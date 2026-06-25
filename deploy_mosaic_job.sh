#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS global IR mosaic builder — Cloud Run Job + Scheduler deploy
# --------------------------------------------------------------------------
# Provisions:
#   1. A Cloud Run Job that runs build_ir_mosaic.py --r2 --storm once per call
#      (reads GOES-19/18 + Himawari-9 B13, reprojects via cached kernels,
#       cutline-blends, tiles z0–5 global + z6–7 storm sectors, uploads to R2).
#   2. A Cloud Scheduler job that triggers it every 10 minutes.
#
# Prereqs:
#   gcloud auth login && gcloud config set project YOUR_PROJECT
#   gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
#                          cloudbuild.googleapis.com
#   R2 creds in Secret Manager: r2-access-key-id, r2-secret-access-key
#
# Idempotent — updates the Job/Scheduler in place. This is ADDITIVE: the tiles
# land in R2 (mosaic-v1/) where nothing in the deployed site reads them yet, so
# it cannot degrade the live page.
# --------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/deploy.env" ]]; then set -a; source "${SCRIPT_DIR}/deploy.env"; set +a; fi

PROJECT="$(gcloud config get-value project 2>/dev/null)"
[[ -z "${PROJECT}" ]] && { echo "ERROR: gcloud project not set."; exit 1; }

JOB_NAME="tc-atlas-mosaic-job"
REGION="us-east1"
SCHEDULER_NAME="tc-atlas-mosaic-schedule"
SCHEDULE="*/10 * * * *"            # every 10 min (GOES/Himawari full-disk cadence)
TIMEZONE="UTC"
IMAGE="gcr.io/${PROJECT}/${JOB_NAME}:latest"

R2_ENDPOINT_URL="${R2_ENDPOINT_URL:-https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com}"
R2_BUCKET="${R2_BUCKET:-tc-atlas-rt}"

# ── Build the container ──────────────────────────────────────────
BUILD_CFG="$(mktemp -t tc-atlas-mosaic-cloudbuild.XXXXXX.yaml)"
trap 'rm -f "${BUILD_CFG}"' EXIT
cat > "${BUILD_CFG}" <<EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-f', 'Dockerfile.mosaic', '-t', '${IMAGE}', '.']
- name: 'gcr.io/cloud-builders/docker'
  args: ['push', '${IMAGE}']
images: ['${IMAGE}']
EOF
echo "Building mosaic-job container..."
gcloud builds submit --config "${BUILD_CFG}" .

# ── Create/update the Cloud Run Job ──────────────────────────────
# 4 vCPU: PNG encode + concurrent R2 upload parallelize across cores.
# 8Gi: the global z5 Mercator raster (~256MB) + 3 cached kernels + 3 full-disk
# source arrays + accumulators peak ~2-3GB; 8Gi leaves headroom for the
# one-time kernel build on cold start.
COMMON_FLAGS=(
  --region "${REGION}" --image "${IMAGE}"
  --memory 8Gi --cpu 4 --max-retries 1 --task-timeout 600
  --set-env-vars "R2_ENDPOINT_URL=${R2_ENDPOINT_URL},R2_BUCKET=${R2_BUCKET}"
  --set-secrets  "R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest"
)
echo "Deploying Cloud Run Job ${JOB_NAME}..."
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" "${COMMON_FLAGS[@]}"
else
    gcloud run jobs create "${JOB_NAME}" "${COMMON_FLAGS[@]}"
fi

# ── Cloud Scheduler → invoke the job every 10 min ────────────────
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

Done. The job is ADDITIVE (writes to R2 mosaic-v1/; the live site doesn't read it yet).

Smoke-test one run now:
  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait

Logs:
  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=${JOB_NAME}' --limit 50 --freshness=1h

Output (served at https://cdn.tcatlas.org/mosaic-v1/ir/...):
  mosaic-v1/ir/frames.json   ← rolling manifest
  mosaic-v1/ir/<ts>/{z}/{x}/{y}.png
EOF
