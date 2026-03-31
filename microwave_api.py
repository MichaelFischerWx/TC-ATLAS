"""
microwave_api.py — TC-PRIMED Microwave Satellite Overlay Endpoints
===================================================================
FastAPI APIRouter that provides passive microwave satellite imagery
from the TC-PRIMED dataset (NOAA/CSU) hosted on public AWS S3.

Products:
    - 89 GHz PCT (Polarization-Corrected Temperature):
        PCT = 1.818 * TB_V − 0.818 * TB_H
      Available from: GMI, SSMIS, AMSR2, SSM/I, TMI
    - 37 GHz H-pol brightness temperature:
      Available from: GMI, SSMIS, AMSR2, SSM/I, TMI
    - 37 GHz Color Composite (NRL 37color per Lee et al. 2002 / Kieper & Jiang 2012):
        RGB false-color: R=f(PCT37, inverted), G=f(V37), B=f(H37)
        PCT37 = 2.18 * V37 − 1.18 * H37  (Grody 1993)
      Available from: GMI, SSMIS, AMSR2, SSM/I, TMI

Data source:
    s3://noaa-nesdis-tcprimed-pds/v01r01/final/{season}/{basin}/{ATCF_ID}/
    Files: TCPRIMED_v01r01-final_{ATCF_ID}_{SENSOR}_{PLATFORM}_{ORBIT}_{YYYYMMDDHHMMSS}.nc

Integration:
    from microwave_api import router as microwave_router
    app.include_router(microwave_router, prefix="/microwave")

Dependencies (all in deployment):
    fastapi, boto3, xarray, numpy, h5netcdf, matplotlib
"""

import base64
import io
import json
import logging
import os
import re
import threading
import time
from collections import defaultdict
from datetime import datetime as _dt, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

logger = logging.getLogger("microwave_api")

router = APIRouter()

# ---------------------------------------------------------------------------
# TC-PRIMED S3 configuration
# ---------------------------------------------------------------------------
TCPRIMED_BUCKET = "noaa-nesdis-tcprimed-pds"
TCPRIMED_PREFIX = "v01r01/final"

# Time window (hours) for matching overpasses to TDR analyses
OVERPASS_WINDOW_HOURS = 6

# Sensors that carry channels we need for 89 GHz PCT and 37 GHz
# Each entry: sensor_name -> dict of channel group info
SENSOR_INFO = {
    "GMI":   {"full_name": "GPM Microwave Imager",          "has_89": True, "has_37": True},
    "SSMIS": {"full_name": "Special Sensor MW Imager/Sounder", "has_89": True, "has_37": True},
    "AMSR2": {"full_name": "Advanced MW Scanning Radiometer 2", "has_89": True, "has_37": True},
    "SSMI":  {"full_name": "Special Sensor MW/Imager",       "has_89": True, "has_37": True},
    "TMI":   {"full_name": "TRMM Microwave Imager",          "has_89": True, "has_37": True},
    "ATMS":  {"full_name": "Advanced Technology MW Sounder",  "has_89": True, "has_37": False},
    "MHS":   {"full_name": "Microwave Humidity Sounder",      "has_89": True, "has_37": False},
}

# TC-PRIMED file naming pattern
# TCPRIMED_v01r01-final_{ATCF_ID}_{SENSOR}_{PLATFORM}_{ORBIT}_{YYYYMMDDHHMMSS}.nc
_FILE_PATTERN = re.compile(
    r"TCPRIMED_v01r01-final_"
    r"(?P<atcf_id>[A-Z]{2}\d+)_"
    r"(?P<sensor>[A-Z0-9]+)_"
    r"(?P<platform>[A-Za-z0-9_-]+)_"
    r"(?P<orbit>\d+)_"
    r"(?P<timestamp>\d{14})\.nc$"
)

# Basin code mapping: IBTrACS basin -> TC-PRIMED S3 directory name
# TC-PRIMED uses 2-letter ATCF basin codes as directory names
BASIN_MAP = {
    "NA": "AL",   # North Atlantic
    "EP": "EP",   # Eastern North Pacific
    "WP": "WP",   # Western North Pacific
    "NI": "IO",   # North Indian Ocean
    "SI": "SH",   # South Indian Ocean  -> Southern Hemisphere
    "SP": "SH",   # South Pacific       -> Southern Hemisphere
    "SA": "AL",   # South Atlantic (rare)
}

# ---------------------------------------------------------------------------
# Global index: built at startup, maps TC-RADAR cases to TC-PRIMED overpasses
# ---------------------------------------------------------------------------
_index_lock = threading.Lock()
_case_overpass_index: Dict[int, List[dict]] = {}   # case_index -> [overpass_info, ...]
_storm_overpass_index: Dict[str, List[dict]] = {}  # atcf_id -> [overpass_info, ...]
_atcf_map: Dict[Tuple[str, int], str] = {}         # (storm_name, year) -> atcf_id
_index_ready = threading.Event()
_index_error: Optional[str] = None


def _get_boto3_client():
    """Create an anonymous S3 client for the public TC-PRIMED bucket."""
    import boto3
    from botocore import UNSIGNED
    from botocore.config import Config
    return boto3.client("s3", config=Config(signature_version=UNSIGNED),
                        region_name="us-east-1")


def _parse_tcprimed_filename(filename: str) -> Optional[dict]:
    """Extract metadata from a TC-PRIMED filename."""
    basename = filename.rsplit("/", 1)[-1] if "/" in filename else filename
    m = _FILE_PATTERN.match(basename)
    if not m:
        return None
    ts_str = m.group("timestamp")
    try:
        dt = _dt.strptime(ts_str, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return {
        "atcf_id":   m.group("atcf_id"),
        "sensor":    m.group("sensor"),
        "platform":  m.group("platform"),
        "orbit":     m.group("orbit"),
        "datetime":  dt,
        "filename":  basename,
    }


def _build_atcf_map(ibtracs_path: str) -> Dict[Tuple[str, int], str]:
    """
    Build a mapping from (storm_name_upper, year) -> atcf_id
    using the IBTrACS storms JSON that's already part of this project.
    """
    mapping: Dict[Tuple[str, int], str] = {}
    try:
        with open(ibtracs_path, "r") as f:
            data = json.load(f)
        for storm in data.get("storms", []):
            atcf = storm.get("atcf_id")
            name = storm.get("name", "").upper()
            year = storm.get("year")
            if atcf and name and year:
                key = (name, year)
                # If multiple storms share name+year, keep the one with
                # the basin matching the ATCF prefix (AL, EP, etc.)
                if key not in mapping:
                    mapping[key] = atcf
        logger.info("ATCF map built: %d storm-year pairs", len(mapping))
    except Exception as e:
        logger.error("Failed to load IBTrACS for ATCF mapping: %s", e)
    return mapping


def _parse_case_datetime(case: dict) -> Optional[_dt]:
    """Parse a TC-RADAR case datetime string into a timezone-aware datetime."""
    dt_str = case.get("datetime", "")
    # Format: "2003-09-03 17:20 UTC"
    try:
        return _dt.strptime(dt_str, "%Y-%m-%d %H:%M UTC").replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    # Fallback: reconstruct from fields
    try:
        return _dt(
            case["year"], case["month"], case["day"],
            case.get("hour", 0), case.get("minute", 0),
            tzinfo=timezone.utc,
        )
    except (KeyError, ValueError):
        return None


def _extract_annual_number(atcf_id: str) -> str:
    """
    Extract the 2-digit annual storm number from an ATCF ID.
    E.g. 'AL062018' -> '06', 'EP122020' -> '12', 'WP032019' -> '03'.
    """
    # ATCF format: BB##YYYY  (2-char basin + 2-digit number + 4-digit year)
    return atcf_id[2:4]


def _compute_tcprimed_season(atcf_id: str, year: int) -> int:
    """
    Compute the TC-PRIMED season directory year.

    For the Northern Hemisphere: season = calendar year.
    For the Southern Hemisphere: the season starts July 1, so the TC-PRIMED
    season is the calendar year + 1 (e.g., a storm in Dec 2019 is season 2020).

    Since IBTrACS 'year' already captures genesis year and TC-PRIMED follows
    the same convention as IBTrACS for SH storm years, we use the ATCF year
    directly — it already encodes the correct season.
    """
    # The 4-digit year in the ATCF ID IS the season year
    try:
        return int(atcf_id[4:8])
    except (ValueError, IndexError):
        return year


def _list_tcprimed_files_for_storm(s3_client, atcf_id: str, season: int) -> List[str]:
    """
    List all TC-PRIMED NetCDF files for a given ATCF ID.
    Returns list of S3 keys.

    TC-PRIMED S3 path structure:
        v01r01/final/{season}/{basin}/{annual_number}/
    where annual_number is the 2-digit storm number (e.g. '06'),
    NOT the full ATCF ID.
    """
    basin_code = atcf_id[:2]  # e.g. "AL", "EP", "WP"
    annual_num = _extract_annual_number(atcf_id)  # e.g. "06"
    tcprimed_season = _compute_tcprimed_season(atcf_id, season)

    prefix = f"{TCPRIMED_PREFIX}/{tcprimed_season}/{basin_code}/{annual_num}/"
    keys = []
    try:
        paginator = s3_client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=TCPRIMED_BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key.endswith(".nc"):
                    keys.append(key)
    except Exception as e:
        logger.warning("S3 list failed for %s/%s: %s", prefix, atcf_id, e)

    logger.debug("Listed %d files for %s at %s", len(keys), atcf_id, prefix)
    return keys


def _build_index_thread(metadata_path: str, ibtracs_path: str):
    """
    Background thread: builds the overpass index at startup.

    Steps:
    1. Load TC-RADAR metadata → extract unique (storm_name, year) pairs
    2. Load IBTrACS → map each pair to an ATCF ID
    3. For each unique ATCF ID, list TC-PRIMED files from S3
    4. For each TC-RADAR case, find overpasses within ±OVERPASS_WINDOW_HOURS
    """
    global _case_overpass_index, _storm_overpass_index, _atcf_map, _index_error

    try:
        logger.info("Microwave index build starting...")
        t0 = time.time()

        # If local JSON files don't exist, fetch from GitHub Pages
        if not os.path.isfile(metadata_path):
            logger.info("Local metadata not found at %s, fetching from GitHub Pages...", metadata_path)
            cache_dir = Path(metadata_path).parent
            metadata_path = _fetch_json_from_url(_METADATA_URL, str(cache_dir / "tc_radar_metadata.json"))

        if not os.path.isfile(ibtracs_path):
            logger.info("Local IBTrACS not found at %s, fetching from GitHub Pages...", ibtracs_path)
            cache_dir = Path(ibtracs_path).parent
            ibtracs_path = _fetch_json_from_url(_IBTRACS_URL, str(cache_dir / "ibtracs_storms.json"))

        # Step 1: Load TC-RADAR metadata
        with open(metadata_path, "r") as f:
            meta = json.load(f)
        cases = meta.get("cases", [])
        logger.info("Loaded %d TC-RADAR cases", len(cases))

        # Step 2: Build ATCF mapping
        atcf_map = _build_atcf_map(ibtracs_path)

        # Step 3: Group cases by (storm_name, year) -> list of cases
        storm_cases: Dict[Tuple[str, int], List[dict]] = defaultdict(list)
        for case in cases:
            key = (case["storm_name"].upper(), case["year"])
            storm_cases[key] = storm_cases.get(key, [])
            storm_cases[key].append(case)

        # Step 4: For each unique ATCF ID, fetch overpass list from S3
        s3 = _get_boto3_client()
        unique_atcf: Dict[str, Tuple[str, int]] = {}  # atcf_id -> (name, year)
        for (name, year), case_list in storm_cases.items():
            atcf = atcf_map.get((name, year))
            if atcf and atcf not in unique_atcf:
                unique_atcf[atcf] = (name, year)

        logger.info("Querying TC-PRIMED for %d unique storms...", len(unique_atcf))

        storm_overpasses: Dict[str, List[dict]] = {}
        n_files_total = 0

        for atcf_id, (name, year) in unique_atcf.items():
            s3_keys = _list_tcprimed_files_for_storm(s3, atcf_id, year)
            overpasses = []
            for key in s3_keys:
                info = _parse_tcprimed_filename(key)
                if info is None:
                    continue
                # Verify this file belongs to our storm (directory may contain
                # files from other storms if annual numbers overlap across basins)
                if info["atcf_id"] != atcf_id:
                    continue
                # Only keep sensors that have useful channels
                sensor = info["sensor"]
                if sensor not in SENSOR_INFO:
                    continue
                info["s3_key"] = key
                info["has_89"] = SENSOR_INFO[sensor]["has_89"]
                info["has_37"] = SENSOR_INFO[sensor]["has_37"]
                info["sensor_full"] = SENSOR_INFO[sensor]["full_name"]
                overpasses.append(info)
            storm_overpasses[atcf_id] = overpasses
            n_files_total += len(overpasses)

        logger.info("Found %d total overpass files across %d storms",
                     n_files_total, len(storm_overpasses))

        # Step 5: For each TC-RADAR case, find temporally matched overpasses
        case_index: Dict[int, List[dict]] = {}
        window = timedelta(hours=OVERPASS_WINDOW_HOURS)

        for (name, year), case_list in storm_cases.items():
            atcf = atcf_map.get((name, year))
            if not atcf or atcf not in storm_overpasses:
                continue
            all_overpasses = storm_overpasses[atcf]
            for case in case_list:
                case_dt = _parse_case_datetime(case)
                if case_dt is None:
                    continue
                matched = []
                for op in all_overpasses:
                    offset = (op["datetime"] - case_dt).total_seconds()
                    if abs(offset) <= window.total_seconds():
                        matched.append({
                            "s3_key":    op["s3_key"],
                            "sensor":    op["sensor"],
                            "platform":  op["platform"],
                            "orbit":     op["orbit"],
                            "datetime":  op["datetime"].strftime("%Y-%m-%d %H:%M UTC"),
                            "offset_minutes": round(offset / 60.0, 1),
                            "has_89":    op["has_89"],
                            "has_37":    op["has_37"],
                            "sensor_full": op["sensor_full"],
                            "filename":  op["filename"],
                        })
                # Sort by absolute offset (closest first)
                matched.sort(key=lambda x: abs(x["offset_minutes"]))
                if matched:
                    case_index[case["case_index"]] = matched

        # Build storm-level index (serialisable)
        storm_idx: Dict[str, List[dict]] = {}
        for atcf_id, ops in storm_overpasses.items():
            storm_idx[atcf_id] = [
                {
                    "s3_key":    op["s3_key"],
                    "sensor":    op["sensor"],
                    "platform":  op["platform"],
                    "orbit":     op["orbit"],
                    "datetime":  op["datetime"].strftime("%Y-%m-%d %H:%M UTC"),
                    "has_89":    op["has_89"],
                    "has_37":    op["has_37"],
                    "sensor_full": op["sensor_full"],
                    "filename":  op["filename"],
                }
                for op in ops
            ]
            storm_idx[atcf_id].sort(key=lambda x: x["datetime"])

        # Commit to globals
        with _index_lock:
            _case_overpass_index.update(case_index)
            _storm_overpass_index.update(storm_idx)
            _atcf_map.update(atcf_map)

        elapsed = time.time() - t0
        logger.info(
            "Microwave index ready: %d cases with overpasses, "
            "%d storms indexed, %.1fs",
            len(case_index), len(storm_idx), elapsed,
        )

    except Exception as e:
        logger.exception("Microwave index build failed: %s", e)
        _index_error = str(e)
    finally:
        _index_ready.set()


def _fetch_json_from_url(url: str, local_cache_path: str) -> str:
    """
    Download a JSON file from a URL and cache it locally.
    Returns the path to the local file.
    """
    import requests as _req
    logger.info("Fetching %s ...", url)
    resp = _req.get(url, timeout=120)
    resp.raise_for_status()
    with open(local_cache_path, "w") as f:
        f.write(resp.text)
    logger.info("Cached %s -> %s (%.1f MB)",
                url, local_cache_path, len(resp.text) / 1e6)
    return local_cache_path


# GitHub Pages URLs for the JSON data files (fallback if not in local repo)
_GITHUB_PAGES_BASE = "https://michaelfischerwx.github.io/TC-RADAR"
_METADATA_URL = f"{_GITHUB_PAGES_BASE}/tc_radar_metadata.json"
_IBTRACS_URL = f"{_GITHUB_PAGES_BASE}/ibtracs_storms.json"


def start_index_build(metadata_path: str = None, ibtracs_path: str = None):
    """
    Kick off the background index build. Called from the main app at startup.
    Paths default to the files alongside this module. If those don't exist
    (e.g. API repo doesn't include them), fetches from GitHub Pages.
    """
    base = Path(__file__).parent
    if metadata_path is None:
        metadata_path = str(base / "tc_radar_metadata.json")
    if ibtracs_path is None:
        ibtracs_path = str(base / "ibtracs_storms.json")

    # If local files don't exist, we'll fetch them from GitHub Pages
    # inside the thread (to avoid blocking app startup)

    thread = threading.Thread(
        target=_build_index_thread,
        args=(metadata_path, ibtracs_path),
        daemon=True,
        name="microwave-index-builder",
    )
    thread.start()
    logger.info("Microwave index build thread started")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status")
async def microwave_status():
    """Check whether the overpass index has finished building."""
    ready = _index_ready.is_set()
    with _index_lock:
        n_cases = len(_case_overpass_index)
        n_storms = len(_storm_overpass_index)
    return JSONResponse({
        "ready": ready,
        "error": _index_error,
        "cases_with_overpasses": n_cases,
        "storms_indexed": n_storms,
    })


@router.get("/overpasses")
async def get_overpasses(
    case_index: int = Query(..., description="TC-RADAR case index"),
):
    """
    Return all TC-PRIMED microwave overpasses within ±6 hours of a TC-RADAR case.
    Each overpass includes sensor, platform, timestamp, offset from TDR analysis,
    and available products (89 GHz PCT, 37 GHz).
    """
    if not _index_ready.is_set():
        raise HTTPException(503, "Index building, try again in a few seconds")

    with _index_lock:
        overpasses = _case_overpass_index.get(case_index, [])

    return JSONResponse({
        "case_index": case_index,
        "overpasses": overpasses,
        "count": len(overpasses),
        "window_hours": OVERPASS_WINDOW_HOURS,
    })


def _live_tcprimed_lookup(atcf_id: str, year: Optional[int] = None) -> List[dict]:
    """
    Real-time S3 lookup for storms NOT in the pre-built index.
    Called when the Global Archive requests overpasses for any IBTrACS storm
    that isn't in the TC-RADAR database (which is the majority of storms).
    Returns the same serialised overpass list format as the pre-built index.
    """
    try:
        season = int(atcf_id[4:8])
    except (ValueError, IndexError):
        season = year or 0
    if not season:
        return []

    try:
        s3 = _get_boto3_client()
        keys = _list_tcprimed_files_for_storm(s3, atcf_id, season)
    except Exception as e:
        logger.warning("Live TC-PRIMED lookup failed for %s: %s", atcf_id, e)
        return []

    overpasses = []
    for key in keys:
        info = _parse_tcprimed_filename(key)
        if info is None:
            continue
        if info["atcf_id"] != atcf_id:
            continue
        sensor = info["sensor"]
        if sensor not in SENSOR_INFO:
            continue
        overpasses.append({
            "s3_key":      key,
            "sensor":      sensor,
            "platform":    info["platform"],
            "orbit":       info["orbit"],
            "datetime":    info["datetime"].strftime("%Y-%m-%d %H:%M UTC"),
            "has_89":      SENSOR_INFO[sensor]["has_89"],
            "has_37":      SENSOR_INFO[sensor]["has_37"],
            "sensor_full": SENSOR_INFO[sensor]["full_name"],
            "filename":    info["filename"],
        })

    overpasses.sort(key=lambda x: x["datetime"])
    logger.info("Live TC-PRIMED lookup for %s: %d overpasses", atcf_id, len(overpasses))
    return overpasses


@router.get("/storm_overpasses")
async def get_storm_overpasses(
    atcf_id: str = Query(None, description="ATCF storm ID, e.g. AL062018"),
    storm_name: str = Query(None, description="Storm name (alternative to atcf_id)"),
    year: int = Query(None, description="Storm year (required if using storm_name)"),
):
    """
    Return ALL TC-PRIMED overpasses for a full storm lifecycle.
    Supports both global archive (query by ATCF ID) and archive mode
    (query by storm_name + year, which gets mapped to ATCF ID internally).
    """
    # Resolve ATCF ID
    resolved_atcf = atcf_id
    if not resolved_atcf and storm_name and year:
        with _index_lock:
            resolved_atcf = _atcf_map.get((storm_name.upper(), year))
        if not resolved_atcf:
            return JSONResponse({
                "atcf_id": None,
                "storm_name": storm_name,
                "year": year,
                "overpasses": [],
                "count": 0,
                "message": "No ATCF ID found for this storm",
            })

    if not resolved_atcf:
        raise HTTPException(400, "Provide either atcf_id or storm_name+year")

    resolved_atcf = resolved_atcf.upper()
    with _index_lock:
        overpasses = _storm_overpass_index.get(resolved_atcf, [])

    # Live S3 fallback: if the pre-built index has nothing (storm not in
    # TC-RADAR database), query TC-PRIMED directly.  Cache the result so
    # subsequent calls for the same storm are instant.
    if not overpasses:
        overpasses = _live_tcprimed_lookup(resolved_atcf, year)
        if overpasses:
            with _index_lock:
                _storm_overpass_index[resolved_atcf] = overpasses

    return JSONResponse({
        "atcf_id": resolved_atcf,
        "overpasses": overpasses,
        "count": len(overpasses),
    })


@router.get("/data")
async def get_microwave_data(
    s3_key: str = Query(..., description="Full S3 key of the TC-PRIMED NetCDF file"),
    product: str = Query("89pct", description="Product: '89pct' or '37h'"),
    center_lat: float = Query(None, description="Storm center latitude (for regridding)"),
    center_lon: float = Query(None, description="Storm center longitude (for regridding)"),
    radius_km: float = Query(500.0, description="Radius in km for the output domain"),
):
    """
    Fetch a TC-PRIMED NetCDF file from S3, compute the requested product,
    and return storm-centered gridded data suitable for Leaflet/Plotly overlay.

    Products:
        89pct — 89 GHz Polarization-Corrected Temperature
                PCT = 1.818 * TB_V − 0.818 * TB_H
        37h   — 37 GHz H-pol brightness temperature

    Returns:
        JSON with lat/lon grids, data values, metadata for frontend rendering.
    """
    import xarray as xr
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.colors as mcolors

    _VALID_PRODUCTS = ("89pct", "89v", "89h", "37h", "37v", "37color")
    if product not in _VALID_PRODUCTS:
        raise HTTPException(400, f"product must be one of {_VALID_PRODUCTS}")

    # Validate S3 key
    if not s3_key.startswith(TCPRIMED_PREFIX) or not s3_key.endswith(".nc"):
        raise HTTPException(400, "Invalid S3 key")

    # Parse filename to know the sensor
    info = _parse_tcprimed_filename(s3_key)
    if info is None:
        raise HTTPException(400, "Cannot parse TC-PRIMED filename from key")

    sensor = info["sensor"]
    if sensor not in SENSOR_INFO:
        raise HTTPException(400, f"Unsupported sensor: {sensor}")

    if product in ("37h", "37color") and not SENSOR_INFO[sensor]["has_37"]:
        raise HTTPException(400, f"Sensor {sensor} does not have 37 GHz channels")

    try:
        # Open the NetCDF from S3 using h5netcdf to discover group structure
        import fsspec
        import h5netcdf
        s3_url = f"s3://{TCPRIMED_BUCKET}/{s3_key}"
        fs = fsspec.filesystem("s3", anon=True)

        # First, discover the HDF5 group structure
        with fs.open(s3_url, "rb") as f:
            h5file = h5netcdf.File(f, "r")
            all_groups = list(h5file.groups.keys())
            root_vars = list(h5file.variables.keys())
            # Also check subgroups
            subgroups = {}
            for g in all_groups:
                grp = h5file.groups[g]
                subgroups[g] = {
                    "subgroups": list(grp.groups.keys()) if hasattr(grp, "groups") else [],
                    "variables": list(grp.variables.keys()),
                }
            h5file.close()

        # Log full structure with print() so it always shows in Render logs
        print(f"[MW] TC-PRIMED file: {s3_key}")
        print(f"[MW]   Top-level groups: {all_groups}")
        print(f"[MW]   Root vars: {root_vars[:10]}")

        # Enumerate sub-subgroups (build into a separate dict to avoid
        # mutating subgroups during iteration)
        deep_groups = {}
        for g, ginfo in list(subgroups.items()):
            print(f"[MW]   Group '{g}': subgroups={ginfo['subgroups']}, vars={ginfo['variables'][:15]}")
            if ginfo["subgroups"]:
                try:
                    with fs.open(s3_url, "rb") as f2:
                        h5f2 = h5netcdf.File(f2, "r")
                        for sg in ginfo["subgroups"]:
                            sg_grp = h5f2.groups[g].groups[sg]
                            sg_vars = list(sg_grp.variables.keys())
                            sg_subs = list(sg_grp.groups.keys()) if hasattr(sg_grp, "groups") else []
                            deep_groups[f"{g}/{sg}"] = {
                                "subgroups": sg_subs,
                                "variables": sg_vars,
                            }
                            print(f"[MW]     Sub '{g}/{sg}': vars={sg_vars[:15]}")
                        h5f2.close()
                except Exception as e_sub:
                    print(f"[MW]   (error reading subgroups of '{g}': {e_sub})")
        subgroups.update(deep_groups)

        data_dict = None

        # ── TC-PRIMED swath structure ──
        # Files use /passive_microwave/S1..S4 where each S* is a different
        # frequency swath with its own lat/lon grid:
        #   S1: low-freq (19 GHz)
        #   S2: mid-freq (37 GHz)   ← used for 37h product
        #   S3: high-freq (150/183 GHz)
        #   S4: imaging-freq (85-92 GHz) ← used for 89pct product
        # Each S* group has: latitude, longitude, x, y, TB_* variables.
        #
        # Strategy: find the right S* swath for the requested product
        # by checking which subgroup has matching frequency variables.

        # Frequency patterns to match for each product
        if product in ("89pct", "89v", "89h"):
            _FREQ_PATTERNS = ["89", "91", "85", "88", "92"]
        else:  # 37h, 37v, or 37color
            _FREQ_PATTERNS = ["37", "36"]

        # Build candidate groups — prioritize passive_microwave sub-swaths
        bt_group_candidates = []

        # First: try passive_microwave sub-swaths (the actual TC-PRIMED structure)
        for compound_key, sg_info in subgroups.items():
            if "passive_microwave/" in compound_key:
                # Check if this swath has the right frequency
                for vname in sg_info.get("variables", []):
                    vname_upper = vname.upper()
                    if any(fp in vname_upper for fp in _FREQ_PATTERNS) and "TB" in vname_upper:
                        bt_group_candidates.insert(0, f"/{compound_key}")
                        break

        # Then: try other explicit paths as fallback
        bt_group_candidates.extend([
            f"/{sensor}/interpolation",
            f"/{sensor}/brightness_temperature",
            f"/{sensor}",
            "/passive_microwave/interpolation",
            "/passive_microwave/brightness_temperature",
            "/passive_microwave",
            "/interpolation",
            "/brightness_temperature",
        ])

        # Also add any remaining discovered groups (skip metadata)
        _SKIP_GROUPS = {"overpass_metadata", "overpass_storm_metadata",
                        "metadata", "overpass_storm", "GPROF", "infrared"}
        for compound_key, sg_info in subgroups.items():
            path = f"/{compound_key}"
            if path not in bt_group_candidates:
                leaf = compound_key.split("/")[-1].lower()
                if leaf not in {s.lower() for s in _SKIP_GROUPS}:
                    bt_group_candidates.append(path)
        for g in all_groups:
            path = f"/{g}"
            if path not in bt_group_candidates and g.lower() not in {s.lower() for s in _SKIP_GROUPS}:
                bt_group_candidates.append(path)

        print(f"[MW]   Product={product}, freq_patterns={_FREQ_PATTERNS}")
        print(f"[MW]   BT candidates: {bt_group_candidates}")

        # ── Find the right group using pre-enumerated variable names ──
        # (No need to open the file for each candidate — use subgroups dict)
        ds_data = None
        ds_geo = None
        used_group = None

        for group_path in bt_group_candidates:
            # Strip leading slash to get the subgroups dict key
            sg_key = group_path.lstrip("/")
            sg_vars = subgroups.get(sg_key, {}).get("variables", [])
            if not sg_vars:
                # Not in our pre-enumerated dict — skip (fallback candidates)
                continue
            has_right_freq = False
            for vname in sg_vars:
                vname_upper = vname.upper()
                if "TB" in vname_upper or "BRIGHTNESS" in vname_upper:
                    if any(fp in vname_upper for fp in _FREQ_PATTERNS):
                        has_right_freq = True
                        break
            if has_right_freq:
                used_group = group_path
                print(f"[MW]   ✓ Selected group '{group_path}' (has matching BT vars: {sg_vars[:8]})")
                break
            else:
                print(f"[MW]   ✗ '{group_path}' no matching freq in: {sg_vars[:8]}")

        if used_group is None:
            raise HTTPException(500,
                f"Could not find {product} data. "
                f"File groups: {all_groups}, subgroups: {list(subgroups.keys())}")

        # Now open the file ONCE and eagerly load all data into memory
        # (avoids lazy-loading + closed file handle issue)
        print(f"[MW]   Opening '{used_group}' and loading data into memory...")
        with fs.open(s3_url, "rb") as f:
            ds_data = xr.open_dataset(f, engine="h5netcdf", group=used_group).load()
        print(f"[MW]   Loaded: vars={list(ds_data.data_vars)[:10]}, coords={list(ds_data.coords)[:6]}")

        # Determine if data is swath (2D lat/lon) or regular grid (1D or x/y offsets)
        has_latlon = ("latitude" in ds_data.data_vars or "latitude" in ds_data.coords or
                      "lat" in ds_data.data_vars or "lat" in ds_data.coords)
        has_xy_coord = ("x_distance" in ds_data.coords or "x_distance" in ds_data.dims)

        # Check dimensionality of lat/lon to distinguish swath from grid
        is_swath = False
        if has_latlon:
            for lat_name in ["latitude", "lat"]:
                if lat_name in ds_data.coords:
                    lat_shape = ds_data[lat_name].shape
                    is_swath = len(lat_shape) >= 2  # 2D = swath data
                    print(f"[MW]   '{lat_name}' shape={lat_shape}, is_swath={is_swath}")
                    break
                elif lat_name in ds_data.data_vars:
                    lat_shape = ds_data[lat_name].shape
                    is_swath = len(lat_shape) >= 2
                    print(f"[MW]   '{lat_name}' (data_var) shape={lat_shape}, is_swath={is_swath}")
                    break

        print(f"[MW]   Data group '{used_group}': has_latlon={has_latlon}, "
              f"has_xy_coord={has_xy_coord}, is_swath={is_swath}, "
              f"vars={list(ds_data.data_vars)[:12]}, coords={list(ds_data.coords)[:10]}")

        # Inject center_lat/center_lon from query params into ds attrs
        if "storm_latitude" not in ds_data.attrs and center_lat is not None:
            ds_data.attrs["storm_latitude"] = center_lat
        if "storm_longitude" not in ds_data.attrs and center_lon is not None:
            ds_data.attrs["storm_longitude"] = center_lon

        # Compute the product
        _SWATH_DISPATCH = {
            "89pct": _compute_89pct_swath,
            "89v": _compute_89v_swath,
            "89h": _compute_89h_swath,
            "37h": _compute_37h_swath,
            "37v": _compute_37v_swath,
            "37color": _compute_37color_swath,
        }
        _GRID_DISPATCH = {
            "89pct": _compute_89pct_interpolated,
            "89v": _compute_89v_interpolated,
            "89h": _compute_89h_interpolated,
            "37h": _compute_37h_interpolated,
            "37v": _compute_37v_interpolated,
            "37color": _compute_37color_interpolated,
        }
        try:
            if is_swath:
                # TC-PRIMED S* swath: lat/lon are 2D, in the same dataset as BT
                # Use ds_data as both BT and geo source
                print(f"[MW]   Using SWATH compute path (2D lat/lon in same group)")
                if product in _SWATH_DISPATCH:
                    data_dict = _SWATH_DISPATCH[product](ds_data, ds_data, sensor)
                else:
                    raise ValueError(f"Unknown product: {product}")
            elif has_xy_coord:
                # Storm-centered regular grid with x_distance/y_distance
                print(f"[MW]   Using GRID compute path (x_distance/y_distance)")
                if product in _GRID_DISPATCH:
                    data_dict = _GRID_DISPATCH[product](ds_data, sensor)
                else:
                    raise ValueError(f"Unknown product: {product}")
            elif has_latlon:
                # Has lat/lon but they're 1D — treat as regular grid
                print(f"[MW]   Using GRID compute path (1D lat/lon)")
                if product in _GRID_DISPATCH:
                    data_dict = _GRID_DISPATCH[product](ds_data, sensor)
                else:
                    raise ValueError(f"Unknown product: {product}")
            else:
                raise ValueError("No geolocation data found in dataset")
        except Exception as e_compute:
            import traceback
            traceback.print_exc()
            ds_data.close()
            raise HTTPException(500,
                f"Found data in group '{used_group}' with vars "
                f"{list(ds_data.data_vars)[:15]} but failed to compute {product}: {e_compute}")

        ds_data.close()

        if data_dict is None:
            raise HTTPException(500, "No data could be extracted")

        # Generate a PNG image for the Leaflet overlay
        png_b64 = _render_product_image(data_dict, product)

        # Build storm-relative grid for Plotly plan-view overlay
        # TC-PRIMED S* groups have x/y (km) as data vars — same swath shape as TB
        storm_grid = None
        storm_grid_rgb = None  # for 37color: three separate grids (R, G, B)
        try:
            if "x" in ds_data.data_vars and "y" in ds_data.data_vars:
                x_km_raw = ds_data["x"].values  # 2D (scan × pixel) — km from center
                y_km_raw = ds_data["y"].values

                if product == "37color":
                    # Build RGB storm-relative grids for Plotly plan view
                    # We need V37, H37, and PCT37 on the same grid
                    v37_name = _find_channel_var(ds_data, sensor, 37, "V")
                    h37_name = _find_channel_var(ds_data, sensor, 37, "H")
                    if v37_name and h37_name:
                        v37_raw = ds_data[v37_name].values.astype(np.float32)
                        h37_raw = ds_data[h37_name].values.astype(np.float32)
                        pct37_raw = 2.18 * v37_raw - 1.18 * h37_raw
                        # Build a single grid from PCT37 for the single-channel Plotly view
                        storm_grid = _build_storm_relative_grid(
                            x_km_raw, y_km_raw, pct37_raw, grid_extent_km=250, grid_res_km=4
                        )
                        # Also build an RGB image for the plan view
                        storm_grid_rgb = _build_storm_relative_rgb_grid(
                            x_km_raw, y_km_raw, pct37_raw, v37_raw, h37_raw,
                            grid_extent_km=250, grid_res_km=4
                        )
                        if storm_grid:
                            print(f"[MW]   Storm-relative 37color grid built: "
                                  f"{storm_grid['nx']}x{storm_grid['ny']}")
                else:
                    # Single-channel products: 89pct, 89v, 89h, 37h, 37v
                    _PROD_CHAN = {
                        "89pct": (89, "V"),  # V-pol used for PCT computation
                        "89v":   (89, "V"),
                        "89h":   (89, "H"),
                        "37h":   (37, "H"),
                        "37v":   (37, "V"),
                    }
                    freq, pol = _PROD_CHAN.get(product, (89, "V"))
                    v_name = _find_channel_var(ds_data, sensor, freq, pol)
                    # For PCT products, also need opposite pol
                    h_name = _find_channel_var(ds_data, sensor, 89, "H") if product == "89pct" else None
                    if v_name:
                        if product == "89pct" and h_name and v_name != h_name:
                            grid_data = (1.818 * ds_data[v_name].values.astype(np.float32) -
                                         0.818 * ds_data[h_name].values.astype(np.float32))
                        elif product == "89pct":
                            grid_data = ds_data[v_name].values.astype(np.float32)
                        else:
                            grid_data = ds_data[v_name].values.astype(np.float32)

                        storm_grid = _build_storm_relative_grid(
                            x_km_raw, y_km_raw, grid_data, grid_extent_km=250, grid_res_km=4
                        )
                        if storm_grid:
                            print(f"[MW]   Storm-relative grid built: {storm_grid['nx']}x{storm_grid['ny']}")
        except Exception as e_grid:
            print(f"[MW]   Storm-relative grid failed: {e_grid}")
            import traceback; traceback.print_exc()
            storm_grid = None

        response = {
            "product": product,
            "sensor": sensor,
            "platform": info["platform"],
            "datetime": info["datetime"].strftime("%Y-%m-%d %H:%M UTC"),
            "image_b64": png_b64,
            "bounds": data_dict.get("bounds"),  # [[south, west], [north, east]]
            "center_lat": data_dict.get("center_lat"),
            "center_lon": data_dict.get("center_lon"),
            "grid": {
                "nx": data_dict.get("nx"),
                "ny": data_dict.get("ny"),
                "dx_km": data_dict.get("dx_km"),
            },
            "stats": data_dict.get("stats", {}),
            "is_rgb": product == "37color",
        }

        # Colorscale / range per product
        _PRODUCT_SCALES = {
            "89pct": (NRL_89GHZ_PLOTLY_COLORSCALE, NRL_VMIN, NRL_VMAX),
            "89v":   (NRL_89GHZ_PLOTLY_COLORSCALE, 150, 300),
            "89h":   (NRL_89GHZ_PLOTLY_COLORSCALE, 100, 290),
            "37h":   (NRL_37GHZ_PLOTLY_COLORSCALE, NRL_37_VMIN, NRL_37_VMAX),
            "37v":   (NRL_37GHZ_PLOTLY_COLORSCALE, NRL_37_VMIN, NRL_37_VMAX),
        }
        if product == "37color":
            # 37color is RGB — no single-channel colorscale
            response["colorscale"] = None
            response["vmin"] = 0
            response["vmax"] = 255
        elif product in _PRODUCT_SCALES:
            cs, vmin, vmax = _PRODUCT_SCALES[product]
            response["colorscale"] = cs
            response["vmin"] = vmin
            response["vmax"] = vmax
        else:
            response["colorscale"] = NRL_89GHZ_PLOTLY_COLORSCALE
            response["vmin"] = 130
            response["vmax"] = 300

        # Include storm-relative grid for Plotly plan view
        if storm_grid:
            response["storm_grid"] = storm_grid
        # Include RGB image for 37color plan view
        if storm_grid_rgb:
            response["storm_grid_rgb_b64"] = storm_grid_rgb

        return JSONResponse(response)

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error fetching microwave data: %s", e)
        raise HTTPException(500, f"Error processing microwave data: {e}")


# ---------------------------------------------------------------------------
# Product computation helpers
# ---------------------------------------------------------------------------

# TC-PRIMED channel naming conventions (approximate — varies by sensor)
# 89 GHz channels:  '89V', '89H' or '89.0V', '89.0H' or 'S1' (ATMS ch16~89GHz)
# 37 GHz channels:  '37V', '37H' or '36.5V', '36.5H' or '36V', '36H'

_89GHZ_PATTERNS = {
    "GMI":   {"v": "89V", "h": "89H"},
    "SSMIS": {"v": "91V", "h": "91H"},      # SSMIS has 91 GHz (close proxy for 89)
    "AMSR2": {"v": "89V_A", "h": "89H_A"},  # AMSR2 has A/B scan; use A
    "SSMI":  {"v": "85V", "h": "85H"},       # SSM/I has 85 GHz
    "TMI":   {"v": "85V", "h": "85H"},       # TMI has 85 GHz
    "ATMS":  {"v": "88V", "h": None},        # ATMS ch16 ~88 GHz, V-pol only
    "MHS":   {"v": "89V", "h": None},        # MHS ch1 ~89 GHz, V-pol only
}

_37GHZ_PATTERNS = {
    "GMI":   {"v": "37V", "h": "37H"},
    "SSMIS": {"v": "37V", "h": "37H"},
    "AMSR2": {"v": "37V", "h": "37H"},
    "SSMI":  {"v": "37V", "h": "37H"},
    "TMI":   {"v": "37V", "h": "37H"},
}


def _find_channel_var(ds, sensor: str, freq_ghz: int, pol: str) -> Optional[str]:
    """
    Search the dataset variables for one that matches the desired
    frequency and polarization.

    TC-PRIMED naming convention:  TB_{freq}{pol}
        e.g. TB_91.665V, TB_37.0H, TB_89.0V, TB_19.35H
    The frequency in the var name may not exactly match freq_ghz
    (e.g. 91.665 for "89 GHz" on SSMIS, 85.5 for "89 GHz" on SSM/I).
    So we check a range of nearby frequencies.
    """
    pol_upper = pol.upper()  # "V" or "H"

    # Build a set of frequency prefixes to match
    # e.g. for 89 GHz: look for 85, 86, 87, 88, 89, 90, 91, 92
    if freq_ghz >= 85:
        freq_candidates = [str(f) for f in range(85, 93)]
    elif freq_ghz >= 35:
        freq_candidates = [str(f) for f in range(36, 39)]  # 36, 37, 38
    else:
        freq_candidates = [str(freq_ghz)]

    print(f"[MW]   _find_channel_var: sensor={sensor}, freq={freq_ghz}, pol={pol_upper}, "
          f"freq_candidates={freq_candidates}, vars={list(ds.data_vars)[:15]}")

    # Strategy 1: TC-PRIMED style — TB_{freq}{pol} where var name ends with pol letter
    for var_name in ds.data_vars:
        vn = var_name.upper()
        if not vn.endswith(pol_upper):
            continue
        # Check if any freq candidate appears in the name
        for fc in freq_candidates:
            if fc in vn:
                print(f"[MW]     → matched '{var_name}' (TC-PRIMED style)")
                return var_name

    # Strategy 2: legacy patterns from _89GHZ_PATTERNS / _37GHZ_PATTERNS
    patterns_dict = _89GHZ_PATTERNS if freq_ghz >= 85 else _37GHZ_PATTERNS
    sensor_info = patterns_dict.get(sensor, {})
    expected = sensor_info.get(pol.lower())
    if expected:
        for var_name in ds.data_vars:
            vn_clean = var_name.upper().replace(".", "").replace("_", "").replace(" ", "")
            ex_clean = expected.upper().replace(".", "").replace("_", "").replace(" ", "")
            if ex_clean in vn_clean:
                print(f"[MW]     → matched '{var_name}' (legacy pattern '{expected}')")
                return var_name

    # Strategy 3: any var with 'brightness_temperature' + channel dimension
    if "brightness_temperature" in ds.data_vars:
        print(f"[MW]     → matched 'brightness_temperature' (generic)")
        return "brightness_temperature"

    print(f"[MW]     → no match found for {freq_ghz} GHz {pol_upper}")
    return None


def _compute_89pct_interpolated(ds, sensor: str) -> dict:
    """
    Compute 89 GHz PCT from the interpolated (storm-centered) grid.
    Returns dict with data array, lats, lons, bounds.
    """
    v_name = _find_channel_var(ds, sensor, 89, "V")
    h_name = _find_channel_var(ds, sensor, 89, "H")

    if v_name and h_name and v_name != h_name:
        tb_v = ds[v_name].values.astype(np.float32)
        tb_h = ds[h_name].values.astype(np.float32)
        pct = 1.818 * tb_v - 0.818 * tb_h
    elif v_name:
        # H-pol not available (ATMS, MHS) — just use V-pol as proxy
        pct = ds[v_name].values.astype(np.float32)
    else:
        raise ValueError(f"Cannot find 89 GHz channels for sensor {sensor}")

    # Get coordinate arrays
    result = _extract_grid_info(ds, pct)
    result["product_label"] = "89 GHz PCT (K)"
    result["stats"] = {
        "min": float(np.nanmin(pct)),
        "max": float(np.nanmax(pct)),
        "mean": float(np.nanmean(pct)),
    }
    return result


def _compute_37h_interpolated(ds, sensor: str) -> dict:
    """
    Compute 37 GHz H-pol from the interpolated grid.
    """
    h_name = _find_channel_var(ds, sensor, 37, "H")
    if not h_name:
        raise ValueError(f"Cannot find 37 GHz H-pol for sensor {sensor}")

    tb_h = ds[h_name].values.astype(np.float32)

    result = _extract_grid_info(ds, tb_h)
    result["product_label"] = "37 GHz H-pol TB (K)"
    result["stats"] = {
        "min": float(np.nanmin(tb_h)),
        "max": float(np.nanmax(tb_h)),
        "mean": float(np.nanmean(tb_h)),
    }
    return result


def _compute_89pct_swath(ds_bt, ds_geo, sensor: str) -> dict:
    """
    Compute 89 GHz PCT from swath-level data and regrid to a regular grid.
    """
    v_name = _find_channel_var(ds_bt, sensor, 89, "V")
    h_name = _find_channel_var(ds_bt, sensor, 89, "H")

    if v_name and h_name and v_name != h_name:
        tb_v = ds_bt[v_name].values.astype(np.float32)
        tb_h = ds_bt[h_name].values.astype(np.float32)
        data = 1.818 * tb_v - 0.818 * tb_h
    elif v_name:
        data = ds_bt[v_name].values.astype(np.float32)
    else:
        raise ValueError(f"Cannot find 89 GHz channels for sensor {sensor}")

    lats, lons = _get_swath_geolocation(ds_geo)
    gridded = _regrid_swath(data, lats, lons)
    gridded["product_label"] = "89 GHz PCT (K)"
    gridded["stats"] = {
        "min": float(np.nanmin(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
        "max": float(np.nanmax(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
    }
    return gridded


def _compute_37h_swath(ds_bt, ds_geo, sensor: str) -> dict:
    """
    Compute 37 GHz H-pol from swath data and regrid.
    """
    h_name = _find_channel_var(ds_bt, sensor, 37, "H")
    if not h_name:
        raise ValueError(f"Cannot find 37 GHz H-pol for sensor {sensor}")

    data = ds_bt[h_name].values.astype(np.float32)
    lats, lons = _get_swath_geolocation(ds_geo)
    # 37 GHz has coarser footprint (~37 km for SSMIS) — use coarser grid
    gridded = _regrid_swath(data, lats, lons, grid_res_deg=0.05)
    gridded["product_label"] = "37 GHz H-pol TB (K)"
    gridded["stats"] = {
        "min": float(np.nanmin(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
        "max": float(np.nanmax(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
    }
    return gridded


def _compute_37v_interpolated(ds, sensor: str) -> dict:
    """Compute 37 GHz V-pol from the interpolated grid."""
    v_name = _find_channel_var(ds, sensor, 37, "V")
    if not v_name:
        raise ValueError(f"Cannot find 37 GHz V-pol for sensor {sensor}")
    tb_v = ds[v_name].values.astype(np.float32)
    result = _extract_grid_info(ds, tb_v)
    result["product_label"] = "37 GHz V-pol TB (K)"
    result["stats"] = {
        "min": float(np.nanmin(tb_v)),
        "max": float(np.nanmax(tb_v)),
        "mean": float(np.nanmean(tb_v)),
    }
    return result


def _compute_37v_swath(ds_bt, ds_geo, sensor: str) -> dict:
    """Compute 37 GHz V-pol from swath data and regrid."""
    v_name = _find_channel_var(ds_bt, sensor, 37, "V")
    if not v_name:
        raise ValueError(f"Cannot find 37 GHz V-pol for sensor {sensor}")
    data = ds_bt[v_name].values.astype(np.float32)
    lats, lons = _get_swath_geolocation(ds_geo)
    # 37 GHz has coarser footprint (~37 km for SSMIS) — use coarser grid
    gridded = _regrid_swath(data, lats, lons, grid_res_deg=0.05)
    gridded["product_label"] = "37 GHz V-pol TB (K)"
    gridded["stats"] = {
        "min": float(np.nanmin(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
        "max": float(np.nanmax(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
    }
    return gridded


def _compute_89v_interpolated(ds, sensor: str) -> dict:
    """Compute 89 GHz V-pol (no PCT) from the interpolated grid."""
    v_name = _find_channel_var(ds, sensor, 89, "V")
    if not v_name:
        raise ValueError(f"Cannot find 89 GHz V-pol for sensor {sensor}")
    tb_v = ds[v_name].values.astype(np.float32)
    result = _extract_grid_info(ds, tb_v)
    result["product_label"] = "89 GHz V-pol TB (K)"
    result["stats"] = {
        "min": float(np.nanmin(tb_v)),
        "max": float(np.nanmax(tb_v)),
        "mean": float(np.nanmean(tb_v)),
    }
    return result


def _compute_89v_swath(ds_bt, ds_geo, sensor: str) -> dict:
    """Compute 89 GHz V-pol from swath data and regrid."""
    v_name = _find_channel_var(ds_bt, sensor, 89, "V")
    if not v_name:
        raise ValueError(f"Cannot find 89 GHz V-pol for sensor {sensor}")
    data = ds_bt[v_name].values.astype(np.float32)
    lats, lons = _get_swath_geolocation(ds_geo)
    gridded = _regrid_swath(data, lats, lons)
    gridded["product_label"] = "89 GHz V-pol TB (K)"
    gridded["stats"] = {
        "min": float(np.nanmin(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
        "max": float(np.nanmax(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
    }
    return gridded


def _compute_89h_interpolated(ds, sensor: str) -> dict:
    """Compute 89 GHz H-pol from the interpolated grid."""
    h_name = _find_channel_var(ds, sensor, 89, "H")
    if not h_name:
        raise ValueError(f"Cannot find 89 GHz H-pol for sensor {sensor}")
    tb_h = ds[h_name].values.astype(np.float32)
    result = _extract_grid_info(ds, tb_h)
    result["product_label"] = "89 GHz H-pol TB (K)"
    result["stats"] = {
        "min": float(np.nanmin(tb_h)),
        "max": float(np.nanmax(tb_h)),
        "mean": float(np.nanmean(tb_h)),
    }
    return result


def _compute_89h_swath(ds_bt, ds_geo, sensor: str) -> dict:
    """Compute 89 GHz H-pol from swath data and regrid."""
    h_name = _find_channel_var(ds_bt, sensor, 89, "H")
    if not h_name:
        raise ValueError(f"Cannot find 89 GHz H-pol for sensor {sensor}")
    data = ds_bt[h_name].values.astype(np.float32)
    lats, lons = _get_swath_geolocation(ds_geo)
    gridded = _regrid_swath(data, lats, lons)
    gridded["product_label"] = "89 GHz H-pol TB (K)"
    gridded["stats"] = {
        "min": float(np.nanmin(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
        "max": float(np.nanmax(data[np.isfinite(data)])) if np.any(np.isfinite(data)) else None,
    }
    return gridded


def _nrl_37color_rgb(v37: np.ndarray, h37: np.ndarray) -> np.ndarray:
    """
    NRL 37 GHz false-color composite per Jiang et al. (2018, JGR) and
    Lee et al. (2002, Earth Interactions).

    From Jiang (2018) p. 5511: "PCT37, V37, and H37 values are displayed
    into RGB guns, respectively."

        PCT37 = 2.18 * V37 − 1.18 * H37   (Grody 1993)

        Red   = clamp((285 − PCT37) / 100,  0, 1)
        Green = clamp((V37 − 155) / 125,    0, 1) ** 1.6
        Blue  = clamp((H37 − 145) / 135,    0, 1) ** 1.1

    Differential gamma (G^1.6 > B^1.1) compresses green faster than blue
    for low-TB scenes, so B > G in deep convection → pink/magenta tones.
    At high TBs (rain) both approach 1.0 → cyan is preserved.

    Resulting colour scheme (Jiang 2018 Table 1, Fig. 1):
        - Dark green:  clear ocean  (PCT37 ~270-300, V37 low, H37 very low)
        - Cyan / teal: warm rain, shallow convection (high V37 & H37)
        - Pink/magenta: deep convection with ice (low PCT37)
        - Red:         intense ice scattering (very low PCT37)

    Parameters
    ----------
    v37, h37 : float arrays (same shape), brightness temperatures in K.

    Returns
    -------
    rgb : uint8 array, shape (*v37.shape, 3)
    """
    pct37 = 2.18 * v37 - 1.18 * h37

    # R ← inverted PCT37: high red for ice scattering (low PCT37)
    r = np.clip((285.0 - pct37) / 100.0, 0.0, 1.0)
    # G ← V37 with gamma 1.6: compresses mid-range → less green in convection
    g = np.clip((v37 - 155.0) / 125.0, 0.0, 1.0) ** 1.6
    # B ← H37 with gamma 1.1: lighter compression → B > G in convection → pink
    b = np.clip((h37 - 145.0) / 135.0, 0.0, 1.0) ** 1.1

    # Mask invalid pixels
    invalid = ~(np.isfinite(v37) & np.isfinite(h37) & (v37 > 0) & (h37 > 0))
    r[invalid] = 0.0
    g[invalid] = 0.0
    b[invalid] = 0.0

    rgb = np.stack([
        (r * 255).astype(np.uint8),
        (g * 255).astype(np.uint8),
        (b * 255).astype(np.uint8),
    ], axis=-1)
    return rgb


def _compute_37color_swath(ds_bt, ds_geo, sensor: str) -> dict:
    """
    Compute 37 GHz false-color composite from swath data and regrid.

    NRL 37 GHz color product per Lee et al. (2002) / Kieper & Jiang (2012):
    three-channel RGB from PCT37, H37, V37.
    Returns dict with 'data' as 3D RGB array (ny, nx, 3), uint8 0-255.
    """
    v_name = _find_channel_var(ds_bt, sensor, 37, "V")
    h_name = _find_channel_var(ds_bt, sensor, 37, "H")
    if not v_name or not h_name:
        raise ValueError(f"Cannot find 37 GHz V and H channels for sensor {sensor}")

    tb_v = ds_bt[v_name].values.astype(np.float32)
    tb_h = ds_bt[h_name].values.astype(np.float32)
    pct37 = 2.18 * tb_v - 1.18 * tb_h

    lats, lons = _get_swath_geolocation(ds_geo)

    # Regrid V37 and H37 onto a SINGLE consistent grid (need both for RGB)
    # 37 GHz has coarser footprint (~37 km for SSMIS) — use coarser grid
    gridded = _regrid_swath_multi(
        [tb_v, tb_h], lats, lons, channel_names=["v37", "h37"],
        grid_res_deg=0.05,
    )

    # Apply NRL Lee et al. (2002) formulas
    rgb = _nrl_37color_rgb(
        gridded["channels"]["v37"],
        gridded["channels"]["h37"],
    )

    result = {
        "data": rgb,
        "center_lat": gridded["center_lat"],
        "center_lon": gridded["center_lon"],
        "bounds": gridded["bounds"],
        "nx": gridded["nx"],
        "ny": gridded["ny"],
        "dx_km": gridded["dx_km"],
        "is_rgb": True,
        "product_label": "37 GHz Color Composite",
        "stats": {
            "pct37_min": float(np.nanmin(pct37)),
            "pct37_max": float(np.nanmax(pct37)),
            "v37_mean": float(np.nanmean(tb_v)),
            "h37_mean": float(np.nanmean(tb_h)),
        },
    }
    return result


def _compute_37color_interpolated(ds, sensor: str) -> dict:
    """
    Compute 37 GHz false-color composite from an interpolated grid.
    """
    v_name = _find_channel_var(ds, sensor, 37, "V")
    h_name = _find_channel_var(ds, sensor, 37, "H")
    if not v_name or not h_name:
        raise ValueError(f"Cannot find 37 GHz V and H channels for sensor {sensor}")

    tb_v = ds[v_name].values.astype(np.float32)
    tb_h = ds[h_name].values.astype(np.float32)
    pct37 = 2.18 * tb_v - 1.18 * tb_h

    # Apply NRL formulas
    rgb = _nrl_37color_rgb(tb_v, tb_h)

    result = _extract_grid_info(ds, pct37)
    result["data"] = rgb
    result["is_rgb"] = True
    result["product_label"] = "37 GHz Color Composite"
    result["stats"] = {
        "pct37_min": float(np.nanmin(pct37)),
        "pct37_max": float(np.nanmax(pct37)),
        "v37_mean": float(np.nanmean(tb_v)),
        "h37_mean": float(np.nanmean(tb_h)),
    }
    return result


def _get_swath_geolocation(ds_geo) -> Tuple[np.ndarray, np.ndarray]:
    """Extract lat/lon arrays from the geolocation group."""
    lat_candidates = ["latitude", "lat", "Latitude"]
    lon_candidates = ["longitude", "lon", "Longitude"]
    lats = lons = None
    for name in lat_candidates:
        if name in ds_geo.data_vars or name in ds_geo.coords:
            lats = ds_geo[name].values
            break
    for name in lon_candidates:
        if name in ds_geo.data_vars or name in ds_geo.coords:
            lons = ds_geo[name].values
            break
    if lats is None or lons is None:
        raise ValueError("Cannot find lat/lon in geolocation group")
    return lats, lons


def _extract_grid_info(ds, data: np.ndarray) -> dict:
    """
    Extract grid coordinate info from an interpolated (storm-centered) dataset.
    TC-PRIMED interpolated grids typically use x_distance, y_distance (km) coords,
    plus a storm center lat/lon attribute.
    """
    # Try to get storm-relative coordinates
    x_km = y_km = None
    for xname in ["x_distance", "x", "across_track"]:
        if xname in ds.coords or xname in ds.dims:
            x_km = ds[xname].values
            break
    for yname in ["y_distance", "y", "along_track"]:
        if yname in ds.coords or yname in ds.dims:
            y_km = ds[yname].values
            break

    # Get storm center from attributes
    center_lat = ds.attrs.get("storm_latitude", ds.attrs.get("center_latitude", 0.0))
    center_lon = ds.attrs.get("storm_longitude", ds.attrs.get("center_longitude", 0.0))

    if x_km is not None and y_km is not None:
        # Convert km offsets to lat/lon
        km_per_deg_lat = 111.0
        km_per_deg_lon = 111.0 * np.cos(np.radians(center_lat))
        lat_arr = center_lat + y_km / km_per_deg_lat
        lon_arr = center_lon + x_km / km_per_deg_lon
    else:
        # Try direct lat/lon coords
        for lname in ["latitude", "lat"]:
            if lname in ds.coords:
                lat_arr = ds[lname].values
                break
        else:
            lat_arr = np.arange(data.shape[0])
        for lname in ["longitude", "lon"]:
            if lname in ds.coords:
                lon_arr = ds[lname].values
                break
        else:
            lon_arr = np.arange(data.shape[1] if data.ndim > 1 else data.shape[0])

    south = float(np.min(lat_arr))
    north = float(np.max(lat_arr))
    west = float(np.min(lon_arr))
    east = float(np.max(lon_arr))

    return {
        "data": data,
        "center_lat": float(center_lat),
        "center_lon": float(center_lon),
        "bounds": [[south, west], [north, east]],
        "nx": data.shape[1] if data.ndim > 1 else data.shape[0],
        "ny": data.shape[0],
        "dx_km": float(np.abs(x_km[1] - x_km[0])) if x_km is not None and len(x_km) > 1 else None,
    }


def _build_storm_relative_grid(
    x_km: np.ndarray, y_km: np.ndarray, pct_data: np.ndarray,
    grid_extent_km: float = 250, grid_res_km: float = 4
) -> Optional[dict]:
    """
    Regrid the MW product data from irregular swath x/y (km) onto a regular
    storm-relative grid matching the TDR plan view (-250 to +250 km).

    Returns dict with x_axis, y_axis (1D lists in km) and z (2D list of lists)
    suitable for direct use as a Plotly heatmap/contour trace.
    Returns None if insufficient data.
    """
    from scipy.interpolate import griddata

    # Flatten & mask
    xf = x_km.ravel().astype(np.float32)
    yf = y_km.ravel().astype(np.float32)
    zf = pct_data.ravel().astype(np.float32) if pct_data.ndim >= 2 else pct_data.astype(np.float32)

    mask = (np.isfinite(xf) & np.isfinite(yf) & np.isfinite(zf) &
            (np.abs(xf) <= grid_extent_km * 1.2) &
            (np.abs(yf) <= grid_extent_km * 1.2))

    xf, yf, zf = xf[mask], yf[mask], zf[mask]
    if len(zf) < 50:
        return None

    # Regular grid
    n = int(2 * grid_extent_km / grid_res_km) + 1
    ax = np.linspace(-grid_extent_km, grid_extent_km, n)
    gx, gy = np.meshgrid(ax, ax)

    gridded = griddata((xf, yf), zf, (gx, gy), method="nearest")

    # Mask points far from any data (>15 km) to avoid extrapolation artifacts
    from scipy.spatial import cKDTree
    tree = cKDTree(np.column_stack([xf, yf]))
    dists, _ = tree.query(np.column_stack([gx.ravel(), gy.ravel()]))
    far_mask = dists.reshape(gridded.shape) > 15.0
    gridded[far_mask] = np.nan

    # Convert to JSON-friendly lists (replace NaN with None for JSON null)
    z_list = []
    for row in gridded:
        z_list.append([None if np.isnan(v) else round(float(v), 1) for v in row])

    return {
        "x_axis": [round(float(v), 1) for v in ax],
        "y_axis": [round(float(v), 1) for v in ax],
        "z": z_list,
        "nx": n,
        "ny": n,
        "extent_km": grid_extent_km,
        "res_km": grid_res_km,
    }


def _build_storm_relative_rgb_grid(
    x_km: np.ndarray, y_km: np.ndarray,
    pct37: np.ndarray, v37: np.ndarray, h37: np.ndarray,
    grid_extent_km: float = 250, grid_res_km: float = 4
) -> Optional[str]:
    """
    Build a storm-relative RGB PNG (base64) for the 37 GHz color composite
    on the Plotly plan view.  Returns base64 PNG string or None.

    Uses the NRL Lee et al. (2002) / Kieper & Jiang (2012) three-channel
    formulas via ``_nrl_37color_rgb()``.  V37 and H37 are gridded separately
    and the RGB is computed on the regular grid.
    """
    from scipy.interpolate import griddata
    from scipy.spatial import cKDTree

    # Flatten & mask (need both V37 and H37 valid)
    xf = x_km.ravel().astype(np.float32)
    yf = y_km.ravel().astype(np.float32)
    vf = v37.ravel().astype(np.float32)
    hf = h37.ravel().astype(np.float32)

    mask_valid = (np.isfinite(xf) & np.isfinite(yf) &
                  np.isfinite(vf) & np.isfinite(hf) &
                  (vf > 0) & (hf > 0) &
                  (np.abs(xf) <= grid_extent_km * 1.2) &
                  (np.abs(yf) <= grid_extent_km * 1.2))

    xf_m, yf_m = xf[mask_valid], yf[mask_valid]
    vf_m, hf_m = vf[mask_valid], hf[mask_valid]
    if len(xf_m) < 50:
        return None

    # Regular grid
    n = int(2 * grid_extent_km / grid_res_km) + 1
    ax = np.linspace(-grid_extent_km, grid_extent_km, n)
    gx, gy = np.meshgrid(ax, ax)

    # Distance mask — transparent where no data within 15 km
    tree = cKDTree(np.column_stack([xf_m, yf_m]))
    dists, _ = tree.query(np.column_stack([gx.ravel(), gy.ravel()]))
    far_mask = dists.reshape((n, n)) > 15.0

    # Grid V37 and H37 independently
    v37_grid = griddata((xf_m, yf_m), vf_m, (gx, gy), method="nearest")
    h37_grid = griddata((xf_m, yf_m), hf_m, (gx, gy), method="nearest")
    v37_grid[far_mask] = np.nan
    h37_grid[far_mask] = np.nan

    # Apply NRL Lee et al. (2002) RGB formulas
    rgb = _nrl_37color_rgb(v37_grid, h37_grid)  # (n, n, 3) uint8

    # Create alpha channel: transparent where data is missing (far from swath
    # OR where RGB is black from invalid input data)
    black_mask = (rgb[:, :, 0] == 0) & (rgb[:, :, 1] == 0) & (rgb[:, :, 2] == 0)
    alpha = np.where(far_mask | black_mask, 0, 180).astype(np.uint8)

    # Build RGBA image
    rgba = np.concatenate([rgb, alpha[:, :, np.newaxis]], axis=-1)

    # Flip vertically (Plotly plan view convention: y increasing upward)
    rgba = rgba[::-1]

    # Encode as PNG
    from PIL import Image
    img = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("ascii")


def _regrid_swath(data: np.ndarray, lats: np.ndarray, lons: np.ndarray,
                  grid_res_deg: float = 0.02) -> dict:
    """
    Regrid irregular swath data onto a regular lat/lon grid using
    nearest-neighbor binning. Fast and sufficient for image overlay.
    """
    from scipy.interpolate import griddata

    # Convert longitudes from 0–360 to -180/+180 if needed (TC-PRIMED uses 0–360)
    lons = lons.copy()
    lons[lons > 180] -= 360

    # Flatten
    mask = np.isfinite(data.ravel()) & np.isfinite(lats.ravel()) & np.isfinite(lons.ravel())
    flat_data = data.ravel()[mask]
    flat_lat = lats.ravel()[mask]
    flat_lon = lons.ravel()[mask]

    if len(flat_data) < 10:
        raise ValueError("Insufficient valid data points for regridding")

    # Define regular grid
    lat_min, lat_max = float(flat_lat.min()), float(flat_lat.max())
    lon_min, lon_max = float(flat_lon.min()), float(flat_lon.max())

    # Limit grid size to prevent memory issues
    max_grid_dim = 500
    n_lat = min(int((lat_max - lat_min) / grid_res_deg) + 1, max_grid_dim)
    n_lon = min(int((lon_max - lon_min) / grid_res_deg) + 1, max_grid_dim)

    grid_lat = np.linspace(lat_min, lat_max, n_lat)
    grid_lon = np.linspace(lon_min, lon_max, n_lon)
    glon, glat = np.meshgrid(grid_lon, grid_lat)

    # Regrid
    gridded = griddata(
        (flat_lon, flat_lat), flat_data,
        (glon, glat),
        method="nearest",
    )

    # Mask grid points far from any actual swath data to prevent
    # nearest-neighbor extrapolation beyond the swath edge.
    # Threshold: ~3x the grid resolution in degrees (~6 km at equator)
    from scipy.spatial import cKDTree
    tree = cKDTree(np.column_stack([flat_lon, flat_lat]))
    dists, _ = tree.query(np.column_stack([glon.ravel(), glat.ravel()]))
    max_dist_deg = grid_res_deg * 3.0
    far_mask = dists.reshape(gridded.shape) > max_dist_deg
    gridded[far_mask] = np.nan

    center_lat = (lat_min + lat_max) / 2.0
    center_lon = (lon_min + lon_max) / 2.0

    return {
        "data": gridded,
        "center_lat": center_lat,
        "center_lon": center_lon,
        "bounds": [[lat_min, lon_min], [lat_max, lon_max]],
        "nx": n_lon,
        "ny": n_lat,
        "dx_km": grid_res_deg * 111.0,
    }


def _regrid_swath_multi(
    data_channels: list, lats: np.ndarray, lons: np.ndarray,
    channel_names: list = None, grid_res_deg: float = 0.02
) -> dict:
    """
    Regrid multiple co-located swath channels onto a SINGLE regular lat/lon
    grid. All channels share the same geometry (lats, lons) and are regridded
    onto identical output grids — critical for building RGB composites.

    Returns dict with 'channels' (dict of name->2D array), plus grid metadata.
    """
    from scipy.interpolate import griddata

    # Convert longitudes from 0–360 to -180/+180
    lons = lons.copy()
    lons[lons > 180] -= 360

    # Build a common validity mask: a pixel must be valid in ALL channels
    mask = np.isfinite(lats.ravel()) & np.isfinite(lons.ravel())
    for ch in data_channels:
        mask &= np.isfinite(ch.ravel())

    flat_lat = lats.ravel()[mask]
    flat_lon = lons.ravel()[mask]

    if len(flat_lat) < 10:
        raise ValueError("Insufficient valid data points for multi-channel regridding")

    # Define regular grid
    lat_min, lat_max = float(flat_lat.min()), float(flat_lat.max())
    lon_min, lon_max = float(flat_lon.min()), float(flat_lon.max())

    max_grid_dim = 500
    n_lat = min(int((lat_max - lat_min) / grid_res_deg) + 1, max_grid_dim)
    n_lon = min(int((lon_max - lon_min) / grid_res_deg) + 1, max_grid_dim)

    grid_lat = np.linspace(lat_min, lat_max, n_lat)
    grid_lon = np.linspace(lon_min, lon_max, n_lon)
    glon, glat = np.meshgrid(grid_lon, grid_lat)

    # Regrid each channel onto the same grid
    if channel_names is None:
        channel_names = [f"ch{i}" for i in range(len(data_channels))]

    channels = {}
    for name, ch_data in zip(channel_names, data_channels):
        flat_ch = ch_data.ravel()[mask]
        channels[name] = griddata(
            (flat_lon, flat_lat), flat_ch,
            (glon, glat), method="nearest",
        )

    # Mask grid points far from any actual swath data to prevent
    # nearest-neighbor extrapolation beyond the swath edge.
    from scipy.spatial import cKDTree
    tree = cKDTree(np.column_stack([flat_lon, flat_lat]))
    dists, _ = tree.query(np.column_stack([glon.ravel(), glat.ravel()]))
    max_dist_deg = grid_res_deg * 3.0
    far_mask = dists.reshape(glon.shape) > max_dist_deg
    for name in channels:
        channels[name][far_mask] = np.nan

    center_lat = (lat_min + lat_max) / 2.0
    center_lon = (lon_min + lon_max) / 2.0

    return {
        "channels": channels,
        "center_lat": center_lat,
        "center_lon": center_lon,
        "bounds": [[lat_min, lon_min], [lat_max, lon_max]],
        "nx": n_lon,
        "ny": n_lat,
        "dx_km": grid_res_deg * 111.0,
    }


# ---------------------------------------------------------------------------
# Image rendering
# ---------------------------------------------------------------------------

def _nrl_89ghz_cmap():
    """
    Build a matplotlib colormap that mimics the NRL-Monterey 89/91 GHz
    display.  Anchor points (TB in K → colour) sampled from the NRL
    colourbar:
        105 K  dark gray     (coldest / deepest ice scattering)
        150 K  dark maroon
        180 K  bright red
        212 K  orange-yellow
        228 K  yellow-green
        254 K  green-cyan
        280 K  blue
        305 K  light blue    (warm ocean background)
    """
    import matplotlib.colors as mcolors
    # Normalised positions for vmin=105, vmax=305
    anchors = [
        (0.000, "#303030"),   # 105 K — dark gray
        (0.100, "#606060"),   # 125 K — medium gray
        (0.225, "#800000"),   # 150 K — dark maroon
        (0.375, "#FF0000"),   # 180 K — bright red
        (0.500, "#FF8C00"),   # 205 K — orange
        (0.535, "#FFD700"),   # 212 K — gold-yellow
        (0.615, "#ADFF2F"),   # 228 K — yellow-green
        (0.700, "#00CC44"),   # 245 K — green
        (0.745, "#00DDCC"),   # 254 K — cyan
        (0.825, "#0066FF"),   # 270 K — blue
        (0.875, "#0000CC"),   # 280 K — dark blue
        (1.000, "#8888FF"),   # 305 K — light blue
    ]
    positions = [a[0] for a in anchors]
    colors = [a[1] for a in anchors]
    return mcolors.LinearSegmentedColormap.from_list("nrl89ghz", list(zip(positions, colors)), N=256)


# Plotly-compatible colorscale (same NRL anchors, for JSON responses)
NRL_89GHZ_PLOTLY_COLORSCALE = [
    [0.000, "#303030"], [0.100, "#606060"], [0.225, "#800000"],
    [0.375, "#FF0000"], [0.500, "#FF8C00"], [0.535, "#FFD700"],
    [0.615, "#ADFF2F"], [0.700, "#00CC44"], [0.745, "#00DDCC"],
    [0.825, "#0066FF"], [0.875, "#0000CC"], [1.000, "#8888FF"],
]

# Default value range matching NRL display
NRL_VMIN = 105
NRL_VMAX = 305


# ---------------------------------------------------------------------------
# NRL-Monterey 37 GHz colormap (for V-pol and H-pol brightness temperatures)
# ---------------------------------------------------------------------------
# Sampled from the NRL-Monterey SSMIS 37V/37H product colorbars.
# Range: 125 K → 300 K
# Progression: magenta/pink → blue → cyan → green → yellow-green → yellow
#              → orange → red/brown → dark red
# Grey tones are used for land masking (handled separately).

def _nrl_37ghz_cmap():
    """
    Build a matplotlib colormap mimicking the NRL-Monterey 37 GHz V/H-pol
    display.  Anchor points sampled from reference NRL imagery:
        125 K  magenta/pink     (coldest — deep ice scattering)
        150 K  blue
        175 K  cyan
        200 K  green
        220 K  yellow-green
        240 K  yellow
        255 K  orange
        275 K  red-brown
        300 K  dark brown/maroon (warm land / ocean background)
    """
    import matplotlib.colors as mcolors
    # Normalised positions for vmin=125, vmax=300
    anchors = [
        (0.000, "#CC00CC"),   # 125 K — magenta
        (0.086, "#9900CC"),   # 140 K — blue-magenta
        (0.143, "#3333FF"),   # 150 K — blue
        (0.229, "#0099FF"),   # 165 K — light blue
        (0.286, "#00CCCC"),   # 175 K — cyan
        (0.371, "#00CC66"),   # 190 K — green-cyan
        (0.429, "#33CC33"),   # 200 K — green
        (0.514, "#99CC00"),   # 215 K — yellow-green
        (0.543, "#CCCC00"),   # 220 K — yellow-green
        (0.600, "#FFD700"),   # 230 K — gold/yellow
        (0.657, "#FFAA00"),   # 240 K — orange-yellow
        (0.714, "#FF8800"),   # 250 K — orange
        (0.743, "#FF6600"),   # 255 K — dark orange
        (0.829, "#CC3300"),   # 270 K — red-brown
        (0.886, "#993300"),   # 280 K — brown
        (1.000, "#663300"),   # 300 K — dark brown
    ]
    positions = [a[0] for a in anchors]
    colors = [a[1] for a in anchors]
    return mcolors.LinearSegmentedColormap.from_list("nrl37ghz", list(zip(positions, colors)), N=256)


# Plotly-compatible colorscale for 37 GHz V/H-pol products
NRL_37GHZ_PLOTLY_COLORSCALE = [
    [0.000, "#CC00CC"], [0.086, "#9900CC"], [0.143, "#3333FF"],
    [0.229, "#0099FF"], [0.286, "#00CCCC"], [0.371, "#00CC66"],
    [0.429, "#33CC33"], [0.514, "#99CC00"], [0.543, "#CCCC00"],
    [0.600, "#FFD700"], [0.657, "#FFAA00"], [0.714, "#FF8800"],
    [0.743, "#FF6600"], [0.829, "#CC3300"], [0.886, "#993300"],
    [1.000, "#663300"],
]

NRL_37_VMIN = 125
NRL_37_VMAX = 300


def _render_product_image(data_dict: dict, product: str) -> str:
    """
    Render the gridded product data as a transparent PNG (base64-encoded)
    suitable for Leaflet image overlay. Uses NRL-style colourmap for
    single-channel products, or direct RGB for 37color composite.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    data = data_dict["data"]
    if data is None:
        return ""

    # ── 37 GHz Color Composite: data is already RGB (ny, nx, 3) ──
    if product == "37color" and data.ndim == 3 and data.shape[2] == 3:
        from PIL import Image
        ny, nx = data.shape[:2]
        # Add alpha channel: transparent where all channels are zero
        alpha = np.where(
            (data[:, :, 0] == 0) & (data[:, :, 1] == 0) & (data[:, :, 2] == 0),
            0, 200
        ).astype(np.uint8)
        rgba = np.concatenate([data, alpha[:, :, np.newaxis]], axis=-1)
        # Flip vertically (origin="lower" convention)
        rgba = rgba[::-1]
        img = Image.fromarray(rgba, mode="RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return base64.b64encode(buf.read()).decode("ascii")

    # ── Single-channel products (89pct, 37h) ──
    if data.ndim == 1:
        return ""

    ny, nx = data.shape

    # NRL-style colormap and range per product
    _CBAR_RANGES = {
        "89pct": (NRL_VMIN, NRL_VMAX),
        "89v":   (150, 300),
        "89h":   (100, 290),
        "37h":   (NRL_37_VMIN, NRL_37_VMAX),
        "37v":   (NRL_37_VMIN, NRL_37_VMAX),
    }
    # Use dedicated 37 GHz colormap for 37V/37H products
    if product in ("37h", "37v"):
        cmap = _nrl_37ghz_cmap()
    else:
        cmap = _nrl_89ghz_cmap()
    vmin, vmax = _CBAR_RANGES.get(product, (NRL_VMIN, NRL_VMAX))

    # Create figure with transparent background
    dpi = 100
    fig_w = nx / dpi
    fig_h = ny / dpi
    fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=dpi)
    fig.patch.set_alpha(0.0)
    ax.set_position([0, 0, 1, 1])
    ax.set_axis_off()

    # Mask invalid values and set transparency
    masked = np.ma.masked_invalid(data)
    cmap_copy = cmap.copy()
    cmap_copy.set_bad(alpha=0.0)

    ax.imshow(
        masked,
        origin="lower",
        cmap=cmap_copy,
        vmin=vmin,
        vmax=vmax,
        interpolation="nearest",
        aspect="auto",
    )

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, transparent=True, bbox_inches="tight",
                pad_inches=0)
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("ascii")


# ---------------------------------------------------------------------------
# Colorbar endpoint (for frontend legend)
# ---------------------------------------------------------------------------

@router.get("/colorbar")
async def get_colorbar(
    product: str = Query("89pct", description="Product: '89pct', '37h', or '37color'"),
):
    """
    Return a standalone colorbar image (PNG, base64) for the given product,
    suitable for rendering as a map legend.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.colors as mcolors

    if product == "37color":
        # Build a synthetic 1-D gradient bar that sweeps through the three
        # key scene types in the 37 GHz color composite:
        #   Left:   deep convection (pink/magenta) — low PCT37, low pol-diff
        #   Centre: warm rain (cyan/teal)          — high PCT37, low pol-diff
        #   Right:  clear ocean (dark green)        — high PCT37, high pol-diff
        #
        # We parameterize V37 and H37 along this gradient using physical
        # scene archetypes.
        n = 256
        t = np.linspace(0, 1, n)
        # Segment 1: t=0→0.5  convection→rain (V37 rises, H37 stays close)
        # Segment 2: t=0.5→1  rain→ocean (V37 moderate, H37 drops → pol rises)
        v37_bar = np.where(t < 0.5,
                           165 + (255 - 165) * (t / 0.5),          # 165→255
                           255 + (220 - 255) * ((t - 0.5) / 0.5))  # 255→220
        h37_bar = np.where(t < 0.5,
                           160 + (245 - 160) * (t / 0.5),          # 160→245
                           245 + (175 - 245) * ((t - 0.5) / 0.5))  # 245→175
        rgb_1d = _nrl_37color_rgb(v37_bar, h37_bar)          # (256, 3) uint8
        rgb_bar = rgb_1d[np.newaxis, :, :].astype(np.float64) / 255.0  # (1, 256, 3)

        fig, ax = plt.subplots(figsize=(3.5, 0.5))
        ax.imshow(rgb_bar, aspect="auto", extent=[0, 1, 0, 1])
        ax.set_yticks([])
        ax.set_xlabel("")
        ax.set_xticks([])
        # Physical annotations — positioned along the gradient
        ax.text(0.08, 1.15, "Ice", fontsize=6, color="white", ha="center", va="bottom")
        ax.text(0.35, 1.15, "Rain", fontsize=6, color="white", ha="center", va="bottom")
        ax.text(0.65, 1.15, "Ocean", fontsize=6, color="white", ha="center", va="bottom")
        ax.set_title("37 GHz Color Composite", fontsize=7, color="white", pad=8)
        fig.patch.set_facecolor("none")
        for spine in ax.spines.values():
            spine.set_edgecolor("white")
            spine.set_linewidth(0.5)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=120, bbox_inches="tight", transparent=True)
        plt.close(fig)
        buf.seek(0)
        b64 = base64.b64encode(buf.read()).decode("ascii")
        return JSONResponse({"image_b64": b64, "product": product, "label": "37 GHz Color Composite"})

    # For 37V/37H, use our custom NRL 37 GHz colormap; others use NRL 89 GHz
    _CBAR_DEFS = {
        "89pct": (NRL_VMIN, NRL_VMAX, "nrl89", "89 GHz PCT (K)"),
        "89v":   (150, 300, "nrl89", "89 GHz V-pol TB (K)"),
        "89h":   (100, 290, "nrl89", "89 GHz H-pol TB (K)"),
        "37h":   (NRL_37_VMIN, NRL_37_VMAX, "nrl37", "37 GHz H-pol TB (K)"),
        "37v":   (NRL_37_VMIN, NRL_37_VMAX, "nrl37", "37 GHz V-pol TB (K)"),
    }
    if product not in _CBAR_DEFS:
        raise HTTPException(400, f"Unknown product '{product}'")
    vmin, vmax, cmap_key, label = _CBAR_DEFS[product]
    if cmap_key == "nrl37":
        cmap = _nrl_37ghz_cmap()
    else:
        cmap = _nrl_89ghz_cmap()

    fig, ax = plt.subplots(figsize=(4, 0.4))
    norm = mcolors.Normalize(vmin=vmin, vmax=vmax)
    sm = plt.cm.ScalarMappable(cmap=cmap, norm=norm)
    sm.set_array([])
    cbar = fig.colorbar(sm, cax=ax, orientation="horizontal")
    cbar.set_label(label, fontsize=9)
    cbar.ax.tick_params(labelsize=7)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=120, bbox_inches="tight", transparent=True)
    plt.close(fig)
    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode("ascii")

    return JSONResponse({"image_b64": b64, "product": product, "label": label})


# ---------------------------------------------------------------------------
# Realtime support: match a real-time TDR case to TC-PRIMED overpasses
# ---------------------------------------------------------------------------

@router.get("/realtime_overpasses")
async def get_realtime_overpasses(
    storm_name: str = Query(..., description="Storm name from real-time TDR"),
    year: int = Query(..., description="Year"),
    analysis_time: str = Query(..., description="TDR analysis time, ISO format"),
):
    """
    For real-time mode: given a storm name, year, and TDR analysis time,
    find matching TC-PRIMED overpasses. This works by looking up the ATCF ID
    from the IBTrACS mapping and then filtering the storm's overpasses
    by the analysis time window.
    """
    # Parse analysis time
    try:
        analysis_dt = _dt.fromisoformat(analysis_time.replace("Z", "+00:00"))
        if analysis_dt.tzinfo is None:
            analysis_dt = analysis_dt.replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(400, "Invalid analysis_time format. Use ISO 8601.")

    # Look up ATCF ID
    with _index_lock:
        atcf = _atcf_map.get((storm_name.upper(), year))

    if not atcf:
        return JSONResponse({
            "storm_name": storm_name,
            "year": year,
            "overpasses": [],
            "count": 0,
            "message": "No ATCF ID found for this storm",
        })

    # Get all storm overpasses — use index if available, otherwise live lookup
    with _index_lock:
        all_ops = _storm_overpass_index.get(atcf, [])

    if not all_ops:
        all_ops = _live_tcprimed_lookup(atcf, year)
        if all_ops:
            with _index_lock:
                _storm_overpass_index[atcf] = all_ops

    window = timedelta(hours=OVERPASS_WINDOW_HOURS)
    matched = []
    for op in all_ops:
        op_dt = _dt.strptime(op["datetime"], "%Y-%m-%d %H:%M UTC").replace(
            tzinfo=timezone.utc
        )
        offset = (op_dt - analysis_dt).total_seconds()
        if abs(offset) <= window.total_seconds():
            entry = dict(op)
            entry["offset_minutes"] = round(offset / 60.0, 1)
            matched.append(entry)

    matched.sort(key=lambda x: abs(x["offset_minutes"]))

    return JSONResponse({
        "storm_name": storm_name,
        "year": year,
        "atcf_id": atcf,
        "analysis_time": analysis_time,
        "overpasses": matched,
        "count": len(matched),
        "window_hours": OVERPASS_WINDOW_HOURS,
    })
