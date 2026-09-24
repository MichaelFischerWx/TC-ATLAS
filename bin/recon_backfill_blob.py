#!/usr/bin/env python3
"""Rebuild a past storm's recon blob from the NHC archive (30-s HDOB + TEMP DROP +
VDM) with recon_api._build_blob, chunked over 72-h windows and unioned, for
storms that predate the SEAR 1-s recon archive (2026-09-02). Output feeds
    sear_rt.py --archive --atcf <ATCF> --name <NAME> --blob <out.json.gz> --asof <end>
Usage: bin/recon_backfill_blob.py --atcf EP062026 --name FAUSTO --start 2026-07-26 --end 2026-07-30 --out fausto.json.gz
"""
import argparse, gzip, json, os, sys
from datetime import datetime, timedelta, timezone

os.environ.setdefault("GCS_IR_CACHE_BUCKET", "")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import recon_api as R  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--atcf", required=True); ap.add_argument("--name", required=True)
ap.add_argument("--start", required=True); ap.add_argument("--end", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()
t0 = datetime.strptime(a.start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
t1 = datetime.strptime(a.end, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1)
ac, vd, dr, seen_ac, seen_v, seen_d = [], [], [], set(), set(), set()
cur = t0 + timedelta(hours=72)
while cur - timedelta(hours=72) < t1:
    sim = min(cur, t1)
    b = R._build_blob(a.atcf.upper(), 72, sim, name=a.name.upper(), live_feed=False)
    for x in b.get("aircraft") or []:
        k = (x.get("tail"), x.get("sortie"))
        if k not in seen_ac and x.get("track"):
            seen_ac.add(k); ac.append(x)
    for v in b.get("vdms") or []:
        k = (v.get("t"), v.get("aircraft"))
        if k not in seen_v: seen_v.add(k); vd.append(v)
    for d in b.get("dropsondes") or []:
        k = (d.get("t"), d.get("tail"))
        if k not in seen_d: seen_d.add(k); dr.append(d)
    print(f"  window ending {sim:%Y-%m-%dT%H}Z: aircraft={len(b.get('aircraft') or [])} vdm={len(b.get('vdms') or [])} sondes={len(b.get('dropsondes') or [])}", flush=True)
    cur += timedelta(hours=72)
# the same tail may straddle two windows as two sortie entries; the scorer dedupes obs by (tail, time)
out = {"atcf_id": a.atcf.upper(), "name": a.name.upper(), "aircraft": ac, "vdms": vd, "dropsondes": dr,
       "counts": {"obs": sum(len(x["track"]) for x in ac), "vdms": len(vd), "dropsondes": len(dr)}, "backfill": True}
with gzip.open(a.out, "wt") as fh:
    json.dump(out, fh, separators=(",", ":"))
print(f"wrote {a.out}: {len(ac)} sortie entries, {out['counts']['obs']} obs, {len(vd)} VDM, {len(dr)} sondes")
