#!/usr/bin/env bash
# --------------------------------------------------------------------------
# Migrate TC-RADAR Zarr stores from AWS S3 to Google Cloud Storage
#
# Prerequisites:
#   1. AWS CLI configured with access to the S3 bucket
#   2. gcloud CLI authenticated with access to the target GCS bucket
#   3. gsutil installed (comes with gcloud CLI)
#
# Usage:
#   export TC_RADAR_S3_BUCKET=your-s3-bucket
#   export TC_RADAR_GCS_BUCKET=your-gcs-bucket
#   ./migrate_s3_to_gcs.sh
#
# This copies all Zarr stores (swath, merge, mergir, era5) from S3 to GCS.
# The data is static, so this only needs to be run once.
# After migration, set TC_RADAR_GCS_BUCKET in deploy.env to enable GCS reads.
# --------------------------------------------------------------------------

set -euo pipefail

S3_BUCKET="${TC_RADAR_S3_BUCKET:?Set TC_RADAR_S3_BUCKET}"
S3_PREFIX="${TC_RADAR_S3_PREFIX:-tc-radar}"
GCS_BUCKET="${TC_RADAR_GCS_BUCKET:?Set TC_RADAR_GCS_BUCKET}"
GCS_PREFIX="${TC_RADAR_GCS_PREFIX:-tc-radar}"

echo "Migrating TC-RADAR Zarr stores"
echo "  From: s3://${S3_BUCKET}/${S3_PREFIX}/"
echo "  To:   gs://${GCS_BUCKET}/${GCS_PREFIX}/"
echo ""

# Zarr stores to migrate
STORES=("swath_early" "swath_recent" "merge_early" "merge_recent" "mergir" "era5")

for store in "${STORES[@]}"; do
    echo "──────────────────────────────────────────"
    echo "Migrating: ${store}"

    # Step 1: Download from S3 to local temp directory
    LOCAL_DIR="/tmp/tc-radar-migrate/${store}"
    mkdir -p "${LOCAL_DIR}"

    echo "  Downloading from S3..."
    aws s3 sync "s3://${S3_BUCKET}/${S3_PREFIX}/${store}" "${LOCAL_DIR}" --quiet

    # Step 2: Upload to GCS
    echo "  Uploading to GCS..."
    gsutil -m rsync -r "${LOCAL_DIR}" "gs://${GCS_BUCKET}/${GCS_PREFIX}/${store}"

    echo "  Done: ${store}"
    echo ""
done

echo "══════════════════════════════════════════"
echo "Migration complete!"
echo ""
echo "Next steps:"
echo "  1. Add TC_RADAR_GCS_BUCKET=${GCS_BUCKET} to your deploy.env"
echo "  2. Redeploy: ./deploy.sh"
echo "  3. Verify: curl https://your-api/health | jq '.gcs_zarr_alive'"
echo "  4. Once verified, you can optionally remove S3 data to stop paying for storage"
echo ""
echo "The API will automatically prefer GCS over S3 when TC_RADAR_GCS_BUCKET is set."
