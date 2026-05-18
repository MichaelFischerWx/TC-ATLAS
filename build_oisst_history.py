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

# NOAA OISST v2.1 high-resolution (0.25°) daily SST. Per-year files; PSL
# provides the current year as a partial file refreshed daily. We download
# the full file rather than using OPeNDAP because PSL's THREDDS OPeNDAP
# endpoint silently returns mostly-zero data when chunked-read patterns hit
# its request-size limits (~500 MB). Direct download is ~120 MB/yr — fast,
# reliable, and matches what's already used elsewhere in the project.
OISST_DOWNLOAD_TMPL = (
    "https://psl.noaa.gov/thredds/fileServer/Datasets/noaa.oisst.v2.highres/"
    "sst.day.mean.{year}.nc"
)
OISST_OPENDAP_TMPL = OISST_DOWNLOAD_TMPL   # kept for back-compat with importers

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

def _download_oisst_year(year: int) -> Path:
    """Mirror sst.day.mean.{year}.nc from PSL to the local cache.

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
    url = OISST_DOWNLOAD_TMPL.format(year=year)
    log.info("  downloading %s", url)
    tmp = local.with_suffix(local.suffix + ".tmp")
    import requests
    with requests.get(url, stream=True, timeout=(30, 600)) as r:
        r.raise_for_status()
        expected = int(r.headers.get("Content-Length", "0"))
        written = 0
        with open(tmp, "wb") as fout:
            for chunk in r.iter_content(chunk_size=1 << 20):  # 1 MB chunks
                if chunk:
                    fout.write(chunk)
                    written += len(chunk)
        if expected and written != expected:
            tmp.unlink()
            raise IOError(
                f"truncated download for {year}: got {written} bytes, expected {expected}"
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

    row = {"date": f"{year}-{month:02d}", "preliminary": True,
           "n_days": int(len(day_idx)), "as_of": today.isoformat()}
    for name, box in REGIONS.items():
        row[f"{name}_sst"]            = round(float(_region_mean(mtd_sst_da,        box).values), 4)
        row[f"{name}_anom"]           = round(float(_region_mean(mtd_anom_da,       box).values), 4)
        row[f"{name}_sst_projected"]  = round(float(_region_mean(projected_sst_da,  box).values), 4)
        # Projected anom equals MTD anom by construction (persistence).
        row[f"{name}_anom_projected"] = row[f"{name}_anom"]
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

    rows = {"date": sst.time.values.astype("datetime64[M]").astype(str)}
    for name, box in REGIONS.items():
        log.info("  region %-10s box=%s", name, box)
        rows[f"{name}_sst"]  = np.round(_region_mean(sst,  box).values, 4)
        rows[f"{name}_anom"] = np.round(_region_mean(anom, box).values, 4)

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
        "kinds": ["raw", "detrended"],
        "vmin": -0.7, "vmax": 0.7,
        "extent": [LON_MIN, LON_MAX, LAT_MIN, LAT_MAX],
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


    total = 0
    for basin in ACE_BASINS:
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
            r_raw = _corr_along_year(sst_v, ace_v)
            _render(r_raw, f"{basin}_{month:02d}_raw.png",
                    ACE_BASINS[basin], month, "raw")
            _write_grid_sidecar(r_raw, f"{basin}_{month:02d}_raw.grid.json")
            # Detrended correlation (linear-in-year removed from BOTH series)
            ace_dt = _detrend(ace_v.reshape(-1, 1)).ravel()
            sst_dt = _detrend(sst_v)
            r_det = _corr_along_year(sst_dt, ace_dt)
            _render(r_det, f"{basin}_{month:02d}_detrended.png",
                    ACE_BASINS[basin], month, "detrended")
            _write_grid_sidecar(r_det, f"{basin}_{month:02d}_detrended.grid.json")
            total += 2
        log.info("  basin %s: 24 maps", basin)

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
        out_obj = {"year": y, "month": m,
                   "extent": [LON_MIN, LON_MAX, LAT_MIN, LAT_MAX],
                   "paths": paths_by_level}
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
        ("oisst_monclim_1991_2020.nc",  "application/x-netcdf"),
        ("indices_monthly.parquet",     "application/octet-stream"),
        ("indices_monthly.json",        "application/json"),
        ("ace_annual.json",             "application/json"),
        ("ace_basins_annual.json",      "application/json"),
    ]
    for fname, ctype in targets:
        src = local_dir / fname
        if not src.exists():
            log.warning("  skip %s (not present locally)", fname)
            continue
        blob = bucket.blob(f"{GCS_PREFIX}/{fname}")
        blob.upload_from_filename(str(src), content_type=ctype)
        log.info("  uploaded gs://%s/%s/%s (%.2f MB)",
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
                             "upload", "all"],
                    default="all",
                    help="Which step to run (default: all)")
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

    if args.step in ("upload", "all"):
        upload_to_gcs(out_dir)

    log.info("Done in %.1f min.", (time.time() - t0) / 60.0)


if __name__ == "__main__":
    main()
