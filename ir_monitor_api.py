"""
ir_monitor_api.py — Real-Time IR Monitor API Endpoints
========================================================
Provides endpoints for the Real-Time IR Monitor page:
  - GET /active-storms     — List all active TCs worldwide
  - GET /storm/{id}/ir     — Fetch IR animation frames for a storm
  - GET /storm/{id}/metadata — Storm metadata + intensity history

How to integrate (in tc_radar_api.py):
    from ir_monitor_api import router as ir_monitor_router
    app.include_router(ir_monitor_router, prefix="/ir-monitor")

Covers Atlantic + East Pacific (NHC ATCF), Western Pacific,
Indian Ocean, and Southern Hemisphere (JTWC B-deck).
"""

import base64
import gc
import io
import json
import math
import os
import re
import threading
import time
import traceback
from collections import OrderedDict
from datetime import datetime as _dt, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response

# Shared satellite IR module
from satellite_ir import (
    select_goes_sat,
    satellite_name_from_bucket,
    find_goes_file,
    open_goes_subset,
    render_ir_png,
    build_frame_times,
    fetch_ir_frame,
    fetch_ir_tb_raw,
    compute_ir_vigor,
    render_vigor_png,
)

try:
    import requests as _requests
except ImportError:
    _requests = None

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
router = APIRouter(tags=["IR Monitor"])

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# NHC ATCF A-deck sources
NHC_ATCF_BASE = "https://ftp.nhc.noaa.gov/atcf/aid_public"
NHC_BDECK_BASE = "https://ftp.nhc.noaa.gov/atcf/btk"

# JTWC B-deck sources (order of preference)
# Reference: tropycal's realtime.py __read_btk_jtwc()
JTWC_SOURCES = [
    ("ssd",  "https://www.ssd.noaa.gov/PS/TROP/DATA/ATCF/JTWC"),
    ("ucar", "https://hurricanes.ral.ucar.edu/repository/data/bdecks_open"),
]

# JTWC CARQ a-deck (operational analyzed fixes — updates faster than b-deck)
JTWC_CARQ_BASE = "https://hurricanes.ral.ucar.edu/repository/data/carq"

# JTWC TCW (Tropical Cyclone Warning) — most real-time source for JTWC storms
JTWC_TCW_BASE = "https://www.metoc.navy.mil/jtwc/products"

# Basins already covered by NHC (skip in JTWC scan)
_NHC_BASINS = {"EP", "CP", "AL"}

# Cache settings
_STORM_CACHE_TTL = 300          # 5 minutes (matches Cloud Scheduler ping interval)
_IR_FRAME_CACHE_MAX = 200       # max cached IR frames (covers ~15 storms)
_IR_FRAME_CACHE_TTL = 300       # 5 minutes per frame

# Tb encoding constants (shared by /ir-raw endpoint and GCS prefetch)
_TB_VMIN = 160.0
_TB_VMAX = 330.0
_TB_SCALE = 254.0 / (_TB_VMAX - _TB_VMIN)

# ── GCS Raw Tb Frame Cache ──────────────────────────────────
# Reuses the same bucket as global archive (GCS_IR_CACHE_BUCKET env var).
# Stores raw Tb uint8 frames so subsequent colormap requests skip S3 fetches.
_GCS_IR_CACHE_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "")
_gcs_rt_client = None
_gcs_rt_bucket = None
_GCS_RT_VERSION = "rt-v7"

def _get_rt_gcs_bucket():
    global _gcs_rt_client, _gcs_rt_bucket
    if not _GCS_IR_CACHE_BUCKET:
        return None
    if _gcs_rt_bucket is not None:
        return _gcs_rt_bucket
    try:
        from google.cloud import storage
        _gcs_rt_client = storage.Client()
        _gcs_rt_bucket = _gcs_rt_client.bucket(_GCS_IR_CACHE_BUCKET)
        return _gcs_rt_bucket
    except Exception:
        return None

def _gcs_rt_get(atcf_id: str, dt_str: str) -> dict | None:
    """Try to read a cached raw Tb frame from GCS."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return None
    key = f"{_GCS_RT_VERSION}/ir-raw/{atcf_id}/{dt_str}.json"
    try:
        blob = bucket.blob(key)
        data = blob.download_as_bytes(timeout=5)
        return json.loads(data)
    except Exception:
        return None

def _gcs_rt_put(atcf_id: str, dt_str: str, frame: dict):
    """Write a raw Tb frame to GCS (fire-and-forget background thread)."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return
    def _upload():
        key = f"{_GCS_RT_VERSION}/ir-raw/{atcf_id}/{dt_str}.json"
        try:
            blob = bucket.blob(key)
            blob.upload_from_string(
                json.dumps(frame, separators=(",", ":")),
                content_type="application/json",
                timeout=15,
            )
        except Exception:
            pass
    threading.Thread(target=_upload, daemon=True).start()

# Saffir-Simpson thresholds
_SS_THRESHOLDS = [
    (137, "C5"), (113, "C4"), (96, "C3"), (83, "C2"),
    (64, "C1"), (34, "TS"), (0, "TD"),
]

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

_active_storms_cache: dict = {"storms": [], "updated_utc": None, "count_by_basin": {}}
_active_storms_lock = threading.Lock()
_last_poll_time: float = 0.0

_ir_frame_cache: OrderedDict = OrderedDict()

# ---------------------------------------------------------------------------
# Season Summary — IBTrACS-based climatology + current season stats
# ---------------------------------------------------------------------------
_CLIMO_YEARS = (1991, 2020)  # 30-year climatological baseline
_IBTRACS_BASINS = ["NA", "EP", "WP", "NI", "SI", "SP"]

# Basin name mapping from ATCF active-storm codes to IBTrACS codes
_ACTIVE_TO_IBTRACS_BASIN = {
    "ATL": "NA", "EPAC": "EP", "WPAC": "WP",
    "IO": "NI", "SHEM_SI": "SI", "SHEM_SP": "SP", "SHEM": "SI",
}

_ibtracs_storms: list = []         # raw storms from ibtracs_storms.json
_climo_cache: dict = {}            # basin → {named, hurricanes, major, ace} averages
_season_summary_cache: dict = {}   # last computed summary
_season_summary_ts: float = 0.0    # timestamp of last computation


def _load_ibtracs_for_climo():
    """Load ibtracs_storms.json once on startup for climatology."""
    global _ibtracs_storms, _climo_cache
    json_path = Path(__file__).parent / "ibtracs_storms.json"
    if not json_path.exists():
        print("[Season Summary] ibtracs_storms.json not found — season summary disabled")
        return
    try:
        data = json.loads(json_path.read_text())
        _ibtracs_storms = data.get("storms", [])
        print(f"[Season Summary] Loaded {len(_ibtracs_storms)} storms from IBTrACS")
    except Exception as exc:
        print(f"[Season Summary] Failed to load IBTrACS: {exc}")
        return

    # Pre-compute 30-year climatological averages per basin
    for basin in _IBTRACS_BASINS:
        yearly = {}  # year → {named, hurricanes, major, ace}
        for yr in range(_CLIMO_YEARS[0], _CLIMO_YEARS[1] + 1):
            yearly[yr] = {"named": 0, "hurricanes": 0, "major": 0, "ace": 0.0}
        for s in _ibtracs_storms:
            if s.get("basin") != basin:
                continue
            yr = s.get("year")
            if yr is None or yr < _CLIMO_YEARS[0] or yr > _CLIMO_YEARS[1]:
                continue
            pk = s.get("peak_wind_kt") or 0
            ace = s.get("ace") or 0.0
            if pk >= 34:
                yearly[yr]["named"] += 1
            if pk >= 64:
                yearly[yr]["hurricanes"] += 1
            if pk >= 96:
                yearly[yr]["major"] += 1
            yearly[yr]["ace"] += ace
        n_years = _CLIMO_YEARS[1] - _CLIMO_YEARS[0] + 1
        _climo_cache[basin] = {
            "named": round(sum(y["named"] for y in yearly.values()) / n_years, 1),
            "hurricanes": round(sum(y["hurricanes"] for y in yearly.values()) / n_years, 1),
            "major": round(sum(y["major"] for y in yearly.values()) / n_years, 1),
            "ace": round(sum(y["ace"] for y in yearly.values()) / n_years, 1),
        }
    print(f"[Season Summary] Climatology computed for {list(_climo_cache.keys())}")


def _compute_season_summary() -> dict:
    """Compute current-year season stats per basin."""
    global _season_summary_cache, _season_summary_ts

    now = _dt.now(timezone.utc)
    current_year = now.year

    # Check cache (10-minute TTL)
    if _season_summary_cache and (time.time() - _season_summary_ts) < 600:
        # Just update active_now counts from live data
        with _active_storms_lock:
            active_by_basin = dict(_active_storms_cache.get("count_by_basin", {}))
        for basin_code, bdata in _season_summary_cache.get("basins", {}).items():
            active = 0
            for atcf_code, ibt_code in _ACTIVE_TO_IBTRACS_BASIN.items():
                if ibt_code == basin_code:
                    active += active_by_basin.get(atcf_code, 0)
            bdata["active_now"] = active
        _season_summary_cache["updated_utc"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        return _season_summary_cache

    basins = {}
    for basin in _IBTRACS_BASINS:
        named = 0
        hurricanes = 0
        major = 0
        ace = 0.0
        for s in _ibtracs_storms:
            if s.get("basin") != basin or s.get("year") != current_year:
                continue
            pk = s.get("peak_wind_kt") or 0
            if pk >= 34:
                named += 1
            if pk >= 64:
                hurricanes += 1
            if pk >= 96:
                major += 1
            ace += s.get("ace") or 0.0

        climo = _climo_cache.get(basin, {})

        # Get active-now count from live cache
        active = 0
        with _active_storms_lock:
            active_by_basin = dict(_active_storms_cache.get("count_by_basin", {}))
        for atcf_code, ibt_code in _ACTIVE_TO_IBTRACS_BASIN.items():
            if ibt_code == basin:
                active += active_by_basin.get(atcf_code, 0)

        basins[basin] = {
            "named_storms": named,
            "hurricanes": hurricanes,
            "major_hurricanes": major,
            "ace": round(ace, 1),
            "climo_named": climo.get("named", 0),
            "climo_hurricanes": climo.get("hurricanes", 0),
            "climo_major": climo.get("major", 0),
            "climo_ace": climo.get("ace", 0),
            "active_now": active,
        }

    _season_summary_cache = {
        "year": current_year,
        "basins": basins,
        "climo_period": f"{_CLIMO_YEARS[0]}-{_CLIMO_YEARS[1]}",
        "updated_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _season_summary_ts = time.time()
    return _season_summary_cache


# Load IBTrACS on module import
_load_ibtracs_for_climo()

# Basin mapping from ATCF 2-letter code
_BASIN_MAP = {
    "AL": "ATL",
    "EP": "EPAC",
    "CP": "CPAC",
    "WP": "WPAC",
    "IO": "IO",
    "SH": "SHEM",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _classify_wind(vmax_kt: Optional[float]) -> str:
    """Classify wind speed to Saffir-Simpson category."""
    if vmax_kt is None:
        return "TD"
    for threshold, cat in _SS_THRESHOLDS:
        if vmax_kt >= threshold:
            return cat
    return "TD"


def _http_get(url: str, timeout: int = 15) -> Optional[str]:
    """Fetch a URL and return text content, or None on failure."""
    try:
        if _requests:
            r = _requests.get(url, timeout=timeout)
            r.raise_for_status()
            return r.text
        else:
            import urllib.request
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# ATCF A-deck / B-deck Parsing
# ---------------------------------------------------------------------------

def _list_nhc_active_storms() -> list:
    """
    List currently active storms from NHC's ATCF B-deck directory.
    Returns list of ATCF IDs like ['al142024', 'ep102024'].
    """
    # The NHC btk directory has files like bal142024.dat for all active storms
    # Also check the aid_public directory index
    text = _http_get(NHC_ATCF_BASE + "/", timeout=10)
    if not text:
        return []

    # Parse filenames from directory listing
    # Format: a{basin}{number}{year}.dat  e.g., aal142024.dat
    pattern = re.compile(r'a([a-z]{2}\d{2}\d{4})\.dat', re.IGNORECASE)
    storm_ids = set()
    for m in pattern.finditer(text):
        storm_ids.add(m.group(1).lower())

    return sorted(storm_ids)


def _list_jtwc_active_storms() -> list:
    """
    Discover active storms from JTWC B-deck directory listings.
    Returns list of tuples: (atcf_id, bdeck_url).

    Uses NOAA SSD (flat directory) as primary, UCAR as fallback.
    Skips EP/CP/AL storms (already covered by NHC).
    """
    year = _dt.now(timezone.utc).year

    for source_name, base_url in JTWC_SOURCES:
        if source_name == "ucar":
            listing_url = f"{base_url}/{year}/"
        else:
            listing_url = f"{base_url}/"

        text = _http_get(listing_url, timeout=15)
        if not text:
            print(f"[IR Monitor] JTWC {source_name} listing failed, trying next source")
            continue

        # Match B-deck files: b{basin}{number}{year}.dat
        # Basin codes: io, sh, wp, ep, cp (from tropycal pattern)
        pattern = re.compile(
            rf'b((?:io|sh|wp|ep|cp)\d{{2}}{year})\.dat',
            re.IGNORECASE,
        )

        storms = []
        seen = set()
        for m in pattern.finditer(text):
            storm_id = m.group(1).upper()
            basin_code = storm_id[:2]

            # Skip NHC basins
            if basin_code in _NHC_BASINS:
                continue

            if storm_id in seen:
                continue
            seen.add(storm_id)

            # UCAR organises files by year subdirectory; SSD is flat
            if source_name == "ucar":
                bdeck_url = f"{base_url}/{year}/b{storm_id.lower()}.dat"
            else:
                bdeck_url = f"{base_url}/b{storm_id.lower()}.dat"
            storms.append((storm_id, bdeck_url))

        # For SH storms that straddle year boundary (Nov→Apr),
        # also check previous year if we're in Jan-Jun
        if _dt.now(timezone.utc).month <= 6:
            prev_year = year - 1
            if source_name == "ucar":
                prev_url = f"{base_url}/{prev_year}/"
                prev_text = _http_get(prev_url, timeout=10)
            else:
                prev_text = text  # SSD flat listing already has all years

            if prev_text:
                prev_pattern = re.compile(
                    rf'b(sh\d{{2}}{prev_year})\.dat',
                    re.IGNORECASE,
                )
                for m in prev_pattern.finditer(prev_text):
                    storm_id = m.group(1).upper()
                    if storm_id not in seen:
                        seen.add(storm_id)
                        if source_name == "ucar":
                            bdeck_url = f"{base_url}/{prev_year}/b{storm_id.lower()}.dat"
                        else:
                            bdeck_url = f"{base_url}/b{storm_id.lower()}.dat"
                        storms.append((storm_id, bdeck_url))

        if storms:
            print(f"[IR Monitor] JTWC {source_name}: found {len(storms)} storms: "
                  f"{[s[0] for s in storms]}")
            return storms

        print(f"[IR Monitor] JTWC {source_name}: no active storms found")

    return []


def _fetch_jtwc_bdeck(atcf_id: str, bdeck_url: Optional[str] = None) -> list:
    """
    Fetch and parse a JTWC B-deck file.
    If bdeck_url is provided, use it directly. Otherwise try each JTWC source.
    Returns list of parsed records sorted by datetime.
    """
    urls_to_try = []
    if bdeck_url:
        urls_to_try.append(bdeck_url)
    else:
        # Extract year from ATCF ID (last 4 chars)
        year_str = atcf_id[-4:]
        for source_name, base_url in JTWC_SOURCES:
            if source_name == "ucar":
                urls_to_try.append(f"{base_url}/{year_str}/b{atcf_id.lower()}.dat")
            else:
                urls_to_try.append(f"{base_url}/b{atcf_id.lower()}.dat")

    for url in urls_to_try:
        text = _http_get(url, timeout=15)
        if not text:
            continue

        records = []
        for line in text.strip().split("\n"):
            rec = _parse_adeck_line(line)  # same CSV format as A-deck
            if rec:
                records.append(rec)

        if records:
            records.sort(key=lambda r: r["datetime"])
            return records

    return []


def _fetch_jtwc_carq(atcf_id: str) -> list:
    """
    Fetch JTWC CARQ a-deck (operationally-analyzed fixes) from UCAR.
    These update faster than b-decks and provide fresher position/intensity.
    Returns list of parsed records sorted by datetime, or empty list.
    """
    year_str = atcf_id[-4:]
    url = f"{JTWC_CARQ_BASE}/{year_str}/a{atcf_id.lower()}.dat"
    text = _http_get(url, timeout=10)
    if not text:
        return []

    records = []
    for line in text.strip().split("\n"):
        rec = _parse_adeck_line(line)
        if rec:
            records.append(rec)

    if records:
        records.sort(key=lambda r: r["datetime"])
    return records


def _fetch_jtwc_tcw(atcf_id: str) -> tuple:
    """
    Fetch JTWC Tropical Cyclone Warning (TCW) and parse the T000 line.
    TCW is the most real-time JTWC source — updates within minutes of
    advisory issuance, while b-deck/CARQ can lag hours.

    URL pattern: {JTWC_TCW_BASE}/{basin}{num}{2-digit-year}.tcw
    Header line 3: YYYYMMDDHH {num}{basin} {name} {warn_num} ...
    T000 line:     T000 {lat3}{N/S} {lon4}{E/W} {vmax} [wind radii...]

    Returns (records, name) where records is a list with a single parsed
    record (ATCF-compatible dict) and name is the storm name, or ([], None).
    """
    # Map ATCF basin prefix to TCW filename prefix
    basin_prefix = atcf_id[:2].upper()  # e.g., "WP", "SH", "IO"
    storm_num = atcf_id[2:4]            # e.g., "04"
    year_4 = atcf_id[-4:]               # e.g., "2026"
    year_2 = year_4[-2:]                # e.g., "26"

    url = f"{JTWC_TCW_BASE}/{basin_prefix.lower()}{storm_num}{year_2}.tcw"
    text = _http_get(url, timeout=8)
    if not text:
        return [], None

    lines = text.strip().split("\n")
    if len(lines) < 4:
        return [], None

    try:
        # Line 3 (0-indexed line 2): "YYYYMMDDHH {storm_id} {name} ..."
        header = lines[2].split()
        if len(header) < 3:
            return [], None
        dt_str = header[0]  # e.g., "2026041018"
        dt = _dt.strptime(dt_str, "%Y%m%d%H").replace(tzinfo=timezone.utc)
        tcw_name = header[2].strip().title() if len(header) > 2 else None
        if tcw_name and tcw_name.upper() in ("", "UNNAMED", "NONAME"):
            tcw_name = None

        # Find T000 line (tau=0 current position)
        t000_line = None
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("T000 "):
                t000_line = stripped
                break

        if not t000_line:
            return [], tcw_name

        parts = t000_line.split()
        # T000 {lat}{N/S} {lon}{E/W} {vmax} ...
        if len(parts) < 4:
            return [], tcw_name

        lat_str = parts[1]   # e.g., "080N" or "084S"
        lon_str = parts[2]   # e.g., "1510E" or "1543E"
        vmax = int(parts[3])

        # Parse lat: "080N" → 8.0, "084S" → -8.4
        lat_val = int(lat_str[:-1]) / 10.0
        if lat_str[-1] == "S":
            lat_val = -lat_val

        # Parse lon: "1510E" → 151.0, "0691E" → 69.1
        lon_val = int(lon_str[:-1]) / 10.0
        if lon_str[-1] == "W":
            lon_val = -lon_val

        # Build ATCF-compatible record dict
        # MSLP not in TCW T000 line — will be filled from b-deck/CARQ
        record = {
            "basin": basin_prefix,
            "storm_num": int(storm_num),
            "datetime": dt,
            "tech": "JTWC",
            "tau": 0,
            "lat": lat_val,
            "lon": lon_val,
            "vmax_kt": vmax,
            "mslp_hpa": None,
        }

        return [record], tcw_name

    except (ValueError, IndexError) as e:
        print(f"[IR Monitor] TCW parse error for {atcf_id}: {e}")
        return [], None


def _extract_storm_name(text: str) -> Optional[str]:
    """
    Try to extract the storm name from a B-deck file.
    ATCF B-deck extended format has the name in column 27 (0-indexed).
    Iterates in reverse to get the most recent (and usually proper) name.
    """
    lines = text.strip().split("\n")
    for line in reversed(lines):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) > 27 and parts[27].strip():
            name = parts[27].strip().upper()
            if name and name not in ("", "UNNAMED", "NONAME"):
                return name.title()
    return None


def _parse_adeck_line(line: str) -> Optional[dict]:
    """
    Parse a single A-deck CSV line.
    Returns dict with fields or None if unparseable.

    A-deck format (comma-separated):
    basin, cy, YYYYMMDDHH, technum, tech, tau, lat, lon, vmax, mslp, ...
    """
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 12:
        return None

    try:
        basin = parts[0].strip()
        storm_num = parts[1].strip()
        dt_str = parts[2].strip()
        tech = parts[4].strip()
        tau = int(parts[5].strip()) if parts[5].strip() else 0

        # Parse lat: e.g., "221N" → 22.1
        lat_str = parts[6].strip()
        lat_val = float(lat_str[:-1]) / 10.0
        if lat_str.endswith("S"):
            lat_val = -lat_val

        # Parse lon: e.g., "864W" → -86.4
        lon_str = parts[7].strip()
        lon_val = float(lon_str[:-1]) / 10.0
        if lon_str.endswith("W"):
            lon_val = -lon_val

        vmax = int(parts[8].strip()) if parts[8].strip() else None
        mslp = int(parts[9].strip()) if parts[9].strip() else None

        # Parse datetime
        dt = _dt.strptime(dt_str, "%Y%m%d%H").replace(tzinfo=timezone.utc)

        return {
            "basin": basin,
            "storm_num": storm_num,
            "datetime": dt,
            "tech": tech,
            "tau": tau,
            "lat": lat_val,
            "lon": lon_val,
            "vmax_kt": vmax,
            "mslp_hpa": mslp,
        }
    except (ValueError, IndexError):
        return None


def _fetch_adeck(atcf_id: str) -> list:
    """
    Fetch and parse the A-deck file for a given ATCF ID.
    Returns list of parsed records sorted by datetime.
    """
    # Try aid_public first (operational forecasts)
    url = f"{NHC_ATCF_BASE}/a{atcf_id}.dat"
    text = _http_get(url)
    if not text:
        return []

    records = []
    for line in text.strip().split("\n"):
        rec = _parse_adeck_line(line)
        if rec:
            records.append(rec)

    records.sort(key=lambda r: r["datetime"])
    return records


def _fetch_bdeck(atcf_id: str) -> list:
    """
    Fetch and parse the B-deck (best track) file.
    Tries NHC first, then JTWC sources.
    For JTWC storms, also merges CARQ a-deck records for fresher fixes.
    Returns list of parsed records sorted by datetime.
    """
    # Try NHC B-deck
    url = f"{NHC_BDECK_BASE}/b{atcf_id}.dat"
    text = _http_get(url)
    if text:
        records = []
        for line in text.strip().split("\n"):
            rec = _parse_adeck_line(line)
            if rec:
                records.append(rec)
        if records:
            records.sort(key=lambda r: r["datetime"])
            return records

    # Fall back to JTWC B-deck + CARQ supplement
    bdeck_records = _fetch_jtwc_bdeck(atcf_id)
    carq_records = _fetch_jtwc_carq(atcf_id)
    if not carq_records:
        return bdeck_records

    # Merge and deduplicate
    seen_keys = set()
    merged = []
    for rec in bdeck_records + carq_records:
        key = (rec["datetime"], rec["tau"], rec["tech"])
        if key not in seen_keys:
            seen_keys.add(key)
            merged.append(rec)
    merged.sort(key=lambda r: r["datetime"])
    return merged


def _get_latest_position(records: list) -> Optional[dict]:
    """
    From A-deck/B-deck/TCW records, get the most recent tau=0 fix.
    Among records at the same datetime, prefer CARQ > JTWC > OFCL > BEST.
    If multiple datetimes exist, always pick the most recent one regardless
    of technique (e.g., JTWC at 18Z beats CARQ at 12Z).
    """
    # Filter to tau=0 (current position, not forecasts)
    t0_records = [r for r in records if r["tau"] == 0]
    if not t0_records:
        return None

    # Find the most recent datetime across all techniques
    latest_dt = max(r["datetime"] for r in t0_records)

    # Among records at the latest datetime, prefer by technique priority
    latest_records = [r for r in t0_records if r["datetime"] == latest_dt]
    for preferred_tech in ["CARQ", "JTWC", "OFCL", "BEST"]:
        for r in latest_records:
            if r["tech"] == preferred_tech:
                return r

    # Fallback: any record at the latest datetime
    return latest_records[-1]


def _build_storm_entry(atcf_id: str, records: list,
                       name: Optional[str] = None,
                       source: str = "NHC") -> Optional[dict]:
    """
    Build a storm entry dict from A-deck or B-deck records.
    Returns None if no valid position found.
    """
    latest = _get_latest_position(records)
    if not latest:
        return None

    basin_code = latest["basin"]
    basin = _BASIN_MAP.get(basin_code, basin_code)

    vmax = latest["vmax_kt"]
    cat = _classify_wind(vmax)

    # Use provided name, or fall back to ATCF ID
    display_name = name if name else atcf_id.upper()

    return {
        "atcf_id": atcf_id.upper(),
        "name": display_name,
        "basin": basin,
        "lat": latest["lat"],
        "lon": latest["lon"],
        "vmax_kt": vmax,
        "mslp_hpa": latest["mslp_hpa"],
        "category": cat,
        "motion_deg": None,   # TODO: compute from successive fixes
        "motion_kt": None,
        "last_fix_utc": latest["datetime"].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "satellite": satellite_name_from_bucket(
            select_goes_sat(latest["lon"], latest["datetime"])[0]
        ),
        "source": source,
        "has_recon": False,  # TODO: cross-ref with Real-Time TDR
    }


def _is_invest(atcf_id: str) -> bool:
    """True if the ATCF ID is an invest (storm number 90-99)."""
    try:
        num = int(atcf_id[2:4])
        return 90 <= num <= 99
    except (IndexError, ValueError):
        return False


def _haversine_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Approximate great-circle distance in degrees (good enough for filtering)."""
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    # Simple Euclidean in lat/lon space with cos(lat) correction
    cos_lat = math.cos(math.radians((lat1 + lat2) / 2.0))
    return math.sqrt(dlat * dlat + (dlon * cos_lat) ** 2)


def _filter_genesis_invests(storms: list, radius_deg: float = 5.0,
                            genesis_radius_deg: float = 12.0) -> list:
    """
    Remove invests (90-99) that have likely undergone genesis into a named
    storm (01-89) in the same basin.

    Two checks are applied:
    1. Current-position proximity: invest is within `radius_deg` of a named
       storm's current position (catches storms that haven't moved far).
    2. Genesis-track proximity: invest has a B-deck fix near the named
       storm's FIRST fix (genesis position) within ±72 h.  This catches
       cases like JTWC where the invest B-deck persists after genesis and
       the named storm has moved far from the invest's last position.
    """
    # Separate named storms from invests
    named = [s for s in storms if not _is_invest(s["atcf_id"])]
    invests = [s for s in storms if _is_invest(s["atcf_id"])]

    if not invests or not named:
        return storms  # nothing to filter

    # For genesis-track check, we need the named storms' first fixes
    # (genesis positions).  Fetch B-deck tracks for named storms.
    named_genesis = {}  # atcf_id → {lat, lon, datetime}
    for ns in named:
        try:
            records = _fetch_bdeck(ns["atcf_id"].lower())
            if not records:
                records = _fetch_jtwc_bdeck(ns["atcf_id"].lower())
            if records:
                t0_records = [r for r in records if r.get("tau", 0) == 0]
                if t0_records:
                    first = t0_records[0]
                    named_genesis[ns["atcf_id"]] = {
                        "lat": first["lat"], "lon": first["lon"],
                        "datetime": first["datetime"]
                    }
        except Exception:
            pass

    keep = []
    for inv in invests:
        inv_basin = inv["basin"]
        is_duplicate = False

        for ns in named:
            if ns["basin"] != inv_basin:
                continue

            # Check 1: current-position proximity
            dist = _haversine_deg(inv["lat"], inv["lon"], ns["lat"], ns["lon"])
            if dist < radius_deg:
                print(f"[IR Monitor] Filtering invest {inv['atcf_id']} — "
                      f"within {dist:.1f}° of named storm {ns['atcf_id']} ({ns['name']})")
                is_duplicate = True
                break

            # Check 2: genesis-track proximity
            genesis = named_genesis.get(ns["atcf_id"])
            if genesis:
                # Fetch invest's B-deck to check if any fix was near genesis
                try:
                    inv_records = _fetch_jtwc_bdeck(inv["atcf_id"].lower())
                    if not inv_records:
                        inv_records = _fetch_bdeck(inv["atcf_id"].lower())
                    if inv_records:
                        gen_dt = genesis["datetime"]
                        for r in inv_records:
                            if r.get("tau", 0) != 0:
                                continue
                            # Check temporal proximity (within 72h of genesis)
                            dt_diff = abs((r["datetime"] - gen_dt).total_seconds())
                            if dt_diff > 72 * 3600:
                                continue
                            # Check spatial proximity to genesis position
                            d = _haversine_deg(r["lat"], r["lon"],
                                               genesis["lat"], genesis["lon"])
                            if d < genesis_radius_deg:
                                print(f"[IR Monitor] Filtering invest {inv['atcf_id']} — "
                                      f"track fix within {d:.1f}° of "
                                      f"{ns['atcf_id']} ({ns['name']}) genesis "
                                      f"position at {gen_dt:%Y-%m-%d}")
                                is_duplicate = True
                                break
                except Exception as e:
                    print(f"[IR Monitor] Error checking invest {inv['atcf_id']} "
                          f"genesis proximity: {e}")

            if is_duplicate:
                break

        if not is_duplicate:
            keep.append(inv)

    return named + keep


# ---------------------------------------------------------------------------
# Polling Logic
# ---------------------------------------------------------------------------

def _poll_active_storms():
    """
    Poll NHC + JTWC for all active storms worldwide and update the cache.
    This runs in the request thread (with TTL gating) or a background thread.
    """
    global _last_poll_time
    now = _dt.now(timezone.utc)
    storms = []
    seen_ids = set()

    # ── NHC storms (ATL + EPAC) ──
    nhc_ids = _list_nhc_active_storms()
    for sid in nhc_ids:
        records = _fetch_adeck(sid)
        if not records:
            continue
        latest = _get_latest_position(records)
        if not latest:
            continue
        age = now - latest["datetime"]
        if age > timedelta(hours=24):
            continue
        entry = _build_storm_entry(sid, records, source="NHC")
        if entry:
            storms.append(entry)
            seen_ids.add(sid.upper())

    print(f"[IR Monitor] NHC: {len(nhc_ids)} A-deck files → {len(storms)} active storms")

    # ── JTWC storms (WPAC, IO, SHEM) ──
    jtwc_storms = _list_jtwc_active_storms()
    jtwc_count = 0
    for storm_id, bdeck_url in jtwc_storms:
        if storm_id in seen_ids:
            continue

        bdeck_records = _fetch_jtwc_bdeck(storm_id, bdeck_url)

        # Supplement with CARQ a-deck (operational fixes — often fresher)
        carq_records = _fetch_jtwc_carq(storm_id)

        # Supplement with TCW warning (most real-time JTWC source)
        tcw_records, tcw_name = _fetch_jtwc_tcw(storm_id)

        # Merge all sources, deduplicate by (datetime, tau, tech)
        seen_keys = set()
        records = []
        for rec in bdeck_records + carq_records + tcw_records:
            key = (rec["datetime"], rec["tau"], rec["tech"])
            if key not in seen_keys:
                seen_keys.add(key)
                records.append(rec)
        records.sort(key=lambda r: r["datetime"])

        if not records:
            print(f"[IR Monitor] JTWC {storm_id}: no B-deck/CARQ/TCW records")
            continue

        latest = _get_latest_position(records)
        if not latest:
            print(f"[IR Monitor] JTWC {storm_id}: no tau=0 position in {len(records)} records")
            continue
        age = now - latest["datetime"]
        if age > timedelta(hours=48):  # JTWC B-decks update less frequently
            print(f"[IR Monitor] JTWC {storm_id}: stale — last fix {latest['datetime']} ({age} ago)")
            continue

        # Storm name: prefer TCW (most current), fall back to b-deck text
        name = tcw_name
        if not name:
            raw_text = _http_get(bdeck_url, timeout=10)
            name = _extract_storm_name(raw_text) if raw_text else None

        bdeck_latest = bdeck_records[-1]["datetime"].strftime("%H%MZ") if bdeck_records else "none"
        carq_latest = carq_records[-1]["datetime"].strftime("%H%MZ") if carq_records else "none"
        tcw_latest = tcw_records[-1]["datetime"].strftime("%H%MZ") if tcw_records else "none"
        print(f"[IR Monitor] JTWC {storm_id}: B-deck={bdeck_latest}, CARQ={carq_latest}, TCW={tcw_latest}, using={latest['datetime'].strftime('%Y-%m-%d %H:%MZ')} ({latest['tech']})")

        entry = _build_storm_entry(storm_id, records, name=name, source="JTWC")
        if entry:
            storms.append(entry)
            seen_ids.add(storm_id)
            jtwc_count += 1

    print(f"[IR Monitor] JTWC: {len(jtwc_storms)} B-deck files → {jtwc_count} active storms")

    # ── Filter out invests that have undergone genesis ──
    # When a JTWC invest (number 90-99) develops into a named storm
    # (number 01-89), both entries may appear in the active list.
    # Remove invests that are within 5° of a named storm in the same basin,
    # since they almost certainly represent the same system post-genesis.
    storms = _filter_genesis_invests(storms)

    # ── Update cache ──
    count_by_basin: dict = {}
    for s in storms:
        b = s["basin"]
        count_by_basin[b] = count_by_basin.get(b, 0) + 1

    with _active_storms_lock:
        _active_storms_cache["storms"] = storms
        _active_storms_cache["updated_utc"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        _active_storms_cache["count_by_basin"] = count_by_basin

    _last_poll_time = time.time()
    total = len(storms)
    print(f"[IR Monitor] Total: {total} active storms worldwide — {count_by_basin}")

    # Kick off background IR pre-fetch for all active storms
    if storms:
        t = threading.Thread(target=_prefetch_ir_frames, args=(list(storms),), daemon=True)
        t.start()


# ---------------------------------------------------------------------------
# Background IR Pre-Fetch
# ---------------------------------------------------------------------------

# Default pre-fetch settings (match the endpoint defaults)
_PREFETCH_LOOKBACK_HOURS = 6.0
_PREFETCH_INTERVAL_MIN = 30
_PREFETCH_RADIUS_DEG = 10.0
_prefetch_lock = threading.Lock()

def _prefetch_ir_frames(storms: list):
    """
    Pre-fetch IR imagery for all active storms in the background.
    Runs after each poll cycle so frames are ready when users click a storm.
    Only fetches frames not already in cache.
    """
    if not _prefetch_lock.acquire(blocking=False):
        print("[IR Pre-fetch] Already running, skipping")
        return
    try:
        total_fetched = 0
        total_cached = 0
        total_gcs_fetched = 0
        for storm in storms:
            atcf_id = storm["atcf_id"]
            center_lat = storm["lat"]
            center_lon = storm["lon"]
            box_deg = _PREFETCH_RADIUS_DEG * 2

            # Always use current UTC so prefetch covers the latest imagery
            center_dt = _dt.now(timezone.utc)

            frame_times = build_frame_times(
                center_dt, _PREFETCH_LOOKBACK_HOURS, _PREFETCH_INTERVAL_MIN
            )

            storm_fetched = 0
            for target_dt in reversed(frame_times):
                cache_key = (atcf_id.upper(), target_dt.strftime("%Y%m%d%H%M"))
                if cache_key in _ir_frame_cache:
                    total_cached += 1
                    continue

                try:
                    frame = fetch_ir_frame(
                        center_lat, center_lon, target_dt, box_deg
                    )
                except Exception:
                    continue

                if frame:
                    _ir_frame_cache[cache_key] = frame
                    if len(_ir_frame_cache) > _IR_FRAME_CACHE_MAX:
                        _ir_frame_cache.popitem(last=False)
                    storm_fetched += 1
                    total_fetched += 1

                gc.collect()

            if storm_fetched:
                print(f"[IR Pre-fetch] {atcf_id}: fetched {storm_fetched} new frames")

            # ── GCS raw Tb + JPG prefetch ──────────────────────────
            # Proactively cache raw Tb uint8 frames AND pre-rendered
            # JPGs to GCS so that both /ir-raw and /ir-frame.jpg
            # requests are served instantly from cache.
            if _get_rt_gcs_bucket() is not None:
                gcs_fetched = 0
                jpg_cached = 0
                for target_dt in reversed(frame_times):
                    dt_str = target_dt.strftime("%Y%m%d%H%M")

                    # Skip if already cached in GCS
                    if _gcs_rt_get(atcf_id.upper(), dt_str) is not None:
                        continue

                    try:
                        raw = fetch_ir_tb_raw(
                            center_lat, center_lon, target_dt, box_deg
                        )
                    except Exception:
                        continue

                    if raw and raw.get("tb") is not None:
                        # Pre-render JPG for /ir-frame.jpg endpoint
                        jpg_bytes = _render_ir_jpg(raw["tb"])
                        if jpg_bytes:
                            _gcs_jpg_put(atcf_id.upper(), dt_str, jpg_bytes)
                            jpg_cached += 1

                        tb = raw["tb"]
                        arr = np.asarray(tb, dtype=np.float32)
                        mask = ~np.isfinite(arr) | (arr <= 0)
                        scaled = np.clip(
                            (arr - _TB_VMIN) * _TB_SCALE + 1, 1, 255
                        )
                        scaled[mask] = 0
                        encoded = scaled.astype(np.uint8)

                        half = box_deg / 2.0
                        frame_result = {
                            "tb_data": base64.b64encode(
                                encoded.tobytes()
                            ).decode("ascii"),
                            "tb_rows": encoded.shape[0],
                            "tb_cols": encoded.shape[1],
                            "tb_vmin": _TB_VMIN,
                            "tb_vmax": _TB_VMAX,
                            "datetime_utc": raw["datetime_utc"],
                            "satellite": raw.get("satellite", ""),
                            "bounds": raw.get("bounds", [
                                [center_lat - half, center_lon - half],
                                [center_lat + half, center_lon + half],
                            ]),
                        }

                        _gcs_rt_put(atcf_id.upper(), dt_str, frame_result)
                        gcs_fetched += 1

                        del tb, arr, mask, scaled, encoded
                        gc.collect()

                    time.sleep(0.2)

                if gcs_fetched or jpg_cached:
                    print(f"[IR Pre-fetch] {atcf_id}: cached {gcs_fetched} raw Tb + {jpg_cached} JPG frames to GCS")
                total_gcs_fetched += gcs_fetched

        print(f"[IR Pre-fetch] Done — {total_fetched} new PNG frames, "
              f"{total_cached} already cached, "
              f"{total_gcs_fetched} raw Tb frames cached to GCS")
    except Exception:
        traceback.print_exc()
    finally:
        _prefetch_lock.release()


def _ensure_fresh_cache():
    """If the cache is stale (older than TTL), re-poll."""
    global _last_poll_time
    if time.time() - _last_poll_time > _STORM_CACHE_TTL:
        try:
            _poll_active_storms()
        except Exception:
            traceback.print_exc()


# ---------------------------------------------------------------------------
# Background Storm Refresh Thread
# ---------------------------------------------------------------------------
# Proactively refreshes the active storms cache on a fixed interval so that
# no user request ever has to wait for NHC/JTWC polling.  The /warmup
# endpoint in tc_radar_api.py also calls refresh_active_storms_cache()
# as a belt-and-suspenders approach (Cloud Scheduler every 5 min).

_bg_refresh_stop = threading.Event()


def _background_storm_refresh():
    """Daemon thread: refresh active storms cache every _STORM_CACHE_TTL seconds."""
    # Small initial delay to let the app finish startup before first poll
    _bg_refresh_stop.wait(10)
    while not _bg_refresh_stop.is_set():
        try:
            _poll_active_storms()
            print("[IR Monitor] Background refresh completed")
        except Exception:
            traceback.print_exc()
        _bg_refresh_stop.wait(_STORM_CACHE_TTL)


def start_background_refresh():
    """Start the background storm refresh thread.  Called once at app startup."""
    t = threading.Thread(target=_background_storm_refresh, daemon=True,
                         name="storm-refresh")
    t.start()
    print("[IR Monitor] Background storm refresh thread started "
          f"(interval={_STORM_CACHE_TTL}s)")


def refresh_active_storms_cache():
    """
    Exported helper for the /warmup endpoint.
    Forces an immediate cache refresh if the cache is older than 60 seconds
    (avoids double-polling when the background thread just ran).
    Returns summary dict for the warmup response.
    """
    if time.time() - _last_poll_time > 60:
        try:
            _poll_active_storms()
        except Exception:
            traceback.print_exc()

    with _active_storms_lock:
        return {
            "storm_count": len(_active_storms_cache["storms"]),
            "updated_utc": _active_storms_cache["updated_utc"],
            "count_by_basin": dict(_active_storms_cache["count_by_basin"]),
        }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/active-storms")
def get_active_storms():
    """
    Return all currently active tropical cyclones worldwide.
    Data sourced from NHC ATCF A-deck (ATL + EPAC) and JTWC B-deck (WPAC, IO, SHEM).
    Results are cached for 10 minutes.
    """
    _ensure_fresh_cache()

    with _active_storms_lock:
        data = {
            "storms": list(_active_storms_cache["storms"]),
            "updated_utc": _active_storms_cache["updated_utc"],
            "count_by_basin": dict(_active_storms_cache["count_by_basin"]),
        }

    return JSONResponse(
        content=data,
        headers={"Cache-Control": "public, max-age=120"},
    )


@router.get("/season-summary")
def get_season_summary():
    """
    Return current-year season statistics per basin with climatological comparison.
    Uses IBTrACS archive for historical counts/ACE and 30-year (1991-2020) averages.
    Active-now counts are merged from the live active-storms cache.
    """
    if not _ibtracs_storms:
        raise HTTPException(status_code=503, detail="IBTrACS data not loaded")

    summary = _compute_season_summary()
    return JSONResponse(
        content=summary,
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/storm/{atcf_id}/ir")
def get_storm_ir(
    atcf_id: str,
    product: str = Query("enhanced_ir", description="IR product type"),
    lookback_hours: float = Query(6.0, ge=1, le=24, description="Hours of lookback"),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0, description="Cutout radius in degrees"),
    interval_min: int = Query(30, ge=10, le=60, description="Minutes between frames"),
):
    """
    Fetch storm-centered IR animation frames from geostationary satellite.
    Returns array of base64-encoded PNG frames with timestamps.
    Automatically selects GOES-East/West or Himawari based on storm longitude.
    """
    # Find the storm in the active list
    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found in active list")

    center_lat = storm["lat"]
    center_lon = storm["lon"]
    box_deg = radius_deg * 2

    # Use current UTC as the end time so imagery is always fresh.
    # The last_fix_utc from JTWC/NHC can be hours old between advisories.
    center_dt = _dt.now(timezone.utc)

    frame_times = build_frame_times(center_dt, lookback_hours, interval_min)

    # Fetch frames (oldest first for animation order)
    frames = []
    for target_dt in reversed(frame_times):
        # Check cache
        cache_key = (atcf_id.upper(), target_dt.strftime("%Y%m%d%H%M"))
        if cache_key in _ir_frame_cache:
            _ir_frame_cache.move_to_end(cache_key)
            frames.append(_ir_frame_cache[cache_key])
            continue

        frame = fetch_ir_frame(center_lat, center_lon, target_dt, box_deg)
        if frame:
            frames.append(frame)
            # Cache the frame
            _ir_frame_cache[cache_key] = frame
            if len(_ir_frame_cache) > _IR_FRAME_CACHE_MAX:
                _ir_frame_cache.popitem(last=False)

        gc.collect()

    if not frames:
        raise HTTPException(
            status_code=502,
            detail="Could not retrieve any IR frames (satellite data may be temporarily unavailable)",
        )

    return JSONResponse(
        content={"frames": frames, "storm": storm},
        headers={"Cache-Control": "public, max-age=180"},
    )


@router.get("/storm/{atcf_id}/ir-raw")
def get_storm_ir_raw(
    atcf_id: str,
    lookback_hours: float = Query(6.0, ge=1, le=24, description="Hours of lookback"),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0, description="Cutout radius in degrees"),
    interval_min: int = Query(30, ge=10, le=60, description="Minutes between frames"),
):
    """
    Fetch storm-centered IR frames as raw Tb uint8 data for client-side colormap rendering.
    Returns base64-encoded uint8 arrays instead of pre-rendered PNGs.
    """
    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found in active list")

    center_lat = storm["lat"]
    center_lon = storm["lon"]
    box_deg = radius_deg * 2

    # Use current UTC so imagery is always fresh (not anchored to stale advisory time)
    center_dt = _dt.now(timezone.utc)

    frame_times = build_frame_times(center_dt, lookback_hours, interval_min)

    frames = []
    half = box_deg / 2.0
    for target_dt in reversed(frame_times):
        dt_str = target_dt.strftime("%Y%m%d%H%M")

        # Check GCS cache first
        cached = _gcs_rt_get(atcf_id.upper(), dt_str)
        if cached is not None:
            frames.append(cached)
            continue

        raw = fetch_ir_tb_raw(center_lat, center_lon, target_dt, box_deg)
        if raw and raw.get("tb") is not None:
            tb = raw["tb"]
            # Encode as uint8: 0 = invalid, 1-255 = Tb range
            arr = np.asarray(tb, dtype=np.float32)
            mask = ~np.isfinite(arr) | (arr <= 0)
            scaled = np.clip((arr - _TB_VMIN) * _TB_SCALE + 1, 1, 255)
            scaled[mask] = 0
            encoded = scaled.astype(np.uint8)

            frame_result = {
                "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
                "tb_rows": encoded.shape[0],
                "tb_cols": encoded.shape[1],
                "tb_vmin": _TB_VMIN,
                "tb_vmax": _TB_VMAX,
                "datetime_utc": raw["datetime_utc"],
                "satellite": raw.get("satellite", ""),
                "bounds": raw.get("bounds", [
                    [center_lat - half, center_lon - half],
                    [center_lat + half, center_lon + half],
                ]),
            }
            frames.append(frame_result)

            # Cache to GCS (fire-and-forget)
            _gcs_rt_put(atcf_id.upper(), dt_str, frame_result)

            del tb, arr, mask, scaled, encoded
            gc.collect()

    if not frames:
        raise HTTPException(
            status_code=502,
            detail="Could not retrieve any raw IR frames",
        )

    return JSONResponse(
        content={"frames": frames, "storm": storm},
        headers={"Cache-Control": "public, max-age=180"},
    )


@router.get("/storm/{atcf_id}/ir-raw-frame")
def get_storm_ir_raw_frame(
    atcf_id: str,
    frame_index: int = Query(0, ge=0, description="Frame index (0 = most recent)"),
    lookback_hours: float = Query(6.0, ge=1, le=24),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(30, ge=10, le=60),
):
    """
    Fetch a SINGLE raw Tb frame by index. Designed for incremental loading
    so the frontend can display frames as they arrive instead of waiting
    for all 13 at once.
    """
    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found")

    center_lat = storm["lat"]
    center_lon = storm["lon"]
    box_deg = radius_deg * 2
    center_dt = _dt.now(timezone.utc)

    frame_times = build_frame_times(center_dt, lookback_hours, interval_min)
    frame_times = list(reversed(frame_times))  # newest first (index 0 = most recent)

    if frame_index >= len(frame_times):
        raise HTTPException(status_code=400, detail=f"frame_index {frame_index} out of range")

    target_dt = frame_times[frame_index]
    dt_str = target_dt.strftime("%Y%m%d%H%M")
    half = box_deg / 2.0

    # Check GCS cache first
    cached = _gcs_rt_get(atcf_id.upper(), dt_str)
    if cached is not None:
        cached["frame_index"] = frame_index
        cached["total_frames"] = len(frame_times)
        return JSONResponse(
            content=cached,
            headers={"Cache-Control": "public, max-age=300"},
        )

    raw = fetch_ir_tb_raw(center_lat, center_lon, target_dt, box_deg)
    if not raw or raw.get("tb") is None:
        raise HTTPException(status_code=502, detail=f"No IR data for frame {frame_index}")

    tb = raw["tb"]
    arr = np.asarray(tb, dtype=np.float32)
    mask = ~np.isfinite(arr) | (arr <= 0)
    scaled = np.clip((arr - _TB_VMIN) * _TB_SCALE + 1, 1, 255)
    scaled[mask] = 0
    encoded = scaled.astype(np.uint8)

    frame_result = {
        "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
        "tb_rows": encoded.shape[0],
        "tb_cols": encoded.shape[1],
        "tb_vmin": _TB_VMIN,
        "tb_vmax": _TB_VMAX,
        "datetime_utc": raw["datetime_utc"],
        "satellite": raw.get("satellite", ""),
        "bounds": raw.get("bounds", [
            [center_lat - half, center_lon - half],
            [center_lat + half, center_lon + half],
        ]),
        "frame_index": frame_index,
        "total_frames": len(frame_times),
    }

    # Cache to GCS
    _gcs_rt_put(atcf_id.upper(), dt_str, frame_result)

    del tb, arr, mask, scaled, encoded
    gc.collect()

    return JSONResponse(
        content=frame_result,
        headers={"Cache-Control": "public, max-age=300"},
    )


# ---------------------------------------------------------------------------
# Pre-Rendered IR Frame JPG Endpoint (fast image-overlay animation)
# ---------------------------------------------------------------------------

def _gcs_jpg_get(atcf_id: str, dt_str: str) -> bytes | None:
    """Try to read a cached pre-rendered JPG from GCS."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return None
    key = f"{_GCS_RT_VERSION}/ir-jpg/{atcf_id}/{dt_str}.jpg"
    try:
        blob = bucket.blob(key)
        return blob.download_as_bytes(timeout=5)
    except Exception:
        return None


def _gcs_jpg_put(atcf_id: str, dt_str: str, jpg_bytes: bytes):
    """Write a pre-rendered JPG to GCS (fire-and-forget)."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return
    def _upload():
        key = f"{_GCS_RT_VERSION}/ir-jpg/{atcf_id}/{dt_str}.jpg"
        try:
            blob = bucket.blob(key)
            blob.upload_from_string(jpg_bytes, content_type="image/jpeg", timeout=15)
        except Exception:
            pass
    threading.Thread(target=_upload, daemon=True).start()


def _render_ir_jpg(tb_array: np.ndarray, quality: int = 75) -> bytes | None:
    """Render a raw Tb array to JPEG bytes using the enhanced IR colormap."""
    from PIL import Image

    arr = np.asarray(tb_array, dtype=np.float32)
    if not np.any(np.isfinite(arr)):
        return None

    # Same colormap as render_ir_png in satellite_ir.py
    frac = 1.0 - (arr - _TB_VMIN) / (_TB_VMAX - _TB_VMIN)
    frac = np.clip(frac, 0.0, 1.0)
    indices = (frac * 255).astype(np.uint8)

    # Use the same LUT as satellite_ir (import lazily)
    from satellite_ir import _IR_LUT
    rgba = _IR_LUT[indices]  # (H, W, 4)

    # NaN/invalid → black (JPG has no alpha)
    mask = ~np.isfinite(arr) | (arr <= 0)
    rgba[mask] = [0, 0, 0, 255]

    img = Image.fromarray(rgba, "RGBA").convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


@router.get("/storm/{atcf_id}/ir-frames-meta")
def get_ir_frames_meta(
    atcf_id: str,
    lookback_hours: float = Query(6.0, ge=1, le=24),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(30, ge=10, le=60),
):
    """Return frame metadata (times, bounds) without image data.

    Lets the frontend know how many frames exist and construct JPG URLs
    before fetching any images.
    """
    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found")

    center_lat = storm["lat"]
    center_lon = storm["lon"]
    half = radius_deg

    frame_times = build_frame_times(
        _dt.now(timezone.utc), lookback_hours, interval_min
    )
    frame_times = list(reversed(frame_times))  # newest first

    # Determine satellite
    bucket, sat_key = select_goes_sat(center_lon, _dt.now(timezone.utc))

    frames = []
    for i, ft in enumerate(frame_times):
        frames.append({
            "index": i,
            "datetime_utc": ft.strftime("%Y-%m-%dT%H:%M:%SZ"),
        })

    return JSONResponse(
        content={
            "frames": frames,
            "bounds": [
                [center_lat - half, center_lon - half],
                [center_lat + half, center_lon + half],
            ],
            "total_frames": len(frame_times),
            "satellite": satellite_name_from_bucket(bucket),
        },
        headers={"Cache-Control": "public, max-age=120"},
    )


@router.get("/storm/{atcf_id}/ir-frame.jpg")
def get_ir_frame_jpg(
    atcf_id: str,
    frame_index: int = Query(0, ge=0),
    lookback_hours: float = Query(6.0, ge=1, le=24),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(30, ge=10, le=60),
):
    """Return a pre-rendered IR frame as a JPEG image.

    Much faster than GIBS tile layers: single ~60KB image vs ~16 tiles.
    Metadata (bounds, time, satellite) is in response headers to avoid
    needing a separate metadata call.
    """
    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found")

    center_lat = storm["lat"]
    center_lon = storm["lon"]
    box_deg = radius_deg * 2
    half = radius_deg

    frame_times = build_frame_times(
        _dt.now(timezone.utc), lookback_hours, interval_min
    )
    frame_times = list(reversed(frame_times))  # newest first

    if frame_index >= len(frame_times):
        raise HTTPException(status_code=400, detail=f"frame_index {frame_index} out of range")

    target_dt = frame_times[frame_index]
    dt_str = target_dt.strftime("%Y%m%d%H%M")

    # Bounds for Leaflet overlay
    bounds = [
        [center_lat - half, center_lon - half],
        [center_lat + half, center_lon + half],
    ]
    bucket, _ = select_goes_sat(center_lon, target_dt)
    sat_name = satellite_name_from_bucket(bucket)

    # Common response headers with metadata
    meta_headers = {
        "Cache-Control": "public, max-age=300",
        "X-Frame-Index": str(frame_index),
        "X-Total-Frames": str(len(frame_times)),
        "X-Datetime": target_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "X-Satellite": sat_name,
        "X-Bounds": json.dumps(bounds),
        "Access-Control-Expose-Headers": "X-Frame-Index, X-Total-Frames, X-Datetime, X-Satellite, X-Bounds",
    }

    # Check GCS JPG cache
    cached_jpg = _gcs_jpg_get(atcf_id.upper(), dt_str)
    if cached_jpg:
        return Response(content=cached_jpg, media_type="image/jpeg", headers=meta_headers)

    # Fallback: check if raw Tb uint8 is cached in GCS (populated by pre-fetch)
    # and render JPG from it — avoids the S3 round-trip entirely.
    cached_raw = _gcs_rt_get(atcf_id.upper(), dt_str)
    if cached_raw is not None and cached_raw.get("tb_data"):
        try:
            encoded = np.frombuffer(
                base64.b64decode(cached_raw["tb_data"]), dtype=np.uint8
            ).reshape((cached_raw["tb_rows"], cached_raw["tb_cols"]))
            decoded_tb = ((encoded.astype(np.float32) - 1) / _TB_SCALE) + _TB_VMIN
            decoded_tb[encoded == 0] = np.nan
            jpg_bytes = _render_ir_jpg(decoded_tb)
            if jpg_bytes:
                _gcs_jpg_put(atcf_id.upper(), dt_str, jpg_bytes)
                return Response(content=jpg_bytes, media_type="image/jpeg", headers=meta_headers)
        except Exception:
            pass  # Fall through to S3 fetch

    # Render fresh from S3 satellite data
    raw = fetch_ir_tb_raw(center_lat, center_lon, target_dt, box_deg)
    if not raw or raw.get("tb") is None:
        raise HTTPException(status_code=502, detail=f"No IR data for frame {frame_index}")

    jpg_bytes = _render_ir_jpg(raw["tb"])
    if not jpg_bytes:
        raise HTTPException(status_code=502, detail="IR rendering failed")

    # Cache to GCS
    _gcs_jpg_put(atcf_id.upper(), dt_str, jpg_bytes)

    del raw
    gc.collect()

    return Response(content=jpg_bytes, media_type="image/jpeg", headers=meta_headers)


def _write_geotiff_bytes(tb_array: np.ndarray, bounds: list) -> bytes:
    """
    Write a float32 brightness temperature array as a minimal GeoTIFF (WGS84).
    Uses Pillow for TIFF structure + manual GeoTIFF tags. No GDAL/rasterio needed.

    bounds: [[south, west], [north, east]]
    Returns raw bytes of the .tif file.
    """
    import struct
    from PIL import Image

    rows, cols = tb_array.shape
    south, west = bounds[0]
    north, east = bounds[1]

    # Pixel scale: degrees per pixel
    scale_x = (east - west) / cols
    scale_y = (north - south) / rows

    # Convert to Pillow image (mode 'F' = float32)
    img = Image.fromarray(tb_array.astype(np.float32), mode='F')

    # GeoTIFF tags
    # 33550: ModelPixelScaleTag — (scaleX, scaleY, 0.0) as doubles
    model_pixel_scale = struct.pack('<3d', scale_x, scale_y, 0.0)

    # 33922: ModelTiepointTag — (col, row, 0, lon, lat, 0) as doubles
    # Ties pixel (0,0) to the upper-left corner (north-west)
    model_tiepoint = struct.pack('<6d', 0.0, 0.0, 0.0, west, north, 0.0)

    # 34735: GeoKeyDirectoryTag — array of unsigned shorts
    # Header: KeyDirectoryVersion=1, KeyRevision=1, MinorRevision=0, NumberOfKeys=3
    # Key 1024: GTModelTypeGeoKey = 2 (Geographic)
    # Key 1025: GTRasterTypeGeoKey = 1 (PixelIsArea)
    # Key 2048: GeographicTypeGeoKey = 4326 (WGS84)
    geo_keys = struct.pack('<16H',
        1, 1, 0, 3,         # header
        1024, 0, 1, 2,      # GTModelTypeGeoKey = Geographic
        1025, 0, 1, 1,      # GTRasterTypeGeoKey = PixelIsArea
        2048, 0, 1, 4326,   # GeographicTypeGeoKey = WGS84 / EPSG:4326
    )

    # Save with custom TIFF tags
    buf = io.BytesIO()
    tiffinfo = {
        33550: model_pixel_scale,
        33922: model_tiepoint,
        34735: geo_keys,
    }

    # Pillow TiffImagePlugin tag types: 7 = UNDEFINED (raw bytes)
    from PIL.TiffImagePlugin import ImageFileDirectory_v2
    ifd = ImageFileDirectory_v2()
    ifd.tagtype[33550] = 12   # DOUBLE
    ifd.tagtype[33922] = 12   # DOUBLE
    ifd.tagtype[34735] = 3    # SHORT

    # For DOUBLE tags, Pillow expects tuples of floats
    ifd[33550] = (scale_x, scale_y, 0.0)
    ifd[33922] = (0.0, 0.0, 0.0, west, north, 0.0)
    # For SHORT array, Pillow expects tuple of ints
    ifd[34735] = (1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326)

    img.save(buf, format='TIFF', tiffinfo=ifd)
    return buf.getvalue()


@router.get("/storm/{atcf_id}/geotiff")
def get_storm_geotiff(
    atcf_id: str,
    frame_index: int = Query(0, ge=0, description="Which frame to export (0 = most recent)"),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0, description="Cutout radius in degrees"),
):
    """
    Export a single IR frame as a GeoTIFF file with brightness temperature (K).
    The file is georeferenced to WGS84 (EPSG:4326) and can be opened in
    QGIS, ArcGIS, Google Earth Pro, or any GIS software.
    """
    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found")

    center_lat = storm["lat"]
    center_lon = storm["lon"]
    box_deg = radius_deg * 2

    try:
        center_dt = _dt.fromisoformat(storm["last_fix_utc"].replace("Z", "+00:00"))
    except Exception:
        center_dt = _dt.now(timezone.utc)

    # Build frame times (30 min interval, 6h lookback)
    frame_times = build_frame_times(center_dt, 6.0, 30)
    frame_times = list(reversed(frame_times))  # newest first

    if frame_index >= len(frame_times):
        raise HTTPException(status_code=400, detail=f"frame_index {frame_index} out of range (max {len(frame_times)-1})")

    target_dt = frame_times[frame_index]

    raw = fetch_ir_tb_raw(center_lat, center_lon, target_dt, box_deg)
    if not raw or raw.get("tb") is None:
        raise HTTPException(status_code=502, detail="Could not fetch IR data for this frame")

    tb = np.asarray(raw["tb"], dtype=np.float32)
    # Replace invalid values with NaN
    tb[~np.isfinite(tb) | (tb <= 0)] = np.nan

    bounds = raw.get("bounds", [
        [center_lat - radius_deg, center_lon - radius_deg],
        [center_lat + radius_deg, center_lon + radius_deg],
    ])

    tiff_bytes = _write_geotiff_bytes(tb, bounds)

    name = storm.get("name", "UNNAMED").replace(" ", "_")
    dt_str = target_dt.strftime("%Y%m%d_%H%MZ")
    filename = f"{name}_{atcf_id.upper()}_{dt_str}_Tb.tif"

    return Response(
        content=tiff_bytes,
        media_type="image/tiff",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "public, max-age=3600",
        },
    )


@router.get("/storm/{atcf_id}/metadata")
def get_storm_metadata(atcf_id: str):
    """
    Return storm metadata including intensity history from A-deck/B-deck.
    """
    # Try B-deck first (more authoritative), fall back to A-deck
    records = _fetch_bdeck(atcf_id.lower())
    if not records:
        records = _fetch_adeck(atcf_id.lower())

    if not records:
        raise HTTPException(status_code=404, detail=f"No data found for {atcf_id}")

    # Build intensity history from tau=0 records
    t0_records = [r for r in records if r["tau"] == 0]
    if not t0_records:
        # Fall back to CARQ records
        t0_records = [r for r in records if r["tech"] == "CARQ"]

    # Deduplicate by datetime (keep last occurrence)
    seen_times: dict = {}
    for r in t0_records:
        key = r["datetime"].strftime("%Y%m%d%H")
        seen_times[key] = r

    intensity_history = []
    for key in sorted(seen_times.keys()):
        r = seen_times[key]
        intensity_history.append({
            "time": r["datetime"].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "vmax_kt": r["vmax_kt"],
            "mslp_hpa": r["mslp_hpa"],
            "lat": r["lat"],
            "lon": r["lon"],
        })

    # ── Guard against reused invest numbers (e.g. SH98) ──
    # JTWC B-decks can contain multiple disturbances under the same
    # invest designator across a season.  Detect large temporal gaps
    # (>72 h) OR large spatial jumps (>8° great-circle) and keep only
    # the most recent continuous segment.
    if len(intensity_history) >= 2:
        _GAP_HOURS = 72
        _MAX_JUMP_DEG = 8.0  # ~900 km — far exceeds any 6-hourly TC motion
        last_seg_start = 0
        for i in range(1, len(intensity_history)):
            t_prev = _dt.fromisoformat(intensity_history[i - 1]["time"].replace("Z", "+00:00"))
            t_curr = _dt.fromisoformat(intensity_history[i]["time"].replace("Z", "+00:00"))
            time_gap = (t_curr - t_prev) > timedelta(hours=_GAP_HOURS)

            # Spatial jump check
            prev_pt = intensity_history[i - 1]
            curr_pt = intensity_history[i]
            spatial_jump = _haversine_deg(
                prev_pt["lat"], prev_pt["lon"],
                curr_pt["lat"], curr_pt["lon"]
            ) > _MAX_JUMP_DEG

            if time_gap or spatial_jump:
                last_seg_start = i
        if last_seg_start > 0:
            intensity_history = intensity_history[last_seg_start:]

    # Get current storm info from active cache
    current = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                current = dict(s)
                break

    # Build forecast track from OFCL records
    forecast_track = []
    ofcl_records = [r for r in records if r["tech"] == "OFCL" and r["tau"] > 0]
    if ofcl_records:
        # Get the most recent OFCL forecast
        latest_init = max(r["datetime"] for r in ofcl_records)
        latest_fcst = [r for r in ofcl_records if r["datetime"] == latest_init]
        latest_fcst.sort(key=lambda r: r["tau"])
        for r in latest_fcst:
            forecast_track.append({
                "tau_h": r["tau"],
                "lat": r["lat"],
                "lon": r["lon"],
                "vmax_kt": r["vmax_kt"],
            })

    result = {
        "atcf_id": atcf_id.upper(),
        "current": current,
        "intensity_history": intensity_history,
        "forecast_track": forecast_track,
        "has_recon": False,  # TODO: cross-ref with Real-Time TDR
    }

    return JSONResponse(
        content=result,
        headers={"Cache-Control": "public, max-age=300"},
    )


# ---------------------------------------------------------------------------
# IR Vigor Endpoint
# ---------------------------------------------------------------------------

@router.get("/storm/{atcf_id}/ir-vigor")
def get_storm_ir_vigor(
    atcf_id: str,
    lookback_hours: float = Query(4.0, ge=1, le=8, description="Hours of Tb frames for temporal average"),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0, description="Cutout radius in degrees"),
    radius_km: float = Query(200.0, ge=50, le=600, description="Spatial radius (km) for local minimum"),
    interval_min: int = Query(30, ge=10, le=60, description="Minutes between frames"),
):
    """
    Compute and return a spatially-aware IR vigor image for a storm.

    Vigor = current_Tb − local_min(temporal_avg_Tb), where local_min
    is computed within `radius_km` of each grid point.  The temporal
    average spans the past `lookback_hours` at `interval_min` intervals.

    Returns a single base64-encoded PNG frame with a diverging colormap.
    """
    try:
        return _compute_vigor_inner(
            atcf_id, lookback_hours, radius_deg, radius_km, interval_min
        )
    except HTTPException:
        raise
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Vigor computation error: {type(exc).__name__}: {exc}",
        )


def _compute_vigor_inner(
    atcf_id: str,
    lookback_hours: float,
    radius_deg: float,
    radius_km: float,
    interval_min: int,
):
    """Inner implementation for vigor — separated so the outer handler can
    catch any uncaught exceptions and return a clean 500 instead of crashing
    the Cloud Run container (which surfaces as a 502 gateway error)."""

    # Find the storm in the active list
    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found in active list")

    center_lat = storm["lat"]
    center_lon = storm["lon"]
    box_deg = radius_deg * 2

    # Parse the last fix time as the animation center
    try:
        center_dt = _dt.fromisoformat(storm["last_fix_utc"].replace("Z", "+00:00"))
    except Exception:
        center_dt = _dt.now(timezone.utc)

    # Build frame times for the temporal average (past N hours)
    frame_times = build_frame_times(center_dt, lookback_hours, interval_min)
    print(f"[ir-vigor] {atcf_id}: fetching {len(frame_times)} frames, "
          f"center={center_lat:.1f},{center_lon:.1f}, box={box_deg}°")

    # Fetch raw Tb arrays (oldest first), stop early once we have enough
    raw_frames = []
    fetch_errors = 0
    for target_dt in reversed(frame_times):
        try:
            result = fetch_ir_tb_raw(center_lat, center_lon, target_dt, box_deg)
            if result:
                raw_frames.append(result)
                print(f"[ir-vigor]   frame {target_dt.strftime('%H:%MZ')}: OK "
                      f"({result['tb'].shape})")
            else:
                fetch_errors += 1
                print(f"[ir-vigor]   frame {target_dt.strftime('%H:%MZ')}: "
                      f"no data")
        except Exception as exc:
            fetch_errors += 1
            print(f"[ir-vigor]   frame {target_dt.strftime('%H:%MZ')}: "
                  f"ERROR {type(exc).__name__}: {exc}")
        gc.collect()

    print(f"[ir-vigor] {atcf_id}: {len(raw_frames)} frames fetched, "
          f"{fetch_errors} failed")

    if len(raw_frames) < 2:
        raise HTTPException(
            status_code=503,
            detail=(f"Only {len(raw_frames)} of {len(frame_times)} IR frames "
                    f"available ({fetch_errors} failed) — need at least 2 for vigor. "
                    f"Satellite data may be temporarily unavailable."),
        )

    # Extract Tb arrays (ordered oldest → newest)
    tb_arrays = [f["tb"] for f in raw_frames]

    # Resample all arrays to the same shape as the last (current) frame
    # (minor size differences can occur between satellite scan times)
    target_shape = tb_arrays[-1].shape
    resampled = []
    for tb in tb_arrays:
        if tb.shape == target_shape:
            resampled.append(tb)
        else:
            # Simple nearest-neighbour resize
            from PIL import Image
            img = Image.fromarray(tb)
            img_resized = img.resize((target_shape[1], target_shape[0]),
                                     Image.NEAREST)
            resampled.append(np.array(img_resized, dtype=np.float32))
    tb_arrays = resampled

    # Compute vigor
    print(f"[ir-vigor] {atcf_id}: computing vigor with {len(tb_arrays)} frames, "
          f"radius={radius_km}km")
    vigor = compute_ir_vigor(tb_arrays, radius_km=radius_km, box_deg=box_deg)
    if vigor is None:
        raise HTTPException(status_code=500, detail="Vigor computation returned None")

    # Render to PNG
    png_b64 = render_vigor_png(vigor)
    n_frames_used = len(tb_arrays)
    vigor_satellite = raw_frames[-1].get("satellite", "Unknown") if raw_frames else storm.get("satellite", "Unknown")
    del vigor, tb_arrays, raw_frames, resampled
    gc.collect()

    if not png_b64:
        raise HTTPException(status_code=500, detail="Vigor rendering failed")

    half = box_deg / 2.0

    return JSONResponse(
        content={
            "image_b64": png_b64,
            "datetime_utc": center_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "satellite": vigor_satellite,
            "bounds": [
                [center_lat - half, center_lon - half],
                [center_lat + half, center_lon + half],
            ],
            "storm_center": {"lat": center_lat, "lon": center_lon},
            "frames_used": n_frames_used,
            "lookback_hours": lookback_hours,
            "radius_km": radius_km,
        },
        headers={"Cache-Control": "public, max-age=300"},
    )


# ---------------------------------------------------------------------------
# DeepMind WeatherLab Ensemble Forecasts
# ---------------------------------------------------------------------------
# Fetches tropical cyclone ensemble forecasts from Google DeepMind's
# WeatherLab (FNV3 model). Public CSV endpoint, no authentication required.
# Data includes 50 ensemble members + ensemble mean with 6-hourly positions,
# MSLP, Vmax, RMW, and wind radii out to ~13 days.

_WEATHERLAB_BASE = (
    "https://deepmind.google.com/science/weatherlab/download/cyclones/FNV3"
)
_weatherlab_cache: dict = {}   # (date_str, hour_str) -> {"data": {...}, "ts": float}
_WEATHERLAB_CACHE_TTL = 7200   # 2 hours (CSV only changes every 6h)
_WEATHERLAB_CACHE_MAX = 4


def _parse_lead_time(lead_str: str) -> float:
    """Parse WeatherLab lead_time like '2 days 06:00:00' -> tau hours."""
    lead_str = lead_str.strip()
    days = 0
    time_part = lead_str
    if "days" in lead_str or "day" in lead_str:
        parts = lead_str.split(" ", 2)
        days = int(parts[0])
        time_part = parts[2] if len(parts) > 2 else "00:00:00"
    elif lead_str.startswith("0 "):
        time_part = lead_str.split(" ", 2)[-1]

    hms = time_part.split(":")
    hours = int(hms[0]) if hms else 0
    return days * 24.0 + hours


def _fetch_weatherlab_csv(date_str: str, hour_str: str) -> dict | None:
    """Fetch and parse WeatherLab ensemble CSV for a given init time.

    Returns dict keyed by track_id (ATCF ID), each containing:
      { "members": { "0": {"points": [...]}, ... }, "ensemble_mean": {...} }
    """
    cache_key = (date_str, hour_str)
    cached = _weatherlab_cache.get(cache_key)
    if cached and time.time() - cached["ts"] < _WEATHERLAB_CACHE_TTL:
        return cached["data"]

    import requests as req

    # Fetch ensemble members
    date_fmt = date_str.replace("-", "_")
    ens_url = (
        f"{_WEATHERLAB_BASE}/ensemble/paired/csv/"
        f"FNV3_{date_fmt}T{hour_str}_00_paired.csv"
    )
    mean_url = (
        f"{_WEATHERLAB_BASE}/ensemble_mean/paired/csv/"
        f"FNV3_{date_fmt}T{hour_str}_00_paired.csv"
    )

    try:
        ens_resp = req.get(ens_url, timeout=30)
        if ens_resp.status_code != 200:
            return None
        ens_text = ens_resp.text
    except Exception as e:
        print(f"[WeatherLab] Ensemble fetch failed: {e}")
        return None

    # Parse ensemble CSV
    result: dict = {}
    header = None
    for line in ens_text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        if header is None:
            header = [h.strip() for h in line.split(",")]
            continue

        cols = line.split(",")
        if len(cols) < 9:
            continue

        track_id = cols[1].strip()
        sample = cols[2].strip()
        try:
            sample_int = int(float(sample))
        except (ValueError, TypeError):
            continue

        tau = _parse_lead_time(cols[4])
        try:
            lat = round(float(cols[5]), 2)
            lon = round(float(cols[6]), 2)
            pres = round(float(cols[7]), 1) if cols[7].strip() else None
            wind = round(float(cols[8]), 1) if cols[8].strip() else None
        except (ValueError, IndexError):
            continue

        point = {"tau": tau, "lat": lat, "lon": lon, "wind": wind, "pres": pres}

        if track_id not in result:
            result[track_id] = {"members": {}, "ensemble_mean": None}

        member_key = str(sample_int)
        storm = result[track_id]
        if member_key not in storm["members"]:
            storm["members"][member_key] = {"points": []}
        storm["members"][member_key]["points"].append(point)

    # Fetch ensemble mean
    try:
        mean_resp = req.get(mean_url, timeout=20)
        if mean_resp.status_code == 200:
            mean_header = None
            for line in mean_resp.text.splitlines():
                if line.startswith("#") or not line.strip():
                    continue
                if mean_header is None:
                    mean_header = True
                    continue

                cols = line.split(",")
                if len(cols) < 9:
                    continue

                track_id = cols[1].strip()
                tau = _parse_lead_time(cols[4])
                try:
                    lat = round(float(cols[5]), 2)
                    lon = round(float(cols[6]), 2)
                    pres = round(float(cols[7]), 1) if cols[7].strip() else None
                    wind = round(float(cols[8]), 1) if cols[8].strip() else None
                except (ValueError, IndexError):
                    continue

                if track_id in result:
                    if result[track_id]["ensemble_mean"] is None:
                        result[track_id]["ensemble_mean"] = {"points": []}
                    result[track_id]["ensemble_mean"]["points"].append(
                        {"tau": tau, "lat": lat, "lon": lon,
                         "wind": wind, "pres": pres}
                    )
    except Exception:
        pass

    # Cache
    _weatherlab_cache[cache_key] = {"data": result, "ts": time.time()}
    if len(_weatherlab_cache) > _WEATHERLAB_CACHE_MAX:
        oldest = min(_weatherlab_cache, key=lambda k: _weatherlab_cache[k]["ts"])
        del _weatherlab_cache[oldest]

    print(f"[WeatherLab] Parsed {len(result)} storms from {date_str} {hour_str}z")
    return result


@router.get("/storm/{atcf_id}/weatherlab")
def get_storm_weatherlab(atcf_id: str):
    """Fetch DeepMind WeatherLab ensemble forecasts for a storm.

    Returns 50 ensemble member tracks + ensemble mean with position,
    intensity, and pressure at 6-hourly intervals out to ~13 days.
    """
    atcf_id = atcf_id.upper().strip()

    # Try latest available init times: today 06z, 00z, then yesterday
    now = _dt.now(timezone.utc)
    candidates = []
    for day_offset in (0, 1):
        dt = now - timedelta(days=day_offset)
        date_str = dt.strftime("%Y-%m-%d")
        for hour in ("18", "12", "06", "00"):
            candidates.append((date_str, hour))

    data = None
    used_date = None
    used_hour = None
    for date_str, hour_str in candidates:
        data = _fetch_weatherlab_csv(date_str, hour_str)
        if data and atcf_id in data:
            used_date = date_str
            used_hour = hour_str
            break

    if not data or atcf_id not in data:
        raise HTTPException(
            status_code=404,
            detail=f"WeatherLab data not found for {atcf_id}",
        )

    storm = data[atcf_id]
    init_time = used_date.replace("-", "") + used_hour

    # Build lead_times list from member 0
    lead_times = []
    m0 = storm["members"].get("0")
    if m0:
        lead_times = sorted(set(p["tau"] for p in m0["points"]))

    return JSONResponse(
        content={
            "model": "DeepMind FNV3",
            "init_time": init_time,
            "members": storm["members"],
            "ensemble_mean": storm["ensemble_mean"],
            "n_members": len(storm["members"]),
            "lead_times_h": lead_times,
        },
        headers={"Cache-Control": "public, max-age=900"},
    )


# ---------------------------------------------------------------------------
# DeepMind 1000-Member Large Ensemble (Intensity Distributions)
# ---------------------------------------------------------------------------

_WEATHERLAB_LARGE_BASE = (
    "https://deepmind.google.com/science/weatherlab/download/cyclones/"
    "FNV3_LARGE_ENSEMBLE"
)
_weatherlab_large_cache: dict = {}  # (date, hour) -> {"data": ..., "ts": float}
_WEATHERLAB_LARGE_CACHE_TTL = 7200  # 2 hours (CSV only changes every 6h)


def _fetch_weatherlab_large_csv(date_str: str, hour_str: str,
                                target_track: str | None = None) -> dict | None:
    """Fetch and parse the 1000-member ensemble CSV.

    To save memory, only parses rows matching target_track if provided.
    Returns dict keyed by track_id with per-member wind/pres arrays per tau.
    """
    cache_key = (date_str, hour_str, target_track or "ALL")
    cached = _weatherlab_large_cache.get(cache_key)
    if cached and time.time() - cached["ts"] < _WEATHERLAB_LARGE_CACHE_TTL:
        return cached["data"]

    import requests as req

    date_fmt = date_str.replace("-", "_")
    url = (
        f"{_WEATHERLAB_LARGE_BASE}/ensemble/paired/csv/"
        f"FNV3_LARGE_ENSEMBLE_{date_fmt}T{hour_str}_00_paired.csv"
    )

    try:
        print(f"[WeatherLab 1K] Fetching {date_str} {hour_str}z ...")
        resp = req.get(url, timeout=60, stream=True)
        if resp.status_code != 200:
            return None
    except Exception as e:
        print(f"[WeatherLab 1K] Fetch failed: {e}")
        return None

    # Parse: collect per-(track, member) → list of {tau, wind, pres}
    # Then reorganise into per-track, per-tau → arrays of winds
    track_target_upper = target_track.upper() if target_track else None

    # Per-member time series: {track_id: {member_int: {tau: {wind, pres}}}}
    member_series: dict = {}
    header_seen = False

    for line in resp.iter_lines(decode_unicode=True):
        if not line or line.startswith("#"):
            continue
        if not header_seen:
            header_seen = True
            continue

        cols = line.split(",")
        if len(cols) < 9:
            continue

        track_id = cols[1].strip()
        if track_target_upper and track_id != track_target_upper:
            continue

        try:
            member = int(float(cols[2].strip()))
            tau = _parse_lead_time(cols[4])
            wind = round(float(cols[8]), 1) if cols[8].strip() else None
            pres = round(float(cols[7]), 1) if cols[7].strip() else None
        except (ValueError, IndexError):
            continue

        if track_id not in member_series:
            member_series[track_id] = {}
        if member not in member_series[track_id]:
            member_series[track_id][member] = {}
        member_series[track_id][member][tau] = {"wind": wind, "pres": pres}

    # Reorganise into per-tau arrays
    result = {}
    for track_id, members in member_series.items():
        all_taus = set()
        for m_data in members.values():
            all_taus.update(m_data.keys())
        sorted_taus = sorted(all_taus)

        # Intensity at each tau: arrays of 1000 values
        intensity = {}
        for tau in sorted_taus:
            winds = []
            pressures = []
            for m in sorted(members.keys()):
                pt = members[m].get(tau)
                if pt:
                    winds.append(pt["wind"])
                    pressures.append(pt["pres"])
                else:
                    winds.append(None)
                    pressures.append(None)
            intensity[str(int(tau))] = {"winds": winds, "pres": pressures}

        # Intensity change: dV over 12h and 24h
        change_12h = {}
        change_24h = {}
        for tau in sorted_taus:
            tau_str = str(int(tau))
            # 12h change
            prev_12 = tau - 12
            if prev_12 in all_taus:
                dv = []
                for m in sorted(members.keys()):
                    curr = members[m].get(tau)
                    prev = members[m].get(prev_12)
                    if curr and prev and curr["wind"] is not None and prev["wind"] is not None:
                        dv.append(round(curr["wind"] - prev["wind"], 1))
                    else:
                        dv.append(None)
                change_12h[tau_str] = {"dv": dv}
            # 24h change
            prev_24 = tau - 24
            if prev_24 in all_taus:
                dv = []
                for m in sorted(members.keys()):
                    curr = members[m].get(tau)
                    prev = members[m].get(prev_24)
                    if curr and prev and curr["wind"] is not None and prev["wind"] is not None:
                        dv.append(round(curr["wind"] - prev["wind"], 1))
                    else:
                        dv.append(None)
                change_24h[tau_str] = {"dv": dv}

        result[track_id] = {
            "lead_times_h": sorted_taus,
            "n_members": len(members),
            "intensity": intensity,
            "intensity_change_12h": change_12h,
            "intensity_change_24h": change_24h,
        }

    # Cache
    _weatherlab_large_cache[cache_key] = {"data": result, "ts": time.time()}
    # Evict oldest if too many
    if len(_weatherlab_large_cache) > 4:
        oldest = min(_weatherlab_large_cache,
                     key=lambda k: _weatherlab_large_cache[k]["ts"])
        del _weatherlab_large_cache[oldest]

    print(f"[WeatherLab 1K] Parsed {len(result)} storms, "
          f"{sum(r['n_members'] for r in result.values())} total members")
    return result


@router.get("/storm/{atcf_id}/weatherlab-ensemble")
def get_storm_weatherlab_ensemble(atcf_id: str):
    """Fetch 1000-member ensemble intensity distributions from WeatherLab.

    Returns per-lead-time arrays of wind speeds and intensity changes
    for histogram rendering. Data is cached server-side so users never
    download the full 20MB CSV.
    """
    atcf_id = atcf_id.upper().strip()

    now = _dt.now(timezone.utc)
    candidates = []
    for day_offset in (0, 1):
        dt = now - timedelta(days=day_offset)
        date_str = dt.strftime("%Y-%m-%d")
        for hour in ("18", "12", "06", "00"):
            candidates.append((date_str, hour))

    data = None
    used_date = None
    used_hour = None
    for date_str, hour_str in candidates:
        # Fetch ALL storms (no filter) so the full CSV is cached for all
        # subsequent per-storm requests within the TTL window.
        data = _fetch_weatherlab_large_csv(date_str, hour_str,
                                           target_track=None)
        if data and atcf_id in data:
            used_date = date_str
            used_hour = hour_str
            break

    if not data or atcf_id not in data:
        raise HTTPException(
            status_code=404,
            detail=f"WeatherLab 1000-member data not found for {atcf_id}",
        )

    storm = data[atcf_id]
    init_time = used_date.replace("-", "") + used_hour

    return JSONResponse(
        content={
            "model": "DeepMind FNV3 (1000 members)",
            "init_time": init_time,
            "n_members": storm["n_members"],
            "lead_times_h": storm["lead_times_h"],
            "intensity": storm["intensity"],
            "intensity_change_12h": storm["intensity_change_12h"],
            "intensity_change_24h": storm["intensity_change_24h"],
        },
        headers={"Cache-Control": "public, max-age=1800"},
    )
