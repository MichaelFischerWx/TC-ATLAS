"""Daily region-mean deep-layer shear indices from the ERA5 archive.

Companion to `build_era5_shear_indices.py` (which writes the MONTHLY
product `indices_monthly_era5_shear.json` that feeds Panel B's
monthly time-series view). This script writes the DAILY product
`indices_daily_shear.parquet` (one row per day, one column per region)
that feeds Panel B's Daily view — the same spaghetti / climatology
/ highlight-year layout as the SST Daily panel, just for shear.

Schema (matches the SST `indices_daily_full.parquet` convention):
    date              str           YYYY-MM-DD
    {region}_shear    float32       m/s, ⟨|V₂₀₀ − V₈₅₀|⟩ region cos(lat)-mean

One column per region in build_oisst_history.REGIONS (14 regions →
15 cols incl. date). Coverage: 1991-01-01 through whatever the
era5_daily_1deg manifest contains (currently 2026-05).

The full 36-year × 14-region table is ~165 KB compressed parquet —
cheap to upload to GCS and serve via the existing `/seasonal/daily`
machinery.

Source: gs://${GCS_IR_CACHE_BUCKET}/era5_daily_1deg/shear/{YYYY}_{MM}.bin.gz
       (00Z snapshot, 1° decimated from 0.25° native, ±60° lat).

Output:
    data/indices_daily_shear.parquet                 (local)
    gs://${GCS_IR_CACHE_BUCKET}/seasonal/indices_daily_shear.parquet
                                                       (production)

Wall time: ~2-3 minutes (36 years × 12 months × ~140 KB tile fetch +
decode + region-mean compute). Memory: bounded by one monthly tile
at a time (~1.5 MB per (n_days × 121 × 360 × float32)).
"""
from __future__ import annotations

import gzip
import io
import json
import logging
import os
import sys
from pathlib import Path

import numpy as np

log = logging.getLogger("era5_daily_shear_indices")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))
from build_oisst_history import REGIONS  # type: ignore  # noqa: E402

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
GCS_PREFIX = "era5_daily_1deg"
SEASONAL_PREFIX = "seasonal"
LOCAL_BASE = Path("era5_daily")

# Grid spec inherited from build_era5_daily_archive.py.
LAT_N, LAT_S = 60.0, -60.0
LATS = np.arange(LAT_N, LAT_S - 0.5, -1.0)
LONS = np.arange(-180.0, 180.0, 1.0)
NY, NX = LATS.size, LONS.size
COS_LAT = np.cos(np.deg2rad(LATS))


_gcs_bucket = None
def _bucket():
    """Lazy GCS client. Same auth pattern as build_era5_shear_indices."""
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


def fetch_monthly_shear(year: int, month: int, manifest: dict,
                        local_only: bool) -> tuple[np.ndarray | None,
                                                   list[str] | None]:
    """Returns ((n_days, NY, NX) grid, valid_dates[n_days]) or (None, None)
    when the tile isn't published yet. valid_dates ride along so the
    output parquet's `date` column is sourced from the manifest (the
    authoritative truth) rather than reconstructed via calendar math.
    """
    tk = f"shear/{year}_{month:02d}"
    meta = manifest.get("tiles", {}).get(tk)
    if not meta:
        return None, None
    if local_only:
        p = LOCAL_BASE / "shear" / f"{year}_{month:02d}.bin.gz"
        if not p.exists():
            return None, None
        raw = gzip.decompress(p.read_bytes())
    else:
        blob = _bucket().blob(f"{GCS_PREFIX}/shear/{year}_{month:02d}.bin.gz")
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
        # Manifest didn't carry per-day dates — reconstruct from
        # (year, month, day-of-month). Safe because n_days matches
        # the calendar month's day count by construction in
        # build_era5_daily_archive.
        from calendar import monthrange
        ndm = monthrange(year, month)[1]
        if n_days != ndm:
            log.warning("  %s: n_days=%d but calendar month has %d — "
                        "valid_dates unreliable", tk, n_days, ndm)
        valid_dates = [f"{year:04d}-{month:02d}-{d:02d}"
                       for d in range(1, n_days + 1)]
    return arr.reshape(n_days, NY, NX), valid_dates


def region_daily_mean(daily_grid: np.ndarray,
                      box: tuple[float, float, float, float]) -> np.ndarray:
    """cos(lat)-weighted regional mean per day. (n_days,) float32; NaN
    where the region has no finite cells for that day.

    Same math as build_era5_shear_indices.region_daily_mean — duplicated
    here to keep the two builders independent (the monthly builder
    aggregates the per-day means into monthly means, this one keeps
    the daily resolution).
    """
    lat_s, lat_n, lon_w, lon_e = box
    # REGIONS use 0..360 longitudes (NaN MDR east at 320..340, etc.);
    # the global grid is -180..180. Wrap as needed.
    lw = lon_w - 360.0 if lon_w > 180.0 else lon_w
    le = lon_e - 360.0 if lon_e > 180.0 else lon_e
    lat_mask = (LATS >= lat_s) & (LATS <= lat_n)
    if lw <= le:
        lon_mask = (LONS >= lw) & (LONS <= le)
    else:
        # Wraps the antimeridian (e.g., a hypothetical 350..10 region).
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
    ap.add_argument("--year-min", type=int, default=1991,
                    help="Earliest year to include (default %(default)s)")
    ap.add_argument("--year-max", type=int, default=None,
                    help="Latest year to include (default: full archive)")
    ap.add_argument("--no-upload", action="store_true",
                    help="Skip the GCS upload step (local parquet only)")
    args = ap.parse_args()

    log.info("Loading manifest...")
    manifest = fetch_manifest(args.local_only)
    tile_keys = set(manifest.get("tiles", {}).keys())
    if not tile_keys:
        log.error("Manifest is empty — run build_era5_daily_archive.py first.")
        sys.exit(1)

    years = sorted({int(k.split("/")[1].split("_")[0])
                    for k in tile_keys if k.startswith("shear/")})
    years = [y for y in years if y >= args.year_min]
    if args.year_max is not None:
        years = [y for y in years if y <= args.year_max]
    if not years:
        log.error("No shear tiles in manifest after filtering.")
        sys.exit(1)
    log.info("Archive covers years: %d..%d (%d years)",
             years[0], years[-1], len(years))

    region_names = list(REGIONS.keys())
    # Per-region time series collectors. We append per-month chunks
    # rather than allocate a single 36 × 366 × 14 array up front so
    # mid-month partial coverage (e.g., 2026-05 in progress) doesn't
    # leave trailing NaN rows.
    all_dates: list[str] = []
    region_series: dict[str, list[float | None]] = {
        r: [] for r in region_names
    }

    for year in years:
        log.info("== %d ==", year)
        for month in range(1, 13):
            grid, dates = fetch_monthly_shear(year, month, manifest,
                                              args.local_only)
            if grid is None:
                continue
            n_days = grid.shape[0]
            all_dates.extend(dates)
            for region, box in REGIONS.items():
                daily = region_daily_mean(grid, box)
                # NaN → None for parquet's pyarrow encoding (the column
                # stays a float; pyarrow handles None as NaN on the
                # write side, then the API serializes back to JSON null).
                for v in daily:
                    region_series[region].append(
                        None if not np.isfinite(v) else round(float(v), 4)
                    )
        log.info("  rows so far: %d", len(all_dates))

    if not all_dates:
        log.error("No daily rows produced — aborting.")
        sys.exit(1)

    # Sanity check: every region series should match the date list length.
    for r, arr in region_series.items():
        if len(arr) != len(all_dates):
            log.error("Region %s: %d values vs %d dates — column lengths "
                      "diverged; aborting.", r, len(arr), len(all_dates))
            sys.exit(1)

    # Materialize the DataFrame. Use pandas for the parquet write — same
    # pattern as build_oisst_history's daily-full table so the API's
    # _load_seasonal_daily_df-style reader works without changes.
    import pandas as pd
    cols: dict[str, list] = {"date": all_dates}
    for r in region_names:
        cols[f"{r}_shear"] = region_series[r]
    df = pd.DataFrame(cols)
    log.info("Built table: %d rows × %d cols", len(df), len(df.columns))
    log.info("  date span: %s .. %s", df["date"].iloc[0], df["date"].iloc[-1])

    out_local = REPO / "data" / "indices_daily_shear.parquet"
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

    blob = _bucket().blob(f"{SEASONAL_PREFIX}/indices_daily_shear.parquet")
    blob.upload_from_filename(str(out_local),
                              content_type="application/octet-stream",
                              predefined_acl="publicRead")
    log.info("Uploaded → gs://%s/%s/indices_daily_shear.parquet (public-read)",
             GCS_BUCKET, SEASONAL_PREFIX)


if __name__ == "__main__":
    main()
