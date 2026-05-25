#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS microwave NRT ingestion — Cloud Run Job + Scheduler deploy
# --------------------------------------------------------------------------
# Provisions:
#   1. A Cloud Run Job that runs `mw_ingest.py --operational` per invocation
#   2. A Cloud Scheduler job that triggers the Run Job every 20 minutes
#
# Prerequisites (run these once, manually, before invoking this script):
#   gcloud auth login
#   gcloud config set project YOUR_PROJECT_ID
#   gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
#                          cloudbuild.googleapis.com artifactregistry.googleapis.com \
#                          secretmanager.googleapis.com
#
#   # GCS bucket for microwave artifacts (PNGs, GeoJSON footprints, manifest)
#   gsutil mb -l us-east1 gs://tc-atlas-microwave-nrt
#
#   # PPS NRT credentials in Secret Manager (PPS uses your registered
#   # email as BOTH username and password by convention)
#   printf '%s' 'mikefischerwx@gmail.com' | gcloud secrets create pps-user --data-file=-
#   printf '%s' 'mikefischerwx@gmail.com' | gcloud secrets create pps-pass --data-file=-
#
# Usage:
#   chmod +x deploy_mw_job.sh
#   ./deploy_mw_job.sh
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

JOB_NAME="tc-atlas-mw-job"
REGION="us-east1"                 # match the API service so cross-region traffic stays cheap
SCHEDULER_NAME="tc-atlas-mw-schedule"
SCHEDULE="*/20 * * * *"           # every 20 min — must finish before the next trigger
TIMEZONE="UTC"
BUCKET="${GCS_MW_BUCKET:-tc-atlas-microwave-nrt}"

# Pass-prediction scheduler: re-uses the SAME Cloud Run Job, but
# Scheduler overrides the container args to run --predict-passes
# instead of --operational (the Dockerfile ENTRYPOINT default).
# Why a 2nd Scheduler entry (not a 2nd Job)? Same container image,
# same env/secrets wiring, half the surface area to keep aligned —
# Cloud Run Jobs accept a `containerOverrides.args` field in the
# :run API body, which Cloud Scheduler can set via --message-body.
PREDICT_SCHEDULER_NAME="tc-atlas-mw-predict-schedule"
PREDICT_SCHEDULE="*/30 * * * *"   # every 30 min — refresh predictions

IMAGE="gcr.io/${PROJECT}/${JOB_NAME}:latest"

# ── Bucket guard — do not auto-create; the user creates it explicitly ─
if ! gsutil ls -b "gs://${BUCKET}" >/dev/null 2>&1; then
    echo "ERROR: bucket gs://${BUCKET} does not exist."
    echo "Create it first with:"
    echo "  gsutil mb -l ${REGION} gs://${BUCKET}"
    exit 1
fi

# ── Public-read on bucket objects — frontend fetches PNGs + manifest via
# https://storage.googleapis.com/... and needs unauthenticated access.
# Idempotent: re-binding the same role is a no-op.
echo "Granting allUsers:objectViewer on gs://${BUCKET}..."
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member=allUsers \
    --role=roles/storage.objectViewer \
    --quiet >/dev/null || echo "  (warning: public-read binding failed; frontend will 403)"

# ── Secret guard — PPS creds must live in Secret Manager ─────────────
for SECRET in pps-user pps-pass; do
    if ! gcloud secrets describe "${SECRET}" >/dev/null 2>&1; then
        echo "ERROR: Secret Manager secret '${SECRET}' does not exist."
        echo "Create both secrets first (PPS uses your email as username AND password):"
        echo "  printf '%s' 'YOUR_PPS_EMAIL' | gcloud secrets create pps-user --data-file=-"
        echo "  printf '%s' 'YOUR_PPS_EMAIL' | gcloud secrets create pps-pass --data-file=-"
        exit 1
    fi
done

# ── Build the container image via Cloud Build ────────────────────────
# Write the build config to a temp file. We can't use process substitution
# (<(cat <<EOF)) here because gcloud rejects `--tag` and `--config` together —
# the custom Dockerfile (-f Dockerfile.mw) only works via --config.
BUILD_CFG="$(mktemp -t tc-atlas-mw-cloudbuild.XXXXXX.yaml)"
trap 'rm -f "${BUILD_CFG}"' EXIT
cat > "${BUILD_CFG}" <<EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-f', 'Dockerfile.mw', '-t', '${IMAGE}', '.']
- name: 'gcr.io/cloud-builders/docker'
  args: ['push', '${IMAGE}']
images: ['${IMAGE}']
EOF

echo "Building microwave-job container..."
gcloud builds submit --config "${BUILD_CFG}" .

# ── Grant the Cloud Run runtime SA access to the PPS secrets ─────────
# Default Compute Engine SA is what `gcloud run jobs` uses unless --service-account
# is set explicitly. Idempotent: || true swallows the "already bound" case.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "Granting Secret Manager access on pps-user/pps-pass to ${SA_EMAIL}..."
for SECRET in pps-user pps-pass; do
    gcloud secrets add-iam-policy-binding "${SECRET}" \
        --member "serviceAccount:${SA_EMAIL}" \
        --role roles/secretmanager.secretAccessor \
        --quiet || true
done

# ── Create or update the Cloud Run Job ───────────────────────────────
echo "Deploying Cloud Run Job ${JOB_NAME}..."
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --memory 2Gi \
        --cpu 2 \
        --max-retries 1 \
        --task-timeout 3600 \
        --set-env-vars "GCS_MW_BUCKET=${BUCKET}" \
        --set-secrets "PPS_USER=pps-user:latest,PPS_PASS=pps-pass:latest"
else
    gcloud run jobs create "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --memory 2Gi \
        --cpu 2 \
        --max-retries 1 \
        --task-timeout 3600 \
        --set-env-vars "GCS_MW_BUCKET=${BUCKET}" \
        --set-secrets "PPS_USER=pps-user:latest,PPS_PASS=pps-pass:latest"
fi

# ── Cloud Scheduler → Cloud Run Job (HTTP POST via Run API) ──────────
JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_NAME}:run"

echo "Granting Cloud Run Invoker on ${JOB_NAME} to ${SA_EMAIL}..."
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
    --region "${REGION}" \
    --member "serviceAccount:${SA_EMAIL}" \
    --role roles/run.invoker \
    --quiet || true

# ── Configure bucket CORS so the frontend can read manifest + PNG bounds ─
# Frontend fetches manifest.json (JSON) and the PNG overlays (image bytes
# for L.imageOverlay). May also sample pixels via canvas getImageData,
# which requires ACAO headers to avoid a tainted canvas. Same JSON shape
# as the env-overlay bucket. Setting on the bucket is idempotent.
CORS_JSON="$(mktemp -t tc-atlas-mw-cors.XXXXXX.json)"
trap 'rm -f "${BUILD_CFG}" "${CORS_JSON}"' EXIT
cat > "${CORS_JSON}" <<EOF
[{"origin":["*"],"method":["GET","HEAD"],"responseHeader":["Content-Type","Access-Control-Allow-Origin"],"maxAgeSeconds":3600}]
EOF
echo "Setting CORS on gs://${BUCKET}..."
gsutil cors set "${CORS_JSON}" "gs://${BUCKET}" || echo "  (warning: CORS set failed; frontend canvas reads may be blocked)"

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

# ── Pass-prediction scheduler (same Job, overridden args) ────────────
# Dockerfile.mw splits ENTRYPOINT=["python","mw_ingest.py"] and
# CMD=["--operational"]. The Cloud Run Jobs :run API's
# containerOverrides.args field replaces CMD only, so we just need
# to swap the single flag — the entrypoint (python script) is
# inherited automatically. Same pattern works for manual testing:
#   gcloud run jobs execute ... --args=--predict-passes
PREDICT_BODY="$(mktemp -t tc-atlas-mw-predict-body.XXXXXX.json)"
trap 'rm -f "${BUILD_CFG}" "${CORS_JSON}" "${PREDICT_BODY}"' EXIT
cat > "${PREDICT_BODY}" <<'EOF'
{"overrides":{"containerOverrides":[{"args":["--predict-passes"]}]}}
EOF

echo "Creating/updating Cloud Scheduler ${PREDICT_SCHEDULER_NAME}..."
if gcloud scheduler jobs describe "${PREDICT_SCHEDULER_NAME}" --location "${REGION}" >/dev/null 2>&1; then
    # `gcloud scheduler jobs update http` rejects --headers — it uses
    # --update-headers (the create branch below still uses --headers).
    gcloud scheduler jobs update http "${PREDICT_SCHEDULER_NAME}" \
        --location "${REGION}" \
        --schedule "${PREDICT_SCHEDULE}" \
        --time-zone "${TIMEZONE}" \
        --uri "${JOB_URI}" \
        --http-method POST \
        --update-headers "Content-Type=application/json" \
        --message-body-from-file "${PREDICT_BODY}" \
        --oauth-service-account-email "${SA_EMAIL}"
else
    gcloud scheduler jobs create http "${PREDICT_SCHEDULER_NAME}" \
        --location "${REGION}" \
        --schedule "${PREDICT_SCHEDULE}" \
        --time-zone "${TIMEZONE}" \
        --uri "${JOB_URI}" \
        --http-method POST \
        --headers "Content-Type=application/json" \
        --message-body-from-file "${PREDICT_BODY}" \
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
echo "  gsutil ls gs://${BUCKET}/"
echo "  gsutil cat gs://${BUCKET}/manifest_latest_48h.json | head -c 2000"
echo "  gsutil cat gs://${BUCKET}/passes_predicted.json | head -c 2000"
echo ""
echo "Smoke-test the prediction path:"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait --args=--predict-passes"
