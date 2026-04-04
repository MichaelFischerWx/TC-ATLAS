"""
tc_radar_api.py  (S3/Zarr edition)
====================================
FastAPI backend for on-demand TC-RADAR plot generation.

Data backend: Zarr stores on S3 — case-level chunks mean each plot
request is a handful of small S3 GETs, typically completing in <1 s
(vs 5–15 s for HTTP range requests against AOML).

Deploy on Cloud Run or Render, co-located in the same AWS region
as your S3 bucket (us-east-1 recommended) for low-latency data access.

Environment variables
---------------------
    TC_RADAR_S3_BUCKET   S3 bucket name  (required for S3 mode)
    TC_RADAR_S3_PREFIX   prefix in bucket (default: tc-radar)
    AWS_ACCESS_KEY_ID    \\ standard AWS creds — or use an IAM role
    AWS_SECRET_ACCESS_KEY /
    AWS_DEFAULT_REGION   (default: us-east-1)
    METADATA_PATH        path to tc_radar_metadata.json (default: ./tc_radar_metadata.json)

If TC_RADAR_S3_BUCKET is not set the API falls back to the original
AOML HTTP range-request mode automatically.

Local dev
---------
    pip install fastapi uvicorn h5netcdf h5py fsspec xarray zarr s3fs matplotlib numpy Pillow
    TC_RADAR_S3_BUCKET=your-bucket uvicorn tc_radar_api:app --reload --port 8000
"""

import base64
import gc
import io
import json
import math
import os
import queue
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr
import fsspec
from scipy import ndimage as _ndimage
from scipy.interpolate import RegularGridInterpolator
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.responses import Response, JSONResponse, StreamingResponse
from starlette.requests import Request as StarletteRequest

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
S3_BUCKET  = os.environ.get("TC_RADAR_S3_BUCKET", "")
S3_PREFIX  = os.environ.get("TC_RADAR_S3_PREFIX", "tc-radar")
AWS_REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
USE_S3     = bool(S3_BUCKET)

# GCS Zarr — preferred over S3 (free egress from Cloud Run)
GCS_ZARR_BUCKET = os.environ.get("TC_RADAR_GCS_BUCKET", "")
GCS_ZARR_PREFIX = os.environ.get("TC_RADAR_GCS_PREFIX", "tc-radar")
USE_GCS_ZARR    = bool(GCS_ZARR_BUCKET)

AOML_BASE = "https://www.aoml.noaa.gov/ftp/pub/hrd/data/radar/level3"

# GCS Zarr paths (preferred — free egress from Cloud Run)
GCS_PATHS = {
    ("swath", "early"):  f"gs://{GCS_ZARR_BUCKET}/{GCS_ZARR_PREFIX}/swath_early",
    ("swath", "recent"): f"gs://{GCS_ZARR_BUCKET}/{GCS_ZARR_PREFIX}/swath_recent",
    ("merge", "early"):  f"gs://{GCS_ZARR_BUCKET}/{GCS_ZARR_PREFIX}/merge_early",
    ("merge", "recent"): f"gs://{GCS_ZARR_BUCKET}/{GCS_ZARR_PREFIX}/merge_recent",
} if USE_GCS_ZARR else {}

# S3 Zarr paths (fallback)
S3_PATHS = {
    ("swath", "early"):  f"s3://{S3_BUCKET}/{S3_PREFIX}/swath_early",
    ("swath", "recent"): f"s3://{S3_BUCKET}/{S3_PREFIX}/swath_recent",
    ("merge", "early"):  f"s3://{S3_BUCKET}/{S3_PREFIX}/merge_early",
    ("merge", "recent"): f"s3://{S3_BUCKET}/{S3_PREFIX}/merge_recent",
}

# AOML fallback (original NetCDF via HTTP range requests)
AOML_FILES = {
    ("swath", "early"):  f"{AOML_BASE}/tc_radar_v3m_1997_2019_xy_rel_swath_ships.nc",
    ("swath", "recent"): f"{AOML_BASE}/tc_radar_v3m_2020_2024_xy_rel_swath_ships.nc",
    ("merge", "early"):  f"{AOML_BASE}/tc_radar_v3m_1997_2019_xy_rel_merge_ships.nc",
    ("merge", "recent"): f"{AOML_BASE}/tc_radar_v3m_2020_2024_xy_rel_merge_ships.nc",
}


# IR satellite imagery (MergIR) Zarr store
IR_GCS_PATH = f"gs://{GCS_ZARR_BUCKET}/{GCS_ZARR_PREFIX}/mergir" if GCS_ZARR_BUCKET else ""
IR_S3_PATH = f"s3://{S3_BUCKET}/{S3_PREFIX}/mergir" if S3_BUCKET else ""

# IR colormap: NOAA-style enhanced IR (warm=dark, cold=bright/colorful)
IR_COLORMAP = [
    [0.0,    "rgb(8,8,8)"],
    [0.15,   "rgb(40,40,40)"],
    [0.30,   "rgb(90,90,90)"],
    [0.40,   "rgb(140,140,140)"],
    [0.50,   "rgb(200,200,200)"],
    [0.55,   "rgb(0,180,255)"],
    [0.60,   "rgb(0,100,255)"],
    [0.65,   "rgb(0,255,0)"],
    [0.70,   "rgb(255,255,0)"],
    [0.75,   "rgb(255,180,0)"],
    [0.80,   "rgb(255,80,0)"],
    [0.85,   "rgb(255,0,0)"],
    [0.90,   "rgb(180,0,180)"],
    [0.95,   "rgb(255,180,255)"],
    [1.0,    "rgb(255,255,255)"],
]

# ERA5 environmental diagnostics Zarr store
ERA5_GCS_PATH = f"gs://{GCS_ZARR_BUCKET}/{GCS_ZARR_PREFIX}/era5" if GCS_ZARR_BUCKET else ""
ERA5_S3_PATH = f"s3://{S3_BUCKET}/{S3_PREFIX}/era5" if S3_BUCKET else ""

ERA5_FIELD_CONFIG = {
    "shear_mag": {
        "display_name": "Deep-Layer Shear (200\u2013850 hPa)",
        "units": "m/s", "vmin": 0, "vmax": 30,
        "colorscale": [
            [0.0, "rgb(255,255,204)"], [0.15, "rgb(255,237,160)"],
            [0.30, "rgb(254,217,118)"], [0.45, "rgb(254,178,76)"],
            [0.60, "rgb(253,141,60)"], [0.75, "rgb(240,59,32)"],
            [0.90, "rgb(189,0,38)"], [1.0, "rgb(128,0,38)"],
        ],
        "has_vectors": True,
        "vector_u": "shear_u", "vector_v": "shear_v",
    },
    "rh_mid": {
        "display_name": "Mid-Level RH (500\u2013700 hPa)",
        "units": "%", "vmin": 0, "vmax": 100,
        "colorscale": [
            [0.0, "rgb(140,81,10)"], [0.15, "rgb(191,129,45)"],
            [0.30, "rgb(223,194,125)"], [0.45, "rgb(245,245,220)"],
            [0.55, "rgb(199,234,229)"], [0.70, "rgb(128,205,193)"],
            [0.85, "rgb(53,151,143)"], [1.0, "rgb(1,102,94)"],
        ],
        "has_vectors": False,
    },
    "div200": {
        "display_name": "200 hPa Divergence",
        "units": "s\u207b\u00b9", "vmin": -3e-5, "vmax": 3e-5,
        "colorscale": [
            [0.0, "rgb(178,24,43)"], [0.15, "rgb(214,96,77)"],
            [0.30, "rgb(244,165,130)"], [0.45, "rgb(253,219,199)"],
            [0.55, "rgb(209,229,240)"], [0.70, "rgb(146,197,222)"],
            [0.85, "rgb(67,147,195)"], [1.0, "rgb(33,102,172)"],
        ],
        "has_vectors": True,
        "vector_u": "u200", "vector_v": "v200",
    },
    "sst": {
        "display_name": "Sea Surface Temperature",
        "units": "°C", "vmin": 18, "vmax": 32,
        "colorscale": [
            [0.0, "rgb(49,54,149)"], [0.15, "rgb(69,117,180)"],
            [0.30, "rgb(116,173,209)"], [0.45, "rgb(171,217,233)"],
            [0.55, "rgb(253,174,97)"], [0.70, "rgb(244,109,67)"],
            [0.85, "rgb(215,48,39)"], [1.0, "rgb(165,0,38)"],
        ],
        "has_vectors": False,
    },
    "entropy_def": {
        "display_name": "Entropy Deficit (χₘ)",
        "units": "", "vmin": 0, "vmax": 2.0,
        "colorscale": [
            [0.0, "rgb(255,247,236)"], [0.15, "rgb(254,232,200)"],
            [0.30, "rgb(253,212,158)"], [0.45, "rgb(253,187,132)"],
            [0.60, "rgb(227,145,86)"], [0.75, "rgb(189,109,53)"],
            [0.90, "rgb(140,81,10)"], [1.0, "rgb(84,48,5)"],
        ],
        "has_vectors": False,
    },
}

CASE_COUNTS = {
    ("swath", "early"):  710,
    ("swath", "recent"): 800,
    ("merge", "early"):  215,
    ("merge", "recent"): 221,
}

# ---------------------------------------------------------------------------
# Variable config
# ---------------------------------------------------------------------------
VARIABLES = {
    "recentered_tangential_wind":           ("Tangential Wind (WCM)",          "recentered_tangential_wind",           "jet",       "m/s",  -10,   80),
    "recentered_radial_wind":               ("Radial Wind (WCM)",               "recentered_radial_wind",               "RdBu_r",    "m/s",  -30,   30),
    "recentered_upward_air_velocity":       ("Vertical Velocity (WCM)",         "recentered_upward_air_velocity",       "RdBu_r",    "m/s",   -5,    5),
    "recentered_reflectivity":              ("Reflectivity (WCM)",              "recentered_reflectivity",              "Spectral_r","dBZ",  -10,   65),
    "recentered_wind_speed":                ("Wind Speed (WCM)",                "recentered_wind_speed",                "inferno",   "m/s",    0,   80),
    "recentered_earth_relative_wind_speed": ("Earth-Rel. Wind Speed (WCM)",    "recentered_earth_relative_wind_speed", "jet",       "m/s",    0,   80),
    "recentered_relative_vorticity":        ("Relative Vorticity (WCM)",        "recentered_relative_vorticity",        "RdBu_r",    "s⁻¹",-5e-3, 5e-3),
    "recentered_divergence":                ("Divergence (WCM)",                "recentered_divergence",                "RdBu_r",    "s⁻¹",-5e-3, 5e-3),
    "total_recentered_tangential_wind":     ("Tangential Wind (tilt-relative)", "total_recentered_tangential_wind",     "jet",       "m/s",  -10,   80),
    "total_recentered_radial_wind":         ("Radial Wind (tilt-relative)",     "total_recentered_radial_wind",         "RdBu_r",    "m/s",  -30,   30),
    "total_recentered_upward_air_velocity": ("Vertical Velocity (tilt-rel.)",   "total_recentered_upward_air_velocity", "RdBu_r",    "m/s",   -5,    5),
    "total_recentered_reflectivity":        ("Reflectivity (tilt-relative)",    "total_recentered_reflectivity",        "Spectral_r","dBZ",  -10,   65),
    "total_recentered_wind_speed":          ("Wind Speed (tilt-relative)",      "total_recentered_wind_speed",          "inferno",   "m/s",    0,   80),
    "total_recentered_earth_relative_wind_speed": ("Earth-Rel. Wind Speed (tilt-rel.)", "total_recentered_earth_relative_wind_speed", "jet", "m/s", 0, 80),
    "swath_tangential_wind":                ("Tangential Wind (original)",      "swath_tangential_wind",                "jet",       "m/s",  -10,   80),
    "swath_radial_wind":                    ("Radial Wind (original)",          "swath_radial_wind",                    "RdBu_r",    "m/s",  -30,   30),
    "swath_reflectivity":                   ("Reflectivity (original)",         "swath_reflectivity",                   "Spectral_r","dBZ",  -10,   65),
    "swath_wind_speed":                     ("Wind Speed (original)",           "swath_wind_speed",                     "inferno",   "m/s",    0,   80),
    "swath_earth_relative_wind_speed":      ("Earth-Rel. Wind Speed (original)","swath_earth_relative_wind_speed",      "jet",       "m/s",    0,   80),
    # Merged (flight-averaged) domain
    "merged_tangential_wind":               ("Tangential Wind (merged)",        "merged_tangential_wind",               "jet",       "m/s",  -10,   80),
    "merged_radial_wind":                   ("Radial Wind (merged)",            "merged_radial_wind",                   "RdBu_r",    "m/s",  -30,   30),
    "merged_reflectivity":                  ("Reflectivity (merged)",           "merged_reflectivity",                  "Spectral_r","dBZ",  -10,   65),
    "merged_wind_speed":                    ("Wind Speed (merged)",             "merged_wind_speed",                    "inferno",   "m/s",    0,   80),
    "merged_upward_air_velocity":           ("Vertical Velocity (merged)",      "merged_upward_air_velocity",           "RdBu_r",    "m/s",   -5,    5),
    "merged_relative_vorticity":            ("Relative Vorticity (merged)",     "merged_relative_vorticity",            "RdBu_r",    "s⁻¹",-5e-3, 5e-3),
    "merged_divergence":                    ("Divergence (merged)",             "merged_divergence",                    "RdBu_r",    "s⁻¹",-5e-3, 5e-3),
}

# Derived variables: computed as sqrt(u² + v²) from component pairs
# key → (u_varname, v_varname)
DERIVED_VARIABLES = {
    "recentered_earth_relative_wind_speed":       ("recentered_earth_relative_eastward_wind",       "recentered_earth_relative_northward_wind"),
    "total_recentered_earth_relative_wind_speed":  ("total_recentered_earth_relative_eastward_wind",  "total_recentered_earth_relative_northward_wind"),
    "swath_earth_relative_wind_speed":             ("swath_earth_relative_eastward_wind",             "swath_earth_relative_northward_wind"),
}

DEFAULT_VARIABLE = "recentered_tangential_wind"

# Wind-barb U/V component mapping: wind-speed variable → (u_varname, v_varname) in netCDF
# These provide the vector components for overlaying meteorological wind barbs.
WIND_BARB_COMPONENTS = {
    "recentered_wind_speed":                        ("recentered_eastward_wind",                        "recentered_northward_wind"),
    "recentered_earth_relative_wind_speed":         ("recentered_earth_relative_eastward_wind",         "recentered_earth_relative_northward_wind"),
    "total_recentered_wind_speed":                  ("total_recentered_eastward_wind",                  "total_recentered_northward_wind"),
    "total_recentered_earth_relative_wind_speed":   ("total_recentered_earth_relative_eastward_wind",   "total_recentered_earth_relative_northward_wind"),
    "swath_wind_speed":                             ("swath_eastward_wind",                             "swath_northward_wind"),
    "swath_earth_relative_wind_speed":              ("swath_earth_relative_eastward_wind",              "swath_earth_relative_northward_wind"),
    "merged_wind_speed":                            ("merged_eastward_wind",                            "merged_northward_wind"),
}

# Mapping: any variable key → its merged climatology equivalent.
# The climatology was computed only for merged_* variables, so we map
# recentered, total_recentered, and swath variants to their merged counterpart.
_CLIMO_VAR_MAP = {}
_MERGED_BASES = [
    "tangential_wind", "radial_wind", "upward_air_velocity",
    "reflectivity", "wind_speed", "relative_vorticity", "divergence",
]
for _base in _MERGED_BASES:
    _merged = f"merged_{_base}"
    _CLIMO_VAR_MAP[_merged] = _merged
    _CLIMO_VAR_MAP[f"recentered_{_base}"] = _merged
    _CLIMO_VAR_MAP[f"total_recentered_{_base}"] = _merged
    _CLIMO_VAR_MAP[f"swath_{_base}"] = _merged

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="TC-RADAR API", version="2.0.0")

# GZip compression — flight-level JSON responses are 0.5-2 MB and compress
# very well (~5-10× reduction).  minimum_size avoids overhead on small responses.
from starlette.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)

_cors_origins = os.environ.get(
    "CORS_ORIGINS",
    "https://michaelfischerwx.github.io,http://localhost:8000",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins],
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Per-IP rate limiting — protect against API abuse
# ---------------------------------------------------------------------------
import time as _time
import collections as _collections
import logging as _logging

_rate_logger = _logging.getLogger("tc-atlas.ratelimit")

# Sliding-window counters per IP
_rate_window = 60          # window in seconds
_rate_max_requests = 120   # max requests per window (2/sec avg)
_rate_alert_threshold = 5  # log warning after this many rejections per IP per window
_rate_buckets: dict[str, list[float]] = {}
_rate_rejections: dict[str, int] = _collections.defaultdict(int)
_rate_lock = threading.Lock()


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Lightweight per-IP rate limiter with abuse alerting."""

    # Skip rate limiting for health checks and static-like endpoints
    EXEMPT_PREFIXES = ('/health', '/docs', '/openapi.json')

    async def dispatch(self, request: StarletteRequest, call_next):
        path = request.url.path
        if any(path.startswith(p) for p in self.EXEMPT_PREFIXES):
            return await call_next(request)

        # Get client IP (Cloud Run sets X-Forwarded-For)
        forwarded = request.headers.get("x-forwarded-for", "")
        client_ip = forwarded.split(",")[0].strip() if forwarded else (
            request.client.host if request.client else "unknown"
        )

        now = _time.monotonic()
        with _rate_lock:
            # Get or create bucket for this IP
            if client_ip not in _rate_buckets:
                _rate_buckets[client_ip] = []

            bucket = _rate_buckets[client_ip]
            # Remove timestamps outside the window
            cutoff = now - _rate_window
            while bucket and bucket[0] < cutoff:
                bucket.pop(0)

            if len(bucket) >= _rate_max_requests:
                _rate_rejections[client_ip] += 1
                rej_count = _rate_rejections[client_ip]
                if rej_count == _rate_alert_threshold:
                    _rate_logger.warning(
                        f"RATE_LIMIT_ABUSE: IP {client_ip} hit rate limit "
                        f"{rej_count} times in current window — "
                        f"path={path}, threshold={_rate_max_requests}/{_rate_window}s"
                    )
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Too many requests. Please slow down."},
                )

            bucket.append(now)
            # Reset rejection counter if request succeeds
            if client_ip in _rate_rejections and _rate_rejections[client_ip] > 0:
                _rate_rejections[client_ip] = 0

        # Periodically clean up stale IPs (every ~1000 requests)
        if len(_rate_buckets) > 500:
            with _rate_lock:
                stale = [ip for ip, b in _rate_buckets.items()
                         if not b or b[-1] < now - _rate_window * 2]
                for ip in stale:
                    del _rate_buckets[ip]
                    _rate_rejections.pop(ip, None)

        return await call_next(request)


app.add_middleware(RateLimitMiddleware)


# ---------------------------------------------------------------------------
# HTTP cache headers — scientific data is immutable, cache aggressively
# ---------------------------------------------------------------------------

class CacheHeaderMiddleware(BaseHTTPMiddleware):
    """
    Add Cache-Control headers based on endpoint data mutability.

    Immutable endpoints (radar data, IR, ERA5) get long TTLs — the data
    will never change for a given case_index + variable + level.
    Semi-stable endpoints (composites) get shorter TTLs since new cases
    could be added.  Metadata/health get brief caching.
    """
    IMMUTABLE_PREFIXES = (
        '/data', '/ir', '/ir_frame', '/era5',
        '/azimuthal_mean', '/quadrant_mean',
        '/cross_section', '/plot', '/volume',
        '/anomaly', '/hybrid', '/scatter', '/climatology',
    )
    SEMI_STABLE_PREFIXES = ('/composite',)
    SHORT_CACHE_PATHS = ('/health', '/metadata', '/variables', '/levels')

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        path = request.url.path

        # Only cache successful responses
        if response.status_code == 200:
            if any(path.startswith(p) for p in self.IMMUTABLE_PREFIXES):
                response.headers['Cache-Control'] = 'public, max-age=86400, immutable'
            elif any(path.startswith(p) for p in self.SEMI_STABLE_PREFIXES):
                response.headers['Cache-Control'] = 'public, max-age=3600'
            elif path in self.SHORT_CACHE_PATHS:
                response.headers['Cache-Control'] = 'public, max-age=300'

        return response


app.add_middleware(CacheHeaderMiddleware)


class CompositeGCMiddleware(BaseHTTPMiddleware):
    """
    Force garbage collection after composite endpoints to reclaim numpy arrays
    and prevent OOM on the 2 GB Render plan.
    """
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path.startswith('/composite'):
            gc.collect()
        return response

app.add_middleware(CompositeGCMiddleware)


# ---------------------------------------------------------------------------
# Dataset loading
# ---------------------------------------------------------------------------

@lru_cache(maxsize=2)
def get_dataset(data_type: str, era: str) -> xr.Dataset:
    """
    Open a TC-RADAR dataset.

    Priority: GCS Zarr (free egress) > S3 Zarr > AOML NetCDF (slow fallback)
    """
    key = (data_type, era)
    if USE_GCS_ZARR and key in GCS_PATHS:
        import gcsfs
        path = GCS_PATHS[key]
        fs = gcsfs.GCSFileSystem()
        store = gcsfs.GCSMap(root=path, gcs=fs, check=False)
        ds = xr.open_zarr(store, consolidated=True)
        print(f"Opened Zarr from GCS: {path}")
        return ds
    if USE_S3:
        import s3fs
        path = S3_PATHS[key]
        fs   = s3fs.S3FileSystem(anon=False, client_kwargs={"region_name": AWS_REGION})
        store = s3fs.S3Map(root=path, s3=fs, check=False)
        ds = xr.open_zarr(store, consolidated=True)
        print(f"Opened Zarr from S3: {path}")
        return ds
    url = AOML_FILES[key]
    of  = fsspec.open(url, "rb")
    ds  = xr.open_dataset(of.open(), engine="h5netcdf")
    print(f"Opened NetCDF from AOML: {url}")
    return ds



@lru_cache(maxsize=1)
def get_ir_dataset():
    """Open the MergIR Zarr store. Prefers GCS (free egress) over S3."""
    import zarr
    if USE_GCS_ZARR and IR_GCS_PATH:
        import gcsfs
        fs = gcsfs.GCSFileSystem()
        store = gcsfs.GCSMap(root=IR_GCS_PATH, gcs=fs, check=False)
        print(f"Opened MergIR Zarr from GCS: {IR_GCS_PATH}")
        return zarr.open(store, mode='r')
    if USE_S3 and IR_S3_PATH:
        import s3fs
        fs = s3fs.S3FileSystem(anon=False, client_kwargs={"region_name": AWS_REGION})
        store = s3fs.S3Map(root=IR_S3_PATH, s3=fs, check=False)
        print(f"Opened MergIR Zarr from S3: {IR_S3_PATH}")
        return zarr.open(store, mode='r')
    return None


@lru_cache(maxsize=1)
def get_era5_dataset():
    """Open the ERA5 Zarr store. Prefers GCS (free egress) over S3."""
    import zarr
    if USE_GCS_ZARR and ERA5_GCS_PATH:
        import gcsfs
        fs = gcsfs.GCSFileSystem()
        store = gcsfs.GCSMap(root=ERA5_GCS_PATH, gcs=fs, check=False)
        print(f"Opened ERA5 Zarr from GCS: {ERA5_GCS_PATH}")
        return zarr.open(store, mode='r')
    if USE_S3 and ERA5_S3_PATH:
        import s3fs
        fs = s3fs.S3FileSystem(anon=False, client_kwargs={"region_name": AWS_REGION})
        store = s3fs.S3Map(root=ERA5_S3_PATH, s3=fs, check=False)
        print(f"Opened ERA5 Zarr from S3: {ERA5_S3_PATH}")
        return zarr.open(store, mode='r')
    return None


def resolve_case(case_index: int, data_type: str) -> tuple[xr.Dataset, int]:
    early_count = CASE_COUNTS[(data_type, "early")]
    if case_index < early_count:
        return get_dataset(data_type, "early"), case_index
    else:
        return get_dataset(data_type, "recent"), case_index - early_count


# ---------------------------------------------------------------------------
# Plot rendering
# ---------------------------------------------------------------------------

def render_planview(
    ds: xr.Dataset,
    local_idx: int,
    variable_key: str,
    level_km: float,
    case_meta: dict,
) -> bytes:
    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable_key]

    # Derived variable: compute sqrt(u² + v²) from component pair
    if variable_key in DERIVED_VARIABLES:
        u_name, v_name = DERIVED_VARIABLES[variable_key]
        if u_name not in ds or v_name not in ds:
            raise ValueError(f"Components '{u_name}' / '{v_name}' not in dataset.")
        ref_varname = u_name  # use u component for dim detection
        height_vals = ds["height"].values
        z_idx = int(np.argmin(np.abs(height_vals - level_km)))
        actual_level = float(height_vals[z_idx])
        u = ds[u_name].isel(num_cases=local_idx, height=z_idx).values
        v = ds[v_name].isel(num_cases=local_idx, height=z_idx).values
        data = np.sqrt(u**2 + v**2)
    else:
        if varname not in ds:
            available = [k for k, v in VARIABLES.items() if v[1] in ds]
            raise ValueError(f"'{varname}' not in dataset. Available: {available}")
        ref_varname = varname
        da = ds[varname].isel(num_cases=local_idx)
        height_vals = ds["height"].values
        z_idx = int(np.argmin(np.abs(height_vals - level_km)))
        actual_level = float(height_vals[z_idx])
        da = da.isel(height=z_idx)
        data = da.values

    # Determine which spatial grid this variable is on:
    #   - recentered / total_recentered vars: (northward_distance, eastward_distance) — 201×201
    #   - original swath vars:                (latitude, longitude)                   — 200×200
    var_dims = set(ds[ref_varname].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        x = ds["eastward_distance"].values
        y = ds["northward_distance"].values
    elif "latitude" in var_dims and "longitude" in var_dims:
        # Original grid: construct storm-centered distance axes (2 km spacing)
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x = np.linspace(-(nx - 1), (nx - 1), nx)   # e.g. -199 to +199 km
        y = np.linspace(-(ny - 1), (ny - 1), ny)
    else:
        # Fallback: use first two remaining dims as index arrays
        remaining = [d for d in da.dims if d != "num_cases" and d != "height"]
        x = np.arange(data.shape[-1])
        y = np.arange(data.shape[-2])

    fig, ax = plt.subplots(figsize=(7, 6.5), facecolor="#0e1117")
    ax.set_facecolor("#0e1117")

    im = ax.pcolormesh(x, y, data, cmap=cmap, vmin=vmin, vmax=vmax, shading="auto")

    rmw = case_meta.get("rmw_km")
    if rmw is not None and not np.isnan(float(rmw)):
        rmw = float(rmw)
        theta = np.linspace(0, 2 * np.pi, 360)
        ax.plot(rmw * np.cos(theta), rmw * np.sin(theta),
                "w--", lw=1.5, alpha=0.85, label=f"RMW = {rmw:.0f} km")
        ax.legend(loc="upper right", fontsize=8, framealpha=0.3, labelcolor="white")

    cbar = fig.colorbar(im, ax=ax, fraction=0.04, pad=0.02)
    cbar.set_label(units, color="white", fontsize=9)
    cbar.ax.yaxis.set_tick_params(color="white")
    plt.setp(cbar.ax.yaxis.get_ticklabels(), color="white")

    storm   = case_meta.get("storm_name", "")
    dt      = case_meta.get("datetime", "")
    vmax_kt = case_meta.get("vmax_kt", "")
    vmax_str = f"  |  Vmax = {float(vmax_kt):.0f} kt" if vmax_kt != "" else ""
    ax.set_title(
        f"{storm}  |  {dt}{vmax_str}\n{display_name} @ {actual_level:.1f} km",
        color="white", fontsize=10, pad=8,
    )
    ax.set_xlabel("Eastward distance (km)", color="white", fontsize=9)
    ax.set_ylabel("Northward distance (km)", color="white", fontsize=9)
    ax.tick_params(colors="white")
    for spine in ax.spines.values():
        spine.set_edgecolor("#444")
    ax.set_aspect("equal")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130, bbox_inches="tight",
                facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    return buf.read()


# ---------------------------------------------------------------------------
# Metadata + plot cache
# ---------------------------------------------------------------------------
METADATA_PATH = Path(os.environ.get("METADATA_PATH", "./tc_radar_metadata.json"))
MERGE_METADATA_PATH = Path(os.environ.get("MERGE_METADATA_PATH", "./tc_radar_metadata_merge.json"))
_metadata_cache: dict[int, dict] = {}
_merge_metadata_cache: dict[int, dict] = {}
# Staging area for two-pass vortex metrics (raw values before DB mean subtraction)
_vortex_raw: dict[int, dict] = {}       # case_index -> {raw_h1_max, raw_width_diff}
_vortex_eras_done = 0                    # how many merge eras have finished pass 1
_vortex_db_means: dict = {}              # {"h1": float, "wd": float} after finalize
_vortex_lock = threading.Lock()          # guard the counter + finalize
_plot_cache: OrderedDict = OrderedDict()
_PLOT_CACHE_MAX = 40   # ~40 plots × ~150 KB ≈ 6 MB max (was 150)

_data_cache: OrderedDict = OrderedDict()
_DATA_CACHE_MAX = 20   # ~20 entries — JSON dicts can be large (was 100)

# Precomputed hybrid-coordinate climatology (Fischer et al. 2025)
# Loaded at startup from climatology_hybrid.npz
_climatology: dict = {}      # Loaded numpy arrays keyed by name
CLIMATOLOGY_PATH = Path(os.environ.get("CLIMATOLOGY_PATH", "./climatology_hybrid.npz"))

# Merge case_index → swath case_index mapping for IR/ERA5 lookups.
# The MergIR and ERA5 zarr stores are indexed by swath case (0–1509),
# but merge mode passes merge case indices (0–435).  This dict maps
# merge_case_index → nearest swath_case_index (matched by mission_id
# and closest datetime).  Built at startup from both metadata files.
_merge_to_swath_index: dict[int, int] = {}


@app.on_event("startup")
def startup():
    # Load metadata
    global _metadata_cache, _merge_metadata_cache, _merge_to_swath_index
    if METADATA_PATH.exists():
        with open(METADATA_PATH) as f:
            data = json.load(f)
        _metadata_cache = {c["case_index"]: c for c in data.get("cases", [])}
        print(f"Loaded {len(_metadata_cache)} cases from {METADATA_PATH}")
    else:
        print(f"Warning: {METADATA_PATH} not found")

    if MERGE_METADATA_PATH.exists():
        with open(MERGE_METADATA_PATH) as f:
            data = json.load(f)
        _merge_metadata_cache = {c["case_index"]: c for c in data.get("cases", [])}
        print(f"Loaded {len(_merge_metadata_cache)} merge cases from {MERGE_METADATA_PATH}")
    else:
        print(f"Warning: {MERGE_METADATA_PATH} not found — merge composites will not filter correctly")

    # Load precomputed climatology for anomaly diagnostics
    global _climatology
    if CLIMATOLOGY_PATH.exists():
        _clim_data = np.load(str(CLIMATOLOGY_PATH), allow_pickle=False)
        _climatology = {k: _clim_data[k] for k in _clim_data.files}
        print(f"Loaded hybrid climatology from {CLIMATOLOGY_PATH} "
              f"({len(_climatology)} arrays)")
    else:
        print(f"Note: {CLIMATOLOGY_PATH} not found — anomaly diagnostics disabled. "
              f"Run precompute_climatology.py to generate it.")

    # Build merge→swath index mapping for IR/ERA5 lookups.
    # The MergIR and ERA5 zarr stores are indexed by swath case number,
    # so when in merge mode we need to translate merge indices to swath indices.
    if _metadata_cache and _merge_metadata_cache:
        from datetime import datetime as _dt
        # Build swath lookup: mission_id → [(swath_idx, datetime, storm_name)]
        _sw_by_mission: dict[str, list] = {}
        for sc in _metadata_cache.values():
            mid = sc.get("mission_id", "")
            sdt = _dt.strptime(sc["datetime"], "%Y-%m-%d %H:%M UTC")
            _sw_by_mission.setdefault(mid, []).append((sc["case_index"], sdt, sc.get("storm_name", "")))

        for mc in _merge_metadata_cache.values():
            mg_idx = mc["case_index"]
            mg_dt = _dt.strptime(mc["datetime"], "%Y-%m-%d %H:%M UTC")
            mg_mission = mc.get("mission_id", "")
            mg_storm = mc.get("storm_name", "")

            # Strategy 1: match by mission_id, pick closest in time
            candidates = _sw_by_mission.get(mg_mission, [])
            if candidates:
                best = min(candidates, key=lambda x: abs((x[1] - mg_dt).total_seconds()))
                _merge_to_swath_index[mg_idx] = best[0]
            else:
                # Strategy 2: match by storm_name, closest time within 24 h
                all_storm = [(si, sdt, sn) for cands in _sw_by_mission.values()
                             for si, sdt, sn in cands if sn == mg_storm]
                if all_storm:
                    best = min(all_storm, key=lambda x: abs((x[1] - mg_dt).total_seconds()))
                    if abs((best[1] - mg_dt).total_seconds()) < 86400:
                        _merge_to_swath_index[mg_idx] = best[0]

        print(f"Built merge→swath index mapping: {len(_merge_to_swath_index)}/{len(_merge_metadata_cache)} cases mapped")

    backend = f"S3 Zarr (s3://{S3_BUCKET}/{S3_PREFIX})" if USE_S3 else "AOML HTTP (fallback)"
    print(f"Data backend: {backend}")

    # Pre-warm datasets in background threads
    # Also enrich metadata with SHIPS shear values once datasets are loaded
    def prewarm_and_enrich(data_type, era):
        try:
            ds = get_dataset(data_type, era)
            print(f"Pre-warmed {data_type}/{era}")
            _enrich_metadata_with_ships(ds, data_type, era)
            _enrich_metadata_with_max_wind(ds, data_type, era)
            _enrich_metadata_with_ships_extended(ds, data_type, era)
            # Compute vortex metrics for merged cases (requires climatology)
            if data_type == "merge" and _climatology:
                _enrich_metadata_with_vortex_metrics(ds, era)
        except Exception as e:
            print(f"Pre-warm failed {data_type}/{era}: {e}")

    for dt in ("swath", "merge"):
        for era in ("early", "recent"):
            threading.Thread(target=prewarm_and_enrich, args=(dt, era), daemon=True).start()


def _enrich_metadata_with_ships(ds, data_type, era):
    """
    Enrich metadata cache with SHIPS shear values (SDDC, SHDC) read
    from the Zarr store.  Runs once per dataset at startup so that
    composite filtering never needs to open the Zarr just to check shear.
    """
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    early_count = CASE_COUNTS[(data_type, "early")]
    offset = 0 if era == "early" else early_count
    n_cases = ds.sizes.get("num_cases", 0)
    enriched = 0
    for local_idx in range(n_cases):
        case_index = local_idx + offset
        if case_index not in cache:
            continue
        sddc = _get_ships_value(ds, local_idx, "sddc_ships")
        shdc = _get_ships_value(ds, local_idx, "shdc_ships")
        if sddc is not None:
            cache[case_index]["sddc"] = sddc
        if shdc is not None:
            cache[case_index]["shdc"] = shdc
        enriched += 1
    print(f"Enriched {enriched} cases with SHIPS shear data ({data_type}/{era})")


def _enrich_metadata_with_max_wind(ds, data_type, era):
    """
    Enrich metadata cache with maximum earth-relative TDR wind speed at
    z = 0.5 km and z = 2.0 km for each case.  Runs once per dataset at
    startup alongside SHIPS enrichment.

    The values are the domain-wide maximum of sqrt(u² + v²) on the 2-D
    plan-view grid at each height level.  Units: m/s, rounded to 1 dp.
    """
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    early_count = CASE_COUNTS[(data_type, "early")]
    offset = 0 if era == "early" else early_count
    n_cases = ds.sizes.get("num_cases", 0)

    # Identify the height indices for 0.5 km and 2.0 km
    height_vals = ds["height"].values
    z05_idx = int(np.argmin(np.abs(height_vals - 0.5)))
    z20_idx = int(np.argmin(np.abs(height_vals - 2.0)))

    # Determine which variable to use
    u_name = v_name = None
    for u_cand, v_cand in [
        ("recentered_earth_relative_eastward_wind", "recentered_earth_relative_northward_wind"),
        ("recentered_eastward_wind", "recentered_northward_wind"),
    ]:
        if u_cand in ds and v_cand in ds:
            u_name, v_name = u_cand, v_cand
            break

    has_components = u_name is not None
    fallback_var = "recentered_wind_speed" if "recentered_wind_speed" in ds else None

    if not has_components and fallback_var is None:
        print(f"  Skipping max-wind enrichment — no suitable variables ({data_type}/{era})")
        return

    enriched = 0
    for local_idx in range(n_cases):
        case_index = local_idx + offset
        if case_index not in cache:
            continue
        try:
            for z_idx, field_name in [(z05_idx, "max_er_wspd_05km"), (z20_idx, "max_er_wspd_20km")]:
                if has_components:
                    u = ds[u_name].isel(num_cases=local_idx, height=z_idx).values
                    v = ds[v_name].isel(num_cases=local_idx, height=z_idx).values
                    wspd = np.sqrt(u**2 + v**2)
                else:
                    wspd = ds[fallback_var].isel(num_cases=local_idx, height=z_idx).values

                max_val = float(np.nanmax(wspd))
                if np.isfinite(max_val):
                    cache[case_index][field_name] = round(max_val, 1)
                else:
                    cache[case_index][field_name] = None
            enriched += 1
        except Exception:
            cache[case_index].setdefault("max_er_wspd_05km", None)
            cache[case_index].setdefault("max_er_wspd_20km", None)

    print(f"Enriched {enriched} cases with max earth-rel wind speed ({data_type}/{era})")


def _filter_cases_for_composite(
    min_intensity: float, max_intensity: float,
    min_vmax_change: float, max_vmax_change: float,
    min_tilt: float, max_tilt: float,
    min_year: int, max_year: int,
    min_shear_mag: float, max_shear_mag: float,
    min_shear_dir: float, max_shear_dir: float,
    min_dtl: float = 0,
    dtl_window: str = "24h",
    data_type: str = "swath",
) -> list[int]:
    """Return list of case_index values that pass all composite filters."""
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    matching = []
    for idx, meta in cache.items():
        vmax = meta.get("vmax_kt")
        if vmax is None:
            continue
        if vmax < min_intensity or vmax > max_intensity:
            continue

        vc = meta.get("24-h_vmax_change_kt")
        if min_vmax_change > -100 or max_vmax_change < 85:
            if vc is None:
                continue
            if vc < min_vmax_change or vc > max_vmax_change:
                continue

        tilt = meta.get("tilt_magnitude_km")
        if min_tilt > 0 or max_tilt < 200:
            if tilt is None:
                continue
            if tilt < min_tilt or tilt > max_tilt:
                continue

        year = meta.get("year")
        if year is not None and (year < min_year or year > max_year):
            continue

        # Shear magnitude: swath uses "shdc" (enriched), merge uses "shear_magnitude_kt" (from JSON)
        shear_mag = meta.get("shdc") or meta.get("shear_magnitude_kt")
        if min_shear_mag > 0 or max_shear_mag < 100:
            if shear_mag is None:
                continue
            if shear_mag < min_shear_mag or shear_mag > max_shear_mag:
                continue

        sddc = meta.get("sddc")
        if min_shear_dir > 0 or max_shear_dir < 360:
            if sddc is None:
                continue
            # Handle wraparound: if min > max, it's a range crossing 360°
            if min_shear_dir <= max_shear_dir:
                if sddc < min_shear_dir or sddc > max_shear_dir:
                    continue
            else:
                # e.g. min=315, max=45 means "NW through NE"
                if sddc < min_shear_dir and sddc > max_shear_dir:
                    continue

        # Distance-to-land filter: exclude cases that approach/cross land
        if min_dtl > 0:
            dtl_key = "dtl_min_24h" if dtl_window == "24h" else "dtl_min_12h"
            dtl_val = meta.get(dtl_key)
            if dtl_val is None or dtl_val < min_dtl:
                continue

        matching.append(idx)
    return matching


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    """Lightweight health/readiness check for Cloud Run liveness probes."""
    return {
        "status": "ok",
        "version": "2.0",
        "backend": "s3_zarr" if USE_S3 else "aoml_http",
        "bucket": S3_BUCKET if USE_S3 else None,
    }


@app.get("/warmup")
def warmup():
    """
    Warm-up endpoint called by Cloud Scheduler every 5 minutes.
    Does three things beyond keeping the container alive:
      1. Refreshes the active storms cache (NHC + JTWC polling)
      2. Touches S3 to keep connection pools / TLS sessions alive
      3. Pre-warms the SEB directory listing for real-time TDR
    Point Cloud Scheduler at: GET https://<service-url>/warmup
    """
    result = {"status": "warm"}

    # 1. Refresh active storms cache (skips if refreshed <60s ago)
    try:
        from ir_monitor_api import refresh_active_storms_cache
        storm_info = refresh_active_storms_cache()
        result["storms"] = storm_info
    except Exception as e:
        result["storms_error"] = str(e)

    # 2. Touch cloud storage to keep connection pool alive
    if USE_GCS_ZARR:
        try:
            import gcsfs
            fs = gcsfs.GCSFileSystem()
            fs.ls(f"{GCS_ZARR_BUCKET}/{GCS_ZARR_PREFIX}/", detail=False)
            result["gcs_zarr_alive"] = True
        except Exception as e:
            result["gcs_zarr_alive"] = False
            result["gcs_zarr_error"] = str(e)
    if USE_S3:
        try:
            import s3fs
            fs = s3fs.S3FileSystem(anon=False,
                                   client_kwargs={"region_name": AWS_REGION})
            fs.ls(f"{S3_BUCKET}/{S3_PREFIX}/", detail=False)
            result["s3_alive"] = True
        except Exception as e:
            result["s3_alive"] = False
            result["s3_error"] = str(e)

    # 3. Pre-warm SEB directory listing for real-time TDR page
    #    (this populates _rt_dir_cache so the first /realtime/missions
    #    request is instant instead of waiting for SEB HTTP response)
    try:
        from realtime_tdr_api import _parse_directory, SEB_BASE
        _parse_directory(SEB_BASE + "/")
        result["seb_primed"] = True
    except Exception as e:
        result["seb_primed"] = False
        result["seb_error"] = str(e)

    return result


@app.get("/variables")
def list_variables():
    return [{"key": k, "display_name": v[0], "units": v[3]} for k, v in VARIABLES.items()]


@app.get("/levels")
def list_levels():
    return {"levels_km": [round(i * 0.5, 1) for i in range(37)]}


@app.get("/metadata")
def get_metadata(
    case_index: int = Query(..., ge=0),
    data_type:  str = Query("swath", description="'swath' or 'merge'"),
):
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    if case_index not in cache:
        raise HTTPException(status_code=404, detail=f"case_index {case_index} not found")
    return JSONResponse(cache[case_index])


@app.get("/metadata_all")
def get_metadata_all(
    data_type: str = Query("swath", description="'swath' or 'merge'"),
):
    """
    Return all enriched metadata as a JSON array.
    Includes fields added at startup (SHIPS shear, max earth-rel wind speed).
    The frontend uses this to populate filters that depend on Zarr-derived data.
    """
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    cases = sorted(cache.values(), key=lambda c: c.get("case_index", 0))
    return JSONResponse({"total_cases": len(cases), "cases": cases})


# ---------------------------------------------------------------------------
# Helper: matplotlib colormap → Plotly colorscale
# ---------------------------------------------------------------------------
def _cmap_to_plotly(cmap_name: str, n_steps: int = 64) -> list:
    """Convert a matplotlib colormap name to a Plotly-compatible colorscale list."""
    cmap = plt.get_cmap(cmap_name)
    return [
        [round(i / (n_steps - 1), 4),
         f"rgb({int(c[0]*255)},{int(c[1]*255)},{int(c[2]*255)})"]
        for i, c in enumerate(cmap(np.linspace(0, 1, n_steps)))
    ]


def _extract_2d_slice(ds, local_idx, variable_key, z_idx):
    """Extract a 2D (y, x) data slice for a variable at a given height index."""
    _, varname, _, _, _, _ = VARIABLES[variable_key]
    if variable_key in DERIVED_VARIABLES:
        u_name, v_name = DERIVED_VARIABLES[variable_key]
        u = ds[u_name].isel(num_cases=local_idx, height=z_idx).values
        v = ds[v_name].isel(num_cases=local_idx, height=z_idx).values
        return np.sqrt(u**2 + v**2), u_name
    else:
        da = ds[varname].isel(num_cases=local_idx, height=z_idx)
        return da.values, varname


def _clean_2d(data):
    """Convert 2D numpy array to JSON-safe nested list (NaN → None)."""
    return [[None if np.isnan(v) else round(float(v), 4) for v in row] for row in data]


def _compute_tilt_profile(ds, local_idx, data_type):
    """
    Extract the pre-computed vortex tilt profile from TC-RADAR.

    TC-RADAR stores tilt as vertical profiles (num_cases, height):
      - tc_eastward_tilt   : eastward displacement of vortex center from 2-km ref (km)
      - tc_northward_tilt  : northward displacement from 2-km ref (km)
      - tc_tilt_magnitude  : total tilt magnitude (km)
      - tc_tilt_direction  : tilt direction (degrees)
      - tc_rmw             : radius of maximum wind profile (km)

    Returns dict with x_km, y_km, height_km, tilt_magnitude_km, rmw_km arrays,
    or None if the required variables are not available.
    """
    # Check that the tilt variables exist in the dataset
    if "tc_eastward_tilt" not in ds or "tc_northward_tilt" not in ds:
        print("Tilt profile: tc_eastward_tilt / tc_northward_tilt not found in dataset")
        return None

    height_vals = ds["height"].values
    ref_z_idx = int(np.argmin(np.abs(height_vals - 2.0)))

    # Extract 1-D profiles for this case (height,)
    east_tilt = ds["tc_eastward_tilt"].isel(num_cases=local_idx).values
    north_tilt = ds["tc_northward_tilt"].isel(num_cases=local_idx).values

    # Tilt magnitude — read stored or compute from components
    if "tc_tilt_magnitude" in ds:
        tilt_mag_arr = ds["tc_tilt_magnitude"].isel(num_cases=local_idx).values
    else:
        tilt_mag_arr = np.sqrt(east_tilt**2 + north_tilt**2)

    # RMW profile (optional)
    rmw_arr = None
    if "tc_rmw" in ds:
        rmw_arr = ds["tc_rmw"].isel(num_cases=local_idx).values

    # Build output lists (NaN → None for JSON serialisation)
    centers_x = []
    centers_y = []
    tilt_mag = []
    heights = []
    rmw_profile = []

    for zi in range(len(height_vals)):
        h = round(float(height_vals[zi]), 1)
        heights.append(h)

        ex = float(east_tilt[zi]) if np.isfinite(east_tilt[zi]) else None
        ny_ = float(north_tilt[zi]) if np.isfinite(north_tilt[zi]) else None
        tm = float(tilt_mag_arr[zi]) if np.isfinite(tilt_mag_arr[zi]) else None

        centers_x.append(round(ex, 2) if ex is not None else None)
        centers_y.append(round(ny_, 2) if ny_ is not None else None)
        tilt_mag.append(round(tm, 2) if tm is not None else None)

        if rmw_arr is not None:
            rv = float(rmw_arr[zi]) if np.isfinite(rmw_arr[zi]) else None
            rmw_profile.append(round(rv, 1) if rv is not None else None)

    result = {
        "x_km": centers_x,
        "y_km": centers_y,
        "height_km": heights,
        "tilt_magnitude_km": tilt_mag,
        "ref_height_km": round(float(height_vals[ref_z_idx]), 1),
        "method": "stored",
    }
    if rmw_profile:
        result["rmw_km"] = rmw_profile

    return result


@app.get("/data")
def get_data(
    case_index: int   = Query(...,              ge=0,          description="0-based case index"),
    variable:   str   = Query(DEFAULT_VARIABLE,                description="Variable key — see /variables"),
    level_km:   float = Query(2.0,              ge=0.0, le=18, description="Altitude in km"),
    data_type:  str   = Query("swath",                         description="'swath' or 'merge'"),
    overlay:    str   = Query("",                              description="Optional overlay variable key"),
    wind_barbs: bool  = Query(False,                           description="Include subsampled U/V for wind barbs"),
    tilt_profile: bool = Query(False,                          description="Include vortex tilt profile (center at each height)"),
):
    """Return the raw 2D data slice as JSON for client-side Plotly rendering."""
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'. See /variables.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")
    if overlay and overlay not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'. See /variables.")

    # Serve from cache if available (instant — no S3 read or computation)
    cache_key = (case_index, variable, round(level_km, 1), data_type, overlay, wind_barbs, tilt_profile)
    if cache_key in _data_cache:
        _data_cache.move_to_end(cache_key)
        return JSONResponse(_data_cache[cache_key], headers={"X-Cache": "HIT"})

    try:
        ds, local_idx = resolve_case(case_index, data_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open dataset: {e}")

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    height_vals = ds["height"].values
    z_idx = int(np.argmin(np.abs(height_vals - level_km)))
    actual_level = float(height_vals[z_idx])

    # Primary variable
    data, ref_varname = _extract_2d_slice(ds, local_idx, variable, z_idx)

    # Determine spatial grid
    var_dims = set(ds[ref_varname].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        x = ds["eastward_distance"].values.tolist()
        y = ds["northward_distance"].values.tolist()
    elif "latitude" in var_dims and "longitude" in var_dims:
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x = np.linspace(-(nx - 1), (nx - 1), nx).tolist()
        y = np.linspace(-(ny - 1), (ny - 1), ny).tolist()
    else:
        x = list(range(data.shape[-1]))
        y = list(range(data.shape[-2]))

    case_meta = _build_case_meta(case_index, ds, local_idx, data_type)

    result = {
        "data": _clean_2d(data),
        "x": x,
        "y": y,
        "actual_level_km": actual_level,
        "variable": {
            "key": variable,
            "display_name": display_name,
            "units": units,
            "vmin": vmin,
            "vmax": vmax,
            "colorscale": _cmap_to_plotly(cmap),
        },
        "case_meta": case_meta,
    }

    # Optional overlay variable
    if overlay:
        ov_display, ov_varname, _, ov_units, ov_vmin, ov_vmax = VARIABLES[overlay]
        try:
            ov_data, _ = _extract_2d_slice(ds, local_idx, overlay, z_idx)
            result["overlay"] = {
                "data": _clean_2d(ov_data),
                "key": overlay,
                "display_name": ov_display,
                "units": ov_units,
                "vmin": ov_vmin,
                "vmax": ov_vmax,
            }
        except Exception:
            pass  # silently skip overlay if variable unavailable

    # Optional wind barbs: return subsampled U/V component arrays
    # If the variable is a wind speed type, use its matched U/V components;
    # otherwise fall back to storm-relative recentered winds.
    if wind_barbs:
        if variable in WIND_BARB_COMPONENTS:
            u_name, v_name = WIND_BARB_COMPONENTS[variable]
        else:
            # Default: use storm-relative recentered winds for any variable
            u_name, v_name = ("recentered_eastward_wind", "recentered_northward_wind")
        try:
            if u_name in ds and v_name in ds:
                u_full = ds[u_name].isel(num_cases=local_idx, height=z_idx).values
                v_full = ds[v_name].isel(num_cases=local_idx, height=z_idx).values
                # Subsample to ~20 barbs per axis
                ny, nx = u_full.shape
                stride = max(1, min(nx, ny) // 20)
                u_sub = u_full[::stride, ::stride]
                v_sub = v_full[::stride, ::stride]
                x_arr = np.array(x)
                y_arr = np.array(y)
                x_sub = x_arr[::stride].tolist()
                y_sub = y_arr[::stride].tolist()
                # Determine if earth-relative or storm-relative
                barb_type = "earth_relative" if "earth_relative" in variable else "storm_relative"
                result["wind_barbs"] = {
                    "u": _clean_2d(u_sub),
                    "v": _clean_2d(v_sub),
                    "x": x_sub,
                    "y": y_sub,
                    "units": "m/s",
                    "type": barb_type,
                }
        except Exception as e:
            print(f"Wind barb extraction failed for {variable}: {e}")
            pass  # silently skip if U/V components unavailable

    # Optional tilt profile: compute vortex center at each height level
    if tilt_profile:
        try:
            tilt_data = _compute_tilt_profile(ds, local_idx, data_type)
            if tilt_data:
                result["tilt_profile"] = tilt_data
        except Exception as e:
            print(f"Tilt profile extraction failed: {e}")

    # Store in cache
    _data_cache[cache_key] = result
    if len(_data_cache) > _DATA_CACHE_MAX:
        _data_cache.popitem(last=False)  # evict oldest entry
        gc.collect()

    return JSONResponse(result, headers={"X-Cache": "MISS"})


def _extract_cross_section(ds, local_idx, variable_key, x_coords, y_coords, xi_idx, yi_idx, h_axis, n_heights, n_points):
    """Extract a vertical cross-section for a variable along sample indices."""
    _, varname, _, _, _, _ = VARIABLES[variable_key]
    if variable_key in DERIVED_VARIABLES:
        u_name, v_name = DERIVED_VARIABLES[variable_key]
        u_3d = ds[u_name].isel(num_cases=local_idx).values
        v_3d = ds[v_name].isel(num_cases=local_idx).values
        vol = np.sqrt(u_3d**2 + v_3d**2)
    else:
        vol = ds[varname].isel(num_cases=local_idx).values

    cs = np.full((n_heights, n_points), np.nan)
    for h in range(n_heights):
        for p in range(n_points):
            if h_axis == 0:
                cs[h, p] = vol[h, yi_idx[p], xi_idx[p]]
            elif h_axis == 2:
                cs[h, p] = vol[yi_idx[p], xi_idx[p], h]
            else:
                cs[h, p] = vol[yi_idx[p], h, xi_idx[p]]
    return cs


@app.get("/cross_section")
def cross_section(
    case_index: int   = Query(...,              ge=0,          description="0-based case index"),
    variable:   str   = Query(DEFAULT_VARIABLE,                description="Variable key — see /variables"),
    data_type:  str   = Query("swath",                         description="'swath' or 'merge'"),
    x0:         float = Query(...,                             description="Start X (km)"),
    y0:         float = Query(...,                             description="Start Y (km)"),
    x1:         float = Query(...,                             description="End X (km)"),
    y1:         float = Query(...,                             description="End Y (km)"),
    n_points:   int   = Query(150,              ge=10, le=500, description="Sample points along line"),
    overlay:    str   = Query("",                              description="Optional overlay variable key"),
):
    """Return a vertical cross-section along a user-defined line."""
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'. See /variables.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")
    if overlay and overlay not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'.")

    try:
        ds, local_idx = resolve_case(case_index, data_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open dataset: {e}")

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    height_vals = ds["height"].values

    # Determine ref variable for grid detection
    if variable in DERIVED_VARIABLES:
        ref_varname = DERIVED_VARIABLES[variable][0]
    else:
        if varname not in ds:
            raise HTTPException(status_code=400, detail=f"'{varname}' not in dataset.")
        ref_varname = varname

    # Determine spatial grid
    var_dims = set(ds[ref_varname].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        x_coords = ds["eastward_distance"].values
        y_coords = ds["northward_distance"].values
    elif "latitude" in var_dims and "longitude" in var_dims:
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x_coords = np.linspace(-(nx - 1), (nx - 1), nx)
        y_coords = np.linspace(-(ny - 1), (ny - 1), ny)
    else:
        raise HTTPException(status_code=500, detail="Cannot determine spatial grid")

    # Determine height axis position
    dim_list = [d for d in ds[ref_varname].dims if d != "num_cases"]
    if "height" not in dim_list:
        raise HTTPException(status_code=500, detail="Cannot determine height axis")
    h_axis = dim_list.index("height")

    # Sample points along the line
    t = np.linspace(0, 1, n_points)
    xs = x0 + t * (x1 - x0)
    ys = y0 + t * (y1 - y0)
    dist = np.sqrt((xs - x0)**2 + (ys - y0)**2)

    xi_idx = np.array([int(np.argmin(np.abs(x_coords - xp))) for xp in xs])
    yi_idx = np.array([int(np.argmin(np.abs(y_coords - yp))) for yp in ys])

    n_heights = len(height_vals)

    # Primary cross-section
    cs = _extract_cross_section(ds, local_idx, variable, x_coords, y_coords, xi_idx, yi_idx, h_axis, n_heights, n_points)

    case_meta = _build_case_meta(case_index, ds, local_idx, data_type)

    result = {
        "cross_section": _clean_2d(cs),
        "distance_km": [round(float(d), 2) for d in dist],
        "height_km": [round(float(h), 2) for h in height_vals],
        "endpoints": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
        "variable": {
            "key": variable,
            "display_name": display_name,
            "units": units,
            "vmin": vmin,
            "vmax": vmax,
            "colorscale": _cmap_to_plotly(cmap),
        },
        "case_meta": case_meta,
    }

    # Optional overlay cross-section
    if overlay:
        ov_display, _, _, ov_units, ov_vmin, ov_vmax = VARIABLES[overlay]
        try:
            ov_cs = _extract_cross_section(ds, local_idx, overlay, x_coords, y_coords, xi_idx, yi_idx, h_axis, n_heights, n_points)
            result["overlay"] = {
                "cross_section": _clean_2d(ov_cs),
                "key": overlay,
                "display_name": ov_display,
                "units": ov_units,
                "vmin": ov_vmin,
                "vmax": ov_vmax,
            }
        except Exception:
            pass

    return JSONResponse(result)


@app.get("/volume")
def get_volume(
    case_index: int   = Query(...,              ge=0,          description="0-based case index"),
    variable:   str   = Query(DEFAULT_VARIABLE,                description="Variable key — see /variables"),
    data_type:  str   = Query("swath",                         description="'swath' or 'merge'"),
    stride:     int   = Query(2,                ge=1, le=5,    description="Spatial subsampling stride (2 = half res)"),
    max_height_km: float = Query(15.0,          ge=1, le=18,   description="Maximum height to include (km)"),
    compact:    bool  = Query(False,                            description="If true, send 1D axis vectors instead of flattened meshgrid"),
    tilt_profile: bool = Query(False,                           description="Include vortex tilt profile (center at each height)"),
):
    """
    Return the full 3D volume as flattened arrays for Plotly isosurface rendering.

    The grid is subsampled spatially by `stride` to reduce transfer size.
    NaN values are replaced with a sentinel (-9999) so the grid stays regular;
    the client should set isomin above this sentinel.

    compact=true mode sends 1D axis vectors (x_axis, y_axis, z_axis) instead
    of the full flattened meshgrid (x, y, z), reducing payload ~4× before gzip.
    The client reconstructs the meshgrid from axes + grid_shape.
    """
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'. See /variables.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    try:
        ds, local_idx = resolve_case(case_index, data_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open dataset: {e}")

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    height_vals = ds["height"].values

    # Cap height
    h_mask = height_vals <= max_height_km + 0.01
    height_sub = height_vals[h_mask]

    # Extract full 3D volume
    vol, ref_varname = _extract_3d_volume(ds, local_idx, variable)

    # Determine spatial grid and height axis position
    dim_list = [d for d in ds[ref_varname].dims if d != "num_cases"]
    if "height" not in dim_list:
        raise HTTPException(status_code=500, detail="Cannot determine height axis")
    h_axis = dim_list.index("height")

    var_dims = set(ds[ref_varname].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        x_full = ds["eastward_distance"].values
        y_full = ds["northward_distance"].values
    elif "latitude" in var_dims and "longitude" in var_dims:
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x_full = np.linspace(-(nx - 1), (nx - 1), nx)
        y_full = np.linspace(-(ny - 1), (ny - 1), ny)
    else:
        x_full = np.arange(vol.shape[-1], dtype=float)
        y_full = np.arange(vol.shape[-2], dtype=float)

    # Subsample spatial dimensions
    x_sub = x_full[::stride]
    y_sub = y_full[::stride]
    n_h = int(h_mask.sum())

    # Slice the volume: need to handle varying axis orders
    if h_axis == 0:
        vol_sub = vol[:n_h, ::stride, ::stride]
    elif h_axis == 2:
        vol_sub = vol[::stride, ::stride, :n_h]
    else:
        vol_sub = vol[::stride, :n_h, ::stride]

    # Reorder to (height, y, x) if needed
    if h_axis == 1:
        vol_sub = np.transpose(vol_sub, (1, 0, 2))  # (y, h, x) -> (h, y, x)
    elif h_axis == 2:
        vol_sub = np.transpose(vol_sub, (2, 0, 1))  # (y, x, h) -> (h, y, x)

    nz, ny, nx = vol_sub.shape
    v_flat = vol_sub.ravel()

    # Compute actual data range (excluding NaN)
    valid = v_flat[np.isfinite(v_flat)]
    data_min = float(np.nanmin(valid)) if len(valid) > 0 else vmin
    data_max = float(np.nanmax(valid)) if len(valid) > 0 else vmax

    # Replace NaN with sentinel for regular-grid isosurface
    SENTINEL = -9999.0
    v_flat = np.where(np.isfinite(v_flat), np.round(v_flat, 3), SENTINEL)

    case_meta = _build_case_meta(case_index, ds, local_idx, data_type)

    result = {
        "value": v_flat.tolist(),
        "sentinel": SENTINEL,
        "grid_shape": [nz, ny, nx],
        "variable": {
            "key": variable,
            "display_name": display_name,
            "units": units,
            "vmin": vmin,
            "vmax": vmax,
            "data_min": round(data_min, 3),
            "data_max": round(data_max, 3),
            "colorscale": _cmap_to_plotly(cmap),
        },
        "case_meta": case_meta,
    }

    if compact:
        # Compact mode: send 1D axis vectors (~232 values total)
        # Client reconstructs meshgrid from axes + grid_shape
        result["x_axis"] = np.round(x_sub, 2).tolist()
        result["y_axis"] = np.round(y_sub, 2).tolist()
        result["z_axis"] = np.round(height_sub, 2).tolist()
    else:
        # Legacy mode: send full flattened meshgrid (~918K values)
        Z, Y, X = np.meshgrid(height_sub, y_sub, x_sub, indexing='ij')
        result["x"] = np.round(X.ravel(), 2).tolist()
        result["y"] = np.round(Y.ravel(), 2).tolist()
        result["z"] = np.round(Z.ravel(), 2).tolist()

    # Optional vortex tilt profile
    if tilt_profile:
        try:
            tilt_data = _compute_tilt_profile(ds, local_idx, data_type)
            if tilt_data:
                result["tilt_profile"] = tilt_data
        except Exception:
            pass

    return JSONResponse(result)


def _extract_3d_volume(ds, local_idx, variable_key):
    """Extract the full 3D volume (height × y × x) for a variable."""
    _, varname, _, _, _, _ = VARIABLES[variable_key]
    if variable_key in DERIVED_VARIABLES:
        u_name, v_name = DERIVED_VARIABLES[variable_key]
        u_3d = ds[u_name].isel(num_cases=local_idx).values
        v_3d = ds[v_name].isel(num_cases=local_idx).values
        return np.sqrt(u_3d**2 + v_3d**2), u_name
    else:
        vol = ds[varname].isel(num_cases=local_idx).values
        return vol, varname


def _get_ships_value(ds, local_idx, varname):
    """
    Look up a SHIPS variable at t=0 h.

    SHIPS lag-hour axis has 17 entries: -48, -42, -36, …, 0, …, +42, +48 h.
    t=0 is index 8 (0-based).
    Returns float or None if unavailable / missing (9999).
    """
    SHIPS_T0_IDX = 8
    if varname not in ds:
        return None
    try:
        raw = ds[varname].isel(num_cases=local_idx).values
        val = float(raw[SHIPS_T0_IDX]) if raw.ndim >= 1 else float(raw)
    except Exception:
        return None
    if val == 9999 or np.isnan(val):
        return None
    return round(val, 1)


def _get_sddc(ds, local_idx):
    """SDDC: deep-layer shear heading (deg, met convention)."""
    return _get_ships_value(ds, local_idx, "sddc_ships")


def _get_shdc(ds, local_idx):
    """SHDC: deep-layer shear magnitude (kt)."""
    return _get_ships_value(ds, local_idx, "shdc_ships")


def _get_storm_motion(ds, local_idx):
    """
    Extract TC motion direction (met heading, deg) and speed (kt) from the dataset.

    Tries (in order):
      1. Per-case variables storm_u_ms / storm_v_ms (U/V in m/s)
      2. SHIPS storm speed/heading variables (spd_ships / dir_ships at t=0)
      3. Global attrs (single-case files)
      4. Difference between earth-relative and storm-relative wind at 2 km

    Returns (direction, speed) as meteorological heading (0=N, 90=E) and knots,
    or (None, None) if unavailable.
    """
    storm_u, storm_v = None, None

    # ── Method 1: per-case U/V variables (m/s) ──────────────────
    for u_key in ("storm_u_ms", "storm_motion_east_ms"):
        if u_key in ds:
            try:
                val = float(ds[u_key].isel(num_cases=local_idx).values)
                if val != -999 and val != 9999 and not np.isnan(val):
                    storm_u = val
                    break
            except Exception:
                pass
    for v_key in ("storm_v_ms", "storm_motion_north_ms"):
        if v_key in ds:
            try:
                val = float(ds[v_key].isel(num_cases=local_idx).values)
                if val != -999 and val != 9999 and not np.isnan(val):
                    storm_v = val
                    break
            except Exception:
                pass
    if storm_u is not None and storm_v is not None:
        spd_ms = np.sqrt(storm_u**2 + storm_v**2)
        spd_kt = round(float(spd_ms * 1.94384), 1)
        math_angle = np.degrees(np.arctan2(storm_v, storm_u))
        met_heading = (90.0 - math_angle) % 360.0
        return round(float(met_heading), 0), spd_kt

    # ── Method 2: SHIPS storm speed & heading at t=0 ────────────
    spd_ships = _get_ships_value(ds, local_idx, "spd_ships")
    dir_ships = _get_ships_value(ds, local_idx, "dir_ships")
    if spd_ships is not None and dir_ships is not None and spd_ships > 0:
        return round(float(dir_ships), 0), round(float(spd_ships), 1)

    # ── Method 3: global attrs (single-case files) ──────────────
    if hasattr(ds, "attrs"):
        try:
            su = float(ds.attrs.get("EASTWARD STORM MOTION (METERS PER SECOND)",
                       ds.attrs.get("storm_motion_east_ms", -999)))
            sv = float(ds.attrs.get("NORTHWARD STORM MOTION (METERS PER SECOND)",
                       ds.attrs.get("storm_motion_north_ms", -999)))
            if su != -999 and sv != -999 and not np.isnan(su) and not np.isnan(sv):
                spd_ms = np.sqrt(su**2 + sv**2)
                spd_kt = round(float(spd_ms * 1.94384), 1)
                math_angle = np.degrees(np.arctan2(sv, su))
                met_heading = (90.0 - math_angle) % 360.0
                return round(float(met_heading), 0), spd_kt
        except Exception:
            pass

    # ── Method 4: derive from earth-relative minus storm-relative wind ──
    # The archive stores both wind frames; their difference is the storm
    # motion vector.  Sample a single valid grid point at 2 km to extract it.
    try:
        er_u_name = sr_u_name = er_v_name = sr_v_name = None
        for _eu, _su in [("recentered_earth_relative_eastward_wind", "recentered_eastward_wind")]:
            if _eu in ds and _su in ds:
                er_u_name, sr_u_name = _eu, _su
                break
        for _ev, _sv in [("recentered_earth_relative_northward_wind", "recentered_northward_wind")]:
            if _ev in ds and _sv in ds:
                er_v_name, sr_v_name = _ev, _sv
                break
        if er_u_name and sr_u_name and er_v_name and sr_v_name:
            height_vals = ds["height"].values
            z_idx = int(np.argmin(np.abs(height_vals - 2.0)))
            er_u = ds[er_u_name].isel(num_cases=local_idx, height=z_idx).values
            sr_u = ds[sr_u_name].isel(num_cases=local_idx, height=z_idx).values
            er_v = ds[er_v_name].isel(num_cases=local_idx, height=z_idx).values
            sr_v = ds[sr_v_name].isel(num_cases=local_idx, height=z_idx).values
            # Storm motion = earth-relative − storm-relative (constant across grid)
            diff_u = er_u - sr_u
            diff_v = er_v - sr_v
            # Use median of valid points (should all be identical, but median is robust)
            valid = np.isfinite(diff_u) & np.isfinite(diff_v)
            if np.count_nonzero(valid) > 10:
                su = float(np.median(diff_u[valid]))
                sv = float(np.median(diff_v[valid]))
                spd_ms = np.sqrt(su**2 + sv**2)
                if spd_ms > 0.1:  # sanity check: at least ~0.2 kt
                    spd_kt = round(float(spd_ms * 1.94384), 1)
                    math_angle = np.degrees(np.arctan2(sv, su))
                    met_heading = (90.0 - math_angle) % 360.0
                    return round(float(met_heading), 0), spd_kt
    except Exception:
        pass

    return None, None


def _get_ships_value_at_lag(ds, local_idx, varname, lag_idx):
    """
    Look up a SHIPS variable at an arbitrary lag-hour index.

    The SHIPS lag-hour axis has 17 entries: -48, -42, -36, …, 0, …, +42, +48 h.
    Index 8 = t=0, Index 10 = t=+12 h, Index 12 = t=+24 h.
    """
    if varname not in ds:
        return None
    try:
        raw = ds[varname].isel(num_cases=local_idx).values
        val = float(raw[lag_idx]) if raw.ndim >= 1 else float(raw)
    except Exception:
        return None
    if val == 9999 or np.isnan(val):
        return None
    return round(val, 1)


def _enrich_metadata_with_ships_extended(ds, data_type, era):
    """
    Enrich metadata with extended SHIPS variables for anomaly diagnostics:
    - vmpi: maximum potential intensity (kt)
    - rhlo: 850-700 hPa mean relative humidity (%)
    - shgc: generalized vertical wind shear (kt)
    - vp: ventilation proxy = shgc * (100 - rhlo) / vmpi
    - dvmax_12h: 12-hour future intensity change from SHIPS best-track Vmax
    - dvmax_24h: 24-hour future intensity change from SHIPS best-track Vmax

    Runs at startup alongside the standard SHIPS enrichment.
    """
    SHIPS_T0_IDX = 8
    SHIPS_T12_IDX = 10   # t = +12 h
    SHIPS_T24_IDX = 12   # t = +24 h

    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    early_count = CASE_COUNTS[(data_type, "early")]
    offset = 0 if era == "early" else early_count
    n_cases = ds.sizes.get("num_cases", 0)

    # Check availability of key SHIPS variables
    has_vmpi = "mpi_ships" in ds
    has_rhlo = "rhlo_ships" in ds
    has_shgc = "shgc_ships" in ds
    has_vmax = "vmax_ships" in ds  # best-track Vmax in SHIPS lag-hour format
    has_dtl  = "dtl_ships" in ds   # distance to land (km)

    avail = []
    if has_vmpi: avail.append("vmpi")
    if has_rhlo: avail.append("rhlo")
    if has_shgc: avail.append("shgc")
    if has_vmax: avail.append("vmax")
    if has_dtl:  avail.append("dtl")
    print(f"  Extended SHIPS vars available ({data_type}/{era}): {avail or 'NONE'}")

    enriched = 0
    for local_idx in range(n_cases):
        case_index = local_idx + offset
        if case_index not in cache:
            continue

        # VP components
        vmpi = _get_ships_value(ds, local_idx, "mpi_ships") if has_vmpi else None
        rhlo = _get_ships_value(ds, local_idx, "rhlo_ships") if has_rhlo else None
        shgc = _get_ships_value(ds, local_idx, "shgc_ships") if has_shgc else None

        if vmpi is not None:
            cache[case_index]["vmpi"] = vmpi
        if rhlo is not None:
            cache[case_index]["rhlo"] = rhlo
        if shgc is not None:
            cache[case_index]["shgc"] = shgc

        # Compute ventilation proxy
        if vmpi and rhlo is not None and shgc is not None and vmpi > 0:
            vp = round(shgc * (100.0 - rhlo) / vmpi, 2)
            cache[case_index]["vp"] = vp

        # Intensity change from SHIPS best-track Vmax
        if has_vmax:
            vmax_t0 = _get_ships_value_at_lag(ds, local_idx, "vmax_ships", SHIPS_T0_IDX)
            vmax_t12 = _get_ships_value_at_lag(ds, local_idx, "vmax_ships", SHIPS_T12_IDX)
            vmax_t24 = _get_ships_value_at_lag(ds, local_idx, "vmax_ships", SHIPS_T24_IDX)
            if vmax_t0 is not None and vmax_t12 is not None:
                cache[case_index]["dvmax_12h"] = round(vmax_t12 - vmax_t0, 1)
            if vmax_t0 is not None and vmax_t24 is not None:
                cache[case_index]["dvmax_24h"] = round(vmax_t24 - vmax_t0, 1)

        # Minimum distance-to-land over 0–12 h and 0–24 h forecast windows
        # Used to filter land-interacting cases from ellipse computations
        if has_dtl:
            # t=0 → idx 8, t=+6h → 9, t=+12h → 10, t=+18h → 11, t=+24h → 12
            dtl_vals_12 = [_get_ships_value_at_lag(ds, local_idx, "dtl_ships", i)
                           for i in range(SHIPS_T0_IDX, SHIPS_T12_IDX + 1)]
            dtl_vals_24 = [_get_ships_value_at_lag(ds, local_idx, "dtl_ships", i)
                           for i in range(SHIPS_T0_IDX, SHIPS_T24_IDX + 1)]
            valid_12 = [v for v in dtl_vals_12 if v is not None]
            valid_24 = [v for v in dtl_vals_24 if v is not None]
            if valid_12:
                cache[case_index]["dtl_min_12h"] = round(min(valid_12), 1)
            if valid_24:
                cache[case_index]["dtl_min_24h"] = round(min(valid_24), 1)

        enriched += 1

    print(f"  Extended SHIPS enrichment: {enriched} cases ({data_type}/{era})")


def _enrich_metadata_with_vortex_metrics(ds, era):
    """
    Pass 1 of the two-pass vortex-metric computation (Fischer et al. 2025,
    MWR, Table 1).  Computes raw (un-centred) metrics for every merged case
    and stores them in the global _vortex_raw dict.

    When both merge eras have finished pass 1, _finalize_vortex_metrics()
    is called automatically to compute a *single* database mean across ALL
    cases and subtract it — producing zero-centred vortex_height,
    vortex_width, and vortex_favorability in _merge_metadata_cache.
    """
    global _vortex_eras_done

    early_count = CASE_COUNTS[("merge", "early")]
    offset = 0 if era == "early" else early_count
    n_cases = ds.sizes.get("num_cases", 0)

    local_raw = {}
    skipped = 0

    for local_idx in range(n_cases):
        case_index = local_idx + offset
        if case_index not in _merge_metadata_cache:
            continue
        try:
            raw = _compute_vortex_metrics_for_case(case_index, ds, local_idx, "merge")
            if raw:
                local_raw[case_index] = raw
            else:
                skipped += 1
        except Exception as e:
            skipped += 1
            if local_idx < 3:
                print(f"  Vortex metrics warning case {case_index}: {e}")

    print(f"  Vortex pass-1: {len(local_raw)} raw metrics, "
          f"{skipped} skipped (merge/{era})")

    # Merge into the global staging dict and check if both eras are done
    with _vortex_lock:
        _vortex_raw.update(local_raw)
        _vortex_eras_done += 1
        if _vortex_eras_done >= 2:
            _finalize_vortex_metrics()


def _finalize_vortex_metrics():
    """
    Pass 2: compute a single database mean across ALL cases (both eras)
    and subtract it from each case's raw metrics to produce zero-centred
    vortex_height, vortex_width, and vortex_favorability.

    Called automatically once both merge eras have completed pass 1.
    Must be called while holding _vortex_lock.
    """
    if not _vortex_raw:
        print("  Vortex finalize: no raw metrics to process")
        return

    all_h1 = [r["raw_h1_max"] for r in _vortex_raw.values()]
    all_wd = [r["raw_width_diff"] for r in _vortex_raw.values()]
    global _vortex_db_means
    db_mean_h1 = float(np.nanmean(all_h1))
    db_mean_wd = float(np.nanmean(all_wd))
    _vortex_db_means = {"h1": db_mean_h1, "wd": db_mean_wd}

    computed = 0
    for case_index, raw in _vortex_raw.items():
        vh = raw["raw_h1_max"] - db_mean_h1
        vw = raw["raw_width_diff"] - db_mean_wd
        _merge_metadata_cache[case_index].update({
            "vortex_height": round(vh, 3),
            "vortex_width": round(vw, 3),
            "vortex_favorability": round(vh - vw, 3),
        })
        computed += 1

    print(f"  Vortex finalize: global DB means height={db_mean_h1:.4f}, "
          f"width_diff={db_mean_wd:.4f} (n={len(_vortex_raw)})")
    print(f"  Vortex finalize: {computed} cases centred")


# ---------------------------------------------------------------------------
# IR satellite imagery – server-side PNG rendering
# ---------------------------------------------------------------------------

# Build a 256-entry RGBA lookup table matching the JS IR colormap.
# The colormap maps normalized (1 - (Tb-vmin)/(vmax-vmin)) to RGB.
def _build_ir_lut():
    """Create a 256-entry uint8 RGBA LUT for IR brightness temperatures."""
    stops = [
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
    lut = np.zeros((256, 4), dtype=np.uint8)
    for i in range(256):
        frac = i / 255.0
        # Find bounding stops
        lo, hi = stops[0], stops[-1]
        for s in range(len(stops) - 1):
            if frac >= stops[s][0] and frac <= stops[s + 1][0]:
                lo, hi = stops[s], stops[s + 1]
                break
        t = 0.0 if hi[0] == lo[0] else (frac - lo[0]) / (hi[0] - lo[0])
        lut[i, 0] = int(lo[1] + t * (hi[1] - lo[1]) + 0.5)
        lut[i, 1] = int(lo[2] + t * (hi[2] - lo[2]) + 0.5)
        lut[i, 2] = int(lo[3] + t * (hi[3] - lo[3]) + 0.5)
        lut[i, 3] = 220  # alpha
    return lut

_IR_LUT = _build_ir_lut()


def _render_ir_png(frame_2d, vmin=190.0, vmax=310.0):
    """
    Render a 2D Tb array to a base64-encoded PNG string.
    Returns a data-URL ready for use as an image src.
    """
    from PIL import Image

    arr = np.asarray(frame_2d, dtype=np.float32)
    # Normalize: cold clouds (low Tb) → high index → bright colors
    frac = 1.0 - (arr - vmin) / (vmax - vmin)
    frac = np.clip(frac, 0.0, 1.0)
    indices = (frac * 255).astype(np.uint8)

    # Apply LUT
    rgba = _IR_LUT[indices]  # shape (H, W, 4)

    # Set NaN / invalid pixels to transparent
    mask = ~np.isfinite(arr) | (arr <= 0)
    rgba[mask] = [0, 0, 0, 0]

    # Flip vertically (lat ascending → image top-to-bottom)
    rgba = rgba[::-1]

    # Encode as PNG (level=1: 4× faster, ~same size as optimize)
    img = Image.fromarray(rgba, 'RGBA')
    buf = io.BytesIO()
    img.save(buf, format='PNG', compress_level=1)
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    return f"data:image/png;base64,{b64}"


@app.get("/ir")
def get_ir(
    case_index: int = Query(..., ge=0),
    data_type:  str = Query("swath", description="'swath' or 'merge'"),
):
    """
    Return IR metadata and the t=0 frame (most recent) for instant display.
    The client then calls /ir_frame for each additional lag index to progressively
    """
    ir_store = get_ir_dataset()
    if ir_store is None:
        raise HTTPException(status_code=503, detail="IR data not available (S3 not configured)")

    # The IR zarr is indexed by swath case (0–1509).  When the caller is
    # in merge mode, translate the merge case_index to the corresponding
    # swath index so we pull the correct storm's IR data.
    ir_idx = case_index
    if data_type == "merge":
        ir_idx = _merge_to_swath_index.get(case_index)
        if ir_idx is None:
            raise HTTPException(status_code=404, detail=f"No swath mapping for merge case {case_index}")

    # Check status
    try:
        status = int(ir_store['status'][ir_idx])
    except (IndexError, KeyError):
        raise HTTPException(status_code=404, detail=f"Case {ir_idx} not found in IR store")

    if status != 1:
        raise HTTPException(status_code=404, detail=f"No IR data for case {ir_idx}")

    # Read metadata
    import numpy as np
    center_lat = float(ir_store['center_lat'][ir_idx])
    center_lon = float(ir_store['center_lon'][ir_idx])
    lat_offsets = ir_store['lat_offsets'][:].tolist()
    lon_offsets = ir_store['lon_offsets'][:].tolist()
    lag_hours = ir_store['lag_hours'][:].tolist()

    # Render ONLY the t=0 frame (index 0) for instant display
    tb_frame0 = ir_store['Tb'][ir_idx, 0]  # shape: (n_lat, n_lon)
    if np.all(np.isnan(tb_frame0)):
        frame0_png = None
    else:
        frame0_png = _render_ir_png(tb_frame0, vmin=190.0, vmax=310.0)

    # Read IR datetimes
    ir_dt_raw = ir_store['ir_datetime'][ir_idx]  # epoch minutes
    ir_datetimes = []
    for val in ir_dt_raw:
        val = int(val)
        if val > 0:
            dt = datetime.utcfromtimestamp(val * 60)
            ir_datetimes.append(dt.strftime('%Y-%m-%d %H:%M UTC'))
        else:
            ir_datetimes.append(None)

    return {
        "case_index": case_index,
        "center_lat": center_lat,
        "center_lon": center_lon,
        "lat_offsets": lat_offsets,
        "lon_offsets": lon_offsets,
        "lag_hours": lag_hours,
        "ir_datetimes": ir_datetimes,
        "n_frames": len(lag_hours),
        "frame0": frame0_png,
        "units": "K",
    }


@app.get("/ir_frame")
def get_ir_frame(
    case_index: int = Query(..., ge=0),
    lag_index:  int = Query(..., ge=0),
    data_type:  str = Query("swath", description="'swath' or 'merge'"),
):
    """
    Return a single server-rendered IR PNG frame.
    Called progressively by the client to build up the animation.
    """
    ir_store = get_ir_dataset()
    if ir_store is None:
        raise HTTPException(status_code=503, detail="IR data not available (S3 not configured)")

    # Translate merge index → swath index (IR zarr is swath-indexed)
    ir_idx = case_index
    if data_type == "merge":
        ir_idx = _merge_to_swath_index.get(case_index)
        if ir_idx is None:
            raise HTTPException(status_code=404, detail=f"No swath mapping for merge case {case_index}")

    try:
        status = int(ir_store['status'][ir_idx])
    except (IndexError, KeyError):
        raise HTTPException(status_code=404, detail=f"Case {ir_idx} not found in IR store")

    if status != 1:
        raise HTTPException(status_code=404, detail=f"No IR data for case {ir_idx}")

    import numpy as np
    n_lags = ir_store['Tb'].shape[1]
    if lag_index >= n_lags:
        raise HTTPException(status_code=404, detail=f"lag_index {lag_index} out of range (max {n_lags-1})")

    frame = ir_store['Tb'][ir_idx, lag_index]
    if np.all(np.isnan(frame)):
        png = None
    else:
        png = _render_ir_png(frame, vmin=190.0, vmax=310.0)

    return {
        "case_index": case_index,
        "lag_index": lag_index,
        "frame": png,
    }



# ---------------------------------------------------------------------------
# ERA5 environmental diagnostics endpoint
# ---------------------------------------------------------------------------
@app.get("/era5")
def get_era5(
    case_index: int = Query(..., ge=0),
    field: str = Query("shear_mag"),
    include_profiles: bool = Query(True),
    radius_km: float = Query(0, ge=0, le=1200, description="Crop radius in km (0=full domain)"),
    data_type: str = Query("swath", description="'swath' or 'merge'"),
):
    """
    Return ERA5 environmental diagnostics for a TC-RADAR case.

    Parameters
    ----------
    case_index : int
    field : str - 2D field to return (shear_mag, rh_mid, div200)
    include_profiles : bool - include vertical profiles & hodograph data
    radius_km : float - crop to this radius from TC center (0=full 20° domain)
    data_type : str - 'swath' or 'merge'
    """
    era5 = get_era5_dataset()
    if era5 is None:
        raise HTTPException(status_code=503, detail="ERA5 data not available")

    # ERA5 zarr is indexed by swath case (0–1509).  Translate merge indices.
    era5_idx = case_index
    if data_type == "merge":
        era5_idx = _merge_to_swath_index.get(case_index)
        if era5_idx is None:
            raise HTTPException(status_code=404, detail=f"No swath mapping for merge case {case_index}")

    try:
        status = int(era5['status'][era5_idx])
    except (IndexError, KeyError):
        raise HTTPException(status_code=404, detail=f"Case {era5_idx} not in ERA5 store")
    if status != 1:
        raise HTTPException(status_code=404, detail=f"No ERA5 data for case {era5_idx}")

    if field not in ERA5_FIELD_CONFIG:
        raise HTTPException(status_code=400, detail=f"Unknown field: {field}. Valid: {list(ERA5_FIELD_CONFIG.keys())}")

    cfg = ERA5_FIELD_CONFIG[field]

    # Read full 2D field and coordinate offsets
    data_2d = era5[field][era5_idx]  # (81, 81)
    lat_offsets = era5['lat_offsets'][:]
    lon_offsets = era5['lon_offsets'][:]

    # Crop to radius_km if specified
    if radius_km > 0:
        center_lat = float(era5['center_lat'][era5_idx])
        crop_deg = radius_km / 111.0  # approximate degrees
        lat_mask = np.abs(lat_offsets) <= crop_deg
        lon_mask = np.abs(lon_offsets) <= crop_deg
        data_2d = data_2d[np.ix_(lat_mask, lon_mask)]
        lat_offsets = lat_offsets[lat_mask]
        lon_offsets = lon_offsets[lon_mask]

    field_list = []
    for row in data_2d:
        field_list.append([
            None if (np.isnan(v)) else round(float(v), 4)
            for v in row
        ])

    result = {
        "case_index": case_index,
        "field": field,
        "field_config": cfg,
        "data": field_list,
        "center_lat": float(era5['center_lat'][era5_idx]),
        "center_lon": float(era5['center_lon'][era5_idx]),
        "lat_offsets": lat_offsets.tolist(),
        "lon_offsets": lon_offsets.tolist(),
    }

    # Add vector components if field has them (subsampled for readability)
    if cfg.get("has_vectors"):
        u_full = era5[cfg["vector_u"]][era5_idx]
        v_full = era5[cfg["vector_v"]][era5_idx]
        if radius_km > 0:
            u_full = u_full[np.ix_(lat_mask, lon_mask)]
            v_full = v_full[np.ix_(lat_mask, lon_mask)]
        # Stride: aim for ~10-15 arrows per axis
        n_pts = len(lat_offsets)
        stride = max(1, n_pts // 12)
        u_sub = u_full[::stride, ::stride]
        v_sub = v_full[::stride, ::stride]
        result["vectors"] = {
            "u": [[round(float(v), 2) if not np.isnan(v) else None for v in row] for row in u_sub],
            "v": [[round(float(v), 2) if not np.isnan(v) else None for v in row] for row in v_sub],
            "stride": stride,
        }

    # Scalar diagnostics
    # Scalar diagnostics — include all available fields
    result["scalars"] = {}
    for sname in ['shear_mag_env', 'shear_dir_env', 'rh_mid_env', 'div200_env',
                   'sst_env', 'chi_m', 'v_pi', 'vent_index']:
        try:
            val = float(era5[sname][era5_idx])
            if np.isnan(val):
                result["scalars"][sname] = None
            elif 'div' in sname:
                result["scalars"][sname] = round(val, 4)
            elif sname == 'vent_index':
                result["scalars"][sname] = round(val, 3)
            elif sname == 'chi_m':
                result["scalars"][sname] = round(val, 2)
            else:
                result["scalars"][sname] = round(val, 1)
        except Exception:
            result["scalars"][sname] = None

    # Vertical profiles (200-600 km annulus mean) with derived thermodynamics
    if include_profiles:
        try:
            plev = era5['plev'][:].astype(float)           # hPa
            t_arr = era5['t_profile'][era5_idx].astype(float)   # K
            q_arr = era5['q_profile'][era5_idx].astype(float)   # g/kg from Zarr

            # Convert q from g/kg to kg/kg if stored as g/kg
            q_kgkg = q_arr / 1000.0 if np.nanmax(q_arr) > 0.5 else q_arr

            # Potential temperature: θ = T * (1000/p)^(Rd/Cp)
            Rd_Cp = 287.04 / 1005.7
            theta = t_arr * (1000.0 / plev) ** Rd_Cp

            # Equivalent potential temperature (Bolton 1980):
            # θe = θ_d * exp(Lv * r_s / (Cp_d * T_LCL))
            # Simplified: θe ≈ T * (1000/p)^0.2854*(1-0.28*q) * exp((3036/T_LCL - 1.78)*q*(1+0.448*q))
            # Using the more standard approximation:
            # θe = θ * exp(Lv * q / (Cpd * T))
            Lv = 2.501e6  # J/kg
            Cpd = 1005.7  # J/kg/K
            theta_e = theta * np.exp(Lv * q_kgkg / (Cpd * t_arr))

            result["profiles"] = {
                "plev": plev.tolist(),
                "u": [round(float(v), 2) if not np.isnan(v) else None for v in era5['u_profile'][era5_idx]],
                "v": [round(float(v), 2) if not np.isnan(v) else None for v in era5['v_profile'][era5_idx]],
                "rh": [round(float(v), 1) if not np.isnan(v) else None for v in era5['rh_profile'][era5_idx]],
                "t": [round(float(v), 2) if not np.isnan(v) else None for v in t_arr],
                "theta": [round(float(v), 1) if not np.isnan(v) else None for v in theta],
                "theta_e": [round(float(v), 1) if not np.isnan(v) else None for v in theta_e],
                "q": [round(float(v), 6) if not np.isnan(v) else None for v in q_arr],
            }
        except Exception:
            result["profiles"] = None

    # Report whether 3D fields are available (so frontend can enable/disable radius slider)
    _3d_t_names = ['t_3d', 'temperature_3d', 't3d', 'temperature', 'temp_3d']
    _3d_q_names = ['q_3d', 'specific_humidity_3d', 'q3d', 'specific_humidity', 'shum_3d']
    result["has_3d"] = any(k in era5 for k in _3d_t_names) and any(k in era5 for k in _3d_q_names)

    return result


# ---------------------------------------------------------------------------
# ERA5 scalar recomputation at user-specified annuli
# ---------------------------------------------------------------------------
@app.get("/era5_scalars")
def get_era5_scalars(
    case_index: int = Query(..., ge=0),
    inner_km: float = Query(200, ge=0, le=1000, description="Inner annulus radius (km)"),
    outer_km: float = Query(800, ge=50, le=1200, description="Outer annulus radius (km)"),
    data_type: str = Query("swath", description="'swath' or 'merge'"),
):
    """
    Recompute area-mean scalar diagnostics from the gridded ERA5 2D fields
    at a user-specified annulus.

    This allows users to explore sensitivity of environmental diagnostics
    to the averaging domain without requiring Zarr-level precomputation.
    """
    era5 = get_era5_dataset()
    if era5 is None:
        raise HTTPException(status_code=503, detail="ERA5 data not available")

    # ERA5 zarr is indexed by swath case.  Translate merge indices.
    era5_idx = case_index
    if data_type == "merge":
        era5_idx = _merge_to_swath_index.get(case_index)
        if era5_idx is None:
            raise HTTPException(status_code=404, detail=f"No swath mapping for merge case {case_index}")

    try:
        status = int(era5['status'][era5_idx])
    except (IndexError, KeyError):
        raise HTTPException(status_code=404, detail=f"Case {case_index} not in ERA5 store")
    if status != 1:
        raise HTTPException(status_code=404, detail=f"No ERA5 data for case {case_index}")

    center_lat = float(era5['center_lat'][era5_idx])
    lat_offsets = era5['lat_offsets'][:]
    lon_offsets = era5['lon_offsets'][:]
    cos_lat = np.cos(np.deg2rad(center_lat))

    # Build distance grid (km)
    dlon_grid, dlat_grid = np.meshgrid(lon_offsets, lat_offsets)
    dist_km = np.sqrt((dlat_grid * 111.0)**2 + (dlon_grid * 111.0 * cos_lat)**2)
    mask = (dist_km >= inner_km) & (dist_km <= outer_km)

    if mask.sum() < 4:
        raise HTTPException(status_code=400,
                            detail=f"Annulus {inner_km}-{outer_km} km contains too few grid points")

    result = {
        "case_index": case_index,
        "inner_km": inner_km,
        "outer_km": outer_km,
        "n_points": int(mask.sum()),
    }

    # Recompute shear from vector components
    try:
        shear_u = era5['shear_u'][era5_idx]
        shear_v = era5['shear_v'][era5_idx]
        su = float(np.nanmean(shear_u[mask]))
        sv = float(np.nanmean(shear_v[mask]))
        result["shear_mag_env"] = round(float(np.sqrt(su**2 + sv**2)), 1)
        shear_dir_math = np.degrees(np.arctan2(sv, su))
        result["shear_dir_env"] = round(float((270 - shear_dir_math) % 360), 0)
    except Exception:
        result["shear_mag_env"] = None
        result["shear_dir_env"] = None

    # Recompute RH mid
    try:
        rh_mid = era5['rh_mid'][era5_idx]
        result["rh_mid_env"] = round(float(np.nanmean(rh_mid[mask])), 0)
    except Exception:
        result["rh_mid_env"] = None

    # Recompute divergence
    try:
        div200 = era5['div200'][era5_idx]
        result["div200_env"] = round(float(np.nanmean(div200[mask])), 4)
    except Exception:
        result["div200_env"] = None

    # Recompute SST
    try:
        sst = era5['sst'][era5_idx]
        result["sst_env"] = round(float(np.nanmean(sst[mask])), 1)
    except Exception:
        result["sst_env"] = None

    # PI, chi_m, and vent_index are precomputed and not recomputable
    # from 2D grids alone (require vertical profiles), so return stored values
    for sname in ['chi_m', 'v_pi', 'vent_index']:
        try:
            val = float(era5[sname][era5_idx])
            result[sname] = round(val, 3) if not np.isnan(val) else None
        except Exception:
            result[sname] = None

    return result


# ---------------------------------------------------------------------------
# ERA5 sounding at user-specified averaging radius (for Skew-T)
# ---------------------------------------------------------------------------
@app.get("/era5_sounding")
def get_era5_sounding(
    case_index: int = Query(..., ge=0),
    radius_km: float = Query(200, ge=50, le=800, description="Averaging radius (km) for sounding"),
    data_type: str = Query("swath", description="'swath' or 'merge'"),
):
    """
    Return ERA5 vertical profiles for Skew-T rendering.

    If 3D ERA5 fields are available in the Zarr store, profiles are recomputed
    as disc-averages within the specified radius.  Otherwise falls back to the
    precomputed 200-600 km annulus profiles.

    Parameters
    ----------
    case_index : int
    radius_km  : float  - disc radius for azimuthal averaging (km)
    data_type  : str    - 'swath' or 'merge'
    """
    era5 = get_era5_dataset()
    if era5 is None:
        raise HTTPException(status_code=503, detail="ERA5 data not available")

    # ERA5 zarr is indexed by swath case.  Translate merge indices.
    era5_idx = case_index
    if data_type == "merge":
        era5_idx = _merge_to_swath_index.get(case_index)
        if era5_idx is None:
            raise HTTPException(status_code=404, detail=f"No swath mapping for merge case {case_index}")

    try:
        status = int(era5['status'][era5_idx])
    except (IndexError, KeyError):
        raise HTTPException(status_code=404, detail=f"Case {case_index} not in ERA5 store")
    if status != 1:
        raise HTTPException(status_code=404, detail=f"No ERA5 data for case {case_index}")

    result = {"case_index": case_index, "radius_km": radius_km}

    # Check if full 3D T/q fields are available for custom radius
    # Support alternate variable names common in ERA5 stores
    _3d_t_names = ['t_3d', 'temperature_3d', 't3d', 'temperature', 'temp_3d']
    _3d_q_names = ['q_3d', 'specific_humidity_3d', 'q3d', 'specific_humidity', 'shum_3d']
    _3d_u_names = ['u_3d', 'u_wind_3d', 'u3d', 'u_component_of_wind']
    _3d_v_names = ['v_3d', 'v_wind_3d', 'v3d', 'v_component_of_wind']

    t_3d_key = next((k for k in _3d_t_names if k in era5), None)
    q_3d_key = next((k for k in _3d_q_names if k in era5), None)
    u_3d_key = next((k for k in _3d_u_names if k in era5), None)
    v_3d_key = next((k for k in _3d_v_names if k in era5), None)

    has_3d = t_3d_key is not None and q_3d_key is not None
    result["has_3d"] = has_3d

    if has_3d:
        try:
            center_lat = float(era5['center_lat'][era5_idx])
            lat_offsets = era5['lat_offsets'][:]
            lon_offsets = era5['lon_offsets'][:]
            cos_lat = np.cos(np.deg2rad(center_lat))
            dlon_grid, dlat_grid = np.meshgrid(lon_offsets, lat_offsets)
            dist_km = np.sqrt((dlat_grid * 111.0)**2 + (dlon_grid * 111.0 * cos_lat)**2)
            mask_2d = dist_km <= radius_km

            if mask_2d.sum() < 2:
                raise ValueError("Too few points")

            plev = era5['plev'][:].astype(float)
            t_3d = era5[t_3d_key][era5_idx]   # (nlev, nlat, nlon)
            q_3d = era5[q_3d_key][era5_idx]

            t_prof = np.array([float(np.nanmean(t_3d[k][mask_2d])) for k in range(len(plev))])
            q_prof = np.array([float(np.nanmean(q_3d[k][mask_2d])) for k in range(len(plev))])
            q_kgkg = q_prof / 1000.0 if np.nanmax(q_prof) > 0.5 else q_prof

            Rd_Cp = 287.04 / 1005.7
            theta = t_prof * (1000.0 / plev) ** Rd_Cp
            Lv, Cpd = 2.501e6, 1005.7
            theta_e = theta * np.exp(Lv * q_kgkg / (Cpd * t_prof))

            # RH: use rh_3d directly if available, else compute from q and T
            rh_3d_key = next((k for k in ['rh_3d', 'relative_humidity_3d'] if k in era5), None)
            if rh_3d_key:
                rh_3d_arr = era5[rh_3d_key][era5_idx]
                rh_prof = np.array([float(np.nanmean(rh_3d_arr[k][mask_2d])) for k in range(len(plev))])
                rh_prof = np.clip(rh_prof, 0, 100)
            else:
                es = 6.112 * np.exp(17.67 * (t_prof - 273.15) / (t_prof - 273.15 + 243.5))
                ws = 0.622 * es / (plev - es)
                rh_prof = np.clip(q_kgkg / ws * 100.0, 0, 100)

            profiles = {
                "plev": plev.tolist(),
                "t": [round(float(v), 2) if not np.isnan(v) else None for v in t_prof],
                "q": [round(float(v), 6) if not np.isnan(v) else None for v in q_prof],
                "rh": [round(float(v), 1) if not np.isnan(v) else None for v in rh_prof],
                "theta": [round(float(v), 1) if not np.isnan(v) else None for v in theta],
                "theta_e": [round(float(v), 1) if not np.isnan(v) else None for v in theta_e],
            }

            # Also average u/v 3D winds if available
            has_uv_3d = u_3d_key is not None and v_3d_key is not None
            if has_uv_3d:
                u_3d = era5[u_3d_key][era5_idx]
                v_3d = era5[v_3d_key][era5_idx]
                u_prof = np.array([float(np.nanmean(u_3d[k][mask_2d])) for k in range(len(plev))])
                v_prof = np.array([float(np.nanmean(v_3d[k][mask_2d])) for k in range(len(plev))])
                profiles["u"] = [round(float(v), 2) if not np.isnan(v) else None for v in u_prof]
                profiles["v"] = [round(float(v), 2) if not np.isnan(v) else None for v in v_prof]
            else:
                # Fall back to precomputed u/v profiles
                try:
                    profiles["u"] = [round(float(v), 2) if not np.isnan(v) else None for v in era5['u_profile'][era5_idx]]
                    profiles["v"] = [round(float(v), 2) if not np.isnan(v) else None for v in era5['v_profile'][era5_idx]]
                except Exception:
                    pass

            result["source"] = "recomputed"
            result["profiles"] = profiles
            return result
        except Exception:
            pass  # Fall through to precomputed profiles

    # Fallback: return precomputed annular-mean profiles
    try:
        plev = era5['plev'][:].astype(float)
        t_arr = era5['t_profile'][era5_idx].astype(float)
        q_arr = era5['q_profile'][era5_idx].astype(float)
        q_kgkg = q_arr / 1000.0 if np.nanmax(q_arr) > 0.5 else q_arr

        Rd_Cp = 287.04 / 1005.7
        theta = t_arr * (1000.0 / plev) ** Rd_Cp
        Lv, Cpd = 2.501e6, 1005.7
        theta_e = theta * np.exp(Lv * q_kgkg / (Cpd * t_arr))

        result["source"] = "precomputed"
        result["precomputed_domain"] = "200-600 km annulus"
        result["profiles"] = {
            "plev": plev.tolist(),
            "t": [round(float(v), 2) if not np.isnan(v) else None for v in t_arr],
            "q": [round(float(v), 6) if not np.isnan(v) else None for v in q_arr],
            "rh": [round(float(v), 1) if not np.isnan(v) else None for v in era5['rh_profile'][era5_idx]],
            "theta": [round(float(v), 1) if not np.isnan(v) else None for v in theta],
            "theta_e": [round(float(v), 1) if not np.isnan(v) else None for v in theta_e],
        }
        # Include precomputed u/v profiles for wind barbs
        try:
            result["profiles"]["u"] = [round(float(v), 2) if not np.isnan(v) else None for v in era5['u_profile'][era5_idx]]
            result["profiles"]["v"] = [round(float(v), 2) if not np.isnan(v) else None for v in era5['v_profile'][era5_idx]]
        except Exception:
            pass
    except Exception:
        result["profiles"] = None

    return result


def _build_case_meta(case_index, ds=None, local_idx=None, data_type="swath"):
    """Build case_meta dict with SDDC, SHDC, and TC motion included."""
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    case_meta = cache.get(case_index, {"case_index": case_index})
    meta = {
        "storm_name": case_meta.get("storm_name", ""),
        "datetime": case_meta.get("datetime", ""),
        "vmax_kt": case_meta.get("vmax_kt"),
        "rmw_km": case_meta.get("rmw_km"),
        "mission_id": case_meta.get("mission_id", ""),
        "tilt_magnitude_km": case_meta.get("tilt_magnitude_km"),
    }
    if ds is not None and local_idx is not None:
        sddc = _get_sddc(ds, local_idx)
        shdc = _get_shdc(ds, local_idx)
        meta["sddc"] = sddc if sddc is not None else 9999
        meta["shdc"] = shdc if shdc is not None else 9999

        # TC motion vector from dataset (storm_u_ms, storm_v_ms in m/s)
        motion_dir, motion_spd = _get_storm_motion(ds, local_idx)
        meta["motion_dir"] = motion_dir if motion_dir is not None else 9999
        meta["motion_spd"] = motion_spd if motion_spd is not None else 9999
    return meta


def _build_case_list(processed_indices: list[int], data_type: str = "swath") -> list[dict]:
    """Build a compact list of case metadata for composite reproducibility."""
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    case_list = []
    for ci in processed_indices:
        meta = cache.get(ci, {})
        case_list.append({
            "case_index": ci,
            "storm_name": meta.get("storm_name", ""),
            "datetime": meta.get("datetime", ""),
            "vmax_kt": meta.get("vmax_kt"),
        })
    return case_list


def _compute_azimuthal_mean(vol, x_coords, y_coords, height_vals, h_axis,
                            max_radius, dr, coverage_min, rmw=None):
    """
    Compute azimuthal mean from a 3D Cartesian volume.

    If rmw is provided, radii are normalised by RMW (output bins in R/RMW).
    Otherwise bins are in km.

    Returns:
        az_mean: 2D array (n_heights × n_rbins) — NaN where coverage < threshold
        coverage: 2D array (n_heights × n_rbins) — fraction of valid data
        r_bins: 1D array of radius bin centres (km or R/RMW)
    """
    # Build 2D radius grid from coordinate arrays
    xx, yy = np.meshgrid(x_coords, y_coords)
    rr = np.sqrt(xx**2 + yy**2)

    # If RMW-normalising, convert radius grid to R/RMW
    if rmw is not None and rmw > 0:
        rr = rr / rmw

    # Define radius bins
    r_edges = np.arange(0, max_radius + dr, dr)
    r_centers = (r_edges[:-1] + r_edges[1:]) / 2.0
    n_rbins = len(r_centers)
    n_heights = len(height_vals)

    # Pre-compute bin membership for each (y, x) grid point
    bin_idx = np.digitize(rr, r_edges) - 1  # shape: (ny, nx), values 0..n_rbins-1

    az_mean  = np.full((n_heights, n_rbins), np.nan)
    coverage = np.full((n_heights, n_rbins), 0.0)

    for h in range(n_heights):
        # Extract 2D slice at this height
        if h_axis == 0:
            slab = vol[h, :, :]
        elif h_axis == 2:
            slab = vol[:, :, h]
        else:
            slab = vol[:, h, :]

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


# ---------------------------------------------------------------------------
# Hybrid radial coordinate (R_H) — Fischer et al. (2025, MWR)
# ---------------------------------------------------------------------------

# Default hybrid-coordinate grid parameters
HYBRID_DR_INNER = 0.05     # R/RMW spacing inward of RMW  (dimensionless)
HYBRID_DR_OUTER_KM = 2.0   # km spacing outward of RMW (matches TC-RADAR grid)
HYBRID_MAX_OUTER_KM = 100.0  # max distance beyond RMW (km)


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


@app.get("/azimuthal_mean")
def azimuthal_mean(
    case_index:    int   = Query(...,   ge=0,            description="0-based case index"),
    variable:      str   = Query(DEFAULT_VARIABLE,       description="Variable key — see /variables"),
    data_type:     str   = Query("swath",                description="'swath' or 'merge'"),
    max_radius_km: float = Query(200.0, ge=10, le=500,   description="Maximum radius in km"),
    dr_km:         float = Query(2.0,   ge=0.5, le=20,   description="Radial bin width in km"),
    coverage_min:  float = Query(0.5,   ge=0.0, le=1.0,  description="Min fraction of valid data per bin"),
    overlay:       str   = Query("",                      description="Optional overlay variable key"),
):
    """Return azimuthal-mean radius-height cross-section as JSON."""
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'. See /variables.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")
    if overlay and overlay not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'.")

    try:
        ds, local_idx = resolve_case(case_index, data_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open dataset: {e}")

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    height_vals = ds["height"].values

    # Get ref variable for grid detection
    if variable in DERIVED_VARIABLES:
        ref_varname = DERIVED_VARIABLES[variable][0]
    else:
        if varname not in ds:
            raise HTTPException(status_code=400, detail=f"'{varname}' not in dataset.")
        ref_varname = varname

    # Determine spatial grid
    var_dims = set(ds[ref_varname].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        x_coords = ds["eastward_distance"].values
        y_coords = ds["northward_distance"].values
    elif "latitude" in var_dims and "longitude" in var_dims:
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x_coords = np.linspace(-(nx - 1), (nx - 1), nx)
        y_coords = np.linspace(-(ny - 1), (ny - 1), ny)
    else:
        raise HTTPException(status_code=500, detail="Cannot determine spatial grid")

    # Determine height axis position
    dim_list = [d for d in ds[ref_varname].dims if d != "num_cases"]
    if "height" not in dim_list:
        raise HTTPException(status_code=500, detail="Cannot determine height axis")
    h_axis = dim_list.index("height")

    # Extract 3D volume and compute azimuthal mean
    vol, _ = _extract_3d_volume(ds, local_idx, variable)
    az_mean, coverage, r_centers = _compute_azimuthal_mean(
        vol, x_coords, y_coords, height_vals, h_axis,
        max_radius_km, dr_km, coverage_min
    )

    case_meta = _build_case_meta(case_index, ds, local_idx, data_type)

    result = {
        "azimuthal_mean": _clean_2d(az_mean),
        "coverage": _clean_2d(coverage),
        "radius_km": [round(float(r), 2) for r in r_centers],
        "height_km": [round(float(h), 2) for h in height_vals],
        "coverage_min": coverage_min,
        "variable": {
            "key": variable,
            "display_name": display_name,
            "units": units,
            "vmin": vmin,
            "vmax": vmax,
            "colorscale": _cmap_to_plotly(cmap),
        },
        "case_meta": case_meta,
    }

    # Optional overlay azimuthal mean
    if overlay:
        ov_display, _, ov_cmap, ov_units, ov_vmin, ov_vmax = VARIABLES[overlay]
        try:
            ov_vol, _ = _extract_3d_volume(ds, local_idx, overlay)
            ov_az, _, _ = _compute_azimuthal_mean(
                ov_vol, x_coords, y_coords, height_vals, h_axis,
                max_radius_km, dr_km, coverage_min
            )
            result["overlay"] = {
                "azimuthal_mean": _clean_2d(ov_az),
                "key": overlay,
                "display_name": ov_display,
                "units": ov_units,
                "vmin": ov_vmin,
                "vmax": ov_vmax,
            }
        except Exception:
            pass

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# Shear-Relative Quadrant Means
# ---------------------------------------------------------------------------
QUADRANT_DEFS = {
    # key: (start_deg, end_deg) in shear-relative met heading
    # θ_sr = (θ_met - SDDC) mod 360, where 0° = downshear, CW positive
    # "left" = counterclockwise from downshear (met convention)
    "DSR": (0,   90),    # downshear-right
    "USR": (90,  180),   # upshear-right
    "USL": (180, 270),   # upshear-left
    "DSL": (270, 360),   # downshear-left
}


def _compute_quadrant_means(vol, x_coords, y_coords, height_vals, h_axis,
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


@app.get("/quadrant_mean")
def quadrant_mean(
    case_index:    int   = Query(...,   ge=0,            description="0-based case index"),
    variable:      str   = Query(DEFAULT_VARIABLE,       description="Variable key — see /variables"),
    data_type:     str   = Query("swath",                description="'swath' or 'merge'"),
    max_radius_km: float = Query(200.0, ge=10, le=500,   description="Maximum radius in km"),
    dr_km:         float = Query(2.0,   ge=0.5, le=20,   description="Radial bin width in km"),
    coverage_min:  float = Query(0.5,   ge=0.0, le=1.0,  description="Min fraction of valid data per bin"),
    overlay:       str   = Query("",                      description="Optional overlay variable key"),
):
    """Return shear-relative quadrant-mean radius-height sections as JSON."""
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'. See /variables.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")
    if overlay and overlay not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'.")

    try:
        ds, local_idx = resolve_case(case_index, data_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open dataset: {e}")

    # Look up SDDC — required for this endpoint
    sddc = _get_sddc(ds, local_idx)
    if sddc is None:
        raise HTTPException(
            status_code=400,
            detail="Shear direction (SDDC) not available for this case — cannot compute shear-relative quadrants."
        )

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    height_vals = ds["height"].values

    # Ref variable for grid detection
    if variable in DERIVED_VARIABLES:
        ref_varname = DERIVED_VARIABLES[variable][0]
    else:
        if varname not in ds:
            raise HTTPException(status_code=400, detail=f"'{varname}' not in dataset.")
        ref_varname = varname

    # Determine spatial grid
    var_dims = set(ds[ref_varname].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        x_coords = ds["eastward_distance"].values
        y_coords = ds["northward_distance"].values
    elif "latitude" in var_dims and "longitude" in var_dims:
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x_coords = np.linspace(-(nx - 1), (nx - 1), nx)
        y_coords = np.linspace(-(ny - 1), (ny - 1), ny)
    else:
        raise HTTPException(status_code=500, detail="Cannot determine spatial grid")

    # Determine height axis position
    dim_list = [d for d in ds[ref_varname].dims if d != "num_cases"]
    if "height" not in dim_list:
        raise HTTPException(status_code=500, detail="Cannot determine height axis")
    h_axis = dim_list.index("height")

    # Extract 3D volume and compute quadrant means
    vol, _ = _extract_3d_volume(ds, local_idx, variable)
    quad_means, r_centers = _compute_quadrant_means(
        vol, x_coords, y_coords, height_vals, h_axis,
        sddc, max_radius_km, dr_km, coverage_min
    )

    case_meta = _build_case_meta(case_index, ds, local_idx, data_type)

    result = {
        "quadrant_means": {
            q: {"data": _clean_2d(quad_means[q])} for q in QUADRANT_DEFS
        },
        "radius_km": [round(float(r), 2) for r in r_centers],
        "height_km": [round(float(h), 2) for h in height_vals],
        "coverage_min": coverage_min,
        "variable": {
            "key": variable,
            "display_name": display_name,
            "units": units,
            "vmin": vmin,
            "vmax": vmax,
            "colorscale": _cmap_to_plotly(cmap),
        },
        "case_meta": case_meta,
    }

    # Optional overlay quadrant means
    if overlay:
        ov_display, _, ov_cmap, ov_units, ov_vmin, ov_vmax = VARIABLES[overlay]
        try:
            ov_vol, _ = _extract_3d_volume(ds, local_idx, overlay)
            ov_quads, _ = _compute_quadrant_means(
                ov_vol, x_coords, y_coords, height_vals, h_axis,
                sddc, max_radius_km, dr_km, coverage_min
            )
            result["overlay"] = {
                "quadrant_means": {
                    q: {"data": _clean_2d(ov_quads[q])} for q in QUADRANT_DEFS
                },
                "key": overlay,
                "display_name": ov_display,
                "units": ov_units,
                "vmin": ov_vmin,
                "vmax": ov_vmax,
            }
        except Exception:
            pass

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# Composite endpoints
# ---------------------------------------------------------------------------
_COMPOSITE_MAX_CASES = 1000  # safety cap — batched processing keeps peak RAM bounded regardless of N

_SENTINEL_DONE = "__DONE__"
_SENTINEL_ERROR = "__ERROR__"


def _streaming_composite_response(compute_fn):
    """
    Run *compute_fn* in a background thread while streaming NDJSON progress
    events to the client.  *compute_fn* receives a *progress_cb(done, total)*
    callback.  It must return the final result dict.

    The response is ``application/x-ndjson``: one JSON object per line.
    Progress lines look like: ``{"progress": 160, "total": 384}``
    The final line is the full result JSON (no wrapper).
    """
    q: queue.Queue = queue.Queue()

    def _progress_cb(done, total):
        q.put(json.dumps({"progress": done, "total": total}) + "\n")

    def _run():
        try:
            result = compute_fn(_progress_cb)
            q.put(json.dumps(result) + "\n")
            q.put(_SENTINEL_DONE)
        except Exception as exc:
            q.put(json.dumps({"error": str(exc)}) + "\n")
            q.put(_SENTINEL_ERROR)

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    def _generate():
        while True:
            item = q.get()
            if item in (_SENTINEL_DONE, _SENTINEL_ERROR):
                break
            yield item

    return StreamingResponse(_generate(), media_type="application/x-ndjson")

# Common query parameters for composite filters
def _composite_filter_params(
    min_intensity:  float = Query(0,    ge=0,   le=200,  description="Min Vmax (kt)"),
    max_intensity:  float = Query(200,  ge=0,   le=200,  description="Max Vmax (kt)"),
    min_vmax_change:float = Query(-100, ge=-100,le=85,   description="Min 24-h Vmax change (kt)"),
    max_vmax_change:float = Query(85,   ge=-100,le=85,   description="Max 24-h Vmax change (kt)"),
    min_tilt:       float = Query(0,    ge=0,   le=200,  description="Min tilt magnitude (km)"),
    max_tilt:       float = Query(200,  ge=0,   le=200,  description="Max tilt magnitude (km)"),
    min_year:       int   = Query(1997, ge=1997,le=2024,  description="Min year"),
    max_year:       int   = Query(2024, ge=1997,le=2024,  description="Max year"),
    min_shear_mag:  float = Query(0,    ge=0,   le=100,  description="Min shear magnitude (kt)"),
    max_shear_mag:  float = Query(100,  ge=0,   le=100,  description="Max shear magnitude (kt)"),
    min_shear_dir:  float = Query(0,    ge=0,   le=360,  description="Min shear direction (deg)"),
    max_shear_dir:  float = Query(360,  ge=0,   le=360,  description="Max shear direction (deg)"),
    min_dtl:        float = Query(0,    ge=0,   le=9999, description="Min distance-to-land (km); 0 = no filter"),
    dtl_window:     str   = Query("24h",                 description="DTL forecast window: '12h' or '24h'"),
):
    return dict(
        min_intensity=min_intensity, max_intensity=max_intensity,
        min_vmax_change=min_vmax_change, max_vmax_change=max_vmax_change,
        min_tilt=min_tilt, max_tilt=max_tilt,
        min_year=min_year, max_year=max_year,
        min_shear_mag=min_shear_mag, max_shear_mag=max_shear_mag,
        min_shear_dir=min_shear_dir, max_shear_dir=max_shear_dir,
        min_dtl=min_dtl, dtl_window=dtl_window,
    )


def _resolve_grid_and_haxis(ds, ref_varname):
    """Determine spatial grid and height axis from a dataset + variable."""
    var_dims = set(ds[ref_varname].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        x_coords = ds["eastward_distance"].values
        y_coords = ds["northward_distance"].values
    elif "latitude" in var_dims and "longitude" in var_dims:
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x_coords = np.linspace(-(nx - 1), (nx - 1), nx)
        y_coords = np.linspace(-(ny - 1), (ny - 1), ny)
    else:
        raise ValueError("Cannot determine spatial grid")
    dim_list = [d for d in ds[ref_varname].dims if d != "num_cases"]
    if "height" not in dim_list:
        raise ValueError("Cannot determine height axis")
    h_axis = dim_list.index("height")
    return x_coords, y_coords, h_axis


# ---------------------------------------------------------------------------
# Plan-view composite helpers
# ---------------------------------------------------------------------------

def _rotate_2d_grid(data, angle_deg):
    """
    Rotate a 2D array counter-clockwise by *angle_deg* degrees.

    Uses bilinear interpolation; out-of-bounds filled with NaN.
    Returns an array of the same shape (no reshape).
    """
    return _ndimage.rotate(data, angle_deg, order=1, cval=np.nan, reshape=False)


def _regrid_to_rmw_normalized(data_2d, x_phys, y_phys, rmw,
                               max_r_rmw=5.0, dr_rmw=0.1):
    """
    Re-grid a physical-coordinate 2D slice onto an RMW-normalised Cartesian
    grid spanning ±max_r_rmw with spacing dr_rmw.

    Parameters
    ----------
    data_2d : 2D ndarray (ny, nx)
    x_phys, y_phys : 1D arrays — physical distance coordinates (km)
    rmw : float — radius of maximum wind (km)
    max_r_rmw, dr_rmw : float — target grid extent & resolution in R/RMW

    Returns
    -------
    data_norm : 2D ndarray on the normalised grid
    x_norm, y_norm : 1D coordinate arrays in R/RMW
    """
    # Build target coordinate arrays (R/RMW)
    half_n = int(round(max_r_rmw / dr_rmw))
    x_norm = np.linspace(-max_r_rmw, max_r_rmw, 2 * half_n + 1)
    y_norm = np.linspace(-max_r_rmw, max_r_rmw, 2 * half_n + 1)

    # Target grid in physical space
    xx_norm, yy_norm = np.meshgrid(x_norm, y_norm)
    xx_phys_target = xx_norm * rmw
    yy_phys_target = yy_norm * rmw

    # Build interpolator on the original physical grid
    interp = RegularGridInterpolator(
        (y_phys, x_phys), data_2d,
        method="linear", bounds_error=False, fill_value=np.nan,
    )
    pts = np.column_stack([yy_phys_target.ravel(), xx_phys_target.ravel()])
    data_norm = interp(pts).reshape(len(y_norm), len(x_norm))
    return data_norm, x_norm, y_norm


# Number of parallel threads for composite S3 reads.
# 8 threads on the upgraded 2 GB Render plan — each concurrent 3D volume
# read is ~10–15 MB, so peak thread memory ≈ 8 × 15 MB ≈ 120 MB, well
# within the ~1.5 GB headroom after base app footprint (~300 MB).
_COMPOSITE_WORKERS = 8

# Batch size for composite processing — process this many cases at a time,
# then lightweight GC between batches to keep peak memory bounded.
_COMPOSITE_BATCH_SIZE = 80


def _process_composites_batched(worker_fn, work_items, accumulate_fn,
                                 progress_cb=None):
    """
    Process composite cases in batches to bound peak memory.

    Parameters
    ----------
    worker_fn : callable
        Function to submit to thread pool. Receives unpacked args from each work item.
    work_items : list of tuples
        Each tuple is unpacked as args to worker_fn.
    accumulate_fn : callable(result)
        Called with each non-None worker result in the main thread.
        Should accumulate into the caller's arrays.
    progress_cb : callable(done, total) or None
        Optional callback invoked after each batch completes.  *done* is the
        cumulative number of work-items processed so far, *total* is
        len(work_items).  Overhead is negligible since it fires once per batch.

    Returns nothing — accumulation is done via side-effect through accumulate_fn.
    """
    total = len(work_items)
    done = 0
    # Reuse a single thread pool across all batches to avoid repeated
    # thread creation/teardown overhead.
    with ThreadPoolExecutor(max_workers=_COMPOSITE_WORKERS) as pool:
        for batch_start in range(0, total, _COMPOSITE_BATCH_SIZE):
            batch = work_items[batch_start:batch_start + _COMPOSITE_BATCH_SIZE]
            futures = {
                pool.submit(worker_fn, *item): item[0]
                for item in batch
            }
            for future in as_completed(futures):
                result = future.result()
                if result is not None:
                    accumulate_fn(result)
                del result
            del futures
            done += len(batch)
            # Lightweight gen-0 GC between batches — avoids the 50–200 ms
            # cost of a full 3-generation sweep while still freeing short-lived
            # objects (thread-local buffers, intermediate arrays).
            gc.collect(0)
            if progress_cb is not None:
                progress_cb(done, total)
    # One full GC at the very end to reclaim any promoted objects.
    gc.collect()


def _process_one_case_azimuthal(case_idx, rmw, variable, overlay, data_type,
                                 x_coords, y_coords, height_km, h_axis,
                                 max_r_rmw, dr_rmw, coverage_min):
    """
    Process a single case for composite azimuthal mean.
    Runs in a thread pool — all args passed explicitly, no shared mutable state.
    Returns (case_idx, az_mean, r_centers, ov_az_or_None) or None on failure.
    """
    try:
        ds, local_idx = resolve_case(case_idx, data_type)
        vol, _ = _extract_3d_volume(ds, local_idx, variable)
        az_mean, _, rc = _compute_azimuthal_mean(
            vol, x_coords, y_coords, height_km, h_axis,
            max_r_rmw, dr_rmw, coverage_min, rmw=rmw
        )

        ov_az = None
        if overlay:
            try:
                ov_vol, _ = _extract_3d_volume(ds, local_idx, overlay)
                ov_az, _, _ = _compute_azimuthal_mean(
                    ov_vol, x_coords, y_coords, height_km, h_axis,
                    max_r_rmw, dr_rmw, coverage_min, rmw=rmw
                )
            except Exception:
                pass

        return (case_idx, az_mean, rc, ov_az)
    except Exception as e:
        print(f"Composite az: skipping case {case_idx}: {e}")
        return None


def _process_one_case_quadrant(case_idx, sddc, rmw, variable, overlay, data_type,
                                x_coords, y_coords, height_km, h_axis,
                                max_r_rmw, dr_rmw, coverage_min):
    """
    Process a single case for composite quadrant mean.
    Runs in a thread pool — all args passed explicitly, no shared mutable state.
    Returns (case_idx, quad_means, r_centers, ov_quad_means_or_None) or None on failure.
    """
    try:
        ds, local_idx = resolve_case(case_idx, data_type)
        vol, _ = _extract_3d_volume(ds, local_idx, variable)
        quad_means, rc = _compute_quadrant_means(
            vol, x_coords, y_coords, height_km, h_axis,
            sddc, max_r_rmw, dr_rmw, coverage_min, rmw=rmw
        )

        ov_quads = None
        if overlay:
            try:
                ov_vol, _ = _extract_3d_volume(ds, local_idx, overlay)
                ov_quads, _ = _compute_quadrant_means(
                    ov_vol, x_coords, y_coords, height_km, h_axis,
                    sddc, max_r_rmw, dr_rmw, coverage_min, rmw=rmw
                )
            except Exception:
                pass

        return (case_idx, quad_means, rc, ov_quads)
    except Exception as e:
        print(f"Composite quad: skipping case {case_idx}: {e}")
        return None


def _process_one_case_plan_view(case_idx, rmw, sddc, variable, overlay,
                                 data_type, x_coords, y_coords, z_idx,
                                 normalize_rmw, max_r_rmw, dr_rmw,
                                 shear_relative):
    """
    Process a single case for plan-view composite.

    Returns (case_idx, plan_2d, x_grid, y_grid, ov_plan_2d) or None.
    """
    try:
        ds, local_idx = resolve_case(case_idx, data_type)
        data_2d, _ = _extract_2d_slice(ds, local_idx, variable, z_idx)

        # Shear-relative rotation: rotate so shear vector points right (+x)
        if shear_relative and sddc is not None:
            # ndimage.rotate rotates CCW by the given angle.
            # We need to map SDDC (met heading) to +x (math 0°).
            # Math angle of shear = 90 - SDDC.
            # To rotate shear to 0° math, rotate CCW by -(90 - SDDC) = SDDC - 90.
            # BUT ndimage.rotate(angle) rotates CCW by `angle`, so pass 90 - SDDC
            # to bring shear to the right.
            rotation_angle = 90.0 - float(sddc)
            data_2d = _rotate_2d_grid(data_2d, rotation_angle)

        # RMW normalisation
        if normalize_rmw and rmw is not None and rmw > 0:
            data_2d, x_grid, y_grid = _regrid_to_rmw_normalized(
                data_2d, x_coords, y_coords, rmw, max_r_rmw, dr_rmw,
            )
        else:
            x_grid, y_grid = x_coords, y_coords

        # Overlay
        ov_2d = None
        if overlay:
            try:
                ov_data, _ = _extract_2d_slice(ds, local_idx, overlay, z_idx)
                if shear_relative and sddc is not None:
                    ov_data = _rotate_2d_grid(ov_data, rotation_angle)
                if normalize_rmw and rmw is not None and rmw > 0:
                    ov_data, _, _ = _regrid_to_rmw_normalized(
                        ov_data, x_coords, y_coords, rmw, max_r_rmw, dr_rmw,
                    )
                ov_2d = ov_data
            except Exception:
                pass

        return (case_idx, data_2d, x_grid, y_grid, ov_2d)
    except Exception as e:
        print(f"Composite plan_view: skipping case {case_idx}: {e}")
        return None


@app.get("/composite/count")
def composite_count(
    data_type:      str   = Query("swath",                description="'swath' or 'merge'"),
    min_intensity:  float = Query(0,    ge=0,   le=200),
    max_intensity:  float = Query(200,  ge=0,   le=200),
    min_vmax_change:float = Query(-100, ge=-100,le=85),
    max_vmax_change:float = Query(85,   ge=-100,le=85),
    min_tilt:       float = Query(0,    ge=0,   le=200),
    max_tilt:       float = Query(200,  ge=0,   le=200),
    min_year:       int   = Query(1997, ge=1997,le=2024),
    max_year:       int   = Query(2024, ge=1997,le=2024),
    min_shear_mag:  float = Query(0,    ge=0,   le=100),
    max_shear_mag:  float = Query(100,  ge=0,   le=100),
    min_shear_dir:  float = Query(0,    ge=0,   le=360),
    max_shear_dir:  float = Query(360,  ge=0,   le=360),
    min_dtl:        float = Query(0,    ge=0,   le=9999),
    dtl_window:     str   = Query("24h"),
):
    """Quick endpoint to get case count for given filter criteria (no data loading)."""
    cases = _filter_cases_for_composite(
        min_intensity, max_intensity, min_vmax_change, max_vmax_change,
        min_tilt, max_tilt, min_year, max_year,
        min_shear_mag, max_shear_mag, min_shear_dir, max_shear_dir,
        min_dtl=min_dtl, dtl_window=dtl_window,
        data_type=data_type,
    )
    return {
        "count": len(cases),
        "max_cases": _COMPOSITE_MAX_CASES,
        "capped": len(cases) > _COMPOSITE_MAX_CASES,
        "case_indices": cases[:20],
    }


@app.get("/composite/azimuthal_mean")
def composite_azimuthal_mean(
    variable:      str   = Query(DEFAULT_VARIABLE,       description="Variable key"),
    overlay:       str   = Query("",                     description="Optional overlay variable key"),
    data_type:     str   = Query("swath",                description="'swath' or 'merge'"),
    normalize_rmw: bool  = Query(True,                   description="Normalise radii by RMW"),
    max_r_rmw:     float = Query(8.0,   ge=1, le=20,    description="Max radius in R/RMW (or km when normalize_rmw=false)"),
    dr_rmw:        float = Query(0.25,  ge=0.05, le=2,  description="Radial bin width in R/RMW (or km when normalize_rmw=false)"),
    coverage_min:  float = Query(0.25,  ge=0.0, le=1.0),
    stream:        bool  = Query(False,                  description="Stream NDJSON progress events"),
    min_intensity:  float = Query(0),    max_intensity:  float = Query(200),
    min_vmax_change:float = Query(-100), max_vmax_change:float = Query(85),
    min_tilt:       float = Query(0),    max_tilt:       float = Query(200),
    min_year:       int   = Query(1997), max_year:       int   = Query(2024),
    min_shear_mag:  float = Query(0),    max_shear_mag:  float = Query(100),
    min_shear_dir:  float = Query(0),    max_shear_dir:  float = Query(360),
    min_dtl:        float = Query(0),    dtl_window:     str   = Query("24h"),
):
    """Compute composite azimuthal mean across matching cases, optionally RMW-normalised."""
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if overlay and overlay not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    meta_cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    matching = _filter_cases_for_composite(
        min_intensity, max_intensity, min_vmax_change, max_vmax_change,
        min_tilt, max_tilt, min_year, max_year,
        min_shear_mag, max_shear_mag, min_shear_dir, max_shear_dir,
        min_dtl=min_dtl, dtl_window=dtl_window,
        data_type=data_type,
    )
    if not matching:
        raise HTTPException(status_code=400, detail="No cases match the specified criteria.")
    if len(matching) > _COMPOSITE_MAX_CASES:
        matching = matching[:_COMPOSITE_MAX_CASES]

    # Filter to cases with valid RMW (only required when normalising)
    if normalize_rmw:
        cases_with_rmw = []
        for ci in matching:
            rmw = meta_cache.get(ci, {}).get("rmw_km")
            if rmw is not None and not np.isnan(float(rmw)) and float(rmw) > 0:
                cases_with_rmw.append((ci, float(rmw)))
        if not cases_with_rmw:
            raise HTTPException(status_code=400, detail="No matching cases have valid RMW data.")
    else:
        # Physical-distance mode: include all matched cases (rmw=None → km bins)
        cases_with_rmw = [(ci, None) for ci in matching]

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    ref_varname = DERIVED_VARIABLES[variable][0] if variable in DERIVED_VARIABLES else varname

    # Pre-fetch grid info from the first valid case so all workers share it
    first_ds, _ = resolve_case(cases_with_rmw[0][0], data_type)
    height_km = first_ds["height"].values
    x_coords, y_coords, h_axis = _resolve_grid_and_haxis(first_ds, ref_varname)

    # Process cases in batches — keeps peak memory bounded on the 2 GB Render plan.
    work_items = [
        (case_idx, rmw, variable, overlay, data_type,
         x_coords, y_coords, height_km, h_axis,
         max_r_rmw, dr_rmw, coverage_min)
        for case_idx, rmw in cases_with_rmw
    ]

    def _compute(progress_cb=None):
        accum_sum = None
        accum_count = None
        ov_accum_sum = None
        ov_accum_count = None
        r_centers = None
        n_processed = 0
        processed_indices = []

        def _accum_az(result):
            nonlocal accum_sum, accum_count, ov_accum_sum, ov_accum_count
            nonlocal r_centers, n_processed
            case_idx, az_mean, rc, ov_az = result
            if accum_sum is None:
                r_centers = rc
                accum_sum = np.zeros_like(az_mean)
                accum_count = np.zeros_like(az_mean)
            valid = ~np.isnan(az_mean)
            accum_sum[valid] += az_mean[valid]
            accum_count[valid] += 1
            if ov_az is not None:
                if ov_accum_sum is None:
                    ov_accum_sum = np.zeros_like(ov_az)
                    ov_accum_count = np.zeros_like(ov_az)
                ov_valid = ~np.isnan(ov_az)
                ov_accum_sum[ov_valid] += ov_az[ov_valid]
                ov_accum_count[ov_valid] += 1
            n_processed += 1
            processed_indices.append(case_idx)

        _process_composites_batched(
            _process_one_case_azimuthal, work_items, _accum_az,
            progress_cb=progress_cb,
        )

        if n_processed == 0:
            raise RuntimeError("Could not process any matching cases.")

        min_cases = max(3, int(np.ceil(0.33 * n_processed)))
        composite = np.where(accum_count >= min_cases, accum_sum / accum_count, np.nan)

        result = {
            "azimuthal_mean": _clean_2d(composite),
            "radius_rrmw": [round(float(r), 3) for r in r_centers],
            "height_km": [round(float(h), 2) for h in height_km],
            "normalized": normalize_rmw,
            "coverage_min": coverage_min,
            "min_cases_per_bin": min_cases,
            "n_cases": n_processed,
            "n_matched": len(matching),
            "n_with_rmw": len(cases_with_rmw),
            "case_list": _build_case_list(processed_indices, data_type),
            "variable": {
                "key": variable,
                "display_name": display_name,
                "units": units,
                "vmin": vmin,
                "vmax": vmax,
                "colorscale": _cmap_to_plotly(cmap),
            },
            "filters": {
                "intensity": [min_intensity, max_intensity],
                "vmax_change": [min_vmax_change, max_vmax_change],
                "tilt": [min_tilt, max_tilt],
                "year": [min_year, max_year],
                "shear_mag": [min_shear_mag, max_shear_mag],
                "shear_dir": [min_shear_dir, max_shear_dir],
            },
        }

        if overlay and ov_accum_sum is not None:
            ov_composite = np.where(ov_accum_count >= min_cases, ov_accum_sum / ov_accum_count, np.nan)
            ov_display, _, ov_cmap, ov_units, ov_vmin, ov_vmax = VARIABLES[overlay]
            clean_ov = _clean_2d(ov_composite)
            flat = [v for row in clean_ov for v in row if v is not None]
            result["overlay"] = {
                "display_name": ov_display,
                "key": overlay,
                "units": ov_units,
                "azimuthal_mean": clean_ov,
                "vmin": min(flat) if flat else ov_vmin,
                "vmax": max(flat) if flat else ov_vmax,
            }
        return result

    if stream:
        return _streaming_composite_response(_compute)
    return JSONResponse(_compute())


@app.get("/composite/quadrant_mean")
def composite_quadrant_mean(
    variable:      str   = Query(DEFAULT_VARIABLE,       description="Variable key"),
    overlay:       str   = Query("",                     description="Optional overlay variable key"),
    data_type:     str   = Query("swath",                description="'swath' or 'merge'"),
    max_r_rmw:     float = Query(8.0,   ge=1, le=20,    description="Max radius in R/RMW"),
    dr_rmw:        float = Query(0.25,  ge=0.05, le=2,  description="Radial bin width in R/RMW"),
    coverage_min:  float = Query(0.25,  ge=0.0, le=1.0),
    stream:        bool  = Query(False,                  description="Stream NDJSON progress events"),
    min_intensity:  float = Query(0),    max_intensity:  float = Query(200),
    min_vmax_change:float = Query(-100), max_vmax_change:float = Query(85),
    min_tilt:       float = Query(0),    max_tilt:       float = Query(200),
    min_year:       int   = Query(1997), max_year:       int   = Query(2024),
    min_shear_mag:  float = Query(0),    max_shear_mag:  float = Query(100),
    min_shear_dir:  float = Query(0),    max_shear_dir:  float = Query(360),
    min_dtl:        float = Query(0),    dtl_window:     str   = Query("24h"),
):
    """Compute RMW-normalised composite shear-relative quadrant means."""
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if overlay and overlay not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    meta_cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    matching = _filter_cases_for_composite(
        min_intensity, max_intensity, min_vmax_change, max_vmax_change,
        min_tilt, max_tilt, min_year, max_year,
        min_shear_mag, max_shear_mag, min_shear_dir, max_shear_dir,
        min_dtl=min_dtl, dtl_window=dtl_window,
        data_type=data_type,
    )
    if not matching:
        raise HTTPException(status_code=400, detail="No cases match the specified criteria.")
    if len(matching) > _COMPOSITE_MAX_CASES:
        matching = matching[:_COMPOSITE_MAX_CASES]

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    ref_varname = DERIVED_VARIABLES[variable][0] if variable in DERIVED_VARIABLES else varname

    # Cases need both valid SDDC and valid RMW
    valid_cases = []
    for ci in matching:
        meta = meta_cache.get(ci, {})
        sddc = meta.get("sddc")
        rmw = meta.get("rmw_km")
        if sddc is not None and rmw is not None and not np.isnan(float(rmw)) and float(rmw) > 0:
            valid_cases.append((ci, sddc, float(rmw)))
    if not valid_cases:
        raise HTTPException(status_code=400, detail="No matching cases have both shear direction and valid RMW.")

    # Pre-fetch grid info from the first valid case so all workers share it
    first_ds, _ = resolve_case(valid_cases[0][0], data_type)
    height_km = first_ds["height"].values
    x_coords, y_coords, h_axis = _resolve_grid_and_haxis(first_ds, ref_varname)

    # Process cases in batches — keeps peak memory bounded on the 2 GB Render plan.
    work_items = [
        (case_idx, sddc, rmw, variable, overlay, data_type,
         x_coords, y_coords, height_km, h_axis,
         max_r_rmw, dr_rmw, coverage_min)
        for case_idx, sddc, rmw in valid_cases
    ]

    def _compute(progress_cb=None):
        accum_sum = None
        accum_count = None
        ov_accum_sum = None
        ov_accum_count = None
        r_centers = None
        n_processed = 0
        processed_indices = []

        def _accum_quad(result):
            nonlocal accum_sum, accum_count, ov_accum_sum, ov_accum_count
            nonlocal r_centers, n_processed
            case_idx, quad_means, rc, ov_quads = result
            if accum_sum is None:
                r_centers = rc
                accum_sum = {q: np.zeros_like(quad_means[q]) for q in QUADRANT_DEFS}
                accum_count = {q: np.zeros_like(quad_means[q]) for q in QUADRANT_DEFS}
            for q in QUADRANT_DEFS:
                valid = ~np.isnan(quad_means[q])
                accum_sum[q][valid] += quad_means[q][valid]
                accum_count[q][valid] += 1
            if ov_quads is not None:
                if ov_accum_sum is None:
                    ov_accum_sum = {q: np.zeros_like(ov_quads[q]) for q in QUADRANT_DEFS}
                    ov_accum_count = {q: np.zeros_like(ov_quads[q]) for q in QUADRANT_DEFS}
                for q in QUADRANT_DEFS:
                    ov_valid = ~np.isnan(ov_quads[q])
                    ov_accum_sum[q][ov_valid] += ov_quads[q][ov_valid]
                    ov_accum_count[q][ov_valid] += 1
            n_processed += 1
            processed_indices.append(case_idx)

        _process_composites_batched(
            _process_one_case_quadrant, work_items, _accum_quad,
            progress_cb=progress_cb,
        )

        if n_processed == 0:
            raise RuntimeError("Could not process any matching cases.")

        min_cases = max(3, int(np.ceil(0.33 * n_processed)))
        composite = {}
        for q in QUADRANT_DEFS:
            composite[q] = np.where(accum_count[q] >= min_cases, accum_sum[q] / accum_count[q], np.nan)

        result = {
            "quadrant_means": {q: {"data": _clean_2d(composite[q])} for q in QUADRANT_DEFS},
            "radius_rrmw": [round(float(r), 3) for r in r_centers],
            "height_km": [round(float(h), 2) for h in height_km],
            "normalized": True,
            "coverage_min": coverage_min,
            "min_cases_per_bin": min_cases,
            "n_cases": n_processed,
            "n_matched": len(matching),
            "n_with_shear_and_rmw": len(valid_cases),
            "case_list": _build_case_list(processed_indices, data_type),
            "variable": {
                "key": variable,
                "display_name": display_name,
                "units": units,
                "vmin": vmin,
                "vmax": vmax,
                "colorscale": _cmap_to_plotly(cmap),
            },
            "filters": {
                "intensity": [min_intensity, max_intensity],
                "vmax_change": [min_vmax_change, max_vmax_change],
                "tilt": [min_tilt, max_tilt],
                "year": [min_year, max_year],
                "shear_mag": [min_shear_mag, max_shear_mag],
                "shear_dir": [min_shear_dir, max_shear_dir],
            },
        }

        if overlay and ov_accum_sum is not None:
            ov_display, _, ov_cmap, ov_units, ov_vmin, ov_vmax = VARIABLES[overlay]
            ov_composite = {}
            all_flat = []
            for q in QUADRANT_DEFS:
                ov_composite[q] = np.where(ov_accum_count[q] >= min_cases, ov_accum_sum[q] / ov_accum_count[q], np.nan)
                clean_q = _clean_2d(ov_composite[q])
                ov_composite[q] = clean_q
                all_flat.extend(v for row in clean_q for v in row if v is not None)
            result["overlay"] = {
                "display_name": ov_display,
                "key": overlay,
                "units": ov_units,
                "quadrant_means": {q: {"data": ov_composite[q]} for q in QUADRANT_DEFS},
                "vmin": min(all_flat) if all_flat else ov_vmin,
                "vmax": max(all_flat) if all_flat else ov_vmax,
            }
        return result

    if stream:
        return _streaming_composite_response(_compute)
    return JSONResponse(_compute())


# ---------------------------------------------------------------------------
# Composite plan-view endpoint
# ---------------------------------------------------------------------------

@app.get("/composite/plan_view")
def composite_plan_view(
    variable:       str   = Query(DEFAULT_VARIABLE,        description="Variable key"),
    overlay:        str   = Query("",                      description="Optional overlay variable key"),
    data_type:      str   = Query("swath",                 description="'swath' or 'merge'"),
    level_km:       float = Query(2.0,  ge=0.5, le=18.0,  description="Height level (km)"),
    normalize_rmw:  bool  = Query(False,                   description="Normalise X/Y by RMW?"),
    max_r_rmw:      float = Query(5.0,  ge=1,   le=20,    description="Max extent in R/RMW"),
    dr_rmw:         float = Query(0.1,  ge=0.05, le=1,    description="Grid spacing in R/RMW"),
    shear_relative: bool  = Query(False,                   description="Rotate to shear-relative frame?"),
    coverage_min:   float = Query(0.25, ge=0.0,  le=1.0,  description="Min coverage fraction"),
    stream:         bool  = Query(False,                  description="Stream NDJSON progress events"),
    min_intensity:  float = Query(0),    max_intensity:  float = Query(200),
    min_vmax_change:float = Query(-100), max_vmax_change:float = Query(85),
    min_tilt:       float = Query(0),    max_tilt:       float = Query(200),
    min_year:       int   = Query(1997), max_year:       int   = Query(2024),
    min_shear_mag:  float = Query(0),    max_shear_mag:  float = Query(100),
    min_shear_dir:  float = Query(0),    max_shear_dir:  float = Query(360),
    min_dtl:        float = Query(0),    dtl_window:     str   = Query("24h"),
):
    """Compute a composite plan-view mean at a specified height level."""

    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if overlay and overlay not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown overlay variable '{overlay}'.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    meta_cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache

    matching = _filter_cases_for_composite(
        min_intensity, max_intensity, min_vmax_change, max_vmax_change,
        min_tilt, max_tilt, min_year, max_year,
        min_shear_mag, max_shear_mag, min_shear_dir, max_shear_dir,
        min_dtl=min_dtl, dtl_window=dtl_window,
        data_type=data_type,
    )
    if not matching:
        raise HTTPException(status_code=400, detail="No cases match the specified criteria.")
    if len(matching) > _COMPOSITE_MAX_CASES:
        matching = matching[:_COMPOSITE_MAX_CASES]

    # ------------------------------------------------------------------
    # Collect per-case metadata (RMW, optionally SDDC)
    # ------------------------------------------------------------------
    cases_ready: list[tuple] = []   # (case_idx, rmw, sddc_or_None)
    for ci in matching:
        meta = meta_cache.get(ci, {})
        rmw = meta.get("rmw_km")
        if normalize_rmw:
            # RMW is mandatory when normalising
            if rmw is None or np.isnan(float(rmw)) or float(rmw) <= 0:
                continue
        else:
            rmw = rmw if (rmw is not None and not np.isnan(float(rmw)) and float(rmw) > 0) else None

        sddc = meta.get("sddc") if shear_relative else None
        if shear_relative and sddc is None:
            continue  # need SDDC for rotation

        cases_ready.append((ci, float(rmw) if rmw is not None else None, sddc))

    if not cases_ready:
        detail = "No matching cases have valid "
        parts = []
        if normalize_rmw:
            parts.append("RMW")
        if shear_relative:
            parts.append("shear direction")
        detail += " and ".join(parts) + " data."
        raise HTTPException(status_code=400, detail=detail)

    # ------------------------------------------------------------------
    # Pre-fetch grid info & locate height index
    # ------------------------------------------------------------------
    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    ref_varname = DERIVED_VARIABLES[variable][0] if variable in DERIVED_VARIABLES else varname

    first_ds, _ = resolve_case(cases_ready[0][0], data_type)
    height_km = first_ds["height"].values
    z_idx = int(np.argmin(np.abs(height_km - level_km)))
    actual_level = float(height_km[z_idx])
    x_coords, y_coords, _ = _resolve_grid_and_haxis(first_ds, ref_varname)

    # ------------------------------------------------------------------
    # Parallel processing
    # ------------------------------------------------------------------
    # Process cases in batches — keeps peak memory bounded on the 2 GB Render plan.
    work_items = [
        (ci, rmw, sddc, variable, overlay, data_type,
         x_coords, y_coords, z_idx,
         normalize_rmw, max_r_rmw, dr_rmw, shear_relative)
        for ci, rmw, sddc in cases_ready
    ]

    def _compute(progress_cb=None):
        accum_sum = None
        accum_count = None
        ov_accum_sum = None
        ov_accum_count = None
        n_processed = 0
        processed_indices: list[int] = []

        def _accum_pv(result):
            nonlocal accum_sum, accum_count, ov_accum_sum, ov_accum_count, n_processed
            ci, plan_2d, x_grid, y_grid, ov_2d = result
            if accum_sum is None:
                accum_sum = np.zeros((len(y_grid), len(x_grid)))
                accum_count = np.zeros_like(accum_sum)
            valid = ~np.isnan(plan_2d)
            accum_sum[valid] += plan_2d[valid]
            accum_count[valid] += 1
            if ov_2d is not None:
                if ov_accum_sum is None:
                    ov_accum_sum = np.zeros_like(ov_2d)
                    ov_accum_count = np.zeros_like(ov_2d)
                ov_valid = ~np.isnan(ov_2d)
                ov_accum_sum[ov_valid] += ov_2d[ov_valid]
                ov_accum_count[ov_valid] += 1
            n_processed += 1
            processed_indices.append(ci)

        _process_composites_batched(
            _process_one_case_plan_view, work_items, _accum_pv,
            progress_cb=progress_cb,
        )

        if n_processed == 0:
            raise RuntimeError("Could not process any matching cases.")

        min_cases = max(3, int(np.ceil(0.33 * n_processed)))
        composite = np.where(accum_count >= min_cases, accum_sum / accum_count, np.nan)

        if normalize_rmw:
            half_n = int(round(max_r_rmw / dr_rmw))
            x_out = np.linspace(-max_r_rmw, max_r_rmw, 2 * half_n + 1)
            y_out = np.linspace(-max_r_rmw, max_r_rmw, 2 * half_n + 1)
            x_label = "X / RMW"
            y_label = "Y / RMW"
        else:
            x_out = x_coords
            y_out = y_coords
            x_label = "Eastward distance (km)"
            y_label = "Northward distance (km)"

        result = {
            "plan_view": _clean_2d(composite),
            "x_axis": [round(float(v), 3) for v in x_out],
            "y_axis": [round(float(v), 3) for v in y_out],
            "x_label": x_label,
            "y_label": y_label,
            "level_km": round(actual_level, 2),
            "normalize_rmw": normalize_rmw,
            "shear_relative": shear_relative,
            "coverage_min": coverage_min,
            "min_cases_per_bin": min_cases,
            "n_cases": n_processed,
            "n_matched": len(matching),
            "n_with_valid_meta": len(cases_ready),
            "case_list": _build_case_list(processed_indices, data_type),
            "variable": {
                "key": variable,
                "display_name": display_name,
                "units": units,
                "vmin": vmin,
                "vmax": vmax,
                "colorscale": _cmap_to_plotly(cmap),
            },
            "filters": {
                "intensity": [min_intensity, max_intensity],
                "vmax_change": [min_vmax_change, max_vmax_change],
                "tilt": [min_tilt, max_tilt],
                "year": [min_year, max_year],
                "shear_mag": [min_shear_mag, max_shear_mag],
                "shear_dir": [min_shear_dir, max_shear_dir],
            },
        }

        if overlay and ov_accum_sum is not None:
            ov_composite = np.where(
                ov_accum_count >= min_cases, ov_accum_sum / ov_accum_count, np.nan
            )
            ov_display, _, _, ov_units, ov_vmin, ov_vmax = VARIABLES[overlay]
            clean_ov = _clean_2d(ov_composite)
            flat = [v for row in clean_ov for v in row if v is not None]
            result["overlay"] = {
                "display_name": ov_display,
                "key": overlay,
                "units": ov_units,
                "plan_view": clean_ov,
                "vmin": min(flat) if flat else ov_vmin,
                "vmax": max(flat) if flat else ov_vmax,
            }
        return result

    if stream:
        return _streaming_composite_response(_compute)
    return JSONResponse(_compute())


# ---------------------------------------------------------------------------
# IR Satellite Composite helpers & endpoints
# ---------------------------------------------------------------------------

# IR composite variable config — these are "virtual" variables not in VARIABLES dict
IR_COMPOSITE_VARIABLES = {
    "ir_brightness_temp": {
        "display_name": "IR Brightness Temperature",
        "units": "K",
        "vmin": 190,
        "vmax": 310,
        "colorscale": IR_COLORMAP,  # Enhanced IR colormap already defined above
    },
}


def _ir_latlon_to_km(lat_offsets, lon_offsets, center_lat):
    """
    Convert IR geographic offsets (degrees) to storm-centred Cartesian km.

    Uses simple spherical approximation:
        1° lat ≈ 111.32 km
        1° lon ≈ 111.32 * cos(lat) km
    """
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * np.cos(np.radians(center_lat))
    y_km = np.array(lat_offsets) * km_per_deg_lat
    x_km = np.array(lon_offsets) * km_per_deg_lon
    return x_km, y_km


def _extract_ir_2d(ir_store, ir_idx, center_lat, max_radius_km=500.0):
    """
    Extract the t=0 IR brightness temperature as a storm-centred 2D array
    in Cartesian km coordinates, cropped to max_radius_km.

    Returns (data_2d, x_km, y_km) or None on failure.
    """
    try:
        status = int(ir_store['status'][ir_idx])
    except (IndexError, KeyError):
        return None
    if status != 1:
        return None

    tb = ir_store['Tb'][ir_idx, 0]  # shape: (n_lat, n_lon), t=0 frame
    if np.all(np.isnan(tb)):
        return None

    lat_offsets = ir_store['lat_offsets'][:]
    lon_offsets = ir_store['lon_offsets'][:]
    x_km, y_km = _ir_latlon_to_km(lat_offsets, lon_offsets, center_lat)

    # Crop to storm-centred domain (±max_radius_km) to reduce memory
    x_mask = np.abs(x_km) <= max_radius_km
    y_mask = np.abs(y_km) <= max_radius_km

    if np.sum(x_mask) < 4 or np.sum(y_mask) < 4:
        return None

    x_km = x_km[x_mask]
    y_km = y_km[y_mask]
    tb_cropped = np.array(tb, dtype=np.float32)
    tb_cropped = tb_cropped[np.ix_(y_mask, x_mask)]

    return tb_cropped, x_km, y_km


def _process_one_case_ir_plan_view(case_idx, rmw, sddc, data_type,
                                    normalize_rmw, max_r_rmw, dr_rmw,
                                    shear_relative, max_radius_km):
    """
    Process a single case for IR plan-view composite.
    Reads from the IR Zarr store, converts to km, applies shear rotation
    and RMW normalization.
    """
    try:
        ir_store = get_ir_dataset()
        if ir_store is None:
            return None

        # Map merge case_index to swath index (IR Zarr is swath-indexed)
        ir_idx = case_idx
        if data_type == "merge":
            ir_idx = _merge_to_swath_index.get(case_idx)
            if ir_idx is None:
                return None

        center_lat = float(ir_store['center_lat'][ir_idx])
        result = _extract_ir_2d(ir_store, ir_idx, center_lat, max_radius_km)
        if result is None:
            return None

        data_2d, x_km, y_km = result

        # Shear-relative rotation
        if shear_relative and sddc is not None:
            rotation_angle = 90.0 - float(sddc)
            data_2d = _rotate_2d_grid(data_2d, rotation_angle)

        # RMW normalisation
        if normalize_rmw and rmw is not None and rmw > 0:
            data_2d, x_grid, y_grid = _regrid_to_rmw_normalized(
                data_2d, x_km, y_km, rmw, max_r_rmw, dr_rmw,
            )
        else:
            # Regrid to a common standard km grid (4 km spacing) so that
            # cases at different latitudes can be composited together.
            dx = 4.0  # km — matches MergedIR native resolution
            half_n = int(max_radius_km / dx)
            x_std = np.linspace(-max_radius_km, max_radius_km, 2 * half_n + 1)
            y_std = np.linspace(-max_radius_km, max_radius_km, 2 * half_n + 1)
            interp = RegularGridInterpolator(
                (y_km, x_km), data_2d,
                method="linear", bounds_error=False, fill_value=np.nan,
            )
            xx_s, yy_s = np.meshgrid(x_std, y_std)
            pts = np.column_stack([yy_s.ravel(), xx_s.ravel()])
            data_2d = interp(pts).reshape(len(y_std), len(x_std))
            x_grid, y_grid = x_std, y_std

        return (case_idx, data_2d, x_grid, y_grid, None)
    except Exception as e:
        print(f"Composite IR plan_view: skipping case {case_idx}: {e}")
        return None


def _process_one_case_ir_azimuthal(case_idx, rmw, data_type,
                                     max_radius, dr, coverage_min,
                                     max_radius_km):
    """
    Process a single case for IR azimuthal-mean composite.
    Computes azimuthal mean of IR Tb in storm-centred coordinates.
    Returns (case_idx, az_mean_1d, r_centers) or None.
    """
    try:
        ir_store = get_ir_dataset()
        if ir_store is None:
            return None

        ir_idx = case_idx
        if data_type == "merge":
            ir_idx = _merge_to_swath_index.get(case_idx)
            if ir_idx is None:
                return None

        center_lat = float(ir_store['center_lat'][ir_idx])
        result = _extract_ir_2d(ir_store, ir_idx, center_lat, max_radius_km)
        if result is None:
            return None

        data_2d, x_km, y_km = result

        # Build radius grid
        xx, yy = np.meshgrid(x_km, y_km)
        rr = np.sqrt(xx**2 + yy**2)

        # RMW-normalise if RMW is valid
        if rmw is not None and rmw > 0:
            rr = rr / rmw

        # Radial bins
        r_edges = np.arange(0, max_radius + dr, dr)
        r_centers = (r_edges[:-1] + r_edges[1:]) / 2.0
        n_rbins = len(r_centers)

        bin_idx = np.digitize(rr, r_edges) - 1
        valid = ~np.isnan(data_2d)

        az_mean = np.full(n_rbins, np.nan)
        for r in range(n_rbins):
            mask = (bin_idx == r)
            n_total = np.count_nonzero(mask)
            if n_total == 0:
                continue
            in_bin = mask & valid
            n_valid = np.count_nonzero(in_bin)
            frac = n_valid / n_total
            if frac >= coverage_min:
                az_mean[r] = float(np.nanmean(data_2d[in_bin]))

        return (case_idx, az_mean, r_centers)
    except Exception as e:
        print(f"Composite IR azimuthal: skipping case {case_idx}: {e}")
        return None


@app.get("/composite/ir_plan_view")
def composite_ir_plan_view(
    ir_variable:    str   = Query("ir_brightness_temp",  description="IR variable key"),
    data_type:      str   = Query("swath",               description="'swath' or 'merge'"),
    normalize_rmw:  bool  = Query(True,                  description="Normalise X/Y by RMW?"),
    max_r_rmw:      float = Query(5.0,  ge=1,   le=20,  description="Max extent in R/RMW"),
    dr_rmw:         float = Query(0.1,  ge=0.05, le=1,  description="Grid spacing in R/RMW"),
    shear_relative: bool  = Query(False,                 description="Rotate to shear-relative frame?"),
    coverage_min:   float = Query(0.25, ge=0.0,  le=1.0, description="Min coverage fraction"),
    max_radius_km:  float = Query(500.0, ge=100, le=1200, description="Max storm-centred domain radius (km)"),
    include_tilt:   bool  = Query(True,                  description="Include composite mean tilt overlay?"),
    stream:         bool  = Query(False,                 description="Stream NDJSON progress events"),
    min_intensity:  float = Query(0),    max_intensity:  float = Query(200),
    min_vmax_change:float = Query(-100), max_vmax_change:float = Query(85),
    min_tilt:       float = Query(0),    max_tilt:       float = Query(200),
    min_year:       int   = Query(1997), max_year:       int   = Query(2024),
    min_shear_mag:  float = Query(0),    max_shear_mag:  float = Query(100),
    min_shear_dir:  float = Query(0),    max_shear_dir:  float = Query(360),
    min_dtl:        float = Query(0),    dtl_window:     str   = Query("24h"),
):
    """Composite plan-view mean of IR brightness temperature."""

    if ir_variable not in IR_COMPOSITE_VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown IR variable '{ir_variable}'.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    ir_store = get_ir_dataset()
    if ir_store is None:
        raise HTTPException(status_code=503, detail="IR data not available (S3 not configured)")

    meta_cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache

    matching = _filter_cases_for_composite(
        min_intensity, max_intensity, min_vmax_change, max_vmax_change,
        min_tilt, max_tilt, min_year, max_year,
        min_shear_mag, max_shear_mag, min_shear_dir, max_shear_dir,
        min_dtl=min_dtl, dtl_window=dtl_window,
        data_type=data_type,
    )
    if not matching:
        raise HTTPException(status_code=400, detail="No cases match the specified criteria.")
    if len(matching) > _COMPOSITE_MAX_CASES:
        matching = matching[:_COMPOSITE_MAX_CASES]

    # Collect per-case metadata
    cases_ready = []
    for ci in matching:
        meta = meta_cache.get(ci, {})
        rmw = meta.get("rmw_km")
        if normalize_rmw:
            if rmw is None or np.isnan(float(rmw)) or float(rmw) <= 0:
                continue
        else:
            rmw = rmw if (rmw is not None and not np.isnan(float(rmw)) and float(rmw) > 0) else None

        sddc = meta.get("sddc") if shear_relative else None
        if shear_relative and sddc is None:
            continue

        # Check IR availability for this case
        ir_idx = ci
        if data_type == "merge":
            ir_idx = _merge_to_swath_index.get(ci)
            if ir_idx is None:
                continue
        try:
            if int(ir_store['status'][ir_idx]) != 1:
                continue
        except (IndexError, KeyError):
            continue

        cases_ready.append((ci, float(rmw) if rmw is not None else None, sddc))

    if not cases_ready:
        raise HTTPException(status_code=400, detail="No matching cases have valid IR data and required metadata.")

    var_info = IR_COMPOSITE_VARIABLES[ir_variable]

    work_items = [
        (ci, rmw, sddc, data_type,
         normalize_rmw, max_r_rmw, dr_rmw, shear_relative, max_radius_km)
        for ci, rmw, sddc in cases_ready
    ]

    def _compute(progress_cb=None):
        accum_sum = None
        accum_count = None
        n_processed = 0
        processed_indices = []

        def _accum(result):
            nonlocal accum_sum, accum_count, n_processed
            ci, plan_2d, x_grid, y_grid, _ = result
            if accum_sum is None:
                accum_sum = np.zeros((len(y_grid), len(x_grid)))
                accum_count = np.zeros_like(accum_sum)
            valid = ~np.isnan(plan_2d)
            accum_sum[valid] += plan_2d[valid]
            accum_count[valid] += 1
            n_processed += 1
            processed_indices.append(ci)

        _process_composites_batched(
            _process_one_case_ir_plan_view, work_items, _accum,
            progress_cb=progress_cb,
        )

        if n_processed == 0:
            raise RuntimeError("Could not process any matching IR cases.")

        min_cases = max(3, int(np.ceil(0.33 * n_processed)))
        composite = np.where(accum_count >= min_cases, accum_sum / accum_count, np.nan)

        if normalize_rmw:
            half_n = int(round(max_r_rmw / dr_rmw))
            x_out = np.linspace(-max_r_rmw, max_r_rmw, 2 * half_n + 1)
            y_out = np.linspace(-max_r_rmw, max_r_rmw, 2 * half_n + 1)
            x_label = "X / RMW"
            y_label = "Y / RMW"
        else:
            # Standard km grid (matches the regridding in the worker)
            dx = 4.0
            half_n = int(max_radius_km / dx)
            x_out = np.linspace(-max_radius_km, max_radius_km, 2 * half_n + 1)
            y_out = np.linspace(-max_radius_km, max_radius_km, 2 * half_n + 1)
            x_label = "Eastward distance (km)"
            y_label = "Northward distance (km)"

        # ── Composite mean tilt profile (optional) ──
        # Extract per-case tilt vectors, optionally normalize by RMW and
        # rotate to shear-relative, then average across cases.
        tilt_overlay = None
        if include_tilt:
            try:
                tilt_cases_x = []  # list of arrays (n_heights,)
                tilt_cases_y = []
                tilt_heights = None
                for ci, rmw_val, sddc_val in cases_ready:
                    if ci not in processed_indices:
                        continue
                    try:
                        ds, local_idx = resolve_case(ci, data_type)
                        tilt = _compute_tilt_profile(ds, local_idx, data_type)
                        if tilt is None:
                            continue
                        tx = np.array(tilt["x_km"], dtype=np.float64)
                        ty = np.array(tilt["y_km"], dtype=np.float64)
                        if tilt_heights is None:
                            tilt_heights = tilt["height_km"]
                        # RMW-normalize tilt displacement
                        if normalize_rmw and rmw_val is not None and rmw_val > 0:
                            tx = tx / rmw_val
                            ty = ty / rmw_val
                        # Shear-relative rotation
                        if shear_relative and sddc_val is not None:
                            angle_rad = np.radians(90.0 - float(sddc_val))
                            cos_a, sin_a = np.cos(angle_rad), np.sin(angle_rad)
                            tx_rot = cos_a * tx - sin_a * ty
                            ty_rot = sin_a * tx + cos_a * ty
                            tx, ty = tx_rot, ty_rot
                        tilt_cases_x.append(tx)
                        tilt_cases_y.append(ty)
                    except Exception:
                        continue

                if len(tilt_cases_x) >= 3 and tilt_heights is not None:
                    all_x = np.array(tilt_cases_x)  # (n_cases, n_heights)
                    all_y = np.array(tilt_cases_y)
                    mean_x = np.nanmean(all_x, axis=0)
                    mean_y = np.nanmean(all_y, axis=0)
                    tilt_overlay = {
                        "x": [round(float(v), 3) if np.isfinite(v) else None for v in mean_x],
                        "y": [round(float(v), 3) if np.isfinite(v) else None for v in mean_y],
                        "height_km": tilt_heights,
                        "n_cases": len(tilt_cases_x),
                    }
            except Exception as e:
                print(f"IR composite tilt overlay: skipped ({e})")

        result = {
            "plan_view": _clean_2d(composite),
            "x_axis": [round(float(v), 3) for v in x_out],
            "y_axis": [round(float(v), 3) for v in y_out],
            "x_label": x_label,
            "y_label": y_label,
            "normalize_rmw": normalize_rmw,
            "shear_relative": shear_relative,
            "coverage_min": coverage_min,
            "min_cases_per_bin": min_cases,
            "n_cases": n_processed,
            "n_matched": len(matching),
            "n_with_valid_meta": len(cases_ready),
            "case_list": _build_case_list(processed_indices, data_type),
            "variable": {
                "key": ir_variable,
                "display_name": var_info["display_name"],
                "units": var_info["units"],
                "vmin": var_info["vmin"],
                "vmax": var_info["vmax"],
                "colorscale": var_info["colorscale"],
            },
            "filters": {
                "intensity": [min_intensity, max_intensity],
                "vmax_change": [min_vmax_change, max_vmax_change],
                "tilt": [min_tilt, max_tilt],
                "year": [min_year, max_year],
                "shear_mag": [min_shear_mag, max_shear_mag],
                "shear_dir": [min_shear_dir, max_shear_dir],
            },
        }
        if tilt_overlay is not None:
            result["tilt_overlay"] = tilt_overlay

        return result

    if stream:
        return _streaming_composite_response(_compute)
    return JSONResponse(_compute())


@app.get("/composite/ir_azimuthal_mean")
def composite_ir_azimuthal_mean(
    ir_variable:    str   = Query("ir_brightness_temp",  description="IR variable key"),
    data_type:      str   = Query("swath",               description="'swath' or 'merge'"),
    normalize_rmw:  bool  = Query(True,                  description="Normalise radii by RMW"),
    max_r_rmw:      float = Query(8.0,  ge=1,   le=20,  description="Max radius in R/RMW (or km)"),
    dr_rmw:         float = Query(0.25, ge=0.05, le=2,  description="Radial bin width in R/RMW (or km)"),
    coverage_min:   float = Query(0.25, ge=0.0,  le=1.0),
    max_radius_km:  float = Query(500.0, ge=100, le=1200, description="Max storm-centred domain radius (km)"),
    stream:         bool  = Query(False,                 description="Stream NDJSON progress events"),
    min_intensity:  float = Query(0),    max_intensity:  float = Query(200),
    min_vmax_change:float = Query(-100), max_vmax_change:float = Query(85),
    min_tilt:       float = Query(0),    max_tilt:       float = Query(200),
    min_year:       int   = Query(1997), max_year:       int   = Query(2024),
    min_shear_mag:  float = Query(0),    max_shear_mag:  float = Query(100),
    min_shear_dir:  float = Query(0),    max_shear_dir:  float = Query(360),
    min_dtl:        float = Query(0),    dtl_window:     str   = Query("24h"),
):
    """Composite azimuthal-mean of IR brightness temperature."""

    if ir_variable not in IR_COMPOSITE_VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown IR variable '{ir_variable}'.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    ir_store = get_ir_dataset()
    if ir_store is None:
        raise HTTPException(status_code=503, detail="IR data not available (S3 not configured)")

    meta_cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache

    matching = _filter_cases_for_composite(
        min_intensity, max_intensity, min_vmax_change, max_vmax_change,
        min_tilt, max_tilt, min_year, max_year,
        min_shear_mag, max_shear_mag, min_shear_dir, max_shear_dir,
        min_dtl=min_dtl, dtl_window=dtl_window,
        data_type=data_type,
    )
    if not matching:
        raise HTTPException(status_code=400, detail="No cases match the specified criteria.")
    if len(matching) > _COMPOSITE_MAX_CASES:
        matching = matching[:_COMPOSITE_MAX_CASES]

    cases_ready = []
    for ci in matching:
        meta = meta_cache.get(ci, {})
        rmw = meta.get("rmw_km")
        if normalize_rmw:
            if rmw is None or np.isnan(float(rmw)) or float(rmw) <= 0:
                continue
        else:
            rmw = rmw if (rmw is not None and not np.isnan(float(rmw)) and float(rmw) > 0) else None

        ir_idx = ci
        if data_type == "merge":
            ir_idx = _merge_to_swath_index.get(ci)
            if ir_idx is None:
                continue
        try:
            if int(ir_store['status'][ir_idx]) != 1:
                continue
        except (IndexError, KeyError):
            continue

        cases_ready.append((ci, float(rmw) if rmw is not None else None))

    if not cases_ready:
        raise HTTPException(status_code=400, detail="No matching cases have valid IR data and RMW.")

    var_info = IR_COMPOSITE_VARIABLES[ir_variable]

    work_items = [
        (ci, rmw, data_type, max_r_rmw, dr_rmw, coverage_min, max_radius_km)
        for ci, rmw in cases_ready
    ]

    def _compute(progress_cb=None):
        accum_sum = None
        accum_count = None
        n_processed = 0
        processed_indices = []

        def _accum_az(result):
            nonlocal accum_sum, accum_count, n_processed
            ci, az_mean_1d, r_centers = result
            if accum_sum is None:
                accum_sum = np.zeros(len(r_centers))
                accum_count = np.zeros_like(accum_sum)
            valid = ~np.isnan(az_mean_1d)
            accum_sum[valid] += az_mean_1d[valid]
            accum_count[valid] += 1
            n_processed += 1
            processed_indices.append(ci)

        _process_composites_batched(
            _process_one_case_ir_azimuthal, work_items, _accum_az,
            progress_cb=progress_cb,
        )

        if n_processed == 0:
            raise RuntimeError("Could not process any matching IR cases.")

        min_cases = max(3, int(np.ceil(0.33 * n_processed)))
        composite_1d = np.where(accum_count >= min_cases, accum_sum / accum_count, np.nan)

        r_edges = np.arange(0, max_r_rmw + dr_rmw, dr_rmw)
        r_centers = ((r_edges[:-1] + r_edges[1:]) / 2.0).tolist()
        r_label = "R / RMW" if normalize_rmw else "Radius (km)"

        return {
            "radial_profile": [None if np.isnan(v) else round(float(v), 2) for v in composite_1d],
            "r_centers": [round(float(v), 3) for v in r_centers],
            "r_label": r_label,
            "normalize_rmw": normalize_rmw,
            "coverage_min": coverage_min,
            "min_cases_per_bin": min_cases,
            "n_cases": n_processed,
            "n_matched": len(matching),
            "n_with_valid_meta": len(cases_ready),
            "case_list": _build_case_list(processed_indices, data_type),
            "variable": {
                "key": ir_variable,
                "display_name": var_info["display_name"],
                "units": var_info["units"],
                "vmin": var_info["vmin"],
                "vmax": var_info["vmax"],
                "colorscale": var_info["colorscale"],
            },
            "filters": {
                "intensity": [min_intensity, max_intensity],
                "vmax_change": [min_vmax_change, max_vmax_change],
                "tilt": [min_tilt, max_tilt],
                "year": [min_year, max_year],
                "shear_mag": [min_shear_mag, max_shear_mag],
                "shear_dir": [min_shear_dir, max_shear_dir],
            },
        }

    if stream:
        return _streaming_composite_response(_compute)
    return JSONResponse(_compute())


# ---------------------------------------------------------------------------
# Composite CFAD (Contoured Frequency by Altitude Diagram) endpoint
# ---------------------------------------------------------------------------

def _process_one_case_cfad(case_idx, variable, data_type, height_km, h_axis,
                           x_coords, y_coords, bin_edges,
                           min_radius, max_radius,
                           rmw=None, sddc=None, quadrants=None):
    """
    Process a single case for CFAD: at each height, histogram all spatial
    pixel values into the caller-supplied bin_edges.

    Parameters
    ----------
    min_radius, max_radius : float
        Radial bounds in km, or in R/RMW if rmw is provided.
    rmw : float or None
        If given and > 0, radii are normalised by RMW before applying the
        min/max radius filter.
    sddc : float or None
        Deep-layer shear heading (met deg).  Required when quadrants is set.
    quadrants : list[str] or None
        Subset of QUADRANT_DEFS keys (e.g. ["DSL", "DSR"]).  If None or empty,
        all azimuths are included.

    Returns (case_idx, histogram_2d) — shape (n_heights, n_bins) — or None.
    """
    try:
        ds, local_idx = resolve_case(case_idx, data_type)
        vol, _ = _extract_3d_volume(ds, local_idx, variable)

        n_heights = len(height_km)
        n_bins = len(bin_edges) - 1

        # 2-D radius grid
        xx, yy = np.meshgrid(x_coords, y_coords)
        rr = np.sqrt(xx**2 + yy**2)
        if rmw is not None and rmw > 0:
            rr_norm = rr / rmw
        else:
            rr_norm = rr

        # Radial annulus mask (min ≤ r ≤ max)
        spatial_mask = (rr_norm >= min_radius) & (rr_norm <= max_radius)

        # Optional shear-relative quadrant mask
        if quadrants and sddc is not None:
            azimuth_math_deg = np.degrees(np.arctan2(yy, xx))
            azimuth_met = (90.0 - azimuth_math_deg) % 360.0
            shear_rel_az = (azimuth_met - sddc) % 360.0
            quad_mask = np.zeros_like(rr, dtype=bool)
            for qname in quadrants:
                az_start, az_end = QUADRANT_DEFS[qname]
                quad_mask |= (shear_rel_az >= az_start) & (shear_rel_az < az_end)
            spatial_mask = spatial_mask & quad_mask

        hist_2d = np.zeros((n_heights, n_bins), dtype=np.float64)

        for h in range(n_heights):
            if h_axis == 0:
                slab = vol[h, :, :]
            elif h_axis == 2:
                slab = vol[:, :, h]
            else:
                slab = vol[:, h, :]

            vals = slab[spatial_mask & ~np.isnan(slab)]
            if len(vals) == 0:
                continue
            counts, _ = np.histogram(vals, bins=bin_edges)
            hist_2d[h, :] = counts

        return (case_idx, hist_2d)
    except Exception as e:
        print(f"Composite CFAD: skipping case {case_idx}: {e}")
        return None


def _process_one_case_cfad_multi(case_idx, variable, data_type, height_km, h_axis,
                                  x_coords, y_coords, bin_edges,
                                  min_radius, max_radius,
                                  rmw=None, sddc=None, quadrants_unused=None):
    """
    Process a single case for MULTI-quadrant CFAD: compute histograms for all
    four shear-relative quadrants (DSL, DSR, USL, USR) in one data load.

    Returns (case_idx, {qname: hist_2d}) or None.
    """
    try:
        ds, local_idx = resolve_case(case_idx, data_type)
        vol, _ = _extract_3d_volume(ds, local_idx, variable)

        n_heights = len(height_km)
        n_bins = len(bin_edges) - 1

        xx, yy = np.meshgrid(x_coords, y_coords)
        rr = np.sqrt(xx**2 + yy**2)
        if rmw is not None and rmw > 0:
            rr_norm = rr / rmw
        else:
            rr_norm = rr

        # Radial annulus mask
        radial_mask = (rr_norm >= min_radius) & (rr_norm <= max_radius)

        # Compute shear-relative azimuths
        azimuth_math_deg = np.degrees(np.arctan2(yy, xx))
        azimuth_met = (90.0 - azimuth_math_deg) % 360.0
        shear_rel_az = (azimuth_met - sddc) % 360.0

        quad_hists = {}
        for qname, (az_start, az_end) in QUADRANT_DEFS.items():
            quad_mask = radial_mask & (shear_rel_az >= az_start) & (shear_rel_az < az_end)
            hist_2d = np.zeros((n_heights, n_bins), dtype=np.float64)
            for h in range(n_heights):
                if h_axis == 0:
                    slab = vol[h, :, :]
                elif h_axis == 2:
                    slab = vol[:, :, h]
                else:
                    slab = vol[:, h, :]
                vals = slab[quad_mask & ~np.isnan(slab)]
                if len(vals) == 0:
                    continue
                counts, _ = np.histogram(vals, bins=bin_edges)
                hist_2d[h, :] = counts
            quad_hists[qname] = hist_2d

        return (case_idx, quad_hists)
    except Exception as e:
        print(f"Composite CFAD-MULTI: skipping case {case_idx}: {e}")
        return None


@app.get("/composite/cfad")
def composite_cfad(
    variable:      str   = Query(DEFAULT_VARIABLE,       description="Variable key"),
    data_type:     str   = Query("swath",                description="'swath' or 'merge'"),
    bin_min:       float = Query(None,                   description="Lower edge of first bin (auto from variable if omitted)"),
    bin_max:       float = Query(None,                   description="Upper edge of last bin (auto from variable if omitted)"),
    bin_width:     float = Query(None,                   description="Bin width (auto-calculated if omitted)"),
    n_bins:        int   = Query(40,   ge=5, le=200,     description="Number of bins (used when bin_width not given)"),
    min_radius:    float = Query(0,    ge=0,  le=500,    description="Minimum radius (km, or R/RMW if use_rmw)"),
    max_radius:    float = Query(200,  ge=0.1, le=500,   description="Maximum radius (km, or R/RMW if use_rmw)"),
    use_rmw:       bool  = Query(False,                  description="Normalise radius by RMW (radii become R/RMW)"),
    quadrants:     str   = Query("",                     description="Shear-relative quadrant filter: comma-separated from DSL,DSR,USL,USR (empty = all)"),
    normalise:     str   = Query("height",               description="'height' = % at each level (standard CFAD); 'total' = % of all pixels; 'raw' = counts"),
    stream:        bool  = Query(False,                  description="Stream NDJSON progress events"),
    min_intensity:  float = Query(0),    max_intensity:  float = Query(200),
    min_vmax_change:float = Query(-100), max_vmax_change:float = Query(85),
    min_tilt:       float = Query(0),    max_tilt:       float = Query(200),
    min_year:       int   = Query(1997), max_year:       int   = Query(2024),
    min_shear_mag:  float = Query(0),    max_shear_mag:  float = Query(100),
    min_shear_dir:  float = Query(0),    max_shear_dir:  float = Query(360),
    min_dtl:        float = Query(0),    dtl_window:     str   = Query("24h"),
):
    """Compute a Contoured Frequency by Altitude Diagram across matching cases."""
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")
    if normalise not in ("total", "height", "raw"):
        raise HTTPException(status_code=400, detail="normalise must be 'total', 'height', or 'raw'")

    # Parse quadrant filter
    multi_mode = quadrants.strip().upper() == "MULTI"
    quad_list = None
    if not multi_mode and quadrants.strip():
        quad_list = [q.strip().upper() for q in quadrants.split(",") if q.strip()]
        invalid = [q for q in quad_list if q not in QUADRANT_DEFS]
        if invalid:
            raise HTTPException(status_code=400,
                                detail=f"Invalid quadrant(s): {invalid}. Use DSL, DSR, USL, USR, or MULTI.")
    need_shear = bool(quad_list) or multi_mode

    meta_cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    matching = _filter_cases_for_composite(
        min_intensity, max_intensity, min_vmax_change, max_vmax_change,
        min_tilt, max_tilt, min_year, max_year,
        min_shear_mag, max_shear_mag, min_shear_dir, max_shear_dir,
        min_dtl=min_dtl, dtl_window=dtl_window,
        data_type=data_type,
    )
    if not matching:
        raise HTTPException(status_code=400, detail="No cases match the specified criteria.")
    if len(matching) > _COMPOSITE_MAX_CASES:
        matching = matching[:_COMPOSITE_MAX_CASES]

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    ref_varname = DERIVED_VARIABLES[variable][0] if variable in DERIVED_VARIABLES else varname

    # Determine bin edges
    b_min = bin_min if bin_min is not None else vmin
    b_max = bin_max if bin_max is not None else vmax
    if bin_width is not None and bin_width > 0:
        bin_edges = np.arange(b_min, b_max + bin_width * 0.5, bin_width)
    else:
        bin_edges = np.linspace(b_min, b_max, n_bins + 1)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2.0
    actual_n_bins = len(bin_centers)

    # Pre-fetch grid info
    first_ds, _ = resolve_case(matching[0], data_type)
    height_km = first_ds["height"].values
    x_coords, y_coords, h_axis = _resolve_grid_and_haxis(first_ds, ref_varname)

    # Build cases list: filter by RMW (if needed) and look up SDDC (if quadrant filtering)
    cases_to_process = []
    for ci in matching:
        meta = meta_cache.get(ci, {})
        rmw_val = None
        if use_rmw:
            rmw = meta.get("rmw_km")
            if rmw is None or np.isnan(float(rmw)) or float(rmw) <= 0:
                continue
            rmw_val = float(rmw)
        sddc_val = None
        if need_shear:
            sddc_val = meta.get("sddc")
            if sddc_val is None:
                continue  # skip cases without shear data when quadrant filtering
        cases_to_process.append((ci, rmw_val, sddc_val))

    if not cases_to_process:
        detail = "No matching cases have valid "
        if use_rmw and need_shear:
            detail += "RMW and shear data."
        elif use_rmw:
            detail += "RMW data."
        else:
            detail += "shear data."
        raise HTTPException(status_code=400, detail=detail)

    # Choose worker function and build work items
    worker_fn = _process_one_case_cfad_multi if multi_mode else _process_one_case_cfad
    work_items = [
        (case_idx, variable, data_type, height_km, h_axis,
         x_coords, y_coords, bin_edges,
         min_radius, max_radius,
         rmw, sddc_val, quad_list)
        for case_idx, rmw, sddc_val in cases_to_process
    ]

    def _normalise_array(accum):
        if normalise == "total":
            total = np.nansum(accum)
            if total > 0:
                return (accum / total) * 100.0
            return accum
        elif normalise == "height":
            row_sums = np.nansum(accum, axis=1, keepdims=True)
            row_sums[row_sums == 0] = 1
            return (accum / row_sums) * 100.0
        return accum  # raw

    def _compute(progress_cb=None):
        n_processed = 0
        processed_indices = []

        if multi_mode:
            accum_multi = {}  # {qname: ndarray}

            def _accum_cfad(result):
                nonlocal n_processed
                case_idx, quad_hists = result
                for qname, hist_2d in quad_hists.items():
                    if qname not in accum_multi:
                        accum_multi[qname] = np.zeros_like(hist_2d)
                    accum_multi[qname] += hist_2d
                n_processed += 1
                processed_indices.append(case_idx)
        else:
            accum = None

            def _accum_cfad(result):
                nonlocal accum, n_processed
                case_idx, hist_2d = result
                if accum is None:
                    accum = np.zeros_like(hist_2d)
                accum += hist_2d
                n_processed += 1
                processed_indices.append(case_idx)

        _process_composites_batched(
            worker_fn, work_items, _accum_cfad,
            progress_cb=progress_cb,
        )

        if n_processed == 0:
            raise RuntimeError("Could not process any matching cases.")

        norm_label = {"total": "% of total", "height": "% at each height"}.get(normalise, "count")

        base_result = {
            "bin_centers": [round(float(b), 4) for b in bin_centers],
            "bin_edges": [round(float(b), 4) for b in bin_edges],
            "bin_width": round(float(bin_edges[1] - bin_edges[0]), 4),
            "height_km": [round(float(h), 2) for h in height_km],
            "normalise": normalise,
            "norm_label": norm_label,
            "n_cases": n_processed,
            "n_matched": len(matching),
            "n_processed": len(cases_to_process),
            "case_list": _build_case_list(processed_indices, data_type),
            "variable": {
                "key": variable,
                "display_name": display_name,
                "units": units,
                "vmin": vmin,
                "vmax": vmax,
                "colorscale": _cmap_to_plotly(cmap),
            },
            "cfad_colorscale": _cmap_to_plotly("Spectral_r"),
            "radial_domain": [min_radius, max_radius],
            "use_rmw": use_rmw,
            "filters": {
                "intensity": [min_intensity, max_intensity],
                "vmax_change": [min_vmax_change, max_vmax_change],
                "tilt": [min_tilt, max_tilt],
                "year": [min_year, max_year],
                "shear_mag": [min_shear_mag, max_shear_mag],
                "shear_dir": [min_shear_dir, max_shear_dir],
            },
        }

        if multi_mode:
            base_result["multi"] = True
            base_result["quadrants"] = ["MULTI"]
            base_result["cfad_multi"] = {
                qname: _clean_2d(_normalise_array(arr))
                for qname, arr in accum_multi.items()
            }
        else:
            base_result["multi"] = False
            base_result["quadrants"] = quad_list or []
            base_result["cfad"] = _clean_2d(_normalise_array(accum))

        return base_result

    if stream:
        return _streaming_composite_response(_compute)
    return JSONResponse(_compute())


# ---------------------------------------------------------------------------
# Single-case CFAD endpoint
# ---------------------------------------------------------------------------

@app.get("/cfad/single")
def single_case_cfad(
    case_index:    int   = Query(...,                      description="Case index"),
    variable:      str   = Query(DEFAULT_VARIABLE,         description="Variable key"),
    data_type:     str   = Query("swath",                  description="'swath', 'merge', or 'tilt'"),
    era:           str   = Query("",                       description="Era tag (empty = auto-detect)"),
    bin_min:       float = Query(None,                     description="Lower edge of first bin (auto if omitted)"),
    bin_max:       float = Query(None,                     description="Upper edge of last bin (auto if omitted)"),
    bin_width:     float = Query(None,                     description="Bin width (auto if omitted)"),
    n_bins:        int   = Query(40,   ge=5, le=200,       description="Number of bins (used when bin_width not given)"),
    min_radius:    float = Query(0,    ge=0,  le=500,      description="Minimum radius (km)"),
    max_radius:    float = Query(200,  ge=0.1, le=500,     description="Maximum radius (km)"),
    normalise:     str   = Query("height",                 description="'height' = % at each level; 'total' = % of all; 'raw' = counts"),
):
    """Compute a CFAD for a single case/analysis."""
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if normalise not in ("total", "height", "raw"):
        raise HTTPException(status_code=400, detail="normalise must be 'total', 'height', or 'raw'")

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    ref_varname = DERIVED_VARIABLES[variable][0] if variable in DERIVED_VARIABLES else varname

    # Bin edges
    b_min = bin_min if bin_min is not None else vmin
    b_max = bin_max if bin_max is not None else vmax
    if bin_width is not None and bin_width > 0:
        bin_edges = np.arange(b_min, b_max + bin_width * 0.5, bin_width)
    else:
        bin_edges = np.linspace(b_min, b_max, n_bins + 1)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2.0

    # Load volume
    try:
        ds, local_idx = resolve_case(case_index, data_type)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Could not load case {case_index}: {e}")

    height_km = ds["height"].values
    x_coords, y_coords, h_axis = _resolve_grid_and_haxis(ds, ref_varname)
    vol, _ = _extract_3d_volume(ds, local_idx, variable)

    n_heights = len(height_km)
    actual_n_bins = len(bin_centers)

    # Radial mask
    xx, yy = np.meshgrid(x_coords, y_coords)
    rr = np.sqrt(xx**2 + yy**2)
    spatial_mask = (rr >= min_radius) & (rr <= max_radius)

    # Histogram at each height
    hist_2d = np.zeros((n_heights, actual_n_bins), dtype=np.float64)
    for h in range(n_heights):
        if h_axis == 0:
            slab = vol[h, :, :]
        elif h_axis == 2:
            slab = vol[:, :, h]
        else:
            slab = vol[:, h, :]
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

    # Case metadata
    meta_cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    case_meta = meta_cache.get(case_index, {})

    return JSONResponse({
        "cfad": _clean_2d(hist_2d),
        "bin_centers": [round(float(b), 4) for b in bin_centers],
        "bin_edges": [round(float(b), 4) for b in bin_edges],
        "bin_width": round(float(bin_edges[1] - bin_edges[0]), 4),
        "height_km": [round(float(h), 2) for h in height_km],
        "normalise": normalise,
        "norm_label": norm_label,
        "variable": {
            "key": variable,
            "display_name": display_name,
            "units": units,
            "vmin": vmin,
            "vmax": vmax,
        },
        "cfad_colorscale": _cmap_to_plotly("Spectral_r"),
        "radial_domain": [min_radius, max_radius],
        "case_index": case_index,
        "case_meta": {
            "storm_id": case_meta.get("storm_id", ""),
            "storm_name": case_meta.get("storm_name", ""),
            "vmax": case_meta.get("vmax"),
            "latitude": case_meta.get("latitude"),
            "longitude": case_meta.get("longitude"),
        },
    })


# ---------------------------------------------------------------------------
# Environmental composite endpoints (ERA5)
# ---------------------------------------------------------------------------

# Common target grid for storm-relative km compositing
_ENV_COMP_GRID_KM = np.linspace(-1100, 1100, 81)  # ±1100 km at ~27 km spacing


def _process_one_case_era5_plan_view(case_idx, field, include_vectors, target_x_km, target_y_km,
                                     sddc=None):
    """
    Process a single case for ERA5 environmental plan-view composite.
    Regrids from degree-offset to a common km grid.
    If sddc is not None, rotate to shear-relative frame (shear → +x).
    Returns (case_idx, data_km, vec_u_km, vec_v_km) or None.
    """
    try:
        era5 = get_era5_dataset()
        if era5 is None:
            return None
        status = int(era5['status'][case_idx])
        if status != 1:
            return None

        data_deg = era5[field][case_idx]  # (81, 81) in degree offsets
        center_lat = float(era5['center_lat'][case_idx])
        lat_offsets = era5['lat_offsets'][:]
        lon_offsets = era5['lon_offsets'][:]

        # Convert degree offsets to km
        y_km_src = lat_offsets * 111.0
        x_km_src = lon_offsets * 111.0 * np.cos(np.deg2rad(center_lat))

        # Regrid onto common km grid
        interp = RegularGridInterpolator(
            (y_km_src, x_km_src), np.array(data_deg, dtype=np.float64),
            method='linear', bounds_error=False, fill_value=np.nan
        )
        yy, xx = np.meshgrid(target_y_km, target_x_km, indexing='ij')
        data_km = interp((yy, xx)).astype(np.float32)

        # Shear-relative rotation: rotate so shear vector points right (+x)
        # Same convention as TDR plan-view: rotation_angle = 90 - SDDC
        if sddc is not None:
            rotation_angle = 90.0 - float(sddc)
            data_km = _rotate_2d_grid(data_km, rotation_angle)

        vec_u_km = None
        vec_v_km = None
        if include_vectors:
            cfg = ERA5_FIELD_CONFIG.get(field, {})
            if cfg.get('has_vectors'):
                u_data = era5[cfg['vector_u']][case_idx]
                v_data = era5[cfg['vector_v']][case_idx]
                interp_u = RegularGridInterpolator(
                    (y_km_src, x_km_src), np.array(u_data, dtype=np.float64),
                    method='linear', bounds_error=False, fill_value=np.nan
                )
                interp_v = RegularGridInterpolator(
                    (y_km_src, x_km_src), np.array(v_data, dtype=np.float64),
                    method='linear', bounds_error=False, fill_value=np.nan
                )
                vec_u_km = interp_u((yy, xx)).astype(np.float32)
                vec_v_km = interp_v((yy, xx)).astype(np.float32)

                # Rotate vector field to shear-relative frame
                if sddc is not None:
                    vec_u_km = _rotate_2d_grid(vec_u_km, rotation_angle)
                    vec_v_km = _rotate_2d_grid(vec_v_km, rotation_angle)
                    # Also rotate the vector components themselves
                    # (rotating the grid moves pixels, but vectors still point
                    #  in their original directions — we must also rotate them)
                    theta_rad = np.deg2rad(rotation_angle)
                    cos_t, sin_t = np.cos(theta_rad), np.sin(theta_rad)
                    u_rot =  cos_t * vec_u_km + sin_t * vec_v_km
                    v_rot = -sin_t * vec_u_km + cos_t * vec_v_km
                    vec_u_km, vec_v_km = u_rot, v_rot

        return (case_idx, data_km, vec_u_km, vec_v_km)
    except Exception as e:
        print(f"Composite era5_plan_view: skipping case {case_idx}: {e}")
        return None


@app.get("/composite/era5_plan_view")
def composite_era5_plan_view(
    filters: dict = Depends(_composite_filter_params),
    field: str = Query("shear_mag", description="ERA5 field name"),
    radius_km: float = Query(500, ge=100, le=1100, description="Crop radius (km)"),
    include_vectors: bool = Query(False, description="Include vector components"),
    shear_relative: bool = Query(False, description="Rotate to shear-relative frame?"),
    data_type: str = Query("swath", description="'swath' or 'merge'"),
    stream: bool = Query(False, description="Stream NDJSON progress events"),
):
    """Composite mean + std of an ERA5 2D field in storm-relative km coordinates."""
    era5 = get_era5_dataset()
    if era5 is None:
        raise HTTPException(status_code=503, detail="ERA5 data not available")
    if field not in ERA5_FIELD_CONFIG:
        raise HTTPException(status_code=400, detail=f"Unknown field: {field}")

    matching = _filter_cases_for_composite(**filters, data_type=data_type)
    if not matching:
        raise HTTPException(status_code=404, detail="No matching cases")

    # Filter to cases with ERA5 data
    era5_status = era5['status'][:]
    matching = [ci for ci in matching if ci < len(era5_status) and int(era5_status[ci]) == 1]
    if not matching:
        raise HTTPException(status_code=404, detail="No matching cases with ERA5 data")

    # If shear_relative, look up SDDC per case from metadata and skip cases without it
    meta_cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    cases_with_sddc: list[tuple] = []  # (case_idx, sddc_or_None)
    for ci in matching[:_COMPOSITE_MAX_CASES]:
        if shear_relative:
            meta = meta_cache.get(ci, {})
            sddc = meta.get("sddc")
            if sddc is None or sddc == 9999:
                continue  # need valid SDDC for rotation
            cases_with_sddc.append((ci, float(sddc)))
        else:
            cases_with_sddc.append((ci, None))

    if not cases_with_sddc:
        detail = "No matching cases with ERA5 data"
        if shear_relative:
            detail += " and valid shear direction (SDDC)"
        raise HTTPException(status_code=404, detail=detail)

    target_x_km = _ENV_COMP_GRID_KM.copy()
    target_y_km = _ENV_COMP_GRID_KM.copy()
    grid_shape = (len(target_y_km), len(target_x_km))

    # Process cases in batches — keeps peak memory bounded on the 2 GB Render plan.
    work_items = [
        (ci, field, include_vectors, target_x_km, target_y_km, sddc)
        for ci, sddc in cases_with_sddc
    ]

    def _compute(progress_cb=None):
        accum_sum = np.zeros(grid_shape, dtype=np.float64)
        accum_sq = np.zeros(grid_shape, dtype=np.float64)
        accum_count = np.zeros(grid_shape, dtype=np.float64)
        vec_u_sum = np.zeros(grid_shape, dtype=np.float64) if include_vectors else None
        vec_v_sum = np.zeros(grid_shape, dtype=np.float64) if include_vectors else None
        vec_count = np.zeros(grid_shape, dtype=np.float64) if include_vectors else None
        processed = []

        def _accum_era5(result):
            nonlocal vec_u_sum, vec_v_sum, vec_count
            ci, data_km, vu, vv = result
            valid = np.isfinite(data_km)
            accum_sum[valid] += data_km[valid]
            accum_sq[valid] += data_km[valid] ** 2
            accum_count[valid] += 1
            if include_vectors and vu is not None:
                vu_valid = np.isfinite(vu)
                vec_u_sum[vu_valid] += vu[vu_valid]
                vv_valid = np.isfinite(vv)
                vec_v_sum[vv_valid] += vv[vv_valid]
                vec_count[vu_valid] += 1
            processed.append(ci)

        _process_composites_batched(
            _process_one_case_era5_plan_view, work_items, _accum_era5,
            progress_cb=progress_cb,
        )

        n_cases = len(processed)
        if n_cases == 0:
            raise RuntimeError("No valid ERA5 cases processed")

        min_cases = max(2, int(0.33 * n_cases))
        mean_2d = np.where(accum_count >= min_cases, accum_sum / accum_count, np.nan)
        variance = np.where(
            accum_count >= min_cases,
            accum_sq / accum_count - (accum_sum / accum_count) ** 2,
            np.nan
        )
        std_2d = np.sqrt(np.maximum(variance, 0))

        yy, xx = np.meshgrid(target_y_km, target_x_km, indexing='ij')
        dist = np.sqrt(xx**2 + yy**2)
        crop_mask = dist > radius_km
        mean_2d[crop_mask] = np.nan
        std_2d[crop_mask] = np.nan

        cfg = ERA5_FIELD_CONFIG[field]
        response = {
            "field": field,
            "field_config": cfg,
            "mean": _clean_2d(mean_2d),
            "std": _clean_2d(std_2d),
            "x_km": [round(float(v), 1) for v in target_x_km],
            "y_km": [round(float(v), 1) for v in target_y_km],
            "n_cases": n_cases,
            "shear_relative": shear_relative,
            "case_list": _build_case_list(processed, data_type),
        }

        if include_vectors and vec_u_sum is not None:
            vec_mean_u = np.where(vec_count >= min_cases, vec_u_sum / vec_count, np.nan)
            vec_mean_v = np.where(vec_count >= min_cases, vec_v_sum / vec_count, np.nan)
            vec_mean_u[crop_mask] = np.nan
            vec_mean_v[crop_mask] = np.nan
            stride = max(1, len(target_x_km) // 12)
            response["vectors"] = {
                "u": _clean_2d(vec_mean_u[::stride, ::stride]),
                "v": _clean_2d(vec_mean_v[::stride, ::stride]),
                "stride": stride,
            }
        return response

    if stream:
        return _streaming_composite_response(_compute)
    return JSONResponse(_compute())


@app.get("/composite/era5_profiles")
def composite_era5_profiles(
    filters: dict = Depends(_composite_filter_params),
    data_type: str = Query("swath", description="'swath' or 'merge'"),
):
    """
    Composite mean +/- std vertical profiles (T, Td, RH, u, v, theta, theta_e)
    from precomputed ERA5 200-600 km annulus profiles.
    """
    era5 = get_era5_dataset()
    if era5 is None:
        raise HTTPException(status_code=503, detail="ERA5 data not available")

    matching = _filter_cases_for_composite(**filters, data_type=data_type)
    if not matching:
        raise HTTPException(status_code=404, detail="No matching cases")

    era5_status = era5['status'][:]
    matching = [ci for ci in matching if ci < len(era5_status) and int(era5_status[ci]) == 1]
    if not matching:
        raise HTTPException(status_code=404, detail="No matching cases with ERA5 data")

    matching = matching[:_COMPOSITE_MAX_CASES]

    plev = era5['plev'][:].astype(float)
    n_lev = len(plev)
    n_cases = len(matching)

    t_all = np.full((n_cases, n_lev), np.nan, dtype=np.float64)
    q_all = np.full((n_cases, n_lev), np.nan, dtype=np.float64)
    rh_all = np.full((n_cases, n_lev), np.nan, dtype=np.float64)
    u_all = np.full((n_cases, n_lev), np.nan, dtype=np.float64)
    v_all = np.full((n_cases, n_lev), np.nan, dtype=np.float64)

    valid_count = 0
    for i, ci in enumerate(matching):
        try:
            t_all[i] = era5['t_profile'][ci].astype(float)
            q_all[i] = era5['q_profile'][ci].astype(float)
            rh_all[i] = era5['rh_profile'][ci].astype(float)
            u_all[i] = era5['u_profile'][ci].astype(float)
            v_all[i] = era5['v_profile'][ci].astype(float)
            valid_count += 1
        except Exception:
            pass

    if valid_count < 2:
        raise HTTPException(status_code=404, detail="Insufficient valid profiles")

    q_kgkg = q_all.copy()
    if np.nanmax(q_all) > 0.5:
        q_kgkg = q_all / 1000.0

    # Dewpoint from specific humidity and pressure (vectorized per level)
    td_all = np.full_like(t_all, np.nan)
    for lev in range(n_lev):
        p_pa = plev[lev] * 100.0
        q_lev = q_kgkg[:, lev]
        t_lev = t_all[:, lev]
        valid_mask = np.isfinite(q_lev) & (q_lev > 0) & np.isfinite(t_lev)
        if not valid_mask.any():
            continue
        e = q_lev[valid_mask] * p_pa / (0.622 + 0.378 * q_lev[valid_mask])
        e_sat = 610.94 * np.exp(17.625 * (t_lev[valid_mask] - 273.15) / (t_lev[valid_mask] - 273.15 + 243.04))
        e = np.minimum(e, e_sat)
        e = np.maximum(e, 1e-3)
        ln_e = np.log(e / 611.2)
        td_c = 243.5 * ln_e / (17.67 - ln_e)
        td_all[valid_mask, lev] = td_c + 273.15

    Rd_Cp = 287.04 / 1005.7
    theta_all = t_all * (1000.0 / plev[np.newaxis, :]) ** Rd_Cp
    Lv, Cpd = 2.501e6, 1005.7
    theta_e_all = theta_all * np.exp(Lv * q_kgkg / (Cpd * t_all))

    def _profile_stats(arr, decimals=2):
        mean = np.nanmean(arr, axis=0)
        std = np.nanstd(arr, axis=0)
        med = np.nanmedian(arr, axis=0)
        p25 = np.nanpercentile(arr, 25, axis=0)
        p75 = np.nanpercentile(arr, 75, axis=0)
        pmin = np.nanmin(arr, axis=0)
        pmax = np.nanmax(arr, axis=0)
        count = np.sum(np.isfinite(arr), axis=0)

        def _to_list(a, d=decimals):
            return [round(float(v), d) if np.isfinite(v) else None for v in a]

        return {
            "mean": _to_list(mean), "std": _to_list(std),
            "median": _to_list(med), "p25": _to_list(p25), "p75": _to_list(p75),
            "min": _to_list(pmin), "max": _to_list(pmax),
            "n_valid": [int(v) for v in count],
        }

    return JSONResponse({
        "plev": plev.tolist(),
        "n_cases": valid_count,
        "t": _profile_stats(t_all),
        "td": _profile_stats(td_all),
        "q": _profile_stats(q_all, decimals=4),
        "rh": _profile_stats(rh_all, decimals=1),
        "u": _profile_stats(u_all),
        "v": _profile_stats(v_all),
        "theta": _profile_stats(theta_all, decimals=1),
        "theta_e": _profile_stats(theta_e_all, decimals=1),
        "case_list": _build_case_list(matching, data_type),
    })


@app.get("/composite/era5_scalars")
def composite_era5_scalars(
    filters: dict = Depends(_composite_filter_params),
    data_type: str = Query("swath", description="'swath' or 'merge'"),
):
    """Composite statistics for all ERA5 scalar diagnostics."""
    era5 = get_era5_dataset()
    if era5 is None:
        raise HTTPException(status_code=503, detail="ERA5 data not available")

    matching = _filter_cases_for_composite(**filters, data_type=data_type)
    if not matching:
        raise HTTPException(status_code=404, detail="No matching cases")

    era5_status = era5['status'][:]
    matching = [ci for ci in matching if ci < len(era5_status) and int(era5_status[ci]) == 1]
    if not matching:
        raise HTTPException(status_code=404, detail="No matching cases with ERA5 data")

    matching = matching[:_COMPOSITE_MAX_CASES]
    indices = np.array(matching)

    scalar_names = [
        'shear_mag_env', 'shear_dir_env', 'rh_mid_env', 'div200_env',
        'sst_env', 'chi_m', 'v_pi', 'vent_index',
    ]
    scalar_meta = {
        'shear_mag_env': {"display_name": "Deep-Layer Shear", "units": "m/s", "decimals": 1},
        'shear_dir_env': {"display_name": "Shear Direction", "units": "\u00b0", "decimals": 0},
        'rh_mid_env': {"display_name": "Mid-Level RH", "units": "%", "decimals": 0},
        'div200_env': {"display_name": "200-hPa Divergence", "units": "\u00d710\u207b\u2075 s\u207b\u00b9", "decimals": 2, "scale": 1e5},
        'sst_env': {"display_name": "SST", "units": "\u00b0C", "decimals": 1},
        'chi_m': {"display_name": "Entropy Deficit (\u03c7\u2098)", "units": "", "decimals": 2},
        'v_pi': {"display_name": "Potential Intensity", "units": "m/s", "decimals": 1},
        'vent_index': {"display_name": "Ventilation Index", "units": "", "decimals": 3},
    }

    scalars = {}
    for sname in scalar_names:
        try:
            values = np.array([float(era5[sname][ci]) for ci in indices])
            valid = values[np.isfinite(values)]
            if len(valid) == 0:
                scalars[sname] = None
                continue

            meta = scalar_meta.get(sname, {"display_name": sname, "units": "", "decimals": 2})
            scale = meta.get("scale", 1.0)
            d = meta["decimals"]

            scalars[sname] = {
                "display_name": meta["display_name"],
                "units": meta["units"],
                "mean": round(float(np.mean(valid)) * scale, d),
                "std": round(float(np.std(valid)) * scale, d),
                "median": round(float(np.median(valid)) * scale, d),
                "p25": round(float(np.percentile(valid, 25)) * scale, d),
                "p75": round(float(np.percentile(valid, 75)) * scale, d),
                "min": round(float(np.min(valid)) * scale, d),
                "max": round(float(np.max(valid)) * scale, d),
                "n_valid": len(valid),
                "values": [round(float(v) * scale, d) for v in valid],
            }
        except Exception:
            scalars[sname] = None

    return JSONResponse({
        "n_cases": len(matching),
        "scalars": scalars,
        "case_list": _build_case_list(matching, data_type),
    })


@app.get("/plot")
def plot(
    case_index: int   = Query(...,              ge=0,          description="0-based case index"),
    variable:   str   = Query(DEFAULT_VARIABLE,                description="Variable key — see /variables"),
    level_km:   float = Query(2.0,              ge=0.0, le=18, description="Altitude in km"),
    data_type:  str   = Query("swath",                         description="'swath' or 'merge'"),
):
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'. See /variables.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    # Serve from cache if available (instant)
    cache_key = (case_index, variable, round(level_km, 1), data_type)
    if cache_key in _plot_cache:
        _plot_cache.move_to_end(cache_key)
        return Response(content=_plot_cache[cache_key], media_type="image/png",
                        headers={"X-Cache": "HIT"})

    try:
        ds, local_idx = resolve_case(case_index, data_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open dataset: {e}")

    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    case_meta = cache.get(case_index, {"case_index": case_index})

    try:
        png = render_planview(ds, local_idx, variable, level_km, case_meta)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Render error: {e}")

    _plot_cache[cache_key] = png
    if len(_plot_cache) > _PLOT_CACHE_MAX:
        _plot_cache.popitem(last=False)  # evict oldest entry
        gc.collect()
    return Response(content=png, media_type="image/png", headers={"X-Cache": "MISS"})

# ---------------------------------------------------------------------------
# Flight-Level Archive  (HRD historical data)
# ---------------------------------------------------------------------------
HRD_FL_BASE = "https://www.aoml.noaa.gov/ftp/pub/hrd/data/flightlevel"
_FL_TIME_WINDOW_MIN = 45   # ±45 minutes around TDR scan time
_FL_AVG_INTERVAL_S = 10    # 10-second averaging window

# Caches for HRD directory listings and flight-level results
_hrd_dir_cache: OrderedDict = OrderedDict()    # url → (links, timestamp)
_HRD_DIR_CACHE_TTL = 3600  # 1 hour for archive data
_hrd_fl_cache: OrderedDict = OrderedDict()     # case_index → (result, timestamp)
_HRD_FL_CACHE_TTL = 7 * 86400  # 7 days — archive data is immutable
_HRD_FL_CACHE_MAX = 50


class _HRDLinkParser(HTMLParser):
    """Extract href links from an Apache directory listing."""
    def __init__(self):
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for name, value in attrs:
                if name == "href" and value and not value.startswith("?") and not value.startswith("/"):
                    self.links.append(value)


def _hrd_fetch_text(url: str, timeout: int = 30) -> str:
    """Fetch text content from a URL (for HRD archive access)."""
    try:
        import requests as _req
        resp = _req.get(url, timeout=timeout)
        resp.raise_for_status()
        return resp.text
    except ImportError:
        import urllib.request as _urllib
        req = _urllib.Request(url)
        with _urllib.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8")


def _hrd_parse_directory(url: str) -> list[str]:
    """Fetch an HRD Apache directory listing and return link names (cached)."""
    now = time.time()
    if url in _hrd_dir_cache:
        links, ts = _hrd_dir_cache[url]
        if now - ts < _HRD_DIR_CACHE_TTL:
            _hrd_dir_cache.move_to_end(url)
            return links

    html = _hrd_fetch_text(url)
    parser = _HRDLinkParser()
    parser.feed(html)
    links = parser.links
    _hrd_dir_cache[url] = (links, now)
    if len(_hrd_dir_cache) > 100:
        _hrd_dir_cache.popitem(last=False)
    return links


def _parse_hrd_trak(text: str) -> list[tuple]:
    """
    Parse an HRD .trak file into a list of (datetime, lat, lon) tuples.

    Format (whitespace-delimited, 2-minute intervals):
        Track for Katrina              2005
        Date         Time (UTC)   Latitude    Longitude
        MM/DD/Year   HH:MM:SS      (deg)        (deg)
        08/23/2005   18:49:02    23.239 N    75.328 W
        ...

    Returns list of (datetime, lat_degN, lon_degE) tuples.
    Longitude is converted from degrees West to degrees East (negative).
    """
    entries = []
    for line in text.strip().splitlines():
        parts = line.split()
        # Data lines: MM/DD/YYYY HH:MM:SS lat N/S lon E/W
        if len(parts) < 6:
            continue
        # First field must look like a date MM/DD/YYYY
        date_str = parts[0]
        if date_str.count('/') != 2:
            continue
        time_str = parts[1]
        if time_str.count(':') < 1:
            continue
        try:
            dt = datetime.strptime(f"{date_str} {time_str}", "%m/%d/%Y %H:%M:%S")
        except ValueError:
            continue
        try:
            lat_val = float(parts[2])
            lat_hem = parts[3].upper() if len(parts) > 3 else 'N'
            lon_val = float(parts[4])
            lon_hem = parts[5].upper() if len(parts) > 5 else 'W'
        except (ValueError, IndexError):
            continue
        if lat_hem == 'S':
            lat_val = -lat_val
        # Convert to degrees East (standard): W → negative
        if lon_hem == 'W':
            lon_val = -lon_val
        entries.append((dt, lat_val, lon_val))
    return entries


def _get_trak_center(
    trak_entries: list[tuple], target_dt: datetime, max_offset_min: float = 30.0
) -> tuple:
    """
    Find the .trak entry closest to target_dt within max_offset_min.
    Returns (lat, lon) or (None, None) if no entry is close enough.
    """
    if not trak_entries:
        return None, None
    best_dt_diff = float('inf')
    best_lat, best_lon = None, None
    for dt, lat, lon in trak_entries:
        diff = abs((dt - target_dt).total_seconds())
        if diff < best_dt_diff:
            best_dt_diff = diff
            best_lat, best_lon = lat, lon
    if best_dt_diff <= max_offset_min * 60:
        return best_lat, best_lon
    return None, None


def _merge_hrd_header_tokens(line: str, expected_ncols: int) -> list[str]:
    """
    Parse a whitespace-aligned header/units line into tokens, merging
    multi-word names (e.g. 'D Val', 'Deg N', 'Deg W') by greedily
    combining the closest-together word pairs until len == expected_ncols.
    """
    # Find each word's (start, end, text)
    words = []
    i, n = 0, len(line)
    while i < n:
        if line[i] != ' ':
            j = i
            while j < n and line[j] != ' ':
                j += 1
            words.append((i, j, line[i:j]))
            i = j
        else:
            i += 1
    if len(words) <= expected_ncols:
        return [w[2] for w in words]
    # Greedily merge the closest pair of consecutive words until we
    # reach the expected column count.
    while len(words) > expected_ncols:
        min_gap = float('inf')
        merge_idx = -1
        for k in range(len(words) - 1):
            gap = words[k + 1][0] - words[k][1]  # char gap between words
            if gap < min_gap:
                min_gap = gap
                merge_idx = k
        if merge_idx < 0:
            break
        merged = (words[merge_idx][0], words[merge_idx + 1][1],
                  words[merge_idx][2] + words[merge_idx + 1][2])
        words = words[:merge_idx] + [merged] + words[merge_idx + 2:]
    return [w[2] for w in words]


def _parse_usaf_10sec(lines: list, col_line_idx: int) -> list:
    """
    Parse USAF .10sec.txt flight-level files.

    USAF files have a distinct header format with multi-word columns
    (GMT Time, V V, Valid Flags, Source Tags) and HH:MM:SS time format.
    The header columns are whitespace-separated single tokens EXCEPT for
    "GMT Time", "V V", "Valid Flags", and "Source Tags".

    We use a known column name list matched by position rather than the
    generic merge algorithm which fails on this format.
    """
    header_line = lines[col_line_idx]
    # Data starts on the line immediately after the header (no units line)
    data_start = col_line_idx + 1

    # Parse header: split on 2+ spaces to handle "GMT Time" etc.
    import re as _re
    raw_tokens = _re.split(r'\s{2,}', header_line.strip())
    # Build column index from the split tokens by finding their position
    # in a whitespace-split of data lines
    # Simpler approach: just use the known USAF column names and find them
    # by matching tokens in the header
    col_names_upper = [t.strip().upper().replace(" ", "") for t in raw_tokens]

    # Map known USAF names to our standard field names.
    # Note: some USAF files have both WSpd/WDir (meteorological wind) AND WS/WD
    # (potentially different quantity). Prefer WSpd/WDir when present.
    _USAF_MAP = {
        "GMTTIME": "TIME", "LAT": "LAT", "LON": "LON",
        "WSPD": "WNDSP", "WDIR": "WNDDR",  # Preferred wind columns
        "WS": "WNDSP2", "WD": "WNDDR2",    # Fallback wind (may be flags in newer files)
        "TA": "TEMPR", "DPR": "DEWPT", "TDD": "DEWPT", "TD": "DEWPT",
        "BSP": "PRESS", "CSP": "PRESS2",
        "GPSA": "GEOAL", "SLP": "SFCPR",
        "THD": "HEAD", "TRK": "TRACK",
        "GS": "GNSPD", "TAS": "TAS",
        "VV": "VTWND", "GA": "GA",
        "PT": "PRESS",  # Some files use PT for pressure
    }

    # Build column index by position in whitespace-split data
    # Strategy: read the header with single-space split, then figure out
    # which data-split index each known column corresponds to.
    # Since USAF headers are fixed-width, use character positions.
    col_positions = []  # list of (start_char, name)
    i = 0
    hdr = header_line
    while i < len(hdr):
        if hdr[i] != ' ':
            j = i
            while j < len(hdr) and hdr[j] != ' ':
                j += 1
            # Check if next word is part of a known multi-word token
            word = hdr[i:j]
            # Peek ahead for known multi-word headers
            rest = hdr[j:].lstrip()
            combined = word + rest.split()[0] if rest.split() else ""
            if combined.upper().replace(" ", "") in ("GMTTIME", "VALIDFLAGS", "SOURCETAGS"):
                end = j
                while end < len(hdr) and hdr[end] == ' ':
                    end += 1
                j2 = end
                while j2 < len(hdr) and hdr[j2] != ' ':
                    j2 += 1
                word = hdr[i:j2].strip()
                j = j2
            col_positions.append((i, word))
            i = j
        else:
            i += 1

    # Now build a simple index: for each data line split(), which index maps to which column
    # Use the simpler approach: just split the header normally and handle known aliases
    simple_tokens = header_line.split()
    col_idx = {}
    skip_next = False
    data_col = 0
    for ti, tok in enumerate(simple_tokens):
        if skip_next:
            skip_next = False
            continue
        upper = tok.upper()
        # Check for multi-word tokens we need to merge
        if upper == "GMT" and ti + 1 < len(simple_tokens) and simple_tokens[ti + 1].upper() == "TIME":
            col_idx["TIME"] = data_col
            skip_next = True
            data_col += 1
            continue
        # NOTE: Do NOT merge "V V" — in ARWO data files, these are two
        # separate single-character columns (vertical velocity components)
        # occupying two data positions.  Merging them shifts all subsequent
        # columns (WDir, WSpd, SLP, …) by one.
        if upper in ("VALID", "VALIDITY", "SOURCE", "SATCOM", "AVAPS", "DDPH", "SFMR", "FLAGS"):
            # Trailing metadata columns — stop parsing
            break
        # Map to standard name
        std = _USAF_MAP.get(upper, upper)
        col_idx[std] = data_col
        data_col += 1

    observations = []
    for line in lines[data_start:]:
        parts = line.split()
        if len(parts) < 15:
            continue

        def _get(name):
            idx = col_idx.get(name)
            if idx is not None and idx < len(parts):
                try:
                    return float(parts[idx])
                except (ValueError, TypeError):
                    return None
            return None

        # Parse TIME (HH:MM:SS format)
        time_str = parts[col_idx.get("TIME", 0)] if "TIME" in col_idx else None
        if not time_str or ":" not in time_str:
            continue
        try:
            tp = time_str.split(":")
            hh, mm = int(tp[0]), int(tp[1])
            ss = int(tp[2]) if len(tp) > 2 else 0
            time_sec = hh * 3600 + mm * 60 + ss
        except (ValueError, IndexError):
            continue

        lat = _get("LAT")
        lon_raw = _get("LON")
        if lat is None or lon_raw is None:
            continue
        # USAF uses standard negative-west convention
        lon = lon_raw

        wspd = _get("WNDSP")
        wdir = _get("WNDDR")
        # Fallback to WS/WD if WSpd/WDir not present (but validate — WS/WD
        # may be validity flag strings in newer USAF files, not numbers)
        if wspd is None:
            ws2 = _get("WNDSP2")
            if ws2 is not None and ws2 < 200:  # Sanity check: flag strings parse as large numbers
                wspd = ws2
        if wdir is None:
            wd2 = _get("WNDDR2")
            if wd2 is not None and wd2 <= 360:
                wdir = wd2
        # ARWO files report wind speed, ground speed, and TAS in knots
        if wspd is not None:
            wspd = wspd * 0.514444
        temp = _get("TEMPR")
        dewpt = _get("DEWPT")
        press = _get("PRESS")
        geo_alt = _get("GEOAL")
        sfcpr = _get("SFCPR")
        gn_spd = _get("GNSPD")
        if gn_spd is not None:
            gn_spd = gn_spd * 0.514444
        tas = _get("TAS")
        if tas is not None:
            tas = tas * 0.514444
        head = _get("HEAD")
        track = _get("TRACK")
        vt_wnd = _get("VTWND")

        obs = {
            "time": f"{hh:02d}:{mm:02d}:{ss:02d}",
            "time_sec": time_sec,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "fl_wspd_ms": round(wspd, 2) if wspd is not None else None,
            "fl_wdir_deg": round(wdir, 1) if wdir is not None else None,
            "gps_alt_m": round(geo_alt, 1) if geo_alt is not None else None,
            "static_pres_hpa": round(press, 1) if press is not None else None,
            "temp_c": round(temp, 2) if temp is not None else None,
            "dewpoint_c": round(dewpt, 2) if dewpt is not None else None,
            "sfcpr_hpa": round(sfcpr, 1) if sfcpr is not None else None,
            "ground_spd_ms": round(gn_spd, 1) if gn_spd is not None else None,
            "true_airspd_ms": round(tas, 1) if tas is not None else None,
            "heading": round(head, 1) if head is not None else None,
            "track": round(track, 1) if track is not None else None,
            "vert_vel_ms": round(vt_wnd, 2) if vt_wnd is not None else None,
            "theta_e": None,
            "sfmr_wspd_ms": None,
            "slp_hpa": None,
            "extrapolated_sfc_wspd_ms": None,
        }
        observations.append(obs)

    return observations


def _parse_usaf_ten(text: str) -> list:
    """
    Parse USAF .ten format flight-level files (10-second data, late 1990s).

    Format:
      Line 1: column names (time lt lg ta td wd ws dv pa ra flag)
      Line 2: @ metadata line (date, aircraft, storm)
      Line 3+: data in deg-min format (30 24.2N  88 55.6W)

    Time is HH:MM:SS with possible space-padded seconds (16:30: 0).
    Lat/lon use degrees + decimal minutes + N/S/E/W suffix.
    """
    lines = text.replace('\x00', '').strip().splitlines()
    if len(lines) < 3:
        return []

    # Find the metadata line starting with @ to extract the date
    flight_date = None
    data_start = 0
    for i, line in enumerate(lines[:5]):
        if line.strip().startswith('@'):
            # Extract date: @ 1998/10/21 16:28:55 ...
            parts = line.split()
            if len(parts) >= 2:
                dp = parts[1].split('/')
                if len(dp) == 3:
                    flight_date = f"{dp[0]}-{dp[1]}-{dp[2]}"
            data_start = i + 1
            break

    observations = []
    import re as _re

    for line in lines[data_start:]:
        line = line.strip()
        if not line or line.startswith('@') or line.startswith('#'):
            continue

        # Parse time: HH:MM:SS (may have space-padded seconds like "16:30: 0")
        # Also handle "16:30:00" format
        m = _re.match(r'(\d{1,2}):(\d{2}):\s*(\d{1,2})', line)
        if not m:
            continue
        hh, mm, ss = int(m.group(1)), int(m.group(2)), int(m.group(3))
        time_sec = hh * 3600 + mm * 60 + ss

        # Parse remaining fields after the time
        rest = line[m.end():].strip()

        # Lat: "30 24.2N" or "30  0.5N" (deg min dir)
        lat_m = _re.search(r'(\d{1,2})\s+(\d{1,2}\.\d+)([NS])', rest)
        if not lat_m:
            continue
        lat_deg = int(lat_m.group(1))
        lat_min = float(lat_m.group(2))
        lat = lat_deg + lat_min / 60.0
        if lat_m.group(3) == 'S':
            lat = -lat

        # Lon: "88 55.6W" or "88  0.5E"
        lon_m = _re.search(r'(\d{1,3})\s+(\d{1,2}\.\d+)([EW])', rest)
        if not lon_m:
            continue
        lon_deg = int(lon_m.group(1))
        lon_min = float(lon_m.group(2))
        lon = lon_deg + lon_min / 60.0
        if lon_m.group(3) == 'W':
            lon = -lon

        # Extract numeric fields after the lon
        after_lon = rest[lon_m.end():].strip()
        vals = after_lon.split()

        def _fget(idx):
            try:
                return float(vals[idx]) if idx < len(vals) else None
            except (ValueError, IndexError):
                return None

        # Column order after lat/lon: ta, td, wd, ws, dv, pa, ra, flag
        temp = _fget(0)      # temperature (°C)
        dewpt = _fget(1)     # dewpoint (°C)
        wdir = _fget(2)      # wind direction (deg)
        wspd = _fget(3)      # wind speed (kt in .ten format)
        dval = _fget(4)      # D-value (m)
        palt = _fget(5)      # pressure altitude
        ralt = _fget(6)      # radar altitude

        # Convert wind speed from knots to m/s
        wspd_ms = wspd * 0.514444 if wspd is not None else None

        obs = {
            "time": f"{hh:02d}:{mm:02d}:{ss:02d}",
            "time_sec": time_sec,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "fl_wspd_ms": round(wspd_ms, 2) if wspd_ms is not None else None,
            "fl_wdir_deg": round(wdir, 1) if wdir is not None else None,
            "gps_alt_m": None,
            "static_pres_hpa": None,
            "temp_c": round(temp, 2) if temp is not None else None,
            "dewpoint_c": round(dewpt, 2) if dewpt is not None else None,
            "sfcpr_hpa": None,
            "ground_spd_ms": None,
            "true_airspd_ms": None,
            "heading": None,
            "track": None,
            "vert_vel_ms": None,
            "theta_e": None,
            "sfmr_wspd_ms": None,
            "slp_hpa": None,
            "extrapolated_sfc_wspd_ms": None,
        }
        observations.append(obs)

    return observations


def _parse_hrd_1sec(text: str) -> list[dict]:
    """
    Parse an HRD archive 1-second flight-level .sec.txt file.

    Format:
      Line 1: storm_name  mission_id  (header)
      Line 2: blank or column names
      Line 3: column names (TIME, Lat, Lon, ...)
      Line 4: units (HHMMSS, Deg N, Deg W, ...)
      Line 5+: data rows (whitespace-delimited)

    Handles multi-word column names (e.g. 'D Val') and mid-file
    field-count changes (day-offset flag inserted after midnight).
    Returns list of observation dicts with consistent field names.
    """
    # Strip null bytes (some legacy files contain embedded \x00 characters)
    text = text.replace('\x00', '')

    lines = text.strip().splitlines()
    if len(lines) < 5:
        return []

    # Find the header line with column names — look for "TIME" and "LAT" (case-insensitive)
    # NOAA files use "TIME" + "Lat"; USAF files use "GMT Time" + "LAT"
    col_line_idx = None
    _is_usaf_format = False
    for i, line in enumerate(lines[:10]):
        upper = line.upper()
        if "TIME" in upper and "LAT" in upper:
            col_line_idx = i
            # Detect USAF format: has "GMT Time", "Valid Flags", "Source Tags"
            if "GMT" in upper or "VALID FLAGS" in upper or "SOURCE TAGS" in upper:
                _is_usaf_format = True
            break
    if col_line_idx is None:
        # Fallback: assume line index 2 has column names
        col_line_idx = 2

    # ── USAF format: use known column layout ──────────────────────
    # USAF .10sec.txt files have complex multi-word headers and trailing
    # text fields ("Valid Flags", "Source Tags") that break the NOAA parser.
    # Use direct column name mapping from the header instead.
    if _is_usaf_format:
        return _parse_usaf_10sec(lines, col_line_idx)

    # Units line is immediately after column names
    units_line = lines[col_line_idx + 1] if col_line_idx + 1 < len(lines) else ""
    # Data starts 2 lines after column header (units line, then data)
    data_start = col_line_idx + 2

    # ---------- Determine expected field count from data sample ----------
    from collections import Counter
    sample_counts = Counter()
    for sline in lines[data_start:min(data_start + 200, len(lines))]:
        nf = len(sline.split())
        if nf >= 15:  # skip blank / short lines
            sample_counts[nf] += 1
    expected_nf = sample_counts.most_common(1)[0][0] if sample_counts else 19

    # ---------- Parse header with multi-word name merging ----------
    col_names = _merge_hrd_header_tokens(lines[col_line_idx], expected_nf)
    units_parts = _merge_hrd_header_tokens(units_line, expected_nf)

    # Build column index map
    col_idx = {}
    for j, name in enumerate(col_names):
        col_idx[name.upper().replace(" ", "")] = j

    _usaf_time_format = False

    # Detect wind speed units from the units line
    # HRD files use either "m/s" or "kts"/"kt"/"knots" for WNDSP
    wspd_col = col_idx.get("WNDSP")
    wspd_in_knots = False
    if wspd_col is not None and wspd_col < len(units_parts):
        wspd_unit = units_parts[wspd_col].lower()
        if "kt" in wspd_unit or "knot" in wspd_unit:
            wspd_in_knots = True

    observations = []
    for line in lines[data_start:]:
        parts = line.split()
        if len(parts) < expected_nf - 2:  # allow a couple missing at end
            continue

        # --- Handle day-offset flag for flights crossing midnight ---
        # Some HRD files insert a small integer (day offset, e.g. "1")
        # at index 1 after midnight, adding one extra field per row.
        # Detect by checking: parts[0] is TIME (>=6 chars), parts[1] is
        # a single-digit integer (no decimal point → not a lat value).
        # This handles both normal +1 field rows AND rows that are
        # simultaneously missing trailing columns.
        if len(parts) >= 2 and len(parts[0]) >= 6:
            p1 = parts[1]
            if len(p1) <= 2 and '.' not in p1:
                try:
                    if 0 <= int(p1) <= 9:
                        parts = [parts[0]] + parts[2:]  # strip day flag
                except (ValueError, TypeError):
                    pass

        def _get(name):
            idx = col_idx.get(name.upper())
            if idx is not None and idx < len(parts):
                try:
                    return float(parts[idx])
                except (ValueError, TypeError):
                    return None
            return None

        # Parse TIME (HHMMSS format)
        time_str = parts[col_idx.get("TIME", 0)] if "TIME" in col_idx else None
        if not time_str or len(time_str) < 5:
            continue
        try:
            if _usaf_time_format or ":" in time_str:
                # HH:MM:SS format (USAF)
                tp = time_str.split(":")
                hh, mm = int(tp[0]), int(tp[1])
                ss = int(tp[2]) if len(tp) > 2 else 0
            else:
                # HHMMSS format (NOAA)
                hh = int(time_str[0:2])
                mm = int(time_str[2:4])
                ss = int(time_str[4:6])
            time_sec = hh * 3600 + mm * 60 + ss
        except (ValueError, IndexError):
            continue

        lat = _get("LAT")
        lon_raw = _get("LON")
        if lat is None or lon_raw is None:
            continue
        # NOAA files: "Deg W" (positive = west), negate for standard
        # USAF files: standard negative-west already
        # Heuristic: if lon > 0 and in Western Hemisphere (Atlantic/EPAC), negate
        lon = -abs(lon_raw) if lon_raw > 0 else lon_raw

        wspd = _get("WNDSP")   # may be knots or m/s depending on file
        if wspd is not None and wspd_in_knots:
            wspd = wspd * 0.514444  # convert knots → m/s
        wdir = _get("WNDDR")   # degrees
        temp = _get("TEMPR")   # °C
        dewpt = _get("DEWPT")  # °C, -25.00 is sentinel
        if dewpt is not None and dewpt <= -24.99:
            dewpt = None
        press = _get("PRESS")  # mb
        geo_alt = _get("GEOAL")  # m
        sfcpr = _get("SFCPR")  # mb
        rd_alt = _get("RDALT")  # m
        gn_spd = _get("GNSPD")  # m/s
        tas = _get("TAS")      # m/s
        head = _get("HEAD")    # deg
        track = _get("TRACK")  # deg
        vt_wnd = _get("VTWND")  # m/s
        theta_e = _get("THETAE")  # deg

        obs = {
            "time": f"{hh:02d}:{mm:02d}:{ss:02d}",
            "time_sec": time_sec,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "fl_wspd_ms": round(wspd, 2) if wspd is not None else None,
            "fl_wdir_deg": round(wdir, 1) if wdir is not None else None,
            "gps_alt_m": round(geo_alt, 1) if geo_alt is not None else None,
            "static_pres_hpa": round(press, 1) if press is not None else None,
            "temp_c": round(temp, 2) if temp is not None else None,
            "dewpoint_c": round(dewpt, 2) if dewpt is not None else None,
            "sfcpr_hpa": round(sfcpr, 1) if sfcpr is not None else None,
            "ground_spd_ms": round(gn_spd, 1) if gn_spd is not None else None,
            "true_airspd_ms": round(tas, 1) if tas is not None else None,
            "heading": round(head, 1) if head is not None else None,
            "track": round(track, 1) if track is not None else None,
            "vert_vel_ms": round(vt_wnd, 2) if vt_wnd is not None else None,
            "theta_e": round(theta_e, 2) if theta_e is not None else None,
            # Placeholders for compatibility with real-time structure
            "sfmr_wspd_ms": None,
            "slp_hpa": None,
            "extrapolated_sfc_wspd_ms": None,
        }
        observations.append(obs)

    # Heuristic check: if we didn't detect knots from the units line,
    # check if max wind speed is unreasonably large for m/s (>120 m/s ~ 233 kt).
    # This catches files where the units line is ambiguous.
    if not wspd_in_knots and observations:
        max_ws = max((o["fl_wspd_ms"] for o in observations if o["fl_wspd_ms"] is not None), default=0)
        if max_ws > 120:  # > 120 m/s is unrealistic, likely knots
            for obs in observations:
                if obs["fl_wspd_ms"] is not None:
                    obs["fl_wspd_ms"] = round(obs["fl_wspd_ms"] * 0.514444, 2)

    return observations


def _hrd_average_window(
    observations: list[dict], interval_s: float = 10.0
) -> list[dict]:
    """
    Compute interval_s-second averages of HRD flight-level observations.
    Similar to the real-time _average_fl_window but works with time_sec field.
    """
    if not observations or interval_s <= 1:
        return observations

    _AVG_KEYS = [
        "gps_alt_m", "static_pres_hpa", "temp_c", "dewpoint_c",
        "fl_wspd_ms", "fl_wdir_deg", "sfcpr_hpa", "ground_spd_ms",
        "true_airspd_ms", "vert_vel_ms", "theta_e",
    ]

    result = []
    n = len(observations)
    i = 0
    while i < n:
        t0 = observations[i]["time_sec"]
        window = []
        while i < n and observations[i]["time_sec"] - t0 < interval_s:
            window.append(observations[i])
            i += 1

        mid_idx = len(window) // 2
        mid = window[mid_idx]
        averaged = {
            "time": mid["time"],
            "time_sec": mid["time_sec"],
            "lat": mid["lat"],
            "lon": mid["lon"],
        }

        for key in _AVG_KEYS:
            vals = [o[key] for o in window if o.get(key) is not None]
            if vals:
                if key == "fl_wdir_deg":
                    rad = [v * math.pi / 180.0 for v in vals]
                    mean_sin = sum(math.sin(r) for r in rad) / len(rad)
                    mean_cos = sum(math.cos(r) for r in rad) / len(rad)
                    avg = (math.atan2(mean_sin, mean_cos) * 180.0 / math.pi) % 360.0
                else:
                    avg = sum(vals) / len(vals)
                averaged[key] = round(avg, 2)
            else:
                averaged[key] = None

        averaged["time_offset_s"] = mid.get("time_offset_s")
        averaged["heading"] = mid.get("heading")
        averaged["track"] = mid.get("track")
        averaged["sfmr_wspd_ms"] = None
        averaged["slp_hpa"] = None
        averaged["extrapolated_sfc_wspd_ms"] = None

        result.append(averaged)

    return result


def _latlon_to_storm_km_archive(
    lat: float, lon: float, center_lat: float, center_lon: float
) -> tuple[float, float]:
    """Convert geographic lat/lon to storm-relative (x_km, y_km)."""
    x_km = (lon - center_lon) * 111.0 * math.cos(math.radians(center_lat))
    y_km = (lat - center_lat) * 111.0
    return round(x_km, 3), round(y_km, 3)


def _interp_tdr_archive(
    ds, local_idx: int, variable_key: str, level_km: float,
    x_pts: np.ndarray, y_pts: np.ndarray
) -> np.ndarray:
    """
    Bilinear-interpolate a TDR 2D field from the archive Zarr dataset
    to arbitrary (x_km, y_km) points.

    Adapted from realtime_tdr_api._interp_tdr_along_track for Zarr archive format.
    Returns array of interpolated values (NaN where outside domain).
    """
    # Get the 2D data slice
    height_vals = ds["height"].values
    z_idx = int(np.argmin(np.abs(height_vals - level_km)))

    # Handle derived variables (wind speed)
    if variable_key in DERIVED_VARIABLES:
        u_name, v_name = DERIVED_VARIABLES[variable_key]
        u = ds[u_name].isel(num_cases=local_idx, height=z_idx).values
        v = ds[v_name].isel(num_cases=local_idx, height=z_idx).values
        data = np.sqrt(u**2 + v**2)
        ref_varname = u_name
    else:
        _, varname, _, _, _, _ = VARIABLES[variable_key]
        data = ds[varname].isel(num_cases=local_idx, height=z_idx).values
        ref_varname = varname

    # Determine grid coordinates
    dims = ds[ref_varname].dims
    if "eastward_distance" in dims:
        x_km = ds["eastward_distance"].values
        y_km = ds["northward_distance"].values
    elif "longitude" in dims:
        x_km = ds["longitude"].values
        y_km = ds["latitude"].values
    else:
        x_km = ds["x"].values if "x" in ds else np.arange(data.shape[-1])
        y_km = ds["y"].values if "y" in ds else np.arange(data.shape[-2])

    # data may be (x, y) — transpose to (y, x) if needed
    if data.shape[0] == len(x_km) and data.shape[1] == len(y_km) and len(x_km) != len(y_km):
        data = data.T
    ny, nx = data.shape

    dx = float(x_km[1] - x_km[0]) if nx > 1 else 1.0
    dy = float(y_km[1] - y_km[0]) if ny > 1 else 1.0

    fi = (x_pts - float(x_km[0])) / dx
    fj = (y_pts - float(y_km[0])) / dy

    result = np.full(len(x_pts), np.nan)
    for k in range(len(x_pts)):
        xi, yj = fi[k], fj[k]
        i0 = int(np.floor(xi))
        j0 = int(np.floor(yj))
        i1, j1 = i0 + 1, j0 + 1
        if i0 < 0 or i1 >= nx or j0 < 0 or j1 >= ny:
            continue
        wx = xi - i0
        wy = yj - j0
        v00 = data[j0, i0]
        v10 = data[j0, i1]
        v01 = data[j1, i0]
        v11 = data[j1, i1]
        if any(np.isnan(v) for v in [v00, v10, v01, v11]):
            ni = int(round(xi))
            nj = int(round(yj))
            if 0 <= ni < nx and 0 <= nj < ny and not np.isnan(data[nj, ni]):
                result[k] = float(data[nj, ni])
            continue
        val = (v00 * (1 - wx) * (1 - wy) + v10 * wx * (1 - wy) +
               v01 * (1 - wx) * wy + v11 * wx * wy)
        result[k] = float(val)
    return result


def _interp_tdr_archive_3d(
    ds, local_idx: int, variable_key: str,
    x_pts: np.ndarray, y_pts: np.ndarray, z_pts_km: np.ndarray
) -> np.ndarray:
    """
    Trilinear-interpolate a TDR 3D field from the archive Zarr dataset
    to arbitrary (x_km, y_km, height_km) points — i.e. at the aircraft altitude.

    Uses scipy RegularGridInterpolator for efficient 3D interpolation.
    Returns array of interpolated values (NaN where outside domain).
    """
    height_vals = ds["height"].values  # 1D, in km

    # Load full 3D volume
    if variable_key in DERIVED_VARIABLES:
        u_name, v_name = DERIVED_VARIABLES[variable_key]
        u_3d = ds[u_name].isel(num_cases=local_idx).values  # (height, y, x) or permuted
        v_3d = ds[v_name].isel(num_cases=local_idx).values
        vol = np.sqrt(u_3d**2 + v_3d**2)
        ref_varname = u_name
    else:
        _, varname, _, _, _, _ = VARIABLES[variable_key]
        vol = ds[varname].isel(num_cases=local_idx).values
        ref_varname = varname

    # Determine grid coordinates
    dims = ds[ref_varname].dims
    # Remove 'num_cases' to get spatial dims in order
    spatial_dims = [d for d in dims if d != "num_cases"]

    if "eastward_distance" in dims:
        x_coord = ds["eastward_distance"].values
        y_coord = ds["northward_distance"].values
    elif "longitude" in dims:
        x_coord = ds["longitude"].values
        y_coord = ds["latitude"].values
    else:
        x_coord = ds["x"].values if "x" in ds else np.arange(vol.shape[-1])
        y_coord = ds["y"].values if "y" in ds else np.arange(vol.shape[-2])

    # Determine axis ordering: need (height, y, x)
    # Common orderings after isel(num_cases=...):
    #   (height, northward_distance, eastward_distance) → already correct
    #   (height, y, x) → already correct
    # If the first spatial dim is height, assume (height, y, x)
    h_dim_name = "height"
    if spatial_dims[0] == h_dim_name:
        # vol is (height, y, x) — correct order
        pass
    elif spatial_dims[-1] == h_dim_name:
        # vol is (y, x, height) — transpose
        vol = np.transpose(vol, (2, 0, 1))
    elif len(spatial_dims) >= 2 and spatial_dims[1] == h_dim_name:
        # vol is (y, height, x) — transpose
        vol = np.transpose(vol, (1, 0, 2))

    # Handle potential (x, y) vs (y, x) ambiguity in the last two dims
    nz, ny_vol, nx_vol = vol.shape
    if ny_vol == len(x_coord) and nx_vol == len(y_coord) and len(x_coord) != len(y_coord):
        # Axes are swapped: (height, x, y) → (height, y, x)
        vol = np.transpose(vol, (0, 2, 1))
        nz, ny_vol, nx_vol = vol.shape

    # Replace NaN with fill to avoid interpolation artifacts at boundaries
    # RegularGridInterpolator handles fill_value for out-of-bounds
    interp = RegularGridInterpolator(
        (height_vals.astype(float), y_coord.astype(float), x_coord.astype(float)),
        vol.astype(float),
        method="linear",
        bounds_error=False,
        fill_value=np.nan,
    )

    # Build query points: (z, y, x) ordering to match grid
    pts = np.column_stack([z_pts_km, y_pts, x_pts])
    result = interp(pts)

    # For NaN results, try nearest-neighbor fallback
    nan_mask = np.isnan(result)
    if np.any(nan_mask):
        interp_nn = RegularGridInterpolator(
            (height_vals.astype(float), y_coord.astype(float), x_coord.astype(float)),
            vol.astype(float),
            method="nearest",
            bounds_error=False,
            fill_value=np.nan,
        )
        nn_vals = interp_nn(pts[nan_mask])
        result[nan_mask] = nn_vals

    return result


def _resolve_hrd_storm_name(storm_name: str, year: int) -> Optional[str]:
    """
    Resolve a TC-RADAR storm name to an HRD directory name.

    HRD uses lowercase storm names as directory names. We check the year
    directory listing and do case-insensitive + fuzzy matching.
    """
    year_url = f"{HRD_FL_BASE}/{year}/"
    try:
        entries = _hrd_parse_directory(year_url)
    except Exception:
        return None

    # Clean entries (strip trailing slashes)
    storm_dirs = [e.rstrip("/") for e in entries if not e.startswith("?")]

    # Exact match (case-insensitive)
    target = storm_name.lower().strip()
    for d in storm_dirs:
        if d.lower() == target:
            return d

    # Fuzzy: try removing numbers/suffixes (e.g., "milton" vs "milton1")
    for d in storm_dirs:
        if target.startswith(d.lower()) or d.lower().startswith(target):
            return d

    return None


def _match_hrd_files(mission_id: str, hrd_files: list[str], year: int = None) -> list[str]:
    """
    Match a TC-RADAR mission_id to HRD .sec.txt files.

    mission_id format: "20241007I1" (YYYYMMDD) or "190901H1" (YYMMDD)
    HRD filename format: e.g., "20241007I1.sec.txt", "20241007H1.1sec.txt"

    The `year` parameter is used as a hint to expand 6-digit dates to 8-digit.
    Returns list of matching filenames sorted by relevance.
    """
    matches = []
    # Try 8-digit date first: YYYYMMDD + aircraft + sortie
    m = re.match(r"(\d{8})([A-Za-z])(\d+)", mission_id)
    if not m:
        # Try 6-digit date: YYMMDD + aircraft + sortie (common in older TC-RADAR metadata)
        m = re.match(r"(\d{6})([A-Za-z])(\d+)", mission_id)
        if not m:
            return matches
        # Expand 6-digit YYMMDD to 8-digit YYYYMMDD
        short_date = m.group(1)
        if year is not None:
            # Use the known year from scan datetime
            century = str(year)[:2]
        else:
            # Guess century: YY >= 97 → 1900s, else 2000s
            yy = int(short_date[:2])
            century = "19" if yy >= 97 else "20"
        date_str = century + short_date
        aircraft, num = m.group(2).upper(), m.group(3)
    else:
        date_str, aircraft, num = m.group(1), m.group(2).upper(), m.group(3)

    mission_prefix = f"{date_str}{aircraft}{num}"

    for fname in hrd_files:
        fl = fname.lower()
        # Accept .sec.txt, .1sec.txt, .1sec, .sec (some older files lack .txt)
        if not (fl.endswith(".txt") or fl.endswith(".1sec") or fl.endswith(".sec")):
            continue
        # Check if the filename starts with the mission prefix
        fname_upper = fname.upper()
        if fname_upper.startswith(mission_prefix.upper()):
            matches.append(fname)
        # Also check with just date + aircraft (e.g., 20241007I)
        elif fname_upper.startswith(f"{date_str}{aircraft}"):
            matches.append(fname)

    # Prefer exact mission_id match, then .1sec.txt, then .sec.txt
    def sort_key(f):
        fu = f.upper()
        if fu.startswith(mission_prefix.upper()):
            priority = 0
        else:
            priority = 1
        if "1sec" in f.lower():
            fmt_priority = 0  # 1-second data preferred
        elif "sec" in f.lower():
            fmt_priority = 1
        else:
            fmt_priority = 2
        return (priority, fmt_priority, f)

    matches.sort(key=sort_key)
    return matches


def _parse_tdr_scan_time(dt_str: str) -> Optional[datetime]:
    """Parse a TC-RADAR datetime string to a datetime object."""
    # Strip trailing " UTC" suffix and normalize to plain string
    cleaned = dt_str.strip()
    if cleaned.upper().endswith(" UTC"):
        cleaned = cleaned[:-4].strip()

    for fmt in (
        "%Y-%m-%d %H:%M:%S",   # 2024-10-08 22:05:30
        "%Y-%m-%d %H:%M",      # 2024-10-08 22:05
        "%Y-%m-%d %H:%M:%SZ",  # 2024-10-08 22:05:30Z
        "%Y-%m-%dT%H:%M:%SZ",  # 2024-10-08T22:05:30Z
        "%Y-%m-%dT%H:%M:%S",   # 2024-10-08T22:05:30
        "%Y-%m-%dT%H:%M",      # 2024-10-08T22:05
    ):
        try:
            return datetime.strptime(cleaned, fmt).replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
    return None


@app.get("/flightlevel/archive")
def get_archive_flight_level(
    case_index: int = Query(..., ge=0, description="0-based case index"),
    data_type: str = Query("swath", description="'swath' or 'merge'"),
    avg_interval_s: float = Query(10.0, ge=1, le=60,
                                   description="Averaging interval in seconds"),
):
    """
    Return flight-level (in situ) observations from the HRD historical archive
    for the TC-RADAR case matching the given case_index.

    Parses 1-Hz HRD .sec.txt data, filters to ±45 min of the TDR analysis time,
    returns 10-second averaged observations with storm-relative coordinates and
    TDR-interpolated wind speeds at 0.5 km and 2.0 km.
    """
    now = time.time()
    cache_key = f"{data_type}_{case_index}_avg{avg_interval_s}"
    if cache_key in _hrd_fl_cache:
        cached, ts = _hrd_fl_cache[cache_key]
        if now - ts < _HRD_FL_CACHE_TTL:
            _hrd_fl_cache.move_to_end(cache_key)
            return JSONResponse(cached)

    # Look up case metadata
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    case_meta = cache.get(case_index)
    if not case_meta:
        raise HTTPException(status_code=404, detail=f"case_index {case_index} not found")

    storm_name = case_meta.get("storm_name", "").strip()
    mission_id = case_meta.get("mission_id", "").strip()
    dt_str = case_meta.get("datetime", "")
    # Get storm center lat/lon — prefer the TDR WCM recentered center so
    # that FL positions align with the TDR plan-view grid.  Fallback to
    # HRD .trak file (2-min center fixes), then ERA5 / IR best-track.
    center_lat = None
    center_lon = None
    _center_source = None
    # --- Priority 1: TDR Zarr WCM recentered TC center ---
    _tdr_ds, _tdr_li = None, None
    try:
        _tdr_ds, _tdr_li = resolve_case(case_index, data_type)
        if 'center_lat' in _tdr_ds and 'center_lon' in _tdr_ds:
            center_lat = float(_tdr_ds['center_lat'].values[_tdr_li])
            center_lon = float(_tdr_ds['center_lon'].values[_tdr_li])
            _center_source = "tdr_zarr"
    except Exception:
        pass
    # --- Priority 1b: Metadata cache latitude/longitude (always available) ---
    if center_lat is None:
        clat = case_meta.get("latitude")
        clon = case_meta.get("longitude")
        if clat is not None and clon is not None:
            try:
                center_lat = float(clat)
                center_lon = float(clon)
                _center_source = "metadata"
            except (ValueError, TypeError):
                pass
    # Priorities 2-4 (.trak, ERA5, IR) are applied after the HRD
    # directory is resolved, since the .trak file lives in that directory
    # and we need scan_dt to find the closest entry.

    if not mission_id:
        result = {
            "success": False,
            "reason": "no_mission_id",
            "message": "No mission ID in metadata for this case",
        }
        return JSONResponse(result)

    # Parse TDR scan datetime
    scan_dt = _parse_tdr_scan_time(dt_str)
    if scan_dt is None:
        result = {
            "success": False,
            "reason": "bad_datetime",
            "message": f"Could not parse datetime: {dt_str}",
        }
        return JSONResponse(result)

    year = scan_dt.year
    scan_time_sec = scan_dt.hour * 3600 + scan_dt.minute * 60 + scan_dt.second

    # Resolve HRD storm directory
    hrd_storm = _resolve_hrd_storm_name(storm_name, year)
    if not hrd_storm:
        result = {
            "success": False,
            "reason": "no_hrd_storm",
            "message": f"No HRD flight-level directory found for {storm_name} ({year})",
        }
        _hrd_fl_cache[cache_key] = (result, now)
        if len(_hrd_fl_cache) > _HRD_FL_CACHE_MAX:
            _hrd_fl_cache.popitem(last=False)
        return JSONResponse(result)

    # List files in the storm directory
    storm_url = f"{HRD_FL_BASE}/{year}/{hrd_storm}/"
    try:
        hrd_files = _hrd_parse_directory(storm_url)
    except Exception as e:
        result = {
            "success": False,
            "reason": "dir_fetch_error",
            "message": f"Could not list HRD directory: {e}",
        }
        return JSONResponse(result)

    # --- Priority 2: HRD .trak file (2-min center fixes) ---
    if center_lat is None:
        trak_files = [f for f in hrd_files if f.lower().endswith('.trak')]
        if trak_files:
            try:
                trak_text = _hrd_fetch_text(f"{storm_url}{trak_files[0]}", timeout=30)
                trak_entries = _parse_hrd_trak(trak_text)
                _trak_lat, _trak_lon = _get_trak_center(trak_entries, scan_dt, max_offset_min=30.0)
                if _trak_lat is not None:
                    center_lat = _trak_lat
                    center_lon = _trak_lon
                    _center_source = "hrd_trak"
            except Exception:
                pass
    # --- Priority 3: ERA5 best-track center ---
    # ERA5 and IR zarr stores are indexed by swath case; translate if in merge mode.
    _swath_idx = _merge_to_swath_index.get(case_index, case_index) if data_type == "merge" else case_index
    if center_lat is None:
        try:
            era5 = get_era5_dataset()
            if era5 is not None and 'center_lat' in era5:
                center_lat = float(era5['center_lat'][_swath_idx])
                center_lon = float(era5['center_lon'][_swath_idx])
                _center_source = "era5"
        except Exception:
            pass
    # --- Priority 4: IR Zarr best-track center ---
    if center_lat is None:
        try:
            ir_store = get_ir_dataset()
            if ir_store is not None and 'center_lat' in ir_store:
                center_lat = float(ir_store['center_lat'][_swath_idx])
                center_lon = float(ir_store['center_lon'][_swath_idx])
                _center_source = "ir_zarr"
        except Exception:
            pass

    # Match mission_id to HRD files
    matched_files = _match_hrd_files(mission_id, hrd_files, year=year)
    if not matched_files:
        result = {
            "success": False,
            "reason": "no_fl_data",
            "message": f"No flight-level data found for mission {mission_id} in {hrd_storm}/",
        }
        _hrd_fl_cache[cache_key] = (result, now)
        if len(_hrd_fl_cache) > _HRD_FL_CACHE_MAX:
            _hrd_fl_cache.popitem(last=False)
        return JSONResponse(result)

    # Fetch and parse the best-match file
    fl_url = f"{storm_url}{matched_files[0]}"
    try:
        fl_text = _hrd_fetch_text(fl_url, timeout=60)
    except Exception as e:
        result = {
            "success": False,
            "reason": "fetch_error",
            "message": f"Could not fetch {matched_files[0]}: {e}",
        }
        return JSONResponse(result)

    raw_obs = _parse_hrd_1sec(fl_text)
    if not raw_obs:
        result = {
            "success": False,
            "reason": "parse_error",
            "message": f"No valid observations parsed from {matched_files[0]}",
        }
        return JSONResponse(result)

    # Time-window filter: keep records within ±FL_TIME_WINDOW_MIN of scan
    window_sec = _FL_TIME_WINDOW_MIN * 60
    filtered = []
    for obs in raw_obs:
        delta = obs["time_sec"] - scan_time_sec
        # Handle midnight crossing
        if delta > 43200:
            delta -= 86400
        elif delta < -43200:
            delta += 86400
        if abs(delta) <= window_sec:
            obs["time_offset_s"] = round(delta, 1)
            filtered.append(obs)

    if not filtered:
        result = {
            "success": False,
            "reason": "no_obs_in_window",
            "message": f"No observations within ±{_FL_TIME_WINDOW_MIN} min of TDR scan time ({scan_dt.strftime('%H:%M:%SZ')})",
            "total_obs": len(raw_obs),
            "file": matched_files[0],
        }
        _hrd_fl_cache[cache_key] = (result, now)
        if len(_hrd_fl_cache) > _HRD_FL_CACHE_MAX:
            _hrd_fl_cache.popitem(last=False)
        return JSONResponse(result)

    # ── Multi-resolution averaging ──────────────────────────────
    # Produce 1s (raw), 10s, and 30s averaged windows in a single pass
    avg_intervals = [1, 10, 30]
    avg_results = {}  # key → list of obs dicts
    for intv in avg_intervals:
        if intv <= 1:
            avg_results[intv] = list(filtered)  # shallow copy of 1-sec obs
        else:
            avg_results[intv] = _hrd_average_window(filtered, interval_s=float(intv))

    # Get storm center coordinates for storm-relative transform
    if center_lat is None or center_lon is None or (center_lat == 0 and center_lon == 0):
        lats = [o["lat"] for o in filtered if o["lat"]]
        lons = [o["lon"] for o in filtered if o["lon"]]
        center_lat = sum(lats) / len(lats) if lats else 0
        center_lon = sum(lons) / len(lons) if lons else 0

    # Storm-motion correction
    storm_u = case_meta.get("storm_motion_east_ms", -999)
    storm_v = case_meta.get("storm_motion_north_ms", -999)
    has_motion = (storm_u is not None and storm_v is not None
                  and storm_u != -999 and storm_v != -999)

    # Convert all resolutions to storm-relative coordinates
    for intv, obs_list in avg_results.items():
        for obs in obs_list:
            x_km, y_km = _latlon_to_storm_km_archive(
                obs["lat"], obs["lon"], center_lat, center_lon
            )
            if has_motion and obs.get("time_offset_s") is not None:
                dt_s = obs["time_offset_s"]
                x_km += storm_u * (-dt_s) / 1000.0
                y_km += storm_v * (-dt_s) / 1000.0
                x_km = round(x_km, 3)
                y_km = round(y_km, 3)
            obs["x_km"] = x_km
            obs["y_km"] = y_km
            obs["r_km"] = round(math.sqrt(x_km**2 + y_km**2), 3)

    # ── TDR interpolation (2D fixed heights + 3D at flight altitude) ──
    # Use earth-relative wind speed for fair comparison with FL winds.
    # Strategy: interpolate storm-relative u/v components separately,
    # add storm motion vector, then compute earth-relative speed.
    # This avoids depending on pre-computed earth-relative fields in the Zarr.
    try:
        # Reuse TDR dataset if already resolved for center extraction above
        if _tdr_ds is not None:
            ds, local_idx = _tdr_ds, _tdr_li
        else:
            ds, local_idx = resolve_case(case_index, data_type)

        # Check which Cartesian u/v components are available
        _u_var = None
        _v_var = None
        for u_cand, v_cand in [
            ("recentered_earth_relative_eastward_wind", "recentered_earth_relative_northward_wind"),
        ]:
            if u_cand in ds and v_cand in ds:
                _u_var, _v_var = u_cand, v_cand
                break

        # If earth-relative components exist, use them directly
        _has_er = _u_var is not None

        for intv, obs_list in avg_results.items():
            if not obs_list:
                continue
            x_arr = np.array([o["x_km"] for o in obs_list], dtype=float)
            y_arr = np.array([o["y_km"] for o in obs_list], dtype=float)

            if _has_er:
                # Earth-relative u/v exist — compute speed from components
                tdr_05 = _interp_tdr_archive(ds, local_idx, "recentered_earth_relative_wind_speed", 0.5, x_arr, y_arr)
                tdr_20 = _interp_tdr_archive(ds, local_idx, "recentered_earth_relative_wind_speed", 2.0, x_arr, y_arr)
            else:
                # Fall back to storm-relative wind speed (best available)
                tdr_05 = _interp_tdr_archive(ds, local_idx, "recentered_wind_speed", 0.5, x_arr, y_arr)
                tdr_20 = _interp_tdr_archive(ds, local_idx, "recentered_wind_speed", 2.0, x_arr, y_arr)

            # 3D interpolation at aircraft altitude
            z_arr = np.array([
                (o.get("gps_alt_m") or 0) / 1000.0 for o in obs_list
            ], dtype=float)
            has_alt = np.any(z_arr > 0)
            if has_alt:
                if _has_er:
                    tdr_fl = _interp_tdr_archive_3d(
                        ds, local_idx, "recentered_earth_relative_wind_speed", x_arr, y_arr, z_arr
                    )
                else:
                    tdr_fl = _interp_tdr_archive_3d(
                        ds, local_idx, "recentered_wind_speed", x_arr, y_arr, z_arr
                    )
            else:
                tdr_fl = np.full(len(obs_list), np.nan)

            for i, obs in enumerate(obs_list):
                obs["tdr_wspd_0p5km"] = round(float(tdr_05[i]), 2) if not np.isnan(tdr_05[i]) else None
                obs["tdr_wspd_2km"] = round(float(tdr_20[i]), 2) if not np.isnan(tdr_20[i]) else None
                obs["tdr_wspd_fl_alt"] = round(float(tdr_fl[i]), 2) if not np.isnan(tdr_fl[i]) else None

    except Exception as e:
        print(f"FL archive TDR interpolation warning: {e}")
        for intv, obs_list in avg_results.items():
            for obs in obs_list:
                obs.setdefault("tdr_wspd_0p5km", None)
                obs.setdefault("tdr_wspd_2km", None)
                obs.setdefault("tdr_wspd_fl_alt", None)

    # Summary statistics from raw 1-sec filtered data
    fl_wspds = [o["fl_wspd_ms"] for o in filtered if o.get("fl_wspd_ms") is not None]
    static_pres = [o["static_pres_hpa"] for o in filtered
                   if o.get("static_pres_hpa") is not None and 200 < o["static_pres_hpa"] < 1100]

    summary = {
        "max_fl_wspd_ms": round(max(fl_wspds), 2) if fl_wspds else None,
        "min_static_pres_hpa": round(min(static_pres), 2) if static_pres else None,
        "total_obs_1hz": len(filtered),
        "mean_alt_m": round(
            sum(o["gps_alt_m"] for o in filtered if o.get("gps_alt_m") is not None)
            / max(1, sum(1 for o in filtered if o.get("gps_alt_m") is not None)),
            0,
        ) if any(o.get("gps_alt_m") is not None for o in filtered) else None,
    }

    # Use 10s as the "primary" observation set for backward compatibility
    averaged_10s = avg_results.get(10, [])

    result = {
        "success": True,
        "observations": averaged_10s,
        "obs_1s": avg_results.get(1, []),
        "obs_10s": averaged_10s,
        "obs_30s": avg_results.get(30, []),
        "analysis_time": scan_dt.strftime("%Y-%m-%d %H:%M:%SZ"),
        "center_lat": center_lat,
        "center_lon": center_lon,
        "center_source": _center_source,
        "mission_id": mission_id,
        "storm_name": storm_name,
        "time_window_min": _FL_TIME_WINDOW_MIN,
        "n_obs": len(averaged_10s),
        "n_obs_raw": len(filtered),
        "source_file": matched_files[0],
        "source_url": fl_url,
        "summary": summary,
    }

    _hrd_fl_cache[cache_key] = (result, now)
    if len(_hrd_fl_cache) > _HRD_FL_CACHE_MAX:
        _hrd_fl_cache.popitem(last=False)

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# Archive Dropsonde Data (HRD .frd format)
# ---------------------------------------------------------------------------

HRD_SONDE_BASE = "https://www.aoml.noaa.gov/ftp/pub/hrd/data/dropsonde"

# Cache for archive dropsonde responses (keyed by "{data_type}_{case_index}")
_hrd_sonde_cache: OrderedDict = OrderedDict()
_HRD_SONDE_CACHE_MAX = 30
_HRD_SONDE_CACHE_TTL = 600  # 10 minutes

SONDE_ARCHIVE_TIME_WINDOW_MIN = 45  # ±45 min for swath matching

# Mapping: 2-digit year → HURR season directory name
# e.g. 2003 → "HURR03", 2014 → "HURR14", 1997 → "HURR97"
def _hurr_season_dir(year: int) -> str:
    """Return the HURR directory name for a given year."""
    return f"HURR{year % 100:02d}"


def _parse_frd_file(text: str) -> Optional[dict]:
    """
    Parse an HRD operationally-processed .frd dropsonde file.

    Returns a dict with:
        meta: dict of header metadata (sonde_id, aircraft, date, time,
              lat, lon, alt, splash_pr, hyd_sfcp, hit_surface,
              estimated_pr_used, gps_verr, format_version)
        profile: dict of arrays (time_s, pres, temp, rh, alt, wspd, wdir,
                                 uwnd, vwnd, lat, lon, theta_e)
    or None if parsing fails.
    """
    lines = text.splitlines()
    if len(lines) < 22:
        return None

    meta = {}

    # --- Parse header (scan all lines up to data start) ---
    # Search broadly — different .frd format versions place fields at different lines
    header_lines = lines[:25]  # generous: scan up to 25 lines for header info
    for line in header_lines:
        stripped = line.strip()
        upper = stripped.upper()
        if "SONDE:" in upper:
            parts = re.split(r"[Ss]onde:", stripped)
            if len(parts) > 1:
                meta["sonde_id"] = parts[1].strip()
        if "FORMAT:" in upper:
            parts = re.split(r"[Ff]ormat:", stripped)
            if len(parts) > 1:
                meta["format_version"] = parts[1].strip()
        if "AIRCRAFT:" in upper:
            m_ac = re.search(r"[Aa]ircraft:\s*(\S+)", stripped)
            if m_ac:
                meta["aircraft"] = m_ac.group(1)
            m_dt = re.search(r"[Dd]ate:\s*(\d{6,8})", stripped)
            if m_dt:
                ds = m_dt.group(1)
                # Handle both YYMMDD and YYYYMMDD
                meta["date_str"] = ds[-6:] if len(ds) > 6 else ds
            m_tm = re.search(r"[Tt]ime:\s*(\d{6})", stripped)
            if m_tm:
                meta["time_str"] = m_tm.group(1)
        if "SPLASH" in upper and "PR" in upper:
            m = re.search(r"[Ss]plash\s*PR\s*=\s*([\d.\-]+)", stripped)
            if m:
                meta["splash_pr"] = float(m.group(1))
        if "HYD" in upper and "SFCP" in upper:
            m = re.search(r"HYD\s*SFCP\s*=\s*([\d.\-]+)", stripped, re.IGNORECASE)
            if m:
                meta["hyd_sfcp"] = float(m.group(1))
        if "GPS" in upper and "VERR" in upper:
            m = re.search(r"GPS\s*VERR\s*=\s*([\d.\-]+)", stripped, re.IGNORECASE)
            if m:
                meta["gps_verr"] = float(m.group(1))
        if "ESTIMATED" in upper and "PR" in upper:
            m = re.search(r"[Ee]stimated\s*PR\s*used\s*=\s*(\S)", stripped)
            if m:
                meta["estimated_pr_used"] = m.group(1).upper() == "Y"
        if "HYD" in upper and "ANCHOR" in upper:
            m = re.search(r"[Hh]yd\s*[Aa]nchor\s*=\s*(\S+)", stripped)
            if m:
                meta["hyd_anchor"] = m.group(1).upper()

    # Parse the second metadata block (Date/Lat/Lon/etc.) — scan broader range
    for line in lines[10:25]:
        stripped = line.strip()
        if "SID:" in stripped:
            m = re.search(r"SID:\s*(\S+)", stripped)
            if m:
                meta["sonde_id"] = m.group(1)
        if "Lat:" in stripped and "Lon:" in stripped:
            m_lat = re.search(r"Lat:\s*([\d.]+)\s*([NS])", stripped)
            m_lon = re.search(r"Lon:\s*([\d.]+)\s*([EW])", stripped)
            if m_lat:
                lat = float(m_lat.group(1))
                if m_lat.group(2) == "S":
                    lat = -lat
                meta["launch_lat"] = lat
            if m_lon:
                lon = float(m_lon.group(1))
                if m_lon.group(2) == "W":
                    lon = -lon
                meta["launch_lon"] = lon
            m_ga = re.search(r"GA:\s*([\d.]+)\s*m", stripped)
            if m_ga:
                meta["launch_alt_m"] = float(m_ga.group(1))

    # Determine if sonde hit the surface
    splash = meta.get("splash_pr", -999.0)
    hyd_anchor = meta.get("hyd_anchor", "MSG").upper()
    meta["hit_surface"] = splash > 0 and hyd_anchor == "SFC"
    # NOTE: For ASPEN PQC .frd files (V4+), hyd_anchor and splash_pr are
    # left blank in the header — so hit_surface will be False here.
    # A fallback check using min profile altitude is applied after profile
    # parsing (see below).

    # Parse launch datetime
    launch_dt = None
    if "date_str" in meta and "time_str" in meta:
        try:
            ds = meta["date_str"]  # YYMMDD
            ts = meta["time_str"]  # HHMMSS
            yy, mm, dd = int(ds[:2]), int(ds[2:4]), int(ds[4:6])
            year = 1900 + yy if yy >= 70 else 2000 + yy
            hh, mi, ss = int(ts[:2]), int(ts[2:4]), int(ts[4:6])
            launch_dt = datetime(year, mm, dd, hh, mi, ss, tzinfo=timezone.utc)
            meta["launch_dt"] = launch_dt
        except (ValueError, IndexError):
            pass

    # --- Find the column header line ---
    data_start = None
    for i, line in enumerate(lines):
        if line.strip().startswith("IX") and "t (s)" in line:
            data_start = i + 1
            break

    if data_start is None:
        return None

    # --- Parse data columns (fixed-width, but we use split) ---
    MISSING = -999.0
    profile = {
        "time_s": [], "pres": [], "temp": [], "rh": [],
        "alt": [], "wspd": [], "wdir": [], "uwnd": [], "vwnd": [],
        "lat": [], "lon": [], "theta_e": [],
    }

    for i in range(data_start, len(lines)):
        stripped = lines[i].strip()
        if not stripped:
            continue
        parts = stripped.split()
        if len(parts) < 18:
            continue

        try:
            t_s   = float(parts[1])
            pres  = float(parts[2])
            temp  = float(parts[3])
            rh    = float(parts[4])
            alt   = float(parts[5])
            wdir  = float(parts[6])
            wspd  = float(parts[7])
            uwnd  = float(parts[8])
            vwnd  = float(parts[9])
            lat   = float(parts[17])
            lon   = float(parts[18])
        except (ValueError, IndexError):
            continue

        # Parse theta_e if present (column index 21 in the extended format)
        theta_e = None
        if len(parts) > 21:
            try:
                te = float(parts[21])
                if te != MISSING:
                    theta_e = te
            except (ValueError, IndexError):
                pass

        def _v(x):
            return None if x == MISSING or x <= MISSING else x

        profile["time_s"].append(round(t_s, 1))
        profile["pres"].append(_v(pres))
        profile["temp"].append(_v(temp))
        profile["rh"].append(_v(rh))
        profile["alt"].append(_v(alt))
        profile["wdir"].append(_v(wdir))
        profile["wspd"].append(_v(wspd))
        profile["uwnd"].append(_v(uwnd))
        profile["vwnd"].append(_v(vwnd))
        profile["lat"].append(_v(lat))
        profile["lon"].append(_v(lon))
        profile["theta_e"].append(theta_e)

    if not profile["time_s"]:
        return None

    # Fallback surface detection for ASPEN PQC files that lack hyd_anchor /
    # splash_pr in the header: if the minimum valid altitude in the profile
    # is 0 m, the sonde reached the surface.
    if not meta["hit_surface"]:
        valid_alts = [a for a in profile["alt"] if a is not None]
        if valid_alts and min(valid_alts) == 0:
            meta["hit_surface"] = True
            meta["_sfc_inferred"] = True  # flag that this was inferred

    return {"meta": meta, "profile": profile}


def _filter_valid_frd_profile(profile: dict) -> dict:
    """
    Filter .frd profile to rows with valid lat, lon, and either alt or pressure.

    Altitude may be entirely missing for sondes that didn't reach the surface
    (Hyd anchor = MSG), so we accept pressure as the vertical coordinate.
    """
    n = len(profile["time_s"])
    mask = []
    for i in range(n):
        lat_ok = profile["lat"][i] is not None
        lon_ok = profile["lon"][i] is not None
        vert_ok = (profile["alt"][i] is not None) or (profile["pres"][i] is not None)
        mask.append(lat_ok and lon_ok and vert_ok)

    filtered = {}
    for key in profile:
        filtered[key] = [profile[key][i] for i in range(n) if mask[i]]
    return filtered


def _build_archive_sonde_response(
    parsed: dict,
    center_lat: float,
    center_lon: float,
    analysis_dt: Optional[datetime],
    storm_u: float = -999,
    storm_v: float = -999,
) -> Optional[dict]:
    """Build a single archive dropsonde entry for the API response.

    If storm_u/storm_v are valid (not -999), each profile point is
    storm-motion-corrected to the analysis time using the same convention
    as flight-level data and real-time dropsondes.
    """
    meta = parsed["meta"]
    profile = _filter_valid_frd_profile(parsed["profile"])

    if not profile["lat"]:
        return None

    has_motion = (storm_u != -999 and storm_v != -999
                  and storm_u is not None and storm_v is not None)

    # ── Parse launch time first (needed for storm-motion correction) ──
    launch_dt = meta.get("launch_dt")
    time_offset_min = None
    launch_time_str = ""
    launch_offset_s = None
    if launch_dt:
        launch_time_str = launch_dt.strftime("%Y-%m-%d %H:%M:%SZ")
        if analysis_dt:
            launch_offset_s = (launch_dt - analysis_dt).total_seconds()
            time_offset_min = round(launch_offset_s / 60.0, 1)

    # Use the sonde's actual surface pressure for altitude estimation fallback
    # instead of standard 1013.25 hPa — critical for TCs with low surface pressure
    sfc_pres_ref = meta.get("hyd_sfcp") or meta.get("splash_pr") or 1013.25
    if sfc_pres_ref <= 0:
        sfc_pres_ref = 1013.25

    x_km_arr = []
    y_km_arr = []
    alt_km_arr = []

    for i in range(len(profile["lat"])):
        x, y = _latlon_to_storm_km_archive(
            profile["lat"][i], profile["lon"][i], center_lat, center_lon
        )
        # Storm-motion correction: shift each point to analysis time
        # dt_s = (launch_time + elapsed_time) - analysis_time
        # x_adj = x + storm_u * (-dt_s) / 1000
        if has_motion and launch_offset_s is not None:
            time_s_i = profile["time_s"][i] if profile["time_s"][i] is not None else 0
            dt_s = launch_offset_s + time_s_i
            x += storm_u * (-dt_s) / 1000.0
            y += storm_v * (-dt_s) / 1000.0
        x_km_arr.append(round(x, 3))
        y_km_arr.append(round(y, 3))
        alt_m = profile["alt"][i]
        # If altitude is missing, estimate from pressure using hypsometric approx
        # relative to the sonde's actual surface pressure (so surface ≈ 0m AGL)
        if alt_m is None and profile["pres"][i] is not None:
            p = profile["pres"][i]
            if p > 0 and p < sfc_pres_ref:
                # Hypsometric: height above surface ≈ (Rd*Tv/g) * ln(Psfc/P)
                # Using Tv ≈ 288K as a tropical mean virtual temperature
                alt_m = (287.04 * 288.0 / 9.81) * math.log(sfc_pres_ref / p)
            elif p > 0:
                # At or below surface pressure — altitude near 0
                alt_m = 0.0
        alt_km_arr.append(round(alt_m / 1000.0, 4) if alt_m is not None else None)

    launch = {
        "lat": profile["lat"][0],
        "lon": profile["lon"][0],
        "alt_m": profile["alt"][0] or (alt_km_arr[0] * 1000.0 if alt_km_arr[0] else None),
        "x_km": x_km_arr[0],
        "y_km": y_km_arr[0],
    }

    surface = {
        "lat": profile["lat"][-1],
        "lon": profile["lon"][-1],
        "alt_m": profile["alt"][-1] or (alt_km_arr[-1] * 1000.0 if alt_km_arr[-1] else None),
        "x_km": x_km_arr[-1],
        "y_km": y_km_arr[-1],
    }

    def _round_list(arr, decimals=3):
        return [round(v, decimals) if v is not None else None for v in arr]

    return {
        "sonde_id": meta.get("sonde_id", ""),
        "launch_time": launch_time_str,
        "time_offset_min": time_offset_min,
        "aircraft": meta.get("aircraft", ""),
        "hit_surface": meta.get("hit_surface", False),
        "splash_pr": meta.get("splash_pr"),
        "hyd_sfcp": meta.get("hyd_sfcp"),
        "estimated_pr_used": meta.get("estimated_pr_used", False),
        "gps_verr": meta.get("gps_verr"),
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
            "dewpoint": [],  # .frd doesn't include dewpoint directly
            "uwnd": _round_list(profile["uwnd"], 2),
            "vwnd": _round_list(profile["vwnd"], 2),
            "theta_e": _round_list(profile.get("theta_e", []), 2),
        },
    }


def _resolve_hurr_season(year: int) -> Optional[str]:
    """
    Resolve the HURR season directory from the AOML dropsonde archive.

    Checks that the directory actually exists on the server.
    Returns the directory name (e.g., "HURR03") or None.
    """
    season_dir = _hurr_season_dir(year)
    season_url = f"{HRD_SONDE_BASE}/{season_dir}/"
    try:
        entries = _hrd_parse_directory(season_url)
        # If we get any entries, the directory exists
        if entries:
            return season_dir
    except Exception:
        pass
    return None


def _resolve_sonde_storm_dir(season_dir: str, storm_name: str) -> Optional[str]:
    """
    Resolve the storm subdirectory within a HURR season for dropsonde data.

    The dropsonde archive may have storm-level subdirectories (e.g.,
    "isabel/operproc/") or place operproc directly in the season dir.
    Returns the resolved base URL path or None.
    """
    season_url = f"{HRD_SONDE_BASE}/{season_dir}/"
    try:
        entries = _hrd_parse_directory(season_url)
    except Exception:
        return None

    dirs = [e.rstrip("/") for e in entries if not e.startswith("?")]

    # Check if "operproc" is directly in the season directory
    if "operproc" in [d.lower() for d in dirs]:
        return f"{HRD_SONDE_BASE}/{season_dir}"

    # Look for storm subdirectory
    target = storm_name.lower().strip()
    for d in dirs:
        if d.lower() == target:
            return f"{HRD_SONDE_BASE}/{season_dir}/{d}"

    # Fuzzy match
    for d in dirs:
        if target.startswith(d.lower()) or d.lower().startswith(target):
            return f"{HRD_SONDE_BASE}/{season_dir}/{d}"

    return None


def _find_frd_tarball(
    base_url: str, mission_id: str, year: int
) -> Optional[str]:
    """
    Find the dropsonde tarball for a given mission_id in the operproc directory.

    mission_id format from TC-RADAR metadata: "201006I1" (YYMMDD + aircraft + flight#)
    or "030914N1" (same, earlier format).

    Archive naming conventions (varies by year):
      Old:  {YYYYMMDD}{aircraft_lower}.frd.tar.gz   e.g. 20030914n.frd.tar.gz
      Mid:  {YYYYMMDD}{Aircraft}{Flight#}_FRD.tar.gz  e.g. 20170905H1_FRD.tar.gz
      New:  {YYYYMMDD}{Aircraft}{Flight#}_DFRD.tar.gz  e.g. 20201006I1_DFRD.tar.gz

    Returns the full URL to the tarball, or None.
    """
    operproc_url = f"{base_url}/operproc/"
    try:
        entries = _hrd_parse_directory(operproc_url)
    except Exception:
        return None

    # Parse mission_id to extract date + aircraft letter + flight number
    # Format: YYMMDD + aircraft_letter + flight_number (e.g. "201006I1")
    m = re.match(r"(\d{6})([A-Za-z])(\d+)", mission_id)
    if not m:
        return None

    short_date = m.group(1)       # "201006"
    aircraft = m.group(2)          # "I"
    flight_num = m.group(3)        # "1"
    century = str(year)[:2]        # "20"
    date_8 = century + short_date  # "20201006"

    # Build candidate prefixes to match (case-insensitive), ordered by priority:
    #  1) _FRD format:   "20170905H1_FRD.tar"   (most common 2010s+)
    #  2) _DFRD format:  "20201006I1_DFRD.tar"   (some newer years)
    #  3) .frd format:   "20030914n.frd.tar"     (old, no flight#, lowercase)
    #  4) Short .frd:    "030914n.frd.tar"        (old 6-digit date)
    date_aircraft_flight = f"{date_8}{aircraft.upper()}{flight_num}"
    candidates = [
        f"{date_aircraft_flight}_frd.tar",      # _FRD format (HURR17 Irma etc.)
        f"{date_aircraft_flight}_dfrd.tar",     # _DFRD format (some newer)
        f"{date_aircraft_flight}.frd.tar",      # hybrid (flight# + .frd)
        f"{date_8}{aircraft.lower()}.frd.tar",  # old format (no flight#)
        f"{short_date}{aircraft.lower()}.frd.tar",  # old short format
    ]

    for entry in entries:
        el = entry.lower().rstrip("/")
        for cand in candidates:
            if el.startswith(cand.lower()):
                return f"{operproc_url}{entry}"

    return None


def _fetch_and_extract_frd_tarball(
    tarball_url: str,
) -> list[tuple[str, str]]:
    """
    Fetch a .frd.tar.gz from AOML and extract all .frd files.

    Returns a list of (filename, file_text) tuples.
    """
    import tarfile

    try:
        import requests as _req
        resp = _req.get(tarball_url, timeout=60)
        resp.raise_for_status()
        data = resp.content
    except ImportError:
        import urllib.request as _urllib
        req = _urllib.Request(tarball_url)
        with _urllib.urlopen(req, timeout=60) as resp:
            data = resp.read()
    except Exception:
        return []

    frd_files = []
    try:
        buf = io.BytesIO(data)
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:
            for member in tar.getmembers():
                if member.name.endswith(".frd") and member.isfile():
                    f = tar.extractfile(member)
                    if f:
                        text = f.read().decode("utf-8", errors="replace")
                        frd_files.append((member.name, text))
    except Exception:
        # Try without gzip (some may be just .tar)
        try:
            buf = io.BytesIO(data)
            with tarfile.open(fileobj=buf, mode="r:") as tar:
                for member in tar.getmembers():
                    if member.name.endswith(".frd") and member.isfile():
                        f = tar.extractfile(member)
                        if f:
                            text = f.read().decode("utf-8", errors="replace")
                            frd_files.append((member.name, text))
        except Exception:
            pass

    return frd_files


@app.get("/dropsondes/archive")
def get_archive_dropsondes(
    case_index: int = Query(..., ge=0, description="0-based case index"),
    data_type: str = Query("swath", description="'swath' or 'merge'"),
):
    """
    Return dropsonde profiles from the HRD .frd archive for an archive case.

    For swath: returns sondes within ±45 min of the TDR analysis time.
    For merge: returns all sondes from the matching flight/mission.

    Fetches operationally-processed .frd files from the AOML HRD archive,
    converts to storm-relative coordinates, and returns profiles.
    """
    now = time.time()
    cache_key = f"sonde_{data_type}_{case_index}"
    if cache_key in _hrd_sonde_cache:
        cached, ts = _hrd_sonde_cache[cache_key]
        if now - ts < _HRD_SONDE_CACHE_TTL:
            _hrd_sonde_cache.move_to_end(cache_key)
            return JSONResponse(cached)

    # Look up case metadata
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    case_meta = cache.get(case_index)
    if not case_meta:
        raise HTTPException(status_code=404, detail=f"case_index {case_index} not found")

    storm_name = case_meta.get("storm_name", "").strip()
    mission_id = case_meta.get("mission_id", "").strip()
    dt_str = case_meta.get("datetime", "")

    # Get storm center — same priority chain as FL endpoint
    center_lat = None
    center_lon = None
    _center_source = None
    # Priority 1: TDR Zarr center_lat/center_lon (if present)
    # Also try to extract storm motion from the Zarr for sonde position correction
    _sonde_storm_u = -999.0
    _sonde_storm_v = -999.0
    try:
        _tdr_ds, _tdr_li = resolve_case(case_index, data_type)
        if "center_lat" in _tdr_ds and "center_lon" in _tdr_ds:
            center_lat = float(_tdr_ds["center_lat"].values[_tdr_li])
            center_lon = float(_tdr_ds["center_lon"].values[_tdr_li])
            _center_source = "tdr_zarr"
        # Storm motion: try per-case variables first, then global attrs
        for _u_key in ("storm_u_ms", "storm_motion_east_ms"):
            if _u_key in _tdr_ds:
                _sonde_storm_u = float(_tdr_ds[_u_key].values[_tdr_li])
                break
        for _v_key in ("storm_v_ms", "storm_motion_north_ms"):
            if _v_key in _tdr_ds:
                _sonde_storm_v = float(_tdr_ds[_v_key].values[_tdr_li])
                break
        # Fallback: global attrs (single-case files or older format)
        if _sonde_storm_u == -999.0 and hasattr(_tdr_ds, "attrs"):
            _sonde_storm_u = float(_tdr_ds.attrs.get(
                "EASTWARD STORM MOTION (METERS PER SECOND)",
                _tdr_ds.attrs.get("storm_motion_east_ms", -999)))
            _sonde_storm_v = float(_tdr_ds.attrs.get(
                "NORTHWARD STORM MOTION (METERS PER SECOND)",
                _tdr_ds.attrs.get("storm_motion_north_ms", -999)))
    except Exception:
        pass
    # Also check case_meta (may have been enriched by FL endpoint)
    if _sonde_storm_u == -999.0:
        _sonde_storm_u = case_meta.get("storm_motion_east_ms", -999.0)
        _sonde_storm_v = case_meta.get("storm_motion_north_ms", -999.0)
    # Priority 2: Metadata cache latitude/longitude (TC-RADAR best-track center)
    if center_lat is None or center_lon is None:
        clat = case_meta.get("latitude")
        clon = case_meta.get("longitude")
        if clat is not None and clon is not None:
            try:
                center_lat = float(clat)
                center_lon = float(clon)
                _center_source = "metadata"
            except (ValueError, TypeError):
                pass
    # Priority 3: ERA5 best-track center
    _swath_idx = _merge_to_swath_index.get(case_index, case_index) if data_type == "merge" else case_index
    if center_lat is None or center_lon is None:
        try:
            era5 = get_era5_dataset()
            if era5 is not None and "center_lat" in era5:
                center_lat = float(era5["center_lat"][_swath_idx])
                center_lon = float(era5["center_lon"][_swath_idx])
                _center_source = "era5"
        except Exception:
            pass
    # Priority 4: IR Zarr best-track center
    if center_lat is None or center_lon is None:
        try:
            ir_store = get_ir_dataset()
            if ir_store is not None and "center_lat" in ir_store:
                center_lat = float(ir_store["center_lat"][_swath_idx])
                center_lon = float(ir_store["center_lon"][_swath_idx])
                _center_source = "ir_zarr"
        except Exception:
            pass

    if center_lat is None or center_lon is None:
        result = {
            "success": False,
            "reason": "no_center",
            "message": "No storm center available for this case",
            "dropsondes": [],
        }
        return JSONResponse(result)

    if not mission_id:
        result = {
            "success": False,
            "reason": "no_mission_id",
            "message": "No mission ID in metadata for this case",
            "dropsondes": [],
        }
        return JSONResponse(result)

    # Parse scan datetime
    scan_dt = _parse_tdr_scan_time(dt_str)
    if scan_dt is None:
        result = {
            "success": False,
            "reason": "bad_datetime",
            "message": f"Could not parse datetime: {dt_str}",
            "dropsondes": [],
        }
        return JSONResponse(result)

    year = scan_dt.year

    # --- Diagnostic tracking ---
    _diag = {"center_source": _center_source, "mission_id": mission_id}

    # Resolve HURR season directory
    season_dir = _resolve_hurr_season(year)
    _diag["season_dir"] = season_dir
    if not season_dir:
        result = {
            "success": False,
            "reason": "no_season_dir",
            "message": f"No HRD dropsonde season directory found for {year}",
            "dropsondes": [],
            "analysis_time": scan_dt.strftime("%Y-%m-%d %H:%M:%SZ"),
            "_diag": _diag,
        }
        _hrd_sonde_cache[cache_key] = (result, now)
        return JSONResponse(result)

    # Resolve storm or base directory (some years have storm subdirs, some don't)
    base_url = _resolve_sonde_storm_dir(season_dir, storm_name)
    _diag["storm_dir_resolved"] = base_url
    if not base_url:
        # Fallback: try season dir directly
        base_url = f"{HRD_SONDE_BASE}/{season_dir}"
        _diag["storm_dir_resolved"] = f"{base_url} (fallback)"

    # Find the tarball for this mission
    tarball_url = _find_frd_tarball(base_url, mission_id, year)
    _diag["tarball_url"] = tarball_url
    _diag["operproc_url"] = f"{base_url}/operproc/"
    if not tarball_url:
        # List what's actually in operproc for debugging
        try:
            _op_entries = _hrd_parse_directory(f"{base_url}/operproc/")
            _diag["operproc_sample"] = _op_entries[:20] if _op_entries else []
            _diag["operproc_count"] = len(_op_entries) if _op_entries else 0
        except Exception as e:
            _diag["operproc_error"] = str(e)
        result = {
            "success": False,
            "reason": "no_tarball",
            "message": f"No dropsonde .frd archive found for mission {mission_id}",
            "dropsondes": [],
            "analysis_time": scan_dt.strftime("%Y-%m-%d %H:%M:%SZ"),
            "center_lat": center_lat,
            "center_lon": center_lon,
            "_diag": _diag,
        }
        _hrd_sonde_cache[cache_key] = (result, now)
        return JSONResponse(result)

    # Fetch and extract .frd files
    frd_files = _fetch_and_extract_frd_tarball(tarball_url)
    _diag["n_frd_extracted"] = len(frd_files)
    _diag["frd_filenames"] = [fn for fn, _ in frd_files[:5]]  # first 5 for debug
    if not frd_files:
        result = {
            "success": False,
            "reason": "empty_tarball",
            "message": f"Could not extract .frd files from archive",
            "dropsondes": [],
            "analysis_time": scan_dt.strftime("%Y-%m-%d %H:%M:%SZ"),
            "center_lat": center_lat,
            "center_lon": center_lon,
            "_diag": _diag,
        }
        _hrd_sonde_cache[cache_key] = (result, now)
        return JSONResponse(result)

    # Parse all .frd files
    dropsondes = []
    for fname, text in frd_files:
        parsed = _parse_frd_file(text)
        if parsed is None:
            continue

        sonde_resp = _build_archive_sonde_response(
            parsed, center_lat, center_lon, scan_dt,
            storm_u=_sonde_storm_u, storm_v=_sonde_storm_v,
        )
        if sonde_resp is None:
            continue

        # Apply time filtering for swath data
        if data_type == "swath" and sonde_resp["time_offset_min"] is not None:
            if abs(sonde_resp["time_offset_min"]) > SONDE_ARCHIVE_TIME_WINDOW_MIN:
                continue

        dropsondes.append(sonde_resp)

    # Sort by time offset
    dropsondes.sort(
        key=lambda s: abs(s["time_offset_min"]) if s["time_offset_min"] is not None else 999
    )

    _has_sm = (_sonde_storm_u != -999 and _sonde_storm_v != -999
               and _sonde_storm_u is not None and _sonde_storm_v is not None)
    result = {
        "success": True,
        "dropsondes": dropsondes,
        "analysis_time": scan_dt.strftime("%Y-%m-%d %H:%M:%SZ"),
        "center_lat": center_lat,
        "center_lon": center_lon,
        "mission_id": mission_id,
        "storm_name": storm_name,
        "data_type": data_type,
        "time_window_min": SONDE_ARCHIVE_TIME_WINDOW_MIN if data_type == "swath" else None,
        "n_sondes": len(dropsondes),
        "n_frd_files": len(frd_files),
        "source_url": tarball_url,
        "storm_motion_corrected": _has_sm,
        "storm_motion_east_ms": round(_sonde_storm_u, 2) if _has_sm else None,
        "storm_motion_north_ms": round(_sonde_storm_v, 2) if _has_sm else None,
    }

    _hrd_sonde_cache[cache_key] = (result, now)
    if len(_hrd_sonde_cache) > _HRD_SONDE_CACHE_MAX:
        _hrd_sonde_cache.popitem(last=False)

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# Anomaly diagnostics — Fischer et al. (2025, MWR)
# ---------------------------------------------------------------------------

def _get_climatology_for_intensity(varname: str, vmax_kt: float):
    """
    Look up the precomputed climatological mean and std for a variable
    at the nearest intensity bin centre.

    Returns (mean_2d, std_2d, count, bin_centre) or (None, None, 0, None).
    """
    if not _climatology:
        return None, None, 0, None

    centres = _climatology.get("intensity_centres")
    if centres is None:
        return None, None, 0, None

    idx = int(np.argmin(np.abs(centres - vmax_kt)))
    bin_centre = int(centres[idx])

    mean_key = f"{varname}_mean_{bin_centre}"
    std_key = f"{varname}_std_{bin_centre}"
    count_key = f"{varname}_count_{bin_centre}"

    if mean_key not in _climatology or std_key not in _climatology:
        return None, None, 0, bin_centre

    return (_climatology[mean_key], _climatology[std_key],
            int(_climatology.get(count_key, 0)), bin_centre)


def _compute_anomaly_for_case(ds, local_idx, case_index, variable, data_type):
    """
    Compute the Z-score anomaly field for a single case on the hybrid R_H grid.
    """
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    case_meta = cache.get(case_index, {})
    vmax = case_meta.get("vmax_kt")
    rmw = case_meta.get("rmw_km")

    if vmax is None or rmw is None or rmw <= 0:
        raise HTTPException(status_code=400,
                            detail=f"Case {case_index} missing vmax_kt or rmw_km")

    display_name, varname, cmap, units, vmin_lim, vmax_lim = VARIABLES[variable]

    if variable in DERIVED_VARIABLES:
        ref_varname = DERIVED_VARIABLES[variable][0]
    else:
        if varname not in ds:
            raise HTTPException(status_code=400, detail=f"'{varname}' not in dataset.")
        ref_varname = varname

    var_dims = set(ds[ref_varname].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        x_coords = ds["eastward_distance"].values
        y_coords = ds["northward_distance"].values
    elif "latitude" in var_dims and "longitude" in var_dims:
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x_coords = np.linspace(-(nx - 1), (nx - 1), nx)
        y_coords = np.linspace(-(ny - 1), (ny - 1), ny)
    else:
        raise HTTPException(status_code=500, detail="Cannot determine spatial grid")

    dim_list = [d for d in ds[ref_varname].dims if d != "num_cases"]
    if "height" not in dim_list:
        raise HTTPException(status_code=500, detail="Cannot determine height axis")
    h_axis = dim_list.index("height")
    height_vals = ds["height"].values

    vol, _ = _extract_3d_volume(ds, local_idx, variable)
    az_raw, cov, r_h_axis, n_inner = _compute_azimuthal_mean_hybrid(
        vol, x_coords, y_coords, height_vals, h_axis, rmw, coverage_min=0.5
    )

    # Map variable to its merged_* climatology equivalent
    climo_varname = _CLIMO_VAR_MAP.get(varname, varname)
    clim_mean, clim_std, clim_count, bin_centre = _get_climatology_for_intensity(
        climo_varname, vmax
    )

    if clim_mean is None:
        return {
            "anomaly": None,
            "raw": _clean_2d(az_raw),
            "clim_mean": None, "clim_std": None,
            "r_h_axis": r_h_axis, "n_inner": n_inner,
            "height_km": [round(float(h), 2) for h in height_vals],
            "clim_count": 0, "clim_bin_kt": None,
            "error": "Climatology not available. Run precompute_climatology.py.",
        }

    # Minimum std floor: prevent extreme Z* from near-zero std cells
    _STD_FLOOR = 5e-5 if "vorticity" in varname else 1.0
    anomaly = np.where(
        np.isnan(az_raw) | np.isnan(clim_mean) | np.isnan(clim_std)
        | (clim_std < _STD_FLOOR),
        np.nan, (az_raw - clim_mean) / clim_std
    )

    return {
        "anomaly": _clean_2d(anomaly),
        "raw": _clean_2d(az_raw),
        "clim_mean": _clean_2d(clim_mean),
        "clim_std": _clean_2d(clim_std),
        "r_h_axis": r_h_axis, "n_inner": n_inner,
        "height_km": [round(float(h), 2) for h in height_vals],
        "clim_count": clim_count, "clim_bin_kt": bin_centre,
    }


def _process_one_case_anomaly(case_idx, variable, data_type):
    """
    Compute the Z-score anomaly on the hybrid R_H grid for a single case.
    Runs in the thread-pool worker — all args passed explicitly.
    Returns (case_idx, anomaly_2d_np, r_h_axis, n_inner) or None on failure.
    """
    try:
        cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
        meta = cache.get(case_idx, {})
        vmax = meta.get("vmax_kt")
        rmw = meta.get("rmw_km")
        if vmax is None or rmw is None or rmw <= 0:
            return None

        ds, local_idx = resolve_case(case_idx, data_type)

        display_name, varname, cmap, units, vmin_lim, vmax_lim = VARIABLES[variable]
        ref_varname = DERIVED_VARIABLES[variable][0] if variable in DERIVED_VARIABLES else varname

        x_coords, y_coords, h_axis = _resolve_grid_and_haxis(ds, ref_varname)
        height_vals = ds["height"].values

        vol, _ = _extract_3d_volume(ds, local_idx, variable)
        az_raw, cov, r_h_axis, n_inner = _compute_azimuthal_mean_hybrid(
            vol, x_coords, y_coords, height_vals, h_axis, rmw, coverage_min=0.5
        )

        climo_varname = _CLIMO_VAR_MAP.get(varname, varname)
        clim_mean, clim_std, clim_count, bin_centre = _get_climatology_for_intensity(
            climo_varname, vmax
        )
        if clim_mean is None:
            return None

        _STD_FLOOR = 5e-5 if "vorticity" in varname else 1.0
        anomaly = np.where(
            np.isnan(az_raw) | np.isnan(clim_mean) | np.isnan(clim_std)
            | (clim_std < _STD_FLOOR),
            np.nan, (az_raw - clim_mean) / clim_std
        )
        return (case_idx, anomaly, r_h_axis, n_inner)
    except Exception as e:
        print(f"Composite anomaly: skipping case {case_idx}: {e}")
        return None


@app.get("/composite/anomaly_azimuthal_mean")
def composite_anomaly_azimuthal_mean(
    variable:       str   = Query("merged_tangential_wind", description="Variable key"),
    data_type:      str   = Query("merge",                  description="'swath' or 'merge'"),
    stream:         bool  = Query(False,                     description="Stream NDJSON progress events"),
    min_intensity:  float = Query(0),    max_intensity:  float = Query(200),
    min_vmax_change:float = Query(-100), max_vmax_change:float = Query(85),
    min_tilt:       float = Query(0),    max_tilt:       float = Query(200),
    min_year:       int   = Query(1997), max_year:       int   = Query(2024),
    min_shear_mag:  float = Query(0),    max_shear_mag:  float = Query(100),
    min_shear_dir:  float = Query(0),    max_shear_dir:  float = Query(360),
    min_dtl:        float = Query(0),    dtl_window:     str   = Query("24h"),
):
    """
    Composite Z-score anomaly on the hybrid R_H coordinate (Fischer et al. 2025).
    Computes per-case anomalies against the intensity-binned climatology, then averages.
    """
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    matching = _filter_cases_for_composite(
        min_intensity, max_intensity, min_vmax_change, max_vmax_change,
        min_tilt, max_tilt, min_year, max_year,
        min_shear_mag, max_shear_mag, min_shear_dir, max_shear_dir,
        min_dtl=min_dtl, dtl_window=dtl_window,
        data_type=data_type,
    )
    if not matching:
        raise HTTPException(status_code=400, detail="No cases match the specified criteria.")
    if len(matching) > _COMPOSITE_MAX_CASES:
        matching = matching[:_COMPOSITE_MAX_CASES]

    # Filter to cases with valid RMW and Vmax (needed for anomaly computation)
    meta_cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    valid_cases = []
    for ci in matching:
        meta = meta_cache.get(ci, {})
        rmw = meta.get("rmw_km")
        vmax = meta.get("vmax_kt")
        if (rmw is not None and not np.isnan(float(rmw)) and float(rmw) > 0
                and vmax is not None):
            valid_cases.append(ci)
    if not valid_cases:
        raise HTTPException(status_code=400, detail="No matching cases have valid RMW/Vmax data.")

    display_name, varname, cmap, units, vmin, vmax_lim = VARIABLES[variable]

    # Build work items — lightweight tuple per case
    work_items = [(ci, variable, data_type) for ci in valid_cases]

    def _compute(progress_cb=None):
        accum_sum = None
        accum_count = None
        r_h_axis = None
        n_inner = None
        n_processed = 0
        processed_indices = []

        def _accum(result):
            nonlocal accum_sum, accum_count, r_h_axis, n_inner, n_processed
            case_idx, anomaly, rh, ni = result
            if accum_sum is None:
                r_h_axis = rh
                n_inner = ni
                accum_sum = np.zeros_like(anomaly)
                accum_count = np.zeros_like(anomaly)
            valid = ~np.isnan(anomaly)
            accum_sum[valid] += anomaly[valid]
            accum_count[valid] += 1
            n_processed += 1
            processed_indices.append(case_idx)

        _process_composites_batched(
            _process_one_case_anomaly, work_items, _accum,
            progress_cb=progress_cb,
        )

        if n_processed == 0:
            raise RuntimeError("Could not compute anomaly for any matching case. "
                               "Ensure climatology is precomputed.")

        min_cases = max(3, int(np.ceil(0.33 * n_processed)))
        composite = np.where(accum_count >= min_cases, accum_sum / accum_count, np.nan)

        # Get height from first valid case
        first_ds, _ = resolve_case(processed_indices[0], data_type)
        height_km = first_ds["height"].values

        return {
            "anomaly": _clean_2d(composite),
            "r_h_axis": r_h_axis,
            "n_inner": n_inner,
            "height_km": [round(float(h), 2) for h in height_km],
            "n_cases": n_processed,
            "n_matched": len(matching),
            "min_cases_per_bin": min_cases,
            "case_list": _build_case_list(processed_indices, data_type),
            "variable": {
                "key": variable,
                "display_name": display_name,
                "units": units,
                "anomaly_units": "\u03c3 (standardized)",
                "colorscale": _cmap_to_plotly("RdBu_r"),
                "vmin": -3, "vmax": 3,
            },
            "filters": {
                "intensity": [min_intensity, max_intensity],
                "vmax_change": [min_vmax_change, max_vmax_change],
                "tilt": [min_tilt, max_tilt],
                "year": [min_year, max_year],
                "shear_mag": [min_shear_mag, max_shear_mag],
                "shear_dir": [min_shear_dir, max_shear_dir],
            },
        }

    if stream:
        return _streaming_composite_response(_compute)
    return JSONResponse(_compute())


@app.get("/anomaly/azimuthal_mean")
def anomaly_azimuthal_mean(
    case_index:   int = Query(..., ge=0, description="0-based case index"),
    variable:     str = Query("merged_tangential_wind", description="Variable key"),
    data_type:    str = Query("merge", description="'swath' or 'merge'"),
):
    """
    Return Z-score anomaly of the azimuthal-mean field on the hybrid R_H
    grid for a single case (Fischer et al. 2025, MWR, Eq. 1).
    """
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    try:
        ds, local_idx = resolve_case(case_index, data_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    result = _compute_anomaly_for_case(ds, local_idx, case_index, variable, data_type)

    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    meta = cache.get(case_index, {})
    display_name, _, cmap_raw, units, vmin_raw, vmax_raw = VARIABLES[variable]

    result["variable"] = {
        "key": variable,
        "display_name": display_name,
        "units": units,
        "anomaly_units": "σ (standardized)",
        "colorscale": _cmap_to_plotly("RdBu_r"),
        "vmin": -3, "vmax": 3,
        "raw_vmin": vmin_raw, "raw_vmax": vmax_raw,
        "raw_colorscale": _cmap_to_plotly(cmap_raw),
    }
    result["case_meta"] = {
        "case_index": case_index,
        "storm_name": meta.get("storm_name", ""),
        "datetime": meta.get("datetime", ""),
        "vmax_kt": meta.get("vmax_kt"),
        "rmw_km": meta.get("rmw_km"),
    }
    return JSONResponse(result)


@app.get("/hybrid/azimuthal_mean")
def hybrid_azimuthal_mean(
    case_index:    int   = Query(..., ge=0, description="0-based case index"),
    variable:      str   = Query(DEFAULT_VARIABLE, description="Variable key"),
    data_type:     str   = Query("merge", description="'swath' or 'merge'"),
    coverage_min:  float = Query(0.5, ge=0.0, le=1.0),
    overlay:       str   = Query("", description="Optional overlay variable key"),
):
    """Return azimuthal mean on the hybrid R_H coordinate (no anomaly)."""
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    try:
        ds, local_idx = resolve_case(case_index, data_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    meta = cache.get(case_index, {})
    rmw = meta.get("rmw_km")
    if rmw is None or rmw <= 0:
        raise HTTPException(status_code=400,
                            detail=f"Case {case_index} missing valid rmw_km")

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]
    height_vals = ds["height"].values

    ref_varname = DERIVED_VARIABLES[variable][0] if variable in DERIVED_VARIABLES else varname
    var_dims = set(ds[ref_varname].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        x_coords = ds["eastward_distance"].values
        y_coords = ds["northward_distance"].values
    elif "latitude" in var_dims and "longitude" in var_dims:
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x_coords = np.linspace(-(nx - 1), (nx - 1), nx)
        y_coords = np.linspace(-(ny - 1), (ny - 1), ny)
    else:
        raise HTTPException(status_code=500, detail="Cannot determine spatial grid")

    dim_list = [d for d in ds[ref_varname].dims if d != "num_cases"]
    h_axis = dim_list.index("height")

    vol, _ = _extract_3d_volume(ds, local_idx, variable)
    az_mean, coverage, r_h_axis, n_inner = _compute_azimuthal_mean_hybrid(
        vol, x_coords, y_coords, height_vals, h_axis, rmw, coverage_min
    )

    case_meta = _build_case_meta(case_index, ds, local_idx, data_type)

    result = {
        "azimuthal_mean": _clean_2d(az_mean),
        "coverage": _clean_2d(coverage),
        "r_h_axis": r_h_axis, "n_inner": n_inner,
        "height_km": [round(float(h), 2) for h in height_vals],
        "coverage_min": coverage_min,
        "coordinate": "hybrid",
        "variable": {
            "key": variable, "display_name": display_name, "units": units,
            "vmin": vmin, "vmax": vmax, "colorscale": _cmap_to_plotly(cmap),
        },
        "case_meta": case_meta,
    }

    if overlay and overlay in VARIABLES:
        ov_display, _, ov_cmap, ov_units, ov_vmin, ov_vmax = VARIABLES[overlay]
        try:
            ov_vol, _ = _extract_3d_volume(ds, local_idx, overlay)
            ov_az, _, _, _ = _compute_azimuthal_mean_hybrid(
                ov_vol, x_coords, y_coords, height_vals, h_axis, rmw, coverage_min
            )
            result["overlay"] = {
                "azimuthal_mean": _clean_2d(ov_az),
                "key": overlay, "display_name": ov_display,
                "units": ov_units, "vmin": ov_vmin, "vmax": ov_vmax,
            }
        except Exception:
            pass

    return JSONResponse(result)


# ---------------------------------------------------------------------------
# Vortex metrics — Table 1 in Fischer et al. (2025, MWR)
# ---------------------------------------------------------------------------

def _compute_vortex_metrics_for_case(case_index, ds, local_idx, data_type):
    """
    Compute vortex height, width, and favorability for a single case
    using the anomaly field on the hybrid R_H grid (Table 1).
    """
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    meta = cache.get(case_index, {})
    vmax = meta.get("vmax_kt")
    rmw = meta.get("rmw_km")
    if vmax is None or rmw is None or rmw <= 0:
        return None

    vt_var = "merged_tangential_wind"
    zeta_var = "merged_relative_vorticity"

    vt_clim_mean, vt_clim_std, _, _ = _get_climatology_for_intensity(vt_var, vmax)
    zeta_clim_mean, zeta_clim_std, _, _ = _get_climatology_for_intensity(zeta_var, vmax)
    if vt_clim_mean is None or zeta_clim_mean is None:
        return None

    if vt_var not in ds or zeta_var not in ds:
        return None

    var_dims = set(ds[vt_var].dims)
    if "eastward_distance" in var_dims and "northward_distance" in var_dims:
        if "eastward_distance" in ds.coords:
            x_coords = ds["eastward_distance"].values
            y_coords = ds["northward_distance"].values
        else:
            nx = ds.sizes["eastward_distance"]
            ny = ds.sizes["northward_distance"]
            x_coords = np.linspace(-(nx // 2), (nx // 2), nx)
            y_coords = np.linspace(-(ny // 2), (ny // 2), ny)
    elif "latitude" in var_dims and "longitude" in var_dims:
        nx = ds.sizes["longitude"]
        ny = ds.sizes["latitude"]
        x_coords = np.linspace(-(nx - 1), (nx - 1), nx)
        y_coords = np.linspace(-(ny - 1), (ny - 1), ny)
    else:
        # Infer from actual data shape
        sample = ds[vt_var].isel(num_cases=0).shape
        ny, nx = sample[-2], sample[-1]
        x_coords = np.linspace(-(nx // 2), (nx // 2), nx)
        y_coords = np.linspace(-(ny // 2), (ny // 2), ny)

    height_vals = ds["height"].values
    dim_list = [d for d in ds[vt_var].dims if d != "num_cases"]
    h_axis = dim_list.index("height") if "height" in dim_list else 0

    vt_vol = ds[vt_var].isel(num_cases=local_idx).values
    vt_az, _, r_h_axis, n_inner = _compute_azimuthal_mean_hybrid(
        vt_vol, x_coords, y_coords, height_vals, h_axis, rmw
    )

    zeta_vol = ds[zeta_var].isel(num_cases=local_idx).values
    zeta_az, _, _, _ = _compute_azimuthal_mean_hybrid(
        zeta_vol, x_coords, y_coords, height_vals, h_axis, rmw
    )

    # Minimum std floors: cells with near-zero std are unreliable and
    # produce extreme Z* values that distort vortex metrics.
    _VT_STD_FLOOR = 1.0       # m/s
    _ZETA_STD_FLOOR = 5e-5    # s⁻¹
    vt_anom = np.where(
        np.isnan(vt_az) | np.isnan(vt_clim_mean) | np.isnan(vt_clim_std)
        | (vt_clim_std < _VT_STD_FLOOR),
        np.nan, (vt_az - vt_clim_mean) / vt_clim_std
    )
    zeta_anom = np.where(
        np.isnan(zeta_az) | np.isnan(zeta_clim_mean) | np.isnan(zeta_clim_std)
        | (zeta_clim_std < _ZETA_STD_FLOOR),
        np.nan, (zeta_az - zeta_clim_mean) / zeta_clim_std
    )

    r_arr = np.array(r_h_axis, dtype=float)

    def r_h_mask(lo_inner, hi_inner, lo_outer, hi_outer):
        """Boolean mask over r_h bins for inner (R/RMW) and outer (km) ranges."""
        mask = np.zeros(len(r_arr), dtype=bool)
        for i, rv in enumerate(r_arr):
            if i < n_inner:
                if lo_inner is not None and rv >= lo_inner and rv <= hi_inner:
                    mask[i] = True
            else:
                if lo_outer is not None and rv >= lo_outer and rv <= hi_outer:
                    mask[i] = True
        return mask

    z_mask = lambda lo, hi: (height_vals >= lo) & (height_vals <= hi)

    # Domain H1: 0.8×RMW to RMW+20km, Z=10–14 km
    h1_r = r_h_mask(0.8, 1.0, 0.0, 20.0)
    h1_z = z_mask(10.0, 14.0)

    # Domain W1: 0.9×RMW to RMW+10km, Z=2–5 km
    w1_r = r_h_mask(0.9, 1.0, 0.0, 10.0)
    w1_z = z_mask(2.0, 5.0)

    # Domain W2: RMW+30 to RMW+70km, Z=2–5 km
    w2_r = r_h_mask(None, None, 30.0, 70.0)
    w2_z = z_mask(2.0, 5.0)

    try:
        h1_vt = vt_anom[np.ix_(h1_z, h1_r)]
        if np.all(np.isnan(h1_vt)):
            if case_index < 10 or case_index % 50 == 0:
                print(f"  [vortex skip] case {case_index}: H1 domain all-NaN "
                      f"(h1_z={h1_z.sum()} levels, h1_r={h1_r.sum()} bins, "
                      f"vmax={meta.get('vmax_kt')}, rmw={meta.get('rmw_km')})")
            return None
        raw_h1_max = float(np.nanmax(h1_vt))

        w1_zeta = zeta_anom[np.ix_(w1_z, w1_r)]
        w2_zeta = zeta_anom[np.ix_(w2_z, w2_r)]
        if np.all(np.isnan(w1_zeta)) or np.all(np.isnan(w2_zeta)):
            return None
        raw_w1_mean = float(np.nanmean(w1_zeta))
        raw_w2_mean = float(np.nanmean(w2_zeta))
        raw_width_diff = raw_w2_mean - raw_w1_mean

        # Return RAW (un-centered) metrics — the caller will subtract
        # database means in a second pass to produce zero-centred metrics
        # per Fischer et al. (2025, MWR) Table 1.
        return {
            "raw_h1_max": raw_h1_max,
            "raw_width_diff": raw_width_diff,
        }
    except Exception:
        return None


@app.get("/scatter/vp_favorability")
def scatter_vp_favorability(
    data_type: str = Query("merge", description="'swath' or 'merge'"),
    color_by:  str = Query("dvmax_12h", description="dvmax_12h or dvmax_24h"),
):
    """
    Return VP vs Vortex Favorability scatter data for all cases.
    Designed for the Fig. 9 scatter plot from Fischer et al. (2025).
    """
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")
    if color_by not in ("dvmax_12h", "dvmax_24h"):
        raise HTTPException(status_code=400, detail="color_by must be dvmax_12h or dvmax_24h")

    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache

    # Log whether vortex metrics have been finalized (debug aid)
    print(f"[scatter] _vortex_eras_done={_vortex_eras_done}, "
          f"_vortex_raw has {len(_vortex_raw)} entries, "
          f"cache size={len(cache)}")

    points = []
    for ci, meta in cache.items():
        vp = meta.get("vp")
        dvmax = meta.get(color_by)
        if vp is None or dvmax is None:
            continue

        points.append({
            "case_index": ci,
            "mission_id": meta.get("mission_id", ""),
            "storm_name": meta.get("storm_name", ""),
            "datetime": meta.get("datetime", ""),
            "vmax_kt": meta.get("vmax_kt"),
            "vp": vp,
            "vortex_favorability": meta.get("vortex_favorability"),
            "vortex_height": meta.get("vortex_height"),
            "vortex_width": meta.get("vortex_width"),
            "dtl_min_12h": meta.get("dtl_min_12h"),
            "dtl_min_24h": meta.get("dtl_min_24h"),
            color_by: dvmax,
        })

    # Compute group statistics for 2σ ellipses
    groups = {"RI": [], "SI": [], "NI": []}
    for p in points:
        if p["vortex_favorability"] is None:
            continue
        dv = p.get(color_by, 0) or 0
        if dv >= 20:
            groups["RI"].append(p)
        elif dv > 0:
            groups["SI"].append(p)
        else:
            groups["NI"].append(p)

    ellipses = {}
    for name, pts in groups.items():
        if len(pts) < 3:
            continue
        vps = [p["vp"] for p in pts]
        vfs = [p["vortex_favorability"] for p in pts]
        ellipses[name] = {
            "mean_vp": round(float(np.mean(vps)), 2),
            "mean_vf": round(float(np.mean(vfs)), 2),
            "std_vp": round(float(np.std(vps)), 2),
            "std_vf": round(float(np.std(vfs)), 2),
            "n": len(pts),
        }

    vortex_ready = _vortex_eras_done >= 2
    return JSONResponse(
        content={
            "points": points, "color_by": color_by,
            "ellipses": ellipses,
            "n_total": len(points),
            "n_with_vf": sum(1 for p in points if p["vortex_favorability"] is not None),
            "vortex_ready": vortex_ready,
            "db_means": _vortex_db_means if _vortex_db_means else None,
        },
        headers={"Cache-Control": "no-store"},
    )


@app.get("/climatology/info")
def climatology_info():
    """Return metadata about the loaded climatology."""
    if not _climatology:
        return JSONResponse({
            "available": False,
            "message": "Climatology not loaded. Run precompute_climatology.py.",
        })

    centres = _climatology.get("intensity_centres", np.array([]))
    r_h = _climatology.get("r_h_axis", np.array([]))
    h_km = _climatology.get("height_km", np.array([]))
    n_inner = int(_climatology.get("n_inner", 0))

    var_names = set()
    for k in _climatology:
        if k.endswith("_mean_25"):
            var_names.add(k.rsplit("_mean_", 1)[0])

    return JSONResponse({
        "available": True,
        "intensity_centres": [int(c) for c in centres],
        "intensity_half_width_kt": 10,
        "n_radial_bins": len(r_h),
        "n_inner_bins": n_inner,
        "n_heights": len(h_km),
        "variables": sorted(var_names),
    })


# ---------------------------------------------------------------------------
# Hovmöller — time × radius at a single height level
# ---------------------------------------------------------------------------

@app.get("/hovmoller")
def hovmoller(
    storm_name: str   = Query(...,                        description="Storm name (e.g. IRMA)"),
    year:       int   = Query(...,   ge=1997, le=2030,    description="Storm year"),
    variable:   str   = Query(DEFAULT_VARIABLE,           description="Variable key — see /variables"),
    data_type:  str   = Query("swath",                    description="'swath' or 'merge'"),
    height_km:  float = Query(2.0,   ge=0.0, le=18.0,    description="Height level in km"),
    max_radius_km: float = Query(200.0, ge=10, le=500,   description="Maximum radius in km"),
    dr_km:      float = Query(2.0,   ge=0.5, le=20,      description="Radial bin width in km"),
    coverage_min: float = Query(0.5, ge=0.0, le=1.0,     description="Min fraction of valid data per bin"),
):
    """
    Compute azimuthal-mean radial profiles at a fixed height for ALL cases
    of a given storm.  Returns discrete per-case profiles (no interpolation),
    suitable for a scatter-style Hovmöller plot.
    """
    if variable not in VARIABLES:
        raise HTTPException(status_code=400, detail=f"Unknown variable '{variable}'.")
    if data_type not in ("swath", "merge"):
        raise HTTPException(status_code=400, detail="data_type must be 'swath' or 'merge'")

    # Find all cases for this storm
    cache = _merge_metadata_cache if data_type == "merge" else _metadata_cache
    storm_cases = []
    for ci, meta in cache.items():
        if meta.get("storm_name", "").upper() == storm_name.upper() and meta.get("year") == year:
            storm_cases.append((ci, meta))

    if not storm_cases:
        raise HTTPException(status_code=404, detail=f"No cases found for {storm_name} ({year})")

    # Sort by datetime
    storm_cases.sort(key=lambda x: x[1].get("datetime", ""))

    display_name, varname, cmap, units, vmin, vmax = VARIABLES[variable]

    # Compute radial profile for each case at the specified height
    profiles = []
    r_centers = None

    for ci, meta in storm_cases:
        try:
            ds, local_idx = resolve_case(ci, data_type)
            vol, ref_var = _extract_3d_volume(ds, local_idx, variable)

            height_vals = ds["height"].values
            z_idx = int(np.argmin(np.abs(height_vals - height_km)))
            actual_height = float(height_vals[z_idx])

            # Determine spatial grid
            if variable in DERIVED_VARIABLES:
                ref_varname = DERIVED_VARIABLES[variable][0]
            else:
                ref_varname = varname
            var_dims = set(ds[ref_varname].dims)
            if "eastward_distance" in var_dims:
                x_coords = ds["eastward_distance"].values
                y_coords = ds["northward_distance"].values
            elif "latitude" in var_dims:
                nx = ds.sizes["longitude"]
                ny = ds.sizes["latitude"]
                x_coords = np.linspace(-(nx - 1), (nx - 1), nx)
                y_coords = np.linspace(-(ny - 1), (ny - 1), ny)
            else:
                continue

            dim_list = [d for d in ds[ref_varname].dims if d != "num_cases"]
            h_axis = dim_list.index("height")

            # Extract 2D slab at height
            if h_axis == 0:
                slab = vol[z_idx, :, :]
            elif h_axis == 2:
                slab = vol[:, :, z_idx]
            else:
                slab = vol[:, z_idx, :]

            # Compute azimuthal mean at this single height
            xx, yy = np.meshgrid(x_coords, y_coords)
            rr = np.sqrt(xx**2 + yy**2)
            r_edges = np.arange(0, max_radius_km + dr_km, dr_km)
            r_ctrs = (r_edges[:-1] + r_edges[1:]) / 2.0
            bin_idx = np.digitize(rr, r_edges) - 1
            valid = ~np.isnan(slab)

            profile = []
            for r in range(len(r_ctrs)):
                mask = (bin_idx == r)
                n_total = np.count_nonzero(mask)
                if n_total == 0:
                    profile.append(None)
                    continue
                in_bin = mask & valid
                n_valid = np.count_nonzero(in_bin)
                frac = n_valid / n_total
                if frac >= coverage_min:
                    profile.append(round(float(np.nanmean(slab[in_bin])), 4))
                else:
                    profile.append(None)

            if r_centers is None:
                r_centers = [round(float(r), 2) for r in r_ctrs]

            # Use metadata RMW if available; otherwise estimate from profile peak
            rmw = meta.get("rmw_km")
            if rmw is None or (isinstance(rmw, float) and np.isnan(rmw)):
                # Estimate RMW as radius of maximum azimuthal-mean value
                valid_vals = [(i, v) for i, v in enumerate(profile) if v is not None]
                if valid_vals:
                    peak_idx, peak_val = max(valid_vals, key=lambda x: x[1])
                    rmw = round(float(r_ctrs[peak_idx]), 1)

            profiles.append({
                "case_index": ci,
                "datetime": meta.get("datetime", ""),
                "mission_id": meta.get("mission_id", ""),
                "vmax_kt": meta.get("vmax_kt"),
                "rmw_km": rmw,
                "profile": profile,
            })

        except Exception as e:
            print(f"Hovmöller: skip case {ci}: {e}")
            continue

    if not profiles:
        raise HTTPException(status_code=500, detail="No valid profiles computed")

    return JSONResponse(
        content={
            "storm_name": storm_name.upper(),
            "year": year,
            "height_km": round(height_km, 1),
            "radius_km": r_centers,
            "variable": {
                "key": variable,
                "display_name": display_name,
                "units": units,
                "vmin": vmin,
                "vmax": vmax,
                "colorscale": _cmap_to_plotly(cmap),
            },
            "profiles": profiles,
            "n_cases": len(profiles),
        },
        headers={"Cache-Control": "public, max-age=3600"},
    )


from realtime_tdr_api import router as realtime_router
app.include_router(realtime_router, prefix="/realtime")

from global_archive_api import router as global_router
app.include_router(global_router, prefix="/global")

from ir_monitor_api import (
    router as ir_monitor_router,
    start_background_refresh as _ir_start_bg,
    refresh_active_storms_cache as _ir_refresh,
)
app.include_router(ir_monitor_router, prefix="/ir-monitor")
_ir_start_bg()  # Start background storm cache refresh thread

try:
    from microwave_api import router as microwave_router, start_index_build as _mw_start
    app.include_router(microwave_router, prefix="/microwave")
    # Kick off the TC-PRIMED overpass index build in a background thread.
    # The index maps TC-RADAR cases to temporally nearby microwave overpasses.
    _mw_start()
    print("[microwave] Router mounted and index build started")
except Exception as _mw_err:
    import traceback
    print(f"[microwave] FAILED to load microwave_api: {_mw_err}")
    traceback.print_exc()

try:
    from nexrad_api import router as nexrad_router
    app.include_router(nexrad_router, prefix="/nexrad")
    print("[nexrad] Router mounted")
except Exception as _nx_err:
    import traceback
    print(f"[nexrad] FAILED to load nexrad_api: {_nx_err}")
    traceback.print_exc()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
