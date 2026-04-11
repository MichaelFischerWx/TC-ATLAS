"""
ascat_api.py — ASCAT Scatterometer Wind Data API
==================================================
Provides endpoints for overlaying ASCAT ocean surface wind observations
on the Real-Time IR Monitor:
  - GET /ascat/passes     — List recent ASCAT passes near a storm
  - GET /ascat/winds      — Get wind vectors for a specific pass

Data source: NASA PO.DAAC (ASCATB-L2-25km, ASCATC-L2-25km) via
CMR granule discovery + OPeNDAP geographic subsetting.

How to integrate (in tc_radar_api.py):
    from ascat_api import router as ascat_router
    app.include_router(ascat_router, prefix="/ascat")
"""

import gc
import logging
import os
import threading
import time
from collections import OrderedDict
from datetime import datetime as _dt, timedelta, timezone
from typing import List, Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

logger = logging.getLogger("ascat_api")
logger.setLevel(logging.INFO)

router = APIRouter(tags=["ascat"])

# ─── Configuration ──────────────────────────────────────────────────────

# CMR collection concept IDs for ASCAT L2 25km wind vectors
_CMR_COLLECTIONS = {
    "MetOp-B": "C2075141559-POCLOUD",
    "MetOp-C": "C2075141638-POCLOUD",
}

_CMR_SEARCH_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"

# Earthdata credentials (for OPeNDAP access)
_EARTHDATA_USER = os.environ.get("EARTHDATA_USERNAME", "") or os.environ.get("EARTHDATA_USER", "")
_EARTHDATA_PASS = os.environ.get("EARTHDATA_PASSWORD", "") or os.environ.get("EARTHDATA_PASS", "")
_EARTHDATA_TOKEN = os.environ.get("EARTHDATA_TOKEN", "")

# Cache settings
_PASS_CACHE_TTL = 900       # 15 minutes
_WIND_CACHE_MAX = 50        # max cached wind results
_WIND_CACHE_TTL = 3600      # 1 hour

# ─── Import active storms cache from ir_monitor_api ──────────────────

_active_storms_ref = None

def _get_storm_position(atcf_id: str) -> Optional[dict]:
    """Look up storm lat/lon from the active-storms cache."""
    global _active_storms_ref
    if _active_storms_ref is None:
        try:
            from ir_monitor_api import _active_storms_cache
            _active_storms_ref = _active_storms_cache
        except ImportError:
            return None
    storms = _active_storms_ref.get("storms", [])
    for s in storms:
        if s.get("atcf_id", "").upper() == atcf_id.upper():
            return {"lat": s["lat"], "lon": s["lon"], "name": s.get("name", "")}
    return None


# ─── CMR Granule Discovery ──────────────────────────────────────────────

_pass_cache: dict = {}  # { (atcf_id, hour_key): { "expires": float, "data": [...] } }
_pass_cache_lock = threading.Lock()

def _search_cmr_granules(
    center_lat: float, center_lon: float,
    hours_back: float = 12.0, radius_deg: float = 10.0,
) -> List[dict]:
    """
    Query NASA CMR for ASCAT L2 granules overlapping the storm region.
    Returns list of dicts with satellite, datetime, granule_id, opendap_url.
    """
    import requests

    now = _dt.now(timezone.utc)
    start = now - timedelta(hours=hours_back)

    # Bounding box: west, south, east, north
    west = center_lon - radius_deg
    east = center_lon + radius_deg
    south = center_lat - radius_deg
    north = center_lat + radius_deg

    # Wrap longitude for dateline crossing
    if west < -180:
        west += 360
    if east > 180:
        east -= 360

    results = []

    for sat_name, concept_id in _CMR_COLLECTIONS.items():
        params = {
            "collection_concept_id": concept_id,
            "temporal": f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')},{now.strftime('%Y-%m-%dT%H:%M:%SZ')}",
            "bounding_box": f"{west},{south},{east},{north}",
            "sort_key": "-start_date",
            "page_size": 20,
        }

        try:
            resp = requests.get(_CMR_SEARCH_URL, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            logger.warning("CMR search failed for %s: %s", sat_name, e)
            continue

        entries = data.get("feed", {}).get("entry", [])
        for entry in entries:
            granule_id = entry.get("id", "")
            title = entry.get("title", "")

            # Extract datetime from title or time_start
            time_start = entry.get("time_start", "")
            time_end = entry.get("time_end", "")
            try:
                dt_start = _dt.strptime(time_start, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
            except (ValueError, AttributeError):
                continue

            # Find OPeNDAP URL from links — must contain the full
            # collection/granule path (not just the base OPeNDAP URL)
            opendap_url = None
            download_url = None
            for link in entry.get("links", []):
                href = link.get("href", "")
                rel = link.get("rel", "")
                if "opendap" in href.lower() and "/granules/" in href:
                    opendap_url = href
                elif rel == "http://esipfed.org/ns/fedsearch/1.1/data#" and \
                     href.endswith(".nc"):
                    download_url = href

            results.append({
                "satellite": sat_name,
                "datetime_utc": dt_start.strftime("%Y-%m-%d %H:%M UTC"),
                "datetime_iso": dt_start.isoformat(),
                "time_start": time_start,
                "time_end": time_end,
                "granule_id": granule_id,
                "title": title,
                "opendap_url": opendap_url,
                "download_url": download_url or opendap_url,
            })

    # Sort by time, newest first
    results.sort(key=lambda x: x["datetime_iso"], reverse=True)
    return results


# ─── OPeNDAP / NetCDF Wind Data Reading ─────────────────────────────────

_wind_cache: OrderedDict = OrderedDict()
_wind_cache_lock = threading.Lock()


def _setup_earthdata_auth():
    """Set up Earthdata authentication for OPeNDAP access."""
    import netrc
    from pathlib import Path

    netrc_path = Path.home() / ".netrc"
    if netrc_path.exists():
        return  # already configured

    if _EARTHDATA_USER and _EARTHDATA_PASS:
        # Create .netrc entry for Earthdata
        try:
            with open(netrc_path, "a") as f:
                f.write(f"\nmachine urs.earthdata.nasa.gov login {_EARTHDATA_USER} password {_EARTHDATA_PASS}\n")
            netrc_path.chmod(0o600)
            logger.info("Created .netrc entry for Earthdata")
        except Exception as e:
            logger.warning("Failed to create .netrc: %s", e)


def _get_earthdata_session():
    """Create a requests.Session with Earthdata auth for NASA data downloads."""
    import requests
    session = requests.Session()
    if _EARTHDATA_USER and _EARTHDATA_PASS:
        session.auth = (_EARTHDATA_USER, _EARTHDATA_PASS)
        logger.info("ASCAT: using Earthdata user/pass for user=%s", _EARTHDATA_USER)
    elif _EARTHDATA_TOKEN:
        session.headers.update({"Authorization": f"Bearer {_EARTHDATA_TOKEN}"})
        logger.info("ASCAT: using Earthdata Bearer token")
    else:
        logger.warning("ASCAT: no Earthdata credentials set — downloads will likely fail (401)")
    return session


def _fetch_ascat_winds(
    data_url: str,
    center_lat: float, center_lon: float,
    radius_deg: float = 8.0,
) -> Optional[dict]:
    """
    Fetch ASCAT wind data from an OPeNDAP URL or direct NetCDF download.
    Subsets to the storm region and returns wind vectors as JSON-ready dict.
    """
    import xarray as xr
    import tempfile

    try:
        # Download the NetCDF file via HTTP to a temp file, then open with xarray.
        # OPeNDAP URLs work as direct .nc downloads when you append ".nc" or
        # use the raw URL.  This avoids DAP protocol issues on Cloud Run.
        download_url = data_url
        if "opendap.earthdata.nasa.gov" in data_url and not data_url.endswith(".nc"):
            download_url = data_url + ".nc"

        logger.info("ASCAT: downloading %s", download_url[:120])
        # PODAAC ASCAT L2 data is publicly accessible — try without auth first.
        # Auth headers can cause 403 errors when requests forwards them to
        # CloudFront CDN during redirects.
        import requests as _req
        resp = _req.get(download_url, timeout=60, stream=True)
        if resp.status_code == 401:
            logger.info("ASCAT: public download got 401, retrying with Earthdata auth")
            session = _get_earthdata_session()
            resp = session.get(download_url, timeout=60, stream=True)
        resp.raise_for_status()

        with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
            tmp_path = tmp.name
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                tmp.write(chunk)
        file_size = os.path.getsize(tmp_path)
        logger.info("ASCAT: downloaded %.1f MB to %s", file_size / 1e6, tmp_path)

        ds = xr.open_dataset(tmp_path, engine="netcdf4")
    except Exception as e:
        logger.warning("ASCAT: Failed to download/open %s: %s", download_url[:120], e)
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        return None

    try:
        # ASCAT L2 variables vary by product version
        # Common variable names: wind_speed, wind_dir, lat, lon
        # Also: wind_speed_selection, wind_dir_selection for ambiguity-removed
        lat = lon = wspd = wdir = None

        # Try standard variable names
        for lat_name in ["lat", "latitude", "LATITUDE"]:
            if lat_name in ds:
                lat = ds[lat_name].values
                break
        for lon_name in ["lon", "longitude", "LONGITUDE"]:
            if lon_name in ds:
                lon = ds[lon_name].values
                break
        for spd_name in ["wind_speed", "wind_speed_selection", "WIND_SPEED"]:
            if spd_name in ds:
                wspd = ds[spd_name].values
                break
        for dir_name in ["wind_dir", "wind_dir_selection", "WIND_DIRECTION"]:
            if dir_name in ds:
                wdir = ds[dir_name].values
                break

        if lat is None or lon is None or wspd is None or wdir is None:
            logger.warning("Missing required variables in ASCAT file. Available: %s",
                           list(ds.data_vars))
            ds.close()
            return None

        # Quality flags (optional)
        qc = None
        for qc_name in ["wvc_quality_flag", "quality_flag", "bs_distance"]:
            if qc_name in ds:
                qc = ds[qc_name].values
                break

        # Extract datetime from dataset
        sat_time = None
        if "time" in ds.coords:
            try:
                sat_time = str(ds.time.values[0])[:19]
            except Exception:
                pass

        ds.close()

        # Flatten arrays if needed (ASCAT L2 is typically [NUMROWS, NUMCELLS])
        lat_flat = lat.ravel()
        lon_flat = lon.ravel()
        wspd_flat = wspd.ravel()
        wdir_flat = wdir.ravel()
        qc_flat = qc.ravel() if qc is not None else None

        # Geographic subset
        lat_min, lat_max = center_lat - radius_deg, center_lat + radius_deg
        lon_min, lon_max = center_lon - radius_deg, center_lon + radius_deg

        # Handle dateline crossing
        if lon_min < -180:
            mask_lon = (lon_flat >= lon_min + 360) | (lon_flat <= lon_max)
        elif lon_max > 180:
            mask_lon = (lon_flat >= lon_min) | (lon_flat <= lon_max - 360)
        else:
            mask_lon = (lon_flat >= lon_min) & (lon_flat <= lon_max)

        mask_lat = (lat_flat >= lat_min) & (lat_flat <= lat_max)
        mask_valid = np.isfinite(wspd_flat) & np.isfinite(wdir_flat) & (wspd_flat >= 0)

        mask = mask_lat & mask_lon & mask_valid

        # Apply quality filter if available
        if qc_flat is not None:
            # Bit 0 of wvc_quality_flag is typically the rain flag
            # Filter out rain-contaminated cells
            mask = mask & np.isfinite(qc_flat)

        lats = lat_flat[mask]
        lons = lon_flat[mask]
        speeds = wspd_flat[mask]
        dirs = wdir_flat[mask]

        if len(lats) == 0:
            return {"winds": [], "count": 0}

        # Convert wind speed from m/s to knots
        speeds_kt = speeds * 1.94384

        # Build wind vector list
        winds = []
        for i in range(len(lats)):
            winds.append({
                "lat": round(float(lats[i]), 3),
                "lon": round(float(lons[i]), 3),
                "speed_kt": round(float(speeds_kt[i]), 1),
                "dir_deg": round(float(dirs[i]), 0),
            })

        del lat, lon, wspd, wdir, lat_flat, lon_flat, wspd_flat, wdir_flat
        gc.collect()

        # Clean up temp file
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

        return {
            "winds": winds,
            "count": len(winds),
            "datetime_utc": sat_time,
        }

    except Exception as e:
        logger.error("Error processing ASCAT data: %s", e, exc_info=True)
        try:
            ds.close()
        except Exception:
            pass
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        return None


# ─── Endpoints ──────────────────────────────────────────────────────────

@router.get("/passes")
async def get_ascat_passes(
    atcf_id: str = Query(..., description="ATCF storm ID, e.g. WP042026"),
    hours: float = Query(12.0, ge=1.0, le=48.0, description="Lookback hours"),
):
    """
    List recent ASCAT passes near an active storm.
    Returns available MetOp-B/C overpasses with download/OPeNDAP URLs.
    """
    storm = _get_storm_position(atcf_id)
    if storm is None:
        raise HTTPException(404, f"Storm {atcf_id} not found in active storms")

    # Check cache
    hour_key = int(time.time() // _PASS_CACHE_TTL)
    cache_key = (atcf_id.upper(), hour_key)
    with _pass_cache_lock:
        cached = _pass_cache.get(cache_key)
        if cached and cached["expires"] > time.time():
            return JSONResponse(cached["data"])

    # Query CMR
    passes = _search_cmr_granules(
        storm["lat"], storm["lon"],
        hours_back=hours, radius_deg=10.0,
    )

    result = {
        "atcf_id": atcf_id.upper(),
        "storm_name": storm.get("name", ""),
        "storm_lat": storm["lat"],
        "storm_lon": storm["lon"],
        "passes": passes,
        "count": len(passes),
        "hours_searched": hours,
    }

    # Cache result
    with _pass_cache_lock:
        _pass_cache[cache_key] = {"data": result, "expires": time.time() + _PASS_CACHE_TTL}
        # Evict old entries
        now = time.time()
        stale = [k for k, v in _pass_cache.items() if v["expires"] < now]
        for k in stale:
            del _pass_cache[k]

    return JSONResponse(result)


@router.get("/winds")
async def get_ascat_winds(
    data_url: str = Query(..., description="OPeNDAP or download URL for the ASCAT granule"),
    center_lat: float = Query(..., description="Storm center latitude"),
    center_lon: float = Query(..., description="Storm center longitude"),
    radius_deg: float = Query(8.0, ge=2.0, le=15.0, description="Cutout radius in degrees"),
):
    """
    Fetch wind vectors from a specific ASCAT pass, subsetted to the storm region.
    Returns array of {lat, lon, speed_kt, dir_deg} observations.
    """
    # Check cache
    cache_key = (data_url, round(center_lat, 1), round(center_lon, 1))
    with _wind_cache_lock:
        cached = _wind_cache.get(cache_key)
        if cached and cached["expires"] > time.time():
            _wind_cache.move_to_end(cache_key)
            return JSONResponse(cached["data"])

    # Fetch and process
    result = _fetch_ascat_winds(data_url, center_lat, center_lon, radius_deg)
    if result is None:
        raise HTTPException(502, "Failed to fetch ASCAT wind data from source")

    # Cache result
    with _wind_cache_lock:
        _wind_cache[cache_key] = {"data": result, "expires": time.time() + _WIND_CACHE_TTL}
        _wind_cache.move_to_end(cache_key)
        while len(_wind_cache) > _WIND_CACHE_MAX:
            _wind_cache.popitem(last=False)

    return JSONResponse(result)
