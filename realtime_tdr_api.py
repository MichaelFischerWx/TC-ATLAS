"""
realtime_tdr_api.py — Real-Time TDR Endpoints
===============================================
Add-on module for tc_radar_api.py that provides endpoints for browsing
and visualizing real-time Tail Doppler Radar (TDR) analyses from
seb.omao.noaa.gov/pub/flight/radar/.

Also provides GOES IR satellite imagery endpoints for real-time
storm context, sourcing ABI Band 13 (10.3 µm clean IR window) data
from NOAA's public AWS S3 buckets with xarray byte-range subsetting.

How to integrate:
    In tc_radar_api.py, add near the bottom:
        from realtime_tdr_api import router as realtime_router
        app.include_router(realtime_router, prefix="/realtime")

Or simply paste the router endpoints into tc_radar_api.py directly.

Dependencies (all already in tc_radar_api.py):
    fastapi, xarray, numpy, matplotlib, requests (add if not present)
Additional for GOES IR: s3fs, pyproj, Pillow
"""

import base64
import gc
import gzip
import io
import re
import time
from collections import OrderedDict
from datetime import datetime as _dt, timedelta, timezone
from html.parser import HTMLParser
from typing import Optional

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response

from scipy.interpolate import RegularGridInterpolator

try:
    import requests as _requests
except ImportError:
    import urllib.request as _urllib
    _requests = None

# Optional GOES IR dependencies — LAZY loaded to save ~80 MB RAM at startup.
# The actual imports happen inside _get_s3fs_module() and _get_pyproj_module()
# only when an IR endpoint is called.
_s3fs_mod = None      # lazy: import s3fs
_pyproj_mod = None    # lazy: import pyproj


def _get_s3fs_module():
    """Lazy-import s3fs on first use."""
    global _s3fs_mod
    if _s3fs_mod is None:
        try:
            import s3fs
            _s3fs_mod = s3fs
        except ImportError:
            return None
    return _s3fs_mod


def _get_pyproj_module():
    """Lazy-import pyproj on first use."""
    global _pyproj_mod
    if _pyproj_mod is None:
        try:
            import pyproj
            _pyproj_mod = pyproj
        except ImportError:
            return None
    return _pyproj_mod

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SEB_BASE = "https://seb.omao.noaa.gov/pub/flight/radar"

# Variable mapping: real-time TDR → display metadata
# key: variable name in the NetCDF file
# value: (display_name, colormap, units, vmin, vmax)
RT_VARIABLES = {
    "TANGENTIAL_WIND": ("Tangential Wind",   "jet",        "m/s",  -10,  80),
    "RADIAL_WIND":     ("Radial Wind",        "RdBu_r",    "m/s",  -30,  30),
    "W":               ("Vertical Velocity",  "RdBu_r",    "m/s",   -5,   5),
    "REFLECTIVITY":    ("Reflectivity",       "Spectral_r", "dBZ", -10,  65),
    "WIND_SPEED":      ("Wind Speed",         "inferno",   "m/s",    0,  80),
    "VORT":            ("Relative Vorticity", "RdBu_r",    "s⁻¹", -5e-3, 5e-3),
    "U":               ("Eastward Wind (U)",  "RdBu_r",    "m/s",  -40,  40),
    "V":               ("Northward Wind (V)", "RdBu_r",    "m/s",  -40,  40),
}

# Derived variable: earth-relative wind speed from U and V
RT_DERIVED = {
    "EARTH_REL_WSPD": {
        "display_name": "Earth-Rel. Wind Speed",
        "components": ("U", "V"),
        "cmap": "jet",
        "units": "m/s",
        "vmin": 0,
        "vmax": 80,
    }
}

DEFAULT_RT_VARIABLE = "TANGENTIAL_WIND"

# ---------------------------------------------------------------------------
# GOES IR Satellite Configuration
# ---------------------------------------------------------------------------
# Satellite buckets (public, no auth needed)
#   GOES-East: GOES-16 (pre Apr 2025) / GOES-19 (post Apr 2025)
#   GOES-West: GOES-18
GOES_BUCKETS = {
    "east_16": "noaa-goes16",
    "east_19": "noaa-goes19",
    "west":    "noaa-goes18",
}
# Sub-satellite longitude for geostationary projection
GOES_LON_0 = {"east": -75.2, "west": -137.2}
GOES_SAT_HEIGHT = 35786023.0        # metres above Earth centre
GOES_TRANSITION_DT = _dt(2025, 4, 4, 15, 0, 0, tzinfo=timezone.utc)  # GOES-19 operational

IR_PRODUCT = "ABI-L2-CMIPF"         # full-disk Cloud & Moisture Imagery
IR_BAND = 13                         # 10.3 µm clean longwave IR window
IR_VARIABLE = "CMI"                  # variable name inside CMI single-band file
IR_LOOKBACK_H = 4                    # hours of lookback
IR_INTERVAL_MIN = 30                 # minutes between animation frames (was 15)
IR_N_FRAMES = int(IR_LOOKBACK_H * 60 / IR_INTERVAL_MIN) + 1  # 9 (t=0 … t−4h)
IR_BOX_DEG = 8.0                     # geographic crop box (degrees, was 10)
IR_VMIN = 190.0                      # brightness temperature colour limits (K)
IR_VMAX = 310.0

# Enhanced IR colormap LUT (cold → bright/colourful, warm → dark grey)
# Same stops as the archive MergIR LUT in tc_radar_api.py
_IR_STOPS = [
    (0.00,   8,   8,   8),
    (0.15,  40,  40,  40),
    (0.30,  90,  90,  90),
    (0.40, 140, 140, 140),
    (0.50, 200, 200, 200),
    (0.55,   0, 180, 255),
    (0.60,   0, 100, 255),
    (0.65,   0, 255,   0),
    (0.70, 255, 255,   0),
    (0.75, 255, 180,   0),
    (0.80, 255,  80,   0),
    (0.85, 255,   0,   0),
    (0.90, 180,   0, 180),
    (0.95, 255, 180, 255),
    (1.00, 255, 255, 255),
]


def _build_ir_lut() -> np.ndarray:
    """Build a 256-entry uint8 RGBA LUT for IR brightness temperatures."""
    lut = np.zeros((256, 4), dtype=np.uint8)
    for i in range(256):
        frac = i / 255.0
        lo, hi = _IR_STOPS[0], _IR_STOPS[-1]
        for s in range(len(_IR_STOPS) - 1):
            if _IR_STOPS[s][0] <= frac <= _IR_STOPS[s + 1][0]:
                lo, hi = _IR_STOPS[s], _IR_STOPS[s + 1]
                break
        t = 0.0 if hi[0] == lo[0] else (frac - lo[0]) / (hi[0] - lo[0])
        lut[i, 0] = int(lo[1] + t * (hi[1] - lo[1]) + 0.5)
        lut[i, 1] = int(lo[2] + t * (hi[2] - lo[2]) + 0.5)
        lut[i, 2] = int(lo[3] + t * (hi[3] - lo[3]) + 0.5)
        lut[i, 3] = 220  # semi-transparent alpha
    return lut


_IR_LUT = _build_ir_lut()

# ---------------------------------------------------------------------------
# Caching
# ---------------------------------------------------------------------------
_rt_ds_cache = OrderedDict()       # file_url → (xr.Dataset, timestamp)
_rt_dir_cache = OrderedDict()      # dir_url  → (link_list, timestamp)
_RT_DS_CACHE_MAX = 1               # ONE dataset at a time — each can be 100-300 MB
_RT_DIR_CACHE_TTL = 300            # 5 minutes for directory listings

# GOES IR frame cache: (file_url, frame_index) → rendered result dict
# Kept small because browsers cache via Cache-Control headers.
_rt_ir_cache = OrderedDict()
_RT_IR_CACHE_MAX = 3               # minimal — browser handles long-term caching

# Shared S3 filesystem (lazy-initialised)
_goes_fs = None

router = APIRouter(tags=["realtime"])

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MAX_DOWNLOAD_MB = 150  # refuse to download files larger than this

def _fetch_bytes(url: str, timeout: int = 60, max_mb: float = _MAX_DOWNLOAD_MB) -> bytes:
    """Fetch raw bytes from a URL with an optional size guard."""
    if _requests:
        # Stream the response so we can check Content-Length before committing
        resp = _requests.get(url, timeout=timeout, stream=True)
        resp.raise_for_status()
        cl = resp.headers.get("Content-Length")
        if cl and int(cl) > max_mb * 1024 * 1024:
            resp.close()
            raise ValueError(
                f"File too large ({int(cl) / 1024 / 1024:.0f} MB, limit {max_mb:.0f} MB): {url}"
            )
        # Read in chunks to enforce size limit even without Content-Length
        chunks = []
        total = 0
        limit = int(max_mb * 1024 * 1024)
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            total += len(chunk)
            if total > limit:
                resp.close()
                raise ValueError(
                    f"File exceeds {max_mb:.0f} MB download limit: {url}"
                )
            chunks.append(chunk)
        return b"".join(chunks)
    else:
        req = _urllib.Request(url)
        with _urllib.urlopen(req, timeout=timeout) as resp:
            cl = resp.headers.get("Content-Length")
            if cl and int(cl) > max_mb * 1024 * 1024:
                raise ValueError(
                    f"File too large ({int(cl) / 1024 / 1024:.0f} MB, limit {max_mb:.0f} MB): {url}"
                )
            return resp.read()


_HTTP_HEADERS = {"User-Agent": "TC-RADAR/1.0 (research; michaelfischerwx@gmail.com)"}


def _fetch_text(url: str, timeout: int = 30) -> str:
    """Fetch text content from a URL."""
    if _requests:
        resp = _requests.get(url, timeout=timeout, headers=_HTTP_HEADERS)
        resp.raise_for_status()
        return resp.text
    else:
        req = _urllib.Request(url, headers=_HTTP_HEADERS)
        with _urllib.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")


class _LinkParser(HTMLParser):
    """Extract href links from an Apache directory listing."""
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for name, value in attrs:
                if name == "href" and value and not value.startswith("?") and not value.startswith("/"):
                    self.links.append(value)


def _parse_directory(url: str) -> list[str]:
    """Fetch an Apache directory listing and return the link names."""
    now = time.time()
    if url in _rt_dir_cache:
        links, ts = _rt_dir_cache[url]
        if now - ts < _RT_DIR_CACHE_TTL:
            _rt_dir_cache.move_to_end(url)
            return links

    html = _fetch_text(url)
    parser = _LinkParser()
    parser.feed(html)
    links = parser.links
    _rt_dir_cache[url] = (links, now)
    if len(_rt_dir_cache) > 50:
        _rt_dir_cache.popitem(last=False)
    return links


def _open_rt_dataset(file_url: str) -> xr.Dataset:
    """Download, decompress (if .gz), and open a real-time TDR NetCDF file.

    Memory-conscious: explicitly frees intermediate byte buffers and forces
    garbage collection when evicting cached datasets.
    """
    if file_url in _rt_ds_cache:
        ds, _ = _rt_ds_cache[file_url]
        _rt_ds_cache.move_to_end(file_url)
        return ds

    # Evict oldest cached dataset BEFORE downloading new one to minimise peak RAM
    if len(_rt_ds_cache) >= _RT_DS_CACHE_MAX:
        _evicted_url, (evicted_ds, _) = _rt_ds_cache.popitem(last=False)
        try:
            evicted_ds.close()
        except Exception:
            pass
        del evicted_ds
        gc.collect()

    raw = _fetch_bytes(file_url, timeout=120)

    # Decompress if gzipped — check the actual bytes, not just the URL,
    # because the HTTP server may transparently decompress via Content-Encoding.
    # Gzip magic number is b'\x1f\x8b'; HDF5/NetCDF4 starts with b'\x89HDF' or b'CDF'.
    if raw[:2] == b'\x1f\x8b':
        decompressed = gzip.decompress(raw)
        del raw          # free compressed copy immediately
        raw = decompressed
        del decompressed

    # Detect file format from magic bytes and choose the right xarray engine.
    # netCDF3 classic starts with b'CDF'; HDF5/netCDF4 starts with b'\x89HDF'.
    if raw[:3] == b'CDF':
        engine = "scipy"
    else:
        engine = "h5netcdf"

    buf = io.BytesIO(raw)
    del raw  # free raw bytes — xarray reads from the BytesIO buffer
    gc.collect()

    ds = xr.open_dataset(buf, engine=engine)
    _rt_ds_cache[file_url] = (ds, time.time())
    return ds


def _cmap_to_plotly(cmap_name: str, n_steps: int = 64) -> list:
    """Convert a matplotlib colormap name to a Plotly-compatible colorscale."""
    cmap = plt.get_cmap(cmap_name)
    return [
        [round(i / (n_steps - 1), 4),
         f"rgb({int(c[0]*255)},{int(c[1]*255)},{int(c[2]*255)})"]
        for i, c in enumerate(cmap(np.linspace(0, 1, n_steps)))
    ]


def _clean_2d(data):
    """Convert 2D numpy array to JSON-safe nested list (NaN → None)."""
    return [[None if np.isnan(v) else round(float(v), 4) for v in row] for row in data]


def _get_xy_coords(ds):
    """Extract x/y coordinate arrays in km (storm-centered)."""
    x = ds["x"].values.astype(float)
    y = ds["y"].values.astype(float)

    # The file stores grid indices; convert to km using resolution and origin offset.
    # If coordinates are already in km (e.g. values range beyond 0–250), use them directly.
    if x.max() <= 250 and x.min() >= 0:
        res_ew = float(ds.attrs.get("EAST_WEST_RESOLUTION_KM", 2.0))
        res_ns = float(ds.attrs.get("NORTH_SOUTH_RESOLUTION_KM", 2.0))
        origin_ew = float(ds.attrs.get("ORIGIN_EAST_WEST_DISTANCE_FROM_LOWER_LEFT_CORNER_KM", 250.0))
        origin_ns = float(ds.attrs.get("ORIGIN_NORTH_SOUTH_DISTANCE_FROM_LOWER_LEFT_CORNER_KM", 250.0))
        x_km = (x * res_ew) - origin_ew
        y_km = (y * res_ns) - origin_ns
    else:
        x_km = x
        y_km = y
    return x_km, y_km


def _get_level_axis(ds):
    """Return the vertical level array in km."""
    return ds["level"].values.astype(float)


def _extract_2d(ds, variable: str, level_km: float):
    """Extract a 2D (x, y) slice at a given height level, handling dim order."""
    levels = _get_level_axis(ds)
    z_idx = int(np.argmin(np.abs(levels - level_km)))
    actual_level = float(levels[z_idx])

    if variable in RT_DERIVED:
        info = RT_DERIVED[variable]
        u_name, v_name = info["components"]
        # Use xarray named transpose to guarantee (y, x) output
        u = ds[u_name].isel(time=0, level=z_idx).transpose("y", "x").values
        v = ds[v_name].isel(time=0, level=z_idx).transpose("y", "x").values
        data = np.sqrt(u**2 + v**2)
    else:
        # Use xarray named transpose — safe regardless of file dim order
        data = ds[variable].isel(time=0, level=z_idx).transpose("y", "x").values

    # Unit conversion: real-time xy.nc stores VORT in 10⁻³ s⁻¹ (.001/seconds) → s⁻¹
    if variable == "VORT":
        data = data * 1e-3

    return data, actual_level


def _interp_tdr_along_track(
    ds, variable: str, level_km: float, x_pts: np.ndarray, y_pts: np.ndarray
) -> np.ndarray:
    """
    Bilinear-interpolate a TDR 2D field to arbitrary (x_km, y_km) points.

    Returns an array of interpolated values (NaN where outside the domain).
    """
    data, actual_level = _extract_2d(ds, variable, level_km)
    # data is (y, x) after the transpose in _extract_2d
    x_km, y_km = _get_xy_coords(ds)
    ny, nx = data.shape

    # Grid spacing (assumed regular)
    dx = float(x_km[1] - x_km[0]) if nx > 1 else 1.0
    dy = float(y_km[1] - y_km[0]) if ny > 1 else 1.0

    # Convert query points to fractional grid indices
    fi = (x_pts - float(x_km[0])) / dx   # fractional x-index
    fj = (y_pts - float(y_km[0])) / dy   # fractional y-index

    result = np.full(len(x_pts), np.nan)
    for k in range(len(x_pts)):
        xi, yj = fi[k], fj[k]
        i0 = int(np.floor(xi))
        j0 = int(np.floor(yj))
        i1, j1 = i0 + 1, j0 + 1
        if i0 < 0 or i1 >= nx or j0 < 0 or j1 >= ny:
            continue
        # Bilinear weights
        wx = xi - i0
        wy = yj - j0
        # data is (y, x)
        v00 = data[j0, i0]
        v10 = data[j0, i1]
        v01 = data[j1, i0]
        v11 = data[j1, i1]
        if any(np.isnan(v) for v in [v00, v10, v01, v11]):
            # Nearest-neighbour fallback if any corner is NaN
            ni = int(round(xi))
            nj = int(round(yj))
            if 0 <= ni < nx and 0 <= nj < ny and not np.isnan(data[nj, ni]):
                result[k] = float(data[nj, ni])
            continue
        val = (v00 * (1 - wx) * (1 - wy) + v10 * wx * (1 - wy) +
               v01 * (1 - wx) * wy + v11 * wx * wy)
        result[k] = float(val)
    return result


def _interp_tdr_3d_along_track(
    ds, variable: str,
    x_pts: np.ndarray, y_pts: np.ndarray, z_pts_km: np.ndarray
) -> np.ndarray:
    """
    Trilinear-interpolate a TDR 3D field to arbitrary (x_km, y_km, height_km)
    points — i.e. at the aircraft's actual GPS altitude.

    Uses scipy RegularGridInterpolator for efficient 3D interpolation.
    Returns array of interpolated values (NaN where outside domain).
    """
    vol, levels = _extract_3d(ds, variable)  # (level, y, x)
    x_km, y_km = _get_xy_coords(ds)

    interp = RegularGridInterpolator(
        (levels.astype(float), y_km.astype(float), x_km.astype(float)),
        vol.astype(float),
        method="linear",
        bounds_error=False,
        fill_value=np.nan,
    )

    # Query points: (z, y, x) ordering to match grid axes
    pts = np.column_stack([z_pts_km, y_pts, x_pts])
    result = interp(pts)

    # Nearest-neighbor fallback for NaN results
    nan_mask = np.isnan(result)
    if np.any(nan_mask):
        interp_nn = RegularGridInterpolator(
            (levels.astype(float), y_km.astype(float), x_km.astype(float)),
            vol.astype(float),
            method="nearest",
            bounds_error=False,
            fill_value=np.nan,
        )
        result[nan_mask] = interp_nn(pts[nan_mask])

    return result


def _extract_3d(ds, variable: str, max_height_km: float = 18.0):
    """Extract the full 3D volume (level, y, x)."""
    levels = _get_level_axis(ds)
    h_mask = levels <= max_height_km + 0.01

    if variable in RT_DERIVED:
        info = RT_DERIVED[variable]
        u_name, v_name = info["components"]
        # Use xarray named transpose to guarantee (level, y, x) regardless
        # of the dimension order in the file.
        u = ds[u_name].isel(time=0).transpose("level", "y", "x").values
        v = ds[v_name].isel(time=0).transpose("level", "y", "x").values
        vol = np.sqrt(u**2 + v**2)
    else:
        # Use xarray named transpose — safe regardless of file dim order.
        vol = ds[variable].isel(time=0).transpose("level", "y", "x").values

    # Unit conversion: real-time xy.nc files store VORT in 10⁻³ s⁻¹
    # (.001/seconds per the file metadata), but the archive expects s⁻¹.
    if variable == "VORT":
        vol = vol * 1e-3

    # Trim to max height
    n_h = int(h_mask.sum())
    vol = vol[:n_h, :, :]
    return vol, levels[h_mask]


def _build_case_meta(ds) -> dict:
    """Build metadata dict from global attributes."""
    attrs = ds.attrs
    # Construct analysis center time
    hour = int(attrs.get("ANALYSIS CENTER HOUR", 0))
    minute = int(attrs.get("ANALYSIS CENTER MINUTE", 0))
    second = int(attrs.get("ANALYSIS CENTER SECOND", 0))
    year = int(attrs.get("FLIGHT YEAR", 0))
    month = int(attrs.get("FLIGHT MONTH", 0))
    day = int(attrs.get("FLIGHT DAY", 0))

    datetime_str = ""
    if year > 0:
        # Handle hour >= 24 (common in met data — e.g. hour 25 = 01Z next day)
        if hour >= 24:
            base_date = _dt(year, month, day, tzinfo=timezone.utc)
            adjusted = base_date + timedelta(hours=hour, minutes=minute, seconds=second)
            datetime_str = adjusted.strftime("%Y-%m-%d %H:%M:%SZ")
        else:
            datetime_str = f"{year:04d}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}:{second:02d}Z"

    return {
        "storm_name": str(attrs.get("STORM NAME", attrs.get("STMNAME", "Unknown"))).strip(),
        "mission_id": str(attrs.get("FLTNAME", "")).strip(),
        "datetime": datetime_str,
        "latitude": float(attrs.get("ORIGIN_LATITUDE", 0)),
        "longitude": float(attrs.get("ORIGIN_LONGITUDE", 0)),
        "radar": str(attrs.get("RADAR", "TAIL")).strip(),
        "experiment": str(attrs.get("EXPERIMENT", "")).strip(),
        "resolution_km": float(attrs.get("EAST_WEST_RESOLUTION_KM", 2.0)),
        "storm_motion_north_ms": float(attrs.get("NORTHWARD STORM MOTION (METERS PER SECOND)", -999)),
        "storm_motion_east_ms": float(attrs.get("EASTWARD STORM MOTION (METERS PER SECOND)", -999)),
        "analysis_level": str(attrs.get("ANALYSIS LEVEL (1--REAL-TIME,2--RESEARCH QUALITY)", "")).strip(),
        "melting_height_km": float(attrs.get("HEIGHT OF CENTER OF MELTING BAND (KM)", -999)),
        "vmax_kt": None,  # Not available in real-time files
    }


# ---------------------------------------------------------------------------
# GOES IR Helpers
# ---------------------------------------------------------------------------

def _get_goes_fs():
    """Return a shared s3fs filesystem for public NOAA GOES buckets."""
    global _goes_fs
    if _goes_fs is None:
        s3fs = _get_s3fs_module()
        if s3fs is None:
            return None
        _goes_fs = s3fs.S3FileSystem(anon=True)
    return _goes_fs


def _select_goes_sat(longitude: float, analysis_dt: _dt) -> tuple[str, str]:
    """
    Select GOES satellite based on storm longitude and analysis date.

    Returns (bucket_name, sat_key) where sat_key is 'east' or 'west'.
    GOES-East: lon > −115°  (GOES-16 before Apr 2025, GOES-19 after)
    GOES-West: lon ≤ −115°  (GOES-18)
    """
    if longitude > -115:
        sat_key = "east"
        # GOES-19 became operational GOES-East on 2025-04-04 15:00 UTC
        if analysis_dt.replace(tzinfo=timezone.utc) >= GOES_TRANSITION_DT:
            bucket = GOES_BUCKETS["east_19"]
        else:
            bucket = GOES_BUCKETS["east_16"]
    else:
        sat_key = "west"
        bucket = GOES_BUCKETS["west"]
    return bucket, sat_key


def _find_goes_file(bucket: str, target_dt: _dt, tolerance_min: int = 15) -> Optional[str]:
    """
    Find the GOES ABI Band 13 full-disk file closest to target_dt.

    Searches the S3 directory for the target hour, parses start-time from
    each filename, and returns the full S3 key of the best match (or None).
    """
    fs = _get_goes_fs()
    if fs is None:
        return None

    jday = target_dt.timetuple().tm_yday
    prefix = f"{bucket}/{IR_PRODUCT}/{target_dt.year}/{jday:03d}/{target_dt.hour:02d}/"

    try:
        files = fs.ls(prefix, detail=False)
    except Exception:
        return None

    # Filter to Band 13 files only
    band_tag = f"C{IR_BAND:02d}"
    candidates = [f for f in files if band_tag in f.split("/")[-1]]
    if not candidates:
        return None

    # Parse start timestamp from filename:
    #   GOES-16: OR_ABI-L2-CMIPF-M6C13-G16-s20231501200432_e…_c….nc
    #   GOES-19: OR_ABI-L2-CMIPF-M6C13_G19_s20253011300205_e…_c….nc
    best_file = None
    best_delta = timedelta(minutes=tolerance_min + 1)
    ts_re = re.compile(r"[-_]s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})")

    for fpath in candidates:
        fname = fpath.split("/")[-1]
        m = ts_re.search(fname)
        if not m:
            continue
        try:
            yr, jd, hh, mm, ss = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
            file_dt = _dt(yr, 1, 1, hh, mm, ss, tzinfo=timezone.utc) + timedelta(days=jd - 1)
            delta = abs(file_dt - target_dt.replace(tzinfo=timezone.utc))
            if delta < best_delta:
                best_delta = delta
                best_file = fpath
        except Exception:
            continue

    if best_delta > timedelta(minutes=tolerance_min):
        return None
    return best_file


def _latlon_to_goes_xy(lat: float, lon: float, sat_key: str) -> tuple[float, float]:
    """
    Convert geographic (lat, lon) to GOES fixed-grid (x, y) in radians.

    Uses the geostationary projection with sweep='x' (GOES-R convention).
    Returns (x_rad, y_rad).
    """
    pyproj = _get_pyproj_module()
    if pyproj is None:
        raise RuntimeError("pyproj is required for GOES IR subsetting")
    lon_0 = GOES_LON_0[sat_key]
    proj = pyproj.Proj(proj="geos", h=GOES_SAT_HEIGHT, lon_0=lon_0, sweep="x")
    x_m, y_m = proj(lon, lat)
    # Convert metres → scanning-angle radians (divide by satellite height)
    return x_m / GOES_SAT_HEIGHT, y_m / GOES_SAT_HEIGHT


def _open_goes_subset(s3_key: str, center_lat: float, center_lon: float,
                      sat_key: str) -> np.ndarray:
    """
    Open a GOES CMI file from S3 and return a geographically-subsetted
    2D brightness-temperature array (y, x) in Kelvin.

    Uses xarray + s3fs byte-range reads so only the subset chunks are
    downloaded (~2-4 MB instead of ~25 MB).
    """
    fs = _get_goes_fs()
    if fs is None:
        raise RuntimeError("s3fs not available")

    half = IR_BOX_DEG / 2.0
    x_min, y_min = _latlon_to_goes_xy(center_lat - half, center_lon - half, sat_key)
    x_max, y_max = _latlon_to_goes_xy(center_lat + half, center_lon + half, sat_key)
    # Ensure ascending order for x, descending for y (GOES convention)
    x_lo, x_hi = min(x_min, x_max), max(x_min, x_max)
    y_lo, y_hi = min(y_min, y_max), max(y_min, y_max)

    fobj = fs.open(f"s3://{s3_key}", "rb")
    try:
        ds = xr.open_dataset(fobj, engine="h5netcdf")

        # Subset — GOES y-axis is descending, x is ascending
        ds_sub = ds.sel(x=slice(x_lo, x_hi), y=slice(y_hi, y_lo))

        # Extract brightness temperature
        if IR_VARIABLE in ds_sub:
            tb = ds_sub[IR_VARIABLE].values.astype(np.float32)
        else:
            # Some files use CMI_C13 instead of CMI
            alt_var = f"CMI_C{IR_BAND:02d}"
            if alt_var in ds_sub:
                tb = ds_sub[alt_var].values.astype(np.float32)
            else:
                raise ValueError(f"Neither {IR_VARIABLE} nor {alt_var} found in dataset")
    finally:
        ds.close()
        fobj.close()
        del ds, ds_sub  # noqa: F821
        gc.collect()
    return tb


def _render_ir_png(frame_2d: np.ndarray) -> Optional[str]:
    """
    Render a 2D Tb array to a base64-encoded PNG data-URL.
    Uses the enhanced IR colormap LUT (cold → bright colours).
    Returns None if all data is NaN.
    """
    from PIL import Image

    arr = np.asarray(frame_2d, dtype=np.float32)
    if not np.any(np.isfinite(arr)):
        return None

    # Normalise: cold clouds (low Tb) → high index → bright colours
    frac = 1.0 - (arr - IR_VMIN) / (IR_VMAX - IR_VMIN)
    frac = np.clip(frac, 0.0, 1.0)
    indices = (frac * 255).astype(np.uint8)

    # Apply LUT
    rgba = _IR_LUT[indices]  # (H, W, 4)

    # Set NaN / invalid pixels to transparent
    mask = ~np.isfinite(arr) | (arr <= 0)
    rgba[mask] = [0, 0, 0, 0]

    # NOTE: No vertical flip here.  GOES y-axis is descending (north at
    # row 0), which matches standard image orientation (top = north) and
    # Leaflet's L.imageOverlay expectation.  For Plotly underlays the
    # client swaps the y-axis bounds instead.

    img = Image.fromarray(rgba, "RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _build_frame_times(analysis_dt: _dt) -> list[_dt]:
    """
    Build list of target GOES scan times for the IR animation.
    Returns IR_N_FRAMES datetimes from t=0 (most recent) to t−4h.
    """
    base = analysis_dt.replace(tzinfo=timezone.utc) if analysis_dt.tzinfo is None else analysis_dt
    return [base - timedelta(minutes=i * IR_INTERVAL_MIN) for i in range(IR_N_FRAMES)]


def _parse_tdr_datetime(meta: dict) -> _dt:
    """Parse the analysis datetime from TDR case_meta dict."""
    dt_str = meta.get("datetime", "")
    if not dt_str:
        raise ValueError("No datetime in TDR metadata")
    # Format: "YYYY-MM-DD HH:MM:SSZ"
    dt_str = dt_str.rstrip("Z").strip()
    return _dt.fromisoformat(dt_str).replace(tzinfo=timezone.utc)


def _get_ir_bounds_km(center_lat: float) -> dict:
    """
    Return the IR box extents in km (for Plotly underlay positioning).
    Box is IR_BOX_DEG × IR_BOX_DEG centred on the storm.
    """
    half = IR_BOX_DEG / 2.0
    km_per_deg_lat = 111.0
    km_per_deg_lon = 111.0 * np.cos(np.radians(center_lat))
    return {
        "y_min_km": -half * km_per_deg_lat,
        "y_max_km":  half * km_per_deg_lat,
        "x_min_km": -half * km_per_deg_lon,
        "x_max_km":  half * km_per_deg_lon,
    }


def _get_variable_info(variable: str) -> dict:
    """Get display metadata for a variable key."""
    if variable in RT_VARIABLES:
        display_name, cmap, units, vmin, vmax = RT_VARIABLES[variable]
    elif variable in RT_DERIVED:
        info = RT_DERIVED[variable]
        display_name = info["display_name"]
        cmap = info["cmap"]
        units = info["units"]
        vmin = info["vmin"]
        vmax = info["vmax"]
    else:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")

    return {
        "key": variable,
        "display_name": display_name,
        "units": units,
        "vmin": vmin,
        "vmax": vmax,
        "colorscale": _cmap_to_plotly(cmap),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/missions")
def list_missions():
    """
    List available mission folders from the SEB radar archive.
    Returns folder names that look like missions (e.g. '20251028H1/').
    """
    try:
        links = _parse_directory(SEB_BASE + "/")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not reach SEB server: {e}")

    # Filter to directories that look like mission IDs (digits + letter + digit pattern)
    missions = []
    for link in links:
        name = link.rstrip("/")
        if re.match(r"^\d{6,8}[A-Za-z]\d", name):
            missions.append(name)

    # Sort reverse chronological
    missions.sort(reverse=True)
    return JSONResponse({"missions": missions})


@router.get("/files")
def list_files(
    mission: str = Query(..., description="Mission folder name, e.g. '20251028H1'"),
):
    """
    List available xy.nc(.gz) analysis files within a mission folder.
    Returns file entries with name and URL.
    """
    url = f"{SEB_BASE}/{mission}/"
    try:
        links = _parse_directory(url)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not list files for {mission}: {e}")

    # Filter to xy analysis files
    files = []
    for link in links:
        if "_xy.nc" in link:
            # Parse analysis time from filename like 251028H1_1349_xy.nc.gz
            m = re.match(r".*?_(\d{4})_xy\.nc", link)
            time_label = m.group(1) if m else ""
            files.append({
                "filename": link,
                "url": f"{SEB_BASE}/{mission}/{link}",
                "time_label": time_label,
            })

    files.sort(key=lambda f: f["filename"])
    return JSONResponse({"mission": mission, "files": files})


@router.get("/variables")
def list_rt_variables():
    """List available variables for real-time TDR files."""
    result = []
    for key, (display_name, _, units, _, _) in RT_VARIABLES.items():
        result.append({"key": key, "display_name": display_name, "units": units})
    for key, info in RT_DERIVED.items():
        result.append({"key": key, "display_name": info["display_name"], "units": info["units"]})
    return result


@router.get("/data")
def get_rt_data(
    file_url:   str   = Query(...,                           description="Full URL to the xy.nc(.gz) file"),
    variable:   str   = Query(DEFAULT_RT_VARIABLE,           description="Variable name"),
    level_km:   float = Query(2.0,            ge=0.0, le=18, description="Altitude in km"),
    overlay:    str   = Query("",                            description="Optional overlay variable"),
    wind_barbs: bool  = Query(False,                         description="Include subsampled U/V for wind barbs"),
):
    """Return a 2D plan-view data slice as JSON for client-side Plotly rendering."""
    if variable not in RT_VARIABLES and variable not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if overlay and overlay not in RT_VARIABLES and overlay not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'.")

    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open file: {e}")

    x_km, y_km = _get_xy_coords(ds)
    data, actual_level = _extract_2d(ds, variable, level_km)
    var_info = _get_variable_info(variable)
    case_meta = _build_case_meta(ds)

    result = {
        "data": _clean_2d(data),
        "x": np.round(x_km, 2).tolist(),
        "y": np.round(y_km, 2).tolist(),
        "actual_level_km": actual_level,
        "variable": var_info,
        "case_meta": case_meta,
    }

    # Optional overlay
    if overlay:
        ov_data, _ = _extract_2d(ds, overlay, level_km)
        ov_info = _get_variable_info(overlay)
        result["overlay"] = {
            "data": _clean_2d(ov_data),
            "display_name": ov_info["display_name"],
            "units": ov_info["units"],
            "vmin": ov_info["vmin"],
            "vmax": ov_info["vmax"],
        }

    # Optional wind barbs: subsampled U/V at requested height
    if wind_barbs:
        try:
            levels = _get_level_axis(ds)
            z_idx = int(np.argmin(np.abs(levels - level_km)))
            u_full = ds["U"].isel(time=0, level=z_idx).transpose("y", "x").values
            v_full = ds["V"].isel(time=0, level=z_idx).transpose("y", "x").values
            ny, nx = u_full.shape
            stride = max(1, min(nx, ny) // 20)
            result["wind_barbs"] = {
                "u": _clean_2d(u_full[::stride, ::stride]),
                "v": _clean_2d(v_full[::stride, ::stride]),
                "x": np.round(x_km[::stride], 2).tolist(),
                "y": np.round(y_km[::stride], 2).tolist(),
                "units": "m/s",
                "type": "earth_relative",
            }
        except Exception:
            pass

    # Quick tilt + RMW: run WCM at 2 km and 6 km only (lightweight, ~0.5s)
    try:
        levels = _get_level_axis(ds)
        attrs = ds.attrs if hasattr(ds, "attrs") else {}
        _su = float(attrs.get("EASTWARD STORM MOTION (METERS PER SECOND)", -999))
        _sv = float(attrs.get("NORTHWARD STORM MOTION (METERS PER SECOND)", -999))
        _has_mot = (_su != -999 and _sv != -999 and not np.isnan(_su) and not np.isnan(_sv))

        def _quick_center(target_km):
            zi = int(np.argmin(np.abs(levels - target_km)))
            u = ds["U"].isel(time=0, level=zi).transpose("y", "x").values
            v = ds["V"].isel(time=0, level=zi).transpose("y", "x").values
            if _has_mot:
                u = u - _su; v = v - _sv
            return _wcm_center_km(u, v, x_km, y_km, num_sectors=1, spad=6, num_iterations=3)

        c2 = _quick_center(2.0)
        if c2["converged"]:
            result["wcm_rmw_km"] = c2["rmw_km"]
            result["wcm_vt_max_ms"] = c2["vt_max_ms"]
            result["wcm_center_x_km"] = c2["center_x_km"]
            result["wcm_center_y_km"] = c2["center_y_km"]
            # 2-to-6 km tilt (each level uses its own vorticity centroid,
            # consistent with tilt_profile parallel approach)
            c6 = _quick_center(6.0)
            if c6["converged"] and c2["center_x_km"] is not None and c6["center_x_km"] is not None:
                dx = c6["center_x_km"] - c2["center_x_km"]
                dy = c6["center_y_km"] - c2["center_y_km"]
                result["tilt_2_6_km"] = round(np.sqrt(dx**2 + dy**2), 1)
    except Exception:
        pass

    return JSONResponse(result)


@router.get("/cross_section")
def get_rt_cross_section(
    file_url:   str   = Query(...,                           description="Full URL to the xy.nc(.gz) file"),
    variable:   str   = Query(DEFAULT_RT_VARIABLE,           description="Variable name"),
    x0:         float = Query(...,                           description="Start X (km)"),
    y0:         float = Query(...,                           description="Start Y (km)"),
    x1:         float = Query(...,                           description="End X (km)"),
    y1:         float = Query(...,                           description="End Y (km)"),
    n_points:   int   = Query(150,            ge=10, le=500, description="Sample points along line"),
    overlay:    str   = Query("",                            description="Optional overlay variable"),
):
    """Return a vertical cross-section along a user-defined line."""
    if variable not in RT_VARIABLES and variable not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if overlay and overlay not in RT_VARIABLES and overlay not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'.")

    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open file: {e}")

    x_km, y_km = _get_xy_coords(ds)
    levels = _get_level_axis(ds)
    n_heights = len(levels)

    # Sample points along the line
    xs = np.linspace(x0, x1, n_points)
    ys = np.linspace(y0, y1, n_points)

    # Find nearest grid indices
    xi_idx = np.array([int(np.argmin(np.abs(x_km - xp))) for xp in xs])
    yi_idx = np.array([int(np.argmin(np.abs(y_km - yp))) for yp in ys])

    # Distance along line
    distance = np.sqrt((xs - x0)**2 + (ys - y0)**2)

    def _extract_cs(var_key):
        vol, _ = _extract_3d(ds, var_key, max_height_km=18.0)  # (level, y, x)
        cs = np.full((n_heights, n_points), np.nan)
        for h in range(n_heights):
            for p in range(n_points):
                cs[h, p] = vol[h, yi_idx[p], xi_idx[p]]
        return cs

    cs_data = _extract_cs(variable)
    var_info = _get_variable_info(variable)
    case_meta = _build_case_meta(ds)

    result = {
        "cross_section": _clean_2d(cs_data),
        "distance_km": np.round(distance, 2).tolist(),
        "height_km": np.round(levels, 2).tolist(),
        "variable": var_info,
        "case_meta": case_meta,
        "endpoints": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
    }

    if overlay:
        ov_cs = _extract_cs(overlay)
        ov_info = _get_variable_info(overlay)
        result["overlay"] = {
            "cross_section": _clean_2d(ov_cs),
            "display_name": ov_info["display_name"],
            "units": ov_info["units"],
            "vmin": ov_info["vmin"],
            "vmax": ov_info["vmax"],
        }

    return JSONResponse(result)


@router.get("/volume")
def get_rt_volume(
    file_url:      str   = Query(...,                              description="Full URL to the xy.nc(.gz) file"),
    variable:      str   = Query(DEFAULT_RT_VARIABLE,              description="Variable name"),
    stride:        int   = Query(2,                ge=1, le=5,     description="Spatial subsampling stride"),
    max_height_km: float = Query(15.0,             ge=1, le=18,   description="Maximum height (km)"),
    tilt_profile:  bool  = Query(False,                            description="Include WCM vortex tilt profile"),
):
    """Return the full 3D volume for Plotly isosurface rendering (compact mode)."""
    if variable not in RT_VARIABLES and variable not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")

    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open file: {e}")

    x_km, y_km = _get_xy_coords(ds)
    vol, height_sub = _extract_3d(ds, variable, max_height_km)

    # Subsample spatially
    x_sub = x_km[::stride]
    y_sub = y_km[::stride]
    vol_sub = vol[:, ::stride, ::stride]

    nz, ny, nx = vol_sub.shape
    v_flat = vol_sub.ravel()

    # Data range (excluding NaN)
    valid = v_flat[np.isfinite(v_flat)]
    data_min = float(np.nanmin(valid)) if len(valid) > 0 else 0
    data_max = float(np.nanmax(valid)) if len(valid) > 0 else 1

    # Replace NaN with sentinel
    SENTINEL = -9999.0
    v_flat = np.where(np.isfinite(v_flat), np.round(v_flat, 3), SENTINEL)

    var_info = _get_variable_info(variable)
    var_info["data_min"] = round(data_min, 3)
    var_info["data_max"] = round(data_max, 3)

    case_meta = _build_case_meta(ds)

    result = {
        "value": v_flat.tolist(),
        "sentinel": SENTINEL,
        "grid_shape": [nz, ny, nx],
        "x_axis": np.round(x_sub, 2).tolist(),
        "y_axis": np.round(y_sub, 2).tolist(),
        "z_axis": np.round(height_sub, 2).tolist(),
        "variable": var_info,
        "case_meta": case_meta,
    }

    if tilt_profile:
        try:
            tilt = _compute_rt_tilt_profile(ds)
            if tilt:
                result["tilt_profile"] = tilt
        except Exception:
            pass

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# Diagnostic endpoint — remove once IR is confirmed working
# ---------------------------------------------------------------------------

@router.get("/ir_debug")
def debug_ir(
    file_url: str = Query(..., description="URL to the TDR xy.nc(.gz) file"),
):
    """Diagnostic: show what the IR pipeline sees without rendering frames."""
    info = {"steps": []}

    # Step 1: Check dependencies
    s3fs_ok = _get_s3fs_module() is not None
    pyproj_ok = _get_pyproj_module() is not None
    info["s3fs_available"] = s3fs_ok
    info["pyproj_available"] = pyproj_ok
    if not s3fs_ok or not pyproj_ok:
        info["error"] = "Missing dependencies"
        return JSONResponse(info)
    info["steps"].append("dependencies OK")

    # Step 2: Open TDR file
    try:
        ds = _open_rt_dataset(file_url)
        meta = _build_case_meta(ds)
        info["meta"] = meta
        info["steps"].append("TDR file opened")
    except Exception as e:
        info["error"] = f"TDR open failed: {e}"
        return JSONResponse(info)

    # Step 3: Parse datetime and select satellite
    try:
        analysis_dt = _parse_tdr_datetime(meta)
        info["analysis_dt"] = analysis_dt.isoformat()
    except Exception as e:
        info["error"] = f"datetime parse failed: {e}"
        return JSONResponse(info)

    bucket, sat_key = _select_goes_sat(meta["longitude"], analysis_dt)
    info["bucket"] = bucket
    info["sat_key"] = sat_key
    info["steps"].append(f"satellite: {bucket} ({sat_key})")

    # Step 4: Build frame times and check t=0
    frame_times = _build_frame_times(analysis_dt)
    t0 = frame_times[0]
    jday = t0.timetuple().tm_yday
    prefix = f"{bucket}/{IR_PRODUCT}/{t0.year}/{jday:03d}/{t0.hour:02d}/"
    info["s3_prefix"] = prefix
    info["t0_target"] = t0.isoformat()

    # Step 5: List S3 directory
    fs = _get_goes_fs()
    try:
        files = fs.ls(prefix, detail=False)
        info["s3_file_count"] = len(files)
        # Show first 5 filenames
        info["s3_files_sample"] = [f.split("/")[-1] for f in files[:5]]
        info["steps"].append(f"S3 ls returned {len(files)} files")
    except Exception as e:
        info["s3_ls_error"] = str(e)
        info["steps"].append(f"S3 ls FAILED: {e}")
        return JSONResponse(info)

    # Step 6: Filter to Band 13
    band_tag = f"C{IR_BAND:02d}"
    candidates = [f for f in files if band_tag in f.split("/")[-1]]
    info["band13_count"] = len(candidates)
    if candidates:
        info["band13_sample"] = [f.split("/")[-1] for f in candidates[:3]]

    # Step 7: Find best match
    try:
        best = _find_goes_file(bucket, t0)
        info["best_file"] = best.split("/")[-1] if best else None
        info["steps"].append(f"best match: {best}")
    except Exception as e:
        info["find_error"] = str(e)

    return JSONResponse(info)


# ---------------------------------------------------------------------------
# HTTP Caching Helpers
# ---------------------------------------------------------------------------

# Historical GOES IR frames are immutable — once rendered they never change.
# We set aggressive Cache-Control headers so the browser (and any CDN) caches
# them, eliminating repeat requests and reducing server RAM usage.
_IR_CACHE_MAX_AGE = 86400          # 24 hours for individual frames
_IR_META_CACHE_MAX_AGE = 300       # 5 minutes for the /ir metadata+frame0 response


def _cached_json_response(data: dict, max_age: int = _IR_CACHE_MAX_AGE) -> Response:
    """Return a JSONResponse with Cache-Control headers for browser caching."""
    import ujson
    body = ujson.dumps(data)
    return Response(
        content=body,
        media_type="application/json",
        headers={
            "Cache-Control": f"public, max-age={max_age}, immutable",
        },
    )


# ---------------------------------------------------------------------------
# GOES IR Satellite Imagery Endpoints
# ---------------------------------------------------------------------------

@router.get("/ir")
def get_realtime_ir(
    file_url: str = Query(..., description="URL to the TDR xy.nc(.gz) file"),
):
    """
    Return GOES IR metadata and the t=0 frame (most recent) for instant display.

    The client then calls /ir_frame for each additional frame index to
    progressively build the animation (same two-phase pattern as the
    archive IR system).
    """
    # Lazy-load IR dependencies on first call (saves ~80 MB at startup)
    missing = []
    if _get_s3fs_module() is None:
        missing.append("s3fs")
    if _get_pyproj_module() is None:
        missing.append("pyproj")
    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"GOES IR not available — missing packages: {', '.join(missing)}",
        )

    # Open TDR file (likely already cached) and extract metadata
    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open TDR file: {e}")

    meta = _build_case_meta(ds)
    center_lat = meta["latitude"]
    center_lon = meta["longitude"]

    try:
        analysis_dt = _parse_tdr_datetime(meta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Select GOES satellite
    bucket, sat_key = _select_goes_sat(center_lon, analysis_dt)
    sat_label = f"GOES-East ({bucket.split('-')[-1].upper()})" if sat_key == "east" else "GOES-West (G18)"

    # Build frame time list
    frame_times = _build_frame_times(analysis_dt)
    lag_minutes = [i * IR_INTERVAL_MIN for i in range(len(frame_times))]

    # Fetch t=0 frame for instant display
    frame0_png = None
    frame0_dt_iso = None
    try:
        t0_key = _find_goes_file(bucket, frame_times[0])
        if t0_key:
            tb = _open_goes_subset(t0_key, center_lat, center_lon, sat_key)
            frame0_png = _render_ir_png(tb)
            del tb  # free raw array immediately
            frame0_dt_iso = frame_times[0].isoformat()
            # Cache it
            _rt_ir_cache[(file_url, 0)] = {
                "frame_index": 0,
                "datetime_iso": frame0_dt_iso,
                "frame": frame0_png,
            }
            if len(_rt_ir_cache) > _RT_IR_CACHE_MAX:
                _rt_ir_cache.popitem(last=False)
    except Exception as e:
        # Non-fatal: t=0 frame unavailable, client will show placeholder
        frame0_png = None

    # Build frame datetime list for the client
    frame_datetimes = []
    for ft in frame_times:
        frame_datetimes.append(ft.strftime("%Y-%m-%d %H:%M UTC"))

    # IR box bounds in km (for Plotly underlay positioning)
    bounds_km = _get_ir_bounds_km(center_lat)

    # Lat/lon bounds (for Leaflet overlay positioning)
    half_deg = IR_BOX_DEG / 2.0
    bounds_deg = {
        "lat_min": center_lat - half_deg,
        "lat_max": center_lat + half_deg,
        "lon_min": center_lon - half_deg,
        "lon_max": center_lon + half_deg,
    }

    return _cached_json_response({
        "center_lat": center_lat,
        "center_lon": center_lon,
        "satellite": sat_key,
        "satellite_label": sat_label,
        "bucket": bucket,
        "n_frames": len(frame_times),
        "lag_minutes": lag_minutes,
        "frame_datetimes": frame_datetimes,
        "frame0": frame0_png,
        "bounds_km": bounds_km,
        "bounds_deg": bounds_deg,
        "units": "K",
    }, max_age=_IR_META_CACHE_MAX_AGE)


@router.get("/ir_frame")
def get_realtime_ir_frame(
    file_url:    str = Query(..., description="URL to the TDR xy.nc(.gz) file"),
    frame_index: int = Query(..., ge=0, description="Frame index (0 = most recent)"),
):
    """
    Return a single server-rendered IR PNG frame.
    Called progressively by the client to build up the animation.
    """
    if _get_s3fs_module() is None or _get_pyproj_module() is None:
        raise HTTPException(status_code=503, detail="GOES IR not available")

    # Check server-side cache first (small — browser is primary cache)
    cache_key = (file_url, frame_index)
    if cache_key in _rt_ir_cache:
        _rt_ir_cache.move_to_end(cache_key)
        return _cached_json_response(_rt_ir_cache[cache_key])

    # Open TDR file for metadata
    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open TDR file: {e}")

    meta = _build_case_meta(ds)
    center_lat = meta["latitude"]
    center_lon = meta["longitude"]

    try:
        analysis_dt = _parse_tdr_datetime(meta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    frame_times = _build_frame_times(analysis_dt)
    if frame_index >= len(frame_times):
        raise HTTPException(status_code=400, detail=f"frame_index {frame_index} out of range (max {len(frame_times)-1})")

    bucket, sat_key = _select_goes_sat(center_lon, analysis_dt)
    target_dt = frame_times[frame_index]

    # Fetch and render
    png = None
    try:
        s3_key = _find_goes_file(bucket, target_dt)
        if s3_key:
            tb = _open_goes_subset(s3_key, center_lat, center_lon, sat_key)
            png = _render_ir_png(tb)
            del tb
    except Exception:
        png = None
    finally:
        gc.collect()

    result = {
        "frame_index": frame_index,
        "datetime_iso": target_dt.strftime("%Y-%m-%d %H:%M UTC"),
        "frame": png,
    }

    # Light server-side cache (browser is primary via Cache-Control)
    _rt_ir_cache[cache_key] = result
    if len(_rt_ir_cache) > _RT_IR_CACHE_MAX:
        _rt_ir_cache.popitem(last=False)

    return _cached_json_response(result)


# ---------------------------------------------------------------------------
# Azimuthal Mean
# ---------------------------------------------------------------------------

def _compute_azimuthal_mean(vol, x_coords, y_coords, height_vals,
                            max_radius, dr, coverage_min):
    """
    Compute azimuthal mean from a 3D Cartesian volume (level, y, x).

    Returns:
        az_mean:  2D array (n_heights × n_rbins) — NaN where coverage < threshold
        coverage: 2D array (n_heights × n_rbins)
        r_bins:   1D array of radius bin centres (km)
    """
    xx, yy = np.meshgrid(x_coords, y_coords)
    rr = np.sqrt(xx**2 + yy**2)

    r_edges = np.arange(0, max_radius + dr, dr)
    r_centers = (r_edges[:-1] + r_edges[1:]) / 2.0
    n_rbins = len(r_centers)
    n_heights = len(height_vals)

    bin_idx = np.digitize(rr, r_edges) - 1  # (ny, nx), values 0..n_rbins-1

    az_mean  = np.full((n_heights, n_rbins), np.nan)
    coverage = np.full((n_heights, n_rbins), 0.0)

    for h in range(n_heights):
        slab = vol[h, :, :]  # (y, x)
        valid = ~np.isnan(slab)
        for r in range(n_rbins):
            mask = (bin_idx == r)
            n_total = np.count_nonzero(mask)
            if n_total == 0:
                continue
            in_bin = mask & valid
            n_valid = np.count_nonzero(in_bin)
            frac = n_valid / n_total
            coverage[h, r] = frac
            if frac >= coverage_min:
                az_mean[h, r] = float(np.nanmean(slab[in_bin]))

    return az_mean, coverage, r_centers


@router.get("/azimuthal_mean")
def get_rt_azimuthal_mean(
    file_url:      str   = Query(..., description="URL of the TDR netCDF file"),
    variable:      str   = Query(DEFAULT_RT_VARIABLE, description="Variable key"),
    max_radius_km: float = Query(200.0, ge=10, le=500, description="Max radius (km)"),
    dr_km:         float = Query(2.0, ge=0.5, le=20, description="Radial bin width (km)"),
    coverage_min:  float = Query(0.5, ge=0.0, le=1.0, description="Min data coverage fraction"),
    overlay:       str   = Query("", description="Optional overlay variable key"),
):
    """Return azimuthal-mean radius-height cross-section for a real-time TDR file."""
    if variable not in RT_VARIABLES and variable not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if overlay and overlay not in RT_VARIABLES and overlay not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'.")

    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open TDR file: {e}")
    x_coords, y_coords = _get_xy_coords(ds)
    vol, heights = _extract_3d(ds, variable)

    az_mean, cov, r_centers = _compute_azimuthal_mean(
        vol, x_coords, y_coords, heights,
        max_radius_km, dr_km, coverage_min
    )

    var_info = _get_variable_info(variable)
    meta = _build_case_meta(ds)

    result = {
        "azimuthal_mean": _clean_2d(az_mean),
        "coverage": _clean_2d(cov),
        "radius_km": [round(float(r), 2) for r in r_centers],
        "height_km": [round(float(h), 2) for h in heights],
        "coverage_min": coverage_min,
        "variable": var_info,
        "case_meta": meta,
    }

    # Optional overlay
    if overlay:
        try:
            ov_vol, ov_heights = _extract_3d(ds, overlay)
            ov_az, _, _ = _compute_azimuthal_mean(
                ov_vol, x_coords, y_coords, ov_heights,
                max_radius_km, dr_km, coverage_min
            )
            ov_info = _get_variable_info(overlay)
            result["overlay"] = {
                "azimuthal_mean": _clean_2d(ov_az),
                "key": overlay,
                "display_name": ov_info["display_name"],
                "units": ov_info["units"],
                "vmin": ov_info["vmin"],
                "vmax": ov_info["vmax"],
            }
        except Exception:
            pass

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# Dropsonde Observations
# ---------------------------------------------------------------------------

SEB_SONDE_BASE = "https://seb.omao.noaa.gov/pub/flight/ASPEN_Data"
SONDE_TIME_WINDOW_MIN = 45  # ±45 minutes from TDR analysis center time

# Cache: file_url → (response_dict, timestamp)
_rt_sonde_cache = OrderedDict()
_RT_SONDE_CACHE_MAX = 2
_RT_SONDE_CACHE_TTL = 300  # 5 minutes


def _extract_mission_id(file_url: str) -> Optional[str]:
    """
    Extract mission ID from a TDR file URL.

    URLs look like: .../radar/20251028H1/251028H1_1349_xy.nc.gz
    The mission folder name follows the /radar/ segment.
    """
    m = re.search(r"/radar/(\d{6,8}[A-Za-z]\d[^/]*)/", file_url)
    if m:
        return m.group(1)
    # Fallback: try to parse from filename prefix (e.g. 251028H1_1349_xy.nc)
    fname = file_url.rstrip("/").split("/")[-1]
    m2 = re.match(r"(\d{6,8}[A-Za-z]\d)", fname)
    if m2:
        short_id = m2.group(1)
        if len(short_id) >= 7 and short_id[0:2].isdigit():
            yr2 = short_id[:2]
            century = "20" if int(yr2) < 70 else "19"
            return century + short_id
    return None


def _parse_sonde_launch_time(filename: str) -> Optional[_dt]:
    """
    Parse launch datetime from a dropsonde CSV filename.

    Filename format: D20251028_135043_PQC.csv
    """
    m = re.match(r"D(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})", filename)
    if not m:
        return None
    try:
        hr = int(m.group(4))
        mi = int(m.group(5))
        sc = int(m.group(6))
        if hr >= 24:
            base = _dt(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                        tzinfo=timezone.utc)
            return base + timedelta(hours=hr, minutes=mi, seconds=sc)
        return _dt(
            int(m.group(1)), int(m.group(2)), int(m.group(3)),
            hr, mi, sc, tzinfo=timezone.utc,
        )
    except ValueError:
        return None


def _parse_dropsonde_csv(csv_text: str) -> Optional[dict]:
    """
    Parse an ASPEN PQC dropsonde CSV file.

    Returns a dict with:
        meta: dict of header metadata
        profile: dict of arrays (time_s, pres, temp, rh, wspd, wdir,
                                 lat, lon, alt, gps_alt, uwnd, vwnd)
    or None if parsing fails.
    """
    lines = csv_text.splitlines()
    meta = {}
    fields_line = None
    data_start = None

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("Fields,"):
            fields_line = i
            data_start = i + 2  # skip Units line
            break
        parts = stripped.split(",", 1)
        if len(parts) == 2:
            key = parts[0].strip()
            val = parts[1].strip().strip('"')
            meta[key] = val

    if fields_line is None or data_start is None:
        return None

    # Parse column names from Fields line
    field_names = lines[fields_line].split(",")
    if field_names and field_names[0].strip().lower() == "fields":
        field_names = field_names[1:]
    field_names = [f.strip() for f in field_names]

    col_map = {}
    for idx, name in enumerate(field_names):
        col_map[name.lower()] = idx

    profile = {
        "time_s": [], "pres": [], "temp": [], "rh": [],
        "wspd": [], "wdir": [], "lat": [], "lon": [],
        "alt": [], "gps_alt": [], "uwnd": [], "vwnd": [],
        "ascent": [], "dewpoint": [],
    }

    aliases = {
        "time_s": ["time"],
        "pres": ["pressure"],
        "temp": ["temperature"],
        "rh": ["rh"],
        "wspd": ["speed"],
        "wdir": ["direction"],
        "lat": ["latitude"],
        "lon": ["longitude"],
        "alt": ["altitude"],
        "gps_alt": ["gps altitude", "gpsaltitude"],
        "uwnd": ["uwnd"],
        "vwnd": ["vwnd"],
        "ascent": ["ascent"],
        "dewpoint": ["dewpoint", "dp", "dew point", "dew pt", "td"],
    }

    var_cols = {}
    for var_key, names in aliases.items():
        for name in names:
            if name in col_map:
                var_cols[var_key] = col_map[name]
                break

    for i in range(data_start, len(lines)):
        stripped = lines[i].strip()
        if not stripped or not stripped.startswith("Data,"):
            continue
        parts = stripped.split(",")
        values = parts[1:]

        for var_key in profile:
            if var_key not in var_cols:
                profile[var_key].append(None)
                continue
            ci = var_cols[var_key]
            if ci < len(values) and values[ci].strip():
                try:
                    profile[var_key].append(float(values[ci].strip()))
                except (ValueError, TypeError):
                    profile[var_key].append(None)
            else:
                profile[var_key].append(None)

    if not profile["time_s"]:
        return None

    return {"meta": meta, "profile": profile}


def _latlon_to_storm_km(
    lat: float, lon: float, center_lat: float, center_lon: float
) -> tuple[float, float]:
    """Convert geographic lat/lon to storm-relative (x_km, y_km)."""
    x_km = (lon - center_lon) * 111.0 * np.cos(np.radians(center_lat))
    y_km = (lat - center_lat) * 111.0
    return float(x_km), float(y_km)


def _filter_valid_profile(profile: dict) -> dict:
    """Filter profile to rows with valid lat, lon, and alt (or gps_alt)."""
    n = len(profile["time_s"])
    mask = []
    for i in range(n):
        lat_ok = profile["lat"][i] is not None
        lon_ok = profile["lon"][i] is not None
        alt_ok = (profile["alt"][i] is not None) or (profile["gps_alt"][i] is not None)
        mask.append(lat_ok and lon_ok and alt_ok)

    filtered = {}
    for key in profile:
        filtered[key] = [profile[key][i] for i in range(n) if mask[i]]
    return filtered


def _build_sonde_response(
    parsed: dict,
    center_lat: float,
    center_lon: float,
    analysis_dt: _dt,
    storm_u: float = -999,
    storm_v: float = -999,
) -> Optional[dict]:
    """Build a single dropsonde entry for the API response.

    If storm_u/storm_v are valid (not -999), each profile point is
    storm-motion-corrected to the analysis time, using the same convention
    as flight-level data:
        x_adj = x_static + storm_u * (-dt_s) / 1000
        y_adj = y_static + storm_v * (-dt_s) / 1000
    where dt_s is the time offset *of each individual data point* from the
    analysis time.
    """
    meta = parsed["meta"]
    profile = _filter_valid_profile(parsed["profile"])

    if not profile["lat"]:
        return None

    has_motion = (storm_u != -999 and storm_v != -999
                  and storm_u is not None and storm_v is not None)

    # ── Parse launch time first (needed for storm-motion correction) ──
    launch_dt = None
    try:
        yr = int(meta.get("Year", 0))
        mo = int(meta.get("Month", 0))
        dy = int(meta.get("Day", 0))
        hr = int(meta.get("Hour", 0))
        mi = int(meta.get("Minute", 0))
        sc = int(meta.get("Second", 0))
        if yr > 0:
            if hr >= 24:
                base = _dt(yr, mo, dy, tzinfo=timezone.utc)
                launch_dt = base + timedelta(hours=hr, minutes=mi, seconds=sc)
            else:
                launch_dt = _dt(yr, mo, dy, hr, mi, sc, tzinfo=timezone.utc)
    except (ValueError, TypeError):
        pass

    time_offset_min = None
    launch_time_str = ""
    if launch_dt:
        launch_time_str = launch_dt.strftime("%Y-%m-%d %H:%M:%SZ")
        delta = (launch_dt - analysis_dt).total_seconds() / 60.0
        time_offset_min = round(delta, 1)

    # ── Build profile arrays with storm-motion correction ──────────
    # For each profile point, compute the point's time relative to the
    # analysis time, then shift (x,y) so that the sonde trajectory is
    # plotted as if the storm were stationary at the analysis position.
    #
    # dt_s for point i = (launch_dt + time_s[i]) - analysis_dt
    # x_adj = x_static + storm_u * (-dt_s) / 1000
    # y_adj = y_static + storm_v * (-dt_s) / 1000

    # Pre-compute launch offset in seconds from analysis time
    launch_offset_s = None
    if launch_dt and analysis_dt:
        launch_offset_s = (launch_dt - analysis_dt).total_seconds()

    x_km_arr = []
    y_km_arr = []
    alt_km_arr = []
    for i in range(len(profile["lat"])):
        x, y = _latlon_to_storm_km(
            profile["lat"][i], profile["lon"][i], center_lat, center_lon
        )
        # Storm-motion correction: shift each point to analysis time
        if has_motion and launch_offset_s is not None:
            time_s_i = profile["time_s"][i] if profile["time_s"][i] is not None else 0
            dt_s = launch_offset_s + time_s_i  # seconds from analysis
            x += storm_u * (-dt_s) / 1000.0
            y += storm_v * (-dt_s) / 1000.0
        x_km_arr.append(round(x, 3))
        y_km_arr.append(round(y, 3))
        alt_m = profile["gps_alt"][i] if profile["gps_alt"][i] is not None else profile["alt"][i]
        alt_km_arr.append(round(alt_m / 1000.0, 4) if alt_m is not None else None)

    launch = {
        "lat": profile["lat"][0],
        "lon": profile["lon"][0],
        "alt_m": (profile["gps_alt"][0] or profile["alt"][0]),
        "x_km": x_km_arr[0],
        "y_km": y_km_arr[0],
    }

    surface = {
        "lat": profile["lat"][-1],
        "lon": profile["lon"][-1],
        "alt_m": (profile["gps_alt"][-1] or profile["alt"][-1]),
        "x_km": x_km_arr[-1],
        "y_km": y_km_arr[-1],
    }

    def _round_list(arr, decimals=3):
        return [round(v, decimals) if v is not None else None for v in arr]

    hit_sfc = meta.get("DropsondeHitSfc", meta.get("DropSondeHitSfc", "0"))

    return {
        "sonde_id": meta.get("SondeId", ""),
        "launch_time": launch_time_str,
        "time_offset_min": time_offset_min,
        "comments": meta.get("Comments", meta.get("Comment", "")),
        "flight": meta.get("Flight", ""),
        "platform": meta.get("PlatformId", ""),
        "project": meta.get("Project", ""),
        "hit_surface": str(hit_sfc).strip() == "1",
        "launch": launch,
        "surface": surface,
        "profile": {
            "time_s": _round_list(profile["time_s"], 1),
            "lat": _round_list(profile["lat"], 5),
            "lon": _round_list(profile["lon"], 5),
            "x_km": x_km_arr,
            "y_km": y_km_arr,
            "alt_km": alt_km_arr,
            "wspd": _round_list(profile["wspd"], 2),
            "wdir": _round_list(profile["wdir"], 1),
            "temp": _round_list(profile["temp"], 2),
            "pres": _round_list(profile["pres"], 2),
            "rh": _round_list(profile["rh"], 1),
            "dewpoint": _round_list(profile.get("dewpoint", []), 2),
            "uwnd": _round_list(profile["uwnd"], 2),
            "vwnd": _round_list(profile["vwnd"], 2),
        },
    }


@router.get("/dropsondes")
def get_dropsondes(
    file_url: str = Query(..., description="URL to the TDR xy.nc(.gz) file"),
):
    """
    Return dropsonde profiles within ±45 min of the TDR analysis time.

    Searches the matching ASPEN_Data mission folder on the SEB server,
    parses PQC CSV files, converts to storm-relative coordinates, and
    returns full-resolution profiles for visualization.
    """
    now = time.time()
    if file_url in _rt_sonde_cache:
        cached, ts = _rt_sonde_cache[file_url]
        if now - ts < _RT_SONDE_CACHE_TTL:
            _rt_sonde_cache.move_to_end(file_url)
            return JSONResponse(cached)

    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open TDR file: {e}")

    case_meta = _build_case_meta(ds)
    center_lat = case_meta["latitude"]
    center_lon = case_meta["longitude"]

    try:
        analysis_dt = _parse_tdr_datetime(case_meta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Extract mission ID from file URL
    mission_id = _extract_mission_id(file_url)
    if not mission_id:
        flt = case_meta.get("mission_id", "")
        m = re.match(r"(\d{6,8}[A-Za-z]\d)", flt)
        if m:
            mission_id = m.group(1)

    if not mission_id:
        raise HTTPException(
            status_code=400,
            detail="Could not determine mission ID from file URL",
        )

    # List dropsonde CSVs for this mission
    sonde_dir_url = f"{SEB_SONDE_BASE}/{mission_id}/"
    try:
        links = _parse_directory(sonde_dir_url)
    except Exception:
        result = {
            "dropsondes": [],
            "analysis_time": analysis_dt.strftime("%Y-%m-%d %H:%M:%SZ"),
            "center_lat": center_lat,
            "center_lon": center_lon,
            "time_window_min": SONDE_TIME_WINDOW_MIN,
            "n_sondes": 0,
            "message": f"No dropsonde directory found for mission {mission_id}",
        }
        _rt_sonde_cache[file_url] = (result, now)
        return JSONResponse(result)

    # Filter to PQC CSV files within time window
    csv_candidates = []
    for link in links:
        if not link.endswith("_PQC.csv"):
            continue
        launch_dt = _parse_sonde_launch_time(link)
        if launch_dt is None:
            continue
        delta_min = abs((launch_dt - analysis_dt).total_seconds()) / 60.0
        if delta_min <= SONDE_TIME_WINDOW_MIN:
            csv_candidates.append((link, launch_dt, delta_min))

    csv_candidates.sort(key=lambda x: x[2])

    # Fetch and parse each CSV in parallel
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def _fetch_and_parse(item):
        filename, _ldt, _dmin = item
        csv_url = f"{SEB_SONDE_BASE}/{mission_id}/{filename}"
        try:
            csv_text = _fetch_text(csv_url, timeout=30)
            parsed = _parse_dropsonde_csv(csv_text)
            if parsed is None:
                return None
            return _build_sonde_response(
                parsed, center_lat, center_lon, analysis_dt,
                storm_u=case_meta.get("storm_motion_east_ms", -999),
                storm_v=case_meta.get("storm_motion_north_ms", -999),
            )
        except Exception:
            return None

    dropsondes = []
    if csv_candidates:
        max_workers = min(len(csv_candidates), 6)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(_fetch_and_parse, item): item for item in csv_candidates}
            for future in as_completed(futures):
                sonde_entry = future.result()
                if sonde_entry is not None:
                    dropsondes.append(sonde_entry)

    dropsondes.sort(
        key=lambda s: abs(s["time_offset_min"]) if s["time_offset_min"] is not None else 999
    )

    _su = case_meta.get("storm_motion_east_ms", -999)
    _sv = case_meta.get("storm_motion_north_ms", -999)
    _has_sm = (_su != -999 and _sv != -999 and _su is not None and _sv is not None)

    result = {
        "dropsondes": dropsondes,
        "analysis_time": analysis_dt.strftime("%Y-%m-%d %H:%M:%SZ"),
        "center_lat": center_lat,
        "center_lon": center_lon,
        "time_window_min": SONDE_TIME_WINDOW_MIN,
        "n_sondes": len(dropsondes),
        "storm_motion_corrected": _has_sm,
        "storm_motion_east_ms": round(_su, 2) if _has_sm else None,
        "storm_motion_north_ms": round(_sv, 2) if _has_sm else None,
    }

    _rt_sonde_cache[file_url] = (result, now)
    if len(_rt_sonde_cache) > _RT_SONDE_CACHE_MAX:
        _rt_sonde_cache.popitem(last=False)
        gc.collect()

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# Flight-Level (In Situ) Observations — IWG1 + MELISSA from acdata
# ---------------------------------------------------------------------------

SEB_ACDATA_BASE = "https://seb.omao.noaa.gov/pub/acdata"
FL_TIME_WINDOW_MIN = 45  # +/-45 minutes from TDR analysis centre time

# NOAA P-3 IWG1 field indices (0-based, after splitting by comma).
# The P-3 includes a WGS-84 altitude field at position 5 that shifts all
# subsequent fields by +1 compared to the base IWG1 standard.
# Spec: https://archive.eol.ucar.edu/raf/Software/IWG1_Def.html
_IWG1 = {
    "timestamp":    1,   # ISO-8601 UTC (yyyymmddThhmmss)
    "lat":          2,   # degrees
    "lon":          3,   # degrees
    "gps_alt":      4,   # GPS MSL altitude (m)
    # 5: WGS-84 altitude (m) — often empty on P-3
    "press_alt":    6,   # pressure altitude (feet)
    "radar_alt":    7,   # radar altitude (feet)
    "ground_spd":   8,   # ground speed (m/s)
    "true_airspd":  9,   # true airspeed (m/s)
    "ias":         10,   # indicated airspeed (knots)
    "mach":        11,   # Mach number
    "vert_vel":    12,   # vertical velocity (m/s)
    "heading":     13,   # true heading (deg)
    "track":       14,   # track angle (deg)
    "drift":       15,   # drift angle (deg)
    "pitch":       16,   # pitch (deg)
    "roll":        17,   # roll (deg)
    "sideslip":    18,   # side slip (deg)
    "aoa":         19,   # angle of attack (deg)
    "temp":        20,   # ambient/static temperature (deg C)
    "dewpoint":    21,   # dew point (deg C)
    "total_temp":  22,   # total temperature (deg C)
    "static_pres": 23,   # static pressure (hPa)
    "dyn_pres":    24,   # dynamic pressure (hPa)
    "cabin_pres":  25,   # cabin pressure (hPa)
    "wind_spd":    26,   # environmental wind speed (m/s)
    "wind_dir":    27,   # environmental wind direction (deg)
    "vert_wind":   28,   # vertical wind speed (m/s)
    "flight_id":   33,   # e.g. 20251028H1 (P-3 extension)
}

# MELISSA fields — only the SFMR surface wind estimates (positions 2-6)
# are reliably identified; the remaining 90+ MELISSA fields vary by
# aircraft configuration and are not yet mapped.
_MELISSA_SFMR_INDICES = [2, 3, 4, 5]  # 4 SFMR sfc wind estimates (m/s)
_MELISSA_EXTRAP_SFC = 6               # extrapolated sfc wind (m/s)
_MELISSA_SLP = 72                     # sea-level pressure (hPa)

# Cache
_rt_fl_cache = OrderedDict()
_RT_FL_CACHE_MAX = 2
_RT_FL_CACHE_TTL = 300  # 5 minutes


def _parse_iwg1_timestamp(ts_str: str) -> Optional[_dt]:
    """Parse IWG1 timestamp like '20251028T101345' into datetime."""
    ts = ts_str.strip()
    if not ts or len(ts) < 15:
        return None
    try:
        return _dt.strptime(ts[:15], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _safe_float(val: str) -> Optional[float]:
    """Safely convert a string to float, returning None on failure."""
    v = val.strip() if val else ""
    if not v:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _iwg1_field(parts: list, idx: int) -> Optional[float]:
    """Extract a float from IWG1 parts at the given index, or None."""
    if idx < len(parts):
        return _safe_float(parts[idx])
    return None


def _parse_acdata_serial(text: str, analysis_dt: _dt, time_window_min: float) -> list[dict]:
    """
    Parse a _serial.dat file containing IWG1 + MELISSA records.

    On the NOAA P-3, IWG1 and MELISSA are on the SAME line, separated
    by a space (e.g. "...2313A MELISSA,AL132025,...").  This parser
    splits on " MELISSA," to separate them.

    Returns a list of 1-Hz observation dicts within +/-time_window_min
    of analysis_dt.
    """
    lines = text.splitlines()
    observations = []

    for line in lines:
        line = line.strip()
        if not line.startswith("IWG1,"):
            continue

        # Split IWG1 and MELISSA (they share the same line on P-3)
        iwg1_text = line
        melissa_text = None
        mel_split = line.split(" MELISSA,", 1)
        if len(mel_split) == 2:
            iwg1_text = mel_split[0]
            melissa_text = "MELISSA," + mel_split[1]

        parts = iwg1_text.split(",")
        ts = _parse_iwg1_timestamp(parts[_IWG1["timestamp"]] if len(parts) > 1 else "")
        if ts is None:
            continue

        # Time-window filter
        delta_sec = (ts - analysis_dt).total_seconds()
        if abs(delta_sec) > time_window_min * 60:
            continue

        lat = _iwg1_field(parts, _IWG1["lat"])
        lon = _iwg1_field(parts, _IWG1["lon"])
        if lat is None or lon is None:
            continue

        obs = {
            "time": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "time_offset_s": round(delta_sec, 1),
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "gps_alt_m":      _iwg1_field(parts, _IWG1["gps_alt"]),
            "press_alt_ft":   _iwg1_field(parts, _IWG1["press_alt"]),
            "ground_spd_ms":  _iwg1_field(parts, _IWG1["ground_spd"]),
            "true_airspd_ms": _iwg1_field(parts, _IWG1["true_airspd"]),
            "vert_vel_ms":    _iwg1_field(parts, _IWG1["vert_vel"]),
            "heading":        _iwg1_field(parts, _IWG1["heading"]),
            "track":          _iwg1_field(parts, _IWG1["track"]),
            "static_pres_hpa": _iwg1_field(parts, _IWG1["static_pres"]),
            "temp_c":         _iwg1_field(parts, _IWG1["temp"]),
            "dewpoint_c":     _iwg1_field(parts, _IWG1["dewpoint"]),
            "fl_wspd_ms":     _iwg1_field(parts, _IWG1["wind_spd"]),
            "fl_wdir_deg":    _iwg1_field(parts, _IWG1["wind_dir"]),
            # MELISSA fields
            "sfmr_wspd_ms": None,
            "slp_hpa": None,
            "extrapolated_sfc_wspd_ms": None,
        }

        # Round values
        for key in obs:
            if isinstance(obs[key], float) and key not in ("lat", "lon", "time_offset_s"):
                obs[key] = round(obs[key], 2)

        # Parse MELISSA line (same line, after the space)
        if melissa_text:
            mparts = melissa_text.split(",")
            # SFMR surface wind: take the maximum positive of the 4 estimates
            best_sfmr = None
            for si in _MELISSA_SFMR_INDICES:
                if si < len(mparts):
                    v = _safe_float(mparts[si])
                    if v is not None and v >= 0:
                        if best_sfmr is None or v > best_sfmr:
                            best_sfmr = v
            if best_sfmr is not None:
                obs["sfmr_wspd_ms"] = round(best_sfmr, 2)

            if _MELISSA_EXTRAP_SFC < len(mparts):
                v = _safe_float(mparts[_MELISSA_EXTRAP_SFC])
                if v is not None:
                    obs["extrapolated_sfc_wspd_ms"] = round(v, 2)

            # Sea-level pressure
            if _MELISSA_SLP < len(mparts):
                v = _safe_float(mparts[_MELISSA_SLP])
                if v is not None and 850 < v < 1100:  # sanity check
                    obs["slp_hpa"] = round(v, 2)

        observations.append(obs)

    return observations


def _average_fl_window(
    observations: list[dict], interval_s: float = 10.0
) -> list[dict]:
    """
    Compute interval_s-second averages of flight-level observations.

    Groups consecutive 1-Hz obs into non-overlapping windows and averages
    all numeric fields.  Lat/lon/time use the window centre observation.
    """
    if not observations or interval_s <= 1:
        return observations

    # Numeric keys to average
    _AVG_KEYS = [
        "gps_alt_m", "press_alt_ft", "ground_spd_ms", "true_airspd_ms",
        "vert_vel_ms", "static_pres_hpa", "temp_c", "dewpoint_c",
        "fl_wspd_ms", "fl_wdir_deg", "sfmr_wspd_ms", "slp_hpa",
        "extrapolated_sfc_wspd_ms",
    ]

    result = []
    n = len(observations)
    i = 0
    while i < n:
        t0 = observations[i]["time_offset_s"]
        window = []
        while i < n and observations[i]["time_offset_s"] - t0 < interval_s:
            window.append(observations[i])
            i += 1

        # Use the centre observation for identity fields
        mid_idx = len(window) // 2
        mid = window[mid_idx]
        averaged = {
            "time": mid["time"],
            "time_offset_s": mid["time_offset_s"],
            "lat": mid["lat"],
            "lon": mid["lon"],
        }

        # Average numeric fields (skip None values)
        for key in _AVG_KEYS:
            vals = [o[key] for o in window if o.get(key) is not None]
            if vals:
                # For wind direction, use circular mean
                if key == "fl_wdir_deg":
                    rad = [v * np.pi / 180.0 for v in vals]
                    mean_sin = sum(np.sin(r) for r in rad) / len(rad)
                    mean_cos = sum(np.cos(r) for r in rad) / len(rad)
                    avg = (np.arctan2(mean_sin, mean_cos) * 180.0 / np.pi) % 360.0
                else:
                    avg = sum(vals) / len(vals)
                averaged[key] = round(avg, 2)
            else:
                averaged[key] = None

        # Carry forward heading/track from centre obs
        averaged["heading"] = mid.get("heading")
        averaged["track"] = mid.get("track")

        result.append(averaged)

    return result


def _find_acdata_serial_file(mission_id: str, year: int) -> Optional[str]:
    """
    Locate the _serial.dat file for a given mission in the acdata tree.

    Directory structure: /pub/acdata/{year}/MET/{mission_id}/{mission_id}_serial.dat
    """
    base_url = f"{SEB_ACDATA_BASE}/{year}/MET/{mission_id}/"
    try:
        links = _parse_directory(base_url)
    except Exception:
        return None

    for link in links:
        if link.endswith("_serial.dat"):
            return f"{base_url}{link}"
    return None


@router.get("/flightlevel")
def get_flight_level(
    file_url: str = Query(..., description="URL to the TDR xy.nc(.gz) file"),
    avg_interval_s: float = Query(10.0, ge=1, le=60,
                                  description="Averaging interval in seconds"),
):
    """
    Return flight-level (in situ) observations from the IWG1/MELISSA serial
    data stream for the aircraft mission matching the given TDR analysis file.

    Parses 1-Hz IWG1 + MELISSA from seb.omao.noaa.gov/pub/acdata/, filters
    to +/-45 min of the TDR analysis time, and returns 10-second averaged
    observations with storm-relative coordinates.
    """
    now = time.time()
    cache_key = f"{file_url}__avg{avg_interval_s}"
    if cache_key in _rt_fl_cache:
        cached, ts = _rt_fl_cache[cache_key]
        if now - ts < _RT_FL_CACHE_TTL:
            _rt_fl_cache.move_to_end(cache_key)
            return JSONResponse(cached)

    # Open the TDR file to extract mission metadata
    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open TDR file: {e}")

    case_meta = _build_case_meta(ds)
    center_lat = case_meta["latitude"]
    center_lon = case_meta["longitude"]

    try:
        analysis_dt = _parse_tdr_datetime(case_meta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Extract mission ID
    mission_id = _extract_mission_id(file_url)
    if not mission_id:
        flt = case_meta.get("mission_id", "")
        m = re.match(r"(\d{6,8}[A-Za-z]\d)", flt)
        if m:
            mission_id = m.group(1)
    if not mission_id:
        raise HTTPException(status_code=400, detail="Could not determine mission ID")

    year = analysis_dt.year

    # Find the serial data file
    serial_url = _find_acdata_serial_file(mission_id, year)
    if serial_url is None:
        result = {
            "observations": [],
            "analysis_time": analysis_dt.strftime("%Y-%m-%d %H:%M:%SZ"),
            "center_lat": center_lat,
            "center_lon": center_lon,
            "mission_id": mission_id,
            "time_window_min": FL_TIME_WINDOW_MIN,
            "n_obs": 0,
            "message": f"No flight-level serial data found for mission {mission_id}",
        }
        _rt_fl_cache[cache_key] = (result, now)
        return JSONResponse(result)

    # Fetch and parse the serial data
    try:
        serial_text = _fetch_text(serial_url, timeout=60)
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Could not fetch serial data from {serial_url}: {e}",
        )

    raw_obs = _parse_acdata_serial(serial_text, analysis_dt, FL_TIME_WINDOW_MIN)

    # Compute 10-second (or user-specified) averages
    averaged_obs = _average_fl_window(raw_obs, interval_s=avg_interval_s)

    # ── Storm-motion correction for flight-level positions ──────────
    # The TDR analysis grid is storm-centered at the analysis time.  FL
    # observations span ±45 min, so uncorrected positions use the
    # *analysis-time* storm center for all obs regardless of when they
    # were collected.  We adjust each obs position by back-propagating
    # the storm motion so that positions reflect where the aircraft was
    # relative to the *moving* storm at the time of each observation.
    #
    #   x_adj = x_static + u_storm * (-dt) / 1000   (dt in s, u in m/s → km)
    #   y_adj = y_static + v_storm * (-dt) / 1000
    #
    # dt = time_offset_s (negative before analysis → -dt is positive →
    #       shifts position in the direction of storm motion, i.e. the
    #       aircraft was "ahead" of the storm center in a relative sense).

    storm_u = case_meta.get("storm_motion_east_ms", -999)
    storm_v = case_meta.get("storm_motion_north_ms", -999)
    has_motion = (storm_u != -999 and storm_v != -999
                  and storm_u is not None and storm_v is not None)

    for obs in averaged_obs:
        x_km, y_km = _latlon_to_storm_km(
            obs["lat"], obs["lon"], center_lat, center_lon
        )
        # Apply storm-motion correction if available
        if has_motion and obs.get("time_offset_s") is not None:
            dt_s = obs["time_offset_s"]        # seconds from analysis (neg = before)
            x_km += storm_u * (-dt_s) / 1000.0  # km
            y_km += storm_v * (-dt_s) / 1000.0
        obs["x_km"] = round(x_km, 3)
        obs["y_km"] = round(y_km, 3)

    # ── Interpolate TDR wind speed to flight-track positions ──────
    # (now using storm-motion-adjusted positions)
    try:
        x_arr = np.array([o["x_km"] for o in averaged_obs], dtype=float)
        y_arr = np.array([o["y_km"] for o in averaged_obs], dtype=float)

        tdr_05 = _interp_tdr_along_track(ds, "WIND_SPEED", 0.5, x_arr, y_arr)
        tdr_20 = _interp_tdr_along_track(ds, "WIND_SPEED", 2.0, x_arr, y_arr)

        # 3D interpolation at aircraft altitude
        z_arr = np.array([
            (o.get("gps_alt_m") or 0) / 1000.0 for o in averaged_obs
        ], dtype=float)
        has_alt = np.any(z_arr > 0)
        if has_alt:
            tdr_fl = _interp_tdr_3d_along_track(ds, "WIND_SPEED", x_arr, y_arr, z_arr)
        else:
            tdr_fl = np.full(len(averaged_obs), np.nan)

        for i, obs in enumerate(averaged_obs):
            obs["tdr_wspd_0p5km"] = round(float(tdr_05[i]), 2) if not np.isnan(tdr_05[i]) else None
            obs["tdr_wspd_2km"]   = round(float(tdr_20[i]), 2) if not np.isnan(tdr_20[i]) else None
            obs["tdr_wspd_fl_alt"] = round(float(tdr_fl[i]), 2) if not np.isnan(tdr_fl[i]) else None
    except Exception:
        # Graceful fallback: if TDR interpolation fails, leave fields as None
        for obs in averaged_obs:
            obs.setdefault("tdr_wspd_0p5km", None)
            obs.setdefault("tdr_wspd_2km", None)
            obs.setdefault("tdr_wspd_fl_alt", None)

    # Compute summary statistics from the RAW 1-Hz data for accuracy
    fl_wspds = [o["fl_wspd_ms"] for o in raw_obs if o["fl_wspd_ms"] is not None]
    sfmr_wspds = [o["sfmr_wspd_ms"] for o in raw_obs if o["sfmr_wspd_ms"] is not None]
    static_pres = [o["static_pres_hpa"] for o in raw_obs
                   if o["static_pres_hpa"] is not None and 200 < o["static_pres_hpa"] < 1100]
    slp_vals = [o["slp_hpa"] for o in raw_obs if o.get("slp_hpa") is not None]
    temps = [o["temp_c"] for o in raw_obs if o["temp_c"] is not None]

    summary = {
        "max_fl_wspd_ms": round(max(fl_wspds), 2) if fl_wspds else None,
        "max_sfmr_wspd_ms": round(max(sfmr_wspds), 2) if sfmr_wspds else None,
        "min_slp_hpa": round(min(slp_vals), 2) if slp_vals else None,
        "max_temp_c": round(max(temps), 2) if temps else None,
        "min_temp_c": round(min(temps), 2) if temps else None,
        "min_static_pres_hpa": round(min(static_pres), 2) if static_pres else None,
        "total_obs_1hz": len(raw_obs),
        "avg_interval_s": avg_interval_s,
        "mean_alt_m": round(
            sum(o["gps_alt_m"] for o in raw_obs if o["gps_alt_m"] is not None)
            / max(1, sum(1 for o in raw_obs if o["gps_alt_m"] is not None)),
            0,
        ) if any(o["gps_alt_m"] is not None for o in raw_obs) else None,
    }

    result = {
        "observations": averaged_obs,
        "analysis_time": analysis_dt.strftime("%Y-%m-%d %H:%M:%SZ"),
        "center_lat": center_lat,
        "center_lon": center_lon,
        "mission_id": mission_id,
        "serial_url": serial_url,
        "time_window_min": FL_TIME_WINDOW_MIN,
        "n_obs": len(averaged_obs),
        "n_obs_total": len(raw_obs),
        "storm_motion_corrected": has_motion,
        "storm_motion_east_ms": round(storm_u, 2) if has_motion else None,
        "storm_motion_north_ms": round(storm_v, 2) if has_motion else None,
        "summary": summary,
    }

    _rt_fl_cache[cache_key] = (result, now)
    if len(_rt_fl_cache) > _RT_FL_CACHE_MAX:
        _rt_fl_cache.popitem(last=False)
        gc.collect()

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# SHIPS Text File Parser and Climatology Functions
# ---------------------------------------------------------------------------

# Cache for SHIPS data: (atcf_id, analysis_dt) → (result_dict, timestamp)
_rt_ships_cache = OrderedDict()
_RT_SHIPS_CACHE_TTL = 600  # 10 minutes

# Variable mapping: RT variable names → climatology variable names
_RT_TO_CLIMO_MAP = {
    "TANGENTIAL_WIND": "merged_tangential_wind",
    "RADIAL_WIND": "merged_radial_wind",
    "W": "merged_upward_air_velocity",
    "REFLECTIVITY": "merged_reflectivity",
    "WIND_SPEED": "merged_wind_speed",
    "VORT": "merged_relative_vorticity",
}

# Hybrid R_H coordinate parameters (match tc_radar_api.py)
HYBRID_DR_INNER = 0.05          # R/RMW spacing inward of RMW
HYBRID_DR_OUTER_KM = 2.0        # km spacing outward of RMW
HYBRID_MAX_OUTER_KM = 100.0     # max distance beyond RMW

# Shear-relative quadrant definitions (from tc_radar_api.py)
QUADRANT_DEFS = {
    "DSR": (0,   90),      # downshear-right
    "USR": (90,  180),     # upshear-right
    "USL": (180, 270),     # upshear-left
    "DSL": (270, 360),     # downshear-left
}

# Import climatology from tc_radar_api
try:
    from tc_radar_api import _climatology, _get_climatology_for_intensity, _CLIMO_VAR_MAP
except ImportError:
    _climatology = {}
    def _get_climatology_for_intensity(varname, vmax_kt):
        return (None, None, 0, None)
    _CLIMO_VAR_MAP = {}


def _build_hybrid_r_axis():
    """
    Build the hybrid R_H radial axis (bin edges and centres).

    Inward of RMW:  normalised by RMW (0 to 1, spacing = HYBRID_DR_INNER)
    Outward of RMW: physical distance beyond RMW (0 to HYBRID_MAX_OUTER_KM km,
                    spacing = HYBRID_DR_OUTER_KM)

    Returns
    -------
    inner_edges : 1D array  — bin edges from 0 to 1 (R/RMW, inward regime)
    outer_edges : 1D array  — bin edges from 0 to HYBRID_MAX_OUTER_KM (km, outward regime)
    r_labels    : list[str] — human-readable labels for each bin centre
    n_inner     : int       — number of inward bins
    n_outer     : int       — number of outward bins
    """
    inner_edges = np.arange(0, 1.0 + HYBRID_DR_INNER / 2, HYBRID_DR_INNER)
    outer_edges = np.arange(0, HYBRID_MAX_OUTER_KM + HYBRID_DR_OUTER_KM / 2,
                            HYBRID_DR_OUTER_KM)
    n_inner = len(inner_edges) - 1
    n_outer = len(outer_edges) - 1

    # Build labels: inner bins as fractional R/RMW, outer as "RMW + X km"
    r_labels = []
    for i in range(n_inner):
        c = (inner_edges[i] + inner_edges[i + 1]) / 2.0
        r_labels.append(round(float(c), 2))
    for i in range(n_outer):
        c = (outer_edges[i] + outer_edges[i + 1]) / 2.0
        r_labels.append(round(float(c), 2))

    return inner_edges, outer_edges, r_labels, n_inner, n_outer


def _compute_azimuthal_mean_hybrid(vol, x_coords, y_coords, height_vals,
                                    h_axis, rmw, coverage_min=0.5):
    """
    Compute azimuthal mean on the hybrid R_H coordinate of Fischer et al. (2025).

    Parameters
    ----------
    vol         : 3D array — (height, y, x) or other axis order per h_axis
    x_coords    : 1D array — x (eastward_distance) in km
    y_coords    : 1D array — y (northward_distance) in km
    height_vals : 1D array — heights in km
    h_axis      : int      — position of the height axis in vol
    rmw         : float    — radius of maximum wind in km (must be > 0)
    coverage_min: float    — minimum fraction of valid data per bin

    Returns
    -------
    az_mean  : 2D array (n_heights × n_total_bins)
    coverage : 2D array (n_heights × n_total_bins)
    r_h_axis : 1D list of bin-centre values (for plotting)
    n_inner  : int — number of inner (RMW-normalised) bins
    """
    if rmw is None or rmw <= 0:
        raise ValueError("rmw must be positive for hybrid coordinate")

    inner_edges, outer_edges, r_labels, n_inner, n_outer = _build_hybrid_r_axis()
    n_total = n_inner + n_outer
    n_heights = len(height_vals)

    # Build 2D radius grid
    xx, yy = np.meshgrid(x_coords, y_coords)
    rr = np.sqrt(xx**2 + yy**2)  # physical radius in km

    # Classify each grid point as inner or outer
    is_inner = rr < rmw
    is_outer = ~is_inner

    # Map to bin index:
    # Inner: normalise by RMW, digitise into inner_edges
    rr_norm = np.where(is_inner, rr / rmw, np.nan)
    inner_bin_idx = np.digitize(np.nan_to_num(rr_norm, nan=-1), inner_edges) - 1

    # Outer: distance beyond RMW in km, digitise into outer_edges
    rr_beyond = np.where(is_outer, rr - rmw, np.nan)
    outer_bin_idx = np.digitize(np.nan_to_num(rr_beyond, nan=-1), outer_edges) - 1

    az_mean  = np.full((n_heights, n_total), np.nan)
    coverage = np.full((n_heights, n_total), 0.0)

    for h in range(n_heights):
        if h_axis == 0:
            slab = vol[h, :, :]
        elif h_axis == 2:
            slab = vol[:, :, h]
        else:
            slab = vol[:, h, :]

        valid = ~np.isnan(slab)

        # Inner bins
        for r in range(n_inner):
            mask = is_inner & (inner_bin_idx == r)
            n_total_pts = np.count_nonzero(mask)
            if n_total_pts == 0:
                continue
            in_bin = mask & valid
            n_valid = np.count_nonzero(in_bin)
            frac = n_valid / n_total_pts
            coverage[h, r] = frac
            if frac >= coverage_min:
                az_mean[h, r] = float(np.nanmean(slab[in_bin]))

        # Outer bins
        for r in range(n_outer):
            mask = is_outer & (outer_bin_idx == r)
            n_total_pts = np.count_nonzero(mask)
            if n_total_pts == 0:
                continue
            in_bin = mask & valid
            n_valid = np.count_nonzero(in_bin)
            frac = n_valid / n_total_pts
            coverage[h, n_inner + r] = frac
            if frac >= coverage_min:
                az_mean[h, n_inner + r] = float(np.nanmean(slab[in_bin]))

    return az_mean, coverage, r_labels, n_inner


def _compute_quadrant_means_rt(vol, x_coords, y_coords, height_vals, h_axis,
                               sddc, max_radius, dr, coverage_min, rmw=None):
    """
    Compute shear-relative quadrant means from a 3D Cartesian volume.

    If rmw is provided, radii are normalised by RMW (output bins in R/RMW).

    Parameters
    ----------
    vol : 3D array — full volume with axes depending on h_axis
    sddc : float — deep-layer shear heading (met deg, 0=N, 90=E, CW)
    rmw : float or None — if provided, normalise radius by RMW

    Returns
    -------
    quad_means : dict[str, 2D array] — {DSL, DSR, USL, USR} each (n_heights × n_rbins)
    r_centers  : 1D array of radial bin centres (km or R/RMW)
    """
    # Build 2D radius and azimuth grids
    xx, yy = np.meshgrid(x_coords, y_coords)
    rr = np.sqrt(xx**2 + yy**2)

    # If RMW-normalising, convert radius grid to R/RMW
    if rmw is not None and rmw > 0:
        rr = rr / rmw

    # Math angle → meteorological heading
    azimuth_math_deg = np.degrees(np.arctan2(yy, xx))        # -180..180, CCW from +x
    azimuth_met = (90.0 - azimuth_math_deg) % 360.0          # met heading, CW from N

    # Shear-relative azimuth: 0° = downshear, 90° = right-of-shear (CW)
    shear_rel_az = (azimuth_met - sddc) % 360.0

    # Radial bins
    r_edges = np.arange(0, max_radius + dr, dr)
    r_centers = (r_edges[:-1] + r_edges[1:]) / 2.0
    n_rbins = len(r_centers)
    n_heights = len(height_vals)

    bin_idx = np.digitize(rr, r_edges) - 1   # (ny, nx)

    # Pre-compute quadrant masks (ny, nx) for each quadrant
    q_masks = {}
    for qname, (az_start, az_end) in QUADRANT_DEFS.items():
        q_masks[qname] = (shear_rel_az >= az_start) & (shear_rel_az < az_end)

    quad_means = {q: np.full((n_heights, n_rbins), np.nan) for q in QUADRANT_DEFS}

    for h in range(n_heights):
        # Extract 2D slab at this height
        if h_axis == 0:
            slab = vol[h, :, :]
        elif h_axis == 2:
            slab = vol[:, :, h]
        else:
            slab = vol[:, h, :]

        valid = ~np.isnan(slab)

        for r in range(n_rbins):
            r_mask = (bin_idx == r)
            for qname, q_mask in q_masks.items():
                mask = r_mask & q_mask
                n_total = np.count_nonzero(mask)
                if n_total == 0:
                    continue
                in_bin = mask & valid
                n_valid = np.count_nonzero(in_bin)
                frac = n_valid / n_total
                if frac >= coverage_min:
                    quad_means[qname][h, r] = float(np.nanmean(slab[in_bin]))

    return quad_means, r_centers


def _parse_ships_text(text: str) -> dict:
    """
    Parse SHIPS text file format to extract environmental parameters at t=0.

    Returns dict with keys: vmax_kt, shear_kt, shear_adj_kt, shear_dir,
                            sst_c, pot_int_kt, rhmd, stm_speed_kt,
                            200mb_div, heat_content, lat, lon
    """
    result = {}
    lines = text.strip().split('\n')

    # Dictionary to map row headers to field names
    row_map = {
        'V (KT) NO LAND': 'vmax_kt',
        'SHEAR (KT)': 'shear_kt',
        'SHEAR ADJ (KT)': 'shear_adj_kt',
        'SHEAR DIR': 'shear_dir',
        'SST (C)': 'sst_c',
        'POT. INT. (KT)': 'pot_int_kt',
        '700-500 MB RH': 'rhmd',
        'STM SPEED (KT)': 'stm_speed_kt',
        'STM SPEED': 'stm_speed_kt',
        'STORM SPEED': 'stm_speed_kt',
        'STM HEADING (DEG)': 'stm_heading_deg',
        'STM HEADING': 'stm_heading_deg',
        'STORM HEADING': 'stm_heading_deg',
        'STORM DIRECTION': 'stm_heading_deg',
        '200 MB DIV': '200mb_div',
        'HEAT CONTENT': 'heat_content',
        'LAT (DEG N)': 'lat',
        'LONG(DEG W)': 'lon',
    }

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Try to match row headers
        matched = False
        for header, field_name in row_map.items():
            if line.startswith(header):
                matched = True
                # Extract the data part (after the header)
                data_str = line[len(header):].strip()
                # Split by whitespace and take first value (t=0 column)
                parts = data_str.split()
                if parts and field_name not in result:
                    try:
                        result[field_name] = float(parts[0])
                    except (ValueError, IndexError):
                        pass
                break

        # Parse "INITIAL HEADING/SPEED (DEG/KT): 25/ 7" line
        if not matched and 'HEADING/SPEED' in line and 'stm_heading_deg' not in result:
            try:
                # Format: "... HEADING/SPEED (DEG/KT): heading/ speed"
                colon_idx = line.index(':')
                hs_str = line[colon_idx + 1:].strip()  # "25/ 7" or "25/7"
                hs_parts = hs_str.split('/')
                if len(hs_parts) == 2:
                    h_val = float(hs_parts[0].strip())
                    s_val = float(hs_parts[1].strip())
                    result['stm_heading_deg'] = h_val
                    if 'stm_speed_kt' not in result:
                        result['stm_speed_kt'] = s_val
            except (ValueError, IndexError):
                pass

    return result


def _guess_basin_from_coords(lat: float, lon: float) -> list[str]:
    """
    Guess likely ATCF basin codes from storm center lat/lon.

    Returns a priority-ordered list of basin codes to try.
    """
    # Normalize longitude to -180..180
    if lon > 180:
        lon = lon - 360

    # Atlantic basin: roughly -100 to 0, lat > 0
    # East Pacific: roughly -180 to -100, lat > 0
    # Central Pacific: roughly -180 to -140, lat > 0
    # West Pacific: roughly 100 to 180, lat > 0

    if lat >= 0:
        if -100 <= lon <= 0:
            return ["AL", "EP"]
        elif -140 <= lon < -100:
            return ["EP", "CP", "AL"]
        elif lon < -140 or lon > 100:
            return ["EP", "CP", "WP"]
        else:
            return ["AL", "EP"]
    else:
        # Southern hemisphere — less common for SHIPS, but try
        return ["AL", "EP", "WP"]


def _fetch_ships_by_name(
    storm_name: str,
    analysis_dt: _dt,
    lat: float = 0.0,
    lon: float = 0.0,
) -> Optional[tuple[dict, str]]:
    """
    Fast SHIPS lookup by storm name: construct direct URLs and probe in
    parallel using ThreadPoolExecutor.

    Instead of fetching/parsing an NHC directory listing (slow HTML page),
    we know the SHIPS filename format is ``YYMMDDHHBBSSYY_ships.txt``
    (BB = basin, SS = storm number, YY = year).  We guess the basin from
    lat/lon, pick the closest synoptic time, and try storm numbers 01-25
    concurrently.  The first file whose header contains the storm name wins.

    Falls back to one older synoptic cycle if the first round finds nothing.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    year = analysis_dt.year
    yy = year % 100
    name_upper = storm_name.upper().strip()

    likely_basins = (
        _guess_basin_from_coords(lat, lon)
        if (lat != 0 or lon != 0)
        else ["AL", "EP"]
    )

    base_urls = [
        "https://ftp.nhc.noaa.gov/atcf/stext",
        f"https://ftp.nhc.noaa.gov/atcf/archive/MESSAGES/{year}/stext",
    ]

    # Build candidate synoptic times (nearest 6-h cycle, then one prior)
    hour_floor = (analysis_dt.hour // 6) * 6
    base_synoptic = analysis_dt.replace(
        hour=hour_floor, minute=0, second=0, microsecond=0
    )
    synoptic_times = [base_synoptic - timedelta(hours=6 * i) for i in range(3)]

    def _try_url(url: str) -> Optional[tuple[dict, str, str]]:
        """Fetch one SHIPS URL; return (parsed_data, atcf_id, text) or None."""
        try:
            text = _fetch_text(url, timeout=8)
        except Exception:
            return None
        # Verify storm name in header (first 10 lines)
        for hline in text.split("\n")[:10]:
            if name_upper in hline.upper():
                return (_parse_ships_text(text), None, url)  # placeholder atcf
        return None

    # For each synoptic time, build all candidate URLs across basins and
    # storm numbers, then probe them in parallel.
    for syn_dt in synoptic_times:
        dt_prefix = syn_dt.strftime("%y%m%d%H")
        urls_and_ids = []  # (url, atcf_id)
        for basin in likely_basins:
            for stnum in range(1, 26):
                atcf_id = f"{basin}{stnum:02d}{yy:02d}"
                fname = f"{dt_prefix}{atcf_id}_ships.txt"
                for base_url in base_urls:
                    urls_and_ids.append((f"{base_url}/{fname}", atcf_id))

        # Fire all requests concurrently (cap threads to avoid overload)
        with ThreadPoolExecutor(max_workers=12) as executor:
            future_map = {
                executor.submit(_try_url, url): atcf_id
                for url, atcf_id in urls_and_ids
            }
            for future in as_completed(future_map):
                result = future.result()
                if result is not None:
                    ships_data, _, _ = result
                    atcf_id = future_map[future]
                    # Cancel remaining futures
                    for f in future_map:
                        f.cancel()
                    return (ships_data, atcf_id)

    return None


def _fetch_ships_from_nhc(atcf_id: str, analysis_dt: _dt) -> Optional[dict]:
    """
    Fetch SHIPS text file from NHC FTP by constructing the URL directly.

    Filename format: YYMMDDHHBBNNNN_ships.txt
      e.g. 25102812AL1325_ships.txt
    Tries the closest synoptic times (00/06/12/18Z) before analysis_dt.
    """
    year = analysis_dt.year
    yy = year % 100

    base_urls = [
        "https://ftp.nhc.noaa.gov/atcf/stext",
        f"https://ftp.nhc.noaa.gov/atcf/archive/MESSAGES/{year}/stext",
    ]

    # Build candidate synoptic times: round down to nearest 6h, then try
    # the previous 4 synoptic cycles (covers 24h before analysis)
    hour_floor = (analysis_dt.hour // 6) * 6
    base_dt = analysis_dt.replace(hour=hour_floor, minute=0, second=0, microsecond=0)
    from datetime import timedelta
    synoptic_times = [base_dt - timedelta(hours=6 * i) for i in range(4)]

    errors = []
    for syn_dt in synoptic_times:
        fname = f"{syn_dt.strftime('%y%m%d%H')}{atcf_id}_ships.txt"
        for base_url in base_urls:
            file_url = f"{base_url}/{fname}"
            try:
                text = _fetch_text(file_url, timeout=20)
                ships_data = _parse_ships_text(text)
                return ships_data
            except Exception as e:
                errors.append(f"{fname} from {base_url}: {e}")
                continue

    return None


def _build_ships_result(ships_data: dict, atcf_id: str, analysis_datetime: _dt,
                        storm_name: str, year: int, basin: str, storm_number: int) -> dict:
    """Build the standard SHIPS response dict with VP computation and shear conversion."""
    vp = None
    vp_components = {}
    # Archive VP uses: SHGC × (100 - RHLO) / VMPI  where SHGC is the
    # "generalized shear" (all levels 1000-100 hPa, vortex removed, 0-500 km).
    # The SHIPS text file provides SHEAR (KT) ≈ SHDC (standard 850-200 hPa,
    # vortex removed, 0-500 km).  Empirical analysis of 396 archive cases
    # yields the linear model:  SHGC = 0.953 × SHDC + 10.251  (R²=0.69)
    # This implies a SHDC-dependent correction factor that is high for low
    # shear (~9.9 at 1.7 kt SHDC) and converges toward ~1.3 at high shear
    # (33 kt SHDC), matching the physical expectation that generalized shear
    # from non-850-200 hPa levels contributes a ~10 kt floor.
    # Equivalent ratio: max(1.0, 0.953 + 10.251 / SHDC)
    # RHMD (700-500 hPa) is used in place of RHLO (850-700 hPa) since the
    # text file doesn't provide RHLO; archive median RHLO ≈ 68% which is
    # comparable to typical RHMD in TC environments.
    _SHGC_SLOPE = 0.953
    _SHGC_INTERCEPT = 10.251  # kt — floor contribution from non-850-200 levels
    if 'shear_kt' in ships_data and 'rhmd' in ships_data and 'pot_int_kt' in ships_data:
        shear_raw = ships_data['shear_kt']      # ≈ SHDC
        # Variable correction factor: linear model with floor of 1.0
        if shear_raw > 0:
            shgc_shdc_ratio = max(1.0, _SHGC_SLOPE + _SHGC_INTERCEPT / shear_raw)
        else:
            shgc_shdc_ratio = 1.0  # avoid division by zero; low shear → low VP anyway
        shgc_est = shear_raw * shgc_shdc_ratio   # estimated SHGC
        rhmd = ships_data['rhmd']
        pot_int = ships_data['pot_int_kt']
        if pot_int > 0:
            vp = shgc_est * (100 - rhmd) / pot_int
            vp_components = {
                "shear_kt": round(float(shear_raw), 2),
                "shgc_est_kt": round(float(shgc_est), 2),
                "shgc_shdc_ratio": round(float(shgc_shdc_ratio), 3),
                "rhmd": round(float(rhmd), 2),
                "pot_int_kt": round(float(pot_int), 2),
            }

    # SHEAR DIR in SHIPS text files is SDDC: the heading of the deep-layer
    # shear vector (direction it points TO, met convention: 0=N, 90=E, CW).
    # This matches the archive's sddc_ships — no conversion needed.
    if 'shear_dir' in ships_data:
        ships_data['sddc'] = ships_data['shear_dir']

    return {
        "status": "success",
        "atcf_id": atcf_id,
        "analysis_dt": analysis_datetime.isoformat(),
        "storm_name": storm_name,
        "year": year,
        "basin": basin,
        "storm_number": storm_number,
        "ships_data": {k: round(float(v), 2) if isinstance(v, (int, float)) else v
                       for k, v in ships_data.items()},
        "ventilation_proxy": round(float(vp), 2) if vp is not None else None,
        "vp_components": vp_components,
    }


@router.get("/ships")
def get_rt_ships(
    storm_name: str = Query(..., description="Storm name (e.g. BERYL)"),
    year: int = Query(..., ge=2000, le=2030),
    basin: str = Query(None, description="Basin code: AL, EP, CP, WP (optional — auto-detected if omitted)"),
    storm_number: int = Query(None, ge=1, le=50, description="Storm number in basin (optional — auto-detected if omitted)"),
    analysis_dt: str = Query(..., description="TDR analysis datetime ISO format YYYY-MM-DDTHH:MM"),
    lat: float = Query(0.0, description="Storm center latitude (for basin auto-detection)"),
    lon: float = Query(0.0, description="Storm center longitude (for basin auto-detection)"),
):
    """
    Fetch SHIPS text file from NHC FTP and return environmental parameters at t=0.

    If basin and storm_number are provided, searches by exact ATCF ID.
    If omitted, auto-detects by scanning SHIPS files and matching storm name.

    Returns computed ventilation proxy (VP) if possible.
    """
    try:
        analysis_datetime = _dt.fromisoformat(analysis_dt.replace('Z', '+00:00'))
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid analysis_dt format. Use ISO 8601 (YYYY-MM-DDTHH:MM)")

    now = time.time()

    # ── Mode 1: Exact ATCF ID search (basin + storm_number provided) ──
    if basin is not None and storm_number is not None:
        atcf_id = f"{basin}{storm_number:02d}{year % 100:02d}"

        cache_key = (atcf_id, analysis_datetime.isoformat())
        if cache_key in _rt_ships_cache:
            cached_result, ts = _rt_ships_cache[cache_key]
            if now - ts < _RT_SHIPS_CACHE_TTL:
                _rt_ships_cache.move_to_end(cache_key)
                return JSONResponse(cached_result)

        try:
            ships_data = _fetch_ships_from_nhc(atcf_id, analysis_datetime)

            if ships_data is None:
                result = {
                    "status": "not_found",
                    "atcf_id": atcf_id,
                    "analysis_dt": analysis_datetime.isoformat(),
                    "message": f"SHIPS file not found for {atcf_id} at {analysis_datetime.isoformat()}",
                }
            else:
                result = _build_ships_result(
                    ships_data, atcf_id, analysis_datetime,
                    storm_name, year, basin, storm_number
                )

            _rt_ships_cache[cache_key] = (result, now)
            if len(_rt_ships_cache) > 50:
                _rt_ships_cache.popitem(last=False)
            return JSONResponse(result)

        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error fetching SHIPS data: {str(e)}")

    # ── Mode 2: Auto-detect by storm name ──
    cache_key = (storm_name.upper(), analysis_datetime.isoformat())
    if cache_key in _rt_ships_cache:
        cached_result, ts = _rt_ships_cache[cache_key]
        if now - ts < _RT_SHIPS_CACHE_TTL:
            _rt_ships_cache.move_to_end(cache_key)
            return JSONResponse(cached_result)

    try:
        found = _fetch_ships_by_name(storm_name, analysis_datetime, lat, lon)

        if found is None:
            result = {
                "status": "not_found",
                "atcf_id": None,
                "analysis_dt": analysis_datetime.isoformat(),
                "message": f"SHIPS file not found for {storm_name} near {analysis_datetime.isoformat()}",
            }
        else:
            ships_data, discovered_atcf = found
            # Parse discovered ATCF ID (e.g., "AL1325") into basin + storm_number
            d_basin = discovered_atcf[:2] if len(discovered_atcf) >= 2 else "??"
            try:
                d_stnum = int(discovered_atcf[2:4]) if len(discovered_atcf) >= 4 else 0
            except ValueError:
                d_stnum = 0

            result = _build_ships_result(
                ships_data, discovered_atcf, analysis_datetime,
                storm_name, year, d_basin, d_stnum
            )
            result["auto_detected"] = True

        _rt_ships_cache[cache_key] = (result, now)
        if len(_rt_ships_cache) > 50:
            _rt_ships_cache.popitem(last=False)
        return JSONResponse(result)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error fetching SHIPS data: {str(e)}")


@router.get("/quadrant_mean")
def get_rt_quadrant_mean(
    file_url: str = Query(...),
    variable: str = Query("TANGENTIAL_WIND"),
    sddc: float = Query(..., description="Shear HEADING in met degrees (0=N, 90=E, CW)"),
    max_radius_km: float = Query(200.0, ge=10, le=500),
    dr_km: float = Query(2.0, ge=0.5, le=20),
    coverage_min: float = Query(0.5, ge=0.0, le=1.0),
    overlay: str = Query(""),
):
    """
    Compute shear-relative quadrant means for a real-time TDR file.

    Returns quadrant means (DSR, USR, USL, DSL) as 2D arrays.
    """
    if variable not in RT_VARIABLES and variable not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'")

    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open file: {str(e)}")

    try:
        # Extract 3D volume
        vol, heights = _extract_3d(ds, variable)
        x_km, y_km = _get_xy_coords(ds)

        # Compute quadrant means
        quad_means, r_centers = _compute_quadrant_means_rt(
            vol, x_km, y_km, heights, h_axis=0,
            sddc=sddc,
            max_radius=max_radius_km,
            dr=dr_km,
            coverage_min=coverage_min
        )

        case_meta = _build_case_meta(ds)

        result = {
            **case_meta,  # case_meta first so explicit keys can override
            "quadrant_means": {q: {"data": _clean_2d(quad_means[q])} for q in QUADRANT_DEFS},
            "radius_km": [round(float(r), 2) for r in r_centers],
            "height_km": [round(float(h), 2) for h in heights],
            "sddc": round(float(sddc), 1),
            "coverage_min": coverage_min,
            "variable": variable,
        }

        # Optional overlay
        if overlay and overlay in RT_VARIABLES or overlay in RT_DERIVED:
            try:
                ov_vol, _ = _extract_3d(ds, overlay)
                ov_quads, _ = _compute_quadrant_means_rt(
                    ov_vol, x_km, y_km, heights, h_axis=0,
                    sddc=sddc,
                    max_radius=max_radius_km,
                    dr=dr_km,
                    coverage_min=coverage_min
                )
                ov_info = _get_variable_info(overlay)
                result["overlay"] = {
                    "quadrant_means": {q: {"data": _clean_2d(ov_quads[q])} for q in QUADRANT_DEFS},
                    "key": overlay,
                    "display_name": ov_info["display_name"],
                    "units": ov_info["units"],
                    "vmin": ov_info["vmin"],
                    "vmax": ov_info["vmax"],
                }
            except Exception:
                pass

        return JSONResponse(result)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error computing quadrant means: {str(e)}")


@router.get("/anomaly_azimuthal_mean")
def get_rt_anomaly_azimuthal_mean(
    file_url: str = Query(...),
    variable: str = Query("TANGENTIAL_WIND"),
    vmax_kt: float = Query(..., ge=0, le=200, description="Current Vmax in kt (from SHIPS)"),
    rmw_km: Optional[float] = Query(None, ge=1, le=200, description="RMW in km (auto-estimated if omitted)"),
    coverage_min: float = Query(0.5, ge=0.0, le=1.0, description="Min azimuthal coverage fraction"),
):
    """
    Compute Z* anomaly azimuthal mean on hybrid R_H coordinate.

    If rmw_km is not provided, auto-estimate from tangential wind azimuthal mean.
    """
    if variable not in RT_VARIABLES and variable not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'")

    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open file: {str(e)}")

    try:
        # Extract 3D volume
        vol, heights = _extract_3d(ds, variable)
        x_km, y_km = _get_xy_coords(ds)

        # Auto-estimate RMW if not provided
        if rmw_km is None or rmw_km <= 0:
            # Use tangential wind to estimate RMW at z=2km
            try:
                tv_vol, _ = _extract_3d(ds, "TANGENTIAL_WIND")
                # Find 2 km level
                z_idx = np.argmin(np.abs(heights - 2.0))
                tv_2km = tv_vol[z_idx, :, :]

                # Compute radius profile
                xx, yy = np.meshgrid(x_km, y_km)
                rr = np.sqrt(xx**2 + yy**2)

                # Bin by radius and find peak
                r_max = np.nanmax(rr)
                r_edges = np.arange(0, r_max + 5, 5)
                r_centers = (r_edges[:-1] + r_edges[1:]) / 2.0
                r_means = []

                for i in range(len(r_centers)):
                    mask = (rr >= r_edges[i]) & (rr < r_edges[i+1])
                    vals = tv_2km[mask]
                    r_means.append(np.nanmean(vals) if np.any(~np.isnan(vals)) else np.nan)

                # Find peak (use nanargmax on the full array to preserve index alignment)
                r_means_arr = np.array(r_means)
                if np.any(~np.isnan(r_means_arr)):
                    peak_idx = int(np.nanargmax(r_means_arr))
                    rmw_km = float(r_centers[peak_idx])
                else:
                    rmw_km = 20.0  # default fallback
            except Exception:
                rmw_km = 20.0  # default fallback

        # Compute azimuthal mean on hybrid R_H
        az_mean, coverage, r_h_labels, n_inner = _compute_azimuthal_mean_hybrid(
            vol, x_km, y_km, heights, h_axis=0, rmw=rmw_km, coverage_min=coverage_min
        )

        # Look up intensity-matched climatology
        climo_varname = _RT_TO_CLIMO_MAP.get(variable, variable)
        climo_mean, climo_std, climo_count, bin_centre = _get_climatology_for_intensity(
            climo_varname, vmax_kt
        )

        # Compute Z* anomaly — handle height grid mismatch
        z_anomaly = np.full_like(az_mean, np.nan)
        if climo_mean is not None and climo_std is not None:
            if az_mean.shape != climo_mean.shape:
                # Interpolate climatology to real-time height grid
                from scipy.interpolate import interp1d
                climo_heights = _climatology.get("height_km", None)
                if climo_heights is not None and len(climo_heights) > 1:
                    climo_h = np.array(climo_heights, dtype=float)
                    rt_h = np.array(heights, dtype=float)
                    n_r = climo_mean.shape[1]
                    cm_interp = np.full((len(rt_h), n_r), np.nan)
                    cs_interp = np.full((len(rt_h), n_r), np.nan)
                    for ri in range(n_r):
                        col_m = climo_mean[:, ri]
                        col_s = climo_std[:, ri]
                        valid = ~np.isnan(col_m)
                        if valid.sum() >= 2:
                            fm = interp1d(climo_h[valid], col_m[valid], bounds_error=False, fill_value=np.nan)
                            fs = interp1d(climo_h[valid], col_s[valid], bounds_error=False, fill_value=np.nan)
                            cm_interp[:, ri] = fm(rt_h)
                            cs_interp[:, ri] = fs(rt_h)
                    climo_mean = cm_interp
                    climo_std = cs_interp
            # Apply minimum std floor to prevent extreme Z* values
            STD_FLOOR = 1.0 if "vorticity" not in climo_varname else 5e-5
            valid_climo = ~np.isnan(climo_mean) & (climo_std >= STD_FLOOR)
            z_anomaly[valid_climo] = (az_mean[valid_climo] - climo_mean[valid_climo]) / climo_std[valid_climo]

        case_meta = _build_case_meta(ds)

        result = {
            **case_meta,  # case_meta first so explicit keys below can override
            "anomaly": _clean_2d(z_anomaly),
            "azimuthal_mean": _clean_2d(az_mean),
            "coverage": _clean_2d(coverage),
            "r_h_axis": r_h_labels,
            "n_inner": n_inner,
            "height_km": [round(float(h), 2) for h in heights],
            "rmw_km": round(float(rmw_km), 2),
            "vmax_kt": float(vmax_kt),  # from SHIPS, overrides case_meta's None
            "variable": variable,
            "climatology_available": climo_mean is not None,
            "climatology_intensity_bin": float(bin_centre) if bin_centre is not None else None,
            "climatology_count": int(climo_count) if climo_count is not None else 0,
        }

        return JSONResponse(result)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error computing anomaly azimuthal mean: {str(e)}")


# ---------------------------------------------------------------------------
# Memory monitoring & cache management
# ---------------------------------------------------------------------------

def _get_rss_mb() -> float:
    """Get current process RSS in MB (Linux)."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024.0
    except Exception:
        pass
    try:
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    except Exception:
        return -1


def _cache_summary() -> dict:
    """Return a summary of all cache sizes."""
    return {
        "rss_mb": round(_get_rss_mb(), 1),
        "rt_ds_cache": {"count": len(_rt_ds_cache), "max": _RT_DS_CACHE_MAX,
                        "urls": list(_rt_ds_cache.keys())},
        "rt_dir_cache": {"count": len(_rt_dir_cache)},
        "rt_ir_cache": {"count": len(_rt_ir_cache), "max": _RT_IR_CACHE_MAX},
        "rt_sonde_cache": {"count": len(_rt_sonde_cache), "max": _RT_SONDE_CACHE_MAX},
        "rt_fl_cache": {"count": len(_rt_fl_cache), "max": _RT_FL_CACHE_MAX},
        "rt_ships_cache": {"count": len(_rt_ships_cache)},
    }


@router.get("/memory")
def memory_status():
    """Show current memory usage and cache occupancy."""
    return JSONResponse(_cache_summary())


@router.post("/clear_cache")
def clear_all_rt_caches():
    """Emergency cache flush — frees all cached datasets and results."""
    for url, (ds, _) in list(_rt_ds_cache.items()):
        try:
            ds.close()
        except Exception:
            pass
    _rt_ds_cache.clear()
    _rt_ir_cache.clear()
    _rt_sonde_cache.clear()
    _rt_fl_cache.clear()
    _rt_ships_cache.clear()
    gc.collect()
    return JSONResponse({"status": "ok", **_cache_summary()})


@router.get("/vortex_raw")
def get_rt_vortex_raw(
    file_url: str = Query(...),
    vmax_kt: float = Query(..., ge=0, le=200, description="Current Vmax in kt"),
    rmw_km: Optional[float] = Query(None, ge=1, le=200, description="RMW in km (auto-estimated if omitted)"),
):
    """
    Compute raw (un-centred) vortex metrics for a real-time TDR file.

    Returns raw_h1_max and raw_width_diff which must be centred using
    database means from /scatter/vp_favorability to get vortex_height,
    vortex_width, and vortex_favorability.
    """
    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open file: {str(e)}")

    try:
        # Extract Vt and vorticity volumes
        vt_vol, heights = _extract_3d(ds, "TANGENTIAL_WIND")
        vort_vol, _ = _extract_3d(ds, "VORT")
        x_km, y_km = _get_xy_coords(ds)

        # (VORT unit conversion 10⁻⁴ s⁻¹ → s⁻¹ is handled inside _extract_3d)

        # Auto-estimate RMW if not provided
        if rmw_km is None or rmw_km <= 0:
            try:
                z_idx = int(np.argmin(np.abs(heights - 2.0)))
                tv_2km = vt_vol[z_idx, :, :]
                xx, yy = np.meshgrid(x_km, y_km)
                rr = np.sqrt(xx**2 + yy**2)
                r_edges = np.arange(0, float(np.nanmax(rr)) + 5, 5)
                r_centers = (r_edges[:-1] + r_edges[1:]) / 2.0
                r_means = []
                for i in range(len(r_centers)):
                    mask = (rr >= r_edges[i]) & (rr < r_edges[i+1])
                    vals = tv_2km[mask]
                    r_means.append(float(np.nanmean(vals)) if np.any(~np.isnan(vals)) else np.nan)
                r_means_arr = np.array(r_means)
                if np.any(~np.isnan(r_means_arr)):
                    rmw_km = float(r_centers[int(np.nanargmax(r_means_arr))])
                else:
                    rmw_km = 20.0
            except Exception:
                rmw_km = 20.0

        # Compute azimuthal mean Vt on hybrid R_H
        vt_az, _, r_h_labels, n_inner = _compute_azimuthal_mean_hybrid(
            vt_vol, x_km, y_km, heights, h_axis=0, rmw=rmw_km, coverage_min=0.3
        )

        # Compute azimuthal mean vorticity on hybrid R_H
        zeta_az, _, _, _ = _compute_azimuthal_mean_hybrid(
            vort_vol, x_km, y_km, heights, h_axis=0, rmw=rmw_km, coverage_min=0.3
        )

        # Get climatology
        vt_climo_mean, vt_climo_std, _, _ = _get_climatology_for_intensity(
            "merged_tangential_wind", vmax_kt
        )
        zeta_climo_mean, zeta_climo_std, _, _ = _get_climatology_for_intensity(
            "merged_relative_vorticity", vmax_kt
        )

        if vt_climo_mean is None or zeta_climo_mean is None:
            return JSONResponse({
                "status": "no_climatology",
                "message": "Climatology not available for this intensity",
                "vmax_kt": vmax_kt,
                "rmw_km": round(float(rmw_km), 2),
            })

        # Compute Z* anomalies — ensure shapes match (may differ if real-time
        # file has different height levels than the archive climatology)
        if vt_az.shape != vt_climo_mean.shape:
            # Interpolate climatology to match real-time height grid
            from scipy.interpolate import interp1d
            climo_heights = _climatology.get("height_km", None)
            if climo_heights is not None and len(climo_heights) > 1:
                climo_h = np.array(climo_heights, dtype=float)
                rt_h = np.array(heights, dtype=float)
                # Interpolate each radial bin along height axis
                n_r = vt_climo_mean.shape[1]
                vt_mean_interp = np.full((len(rt_h), n_r), np.nan)
                vt_std_interp = np.full((len(rt_h), n_r), np.nan)
                zeta_mean_interp = np.full((len(rt_h), n_r), np.nan)
                zeta_std_interp = np.full((len(rt_h), n_r), np.nan)
                for ri in range(n_r):
                    col_m = vt_climo_mean[:, ri]
                    col_s = vt_climo_std[:, ri]
                    valid = ~np.isnan(col_m)
                    if valid.sum() >= 2:
                        f_m = interp1d(climo_h[valid], col_m[valid], bounds_error=False, fill_value=np.nan)
                        f_s = interp1d(climo_h[valid], col_s[valid], bounds_error=False, fill_value=np.nan)
                        vt_mean_interp[:, ri] = f_m(rt_h)
                        vt_std_interp[:, ri] = f_s(rt_h)
                    col_m2 = zeta_climo_mean[:, ri]
                    col_s2 = zeta_climo_std[:, ri]
                    valid2 = ~np.isnan(col_m2)
                    if valid2.sum() >= 2:
                        f_m2 = interp1d(climo_h[valid2], col_m2[valid2], bounds_error=False, fill_value=np.nan)
                        f_s2 = interp1d(climo_h[valid2], col_s2[valid2], bounds_error=False, fill_value=np.nan)
                        zeta_mean_interp[:, ri] = f_m2(rt_h)
                        zeta_std_interp[:, ri] = f_s2(rt_h)
                vt_climo_mean = vt_mean_interp
                vt_climo_std = vt_std_interp
                zeta_climo_mean = zeta_mean_interp
                zeta_climo_std = zeta_std_interp
                print(f"  [vortex_raw] Interpolated climatology from {len(climo_h)} to {len(rt_h)} heights")
            else:
                return JSONResponse({
                    "status": "shape_mismatch",
                    "message": f"Climatology shape {vt_climo_mean.shape} != azimuthal mean shape {vt_az.shape}",
                })

        # Use physically meaningful minimum std thresholds to prevent
        # extreme Z* values from near-zero std at sparsely-sampled grid cells.
        # Vt std < 1 m/s and vorticity std < 5e-5 s⁻¹ are unreliable.
        VT_STD_FLOOR = 1.0       # m/s
        ZETA_STD_FLOOR = 5e-5    # s⁻¹
        vt_std_safe = np.where(vt_climo_std < VT_STD_FLOOR, np.nan, vt_climo_std)
        zeta_std_safe = np.where(zeta_climo_std < ZETA_STD_FLOOR, np.nan, zeta_climo_std)

        vt_anom = np.where(
            np.isnan(vt_az) | np.isnan(vt_climo_mean) | np.isnan(vt_std_safe),
            np.nan, (vt_az - vt_climo_mean) / vt_std_safe
        )
        zeta_anom = np.where(
            np.isnan(zeta_az) | np.isnan(zeta_climo_mean) | np.isnan(zeta_std_safe),
            np.nan, (zeta_az - zeta_climo_mean) / zeta_std_safe
        )

        r_arr = np.array([float(r) if isinstance(r, (int, float)) else float(r) for r in r_h_labels])

        # H1 domain: 0.8×RMW to RMW+20km, Z=10–14 km
        h1_z = (heights >= 10.0) & (heights <= 14.0)
        h1_r = np.zeros(len(r_arr), dtype=bool)
        for i, rv in enumerate(r_arr):
            if i < n_inner:
                if rv >= 0.8 and rv <= 1.0:
                    h1_r[i] = True
            else:
                if rv >= 0.0 and rv <= 20.0:
                    h1_r[i] = True

        # W1 domain: 0.9×RMW to RMW+10km, Z=2–5 km
        w1_z = (heights >= 2.0) & (heights <= 5.0)
        w1_r = np.zeros(len(r_arr), dtype=bool)
        for i, rv in enumerate(r_arr):
            if i < n_inner:
                if rv >= 0.9 and rv <= 1.0:
                    w1_r[i] = True
            else:
                if rv >= 0.0 and rv <= 10.0:
                    w1_r[i] = True

        # W2 domain: RMW+30 to RMW+70km, Z=2–5 km
        w2_z = (heights >= 2.0) & (heights <= 5.0)
        w2_r = np.zeros(len(r_arr), dtype=bool)
        for i, rv in enumerate(r_arr):
            if i >= n_inner:
                if rv >= 30.0 and rv <= 70.0:
                    w2_r[i] = True

        # Extract metrics
        h1_vt = vt_anom[np.ix_(h1_z, h1_r)]
        w1_zeta = zeta_anom[np.ix_(w1_z, w1_r)]
        w2_zeta = zeta_anom[np.ix_(w2_z, w2_r)]

        if np.all(np.isnan(h1_vt)):
            return JSONResponse({
                "status": "insufficient_data",
                "message": "H1 domain (upper-level Vt anomaly) is all NaN",
                "rmw_km": round(float(rmw_km), 2),
                "h1_z_levels": int(h1_z.sum()),
                "h1_r_bins": int(h1_r.sum()),
            })

        raw_h1_max = float(np.nanmax(h1_vt))

        if np.all(np.isnan(w1_zeta)) or np.all(np.isnan(w2_zeta)):
            return JSONResponse({
                "status": "insufficient_data",
                "message": "W1 or W2 vorticity domain is all NaN",
                "rmw_km": round(float(rmw_km), 2),
                "raw_h1_max": round(raw_h1_max, 4),
            })

        raw_w1_mean = float(np.nanmean(w1_zeta))
        raw_w2_mean = float(np.nanmean(w2_zeta))
        raw_width_diff = raw_w2_mean - raw_w1_mean

        # Try to get database means from tc_radar_api
        try:
            from tc_radar_api import _vortex_db_means
            db_means = _vortex_db_means if _vortex_db_means else None
        except ImportError:
            db_means = None

        result = {
            "status": "ok",
            "raw_h1_max": round(raw_h1_max, 4),
            "raw_width_diff": round(raw_width_diff, 4),
            "rmw_km": round(float(rmw_km), 2),
            "vmax_kt": float(vmax_kt),
            # Diagnostic info for debugging VF values
            "diag": {
                "vt_az_shape": list(vt_az.shape),
                "climo_shape": list(vt_climo_mean.shape) if vt_climo_mean is not None else None,
                "heights": [round(float(h), 2) for h in heights[:5]] + ["..."] + [round(float(h), 2) for h in heights[-3:]] if len(heights) > 8 else [round(float(h), 2) for h in heights],
                "n_heights": len(heights),
                "n_r_bins": len(r_arr),
                "n_inner": n_inner,
                "h1_z_count": int(h1_z.sum()),
                "h1_r_count": int(h1_r.sum()),
                "h1_vt_range": [round(float(np.nanmin(h1_vt)), 4), round(float(np.nanmax(h1_vt)), 4)],
                "w1_zeta_range": [round(float(np.nanmin(w1_zeta)), 4), round(float(np.nanmax(w1_zeta)), 4)],
                "w2_zeta_range": [round(float(np.nanmin(w2_zeta)), 4), round(float(np.nanmax(w2_zeta)), 4)],
                "vt_climo_std_min_h1": round(float(np.nanmin(vt_climo_std[np.ix_(h1_z, h1_r)])), 6) if vt_climo_std is not None and h1_z.any() and h1_r.any() else None,
                "vt_std_floor": VT_STD_FLOOR,
                "zeta_std_floor": ZETA_STD_FLOOR,
                "raw_w1_mean": round(raw_w1_mean, 4),
                "raw_w2_mean": round(raw_w2_mean, 4),
            },
        }

        # If database means are available, compute centred metrics directly
        if db_means:
            vh = raw_h1_max - db_means["h1"]
            vw = raw_width_diff - db_means["wd"]
            result.update({
                "vortex_height": round(vh, 3),
                "vortex_width": round(vw, 3),
                "vortex_favorability": round(vh - vw, 3),
                "db_means": db_means,
            })

        return JSONResponse(result)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error computing vortex metrics: {str(e)}")


# ---------------------------------------------------------------------------
# WCM Center Finding & Tilt Profile (km-space version)
# ---------------------------------------------------------------------------

def _wcm_center_km(u_2d, v_2d, x_km, y_km,
                    num_sectors=12, spad=6, num_iterations=3,
                    first_guess_xy=None):
    """
    Weighted Circulation Maximisation (WCM) centre-finding in storm-centred
    km-space.  Optimised version: crops data to a ~200 km region around the
    first guess to avoid full-grid operations on every candidate.

    Returns dict with center_x_km, center_y_km, center_ix, center_iy,
    rmw_km, vt_max_ms, data_coverage, converged.
    """
    ny, nx = u_2d.shape
    dx_km = float(np.abs(x_km[1] - x_km[0])) if len(x_km) > 1 else 2.0

    # ── First guess ──────────────────────────────────────────────
    if first_guess_xy is not None:
        pnxi, pnyi = first_guess_xy
    else:
        dx_m = dx_km * 1000.0
        dy_m = float(np.abs(y_km[1] - y_km[0])) * 1000.0 if len(y_km) > 1 else 2000.0
        dvdx = np.gradient(v_2d, dx_m, axis=1)
        dudy = np.gradient(u_2d, dy_m, axis=0)
        relvort = dvdx - dudy
        ksize = 21
        kernel = np.ones((ksize, ksize)) / (ksize * ksize)
        mask_f = np.isfinite(relvort)
        rv_filled = np.where(mask_f, relvort, 0.0)
        from scipy.ndimage import convolve
        sm_data = convolve(rv_filled, kernel, mode='reflect')
        sm_wt   = convolve(mask_f.astype(float), kernel, mode='reflect')
        smooth_vort = np.where(sm_wt >= 0.25, sm_data / sm_wt, np.nan)
        mx = np.nanmax(smooth_vort)
        if mx > 0:
            loc = np.unravel_index(np.nanargmax(smooth_vort), smooth_vort.shape)
            pnyi, pnxi = int(loc[0]), int(loc[1])
        else:
            pnyi, pnxi = ny // 2, nx // 2

    # ── Crop to ~200 km region around first guess for speed ──────
    crop_pad = int(np.ceil(200.0 / dx_km))  # ~100 grid points at 2 km res
    y0 = max(0, pnyi - crop_pad)
    y1 = min(ny, pnyi + crop_pad + 1)
    x0 = max(0, pnxi - crop_pad)
    x1 = min(nx, pnxi + crop_pad + 1)

    u_c = u_2d[y0:y1, x0:x1]
    v_c = v_2d[y0:y1, x0:x1]
    x_c = x_km[x0:x1]
    y_c = y_km[y0:y1]
    xx_c, yy_c = np.meshgrid(x_c, y_c)
    ws_c = np.sqrt(u_c**2 + v_c**2)
    wind_angle_c = np.arctan2(v_c, u_c)
    data_mask_c = np.isfinite(ws_c)
    wt_wind_c = np.sqrt(ws_c + 1.0)  # pre-compute once

    cny, cnx = u_c.shape

    # Adjust first-guess indices into cropped frame
    pnyi_c = pnyi - y0
    pnxi_c = pnxi - x0

    # Search / weighting constants
    angle_thresh = np.linspace(-np.pi, np.pi, num_sectors + 1)
    search_radius = 150.0
    core_sigma = 50.0
    coverage_r = 100.0
    coverage_r_inn = 50.0
    min_data_frac = 0.02
    min_wt = 1e-6

    prev_best = np.inf
    yloc_c = xloc_c = np.nan
    best_cov = np.nan
    # Track evaluated errors per candidate (sparse dict instead of full array)
    evaluated = {}

    # ── Iterate ──────────────────────────────────────────────────
    for it in range(num_iterations):
        if it >= 1:
            if prev_best < np.inf:
                pnyi_c, pnxi_c = int(yloc_c), int(xloc_c)
            else:
                break

        ry = range(max(0, pnyi_c - spad), min(cny, pnyi_c + spad + 1))
        rx = range(max(0, pnxi_c - spad), min(cnx, pnxi_c + spad + 1))

        for yi in ry:
            for xi in rx:
                if (yi, xi) in evaluated:
                    continue

                dx_grid = xx_c - x_c[xi]
                dy_grid = yy_c - y_c[yi]
                dist = np.sqrt(dx_grid**2 + dy_grid**2)

                # Quick coverage check before expensive ops
                c_mask = dist <= coverage_r
                nf_quick = np.count_nonzero(data_mask_c & c_mask)
                nt_quick = max(np.count_nonzero(c_mask), 1)
                if nf_quick / nt_quick < min_data_frac:
                    evaluated[(yi, xi)] = np.inf
                    continue

                angle = np.arctan2(dy_grid, dx_grid)

                wt_dist = np.where(data_mask_c,
                                   np.exp(-0.5 * (dist / core_sigma)**2),
                                   np.nan)
                wt_dist = np.maximum(wt_dist, min_wt)
                wt_dist_mean = np.nanmean(wt_dist)
                if wt_dist_mean > 0:
                    wt_dist /= wt_dist_mean

                weight = wt_dist * wt_wind_c

                ideal = angle + np.pi / 2.0
                ideal = np.where(ideal > np.pi, ideal - 2.0 * np.pi, ideal)
                adiff = (wind_angle_c - ideal + np.pi) % (2.0 * np.pi) - np.pi
                wdiff = np.where(dist <= search_radius, weight * adiff, np.nan)

                # Full coverage check
                ci_mask = dist <= coverage_r_inn
                nf = np.count_nonzero(np.isfinite(wdiff) & c_mask)
                nt = max(np.count_nonzero(c_mask), 1)
                nfi = np.count_nonzero(np.isfinite(wdiff) & ci_mask)
                nti = max(np.count_nonzero(ci_mask), 1)

                # Sector mean absolute error
                sector_errs = np.empty(num_sectors)
                sector_errs[:] = np.nan
                for si in range(num_sectors):
                    smask = (angle >= angle_thresh[si]) & (angle < angle_thresh[si + 1])
                    vals = wdiff[smask]
                    if vals.size > 0:
                        sector_errs[si] = np.nanmean(np.abs(vals))

                curr = float(np.nanmean(sector_errs))
                evaluated[(yi, xi)] = curr

                if curr < prev_best:
                    prev_best = curr
                    yloc_c, xloc_c = yi, xi
                    best_cov = min(nf / nt, nfi / nti)

        # Convergence check
        if it >= 1 and yloc_c == pnyi_c and xloc_c == pnxi_c:
            break

    # ── RMW from converged centre ────────────────────────────────
    rmw_km = np.nan
    vt_max = np.nan
    cx_km = cy_km = np.nan
    converged = not (np.isnan(yloc_c) or np.isnan(xloc_c))
    if converged:
        yi_c, xi_c = int(yloc_c), int(xloc_c)
        cx_km = float(x_c[xi_c])
        cy_km = float(y_c[yi_c])

        dx_g = xx_c - cx_km
        dy_g = yy_c - cy_km
        dist_c = np.sqrt(dx_g**2 + dy_g**2)
        ang_c  = np.arctan2(dy_g, dx_g)
        vt = -u_c * np.sin(ang_c) + v_c * np.cos(ang_c)

        dr = 2.0
        radii = np.arange(2.0, 176.0, dr)
        vt_ann = np.full(len(radii), np.nan)
        for ri, r in enumerate(radii):
            amask = (dist_c >= r - 0.5 * dr) & (dist_c < r + 0.5 * dr)
            if np.any(amask):
                vt_ann[ri] = np.nanmean(vt[amask])
        vt_max = float(np.nanmax(vt_ann)) if np.any(np.isfinite(vt_ann)) else np.nan
        try:
            rmw_km = float(radii[np.nanargmax(vt_ann)])
        except (ValueError, IndexError):
            rmw_km = np.nan

    # Convert back to full-grid indices
    full_ix = int(xloc_c) + x0 if converged else None
    full_iy = int(yloc_c) + y0 if converged else None

    return {
        "center_x_km": round(cx_km, 2) if np.isfinite(cx_km) else None,
        "center_y_km": round(cy_km, 2) if np.isfinite(cy_km) else None,
        "center_ix": full_ix,
        "center_iy": full_iy,
        "rmw_km": round(rmw_km, 1) if np.isfinite(rmw_km) else None,
        "vt_max_ms": round(vt_max, 2) if np.isfinite(vt_max) else None,
        "data_coverage": round(best_cov, 3) if np.isfinite(best_cov) else None,
        "converged": converged,
    }


def _compute_rt_tilt_profile(ds, min_height=0.5, max_height=8.0, ref_height=2.0):
    """
    Compute vortex tilt profile for a real-time TDR file by running the WCM
    center finder at every analysis height in parallel.

    Returns the same dict structure as the archive _compute_tilt_profile():
    {x_km, y_km, height_km, tilt_magnitude_km, ref_height_km, rmw_km, method}
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    levels = _get_level_axis(ds)
    x_km, y_km = _get_xy_coords(ds)

    # ── Storm-motion correction ──────────────────────────────────
    # U and V in real-time TDR files are earth-relative.  The WCM
    # needs storm-relative wind, so subtract the storm motion vector.
    attrs = ds.attrs if hasattr(ds, "attrs") else {}
    storm_u = float(attrs.get("EASTWARD STORM MOTION (METERS PER SECOND)", -999))
    storm_v = float(attrs.get("NORTHWARD STORM MOTION (METERS PER SECOND)", -999))
    has_motion = (storm_u != -999 and storm_v != -999
                  and not np.isnan(storm_u) and not np.isnan(storm_v))

    # Select heights in range
    mask = (levels >= min_height - 0.01) & (levels <= max_height + 0.01)
    sel_levels = levels[mask]
    if len(sel_levels) == 0:
        return None

    # Extract U, V at each selected height and convert to storm-relative.
    # .transpose("y", "x") guarantees (ny, nx) dimension order regardless
    # of the native file ordering (which may be (x, y)).
    uv_slices = {}
    for lev in sel_levels:
        z_idx = int(np.argmin(np.abs(levels - lev)))
        try:
            u_er = ds["U"].isel(time=0, level=z_idx).transpose("y", "x").values
            v_er = ds["V"].isel(time=0, level=z_idx).transpose("y", "x").values
            if has_motion:
                u_sr = u_er - storm_u     # earth-relative → storm-relative
                v_sr = v_er - storm_v
            else:
                u_sr, v_sr = u_er, v_er   # best effort if motion unavailable
            uv_slices[float(lev)] = (u_sr, v_sr)
        except Exception:
            pass

    if not uv_slices:
        return None

    # Run WCM at all heights in parallel.  Each level finds its own
    # smoothed-vorticity centroid as the first guess (no first_guess_xy),
    # so the search isn't biased by a single reference level — important
    # when the vortex is highly tilted.
    def _solve_level(lev):
        u, v = uv_slices[lev]
        res = _wcm_center_km(u, v, x_km, y_km,
                              num_sectors=1, spad=6, num_iterations=3)
        return lev, res

    results = {}
    sorted_levels = sorted(uv_slices.keys())
    n_workers = min(len(sorted_levels), 8)

    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        futures = {pool.submit(_solve_level, lev): lev for lev in sorted_levels}
        for fut in as_completed(futures):
            try:
                lev, res = fut.result()
                results[lev] = res
            except Exception:
                pass

    if not results:
        return None

    # Identify the reference level result
    ref_lev = float(sel_levels[np.argmin(np.abs(sel_levels - ref_height))])
    if ref_lev not in results or not results.get(ref_lev, {}).get("converged"):
        # Fall back to closest converged level
        ref_lev = next((l for l in sorted_levels if results.get(l, {}).get("converged")), None)
    if ref_lev is None:
        return None
    ref_result = results[ref_lev]

    if not results:
        return None

    # Build profile relative to reference level
    ref_cx = ref_result["center_x_km"] or 0.0
    ref_cy = ref_result["center_y_km"] or 0.0

    x_out, y_out, h_out, mag_out, rmw_out = [], [], [], [], []
    for lev in sorted_levels:
        r = results.get(lev)
        if r is None or not r["converged"]:
            continue
        cx = r["center_x_km"] or 0.0
        cy = r["center_y_km"] or 0.0
        dx = cx - ref_cx
        dy = cy - ref_cy
        x_out.append(round(dx, 2))
        y_out.append(round(dy, 2))
        h_out.append(round(lev, 2))
        mag_out.append(round(np.sqrt(dx**2 + dy**2), 2))
        rmw_out.append(round(r["rmw_km"], 1) if r["rmw_km"] is not None else None)

    if len(h_out) < 2:
        return None

    return {
        "x_km": x_out,
        "y_km": y_out,
        "height_km": h_out,
        "tilt_magnitude_km": mag_out,
        "ref_height_km": round(ref_lev, 2),
        "rmw_km": rmw_out,
        "method": "wcm_realtime",
        "ref_center_x_km": round(ref_cx, 2),
        "ref_center_y_km": round(ref_cy, 2),
        "storm_motion_corrected": has_motion,
    }


@router.get("/tilt_profile")
def get_rt_tilt_profile(
    file_url:    str   = Query(...,            description="Full URL to the xy.nc(.gz) file"),
    min_height:  float = Query(0.5, ge=0, le=8, description="Minimum height (km)"),
    max_height:  float = Query(8.0, ge=1, le=18, description="Maximum height (km)"),
    ref_height:  float = Query(2.0, ge=0, le=10, description="Reference height for tilt origin (km)"),
):
    """
    Compute WCM vortex centre at every analysis height and return the tilt
    profile (centre displacement relative to the reference height).

    Uses parallel ThreadPoolExecutor for each height level.
    """
    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open file: {str(e)}")

    t0 = time.time()
    try:
        tilt = _compute_rt_tilt_profile(ds, min_height, max_height, ref_height)
    except Exception as e:
        raise HTTPException(status_code=500,
                            detail=f"Error computing tilt profile: {str(e)}")
    elapsed = time.time() - t0

    if tilt is None:
        raise HTTPException(status_code=400,
                            detail="Could not compute tilt — insufficient data.")

    tilt["compute_time_s"] = round(elapsed, 2)
    return JSONResponse(tilt)


# ---------------------------------------------------------------------------
# Single-case CFAD (Contoured Frequency by Altitude Diagram) for real-time TDR
# ---------------------------------------------------------------------------

# Default bin configurations per variable
_RT_CFAD_BINS = {
    "REFLECTIVITY":    (-10, 60,  1.0),
    "TANGENTIAL_WIND": (-10, 80,  2.0),
    "RADIAL_WIND":     (-30, 30,  2.0),
    "W":               (-8,  8,   0.5),
    "WIND_SPEED":      (0,   80,  2.0),
    "WIND_SPEED_EARTH":(0,   80,  2.0),
    "VORT":            (-0.005, 0.005, 0.0002),
}

@router.get("/cfad")
def get_rt_cfad(
    file_url:    str   = Query(...,                 description="Full URL to the xy.nc(.gz) file"),
    variable:    str   = Query("REFLECTIVITY",      description="Variable key"),
    bin_min:     float = Query(None,                description="Lower bin edge (auto if omitted)"),
    bin_max:     float = Query(None,                description="Upper bin edge (auto if omitted)"),
    bin_width:   float = Query(None,                description="Bin width (auto if omitted)"),
    n_bins:      int   = Query(40,   ge=5, le=200,  description="Number of bins (if bin_width omitted)"),
    min_radius:  float = Query(0,    ge=0,  le=500, description="Minimum radius (km)"),
    max_radius:  float = Query(200,  ge=0.1, le=500,description="Maximum radius (km)"),
    normalise:   str   = Query("height",            description="'height', 'total', or 'raw'"),
):
    """Compute a CFAD for a single real-time TDR analysis."""
    if variable not in RT_VARIABLES and variable not in RT_DERIVED:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if normalise not in ("total", "height", "raw"):
        raise HTTPException(status_code=400, detail="normalise must be 'total', 'height', or 'raw'")

    try:
        ds = _open_rt_dataset(file_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open file: {str(e)}")

    # Extract 3D volume (level, y, x)
    vol, heights = _extract_3d(ds, variable)
    x_km, y_km = _get_xy_coords(ds)
    meta = _build_case_meta(ds)

    # Variable display info
    if variable in RT_VARIABLES:
        display_name, cmap, units, vmin, vmax = RT_VARIABLES[variable]
    else:
        info = RT_DERIVED[variable]
        display_name, cmap, units, vmin, vmax = info["display_name"], info.get("cmap", "inferno"), info["units"], info["vmin"], info["vmax"]

    # Bin edges
    if variable in _RT_CFAD_BINS:
        default_min, default_max, default_width = _RT_CFAD_BINS[variable]
    else:
        default_min, default_max, default_width = vmin, vmax, None

    b_min = bin_min if bin_min is not None else default_min
    b_max = bin_max if bin_max is not None else default_max
    if bin_width is not None and bin_width > 0:
        bin_edges = np.arange(b_min, b_max + bin_width * 0.5, bin_width)
    elif default_width is not None and bin_width is None:
        bin_edges = np.arange(b_min, b_max + default_width * 0.5, default_width)
    else:
        bin_edges = np.linspace(b_min, b_max, n_bins + 1)

    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2.0
    n_heights = len(heights)
    actual_n_bins = len(bin_centers)

    # Radial mask
    xx, yy = np.meshgrid(x_km, y_km)
    rr = np.sqrt(xx**2 + yy**2)
    spatial_mask = (rr >= min_radius) & (rr <= max_radius)

    # Histogram at each height
    hist_2d = np.zeros((n_heights, actual_n_bins), dtype=np.float64)
    for h in range(n_heights):
        slab = vol[h, :, :]
        vals = slab[spatial_mask & ~np.isnan(slab)]
        if len(vals) == 0:
            continue
        counts, _ = np.histogram(vals, bins=bin_edges)
        hist_2d[h, :] = counts

    # Normalise
    if normalise == "total":
        total = np.nansum(hist_2d)
        if total > 0:
            hist_2d = (hist_2d / total) * 100.0
    elif normalise == "height":
        row_sums = np.nansum(hist_2d, axis=1, keepdims=True)
        row_sums[row_sums == 0] = 1
        hist_2d = (hist_2d / row_sums) * 100.0

    norm_label = {"total": "% of total", "height": "% at each height"}.get(normalise, "count")

    # Clean for JSON
    cfad_list = []
    for row in hist_2d:
        cfad_list.append([round(float(v), 4) if np.isfinite(v) else 0.0 for v in row])

    return JSONResponse({
        "cfad": cfad_list,
        "bin_centers": [round(float(b), 6) for b in bin_centers],
        "bin_edges": [round(float(b), 6) for b in bin_edges],
        "bin_width": round(float(bin_edges[1] - bin_edges[0]), 6),
        "height_km": [round(float(h), 2) for h in heights],
        "normalise": normalise,
        "norm_label": norm_label,
        "variable": {
            "key": variable,
            "display_name": display_name,
            "units": units,
            "vmin": vmin,
            "vmax": vmax,
        },
        "radial_domain": [min_radius, max_radius],
        "case_meta": meta,
    })
