#!/usr/bin/env bash
# One-shot operator script — 2026-09-01 cost/stability roadmap, items 1 + 5.
# Run from the repo root:  ./bin/ops_2026_09_01.sh
# Every step is idempotent; comment out anything you want to skip.
set -euo pipefail
REGION=us-east1

echo "── 1a. Deploy API from clean origin/main (watchdog, XFF, ops gate, allowlists, cache headers)"
./deploy.sh

echo "── 1b. Service env: glibc arena cap (same as the mosaic job) + ops-route secret"
OPS_SECRET="$(openssl rand -hex 16)"
gcloud run services update tc-atlas-api --region "$REGION" \
  --update-env-vars "MALLOC_ARENA_MAX=2,MALLOC_TRIM_THRESHOLD_=0,OPS_SECRET=${OPS_SECRET}"
echo "OPS_SECRET=${OPS_SECRET}   (save this; send header X-Ops-Key on /realtime/clear_cache etc.)"

echo "── 1c. Rebuild mosaic image (Himawari segment cache) + task timeout 600→900 s"
./deploy_mosaic_idx_job.sh

echo "── 5a. Delete retired Cloud Run jobs + their PAUSED schedulers"
gcloud run jobs delete tc-atlas-prewarm-job --region "$REGION" --quiet || true
gcloud run jobs delete tc-atlas-mosaic-job  --region "$REGION" --quiet || true
gcloud scheduler jobs delete tc-atlas-prewarm-schedule --location "$REGION" --quiet || true
gcloud scheduler jobs delete tc-atlas-mosaic-schedule  --location "$REGION" --quiet || true

echo "── 5b. Delete unreferenced GCS prefixes (~4 GiB; no code reads them — rt-v1 stays, it is live)"
for p in rt-v10 mw-v1 mw-v2 recon/v1 recon/v2 recon/v3 recon/v4 recon/v5; do
  gcloud storage rm -r "gs://tc-atlas-ir-cache/${p}/" || true
done

echo "── done. Verify:"
echo "gcloud run jobs list --region $REGION; gcloud scheduler jobs list --location $REGION"
