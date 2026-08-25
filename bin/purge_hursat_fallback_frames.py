#!/usr/bin/env python3
"""
Purge index-mismatched HURSAT-fallback IR frames from the render caches.

When MergIR and GridSat both failed for a frame, ir_frame() used to fall back
to hursat_frames[frame_idx] — indexing HURSAT's own file list with the MergIR
frame index. The two index spaces do not correspond (the MergIR list is
3-hourly over the IBTrACS track; HURSAT files start on their own date and
have gaps), so the cached imagery can be from a different day entirely
(Nida 2009 frame 36: the 11-25 18:00 slot cached 11-27 15:00 imagery). Such
frames are immutable per (version, sid, frame_idx), so they never heal into
correct pixels on their own — healing only upgrades the source, and its
bounds-derived coordinates would inherit the wrong position anyway.

A frame is affected iff it lives under the MergIR/GridSat cache prefix
(v7/ir/) with "source": "hursat" and WITHOUT "actual_datetime" — the fixed
code stamps actual_datetime on every time-matched HURSAT substitution, so the
predicate stays valid after the fix deploys. Legitimate HURSAT-native frames
cache under v7/hursat/ and are untouched.

Sweeps (same layout as purge_dateline_frames.py):
  * GCS  gs://tc-atlas-ir-cache/v7/ir/<sid>/<idx>.json   (render cache)
  * R2   tc-atlas-rt/v7/ir/<sid>/<idx>.json              (public mirror)
  * GCS  archive/hovmoller/v15/<sid>.json for every affected SID (profiles
    read the same cached frames, so contaminated storms recompute)

"source" and "actual_datetime" sit in the first ~700 bytes of each frame
JSON (before tb_data), so the scan uses ranged GETs — it never downloads
frame payloads.

R2 credentials come from env (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) or,
failing that, Secret Manager via gcloud (r2-access-key-id / r2-secret-access-key).

Usage:
  python3 bin/purge_hursat_fallback_frames.py            # dry run: report only
  python3 bin/purge_hursat_fallback_frames.py --apply    # delete affected objects

After --apply, CDN copies of deleted R2 frames expire naturally within 24 h
(max-age=86400); the frontend's CDN-miss fallback re-renders via the API.
A purge-URL list is written to hursat_purge_urls.txt for an optional
targeted Cloudflare cache purge.
"""

import argparse
import re
import subprocess
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
R2_BUCKET = os.environ.get("R2_BUCKET", "tc-atlas-rt")
R2_ENDPOINT = os.environ.get(
    "R2_ENDPOINT_URL",
    "https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com",
)
R2_PUBLIC_BASE = "https://cdn.tcatlas.org"
FRAME_PREFIX = "v7/ir/"          # MergIR/GridSat cache; v7/hursat/ is native & untouched
HOV_PREFIX = "archive/hovmoller/v15/"
HEAD_BYTES = 700                 # source + actual_datetime sit before tb_data
SCAN_WORKERS = 16


_SOURCE_RE = re.compile(r'"source"\s*:\s*"([a-z]+)"')


def head_is_stale_hursat(head: bytes) -> bool | None:
    """True iff the frame head declares source hursat with no actual_datetime.
    None if the head has no source declaration at all (unparseable)."""
    text = head.decode("utf-8", "replace")
    m = _SOURCE_RE.search(text)
    if not m:
        return None
    return m.group(1) == "hursat" and '"actual_datetime"' not in text


def get_r2_client():
    ak = os.environ.get("R2_ACCESS_KEY_ID", "")
    sk = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not (ak and sk):
        try:
            ak = subprocess.check_output(
                ["gcloud", "secrets", "versions", "access", "latest",
                 "--secret", "r2-access-key-id"], text=True).strip()
            sk = subprocess.check_output(
                ["gcloud", "secrets", "versions", "access", "latest",
                 "--secret", "r2-secret-access-key"], text=True).strip()
        except Exception as e:
            print(f"WARN: no R2 credentials (env or Secret Manager): {e}")
            return None
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3", endpoint_url=R2_ENDPOINT,
        aws_access_key_id=ak, aws_secret_access_key=sk, region_name="auto",
        config=Config(signature_version="s3v4",
                      retries={"max_attempts": 3, "mode": "standard"}),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="delete (default: dry run)")
    args = ap.parse_args()

    from google.cloud import storage
    gcs = storage.Client()
    bucket = gcs.bucket(GCS_BUCKET)

    print(f"Listing gs://{GCS_BUCKET}/{FRAME_PREFIX} ...")
    blobs = [b for b in bucket.list_blobs(prefix=FRAME_PREFIX)
             if b.name.endswith(".json")]
    print(f"  {len(blobs)} frame objects to scan")

    def scan(blob):
        try:
            head = blob.download_as_bytes(start=0, end=HEAD_BYTES - 1)
        except Exception as e:
            return blob.name, None, f"read failed: {e}"
        return blob.name, head_is_stale_hursat(head), None

    bad, unparseable = [], []
    with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        futures = [pool.submit(scan, b) for b in blobs]
        for i, fut in enumerate(as_completed(futures), 1):
            name, stale, err = fut.result()
            if err or stale is None:
                unparseable.append((name, err or "no source in head"))
            elif stale:
                bad.append(name)
            if i % 2000 == 0:
                print(f"  scanned {i}/{len(blobs)} — {len(bad)} affected so far")

    sids = sorted({k.split("/")[2] for k in bad})
    print(f"\nAffected: {len(bad)} frames across {len(sids)} storms")
    for sid in sids:
        n = sum(1 for k in bad if k.split("/")[2] == sid)
        print(f"  {sid}: {n} frames")
    if unparseable:
        print(f"WARN: {len(unparseable)} objects unparseable (left untouched):")
        for name, err in unparseable[:10]:
            print(f"  {name}: {err}")

    # Hovmöllers for affected storms read the same cached frames
    hov_keys = [f"{HOV_PREFIX}{sid}.json" for sid in sids
                if bucket.blob(f"{HOV_PREFIX}{sid}.json").exists()]
    print(f"Contaminated hovmollers present in GCS: {len(hov_keys)}")

    # R2 mirror side: mirror keys match GCS keys; also catch R2-only strays
    r2 = get_r2_client()
    r2_bad = list(bad)
    if r2 is not None:
        gcs_names = {b.name for b in blobs}
        strays = []
        token, kwargs = None, {"Bucket": R2_BUCKET, "Prefix": FRAME_PREFIX}
        while True:
            resp = r2.list_objects_v2(**kwargs, **({"ContinuationToken": token} if token else {}))
            for obj in resp.get("Contents", []):
                if obj["Key"].endswith(".json") and obj["Key"] not in gcs_names:
                    strays.append(obj["Key"])
            if not resp.get("IsTruncated"):
                break
            token = resp["NextContinuationToken"]
        for key in strays:
            try:
                head = r2.get_object(Bucket=R2_BUCKET, Key=key,
                                     Range=f"bytes=0-{HEAD_BYTES - 1}")["Body"].read()
                if head_is_stale_hursat(head):
                    r2_bad.append(key)
            except Exception:
                pass
        print(f"R2-only stray frames affected: {len(r2_bad) - len(bad)}")

    with open("hursat_purge_urls.txt", "w") as f:
        for key in sorted(set(r2_bad)):
            f.write(f"{R2_PUBLIC_BASE}/{key}\n")
    print("CDN purge URL list -> hursat_purge_urls.txt")

    if not args.apply:
        print("\nDRY RUN — nothing deleted. Re-run with --apply to delete.")
        return

    print("\nDeleting GCS frames ...")
    for i in range(0, len(bad), 100):
        bucket.delete_blobs([bucket.blob(k) for k in bad[i:i + 100]],
                            on_error=lambda b: print(f"  GCS delete failed: {b.name}"))
    print(f"  {len(bad)} GCS frames deleted")

    if hov_keys:
        bucket.delete_blobs([bucket.blob(k) for k in hov_keys],
                            on_error=lambda b: print(f"  GCS delete failed: {b.name}"))
        print(f"  {len(hov_keys)} hovmollers deleted")

    if r2 is not None and r2_bad:
        for i in range(0, len(r2_bad), 1000):
            chunk = r2_bad[i:i + 1000]
            r2.delete_objects(Bucket=R2_BUCKET, Delete={
                "Objects": [{"Key": k} for k in chunk], "Quiet": True})
        print(f"  {len(r2_bad)} R2 frames deleted "
              f"(CDN copies expire within 24 h; purge list written above)")
    elif r2 is None:
        print("  R2 SKIPPED (no credentials) — mirrored bad frames still live "
              "at cdn.tcatlas.org! Re-run with R2 creds.")


if __name__ == "__main__":
    main()
