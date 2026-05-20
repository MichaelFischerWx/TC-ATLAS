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

# Mercator clamp same as the OISST anomaly PNG.
WEB_MERC_LAT_MAX = 85.05112877980659


def _http_get(url: str) -> bytes | None:
    import requests
    r = requests.get(url, timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.content


def load_manifest(local_only: bool) -> dict:
    if local_only:
        p = Path("era5_daily/manifest.json")
        return json.loads(p.read_text()) if p.exists() else {}
    body = _http_get(f"https://storage.googleapis.com/{GCS_BUCKET}/{ARCHIVE_PREFIX}/manifest.json")
    return json.loads(body) if body else {}


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
        body = _http_get(f"https://storage.googleapis.com/{GCS_BUCKET}/"
                         f"{ARCHIVE_PREFIX}/shear/{year}_{month:02d}.bin.gz")
        if body is None:
            return None
        raw = gzip.decompress(body)
    u16 = np.frombuffer(raw, dtype=np.uint16)
    n_days = int(meta["n_days"])
    if u16.size != n_days * NY * NX:
        log.warning("  %s: shape mismatch — skip", tk)
        return None
    rng = (meta["vmax"] - meta["vmin"]) / 65534.0
    arr = meta["vmin"] + u16.astype(np.float32) * rng
    arr[u16 == 0xFFFF] = np.nan
    return arr.reshape(n_days, NY, NX)


# ── Mercator warp (matches build_subseasonal_overlays._warp_eq_to_mercator) ──
def warp_to_mercator(field: np.ndarray, ny_out: int | None = None) -> np.ndarray:
    """Re-sample a 60°S-60°N field onto a Web Mercator pixel grid bounded
    by ±WEB_MERC_LAT_MAX so it overlays cleanly on the Panel A image
    framing. We pad with NaN above/below the source range."""
    ny_in, nx = field.shape
    ny_out = ny_out or ny_in * 2
    # Source lats (descending 60 → -60).
    src_lats = LATS
    # Target lats — equispaced Mercator pixels.
    y_pix = np.linspace(0, 1, ny_out)
    target_lats = np.degrees(
        np.arctan(np.sinh((1 - 2 * y_pix) * np.pi)))
    # For each target row, snap to nearest source row by latitude.
    src_idx = np.zeros(ny_out, dtype=np.int32)
    out_of_range = np.zeros(ny_out, dtype=bool)
    for i, lat in enumerate(target_lats):
        if lat > LAT_N or lat < LAT_S:
            out_of_range[i] = True
            src_idx[i] = 0   # placeholder
        else:
            src_idx[i] = int(round(LAT_N - lat))
            src_idx[i] = max(0, min(ny_in - 1, src_idx[i]))
    out = field[src_idx]
    out[out_of_range] = np.nan
    return out


# ── PNG rendering ────────────────────────────────────────────────────
def render_shear_png(monthly_clim: np.ndarray, month: int) -> bytes:
    """Diverging-around-12 m/s palette: low shear (favorable) in cool
    blues, high shear (suppressive) in hot reds. Centerpoint at 12 m/s
    matches the operational TC-genesis "shear less than 12 m/s favorable"
    rule of thumb."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import TwoSlopeNorm

    warped = warp_to_mercator(monthly_clim, ny_out=monthly_clim.shape[0] * 4)
    fig, ax = plt.subplots(figsize=(16, 6), dpi=100)
    ax.axis("off")
    norm = TwoSlopeNorm(vmin=0, vcenter=12.0, vmax=30.0)
    ax.imshow(
        warped, cmap="RdYlBu_r", norm=norm,
        extent=[-180, 180, -WEB_MERC_LAT_MAX, WEB_MERC_LAT_MAX],
        origin="upper", interpolation="bilinear", aspect="auto",
    )
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, bbox_inches="tight",
                pad_inches=0)
    plt.close(fig)
    return buf.getvalue()


def render_grid_sidecar(monthly_clim: np.ndarray) -> bytes:
    """Hover-tooltip values at 1° lat × 1° lon. Same shape/orientation as
    the input climatology grid — frontend looks up by (lat, lon) → idx."""
    payload = {
        "lat_first": LAT_N, "lat_last": LAT_S, "lat_step": -1.0,
        "lon_first": -180.0, "lon_last": 179.0, "lon_step": 1.0,
        "shape": [NY, NX],
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
    log.info("  uploaded gs://%s/%s (%d bytes)", GCS_BUCKET, blob_path, len(body))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--local-only", action="store_true",
                    help="Read from ./era5_daily/, write to ./era5_climo/")
    ap.add_argument("--month", type=int, default=None,
                    help="Render only this calendar month (debug)")
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
            "lat_first": LAT_N, "lat_last": LAT_S,
            "lon_first": -180.0, "lon_last": 179.0,
            "centerpoint_m_per_s": 12.0,
            "source": "ERA5 daily 6-hr winds → daily |V₂₀₀ − V₈₅₀| → monthly mean → "
                      "1991-2020 climatological mean",
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
        if n_years < 5:
            log.warning("  month %02d: only %d years available — skipping", month, n_years)
            continue
        clim = np.where(count_field > 0, sum_field / np.maximum(count_field, 1), np.nan)

        # Render + upload.
        png_body = render_shear_png(clim, month)
        grid_body = render_grid_sidecar(clim)
        upload(f"{OUTPUT_PREFIX}/shear_{month:02d}.png", png_body, "image/png", args.local_only)
        upload(f"{OUTPUT_PREFIX}/shear_{month:02d}.grid.json", grid_body, "application/json", args.local_only)
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
