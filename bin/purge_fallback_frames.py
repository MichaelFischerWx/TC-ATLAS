#!/usr/bin/env python3
"""
Purge IR frames that were rendered from a FALLBACK source and frozen in cache.

/global/ir/frame cascades MergIR -> GridSat -> HURSAT. Before the 2026-10-22
fix, a frame whose preferred source failed transiently (GES DISC timeout,
429, ...) was rendered from the fallback, written to GCS AND mirrored to R2.
From then on the R2 fast path / CDN-direct fetch served it forever, and the
opportunistic heal (_maybe_heal_frame) never ran because it only fires on GCS
or in-memory hits. Hagibis 2019 (2019278N16165) frames 24-26 were GridSat
inside a MergIR storm, with the eye drawn 14-36 km off the MergIR eye fix.

A frame is a fallback iff its `source` ranks below the storm's preferred
source (same rule as _determine_preferred_source in global_archive_api.py):
  year >= 1998           -> preferred mergir
  1980 <= year <= 2024   -> preferred gridsat
  rank: mergir 0 < gridsat 1 < hursat 2

Deleting the cached copy is safe either way: the next view re-renders, and
(after the fix) a frame that falls back AGAIN stays in GCS only, where every
hit retries the preferred source instead of freezing on R2.

Sweeps:
  * GCS  gs://tc-atlas-ir-cache/v7/ir/<sid>/<idx>.json   (render cache)
  * R2   tc-atlas-rt/v7/ir/<sid>/<idx>.json              (public mirror,
         incl. R2-only strays)
  * GCS  archive/hovmoller/v15/<sid>.json for affected SIDs (radial profiles
         are computed off the cached frames)

Only the first ~400 bytes of each frame are read (source/bounds precede
tb_data).

Usage:
  python3 bin/purge_fallback_frames.py                 # dry run: report only
  python3 bin/purge_fallback_frames.py --sid 2019278N16165 --apply
  python3 bin/purge_fallback_frames.py --apply         # every fallback frame
"""

import argparse
import json
import os
import re
import subprocess
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
R2_BUCKET = os.environ.get("R2_BUCKET", "tc-atlas-rt")
R2_ENDPOINT = os.environ.get(
    "R2_ENDPOINT_URL",
    "https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com",
)
R2_PUBLIC_BASE = "https://cdn.tcatlas.org"
FRAME_PREFIX = "v7/ir/"
HOV_PREFIX = "archive/hovmoller/v15/"
HEAD_BYTES = 400
SCAN_WORKERS = 32

MERGIR_START_YEAR = 1998
GRIDSAT_START_YEAR, GRIDSAT_END_YEAR = 1980, 2024
RANK = {"mergir": 0, "gridsat": 1, "hursat": 2}

_SRC_RE = re.compile(r'"source"\s*:\s*"([a-z]+)"')
_DT_RE = re.compile(r'"datetime"\s*:\s*"([^"]*)"')


def preferred(sid: str):
    try:
        year = int(sid[:4])
    except ValueError:
        return None
    if year >= MERGIR_START_YEAR:
        return "mergir"
    if GRIDSAT_START_YEAR <= year <= GRIDSAT_END_YEAR:
        return "gridsat"
    return None


def classify(key: str, head: bytes):
    """-> (is_fallback, source, datetime) or None when unparseable."""
    txt = head.decode("utf-8", "replace")
    if re.search(r'"fallback_final"\s*:\s*true', txt):
        return False, "final", ""     # heal confirmed an archive gap; keep
    m = _SRC_RE.search(txt)
    if not m:
        return None
    src = m.group(1)
    d = _DT_RE.search(txt)
    pref = preferred(key.split("/")[2])
    fb = pref is not None and RANK.get(src, 99) > RANK.get(pref, 99)
    return fb, src, d.group(1) if d else ""


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
        config=Config(signature_version="s3v4", max_pool_connections=SCAN_WORKERS,
                      retries={"max_attempts": 3, "mode": "standard"}),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="delete (default: dry run)")
    ap.add_argument("--sid", action="append", help="limit to these SIDs (repeatable)")
    ap.add_argument("--report", default="fallback_frames_report.json",
                    help="JSON report path")
    args = ap.parse_args()

    from google.cloud import storage
    bucket = storage.Client().bucket(GCS_BUCKET)

    prefixes = [f"{FRAME_PREFIX}{s}/" for s in args.sid] if args.sid else [FRAME_PREFIX]
    blobs = []
    for p in prefixes:
        blobs += [b for b in bucket.list_blobs(prefix=p) if b.name.endswith(".json")]
    # Pre-filter: storms with no preferred source can't hold a fallback.
    blobs = [b for b in blobs if preferred(b.name.split("/")[2])]
    print(f"gs://{GCS_BUCKET}: {len(blobs)} frame objects to scan", flush=True)

    def scan_gcs(blob):
        try:
            return blob.name, classify(blob.name, blob.download_as_bytes(start=0, end=HEAD_BYTES - 1))
        except Exception as e:
            return blob.name, ("ERR", str(e))

    bad, by_src, unparse = {}, Counter(), []

    def take(name, res):
        if res is None or res[0] == "ERR":
            unparse.append((name, res[1] if res else "no source in head"))
            return
        fb, src, dt = res
        by_src[src] += 1
        if fb:
            bad[name] = (src, dt)

    with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        futs = [pool.submit(scan_gcs, b) for b in blobs]
        for i, fut in enumerate(as_completed(futs), 1):
            take(*fut.result())
            if i % 5000 == 0:
                print(f"  scanned {i}/{len(blobs)} — {len(bad)} fallback so far", flush=True)
    gcs_bad = sorted(bad)

    # R2 side: same keys, plus strays that only exist on R2.
    r2 = get_r2_client()
    r2_bad = []
    if r2 is not None:
        gcs_names = {b.name for b in blobs}
        r2_keys = []
        for p in prefixes:
            token = None
            while True:
                kw = {"Bucket": R2_BUCKET, "Prefix": p}
                if token:
                    kw["ContinuationToken"] = token
                resp = r2.list_objects_v2(**kw)
                r2_keys += [o["Key"] for o in resp.get("Contents", [])
                            if o["Key"].endswith(".json")]
                if not resp.get("IsTruncated"):
                    break
                token = resp["NextContinuationToken"]
        r2_set = set(r2_keys)
        r2_bad = [k for k in gcs_bad if k in r2_set]
        strays = [k for k in r2_keys if k not in gcs_names and preferred(k.split("/")[2])]
        print(f"R2: {len(r2_keys)} frame objects, {len(strays)} R2-only strays to scan", flush=True)

        def scan_r2(key):
            try:
                head = r2.get_object(Bucket=R2_BUCKET, Key=key,
                                     Range=f"bytes=0-{HEAD_BYTES - 1}")["Body"].read()
                return key, classify(key, head)
            except Exception as e:
                return key, ("ERR", str(e))

        with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
            for fut in as_completed([pool.submit(scan_r2, k) for k in strays]):
                key, res = fut.result()
                if res and res[0] is True:
                    bad[key] = (res[1], res[2])
                    r2_bad.append(key)

    per_sid = defaultdict(list)
    for k, (src, dt) in bad.items():
        per_sid[k.split("/")[2]].append((int(k.rsplit("/", 1)[1][:-5]), src, dt))
    sids = sorted(per_sid)

    print(f"\nSources seen (GCS): {dict(by_src)}")
    print(f"Fallback frames: {len(bad)} across {len(sids)} storms "
          f"(GCS {len(gcs_bad)}, on R2 {len(r2_bad)})")
    for sid in sids:
        rows = sorted(per_sid[sid])
        srcs = Counter(r[1] for r in rows)
        print(f"  {sid}: {len(rows)} ({', '.join(f'{s} {n}' for s, n in srcs.items())})"
              f"  e.g. #{rows[0][0]} {rows[0][2]}")
    if unparse:
        print(f"WARN: {len(unparse)} objects unparseable (left untouched), e.g. {unparse[:3]}")

    hov_keys = [f"{HOV_PREFIX}{sid}.json" for sid in sids
                if bucket.blob(f"{HOV_PREFIX}{sid}.json").exists()]
    print(f"Hovmollers built on these frames: {len(hov_keys)}")

    with open(args.report, "w") as f:
        json.dump({"frames": {k: list(v) for k, v in sorted(bad.items())},
                   "r2": sorted(r2_bad), "hovmoller": hov_keys,
                   "sources": dict(by_src)}, f, indent=1)
    print(f"Report -> {args.report}")

    if not args.apply:
        print("\nDRY RUN — nothing deleted. Re-run with --apply to delete.")
        return

    for i in range(0, len(gcs_bad), 100):
        bucket.delete_blobs([bucket.blob(k) for k in gcs_bad[i:i + 100]],
                            on_error=lambda b: print(f"  GCS delete failed: {b.name}"))
    print(f"Deleted {len(gcs_bad)} GCS frames")
    if hov_keys:
        bucket.delete_blobs([bucket.blob(k) for k in hov_keys],
                            on_error=lambda b: print(f"  GCS delete failed: {b.name}"))
        print(f"Deleted {len(hov_keys)} hovmollers")
    if r2 is not None and r2_bad:
        for i in range(0, len(r2_bad), 1000):
            r2.delete_objects(Bucket=R2_BUCKET, Delete={
                "Objects": [{"Key": k} for k in r2_bad[i:i + 1000]], "Quiet": True})
        print(f"Deleted {len(r2_bad)} R2 frames — CDN edge copies expire within "
              f"24 h unless purged:")
        for k in sorted(r2_bad)[:20]:
            print(f"  {R2_PUBLIC_BASE}/{k}")
    elif r2 is None:
        print("R2 SKIPPED (no credentials) — fallback frames still live on the CDN!")


if __name__ == "__main__":
    main()
