"""
nexrad_api.py — NEXRAD WSR-88D Ground Radar Overlay Endpoints
==============================================================
FastAPI APIRouter that provides NEXRAD Level II radar data
(reflectivity, radial velocity) from the AWS Open Data archive.

Supports two rendering modes:
  1. Geographic overlay — gridded to lat/lon for Leaflet L.imageOverlay
  2. Storm-relative — reprojected to Cartesian km for Plotly plan-view

Data source: s3://noaa-nexrad-level2/ (public, no auth required)
"""

import base64
import io
import json
import logging
import math
import os
import threading
import time
from collections import OrderedDict
from datetime import datetime as _dt, timedelta, timezone
from typing import Dict, List, Optional, Tuple

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

logger = logging.getLogger("nexrad_api")

router = APIRouter(tags=["nexrad"])

# ── Lazy imports ──────────────────────────────────────────────

_s3fs_mod = None
_pyart_mod = None
_nexrad_fs = None
_scipy_interp = None


def _get_s3fs():
    global _s3fs_mod
    if _s3fs_mod is None:
        try:
            import s3fs
            _s3fs_mod = s3fs
        except ImportError:
            return None
    return _s3fs_mod


def _get_pyart():
    global _pyart_mod
    if _pyart_mod is None:
        try:
            import pyart
            _pyart_mod = pyart
        except ImportError:
            return None
    return _pyart_mod


def _get_scipy_interp():
    global _scipy_interp
    if _scipy_interp is None:
        try:
            from scipy.interpolate import RegularGridInterpolator
            _scipy_interp = RegularGridInterpolator
        except ImportError:
            return None
    return _scipy_interp


def _get_nexrad_fs():
    """Return a shared s3fs filesystem for public NEXRAD bucket."""
    global _nexrad_fs
    if _nexrad_fs is None:
        s3fs = _get_s3fs()
        if s3fs is None:
            return None
        _nexrad_fs = s3fs.S3FileSystem(anon=True)
    return _nexrad_fs


# ── In-memory LRU cache ──────────────────────────────────────

_CACHE_MAX = 64
_frame_cache: OrderedDict = OrderedDict()
_cache_lock = threading.Lock()


def _cache_get(key: str) -> dict | None:
    with _cache_lock:
        val = _frame_cache.get(key)
        if val is not None:
            _frame_cache.move_to_end(key)
        return val


def _cache_put(key: str, val: dict):
    with _cache_lock:
        _frame_cache[key] = val
        _frame_cache.move_to_end(key)
        while len(_frame_cache) > _CACHE_MAX:
            _frame_cache.popitem(last=False)


# ── GCS persistent cache ─────────────────────────────────────

_GCS_NEXRAD_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "")
_gcs_client = None
_gcs_bucket = None
_GCS_CACHE_VERSION = "v5"


def _get_gcs_bucket():
    global _gcs_client, _gcs_bucket
    if not _GCS_NEXRAD_BUCKET:
        return None
    if _gcs_bucket is not None:
        return _gcs_bucket
    try:
        from google.cloud import storage
        _gcs_client = storage.Client()
        _gcs_bucket = _gcs_client.bucket(_GCS_NEXRAD_BUCKET)
        logger.info(f"GCS NEXRAD cache enabled: gs://{_GCS_NEXRAD_BUCKET}")
        return _gcs_bucket
    except Exception as e:
        logger.warning(f"GCS NEXRAD cache init failed: {e}")
        return None


def _gcs_cache_key(site: str, scan_key: str, product: str, tilt: int,
                    max_range_km: int = 460) -> str:
    safe_key = scan_key.replace("/", "_")
    return f"nexrad/{_GCS_CACHE_VERSION}/{site}/{safe_key}/{product}_{tilt}_{max_range_km}km.json"


def _gcs_get_frame(site: str, scan_key: str, product: str, tilt: int,
                    max_range_km: int = 460) -> dict | None:
    bucket = _get_gcs_bucket()
    if bucket is None:
        return None
    key = _gcs_cache_key(site, scan_key, product, tilt, max_range_km)
    try:
        blob = bucket.blob(key)
        data = blob.download_as_bytes(timeout=5)
        return json.loads(data)
    except Exception:
        return None


def _gcs_put_frame(site: str, scan_key: str, product: str, tilt: int, result: dict,
                    max_range_km: int = 460):
    bucket = _get_gcs_bucket()
    if bucket is None:
        return

    def _upload():
        key = _gcs_cache_key(site, scan_key, product, tilt, max_range_km)
        try:
            blob = bucket.blob(key)
            blob.upload_from_string(
                json.dumps(result, separators=(",", ":")),
                content_type="application/json",
                timeout=15,
            )
            logger.debug(f"GCS NEXRAD cache PUT: {key}")
        except Exception as e:
            logger.debug(f"GCS NEXRAD cache PUT failed: {key}: {e}")

    threading.Thread(target=_upload, daemon=True).start()


# ── NEXRAD WSR-88D Site Table ─────────────────────────────────
# Key TC-relevant sites. Full table at ~160 sites, but we only
# include the coastal/island sites most relevant for tropical
# cyclone coverage. Additional sites can be added as needed.

NEXRAD_SITES: Dict[str, Tuple[float, float, str]] = {
    # site_id: (lat, lon, name)
    # ── Atlantic / Gulf Coast ──
    "KBYX": (24.597, -81.703, "Key West FL"),
    "KAMX": (25.611, -80.413, "Miami FL"),
    "KMLB": (28.113, -80.654, "Melbourne FL"),
    "KTBW": (27.706, -82.402, "Tampa Bay FL"),
    "KJAX": (30.485, -81.702, "Jacksonville FL"),
    "KTLH": (30.398, -84.329, "Tallahassee FL"),
    "KEVX": (30.565, -85.922, "Eglin AFB FL"),
    "KMOB": (30.680, -88.240, "Mobile AL"),
    "KEOX": (31.460, -85.459, "Fort Rucker AL"),
    "KLIX": (30.337, -89.826, "New Orleans LA"),
    "KLCH": (30.125, -93.216, "Lake Charles LA"),
    "KPOE": (31.156, -92.976, "Fort Polk LA"),
    "KHGX": (29.472, -95.079, "Houston TX"),
    "KCRP": (27.784, -97.511, "Corpus Christi TX"),
    "KBRO": (25.916, -97.419, "Brownsville TX"),
    "KEWX": (29.704, -98.029, "San Antonio TX"),
    "KDFX": (29.273, -100.281, "Laughlin AFB TX"),
    # ── Southeast / Mid-Atlantic ──
    "KCLX": (32.656, -81.042, "Charleston SC"),
    "KCAE": (33.949, -81.119, "Columbia SC"),
    "KLTX": (33.989, -78.429, "Wilmington NC"),
    "KMHX": (34.776, -76.876, "Morehead City NC"),
    "KRAX": (35.666, -78.490, "Raleigh NC"),
    "KAKQ": (36.984, -77.008, "Wakefield VA"),
    "KDOX": (38.826, -75.440, "Dover AFB DE"),
    "KDIX": (39.947, -74.411, "Philadelphia PA"),
    "KOKX": (40.866, -72.864, "New York City NY"),
    "KBOX": (41.956, -71.137, "Boston MA"),
    # ── Caribbean ──
    "TJUA": (18.116, -66.078, "San Juan PR"),
    # ── West Pacific ──
    "PGUA": (13.455, 144.811, "Andersen AFB Guam"),
    # ── Hawaii ──
    "PHKI": (21.894, -159.552, "Kauai HI"),
    "PHKM": (20.125, -155.778, "Kamuela HI"),
    "PHMO": (21.133, -157.180, "Molokai HI"),
    "PHWA": (19.095, -155.569, "South Shore HI"),
}


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km between two points."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ── NWS-style colormaps ───────────────────────────────────────

def _build_reflectivity_lut() -> np.ndarray:
    """
    Build a 256-entry RGBA LUT for reflectivity (dBZ).
    Maps uint8 index 0 = transparent (invalid), 1-255 = -32 to 95 dBZ.
    Standard NWS reflectivity color scheme.
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    # Index 0 = transparent/invalid
    lut[0] = [0, 0, 0, 0]

    # dBZ thresholds and discrete colors (NWS standard — no interpolation)
    # Each entry: (min_dbz, R, G, B, A) — solid color for dbz >= threshold
    steps = [
        (75, 253, 253, 253, 255),  # white (extreme)
        (70, 152,  84, 198, 255),  # purple
        (65, 248,   0, 253, 255),  # magenta
        (60, 188,   0,   0, 255),  # darker red
        (55, 212,   0,   0, 255),  # dark red
        (50, 253,   0,   0, 255),  # red
        (45, 253, 149,   0, 255),  # orange
        (40, 229, 188,   0, 255),  # dark yellow
        (35, 253, 248,   2, 255),  # yellow
        (30,   0, 142,   0, 255),  # dark green
        (25,   1, 197,   1, 255),  # darker green
        (20,   2, 253,   2, 255),  # green
        (15,   3,   0, 244, 255),  # blue
        (10,   1, 159, 244, 255),  # medium cyan
        ( 5,   4, 233, 231, 255),  # light cyan
    ]

    dbz_min, dbz_max = -32.0, 95.0
    dbz_range = dbz_max - dbz_min

    for i in range(1, 256):
        dbz = dbz_min + (i - 1) * dbz_range / 254.0
        color = [0, 0, 0, 0]  # transparent by default (below 5 dBZ)
        for threshold, r, g, b, a in steps:
            if dbz >= threshold:
                color = [r, g, b, a]
                break
        lut[i] = color

    return lut


def _build_velocity_lut() -> np.ndarray:
    """
    Build a 256-entry RGBA LUT for radial velocity (m/s).
    Maps uint8 index 0 = transparent (invalid), 1-255 = -50 to +50 m/s.
    Blue = inbound (negative), Red = outbound (positive).
    """
    lut = np.zeros((256, 4), dtype=np.uint8)
    lut[0] = [0, 0, 0, 0]

    vel_min, vel_max = -50.0, 50.0
    vel_range = vel_max - vel_min

    for i in range(1, 256):
        vel = vel_min + (i - 1) * vel_range / 254.0
        norm = (vel - vel_min) / vel_range  # 0 to 1

        if norm < 0.15:
            r, g, b = 0, 0, int(80 + norm / 0.15 * 175)
        elif norm < 0.3:
            f = (norm - 0.15) / 0.15
            r, g, b = 0, int(f * 200), 255
        elif norm < 0.45:
            f = (norm - 0.3) / 0.15
            r, g, b = 0, int(200 + f * 55), int(255 - f * 55)
        elif norm < 0.5:
            f = (norm - 0.45) / 0.05
            r, g, b = int(f * 128), 255, int(200 - f * 200)
        elif norm < 0.55:
            f = (norm - 0.5) / 0.05
            r, g, b = int(128 + f * 127), int(255 - f * 127), 0
        elif norm < 0.7:
            f = (norm - 0.55) / 0.15
            r, g, b = 255, int(128 - f * 128), 0
        elif norm < 0.85:
            f = (norm - 0.7) / 0.15
            r, g, b = int(255 - f * 55), 0, 0
        else:
            f = (norm - 0.85) / 0.15
            r, g, b = int(200 - f * 80), 0, int(f * 60)

        lut[i] = [min(255, max(0, r)), min(255, max(0, g)),
                  min(255, max(0, b)), 230]

    return lut


_REFL_LUT = _build_reflectivity_lut()
_VEL_LUT = _build_velocity_lut()

# Product configuration
PRODUCTS = {
    "reflectivity": {
        "field": "reflectivity",
        "vmin": -32.0,
        "vmax": 95.0,
        "lut": _REFL_LUT,
        "units": "dBZ",
        "label": "Reflectivity",
    },
    "velocity": {
        "field": "velocity",
        "vmin": -50.0,
        "vmax": 50.0,
        "lut": _VEL_LUT,
        "units": "m/s",
        "label": "Radial Velocity",
    },
}


# ── Rendering helpers ─────────────────────────────────────────

def _encode_data_uint8(data_2d: np.ndarray, vmin: float, vmax: float) -> dict:
    """
    Encode a 2D data array as a compact base64 uint8 string for client-side hover.
    Values mapped to 1-255 range (0 = invalid/masked).
    """
    arr = np.asarray(data_2d, dtype=np.float32)
    mask = ~np.isfinite(arr)

    scale = 254.0 / (vmax - vmin) if vmax != vmin else 1.0
    scaled = np.clip((arr - vmin) * scale + 1, 1, 255)
    scaled[mask] = 0
    encoded = scaled.astype(np.uint8)

    return {
        "data": base64.b64encode(encoded.tobytes()).decode("ascii"),
        "data_rows": encoded.shape[0],
        "data_cols": encoded.shape[1],
        "data_vmin": float(vmin),
        "data_vmax": float(vmax),
    }


def _render_radar_image(data_2d: np.ndarray, lut: np.ndarray,
                        vmin: float, vmax: float, scale: int = 1) -> str:
    """
    Render a 2D radar data array to a base64 WebP/PNG image using the given LUT.
    """
    from PIL import Image

    arr = np.asarray(data_2d, dtype=np.float32)
    mask = ~np.isfinite(arr)

    # Map data to uint8 indices (1-255, 0=invalid)
    frac = (arr - vmin) / (vmax - vmin)
    frac[mask] = -1
    frac = np.clip(frac, 0.0, 1.0)
    indices = (frac * 254 + 1).astype(np.uint8)
    indices[mask] = 0

    rgba = lut[indices]  # shape (H, W, 4)

    img = Image.fromarray(rgba, "RGBA")
    del arr, frac, indices, rgba

    if scale and scale > 1:
        img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)

    buf = io.BytesIO()
    try:
        # Lossless WebP preserves alpha channel cleanly (lossy corrupts it)
        img.save(buf, format="WEBP", lossless=True, method=0)
        mime = "image/webp"
    except Exception:
        img.save(buf, format="PNG", compress_level=1)
        mime = "image/png"

    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:{mime};base64,{b64}"


# ── S3 data fetching ─────────────────────────────────────────

_NEXRAD_BUCKET = "unidata-nexrad-level2"


def _list_scans_s3(site: str, dt: _dt, window_min: int = 60) -> List[dict]:
    """
    List available NEXRAD Level II scans near a given datetime.
    Returns list of {s3_key, scan_time, site} sorted by time distance.
    """
    fs = _get_nexrad_fs()
    if fs is None:
        raise HTTPException(500, "s3fs not available")

    results = []
    # Search the day of and adjacent day if near midnight
    dates_to_check = [dt.date()]
    if dt.hour < 1:
        dates_to_check.append((dt - timedelta(days=1)).date())
    elif dt.hour >= 23:
        dates_to_check.append((dt + timedelta(days=1)).date())

    for d in dates_to_check:
        prefix = f"{_NEXRAD_BUCKET}/{d.strftime('%Y/%m/%d')}/{site}/"
        try:
            files = fs.ls(prefix)
        except Exception:
            continue

        for f in files:
            fname = f.split("/")[-1]
            # Filenames: KBYX20220928_183456_V06 or similar
            if not fname.startswith(site):
                continue
            # Skip MDM metadata files
            if fname.endswith("_MDM"):
                continue
            # Extract datetime from filename
            try:
                # Format: SSSSYYYYMMDD_HHMMSS_V0X
                date_str = fname[4:19]  # YYYYMMDD_HHMMSS
                scan_dt = _dt.strptime(date_str, "%Y%m%d_%H%M%S").replace(
                    tzinfo=timezone.utc
                )
            except (ValueError, IndexError):
                continue

            delta = abs((scan_dt - dt).total_seconds())
            if delta <= window_min * 60:
                results.append({
                    "s3_key": f,
                    "scan_time": scan_dt.strftime("%Y-%m-%d %H:%M:%S UTC"),
                    "scan_dt": scan_dt,
                    "delta_sec": delta,
                    "site": site,
                })

    results.sort(key=lambda x: x["scan_dt"])
    return results


def _read_nexrad_level2(s3_key: str):
    """
    Read a NEXRAD Level II file from S3 and return a pyart Radar object.
    """
    pyart = _get_pyart()
    if pyart is None:
        raise HTTPException(500, "arm-pyart not available")

    fs = _get_nexrad_fs()
    if fs is None:
        raise HTTPException(500, "s3fs not available")

    try:
        with fs.open(s3_key, "rb") as f:
            data = f.read()
    except Exception as e:
        raise HTTPException(404, f"NEXRAD file not found: {s3_key}: {e}")

    # Pre-2008 NEXRAD files are gzip-compressed (.gz extension).
    # Py-ART handles internal bzip2 but not the outer gzip wrapper.
    # Some old files have truncated gzip streams, so we use incremental
    # decompression to recover as much data as possible.
    import gzip as _gzip
    import zlib as _zlib
    if data[:2] == b'\x1f\x8b':  # gzip magic bytes
        try:
            data = _gzip.decompress(data)
        except Exception as e:
            # Truncated gzip — try incremental decompression to salvage data
            logger.warning(f"gzip.decompress failed for {s3_key}: {e}, trying incremental")
            try:
                d = _zlib.decompressobj(_zlib.MAX_WBITS | 16)
                data = d.decompress(data)
            except Exception as e2:
                logger.warning(f"Incremental gzip also failed for {s3_key}: {e2}")

    try:
        radar = pyart.io.read_nexrad_archive(
            io.BytesIO(data), delay_field_loading=False
        )
    except Exception as e:
        raise HTTPException(500, f"Failed to read NEXRAD file: {e}")

    return radar


def _grid_radar(radar, product: str = "reflectivity",
                sweep: int = 0, grid_spacing_m: int = 1000,
                max_range_m: int = 230000) -> Tuple[np.ndarray, dict]:
    """
    Grid a single sweep of radar data to a regular lat/lon grid.

    Uses lightweight direct gate-to-grid binning instead of pyart.map.grid_from_radars()
    to stay within Cloud Run's 2GB memory limit.

    Returns (data_2d, metadata) where metadata includes bounds and grid info.
    """
    pyart = _get_pyart()

    # Get the field name for the requested product
    prod_cfg = PRODUCTS.get(product)
    if prod_cfg is None:
        raise HTTPException(400, f"Unknown product: {product}")

    field = prod_cfg["field"]

    # Check if field exists in the radar object
    if field not in radar.fields:
        alt_fields = {
            "reflectivity": ["reflectivity", "REF", "DZ", "corrected_reflectivity"],
            "velocity": ["velocity", "VEL", "VR", "corrected_velocity",
                         "dealiased_velocity"],
        }
        found = False
        for alt in alt_fields.get(product, []):
            if alt in radar.fields:
                field = alt
                found = True
                break
        if not found:
            raise HTTPException(404, f"Field '{product}' not in radar data. "
                                f"Available: {list(radar.fields.keys())}")

    # Dealias velocity — try region-based first, then fourdd
    if product == "velocity":
        _dealiased = False
        # Method 1: region-based (works well for most cases)
        try:
            dealiased = pyart.correct.dealias_region_based(
                radar, vel_field=field, centered=True
            )
            radar.add_field("dealiased_velocity", dealiased, replace_existing=True)
            field = "dealiased_velocity"
            _dealiased = True
        except Exception as e:
            logger.warning(f"Region-based dealiasing failed: {e}")
        # Method 2: unwrap-based fallback
        if not _dealiased:
            try:
                dealiased = pyart.correct.dealias_unwrap_phase(
                    radar, vel_field=field
                )
                radar.add_field("dealiased_velocity", dealiased, replace_existing=True)
                field = "dealiased_velocity"
                _dealiased = True
            except Exception as e:
                logger.warning(f"Unwrap dealiasing also failed: {e}")

    # Find a sweep that has data for the requested field.
    # NEXRAD VCP split-cuts put reflectivity on sweep 0 and velocity on
    # sweep 1 at the same elevation angle — we need to search for the
    # first sweep that actually contains valid data.
    sweep_idx = min(sweep, radar.nsweeps - 1)
    for candidate in range(sweep_idx, min(sweep_idx + 4, radar.nsweeps)):
        s0 = radar.sweep_start_ray_index["data"][candidate]
        s1 = radar.sweep_end_ray_index["data"][candidate]
        check = radar.fields[field]["data"][s0:s1 + 1]
        if hasattr(check, "count"):
            # masked array — count non-masked
            if check.count() > 0:
                sweep_idx = candidate
                break
        else:
            if np.isfinite(np.asarray(check)).any():
                sweep_idx = candidate
                break

    sweep_start = radar.sweep_start_ray_index["data"][sweep_idx]
    sweep_end = radar.sweep_end_ray_index["data"][sweep_idx]

    # Extract gate positions and data for this sweep only
    # Use get_gate_x_y_z for Cartesian positions relative to radar
    xg, yg, zg = radar.get_gate_x_y_z(sweep_idx)  # meters from radar
    field_data = radar.fields[field]["data"][sweep_start:sweep_end + 1]
    if hasattr(field_data, "filled"):
        field_data = field_data.filled(np.nan)
    field_data = np.asarray(field_data, dtype=np.float32)

    # Build output grid
    n_bins = int(2 * max_range_m / grid_spacing_m)
    sum_2d = np.zeros((n_bins, n_bins), dtype=np.float64)
    count_2d = np.zeros((n_bins, n_bins), dtype=np.int32)

    # Bin gate data into grid cells (nearest-neighbor binning)
    # xg, yg are in meters; convert to grid indices
    half = max_range_m
    xi = ((xg + half) / grid_spacing_m).astype(np.int32)
    yi = ((yg + half) / grid_spacing_m).astype(np.int32)

    # Flatten for fast indexing
    xi_flat = xi.ravel()
    yi_flat = yi.ravel()
    data_flat = field_data.ravel()

    # Mask valid points (in-bounds AND finite data)
    valid = ((xi_flat >= 0) & (xi_flat < n_bins) &
             (yi_flat >= 0) & (yi_flat < n_bins) &
             np.isfinite(data_flat))

    xi_v = xi_flat[valid]
    yi_v = yi_flat[valid]
    dv = data_flat[valid]

    # Accumulate (sum + count for averaging overlapping gates)
    np.add.at(sum_2d, (yi_v, xi_v), dv)
    np.add.at(count_2d, (yi_v, xi_v), 1)

    # Average where multiple gates fall in same bin; NaN elsewhere
    grid_2d = np.full((n_bins, n_bins), np.nan, dtype=np.float32)
    mask = count_2d > 0
    grid_2d[mask] = (sum_2d[mask] / count_2d[mask]).astype(np.float32)

    # Fill single-pixel radial gaps with nearest-neighbor average.
    # Gaps appear between radar beams at far range where angular spacing
    # exceeds the grid cell size.
    gaps = ~mask
    if gaps.any():
        from scipy.ndimage import uniform_filter
        # Compute neighborhood mean and count of valid neighbors
        filled = np.where(mask, grid_2d, 0.0)
        neighbor_sum = uniform_filter(filled.astype(np.float64), size=3, mode='constant')
        neighbor_cnt = uniform_filter(mask.astype(np.float64), size=3, mode='constant')
        fill_mask = gaps & (neighbor_cnt > 0.2)  # at least ~2 of 9 neighbors have data
        grid_2d[fill_mask] = (neighbor_sum[fill_mask] / neighbor_cnt[fill_mask]).astype(np.float32)

    # Free intermediate arrays
    del xg, yg, zg, field_data, xi, yi, xi_flat, yi_flat, data_flat

    # Grid is in natural order: row 0 = south, row N = north
    # (y index increases with northward distance from radar)
    data_2d = grid_2d

    # Get geographic bounds — fall back to site table if radar metadata
    # has no position (common in pre-2008 Message Type 1 files)
    lat_center = float(radar.latitude["data"][0])
    lon_center = float(radar.longitude["data"][0])

    if abs(lat_center) < 0.01 and abs(lon_center) < 0.01:
        # Position missing — look up from site table via instrument name
        site_id = radar.metadata.get("instrument_name", "").upper().strip()
        if site_id in NEXRAD_SITES:
            lat_center, lon_center = NEXRAD_SITES[site_id][:2]
            logger.info(f"Using site table position for {site_id}: {lat_center}, {lon_center}")
        else:
            logger.warning(f"Radar position is 0,0 and site '{site_id}' not in table")

    dy_deg = max_range_m / 111320.0
    dx_deg = max_range_m / (111320.0 * math.cos(math.radians(lat_center)))

    bounds = [
        [lat_center - dy_deg, lon_center - dx_deg],
        [lat_center + dy_deg, lon_center + dx_deg],
    ]

    # Scan time
    try:
        scan_time = pyart.util.datetime_from_radar(radar).strftime(
            "%Y-%m-%d %H:%M:%S UTC"
        )
    except Exception:
        scan_time = "unknown"

    # Elevation angle
    try:
        elev = float(radar.fixed_angle["data"][sweep_idx])
    except Exception:
        elev = 0.5

    metadata = {
        "bounds": bounds,
        "site": radar.metadata.get("instrument_name", ""),
        "scan_time": scan_time,
        "product": product,
        "tilt": round(elev, 1),
        "lat_center": lat_center,
        "lon_center": lon_center,
        "grid_spacing_m": grid_spacing_m,
        "max_range_m": max_range_m,
    }

    return data_2d, metadata


# ── API Endpoints ─────────────────────────────────────────────

@router.get("/sites")
async def get_nearby_sites(
    lat: float = Query(..., description="Storm center latitude"),
    lon: float = Query(..., description="Storm center longitude"),
    max_range_km: float = Query(300, description="Max distance in km"),
):
    """Return NEXRAD sites within range of a given lat/lon."""
    results = []
    for site_id, (slat, slon, name) in NEXRAD_SITES.items():
        dist = _haversine_km(lat, lon, slat, slon)
        if dist <= max_range_km:
            results.append({
                "site": site_id,
                "name": name,
                "lat": slat,
                "lon": slon,
                "distance_km": round(dist, 1),
            })
    results.sort(key=lambda x: x["distance_km"])
    return JSONResponse({"sites": results, "count": len(results)})


@router.get("/scans")
async def get_available_scans(
    site: str = Query(..., description="NEXRAD site ID (e.g., KBYX)"),
    datetime: str = Query(..., description="ISO datetime (e.g., 2022-09-28T18:00:00)"),
    window_min: int = Query(60, description="Search window in minutes"),
):
    """List available NEXRAD scans near a given time."""
    site = site.upper()
    if site not in NEXRAD_SITES:
        raise HTTPException(400, f"Unknown NEXRAD site: {site}")

    try:
        dt = _dt.fromisoformat(datetime.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(400, f"Invalid datetime: {datetime}")

    scans = _list_scans_s3(site, dt, window_min)

    # Find the index of the closest scan to the requested time
    closest_idx = 0
    if scans:
        min_delta = scans[0]["delta_sec"]
        for i, s in enumerate(scans):
            if s["delta_sec"] < min_delta:
                min_delta = s["delta_sec"]
                closest_idx = i

    return JSONResponse({
        "site": site,
        "requested_time": dt.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "window_min": window_min,
        "scans": [
            {
                "s3_key": s["s3_key"],
                "scan_time": s["scan_time"],
                "delta_sec": s["delta_sec"],
            }
            for s in scans
        ],
        "count": len(scans),
        "closest_index": closest_idx,
    })


@router.get("/frame")
async def get_radar_frame(
    site: str = Query(..., description="NEXRAD site ID"),
    s3_key: str = Query(..., description="S3 key from /scans endpoint"),
    product: str = Query("reflectivity", description="reflectivity or velocity"),
    tilt: int = Query(0, description="Sweep/tilt index (0 = lowest)"),
    max_range_km: int = Query(460, description="Max radar range in km"),
    grid_spacing_m: int = Query(1000, description="Grid spacing in meters"),
):
    """
    Render a NEXRAD radar frame as a geographic overlay image + raw data for hover.
    """
    site = site.upper()
    if product not in PRODUCTS:
        raise HTTPException(400, f"Unknown product: {product}. Use: {list(PRODUCTS.keys())}")

    prod_cfg = PRODUCTS[product]

    # Check in-memory cache
    cache_key = f"{site}:{s3_key}:{product}:{tilt}:{max_range_km}:{grid_spacing_m}"
    cached = _cache_get(cache_key)
    if cached:
        return JSONResponse(cached)

    # Check GCS cache
    gcs_result = _gcs_get_frame(site, s3_key, product, tilt, max_range_km)
    if gcs_result:
        _cache_put(cache_key, gcs_result)
        return JSONResponse(gcs_result)

    # Read and process the radar data
    radar = _read_nexrad_level2(s3_key)
    data_2d, metadata = _grid_radar(
        radar, product=product, sweep=tilt,
        grid_spacing_m=grid_spacing_m,
        max_range_m=max_range_km * 1000,
    )
    radar = None  # free memory

    # Render image (flip so row 0 = north for image display)
    image = _render_radar_image(
        np.flipud(data_2d), prod_cfg["lut"], prod_cfg["vmin"], prod_cfg["vmax"], scale=1
    )

    # Encode raw data for hover readout (also flipped for north-at-top display)
    hover_data = _encode_data_uint8(np.flipud(data_2d), prod_cfg["vmin"], prod_cfg["vmax"])

    result = {
        "image": image,
        **hover_data,
        "bounds": metadata["bounds"],
        "site": site,
        "scan_time": metadata["scan_time"],
        "product": product,
        "tilt": metadata["tilt"],
        "units": prod_cfg["units"],
        "label": prod_cfg["label"],
    }

    # Cache
    _cache_put(cache_key, result)
    _gcs_put_frame(site, s3_key, product, tilt, result, max_range_km)

    return JSONResponse(result)


@router.get("/storm_relative")
async def get_storm_relative_frame(
    site: str = Query(..., description="NEXRAD site ID"),
    s3_key: str = Query(..., description="S3 key from /scans endpoint"),
    center_lat: float = Query(..., description="Storm center latitude"),
    center_lon: float = Query(..., description="Storm center longitude"),
    product: str = Query("reflectivity", description="reflectivity or velocity"),
    tilt: int = Query(0, description="Sweep/tilt index"),
    grid_spacing_km: float = Query(2.0, description="Output grid spacing in km"),
    domain_km: float = Query(200.0, description="Half-domain size in km"),
):
    """
    Render NEXRAD data in storm-relative Cartesian coordinates,
    matching the TC-RADAR plan-view grid for direct comparison.
    """
    site = site.upper()
    if product not in PRODUCTS:
        raise HTTPException(400, f"Unknown product: {product}")

    prod_cfg = PRODUCTS[product]

    # Check cache
    cache_key = (f"sr:{site}:{s3_key}:{product}:{tilt}:"
                 f"{center_lat:.3f}:{center_lon:.3f}:{grid_spacing_km}:{domain_km}")
    cached = _cache_get(cache_key)
    if cached:
        return JSONResponse(cached)

    # Read and grid to geographic coordinates
    radar = _read_nexrad_level2(s3_key)
    data_geo, metadata = _grid_radar(
        radar, product=product, sweep=tilt,
        grid_spacing_m=1000,  # intermediate grid (1km matches /frame default)
        max_range_m=int((domain_km + 50) * 1000),  # +50 km margin
    )
    radar = None

    # Build storm-relative output grid
    n_pts = int(2 * domain_km / grid_spacing_km) + 1
    x_km = np.linspace(-domain_km, domain_km, n_pts)
    y_km = np.linspace(-domain_km, domain_km, n_pts)

    # Convert geographic grid to storm-relative km
    bounds = metadata["bounds"]
    lat_center_radar = metadata["lat_center"]
    lon_center_radar = metadata["lon_center"]

    ny_geo, nx_geo = data_geo.shape
    lats_geo = np.linspace(bounds[0][0], bounds[1][0], ny_geo)
    lons_geo = np.linspace(bounds[0][1], bounds[1][1], nx_geo)

    # Convert geo coords to storm-relative km
    km_per_deg_lat = 111.0
    km_per_deg_lon = 111.0 * math.cos(math.radians(center_lat))
    x_geo_km = (lons_geo - center_lon) * km_per_deg_lon
    y_geo_km = (lats_geo - center_lat) * km_per_deg_lat

    # Interpolate from geographic grid to storm-relative grid
    RegularGridInterpolator = _get_scipy_interp()
    if RegularGridInterpolator is None:
        raise HTTPException(500, "scipy not available")

    # Replace NaN with a fill value for interpolation
    fill_val = prod_cfg["vmin"] - 999
    data_clean = np.where(np.isfinite(data_geo), data_geo, fill_val)

    interp = RegularGridInterpolator(
        (y_geo_km, x_geo_km), data_clean,
        method="nearest", bounds_error=False, fill_value=fill_val,
    )

    # Create output grid
    yy, xx = np.meshgrid(y_km, x_km, indexing="ij")
    pts = np.column_stack([yy.ravel(), xx.ravel()])
    data_sr = interp(pts).reshape(n_pts, n_pts).astype(np.float32)

    # Restore NaN for fill values
    data_sr[data_sr <= fill_val + 1] = np.nan

    # Flip so north is at top
    data_sr = np.flipud(data_sr)

    # Render image
    image = _render_radar_image(
        data_sr, prod_cfg["lut"], prod_cfg["vmin"], prod_cfg["vmax"], scale=1
    )

    # Encode hover data
    hover_data = _encode_data_uint8(data_sr, prod_cfg["vmin"], prod_cfg["vmax"])

    result = {
        "image": image,
        **hover_data,
        "x_km": x_km.tolist(),
        "y_km": y_km.tolist(),
        "site": site,
        "scan_time": metadata["scan_time"],
        "product": product,
        "tilt": metadata["tilt"],
        "units": prod_cfg["units"],
        "label": prod_cfg["label"],
        "center_lat": center_lat,
        "center_lon": center_lon,
        "domain_km": domain_km,
        "grid_spacing_km": grid_spacing_km,
    }

    _cache_put(cache_key, result)

    return JSONResponse(result)
