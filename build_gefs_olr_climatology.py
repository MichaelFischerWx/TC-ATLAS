#!/usr/bin/env python3
"""Build a GEFSv12 reforecast TOA-OLR (ULWRF) climatology sidecar.

WHY THIS EXISTS
---------------
The Subseasonal Hovmöller appends a 10-day GEFS forecast to the observed
NOAA/CPC OLR series. The live pipeline (``build_subseasonal_overlays.py``)
historically formed the forecast anomaly by subtracting the *observed* CPC
1991-2020 climatology from the GEFS forecast. But GEFS model OLR (ULWRF at
top-of-atmosphere) has a different mean state than CPC Blended OLR, so that
mismatch left a systematic step at the observed-forecast seam — visible as a
discontinuity in the WK-filtered wave contours where they cross the
``GEFS forecast`` line.

The fix is to express the GEFS forecast as an anomaly relative to GEFS's
*own* climatology (per forecast lead, per day-of-year), so both the observed
and forecast halves of the Hovmöller are anomalies about their own base
state and join smoothly. This script builds that GEFS climatology once,
offline, and writes a NetCDF sidecar the live pipeline loads (locally or
from GCS).

WHAT IT PRODUCES
----------------
A NetCDF DataArray ``ulwrf_climo`` of shape (lead, doy, lat, lon):
  - lead : forecast day 1..MAX_LEAD (day k valid on cycle_date + (k-1))
  - doy  : valid-time day-of-year 1..366 (smoothed with a circular window)
  - lat, lon : the 2.5° observed OLR grid (read from the live OPeNDAP source
               so the climatology lands on exactly the grid the live forecast
               is regridded onto)
Plus provenance attrs (period, members, stride, smoothing, n samples/bin).

COST
----
The recurring 6-h overlay job pays ~nothing: it loads this sidecar and does
one array subtraction. The cost is entirely here, and it is bandwidth, not
compute: ~40 byte-range GRIB pulls (~0.4 MB each) per sampled init. With the
defaults (c00 control, every 5th init across 2000-2019) that is ~1,460 inits
≈ ~23 GB and a few hours wall-clock — run once. Tune --stride / --members /
--years to trade accuracy against download.

USAGE
-----
  python3 build_gefs_olr_climatology.py \
      --out cache/gefs_ulwrf_climo.nc --stride 5 --members c00 --upload-gcs

The output is consumed by build_subseasonal_overlays.py
(``gefs_daily_climatology`` / ``gefs_forecast_anomaly``).
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import requests

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("build_gefs_olr_climatology")

# --------------------------------------------------------------------------
# Constants — keep in sync with build_subseasonal_overlays.py
# --------------------------------------------------------------------------
# Observed OLR grid source (coordinates only are read here).
OPENDAP_URL = ("https://psl.noaa.gov/thredds/dodsC/Datasets/"
               "cpc_blended_olr-2.5deg/olr.day.mean.nc")

# GEFSv12 reforecast public mirror. ULWRF-at-TOA is stored as `ulwrf_tatm`,
# Days:1-10 file = forty 6-hour-average windows (0-6, 6-12, ... 234-240),
# matching the operational pgrb2a product the live forecast pulls.
REFCST_HOST = "noaa-gefs-retrospective.s3.amazonaws.com"
MAX_LEAD = int(os.environ.get("GEFS_CLIMO_MAX_LEAD", "10"))   # forecast days

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
GCS_PREFIX = "subseasonal"
GCS_CLIMO_NAME = "gefs_ulwrf_climo.nc"


# --------------------------------------------------------------------------
# Observed grid (regrid target)
# --------------------------------------------------------------------------
def obs_grid():
    """Return (lat, lon) 1-D arrays of the live OLR grid via OPeNDAP coords."""
    import xarray as xr
    log.info("Reading observed OLR grid coordinates from OPeNDAP ...")
    ds = xr.open_dataset(OPENDAP_URL, decode_times=False)
    lat = ds["lat"].values.astype(np.float64)
    lon = ds["lon"].values.astype(np.float64)
    ds.close()
    log.info("  observed grid: %d lat x %d lon (lat %.1f..%.1f, lon %.1f..%.1f)",
             lat.size, lon.size, lat[0], lat[-1], lon[0], lon[-1])
    return lat, lon


# --------------------------------------------------------------------------
# GEFS reforecast access
# --------------------------------------------------------------------------
def _refcst_base(date_str: str, member: str) -> str:
    yyyy = date_str[:4]
    return (f"https://{REFCST_HOST}/GEFSv12/reforecast/{yyyy}/{date_str}00/"
            f"{member}/Days:1-10/ulwrf_tatm_{date_str}00_{member}.grib2")


def _decode_msg(content: bytes) -> Optional["object"]:
    """Decode one GRIB message (bytes) to a DataArray(lat, lon)."""
    import xarray as xr
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
        tmp.write(content)
        path = tmp.name
    try:
        ds = xr.open_dataset(path, engine="cfgrib",
                             backend_kwargs={"indexpath": ""},
                             decode_timedelta=False)
        vname = list(ds.data_vars)[0]
        da = ds[vname].rename({"latitude": "lat", "longitude": "lon"})
        return da.load()
    except Exception as e:
        log.warning("cfgrib decode failed: %s", e)
        return None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _daily_means_for_init(date_str: str, member: str,
                          obs_lat, obs_lon, max_lead: int = MAX_LEAD):
    """Return a (lead, lat, lon) DataArray of calendar-day-mean ULWRF for one
    reforecast init, regridded to the observed grid, or None on failure.

    Day k (1-based) = mean of the four 6-hour-average windows spanning hours
    [24(k-1) .. 24k], matching the live product's daily-mean construction.
    """
    import xarray as xr
    base = _refcst_base(date_str, member)
    try:
        idx = requests.get(base + ".idx", timeout=60).text
    except Exception as e:
        log.warning("%s %s: idx fetch failed: %s", date_str, member, e)
        return None
    lines = idx.strip().split("\n")

    # Map "<start>-<end> hour ave fcst" -> (byte_start, byte_end)
    def _byte_range(label: str):
        for i, ln in enumerate(lines):
            p = ln.split(":")
            if len(p) >= 6 and p[3] == "ULWRF" and p[4] == "top of atmosphere" \
                    and p[5] == label:
                start = int(p[1])
                end = (int(lines[i + 1].split(":")[1]) - 1
                       if i + 1 < len(lines) else None)
                return start, end
        return None, None

    leads = []
    for k in range(1, max_lead + 1):
        h0 = 24 * (k - 1)
        windows = [f"{h0}-{h0 + 6} hour ave fcst",
                   f"{h0 + 6}-{h0 + 12} hour ave fcst",
                   f"{h0 + 12}-{h0 + 18} hour ave fcst",
                   f"{h0 + 18}-{h0 + 24} hour ave fcst"]
        fields = []
        for w in windows:
            start, end = _byte_range(w)
            if start is None:
                break
            rng = f"bytes={start}-{end if end is not None else ''}"
            try:
                r = requests.get(base, headers={"Range": rng}, timeout=120)
                if r.status_code not in (200, 206) or not r.content.startswith(b"GRIB"):
                    break
            except Exception as e:
                log.warning("%s %s %s: range fetch failed: %s",
                            date_str, member, w, e)
                break
            da = _decode_msg(r.content)
            if da is None:
                break
            fields.append(da)
        if len(fields) < 4:
            log.warning("%s %s: day %d incomplete (%d/4 windows) — stop",
                        date_str, member, k, len(fields))
            break
        day_mean = sum(fields) / 4.0
        # Regrid native 0.5° -> observed 2.5° grid (interp tolerates the
        # descending-lat source coordinate).
        leads.append(day_mean.interp(lat=obs_lat, lon=obs_lon))

    if not leads:
        return None
    out = xr.concat(leads, dim="lead")
    out = out.assign_coords(lead=("lead", np.arange(1, len(leads) + 1)))
    return out


# --------------------------------------------------------------------------
# Climatology accumulation
# --------------------------------------------------------------------------
def init_dates(year_start: int, year_end: int, stride: int):
    """Every `stride`-th calendar day across [year_start, year_end] inclusive."""
    d = datetime(year_start, 1, 1, tzinfo=timezone.utc)
    end = datetime(year_end, 12, 31, tzinfo=timezone.utc)
    out = []
    while d <= end:
        out.append(d)
        d += timedelta(days=stride)
    return out


def smooth_doy(mean, smooth_days: int):
    """Circular running-mean over the doy axis (axis=1) ignoring NaNs."""
    if smooth_days <= 0:
        return mean
    n = mean.shape[1]
    win = 2 * smooth_days + 1
    # Pad circularly in doy, nan-mean over the sliding window.
    padded = np.concatenate([mean[:, -smooth_days:], mean,
                             mean[:, :smooth_days]], axis=1)
    out = np.full_like(mean, np.nan)
    for j in range(n):
        sl = padded[:, j:j + win]
        out[:, j] = np.nanmean(sl, axis=1)
    return out


def build(args):
    import xarray as xr

    obs_lat, obs_lon = obs_grid()
    ny, nx = obs_lat.size, obs_lon.size
    members = [m.strip() for m in args.members.split(",") if m.strip()]
    dates = init_dates(args.year_start, args.year_end, args.stride)
    log.info("Building GEFS ULWRF climatology: %d inits x %d members, "
             "leads 1..%d, stride %d d, smooth +-%d d",
             len(dates), len(members), MAX_LEAD, args.stride, args.smooth)

    # Accumulators keyed by valid-time day-of-year (1..366).
    n_doy = 366
    ssum = np.zeros((MAX_LEAD, n_doy, ny, nx), dtype=np.float64)
    scnt = np.zeros((MAX_LEAD, n_doy), dtype=np.int64)

    ckpt = Path(args.out).with_suffix(".ckpt.npz")
    start_idx = 0
    if args.resume and ckpt.exists():
        z = np.load(ckpt)
        if z["ssum"].shape == ssum.shape:
            ssum, scnt = z["ssum"], z["scnt"]
            start_idx = int(z["next_idx"])
            log.info("Resumed from checkpoint at init %d/%d", start_idx, len(dates))

    n_ok = 0
    for di in range(start_idx, len(dates)):
        d = dates[di]
        date_str = d.strftime("%Y%m%d")
        for member in members:
            da = _daily_means_for_init(date_str, member, obs_lat, obs_lon)
            if da is None:
                continue
            n_ok += 1
            vals = da.values  # (lead, lat, lon)
            for li in range(vals.shape[0]):
                lead = int(da.lead.values[li])      # 1-based
                valid = d + timedelta(days=lead - 1)
                doy = valid.timetuple().tm_yday      # 1..366
                ssum[lead - 1, doy - 1] += vals[li]
                scnt[lead - 1, doy - 1] += 1
        if (di + 1) % args.checkpoint_every == 0:
            np.savez(ckpt, ssum=ssum, scnt=scnt, next_idx=di + 1)
            log.info("  [%d/%d inits] %d successful init-members, checkpoint saved",
                     di + 1, len(dates), n_ok)

    log.info("Accumulation done: %d successful init-members", n_ok)
    if n_ok == 0:
        log.error("No data accumulated — aborting.")
        return 1

    # Mean per (lead, doy) cell; bins with no samples stay NaN, filled by
    # the circular doy smoothing from neighbouring days.
    with np.errstate(invalid="ignore"):
        mean = ssum / np.maximum(scnt, 1)[:, :, None, None]
    mean[scnt == 0] = np.nan
    mean = smooth_doy(mean, args.smooth)
    if np.isnan(mean).any():
        log.warning("Climatology still has %d NaN cells after smoothing; "
                    "filling with lead-mean.", int(np.isnan(mean).sum()))
        lead_mean = np.nanmean(mean, axis=1, keepdims=True)
        mean = np.where(np.isnan(mean), lead_mean, mean)

    climo = xr.DataArray(
        mean.astype(np.float32),
        dims=("lead", "doy", "lat", "lon"),
        coords={"lead": np.arange(1, MAX_LEAD + 1),
                "doy": np.arange(1, n_doy + 1),
                "lat": obs_lat, "lon": obs_lon},
        name="ulwrf_climo",
        attrs={
            "long_name": "GEFSv12 reforecast TOA ULWRF climatology",
            "units": "W m-2",
            "source": "noaa-gefs-retrospective GEFSv12 reforecast",
            "period": f"{args.year_start}-{args.year_end}",
            "members": ",".join(members),
            "stride_days": args.stride,
            "smooth_days": args.smooth,
            "max_lead_days": MAX_LEAD,
            "n_init_members": int(n_ok),
            "doy_convention": "valid-time day-of-year (1..366)",
            "grid": "regridded to CPC 2.5deg observed OLR grid",
        },
    )
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    enc = {"ulwrf_climo": {"zlib": True, "complevel": 4, "dtype": "float32"}}
    climo.to_netcdf(out_path, encoding=enc)
    log.info("Wrote %s (%.1f MB)", out_path,
             out_path.stat().st_size / 1e6)

    if args.upload_gcs:
        try:
            from google.cloud import storage
            client = storage.Client()
            blob = client.bucket(GCS_BUCKET).blob(f"{GCS_PREFIX}/{GCS_CLIMO_NAME}")
            blob.cache_control = "public, max-age=86400"
            blob.upload_from_filename(str(out_path))
            log.info("Uploaded to gs://%s/%s/%s",
                     GCS_BUCKET, GCS_PREFIX, GCS_CLIMO_NAME)
        except Exception as e:
            log.exception("GCS upload failed: %s", e)

    if ckpt.exists() and not args.keep_checkpoint:
        try:
            ckpt.unlink()
        except OSError:
            pass
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", default="cache/gefs_ulwrf_climo.nc",
                   help="output NetCDF path (default: cache/gefs_ulwrf_climo.nc)")
    p.add_argument("--year-start", type=int, default=2000)
    p.add_argument("--year-end", type=int, default=2019)
    p.add_argument("--stride", type=int, default=5,
                   help="sample every Nth calendar-day init (default 5)")
    p.add_argument("--members", default="c00",
                   help="comma list of reforecast members (default c00; "
                        "e.g. c00,p01,p02,p03,p04)")
    p.add_argument("--smooth", type=int, default=15,
                   help="circular doy smoothing half-window in days (default 15)")
    p.add_argument("--checkpoint-every", type=int, default=25,
                   help="save a resumable checkpoint every N inits (default 25)")
    p.add_argument("--resume", action="store_true",
                   help="resume from an existing .ckpt.npz next to --out")
    p.add_argument("--keep-checkpoint", action="store_true")
    p.add_argument("--upload-gcs", action="store_true",
                   help=f"upload to gs://{GCS_BUCKET}/{GCS_PREFIX}/{GCS_CLIMO_NAME}")
    args = p.parse_args()
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
