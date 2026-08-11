#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS env-overlay builder — Cloud Run Job + Scheduler deploy
# --------------------------------------------------------------------------
# Provisions:
#   1. A Cloud Run Job that runs build_env_overlays.py once per invocation
#   2. A Cloud Scheduler job that triggers the Run Job every 6 hours
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project YOUR_PROJECT_ID
#   gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
#                          cloudbuild.googleapis.com artifactregistry.googleapis.com
#
# Usage:
#   chmod +x deploy_env_job.sh
#   ./deploy_env_job.sh
#
# Re-running this script is idempotent — it updates the Job/Scheduler in
# place rather than creating duplicates.
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

JOB_NAME="tc-atlas-env-job"
REGION="us-east1"                 # match the API service so cross-region traffic stays cheap
SCHEDULER_NAME="tc-atlas-env-schedule"
SCHEDULE="15 */6 * * *"           # every 6h at :15 (after GFS publish window)
TIMEZONE="UTC"
BUCKET="${GCS_IR_CACHE_BUCKET:-tc-atlas-ir-cache}"

IMAGE="gcr.io/${PROJECT}/${JOB_NAME}:latest"

# Write the build config to a temp file. We can't use process substitution
# (<(cat <<EOF)) here because gcloud rejects `--tag` and `--config` together —
# the custom Dockerfile (-f Dockerfile.env) only works via --config.
BUILD_CFG="$(mktemp -t tc-atlas-env-cloudbuild.XXXXXX.yaml)"
trap 'rm -f "${BUILD_CFG}"' EXIT
cat > "${BUILD_CFG}" <<EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-f', 'Dockerfile.env', '-t', '${IMAGE}', '.']
- name: 'gcr.io/cloud-builders/docker'
  args: ['push', '${IMAGE}']
images: ['${IMAGE}']
EOF

echo "Building env-job container..."
gcloud builds submit --config "${BUILD_CFG}" .

# ── Create or update the Cloud Run Job ───────────────────────────
# 1 vCPU: measured CPU utilization peaks at ~0.47 of the old 2-vCPU allocation
# (~0.9 core), so the 2nd vCPU sat idle — overlay builds are I/O/GIL-bound, not
# 2-core-bound. CR_VCPU is telemetry-only (cost-log accuracy), set to 1 to match.
#
# Timeout raised 1800 -> 2700 s when the MPI/VI/vPI layers landed. The job was
# running 1000-1265 s and the Bister-Emanuel solve adds ~150-220 s at 1 vCPU,
# which left too little margin on a slow NOMADS day. Jobs bill actual runtime,
# so a longer ceiling costs nothing unless a run genuinely hangs.
#
# Memory raised 2 -> 3 GiB for the same change: the PI path holds 23-level
# T and q profiles on the 0.25 deg grid (~95 MB each) plus their vortex-removed
# copies and derived arrays. The driver keeps them float32 and the builder frees
# them before the solve, but peak is still several hundred MB above the old
# high-water mark and an OOM here would take the whole overlay run down.
echo "Deploying Cloud Run Job ${JOB_NAME}..."
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --memory 3Gi \
        --cpu 1 \
        --max-retries 1 \
        --task-timeout 2700 \
        --set-env-vars "GCS_IR_CACHE_BUCKET=${BUCKET},CR_VCPU=1,CR_MEM_GIB=3"
else
    gcloud run jobs create "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --memory 3Gi \
        --cpu 1 \
        --max-retries 1 \
        --task-timeout 2700 \
        --set-env-vars "GCS_IR_CACHE_BUCKET=${BUCKET},CR_VCPU=1,CR_MEM_GIB=3"
fi

# ── Cloud Scheduler — invoke the Run Job on a cadence ─────────────
# The recommended target for Cloud Scheduler → Cloud Run Job is the
# Run API REST endpoint (HTTP POST). We use a default service account
# with Cloud Run Invoker on the job.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_NAME}:run"

echo "Granting Cloud Run Invoker on ${JOB_NAME} to ${SA_EMAIL}..."
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
    --region "${REGION}" \
    --member "serviceAccount:${SA_EMAIL}" \
    --role roles/run.invoker \
    --quiet || true

# ── Configure bucket CORS so the frontend canvas can sample data PNGs ─
# Required for the hover-tooltip readout: the frontend loads each layer's
# greyscale data PNG with crossOrigin='anonymous' and reads pixel values
# via getImageData. Without ACAO headers, the canvas becomes tainted and
# the read throws SecurityError. Setting on the bucket is idempotent.
CORS_JSON="$(mktemp -t tc-atlas-env-cors.XXXXXX.json)"
trap 'rm -f "${BUILD_CFG}" "${CORS_JSON}"' EXIT
cat > "${CORS_JSON}" <<EOF
[{"origin":["*"],"method":["GET","HEAD"],"responseHeader":["Content-Type","Access-Control-Allow-Origin"],"maxAgeSeconds":3600}]
EOF
echo "Setting CORS on gs://${BUCKET}..."
gsutil cors set "${CORS_JSON}" "gs://${BUCKET}" || echo "  (warning: CORS set failed; hover tooltips will gracefully no-op)"

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
echo "Smoke-test the job manually:"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait"
echo ""
echo "Logs:"
echo "  gcloud run jobs executions list --job ${JOB_NAME} --region ${REGION} --limit 5"
echo "  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}' --limit 50 --freshness=1h"
echo ""
echo "Output bucket:"
echo "  gsutil ls gs://${BUCKET}/env/"
