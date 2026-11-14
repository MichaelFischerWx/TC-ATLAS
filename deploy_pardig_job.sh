#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS PARDIG rain-rate tiles -- Cloud Run Job + Scheduler
# --------------------------------------------------------------------------
# DeepMind posts PARDIG near-real-time rain in 6-hourly batches (24 frames at
# 15 min, the newest ~2 h old on arrival). The job polls every 10 min, builds
# only frames R2 does not have, pairs each with the archived IR mosaic frame
# nearest in time, rewrites pardig-v1/rain/frames.json and prunes frames older
# than 72 h, then updates the per-storm rain totals (pardig-v1/storms/<ID>/)
# that the storm cards draw. Cost: ~144 short runs/day (~5-10 s each) + 4 batch builds/day
# (~1-2 min each) at 1 vCPU / 2 GiB, roughly $1-2/mo; R2 upload ~40 MB/batch.
#
# Usage:  ./deploy_pardig_job.sh            # build + deploy + schedule
#         ./deploy_pardig_job.sh --no-build # re-apply job/scheduler config only
# Pause:  gcloud scheduler jobs pause tc-atlas-pardig-schedule --location us-east1
# --------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
[[ -n "${PROJECT}" ]] || { echo "ERROR: gcloud project not set"; exit 1; }

JOB_NAME="tc-atlas-pardig-job"
REGION="us-east1"
SCHEDULER_NAME="tc-atlas-pardig-schedule"
SCHEDULE="3-59/10 * * * *"
IMAGE="gcr.io/${PROJECT}/${JOB_NAME}:latest"

if [[ "${1:-}" != "--no-build" ]]; then
    # Stage a small build context (the repo root is far too big to upload).
    CTX="$(mktemp -d -t tc-atlas-pardig-ctx.XXXXXX)"
    trap 'rm -rf "${CTX}"' EXIT
    cp "${SCRIPT_DIR}/Dockerfile.pardig" "${CTX}/Dockerfile"
    cp "${SCRIPT_DIR}/build_pardig_rain.py" "${SCRIPT_DIR}/pardig_storm_totals.py" \
       "${SCRIPT_DIR}/build_pardig_archive.py" "${CTX}/"
    echo "Building ${IMAGE}..."
    gcloud builds submit --tag "${IMAGE}" "${CTX}"
fi

# max-retries 0: a failed slot is simply retried by the next one 10 min later.
ARGS=(--region "${REGION}" --image "${IMAGE}" --memory 2Gi --cpu 1 --max-retries 0 --task-timeout 900
      --set-env-vars "R2_ENDPOINT_URL=https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com,R2_BUCKET=tc-atlas-rt"
      --set-secrets "R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest")
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" "${ARGS[@]}"
else
    gcloud run jobs create "${JOB_NAME}" "${ARGS[@]}"
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB_NAME}:run"
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" --region "${REGION}" \
    --member "serviceAccount:${SA_EMAIL}" --role roles/run.invoker --quiet >/dev/null || true
SCHED=(--location "${REGION}" --schedule "${SCHEDULE}" --time-zone UTC --uri "${JOB_URI}"
       --http-method POST --oauth-service-account-email "${SA_EMAIL}" --attempt-deadline 60s)
if gcloud scheduler jobs describe "${SCHEDULER_NAME}" --location "${REGION}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${SCHEDULER_NAME}" "${SCHED[@]}"
else
    gcloud scheduler jobs create http "${SCHEDULER_NAME}" "${SCHED[@]}"
fi

echo
echo "Done. Run once now:  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait"
echo "Executions:          gcloud run jobs executions list --job ${JOB_NAME} --region ${REGION} --limit 8"
echo "Manifest:            curl -s https://cdn.tcatlas.org/pardig-v1/rain/frames.json?t=\$RANDOM"
