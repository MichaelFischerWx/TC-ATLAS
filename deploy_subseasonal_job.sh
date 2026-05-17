#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS subseasonal overlay builder — Cloud Run Job + Scheduler deploy
# --------------------------------------------------------------------------
# Provisions:
#   1. A Cloud Run Job that runs build_subseasonal_overlays.py once per
#      invocation — fetches the latest CPC Blended OLR, computes WK-filtered
#      MJO / Kelvin / ER / MRG bands, uploads PNGs + metadata.json to
#      gs://${GCS_IR_CACHE_BUCKET}/subseasonal/{wave}/.
#   2. A Cloud Scheduler job that triggers it daily at 13:30 UTC (after
#      CPC's daily OLR product publishes ~12 UTC).
#
# The job reuses the same container image as the env-overlay job
# (Dockerfile.env builds both scripts into one image). We override the
# entrypoint command at job-create time so this job runs the subseasonal
# script while the env-overlay job keeps using the default ENTRYPOINT.
#
# Prerequisites (idempotent — safe to run more than once):
#   gcloud auth login
#   gcloud config set project YOUR_PROJECT_ID
#   gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
#                          cloudbuild.googleapis.com artifactregistry.googleapis.com
#
# Usage:
#   chmod +x deploy_subseasonal_job.sh
#   ./deploy_subseasonal_job.sh
#
# Build dependency: this script reuses gcr.io/${PROJECT}/tc-atlas-env-job:latest.
# If you haven't run deploy_env_job.sh recently, run it FIRST so the image
# contains the latest build_subseasonal_overlays.py.
# --------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/deploy.env" ]]; then
    set -a
    source "${SCRIPT_DIR}/deploy.env"
    set +a
fi

PROJECT="$(gcloud config get-value project 2>/dev/null)"
if [[ -z "${PROJECT}" ]]; then
    echo "ERROR: gcloud project not set. Run: gcloud config set project YOUR_PROJECT"
    exit 1
fi

JOB_NAME="tc-atlas-subseasonal-job"
REGION="us-east1"                 # match env-overlay + API region
SCHEDULER_NAME="tc-atlas-subseasonal-schedule"
SCHEDULE="30 13 * * *"            # daily at 13:30 UTC (after CPC OLR ~12 UTC update)
TIMEZONE="UTC"
BUCKET="${GCS_IR_CACHE_BUCKET:-tc-atlas-ir-cache}"

# Reuse the env-overlay image. Override the entrypoint command at job
# create/update time so this job runs the subseasonal script.
IMAGE="gcr.io/${PROJECT}/tc-atlas-env-job:latest"

# Production climatology window — 30-yr WMO baseline. The first job run
# takes ~3 min for the climatology fetch over OPeNDAP; subsequent runs
# reuse the cached netCDF in /tmp/_olr_cache and complete in ~30s. Cloud
# Run Job's /tmp is ephemeral per-task, so each cold start re-downloads
# the climatology unless we pre-stage it in GCS — TODO for v2 if cold-
# start cost matters; today's ~$0.05/run is well within margin.
OLR_CLIMO_START="${OLR_CLIMO_START:-1991-01-01}"
OLR_CLIMO_END="${OLR_CLIMO_END:-2020-12-31}"

# ── Create or update the Cloud Run Job ───────────────────────────
echo "Deploying Cloud Run Job ${JOB_NAME}..."
# Memory: 30-yr climatology fetch accumulates ~1.25 GB of raw OLR
# chunks before concat. 4 GiB gives plenty of headroom; daily warm
# runs use far less but we provision for the cold-start case since
# Cloud Run Job /tmp is per-task (no climo cache persistence).
# TODO: bump back down to 1 GiB once we add GCS-side climo cache.
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --command "python" \
        --args "build_subseasonal_overlays.py" \
        --memory 4Gi \
        --cpu 2 \
        --max-retries 1 \
        --task-timeout 900 \
        --set-env-vars "GCS_IR_CACHE_BUCKET=${BUCKET},OLR_CLIMO_START=${OLR_CLIMO_START},OLR_CLIMO_END=${OLR_CLIMO_END},CR_VCPU=2,CR_MEM_GIB=4"
else
    gcloud run jobs create "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --command "python" \
        --args "build_subseasonal_overlays.py" \
        --memory 4Gi \
        --cpu 2 \
        --max-retries 1 \
        --task-timeout 900 \
        --set-env-vars "GCS_IR_CACHE_BUCKET=${BUCKET},OLR_CLIMO_START=${OLR_CLIMO_START},OLR_CLIMO_END=${OLR_CLIMO_END},CR_VCPU=2,CR_MEM_GIB=4"
fi

# ── Cloud Scheduler — invoke the Run Job daily ───────────────────
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_NAME}:run"

echo "Granting Cloud Run Invoker on ${JOB_NAME} to ${SA_EMAIL}..."
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
    --region "${REGION}" \
    --member "serviceAccount:${SA_EMAIL}" \
    --role roles/run.invoker \
    --quiet || true

echo "Creating/updating Cloud Scheduler ${SCHEDULER_NAME}..."
if gcloud scheduler jobs describe "${SCHEDULER_NAME}" --location "${REGION}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${SCHEDULER_NAME}" \
        --location "${REGION}" \
        --schedule "${SCHEDULE}" \
        --time-zone "${TIMEZONE}" \
        --uri "${JOB_URI}" \
        --http-method POST \
        --oauth-service-account-email "${SA_EMAIL}"
else
    gcloud scheduler jobs create http "${SCHEDULER_NAME}" \
        --location "${REGION}" \
        --schedule "${SCHEDULE}" \
        --time-zone "${TIMEZONE}" \
        --uri "${JOB_URI}" \
        --http-method POST \
        --oauth-service-account-email "${SA_EMAIL}"
fi

echo ""
echo "Done."
echo ""
echo "Smoke-test the job manually (will compute the 30-yr climatology on first run, ~3 min):"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait"
echo ""
echo "Logs:"
echo "  gcloud run jobs executions list --job ${JOB_NAME} --region ${REGION} --limit 5"
echo "  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}' --limit 50 --freshness=1h"
echo ""
echo "Output bucket:"
echo "  gsutil ls gs://${BUCKET}/subseasonal/"
echo ""
echo "After the first successful run, refresh the RT Monitor and the"
echo "\"Subseasonal Forcing\" group should appear under Env Analysis."
