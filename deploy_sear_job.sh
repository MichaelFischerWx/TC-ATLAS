#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS SEAR real-time publisher -- Cloud Run Job (BACKSTOP) + Scheduler
# --------------------------------------------------------------------------
# The Mac is the primary SEAR runner (launchd com.fischerwx.sear-rt at
# :05/:20/:35/:50, ~$0). This job is the greedy fallback for the slots the
# Mac misses (asleep, commuting, offline):
#   * Scheduler fires :12/:27/:42/:57 -- 7 min after each Mac slot.
#   * sear_rt.py (SEAR_SKIP_IF_FRESH_MIN=10) reads sear-rt/_run_marker.json;
#     if the Mac completed within 10 min it exits in ~2 s (~$0.0001).
#     Otherwise it does the full pass (~1-2 min, ~$0.003 with a storm).
#   * Worst case (Mac never runs, recon every day): ~$0.30/day.
#
# Code lives in ~/github/MLBT (no git remote), so this script STAGES the
# runtime files into sear_job_ctx/ (gitignored) before Cloud Build.
#
# Usage:  ./deploy_sear_job.sh            # build + deploy + schedule
#         ./deploy_sear_job.sh --no-build # re-apply job/scheduler config only
# Disable the backstop:  gcloud scheduler jobs pause tc-atlas-sear-schedule --location us-east1
# --------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
[[ -n "${PROJECT}" ]] || { echo "ERROR: gcloud project not set"; exit 1; }

JOB_NAME="tc-atlas-sear-job"
REGION="us-east1"
SCHEDULER_NAME="tc-atlas-sear-schedule"
SCHEDULE="12,27,42,57 * * * *"
IMAGE="gcr.io/${PROJECT}/${JOB_NAME}:latest"
MLBT="${MLBT_DIR:-$HOME/github/MLBT}"
CTX="${SCRIPT_DIR}/sear_job_ctx"

if [[ "${1:-}" != "--no-build" ]]; then
    # ── Stage the runtime files ──────────────────────────────────────
    rm -rf "${CTX}"; mkdir -p "${CTX}/realtime" "${CTX}/SEAR/Scripts" "${CTX}/SEAR/Model"
    cp "${MLBT}/realtime/sear_rt.py" "${MLBT}/realtime/sear_swath.py" "${CTX}/realtime/"
    cp "${MLBT}"/external/SEAR/Scripts/*.py "${CTX}/SEAR/Scripts/"
    # Only the two model files sear_rt.py loads (SEAR_RMW_MODE=leg set).
    python3 - "${MLBT}/external/SEAR/Scripts/config.py" "${MLBT}/external/SEAR/Model" "${CTX}/SEAR/Model" <<'PY'
import re, shutil, sys, pathlib
cfg, src, dst = sys.argv[1:]
txt = pathlib.Path(cfg).read_text()
names = set(re.findall(r'MODEL_DIR / "([^"]+\.joblib)"', txt))
want = [n for n in names if ("v4_rmwLocal_wrel" in n or "v8_lnrmw_mono_param" in n)]
for n in want:
    shutil.copy(pathlib.Path(src) / n, dst); print("  model:", n)
assert len(want) == 2, want
PY
    du -sh "${CTX}"

    BUILD_CFG="$(mktemp -t tc-atlas-sear-cloudbuild.XXXXXX.yaml)"
    trap 'rm -f "${BUILD_CFG}"' EXIT
    cat > "${BUILD_CFG}" <<YAML
steps:
- name: 'gcr.io/cloud-builders/docker'
  entrypoint: 'bash'
  args: ['-c', 'docker pull ${IMAGE} || exit 0']
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-f', 'Dockerfile.sear', '--cache-from', '${IMAGE}', '-t', '${IMAGE}', '.']
- name: 'gcr.io/cloud-builders/docker'
  args: ['push', '${IMAGE}']
images: ['${IMAGE}']
YAML
    echo "Building ${IMAGE}..."
    gcloud builds submit --config "${BUILD_CFG}" --ignore-file .gcloudignore.sear "${SCRIPT_DIR}"
fi

# ── Cloud Run Job ────────────────────────────────────────────────────
# 1 vCPU / 2 GiB: a pass is a GFS 0.25 subset read + two LightGBM predicts.
# max-retries 0: a failed quarter-hour is simply re-attempted at the next
# scheduled slot; a retry of a slow pass would overlap the next one.
ARGS=(--region "${REGION}" --image "${IMAGE}" --memory 2Gi --cpu 1 --max-retries 0 --task-timeout 900
      --set-env-vars "R2_ENDPOINT_URL=https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com,R2_BUCKET=tc-atlas-rt"
      --set-secrets "R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest")
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" "${ARGS[@]}"
else
    gcloud run jobs create "${JOB_NAME}" "${ARGS[@]}"
fi

# ── Scheduler ────────────────────────────────────────────────────────
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
echo "Done. Force a full pass (ignores the Mac's marker):"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait --update-env-vars SEAR_SKIP_IF_FRESH_MIN=0"
echo "Executions:  gcloud run jobs executions list --job ${JOB_NAME} --region ${REGION} --limit 8"
echo "Who carried: gsutil cat gs://tc-atlas-ir-cache/sear-rt/_run_marker.json"
