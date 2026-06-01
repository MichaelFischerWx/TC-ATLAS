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
import hashlib
import io
import json
import logging
import math
import os
import re
import threading

# Module-level logger so the various .warning() / .debug() calls in the
# shear endpoints (added during the env-profile + Helmholtz work) don't
# blow up with NameError when their except branches fire. Routes Python's
# logging through Cloud Run's default stderr capture.
logger = logging.getLogger("ir_monitor_api")
import time
import traceback
from collections import OrderedDict
from datetime import datetime as _dt, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import APIRouter, Header, HTTPException, Query, Request
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
    fetch_band_raw,
    compute_ir_vigor,
    render_vigor_png,
    BAND_RANGES,
    VIS_BAND,
    WV_BAND,
    SWIR_BAND,
)

from tc_center_fix import find_ir_center, apply_center_gates

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
_IR_FRAME_CACHE_MAX = 100       # max cached IR frames (~10 MB, covers ~7 storms)
_IR_FRAME_CACHE_TTL = 300       # 5 minutes per frame
# Minimum spacing between expensive background prefetch cycles. The storm
# list polls every _STORM_CACHE_TTL, but the satellites only scan every
# 10 min (Himawari + GOES Full Disk on 0/10/20/.../50), so re-rendering
# all bands more often than that is pure waste. Routine cycles are gated
# to this interval; storm-movement cycles bypass it (see _poll_active_storms).
_PREFETCH_MIN_INTERVAL_SEC = 540   # ~9 min — one poll short of 10 min

# When False (IR_INLINE_PREWARM=0) the in-process prewarm daemon and the
# on-demand prefetch thread-spawn are both disabled, so the API can run
# cpu-throttled (min=1) without burning always-allocated CPU. The prewarm
# render pipeline then runs in a separate Cloud Run Job (prewarm_job.py)
# on a Cloud Scheduler cadence. Default True keeps legacy inline behavior.
_INLINE_PREWARM = os.environ.get("IR_INLINE_PREWARM", "1") != "0"

# Render-once prewarm. When True (default) each immutable satellite scan-time
# is rendered ONCE — at the interpolated storm position it first resolved —
# and that position is recorded in a per-storm GCS manifest. Subsequent
# cycles read each frame back at its RECORDED position (stable across
# cycles) so the existing GCS cache short-circuit actually HITS, instead of
# re-interpolating a position that drifts past the 0.1° cache key and forces
# the whole 6h window to re-render every cycle. Steady state then renders
# only the ~1-2 genuinely-new leading-edge frames per storm (plus the forced
# self-heal window), cutting a ~290s/storm cycle to a few seconds and letting
# 4 storms finish well inside the 900s job timeout. Set IR_RENDER_ONCE=0 to
# restore the legacy re-interpolate-and-re-render-everything behavior.
_RENDER_ONCE = os.environ.get("IR_RENDER_ONCE", "1") != "0"

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
# rt-v10: cache keys now use the storm's INTERPOLATED track position at
# each frame's time (not the static advisory position), plus radius_deg.
# Together these fix two pre-existing cache misses:
#   - storm motion ≥ 0.5° causes round(lat/lon) to flip → all frames miss
#   - different radius_deg requests collided on the same key → wrong cutout
_GCS_RT_VERSION = "rt-v11"  # v11: Himawari geos→latlon reprojection wedge fix
                            # (perimeter-sampled geos window + true geos_extent;
                            # evicts pre-fix frames with rotated black corners)

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

def _pos_key(lat: float, lon: float, radius_deg: float = 10.0) -> str:
    """Cache-key fragment encoding (lat, lon, radius) for raw Tb frames.

    Callers MUST pass the storm's INTERPOLATED track position at the
    frame's time (not the current advisory position). Doing so keeps
    historical frames stable across cache reads — a frame from 6h ago
    is keyed by where the storm was 6h ago, so subsequent lookups
    re-interpolate to the same position and hit. The prior advisory-
    based scheme thrashed for any storm moving > 0.5° between cache
    write and read (which is most recurving Atlantic systems).

    Lat/lon rounded to 0.1° so very small numerical jitter in
    interpolation doesn't fragment cache entries. 0.1° ≈ 11 km is much
    smaller than any meaningful track adjustment, so distinct cached
    positions reflect real motion.

    Radius is included so requests with different cutout sizes (e.g.
    ±4° storm-relative vs ±10° wide-view) don't collide on the same key.
    """
    lat_r = round(lat * 10) / 10
    lon_r = round(lon * 10) / 10
    rad_r = round(radius_deg, 1)
    return f"{lat_r}_{lon_r}_r{rad_r}"


def _interp_pos_at(atcf_id: str, target_dt, fallback_lat: float,
                   fallback_lon: float) -> tuple[float, float]:
    """Return (lat, lon) for the storm at target_dt, interpolated from
    b-deck records when available. Falls back to (fallback_lat,
    fallback_lon) — typically the current advisory position — when no
    track data exists yet (newly-formed storms).

    Used to derive cache keys + cutout centers so historical frames
    persist under the storm's true historical position rather than
    its current position. _get_track_for_interp is 10-min TTL cached,
    so per-frame calls are cheap.
    """
    records = _get_track_for_interp(atcf_id)
    if records:
        pos = _interpolate_track_position(records, target_dt)
        if pos:
            return pos[0], pos[1]
    return fallback_lat, fallback_lon


def _gcs_rt_get(atcf_id: str, dt_str: str, lat: float = 0, lon: float = 0,
                radius_deg: float = 10.0) -> dict | None:
    """Try to read a cached raw Tb frame from GCS.

    lat/lon should be the INTERPOLATED storm position at the frame's
    time (see _pos_key)."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return None
    pk = _pos_key(lat, lon, radius_deg)
    key = f"{_GCS_RT_VERSION}/ir-raw/{atcf_id}/{pk}/{dt_str}.json"
    try:
        blob = bucket.blob(key)
        data = blob.download_as_bytes(timeout=5)
        return json.loads(data)
    except Exception:
        return None

def _gcs_rt_put(atcf_id: str, dt_str: str, frame: dict, lat: float = 0,
                lon: float = 0, radius_deg: float = 10.0):
    """Write a raw Tb frame to GCS (fire-and-forget background thread).

    lat/lon should be the INTERPOLATED storm position at the frame's
    time (see _pos_key)."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return
    pk = _pos_key(lat, lon, radius_deg)
    def _upload():
        key = f"{_GCS_RT_VERSION}/ir-raw/{atcf_id}/{pk}/{dt_str}.json"
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


# ── IR Center Fix Log (GCS persistent archive) ────────────────
_CENTER_FIX_LOG_KEY = "ir-center-fix-log.txt"
_center_fix_log_buf = []
_center_fix_log_lock = threading.Lock()
_CENTER_FIX_FLUSH_SIZE = 5  # flush to GCS every N entries


def _log_center_fix(atcf_id, storm_name, frame_dt, satellite, cfix):
    """Buffer a center-fix log entry and flush to GCS when buffer is full."""
    now = _dt.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if cfix and cfix.get("success"):
        line = (
            f"{now}\t{atcf_id}\t{storm_name}\t{frame_dt}\t{satellite}"
            f"\t{cfix['lat']}\t{cfix['lon']}"
            f"\t{cfix['eye_score']}\t{cfix['ir_rad_dif']}\t{cfix['mean_std']}"
        )
    else:
        # Include failure diagnostics if available
        reason = cfix.get("reason", "unknown") if cfix else "null"
        best_s = cfix.get("best_score", "nan") if cfix else "nan"
        best_d = cfix.get("best_ir_rad_dif", "nan") if cfix else "nan"
        vfrac = cfix.get("valid_frac", "nan") if cfix else "nan"
        ncand = cfix.get("n_candidates", "nan") if cfix else "nan"
        line = (
            f"{now}\t{atcf_id}\t{storm_name}\t{frame_dt}\t{satellite}"
            f"\tnan\tnan\t{best_s}\t{best_d}\tnan"
            f"\t{reason}\t{vfrac}\t{ncand}"
        )
    with _center_fix_log_lock:
        _center_fix_log_buf.append(line)
        if len(_center_fix_log_buf) >= _CENTER_FIX_FLUSH_SIZE:
            _flush_center_fix_log()


def _flush_center_fix_log():
    """Append buffered log lines to GCS. Called with lock held."""
    global _center_fix_log_buf
    if not _center_fix_log_buf:
        return
    lines = _center_fix_log_buf
    _center_fix_log_buf = []

    def _upload():
        bucket = _get_rt_gcs_bucket()
        if bucket is None:
            return
        try:
            blob = bucket.blob(_CENTER_FIX_LOG_KEY)
            # Download existing log, append new lines
            try:
                existing = blob.download_as_text(timeout=10)
            except Exception:
                existing = (
                    "timestamp\tatcf_id\tstorm_name\tframe_dt\tsatellite"
                    "\tfix_lat\tfix_lon\teye_score\tir_rad_dif\tmean_std\n"
                )
            existing += "\n".join(lines) + "\n"
            blob.upload_from_string(existing, content_type="text/plain", timeout=15)
        except Exception:
            pass

    threading.Thread(target=_upload, daemon=True).start()


def _gcs_band_get(band: int, atcf_id: str, dt_str: str, lat: float = 0, lon: float = 0) -> dict | None:
    """Try to read a cached band frame from GCS."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return None
    pk = _pos_key(lat, lon)
    key = f"{_GCS_RT_VERSION}/band-raw/{band}/{atcf_id}/{pk}/{dt_str}.json"
    try:
        blob = bucket.blob(key)
        data = blob.download_as_bytes(timeout=5)
        return json.loads(data)
    except Exception:
        return None


def _gcs_band_put(band: int, atcf_id: str, dt_str: str, frame: dict, lat: float = 0, lon: float = 0):
    """Write a band frame to GCS (fire-and-forget background thread)."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return
    pk = _pos_key(lat, lon)
    def _upload():
        key = f"{_GCS_RT_VERSION}/band-raw/{band}/{atcf_id}/{pk}/{dt_str}.json"
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


# ── Per-storm frame manifest (render-once) ─────────────────────────
# Maps each rendered scan-time slot ("YYYYMMDDHHMM") → the interpolated
# storm position it was rendered at: {"lat", "lon", "radius_deg"}. A past
# 10-min satellite scan is immutable, so once rendered we keep using the
# SAME cutout center forever; this lets both the prewarm short-circuit and
# the bundle builder read each frame at the exact key it was written —
# instead of re-interpolating a position that drifts past the 0.1° cache
# key between cycles and silently re-renders the whole window. See
# _RENDER_ONCE.
_MANIFEST_PREFIX = f"{_GCS_RT_VERSION}/frame-manifest"


def _gcs_rt_exists(atcf_id: str, dt_str: str, lat: float = 0, lon: float = 0,
                   radius_deg: float = 10.0) -> bool:
    """Cheap existence check (HEAD-equivalent, no data transfer) for a cached
    raw Tb frame. Used by the prewarm skip path so render-once doesn't
    download the full ~2 MB frame just to learn it's already there."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return False
    pk = _pos_key(lat, lon, radius_deg)
    key = f"{_GCS_RT_VERSION}/ir-raw/{atcf_id}/{pk}/{dt_str}.json"
    try:
        return bucket.blob(key).exists()
    except Exception:
        return False


def _gcs_band_exists(band: int, atcf_id: str, dt_str: str,
                     lat: float = 0, lon: float = 0) -> bool:
    """Cheap existence check for a cached band frame (see _gcs_rt_exists)."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return False
    pk = _pos_key(lat, lon)
    key = f"{_GCS_RT_VERSION}/band-raw/{band}/{atcf_id}/{pk}/{dt_str}.json"
    try:
        return bucket.blob(key).exists()
    except Exception:
        return False


def _gcs_manifest_get(atcf_id: str) -> dict:
    """Load the per-storm render-once frame manifest from GCS. Returns {}
    on miss or any error (treated as 'nothing rendered yet')."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return {}
    key = f"{_MANIFEST_PREFIX}/{atcf_id.upper()}.json"
    try:
        blob = bucket.blob(key)
        data = blob.download_as_bytes(timeout=5)
        m = json.loads(data)
        return m if isinstance(m, dict) else {}
    except Exception:
        return {}


def _gcs_manifest_put(atcf_id: str, manifest: dict):
    """Write the per-storm frame manifest to GCS. SYNCHRONOUS (not fire-and-
    forget): the Cloud Run Job process exits as soon as the prewarm cycle
    returns, so a background upload thread could be killed before it flushes.
    A lost manifest just means the next cycle re-renders the window once."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return
    key = f"{_MANIFEST_PREFIX}/{atcf_id.upper()}.json"
    try:
        blob = bucket.blob(key)
        blob.upload_from_string(
            json.dumps(manifest, separators=(",", ":")),
            content_type="application/json",
            timeout=15,
        )
    except Exception as ex:
        print(f"[Prewarm Manifest] {atcf_id}: write failed: {ex}")


# ── Pre-built bundle artifacts (Item 6) ────────────────────────────
# Same wire format as the API bundle endpoints. Written by the prewarm
# loop to a public-read GCS path so the frontend can fetch directly
# from storage.googleapis.com — Cloud Run never sees the request on a
# cache hit, saving the TLS+routing round-trip (~200-400 ms).

def _pack_bundle(header: dict, payloads: list) -> bytes:
    """[uint32 LE header_length][header JSON][concat payloads]."""
    import struct
    header_json = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(header_json)) + header_json + b"".join(payloads)


def _upload_public_bundle(key: str, body: bytes, content_type: str = "application/octet-stream",
                          gzip_content: bool = False):
    """Upload bundle bytes to GCS with publicRead ACL + 5-min max-age.

    If `gzip_content=True`, the body is gzipped before upload and the
    GCS blob is tagged with Content-Encoding: gzip. Modern browsers
    transparently decompress, so the frontend's r.arrayBuffer() yields
    the decompressed bytes — no client-side decode needed.

    Only worth setting for high-entropy payloads (raw Tb uint8 arrays):
    WebP/JPEG/PNG are already entropy-coded and gzipping them wastes
    CPU for ~2-5% gain.
    """
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return
    try:
        if gzip_content:
            import gzip as _gz
            body = _gz.compress(body, compresslevel=6)
        blob = bucket.blob(key)
        blob.cache_control = "public, max-age=300"
        if gzip_content:
            blob.content_encoding = "gzip"
        blob.upload_from_string(
            body, content_type=content_type,
            predefined_acl="publicRead", timeout=30,
        )
    except Exception as ex:
        print(f"[Bundle Pre-build] upload {key} failed: {ex}")


def _gcs_rt_version_put():
    """Publish the current RT cache version to rt-version.json at the
    bucket root so the frontend can discover it at runtime and avoid
    serving a frozen old-version bundle after a server-side version bump
    (the frontend fetches bundles directly from GCS, so it can't see
    _GCS_RT_VERSION otherwise). Cheap (~30 bytes), idempotent; called
    once per prewarm cycle."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return
    try:
        blob = bucket.blob("rt-version.json")
        blob.cache_control = "public, max-age=120"
        blob.upload_from_string(
            json.dumps({"version": _GCS_RT_VERSION}),
            content_type="application/json",
            predefined_acl="publicRead", timeout=15,
        )
    except Exception as ex:
        print(f"[Prewarm] rt-version.json upload failed: {ex}")


# Anomalous-scan screen. Frames are uniform size/bounds, but a bad scan
# substitution can slip an offset/wrong image into one slot — it looks
# distorted in the loop even though geometry is fine. We catch it by
# comparing each frame's imagery to its two temporal neighbors: a frame is
# anomalous if it differs from BOTH neighbors far more than they differ
# from each other (the "pops out and comes back" signature). Genuine rapid
# evolution is monotonic (neighbors progressively differ) and is NOT
# flagged. Tuned from observed data: normal 10-min mean-abs-diff ~7 on a
# 0–255 grayscale; a bad substitution measured ~46 vs neighbors that
# agreed at ~13.
_ANOM_RATIO = 2.5       # flag if both neighbor diffs exceed RATIO × the neighbor-pair diff
_ANOM_ABS_FLOOR = 20.0  # …and exceed this absolute MAD (avoids flagging quiet periods)

# Low-contrast reflectance override (Visible / SWIR). The IR-tuned floor above
# (20 on a 0–255 scale) is BLIND to a stale-scan substitution in the Visible
# channel near sunrise/sunset: the scene then occupies only ~10–45 counts, so a
# genuine "pops out and comes back" outlier measures MAD ~13–16 vs neighbors
# (normal evolution ~2.7) yet sits UNDER the 20 floor and ships. Observed live on
# Jangmi (WP062026) 22:20 UTC: an older/smoother substituted scan with
# d_prev/d_next = 13.4/15.8 (neighbors agreed at 5.4) passed the IR floor.
# These lower the floor and ratio for the reflectance-like products so the screen
# catches that regime; the ratio term still scales with the prev↔next span, so
# fast-but-monotonic illumination changes are not flagged.
_ANOM_RATIO_VIS = 2.0
_ANOM_ABS_FLOOR_VIS = 8.0

# Reflectance-band (Visible) dim-out screen. The MAD screen above is blind to
# a bad/low-gain Visible scan near sunrise/sunset: twilight frames are all
# near-black, so even a real dropout sits under _ANOM_ABS_FLOOR (tuned for
# high-contrast IR). But the sun only ramps illumination one way through a
# pass, so a daytime reflectance frame should never be DARKER than both its
# temporal neighbors. We flag a clear brightness local-minimum instead.
_VIS_DROPOUT_FRAC = 0.80      # flag if frame mean < FRAC × the dimmer neighbor's mean
_VIS_DROPOUT_MIN_BRIGHT = 12.0  # …and both neighbors are this bright (i.e. it's daylight,
                                # not the near-black twilight floor where the ratio is noise)

# Per-storm set of frame slot keys ("YYYYMMDDHHMM") flagged anomalous in the
# last bundle build. The prewarm pops this at the start of each cycle and
# FORCE-refetches those frames (bypassing the cache short-circuit) so a
# poisoned frame anywhere in the window — not just the newest few — gets a
# fresh scan and self-heals. Bundle builds re-populate it for the next
# cycle; a frame that re-fetches clean drops out, one that's still bad keeps
# retrying until its real scan lands or it ages out of the window.
_anomalous_heal_times: dict = {}
_anomalous_heal_lock = threading.Lock()


def _flag_anomalous_frames(jpgs: list, band: int | None = None,
                           is_day: list | None = None) -> set:
    """Return the set of frame indices whose imagery is a strong outlier vs
    BOTH immediate temporal neighbors (likely a bad scan substitution).
    `jpgs` is a list of encoded image bytes or None (missing frame).

    A second, brightness-based test also flags daytime reflectance dim-out
    scans the MAD screen misses near the day/night terminator (see
    _VIS_DROPOUT_FRAC). It runs when `band == VIS_BAND` (the Visible product,
    where every present frame is daytime reflectance), OR when `is_day` is
    supplied (the GeoColor composite, a day-Band-2/night-Band-13 mix): there
    only daytime-interior frames are screened and only daytime frames serve as
    neighbors, since a night IR neighbor's brightness is unrelated to
    illumination. Emissive bands (WV/SWIR) and IR pass `band=None`/`is_day=None`
    and get the MAD screen only.

    Fail-open: returns an empty set on any decode/dependency error so a
    detection hiccup never blocks bundling."""
    try:
        import numpy as np
        from PIL import Image
        import io as _io
    except Exception:
        return set()

    n = len(jpgs)
    thumbs = [None] * n
    for i, b in enumerate(jpgs):
        if not b:
            continue
        try:
            im = Image.open(_io.BytesIO(b)).convert("L").resize((64, 64))
            thumbs[i] = np.asarray(im, dtype=np.float32)
        except Exception:
            thumbs[i] = None

    def _mad(a, b):
        return float(np.abs(a - b).mean())

    # Visible/SWIR are low-contrast reflectance-like products: use a floor/ratio
    # scaled to their narrow working range so sunrise/sunset substitutions aren't
    # masked by the IR-tuned floor. Emissive IR/WV keep the high-contrast tuning.
    low_contrast = band is not None and band in (VIS_BAND, SWIR_BAND)
    anom_ratio = _ANOM_RATIO_VIS if low_contrast else _ANOM_RATIO
    anom_floor = _ANOM_ABS_FLOOR_VIS if low_contrast else _ANOM_ABS_FLOOR

    flagged = set()
    for i in range(n):
        ti = thumbs[i]
        if ti is None:
            continue
        # Nearest PRESENT neighbor on each side — skip over missing slots so a
        # degraded frame sitting next to a data gap is still triangulated.
        # (The original immediate-neighbor form silently skipped exactly this
        # case: a bad scan whose adjacent slot is itself missing — the real
        # WV failure mode where the prior scan didn't disseminate.) The d_skip
        # term still scales the threshold to the prev↔next span, so genuine
        # evolution across the gap isn't mistaken for an anomaly.
        tp = next((thumbs[j] for j in range(i - 1, -1, -1) if thumbs[j] is not None), None)
        tq = next((thumbs[j] for j in range(i + 1, n) if thumbs[j] is not None), None)
        if tp is None or tq is None:
            continue
        d_prev = _mad(ti, tp)
        d_next = _mad(ti, tq)
        d_skip = _mad(tp, tq)
        thr = max(anom_floor, anom_ratio * d_skip)
        if d_prev > thr and d_next > thr:
            flagged.add(i)

    # Reflectance dim-out screen: a daytime reflectance frame should never be
    # a brightness local-minimum (the sun ramps illumination monotonically
    # through a pass). Catches low-gain/partial Vis scans near sunrise/sunset
    # whose near-black MADs fall under _ANOM_ABS_FLOOR. Runs for the Visible
    # product (band == VIS_BAND) and, gated by `is_day`, for the GeoColor
    # composite's daytime Band-2 frames. For GeoColor we screen only daytime
    # frames and only treat daytime frames as neighbors, since a night Band-13
    # neighbor's brightness ≠ illumination. Skipped entirely for emissive
    # bands (WV/SWIR) and IR.
    run_dimout = (band is not None and band == VIS_BAND) or (is_day is not None)
    if run_dimout:
        means = [float(t.mean()) if t is not None else None for t in thumbs]

        def _usable(j):
            # A neighbor is usable if it has imagery and — for GeoColor — is a
            # daytime frame (so we never compare against inverted night IR).
            return means[j] is not None and (is_day is None or is_day[j])

        for i in range(n):
            mi = means[i]
            if mi is None or i in flagged:
                continue
            # GeoColor: only screen daytime-interior frames.
            if is_day is not None and not is_day[i]:
                continue
            mp = next((means[j] for j in range(i - 1, -1, -1) if _usable(j)), None)
            mq = next((means[j] for j in range(i + 1, n) if _usable(j)), None)
            if mp is None or mq is None:
                continue
            dimmer = min(mp, mq)
            # Only meaningful once both neighbors are daylight-bright — below
            # that floor the ratio is just twilight noise.
            if dimmer >= _VIS_DROPOUT_MIN_BRIGHT and mi < dimmer * _VIS_DROPOUT_FRAC:
                flagged.add(i)
    return flagged


def _screen_and_queue_anomalies(atcf_upper: str, times_oldest_first: list,
                                jpgs: list, label: str = "",
                                band: int | None = None,
                                is_day: list | None = None) -> set:
    """Flag anomalous frames in `jpgs` (encoded image bytes or None,
    oldest-first, aligned with `times_oldest_first`), queue their slot keys
    for force-refetch on the next prewarm cycle (self-heal), and return the
    flagged index set.

    Shared by the IR bundle, the prebuilt WV bundle, and the on-demand band
    bundle so every product we ship (IR/WV/SWIR/Vis) gets the same "pops out
    and comes back" screen. The prewarm pops `_anomalous_heal_times` and
    force-refetches ALL bands for each queued slot, so a frame flagged on any
    one product heals across products. `label` tags the log line. `band` and
    `is_day` are forwarded to enable the reflectance dim-out screen (Visible
    via `band`, GeoColor's daytime frames via `is_day`)."""
    anomalous_idx = _flag_anomalous_frames(jpgs, band=band, is_day=is_day)
    if anomalous_idx:
        bad_keys = {times_oldest_first[i].strftime("%Y%m%d%H%M")
                    for i in anomalous_idx}
        with _anomalous_heal_lock:
            _anomalous_heal_times.setdefault(atcf_upper, set()).update(bad_keys)
        _bad = [times_oldest_first[i].strftime("%H%M") for i in sorted(anomalous_idx)]
        tag = f" {label}" if label else ""
        print(f"[Bundle Pre-build] {atcf_upper}:{tag} dropping "
              f"{len(anomalous_idx)} anomalous scan frame(s) {_bad} "
              f"(queued for self-heal)")
    return anomalous_idx


def _bundle_pos_for(atcf_id, ft, fallback_lat, fallback_lon, manifest):
    """Position for a frame during bundle assembly: prefer the
    manifest-recorded render position (so the GCS read key matches what the
    prewarm wrote and the cache short-circuit hits), else fall back to a
    fresh interpolation. Falling back is also exactly the legacy behavior
    when _RENDER_ONCE is off or the slot isn't in the manifest yet."""
    if _RENDER_ONCE and manifest:
        ent = manifest.get(ft.strftime("%Y%m%d%H%M"))
        if ent:
            return ent["lat"], ent["lon"]
    return _interp_pos_at(atcf_id, ft, fallback_lat, fallback_lon)


def _build_and_upload_bundles(
    atcf_id: str, fallback_lat: float, fallback_lon: float,
    frame_times, radius_deg: float, lookback_hours: float, interval_min: int,
    band: int | None = None, manifest: dict | None = None,
):
    """Assemble the display-WebP + raw-Tb bundles for one storm and
    write them to public-read GCS paths. Mirrors the wire format
    produced by /ir-frames-bundle and /ir-raw-bundle so the frontend
    can consume either source interchangeably.

    Reads exclusively from already-warmed GCS caches (no S3 fetches
    here) — the per-frame loop that just ran took care of that. If a
    frame is missing from cache for any reason it's marked as
    byte_length=0 with an error field; the frontend skips it.

    If `band` is given, that band's display bundle is also built (via
    `_build_band_bundle`). The IR display/raw bundles are identical
    regardless of which band we're warming, so a cycle that warms several
    bands (WV + SWIR + Vis) builds the IR bundle ONCE here and calls
    `_build_band_bundle` directly for the rest — avoiding re-reading and
    re-uploading the ~80 MB raw-Tb bundle two extra times per cycle.
    """
    atcf_upper = atcf_id.upper()
    # frame_times comes in newest-first; bundles use oldest-first
    times_oldest_first = list(reversed(list(frame_times)))
    half = radius_deg

    def _pos_for(ft):
        return _bundle_pos_for(atcf_id, ft, fallback_lat, fallback_lon, manifest)

    # Pre-pass: interpolated positions + display WebPs for every frame, so
    # we can screen for anomalous scans (a bad substitution that slipped in
    # upstream) BEFORE shipping the bundle. Flagged frames are dropped to
    # no-data stubs so the loop cleanly skips them instead of showing a
    # visibly distorted frame. Reuses these values in the main loop below
    # (no extra GCS reads or position interpolations).
    interp_pos = [_pos_for(ft) for ft in times_oldest_first]
    jpgs_pre = [
        _gcs_jpg_get(atcf_upper, ft.strftime("%Y%m%d%H%M"),
                     lat=interp_pos[i][0], lon=interp_pos[i][1])
        for i, ft in enumerate(times_oldest_first)
    ]
    anomalous_idx = _screen_and_queue_anomalies(
        atcf_upper, times_oldest_first, jpgs_pre, label="IR")

    # Single pass: read both jpg + raw caches per frame. The raw cache
    # carries center_fix (IR-derived eye position), which we now ALSO
    # embed in the display bundle header so the satellite viewer's
    # follow-storm toggle can recenter accurately from the moment the
    # display bundle lands — without waiting for the raw Tb bundle.
    frame_hdrs = []
    raw_hdrs = []
    payloads_jpg = []
    payloads_raw = []
    jpg_offset = 0
    raw_offset = 0
    summary_sat = ""
    for i, ft in enumerate(times_oldest_first):
        dt_str = ft.strftime("%Y%m%d%H%M")
        iso_dt = ft.strftime("%Y-%m-%dT%H:%M:%SZ")
        ilat, ilon = interp_pos[i]
        fb = [[ilat - half, ilon - half], [ilat + half, ilon + half]]

        # Raw cache read first (carries center_fix we want for display too)
        cached = _gcs_rt_get(atcf_upper, dt_str,
                            lat=ilat, lon=ilon, radius_deg=radius_deg)
        center_fix = cached.get("center_fix") if cached else None

        # ── Display bundle entry ────────────────────────
        # Pre-fetched above. Drop frames flagged as anomalous scans so the
        # loop skips them rather than shipping a distorted frame.
        jpg = jpgs_pre[i]
        if not jpg or i in anomalous_idx:
            frame_hdrs.append({
                "index": i, "datetime_utc": iso_dt, "satellite": "",
                "bounds": fb, "byte_offset": jpg_offset, "byte_length": 0,
                "center_fix": center_fix,
                "error": "anomalous_scan" if (jpg and i in anomalous_idx) else "no_cached_jpg",
            })
        else:
            bucket_name, _ = select_goes_sat(ilon, ft)
            sat_name = satellite_name_from_bucket(bucket_name)
            frame_hdrs.append({
                "index": i, "datetime_utc": iso_dt, "satellite": sat_name,
                "bounds": fb, "byte_offset": jpg_offset, "byte_length": len(jpg),
                "center_fix": center_fix,
            })
            payloads_jpg.append(jpg)
            jpg_offset += len(jpg)
            summary_sat = sat_name or summary_sat

        # ── Raw Tb bundle entry ────────────────────────
        if not cached or not cached.get("tb_data"):
            raw_hdrs.append({
                "index": i, "datetime_utc": iso_dt,
                "tb_rows": 0, "tb_cols": 0,
                "byte_offset": raw_offset, "byte_length": 0,
                "error": "no_cached_tb",
            })
            continue
        try:
            tb_bytes = base64.b64decode(cached["tb_data"])
        except Exception as ex:
            raw_hdrs.append({
                "index": i, "datetime_utc": iso_dt,
                "tb_rows": 0, "tb_cols": 0,
                "byte_offset": raw_offset, "byte_length": 0,
                "error": f"decode: {ex}",
            })
            continue
        rows = int(cached["tb_rows"])
        cols = int(cached["tb_cols"])
        raw_hdrs.append({
            "index": i,
            "datetime_utc": cached.get("datetime_utc", iso_dt),
            "satellite": cached.get("satellite", ""),
            "tb_rows": rows, "tb_cols": cols,
            "byte_offset": raw_offset, "byte_length": rows * cols,
            "bounds": cached.get("bounds"),
            "center_fix": center_fix,
        })
        payloads_raw.append(tb_bytes)
        raw_offset += rows * cols

    # Summary bounds: latest frame's interpolated position
    latest_ft = times_oldest_first[-1] if times_oldest_first else _dt.now(timezone.utc)
    s_ilat, s_ilon = _pos_for(latest_ft)
    frames_header = {
        "total_frames": len(times_oldest_first),
        "bounds": [[s_ilat - half, s_ilon - half], [s_ilat + half, s_ilon + half]],
        "satellite": summary_sat,
        "lookback_hours": lookback_hours,
        "interval_min": interval_min,
        "radius_deg": radius_deg,
        "media_type": "image/webp",
        "frames": frame_hdrs,
    }
    frames_body = _pack_bundle(frames_header, payloads_jpg)

    raw_header = {
        "total_frames": len(times_oldest_first),
        "tb_vmin": _TB_VMIN,
        "tb_vmax": _TB_VMAX,
        "lookback_hours": lookback_hours,
        "interval_min": interval_min,
        "radius_deg": radius_deg,
        "frames": raw_hdrs,
    }
    raw_body = _pack_bundle(raw_header, payloads_raw)

    # Upload IR display + raw bundles. Pathing matches the frontend's
    # _gcsFramesBundleUrl / _gcsRawBundleUrl helpers in realtime_ir.js.
    # Display WebPs are already codec-compressed (gzip would gain ~2%
    # for 5-50ms of CPU — not worth it). Raw Tb uint8 arrays have
    # strong spatial correlation (smooth cloud features → repeated/
    # similar bytes) — gzip shrinks them ~30-50%, saving ~2 MB per
    # raw-Tb load with imperceptible browser decode cost.
    frames_key = f"{_GCS_RT_VERSION}/bundles/frames/{atcf_upper}.bin"
    raw_key = f"{_GCS_RT_VERSION}/bundles/raw/{atcf_upper}.bin"
    _upload_public_bundle(frames_key, frames_body)
    _upload_public_bundle(raw_key, raw_body, gzip_content=True)

    # (Removed: separate animated-WebP build. The frames bundle above
    # IS the animation source — sat_quick.js animates by swapping <img>
    # src across the 25 blob URLs sliced from `frames_body`. No need to
    # encode a second artifact at ~the same size for marginal savings.)

    print(f"[Bundle Pre-build] {atcf_upper}: frames={len(payloads_jpg)} "
          f"({len(frames_body)//1024} KB), raw={len(payloads_raw)} "
          f"({len(raw_body)//1024} KB)")

    # ── Band bundle (WV / SWIR / Vis) ───────────────────────────
    # Built separately so extra bands in the same cycle don't rebuild the
    # IR display/raw bundles above. s_ilat/s_ilon (latest-frame position)
    # feed the band header's summary bounds.
    if band is not None:
        _build_band_bundle(
            atcf_id, fallback_lat, fallback_lon, times_oldest_first,
            half, s_ilat, s_ilon, band, manifest,
            lookback_hours, interval_min, radius_deg)


def _build_band_bundle(
    atcf_id: str, fallback_lat: float, fallback_lon: float,
    times_oldest_first, half: float, s_ilat: float, s_ilon: float,
    band: int, manifest: dict | None,
    lookback_hours: float, interval_min: int, radius_deg: float,
):
    """Assemble + upload ONE band's display-WebP bundle (WV / SWIR / Vis).

    Split out of `_build_and_upload_bundles` so a cycle warming several
    bands builds the shared IR display + raw-Tb bundles only ONCE, then
    calls this per band — avoiding re-reading/re-uploading the ~80 MB
    raw-Tb bundle two extra times per cycle. Reads exclusively from the
    already-warmed `band{N}-webp` GCS caches (no S3 fetches here)."""
    atcf_upper = atcf_id.upper()

    def _pos_for(ft):
        return _bundle_pos_for(atcf_id, ft, fallback_lat, fallback_lon, manifest)

    # Pre-pass: positions + cached band JPGs for every frame, so we can
    # screen for anomalous scans (same "pops out and comes back" check
    # the IR bundle uses) BEFORE shipping. Nighttime Vis frames stay None
    # — expected-missing, never triangulated.
    band_pos = [_pos_for(ft) for ft in times_oldest_first]
    band_night = [
        band == VIS_BAND and _solar_elevation(band_pos[i][0], band_pos[i][1], ft) < -6
        for i, ft in enumerate(times_oldest_first)
    ]
    bjpgs_pre = [
        None if band_night[i]
        else _gcs_jpg_get(atcf_upper, ft.strftime("%Y%m%d%H%M"),
                          band=band, lat=band_pos[i][0], lon=band_pos[i][1])
        for i, ft in enumerate(times_oldest_first)
    ]
    band_anom_idx = _screen_and_queue_anomalies(
        atcf_upper, times_oldest_first, bjpgs_pre, label=f"band{band}",
        band=band)

    band_hdrs = []
    payloads_band: list[bytes] = []
    boffset = 0
    b_summary_sat = ""
    for i, ft in enumerate(times_oldest_first):
        iso_dt = ft.strftime("%Y-%m-%dT%H:%M:%SZ")
        ilat, ilon = band_pos[i]
        fb = [[ilat - half, ilon - half], [ilat + half, ilon + half]]

        # Vis is daytime-only — mark night frames as expected-missing
        if band_night[i]:
            band_hdrs.append({
                "index": i, "datetime_utc": iso_dt, "satellite": "",
                "bounds": fb, "byte_offset": boffset, "byte_length": 0,
                "error": "nighttime",
            })
            continue

        bjpg = bjpgs_pre[i]
        if not bjpg or i in band_anom_idx:
            band_hdrs.append({
                "index": i, "datetime_utc": iso_dt, "satellite": "",
                "bounds": fb, "byte_offset": boffset, "byte_length": 0,
                "error": "anomalous_scan" if (bjpg and i in band_anom_idx) else "no_cached_jpg",
            })
            continue
        bucket_name, _ = select_goes_sat(ilon, ft)
        sat_name = satellite_name_from_bucket(bucket_name)
        band_hdrs.append({
            "index": i, "datetime_utc": iso_dt, "satellite": sat_name,
            "bounds": fb, "byte_offset": boffset, "byte_length": len(bjpg),
        })
        payloads_band.append(bjpg)
        boffset += len(bjpg)
        b_summary_sat = sat_name or b_summary_sat

    binfo = BAND_RANGES.get(band, BAND_RANGES[13])
    band_header = {
        "total_frames": len(times_oldest_first),
        "bounds": [[s_ilat - half, s_ilon - half],
                   [s_ilat + half, s_ilon + half]],
        "satellite": b_summary_sat,
        "band": band,
        "data_type": binfo["data_type"],
        "vmin": binfo["vmin"],
        "vmax": binfo["vmax"],
        "lookback_hours": lookback_hours,
        "interval_min": interval_min,
        "radius_deg": radius_deg,
        "media_type": "image/webp",
        "frames": band_hdrs,
    }
    band_body = _pack_bundle(band_header, payloads_band)
    band_key = f"{_GCS_RT_VERSION}/bundles/band/{band}/{atcf_upper}.bin"
    _upload_public_bundle(band_key, band_body)
    print(f"[Bundle Pre-build] {atcf_upper}: band{band}={len(payloads_band)} "
          f"({len(band_body)//1024} KB)")


def _solar_elevation(lat: float, lon: float, dt: _dt) -> float:
    """Approximate solar elevation angle in degrees at (lat, lon, dt)."""
    utc = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
    day_of_year = utc.timetuple().tm_yday
    # Solar declination (approximate)
    decl = -23.44 * math.cos(math.radians(360 / 365 * (day_of_year + 10)))
    # Hour angle
    utc_hours = utc.hour + utc.minute / 60.0 + utc.second / 3600.0
    ha = (utc_hours - 12.0) * 15.0 + lon
    # Solar elevation
    lat_r = math.radians(lat)
    decl_r = math.radians(decl)
    ha_r = math.radians(ha)
    sin_elev = (math.sin(lat_r) * math.sin(decl_r) +
                math.cos(lat_r) * math.cos(decl_r) * math.cos(ha_r))
    return math.degrees(math.asin(max(-1, min(1, sin_elev))))


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
_last_prefetch_time: float = 0.0

_ir_frame_cache: OrderedDict = OrderedDict()
_ir_frame_cache_lock = threading.Lock()

# Best-track interpolation cache for center-fix initial guess
# Stores (datetime, lat, lon) tuples per storm for time-aware position estimates
_track_interp_cache: dict = {}   # {ATCF_ID: {"records": [(dt, lat, lon), ...], "ts": float}}
_TRACK_INTERP_TTL = 600          # 10 min — B-deck updates are at most 6-hourly

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

# JTWC-owned basins — used to know when to fetch the wp/io/sh web.txt
# advisory for the official "MOVEMENT PAST SIX HOURS" line.
_JTWC_BASINS = {"WP", "IO", "SH"}


# Motion cache: per-storm advisory-text-derived (dir, speed). Keyed by
# uppercase ATCF id. TTL matches the 6-hourly JTWC advisory cycle —
# refreshing more often than that hits the Navy server pointlessly.
_motion_cache: dict[str, dict] = {}
_motion_cache_lock = threading.Lock()
_MOTION_CACHE_TTL_S = 6 * 60 * 60


def _fetch_jtwc_motion(atcf_id: str) -> tuple[float | None, float | None]:
    """Fetch the latest JTWC web.txt advisory and parse the
    MOVEMENT PAST SIX HOURS line to recover (motion_deg, motion_kt).
    Returns (None, None) if the advisory is unreachable or the line
    isn't present. Cached for 6 h to be respectful to the Navy server."""
    aid = atcf_id.upper()
    with _motion_cache_lock:
        hit = _motion_cache.get(aid)
        if hit and (time.time() - hit["t"]) < _MOTION_CACHE_TTL_S:
            return hit["deg"], hit["kt"]

    # JTWC URL: wp0626 → wp{NN}{YY}web.txt where NN=storm number, YY=2-digit year
    # ATCF id is like "WP062026" → wp0626web.txt
    basin = aid[:2].lower()
    if basin not in {"wp", "io", "sh"}:
        return None, None
    # Year on the wire is 2-digit. ATCF id has 4-digit year at the end.
    storm_num = aid[2:4]  # 06
    year_2 = aid[-2:]     # 26
    url = (
        f"https://www.metoc.navy.mil/jtwc/products/"
        f"{basin}{storm_num}{year_2}web.txt"
    )
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "tc-atlas/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            text = resp.read().decode("utf-8", errors="ignore")
    except Exception:
        with _motion_cache_lock:
            _motion_cache[aid] = {"t": time.time(), "deg": None, "kt": None}
        return None, None

    # Format: "MOVEMENT PAST SIX HOURS - 335 DEGREES AT 07 KTS"
    m = re.search(
        r"MOVEMENT\s+PAST\s+SIX\s+HOURS\s*-\s*(\d{1,3})\s*DEGREES?\s+AT\s+(\d{1,3})\s*KTS?",
        text, re.IGNORECASE,
    )
    if not m:
        with _motion_cache_lock:
            _motion_cache[aid] = {"t": time.time(), "deg": None, "kt": None}
        return None, None
    try:
        deg = float(m.group(1))
        kt = float(m.group(2))
    except ValueError:
        return None, None
    with _motion_cache_lock:
        _motion_cache[aid] = {"t": time.time(), "deg": deg, "kt": kt}
    return deg, kt


def _compute_motion_from_records(records: list) -> tuple[float | None, float | None]:
    """Records-based fallback for storms without a JTWC web.txt advisory
    (Atlantic, EPac, CPac NHC storms). Use the most recent two tau=0
    fixes ≥ 3 h apart and compute great-circle bearing + speed in kt.
    Returns (None, None) if there aren't enough fixes."""
    t0 = [r for r in records if r.get("tau") == 0]
    if len(t0) < 2:
        return None, None
    # Prefer fixes from the BEST/JTWC/CARQ track only (skip forecasts).
    track = [r for r in t0 if r.get("tech") in ("BEST", "JTWC", "CARQ", "OFCL")]
    if len(track) < 2:
        track = t0
    track = sorted(track, key=lambda r: r["datetime"])
    latest = track[-1]
    # Walk backwards looking for the most recent fix at least 3 h earlier.
    prior = None
    for r in reversed(track[:-1]):
        dt_h = (latest["datetime"] - r["datetime"]).total_seconds() / 3600.0
        if dt_h >= 3.0:
            prior = r
            break
    if not prior:
        return None, None

    # Haversine bearing + distance.
    lat1 = math.radians(prior["lat"])
    lat2 = math.radians(latest["lat"])
    dlon = math.radians(latest["lon"] - prior["lon"])
    # Bearing from prior → latest (compass heading, 0=N, 90=E).
    y = math.sin(dlon) * math.cos(lat2)
    x = (math.cos(lat1) * math.sin(lat2) -
         math.sin(lat1) * math.cos(lat2) * math.cos(dlon))
    bearing_rad = math.atan2(y, x)
    bearing_deg = (math.degrees(bearing_rad) + 360.0) % 360.0
    # Great-circle distance (nm).
    a = (math.sin((lat2 - lat1) / 2) ** 2 +
         math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2)
    dist_nm = 2 * 3440.065 * math.asin(min(1.0, math.sqrt(a)))
    dt_h = (latest["datetime"] - prior["datetime"]).total_seconds() / 3600.0
    if dt_h <= 0:
        return None, None
    speed_kt = dist_nm / dt_h
    return round(bearing_deg), round(speed_kt)


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


def _http_head(url: str, timeout: int = 5) -> bool:
    """Check if a URL exists (HTTP 200) via HEAD request."""
    try:
        if _requests:
            r = _requests.head(url, timeout=timeout, allow_redirects=True)
            return r.status_code == 200
        else:
            import urllib.request
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status == 200
    except Exception:
        return False


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
        # check previous year only in Jan-Mar when straddling is plausible
        if _dt.now(timezone.utc).month <= 3:
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

    # ── Fallback: probe JTWC TCW files directly ──────────────────
    # When both b-deck directory listings are down, probe known TCW
    # URL patterns to discover active storms.  Parallelized to keep
    # total probe time under ~5 seconds.
    from concurrent.futures import ThreadPoolExecutor, as_completed

    print("[IR Monitor] JTWC b-deck sources unavailable, probing TCW files...")
    year_2d = str(_dt.now(timezone.utc).year)[-2:]
    full_year = str(_dt.now(timezone.utc).year)
    tcw_storms = []

    def _probe_tcw(basin, num):
        storm_id_lower = f"{basin}{num:02d}{year_2d}"
        tcw_url = f"{JTWC_TCW_BASE}/{storm_id_lower}.tcw"
        if _http_head(tcw_url, timeout=3):
            atcf_id = f"{basin.upper()}{num:02d}{full_year}"
            return (atcf_id, None)
        return None

    with ThreadPoolExecutor(max_workers=15) as pool:
        futures = []
        for basin in ["wp", "io", "sh"]:
            for num in range(1, 31):
                futures.append(pool.submit(_probe_tcw, basin, num))
        for fut in as_completed(futures):
            result = fut.result()
            if result:
                tcw_storms.append(result)
                print(f"[IR Monitor] TCW probe: {result[0]} ACTIVE")

    if tcw_storms:
        print(f"[IR Monitor] TCW probe found {len(tcw_storms)} active storms: "
              f"{[s[0] for s in tcw_storms]}")
    else:
        print("[IR Monitor] TCW probe: no active storms found")

    return tcw_storms


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


# ---------------------------------------------------------------------------
# Active-recon detection
# ---------------------------------------------------------------------------
# A storm "has recon" if a Vortex Data Message was issued for it recently.
# We list the NHC recon archive's REPNT2 (Atlantic) + REPPN2 (E/C Pacific)
# directories for the current year, parse the handful of files from the last
# few hours, and collect their ATCF IDs. The result is cached so the
# active-storms poll (and per-storm metadata) only pays the network cost once
# per refresh window.
_recent_recon_atcf: set = set()
_recent_recon_ts: float = 0.0
_recon_lock = threading.Lock()
_RECON_CACHE_TTL = 900       # refresh the recon set at most every 15 min
_RECON_LOOKBACK_HOURS = 18   # a storm with a VDM this recent is "in recon"


def _refresh_recent_recon() -> set:
    """Return the set of ATCF IDs (upper-case) with a VDM in the last
    _RECON_LOOKBACK_HOURS. Cached; falls back to the stale set on error."""
    global _recent_recon_atcf, _recent_recon_ts
    now = time.time()
    with _recon_lock:
        if _recent_recon_atcf and (now - _recent_recon_ts) < _RECON_CACHE_TTL:
            return set(_recent_recon_atcf)
        # Avoid a thundering herd: bump the timestamp before doing I/O so
        # concurrent callers within the window reuse the (stale) set.
        stale = set(_recent_recon_atcf)
        if (now - _recent_recon_ts) < _RECON_CACHE_TTL:
            return stale

    found: set = set()
    try:
        from global_archive_api import NHC_RECON_BASE, _parse_vdm_text
        from tc_radar_api import _hrd_fetch_text, _hrd_parse_directory

        year = _dt.now(timezone.utc).year
        cutoff = _dt.now(timezone.utc) - timedelta(hours=_RECON_LOOKBACK_HOURS)
        for prefix in ("REPNT2", "REPPN2"):
            url = f"{NHC_RECON_BASE}/{year}/{prefix}/"
            try:
                entries = _hrd_parse_directory(url)
            except Exception:
                continue
            recent = []
            for entry in entries:
                if not entry.lower().endswith(".txt"):
                    continue
                dm = re.search(r"(\d{12})\.txt$", entry)
                if not dm:
                    continue
                try:
                    fdt = _dt.strptime(dm.group(1), "%Y%m%d%H%M").replace(
                        tzinfo=timezone.utc)
                except ValueError:
                    continue
                if fdt >= cutoff:
                    recent.append(entry)
            for fname in recent:
                try:
                    text = _hrd_fetch_text(url + fname, timeout=10)
                    vdm = _parse_vdm_text(text, year)
                    if vdm and vdm.get("atcf_id"):
                        found.add(vdm["atcf_id"].upper())
                except Exception:
                    continue
    except Exception as e:
        logger.warning(f"recent-recon refresh failed: {e}")
        with _recon_lock:
            return set(_recent_recon_atcf)

    with _recon_lock:
        _recent_recon_atcf = found
        _recent_recon_ts = time.time()
        return set(found)


def _has_active_recon(atcf_id: str) -> bool:
    """True if a VDM was issued for this storm within the lookback window."""
    if not atcf_id:
        return False
    try:
        return atcf_id.upper() in _refresh_recent_recon()
    except Exception:
        return False


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

    # Motion: prefer the JTWC advisory's official "MOVEMENT PAST SIX
    # HOURS" line for WP/IO/SH storms (it's what shows on the warning
    # graphic). Fall back to a haversine bearing+speed computed from
    # the two most recent tau=0 fixes for NHC storms (AL/EP/CP) and
    # for any case where the JTWC web.txt is unreachable.
    motion_deg: Optional[float] = None
    motion_kt: Optional[float] = None
    if basin_code in _JTWC_BASINS:
        motion_deg, motion_kt = _fetch_jtwc_motion(atcf_id)
    if motion_deg is None or motion_kt is None:
        rd, rk = _compute_motion_from_records(records)
        if motion_deg is None:
            motion_deg = rd
        if motion_kt is None:
            motion_kt = rk

    return {
        "atcf_id": atcf_id.upper(),
        "name": display_name,
        "basin": basin,
        "lat": latest["lat"],
        "lon": latest["lon"],
        "vmax_kt": vmax,
        "mslp_hpa": latest["mslp_hpa"],
        "category": cat,
        "motion_deg": motion_deg,
        "motion_kt": motion_kt,
        "last_fix_utc": latest["datetime"].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "satellite": satellite_name_from_bucket(
            select_goes_sat(latest["lon"], latest["datetime"])[0]
        ),
        "source": source,
        "has_recon": _has_active_recon(atcf_id),
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


def _get_track_for_interp(atcf_id: str) -> list:
    """
    Return best-track positions as [(datetime, lat, lon), ...] sorted
    chronologically.  Cached for _TRACK_INTERP_TTL seconds.
    """
    key = atcf_id.upper()
    cached = _track_interp_cache.get(key)
    if cached and (time.time() - cached["ts"]) < _TRACK_INTERP_TTL:
        return cached["records"]

    records = _fetch_bdeck(atcf_id.lower())
    if not records:
        records = _fetch_adeck(atcf_id.lower())
    if not records:
        return []

    # Filter tau=0 (best-track analysis), deduplicate by hour
    t0 = [r for r in records if r["tau"] == 0]
    if not t0:
        t0 = [r for r in records if r["tech"] == "CARQ"]
    seen: dict = {}
    for r in t0:
        seen[r["datetime"].strftime("%Y%m%d%H")] = r

    pts = []
    for k in sorted(seen.keys()):
        r = seen[k]
        pts.append((r["datetime"], r["lat"], r["lon"]))

    # Segment-detection guard (reused invest numbers) — same as get_storm_metadata
    if len(pts) >= 2:
        _GAP_H, _MAX_JUMP = 72, 8.0
        last_seg = 0
        for i in range(1, len(pts)):
            gap = (pts[i][0] - pts[i - 1][0]) > timedelta(hours=_GAP_H)
            jump = _haversine_deg(pts[i - 1][1], pts[i - 1][2],
                                  pts[i][1], pts[i][2]) > _MAX_JUMP
            if gap or jump:
                last_seg = i
        if last_seg > 0:
            pts = pts[last_seg:]

    _track_interp_cache[key] = {"records": pts, "ts": time.time()}
    return pts


def _interpolate_track_position(records: list, target_dt) -> tuple | None:
    """
    Linearly interpolate (or extrapolate) best-track (lat, lon) at *target_dt*.
    Returns (lat, lon) or None if records is empty.
    Uses linear extrapolation from the last two points for times beyond
    the track range (handles B-deck lag where the latest fix may be
    6-12 hours behind real-time).
    """
    if not records:
        return None
    if len(records) == 1:
        return (records[0][1], records[0][2])

    t_arr = np.array([r[0].timestamp() for r in records])
    lat_arr = np.array([r[1] for r in records])
    lon_arr = np.array([r[2] for r in records])

    t_q = target_dt.timestamp()

    if t_q <= t_arr[-1] and t_q >= t_arr[0]:
        # Within range — standard interpolation
        lat_q = float(np.interp(t_q, t_arr, lat_arr))
        lon_q = float(np.interp(t_q, t_arr, lon_arr))
    elif t_q > t_arr[-1] and len(t_arr) >= 2:
        # Beyond latest fix — extrapolate from last two points
        dt = t_arr[-1] - t_arr[-2]
        if dt > 0:
            frac = (t_q - t_arr[-2]) / dt
            lat_q = float(lat_arr[-2] + frac * (lat_arr[-1] - lat_arr[-2]))
            lon_q = float(lon_arr[-2] + frac * (lon_arr[-1] - lon_arr[-2]))
        else:
            lat_q, lon_q = float(lat_arr[-1]), float(lon_arr[-1])
    elif t_q < t_arr[0] and len(t_arr) >= 2:
        # Before earliest fix — extrapolate from first two points
        dt = t_arr[1] - t_arr[0]
        if dt > 0:
            frac = (t_q - t_arr[0]) / dt
            lat_q = float(lat_arr[0] + frac * (lat_arr[1] - lat_arr[0]))
            lon_q = float(lon_arr[0] + frac * (lon_arr[1] - lon_arr[0]))
        else:
            lat_q, lon_q = float(lat_arr[0]), float(lon_arr[0])
    else:
        # Fallback (single-point edge case handled above)
        lat_q = float(np.interp(t_q, t_arr, lat_arr))
        lon_q = float(np.interp(t_q, t_arr, lon_arr))

    return (lat_q, lon_q)


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

def _poll_active_storms(spawn_prefetch: bool = True):
    """
    Poll NHC + JTWC for all active storms worldwide and update the cache.
    This runs in the request thread (with TTL gating) or a background thread.

    spawn_prefetch=False suppresses the in-process prefetch thread-spawn so the
    caller (e.g. the prewarm Cloud Run Job) can drive the render pipeline
    synchronously instead.
    """
    global _last_poll_time, _last_prefetch_time
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

        # Fetch B-deck first and check staleness before expensive CARQ/TCW lookups
        bdeck_records = _fetch_jtwc_bdeck(storm_id, bdeck_url)

        # Quick staleness check on B-deck alone — skip CARQ/TCW for old storms
        if bdeck_records:
            bdeck_latest_dt = max(r["datetime"] for r in bdeck_records)
            bdeck_age = now - bdeck_latest_dt
            if bdeck_age > timedelta(hours=48):
                print(f"[IR Monitor] JTWC {storm_id}: stale — last fix {bdeck_latest_dt} ({bdeck_age} ago)")
                continue

        # Only fetch CARQ/TCW for potentially active storms
        carq_records = _fetch_jtwc_carq(storm_id)
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

    # ── Detect position changes ──
    moved_storms = set()
    with _active_storms_lock:
        old_by_id = {s["atcf_id"]: s for s in _active_storms_cache.get("storms", [])}
        for s in storms:
            old = old_by_id.get(s["atcf_id"])
            if old:
                dlat = abs(s.get("lat", 0) - old.get("lat", 0))
                dlon = abs(s.get("lon", 0) - old.get("lon", 0))
                if dlat > 0.3 or dlon > 0.3:
                    moved_storms.add(s["atcf_id"])
                    print(f"[IR Monitor] {s['atcf_id']} position shifted: "
                          f"{old.get('lat',0):.1f},{old.get('lon',0):.1f} → "
                          f"{s.get('lat',0):.1f},{s.get('lon',0):.1f} "
                          f"(Δ{dlat:.1f}°lat, Δ{dlon:.1f}°lon) — will refetch frames")

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
    if moved_storms:
        print(f"[IR Monitor] Total: {total} active — {count_by_basin} "
              f"({len(moved_storms)} storm(s) moved, refetching frames)")
    else:
        print(f"[IR Monitor] Total: {total} active storms worldwide — {count_by_basin}")

    # Kick off background IR pre-fetch for all active storms
    # Storms that moved get priority (listed first)
    # Guard: don't spawn a new thread if prefetch is already running.
    # Throttle: routine cycles run at most every _PREFETCH_MIN_INTERVAL_SEC
    # (satellites only scan every 10 min, so more often is wasted render +
    # GCS work). A storm that moved bypasses the throttle — its cutout center
    # changed, so its frames must be re-fetched immediately.
    if spawn_prefetch and _INLINE_PREWARM and storms and not _prefetch_lock.locked():
        due = (time.time() - _last_prefetch_time) >= _PREFETCH_MIN_INTERVAL_SEC
        if due or moved_storms:
            ordered = sorted(storms, key=lambda s: s["atcf_id"] not in moved_storms)
            _last_prefetch_time = time.time()
            t = threading.Thread(target=_prefetch_ir_frames, args=(list(ordered),), daemon=True)
            t.start()

    return storms


# ---------------------------------------------------------------------------
# Background IR Pre-Fetch
# ---------------------------------------------------------------------------

# Default pre-fetch settings (match the endpoint defaults)
_PREFETCH_LOOKBACK_HOURS = 6.0
# 10-min prewarm cadence — aligns with the underlying satellite scan
# grid (Himawari + GOES Full Disk both scan every 10 min on
# 0/10/20/30/40/50). Previously at 15-min, half the requested frames
# mis-aligned with scans by 5 min, causing storm position alternation
# in the rendered cutouts (the "NW-SE bouncing" the user observed).
# 30-min consumers still hit because 30-min boundaries are a strict
# subset of 10-min boundaries.
_PREFETCH_INTERVAL_MIN = 10
_PREFETCH_RADIUS_DEG = 10.0
# Animation frames sit on exact 10-min scan slots, so a scan that the
# finder substitutes from a neighbouring slot (±10/±20 min) is always
# wrong — it gets reprojected at this frame's motion-advanced center and
# the storm appears to jump. Reject anything further than this from the
# slot; a not-yet-available leading-edge frame is left absent (frontend
# skips it) and refilled next cycle once its real scan lands on S3.
_ANIM_MAX_SUBSTITUTION_MIN = 7.0
# Re-fetch the newest N frames every cycle instead of trusting the cache.
# These sit at the data-arrival edge: when first cached their real scan
# may not have disseminated yet (so they were skipped), and they're the
# only frames that could still carry pre-fix poison from before this
# guard existed. Forcing a re-fetch heals them as soon as S3 has the scan.
_SELF_HEAL_FRAMES = 4
_prefetch_lock = threading.Lock()
# Cap on how many MW-pass-matched IR frames to pre-save per storm per cycle
# (bounds extra render work; real pass counts are well under this).
_MW_COMPARE_PRESAVE_MAX = 16


def _mw_compare_ir_slots(center_lat: float, center_lon: float, frame_times) -> list:
    """10-min IR slots (datetimes) matched to each NRT MW pass in the last
    24h that are NOT already covered by the prewarm `frame_times` window.
    Pre-rendering these makes the IR↔MW compare a cache hit instead of a
    slow on-demand render. Rounding to the nearest 10-min slot matches
    build_frame_times' grid and the compare's closest-frame selection.
    Returns [] (no-op) if the MW manifest is unavailable."""
    try:
        from microwave_api import nrt_passes_for_storm  # lazy: avoid import cycle
        passes = nrt_passes_for_storm(center_lat, center_lon, 24.0)
    except Exception:
        return []
    if not passes:
        return []
    have = {ft.strftime("%Y%m%d%H%M") for ft in frame_times}
    slots = {}
    for p in passes:
        ts = p.get("scan_start")
        if not ts:
            continue
        try:
            pdt = _dt.fromisoformat(ts.replace("Z", "+00:00"))
        except Exception:
            continue
        # Nearest 10-min slot, ties → earlier slot, matching the compare's
        # closest-frame pick (its meta is oldest-first with a strict-< test,
        # so an exactly-between pass keeps the earlier frame). round-half-
        # down via ceil(x-0.5) rather than banker's round() for determinism.
        slot_epoch = math.ceil(pdt.timestamp() / 600.0 - 0.5) * 600
        slot = _dt.fromtimestamp(slot_epoch, tz=timezone.utc)
        key = slot.strftime("%Y%m%d%H%M")
        if key in have:
            continue  # already prewarmed within the 6h window
        slots[key] = slot
    return sorted(slots.values(), reverse=True)[:_MW_COMPARE_PRESAVE_MAX]


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
                with _ir_frame_cache_lock:
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
                    with _ir_frame_cache_lock:
                        _ir_frame_cache[cache_key] = frame
                        while len(_ir_frame_cache) > _IR_FRAME_CACHE_MAX:
                            _ir_frame_cache.popitem(last=False)
                    storm_fetched += 1
                    total_fetched += 1

                gc.collect()

            if storm_fetched:
                print(f"[IR Pre-fetch] {atcf_id}: fetched {storm_fetched} new frames")

            # ── GCS multi-band prefetch (IR + WV/Vis) ────────────────
            # Uses a thread pool to fetch multiple frames in parallel.
            # Each worker fetches one (band, timestamp) pair from S3,
            # encodes to uint8, and caches to GCS.
            if _get_rt_gcs_bucket() is not None:
                from concurrent.futures import ThreadPoolExecutor, as_completed

                # Render-once manifest: scan-time slot → the position that
                # slot was rendered at. Loaded once per cycle; workers read
                # it (stable past positions → cache hits → skip render) and
                # record any newly-rendered slot under a lock; saved back at
                # the end of the cycle. Empty dict when _RENDER_ONCE is off,
                # which makes the helpers below fall through to the legacy
                # re-interpolate-every-frame path.
                manifest = _gcs_manifest_get(atcf_id) if _RENDER_ONCE else {}
                _manifest_lock = threading.Lock()

                def _manifest_pos(tdt, dstr, force):
                    """Cutout center for this slot. Non-force frames already
                    in the manifest reuse their recorded (immutable) center
                    so the cache short-circuit hits. Force frames (leading
                    edge / self-heal) always re-interpolate so the newest
                    estimate wins, and overwrite the manifest entry."""
                    if _RENDER_ONCE and not force:
                        with _manifest_lock:
                            ent = manifest.get(dstr)
                        if ent:
                            return ent["lat"], ent["lon"]
                    return _interp_pos_at(atcf_id, tdt, center_lat, center_lon)

                def _manifest_record(dstr, ilat, ilon):
                    if not _RENDER_ONCE:
                        return
                    with _manifest_lock:
                        manifest[dstr] = {
                            "lat": round(ilat, 4), "lon": round(ilon, 4),
                            "radius_deg": _PREFETCH_RADIUS_DEG,
                        }

                half = box_deg / 2.0
                sun_el_now = _solar_elevation(
                    center_lat, center_lon, _dt.now(timezone.utc)
                )
                # WV (Band 8) is useful 24/7 and small (same volume as IR
                # — 16× smaller than Vis L1b), so we prewarm it every
                # cycle.
                #
                # Visible-like extras:
                #   - SWIR (Band 7) every cycle (small, same vol as IR).
                #     This covers the SUNRISE transition: when the loop
                #     window still straddles dark + light, Vis Band 2
                #     returns mostly nighttime stubs, the frontend auto-
                #     falls-back to SWIR, and we want that SWIR bundle
                #     to be fresh — not whatever last night's cycle left.
                #   - Vis (Band 2) only during daylight at the storm
                #     (Vis L1b is big; skipping it at night saves the
                #     bulk of the S3 + memory cost since Vis returns no
                #     usable data when the sun is down anyway).
                #
                # Previously the prewarm chose *one* band — Vis OR WV —
                # which left the WV bundle stale for ~12 h whenever a
                # storm sat in daylight, AND left SWIR stale all day so
                # the sunrise auto-fallback returned hours-old frames.
                primary_band = WV_BAND
                extra_bands: list[int] = [SWIR_BAND]
                if sun_el_now > -6:
                    extra_bands.append(VIS_BAND)
                _prefetch_counts = {"ir": 0, "band": 0, "jpg": 0}

                def _fetch_and_cache_ir(tdt, dstr, force=False):
                    """Worker: fetch IR frame and cache to GCS.

                    Per-frame cutout is centered on the storm's
                    INTERPOLATED position at tdt (not the current
                    advisory) so historical frames stay aligned with
                    storm motion and cache keys remain stable across
                    later lookups.

                    force=True (newest few frames) bypasses the cache
                    short-circuit so a leading-edge frame that was skipped
                    or stale-cached on an earlier cycle is re-fetched and
                    overwritten once its real scan reaches S3."""
                    ilat, ilon = _manifest_pos(tdt, dstr, force)
                    if not force and _gcs_rt_exists(atcf_id.upper(), dstr,
                                   lat=ilat, lon=ilon,
                                   radius_deg=_PREFETCH_RADIUS_DEG):
                        return
                    try:
                        raw = fetch_ir_tb_raw(ilat, ilon, tdt, box_deg,
                                              max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
                    except Exception:
                        return
                    if not raw or raw.get("tb") is None:
                        return
                    # Mercator-warp so the cached WebP is correct when
                    # displayed as L.imageOverlay on the Mercator detail map.
                    jpg_bytes = _render_ir_jpg(
                        raw["tb"],
                        lat_bounds=(ilat - half, ilat + half),
                    )
                    if jpg_bytes:
                        _gcs_jpg_put(atcf_id.upper(), dstr, jpg_bytes,
                                     lat=ilat, lon=ilon)
                        _prefetch_counts["jpg"] += 1
                    tb = raw["tb"]
                    arr = np.asarray(tb, dtype=np.float32)
                    mask = ~np.isfinite(arr) | (arr <= 0)
                    scaled = np.clip((arr - _TB_VMIN) * _TB_SCALE + 1, 1, 255)
                    scaled[mask] = 0
                    encoded = scaled.astype(np.uint8)
                    _gcs_rt_put(atcf_id.upper(), dstr, {
                        "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
                        "tb_rows": encoded.shape[0], "tb_cols": encoded.shape[1],
                        "tb_vmin": _TB_VMIN, "tb_vmax": _TB_VMAX,
                        "datetime_utc": raw["datetime_utc"],
                        "scan_dt": raw.get("scan_dt"),
                        "satellite": raw.get("satellite", ""),
                        "bounds": raw.get("bounds", [
                            [ilat - half, ilon - half],
                            [ilat + half, ilon + half],
                        ]),
                    }, lat=ilat, lon=ilon, radius_deg=_PREFETCH_RADIUS_DEG)
                    _prefetch_counts["ir"] += 1
                    # Freeze this slot's center so future cycles reuse it
                    # (the bundle builder reads each frame back here).
                    _manifest_record(dstr, ilat, ilon)
                    del tb, arr, mask, scaled, encoded

                def _fetch_and_cache_band(tdt, dstr, band, force=False):
                    """Worker: fetch WV/Vis frame and cache to GCS.

                    Cache keys use the storm's INTERPOLATED position at
                    `tdt` (like _fetch_and_cache_ir), NOT the current
                    advisory position. _build_and_upload_bundles reads
                    each frame back at its interpolated position, so
                    keying the cache at the current position made every
                    frame except the most-recent ~few miss (the storm
                    moves > the 0.1° key precision within ~30 min), which
                    left the Vis/WV/SWIR loops stuck at only a handful of
                    frames for any moving storm.

                    force=True re-fetches the newest few frames each cycle
                    (see _fetch_and_cache_ir) to heal leading-edge frames."""
                    ilat, ilon = _manifest_pos(tdt, dstr, force)
                    if not force and _gcs_band_exists(band, atcf_id.upper(), dstr, lat=ilat, lon=ilon):
                        return
                    if band == VIS_BAND:
                        se = _solar_elevation(ilat, ilon, tdt)
                        if se < -6:
                            return
                    binfo = BAND_RANGES.get(band, BAND_RANGES[13])
                    bvmin, bvmax = binfo["vmin"], binfo["vmax"]
                    bscale = 254.0 / (bvmax - bvmin)
                    try:
                        raw = fetch_band_raw(ilat, ilon, tdt, box_deg, band=band,
                                             max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
                    except Exception:
                        return
                    if not raw or raw.get("data") is None:
                        return
                    data = raw["data"]
                    arr = np.asarray(data, dtype=np.float32)
                    mask = ~np.isfinite(arr)
                    scaled = np.clip((arr - bvmin) * bscale + 1, 1, 255)
                    scaled[mask] = 0
                    encoded = scaled.astype(np.uint8)
                    _gcs_band_put(band, atcf_id.upper(), dstr, {
                        "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
                        "tb_rows": encoded.shape[0], "tb_cols": encoded.shape[1],
                        "tb_vmin": bvmin, "tb_vmax": bvmax,
                        "band": band, "data_type": binfo["data_type"],
                        "datetime_utc": raw["datetime_utc"],
                        "scan_dt": raw.get("scan_dt"),
                        "satellite": raw.get("satellite", ""),
                        "bounds": raw.get("bounds", [
                            [ilat - half, ilon - half],
                            [ilat + half, ilon + half],
                        ]),
                    }, lat=ilat, lon=ilon)
                    _prefetch_counts["band"] += 1
                    _manifest_record(dstr, ilat, ilon)
                    # Also render and cache band JPG for fast preview
                    try:
                        jpg_bytes = _render_band_jpg(
                            np.asarray(data, dtype=np.float32), band, bvmin, bvmax
                        )
                        if jpg_bytes:
                            _gcs_jpg_put(atcf_id.upper(), dstr, jpg_bytes,
                                         band=band, lat=ilat, lon=ilon)
                    except Exception:
                        pass
                    del data, arr, mask, scaled, encoded

                # Vis L1b segments are 16× the IR data per frame, but the
                # _fetch_and_cache_band worker already skips frames whose
                # solar elevation is < -6° (no usable imagery at night).
                # That filter cuts the effective Vis frame count in half
                # for most storm latitudes, so prewarming all frames is
                # affordable.
                max_band_frames = len(frame_times)
                # Worker count tuned for Cloud Run's 2 vCPU + 4 Gi memory.
                # Frame work is mostly I/O-bound (S3 fetch + bz2
                # decompress), so we can run well above core count.
                # Vis L1b is much larger per segment so we cap lower to
                # bound peak memory; IR/WV/SWIR are 16× smaller.
                has_vis_extra = VIS_BAND in extra_bands
                max_workers = 3 if has_vis_extra else 8

                # Iterate newest → oldest so the most-recent frames land
                # in the per-frame cache first. The bundle rebuild only
                # happens after the full cycle finishes, but if the
                # cycle is interrupted (instance recycle, crash mid-
                # cycle), the cached frames closest to "now" are
                # already on disk and ready for the next bundle.
                # frame_times is in newest→oldest order from
                # build_frame_times — no reverse needed.
                # Slots flagged anomalous by the previous cycle's bundle
                # screen — force-refetch them (anywhere in the window) so a
                # poisoned frame heals, not just the newest few. Pop so it's
                # re-derived fresh from this cycle's screen.
                with _anomalous_heal_lock:
                    heal_times = _anomalous_heal_times.pop(atcf_id.upper(), set())
                if heal_times:
                    print(f"[IR Pre-fetch] {atcf_id}: self-healing {len(heal_times)} "
                          f"flagged frame(s): {sorted(heal_times)}")

                # IR frames matched to each NRT MW pass in the last 24h that
                # fall OUTSIDE the 6h prewarm window. Pre-rendering them makes
                # the IR↔MW compare a cache hit (instant) instead of a slow
                # on-demand render — and re-rendering each cycle keeps them
                # aligned through best-track updates (which re-key historical
                # frames). Cheap: only the older passes, ~handful per storm.
                compare_slots = _mw_compare_ir_slots(center_lat, center_lon, frame_times)
                if compare_slots:
                    print(f"[IR Pre-fetch] {atcf_id}: pre-saving {len(compare_slots)} "
                          f"IR frame(s) at MW pass times for the compare modal")

                with ThreadPoolExecutor(max_workers=max_workers) as pool:
                    futures = []
                    for i, target_dt in enumerate(frame_times):
                        dt_str = target_dt.strftime("%Y%m%d%H%M")
                        # Force-refetch the leading edge (their real scan may
                        # not have disseminated when first cached) AND any
                        # slot flagged anomalous last cycle (self-heal).
                        force = (i < _SELF_HEAL_FRAMES) or (dt_str in heal_times)
                        futures.append(pool.submit(_fetch_and_cache_ir, target_dt, dt_str, force))
                        if i < max_band_frames:
                            futures.append(pool.submit(_fetch_and_cache_band, target_dt, dt_str, primary_band, force))
                            for eb in extra_bands:
                                futures.append(pool.submit(_fetch_and_cache_band, target_dt, dt_str, eb, force))
                    # IR-only pre-save for the MW compare (no band/raw needed —
                    # the compare panel uses /ir-frame.jpg).
                    for slot in compare_slots:
                        futures.append(pool.submit(
                            _fetch_and_cache_ir, slot, slot.strftime("%Y%m%d%H%M"), False))

                    # Wait for all to complete
                    for fut in as_completed(futures):
                        try:
                            fut.result()
                        except Exception:
                            pass

                gc.collect()
                c = _prefetch_counts
                if c["ir"] or c["band"] or c["jpg"]:
                    extra_summary = (
                        f" + Band {extra_bands[0]}" if extra_bands else ""
                    )
                    print(f"[IR Pre-fetch] {atcf_id}: GCS cached {c['ir']} IR + "
                          f"{c['band']} Band {primary_band}{extra_summary} + "
                          f"{c['jpg']} JPG frames (parallel)")
                total_gcs_fetched += c["ir"] + c["band"]

                # ── Pre-build bundle artifacts ─────────────────────
                # Assemble both the display-WebP and raw-Tb bundles
                # for this storm and write them to a public-read GCS
                # path. The frontend's _fetchRawTbBundle and
                # _initDetailMapJPG try these direct-GCS URLs FIRST,
                # bypassing Cloud Run entirely on the read path. Net
                # win: ~400-700 ms → ~150-300 ms warm-bundle load.
                #
                # Brief wait so the fire-and-forget _gcs_rt_put /
                # _gcs_jpg_put threads spawned by the per-frame workers
                # have time to flush their uploads before we read them
                # back. ~3s is empirically enough for a 25-frame batch;
                # any straggler just shows up as a missing frame in
                # this cycle's bundle and is captured on the next.
                time.sleep(3)
                try:
                    _build_and_upload_bundles(
                        atcf_id, center_lat, center_lon, frame_times,
                        radius_deg=_PREFETCH_RADIUS_DEG,
                        lookback_hours=_PREFETCH_LOOKBACK_HOURS,
                        interval_min=_PREFETCH_INTERVAL_MIN,
                        band=primary_band,   # always WV — 24/7 utility
                        manifest=manifest,
                    )
                except Exception as ex:
                    # Bundle build is best-effort — per-frame cache still
                    # populated above, so the API endpoints can assemble
                    # on demand. Just log and move on.
                    print(f"[IR Pre-fetch] {atcf_id}: bundle build failed: {ex}")

                # Daylight cycle adds Vis; nighttime adds SWIR. Both are
                # the "visible-like" pair so the Visible button is always
                # ready (true Vis when sunlit, SWIR when dark) without
                # waiting on cold S3. Call _build_band_bundle DIRECTLY (not
                # the full _build_and_upload_bundles) so the ~80 MB IR
                # display+raw bundles aren't re-assembled for each band.
                if extra_bands:
                    _b_times_oldest = list(reversed(list(frame_times)))
                    _b_latest = (_b_times_oldest[-1] if _b_times_oldest
                                 else _dt.now(timezone.utc))
                    _b_silat, _b_silon = _bundle_pos_for(
                        atcf_id, _b_latest, center_lat, center_lon, manifest)
                    for eb in extra_bands:
                        try:
                            _build_band_bundle(
                                atcf_id, center_lat, center_lon, _b_times_oldest,
                                _PREFETCH_RADIUS_DEG, _b_silat, _b_silon, eb,
                                manifest, _PREFETCH_LOOKBACK_HOURS,
                                _PREFETCH_INTERVAL_MIN, _PREFETCH_RADIUS_DEG)
                        except Exception as ex:
                            print(f"[IR Pre-fetch] {atcf_id}: band {eb} bundle build failed: {ex}")

                # ── Persist the render-once manifest ───────────────
                # Prune to a 30h horizon (covers the 6h loop window + the
                # 24h MW-compare lookback so persistent compare slots aren't
                # re-rendered each cycle) so the manifest stays bounded, then
                # write it back. Lexicographic compare on "YYYYMMDDHHMM" is
                # chronological. SYNCHRONOUS so the Job flushes before exit.
                if _RENDER_ONCE:
                    try:
                        cutoff = (_dt.now(timezone.utc) - timedelta(hours=30)).strftime("%Y%m%d%H%M")
                        manifest = {k: v for k, v in manifest.items() if k >= cutoff}
                        _gcs_manifest_put(atcf_id, manifest)
                    except Exception as ex:
                        print(f"[IR Pre-fetch] {atcf_id}: manifest save failed: {ex}")

        # ── NEXRAD radar pre-fetch for storms near 88D sites ────────
        _prefetch_nexrad_for_storms(storms, frame_times_map={
            s["atcf_id"]: build_frame_times(
                _dt.now(timezone.utc), _PREFETCH_LOOKBACK_HOURS, _PREFETCH_INTERVAL_MIN
            ) for s in storms
        })

        print(f"[IR Pre-fetch] Done — {total_fetched} new PNG frames, "
              f"{total_cached} already cached, "
              f"{total_gcs_fetched} raw Tb frames cached to GCS")

        # Clean up old cached frames from GCS
        _cleanup_old_gcs_frames(storms)

    except Exception:
        traceback.print_exc()
    finally:
        _prefetch_lock.release()


def _prefetch_nexrad_for_storms(storms: list, frame_times_map: dict):
    """
    Pre-fetch NEXRAD radar frames for active storms near 88D sites.
    Runs after the IR/band pre-fetch. For each storm within 500 km of a
    NEXRAD site, renders ~8 key reflectivity frames spanning the 6h window
    and caches them to GCS.
    """
    try:
        from nexrad_api import (
            NEXRAD_SITES, _haversine_km, _list_scans_s3,
            _read_nexrad_level2, _grid_radar, _render_radar_image,
            _encode_data_uint8, PRODUCTS, _gcs_get_frame, _gcs_put_frame,
            _cache_put,
        )
    except ImportError:
        return  # nexrad_api not available

    from concurrent.futures import ThreadPoolExecutor, as_completed

    MAX_RANGE_KM = 300
    MAX_KEY_FRAMES = 8
    SEARCH_WINDOW_MIN = 360  # 6 hours
    CONCURRENCY = 2

    total_rendered = 0

    for storm in storms:
        atcf_id = storm["atcf_id"]
        slat = storm["lat"]
        slon = storm["lon"]

        # Find nearby sites (within 500 km)
        nearby = []
        for site_id, (rlat, rlon, name) in NEXRAD_SITES.items():
            dist = _haversine_km(slat, slon, rlat, rlon)
            if dist <= 500:
                nearby.append((site_id, dist))
        if not nearby:
            continue

        nearby.sort(key=lambda x: x[1])
        # Only pre-fetch for the closest site
        site_id = nearby[0][0]
        site_dist = nearby[0][1]

        # Get frame times for this storm
        frame_times = frame_times_map.get(atcf_id, [])
        if not frame_times:
            continue

        # Use the middle frame time as reference for scan search
        mid_dt = frame_times[len(frame_times) // 2]

        # Search for available scans across the full 6h window
        try:
            scans = _list_scans_s3(site_id, mid_dt, window_min=SEARCH_WINDOW_MIN)
        except Exception as e:
            print(f"[Radar Pre-fetch] {atcf_id}/{site_id}: scan search failed: {e}")
            continue

        if not scans:
            continue

        # Sort by time ascending
        scans.sort(key=lambda s: s["scan_time"])

        # Pick ~MAX_KEY_FRAMES evenly spaced scans
        step = max(1, len(scans) // MAX_KEY_FRAMES)
        key_scans = [scans[i] for i in range(0, len(scans), step)]
        if key_scans[-1] != scans[-1]:
            key_scans.append(scans[-1])

        # Filter out scans already in GCS cache
        uncached = []
        for sc in key_scans:
            cached = _gcs_get_frame(site_id, sc["s3_key"], "reflectivity", 0, MAX_RANGE_KM)
            if cached is None:
                uncached.append(sc)

        if not uncached:
            continue

        print(f"[Radar Pre-fetch] {atcf_id}/{site_id} ({site_dist:.0f}km): "
              f"rendering {len(uncached)} uncached of {len(key_scans)} key frames")

        prod_cfg = PRODUCTS["reflectivity"]
        storm_rendered = 0

        def _render_one(scan):
            nonlocal storm_rendered
            s3_key = scan["s3_key"]
            cache_key = f"{site_id}:{s3_key}:reflectivity:0:{MAX_RANGE_KM}:1000"
            try:
                radar = _read_nexrad_level2(s3_key)
                data_2d, metadata = _grid_radar(
                    radar, product="reflectivity", sweep=0,
                    grid_spacing_m=1000, max_range_m=MAX_RANGE_KM * 1000,
                )
                radar = None

                image = _render_radar_image(
                    np.flipud(data_2d), prod_cfg["lut"],
                    prod_cfg["vmin"], prod_cfg["vmax"], scale=1
                )
                hover_data = _encode_data_uint8(
                    np.flipud(data_2d), prod_cfg["vmin"], prod_cfg["vmax"]
                )

                result = {
                    "image": image,
                    **hover_data,
                    "bounds": metadata["bounds"],
                    "site": site_id,
                    "scan_time": metadata["scan_time"],
                    "product": "reflectivity",
                    "tilt": metadata["tilt"],
                    "units": prod_cfg["units"],
                    "label": prod_cfg["label"],
                }

                _cache_put(cache_key, result)
                _gcs_put_frame(site_id, s3_key, "reflectivity", 0, result, MAX_RANGE_KM)
                storm_rendered += 1

                del data_2d, image, hover_data, result
                gc.collect()
            except Exception as e:
                print(f"[Radar Pre-fetch] {site_id} frame failed: {e}")

        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            futures = [pool.submit(_render_one, sc) for sc in uncached]
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception:
                    pass

        if storm_rendered:
            print(f"[Radar Pre-fetch] {atcf_id}/{site_id}: cached {storm_rendered} radar frames")
        total_rendered += storm_rendered

    if total_rendered:
        print(f"[Radar Pre-fetch] Total: {total_rendered} radar frames cached to GCS")


# Max age for cached frames (hours).  Anything older gets deleted.
_GCS_CACHE_MAX_AGE_HOURS = 24


def _cleanup_old_gcs_frames(active_storms: list):
    """
    Delete rt-v{N} real-time-monitor cached frames older than
    _GCS_CACHE_MAX_AGE_HOURS, plus ALL cached frames for storms no longer
    active. Scoped STRICTLY to the rt-v{N} real-time per-frame prefixes —
    it NEVER touches the global-archive / TC-RADAR IR caches (different
    prefixes), the bundles, the manifest, or any other bucket data.

    Per-prefix path layouts differ in WHERE the ATCF id sits, so each
    target carries the 0-based index of its atcf_id path segment:
      {V}/ir-raw/{atcf}/{pk}/{dt}.json           → idx 2
      {V}/band-raw/{band}/{atcf}/{pk}/{dt}.json   → idx 3
      {V}/ir-webp-merc/{atcf}/{dt}{pos}.webp      → idx 2
      {V}/band{N}-webp/{atcf}/{dt}{pos}.webp      → idx 2

    NOTE: the previous version parsed parts[-2] as the atcf_id, but the
    pk segment sits there now — so it deleted EVERY active-storm frame
    every cycle, forcing a full re-render next cycle (a hidden cost
    driver and the reason render-once frames couldn't persist). It also
    cleaned a stale `ir-jpg/` prefix that no longer exists (the WebP
    frames under ir-webp-merc/band{N}-webp leaked forever). Both fixed.
    """
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return

    cutoff = _dt.now(timezone.utc) - timedelta(hours=_GCS_CACHE_MAX_AGE_HOURS)
    cutoff_str = cutoff.strftime("%Y%m%d%H%M")
    active_ids = {s["atcf_id"].upper() for s in active_storms}
    deleted = 0

    targets = [
        (f"{_GCS_RT_VERSION}/ir-raw/", 2),
        (f"{_GCS_RT_VERSION}/band-raw/", 3),
        (f"{_GCS_RT_VERSION}/ir-webp-merc/", 2),
    ]
    for _b in (WV_BAND, SWIR_BAND, VIS_BAND):
        targets.append((f"{_GCS_RT_VERSION}/band{_b}-webp/", 2))

    for prefix, atcf_idx in targets:
        try:
            blobs = list(bucket.list_blobs(prefix=prefix, max_results=10000))
        except Exception:
            continue

        for blob in blobs:
            try:
                parts = blob.name.split("/")
                if len(parts) <= atcf_idx:
                    continue
                filename = parts[-1]
                # Leading 12 digits of the filename are the scan time
                # ("YYYYMMDDHHMM"); a trailing position suffix (.json /
                # {pos}.webp) follows. Bail on any unexpected name.
                dt_part = filename[:12]
                if not (len(dt_part) == 12 and dt_part.isdigit()):
                    continue
                atcf_id = parts[atcf_idx].upper()
                # Safety net: a real ATCF id is alphanumeric (e.g.
                # WP062026). A misparse landing on a pk ("20.3_128.4_r10.0")
                # contains '.'/'_' — never delete based on that, so a path-
                # shape change can't silently nuke the cache again.
                if not atcf_id.isalnum():
                    continue
                if dt_part < cutoff_str or atcf_id not in active_ids:
                    blob.delete()
                    deleted += 1
            except Exception:
                continue

    if deleted:
        print(f"[GCS Cleanup] Deleted {deleted} old cached frames "
              f"(cutoff: {cutoff_str}, active storms: {len(active_ids)})")


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
    """Start the background storm refresh thread.  Called once at app startup.

    No-op when _INLINE_PREWARM is False: the API then runs cpu-throttled, where
    daemon threads get no CPU between requests anyway. Storm-cache refresh is
    driven by the /warmup Cloud Scheduler ping (refresh_active_storms_cache),
    and the render pipeline runs in the standalone prewarm Cloud Run Job.
    """
    if not _INLINE_PREWARM:
        print("[IR Monitor] Inline prewarm disabled (IR_INLINE_PREWARM=0) — "
              "background refresh thread NOT started; warmup cron + prewarm job drive refresh")
        return
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


def run_prewarm_cycle():
    """
    Run one full prewarm cycle SYNCHRONOUSLY (poll storms, then render + upload
    all IR/WV/SWIR/Vis frames, build bundles, prefetch NEXRAD, clean old GCS
    frames). This is the entry point for the standalone prewarm Cloud Run Job
    (prewarm_job.py), which replaces the in-process prewarm daemon so the API
    can run cpu-throttled. Returns a summary dict.
    """
    global _last_prefetch_time
    t0 = time.time()
    # Publish the live cache version so the frontend tracks server-side
    # bumps instead of freezing on a stale old-version bundle. Done every
    # cycle (even with no storms) so the discovery file always exists.
    _gcs_rt_version_put()
    storms = _poll_active_storms(spawn_prefetch=False)
    if not storms:
        print("[Prewarm Job] No active storms — nothing to render")
        return {"storm_count": 0, "elapsed_sec": round(time.time() - t0, 1)}

    print(f"[Prewarm Job] Rendering frames for {len(storms)} active storm(s)…")
    _last_prefetch_time = time.time()
    _prefetch_ir_frames(list(storms))
    elapsed = round(time.time() - t0, 1)
    print(f"[Prewarm Job] Cycle complete in {elapsed}s for {len(storms)} storm(s)")
    return {
        "storm_count": len(storms),
        "elapsed_sec": elapsed,
        "atcf_ids": [s["atcf_id"] for s in storms],
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/active-storms")
def get_active_storms(if_none_match: Optional[str] = Header(default=None)):
    """
    Return all currently active tropical cyclones worldwide.
    Data sourced from NHC ATCF A-deck (ATL + EPAC) and JTWC B-deck (WPAC, IO, SHEM).
    Results are cached for 10 minutes; ETag/304 short-circuits unchanged polls.
    """
    _ensure_fresh_cache()

    with _active_storms_lock:
        data = {
            "storms": list(_active_storms_cache["storms"]),
            "updated_utc": _active_storms_cache["updated_utc"],
            "count_by_basin": dict(_active_storms_cache["count_by_basin"]),
        }

    # ETag derived from updated_utc + storm count (cache rebuild → new ETag).
    # Cheap to compute and stable so long as the cache hasn't changed.
    etag_seed = f"{data['updated_utc']}|{len(data['storms'])}"
    etag = '"' + hashlib.sha1(etag_seed.encode("utf-8")).hexdigest()[:16] + '"'

    if if_none_match and if_none_match.strip() == etag:
        return Response(
            status_code=304,
            headers={"ETag": etag, "Cache-Control": "public, max-age=120"},
        )

    return JSONResponse(
        content=data,
        headers={
            "Cache-Control": "public, max-age=120",
            "ETag": etag,
        },
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


# ---------------------------------------------------------------------------
# Recent storms (active + recently-dissipated) — drives the RT Monitor's
# Subseasonal-tab Hovmöller TC overlay so users see storms like Sinlaku
# that just dissipated, not only those currently active.
# ---------------------------------------------------------------------------

# Cache the result to avoid re-scanning ATCF dirs on every page load.
# 15 min is sensible since deck files refresh every 6 h.
_recent_storms_cache: dict = {"days": None, "data": None, "ts": 0.0}
_recent_storms_lock = threading.Lock()
_RECENT_STORMS_TTL = 15 * 60


def _list_recent_atcf_ids(days_back: int) -> list:
    """Discover ATCF IDs for recently active or dissipated storms.
    Pulls from NHC btk (best-track) + JTWC b-deck directory listings.
    Returns sorted unique list of lowercase ATCF IDs."""
    now = _dt.now(timezone.utc)
    cutoff = now - timedelta(days=days_back)
    ids = set()

    # NHC btk dir keeps b-deck files for current-year ATL/EP/CP storms.
    text = _http_get(NHC_BDECK_BASE + "/", timeout=10) or ""
    for m in re.finditer(r'b((?:al|ep|cp)\d{2}\d{4})\.dat', text, re.IGNORECASE):
        ids.add(m.group(1).lower())

    # Also scrape NHC aid_public (a-deck) in case btk hasn't caught up
    # yet for a storm that just transitioned from invest to named.
    text = _http_get(NHC_ATCF_BASE + "/", timeout=10) or ""
    for m in re.finditer(r'a((?:al|ep|cp)\d{2}\d{4})\.dat', text, re.IGNORECASE):
        ids.add(m.group(1).lower())

    # JTWC b-deck listings (current + prior year if straddling Jan-Mar).
    for source_name, base_url in JTWC_SOURCES:
        listing = (f"{base_url}/{now.year}/" if source_name == "ucar"
                   else f"{base_url}/")
        text = _http_get(listing, timeout=10) or ""
        if not text:
            continue
        for yr in (now.year, now.year - 1 if now.month <= 3 else None):
            if yr is None:
                continue
            pattern = rf'b((?:io|sh|wp|ep|cp)\d{{2}}{yr})\.dat'
            for m in re.finditer(pattern, text, re.IGNORECASE):
                sid = m.group(1).lower()
                if sid[:2].upper() not in _NHC_BASINS:
                    ids.add(sid)
        if ids:
            break  # one JTWC source succeeded; no need to try fallback

    # Drop obviously-stale older-year IDs unless cutoff includes them.
    cutoff_year = cutoff.year
    return sorted(
        s for s in ids
        if int(s[-4:]) >= cutoff_year
    )


def _fetch_deck_text(atcf_id: str) -> Optional[str]:
    """Fetch raw b-deck (or a-deck fallback) text for an ATCF ID.
    Used by /recent-storms for name extraction — _extract_storm_name
    needs the raw CSV rather than the parsed-record list."""
    sid = atcf_id.lower()
    # NHC btk path
    text = _http_get(f"{NHC_BDECK_BASE}/b{sid}.dat")
    if text:
        return text
    # JTWC b-deck — try both source URLs
    for source_name, base_url in JTWC_SOURCES:
        yr = int(sid[-4:])
        url = (f"{base_url}/{yr}/b{sid}.dat" if source_name == "ucar"
               else f"{base_url}/b{sid}.dat")
        text = _http_get(url)
        if text:
            return text
    # Last resort: aid_public a-deck
    text = _http_get(f"{NHC_ATCF_BASE}/a{sid}.dat")
    return text


def _build_recent_storm_track(atcf_id: str, days_back: int) -> Optional[dict]:
    """Fetch + filter a storm's full track to the last N days.
    Returns None if no fixes in the lookback window."""
    text = _fetch_deck_text(atcf_id)
    if not text:
        return None
    records = []
    for line in text.strip().split("\n"):
        rec = _parse_adeck_line(line)
        if rec:
            records.append(rec)
    if not records:
        records = _fetch_adeck(atcf_id)  # JTWC carq fallback if btk gave 0 valid lines
    if not records:
        return None
    name = _extract_storm_name(text)
    cutoff = _dt.now(timezone.utc) - timedelta(days=days_back)
    # tau=0 = analyzed/best-track position (not a forecast). Prefer
    # BEST > CARQ > JTWC > OFCL when multiple techniques report the
    # same datetime (best-track is post-storm, generally cleanest).
    priority = {"BEST": 3, "CARQ": 2, "JTWC": 1, "OFCL": 0}
    by_dt = {}
    for r in records:
        if r["tau"] != 0 or r["datetime"] < cutoff:
            continue
        key = r["datetime"]
        existing = by_dt.get(key)
        if not existing or priority.get(r["tech"], -1) > priority.get(existing["tech"], -1):
            by_dt[key] = r
    if not by_dt:
        return None
    track = sorted(by_dt.values(), key=lambda r: r["datetime"])
    latest = track[-1]
    now = _dt.now(timezone.utc)
    # > 6 hours since last fix → consider dissipated. Active storms get
    # fix updates every 6h, so this draws a clear line.
    dissipated = (now - latest["datetime"]).total_seconds() > 6 * 3600
    return {
        "atcf_id": atcf_id.upper(),
        "name": name,                    # may be None for early/unnamed systems
        "basin": latest["basin"],
        "lat": latest["lat"],
        "lon": latest["lon"],
        "vmax_kt": latest.get("vmax_kt"),
        "active": not dissipated,
        "last_fix_utc": latest["datetime"].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "track": [
            {
                "time": r["datetime"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "lat": r["lat"], "lon": r["lon"],
                "vmax_kt": r.get("vmax_kt"),
            } for r in track
        ],
    }


def _attach_storm_names(entries: list) -> None:
    """Fill in any missing names from the active-storms cache. Each
    entry already tries to extract its own name from the deck file
    (column 27); this is just a fallback for storms whose deck file
    has UNNAMED in that field but who are known via the live cache."""
    with _active_storms_lock:
        by_id = {s["atcf_id"].upper(): s.get("name")
                 for s in _active_storms_cache.get("storms", [])}
    for e in entries:
        if not e.get("name") and e["atcf_id"] in by_id:
            e["name"] = by_id[e["atcf_id"]]


@router.get("/recent-storms")
def get_recent_storms(days: int = Query(60, ge=1, le=120,
                                         description="Lookback window in days")):
    """All storms with at least one fix in the last N days (active +
    recently-dissipated). Includes the full track in the window so the
    RT Monitor's Subseasonal tab can plot (time, lon) trajectories on
    the Hovmöllers — i.e. show whether each storm rode a Kelvin or MJO
    envelope through its lifetime."""
    now = time.time()
    with _recent_storms_lock:
        cached = _recent_storms_cache
        if (cached["days"] == days and cached["data"] is not None
                and (now - cached["ts"]) < _RECENT_STORMS_TTL):
            return JSONResponse(content=cached["data"],
                                headers={"Cache-Control": "public, max-age=600"})

    ids = _list_recent_atcf_ids(days)
    entries = []
    for atcf_id in ids:
        try:
            entry = _build_recent_storm_track(atcf_id, days)
            if entry:
                entries.append(entry)
        except Exception as e:
            print(f"[recent-storms] {atcf_id} failed: {e}")
    _attach_storm_names(entries)
    entries.sort(key=lambda s: s["last_fix_utc"], reverse=True)

    payload = {
        "storms": entries,
        "lookback_days": days,
        "updated_utc": _dt.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(entries),
    }
    with _recent_storms_lock:
        _recent_storms_cache.update({"days": days, "data": payload, "ts": now})
    return JSONResponse(content=payload,
                        headers={"Cache-Control": "public, max-age=600"})


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
        with _ir_frame_cache_lock:
            if cache_key in _ir_frame_cache:
                _ir_frame_cache.move_to_end(cache_key)
                frames.append(_ir_frame_cache[cache_key])
                continue

        frame = fetch_ir_frame(center_lat, center_lon, target_dt, box_deg)
        if frame:
            frames.append(frame)
            # Cache the frame
            with _ir_frame_cache_lock:
                _ir_frame_cache[cache_key] = frame
                while len(_ir_frame_cache) > _IR_FRAME_CACHE_MAX:
                    _ir_frame_cache.popitem(last=False)

    if not frames:
        raise HTTPException(
            status_code=502,
            detail="Could not retrieve any IR frames (satellite data may be temporarily unavailable)",
        )

    return JSONResponse(
        content={"frames": frames, "storm": storm},
        headers={"Cache-Control": "public, max-age=180, s-maxage=600, stale-while-revalidate=120"},
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
        ilat, ilon = _interp_pos_at(atcf_id, target_dt, center_lat, center_lon)

        # Check GCS cache first (interpolated-position key — see _pos_key docs)
        cached = _gcs_rt_get(atcf_id.upper(), dt_str,
                            lat=ilat, lon=ilon, radius_deg=radius_deg)
        if cached is not None:
            frames.append(cached)
            continue

        raw = fetch_ir_tb_raw(ilat, ilon, target_dt, box_deg,
                              max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
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
                    [ilat - half, ilon - half],
                    [ilat + half, ilon + half],
                ]),
            }
            frames.append(frame_result)

            # Cache to GCS (fire-and-forget)
            _gcs_rt_put(atcf_id.upper(), dt_str, frame_result,
                        lat=ilat, lon=ilon, radius_deg=radius_deg)

            del tb, arr, mask, scaled, encoded

    if not frames:
        raise HTTPException(
            status_code=502,
            detail="Could not retrieve any raw IR frames",
        )

    return JSONResponse(
        content={"frames": frames, "storm": storm},
        headers={"Cache-Control": "public, max-age=180, s-maxage=600, stale-while-revalidate=120"},
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
    frame_times = list(reversed(frame_times))  # oldest first (index 0 = oldest, index N-1 = most recent)

    if frame_index >= len(frame_times):
        raise HTTPException(status_code=400, detail=f"frame_index {frame_index} out of range")

    target_dt = frame_times[frame_index]
    dt_str = target_dt.strftime("%Y%m%d%H%M")
    half = box_deg / 2.0

    # Interpolate best-track position at frame time for center-finding.
    # This tracks storm motion and is much better than the static advisory
    # for older frames in the 6h lookback window.
    track_records = _get_track_for_interp(atcf_id)
    interp_lat, interp_lon = center_lat, center_lon  # fallback to advisory
    if track_records:
        _ipos = _interpolate_track_position(track_records, target_dt)
        if _ipos:
            interp_lat, interp_lon = _ipos

    # Check GCS cache first (keyed by INTERPOLATED position at this frame's
    # time so historical frames remain stable across recurring lookups —
    # see _pos_key docstring for why advisory-position keying thrashed).
    cached = _gcs_rt_get(atcf_id.upper(), dt_str,
                        lat=interp_lat, lon=interp_lon,
                        radius_deg=radius_deg)
    if cached is not None:
        cached["frame_index"] = frame_index
        cached["total_frames"] = len(frame_times)

        # Re-attempt center_fix for cached frames that are missing it or failed
        vmax_kt = storm.get("vmax_kt")
        _cfix = cached.get("center_fix")
        # Trigger retry when:
        #   - never computed, OR
        #   - last attempt explicitly failed (success=False), OR
        #   - cached fix was written by pre-gates code (no `gates` key) —
        #     those bypassed g1/g2/g3 and may be spatially wrong.
        _cfix_missing_gates = (
            isinstance(_cfix, dict)
            and _cfix.get("success") is not False
            and "gates" not in _cfix
        )
        _needs_retry = (
            _cfix is None
            or (isinstance(_cfix, dict) and _cfix.get("success") is False)
            or _cfix_missing_gates
        )
        if _needs_retry and vmax_kt is not None and vmax_kt >= 65:
            try:
                raw_u8 = np.frombuffer(
                    base64.b64decode(cached["tb_data"]),
                    dtype=np.uint8,
                ).reshape(cached["tb_rows"], cached["tb_cols"])
                tb_float = np.where(
                    raw_u8 > 0,
                    _TB_VMIN + (raw_u8.astype(np.float32) - 1) * (_TB_VMAX - _TB_VMIN) / 254.0,
                    np.nan,
                )
                frame_bounds = cached.get("bounds", [
                    [center_lat - half, center_lon - half],
                    [center_lat + half, center_lon + half],
                ])
                # Use adjacent frame's center_fix as initial guess if available,
                # falling back to interpolated best-track position at frame time
                bf_guess_lat, bf_guess_lon = interp_lat, interp_lon
                for bf_off in [1, -1]:
                    bf_adj = frame_index + bf_off
                    if bf_adj < 0 or bf_adj >= len(frame_times):
                        continue
                    bf_dt = frame_times[bf_adj].strftime("%Y%m%d%H%M")
                    bf_ilat, bf_ilon = _interp_pos_at(
                        atcf_id, frame_times[bf_adj], center_lat, center_lon)
                    bf_cached = _gcs_rt_get(atcf_id.upper(), bf_dt,
                                           lat=bf_ilat, lon=bf_ilon,
                                           radius_deg=radius_deg)
                    bf_fix = bf_cached.get("center_fix") if bf_cached else None
                    if isinstance(bf_fix, dict) and bf_fix.get("lat") is not None:
                        bf_guess_lat = bf_fix["lat"]
                        bf_guess_lon = bf_fix["lon"]
                        break
                gated = apply_center_gates(
                    tb_float, frame_bounds, bf_guess_lat, bf_guess_lon,
                    ref_lat=interp_lat, ref_lon=interp_lon,
                )
                cfix = gated["cfix_raw"]
                if gated["passed"]:
                    cached["center_fix"] = gated["center_fix"]
                else:
                    # find_ir_center's success return uses `eye_score` /
                    # `ir_rad_dif`; its no-candidate return uses `best_*`.
                    # Prefer the success keys when gates rejected a found
                    # candidate so the diagnostic chart shows real values.
                    cached["center_fix"] = {
                        "success": False,
                        "reason": gated["gate_info"].get("reason", "unknown"),
                        "gates": gated["gate_info"],
                        "best_score": cfix.get("eye_score", cfix.get("best_score", 0)),
                        "best_ir_rad_dif": cfix.get("ir_rad_dif", cfix.get("best_ir_rad_dif", 0)),
                        "n_candidates": cfix.get("n_candidates", 0),
                    }
                    if cfix.get("found_lat") is not None:
                        cached["center_fix"]["found_lat"] = cfix["found_lat"]
                        cached["center_fix"]["found_lon"] = cfix["found_lon"]
                        cached["center_fix"]["guess_lat"] = cfix["guess_lat"]
                        cached["center_fix"]["guess_lon"] = cfix["guess_lon"]
                        cached["center_fix"]["dist_deg"] = cfix.get("dist_deg", 0)
                # Re-cache with center_fix included
                _gcs_rt_put(atcf_id.upper(), dt_str, cached,
                            lat=interp_lat, lon=interp_lon,
                            radius_deg=radius_deg)
                # Log the result
                _log_center_fix(
                    atcf_id.upper(), storm.get("name", ""),
                    cached.get("datetime_utc", dt_str),
                    cached.get("satellite", ""), cfix,
                )
            except Exception:
                cached["center_fix"] = None

        return JSONResponse(
            content=cached,
            headers={"Cache-Control": "public, max-age=300"},
        )

    # Cutout centered on the storm's INTERPOLATED position at this
    # frame's time (not the static advisory) — keeps historical frames
    # framed correctly when the storm has moved.
    raw = fetch_ir_tb_raw(interp_lat, interp_lon, target_dt, box_deg,
                          max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
    if not raw or raw.get("tb") is None:
        raise HTTPException(status_code=502, detail=f"No IR data for frame {frame_index}")

    tb = raw["tb"]
    arr = np.asarray(tb, dtype=np.float32)
    mask = ~np.isfinite(arr) | (arr <= 0)
    scaled = np.clip((arr - _TB_VMIN) * _TB_SCALE + 1, 1, 255)
    scaled[mask] = 0
    encoded = scaled.astype(np.uint8)

    # IR-based center fix for hurricanes (>= 65 kt)
    center_fix = None
    cfix_raw = None
    vmax_kt = storm.get("vmax_kt")
    if vmax_kt is not None and vmax_kt >= 65:
        frame_bounds = raw.get("bounds", [
            [interp_lat - half, interp_lon - half],
            [interp_lat + half, interp_lon + half],
        ])

        # Use the nearest successful center_fix from an adjacent frame as
        # the initial guess, falling back to the interpolated best-track
        # position at this frame's time (tracks storm motion over 6h window).
        guess_lat, guess_lon = interp_lat, interp_lon
        for offset in [1, -1]:
            adj_idx = frame_index + offset
            if adj_idx < 0 or adj_idx >= len(frame_times):
                continue
            adj_dt = frame_times[adj_idx].strftime("%Y%m%d%H%M")
            adj_ilat, adj_ilon = _interp_pos_at(
                atcf_id, frame_times[adj_idx], center_lat, center_lon)
            adj_cached = _gcs_rt_get(atcf_id.upper(), adj_dt,
                                    lat=adj_ilat, lon=adj_ilon,
                                    radius_deg=radius_deg)
            adj_fix = adj_cached.get("center_fix") if adj_cached else None
            if isinstance(adj_fix, dict) and adj_fix.get("lat") is not None:
                guess_lat = adj_fix["lat"]
                guess_lon = adj_fix["lon"]
                break

        try:
            gated = apply_center_gates(
                arr, frame_bounds, guess_lat, guess_lon,
                ref_lat=interp_lat, ref_lon=interp_lon,
            )
            cfix_raw = gated["cfix_raw"]
            if gated["passed"]:
                center_fix = gated["center_fix"]
            else:
                # Store a failure record so the diagnostic chart and tooltip
                # can show WHY gates rejected the candidate (otherwise the
                # frontend has nothing to display for rejected frames).
                center_fix = {
                    "success": False,
                    "reason": gated["gate_info"].get("reason", "unknown"),
                    "gates": gated["gate_info"],
                    "best_score": cfix_raw.get("eye_score", cfix_raw.get("best_score", 0)),
                    "best_ir_rad_dif": cfix_raw.get("ir_rad_dif", cfix_raw.get("best_ir_rad_dif", 0)),
                    "n_candidates": cfix_raw.get("n_candidates", 0),
                }
        except Exception:
            pass  # center fix is best-effort; never block frame delivery

        # Log every center-fix attempt (success or NaN) to GCS archive
        try:
            _log_center_fix(
                atcf_id.upper(),
                storm.get("name", ""),
                raw.get("datetime_utc", dt_str),
                raw.get("satellite", ""),
                cfix_raw,
            )
        except Exception:
            pass

    frame_result = {
        "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
        "tb_rows": encoded.shape[0],
        "tb_cols": encoded.shape[1],
        "tb_vmin": _TB_VMIN,
        "tb_vmax": _TB_VMAX,
        "datetime_utc": raw["datetime_utc"],
        "satellite": raw.get("satellite", ""),
        "bounds": raw.get("bounds", [
            [interp_lat - half, interp_lon - half],
            [interp_lat + half, interp_lon + half],
        ]),
        "frame_index": frame_index,
        "total_frames": len(frame_times),
        "center_fix": center_fix,
    }

    # Cache to GCS (keyed by interpolated position — see _pos_key docs)
    _gcs_rt_put(atcf_id.upper(), dt_str, frame_result,
                lat=interp_lat, lon=interp_lon, radius_deg=radius_deg)

    del tb, arr, mask, scaled, encoded

    return JSONResponse(
        content=frame_result,
        headers={"Cache-Control": "public, max-age=300"},
    )


# ---------------------------------------------------------------------------
# Raw Tb Bundle Endpoint — all frames in one packed binary response
# ---------------------------------------------------------------------------

def _fetch_one_raw_tb_for_bundle(
    atcf_upper: str, storm: dict, target_dt: _dt,
    radius_deg: float, interp_lat: float, interp_lon: float,
) -> dict | None:
    """Bundle-endpoint worker: faithful clone of /ir-raw-frame's GCS-then-S3
    fetch path, minus the adjacent-frame center_fix chaining.

    Why no chaining: the bundle runs all frames in parallel from a clean
    cache-state read, so cross-frame center_fix lookups would either race
    (workers' frames not yet written) or do redundant GCS reads. Instead
    the initial guess is the interpolated best-track position at this
    frame's time, which is what the per-frame endpoint falls back to when
    no adjacent fix exists anyway. The (typically minor) loss in initial-
    guess quality is acceptable for first-load speed; users can still
    refetch a single frame via /ir-raw-frame to pick up the chained guess.
    """
    box_deg = radius_deg * 2.0
    half = radius_deg
    dt_str = target_dt.strftime("%Y%m%d%H%M")
    vmax_kt = storm.get("vmax_kt")

    # GCS cache first — keyed by INTERPOLATED position at this frame's time
    # so historical frames stay stable across recurring lookups.
    cached = _gcs_rt_get(atcf_upper, dt_str,
                        lat=interp_lat, lon=interp_lon,
                        radius_deg=radius_deg)
    if cached is not None:
        return cached

    # Cache miss: pull from S3 + render. Cutout centered on the
    # interpolated position so the cached frame's bounds match the key.
    raw = fetch_ir_tb_raw(interp_lat, interp_lon, target_dt, box_deg,
                          max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
    if not raw or raw.get("tb") is None:
        return None

    tb = raw["tb"]
    arr = np.asarray(tb, dtype=np.float32)
    mask = ~np.isfinite(arr) | (arr <= 0)
    scaled = np.clip((arr - _TB_VMIN) * _TB_SCALE + 1, 1, 255)
    scaled[mask] = 0
    encoded = scaled.astype(np.uint8)

    # Center fix for hurricanes (≥65 kt), seeded by interpolated track pos
    center_fix = None
    if vmax_kt is not None and vmax_kt >= 65:
        frame_bounds = raw.get("bounds", [
            [interp_lat - half, interp_lon - half],
            [interp_lat + half, interp_lon + half],
        ])
        try:
            gated = apply_center_gates(
                arr, frame_bounds, interp_lat, interp_lon,
                ref_lat=interp_lat, ref_lon=interp_lon,
            )
            if gated["passed"]:
                center_fix = gated["center_fix"]
            else:
                cfix = gated["cfix_raw"]
                center_fix = {
                    "success": False,
                    "reason": gated["gate_info"].get("reason", "unknown"),
                    "gates": gated["gate_info"],
                    "best_score": cfix.get("eye_score", cfix.get("best_score", 0)),
                    "best_ir_rad_dif": cfix.get("ir_rad_dif", cfix.get("best_ir_rad_dif", 0)),
                    "n_candidates": cfix.get("n_candidates", 0),
                }
                if cfix.get("found_lat") is not None:
                    center_fix["found_lat"] = cfix["found_lat"]
                    center_fix["found_lon"] = cfix["found_lon"]
                    center_fix["guess_lat"] = cfix["guess_lat"]
                    center_fix["guess_lon"] = cfix["guess_lon"]
                    center_fix["dist_deg"] = cfix.get("dist_deg", 0)
        except Exception:
            pass

    frame_result = {
        "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
        "tb_rows": encoded.shape[0],
        "tb_cols": encoded.shape[1],
        "tb_vmin": _TB_VMIN,
        "tb_vmax": _TB_VMAX,
        "datetime_utc": raw["datetime_utc"],
        "satellite": raw.get("satellite", ""),
        "bounds": raw.get("bounds", [
            [interp_lat - half, interp_lon - half],
            [interp_lat + half, interp_lon + half],
        ]),
        "center_fix": center_fix,
    }
    # Cache fire-and-forget so subsequent per-frame requests benefit
    _gcs_rt_put(atcf_upper, dt_str, frame_result,
                lat=interp_lat, lon=interp_lon, radius_deg=radius_deg)

    del tb, arr, mask, scaled, encoded
    return frame_result


@router.get("/storm/{atcf_id}/ir-raw-bundle")
def get_storm_ir_raw_bundle(
    request: Request,
    atcf_id: str,
    lookback_hours: float = Query(6.0, ge=1, le=24),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(30, ge=10, le=60),
):
    """Return all raw Tb frames for a storm in one packed binary response.

    Wire format:
        bytes [0..4):            uint32 little-endian: header JSON length L
        bytes [4..4+L):           UTF-8 JSON header (per-frame metadata)
        bytes [4+L..end):         concatenated uint8 Tb arrays, frame order

    JSON header shape:
        {
          "total_frames": N,
          "tb_vmin": 160.0, "tb_vmax": 330.0,
          "lookback_hours": 6.0, "interval_min": 30, "radius_deg": 10.0,
          "frames": [
            {"index": i, "datetime_utc": "...", "satellite": "...",
             "tb_rows": R, "tb_cols": C,
             "byte_offset": O, "byte_length": R*C,
             "bounds": [[s,w],[n,e]], "center_fix": {...} | null},
            ...
          ]
        }

    Frames that fail to fetch keep their index entry with byte_length=0
    and an "error" field — clients can show partial UI and optionally
    refetch the missing frame via /ir-raw-frame.

    Replaces the 13× /ir-raw-frame waterfall used by _fetchRawTbIncremental
    in realtime_ir.js. Server fans out across frames with a small thread
    pool so wall time ≈ max-frame fetch, and the wire payload drops from
    ~9 MB of base64 JSON to ~2.5 MB of binary in a single TLS round-trip.
    """
    import struct
    from concurrent.futures import ThreadPoolExecutor

    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found")

    atcf_upper = atcf_id.upper()
    center_lat = storm["lat"]
    center_lon = storm["lon"]

    center_dt = _dt.now(timezone.utc)
    frame_times = build_frame_times(center_dt, lookback_hours, interval_min)
    # Match /ir-raw-frame ordering: index 0 = oldest, index N-1 = most recent
    frame_times = list(reversed(frame_times))

    track_records = _get_track_for_interp(atcf_id)

    def _worker(item):
        i, target_dt = item
        interp_lat, interp_lon = center_lat, center_lon
        if track_records:
            ipos = _interpolate_track_position(track_records, target_dt)
            if ipos:
                interp_lat, interp_lon = ipos
        try:
            return (i, _fetch_one_raw_tb_for_bundle(
                atcf_upper, storm, target_dt, radius_deg, interp_lat, interp_lon,
            ))
        except Exception as ex:
            return (i, {"_error": str(ex)})

    # Cap workers at 4 — beyond that S3 throughput plateaus and the
    # NOAA-Open-Data anonymous endpoint starts returning sporadic 429s.
    indexed = list(enumerate(frame_times))
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(_worker, indexed))
    results.sort(key=lambda r: r[0])

    frame_headers = []
    payloads: list[bytes] = []
    offset = 0

    for i, frame in results:
        target_dt = frame_times[i]
        iso_dt = target_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        if frame is None or (isinstance(frame, dict) and "_error" in frame):
            frame_headers.append({
                "index": i,
                "datetime_utc": iso_dt,
                "tb_rows": 0,
                "tb_cols": 0,
                "byte_offset": offset,
                "byte_length": 0,
                "error": (frame or {}).get("_error", "no_data") if frame else "no_data",
            })
            continue
        try:
            tb_bytes = base64.b64decode(frame["tb_data"])
        except Exception as ex:
            frame_headers.append({
                "index": i, "datetime_utc": iso_dt,
                "tb_rows": 0, "tb_cols": 0,
                "byte_offset": offset, "byte_length": 0,
                "error": f"decode: {ex}",
            })
            continue
        rows = int(frame["tb_rows"])
        cols = int(frame["tb_cols"])
        if len(tb_bytes) != rows * cols:
            frame_headers.append({
                "index": i, "datetime_utc": iso_dt,
                "tb_rows": 0, "tb_cols": 0,
                "byte_offset": offset, "byte_length": 0,
                "error": "size_mismatch",
            })
            continue
        frame_headers.append({
            "index": i,
            "datetime_utc": frame.get("datetime_utc", iso_dt),
            "satellite": frame.get("satellite", ""),
            "tb_rows": rows,
            "tb_cols": cols,
            "byte_offset": offset,
            "byte_length": rows * cols,
            "bounds": frame.get("bounds"),
            "center_fix": frame.get("center_fix"),
        })
        payloads.append(tb_bytes)
        offset += rows * cols

    header = {
        "total_frames": len(frame_times),
        "tb_vmin": _TB_VMIN,
        "tb_vmax": _TB_VMAX,
        "lookback_hours": lookback_hours,
        "interval_min": interval_min,
        "radius_deg": radius_deg,
        "frames": frame_headers,
    }
    header_json = json.dumps(header, separators=(",", ":")).encode("utf-8")
    body = struct.pack("<I", len(header_json)) + header_json + b"".join(payloads)

    # Gzip the raw-Tb body for clients that accept it (all modern browsers
    # do). uint8 brightness-temp arrays have strong spatial correlation
    # and compress 30-50%. Browser decompresses transparently before
    # r.arrayBuffer() resolves — no client-side decode needed. Display
    # WebP bundles are NOT gzipped (already entropy-coded by codec).
    resp_headers = {
        "Cache-Control": "public, max-age=300",
        "X-Bundle-Frames": str(len(frame_times)),
        "X-Bundle-Header-Length": str(len(header_json)),
        "Vary": "Accept-Encoding",
        "Access-Control-Expose-Headers": "X-Bundle-Frames, X-Bundle-Header-Length",
    }
    accept_enc = request.headers.get("accept-encoding", "")
    if "gzip" in accept_enc.lower():
        import gzip as _gz
        body = _gz.compress(body, compresslevel=6)
        resp_headers["Content-Encoding"] = "gzip"

    return Response(
        content=body,
        media_type="application/octet-stream",
        headers=resp_headers,
    )


# ---------------------------------------------------------------------------
# Hovmoller Batch Endpoint — server-side radial profile computation
# ---------------------------------------------------------------------------

@router.get("/storm/{atcf_id}/hovmoller")
def get_storm_hovmoller(
    atcf_id: str,
    lookback_hours: float = Query(6.0, ge=1, le=24),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(30, ge=10, le=60),
):
    """
    Return pre-computed azimuthal-mean Tb radial profiles for all frames
    in the lookback window.  Single request replaces 25-49 individual
    ir-raw-frame fetches — response is ~15 KB vs ~9 MB of raw Tb data.
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

    frame_times = build_frame_times(_dt.now(timezone.utc), lookback_hours, interval_min)
    frame_times = list(reversed(frame_times))  # oldest first

    # Load frames — try GCS cache first, fetch from satellite if missing
    half = radius_deg
    box_deg = radius_deg * 2
    frames = []  # list of (target_dt, cached_dict_or_None)
    for ft in frame_times:
        dt_str = ft.strftime("%Y%m%d%H%M")
        ilat, ilon = _interp_pos_at(atcf_id, ft, center_lat, center_lon)
        cached = _gcs_rt_get(atcf_id.upper(), dt_str,
                            lat=ilat, lon=ilon, radius_deg=radius_deg)
        if cached is None:
            # Not in cache — fetch raw Tb from satellite and cache it
            try:
                raw = fetch_ir_tb_raw(ilat, ilon, ft, box_deg,
                                      max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
                if raw and raw.get("tb") is not None:
                    arr = np.asarray(raw["tb"], dtype=np.float32)
                    mask = ~np.isfinite(arr) | (arr <= 0)
                    scaled = np.clip((arr - _TB_VMIN) * _TB_SCALE + 1, 1, 255)
                    scaled[mask] = 0
                    encoded = scaled.astype(np.uint8)
                    cached = {
                        "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
                        "tb_rows": encoded.shape[0], "tb_cols": encoded.shape[1],
                        "tb_vmin": _TB_VMIN, "tb_vmax": _TB_VMAX,
                        "datetime_utc": raw.get("datetime_utc", ft.strftime("%Y-%m-%dT%H:%M:%SZ")),
                        "satellite": raw.get("satellite", ""),
                        "bounds": raw.get("bounds", [
                            [ilat - half, ilon - half],
                            [ilat + half, ilon + half],
                        ]),
                        "center_fix": None,
                    }
                    _gcs_rt_put(atcf_id.upper(), dt_str, cached,
                                lat=ilat, lon=ilon, radius_deg=radius_deg)
            except Exception:
                cached = None
        frames.append((ft, cached))

    # Collect center positions — interpolate for missing fixes
    track_records = _get_track_for_interp(atcf_id)
    fix_lat = [None] * len(frames)
    fix_lon = [None] * len(frames)
    known_indices = []

    for i, (ft, cached) in enumerate(frames):
        if cached and isinstance(cached.get("center_fix"), dict) and cached["center_fix"].get("lat"):
            fix_lat[i] = cached["center_fix"]["lat"]
            fix_lon[i] = cached["center_fix"]["lon"]
            known_indices.append(i)

    # Interpolate/extrapolate between known fixes (same algorithm as frontend)
    if len(known_indices) >= 2:
        for i in range(len(frames)):
            if fix_lat[i] is not None:
                continue
            lo, hi = -1, -1
            for ki_idx, ki in enumerate(known_indices):
                if ki <= i:
                    lo = ki_idx
                if ki >= i and hi < 0:
                    hi = ki_idx
            if lo >= 0 and hi >= 0 and lo != hi:
                lo_i, hi_i = known_indices[lo], known_indices[hi]
                frac = (i - lo_i) / (hi_i - lo_i)
                fix_lat[i] = fix_lat[lo_i] + frac * (fix_lat[hi_i] - fix_lat[lo_i])
                fix_lon[i] = fix_lon[lo_i] + frac * (fix_lon[hi_i] - fix_lon[lo_i])
            elif len(known_indices) >= 2:
                if lo < 0:
                    a, b = known_indices[0], known_indices[1]
                else:
                    a, b = known_indices[-2], known_indices[-1]
                span = b - a
                if span > 0:
                    ext = (i - a) / span
                    fix_lat[i] = fix_lat[a] + ext * (fix_lat[b] - fix_lat[a])
                    fix_lon[i] = fix_lon[a] + ext * (fix_lon[b] - fix_lon[a])
    elif len(known_indices) == 1:
        only = known_indices[0]
        for i in range(len(frames)):
            if fix_lat[i] is None:
                fix_lat[i] = fix_lat[only]
                fix_lon[i] = fix_lon[only]
    else:
        # No IR fixes — try interpolated track positions
        for i, (ft, _) in enumerate(frames):
            ipos = _interpolate_track_position(track_records, ft)
            if ipos:
                fix_lat[i], fix_lon[i] = ipos
            else:
                fix_lat[i], fix_lon[i] = center_lat, center_lon

    # Compute radial profiles
    max_rad_km = 200.0
    dr = 4.0
    n_rad_bins = int(max_rad_km / dr)

    out_times = []
    out_profiles = []
    out_extrapolated = []

    for i in range(len(frames) - 1, -1, -1):  # oldest → newest (reverse index order)
        ft, cached = frames[i]
        if not cached or "tb_data" not in cached:
            continue

        c_lat, c_lon = fix_lat[i], fix_lon[i]
        if c_lat is None:
            continue

        try:
            raw_u8 = np.frombuffer(
                base64.b64decode(cached["tb_data"]), dtype=np.uint8
            ).reshape(cached["tb_rows"], cached["tb_cols"])
        except Exception:
            continue

        rows, cols = raw_u8.shape
        bounds = cached.get("bounds", [
            [center_lat - half, center_lon - half],
            [center_lat + half, center_lon + half],
        ])
        south, west = bounds[0]
        north, east = bounds[1]
        lat_span = north - south
        lon_span = east - west
        if lat_span <= 0 or lon_span <= 0:
            continue

        vmin = cached.get("tb_vmin", _TB_VMIN)
        vmax = cached.get("tb_vmax", _TB_VMAX)

        # Center pixel
        cy = (north - c_lat) / lat_span * (rows - 1)
        cx = (c_lon - west) / lon_span * (cols - 1)
        cos_lat = np.cos(np.radians(c_lat))
        dy_km = lat_span / (rows - 1) * 111.0
        dx_km = lon_span / (cols - 1) * 111.0 * cos_lat

        # Vectorized radial binning
        row_idx = np.arange(rows)
        col_idx = np.arange(cols)
        dY = (row_idx - cy) * dy_km
        dX = (col_idx - cx) * dx_km
        DY, DX = np.meshgrid(dY, dX, indexing='ij')
        dist = np.sqrt(DY * DY + DX * DX)
        bins = np.floor(dist / dr).astype(np.int32)

        # Decode Tb
        valid = raw_u8 > 0
        tb_k = np.where(valid, vmin + (raw_u8.astype(np.float32) - 1) * (vmax - vmin) / 254.0, np.nan)

        profile = [None] * n_rad_bins
        for b in range(n_rad_bins):
            mask = valid & (bins == b)
            count = np.count_nonzero(mask)
            if count >= 3:
                profile[b] = round(float(np.mean(tb_k[mask])) - 273.15, 2)

        out_times.append(cached.get("datetime_utc", ft.strftime("%Y-%m-%dT%H:%M:%SZ")))
        out_profiles.append(profile)
        has_fix = cached.get("center_fix") and isinstance(cached["center_fix"], dict) and cached["center_fix"].get("lat")
        out_extrapolated.append(not bool(has_fix))

    if len(out_times) < 2:
        return JSONResponse(content={"times": [], "radii": [], "profiles": [], "extrapolated": [], "n_frames": 0})

    radii = [round(b * dr + dr / 2, 1) for b in range(n_rad_bins)]

    return JSONResponse(
        content={
            "times": out_times,
            "radii": radii,
            "profiles": out_profiles,
            "extrapolated": out_extrapolated,
            "n_frames": len(out_times),
        },
        headers={"Cache-Control": "public, max-age=120"},
    )


# ---------------------------------------------------------------------------
# Multi-Band Raw Frame Endpoint (Visible, WV, IR)
# ---------------------------------------------------------------------------

@router.get("/storm/{atcf_id}/band-raw-frame")
def get_storm_band_raw_frame(
    atcf_id: str,
    band: int = Query(8, ge=1, le=16, description="ABI band number (2=Vis, 8=WV, 13=IR)"),
    frame_index: int = Query(0, ge=0, description="Frame index (0 = most recent)"),
    lookback_hours: float = Query(3.0, ge=1, le=12),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(30, ge=10, le=60),
):
    """
    Fetch a single raw data frame for any satellite band.
    Band 2/3 = Visible (reflectance 0-1), Band 8 = Water Vapor (Tb K),
    Band 13 = Clean IR (Tb K).
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
    frame_times = list(reversed(frame_times))

    if frame_index >= len(frame_times):
        raise HTTPException(status_code=400, detail=f"frame_index {frame_index} out of range")

    target_dt = frame_times[frame_index]
    dt_str = target_dt.strftime("%Y%m%d%H%M")
    half = box_deg / 2.0

    # Check GCS cache
    cached = _gcs_band_get(band, atcf_id.upper(), dt_str, lat=center_lat, lon=center_lon)
    if cached is not None:
        cached["frame_index"] = frame_index
        cached["total_frames"] = len(frame_times)
        return JSONResponse(
            content=cached,
            headers={"Cache-Control": "public, max-age=300"},
        )

    # Fetch from satellite
    raw = fetch_band_raw(center_lat, center_lon, target_dt, box_deg, band=band,
                         max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
    if not raw or raw.get("data") is None:
        raise HTTPException(status_code=502, detail=f"No Band {band} data for frame {frame_index}")

    data = raw["data"]
    data_type = raw["data_type"]
    band_info = BAND_RANGES.get(band, BAND_RANGES[13])
    vmin, vmax = band_info["vmin"], band_info["vmax"]

    arr = np.asarray(data, dtype=np.float32)
    mask = ~np.isfinite(arr) | (arr < vmin * 0.5 if data_type == "tb" else arr < -0.01)
    scale = 254.0 / (vmax - vmin)
    scaled = np.clip((arr - vmin) * scale + 1, 1, 255)
    scaled[mask] = 0
    encoded = scaled.astype(np.uint8)

    frame_result = {
        "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
        "tb_rows": encoded.shape[0],
        "tb_cols": encoded.shape[1],
        "tb_vmin": vmin,
        "tb_vmax": vmax,
        "band": band,
        "data_type": data_type,
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
    _gcs_band_put(band, atcf_id.upper(), dt_str, frame_result, lat=center_lat, lon=center_lon)

    del data, arr, mask, scaled, encoded

    return JSONResponse(
        content=frame_result,
        headers={"Cache-Control": "public, max-age=300"},
    )


# ---------------------------------------------------------------------------
# Pre-Rendered IR Frame JPG Endpoint (fast image-overlay animation)
# ---------------------------------------------------------------------------

def _jpg_pos_key(lat: float | None, lon: float | None) -> str:
    """Position fragment for WebP cache keys. Rounded to 0.1° (~11 km)
    so the cache invalidates when the best-track interpolation shifts
    by more than ~one pixel at the storm-card zoom, but doesn't
    thrash on tiny sub-pixel re-interpolations. Returns empty string
    when position is None — caller falls back to the legacy unkeyed
    file path. Tied to the same precision the raw-Tb cache uses via
    `_pos_key` so the two stores stay in sync."""
    if lat is None or lon is None:
        return ""
    return f"_p{int(round(lat * 10))}_{int(round(lon * 10))}"


def _gcs_jpg_get(atcf_id: str, dt_str: str, band: int = 0,
                 lat: float | None = None,
                 lon: float | None = None) -> bytes | None:
    """Try to read a cached pre-rendered frame from GCS. Despite the
    legacy `_jpg_` name, frames are now WebP-encoded (smaller files at
    same perceptual quality — about 25-30% reduction on typical
    storm-cropped frames).

    Cache key prefix is `ir-webp-merc` (Mercator-warped) for the main IR
    band — needed because the frontend now uses these directly as
    L.imageOverlay on a Mercator basemap. Prior `ir-webp` entries are
    equirectangular and would land geographically displaced when stretched
    by Leaflet; they age out through the bucket lifecycle. Band frames
    (WV/Vis) still use the old `band{N}-webp` prefix because they're
    drawn to a flat <canvas> in the microwave-compare modal where no
    map projection applies.

    When `lat` / `lon` are supplied, the storm's interpolated position
    is baked into the cache key so a best-track update — which shifts
    the interpolation for historical frames — invalidates the stale
    WebPs (which were cropped at the OLD interpolation). Without that,
    older frames in the animation jump relative to newer ones until the
    bucket lifecycle ages them out. Callers that don't have a position
    (back-compat path) fall through to the unkeyed name."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return None
    prefix = "ir-webp-merc" if band == 0 else f"band{band}-webp"
    pos = _jpg_pos_key(lat, lon)
    key = f"{_GCS_RT_VERSION}/{prefix}/{atcf_id}/{dt_str}{pos}.webp"
    try:
        blob = bucket.blob(key)
        return blob.download_as_bytes(timeout=5)
    except Exception:
        # Position-keyed miss: fall back to the legacy unkeyed name so
        # the rollout doesn't blow away the warm cache instantaneously.
        # Old entries gradually age out via bucket lifecycle as new
        # position-keyed ones replace them on next prewarm.
        if pos:
            try:
                legacy = f"{_GCS_RT_VERSION}/{prefix}/{atcf_id}/{dt_str}.webp"
                return bucket.blob(legacy).download_as_bytes(timeout=5)
            except Exception:
                return None
        return None


def _gcs_jpg_put(atcf_id: str, dt_str: str, jpg_bytes: bytes, band: int = 0,
                 lat: float | None = None,
                 lon: float | None = None):
    """Write a pre-rendered WebP frame to GCS (fire-and-forget). Name
    kept for back-compat with existing call sites — the bytes are now
    WebP (encoded that way by _render_ir_jpg / _render_band_jpg).
    See _gcs_jpg_get for the `ir-webp-merc` prefix rationale and the
    position-keyed name for best-track invalidation."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return
    def _upload():
        prefix = "ir-webp-merc" if band == 0 else f"band{band}-webp"
        pos = _jpg_pos_key(lat, lon)
        key = f"{_GCS_RT_VERSION}/{prefix}/{atcf_id}/{dt_str}{pos}.webp"
        try:
            blob = bucket.blob(key)
            blob.upload_from_string(jpg_bytes, content_type="image/webp", timeout=15)
        except Exception:
            pass
    threading.Thread(target=_upload, daemon=True).start()


# ── Claude IR LUT for JPG rendering (matches client-side 'claude-ir') ──
# Built from Tb stops mapped to fractions over the 160–330K uint8 encoding range.
# This matches the client buildLUTfromTb() exactly.
_CLAUDE_IR_TB_STOPS = [
    (310, 12,12,22), (293, 70,70,82), (283, 120,120,132),
    (273, 180,180,192), (263, 216,218,228), (253, 140,210,220),
    (248, 68,180,196), (243, 32,148,166), (238, 40,178,116),
    (233, 96,208,68), (228, 192,220,40), (223, 238,196,48),
    (218, 228,132,48), (213, 214,78,56), (208, 180,36,68),
    (203, 196,48,156), (198, 168,64,200), (193, 120,48,180),
    (183, 64,24,140), (173, 28,12,96),
]

def _build_claude_ir_jpg_lut() -> np.ndarray:
    """Build 256-entry RGBA LUT matching the client claude-ir colormap."""
    vmin, vmax = 160.0, 330.0
    # Convert Tb stops to fraction stops (frac = 1 - (tb-vmin)/(vmax-vmin))
    frac_stops = []
    for tb, r, g, b in _CLAUDE_IR_TB_STOPS:
        f = 1.0 - (tb - vmin) / (vmax - vmin)
        frac_stops.append((f, r, g, b))
    frac_stops.sort(key=lambda s: s[0])

    lut = np.zeros((256, 4), dtype=np.uint8)
    for i in range(256):
        frac = i / 255.0
        # Find enclosing stops
        lo, hi = frac_stops[0], frac_stops[-1]
        for s in range(len(frac_stops) - 1):
            if frac_stops[s][0] <= frac <= frac_stops[s + 1][0]:
                lo, hi = frac_stops[s], frac_stops[s + 1]
                break
        t = 0.0 if hi[0] == lo[0] else (frac - lo[0]) / (hi[0] - lo[0])
        t = max(0.0, min(1.0, t))
        lut[i, 0] = int(lo[1] + t * (hi[1] - lo[1]) + 0.5)
        lut[i, 1] = int(lo[2] + t * (hi[2] - lo[2]) + 0.5)
        lut[i, 2] = int(lo[3] + t * (hi[3] - lo[3]) + 0.5)
        lut[i, 3] = 255
    return lut

_CLAUDE_IR_JPG_LUT = _build_claude_ir_jpg_lut()


def _warp_eq_to_mercator_local(field: np.ndarray, lat_min: float,
                               lat_max: float) -> np.ndarray:
    """Re-sample a small equirectangular cutout (rows uniform in latitude,
    top row = lat_max, bottom row = lat_min) onto a Mercator-y pixel grid
    spanning the SAME geographic lat range.

    Why: Leaflet's L.imageOverlay places an image between two corner
    lat/lons by linearly CSS-stretching it in *projected* (Web Mercator)
    screen space. An equirectangular source pixel labeled "lat L" therefore
    lands at the screen y-position that Mercator assigns to a different,
    higher latitude. For a ±10° storm cutout at 14°N the displacement is
    ~0.5-0.8° (≈80 km) — perceptible at eye scale. Pre-warping the source
    so rows are uniform in Mercator y makes the linear CSS-stretch produce
    a geographically correct image at the original lat bounds.

    This is the localized analogue of build_env_overlays._warp_eq_to_mercator;
    it operates on a small lat window rather than the global [+90, -90] range.

    Cap at ±WEB_MERC_LAT_MAX (85.05°) for numerical safety even though
    storm cutouts never approach the pole.
    """
    WEB_MERC_LAT_MAX = 85.05112877980659
    ny_in, nx_in = field.shape
    lat_max_c = max(min(lat_max,  WEB_MERC_LAT_MAX), -WEB_MERC_LAT_MAX)
    lat_min_c = max(min(lat_min,  WEB_MERC_LAT_MAX), -WEB_MERC_LAT_MAX)
    if lat_max_c <= lat_min_c:
        return field  # degenerate; skip warp
    # Mercator y at top/bottom of the cutout
    my_top = math.log(math.tan(math.pi / 4 + math.radians(lat_max_c) / 2))
    my_bot = math.log(math.tan(math.pi / 4 + math.radians(lat_min_c) / 2))
    # For each output row, find the lat whose Mercator-y matches that
    # row's linear-screen position between (my_top, my_bot).
    rows_out = np.arange(ny_in, dtype=np.float64)
    merc_y = my_top - (rows_out + 0.5) / ny_in * (my_top - my_bot)
    lats_out = np.degrees(np.arctan(np.sinh(merc_y)))
    # Equirectangular source row for each target lat. Nearest neighbor so
    # masked/NaN pixels don't blur across cloud edges.
    src_rows = np.clip(
        np.round((lat_max - lats_out) / (lat_max - lat_min) * ny_in).astype(int),
        0, ny_in - 1,
    )
    return field[src_rows, :].copy()


def _render_ir_jpg(tb_array: np.ndarray, quality: int = 75,
                   lat_bounds: tuple[float, float] | None = None) -> bytes | None:
    """Render a raw Tb array to WebP bytes using the Claude IR colormap.

    If `lat_bounds=(lat_min, lat_max)` is supplied, the array is Mercator-warped
    before colormap LUT lookup so the resulting image displays correctly when
    placed on a Web Mercator basemap via L.imageOverlay (linear CSS-stretch
    between projected corner positions). See _warp_eq_to_mercator_local."""
    from PIL import Image

    arr = np.asarray(tb_array, dtype=np.float32)
    if not np.any(np.isfinite(arr)):
        return None

    if lat_bounds is not None:
        arr = _warp_eq_to_mercator_local(arr, lat_bounds[0], lat_bounds[1])

    frac = 1.0 - (arr - _TB_VMIN) / (_TB_VMAX - _TB_VMIN)
    frac = np.clip(frac, 0.0, 1.0)
    indices = (frac * 255).astype(np.uint8)

    rgba = _CLAUDE_IR_JPG_LUT[indices]  # (H, W, 4)

    # NaN/invalid → black (JPG has no alpha)
    mask = ~np.isfinite(arr) | (arr <= 0)
    rgba[mask] = [0, 0, 0, 255]

    img = Image.fromarray(rgba, "RGBA").convert("RGB")
    buf = io.BytesIO()
    # WebP instead of JPEG: ~25-30% smaller at equivalent visual
    # quality on storm-cropped frames. Method 4 balances encode
    # speed vs compression ratio (range 0=fast, 6=slowest/smallest).
    img.save(buf, format="WEBP", quality=quality, method=4)
    return buf.getvalue()


# ── Claude WV colormap LUT ─────────────────────────────────────
# Designed to highlight dry-air signatures (CIMSS/CIRA convention):
#   warm Tb → terra-cotta/orange: dry intrusions, lower-trop holes
#   mid Tb  → cream / ivory:       transition (mid-trop moisture)
#   cool Tb → cyan/cobalt blues:   moist mid-trop
#   cold Tb → vivid greens:        deep convection / overshooting tops
#
# Mapping `frac = 1 - (Tb - vmin) / (vmax - vmin)`, so frac=0 at the
# warmest end of the WV band's encoding range (~260 K for 6.2 µm) and
# frac=1 at the coldest (~170 K). The warm end uses saturated burnt
# colors so a dry slot reads instantly; the cold end peaks in green
# to call out convective bursts. Built once at import time as a 256-row
# uint8 LUT — same fast lookup pattern as _CLAUDE_IR_JPG_LUT.
_CLAUDE_WV_FRAC_STOPS = [
    # frac   R    G    B
    (0.000, 235, 110,  45),   # warm: saturated terra cotta (dry intrusion)
    (0.080, 215,  90,  50),   # rust red
    (0.160, 195, 105,  55),   # terracotta
    (0.240, 220, 150,  90),   # amber
    (0.310, 235, 200, 165),   # warm cream
    (0.380, 248, 235, 218),   # ivory
    (0.450, 242, 246, 248),   # off-white (mid-trop moisture)
    (0.510, 218, 235, 246),   # pale ice blue
    (0.580, 160, 210, 240),   # light cyan
    (0.660,  95, 175, 225),   # sky blue
    (0.740,  45, 130, 200),   # cobalt
    (0.800,  20,  90, 170),   # navy
    (0.860,  30, 130, 135),   # teal-green
    (0.910,  55, 180,  95),   # forest green (deep convection)
    (0.960, 140, 230, 145),   # emerald
    (1.000, 230, 250, 220),   # pale mint (overshooting tops)
]

def _build_claude_wv_lut() -> np.ndarray:
    """Build a 256-row RGBA uint8 LUT from the fraction stops."""
    stops = sorted(_CLAUDE_WV_FRAC_STOPS, key=lambda s: s[0])
    lut = np.zeros((256, 4), dtype=np.uint8)
    for i in range(256):
        f = i / 255.0
        lo, hi = stops[0], stops[-1]
        for s in range(len(stops) - 1):
            if stops[s][0] <= f <= stops[s + 1][0]:
                lo, hi = stops[s], stops[s + 1]
                break
        t = 0.0 if hi[0] == lo[0] else (f - lo[0]) / (hi[0] - lo[0])
        t = max(0.0, min(1.0, t))
        lut[i, 0] = int(lo[1] + t * (hi[1] - lo[1]) + 0.5)
        lut[i, 1] = int(lo[2] + t * (hi[2] - lo[2]) + 0.5)
        lut[i, 2] = int(lo[3] + t * (hi[3] - lo[3]) + 0.5)
        lut[i, 3] = 255
    return lut

_CLAUDE_WV_JPG_LUT = _build_claude_wv_lut()


def _render_band_jpg(data_array: np.ndarray, band: int,
                     vmin: float, vmax: float, quality: int = 75,
                     lat_bounds: tuple[float, float] | None = None) -> bytes | None:
    """Render a WV or Vis band array to WebP bytes.

    WV: Claude-inspired CIMSS-style palette via LUT lookup — dry air
        in terra-cotta/orange, mid moisture in cream→cyan, deep
        convection in vivid green.
    Vis: grayscale (dark=low reflectance, white=clouds).

    If `lat_bounds=(lat_min, lat_max)` is supplied, the array is
    Mercator-warped before colormap lookup so the WebP displays
    correctly when placed on a Web Mercator basemap via L.imageOverlay.
    Today the band path renders into a flat <canvas> (microwave-compare
    modal) so the warp is opt-in; pass None to skip it."""
    from PIL import Image

    arr = np.asarray(data_array, dtype=np.float32)
    if not np.any(np.isfinite(arr)):
        return None

    if lat_bounds is not None:
        arr = _warp_eq_to_mercator_local(arr, lat_bounds[0], lat_bounds[1])

    mask = ~np.isfinite(arr)

    if band == WV_BAND:
        # Invert so warm Tb (dry) → frac 0, cold Tb (convection) → frac 1.
        # The LUT then maps frac to the Claude WV palette in one shot.
        frac = np.clip(1.0 - (arr - vmin) / (vmax - vmin), 0.0, 1.0)
        indices = (frac * 255).astype(np.uint8)
        rgba = _CLAUDE_WV_JPG_LUT[indices]
        rgb = rgba[..., :3]
    elif band == 7:
        # SWIR (Band 7, 3.9 µm) — nighttime fallback for Visible.
        # Invert so cold Tb (clouds) → bright, warm Tb (surface) → dark.
        # Visually mimics nighttime visible imagery (cf. Tropical Tidbits
        # "vis_swir"). Slight gamma stretch to brighten mid-tones.
        frac = np.clip(1.0 - (arr - vmin) / (vmax - vmin), 0.0, 1.0)
        gray = (np.power(frac, 0.7) * 245 + 10).astype(np.uint8)
        rgb = np.stack([gray, gray, gray], axis=-1)
    else:
        # Vis: no inversion — high reflectance = bright (white clouds)
        frac = np.clip((arr - vmin) / (vmax - vmin), 0.0, 1.0)
        gray = (frac * 245 + 10).astype(np.uint8)
        rgb = np.stack([gray, gray, gray], axis=-1)

    rgb = rgb.copy()  # writable for the mask blackout below
    rgb[mask] = [0, 0, 0]

    img = Image.fromarray(rgb, "RGB")
    buf = io.BytesIO()
    # WebP — same encoding as the IR path (smaller than JPEG at equal quality)
    img.save(buf, format="WEBP", quality=quality, method=4)
    return buf.getvalue()


@router.get("/storm/{atcf_id}/band-frame.jpg")
def get_band_frame_jpg(
    atcf_id: str,
    band: int = Query(8, description="Band number: 8=WV, 2=Vis"),
    frame_index: int = Query(0, ge=0),
    lookback_hours: float = Query(6.0, ge=1, le=24),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(30, ge=10, le=60),
):
    """Return a pre-rendered WV/Vis band frame as a JPEG image."""
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
    box_deg = radius_deg * 2

    frame_times = build_frame_times(
        _dt.now(timezone.utc), lookback_hours, interval_min
    )
    frame_times = list(reversed(frame_times))

    if frame_index >= len(frame_times):
        raise HTTPException(status_code=400, detail=f"frame_index {frame_index} out of range")

    target_dt = frame_times[frame_index]
    dt_str = target_dt.strftime("%Y%m%d%H%M")

    # Interpolated storm position at this frame's time — used for the
    # cutout center AND cache keys so the band frame co-registers with the
    # IR frame (which centers on the same interp position) and the MW
    # compare panel. Mirrors get_ir_frame_jpg. Falls back to the advisory
    # fix for newly-formed storms with no track yet.
    center_lat, center_lon = _interp_pos_at(atcf_id, target_dt, center_lat, center_lon)

    bounds = [
        [center_lat - half, center_lon - half],
        [center_lat + half, center_lon + half],
    ]
    bucket, _ = select_goes_sat(center_lon, target_dt)
    sat_name = satellite_name_from_bucket(bucket)

    meta_headers = {
        "Cache-Control": "public, max-age=300",
        "X-Frame-Index": str(frame_index),
        "X-Total-Frames": str(len(frame_times)),
        "X-Datetime": target_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "X-Satellite": sat_name,
        "X-Bounds": json.dumps(bounds),
        "X-Band": str(band),
        "Access-Control-Expose-Headers": "X-Frame-Index, X-Total-Frames, X-Datetime, X-Satellite, X-Bounds, X-Band",
    }

    # Check GCS JPG cache
    cached_jpg = _gcs_jpg_get(atcf_id.upper(), dt_str, band=band,
                              lat=center_lat, lon=center_lon)
    if cached_jpg:
        return Response(content=cached_jpg, media_type="image/webp", headers=meta_headers)

    # Fallback: check if raw Tb is cached and render JPG from it
    cached_raw = _gcs_band_get(band, atcf_id.upper(), dt_str, lat=center_lat, lon=center_lon)
    if cached_raw is not None and cached_raw.get("tb_data"):
        try:
            binfo = BAND_RANGES.get(band, BAND_RANGES[13])
            encoded = np.frombuffer(
                base64.b64decode(cached_raw["tb_data"]), dtype=np.uint8
            ).reshape((cached_raw["tb_rows"], cached_raw["tb_cols"]))
            bvmin, bvmax = binfo["vmin"], binfo["vmax"]
            decoded = ((encoded.astype(np.float32) - 1) / (254.0 / (bvmax - bvmin))) + bvmin
            decoded[encoded == 0] = np.nan
            jpg_bytes = _render_band_jpg(decoded, band, bvmin, bvmax)
            if jpg_bytes:
                _gcs_jpg_put(atcf_id.upper(), dt_str, jpg_bytes, band=band,
                             lat=center_lat, lon=center_lon)
                return Response(content=jpg_bytes, media_type="image/webp", headers=meta_headers)
        except Exception:
            pass

    # Render fresh from S3
    try:
        raw = fetch_band_raw(center_lat, center_lon, target_dt, box_deg, band=band,
                         max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
    except Exception:
        raise HTTPException(status_code=502, detail=f"No band {band} data")

    if not raw or raw.get("data") is None:
        raise HTTPException(status_code=502, detail=f"No band {band} data for frame {frame_index}")

    binfo = BAND_RANGES.get(band, BAND_RANGES[13])
    jpg_bytes = _render_band_jpg(raw["data"], band, binfo["vmin"], binfo["vmax"])
    if not jpg_bytes:
        raise HTTPException(status_code=502, detail="Band rendering failed")

    _gcs_jpg_put(atcf_id.upper(), dt_str, jpg_bytes, band=band,
                 lat=center_lat, lon=center_lon)
    del raw
    return Response(content=jpg_bytes, media_type="image/webp", headers=meta_headers)


# ---------------------------------------------------------------------------
# Band Frames Bundle — WV/Vis WebPs in one binary response
# ---------------------------------------------------------------------------

def _get_or_render_band_jpg(
    atcf_upper: str, interp_lat: float, interp_lon: float,
    target_dt: _dt, radius_deg: float, band: int,
) -> tuple[bytes | None, str]:
    """Bundle helper for WV/Vis bands — mirrors _get_or_render_ir_jpg.

    GCS-JPG → cached-raw → fresh-S3 fallback chain. For Vis (band 2)
    the chain may legitimately return (None, sat_name) at night when
    solar elevation drops too low for usable imagery — caller marks the
    frame as missing in the bundle header and the client skips it.
    """
    box_deg = radius_deg * 2.0
    dt_str = target_dt.strftime("%Y%m%d%H%M")
    bucket, _ = select_goes_sat(interp_lon, target_dt)
    sat_name = satellite_name_from_bucket(bucket)

    # Vis is daytime-only — skip cleanly when sun is too low
    if band == VIS_BAND:
        se = _solar_elevation(interp_lat, interp_lon, target_dt)
        if se < -6:
            return None, sat_name

    # Warmest: pre-rendered WebP in GCS (band-specific cache prefix)
    cached_jpg = _gcs_jpg_get(atcf_upper, dt_str, band=band,
                              lat=interp_lat, lon=interp_lon)
    if cached_jpg:
        return cached_jpg, sat_name

    # Next: render from cached raw uint8 (skips S3)
    cached_raw = _gcs_band_get(band, atcf_upper, dt_str,
                              lat=interp_lat, lon=interp_lon)
    if cached_raw is not None and cached_raw.get("tb_data"):
        try:
            binfo = BAND_RANGES.get(band, BAND_RANGES[13])
            encoded = np.frombuffer(
                base64.b64decode(cached_raw["tb_data"]), dtype=np.uint8
            ).reshape((cached_raw["tb_rows"], cached_raw["tb_cols"]))
            bvmin, bvmax = binfo["vmin"], binfo["vmax"]
            decoded = ((encoded.astype(np.float32) - 1) / (254.0 / (bvmax - bvmin))) + bvmin
            decoded[encoded == 0] = np.nan
            jpg_bytes = _render_band_jpg(decoded, band, bvmin, bvmax)
            if jpg_bytes:
                _gcs_jpg_put(atcf_upper, dt_str, jpg_bytes, band=band,
                             lat=interp_lat, lon=interp_lon)
                return jpg_bytes, sat_name
        except Exception:
            pass

    # Coldest: fetch from S3 + render. Vis L1b segments are 16× the IR
    # data per frame, so cold loads here are noticeably slower than IR
    # cold loads. The bundle's parallel fan-out still completes in
    # max-frame-time wall clock instead of N × per-frame-time.
    try:
        raw = fetch_band_raw(interp_lat, interp_lon, target_dt, box_deg, band=band,
                             max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
    except Exception:
        return None, sat_name
    if not raw or raw.get("data") is None:
        return None, sat_name
    binfo = BAND_RANGES.get(band, BAND_RANGES[13])
    jpg_bytes = _render_band_jpg(raw["data"], band, binfo["vmin"], binfo["vmax"])
    if jpg_bytes:
        _gcs_jpg_put(atcf_upper, dt_str, jpg_bytes, band=band,
                     lat=interp_lat, lon=interp_lon)
        return jpg_bytes, raw.get("satellite", sat_name)
    return None, sat_name


@router.get("/storm/{atcf_id}/band-frames-bundle")
def get_storm_band_frames_bundle(
    atcf_id: str,
    band: int = Query(8, description="Band: 8=WV (6.2 µm), 2=Vis (0.64 µm), 7=SWIR (3.9 µm, night fallback for Vis)"),
    lookback_hours: float = Query(6.0, ge=1, le=24),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(15, ge=10, le=60),
):
    """Return all WV or Vis band frames for a storm in one packed binary
    response. Same wire format as /ir-frames-bundle:
        [uint32 LE header_length][JSON header][concat WebP bytes]

    Why this matters for the Storm Satellite WV/Vis compare view:
    previously each band frame was fetched via /band-frame.jpg in a
    per-frame waterfall. With Vis prewarm capped at the 4 most-recent
    frames (Vis L1b is 16× the IR data per segment), most older frames
    were cold-cache → 25 × ~5-10 s of serialized S3 work. The bundle
    fans out across frames with ThreadPoolExecutor(max_workers=4) so
    total wall time ≈ slowest-frame fetch.

    Vis frames that fall outside daylight (solar elevation < -6°) are
    marked byte_length=0 with an "error":"nighttime" entry so the
    client can skip them without showing black overlays.
    """
    import struct
    from concurrent.futures import ThreadPoolExecutor

    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found")

    atcf_upper = atcf_id.upper()
    center_lat = storm["lat"]
    center_lon = storm["lon"]
    half = radius_deg

    center_dt = _dt.now(timezone.utc)
    frame_times = build_frame_times(center_dt, lookback_hours, interval_min)
    frame_times = list(reversed(frame_times))

    latest_dt = frame_times[-1] if frame_times else center_dt
    s_ilat, s_ilon = _interp_pos_at(atcf_id, latest_dt, center_lat, center_lon)
    bounds = [
        [s_ilat - half, s_ilon - half],
        [s_ilat + half, s_ilon + half],
    ]

    def _worker(item):
        i, target_dt = item
        try:
            ilat, ilon = _interp_pos_at(
                atcf_id, target_dt, center_lat, center_lon)
            jpg, sat = _get_or_render_band_jpg(
                atcf_upper, ilat, ilon, target_dt, radius_deg, band,
            )
            frame_bounds = [
                [ilat - half, ilon - half],
                [ilat + half, ilon + half],
            ]
            # Real solar gate for the Vis "nighttime" label: a missing Vis
            # frame is only genuinely "nighttime" when the sun is actually
            # down. A daytime gap (upstream Band-2 latency/scan miss) must NOT
            # be labelled night — that mislabels the SWIR fallback as a night
            # frame on the client.
            is_night = (band == VIS_BAND and
                        _solar_elevation(ilat, ilon, target_dt) < -6)
            return (i, jpg, sat, frame_bounds, is_night, None)
        except Exception as ex:
            return (i, None, "", None, False, str(ex))

    indexed = list(enumerate(frame_times))
    # 8 workers: doubles the previous 4. Per-frame work is mostly S3
    # latency (~3-5 s/frame for Vis L1b), so more workers shorten the
    # cold-bundle wall clock close to one slowest-frame latency.
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(_worker, indexed))
    results.sort(key=lambda r: r[0])

    # Screen for anomalous scans (same "pops out and comes back" check the
    # IR/prebuilt-WV bundles use) and queue any flagged slot for self-heal on
    # the next prewarm cycle. frame_times is oldest-first, index-aligned.
    jpgs_by_idx = [None] * len(frame_times)
    for i, jpg, sat, fbounds, is_night, err in results:
        if jpg and err is None:
            jpgs_by_idx[i] = jpg
    band_anom_idx = _screen_and_queue_anomalies(
        atcf_upper, frame_times, jpgs_by_idx, label=f"band{band} (on-demand)",
        band=band)

    frame_headers = []
    payloads: list[bytes] = []
    offset = 0
    summary_sat = ""

    for i, jpg, sat, fbounds, is_night, err in results:
        target_dt = frame_times[i]
        iso_dt = target_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        is_anom = i in band_anom_idx
        if not jpg or err is not None or is_anom:
            # Distinguish anomalous scan, nighttime (expected for Vis), errors
            if is_anom:
                err_msg = "anomalous_scan"
            elif err:
                err_msg = err
            elif band == VIS_BAND:
                # Only call it night when the sun is actually down; a daytime
                # Band-2 gap is "no_data" so the client labels the SWIR
                # fallback "(SWIR)" not "(SWIR night)".
                err_msg = "nighttime" if is_night else "no_data"
            else:
                err_msg = "no_data"
            frame_headers.append({
                "index": i,
                "datetime_utc": iso_dt,
                "satellite": sat or "",
                "bounds": fbounds,
                "byte_offset": offset,
                "byte_length": 0,
                "error": err_msg,
            })
            continue
        frame_headers.append({
            "index": i,
            "datetime_utc": iso_dt,
            "satellite": sat or "",
            "bounds": fbounds,
            "byte_offset": offset,
            "byte_length": len(jpg),
        })
        payloads.append(jpg)
        offset += len(jpg)
        summary_sat = sat or summary_sat

    binfo = BAND_RANGES.get(band, BAND_RANGES[13])
    header = {
        "total_frames": len(frame_times),
        "bounds": bounds,
        "satellite": summary_sat,
        "band": band,
        "data_type": binfo["data_type"],
        "vmin": binfo["vmin"],
        "vmax": binfo["vmax"],
        "lookback_hours": lookback_hours,
        "interval_min": interval_min,
        "radius_deg": radius_deg,
        "media_type": "image/webp",
        "frames": frame_headers,
    }
    header_json = json.dumps(header, separators=(",", ":")).encode("utf-8")
    body = struct.pack("<I", len(header_json)) + header_json + b"".join(payloads)

    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "public, max-age=300",
            "X-Bundle-Frames": str(len(frame_times)),
            "X-Bundle-Band": str(band),
            "X-Bundle-Header-Length": str(len(header_json)),
            "Access-Control-Expose-Headers": "X-Bundle-Frames, X-Bundle-Band, X-Bundle-Header-Length",
        },
    )


# ─────────────────────────────────────────────────────────────────
# GeoColor bundle — per-frame solar-elevation-aware composite:
#   sun > -6° → Band 2 visible (white clouds, dark ocean)
#   sun ≤ -6° → Band 13 IR, inverted grayscale (cold tops = bright)
# Mirrors the band-frames-bundle wire format so the frontend reuses
# the existing parser; only the URL and per-frame band selection differ.
# ─────────────────────────────────────────────────────────────────

def _render_geocolor_jpg(
    data_array: np.ndarray, *, is_day: bool,
    vmin: float, vmax: float,
    lat_bounds: tuple[float, float] | None = None,
) -> bytes | None:
    """Render a Band-2 (day) or Band-13 (night) frame in the GeoColor
    style: day frames get the bright-clouds-on-dark-surface visible
    treatment (gamma-corrected grayscale, same as Vis); night frames
    get inverted-grayscale IR (cold cloud tops = bright). Returns the
    frame as WebP bytes ready to drop into a bundle payload."""
    from PIL import Image

    arr = np.asarray(data_array, dtype=np.float32)
    if not np.any(np.isfinite(arr)):
        return None

    if lat_bounds is not None:
        arr = _warp_eq_to_mercator_local(arr, lat_bounds[0], lat_bounds[1])

    mask = ~np.isfinite(arr)

    if is_day:
        # Band 2 reflectance: higher = brighter cloud. No inversion.
        # Gamma 0.8 brightens mid-tones (dawn/dusk) without blowing out
        # cloud highlights.
        frac = np.clip((arr - vmin) / (vmax - vmin), 0.0, 1.0)
        gray = (np.power(frac, 0.8) * 245 + 10).astype(np.uint8)
    else:
        # Band 13 brightness temperature: cold clouds (low Tb) should be
        # bright. Invert and apply a gentle gamma so deep convection
        # reads as brilliant white against a near-black ocean surface.
        frac = np.clip(1.0 - (arr - vmin) / (vmax - vmin), 0.0, 1.0)
        gray = (np.power(frac, 0.85) * 245 + 10).astype(np.uint8)

    rgb = np.stack([gray, gray, gray], axis=-1).copy()
    rgb[mask] = [0, 0, 0]

    img = Image.fromarray(rgb, "RGB")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=75, method=4)
    return buf.getvalue()


def _get_or_render_geocolor_jpg(
    atcf_upper: str, interp_lat: float, interp_lon: float,
    target_dt: _dt, radius_deg: float,
) -> tuple[bytes | None, str, bool]:
    """Bundle helper for the GeoColor product. Returns (jpg_bytes,
    satellite_name, is_day). Solar elevation at the storm center at
    `target_dt` picks the band: Band 2 for daytime, Band 13 for night.

    Cache strategy mirrors _get_or_render_band_jpg: GCS pre-rendered →
    cached raw → fresh S3 fallback. Cache prefix is `geocolor-webp` so
    these don't collide with the per-band caches."""
    box_deg = radius_deg * 2.0
    dt_str = target_dt.strftime("%Y%m%d%H%M")
    bucket, _ = select_goes_sat(interp_lon, target_dt)
    sat_name = satellite_name_from_bucket(bucket)
    is_day = _solar_elevation(interp_lat, interp_lon, target_dt) > -6
    band = VIS_BAND if is_day else 13

    # GCS pre-rendered GeoColor frame (own cache prefix so we don't
    # blow away the per-band caches when the GeoColor recipe evolves).
    geocolor_prefix = f"geocolor-webp/{atcf_upper}/{dt_str}.webp"
    bkt = _get_rt_gcs_bucket()
    if bkt is not None:
        try:
            blob = bkt.blob(f"{_GCS_RT_VERSION}/{geocolor_prefix}")
            cached = blob.download_as_bytes(timeout=5)
            if cached:
                return cached, sat_name, is_day
        except Exception:
            pass  # not cached yet — render below

    # Fall back to the per-band JPG cache (we may already have a vis or
    # IR rendering of this frame from another product). The GeoColor
    # vis-day path produces an identical grayscale to the Vis button, so
    # band-2 cache entries are interchangeable. Band 13 inverted is
    # NOT the same as the Claude IR colormap, so we can't reuse those.
    if is_day:
        cached_band_jpg = _gcs_jpg_get(atcf_upper, dt_str, band=VIS_BAND,
                                       lat=interp_lat, lon=interp_lon)
        if cached_band_jpg:
            # Cache the same bytes under the GeoColor prefix for next time.
            if bkt is not None:
                try:
                    bkt.blob(f"{_GCS_RT_VERSION}/{geocolor_prefix}").upload_from_string(
                        cached_band_jpg, content_type="image/webp", timeout=10)
                except Exception:
                    pass
            return cached_band_jpg, sat_name, is_day

    # Render from raw band data: try cached raw first, then fresh S3.
    binfo = BAND_RANGES.get(band, BAND_RANGES[13])
    bvmin, bvmax = binfo["vmin"], binfo["vmax"]

    cached_raw = _gcs_band_get(band, atcf_upper, dt_str,
                              lat=interp_lat, lon=interp_lon)
    if cached_raw is not None and cached_raw.get("tb_data"):
        try:
            encoded = np.frombuffer(
                base64.b64decode(cached_raw["tb_data"]), dtype=np.uint8
            ).reshape((cached_raw["tb_rows"], cached_raw["tb_cols"]))
            decoded = ((encoded.astype(np.float32) - 1) / (254.0 / (bvmax - bvmin))) + bvmin
            decoded[encoded == 0] = np.nan
            jpg_bytes = _render_geocolor_jpg(
                decoded, is_day=is_day, vmin=bvmin, vmax=bvmax)
            if jpg_bytes and bkt is not None:
                try:
                    bkt.blob(f"{_GCS_RT_VERSION}/{geocolor_prefix}").upload_from_string(
                        jpg_bytes, content_type="image/webp", timeout=10)
                except Exception:
                    pass
            return jpg_bytes, sat_name, is_day
        except Exception:
            pass

    try:
        raw = fetch_band_raw(interp_lat, interp_lon, target_dt, box_deg, band=band,
                             max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
    except Exception:
        return None, sat_name, is_day
    if not raw or raw.get("data") is None:
        return None, sat_name, is_day
    jpg_bytes = _render_geocolor_jpg(
        raw["data"], is_day=is_day, vmin=bvmin, vmax=bvmax)
    if jpg_bytes and bkt is not None:
        try:
            bkt.blob(f"{_GCS_RT_VERSION}/{geocolor_prefix}").upload_from_string(
                jpg_bytes, content_type="image/webp", timeout=10)
        except Exception:
            pass
    return jpg_bytes, raw.get("satellite", sat_name), is_day


@router.get("/storm/{atcf_id}/geocolor-frames-bundle")
def get_storm_geocolor_frames_bundle(
    atcf_id: str,
    lookback_hours: float = Query(6.0, ge=1, le=24),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(15, ge=10, le=60),
):
    """GeoColor bundle: per-frame solar-elevation switch between Band 2
    visible (day) and Band 13 IR (night, inverted grayscale). Same packed
    binary wire format as the IR/band bundles:
        [uint32 LE header_length][JSON header][concat WebP bytes]
    """
    import struct
    from concurrent.futures import ThreadPoolExecutor

    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found")

    atcf_upper = atcf_id.upper()
    center_lat = storm["lat"]
    center_lon = storm["lon"]
    half = radius_deg

    center_dt = _dt.now(timezone.utc)
    frame_times = build_frame_times(center_dt, lookback_hours, interval_min)
    frame_times = list(reversed(frame_times))

    latest_dt = frame_times[-1] if frame_times else center_dt
    s_ilat, s_ilon = _interp_pos_at(atcf_id, latest_dt, center_lat, center_lon)
    bounds = [
        [s_ilat - half, s_ilon - half],
        [s_ilat + half, s_ilon + half],
    ]

    def _worker(item):
        i, target_dt = item
        try:
            ilat, ilon = _interp_pos_at(
                atcf_id, target_dt, center_lat, center_lon)
            jpg, sat, is_day = _get_or_render_geocolor_jpg(
                atcf_upper, ilat, ilon, target_dt, radius_deg,
            )
            frame_bounds = [
                [ilat - half, ilon - half],
                [ilat + half, ilon + half],
            ]
            return (i, jpg, sat, frame_bounds, is_day, None)
        except Exception as ex:
            return (i, None, "", None, False, str(ex))

    indexed = list(enumerate(frame_times))
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(_worker, indexed))
    results.sort(key=lambda r: r[0])

    # Screen for anomalous scans + queue self-heal. The single day/night
    # render switch is NOT flagged (triangulation needs BOTH neighbors to
    # diverge; the switch only diverges from one side).
    jpgs_by_idx = [None] * len(frame_times)
    geo_is_day = [False] * len(frame_times)
    for i, jpg, sat, fbounds, is_day, err in results:
        geo_is_day[i] = bool(is_day)
        if jpg and err is None:
            jpgs_by_idx[i] = jpg
    # Pass per-frame is_day so the dim-out screen guards GeoColor's daytime
    # Band-2 frames (same failure mode as the Visible panel) without tripping
    # on the day→night Band-13 render switch.
    geo_anom_idx = _screen_and_queue_anomalies(
        atcf_upper, frame_times, jpgs_by_idx, label="geocolor",
        is_day=geo_is_day)

    frame_headers = []
    payloads: list[bytes] = []
    offset = 0
    summary_sat = ""
    n_day = 0
    n_night = 0

    for i, jpg, sat, fbounds, is_day, err in results:
        target_dt = frame_times[i]
        iso_dt = target_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        if not jpg or i in geo_anom_idx:
            err_msg = "anomalous_scan" if (jpg and i in geo_anom_idx) else (err or "no_data")
            frame_headers.append({
                "index": i, "datetime_utc": iso_dt, "satellite": sat or "",
                "bounds": fbounds, "byte_offset": offset, "byte_length": 0,
                "is_day": is_day, "error": err_msg,
            })
            continue
        frame_headers.append({
            "index": i, "datetime_utc": iso_dt, "satellite": sat or "",
            "bounds": fbounds, "byte_offset": offset, "byte_length": len(jpg),
            "is_day": is_day,
        })
        payloads.append(jpg)
        offset += len(jpg)
        summary_sat = sat or summary_sat
        if is_day:
            n_day += 1
        else:
            n_night += 1

    header = {
        "total_frames": len(frame_times),
        "bounds": bounds,
        "satellite": summary_sat,
        "product": "geocolor",
        "n_day_frames": n_day,
        "n_night_frames": n_night,
        "lookback_hours": lookback_hours,
        "interval_min": interval_min,
        "radius_deg": radius_deg,
        "media_type": "image/webp",
        "frames": frame_headers,
    }
    header_json = json.dumps(header, separators=(",", ":")).encode("utf-8")
    body = struct.pack("<I", len(header_json)) + header_json + b"".join(payloads)

    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "public, max-age=300",
            "X-Bundle-Frames": str(len(frame_times)),
            "X-Bundle-Product": "geocolor",
            "X-Bundle-Day-Frames": str(n_day),
            "X-Bundle-Night-Frames": str(n_night),
            "X-Bundle-Header-Length": str(len(header_json)),
            "Access-Control-Expose-Headers": "X-Bundle-Frames, X-Bundle-Product, X-Bundle-Day-Frames, X-Bundle-Night-Frames, X-Bundle-Header-Length",
        },
    )


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
    frame_times = list(reversed(frame_times))  # oldest first (idx 0 = oldest)

    # Determine satellite
    bucket, sat_key = select_goes_sat(center_lon, _dt.now(timezone.utc))

    frames = []
    for i, ft in enumerate(frame_times):
        # Per-frame center = the storm's INTERPOLATED position at this
        # frame's time — exactly what /ir-frame.jpg crops the cutout on
        # (so the cutout's true center, not the current advisory fix
        # which can be hours stale when JTWC skips a cycle). Consumers
        # like the IR↔MW compare modal co-register both panels on this,
        # not on storm["lat"]/["lon"], so the graticules line up.
        ilat, ilon = _interp_pos_at(atcf_id, ft, center_lat, center_lon)
        frames.append({
            "index": i,
            "datetime_utc": ft.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "center": [ilat, ilon],
            "bounds": [
                [ilat - half, ilon - half],
                [ilat + half, ilon + half],
            ],
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
    warp: str = Query("mercator", pattern="^(mercator|none)$"),
):
    """Return a pre-rendered IR frame as a JPEG image.

    Much faster than GIBS tile layers: single ~60KB image vs ~16 tiles.
    Metadata (bounds, time, satellite) is in response headers to avoid
    needing a separate metadata call.

    warp="mercator" (default) pre-warps the cutout to Web Mercator so it
    overlays correctly on the Leaflet detail map (L.imageOverlay linear
    CSS-stretch). warp="none" returns the native equirectangular render —
    used by the IR↔MW compare modal, whose canvas crop + lat/lon grid are
    linear in latitude, so a Mercator image there mismatches the (also
    equirectangular) microwave panel. The equirectangular variant is
    rendered on the fly and NOT written to the shared jpg cache, which
    holds only Mercator frames for the map.
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
    frame_times = list(reversed(frame_times))  # oldest first (idx 0 = oldest)

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

    # Interpolated storm position at this frame's time — used for the
    # Tb cache key, the cutout center, AND the WebP cache key so the
    # cached frame's bounds line up with its key. Computed FIRST so
    # the JPG-cache lookup below sees the interp position.
    ilat, ilon = _interp_pos_at(atcf_id, target_dt, center_lat, center_lon)

    # Mercator (default) vs native equirectangular (compare modal). The
    # shared jpg cache holds only Mercator frames, so the equirectangular
    # variant skips the cache entirely (read + write).
    mercator = warp.lower() != "none"
    lat_bounds = (ilat - half, ilat + half) if mercator else None

    # Check GCS JPG cache (position-keyed) — Mercator frames only.
    if mercator:
        cached_jpg = _gcs_jpg_get(atcf_id.upper(), dt_str, lat=ilat, lon=ilon)
        if cached_jpg:
            return Response(content=cached_jpg, media_type="image/webp", headers=meta_headers)

    # Fallback: check if raw Tb uint8 is cached in GCS (populated by pre-fetch)
    # and render JPG from it — avoids the S3 round-trip entirely.
    cached_raw = _gcs_rt_get(atcf_id.upper(), dt_str,
                            lat=ilat, lon=ilon, radius_deg=radius_deg)
    if cached_raw is not None and cached_raw.get("tb_data"):
        try:
            encoded = np.frombuffer(
                base64.b64decode(cached_raw["tb_data"]), dtype=np.uint8
            ).reshape((cached_raw["tb_rows"], cached_raw["tb_cols"]))
            decoded_tb = ((encoded.astype(np.float32) - 1) / _TB_SCALE) + _TB_VMIN
            decoded_tb[encoded == 0] = np.nan
            jpg_bytes = _render_ir_jpg(decoded_tb, lat_bounds=lat_bounds)
            if jpg_bytes:
                if mercator:
                    _gcs_jpg_put(atcf_id.upper(), dt_str, jpg_bytes,
                                 lat=ilat, lon=ilon)
                return Response(content=jpg_bytes, media_type="image/webp", headers=meta_headers)
        except Exception:
            pass  # Fall through to S3 fetch

    # Render fresh from S3 satellite data (cutout centered on interpolated pos)
    raw = fetch_ir_tb_raw(ilat, ilon, target_dt, box_deg,
                          max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
    if not raw or raw.get("tb") is None:
        raise HTTPException(status_code=502, detail=f"No IR data for frame {frame_index}")

    jpg_bytes = _render_ir_jpg(raw["tb"], lat_bounds=lat_bounds)
    if not jpg_bytes:
        raise HTTPException(status_code=502, detail="IR rendering failed")

    # Cache to GCS (Mercator frames only — the equirectangular compare
    # variant is one-off and must not overwrite the map's cache entry).
    if mercator:
        _gcs_jpg_put(atcf_id.upper(), dt_str, jpg_bytes, lat=ilat, lon=ilon)

    del raw

    return Response(content=jpg_bytes, media_type="image/webp", headers=meta_headers)


# ---------------------------------------------------------------------------
# Display Frames Bundle — all WebPs in one binary response
# ---------------------------------------------------------------------------

def _get_or_render_ir_jpg(
    atcf_upper: str, interp_lat: float, interp_lon: float,
    target_dt: _dt, radius_deg: float,
) -> tuple[bytes | None, str]:
    """Bundle-endpoint helper: return one frame's WebP bytes + satellite name.

    interp_lat/lon should be the storm's INTERPOLATED track position at
    target_dt (the bundle endpoint computes this before fan-out). It's
    used for both the Tb-cache key and the cutout center so the cached
    frame's bounds line up with its key.

    Mirrors the GCS-JPG → cached-raw-Tb → S3-fresh fallback chain in
    get_ir_frame_jpg. Returns (None, sat_name) when no data is available.
    """
    box_deg = radius_deg * 2.0
    half = radius_deg
    dt_str = target_dt.strftime("%Y%m%d%H%M")
    bucket, _ = select_goes_sat(interp_lon, target_dt)
    sat_name = satellite_name_from_bucket(bucket)

    # Warmest path: pre-rendered Mercator-warped WebP in GCS (position-
    # keyed so a best-track update invalidates the stale entry).
    cached_jpg = _gcs_jpg_get(atcf_upper, dt_str,
                              lat=interp_lat, lon=interp_lon)
    if cached_jpg:
        return cached_jpg, sat_name

    # Next: render from cached raw Tb (skips S3 round-trip)
    cached_raw = _gcs_rt_get(atcf_upper, dt_str,
                            lat=interp_lat, lon=interp_lon,
                            radius_deg=radius_deg)
    if cached_raw is not None and cached_raw.get("tb_data"):
        try:
            encoded = np.frombuffer(
                base64.b64decode(cached_raw["tb_data"]), dtype=np.uint8
            ).reshape((cached_raw["tb_rows"], cached_raw["tb_cols"]))
            decoded_tb = ((encoded.astype(np.float32) - 1) / _TB_SCALE) + _TB_VMIN
            decoded_tb[encoded == 0] = np.nan
            jpg_bytes = _render_ir_jpg(
                decoded_tb,
                lat_bounds=(interp_lat - half, interp_lat + half),
            )
            if jpg_bytes:
                _gcs_jpg_put(atcf_upper, dt_str, jpg_bytes,
                             lat=interp_lat, lon=interp_lon)
                return jpg_bytes, sat_name
        except Exception:
            pass

    # Coldest: fetch Tb from S3 + render
    try:
        raw = fetch_ir_tb_raw(interp_lat, interp_lon, target_dt, box_deg,
                          max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
    except Exception:
        return None, sat_name
    if not raw or raw.get("tb") is None:
        return None, sat_name
    jpg_bytes = _render_ir_jpg(
        raw["tb"],
        lat_bounds=(interp_lat - half, interp_lat + half),
    )
    if jpg_bytes:
        _gcs_jpg_put(atcf_upper, dt_str, jpg_bytes,
                     lat=interp_lat, lon=interp_lon)
        return jpg_bytes, raw.get("satellite", sat_name)
    return None, sat_name


@router.get("/storm/{atcf_id}/ir-frames-bundle")
def get_storm_ir_frames_bundle(
    atcf_id: str,
    lookback_hours: float = Query(6.0, ge=1, le=24),
    radius_deg: float = Query(10.0, ge=1.0, le=12.0),
    interval_min: int = Query(30, ge=10, le=60),
):
    """Return all display WebP frames for a storm in one packed binary response.

    Wire format (same convention as /ir-raw-bundle):
        bytes [0..4):           uint32 little-endian: header JSON length L
        bytes [4..4+L):           UTF-8 JSON header
        bytes [4+L..end):         concatenated WebP frame bytes, frame order

    JSON header shape:
        {
          "total_frames": N,
          "bounds": [[s,w],[n,e]],
          "satellite": "GOES-16",
          "lookback_hours": 6.0, "interval_min": 30, "radius_deg": 10.0,
          "frames": [
            {"index": i, "datetime_utc": "...", "satellite": "...",
             "byte_offset": O, "byte_length": L},
            ...
          ]
        }

    Failed frames keep their index entry with byte_length=0 and an "error"
    field, so the client can show partial UI.

    Replaces the per-frame /ir-frame.jpg waterfall used by _initDetailMapJPG
    in realtime_ir.js. Server fans out to GCS (or S3 on cold cache) with a
    small thread pool so wall time ≈ slowest-frame fetch, and all 13 frames
    arrive together — the animation goes from "frames pop in randomly" to
    "appears fully populated, plays smoothly."
    """
    import struct
    from concurrent.futures import ThreadPoolExecutor

    _ensure_fresh_cache()
    storm = None
    with _active_storms_lock:
        for s in _active_storms_cache["storms"]:
            if s["atcf_id"].upper() == atcf_id.upper():
                storm = dict(s)
                break

    if not storm:
        raise HTTPException(status_code=404, detail=f"Storm {atcf_id} not found")

    atcf_upper = atcf_id.upper()
    center_lat = storm["lat"]
    center_lon = storm["lon"]
    half = radius_deg

    center_dt = _dt.now(timezone.utc)
    frame_times = build_frame_times(center_dt, lookback_hours, interval_min)
    # Match /ir-frame.jpg ordering: index 0 = oldest, index N-1 = most recent
    frame_times = list(reversed(frame_times))

    # Bundle-level "bounds" reflects the *latest* frame's interpolated
    # position. Each frame in the JSON header also carries its own bounds
    # (computed per-frame inside the worker) so storms that move through
    # the lookback window are placed correctly per-frame on the map.
    latest_dt = frame_times[-1] if frame_times else center_dt
    summary_ilat, summary_ilon = _interp_pos_at(
        atcf_id, latest_dt, center_lat, center_lon)
    bounds = [
        [summary_ilat - half, summary_ilon - half],
        [summary_ilat + half, summary_ilon + half],
    ]

    def _worker(item):
        i, target_dt = item
        try:
            ilat, ilon = _interp_pos_at(
                atcf_id, target_dt, center_lat, center_lon)
            jpg, sat = _get_or_render_ir_jpg(
                atcf_upper, ilat, ilon, target_dt, radius_deg,
            )
            # Also pull center_fix from the raw Tb cache so the bundle
            # header carries it — lets the satellite viewer's follow-storm
            # toggle recenter accurately from the moment the display bundle
            # lands, without waiting for the separate raw Tb bundle.
            dt_str = target_dt.strftime("%Y%m%d%H%M")
            cached_raw = _gcs_rt_get(atcf_upper, dt_str,
                                    lat=ilat, lon=ilon, radius_deg=radius_deg)
            cfix = cached_raw.get("center_fix") if cached_raw else None
            # Carry per-frame bounds so the JSON header can describe
            # exactly where this frame's cutout lives.
            frame_bounds = [
                [ilat - half, ilon - half],
                [ilat + half, ilon + half],
            ]
            return (i, jpg, sat, frame_bounds, cfix, None)
        except Exception as ex:
            return (i, None, "", None, None, str(ex))

    indexed = list(enumerate(frame_times))
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(_worker, indexed))
    results.sort(key=lambda r: r[0])

    frame_headers = []
    payloads: list[bytes] = []
    offset = 0
    # Most-recent frame's satellite goes in the top-level summary;
    # per-frame satellite stays available for storms crossing
    # GOES-East / GOES-West / Himawari boundaries within the window.
    summary_sat = ""

    for i, jpg, sat, fbounds, cfix, err in results:
        target_dt = frame_times[i]
        iso_dt = target_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        if not jpg or err is not None:
            frame_headers.append({
                "index": i,
                "datetime_utc": iso_dt,
                "satellite": sat or "",
                "bounds": fbounds,
                "center_fix": cfix,
                "byte_offset": offset,
                "byte_length": 0,
                "error": err or "no_data",
            })
            continue
        frame_headers.append({
            "index": i,
            "datetime_utc": iso_dt,
            "satellite": sat or "",
            "bounds": fbounds,
            "center_fix": cfix,
            "byte_offset": offset,
            "byte_length": len(jpg),
        })
        payloads.append(jpg)
        offset += len(jpg)
        summary_sat = sat or summary_sat

    header = {
        "total_frames": len(frame_times),
        "bounds": bounds,
        "satellite": summary_sat,
        "lookback_hours": lookback_hours,
        "interval_min": interval_min,
        "radius_deg": radius_deg,
        "media_type": "image/webp",
        "frames": frame_headers,
    }
    header_json = json.dumps(header, separators=(",", ":")).encode("utf-8")
    body = struct.pack("<I", len(header_json)) + header_json + b"".join(payloads)

    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "public, max-age=300",
            "X-Bundle-Frames": str(len(frame_times)),
            "X-Bundle-Header-Length": str(len(header_json)),
            "Access-Control-Expose-Headers": "X-Bundle-Frames, X-Bundle-Header-Length",
        },
    )


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
    frame_times = list(reversed(frame_times))  # oldest first (idx 0 = oldest)

    if frame_index >= len(frame_times):
        raise HTTPException(status_code=400, detail=f"frame_index {frame_index} out of range (max {len(frame_times)-1})")

    target_dt = frame_times[frame_index]

    raw = fetch_ir_tb_raw(center_lat, center_lon, target_dt, box_deg,
                          max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
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
        "has_recon": _has_active_recon(atcf_id),
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
            result = fetch_ir_tb_raw(center_lat, center_lon, target_dt, box_deg,
                                     max_substitution_min=_ANIM_MAX_SUBSTITUTION_MIN)
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
# Same publish-lag profile as the LARGE_ENSEMBLE CSV — paired ensemble
# lands ~3–5 h after init. Mirror the negative cache so probes for an
# unpublished cycle don't cost 30 s each on every request.
_WEATHERLAB_MISS_TTL = 600
_WEATHERLAB_MISS = "__MISSING__"

# Short negative-cache TTL for TRANSIENT fetch errors (timeout, dropped TLS
# handshake, connection reset) — as opposed to a definitive 404 for a
# not-yet-published cycle. DeepMind's CDN intermittently drops the TLS
# connection for Cloud Run's datacenter egress (SSL UNEXPECTED_EOF). A
# transient failure must NOT be cached for the full 10-min MISS window, or
# one flaky handshake silently demotes users to an older cycle until it
# expires. 45 s only throttles a hammer-loop while re-probing promptly.
_WEATHERLAB_TRANSIENT_MISS_TTL = 45

# Sentinel meaning "cache absent or expired — go fetch" (distinct from a
# live negative-cache hit, which returns None = "known-missing, don't
# re-fetch yet").
_WL_CACHE_MISS = object()

_WEATHERLAB_HTTP_SESSION = None


def _weatherlab_http():
    """Shared requests.Session with connection-level retry + backoff.

    The CSV files are reachable in ~1 s; the failures we see in production
    are transient TLS EOFs on Cloud Run egress to deepmind.google.com,
    which a couple of automatic retries absorb almost entirely. Falls back
    to a bare session (no auto-retry) if urllib3's Retry isn't importable.
    """
    global _WEATHERLAB_HTTP_SESSION
    if _WEATHERLAB_HTTP_SESSION is not None:
        return _WEATHERLAB_HTTP_SESSION
    import requests as req
    s = req.Session()
    try:
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry
        retry = Retry(
            total=3, connect=3, read=3,
            backoff_factor=0.6,            # ~0, 0.6, 1.2, 2.4 s between tries
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET"]),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
    except Exception:
        pass  # bare session still works, just without auto-retry
    _WEATHERLAB_HTTP_SESSION = s
    return s


def _weatherlab_cache_lookup(cache, key, good_ttl, miss_ttl):
    """Shared read-side cache check honouring a per-entry "ttl" override
    (used to give TRANSIENT negative entries a much shorter life than
    definitive 404 misses). Positive data is always a dict; negative
    entries are the "__MISSING__" string sentinel. Returns:
      - the cached data dict on a fresh positive hit,
      - None on a fresh negative hit (known-missing — caller returns None),
      - _WL_CACHE_MISS when absent/expired (caller should fetch).
    """
    c = cache.get(key)
    if not c:
        return _WL_CACHE_MISS
    age = time.time() - c["ts"]
    if isinstance(c["data"], dict):
        return c["data"] if age < good_ttl else _WL_CACHE_MISS
    eff = c.get("ttl", miss_ttl)            # transient misses carry a short ttl
    return None if age < eff else _WL_CACHE_MISS


def _weatherlab_cache_transient(cache, key):
    """Record a SHORT-lived negative entry for a transient fetch error, so
    a dropped TLS handshake doesn't poison the cache for the full MISS TTL.
    """
    cache[key] = {"data": "__MISSING__", "ts": time.time(),
                  "ttl": _WEATHERLAB_TRANSIENT_MISS_TTL}


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


def _wl_float(s: str):
    """Parse a WeatherLab numeric column. Empty / NaN-ish → None."""
    s = s.strip()
    if not s:
        return None
    try:
        v = float(s)
    except (ValueError, TypeError):
        return None
    if v != v:  # NaN
        return None
    return v


def _parse_weatherlab_size(cols: list) -> dict:
    """Extract RMW + R34/R50/R64 quadrant radii (km) from a WeatherLab CSV row.

    Column layout (0-indexed):
        9: radius_of_maximum_winds_km
        10–13: R34 NE/SE/SW/NW
        14–17: R50 NE/SE/SW/NW
        18–21: R64 NE/SE/SW/NW

    Returns a flat dict suitable for json.dumps; missing columns are skipped.
    rmw_km, r34_ne_km/se/sw/nw_km, r50_*, r64_*. Also includes a mean
    radius per threshold (`r34_mean_km`, etc.) for compact UI summaries —
    None if all four quadrants missing.
    """
    out: dict = {}
    if len(cols) > 9:
        rmw = _wl_float(cols[9])
        if rmw is not None:
            out["rmw_km"] = round(rmw, 1)
    for thresh, base in [(34, 10), (50, 14), (64, 18)]:
        quads = ["ne", "se", "sw", "nw"]
        vals = []
        for i, q in enumerate(quads):
            idx = base + i
            if idx >= len(cols):
                continue
            v = _wl_float(cols[idx])
            if v is not None:
                out[f"r{thresh}_{q}_km"] = round(v, 1)
                vals.append(v)
        if vals:
            out[f"r{thresh}_mean_km"] = round(sum(vals) / len(vals), 1)
    return out


def _fetch_weatherlab_csv(date_str: str, hour_str: str) -> dict | None:
    """Fetch and parse WeatherLab ensemble CSV for a given init time.

    Returns dict keyed by track_id (ATCF ID), each containing:
      { "members": { "0": {"points": [...]}, ... }, "ensemble_mean": {...} }
    """
    cache_key = (date_str, hour_str)
    hit = _weatherlab_cache_lookup(
        _weatherlab_cache, cache_key,
        _WEATHERLAB_CACHE_TTL, _WEATHERLAB_MISS_TTL)
    if hit is not _WL_CACHE_MISS:
        return hit   # fresh positive dict, or None for a known-missing cycle

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
        ens_resp = _weatherlab_http().get(ens_url, timeout=30)
    except Exception as e:
        # Transient — short negative cache only (see genesis fetcher).
        print(f"[WeatherLab] Ensemble transient fetch error "
              f"{date_str} {hour_str}z: {e}")
        _weatherlab_cache_transient(_weatherlab_cache, cache_key)
        return None
    if ens_resp.status_code != 200:
        # Definitive 404 — cycle not published. Full MISS TTL.
        _weatherlab_cache[cache_key] = {"data": _WEATHERLAB_MISS, "ts": time.time()}
        return None
    ens_text = ens_resp.text

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
        # Parse storm-size columns (cols 9-21): RMW + R34/R50/R64 per quadrant.
        # NaN/empty values land as None. nm conversion left to the frontend.
        _size = _parse_weatherlab_size(cols)
        if _size:
            point.update(_size)

        if track_id not in result:
            result[track_id] = {"members": {}, "ensemble_mean": None}

        member_key = str(sample_int)
        storm = result[track_id]
        if member_key not in storm["members"]:
            storm["members"][member_key] = {"points": []}
        storm["members"][member_key]["points"].append(point)

    # Fetch ensemble mean
    try:
        mean_resp = _weatherlab_http().get(mean_url, timeout=20)
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
                    pt = {"tau": tau, "lat": lat, "lon": lon,
                          "wind": wind, "pres": pres}
                    _size = _parse_weatherlab_size(cols)
                    if _size:
                        pt.update(_size)
                    result[track_id]["ensemble_mean"]["points"].append(pt)
    except Exception:
        pass

    # Cache. Exclude miss-sentinel entries from the eviction cap so a
    # flurry of 404s on not-yet-published cycles can't push a real
    # parsed cycle out of the cache.
    _weatherlab_cache[cache_key] = {"data": result, "ts": time.time()}
    parsed_keys = [k for k, v in _weatherlab_cache.items()
                   if v["data"] != _WEATHERLAB_MISS]
    if len(parsed_keys) > _WEATHERLAB_CACHE_MAX:
        oldest = min(parsed_keys, key=lambda k: _weatherlab_cache[k]["ts"])
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

    # Walk maturity-gated candidates newest-first. Cycles too young to
    # plausibly be on the CDN are skipped, and 404s are cached short-TTL,
    # so each frontend request is at worst one network probe.
    now = _dt.now(timezone.utc)

    data = None
    used_date = None
    used_hour = None
    for date_str, hour_str in _genesis_candidates(now=now):
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
    cycle_dt = _genesis_cycle_dt(used_date, used_hour)
    cycle_age_h = (now - cycle_dt).total_seconds() / 3600.0
    next_eta_h = _genesis_next_cycle_eta_h(now=now, init_time=init_time)

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
            "cycle_age_hours": round(cycle_age_h, 2),
            "next_cycle_eta_hours": round(next_eta_h, 2)
                                    if next_eta_h is not None else None,
            "fetched_at": now.isoformat(),
        },
        headers={"Cache-Control": "public, max-age=900"},
    )


# --------------------------------------------------------------------------
# Seasonal tab: daily indices slice (Panel B Daily view)
# --------------------------------------------------------------------------
#
# Reads gs://{GCS_IR_CACHE_BUCKET}/seasonal/indices_daily_full.parquet once
# (~2 MB, ~16 k rows × 43 cols), keeps it in-process for 24 h, and serves
# region-by-year slices as JSON to the RT Monitor Seasonal tab.
# (threading + io are imported at the top of the module.)

_SEASONAL_DAILY_LOCK = threading.Lock()
_SEASONAL_DAILY_CACHE: dict = {
    "df": None,
    "loaded_at": 0.0,
    "concat_year": None,   # which year of indices_daily_current_year was merged
}
_SEASONAL_DAILY_TTL_S = 24 * 3600


def _load_seasonal_daily_df():
    """Load (or return cached) DataFrame of daily indices. Concatenates
    the in-progress current-year rows so requests for `year=<this_year>`
    return live data without waiting on the next backfill rebuild."""
    import time as _time
    import pandas as pd

    now = _time.time()
    with _SEASONAL_DAILY_LOCK:
        df = _SEASONAL_DAILY_CACHE.get("df")
        loaded_at = _SEASONAL_DAILY_CACHE.get("loaded_at", 0.0)
        if df is not None and (now - loaded_at) < _SEASONAL_DAILY_TTL_S:
            return df

        bucket = _get_rt_gcs_bucket()
        if bucket is None:
            return None
        try:
            blob = bucket.blob("seasonal/indices_daily_full.parquet")
            if not blob.exists():
                logger.warning("seasonal/indices_daily_full.parquet not found")
                return None
            data = blob.download_as_bytes()
            df_full = pd.read_parquet(io.BytesIO(data))
        except Exception as e:
            logger.warning(f"failed to load indices_daily_full.parquet: {e}")
            return None

        # Optionally splice the current-year live rows in. Lets the API
        # serve `year=<this_year>` accurately between full-history rebuilds.
        try:
            cy_blob = bucket.blob("seasonal/indices_daily_current_year.parquet")
            if cy_blob.exists():
                cy_data = cy_blob.download_as_bytes()
                df_cy = pd.read_parquet(io.BytesIO(cy_data))
                # Keep only columns the full table has, drop the rest.
                keep_cols = [c for c in df_cy.columns if c in df_full.columns]
                df_cy = df_cy[keep_cols]
                # Replace any full-history rows for the current year with
                # the live ones.
                if len(df_cy):
                    live_year = df_cy["date"].iloc[0][:4]
                    df_full = df_full[
                        ~df_full["date"].str.startswith(live_year + "-")
                    ]
                    df_full = pd.concat([df_full, df_cy], ignore_index=True)
                    df_full = (df_full
                               .drop_duplicates(subset=["date"], keep="last")
                               .sort_values("date")
                               .reset_index(drop=True))
        except Exception as e:
            logger.warning(f"current-year splice skipped: {e}")

        _SEASONAL_DAILY_CACHE["df"] = df_full
        _SEASONAL_DAILY_CACHE["loaded_at"] = now
        logger.info(
            f"loaded indices_daily_full.parquet: {len(df_full)} rows, "
            f"{len(df_full.columns)} cols"
        )
        return df_full


# Region names accepted by /seasonal/daily. Mirrors REGIONS in
# build_oisst_history.py — kept here as a frozen set so we don't import
# the full backfill module into the API container.
_SEASONAL_DAILY_REGIONS = frozenset({
    "atl_basin", "atl_mdr", "atl_mdr_east", "atl_amo",
    "caribbean", "gulf", "nta", "tsa",
    "epac_mdr", "wpac_mdr",
    "nino12", "nino3", "nino34", "nino4",
})


@router.get("/seasonal/daily")
def get_seasonal_daily(
    region: str = Query(..., description="Region key, e.g. atl_mdr"),
    year: str = Query("all", description="4-digit year, or 'all' for full history"),
):
    """Slice of `indices_daily_full.parquet` for one region.

    Returns daily-resolution arrays of SST, anomaly, and Vecchi-Soden
    relative anomaly for the requested region (and year). Used by the
    RT Monitor Seasonal tab Panel B "Daily" view to fill the gray
    historical-year spaghetti and any selected highlight year.

    The current calendar year always reflects the latest live OISST
    values via splice with `indices_daily_current_year.parquet`.
    """
    if region not in _SEASONAL_DAILY_REGIONS:
        return JSONResponse(
            content={"error": f"unknown region '{region}'"},
            status_code=400,
        )
    df = _load_seasonal_daily_df()
    if df is None:
        return JSONResponse(
            content={"error": "daily indices unavailable"},
            status_code=503,
        )

    cols = ["date", f"{region}_sst", f"{region}_anom", f"{region}_anom_rel"]
    missing = [c for c in cols if c not in df.columns]
    if missing:
        return JSONResponse(
            content={"error": f"columns not in parquet: {missing}"},
            status_code=500,
        )
    sub = df[cols]
    if year != "all":
        if not (year.isdigit() and len(year) == 4):
            return JSONResponse(
                content={"error": f"bad year '{year}'"},
                status_code=400,
            )
        sub = sub[sub["date"].str.startswith(year + "-")]
    sub = sub.reset_index(drop=True)

    # NaN → null in JSON. pandas will already serialize NaN as null when
    # values are tolist()'d through a generic encoder, but we round-trip
    # via numpy explicitly so the JSON is small and stable.
    def _col(name):
        import numpy as _np
        arr = sub[name].to_numpy()
        out = [None if (isinstance(v, float) and _np.isnan(v)) else
               (float(v) if isinstance(v, (int, float)) else v)
               for v in arr]
        return out

    payload = {
        "region": region,
        "year": year,
        "n_rows": len(sub),
        "dates":     sub["date"].tolist(),
        "sst":       _col(f"{region}_sst"),
        "anom":      _col(f"{region}_anom"),
        "anom_rel":  _col(f"{region}_anom_rel"),
    }
    return JSONResponse(
        content=payload,
        # Historical years are immutable; current year refreshes daily.
        # 1 h public cache hits the sweet spot for both.
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ------------------------------------------------------------------
# /seasonal/daily/shear — daily region-mean shear time series.
# Built by build_era5_daily_shear_indices.py and uploaded to
# gs://${GCS_IR_CACHE_BUCKET}/seasonal/indices_daily_shear.parquet.
# Schema: date + {region}_shear column per region in _SEASONAL_DAILY_REGIONS.
# ------------------------------------------------------------------
_SEASONAL_DAILY_SHEAR_LOCK = threading.Lock()
_SEASONAL_DAILY_SHEAR_CACHE: dict = {
    "df": None,
    "loaded_at": 0.0,
}
_SEASONAL_DAILY_SHEAR_TTL_S = 24 * 3600


def _load_seasonal_daily_shear_df():
    """Load (or return cached) daily-shear DataFrame. Mirrors the SST
    daily loader (_load_seasonal_daily_df) but reads the separate
    indices_daily_shear.parquet — keeping it out of the SST table lets
    the two pipelines update independently.
    """
    import time as _time
    import pandas as pd

    now = _time.time()
    with _SEASONAL_DAILY_SHEAR_LOCK:
        df = _SEASONAL_DAILY_SHEAR_CACHE.get("df")
        loaded_at = _SEASONAL_DAILY_SHEAR_CACHE.get("loaded_at", 0.0)
        if df is not None and (now - loaded_at) < _SEASONAL_DAILY_SHEAR_TTL_S:
            return df

        bucket = _get_rt_gcs_bucket()
        if bucket is None:
            return None
        try:
            blob = bucket.blob("seasonal/indices_daily_shear.parquet")
            if not blob.exists():
                logger.warning("seasonal/indices_daily_shear.parquet not found")
                return None
            data = blob.download_as_bytes()
            df = pd.read_parquet(io.BytesIO(data))
        except Exception as e:
            logger.warning(f"failed to load indices_daily_shear.parquet: {e}")
            return None

        _SEASONAL_DAILY_SHEAR_CACHE["df"] = df
        _SEASONAL_DAILY_SHEAR_CACHE["loaded_at"] = now
        logger.info(
            f"loaded indices_daily_shear.parquet: {len(df)} rows, "
            f"{len(df.columns)} cols"
        )
        return df


@router.get("/seasonal/daily/shear")
def get_seasonal_daily_shear(
    region: str = Query(..., description="Region key, e.g. atl_mdr"),
    year: str = Query("all", description="4-digit year, or 'all' for full history"),
):
    """Slice of `indices_daily_shear.parquet` for one region.

    Returns daily-resolution ⟨|V₂₀₀ − V₈₅₀|⟩ (m/s) cos(lat)-weighted
    over the requested region. Sibling of /seasonal/daily but for the
    atmospheric (shear) panel — Panel B Daily-mode rendering reuses
    the same spaghetti / climatology / highlight-year framework as the
    SST view.

    Source: ERA5 daily archive (era5_daily_1deg/, 00Z snapshot, 1° from
    0.25° native), aggregated nightly by build_era5_daily_shear_indices.
    """
    if region not in _SEASONAL_DAILY_REGIONS:
        return JSONResponse(
            content={"error": f"unknown region '{region}'"},
            status_code=400,
        )
    df = _load_seasonal_daily_shear_df()
    if df is None:
        return JSONResponse(
            content={"error": "daily shear indices unavailable"},
            status_code=503,
        )

    col = f"{region}_shear"
    if col not in df.columns:
        return JSONResponse(
            content={"error": f"column not in parquet: {col}"},
            status_code=500,
        )
    sub = df[["date", col]]
    if year != "all":
        if not (year.isdigit() and len(year) == 4):
            return JSONResponse(
                content={"error": f"bad year '{year}'"},
                status_code=400,
            )
        sub = sub[sub["date"].str.startswith(year + "-")]
    sub = sub.reset_index(drop=True)

    def _col(name):
        import numpy as _np
        arr = sub[name].to_numpy()
        return [None if (isinstance(v, float) and _np.isnan(v)) else
                (float(v) if isinstance(v, (int, float)) else v)
                for v in arr]

    payload = {
        "region": region,
        "year": year,
        "variable": "shear",
        "units": "m s-1",
        "n_rows": len(sub),
        "dates": sub["date"].tolist(),
        "shear": _col(col),
    }
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ------------------------------------------------------------------
# /seasonal/daily/winds — daily region-mean zonal winds (u200, u850).
# Built by build_era5_daily_winds_indices.py from the same era5_daily_1deg
# archive that powers shear. One parquet with all (region × wind-field)
# columns so a single endpoint serves both u200 and u850.
# ------------------------------------------------------------------
_SEASONAL_DAILY_WINDS_LOCK = threading.Lock()
_SEASONAL_DAILY_WINDS_CACHE: dict = {
    "df": None,
    "loaded_at": 0.0,
}
_SEASONAL_DAILY_WINDS_TTL_S = 24 * 3600
_SEASONAL_DAILY_WINDS_VARS = frozenset({"u200", "u850"})


def _load_seasonal_daily_winds_df():
    import time as _time
    import pandas as pd
    now = _time.time()
    with _SEASONAL_DAILY_WINDS_LOCK:
        df = _SEASONAL_DAILY_WINDS_CACHE.get("df")
        loaded_at = _SEASONAL_DAILY_WINDS_CACHE.get("loaded_at", 0.0)
        if df is not None and (now - loaded_at) < _SEASONAL_DAILY_WINDS_TTL_S:
            return df
        bucket = _get_rt_gcs_bucket()
        if bucket is None:
            return None
        try:
            blob = bucket.blob("seasonal/indices_daily_winds.parquet")
            if not blob.exists():
                logger.warning("seasonal/indices_daily_winds.parquet not found")
                return None
            data = blob.download_as_bytes()
            df = pd.read_parquet(io.BytesIO(data))
        except Exception as e:
            logger.warning(f"failed to load indices_daily_winds.parquet: {e}")
            return None
        _SEASONAL_DAILY_WINDS_CACHE["df"] = df
        _SEASONAL_DAILY_WINDS_CACHE["loaded_at"] = now
        logger.info(
            f"loaded indices_daily_winds.parquet: {len(df)} rows, "
            f"{len(df.columns)} cols"
        )
        return df


@router.get("/seasonal/daily/winds")
def get_seasonal_daily_winds(
    region: str = Query(..., description="Region key, e.g. atl_mdr"),
    variable: str = Query("u850", description="Wind variable: u200 or u850"),
    year: str = Query("all", description="4-digit year, or 'all'"),
):
    """Slice of `indices_daily_winds.parquet` for one (region, variable).

    Returns daily-resolution cos(lat)-weighted region-mean zonal wind
    (m/s) at the requested pressure level. Powers the Panel B Daily-mode
    view for u200 and u850 — reuses the same spaghetti / climatology /
    highlight-year framework as the SST and shear daily panels.

    Source: ERA5 daily archive (era5_daily_1deg/, 00Z snapshot, 1° from
    0.25° native), aggregated by build_era5_daily_winds_indices.
    """
    if region not in _SEASONAL_DAILY_REGIONS:
        return JSONResponse(
            content={"error": f"unknown region '{region}'"},
            status_code=400,
        )
    if variable not in _SEASONAL_DAILY_WINDS_VARS:
        return JSONResponse(
            content={"error": f"unknown variable '{variable}'"},
            status_code=400,
        )
    df = _load_seasonal_daily_winds_df()
    if df is None:
        return JSONResponse(
            content={"error": "daily winds indices unavailable"},
            status_code=503,
        )
    col = f"{region}_{variable}"
    if col not in df.columns:
        return JSONResponse(
            content={"error": f"column not in parquet: {col}"},
            status_code=500,
        )
    sub = df[["date", col]]
    if year != "all":
        if not (year.isdigit() and len(year) == 4):
            return JSONResponse(
                content={"error": f"bad year '{year}'"},
                status_code=400,
            )
        sub = sub[sub["date"].str.startswith(year + "-")]
    sub = sub.reset_index(drop=True)

    def _col(name):
        import numpy as _np
        arr = sub[name].to_numpy()
        return [None if (isinstance(v, float) and _np.isnan(v)) else
                (float(v) if isinstance(v, (int, float)) else v)
                for v in arr]

    payload = {
        "region": region,
        "variable": variable,
        "year": year,
        "units": "m s-1",
        "n_rows": len(sub),
        "dates": sub["date"].tolist(),
        "values": _col(col),
    }
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/env/layers")
def get_env_layers():
    """List available global environmental overlays.

    Reads `metadata.json` for each layer from the GCS env/ prefix.
    Frontend uses this to learn the PNG URL + colorbar info for each
    available field, then drops it on the global map as L.imageOverlay.

    The layers are produced by the `build_env_overlays.py` Cloud Run
    Job (scheduled every 6 h).
    """
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return JSONResponse(
            content={"layers": [], "error": "GCS not configured"},
            status_code=503,
        )

    # Known layer names — kept in code (not auto-discovered) so the
    # endpoint stays fast and we don't enumerate the whole bucket.
    # Each entry is (gcs_prefix, layer_name). The metadata.json carries
    # the `category` field which the frontend uses for menu grouping.
    known = (
        ("env", "mslp"),
        ("env", "shear_200_850"), ("env", "shear_anom_200_850"),
        ("env", "shear_500_850"),
        ("env", "vort_850"), ("env", "vort_700"), ("env", "vort_500"),
        ("env", "div_850"), ("env", "div_200"),
        ("env", "z500_heights"),
        ("env", "winds_10m"), ("env", "winds_850"),
        ("env", "winds_700"), ("env", "winds_500"), ("env", "winds_200"),
        ("env", "rh_700_400"), ("env", "sst_oisst"),
        ("env", "genesis_prob_2d"), ("env", "genesis_prob_7d"), ("env", "genesis_prob_14d"),
        # Subseasonal forcing overlays — Wheeler-Kiladis-filtered OLR
        # (build_subseasonal_overlays.py Cloud Run Job).
        ("subseasonal", "anomaly"),
        ("subseasonal", "mjo"),
        ("subseasonal", "kelvin"),
        ("subseasonal", "er"),
        ("subseasonal", "mrg"),
    )
    layers = []
    for prefix, name in known:
        try:
            blob = bucket.blob(f"{prefix}/{name}/metadata.json")
            if not blob.exists():
                continue
            meta = json.loads(blob.download_as_text())
            layers.append(meta)
        except Exception as e:
            logger.warning(f"{prefix}/{name}/metadata.json read failed: {e}")

    return JSONResponse(
        content={"layers": layers, "count": len(layers)},
        headers={"Cache-Control": "public, max-age=120"},
    )


@router.get("/weatherlab-global")
def get_weatherlab_global():
    """Latest WeatherLab ensemble forecasts for every track in the paired CSV.

    Returns one entry per track (active storm or invest in ATCF) with the
    50-member ensemble + ensemble mean. Used by the RT Monitor global map
    to overlay 10-day forecast spaghetti across all tracked systems —
    helpful for situational awareness in busy basins.

    Note: WeatherLab's paired CSV is ATCF-paired only, so this does NOT
    surface disturbances that haven't yet received an invest number.
    """
    now = _dt.now(timezone.utc)
    data = None
    used_date = None
    used_hour = None
    for date_str, hour_str in _genesis_candidates(now=now):
        d = _fetch_weatherlab_csv(date_str, hour_str)
        if d:
            data = d
            used_date = date_str
            used_hour = hour_str
            break

    if not data:
        return JSONResponse(
            content={
                "model": "DeepMind FNV3",
                "init_time": None,
                "tracks": [],
                "n_tracks": 0,
            },
            headers={"Cache-Control": "public, max-age=120"},
        )

    init_time = used_date.replace("-", "") + used_hour
    cycle_dt = _genesis_cycle_dt(used_date, used_hour)
    cycle_age_h = (now - cycle_dt).total_seconds() / 3600.0
    next_eta_h = _genesis_next_cycle_eta_h(now=now, init_time=init_time)
    tracks = []
    for track_id, storm in data.items():
        tracks.append({
            "track_id": track_id,
            "members": storm["members"],
            "ensemble_mean": storm["ensemble_mean"],
            "n_members": len(storm["members"]),
        })

    return JSONResponse(
        content={
            "model": "DeepMind FNV3",
            "init_time": init_time,
            "tracks": tracks,
            "n_tracks": len(tracks),
            "cycle_age_hours": round(cycle_age_h, 2),
            "next_cycle_eta_hours": round(next_eta_h, 2)
                                    if next_eta_h is not None else None,
            "fetched_at": now.isoformat(),
        },
        headers={"Cache-Control": "public, max-age=900"},
    )


# ---------------------------------------------------------------------------
# DeepMind FNV3 LARGE_ENSEMBLE Cyclogenesis (1000-member pre-genesis tracks)
# ---------------------------------------------------------------------------
# Unlike the paired CSV (ATCF-storms only), the cyclogenesis CSV contains
# every TC-like feature FNV3's 1000-member ensemble detects in its
# forecast fields — including pre-genesis disturbances NHC/JTWC haven't
# numbered yet. Each row carries (track_id, sample, lat/lon, MSLP, wind,
# RMW, R34/R50/R64 quadrants) at 6h cadence out to 15 days.

_weatherlab_genesis_cache: dict = {}  # (date, hour) -> {"data": ..., "ts": float}
_WEATHERLAB_GENESIS_CACHE_TTL = 7200  # 2 hours (CSV only changes every 6h)
# Shorter TTL for cached MISSES — DeepMind publishes ~3–5 h after the
# cycle init time, so a cycle that 404'd 5 min ago might land soon. 10 min
# is a good balance between avoiding hammer-loops and picking up fresh
# cycles promptly. The sentinel below is stored as the "data" payload so
# we don't have to add a separate dict.
_WEATHERLAB_GENESIS_MISS_TTL = 600     # 10 min for negative cache
_WEATHERLAB_GENESIS_MISS = "__MISSING__"

# DeepMind typically publishes a cycle ~3–5 hours after its init time
# (FNV3 inference + post-processing). Probing cycles younger than this
# almost always 404s, wasting a 60-s timeout on every backend request
# during the publish-lag window. The candidate enumerator skips any
# cycle whose age is below this threshold.
_WEATHERLAB_GENESIS_MIN_MATURITY_H = 3.0
# Cadence between DeepMind cycles (00, 06, 12, 18 UTC).
_WEATHERLAB_GENESIS_CADENCE_H = 6.0
# Expected publish lag used for the user-visible "next cycle in Xh" chip.
# Separate from MIN_MATURITY_H, which is the EARLIEST plausible publish
# (used to gate backend probing). The typical lag we observe in
# production is the upper end of the 3-5 h range, so anchoring the ETA
# on the floor (3 h) systematically reads as "data should be here by
# now" before it actually drops. Used only as a fallback when we don't
# have a first-seen timestamp for the previous cycle yet.
_WEATHERLAB_GENESIS_TYPICAL_PUBLISH_LAG_H = 5.0

# Wall-clock time (unix seconds) at which each (date_str, hour_str)
# cycle was FIRST observed successfully on DeepMind. Populated by
# _fetch_weatherlab_genesis_csv on its first successful parse for a
# given cycle and never cleared (a few hundred bytes per cycle even
# across a long-running process). Used by _genesis_next_cycle_eta_h
# to anchor the "next cycle in Xh" chip on the actual previous publish
# — "next publish ≈ first_seen + 6 h" — instead of an assumed-lag
# model that consistently runs ~2 h optimistic in practice.
_genesis_cycle_first_seen: dict = {}


def _genesis_cycle_dt(date_str: str, hour_str: str):
    """Parse a `(date_str, hour_str)` candidate into a UTC datetime."""
    return _dt(
        int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10]),
        int(hour_str), tzinfo=timezone.utc,
    )


def _genesis_init_to_cycle(init_time: str):
    """Parse a `YYYYMMDDHH` init string into `(date_str, hour_str)`.
    Returns `(None, None)` if malformed. Used by the cycle-trend toggle
    so the global endpoint can serve a specific past DeepMind cycle."""
    s = (init_time or "").strip()
    if len(s) != 10 or not s.isdigit():
        return None, None
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}", s[8:10]


def _genesis_candidates(now=None, days_back: int = 2, min_maturity_h: float = None) -> list:
    """Ordered list of `(date_str, hour_str)` cycles to probe, freshest
    first. Skips cycles too young to plausibly be published (saves a 60-s
    timeout per request during the publish-lag window). Default look-back
    is 2 days × 4 cycles = 8 candidates, more than enough to find data
    even after a multi-cycle outage.
    """
    if now is None:
        now = _dt.now(timezone.utc)
    if min_maturity_h is None:
        min_maturity_h = _WEATHERLAB_GENESIS_MIN_MATURITY_H
    candidates = []
    for day_offset in range(days_back):
        dt = now - timedelta(days=day_offset)
        date_str = dt.strftime("%Y-%m-%d")
        for hour in ("18", "12", "06", "00"):
            cyc_dt = _genesis_cycle_dt(date_str, hour)
            age_h = (now - cyc_dt).total_seconds() / 3600.0
            if age_h < min_maturity_h:
                continue   # not yet published, skip
            candidates.append((date_str, hour))
    return candidates


def _genesis_next_cycle_eta_h(now=None, init_time: str = None) -> float | None:
    """Hours until the NEXT cycle past `init_time` is expected to land on
    DeepMind. Used both for the user-visible "next cycle in Xh" chip and
    for setting a tight HTTP Cache-Control near a publish boundary.

    Prefers an OBSERVED anchor: if we recorded a first-seen timestamp
    for the current cycle (we almost always have one — the only way to
    know `init_time` is to have just fetched it), the next publish is
    estimated as `first_seen + 6 h`. This tracks reality much better
    than the older assumed-lag model, which was anchored on the floor
    of the 3-5 h observed range and consistently ran ~2 h optimistic.

    Falls back to `next_init + typical_lag` (5 h) when no anchor is
    available — e.g., immediately after a server restart, before any
    successful fetch has populated `_genesis_cycle_first_seen`.
    """
    if now is None:
        now = _dt.now(timezone.utc)
    if not init_time or len(init_time) < 10:
        return None
    try:
        cur_cyc = _dt(
            int(init_time[:4]), int(init_time[4:6]), int(init_time[6:8]),
            int(init_time[8:10]), tzinfo=timezone.utc,
        )
    except (ValueError, TypeError):
        return None

    # Observed anchor: look up first-seen for the current cycle. The
    # init_time string here is the compact YYYYMMDDHH form; the
    # first-seen map is keyed by (YYYY-MM-DD, HH), so reformat.
    cache_key = (
        f"{init_time[:4]}-{init_time[4:6]}-{init_time[6:8]}",
        init_time[8:10],
    )
    first_seen_ts = _genesis_cycle_first_seen.get(cache_key)
    if first_seen_ts is not None:
        first_seen_dt = _dt.fromtimestamp(first_seen_ts, tz=timezone.utc)
        # Sanity check: first_seen must come AFTER the cycle's init
        # time. If it doesn't (clock skew, corrupted timestamp, or the
        # cycle was somehow recorded before it could physically exist),
        # fall through to the assumed-lag estimate.
        if first_seen_dt >= cur_cyc:
            next_published = first_seen_dt + timedelta(
                hours=_WEATHERLAB_GENESIS_CADENCE_H)
            return max(0.0, (next_published - now).total_seconds() / 3600.0)

    # Fallback: assumed-lag model, but anchored on the TYPICAL (not
    # minimum) publish lag so the user-visible ETA doesn't expire while
    # the data is still being staged.
    next_cyc = cur_cyc + timedelta(hours=_WEATHERLAB_GENESIS_CADENCE_H)
    next_published = next_cyc + timedelta(
        hours=_WEATHERLAB_GENESIS_TYPICAL_PUBLISH_LAG_H)
    return max(0.0, (next_published - now).total_seconds() / 3600.0)


def _resolve_latest_genesis_cycle(require_data: bool = True
                                  ) -> tuple[str | None, str | None, dict | None]:
    """Walk the candidate list newest-first and return the first cycle
    that fetches successfully. Centralizes the loop that the global
    endpoint, the per-track endpoint, and the warmer all need so the
    "what's the latest?" logic lives in one place.

    `require_data`: if True (default), keep walking past cycles that
    fetch successfully but contain zero tracks. Set False to accept the
    first non-None result (useful when probing whether the cycle exists
    at all, regardless of whether any genesis is forecast).
    """
    candidates = _genesis_candidates()
    fallback = None
    for date_str, hour_str in candidates:
        d = _fetch_weatherlab_genesis_csv(date_str, hour_str)
        if d is None:
            continue
        if not require_data or len(d) > 0:
            return date_str, hour_str, d
        # Stash the first empty-but-published cycle as a fallback —
        # better to return "0 tracks" from a real cycle than nothing.
        if fallback is None:
            fallback = (date_str, hour_str, d)
    if fallback is not None:
        return fallback
    return None, None, None


def _fetch_weatherlab_genesis_csv(date_str: str, hour_str: str
                                  ) -> dict | None:
    """Fetch and parse the FNV3 LARGE_ENSEMBLE cyclogenesis CSV for the
    given init time. Returns dict keyed by track_id:
        { "members": {"<sample>": {"points": [...]}, ...},
          "ensemble_mean": {"points": [...]} }
    with the same per-point shape as `_fetch_weatherlab_csv` so the
    frontend can reuse its rendering logic.

    Cyclogenesis CSV column layout as of late May 2026 (DeepMind
    dropped the `lead_time_hours` column some time after our original
    integration, shifting everything 1 index left):
      0: init_time         1: track_id       2: sample
      3: valid_time        4: lead_time      5: lat
      6: lon               7: MSLP (hPa)     8: max_wind (kt)
      9: RMW (km)         10-13: R34 NE/SE/SW/NW
     14-17: R50 NE/SE/SW/NW    18-21: R64 NE/SE/SW/NW

    (When lead_time_hours reappears we detect it and fall back to the
    legacy layout.)
    """
    cache_key = (date_str, hour_str)
    hit = _weatherlab_cache_lookup(
        _weatherlab_genesis_cache, cache_key,
        _WEATHERLAB_GENESIS_CACHE_TTL, _WEATHERLAB_GENESIS_MISS_TTL)
    if hit is not _WL_CACHE_MISS:
        return hit   # fresh positive dict, or None for a known-missing cycle

    date_fmt = date_str.replace("-", "_")
    url = (f"{_WEATHERLAB_LARGE_BASE}/ensemble/cyclogenesis/csv/"
           f"FNV3_LARGE_ENSEMBLE_{date_fmt}T{hour_str}_00_cyclogenesis.csv")
    try:
        # 30 s read is enough for the multi-MB CSV on a warm CDN edge; the
        # shared session adds a few automatic retries to absorb DeepMind's
        # intermittent TLS EOFs on Cloud Run egress.
        r = _weatherlab_http().get(url, timeout=30)
    except Exception as e:
        # Transient (timeout / dropped TLS / reset) AFTER auto-retries.
        # Short negative cache only — a flaky handshake must NOT poison the
        # full MISS window and demote users to an older cycle for 10 min.
        print(f"[WeatherLab Genesis] transient fetch error "
              f"{date_str} {hour_str}z: {e}")
        _weatherlab_cache_transient(_weatherlab_genesis_cache, cache_key)
        return None
    if r.status_code != 200:
        # Definitive: cycle not published yet. Full MISS TTL is correct so
        # the next request doesn't pay another fetch for the same 404.
        _weatherlab_genesis_cache[cache_key] = {
            "data": _WEATHERLAB_GENESIS_MISS, "ts": time.time()}
        return None
    text = r.text

    result: dict = {}
    header_seen = False
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        if not header_seen:
            header_seen = True
            continue

        cols = line.split(",")
        if len(cols) < 10:
            continue

        track_id = cols[1].strip()
        sample = cols[2].strip()
        try:
            sample_int = int(float(sample))
        except (ValueError, TypeError):
            continue

        # Detect whether the CSV includes the legacy `lead_time_hours`
        # column at index 5. We can tell from the value's magnitude: a
        # lead-time-hours value is an integer (or near-integer) ≥ 0 with
        # NO geographic constraint, but a LATITUDE value is in [-90, +90]
        # AND is almost always a float-with-decimal. The cleanest signal
        # is the value at index 6: if it parses to something in lat-range
        # AND col-5 doesn't, we're on the legacy layout. If col-7 looks
        # like MSLP (~1000), we're on the new layout. Default to new
        # layout (current as of May 2026) and probe for legacy on each
        # row so we transition cleanly if DeepMind re-adds the column.
        legacy_layout = False
        try:
            v6 = float(cols[6])
            v7 = float(cols[7])
            # New layout: cols[5]=lat ∈ [-90,90], cols[7]=mslp ~ [800,1100]
            # Legacy:     cols[5]=lead_h, cols[6]=lat, cols[8]=mslp
            if -90 <= float(cols[5]) <= 90 and 800 <= v7 <= 1100:
                legacy_layout = False   # new layout matches
            elif -90 <= v6 <= 90:
                legacy_layout = True    # legacy layout matches
        except (ValueError, IndexError):
            pass

        if legacy_layout:
            lat_idx, lon_idx, mslp_idx, wind_idx, rmw_idx = 6, 7, 8, 9, 10
            r34_base, r50_base, r64_base = 11, 15, 19
            try:
                tau = float(cols[5])
            except (ValueError, IndexError):
                tau = _parse_lead_time(cols[4])
        else:
            lat_idx, lon_idx, mslp_idx, wind_idx, rmw_idx = 5, 6, 7, 8, 9
            r34_base, r50_base, r64_base = 10, 14, 18
            # No lead_time_hours — derive tau from the "N days HH:MM:SS"
            # field in col 4.
            tau = _parse_lead_time(cols[4])

        try:
            lat = round(float(cols[lat_idx]), 2)
            lon = round(float(cols[lon_idx]), 2)
            pres = (round(float(cols[mslp_idx]), 1)
                    if cols[mslp_idx].strip() else None)
            wind = (round(float(cols[wind_idx]), 1)
                    if cols[wind_idx].strip() else None)
        except (ValueError, IndexError):
            continue

        point = {"tau": tau, "lat": lat, "lon": lon,
                 "wind": wind, "pres": pres}
        size = {}
        if len(cols) > rmw_idx:
            try:
                rmw = (float(cols[rmw_idx])
                       if cols[rmw_idx].strip() else None)
                if rmw is not None and rmw == rmw:  # not NaN
                    size["rmw_km"] = round(rmw, 1)
            except (ValueError, TypeError):
                pass
        for thresh, base in [(34, r34_base), (50, r50_base), (64, r64_base)]:
            quads = ["ne", "se", "sw", "nw"]
            vals = []
            for i, q in enumerate(quads):
                idx = base + i
                if idx >= len(cols):
                    continue
                try:
                    v = float(cols[idx])
                    if v == v:  # not NaN
                        size[f"r{thresh}_{q}_km"] = round(v, 1)
                        vals.append(v)
                except (ValueError, TypeError):
                    continue
            if vals:
                size[f"r{thresh}_mean_km"] = round(sum(vals) / len(vals), 1)
        if size:
            point.update(size)

        if track_id not in result:
            result[track_id] = {"members": {}, "ensemble_mean": None}
        member_key = str(sample_int)
        if member_key not in result[track_id]["members"]:
            result[track_id]["members"][member_key] = {"points": []}
        result[track_id]["members"][member_key]["points"].append(point)

    # Compute the ensemble mean per track: average lat/lon/wind/pres at
    # each tau across all samples we have. DeepMind doesn't publish an
    # ensemble_mean for the cyclogenesis CSV, so we derive it here.
    for track_id, storm in result.items():
        by_tau: dict = {}  # tau -> {lats:[], lons:[], winds:[], pres:[]}
        for mkey, mem in storm["members"].items():
            for p in mem["points"]:
                t = p["tau"]
                bucket = by_tau.setdefault(t, {"lat": [], "lon": [],
                                                "wind": [], "pres": []})
                bucket["lat"].append(p["lat"])
                bucket["lon"].append(p["lon"])
                if p.get("wind") is not None:
                    bucket["wind"].append(p["wind"])
                if p.get("pres") is not None:
                    bucket["pres"].append(p["pres"])
        mean_pts = []
        for t in sorted(by_tau):
            b = by_tau[t]
            mean_pts.append({
                "tau": t,
                "lat": round(sum(b["lat"]) / len(b["lat"]), 2),
                "lon": round(sum(b["lon"]) / len(b["lon"]), 2),
                "wind": round(sum(b["wind"]) / len(b["wind"]), 1)
                        if b["wind"] else None,
                "pres": round(sum(b["pres"]) / len(b["pres"]), 1)
                        if b["pres"] else None,
            })
        storm["ensemble_mean"] = {"points": mean_pts}

    _weatherlab_genesis_cache[cache_key] = {"data": result, "ts": time.time()}
    # Record the FIRST time we observed this cycle as published — this
    # anchors the next-cycle ETA on observed reality ("publish + 6 h")
    # rather than an assumed lag. We use setdefault so re-fetches after
    # cache eviction don't reset the anchor to a later wall-clock time
    # (which would push the predicted next-publish further into the
    # future every time).
    _genesis_cycle_first_seen.setdefault(cache_key, time.time())
    # Cap the cache at 4 PARSED cycles. Miss-sentinel entries are tiny
    # strings, so we exclude them from the cap — otherwise a flurry of
    # not-yet-published probes could evict a fresh ~10 MB parse and
    # force a re-fetch on the next request.
    parsed_keys = [k for k, v in _weatherlab_genesis_cache.items()
                   if v["data"] != _WEATHERLAB_GENESIS_MISS]
    if len(parsed_keys) > 4:
        oldest = min(parsed_keys, key=lambda k: _weatherlab_genesis_cache[k]["ts"])
        del _weatherlab_genesis_cache[oldest]
    print(f"[WeatherLab Genesis] Parsed {len(result)} tracks from "
          f"{date_str} {hour_str}z")
    return result


# ---------------------------------------------------------------------------
# Background warm-up for the WeatherLab genesis cache
#
# Without this, /weatherlab-genesis pays a cold synchronous cost on the first
# request after a new Cloud Run instance spins up: resolve the latest cycle,
# download a multi-MB CSV (up to 30 s), then parse ~10 MB. On an incognito tab
# (no localStorage / browser HTTP cache to fall back on) the global genesis
# layer can appear to never load while that runs — and can exceed the request
# timeout entirely. Mirror the active-storms pattern: a daemon thread keeps
# `_weatherlab_genesis_cache` warm so the endpoint always serves from memory,
# and /warmup primes a freshly-spun instance.
# ---------------------------------------------------------------------------

_GENESIS_WARM_INTERVAL = 900  # 15 min — catches a new 6-hourly cycle promptly
_genesis_warm_stop = threading.Event()


def refresh_genesis_cache() -> dict:
    """Resolve + parse the latest genesis cycle into the in-memory cache,
    and pre-compute the default-param TC-ATLAS cluster index.

    Cheap when both are already cached (dict lookups); only pays the CSV
    download+parse when a newer cycle has published, and the clustering
    only when that fresh cycle hasn't been clustered yet. Used by the
    background warmer and /warmup.

    Warming the clusters matters because /weatherlab-genesis-clusters is
    what produces the *exact* uncapped formation probabilities. With it
    warm, the frontend's parallel cluster fetch is an instant ~50 KB hit
    and the real probabilities paint without waiting on server compute.
    The params here mirror the endpoint defaults (and the frontend reset
    values) so the steady-state request is the same cache key.
    """
    used_date, used_hour, data = _resolve_latest_genesis_cycle(require_data=True)
    init_time = (used_date.replace("-", "") + used_hour) if used_date else None
    n_clusters = None
    if data:
        try:
            _, _, clusters, _ = _tca_get_or_compute_clusters(
                3.0, 8, 750.0, 48.0, 25)
            n_clusters = len(clusters) if clusters else 0
        except Exception:
            traceback.print_exc()
    return {
        "init_time": init_time,
        "n_tracks": len(data) if data else 0,
        "n_clusters": n_clusters,
    }


def _background_genesis_warm():
    """Daemon thread: keep the genesis cache warm so /weatherlab-genesis never
    pays the cold CSV fetch on the request path."""
    # Let startup settle (active-storms uses a 10 s delay; stagger after it).
    _genesis_warm_stop.wait(12)
    while not _genesis_warm_stop.is_set():
        try:
            info = refresh_genesis_cache()
            print(f"[IR Monitor] Genesis warm refresh: {info}")
        except Exception:
            traceback.print_exc()
        _genesis_warm_stop.wait(_GENESIS_WARM_INTERVAL)


def start_genesis_warmup():
    """Start the background genesis warm thread. Called once at app startup."""
    t = threading.Thread(target=_background_genesis_warm, daemon=True,
                         name="genesis-warm")
    t.start()
    print("[IR Monitor] Background genesis warm thread started "
          f"(interval={_GENESIS_WARM_INTERVAL}s)")


@router.get("/weatherlab-genesis")
def get_weatherlab_genesis(max_members: int = 100, init_time: str = None):
    """FNV3 LARGE_ENSEMBLE cyclogenesis: all 1000-member TC predictions
    (including pre-genesis disturbances) for the latest available init.

    `max_members` (default 100) thins the per-track ensemble before
    return — full payload is ~10 MB for ~30 tracks × 1000 samples and
    rendering 30k polylines tanks Leaflet performance. The ensemble
    mean is always returned in full.

    `init_time` (YYYYMMDDHH) pins the response to a specific past cycle
    so the frontend can step through recent runs (run-to-run trend). When
    omitted, the latest published cycle is resolved as before.
    """
    now = _dt.now(timezone.utc)
    if init_time:
        req_date, req_hour = _genesis_init_to_cycle(init_time)
        if req_date is None:
            raise HTTPException(
                status_code=400,
                detail="init_time must be 10 digits (YYYYMMDDHH)")
        data = _fetch_weatherlab_genesis_csv(req_date, req_hour)
        used_date, used_hour = req_date, req_hour
    else:
        used_date, used_hour, data = _resolve_latest_genesis_cycle(
            require_data=True)

    if data is None:
        return JSONResponse(
            content={
                "model": "DeepMind FNV3 LARGE_ENSEMBLE",
                "init_time": init_time if init_time else None,
                "tracks": [],
                "n_tracks": 0,
                "cycle_age_hours": None,
                "next_cycle_eta_hours": None,
            },
            # Short cache when we have nothing — the next cycle might be
            # 5 min away from publication.
            headers={"Cache-Control": "public, max-age=120"},
        )

    init_time = used_date.replace("-", "") + used_hour
    cycle_dt = _genesis_cycle_dt(used_date, used_hour)
    cycle_age_h = (now - cycle_dt).total_seconds() / 3600.0
    next_eta_h = _genesis_next_cycle_eta_h(now=now, init_time=init_time)
    tracks = []
    cap = max(1, int(max_members)) if max_members else None
    for track_id, storm in data.items():
        members = storm["members"]
        total = len(members)
        if cap and total > cap:
            keys = sorted(members.keys(), key=lambda k: int(k))
            stride = max(1, total // cap)
            kept_keys = keys[::stride][:cap]
            members = {k: members[k] for k in kept_keys}
        tracks.append({
            "track_id": track_id,
            "members": members,
            "ensemble_mean": storm["ensemble_mean"],
            "n_members": len(members),
            "n_members_total": total,
        })

    # Adaptive HTTP cache: if the next cycle is expected within ~30 min,
    # shrink max-age so the frontend doesn't sit on the previous cycle
    # past its useful life. Otherwise the default 15 min is plenty.
    if next_eta_h is not None and next_eta_h < 0.5:
        cache_max_age = 60        # next cycle imminent — re-check often
    elif next_eta_h is not None and next_eta_h < 1.5:
        cache_max_age = 300       # within an hour-ish
    else:
        cache_max_age = 900       # comfortable lull mid-cycle

    return JSONResponse(
        content={
            "model": "DeepMind FNV3 LARGE_ENSEMBLE",
            "init_time": init_time,
            "tracks": tracks,
            "n_tracks": len(tracks),
            "thinned_to": cap,
            "cycle_age_hours": round(cycle_age_h, 2),
            "next_cycle_eta_hours": round(next_eta_h, 2) if next_eta_h is not None else None,
            "fetched_at": now.isoformat(),
        },
        headers={"Cache-Control": f"public, max-age={cache_max_age}"},
    )


@router.get("/weatherlab-genesis-cycles")
def get_weatherlab_genesis_cycles(count: int = 4):
    """List the most recent published genesis cycles (freshest first) so
    the frontend can offer a cycle picker for run-to-run trend comparison.

    Each entry: `{init_time (YYYYMMDDHH), age_hours, n_tracks}`. Probes the
    maturity-gated candidate list and reuses the per-cycle CSV cache, so
    steady state is dict lookups; a cold instance pays the download for up
    to `count` cycles once, after which they're warm (the parse cache also
    caps at ~4, matching the default window).

    Hyphenated path (not `/weatherlab-genesis/cycles`) so it doesn't get
    swallowed by the `/weatherlab-genesis/{track_id}` route.
    """
    now = _dt.now(timezone.utc)
    count = max(1, min(int(count or 4), 8))
    cycles = []
    for date_str, hour_str in _genesis_candidates(now=now):
        d = _fetch_weatherlab_genesis_csv(date_str, hour_str)
        if d is None:
            continue   # not published (or fetch failed) — skip, keep looking
        cycle_dt = _genesis_cycle_dt(date_str, hour_str)
        cycles.append({
            "init_time": date_str.replace("-", "") + hour_str,
            "age_hours": round((now - cycle_dt).total_seconds() / 3600.0, 2),
            "n_tracks": len(d),
        })
        if len(cycles) >= count:
            break
    return JSONResponse(
        content={"cycles": cycles, "n": len(cycles)},
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/weatherlab-genesis-trend")
def get_weatherlab_genesis_trend(
    lat: float,
    lon: float,
    count: int = 4,
    match_radius_km: float = 800.0,
    grid_deg: float = 3.0,
    peak_min_members: int = 8,
    assign_radius_km: float = 1000.0,
    time_window_h: float = 60.0,
    cluster_min_members: int = 25,
):
    """Run-to-run trend for ONE disturbance: for each of the last `count`
    published cycles, find the TC-ATLAS cluster whose density-peak genesis
    location is nearest the anchor (lat, lon) within `match_radius_km`, and
    return its formation probability + predicted peak Vmax. Lets the detail
    modal draw a sparkline of how the forecast for this system has trended.

    The anchor is the clicked disturbance's `peak_lat`/`peak_lon` (the
    genesis-density cell), which is the most run-to-run-stable handle on a
    physical system — D-numbers are re-ranked every cycle, so they can't be
    used to follow a disturbance across runs.

    Each entry (freshest first):
      `{init_time, age_hours, matched, dist_km, formation_prob, peak_wind,
        peak_tau, display_short, mean_track}`. `mean_track` is the matched
    cluster's slim mean polyline ([{tau,lat,lon,wind}]) for the Trends-tab
    track + intensity overlays. Unmatched cycles still appear with null
    metrics so a gap reads as 'this run didn't forecast this system'.

    Hyphenated path so it isn't swallowed by `/weatherlab-genesis/{track_id}`.
    """
    now = _dt.now(timezone.utc)
    count = max(1, min(int(count or 4), 8))
    trend = []
    n_with_data = 0
    for date_str, hour_str in _genesis_candidates(now=now):
        clusters = _tca_clusters_for_cycle(
            date_str, hour_str, grid_deg, peak_min_members,
            assign_radius_km, time_window_h, cluster_min_members)
        if clusters is None:
            continue   # cycle not published — skip, keep looking
        n_with_data += 1
        cycle_dt = _genesis_cycle_dt(date_str, hour_str)
        best = None
        best_d = float("inf")
        for c in clusters:
            if c.get("peak_lat") is None or c.get("peak_lon") is None:
                continue
            d = _tca_haversine_km(lat, lon, c["peak_lat"], c["peak_lon"])
            if d < best_d:
                best_d = d
                best = c
        matched = best is not None and best_d <= match_radius_km
        # For matched cycles, attach the cluster's mean polyline so the
        # Trends tab can overlay run-to-run track + intensity. ensemble_mean
        # already carries {tau, lat, lon, wind} per point — slim to those
        # four fields so 4-8 cycles stay a small payload.
        mean_track = None
        if matched:
            pts = ((best.get("ensemble_mean") or {}).get("points")) or []
            mean_track = [
                {"tau": p.get("tau"), "lat": p.get("lat"),
                 "lon": p.get("lon"), "wind": p.get("wind")}
                for p in pts
            ]
        trend.append({
            "init_time": date_str.replace("-", "") + hour_str,
            "age_hours": round((now - cycle_dt).total_seconds() / 3600.0, 2),
            "matched": matched,
            "dist_km": round(best_d, 1) if best is not None else None,
            "formation_prob": best["fraction"] if matched else None,
            "peak_wind": best["peak_wind"] if matched else None,
            "peak_tau": best["peak_tau"] if matched else None,
            "display_short": best["display_short"] if matched else None,
            "mean_track": mean_track,
        })
        if n_with_data >= count:
            break
    return JSONResponse(
        content={
            "model": "DeepMind FNV3 LARGE_ENSEMBLE",
            "anchor": {"lat": lat, "lon": lon},
            "match_radius_km": match_radius_km,
            "trend": trend,
            "n": len(trend),
        },
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/weatherlab-genesis/{track_id}")
def get_weatherlab_genesis_track(track_id: str):
    """Per-track detail for a single FNV3 LARGE_ENSEMBLE cyclogenesis
    feature. Returns ALL ensemble members for the track (vs the global
    endpoint which thins to 100 to keep the spaghetti layer from
    tanking Leaflet). Drives the click-through detail modal that
    renders the colleague's point-cloud + intensity-spread figures
    for pre-genesis disturbances.

    Reuses _fetch_weatherlab_genesis_csv's per-init cache so even a
    cold per-track lookup is one filter on the already-parsed dict.
    """
    track_id = track_id.strip()
    if not track_id:
        raise HTTPException(status_code=400, detail="track_id is required")

    now = _dt.now(timezone.utc)
    # Walk the maturity-gated candidate list and stop at the first cycle
    # that contains the requested track_id. Cycles too young to be
    # published are skipped automatically.
    data = None
    used_date = None
    used_hour = None
    for date_str, hour_str in _genesis_candidates(now=now):
        d = _fetch_weatherlab_genesis_csv(date_str, hour_str)
        if d and track_id in d:
            data = d
            used_date = date_str
            used_hour = hour_str
            break

    if data is None or track_id not in data:
        raise HTTPException(
            status_code=404,
            detail=f"Genesis track {track_id} not found in any recent init",
        )

    storm = data[track_id]
    init_time = used_date.replace("-", "") + used_hour
    cycle_dt = _genesis_cycle_dt(used_date, used_hour)
    cycle_age_h = (now - cycle_dt).total_seconds() / 3600.0
    next_eta_h = _genesis_next_cycle_eta_h(now=now, init_time=init_time)
    members = storm["members"]
    return JSONResponse(
        content={
            "model": "DeepMind FNV3 LARGE_ENSEMBLE",
            "init_time": init_time,
            "track_id": track_id,
            "n_members": len(members),
            "members": members,
            "ensemble_mean": storm["ensemble_mean"],
            "cycle_age_hours": round(cycle_age_h, 2),
            "next_cycle_eta_hours": round(next_eta_h, 2) if next_eta_h is not None else None,
        },
        headers={"Cache-Control": "public, max-age=900"},
    )


# ---------------------------------------------------------------------------
# TC-ATLAS Density-Peak Clustering (server-side, full uncapped data)
# ---------------------------------------------------------------------------
#
# Re-clusters the LARGE_ENSEMBLE cyclogenesis CSV using TC-ATLAS's density-
# peak algorithm — same logic as realtime_ir.js's _genesisTCAtlasDisturbances,
# but running on the ALREADY-CACHED full uncapped parse rather than forcing
# every client to download 8+ MB of per-track endpoints and recompute. One
# CPU pass per cycle benefits every user that lands on the page after.
#
# Cache strategy: keep ≤_TCA_CLUSTER_CACHE_MAX results, keyed by
# (init_time, tuner_params). The default-param result is what 99% of users
# hit, so a single entry per init_time covers steady state. The tuner
# sliders push other param combos through the same path with on-demand
# compute (small extra CPU per slider drag, no extra memory per user).

_TCA_CLUSTER_CACHE: dict = {}        # (init_time, params_tuple) -> (result, ts)
_TCA_CLUSTER_CACHE_MAX = 6           # cap memory ~ 6 cycles × ~6 MB = ~36 MB
_TCA_CLUSTER_TTL = 7200              # same TTL as the underlying CSV


def _tca_haversine_km(la1, lo1, la2, lo2):
    R = 6371.0
    rad = math.pi / 180.0
    dl = (la2 - la1) * rad
    do = (lo2 - lo1) * rad
    a = (math.sin(dl / 2) ** 2
         + math.cos(la1 * rad) * math.cos(la2 * rad) * math.sin(do / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(a))


def _tca_mean_track(member_point_arrays):
    """Pool member trajectories and compute the ensemble-mean lat/lon/
    wind/pres per tau bucket. Uses circular mean for longitude (so a
    cluster straddling the antimeridian doesn't average to the wrong
    side of the globe) and drops tau buckets supported by too few
    members — otherwise a 1-member mean at +312 h can jump thousands
    of km and create great-circle arcs across the map. Mirrors
    _genesisMeanTrack in the JS, with these two improvements."""
    by_tau: dict = {}
    for pts in member_point_arrays:
        if not pts:
            continue
        for p in pts:
            if p.get("lat") is None or p.get("lon") is None:
                continue
            t = p.get("tau")
            if t is None:
                continue
            bucket = by_tau.setdefault(t, {
                "lat_sum": 0.0,
                "lon_sin_sum": 0.0, "lon_cos_sum": 0.0,
                "n": 0,
                "wind_sum": 0.0, "wind_n": 0,
                "pres_sum": 0.0, "pres_n": 0,
            })
            bucket["lat_sum"] += p["lat"]
            # Circular mean accumulator for longitude — sin/cos of the
            # angle, averaged, then atan2 back to a degree. Robust to
            # the antimeridian (members at +179° and -179° average to
            # 180° instead of the wrong-side 0°).
            lon_rad = p["lon"] * math.pi / 180.0
            bucket["lon_sin_sum"] += math.sin(lon_rad)
            bucket["lon_cos_sum"] += math.cos(lon_rad)
            bucket["n"] += 1
            w = p.get("wind")
            if w is not None:
                bucket["wind_sum"] += w
                bucket["wind_n"] += 1
            pr = p.get("pres")
            if pr is not None:
                bucket["pres_sum"] += pr
                bucket["pres_n"] += 1
    if not by_tau:
        return []
    # Member-count gate: at very late taus only a handful of members
    # are still being tracked, and the resulting "mean" position can
    # leap thousands of km between consecutive taus. Threshold = 10%
    # of the peak member count (so a 996-member cluster requires
    # ~100 members per tau), with a floor of 5 for small clusters.
    peak_n = max(b["n"] for b in by_tau.values())
    min_n = max(5, int(round(peak_n * 0.10)))
    out = []
    for t in sorted(by_tau.keys()):
        b = by_tau[t]
        if b["n"] < min_n:
            continue
        lon_mean_rad = math.atan2(b["lon_sin_sum"] / b["n"],
                                   b["lon_cos_sum"] / b["n"])
        lon_mean = lon_mean_rad * 180.0 / math.pi
        out.append({
            "tau": t,
            "lat": round(b["lat_sum"] / b["n"], 2),
            "lon": round(lon_mean, 2),
            "wind": round(b["wind_sum"] / b["wind_n"], 1)
                    if b["wind_n"] else None,
            "pres": round(b["pres_sum"] / b["pres_n"], 1)
                    if b["pres_n"] else None,
            "n_members": b["n"],
        })
    return out


def _tca_compute_clusters(raw_data: dict,
                          grid_deg: float = 3.0,
                          peak_min_members: int = 8,
                          assign_radius_km: float = 1000.0,
                          time_window_h: float = 60.0,
                          cluster_min_members: int = 25,
                          ensemble_size: int = 1000) -> list:
    """Run the TC-ATLAS density-peak algorithm on the full uncapped
    CSV parse (dict keyed by DM track_id). Returns a list of cluster
    dicts ranked by size (largest first → 'Disturbance 1')."""
    if not raw_data:
        return []

    # Step 1: pool (track_id, sample) entries with first-genesis points.
    entries = []
    track_ids = list(raw_data.keys())
    for tid in track_ids:
        members = raw_data[tid].get("members", {})
        for sample_key, mem in members.items():
            pts = mem.get("points", [])
            if not pts or len(pts) < 2:
                continue
            first = None
            for p in pts:
                if (p.get("wind") is not None and p["wind"] >= 34
                        and p.get("lat") is not None and p.get("lon") is not None):
                    first = p
                    break
            if not first:
                continue
            entries.append({
                "from_track_id": tid,
                "sample_key": sample_key,
                "points": pts,
                "first_lat": first["lat"],
                "first_lon": first["lon"],
                "first_tau": first.get("tau"),
            })
    if not entries:
        return []

    # Step 2: bin first-genesis points into a 2D density grid.
    density: dict = {}
    for e in entries:
        ix = int(math.floor((e["first_lon"] + 180) / grid_deg))
        iy = int(math.floor((e["first_lat"] + 90) / grid_deg))
        density[(ix, iy)] = density.get((ix, iy), 0) + 1

    # Step 3: find density peaks (cells dominating their 3x3 nbrhd,
    # plateau ties broken by lexical-first key).
    peaks = []
    for key, count in density.items():
        if count < peak_min_members:
            continue
        ix, iy = key
        is_peak = True
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                nk = (ix + dx, iy + dy)
                nc = density.get(nk, 0)
                if nc > count:
                    is_peak = False
                    break
                if nc == count and nk < key:
                    is_peak = False
                    break
            if not is_peak:
                break
        if is_peak:
            peaks.append({
                "ix": ix, "iy": iy,
                "lat": (iy + 0.5) * grid_deg - 90,
                "lon": (ix + 0.5) * grid_deg - 180,
                "count": count,
                "mean_tau": None,
            })

    if not peaks:
        return []

    # Step 4: per-peak mean genesis tau from members whose first-genesis
    # falls IN the peak cell.
    for pk in peaks:
        tsum, tn = 0.0, 0
        for e in entries:
            eix = int(math.floor((e["first_lon"] + 180) / grid_deg))
            eiy = int(math.floor((e["first_lat"] + 90) / grid_deg))
            if eix == pk["ix"] and eiy == pk["iy"] and e["first_tau"] is not None:
                tsum += e["first_tau"]
                tn += 1
        pk["mean_tau"] = (tsum / tn) if tn else None

    # Step 5: assign each entry to nearest peak passing both gates.
    cluster_entries = [[] for _ in peaks]
    for e in entries:
        best_i, best_d = -1, float("inf")
        for i, pk in enumerate(peaks):
            d = _tca_haversine_km(e["first_lat"], e["first_lon"],
                                  pk["lat"], pk["lon"])
            if d > assign_radius_km:
                continue
            if pk["mean_tau"] is not None and e["first_tau"] is not None:
                if abs(e["first_tau"] - pk["mean_tau"]) > time_window_h:
                    continue
            if d < best_d:
                best_d = d
                best_i = i
        if best_i >= 0:
            cluster_entries[best_i].append(e)

    # Step 6: build cluster bundles. Dedupe by sample within a cluster
    # (keep the closest-to-peak entry per sample), filter by min size.
    out = []
    for ci, cluster in enumerate(cluster_entries):
        if len(cluster) < cluster_min_members:
            continue
        pk = peaks[ci]
        # Per-sample best entry.
        best_per_sample: dict = {}
        contrib_track_ids: dict = {}
        for e in cluster:
            d = _tca_haversine_km(e["first_lat"], e["first_lon"],
                                  pk["lat"], pk["lon"])
            sk = e["sample_key"]
            if sk not in best_per_sample or d < best_per_sample[sk][0]:
                best_per_sample[sk] = (d, e)
            contrib_track_ids[e["from_track_id"]] = (
                contrib_track_ids.get(e["from_track_id"], 0) + 1)
        members = {}
        member_arrays = []
        for sk, (_d, e) in best_per_sample.items():
            members[sk] = {"points": e["points"]}
            member_arrays.append(e["points"])
        unique_total = len(best_per_sample)
        mean_pts = _tca_mean_track(member_arrays)
        peak_wind, peak_tau = 0.0, None
        for mp in mean_pts:
            if mp.get("wind") is not None and mp["wind"] > peak_wind:
                peak_wind = mp["wind"]
                peak_tau = mp["tau"]
        out.append({
            "track_id": f"tca-{ci}",
            "members": members,
            "ensemble_mean": {"points": mean_pts},
            "n_members": unique_total,
            "n_members_total": unique_total,
            "fraction": round(unique_total / max(1, ensemble_size), 4),
            "peak_wind": round(peak_wind, 1),
            "peak_tau": peak_tau,
            "peak_lat": pk["lat"],
            "peak_lon": pk["lon"],
            "peak_mean_tau": pk["mean_tau"],
            "gate_radius_km": assign_radius_km,
            "gate_time_h": time_window_h,
            "contrib_track_ids": contrib_track_ids,
            "capped_total": len(cluster),
        })
    # Sort by formation prob desc → D1 is largest. Re-label after sort.
    out.sort(key=lambda c: -c["n_members_total"])
    for idx, c in enumerate(out):
        c["display_label"] = f"Disturbance {idx + 1}"
        c["display_short"] = f"D{idx + 1}"
    return out


def _tca_get_or_compute_clusters(grid_deg, peak_min_members,
                                  assign_radius_km, time_window_h,
                                  cluster_min_members):
    """Return cached (full, with members) clusters for the current
    cycle + params, computing on miss. Used by both the index endpoint
    (which strips members for the response) and the per-cluster detail
    endpoint (which serves them in full)."""
    now = _dt.now(timezone.utc)
    used_date, used_hour, data = _resolve_latest_genesis_cycle(require_data=True)
    if data is None:
        return None, None, None, None
    init_time = used_date.replace("-", "") + used_hour
    params = (round(grid_deg, 3), int(peak_min_members),
              round(assign_radius_km, 2), round(time_window_h, 2),
              int(cluster_min_members))
    cache_key = (init_time, params)
    cached = _TCA_CLUSTER_CACHE.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _TCA_CLUSTER_TTL:
        return init_time, params, cached["clusters"], (used_date, used_hour)
    clusters = _tca_compute_clusters(
        data,
        grid_deg=grid_deg,
        peak_min_members=peak_min_members,
        assign_radius_km=assign_radius_km,
        time_window_h=time_window_h,
        cluster_min_members=cluster_min_members,
    )
    _TCA_CLUSTER_CACHE[cache_key] = {"clusters": clusters, "ts": time.time()}
    if len(_TCA_CLUSTER_CACHE) > _TCA_CLUSTER_CACHE_MAX:
        oldest = sorted(_TCA_CLUSTER_CACHE.items(),
                        key=lambda kv: kv[1]["ts"])[0][0]
        _TCA_CLUSTER_CACHE.pop(oldest, None)
    return init_time, params, clusters, (used_date, used_hour)


def _tca_clusters_for_cycle(date_str, hour_str, grid_deg, peak_min_members,
                            assign_radius_km, time_window_h,
                            cluster_min_members):
    """Like `_tca_get_or_compute_clusters` but for a SPECIFIC (already-
    resolved) cycle rather than 'the latest'. Shares the same
    `_TCA_CLUSTER_CACHE` so the run-to-run trend endpoint reuses the
    cluster set the global index already computed for the current cycle,
    and only pays compute on the older cycles. Returns the cluster list
    (with members) or None if the cycle has no data."""
    data = _fetch_weatherlab_genesis_csv(date_str, hour_str)
    if data is None:
        return None
    init_time = date_str.replace("-", "") + hour_str
    params = (round(grid_deg, 3), int(peak_min_members),
              round(assign_radius_km, 2), round(time_window_h, 2),
              int(cluster_min_members))
    cache_key = (init_time, params)
    cached = _TCA_CLUSTER_CACHE.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _TCA_CLUSTER_TTL:
        return cached["clusters"]
    clusters = _tca_compute_clusters(
        data,
        grid_deg=grid_deg,
        peak_min_members=peak_min_members,
        assign_radius_km=assign_radius_km,
        time_window_h=time_window_h,
        cluster_min_members=cluster_min_members,
    )
    _TCA_CLUSTER_CACHE[cache_key] = {"clusters": clusters, "ts": time.time()}
    if len(_TCA_CLUSTER_CACHE) > _TCA_CLUSTER_CACHE_MAX:
        oldest = sorted(_TCA_CLUSTER_CACHE.items(),
                        key=lambda kv: kv[1]["ts"])[0][0]
        _TCA_CLUSTER_CACHE.pop(oldest, None)
    return clusters


def _tca_cluster_index_view(c):
    """Strip the heavy per-member trajectories from a cluster for the
    index response. Keeps sample-key list so the frontend has unique-
    member counts, ensemble_mean (small), and all cluster metadata."""
    return {
        "track_id": c["track_id"],
        "display_label": c["display_label"],
        "display_short": c["display_short"],
        "n_members": c["n_members"],
        "n_members_total": c["n_members_total"],
        "fraction": c["fraction"],
        "peak_wind": c["peak_wind"],
        "peak_tau": c["peak_tau"],
        "peak_lat": c["peak_lat"],
        "peak_lon": c["peak_lon"],
        "peak_mean_tau": c["peak_mean_tau"],
        "gate_radius_km": c["gate_radius_km"],
        "gate_time_h": c["gate_time_h"],
        "contrib_track_ids": c["contrib_track_ids"],
        "capped_total": c["capped_total"],
        "ensemble_mean": c["ensemble_mean"],
        # Sample keys only — lets the frontend show unique counts and
        # display "X members" without the multi-MB trajectory blob.
        "sample_keys": list((c.get("members") or {}).keys()),
    }


@router.get("/weatherlab-genesis-clusters")
def get_weatherlab_genesis_clusters(
    grid_deg: float = 3.0,
    peak_min_members: int = 8,
    assign_radius_km: float = 1000.0,
    time_window_h: float = 60.0,
    cluster_min_members: int = 25,
):
    """Precomputed TC-ATLAS density-peak cluster INDEX — lightweight
    cluster metadata + ensemble_mean polylines, no per-member trajectories.
    Per-member data is served by /weatherlab-genesis-cluster/{tca_id}
    when the user clicks a disturbance.

    Query params mirror the on-page Advanced clustering controls so the
    sliders still drive recomputation server-side."""
    now = _dt.now(timezone.utc)
    init_time, params, clusters, dh = _tca_get_or_compute_clusters(
        grid_deg, peak_min_members, assign_radius_km,
        time_window_h, cluster_min_members)
    if clusters is None:
        next_eta_h = _genesis_next_cycle_eta_h(now=now, init_time=None)
        return JSONResponse(
            content={
                "model": "DeepMind FNV3 LARGE_ENSEMBLE",
                "method": "tcatlas",
                "init_time": None,
                "clusters": [],
                "n_clusters": 0,
                "next_cycle_eta_hours": round(next_eta_h, 2)
                                        if next_eta_h is not None else None,
            },
            headers={"Cache-Control": "public, max-age=120"},
        )

    used_date, used_hour = dh
    cycle_dt = _genesis_cycle_dt(used_date, used_hour)
    cycle_age_h = (now - cycle_dt).total_seconds() / 3600.0
    next_eta_h = _genesis_next_cycle_eta_h(now=now, init_time=init_time)
    return JSONResponse(
        content={
            "model": "DeepMind FNV3 LARGE_ENSEMBLE",
            "method": "tcatlas",
            "init_time": init_time,
            "params": {
                "grid_deg": params[0],
                "peak_min_members": params[1],
                "assign_radius_km": params[2],
                "time_window_h": params[3],
                "cluster_min_members": params[4],
            },
            "clusters": [_tca_cluster_index_view(c) for c in clusters],
            "n_clusters": len(clusters),
            "cycle_age_hours": round(cycle_age_h, 2),
            "next_cycle_eta_hours": round(next_eta_h, 2)
                                    if next_eta_h is not None else None,
            "fetched_at": now.isoformat(),
        },
        headers={"Cache-Control": "public, max-age=900"},
    )


@router.get("/weatherlab-genesis-cluster/{tca_id}")
def get_weatherlab_genesis_cluster(
    tca_id: str,
    grid_deg: float = 3.0,
    peak_min_members: int = 8,
    assign_radius_km: float = 1000.0,
    time_window_h: float = 60.0,
    cluster_min_members: int = 25,
):
    """Full per-member trajectories for one TC-ATLAS cluster (tca-N).
    Lazy-loaded by the detail modal when the user clicks a disturbance.
    Reuses the cached cluster computation — server work is one dict
    lookup if the index endpoint has already been hit this cycle."""
    init_time, params, clusters, dh = _tca_get_or_compute_clusters(
        grid_deg, peak_min_members, assign_radius_km,
        time_window_h, cluster_min_members)
    if clusters is None:
        raise HTTPException(status_code=404, detail="No cycle data available")
    match = next((c for c in clusters if c["track_id"] == tca_id), None)
    if match is None:
        raise HTTPException(
            status_code=404,
            detail=f"Cluster {tca_id} not found in current cycle ({init_time})")
    now = _dt.now(timezone.utc)
    next_eta_h = _genesis_next_cycle_eta_h(now=now, init_time=init_time)
    cycle_age_h = None
    if dh is not None:
        used_date, used_hour = dh
        cycle_age_h = (now - _genesis_cycle_dt(used_date, used_hour)).total_seconds() / 3600.0
    return JSONResponse(
        content={
            "model": "DeepMind FNV3 LARGE_ENSEMBLE",
            "method": "tcatlas",
            "init_time": init_time,
            "track_id": tca_id,
            "display_label": match["display_label"],
            "display_short": match["display_short"],
            "n_members": match["n_members"],
            "n_members_total": match["n_members_total"],
            "fraction": match["fraction"],
            "peak_wind": match["peak_wind"],
            "peak_tau": match["peak_tau"],
            "peak_lat": match["peak_lat"],
            "peak_lon": match["peak_lon"],
            "peak_mean_tau": match["peak_mean_tau"],
            "contrib_track_ids": match["contrib_track_ids"],
            "members": match["members"],
            "ensemble_mean": match["ensemble_mean"],
            "cycle_age_hours": round(cycle_age_h, 2)
                                if cycle_age_h is not None else None,
            "next_cycle_eta_hours": round(next_eta_h, 2)
                                    if next_eta_h is not None else None,
            "fetched_at": now.isoformat(),
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
_WEATHERLAB_LARGE_MISS_TTL = 600
_WEATHERLAB_LARGE_MISS = "__MISSING__"


def _fetch_weatherlab_large_csv(date_str: str, hour_str: str,
                                target_track: str | None = None) -> dict | None:
    """Fetch and parse the 1000-member ensemble CSV.

    To save memory, only parses rows matching target_track if provided.
    Returns dict keyed by track_id with per-member wind/pres arrays per tau.
    """
    cache_key = (date_str, hour_str, target_track or "ALL")
    hit = _weatherlab_cache_lookup(
        _weatherlab_large_cache, cache_key,
        _WEATHERLAB_LARGE_CACHE_TTL, _WEATHERLAB_LARGE_MISS_TTL)
    if hit is not _WL_CACHE_MISS:
        return hit   # fresh positive dict, or None for a known-missing cycle

    date_fmt = date_str.replace("-", "_")
    url = (
        f"{_WEATHERLAB_LARGE_BASE}/ensemble/paired/csv/"
        f"FNV3_LARGE_ENSEMBLE_{date_fmt}T{hour_str}_00_paired.csv"
    )

    try:
        print(f"[WeatherLab 1K] Fetching {date_str} {hour_str}z ...")
        resp = _weatherlab_http().get(url, timeout=60, stream=True)
    except Exception as e:
        # Transient — short negative cache only (see genesis fetcher).
        print(f"[WeatherLab 1K] transient fetch error "
              f"{date_str} {hour_str}z: {e}")
        _weatherlab_cache_transient(_weatherlab_large_cache, cache_key)
        return None
    if resp.status_code != 200:
        # Definitive 404 — cycle not published. Full MISS TTL.
        _weatherlab_large_cache[cache_key] = {
            "data": _WEATHERLAB_LARGE_MISS, "ts": time.time()}
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

    # Cache. Exclude miss-sentinel entries from the cap so 404 probes
    # can't evict a freshly-parsed multi-MB cycle.
    _weatherlab_large_cache[cache_key] = {"data": result, "ts": time.time()}
    parsed_keys = [k for k, v in _weatherlab_large_cache.items()
                   if v["data"] != _WEATHERLAB_LARGE_MISS]
    if len(parsed_keys) > 4:
        oldest = min(parsed_keys, key=lambda k: _weatherlab_large_cache[k]["ts"])
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
    data = None
    used_date = None
    used_hour = None
    for date_str, hour_str in _genesis_candidates(now=now):
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


# ---------------------------------------------------------------------------
# GFS Analysis Shear (200–850 hPa, 200–800 km annulus, vortex-removed)
# ---------------------------------------------------------------------------
# Pulls u/v at 200 and 850 hPa from the latest available GFS 0.25° analysis
# via the NOAA NOMADS cgi-bin filter (which serves a subsetted GRIB2 byte
# stream — typically 30–50 KB for our small box × 2 vars × 2 levels), masks
# to the SHIPS-canonical 200–800 km annulus around the storm's current
# best-track position, and returns the deep-layer shear vector. Cached per
# (atcf_id, gfs_cycle) so we do at most one fetch per storm per GFS cycle.
#
# NOMADS OPeNDAP was retired in SCN25-81; the cgi-bin filter is the
# recommended replacement and remains available.

_GFS_FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
_GFS_LATENCY_HOURS = 4.0       # NOMADS typically posts ~3.5h after cycle time
_SHEAR_INNER_KM = 200.0        # SHIPS annulus inner radius
_SHEAR_OUTER_KM = 800.0        # SHIPS annulus outer radius
_SHEAR_BOX_DEG = 9.0           # subset half-width in degrees (lat ~1000 km buffer)
_SHEAR_CACHE_TTL = 6 * 3600    # 6 hours; one GFS cycle
# Bumped to env-v3 after the env-profile + Helmholtz merge: payload
# combines the SHIPS deep-layer summary, the full vertical profile
# (u, v, T, RH, q at every level for Skew-T + shear-vs-pressure),
# and supports the Davis-Ahijevych Helmholtz method as an opt-in.
# Cache key includes method + params so SHIPS, env-profile, and
# Helmholtz-tuned variants don't cross-pollinate.
_SHEAR_CACHE_VER = "env-v3"
_shear_mem_cache: dict = {}    # (atcf_id, cycle_iso, params_key) → {data, ts}
_shear_mem_lock = threading.Lock()
_SHEAR_MEM_MAX = 200

# Davis & Ahijevych (2008) Helmholtz-decomposition defaults. The paper used
# 900-200 hPa shear over a 5400 km domain with the disturbance mask at
# r ≤ 900 km. We default the mask radius to 500 km (a more "storm-felt"
# scale) but keep the layer + evaluation at storm-center per the paper.
_DA_LAYER_LOWER_HPA = 900
_DA_LAYER_UPPER_HPA = 200
_DA_DEFAULT_MASK_KM = 500.0    # disturbance mask: zero div/vort outside this
_DA_DEFAULT_EVAL_KM = 500.0    # evaluation radius: 0–eval_km area-mean of env shear

# Standard pressure levels we pull for the env profile + Skew-T.
# Includes 900 (Davis-Ahijevych) and 850 (SHIPS) so a single GRIB
# fetch services every supported method. ~400 KB GRIB2 for a 9° box.
_GFS_PROFILE_LEVELS = [1000, 925, 900, 850, 700, 500, 400, 300, 250, 200, 150, 100]


def _latest_available_gfs_cycle() -> tuple[str, str]:
    """Return the latest GFS analysis cycle that should be available on NOMADS.

    GFS cycles at 00/06/12/18 UTC; allow ~4h for NOMADS to publish. Returns
    (YYYYMMDD, HH) strings.
    """
    now = _dt.now(timezone.utc) - timedelta(hours=_GFS_LATENCY_HOURS)
    cyc_hour = (now.hour // 6) * 6
    cyc_dt = now.replace(hour=cyc_hour, minute=0, second=0, microsecond=0)
    return cyc_dt.strftime("%Y%m%d"), f"{cyc_hour:02d}"


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometers (vectorizable when given numpy arrays)."""
    import numpy as np
    R = 6371.0
    lat1r = np.radians(lat1); lat2r = np.radians(lat2)
    dlat = np.radians(lat2 - lat1)
    dlon = np.radians(lon2 - lon1)
    # Wrap longitude difference to ±π for dateline safety
    dlon = np.where(dlon > np.pi, dlon - 2 * np.pi, dlon)
    dlon = np.where(dlon < -np.pi, dlon + 2 * np.pi, dlon)
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1r) * np.cos(lat2r) * np.sin(dlon / 2) ** 2
    return 2 * R * np.arcsin(np.minimum(np.sqrt(a), 1.0))


def _gcs_get_shear(atcf_id: str, cycle_iso: str,
                   params_key: str = "ships") -> Optional[dict]:
    """Read a cached shear result from GCS, if present and fresh.

    params_key encodes method + tunables so different invocations don't
    cross-pollinate (e.g. helmholtz with mask_km=500 vs mask_km=900).
    """
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return None
    blob_name = (
        f"shear/{_SHEAR_CACHE_VER}/{atcf_id.upper()}/"
        f"{cycle_iso}_{params_key}.json"
    )
    try:
        blob = bucket.blob(blob_name)
        if not blob.exists():
            return None
        return json.loads(blob.download_as_text())
    except Exception as e:
        logger.debug(f"GCS shear get failed for {atcf_id} {cycle_iso} {params_key}: {e}")
        return None


def _gcs_put_shear(atcf_id: str, cycle_iso: str, payload: dict,
                   params_key: str = "ships") -> None:
    """Write shear result to GCS (fire-and-forget)."""
    bucket = _get_rt_gcs_bucket()
    if bucket is None:
        return
    blob_name = (
        f"shear/{_SHEAR_CACHE_VER}/{atcf_id.upper()}/"
        f"{cycle_iso}_{params_key}.json"
    )
    try:
        blob = bucket.blob(blob_name)
        blob.upload_from_string(
            json.dumps(payload), content_type="application/json"
        )
    except Exception as e:
        logger.debug(f"GCS shear put failed for {atcf_id} {cycle_iso} {params_key}: {e}")


def _fetch_gfs_grib2(slat: float, slon360: float, date_str: str, hour_str: str,
                     levels: Optional[list] = None,
                     vars_: Optional[list] = None) -> Optional[bytes]:
    """Pull a GRIB2 slice from the NOMADS cgi-bin filter covering pressure-
    level u/v/T/RH (defaults) over a ~9° box around the storm.

    Defaults serve every supported shear method out of one fetch:
      * SHIPS deep-layer (200 ↔ 850)
      * Davis-Ahijevych Helmholtz (200 ↔ 900)
      * Full env-profile + Skew-T (all 12 levels)
    so we never round-trip GFS twice for the same storm/cycle.

    `levels` and `vars_` overrides are available for callers that want
    a smaller/cheaper subset. Returns raw GRIB2 bytes or None on failure.
    The cgi-bin filter may return an HTML error page instead of GRIB2 if
    the cycle isn't yet published; we detect that by checking the magic
    bytes.
    """
    import requests as _req

    if not levels:
        levels = list(_GFS_PROFILE_LEVELS)
    if not vars_:
        vars_ = ["UGRD", "VGRD", "TMP", "RH"]

    box = _SHEAR_BOX_DEG
    top = min(89.0, slat + box)
    bot = max(-89.0, slat - box)
    # cgi-bin uses 0–360 lon convention. Split-fetch over the dateline if
    # needed and concat the bytes (the GRIB format is a sequence of
    # self-contained messages, so concatenation is valid).
    lon_lo = slon360 - box
    lon_hi = slon360 + box

    def _one_fetch(left: float, right: float) -> Optional[bytes]:
        # Build (varname, level) cross-product as repeated query params.
        # cgi-bin filter accepts each var_X=on and lev_X_mb=on as on/off
        # toggles; the filter then emits all (var × level) pairs that
        # exist in the source GRIB2. Use a list-of-tuples (not dict) so
        # multiple lev_X_mb=on params survive urlencoding.
        params = [
            ("dir", f"/gfs.{date_str}/{hour_str}/atmos"),
            ("file", f"gfs.t{hour_str}z.pgrb2.0p25.f000"),
        ]
        for v in vars_:
            params.append((f"var_{v}", "on"))
        for L in levels:
            params.append((f"lev_{int(L)}_mb", "on"))
        params += [
            ("subregion", ""),
            ("toplat",    f"{top:.2f}"),
            ("leftlon",   f"{left:.2f}"),
            ("rightlon",  f"{right:.2f}"),
            ("bottomlat", f"{bot:.2f}"),
        ]
        try:
            r = _req.get(_GFS_FILTER_URL, params=params, timeout=45,
                         headers={"User-Agent": "TC-ATLAS/1.0"})
            if r.status_code != 200:
                logger.warning(f"[env] cgi-bin HTTP {r.status_code}")
                return None
            data = r.content
            if not data.startswith(b"GRIB"):
                # cgi-bin sometimes returns an HTML 200 with an error
                # message body when the file isn't yet on disk.
                logger.warning(
                    f"[env] non-GRIB response for {date_str} {hour_str}z "
                    f"({len(data)} bytes); first 80: {data[:80]!r}"
                )
                return None
            return data
        except Exception as e:
            logger.warning(f"[env] cgi-bin fetch failed: {e}")
            return None

    if lon_lo < 0 or lon_hi > 360:
        a = _one_fetch(lon_lo % 360.0, 359.75)
        b = _one_fetch(0.0, lon_hi % 360.0)
        if a is None or b is None:
            return None
        return a + b
    return _one_fetch(lon_lo, lon_hi)


def _compute_gfs_shear(lat: float, lon: float, date_str: str, hour_str: str) -> Optional[dict]:
    """Pull GFS GRIB2, vortex-mask, return shear dict. None on any failure."""
    import os as _os
    import tempfile
    import numpy as np
    import xarray as xr

    slon360 = lon % 360.0
    slat = lat

    grib_bytes = _fetch_gfs_grib2(slat, slon360, date_str, hour_str)
    if grib_bytes is None:
        return None

    # cfgrib reads from a real file on disk; use a temp file (small, ~50KB).
    tmp_dir = tempfile.mkdtemp(prefix="tcatlas_shear_")
    grib_path = _os.path.join(tmp_dir, "gfs_uv.grib2")
    try:
        with open(grib_path, "wb") as f:
            f.write(grib_bytes)
        try:
            ds = xr.open_dataset(grib_path, engine="cfgrib",
                                 backend_kwargs={"indexpath": ""})
        except Exception as e:
            logger.warning(f"[shear] cfgrib open failed: {e}")
            return None

        try:
            # cfgrib names: u, v, t (Kelvin), r (RH %) all on isobaricInhPa.
            # NB: `ds.get('u') or ds.get('U')` looks idiomatic but is wrong:
            # `or` evaluates the first operand's truthiness, and an
            # xarray.DataArray with >1 element raises
            # `ValueError: The truth value of an array with more than one
            # element is ambiguous` instead of returning the array.
            # Use explicit membership checks.
            u_var = ds["u"] if "u" in ds else (ds["U"] if "U" in ds else None)
            v_var = ds["v"] if "v" in ds else (ds["V"] if "V" in ds else None)
            t_var = ds["t"] if "t" in ds else (ds["T"] if "T" in ds else None)
            r_var = ds["r"] if "r" in ds else (ds["R"] if "R" in ds else None)  # RH %
            if u_var is None or v_var is None:
                logger.warning(f"[env] u/v missing; vars: {list(ds.data_vars)}")
                return None

            lev_name = "isobaricInhPa" if "isobaricInhPa" in u_var.dims else "level"
            lat_name = "latitude" if "latitude" in u_var.dims else "lat"
            lon_name = "longitude" if "longitude" in u_var.dims else "lon"

            lat_vals = u_var[lat_name].values
            lon_vals = u_var[lon_name].values
            lon_vals_360 = np.where(lon_vals < 0, lon_vals + 360.0, lon_vals)
            lats_g, lons_g = np.meshgrid(lat_vals, lon_vals_360, indexing="ij")
            dist_km = _haversine_km(slat, slon360, lats_g, lons_g)
            mask = (dist_km >= _SHEAR_INNER_KM) & (dist_km <= _SHEAR_OUTER_KM)
            n_pts = int(mask.sum())
            if n_pts < 8:
                logger.warning(f"[env] mask too sparse: {n_pts} pts for {slat},{slon360}")
                return None

            def _avg2d(da):
                arr = np.asarray(da.values)
                while arr.ndim > 2:
                    arr = arr[0]
                vals = arr[mask]
                vals = vals[np.isfinite(vals)]
                return float(vals.mean()) if vals.size else float("nan")

            # Build the per-level annular profile. cfgrib presents the levels
            # in source order (which the GFS GRIB happens to emit top-down,
            # i.e. 100 → 1000); we sort descending pressure for a tidy profile.
            levs_grib = list(u_var[lev_name].values)
            order = sorted(range(len(levs_grib)), key=lambda i: -levs_grib[i])
            plev_sorted = [int(levs_grib[i]) for i in order]
            u_prof = []; v_prof = []; t_prof = []; rh_prof = []
            for i in order:
                u_prof.append(round(_avg2d(u_var.isel({lev_name: i})), 2))
                v_prof.append(round(_avg2d(v_var.isel({lev_name: i})), 2))
                t_prof.append(round(_avg2d(t_var.isel({lev_name: i})), 2)
                              if t_var is not None else None)
                rh_prof.append(round(_avg2d(r_var.isel({lev_name: i})), 1)
                               if r_var is not None else None)

            # Pull deep-layer summary from the same profile so 850→200 hPa
            # always agrees with the levels we display in the Skew-T.
            def _at(level):
                if level not in plev_sorted:
                    return None, None
                k = plev_sorted.index(level)
                return u_prof[k], v_prof[k]
            u850a, v850a = _at(850)
            u200a, v200a = _at(200)
            if any(x is None or not np.isfinite(x)
                   for x in (u200a, v200a, u850a, v850a)):
                logger.warning("[env] missing 200/850 hPa in profile")
                return None

            du_ms = u200a - u850a
            dv_ms = v200a - v850a
            mag_ms = float(np.sqrt(du_ms ** 2 + dv_ms ** 2))
            hdg = float((np.degrees(np.arctan2(du_ms, dv_ms)) + 360.0) % 360.0)

            # Convert RH → specific humidity (q, kg/kg) for skewt.js so we
            # don't have to teach it RH semantics. Bolton/Tetens for es;
            # q = ε e / (p - 0.378 e). ε = Rd/Rv = 0.622.
            q_prof = []
            for k, pHpa in enumerate(plev_sorted):
                if t_prof[k] is None or rh_prof[k] is None:
                    q_prof.append(None); continue
                tC = t_prof[k] - 273.15
                es = 6.112 * np.exp(17.67 * tC / (tC + 243.5))
                e = max(0.0, (rh_prof[k] / 100.0) * es)
                q = 0.622 * e / max(pHpa - 0.378 * e, 1e-3)
                q_prof.append(round(float(q), 6))

            return {
                # Existing summary fields (unchanged contract).
                "magnitude_ms": round(mag_ms, 2),
                "magnitude_kt": round(mag_ms * 1.94384, 1),
                "heading_deg": round(hdg, 1),
                "du_ms": round(du_ms, 2),
                "dv_ms": round(dv_ms, 2),
                "u200_ms": round(u200a, 2),
                "v200_ms": round(v200a, 2),
                "u850_ms": round(u850a, 2),
                "v850_ms": round(v850a, 2),
                "annulus_km": [_SHEAR_INNER_KM, _SHEAR_OUTER_KM],
                "layer_hpa": [850, 200],
                "n_grid_points": n_pts,
                # New profile fields — annular-mean vertical structure
                # for shear-vs-pressure plots and an environmental Skew-T.
                "profile": {
                    "plev_hpa": plev_sorted,
                    "u_ms":     u_prof,
                    "v_ms":     v_prof,
                    "t_k":      t_prof,
                    "rh_pct":   rh_prof,
                    "q_kgkg":   q_prof,
                },
            }
        finally:
            try:
                ds.close()
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"[shear] computation failed: {e}")
        return None
    finally:
        try:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


def _compute_gfs_helmholtz_shear(
    lat: float,
    lon: float,
    date_str: str,
    hour_str: str,
    mask_km: float = _DA_DEFAULT_MASK_KM,
    eval_km: float = _DA_DEFAULT_EVAL_KM,
    lower_hpa: int = _DA_LAYER_LOWER_HPA,
    upper_hpa: int = _DA_LAYER_UPPER_HPA,
) -> Optional[dict]:
    """Davis & Ahijevych (2008) environmental shear via Helmholtz decomposition.

    Procedure (paper's eqs. 1–4):
      1. Compute total deep-layer shear field Δv = v(200) − v(900) on the
         GFS grid surrounding the storm.
      2. Compute differential divergence δ = ∂Δu/∂x + ∂Δv/∂y and
         differential vorticity ζ = ∂Δv/∂x − ∂Δu/∂y via central differences.
      3. Mask both to zero outside `mask_km` from the storm center —
         keeps only the disturbance contribution (paper used 900 km).
      4. Solve ∇²ψ = ζ_masked and ∇²χ = δ_masked with homogeneous
         Dirichlet BCs (ψ = χ = 0 on box edges) via DST-I — exact O(N² log N)
         solver for the discrete Laplacian on a uniform grid.
      5. Reconstruct disturbance shear:
            Δv_ψ = (-∂ψ/∂y, +∂ψ/∂x)   (rotational, vortex)
            Δv_χ = (+∂χ/∂x, +∂χ/∂y)   (irrotational, outflow/inflow)
      6. Environmental shear = total − Δv_ψ − Δv_χ.
      7. Report the env shear at the storm-center grid cell AND
         area-averaged over 0–`eval_km` (paper-equivalent "storm-felt" mean).

    Returns None on any failure (fetch, GRIB parse, sparse mask).
    """
    import os as _os
    import tempfile
    import numpy as np
    import xarray as xr
    try:
        from scipy.fft import dstn, idstn
    except Exception as e:
        logger.warning(f"[helmholtz] scipy.fft.dstn unavailable: {e}")
        return None

    slon360 = lon % 360.0
    slat = lat
    grib_bytes = _fetch_gfs_grib2(
        slat, slon360, date_str, hour_str,
        levels=[lower_hpa, upper_hpa],
    )
    if grib_bytes is None:
        return None

    tmp_dir = tempfile.mkdtemp(prefix="tcatlas_helm_")
    grib_path = _os.path.join(tmp_dir, "gfs_uv.grib2")
    try:
        with open(grib_path, "wb") as f:
            f.write(grib_bytes)
        try:
            ds = xr.open_dataset(grib_path, engine="cfgrib",
                                 backend_kwargs={"indexpath": ""})
        except Exception as e:
            logger.warning(f"[helmholtz] cfgrib open failed: {e}")
            return None

        try:
            # NB: `ds.get('u') or ds.get('U')` looks idiomatic but is wrong:
            # `or` evaluates the first operand's truthiness, and an
            # xarray.DataArray with >1 element raises
            # `ValueError: The truth value of an array with more than one
            # element is ambiguous` instead of returning the array.
            # Use explicit membership checks.
            u_var = ds["u"] if "u" in ds else (ds["U"] if "U" in ds else None)
            v_var = ds["v"] if "v" in ds else (ds["V"] if "V" in ds else None)
            if u_var is None or v_var is None:
                logger.warning(f"[helmholtz] u/v missing; vars: {list(ds.data_vars)}")
                return None

            lev_name = "isobaricInhPa" if "isobaricInhPa" in u_var.dims else "level"
            lat_name = "latitude" if "latitude" in u_var.dims else "lat"
            lon_name = "longitude" if "longitude" in u_var.dims else "lon"

            u_lo = u_var.sel({lev_name: lower_hpa}, method="nearest").values
            v_lo = v_var.sel({lev_name: lower_hpa}, method="nearest").values
            u_up = u_var.sel({lev_name: upper_hpa}, method="nearest").values
            v_up = v_var.sel({lev_name: upper_hpa}, method="nearest").values
            lat_v = np.asarray(u_var[lat_name].values)
            lon_v = np.asarray(u_var[lon_name].values)
            lon_v360 = np.where(lon_v < 0, lon_v + 360.0, lon_v)

            # Squeeze any extra leading dims (some cfgrib variants keep
            # singleton time/step axes after .sel).
            for arr in (u_lo, v_lo, u_up, v_up):
                pass  # arrays are already 2D after .sel().values
            while u_lo.ndim > 2: u_lo = u_lo[0]
            while v_lo.ndim > 2: v_lo = v_lo[0]
            while u_up.ndim > 2: u_up = u_up[0]
            while v_up.ndim > 2: v_up = v_up[0]

            # Ensure rows are sorted by ASCENDING latitude so that ∂/∂y is
            # northward-positive. cfgrib often returns lat descending.
            if len(lat_v) >= 2 and lat_v[1] < lat_v[0]:
                lat_v = lat_v[::-1]
                u_lo = u_lo[::-1, :]; v_lo = v_lo[::-1, :]
                u_up = u_up[::-1, :]; v_up = v_up[::-1, :]

            # Local Cartesian projection. cos(slat) for the lon-stride; valid
            # for our small box even at moderate lats. R in METERS so dx/dy
            # come out in meters (∇² will be in 1/m²).
            R_m = 6371.0e3
            cos_lat0 = float(np.cos(np.radians(slat)))
            dy = R_m * np.radians(abs(lat_v[1] - lat_v[0]))
            dx = R_m * cos_lat0 * np.radians(abs(lon_v360[1] - lon_v360[0]))
            Ny, Nx = u_lo.shape
            box_km = max(Nx * dx, Ny * dy) / 1000.0

            # Total deep-layer shear field (Δu, Δv = upper − lower).
            du = u_up - u_lo
            dv = v_up - v_lo

            # Differential divergence + vorticity (central differences,
            # zero at edges since we use [1:-1] slicing).
            div = np.zeros_like(du)
            vort = np.zeros_like(du)
            div[:, 1:-1] = (du[:, 2:] - du[:, :-2]) / (2 * dx)
            div[1:-1, :] += (dv[2:, :] - dv[:-2, :]) / (2 * dy)
            vort[:, 1:-1] = (dv[:, 2:] - dv[:, :-2]) / (2 * dx)
            vort[1:-1, :] -= (du[2:, :] - du[:-2, :]) / (2 * dy)

            # Disturbance mask: zero δ, ζ outside mask_km from storm.
            lats_g, lons_g = np.meshgrid(lat_v, lon_v360, indexing="ij")
            dist = _haversine_km(slat, slon360, lats_g, lons_g)
            mask_in = dist <= mask_km
            n_in = int(mask_in.sum())
            if n_in < 8:
                logger.warning(f"[helmholtz] mask too sparse: {n_in} pts")
                return None
            div_m = np.where(mask_in, div, 0.0)
            vort_m = np.where(mask_in, vort, 0.0)

            # Solve Poisson via DST-I. Eigenvalues of the discrete Laplacian
            # on Nx×Ny INTERIOR points with homogeneous Dirichlet BCs:
            #   λ_pq = -[2(1-cos(πp/(Nx+1)))/dx² + 2(1-cos(πq/(Ny+1)))/dy²]
            # so ψ_t = vort_t / λ → ψ = idstn(ψ_t).
            def _poisson(rhs, dx_, dy_):
                ny, nx = rhs.shape
                ip = np.arange(1, ny + 1)
                jp = np.arange(1, nx + 1)
                ly = 2 * (1 - np.cos(np.pi * ip / (ny + 1))) / (dy_ ** 2)
                lx = 2 * (1 - np.cos(np.pi * jp / (nx + 1))) / (dx_ ** 2)
                Lx, Ly = np.meshgrid(lx, ly)
                eig = -(Lx + Ly)
                rhs_t = dstn(rhs, type=1, norm="ortho")
                phi_t = rhs_t / eig
                return idstn(phi_t, type=1, norm="ortho")

            psi = _poisson(vort_m, dx, dy)
            chi = _poisson(div_m, dx, dy)

            # Disturbance components from gradients.
            u_psi = np.zeros_like(psi); v_psi = np.zeros_like(psi)
            u_chi = np.zeros_like(chi); v_chi = np.zeros_like(chi)
            u_psi[1:-1, :] = -(psi[2:, :] - psi[:-2, :]) / (2 * dy)
            v_psi[:, 1:-1] =  (psi[:, 2:] - psi[:, :-2]) / (2 * dx)
            u_chi[:, 1:-1] =  (chi[:, 2:] - chi[:, :-2]) / (2 * dx)
            v_chi[1:-1, :] =  (chi[2:, :] - chi[:-2, :]) / (2 * dy)
            u_dist = u_psi + u_chi
            v_dist = v_psi + v_chi

            # Environmental shear field.
            u_env = du - u_dist
            v_env = dv - v_dist

            # Storm-center grid-cell value (paper convention).
            ic = int(np.argmin(np.abs(lat_v - slat)))
            jc = int(np.argmin(np.abs(lon_v360 - slon360)))
            u_env_ctr = float(u_env[ic, jc])
            v_env_ctr = float(v_env[ic, jc])

            # 0–eval_km area-mean (a useful "storm-felt" scalar summary).
            eval_mask = dist <= eval_km
            n_eval = int(eval_mask.sum())
            u_env_avg = float(np.nanmean(u_env[eval_mask])) if n_eval else float("nan")
            v_env_avg = float(np.nanmean(v_env[eval_mask])) if n_eval else float("nan")

            mag_ms = float(np.sqrt(u_env_avg ** 2 + v_env_avg ** 2))
            hdg = float((np.degrees(np.arctan2(u_env_avg, v_env_avg)) + 360.0) % 360.0)

            # Diagnostic: compare against the storm-disturbance magnitude
            # (how much the Helmholtz subtraction "took out").
            u_dist_avg = float(np.nanmean(u_dist[eval_mask]))
            v_dist_avg = float(np.nanmean(v_dist[eval_mask]))
            mag_dist = float(np.sqrt(u_dist_avg ** 2 + v_dist_avg ** 2))

            return {
                "magnitude_ms": round(mag_ms, 2),
                "magnitude_kt": round(mag_ms * 1.94384, 1),
                "heading_deg": round(hdg, 1),
                "du_ms": round(u_env_avg, 2),
                "dv_ms": round(v_env_avg, 2),
                # Center-cell value (paper's reporting convention).
                "u_env_center_ms": round(u_env_ctr, 2),
                "v_env_center_ms": round(v_env_ctr, 2),
                "magnitude_center_ms": round(float(np.sqrt(u_env_ctr**2 + v_env_ctr**2)), 2),
                "magnitude_center_kt": round(float(np.sqrt(u_env_ctr**2 + v_env_ctr**2)) * 1.94384, 1),
                # How much of the original shear was attributed to the storm.
                "disturbance_magnitude_ms": round(mag_dist, 2),
                "disturbance_magnitude_kt": round(mag_dist * 1.94384, 1),
                # Method parameters (echoed for audit).
                "method": "helmholtz",
                "layer_hpa": [lower_hpa, upper_hpa],
                "mask_km": mask_km,
                "eval_km": eval_km,
                "domain_km": round(box_km, 0),
                "n_grid_points_mask": n_in,
                "n_grid_points_eval": n_eval,
            }
        finally:
            try:
                ds.close()
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"[helmholtz] computation failed: {e}")
        return None
    finally:
        try:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


# Shear-profile axes: layer BOTTOM (x) and TOP (y) candidate pressures.
# A cell (bottom, top) is the Helmholtz env shear for that layer; only
# valid where top < bottom (top is the lower-pressure / higher-altitude
# end). Drawn as a 2D heatmap on the storm page.
_SHEAR_PROFILE_BOTTOMS = [900, 850, 700, 500, 400, 300]
_SHEAR_PROFILE_TOPS    = [850, 700, 500, 400, 300, 250, 200, 150]


def _load_gfs_uv_levels(slat: float, slon360: float, date_str: str,
                        hour_str: str, levels: list):
    """Fetch GFS u/v at the given pressure levels around the storm in ONE
    GRIB request and return oriented (ascending-lat) 2D fields plus grid
    metadata shared across layer pairs. Returns (fields, meta) where
    fields = {level_hpa: (u2d, v2d)} and meta carries the haversine
    distance grid (km), grid spacing dx/dy (m), storm-center indices
    ic/jc, and box_km. None on failure.
    """
    import os as _os
    import tempfile
    import numpy as np
    import xarray as xr

    grib_bytes = _fetch_gfs_grib2(
        slat, slon360, date_str, hour_str,
        levels=list(levels), vars_=["UGRD", "VGRD"],
    )
    if grib_bytes is None:
        return None

    tmp_dir = tempfile.mkdtemp(prefix="tcatlas_helmprof_")
    grib_path = _os.path.join(tmp_dir, "gfs_uv.grib2")
    try:
        with open(grib_path, "wb") as f:
            f.write(grib_bytes)
        try:
            ds = xr.open_dataset(grib_path, engine="cfgrib",
                                 backend_kwargs={"indexpath": ""})
        except Exception as e:
            logger.warning(f"[helmprof] cfgrib open failed: {e}")
            return None
        try:
            u_var = ds["u"] if "u" in ds else (ds["U"] if "U" in ds else None)
            v_var = ds["v"] if "v" in ds else (ds["V"] if "V" in ds else None)
            if u_var is None or v_var is None:
                logger.warning(f"[helmprof] u/v missing; vars: {list(ds.data_vars)}")
                return None
            lev_name = "isobaricInhPa" if "isobaricInhPa" in u_var.dims else "level"
            lat_name = "latitude" if "latitude" in u_var.dims else "lat"
            lon_name = "longitude" if "longitude" in u_var.dims else "lon"
            lat_v = np.asarray(u_var[lat_name].values)
            lon_v = np.asarray(u_var[lon_name].values)
            lon_v360 = np.where(lon_v < 0, lon_v + 360.0, lon_v)
            flip = len(lat_v) >= 2 and lat_v[1] < lat_v[0]
            if flip:
                lat_v = lat_v[::-1]

            fields = {}
            for L in levels:
                try:
                    u2 = u_var.sel({lev_name: L}, method="nearest").values
                    v2 = v_var.sel({lev_name: L}, method="nearest").values
                except Exception:
                    continue
                while u2.ndim > 2:
                    u2 = u2[0]
                while v2.ndim > 2:
                    v2 = v2[0]
                if flip:
                    u2 = u2[::-1, :]
                    v2 = v2[::-1, :]
                fields[int(L)] = (np.asarray(u2, dtype=float),
                                  np.asarray(v2, dtype=float))
            if not fields:
                return None

            R_m = 6371.0e3
            cos_lat0 = float(np.cos(np.radians(slat)))
            dy = R_m * np.radians(abs(lat_v[1] - lat_v[0]))
            dx = R_m * cos_lat0 * np.radians(abs(lon_v360[1] - lon_v360[0]))
            Ny, Nx = next(iter(fields.values()))[0].shape
            box_km = max(Nx * dx, Ny * dy) / 1000.0
            lats_g, lons_g = np.meshgrid(lat_v, lon_v360, indexing="ij")
            dist = _haversine_km(slat, slon360, lats_g, lons_g)
            ic = int(np.argmin(np.abs(lat_v - slat)))
            jc = int(np.argmin(np.abs(lon_v360 - slon360)))
            return fields, {
                "dx": dx, "dy": dy, "dist": dist,
                "ic": ic, "jc": jc, "box_km": box_km,
            }
        finally:
            try:
                ds.close()
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"[helmprof] load failed: {e}")
        return None
    finally:
        try:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


def _helmholtz_env_shear_pair(u_lo, v_lo, u_up, v_up, dist, dx, dy,
                              ic, jc, mask_km, eval_km):
    """Davis & Ahijevych (2008) environmental shear for ONE layer pair from
    already-loaded, ascending-lat 2D u/v fields (lower + upper level). This
    is the same decomposition as _compute_gfs_helmholtz_shear's inner math,
    factored out so the shear-profile endpoint can reuse a single GRIB fetch
    across ~33 layer pairs. Returns {magnitude_kt, heading_deg, ...} or None.
    """
    import numpy as np
    try:
        from scipy.fft import dstn, idstn
    except Exception:
        return None

    du = u_up - u_lo
    dv = v_up - v_lo
    div = np.zeros_like(du)
    vort = np.zeros_like(du)
    div[:, 1:-1] = (du[:, 2:] - du[:, :-2]) / (2 * dx)
    div[1:-1, :] += (dv[2:, :] - dv[:-2, :]) / (2 * dy)
    vort[:, 1:-1] = (dv[:, 2:] - dv[:, :-2]) / (2 * dx)
    vort[1:-1, :] -= (du[2:, :] - du[:-2, :]) / (2 * dy)

    mask_in = dist <= mask_km
    n_in = int(mask_in.sum())
    if n_in < 8:
        return None
    div_m = np.where(mask_in, div, 0.0)
    vort_m = np.where(mask_in, vort, 0.0)

    def _poisson(rhs, dx_, dy_):
        ny, nx = rhs.shape
        ip = np.arange(1, ny + 1)
        jp = np.arange(1, nx + 1)
        ly = 2 * (1 - np.cos(np.pi * ip / (ny + 1))) / (dy_ ** 2)
        lx = 2 * (1 - np.cos(np.pi * jp / (nx + 1))) / (dx_ ** 2)
        Lx, Ly = np.meshgrid(lx, ly)
        eig = -(Lx + Ly)
        rhs_t = dstn(rhs, type=1, norm="ortho")
        phi_t = rhs_t / eig
        return idstn(phi_t, type=1, norm="ortho")

    psi = _poisson(vort_m, dx, dy)
    chi = _poisson(div_m, dx, dy)

    u_psi = np.zeros_like(psi); v_psi = np.zeros_like(psi)
    u_chi = np.zeros_like(chi); v_chi = np.zeros_like(chi)
    u_psi[1:-1, :] = -(psi[2:, :] - psi[:-2, :]) / (2 * dy)
    v_psi[:, 1:-1] =  (psi[:, 2:] - psi[:, :-2]) / (2 * dx)
    u_chi[:, 1:-1] =  (chi[:, 2:] - chi[:, :-2]) / (2 * dx)
    v_chi[1:-1, :] =  (chi[2:, :] - chi[:-2, :]) / (2 * dy)
    u_env = du - (u_psi + u_chi)
    v_env = dv - (v_psi + v_chi)

    eval_mask = dist <= eval_km
    n_eval = int(eval_mask.sum())
    if not n_eval:
        return None
    u_env_avg = float(np.nanmean(u_env[eval_mask]))
    v_env_avg = float(np.nanmean(v_env[eval_mask]))
    mag_ms = float(np.sqrt(u_env_avg ** 2 + v_env_avg ** 2))
    hdg = float((np.degrees(np.arctan2(u_env_avg, v_env_avg)) + 360.0) % 360.0)
    u_env_ctr = float(u_env[ic, jc])
    v_env_ctr = float(v_env[ic, jc])
    return {
        "magnitude_ms": round(mag_ms, 2),
        "magnitude_kt": round(mag_ms * 1.94384, 1),
        "heading_deg": round(hdg, 1),
        "magnitude_center_kt": round(
            float(np.sqrt(u_env_ctr ** 2 + v_env_ctr ** 2)) * 1.94384, 1),
        "n_grid_points_mask": n_in,
        "n_grid_points_eval": n_eval,
    }


def _compute_gfs_shear_profile_helmholtz(lat: float, lon: float, date_str: str,
                                         hour_str: str,
                                         mask_km: float = _DA_DEFAULT_MASK_KM,
                                         eval_km: float = _DA_DEFAULT_EVAL_KM
                                         ) -> Optional[dict]:
    """Helmholtz env-shear magnitude for a grid of (bottom, top) layer pairs.

    One GFS fetch covers every needed level; the Helmholtz decomposition is
    run per pair (top < bottom) and reduced to the 0–eval_km env-shear
    magnitude. Returns axes + a 2D matrix (rows=tops, cols=bottoms) of kt,
    with None in cells where the layer is invalid or the solve failed.
    """
    import numpy as np
    slon360 = lon % 360.0
    slat = lat
    levels = sorted(set(_SHEAR_PROFILE_BOTTOMS) | set(_SHEAR_PROFILE_TOPS),
                    reverse=True)
    loaded = _load_gfs_uv_levels(slat, slon360, date_str, hour_str, levels)
    if loaded is None:
        return None
    fields, meta = loaded
    bottoms = [b for b in _SHEAR_PROFILE_BOTTOMS if b in fields]
    tops = [t for t in _SHEAR_PROFILE_TOPS if t in fields]
    if not bottoms or not tops:
        return None

    mag = [[None] * len(bottoms) for _ in tops]
    hdg = [[None] * len(bottoms) for _ in tops]
    for ti, t in enumerate(tops):
        u_up, v_up = fields[t]
        for bi, b in enumerate(bottoms):
            if t >= b:        # top must be lower pressure than bottom
                continue
            u_lo, v_lo = fields[b]
            res = _helmholtz_env_shear_pair(
                u_lo, v_lo, u_up, v_up, meta["dist"], meta["dx"], meta["dy"],
                meta["ic"], meta["jc"], mask_km, eval_km)
            if res is not None:
                mag[ti][bi] = res["magnitude_kt"]
                hdg[ti][bi] = res["heading_deg"]
    return {
        "method": "helmholtz",
        "bottoms_hpa": bottoms,
        "tops_hpa": tops,
        "magnitude_kt": mag,
        "heading_deg": hdg,
        "mask_km": mask_km,
        "eval_km": eval_km,
        "domain_km": round(meta["box_km"], 0),
    }


def _resolve_storm_position(atcf_id: str) -> Optional[tuple[float, float, str]]:
    """Return (lat, lon, last_fix_iso) for an active storm or None."""
    aid_up = atcf_id.upper()
    with _active_storms_lock:
        for s in _active_storms_cache.get("storms", []):
            if s.get("atcf_id", "").upper() == aid_up:
                return s["lat"], s["lon"], s.get("last_fix_utc")
    # Fall back to A/B-deck if not in active cache (storm just became inactive)
    records = _fetch_bdeck(atcf_id.lower()) or _fetch_adeck(atcf_id.lower())
    if not records:
        return None
    latest = _get_latest_position(records)
    if not latest:
        return None
    return (
        float(latest["lat"]),
        float(latest["lon"]),
        latest["datetime"].strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


@router.get("/storm/{atcf_id}/shear")
def get_storm_shear(
    atcf_id: str,
    method: str = "ships",
    mask_km: Optional[float] = None,
    eval_km: Optional[float] = None,
    lower_hpa: Optional[int] = None,
    upper_hpa: Optional[int] = None,
):
    """Return vortex-removed deep-layer shear at the storm's current
    best-track position from the latest GFS 0.25° analysis.

    Methods (?method=...):
      * `ships` (default) — 200–800 km annular average of u/v at 850 +
        200 hPa, vector difference. Matches SHIPS SHRD/SHTD.
      * `helmholtz` — Davis & Ahijevych (2008): solve a Poisson problem
        for the streamfunction ψ and velocity potential χ of the
        differential vorticity / divergence field, mask the disturbance
        within `mask_km` (default 500 km), reconstruct the rotational
        + irrotational disturbance shear, subtract from the total. Layer
        is 900 → 200 hPa per the paper. Result is reported as the
        environmental shear area-averaged within `eval_km` (default
        500 km) plus the storm-center grid-cell value.

    Heading is "toward" (westerly shear → 90°). Cached per
    (atcf_id, cycle, method, params); GFS refreshes every 6 hours.
    """
    method = (method or "ships").lower()
    if method not in ("ships", "helmholtz"):
        raise HTTPException(
            status_code=400,
            detail=f"Unknown method '{method}'. Valid: ships, helmholtz.",
        )
    if method == "helmholtz":
        m_km = float(mask_km) if mask_km is not None else _DA_DEFAULT_MASK_KM
        e_km = float(eval_km) if eval_km is not None else _DA_DEFAULT_EVAL_KM
        lo_hpa = int(lower_hpa) if lower_hpa is not None else _DA_LAYER_LOWER_HPA
        up_hpa = int(upper_hpa) if upper_hpa is not None else _DA_LAYER_UPPER_HPA
        if not (50.0 <= m_km <= 2000.0):
            raise HTTPException(status_code=400, detail="mask_km must be in [50, 2000].")
        if not (50.0 <= e_km <= 1500.0):
            raise HTTPException(status_code=400, detail="eval_km must be in [50, 1500].")
        if lo_hpa not in _GFS_PROFILE_LEVELS or up_hpa not in _GFS_PROFILE_LEVELS:
            raise HTTPException(
                status_code=400,
                detail=f"lower_hpa/upper_hpa must be in {sorted(_GFS_PROFILE_LEVELS)}.")
        if up_hpa >= lo_hpa:
            raise HTTPException(
                status_code=400,
                detail="upper_hpa must be a lower pressure (higher level) than lower_hpa.")
    else:
        m_km = e_km = None  # not used for ships
        lo_hpa = up_hpa = None

    pos = _resolve_storm_position(atcf_id)
    if pos is None:
        raise HTTPException(status_code=404, detail=f"No position found for {atcf_id}")
    slat, slon, last_fix = pos

    date_str, hour_str = _latest_available_gfs_cycle()
    cycle_iso = f"{date_str}T{hour_str}"
    # Cache key includes method + params so different invocations don't
    # cross-pollinate (different mask radii produce genuinely different
    # results — caching them under one key would silently serve the wrong
    # answer to the second caller).
    if method == "helmholtz":
        params_key = f"helmholtz:L{lo_hpa}-{up_hpa}:m{int(m_km)}:e{int(e_km)}"
    else:
        params_key = "ships"
    cache_key = (atcf_id.upper(), cycle_iso, params_key)

    with _shear_mem_lock:
        hit = _shear_mem_cache.get(cache_key)
        if hit and time.time() - hit["ts"] < _SHEAR_CACHE_TTL:
            return JSONResponse(
                content=hit["data"],
                headers={"Cache-Control": "public, max-age=1800"},
            )

    # GCS warm cache. The helper bakes method+params into the blob name
    # so old SHIPS-only entries (shear-v1) don't collide with the new
    # schema (shear-v2 with method/params split).
    gcs_hit = _gcs_get_shear(atcf_id, cycle_iso, params_key)
    if gcs_hit is not None:
        with _shear_mem_lock:
            _shear_mem_cache[cache_key] = {"data": gcs_hit, "ts": time.time()}
            while len(_shear_mem_cache) > _SHEAR_MEM_MAX:
                _shear_mem_cache.pop(next(iter(_shear_mem_cache)))
        return JSONResponse(
            content=gcs_hit,
            headers={"Cache-Control": "public, max-age=1800"},
        )

    # Compute fresh.
    if method == "helmholtz":
        shear = _compute_gfs_helmholtz_shear(slat, slon, date_str, hour_str,
                                             mask_km=m_km, eval_km=e_km,
                                             lower_hpa=lo_hpa, upper_hpa=up_hpa)
    else:
        shear = _compute_gfs_shear(slat, slon, date_str, hour_str)

    # Fall back one cycle if NOMADS hasn't published yet
    if shear is None:
        try:
            cyc_dt = _dt.strptime(date_str + hour_str, "%Y%m%d%H").replace(tzinfo=timezone.utc)
            cyc_dt -= timedelta(hours=6)
            date_str = cyc_dt.strftime("%Y%m%d")
            hour_str = cyc_dt.strftime("%H")
            cycle_iso = f"{date_str}T{hour_str}"
            cache_key = (atcf_id.upper(), cycle_iso, params_key)
            if method == "helmholtz":
                shear = _compute_gfs_helmholtz_shear(slat, slon, date_str, hour_str,
                                                     mask_km=m_km, eval_km=e_km,
                                                     lower_hpa=lo_hpa, upper_hpa=up_hpa)
            else:
                shear = _compute_gfs_shear(slat, slon, date_str, hour_str)
        except Exception:
            shear = None

    if shear is None:
        raise HTTPException(
            status_code=503,
            detail="GFS analysis unavailable; try again shortly.",
        )

    payload = {
        "atcf_id": atcf_id.upper(),
        "lat": slat,
        "lon": slon,
        "last_fix_utc": last_fix,
        "gfs_cycle_utc": f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z",
        "source": "GFS 0.25° analysis (NOMADS cgi-bin filter)",
        **shear,
    }
    # SHIPS path doesn't echo `method` in its result dict; tag it for
    # symmetry so frontends can dispatch on the field reliably.
    payload.setdefault("method", "ships")

    with _shear_mem_lock:
        _shear_mem_cache[cache_key] = {"data": payload, "ts": time.time()}
        while len(_shear_mem_cache) > _SHEAR_MEM_MAX:
            _shear_mem_cache.pop(next(iter(_shear_mem_cache)))
    threading.Thread(
        target=_gcs_put_shear,
        args=(atcf_id, cycle_iso, payload, params_key),
        daemon=True,
    ).start()

    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "public, max-age=1800"},
    )


@router.get("/storm/{atcf_id}/shear-profile")
def get_storm_shear_profile(
    atcf_id: str,
    mask_km: Optional[float] = None,
    eval_km: Optional[float] = None,
):
    """Helmholtz environmental-shear magnitude across a grid of layer
    choices: x = layer bottom (900–300 hPa), y = layer top (850–150 hPa),
    z = 0–`eval_km` env-shear magnitude (kt) with the vortex removed inside
    `mask_km`. Lets a forecaster see which deep-layer slab the shear is
    concentrated in. Same GFS analysis + caching as /shear; one fetch
    services all ~33 layer pairs.
    """
    m_km = float(mask_km) if mask_km is not None else _DA_DEFAULT_MASK_KM
    e_km = float(eval_km) if eval_km is not None else _DA_DEFAULT_EVAL_KM
    if not (50.0 <= m_km <= 2000.0):
        raise HTTPException(status_code=400, detail="mask_km must be in [50, 2000].")
    if not (50.0 <= e_km <= 1500.0):
        raise HTTPException(status_code=400, detail="eval_km must be in [50, 1500].")

    pos = _resolve_storm_position(atcf_id)
    if pos is None:
        raise HTTPException(status_code=404, detail=f"No position found for {atcf_id}")
    slat, slon, last_fix = pos

    date_str, hour_str = _latest_available_gfs_cycle()
    cycle_iso = f"{date_str}T{hour_str}"
    params_key = f"profile:m{int(m_km)}:e{int(e_km)}"
    cache_key = (atcf_id.upper(), cycle_iso, params_key)

    with _shear_mem_lock:
        hit = _shear_mem_cache.get(cache_key)
        if hit and time.time() - hit["ts"] < _SHEAR_CACHE_TTL:
            return JSONResponse(content=hit["data"],
                                headers={"Cache-Control": "public, max-age=1800"})

    gcs_hit = _gcs_get_shear(atcf_id, cycle_iso, params_key)
    if gcs_hit is not None:
        with _shear_mem_lock:
            _shear_mem_cache[cache_key] = {"data": gcs_hit, "ts": time.time()}
            while len(_shear_mem_cache) > _SHEAR_MEM_MAX:
                _shear_mem_cache.pop(next(iter(_shear_mem_cache)))
        return JSONResponse(content=gcs_hit,
                            headers={"Cache-Control": "public, max-age=1800"})

    prof = _compute_gfs_shear_profile_helmholtz(slat, slon, date_str, hour_str,
                                                mask_km=m_km, eval_km=e_km)
    if prof is None:
        # Fall back one GFS cycle if NOMADS hasn't published yet.
        try:
            cyc_dt = _dt.strptime(date_str + hour_str, "%Y%m%d%H").replace(tzinfo=timezone.utc)
            cyc_dt -= timedelta(hours=6)
            date_str = cyc_dt.strftime("%Y%m%d")
            hour_str = cyc_dt.strftime("%H")
            cycle_iso = f"{date_str}T{hour_str}"
            cache_key = (atcf_id.upper(), cycle_iso, params_key)
            prof = _compute_gfs_shear_profile_helmholtz(slat, slon, date_str, hour_str,
                                                        mask_km=m_km, eval_km=e_km)
        except Exception:
            prof = None

    if prof is None:
        raise HTTPException(status_code=503,
                            detail="GFS analysis unavailable; try again shortly.")

    payload = {
        "atcf_id": atcf_id.upper(),
        "lat": slat,
        "lon": slon,
        "last_fix_utc": last_fix,
        "gfs_cycle_utc": f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z",
        "source": "GFS 0.25° analysis (NOMADS cgi-bin filter)",
        **prof,
    }
    with _shear_mem_lock:
        _shear_mem_cache[cache_key] = {"data": payload, "ts": time.time()}
        while len(_shear_mem_cache) > _SHEAR_MEM_MAX:
            _shear_mem_cache.pop(next(iter(_shear_mem_cache)))
    threading.Thread(target=_gcs_put_shear,
                     args=(atcf_id, cycle_iso, payload, params_key),
                     daemon=True).start()

    return JSONResponse(content=payload,
                        headers={"Cache-Control": "public, max-age=1800"})


# ─────────────────────────────────────────────────────────────────
# Surface observations overlay (NDBC buoys for now; Synoptic Data
# land obs is a planned follow-up once a free-tier token is wired).
# Pulls the one-shot latest_obs.txt from NDBC (no auth, ~1 hr old)
# and filters by a bbox around the storm's current position.
# ─────────────────────────────────────────────────────────────────

_NDBC_LATEST_URL = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
_NDBC_STATIONS_URL = "https://www.ndbc.noaa.gov/activestations.xml"
_NDBC_CACHE: dict = {"text": None, "stations": None, "fetched_at": 0.0}
_NDBC_CACHE_LOCK = threading.Lock()
_NDBC_CACHE_TTL_S = 10 * 60   # 10 min — matches buoy report cadence


def _fetch_ndbc_latest_text() -> str | None:
    """Cached one-shot pull of NDBC's latest_obs.txt. ~150 KB. Refreshes
    every 10 min — buoys report on 10-min cycles so refreshing faster
    just costs bandwidth without new data."""
    with _NDBC_CACHE_LOCK:
        if (_NDBC_CACHE["text"] is not None and
                (time.time() - _NDBC_CACHE["fetched_at"]) < _NDBC_CACHE_TTL_S):
            return _NDBC_CACHE["text"]
    try:
        import urllib.request
        req = urllib.request.Request(
            _NDBC_LATEST_URL, headers={"User-Agent": "tc-atlas/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8", errors="ignore")
    except Exception as ex:
        print(f"[Surface Obs] NDBC fetch failed: {ex}")
        return None
    with _NDBC_CACHE_LOCK:
        _NDBC_CACHE["text"] = text
        _NDBC_CACHE["fetched_at"] = time.time()
    return text


def _parse_ndbc_latest(text: str) -> list[dict]:
    """Parse the latest_obs.txt fixed-width feed. Columns are documented
    in NDBC's data file header (commented out with #) and have stayed
    stable for years. Returns a list of dicts with normalized SI units."""
    # Header line is the second line; first row is column names.
    # Example header:  STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    if len(lines) < 2:
        return []
    rows = []

    def _f(v: str) -> float | None:
        try:
            x = float(v)
            return None if x in (99.0, 999.0, 9999.0, 99.0, 99.00) else x
        except (ValueError, TypeError):
            return None

    for line in lines[1:]:  # skip the unit row
        parts = line.split()
        if len(parts) < 7:
            continue
        try:
            stn = parts[0]
            lat = float(parts[1])
            lon = float(parts[2])
        except (ValueError, IndexError):
            continue
        # NDBC pad with "MM" for missing values; pad to 21 fields.
        while len(parts) < 21:
            parts.append("MM")
        rows.append({
            "id": stn,
            "lat": lat,
            "lon": lon,
            "time_utc": (f"{parts[3]}-{parts[4]}-{parts[5]}T"
                         f"{parts[6]}:{parts[7]}:00Z"),
            "wind_dir_deg": _f(parts[8]),
            "wind_speed_kt": _f(parts[9]),
            "wind_gust_kt": _f(parts[10]),
            "wave_height_m": _f(parts[11]),
            "wave_period_s": _f(parts[12]),
            "pressure_hpa": _f(parts[15]),
            "pressure_tend_hpa": _f(parts[16]),
            "air_temp_c": _f(parts[17]),
            "sst_c": _f(parts[18]),
            "dewpoint_c": _f(parts[19]),
            "source": "NDBC",
        })
    return rows


@router.get("/storm/{atcf_id}/surface-obs")
def get_storm_surface_obs(
    atcf_id: str,
    radius_deg: float = Query(10.0, ge=1.0, le=20.0,
                              description="Half-width of the bbox around the storm center"),
    max_stations: int = Query(500, ge=50, le=1500),
):
    """Return surface observations within the storm's bbox — METAR
    airports/land (aviationweather.gov) merged with NDBC marine buoys,
    the same blend the global viewport overlay serves. Frontend renders
    these in conventional station-plot format (wind barbs, T/Td, MSLP).

    Bbox is ±radius_deg around the storm's current advisory position.
    NDBC buoy coverage is U.S.-centric (Atlantic / GoM / E-Pac / Hawaii),
    so a Western Pacific TC sees essentially no buoys — the METAR merge is
    what lights up land/island stations (Japan, Philippines, Taiwan, …)
    around those storms. Results are grid-thinned to <= max_stations.

    Future source to layer in: Synoptic Data API (needs a free-tier
    token) for additional land + marine mesonet coverage.
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

    def _wrap(x: float) -> float:
        return ((x + 180.0) % 360.0) - 180.0

    n = min(center_lat + half, 90.0)
    s_ = max(center_lat - half, -90.0)
    w = _wrap(center_lon - half)
    e = _wrap(center_lon + half)
    # Antimeridian-crossing bbox (common for W-Pac / dateline storms):
    # split into two lon spans so both the METAR pull and NDBC filter
    # walk the same continuous axis as the viewport endpoint.
    lon_boxes = [(w, e)] if w <= e else [(w, 180.0), (-180.0, e)]

    metars: list[dict] = []
    for (lw, le_) in lon_boxes:
        metars.extend(_fetch_metars_bbox(s_, lw, n, le_))

    ndbc: list[dict] = []
    text = _fetch_ndbc_latest_text()
    if text:
        for ob in _parse_ndbc_latest(text):
            if not (s_ <= ob["lat"] <= n):
                continue
            olon = _wrap(ob["lon"])
            if any(lw <= olon <= le_ for (lw, le_) in lon_boxes):
                ndbc.append(ob)

    combined = metars + ndbc
    total_before = len(combined)
    thinned = _grid_thin_obs(combined, s_, n, lon_boxes, max_stations)

    return JSONResponse(
        content={
            "atcf_id": atcf_id.upper(),
            "storm_center": {"lat": center_lat, "lon": center_lon},
            "bbox": {
                "north": center_lat + half, "south": center_lat - half,
                "east": center_lon + half,  "west": center_lon - half,
            },
            "fetched_at": _dt.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "n_obs": len(thinned),
            "n_before_thinning": total_before,
            "sources": ["METAR", "NDBC"],
            "observations": thinned,
        },
        headers={"Cache-Control": "public, max-age=600"},
    )


# ─────────────────────────────────────────────────────────────────
# Global viewport surface-obs overlay (Global Archive map). Merges
# NDBC buoys (cached global feed) with aviationweather.gov METARs
# fetched by bbox. METAR results are cached per integer-degree bbox so
# slight pans / repeated viewports reuse the same upstream pull, which
# keeps us well under any rate limit and costs ~nothing.
# ─────────────────────────────────────────────────────────────────

_METAR_BBOX_URL = "https://aviationweather.gov/api/data/metar"
_METAR_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_METAR_CACHE_LOCK = threading.Lock()
_METAR_CACHE_TTL_S = 10 * 60      # METARs refresh ~hourly; 10 min stays fresh
_METAR_CACHE_MAX = 64             # cap distinct bbox tiles held in memory


def _metar_num(v):
    """aviationweather encodes missing/variable winds as null, '', or
    strings like 'VRB'. Coerce to float or None."""
    if v is None:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _fetch_metars_bbox(south: float, west: float,
                       north: float, east: float) -> list[dict]:
    """Cached METAR pull for an integer-degree bbox tile. Snaps the
    requested bbox out to whole degrees so adjacent viewports share a
    cache entry. Returns obs normalized to the same schema as NDBC."""
    key = (int(math.floor(south)), int(math.floor(west)),
           int(math.ceil(north)), int(math.ceil(east)))
    now = time.time()
    with _METAR_CACHE_LOCK:
        hit = _METAR_CACHE.get(key)
        if hit and (now - hit["fetched_at"]) < _METAR_CACHE_TTL_S:
            _METAR_CACHE.move_to_end(key)
            return hit["obs"]

    s, w, n, e = key
    url = f"{_METAR_BBOX_URL}?format=json&bbox={s},{w},{n},{e}"
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "tc-atlas/1.0"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            body = resp.read().decode("utf-8", errors="ignore").strip()
        # Open-ocean bboxes with no airports come back as an empty body
        # (not "[]"), which is a normal no-data case, not an error.
        raw = json.loads(body) if body else []
    except Exception as ex:
        print(f"[Surface Obs] METAR fetch failed for {key}: {ex}")
        return []

    obs: list[dict] = []
    for m in (raw or []):
        lat = _metar_num(m.get("lat"))
        lon = _metar_num(m.get("lon"))
        if lat is None or lon is None:
            continue
        # Prefer reduced sea-level pressure; fall back to altimeter setting
        # (close enough for the station-plot's last-3-digits convention).
        mslp = _metar_num(m.get("slp"))
        if mslp is None:
            mslp = _metar_num(m.get("altim"))
        time_utc = (m.get("reportTime") or "").replace(" ", "T")
        if time_utc and not time_utc.endswith("Z"):
            time_utc += "Z"
        obs.append({
            "id": m.get("icaoId") or m.get("name") or "METAR",
            "name": m.get("name"),
            "lat": lat,
            "lon": lon,
            "time_utc": time_utc,
            "wind_dir_deg": _metar_num(m.get("wdir")),
            "wind_speed_kt": _metar_num(m.get("wspd")),
            "wind_gust_kt": _metar_num(m.get("wgst")),
            "air_temp_c": _metar_num(m.get("temp")),
            "dewpoint_c": _metar_num(m.get("dewp")),
            "pressure_hpa": mslp,
            "source": "METAR",
        })

    with _METAR_CACHE_LOCK:
        _METAR_CACHE[key] = {"obs": obs, "fetched_at": now}
        _METAR_CACHE.move_to_end(key)
        while len(_METAR_CACHE) > _METAR_CACHE_MAX:
            _METAR_CACHE.popitem(last=False)
    return obs


def _ob_richness(ob: dict) -> int:
    """Rank an ob for grid-thinning: the most complete ob wins its cell."""
    score = 0
    if ob.get("pressure_hpa") is not None:
        score += 4
    if ob.get("wind_speed_kt") is not None:
        score += 2
    if ob.get("air_temp_c") is not None:
        score += 1
    # Slight tiebreak toward buoys — offshore they're the only ob around,
    # while METARs are abundant on land anyway.
    if ob.get("source") == "NDBC":
        score += 1
    return score


def _grid_thin_obs(obs: list[dict], south: float, north: float,
                   lon_boxes: list[tuple], max_stations: int) -> list[dict]:
    """Bin obs into a lat/lon grid (~max_stations cells over the viewport)
    and keep the richest ob per cell. Keeps dense regions legible and the
    payload bounded. `lon_boxes` is the (possibly antimeridian-split) set
    of [west,east] spans, walked left-to-right as one continuous axis."""
    if len(obs) <= max_stations:
        return obs
    lat_span = max(north - south, 1e-6)
    lon_span = sum((le_ - lw) for (lw, le_) in lon_boxes) or 1e-6
    aspect = max(lon_span / lat_span, 1e-6)
    n_lat = max(1, int(round(math.sqrt(max_stations / aspect))))
    n_lon = max(1, int(round(max_stations / n_lat)))
    dlat = lat_span / n_lat
    dlon = lon_span / n_lon
    best: dict = {}
    for ob in obs:
        ilat = int((ob["lat"] - south) / dlat)
        olon = ((ob["lon"] + 180.0) % 360.0) - 180.0
        off = 0.0
        placed = 0.0
        for (lw, le_) in lon_boxes:
            if lw <= olon <= le_:
                placed = off + (olon - lw)
                break
            off += (le_ - lw)
        ilon = int(placed / dlon)
        key = (ilat, ilon)
        cur = best.get(key)
        if cur is None or _ob_richness(ob) > _ob_richness(cur):
            best[key] = ob
    return list(best.values())


@router.get("/surface-obs/viewport")
def get_surface_obs_viewport(
    north: float = Query(..., ge=-90, le=90),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(...),
    west: float = Query(...),
    max_stations: int = Query(500, ge=50, le=1500),
):
    """Surface observations inside a map viewport — METAR airports/land
    (aviationweather.gov) merged with NDBC marine buoys. Backs the Global
    Archive 'Surface Obs' overlay. Results are grid-thinned to
    <= max_stations so dense regions stay readable and payloads small.

    The frontend gates fetching by zoom; we also clamp the latitude span
    here so a hand-crafted request can't trigger a whole-globe pull.
    """
    if north <= south:
        raise HTTPException(status_code=400, detail="north must exceed south")
    if (north - south) > 60:
        raise HTTPException(status_code=400,
                            detail="latitude span too large; zoom in")

    def _wrap(x: float) -> float:
        return ((x + 180.0) % 360.0) - 180.0

    w = _wrap(west)
    e = _wrap(east)
    # Antimeridian-crossing viewport: split into two lon spans.
    lon_boxes = [(w, e)] if w <= e else [(w, 180.0), (-180.0, e)]

    metars: list[dict] = []
    for (lw, le_) in lon_boxes:
        metars.extend(_fetch_metars_bbox(south, lw, north, le_))

    ndbc: list[dict] = []
    text = _fetch_ndbc_latest_text()
    if text:
        for ob in _parse_ndbc_latest(text):
            if not (south <= ob["lat"] <= north):
                continue
            olon = _wrap(ob["lon"])
            if any(lw <= olon <= le_ for (lw, le_) in lon_boxes):
                ndbc.append(ob)

    combined = metars + ndbc
    total_before = len(combined)
    thinned = _grid_thin_obs(combined, south, north, lon_boxes, max_stations)

    return JSONResponse(
        content={
            "bbox": {"north": north, "south": south,
                     "east": east, "west": west},
            "fetched_at": _dt.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "n_obs": len(thinned),
            "n_before_thinning": total_before,
            "sources": ["METAR", "NDBC"],
            "observations": thinned,
        },
        headers={"Cache-Control": "public, max-age=300"},
    )
