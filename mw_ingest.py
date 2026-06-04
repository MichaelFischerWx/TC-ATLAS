"""
mw_ingest.py — NRT passive-microwave swath ingestion for TC-ATLAS
=================================================================
Pulls new microwave granules from NASA PPS (and later JAXA G-Portal,
NOAA CLASS) and produces Web Mercator PNG overlays + GeoJSON footprints
in GCS for display on the RT Monitor / Global Archive map.

Phase 1 scope: GMI (PPS NRT) → global "microwave passes (last N hrs)"
overlay layer. Storm-linkage is Phase 3 (separate pass, this script
already writes the raw artifacts it needs).

Pipeline per granule
--------------------
1. Download .HDF5 (PPS) or .nc (TC-PRIMED) to a tempfile
2. Adapt to TC-PRIMED-style (ds_bt, ds_geo) so microwave_api renderers
   can be reused 1:1
3. Render 37-color RGB and 89H PCT as regridded arrays
4. Warp each from equirect-bbox to Mercator pixel space (so Leaflet's
   L.imageOverlay places it correctly on a Mercator basemap — see
   feedback_env_overlay_projection memory)
5. Encode as RGBA PNG with NaN → fully transparent
6. Compute footprint polygon from valid-pixel mask → GeoJSON
7. Upload to gs://{MW_BUCKET}/{sensor}/{YYYY}/{MM}/{DD}/{orbit_id}.{png,geojson}
8. Append entry to gs://{MW_BUCKET}/manifest_latest_48h.json (self-pruning)

Usage
-----
Test render+upload against an existing TC-PRIMED file (no PPS auth needed):

    GCS_MW_BUCKET=tc-atlas-microwave-nrt \\
        python mw_ingest.py --tcprimed-file path/to/TCPRIMED_*.nc \\
                            --sensor GMI --products 37color,89pct

Live PPS poll (after PPS_USER/PPS_PASS set):

    GCS_MW_BUCKET=tc-atlas-microwave-nrt \\
    PPS_USER=user@example.com PPS_PASS=user@example.com \\
        python mw_ingest.py --sensor GMI --since-hours 6

Environment
-----------
    GCS_MW_BUCKET   target GCS bucket (default: tc-atlas-microwave-nrt)
    PPS_USER        NASA PPS NRT email/username (basic auth username)
    PPS_PASS        NASA PPS NRT password (same as email per PPS convention)

Dependencies (all already in TC-ATLAS deployment)
    xarray, h5netcdf, numpy, scipy, matplotlib, pillow, google-cloud-storage,
    requests, shapely
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import os
import signal
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime as _dt, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional, Tuple

import numpy as np

# Reuse proven rendering helpers from the existing microwave API.
# These are sensor-agnostic: they take (ds_bt, ds_geo, sensor) where ds_bt
# has TB_{freq}{pol} variables and ds_geo has latitude/longitude. The
# PPS reader below produces datasets in that shape so 100% of the math
# is shared with the TC-PRIMED archive path.
from microwave_api import (
    _compute_37color_swath,
    _compute_89pct_swath,
    _compute_37v_swath,
    _compute_37h_swath,
    _compute_89v_swath,
    _compute_89h_swath,
    _nrl_37ghz_cmap,
    _nrl_89ghz_cmap,
)

logger = logging.getLogger("mw_ingest")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MW_BUCKET = os.environ.get("GCS_MW_BUCKET", "tc-atlas-microwave-nrt")
PPS_USER = os.environ.get("PPS_USER", "")
PPS_PASS = os.environ.get("PPS_PASS", "")
PPS_BASE = "https://jsimpsonhttps.pps.eosdis.nasa.gov"
# Space-Track is the primary TLE source: CelesTrak network-blocks
# datacenter egress IPs (Cloud Run connects time out — not a 403), so
# the per-CATNR CelesTrak path silently yields zero passes from the job.
# Space-Track answers from cloud IPs with a free account; CelesTrak is
# kept as a last-resort fallback for local/dev runs where it's reachable.
SPACETRACK_USER = os.environ.get("SPACETRACK_USER", "")
SPACETRACK_PASS = os.environ.get("SPACETRACK_PASS", "")
MANIFEST_KEY = "manifest_latest_48h.json"
MANIFEST_RETENTION_HOURS = 48
# Periodic manifest checkpoint during long backfills. The end-of-run
# manifest update means the frontend sees nothing-then-everything;
# writing intermediate checkpoints every CHECKPOINT_INTERVAL_SEC lets
# users watch coverage grow incrementally. update_manifest is
# idempotent (dedupes by orbit_id + product) so re-writing partial
# state is safe. Atomic GCS writes mean the frontend never sees a
# half-built manifest.
CHECKPOINT_INTERVAL_SEC = 120

# Self-imposed runtime budget for operational ingest. The Cloud Run task
# timeout (1 h) is the hard backstop, but we want to exit cleanly well
# before it so partial progress lands in the manifest and Cloud Run
# doesn't mark the execution failed and retry. 25 min leaves 5 min of
# headroom before the next */30 cron firing and 35 min before the hard
# kill. See 2026-05-26 incident: a regrid-cap regression in
# microwave_api made per-pass compute 5-25x heavier, every cron-fired
# ingest hit the 1 h SIGKILL, in-flight work was lost, and overlapping
# workers piled up racing on PPS NRT polls and GCS writes.
_MAX_RUNTIME_SECONDS = 25 * 60

# Per-granule watchdog timeout. A single granule that hangs in render
# or upload must NOT be allowed to consume the whole _MAX_RUNTIME_SECONDS
# budget — that's exactly the failure mode the 2026-05-27 incident
# exposed (a poison SSMIS HDF5 hung the regridder silently for 25 min
# every tick, starving GMI/ATMS/AMSR2 of any compute slice). 10 min
# is comfortable headroom above the ~5 min nominal SSMIS+AMSR2 granule
# processing time, while still letting a single tick cycle through
# multiple sensors when one hangs.
_GRANULE_TIMEOUT_SECONDS = 10 * 60

# Sentinel product slug emitted to the manifest when a granule times
# out. Lets the per-sensor cursor advance past the offender so the
# next cron tick doesn't re-hit it. The frontend product whitelist
# (89pct/89v/89h/37color/37v/37h) excludes this, so it never renders.
_TIMEOUT_SENTINEL_PRODUCT = "_timed-out-skip"

# Frontfill phase: process the N freshest granules per sensor BEFORE
# the cursor-based catch-up loop. Prevents the "manifest has data but
# the 6h page window is empty" failure mode when the catch-up has to
# grind through a multi-hour poison-granule cluster oldest-first.
#
# Frontfill entries carry _source="frontfill" and are EXCLUDED from
# _last_processed_start_utc so the backfill cursor stays anchored on
# the contiguous-from-old end of processed data. The backfill catches
# up to and overwrites the frontfilled entries naturally; the slight
# reprocessing cost is bounded (N entries × 4 sensors per tick) and
# pays for itself in user-visible freshness.
_FRONTFILL_PER_SENSOR        = 2
_FRONTFILL_LOOKBACK_HOURS    = 1.0    # only frontfill last hour of PPS
_FRONTFILL_BUDGET_SECONDS    = 8 * 60  # cap so backfill keeps ~17 min
_FRONTFILL_SOURCE_TAG        = "frontfill"

# GCS-based concurrency lock. Cloud Run Jobs has no native exclusion,
# so we use a conditional-create on a GCS object. TTL covers the
# runtime budget plus a small cushion so a crashed worker's stale lock
# self-expires before the next */30 cron fires.
_INGEST_LOCK_KEY = ".ingest.lock"
_INGEST_LOCK_TTL_SEC = _MAX_RUNTIME_SECONDS + 5 * 60

WEB_MERC_LAT_MAX = 85.05112877980659  # arctan(sinh(pi)) * 180/pi

# Crop incoming swath pixels to within ±MAX_RENDER_LAT before regridding.
# Polar-orbit sensors with long orbital arcs (SSMIS ~17 min, AMSR2 ~17 min)
# cross the poles where the swath inherently spans many longitudes due to
# cos(lat) → 0 at the poles. That blows up the per-granule bounding box to
# essentially the whole world. Clipping to ±60° drops polar wraparound
# entirely, gives every granule a tractable bbox, and loses zero data
# value for TC research (TCs live in the tropics + subtropics).
MAX_RENDER_LAT = 60.0

# ---------------------------------------------------------------------------
# Pass-prediction config (TLE-based SGP4 propagation)
# ---------------------------------------------------------------------------
# Active-storm API (defaults to the prod TC-ATLAS API) — public endpoint,
# no auth needed. Override with TC_ATLAS_API_BASE for staging.
TC_ATLAS_API_BASE = os.environ.get(
    "TC_ATLAS_API_BASE",
    "https://tc-atlas-api-361010099051.us-east1.run.app",
)
CELESTRAK_TLE_URL = (
    "https://celestrak.org/NORAD/elements/gp.php?CATNR={catnr}&FORMAT=TLE"
)
# Open-source, no-auth TLE mirror (MIT; tle-api by Ivan Stanojević). It
# republishes CelesTrak data from its own infrastructure, so it does NOT
# share CelesTrak's block on cloud-datacenter egress IPs — which is the
# reason direct CelesTrak fetches time out from Cloud Run. Per-satellite
# JSON: {"name", "line1", "line2", ...}. Used as the primary no-auth
# source so the predictor works even when Space-Track creds are unset.
TLEAPI_URL = "https://tle.ivanstanojevic.me/api/tle/{catnr}"
# Space-Track REST: one POST to authenticate (sets a session cookie),
# then one bulk GP query for all catalog numbers in 3LE form. The
# {ids} placeholder is a comma-separated NORAD_CAT_ID list.
SPACETRACK_LOGIN_URL = "https://www.space-track.org/ajaxauth/login"
SPACETRACK_GP_URL = (
    "https://www.space-track.org/basicspacedata/query/class/gp/"
    "NORAD_CAT_ID/{ids}/orderby/NORAD_CAT_ID/format/3le"
)
TLES_CACHE_KEY = "tles_latest.txt"
TLES_CACHE_MAX_AGE_HOURS = 6   # prefer a fresh fetch at most every 6 h
# Hard ceiling for the stale-cache fallback. If every live source fails
# (Space-Track + CelesTrak both unreachable), reuse the last cached TLEs
# up to this age rather than degrading to zero predicted passes. SGP4
# stays well within swath-overlap tolerance for several days, so a
# day-or-two-old element set still tells users when to expect a pass.
TLES_CACHE_STALE_MAX_AGE_HOURS = 72
PASSES_KEY = "passes_predicted.json"
PREDICT_HORIZON_HOURS = 24
PREDICT_STEP_SECONDS = 60      # 1-min propagation step

# Per-sensor horizon overrides. Single-satellite sensors (GMI on GPM,
# AMSR2 on GCOM-W1) have sparse tropical coverage and can miss the
# 24h default at unlucky longitudes — see passes_predicted.json for
# WP992026 (8.7°N, 137.2°E) showing "GMI: none in 24h" while the
# sun-sync SSMIS/ATMS constellations comfortably hit 4 passes each.
# 3-satellite constellations (SSMIS F16/17/18, ATMS NPP/NOAA20/NOAA21)
# stay at 24h — they don't gain anything from a longer window.
GMI_PREDICT_HORIZON_H   = 72   # GPM 65°-incl, 1 sat, daily-ish coverage
AMSR2_PREDICT_HORIZON_H = 48   # GCOM-W1 sun-sync, 1 sat, smaller swath

# Satellites we ingest from. catnr = NORAD ID; swath_half_km is the
# sensor's swath half-width (km) used as the pass-detection radius.
# nrt_latency_min is the empirical lag between scan_start and when the
# corresponding granule lands in TC-ATLAS GCS (measured from current
# ingestion timing — easy to tune as PPS/JAXA pipelines change).
# predict_horizon_h overrides PREDICT_HORIZON_HOURS for that sensor;
# omit (or set None) to inherit the default 24 h.
GMI_NRT_LATENCY_MIN   = 45
SSMIS_NRT_LATENCY_MIN = 180
AMSR2_NRT_LATENCY_MIN = 200
ATMS_NRT_LATENCY_MIN  = 60   # NPP/NOAA-20/NOAA-21 via PPS; empirical

PREDICT_SATELLITES = [
    {"platform": "GPM",     "sensor": "GMI",   "catnr": 39574,
     "swath_half_km": 445.0, "nrt_latency_min": GMI_NRT_LATENCY_MIN,
     "predict_horizon_h": GMI_PREDICT_HORIZON_H},
    {"platform": "F16",     "sensor": "SSMIS", "catnr": 33591,
     "swath_half_km": 875.0, "nrt_latency_min": SSMIS_NRT_LATENCY_MIN},
    {"platform": "F17",     "sensor": "SSMIS", "catnr": 34938,
     "swath_half_km": 875.0, "nrt_latency_min": SSMIS_NRT_LATENCY_MIN},
    {"platform": "F18",     "sensor": "SSMIS", "catnr": 35951,
     "swath_half_km": 875.0, "nrt_latency_min": SSMIS_NRT_LATENCY_MIN},
    {"platform": "GCOM-W1", "sensor": "AMSR2", "catnr": 38337,
     "swath_half_km": 725.0, "nrt_latency_min": AMSR2_NRT_LATENCY_MIN,
     "predict_horizon_h": AMSR2_PREDICT_HORIZON_H},
    # ATMS — cross-track sounder, ~2300 km swath (half-width 1150 km).
    # Three satellites: Suomi NPP, NOAA-20 (JPSS-1), NOAA-21 (JPSS-2).
    {"platform": "NPP",     "sensor": "ATMS",  "catnr": 37849,
     "swath_half_km": 1150.0, "nrt_latency_min": ATMS_NRT_LATENCY_MIN},
    {"platform": "NOAA20",  "sensor": "ATMS",  "catnr": 43013,
     "swath_half_km": 1150.0, "nrt_latency_min": ATMS_NRT_LATENCY_MIN},
    {"platform": "NOAA21",  "sensor": "ATMS",  "catnr": 54234,
     "swath_half_km": 1150.0, "nrt_latency_min": ATMS_NRT_LATENCY_MIN},
]

EARTH_RADIUS_KM = 6371.0
WGS84_A_KM = 6378.137           # semi-major axis (equatorial)
WGS84_F = 1.0 / 298.257223563   # flattening

# Nominal TC "core" radius used to express overpass coverage as a
# percentage. PMW interpretation (eyewall, inner rainbands, convective
# asymmetry) lives in roughly the inner 200 km; we report coverage of a
# disk of this radius. It's a fixed proxy — we don't have reliable
# real-time storm-size radii (R34/ROCI) for every system — and is echoed
# in the payload meta so the frontend can word it honestly.
NOMINAL_TC_CORE_RADIUS_KM = 200.0


# ---------------------------------------------------------------------------
# GCS helpers
# ---------------------------------------------------------------------------
_storage_client = None
_bucket = None


def _get_bucket():
    global _storage_client, _bucket
    if _bucket is not None:
        return _bucket
    from google.cloud import storage
    _storage_client = storage.Client()
    _bucket = _storage_client.bucket(MW_BUCKET)
    return _bucket


def _upload_bytes(key: str, data: bytes, content_type: str,
                  cache_seconds: int = 600) -> None:
    blob = _get_bucket().blob(key)
    blob.cache_control = f"public, max-age={cache_seconds}"
    blob.upload_from_string(data, content_type=content_type)
    logger.info("uploaded gs://%s/%s (%d bytes)", MW_BUCKET, key, len(data))


def _download_text(key: str) -> Optional[str]:
    blob = _get_bucket().blob(key)
    if not blob.exists():
        return None
    return blob.download_as_text()


def _prefix_has_objects(prefix: str) -> bool:
    """True if at least one object exists in the bucket under `prefix`.

    Used by the frontfill existence guard to detect already-rendered
    granules without downloading. Uses max_results=1 so it costs a
    single LIST page regardless of how many products/passes a granule
    produced. Raises on transport/permission errors — callers MUST fall
    through to full processing on error (never silently drop a pass)."""
    blobs = _get_bucket().list_blobs(prefix=prefix, max_results=1)
    for _ in blobs:
        return True
    return False


# ---------------------------------------------------------------------------
# GCS concurrency lock for the operational ingest job.
#
# Cloud Run Jobs has no built-in mutual exclusion, so we serialize via a
# conditional-create on a small GCS object. Why this exists: see the
# 2026-05-26 incident notes near _MAX_RUNTIME_SECONDS — overlapping
# workers raced on PPS NRT polls and GCS writes after the cron interval
# fell behind the wall-clock runtime, compounding the slowdown.
# ---------------------------------------------------------------------------
def _acquire_ingest_lock(execution_name: str) -> bool:
    """Claim the ingest lock atomically. Returns True on success.

    Uses if_generation_match=0 (create-only) so two racing workers can
    never both succeed. If the existing lock has passed its expires_at,
    delete it (with generation match for safety) and retry once.
    """
    from google.api_core.exceptions import PreconditionFailed
    now = _dt.now(timezone.utc)
    expires = now + timedelta(seconds=_INGEST_LOCK_TTL_SEC)
    payload = json.dumps({
        "execution_name": execution_name,
        "started_at": now.isoformat(),
        "expires_at": expires.isoformat(),
    }).encode("utf-8")
    blob = _get_bucket().blob(_INGEST_LOCK_KEY)
    for _ in range(2):
        try:
            blob.upload_from_string(
                payload, content_type="application/json",
                if_generation_match=0,
            )
            logger.info("[lock] acquired by %s (expires %s)",
                        execution_name, expires.isoformat())
            return True
        except PreconditionFailed:
            try:
                blob.reload()
                existing = json.loads(blob.download_as_text())
            except Exception:
                existing = {}
            exp_str = existing.get("expires_at", "")
            try:
                exp_dt = _dt.fromisoformat(exp_str)
            except Exception:
                exp_dt = None
            if exp_dt is not None and exp_dt > now:
                logger.info("[lock] another execution (%s) is running, "
                            "expires at %s — exiting clean",
                            existing.get("execution_name", "?"), exp_str)
                return False
            logger.warning("[lock] stale lock from %s (expired %s) — "
                           "reclaiming",
                           existing.get("execution_name", "?"), exp_str)
            try:
                blob.delete(if_generation_match=blob.generation)
            except Exception as exc:
                logger.warning("[lock] stale-lock delete failed (%s) — "
                               "next attempt will reassess", exc)
    logger.warning("[lock] could not acquire after stale-lock reclaim — "
                   "exiting clean")
    return False


def _release_ingest_lock(execution_name: str) -> None:
    """Release the lock iff WE hold it. Never delete another worker's lock."""
    blob = _get_bucket().blob(_INGEST_LOCK_KEY)
    try:
        if not blob.exists():
            return
        blob.reload()
        try:
            existing = json.loads(blob.download_as_text())
        except Exception:
            existing = {}
        if existing.get("execution_name") != execution_name:
            logger.warning("[lock] not releasing — held by %s, not us (%s)",
                           existing.get("execution_name", "?"),
                           execution_name)
            return
        blob.delete(if_generation_match=blob.generation)
        logger.info("[lock] released by %s", execution_name)
    except Exception as exc:
        logger.warning("[lock] release failed: %s", exc)


# ---------------------------------------------------------------------------
# Mercator warp for a bbox-local equirect array
# ---------------------------------------------------------------------------
def _warp_eq_to_mercator_bbox(field: np.ndarray,
                              lat_min: float, lat_max: float,
                              ny_out: Optional[int] = None) -> np.ndarray:
    """Re-sample a bbox-local equirectangular field (rows uniform in lat,
    top row = lat_max, bottom row = lat_min) onto a Mercator pixel grid
    spanning the same lat range but uniform in Mercator y.

    Generalizes build_env_overlays._warp_eq_to_mercator (which assumed
    a global lat range of ±MAX_LAT) to an arbitrary lat bbox — needed
    because each microwave orbit covers only a regional patch.

    Why we warp: Leaflet's L.imageOverlay stretches the image linearly
    in screen pixels between the two lat corners; on a Mercator basemap
    that linear stretch is only correct if the source pixels are spaced
    uniformly in Mercator y, not in lat. Skipping the warp produces a
    vertical offset that grows with |lat| (see feedback_env_overlay_projection).
    """
    ny_in, nx_in = field.shape[:2]
    if ny_out is None:
        ny_out = ny_in
    # Clamp lat range to Mercator-valid window.
    lat_top = min(lat_max, WEB_MERC_LAT_MAX)
    lat_bot = max(lat_min, -WEB_MERC_LAT_MAX)

    def _mercy(lat_deg: float) -> float:
        return np.log(np.tan(np.pi / 4 + np.radians(lat_deg) / 2))

    my_top = _mercy(lat_top)
    my_bot = _mercy(lat_bot)
    rows_out = np.arange(ny_out, dtype=np.float64)
    # Linear in Mercator y from my_top (row 0) → my_bot (row ny_out-1).
    merc_y = my_top - (rows_out + 0.5) / ny_out * (my_top - my_bot)
    lats = np.degrees(np.arctan(np.sinh(merc_y)))
    # Source row = fractional position in [lat_min..lat_max], top→bottom.
    src_rows = np.clip(
        np.round((lat_max - lats) / (lat_max - lat_min) * (ny_in - 1)).astype(int),
        0, ny_in - 1,
    )
    return field[src_rows, ...].copy()


# ---------------------------------------------------------------------------
# PNG encoding — RGB or scalar, NaN → fully transparent
# ---------------------------------------------------------------------------
def _encode_rgb_png(rgb: np.ndarray, valid_mask: np.ndarray) -> bytes:
    """rgb: (H, W, 3) uint8.  valid_mask: (H, W) bool, True = opaque."""
    from PIL import Image
    h, w, _ = rgb.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.where(valid_mask, 255, 0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _encode_scalar_png(arr: np.ndarray, cmap, vmin: float, vmax: float) -> bytes:
    """arr: (H, W) float; NaN → transparent.  cmap: matplotlib Colormap."""
    from PIL import Image
    valid = np.isfinite(arr)
    norm = np.clip((arr - vmin) / (vmax - vmin), 0.0, 1.0)
    rgba_f = cmap(np.where(valid, norm, 0.0))  # (H, W, 4) floats 0..1
    rgba = (rgba_f * 255).astype(np.uint8)
    rgba[..., 3] = np.where(valid, rgba[..., 3], 0).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Footprint polygon (concave hull of valid pixels)
# ---------------------------------------------------------------------------
def _footprint_geojson(valid_mask: np.ndarray,
                       bounds: list) -> dict:
    """Approximate the swath footprint as a polygon by tracing the outer
    contour of the valid_mask in lat/lon space. Coarse but adequate for
    a click-popup hit test and visualization. bounds = [[s, w], [n, e]]."""
    from shapely.geometry import MultiPolygon, Polygon, mapping
    from shapely.ops import unary_union
    try:
        from skimage import measure
    except ImportError:
        # Fall back to a simple bounding-box rectangle if skimage missing.
        s, w = bounds[0]
        n, e = bounds[1]
        poly = Polygon([(w, s), (e, s), (e, n), (w, n), (w, s)])
        return mapping(poly)

    h, w_px = valid_mask.shape
    s, west = bounds[0]
    n, east = bounds[1]
    dlat = (n - s) / max(h, 1)
    dlon = (east - west) / max(w_px, 1)

    contours = measure.find_contours(valid_mask.astype(np.uint8), 0.5)
    if not contours:
        poly = Polygon([(west, s), (east, s), (east, n), (west, n), (west, s)])
        return mapping(poly)

    polys = []
    for c in contours:
        # c is (row, col) float pixel coords; row 0 = top = lat n.
        coords = [(west + col * dlon, n - row * dlat) for row, col in c]
        if len(coords) >= 4:
            try:
                p = Polygon(coords).buffer(0)  # repair self-intersections
                if p.is_valid and p.area > 0:
                    polys.append(p)
            except Exception:
                continue

    if not polys:
        poly = Polygon([(west, s), (east, s), (east, n), (west, n), (west, s)])
        return mapping(poly)

    union = unary_union(polys)
    if isinstance(union, MultiPolygon):
        # Pick the largest few components to keep the GeoJSON small.
        comps = sorted(union.geoms, key=lambda g: -g.area)[:5]
        union = MultiPolygon(comps)
    return mapping(union)


def _center_track(ds_geo, max_points: int = 12) -> list:
    """Decimated center-pixel ground track of an arc as [[lat, lon], ...].

    A cheap geometry proxy the frontend uses to decide whether a storm
    actually fell under the swath: min great-circle distance from the
    storm to this polyline ≤ the sensor's swath half-width. This replaces
    the far looser bounding-box containment test, which badly over-reports
    coverage for dateline-spanning, pole-to-±60° arcs — their bbox can be
    ~60° wide in longitude even though the swath at any given latitude is
    only ~15-20° wide. Mirrors the subpoint-track distance test that
    predict_passes() already uses for *upcoming* passes, so ingested and
    predicted coverage now share one definition.

    Returns [] when geolocation is unavailable so callers fall back to the
    bbox test (keeps pre-existing manifest entries working too)."""
    try:
        lats, lons = _get_swath_geolocation(ds_geo)
    except Exception:
        return []
    lats = np.asarray(lats)
    lons = np.asarray(lons)
    if lats.ndim != 2 or lats.shape[0] < 2:
        return []
    center_col = lats.shape[1] // 2
    lat = lats[:, center_col].astype(np.float64)
    lon = lons[:, center_col].astype(np.float64)
    good = np.isfinite(lat) & np.isfinite(lon)
    lat = lat[good]
    lon = lon[good]
    n = len(lat)
    if n == 0:
        return []
    if n <= max_points:
        idx = range(n)
    else:
        idx = np.unique(np.linspace(0, n - 1, max_points).round().astype(int))
    return [[round(float(lat[i]), 2), round(float(lon[i]), 2)] for i in idx]


# ---------------------------------------------------------------------------
# Readers — produce TC-PRIMED-style (ds_bt, ds_geo) tuples
# ---------------------------------------------------------------------------
@dataclass
class GranuleMeta:
    sensor: str         # GMI, AMSR2, SSMIS, ...
    platform: str       # GPM, GCOM-W1, F16, ...
    orbit_id: str       # e.g. "31234" (PPS orbit number)
    scan_start_utc: _dt
    scan_end_utc: _dt
    source: str         # "PPS_NRT" | "TCPRIMED_PRELIM" | ...


def _tcprimed_meta(path: str) -> GranuleMeta:
    import re
    fname = Path(path).name
    m = re.match(
        r"TCPRIMED_v\d+r\d+-(?:final|preliminary)_([A-Z0-9]+)_"
        r"([A-Z0-9]+)_([A-Z0-9\-]+)_(\d+)_(\d{14})\.nc",
        fname,
    )
    if not m:
        raise ValueError(f"Unrecognized TC-PRIMED filename: {fname}")
    _atcf, sensor, platform, orbit, ts = m.groups()
    start = _dt.strptime(ts, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    return GranuleMeta(
        sensor=sensor, platform=platform, orbit_id=str(orbit),
        scan_start_utc=start, scan_end_utc=start,
        source="TCPRIMED_PRELIM",
    )


def _tcprimed_swath_groups(path: str) -> list[tuple[str, list[str]]]:
    """Enumerate (group_path, [tb_vars]) for every passive_microwave/Sn
    sub-swath in a TC-PRIMED file. Each sub-swath bundles a different
    frequency band (e.g. SSMIS S2=37 GHz, S4=91.665 GHz) on its own
    scan geometry with its own lat/lon arrays."""
    import h5netcdf
    out = []
    with h5netcdf.File(path, "r") as h5:
        pm = h5.groups.get("passive_microwave")
        if pm is None:
            return out
        for name, sub in pm.groups.items():
            tb_vars = [v for v in sub.variables if v.upper().startswith("TB_")]
            if tb_vars and "latitude" in sub.variables:
                out.append((f"passive_microwave/{name}", tb_vars))
    return out


def _pick_tcprimed_swath_for_freq(swaths: list[tuple[str, list[str]]],
                                  freq_ghz: int) -> Optional[str]:
    """Pick the sub-swath whose TB vars include the requested frequency.
    For 89 GHz, SSMIS labels the channel as 91.665, SSM/I as 85.5, so
    we accept anything in [85, 92]."""
    lo, hi = (85, 92) if freq_ghz >= 85 else (36, 38)
    import re
    for path, tb_vars in swaths:
        for v in tb_vars:
            m = re.search(r"TB_(\d+(?:\.\d+)?)", v)
            if m and lo <= float(m.group(1)) <= hi:
                return path
    return None


def read_tcprimed_for_product(path: str, product: str) -> tuple:
    """Open the TC-PRIMED sub-swath bearing the right frequency band for
    the requested product. Returns (ds_bt, ds_geo, meta) — for TC-PRIMED,
    lat/lon and TB live in the same group, so ds_geo is ds_bt."""
    import xarray as xr
    meta = _tcprimed_meta(path)
    swaths = _tcprimed_swath_groups(path)
    if not swaths:
        raise ValueError(f"No passive_microwave swath groups in {path}")

    freq = 37 if product == "37color" else 89
    grp = _pick_tcprimed_swath_for_freq(swaths, freq)
    if not grp:
        raise ValueError(
            f"No sub-swath with {freq} GHz channels for product {product} "
            f"in {Path(path).name}; swaths={[s for s, _ in swaths]}"
        )
    ds = xr.open_dataset(path, engine="h5netcdf", group=grp).load()
    return ds, ds, meta


# ---------------------------------------------------------------------------
# PPS sensor configuration (GMI / SSMIS / AMSR2 — all served from PPS NRT)
# ---------------------------------------------------------------------------
# Each sensor describes:
#   list_path:  the text-listing endpoint suffix (under /text/)
#   data_path:  the directory granules live under (relative to PPS_BASE)
#   fname_re:   regex matching {YYYYMMDD}-S{HHMMSS}-E{HHMMSS} in the
#               filename, with the satellite/platform also captured as the
#               first group when the listing intermixes platforms (SSMIS)
#   platform_fn: callable(fname) → platform string (e.g. "GPM", "F18")
#   products:   per-product { group, channels: {var_name: chan_idx} }
#               where each product picks its sub-swath and channel slice
#
# Channel slot orders verified from Tc.LongName on real 2026-05-25 granules.
# The "var_name" follows TC-PRIMED convention (TB_{freq}{pol}) so
# microwave_api._find_channel_var picks them up unchanged.
_PPS_FILL = -9999.9

_PPS_SENSORS = {
    "GMI": {
        "list_path":  "1CR/",
        "data_path":  "1CR/",
        "fname_re":   r"1C-R\.GPM\.GMI\.[\w\-]+\.(\d{8})-S(\d{6})-E(\d{6})\."
                      r"V\w+\.RT-NC$",
        "platform_fn": lambda f: "GPM",
        # GMI puts the 37 and 89 GHz channels both in /S1 (channels
        # 5-8), so each product picks just the channels it needs.
        # Single-pol products read one channel; composite products
        # read both for the polarization math.
        "products": {
            "37color": {"group": "S1", "channels": {
                "TB_36.64V": 5, "TB_36.64H": 6,
            }},
            "89pct":   {"group": "S1", "channels": {
                "TB_89.0V": 7, "TB_89.0H": 8,
            }},
            "37v":     {"group": "S1", "channels": {"TB_36.64V": 5}},
            "37h":     {"group": "S1", "channels": {"TB_36.64H": 6}},
            "89v":     {"group": "S1", "channels": {"TB_89.0V":  7}},
            "89h":     {"group": "S1", "channels": {"TB_89.0H":  8}},
        },
    },
    "SSMIS": {
        "list_path":  "1C/SSMIS/",
        "data_path":  "1C/SSMIS/",
        # 1C.{F16|F17|F18}.SSMIS.XCAL2021-V.YYYYMMDD-SHHMMSS-EHHMMSS.V08A.RT-NC
        "fname_re":   r"1C\.(F\d{2})\.SSMIS\.[\w\-]+\.(\d{8})-S(\d{6})-"
                      r"E(\d{6})\.V\w+\.RT-NC$",
        "platform_fn": None,  # captured from fname_re group 1
        # SSMIS splits frequency bands across sub-swaths with different
        # scan geometries — must open the right group per product.
        "products": {
            "37color": {"group": "S2", "channels": {
                "TB_37.0V": 0, "TB_37.0H": 1,
            }},
            "89pct":   {"group": "S4", "channels": {
                "TB_91.665V": 0, "TB_91.665H": 1,
            }},
            "37v":     {"group": "S2", "channels": {"TB_37.0V":    0}},
            "37h":     {"group": "S2", "channels": {"TB_37.0H":    1}},
            "89v":     {"group": "S4", "channels": {"TB_91.665V":  0}},
            "89h":     {"group": "S4", "channels": {"TB_91.665H":  1}},
        },
    },
    "AMSR2": {
        "list_path":  "1C/AMSR2/",
        "data_path":  "1C/AMSR2/",
        "fname_re":   r"1C\.GCOMW1\.AMSR2\.[\w\-]+\.(\d{8})-S(\d{6})-"
                      r"E(\d{6})\.V\w+\.RT-NC$",
        "platform_fn": lambda f: "GCOMW1",
        # AMSR2 splits 89 GHz across two feedhorns: S5 = 89A-Scan,
        # S6 = 89B-Scan. The horns sample the same scans offset by ~half
        # a footprint, so reading only S5 halves the along-track sampling
        # and the overlay renders blocky. `merge_groups` folds S6 into S5
        # at read time (see read_pps_group / _interleave_horns) to recover
        # full-density 89 GHz sampling. 37 GHz lives wholly in S4.
        "merge_groups": {"S5": "S6"},
        "products": {
            "37color": {"group": "S4", "channels": {
                "TB_36.5V": 0, "TB_36.5H": 1,
            }},
            "89pct":   {"group": "S5", "channels": {
                "TB_89.0V": 0, "TB_89.0H": 1,
            }},
            "37v":     {"group": "S4", "channels": {"TB_36.5V": 0}},
            "37h":     {"group": "S4", "channels": {"TB_36.5H": 1}},
            "89v":     {"group": "S5", "channels": {"TB_89.0V": 0}},
            "89h":     {"group": "S5", "channels": {"TB_89.0H": 1}},
        },
    },
    "ATMS": {
        "list_path":  "1C/ATMS/",
        "data_path":  "1C/ATMS/",
        # 1C.{NPP|NOAA20|NOAA21}.ATMS.XCAL2019-V.YYYYMMDD-SHHMMSS-EHHMMSS.V08A.RT-NC
        "fname_re":   r"1C\.(NPP|NOAA20|NOAA21)\.ATMS\.[\w\-]+\.(\d{8})-S(\d{6})-"
                      r"E(\d{6})\.V\w+\.RT-NC$",
        "platform_fn": None,  # captured from fname_re group 1 (NPP/NOAA20/NOAA21)
        # ATMS is a cross-track *sounder*, not a dual-pol imager — each
        # channel carries only one polarization. We expose ATMS as a
        # single-product sensor (89v only) using S3's 88.2 GHz QV-pol
        # channel as a proxy for the 89 V-pol slot. The colormap renders
        # brightness temperature regardless of polarization, so QV vs V
        # is visually equivalent for convective-signal interpretation.
        # 37-color, 89 PCT, 37V/H/89H are simply not available for ATMS;
        # orbits without a PNG for those products are skipped on render.
        "products": {
            "89v": {"group": "S3", "channels": {"TB_88.2V": 0}},
        },
    },
}


def _pps_granule_meta(sensor: str, fname: str) -> GranuleMeta:
    """Parse start/end times + platform out of a PPS granule filename."""
    import re
    cfg = _PPS_SENSORS[sensor]
    m = re.match(cfg["fname_re"], fname)
    if not m:
        raise ValueError(f"Unrecognized PPS {sensor} filename: {fname}")
    groups = m.groups()
    if cfg["platform_fn"] is None:
        # First capture group is the platform (e.g. F18 for SSMIS).
        platform = groups[0]
        ymd, start_hms, end_hms = groups[1:4]
    else:
        platform = cfg["platform_fn"](fname)
        ymd, start_hms, end_hms = groups[:3]
    start = _dt.strptime(ymd + start_hms, "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc)
    end = _dt.strptime(ymd + end_hms, "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc)
    if end < start:
        end += timedelta(days=1)
    orbit_id = start.strftime("%Y%m%dT%H%M%S")
    return GranuleMeta(
        sensor=sensor, platform=platform, orbit_id=orbit_id,
        scan_start_utc=start, scan_end_utc=end, source="PPS_NRT",
    )


def read_pps_for_product(path: str, sensor: str, product: str) -> tuple:
    """Open the PPS L1C HDF5 sub-swath that bears the right frequency band
    for `product` on `sensor`, and adapt to TC-PRIMED-style
    (ds_bt, ds_geo, meta) so microwave_api renderers Just Work.

    Each sub-swath in PPS L1C carries its own Latitude/Longitude
    co-located with Tc[scan, pixel, chan], so we return the same Dataset
    as both ds_bt and ds_geo (matching the TC-PRIMED pattern where the
    storm-centered overpass sub-swath is self-contained)."""
    import xarray as xr

    fname = Path(path).name
    meta = _pps_granule_meta(sensor, fname)
    spec = _PPS_SENSORS[sensor]["products"].get(product)
    if spec is None:
        raise ValueError(f"Sensor {sensor} has no product {product} configured")

    s = xr.open_dataset(path, engine="h5netcdf", group=spec["group"]).load()
    tc = s["Tc"]
    # Channel-dim name varies (nchannel1 for GMI S1, nchannel2 for SSMIS S2, etc.)
    # — last dim by position to stay sensor-agnostic.
    chan_dim = tc.dims[-1]

    # Polar-pixel mask (True where |lat| > MAX_RENDER_LAT). NaN-ing
    # the data + geolocation here lets the regridder's existing
    # finite-only filter drop these pixels, so the bbox shrinks to
    # actual TC-relevant latitudes only.
    lat_arr = s["Latitude"].values.astype(np.float32)
    lon_arr = s["Longitude"].values.astype(np.float32)
    polar = np.abs(lat_arr) > MAX_RENDER_LAT
    if polar.any():
        lat_arr = np.where(polar, np.nan, lat_arr)
        lon_arr = np.where(polar, np.nan, lon_arr)

    data_vars = {}
    for var_name, k in spec["channels"].items():
        slab = tc.isel({chan_dim: k}).astype(np.float32)
        slab = slab.where(slab > _PPS_FILL + 0.1)
        vals = slab.values
        if polar.any():
            vals = np.where(polar, np.nan, vals)
        data_vars[var_name] = (("scan", "pixel"), vals)
    data_vars["latitude"]  = (("scan", "pixel"), lat_arr)
    data_vars["longitude"] = (("scan", "pixel"), lon_arr)
    ds = xr.Dataset(data_vars=data_vars)
    s.close()
    return ds, ds, meta


def _read_pps_group_arrays(path: str, group_name: str,
                           channels: dict) -> tuple:
    """Open one PPS L1C HDF5 group and return (channel_arrays, lat, lon).

    `channel_arrays` maps each requested var_name to its 2D (scan, pixel)
    float32 slab with fill values and polar pixels (|lat| > MAX_RENDER_LAT)
    set to NaN; lat/lon are the matching float32 grids. Split out from
    read_pps_group so multiple co-located groups (e.g. AMSR2's two 89 GHz
    feedhorns) can be read and merged before the Dataset is built."""
    import xarray as xr

    s = xr.open_dataset(path, engine="h5netcdf", group=group_name).load()
    tc = s["Tc"]
    chan_dim = tc.dims[-1]

    # Polar clip (see read_pps_for_product for rationale).
    lat_arr = s["Latitude"].values.astype(np.float32)
    lon_arr = s["Longitude"].values.astype(np.float32)
    polar = np.abs(lat_arr) > MAX_RENDER_LAT
    if polar.any():
        lat_arr = np.where(polar, np.nan, lat_arr)
        lon_arr = np.where(polar, np.nan, lon_arr)

    arrays = {}
    for var_name, k in channels.items():
        slab = tc.isel({chan_dim: k}).astype(np.float32)
        slab = slab.where(slab > _PPS_FILL + 0.1)
        vals = slab.values
        if polar.any():
            vals = np.where(polar, np.nan, vals)
        arrays[var_name] = vals
    s.close()
    return arrays, lat_arr, lon_arr


def _interleave_horns(a: tuple, b: tuple) -> tuple:
    """Interleave two co-temporal AMSR2 89 GHz horn sub-swaths (89A=S5,
    89B=S6) column-by-column into one denser (scan, 2·pixel) grid.

    The two feedhorns sample the same scans offset by ~half a footprint,
    so interleaving their columns (A,B,A,B,…) roughly doubles along-track
    sampling. Nadir stays near the center column, so the orbital-arc
    splitter (which walks the center pixel) keeps working unchanged, and
    the regridder — which ravels everything to a point cloud — just sees
    twice the samples. Each arg is (channel_arrays, lat, lon); returns a
    merged triple. Crops to the common (scan, pixel) extent so a horn
    shape mismatch degrades gracefully rather than raising."""
    a_arrays, a_lat, a_lon = a
    b_arrays, b_lat, b_lon = b
    ns = min(a_lat.shape[0], b_lat.shape[0])
    npix = min(a_lat.shape[1], b_lat.shape[1])

    def il(x: np.ndarray, y: np.ndarray) -> np.ndarray:
        x, y = x[:ns, :npix], y[:ns, :npix]
        out = np.empty((ns, 2 * npix), dtype=x.dtype)
        out[:, 0::2] = x
        out[:, 1::2] = y
        return out

    merged = {name: il(arr, b_arrays[name])
              for name, arr in a_arrays.items() if name in b_arrays}
    return merged, il(a_lat, b_lat), il(a_lon, b_lon)


def read_pps_group(path: str, sensor: str, group_name: str,
                   channels: dict) -> tuple:
    """Load a single HDF5 group from a PPS granule with all the
    specified channels in one shot. `channels` is a mapping from
    var_name (TC-PRIMED-style "TB_36.64V") to the channel index k
    inside the group's Tc[scan, pixel, chan] array.

    Used by the group-grouped process_one flow: when a sensor's
    multiple products live in the same HDF5 group (e.g., SSMI/S has
    37-color + 37V + 37H all sourced from S2), the file is opened
    and the channels extracted once, then shared across products via
    the regrid cache. Returns (ds, ds, meta) — both ds_bt and ds_geo
    are the same Dataset since PPS L1C colocates lat/lon and Tc.

    If the sensor declares a `merge_groups` entry for this group (AMSR2
    folds its 89B-Scan horn S6 into 89A S5), the secondary group is read
    and interleaved in so the regridder sees full-density sampling."""
    import xarray as xr

    fname = Path(path).name
    meta = _pps_granule_meta(sensor, fname)

    arrays, lat_arr, lon_arr = _read_pps_group_arrays(path, group_name, channels)

    secondary = (_PPS_SENSORS.get(sensor) or {}).get(
        "merge_groups", {}).get(group_name)
    if secondary is not None:
        try:
            b = _read_pps_group_arrays(path, secondary, channels)
            arrays, lat_arr, lon_arr = _interleave_horns(
                (arrays, lat_arr, lon_arr), b)
        except Exception as exc:
            logger.warning(
                "%s horn merge %s+%s failed (%s); rendering %s only",
                sensor, group_name, secondary, exc, group_name)

    data_vars = {name: (("scan", "pixel"), vals)
                 for name, vals in arrays.items()}
    data_vars["latitude"]  = (("scan", "pixel"), lat_arr)
    data_vars["longitude"] = (("scan", "pixel"), lon_arr)
    ds = xr.Dataset(data_vars=data_vars)
    return ds, ds, meta


# Backwards-compat alias for the GMI-only entry point used during Phase 1
# scaffolding. Operational mode and process_one now go through
# read_pps_for_product.
def read_pps_l1c(path: str) -> tuple:
    return read_pps_for_product(path, "GMI", "37color")


# ---------------------------------------------------------------------------
# PPS granule discovery (HTTP listing → granule URLs)
# ---------------------------------------------------------------------------
def list_pps_granules(sensor: str, since: _dt, until: Optional[_dt] = None
                      ) -> list[tuple[str, _dt]]:
    """Return [(granule_url, scan_start_utc), ...] for `sensor` granules
    in [since, until] (UTC). PPS exposes a text-listing endpoint that
    returns one path per line (newest at the bottom); we filter to the
    sensor's filename pattern and time window.
    """
    import re
    cfg = _PPS_SENSORS[sensor]
    sess = _pps_session()
    r = sess.get(f"{PPS_BASE}/text/{cfg['list_path']}", timeout=60)
    r.raise_for_status()
    rx = re.compile(cfg["fname_re"])
    data_base = f"{PPS_BASE}/{cfg['data_path']}"
    out: list[tuple[str, _dt]] = []
    for line in r.text.splitlines():
        line = line.strip()
        if not line:
            continue
        fname = line.rsplit("/", 1)[-1]
        m = rx.match(fname)
        if not m:
            continue
        # ymd + start_hms are at positions 0,1 for GMI/AMSR2, 1,2 for SSMIS
        # (which captures platform first). _pps_granule_meta handles the
        # offset — but for sort key we just need start time, so parse here.
        groups = m.groups()
        if cfg["platform_fn"] is None:
            ymd, start_hms = groups[1], groups[2]
        else:
            ymd, start_hms = groups[0], groups[1]
        start = _dt.strptime(ymd + start_hms, "%Y%m%d%H%M%S").replace(
            tzinfo=timezone.utc)
        if start < since:
            continue
        if until is not None and start > until:
            continue
        out.append((f"{data_base}{fname}", start))
    out.sort(key=lambda t: t[1])
    return out


# Backwards-compat alias.
def list_pps_gmi_granules(since: _dt, until: Optional[_dt] = None
                          ) -> list[tuple[str, _dt]]:
    return list_pps_granules("GMI", since, until)


def _pps_session():
    """requests.Session with PPS basic auth. PPS uses email as both
    username and password by convention."""
    import requests
    if not PPS_USER or not PPS_PASS:
        raise RuntimeError(
            "Set PPS_USER and PPS_PASS (both = your registered email per "
            "PPS NRT convention)"
        )
    s = requests.Session()
    s.auth = (PPS_USER, PPS_PASS)
    return s


# ---------------------------------------------------------------------------
# Render + upload one granule
# ---------------------------------------------------------------------------
@dataclass
class RenderedProduct:
    product: str        # "37color" | "89pct" | "37v" | "37h" | "89v" | "89h"
    png_bytes: bytes
    bounds: list        # [[s, w], [n, e]]
    footprint: dict     # GeoJSON geometry
    pass_suffix: str = ""  # per-pass tag like "-p0" when granule was split
    center_track: list = field(default_factory=list)  # [[lat,lon],...] arc center; [] if unknown
    # Storm-centered hi-res crops for this product, one per active storm
    # this arc covers. Each: {"storm_id", "png_bytes", "bounds"}. The
    # whole-arc PNG is downsampled by _adaptive_grid_cap; these crops are
    # regridded at native resolution over a small storm window so the
    # per-storm card + IR/MW compare modal show crisp imagery. Empty when
    # no active storm fell on this arc. See _storm_crops_for_band.
    crops: list = field(default_factory=list)


# Sensors whose NRT granules bundle multiple orbital passes and must
# be split per-pass to keep each rendered PNG to a single-orbit bbox.
# GMI and ATMS NRT granules are already ~5-min single-pass chunks.
_MULTI_PASS_SENSORS = {"SSMIS", "AMSR2"}


# Per-band grid resolution. 37 GHz has coarser native footprint (~15-37 km
# depending on sensor) so a 0.05° grid is appropriate; 89 GHz is sharper
# (~5-15 km) so we go finer at 0.02°. Bands use *different* grids by
# design, which is why the regrid cache is keyed per-band, not per-group.
# Used by the WHOLE-ARC render (overview / Global Map), where the
# _adaptive_grid_cap is the binding constraint on wide arcs anyway.
_BAND_GRID_RES = {37: 0.05, 89: 0.02}


# Native ground footprint (effective IFOV, km) per sensor+band — the finer
# of along/cross-track, post-89A/89B horn-merge for AMSR2. Sources: GPM GMI
# & AMSR2 instrument specs, SSMIS imaging-channel footprints, ATMS 88.2 GHz
# nadir IFOV (cross-track, grows toward swath edge). The storm crop grids
# at ≈ half each footprint (below) so a sharp imager isn't under-sampled and
# a coarse sounder isn't gratuitously over-gridded into a falsely smooth
# image. Reference only — _CROP_GRID_RES is the value actually used.
_SENSOR_NATIVE_KM = {
    "GMI":   {37: 9.2,  89: 4.4},
    "AMSR2": {37: 7.3,  89: 3.5},
    "SSMIS": {37: 28.0, 89: 13.2},
    "ATMS":  {89: 16.0},
}

# Storm-crop grid resolution (deg) per sensor+band, ≈ half the native
# footprint above (km/pixel in comments, ×111 km/deg). This is what makes
# every sensor's per-storm / IR-compare crop preserve its OWN native
# resolution: AMSR2 & GMI stay crisp (2-2.2 km), while SSMIS & ATMS grid at
# ~native instead of the blanket 0.02° that over-sampled them 6-7×. Unknown
# sensors fall back to _BAND_GRID_RES via _crop_grid_res_for().
_CROP_GRID_RES = {
    "GMI":   {37: 0.040, 89: 0.020},   # 4.4 / 2.2 km
    "AMSR2": {37: 0.033, 89: 0.018},   # 3.7 / 2.0 km
    "SSMIS": {37: 0.090, 89: 0.050},   # 10.0 / 5.5 km
    "ATMS":  {89: 0.060},              # 6.7 km
}


def _crop_grid_res_for(sensor: str, band: int) -> float:
    """Grid resolution (deg) for a sensor+band storm crop, set finer than
    that sensor's native footprint so the native-resolution regrid never
    under-samples (degrades) the data. Falls back to the band default for
    sensors not in _CROP_GRID_RES."""
    per_band = _CROP_GRID_RES.get(sensor)
    if per_band and band in per_band:
        return per_band[band]
    return _BAND_GRID_RES.get(band, 0.05)


# Storm-centered hi-res crop parameters. The frontend per-storm card and
# IR/MW compare modal draw a ±_RT_MW_HALF_DEG (6°) box, so the crop window
# is a bit wider (7°) to leave a margin and keep the storm box fully inside
# the native-resolution data. A crop is only emitted when ≥ _CROP_MIN_VALID
# of the window has swath data, so storms that merely fall inside a wide
# arc's bbox (but off the actual swath) don't get an empty crop.
_CROP_HALF_DEG = 7.0
_CROP_MIN_VALID = 0.03


# Active-storm + disturbance target cache for the hi-res crop. Refreshed at
# most once per _STORM_TARGETS_TTL_SEC so a multi-granule backfill doesn't
# hammer the active-storms API once per granule.
_STORM_TARGETS_TTL_SEC = 600
_storm_targets_cache: tuple = (0.0, None)  # (monotonic_ts, list | None)


def _active_storm_targets() -> list[dict]:
    """Return [{"id", "name", "lat", "lon"}, ...] for active TCs + genesis
    disturbances, cached for _STORM_TARGETS_TTL_SEC. Used to decide which
    rendered arcs warrant a storm-centered native-resolution crop. Failures
    degrade to [] (no crops) — the whole-arc PNG still ships."""
    global _storm_targets_cache
    now = time.monotonic()
    ts, cached = _storm_targets_cache
    if cached is not None and (now - ts) < _STORM_TARGETS_TTL_SEC:
        return cached
    targets: list[dict] = []
    for fetch, kind in ((_fetch_active_storms, "storm"),
                        (_fetch_genesis_disturbances, "disturbance")):
        try:
            for s in fetch() or []:
                lat, lon = s.get("lat"), s.get("lon")
                if lat is None or lon is None:
                    continue
                targets.append({
                    "id": s.get("atcf_id") or s.get("name") or kind,
                    "name": s.get("name"),
                    "lat": float(lat),
                    "lon": float(lon),
                })
        except Exception as exc:
            logger.warning("[crop] %s target fetch failed: %s", kind, exc)
    _storm_targets_cache = (now, targets)
    if targets:
        logger.info("[crop] %d active storm/disturbance target(s): %s",
                    len(targets), [t["id"] for t in targets])
    return targets


def _band_of_product(product: str) -> int:
    """Map a product string ('37color', '89v', etc.) to its center
    frequency band (37 or 89). Single source of truth for the
    band-grouping that the regrid cache is keyed on."""
    if product.startswith("37"):
        return 37
    if product.startswith("89"):
        return 89
    raise ValueError(f"Unknown frequency band for product {product!r}")


def _split_into_passes(ds_bt, ds_geo) -> list[tuple]:
    """Split a granule into contiguous single-arc orbital passes.

    Walks the center-pixel (lat, lon) scan-by-scan and breaks the
    granule at three kinds of boundaries:

      (1) Latitude-direction reversal — the ascending/descending node
          at the equator that separates two halves of an orbit.
      (2) Large scan-to-scan longitude jump (>30°) — happens at polar
          crossings where lon-convergence makes the ground track snap
          to a different longitude.
      (3) NaN gaps (from polar clipping) — when a scan is invalid and
          the next valid scan is in a very different geographic
          location, treat as a new arc.

    Returns a list of (sub_bt, sub_geo, suffix) tuples, one per arc,
    each with a coherent narrow bounding box. Falls back to a single-
    element list (whole granule, no suffix) for single-arc granules
    like GMI or ATMS so the caller's code path stays uniform."""
    if "latitude" not in ds_geo.data_vars or "longitude" not in ds_geo.data_vars:
        return [(ds_bt, ds_geo, "")]
    lats_all = ds_geo["latitude"].values
    lons_all = ds_geo["longitude"].values
    if lats_all.ndim != 2 or lats_all.shape[0] < 60:
        return [(ds_bt, ds_geo, "")]
    center_col = lats_all.shape[1] // 2
    lat = lats_all[:, center_col].astype(np.float64)
    lon = lons_all[:, center_col].astype(np.float64)
    nscan = len(lat)

    arcs: list[tuple[int, int]] = []
    arc_start: Optional[int] = None
    prev_lon = prev_lat = None
    prev_dlat_sign = 0  # +1 ascending, -1 descending, 0 unknown
    JUMP_DEG = 30.0     # >30° lon jump between consecutive scans → polar/dateline gap
    NOISE_DEG = 0.05    # |dlat| under this is ignored for direction
    for i in range(nscan):
        if np.isnan(lat[i]) or np.isnan(lon[i]):
            if arc_start is not None and (i - arc_start) >= 30:
                arcs.append((arc_start, i))
            arc_start = None
            prev_lon = prev_lat = None
            prev_dlat_sign = 0
            continue
        if arc_start is None:
            arc_start = i
            prev_lon, prev_lat = lon[i], lat[i]
            prev_dlat_sign = 0
            continue
        dlon = lon[i] - prev_lon
        if dlon > 180:
            dlon -= 360
        elif dlon < -180:
            dlon += 360
        dlat = lat[i] - prev_lat
        boundary = False
        if abs(dlon) > JUMP_DEG:
            # Polar / dateline discontinuity — arc broken.
            boundary = True
        elif abs(dlat) > NOISE_DEG:
            sign_now = 1 if dlat > 0 else -1
            if prev_dlat_sign != 0 and sign_now != prev_dlat_sign:
                # Ascending ↔ descending — start of next pass.
                boundary = True
            prev_dlat_sign = sign_now
        if boundary:
            if (i - arc_start) >= 30:
                arcs.append((arc_start, i))
            arc_start = i
            prev_dlat_sign = 0
        prev_lon, prev_lat = lon[i], lat[i]

    if arc_start is not None and (nscan - arc_start) >= 30:
        arcs.append((arc_start, nscan))

    if len(arcs) <= 1:
        return [(ds_bt, ds_geo, "")]
    out = []
    for idx, (i0, i1) in enumerate(arcs):
        sub_bt  = ds_bt.isel(scan=slice(i0, i1))
        sub_geo = sub_bt if ds_bt is ds_geo else ds_geo.isel(scan=slice(i0, i1))
        out.append((sub_bt, sub_geo, f"-p{idx}"))
    logger.info("split granule into %d orbital arcs", len(out))
    return out


def render_product(ds_bt, ds_geo, sensor: str, product: str
                   ) -> list[RenderedProduct]:
    """Render one product from one swath. For multi-pass sensors (SSMI/S,
    AMSR2 — their NRT granules bundle ~1h45m of orbit, containing 1+
    orbital revolutions), splits into single-pass chunks first and
    renders each independently so per-pass bboxes stay narrow.
    Returns a list of RenderedProducts (one per pass); single-pass
    sensors yield a one-element list with no `pass_suffix`."""
    if sensor in _MULTI_PASS_SENSORS:
        passes = _split_into_passes(ds_bt, ds_geo)
    else:
        passes = [(ds_bt, ds_geo, "")]
    out: list[RenderedProduct] = []
    for sub_bt, sub_geo, suffix in passes:
        try:
            r = _render_single_product(sub_bt, sub_geo, sensor, product)
        except ValueError as exc:
            logger.debug("pass%s skipped: %s", suffix or "", exc)
            continue
        r.pass_suffix = suffix
        r.center_track = _center_track(sub_geo)
        out.append(r)
    return out


def _render_single_product(ds_bt, ds_geo, sensor: str, product: str
                           ) -> RenderedProduct:
    """Render one product from one swath. Each product may need a
    different (ds_bt, ds_geo) — caller is responsible for opening the
    right group(s) per product (see read_tcprimed_for_product).

    Products:
      37color — NRL 37 GHz RGB composite (V+H polarization recipe)
      89pct   — 89 GHz polarization-corrected temperature (V+H formula)
      37v     — raw 37 GHz V-pol brightness temperature
      37h     — raw 37 GHz H-pol brightness temperature
      89v     — raw 89 GHz V-pol brightness temperature
      89h     — raw 89 GHz H-pol brightness temperature
    Single-pol products give researchers access to the underlying TB
    fields so they can do their own physics (e.g. compute their own
    polarization indices, sample emissivity contrasts, etc.).
    """
    # vmin/vmax ranges per single-pol product. V-pol ocean values are
    # higher than H-pol because ocean emissivity is V-dominated at these
    # frequencies; bumping V-pol's vmin pulls dynamic range over the
    # convective signal band rather than wasting it on warm ocean.
    SINGLE_POL_RANGE = {
        "37v": (180, 290),  # V-pol ocean ~200K, land/rain ~270-290K
        "37h": (130, 290),  # H-pol ocean ~140K, land ~270K (huge dynamic range)
        "89v": (180, 290),  # V-pol 89 GHz: ocean ~250K, ice scattering down to 180K
        "89h": (130, 290),  # H-pol 89 GHz: ocean ~210K, ice down to 130K
    }

    if product == "37color":
        gridded = _compute_37color_swath(ds_bt, ds_geo, sensor)
        data = gridded["data"]               # (H, W, 3) uint8
        valid = ~np.all(data == 0, axis=-1)  # transparent where all-zero
    elif product == "89pct":
        gridded = _compute_89pct_swath(ds_bt, ds_geo, sensor)
        data = gridded["data"].astype(np.float32)
        valid = np.isfinite(data)
    elif product in SINGLE_POL_RANGE:
        compute_fn = {
            "37v": _compute_37v_swath, "37h": _compute_37h_swath,
            "89v": _compute_89v_swath, "89h": _compute_89h_swath,
        }[product]
        gridded = compute_fn(ds_bt, ds_geo, sensor)
        data = gridded["data"].astype(np.float32)
        valid = np.isfinite(data)
    else:
        raise ValueError(f"Unknown product {product}")

    # Safety net: even after per-pass splitting, drop anything that
    # still has an absurd bbox (lon-span > 150°). This catches edge
    # cases where the pass detector failed to find boundaries (e.g.,
    # all-NaN center column) and should be rare. Most legitimate
    # passes have lon-span well under 100° after the polar clip.
    bounds = gridded["bounds"]
    lat_min, lat_max = bounds[0][0], bounds[1][0]
    lon_min, lon_max = bounds[0][1], bounds[1][1]
    lon_span = lon_max - lon_min
    if lon_span > 150.0:
        raise ValueError(
            f"bbox too wide after split (lon span {lon_span:.0f}°) — "
            f"pass splitter likely missed a boundary")

    # `_regrid_swath` returns arrays with row 0 = lat_min (south-up, since
    # grid_lat = np.linspace(lat_min, lat_max)). PIL / L.imageOverlay
    # expect row 0 = top = lat_max (north-down). Flip vertically so the
    # subsequent Mercator warp + PNG render places pixels at their true
    # latitudes — otherwise features land mirrored across the swath
    # center (e.g. land/ocean transitions miss the basemap coastline).
    data = data[::-1, ...]
    valid = valid[::-1, ...]

    if product == "37color":
        warped_rgb = _warp_eq_to_mercator_bbox(data, lat_min, lat_max)
        warped_valid = _warp_eq_to_mercator_bbox(
            valid.astype(np.uint8), lat_min, lat_max,
        ).astype(bool)
        png = _encode_rgb_png(warped_rgb, warped_valid)
    elif product == "89pct":
        warped = _warp_eq_to_mercator_bbox(data, lat_min, lat_max)
        # vmin=180 (was 150) better reveals convective detail at tropical
        # latitudes where most pixels are warm ocean — values below ~200 K
        # are rare and meaningful (deep ice scattering), so a tighter floor
        # keeps the colormap's dynamic range over the band that actually
        # carries signal. Keep the frontend legend's 180-290 K ticks in sync.
        png = _encode_scalar_png(warped, _nrl_89ghz_cmap(), vmin=180, vmax=290)
        warped_valid = np.isfinite(warped)
    else:
        # Single-pol products (37v / 37h / 89v / 89h). Use the matching
        # NRL colormap per frequency (37 GHz colormap is calibrated to
        # rain-rate signal at that frequency; 89 GHz colormap targets
        # ice scattering) and the per-product vmin/vmax from above.
        warped = _warp_eq_to_mercator_bbox(data, lat_min, lat_max)
        vmin, vmax = SINGLE_POL_RANGE[product]
        cmap = _nrl_37ghz_cmap() if product.startswith("37") else _nrl_89ghz_cmap()
        png = _encode_scalar_png(warped, cmap, vmin=vmin, vmax=vmax)
        warped_valid = np.isfinite(warped)

    footprint = _footprint_geojson(warped_valid, bounds)
    return RenderedProduct(product=product, png_bytes=png,
                           bounds=bounds, footprint=footprint)


# ---------------------------------------------------------------------------
# Regrid-cached rendering: regrid each channel once per (group, pass, band)
# and derive every product of that band from the cached arrays. Cuts the
# regrid work roughly in half for multi-pol-product sensors.
# ---------------------------------------------------------------------------
from microwave_api import (
    _get_swath_geolocation, _regrid_swath_multi, _regrid_swath_window,
)


def _regrid_band_channels(ds_bt, ds_geo, channel_names: list,
                          sensor: str, grid_res_deg: float) -> dict:
    """Regrid every TB channel in `channel_names` onto a single shared
    grid at `grid_res_deg`. Returns dict matching _regrid_swath_multi's
    output shape (channels + bounds + nx/ny/dx_km). Bypass: if no
    channels actually appear in the dataset, raise ValueError so the
    caller can skip the (pass, band) cleanly."""
    arrays = []
    used_names = []
    for name in channel_names:
        if name not in ds_bt.data_vars:
            continue
        arr = ds_bt[name].values.astype(np.float32)
        # Drop a channel that's entirely fill/NaN (e.g. a pass that delivered
        # 37H but no 37V). _regrid_swath_multi's validity mask is the AND across
        # all channels, so an all-empty channel zeros the mask and sinks the
        # whole band — including the single-pol product that doesn't use it.
        # Leaving it out lets 37H still render; 37color/37V fail cleanly
        # downstream (channel absent from the cache → ValueError in render).
        if not np.isfinite(arr).any():
            logger.info("%s channel %s entirely empty — dropping from regrid",
                        sensor, name)
            continue
        arrays.append(arr)
        used_names.append(name)
    if not arrays:
        raise ValueError(
            f"None of channels {channel_names} present in dataset for {sensor}")
    lats, lons = _get_swath_geolocation(ds_geo)
    return _regrid_swath_multi(
        arrays, lats, lons,
        channel_names=used_names, grid_res_deg=grid_res_deg,
    )


def _storm_crops_for_band(sub_bt, sub_geo, band_channels: list, sensor: str,
                          band: int, targets: list[dict]) -> dict:
    """Pre-compute one storm-window regrid cache per covering target for
    this (pass, band). The band's channel arrays + geolocation are
    extracted ONCE and reused across targets (a wide arc's channel array
    is large — re-copying per storm would be wasteful). The crop is gridded
    at _crop_grid_res_for(sensor, band) — finer than the sensor's native
    footprint so its resolution is preserved, not degraded. Returns
    {storm_id: cache_dict} for targets the arc actually imaged at
    >= _CROP_MIN_VALID coverage; others omitted. Empty dict when there are
    no targets or none fall on the swath — render proceeds with whole-arc
    PNGs only."""
    if not targets:
        return {}
    arrays = []
    used_names = []
    for name in band_channels:
        if name not in sub_bt.data_vars:
            continue
        arr = sub_bt[name].values.astype(np.float32)
        # Skip an all-empty pol so it can't poison the window's AND-mask and
        # sink the single-pol crop — see _regrid_band_channels.
        if not np.isfinite(arr).any():
            continue
        arrays.append(arr)
        used_names.append(name)
    if not arrays:
        return {}
    grid_res_deg = _crop_grid_res_for(sensor, band)
    lats, lons = _get_swath_geolocation(sub_geo)
    out: dict = {}
    for t in targets:
        try:
            cache = _regrid_swath_window(
                arrays, lats, lons, t["lat"], t["lon"], _CROP_HALF_DEG,
                channel_names=used_names, grid_res_deg=grid_res_deg)
        except ValueError:
            continue  # storm off this swath
        if cache.get("valid_frac", 0.0) >= _CROP_MIN_VALID:
            out[t["id"]] = cache
    return out


def _finalize_from_grid(data, valid, bounds, product: str,
                        is_rgb: bool) -> RenderedProduct:
    """Common tail of the render pipeline shared by the per-product path
    and the cached-regrid path: bbox safety check, vertical flip,
    Mercator warp, PNG encode, footprint."""
    lat_min, lat_max = bounds[0][0], bounds[1][0]
    lon_min, lon_max = bounds[0][1], bounds[1][1]
    if (lon_max - lon_min) > 150.0:
        raise ValueError(
            f"bbox too wide ({lon_max - lon_min:.0f}°) — pass splitter likely missed a boundary")

    data  = data[::-1, ...]
    valid = valid[::-1, ...]

    if is_rgb:
        warped_rgb = _warp_eq_to_mercator_bbox(data, lat_min, lat_max)
        warped_valid = _warp_eq_to_mercator_bbox(
            valid.astype(np.uint8), lat_min, lat_max).astype(bool)
        png = _encode_rgb_png(warped_rgb, warped_valid)
    else:
        warped = _warp_eq_to_mercator_bbox(data, lat_min, lat_max)
        if product == "89pct":
            cmap = _nrl_89ghz_cmap()
            vmin, vmax = 180, 290
        else:
            # 37v / 37h / 89v / 89h
            vmin, vmax = _SINGLE_POL_RANGE[product]
            cmap = _nrl_37ghz_cmap() if product.startswith("37") else _nrl_89ghz_cmap()
        png = _encode_scalar_png(warped, cmap, vmin=vmin, vmax=vmax)
        warped_valid = np.isfinite(warped)
    footprint = _footprint_geojson(warped_valid, bounds)
    return RenderedProduct(
        product=product, png_bytes=png, bounds=bounds, footprint=footprint,
    )


# Per-product (vmin, vmax) for the single-pol scalar products.
# Same numbers used by _render_single_product, hoisted here so both
# render paths share the source of truth.
_SINGLE_POL_RANGE = {
    "37v": (180, 290),
    "37h": (150, 290),
    "89v": (180, 290),
    "89h": (150, 290),
}


def _render_from_cached(cached: dict, sensor: str,
                        product: str) -> RenderedProduct:
    """Derive a single product from the band's pre-regridded channel
    arrays. Replaces the regrid-per-product flow inside
    _render_single_product. The cached dict comes from
    _regrid_band_channels: { 'channels': {name: 2D array}, 'bounds': ... }."""
    spec = _PPS_SENSORS[sensor]["products"].get(product)
    if spec is None:
        raise ValueError(f"{sensor} has no product {product}")
    channels_needed = list(spec["channels"].keys())
    chs = cached["channels"]

    if product == "37color":
        if len(channels_needed) != 2:
            raise ValueError("37color expects 2 channels (V+H)")
        v = chs.get(channels_needed[0])
        h = chs.get(channels_needed[1])
        if v is None or h is None:
            raise ValueError("37color: missing V or H from cache")
        from microwave_api import _nrl_37color_rgb
        data = _nrl_37color_rgb(v, h)
        valid = ~np.all(data == 0, axis=-1)
        return _finalize_from_grid(data, valid, cached["bounds"], product, is_rgb=True)

    if product == "89pct":
        if len(channels_needed) != 2:
            raise ValueError("89pct expects 2 channels (V+H)")
        v = chs.get(channels_needed[0])
        h = chs.get(channels_needed[1])
        if v is None or h is None:
            raise ValueError("89pct: missing V or H from cache")
        # PCT = 1.818 * V - 0.818 * H (same formula as _compute_89pct_swath).
        data = (1.818 * v - 0.818 * h).astype(np.float32)
        valid = np.isfinite(data)
        return _finalize_from_grid(data, valid, cached["bounds"], product, is_rgb=False)

    # Single-pol products (37v / 37h / 89v / 89h)
    if len(channels_needed) != 1:
        raise ValueError(f"single-pol product {product} expects 1 channel")
    chan = chs.get(channels_needed[0])
    if chan is None:
        raise ValueError(f"{product}: channel {channels_needed[0]} not in cache")
    data = chan.astype(np.float32)
    valid = np.isfinite(data)
    return _finalize_from_grid(data, valid, cached["bounds"], product, is_rgb=False)


def _granule_output_prefix(meta: GranuleMeta) -> str:
    """Deterministic GCS key prefix shared by EVERY output object of a
    granule, across products AND pass suffixes.

    `upload_granule` writes objects at
        {sensor}/{Y}/{m}/{d}/{orbit_id}{pass_suffix}_{HHMMSS}_{product}.{ext}
    so the longest prefix common to every one of them — regardless of
    which products rendered or how many passes the granule split into —
    is {sensor}/{Y}/{m}/{d}/{orbit_id}. The frontfill existence guard
    lists this prefix to decide whether a granule has already been
    rendered. Keeping this derivation here (and reused below) means the
    guard's notion of granule identity can never drift from the writer's."""
    t = meta.scan_start_utc
    return f"{meta.sensor}/{t:%Y}/{t:%m}/{t:%d}/{meta.orbit_id}"


def _granule_png_key(meta: GranuleMeta, product: str,
                     pass_suffix: str = "") -> str:
    """Deterministic PNG object key for one (granule, product, pass).
    The single source of truth for the output-key layout — used both by
    `upload_granule` (the writer) and, via `_granule_output_prefix`, by
    the frontfill existence guard (the reader)."""
    t = meta.scan_start_utc
    orbit_id = meta.orbit_id + (pass_suffix or "")
    base = f"{meta.sensor}/{t:%Y}/{t:%m}/{t:%d}/{orbit_id}_{t:%H%M%S}"
    return f"{base}_{product}.png"


def _frontfill_skip_granule(sensor: str, fname: str) -> bool:
    """Frontfill existence guard: True iff this PPS granule's rendered
    outputs are ALREADY in GCS, so the frontfill phase can skip the
    download + regrid + render + upload entirely.

    Microwave overpasses are sporadic but the operational frontfill phase
    re-pulls the freshest N granules per sensor every 30-min tick, so most
    ticks re-render granules already uploaded — the dominant Jobs cost.
    This guard suppresses that redundant work while preserving freshness.

    Identity is filename-derived (no download): `_pps_granule_meta` parses
    the orbit_id + scan_start from the granule name, and
    `_granule_output_prefix` turns that into the exact GCS key prefix shared
    by every output object `upload_granule` would write for this granule
    (all products, all pass suffixes). A single existing object under that
    prefix ⇒ the granule was already rendered ⇒ skip.

    Freshness/safety contract — this function returns False (→ DO process)
    whenever it cannot positively confirm prior rendering:
      * filename unparseable               → False (process)
      * MW_FRONTFILL_FORCE truthy          → False (force re-render)
      * existence check raises (transient) → False (never drop a new pass)
    A genuinely new pass has NO objects under its prefix, so this returns
    False and the granule is fully processed."""
    if os.environ.get("MW_FRONTFILL_FORCE", "").strip().lower() in (
            "1", "true", "yes", "on"):
        return False
    try:
        meta = _pps_granule_meta(sensor, fname)
    except Exception as exc:
        logger.debug("[frontfill][%s] %s: meta parse failed (%s) — "
                     "processing", sensor, fname, exc)
        return False
    prefix = _granule_output_prefix(meta)
    try:
        already = _prefix_has_objects(prefix)
    except Exception as exc:
        # Bucket/transient error — fall through to processing so a real
        # new pass is never silently dropped on a flaky LIST.
        logger.warning("[frontfill][%s] existence check for %s failed "
                       "(%s) — processing to be safe", sensor, prefix, exc)
        return False
    if already:
        logger.info("[frontfill][%s] %s already rendered (gs://%s/%s*) — "
                    "skipping download+render", sensor, fname,
                    MW_BUCKET, prefix)
    return already


def upload_granule(meta: GranuleMeta, products: list[RenderedProduct],
                   dry_run: bool = False, dry_run_dir: Optional[str] = None,
                   ) -> list[dict]:
    """Upload PNG + GeoJSON for each product. Returns manifest entries.
    Each product carries its own `pass_suffix` (e.g., "-p0") for
    multi-pass sensors that were split. The suffix is appended to
    meta.orbit_id so each pass becomes a distinct manifest entry."""
    import re
    entries = []
    t = meta.scan_start_utc
    for p in products:
        # Per-pass orbit_id (with suffix when split). Single-pass
        # sensors (GMI, ATMS) leave pass_suffix empty so the path and
        # manifest key are bit-for-bit unchanged.
        orbit_id = meta.orbit_id + (p.pass_suffix or "")
        # png_key derived via the shared helper so the frontfill
        # existence guard and this writer can never disagree on layout.
        png_key = _granule_png_key(meta, p.product, p.pass_suffix or "")
        base = png_key[:-len(f"_{p.product}.png")]
        geo_key = f"{base}_{p.product}.geojson"
        geo_payload = json.dumps(
            {"type": "Feature", "geometry": p.footprint,
             "properties": {"sensor": meta.sensor,
                            "scan_start": t.isoformat()}},
            separators=(",", ":")).encode("utf-8")
        if dry_run:
            out_root = Path(dry_run_dir or "./mw_out")
            (out_root / Path(png_key).parent).mkdir(parents=True, exist_ok=True)
            (out_root / png_key).write_bytes(p.png_bytes)
            (out_root / geo_key).write_bytes(geo_payload)
            logger.info("[dry-run] wrote %s (%d bytes)", out_root / png_key,
                        len(p.png_bytes))
        else:
            _upload_bytes(png_key, p.png_bytes, "image/png")
            _upload_bytes(geo_key, geo_payload, "application/geo+json")
        # Storm-centered hi-res crops (native resolution over a small
        # window) — uploaded alongside the whole-arc PNG. The frontend
        # per-storm card + IR/MW compare prefer the crop whose bounds cover
        # the storm; everything else (Global Map overlay, schedule) keeps
        # using the whole-arc png_url. Absent when no active storm fell on
        # this arc, so the manifest is unchanged on quiet days.
        crops_meta = []
        for crop in (p.crops or []):
            safe_id = re.sub(r"[^A-Za-z0-9]+", "", str(crop["storm_id"])) or "x"
            crop_key = f"{base}_{p.product}_crop-{safe_id}.png"
            if dry_run:
                out_root = Path(dry_run_dir or "./mw_out")
                (out_root / Path(crop_key).parent).mkdir(
                    parents=True, exist_ok=True)
                (out_root / crop_key).write_bytes(crop["png_bytes"])
            else:
                _upload_bytes(crop_key, crop["png_bytes"], "image/png")
            crops_meta.append({
                "storm_id": crop["storm_id"],
                "png_url": f"https://storage.googleapis.com/{MW_BUCKET}/{crop_key}",
                "bounds": crop["bounds"],
            })
        entry = {
            "sensor": meta.sensor,
            "platform": meta.platform,
            "orbit_id": orbit_id,
            "scan_start": t.isoformat(),
            "product": p.product,
            "png_url": f"https://storage.googleapis.com/{MW_BUCKET}/{png_key}",
            "geojson_url": f"https://storage.googleapis.com/{MW_BUCKET}/{geo_key}",
            "bounds": p.bounds,  # [[s, w], [n, e]] for L.imageOverlay
            # Decimated arc center track [[lat,lon],...]. The frontend
            # tests min great-circle distance to this polyline against the
            # sensor swath half-width — an honest coverage gate that the
            # bbox over-reports for wide dateline/polar arcs.
            "center_track": p.center_track,
            "source": meta.source,
        }
        if crops_meta:
            # Storm-centered native-res crops; frontend prefers the one
            # whose bounds cover the storm. Only present when an active
            # storm was on this arc.
            entry["crops"] = crops_meta
        entries.append(entry)
    return entries


def _last_processed_start_utc(sensor: Optional[str] = None) -> Optional[_dt]:
    """Look up the newest scan_start in the rolling manifest. Used by
    --operational mode to resume polling without reprocessing. When
    `sensor` is given, only entries for that sensor are considered (so
    a new sensor's first run doesn't get pinned to another sensor's
    cursor).

    Frontfill entries (carry _source="frontfill") are EXCLUDED from
    this lookup — they represent fresh granules processed out of
    sequence to populate the page, and letting them advance the
    backfill cursor would create permanent gaps where the cursor
    skipped from old data straight to fresh data. The contiguous
    catch-up backfill still proceeds oldest-first off this cursor."""
    try:
        txt = _download_text(MANIFEST_KEY)
    except Exception as exc:
        logger.warning("manifest read failed (%s) — falling back to default since", exc)
        return None
    if not txt:
        return None
    try:
        entries = json.loads(txt).get("entries", [])
    except Exception:
        return None
    if sensor:
        entries = [e for e in entries if e.get("sensor") == sensor]
    # Exclude frontfill entries — they're out-of-order fresh data and
    # shouldn't anchor the contiguous backfill cursor.
    entries = [e for e in entries
               if e.get("_source") != _FRONTFILL_SOURCE_TAG]
    if not entries:
        return None
    return max(_dt.fromisoformat(e["scan_start"]) for e in entries)


def update_manifest(new_entries: list[dict]) -> None:
    """Merge new_entries into the rolling 48-hour manifest."""
    existing_txt = _download_text(MANIFEST_KEY)
    existing = json.loads(existing_txt)["entries"] if existing_txt else []
    # Dedupe by (orbit_id, product).
    keyed = {(e["orbit_id"], e["product"]): e for e in existing}
    for e in new_entries:
        keyed[(e["orbit_id"], e["product"])] = e
    # Prune anything older than retention window.
    cutoff = _dt.now(timezone.utc) - timedelta(hours=MANIFEST_RETENTION_HOURS)
    pruned = [e for e in keyed.values()
              if _dt.fromisoformat(e["scan_start"]) >= cutoff]
    pruned.sort(key=lambda e: e["scan_start"], reverse=True)
    payload = {"updated": _dt.now(timezone.utc).isoformat(),
               "retention_hours": MANIFEST_RETENTION_HOURS,
               "entries": pruned}
    _upload_bytes(
        MANIFEST_KEY,
        json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        "application/json",
        cache_seconds=60,
    )
    logger.info("manifest: %d entries after merge (%d new)",
                len(pruned), len(new_entries))
    _log_sensor_freshness(pruned)


# Wall-clock staleness threshold above which a sensor's latest manifest
# cursor triggers a WARNING-severity log. Set conservatively at 6 h: GMI
# normally lags <10 min, SSMIS+AMSR2 <2-3 h, so 6 h is comfortably outside
# the normal envelope for every sensor we ingest. The threshold is the
# trigger for any external alerting wired up against Cloud Logging
# (Pub/Sub → email/Slack on `severity>=WARNING` + `textPayload:freshness`).
_SENSOR_FRESHNESS_WARN_H = 6.0


def _log_sensor_freshness(entries: list[dict]) -> None:
    """Emit per-sensor freshness summary at the end of each manifest
    update. INFO for sensors within the warn threshold, WARNING for
    those past it. This is the hook for alerting on upstream stalls
    (NASA PPS / JAXA GCOM-W1) and for our own backlogs after recovery
    from a job-timeout incident.

    Logs use a fixed `freshness=` token so log-based metrics + alert
    filters can match a stable signature.
    """
    if not entries:
        logger.info("freshness=no-entries (nothing to summarize)")
        return
    now = _dt.now(timezone.utc)
    by_sensor: dict = {}
    for e in entries:
        s = e.get("sensor")
        t = e.get("scan_start")
        if not s or not t:
            continue
        try:
            ts = _dt.fromisoformat(t.replace("Z", "+00:00"))
        except ValueError:
            continue
        if s not in by_sensor or ts > by_sensor[s]:
            by_sensor[s] = ts
    for sensor in sorted(by_sensor):
        latest = by_sensor[sensor]
        age_h = (now - latest).total_seconds() / 3600.0
        msg = (f"freshness sensor={sensor} latest={latest.isoformat()} "
               f"age_h={age_h:.2f}")
        if age_h > _SENSOR_FRESHNESS_WARN_H:
            logger.warning("%s STALE (threshold=%.1f h)",
                           msg, _SENSOR_FRESHNESS_WARN_H)
        else:
            logger.info(msg)


def process_one(reader_path: str, sensor: str,
                products: Iterable[str],
                dry_run: bool = False,
                dry_run_dir: Optional[str] = None) -> list[dict]:
    """Read → render → upload one file. Returns manifest entries.

    PPS path uses the regrid-cached flow: open each HDF5 group once,
    pass-split once, regrid each band's channels once, derive every
    product of that band from the cached arrays. Roughly half the
    regrid work of the per-product flow.

    TC-PRIMED path keeps the simpler per-product flow since its
    sub-swath geometries differ per band/group and there's much less
    sharing to capture."""
    is_tcprimed = reader_path.lower().endswith(".nc")
    if is_tcprimed:
        return _process_one_tcprimed(
            reader_path, sensor, products,
            dry_run=dry_run, dry_run_dir=dry_run_dir)
    return _process_one_pps(
        reader_path, sensor, products,
        dry_run=dry_run, dry_run_dir=dry_run_dir)


def _process_one_pps(reader_path: str, sensor: str,
                     products: Iterable[str],
                     dry_run: bool = False,
                     dry_run_dir: Optional[str] = None) -> list[dict]:
    """PPS-specific process_one: group products by HDF5 group, open
    each group once, split passes once per group, regrid each band's
    channels once per pass, derive products from the cache."""
    from collections import defaultdict
    products = list(products)
    cfg = _PPS_SENSORS.get(sensor) or {}
    sensor_products = cfg.get("products", {})

    # Group products by (group_name, band). Within a group, multiple
    # bands can coexist (e.g., GMI S1 has both 37 and 89). The cache
    # key is the band because grid resolution differs per band.
    by_group_band: dict = defaultdict(list)
    for p in products:
        spec = sensor_products.get(p)
        if spec is None:
            continue
        try:
            band = _band_of_product(p)
        except ValueError:
            continue
        by_group_band[(spec["group"], band)].append(p)

    if not by_group_band:
        return []

    # For each HDF5 group, union the channels needed across ALL its bands
    # — that's what we'll request from read_pps_group.
    channels_per_group: dict = defaultdict(dict)
    for (group_name, _band), prods in by_group_band.items():
        for p in prods:
            for var_name, k in sensor_products[p]["channels"].items():
                channels_per_group[group_name][var_name] = k

    rendered: list[RenderedProduct] = []
    meta: Optional[GranuleMeta] = None

    # Active storm/disturbance targets for the storm-centered hi-res crop.
    # Fetched once per granule (TTL-cached across granules). Empty list ⇒
    # no crops; render proceeds with whole-arc PNGs exactly as before.
    crop_targets = _active_storm_targets()

    # Iterate groups (file opens), then within each group iterate bands
    # (regrid caches), then within each band iterate passes + products.
    for group_name, all_channels in channels_per_group.items():
        try:
            ds_bt, ds_geo, meta_i = read_pps_group(
                reader_path, sensor, group_name, all_channels)
        except Exception as exc:
            logger.error("open failed for group=%s sensor=%s: %s",
                         group_name, sensor, exc)
            continue
        if meta is None:
            meta = meta_i

        # Pass-split once per group (lat/lon is shared across bands).
        if sensor in _MULTI_PASS_SENSORS:
            passes = _split_into_passes(ds_bt, ds_geo)
        else:
            passes = [(ds_bt, ds_geo, "")]

        # For every band that lives in this group, regrid once per pass
        # and derive every product of that band.
        for sub_bt, sub_geo, suffix in passes:
            # One arc → one center track, shared by every band/product of
            # this arc (geolocation is common across the group's bands).
            arc_track = _center_track(sub_geo)
            for (g_name, band), prods in by_group_band.items():
                if g_name != group_name:
                    continue
                band_channels = sorted({
                    var_name
                    for p in prods
                    for var_name in sensor_products[p]["channels"]
                })
                grid_res = _BAND_GRID_RES.get(band, 0.05)
                try:
                    cached = _regrid_band_channels(
                        sub_bt, sub_geo, band_channels, sensor, grid_res)
                except ValueError as exc:
                    logger.debug("pass%s band=%d regrid failed: %s",
                                 suffix, band, exc)
                    continue
                # Storm-window native-res regrids for this (pass, band) —
                # one per active storm the arc actually imaged. Derived
                # products below crop from these instead of the
                # _adaptive_grid_cap-downsampled whole-arc grid.
                band_crops = _storm_crops_for_band(
                    sub_bt, sub_geo, band_channels, sensor, band,
                    crop_targets)
                for p in prods:
                    try:
                        r = _render_from_cached(cached, sensor, p)
                        r.pass_suffix = suffix
                        r.center_track = arc_track
                        for storm_id, wcache in band_crops.items():
                            try:
                                cr = _render_from_cached(wcache, sensor, p)
                            except ValueError:
                                continue  # product can't derive from window
                            r.crops.append({
                                "storm_id": storm_id,
                                "png_bytes": cr.png_bytes,
                                "bounds": cr.bounds,
                            })
                        rendered.append(r)
                    except ValueError as exc:
                        logger.debug("pass%s product=%s skipped: %s",
                                     suffix, p, exc)

        ds_bt.close()

    if not rendered:
        return []
    if sensor and meta and sensor != meta.sensor:
        meta = GranuleMeta(**{**meta.__dict__, "sensor": sensor})
    logger.info("processing %s/%s orbit=%s start=%s — %d products rendered",
                meta.sensor, meta.platform, meta.orbit_id,
                meta.scan_start_utc, len(rendered))
    return upload_granule(meta, rendered, dry_run=dry_run,
                          dry_run_dir=dry_run_dir)


def _process_one_tcprimed(reader_path: str, sensor: str,
                          products: Iterable[str],
                          dry_run: bool = False,
                          dry_run_dir: Optional[str] = None) -> list[dict]:
    """TC-PRIMED path — keeps the per-product flow since each
    TC-PRIMED sub-swath has its own geometry and there's no shared
    regrid to capture."""
    rendered: list[RenderedProduct] = []
    meta: Optional[GranuleMeta] = None
    for product in products:
        try:
            ds_bt, ds_geo, meta_i = read_tcprimed_for_product(
                reader_path, product)
        except Exception as exc:
            logger.error("open failed for product=%s sensor=%s: %s",
                         product, sensor, exc)
            continue
        if meta is None:
            meta = meta_i
        eff_sensor = sensor or meta.sensor
        try:
            rendered.extend(render_product(ds_bt, ds_geo, eff_sensor, product))
        except Exception as exc:
            logger.error("render failed for product=%s: %s", product, exc)
        finally:
            ds_bt.close()
            if ds_geo is not ds_bt:
                ds_geo.close()
    if not rendered:
        return []
    if sensor and meta and sensor != meta.sensor:
        meta = GranuleMeta(**{**meta.__dict__, "sensor": sensor})
    logger.info("processing %s/%s orbit=%s start=%s — %d products rendered (TC-PRIMED)",
                meta.sensor, meta.platform, meta.orbit_id,
                meta.scan_start_utc, len(rendered))
    return upload_granule(meta, rendered, dry_run=dry_run,
                          dry_run_dir=dry_run_dir)


# ---------------------------------------------------------------------------
# Pass prediction — TLE fetch, SGP4 propagation, storm-relative geometry
# ---------------------------------------------------------------------------
def _fetch_active_storms() -> list[dict]:
    """Pull current ATCF active storms from the TC-ATLAS API. Returns a
    list of {atcf_id, name, lat, lon, ...}. No auth required."""
    import requests
    url = f"{TC_ATLAS_API_BASE}/ir-monitor/active-storms"
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    payload = r.json()
    return payload.get("storms", []) or []


def _fetch_genesis_disturbances() -> list[dict]:
    """Pull current FNV3 LARGE_ENSEMBLE cyclogenesis disturbances (D1, D2,
    ...) from the TC-ATLAS API and convert each into a virtual "storm"
    record compatible with predict_passes(). Each disturbance is a
    time-evolving forecast track; we pick the ensemble_mean point at
    forecast hour closest to the middle of our prediction horizon as
    the best-estimate position. Disturbances flagged with
    `is_disturbance: True` so the frontend can label them distinctly."""
    import requests
    url = f"{TC_ATLAS_API_BASE}/ir-monitor/weatherlab-genesis-clusters"
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        payload = r.json()
    except Exception as exc:
        logger.warning("genesis-clusters fetch failed: %s", exc)
        return []

    init_iso = payload.get("init_time")
    if not init_iso:
        return []
    try:
        # genesis-clusters API returns init_time in compact YYYYMMDDHH
        # format (e.g., "2026052506"), not ISO 8601. Accept both shapes.
        if isinstance(init_iso, str) and len(init_iso) == 10 and init_iso.isdigit():
            init_time = _dt.strptime(init_iso, "%Y%m%d%H").replace(tzinfo=timezone.utc)
        else:
            init_time = _dt.fromisoformat(str(init_iso).replace("Z", "+00:00"))
    except Exception as exc:
        logger.warning("genesis-clusters init_time parse failed (%r): %s",
                       init_iso, exc)
        return []
    now = _dt.now(timezone.utc)
    elapsed_h = (now - init_time).total_seconds() / 3600.0
    # Target tau = elapsed + half the prediction horizon. This places
    # the chosen point in the middle of the window we'll predict over,
    # so a disturbance's modeled motion is approximately right for the
    # representative pass-prediction match.
    target_tau = elapsed_h + PREDICT_HORIZON_HOURS / 2.0

    out = []
    for cluster in payload.get("clusters", []) or []:
        em = cluster.get("ensemble_mean") or {}
        points = em.get("points") or []
        if not points:
            continue
        # Pick the point with tau closest to target_tau.
        best = min(points, key=lambda p: abs(float(p.get("tau", 0.0)) - target_tau))
        lat = best.get("lat")
        lon = best.get("lon")
        if lat is None or lon is None:
            continue
        short = cluster.get("display_short") or cluster.get("track_id") or "D?"
        label = cluster.get("display_label") or short
        # Virtual ATCF-style ID so the frontend can index the same way.
        virtual_id = "DIST-" + short
        out.append({
            "atcf_id": virtual_id,
            "name": label,
            "lat": float(lat),
            "lon": float(lon),
            "vmax_kt": best.get("wind"),
            "mslp_hpa": best.get("pres"),
            "is_disturbance": True,
            "forecast_tau_h": float(best.get("tau", 0.0)),
            "frac": cluster.get("fraction"),
        })
    logger.info("loaded %d cyclogenesis disturbances from %s "
                "(init=%s, target_tau≈%.1f h)",
                len(out), url, init_iso, target_tau)
    return out


def _fetch_tle_celestrak(catnr: int) -> str:
    """Fetch a single satellite's current TLE from CelesTrak. Returns the
    raw 3-line block ("NAME\\nLINE1\\nLINE2\\n")."""
    import requests
    url = CELESTRAK_TLE_URL.format(catnr=catnr)
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    text = r.text.strip()
    if not text or "No GP data found" in text:
        raise RuntimeError(f"CelesTrak returned no TLE for CATNR={catnr}")
    return text + "\n"


def _fetch_tles_tleapi(
    catnrs: set[int],
) -> dict[int, tuple[str, str, str]]:
    """Fetch current TLEs for ``catnrs`` from the open-source no-auth mirror
    (tle.ivanstanojevic.me). One small JSON request per satellite; with 8
    sats every 2 h behind a 6 h cache we stay far under any rate limit.
    Returns {catnr: (name, line1, line2)}; satellites that fail are simply
    omitted so the caller can fall through to the next source."""
    import requests
    out: dict[int, tuple[str, str, str]] = {}
    sess = requests.Session()
    sess.headers.update({
        "Accept": "application/json",
        "User-Agent": "TC-ATLAS/1.0 (+https://michaelfischerwx.github.io)",
    })
    try:
        for catnr in sorted(catnrs):
            try:
                r = sess.get(TLEAPI_URL.format(catnr=catnr), timeout=30)
                r.raise_for_status()
                j = r.json()
                l1 = (j.get("line1") or "").rstrip()
                l2 = (j.get("line2") or "").rstrip()
                if not l1.startswith("1 ") or not l2.startswith("2 "):
                    raise RuntimeError(f"malformed TLE payload: {j!r}")
                name = (j.get("name") or f"CATNR-{catnr}").strip()
                out[catnr] = (name, l1, l2)
            except Exception as exc:
                logger.warning("TLE mirror fetch failed for CATNR=%d: %s",
                               catnr, exc)
    finally:
        sess.close()
    if out:
        logger.info("TLE mirror (tle.ivanstanojevic.me) returned %d/%d TLEs",
                    len(out), len(catnrs))
    return out


def _load_cached_tles(
    max_age_hours: float = TLES_CACHE_MAX_AGE_HOURS,
) -> Optional[dict[int, tuple[str, str, str]]]:
    """Return {catnr: (name, line1, line2)} from gs://.../tles_latest.txt
    if the cache exists and is no older than ``max_age_hours``; otherwise
    None. Cache file is a plain concatenation of 3-line TLE blocks with a
    leading "# updated:" timestamp comment. Pass a larger ``max_age_hours``
    (e.g. TLES_CACHE_STALE_MAX_AGE_HOURS) for the last-resort fallback
    when every live source is unreachable.
    """
    txt = _download_text(TLES_CACHE_KEY)
    if not txt:
        return None
    lines = txt.splitlines()
    if not lines or not lines[0].startswith("# updated:"):
        return None
    try:
        updated = _dt.fromisoformat(lines[0].split("# updated:", 1)[1].strip())
    except Exception:
        return None
    age = _dt.now(timezone.utc) - updated
    if age > timedelta(hours=max_age_hours):
        return None
    # Parse 3-line groups (name, line1, line2) skipping comment lines.
    blocks: dict[int, tuple[str, str, str]] = {}
    buf: list[str] = []
    for raw in lines[1:]:
        if not raw.strip() or raw.startswith("#"):
            continue
        buf.append(raw.rstrip())
        if len(buf) == 3:
            name, l1, l2 = buf
            try:
                catnr = int(l1[2:7])
                blocks[catnr] = (name.strip(), l1, l2)
            except Exception:
                pass
            buf = []
    return blocks or None


def _save_tle_cache(tles: dict[int, tuple[str, str, str]]) -> None:
    """Write the cache file with a timestamp header."""
    now = _dt.now(timezone.utc).isoformat()
    lines = [f"# updated: {now}"]
    for catnr, (name, l1, l2) in tles.items():
        lines.extend([name, l1, l2])
    payload = "\n".join(lines) + "\n"
    _upload_bytes(
        TLES_CACHE_KEY,
        payload.encode("utf-8"),
        "text/plain",
        cache_seconds=60,
    )


def _parse_3le(text: str) -> dict[int, tuple[str, str, str]]:
    """Parse a 3LE/TLE blob into {catnr: (name, line1, line2)}.

    Accepts both Space-Track 3LE (name line prefixed with "0 ") and plain
    CelesTrak 3-line groups. NORAD id is read from columns 3-7 of line 1,
    so the parse is robust even if the name line is missing or odd.
    """
    out: dict[int, tuple[str, str, str]] = {}
    name = ""
    pending1: Optional[str] = None
    for raw in text.splitlines():
        ln = raw.rstrip()
        if not ln.strip() or ln.startswith("#"):
            continue
        if ln.startswith("1 ") and len(ln) >= 7:
            pending1 = ln
        elif ln.startswith("2 ") and pending1 is not None:
            try:
                catnr = int(pending1[2:7])
                disp = name[2:].strip() if name.startswith("0 ") else name.strip()
                out[catnr] = (disp or f"CATNR-{catnr}", pending1, ln)
            except Exception:
                pass
            pending1 = None
            name = ""
        else:
            # Name line (3LE leads each block with "0 NAME").
            name = ln
            pending1 = None
    return out


def _fetch_tles_spacetrack(
    catnrs: set[int],
) -> dict[int, tuple[str, str, str]]:
    """Fetch current TLEs for ``catnrs`` from Space-Track in a single bulk
    GP query (one auth + one data request — well within Space-Track's
    rate limits). Returns {catnr: (name, line1, line2)}; empty dict if
    credentials are unset or the request fails."""
    if not SPACETRACK_USER or not SPACETRACK_PASS:
        logger.info("Space-Track creds unset — skipping (set SPACETRACK_USER/"
                    "SPACETRACK_PASS to enable the primary TLE source)")
        return {}
    import requests
    ids = ",".join(str(c) for c in sorted(catnrs))
    sess = requests.Session()
    try:
        login = sess.post(
            SPACETRACK_LOGIN_URL,
            data={"identity": SPACETRACK_USER, "password": SPACETRACK_PASS},
            timeout=30,
        )
        login.raise_for_status()
        resp = sess.get(SPACETRACK_GP_URL.format(ids=ids), timeout=60)
        resp.raise_for_status()
        parsed = _parse_3le(resp.text)
        logger.info("Space-Track returned %d/%d TLEs",
                    len(parsed), len(catnrs))
        return parsed
    except Exception as exc:
        logger.error("Space-Track TLE fetch failed: %s", exc)
        return {}
    finally:
        # Best-effort logout so we don't leave sessions dangling.
        try:
            sess.get("https://www.space-track.org/ajaxauth/logout", timeout=10)
        except Exception:
            pass
        sess.close()


def _get_tles() -> dict[int, tuple[str, str, str]]:
    """Return {catnr: (name, line1, line2)} for every PREDICT_SATELLITES
    entry. Resolution order, each falling through on shortfall:
      1. Fresh GCS cache (≤ TLES_CACHE_MAX_AGE_HOURS).
      2. Space-Track bulk query (most authoritative; needs creds — skipped
         if SPACETRACK_USER/PASS unset).
      3. Open-source no-auth mirror (tle.ivanstanojevic.me). Primary source
         when creds are unset; unlike CelesTrak it isn't blocked from
         Cloud Run egress IPs.
      4. CelesTrak per-CATNR (last-resort; blocked from Cloud Run egress,
         but works for local/dev runs).
      5. Stale GCS cache (≤ TLES_CACHE_STALE_MAX_AGE_HOURS) — better a
         day-old element set than zero predicted passes.
    The cache is refreshed whenever a live source supplies new TLEs."""
    needed = {s["catnr"] for s in PREDICT_SATELLITES}

    cached = _load_cached_tles()
    if cached and needed.issubset(cached.keys()):
        logger.info("using fresh cached TLEs from gs://%s/%s",
                    MW_BUCKET, TLES_CACHE_KEY)
        return cached

    out: dict[int, tuple[str, str, str]] = dict(cached or {})

    # Most-authoritative live source: Space-Track (bulk). No-op if creds
    # are unset, in which case the open mirror below carries the load.
    missing = needed - out.keys()
    if missing:
        out.update(_fetch_tles_spacetrack(missing))

    # Primary no-auth live source: open mirror (not blocked from Cloud Run).
    missing = needed - out.keys()
    if missing:
        out.update(_fetch_tles_tleapi(missing))

    # Last-resort live source: CelesTrak per-CATNR (works locally).
    missing = needed - out.keys()
    if missing:
        logger.info("falling back to CelesTrak for %d remaining sat(s)",
                    len(missing))
        for spec in PREDICT_SATELLITES:
            catnr = spec["catnr"]
            if catnr not in missing:
                continue
            try:
                block = _fetch_tle_celestrak(catnr)
                parts = [ln for ln in block.splitlines() if ln.strip()]
                if len(parts) < 3:
                    raise RuntimeError(f"malformed TLE for {catnr}: {block!r}")
                name, l1, l2 = parts[0].strip(), parts[1], parts[2]
                out[catnr] = (name, l1, l2)
            except Exception as exc:
                logger.error("TLE fetch failed for CATNR=%d (%s): %s",
                             catnr, spec["platform"], exc)

    # Persist whatever live sources gave us (skip if we only have cache).
    if out and out != (cached or {}):
        try:
            _save_tle_cache(out)
        except Exception as exc:
            logger.warning("TLE cache upload failed: %s", exc)

    # Final safety net: if live sources left gaps, top up from a stale
    # cache rather than dropping those satellites (and their passes).
    missing = needed - out.keys()
    if missing:
        stale = _load_cached_tles(max_age_hours=TLES_CACHE_STALE_MAX_AGE_HOURS)
        if stale:
            topped = {c: stale[c] for c in missing if c in stale}
            if topped:
                logger.warning("topping up %d sat(s) from stale TLE cache: %s",
                               len(topped), sorted(topped.keys()))
                out.update(topped)

    return out


def _eci_to_geodetic_subpoint(r_eci_km: tuple[float, float, float],
                              when_utc: _dt) -> tuple[float, float]:
    """Convert ECI (TEME) position to (lat_deg, lon_deg) sub-point.

    Uses Greenwich Mean Sidereal Time (IAU 1982 approximation, good to
    arcseconds — far better than needed for swath-overlap detection) to
    rotate ECI → ECEF, then WGS84 closed-form ECEF → geodetic.
    """
    x, y, z = r_eci_km

    # Julian date (UT1 ≈ UTC for this purpose; sub-arcsecond error)
    yr = when_utc.year
    mo = when_utc.month
    day = when_utc.day
    hr = when_utc.hour
    mn = when_utc.minute
    sc = when_utc.second + when_utc.microsecond * 1e-6
    if mo <= 2:
        yr -= 1
        mo += 12
    A = yr // 100
    B = 2 - A + A // 4
    jd0 = int(365.25 * (yr + 4716)) + int(30.6001 * (mo + 1)) \
          + day + B - 1524.5
    ut = (hr + mn / 60.0 + sc / 3600.0) / 24.0
    jd = jd0 + ut

    # GMST (IAU 1982 polynomial), in radians.
    T = (jd - 2451545.0) / 36525.0
    gmst_sec = (67310.54841
                + (876600.0 * 3600.0 + 8640184.812866) * T
                + 0.093104 * T * T
                - 6.2e-6 * T * T * T)
    gmst_rad = (gmst_sec % 86400.0) / 240.0  # 86400 s / 360 deg → 240 s/deg
    gmst_rad = np.radians(gmst_rad)

    cos_g = np.cos(gmst_rad)
    sin_g = np.sin(gmst_rad)
    x_ecef = cos_g * x + sin_g * y
    y_ecef = -sin_g * x + cos_g * y
    z_ecef = z

    # WGS84 ECEF → geodetic (Bowring closed-form). For swath-radius checks
    # the sub-degree differences between geodetic and geocentric latitude
    # matter at high latitudes but are still well within sensor swath
    # widths (hundreds of km).
    a = WGS84_A_KM
    f = WGS84_F
    e2 = 2.0 * f - f * f
    b = a * (1.0 - f)
    ep2 = (a * a - b * b) / (b * b)
    p = np.sqrt(x_ecef * x_ecef + y_ecef * y_ecef)
    theta = np.arctan2(z_ecef * a, p * b)
    lat = np.arctan2(z_ecef + ep2 * b * np.sin(theta) ** 3,
                     p - e2 * a * np.cos(theta) ** 3)
    lon = np.arctan2(y_ecef, x_ecef)
    lat_deg = float(np.degrees(lat))
    lon_deg = float(np.degrees(lon))
    # Wrap lon to [-180, 180].
    if lon_deg > 180.0:
        lon_deg -= 360.0
    elif lon_deg < -180.0:
        lon_deg += 360.0
    return lat_deg, lon_deg


def _great_circle_km(lat1: float, lon1: float,
                     lat2: float, lon2: float) -> float:
    """Spherical great-circle distance in km (Haversine)."""
    phi1 = np.radians(lat1)
    phi2 = np.radians(lat2)
    dphi = np.radians(lat2 - lat1)
    dlam = np.radians(lon2 - lon1)
    a = (np.sin(dphi / 2) ** 2
         + np.cos(phi1) * np.cos(phi2) * np.sin(dlam / 2) ** 2)
    return float(2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(min(1.0, a))))


def _propagate_subpoints(line1: str, line2: str,
                         t0: _dt, horizon: timedelta,
                         step_seconds: int = PREDICT_STEP_SECONDS
                         ) -> list[tuple[_dt, float, float]]:
    """Run SGP4 from t0 → t0+horizon at `step_seconds` cadence; return
    [(when_utc, sublat_deg, sublon_deg), ...]. Skips steps where SGP4
    errors (rare for healthy TLEs over a 24-h window)."""
    from sgp4.api import Satrec, jday
    sat = Satrec.twoline2rv(line1, line2)
    n_steps = int(horizon.total_seconds() // step_seconds) + 1
    out: list[tuple[_dt, float, float]] = []
    for i in range(n_steps):
        when = t0 + timedelta(seconds=i * step_seconds)
        sc = when.second + when.microsecond * 1e-6
        jd, fr = jday(when.year, when.month, when.day,
                      when.hour, when.minute, sc)
        e, r, _v = sat.sgp4(jd, fr)
        if e != 0:
            continue
        lat, lon = _eci_to_geodetic_subpoint(r, when)
        out.append((when, lat, lon))
    return out


def _swath_coverage_fraction(min_distance_km: float,
                             swath_half_km: float,
                             core_radius_km: float = NOMINAL_TC_CORE_RADIUS_KM,
                             ) -> float:
    """Fraction of a storm disk of radius ``core_radius_km`` that falls
    inside the swath, given the nadir track's closest approach to the
    storm center (``min_distance_km``) and the swath half-width.

    Geometry: model the swath locally as a straight band of half-width W
    about the nadir line, and the storm as a disk of radius R centered at
    perpendicular distance d (= min_distance_km) from that line. The far
    swath edge cuts the disk at signed height h = W − d above the storm
    center; the near edge is too far to cut for MW swaths (W ≫ R). The
    covered area is the disk minus the circular cap beyond the far edge:

        cap(h) = R²·arccos(h/R) − h·√(R² − h²),   −R ≤ h ≤ R

    Returns a value in [0, 1]. For a center-in-swath pass (d ≤ W ⇒ h ≥ 0)
    this is ≥ 0.5 by construction (the near half of the disk is always in
    the band)."""
    R = core_radius_km
    if R <= 0:
        return 1.0 if min_distance_km <= swath_half_km else 0.0
    h = swath_half_km - min_distance_km
    if h >= R:
        return 1.0
    if h <= -R:
        return 0.0
    cap = (R * R * float(np.arccos(h / R))
           - h * float(np.sqrt(max(0.0, R * R - h * h))))
    frac = 1.0 - cap / (float(np.pi) * R * R)
    return max(0.0, min(1.0, frac))


def _find_passes_for_storm(subpoints: list[tuple[_dt, float, float]],
                           storm_lat: float, storm_lon: float,
                           swath_half_km: float
                           ) -> list[tuple[_dt, float]]:
    """Return [(scan_start_utc, min_distance_km), ...] for every local
    minimum of distance(sat-subpoint, storm) below `swath_half_km`.

    A "pass" is a contiguous run of steps under the threshold; we report
    the timestamp of the minimum-distance step inside each run."""
    if not subpoints:
        return []
    passes: list[tuple[_dt, float]] = []
    in_pass = False
    best_t: Optional[_dt] = None
    best_d = float("inf")
    for when, sublat, sublon in subpoints:
        d = _great_circle_km(sublat, sublon, storm_lat, storm_lon)
        if d <= swath_half_km:
            if not in_pass:
                in_pass = True
                best_t, best_d = when, d
            elif d < best_d:
                best_t, best_d = when, d
        else:
            if in_pass and best_t is not None:
                passes.append((best_t, best_d))
                in_pass = False
                best_t, best_d = None, float("inf")
    if in_pass and best_t is not None:
        passes.append((best_t, best_d))
    return passes


def predict_passes(storms: Optional[list[dict]] = None,
                   tles: Optional[dict[int, tuple[str, str, str]]] = None,
                   t0: Optional[_dt] = None,
                   horizon_hours: float = PREDICT_HORIZON_HOURS,
                   include_disturbances: bool = True,
                   ) -> dict:
    """Build the passes_predicted.json payload. Inputs are optional so
    callers (tests) can inject fixtures; defaults pull live data.

    When `include_disturbances` is True (default), FNV3 cyclogenesis
    disturbances (D1, D2, ...) are also predicted alongside ATCF storms.
    Each disturbance is treated as a virtual storm at its best-estimate
    forecast position. Useful in off-season when no formal TCs exist
    but model-flagged developing systems do."""
    if t0 is None:
        t0 = _dt.now(timezone.utc).replace(microsecond=0)
    if storms is None:
        storms = _fetch_active_storms()
        if include_disturbances:
            storms = list(storms) + _fetch_genesis_disturbances()
    if tles is None:
        tles = _get_tles()

    # Pre-propagate each satellite once; reuse the subpoint stream
    # across all storms. Per-spec `predict_horizon_h` overrides the
    # default `horizon_hours` so single-satellite sensors (GMI / AMSR2)
    # can extend their window without doubling the cost of the dense
    # multi-platform constellations (SSMIS / ATMS) that don't need it.
    propagated: dict[int, list[tuple[_dt, float, float]]] = {}
    for spec in PREDICT_SATELLITES:
        catnr = spec["catnr"]
        if catnr not in tles:
            logger.warning("no TLE for CATNR=%d (%s) — skipping",
                           catnr, spec["platform"])
            continue
        _name, l1, l2 = tles[catnr]
        per_sat_horizon_h = spec.get("predict_horizon_h") or horizon_hours
        per_sat_horizon = timedelta(hours=per_sat_horizon_h)
        try:
            propagated[catnr] = _propagate_subpoints(
                l1, l2, t0, per_sat_horizon)
        except Exception as exc:
            logger.error("SGP4 propagation failed for %s (%d): %s",
                         spec["platform"], catnr, exc)

    storm_out: list[dict] = []
    for st in storms:
        atcf_id = st.get("atcf_id") or st.get("storm_id") or ""
        name = st.get("name") or ""
        lat = st.get("lat")
        lon = st.get("lon")
        if lat is None or lon is None:
            logger.warning("storm %s missing lat/lon — skipping", atcf_id)
            continue
        passes_out: list[dict] = []
        for spec in PREDICT_SATELLITES:
            sub = propagated.get(spec["catnr"])
            if not sub:
                continue
            swath_half = float(spec["swath_half_km"])
            # Detection gate = swath half-width + nominal core radius. A pass
            # images SOME of the core whenever the nadir track passes within
            # (W + R) of the storm center — the swath edge reaches the near
            # rim of the R-radius core disk. Gating on W alone (closest
            # approach ≤ W) drops grazing passes whose edge still cuts the
            # core: e.g. a GMI nadir 517 km out (W=445) covers ~28% of the
            # 200 km core, but d > W skipped it entirely. _swath_coverage_fraction
            # below uses the TRUE swath_half (not the widened gate) so the
            # reported coverage_frac stays honest; the frontend can threshold
            # on it to hide trivial grazes.
            detect_half = swath_half + NOMINAL_TC_CORE_RADIUS_KM
            hits = _find_passes_for_storm(
                sub, float(lat), float(lon), detect_half)
            latency = timedelta(minutes=spec["nrt_latency_min"])
            for scan_start, min_d in hits:
                # Coverage geometry: min_d is the closest approach of the
                # nadir track (swath centerline) to the storm center; the
                # swath fully images the storm out to (W − min_d) km, and
                # covers `coverage_frac` of the nominal core disk.
                cov_radius = max(0.0, swath_half - min_d)
                cov_frac = _swath_coverage_fraction(min_d, swath_half)
                passes_out.append({
                    "sensor": spec["sensor"],
                    "platform": spec["platform"],
                    "predicted_scan_start": scan_start.isoformat(),
                    "min_distance_km": round(min_d, 1),
                    "swath_half_km": round(swath_half, 1),
                    "coverage_radius_km": round(cov_radius),
                    "coverage_frac": round(cov_frac, 2),
                    "eta_on_tcatlas": (scan_start + latency).isoformat(),
                })
        passes_out.sort(key=lambda p: p["predicted_scan_start"])
        rec = {
            "atcf_id": atcf_id,
            "name": name,
            "lat": float(lat),
            "lon": float(lon),
            "passes": passes_out,
        }
        # Surface the disturbance flag so the frontend can render
        # forecast-only rows distinctly from active TCs.
        if st.get("is_disturbance"):
            rec["is_disturbance"] = True
            if st.get("forecast_tau_h") is not None:
                rec["forecast_tau_h"] = st["forecast_tau_h"]
            if st.get("frac") is not None:
                rec["frac"] = st["frac"]
        storm_out.append(rec)

    # Publish the per-sensor effective horizon so the frontend can
    # render entries beyond the baseline (24 h) with a "dim / far-out"
    # style. Without this the UI would have to guess.
    horizon_by_sensor: dict[str, float] = {}
    for spec in PREDICT_SATELLITES:
        h = float(spec.get("predict_horizon_h") or horizon_hours)
        # Multiple satellites can share a sensor (SSMIS, ATMS); take
        # the max so the published horizon reflects the longest one
        # actually propagated.
        cur = horizon_by_sensor.get(spec["sensor"])
        if cur is None or h > cur:
            horizon_by_sensor[spec["sensor"]] = h
    return {
        "updated": t0.isoformat(),
        "horizon_hours": horizon_hours,
        "horizon_by_sensor": horizon_by_sensor,
        "coverage_core_radius_km": NOMINAL_TC_CORE_RADIUS_KM,
        "storms": storm_out,
    }


def run_predict_passes(upload: bool = True) -> dict:
    """Top-level entry: fetch storms+TLEs, compute, optionally upload to
    gs://{MW_BUCKET}/passes_predicted.json. Returns the payload."""
    payload = predict_passes()
    n_passes = sum(len(s["passes"]) for s in payload["storms"])
    logger.info("predicted %d passes across %d storms (horizon %s h)",
                n_passes, len(payload["storms"]), payload["horizon_hours"])
    if upload:
        _upload_bytes(
            PASSES_KEY,
            json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            "application/json",
            cache_seconds=300,
        )
    _check_for_wsf_m_on_pps()
    return payload


# Sensors we'd like to add to TC-ATLAS once NASA adds them to the GPM
# XCAL constellation on PPS. Right now (~2026) WSF-M's MWI isn't in
# /text/1C/ — it's distributed via FNMOC + NRL Monterey to authorized
# users only. Each --predict-passes run probes for it so the day NASA
# finally publishes it we see a clear log line and can extend
# _PPS_SENSORS with one new entry.
_PPS_SENSOR_WATCHLIST = [
    ("WSF",     "WSF-M (MWI) — Space Force microwave imager"),
    ("MWI",     "WSF-M (MWI) — alternate path"),
    ("WSF-M",   "WSF-M (MWI) — full-name path"),
]


def _check_for_wsf_m_on_pps() -> None:
    """Lightweight HEAD probe: is WSF-M / MWI available on PPS yet?
    Gated to UTC midnight (00:00-00:29) so it fires at most once per
    day even though the parent prediction job runs every 30 min —
    PPS integration of a new sensor isn't imminent and there's no
    benefit to polling more often than daily. Missed days are fine
    (it's a passive watchlist, not a critical alert)."""
    now = _dt.now(timezone.utc)
    if now.hour != 0 or now.minute >= 30:
        return
    import requests
    try:
        sess = requests.Session()
        if PPS_USER and PPS_PASS:
            sess.auth = (PPS_USER, PPS_PASS)
        for path, label in _PPS_SENSOR_WATCHLIST:
            url = f"{PPS_BASE}/text/1C/{path}/"
            try:
                r = sess.head(url, timeout=20, allow_redirects=True)
                if r.status_code == 200:
                    logger.warning(
                        "[WATCHLIST] %s now available on PPS at %s — "
                        "extend _PPS_SENSORS to ingest it!", label, url)
                else:
                    logger.debug("[WATCHLIST] %s: not yet on PPS (HTTP %d)",
                                 label, r.status_code)
            except Exception as exc:
                logger.debug("[WATCHLIST] %s: probe error: %s", label, exc)
    except Exception as exc:
        logger.warning("watchlist probe failed: %s", exc)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _cli(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--tcprimed-file",
                    help="Local TC-PRIMED .nc to process (test mode)")
    ap.add_argument("--pps-file",
                    help="Local PPS L1C HDF5 to process (after reader is ready)")
    ap.add_argument("--sensor", default="GMI",
                    help="Single-sensor mode (--tcprimed-file / --pps-file): "
                         "sensor name; defaults to GMI")
    # AMSR2 is ordered ahead of SSMIS so a runtime-starved worker (e.g.,
    # a heavy GMI backlog hogging the budget) drops SSMIS first, not the
    # higher-resolution AMSR2. AMSR2 native 89 GHz footprint is ~5 km
    # vs SSMIS ~13 km, so an AMSR2 pass carries more diagnostic value
    # per granule for TC inner-core analysis.
    ap.add_argument("--sensors", default="GMI,AMSR2,SSMIS,ATMS",
                    help="Operational/poll mode: comma-separated list of "
                         "PPS sensors to ingest (default GMI,AMSR2,SSMIS,"
                         "ATMS; AMSR2 prioritized over SSMIS by resolution). "
                         "Quiet-mode gate narrows this to GMI+AMSR2 when "
                         "there are 0 active storms AND 0 disturbances, so "
                         "ATMS only ingests when something's actually worth "
                         "watching.")
    ap.add_argument("--products", default="37color,89pct,37v,37h,89v,89h",
                    help="Comma-separated product list (default = all six)")
    ap.add_argument("--since-hours", type=float, default=None,
                    help="Live PPS poll mode: ingest all granules from "
                         "now − N hours per sensor (requires PPS_USER/PPS_PASS)")
    ap.add_argument("--operational", action="store_true",
                    help="Cloud Run mode: resume from the latest manifest "
                         "scan_start per sensor (or --since-hours N on first "
                         "run). Idempotent — already-uploaded granules are "
                         "deduped by orbit_id in the manifest.")
    ap.add_argument("--predict-passes", action="store_true",
                    help="Fetch TLEs + active storms and write the next "
                         "24 h of predicted microwave passes to "
                         "gs://{bucket}/passes_predicted.json. Does NOT "
                         "require PPS creds.")
    ap.add_argument("--no-manifest", action="store_true",
                    help="Skip manifest update (useful for one-off testing)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Write PNGs/GeoJSON locally instead of uploading to GCS")
    ap.add_argument("--dry-run-dir", default="./mw_out",
                    help="Local output directory in --dry-run mode")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # Wall-clock start for the operational runtime budget. See
    # _MAX_RUNTIME_SECONDS for why we exit voluntarily before the Cloud
    # Run hard timeout. Recording it unconditionally is harmless for
    # the non-operational paths.
    start_time = time.time()
    execution_name = (
        os.environ.get("CLOUD_RUN_EXECUTION")
        or os.environ.get("HOSTNAME")
        or f"local-{os.getpid()}"
    )

    # Convert SIGTERM into a normal SystemExit so try/finally blocks run
    # when the job is cancelled via `gcloud run jobs executions cancel`.
    # Lock release + manifest checkpoint can then complete instead of
    # leaving a stale lock behind. TTL is the safety net if the signal
    # arrives mid-syscall and the finally never runs.
    signal.signal(signal.SIGTERM, lambda *_a: sys.exit(0))

    products = [p.strip() for p in args.products.split(",") if p.strip()]
    all_entries: list[dict] = []

    # --predict-passes is its own short-circuit path: it never touches
    # PPS auth or granule listing, so it must run BEFORE the operational
    # branch (which calls _pps_session() and would raise without creds).
    if args.predict_passes:
        # Mutual-exclusion guard against the granule-ingest modes.
        conflict = [name for name, v in [
            ("--tcprimed-file", args.tcprimed_file),
            ("--pps-file", args.pps_file),
            ("--operational", args.operational),
            ("--since-hours", args.since_hours),
        ] if v]
        if conflict:
            ap.error(f"--predict-passes cannot be combined with: {conflict}")
        payload = run_predict_passes(upload=not args.dry_run)
        if args.dry_run:
            out_root = Path(args.dry_run_dir)
            out_root.mkdir(parents=True, exist_ok=True)
            (out_root / PASSES_KEY).write_text(
                json.dumps(payload, indent=2))
            logger.info("[dry-run] wrote %s", out_root / PASSES_KEY)
        print(json.dumps({
            "storms": len(payload["storms"]),
            "passes": sum(len(s["passes"]) for s in payload["storms"]),
            "horizon_hours": payload["horizon_hours"],
        }, indent=2))
        return

    if args.tcprimed_file:
        all_entries.extend(process_one(
            args.tcprimed_file, args.sensor, products,
            dry_run=args.dry_run, dry_run_dir=args.dry_run_dir,
        ))
    elif args.pps_file:
        all_entries.extend(process_one(
            args.pps_file, args.sensor, products,
            dry_run=args.dry_run, dry_run_dir=args.dry_run_dir,
        ))
    elif args.since_hours is not None or args.operational:
        # Operational-mode concurrency lock + runtime budget guard.
        # See _acquire_ingest_lock and _MAX_RUNTIME_SECONDS for context
        # on the 2026-05-26 incident this prevents. Manual --since-hours
        # invocations bypass the lock so an operator firing a backfill
        # isn't blocked by an in-flight cron run.
        lock_held = False
        if args.operational:
            if not _acquire_ingest_lock(execution_name):
                print(json.dumps({"processed": 0, "reason": "lock-held"}))
                return
            lock_held = True
        try:
            # Operational mode: pick up where the manifest left off PER SENSOR,
            # so a newly-added sensor with no entries yet doesn't get pinned
            # to another sensor's cursor. Fall back to args.since_hours
            # (or 1 h default) on the very first run for that sensor.
            sensors = [s.strip() for s in args.sensors.split(",") if s.strip()]
            unknown = [s for s in sensors if s not in _PPS_SENSORS]
            if unknown:
                ap.error(f"Unknown sensor(s): {unknown}. "
                         f"Supported: {list(_PPS_SENSORS)}")

            # Tier 2 cost gate: in --operational mode (i.e., cron-triggered),
            # narrow the sensor list to a quiet-mode subset (GMI + AMSR2) when
            # there are zero active TCs AND zero genesis disturbances. Rationale:
            # ATCF invests (90-99) and FNV3 disturbances both count as "active"
            # here, so the gate only fires on truly quiet days (~30-50/year).
            # On those days we still want opportunistic global coverage from the
            # highest-quality sensors (GMI 37 GHz, AMSR2 89 GHz) — useful for
            # pre-genesis AEW/monsoon monitoring, polar lows, and sub-tropical
            # systems — but skip the heavier SSMI/S (3 sats × multi-orbit) and
            # ATMS (3 sats × 5-min cadence, sounder-blurred 89v only). Cuts
            # quiet-day compute to ~40% of full-mode while keeping the frontend
            # populated. Manual --since-hours invocations skip the gate.
            # Fail-safe: if either gate API call fails, keep the full sensor
            # list (better to over-ingest than to drop coverage silently).
            QUIET_MODE_SENSORS = {"GMI", "AMSR2"}
            if args.operational and not args.since_hours:
                storms_ok = disturb_ok = True
                try:
                    gate_storms = _fetch_active_storms()
                except Exception as exc:
                    logger.warning("[gate] active-storms fetch failed (%s) — "
                                   "full sensor list to be safe", exc)
                    storms_ok = False
                    gate_storms = []
                try:
                    gate_disturb = _fetch_genesis_disturbances()
                except Exception as exc:
                    logger.warning("[gate] genesis fetch failed (%s) — "
                                   "full sensor list to be safe", exc)
                    disturb_ok = False
                    gate_disturb = []
                if storms_ok and disturb_ok and not gate_storms and not gate_disturb:
                    quiet_sensors = [s for s in sensors if s in QUIET_MODE_SENSORS]
                    if not quiet_sensors:
                        logger.info("[gate] quiet (0 storms, 0 disturbances) and "
                                    "configured sensors %s have no quiet-mode "
                                    "overlap with %s — skipping ingest entirely",
                                    sensors, sorted(QUIET_MODE_SENSORS))
                        print(json.dumps({"processed": 0, "reason": "quiet-gate-skip"}))
                        return
                    logger.info("[gate] quiet (0 storms, 0 disturbances) — "
                                "narrowing sensors %s → %s for opportunistic "
                                "global coverage", sensors, quiet_sensors)
                    sensors = quiet_sensors

            # Sort sensors stalest-first so each cron tick attacks the
            # biggest freshness deficit before the runtime budget runs
            # out. Without this, the original config order is "GMI,
            # AMSR2, SSMIS, ATMS" — and GMI's 5-min granule cadence can
            # consume the full ~26 min budget on its own when there's
            # any backlog, leaving ATMS perpetually stuck on day-old
            # data (observed 2026-05-26: ATMS at 31 h while GMI was
            # current). Stalest-first guarantees the worst-off sensor
            # gets the first slice of every run's budget; freshness
            # converges across sensors over a handful of ticks.
            if args.operational:
                def _staleness_h(sensor: str) -> float:
                    last = _last_processed_start_utc(sensor=sensor)
                    if last is None:
                        # No prior entries — treat as maximally stale so
                        # a newly-added sensor (e.g., ATMS just being
                        # re-enabled) gets attention immediately.
                        return float("inf")
                    return (_dt.now(timezone.utc) - last).total_seconds() / 3600.0
                sensors = sorted(sensors, key=_staleness_h, reverse=True)
                logger.info("[order] sensors sorted stalest-first: %s",
                            [(s, round(_staleness_h(s), 1)) for s in sensors])

            sess = _pps_session()
            # Manifest-checkpoint timer. Long backfills used to keep the
            # frontend dark until end-of-run; now we write the manifest every
            # CHECKPOINT_INTERVAL_SEC of wall-clock time during the loop, so
            # users watch coverage build up incrementally. The final
            # end-of-run update_manifest still fires (idempotent) so any
            # post-last-checkpoint entries also land.
            last_checkpoint = time.monotonic()
            def _maybe_checkpoint():
                nonlocal last_checkpoint
                if args.no_manifest or args.dry_run:
                    return
                if not all_entries:
                    return
                now_t = time.monotonic()
                if (now_t - last_checkpoint) < CHECKPOINT_INTERVAL_SEC:
                    return
                try:
                    update_manifest(all_entries)
                    logger.info("[checkpoint] manifest updated with %d entries so far",
                                len(all_entries))
                except Exception as exc:
                    logger.warning("[checkpoint] manifest update failed: %s", exc)
                last_checkpoint = now_t

            # Larger first-run fallback than 1 h — SSMI/S and AMSR2 NRT lag ~3-4 h
            # behind real time, so a tight window leaves them empty on the first
            # operational pass. 6 h captures everything available; subsequent
            # runs resume from the per-sensor manifest cursor with 20-min steps.
            fallback_hours = args.since_hours if args.since_hours is not None else 6

            # Per-granule processor — used by BOTH the frontfill pass
            # (newest-first, freshest N per sensor) and the catch-up
            # backfill (oldest-first off the per-sensor cursor). Adding
            # this once avoids drift between the two phases on watchdog
            # / error handling.
            #
            # `source_tag` (None or "frontfill") is stamped on each
            # output manifest entry as _source. _last_processed_start_utc
            # filters out _source=="frontfill" so frontfilled granules
            # show on the page WITHOUT advancing the backfill cursor —
            # the contiguous catch-up still proceeds oldest-first from
            # where it left off.
            #
            # Returns True if the granule was processed (success OR
            # watchdog timeout — both advance state); False on a
            # transient error that should be retried on the next tick.
            def _process_one_granule(url, scan_start, sensor,
                                     source_tag=None):
                fname = url.rsplit("/", 1)[-1]
                granule_timed_out = False
                def _granule_alarm_handler(_signum, _frame):
                    raise TimeoutError(
                        f"granule watchdog ({_GRANULE_TIMEOUT_SECONDS}s)")
                prev_handler = signal.signal(
                    signal.SIGALRM, _granule_alarm_handler)
                signal.alarm(_GRANULE_TIMEOUT_SECONDS)
                # Download into a temp DIR using the original PPS
                # filename so read_pps_for_product's regex (anchored
                # on the granule name pattern) sees the unmodified
                # granule name. NamedTemporaryFile prepends tmpXXX_
                # which broke that parse.
                produced = []
                try:
                    with tempfile.TemporaryDirectory() as td:
                        fpath = Path(td) / fname
                        try:
                            r = sess.get(url, stream=True, timeout=180)
                            r.raise_for_status()
                            with open(fpath, "wb") as f:
                                for chunk in r.iter_content(chunk_size=1 << 20):
                                    f.write(chunk)
                            produced = process_one(
                                str(fpath), sensor, products)
                        except TimeoutError as exc:
                            granule_timed_out = True
                            logger.error(
                                "[%s] granule %s WATCHDOG TIMEOUT "
                                "(%s) — skipping; cursor will advance "
                                "via sentinel entry to prevent retry "
                                "loop", sensor, fname, exc)
                        except Exception as exc:
                            logger.error("[%s] granule %s failed: %s",
                                         sensor, fname, exc)
                finally:
                    signal.alarm(0)
                    signal.signal(signal.SIGALRM, prev_handler)

                if source_tag:
                    for e in produced:
                        e["_source"] = source_tag
                all_entries.extend(produced)

                if granule_timed_out:
                    all_entries.append({
                        "sensor": sensor,
                        "platform": "_skip",
                        "scan_start": scan_start.isoformat(),
                        "scan_end": scan_start.isoformat(),
                        "orbit_id": f"TIMEOUT-SKIP-{fname}",
                        "product": _TIMEOUT_SENTINEL_PRODUCT,
                        "png_url": "",
                        "geojson_url": "",
                        "bounds": [[0.0, 0.0], [0.0, 0.0]],
                        "_skip_reason": "granule-watchdog-timeout",
                        **({"_source": source_tag} if source_tag else {}),
                    })
                _maybe_checkpoint()
                return True

            # ── Frontfill phase ─────────────────────────────────────
            # Process the N freshest granules per sensor up-front so
            # the page reflects current activity even when there's a
            # multi-hour catch-up backlog behind the cursor. Each
            # frontfilled entry is tagged _source=frontfill so the
            # backfill cursor doesn't jump forward to it.
            #
            # Skipped entirely on manual --since-hours backfills (no
            # cursor in play; the caller wants the explicit window
            # processed in order). Also skipped when no operational
            # cursor exists (first-ever run) — let the normal first-
            # run path populate from fallback_hours instead.
            if args.operational:
                frontfill_start = time.time()
                frontfill_since = (_dt.now(timezone.utc)
                                   - timedelta(hours=_FRONTFILL_LOOKBACK_HOURS))
                logger.info(
                    "[frontfill] pulling freshest %d granules/sensor "
                    "since %s (budget %.0fs)",
                    _FRONTFILL_PER_SENSOR, frontfill_since.isoformat(),
                    _FRONTFILL_BUDGET_SECONDS)
                for sensor in sensors:
                    if (time.time() - frontfill_start
                            > _FRONTFILL_BUDGET_SECONDS):
                        logger.info("[frontfill] budget exhausted — "
                                    "switching to backfill phase")
                        break
                    try:
                        recent = list_pps_granules(sensor, frontfill_since)
                    except Exception as exc:
                        logger.warning(
                            "[frontfill][%s] listing failed: %s", sensor, exc)
                        continue
                    # PPS listing is ascending by scan_start; take the
                    # TAIL N (newest) and process newest-first.
                    freshest = list(reversed(recent[-_FRONTFILL_PER_SENSOR:]))
                    logger.info(
                        "[frontfill][%s] %d candidates in last %.1fh; "
                        "frontfilling %d newest",
                        sensor, len(recent), _FRONTFILL_LOOKBACK_HOURS,
                        len(freshest))
                    for url, scan_start in freshest:
                        if (time.time() - frontfill_start
                                > _FRONTFILL_BUDGET_SECONDS):
                            break
                        # Existence guard: a frontfill candidate whose
                        # rendered outputs are already in GCS is skipped
                        # BEFORE the expensive download+regrid+render —
                        # this is the main Jobs-cost saving. A genuinely
                        # new pass (no outputs yet) and any error/force
                        # case fall through to full processing.
                        fname = url.rsplit("/", 1)[-1]
                        if _frontfill_skip_granule(sensor, fname):
                            continue
                        _process_one_granule(
                            url, scan_start, sensor,
                            source_tag=_FRONTFILL_SOURCE_TAG)
                logger.info("[frontfill] phase complete in %.0fs",
                            time.time() - frontfill_start)

            # ── Backfill phase (cursor-based catch-up, oldest-first) ──
            # Runtime-budget flag — set when _MAX_RUNTIME_SECONDS is hit in
            # the inner loop; checked by the outer loop so we break out of
            # both. Manual --since-hours backfills also honor this so they
            # don't pile up if an operator forgot one running.
            budget_exceeded = False
            for sensor in sensors:
                if time.time() - start_time > _MAX_RUNTIME_SECONDS:
                    logger.warning("[budget] runtime budget exceeded (%.0fs) "
                                   "before starting sensor %s — exiting "
                                   "cleanly; next cron picks up",
                                   time.time() - start_time, sensor)
                    budget_exceeded = True
                    break
                if args.operational:
                    last = _last_processed_start_utc(sensor=sensor)
                    if last is None:
                        since = _dt.now(timezone.utc) - timedelta(hours=fallback_hours)
                        logger.info("[%s] no prior manifest entries — falling back "
                                    "to last %.1f h", sensor, fallback_hours)
                    else:
                        # +1s so we don't reprocess the boundary granule.
                        since = last + timedelta(seconds=1)
                else:
                    since = _dt.now(timezone.utc) - timedelta(hours=args.since_hours)
                logger.info("[%s] polling PPS for granules since %s",
                            sensor, since.isoformat())
                try:
                    granules = list_pps_granules(sensor, since)
                except Exception as exc:
                    logger.error("[%s] listing failed: %s — skipping", sensor, exc)
                    continue
                logger.info("[%s] found %d new granules to process",
                            sensor, len(granules))

                for idx, (url, scan_start) in enumerate(granules):
                    if time.time() - start_time > _MAX_RUNTIME_SECONDS:
                        logger.warning(
                            "[%s] runtime budget exceeded (%.0fs) — exiting "
                            "cleanly with %d granules remaining; next cron "
                            "picks up", sensor,
                            time.time() - start_time, len(granules) - idx)
                        budget_exceeded = True
                        break
                    _process_one_granule(url, scan_start, sensor,
                                         source_tag=None)
                if budget_exceeded:
                    break
        finally:
            if lock_held:
                _release_ingest_lock(execution_name)
    else:
        ap.error("Specify one of --tcprimed-file / --pps-file / "
                 "--since-hours / --operational")

    if all_entries and not args.no_manifest and not args.dry_run:
        update_manifest(all_entries)
    print(json.dumps({"processed": len(all_entries), "entries": all_entries[:3]},
                     indent=2, default=str))


if __name__ == "__main__":
    _cli()
