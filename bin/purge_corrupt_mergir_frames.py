#!/usr/bin/env python3
"""
Purge cached MergIR frames whose image fails the scene QC that /global/ir/frame
now runs (_mergir_scene_qc / _load_mergir_clean in global_archive_api.py,
2026-10-29).

Before the fix the API rendered the nearest half-hour slice whatever it held.
Some slices are not usable images: in the West Pacific before 2016 the
synoptic :00 slot is often a striped, partly empty fill (Cimaron 2006-10-29
00Z, 9.6% missing, stripe anisotropy 2.28 in the storm box). Those renders sit
in GCS and on R2, and R2 copies are served by 302 / CDN-direct without ever
reaching the new code, so they must be deleted to re-render as the nearest
clean scan.

Selection: source == "mergir", rendered before the fix (no qc_substituted /
qc_degraded field), and the decoded +/-6 deg box about the frame centre fails
fill > FILL_MAX or stripe anisotropy > ANISO_MAX. The cut-offs are a little
looser than the API's (0.06 / 1.8) because the cached image is quantised to
0.55 K; a clean frame caught by the margin just re-renders identically.

Sweeps (same layout as purge_fallback_frames.py):
  * GCS  gs://tc-atlas-ir-cache/v7/ir/<sid>/<idx>.json   (render cache)
  * R2   tc-atlas-rt/v7/ir/<sid>/<idx>.json              (public mirror)
  * GCS  archive/hovmoller/v15/<sid>.json for affected SIDs (built off frames)

Frames are READ through the public CDN (free egress, no credentials); GCS-only
objects (fallback renders, never mirrored) are read from GCS.

Usage:
  python3 bin/purge_corrupt_mergir_frames.py                       # dry run
  python3 bin/purge_corrupt_mergir_frames.py --sid 2006298N12143   # one storm
  python3 bin/purge_corrupt_mergir_frames.py --apply               # delete
"""

import argparse
import base64
import json
import os
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
R2_BUCKET = os.environ.get("R2_BUCKET", "tc-atlas-rt")
R2_PUBLIC_BASE = "https://cdn.tcatlas.org"
FRAME_PREFIX = "v7/ir/"
HOV_PREFIX = "archive/hovmoller/v15/"
SCAN_WORKERS = 24
HALF_DEG = 6.0
FILL_MAX = 0.05
ANISO_MAX = 1.7
# Cloudflare answers Python-urllib's default User-Agent with 403 (the first dry
# run read only the ~20k frames GCS also holds; 138k R2-only frames errored).
CDN_HEADERS = {"User-Agent": "tc-atlas-maint/1.0 (+https://tcatlas.org)"}


def decode(fr):
    raw = np.frombuffer(base64.b64decode(fr["tb_data"]), np.uint8).reshape(fr["tb_rows"], fr["tb_cols"])
    scale = 254.0 / (fr["tb_vmax"] - fr["tb_vmin"])
    tb = fr["tb_vmin"] + (raw.astype(np.float32) - 1.0) / scale
    tb[raw == 0] = np.nan
    return tb


def scene_qc(fr):
    """-> (is_bad, reason) on the +/-6 deg box about the frame centre."""
    b = fr["bounds"]
    tb = decode(fr)
    ny, nx = tb.shape
    clat, clon = (b["north"] + b["south"]) / 2, (b["west"] + b["east"]) / 2
    lats = b["north"] - (np.arange(ny) + 0.5) * (b["north"] - b["south"]) / ny
    lons = b["west"] + (np.arange(nx) + 0.5) * (b["east"] - b["west"]) / nx
    sub = tb[np.ix_(np.abs(lats - clat) <= HALF_DEG, np.abs(lons - clon) <= HALF_DEG)]
    fin = np.isfinite(sub)
    if fin.sum() < 100:
        return True, "empty"
    fill = float(1.0 - fin.mean())
    cj = float(np.nanmean(np.abs(np.diff(sub, axis=1))))
    rj = float(np.nanmean(np.abs(np.diff(sub, axis=0))))
    aniso = max(cj, rj) / max(min(cj, rj), 1e-6)
    reasons = ([f"fill={fill:.3f}"] if fill > FILL_MAX else []) + \
              ([f"stripe_aniso={aniso:.2f}"] if aniso > ANISO_MAX else [])
    return bool(reasons), ",".join(reasons)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="delete (default: dry run)")
    ap.add_argument("--sid", action="append", help="limit to these SIDs (repeatable)")
    ap.add_argument("--report", default="corrupt_mergir_frames_report.json")
    args = ap.parse_args()

    from google.cloud import storage
    bucket = storage.Client().bucket(GCS_BUCKET)
    prefixes = [f"{FRAME_PREFIX}{s}/" for s in args.sid] if args.sid else [FRAME_PREFIX]
    keep = lambda k: k.endswith(".json") and k.split("/")[2][:4].isdigit() and int(k.split("/")[2][:4]) >= 1998
    gcs_keys = {b.name for p in prefixes for b in bucket.list_blobs(prefix=p) if keep(b.name)}
    # Most rendered frames live on R2 only (the mirror outlives the GCS render
    # cache), and R2 is only listable with credentials.
    from purge_fallback_frames import get_r2_client          # env or Secret Manager
    r2 = get_r2_client()
    r2_keys = set()
    if r2 is not None:
        for p in prefixes:
            token = None
            while True:
                kw = {"Bucket": R2_BUCKET, "Prefix": p, **({"ContinuationToken": token} if token else {})}
                resp = r2.list_objects_v2(**kw)
                r2_keys |= {o["Key"] for o in resp.get("Contents", []) if keep(o["Key"])}
                if not resp.get("IsTruncated"):
                    break
                token = resp["NextContinuationToken"]
    else:
        print("WARN: no R2 credentials — R2-only frames cannot be listed; scanning GCS keys only")
    keys = sorted(gcs_keys | r2_keys)
    print(f"frame objects (1998+): GCS {len(gcs_keys)}, R2 {len(r2_keys)}, union {len(keys)}", flush=True)

    def fetch(key):
        if key in r2_keys or r2 is None:
            try:
                with urllib.request.urlopen(urllib.request.Request(f"{R2_PUBLIC_BASE}/{key}", headers=CDN_HEADERS),
                                            timeout=60) as r:
                    return json.loads(r.read())
            except Exception:
                if key not in gcs_keys:
                    raise
        return json.loads(bucket.blob(key).download_as_bytes())

    def scan(key):
        try:
            fr = fetch(key)
            if fr.get("source") != "mergir" or "qc_substituted" in fr or "qc_degraded" in fr:
                return key, None
            bad, why = scene_qc(fr)
            return key, (why, fr.get("datetime", "")) if bad else None
        except Exception as e:
            return key, ("ERR " + str(e)[:80], "")

    bad, errs = {}, []
    with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        futs = [pool.submit(scan, k) for k in keys]
        for i, fut in enumerate(as_completed(futs), 1):
            name, res = fut.result()
            if res and res[0].startswith("ERR"):
                errs.append((name, res[0]))
            elif res:
                bad[name] = res
            if i % 2000 == 0:
                print(f"  scanned {i}/{len(keys)} — {len(bad)} corrupt so far", flush=True)
    r2_bad = sorted(k for k in bad if k in r2_keys)

    per_sid = defaultdict(list)
    for k, (why, dt) in bad.items():
        per_sid[k.split("/")[2]].append((int(k.rsplit("/", 1)[1][:-5]), dt, why))
    sids = sorted(per_sid)
    print(f"\nCorrupt MergIR frames: {len(bad)} across {len(sids)} storms (on R2 {len(r2_bad)})")
    for sid in sids[:60]:
        rows = sorted(per_sid[sid])
        print(f"  {sid}: {len(rows)}  e.g. #{rows[0][0]} {rows[0][1]} {rows[0][2]}")
    if len(sids) > 60:
        print(f"  ... {len(sids) - 60} more storms in the report")
    if errs:
        print(f"WARN: {len(errs)} objects unreadable (left untouched), e.g. {errs[:3]}")
    hov_keys = [f"{HOV_PREFIX}{sid}.json" for sid in sids if bucket.blob(f"{HOV_PREFIX}{sid}.json").exists()]
    print(f"Hovmollers built on these frames: {len(hov_keys)}")
    with open(args.report, "w") as f:
        json.dump({"frames": {k: list(v) for k, v in sorted(bad.items())}, "r2": sorted(r2_bad),
                   "hovmoller": hov_keys, "errors": errs}, f, indent=1)
    print(f"Report -> {args.report}")

    if len(errs) > 0.01 * len(keys):
        print(f"\nINCOMPLETE SCAN: {len(errs)} of {len(keys)} objects unreadable — "
              f"{'refusing to delete; fix the reads and re-run' if args.apply else 'the counts above are partial'}.")
        return
    if not args.apply:
        print("\nDRY RUN — nothing deleted. Re-run with --apply to delete.")
        return

    gcs_bad = sorted(k for k in bad if k in gcs_keys)
    for i in range(0, len(gcs_bad), 100):
        bucket.delete_blobs([bucket.blob(k) for k in gcs_bad[i:i + 100]],
                            on_error=lambda b: print(f"  GCS delete failed: {b.name}"))
    print(f"Deleted {len(gcs_bad)} GCS frames")
    if hov_keys:
        bucket.delete_blobs([bucket.blob(k) for k in hov_keys],
                            on_error=lambda b: print(f"  GCS delete failed: {b.name}"))
        print(f"Deleted {len(hov_keys)} hovmollers")
    if r2 is None:
        print("R2 SKIPPED (no credentials) — corrupt frames still live on the CDN!")
    elif r2_bad:
        for i in range(0, len(r2_bad), 1000):
            r2.delete_objects(Bucket=R2_BUCKET, Delete={
                "Objects": [{"Key": k} for k in r2_bad[i:i + 1000]], "Quiet": True})
        print(f"Deleted {len(r2_bad)} R2 frames — CDN edge copies expire within 24 h unless purged")


if __name__ == "__main__":
    main()
