"""
mw_ingest.py — NRT passive-microwave swath ingestion for TC-ATLAS
=================================================================
Pulls new microwave granules from NASA PPS (and later JAXA G-Portal,
NOAA CLASS) and produces Web Mercator PNG overlays + GeoJSON footprints
in GCS for display on the RT Monitor / Global Archive map.

Phase 1 scope: GMI (PPS NRT) → global "microwave passes (last N hrs)"
overlay layer. Storm-linkage is Phase 3 (separate pass, this script
already writes the raw artifacts it needs).

Pipeline per granule
--------------------
1. Download .HDF5 (PPS) or .nc (TC-PRIMED) to a tempfile
2. Adapt to TC-PRIMED-style (ds_bt, ds_geo) so microwave_api renderers
   can be reused 1:1
3. Render 37-color RGB and 89H PCT as regridded arrays
4. Warp each from equirect-bbox to Mercator pixel space (so Leaflet's
   L.imageOverlay places it correctly on a Mercator basemap — see
   feedback_env_overlay_projection memory)
5. Encode as RGBA PNG with NaN → fully transparent
6. Compute footprint polygon from valid-pixel mask → GeoJSON
7. Upload to gs://{MW_BUCKET}/{sensor}/{YYYY}/{MM}/{DD}/{orbit_id}.{png,geojson}
8. Append entry to gs://{MW_BUCKET}/manifest_latest_48h.json (self-pruning)

Usage
-----
Test render+upload against an existing TC-PRIMED file (no PPS auth needed):

    GCS_MW_BUCKET=tc-atlas-microwave-nrt \\
        python mw_ingest.py --tcprimed-file path/to/TCPRIMED_*.nc \\
                            --sensor GMI --products 37color,89pct

Live PPS poll (after PPS_USER/PPS_PASS set):

    GCS_MW_BUCKET=tc-atlas-microwave-nrt \\
    PPS_USER=user@example.com PPS_PASS=user@example.com \\
        python mw_ingest.py --sensor GMI --since-hours 6

Environment
-----------
    GCS_MW_BUCKET   target GCS bucket (default: tc-atlas-microwave-nrt)
    PPS_USER        NASA PPS NRT email/username (basic auth username)
    PPS_PASS        NASA PPS NRT password (same as email per PPS convention)

Dependencies (all already in TC-ATLAS deployment)
    xarray, h5netcdf, numpy, scipy, matplotlib, pillow, google-cloud-storage,
    requests, shapely
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import os
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime as _dt, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional, Tuple

import numpy as np

# Reuse proven rendering helpers from the existing microwave API.
# These are sensor-agnostic: they take (ds_bt, ds_geo, sensor) where ds_bt
# has TB_{freq}{pol} variables and ds_geo has latitude/longitude. The
# PPS reader below produces datasets in that shape so 100% of the math
# is shared with the TC-PRIMED archive path.
from microwave_api import (
    _compute_37color_swath,
    _compute_89pct_swath,
    _nrl_89ghz_cmap,
)

logger = logging.getLogger("mw_ingest")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MW_BUCKET = os.environ.get("GCS_MW_BUCKET", "tc-atlas-microwave-nrt")
PPS_USER = os.environ.get("PPS_USER", "")
PPS_PASS = os.environ.get("PPS_PASS", "")
PPS_BASE = "https://jsimpsonhttps.pps.eosdis.nasa.gov"
MANIFEST_KEY = "manifest_latest_48h.json"
MANIFEST_RETENTION_HOURS = 48

WEB_MERC_LAT_MAX = 85.05112877980659  # arctan(sinh(pi)) * 180/pi


# ---------------------------------------------------------------------------
# GCS helpers
# ---------------------------------------------------------------------------
_storage_client = None
_bucket = None


def _get_bucket():
    global _storage_client, _bucket
    if _bucket is not None:
        return _bucket
    from google.cloud import storage
    _storage_client = storage.Client()
    _bucket = _storage_client.bucket(MW_BUCKET)
    return _bucket


def _upload_bytes(key: str, data: bytes, content_type: str,
                  cache_seconds: int = 600) -> None:
    blob = _get_bucket().blob(key)
    blob.cache_control = f"public, max-age={cache_seconds}"
    blob.upload_from_string(data, content_type=content_type)
    logger.info("uploaded gs://%s/%s (%d bytes)", MW_BUCKET, key, len(data))


def _download_text(key: str) -> Optional[str]:
    blob = _get_bucket().blob(key)
    if not blob.exists():
        return None
    return blob.download_as_text()


# ---------------------------------------------------------------------------
# Mercator warp for a bbox-local equirect array
# ---------------------------------------------------------------------------
def _warp_eq_to_mercator_bbox(field: np.ndarray,
                              lat_min: float, lat_max: float,
                              ny_out: Optional[int] = None) -> np.ndarray:
    """Re-sample a bbox-local equirectangular field (rows uniform in lat,
    top row = lat_max, bottom row = lat_min) onto a Mercator pixel grid
    spanning the same lat range but uniform in Mercator y.

    Generalizes build_env_overlays._warp_eq_to_mercator (which assumed
    a global lat range of ±MAX_LAT) to an arbitrary lat bbox — needed
    because each microwave orbit covers only a regional patch.

    Why we warp: Leaflet's L.imageOverlay stretches the image linearly
    in screen pixels between the two lat corners; on a Mercator basemap
    that linear stretch is only correct if the source pixels are spaced
    uniformly in Mercator y, not in lat. Skipping the warp produces a
    vertical offset that grows with |lat| (see feedback_env_overlay_projection).
    """
    ny_in, nx_in = field.shape[:2]
    if ny_out is None:
        ny_out = ny_in
    # Clamp lat range to Mercator-valid window.
    lat_top = min(lat_max, WEB_MERC_LAT_MAX)
    lat_bot = max(lat_min, -WEB_MERC_LAT_MAX)

    def _mercy(lat_deg: float) -> float:
        return np.log(np.tan(np.pi / 4 + np.radians(lat_deg) / 2))

    my_top = _mercy(lat_top)
    my_bot = _mercy(lat_bot)
    rows_out = np.arange(ny_out, dtype=np.float64)
    # Linear in Mercator y from my_top (row 0) → my_bot (row ny_out-1).
    merc_y = my_top - (rows_out + 0.5) / ny_out * (my_top - my_bot)
    lats = np.degrees(np.arctan(np.sinh(merc_y)))
    # Source row = fractional position in [lat_min..lat_max], top→bottom.
    src_rows = np.clip(
        np.round((lat_max - lats) / (lat_max - lat_min) * (ny_in - 1)).astype(int),
        0, ny_in - 1,
    )
    return field[src_rows, ...].copy()


# ---------------------------------------------------------------------------
# PNG encoding — RGB or scalar, NaN → fully transparent
# ---------------------------------------------------------------------------
def _encode_rgb_png(rgb: np.ndarray, valid_mask: np.ndarray) -> bytes:
    """rgb: (H, W, 3) uint8.  valid_mask: (H, W) bool, True = opaque."""
    from PIL import Image
    h, w, _ = rgb.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.where(valid_mask, 255, 0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _encode_scalar_png(arr: np.ndarray, cmap, vmin: float, vmax: float) -> bytes:
    """arr: (H, W) float; NaN → transparent.  cmap: matplotlib Colormap."""
    from PIL import Image
    valid = np.isfinite(arr)
    norm = np.clip((arr - vmin) / (vmax - vmin), 0.0, 1.0)
    rgba_f = cmap(np.where(valid, norm, 0.0))  # (H, W, 4) floats 0..1
    rgba = (rgba_f * 255).astype(np.uint8)
    rgba[..., 3] = np.where(valid, rgba[..., 3], 0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Footprint polygon (concave hull of valid pixels)
# ---------------------------------------------------------------------------
def _footprint_geojson(valid_mask: np.ndarray,
                       bounds: list) -> dict:
    """Approximate the swath footprint as a polygon by tracing the outer
    contour of the valid_mask in lat/lon space. Coarse but adequate for
    a click-popup hit test and visualization. bounds = [[s, w], [n, e]]."""
    from shapely.geometry import MultiPolygon, Polygon, mapping
    from shapely.ops import unary_union
    try:
        from skimage import measure
    except ImportError:
        # Fall back to a simple bounding-box rectangle if skimage missing.
        s, w = bounds[0]
        n, e = bounds[1]
        poly = Polygon([(w, s), (e, s), (e, n), (w, n), (w, s)])
        return mapping(poly)

    h, w_px = valid_mask.shape
    s, west = bounds[0]
    n, east = bounds[1]
    dlat = (n - s) / max(h, 1)
    dlon = (east - west) / max(w_px, 1)

    contours = measure.find_contours(valid_mask.astype(np.uint8), 0.5)
    if not contours:
        poly = Polygon([(west, s), (east, s), (east, n), (west, n), (west, s)])
        return mapping(poly)

    polys = []
    for c in contours:
        # c is (row, col) float pixel coords; row 0 = top = lat n.
        coords = [(west + col * dlon, n - row * dlat) for row, col in c]
        if len(coords) >= 4:
            try:
                p = Polygon(coords).buffer(0)  # repair self-intersections
                if p.is_valid and p.area > 0:
                    polys.append(p)
            except Exception:
                continue

    if not polys:
        poly = Polygon([(west, s), (east, s), (east, n), (west, n), (west, s)])
        return mapping(poly)

    union = unary_union(polys)
    if isinstance(union, MultiPolygon):
        # Pick the largest few components to keep the GeoJSON small.
        comps = sorted(union.geoms, key=lambda g: -g.area)[:5]
        union = MultiPolygon(comps)
    return mapping(union)


# ---------------------------------------------------------------------------
# Readers — produce TC-PRIMED-style (ds_bt, ds_geo) tuples
# ---------------------------------------------------------------------------
@dataclass
class GranuleMeta:
    sensor: str         # GMI, AMSR2, SSMIS, ...
    platform: str       # GPM, GCOM-W1, F16, ...
    orbit_id: str       # e.g. "31234" (PPS orbit number)
    scan_start_utc: _dt
    scan_end_utc: _dt
    source: str         # "PPS_NRT" | "TCPRIMED_PRELIM" | ...


def _tcprimed_meta(path: str) -> GranuleMeta:
    import re
    fname = Path(path).name
    m = re.match(
        r"TCPRIMED_v\d+r\d+-(?:final|preliminary)_([A-Z0-9]+)_"
        r"([A-Z0-9]+)_([A-Z0-9\-]+)_(\d+)_(\d{14})\.nc",
        fname,
    )
    if not m:
        raise ValueError(f"Unrecognized TC-PRIMED filename: {fname}")
    _atcf, sensor, platform, orbit, ts = m.groups()
    start = _dt.strptime(ts, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    return GranuleMeta(
        sensor=sensor, platform=platform, orbit_id=str(orbit),
        scan_start_utc=start, scan_end_utc=start,
        source="TCPRIMED_PRELIM",
    )


def _tcprimed_swath_groups(path: str) -> list[tuple[str, list[str]]]:
    """Enumerate (group_path, [tb_vars]) for every passive_microwave/Sn
    sub-swath in a TC-PRIMED file. Each sub-swath bundles a different
    frequency band (e.g. SSMIS S2=37 GHz, S4=91.665 GHz) on its own
    scan geometry with its own lat/lon arrays."""
    import h5netcdf
    out = []
    with h5netcdf.File(path, "r") as h5:
        pm = h5.groups.get("passive_microwave")
        if pm is None:
            return out
        for name, sub in pm.groups.items():
            tb_vars = [v for v in sub.variables if v.upper().startswith("TB_")]
            if tb_vars and "latitude" in sub.variables:
                out.append((f"passive_microwave/{name}", tb_vars))
    return out


def _pick_tcprimed_swath_for_freq(swaths: list[tuple[str, list[str]]],
                                  freq_ghz: int) -> Optional[str]:
    """Pick the sub-swath whose TB vars include the requested frequency.
    For 89 GHz, SSMIS labels the channel as 91.665, SSM/I as 85.5, so
    we accept anything in [85, 92]."""
    lo, hi = (85, 92) if freq_ghz >= 85 else (36, 38)
    import re
    for path, tb_vars in swaths:
        for v in tb_vars:
            m = re.search(r"TB_(\d+(?:\.\d+)?)", v)
            if m and lo <= float(m.group(1)) <= hi:
                return path
    return None


def read_tcprimed_for_product(path: str, product: str) -> tuple:
    """Open the TC-PRIMED sub-swath bearing the right frequency band for
    the requested product. Returns (ds_bt, ds_geo, meta) — for TC-PRIMED,
    lat/lon and TB live in the same group, so ds_geo is ds_bt."""
    import xarray as xr
    meta = _tcprimed_meta(path)
    swaths = _tcprimed_swath_groups(path)
    if not swaths:
        raise ValueError(f"No passive_microwave swath groups in {path}")

    freq = 37 if product == "37color" else 89
    grp = _pick_tcprimed_swath_for_freq(swaths, freq)
    if not grp:
        raise ValueError(
            f"No sub-swath with {freq} GHz channels for product {product} "
            f"in {Path(path).name}; swaths={[s for s, _ in swaths]}"
        )
    ds = xr.open_dataset(path, engine="h5netcdf", group=grp).load()
    return ds, ds, meta


# ---------------------------------------------------------------------------
# PPS sensor configuration (GMI / SSMIS / AMSR2 — all served from PPS NRT)
# ---------------------------------------------------------------------------
# Each sensor describes:
#   list_path:  the text-listing endpoint suffix (under /text/)
#   data_path:  the directory granules live under (relative to PPS_BASE)
#   fname_re:   regex matching {YYYYMMDD}-S{HHMMSS}-E{HHMMSS} in the
#               filename, with the satellite/platform also captured as the
#               first group when the listing intermixes platforms (SSMIS)
#   platform_fn: callable(fname) → platform string (e.g. "GPM", "F18")
#   products:   per-product { group, channels: {var_name: chan_idx} }
#               where each product picks its sub-swath and channel slice
#
# Channel slot orders verified from Tc.LongName on real 2026-05-25 granules.
# The "var_name" follows TC-PRIMED convention (TB_{freq}{pol}) so
# microwave_api._find_channel_var picks them up unchanged.
_PPS_FILL = -9999.9

_PPS_SENSORS = {
    "GMI": {
        "list_path":  "1CR/",
        "data_path":  "1CR/",
        "fname_re":   r"1C-R\.GPM\.GMI\.[\w\-]+\.(\d{8})-S(\d{6})-E(\d{6})\."
                      r"V\w+\.RT-NC$",
        "platform_fn": lambda f: "GPM",
        # GMI puts everything in /S1, so both products share one group.
        "products": {
            "37color": {"group": "S1", "channels": {
                "TB_36.64V": 5, "TB_36.64H": 6,
            }},
            "89pct":   {"group": "S1", "channels": {
                "TB_89.0V": 7, "TB_89.0H": 8,
            }},
        },
    },
    "SSMIS": {
        "list_path":  "1C/SSMIS/",
        "data_path":  "1C/SSMIS/",
        # 1C.{F16|F17|F18}.SSMIS.XCAL2021-V.YYYYMMDD-SHHMMSS-EHHMMSS.V08A.RT-NC
        "fname_re":   r"1C\.(F\d{2})\.SSMIS\.[\w\-]+\.(\d{8})-S(\d{6})-"
                      r"E(\d{6})\.V\w+\.RT-NC$",
        "platform_fn": None,  # captured from fname_re group 1
        # SSMIS splits frequency bands across sub-swaths with different
        # scan geometries — must open the right group per product.
        "products": {
            "37color": {"group": "S2", "channels": {
                "TB_37.0V": 0, "TB_37.0H": 1,
            }},
            "89pct":   {"group": "S4", "channels": {
                "TB_91.665V": 0, "TB_91.665H": 1,
            }},
        },
    },
    "AMSR2": {
        "list_path":  "1C/AMSR2/",
        "data_path":  "1C/AMSR2/",
        "fname_re":   r"1C\.GCOMW1\.AMSR2\.[\w\-]+\.(\d{8})-S(\d{6})-"
                      r"E(\d{6})\.V\w+\.RT-NC$",
        "platform_fn": lambda f: "GCOMW1",
        # AMSR2 also splits per band; use S5 (89 A-Scan) for 89pct.
        "products": {
            "37color": {"group": "S4", "channels": {
                "TB_36.5V": 0, "TB_36.5H": 1,
            }},
            "89pct":   {"group": "S5", "channels": {
                "TB_89.0V": 0, "TB_89.0H": 1,
            }},
        },
    },
}


def _pps_granule_meta(sensor: str, fname: str) -> GranuleMeta:
    """Parse start/end times + platform out of a PPS granule filename."""
    import re
    cfg = _PPS_SENSORS[sensor]
    m = re.match(cfg["fname_re"], fname)
    if not m:
        raise ValueError(f"Unrecognized PPS {sensor} filename: {fname}")
    groups = m.groups()
    if cfg["platform_fn"] is None:
        # First capture group is the platform (e.g. F18 for SSMIS).
        platform = groups[0]
        ymd, start_hms, end_hms = groups[1:4]
    else:
        platform = cfg["platform_fn"](fname)
        ymd, start_hms, end_hms = groups[:3]
    start = _dt.strptime(ymd + start_hms, "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc)
    end = _dt.strptime(ymd + end_hms, "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc)
    if end < start:
        end += timedelta(days=1)
    orbit_id = start.strftime("%Y%m%dT%H%M%S")
    return GranuleMeta(
        sensor=sensor, platform=platform, orbit_id=orbit_id,
        scan_start_utc=start, scan_end_utc=end, source="PPS_NRT",
    )


def read_pps_for_product(path: str, sensor: str, product: str) -> tuple:
    """Open the PPS L1C HDF5 sub-swath that bears the right frequency band
    for `product` on `sensor`, and adapt to TC-PRIMED-style
    (ds_bt, ds_geo, meta) so microwave_api renderers Just Work.

    Each sub-swath in PPS L1C carries its own Latitude/Longitude
    co-located with Tc[scan, pixel, chan], so we return the same Dataset
    as both ds_bt and ds_geo (matching the TC-PRIMED pattern where the
    storm-centered overpass sub-swath is self-contained)."""
    import xarray as xr

    fname = Path(path).name
    meta = _pps_granule_meta(sensor, fname)
    spec = _PPS_SENSORS[sensor]["products"].get(product)
    if spec is None:
        raise ValueError(f"Sensor {sensor} has no product {product} configured")

    s = xr.open_dataset(path, engine="h5netcdf", group=spec["group"]).load()
    tc = s["Tc"]
    # Channel-dim name varies (nchannel1 for GMI S1, nchannel2 for SSMIS S2, etc.)
    # — last dim by position to stay sensor-agnostic.
    chan_dim = tc.dims[-1]

    data_vars = {}
    for var_name, k in spec["channels"].items():
        slab = tc.isel({chan_dim: k}).astype(np.float32)
        slab = slab.where(slab > _PPS_FILL + 0.1)
        data_vars[var_name] = (("scan", "pixel"), slab.values)
    data_vars["latitude"] = (("scan", "pixel"), s["Latitude"].values)
    data_vars["longitude"] = (("scan", "pixel"), s["Longitude"].values)
    ds = xr.Dataset(data_vars=data_vars)
    s.close()
    return ds, ds, meta


# Backwards-compat alias for the GMI-only entry point used during Phase 1
# scaffolding. Operational mode and process_one now go through
# read_pps_for_product.
def read_pps_l1c(path: str) -> tuple:
    return read_pps_for_product(path, "GMI", "37color")


# ---------------------------------------------------------------------------
# PPS granule discovery (HTTP listing → granule URLs)
# ---------------------------------------------------------------------------
def list_pps_granules(sensor: str, since: _dt, until: Optional[_dt] = None
                      ) -> list[tuple[str, _dt]]:
    """Return [(granule_url, scan_start_utc), ...] for `sensor` granules
    in [since, until] (UTC). PPS exposes a text-listing endpoint that
    returns one path per line (newest at the bottom); we filter to the
    sensor's filename pattern and time window.
    """
    import re
    cfg = _PPS_SENSORS[sensor]
    sess = _pps_session()
    r = sess.get(f"{PPS_BASE}/text/{cfg['list_path']}", timeout=60)
    r.raise_for_status()
    rx = re.compile(cfg["fname_re"])
    data_base = f"{PPS_BASE}/{cfg['data_path']}"
    out: list[tuple[str, _dt]] = []
    for line in r.text.splitlines():
        line = line.strip()
        if not line:
            continue
        fname = line.rsplit("/", 1)[-1]
        m = rx.match(fname)
        if not m:
            continue
        # ymd + start_hms are at positions 0,1 for GMI/AMSR2, 1,2 for SSMIS
        # (which captures platform first). _pps_granule_meta handles the
        # offset — but for sort key we just need start time, so parse here.
        groups = m.groups()
        if cfg["platform_fn"] is None:
            ymd, start_hms = groups[1], groups[2]
        else:
            ymd, start_hms = groups[0], groups[1]
        start = _dt.strptime(ymd + start_hms, "%Y%m%d%H%M%S").replace(
            tzinfo=timezone.utc)
        if start < since:
            continue
        if until is not None and start > until:
            continue
        out.append((f"{data_base}{fname}", start))
    out.sort(key=lambda t: t[1])
    return out


# Backwards-compat alias.
def list_pps_gmi_granules(since: _dt, until: Optional[_dt] = None
                          ) -> list[tuple[str, _dt]]:
    return list_pps_granules("GMI", since, until)


def _pps_session():
    """requests.Session with PPS basic auth. PPS uses email as both
    username and password by convention."""
    import requests
    if not PPS_USER or not PPS_PASS:
        raise RuntimeError(
            "Set PPS_USER and PPS_PASS (both = your registered email per "
            "PPS NRT convention)"
        )
    s = requests.Session()
    s.auth = (PPS_USER, PPS_PASS)
    return s


# ---------------------------------------------------------------------------
# Render + upload one granule
# ---------------------------------------------------------------------------
@dataclass
class RenderedProduct:
    product: str        # "37color" | "89pct"
    png_bytes: bytes
    bounds: list        # [[s, w], [n, e]]
    footprint: dict     # GeoJSON geometry


def render_product(ds_bt, ds_geo, sensor: str, product: str
                   ) -> RenderedProduct:
    """Render one product from one swath. Each product may need a
    different (ds_bt, ds_geo) — caller is responsible for opening the
    right group(s) per product (see read_tcprimed_for_product)."""
    if product == "37color":
        gridded = _compute_37color_swath(ds_bt, ds_geo, sensor)
        data = gridded["data"]               # (H, W, 3) uint8
        valid = ~np.all(data == 0, axis=-1)  # transparent where all-zero
    elif product == "89pct":
        gridded = _compute_89pct_swath(ds_bt, ds_geo, sensor)
        data = gridded["data"].astype(np.float32)
        valid = np.isfinite(data)
    else:
        raise ValueError(f"Unknown product {product}")

    # `_regrid_swath` returns arrays with row 0 = lat_min (south-up, since
    # grid_lat = np.linspace(lat_min, lat_max)). PIL / L.imageOverlay
    # expect row 0 = top = lat_max (north-down). Flip vertically so the
    # subsequent Mercator warp + PNG render places pixels at their true
    # latitudes — otherwise features land mirrored across the swath
    # center (e.g. land/ocean transitions miss the basemap coastline).
    data = data[::-1, ...]
    valid = valid[::-1, ...]

    bounds = gridded["bounds"]
    lat_min, lat_max = bounds[0][0], bounds[1][0]

    if product == "37color":
        warped_rgb = _warp_eq_to_mercator_bbox(data, lat_min, lat_max)
        warped_valid = _warp_eq_to_mercator_bbox(
            valid.astype(np.uint8), lat_min, lat_max,
        ).astype(bool)
        png = _encode_rgb_png(warped_rgb, warped_valid)
    else:
        warped = _warp_eq_to_mercator_bbox(data, lat_min, lat_max)
        # vmin=180 (was 150) better reveals convective detail at tropical
        # latitudes where most pixels are warm ocean — values below ~200 K
        # are rare and meaningful (deep ice scattering), so a tighter floor
        # keeps the colormap's dynamic range over the band that actually
        # carries signal. Keep the frontend legend's 150-290 K axis in
        # rough sync (~180-290 K shows correctly with a labeled tick at 200).
        png = _encode_scalar_png(warped, _nrl_89ghz_cmap(), vmin=180, vmax=290)
        warped_valid = np.isfinite(warped)

    footprint = _footprint_geojson(warped_valid, bounds)
    return RenderedProduct(product=product, png_bytes=png,
                           bounds=bounds, footprint=footprint)


def upload_granule(meta: GranuleMeta, products: list[RenderedProduct],
                   dry_run: bool = False, dry_run_dir: Optional[str] = None,
                   ) -> list[dict]:
    """Upload PNG + GeoJSON for each product. Returns manifest entries.
    In dry-run mode, writes locally under dry_run_dir instead of GCS."""
    entries = []
    t = meta.scan_start_utc
    base = f"{meta.sensor}/{t:%Y}/{t:%m}/{t:%d}/{meta.orbit_id}_{t:%H%M%S}"
    for p in products:
        png_key = f"{base}_{p.product}.png"
        geo_key = f"{base}_{p.product}.geojson"
        geo_payload = json.dumps(
            {"type": "Feature", "geometry": p.footprint,
             "properties": {"sensor": meta.sensor,
                            "scan_start": t.isoformat()}},
            separators=(",", ":")).encode("utf-8")
        if dry_run:
            out_root = Path(dry_run_dir or "./mw_out")
            (out_root / Path(png_key).parent).mkdir(parents=True, exist_ok=True)
            (out_root / png_key).write_bytes(p.png_bytes)
            (out_root / geo_key).write_bytes(geo_payload)
            logger.info("[dry-run] wrote %s (%d bytes)", out_root / png_key,
                        len(p.png_bytes))
        else:
            _upload_bytes(png_key, p.png_bytes, "image/png")
            _upload_bytes(geo_key, geo_payload, "application/geo+json")
        entries.append({
            "sensor": meta.sensor,
            "platform": meta.platform,
            "orbit_id": meta.orbit_id,
            "scan_start": t.isoformat(),
            "product": p.product,
            "png_url": f"https://storage.googleapis.com/{MW_BUCKET}/{png_key}",
            "geojson_url": f"https://storage.googleapis.com/{MW_BUCKET}/{geo_key}",
            "bounds": p.bounds,  # [[s, w], [n, e]] for L.imageOverlay
            "source": meta.source,
        })
    return entries


def _last_processed_start_utc(sensor: Optional[str] = None) -> Optional[_dt]:
    """Look up the newest scan_start in the rolling manifest. Used by
    --operational mode to resume polling without reprocessing. When
    `sensor` is given, only entries for that sensor are considered (so
    a new sensor's first run doesn't get pinned to another sensor's
    cursor)."""
    try:
        txt = _download_text(MANIFEST_KEY)
    except Exception as exc:
        logger.warning("manifest read failed (%s) — falling back to default since", exc)
        return None
    if not txt:
        return None
    try:
        entries = json.loads(txt).get("entries", [])
    except Exception:
        return None
    if sensor:
        entries = [e for e in entries if e.get("sensor") == sensor]
    if not entries:
        return None
    return max(_dt.fromisoformat(e["scan_start"]) for e in entries)


def update_manifest(new_entries: list[dict]) -> None:
    """Merge new_entries into the rolling 48-hour manifest."""
    existing_txt = _download_text(MANIFEST_KEY)
    existing = json.loads(existing_txt)["entries"] if existing_txt else []
    # Dedupe by (orbit_id, product).
    keyed = {(e["orbit_id"], e["product"]): e for e in existing}
    for e in new_entries:
        keyed[(e["orbit_id"], e["product"])] = e
    # Prune anything older than retention window.
    cutoff = _dt.now(timezone.utc) - timedelta(hours=MANIFEST_RETENTION_HOURS)
    pruned = [e for e in keyed.values()
              if _dt.fromisoformat(e["scan_start"]) >= cutoff]
    pruned.sort(key=lambda e: e["scan_start"], reverse=True)
    payload = {"updated": _dt.now(timezone.utc).isoformat(),
               "retention_hours": MANIFEST_RETENTION_HOURS,
               "entries": pruned}
    _upload_bytes(
        MANIFEST_KEY,
        json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        "application/json",
        cache_seconds=60,
    )
    logger.info("manifest: %d entries after merge (%d new)",
                len(pruned), len(new_entries))


def process_one(reader_path: str, sensor: str,
                products: Iterable[str],
                dry_run: bool = False,
                dry_run_dir: Optional[str] = None) -> list[dict]:
    """Read → render → upload one file. Returns manifest entries."""
    is_tcprimed = reader_path.lower().endswith(".nc")
    rendered: list[RenderedProduct] = []
    meta: Optional[GranuleMeta] = None

    for product in products:
        try:
            if is_tcprimed:
                ds_bt, ds_geo, meta_i = read_tcprimed_for_product(
                    reader_path, product)
            else:
                ds_bt, ds_geo, meta_i = read_pps_for_product(
                    reader_path, sensor, product)
        except Exception as exc:
            logger.error("open failed for product=%s sensor=%s: %s",
                         product, sensor, exc)
            continue

        if meta is None:
            meta = meta_i
        eff_sensor = sensor or meta.sensor
        try:
            rendered.append(render_product(ds_bt, ds_geo, eff_sensor, product))
        except Exception as exc:
            logger.error("render failed for product=%s: %s", product, exc)
        finally:
            ds_bt.close()
            if ds_geo is not ds_bt:
                ds_geo.close()

    if not rendered:
        return []
    if sensor and meta and sensor != meta.sensor:
        meta = GranuleMeta(**{**meta.__dict__, "sensor": sensor})
    logger.info("processing %s/%s orbit=%s start=%s — %d products rendered",
                meta.sensor, meta.platform, meta.orbit_id,
                meta.scan_start_utc, len(rendered))
    return upload_granule(meta, rendered, dry_run=dry_run,
                          dry_run_dir=dry_run_dir)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _cli(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--tcprimed-file",
                    help="Local TC-PRIMED .nc to process (test mode)")
    ap.add_argument("--pps-file",
                    help="Local PPS L1C HDF5 to process (after reader is ready)")
    ap.add_argument("--sensor", default="GMI",
                    help="Single-sensor mode (--tcprimed-file / --pps-file): "
                         "sensor name; defaults to GMI")
    ap.add_argument("--sensors", default="GMI,SSMIS,AMSR2",
                    help="Operational/poll mode: comma-separated list of "
                         "PPS sensors to ingest (default GMI,SSMIS,AMSR2)")
    ap.add_argument("--products", default="37color,89pct",
                    help="Comma-separated product list")
    ap.add_argument("--since-hours", type=float, default=None,
                    help="Live PPS poll mode: ingest all granules from "
                         "now − N hours per sensor (requires PPS_USER/PPS_PASS)")
    ap.add_argument("--operational", action="store_true",
                    help="Cloud Run mode: resume from the latest manifest "
                         "scan_start per sensor (or --since-hours N on first "
                         "run). Idempotent — already-uploaded granules are "
                         "deduped by orbit_id in the manifest.")
    ap.add_argument("--no-manifest", action="store_true",
                    help="Skip manifest update (useful for one-off testing)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Write PNGs/GeoJSON locally instead of uploading to GCS")
    ap.add_argument("--dry-run-dir", default="./mw_out",
                    help="Local output directory in --dry-run mode")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    products = [p.strip() for p in args.products.split(",") if p.strip()]
    all_entries: list[dict] = []

    if args.tcprimed_file:
        all_entries.extend(process_one(
            args.tcprimed_file, args.sensor, products,
            dry_run=args.dry_run, dry_run_dir=args.dry_run_dir,
        ))
    elif args.pps_file:
        all_entries.extend(process_one(
            args.pps_file, args.sensor, products,
            dry_run=args.dry_run, dry_run_dir=args.dry_run_dir,
        ))
    elif args.since_hours is not None or args.operational:
        # Operational mode: pick up where the manifest left off PER SENSOR,
        # so a newly-added sensor with no entries yet doesn't get pinned
        # to another sensor's cursor. Fall back to args.since_hours
        # (or 1 h default) on the very first run for that sensor.
        sensors = [s.strip() for s in args.sensors.split(",") if s.strip()]
        unknown = [s for s in sensors if s not in _PPS_SENSORS]
        if unknown:
            ap.error(f"Unknown sensor(s): {unknown}. "
                     f"Supported: {list(_PPS_SENSORS)}")

        sess = _pps_session()
        # Larger first-run fallback than 1 h — SSMI/S and AMSR2 NRT lag ~3-4 h
        # behind real time, so a tight window leaves them empty on the first
        # operational pass. 6 h captures everything available; subsequent
        # runs resume from the per-sensor manifest cursor with 20-min steps.
        fallback_hours = args.since_hours if args.since_hours is not None else 6

        for sensor in sensors:
            if args.operational:
                last = _last_processed_start_utc(sensor=sensor)
                if last is None:
                    since = _dt.now(timezone.utc) - timedelta(hours=fallback_hours)
                    logger.info("[%s] no prior manifest entries — falling back "
                                "to last %.1f h", sensor, fallback_hours)
                else:
                    # +1s so we don't reprocess the boundary granule.
                    since = last + timedelta(seconds=1)
            else:
                since = _dt.now(timezone.utc) - timedelta(hours=args.since_hours)
            logger.info("[%s] polling PPS for granules since %s",
                        sensor, since.isoformat())
            try:
                granules = list_pps_granules(sensor, since)
            except Exception as exc:
                logger.error("[%s] listing failed: %s — skipping", sensor, exc)
                continue
            logger.info("[%s] found %d new granules to process",
                        sensor, len(granules))

            for url, scan_start in granules:
                fname = url.rsplit("/", 1)[-1]
                # Download into a temp DIR using the original PPS filename so
                # read_pps_for_product's regex (anchored on the granule name
                # pattern) sees the unmodified granule name.
                # NamedTemporaryFile prepends tmpXXX_ which broke that parse.
                with tempfile.TemporaryDirectory() as td:
                    fpath = Path(td) / fname
                    try:
                        r = sess.get(url, stream=True, timeout=180)
                        r.raise_for_status()
                        with open(fpath, "wb") as f:
                            for chunk in r.iter_content(chunk_size=1 << 20):
                                f.write(chunk)
                        all_entries.extend(process_one(
                            str(fpath), sensor, products))
                    except Exception as exc:
                        logger.error("[%s] granule %s failed: %s",
                                     sensor, fname, exc)
    else:
        ap.error("Specify one of --tcprimed-file / --pps-file / "
                 "--since-hours / --operational")

    if all_entries and not args.no_manifest and not args.dry_run:
        update_manifest(all_entries)
    print(json.dumps({"processed": len(all_entries), "entries": all_entries[:3]},
                     indent=2, default=str))


if __name__ == "__main__":
    _cli()
