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
SCHEDULE="*/10 * * * *"           # every 10 min (was 30). The overpass-aware gate in
                                  # mw_ingest.py (_pass_windows) makes OUT-OF-WINDOW ticks
                                  # cheap: when no sensor is inside its predicted
                                  # data-availability window (and the ≤2h safety-net
                                  # backfill isn't due) the run early-exits after a single
                                  # GCS read of passes_predicted.json — no PPS auth/listing.
                                  # So the tighter cadence buys ~10-min in-window pickup at
                                  # roughly flat Cloud Run cost. MISSING/STALE predictions
                                  # degrade to a full run every tick (i.e. old behavior).
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
PREDICT_SCHEDULE="0 */2 * * *"    # every 2 hours on the hour. TLEs update
                                  # daily and GMI's 72 h predict horizon means
                                  # an established storm's passes are caught
                                  # many cycles ahead, so 2 h is ample. (A 30 min
                                  # variant was tried to shrink the new-storm
                                  # blind window but reverted — not worth the
                                  # cost; the grazing-pass detection fix in
                                  # mw_ingest.py was the actual gap.)

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

# ── Optional creds — Space-Track (most-authoritative TLE source) ─────
# Pass prediction works without these: the open-source no-auth mirror
# (tle.ivanstanojevic.me) is the primary source and isn't blocked from
# Cloud Run egress the way CelesTrak is. Space-Track, if present, takes
# precedence as the more authoritative source (and fills sats the mirror
# lacks, e.g. F17). So we DETECT rather than REQUIRE these secrets and
# only wire them in when both exist. Free account: https://www.space-track.org
HAVE_SPACETRACK=0
if gcloud secrets describe space-track-user >/dev/null 2>&1 \
   && gcloud secrets describe space-track-pass >/dev/null 2>&1; then
    HAVE_SPACETRACK=1
    echo "Space-Track secrets found — wiring them in as the primary TLE source."
else
    echo "Space-Track secrets not found — proceeding with the open TLE mirror only."
    echo "  (optional) to add the authoritative source later:"
    echo "    printf '%s' 'USERNAME' | gcloud secrets create space-track-user --data-file=-"
    echo "    printf '%s' 'PASSWORD' | gcloud secrets create space-track-pass --data-file=-"
    echo "    then re-run this script."
fi

# ── Build the container image via Cloud Build ────────────────────────
# Write the build config to a temp file. We can't use process substitution
# (<(cat <<EOF)) here because gcloud rejects `--tag` and `--config` together —
# the custom Dockerfile (-f Dockerfile.mw) only works via --config.
# Pull the previous image (if any) so Docker can reuse its layers as
# a cache. Without --cache-from, every Cloud Build run rebuilds from
# scratch and the heavy pip-install step (scipy/matplotlib/h5netcdf/
# scikit-image/etc.) takes 5-10 min on its own — combined with a
# Dockerfile change it can balloon past 20 min. With layer caching,
# subsequent builds finish in ~1-2 min when only mw_ingest.py changes.
# The `|| true` swallows the no-previous-image case (first deploy).
#
# CACHEBUST: --cache-from has been observed to reuse a STALE `COPY *.py` layer
# even after the source changed (2026-07-02 shipped an old mw_ingest.py to a new
# digest). We pass a content hash of the copied files as a build-arg consumed by
# `ARG CACHEBUST` in Dockerfile.mw (placed just before the COPYs): unchanged
# source → same hash → COPY layer still cached (fast); any edit → new hash →
# COPY and everything after rebuild. Keeps the pip layer cached either way.
SRC_HASH="$(cat mw_ingest.py microwave_api.py | shasum -a 256 | cut -c1-16)"
BUILD_CFG="$(mktemp -t tc-atlas-mw-cloudbuild.XXXXXX.yaml)"
trap 'rm -f "${BUILD_CFG}"' EXIT
cat > "${BUILD_CFG}" <<EOF
steps:
- name: 'gcr.io/cloud-builders/docker'
  entrypoint: 'bash'
  args: ['-c', 'docker pull ${IMAGE} || true']
- name: 'gcr.io/cloud-builders/docker'
  args: ['build', '-f', 'Dockerfile.mw', '-t', '${IMAGE}', '--cache-from', '${IMAGE}', '--build-arg', 'CACHEBUST=${SRC_HASH}', '.']
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

GRANT_SECRETS="pps-user pps-pass"
if [ "${HAVE_SPACETRACK}" = "1" ]; then
    GRANT_SECRETS="${GRANT_SECRETS} space-track-user space-track-pass"
fi
# When the R2 CDN mirror is on (see MW_R2_MIRROR below), also (re)grant the SA
# access to the r2-* secrets so a re-enable is fully self-contained.
if [ "${MW_R2_MIRROR:-0}" = "1" ]; then
    GRANT_SECRETS="${GRANT_SECRETS} r2-access-key-id r2-secret-access-key"
fi
echo "Granting Secret Manager access on [${GRANT_SECRETS}] to ${SA_EMAIL}..."
for SECRET in ${GRANT_SECRETS}; do
    gcloud secrets add-iam-policy-binding "${SECRET}" \
        --member "serviceAccount:${SA_EMAIL}" \
        --role roles/secretmanager.secretAccessor \
        --quiet || true
done

# ── Create or update the Cloud Run Job ───────────────────────────────
# Build the secrets list dynamically so a missing (optional) Space-Track
# pair doesn't break the deploy — referencing a nonexistent secret in
# --set-secrets fails the whole command.
SECRETS="PPS_USER=pps-user:latest,PPS_PASS=pps-pass:latest"
if [ "${HAVE_SPACETRACK}" = "1" ]; then
    SECRETS="${SECRETS},SPACETRACK_USER=space-track-user:latest,SPACETRACK_PASS=space-track-pass:latest"
fi

# ── R2 CDN mirror toggle (default OFF) ───────────────────────────────
# Every rendered MW object is written to GCS (primary, must succeed). When the
# mirror is ON it is *also* best-effort mirrored to Cloudflare R2 and the browser
# manifest serves cdn.tcatlas.org URLs; when OFF, _get_r2_client() (mw_ingest.py)
# sees no R2 vars → returns None → _mw_public_url emits GCS URLs. Images render
# identically either way; the mirror only shifts *where* browsers fetch from.
#
# Disabled 2026-07-02: mirror was net-lossy ~$11-12/mo (uploaded ~4 GiB/day to R2
# but browsers pulled only 0.1-0.5 GiB/day of MW imagery from GCS). Flip back ON
# only if GCS egress from the microwave-nrt bucket ramps enough to beat the ~$0.43/day
# Cloud Run→R2 upload egress. Re-enable with:  MW_R2_MIRROR=1 ./deploy_mw_job.sh
# (or set MW_R2_MIRROR=1 in deploy.env for a durable flip). Nothing else to change.
MW_R2_MIRROR="${MW_R2_MIRROR:-0}"
ENV_VARS="GCS_MW_BUCKET=${BUCKET}"
if [ "${MW_R2_MIRROR}" = "1" ]; then
    echo "R2 CDN mirror: ENABLED (MW_R2_MIRROR=1)"
    SECRETS="${SECRETS},R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest"
    # ^||^ = use || as the pair delimiter (values are comma-free, but keep the
    # explicit delimiter so a future value with a comma can't split silently).
    ENV_VARS="^||^GCS_MW_BUCKET=${BUCKET}||R2_ENDPOINT_URL=${R2_ENDPOINT_URL:-https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com}||R2_BUCKET=${R2_MW_BUCKET:-tc-atlas-rt}"
else
    echo "R2 CDN mirror: DISABLED (MW imagery served from GCS; set MW_R2_MIRROR=1 to re-enable)"
fi
# 1 vCPU: granule rendering is serial and measured CPU utilization peaks at
# ~0.5 of the old 2-vCPU allocation (~1 core), so the 2nd vCPU sat idle. At 1
# vCPU wall-clock is unchanged, so in-window (active-overpass) latency is NOT
# degraded — the overpass-aware gate still does rapid pickup; this just stops
# paying for the idle core. Bump back to 2 if a future sensor parallelizes.
echo "Deploying Cloud Run Job ${JOB_NAME}..."
if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --memory 2Gi \
        --cpu 1 \
        --max-retries 1 \
        --task-timeout 900 \
        --set-env-vars "${ENV_VARS}" \
        --set-secrets "${SECRETS}"
else
    gcloud run jobs create "${JOB_NAME}" \
        --region "${REGION}" \
        --image "${IMAGE}" \
        --memory 2Gi \
        --cpu 1 \
        --max-retries 1 \
        --task-timeout 900 \
        --set-env-vars "${ENV_VARS}" \
        --set-secrets "${SECRETS}"
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

# ── Bucket lifecycle — auto-delete sensor PNG/GeoJSON files older than
# 7 days. Caps storage growth at ~2.5 GB regardless of how long this
# pipeline runs. Frontend only reads the last 48 hours, so 7-day
# retention gives ample buffer + room for ad-hoc retrospective work.
# Manifest and predictions files have no sensor prefix so they're
# left alone (they update in place and are tiny).
LIFECYCLE_JSON="$(mktemp -t tc-atlas-mw-lifecycle.XXXXXX.json)"
trap 'rm -f "${BUILD_CFG}" "${CORS_JSON}" "${PREDICT_BODY}" "${LIFECYCLE_JSON}"' EXIT
cat > "${LIFECYCLE_JSON}" <<EOF
{"lifecycle":{"rule":[{"action":{"type":"Delete"},"condition":{"age":7,"matchesPrefix":["GMI/","SSMIS/","AMSR2/","ATMS/"]}}]}}
EOF
echo "Setting 7-day lifecycle rule on gs://${BUCKET}..."
gsutil lifecycle set "${LIFECYCLE_JSON}" "gs://${BUCKET}" || echo "  (warning: lifecycle set failed)"

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
