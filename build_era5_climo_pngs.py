"""Render ERA5 climatological-mean shear maps (1991-2020) as PNGs +
hover sidecars for Panel A's "Atmosphere" mode on the Seasonal page.

Consumes the daily archive produced by `build_era5_daily_archive.py`
(NOT CDS directly — separation of concerns). For each calendar month
1..12, computes the 1991-2020 mean of ⟨|V₂₀₀ − V₈₅₀|⟩ at each (lat,
lon) grid cell, renders a Mercator-warped PNG (matches Panel A's
existing image-overlay framing), and writes a small .grid.json hover
sidecar at 1° resolution.

Outputs uploaded to:
    gs://${GCS_IR_CACHE_BUCKET}/era5_climo/
        shear_{MM}.png         ← Mercator-warped, 60°S-60°N
        shear_{MM}.grid.json   ← hover values, 1° lat × 1° lon
        manifest.json          ← lists which months are populated

Stage 1 ships *climatology only*. Stage 2 will add a sibling cron that
reads the env-overlay shear MTD parquet, computes the trailing-30-day
anomaly = current − climo, and writes shear_anom_latest.png — same
hover-sidecar plumbing.

Run after `build_era5_daily_archive.py` finishes its backfill.
Re-runnable any time the daily archive grows.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import logging
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

log = logging.getLogger("era5_climo_pngs")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))
from build_oisst_history import REGIONS  # type: ignore  # noqa: E402

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
ARCHIVE_PREFIX = "era5_daily"
OUTPUT_PREFIX  = "era5_climo"

# Grid spec — must match build_era5_daily_archive.py.
LAT_N, LAT_S = 60.0, -60.0
LATS = np.arange(LAT_N, LAT_S - 0.5, -1.0)
LONS = np.arange(-180.0, 180.0, 1.0)
NY, NX = LATS.size, LONS.size
COS_LAT = np.cos(np.deg2rad(LATS))

CLIM_START = 1991
CLIM_END   = 2020

# Shear PNGs use the same Pacific-centered lon framing as the OISST
# anomaly PNG (LON_MIN=100, LON_MAX=360 in build_oisst_history.py) so
# Panel A's basin-zoom presets crop correctly. Lat-extent likewise
# matches OISST's ±60° box rather than Mercator-clamped, since this
# panel uses an equirectangular (not Mercator) overlay aspect.
PNG_LAT_MIN, PNG_LAT_MAX = -60.0, 60.0
PNG_LON_MIN, PNG_LON_MAX = 100.0, 360.0
PNG_VMAX_SHEAR = 30.0   # m/s color saturation upper bound
PNG_VCENTER_SHEAR = 12.0  # operational TC-genesis threshold


def _http_get(url: str) -> bytes | None:
    import requests
    r = requests.get(url, timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.content


_gcs_bucket = None
def _bucket():
    global _gcs_bucket
    if _gcs_bucket is None:
        from google.cloud import storage   # type: ignore
        _gcs_bucket = storage.Client().bucket(GCS_BUCKET)
    return _gcs_bucket


def load_manifest(local_only: bool) -> dict:
    if local_only:
        p = Path("era5_daily/manifest.json")
        return json.loads(p.read_text()) if p.exists() else {}
    blob = _bucket().blob(f"{ARCHIVE_PREFIX}/manifest.json")
    if not blob.exists():
        return {}
    return json.loads(blob.download_as_text())


def fetch_monthly_shear(year: int, month: int, manifest: dict, local_only: bool
                        ) -> np.ndarray | None:
    """Daily-resolved shear field for (year, month) → (n_days, NY, NX)."""
    tk = f"shear/{year}_{month:02d}"
    meta = manifest.get("tiles", {}).get(tk)
    if not meta:
        return None
    if local_only:
        p = Path("era5_daily/shear") / f"{year}_{month:02d}.bin.gz"
        if not p.exists():
            return None
        raw = gzip.decompress(p.read_bytes())
    else:
        blob = _bucket().blob(f"{ARCHIVE_PREFIX}/shear/{year}_{month:02d}.bin.gz")
        if not blob.exists():
            return None
        raw = gzip.decompress(blob.download_as_bytes())
    u16 = np.frombuffer(raw, dtype=np.uint16)
    n_days = int(meta["n_days"])
    if u16.size != n_days * NY * NX:
        log.warning("  %s: shape mismatch — skip", tk)
        return None
    rng = (meta["vmax"] - meta["vmin"]) / 65534.0
    arr = meta["vmin"] + u16.astype(np.float32) * rng
    arr[u16 == 0xFFFF] = np.nan
    return arr.reshape(n_days, NY, NX)


# ── PNG rendering ────────────────────────────────────────────────────
def _roll_to_pacific_centered(field: np.ndarray) -> np.ndarray:
    """Source `field` columns are at lons -180..179 (Atlantic-centered).
    Roll so column 0 → lon 100 (Pacific-centered, matches OISST PNG).
    Column 0 in the rolled array corresponds to lon = -180 + 280 = 100;
    column 359 corresponds to lon = 459 ≡ 99°. So extent=[100, 460]."""
    return np.roll(field, -280, axis=-1)


def render_shear_png(monthly_clim: np.ndarray, month: int) -> bytes:
    """Equirectangular shear-climatology PNG with cartopy coastlines.
    Diverging colormap centered at 12 m/s — operational TC-genesis
    "shear ≲ 12 m/s favorable" threshold. Pacific-centered framing
    matches the OISST anomaly PNG so Panel A's basin-zoom presets
    crop both kinds of maps consistently."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import TwoSlopeNorm
    import cartopy.crs as ccrs
    import cartopy.feature as cfeature

    # Pacific-centered rotation.
    field = _roll_to_pacific_centered(monthly_clim)

    # Equirectangular projection on a Pacific-centered globe so
    # cartopy lines up coastlines correctly with the lon 100..460 frame.
    fig = plt.figure(figsize=(8.0, 8.0 * 120 / 260), dpi=200)
    ax = fig.add_subplot(1, 1, 1,
                         projection=ccrs.PlateCarree(central_longitude=180))
    ax.set_extent([PNG_LON_MIN, PNG_LON_MAX, PNG_LAT_MIN, PNG_LAT_MAX],
                  crs=ccrs.PlateCarree())
    norm = TwoSlopeNorm(vmin=0, vcenter=PNG_VCENTER_SHEAR, vmax=PNG_VMAX_SHEAR)
    # `field` is the rolled array: column 0 → lon 100°, column 359 →
    # lon 459°. So imshow extent must span 100..460 (not 100..360!) so
    # the 360 cells cover a full 360° of longitude. The axis is then
    # cropped to set_extent([100, 360]) — same range, just naming the
    # visible window.
    ax.imshow(
        field,
        cmap="RdYlBu_r", norm=norm,
        extent=[PNG_LON_MIN, PNG_LON_MAX + 100.0, PNG_LAT_MIN, PNG_LAT_MAX],
        origin="upper", interpolation="bilinear",
        transform=ccrs.PlateCarree(),
        zorder=1,
    )
    # Continents fill + coastlines + borders — enough visual weight to
    # see where you are against the diverging shear palette. Light gray
    # land fill at low alpha avoids smothering coastal shear features.
    ax.add_feature(cfeature.LAND, facecolor="#9ca3af", alpha=0.18,
                   zorder=2)
    ax.add_feature(cfeature.COASTLINE, linewidth=0.8, edgecolor="#0f172a",
                   zorder=3)
    ax.add_feature(cfeature.BORDERS, linewidth=0.3, edgecolor="#475569",
                   linestyle=":", zorder=3)
    ax.set_axis_off()
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, pad_inches=0,
                bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


def render_grid_sidecar(monthly_clim: np.ndarray) -> bytes:
    """Hover-tooltip values at 1° lat × 1° lon, matching the SST
    sidecar format (build_seasonal_diagnostics.render_anomaly_png) so
    Panel A's existing hover machinery (_wireAnomHover) can read this
    grid with the same lat_min/lat_max/lon_min/lon_max/n_lat/n_lon
    convention.

    Orientation: south-to-north (values[0] = lat_min). West-to-east
    in the Pacific-centered frame (values[i][0] = lon 100°E).
    Cropped to the visible 100°-360°E PNG window (cols 0..260 of
    the rolled array).
    """
    rolled = _roll_to_pacific_centered(monthly_clim)          # (121, 360), N→S, lon 100..459
    visible = rolled[:, : int(PNG_LON_MAX - PNG_LON_MIN) + 1]  # cols 0..260, lons 100..360
    south_to_north = visible[::-1, :]                          # flip lat so row 0 = -60
    n_lat, n_lon = south_to_north.shape
    payload = {
        "lat_min": PNG_LAT_MIN, "lat_max": PNG_LAT_MAX,
        "lon_min": PNG_LON_MIN, "lon_max": PNG_LON_MAX,
        "cell_size_deg": 1.0,
        "n_lat": int(n_lat), "n_lon": int(n_lon),
        "units": "m s-1",
        "values": [
            [round(float(v), 3) if np.isfinite(v) else None for v in row]
            for row in south_to_north
        ],
    }
    return json.dumps(payload, separators=(",", ":")).encode()


def render_global_grid_sidecar(monthly_clim: np.ndarray) -> bytes:
    """Global 360-col climatology grid (lon -180..179), matching the
    daily-archive tile layout exactly. Panel C's anomaly-mode renderer
    subtracts this from the per-year monthly mean, so we want full lon
    coverage (no Pacific-centered cropping).

    Orientation: north-to-south (values[0] = lat_max = +60), to match
    the daily-tile and EVO_LATS frame so Panel C's _evoLoadClimoForMonth
    can index without flipping rows. West-to-east lon -180..179.
    """
    n_lat, n_lon = monthly_clim.shape    # already (121, 360), N→S, lon -180..179
    payload = {
        "lat_min": PNG_LAT_MIN, "lat_max": PNG_LAT_MAX,
        "lon_min": -180.0,      "lon_max": 179.0,
        "cell_size_deg": 1.0,
        "n_lat": int(n_lat), "n_lon": int(n_lon),
        "lat_first": PNG_LAT_MAX, "lat_last": PNG_LAT_MIN,    # explicit N→S
        "lon_first": -180.0,      "lon_last":  179.0,
        "units": "m s-1",
        "values": [
            [round(float(v), 3) if np.isfinite(v) else None for v in row]
            for row in monthly_clim
        ],
    }
    return json.dumps(payload, separators=(",", ":")).encode()


# ── Top-level workflow ───────────────────────────────────────────────
def upload(blob_path: str, body: bytes, content_type: str, local_only: bool) -> None:
    if local_only:
        p = Path("era5_climo") / blob_path.split("/", 1)[1]
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body)
        log.info("  wrote local %s (%d bytes)", p, len(body))
        return
    from google.cloud import storage
    bucket = storage.Client().bucket(GCS_BUCKET)
    blob = bucket.blob(blob_path)
    blob.cache_control = "public, max-age=86400"
    blob.upload_from_string(body, content_type=content_type)
    try:
        blob.make_public()
    except Exception as e:
        log.warning("  could not make %s public: %s", blob.name, e)
    log.info("  uploaded gs://%s/%s (%d bytes)", GCS_BUCKET, blob_path, len(body))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--local-only", action="store_true",
                    help="Read from ./era5_daily/, write to ./era5_climo/")
    ap.add_argument("--month", type=int, default=None,
                    help="Render only this calendar month (debug)")
    ap.add_argument("--min-years", type=int, default=5,
                    help="Minimum n_years to render a calendar month "
                         "(default 5; lower this during backfill for "
                         "early-preview maps with the right spatial "
                         "pattern but noisy magnitudes)")
    args = ap.parse_args()

    manifest = load_manifest(args.local_only)
    if not manifest:
        log.error("Daily archive manifest empty — run build_era5_daily_archive.py first.")
        sys.exit(1)

    # Which months are we rendering? Either a single one (debug) or all 12.
    target_months = [args.month] if args.month else list(range(1, 13))
    output_manifest = {
        "metadata": {
            "clim_window": [CLIM_START, CLIM_END],
            "shape": [NY, NX],
            "lat_first": PNG_LAT_MAX, "lat_last": PNG_LAT_MIN,
            "lon_first": PNG_LON_MIN, "lon_last": PNG_LON_MAX,
            "source": "ERA5 daily 6-hr winds → daily |V₂₀₀ − V₈₅₀| → monthly mean → "
                      "1991-2020 climatological mean",
            # Colorbar spec consumed by the frontend so Panel A's legend
            # gradient + tick labels swap automatically in Atmosphere mode.
            "colorbar": {
                "label": "Deep-layer shear (m/s)",
                "vmin": 0.0,
                "vcenter": PNG_VCENTER_SHEAR,
                "vmax": PNG_VMAX_SHEAR,
                "units": "m/s",
                "stops": ["#313695", "#74add1", "#fed98e", "#f46d43", "#a50026"],
                "stop_positions": [0.0, 0.4, 0.5, 0.7, 1.0],
            },
        },
        "months_rendered": [],
        "region_means": {},
    }

    for month in target_months:
        log.info("== Climo month %02d ==", month)
        # Accumulate sum + count per cell across the 1991-2020 years.
        n_years = 0
        sum_field = np.zeros((NY, NX), dtype=np.float64)
        count_field = np.zeros((NY, NX), dtype=np.int32)
        for year in range(CLIM_START, CLIM_END + 1):
            grid = fetch_monthly_shear(year, month, manifest, args.local_only)
            if grid is None:
                continue
            # Monthly mean of daily shear at each cell.
            mm = np.nanmean(grid, axis=0)
            mask = np.isfinite(mm)
            sum_field[mask] += mm[mask]
            count_field[mask] += 1
            n_years += 1
        if n_years < args.min_years:
            log.warning("  month %02d: only %d years available — skipping "
                        "(below --min-years=%d)",
                        month, n_years, args.min_years)
            continue
        # Record n_years in the per-month entry of the output manifest so
        # the frontend can label preview-quality maps honestly.
        output_manifest.setdefault("n_years_per_month", {})[str(month)] = n_years
        clim = np.where(count_field > 0, sum_field / np.maximum(count_field, 1), np.nan)

        # Render + upload.
        png_body = render_shear_png(clim, month)
        grid_body = render_grid_sidecar(clim)
        global_grid_body = render_global_grid_sidecar(clim)
        upload(f"{OUTPUT_PREFIX}/shear_{month:02d}.png", png_body, "image/png", args.local_only)
        upload(f"{OUTPUT_PREFIX}/shear_{month:02d}.grid.json", grid_body, "application/json", args.local_only)
        upload(f"{OUTPUT_PREFIX}/shear_{month:02d}.global.grid.json", global_grid_body, "application/json", args.local_only)
        output_manifest["months_rendered"].append(month)

        # Caption-helper region means.
        for region, box in REGIONS.items():
            from build_era5_shear_indices import region_daily_mean
            # region_daily_mean expects (n_days, ny, nx); reuse by reshaping.
            rmean = region_daily_mean(clim[None, :, :], box)[0]
            output_manifest["region_means"].setdefault(region, [None] * 12)[month - 1] = (
                None if not np.isfinite(rmean) else round(float(rmean), 3))
        log.info("  month %02d: rendered + uploaded (n_years=%d)", month, n_years)

    upload(f"{OUTPUT_PREFIX}/manifest.json",
           json.dumps(output_manifest, separators=(",", ":")).encode(),
           "application/json", args.local_only)
    log.info("Climo PNG manifest published.")


if __name__ == "__main__":
    main()
