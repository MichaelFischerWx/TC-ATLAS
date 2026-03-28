#!/usr/bin/env python3
"""
precache_mergir.py — Bulk pre-cache MergIR IR frames for IBTrACS storms.

Downloads 20°×20° Tb subsets from NASA GES DISC (MergIR / GPM_MERGIR.1)
for every 3-hourly track position and stores them in GCS as ready-to-serve
JSON blobs (identical format to what the live API produces).

Usage:
    # North Atlantic, 1998-present (default)
    python precache_mergir.py --basin NA

    # Specific year range
    python precache_mergir.py --basin NA --start-year 2020 --end-year 2025

    # All basins
    python precache_mergir.py --basin ALL

    # Dry run (count frames without downloading)
    python precache_mergir.py --basin NA --dry-run

    # Resume from a specific storm (skip already-cached frames)
    python precache_mergir.py --basin NA --resume

Environment variables required:
    EARTHDATA_USER / EARTHDATA_PASS   — or —   EARTHDATA_TOKEN
    GCS_IR_CACHE_BUCKET               (e.g. "tc-atlas-ir-cache")
    GOOGLE_APPLICATION_CREDENTIALS    (path to GCS service account key)
"""

import argparse
import base64
import gc
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta

# ---------------------------------------------------------------------------
# Dependency check — install missing packages automatically
# ---------------------------------------------------------------------------

REQUIRED_PACKAGES = {
    "numpy": "numpy",
    "xarray": "xarray",
    "netCDF4": "netCDF4",
    "google.cloud.storage": "google-cloud-storage",
}


def _check_deps(dry_run=False):
    """Check for required packages; auto-install if missing."""
    # For dry-run, we only need numpy + json (stdlib) — skip heavy deps
    check = REQUIRED_PACKAGES if not dry_run else {"numpy": "numpy"}
    missing = []
    for import_name, pip_name in check.items():
        try:
            __import__(import_name)
        except ImportError:
            missing.append(pip_name)
    if missing:
        print(f"Installing missing packages: {', '.join(missing)}")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet"] + missing
            )
        except subprocess.CalledProcessError:
            print(f"ERROR: Failed to install: {', '.join(missing)}")
            print(f"Please install manually: pip install {' '.join(missing)}")
            sys.exit(1)


# Quick check: if --dry-run is in argv, only enforce minimal deps
_check_deps(dry_run="--dry-run" in sys.argv)

import numpy as np

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MERGIR_HALF_DOMAIN = 10.0  # 10° each direction = 20°×20° box
MERGIR_START_YEAR = 1998
TB_VMIN = 170.0
TB_VMAX = 310.0
TB_SCALE = 254.0 / (TB_VMAX - TB_VMIN)

GCS_CACHE_VERSION = "v6"  # Must match global_archive_api.py

# Rate limiting — be respectful to NASA GES DISC
MIN_REQUEST_INTERVAL = 0.5   # seconds between requests (conservative for bulk)
REQUEST_TIMEOUT = (15, 45)   # (connect, read) seconds

# Retry configuration
MAX_RETRIES = 3
RETRY_BACKOFF = 5  # seconds, multiplied by attempt number

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("precache_mergir")


# ---------------------------------------------------------------------------
# Earthdata ~/.netrc setup
# ---------------------------------------------------------------------------

def _setup_netrc():
    """
    Ensure ~/.netrc exists for NASA GES DISC OPeNDAP access.

    xarray.open_dataset() on OPeNDAP URLs uses the netCDF4/DAP client which
    reads ~/.netrc automatically for authentication. This is the same auth
    approach used by the working tropics_mergir_ir_tb_btcenter2.py script.
    """
    home = os.path.expanduser("~")
    netrc_path = os.path.join(home, ".netrc")

    # If .netrc already exists with earthdata entry, skip
    if os.path.exists(netrc_path):
        with open(netrc_path, "r") as f:
            if "urs.earthdata.nasa.gov" in f.read():
                log.info(f"Earthdata: using existing {netrc_path}")
                return True

    user = os.environ.get("EARTHDATA_USERNAME", os.environ.get("EARTHDATA_USER", ""))
    passwd = os.environ.get("EARTHDATA_PASSWORD", os.environ.get("EARTHDATA_PASS", ""))
    token = os.environ.get("EARTHDATA_TOKEN", "")

    if user and passwd:
        entry = (
            f"machine urs.earthdata.nasa.gov\n"
            f"    login {user}\n"
            f"    password {passwd}\n"
        )
    elif token:
        entry = (
            f"machine urs.earthdata.nasa.gov\n"
            f"    login token\n"
            f"    password {token}\n"
        )
    else:
        log.error(
            "No Earthdata credentials and no ~/.netrc found.\n"
            "Set EARTHDATA_USERNAME + EARTHDATA_PASSWORD, or create ~/.netrc with:\n"
            "  machine urs.earthdata.nasa.gov\n"
            "      login YOUR_USERNAME\n"
            "      password YOUR_PASSWORD"
        )
        return False

    try:
        # Append to existing .netrc or create new one
        with open(netrc_path, "a") as f:
            f.write(entry)
        os.chmod(netrc_path, 0o600)
        log.info(f"Earthdata: wrote credentials to {netrc_path}")
        return True
    except Exception as e:
        log.error(f"Failed to write {netrc_path}: {e}")
        return False


# ---------------------------------------------------------------------------
# GCS helpers
# ---------------------------------------------------------------------------

_gcs_bucket = None


def _get_gcs_bucket():
    global _gcs_bucket
    if _gcs_bucket is not None:
        return _gcs_bucket

    bucket_name = os.environ.get("GCS_IR_CACHE_BUCKET", "")
    if not bucket_name:
        log.error("GCS_IR_CACHE_BUCKET not set.")
        sys.exit(1)

    from google.cloud import storage
    client = storage.Client()
    _gcs_bucket = client.bucket(bucket_name)
    log.info(f"Connected to GCS bucket: {bucket_name}")
    return _gcs_bucket


def _gcs_cache_key(sid: str, frame_idx: int) -> str:
    return f"{GCS_CACHE_VERSION}/ir/{sid}/{frame_idx}.json"


def _gcs_frame_exists(bucket, sid: str, frame_idx: int) -> bool:
    """Check if a frame is already cached in GCS."""
    key = _gcs_cache_key(sid, frame_idx)
    return bucket.blob(key).exists()


def _gcs_put_frame(bucket, sid: str, frame_idx: int, result: dict):
    """Write a frame to GCS."""
    key = _gcs_cache_key(sid, frame_idx)
    blob = bucket.blob(key)
    blob.upload_from_string(
        json.dumps(result, separators=(",", ":")),
        content_type="application/json",
        timeout=15,
    )


# ---------------------------------------------------------------------------
# Tb encoding (matches global_archive_api.py _encode_tb_uint8)
# ---------------------------------------------------------------------------

def encode_tb_uint8(frame_2d):
    """Encode 2D Tb array as compact base64 uint8 string."""
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
# MergIR download
# ---------------------------------------------------------------------------

def _mergir_opendap_url(dt: datetime) -> str:
    """Build OPeNDAP base URL for a MergIR file (no subsetting constraint)."""
    jday = dt.timetuple().tm_yday
    time_str = dt.strftime("%Y%m%d%H")
    return (
        f"https://disc2.gesdisc.eosdis.nasa.gov/opendap/"
        f"MERGED_IR/GPM_MERGIR.1/{dt.year}/{jday:03d}/"
        f"merg_{time_str}_4km-pixel.nc4"
    )


def _get_candidate_urls(target_dt: datetime) -> list:
    """Return ordered candidate MergIR URLs for a target time."""
    file_dt = target_dt.replace(minute=0, second=0, microsecond=0)
    url_current = _mergir_opendap_url(file_dt)
    url_next = _mergir_opendap_url(file_dt + timedelta(hours=1))
    if target_dt.minute >= 30:
        return [url_next, url_current]
    else:
        return [url_current, url_next]


def _find_nearest_half_hour(target_dt, ir_times):
    """Find the closest time index in the MergIR file."""
    import pandas as pd
    diffs = []
    for i, t in enumerate(ir_times):
        ts = pd.Timestamp(t)
        diff_min = abs((target_dt - ts).total_seconds()) / 60.0
        diffs.append((i, diff_min))
    return min(diffs, key=lambda x: x[1])


def fetch_mergir_file(url, lat_bounds=None, lon_bounds=None, max_retries=MAX_RETRIES):
    """
    Fetch a MergIR file via OPeNDAP with spatial subsetting and retry logic.

    Mirrors tropics_mergir_ir_tb_btcenter2.py fetch_mergir_file() exactly.
    Auth is handled by ~/.netrc via the netCDF4/DAP client.

    Returns (ir_times, lats, lons, tb_data) or None on failure.
    """
    import xarray as xr

    for attempt in range(max_retries):
        try:
            ds = xr.open_dataset(url)
            ir_times = ds["time"].values
            if lat_bounds is not None and lon_bounds is not None:
                lat_min, lat_max = lat_bounds
                lon_min, lon_max = lon_bounds
                # MergIR lats can be descending (59.98 → -59.98)
                if ds["lat"].values[0] > ds["lat"].values[-1]:
                    lat_sl = slice(lat_max, lat_min)
                else:
                    lat_sl = slice(lat_min, lat_max)
                subset = ds.sel(lat=lat_sl, lon=slice(lon_min, lon_max))
                lats = subset["lat"].values
                lons = subset["lon"].values
                tb_data = subset["Tb"].values
            else:
                lats = ds["lat"].values
                lons = ds["lon"].values
                tb_data = ds["Tb"].values
            ds.close()
            time.sleep(0.5)
            return (ir_times, lats, lons, tb_data)
        except Exception as e:
            if attempt < max_retries - 1:
                log.debug(f"  Retry {attempt+1}/{max_retries} for {url}: {e}")
                time.sleep(5 * (attempt + 1))
    return None


def extract_frame_from_file(ir_times, all_lats, all_lons, tb_data,
                            target_dt, center_lat, center_lon):
    """
    Extract a single storm-centered frame from an already-fetched MergIR file.

    The file's spatial extent may cover a wide bounding box (union of multiple
    storms). This function extracts the MERGIR_HALF_DOMAIN subset for one storm.

    Returns (tb_2d_north_at_top, bounds_dict) or (None, None).
    """
    tidx, tdiff = _find_nearest_half_hour(target_dt, ir_times)
    if tdiff > 20.0:
        return None, None

    # tb_data shape is (n_times, n_lats, n_lons)
    tb_time = tb_data[tidx]

    # Find lat/lon index ranges for this storm's 20°×20° box
    lat_min = center_lat - MERGIR_HALF_DOMAIN
    lat_max = center_lat + MERGIR_HALF_DOMAIN
    lon_min = center_lon - MERGIR_HALF_DOMAIN
    lon_max = center_lon + MERGIR_HALF_DOMAIN

    lat_ascending = all_lats[-1] > all_lats[0]

    if lat_ascending:
        lat_mask = (all_lats >= lat_min) & (all_lats <= lat_max)
    else:
        lat_mask = (all_lats >= lat_min) & (all_lats <= lat_max)
    lon_mask = (all_lons >= lon_min) & (all_lons <= lon_max)

    lat_idx = np.where(lat_mask)[0]
    lon_idx = np.where(lon_mask)[0]

    if len(lat_idx) < 2 or len(lon_idx) < 2:
        return None, None

    tb = tb_time[lat_idx[0]:lat_idx[-1]+1, lon_idx[0]:lon_idx[-1]+1]
    sub_lats = all_lats[lat_idx[0]:lat_idx[-1]+1]
    sub_lons = all_lons[lon_idx[0]:lon_idx[-1]+1]

    actual_bounds = {
        "south": float(np.min(sub_lats)),
        "north": float(np.max(sub_lats)),
        "west": float(np.min(sub_lons)),
        "east": float(np.max(sub_lons)),
    }

    # Validate subset size
    lat_range = actual_bounds["north"] - actual_bounds["south"]
    lon_range = actual_bounds["east"] - actual_bounds["west"]
    if lat_range < MERGIR_HALF_DOMAIN or lon_range < MERGIR_HALF_DOMAIN:
        return None, None

    # Validate data completeness
    valid_frac = np.count_nonzero(np.isfinite(tb) & (tb > 0)) / tb.size
    if valid_frac < 0.3:
        return None, None

    # Ensure north-at-top (row 0 = north) for Leaflet
    if sub_lats[0] < sub_lats[-1]:
        tb = tb[::-1]

    return tb, actual_bounds


# ---------------------------------------------------------------------------
# Frame list builder (matches global_archive_api.py _build_mergir_frame_list)
# ---------------------------------------------------------------------------

def build_frame_list(track_points: list) -> list:
    """Build 3-hourly frame list from track points."""
    frames = []
    seen = set()

    for pt in track_points:
        t_str = pt.get("t", "")
        lat = pt.get("la")
        lon = pt.get("lo")
        if not t_str or lat is None or lon is None:
            continue

        try:
            dt = datetime.fromisoformat(t_str)
        except (ValueError, AttributeError):
            continue

        hour_3 = (dt.hour // 3) * 3
        dt_rounded = dt.replace(hour=hour_3, minute=0, second=0, microsecond=0)
        key = dt_rounded.strftime("%Y%m%d%H")

        if key in seen:
            continue
        seen.add(key)

        frames.append({
            "datetime": dt_rounded.strftime("%Y-%m-%dT%H:%M:00"),
            "lat": float(lat),
            "lon": float(lon),
        })

    frames.sort(key=lambda f: f["datetime"])
    return frames


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Pre-cache MergIR IR frames for IBTrACS storms")
    parser.add_argument("--basin", default="NA", help="Basin code (NA, EP, WP, etc.) or ALL")
    parser.add_argument("--start-year", type=int, default=MERGIR_START_YEAR)
    parser.add_argument("--end-year", type=int, default=2026)
    parser.add_argument("--dry-run", action="store_true", help="Count frames without downloading")
    parser.add_argument("--resume", action="store_true", help="Skip already-cached frames")
    parser.add_argument("--rate", type=float, default=MIN_REQUEST_INTERVAL,
                        help=f"Seconds between requests (default {MIN_REQUEST_INTERVAL})")
    parser.add_argument("--local-dir", default=None,
                        help="Save compressed .npz files locally (e.g. ./mergir_cache)")
    parser.add_argument("--no-gcs", action="store_true",
                        help="Skip GCS upload (local-only mode, requires --local-dir)")
    parser.add_argument("--storms-json", default="ibtracs_storms.json")
    parser.add_argument("--tracks-dir", default=".", help="Directory containing tracks JSON chunks")
    parser.add_argument("--sid", default=None, help="Process a single storm ID (for testing)")
    args = parser.parse_args()

    if args.no_gcs and not args.local_dir:
        parser.error("--no-gcs requires --local-dir")

    # ── Load IBTrACS data ──
    storms_path = os.path.join(args.tracks_dir, args.storms_json)
    log.info(f"Loading storms from {storms_path}")
    with open(storms_path) as f:
        storms_data = json.load(f)
    all_storms = storms_data["storms"]

    # Load track chunks
    tracks = {}
    tracks_dir = args.tracks_dir
    manifest_path = os.path.join(tracks_dir, "ibtracs_tracks_manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
        for chunk_file in manifest.get("chunks", manifest.get("files", [])):
            chunk_path = os.path.join(tracks_dir, chunk_file)
            log.info(f"Loading tracks from {chunk_path}")
            with open(chunk_path) as f:
                tracks.update(json.load(f))
    else:
        fallback = os.path.join(tracks_dir, "ibtracs_tracks.json")
        log.info(f"Loading tracks from {fallback}")
        with open(fallback) as f:
            tracks = json.load(f)

    log.info(f"Loaded {len(all_storms)} storms, {len(tracks)} tracks")

    # ── Filter storms ──
    if args.sid:
        target_storms = [s for s in all_storms if s["sid"] == args.sid]
    else:
        target_storms = [
            s for s in all_storms
            if (args.basin == "ALL" or s.get("basin") == args.basin)
            and args.start_year <= s.get("year", 0) <= args.end_year
        ]

    # Sort by year descending (most recent first) for orderly processing
    target_storms.sort(key=lambda s: (s.get("year", 0), s["sid"]), reverse=True)
    log.info(f"Target: {len(target_storms)} storms ({args.basin}, {args.start_year}-{args.end_year})")

    # ── Count total frames ──
    storm_frames = []
    total_frames = 0
    for s in target_storms:
        sid = s["sid"]
        if sid not in tracks:
            continue
        frames = build_frame_list(tracks[sid])
        if frames:
            storm_frames.append((s, frames))
            total_frames += len(frames)

    log.info(f"Total frames to process: {total_frames} across {len(storm_frames)} storms")

    if args.dry_run:
        # Print per-year breakdown
        from collections import Counter
        year_counts = Counter()
        unique_urls = set()
        for s, frames in storm_frames:
            year_counts[s.get("year", 0)] += len(frames)
            for frame in frames:
                target_dt = datetime.fromisoformat(frame["datetime"])
                primary_url = _get_candidate_urls(target_dt)[0]
                unique_urls.add(primary_url)
        for y in sorted(year_counts):
            print(f"  {y}: {year_counts[y]} frames")
        n_unique = len(unique_urls)
        print(f"\nTotal: {total_frames} frames across {n_unique} unique MergIR files")
        est_gb = total_frames * 550 * 550 / 1e9
        print(f"Estimated raw storage: {est_gb:.1f} GB (float32 .npz)")
        est_hours = n_unique * args.rate / 3600
        print(f"Estimated download time at {args.rate}s/file: {est_hours:.1f} hours")
        print(f"  (fetches {n_unique} unique files, not {total_frames} individual frames)")
        return

    # ── Init auth ──
    if not _setup_netrc():
        sys.exit(1)

    # ── Init storage backends ──
    use_gcs = not args.no_gcs
    bucket = _get_gcs_bucket() if use_gcs else None

    local_dir = args.local_dir
    if local_dir:
        os.makedirs(local_dir, exist_ok=True)
        log.info(f"Local save directory: {os.path.abspath(local_dir)}")

    # ── Build jobs and group by PRIMARY URL ──
    # Each "job" is one frame to cache. We map each job to its primary
    # OPeNDAP URL only (not fallback). If the primary fails, we retry
    # with the fallback URL for just the unsatisfied jobs from that file.
    # This halves the unique URL count vs. pre-registering both URLs.
    from collections import defaultdict, OrderedDict

    all_jobs = {}       # (sid, fidx) -> job dict
    url_to_jobs = defaultdict(list)  # url -> [(sid, fidx), ...]
    job_fallback = {}   # (sid, fidx) -> fallback_url
    urls_ordered = OrderedDict()

    skipped = 0
    for storm, frames in storm_frames:
        sid = storm["sid"]
        for fidx, frame in enumerate(frames):
            # Check if already cached (resume mode)
            if args.resume:
                already_exists = False
                if local_dir:
                    local_path = os.path.join(local_dir, sid, f"{fidx}.npz")
                    if os.path.exists(local_path):
                        already_exists = True
                if not already_exists and bucket:
                    try:
                        if _gcs_frame_exists(bucket, sid, fidx):
                            already_exists = True
                    except Exception:
                        pass
                if already_exists:
                    skipped += 1
                    continue

            target_dt = datetime.fromisoformat(frame["datetime"])
            job = {
                "sid": sid,
                "fidx": fidx,
                "datetime": frame["datetime"],
                "target_dt": target_dt,
                "lat": frame["lat"],
                "lon": frame["lon"],
            }
            all_jobs[(sid, fidx)] = job

            # Map to PRIMARY URL only; store fallback for retry
            candidates = _get_candidate_urls(target_dt)
            primary_url = candidates[0]
            url_to_jobs[primary_url].append((sid, fidx))
            urls_ordered[primary_url] = None
            if len(candidates) > 1:
                job_fallback[(sid, fidx)] = candidates[1]

    n_jobs = len(all_jobs)
    n_urls = len(urls_ordered)
    url_list = sorted(urls_ordered.keys(), reverse=True)  # newest files first

    log.info(f"Jobs to process: {n_jobs} (skipped {skipped} already cached)")
    log.info(f"Unique MergIR files to fetch: {n_urls} (primary only — fallback on failure)")

    if n_jobs == 0:
        log.info("Nothing to do!")
        return

    # ── Helper: save one frame immediately ──
    def _save_frame(sid, fidx, tb, bounds, frame_dt_str):
        """Save a single frame to local disk and/or GCS. Returns True on success."""
        ok = True
        if local_dir:
            try:
                storm_dir = os.path.join(local_dir, sid)
                os.makedirs(storm_dir, exist_ok=True)
                local_path = os.path.join(storm_dir, f"{fidx}.npz")
                np.savez_compressed(
                    local_path,
                    tb=tb.astype(np.float32),
                    bounds=np.array([
                        bounds["south"], bounds["north"],
                        bounds["west"], bounds["east"],
                    ]),
                    meta=np.array([frame_dt_str], dtype="U"),
                )
            except Exception as e:
                log.error(f"Local save failed for {sid}/{fidx}: {e}")
                ok = False

        if bucket:
            tb_encoded = encode_tb_uint8(tb)
            result = {
                "sid": sid,
                "frame_idx": fidx,
                "datetime": frame_dt_str,
                "source": "mergir",
                "bounds": bounds,
                **tb_encoded,
            }
            try:
                _gcs_put_frame(bucket, sid, fidx, result)
            except Exception as e:
                log.error(f"GCS upload failed for {sid}/{fidx}: {e}")
                ok = False

        return ok

    # ── Helper: process one URL fetch (extract + save frames) ──
    def _process_url(url, pending_jobs):
        """
        Fetch one OPeNDAP URL, extract & save all pending frames from it.
        Returns (n_saved, n_extract_fail, unsatisfied_keys).
        """
        # Compute bounding box covering all pending jobs
        job_lats = [all_jobs[k]["lat"] for k in pending_jobs]
        job_lons = [all_jobs[k]["lon"] for k in pending_jobs]
        margin = MERGIR_HALF_DOMAIN + 1.0
        lat_bounds = (min(job_lats) - margin, max(job_lats) + margin)
        lon_bounds = (min(job_lons) - margin, max(job_lons) + margin)

        time.sleep(args.rate)
        file_data = fetch_mergir_file(url, lat_bounds=lat_bounds, lon_bounds=lon_bounds)
        if file_data is None:
            return 0, 0, list(pending_jobs)

        ir_times, all_lats, all_lons, tb_data = file_data
        saved = 0
        extract_fail = 0
        unsatisfied = []

        for key in pending_jobs:
            job = all_jobs[key]
            tb, bounds = extract_frame_from_file(
                ir_times, all_lats, all_lons, tb_data,
                job["target_dt"], job["lat"], job["lon"],
            )
            if tb is not None:
                if _save_frame(job["sid"], job["fidx"], tb, bounds, job["datetime"]):
                    saved += 1
                else:
                    extract_fail += 1
                del tb  # free immediately
            else:
                unsatisfied.append(key)

        del ir_times, all_lats, all_lons, tb_data, file_data
        return saved, extract_fail, unsatisfied

    # ── Fetch each primary URL, then retry failures with fallback ──
    completed = set()   # (sid, fidx) keys — just for tracking, no data held
    n_fetched = 0
    n_fetch_fail = 0
    n_saved = 0
    n_save_fail = 0
    fallback_queue = defaultdict(list)  # fallback_url -> [(sid, fidx), ...]
    start_time = time.time()

    for ui, url in enumerate(url_list):
        short_name = url.rsplit("/", 1)[-1] if "/" in url else url

        # Skip if all jobs for this URL are already satisfied
        pending = [(s, f) for s, f in url_to_jobs.get(url, [])
                   if (s, f) not in completed and (s, f) in all_jobs]
        if not pending:
            continue

        t0 = time.time()
        saved, fails, unsatisfied = _process_url(url, pending)
        dt_fetch = time.time() - t0

        if saved == 0 and fails == 0 and len(unsatisfied) == len(pending):
            # Total fetch failure — queue ALL for fallback
            n_fetch_fail += 1
            for key in unsatisfied:
                fb = job_fallback.get(key)
                if fb:
                    fallback_queue[fb].append(key)
            tag = f"FAIL ({dt_fetch:.1f}s) → {len(unsatisfied)} queued for fallback"
        else:
            n_fetched += 1
            n_saved += saved
            n_save_fail += fails
            for key in pending:
                if key not in unsatisfied:
                    completed.add(key)
            # Queue extraction failures for fallback too
            for key in unsatisfied:
                fb = job_fallback.get(key)
                if fb:
                    fallback_queue[fb].append(key)
            tag = f"OK ({dt_fetch:.1f}s, {saved} saved, {len(unsatisfied)} unsatisfied)"

        if (ui + 1) % 25 == 0 or ui == 0 or ui == len(url_list) - 1:
            elapsed = time.time() - start_time
            rate_f = (n_fetched + n_fetch_fail) / elapsed if elapsed > 0 else 0
            eta = (n_urls - ui - 1) / rate_f / 60 if rate_f > 0 else 0
            pct = 100 * len(completed) / max(n_jobs, 1)
            log.info(
                f"  [{ui+1}/{n_urls}] {short_name}  {tag}"
                f"  |  {elapsed:.0f}s, {rate_f:.2f} file/s, ETA {eta:.0f}m"
                f"  [frames: {len(completed)}/{n_jobs} ({pct:.0f}%)]"
            )

        # Periodic GC
        if (ui + 1) % 100 == 0:
            gc.collect()

    # ── Fallback pass: retry unsatisfied frames with alternate URLs ──
    if fallback_queue:
        n_fb_urls = len(fallback_queue)
        n_fb_jobs = sum(len(v) for v in fallback_queue.values())
        log.info(f"\nFallback pass: {n_fb_jobs} frames across {n_fb_urls} alternate URLs")

        for fi, (fb_url, fb_keys) in enumerate(sorted(fallback_queue.items())):
            # Filter out any that got satisfied by another URL in the meantime
            still_pending = [k for k in fb_keys if k not in completed]
            if not still_pending:
                continue

            short_name = fb_url.rsplit("/", 1)[-1] if "/" in fb_url else fb_url
            t0 = time.time()
            saved, fails, _ = _process_url(fb_url, still_pending)
            dt_fetch = time.time() - t0

            if saved > 0:
                n_fetched += 1
                n_saved += saved
                n_save_fail += fails
                for key in still_pending:
                    if key not in completed:
                        completed.add(key)  # approximate — some may have failed
            else:
                n_fetch_fail += 1

            if (fi + 1) % 25 == 0 or fi == 0 or fi == n_fb_urls - 1:
                log.info(f"  [FB {fi+1}/{n_fb_urls}] {short_name}  saved={saved} ({dt_fetch:.1f}s)")

    fetch_elapsed = time.time() - start_time

    # ── Final summary ──
    unsatisfied = n_jobs - len(completed)
    log.info(
        f"\n{'='*60}\n"
        f"COMPLETE: {args.basin} {args.start_year}-{args.end_year}\n"
        f"  Storms:         {len(storm_frames)}\n"
        f"  Total frames:   {total_frames}\n"
        f"  Skipped:        {skipped} (already cached)\n"
        f"  Files fetched:  {n_fetched} OK, {n_fetch_fail} failed\n"
        f"  Frames saved:   {n_saved}\n"
        f"  Frames failed:  {n_save_fail} (save errors) + {unsatisfied} (no data)\n"
        f"  Total time:     {fetch_elapsed/60:.1f} min ({fetch_elapsed/3600:.1f} hours)\n"
        f"{'='*60}"
    )


if __name__ == "__main__":
    main()
