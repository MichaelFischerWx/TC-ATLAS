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
import threading
import time
from collections import OrderedDict
from datetime import datetime as _dt, timedelta, timezone
from typing import Optional, Tuple

import numpy as np

# ---------------------------------------------------------------------------
# fs.ls() listing cache — S3 LIST is slow and results are stable for minutes
# ---------------------------------------------------------------------------

_FS_LS_TTL_SEC = 120
_FS_LS_MAX_ENTRIES = 512
_fs_ls_cache: "OrderedDict[tuple, tuple[float, list]]" = OrderedDict()
_fs_ls_lock = threading.Lock()


def _cached_fs_ls(fs, prefix, detail=False):
    """LRU + TTL cache wrapper around fs.ls() to cut redundant S3 LIST calls."""
    key = (id(fs), prefix, bool(detail))
    now = time.monotonic()
    with _fs_ls_lock:
        hit = _fs_ls_cache.get(key)
        if hit is not None:
            ts, cached = hit
            if now - ts < _FS_LS_TTL_SEC:
                _fs_ls_cache.move_to_end(key)
                return cached
            del _fs_ls_cache[key]

    result = fs.ls(prefix, detail=detail)

    with _fs_ls_lock:
        _fs_ls_cache[key] = (now, result)
        _fs_ls_cache.move_to_end(key)
        while len(_fs_ls_cache) > _FS_LS_MAX_ENTRIES:
            _fs_ls_cache.popitem(last=False)
    return result

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
GOES_SWEEP = "x"               # GOES ABI fixed grid uses sweep='x'

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
# As of 2026, L1b data uses HSD format (.DAT.bz2) with month/day/HHMM paths:
#   AHI-L1b-FLDK/{year}/{month:02d}/{day:02d}/{HHMM}/HS_H09_..._B13_FLDK_R20_S{seg}.DAT.bz2
# Band 13 (10.4 µm) at 2km resolution (R20), 10 segments per scan
HIMAWARI_L1B_PRODUCT = "AHI-L1b-FLDK"
HIMAWARI_BAND = 13
HIMAWARI_N_SEGMENTS = 10   # full disk is split into 10 latitude segments
HIMAWARI_NLINES_PER_SEG = 550  # lines per segment at 2km resolution
HIMAWARI_NCOLS = 5500      # columns at 2km resolution (full disk)

# Per-band resolution for Himawari AHI (native pixel size in meters)
# Band 3 = 0.5km (R05), Band 8 = 2km (R20), Band 13 = 2km (R20)
HIMAWARI_BAND_RES_M = {
    1: 1000, 2: 1000, 3: 500, 4: 1000,
    5: 2000, 6: 2000, 7: 2000, 8: 2000,
    9: 2000, 10: 2000, 11: 2000, 12: 2000,
    13: 2000, 14: 2000, 15: 2000, 16: 2000,
}

# ---------------------------------------------------------------------------
# Common IR settings
# ---------------------------------------------------------------------------

IR_PRODUCT = "ABI-L2-CMIPF"     # GOES full-disk Cloud & Moisture Imagery
IR_BAND = 13                     # 10.3 µm clean longwave IR window
IR_VARIABLE = "CMI"              # variable name in CMI file

IR_VMIN = 190.0                  # brightness temperature colour limits (K)
IR_VMAX = 310.0

# Reprojection pitch for the raw-Tb IR path (fetch_ir_tb_raw only). Native
# GOES/Himawari Band-13 IR is 2 km ≈ 0.018°, so the legacy 0.013° default was
# pure oversampling (SSIM=1.0 to native truth; perceptually identical at max
# zoom). 0.018° preserves 100% of native IR detail while cutting egress/storage
# ~45-48% (1538px → ~1111px for a 20° box). Applies to IR Tb ONLY — the VISIBLE
# band is 0.5 km native and is already undersampled at 0.013°, so fetch_band_raw
# keeps the finer 0.013° default and MUST NOT use this constant.
_IR_RAW_RES_DEG = 0.018  # native Band-13 2km; 0.013 was oversampling

# Multi-band support (Visible + Water Vapor)
VIS_BAND = 2                    # GOES 0.64 µm red visible
WV_BAND = 8                     # 6.2 µm upper-level water vapor
HIMAWARI_VIS_BAND = 3           # Himawari 0.64 µm equivalent
HIMAWARI_WV_BAND = 8            # Himawari 6.2 µm WV

# Per-band encoding ranges for uint8 (1-255) scaling
BAND_RANGES = {
    2:  {"vmin": 0.0,   "vmax": 1.0,   "data_type": "reflectance"},
    3:  {"vmin": 0.0,   "vmax": 1.0,   "data_type": "reflectance"},
    # Band 7 (3.9 µm shortwave IR) — nighttime "visible-like" fallback for
    # the Visible product. Narrowed to 240–320 K (was 200–330) to
    # concentrate the dynamic range on the warm cloud/surface regime,
    # ~doubling contrast for low-level clouds (stratocumulus/fog, ~280–300 K)
    # that were washed out over the old 130 K span. Cold tops (<240 K)
    # saturate bright — fine for a visible-like product (cold-top detail is
    # the IR panel's job). Rendered inverted in _render_band_jpg. Tunable.
    7:  {"vmin": 240.0, "vmax": 320.0, "data_type": "tb"},
    8:  {"vmin": 170.0, "vmax": 260.0, "data_type": "tb"},
    13: {"vmin": 160.0, "vmax": 330.0, "data_type": "tb"},
}

# Band 7 has the same band-number on Himawari (AHI Band 7, 3.9 µm SWIR)
# so no Himawari remap is needed — fetch_band_raw passes band through.
SWIR_BAND = 7

# Claude IR colormap LUT — matches the client-side Claude IR colormap.
# frac = 1 - (Tb - IR_VMIN) / (IR_VMAX - IR_VMIN), so frac 0 = warm, 1 = cold.
# Grey warm side → teal → green → gold → orange → crimson → magenta → violet → indigo.
_IR_STOPS = [
    (0.000,  12,  12,  22),   # 310K  warm surface: near-black
    (0.142,  70,  70,  82),   # 293K  dark grey-blue
    (0.225, 120, 120, 132),   # 283K  medium grey
    (0.308, 180, 180, 192),   # 273K  light grey (freezing)
    (0.392, 216, 218, 228),   # 263K  pale blue-grey
    (0.475, 140, 210, 220),   # 253K  light teal
    (0.517,  68, 180, 196),   # 248K  teal
    (0.558,  32, 148, 166),   # 243K  deep teal
    (0.600,  40, 178, 116),   # 238K  teal-green
    (0.642,  96, 208,  68),   # 233K  green
    (0.683, 192, 220,  40),   # 228K  yellow-green
    (0.725, 238, 196,  48),   # 223K  gold
    (0.767, 228, 132,  48),   # 218K  orange
    (0.808, 214,  78,  56),   # 213K  red-orange
    (0.850, 180,  36,  68),   # 208K  crimson
    (0.892, 196,  48, 156),   # 203K  magenta
    (0.933, 168,  64, 200),   # 198K  purple
    (0.975, 120,  48, 180),   # 193K  deep violet
    (1.000,  64,  24, 140),   # 183K  indigo
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
      -105° ≤ lon ≤ +10°  → GOES-East  (Atlantic)
      -175° ≤ lon < -105°  → GOES-West  (East/Central Pacific)
      Everything else       → Himawari-9 (Western Pacific, IO, SH)

    The east/west cutoff sits at -105° (not -100°) so western-Gulf /
    NE-Mexico Atlantic storms (e.g. a system near 101°W) are imaged by
    GOES-East (~26° off-nadir) rather than GOES-West (~36° off-nadir) —
    a less-oblique, crisper view. GOES-East full-disk still has ample
    coverage out to -105°.
    """
    # Normalise to -180..+180
    lon = ((longitude + 180) % 360) - 180

    if -105 <= lon <= 10:
        # Atlantic, Caribbean, Gulf of Mexico
        sat_key = "east"
        if analysis_dt.replace(tzinfo=timezone.utc) >= GOES_TRANSITION_DT:
            bucket = GOES_BUCKETS["east_19"]
        else:
            bucket = GOES_BUCKETS["east_16"]
    elif -175 <= lon < -105:
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
                   tolerance_min: int = 15, band: int = IR_BAND,
                   return_dt: bool = False):
    """
    Find the GOES ABI full-disk file closest to target_dt for a given band.
    Returns the full S3 key or None.

    If return_dt=True, returns (s3_key, matched_scan_dt) so callers can
    detect a substituted scan time (see fetch_ir_tb_raw's
    max_substitution_min). (None, None) when nothing matches.
    """
    fs = get_goes_fs()
    if fs is None:
        return (None, None) if return_dt else None

    # Scan the target hour AND the previous hour. The large 0.5 km Visible
    # (Band 2) full-disk file (~380 MB) finishes uploading well after the small
    # IR/WV ones, so at the near-real-time edge the wanted scan often still lives
    # in the PREVIOUS hour's prefix (the hour-scoped listing would otherwise miss
    # it → "no file"). The best_delta/tolerance gate below still rejects anything
    # too far, so this is safe for IR/WV too — a previous-hour file is only ever
    # selected when it's genuinely within tolerance.
    band_tag = f"C{band:02d}"
    candidates = []
    for _h in (target_dt, target_dt - timedelta(hours=1)):
        jd = _h.timetuple().tm_yday
        pfx = f"{bucket}/{IR_PRODUCT}/{_h.year}/{jd:03d}/{_h.hour:02d}/"
        try:
            candidates += [f for f in _cached_fs_ls(fs, pfx)
                           if band_tag in f.split("/")[-1]]
        except Exception:
            continue
    if not candidates:
        return (None, None) if return_dt else None

    best_file = None
    best_dt = None
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
                best_dt = file_dt
        except Exception:
            continue

    if best_delta > timedelta(minutes=tolerance_min):
        return (None, None) if return_dt else None
    return (best_file, best_dt) if return_dt else best_file


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
                     sat_key: str, box_deg: float = 8.0,
                     band: int = IR_BAND, return_extent: bool = False):
    """
    Open a GOES CMI file from S3 and return a geographically-subsetted
    2D array (y, x) IN THE GEOSTATIONARY FIXED GRID (uniform in scan angle,
    NOT lat/lon).  For IR/WV bands (7-16) returns brightness temperature
    in Kelvin; for visible bands (1-6) returns reflectance factor (0-1).

    The returned array MUST be reprojected with _reproject_geos_to_latlon
    before being displayed as an L.imageOverlay on a lat/lon box — the ABI
    fixed grid is uniform in scan angle, so off-nadir storms are displaced
    by tens-to-hundreds of km if the raw subset is stretched onto a lat/lon
    rectangle (verified 2026-06-02: ~80 km NE at 11° off-nadir, ~250 km at
    25°). Pass return_extent=True to get the geos extent the reprojection
    needs.

    return_extent=True → (data, geos_meta) where geos_meta is a dict with:
        "extent": (x_left, x_right, y_top, y_bottom) in METRES (matching geos
                  Proj() output, the convention open_himawari_subset uses),
                  measured at the subset's first/last pixel centres;
        "sat_height", "lon_0", "sweep": the file's OWN navigation, read from
                  goes_imager_projection so the reproject uses the satellite's
                  true sub-point. (The hardcoded GOES_LON_0 lags reality —
                  GOES-18 sits at -137.0, not -137.2 — so trusting the file
                  avoids a ~0.2°/~22 km residual shift, and stays correct if a
                  satellite is ever repositioned.)
    """
    import xarray as xr

    fs = get_goes_fs()
    if fs is None:
        raise RuntimeError("s3fs not available")

    half = box_deg / 2.0
    # Off-nadir, a lat/lon box maps to a SKEWED quadrilateral in the geos
    # fixed grid — its bounding scan-angle rectangle is wider than the two
    # SW/NE corners alone suggest. Sampling only the corners leaves the
    # rotated box poking past the crop, which renders as black corner
    # wedges after _reproject_geos_to_latlon resamples a region with no
    # data (e.g. GOES-18 viewing a Gulf/Mexico storm ~36° off-nadir).
    # Sample the whole perimeter densely (each edge bows outward between
    # its endpoints, the projection being nonlinear), then take min/max +
    # a small margin. This mirrors the fix open_himawari_subset carries.
    pyproj = _get_pyproj()
    if pyproj is None:
        raise RuntimeError("pyproj is required for GOES IR subsetting")
    _proj = pyproj.Proj(proj="geos", h=GOES_SAT_HEIGHT,
                        lon_0=GOES_LON_0[sat_key], sweep="x")
    lat0, lat1 = center_lat - half, center_lat + half
    lon0, lon1 = center_lon - half, center_lon + half
    N = 9
    ts = [i / (N - 1) for i in range(N)]  # 0..1 along each edge
    xs_s, ys_s = [], []
    for t in ts:
        for la, lo in (
            (lat1, lon0 + t * (lon1 - lon0)),   # north edge
            (lat0, lon0 + t * (lon1 - lon0)),   # south edge
            (lat0 + t * (lat1 - lat0), lon0),   # west edge
            (lat0 + t * (lat1 - lat0), lon1),   # east edge
        ):
            xm, ym = _proj(lo, la)
            xr_, yr_ = xm / GOES_SAT_HEIGHT, ym / GOES_SAT_HEIGHT
            if np.isfinite(xr_) and np.isfinite(yr_):
                xs_s.append(xr_)
                ys_s.append(yr_)
    if not xs_s or not ys_s:
        raise ValueError("storm window does not intersect the GOES disk")
    # ~4 px of margin (ABI 2-km IR IFOV, in scan-angle radians) so grid
    # discretization can't re-introduce a thin uncovered sliver.
    margin = 4.0 * 2000.0 / GOES_SAT_HEIGHT
    x_lo, x_hi = min(xs_s) - margin, max(xs_s) + margin
    y_lo, y_hi = min(ys_s) - margin, max(ys_s) + margin

    geos_meta = None
    fobj = fs.open(f"s3://{s3_key}", "rb")
    try:
        ds = xr.open_dataset(fobj, engine="h5netcdf")
        ds_sub = ds.sel(x=slice(x_lo, x_hi), y=slice(y_hi, y_lo))

        if IR_VARIABLE in ds_sub:
            data = ds_sub[IR_VARIABLE].values.astype(np.float32)
        else:
            alt_var = f"CMI_C{band:02d}"
            if alt_var in ds_sub:
                data = ds_sub[alt_var].values.astype(np.float32)
            else:
                raise ValueError(f"Neither {IR_VARIABLE} nor {alt_var} found in dataset")

        if return_extent:
            # ABI x/y coords are scan angles in RADIANS; geos Proj() emits
            # metres, so scale by the perspective height. Subset is sliced
            # x ascending (W->E) and y descending (N->S), so xs[0]=x_left,
            # xs[-1]=x_right, ys[0]=y_top, ys[-1]=y_bottom.
            gip = ds["goes_imager_projection"].attrs
            sat_h = float(gip.get("perspective_point_height", GOES_SAT_HEIGHT))
            lon0 = float(gip.get("longitude_of_projection_origin",
                                 GOES_LON_0[sat_key]))
            sweep = str(gip.get("sweep_angle_axis", GOES_SWEEP))
            xs = ds_sub["x"].values
            ys = ds_sub["y"].values
            geos_meta = {
                "extent": (float(xs[0]) * sat_h, float(xs[-1]) * sat_h,
                           float(ys[0]) * sat_h, float(ys[-1]) * sat_h),
                "sat_height": sat_h,
                "lon_0": lon0,
                "sweep": sweep,
            }
    finally:
        ds.close()
        fobj.close()
        gc.collect()
    return (data, geos_meta) if return_extent else data


def find_himawari_file(target_dt: _dt, tolerance_min: int = 20,
                       band: int = HIMAWARI_BAND, return_dt: bool = False):
    """
    Find the S3 prefix for a Himawari-9 AHI full-disk scan
    closest to target_dt for a given band.

    As of 2026, the noaa-himawari9 bucket uses:
        AHI-L1b-FLDK/{year}/{month:02d}/{day:02d}/{HHMM}/
            HS_H09_YYYYMMDD_HHMM_B{band}_FLDK_R20_S{seg}10.DAT.bz2

    Returns the S3 *directory prefix* (not a single file) containing the
    segment files, or None if nothing is found within tolerance.

    If return_dt=True, returns (prefix, matched_scan_dt) so callers can
    tell whether a *different* scan time was substituted for the request
    (None matches → (None, None)). The substitution window can be up to
    ±tolerance_min, which is fine for an isolated snapshot but wrong for
    an animation frame whose neighbours are exact 10-min slots — see
    fetch_ir_tb_raw's max_substitution_min.
    """
    fs = get_goes_fs()
    if fs is None:
        return (None, None) if return_dt else None

    utc_dt = target_dt.replace(tzinfo=timezone.utc) if target_dt.tzinfo is None else target_dt

    # Round to the nearest 10 minutes (Himawari scans every 10 min)
    minute = utc_dt.minute
    base_min = minute - (minute % 10)

    # Try the target time and +/- 10 min offsets
    candidates_dt = [
        utc_dt.replace(minute=base_min, second=0, microsecond=0),
    ]
    for offset in [10, -10, 20, -20]:
        candidates_dt.append(candidates_dt[0] + timedelta(minutes=offset))

    band_tag = f"B{band:02d}"

    for cdt in candidates_dt:
        hhmm = f"{cdt.hour:02d}{cdt.minute:02d}"
        prefix = (f"{HIMAWARI_BUCKET}/{HIMAWARI_L1B_PRODUCT}/"
                  f"{cdt.year}/{cdt.month:02d}/{cdt.day:02d}/{hhmm}/")

        try:
            files = _cached_fs_ls(fs, prefix)
        except Exception:
            continue

        if not files:
            continue

        band_files = [f for f in files if band_tag in f.split("/")[-1]]
        if not band_files:
            continue

        delta = abs(cdt - utc_dt)
        if delta <= timedelta(minutes=tolerance_min):
            print(f"[satellite_ir] Himawari L1b dir found: {prefix.split('/')[-2]} "
                  f"({len(band_files)} {band_tag} segments)")
            return (prefix, cdt) if return_dt else prefix

    print(f"[satellite_ir] No Himawari {band_tag} data found for {target_dt.isoformat()}")
    return (None, None) if return_dt else None


def _himawari_seg_for_lat(center_lat: float, box_deg: float,
                          band: int = HIMAWARI_BAND) -> list:
    """
    Determine which Himawari segment numbers (1-10) are needed
    to cover the latitude range [center_lat ± box_deg/2].

    Each band has a native resolution; segment dimensions scale accordingly.
    Segment 1 = top of disk (northernmost), segment 10 = bottom.
    """
    pyproj = _get_pyproj()
    if pyproj is None:
        return list(range(1, HIMAWARI_N_SEGMENTS + 1))

    proj = pyproj.Proj(
        proj="geos", h=HIMAWARI_SAT_HEIGHT,
        lon_0=HIMAWARI_LON_0, sweep=HIMAWARI_SWEEP,
    )

    res_m = HIMAWARI_BAND_RES_M.get(band, 2000)
    scale = 2000 / res_m  # e.g., 4 for 0.5km bands
    nlines_per_seg = int(HIMAWARI_NLINES_PER_SEG * scale)

    half = box_deg / 2.0
    total_lines = nlines_per_seg * HIMAWARI_N_SEGMENTS

    loff = total_lines / 2.0
    pix_per_rad = HIMAWARI_SAT_HEIGHT / float(res_m)

    segs_needed = set()
    for lat in [center_lat - half, center_lat + half, center_lat]:
        lat_c = max(-80.0, min(80.0, lat))
        try:
            _, y_m = proj(HIMAWARI_LON_0, lat_c)
            y_angle = y_m / HIMAWARI_SAT_HEIGHT
            row = loff - y_angle * pix_per_rad
            row = max(0, min(total_lines - 1, int(round(row))))
            seg = (row // nlines_per_seg) + 1
            seg = max(1, min(HIMAWARI_N_SEGMENTS, seg))
            segs_needed.add(seg)
        except Exception:
            continue

    if not segs_needed:
        # Fallback: return middle segments
        return [5, 6]

    # Expand range to include all segments between min and max
    seg_min = min(segs_needed)
    seg_max = max(segs_needed)
    return list(range(seg_min, seg_max + 1))


def _parse_hsd_header(data: bytes) -> dict:
    """
    Parse the essential header fields from a Himawari Standard Data (HSD) file.
    Reads block lengths dynamically to find correct offsets.

    HSD block layout (big-endian):
      Block 1 (Basic info):   byte 0: blk_num(1) + blk_len(2) + ...
      Block 2 (Data info):    starts at block1_len
      Block 3 (Projection):   starts at block1_len + block2_len
      Block 4 (Navigation):   starts at sum of blocks 1-3
      Block 5 (Calibration):  starts at sum of blocks 1-4

    Returns dict with n_columns, n_lines, calibration coefficients,
    and data_offset.
    """
    import struct

    header = {}

    # HSD format is LITTLE-ENDIAN (confirmed by JMA spec and satpy reader).
    # Each block starts with: block_number (uint8, 1B) + block_length (uint16, 2B)
    LE = "<"  # little-endian prefix

    def blk_len_at(offset):
        return struct.unpack_from(f"{LE}H", data, offset + 1)[0]

    try:
        blk1_len = blk_len_at(0)
        blk2_start = blk1_len
        blk2_len = blk_len_at(blk2_start)
        blk3_start = blk2_start + blk2_len
        blk3_len = blk_len_at(blk3_start)
        blk4_start = blk3_start + blk3_len
        blk4_len = blk_len_at(blk4_start)
        blk5_start = blk4_start + blk4_len
        print(f"[satellite_ir] HSD block chain: blk1={blk1_len}, blk2@{blk2_start} len={blk2_len}, "
              f"blk5@{blk5_start}")
    except Exception as e:
        print(f"[satellite_ir] HSD block chain walk failed: {e}")
        # Fallback to typical offsets for 2km FLDK data
        blk2_start = 282
        blk5_start = 598  # 282 + 50 + 127 + 139
        blk1_len = 282

    # Block 2: Data info — contains image dimensions
    # Layout: blk_num(1) + blk_len(2) + bits_per_pixel(2) +
    #         n_columns(2) + n_lines(2) + compression(1) + ...
    try:
        header["n_columns"] = struct.unpack_from(f"{LE}H", data, blk2_start + 5)[0]
        header["n_lines"] = struct.unpack_from(f"{LE}H", data, blk2_start + 7)[0]
    except Exception:
        header["n_columns"] = HIMAWARI_NCOLS   # fallback: 5500
        header["n_lines"] = HIMAWARI_NLINES_PER_SEG  # fallback: 550

    # Block 5: Calibration — IR band coefficients
    # Layout: blk_num(1) + blk_len(2) + band_num(2) + central_wl(8) +
    #         valid_bits(2) + error_count(2) + outside_count(2) +
    #         gain_count2rad(8) + const_count2rad(8) +
    #   [IR bands only, byte 35+]:
    #         c0_planck(8) + c1_planck(8) + c2_planck(8) +
    #         gain_count2tbb(8) + const_count2tbb(8)
    try:
        # count→radiance conversion (for all bands)
        header["gain"] = struct.unpack_from(f"{LE}d", data, blk5_start + 19)[0]
        header["offset"] = struct.unpack_from(f"{LE}d", data, blk5_start + 27)[0]

        # Planck coefficients (IR bands only — Band 7-16)
        header["planck_c0"] = struct.unpack_from(f"{LE}d", data, blk5_start + 35)[0]
        header["planck_c1"] = struct.unpack_from(f"{LE}d", data, blk5_start + 43)[0]
        header["planck_c2"] = struct.unpack_from(f"{LE}d", data, blk5_start + 51)[0]

        # Central wavelength (µm) — at offset 5 in block 5
        header["central_wavelength"] = struct.unpack_from(f"{LE}d", data, blk5_start + 5)[0]

        # Planck temperature correction coefficients (offsets 59-75):
        # Tbb_corrected = C0 + C1 * Te + C2 * Te^2
        header["corr_c0"] = struct.unpack_from(f"{LE}d", data, blk5_start + 59)[0]
        header["corr_c1"] = struct.unpack_from(f"{LE}d", data, blk5_start + 67)[0]
        header["corr_c2"] = struct.unpack_from(f"{LE}d", data, blk5_start + 75)[0]

        # Physical constants (offsets 83-99)
        header["speed_of_light"] = struct.unpack_from(f"{LE}d", data, blk5_start + 83)[0]
        header["planck_h"] = struct.unpack_from(f"{LE}d", data, blk5_start + 91)[0]
        header["boltzmann_k"] = struct.unpack_from(f"{LE}d", data, blk5_start + 99)[0]
    except Exception as e:
        print(f"[satellite_ir] HSD calibration parse failed: {e}")
        header.setdefault("gain", 1.0)
        header.setdefault("offset", 0.0)
        header.setdefault("planck_c0", 0.0)
        header.setdefault("planck_c1", 0.0)
        header.setdefault("planck_c2", 0.0)
        header.setdefault("central_wavelength", 10.4)
        header.setdefault("corr_c0", 0.0)
        header.setdefault("corr_c1", 1.0)
        header.setdefault("corr_c2", 0.0)
        header.setdefault("speed_of_light", 299792458.0)
        header.setdefault("planck_h", 6.62607e-34)
        header.setdefault("boltzmann_k", 1.38065e-23)

    # Total header length is stored in Block 1 at byte 70 (uint32)
    try:
        total_header_len = struct.unpack_from(f"{LE}I", data, 70)[0]
        header["data_offset"] = total_header_len
    except Exception:
        # Fallback: compute from file size minus expected data
        data_size = header["n_lines"] * header["n_columns"] * 2
        header["data_offset"] = len(data) - data_size

    print(f"[satellite_ir] HSD header: {header['n_columns']}x{header['n_lines']}, "
          f"data_offset={header['data_offset']}, "
          f"gain={header.get('gain', 'N/A'):.6g}, "
          f"corr_c0={header.get('corr_c0', 'N/A'):.6g}, "
          f"corr_c1={header.get('corr_c1', 'N/A'):.6g}")

    return header


def _hsd_counts_to_tbb(counts: np.ndarray, header: dict) -> np.ndarray:
    """Convert raw HSD uint16 counts to brightness temperature (K).

    Three-step conversion following the JMA HSD specification and satpy:
      1. Count → Radiance:  L = gain * DN + offset   [W m⁻² sr⁻¹ µm⁻¹]
      2. Planck inversion:  Te = hc / (kλ · ln(2hc²/(Lλ⁵·10⁶) + 1))
      3. Correction:        Tbb = C0 + C1·Te + C2·Te²

    The physical constants (h, c, k) and central wavelength come from
    the HSD Block 5 header.  The correction coefficients C0/C1/C2
    account for sensor spectral response.
    """
    valid = counts > 0

    # Step 1: count → spectral radiance
    rad = np.full(counts.shape, np.nan, dtype=np.float64)
    rad[valid] = header["gain"] * counts[valid].astype(np.float64) + header["offset"]

    # Step 2: Planck inversion using physical constants
    lam = header.get("central_wavelength", 10.4) * 1e-6  # µm → m
    h = header.get("planck_h", 6.62607e-34)
    c = header.get("speed_of_light", 2.99792e8)
    k = header.get("boltzmann_k", 1.38065e-23)

    with np.errstate(divide="ignore", invalid="ignore"):
        # Radiance in HSD is in [W m⁻² sr⁻¹ µm⁻¹], convert to [W m⁻² sr⁻¹ m⁻¹]
        rad_si = rad * 1e6
        arg = 2.0 * h * c * c / (rad_si * lam**5) + 1.0
        tbb = h * c / (k * lam * np.log(arg))

    # Step 3: apply correction coefficients
    corr_c0 = header.get("corr_c0", 0.0)
    corr_c1 = header.get("corr_c1", 1.0)
    corr_c2 = header.get("corr_c2", 0.0)
    tbb = corr_c0 + corr_c1 * tbb + corr_c2 * tbb * tbb

    tbb[~valid] = np.nan
    return tbb.astype(np.float32)


def _hsd_counts_to_reflectance(counts: np.ndarray, header: dict,
                                center_lat: float = 0.0) -> np.ndarray:
    """Convert raw HSD uint16 counts to reflectance factor (0-1) for visible bands.

    Two-step conversion:
      1. Count → Radiance:  L = gain * DN + offset   [W m⁻² sr⁻¹ µm⁻¹]
      2. Radiance → Reflectance:  refl = π * L / F₀

    F₀ (solar irradiance at band wavelength) is approximated from the
    central wavelength.  Earth-sun distance correction (~±3.4%) is applied.
    Solar zenith angle correction is approximated using storm center latitude.
    """
    import math as _math

    valid = counts > 0
    rad = np.full(counts.shape, np.nan, dtype=np.float64)
    rad[valid] = header["gain"] * counts[valid].astype(np.float64) + header["offset"]

    # Solar irradiance approximation for Band 3 (0.64 µm): ~1631 W m⁻² µm⁻¹
    lam_um = header.get("central_wavelength", 0.64)
    # Approximate solar spectral irradiance (W m⁻² µm⁻¹) at common visible wavelengths
    _SOLAR_IRRADIANCE = {0.47: 2006, 0.51: 1942, 0.64: 1631, 0.86: 1041}
    f0 = min(_SOLAR_IRRADIANCE.items(), key=lambda kv: abs(kv[0] - lam_um))[1]

    # Earth-sun distance factor (approximate, varies ±3.4% over the year)
    # d_sun ≈ 1.0 for simplicity; refinement possible with day-of-year
    d_sun = 1.0

    # Convert: refl = π * L * d² / F₀  (Lambertian reflectance factor)
    with np.errstate(divide="ignore", invalid="ignore"):
        refl = _math.pi * rad * d_sun * d_sun / f0

    # Clamp to [0, 1] — values > 1 can occur at glint or bright surfaces
    refl = np.clip(refl, 0.0, 1.5)
    refl[~valid] = np.nan
    return refl.astype(np.float32)


def open_himawari_subset(s3_prefix: str, center_lat: float, center_lon: float,
                         box_deg: float = 8.0,
                         band: int = HIMAWARI_BAND,
                         return_extent: bool = False):
    """
    Open Himawari HSD segment files from S3 and return a geographically-subsetted
    2D array (y, x).  For IR/WV bands (7-16) returns brightness temperature
    in Kelvin; for visible bands (1-6) returns reflectance factor (0-1).

    s3_prefix is the directory containing the segment .DAT.bz2 files.
    Only downloads the segment(s) needed for the latitude range.

    return_extent: when True, returns (subset, geos_extent) where geos_extent
    is (x_left, x_right, y_top, y_bottom) in geostationary metres for the
    subset's first/last pixel centres — feed it straight to
    _reproject_geos_to_latlon(geos_extent=...). In this mode the pixel window
    is sized to bound the ENTIRE lat/lon box (perimeter-sampled + margin), not
    just its NW/SE corners, so off-nadir storms don't get rotated black corner
    wedges after reprojection. geos_extent is None if subsetting was skipped.
    The default (return_extent=False) preserves the legacy 2-corner window and
    a bare-array return for callers that render the geos grid directly.
    """
    import bz2

    fs = get_goes_fs()
    if fs is None:
        raise RuntimeError("s3fs not available")

    is_visible = band <= 6
    res_m = HIMAWARI_BAND_RES_M.get(band, 2000)
    scale_factor = int(2000 / res_m)  # subsample factor to get to 2km (e.g., 4 for 0.5km)

    # Determine which segments we need
    needed_segs = _himawari_seg_for_lat(center_lat, box_deg, band=band)
    print(f"[satellite_ir] Himawari B{band:02d} (R{res_m//100:02d}): need segments {needed_segs} for "
          f"lat={center_lat:.1f}±{box_deg/2:.0f}°"
          f"{' (will subsample ' + str(scale_factor) + 'x to 2km)' if scale_factor > 1 else ''}")

    # List files in the prefix directory
    try:
        all_files = _cached_fs_ls(fs, s3_prefix)
    except Exception as e:
        raise RuntimeError(f"Cannot list {s3_prefix}: {e}")

    band_tag = f"B{band:02d}"
    seg_files = {}
    for fpath in all_files:
        fname = fpath.split("/")[-1]
        if band_tag not in fname:
            continue
        # Extract segment number from filename: ..._S0110.DAT.bz2 → seg 1
        m = re.search(r"_S(\d{2})10\.DAT", fname)
        if m:
            seg_num = int(m.group(1))
            if seg_num in needed_segs:
                seg_files[seg_num] = fpath

    if not seg_files:
        raise RuntimeError(f"No Band {band} segment files found in {s3_prefix}")

    # Download, decompress, and parse each segment
    seg_arrays = {}
    header = None
    for seg_num in sorted(seg_files.keys()):
        fpath = seg_files[seg_num]
        try:
            print(f"[satellite_ir] Downloading segment {seg_num}: {fpath.split('/')[-1]}")
            compressed = fs.cat_file(fpath)
            print(f"[satellite_ir]   compressed size: {len(compressed)} bytes, decompressing...")
            raw_data = bz2.decompress(compressed)
            print(f"[satellite_ir]   decompressed size: {len(raw_data)} bytes")
            del compressed

            hdr = _parse_hsd_header(raw_data)
            if header is None:
                header = hdr

            nlines = hdr["n_lines"]
            ncols = hdr["n_columns"]
            data_offset = hdr["data_offset"]

            # Extract raw counts (uint16 little-endian per HSD spec)
            counts = np.frombuffer(raw_data[data_offset:data_offset + nlines * ncols * 2],
                                   dtype="<u2").reshape(nlines, ncols)
            del raw_data

            # Subsample high-res bands to 2km immediately to save memory
            if scale_factor > 1:
                counts = counts[::scale_factor, ::scale_factor]

            # Convert counts to physical values
            if is_visible:
                vals = _hsd_counts_to_reflectance(counts, hdr, center_lat)
            else:
                vals = _hsd_counts_to_tbb(counts, hdr)
            del counts
            seg_arrays[seg_num] = vals
            gc.collect()
        except Exception as e:
            print(f"[satellite_ir] Himawari segment {seg_num} failed: {e}")
            continue

    if not seg_arrays:
        raise RuntimeError("All Himawari segment reads failed")

    # Stack segments vertically (segment 1 = top/north, 10 = bottom/south)
    ordered = [seg_arrays[s] for s in sorted(seg_arrays.keys())]
    full_tb = np.vstack(ordered)
    del seg_arrays, ordered
    gc.collect()

    # Now subset to the geographic bounding box
    pyproj = _get_pyproj()
    if pyproj is None:
        # return full segment data if can't subset
        return (full_tb, None) if return_extent else full_tb

    proj = pyproj.Proj(
        proj="geos", h=HIMAWARI_SAT_HEIGHT,
        lon_0=HIMAWARI_LON_0, sweep=HIMAWARI_SWEEP,
    )

    # Compute pixel coordinates for the bounding box corners
    half = box_deg / 2.0
    total_nlines = HIMAWARI_NLINES_PER_SEG * HIMAWARI_N_SEGMENTS  # 5500
    total_ncols = HIMAWARI_NCOLS  # 5500

    # Pixel scale: at nadir, 1 pixel = 2 km = 2000 m
    # IFOV = 2000 / sat_height = 5.589e-5 rad
    # pixels_per_rad = 1 / IFOV = 17893
    coff = total_ncols / 2.0   # 2750
    loff = total_nlines / 2.0  # 2750
    pix_per_rad = HIMAWARI_SAT_HEIGHT / 2000.0  # 17893.01

    def latlon_to_pixel(lat, lon):
        """Convert lat/lon to pixel row/col in full-disk image."""
        try:
            x_m, y_m = proj(lon, lat)
            x_rad = x_m / HIMAWARI_SAT_HEIGHT
            y_rad = y_m / HIMAWARI_SAT_HEIGHT
            col = coff + x_rad * pix_per_rad
            row = loff - y_rad * pix_per_rad
            return int(round(row)), int(round(col))
        except Exception:
            return None, None

    # Adjust row indices relative to the stacked array
    # (which starts from the first needed segment, not segment 1)
    min_seg = min(seg_files.keys())
    row_offset = (min_seg - 1) * HIMAWARI_NLINES_PER_SEG

    if return_extent:
        # Off-nadir, a lat/lon box maps to a SKEWED quadrilateral in the
        # geos fixed grid — its bounding pixel rectangle is wider than the
        # NW/SE corners alone suggest.  Sampling only two corners leaves the
        # rotated box poking outside the cropped window, which shows up as
        # black corner wedges after _reproject_geos_to_latlon resamples a
        # region with no data.  Sample the whole PERIMETER densely (the geos
        # projection is nonlinear, so each box edge bows outward between its
        # endpoints — its extreme row/col sits past the corners/midpoint).
        # 9 points per edge captures that curvature; take min/max + a margin.
        MARGIN = 4
        N = 9
        ts = [i / (N - 1) for i in range(N)]  # 0..1 along each edge
        lat0, lat1 = center_lat - half, center_lat + half
        lon0, lon1 = center_lon - half, center_lon + half
        perimeter = []
        for t in ts:
            perimeter.append((lat1, lon0 + t * (lon1 - lon0)))  # north edge
            perimeter.append((lat0, lon0 + t * (lon1 - lon0)))  # south edge
            perimeter.append((lat0 + t * (lat1 - lat0), lon0))  # west edge
            perimeter.append((lat0 + t * (lat1 - lat0), lon1))  # east edge
        rows_s, cols_s = [], []
        for la, lo in perimeter:
            rr, cc = latlon_to_pixel(la, lo)
            if rr is not None and cc is not None:
                rows_s.append(rr)
                cols_s.append(cc)
        if not rows_s or not cols_s:
            return (full_tb, None)
        r_top = min(rows_s) - MARGIN
        r_bot = max(rows_s) + MARGIN
        c_lft = min(cols_s) - MARGIN
        c_rgt = max(cols_s) + MARGIN
    else:
        r1, c1 = latlon_to_pixel(center_lat + half, center_lon - half)  # NW corner
        r2, c2 = latlon_to_pixel(center_lat - half, center_lon + half)  # SE corner
        if r1 is None or r2 is None:
            return full_tb
        r_top, r_bot = r1, r2
        c_lft, c_rgt = min(c1, c2), max(c1, c2)

    r1_local = max(0, r_top - row_offset)
    r2_local = min(full_tb.shape[0], r_bot - row_offset)
    c1_local = max(0, c_lft)
    c2_local = min(full_tb.shape[1], c_rgt)

    if r2_local <= r1_local or c2_local <= c1_local:
        print(f"[satellite_ir] Himawari subset empty: rows {r1_local}-{r2_local}, "
              f"cols {c1_local}-{c2_local}")
        return (full_tb, None) if return_extent else full_tb

    subset = full_tb[r1_local:r2_local, c1_local:c2_local].copy()
    del full_tb
    gc.collect()

    print(f"[satellite_ir] Himawari subset: {subset.shape} from segments {list(seg_files.keys())}")

    if return_extent:
        # geos extent at the centres of the subset's first/last pixels, in
        # the same metres the geos Proj() emits (x_m = (col-coff)*2000, etc).
        # Absolute full-disk rows: r1_local maps back via +row_offset.
        x_left   = (c1_local - coff) * 2000.0
        x_right  = (c2_local - 1 - coff) * 2000.0
        y_top    = (loff - (r1_local + row_offset)) * 2000.0
        y_bottom = (loff - (r2_local - 1 + row_offset)) * 2000.0
        return subset, (x_left, x_right, y_top, y_bottom)

    return subset


# ---------------------------------------------------------------------------
# Raw Tb Fetcher
# ---------------------------------------------------------------------------

def _reproject_geos_to_latlon(
    tb_geo: np.ndarray, center_lat: float, center_lon: float,
    box_deg: float, sat_height: float, lon_0: float, sweep: str,
    res_deg: float = 0.013,
    geos_extent: Optional[Tuple[float, float, float, float]] = None,
) -> np.ndarray:
    """
    Reproject a geostationary fixed-grid Tb array to a regular lat/lon grid.

    The input tb_geo is in geostationary pixel coordinates (rows/cols map to
    scan angles). The output is a regular lat/lon array that can be correctly
    displayed as an L.imageOverlay on a Mercator/equirectangular map.

    Default `res_deg=0.013` → 1500×1500 for a 20° storm cutout. Chosen to
    1.35× oversample the native GOES/Himawari ~2 km nadir resolution while
    keeping per-frame WebP ~150 KB and decoded mobile memory tractable
    (9 frames × 9 MB decoded = 81 MB, well inside iOS Safari's per-tab
    budget). At 2° zoom the panel-px-to-source-px ratio drops from the
    previous ~3× upscale (with 0.02° = 1000×1000) to ~2× — visibly sharper.

    Going beyond 0.013° (e.g. 0.01° = 2000×2000) is diminishing-returns
    territory: that's 1.8× oversampling past native, mostly synthesizing
    interpolation noise. Bandwidth + decoded RAM grow ~2.25× for marginal
    additional perceived sharpness.

    Uses scipy.ndimage.map_coordinates for bilinear interpolation.
    """
    from scipy.ndimage import map_coordinates

    pyproj = _get_pyproj()
    if pyproj is None:
        return tb_geo  # no reprojection possible

    half = box_deg / 2.0
    lat_min = center_lat - half
    lat_max = center_lat + half
    lon_min = center_lon - half
    lon_max = center_lon + half

    # Output grid: pitch controlled by `res_deg`. Defaults to ~2 km per
    # pixel — slightly coarser than the native GOES/Himawari nadir
    # resolution (~2 km at the equator, ~3 km at off-nadir extremes).
    n_lat = int(box_deg / res_deg)
    n_lon = int(box_deg / res_deg)

    # Create the geostationary projection
    proj = pyproj.Proj(proj="geos", h=sat_height, lon_0=lon_0, sweep=sweep)

    # Build the output lat/lon grid
    lats = np.linspace(lat_max, lat_min, n_lat)  # north to south
    lons = np.linspace(lon_min, lon_max, n_lon)
    lon_grid, lat_grid = np.meshgrid(lons, lats)

    # Project lat/lon grid to geostationary x/y (meters)
    x_m, y_m = proj(lon_grid.ravel(), lat_grid.ravel())
    x_m = np.array(x_m).reshape(n_lat, n_lon)
    y_m = np.array(y_m).reshape(n_lat, n_lon)

    # Convert to pixel coordinates in the input tb_geo array
    # The input array covers the same bounding box in geostationary space
    # We need to know the geostationary pixel coords of the input array corners
    nrows, ncols = tb_geo.shape

    # Geostationary coords of the input array's first/last pixel centres.
    # When the subset was sized by open_himawari_subset's perimeter window,
    # the true geos extent is wider than the lat/lon box's NW/SE corners
    # (the box is skewed off-nadir) — using those corners here would stretch
    # the source grid and leave rotated black wedges. Prefer the exact extent.
    if geos_extent is not None:
        x_nw, x_se, y_nw, y_se = geos_extent  # (x_left, x_right, y_top, y_bottom)
    else:
        x_nw, y_nw = proj(lon_min, lat_max)  # top-left
        x_se, y_se = proj(lon_max, lat_min)  # bottom-right

    # Map geostationary x/y to fractional pixel indices in tb_geo
    # x increases left-to-right (west to east), y increases bottom-to-top
    col_frac = (x_m - x_nw) / (x_se - x_nw) * (ncols - 1)
    row_frac = (y_nw - y_m) / (y_nw - y_se) * (nrows - 1)

    # Replace NaN/inf (off-disk points) with -1
    invalid = ~np.isfinite(x_m) | ~np.isfinite(y_m)
    col_frac[invalid] = -1
    row_frac[invalid] = -1

    # Replace NaN in tb_geo with a sentinel for interpolation
    tb_filled = np.where(np.isfinite(tb_geo), tb_geo, 0)

    # Bilinear interpolation
    coords = np.array([row_frac.ravel(), col_frac.ravel()])
    tb_out = map_coordinates(tb_filled, coords, order=1, mode='constant', cval=np.nan)
    tb_out = tb_out.reshape(n_lat, n_lon)

    # Mask invalid pixels
    tb_out[invalid] = np.nan

    # Also mask where row/col indices are out of bounds
    oob = (row_frac < 0) | (row_frac >= nrows) | (col_frac < 0) | (col_frac >= ncols)
    tb_out[oob] = np.nan

    print(f"[satellite_ir] Reprojected {nrows}x{ncols} geos → {n_lat}x{n_lon} latlon")
    del tb_filled, x_m, y_m, col_frac, row_frac
    gc.collect()

    return tb_out


def _scan_substitution_too_stale(scan_dt, target_dt: _dt,
                                 max_substitution_min: Optional[float]) -> bool:
    """True when the matched scan is further from the requested slot than
    the caller tolerates. The scan finders accept a scan up to ±tolerance
    (20 min Himawari / 15 min GOES) and silently relabel it as the request.
    That is fine for an isolated snapshot but wrong for an animation frame:
    at the leading edge the requested scan hasn't disseminated to S3 yet, so
    an *older* scan gets substituted, frozen into the per-frame cache, and
    rendered at the frame's (newer, motion-advanced) center — the storm then
    appears to jump. Animation callers pass a tight window so a not-yet-
    available frame is skipped (and refilled next cycle once it lands) rather
    than poisoned with a stale neighbour."""
    if max_substitution_min is None or scan_dt is None:
        return False
    tgt = target_dt.replace(tzinfo=timezone.utc) if target_dt.tzinfo is None else target_dt
    sdt = scan_dt.replace(tzinfo=timezone.utc) if scan_dt.tzinfo is None else scan_dt
    return abs((sdt - tgt).total_seconds()) > max_substitution_min * 60.0


def fetch_ir_tb_raw(center_lat: float, center_lon: float,
                    target_dt: _dt, box_deg: float = 8.0,
                    max_substitution_min: Optional[float] = None) -> Optional[dict]:
    """
    Fetch a single IR frame and return the RAW brightness temperature array.
    Same routing as fetch_ir_frame but returns numpy Tb instead of rendered PNG.

    Output grid pitch is _IR_RAW_RES_DEG (0.018° → ~1111×1111 for a 20° box),
    passed explicitly to _reproject_geos_to_latlon below. 0.018° matches the
    native Band-13 2km IR resolution; the earlier 0.013° was oversampling
    (SSIM=1.0 to native, no visible detail lost). NOTE: this is intentionally
    distinct from fetch_band_raw, which keeps the finer 0.013° default for the
    0.5km-native visible band. See _IR_RAW_RES_DEG.

    max_substitution_min: if set, return None when the nearest available scan
    is further than this many minutes from target_dt (see
    _scan_substitution_too_stale). Leave None for snapshot callers that want
    the nearest scan regardless of age.

    Returns dict with 'tb' (np.ndarray), 'datetime_utc', 'scan_dt',
    'satellite', 'bounds' or None on failure.
    """
    bucket, sat_key = select_goes_sat(center_lon, target_dt)

    try:
        if sat_key == "himawari":
            s3_key, scan_dt = find_himawari_file(target_dt, return_dt=True)
            if not s3_key:
                return None
            if _scan_substitution_too_stale(scan_dt, target_dt, max_substitution_min):
                return None
            tb_geo, geos_extent = open_himawari_subset(
                s3_key, center_lat, center_lon, box_deg, return_extent=True
            )
            # Reproject from geostationary fixed-grid to regular lat/lon grid
            # at _IR_RAW_RES_DEG (0.018° = native Band-13 2km; ~1111×1111 for a
            # 20° box). See _IR_RAW_RES_DEG for why this is lossless vs 0.013°.
            tb = _reproject_geos_to_latlon(
                tb_geo, center_lat, center_lon, box_deg,
                HIMAWARI_SAT_HEIGHT, HIMAWARI_LON_0, HIMAWARI_SWEEP,
                res_deg=_IR_RAW_RES_DEG,
                geos_extent=geos_extent,
            )
            del tb_geo
        else:
            s3_key, scan_dt = find_goes_file(bucket, target_dt, return_dt=True)
            if not s3_key:
                return None
            if _scan_substitution_too_stale(scan_dt, target_dt, max_substitution_min):
                return None
            # GOES ABI is on the geostationary fixed grid (uniform in scan
            # angle, NOT lat/lon), so it MUST be reprojected before being
            # placed on a lat/lon imageOverlay — otherwise off-nadir storms
            # are displaced by tens-to-hundreds of km (verified 2026-06-02).
            # Same geos→latlon path Himawari uses, with GOES sat geometry.
            tb_geo, gm = open_goes_subset(
                s3_key, center_lat, center_lon, sat_key, box_deg,
                return_extent=True)
            tb = _reproject_geos_to_latlon(
                tb_geo, center_lat, center_lon, box_deg,
                gm["sat_height"], gm["lon_0"], gm["sweep"],
                res_deg=_IR_RAW_RES_DEG,
                geos_extent=gm["extent"])
            del tb_geo

        if not np.any(np.isfinite(tb)):
            return None

        half = box_deg / 2.0
        # CACHE NOTE: raw-Tb frames are cached in GCS keyed by atcf/pos/dt
        # (NOT resolution), so legacy 0.013° frames (1538px) and new 0.018°
        # frames (~1111px) coexist. Each frame self-describes its grid via
        # tb_rows/tb_cols below, so mixed-resolution bundles render correctly.
        # We deliberately do NOT bump the global GCS cache version — that would
        # force a full re-render (the opposite of the cost saving). Natural 24h
        # cache rollover replaces legacy frames with the coarser pitch.
        return {
            "tb": tb,
            "datetime_utc": target_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "scan_dt": scan_dt.strftime("%Y-%m-%dT%H:%M:%SZ") if scan_dt else None,
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


def fetch_band_raw(center_lat: float, center_lon: float,
                   target_dt: _dt, box_deg: float = 8.0,
                   band: int = 13,
                   max_substitution_min: Optional[float] = None) -> Optional[dict]:
    """
    Fetch any satellite band and return the raw 2D data array.
    For IR/WV bands (7-16): returns brightness temperature (K).
    For visible bands (1-6): returns reflectance factor (0-1).

    max_substitution_min: see fetch_ir_tb_raw — reject (return None) when the
    nearest available scan is further than this from target_dt, so animation
    frames are never poisoned with a stale neighbouring scan.

    Returns dict with 'data', 'data_type', 'datetime_utc', 'scan_dt',
    'satellite', 'bounds' or None on failure.
    """
    bucket, sat_key = select_goes_sat(center_lon, target_dt)

    # Map GOES band to Himawari equivalent
    him_band = band
    if sat_key == "himawari":
        if band == VIS_BAND:
            him_band = HIMAWARI_VIS_BAND
        elif band == WV_BAND:
            him_band = HIMAWARI_WV_BAND

    band_info = BAND_RANGES.get(band, BAND_RANGES[13])
    data_type = band_info["data_type"]

    try:
        if sat_key == "himawari":
            s3_key, scan_dt = find_himawari_file(target_dt, band=him_band, return_dt=True)
            if not s3_key:
                return None
            if _scan_substitution_too_stale(scan_dt, target_dt, max_substitution_min):
                return None
            data_geo, geos_extent = open_himawari_subset(
                s3_key, center_lat, center_lon, box_deg, band=him_band,
                return_extent=True
            )
            data = _reproject_geos_to_latlon(
                data_geo, center_lat, center_lon, box_deg,
                HIMAWARI_SAT_HEIGHT, HIMAWARI_LON_0, HIMAWARI_SWEEP,
                geos_extent=geos_extent,
            )
            del data_geo
        else:
            s3_key, scan_dt = find_goes_file(bucket, target_dt, band=band, return_dt=True)
            if not s3_key:
                return None
            if _scan_substitution_too_stale(scan_dt, target_dt, max_substitution_min):
                return None
            data_geo, gm = open_goes_subset(
                s3_key, center_lat, center_lon, sat_key, box_deg, band=band,
                return_extent=True
            )
            # Reproject the fixed-grid subset to lat/lon (see open_goes_subset).
            data = _reproject_geos_to_latlon(
                data_geo, center_lat, center_lon, box_deg,
                gm["sat_height"], gm["lon_0"], gm["sweep"],
                geos_extent=gm["extent"])
            del data_geo

        if not np.any(np.isfinite(data)):
            return None

        half = box_deg / 2.0
        return {
            "data": data,
            "data_type": data_type,
            "band": band,
            "datetime_utc": target_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "scan_dt": scan_dt.strftime("%Y-%m-%dT%H:%M:%SZ") if scan_dt else None,
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
    Base time is rounded DOWN to the nearest interval_min so that
    cache keys are stable across requests made at different seconds.
    """
    base = center_dt.replace(tzinfo=timezone.utc) if center_dt.tzinfo is None else center_dt
    # Round down to nearest interval_min boundary for stable cache keys
    base = base.replace(second=0, microsecond=0)
    base = base.replace(minute=(base.minute // interval_min) * interval_min)
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
            # Reproject ABI fixed grid → lat/lon (see open_goes_subset); the
            # raw subset is uniform in scan angle, not lat/lon.
            tb_geo, gm = open_goes_subset(
                s3_key, center_lat, center_lon, sat_key, box_deg,
                return_extent=True)
            tb = _reproject_geos_to_latlon(
                tb_geo, center_lat, center_lon, box_deg,
                gm["sat_height"], gm["lon_0"], gm["sweep"],
                geos_extent=gm["extent"])
            del tb_geo

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
