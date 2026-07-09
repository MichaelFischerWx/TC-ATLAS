#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS single-channel-idx mosaic builder — Cloud Run Job + Scheduler
# --------------------------------------------------------------------------
# The cost-saving sibling of deploy_mosaic_job.sh: same builder image, but run
# with MOSAIC_TILE_MODE=idx + MOSAIC_R2_PREFIX=mosaic-v3 so it emits single-channel
# brightness-INDEX tiles (1-ch PNG, value = quantized Tb) instead of baked-colormap
# RGBA. The frontend GPU-recolors them (mosaic_gl_layer.js); measured egress:
# IR -65%, WV -69%, Vis -43%.
#
# REUSES the image built by deploy_mosaic_job.sh (gcr.io/<proj>/tc-atlas-mosaic-job)
# — does NOT build. Run ./deploy_mosaic_job.sh first if the image is stale.
#
# DUAL-WRITE: while both this and tc-atlas-mosaic-job are scheduled, R2 carries
# v2 (RGBA) AND v3 (idx). That's the safe cutover overlap; once the frontend
# defaults to idx and is verified live+mobile, pause tc-atlas-mosaic-schedule
# (the v2 job) and this becomes THE mosaic job.
#   pause v2:  gcloud scheduler jobs pause  tc-atlas-mosaic-schedule --location us-east1
#   rollback:  gcloud scheduler jobs resume tc-atlas-mosaic-schedule --location us-east1
# Idempotent.
# --------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/deploy.env" ]]; then set -a; source "${SCRIPT_DIR}/deploy.env"; set +a; fi

PROJECT="$(gcloud config get-value project 2>/dev/null)"
[[ -z "${PROJECT}" ]] && { echo "ERROR: gcloud project not set."; exit 1; }

JOB_NAME="tc-atlas-mosaic-idx"
REGION="us-east1"
SCHEDULER_NAME="tc-atlas-mosaic-idx-schedule"
SCHEDULE="*/10 * * * *"            # match the v2 job (GOES/Himawari full-disk cadence)
TIMEZONE="UTC"
IMAGE="gcr.io/${PROJECT}/tc-atlas-mosaic-job:latest"   # shared builder image (idx is env-gated)

R2_ENDPOINT_URL="${R2_ENDPOINT_URL:-https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com}"
R2_BUCKET="${R2_BUCKET:-tc-atlas-rt}"

if ! gcloud artifacts docker images describe "${IMAGE}" >/dev/null 2>&1 \
   && ! gcloud container images describe "${IMAGE}" >/dev/null 2>&1; then
    echo "ERROR: ${IMAGE} not found. Build it first: ./deploy_mosaic_job.sh"
    exit 1
fi

# ── Create/update the idx Cloud Run Job ──────────────────────────
# S6 peak-RAM fix landed 2026-07-08: strip-decode VIS read + malloc_trim between
# bands dropped the full-run peak ~6.5→~3.4 GiB, so the job runs at the cheaper
# 1vCPU/4Gi tier (Cloud Run requires 2vCPU for >4Gi). REQUIRED: MALLOC_ARENA_MAX=2
# — without it glibc spreads the 16-thread upload pool across per-thread arenas
# whose fragmentation adds ~670 MiB to the cgroup (getrusage doesn't see it) and
# OOMs at 4Gi even though the process peaks ~3.4 GiB. Verified: exec 3m40s wall,
# peak 3311-3467 MiB. Rollback if it ever OOMs: MOSAIC_JOB_MEMORY=8Gi
# MOSAIC_JOB_CPU=2 ./deploy_mosaic_idx_job.sh
MOSAIC_JOB_MEMORY="${MOSAIC_JOB_MEMORY:-4Gi}"
MOSAIC_JOB_CPU="${MOSAIC_JOB_CPU:-1}"
# rolling 1 frame/run (R2_KEEP_FRAMES window in the builder). args use the ^@^
# delimiter — leading -- trips gcloud.
COMMON_FLAGS=(
  --region "${REGION}" --image "${IMAGE}"
  --memory "${MOSAIC_JOB_MEMORY}" --cpu "${MOSAIC_JOB_CPU}" --max-retries 1 --task-timeout 600
  --set-env-vars "R2_ENDPOINT_URL=${R2_ENDPOINT_URL},R2_BUCKET=${R2_BUCKET},MOSAIC_TILE_MODE=idx,MOSAIC_R2_PREFIX=mosaic-v3,MALLOC_ARENA_MAX=2,MALLOC_TRIM_THRESHOLD_=0"
  --set-secrets  "R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest"
  "--args=^@^--r2@--storm@--time@--bands@ir,wv,vis@--frames@1"
)
echo "Deploying Cloud Run Job ${JOB_NAME} (idx → mosaic-v3)..."
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" "${COMMON_FLAGS[@]}"
else
    gcloud run jobs create "${JOB_NAME}" "${COMMON_FLAGS[@]}"
fi

# ── Cloud Scheduler → invoke every 10 min ────────────────────────
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_NAME}:run"

gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
    --region "${REGION}" --member "serviceAccount:${SA_EMAIL}" \
    --role roles/run.invoker --quiet || true

echo "Creating/updating Cloud Scheduler ${SCHEDULER_NAME}..."
if gcloud scheduler jobs describe "${SCHEDULER_NAME}" --location "${REGION}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${SCHEDULER_NAME}" \
        --location "${REGION}" --schedule "${SCHEDULE}" --time-zone "${TIMEZONE}" \
        --uri "${JOB_URI}" --http-method POST --oauth-service-account-email "${SA_EMAIL}"
else
    gcloud scheduler jobs create http "${SCHEDULER_NAME}" \
        --location "${REGION}" --schedule "${SCHEDULE}" --time-zone "${TIMEZONE}" \
        --uri "${JOB_URI}" --http-method POST --oauth-service-account-email "${SA_EMAIL}"
fi

cat <<EOF

Done. v3 (idx) tiles → https://cdn.tcatlas.org/mosaic-v3/{ir,wv,vis}/...
DUAL-WRITE active alongside tc-atlas-mosaic-job (v2). After the frontend defaults
to idx and is verified live + mobile, pause the v2 job to land the savings:
  gcloud scheduler jobs pause tc-atlas-mosaic-schedule --location ${REGION}
EOF
