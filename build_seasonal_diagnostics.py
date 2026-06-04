"""Daily Cloud Run Job for the RT Monitor Seasonal tab.

Once a day (after NOAA's OISST drop), this job:

  1. Fetches the latest OISST v2.1 daily slice from PSL OPeNDAP, subset to
     the Atlantic + tropics box.
  2. Computes today's SST anomaly vs the precomputed day-of-year climatology
     (built once by build_oisst_history.py).
  3. Renders an Atlantic-centric anomaly PNG with a fixed -3..+3 °C
     diverging colormap.
  4. Computes today's region-mean SST + anomaly for each defined region and
     appends a row to indices_daily.parquet on GCS.
  5. Writes a small latest.json for fast first-paint on the frontend.

Mirrors the structure and ops envelope of build_subseasonal_overlays.py.
Expected wall time per run: ~30 s. Expected monthly cost: <$0.30.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import xarray as xr

# Re-use helpers from the backfill module to keep region defs and OPeNDAP
# logic in exactly one place.
from build_oisst_history import (
    LAT_MIN, LAT_MAX, LON_MIN, LON_MAX,
    REGIONS,
    _region_mean,
)

# Per-year daily file via PSL OPeNDAP. We only ever pull ONE timestep
# from this (today), so the full-year request-size cap that broke the
# historical backfill doesn't apply here.
OISST_DAILY_OPENDAP_TMPL = (
    "https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres/"
    "sst.day.mean.{year}.nc"
)

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("build_seasonal_diagnostics")

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
GCS_PREFIX = "seasonal"

# Local working directory inside the Cloud Run container.
WORK_DIR = Path(os.environ.get("SEASONAL_WORK_DIR", "/tmp/seasonal_work"))

# Global render box — full ±60° lat × 100..360°E so all 7 TC basins
# show up at once. The frontend can CSS-crop into individual basins
# via a "Zoom" selector without needing per-basin PNGs.
PNG_LAT_MIN, PNG_LAT_MAX = LAT_MIN, LAT_MAX
PNG_LON_MIN, PNG_LON_MAX = LON_MIN, LON_MAX
PNG_VMIN, PNG_VMAX = -3.0, 3.0            # °C, symmetric


# --------------------------------------------------------------------------
# GCS helpers
# --------------------------------------------------------------------------

def _gcs_client():
    from google.cloud import storage
    return storage.Client()


def _gcs_blob(name: str):
    if not GCS_BUCKET:
        raise RuntimeError("GCS_IR_CACHE_BUCKET not set")
    return _gcs_client().bucket(GCS_BUCKET).blob(f"{GCS_PREFIX}/{name}")


def _download_blob(name: str, dest: Path) -> bool:
    """Download a GCS blob to a local path. Returns False if it doesn't exist."""
    blob = _gcs_blob(name)
    if not blob.exists():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    blob.download_to_filename(str(dest))
    return True


def _upload_blob(src: Path, name: str, content_type: str) -> None:
    blob = _gcs_blob(name)
    # predefined_acl="publicRead" — the frontend fetches these blobs
    # directly via storage.googleapis.com, no auth header. Without this
    # the bucket-default private ACL applies and anon GETs 403.
    blob.upload_from_filename(
        str(src),
        content_type=content_type,
        predefined_acl="publicRead",
    )
    log.info("  uploaded gs://%s/%s/%s (%.1f KB, public-read)",
             GCS_BUCKET, GCS_PREFIX, name, src.stat().st_size / 1024.0)


# --------------------------------------------------------------------------
# Core daily step
# --------------------------------------------------------------------------

def _fetch_oisst_single_day(year: int) -> xr.DataArray | None:
    """Open year's daily OISST OPeNDAP file and return the last non-empty
    timestep, subset to the Atlantic+tropics box. Single-time-slice fetches
    are reliable through PSL OPeNDAP (the failure mode of the historical
    backfill was triggered by large multi-chunk requests, not single days)."""
    url = OISST_DAILY_OPENDAP_TMPL.format(year=year)
    try:
        ds = xr.open_dataset(url)
    except Exception as e:
        log.warning("  OPeNDAP open failed for %d: %s", year, e)
        return None
    try:
        sub = ds.sel(lat=slice(LAT_MIN, LAT_MAX), lon=slice(LON_MIN, LON_MAX))
        # Walk back from the last timestep until we find one with real data.
        for k in range(1, min(8, sub.sizes["time"]) + 1):
            slab = sub["sst"].isel(time=-k).load()
            vals = np.ascontiguousarray(slab.values)
            vals[np.abs(vals) > 50.0] = np.nan
            if np.isfinite(vals).any():
                t = slab["time"].values
                log.info("  latest OISST timestep: %s",
                         str(np.datetime64(t, "D")))
                return xr.DataArray(
                    vals, dims=("lat", "lon"),
                    coords={
                        "lat": slab["lat"].values.copy(),
                        "lon": slab["lon"].values.copy(),
                    },
                    attrs={"time": str(np.datetime64(t, "D"))},
                )
    finally:
        ds.close()
    return None


def fetch_latest_oisst() -> xr.DataArray:
    """Return the most recent available daily SST field from PSL.

    PSL's current-year file is updated each day with the latest available
    timestep. We open the current year's file, take the last time slice
    that's not all-NaN, and return it as a 2D DataArray with a time coord.
    """
    yr = datetime.now(timezone.utc).year
    sst = _fetch_oisst_single_day(yr)
    if sst is None:
        log.warning("  current-year (%d) OISST not available; trying %d", yr, yr - 1)
        sst = _fetch_oisst_single_day(yr - 1)
    if sst is None:
        raise RuntimeError(
            "Could not get a recent OISST timestep from either current or prior year"
        )
    return sst


def load_climatology() -> xr.Dataset:
    """Pull the monthly climatology from GCS (cached locally between runs)."""
    local = WORK_DIR / "oisst_monclim_1991_2020.nc"
    if not local.exists():
        log.info("  downloading climatology from GCS ...")
        if not _download_blob("oisst_monclim_1991_2020.nc", local):
            raise RuntimeError(
                "Climatology blob missing. Run build_oisst_history.py first."
            )
    return xr.open_dataset(local)


def _interp_month_climatology(clim_mean: xr.DataArray,
                              valid_date: np.datetime64) -> xr.DataArray:
    """Linearly interpolate the (month=1..12) climatology to a calendar day,
    using fractional-month phase between the 15th of consecutive months. This
    avoids discontinuous step jumps in the daily anomaly map at month
    boundaries."""
    d = pd.Timestamp(valid_date)
    # Phase 0 at the 15th of d.month, phase 1 at the 15th of the next month.
    this_15 = pd.Timestamp(d.year, d.month, 15)
    if d >= this_15:
        m_lo, m_hi = d.month, (d.month % 12) + 1
        next_15 = (this_15 + pd.DateOffset(months=1)).replace(day=15)
        frac = (d - this_15) / (next_15 - this_15)
    else:
        m_hi = d.month
        m_lo = 12 if d.month == 1 else d.month - 1
        prev_15 = (this_15 - pd.DateOffset(months=1)).replace(day=15)
        frac = (d - prev_15) / (this_15 - prev_15)
    a = clim_mean.sel(month=m_lo)
    b = clim_mean.sel(month=m_hi)
    return a + (b - a) * float(frac)


import pandas as pd


def render_anomaly_png(anom: xr.DataArray, valid_time: str) -> Path:
    """Render the Atlantic-centric anomaly PNG with a fixed diverging cmap.

    Also writes a small JSON sidecar (anom_<valid_time>.grid.json) holding
    the binned anomaly grid (downsampled to 1° so the payload stays under
    30 KB) for the frontend's mouse-hover tooltip.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    sub = anom.sel(lat=slice(PNG_LAT_MIN, PNG_LAT_MAX),
                   lon=slice(PNG_LON_MIN, PNG_LON_MAX))
    h, w = sub.shape
    aspect = w / h

    # Native OISST 0.25° subset is 400 × 260 cells. Render at 1600 × 1040
    # (4× native, 2× retina) so the browser never has to upscale and the
    # PNG stays crisp on wide monitors. Switch to dpi=200 + drop the
    # "tight" bbox so the output dims are deterministic (figsize × dpi).
    fig, ax = plt.subplots(figsize=(8.0, 8.0 / aspect))
    ax.imshow(
        sub.values, origin="lower",
        extent=[PNG_LON_MIN, PNG_LON_MAX, PNG_LAT_MIN, PNG_LAT_MAX],
        cmap="RdBu_r", vmin=PNG_VMIN, vmax=PNG_VMAX,
        interpolation="bilinear",
    )
    ax.set_axis_off()
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    out = WORK_DIR / f"anom_{valid_time}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=200, pad_inches=0, transparent=True)
    plt.close(fig)

    # Hover sidecar: 1° lat × 1° lon grid covering the same extent as the
    # PNG. Each cell holds a 1-decimal anomaly °C, or null for land/missing.
    # At PNG_LAT (-5..60) × PNG_LON (260..360) = 65 × 100 = 6500 cells
    # → ~25 KB JSON.
    coarse = sub.coarsen(lat=4, lon=4, boundary="trim").mean()
    vals = coarse.values
    grid_payload = {
        "valid_time": valid_time,
        "lat_min": PNG_LAT_MIN, "lat_max": PNG_LAT_MAX,
        "lon_min": PNG_LON_MIN, "lon_max": PNG_LON_MAX,
        "cell_size_deg": 1.0,
        "n_lat": int(vals.shape[0]), "n_lon": int(vals.shape[1]),
        # Row-major (lat × lon), south-to-north, west-to-east. Null for NaN.
        "values": [[None if not np.isfinite(v) else round(float(v), 2)
                    for v in row] for row in vals],
    }
    grid_path = WORK_DIR / f"anom_{valid_time}.grid.json"
    grid_path.write_text(json.dumps(grid_payload, separators=(",", ":")))
    log.info("  wrote hover sidecar %s (%.1f KB)",
             grid_path.name, grid_path.stat().st_size / 1024.0)
    return out


def compute_today_indices(sst: xr.DataArray, clim_mean: xr.DataArray) -> tuple:
    """Region-mean SST + anomaly for today's 2D slab. Climatology is
    interpolated to the calendar day from the 12-month basis. Also
    computes the Vecchi-Soden relative anomaly = raw anomaly minus
    the area-weighted 30°S-30°N anomaly (so the global trend signal
    is removed). Returns (row, anom_raw, anom_relative)."""
    valid_date = np.datetime64(sst.attrs["time"], "D")
    clim_today = _interp_month_climatology(clim_mean, valid_date)
    anom = sst - clim_today

    # Tropical-mean anomaly (matches the build_oisst_history band).
    from build_oisst_history import (TROPICAL_MEAN_LAT_MIN,
                                     TROPICAL_MEAN_LAT_MAX)
    trop = anom.sel(lat=slice(TROPICAL_MEAN_LAT_MIN, TROPICAL_MEAN_LAT_MAX))
    w = np.cos(np.deg2rad(trop.lat.values))[:, None]
    finite = np.isfinite(trop.values)
    w2 = np.where(finite, w * np.ones_like(trop.values), 0)
    s2 = np.where(finite, trop.values, 0)
    den = w2.sum()
    trop_anom_mean = float((s2 * w2).sum() / den) if den > 0 else 0.0
    anom_rel = anom - trop_anom_mean
    anom_rel.attrs = dict(anom.attrs)

    row = {"date": sst.attrs["time"]}
    for name, box in REGIONS.items():
        row[f"{name}_sst"]      = round(float(_region_mean(sst,      box).values), 4)
        row[f"{name}_anom"]     = round(float(_region_mean(anom,     box).values), 4)
        row[f"{name}_anom_rel"] = round(float(_region_mean(anom_rel, box).values), 4)
    return row, anom, anom_rel


def fetch_current_month_mtd_anomaly(clim_mean: xr.DataArray):
    """Month-to-date mean anomaly grids for the current calendar month.

    Averages the anomaly of every available day this month (each day's SST
    minus its day-interpolated climatology, via compute_today_indices so the
    field is identical in construction to the Panel A live anomaly) into a
    single MTD anomaly field, plus its Vecchi-Soden relative counterpart.

    This is the field the grid-weighted *preliminary* analog distances should
    use. A single daily slab (what fetch_latest_oisst returns) is noisy; the
    MTD mean is a far better-conditioned persistence estimate of the
    full-month anomaly — and persistence-of-anomaly is exactly the projection
    the analog distance assumes (projected full-month anom = current anom).

    Returns (anom_mtd_da, anom_rel_mtd_da, n_days, through_date) or None if no
    current-month days are available yet (caller falls back to single-day).
    """
    today = datetime.now(timezone.utc).date()
    year, month = today.year, today.month
    url = OISST_DAILY_OPENDAP_TMPL.format(year=year)
    try:
        ds = xr.open_dataset(url)
    except Exception as e:
        log.warning("  MTD anomaly: OPeNDAP open failed for %d: %s", year, e)
        return None
    anoms, rels, dates = [], [], []
    try:
        sub = ds.sel(lat=slice(LAT_MIN, LAT_MAX), lon=slice(LON_MIN, LON_MAX))
        for i, t in enumerate(sub["time"].values):
            ts = str(t)[:10]
            if not ts.startswith(f"{year}-{month:02d}-"):
                continue
            slab = sub["sst"].isel(time=i).load()
            v = np.ascontiguousarray(slab.values)
            v[np.abs(v) > 50.0] = np.nan
            if not np.isfinite(v).any():
                continue
            day_da = xr.DataArray(
                v, dims=("lat", "lon"),
                coords={"lat": slab["lat"].values.copy(),
                        "lon": slab["lon"].values.copy()},
                attrs={"time": ts})
            _row, a, ar = compute_today_indices(day_da, clim_mean)
            anoms.append(a)
            rels.append(ar)
            dates.append(ts)
    finally:
        ds.close()

    if not anoms:
        log.warning("  MTD anomaly: no current-month days available yet")
        return None
    # NaN-safe mean across days (land/ice cells that are NaN on some days
    # still contribute their finite days rather than poisoning the cell).
    anom_mtd = xr.concat(anoms, dim="_day").mean(dim="_day", skipna=True)
    anom_rel_mtd = xr.concat(rels, dim="_day").mean(dim="_day", skipna=True)
    anom_mtd.attrs = {"time": dates[-1]}
    anom_rel_mtd.attrs = {"time": dates[-1]}
    log.info("  MTD anomaly: averaged %d day(s) of %d-%02d (through %s)",
             len(anoms), year, month, dates[-1])
    return anom_mtd, anom_rel_mtd, len(anoms), dates[-1]


def compute_preliminary_analog_distances(
        anom_raw: xr.DataArray,
        anom_rel: xr.DataArray,
        ace_basins: dict,
) -> dict:
    """Compute grid-weighted L2 distance from the live preliminary
    current-month anomaly field to each historical year for every
    (basin, kind, stat) combination. Lets Panel E's grid-weighted
    method return real analogs for the current year instead of
    "no data" — the frontend falls back here when the precomputed
    distance matrix has no row for the target year.

    By construction (persistence-anomaly extrapolation), the projected
    full-month anomaly equals the MTD anomaly, so we use the MTD
    anomaly field directly. The weighting is shaped by the precomputed
    correlation field at 1° (we read the grid sidecars Panel D already
    emits). Output JSON shape:

      {basin: {kind+stat: {year: distance, ...}}}

    where kind+stat ∈ {raw, raw_spearman, detrended, detrended_spearman,
                       relative, relative_spearman}.
    """
    from build_oisst_history import ACE_BASINS

    today = datetime.now(timezone.utc).date()
    year = today.year
    month = today.month
    mm = f"{month:02d}"

    # ---- Coarsen the preliminary anomaly fields to the 1° grid used by
    # the correlation sidecars + the anomaly-contour grids. We need
    # numpy arrays at that resolution to compute distances.
    def _coarsen_1deg(da, kind_name):
        # Native is 0.25° → 1° coarsening = 4× in each dim.
        H, W = da.shape
        h2, w2 = H // 4, W // 4
        block = da.values[:h2 * 4, :w2 * 4].reshape(h2, 4, w2, 4)
        with np.errstate(invalid="ignore"):
            return np.nanmean(block, axis=(1, 3))
    prelim_raw_1deg = _coarsen_1deg(anom_raw, "raw")
    prelim_rel_1deg = _coarsen_1deg(anom_rel, "rel")
    # "Detrended" preliminary anomaly: persistence anom is itself
    # already the deviation from climo; for distance purposes the
    # detrended anomaly = MTD anomaly with the long-term trend at
    # current_year subtracted. But the linear trend is a constant
    # offset per pixel — it shifts each year uniformly. Pairwise
    # distances over the trend-removed field equal pairwise distances
    # over the raw anomaly field (constants cancel). So we can reuse
    # prelim_raw_1deg for detrended too without loss.
    prelim_by_kind = {
        'raw':       prelim_raw_1deg,
        'detrended': prelim_raw_1deg,
        'relative':  prelim_rel_1deg,
    }
    out = {"month": month, "year": year, "basins": {}}

    for basin in ACE_BASINS:
        out["basins"][basin] = {}
        for kind in ('raw', 'detrended', 'relative'):
            prelim = prelim_by_kind[kind]
            for stat in ('pearson', 'spearman'):
                stat_suffix = ('_spearman' if stat == 'spearman' else '')
                key = kind + stat_suffix
                # Load correlation 1° grid (small JSON).
                corr_name = (f"correlations/{basin}_{mm}_{kind}"
                             f"{stat_suffix}.grid.json")
                try:
                    cfile = WORK_DIR / corr_name
                    if cfile.exists():
                        cgrid = json.loads(cfile.read_text())
                    else:
                        ok = _download_blob(corr_name, cfile)
                        if not ok:
                            continue
                        cgrid = json.loads(cfile.read_text())
                except Exception as e:
                    log.warning("  prelim distances: failed to load %s: %s",
                                corr_name, e)
                    continue
                cvals = np.array(cgrid["values"], dtype=np.float64)
                # Weight per pixel = sqrt(|r|).
                w = np.sqrt(np.where(np.isfinite(cvals), np.abs(cvals), 0))
                # Loop over historical years' anomaly grids (embedded in
                # anomaly_contours/{year}_{MM}.json).
                dists = {}
                # 1982 .. current_year-1 is the conservative range; we
                # take what's there.
                for yh in range(1982, year):
                    yhname = f"anomaly_contours/{yh}_{mm}.json"
                    cache = WORK_DIR / yhname
                    if not cache.exists():
                        _download_blob(yhname, cache)
                    if not cache.exists():
                        continue
                    try:
                        ydata = json.loads(cache.read_text())
                    except Exception:
                        continue
                    ygrid = ydata.get("grid")
                    if not ygrid:
                        continue
                    yvals = np.array(ygrid["values"], dtype=np.float64)
                    # For 'relative' kind, we need each historical year's
                    # SST minus that year's tropical-mean anomaly. The
                    # contour JSON has raw anomaly only — approximate
                    # 'relative' by subtracting that year's 30°S-30°N
                    # mean anomaly (matches what compute_today_indices
                    # does for the live frame). For 'raw' and 'detrended',
                    # use the year-anomaly directly (constants cancel).
                    if kind == 'relative':
                        lat_axis = np.linspace(ygrid["lat_min"] + 0.5,
                                                ygrid["lat_max"] - 0.5,
                                                ygrid["n_lat"])
                        trop_mask = (lat_axis >= -30.0) & (lat_axis <= 30.0)
                        if trop_mask.any():
                            cosw = np.cos(np.deg2rad(lat_axis[trop_mask]))[:, None]
                            sub = yvals[trop_mask, :]
                            finite = np.isfinite(sub)
                            wsum = np.where(finite, cosw, 0)
                            ssum = np.where(finite, sub, 0)
                            denom = wsum.sum()
                            mean_ya = float((ssum * wsum).sum() / denom) if denom > 0 else 0
                            ya = yvals - mean_ya
                        else:
                            ya = yvals
                    else:
                        ya = yvals
                    # Pairwise distance: sqrt(sum(w² · (prelim - ya)²)).
                    diff = prelim - ya
                    sq = np.where(np.isfinite(diff), diff * diff, 0)
                    d = float(np.sqrt(np.sum(w * w * sq)))
                    dists[yh] = round(d, 3)
                if dists:
                    out["basins"][basin][key] = dists
    return out


def append_to_daily_parquet(row: dict) -> None:
    """Append today's row to the current-year daily indices parquet on GCS.
    Replaces any existing row for the same date so reruns are idempotent.

    Only the current year of daily values is kept on GCS — historical
    monthly values live in indices_monthly.parquet, written by the
    backfill. The frontend joins the two on the fly."""
    name = "indices_daily_current_year.parquet"
    local = WORK_DIR / name
    if not _download_blob(name, local):
        # First-of-year: start a fresh table.
        log.info("  no existing %s; starting fresh", name)
        df = pd.DataFrame(columns=list(row.keys()))
    else:
        df = pd.read_parquet(local)
    df = df[df["date"] != row["date"]]
    df = pd.concat([df, pd.DataFrame([row])], ignore_index=True)
    df = df.sort_values("date").reset_index(drop=True)
    df.to_parquet(local, compression="snappy", index=False)
    _upload_blob(local, name, "application/octet-stream")

    # JSON sidecar: same content in a browser-friendly shape so Panel B's
    # Daily view never touches parquet client-side. ~15 KB on the wire.
    json_name = "indices_daily_current_year.json"
    json_local = WORK_DIR / json_name
    payload = {
        "version": 1,
        "year": int(row["date"][:4]),
        "as_of": datetime.now(timezone.utc).isoformat(),
        "dates": df["date"].tolist(),
        "values": {col: df[col].tolist()
                   for col in df.columns if col != "date"},
    }
    json_local.write_text(json.dumps(payload, separators=(",", ":")))
    _upload_blob(json_local, json_name, "application/json")


def refresh_monthly_preliminary(climo_mean: xr.DataArray) -> None:
    """Patch the current-month preliminary row in indices_monthly.parquet
    so Panel C stays current between manual `build_oisst_history --step
    monthly_indices` runs. Without this, Panel C only refreshes when
    someone manually re-runs the backfill — the daily cron previously
    only touched the daily files, never the monthly one.

    Process: pull the existing parquet from GCS → compute a fresh
    preliminary row via `_fetch_current_month_preliminary` (same OPeNDAP
    logic the backfill uses) → drop any old preliminary for this month →
    splice the fresh row in → upload parquet + JSON sidecar.

    Note: the `{region}_sst_dt` (detrended) column for the preliminary
    row is left as NaN here. Computing the per-region linear-in-year
    trend would require iterating all finalized rows of this month,
    region-by-region. For tonight, Panel C's `Variable=SST detrended`
    selector simply won't have a preliminary star for the current month
    until the next full backfill; raw SST / anom / rel-anom are all
    fresh.
    """
    import pandas as pd
    from build_oisst_history import (_fetch_current_month_preliminary,
                                     _fetch_completed_month_from_daily,
                                     REGIONS,
                                     CLIMO_START_YEAR, CLIMO_END_YEAR)

    name = "indices_monthly.parquet"
    local = WORK_DIR / name
    if not _download_blob(name, local):
        log.warning("  no indices_monthly.parquet on GCS; skipping monthly refresh")
        return
    df = pd.read_parquet(local)

    today = datetime.now(timezone.utc).date()
    cur_month = f"{today.year}-{today.month:02d}"

    # Backward-compat: parquets written before the daily-derived gap-fill
    # landed don't carry this column.
    if "daily_derived" not in df.columns:
        df["daily_derived"] = False
    df["daily_derived"] = df["daily_derived"].fillna(False).astype(bool)

    # Fill / finalize completed-but-unpublished months from the daily
    # archive (NOAA's monthly OISST lags ~2 weeks). Each night this covers:
    #   * a new gap month the monthly file doesn't have yet, and
    #   * last month's leftover preliminary row, now that the month is
    #     complete — upgraded to a finalized-quality daily-derived row.
    # True NOAA-finalized rows (preliminary=False, daily_derived=False) are
    # never touched; the next full backfill replaces daily-derived rows with
    # official ones once NOAA publishes them.
    official = df[(~df["preliminary"]) & (~df["daily_derived"])]["date"]
    if len(official):
        cur_p = pd.Period(cur_month, freq="M")
        p = pd.Period(official.max(), freq="M") + 1
        while p < cur_p:
            key = f"{p.year}-{p.month:02d}"
            existing = df[df["date"] == key]
            if existing.empty or bool(existing["preliminary"].iloc[0]):
                filled = _fetch_completed_month_from_daily(
                    climo_mean, p.year, p.month)
                if filled:
                    df = df[df["date"] != key]
                    frow = pd.DataFrame([filled])
                    for col in df.columns:
                        if col not in frow.columns:
                            frow[col] = pd.NA
                    frow = frow[df.columns]
                    df = pd.concat([df, frow], ignore_index=True)
                    df = df.sort_values("date").reset_index(drop=True)
                    log.info("  filled daily-derived month %s (n=%d days)",
                             key, int(filled["n_days"]))
            p += 1

    log.info("  fetching preliminary month-to-date for %s ...", cur_month)
    prelim = _fetch_current_month_preliminary(climo_mean)
    if prelim is None:
        log.warning("  preliminary fetch returned None; skipping monthly refresh")
        return

    # Drop any existing row for this month (finalized or preliminary).
    df = df[df["date"] != cur_month]
    # Build the new row, aligned to the parquet schema (missing cols → NaN).
    new_row = pd.DataFrame([prelim])
    # Extend the schema with any prelim columns the parquet doesn't have yet
    # (e.g. a newly introduced projected sibling like `*_sst_rel_projected`).
    # Existing rows get NaN. Without this the strict `new_row[df.columns]`
    # reindex below would silently drop the new column every night, so a
    # freshly-added projected field would never reach the JSON until a full
    # backfill ran.
    for col in new_row.columns:
        if col not in df.columns:
            df[col] = pd.NA
    for col in df.columns:
        if col not in new_row.columns:
            new_row[col] = pd.NA
    new_row = new_row[df.columns]
    df = pd.concat([df, new_row], ignore_index=True)
    df = df.sort_values("date").reset_index(drop=True)

    # The current-month prelim row was aligned with missing cols → NA above.
    df["daily_derived"] = df["daily_derived"].fillna(False).astype(bool)

    df.to_parquet(local, compression="snappy", index=False)
    _upload_blob(local, name, "application/octet-stream")

    # JSON sidecar in the same shape build_indices writes.
    value_cols = [c for c in df.columns
                  if c not in ("date", "preliminary", "daily_derived",
                               "n_days", "as_of")]

    def _to_jsonable(s):
        return [None if pd.isna(v) else round(float(v), 3) for v in s]

    payload = {
        "regions": list(REGIONS.keys()),
        "dates": df["date"].tolist(),
        "values": {col: _to_jsonable(df[col]) for col in value_cols},
        "preliminary": df["preliminary"].astype(bool).tolist(),
        "daily_derived": df["daily_derived"].astype(bool).tolist(),
        "preliminary_n_days": df["n_days"].astype(int).tolist(),
        "climatology_period": f"{CLIMO_START_YEAR}-{CLIMO_END_YEAR}",
        "generated_utc": datetime.now(timezone.utc).isoformat(),
    }
    json_local = WORK_DIR / "indices_monthly.json"
    json_local.write_text(json.dumps(payload, separators=(",", ":")))
    _upload_blob(json_local, "indices_monthly.json", "application/json")
    log.info("  refreshed monthly preliminary %s (n_days=%d)",
             cur_month, int(prelim.get("n_days", 0)))


def write_latest_json(row: dict, png_name: str) -> None:
    """Tiny pointer file used by the frontend for first-paint. Now also
    points to the Vecchi-Soden relative-anomaly PNG + grid sidecar so
    the Panel A "Variable" selector can flip between raw and relative
    without an extra metadata fetch."""
    rel_png = png_name.replace(".png", "_relative.png")
    payload = {
        "valid_date": row["date"],
        "anom_png": png_name,
        "anom_grid": png_name.replace(".png", ".grid.json"),
        "anom_png_relative": rel_png,
        "anom_grid_relative": rel_png.replace(".png", ".grid.json"),
        "indices": {k: v for k, v in row.items() if k not in ("date", "dayofyear")},
        "generated_utc": datetime.now(timezone.utc).isoformat(),
    }
    local = WORK_DIR / "latest.json"
    local.write_text(json.dumps(payload, separators=(",", ":")))
    _upload_blob(local, "latest.json", "application/json")


def main():
    global WORK_DIR
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--local-only", action="store_true",
                    help="Skip GCS up/downloads; use local files in --out")
    ap.add_argument("--out", default=str(WORK_DIR),
                    help="Local working dir")
    args = ap.parse_args()

    WORK_DIR = Path(args.out)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    log.info("Fetching latest OISST ...")
    sst = fetch_latest_oisst()

    log.info("Loading climatology ...")
    clim = load_climatology()

    log.info("Computing indices + anomaly (raw + relative) ...")
    row, anom, anom_rel = compute_today_indices(sst, clim["sst_clim_mean"])
    log.info("  date=%s, MDR anom=%+.2f °C (rel %+.2f °C), AMO anom=%+.2f °C, Niño3.4 anom=%+.2f °C",
             row["date"], row["atl_mdr_anom"], row["atl_mdr_anom_rel"],
             row["atl_amo_anom"], row["nino34_anom"])

    log.info("Rendering anomaly PNGs (raw + relative) ...")
    png_path = render_anomaly_png(anom, row["date"])
    png_path_rel = render_anomaly_png(anom_rel, row["date"] + "_relative")

    if args.local_only:
        log.info("Local-only mode: skipping GCS uploads")
    else:
        log.info("Uploading PNG + hover-sidecar (raw + relative) ...")
        _upload_blob(png_path, f"anom_png/{row['date']}.png", "image/png")
        _upload_blob(png_path_rel,
                     f"anom_png/{row['date']}_relative.png", "image/png")
        for label in [row["date"], row["date"] + "_relative"]:
            gp = WORK_DIR / f"anom_{label}.grid.json"
            if gp.exists():
                _upload_blob(gp, f"anom_png/{label}.grid.json",
                             "application/json")
        log.info("Appending daily indices parquet ...")
        append_to_daily_parquet(row)
        log.info("Refreshing monthly preliminary row (Panel C) ...")
        try:
            refresh_monthly_preliminary(clim["sst_clim_mean"])
        except Exception as e:
            # Don't let a monthly-refresh failure block the rest of the
            # daily run; the manual backfill still works as a fallback.
            log.warning("  monthly refresh failed: %s", e)
        log.info("Writing latest.json ...")
        write_latest_json(row, f"anom_png/{row['date']}.png")

    log.info("Computing preliminary analog distances for Panel E ...")
    try:
        # Prefer the month-to-date mean anomaly (averages all available days
        # of the current month) over the single latest daily slab — far less
        # noisy, especially early in a month. Falls back to the single-day
        # field if the MTD fetch yields nothing.
        mtd = fetch_current_month_mtd_anomaly(clim["sst_clim_mean"])
        if mtd is not None:
            anom_pre, anom_rel_pre, n_mtd, mtd_through = mtd
            log.info("  analog distances use %d-day MTD mean anomaly (through %s)",
                     n_mtd, mtd_through)
        else:
            anom_pre, anom_rel_pre = anom, anom_rel
            log.warning("  MTD anomaly unavailable; using single-day field "
                        "for analog distances")
        prelim_dist = compute_preliminary_analog_distances(anom_pre, anom_rel_pre, None)
        out_local = WORK_DIR / "analog_preliminary_distances.json"
        out_local.write_text(json.dumps(prelim_dist, separators=(",", ":")))
        if not args.local_only:
            _upload_blob(out_local, "analog_preliminary_distances.json",
                         "application/json")
        log.info("  wrote analog_preliminary_distances.json (%.1f KB)",
                 out_local.stat().st_size / 1024.0)
    except Exception as e:
        log.warning("  preliminary distances failed: %s", e)

    log.info("Done in %.1f s.", time.time() - t0)


if __name__ == "__main__":
    main()
