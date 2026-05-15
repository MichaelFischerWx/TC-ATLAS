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

echo "Building env-job container..."
gcloud builds submit \
    --tag "${IMAGE}" \
    --config <(cat <<EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-f', 'Dockerfile.env', '-t', '${IMAGE}', '.']
- name: 'gcr.io/cloud-builders/docker'
  args: ['push', '${IMAGE}']
images: ['${IMAGE}']
EOF
)

# ── Create or update the Cloud Run Job ───────────────────────────
echo "Deploying Cloud Run Job ${JOB_NAME}..."
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --memory 2Gi \
        --cpu 2 \
        --max-retries 1 \
        --task-timeout 600 \
        --set-env-vars "GCS_IR_CACHE_BUCKET=${BUCKET}"
else
    gcloud run jobs create "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --memory 2Gi \
        --cpu 2 \
        --max-retries 1 \
        --task-timeout 600 \
        --set-env-vars "GCS_IR_CACHE_BUCKET=${BUCKET}"
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
