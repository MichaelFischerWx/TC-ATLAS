#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS R2 archive mirror — Cloud Run Job + Scheduler deploy
# --------------------------------------------------------------------------
# Keeps the migrated ERA5 / seasonal / subseasonal archive tiles on Cloudflare
# R2 in sync with their GCS source. The frontend (realtime_seasonal.js,
# realtime_subseasonal.js, tc_climatology.js) serves these prefixes from
# cdn.tcatlas.org (zero egress); this job mirrors GCS -> R2 every 6 h so the
# R2 copy never goes stale as the ~14 build scripts append new periods.
#
# Why a mirror job instead of editing each build script: decouples freshness
# from 14 separate writers, auto-covers any future script that writes these
# prefixes, single point of maintenance. 6 h lag is fine — these tiles update
# at most daily (era5_daily_1deg appends ERA5's ~5-day-lagged days; seasonal/
# subseasonal are daily). `env/` is deliberately NOT mirrored here (hourly GFS
# churn; it stays on GCS — revisit if its egress proves significant).
#
# Auth: R2 via Secret Manager (r2-access-key-id / r2-secret-access-key, mounted
# as rclone RCLONE_CONFIG_R2_* env vars). GCS via the job's runtime compute SA
# (env_auth=true -> Cloud Run metadata server); that SA already has object
# access on the bucket. Uses the public rclone/rclone image (no build step).
#
# --s3-no-check-bucket: the Object-scoped R2 token can't CreateBucket, which
# rclone's S3 backend otherwise probes before the first upload.
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

JOB_NAME="tc-atlas-r2-mirror"
REGION="us-east1"
SCHEDULER_NAME="tc-atlas-r2-mirror-schedule"
SCHEDULE="0 */6 * * *"            # every 6 h, on the hour
TIMEZONE="UTC"
IMAGE="rclone/rclone:1.74.3"      # pinned; public Docker Hub image (no build)

SRC_BUCKET="${GCS_IR_CACHE_BUCKET:-tc-atlas-ir-cache}"
R2_BUCKET_NAME="${R2_BUCKET:-tc-atlas-rt}"
R2_ENDPOINT="${R2_ENDPOINT_URL:-https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com}"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"

# Prefixes to mirror (static/diagnostic archive only — NOT env, NOT rt-v
# bundles which dual-write live, NOT era5_daily_00z HD until Phase 2b).
PREFIXES="era5_daily_1deg era5_climo era5_monthly_vpi seasonal subseasonal"

# rclone backends are configured entirely via RCLONE_CONFIG_* env vars (no
# config file). The sync loop runs in the rclone image's /bin/sh.
MIRROR_SCRIPT='set -e; for p in '"${PREFIXES}"'; do echo "[r2-mirror] sync $p"; rclone sync "GCS:'"${SRC_BUCKET}"'/$p" "R2:'"${R2_BUCKET_NAME}"'/$p" --s3-no-check-bucket --transfers 32 --checkers 32 --fast-list --stats-one-line --stats 60s; done; echo "[r2-mirror] complete"'

JOB_ENV="^||^RCLONE_CONFIG_R2_TYPE=s3"
JOB_ENV="${JOB_ENV}||RCLONE_CONFIG_R2_PROVIDER=Cloudflare"
JOB_ENV="${JOB_ENV}||RCLONE_CONFIG_R2_ENDPOINT=${R2_ENDPOINT}"
JOB_ENV="${JOB_ENV}||RCLONE_CONFIG_R2_REGION=auto"
JOB_ENV="${JOB_ENV}||RCLONE_CONFIG_GCS_TYPE=google cloud storage"
JOB_ENV="${JOB_ENV}||RCLONE_CONFIG_GCS_ENV_AUTH=true"
JOB_ENV="${JOB_ENV}||RCLONE_CONFIG_GCS_PROJECT_NUMBER=${PROJECT_NUMBER}"
JOB_ENV="${JOB_ENV}||RCLONE_S3_NO_CHECK_BUCKET=true"

JOB_SECRETS="RCLONE_CONFIG_R2_ACCESS_KEY_ID=r2-access-key-id:latest,RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest"

COMMON_ARGS=(
    --region "${REGION}"
    --image "${IMAGE}"
    --command /bin/sh
    --args "-c,${MIRROR_SCRIPT}"
    --memory 1Gi
    --cpu 1
    --max-retries 1
    --task-timeout 1800
    --set-env-vars "${JOB_ENV}"
    --set-secrets "${JOB_SECRETS}"
)

echo "Deploying Cloud Run Job ${JOB_NAME} (image ${IMAGE})..."
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" "${COMMON_ARGS[@]}"
else
    gcloud run jobs create "${JOB_NAME}" "${COMMON_ARGS[@]}"
fi

# ── Cloud Scheduler — invoke the Run Job every 6 h ─────────────
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
echo "Smoke-test the mirror manually:"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait"
echo "Logs:"
echo "  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}' --limit 50 --freshness=1h"
