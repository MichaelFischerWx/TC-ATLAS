#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS real-time prewarm worker — Cloud Run Job + Scheduler deploy
# --------------------------------------------------------------------------
# Moves the satellite/microwave prewarm render pipeline OUT of the API
# process and INTO a standalone Cloud Run Job, so the API can run
# cpu-throttled (min=1, --no-cpu-boost) instead of paying the ~$150/mo
# always-allocated-CPU floor that the in-process prewarm daemon required.
#
# Provisions:
#   1. A Cloud Run Job (tc-atlas-prewarm-job) that runs prewarm_job.py once
#      per invocation. It REUSES the API service's deployed container image
#      (identical code + deps), overriding the entrypoint to prewarm_job.py.
#   2. A Cloud Scheduler job that triggers it every 10 min (matching the
#      Himawari + GOES Full Disk scan grid on 0/10/20/.../50).
#
# IMPORTANT ordering: deploy the API service FIRST (./deploy.sh) so the
# image contains run_prewarm_cycle() + prewarm_job.py, THEN run this. While
# the service still has IR_INLINE_PREWARM=1 (default), the job's writes are
# harmless duplicates — safe to smoke-test. Only after the job is verified
# should you flip the service to IR_INLINE_PREWARM=0 + cpu-throttling.
#
# Re-running this script is idempotent.
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

SERVICE_NAME="tc-atlas-api"
JOB_NAME="tc-atlas-prewarm-job"
REGION="us-east1"
SCHEDULER_NAME="tc-atlas-prewarm-schedule"
SCHEDULE="*/10 * * * *"            # every 10 min, aligned to satellite scan grid
TIMEZONE="UTC"
BUCKET="${GCS_IR_CACHE_BUCKET:-tc-atlas-ir-cache}"

# ── Reuse the API service's deployed image (no separate build) ────
echo "Resolving deployed image for ${SERVICE_NAME}..."
IMAGE="$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" \
    --format='value(spec.template.spec.containers[0].image)')"
if [[ -z "${IMAGE}" ]]; then
    echo "ERROR: could not resolve image for ${SERVICE_NAME}. Deploy the service first: ./deploy.sh"
    exit 1
fi
echo "  → ${IMAGE}"

# ── Job env contract ──────────────────────────────────────────────
# Satellite IR (GOES/Himawari) and NEXRAD L2 are pulled from ANONYMOUS
# public NOAA S3 buckets (satellite_ir.py uses s3fs anon=True), so no
# Earthdata token is needed here. The job writes rendered frames to GCS
# via its runtime service account (same default compute SA as the
# service, which already has object write on the bucket).
JOB_ENV="GCS_IR_CACHE_BUCKET=${BUCKET}"
JOB_ENV="${JOB_ENV},AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}"
[[ -n "${AWS_ACCESS_KEY_ID:-}" ]]     && JOB_ENV="${JOB_ENV},AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}"
[[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]] && JOB_ENV="${JOB_ENV},AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}"
[[ -n "${TC_RADAR_S3_BUCKET:-}" ]]    && JOB_ENV="${JOB_ENV},TC_RADAR_S3_BUCKET=${TC_RADAR_S3_BUCKET}"

# ── Create or update the Cloud Run Job ───────────────────────────
echo "Deploying Cloud Run Job ${JOB_NAME}..."
COMMON_ARGS=(
    --region "${REGION}"
    --image "${IMAGE}"
    --command python3
    --args prewarm_job.py
    --memory 4Gi
    --cpu 2
    --max-retries 1
    --task-timeout 900
    --set-env-vars "${JOB_ENV}"
)
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" "${COMMON_ARGS[@]}"
else
    gcloud run jobs create "${JOB_NAME}" "${COMMON_ARGS[@]}"
fi

# ── Cloud Scheduler — invoke the Run Job every 10 min ─────────────
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
echo "Smoke-test the job manually (safe while service IR_INLINE_PREWARM=1):"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait"
echo ""
echo "Logs:"
echo "  gcloud run jobs executions list --job ${JOB_NAME} --region ${REGION} --limit 5"
echo "  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}' --limit 50 --freshness=1h"
echo ""
echo "AFTER verifying the job, flip the service to cpu-throttled (keeps min=1):"
echo "  gcloud run services update ${SERVICE_NAME} --region ${REGION} \\"
echo "      --update-env-vars IR_INLINE_PREWARM=0 --cpu-throttling --min-instances 1"
echo "  (--cpu-throttling = CPU only allocated during requests; this is the"
echo "   change that removes the always-on-CPU billing floor.)"
