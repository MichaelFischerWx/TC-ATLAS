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
SCHEDULE="*/15 * * * *"            # every 15 min (cost: prewarm is the #1 job line; was */10)
TIMEZONE="UTC"
BUCKET="${GCS_IR_CACHE_BUCKET:-tc-atlas-ir-cache}"

# ── Reuse the API service's deployed image (no separate build) ────
# Pin to the :latest TAG, NOT the running service's resolved @sha256
# digest. Cloud Run source-deploy tags every new build :latest, and the
# keep-3 Artifact Registry cleanup policy prunes older digests — so a
# digest-pinned job silently breaks (every 10-min run fails with "Image
# not found") the moment the API is redeployed a few times past it. The
# tag always resolves to the current image; deploy.sh re-runs this script
# after each API deploy so the job's pin is refreshed to the new build.
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${SERVICE_NAME}:latest"
echo "Using API image tag: ${IMAGE}"
if ! gcloud artifacts docker images describe "${IMAGE}" >/dev/null 2>&1; then
    echo "ERROR: ${IMAGE} not found. Deploy the service first: ./deploy.sh"
    exit 1
fi

# ── Job env contract ──────────────────────────────────────────────
# Satellite IR (GOES/Himawari) and NEXRAD L2 are pulled from ANONYMOUS
# public NOAA S3 buckets (satellite_ir.py uses s3fs anon=True), so no
# Earthdata token is needed here. The job writes rendered frames to GCS
# via its runtime service account (same default compute SA as the
# service, which already has object write on the bucket).
# AWS creds come from Secret Manager (aws-access-key-id / aws-secret-access-key),
# NOT plaintext env vars — see --set-secrets below. The runtime compute SA has
# secretAccessor on both. Non-secret config stays as plain env vars.
JOB_ENV="GCS_IR_CACHE_BUCKET=${BUCKET}"
JOB_ENV="${JOB_ENV},AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}"
JOB_ENV="${JOB_ENV},R2_ENDPOINT_URL=${R2_ENDPOINT_URL:-https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com}"
JOB_ENV="${JOB_ENV},R2_BUCKET=${R2_BUCKET:-tc-atlas-rt}"
JOB_ENV="${JOB_ENV},PUBLIC_BUNDLE_BASE=${PUBLIC_BUNDLE_BASE:-https://cdn.tcatlas.org}"
[[ -n "${TC_RADAR_S3_BUCKET:-}" ]]    && JOB_ENV="${JOB_ENV},TC_RADAR_S3_BUCKET=${TC_RADAR_S3_BUCKET}"
# This Job IS the prewarm worker — it calls run_prewarm_cycle() directly and
# never serves loop requests, so the in-process _ir_frame_cache warming (Phase
# 1 of _prefetch_ir_frames) has no reader and is discarded on exit. Setting
# IR_INLINE_PREWARM=0 skips that dead fetch+reproject+render pass (and the
# inline daemon/thread-spawn the flag also gates). GCS prefetch — the part that
# actually persists and serves users — is unaffected.
JOB_ENV="${JOB_ENV},IR_INLINE_PREWARM=0"
# Render this many active storms concurrently (default 2). Cloud Run Jobs bill
# CPU × wall-clock and the per-storm work is I/O-bound, so overlapping storms
# cuts wall-clock — and cost — when multiple systems are active. Override here
# (and bump --memory below) only if raising it; peak heavy-fetch memory is
# already capped by _raw_fetch_semaphore regardless of this value.
[[ -n "${IR_PREWARM_STORM_CONCURRENCY:-}" ]] && JOB_ENV="${JOB_ENV},IR_PREWARM_STORM_CONCURRENCY=${IR_PREWARM_STORM_CONCURRENCY}"

# ── Create or update the Cloud Run Job ───────────────────────────
echo "Deploying Cloud Run Job ${JOB_NAME}..."
COMMON_ARGS=(
    --region "${REGION}"
    --image "${IMAGE}"
    --command python3
    --args prewarm_job.py
    --memory 6Gi   # 6 GiB: 3 GiB OOM-killed (signal 9) on busy multi-storm
                   # cycles — e.g. 3 active systems incl. a Himawari one, whose
                   # full-disk segments are ~6 MB each decompressed × many
                   # segments × frames × concurrent storms. Job bills memory ×
                   # runtime only while running (quiet-gate skips otherwise), so
                   # the extra is bounded to active-storm windows (~+$0.1/day).
    --cpu 2
    --max-retries 1
    --task-timeout 900
    --set-env-vars "${JOB_ENV}"
    --set-secrets "AWS_ACCESS_KEY_ID=aws-access-key-id:latest,AWS_SECRET_ACCESS_KEY=aws-secret-access-key:latest,R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest"
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
