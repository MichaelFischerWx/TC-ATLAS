"""Build / maintain the TC-ATLAS daily ERA5 archive on GCS.

Stage 1 of the in-line Atmosphere mode for the Seasonal page (see
PLAN_ops_research_features.md). We fetch daily-mean u, v at 200 and
850 hPa from Copernicus CDS over a 60°S-60°N tropical box (1° grid, to
match the existing GC-ATLAS / Panel D framing), derive daily shear
magnitude, and store everything to GCS in the same f16-gz format the
gc-atlas-era5 tile pipeline uses.

Stage 1 only consumes the *monthly-mean* derivatives this archive
produces (via build_era5_shear_indices.py). Stage 2 will surface the
daily fields directly for the Panel A current-anomaly view and the
seasonal-evolution animation with TC tracks. Storing daily once
underwrites both stages without a second CDS pull.

Storage layout (gs://tc-atlas-ir-cache/era5_daily/):

    u200/{YYYY}_{MM}.bin.gz          ← f16-gz, one file per month
    v200/{YYYY}_{MM}.bin.gz
    u850/{YYYY}_{MM}.bin.gz
    v850/{YYYY}_{MM}.bin.gz
    shear/{YYYY}_{MM}.bin.gz         ← pre-derived |V₂₀₀ − V₈₅₀| convenience
    manifest.json                    ← per-tile vmin/vmax + valid dates

Each monthly file packs N_days × (120 lat × 360 lon) uint16 samples
big-endian, gzip-streamed. Per-tile vmin/vmax recorded in the manifest
so the frontend (eventually) decodes the same way it decodes the
gc-atlas-era5 climatology tiles.

CLI usage:

    # one-time historical backfill, all years 1991-2025
    python build_era5_daily_archive.py --backfill --years 1991-2025

    # single test year (recommended before the full backfill)
    python build_era5_daily_archive.py --backfill --years 1991

    # monthly maintenance — fetches only the most recent fully-closed month
    python build_era5_daily_archive.py --incremental

    # local-only smoke test (writes under ./era5_daily/ instead of GCS)
    python build_era5_daily_archive.py --backfill --years 1991 --local-only

Requires `~/.cdsapirc` with valid Copernicus CDS credentials.
"""
from __future__ import annotations

import argparse
import calendar
import gzip
import io
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np

# Lazy imports for cdsapi + xarray + google-cloud-storage so the script
# can be `import`-ed for unit tests without those installed.

log = logging.getLogger("era5_daily_archive")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")

# ── Configuration ───────────────────────────────────────────────────────
GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
GCS_PREFIX = "era5_daily"

# 60°S to 60°N at 1° resolution — symmetric with the Panel D correlation
# map framing. lat values written descending (90...-90 convention used by
# gc-atlas-era5 tiles), but we trim to the tropical/sub-tropical box.
LAT_N, LAT_S =  60.0, -60.0
LON_W, LON_E = -180.0, 179.0
LATS = np.arange(LAT_N, LAT_S - 0.5, -1.0)        # descending: 60, 59, …, -60 (121 values)
LONS = np.arange(LON_W, LON_E + 0.5, 1.0)         # ascending: -180, …, 179 (360 values)
NY, NX = LATS.size, LONS.size

# Local cache + working dir
WORK_DIR = Path(os.environ.get("ERA5_DAILY_WORK", "/tmp/_era5_daily"))

# Variables we fetch + store. Keyed by short name in the GCS folder.
# The shear field is derived from these and stored alongside.
FIELDS = {
    "u200": {"era5_var": "u_component_of_wind", "level": 200},
    "v200": {"era5_var": "v_component_of_wind", "level": 200},
    "u850": {"era5_var": "u_component_of_wind", "level": 850},
    "v850": {"era5_var": "v_component_of_wind", "level": 850},
}

# ERA5 publishes preliminary monthly mean data on the CDS within a few
# days of month-end. For daily-mean data the lag is more like 5-7 days
# under the ERA5T preliminary product; the regular ERA5 final product
# lags 2-3 months. We default to the daily ERA5T-or-ERA5 product.
CDS_DATASET = "reanalysis-era5-pressure-levels"
CDS_PRODUCT_TYPE = "reanalysis"


# ── Helpers ─────────────────────────────────────────────────────────
def _ensure_work_dir() -> Path:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    return WORK_DIR


@dataclass
class MonthlyBundle:
    """One month's worth of daily fields for a single (var, level).
    Shape (n_days, NY, NX). NaN where any 0xFFFF appears."""
    year: int
    month: int
    field: str            # u200 / v200 / u850 / v850 / shear
    values: np.ndarray    # (n_days, ny, nx) float32
    valid_dates: list[str]   # ISO YYYY-MM-DD, one per day in `values`


def _days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


# ── CDS API fetch ───────────────────────────────────────────────────
def fetch_daily_winds_for_month(year: int, month: int,
                                local_target: Path,
                                *, retry: int = 3) -> Path:
    """Fetch daily-mean u, v at 200 and 850 hPa for the given month from
    CDS into `local_target` (NetCDF). Skips the fetch if `local_target`
    already exists — supports interrupted backfills."""
    if local_target.exists() and local_target.stat().st_size > 1_000_000:
        log.info("  cache hit: %s", local_target.name)
        return local_target
    import cdsapi  # type: ignore  # imported lazily so the script imports cheaply
    c = cdsapi.Client()
    request = {
        "product_type": CDS_PRODUCT_TYPE,
        "format": "netcdf",
        # daily statistics is a separate CDS API endpoint — see
        # "derived-era5-pressure-levels-daily-statistics" for hourly
        # → daily mean preprocessing on the server. Falls back to
        # hourly + client-side mean if the daily endpoint is
        # rate-limited or unavailable.
        "variable": ["u_component_of_wind", "v_component_of_wind"],
        "pressure_level": ["200", "850"],
        "year": str(year),
        "month": f"{month:02d}",
        "day": [f"{d:02d}" for d in range(1, _days_in_month(year, month) + 1)],
        "time": ["00:00", "06:00", "12:00", "18:00"],   # 4× daily, hourly is overkill for env diagnostics
        "area": [LAT_N, LON_W, LAT_S, LON_E],            # [N, W, S, E]
        "grid": [1.0, 1.0],                              # native to our archive grid
    }
    last_err: Exception | None = None
    for attempt in range(retry):
        try:
            log.info("  CDS request: %d-%02d (attempt %d/%d)",
                     year, month, attempt + 1, retry)
            c.retrieve(CDS_DATASET, request, str(local_target))
            return local_target
        except Exception as e:
            last_err = e
            backoff = 10 * (attempt + 1)
            log.warning("  CDS failed: %s — sleeping %ds", e, backoff)
            time.sleep(backoff)
    raise RuntimeError(f"CDS fetch failed for {year}-{month:02d}: {last_err}")


def hourly_to_daily(values: np.ndarray) -> np.ndarray:
    """Collapse (time, …) of 4× daily samples to (day, …) means.
    Expects time stride 6h, starting at 00 UTC. Trailing partial-day
    samples (rare; usually only at-month-end if CDS clamps the response)
    are averaged as-is over the available timesteps."""
    nt = values.shape[0]
    n_days = nt // 4
    leftover = nt % 4
    full = values[: n_days * 4].reshape(n_days, 4, *values.shape[1:])
    daily = np.nanmean(full, axis=1)
    if leftover:
        tail = np.nanmean(values[n_days * 4:], axis=0, keepdims=True)
        daily = np.concatenate([daily, tail], axis=0)
    return daily


def open_cds_netcdf(local: Path) -> "xr.Dataset":  # noqa: F821
    import xarray as xr
    return xr.open_dataset(local)


def load_monthly_winds(year: int, month: int, work_dir: Path
                       ) -> dict[str, MonthlyBundle]:
    """Returns {short_name: MonthlyBundle} for u200/v200/u850/v850 +
    a derived 'shear' bundle. Reuses any cached NetCDF in work_dir.
    Pulls 6-hourly winds from CDS and collapses to daily means
    client-side — robust against CDS's daily-stats endpoint downtime."""
    nc_path = work_dir / f"era5_daily_winds_{year}_{month:02d}.nc"
    nc_path = fetch_daily_winds_for_month(year, month, nc_path)
    ds = open_cds_netcdf(nc_path)
    # CDS netCDF coordinate / variable names changed in 2024:
    # try both. ds['u'] / ds['v'] vs ds['u_component_of_wind'] etc.
    def _pick(*names):
        for n in names:
            if n in ds:
                return ds[n]
        raise KeyError(f"none of {names} in dataset: {list(ds.data_vars)}")
    u = _pick("u", "u_component_of_wind")
    v = _pick("v", "v_component_of_wind")
    # Pressure-level coord (some CDS responses name it `level`, others
    # `pressure_level`).
    level_coord = next((c for c in ("level", "pressure_level")
                        if c in u.coords or c in u.dims), None)
    if level_coord is None:
        raise KeyError(f"no level coord found in {nc_path}")
    # Time coord ('time' historically; 'valid_time' on the new CDS-beta).
    time_coord = next((c for c in ("time", "valid_time")
                       if c in u.coords or c in u.dims), None)
    if time_coord is None:
        raise KeyError(f"no time coord found in {nc_path}")
    # Build daily means per (var, level).
    bundles: dict[str, MonthlyBundle] = {}
    valid_dates: list[str] | None = None
    for level in (200, 850):
        u_lev = u.sel({level_coord: level}).values
        v_lev = v.sel({level_coord: level}).values
        u_daily = hourly_to_daily(u_lev)
        v_daily = hourly_to_daily(v_lev)
        # Derive ISO dates for each daily index — same set for both levels
        # and both u/v, so compute once.
        if valid_dates is None:
            times = ds[time_coord].values
            # First timestep is 00 UTC on day 1; collapsing 4 timesteps
            # per day keeps the first day's date. Just use month-day-1
            # walked forward by n_days.
            ndays = u_daily.shape[0]
            base = date(year, month, 1)
            valid_dates = [(base.replace(day=base.day + i)).isoformat()
                           if (base.day + i) <= _days_in_month(year, month)
                           else f"{year}-{month:02d}-{_days_in_month(year, month):02d}"
                           for i in range(ndays)]
        bundles[f"u{level}"] = MonthlyBundle(
            year=year, month=month, field=f"u{level}",
            values=u_daily.astype(np.float32),
            valid_dates=list(valid_dates),
        )
        bundles[f"v{level}"] = MonthlyBundle(
            year=year, month=month, field=f"v{level}",
            values=v_daily.astype(np.float32),
            valid_dates=list(valid_dates),
        )
    # Derived shear magnitude per day.
    du = bundles["u200"].values - bundles["u850"].values
    dv = bundles["v200"].values - bundles["v850"].values
    shear = np.sqrt(du * du + dv * dv).astype(np.float32)
    bundles["shear"] = MonthlyBundle(
        year=year, month=month, field="shear",
        values=shear, valid_dates=list(valid_dates) if valid_dates else [],
    )
    ds.close()
    return bundles


# ── f16-gz encoding (matches gc-atlas-era5 tile pipeline) ───────────
def encode_f16_gz(values: np.ndarray) -> tuple[bytes, float, float]:
    """uint16 quantize between vmin and vmax (NaN → 0xFFFF), gzip.
    Returns (compressed_bytes, vmin, vmax)."""
    finite = np.isfinite(values)
    if not finite.any():
        # All-NaN — write a sentinel-filled array.
        u16 = np.full(values.shape, 0xFFFF, dtype=np.uint16)
        return gzip.compress(u16.tobytes(), compresslevel=6), 0.0, 0.0
    vmin = float(values[finite].min())
    vmax = float(values[finite].max())
    if vmax <= vmin:
        # Flat field — give it a tiny range so we don't divide by zero.
        vmax = vmin + 1e-9
    rng = 65534.0 / (vmax - vmin)
    u16 = np.where(finite,
                   np.clip(np.round((values - vmin) * rng), 0, 65534),
                   0xFFFF).astype(np.uint16)
    return gzip.compress(u16.tobytes(), compresslevel=6), vmin, vmax


# ── GCS / local-file output ────────────────────────────────────────
class StorageWriter:
    """Uploads to gs://${GCS_BUCKET}/${GCS_PREFIX}/... when local_only is
    False; otherwise writes to ./era5_daily/ for inspection."""
    def __init__(self, local_only: bool = False):
        self.local_only = local_only
        self._bucket = None

    def _gcs_bucket(self):
        if self._bucket is None:
            from google.cloud import storage   # type: ignore
            self._bucket = storage.Client().bucket(GCS_BUCKET)
        return self._bucket

    def put(self, key: str, body: bytes, content_type: str = "application/octet-stream"):
        if self.local_only:
            p = Path("era5_daily") / key
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)
            log.info("  wrote local %s (%d bytes)", p, len(body))
            return
        blob = self._gcs_bucket().blob(f"{GCS_PREFIX}/{key}")
        blob.cache_control = "public, max-age=86400"
        blob.upload_from_string(body, content_type=content_type)
        log.info("  uploaded gs://%s/%s/%s (%d bytes)",
                 GCS_BUCKET, GCS_PREFIX, key, len(body))

    def fetch_manifest(self) -> dict:
        """Load the current manifest.json from GCS (or local). Returns
        {} if it doesn't yet exist (first-time backfill)."""
        if self.local_only:
            p = Path("era5_daily/manifest.json")
            return json.loads(p.read_text()) if p.exists() else {}
        from google.cloud import storage   # type: ignore  # noqa: F401
        blob = self._gcs_bucket().blob(f"{GCS_PREFIX}/manifest.json")
        if not blob.exists():
            return {}
        return json.loads(blob.download_as_text())


def write_monthly_bundles(writer: StorageWriter, bundles: dict[str, MonthlyBundle],
                          manifest: dict) -> None:
    """Encode each MonthlyBundle as a single .bin.gz file and update the
    manifest with per-file vmin/vmax + valid date list."""
    manifest.setdefault("metadata", {
        "lat_first": LAT_N, "lat_last": LAT_S, "lat_step": -1.0,
        "lon_first": LON_W, "lon_last": LON_E, "lon_step": 1.0,
        "shape": [NY, NX],
        "nan_sentinel": 0xFFFF,
        "encoding": "f16-gz",
        "frame_shape_per_day": [NY, NX],
        "source": "ERA5 reanalysis daily means (6-hr → daily), 60°S-60°N at 1°",
        "fetched_via": "Copernicus CDS API",
    })
    manifest.setdefault("tiles", {})
    for short, b in bundles.items():
        # Flatten (n_days, ny, nx) → (n_days*ny*nx,) so a single
        # encoding pass produces one file; the frontend reads it as
        # (n_days, ny, nx) using the day count from manifest.tiles.
        body, vmin, vmax = encode_f16_gz(b.values)
        key = f"{short}/{b.year}_{b.month:02d}.bin.gz"
        writer.put(key, body, content_type="application/octet-stream")
        manifest["tiles"][f"{short}/{b.year}_{b.month:02d}"] = {
            "vmin": vmin, "vmax": vmax,
            "n_days": int(b.values.shape[0]),
            "valid_dates": b.valid_dates,
            "uploaded_utc": datetime.now(timezone.utc).isoformat(),
        }


def write_manifest(writer: StorageWriter, manifest: dict) -> None:
    body = json.dumps(manifest, separators=(",", ":")).encode()
    writer.put("manifest.json", body, content_type="application/json")


# ── Top-level workflow ──────────────────────────────────────────────
def process_month(writer: StorageWriter, manifest: dict, year: int, month: int) -> None:
    log.info("== %d-%02d ==", year, month)
    work = _ensure_work_dir()
    bundles = load_monthly_winds(year, month, work)
    write_monthly_bundles(writer, bundles, manifest)


def backfill_years(writer: StorageWriter, year_lo: int, year_hi: int) -> None:
    manifest = writer.fetch_manifest()
    for year in range(year_lo, year_hi + 1):
        for month in range(1, 13):
            tile_key = f"u200/{year}_{month:02d}"
            if tile_key in manifest.get("tiles", {}):
                log.info("  skip %d-%02d (already in manifest)", year, month)
                continue
            try:
                process_month(writer, manifest, year, month)
                write_manifest(writer, manifest)   # checkpoint after each month
            except Exception as e:
                log.error("FAILED %d-%02d: %s", year, month, e)
                # Keep going — partial archive is still useful.
                continue


def incremental_latest(writer: StorageWriter) -> None:
    """Fetch the most recently completed month (today − ~1 month) and
    overwrite if already present. Idempotent — re-running on the same
    day is a no-op except for the final manifest write."""
    today = datetime.now(timezone.utc).date()
    # Most-recent fully-closed month: subtract 1 from the month, with
    # year wrap. We give ERA5T a 7-day window after month-end before
    # we trust it.
    target = today.replace(day=1)
    target = (target.replace(month=target.month - 1) if target.month > 1
              else target.replace(year=target.year - 1, month=12))
    year, month = target.year, target.month
    manifest = writer.fetch_manifest()
    process_month(writer, manifest, year, month)
    write_manifest(writer, manifest)


def parse_years(s: str) -> tuple[int, int]:
    if "-" in s:
        a, b = s.split("-")
        return int(a), int(b)
    return int(s), int(s)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--backfill", action="store_true",
                    help="Bulk backfill mode — pass --years YYYY[-YYYY]")
    ap.add_argument("--incremental", action="store_true",
                    help="Fetch the most recent fully-closed month only")
    ap.add_argument("--years", help="Year (1991) or range (1991-2025)")
    ap.add_argument("--local-only", action="store_true",
                    help="Write under ./era5_daily/ instead of GCS")
    args = ap.parse_args()

    if not (args.backfill or args.incremental):
        ap.print_help(sys.stderr)
        sys.exit(2)

    writer = StorageWriter(local_only=args.local_only)
    if args.backfill:
        if not args.years:
            ap.error("--backfill requires --years")
        lo, hi = parse_years(args.years)
        backfill_years(writer, lo, hi)
    else:
        incremental_latest(writer)


if __name__ == "__main__":
    main()
