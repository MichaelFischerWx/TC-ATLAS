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
# As of 2026, L1b data uses HSD format (.DAT.bz2) with month/day/HHMM paths:
#   AHI-L1b-FLDK/{year}/{month:02d}/{day:02d}/{HHMM}/HS_H09_..._B13_FLDK_R20_S{seg}.DAT.bz2
# Band 13 (10.4 µm) at 2km resolution (R20), 10 segments per scan
HIMAWARI_L1B_PRODUCT = "AHI-L1b-FLDK"
HIMAWARI_BAND = 13
HIMAWARI_N_SEGMENTS = 10   # full disk is split into 10 latitude segments
HIMAWARI_NLINES_PER_SEG = 550  # lines per segment at 2km resolution
HIMAWARI_NCOLS = 5500      # columns at 2km resolution (full disk)

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
    Find the S3 prefix for a Himawari-9 AHI Band 13 full-disk scan
    closest to target_dt.

    As of 2026, the noaa-himawari9 bucket uses:
        AHI-L1b-FLDK/{year}/{month:02d}/{day:02d}/{HHMM}/
            HS_H09_YYYYMMDD_HHMM_B13_FLDK_R20_S{seg}10.DAT.bz2

    Returns the S3 *directory prefix* (not a single file) containing the
    segment files, or None if nothing is found within tolerance.
    """
    fs = get_goes_fs()
    if fs is None:
        return None

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

    for cdt in candidates_dt:
        hhmm = f"{cdt.hour:02d}{cdt.minute:02d}"
        prefix = (f"{HIMAWARI_BUCKET}/{HIMAWARI_L1B_PRODUCT}/"
                  f"{cdt.year}/{cdt.month:02d}/{cdt.day:02d}/{hhmm}/")

        try:
            files = fs.ls(prefix, detail=False)
        except Exception:
            continue

        if not files:
            continue

        # Check that Band 13 segment files exist
        band_tag = f"B{HIMAWARI_BAND:02d}"
        b13_files = [f for f in files if band_tag in f.split("/")[-1]]
        if not b13_files:
            continue

        delta = abs(cdt - utc_dt)
        if delta <= timedelta(minutes=tolerance_min):
            print(f"[satellite_ir] Himawari L1b dir found: {prefix.split('/')[-2]} "
                  f"({len(b13_files)} B13 segments)")
            return prefix  # return the directory prefix

    print(f"[satellite_ir] No Himawari L1b data found for {target_dt.isoformat()}")
    return None


def _himawari_seg_for_lat(center_lat: float, box_deg: float) -> list:
    """
    Determine which Himawari segment numbers (1-10) are needed
    to cover the latitude range [center_lat ± box_deg/2].

    Himawari full-disk at 2km resolution: 5500 lines, 10 segments of 550 lines.
    Segment 1 = top of disk (northernmost), segment 10 = bottom.
    The full disk spans approx ±80° latitude from the sub-satellite point.
    """
    pyproj = _get_pyproj()
    if pyproj is None:
        # Fallback: return all segments
        return list(range(1, HIMAWARI_N_SEGMENTS + 1))

    proj = pyproj.Proj(
        proj="geos", h=HIMAWARI_SAT_HEIGHT,
        lon_0=HIMAWARI_LON_0, sweep=HIMAWARI_SWEEP,
    )

    half = box_deg / 2.0
    total_lines = HIMAWARI_NLINES_PER_SEG * HIMAWARI_N_SEGMENTS  # 5500

    # Use the same pixel coordinate formula as latlon_to_pixel()
    # in open_himawari_subset: row = loff - (y_m / sat_height) * pix_per_rad
    loff = total_lines / 2.0        # 2750
    pix_per_rad = HIMAWARI_SAT_HEIGHT / 2000.0  # 17893.01

    segs_needed = set()
    for lat in [center_lat - half, center_lat + half, center_lat]:
        lat_c = max(-80.0, min(80.0, lat))
        try:
            _, y_m = proj(HIMAWARI_LON_0, lat_c)
            y_angle = y_m / HIMAWARI_SAT_HEIGHT
            row = loff - y_angle * pix_per_rad
            row = max(0, min(total_lines - 1, int(round(row))))
            seg = (row // HIMAWARI_NLINES_PER_SEG) + 1
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

        # Direct count→Tbb speed-up coefficients (avoids radiance step)
        header["tbb_gain"] = struct.unpack_from(f"{LE}d", data, blk5_start + 59)[0]
        header["tbb_offset"] = struct.unpack_from(f"{LE}d", data, blk5_start + 67)[0]
    except Exception as e:
        print(f"[satellite_ir] HSD calibration parse failed: {e}")
        header.setdefault("gain", 1.0)
        header.setdefault("offset", 0.0)
        header.setdefault("planck_c0", 0.0)
        header.setdefault("planck_c1", 0.0)
        header.setdefault("planck_c2", 0.0)
        header.setdefault("tbb_gain", 0.0)
        header.setdefault("tbb_offset", 0.0)

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
          f"tbb_gain={header.get('tbb_gain', 'N/A'):.6g}")

    return header


def _hsd_counts_to_tbb(counts: np.ndarray, header: dict) -> np.ndarray:
    """Convert raw HSD uint16 counts to brightness temperature (K).

    Uses the direct count→Tbb speed-up coefficients if available (most
    efficient).  Falls back to the two-step count→radiance→Tbb path
    using Planck inversion otherwise.
    """
    valid = counts > 0

    # Fast path: use direct count→Tbb linear coefficients
    tbb_gain = header.get("tbb_gain", 0.0)
    tbb_offset = header.get("tbb_offset", 0.0)
    if tbb_gain != 0.0:
        tbb = np.full(counts.shape, np.nan, dtype=np.float32)
        tbb[valid] = tbb_gain * counts[valid].astype(np.float32) + tbb_offset
        return tbb

    # Slow path: count → radiance → Tbb
    rad = np.full(counts.shape, np.nan, dtype=np.float32)
    rad[valid] = header["gain"] * counts[valid].astype(np.float32) + header["offset"]

    c0 = header.get("planck_c0", 0.0)
    c1 = header.get("planck_c1", 0.0)
    c2 = header.get("planck_c2", 0.0)

    if c1 > 0 and c2 > 0:
        with np.errstate(divide="ignore", invalid="ignore"):
            tbb = c2 / np.log(1.0 + c1 / rad) + c0
    else:
        tbb = rad

    tbb[~valid] = np.nan
    return tbb


def open_himawari_subset(s3_prefix: str, center_lat: float, center_lon: float,
                         box_deg: float = 8.0) -> np.ndarray:
    """
    Open Himawari HSD segment files from S3 and return a geographically-subsetted
    2D brightness-temperature array (y, x) in Kelvin.

    s3_prefix is the directory containing the segment .DAT.bz2 files.
    Only downloads the segment(s) needed for the latitude range.
    """
    import bz2

    fs = get_goes_fs()
    if fs is None:
        raise RuntimeError("s3fs not available")

    # Determine which segments we need
    needed_segs = _himawari_seg_for_lat(center_lat, box_deg)
    print(f"[satellite_ir] Himawari: need segments {needed_segs} for "
          f"lat={center_lat:.1f}±{box_deg/2:.0f}°")

    # List files in the prefix directory
    try:
        all_files = fs.ls(s3_prefix, detail=False)
    except Exception as e:
        raise RuntimeError(f"Cannot list {s3_prefix}: {e}")

    band_tag = f"B{HIMAWARI_BAND:02d}"
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
        raise RuntimeError(f"No Band {HIMAWARI_BAND} segment files found in {s3_prefix}")

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

            # Convert to brightness temperature
            tbb = _hsd_counts_to_tbb(counts, hdr)
            del counts
            seg_arrays[seg_num] = tbb
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
        return full_tb  # return full segment data if can't subset

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

    r1, c1 = latlon_to_pixel(center_lat + half, center_lon - half)  # NW corner
    r2, c2 = latlon_to_pixel(center_lat - half, center_lon + half)  # SE corner

    if r1 is None or r2 is None:
        return full_tb

    # Adjust row indices relative to the stacked array
    # (which starts from the first needed segment, not segment 1)
    min_seg = min(seg_files.keys())
    row_offset = (min_seg - 1) * HIMAWARI_NLINES_PER_SEG

    r1_local = max(0, r1 - row_offset)
    r2_local = min(full_tb.shape[0], r2 - row_offset)
    c1_local = max(0, min(c1, c2))
    c2_local = min(full_tb.shape[1], max(c1, c2))

    if r2_local <= r1_local or c2_local <= c1_local:
        print(f"[satellite_ir] Himawari subset empty: rows {r1_local}-{r2_local}, "
              f"cols {c1_local}-{c2_local}")
        return full_tb

    subset = full_tb[r1_local:r2_local, c1_local:c2_local].copy()
    del full_tb
    gc.collect()

    print(f"[satellite_ir] Himawari subset: {subset.shape} from segments {list(seg_files.keys())}")
    return subset


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

def _reproject_geos_to_latlon(
    tb_geo: np.ndarray, center_lat: float, center_lon: float,
    box_deg: float, sat_height: float, lon_0: float, sweep: str
) -> np.ndarray:
    """
    Reproject a geostationary fixed-grid Tb array to a regular lat/lon grid.

    The input tb_geo is in geostationary pixel coordinates (rows/cols map to
    scan angles). The output is a regular lat/lon array that can be correctly
    displayed as an L.imageOverlay on a Mercator/equirectangular map.

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

    # Output grid: ~2km spacing in lat/lon (roughly matching input resolution)
    # 1 degree ≈ 111 km, so 2km ≈ 0.018 degrees
    res_deg = 0.02  # slightly coarser than native 2km for speed
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

    # Corners of the input array in geostationary coordinates
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
            tb_geo = open_himawari_subset(s3_key, center_lat, center_lon, box_deg)
            # Reproject from geostationary fixed-grid to regular lat/lon grid
            tb = _reproject_geos_to_latlon(
                tb_geo, center_lat, center_lon, box_deg,
                HIMAWARI_SAT_HEIGHT, HIMAWARI_LON_0, HIMAWARI_SWEEP
            )
            del tb_geo
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


def _min_filter_2d_pure_numpy(arr: np.ndarray, size: int) -> np.ndarray:
    """
    2D minimum filter using separable 1D passes (pure numpy, no scipy).
    Equivalent to scipy.ndimage.minimum_filter(arr, size=size) for square kernels.

    Uses numpy.lib.stride_tricks.sliding_window_view for efficient vectorized
    sliding-window minimums along each axis.  The grid is on a fixed-distance
    regular lat/lon grid, so separable row/column passes are valid.

    Parameters
    ----------
    arr : 2D float32 array
    size : kernel width (odd integer)

    Returns
    -------
    2D float32 array with local minimums.
    """
    from numpy.lib.stride_tricks import sliding_window_view

    half_w = size // 2
    ny, nx = arr.shape

    # Pass 1: minimum along rows (axis=1)
    # Pad columns with inf so boundary windows are handled correctly
    padded_rows = np.pad(arr, ((0, 0), (half_w, half_w)),
                         mode='constant', constant_values=np.inf)
    # sliding_window_view along axis=1 gives shape (ny, nx, size)
    windows_r = sliding_window_view(padded_rows, size, axis=1)
    temp = np.min(windows_r, axis=2).astype(np.float32)

    # Pass 2: minimum along columns (axis=0) of the row-filtered result
    padded_cols = np.pad(temp, ((half_w, half_w), (0, 0)),
                         mode='constant', constant_values=np.inf)
    windows_c = sliding_window_view(padded_cols, size, axis=0)
    out = np.min(windows_c, axis=2).astype(np.float32)

    return out


def compute_ir_vigor(tb_frames: list, radius_km: float = 200.0,
                     box_deg: float = 8.0) -> Optional[np.ndarray]:
    """
    Compute spatially-aware IR vigor from a list of raw Tb arrays.

    For each grid point, vigor = current_Tb − local_min(temporal_avg),
    where local_min is the minimum within `radius_km` of that point.

    Uses a pure-numpy separable minimum filter (no scipy dependency).
    The grid is on a fixed-distance regular lat/lon grid, so separable
    row/column passes produce equivalent results to a 2D square kernel.

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

    # Compute filter kernel size in pixels (diameter of the radius)
    filter_size = max(3, 2 * int(round(radius_km / pixel_km)) + 1)

    # Spatially-aware local minimum of the temporal average
    # NaN-safe: replace NaN with extreme sentinel before filtering, restore after
    _NAN_SENTINEL = 9999.0
    avg_filled = np.where(np.isfinite(avg_tb), avg_tb, _NAN_SENTINEL)
    local_min = _min_filter_2d_pure_numpy(avg_filled, filter_size)
    local_min = np.where(local_min >= _NAN_SENTINEL * 0.9, np.nan, local_min)

    # Vigor = current Tb − local min of temporal average
    vigor = current_tb - local_min

    return vigor


def render_vigor_png(vigor_2d: np.ndarray,
                     as_data_url: bool = False,
                     min_output_px: int = 1024) -> Optional[str]:
    """
    Render a 2D vigor array to a base64-encoded PNG string using
    the vigor colormap.  The output is upsampled with nearest-neighbor
    interpolation so that each grid-point "pixel" matches the visual size
    of GIBS IR tiles on the Leaflet map (which render at ~256 px per tile).
    The frontend additionally uses CSS image-rendering: pixelated to ensure
    the browser does not blur the discrete pixels.

    Parameters
    ----------
    vigor_2d : 2D float32 array of vigor values (Kelvin).
    as_data_url : if True, prepend the data:image/png;base64, prefix.
    min_output_px : target minimum dimension for the output PNG.
        The native Tb grid (~333 px for a 6° box at 2 km) is upsampled
        by an integer factor so the longest side reaches at least this
        value.  Default 1024 gives ~3× upsampling, matching GIBS tile
        density on retina displays at zoom 5-6.

    Returns None if all data is NaN.
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

    # Upsample with nearest-neighbor so each grid-point pixel matches
    # the visual density of GIBS IR tiles on retina displays.
    max_dim = max(img.size)  # (width, height)
    if max_dim > 0 and max_dim < min_output_px:
        scale = max(1, min_output_px // max_dim)
        new_w = img.size[0] * scale
        new_h = img.size[1] * scale
        img = img.resize((new_w, new_h), Image.NEAREST)

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
