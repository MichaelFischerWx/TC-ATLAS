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
#   ./deploy.sh                    # deploy a CLEAN checkout of origin/main, then promote
#   ./deploy.sh --ref HEAD         # deploy local committed (but unpushed) HEAD, clean
#   ./deploy.sh --dirty            # deploy the working tree as-is (uncommitted WIP)
#   ./deploy.sh --no-promote       # build the revision but don't shift traffic to it
#   ./deploy.sh --tag v2           # deploy with a traffic tag
#
# By default the deploy builds from a throwaway worktree at origin/main (never
# the dirty working tree) and migrates 100% traffic to the new revision, so
# "deploy" always ships AND serves exactly what's on origin/main.
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

# ── Source selection: deploy a CLEAN commit, not the dirty tree ──────
# `gcloud run deploy --source .` ships whatever is on disk. With multiple
# editing sessions, the working tree is a soup of interleaved uncommitted
# WIP, so a plain deploy can silently ship half-finished other-session code
# (or a stale checkout). To make "what's live?" answerable, the DEFAULT now
# deploys a clean checkout of a git ref (origin/main) into a throwaway
# worktree — never the dirty working tree.
#
# Flags:
#   --dirty             deploy the working tree as-is (old behavior; for a
#                       quick test of UNCOMMITTED local changes)
#   --ref <committish>  deploy this ref instead of origin/main
#                       (e.g. --ref HEAD for committed-but-unpushed local work)
#   --no-promote        build the revision but DON'T migrate traffic to it
#   --force-stale       in --dirty mode, skip the origin/main divergence prompt
# Env:  DEPLOY_SKIP_FRESHNESS_CHECK=1 also skips the --dirty prompt.
DIRTY=0
NO_PROMOTE=0
FORCE_STALE=0
DEPLOY_REF="origin/main"
ARGS_FORWARD=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dirty)       DIRTY=1 ;;
        --no-promote)  NO_PROMOTE=1 ;;
        --force-stale) FORCE_STALE=1 ;;
        --ref)         DEPLOY_REF="${2:?--ref needs a committish}"; shift ;;
        *)             ARGS_FORWARD+=("$1") ;;
    esac
    shift
done

# Throwaway worktree (clean mode) is cleaned up on any exit.
CLEANUP_WORKTREE=""
cleanup_worktree() {
    if [[ -n "${CLEANUP_WORKTREE}" ]]; then
        git -C "${SCRIPT_DIR}" worktree remove "${CLEANUP_WORKTREE}" --force 2>/dev/null \
            || rm -rf "${CLEANUP_WORKTREE}"
    fi
}
trap cleanup_worktree EXIT

if [[ "${DIRTY}" == "1" ]]; then
    # ── Dirty mode: deploy the working tree (may include uncommitted WIP) ──
    DEPLOY_SRC="${SCRIPT_DIR}"
    echo "⚠️  --dirty: deploying the WORKING TREE (uncommitted changes included)."
    if [[ "${DEPLOY_SKIP_FRESHNESS_CHECK:-0}" != "1" && "${FORCE_STALE}" != "1" ]]; then
        if git -C "${SCRIPT_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
            git -C "${SCRIPT_DIR}" fetch origin main --quiet 2>/dev/null || true
            HEAD_SHA=$(git -C "${SCRIPT_DIR}" rev-parse HEAD 2>/dev/null || echo "?")
            REMOTE_SHA=$(git -C "${SCRIPT_DIR}" rev-parse origin/main 2>/dev/null || echo "?")
            [[ "${HEAD_SHA}" != "${REMOTE_SHA}" ]] && \
                echo "  HEAD ${HEAD_SHA:0:10} != origin/main ${REMOTE_SHA:0:10}"
            [[ -n "$(git -C "${SCRIPT_DIR}" status --porcelain 2>/dev/null)" ]] && \
                echo "  Working tree has UNCOMMITTED changes (they will ship)."
            read -p "Deploy the dirty working tree? [y/N] " -n 1 -r; echo
            [[ $REPLY =~ ^[Yy]$ ]] || exit 1
        fi
    fi
else
    # ── Clean mode (default): deploy a throwaway worktree at DEPLOY_REF ──
    if ! git -C "${SCRIPT_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
        echo "ERROR: not a git repo; use --dirty to deploy the directory as-is." >&2
        exit 1
    fi
    if [[ "${DEPLOY_REF}" == origin/* ]]; then
        echo "Fetching ${DEPLOY_REF}..."
        git -C "${SCRIPT_DIR}" fetch origin "${DEPLOY_REF#origin/}" --quiet \
            || { echo "ERROR: could not fetch ${DEPLOY_REF}." >&2; exit 1; }
    fi
    REF_SHA=$(git -C "${SCRIPT_DIR}" rev-parse --verify "${DEPLOY_REF}^{commit}" 2>/dev/null) \
        || { echo "ERROR: ref '${DEPLOY_REF}' not found." >&2; exit 1; }
    CLEANUP_WORKTREE="${TMPDIR:-/tmp}/tc-atlas-deploy.$$"
    echo "Deploying CLEAN checkout of ${DEPLOY_REF} (${REF_SHA:0:10}) — working tree NOT used."
    git -C "${SCRIPT_DIR}" worktree add --quiet --detach "${CLEANUP_WORKTREE}" "${REF_SHA}" \
        || { echo "ERROR: worktree checkout failed." >&2; CLEANUP_WORKTREE=""; exit 1; }
    DEPLOY_SRC="${CLEANUP_WORKTREE}"
fi

# --no-promote builds the revision without shifting traffic to it.
PROMOTE_FLAGS=()
[[ "${NO_PROMOTE}" == "1" ]] && PROMOTE_FLAGS+=("--no-traffic")

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
    --source "${DEPLOY_SRC}" \
    --region "${REGION}" \
    --platform managed \
    --memory "${MEMORY}" \
    --cpu "${CPU}" \
    --timeout "${TIMEOUT}" \
    --port 8080 \
    --allow-unauthenticated \
    --update-env-vars "^||^TC_RADAR_S3_BUCKET=${TC_RADAR_S3_BUCKET:-}||TC_RADAR_S3_PREFIX=${TC_RADAR_S3_PREFIX:-tc-radar}||TC_RADAR_GCS_BUCKET=${TC_RADAR_GCS_BUCKET:-}||TC_RADAR_GCS_PREFIX=${TC_RADAR_GCS_PREFIX:-tc-radar}||GCS_IR_CACHE_BUCKET=${GCS_IR_CACHE_BUCKET:-tc-atlas-ir-cache}||AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}||EARTHDATA_USERNAME=${EARTHDATA_USERNAME:-}||CORS_ORIGINS=https://michaelfischerwx.github.io,http://localhost:8000||R2_ENDPOINT_URL=${R2_ENDPOINT_URL:-https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com}||R2_BUCKET=${R2_BUCKET:-tc-atlas-rt}||PUBLIC_BUNDLE_BASE=${PUBLIC_BUNDLE_BASE:-}" \
    --update-secrets "AWS_ACCESS_KEY_ID=aws-access-key-id:latest,AWS_SECRET_ACCESS_KEY=aws-secret-access-key:latest,EARTHDATA_PASSWORD=earthdata-pass:latest,R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest" \
    ${PROMOTE_FLAGS[@]+"${PROMOTE_FLAGS[@]}"} \
    ${ARGS_FORWARD[@]+"${ARGS_FORWARD[@]}"}

# ── Promote the new revision (make the deploy actually SERVE) ────────
# The service's traffic can be PINNED to a specific revision, in which case
# a plain `gcloud run deploy` BUILDS a new revision but does NOT serve it —
# the classic "deploy succeeded but my change isn't live." Make promotion
# explicit and loud so the serving revision never silently lags the build.
# Runs BEFORE the prewarm repoint so a prewarm hiccup can't leave the API
# stuck on the old revision.
NEW_REV=$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" \
    --format="value(status.latestCreatedRevisionName)" 2>/dev/null || echo "")
if [[ "${NO_PROMOTE}" == "1" ]]; then
    SERVING_REV=$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" \
        --format="value(status.traffic[0].revisionName)" 2>/dev/null || echo "?")
    echo ""
    echo "⚠️  --no-promote: built ${NEW_REV:-<new revision>} but did NOT migrate traffic."
    echo "    Still serving: ${SERVING_REV}"
    echo "    Promote when ready:"
    echo "      gcloud run services update-traffic ${SERVICE_NAME} --region ${REGION} --to-revisions ${NEW_REV}=100"
else
    echo ""
    echo "Promoting ${NEW_REV:-latest revision} to 100% traffic..."
    gcloud run services update-traffic "${SERVICE_NAME}" --region "${REGION}" --to-latest \
        --format="value(status.traffic[0].revisionName)" \
        || echo "  WARNING: traffic migration failed — run update-traffic manually (see below)."
    SERVING_REV=$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" \
        --format="value(status.traffic[0].revisionName)" 2>/dev/null || echo "?")
    echo "  Now serving: ${SERVING_REV}"
fi

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
