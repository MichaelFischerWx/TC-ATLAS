"""
satellite_ir.py — Shared Geostationary Satellite IR Module
============================================================
Provides GOES-16/18/19 and Himawari-9 IR imagery access,
subsetting, and rendering for the Real-Time IR Monitor and Real-Time
TDR modules.

Satellite routing by storm longitude:
  - GOES-East (GOES-19):  100°W to 10°E   (Atlantic, Caribbean)
  - GOES-West (GOES-18):  175°W to 100°W  (Eastern/Central Pacific)
  - Himawari-9:            80°E to 175°W   (Western Pacific, IO, SH)

This module is imported by ir_monitor_api.py and can eventually
replace the duplicate GOES code in realtime_tdr_api.py.

Dependencies: s3fs, pyproj, xarray, numpy, Pillow
All are lazy-imported so the module won't crash if they're missing.
"""

import base64
import gc
import io
import re
from collections import OrderedDict
from datetime import datetime as _dt, timedelta, timezone
from typing import Optional

import numpy as np

# ---------------------------------------------------------------------------
# Lazy imports (same pattern as realtime_tdr_api.py)
# ---------------------------------------------------------------------------

_s3fs_mod = None
_pyproj_mod = None
_goes_fs = None


def _get_s3fs():
    """Lazy-import s3fs."""
    global _s3fs_mod
    if _s3fs_mod is None:
        try:
            import s3fs
            _s3fs_mod = s3fs
        except ImportError:
            return None
    return _s3fs_mod


def _get_pyproj():
    """Lazy-import pyproj."""
    global _pyproj_mod
    if _pyproj_mod is None:
        try:
            import pyproj
            _pyproj_mod = pyproj
        except ImportError:
            return None
    return _pyproj_mod


def get_goes_fs():
    """Return a shared s3fs filesystem for public NOAA GOES buckets."""
    global _goes_fs
    if _goes_fs is None:
        s3fs = _get_s3fs()
        if s3fs is None:
            return None
        _goes_fs = s3fs.S3FileSystem(anon=True)
    return _goes_fs


# ---------------------------------------------------------------------------
# GOES Configuration
# ---------------------------------------------------------------------------

GOES_BUCKETS = {
    "east_16": "noaa-goes16",
    "east_19": "noaa-goes19",
    "west":    "noaa-goes18",
}

GOES_LON_0 = {"east": -75.2, "west": -137.2}
GOES_SAT_HEIGHT = 35786023.0  # metres above Earth centre

# GOES-19 became operational GOES-East on 2025-04-04 15:00 UTC
GOES_TRANSITION_DT = _dt(2025, 4, 4, 15, 0, 0, tzinfo=timezone.utc)

# ---------------------------------------------------------------------------
# Himawari-9 Configuration
# ---------------------------------------------------------------------------

HIMAWARI_BUCKET = "noaa-himawari9"
HIMAWARI_LON_0 = 140.7            # subsatellite point (°E)
HIMAWARI_SAT_HEIGHT = 35786023.0   # same as GOES
HIMAWARI_SWEEP = "y"               # Himawari uses sweep='y' (GOES uses 'x')

# Himawari AHI products on NOAA S3
# Band 13 (10.4 µm) = clean IR window, equivalent to GOES Band 13
HIMAWARI_PRODUCT = "AHI-L2-FLDK-ISatSS"
HIMAWARI_BAND = 13

# ---------------------------------------------------------------------------
# Common IR settings
# ---------------------------------------------------------------------------

IR_PRODUCT = "ABI-L2-CMIPF"     # GOES full-disk Cloud & Moisture Imagery
IR_BAND = 13                     # 10.3 µm clean longwave IR window
IR_VARIABLE = "CMI"              # variable name in CMI file

IR_VMIN = 190.0                  # brightness temperature colour limits (K)
IR_VMAX = 310.0

# Enhanced IR colormap LUT (cold → bright/colourful, warm → dark grey)
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
        lut[i, 3] = 255  # fully opaque for standalone rendering
    return lut


_IR_LUT = _build_ir_lut()


# ---------------------------------------------------------------------------
# Core Functions
# ---------------------------------------------------------------------------

def select_goes_sat(longitude: float, analysis_dt: _dt) -> tuple:
    """
    Select geostationary satellite based on storm longitude and analysis date.
    Returns (bucket_name, sat_key) where sat_key is 'east', 'west', or 'himawari'.

    Routing:
      -100° ≤ lon ≤ +10°  → GOES-East  (Atlantic)
      -175° ≤ lon < -100°  → GOES-West  (East/Central Pacific)
      Everything else       → Himawari-9 (Western Pacific, IO, SH)
    """
    # Normalise to -180..+180
    lon = ((longitude + 180) % 360) - 180

    if -100 <= lon <= 10:
        # Atlantic, Caribbean, Gulf of Mexico
        sat_key = "east"
        if analysis_dt.replace(tzinfo=timezone.utc) >= GOES_TRANSITION_DT:
            bucket = GOES_BUCKETS["east_19"]
        else:
            bucket = GOES_BUCKETS["east_16"]
    elif -175 <= lon < -100:
        # Eastern / Central Pacific
        sat_key = "west"
        bucket = GOES_BUCKETS["west"]
    else:
        # Western Pacific, Indian Ocean, Southern Hemisphere
        sat_key = "himawari"
        bucket = HIMAWARI_BUCKET

    return bucket, sat_key


def satellite_name_from_bucket(bucket: str) -> str:
    """Human-readable satellite name from bucket."""
    names = {
        "noaa-goes16": "GOES-16",
        "noaa-goes19": "GOES-19",
        "noaa-goes18": "GOES-18",
        "noaa-himawari9": "Himawari-9",
    }
    return names.get(bucket, bucket)


def find_goes_file(bucket: str, target_dt: _dt,
                   tolerance_min: int = 15) -> Optional[str]:
    """
    Find the GOES ABI Band 13 full-disk file closest to target_dt.
    Returns the full S3 key or None.
    """
    fs = get_goes_fs()
    if fs is None:
        return None

    jday = target_dt.timetuple().tm_yday
    prefix = f"{bucket}/{IR_PRODUCT}/{target_dt.year}/{jday:03d}/{target_dt.hour:02d}/"

    try:
        files = fs.ls(prefix, detail=False)
    except Exception:
        return None

    band_tag = f"C{IR_BAND:02d}"
    candidates = [f for f in files if band_tag in f.split("/")[-1]]
    if not candidates:
        return None

    best_file = None
    best_delta = timedelta(minutes=tolerance_min + 1)
    ts_re = re.compile(r"[-_]s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})")

    for fpath in candidates:
        fname = fpath.split("/")[-1]
        m = ts_re.search(fname)
        if not m:
            continue
        try:
            yr = int(m.group(1))
            jd = int(m.group(2))
            hh = int(m.group(3))
            mm = int(m.group(4))
            ss = int(m.group(5))
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


def latlon_to_goes_xy(lat: float, lon: float, sat_key: str) -> tuple:
    """Convert geographic (lat, lon) to GOES fixed-grid (x, y) in radians."""
    pyproj = _get_pyproj()
    if pyproj is None:
        raise RuntimeError("pyproj is required for GOES IR subsetting")
    lon_0 = GOES_LON_0[sat_key]
    proj = pyproj.Proj(proj="geos", h=GOES_SAT_HEIGHT, lon_0=lon_0, sweep="x")
    x_m, y_m = proj(lon, lat)
    return x_m / GOES_SAT_HEIGHT, y_m / GOES_SAT_HEIGHT


def latlon_to_himawari_xy(lat: float, lon: float) -> tuple:
    """Convert geographic (lat, lon) to Himawari fixed-grid (x, y) in radians."""
    pyproj = _get_pyproj()
    if pyproj is None:
        raise RuntimeError("pyproj is required for Himawari IR subsetting")
    proj = pyproj.Proj(
        proj="geos", h=HIMAWARI_SAT_HEIGHT,
        lon_0=HIMAWARI_LON_0, sweep=HIMAWARI_SWEEP,
    )
    x_m, y_m = proj(lon, lat)
    return x_m / HIMAWARI_SAT_HEIGHT, y_m / HIMAWARI_SAT_HEIGHT


def open_goes_subset(s3_key: str, center_lat: float, center_lon: float,
                     sat_key: str, box_deg: float = 8.0) -> np.ndarray:
    """
    Open a GOES CMI file from S3 and return a geographically-subsetted
    2D brightness-temperature array (y, x) in Kelvin.
    """
    import xarray as xr

    fs = get_goes_fs()
    if fs is None:
        raise RuntimeError("s3fs not available")

    half = box_deg / 2.0
    x_min, y_min = latlon_to_goes_xy(center_lat - half, center_lon - half, sat_key)
    x_max, y_max = latlon_to_goes_xy(center_lat + half, center_lon + half, sat_key)
    x_lo, x_hi = min(x_min, x_max), max(x_min, x_max)
    y_lo, y_hi = min(y_min, y_max), max(y_min, y_max)

    fobj = fs.open(f"s3://{s3_key}", "rb")
    try:
        ds = xr.open_dataset(fobj, engine="h5netcdf")
        ds_sub = ds.sel(x=slice(x_lo, x_hi), y=slice(y_hi, y_lo))

        if IR_VARIABLE in ds_sub:
            tb = ds_sub[IR_VARIABLE].values.astype(np.float32)
        else:
            alt_var = f"CMI_C{IR_BAND:02d}"
            if alt_var in ds_sub:
                tb = ds_sub[alt_var].values.astype(np.float32)
            else:
                raise ValueError(f"Neither {IR_VARIABLE} nor {alt_var} found in dataset")
    finally:
        ds.close()
        fobj.close()
        gc.collect()
    return tb


def find_himawari_file(target_dt: _dt, tolerance_min: int = 20) -> Optional[str]:
    """
    Find a Himawari-9 AHI Band 13 full-disk file closest to target_dt.
    Returns the full S3 key or None.

    Tries multiple known product paths on the noaa-himawari9 bucket.
    """
    fs = get_goes_fs()  # same anon S3 filesystem works for all NOAA buckets
    if fs is None:
        return None

    jday = target_dt.timetuple().tm_yday

    # Try known Himawari product paths on NOAA S3
    product_paths = [
        f"{HIMAWARI_BUCKET}/AHI-L2-FLDK-ISatSS/{target_dt.year}/{jday:03d}/{target_dt.hour:02d}/",
        f"{HIMAWARI_BUCKET}/AHI-L1b-FLDK/{target_dt.year}/{jday:03d}/{target_dt.hour:02d}/",
    ]

    for prefix in product_paths:
        try:
            files = fs.ls(prefix, detail=False)
        except Exception:
            continue

        if not files:
            continue

        # Filter for Band 13 files
        band_tags = [f"B{HIMAWARI_BAND:02d}", f"C{HIMAWARI_BAND:02d}", f"b{HIMAWARI_BAND:02d}"]
        candidates = []
        for f in files:
            fname = f.split("/")[-1]
            if any(tag in fname for tag in band_tags):
                candidates.append(f)

        if not candidates:
            # If no band-specific files, the product might store all bands in one file
            # (e.g., ISatSS stores SST which already contains Tb)
            candidates = files[:5]  # try first few files

        # Find closest to target time
        best_file = None
        best_delta = timedelta(minutes=tolerance_min + 1)

        # Himawari filenames typically contain timestamps
        # Pattern: various formats including YYYYMMDD_HHMM, or sYYYYJJJHHMMSS
        ts_patterns = [
            re.compile(r"(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})"),  # YYYYMMDD_HHMM
            re.compile(r"[-_]s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})"),  # sYYYYJJJHHMMSS
        ]

        for fpath in candidates:
            fname = fpath.split("/")[-1]
            for ts_re in ts_patterns:
                m = ts_re.search(fname)
                if not m:
                    continue
                try:
                    groups = m.groups()
                    if len(groups) == 5 and len(m.group(1)) == 4 and len(m.group(2)) == 2:
                        # YYYYMMDD_HHMM format
                        file_dt = _dt(
                            int(groups[0]), int(groups[1]), int(groups[2]),
                            int(groups[3]), int(groups[4]),
                            tzinfo=timezone.utc,
                        )
                    else:
                        # sYYYYJJJHHMMSS format (same as GOES)
                        yr = int(groups[0])
                        jd = int(groups[1])
                        hh = int(groups[2])
                        mm = int(groups[3])
                        ss = int(groups[4])
                        file_dt = _dt(yr, 1, 1, hh, mm, ss, tzinfo=timezone.utc) + timedelta(days=jd - 1)

                    delta = abs(file_dt - target_dt.replace(tzinfo=timezone.utc))
                    if delta < best_delta:
                        best_delta = delta
                        best_file = fpath
                    break
                except Exception:
                    continue

        if best_file and best_delta <= timedelta(minutes=tolerance_min):
            print(f"[satellite_ir] Himawari file found: {best_file.split('/')[-1]}")
            return best_file

    print(f"[satellite_ir] No Himawari file found for {target_dt.isoformat()}")
    return None


def open_himawari_subset(s3_key: str, center_lat: float, center_lon: float,
                         box_deg: float = 8.0) -> np.ndarray:
    """
    Open a Himawari file from S3 and return a geographically-subsetted
    2D brightness-temperature array (y, x) in Kelvin.
    """
    import xarray as xr

    fs = get_goes_fs()
    if fs is None:
        raise RuntimeError("s3fs not available")

    half = box_deg / 2.0
    x_min, y_min = latlon_to_himawari_xy(center_lat - half, center_lon - half)
    x_max, y_max = latlon_to_himawari_xy(center_lat + half, center_lon + half)
    x_lo, x_hi = min(x_min, x_max), max(x_min, x_max)
    y_lo, y_hi = min(y_min, y_max), max(y_min, y_max)

    fobj = fs.open(f"s3://{s3_key}", "rb")
    try:
        ds = xr.open_dataset(fobj, engine="h5netcdf")

        # Try subsetting by x/y coordinates (same convention as GOES)
        if "x" in ds.coords and "y" in ds.coords:
            ds_sub = ds.sel(x=slice(x_lo, x_hi), y=slice(y_hi, y_lo))
        elif "longitude" in ds.coords and "latitude" in ds.coords:
            # Some products use lat/lon directly
            ds_sub = ds.sel(
                longitude=slice(center_lon - half, center_lon + half),
                latitude=slice(center_lat + half, center_lat - half),
            )
        else:
            # Fall back to first 2D variable
            ds_sub = ds

        # Try common variable names for brightness temperature
        tb = None
        for var_name in ["CMI", "Tb", "toa_brightness_temperature",
                         "sea_surface_temperature", "SST",
                         f"CMI_C{HIMAWARI_BAND:02d}"]:
            if var_name in ds_sub:
                tb = ds_sub[var_name].values.astype(np.float32)
                break

        if tb is None:
            # Try first data variable
            data_vars = list(ds_sub.data_vars)
            if data_vars:
                tb = ds_sub[data_vars[0]].values.astype(np.float32)
            else:
                raise ValueError(f"No suitable variable found in Himawari file")
    finally:
        ds.close()
        fobj.close()
        gc.collect()

    return tb


# ---------------------------------------------------------------------------
# IR Vigor Colormap
# ---------------------------------------------------------------------------
# Diverging colormap for vigor: dark → blue (low vigor) → white → yellow →
# red → magenta (high vigor).  Vigor values are normalised 0..1 where 0.5 is
# the "neutral" point.

_VIGOR_STOPS = [
    (0.00,  10,  10,  30),    # very low vigor — near-black/deep blue
    (0.10,  20,  40, 120),
    (0.20,  40,  80, 180),
    (0.30,  80, 140, 220),
    (0.40, 160, 200, 240),
    (0.50, 230, 230, 230),    # neutral — light grey
    (0.60, 255, 255, 150),
    (0.70, 255, 220,  50),
    (0.80, 255, 140,   0),
    (0.90, 230,  50,   0),
    (1.00, 200,   0, 150),    # extreme vigor — magenta
]


def _build_vigor_lut() -> np.ndarray:
    """Build a 256-entry uint8 RGBA LUT for IR vigor rendering."""
    lut = np.zeros((256, 4), dtype=np.uint8)
    for i in range(256):
        frac = i / 255.0
        lo, hi = _VIGOR_STOPS[0], _VIGOR_STOPS[-1]
        for s in range(len(_VIGOR_STOPS) - 1):
            if _VIGOR_STOPS[s][0] <= frac <= _VIGOR_STOPS[s + 1][0]:
                lo, hi = _VIGOR_STOPS[s], _VIGOR_STOPS[s + 1]
                break
        t = 0.0 if hi[0] == lo[0] else (frac - lo[0]) / (hi[0] - lo[0])
        lut[i, 0] = int(lo[1] + t * (hi[1] - lo[1]) + 0.5)
        lut[i, 1] = int(lo[2] + t * (hi[2] - lo[2]) + 0.5)
        lut[i, 2] = int(lo[3] + t * (hi[3] - lo[3]) + 0.5)
        lut[i, 3] = 255
    return lut


_VIGOR_LUT = _build_vigor_lut()

# Vigor rendering range (in Kelvin — vigor = Tb_current − local_min_avg)
VIGOR_VMIN = -10.0   # strong deepening convection (colder than local avg min)
VIGOR_VMAX = 80.0    # clear sky well above local coldest convection


# ---------------------------------------------------------------------------
# Raw Tb Fetcher (for vigor computation)
# ---------------------------------------------------------------------------

def fetch_ir_tb_raw(center_lat: float, center_lon: float,
                    target_dt: _dt, box_deg: float = 8.0) -> Optional[dict]:
    """
    Fetch a single IR frame and return the RAW brightness temperature array.
    Same routing as fetch_ir_frame but returns numpy Tb instead of rendered PNG.
    Returns dict with 'tb' (np.ndarray), 'datetime_utc', 'satellite', 'bounds'
    or None on failure.
    """
    bucket, sat_key = select_goes_sat(center_lon, target_dt)

    try:
        if sat_key == "himawari":
            s3_key = find_himawari_file(target_dt)
            if not s3_key:
                return None
            tb = open_himawari_subset(s3_key, center_lat, center_lon, box_deg)
        else:
            s3_key = find_goes_file(bucket, target_dt)
            if not s3_key:
                return None
            tb = open_goes_subset(s3_key, center_lat, center_lon, sat_key, box_deg)

        if not np.any(np.isfinite(tb)):
            return None

        half = box_deg / 2.0
        return {
            "tb": tb,
            "datetime_utc": target_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "satellite": satellite_name_from_bucket(bucket),
            "bounds": [
                [center_lat - half, center_lon - half],
                [center_lat + half, center_lon + half],
            ],
            "storm_center": {"lat": center_lat, "lon": center_lon},
        }
    except Exception:
        import traceback
        traceback.print_exc()
        return None


# ---------------------------------------------------------------------------
# Spatially-Aware IR Vigor Computation
# ---------------------------------------------------------------------------

def _build_circular_footprint(radius_km: float, pixel_km: float) -> np.ndarray:
    """
    Build a 2D boolean circular footprint for use with scipy ndimage filters.
    radius_km: physical radius in km
    pixel_km:  approximate pixel size in km
    Returns boolean ndarray.
    """
    radius_px = max(1, int(round(radius_km / pixel_km)))
    size = 2 * radius_px + 1
    y, x = np.ogrid[-radius_px:radius_px + 1, -radius_px:radius_px + 1]
    mask = (x * x + y * y) <= (radius_px * radius_px)
    return mask


def compute_ir_vigor(tb_frames: list, radius_km: float = 300.0,
                     box_deg: float = 8.0) -> Optional[np.ndarray]:
    """
    Compute spatially-aware IR vigor from a list of raw Tb arrays.

    For each grid point, vigor = current_Tb − local_min(temporal_avg),
    where local_min is the minimum within `radius_km` of that point.

    Parameters
    ----------
    tb_frames : list of np.ndarray
        Raw Tb arrays (oldest first).  The LAST frame is "current".
    radius_km : float
        Spatial radius (km) for the local minimum filter.
    box_deg : float
        Size of the cutout domain in degrees (used to estimate pixel size).

    Returns
    -------
    np.ndarray or None
        2D vigor array (same shape as input frames) in Kelvin.
    """
    from scipy.ndimage import minimum_filter

    if not tb_frames or len(tb_frames) < 2:
        return None

    # Current frame is the last one
    current_tb = tb_frames[-1].astype(np.float32)

    # Temporal average of all frames
    stack = np.stack([f.astype(np.float32) for f in tb_frames], axis=0)
    avg_tb = np.nanmean(stack, axis=0)

    # Estimate pixel size in km from domain size and array shape
    # box_deg covers the full domain; 1° latitude ≈ 111 km
    domain_km = box_deg * 111.0
    ny, nx = current_tb.shape
    pixel_km = domain_km / max(ny, nx) if max(ny, nx) > 0 else 2.0

    # Build circular footprint for the spatial filter
    footprint = _build_circular_footprint(radius_km, pixel_km)

    # Spatially-aware local minimum of the temporal average
    # NaN-safe: replace NaN with extreme sentinel before filtering, restore after
    _NAN_SENTINEL = 9999.0
    avg_filled = np.where(np.isfinite(avg_tb), avg_tb, _NAN_SENTINEL)
    local_min = minimum_filter(avg_filled, footprint=footprint)
    local_min = np.where(local_min >= _NAN_SENTINEL * 0.9, np.nan, local_min)

    # Vigor = current Tb − local min of temporal average
    vigor = current_tb - local_min

    return vigor


def render_vigor_png(vigor_2d: np.ndarray,
                     as_data_url: bool = False) -> Optional[str]:
    """
    Render a 2D vigor array to a base64-encoded PNG string using
    the vigor colormap.  Returns None if all data is NaN.
    """
    from PIL import Image

    arr = np.asarray(vigor_2d, dtype=np.float32)
    if not np.any(np.isfinite(arr)):
        return None

    # Normalise to 0..1 range using vigor limits
    frac = (arr - VIGOR_VMIN) / (VIGOR_VMAX - VIGOR_VMIN)
    frac = np.clip(frac, 0.0, 1.0)
    indices = (frac * 255).astype(np.uint8)

    rgba = _VIGOR_LUT[indices]  # (H, W, 4)

    # NaN / invalid pixels → transparent
    mask = ~np.isfinite(arr)
    rgba[mask] = [0, 0, 0, 0]

    img = Image.fromarray(rgba, "RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    if as_data_url:
        return f"data:image/png;base64,{b64}"
    return b64


def render_ir_png(frame_2d: np.ndarray, as_data_url: bool = False) -> Optional[str]:
    """
    Render a 2D Tb array to a base64-encoded PNG string.
    If as_data_url=True, prepends 'data:image/png;base64,'.
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

    rgba = _IR_LUT[indices]  # (H, W, 4)

    # NaN / invalid pixels → transparent
    mask = ~np.isfinite(arr) | (arr <= 0)
    rgba[mask] = [0, 0, 0, 0]

    img = Image.fromarray(rgba, "RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    if as_data_url:
        return f"data:image/png;base64,{b64}"
    return b64


def build_frame_times(center_dt: _dt, lookback_hours: float = 6.0,
                      interval_min: int = 30) -> list:
    """
    Build list of target GOES scan times for an IR animation.
    Returns datetimes from t=0 (most recent) to t−lookback_hours.
    """
    base = center_dt.replace(tzinfo=timezone.utc) if center_dt.tzinfo is None else center_dt
    n_frames = int(lookback_hours * 60 / interval_min) + 1
    return [base - timedelta(minutes=i * interval_min) for i in range(n_frames)]


def fetch_ir_frame(center_lat: float, center_lon: float,
                   target_dt: _dt, box_deg: float = 8.0) -> Optional[dict]:
    """
    Fetch and render a single IR frame for a given storm position and time.
    Automatically routes to GOES or Himawari based on longitude.
    Returns dict with 'image_b64', 'datetime_utc', 'satellite', 'bounds'
    or None on failure.
    """
    bucket, sat_key = select_goes_sat(center_lon, target_dt)

    try:
        if sat_key == "himawari":
            # ── Himawari-9 path ──
            s3_key = find_himawari_file(target_dt)
            if not s3_key:
                return None
            tb = open_himawari_subset(s3_key, center_lat, center_lon, box_deg)
        else:
            # ── GOES path ──
            s3_key = find_goes_file(bucket, target_dt)
            if not s3_key:
                return None
            tb = open_goes_subset(s3_key, center_lat, center_lon, sat_key, box_deg)

        png_b64 = render_ir_png(tb)
        del tb
        gc.collect()

        if not png_b64:
            return None

        half = box_deg / 2.0
        return {
            "image_b64": png_b64,
            "datetime_utc": target_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "satellite": satellite_name_from_bucket(bucket),
            "bounds": [
                [center_lat - half, center_lon - half],
                [center_lat + half, center_lon + half],
            ],
            "storm_center": {"lat": center_lat, "lon": center_lon},
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return None
