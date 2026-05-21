"""Derive monthly region-mean shear indices from the daily ERA5 archive.

Reads the f16-gz daily-shear archive produced by
`build_era5_daily_archive.py` (gs://${GCS_IR_CACHE_BUCKET}/era5_daily/
shear/{YYYY}_{MM}.bin.gz) and computes ⟨|V₂₀₀ − V₈₅₀|⟩ averaged over
each TC-relevant region for every (year, month). This is the
*operational* mean-of-magnitudes shear (Jensen-corrected vs the
naive |⟨V₂₀₀⟩ − ⟨V₈₅₀⟩| computed from monthly-mean winds).

Output: `data/indices_monthly_era5_shear.json` — shape mirrors
`indices_monthly_era5.json` so Panel B's Atmosphere mode can read it
with the same byYear / climMean / climStd machinery as the SST side.

Stage 1 ships only this monthly product. Stage 2 will surface the
daily fields directly for the spatial-anomaly map + animation; this
script's output is the time-series companion to that work.

Bandwidth: ~30 MB total (35 years × 12 monthly tiles × ~50 KB each).
Wall time: ~2 minutes on a warm connection.
"""
from __future__ import annotations

import gzip
import io
import json
import logging
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import requests

log = logging.getLogger("era5_shear_indices")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))
from build_oisst_history import REGIONS  # type: ignore  # noqa: E402

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
# Pull from the NEW 00Z × 0.25°-source decimated 1° archive
# (era5_daily_1deg/, built by build_era5_daily_archive.py).
# The LEGACY era5_daily/ archive (4×-daily-mean) stopped at 2023/04,
# so reading from there silently dropped 2024+ from Panel B's monthly
# shear time series. The 00Z snapshot picks up the small Jensen-style
# bias the 4×-daily mean smoothed away (~3-7% lower shear magnitudes)
# but is internally consistent across the full 1991-2026 record.
ARCHIVE_BASE = f"https://storage.googleapis.com/{GCS_BUCKET}/era5_daily_1deg"
LOCAL_BASE   = Path("era5_daily")   # fallback for --local archives
# GCS path prefix for the manifest + per-month tile blobs. Kept as a
# constant so the GCS client reads use the same prefix as the HTTP one.
GCS_PREFIX   = "era5_daily_1deg"

CLIM_START = 1991
CLIM_END   = 2020
PER_YEAR_END_DEFAULT = 2025   # extended each year as new ERA5 data lands

# Grid spec inherited from build_era5_daily_archive.py — must stay in sync.
LAT_N, LAT_S = 60.0, -60.0
LATS = np.arange(LAT_N, LAT_S - 0.5, -1.0)
LONS = np.arange(-180.0, 180.0, 1.0)
NY, NX = LATS.size, LONS.size
COS_LAT = np.cos(np.deg2rad(LATS))


_gcs_bucket = None
def _bucket():
    """Lazy GCS client — authenticated reads work regardless of per-blob
    public ACL state, which matters because the daily-archive backfill
    races us when running concurrently."""
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
                        local_only: bool) -> np.ndarray | None:
    """Returns (n_days, NY, NX) float32 with NaN where invalid. None
    when the tile isn't published yet."""
    tk = f"shear/{year}_{month:02d}"
    meta = manifest.get("tiles", {}).get(tk)
    if not meta:
        return None
    if local_only:
        p = LOCAL_BASE / "shear" / f"{year}_{month:02d}.bin.gz"
        if not p.exists():
            return None
        raw = gzip.decompress(p.read_bytes())
    else:
        blob = _bucket().blob(f"{GCS_PREFIX}/shear/{year}_{month:02d}.bin.gz")
        if not blob.exists():
            return None
        raw = gzip.decompress(blob.download_as_bytes())
    u16 = np.frombuffer(raw, dtype=np.uint16)
    n_days = int(meta["n_days"])
    expected = n_days * NY * NX
    if u16.size != expected:
        log.warning("  %s: expected %d samples, got %d — skipping",
                    tk, expected, u16.size)
        return None
    rng = (meta["vmax"] - meta["vmin"]) / 65534.0
    arr = meta["vmin"] + u16.astype(np.float32) * rng
    arr[u16 == 0xFFFF] = np.nan
    return arr.reshape(n_days, NY, NX)


def region_daily_mean(daily_grid: np.ndarray,
                      box: tuple[float, float, float, float]) -> np.ndarray:
    """cos(lat)-weighted regional mean per day. Returns (n_days,)
    float32 with NaN where the region is all-missing for that day."""
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
                    help="Read from ./era5_daily/ instead of GCS")
    ap.add_argument("--year-max", type=int, default=PER_YEAR_END_DEFAULT,
                    help="Stop after this year (default %(default)s)")
    args = ap.parse_args()

    log.info("Loading manifest...")
    manifest = fetch_manifest(args.local_only)
    tile_keys = set(manifest.get("tiles", {}).keys())
    if not tile_keys:
        log.error("Manifest is empty — run build_era5_daily_archive.py first.")
        sys.exit(1)

    # Discover the actual year range available in the archive from the
    # shear/ tile keys.
    years = sorted({int(k.split("/")[1].split("_")[0])
                    for k in tile_keys if k.startswith("shear/")})
    years = [y for y in years if y <= args.year_max]
    if not years:
        log.error("No shear tiles in manifest.")
        sys.exit(1)
    log.info("Archive covers years: %d..%d", years[0], years[-1])

    out = {
        "metadata": {
            "source": "ERA5 daily 6-hour winds → daily shear → monthly mean of magnitudes",
            "clim_window": [CLIM_START, CLIM_END],
            "year_range": [years[0], years[-1]],
            "regions": list(REGIONS.keys()),
        },
        "regions": {r: list(box) for r, box in REGIONS.items()},
        "values": {},   # region_shear → [12] climo mean
        "std":    {},   # region_shear → [12] climo std (across-years std of monthly means)
        "by_year": {},  # year → region_shear → [12] monthly means
    }

    # Per-(year, month, region) monthly means accumulator.
    # Compute as we read each monthly tile to keep memory bounded.
    monthly_means: dict[tuple[int, int, str], float] = {}
    for year in years:
        log.info("== %d ==", year)
        for month in range(1, 13):
            grid = fetch_monthly_shear(year, month, manifest, args.local_only)
            if grid is None:
                continue
            # Compute regional daily means, then monthly mean.
            for region, box in REGIONS.items():
                daily = region_daily_mean(grid, box)
                if np.isfinite(daily).any():
                    m = float(np.nanmean(daily))
                    monthly_means[(year, month, region)] = round(m, 4)

    # Materialize by_year.
    for year in years:
        block = {}
        for region in REGIONS:
            row = [None] * 12
            for month in range(1, 13):
                v = monthly_means.get((year, month, region))
                if v is not None:
                    row[month - 1] = v
            block[f"{region}_shear"] = row
        out["by_year"][str(year)] = block

    # Climatology mean + across-years std for each calendar month.
    for region in REGIONS:
        means = [None] * 12
        stds  = [None] * 12
        for month in range(1, 13):
            vals = []
            for yy in range(CLIM_START, CLIM_END + 1):
                v = monthly_means.get((yy, month, region))
                if v is not None:
                    vals.append(v)
            if len(vals) >= 5:    # need at least 5 years for a defensible std
                arr = np.array(vals, dtype=np.float32)
                means[month - 1] = round(float(arr.mean()), 4)
                stds[month - 1]  = round(float(arr.std(ddof=1)), 4)
        out["values"][f"{region}_shear"] = means
        out["std"][f"{region}_shear"]    = stds

    out_path = REPO / "data" / "indices_monthly_era5_shear.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    log.info("Wrote %s (%d bytes)", out_path, out_path.stat().st_size)
    # Quick sanity log: MDR shear should be ~8-10 m/s in peak Atlantic season.
    mdr_clim = out["values"].get("atl_mdr_shear")
    if mdr_clim and mdr_clim[8] is not None:
        log.info("  atl_mdr_shear Sep climo: %.2f m/s "
                 "(operational range ~7-12 m/s for Atlantic MDR)", mdr_clim[8])


if __name__ == "__main__":
    main()
