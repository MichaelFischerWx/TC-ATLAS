#!/usr/bin/env python3
"""
upload_npz_to_gcs.py — Upload locally cached .npz MergIR frames to GCS.

Run this alongside precache_mergir.py to push completed frames to the
GCS cache so users see them on the live site immediately.

Usage:
    # One-shot: upload everything in ./mergir_cache
    python upload_npz_to_gcs.py --local-dir ./mergir_cache

    # Continuous mode: re-scan every 60s for new files (run alongside downloader)
    python upload_npz_to_gcs.py --local-dir ./mergir_cache --watch --interval 60

    # Dry run: count files without uploading
    python upload_npz_to_gcs.py --local-dir ./mergir_cache --dry-run

Environment variables required:
    GCS_IR_CACHE_BUCKET           (e.g. "tc-atlas-ir-cache")
    GOOGLE_APPLICATION_CREDENTIALS (path to GCS service account key)
"""

import argparse
import base64
import json
import logging
import os
import sys
import time

import numpy as np

# ---------------------------------------------------------------------------
# Configuration — must match precache_mergir.py and global_archive_api.py
# ---------------------------------------------------------------------------

GCS_CACHE_VERSION = "v6"
TB_VMIN = 170.0
TB_VMAX = 310.0
TB_SCALE = 254.0 / (TB_VMAX - TB_VMIN)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("upload_npz_to_gcs")


# ---------------------------------------------------------------------------
# Tb encoding (matches global_archive_api.py _encode_tb_uint8)
# ---------------------------------------------------------------------------

def encode_tb_uint8(frame_2d):
    arr = np.asarray(frame_2d, dtype=np.float32)
    mask = ~np.isfinite(arr) | (arr <= 0)
    scaled = np.clip((arr - TB_VMIN) * TB_SCALE + 1, 1, 255)
    scaled[mask] = 0
    encoded = scaled.astype(np.uint8)
    return {
        "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
        "tb_rows": encoded.shape[0],
        "tb_cols": encoded.shape[1],
        "tb_vmin": TB_VMIN,
        "tb_vmax": TB_VMAX,
    }


# ---------------------------------------------------------------------------
# GCS helpers
# ---------------------------------------------------------------------------

_gcs_bucket = None


def _get_gcs_bucket(bucket_name):
    global _gcs_bucket
    if _gcs_bucket is not None:
        return _gcs_bucket
    from google.cloud import storage
    client = storage.Client()
    _gcs_bucket = client.bucket(bucket_name)
    log.info(f"Connected to GCS bucket: {bucket_name}")
    return _gcs_bucket


def _gcs_cache_key(sid, frame_idx):
    return f"{GCS_CACHE_VERSION}/ir/{sid}/{frame_idx}.json"


# ---------------------------------------------------------------------------
# Scan and upload
# ---------------------------------------------------------------------------

def scan_local_dir(local_dir):
    """Find all .npz files and return list of (sid, fidx, filepath)."""
    results = []
    if not os.path.isdir(local_dir):
        return results
    for sid_dir in sorted(os.listdir(local_dir), reverse=True):  # newest SIDs first
        sid_path = os.path.join(local_dir, sid_dir)
        if not os.path.isdir(sid_path):
            continue
        for fname in sorted(os.listdir(sid_path)):
            if not fname.endswith(".npz"):
                continue
            fidx_str = fname.replace(".npz", "")
            try:
                fidx = int(fidx_str)
            except ValueError:
                continue
            results.append((sid_dir, fidx, os.path.join(sid_path, fname)))
    return results


def upload_batch(bucket, files, already_uploaded, dry_run=False):
    """Upload .npz files to GCS. Returns count of newly uploaded files."""
    uploaded = 0
    errors = 0

    for sid, fidx, filepath in files:
        key = _gcs_cache_key(sid, fidx)
        if key in already_uploaded:
            continue

        if dry_run:
            uploaded += 1
            already_uploaded.add(key)
            continue

        try:
            data = np.load(filepath, allow_pickle=False)
            tb = data["tb"]
            bounds_arr = data["bounds"]  # [south, north, west, east]
            meta = data["meta"]          # [datetime_str]

            bounds = {
                "south": float(bounds_arr[0]),
                "north": float(bounds_arr[1]),
                "west": float(bounds_arr[2]),
                "east": float(bounds_arr[3]),
            }
            frame_dt_str = str(meta[0])

            tb_encoded = encode_tb_uint8(tb)
            result = {
                "sid": sid,
                "frame_idx": fidx,
                "datetime": frame_dt_str,
                "source": "mergir",
                "bounds": bounds,
                **tb_encoded,
            }

            blob = bucket.blob(key)
            blob.upload_from_string(
                json.dumps(result, separators=(",", ":")),
                content_type="application/json",
                timeout=15,
            )
            already_uploaded.add(key)
            uploaded += 1

        except Exception as e:
            log.error(f"Failed {sid}/{fidx}: {e}")
            errors += 1

    return uploaded, errors


def main():
    parser = argparse.ArgumentParser(description="Upload cached .npz frames to GCS")
    parser.add_argument("--local-dir", required=True, help="Local cache directory (e.g. ./mergir_cache)")
    parser.add_argument("--bucket", default=None,
                        help="GCS bucket name (default: $GCS_IR_CACHE_BUCKET)")
    parser.add_argument("--dry-run", action="store_true", help="Count files without uploading")
    parser.add_argument("--watch", action="store_true",
                        help="Continuous mode: re-scan for new files periodically")
    parser.add_argument("--interval", type=int, default=60,
                        help="Seconds between re-scans in watch mode (default: 60)")
    args = parser.parse_args()

    bucket_name = args.bucket or os.environ.get("GCS_IR_CACHE_BUCKET", "")
    if not bucket_name and not args.dry_run:
        log.error("Set GCS_IR_CACHE_BUCKET or use --bucket")
        sys.exit(1)

    bucket = None if args.dry_run else _get_gcs_bucket(bucket_name)
    already_uploaded = set()

    if args.watch:
        log.info(f"Watch mode: scanning {args.local_dir} every {args.interval}s")
        total_uploaded = 0
        while True:
            files = scan_local_dir(args.local_dir)
            new_count, err_count = upload_batch(bucket, files, already_uploaded, args.dry_run)
            if new_count > 0:
                total_uploaded += new_count
                log.info(f"Uploaded {new_count} new frames ({total_uploaded} total, {err_count} errors)")
            time.sleep(args.interval)
    else:
        files = scan_local_dir(args.local_dir)
        log.info(f"Found {len(files)} .npz files in {args.local_dir}")
        uploaded, errors = upload_batch(bucket, files, already_uploaded, args.dry_run)
        action = "Would upload" if args.dry_run else "Uploaded"
        log.info(f"{action} {uploaded} frames, {errors} errors")


if __name__ == "__main__":
    main()
