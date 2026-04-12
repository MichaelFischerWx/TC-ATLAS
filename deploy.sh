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

# ── Configuration ─────────────────────────────────────────────
SERVICE_NAME="tc-atlas-api"
REGION="us-east1"                   # close to your S3 bucket in us-east-1
MEMORY="2Gi"                        # match your current Render plan
CPU="1"                             # 1 vCPU per instance
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
    --update-env-vars "^||^TC_RADAR_S3_BUCKET=${TC_RADAR_S3_BUCKET:-}||TC_RADAR_S3_PREFIX=${TC_RADAR_S3_PREFIX:-tc-radar}||TC_RADAR_GCS_BUCKET=${TC_RADAR_GCS_BUCKET:-}||TC_RADAR_GCS_PREFIX=${TC_RADAR_GCS_PREFIX:-tc-radar}||AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-}||AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-}||AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}||EARTHDATA_USERNAME=${EARTHDATA_USERNAME:-}||EARTHDATA_PASSWORD=${EARTHDATA_PASSWORD:-}||CORS_ORIGINS=https://michaelfischerwx.github.io,http://localhost:8000" \
    "$@"

echo ""
echo "Done! Update your frontend API_BASE to the URL above."
echo ""
echo "Useful commands:"
echo "  gcloud run services describe ${SERVICE_NAME} --region ${REGION}"
echo "  gcloud run services update ${SERVICE_NAME} --region ${REGION} --min-instances 1   # hurricane season"
echo "  gcloud run services update ${SERVICE_NAME} --region ${REGION} --min-instances 0   # off-season"
echo "  gcloud run services logs read ${SERVICE_NAME} --region ${REGION} --limit 50"
