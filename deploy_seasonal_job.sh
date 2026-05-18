#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS seasonal-diagnostics builder — Cloud Run Job + Scheduler deploy
# --------------------------------------------------------------------------
# Provisions:
#   1. A Cloud Run Job that runs build_seasonal_diagnostics.py once per
#      invocation — fetches the latest daily OISST timestep from NOAA PSL,
#      computes today's SST anomaly vs the 1991-2020 climatology, renders
#      two anomaly PNGs (raw + Vecchi-Soden relative) and updates
#      latest.json + analog_preliminary_distances.json in
#      gs://${GCS_IR_CACHE_BUCKET}/seasonal/.
#   2. A Cloud Scheduler job that triggers it daily at 09:00 UTC (after
#      PSL's daily OISST v2.1 product publishes ~06 UTC).
#
# Reuses the env-overlay Docker image (Dockerfile.env). Override the
# entrypoint at job-create time so this job runs the seasonal script.
#
# Prerequisites (idempotent — safe to run more than once):
#   gcloud auth login
#   gcloud config set project YOUR_PROJECT_ID
#   gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
#                          cloudbuild.googleapis.com artifactregistry.googleapis.com
#
# Build dependency: this script reuses gcr.io/${PROJECT}/tc-atlas-env-job:latest.
# Run ./deploy_env_job.sh FIRST so the image contains the up-to-date
# build_seasonal_diagnostics.py + build_oisst_history.py.
#
# Usage:
#   chmod +x deploy_seasonal_job.sh
#   ./deploy_seasonal_job.sh
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

JOB_NAME="tc-atlas-seasonal-job"
REGION="us-east1"                 # match env-overlay + API region
SCHEDULER_NAME="tc-atlas-seasonal-schedule"
SCHEDULE="0 9 * * *"              # daily at 09:00 UTC (after PSL OISST ~06 UTC publish)
TIMEZONE="UTC"
BUCKET="${GCS_IR_CACHE_BUCKET:-tc-atlas-ir-cache}"

IMAGE="gcr.io/${PROJECT}/tc-atlas-env-job:latest"

# ── Create or update the Cloud Run Job ───────────────────────────
# Memory: single OISST day slice (720×1440) + 1991-2020 monthly
# climatology (12×720×1440 ≈ 50 MB) + grid-weighted distance vector for
# preliminary analogs is well under 1 GiB; 2 GiB leaves plenty of head
# room. CPU 2 because the OPeNDAP fetch + xarray decode is the wall
# clock bottleneck (~30-90s); more vCPU doesn't help OPeNDAP much but
# keeps matplotlib PNG render brisk.
echo "Deploying Cloud Run Job ${JOB_NAME}..."
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --command "python" \
        --args "build_seasonal_diagnostics.py" \
        --memory 2Gi \
        --cpu 2 \
        --max-retries 1 \
        --task-timeout 600 \
        --set-env-vars "GCS_IR_CACHE_BUCKET=${BUCKET},CR_VCPU=2,CR_MEM_GIB=2"
else
    gcloud run jobs create "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --command "python" \
        --args "build_seasonal_diagnostics.py" \
        --memory 2Gi \
        --cpu 2 \
        --max-retries 1 \
        --task-timeout 600 \
        --set-env-vars "GCS_IR_CACHE_BUCKET=${BUCKET},CR_VCPU=2,CR_MEM_GIB=2"
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
echo "Smoke-test the job manually (writes latest.json + new anom PNGs to GCS):"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait"
echo ""
echo "Logs:"
echo "  gcloud run jobs executions list --job ${JOB_NAME} --region ${REGION} --limit 5"
echo "  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}' --limit 50 --freshness=1h"
echo ""
echo "Output bucket:"
echo "  gsutil ls gs://${BUCKET}/seasonal/"
echo "  gsutil cat gs://${BUCKET}/seasonal/latest.json"
