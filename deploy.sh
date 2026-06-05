#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS API — Deploy to Google Cloud Run
# (Tropical Cyclone Analysis Tool for Live and Archived Structure)
# --------------------------------------------------------------------------
# Prerequisites:
#   1. Install gcloud CLI: https://cloud.google.com/sdk/docs/install
#   2. Authenticate:       gcloud auth login
#   3. Set project:        gcloud config set project YOUR_PROJECT_ID
#   4. Enable APIs:        gcloud services enable run.googleapis.com \
#                              artifactregistry.googleapis.com \
#                              cloudbuild.googleapis.com
#
# First-time setup:
#   Copy deploy.env.example to deploy.env and fill in your secrets:
#     cp deploy.env.example deploy.env
#     # edit deploy.env with your S3 bucket and AWS keys
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh                    # deploy (reads secrets from deploy.env)
#   ./deploy.sh --tag v2           # deploy with a traffic tag
#
# After first deploy, update your frontend JS files:
#   const API_BASE = 'https://tc-atlas-api-XXXXXXXXXX-ue.a.run.app';
#   (Cloud Run will print the service URL after deploy)
# --------------------------------------------------------------------------

set -euo pipefail

# ── Load secrets from deploy.env if it exists ────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/deploy.env" ]]; then
    echo "Loading secrets from deploy.env..."
    set -a
    source "${SCRIPT_DIR}/deploy.env"
    set +a
fi

# ── Validate required secrets ────────────────────────────────
MISSING=""
[[ -z "${TC_RADAR_S3_BUCKET:-}" ]] && MISSING="${MISSING}  TC_RADAR_S3_BUCKET\n"
[[ -z "${AWS_ACCESS_KEY_ID:-}" ]]  && MISSING="${MISSING}  AWS_ACCESS_KEY_ID\n"
[[ -z "${AWS_SECRET_ACCESS_KEY:-}" ]] && MISSING="${MISSING}  AWS_SECRET_ACCESS_KEY\n"

if [[ -n "${MISSING}" ]]; then
    echo "WARNING: The following required env vars are not set:"
    echo -e "${MISSING}"
    echo "The deploy will proceed, but S3 data endpoints will not work."
    echo "Set them in deploy.env or export them in your shell."
    echo ""
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# ── Freshness check: make sure the working tree matches origin/main ──
# `gcloud run deploy --source .` ships whatever's in the current directory.
# A stale local checkout (forgot to `git pull` after a merge) silently
# deploys the previous version, which presents as "deploy succeeded but
# my new code isn't there." Surface this loudly before we waste a Cloud
# Build run on stale source.
#
# Bypass with DEPLOY_SKIP_FRESHNESS_CHECK=1 or --force-stale (e.g. local
# work-in-progress that's ahead of main and intentionally not pushed).
FORCE_STALE=0
ARGS_FORWARD=()
for arg in "$@"; do
    if [[ "$arg" == "--force-stale" ]]; then
        FORCE_STALE=1
    else
        ARGS_FORWARD+=("$arg")
    fi
done

if [[ "${DEPLOY_SKIP_FRESHNESS_CHECK:-0}" != "1" && "${FORCE_STALE}" != "1" ]]; then
    if git -C "${SCRIPT_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
        echo "Checking source freshness vs origin/main..."
        if ! git -C "${SCRIPT_DIR}" fetch origin main --quiet 2>/dev/null; then
            echo "  (warning: could not fetch origin/main; skipping freshness check)"
        else
            HEAD_SHA=$(git -C "${SCRIPT_DIR}" rev-parse HEAD)
            REMOTE_SHA=$(git -C "${SCRIPT_DIR}" rev-parse origin/main)
            if [[ "${HEAD_SHA}" != "${REMOTE_SHA}" ]]; then
                # Are we behind, ahead, or diverged?
                BEHIND=$(git -C "${SCRIPT_DIR}" rev-list --count "${HEAD_SHA}..${REMOTE_SHA}" 2>/dev/null || echo "?")
                AHEAD=$(git -C "${SCRIPT_DIR}" rev-list --count "${REMOTE_SHA}..${HEAD_SHA}" 2>/dev/null || echo "?")
                echo ""
                echo "WARNING: working tree is NOT at origin/main HEAD."
                echo "  HEAD:        ${HEAD_SHA:0:10}"
                echo "  origin/main: ${REMOTE_SHA:0:10}"
                if [[ "${BEHIND}" != "0" && "${BEHIND}" != "?" ]]; then
                    echo "  → ${BEHIND} commit(s) BEHIND origin/main."
                    echo "    Recent commits you don't have locally:"
                    git -C "${SCRIPT_DIR}" log --oneline "${HEAD_SHA}..${REMOTE_SHA}" 2>/dev/null | head -8 | sed 's/^/      /'
                    echo "    To pick them up:  git pull origin main"
                fi
                if [[ "${AHEAD}" != "0" && "${AHEAD}" != "?" ]]; then
                    echo "  → ${AHEAD} commit(s) AHEAD of origin/main (local-only work)."
                fi
                echo ""
                echo "Deploying anyway will ship YOUR local tree, including any"
                echo "uncommitted changes. To skip this check use --force-stale"
                echo "or set DEPLOY_SKIP_FRESHNESS_CHECK=1."
                echo ""
                read -p "Deploy stale/divergent source? [y/N] " -n 1 -r
                echo
                [[ $REPLY =~ ^[Yy]$ ]] || exit 1
            else
                echo "  ✓ HEAD matches origin/main (${HEAD_SHA:0:10})"
            fi
        fi
    fi
fi

# ── Configuration ─────────────────────────────────────────────
SERVICE_NAME="tc-atlas-api"
REGION="us-east1"                   # close to your S3 bucket in us-east-1
MEMORY="4Gi"                        # 4 GiB — full-volume NEXRAD super-res VCPs (10-14 sweeps × ~5500 rays × 1832 gates) OOM at 2 GiB during region-based dealiasing
CPU="1"                             # 1 vCPU — Cloud Run allows 1 vCPU at 4 GiB (only >4 GiB needs 2; the old "needs 2" note was wrong). Single gunicorn worker (1 GIL) + GCS-first serving + rendering offloaded to the prewarm Job make the 2nd core nearly idle: benchmarked p99 CPU ~55% on 2 vCPU, cached paths identical, worst-case uncached render only ~14% slower (I/O-bound, not CPU-bound). Memory stays 4 GiB for NEXRAD.
TIMEOUT="300s"                      # match gunicorn timeout
# NOTE: max-instances and concurrency are managed via gcloud CLI, not
# this script. Change them with:
#   gcloud run services update tc-atlas-api --region us-east1 --max-instances N --concurrency N

# ── Deploy ────────────────────────────────────────────────────
echo "Deploying ${SERVICE_NAME} to Cloud Run (${REGION})..."

gcloud run deploy "${SERVICE_NAME}" \
    --source . \
    --region "${REGION}" \
    --platform managed \
    --memory "${MEMORY}" \
    --cpu "${CPU}" \
    --timeout "${TIMEOUT}" \
    --port 8080 \
    --allow-unauthenticated \
    --update-env-vars "^||^TC_RADAR_S3_BUCKET=${TC_RADAR_S3_BUCKET:-}||TC_RADAR_S3_PREFIX=${TC_RADAR_S3_PREFIX:-tc-radar}||TC_RADAR_GCS_BUCKET=${TC_RADAR_GCS_BUCKET:-}||TC_RADAR_GCS_PREFIX=${TC_RADAR_GCS_PREFIX:-tc-radar}||GCS_IR_CACHE_BUCKET=${GCS_IR_CACHE_BUCKET:-tc-atlas-ir-cache}||AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}||EARTHDATA_USERNAME=${EARTHDATA_USERNAME:-}||CORS_ORIGINS=https://michaelfischerwx.github.io,http://localhost:8000" \
    --update-secrets "AWS_ACCESS_KEY_ID=aws-access-key-id:latest,AWS_SECRET_ACCESS_KEY=aws-secret-access-key:latest,EARTHDATA_PASSWORD=earthdata-pass:latest" \
    ${ARGS_FORWARD[@]+"${ARGS_FORWARD[@]}"}

# ── Re-point the prewarm job at the freshly built image ──────────
# tc-atlas-prewarm-job REUSES this service's container image. The
# keep-3 Artifact Registry cleanup prunes old digests, so the job MUST
# be re-pinned to the new build on every deploy or it breaks ~3 deploys
# later ("Image not found", failing silently every 10 min). The script
# pins the :latest tag, idempotently refreshing the job + scheduler.
if [[ -x "${SCRIPT_DIR}/deploy_prewarm_job.sh" ]]; then
    echo ""
    echo "Re-pointing prewarm job at the new image..."
    "${SCRIPT_DIR}/deploy_prewarm_job.sh"
fi

echo ""
echo "Done! Update your frontend API_BASE to the URL above."
echo ""
echo "Useful commands:"
echo "  gcloud run services describe ${SERVICE_NAME} --region ${REGION}"
echo "  gcloud run services update ${SERVICE_NAME} --region ${REGION} --min-instances 1   # hurricane season"
echo "  gcloud run services update ${SERVICE_NAME} --region ${REGION} --min-instances 0   # off-season"
echo "  gcloud run services logs read ${SERVICE_NAME} --region ${REGION} --limit 50"
