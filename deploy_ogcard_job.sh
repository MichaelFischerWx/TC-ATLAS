#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS social OG-card refresher — Cloud Run Job + Scheduler deploy
# --------------------------------------------------------------------------
# Provisions a lightweight Cloud Run Job (tc-atlas-ogcard-job) that runs
# ogcard_job.py once per invocation to (re)build the dynamic social OG card
# (og:image / twitter:image) and refresh rt-version.json. Scheduled HOURLY.
#
# WHY: the storm card now defaults to the lite mosaic view, so the prewarm
# job's pre-rendered raw-Tb frames are no longer needed up front (Detailed
# renders on demand). The OG card + rt-version.json were prewarm's only OTHER
# unique outputs — moving them here lets the prewarm scheduler be PAUSED:
#     gcloud scheduler jobs pause tc-atlas-prewarm-schedule --location us-east1
#
# ogcard_job.py REUSES the API image (like prewarm) but imports only
# og_refresh → (og_card, satellite_ir) + google-cloud-storage, NOT
# ir_monitor_api — so it skips the heavy pyart/cartopy + IBTrACS cold start
# and is cheap to run hourly (~1 IR fetch + render + GCS put).
#
# IMPORTANT ordering: deploy the API service FIRST (./deploy.sh) so the image
# contains ogcard_job.py + og_refresh.py, THEN run this. deploy.sh chains it.
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
JOB_NAME="tc-atlas-ogcard-job"
REGION="us-east1"
SCHEDULER_NAME="tc-atlas-ogcard-schedule"
SCHEDULE="0 * * * *"               # hourly, top of the hour (the OG card only
                                   # needs to track storm motion/intensity loosely)
TIMEZONE="UTC"
BUCKET="${GCS_IR_CACHE_BUCKET:-tc-atlas-ir-cache}"

# rt-version.json must advertise the SAME cache version the API serves. Pull it
# straight from the source of truth so this job never drifts from a manual bump.
RT_VERSION="$(grep -m1 -oE '_GCS_RT_VERSION = "[^"]+"' "${SCRIPT_DIR}/ir_monitor_api.py" \
              | sed -E 's/.*"([^"]+)".*/\1/')"
if [[ -z "${RT_VERSION}" ]]; then
    echo "ERROR: could not parse _GCS_RT_VERSION from ir_monitor_api.py"
    exit 1
fi
echo "rt-version: ${RT_VERSION}"

# ── Reuse the API service's deployed image (no separate build) ────
# Pin the :latest TAG, not a resolved @sha256 digest — the keep-3 Artifact
# Registry cleanup prunes old digests, so a digest pin breaks ~3 deploys later.
# deploy.sh re-runs this after each API deploy so the pin tracks the new build.
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${SERVICE_NAME}:latest"
echo "Using API image tag: ${IMAGE}"
if ! gcloud artifacts docker images describe "${IMAGE}" >/dev/null 2>&1; then
    echo "ERROR: ${IMAGE} not found. Deploy the service first: ./deploy.sh"
    exit 1
fi

# ── Job env contract ──────────────────────────────────────────────
# Writes the card + rt-version.json to GCS via the runtime compute SA (already
# has object write). Satellite IR is read from ANONYMOUS public NOAA S3 (s3fs
# anon=True), so no Earthdata/AWS creds are strictly required — AWS secrets are
# attached defensively for parity with the prewarm job (harmless if unused).
JOB_ENV="GCS_IR_CACHE_BUCKET=${BUCKET}"
JOB_ENV="${JOB_ENV},GCS_RT_VERSION=${RT_VERSION}"
JOB_ENV="${JOB_ENV},AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}"
JOB_ENV="${JOB_ENV},PUBLIC_BUNDLE_BASE=${PUBLIC_BUNDLE_BASE:-https://cdn.tcatlas.org}"
JOB_ENV="${JOB_ENV},OG_CARD_KEY=og/realtime_ir.png"

# ── Create or update the Cloud Run Job ───────────────────────────
echo "Deploying Cloud Run Job ${JOB_NAME}..."
COMMON_ARGS=(
    --region "${REGION}"
    --image "${IMAGE}"
    --command python3
    --args ogcard_job.py
    --memory 2Gi   # one 10°-box IR fetch + a PIL card render — far lighter than
                   # prewarm's multi-storm full-loop render; 2 GiB is ample.
    --cpu 1
    --max-retries 1
    --task-timeout 300
    --set-env-vars "${JOB_ENV}"
    --set-secrets "AWS_ACCESS_KEY_ID=aws-access-key-id:latest,AWS_SECRET_ACCESS_KEY=aws-secret-access-key:latest"
)
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" "${COMMON_ARGS[@]}"
else
    gcloud run jobs create "${JOB_NAME}" "${COMMON_ARGS[@]}"
fi

# ── Cloud Scheduler — invoke the Run Job hourly ──────────────────
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

# Refresh rt-version.json + the OG card immediately so a deploy never leaves a
# stale version pointer (rt-version only changes at deploy time).
echo "Triggering one ${JOB_NAME} run to refresh rt-version + OG card..."
gcloud run jobs execute "${JOB_NAME}" --region "${REGION}" --wait || \
    echo "  (initial run failed — check logs; not fatal to the deploy)"

echo ""
echo "Done."
echo ""
echo "Once verified, PAUSE prewarm (the OG card + rt-version now live here):"
echo "  gcloud scheduler jobs pause tc-atlas-prewarm-schedule --location ${REGION}"
echo "  (resume:  gcloud scheduler jobs resume tc-atlas-prewarm-schedule --location ${REGION})"
echo ""
echo "Logs:"
echo "  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}' --limit 20 --freshness=2h"
