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

# Atlantic-centric render box (PNG only — the indices use the wider box
# defined in build_oisst_history.py).
PNG_LAT_MIN, PNG_LAT_MAX = -5.0, 60.0
PNG_LON_MIN, PNG_LON_MAX = 260.0, 360.0   # 100°W .. 0°
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
    blob.upload_from_filename(str(src), content_type=content_type)
    log.info("  uploaded gs://%s/%s/%s (%.1f KB)",
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
    interpolated to the calendar day from the 12-month basis."""
    valid_date = np.datetime64(sst.attrs["time"], "D")
    clim_today = _interp_month_climatology(clim_mean, valid_date)
    anom = sst - clim_today
    row = {"date": sst.attrs["time"]}
    for name, box in REGIONS.items():
        row[f"{name}_sst"]  = round(float(_region_mean(sst,  box).values), 4)
        row[f"{name}_anom"] = round(float(_region_mean(anom, box).values), 4)
    return row, anom


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


def write_latest_json(row: dict, png_name: str) -> None:
    """Tiny pointer file used by the frontend for first-paint."""
    payload = {
        "valid_date": row["date"],
        "anom_png": png_name,
        "anom_grid": png_name.replace(".png", ".grid.json"),
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

    log.info("Computing indices + anomaly ...")
    row, anom = compute_today_indices(sst, clim["sst_clim_mean"])
    log.info("  date=%s, MDR anom=%+.2f °C, AMO anom=%+.2f °C, Niño3.4 anom=%+.2f °C",
             row["date"], row["atl_mdr_anom"], row["atl_amo_anom"], row["nino34_anom"])

    log.info("Rendering anomaly PNG ...")
    png_path = render_anomaly_png(anom, row["date"])

    if args.local_only:
        log.info("Local-only mode: skipping GCS uploads")
    else:
        log.info("Uploading PNG + hover-sidecar ...")
        _upload_blob(png_path, f"anom_png/{row['date']}.png", "image/png")
        grid_path = WORK_DIR / f"anom_{row['date']}.grid.json"
        if grid_path.exists():
            _upload_blob(grid_path,
                         f"anom_png/{row['date']}.grid.json",
                         "application/json")
        log.info("Appending daily indices parquet ...")
        append_to_daily_parquet(row)
        log.info("Writing latest.json ...")
        write_latest_json(row, f"anom_png/{row['date']}.png")

    log.info("Done in %.1f s.", time.time() - t0)


if __name__ == "__main__":
    main()
