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
from fastapi.responses import JSONResponse

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

# Basins already covered by NHC (skip in JTWC scan)
_NHC_BASINS = {"EP", "CP", "AL"}

# Cache settings
_STORM_CACHE_TTL = 300          # 5 minutes (matches Cloud Scheduler ping interval)
_IR_FRAME_CACHE_MAX = 200       # max cached IR frames (covers ~15 storms)
_IR_FRAME_CACHE_TTL = 300       # 5 minutes per frame

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

    # Fall back to JTWC B-deck
    return _fetch_jtwc_bdeck(atcf_id)


def _get_latest_position(records: list) -> Optional[dict]:
    """
    From A-deck records, get the most recent CARQ or OFCL fix at tau=0.
    Falls back to the most recent tau=0 record from any technique.
    """
    # Filter to tau=0 (current position, not forecasts)
    t0_records = [r for r in records if r["tau"] == 0]
    if not t0_records:
        return None

    # Prefer CARQ (combined ARQ), then OFCL (official NHC forecast)
    for preferred_tech in ["CARQ", "OFCL"]:
        tech_records = [r for r in t0_records if r["tech"] == preferred_tech]
        if tech_records:
            return tech_records[-1]  # most recent

    # Fallback: most recent tau=0 from any technique
    return t0_records[-1]


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

        records = _fetch_jtwc_bdeck(storm_id, bdeck_url)
        if not records:
            print(f"[IR Monitor] JTWC {storm_id}: no B-deck records from {bdeck_url}")
            continue

        latest = _get_latest_position(records)
        if not latest:
            print(f"[IR Monitor] JTWC {storm_id}: no tau=0 position in {len(records)} records")
            continue
        age = now - latest["datetime"]
        if age > timedelta(hours=48):  # JTWC B-decks update less frequently
            print(f"[IR Monitor] JTWC {storm_id}: stale — last fix {latest['datetime']} ({age} ago)")
            continue

        # Try to extract storm name from the raw B-deck text
        raw_text = _http_get(bdeck_url, timeout=10)
        name = _extract_storm_name(raw_text) if raw_text else None

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
_PREFETCH_RADIUS_DEG = 3.0
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
        for storm in storms:
            atcf_id = storm["atcf_id"]
            center_lat = storm["lat"]
            center_lon = storm["lon"]
            box_deg = _PREFETCH_RADIUS_DEG * 2

            try:
                center_dt = _dt.fromisoformat(
                    storm["last_fix_utc"].replace("Z", "+00:00")
                )
            except Exception:
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

        print(f"[IR Pre-fetch] Done — {total_fetched} new frames fetched, "
              f"{total_cached} already cached")
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
    radius_deg: float = Query(3.0, ge=1.0, le=8.0, description="Cutout radius in degrees"),
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

    # Parse the last fix time as the animation center
    try:
        center_dt = _dt.fromisoformat(storm["last_fix_utc"].replace("Z", "+00:00"))
    except Exception:
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
    radius_deg: float = Query(3.0, ge=1.0, le=8.0, description="Cutout radius in degrees"),
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
