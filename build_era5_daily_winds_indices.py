"""Daily region-mean zonal winds (u200, u850) from the ERA5 archive.

Sibling of `build_era5_daily_shear_indices.py`. Reads the per-month
1° tiles from `gs://${GCS_IR_CACHE_BUCKET}/era5_daily_1deg/u200/` and
.../u850/, computes cos(lat)-weighted regional daily means, and emits
`indices_daily_winds.parquet` with one column per (region × variable).

Schema:
    date              str           YYYY-MM-DD
    {region}_u200     float32       m/s, cos(lat)-weighted region mean
    {region}_u850     float32       m/s, cos(lat)-weighted region mean

Coverage: 1991-01-01 through whatever the era5_daily_1deg manifest
contains. Bandwidth: ~30 MB total (36 years × 12 months × 2 fields
× ~140 KB tile). Wall time: ~4-5 min (twice the shear builder
because we fetch two field grids per month).

Both products come from the same per-(year, month) decode pass —
the builder fetches u200 + u850 tiles together so each month's grid
data is touched once.

Powers the Panel B Daily-mode view for u200 and u850 ERA5 variables
(parallel to the shear daily product), via the `/seasonal/daily/winds`
API endpoint.
"""
from __future__ import annotations

import gzip
import json
import logging
import os
import sys
from pathlib import Path

import numpy as np

log = logging.getLogger("era5_daily_winds_indices")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))
from build_oisst_history import REGIONS  # type: ignore  # noqa: E402

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
GCS_PREFIX = "era5_daily_1deg"
SEASONAL_PREFIX = "seasonal"
LOCAL_BASE = Path("era5_daily")

# Wind fields to compute. (display name, tile field name, level label).
# Tile path is era5_daily_1deg/{field}/{YYYY}_{MM}.bin.gz where field
# is e.g. "u200" — the daily-archive build script packs the level
# into the tile prefix, not a separate dim.
WIND_FIELDS = ["u200", "u850"]

LAT_N, LAT_S = 60.0, -60.0
LATS = np.arange(LAT_N, LAT_S - 0.5, -1.0)
LONS = np.arange(-180.0, 180.0, 1.0)
NY, NX = LATS.size, LONS.size
COS_LAT = np.cos(np.deg2rad(LATS))


_gcs_bucket = None
def _bucket():
    global _gcs_bucket
    if _gcs_bucket is None:
        from google.cloud import storage   # type: ignore
        _gcs_bucket = storage.Client().bucket(GCS_BUCKET)
    return _gcs_bucket


def fetch_manifest(local_only: bool) -> dict:
    if local_only:
        p = LOCAL_BASE / "manifest.json"
        return json.loads(p.read_text()) if p.exists() else {}
    blob = _bucket().blob(f"{GCS_PREFIX}/manifest.json")
    if not blob.exists():
        return {}
    return json.loads(blob.download_as_text())


def fetch_monthly_grid(field: str, year: int, month: int, manifest: dict,
                        local_only: bool) -> tuple[np.ndarray | None,
                                                   list[str] | None]:
    """Returns ((n_days, NY, NX) grid, valid_dates) or (None, None)."""
    tk = f"{field}/{year}_{month:02d}"
    meta = manifest.get("tiles", {}).get(tk)
    if not meta:
        return None, None
    if local_only:
        p = LOCAL_BASE / field / f"{year}_{month:02d}.bin.gz"
        if not p.exists():
            return None, None
        raw = gzip.decompress(p.read_bytes())
    else:
        blob = _bucket().blob(f"{GCS_PREFIX}/{field}/{year}_{month:02d}.bin.gz")
        if not blob.exists():
            return None, None
        raw = gzip.decompress(blob.download_as_bytes())
    u16 = np.frombuffer(raw, dtype=np.uint16)
    n_days = int(meta["n_days"])
    expected = n_days * NY * NX
    if u16.size != expected:
        log.warning("  %s: expected %d samples, got %d — skipping",
                    tk, expected, u16.size)
        return None, None
    rng = (meta["vmax"] - meta["vmin"]) / 65534.0
    arr = meta["vmin"] + u16.astype(np.float32) * rng
    arr[u16 == 0xFFFF] = np.nan
    valid_dates = meta.get("valid_dates")
    if not valid_dates or len(valid_dates) != n_days:
        from calendar import monthrange
        ndm = monthrange(year, month)[1]
        valid_dates = [f"{year:04d}-{month:02d}-{d:02d}"
                       for d in range(1, n_days + 1)]
    return arr.reshape(n_days, NY, NX), valid_dates


def region_daily_mean(daily_grid: np.ndarray,
                      box: tuple[float, float, float, float]) -> np.ndarray:
    """cos(lat)-weighted regional mean per day. (n_days,) float32; NaN
    where the region has no finite cells. Same math as the shear
    builder — duplicated to keep this script standalone."""
    lat_s, lat_n, lon_w, lon_e = box
    lw = lon_w - 360.0 if lon_w > 180.0 else lon_w
    le = lon_e - 360.0 if lon_e > 180.0 else lon_e
    lat_mask = (LATS >= lat_s) & (LATS <= lat_n)
    if lw <= le:
        lon_mask = (LONS >= lw) & (LONS <= le)
    else:
        lon_mask = (LONS >= lw) | (LONS <= le)
    sub = daily_grid[:, lat_mask][:, :, lon_mask]
    w = COS_LAT[lat_mask][None, :, None] * np.ones_like(sub)
    finite = np.isfinite(sub)
    w = np.where(finite, w, 0.0)
    s = np.where(finite, sub, 0.0)
    den = w.sum(axis=(1, 2))
    out = np.full(sub.shape[0], np.nan, dtype=np.float32)
    valid = den > 0
    out[valid] = (s.sum(axis=(1, 2))[valid] / den[valid])
    return out


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--local-only", action="store_true",
                    help="Read tiles from ./era5_daily/ instead of GCS")
    ap.add_argument("--year-min", type=int, default=1991)
    ap.add_argument("--year-max", type=int, default=None)
    ap.add_argument("--no-upload", action="store_true",
                    help="Skip the GCS upload step (local parquet only)")
    args = ap.parse_args()

    log.info("Loading manifest...")
    manifest = fetch_manifest(args.local_only)
    tile_keys = set(manifest.get("tiles", {}).keys())
    if not tile_keys:
        log.error("Manifest is empty — run build_era5_daily_archive.py first.")
        sys.exit(1)

    # Use u850 as the reference field to determine year coverage —
    # u200 and u850 are produced together by the daily-archive build,
    # so they have identical coverage.
    years = sorted({int(k.split("/")[1].split("_")[0])
                    for k in tile_keys if k.startswith("u850/")})
    years = [y for y in years if y >= args.year_min]
    if args.year_max is not None:
        years = [y for y in years if y <= args.year_max]
    if not years:
        log.error("No u850 tiles in manifest after filtering.")
        sys.exit(1)
    log.info("Archive covers years: %d..%d (%d years)",
             years[0], years[-1], len(years))

    region_names = list(REGIONS.keys())
    # One time-series collector per (region, wind-field) pair.
    all_dates: list[str] = []
    series: dict[tuple[str, str], list[float | None]] = {
        (r, f): [] for r in region_names for f in WIND_FIELDS
    }

    for year in years:
        log.info("== %d ==", year)
        for month in range(1, 13):
            month_dates = None
            month_grids: dict[str, np.ndarray] = {}
            for field in WIND_FIELDS:
                grid, dates = fetch_monthly_grid(field, year, month,
                                                  manifest, args.local_only)
                if grid is None:
                    month_grids = {}
                    break
                if month_dates is None:
                    month_dates = dates
                month_grids[field] = grid
            if not month_grids or month_dates is None:
                continue
            all_dates.extend(month_dates)
            for field in WIND_FIELDS:
                grid = month_grids[field]
                for region, box in REGIONS.items():
                    daily = region_daily_mean(grid, box)
                    for v in daily:
                        series[(region, field)].append(
                            None if not np.isfinite(v) else round(float(v), 4)
                        )
        log.info("  rows so far: %d", len(all_dates))

    if not all_dates:
        log.error("No daily rows produced — aborting.")
        sys.exit(1)

    # Sanity check column lengths.
    for (r, f), arr in series.items():
        if len(arr) != len(all_dates):
            log.error("Series (%s, %s): %d values vs %d dates — aborting.",
                      r, f, len(arr), len(all_dates))
            sys.exit(1)

    import pandas as pd
    cols: dict[str, list] = {"date": all_dates}
    for region in region_names:
        for field in WIND_FIELDS:
            cols[f"{region}_{field}"] = series[(region, field)]
    df = pd.DataFrame(cols)
    log.info("Built table: %d rows × %d cols", len(df), len(df.columns))
    log.info("  date span: %s .. %s", df["date"].iloc[0], df["date"].iloc[-1])

    out_local = REPO / "data" / "indices_daily_winds.parquet"
    out_local.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_local, compression="snappy", index=False)
    log.info("Wrote local parquet → %s (%.2f KB)", out_local,
             out_local.stat().st_size / 1024.0)

    if args.no_upload or args.local_only:
        log.info("Skipping GCS upload.")
        return
    if not GCS_BUCKET:
        log.warning("GCS_IR_CACHE_BUCKET not set — skipping upload.")
        return
    blob = _bucket().blob(f"{SEASONAL_PREFIX}/indices_daily_winds.parquet")
    blob.upload_from_filename(str(out_local),
                              content_type="application/octet-stream",
                              predefined_acl="publicRead")
    log.info("Uploaded → gs://%s/%s/indices_daily_winds.parquet (public-read)",
             GCS_BUCKET, SEASONAL_PREFIX)


if __name__ == "__main__":
    main()
