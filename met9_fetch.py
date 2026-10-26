#!/usr/bin/env python3
"""met9_fetch.py — Meteosat-9 IODC (45.5°E) pre-step for the mosaic Cloud Run Job.

Fills the Africa / Indian Ocean gap that GOES-19/18 + Himawari-9 can't see.
Data: EUMETSAT Data Store, collection EO:EUM:DAT:MSG:HRSEVIRI-IODC (SEVIRI
Level 1.5, full disk every 15 min, ~0.5 min ingest lag). Contains EUMETSAT data;
credited on the site (realtime_ir.js attribution + about.html).

WHY a separate process: the .nat holds all 12 channels (a few hundred MB) and
Cloud Run's /tmp is RAM, so it can't sit on disk while the band children run
near the 4 GiB ceiling. This step runs ALONE before the bands
(mosaic_band_runner.py): download → decode IR_108 / WV_062 / VIS006 → write a
small float16 cache (~83 MB) → delete the .nat → exit (all transient memory
returns to the OS). Each band child then reads its channel from the cache
(build_ir_mosaic.read_met9_full_disk) with no satpy import.

Cache layout ($MET9_CACHE_DIR, default /tmp/met9_cache):
  ir.npy wv.npy vis.npy   float16, native SEVIRI 3712² grid (vis = 0-1 factor)
  nav.npz                 x, y (scan angle, rad), lon_0, sat_h, sweep, scan_dt, product
Written to a temp dir and renamed, so a reader never sees a half cache.

Failure is non-fatal by design: the runner logs it and the bands build the
mosaic without Meteosat-9 (the gap stays dark for that frame).

Off switch: MOSAIC_MET9=0 on the job (no redeploy) skips this step and drops
Meteosat-9 from the builder's satellite list.

Credentials: EUMDAC_KEY / EUMDAC_SECRET env (job secrets), else
~/.eumdac/credentials ("key,secret", written by `eumdac set-credentials`).

Usage:
  python met9_fetch.py                       # latest scan near the builder's frame time
  python met9_fetch.py --build-kernel        # ALSO (re)build kernels/met9_z4.npz from
                                             # the real navigation (local only: ~6.5 GB peak)
  python met9_fetch.py --synthetic           # nominal geometry + fake field (dev/test)
"""
import argparse
import os
import resource
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np

COLLECTION = "EO:EUM:DAT:MSG:HRSEVIRI-IODC"
CHANNELS = {"ir": ("IR_108", "brightness_temperature"),
            "wv": ("WV_062", "brightness_temperature"),
            "vis": ("VIS006", "reflectance")}
CACHE_DIR = os.environ.get("MET9_CACHE_DIR", "/tmp/met9_cache")
TOL_MIN = 20


def log(msg):
    print(f"[met9] {msg}", flush=True)


def _peak_rss_mib():
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / 1024.0 if sys.platform.startswith("linux") else r / 1048576.0


def frame_dt():
    """Same frame time the builder renders (build_ir_mosaic.main: now-20 min,
    floored to 10 min), so the scan we cache is the one the bands will want."""
    now = datetime.now(timezone.utc) - timedelta(minutes=20)
    return now.replace(minute=now.minute - (now.minute % 10), second=0,
                       microsecond=0).replace(tzinfo=None)


def _credentials():
    k, s = os.environ.get("EUMDAC_KEY"), os.environ.get("EUMDAC_SECRET")
    if k and s:
        return k.strip(), s.strip()
    p = os.path.expanduser("~/.eumdac/credentials")
    if os.path.exists(p):
        k, s = open(p).read().strip().split(",", 1)
        return k.strip(), s.strip()
    return None


def download_nat(dt, work):
    """Latest IODC scan whose start is nearest the frame time (within TOL_MIN).
    Returns (nat_path, scan_start, product_id) or None."""
    import eumdac
    cred = _credentials()
    if not cred:
        log("no EUMETSAT credentials (EUMDAC_KEY/EUMDAC_SECRET) — skip")
        return None
    t0 = time.time()
    coll = eumdac.DataStore(eumdac.AccessToken(cred)).get_collection(COLLECTION)
    prods = list(coll.search(dtstart=dt - timedelta(minutes=TOL_MIN + 15),
                             dtend=dt + timedelta(minutes=TOL_MIN)))
    best, best_gap = None, None
    for p in prods:
        st = p.sensing_start.replace(tzinfo=None)
        gap = abs((st - dt).total_seconds()) / 60.0
        if gap <= TOL_MIN and (best_gap is None or gap < best_gap):
            best, best_gap = p, gap
    if best is None:
        log(f"no IODC scan within {TOL_MIN} min of {dt:%H:%M}Z "
            f"({len(prods)} in window) — skip")
        return None
    nat = next((e for e in best.entries if e.lower().endswith(".nat")), None)
    if not nat:
        log(f"{best}: no .nat entry — skip")
        return None
    scan = best.sensing_start.replace(tzinfo=None)
    log(f"search {time.time()-t0:.1f}s → {best} (scan {scan:%H:%M}Z, "
        f"{best_gap:.0f} min from frame)")
    t0 = time.time()
    dest = os.path.join(work, os.path.basename(nat))
    with best.open(entry=nat) as src, open(dest, "wb") as dst:
        shutil.copyfileobj(src, dst, 8 << 20)
    mb = os.path.getsize(dest) / 1e6
    log(f"download {time.time()-t0:.1f}s ({mb:.0f} MB)")
    return dest, scan, str(best)


def decode(nat):
    """→ ({product: float32 2-D}, nav). Navigation comes from satpy's own area
    definition (pixel-centre projection vectors), so whatever orientation the
    reader returns, x/y follow the array and the builder's kernel lines up."""
    t0 = time.time()
    from satpy import Scene
    t_imp = time.time() - t0
    t0 = time.time()
    scn = Scene(reader="seviri_l1b_native", filenames=[nat])
    for prod, (ch, cal) in CHANNELS.items():
        scn.load([ch], calibration=cal)
    out = {}
    for prod, (ch, _cal) in CHANNELS.items():
        a = np.asarray(scn[ch].values, dtype=np.float32)
        if prod == "vis":
            a = a / 100.0                    # satpy % → the builder's 0-1 factor
        out[prod] = a
    area = scn[CHANNELS["ir"][0]].attrs["area"]
    crs = area.crs.to_dict()
    h = float(crs["h"])
    xm, ym = area.get_proj_vectors()
    nav = dict(x=np.asarray(xm, np.float64) / h, y=np.asarray(ym, np.float64) / h,
               lon_0=float(crs.get("lon_0", 45.5)), sat_h=h,
               sweep=str(crs.get("sweep", "y")))
    ir = out["ir"]
    log(f"decode {time.time()-t0:.1f}s (+{t_imp:.1f}s satpy import) "
        f"{ir.shape} lon_0={nav['lon_0']} IR {np.nanmin(ir):.0f}-{np.nanmax(ir):.0f} K")
    return out, nav


def synthetic():
    """Nominal SEVIRI IODC geometry (3712² at 3 km) + a smooth fake field."""
    n, half, h = 3712, 5570248.4773392612, 35785831.0
    step = 2 * half / n
    xm = -half + step * (np.arange(n) + 0.5)
    ym = half - step * (np.arange(n) + 0.5)
    X, Y = np.meshgrid(xm / h, ym / h)
    ir = (260 + 30 * np.cos(40 * X) * np.cos(40 * Y)).astype(np.float32)
    out = {"ir": ir, "wv": ir - 30, "vis": np.clip((ir - 230) / 80, 0, 1)}
    return out, dict(x=xm / h, y=ym / h, lon_0=45.5, sat_h=h, sweep="y")


def write_cache(bands, nav, scan, product, cache_dir=CACHE_DIR):
    tmp = cache_dir + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    for prod, a in bands.items():
        np.save(os.path.join(tmp, f"{prod}.npy"), a.astype(np.float16))
    np.savez(os.path.join(tmp, "nav.npz"), x=nav["x"], y=nav["y"],
             lon_0=nav["lon_0"], sat_h=nav["sat_h"], sweep=nav["sweep"],
             scan_dt=scan.strftime("%Y%m%d%H%M"), product=product)
    shutil.rmtree(cache_dir, ignore_errors=True)
    os.rename(tmp, cache_dir)
    mb = sum(os.path.getsize(os.path.join(cache_dir, f))
             for f in os.listdir(cache_dir)) / 1e6
    log(f"cache → {cache_dir} ({mb:.0f} MB, scan {scan:%H:%M}Z)")


def build_kernel(nav, zoom):
    """geos→Mercator kernel from the REAL navigation, cropped to its on-disk
    bounding box (576 → ~162 MiB resident) — see build_ir_mosaic.crop_kernel.
    Local only: the full-res projection peaks ~6.5 GB, far over the job's 4 GiB,
    which is why the job never builds this kernel itself. Upload the result to
    R2 kernels/met9_z{zoom}.npz; Dockerfile.mosaic bakes it from the CDN."""
    import build_ir_mosaic as bim
    S = bim.TILE_SIZE * (2 ** zoom)
    t0 = time.time()
    px = np.arange(S, dtype=np.float64) + 0.5
    lon, lat = bim.pixels_to_lonlat(px[None, :], px[:, None], S)
    LON, LAT = np.broadcast_to(lon, (S, S)), np.broadcast_to(lat, (S, S))
    grid = bim.grid_of(nav["x"], nav["y"])
    idx, cosz, mask = bim.project_to_sat(LON, LAT, grid, nav["lon_0"],
                                         nav["sat_h"], nav["sweep"])
    kp = bim.kernel_path("met9", zoom)
    os.makedirs(os.path.dirname(kp), exist_ok=True)
    bim.save_cropped_kernel(kp, idx, cosz, mask, grid)
    log(f"kernel → {kp} ({os.path.getsize(kp)/1e6:.0f} MB) in {time.time()-t0:.0f}s")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dt", help="frame time YYYYmmddHHMM (default: builder's latest)")
    ap.add_argument("--build-kernel", action="store_true")
    ap.add_argument("--zoom", type=int, default=4)
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--cache-dir", default=CACHE_DIR)
    a = ap.parse_args()
    dt = datetime.strptime(a.dt, "%Y%m%d%H%M") if a.dt else frame_dt()
    t0 = time.time()
    if a.synthetic:
        bands, nav = synthetic()
        scan, product = dt, "synthetic"
    else:
        work = a.cache_dir + ".nat"
        shutil.rmtree(work, ignore_errors=True)
        os.makedirs(work)
        try:
            got = download_nat(dt, work)
            if not got:
                return 1
            nat, scan, product = got
            bands, nav = decode(nat)
        finally:
            shutil.rmtree(work, ignore_errors=True)    # the .nat never outlives decode
    write_cache(bands, nav, scan, product, a.cache_dir)
    if a.build_kernel:
        build_kernel(nav, a.zoom)
    log(f"done {time.time()-t0:.1f}s, peak RSS {_peak_rss_mib():.0f} MiB")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:                  # non-fatal: the runner carries on without M9
        log(f"FAILED: {type(e).__name__}: {e}")
        sys.exit(1)
