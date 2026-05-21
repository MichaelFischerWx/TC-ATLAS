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
# Default to the 00Z × 0.25° archive (project decision 2026-05-20, see
# project_era5_archive_00z memory). The legacy 4×-daily 1° archive
# remains at era5_daily/ for reference until the 00Z product validates.
GCS_PREFIX = os.environ.get("ERA5_DAILY_PREFIX", "era5_daily_00z")
# Companion prefix for the 1°-decimated mirror Panel C reads to keep
# browser memory ~ 60 MB at 365 frames/year. Same encoding, just every
# 4th cell averaged into a (121, 360) tile.
DECIMATED_PREFIX = "era5_daily_1deg"

# 60°S to 60°N. NATIVE grid is 0.25° (matches ERA5's native publication
# grid + SHIPS environmental shear product). The 1° decimated grid (121
# × 360, lat 60..−60, lon −180..179) is preserved for backward compat
# with Panel C's existing memory budget.
LAT_N, LAT_S =  60.0, -60.0
LON_W = -180.0
NATIVE_RES = 0.25
# Native 0.25° grid: lat 60..-60 inclusive (481 cells), lon -180..179.75
# inclusive (1440 cells — the cell at 180° is identified with -180°).
LATS_NATIVE = np.arange(LAT_N, LAT_S - NATIVE_RES * 0.5, -NATIVE_RES)   # 481 values
LONS_NATIVE = LON_W + NATIVE_RES * np.arange(1440)                     # -180..179.75
NY_NATIVE, NX_NATIVE = LATS_NATIVE.size, LONS_NATIVE.size
# 1° decimated grid for Panel C: lat 60..-60 (121 cells), lon -180..179 (360).
LATS_1DEG = np.arange(LAT_N, LAT_S - 0.5, -1.0)                          # 121 values
LONS_1DEG = LON_W + 1.0 * np.arange(360)                                 # -180..179
# Back-compat: legacy CDS area request uses [N, W, S, E] — give it the
# eastern edge that matches the native grid's last col.
LON_E = float(LONS_NATIVE[-1] + NATIVE_RES)                              # 180.0
NY_1DEG, NX_1DEG = LATS_1DEG.size, LONS_1DEG.size
# Back-compat aliases used by load_monthly_winds and downstream callers
# that don't care which grid they're on. Set at runtime from CLI flags.
LATS = LATS_NATIVE
LONS = LONS_NATIVE
NY, NX = NY_NATIVE, NX_NATIVE

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
        # 00Z analysis snapshot — preserves synoptic structure (no
        # diurnal smearing) and matches SHIPS environmental-shear
        # sampling. See project_era5_archive_00z memory note.
        "time": ["00:00"],
        "area": [LAT_N, LON_W, LAT_S, LON_E],            # [N, W, S, E]
        "grid": [NATIVE_RES, NATIVE_RES],                # 0.25° native
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
    """In 00Z snapshot mode (current), each CDS request returns one
    timestep per day already, so this is a near-identity. We still
    keep the function in the pipeline as a single hook in case we
    later switch back to multi-timestep snapshots or want to average
    a different sub-daily window. Validates `values` already has one
    sample per day; falls back to the 4× collapse path if not (so the
    legacy 4× build still works if invoked from an old workflow)."""
    nt = values.shape[0]
    # If samples-per-day looks like 1 (00Z only), straight passthrough.
    # CDS always returns timesteps in chronological order with one entry
    # per (day, time) combo, so nt == n_days for 00Z-only.
    if nt <= 31:
        return values
    # Legacy fallback: 4× daily means.
    n_days = nt // 4
    leftover = nt % 4
    full = values[: n_days * 4].reshape(n_days, 4, *values.shape[1:])
    daily = np.nanmean(full, axis=1)
    if leftover:
        tail = np.nanmean(values[n_days * 4:], axis=0, keepdims=True)
        daily = np.concatenate([daily, tail], axis=0)
    return daily


def decimate_to_1deg(values_native: np.ndarray) -> np.ndarray:
    """4×4 block-mean the (T, 481, 1440) native 0.25° array down to
    (T, 121, 360) 1°. Edge handling: the native grid is lat 60..-60
    at 0.25° (481 lats — 480 = 120×4, plus the lat 60 endpoint), and
    lon -180..179.75 (1440 = 360×4). We take cell (i, j) of the 1°
    output as the mean of native rows [4i .. 4i+3] (clipped to NY_NATIVE)
    and cols [4j .. 4j+3]. Row 120 (lat -60) reads the single native
    row 480 since 4×120+0 = 480 is the last index. NaN-aware mean."""
    n_t = values_native.shape[0]
    out = np.full((n_t, NY_1DEG, NX_1DEG), np.nan, dtype=np.float32)
    for i in range(NY_1DEG):
        r0 = min(4 * i,     NY_NATIVE - 1)
        r1 = min(4 * i + 4, NY_NATIVE)
        for j in range(NX_1DEG):
            c0 = 4 * j
            c1 = 4 * j + 4
            block = values_native[:, r0:r1, c0:c1]
            # nanmean over (lat-block, lon-block) → single value per t.
            with np.errstate(invalid='ignore'):
                out[:, i, j] = np.nanmean(block.reshape(n_t, -1), axis=1)
    return out


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
    """Uploads to gs://${GCS_BUCKET}/${prefix}/... when local_only is
    False; otherwise writes to ./{prefix}/ for inspection. `prefix` is
    parameterized so the same writer instance can target the native
    archive and the 1°-decimated mirror."""
    def __init__(self, local_only: bool = False, prefix: str = GCS_PREFIX):
        self.local_only = local_only
        self.prefix = prefix
        self._bucket = None

    def _gcs_bucket(self):
        if self._bucket is None:
            from google.cloud import storage   # type: ignore
            self._bucket = storage.Client().bucket(GCS_BUCKET)
        return self._bucket

    def put(self, key: str, body: bytes, content_type: str = "application/octet-stream"):
        if self.local_only:
            p = Path(self.prefix) / key
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)
            log.info("  wrote local %s (%d bytes)", p, len(body))
            return
        blob = self._gcs_bucket().blob(f"{self.prefix}/{key}")
        blob.cache_control = "public, max-age=86400"
        blob.upload_from_string(body, content_type=content_type)
        # Match the rest of tc-atlas-ir-cache: objects are publicly
        # readable so the static frontend can fetch them without auth.
        try:
            blob.make_public()
        except Exception as e:
            log.warning("  could not make %s public: %s", blob.name, e)
        log.info("  uploaded gs://%s/%s/%s (%d bytes)",
                 GCS_BUCKET, self.prefix, key, len(body))

    def fetch_manifest(self) -> dict:
        """Load the current manifest.json from GCS (or local). Returns
        {} if it doesn't yet exist (first-time backfill)."""
        if self.local_only:
            p = Path(self.prefix) / "manifest.json"
            return json.loads(p.read_text()) if p.exists() else {}
        from google.cloud import storage   # type: ignore  # noqa: F401
        blob = self._gcs_bucket().blob(f"{self.prefix}/manifest.json")
        if not blob.exists():
            return {}
        return json.loads(blob.download_as_text())


def write_monthly_bundles(writer: StorageWriter, bundles: dict[str, MonthlyBundle],
                          manifest: dict, *, grid: str = "native") -> None:
    """Encode each MonthlyBundle as a single .bin.gz file and update the
    manifest with per-file vmin/vmax + valid date list. `grid` is one of
    "native" (0.25°, 481×1440) or "1deg" (121×360); only used to fill
    the per-archive `metadata` block with the right shape on first
    write."""
    if grid == "native":
        meta = {
            "lat_first": LAT_N, "lat_last": LAT_S, "lat_step": -NATIVE_RES,
            "lon_first": LON_W, "lon_last": LON_E, "lon_step": NATIVE_RES,
            "shape": [NY_NATIVE, NX_NATIVE],
            "frame_shape_per_day": [NY_NATIVE, NX_NATIVE],
            "source": ("ERA5 reanalysis 00Z analysis snapshot, "
                       "60°S-60°N at 0.25° native"),
        }
    else:
        meta = {
            "lat_first": LAT_N, "lat_last": LAT_S, "lat_step": -1.0,
            "lon_first": LON_W, "lon_last": LON_E, "lon_step": 1.0,
            "shape": [NY_1DEG, NX_1DEG],
            "frame_shape_per_day": [NY_1DEG, NX_1DEG],
            "source": ("ERA5 reanalysis 00Z analysis snapshot, "
                       "60°S-60°N at 1° (4×4 block-mean decimation "
                       "from native 0.25°)"),
        }
    meta.update({
        "nan_sentinel": 0xFFFF,
        "encoding": "f16-gz",
        "fetched_via": "Copernicus CDS API",
    })
    manifest.setdefault("metadata", meta)
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
def process_month(writer_native: StorageWriter, writer_1deg: StorageWriter,
                  manifest_native: dict, manifest_1deg: dict,
                  year: int, month: int) -> None:
    log.info("== %d-%02d ==", year, month)
    work = _ensure_work_dir()
    bundles = load_monthly_winds(year, month, work)
    # Native 0.25° archive: upload directly.
    write_monthly_bundles(writer_native, bundles, manifest_native, grid="native")
    # 1°-decimated mirror for Panel C's browser memory budget. Build a
    # second set of bundles with block-mean values and the same valid
    # dates / field names.
    dec_bundles = {}
    for short, b in bundles.items():
        dec_values = decimate_to_1deg(b.values)
        dec_bundles[short] = MonthlyBundle(
            year=b.year, month=b.month, field=b.field,
            values=dec_values.astype(np.float32),
            valid_dates=list(b.valid_dates),
        )
    write_monthly_bundles(writer_1deg, dec_bundles, manifest_1deg, grid="1deg")


def backfill_years(writer_native: StorageWriter, writer_1deg: StorageWriter,
                   year_lo: int, year_hi: int) -> None:
    manifest_native = writer_native.fetch_manifest()
    manifest_1deg = writer_1deg.fetch_manifest()
    for year in range(year_lo, year_hi + 1):
        for month in range(1, 13):
            tile_key = f"u200/{year}_{month:02d}"
            have_native = tile_key in manifest_native.get("tiles", {})
            have_1deg   = tile_key in manifest_1deg.get("tiles", {})
            if have_native and have_1deg:
                log.info("  skip %d-%02d (already in both manifests)", year, month)
                continue
            try:
                process_month(writer_native, writer_1deg,
                              manifest_native, manifest_1deg, year, month)
                write_manifest(writer_native, manifest_native)
                write_manifest(writer_1deg, manifest_1deg)
            except Exception as e:
                log.error("FAILED %d-%02d: %s", year, month, e)
                continue


def incremental_latest(writer_native: StorageWriter,
                       writer_1deg: StorageWriter) -> None:
    """Fetch the most recently completed month (today − ~1 month) and
    overwrite if already present. Idempotent — re-running on the same
    day is a no-op except for the final manifest write."""
    today = datetime.now(timezone.utc).date()
    target = today.replace(day=1)
    target = (target.replace(month=target.month - 1) if target.month > 1
              else target.replace(year=target.year - 1, month=12))
    year, month = target.year, target.month
    manifest_native = writer_native.fetch_manifest()
    manifest_1deg = writer_1deg.fetch_manifest()
    process_month(writer_native, writer_1deg,
                  manifest_native, manifest_1deg, year, month)
    write_manifest(writer_native, manifest_native)
    write_manifest(writer_1deg, manifest_1deg)


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

    writer_native = StorageWriter(local_only=args.local_only, prefix=GCS_PREFIX)
    writer_1deg   = StorageWriter(local_only=args.local_only, prefix=DECIMATED_PREFIX)
    if args.backfill:
        if not args.years:
            ap.error("--backfill requires --years")
        lo, hi = parse_years(args.years)
        backfill_years(writer_native, writer_1deg, lo, hi)
    else:
        incremental_latest(writer_native, writer_1deg)


if __name__ == "__main__":
    main()
