#!/usr/bin/env python3
"""Build the Global Archive "IR context" layer: one near-global 8 km IR image
per 3-hourly synoptic time, 1980 → today, uploaded to R2 as lossy WebP.

Why this exists
  The archive's storm frames are exact 4 km sectors around each storm
  (rendered on demand). This layer is the *visual* backdrop underneath them:
  every storm active at that time, the ITCZ, the whole basin. It is never
  read for values (Tb hover, radial profiles, exports all use the sector),
  so lossy encoding is acceptable: WebP q90 measured mean |err| 0.7 K,
  p99 2.8 K on a real MergIR frame, at ~1.3 MB/frame vs 3.7 MB lossless.
  Full 1980-2026 calendar ≈ 136k frames ≈ 180 GB on R2 (≈ $2.7/month,
  egress free).

Sources
  2000-present  MergIR (GPM_MERGIR.1) 4 km half-hourly, 60S-60N, from GES
                DISC (Earthdata login via ~/.netrc). time=0 of each file is
                the top of the hour. Averaged 2x2 → ~8 km.
  1980-1999     GridSat-B1 v02r01 3-hourly 0.07°, 70S-70N, from NCEI
                (irwin_cdr). Kept at native ~8 km.

Encoding
  8-bit index, frontend convention: 0 = missing, 1 = 170 K … 255 = 310 K
  (linear). Written as RGBA WebP: RGB = index (gray), A = validity mask.
  Missing pixels are nearest-filled BEFORE lossy encoding so the lossy luma
  never rings against index 0 (which would decode as false 170 K cold tops);
  the alpha plane (lossless in WebP) carries the true mask.

Layout on R2 (bucket tc-atlas-rt, public via cdn.tcatlas.org)
  ir-context/v1/{YYYY}/{YYYYMMDDHH}.webp        immutable, 1 y cache
  ir-context/v1/{YYYY}/index.json               {"ts": [...], "src", "bounds"}
  ir-context/v1/index.json                      {"years": {YYYY: {n, src}}}

Disk
  Each source file (~32 MB MergIR, ~10 MB GridSat) is downloaded to a temp
  dir, processed in memory, uploaded, and deleted immediately. Peak local
  footprint ≈ workers × 35 MB. The run aborts if free disk < --min-free-gb.

Resumable: existing keys under each year prefix are listed once and skipped.

Usage (on the Mac, under caffeinate so sleep can't kill it):
  caffeinate -i nohup python3 bin/build_ir_context.py --start 2022-09-27 --end 2022-09-29 &
  caffeinate -i nohup python3 bin/build_ir_context.py --start 1980-01-01 --end 2026-12-31 --workers 4 > ~/ir_context_build.log 2>&1 &
  python3 bin/build_ir_context.py --start 2022-09-28 --end 2022-09-28 --dry-run --out /tmp/ctx   # local files only
"""
import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import numpy as np

R2_ENDPOINT = os.environ.get("R2_ENDPOINT_URL", "https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com")
R2_BUCKET = os.environ.get("R2_BUCKET", "tc-atlas-rt")
PREFIX = "ir-context/v1"
MERGIR_DIRECT = "https://disc2.gesdisc.eosdis.nasa.gov/data/MERGED_IR/GPM_MERGIR.1"
GRIDSAT_DIRECT = "https://www.ncei.noaa.gov/data/geostationary-ir-channel-brightness-temperature-gridsat-b1/access"
TB_VMIN, TB_VMAX = 170.0, 310.0
WEBP_QUALITY = 90
MERGIR_FIRST_YEAR = 2000     # archive uses MergIR from 2000 on, GridSat before
GRIDSAT_FIRST_YEAR = 1980

_print_lock = threading.Lock()
_STOP = threading.Event()      # set by SIGINT/SIGTERM: finish in-flight, write indexes, exit
INDEX_FLUSH_EVERY = 200        # rewrite the year index this often so an interrupted run leaves a usable index
RETRIES = 3                    # per-frame attempts (sleep/wake and GES DISC hiccups fail transiently)
# Native grid edges per source — used for the index when a pass processed no
# frame of that source (e.g. a resume pass that found everything already built).
DEFAULT_BOUNDS = {
    "gridsat": {"south": -70.035, "north": 69.965, "west": -180.035, "east": 179.975},
    "mergir": {"south": -60.0, "north": 60.0, "west": -180.0, "east": 180.0},
}
_NC_LOCK = threading.Lock()    # HDF5/netCDF4 is NOT thread-safe: concurrent opens segfault the process.
                               # Downloads and WebP encoding stay parallel; only the file read is serialized.


def log(msg):
    with _print_lock:
        print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


# ── sources ──────────────────────────────────────────────────────────────
def source_for(dt):
    return "mergir" if dt.year >= MERGIR_FIRST_YEAR else "gridsat"


def source_url(dt):
    if source_for(dt) == "mergir":
        return f"{MERGIR_DIRECT}/{dt.year}/{dt.timetuple().tm_yday:03d}/merg_{dt:%Y%m%d%H}_4km-pixel.nc4"
    return f"{GRIDSAT_DIRECT}/{dt.year}/GRIDSAT-B1.{dt:%Y.%m.%d.%H}.v02r01.nc"


def make_session():
    import requests
    s = requests.Session()
    s.headers["User-Agent"] = "tc-atlas-ir-context-builder"
    # requests picks up ~/.netrc for urs.earthdata.nasa.gov on the redirect.
    return s


def download(session, url, dest, timeout=180):
    with session.get(url, stream=True, timeout=timeout, allow_redirects=True) as r:
        if r.status_code == 404:
            return None
        r.raise_for_status()
        ctype = r.headers.get("Content-Type", "")
        if "html" in ctype:
            raise RuntimeError(f"got HTML instead of data (Earthdata login?) for {url}")
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    return dest


# ── processing ───────────────────────────────────────────────────────────
def read_tb(path, src):
    """Return (tb float32 [lat asc, lon asc], lat_edges (s,n), lon_edges (w,e))."""
    import xarray as xr
    with xr.open_dataset(path, decode_times=False) as ds:
        if src == "mergir":
            v = ds["Tb"]
            arr = v.isel(time=0).values.astype(np.float32) if "time" in v.dims else v.values.astype(np.float32)
            lat = ds["lat"].values; lon = ds["lon"].values
        else:
            name = next(n for n in ("irwin_cdr", "irwin", "Tb") if n in ds)
            v = ds[name]
            arr = v.isel(time=0).values.astype(np.float32) if "time" in v.dims else v.values.astype(np.float32)
            lat = ds["lat"].values; lon = ds["lon"].values
    if lat[0] > lat[-1]:
        arr = arr[::-1]; lat = lat[::-1]
    if lon[0] > lon[-1]:
        arr = arr[:, ::-1]; lon = lon[::-1]
    dlat = float(abs(lat[1] - lat[0])); dlon = float(abs(lon[1] - lon[0]))
    return arr, (float(lat[0] - dlat / 2), float(lat[-1] + dlat / 2)), (float(lon[0] - dlon / 2), float(lon[-1] + dlon / 2))


def to_8km(arr, src):
    if src != "mergir":
        return arr                       # GridSat is already 0.07°
    H, W = arr.shape; H2, W2 = H // 2 * 2, W // 2 * 2
    blk = arr[:H2, :W2].reshape(H2 // 2, 2, W2 // 2, 2)
    with np.errstate(invalid="ignore"):
        return np.nanmean(blk, axis=(1, 3))


def nearest_fill(arr, mask):
    """Fill masked pixels with the nearest valid value (for lossy-safe edges)."""
    if not mask.any():
        return arr
    if mask.all():
        return np.full_like(arr, 290.0)
    try:
        from scipy import ndimage
        idx = ndimage.distance_transform_edt(mask, return_distances=False, return_indices=True)
        return arr[tuple(idx)]
    except Exception:
        out = arr.copy(); out[mask] = 290.0
        return out


def quantize(tb):
    q = 1.0 + (tb - TB_VMIN) / (TB_VMAX - TB_VMIN) * 254.0
    return np.clip(np.round(q), 1, 255).astype(np.uint8)


def encode_webp(tb8):
    from PIL import Image
    mask = ~np.isfinite(tb8)
    q = quantize(nearest_fill(np.where(mask, np.nan, tb8), mask))
    # north-up image: row 0 = north
    q = q[::-1]; alpha = np.where(mask[::-1], 0, 255).astype(np.uint8)
    rgba = np.dstack([q, q, q, alpha])
    b = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(b, "WEBP", quality=WEBP_QUALITY, method=4)
    return b.getvalue(), float(mask.mean())


# ── R2 ───────────────────────────────────────────────────────────────────
def get_r2_client():
    ak = os.environ.get("R2_ACCESS_KEY_ID", ""); sk = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not (ak and sk):
        ak = subprocess.check_output(["gcloud", "secrets", "versions", "access", "latest", "--secret", "r2-access-key-id"], text=True).strip()
        sk = subprocess.check_output(["gcloud", "secrets", "versions", "access", "latest", "--secret", "r2-secret-access-key"], text=True).strip()
    import boto3
    from botocore.config import Config
    return boto3.client("s3", endpoint_url=R2_ENDPOINT, aws_access_key_id=ak, aws_secret_access_key=sk,
                        region_name="auto", config=Config(signature_version="s3v4", max_pool_connections=32,
                                                          retries={"max_attempts": 5, "mode": "standard"}))


def list_existing(r2, year):
    keys = set(); token = None
    while True:
        kw = dict(Bucket=R2_BUCKET, Prefix=f"{PREFIX}/{year}/", MaxKeys=1000)
        if token: kw["ContinuationToken"] = token
        resp = r2.list_objects_v2(**kw)
        for o in resp.get("Contents", []):
            if o["Key"].endswith(".webp"):
                keys.add(o["Key"].rsplit("/", 1)[1][:-5])
        if not resp.get("IsTruncated"):
            return keys
        token = resp.get("NextContinuationToken")


def put(r2, key, body, ctype, cc):
    r2.put_object(Bucket=R2_BUCKET, Key=key, Body=body, ContentType=ctype, CacheControl=cc)


def write_year_index(r2, year, src, bounds_by_src, dry, out):
    if r2:
        ts = sorted(list_existing(r2, year))
    else:
        d = os.path.join(out, str(year))
        ts = sorted(f[:-5] for f in os.listdir(d) if f.endswith(".webp")) if os.path.isdir(d) else []
    bounds = bounds_by_src.get(src)
    if bounds is None and r2:          # keep what the previous index had
        try:
            prev = json.loads(r2.get_object(Bucket=R2_BUCKET, Key=f"{PREFIX}/{year}/index.json")["Body"].read())
            bounds = prev.get("bounds") or None
        except Exception:
            bounds = None
    if bounds is None:
        bounds = DEFAULT_BOUNDS[src]
    doc = {"year": year, "src": src, "n": len(ts), "ts": ts,
           "bounds": bounds, "vmin": TB_VMIN, "vmax": TB_VMAX,
           "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    body = json.dumps(doc, separators=(",", ":")).encode()
    if dry:
        os.makedirs(os.path.join(out, str(year)), exist_ok=True)
        open(os.path.join(out, str(year), "index.json"), "wb").write(body)
    else:
        put(r2, f"{PREFIX}/{year}/index.json", body, "application/json", "public, max-age=3600")
    return len(ts)


def write_root_index(r2, years_meta, bounds_by_src, dry, out):
    doc = {"prefix": PREFIX, "quality": WEBP_QUALITY, "vmin": TB_VMIN, "vmax": TB_VMAX,
           "sources": {"mergir": {"res_deg": 0.0727, "bounds": bounds_by_src.get("mergir") or DEFAULT_BOUNDS["mergir"]},
                       "gridsat": {"res_deg": 0.07, "bounds": bounds_by_src.get("gridsat") or DEFAULT_BOUNDS["gridsat"]}},
           "years": years_meta, "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    body = json.dumps(doc, separators=(",", ":")).encode()
    if dry:
        open(os.path.join(out, "index.json"), "wb").write(body)
    else:
        put(r2, f"{PREFIX}/index.json", body, "application/json", "public, max-age=3600")


# ── main loop ────────────────────────────────────────────────────────────
def free_gb(path):
    st = os.statvfs(path); return st.f_bavail * st.f_frsize / 1e9


def process_one(dt, session, r2, tmpdir, dry, out, bounds_by_src):
    src = source_for(dt); url = source_url(dt); key = f"{PREFIX}/{dt.year}/{dt:%Y%m%d%H}.webp"
    local = os.path.join(tmpdir, f"{dt:%Y%m%d%H}_{src}.nc")
    t0 = time.time()
    try:
        last_err = None
        for attempt in range(RETRIES):
            if _STOP.is_set():
                return dt, "stopped", 0, 0.0
            try:
                if download(session, url, local) is None:
                    return dt, "missing", 0, 0.0
                last_err = None
                break
            except Exception as e:           # network blip, wake-from-sleep, 5xx
                last_err = e
                time.sleep(5 * (attempt + 1))
        if last_err is not None:
            raise last_err
        with _NC_LOCK:
            arr, lat_e, lon_e = read_tb(local, src)
        bounds_by_src.setdefault(src, {"south": round(lat_e[0], 4), "north": round(lat_e[1], 4),
                                       "west": round(lon_e[0], 4), "east": round(lon_e[1], 4)})
        webp, miss = encode_webp(to_8km(arr, src))
        if dry:
            os.makedirs(os.path.join(out, str(dt.year)), exist_ok=True)
            open(os.path.join(out, str(dt.year), f"{dt:%Y%m%d%H}.webp"), "wb").write(webp)
        else:
            put(r2, key, webp, "image/webp", "public, max-age=31536000, immutable")
        return dt, "ok", len(webp), time.time() - t0
    finally:
        try: os.remove(local)
        except OSError: pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", required=True, help="YYYY-MM-DD (inclusive, UTC)")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD (inclusive, UTC)")
    ap.add_argument("--step-hours", type=int, default=3)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true", help="write files under --out instead of R2")
    ap.add_argument("--out", default=os.path.expanduser("~/ir_context_out"))
    ap.add_argument("--tmp", default=None, help="download scratch dir (default: system temp)")
    ap.add_argument("--min-free-gb", type=float, default=5.0)
    ap.add_argument("--no-index", action="store_true", help="skip per-year/root index rewrite")
    args = ap.parse_args()

    start = datetime.strptime(args.start, "%Y-%m-%d"); end = datetime.strptime(args.end, "%Y-%m-%d")
    if start.year < GRIDSAT_FIRST_YEAR:
        sys.exit(f"GridSat-B1 starts {GRIDSAT_FIRST_YEAR}; nothing earlier is available")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    # Fixed scratch dir: a hard kill can't leak temp files across runs because
    # anything left from a previous run is purged here.
    tmpdir = args.tmp or os.path.expanduser("~/.cache/tc-atlas-ir-context")
    os.makedirs(tmpdir, exist_ok=True)
    for f in os.listdir(tmpdir):
        try: os.remove(os.path.join(tmpdir, f))
        except OSError: pass

    import signal
    def _on_signal(signum, _frame):
        log(f"signal {signum}: finishing in-flight frames, then writing indexes and exiting")
        _STOP.set()
    signal.signal(signal.SIGINT, _on_signal); signal.signal(signal.SIGTERM, _on_signal)
    r2 = None if args.dry_run else get_r2_client()
    if args.dry_run: os.makedirs(args.out, exist_ok=True)
    session = make_session()
    bounds_by_src = {}
    years_meta = {}

    year = start.year
    while year <= end.year:
        y0 = max(start, datetime(year, 1, 1)); y1 = min(end + timedelta(days=1), datetime(year + 1, 1, 1), now)
        todo = []
        t = y0
        while t < y1:
            todo.append(t); t += timedelta(hours=args.step_hours)
        existing = list_existing(r2, year) if r2 else set()
        todo = [t for t in todo if f"{t:%Y%m%d%H}" not in existing]
        log(f"{year}: {len(todo)} frames to build ({len(existing)} already on R2), src={source_for(datetime(year,6,1))}")
        n_ok = n_missing = n_err = 0; bytes_total = 0; t_year = time.time()
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = {}
            it = iter(todo)
            def submit_next():
                if _STOP.is_set():
                    return False
                try:
                    dt = next(it)
                except StopIteration:
                    return False
                futs[pool.submit(process_one, dt, session, r2, tmpdir, args.dry_run, args.out, bounds_by_src)] = dt
                return True
            for _ in range(args.workers * 2):
                if not submit_next(): break
            while futs:
                if free_gb(tmpdir) < args.min_free_gb:
                    log(f"ABORT: free disk {free_gb(tmpdir):.1f} GB < {args.min_free_gb} GB"); shutil.rmtree(tmpdir, ignore_errors=True); sys.exit(2)
                done = next(as_completed(futs)); dt = futs.pop(done)
                try:
                    _, status, nbytes, secs = done.result()
                    if status == "ok":
                        n_ok += 1; bytes_total += nbytes
                        if n_ok % INDEX_FLUSH_EVERY == 0 and not args.no_index:
                            write_year_index(r2, year, source_for(datetime(year, 6, 1)), bounds_by_src, args.dry_run, args.out)
                    elif status == "missing":
                        n_missing += 1
                    if (n_ok + n_missing) % 50 == 0 or status != "ok":
                        rate = (n_ok + n_missing) / max(1e-6, time.time() - t_year)
                        log(f"{dt:%Y-%m-%d %HZ} {status:7s} {nbytes/1024:6.0f} KB {secs:4.1f}s | {n_ok} ok, {n_missing} missing, {n_err} err | {rate*3600:.0f}/h, {bytes_total/1e9:.2f} GB")
                except Exception as e:
                    n_err += 1; log(f"{dt:%Y-%m-%d %HZ} ERROR {type(e).__name__}: {str(e)[:200]} <{source_url(dt)}>")
                submit_next()
        if not args.no_index:
            n = write_year_index(r2, year, source_for(datetime(year, 6, 1)), bounds_by_src, args.dry_run, args.out)
            years_meta[str(year)] = {"n": n, "src": source_for(datetime(year, 6, 1))}
        log(f"{year} {'STOPPED' if _STOP.is_set() else 'done'}: {n_ok} built, {n_missing} missing upstream, {n_err} errors (rerun picks them up), {bytes_total/1e9:.2f} GB, {(time.time()-t_year)/60:.1f} min")
        if _STOP.is_set():
            break
        year += 1
    if not args.no_index and (r2 or args.dry_run):
        # merge with whatever the root index already knows (other year ranges)
        try:
            if r2:
                prev = json.loads(r2.get_object(Bucket=R2_BUCKET, Key=f"{PREFIX}/index.json")["Body"].read())
                merged = prev.get("years", {}); merged.update(years_meta); years_meta = merged
                for k, v in (prev.get("sources") or {}).items():
                    if v.get("bounds") and k not in bounds_by_src: bounds_by_src[k] = v["bounds"]
        except Exception:
            pass
        write_root_index(r2, years_meta, bounds_by_src, args.dry_run, args.out)
    for f in os.listdir(tmpdir):
        try: os.remove(os.path.join(tmpdir, f))
        except OSError: pass
    log("stopped cleanly (rerun to resume)" if _STOP.is_set() else "all done")
    sys.exit(3 if _STOP.is_set() else 0)


if __name__ == "__main__":
    main()
