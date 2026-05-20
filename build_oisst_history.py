"""One-time backfill for the RT Monitor Seasonal tab.

Produces the small derived blobs that the daily Cloud Run Job
(`build_seasonal_diagnostics.py`, separate file) will append to:

    1. oisst_doyclim_1991_2020.nc   day-of-year mean + std of SST
    2. indices_daily.parquet        daily region-mean SST anomalies, 1982-present
    3. ace_annual.json              annual ACE for the North Atlantic, 1982-present

No raw OISST NetCDF is mirrored to GCS — we pull subsets via PSL OPeNDAP each
time, compute small products in memory, and upload only those. Source of
truth stays at PSL.

Each step is idempotent and can be run alone:

    python build_oisst_history.py --step climatology
    python build_oisst_history.py --step indices
    python build_oisst_history.py --step ace
    python build_oisst_history.py --step upload
    python build_oisst_history.py --step all

Local outputs default to data/seasonal/; pass --upload-only after a local
run to push to gs://${GCS_IR_CACHE_BUCKET}/seasonal/.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("build_oisst_history")


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

# NOAA OISST v2.1 high-resolution (0.25°) daily SST.
#
# Source priority:
#   1. NCEI per-day HTTPS — small (~1.7 MB/file), reliable, parallelizable.
#      Per-year backfill = 365 concurrent fetches → ~30 s/year wall time.
#   2. PSL per-year HTTPS (kept as fallback) — ~480 MB/year. Some networks
#      cap connection size at ~10-25 MB; in that case PSL is unusable and
#      NCEI is the only option.
#
# We assemble the NCEI per-day files into a per-year NetCDF in the same
# (time, lat, lon) layout the rest of the pipeline expects, so callers see
# one file per year regardless of which source it came from.
# AWS Open-Data S3 mirror of NCEI per-day OISST. Anonymous read, no
# concurrency throttle (verified: ~13× faster than NCEI HTTPS for the
# same 8-way concurrent workload on the dev network).
OISST_S3_DAY_TMPL = (
    "https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3."
    "amazonaws.com/data/v2.1/avhrr/{yyyymm}/oisst-avhrr-v02r01.{yyyymmdd}.nc"
)
# NCEI per-day HTTPS — used only as a last-resort per-file fallback if
# the S3 mirror is missing a date or unreachable. Throttles concurrent
# requests on some networks (~11 s per file at 8-way concurrency), so
# do NOT use as primary.
OISST_NCEI_DAY_TMPL = (
    "https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-"
    "interpolation/v2.1/access/avhrr/{yyyymm}/oisst-avhrr-v02r01.{yyyymmdd}.nc"
)
OISST_DOWNLOAD_TMPL = (
    "https://psl.noaa.gov/thredds/fileServer/Datasets/noaa.oisst.v2.highres/"
    "sst.day.mean.{year}.nc"
)
OISST_OPENDAP_TMPL = OISST_DOWNLOAD_TMPL   # kept for back-compat with importers
# Number of concurrent per-day fetches against NCEI. 8 is comfortably below
# any rate limit and saturates a typical home connection on the small-file
# workload.
OISST_NCEI_CONCURRENCY = int(os.environ.get("OISST_NCEI_CONCURRENCY", "8"))

# Local cache for the downloaded per-year files. Deleted after processing
# unless --keep-cache is set. Re-uses /Users/mfischer/Data/ACE/ if files
# are already present there (matches the existing workflow in ACE repo).
OISST_LOCAL_CACHE = Path(os.environ.get(
    "OISST_LOCAL_CACHE", "/Users/mfischer/Data/OISST_daily"))

# Global SST subset spanning ±60°N (covers all 7 TC basins incl. SH).
# Lat range chosen so Southern Hemisphere TC corridors (10-30°S Atlantic
# coast, SI 5-25°S, SP 5-25°S) are fully visible on Panel D correlation
# maps. OISST is 0.25° so the global grid is 1440x720 — our subset is
# ~480x1040, roughly 49% of the full globe.
LAT_MIN, LAT_MAX = -60.0, 60.0
LON_MIN, LON_MAX = 100.0, 360.0   # OISST is 0-360E

# Climatology reference period. 1991-2020 matches WMO standard normals and
# is what the subseasonal overlay job uses (consistent across the site).
CLIMO_START_YEAR = 1991
CLIMO_END_YEAR = 2020

# Indices history starts at 1982 (OISST v2.1 begins Sep 1981, full year 1982).
INDICES_START_YEAR = 1982

# Monthly OISST v2.1 mean at 0.25°. Single file, ~2 GB, covers 1981-09 to
# current. The full historical climatology + monthly indices are computed
# from this file — daily PSL fetches are reserved for the live tab. The
# file is updated by NOAA roughly mid-month for the prior month.
OISST_MONTHLY_LOCAL_DEFAULT = "/Users/mfischer/Data/ACE/sst.mon.mean_may_2026.nc"
OISST_MONTHLY_URL = (
    "https://psl.noaa.gov/thredds/fileServer/Datasets/noaa.oisst.v2.highres/"
    "sst.mon.mean.nc"
)

# Region boxes for the index time series. All in (lat_s, lat_n, lon_w, lon_e)
# with lon in [0, 360). Definitions follow the conventional choices used in
# the seasonal-forecast and ENSO literature so values are directly
# comparable with CPC / Klotzbach / SHIPS-style indices.
REGIONS = {
    # Atlantic basin-scale + sub-regions
    "atl_basin":   (5.0,  30.0,  280.0, 350.0),   # whole tropical Atlantic
    "atl_mdr":     (10.0, 20.0,  275.0, 340.0),   # Main Development Region 10-20°N, 20-85°W
    "atl_mdr_east": (10.0, 20.0, 320.0, 340.0),   # Eastern MDR 10-20°N, 20-40°W
    "atl_amo":     (10.0, 50.0,  330.0, 340.0),   # AMO box 10-50°N, 20-30°W (Goldenberg-style)
    "caribbean":   (10.0, 22.0,  275.0, 300.0),   # 10-22°N, 85-60°W
    "gulf":        (20.0, 30.0,  262.0, 282.0),   # 20-30°N, 98-78°W
    "nta":         (5.0,  25.0,  305.0, 345.0),   # North Tropical Atlantic
    "tsa":         (-20.0, 0.0,  330.0, 350.0),   # Tropical South Atlantic 20°S-0, 30-10°W

    # Pacific MDRs
    "epac_mdr":    (10.0, 20.0,  230.0, 270.0),   # East Pacific MDR 10-20°N, 90-130°W
    "wpac_mdr":    (5.0,  20.0,  130.0, 170.0),   # West Pacific MDR 5-20°N, 130-170°E

    # ENSO Niño regions (CPC definitions)
    "nino12":      (-10.0, 0.0,  270.0, 280.0),   # Niño 1+2: 10°S-0, 90-80°W
    "nino3":       (-5.0,  5.0,  210.0, 270.0),   # Niño 3: 5°S-5°N, 150-90°W
    "nino34":      (-5.0,  5.0,  190.0, 240.0),   # Niño 3.4: 5°S-5°N, 170-120°W
    "nino4":       (-5.0,  5.0,  160.0, 210.0),   # Niño 4: 5°S-5°N, 160°E-150°W
}

# Backward-compatibility aliases for the prior naming (basin/mdr/amo_box).
# Old indices_monthly parquets and frontend code may still reference these;
# downstream consumers should switch to the canonical keys above.
REGION_ALIASES = {
    "basin":   "atl_basin",
    "mdr":     "atl_mdr",
    "amo_box": "atl_amo",
}

# Basins for which we compute annual ACE and pixel-wise SST correlations.
# Codes match IBTrACS.ALL `basin` variable.
ACE_BASINS = {
    "NA": "North Atlantic",
    "EP": "East Pacific",
    "WP": "West Pacific",
    "NI": "North Indian",
    "SI": "South Indian",
    "SP": "South Pacific",
}

# IBTrACS.ALL — global basins, for per-basin ACE used in correlation maps.
# (NA-only file at IBTRACS_LOCAL_DEFAULT is still used for the headline
# Atlantic ACE history JSON.)
IBTRACS_ALL_LOCAL = "/Users/mfischer/github/TC-ATLAS/data/_ibtracs_cache/IBTrACS.ALL.v04r01.nc"

# IBTrACS North Atlantic v04r01 (current release; supersedes v04r00).
# NCEI updates this quarterly. The .NA file covers 1851–current and includes
# in-progress seasons with track_type='PROVISIONAL'.
IBTRACS_URL = "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/netcdf/IBTrACS.NA.v04r01.nc"
IBTRACS_LOCAL_DEFAULT = "/Users/mfischer/Data/IBTRACS/IBTrACS.NA.v04r01.nc"

# ACE accumulation threshold (kt). Standard NHC definition.
ACE_VMAX_THRESH = 35.0

# GCS upload — re-uses the same bucket convention as build_subseasonal_overlays.
GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
GCS_PREFIX = "seasonal"


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _oisst_fetch_one_day(date_str: str, dest: Path,
                         max_attempts: int = 4) -> bool:
    """Pull one day's OISST NetCDF to `dest`. Returns True on success.

    Source order: S3 final → S3 preliminary → NCEI final → NCEI prelim.
    OISST has a ~14-day finalization lag; the `_preliminary.nc` variant
    sits in the public mirrors during that window, so consult it before
    giving up. Per-day files are ~1.7 MB so a single GET completes in
    one shot; we retry transient errors but not 404s (404 on the final
    is the normal signal to drop to preliminary).
    """
    import requests
    if dest.exists() and dest.stat().st_size > 100_000:
        return True
    yyyymm = date_str[:6]
    # Ordered fallbacks. (label, url) pairs.
    sources = [
        ("S3 final",      OISST_S3_DAY_TMPL.format(yyyymm=yyyymm, yyyymmdd=date_str)),
        ("S3 prelim",     OISST_S3_DAY_TMPL.format(yyyymm=yyyymm, yyyymmdd=date_str)
                              .replace(".nc", "_preliminary.nc")),
        ("NCEI final",    OISST_NCEI_DAY_TMPL.format(yyyymm=yyyymm, yyyymmdd=date_str)),
        ("NCEI prelim",   OISST_NCEI_DAY_TMPL.format(yyyymm=yyyymm, yyyymmdd=date_str)
                              .replace(".nc", "_preliminary.nc")),
    ]
    for label, url in sources:
        for attempt in range(1, max_attempts + 1):
            try:
                r = requests.get(url, timeout=(15, 60))
                if r.status_code == 404:
                    # Don't keep retrying a 404 — fall through to next
                    # source. Transient errors (5xx, timeouts) still retry.
                    break
                r.raise_for_status()
                tmp = dest.with_suffix(dest.suffix + ".tmp")
                with open(tmp, "wb") as fout:
                    fout.write(r.content)
                tmp.replace(dest)
                return True
            except Exception as e:
                if attempt == max_attempts:
                    log.warning("    %s %s failed after %d attempts: %s",
                                label, date_str, max_attempts, e)
                    break
                time.sleep(0.5 * attempt)
    return False


def _download_oisst_year_via_ncei(year: int) -> Path:
    """Build a per-year NetCDF for `year` by fetching the 365/366 per-day
    files (S3 mirror primary, NCEI fallback) in parallel and concatenating
    along the time axis. Output matches the PSL per-year layout (variable
    `sst`, dims time × lat × lon) so downstream callers see a uniform shape.
    """
    import pandas as pd
    from concurrent.futures import ThreadPoolExecutor, as_completed

    OISST_LOCAL_CACHE.mkdir(parents=True, exist_ok=True)
    local = OISST_LOCAL_CACHE / f"sst.day.mean.{year}.nc"
    # Per-day staging dir — kept across runs so partial-year retries are
    # cheap. Cleaned up after the per-year assembly succeeds.
    stage_dir = OISST_LOCAL_CACHE / f"_ncei_stage_{year}"
    stage_dir.mkdir(parents=True, exist_ok=True)

    # Build the list of days to fetch. For the current year, only days up
    # to (today − 2) — the OISST mirror publishes after a 1-2 day lag.
    today = datetime.now(timezone.utc).date()
    end = pd.Timestamp(year, 12, 31)
    if year == today.year:
        end = min(end, pd.Timestamp(today) - pd.Timedelta(days=2))
    start = pd.Timestamp(year, 1, 1)
    days = pd.date_range(start, end, freq="D")
    log.info("  S3+NCEI fetch %d: %d daily files (concurrency=%d)",
             year, len(days), OISST_NCEI_CONCURRENCY)

    targets = []
    for d in days:
        ds_str = d.strftime("%Y%m%d")
        targets.append((ds_str, stage_dir / f"oisst-{ds_str}.nc"))

    n_ok, n_fail = 0, 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=OISST_NCEI_CONCURRENCY) as ex:
        futures = {ex.submit(_oisst_fetch_one_day, ds, dest): ds
                   for ds, dest in targets}
        for fut in as_completed(futures):
            ok = fut.result()
            if ok:
                n_ok += 1
            else:
                n_fail += 1
            if (n_ok + n_fail) % 50 == 0:
                log.info("    %d: %d/%d (%.1f s elapsed)",
                         year, n_ok + n_fail, len(targets),
                         time.time() - t0)
    log.info("  %d: %d ok, %d failed in %.1f s",
             year, n_ok, n_fail, time.time() - t0)
    if n_ok == 0:
        raise IOError(f"S3+NCEI fetched 0 days for {year}")

    # Open all the per-day files, concat on time, write a single per-year
    # NetCDF in the (time, lat, lon) layout the rest of the code expects.
    paths = sorted(p for _, p in targets if p.exists() and p.stat().st_size > 100_000)
    log.info("  assembling %d per-day files into %s", len(paths), local.name)
    arrays = []
    for p in paths:
        with xr.open_dataset(p) as ds:
            # Drop singleton zlev only — KEEP time as a coord so the
            # concat preserves real timestamps (squeezing time also
            # drops the coord, leaving 0..N-1 integer indices and a
            # downstream parsing crash). Mirrors what
            # `_open_monthly_oisst` does to keep `time` intact.
            da = ds["sst"].squeeze("zlev", drop=True)
            arrays.append(da.load())
    combined = xr.concat(arrays, dim="time")
    out = xr.Dataset({"sst": combined})
    tmp = local.with_suffix(local.suffix + ".tmp")
    out.to_netcdf(tmp)
    tmp.replace(local)
    log.info("  cached %.1f MB at %s", local.stat().st_size / 1e6, local)
    # Clean staging dir on success.
    shutil.rmtree(stage_dir, ignore_errors=True)
    return local


def _download_oisst_year(year: int,
                         max_attempts: int = 40,
                         base_backoff_s: float = 2.0) -> Path:
    """Mirror sst.day.mean.{year}.nc to the local cache.

    Tries NCEI per-day fetches first (small, parallelizable, ~30 s/year).
    Falls back to PSL per-year HTTPS with Range-request resume only if
    NCEI is unavailable — PSL's 480 MB transfers are unreliable on some
    networks (consistent ~10-25 MB connection cap).

    Idempotent: if the file already exists and is plausibly complete
    (size > 1 MB), returns the cached path unchanged. The current-year
    file grows daily, so we refresh it if older than 18 hours.
    """
    OISST_LOCAL_CACHE.mkdir(parents=True, exist_ok=True)
    local = OISST_LOCAL_CACHE / f"sst.day.mean.{year}.nc"
    now = time.time()
    if local.exists() and local.stat().st_size > 1_000_000:
        age_hrs = (now - local.stat().st_mtime) / 3600.0
        if year < datetime.now(timezone.utc).year or age_hrs < 18:
            return local
        log.info("  %s is %.1f h old; refreshing", local.name, age_hrs)

    # Primary path: NCEI per-day, concurrent.
    try:
        return _download_oisst_year_via_ncei(year)
    except Exception as e:
        log.warning("  NCEI fetch for %d failed (%s); falling back to PSL",
                    year, e)

    # Fallback path: PSL per-year with Range-resume.
    url = OISST_DOWNLOAD_TMPL.format(year=year)
    tmp = local.with_suffix(local.suffix + ".tmp")
    import requests
    import random

    # Learn the expected file size via HEAD. Some servers don't expose
    # this on HEAD (return 0); if so, we fall back to letting the GET
    # report it on the first successful Range response.
    try:
        h = requests.head(url, timeout=30, allow_redirects=True)
        h.raise_for_status()
        expected = int(h.headers.get("Content-Length", "0"))
    except Exception as e:
        log.warning("  HEAD for %s failed (%s); will infer size from GET", url, e)
        expected = 0

    log.info("  downloading %s (expected %.1f MB)",
             url, expected / 1e6 if expected else 0)
    attempt = 0
    last_progress_log = 0
    while True:
        attempt += 1
        if attempt > max_attempts:
            raise IOError(
                f"giving up on {year} after {max_attempts} attempts; "
                f"tmp has {tmp.stat().st_size if tmp.exists() else 0} bytes"
            )
        have = tmp.stat().st_size if tmp.exists() else 0
        if expected and have >= expected:
            break
        headers = {"Range": f"bytes={have}-"} if have > 0 else {}
        try:
            with requests.get(url, stream=True,
                              timeout=(30, 120),
                              headers=headers) as r:
                # 206 = partial content (Range succeeded); 200 = full body
                # (server ignored Range — start over).
                if have > 0 and r.status_code == 200:
                    log.warning("  server ignored Range; restarting from 0")
                    tmp.unlink(missing_ok=True)
                    have = 0
                elif r.status_code not in (200, 206):
                    r.raise_for_status()
                if not expected:
                    # First successful response — capture full size from
                    # Content-Range (206) or Content-Length (200).
                    cr = r.headers.get("Content-Range", "")
                    if cr and "/" in cr:
                        expected = int(cr.split("/")[-1])
                    else:
                        expected = int(r.headers.get("Content-Length", "0"))
                with open(tmp, "ab" if have > 0 else "wb") as fout:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        if chunk:
                            fout.write(chunk)
                            have += len(chunk)
                            # Throttle progress logs to every ~50 MB.
                            if have - last_progress_log >= 50 * (1 << 20):
                                log.info("    %d: %.1f / %.1f MB",
                                         year, have / 1e6, expected / 1e6)
                                last_progress_log = have
            # Loop top will re-check have vs expected.
        except (requests.exceptions.RequestException, IOError) as e:
            # Sleep with jitter, then retry from the new offset.
            wait = base_backoff_s * (1.5 ** min(attempt - 1, 8))
            wait += random.uniform(0, 0.5)
            have_now = tmp.stat().st_size if tmp.exists() else 0
            log.warning(
                "  %d attempt %d: %s; have %.1f MB, retrying in %.1f s",
                year, attempt, e, have_now / 1e6, wait,
            )
            time.sleep(wait)

    # Sanity-check final size.
    final = tmp.stat().st_size
    if expected and final != expected:
        raise IOError(
            f"size mismatch for {year}: got {final}, expected {expected}"
        )
    tmp.replace(local)
    log.info("  cached %.1f MB at %s", local.stat().st_size / 1e6, local)
    return local


def _open_oisst_year(year: int) -> xr.DataArray:
    """Return a fully-in-memory DataArray of daily SST for `year`, subset to
    the Atlantic+tropics box. Downloads the per-year file from PSL on first
    use, caches locally, masks out non-physical fill values.
    """
    local = _download_oisst_year(year)
    with xr.open_dataset(local) as ds:
        sub = ds.sel(lat=slice(LAT_MIN, LAT_MAX), lon=slice(LON_MIN, LON_MAX))
        sst_vals = np.ascontiguousarray(sub["sst"].values)
        time_vals = sub["time"].values.copy()
        lat_vals = sub["lat"].values.copy()
        lon_vals = sub["lon"].values.copy()
    sst_vals[np.abs(sst_vals) > 50.0] = np.nan
    return xr.DataArray(
        sst_vals, dims=("time", "lat", "lon"),
        coords={"time": time_vals, "lat": lat_vals, "lon": lon_vals},
        name="sst",
    )


def _area_weights(lat: np.ndarray) -> np.ndarray:
    """cos(lat) area weights for spatial means."""
    return np.cos(np.deg2rad(lat))


def _region_mean(da: xr.DataArray, box: tuple) -> xr.DataArray:
    """Area-weighted spatial mean of `da` over (lat_s, lat_n, lon_w, lon_e)."""
    lat_s, lat_n, lon_w, lon_e = box
    sub = da.sel(lat=slice(lat_s, lat_n), lon=slice(lon_w, lon_e))
    w = xr.DataArray(_area_weights(sub.lat.values), dims=["lat"], coords={"lat": sub.lat})
    return sub.weighted(w).mean(dim=["lat", "lon"])


# --------------------------------------------------------------------------
# Monthly source helpers (used by both climatology + indices steps)
# --------------------------------------------------------------------------

def _open_monthly_oisst(local_path: str | None = None) -> xr.DataArray:
    """Return the OISST v2.1 monthly mean SST as a clean in-memory DataArray,
    subset to the Atlantic+tropics box. Reads from a local NetCDF (the file
    is large — ~2 GB at 0.25° — so we never re-download it here)."""
    path = Path(local_path or OISST_MONTHLY_LOCAL_DEFAULT)
    if not path.exists():
        raise FileNotFoundError(
            f"Monthly OISST file not found at {path}. "
            f"Download from {OISST_MONTHLY_URL} once, then retry."
        )
    log.info("  opening %s (%.1f GB)", path, path.stat().st_size / 1e9)
    with xr.open_dataset(path) as ds:
        sub = ds.sel(lat=slice(LAT_MIN, LAT_MAX), lon=slice(LON_MIN, LON_MAX))
        sst_vals = np.ascontiguousarray(sub["sst"].values)
        time_vals = sub["time"].values.copy()
        lat_vals = sub["lat"].values.copy()
        lon_vals = sub["lon"].values.copy()
    sst_vals[np.abs(sst_vals) > 50.0] = np.nan
    return xr.DataArray(
        sst_vals, dims=("time", "lat", "lon"),
        coords={"time": time_vals, "lat": lat_vals, "lon": lon_vals},
        name="sst",
    )


# --------------------------------------------------------------------------
# Helper: tropical-mean SST (for the "relative SST" detrending mode)
# --------------------------------------------------------------------------

# Vecchi & Soden (2007) tropical band. 30°S–30°N is the published choice;
# Camargo and some genesis-index work use 20°S–20°N. Documented in the
# Panel A/B/D/E tooltips so the audience knows which we picked.
TROPICAL_MEAN_LAT_MIN = -30.0
TROPICAL_MEAN_LAT_MAX = 30.0


def _tropical_mean_sst(sst_da: xr.DataArray) -> np.ndarray:
    """Area-weighted mean SST over TROPICAL_MEAN_LAT_MIN..MAX × LON_MIN..MAX
    at each time step in `sst_da` (dims time × lat × lon). Returns a 1D
    array shaped (n_time,)."""
    sub = sst_da.sel(lat=slice(TROPICAL_MEAN_LAT_MIN, TROPICAL_MEAN_LAT_MAX))
    w = np.cos(np.deg2rad(sub.lat.values))
    # NaN-safe area-weighted mean across (lat, lon) at each time.
    vals = sub.values   # (time, lat, lon)
    finite = np.isfinite(vals)
    w2 = w[None, :, None] * np.ones_like(vals)
    w2 = np.where(finite, w2, 0)
    vals0 = np.where(finite, vals, 0)
    num = (vals0 * w2).sum(axis=(1, 2))
    den = w2.sum(axis=(1, 2))
    return np.where(den > 0, num / den, np.nan)


# --------------------------------------------------------------------------
# Step 1: Month-of-year climatology (from monthly file)
# --------------------------------------------------------------------------

def build_climatology(out_path: Path, monthly_path: str | None = None) -> Path:
    """Compute 1991–2020 month-of-year mean + std of SST. Writes a NetCDF.

    Output dims: (month=12, lat, lon). ~30 MB at 0.25° on the subset box.
    The daily live tab interpolates between adjacent months for finer
    visual transition — a simple linear-in-time interpolation is fine at
    seasonal scales.
    """
    log.info("Building OISST month-of-year climatology %d-%d ...",
             CLIMO_START_YEAR, CLIMO_END_YEAR)
    full = _open_monthly_oisst(monthly_path)
    full = full.sel(time=slice(f"{CLIMO_START_YEAR}-01-01",
                               f"{CLIMO_END_YEAR}-12-31"))
    log.info("  selected %d months (%s .. %s)",
             full.sizes["time"],
             str(full.time.values[0])[:7], str(full.time.values[-1])[:7])
    grouped = full.groupby("time.month")
    mon_mean = grouped.mean(dim="time").rename("sst_clim_mean")
    mon_std = grouped.std(dim="time").rename("sst_clim_std")
    out = xr.merge([mon_mean, mon_std])
    out.attrs["title"] = "OISST v2.1 month-of-year climatology (mean + std)"
    out.attrs["reference_period"] = f"{CLIMO_START_YEAR}-{CLIMO_END_YEAR}"
    out.attrs["region"] = (
        f"lat {LAT_MIN}..{LAT_MAX}, lon {LON_MIN}..{LON_MAX} (0-360E)"
    )
    out.attrs["source"] = OISST_MONTHLY_URL
    out.attrs["generated_utc"] = datetime.now(timezone.utc).isoformat()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    enc = {v: {"zlib": True, "complevel": 4} for v in ("sst_clim_mean", "sst_clim_std")}
    out.to_netcdf(out_path, encoding=enc)
    log.info("  wrote %s (%.1f MB)", out_path, out_path.stat().st_size / 1e6)
    return out_path


# --------------------------------------------------------------------------
# Step 2: Monthly region indices (full history)
# --------------------------------------------------------------------------

def _interp_daily_clim(climo_mean: xr.DataArray, year: int, month: int,
                       day: int) -> np.ndarray:
    """Linearly interpolate the 12-month climatology to a specific calendar
    day. Treats each month's value as anchored at the 15th and advances
    fractionally toward the adjacent month's 15th."""
    import pandas as pd
    d = pd.Timestamp(year, month, day)
    this_15 = pd.Timestamp(year, month, 15)
    if d >= this_15:
        m_lo, m_hi = month, (month % 12) + 1
        next_15 = (pd.Timestamp(year + 1, 1, 15) if month == 12
                   else pd.Timestamp(year, month + 1, 15))
        frac = (d - this_15).days / (next_15 - this_15).days
    else:
        m_hi = month
        m_lo = 12 if month == 1 else month - 1
        prev_15 = (pd.Timestamp(year - 1, 12, 15) if month == 1
                   else pd.Timestamp(year, month - 1, 15))
        frac = (d - prev_15).days / (this_15 - prev_15).days
    a = climo_mean.sel(month=m_lo).values
    b = climo_mean.sel(month=m_hi).values
    return a + (b - a) * frac


def _fetch_current_month_preliminary(climo_mean: xr.DataArray) -> dict | None:
    """Fetch all available days of the current calendar month from PSL daily
    OPeNDAP one timestep at a time and return a row containing TWO sets
    of region values:

      `{region}_sst` / `{region}_anom`
          Preliminary month-to-date (MTD): the mean of daily values
          observed so far this month. Anomaly uses a proper
          daily-climatology subtraction (sst_day - climo_day for each
          day, then averaged) so the within-month seasonal cycle is
          not mistaken for a real anomaly.

      `{region}_sst_projected` / `{region}_anom_projected`
          Extrapolated full-month value, assuming the days remaining in
          the month carry the same anomaly as the days observed so far:
          projected_full_sst = climo_full_month + mtd_anom.
          The corresponding anomaly equals mtd_anom by construction.

    Returns None if the open fails or no days have finite data yet.
    """
    today = datetime.now(timezone.utc).date()
    year, month = today.year, today.month
    url = ("https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres/"
           f"sst.day.mean.{year}.nc")
    try:
        ds = xr.open_dataset(url)
    except Exception as e:
        log.warning("  preliminary current-month fetch failed (open): %s", e)
        return None
    try:
        sub = ds.sel(lat=slice(LAT_MIN, LAT_MAX), lon=slice(LON_MIN, LON_MAX))
        all_times = sub["time"].values
        day_idx, day_nums = [], []
        for i, t in enumerate(all_times):
            ts = str(t)[:10]
            if ts.startswith(f"{year}-{month:02d}-"):
                day_idx.append(i)
                day_nums.append(int(ts[8:10]))
        if not day_idx:
            log.warning("  preliminary current-month: no days available yet")
            return None
        lat_vals = sub["lat"].values.copy()
        lon_vals = sub["lon"].values.copy()
        log.info("  fetching %d daily slabs one-at-a-time for %d-%02d ...",
                 len(day_idx), year, month)
        shape = (len(lat_vals), len(lon_vals))
        accum_sst = np.zeros(shape, dtype=np.float64)
        accum_anom = np.zeros(shape, dtype=np.float64)
        accum_n = np.zeros(shape, dtype=np.int32)
        for k, d in zip(day_idx, day_nums):
            slab = sub["sst"].isel(time=k).load()
            v = np.ascontiguousarray(slab.values)
            v[np.abs(v) > 50.0] = np.nan
            climo_day = _interp_daily_clim(climo_mean, year, month, d)
            anom = v - climo_day
            mask = np.isfinite(v)
            accum_sst[mask] += v[mask]
            accum_anom[mask] += anom[mask]
            accum_n[mask] += 1
    finally:
        ds.close()

    if accum_n.max() == 0:
        log.warning("  preliminary current-month: all days returned no data")
        return None
    with np.errstate(invalid="ignore", divide="ignore"):
        mtd_sst = np.where(accum_n > 0, accum_sst / accum_n, np.nan)
        mtd_anom = np.where(accum_n > 0, accum_anom / accum_n, np.nan)

    climo_full = climo_mean.sel(month=month).values
    # Projected full-month SST assumes the remaining days hold the same
    # anomaly as the days observed so far.
    projected_sst = climo_full + mtd_anom

    def _da(arr): return xr.DataArray(
        arr.astype(np.float32), dims=("lat", "lon"),
        coords={"lat": lat_vals, "lon": lon_vals}, name="sst")

    mtd_sst_da = _da(mtd_sst)
    mtd_anom_da = _da(mtd_anom)
    projected_sst_da = _da(projected_sst)
    # Tropical-mean SST for the preliminary period (Vecchi-Soden
    # relative-SST framework). Use the same MTD slab — area-weighted
    # mean over 30°S-30°N within the OISST subset.
    sub = mtd_sst_da.sel(lat=slice(TROPICAL_MEAN_LAT_MIN, TROPICAL_MEAN_LAT_MAX))
    w = np.cos(np.deg2rad(sub.lat.values))[:, None]
    finite = np.isfinite(sub.values)
    w2 = np.where(finite, w * np.ones_like(sub.values), 0)
    s2 = np.where(finite, sub.values, 0)
    trop_mean_mtd = float((s2 * w2).sum() / w2.sum()) if w2.sum() > 0 else float("nan")
    # Projected tropical-mean assumes persistence-anom: tropical-mean
    # anom = mtd tropical-mean anom; full-month projected ≈ same value.
    trop_mean_proj = trop_mean_mtd

    row = {"date": f"{year}-{month:02d}", "preliminary": True,
           "n_days": int(len(day_idx)), "as_of": today.isoformat()}
    for name, box in REGIONS.items():
        region_sst = float(_region_mean(mtd_sst_da, box).values)
        region_anom = float(_region_mean(mtd_anom_da, box).values)
        region_sst_proj = float(_region_mean(projected_sst_da, box).values)
        row[f"{name}_sst"]            = round(region_sst, 4)
        row[f"{name}_anom"]           = round(region_anom, 4)
        row[f"{name}_sst_projected"]  = round(region_sst_proj, 4)
        # Projected anom equals MTD anom by construction (persistence).
        row[f"{name}_anom_projected"] = row[f"{name}_anom"]
        # Relative SST + projected.
        row[f"{name}_sst_rel"]            = round(region_sst - trop_mean_mtd, 4)
        row[f"{name}_sst_rel_projected"]  = round(region_sst_proj - trop_mean_proj, 4)
    log.info("  %d-%02d preliminary (n=%d days): MDR mtd-anom=%+.2f → proj-sst=%.2f, AMO mtd-anom=%+.2f → proj-sst=%.2f, Niño3.4 mtd-anom=%+.2f → proj-sst=%.2f",
             year, month, row["n_days"],
             row["atl_mdr_anom"], row["atl_mdr_sst_projected"],
             row["atl_amo_anom"], row["atl_amo_sst_projected"],
             row["nino34_anom"], row["nino34_sst_projected"])
    return row


def build_indices(climo_path: Path, out_path: Path,
                  year_start: int = INDICES_START_YEAR,
                  year_end: int | None = None,
                  monthly_path: str | None = None,
                  with_preliminary: bool = True) -> Path:
    """Compute monthly region-mean SST and SST anomalies from the monthly
    OISST file. Writes a parquet keyed by (year, month).

    If `with_preliminary` is set and the current calendar month is not
    already in the file, also tries to fetch the partial-month daily
    average from PSL OPeNDAP and appends it as a row flagged
    `preliminary=True`. This keeps the scatter able to plot the current
    year/month before NOAA finalizes the monthly file.
    """
    log.info("Building monthly region indices %d-present ...", year_start)
    if not climo_path.exists():
        raise FileNotFoundError(
            f"Climatology not found at {climo_path}. Run --step monthly_climatology first."
        )
    clim_mean = xr.open_dataset(climo_path)["sst_clim_mean"]   # (month, lat, lon)

    sst = _open_monthly_oisst(monthly_path)
    sst = sst.sel(time=slice(f"{year_start}-01-01",
                             None if year_end is None else f"{year_end}-12-31"))
    log.info("  loaded %d monthly slabs (%s .. %s)",
             sst.sizes["time"],
             str(sst.time.values[0])[:7], str(sst.time.values[-1])[:7])

    # Anomalies: subtract climatology of the matching calendar month.
    months = sst["time"].dt.month
    clim_on_axis = clim_mean.sel(month=months)
    anom = sst - clim_on_axis

    # Relative SST (Vecchi & Soden 2007): region SST minus the
    # contemporaneous 30°S-30°N tropical-mean SST. By construction this
    # removes the global tropical warming signal, leaving only
    # differential warming (the dynamically meaningful part for TC
    # potential intensity work).
    trop_mean_per_time = _tropical_mean_sst(sst)            # (n_time,)
    # Climatological tropical-mean per calendar month.
    trop_mean_clim = _tropical_mean_sst(clim_mean.rename({"month": "time"}))
    log.info("  tropical-mean SST: monthly range %.2f..%.2f °C; clim min/max=%.2f/%.2f",
             float(np.nanmin(trop_mean_per_time)),
             float(np.nanmax(trop_mean_per_time)),
             float(np.nanmin(trop_mean_clim)),
             float(np.nanmax(trop_mean_clim)))

    rows = {"date": sst.time.values.astype("datetime64[M]").astype(str)}
    for name, box in REGIONS.items():
        log.info("  region %-10s box=%s", name, box)
        region_sst = _region_mean(sst,  box).values
        region_anom = _region_mean(anom, box).values
        rows[f"{name}_sst"]  = np.round(region_sst, 4)
        rows[f"{name}_anom"] = np.round(region_anom, 4)
        # Relative SST: subtract contemporaneous tropical-mean from
        # this region's monthly SST.
        rows[f"{name}_sst_rel"] = np.round(region_sst - trop_mean_per_time, 4)

    import pandas as pd
    df = pd.DataFrame(rows).sort_values("date").reset_index(drop=True)
    df["preliminary"] = False
    df["n_days"] = 0  # placeholder for finalized rows
    df["as_of"] = ""
    # Two-marker fields for the current-year preliminary point. Filled
    # with NaN on every finalized row; populated only for the preliminary
    # current-month row by `_fetch_current_month_preliminary`.
    for name in REGIONS:
        df[f"{name}_sst_projected"] = np.nan
        df[f"{name}_anom_projected"] = np.nan
    log.info("  built finalized indices table: %d rows × %d cols",
             len(df), len(df.columns))

    # Preliminary current-month row (if not already covered by the
    # monthly file and the daily fetch succeeds). Append BEFORE
    # detrending so the prelim row picks up a real `{region}_sst_dt`
    # value from the trend fit on finalized data.
    if with_preliminary:
        today = datetime.now(timezone.utc).date()
        cur_month = f"{today.year}-{today.month:02d}"
        if cur_month not in set(df["date"]):
            prelim = _fetch_current_month_preliminary(clim_mean)
            if prelim:
                prelim_df = pd.DataFrame([{**prelim}])
                # Any column missing from the prelim row stays NaN (so
                # downstream code can detect "not applicable" properly
                # instead of seeing a misleading 0).
                df = pd.concat([df, prelim_df], ignore_index=True)
                df = df.sort_values("date").reset_index(drop=True)
                log.info("  appended preliminary row for %s (n=%d days)",
                         prelim["date"], prelim["n_days"])

    # Detrended SST: per-(region, calendar-month) linear-in-year trend fit
    # across finalized rows only, subtracted off every row (finalized +
    # preliminary). Result is the year's deviation from the locally-fit
    # trend, stored as `{region}_sst_dt`. Done AFTER prelim append so the
    # prelim row also gets a detrended value.
    df["_year"] = pd.to_datetime(df["date"]).dt.year
    df["_month"] = pd.to_datetime(df["date"]).dt.month
    for name in REGIONS:
        col_sst = f"{name}_sst"
        col_dt = f"{name}_sst_dt"
        col_sst_p = f"{name}_sst_projected"
        col_dt_p = f"{name}_sst_dt_projected"
        df[col_dt] = np.nan
        df[col_dt_p] = np.nan
        for m in range(1, 13):
            mask = (df["_month"] == m) & (~df["preliminary"])
            if mask.sum() < 4:
                continue
            ys = df.loc[mask, "_year"].values.astype(np.float64)
            vs = df.loc[mask, col_sst].values.astype(np.float64)
            slope, intercept = np.polyfit(ys, vs, 1)
            full_mask = (df["_month"] == m)
            full_ys = df.loc[full_mask, "_year"].values.astype(np.float64)
            full_vs = df.loc[full_mask, col_sst].values.astype(np.float64)
            df.loc[full_mask, col_dt] = np.round(
                full_vs - (slope * full_ys + intercept), 4
            )
            # Apply the same trend to the projected full-month SST so
            # the preliminary row also gets a meaningful detrended-
            # projected value. Finalized rows have NaN here.
            if col_sst_p in df.columns:
                proj_vs = df.loc[full_mask, col_sst_p].values.astype(np.float64)
                df.loc[full_mask, col_dt_p] = np.round(
                    proj_vs - (slope * full_ys + intercept), 4
                )
    df = df.drop(columns=["_year", "_month"])

    # Frontend-friendly JSON sidecar — keeps the per-column lists plus
    # a top-level `preliminary` boolean list aligned with `dates` so the
    # scatter renderer can pick out partial-month points.
    json_path = out_path.with_suffix(".json")
    value_cols = [c for c in df.columns
                  if c not in ("date", "preliminary", "n_days", "as_of")]

    def _nan_to_none(s):
        """Convert pandas series → JSON-safe list with None for NaN."""
        return [None if pd.isna(v) else round(float(v), 3) for v in s]

    payload = {
        "regions": list(REGIONS.keys()),
        "dates": df["date"].tolist(),
        "values": {col: _nan_to_none(df[col]) for col in value_cols},
        "preliminary": df["preliminary"].astype(bool).tolist(),
        "preliminary_n_days": df["n_days"].astype(int).tolist(),
        "climatology_period": f"{CLIMO_START_YEAR}-{CLIMO_END_YEAR}",
        "generated_utc": datetime.now(timezone.utc).isoformat(),
    }
    json_path.write_text(json.dumps(payload, separators=(",", ":")))
    log.info("  wrote %s (%.2f MB)", json_path, json_path.stat().st_size / 1e6)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_path, compression="snappy", index=False)
    log.info("  wrote %s (%.2f MB)", out_path, out_path.stat().st_size / 1e6)
    return out_path


# --------------------------------------------------------------------------
# Step 3: Annual ACE history from IBTrACS
# --------------------------------------------------------------------------

def _ensure_ibtracs(local_path: str) -> str:
    """Mirror IBTrACS.NA from NCEI to `local_path` (atomic write)."""
    p = Path(local_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    log.info("  fetching IBTrACS NA from %s", IBTRACS_URL)
    with urllib.request.urlopen(IBTRACS_URL, timeout=120) as resp, open(tmp, "wb") as fout:
        shutil.copyfileobj(resp, fout)
    tmp.replace(p)
    log.info("  wrote %.1f MB to %s", p.stat().st_size / 1e6, p)
    return str(p)


def build_ace(out_path: Path, ibtracs_path: str | None = None,
              refresh: bool = False,
              max_age_days: int = 7) -> Path:
    """Compute annual basin ACE for the North Atlantic. Writes JSON.

    ACE = sum 10^-4 * v^2 over every 6-hourly TC point in the NA basin with
    wind >= 35 kt. Accepts both finalized ('main') and current-season
    ('PROVISIONAL') track types. Falls back to `usa_wind` when `wmo_wind` is
    NaN — NHC is the WMO RSMC for NA, so these agree on finalized data and
    `usa_wind` is the only signal available for in-progress seasons.

    Sub-sampled to 6-hourly synoptic times only (0/6/12/18 UTC) to avoid
    double-counting interpolated track points in IBTrACS.
    """
    if ibtracs_path is None:
        ibtracs_path = IBTRACS_LOCAL_DEFAULT
    p = Path(ibtracs_path)
    needs_refresh = refresh or not p.exists()
    if not needs_refresh and p.exists():
        age_days = (time.time() - p.stat().st_mtime) / 86400.0
        if age_days > max_age_days:
            log.info("  IBTrACS is %.1f days old (>%d); refreshing", age_days, max_age_days)
            needs_refresh = True
    if needs_refresh:
        ibtracs_path = _ensure_ibtracs(ibtracs_path)
    log.info("Computing annual ACE from %s ...", ibtracs_path)

    ds = xr.open_dataset(ibtracs_path)
    season = ds["season"].values
    wmo_wind = ds["wmo_wind"].values         # (storm, time)
    usa_wind = ds["usa_wind"].values if "usa_wind" in ds else np.full_like(wmo_wind, np.nan)
    basin = ds["basin"].values               # (storm, time) bytes
    track_type = ds["track_type"].values     # (storm,) bytes
    iso_time = ds["iso_time"].values         # (storm, time) bytes ISO timestamps

    def _b2s(x):
        return x.decode("utf-8") if isinstance(x, (bytes, bytearray)) else str(x)

    ACCEPTED_TRACK_TYPES = {"main", "PROVISIONAL"}
    # IBTrACS nature codes counted toward ACE: tropical (TS — covers TD/TS/HU
    # in the IBTrACS scheme) and subtropical (SS) with wind ≥ 35 kt. Excludes
    # disturbance (DS), extratropical (ET), not-rated (NR), mixed (MX).
    # Matches honest_ace_regression.py:190 in /Users/mfischer/github/ACE/.
    ACE_NATURES = {"TS", "SS"}
    nature = ds["nature"].values             # (storm, time) bytes

    n_storms, n_times = wmo_wind.shape
    years = sorted({int(y) for y in season if not np.isnan(y)})
    ace_per_year = {}

    for yr in years:
        if yr < INDICES_START_YEAR:
            continue
        cum = 0.0
        n_storms_yr = 0
        ix = np.where(season == yr)[0]
        for i in ix:
            tt = _b2s(track_type[i])
            if tt not in ACCEPTED_TRACK_TYPES:
                continue
            contributed = False
            for j in range(n_times):
                # 6-hourly synoptic times only — IBTrACS includes 3-hourly
                # interpolated points which would double-count.
                tstr = _b2s(iso_time[i, j])
                if len(tstr) < 16 or tstr[11:13] not in ("00", "06", "12", "18") \
                        or tstr[14:16] != "00":
                    continue
                # Only count TC-stage points (tropical or subtropical).
                if _b2s(nature[i, j]) not in ACE_NATURES:
                    continue
                # NA basin only (excludes EP crossings during the same storm).
                if _b2s(basin[i, j]) != "NA":
                    continue
                v = wmo_wind[i, j]
                if np.isnan(v):
                    v = usa_wind[i, j]
                if np.isnan(v) or v < ACE_VMAX_THRESH:
                    continue
                cum += (v * v) * 1e-4
                contributed = True
            if contributed:
                n_storms_yr += 1
        ace_per_year[int(yr)] = {
            "ace": round(float(cum), 2),
            "named_storms_contrib": int(n_storms_yr),
        }
        log.info("  %d: ACE=%6.1f, storms contributing=%d",
                 yr, cum, n_storms_yr)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "basin": "NA",
        "vmax_threshold_kt": ACE_VMAX_THRESH,
        "source": IBTRACS_URL,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "years": ace_per_year,
    }
    out_path.write_text(json.dumps(payload, indent=2))
    log.info("  wrote %s (%d years)", out_path, len(ace_per_year))
    return out_path


# --------------------------------------------------------------------------
# Step 3b: All-basin annual ACE (for correlation maps)
# --------------------------------------------------------------------------

def build_ace_all_basins(out_path: Path,
                         ibtracs_all_path: str | None = None) -> dict:
    """Compute annual ACE for every basin in IBTrACS.ALL.

    Same per-storm policy as `build_ace` (synoptic 6-hourly times, nature
    in {TS, SS}, track_type in {main, PROVISIONAL}, wmo_wind ≥ 35 kt with
    usa_wind fallback). Storms that cross basins are credited to the basin
    of the point being summed, so a single storm can contribute to two
    basins if it crossed (e.g., EP→NA).

    Returns the in-memory dict so the correlation step can consume it
    directly without re-reading the file.
    """
    path = ibtracs_all_path or IBTRACS_ALL_LOCAL
    if not Path(path).exists():
        raise FileNotFoundError(f"IBTrACS.ALL not found at {path}")
    log.info("Computing per-basin annual ACE from %s ...", path)

    ds = xr.open_dataset(path)
    season = ds["season"].values
    wmo_wind = ds["wmo_wind"].values
    usa_wind = ds["usa_wind"].values if "usa_wind" in ds else np.full_like(wmo_wind, np.nan)
    basin_arr = ds["basin"].values
    track_type = ds["track_type"].values
    iso_time = ds["iso_time"].values
    nature = ds["nature"].values

    def _b2s(x):
        return x.decode("utf-8") if isinstance(x, (bytes, bytearray)) else str(x)

    ACCEPTED_TRACK_TYPES = {"main", "PROVISIONAL"}
    ACE_NATURES = {"TS", "SS"}

    n_storms, n_times = wmo_wind.shape
    years = sorted({int(y) for y in season if not np.isnan(y) and int(y) >= INDICES_START_YEAR})
    # ace[basin][year] = cumulative ACE
    ace = {b: {y: 0.0 for y in years} for b in ACE_BASINS}

    for i in range(n_storms):
        yr = season[i]
        if np.isnan(yr):
            continue
        yr = int(yr)
        if yr < INDICES_START_YEAR:
            continue
        tt = _b2s(track_type[i])
        if tt not in ACCEPTED_TRACK_TYPES:
            continue
        for j in range(n_times):
            tstr = _b2s(iso_time[i, j])
            if len(tstr) < 16 or tstr[11:13] not in ("00", "06", "12", "18") \
                    or tstr[14:16] != "00":
                continue
            if _b2s(nature[i, j]) not in ACE_NATURES:
                continue
            b = _b2s(basin_arr[i, j])
            if b not in ACE_BASINS:
                continue
            v = wmo_wind[i, j]
            if np.isnan(v):
                v = usa_wind[i, j]
            if np.isnan(v) or v < ACE_VMAX_THRESH:
                continue
            ace[b][yr] += (v * v) * 1e-4

    ds.close()

    # Round + log a summary line per basin (last year + max year)
    payload = {"vmax_threshold_kt": ACE_VMAX_THRESH,
               "generated_utc": datetime.now(timezone.utc).isoformat(),
               "basins": {}}
    for b, label in ACE_BASINS.items():
        rounded = {y: round(float(v), 2) for y, v in ace[b].items()}
        max_yr = max(rounded, key=rounded.get)
        last_yr = max(rounded.keys())
        log.info("  %s (%s): max=%.1f in %d, %d=%.1f",
                 b, label, rounded[max_yr], max_yr, last_yr, rounded[last_yr])
        payload["basins"][b] = {"name": label, "years": rounded}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    log.info("  wrote %s (%.2f KB)", out_path, out_path.stat().st_size / 1024.0)
    return payload


# --------------------------------------------------------------------------
# Step 3c: Per-pixel ACE × SST correlation maps
# --------------------------------------------------------------------------

def build_correlations(out_dir: Path,
                       ace_all: dict | None = None,
                       monthly_path: str | None = None) -> Path:
    """For each (basin, month, raw/detrended), compute pixel-wise Pearson
    correlation between monthly SST and annual basin ACE (1982-present),
    and render as a PNG with a fixed RdBu_r colorbar (-0.7..+0.7).

    Detrended version removes a linear-in-year fit from both SST and ACE
    before correlating, so the correlation reflects year-to-year coupling
    rather than shared long-term trend.

    Writes:
      out_dir/correlations/{basin}_{MM}_{kind}.png
      out_dir/correlations/manifest.json
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import Normalize

    if ace_all is None:
        ace_all = build_ace_all_basins(out_dir / "ace_basins_annual.json")

    log.info("Building ACE×SST correlation maps ...")
    sst = _open_monthly_oisst(monthly_path)
    years_all = np.unique(sst.time.dt.year.values).astype(int)
    years_all = years_all[(years_all >= INDICES_START_YEAR)]
    log.info("  using SST years %d-%d (%d total)",
             int(years_all.min()), int(years_all.max()), len(years_all))

    corr_dir = out_dir / "correlations"
    corr_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "basins": ACE_BASINS,
        "months": list(range(1, 13)),
        "kinds": ["raw", "detrended", "relative",
                  "raw_spearman", "detrended_spearman", "relative_spearman"],
        "vmin": -0.7, "vmax": 0.7,
        "extent": [LON_MIN, LON_MAX, LAT_MIN, LAT_MAX],
        "tropical_mean_band": [TROPICAL_MEAN_LAT_MIN, TROPICAL_MEAN_LAT_MAX],
        "generated_utc": datetime.now(timezone.utc).isoformat(),
    }

    # Pre-stack SST by (year, month) once — saves re-selecting 144 times.
    log.info("  stacking SST as (year, month, lat, lon) cube ...")
    sst_stack = np.full((len(years_all), 12, sst.sizes["lat"], sst.sizes["lon"]),
                        np.nan, dtype=np.float32)
    year_idx = {int(y): i for i, y in enumerate(years_all)}
    for t in range(sst.sizes["time"]):
        ts = sst.time.values[t]
        y = int(ts.astype("datetime64[Y]").astype(int)) + 1970
        m = int(str(ts)[5:7])
        if y in year_idx:
            sst_stack[year_idx[y], m - 1] = sst.values[t]

    lat = sst.lat.values
    lon = sst.lon.values

    def _detrend(arr_yt):
        """Linear-in-year detrend along axis 0. arr_yt shape (n_years, *spatial)."""
        n = arr_yt.shape[0]
        x = np.arange(n, dtype=np.float64)
        x = (x - x.mean())
        denom = (x * x).sum()
        # Reshape to (n_years, K) for vectorized regression then reshape back.
        flat = arr_yt.reshape(n, -1).astype(np.float64)
        slope = (x[:, None] * flat).sum(axis=0) / denom
        # Subtract trend (no need to remove intercept — we'll re-mean later for correlation).
        flat = flat - slope[None, :] * x[:, None]
        return flat.reshape(arr_yt.shape).astype(np.float32)

    def _corr_along_year(sst_ym, ace_ts):
        """Pearson correlation along axis 0. Returns 2D (lat, lon)."""
        s = sst_ym.astype(np.float64)
        a = ace_ts.astype(np.float64)
        sm = np.nanmean(s, axis=0)
        am = a.mean()
        s_dev = s - sm
        a_dev = a - am
        num = np.nansum(s_dev * a_dev[:, None, None], axis=0)
        s_ss = np.nansum(s_dev * s_dev, axis=0)
        a_ss = (a_dev * a_dev).sum()
        denom = np.sqrt(s_ss * a_ss)
        with np.errstate(invalid="ignore", divide="ignore"):
            r = num / denom
        return r.astype(np.float32)

    def _spearman_along_year(sst_ym, ace_ts):
        """Spearman rank correlation along axis 0 = Pearson on ranks.
        Robust to outliers and to non-linear-but-monotonic relationships.
        Useful here because ACE is heavily right-skewed (a few
        hyperactive seasons dominate Pearson). Pixels that are NaN
        every year (land) return NaN; everywhere else we get a proper
        rank correlation."""
        s = sst_ym.astype(np.float64)
        # `argsort(axis=0).argsort(axis=0)` gives ranks 0..n-1 along
        # the year axis. NaN cells get a deterministic-but-meaningless
        # rank; the final NaN-mask below sets those to NaN.
        sst_ranks = s.argsort(axis=0).argsort(axis=0).astype(np.float64)
        ace_ranks = ace_ts.argsort().argsort().astype(np.float64)
        r = _corr_along_year(sst_ranks, ace_ranks)
        # Force land/all-NaN cells back to NaN.
        all_nan_mask = ~np.isfinite(s).any(axis=0)
        r[all_nan_mask] = np.nan
        return r

    def _render(corr_2d, fname, basin_name, month, kind):
        # Native subset is 340 × 1040 cells (lat × lon). Render at
        # 1600 × 520 (1.5× native lon, ample for browser display) so
        # the PNG stays sharp on wide monitors without ballooning file
        # size. dpi=200 with the standard 8-in figure width hits that
        # spot exactly; bbox_inches removed so output dims are
        # deterministic.
        fig_w = 8
        fig, ax = plt.subplots(
            figsize=(fig_w, fig_w * (LAT_MAX - LAT_MIN) / (LON_MAX - LON_MIN))
        )
        ax.imshow(corr_2d, origin="lower",
                  extent=[LON_MIN, LON_MAX, LAT_MIN, LAT_MAX],
                  cmap="RdBu_r", vmin=-0.7, vmax=0.7,
                  interpolation="bilinear")
        ax.set_axis_off()
        fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
        fig.savefig(corr_dir / fname, dpi=200, pad_inches=0,
                    transparent=True)
        plt.close(fig)

    def _write_grid_sidecar(corr_2d, fname):
        """1° lat/lon binned correlation grid for the frontend hover
        tooltip. Coarsening from native 0.25° to 1° drops payload from
        ~1.4 MB to ~30 KB per map, more than enough for tooltip resolution."""
        block = 4   # 0.25° → 1°
        H, W = corr_2d.shape
        h2, w2 = H // block, W // block
        c = corr_2d[:h2 * block, :w2 * block].reshape(h2, block, w2, block)
        with np.errstate(invalid="ignore"):
            coarse = np.nanmean(c, axis=(1, 3))
        grid = {
            "lat_min": LAT_MIN, "lat_max": LAT_MIN + h2 * 1.0,
            "lon_min": LON_MIN, "lon_max": LON_MIN + w2 * 1.0,
            "cell_size_deg": 1.0,
            "n_lat": int(h2), "n_lon": int(w2),
            "values": [[None if not np.isfinite(v) else round(float(v), 3)
                        for v in row] for row in coarse],
        }
        (corr_dir / fname).write_text(json.dumps(grid, separators=(",", ":")))


    # Region-mean correlation values used by the Panel E
    # "correlation-weighted" analog method. Structure:
    # {basin: {month: {region: {raw: r, detrended: r}}}}
    lat_axis = sst.lat.values
    lon_axis = sst.lon.values

    def _box_mean_corr(field_2d, box):
        """Area-weighted mean of the correlation field over a region box.
        Returns NaN if the box covers no finite cells (e.g. land-only)."""
        lat_s, lat_n, lon_w, lon_e = box
        lat_mask = (lat_axis >= lat_s) & (lat_axis <= lat_n)
        lon_mask = (lon_axis >= lon_w) & (lon_axis <= lon_e)
        sub = field_2d[np.ix_(lat_mask, lon_mask)]
        w = np.cos(np.deg2rad(lat_axis[lat_mask]))[:, None]
        finite = np.isfinite(sub)
        wsum = (w * finite).sum()
        if wsum == 0:
            return float("nan")
        return float((np.where(finite, sub, 0) * w).sum() / wsum)

    # Tropical-mean SST per (year, month) — used to compute the
    # Vecchi & Soden (2007) relative-SST field SST_rel = SST - trop_mean.
    # Vectorized area-weighted mean over 30°S-30°N × LON_MIN..LON_MAX.
    lat_trop_mask = (lat >= TROPICAL_MEAN_LAT_MIN) & (lat <= TROPICAL_MEAN_LAT_MAX)
    cos_w = np.cos(np.deg2rad(lat[lat_trop_mask]))[None, :, None]
    trop_mean_grid = np.full((len(years_all), 12), np.nan, dtype=np.float64)
    for mm in range(12):
        sub = sst_stack[:, mm][:, lat_trop_mask, :]
        finite = np.isfinite(sub)
        w2 = np.where(finite, cos_w, 0)
        s2 = np.where(finite, sub, 0)
        num = (s2 * w2).sum(axis=(1, 2))
        den = w2.sum(axis=(1, 2))
        trop_mean_grid[:, mm] = np.where(den > 0, num / den, np.nan)

    region_corr = {}
    # Distance matrices for the grid-based ("correlation-weighted pixel")
    # analog method on Panel E. Structure:
    # {basin: {month: {years: [...], raw: [[..]],
    #                  detrended: [[..]], relative: [[..]]}}}
    distance_matrices = {}
    def _pairwise_weighted_l2(field_yx, weight_x):
        """Squared-weighted L2 distance between every pair of rows in
        `field_yx` (shape n_years × n_pix), using `weight_x` (n_pix)
        as the per-pixel weight. NaN pixels are treated as zero (so
        land/missing cells contribute nothing rather than poisoning
        the sum)."""
        w = np.sqrt(np.abs(weight_x))
        # NaN-safe: zero out non-finite cells before weighting.
        finite = np.isfinite(field_yx) & np.isfinite(w)[None, :]
        weighted = np.where(finite, field_yx * w[None, :], 0).astype(np.float64)
        sq = np.sum(weighted * weighted, axis=1)
        gram = weighted @ weighted.T
        dist2 = sq[:, None] + sq[None, :] - 2 * gram
        return np.sqrt(np.maximum(dist2, 0))
    total = 0
    for basin in ACE_BASINS:
        region_corr[basin] = {}
        distance_matrices[basin] = {}
        ace_dict = ace_all["basins"][basin]["years"]
        ace_full = np.array([ace_dict.get(y, 0.0) for y in years_all.tolist()],
                            dtype=np.float64)
        for month in range(1, 13):
            sst_ym = sst_stack[:, month - 1]   # (n_years, lat, lon)
            # Mask out years where this month's SST is entirely missing
            # (e.g., months past the most-recent slab in the monthly file).
            valid_year_mask = np.isfinite(sst_ym).any(axis=(1, 2))
            if not valid_year_mask.any():
                log.warning("  %s month %d: no valid SST years; skipping", basin, month)
                continue
            sst_v = sst_ym[valid_year_mask]
            ace_v = ace_full[valid_year_mask]
            # Raw correlation
            # Pearson + Spearman correlation in parallel for each kind.
            # Spearman is robust to ACE outliers (1990 WP, 2005 NA, 2018
            # EP …); useful as an option but Pearson stays default since
            # it matches the standard convention in the literature.
            r_raw  = _corr_along_year(sst_v, ace_v)
            r_raw_s = _spearman_along_year(sst_v, ace_v)
            _render(r_raw, f"{basin}_{month:02d}_raw.png",
                    ACE_BASINS[basin], month, "raw")
            _render(r_raw_s, f"{basin}_{month:02d}_raw_spearman.png",
                    ACE_BASINS[basin], month, "raw_spearman")
            _write_grid_sidecar(r_raw, f"{basin}_{month:02d}_raw.grid.json")
            _write_grid_sidecar(r_raw_s, f"{basin}_{month:02d}_raw_spearman.grid.json")
            # Detrended (linear-in-year removed from both SST and ACE)
            ace_dt = _detrend(ace_v.reshape(-1, 1)).ravel()
            sst_dt = _detrend(sst_v)
            r_det  = _corr_along_year(sst_dt, ace_dt)
            r_det_s = _spearman_along_year(sst_dt, ace_dt)
            _render(r_det, f"{basin}_{month:02d}_detrended.png",
                    ACE_BASINS[basin], month, "detrended")
            _render(r_det_s, f"{basin}_{month:02d}_detrended_spearman.png",
                    ACE_BASINS[basin], month, "detrended_spearman")
            _write_grid_sidecar(r_det, f"{basin}_{month:02d}_detrended.grid.json")
            _write_grid_sidecar(r_det_s, f"{basin}_{month:02d}_detrended_spearman.grid.json")
            # Relative SST (Vecchi-Soden); ACE detrended for consistency.
            trop_v = trop_mean_grid[valid_year_mask, month - 1]
            sst_v_rel = sst_v - trop_v[:, None, None]
            r_rel  = _corr_along_year(sst_v_rel, ace_dt)
            r_rel_s = _spearman_along_year(sst_v_rel, ace_dt)
            _render(r_rel, f"{basin}_{month:02d}_relative.png",
                    ACE_BASINS[basin], month, "relative")
            _render(r_rel_s, f"{basin}_{month:02d}_relative_spearman.png",
                    ACE_BASINS[basin], month, "relative_spearman")
            _write_grid_sidecar(r_rel, f"{basin}_{month:02d}_relative.grid.json")
            _write_grid_sidecar(r_rel_s, f"{basin}_{month:02d}_relative_spearman.grid.json")
            total += 6

            # Per-region analog weights — Pearson + Spearman both.
            region_corr[basin][month] = {}
            for region, box in REGIONS.items():
                def _maybe(val):
                    return None if not np.isfinite(val) else round(val, 4)
                region_corr[basin][month][region] = {
                    "raw":              _maybe(_box_mean_corr(r_raw,  box)),
                    "raw_spearman":     _maybe(_box_mean_corr(r_raw_s, box)),
                    "detrended":        _maybe(_box_mean_corr(r_det,  box)),
                    "detrended_spearman": _maybe(_box_mean_corr(r_det_s, box)),
                    "relative":         _maybe(_box_mean_corr(r_rel,  box)),
                    "relative_spearman": _maybe(_box_mean_corr(r_rel_s, box)),
                }

            # Grid-based analog distance matrices — Pearson + Spearman.
            flat_raw = sst_v.reshape(sst_v.shape[0], -1)
            flat_dt = sst_dt.reshape(sst_dt.shape[0], -1)
            flat_rel = sst_v_rel.reshape(sst_v_rel.shape[0], -1)
            yr_list = years_all[valid_year_mask].tolist()
            distance_matrices[basin][month] = {
                "years":               [int(y) for y in yr_list],
                "raw":                 np.round(_pairwise_weighted_l2(flat_raw, r_raw.ravel()),  3).tolist(),
                "raw_spearman":        np.round(_pairwise_weighted_l2(flat_raw, r_raw_s.ravel()), 3).tolist(),
                "detrended":           np.round(_pairwise_weighted_l2(flat_dt,  r_det.ravel()),  3).tolist(),
                "detrended_spearman":  np.round(_pairwise_weighted_l2(flat_dt,  r_det_s.ravel()), 3).tolist(),
                "relative":            np.round(_pairwise_weighted_l2(flat_rel, r_rel.ravel()),  3).tolist(),
                "relative_spearman":   np.round(_pairwise_weighted_l2(flat_rel, r_rel_s.ravel()), 3).tolist(),
            }
        log.info("  basin %s: %d maps (raw/detrended/relative × pearson+spearman)",
                 basin, 36)

    (out_dir / "region_ace_correlations.json").write_text(
        json.dumps({"basins": region_corr,
                    "generated_utc": datetime.now(timezone.utc).isoformat()},
                   separators=(",", ":"))
    )
    log.info("  wrote region_ace_correlations.json (analog-weight lookup)")

    (out_dir / "analog_distance_matrices.json").write_text(
        json.dumps({"basins": distance_matrices,
                    "generated_utc": datetime.now(timezone.utc).isoformat()},
                   separators=(",", ":"))
    )
    sz = (out_dir / "analog_distance_matrices.json").stat().st_size
    log.info("  wrote analog_distance_matrices.json (%.2f MB, grid-based analog lookup)",
             sz / 1e6)

    (corr_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    log.info("  wrote %d correlation PNGs + manifest.json to %s",
             total, corr_dir)
    return corr_dir


# --------------------------------------------------------------------------
# Step 3d: Per-(year, month) anomaly contour paths (for Panel D overlay)
# --------------------------------------------------------------------------

def build_anomaly_contours(out_dir: Path, climo_path: Path,
                            monthly_path: str | None = None) -> Path:
    """Emit JSON contour-path files for the monthly SST anomaly field of
    each (year, month) in the record. Output:

        out_dir/anomaly_contours/{YYYY}_{MM}.json
        out_dir/anomaly_contours/manifest.json

    Each per-year-month file is a small JSON of the form
    {"levels": ["-2.0", "-1.0", "-0.5", "+0.5", "+1.0", "+2.0"],
     "paths": {"+1.0": [[[lat, lon], ...], ...], ...}}

    Used by the Panel D year-overlay feature: the frontend draws these
    polylines as SVG on top of the correlation shading, so the user can
    see at a glance whether the year's anomaly aligns with the
    historically-significant correlation pattern.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    if not climo_path.exists():
        raise FileNotFoundError(
            f"Climatology not found at {climo_path}. Run --step monthly_climatology first."
        )
    clim_mean = xr.open_dataset(climo_path)["sst_clim_mean"]   # (month, lat, lon)

    log.info("Building per-(year, month) SST anomaly contour JSON ...")
    sst = _open_monthly_oisst(monthly_path)

    LEVELS = [-2.0, -1.0, -0.5, 0.5, 1.0, 2.0]
    cdir = out_dir / "anomaly_contours"
    cdir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "levels": [f"{L:+.1f}" for L in LEVELS],
        "extent": [LON_MIN, LON_MAX, LAT_MIN, LAT_MAX],
        "years": [],
        "generated_utc": datetime.now(timezone.utc).isoformat(),
    }

    # Per-file size budget: downsample the anomaly field from 0.25° native
    # to 1° before contouring. Contour-path vertices scale roughly with
    # length, so 4× coarser sampling gives ~16× shorter total path length
    # → ~70 KB per file vs ~1.1 MB at native resolution. Visually
    # indistinguishable at the panel's display scale.
    COARSEN = 4
    n = 0
    years_seen = set()
    for t in range(sst.sizes["time"]):
        ts = sst.time.values[t]
        y = int(str(ts)[:4]); m = int(str(ts)[5:7])
        anom = sst.values[t] - clim_mean.sel(month=m).values
        # Block-mean coarsen
        H, W = anom.shape
        h2, w2 = H // COARSEN, W // COARSEN
        anom = anom[:h2 * COARSEN, :w2 * COARSEN].reshape(
            h2, COARSEN, w2, COARSEN)
        with np.errstate(invalid="ignore"):
            anom_coarse = np.nanmean(anom, axis=(1, 3))
        fig_h, ax_h = plt.subplots()
        try:
            cs = ax_h.contour(anom_coarse, levels=LEVELS,
                              extent=[LON_MIN, LON_MAX, LAT_MIN, LAT_MAX],
                              origin="lower")
            paths_by_level = {}
            for level, segs in zip(cs.levels, cs.allsegs):
                label = f"{level:+.1f}"
                paths = []
                for seg in segs:
                    if len(seg) < 2:
                        continue
                    pts = [[round(float(p[1]), 2), round(float(p[0]), 2)]
                           for p in seg]
                    paths.append(pts)
                if paths:
                    paths_by_level[label] = paths
        finally:
            plt.close(fig_h)
        # Also embed the binned anomaly grid (same coarsening) so the
        # Panel D hover tooltip can report this year's anomaly value at
        # the cursor alongside the correlation r — single fetch covers
        # both. Coarse grid is ~70 KB additional JSON.
        grid_vals = [[None if not np.isfinite(v) else round(float(v), 2)
                      for v in row] for row in anom_coarse]
        out_obj = {
            "year": y, "month": m,
            "extent": [LON_MIN, LON_MAX, LAT_MIN, LAT_MAX],
            "paths": paths_by_level,
            "grid": {
                "lat_min": LAT_MIN, "lat_max": LAT_MIN + h2 * 1.0,
                "lon_min": LON_MIN, "lon_max": LON_MIN + w2 * 1.0,
                "cell_size_deg": 1.0,
                "n_lat": int(h2), "n_lon": int(w2),
                "values": grid_vals,
            },
        }
        (cdir / f"{y}_{m:02d}.json").write_text(
            json.dumps(out_obj, separators=(",", ":")))
        years_seen.add(y)
        n += 1
    manifest["years"] = sorted(years_seen)
    (cdir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    log.info("  wrote %d anomaly-contour files (%d years) to %s",
             n, len(years_seen), cdir)
    return cdir


# --------------------------------------------------------------------------
# Step 3b: Daily indices (full-history backfill) + daily climatology + trend
# --------------------------------------------------------------------------
#
# These are the three blobs the RT Monitor Seasonal Panel B "Daily" view
# reads. They are one-time backfills, written locally from the per-year
# OISST files in OISST_LOCAL_CACHE and uploaded to GCS once. The daily
# Cloud Run Job (build_seasonal_diagnostics.py) does NOT touch them in
# steady state — it only appends to indices_daily_current_year.parquet.
#
# Schema of indices_daily_full.parquet:
#   date              YYYY-MM-DD
#   {region}_sst      area-weighted region-mean SST (°C)
#   {region}_anom     anomaly vs the per-DOY climatology
#   {region}_anom_rel Vecchi-Soden relative: anom − 30°S-30°N anom that day
#
# Matches the schema the daily job writes to indices_daily_current_year.parquet,
# so the two can be concat'd on the fly.

# Cumulative day-of-year (leap-year reference frame) at end of each prior month.
# Jan 1 = leap-DOY 1, Feb 1 = 32, Mar 1 = 61, ..., Dec 31 = 366.
_LEAP_DOY_CUM = (0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366)


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _leap_doy(month: int, day: int) -> int:
    """Day-of-year in a leap-year reference frame (1..366).

    Jan 1 = 1, Feb 28 = 59, Feb 29 = 60, Mar 1 = 61, Dec 31 = 366. This is
    the indexing the daily climatology + trend blobs use, and the indexing
    the frontend uses on its x-axis. In non-leap years, no data lands on
    leap-DOY 60 — Feb 28 → 59, Mar 1 → 61.
    """
    return _LEAP_DOY_CUM[month - 1] + day


def _ld_to_md(ld: int) -> tuple[int, int]:
    """Inverse of _leap_doy: leap-DOY (1..366) → (month, day)."""
    for m in range(12):
        if _LEAP_DOY_CUM[m] < ld <= _LEAP_DOY_CUM[m + 1]:
            return m + 1, ld - _LEAP_DOY_CUM[m]
    raise ValueError(f"leap-DOY out of range: {ld}")


def _build_daily_climo_grid(clim_mean: xr.DataArray) -> np.ndarray:
    """(366, n_lat, n_lon) interpolated daily climatology in the leap-year
    frame. Uses the existing 12-month basis + the same fractional-month
    interpolation as `_interp_daily_clim` (anchored at the 15th)."""
    n_lat = clim_mean.sizes["lat"]
    n_lon = clim_mean.sizes["lon"]
    out = np.empty((366, n_lat, n_lon), dtype=np.float32)
    for ld in range(1, 367):
        month, day = _ld_to_md(ld)
        # Year 2000 (a leap year) gives the interpolation helper a valid
        # Feb 29 anchor. The interpolation is year-independent in practice.
        out[ld - 1] = _interp_daily_clim(clim_mean, 2000, month, day)
    return out


def _build_daily_trop_climo(daily_climo_grid: np.ndarray,
                            lat_vals: np.ndarray) -> np.ndarray:
    """(366,) area-weighted tropical-mean climatology in the leap-year frame.
    Used to convert today's tropical-mean SST into today's tropical-mean
    anomaly when computing the Vecchi-Soden relative SST."""
    trop_mask = (lat_vals >= TROPICAL_MEAN_LAT_MIN) & (lat_vals <= TROPICAL_MEAN_LAT_MAX)
    w = np.cos(np.deg2rad(lat_vals[trop_mask]))[:, None]
    out = np.empty(366, dtype=np.float64)
    for ld in range(366):
        slab = daily_climo_grid[ld][trop_mask, :]
        finite = np.isfinite(slab)
        w2 = np.where(finite, w * np.ones_like(slab), 0)
        s2 = np.where(finite, slab, 0)
        denom = w2.sum()
        out[ld] = (s2 * w2).sum() / denom if denom > 0 else np.nan
    return out


def _build_region_index(lat_vals: np.ndarray, lon_vals: np.ndarray) -> dict:
    """Precompute per-region (lat_idx_slice, lon_idx_slice, cos-lat weights)
    so the per-day inner loop is plain numpy slicing + a weighted mean."""
    out = {}
    for name, (lat_s, lat_n, lon_w, lon_e) in REGIONS.items():
        lat_idx = np.where((lat_vals >= lat_s) & (lat_vals <= lat_n))[0]
        lon_idx = np.where((lon_vals >= lon_w) & (lon_vals <= lon_e))[0]
        if len(lat_idx) == 0 or len(lon_idx) == 0:
            raise ValueError(f"region {name} has empty footprint within OISST subset")
        w = np.cos(np.deg2rad(lat_vals[lat_idx]))[:, None]   # (n_lat_sub, 1)
        out[name] = (slice(lat_idx[0], lat_idx[-1] + 1),
                     slice(lon_idx[0], lon_idx[-1] + 1),
                     w)
    return out


def _region_mean_2d(slab: np.ndarray, region_entry: tuple) -> float:
    """NaN-safe area-weighted mean of a 2D (lat, lon) slab over a region."""
    lat_sl, lon_sl, w = region_entry
    sub = slab[lat_sl, lon_sl]
    finite = np.isfinite(sub)
    if not finite.any():
        return float("nan")
    w2 = np.where(finite, w * np.ones_like(sub), 0)
    s2 = np.where(finite, sub, 0)
    denom = w2.sum()
    return float((s2 * w2).sum() / denom) if denom > 0 else float("nan")


def _trop_mean_2d(slab: np.ndarray, lat_vals: np.ndarray) -> float:
    """NaN-safe area-weighted 30°S–30°N mean of a 2D (lat, lon) slab."""
    trop_mask = (lat_vals >= TROPICAL_MEAN_LAT_MIN) & (lat_vals <= TROPICAL_MEAN_LAT_MAX)
    sub = slab[trop_mask, :]
    w = np.cos(np.deg2rad(lat_vals[trop_mask]))[:, None]
    finite = np.isfinite(sub)
    if not finite.any():
        return float("nan")
    w2 = np.where(finite, w * np.ones_like(sub), 0)
    s2 = np.where(finite, sub, 0)
    denom = w2.sum()
    return float((s2 * w2).sum() / denom) if denom > 0 else float("nan")


def _compute_year_daily_rows(sst_da: xr.DataArray,
                             daily_climo_grid: np.ndarray,
                             daily_trop_climo: np.ndarray,
                             region_index: dict,
                             lat_vals: np.ndarray) -> list[dict]:
    """Return one row per day for `sst_da` (time × lat × lon). Each row has
    `date`, `{region}_sst`, `{region}_anom`, `{region}_anom_rel`."""
    times = sst_da["time"].values   # datetime64[ns]
    # Sanity-check: time coord must be datetime-like, not integers. If a
    # caller passed an array of 0..N-1 (the symptom of an over-eager
    # `.squeeze(drop=True)` upstream), the per-row parse below would die
    # with an opaque "invalid literal for int() with base 10: ''" error
    # several frames deep; surface it here instead.
    if not np.issubdtype(times.dtype, np.datetime64):
        raise TypeError(
            f"sst_da.time must be datetime64; got dtype={times.dtype}"
        )
    vals  = sst_da.values           # (n_days, n_lat, n_lon)
    n_days = vals.shape[0]
    rows = []
    for i in range(n_days):
        ts = times[i]
        # numpy.datetime64 → date string + (month, day)
        s = str(ts)[:10]
        year_i  = int(s[0:4])
        month_i = int(s[5:7])
        day_i   = int(s[8:10])
        ld = _leap_doy(month_i, day_i)
        slab = vals[i]
        clim_slab = daily_climo_grid[ld - 1]
        anom_slab = slab - clim_slab
        trop_today = _trop_mean_2d(slab, lat_vals)
        trop_clim_today = float(daily_trop_climo[ld - 1])
        trop_anom_today = (trop_today - trop_clim_today
                           if np.isfinite(trop_today) and np.isfinite(trop_clim_today)
                           else float("nan"))
        row = {"date": s}
        for name, entry in region_index.items():
            r_sst  = _region_mean_2d(slab,      entry)
            r_anom = _region_mean_2d(anom_slab, entry)
            row[f"{name}_sst"]      = round(r_sst,  4) if np.isfinite(r_sst)  else None
            row[f"{name}_anom"]     = round(r_anom, 4) if np.isfinite(r_anom) else None
            if np.isfinite(r_anom) and np.isfinite(trop_anom_today):
                row[f"{name}_anom_rel"] = round(r_anom - trop_anom_today, 4)
            else:
                row[f"{name}_anom_rel"] = None
        rows.append(row)
    return rows


def build_daily_indices_full(climo_path: Path,
                             out_path: Path,
                             year_start: int = INDICES_START_YEAR,
                             year_end: int | None = None) -> Path:
    """Build the 1982-present per-day region-mean SST + anomaly + relative
    anomaly parquet. Idempotent and resumable: existing year-rows are
    preserved; only years missing or partial are recomputed. The current
    calendar year is always recomputed (its row count grows daily anyway).

    Source: per-year OISST files in `OISST_LOCAL_CACHE`. `_open_oisst_year`
    pulls anything missing from PSL on first use and caches the NetCDF;
    subsequent runs are local-only and fast (~5-10 s/year).
    """
    import pandas as pd
    if not climo_path.exists():
        raise FileNotFoundError(
            f"Climatology not found at {climo_path}. "
            f"Run --step monthly_climatology first."
        )
    if year_end is None:
        year_end = datetime.now(timezone.utc).year

    log.info("Building daily indices %d-%d ...", year_start, year_end)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Load existing parquet (if any) to support resume.
    if out_path.exists():
        existing_df = pd.read_parquet(out_path)
        log.info("  found existing %s (%d rows); will resume",
                 out_path.name, len(existing_df))
    else:
        existing_df = pd.DataFrame()

    complete_years = set()
    if len(existing_df):
        existing_years = existing_df["date"].str.slice(0, 4).astype(int)
        current_year = datetime.now(timezone.utc).year
        for y, n_rows in existing_years.value_counts().items():
            if y >= current_year:
                continue   # always refresh the live year
            expected = 366 if _is_leap(int(y)) else 365
            # Allow a 2-day slack in case a year has a missing day at the
            # edge from earlier reprocessing.
            if n_rows >= expected - 2:
                complete_years.add(int(y))

    # Open the monthly climatology once and precompute the 366-day grid.
    log.info("  loading monthly climatology + precomputing 366-day grid")
    clim_ds = xr.open_dataset(climo_path)
    clim_mean = clim_ds["sst_clim_mean"]   # (month, lat, lon)
    lat_vals = clim_mean["lat"].values
    lon_vals = clim_mean["lon"].values
    daily_climo_grid = _build_daily_climo_grid(clim_mean)
    daily_trop_climo = _build_daily_trop_climo(daily_climo_grid, lat_vals)
    region_index = _build_region_index(lat_vals, lon_vals)
    clim_ds.close()

    new_chunks = [existing_df] if len(existing_df) else []
    for year in range(year_start, year_end + 1):
        if year in complete_years:
            log.info("  year %d: already complete; skipping", year)
            continue
        try:
            sst_da = _open_oisst_year(year)
        except Exception as e:
            log.warning("  year %d: failed to open (%s); skipping", year, e)
            continue
        t0 = time.time()
        rows = _compute_year_daily_rows(sst_da, daily_climo_grid,
                                        daily_trop_climo, region_index,
                                        lat_vals)
        log.info("  year %d: %d daily rows in %.1f s",
                 year, len(rows), time.time() - t0)

        # Drop any pre-existing rows from this year before appending.
        if len(existing_df):
            existing_df = existing_df[
                ~existing_df["date"].str.startswith(f"{year}-")
            ].reset_index(drop=True)
            new_chunks = [existing_df]
        new_chunks.append(pd.DataFrame(rows))

        # Spill to disk every year so a crash leaves progress.
        df_so_far = pd.concat(new_chunks, ignore_index=True)
        df_so_far = (df_so_far
                     .drop_duplicates(subset=["date"], keep="last")
                     .sort_values("date")
                     .reset_index(drop=True))
        df_so_far.to_parquet(out_path, compression="snappy", index=False)
        existing_df = df_so_far
        new_chunks = [existing_df]
        log.info("  year %d: parquet now %d rows (%.1f MB)",
                 year, len(df_so_far),
                 out_path.stat().st_size / 1e6)

    log.info("Done: %s", out_path)
    return out_path


def _rolling_circular_mean(arr: np.ndarray, window: int) -> np.ndarray:
    """Centered rolling mean along a 1D length-366 array with wraparound
    at the year boundary. Window must be odd. NaN-safe (NaN cells are
    excluded from their window)."""
    if window % 2 == 0:
        raise ValueError("window must be odd")
    n = arr.shape[0]
    half = window // 2
    out = np.empty(n, dtype=np.float64)
    for i in range(n):
        idx = [(i + d) % n for d in range(-half, half + 1)]
        sub = arr[idx]
        finite = np.isfinite(sub)
        out[i] = sub[finite].mean() if finite.any() else np.nan
    return out


def build_daily_climatology(daily_path: Path, out_path: Path,
                            climo_start: int = CLIMO_START_YEAR,
                            climo_end: int = CLIMO_END_YEAR,
                            smoothing_days: int = 7) -> Path:
    """Per-region, per-leap-DOY mean + std of SST, anom, and anom_rel across
    the 1991-2020 climatology window. 7-day circular rolling smoother
    applied to both mean and std so the curves don't show 30-sample noise.

    Reads from `indices_daily_full.parquet`. Output is a single small JSON.
    """
    import pandas as pd
    if not daily_path.exists():
        raise FileNotFoundError(
            f"{daily_path} not found. Run --step daily_indices first."
        )
    log.info("Building daily climatology %d-%d (smoothing=%d-day) ...",
             climo_start, climo_end, smoothing_days)
    df = pd.read_parquet(daily_path)
    year = df["date"].str.slice(0, 4).astype(int)
    mask = (year >= climo_start) & (year <= climo_end)
    df = df.loc[mask].reset_index(drop=True)
    log.info("  using %d daily rows from climo window", len(df))

    # Pre-compute leap-DOY for every row.
    months = df["date"].str.slice(5, 7).astype(int).to_numpy()
    days   = df["date"].str.slice(8, 10).astype(int).to_numpy()
    ld = np.fromiter((_leap_doy(m, d) for m, d in zip(months, days)),
                     dtype=np.int32, count=len(df))

    variables = ("sst", "anom", "anom_rel")
    payload = {
        "version": 1,
        "climo_window": [climo_start, climo_end],
        "smoothing": f"{smoothing_days}-day-circular-rolling",
        "doys": list(range(1, 367)),
        "regions": list(REGIONS.keys()),
        "values": {},
    }
    # Group rows by leap-DOY once → array of row-indices per DOY.
    by_doy = [[] for _ in range(367)]
    for i, d in enumerate(ld):
        by_doy[d].append(i)

    for region in REGIONS:
        payload["values"][region] = {}
        for var in variables:
            col = f"{region}_{var}"
            if col not in df.columns:
                continue
            vals = df[col].to_numpy(dtype=np.float64)
            mean_arr = np.full(366, np.nan, dtype=np.float64)
            std_arr  = np.full(366, np.nan, dtype=np.float64)
            for d in range(1, 367):
                idxs = by_doy[d]
                if not idxs:
                    continue
                v = vals[idxs]
                finite = np.isfinite(v)
                if not finite.any():
                    continue
                vf = v[finite]
                mean_arr[d - 1] = vf.mean()
                std_arr[d - 1]  = vf.std(ddof=0)
            mean_smooth = _rolling_circular_mean(mean_arr, smoothing_days)
            std_smooth  = _rolling_circular_mean(std_arr,  smoothing_days)
            payload["values"][region][var] = {
                "mean": [None if not np.isfinite(v) else round(float(v), 4)
                         for v in mean_smooth],
                "std":  [None if not np.isfinite(v) else round(float(v), 4)
                         for v in std_smooth],
            }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    log.info("Done: %s (%.1f KB)", out_path, out_path.stat().st_size / 1024.0)
    return out_path


def build_daily_trend(daily_path: Path, out_path: Path,
                      year_start: int = INDICES_START_YEAR,
                      year_end: int | None = None,
                      smoothing_days: int = 7) -> Path:
    """Per-region per-leap-DOY linear-in-year trend coefficients (slope °C/yr,
    intercept °C) fit on the SST column, plus the std of the per-DOY
    detrended series. Used by the frontend to compute the `sst_dt`
    (detrended SST) variant on the daily axis without needing the full
    parquet client-side.

    Trend is fit on years [year_start, year_end-1] (the current year is
    almost always incomplete, so excluded). Smoothed with the same 7-day
    circular roller as the climatology so coefficients don't have day-to-
    day noise.
    """
    import pandas as pd
    if not daily_path.exists():
        raise FileNotFoundError(
            f"{daily_path} not found. Run --step daily_indices first."
        )
    if year_end is None:
        year_end = datetime.now(timezone.utc).year   # exclusive upper bound
    log.info("Building daily trend %d..%d (excl) (smoothing=%d-day) ...",
             year_start, year_end, smoothing_days)
    df = pd.read_parquet(daily_path)
    year_col = df["date"].str.slice(0, 4).astype(int)
    mask = (year_col >= year_start) & (year_col < year_end)
    df = df.loc[mask].reset_index(drop=True)
    year_arr = df["date"].str.slice(0, 4).astype(int).to_numpy()
    log.info("  using %d daily rows for trend fit", len(df))

    months = df["date"].str.slice(5, 7).astype(int).to_numpy()
    days   = df["date"].str.slice(8, 10).astype(int).to_numpy()
    ld = np.fromiter((_leap_doy(m, d) for m, d in zip(months, days)),
                     dtype=np.int32, count=len(df))
    by_doy = [[] for _ in range(367)]
    for i, d in enumerate(ld):
        by_doy[d].append(i)

    payload = {
        "version": 1,
        "fit_window": [year_start, year_end - 1],
        "smoothing": f"{smoothing_days}-day-circular-rolling",
        "doys": list(range(1, 367)),
        "regions": list(REGIONS.keys()),
        "values": {},
    }
    for region in REGIONS:
        col = f"{region}_sst"
        if col not in df.columns:
            continue
        sst_arr = df[col].to_numpy(dtype=np.float64)
        slope_arr  = np.full(366, np.nan, dtype=np.float64)
        intercept_arr = np.full(366, np.nan, dtype=np.float64)
        dt_std_arr = np.full(366, np.nan, dtype=np.float64)
        for d in range(1, 367):
            idxs = by_doy[d]
            if not idxs:
                continue
            y_vals = year_arr[idxs].astype(np.float64)
            s_vals = sst_arr[idxs]
            finite = np.isfinite(s_vals)
            if finite.sum() < 5:   # too few points to fit
                continue
            yf = y_vals[finite]
            sf = s_vals[finite]
            slope, intercept = np.polyfit(yf, sf, 1)
            detrended = sf - (slope * yf + intercept)
            slope_arr[d - 1] = slope
            intercept_arr[d - 1] = intercept
            dt_std_arr[d - 1] = detrended.std(ddof=0)
        slope_smooth = _rolling_circular_mean(slope_arr, smoothing_days)
        # Intercept is sensitive to slope-smoothing rounding; refit
        # intercept after smoothing slope so the (smoothed) line still
        # passes through the centroid of the data. Equivalent to
        # recomputing intercept = mean(sst) - smoothed_slope * mean(year).
        intercept_smooth = np.full(366, np.nan, dtype=np.float64)
        for d in range(1, 367):
            idxs = by_doy[d]
            if not idxs or not np.isfinite(slope_smooth[d - 1]):
                continue
            y_vals = year_arr[idxs].astype(np.float64)
            s_vals = sst_arr[idxs]
            finite = np.isfinite(s_vals)
            if finite.sum() < 5:
                continue
            yf = y_vals[finite]
            sf = s_vals[finite]
            intercept_smooth[d - 1] = sf.mean() - slope_smooth[d - 1] * yf.mean()
        dt_std_smooth = _rolling_circular_mean(dt_std_arr, smoothing_days)
        payload["values"][region] = {
            "sst": {
                "slope":     [None if not np.isfinite(v) else round(float(v), 6)
                              for v in slope_smooth],
                "intercept": [None if not np.isfinite(v) else round(float(v), 4)
                              for v in intercept_smooth],
                "detrended_std": [None if not np.isfinite(v) else round(float(v), 4)
                                  for v in dt_std_smooth],
            },
        }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    log.info("Done: %s (%.1f KB)", out_path, out_path.stat().st_size / 1024.0)
    return out_path


def build_current_year_sidecar(daily_path: Path, out_path: Path,
                               year: int | None = None) -> Path:
    """Slice the current calendar year out of `indices_daily_full.parquet`
    and write a JSON sidecar in the same shape the daily Cloud Run Job
    produces (`indices_daily_current_year.json`). Useful for local
    previews when you've built the full-history parquet but don't want
    to run `build_seasonal_diagnostics.py` against PSL just to get the
    live-year JSON. The shape matches `_fetchData('indices_daily_current_year.json')`
    on the frontend exactly.
    """
    import pandas as pd
    if not daily_path.exists():
        raise FileNotFoundError(
            f"{daily_path} not found. Run --step daily_indices first."
        )
    if year is None:
        year = datetime.now(timezone.utc).year
    df = pd.read_parquet(daily_path)
    sub = df[df["date"].str.startswith(f"{year}-")].reset_index(drop=True)
    if len(sub) == 0:
        log.warning("  no rows for %d in %s — sidecar will be empty",
                    year, daily_path.name)
    payload = {
        "version": 1,
        "year": int(year),
        "as_of": datetime.now(timezone.utc).isoformat(),
        "dates": sub["date"].tolist(),
        "values": {col: sub[col].tolist()
                   for col in sub.columns if col != "date"},
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    log.info("Done: %s (%d rows, %.1f KB)",
             out_path, len(sub), out_path.stat().st_size / 1024.0)
    # Also write the matching parquet — the daily Cloud Run Job reads
    # this file on each tick and appends the new day. Seeding it with
    # the full year-to-date prevents the cron from clobbering the
    # sidecar with a 2-row file the first time it runs.
    parq_path = out_path.with_suffix(".parquet")
    sub.to_parquet(parq_path, compression="snappy", index=False)
    log.info("Done: %s (%d rows, %.1f KB)",
             parq_path, len(sub), parq_path.stat().st_size / 1024.0)
    return out_path


# --------------------------------------------------------------------------
# Step 4: Upload to GCS
# --------------------------------------------------------------------------

def upload_to_gcs(local_dir: Path) -> None:
    """Push the three derived blobs to gs://{bucket}/seasonal/."""
    try:
        from google.cloud import storage
    except ImportError as e:
        raise RuntimeError(
            "google-cloud-storage not installed; pip install google-cloud-storage"
        ) from e

    if not GCS_BUCKET:
        raise RuntimeError("GCS_IR_CACHE_BUCKET env var not set")

    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    targets = [
        ("oisst_monclim_1991_2020.nc",   "application/x-netcdf"),
        ("indices_monthly.parquet",      "application/octet-stream"),
        ("indices_monthly.json",         "application/json"),
        ("ace_annual.json",              "application/json"),
        ("ace_basins_annual.json",       "application/json"),
        ("region_ace_correlations.json", "application/json"),
        ("analog_distance_matrices.json", "application/json"),
        # Daily Panel B view (RT Monitor Seasonal tab).
        ("indices_daily_full.parquet",   "application/octet-stream"),
        ("clim_daily_1991_2020.json",    "application/json"),
        ("trend_daily_1982_present.json", "application/json"),
        # The current-year sidecar + parquet are normally appended-to by
        # the daily Cloud Run Job (build_seasonal_diagnostics.py), but
        # we also upload both from the backfill so the very first deploy
        # has a live-year curve AND the cron's parquet has a proper base
        # to grow from (the cron only appends one row per tick — without
        # this seed it would take ~5 months to reach a full-year window).
        ("indices_daily_current_year.parquet", "application/octet-stream"),
        ("indices_daily_current_year.json",    "application/json"),
    ]
    for fname, ctype in targets:
        src = local_dir / fname
        if not src.exists():
            log.warning("  skip %s (not present locally)", fname)
            continue
        blob = bucket.blob(f"{GCS_PREFIX}/{fname}")
        # publicRead matches build_seasonal_diagnostics._upload_blob:
        # the frontend pulls these blobs anonymously over
        # storage.googleapis.com, so each new blob needs the ACL.
        blob.upload_from_filename(str(src), content_type=ctype,
                                  predefined_acl="publicRead")
        log.info("  uploaded gs://%s/%s/%s (%.2f MB, public-read)",
                 GCS_BUCKET, GCS_PREFIX, fname, src.stat().st_size / 1e6)

    # Correlation maps: bulk-upload everything under correlations/.
    corr_dir = local_dir / "correlations"
    if corr_dir.is_dir():
        n = 0
        for p in sorted(corr_dir.iterdir()):
            if p.is_file():
                ctype = "image/png" if p.suffix == ".png" else "application/json"
                bucket.blob(f"{GCS_PREFIX}/correlations/{p.name}").upload_from_filename(
                    str(p), content_type=ctype)
                n += 1
        log.info("  uploaded %d files under gs://%s/%s/correlations/",
                 n, GCS_BUCKET, GCS_PREFIX)

    # Anomaly contour overlays for Panel D year toggle.
    ac_dir = local_dir / "anomaly_contours"
    if ac_dir.is_dir():
        n = 0
        for p in sorted(ac_dir.iterdir()):
            if p.is_file() and p.suffix == ".json":
                bucket.blob(f"{GCS_PREFIX}/anomaly_contours/{p.name}").upload_from_filename(
                    str(p), content_type="application/json")
                n += 1
        log.info("  uploaded %d files under gs://%s/%s/anomaly_contours/",
                 n, GCS_BUCKET, GCS_PREFIX)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--step",
                    choices=["monthly_climatology", "monthly_indices",
                             "ace", "correlations", "anomaly_contours",
                             "daily_indices", "daily_climatology",
                             "daily_trend", "daily_current_year",
                             "daily_all", "daily_local",
                             "upload", "all"],
                    default="all",
                    help="Which step to run (default: all). "
                         "`daily_all` = full backfill + upload to GCS. "
                         "`daily_local` = same builds, no upload — useful "
                         "for `python3 -m http.server 8000` previews.")
    ap.add_argument("--out", default="data/seasonal",
                    help="Local output directory")
    ap.add_argument("--monthly-file", default=None,
                    help=f"Path to OISST monthly file (default: {OISST_MONTHLY_LOCAL_DEFAULT})")
    ap.add_argument("--ibtracs", default=None,
                    help="Path to IBTrACS NA NetCDF (downloads if missing)")
    ap.add_argument("--refresh-ibtracs", action="store_true",
                    help="Re-download IBTrACS even if local copy exists")
    ap.add_argument("--year-end", type=int, default=None,
                    help="Last year to include in indices (default: current year)")
    args = ap.parse_args()

    out_dir = Path(args.out)
    climo_path = out_dir / "oisst_monclim_1991_2020.nc"
    indices_path = out_dir / "indices_monthly.parquet"
    ace_path = out_dir / "ace_annual.json"
    daily_full_path     = out_dir / "indices_daily_full.parquet"
    daily_climo_path    = out_dir / "clim_daily_1991_2020.json"
    daily_trend_path    = out_dir / "trend_daily_1982_present.json"
    daily_cy_path       = out_dir / "indices_daily_current_year.json"

    t0 = time.time()
    if args.step in ("monthly_climatology", "all"):
        if climo_path.exists():
            log.info("Climatology already at %s; skipping (delete to rebuild)",
                     climo_path)
        else:
            build_climatology(climo_path, monthly_path=args.monthly_file)

    if args.step in ("monthly_indices", "all"):
        build_indices(climo_path, indices_path,
                      year_end=args.year_end,
                      monthly_path=args.monthly_file)

    if args.step in ("ace", "all"):
        build_ace(ace_path, ibtracs_path=args.ibtracs,
                  refresh=args.refresh_ibtracs)

    if args.step in ("correlations", "all"):
        build_correlations(out_dir, monthly_path=args.monthly_file)

    if args.step in ("anomaly_contours", "all"):
        build_anomaly_contours(out_dir, climo_path, monthly_path=args.monthly_file)

    # Daily-resolution backfill (Panel B Daily view on the RT Monitor
    # Seasonal tab). Not in the default "all" run because it needs
    # /Users/mfischer/Data/OISST_daily/ populated and takes ~5-8 minutes.
    if args.step in ("daily_indices", "daily_all", "daily_local"):
        build_daily_indices_full(climo_path, daily_full_path,
                                 year_end=args.year_end)
    if args.step in ("daily_climatology", "daily_all", "daily_local"):
        build_daily_climatology(daily_full_path, daily_climo_path)
    if args.step in ("daily_trend", "daily_all", "daily_local"):
        build_daily_trend(daily_full_path, daily_trend_path)
    if args.step in ("daily_current_year", "daily_all", "daily_local"):
        build_current_year_sidecar(daily_full_path, daily_cy_path)

    if args.step in ("upload", "all", "daily_all"):
        upload_to_gcs(out_dir)

    log.info("Done in %.1f min.", (time.time() - t0) / 60.0)


if __name__ == "__main__":
    main()
