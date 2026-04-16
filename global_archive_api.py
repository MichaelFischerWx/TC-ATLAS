"""
global_archive_api.py — FastAPI router for Global TC Archive (IR satellite imagery)

Include in tc_radar_api.py:
    from global_archive_api import router as global_router
    app.include_router(global_router, prefix="/global")

Endpoints:
    GET /global/hursat/meta?sid={SID}    — HURSAT frame list for a storm
    GET /global/hursat/frame?sid={SID}&frame_idx={N}  — Rendered IR frame as base64 PNG
    GET /global/ir/meta?sid={SID}&track=...  — Unified IR meta (auto-selects source)
    GET /global/ir/frame?sid={SID}&frame_idx={N}&lat=...&lon=...  — Unified IR frame
    GET /global/health                   — Cache status
    GET /global/hursat/debug?sid={SID}   — Debug NCEI connectivity

Data sources:
    GridSat-B1 CDR (1980–2024): NCEI THREDDS, global 8km 3-hourly, no auth required
    MergIR (2000–present): NASA GES DISC, global 4km half-hourly, requires Earthdata token
    HURSAT-B1 v06 (1978–2015): NCEI tar.gz archives, storm-centered 8km 3-hourly (legacy fallback)
    Priority: MergIR (2000+) > GridSat (1980-2024) > HURSAT (1978-2015 fallback)
"""

import base64
import gc
import io
import json
import logging
import os
import re
import tarfile
import tempfile
import threading
from collections import OrderedDict
from datetime import datetime
from functools import lru_cache

import numpy as np
import requests
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from PIL import Image

from tc_center_fix import find_ir_center

logger = logging.getLogger("global_archive")

# ── GCS Cache ────────────────────────────────────────────────
# Shared GCS bucket for IR frame cache AND flight-level recon cache.
# Tries GCS_IR_CACHE_BUCKET first, falls back to TC_RADAR_GCS_BUCKET.
GCS_IR_CACHE_BUCKET = (
    os.environ.get("GCS_IR_CACHE_BUCKET", "")
    or os.environ.get("TC_RADAR_GCS_BUCKET", "")
)
_gcs_client = None
_gcs_bucket = None


def _get_gcs_bucket():
    """Lazy-init GCS client and bucket. Returns None if not configured."""
    global _gcs_client, _gcs_bucket
    if not GCS_IR_CACHE_BUCKET:
        return None
    if _gcs_bucket is not None:
        return _gcs_bucket
    try:
        from google.cloud import storage
        _gcs_client = storage.Client()
        _gcs_bucket = _gcs_client.bucket(GCS_IR_CACHE_BUCKET)
        logger.info(f"GCS cache enabled: gs://{GCS_IR_CACHE_BUCKET}")
        return _gcs_bucket
    except Exception as e:
        logger.warning(f"GCS cache init failed: {e}")
        return None


# Bump this version whenever rendering logic changes to invalidate stale cache.
_GCS_CACHE_VERSION = "v6"  # v6: actual data bounds from loaders (fixes geo-alignment offset)


def _gcs_cache_key(sid: str, frame_idx: int, source: str = "ir") -> str:
    """Build GCS object path for a cached frame."""
    return f"{_GCS_CACHE_VERSION}/{source}/{sid}/{frame_idx}.json"


def _gcs_get_frame(sid: str, frame_idx: int, source: str = "ir") -> dict | None:
    """Try to read a cached frame from GCS. Returns parsed dict or None."""
    bucket = _get_gcs_bucket()
    if bucket is None:
        return None
    key = _gcs_cache_key(sid, frame_idx, source)
    try:
        blob = bucket.blob(key)
        data = blob.download_as_bytes(timeout=5)
        return json.loads(data)
    except Exception:
        return None


def _gcs_put_frame(sid: str, frame_idx: int, result: dict, source: str = "ir"):
    """Write a rendered frame to GCS in a background thread (fire-and-forget)."""
    bucket = _get_gcs_bucket()
    if bucket is None:
        return

    def _upload():
        key = _gcs_cache_key(sid, frame_idx, source)
        try:
            blob = bucket.blob(key)
            blob.upload_from_string(
                json.dumps(result, separators=(",", ":")),
                content_type="application/json",
                timeout=15,
            )
            logger.debug(f"GCS cache PUT: {key}")
        except Exception as e:
            logger.debug(f"GCS cache PUT failed: {key}: {e}")

    threading.Thread(target=_upload, daemon=True).start()

router = APIRouter(tags=["global_archive"])

# ── Configuration ────────────────────────────────────────────

HURSAT_V06_BASE = (
    "https://www.ncei.noaa.gov/data/hurricane-satellite-hursat-b1/archive/v06"
)

HURSAT_START_YEAR = 1978
HURSAT_END_YEAR = 2015

# MergIR (NASA GES DISC GPM_MERGIR) — via OPeNDAP for server-side subsetting
MERGIR_OPENDAP = "https://disc2.gesdisc.eosdis.nasa.gov/opendap/MERGED_IR/GPM_MERGIR.1"
MERGIR_START_YEAR = 1998  # Extended back from Feb 2000 in June 2025

# GridSat-B1 CDR (NOAA/NCEI THREDDS) — 3-hourly global IR, 0.07° (~8km), 1980–present
# No authentication required (public NCEI data)
GRIDSAT_THREDDS = "https://www.ncei.noaa.gov/thredds/dodsC/cdr/gridsat"
GRIDSAT_DIRECT = "https://www.ncei.noaa.gov/data/geostationary-ir-channel-brightness-temperature-gridsat-b1/access"
GRIDSAT_START_YEAR = 1980
GRIDSAT_END_YEAR = 2024  # Updates paused since March 2024
GRIDSAT_HALF_DOMAIN = 10.0  # 10° each direction = 20°×20° box — fills Leaflet panel

# Earthdata credentials for MergIR access (set via env vars on Render)
# Option 1: Bearer token (EARTHDATA_TOKEN) — preferred
# Option 2: Username/password (EARTHDATA_USER + EARTHDATA_PASS)
# Either option requires a ~/.netrc entry for urs.earthdata.nasa.gov
EARTHDATA_TOKEN = os.environ.get("EARTHDATA_TOKEN", "")
EARTHDATA_USER = os.environ.get("EARTHDATA_USER", "")
EARTHDATA_PASS = os.environ.get("EARTHDATA_PASS", "")


def _setup_earthdata_netrc():
    """
    Create ~/.netrc and ~/.dodsrc for NASA GES DISC OPeNDAP access.

    OPeNDAP (used by xarray) requires ~/.netrc with Earthdata credentials.
    Also creates ~/.dodsrc to tell the DAP client to follow redirects and
    check cookies from urs.earthdata.nasa.gov.

    Security note: The token is injected from GCP Secret Manager at container
    start (see deploy.sh --set-secrets). The .netrc is written to the ephemeral
    container filesystem with 0o600 permissions and is destroyed when the
    container shuts down. This is the standard NASA-recommended auth pattern
    for OPeNDAP clients.
    """
    home = os.path.expanduser("~")
    netrc_path = os.path.join(home, ".netrc")
    dodsrc_path = os.path.join(home, ".dodsrc")

    # Skip if no credentials configured
    if not EARTHDATA_USER and not EARTHDATA_TOKEN:
        print("[global_archive] Earthdata: no credentials configured (MergIR disabled)")
        return

    # Write ~/.netrc
    if EARTHDATA_USER and EARTHDATA_PASS:
        netrc_entry = (
            f"machine urs.earthdata.nasa.gov\n"
            f"    login {EARTHDATA_USER}\n"
            f"    password {EARTHDATA_PASS}\n"
        )
    elif EARTHDATA_TOKEN:
        # Use token as password with 'token' as username
        netrc_entry = (
            f"machine urs.earthdata.nasa.gov\n"
            f"    login token\n"
            f"    password {EARTHDATA_TOKEN}\n"
        )
    else:
        return

    try:
        with open(netrc_path, "w") as f:
            f.write(netrc_entry)
        os.chmod(netrc_path, 0o600)
        print(f"[global_archive] Earthdata: wrote {netrc_path}")
    except Exception as e:
        print(f"[global_archive] Earthdata: FAILED to write {netrc_path}: {e}")

    # Write ~/.dodsrc for OPeNDAP cookie/redirect handling
    dodsrc_content = (
        "HTTP.COOKIEJAR=~/.urs_cookies\n"
        "HTTP.NETRC=~/.netrc\n"
    )
    try:
        with open(dodsrc_path, "w") as f:
            f.write(dodsrc_content)
        print(f"[global_archive] Earthdata: wrote {dodsrc_path}")
    except Exception as e:
        print(f"[global_archive] Earthdata: FAILED to write {dodsrc_path}: {e}")


# Run netrc setup at import time (before any OPeNDAP requests)
print(f"[global_archive] EARTHDATA_USER={'set' if EARTHDATA_USER else 'empty'}, "
      f"EARTHDATA_PASS={'set' if EARTHDATA_PASS else 'empty'}, "
      f"EARTHDATA_TOKEN={'set' if EARTHDATA_TOKEN else 'empty'}")
_setup_earthdata_netrc()

_HTTP_HEADERS = {
    "User-Agent": "TC-RADAR-API/1.0 (NOAA/HRD research; https://michaelfischerwx.github.io/TC-RADAR/)"
}

# ── Caches ───────────────────────────────────────────────────

# Cache for extracted NetCDF file paths from tar.gz (keyed by SID)
# Value: list of (datetime_str, tmp_nc_path) tuples, sorted chronologically
_extracted_cache: OrderedDict = OrderedDict()
_EXTRACTED_CACHE_MAX = 5  # Max storms extracted at once (each uses disk + memory)

# LRU cache for rendered PNG frames
# With scale=4 upscaling, each base64 WebP is ~200-350 KB.
# Browser caches all frames in JS anyway, so server cache is just
# to avoid re-rendering on rapid replays.
_frame_cache: OrderedDict = OrderedDict()
_FRAME_CACHE_MAX = 100  # ~100 × 300KB ≈ 30 MB max (fits comfortably in 2 GB)

# LRU cache for HURSAT metadata (frame lists)
_meta_cache: OrderedDict = OrderedDict()
_META_CACHE_MAX = 80

# Semaphore to limit concurrent data loading (OPeNDAP / HTTP downloads).
# Each load can consume 50-150 MB transiently; on a 2 GB Render instance
# we must cap concurrent loads to avoid OOM.  5 slots allows more
# parallelism while keeping peak memory under ~750 MB (5 × 150 MB).
_data_load_semaphore = threading.Semaphore(5)

# ── MergIR rate limiter ──────────────────────────────────────────────
# NASA GES DISC (Earthdata) can throttle or 503 when a single client
# sustains many parallel OPeNDAP/HTTP requests.  This serialises the
# pacing so requests are spaced ≥ MERGIR_MIN_INTERVAL apart, without
# slowing down GridSat or HURSAT fetches which use different servers.
import time as _time

_mergir_last_request_ts = 0.0
_mergir_rate_lock = threading.Lock()
MERGIR_MIN_INTERVAL = 0.15  # seconds between consecutive NASA requests (was 0.5)


def _mergir_rate_limit():
    """Block until at least MERGIR_MIN_INTERVAL since the last NASA request."""
    global _mergir_last_request_ts
    with _mergir_rate_lock:
        now = _time.monotonic()
        elapsed = now - _mergir_last_request_ts
        if elapsed < MERGIR_MIN_INTERVAL:
            _time.sleep(MERGIR_MIN_INTERVAL - elapsed)
        _mergir_last_request_ts = _time.monotonic()


# ── MergIR circuit breaker ───────────────────────────────────────────
# If N consecutive MergIR fetches fail/timeout, temporarily skip MergIR
# and fall back to GridSat/HURSAT.  This prevents the entire pipeline
# from hanging when NASA GES DISC is slow or the Earthdata token is
# expired (which causes silent redirect-to-login-page failures).
_mergir_consecutive_failures = 0
_mergir_circuit_open_until = 0.0  # monotonic timestamp
_mergir_circuit_lock = threading.Lock()
MERGIR_CIRCUIT_THRESHOLD = 3    # failures before opening circuit
MERGIR_CIRCUIT_COOLDOWN = 300   # seconds to skip MergIR after circuit opens (5 min)


def _mergir_record_success():
    """Reset the circuit breaker on a successful MergIR fetch."""
    global _mergir_consecutive_failures
    with _mergir_circuit_lock:
        _mergir_consecutive_failures = 0


def _mergir_record_failure():
    """Record a MergIR failure.  Opens the circuit after THRESHOLD consecutive failures."""
    global _mergir_consecutive_failures, _mergir_circuit_open_until
    with _mergir_circuit_lock:
        _mergir_consecutive_failures += 1
        if _mergir_consecutive_failures >= MERGIR_CIRCUIT_THRESHOLD:
            _mergir_circuit_open_until = _time.monotonic() + MERGIR_CIRCUIT_COOLDOWN
            logger.warning(
                f"MergIR circuit breaker OPEN — {_mergir_consecutive_failures} consecutive "
                f"failures, skipping MergIR for {MERGIR_CIRCUIT_COOLDOWN}s"
            )


def _mergir_circuit_is_open() -> bool:
    """Check if the MergIR circuit breaker is open (should skip MergIR)."""
    with _mergir_circuit_lock:
        if _mergir_circuit_open_until == 0.0:
            return False
        if _time.monotonic() >= _mergir_circuit_open_until:
            # Cooldown expired — half-open: allow one attempt
            return False
        return True

# Persistent HTTP session for NCEI (GridSat) and general downloads.
# Reusing a session keeps TCP connections alive, avoiding ~200-500ms
# TCP+TLS handshake overhead per request.
_ncei_session: requests.Session | None = None


def _get_ncei_session() -> requests.Session:
    """Return a persistent session for NCEI/GridSat/HURSAT downloads."""
    global _ncei_session
    if _ncei_session is None:
        _ncei_session = requests.Session()
        _ncei_session.headers.update(_HTTP_HEADERS)
    return _ncei_session


# ── IR Tb Encoding ───────────────────────────────────────────
# Encode Tb as uint8 for compact transfer to client.
# Client applies colormaps locally, enabling instant colorbar switching.
# Encoding: 0 = invalid/transparent, 1-255 = Tb from TB_VMIN to TB_VMAX
# Precision: (310-170)/254 ≈ 0.551 K per step
TB_VMIN = 170.0  # K
TB_VMAX = 310.0  # K
TB_SCALE = 254.0 / (TB_VMAX - TB_VMIN)  # steps per K


def _encode_tb_uint8(frame_2d):
    """
    Encode a 2D Tb array as a compact base64 uint8 string for client-side rendering.

    Returns dict with:
      - tb_data: base64-encoded uint8 array (row-major, north-at-top)
      - tb_rows: number of rows
      - tb_cols: number of columns
      - tb_vmin/tb_vmax: Tb range for decoding
    """
    arr = np.asarray(frame_2d, dtype=np.float32)
    mask = ~np.isfinite(arr) | (arr <= 0)

    # Map Tb to 1-255 range (0 = invalid)
    scaled = np.clip((arr - TB_VMIN) * TB_SCALE + 1, 1, 255)
    scaled[mask] = 0
    encoded = scaled.astype(np.uint8)

    return {
        "tb_data": base64.b64encode(encoded.tobytes()).decode("ascii"),
        "tb_rows": encoded.shape[0],
        "tb_cols": encoded.shape[1],
        "tb_vmin": TB_VMIN,
        "tb_vmax": TB_VMAX,
    }


# ── IR Colormap (matches radar archive: NOAA-style enhanced) ─

IR_COLORMAP_STOPS = [
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


@lru_cache(maxsize=1)
def _build_ir_lut():
    """Build 256-entry RGBA lookup table from IR_COLORMAP_STOPS."""
    stops = IR_COLORMAP_STOPS
    lut = np.zeros((256, 4), dtype=np.uint8)
    for i in range(256):
        frac = i / 255.0
        lo, hi = stops[0], stops[-1]
        for s in range(len(stops) - 1):
            if frac >= stops[s][0] and frac <= stops[s + 1][0]:
                lo, hi = stops[s], stops[s + 1]
                break
        t = 0.0 if hi[0] == lo[0] else (frac - lo[0]) / (hi[0] - lo[0])
        lut[i, 0] = int(lo[1] + t * (hi[1] - lo[1]) + 0.5)
        lut[i, 1] = int(lo[2] + t * (hi[2] - lo[2]) + 0.5)
        lut[i, 2] = int(lo[3] + t * (hi[3] - lo[3]) + 0.5)
        lut[i, 3] = 255
    return lut


_IR_LUT = _build_ir_lut()


def _render_ir_png(frame_2d, vmin=170.0, vmax=310.0, scale=2):
    """
    Render a 2D brightness temperature array to a base64 PNG.

    scale: upscale factor for higher resolution when zoomed in on the map.
           Default 2 for MergIR (4km native). Use scale=4 for 8km data
           (HURSAT, GridSat) to avoid blurriness when Leaflet stretches
           the image across the map viewport.

           Uses nearest-neighbor interpolation to preserve crisp pixel
           boundaries — bilinear smears edges and creates false smoothness
           that implies resolution the data doesn't have.
    """
    arr = np.asarray(frame_2d, dtype=np.float32)

    # Identify invalid pixels BEFORE arithmetic to avoid NaN propagation
    # warnings during the uint8 cast (NaN → float math → NaN → uint8 = warning)
    mask = ~np.isfinite(arr) | (arr <= 0)

    # Cold clouds (low Tb) → high index → bright colors
    frac = 1.0 - (arr - vmin) / (vmax - vmin)
    frac[mask] = 0.0  # Pre-zero invalid pixels so clip/cast is clean
    frac = np.clip(frac, 0.0, 1.0)
    indices = (frac * 255).astype(np.uint8)

    # Apply LUT
    rgba = _IR_LUT[indices]  # shape (H, W, 4)

    # Set invalid pixels to transparent
    rgba[mask] = [0, 0, 0, 0]

    # NOTE: Vertical orientation is handled in _load_frame_from_nc()
    # which checks actual latitude order and ensures north-at-top.
    # No flip needed here.

    img = Image.fromarray(rgba, "RGBA")
    del arr, frac, indices, rgba, mask  # Free intermediate arrays

    # Upscale for higher resolution when zoomed in on the map.
    # NEAREST preserves crisp pixel boundaries (no false smoothing).
    if scale and scale > 1:
        new_w = img.width * scale
        new_h = img.height * scale
        img = img.resize((new_w, new_h), Image.NEAREST)

    buf = io.BytesIO()
    # WebP q=75: ~60% smaller than PNG for spatially-coherent IR data,
    # which means faster JSON serialization and network transfer.
    # method=0 = fastest encoding. Lossy artifacts invisible at NEAREST upscale.
    try:
        img.save(buf, format="WEBP", quality=75, method=0)
        mime = "image/webp"
    except Exception:
        # Fallback to PNG if WebP not available on this platform
        img.save(buf, format="PNG", compress_level=1)
        mime = "image/png"
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _downsample_tb_grid(frame_2d, max_size=150):
    """
    Downsample a 2D Tb array to at most max_size × max_size for hover display.
    Returns a list-of-lists (row-major) with integer Tb values (K),
    or None for invalid pixels.  Typically 10-30 KB in JSON.

    Vectorized — avoids Python for-loops over pixels for ~10-50× speedup.
    """
    arr = np.asarray(frame_2d, dtype=np.float32)
    h, w = arr.shape
    step_y = max(1, h // max_size)
    step_x = max(1, w // max_size)
    small = arr[::step_y, ::step_x]

    # Vectorized: round valid pixels, mark invalid as -9999 sentinel
    mask = np.isfinite(small) & (small > 0)
    rounded = np.where(mask, np.round(small).astype(np.int32), -9999)

    # Convert to Python list, replacing sentinel with None
    result = rounded.tolist()
    for row in result:
        for j in range(len(row)):
            if row[j] == -9999:
                row[j] = None
    return result


# ── HURSAT Data Access ───────────────────────────────────────

def _parse_sid_year(sid: str) -> int:
    """Extract year from IBTrACS SID (e.g., '2005236N23285' → 2005)."""
    match = re.match(r"^(\d{4})", sid)
    if match:
        return int(match.group(1))
    return 0


def _find_tarball_url(sid: str, year: int) -> str | None:
    """
    Find the tar.gz URL for a storm on NCEI.
    Scans the year directory listing for a file containing the SID.
    """
    import requests

    year_url = f"{HURSAT_V06_BASE}/{year}/"

    try:
        logger.info(f"HURSAT: listing {year_url}")
        resp = requests.get(year_url, timeout=20, headers=_HTTP_HEADERS)
        if resp.status_code != 200:
            logger.info(f"HURSAT: year listing returned HTTP {resp.status_code}")
            return None

        # Find tar.gz files matching this SID
        # Pattern: HURSAT_b1_v06_{SID}_{NAME}_c{DATE}.tar.gz
        pattern = rf'href="(HURSAT_b1_v06_{re.escape(sid)}_[^"]+\.tar\.gz)"'
        matches = re.findall(pattern, resp.text)

        if matches:
            tarball_url = year_url + matches[0]
            logger.info(f"HURSAT: found tarball {matches[0]}")
            return tarball_url

        logger.info(f"HURSAT: no tarball found for SID {sid} in {year_url}")
        return None

    except Exception as e:
        logger.error(f"HURSAT: error listing {year_url}: {e}")
        return None


def _extract_tarball(sid: str, tarball_url: str, storm_lon: float = 0.0) -> list:
    """
    Download a HURSAT tar.gz, extract NetCDF files to /tmp, return sorted list
    of (datetime_str, nc_path, satellite) tuples.
    Deduplicates frames at the same time from different satellites,
    preferring the satellite with the best viewing angle for storm_lon.
    """
    import requests

    try:
        logger.info(f"HURSAT: downloading {tarball_url}")
        resp = requests.get(tarball_url, timeout=120, headers=_HTTP_HEADERS,
                            stream=True)
        resp.raise_for_status()

        # Write to temp file
        tmp_tar = tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False)
        for chunk in resp.iter_content(chunk_size=1024 * 64):
            tmp_tar.write(chunk)
        tmp_tar.close()
        tar_size = os.path.getsize(tmp_tar.name)
        logger.info(f"HURSAT: downloaded {tar_size / 1024 / 1024:.1f} MB")

        # Extract .nc files to a temp directory
        extract_dir = tempfile.mkdtemp(prefix=f"hursat_{sid}_")

        with tarfile.open(tmp_tar.name, "r:gz") as tar:
            # Security: only extract .nc files, no path traversal
            nc_members = [
                m for m in tar.getmembers()
                if m.name.endswith(".nc") and not m.name.startswith("/")
                and ".." not in m.name
            ]
            logger.info(f"HURSAT: tar contains {len(nc_members)} .nc files")

            raw_frames = []
            for member in nc_members:
                # Extract to flat directory
                member.name = os.path.basename(member.name)
                tar.extract(member, path=extract_dir)
                nc_path = os.path.join(extract_dir, member.name)

                # Parse datetime from filename
                dt_str = _parse_datetime_from_filename(member.name)
                raw_frames.append((dt_str, nc_path))

        # Clean up tar file
        os.unlink(tmp_tar.name)

        # Sort by datetime
        raw_frames.sort(key=lambda x: x[0])

        # Deduplicate frames with same datetime from different satellites
        frames = _deduplicate_frames(raw_frames, storm_lon=storm_lon)
        logger.info(
            f"HURSAT: {len(raw_frames)} raw frames → {len(frames)} after dedup"
        )

        # Clean up skipped duplicate files
        kept_paths = {f[1] for f in frames}
        for _, nc_path in raw_frames:
            if nc_path not in kept_paths:
                try:
                    os.unlink(nc_path)
                except OSError:
                    pass

        # Cache extracted paths
        _evict_extracted_cache()
        _extracted_cache[sid] = frames
        if len(_extracted_cache) > _EXTRACTED_CACHE_MAX:
            _evict_extracted_cache()

        return frames

    except Exception as e:
        logger.error(f"HURSAT: failed to extract {tarball_url}: {e}")
        return []


def _evict_extracted_cache():
    """Evict oldest entry from extracted cache and clean up tmp files."""
    if len(_extracted_cache) >= _EXTRACTED_CACHE_MAX:
        old_sid, old_frames = _extracted_cache.popitem(last=False)
        for frame_tuple in old_frames:
            try:
                os.unlink(frame_tuple[1])  # nc_path is index 1
            except OSError:
                pass
        # Try to remove the directory
        if old_frames:
            try:
                os.rmdir(os.path.dirname(old_frames[0][1]))
            except OSError:
                pass
        gc.collect()
        logger.info(f"HURSAT: evicted cache for {old_sid}")


def _get_extracted_frames(sid: str, storm_lon: float = 0.0) -> list | None:
    """Get extracted frames for a storm, downloading if needed.
    storm_lon is used for satellite viewing angle selection during dedup."""
    if sid in _extracted_cache:
        _extracted_cache.move_to_end(sid)
        return _extracted_cache[sid]

    year = _parse_sid_year(sid)
    if year < HURSAT_START_YEAR or year > HURSAT_END_YEAR:
        return None

    tarball_url = _find_tarball_url(sid, year)
    if not tarball_url:
        return None

    frames = _extract_tarball(sid, tarball_url, storm_lon=storm_lon)
    return frames if frames else None


def _parse_datetime_from_filename(filename: str) -> str:
    """
    Extract datetime from HURSAT filename.
    Actual v06 format:
        {SID}.{NAME}.{YYYY}.{MM}.{DD}.{HHMM}.{...}.hursat-b1.v06.nc
        e.g. 1992230N11325.ANDREW.1992.08.16.1800.43.MET-4.022.hursat-b1.v06.nc
    """
    # Primary pattern: {SID}.{NAME}.{YYYY}.{MM}.{DD}.{HHMM}
    m = re.search(r'\.\d{4}\.(\d{2})\.(\d{2})\.(\d{4})\.', filename)
    if m:
        # Extract year from the 4-digit sequence before the MM.DD.HHMM
        ym = re.search(r'\.(\d{4})\.(\d{2})\.(\d{2})\.(\d{4})\.', filename)
        if ym:
            yyyy, mm, dd, hhmm = ym.group(1), ym.group(2), ym.group(3), ym.group(4)
            return f"{yyyy}-{mm}-{dd}T{hhmm[:2]}:{hhmm[2:]}:00"

    # Fallback pattern: d{YYYYMMDD}_s{HHMMSS}
    m = re.search(r'd(\d{8})_s(\d{6})', filename)
    if m:
        d, t = m.group(1), m.group(2)
        return f"{d[:4]}-{d[4:6]}-{d[6:8]}T{t[:2]}:{t[2:4]}:{t[4:6]}"

    # Fallback: any 8+ digit sequence that looks like a date
    m = re.search(r'(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})', filename)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}T{m.group(4)}:{m.group(5)}:00"

    return filename


def _parse_satellite_from_filename(filename: str) -> str:
    """
    Extract satellite name from HURSAT filename.
    Format: {SID}.{NAME}.{YYYY}.{MM}.{DD}.{HHMM}.{num}.{SATELLITE}.{num}.hursat-b1.v06.nc
    e.g. 1992230N11325.ANDREW.1992.08.22.0300.59.GOE-7.053.hursat-b1.v06.nc → "GOE-7"
    """
    # Match satellite field: letter(s) + optional dash + number, between two dot-number segments
    m = re.search(r'\.\d{4}\.\d{2}\.\d{2}\.\d{4}\.\d+\.([A-Z][\w-]+)\.\d+\.hursat', filename)
    if m:
        return m.group(1)
    return ""


# Known geostationary satellite sub-point longitudes (degrees East).
# Used to pick the satellite with the best viewing angle for a given storm.
_SAT_SUBLON = {
    # GOES-East series (~75°W = -75°)
    "GOE-8": -75, "GOE-12": -75, "GOE-13": -75, "GOE-14": -75, "GOE-16": -75,
    # GOES-West series (~137°W = -137°)
    "GOE-7": -112,  # GOES-7 drifted; was ~112°W in early 1990s
    "GOE-9": -135, "GOE-10": -135, "GOE-11": -135, "GOE-15": -135, "GOE-17": -137,
    # Meteosat (0° or 63°E for Indian Ocean)
    "MET-2": 0, "MET-3": 0, "MET-4": 0, "MET-5": 0, "MET-7": 0,
    "MET-8": 0, "MET-9": 0, "MET-10": 0, "MET-11": 0,
    # Meteosat Indian Ocean (IODC at ~63°E)
    "MET-6": 63, "MET-I7": 57,
    # GMS / MTSAT / Himawari (~140°E)
    "GMS-1": 140, "GMS-2": 140, "GMS-3": 140, "GMS-4": 140, "GMS-5": 140,
    "MTS-1": 140, "MTS-2": 140,
    "HIM-8": 140, "HIM-9": 140,
}

# Fallback sub-point by satellite prefix (for unrecognized specific IDs)
_SAT_PREFIX_SUBLON = {
    "GOE": -75,   # Default GOES → East position
    "GMS": 140,
    "MTS": 140,
    "HIM": 140,
    "MET": 0,
}


def _get_sat_sublon(sat_name: str) -> float | None:
    """Get approximate sub-satellite-point longitude for a satellite."""
    if sat_name in _SAT_SUBLON:
        return _SAT_SUBLON[sat_name]
    prefix = sat_name[:3].upper() if sat_name else ""
    return _SAT_PREFIX_SUBLON.get(prefix)


def _viewing_angle_score(sat_name: str, storm_lon: float) -> float:
    """
    Return a score representing how far the satellite is from the storm.
    Lower = better viewing angle (satellite is closer to being overhead).

    Uses great-circle-like longitude difference on the equator as proxy.
    Falls back to a large penalty if satellite position is unknown.
    """
    sublon = _get_sat_sublon(sat_name)
    if sublon is None:
        return 999.0
    # Longitude difference (handle wrap-around)
    diff = abs(storm_lon - sublon)
    if diff > 180:
        diff = 360 - diff
    return diff


def _deduplicate_frames(frames: list, storm_lon: float = 0.0) -> list:
    """
    Deduplicate HURSAT frames that share the same datetime but come from
    different satellites (e.g., GOE-7 and MET-4 both at 0300 UTC).

    Keeps the satellite with the best viewing angle for the storm's longitude
    (smallest longitude difference between satellite sub-point and storm center).
    Also stores satellite name in the tuple for metadata.

    Input: list of (datetime_str, nc_path) tuples
    Output: list of (datetime_str, nc_path, satellite) tuples, deduplicated
    """
    from collections import defaultdict

    # Group by datetime
    by_time = defaultdict(list)
    for dt_str, nc_path in frames:
        sat = _parse_satellite_from_filename(os.path.basename(nc_path))
        by_time[dt_str].append((dt_str, nc_path, sat))

    deduped = []
    for dt_str in sorted(by_time.keys()):
        candidates = by_time[dt_str]
        if len(candidates) == 1:
            deduped.append(candidates[0])
        else:
            # Pick the satellite closest to the storm (best viewing angle)
            candidates.sort(key=lambda x: _viewing_angle_score(x[2], storm_lon))
            chosen = candidates[0]
            skipped_info = [
                f"{c[2]}({_viewing_angle_score(c[2], storm_lon):.0f}°)"
                for c in candidates[1:]
            ]
            logger.info(
                f"HURSAT dedup: {dt_str} — kept {chosen[2]} "
                f"(Δlon={_viewing_angle_score(chosen[2], storm_lon):.0f}°), "
                f"skipped {skipped_info}"
            )
            deduped.append(chosen)

    return deduped


def _load_frame_from_nc(nc_path: str):
    """
    Open a local NetCDF file and return (frame_2d, bounds_dict).

    bounds_dict has keys: south, north, west, east (in degrees).
    HURSAT-B1 v06 files have 'latitude' and 'longitude' coordinate variables
    on a 301×301 storm-centered grid (~8km resolution ≈ ~12° box).
    """
    import xarray as xr

    try:
        ds = xr.open_dataset(nc_path, engine="h5netcdf")

        # Find the IR variable
        var_name = None
        for candidate in ["irwin_cdr", "irwin", "irwin_2", "Tb", "IRWIN"]:
            if candidate in ds:
                var_name = candidate
                break

        if var_name is None:
            for v in ds.data_vars:
                if ds[v].ndim >= 2:
                    var_name = v
                    break

        if var_name is None:
            ds.close()
            return None, None

        data = ds[var_name]
        if "htime" in data.dims:
            frame = data.isel(htime=0).values
        elif "time" in data.dims:
            frame = data.isel(time=0).values
        else:
            frame = data.values

        # Extract geographic bounds and determine latitude orientation
        bounds = None
        lat_var = None
        lon_var = None
        lat_increasing = True  # default assumption

        # HURSAT-B1 v06 uses 'latitude' and 'longitude' (1D or 2D)
        for lat_cand in ["latitude", "lat", "Latitude"]:
            if lat_cand in ds.coords or lat_cand in ds:
                lat_var = lat_cand
                break
        for lon_cand in ["longitude", "lon", "Longitude"]:
            if lon_cand in ds.coords or lon_cand in ds:
                lon_var = lon_cand
                break

        if lat_var and lon_var:
            try:
                lats = ds[lat_var].values
                lons = ds[lon_var].values

                logger.info(
                    f"HURSAT frame: {os.path.basename(nc_path)}, "
                    f"lat shape={lats.shape}, lon shape={lons.shape}, "
                    f"frame shape={frame.shape}"
                )

                # Determine latitude order (1D array or first column of 2D)
                if lats.ndim == 1:
                    lat_1d = lats
                elif lats.ndim == 2:
                    lat_1d = lats[:, lats.shape[1] // 2]  # center column
                else:
                    lat_1d = lats.ravel()

                finite_lats = lat_1d[np.isfinite(lat_1d)]
                if len(finite_lats) >= 2:
                    lat_increasing = finite_lats[-1] > finite_lats[0]
                    logger.info(
                        f"  lat[0]={finite_lats[0]:.2f}, "
                        f"lat[-1]={finite_lats[-1]:.2f}, "
                        f"increasing={lat_increasing}"
                    )

                # Handle NaN values
                lats_valid = lats[np.isfinite(lats)]
                lons_valid = lons[np.isfinite(lons)]
                if len(lats_valid) > 0 and len(lons_valid) > 0:
                    bounds = {
                        "south": float(np.min(lats_valid)),
                        "north": float(np.max(lats_valid)),
                        "west": float(np.min(lons_valid)),
                        "east": float(np.max(lons_valid)),
                    }
                    logger.info(
                        f"  bounds: S={bounds['south']:.2f} N={bounds['north']:.2f} "
                        f"W={bounds['west']:.2f} E={bounds['east']:.2f}"
                    )

                    # Log frame data stats for sanity check
                    valid_frame = frame[np.isfinite(frame)]
                    if len(valid_frame) > 0:
                        logger.info(
                            f"  Tb stats: min={np.min(valid_frame):.1f}, "
                            f"max={np.max(valid_frame):.1f}, "
                            f"mean={np.mean(valid_frame):.1f}, "
                            f"NaN%={100*(1 - len(valid_frame)/frame.size):.0f}%"
                        )
            except Exception as e:
                logger.warning(f"Could not extract bounds from {nc_path}: {e}")

        # Ensure frame is oriented with north at top (row 0 = north)
        # Leaflet imageOverlay expects top-left = NW corner
        if lat_increasing:
            # First row = south → flip so first row = north
            frame = frame[::-1]
            logger.info("  → Flipped frame (lat was increasing)")
        else:
            logger.info("  → No flip needed (lat already decreasing/north-at-top)")

        ds.close()
        return frame, bounds

    except Exception as e:
        logger.warning(f"Failed to load {nc_path}: {e}")
        return None, None


# ── Endpoints ────────────────────────────────────────────────

@router.get("/hursat/meta")
def hursat_meta(
    sid: str = Query(..., description="IBTrACS storm ID"),
    storm_lon: float = Query(0.0, description="Storm longitude for satellite selection"),
):
    """Return HURSAT frame metadata for a storm."""
    # Check cache
    if sid in _meta_cache:
        _meta_cache.move_to_end(sid)
        return JSONResponse(
            _meta_cache[sid],
            headers={"Cache-Control": "public, max-age=86400, immutable"},
        )

    year = _parse_sid_year(sid)
    if year < HURSAT_START_YEAR or year > HURSAT_END_YEAR:
        result = {
            "sid": sid,
            "available": False,
            "reason": f"HURSAT-B1 coverage is {HURSAT_START_YEAR}–{HURSAT_END_YEAR}",
        }
        return JSONResponse(result)

    frames = _get_extracted_frames(sid, storm_lon=storm_lon)
    if not frames:
        result = {"sid": sid, "available": False, "reason": "Data not found on NCEI"}
        return JSONResponse(result)

    frame_list = []
    for i, frame_tuple in enumerate(frames):
        entry = {"index": i, "datetime": frame_tuple[0]}
        if len(frame_tuple) > 2 and frame_tuple[2]:
            entry["satellite"] = frame_tuple[2]
        frame_list.append(entry)

    result = {
        "sid": sid,
        "available": True,
        "n_frames": len(frames),
        "frames": frame_list,
    }

    # Cache metadata
    _meta_cache[sid] = result
    if len(_meta_cache) > _META_CACHE_MAX:
        _meta_cache.popitem(last=False)

    return JSONResponse(
        result,
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


@router.get("/hursat/frame")
def hursat_frame(
    sid: str = Query(..., description="IBTrACS storm ID"),
    frame_idx: int = Query(..., ge=0, description="Frame index (0-based)"),
):
    """Return a rendered IR frame as base64 PNG."""
    cache_key = (sid, frame_idx)

    # Check in-memory frame cache
    if cache_key in _frame_cache:
        _frame_cache.move_to_end(cache_key)
        return JSONResponse(
            _frame_cache[cache_key],
            headers={
                "Cache-Control": "public, max-age=86400, immutable",
                "X-Cache": "HIT",
            },
        )

    # Check GCS persistent cache
    gcs_result = _gcs_get_frame(sid, frame_idx, source="hursat")
    if gcs_result is not None:
        _frame_cache[cache_key] = gcs_result
        if len(_frame_cache) > _FRAME_CACHE_MAX:
            _frame_cache.popitem(last=False)
        return JSONResponse(
            gcs_result,
            headers={
                "Cache-Control": "public, max-age=86400, immutable",
                "X-Cache": "GCS-HIT",
            },
        )

    # storm_lon=0.0 is fine here — frames should already be cached from meta call
    frames = _get_extracted_frames(sid, storm_lon=0.0)
    if not frames:
        raise HTTPException(status_code=404, detail="HURSAT data not found")

    if frame_idx >= len(frames):
        raise HTTPException(
            status_code=404,
            detail=f"Frame index {frame_idx} out of range (0-{len(frames)-1})",
        )

    frame_tuple = frames[frame_idx]
    dt_str, nc_path = frame_tuple[0], frame_tuple[1]
    satellite = frame_tuple[2] if len(frame_tuple) > 2 else ""
    nc_filename = os.path.basename(nc_path)

    logger.info(
        f"HURSAT frame request: idx={frame_idx}, dt={dt_str}, "
        f"sat={satellite}, file={nc_filename}"
    )

    frame_2d, bounds = _load_frame_from_nc(nc_path)
    if frame_2d is None:
        raise HTTPException(status_code=500, detail="Failed to read frame data")

    # Path 1: send raw Tb as uint8 for client-side colormap rendering
    tb_encoded = _encode_tb_uint8(frame_2d)

    result = {
        "sid": sid,
        "frame_idx": frame_idx,
        "datetime": dt_str,
        "nc_file": nc_filename,
        **tb_encoded,
    }
    if satellite:
        result["satellite"] = satellite
    if bounds:
        result["bounds"] = bounds

    # Cache rendered frame (in-memory + GCS persistent)
    _frame_cache[cache_key] = result
    if len(_frame_cache) > _FRAME_CACHE_MAX:
        _frame_cache.popitem(last=False)
        gc.collect()
    _gcs_put_frame(sid, frame_idx, result, source="hursat")

    return JSONResponse(
        result,
        headers={
            "Cache-Control": "public, max-age=86400, immutable",
            "X-Cache": "MISS",
        },
    )


# ══════════════════════════════════════════════════════════════
#  MergIR Data Access (2000–present)
# ══════════════════════════════════════════════════════════════

# MergIR caches
_mergir_meta_cache: OrderedDict = OrderedDict()
_MERGIR_META_CACHE_MAX = 100

# Box size for storm-centered subset (degrees from center)
MERGIR_HALF_DOMAIN = 10.0  # 10° each direction = 20°×20° box — fills Leaflet panel


def _mergir_opendap_file_url(dt: datetime) -> str:
    """
    Build OPeNDAP URL for the MergIR file covering a given datetime.
    Each file has two half-hourly grids and is keyed by the truncated hour.

    Pattern: {BASE}/{YYYY}/{DOY:03d}/merg_{YYYYMMDDHH}_4km-pixel.nc4
    """
    jday = dt.timetuple().tm_yday
    time_str = dt.strftime("%Y%m%d%H")
    return (
        f"{MERGIR_OPENDAP}/{dt.year}/{jday:03d}/"
        f"merg_{time_str}_4km-pixel.nc4"
    )


def _build_mergir_frame_list(track_points: list) -> list:
    """
    Build a list of MergIR frames from track points.

    track_points: list of {"t": "YYYY-MM-DDTHH:MM", "la": lat, "lo": lon}
    Returns: list of {"datetime": str, "lat": float, "lon": float}

    We sample at 3-hourly intervals (synoptic hours) to keep frame counts
    manageable while providing good temporal coverage.
    """
    frames = []
    seen_times = set()

    for pt in track_points:
        if not pt.get("t") or not pt.get("la") or not pt.get("lo"):
            continue

        try:
            dt = datetime.fromisoformat(pt["t"].replace("Z", "+00:00").split("+")[0])
        except (ValueError, AttributeError):
            continue

        # Round to nearest 3-hour interval for consistent sampling
        hour_3 = (dt.hour // 3) * 3
        dt_rounded = dt.replace(hour=hour_3, minute=0, second=0, microsecond=0)
        time_key = dt_rounded.strftime("%Y%m%d%H")

        if time_key in seen_times:
            continue
        seen_times.add(time_key)

        frames.append({
            "datetime": dt_rounded.strftime("%Y-%m-%dT%H:%M:00"),
            "lat": float(pt["la"]),
            "lon": float(pt["lo"]),
        })

    frames.sort(key=lambda f: f["datetime"])
    return frames


def _find_nearest_half_hour(target_dt, ir_times):
    """
    Find the MergIR time index closest to target_dt.
    Each file has two half-hourly grids.
    Returns (time_index, time_diff_minutes).
    """
    import pandas as pd

    best_idx = 0
    best_diff = float("inf")
    for i, t in enumerate(ir_times):
        ts = pd.Timestamp(t)
        diff_min = abs((target_dt - ts).total_seconds()) / 60.0
        if diff_min < best_diff:
            best_diff = diff_min
            best_idx = i
    return best_idx, best_diff


# Earthdata session (reused across requests for cookie persistence)
_earthdata_session = None


def _get_earthdata_session():
    """Get or create a requests session with Earthdata credentials."""
    global _earthdata_session
    if _earthdata_session is not None:
        return _earthdata_session

    import requests

    session = requests.Session()

    if EARTHDATA_USER and EARTHDATA_PASS:
        session.auth = (EARTHDATA_USER, EARTHDATA_PASS)
    elif EARTHDATA_TOKEN:
        session.headers.update({"Authorization": f"Bearer {EARTHDATA_TOKEN}"})

    _earthdata_session = session
    return session


def _mergir_direct_file_url(dt: datetime) -> str:
    """
    Build direct download URL for the MergIR file covering a given datetime.
    Pattern: {BASE_DATA}/{YYYY}/{DOY:03d}/merg_{YYYYMMDDHH}_4km-pixel.nc4
    """
    jday = dt.timetuple().tm_yday
    time_str = dt.strftime("%Y%m%d%H")
    return (
        f"https://disc2.gesdisc.eosdis.nasa.gov/data/MERGED_IR/GPM_MERGIR.1"
        f"/{dt.year}/{jday:03d}/merg_{time_str}_4km-pixel.nc4"
    )


def _mergir_subset_url(dt: datetime, center_lat: float, center_lon: float) -> str:
    """
    Build OPeNDAP subset URL that returns only the geographic subset we need.
    Appends .nc4 suffix + constraint expression to request server-side subsetting.
    This downloads ~1-2 MB instead of ~130 MB for the full file.

    GES DISC OPeNDAP supports: {opendap_url}.nc4?Tb[time][lat_start:lat_end][lon_start:lon_end]
    MergIR grid: lat -60 to 60 (0.03636° spacing, ~3300 pts), lon -180 to 180 (~9896 pts)
    """
    jday = dt.timetuple().tm_yday
    time_str = dt.strftime("%Y%m%d%H")
    base = (
        f"{MERGIR_OPENDAP}/{dt.year}/{jday:03d}/"
        f"merg_{time_str}_4km-pixel.nc4"
    )

    # Convert lat/lon bounds to grid indices
    # MergIR: lat from -60 to 60 in ~3301 steps, lon from -180 to 180 in ~9896 steps
    # Add 2° margin to avoid edge effects from grid index rounding;
    # actual subsetting to exact domain uses .sel() later
    margin = 2.0
    lat_min = center_lat - MERGIR_HALF_DOMAIN - margin
    lat_max = center_lat + MERGIR_HALF_DOMAIN + margin
    lon_min = center_lon - MERGIR_HALF_DOMAIN - margin
    lon_max = center_lon + MERGIR_HALF_DOMAIN + margin

    # Clamp to grid bounds
    lat_min = max(lat_min, -60.0)
    lat_max = min(lat_max, 60.0)
    lon_min = max(lon_min, -180.0)
    lon_max = min(lon_max, 180.0)

    # Grid spacing: ~0.036364° for lat, ~0.036378° for lon
    lat_idx_min = int((lat_min + 60.0) / 0.036364)
    lat_idx_max = min(int((lat_max + 60.0) / 0.036364), 3300)
    lon_idx_min = int((lon_min + 180.0) / 0.036378)
    lon_idx_max = min(int((lon_max + 180.0) / 0.036378), 9895)

    # Build constraint expression for server-side subsetting
    # Request both time steps (usually 2 per file), subset lat/lon
    constraint = (
        f"Tb[0:1][{lat_idx_min}:{lat_idx_max}][{lon_idx_min}:{lon_idx_max}],"
        f"lat[{lat_idx_min}:{lat_idx_max}],"
        f"lon[{lon_idx_min}:{lon_idx_max}],"
        f"time[0:1]"
    )

    return f"{base}.nc4?{constraint}"


def _load_mergir_subset(target_dt: datetime, center_lat: float, center_lon: float):
    """
    Fetch a single MergIR Tb snapshot, cropped to a
    MERGIR_HALF_DOMAIN degree box around (center_lat, center_lon).

    Uses requests with Earthdata session auth to download the file,
    then opens locally with xarray for subsetting.
    Downloads to temp file, extracts subset, deletes temp file.

    Returns (2D numpy array of Tb, bounds_dict) or (None, None) on failure.
    bounds_dict has keys: south, north, west, east — extracted from actual data.
    """
    import xarray as xr
    from datetime import timedelta

    # Acquire semaphore to limit concurrent loads (OOM protection)
    if not _data_load_semaphore.acquire(timeout=60):
        logger.warning("MergIR: semaphore timeout — too many concurrent loads")
        return None, None

    try:
        return _load_mergir_subset_inner(target_dt, center_lat, center_lon, xr, timedelta)
    finally:
        _data_load_semaphore.release()


def _load_mergir_subset_inner(target_dt, center_lat, center_lon, xr, timedelta):
    session = _get_earthdata_session()
    if not session:
        logger.warning("MergIR: no Earthdata session available")
        return None, None

    file_dt = target_dt.replace(minute=0, second=0, microsecond=0)

    for attempt_dt in [file_dt, file_dt + timedelta(hours=1)]:
        # Try full file download (more reliable than OPeNDAP subset)
        full_url = _mergir_direct_file_url(attempt_dt)
        # OPeNDAP subset as fallback
        subset_url = _mergir_subset_url(attempt_dt, center_lat, center_lon)

        # Check circuit breaker before attempting NASA requests
        if _mergir_circuit_is_open():
            logger.info("MergIR: circuit breaker open, skipping NASA fetch")
            return None, None

        for url_label, url in [("subset", subset_url), ("full", full_url)]:
            tmp = None
            try:
                # Pace requests to avoid NASA GES DISC throttling / 503s
                _mergir_rate_limit()
                logger.info(f"MergIR: downloading {url_label} from {url[:120]}...")
                # timeout=(connect, read): 15s to connect, 30s per chunk read.
                # The old timeout=90 only covered connection with stream=True,
                # allowing iter_content to hang indefinitely on slow NASA responses.
                resp = session.get(url, timeout=(15, 30), allow_redirects=True, stream=True)

                if resp.status_code in (401, 403):
                    logger.warning(
                        f"MergIR: auth failed ({resp.status_code}), "
                        f"resetting session"
                    )
                    resp.close()
                    global _earthdata_session
                    _earthdata_session = None
                    session = _get_earthdata_session()
                    _mergir_record_failure()
                    continue

                # Detect Earthdata login page redirect — if the response is
                # HTML instead of NetCDF, the token is likely expired.
                content_type = resp.headers.get("content-type", "")
                if "text/html" in content_type:
                    logger.warning(
                        f"MergIR: got HTML response for {url_label} — "
                        f"likely expired Earthdata token (redirected to login page)"
                    )
                    resp.close()
                    _earthdata_session = None
                    session = _get_earthdata_session()
                    _mergir_record_failure()
                    continue

                if resp.status_code != 200:
                    logger.info(f"MergIR: HTTP {resp.status_code} for {url_label}")
                    resp.close()
                    _mergir_record_failure()
                    continue

                # Stream to temp file (avoid buffering 130 MB in memory)
                tmp = tempfile.NamedTemporaryFile(suffix=".nc4", delete=False)
                file_size = 0
                for chunk in resp.iter_content(chunk_size=256 * 1024):
                    tmp.write(chunk)
                    file_size += len(chunk)
                tmp.close()
                resp.close()
                file_size_mb = file_size / 1024 / 1024
                logger.info(f"MergIR: downloaded {url_label} {file_size_mb:.1f} MB")

            except Exception as e:
                logger.warning(f"MergIR: {url_label} download failed: {e}")
                _mergir_record_failure()
                if tmp and hasattr(tmp, 'name') and os.path.exists(tmp.name):
                    try:
                        os.unlink(tmp.name)
                    except OSError:
                        pass
                continue

            try:
                ds = xr.open_dataset(tmp.name, engine="h5netcdf")

                ir_times = ds["time"].values
                tidx, tdiff = _find_nearest_half_hour(target_dt, ir_times)

                if tdiff > 20.0:
                    ds.close()
                    os.unlink(tmp.name)
                    continue

                # Always do spatial subsetting from the dataset to get
                # correct lat/lon bounds (even for OPeNDAP subsets)
                lat_min = center_lat - MERGIR_HALF_DOMAIN
                lat_max = center_lat + MERGIR_HALF_DOMAIN
                lon_min = center_lon - MERGIR_HALF_DOMAIN
                lon_max = center_lon + MERGIR_HALF_DOMAIN

                da = ds["Tb"].isel(time=tidx)

                # Subset spatially using coordinate selection
                da_sub = da.sel(
                    lat=slice(lat_min, lat_max),
                    lon=slice(lon_min, lon_max),
                )

                tb = da_sub.values
                actual_lats = da_sub.coords["lat"].values
                actual_lons = da_sub.coords["lon"].values

                ds.close()
                os.unlink(tmp.name)
                tmp = None

                if tb is not None and tb.size > 0 and len(actual_lats) > 1 and len(actual_lons) > 1:
                    # Extract actual bounds from coordinate arrays
                    actual_bounds = {
                        "south": float(np.min(actual_lats)),
                        "north": float(np.max(actual_lats)),
                        "west": float(np.min(actual_lons)),
                        "east": float(np.max(actual_lons)),
                    }
                    logger.info(
                        f"MergIR: got {tb.shape} subset for "
                        f"({center_lat:.1f}, {center_lon:.1f}), "
                        f"actual bounds: S={actual_bounds['south']:.2f} "
                        f"N={actual_bounds['north']:.2f} "
                        f"W={actual_bounds['west']:.2f} "
                        f"E={actual_bounds['east']:.2f}"
                    )

                    # Validate subset covers at least ~50% of requested domain.
                    # OPeNDAP subsets can sometimes return truncated data.
                    expected_range = 2 * MERGIR_HALF_DOMAIN  # 20°
                    actual_lat_range = actual_bounds["north"] - actual_bounds["south"]
                    actual_lon_range = actual_bounds["east"] - actual_bounds["west"]
                    if actual_lat_range < expected_range * 0.5 or actual_lon_range < expected_range * 0.5:
                        logger.warning(
                            f"MergIR: {url_label} subset too small "
                            f"({actual_lat_range:.1f}° lat × {actual_lon_range:.1f}° lon, "
                            f"expected ~{expected_range}°), trying next source"
                        )
                        continue

                    # Validate data completeness (fix strip/partial frame loading)
                    valid_frac = np.count_nonzero(np.isfinite(tb) & (tb > 0)) / tb.size
                    if valid_frac < 0.3:
                        logger.warning(
                            f"MergIR: {url_label} data too sparse "
                            f"({valid_frac:.0%} valid pixels), trying next source"
                        )
                        continue

                    # MergIR lat is ascending (south→north), flip so
                    # row 0 = north (as Leaflet imageOverlay expects)
                    _mergir_record_success()
                    # Use REQUESTED bounds (not actual) for frame-to-frame
                    # consistency — avoids jitter/cropping in animation.
                    # Actual vs requested differs by <0.5° (sub-pixel).
                    requested_bounds = {
                        "south": center_lat - MERGIR_HALF_DOMAIN,
                        "north": center_lat + MERGIR_HALF_DOMAIN,
                        "west": center_lon - MERGIR_HALF_DOMAIN,
                        "east": center_lon + MERGIR_HALF_DOMAIN,
                    }
                    return tb[::-1], requested_bounds

            except Exception as e:
                logger.warning(f"MergIR: {url_label} parse failed: {e}")
                if tmp:
                    try:
                        os.unlink(tmp.name)
                    except OSError:
                        pass
                continue

    logger.warning(f"MergIR: no data found for {target_dt}")
    _mergir_record_failure()
    return None, None


# ══════════════════════════════════════════════════════════════
#  GridSat-B1 Data Access (1980–2024)
# ══════════════════════════════════════════════════════════════

def _gridsat_thredds_url(dt: datetime) -> str:
    """
    Build THREDDS OPeNDAP URL for the GridSat-B1 file at a given datetime.
    Pattern: {BASE}/{YYYY}/GRIDSAT-B1.{YYYY}.{MM}.{DD}.{HH}.v02r01.nc
    Files are 3-hourly at 00, 03, 06, 09, 12, 15, 18, 21 UTC.
    """
    # Round to nearest 3-hour interval
    hour_3 = (dt.hour // 3) * 3
    dt_3h = dt.replace(hour=hour_3, minute=0, second=0, microsecond=0)
    return (
        f"{GRIDSAT_THREDDS}/{dt_3h.year}/"
        f"GRIDSAT-B1.{dt_3h.year}.{dt_3h.month:02d}.{dt_3h.day:02d}"
        f".{dt_3h.hour:02d}.v02r01.nc"
    )


def _gridsat_direct_url(dt: datetime) -> str:
    """
    Build direct HTTPS download URL for GridSat-B1 file.
    Pattern: {BASE}/{YYYY}/GRIDSAT-B1.{YYYY}.{MM}.{DD}.{HH}.v02r01.nc
    """
    hour_3 = (dt.hour // 3) * 3
    dt_3h = dt.replace(hour=hour_3, minute=0, second=0, microsecond=0)
    return (
        f"{GRIDSAT_DIRECT}/{dt_3h.year}/"
        f"GRIDSAT-B1.{dt_3h.year}.{dt_3h.month:02d}.{dt_3h.day:02d}"
        f".{dt_3h.hour:02d}.v02r01.nc"
    )


def _load_gridsat_subset(target_dt: datetime, center_lat: float, center_lon: float):
    """
    Fetch a single GridSat-B1 Tb snapshot, cropped to a
    GRIDSAT_HALF_DOMAIN degree box around (center_lat, center_lon).

    Tries OPeNDAP (THREDDS) first for efficient server-side subsetting,
    falls back to direct HTTPS download if needed.

    GridSat-B1 specs:
      - Variable: irwin_cdr (CDR-quality IR window ~11μm BT)
      - Lat: -70 to 70, 0.07° spacing (~2001 points)
      - Lon: -180 to 180, 0.07° spacing (~5143 points)
      - Time: single time step per file (3-hourly)

    Returns (2D numpy array of Tb, bounds_dict) or (None, None) on failure.
    """
    import requests
    import xarray as xr

    # Acquire semaphore to limit concurrent loads (OOM protection)
    if not _data_load_semaphore.acquire(timeout=60):
        logger.warning("GridSat: semaphore timeout — too many concurrent loads")
        return None, None

    try:
        return _load_gridsat_subset_inner(target_dt, center_lat, center_lon, requests, xr)
    finally:
        _data_load_semaphore.release()


def _load_gridsat_subset_inner(target_dt, center_lat, center_lon, requests_mod, xr):
    # Round to nearest 3-hour interval
    hour_3 = (target_dt.hour // 3) * 3
    file_dt = target_dt.replace(hour=hour_3, minute=0, second=0, microsecond=0)

    thredds_url = _gridsat_thredds_url(file_dt)
    direct_url = _gridsat_direct_url(file_dt)

    # Spatial bounds for subsetting
    lat_min = center_lat - GRIDSAT_HALF_DOMAIN
    lat_max = center_lat + GRIDSAT_HALF_DOMAIN
    lon_min = center_lon - GRIDSAT_HALF_DOMAIN
    lon_max = center_lon + GRIDSAT_HALF_DOMAIN

    # Clamp to GridSat domain
    lat_min = max(lat_min, -70.0)
    lat_max = min(lat_max, 70.0)
    lon_min = max(lon_min, -180.0)
    lon_max = min(lon_max, 180.0)

    # Strategy 1: OPeNDAP via THREDDS (efficient server-side subsetting)
    # Requires the netCDF4 C library for DAP protocol support
    try:
        import netCDF4 as _nc4  # noqa: F401 — needed by xarray's netcdf4 engine
        logger.info(f"GridSat: trying OPeNDAP {thredds_url[:100]}...")
        ds = xr.open_dataset(thredds_url, engine="netcdf4")

        # Find the IR window variable
        var_name = None
        for candidate in ["irwin_cdr", "irwin", "Tb", "IRWIN"]:
            if candidate in ds:
                var_name = candidate
                break
        if var_name is None:
            for v in ds.data_vars:
                if ds[v].ndim >= 2:
                    var_name = v
                    break

        if var_name is None:
            ds.close()
            logger.warning("GridSat: no IR variable found in dataset")
        else:
            da = ds[var_name]
            # Select first time step if time dimension exists
            if "time" in da.dims:
                da = da.isel(time=0)

            # Spatial subset
            da_sub = da.sel(
                lat=slice(lat_min, lat_max),
                lon=slice(lon_min, lon_max),
            )

            tb = da_sub.values
            actual_lats = da_sub.coords["lat"].values
            actual_lons = da_sub.coords["lon"].values
            ds.close()

            if tb is not None and tb.size > 0 and len(actual_lats) > 1 and len(actual_lons) > 1:
                actual_bounds = {
                    "south": float(np.min(actual_lats)),
                    "north": float(np.max(actual_lats)),
                    "west": float(np.min(actual_lons)),
                    "east": float(np.max(actual_lons)),
                }

                # Validate coordinate coverage
                expected_range = 2 * GRIDSAT_HALF_DOMAIN
                actual_lat_range = actual_bounds["north"] - actual_bounds["south"]
                actual_lon_range = actual_bounds["east"] - actual_bounds["west"]
                if actual_lat_range < expected_range * 0.5 or actual_lon_range < expected_range * 0.5:
                    logger.warning(
                        f"GridSat: OPeNDAP subset too small "
                        f"({actual_lat_range:.1f}° × {actual_lon_range:.1f}°)"
                    )
                else:
                    # Validate data completeness (fix strip/partial loading)
                    valid_frac = np.count_nonzero(np.isfinite(tb) & (tb > 0)) / tb.size
                    if valid_frac < 0.3:
                        logger.warning(
                            f"GridSat: OPeNDAP data too sparse "
                            f"({valid_frac:.0%} valid pixels), trying direct download"
                        )
                    else:
                        logger.info(
                            f"GridSat: got {tb.shape} subset, "
                            f"{valid_frac:.0%} valid, bounds: "
                            f"S={actual_bounds['south']:.2f} N={actual_bounds['north']:.2f} "
                            f"W={actual_bounds['west']:.2f} E={actual_bounds['east']:.2f}"
                        )
                        # GridSat lat is ascending (-70 to 70), flip to north-at-top
                        if len(actual_lats) >= 2 and actual_lats[-1] > actual_lats[0]:
                            tb = tb[::-1]
                        # Use requested bounds for animation consistency
                        requested_bounds = {
                            "south": center_lat - GRIDSAT_HALF_DOMAIN,
                            "north": center_lat + GRIDSAT_HALF_DOMAIN,
                            "west": center_lon - GRIDSAT_HALF_DOMAIN,
                            "east": center_lon + GRIDSAT_HALF_DOMAIN,
                        }
                        return tb, requested_bounds

    except Exception as e:
        logger.warning(f"GridSat: OPeNDAP failed: {e}")

    # Strategy 2: Direct HTTPS download + local subsetting
    tmp = None
    try:
        logger.info(f"GridSat: downloading full file {direct_url[:100]}...")
        ncei = _get_ncei_session()
        resp = ncei.get(direct_url, timeout=120, stream=True)
        if resp.status_code != 200:
            logger.info(f"GridSat: HTTP {resp.status_code} for direct download")
            resp.close()
            return None, None

        # Stream to disk instead of buffering entire file in memory
        tmp = tempfile.NamedTemporaryFile(suffix=".nc", delete=False)
        file_size = 0
        for chunk in resp.iter_content(chunk_size=256 * 1024):
            tmp.write(chunk)
            file_size += len(chunk)
        tmp.close()
        resp.close()
        logger.info(f"GridSat: streamed {file_size / 1024 / 1024:.1f} MB to disk")

        ds = xr.open_dataset(tmp.name, engine="h5netcdf",
                             decode_times=False)

        var_name = None
        for candidate in ["irwin_cdr", "irwin", "Tb", "IRWIN"]:
            if candidate in ds:
                var_name = candidate
                break
        if var_name is None:
            for v in ds.data_vars:
                if ds[v].ndim >= 2:
                    var_name = v
                    break

        if var_name is None:
            ds.close()
            os.unlink(tmp.name)
            return None, None

        da = ds[var_name]
        if "time" in da.dims:
            da = da.isel(time=0)

        da_sub = da.sel(
            lat=slice(lat_min, lat_max),
            lon=slice(lon_min, lon_max),
        )

        tb = da_sub.values
        actual_lats = da_sub.coords["lat"].values
        actual_lons = da_sub.coords["lon"].values
        ds.close()
        os.unlink(tmp.name)
        tmp = None

        if tb is not None and tb.size > 0 and len(actual_lats) > 1 and len(actual_lons) > 1:
            actual_bounds = {
                "south": float(np.min(actual_lats)),
                "north": float(np.max(actual_lats)),
                "west": float(np.min(actual_lons)),
                "east": float(np.max(actual_lons)),
            }

            # Validate data completeness
            valid_frac = np.count_nonzero(np.isfinite(tb) & (tb > 0)) / tb.size
            if valid_frac < 0.3:
                logger.warning(
                    f"GridSat: direct download data too sparse ({valid_frac:.0%} valid)"
                )
                return None, None

            # Flip to north-at-top if needed
            if len(actual_lats) >= 2 and actual_lats[-1] > actual_lats[0]:
                tb = tb[::-1]
            # Use requested bounds for animation consistency
            requested_bounds = {
                "south": center_lat - GRIDSAT_HALF_DOMAIN,
                "north": center_lat + GRIDSAT_HALF_DOMAIN,
                "west": center_lon - GRIDSAT_HALF_DOMAIN,
                "east": center_lon + GRIDSAT_HALF_DOMAIN,
            }
            return tb, requested_bounds

    except Exception as e:
        logger.warning(f"GridSat: direct download failed: {e}")
        if tmp:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    return None, None


# ── Unified IR Endpoints ──────────────────────────────────────

@router.get("/ir/meta")
def ir_meta(
    sid: str = Query(..., description="IBTrACS storm ID"),
    track: str = Query("", description="JSON-encoded track points array"),
    storm_lon: float = Query(0.0, description="Storm longitude for satellite selection"),
):
    """
    Return IR frame metadata for a storm, auto-selecting source.

    Priority: MergIR (2000+) > GridSat (1980-2024) > HURSAT (1978-2015 fallback).
    For MergIR/GridSat, track data is needed to know storm positions.
    """
    import json as json_mod

    cache_key = f"ir_{sid}"
    if cache_key in _mergir_meta_cache:
        _mergir_meta_cache.move_to_end(cache_key)
        return JSONResponse(
            _mergir_meta_cache[cache_key],
            headers={"Cache-Control": "public, max-age=3600"},
        )

    year = _parse_sid_year(sid)

    # Determine source — priority: MergIR (2000+) > GridSat (1980-2024) > HURSAT (fallback)
    source = None
    _earthdata_configured = bool(EARTHDATA_TOKEN or EARTHDATA_USER)
    if year >= MERGIR_START_YEAR and _earthdata_configured:
        source = "mergir"
    elif GRIDSAT_START_YEAR <= year <= GRIDSAT_END_YEAR:
        source = "gridsat"
    elif HURSAT_START_YEAR <= year <= HURSAT_END_YEAR:
        source = "hursat"
    elif year >= MERGIR_START_YEAR and not _earthdata_configured:
        # MergIR available but no credentials; try GridSat if in range
        if GRIDSAT_START_YEAR <= year <= GRIDSAT_END_YEAR:
            source = "gridsat"
        else:
            result = {
                "sid": sid, "available": False, "source": "mergir",
                "reason": "MergIR requires Earthdata credentials (not configured)",
            }
            return JSONResponse(result)
    else:
        result = {
            "sid": sid, "available": False,
            "reason": f"No IR data available for year {year}",
        }
        return JSONResponse(result)

    # Handle HURSAT path
    if source == "hursat":
        frames = _get_extracted_frames(sid, storm_lon=storm_lon)
        if not frames:
            result = {
                "sid": sid, "available": False, "source": "hursat",
                "reason": "HURSAT data not found on NCEI",
            }
            return JSONResponse(result)

        frame_list = [
            {
                "index": i, "datetime": ft[0],
                **({"satellite": ft[2]} if len(ft) > 2 and ft[2] else {}),
            }
            for i, ft in enumerate(frames)
        ]
        result = {
            "sid": sid, "available": True, "source": "hursat",
            "n_frames": len(frames), "frames": frame_list,
        }

    # Handle GridSat path (same track-based frame list as MergIR)
    elif source == "gridsat":
        track_points = []
        if track:
            try:
                track_points = json_mod.loads(track)
            except (json_mod.JSONDecodeError, TypeError):
                pass

        if not track_points:
            # Fall back to HURSAT if available, but DO NOT cache (same
            # cache-poisoning issue as MergIR — see comment above).
            if HURSAT_START_YEAR <= year <= HURSAT_END_YEAR:
                frames = _get_extracted_frames(sid, storm_lon=storm_lon)
                if frames:
                    frame_list = [
                        {
                            "index": i, "datetime": ft[0],
                            **({"satellite": ft[2]} if len(ft) > 2 and ft[2] else {}),
                        }
                        for i, ft in enumerate(frames)
                    ]
                    result = {
                        "sid": sid, "available": True, "source": "hursat",
                        "n_frames": len(frames), "frames": frame_list,
                        "_fallback": True,
                    }
                    # NOT cached — next request with track data should get GridSat
                    return JSONResponse(
                        result,
                        headers={"Cache-Control": "public, max-age=60"},
                    )

            result = {
                "sid": sid, "available": False, "source": "gridsat",
                "reason": "Track data required for GridSat (pass track parameter)",
            }
            return JSONResponse(result)

        gridsat_frames = _build_mergir_frame_list(track_points)
        if not gridsat_frames:
            result = {
                "sid": sid, "available": False, "source": "gridsat",
                "reason": "No valid track times for GridSat",
            }
            return JSONResponse(result)

        frame_list = [
            {
                "index": i,
                "datetime": f["datetime"],
                "lat": f["lat"],
                "lon": f["lon"],
            }
            for i, f in enumerate(gridsat_frames)
        ]
        result = {
            "sid": sid, "available": True, "source": "gridsat",
            "n_frames": len(gridsat_frames), "frames": frame_list,
        }

    # Handle MergIR path
    elif source == "mergir":
        # Parse track points
        track_points = []
        if track:
            try:
                track_points = json_mod.loads(track)
            except (json_mod.JSONDecodeError, TypeError):
                pass

        if not track_points:
            # Fall back to HURSAT if available, but DO NOT cache this result.
            # Caching a HURSAT fallback under the MergIR cache key poisons all
            # subsequent requests for this SID — even when track data is provided
            # later, the cached HURSAT result is returned.  This was the root
            # cause of MergIR "failures": an early prefetch without track data
            # would cache HURSAT and lock out MergIR for that storm.
            if HURSAT_START_YEAR <= year <= HURSAT_END_YEAR:
                frames = _get_extracted_frames(sid, storm_lon=storm_lon)
                if frames:
                    frame_list = [
                        {
                            "index": i, "datetime": ft[0],
                            **({"satellite": ft[2]} if len(ft) > 2 and ft[2] else {}),
                        }
                        for i, ft in enumerate(frames)
                    ]
                    result = {
                        "sid": sid, "available": True, "source": "hursat",
                        "n_frames": len(frames), "frames": frame_list,
                        "_fallback": True,  # Signal that this is a trackless fallback
                    }
                    # NOT cached — next request with track data should get MergIR
                    return JSONResponse(
                        result,
                        headers={"Cache-Control": "public, max-age=60"},  # Short TTL
                    )

            result = {
                "sid": sid, "available": False, "source": "mergir",
                "reason": "Track data required for MergIR (pass track parameter)",
            }
            return JSONResponse(result)

        # Build MergIR frame list from track
        mergir_frames = _build_mergir_frame_list(track_points)
        if not mergir_frames:
            result = {
                "sid": sid, "available": False, "source": "mergir",
                "reason": "No valid track times for MergIR",
            }
            return JSONResponse(result)

        frame_list = [
            {
                "index": i,
                "datetime": f["datetime"],
                "lat": f["lat"],
                "lon": f["lon"],
            }
            for i, f in enumerate(mergir_frames)
        ]
        result = {
            "sid": sid, "available": True, "source": "mergir",
            "n_frames": len(mergir_frames), "frames": frame_list,
        }

    # Cache and return
    _mergir_meta_cache[cache_key] = result
    if len(_mergir_meta_cache) > _MERGIR_META_CACHE_MAX:
        _mergir_meta_cache.popitem(last=False)

    # Fire-and-forget: precompute Hovmöller in background so it's cached
    # when the user clicks the button. Skip if already cached.
    if result.get("available") and track and sid not in _hovmoller_cache:
        if _gcs_get_hovmoller(sid) is None:
            def _bg_hovmoller():
                try:
                    logger.info(f"[Hovmöller] Background precompute starting for {sid}")
                    # Build a minimal mock request for the hovmoller function
                    _track_points = []
                    try:
                        _track_points = json_mod.loads(track)
                    except Exception:
                        return
                    if len(_track_points) < 2:
                        return
                    _precompute_hovmoller(sid, _track_points, storm_lon)
                    logger.info(f"[Hovmöller] Background precompute done for {sid}")
                except Exception as e:
                    logger.debug(f"[Hovmöller] Background precompute failed for {sid}: {e}")
            threading.Thread(target=_bg_hovmoller, daemon=True).start()

    return JSONResponse(
        result,
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ---------------------------------------------------------------------------
# Cache Healing — Opportunistic Upgrade of Fallback Frames
# ---------------------------------------------------------------------------
# When a frame was served from a fallback source (e.g. GridSat when MergIR
# was preferred), subsequent cache hits detect this and spawn a background
# thread to retry the preferred source.  If the retry succeeds, the in-memory
# and GCS caches are silently upgraded so future users get the higher-quality
# frame without any latency penalty.
#
# This is safe because:
#   - The heal runs in a daemon thread (no request latency impact)
#   - It respects the concurrency semaphore (won't cause OOM)
#   - Failed retries are silently ignored (fallback frame stays)
#   - A per-frame lock prevents duplicate heal attempts

_heal_in_progress: set = set()       # set of (sid, frame_idx) currently healing
_heal_lock = threading.Lock()


def _heal_frame_background(sid: str, frame_idx: int, preferred_source: str,
                           frame_dt: datetime, frame_lat: float, frame_lon: float):
    """
    Background worker: retry fetching a frame from the preferred source.
    If successful, update both in-memory and GCS caches.
    """
    heal_key = (sid, frame_idx)
    try:
        frame_2d = None

        if preferred_source == "mergir":
            frame_2d, ir_bounds = _load_mergir_subset(frame_dt, frame_lat, frame_lon)
            half_domain = MERGIR_HALF_DOMAIN
            ir_scale = 3
        elif preferred_source == "gridsat":
            frame_2d, ir_bounds = _load_gridsat_subset(frame_dt, frame_lat, frame_lon)
            half_domain = GRIDSAT_HALF_DOMAIN
            ir_scale = 4

        if frame_2d is None:
            _heal_stats["failed"] += 1
            _record_heal_history(sid, frame_idx, preferred_source, success=False,
                                 reason="preferred source returned no data")
            return  # Preferred source still unavailable — keep fallback

        tb_encoded = _encode_tb_uint8(frame_2d)
        if ir_bounds:
            bounds = ir_bounds
        else:
            bounds = {
                "south": frame_lat - half_domain,
                "north": frame_lat + half_domain,
                "west": frame_lon - half_domain,
                "east": frame_lon + half_domain,
            }
        result = {
            "sid": sid, "frame_idx": frame_idx,
            "datetime": frame_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": preferred_source,
            "bounds": bounds,
            **tb_encoded,
        }

        # Update in-memory cache
        cache_key = (f"ir_{sid}", frame_idx)
        _frame_cache[cache_key] = result
        # Update GCS persistent cache
        _gcs_put_frame(sid, frame_idx, result, source="ir")

        _heal_stats["succeeded"] += 1
        _record_heal_history(sid, frame_idx, preferred_source, success=True)
        print(f"[Cache Heal] ✓ Upgraded {sid} frame {frame_idx} → {preferred_source}")

    except Exception as e:
        _heal_stats["failed"] += 1
        _record_heal_history(sid, frame_idx, preferred_source, success=False,
                             reason=str(e))
        print(f"[Cache Heal] ✗ Failed {sid} frame {frame_idx}: {e}")
    finally:
        with _heal_lock:
            _heal_in_progress.discard(heal_key)


def _record_heal_history(sid: str, frame_idx: int, target_source: str,
                         success: bool, reason: str = ""):
    """Append to the rolling heal history for the diagnostic endpoint."""
    entry = {
        "sid": sid, "frame_idx": frame_idx,
        "target_source": target_source,
        "success": success,
        "reason": reason,
        "time_utc": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _heal_stats["history"].append(entry)
    if len(_heal_stats["history"]) > _HEAL_HISTORY_MAX:
        _heal_stats["history"] = _heal_stats["history"][-_HEAL_HISTORY_MAX:]


_heal_stats = {"attempted": 0, "succeeded": 0, "failed": 0, "skipped": 0, "history": []}
_HEAL_HISTORY_MAX = 50  # Keep last N heal results for the diagnostic endpoint


def _determine_preferred_source(sid: str) -> str | None:
    """
    Determine the preferred IR source for a storm based on its year and
    server configuration.  Uses the same logic as ir_meta but doesn't
    require the metadata cache to be populated.
    """
    year = _parse_sid_year(sid)
    _earthdata_configured = bool(EARTHDATA_TOKEN or EARTHDATA_USER)
    if year >= MERGIR_START_YEAR and _earthdata_configured:
        return "mergir"
    elif GRIDSAT_START_YEAR <= year <= GRIDSAT_END_YEAR:
        return "gridsat"
    return None  # Can't determine or no upgrade possible


def _maybe_heal_frame(sid: str, frame_idx: int, cached_result: dict):
    """
    Check if a cached frame was served from a fallback source and, if so,
    spawn a background thread to retry the preferred source.

    Works in two modes:
      1. If _mergir_meta_cache has metadata for this storm, use it for
         frame coordinates (most accurate).
      2. Otherwise, infer the preferred source from the SID year and
         extract coordinates from the cached frame's bounds (works even
         after container restarts when only GCS cache is available).
    """
    actual_source = cached_result.get("source", "")
    if not actual_source:
        return

    # Try metadata cache first, fall back to year-based inference
    meta_key = f"ir_{sid}"
    meta = _mergir_meta_cache.get(meta_key)
    if meta and meta.get("available"):
        preferred_source = meta.get("source", "")
    else:
        preferred_source = _determine_preferred_source(sid)

    if not preferred_source:
        return

    # Nothing to heal if the frame already came from the preferred source
    if actual_source == preferred_source:
        return

    # Only heal upgrades (gridsat→mergir, hursat→gridsat, hursat→mergir)
    _SOURCE_RANK = {"mergir": 0, "gridsat": 1, "hursat": 2}
    if _SOURCE_RANK.get(actual_source, 99) <= _SOURCE_RANK.get(preferred_source, 99):
        return

    # Don't duplicate heal attempts
    heal_key = (sid, frame_idx)
    with _heal_lock:
        if heal_key in _heal_in_progress:
            return
        _heal_in_progress.add(heal_key)

    # Get frame coordinates — prefer metadata, fall back to cached bounds
    frame_lat = None
    frame_lon = None
    frame_dt = None

    if meta and meta.get("frames"):
        frames = meta.get("frames", [])
        if frame_idx < len(frames):
            frame_info = frames[frame_idx]
            frame_lat = frame_info.get("lat")
            frame_lon = frame_info.get("lon")
            try:
                frame_dt = datetime.fromisoformat(frame_info["datetime"])
            except Exception:
                pass

    # Fall back to extracting coords from the cached frame's bounds
    if frame_lat is None or frame_lon is None:
        bounds = cached_result.get("bounds")
        if bounds:
            frame_lat = (bounds.get("south", 0) + bounds.get("north", 0)) / 2
            frame_lon = (bounds.get("west", 0) + bounds.get("east", 0)) / 2

    if frame_dt is None:
        dt_str = cached_result.get("datetime", "")
        if dt_str:
            try:
                frame_dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
            except Exception:
                pass

    if frame_lat is None or frame_lon is None or frame_dt is None:
        with _heal_lock:
            _heal_in_progress.discard(heal_key)
        _heal_stats["skipped"] += 1
        return

    _heal_stats["attempted"] += 1
    t = threading.Thread(
        target=_heal_frame_background,
        args=(sid, frame_idx, preferred_source, frame_dt, frame_lat, frame_lon),
        daemon=True, name=f"heal-{sid}-{frame_idx}",
    )
    t.start()
    print(f"[Cache Heal] Spawned heal for {sid} frame {frame_idx} "
          f"({actual_source} → {preferred_source})")


@router.get("/ir/frame")
def ir_frame(
    sid: str = Query(..., description="IBTrACS storm ID"),
    frame_idx: int = Query(..., ge=0, description="Frame index (0-based)"),
    lat: float = Query(None, description="Storm center latitude (for MergIR)"),
    lon: float = Query(None, description="Storm center longitude (for MergIR)"),
):
    """
    Return a rendered IR frame as base64 PNG.
    Auto-selects source (MergIR/GridSat/HURSAT) based on cached metadata.
    """
    cache_key = (f"ir_{sid}", frame_idx)

    # Check in-memory frame cache
    if cache_key in _frame_cache:
        _frame_cache.move_to_end(cache_key)
        cached = _frame_cache[cache_key]
        # Opportunistically heal fallback frames in the background
        _maybe_heal_frame(sid, frame_idx, cached)
        return JSONResponse(
            cached,
            headers={"Cache-Control": "public, max-age=86400", "X-Cache": "HIT"},
        )

    # Check GCS persistent cache
    gcs_result = _gcs_get_frame(sid, frame_idx, source="ir")
    if gcs_result is not None:
        # Populate in-memory cache too
        _frame_cache[cache_key] = gcs_result
        if len(_frame_cache) > _FRAME_CACHE_MAX:
            _frame_cache.popitem(last=False)
        # Opportunistically heal fallback frames in the background
        _maybe_heal_frame(sid, frame_idx, gcs_result)
        return JSONResponse(
            gcs_result,
            headers={"Cache-Control": "public, max-age=86400", "X-Cache": "GCS-HIT"},
        )

    # Check what source was determined for this storm.
    # If the server's meta cache is empty (e.g. fresh container restart, or
    # meta served from browser HTTP cache), infer the source from the storm
    # year and whether lat/lon were provided.  Without this, every frame
    # falls back to HURSAT after a container restart even though MergIR is
    # available and the client sent lat/lon.
    meta_key = f"ir_{sid}"
    meta = _mergir_meta_cache.get(meta_key)
    source = meta.get("source", "hursat") if meta else None

    year = _parse_sid_year(sid)

    if source is None:
        # Meta cache miss — infer source from year + credentials + params
        _earthdata_configured = bool(EARTHDATA_TOKEN or EARTHDATA_USER)
        if year >= MERGIR_START_YEAR and _earthdata_configured and lat is not None and lon is not None:
            source = "mergir"
            logger.info(f"ir_frame: meta cache miss for {sid}, inferred source=mergir from year={year} + lat/lon")
        elif GRIDSAT_START_YEAR <= year <= GRIDSAT_END_YEAR and lat is not None and lon is not None:
            source = "gridsat"
            logger.info(f"ir_frame: meta cache miss for {sid}, inferred source=gridsat from year={year} + lat/lon")
        else:
            source = "hursat"

    if source in ("mergir", "gridsat") and (lat is not None and lon is not None):
        # MergIR/GridSat path: need lat/lon for the specific frame.
        # When meta cache is available, use it for frame coordinates and datetime.
        # When meta is missing (container restart), fall back to client-provided
        # lat/lon and derive datetime from HURSAT frame list.
        frame_lat = lat
        frame_lon = lon
        frame_dt = None

        if meta and meta.get("available"):
            frames = meta.get("frames", [])
            if frame_idx < len(frames):
                frame_info = frames[frame_idx]
                frame_lat = lat or frame_info.get("lat")
                frame_lon = lon or frame_info.get("lon")
                frame_dt = datetime.fromisoformat(frame_info["datetime"])

        # If we don't have frame_dt from meta, try to get it from HURSAT frame list
        if frame_dt is None:
            try:
                hursat_frames = _get_extracted_frames(sid, storm_lon=lon or 0.0)
                if hursat_frames and frame_idx < len(hursat_frames):
                    dt_str = hursat_frames[frame_idx][0]
                    frame_dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00").split("+")[0])
            except Exception:
                pass

        if frame_dt is None:
            # Can't determine frame time — fall back to HURSAT path
            logger.warning(f"ir_frame: no frame datetime for {sid} frame {frame_idx}, falling back to HURSAT")
            source = "hursat"

        # Try primary source, then cascade to alternatives on failure.
        # Priority: MergIR → GridSat → HURSAT (for 2000+ storms)
        #           GridSat → HURSAT             (for pre-2000 storms)
        frame_2d = None
        actual_source = source

        if source == "mergir":
            frame_2d, ir_bounds = _load_mergir_subset(frame_dt, frame_lat, frame_lon)
            half_domain = MERGIR_HALF_DOMAIN
            ir_scale = 3  # 4km → 3x upscale

        if frame_2d is None and (source in ("mergir", "gridsat")):
            # Cascade: try GridSat
            frame_2d, ir_bounds = _load_gridsat_subset(frame_dt, frame_lat, frame_lon)
            if frame_2d is not None:
                actual_source = "gridsat"
                half_domain = GRIDSAT_HALF_DOMAIN
                ir_scale = 4  # 8km → 4x upscale

        if frame_2d is None:
            # Final cascade: try HURSAT if available
            try:
                hursat_frames = _get_extracted_frames(sid, storm_lon=frame_lon)
                if hursat_frames and frame_idx < len(hursat_frames):
                    frame_tuple = hursat_frames[frame_idx]
                    nc_path = frame_tuple[1]
                    frame_2d, ir_bounds = _load_frame_from_nc(nc_path)
                    if frame_2d is not None:
                        actual_source = "hursat"
                        half_domain = GRIDSAT_HALF_DOMAIN  # Use consistent domain
                        ir_scale = 4
            except Exception as e:
                logger.debug(f"HURSAT fallback failed for {sid} frame {frame_idx}: {e}")

        if frame_2d is None:
            raise HTTPException(
                status_code=502,
                detail=f"No IR data available from any source for {sid} frame {frame_idx} (dt={frame_dt})",
            )

        # Use actual data bounds from the loader for precise geo-alignment.
        # The loaders return ir_bounds with the exact lat/lon extent of the
        # data array, which ensures the image overlay and hover lookup match
        # the true pixel coordinates (avoids sub-degree offset from grid snapping).
        # Fall back to center ± half_domain if ir_bounds is missing.
        tb_encoded = _encode_tb_uint8(frame_2d)
        if ir_bounds:
            bounds = ir_bounds
        else:
            bounds = {
                "south": frame_lat - half_domain,
                "north": frame_lat + half_domain,
                "west": frame_lon - half_domain,
                "east": frame_lon + half_domain,
            }
        result = {
            "sid": sid, "frame_idx": frame_idx,
            "datetime": frame_dt.isoformat() if frame_dt else "",
            "source": actual_source,
            "bounds": bounds,
            **tb_encoded,
        }

    else:
        # HURSAT path (default)
        # Use lon if available (from MergIR params), default 0.0 for cache hit
        frames = _get_extracted_frames(sid, storm_lon=lon or 0.0)
        if not frames:
            raise HTTPException(status_code=404, detail="IR data not found")

        if frame_idx >= len(frames):
            raise HTTPException(
                status_code=404,
                detail=f"Frame {frame_idx} out of range (0-{len(frames)-1})",
            )

        frame_tuple = frames[frame_idx]
        dt_str, nc_path = frame_tuple[0], frame_tuple[1]
        satellite = frame_tuple[2] if len(frame_tuple) > 2 else ""

        frame_2d, bounds = _load_frame_from_nc(nc_path)
        if frame_2d is None:
            raise HTTPException(status_code=500, detail="Failed to read frame data")

        tb_encoded = _encode_tb_uint8(frame_2d)
        result = {
            "sid": sid, "frame_idx": frame_idx,
            "datetime": dt_str, "source": "hursat",
            **tb_encoded,
        }
        if satellite:
            result["satellite"] = satellite
        if bounds:
            result["bounds"] = bounds

    # Cache rendered frame (in-memory + GCS persistent)
    _frame_cache[cache_key] = result
    if len(_frame_cache) > _FRAME_CACHE_MAX:
        _frame_cache.popitem(last=False)
        gc.collect()
    _gcs_put_frame(sid, frame_idx, result, source="ir")

    return JSONResponse(
        result,
        headers={"Cache-Control": "public, max-age=86400", "X-Cache": "MISS"},
    )


@router.get("/ir/batch")
def ir_batch(
    sid: str = Query(..., description="IBTrACS storm ID"),
    indices: str = Query(..., description="Comma-separated frame indices, e.g. '0,1,2,3,4'"),
):
    """
    Fetch multiple IR frames in one request using concurrent workers.
    Returns a dict mapping frame index → frame data (or null on failure).
    Server-side concurrency is capped at 5 workers to limit RAM usage.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    MAX_BATCH = 15      # Max frames per batch request
    MAX_WORKERS = 5     # Concurrent OPeNDAP/file reads

    # Parse indices
    try:
        idx_list = [int(x.strip()) for x in indices.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid indices format")

    if len(idx_list) > MAX_BATCH:
        idx_list = idx_list[:MAX_BATCH]

    # Look up cached meta to determine source
    # The unified /ir/meta endpoint caches with "ir_{sid}" prefix
    meta = _mergir_meta_cache.get(f"ir_{sid}")
    if not meta:
        meta = _mergir_meta_cache.get(sid)
    if not meta:
        meta = _meta_cache.get(sid)
    source = meta.get("source", "hursat") if meta else "hursat"

    def fetch_single_frame(frame_idx: int):
        """Fetch one frame, return (idx, result_dict) or (idx, None)."""
        cache_key = (sid, frame_idx)

        # Check frame cache first
        if cache_key in _frame_cache:
            _frame_cache.move_to_end(cache_key)
            return (frame_idx, _frame_cache[cache_key])

        try:
            if source in ("mergir", "gridsat") and meta and meta.get("available"):
                frames_meta = meta.get("frames", [])
                if frame_idx >= len(frames_meta):
                    return (frame_idx, None)

                frame_info = frames_meta[frame_idx]
                frame_dt = datetime.strptime(
                    frame_info["datetime"], "%Y-%m-%dT%H:%M:%S"
                )
                frame_lat = frame_info.get("lat")
                frame_lon = frame_info.get("lon")

                if frame_lat is None or frame_lon is None:
                    return (frame_idx, None)

                if source == "gridsat":
                    frame_2d, ir_bounds = _load_gridsat_subset(
                        frame_dt, frame_lat, frame_lon
                    )
                    half_domain = GRIDSAT_HALF_DOMAIN
                    ir_scale = 4
                else:
                    frame_2d, ir_bounds = _load_mergir_subset(
                        frame_dt, frame_lat, frame_lon
                    )
                    half_domain = MERGIR_HALF_DOMAIN
                    ir_scale = 3

                if frame_2d is None:
                    return (frame_idx, None)

                tb_encoded = _encode_tb_uint8(frame_2d)
                # Use actual data bounds for precise geo-alignment
                if ir_bounds:
                    bounds = ir_bounds
                else:
                    bounds = {
                        "south": frame_lat - half_domain,
                        "north": frame_lat + half_domain,
                        "west": frame_lon - half_domain,
                        "east": frame_lon + half_domain,
                    }
                result = {
                    "sid": sid, "frame_idx": frame_idx,
                    "datetime": frame_info["datetime"], "source": source,
                    "bounds": bounds,
                    **tb_encoded,
                }
            else:
                # HURSAT path
                frames = _get_extracted_frames(sid, storm_lon=0.0)
                if not frames or frame_idx >= len(frames):
                    return (frame_idx, None)

                frame_tuple = frames[frame_idx]
                dt_str, nc_path = frame_tuple[0], frame_tuple[1]
                satellite = frame_tuple[2] if len(frame_tuple) > 2 else ""

                frame_2d, bounds = _load_frame_from_nc(nc_path)
                if frame_2d is None:
                    return (frame_idx, None)

                tb_encoded = _encode_tb_uint8(frame_2d)
                result = {
                    "sid": sid, "frame_idx": frame_idx,
                    "datetime": dt_str, "source": "hursat",
                    **tb_encoded,
                }
                if satellite:
                    result["satellite"] = satellite
                if bounds:
                    result["bounds"] = bounds

            # Cache it
            _frame_cache[cache_key] = result
            if len(_frame_cache) > _FRAME_CACHE_MAX:
                _frame_cache.popitem(last=False)

            return (frame_idx, result)

        except Exception as e:
            logger.warning(f"Batch frame {frame_idx} failed: {e}")
            return (frame_idx, None)

    # Fetch frames concurrently
    results = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(fetch_single_frame, idx): idx for idx in idx_list}
        for future in as_completed(futures):
            idx, data = future.result()
            results[str(idx)] = data

    # Opportunistically heal any fallback frames in the background
    for idx_str, frame_data in results.items():
        if frame_data is not None:
            _maybe_heal_frame(sid, int(idx_str), frame_data)

    return JSONResponse(
        {"sid": sid, "source": source, "frames": results},
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ── Storm-Duration Hovmöller ─────────────────────────────────

# GCS + in-memory cache for Hovmöller results (keyed by SID)
_hovmoller_cache: OrderedDict = OrderedDict()
_HOVMOLLER_CACHE_MAX = 20


_HOV_CACHE_VER = "v14"  # v14 = std ratio gate tightened to 0.6, tooltip fix


def _gcs_get_hovmoller(sid: str):
    """Try loading a cached Hovmöller result from GCS."""
    bucket = _get_gcs_bucket()
    if not bucket:
        return None
    blob_name = f"archive/hovmoller/{_HOV_CACHE_VER}/{sid}.json"
    try:
        blob = bucket.blob(blob_name)
        if not blob.exists():
            return None
        data = json.loads(blob.download_as_text())
        return data
    except Exception:
        return None


def _gcs_put_hovmoller(sid: str, result: dict):
    """Cache Hovmöller result to GCS (fire-and-forget)."""
    bucket = _get_gcs_bucket()
    if not bucket:
        return
    blob_name = f"archive/hovmoller/{_HOV_CACHE_VER}/{sid}.json"
    try:
        blob = bucket.blob(blob_name)
        blob.upload_from_string(
            json.dumps(result), content_type="application/json"
        )
    except Exception as e:
        logger.debug(f"GCS Hovmöller put failed for {sid}: {e}")


def _precompute_hovmoller(sid: str, track_points: list, storm_lon: float = 0.0,
                          max_radius_km: float = 200.0, dr_km: float = 4.0):
    """Compute Hovmöller profiles and cache to memory + GCS. Used by both
    the endpoint and the fire-and-forget background precompute from ir_meta."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    year = _parse_sid_year(sid)
    _earthdata_configured = bool(EARTHDATA_TOKEN or EARTHDATA_USER)

    if year >= MERGIR_START_YEAR and _earthdata_configured:
        source = "mergir"
    elif GRIDSAT_START_YEAR <= year <= GRIDSAT_END_YEAR:
        source = "gridsat"
    elif HURSAT_START_YEAR <= year <= HURSAT_END_YEAR:
        source = "hursat"
    else:
        return None

    if source in ("mergir", "gridsat"):
        frame_list = _build_mergir_frame_list(track_points)
        # Add frame indices for GCS cache lookup
        for i, f in enumerate(frame_list):
            f["_frame_idx"] = i
    else:
        frames = _get_extracted_frames(sid, storm_lon=storm_lon)
        frame_list = []
        if frames:
            for i, ft in enumerate(frames):
                frame_list.append({
                    "datetime": ft[0], "lat": None, "lon": None,
                    "_hursat_idx": i, "_frame_idx": i,
                })

    if not frame_list:
        return None

    # Build track interpolation arrays
    track_times, track_lats, track_lons, track_winds = [], [], [], []
    for pt in track_points:
        if not pt.get("t") or pt.get("la") is None or pt.get("lo") is None:
            continue
        try:
            dt = datetime.fromisoformat(pt["t"].replace("Z", "+00:00").split("+")[0])
            track_times.append(dt.timestamp())
            track_lats.append(float(pt["la"]))
            track_lons.append(float(pt["lo"]))
            track_winds.append(float(pt["w"]) if pt.get("w") is not None else None)
        except (ValueError, TypeError):
            continue

    if len(track_times) < 2:
        return None

    track_ts = np.array(track_times)
    track_la = np.array(track_lats)
    track_lo = np.array(track_lons)

    def _interp_position(target_dt):
        ts = target_dt.timestamp()
        if ts < track_ts[0]:
            ts = track_ts[0]
        elif ts > track_ts[-1]:
            ts = track_ts[-1]
        lat = float(np.interp(ts, track_ts, track_la))
        lon = float(np.interp(ts, track_ts, track_lo))
        wind = None
        for i in range(len(track_times) - 1):
            if track_ts[i] <= ts <= track_ts[i + 1]:
                w0, w1 = track_winds[i], track_winds[i + 1]
                if w0 is not None and w1 is not None:
                    frac = (ts - track_ts[i]) / (track_ts[i + 1] - track_ts[i]) if track_ts[i + 1] > track_ts[i] else 0
                    wind = round(w0 + frac * (w1 - w0))
                elif w0 is not None:
                    wind = w0
                elif w1 is not None:
                    wind = w1
                break
        return lat, lon, wind

    n_rad_bins = int(max_radius_km / dr_km)

    def _compute_profile(frame_info):
        try:
            dt_str = frame_info["datetime"]
            frame_dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00").split("+")[0])
        except (ValueError, KeyError):
            return None

        c_lat, c_lon, wind = _interp_position(frame_dt)

        # Try GCS frame cache first — frames already fetched by the IR viewer
        frame_idx = frame_info.get("_frame_idx", frame_info.get("_hursat_idx"))
        arr = None
        south = north = west = east = None

        if frame_idx is not None:
            cached = _gcs_get_frame(sid, frame_idx, source="ir")
            if cached is None and source == "hursat":
                cached = _gcs_get_frame(sid, frame_idx, source="hursat")
            if cached and cached.get("tb_data"):
                try:
                    import base64 as _b64
                    raw_u8 = np.frombuffer(
                        _b64.b64decode(cached["tb_data"]), dtype=np.uint8
                    ).reshape(cached["tb_rows"], cached["tb_cols"])
                    vmin = cached.get("tb_vmin", TB_VMIN)
                    vmax = cached.get("tb_vmax", TB_VMAX)
                    # Decode uint8 back to Tb (K)
                    arr = np.where(raw_u8 > 0,
                                   vmin + (raw_u8.astype(np.float32) - 1) * (vmax - vmin) / 254.0,
                                   np.nan)
                    bounds_c = cached.get("bounds", {})
                    if isinstance(bounds_c, dict):
                        south, north = bounds_c.get("south"), bounds_c.get("north")
                        west, east = bounds_c.get("west"), bounds_c.get("east")
                    elif isinstance(bounds_c, list) and len(bounds_c) == 2:
                        south, west = bounds_c[0]
                        north, east = bounds_c[1]
                except Exception:
                    arr = None

        # Fall back to direct satellite fetch if not in cache
        if arr is None:
            frame_2d = None
            ir_bounds = None
            half_domain = GRIDSAT_HALF_DOMAIN

            if source == "mergir":
                frame_2d, ir_bounds = _load_mergir_subset(frame_dt, c_lat, c_lon)
                half_domain = MERGIR_HALF_DOMAIN
            if frame_2d is None and source in ("mergir", "gridsat"):
                frame_2d, ir_bounds = _load_gridsat_subset(frame_dt, c_lat, c_lon)
                half_domain = GRIDSAT_HALF_DOMAIN
            if frame_2d is None and frame_info.get("_hursat_idx") is not None:
                hursat_frames = _get_extracted_frames(sid, storm_lon=storm_lon)
                if hursat_frames and frame_info["_hursat_idx"] < len(hursat_frames):
                    frame_2d, ir_bounds = _load_frame_from_nc(hursat_frames[frame_info["_hursat_idx"]][1])
                    half_domain = GRIDSAT_HALF_DOMAIN

            if frame_2d is None:
                return None

            arr = np.asarray(frame_2d, dtype=np.float32)
            if ir_bounds:
                south, north = ir_bounds["south"], ir_bounds["north"]
                west, east = ir_bounds["west"], ir_bounds["east"]
            else:
                south, north = c_lat - half_domain, c_lat + half_domain
                west, east = c_lon - half_domain, c_lon + half_domain

        if arr is None or south is None:
            return None

        rows, cols = arr.shape

        lat_span, lon_span = north - south, east - west
        if lat_span <= 0 or lon_span <= 0:
            return None

        # Center-finding with relaxed search but strict acceptance:
        # Quality gates:
        #   1. ir_rad_dif >= 15K — clear warm eye vs cold eyewall
        #   2. std_ratio < 0.6 — symmetric relative to core variability
        #   3. coldest_ring <= -60°C — deep convective eyewall
        center_method = "track"
        gate_info = {}  # diagnostic info for frontend tooltip
        if wind is not None and wind >= 50:
            try:
                cfix = find_ir_center(
                    arr, [[south, west], [north, east]], c_lat, c_lon,
                    ref_lat=c_lat, ref_lon=c_lon,
                    min_ir_rad_dif=0.0,
                    min_eye_score=0.0,
                    search_radius_km=80.0,
                    max_iterations=3,
                )
                if cfix.get("lat") is not None:
                    g1 = round(cfix.get("ir_rad_dif", 0), 1)
                    g2 = round(cfix.get("mean_std", 99), 3)  # std ratio
                    g3_ring = round(cfix.get("coldest_ring", 999) - 273.15, 1)  # °C
                    # Always store the candidate position + gates for diagnostics
                    gate_info = {"g1_rad_dif": g1, "g2_std_ratio": g2, "g3_ring_C": g3_ring,
                                 "cand_lat": cfix["lat"], "cand_lon": cfix["lon"]}

                    passed = (g1 >= 15.0 and g2 < 0.6
                              and g3_ring <= -60.0)
                    if passed:
                        c_lat, c_lon = cfix["lat"], cfix["lon"]
                        center_method = "ir_fix"
            except Exception:
                pass

        cy = (north - c_lat) / lat_span * (rows - 1)
        cx = (c_lon - west) / lon_span * (cols - 1)
        cos_lat = np.cos(np.radians(c_lat))
        dy_km = lat_span / (rows - 1) * 111.0
        dx_km = lon_span / (cols - 1) * 111.0 * cos_lat

        row_idx, col_idx = np.arange(rows), np.arange(cols)
        DY, DX = np.meshgrid((row_idx - cy) * dy_km, (col_idx - cx) * dx_km, indexing='ij')
        dist = np.sqrt(DY * DY + DX * DX)
        bins = np.floor(dist / dr_km).astype(np.int32)
        valid = np.isfinite(arr) & (arr > 0)

        # Data quality check: reject frames with poor coverage in inner core.
        # If >30% of pixels within 100km are missing/invalid, the radial
        # profile will have gaps — likely a MergIR swath boundary or data gap.
        inner_mask = dist <= 100.0
        n_inner_total = np.count_nonzero(inner_mask)
        n_inner_valid = np.count_nonzero(valid & inner_mask)
        if n_inner_total > 0 and n_inner_valid / n_inner_total < 0.7:
            return None  # skip this frame

        profile = [None] * n_rad_bins
        for b in range(n_rad_bins):
            mask = valid & (bins == b)
            if np.count_nonzero(mask) >= 3:
                profile[b] = round(float(np.mean(arr[mask])) - 273.15, 2)

        return {"time": dt_str, "profile": profile, "wind": wind,
                "center": center_method, "clat": round(c_lat, 3), "clon": round(c_lon, 3),
                "gates": gate_info}

    MAX_WORKERS = 5
    partial_results = [None] * len(frame_list)
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_compute_profile, f): i for i, f in enumerate(frame_list)}
        for future in as_completed(futures):
            idx = futures[future]
            try:
                partial_results[idx] = future.result()
            except Exception as e:
                logger.debug(f"Hovmöller frame {idx} failed: {e}")

    out_times, out_profiles, out_winds, out_centers = [], [], [], []
    for r in partial_results:
        if r is not None:
            out_times.append(r["time"])
            out_profiles.append(r["profile"])
            out_winds.append(r["wind"])
            out_centers.append({"lat": r["clat"], "lon": r["clon"], "method": r["center"],
                                "gates": r.get("gates", {})})

    if not out_times:
        return None

    radii = [round(b * dr_km + dr_km / 2, 1) for b in range(n_rad_bins)]
    result = {
        "sid": sid, "source": source, "times": out_times, "radii": radii,
        "profiles": out_profiles, "winds": out_winds, "centers": out_centers,
        "n_frames": len(out_times),
    }

    _hovmoller_cache[sid] = result
    if len(_hovmoller_cache) > _HOVMOLLER_CACHE_MAX:
        _hovmoller_cache.popitem(last=False)
    threading.Thread(target=_gcs_put_hovmoller, args=(sid, result), daemon=True).start()
    return result


@router.api_route("/ir/hovmoller", methods=["GET", "POST"])
async def ir_hovmoller(
    request: Request,
    sid: str = Query("", description="IBTrACS storm ID"),
    track: str = Query("", description="JSON-encoded track points (GET) or send as POST body"),
    storm_lon: float = Query(0.0, description="Storm longitude for satellite selection"),
    max_radius_km: float = Query(200.0, ge=50, le=500),
    dr_km: float = Query(4.0, ge=2, le=20),
    stream: bool = Query(False, description="Stream progress as newline-delimited JSON"),
):
    """
    Compute storm-duration azimuthal-mean Tb radial profiles (Hovmöller diagram).

    Returns pre-computed profiles for all available IR frames of a historical
    storm, centered on interpolated best-track positions.
    With stream=true, sends progress lines before the final JSON result.
    """
    import json as json_mod
    from concurrent.futures import ThreadPoolExecutor, as_completed

    if not sid:
        raise HTTPException(status_code=400, detail="sid parameter required")

    # Check in-memory cache
    if sid in _hovmoller_cache:
        _hovmoller_cache.move_to_end(sid)
        return JSONResponse(
            _hovmoller_cache[sid],
            headers={"Cache-Control": "public, max-age=86400"},
        )

    # Check GCS cache
    gcs_result = _gcs_get_hovmoller(sid)
    if gcs_result is not None:
        _hovmoller_cache[sid] = gcs_result
        if len(_hovmoller_cache) > _HOVMOLLER_CACHE_MAX:
            _hovmoller_cache.popitem(last=False)
        return JSONResponse(
            gcs_result,
            headers={"Cache-Control": "public, max-age=86400"},
        )

    # Parse track points (from GET query param or POST body)
    track_points = []
    track_str = track
    if request and request.method == "POST" and not track_str:
        try:
            body = await request.body()
            body_json = json_mod.loads(body)
            if isinstance(body_json, list):
                track_points = body_json
            elif isinstance(body_json, dict) and "track" in body_json:
                track_points = body_json["track"]
                if not sid and "sid" in body_json:
                    sid = body_json["sid"]
        except Exception:
            pass
    if not track_points and track_str:
        try:
            track_points = json_mod.loads(track_str)
        except (json_mod.JSONDecodeError, TypeError):
            pass

    if not track_points:
        raise HTTPException(status_code=400, detail="Track data required for Hovmöller")

    # Build frame list (same as ir_meta)
    year = _parse_sid_year(sid)
    _earthdata_configured = bool(EARTHDATA_TOKEN or EARTHDATA_USER)

    if year >= MERGIR_START_YEAR and _earthdata_configured:
        source = "mergir"
    elif GRIDSAT_START_YEAR <= year <= GRIDSAT_END_YEAR:
        source = "gridsat"
    elif HURSAT_START_YEAR <= year <= HURSAT_END_YEAR:
        source = "hursat"
    else:
        raise HTTPException(status_code=404, detail=f"No IR data available for year {year}")

    if source in ("mergir", "gridsat"):
        frame_list = _build_mergir_frame_list(track_points)
    else:
        frames = _get_extracted_frames(sid, storm_lon=storm_lon)
        frame_list = []
        if frames:
            for i, ft in enumerate(frames):
                frame_list.append({
                    "datetime": ft[0],
                    "lat": None, "lon": None,
                    "_hursat_idx": i,
                })

    if not frame_list:
        raise HTTPException(status_code=404, detail="No frames available")

    # Build track interpolation arrays from track_points
    track_times = []
    track_lats = []
    track_lons = []
    track_winds = []
    for pt in track_points:
        if not pt.get("t") or pt.get("la") is None or pt.get("lo") is None:
            continue
        try:
            dt = datetime.fromisoformat(pt["t"].replace("Z", "+00:00").split("+")[0])
            track_times.append(dt.timestamp())
            track_lats.append(float(pt["la"]))
            track_lons.append(float(pt["lo"]))
            track_winds.append(float(pt["w"]) if pt.get("w") is not None else None)
        except (ValueError, TypeError):
            continue

    if len(track_times) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 track points")

    track_ts = np.array(track_times)
    track_la = np.array(track_lats)
    track_lo = np.array(track_lons)

    def _interp_position(target_dt):
        """Interpolate best-track lat/lon/wind at a target datetime."""
        ts = target_dt.timestamp()
        if ts < track_ts[0]:
            ts = track_ts[0]
        elif ts > track_ts[-1]:
            ts = track_ts[-1]
        lat = float(np.interp(ts, track_ts, track_la))
        lon = float(np.interp(ts, track_ts, track_lo))
        # Wind interpolation (handle None values)
        wind = None
        for i in range(len(track_times) - 1):
            if track_ts[i] <= ts <= track_ts[i + 1]:
                w0, w1 = track_winds[i], track_winds[i + 1]
                if w0 is not None and w1 is not None:
                    frac = (ts - track_ts[i]) / (track_ts[i + 1] - track_ts[i]) if track_ts[i + 1] > track_ts[i] else 0
                    wind = round(w0 + frac * (w1 - w0))
                elif w0 is not None:
                    wind = w0
                elif w1 is not None:
                    wind = w1
                break
        return lat, lon, wind

    # Radial profile parameters
    n_rad_bins = int(max_radius_km / dr_km)

    def _compute_profile_for_frame(frame_info):
        """Load a single frame and compute its radial profile."""
        try:
            dt_str = frame_info["datetime"]
            frame_dt = datetime.fromisoformat(
                dt_str.replace("Z", "+00:00").split("+")[0]
            )
        except (ValueError, KeyError):
            return None

        c_lat, c_lon, wind = _interp_position(frame_dt)

        # Load raw Tb data
        frame_2d = None
        ir_bounds = None
        half_domain = GRIDSAT_HALF_DOMAIN

        if source == "mergir":
            frame_2d, ir_bounds = _load_mergir_subset(frame_dt, c_lat, c_lon)
            half_domain = MERGIR_HALF_DOMAIN
        if frame_2d is None and source in ("mergir", "gridsat"):
            frame_2d, ir_bounds = _load_gridsat_subset(frame_dt, c_lat, c_lon)
            half_domain = GRIDSAT_HALF_DOMAIN
        if frame_2d is None and frame_info.get("_hursat_idx") is not None:
            hursat_frames = _get_extracted_frames(sid, storm_lon=storm_lon)
            if hursat_frames and frame_info["_hursat_idx"] < len(hursat_frames):
                frame_2d, ir_bounds = _load_frame_from_nc(
                    hursat_frames[frame_info["_hursat_idx"]][1]
                )
                half_domain = GRIDSAT_HALF_DOMAIN

        if frame_2d is None:
            return None

        arr = np.asarray(frame_2d, dtype=np.float32)
        rows, cols = arr.shape

        if ir_bounds:
            south, north = ir_bounds["south"], ir_bounds["north"]
            west, east = ir_bounds["west"], ir_bounds["east"]
        else:
            south = c_lat - half_domain
            north = c_lat + half_domain
            west = c_lon - half_domain
            east = c_lon + half_domain

        lat_span = north - south
        lon_span = east - west
        if lat_span <= 0 or lon_span <= 0:
            return None

        # Attempt objective IR center-finding for hurricane-strength frames
        center_method = "track"
        if wind is not None and wind >= 65:
            try:
                cfix = find_ir_center(
                    arr, [[south, west], [north, east]],
                    c_lat, c_lon,
                    ref_lat=c_lat, ref_lon=c_lon,
                )
                if cfix.get("success") and cfix.get("lat"):
                    c_lat = cfix["lat"]
                    c_lon = cfix["lon"]
                    center_method = "ir_fix"
            except Exception:
                pass  # fall back to best-track position

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
        bins = np.floor(dist / dr_km).astype(np.int32)

        # Mask invalid pixels
        valid = np.isfinite(arr) & (arr > 0)

        profile = [None] * n_rad_bins
        for b in range(n_rad_bins):
            mask = valid & (bins == b)
            count = np.count_nonzero(mask)
            if count >= 3:
                profile[b] = round(float(np.mean(arr[mask])) - 273.15, 2)

        return {
            "time": dt_str,
            "profile": profile,
            "wind": wind,
            "center": center_method,
            "clat": round(c_lat, 3),
            "clon": round(c_lon, 3),
        }

    # Process frames concurrently (cap at 5 workers for OOM protection)
    MAX_WORKERS = 5
    total_frames = len(frame_list)

    def _process_all():
        """Run all frames and return (partial_results, completed_count_ref)."""
        completed = [0]  # mutable counter for progress tracking
        partial_results = [None] * total_frames

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {
                pool.submit(_compute_profile_for_frame, f): i
                for i, f in enumerate(frame_list)
            }
            for future in as_completed(futures):
                idx = futures[future]
                try:
                    partial_results[idx] = future.result()
                except Exception as e:
                    logger.debug(f"Hovmöller frame {idx} failed: {e}")
                completed[0] += 1

        return partial_results

    def _build_result(partial_results):
        out_times, out_profiles, out_winds, out_centers = [], [], [], []
        for r in partial_results:
            if r is not None:
                out_times.append(r["time"])
                out_profiles.append(r["profile"])
                out_winds.append(r["wind"])
                out_centers.append({
                    "lat": r["clat"], "lon": r["clon"],
                    "method": r["center"],
                })

        if not out_times:
            return None

        radii = [round(b * dr_km + dr_km / 2, 1) for b in range(n_rad_bins)]
        return {
            "sid": sid, "source": source,
            "times": out_times, "radii": radii,
            "profiles": out_profiles, "winds": out_winds,
            "centers": out_centers, "n_frames": len(out_times),
        }

    if stream:
        # SSE streaming: Cloud Run doesn't buffer text/event-stream
        def _sse_generator():
            completed = [0]
            partial_results = [None] * total_frames

            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
                futures = {
                    pool.submit(_compute_profile_for_frame, f): i
                    for i, f in enumerate(frame_list)
                }
                for future in as_completed(futures):
                    idx = futures[future]
                    try:
                        partial_results[idx] = future.result()
                    except Exception as e:
                        logger.debug(f"Hovmöller frame {idx} failed: {e}")
                    completed[0] += 1
                    yield f"data: {json.dumps({'progress': completed[0], 'total': total_frames})}\n\n"

            result = _build_result(partial_results)
            if result:
                _hovmoller_cache[sid] = result
                if len(_hovmoller_cache) > _HOVMOLLER_CACHE_MAX:
                    _hovmoller_cache.popitem(last=False)
                threading.Thread(target=_gcs_put_hovmoller, args=(sid, result), daemon=True).start()
                yield f"data: {json.dumps(result)}\n\n"
            else:
                yield f"data: {json.dumps({'error': 'No frames could be processed'})}\n\n"

        return StreamingResponse(
            _sse_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Non-streaming mode (default): delegate to shared helper
    result = _precompute_hovmoller(sid, track_points, storm_lon, max_radius_km, dr_km)

    if not result:
        raise HTTPException(status_code=502, detail="No frames could be processed")

    return JSONResponse(
        result,
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── NHC F-Deck Fix Data ──────────────────────────────────────

# Cache parsed f-deck data: atcf_id -> parsed dict
_fdeck_cache: OrderedDict = OrderedDict()
_FDECK_CACHE_MAX = 50

# Dvorak CI number → approximate wind speed (kt) lookup
_DVORAK_CI_TO_KT = {
    1.0: 25, 1.5: 25, 2.0: 30, 2.5: 35, 3.0: 45, 3.5: 55,
    4.0: 65, 4.5: 77, 5.0: 90, 5.5: 102, 6.0: 115, 6.5: 127,
    7.0: 140, 7.5: 155, 8.0: 170, 8.5: 195,
}

# Reverse: wind → nearest CI
_WIND_TO_CI = {v: k for k, v in sorted(_DVORAK_CI_TO_KT.items())}


def _parse_fdeck(raw_text: str) -> dict:
    """Parse NHC f-deck text into structured fix data by type.

    Returns dict with keys for each fix category:
      DVTS, DVTO          — Dvorak fixes (with CI number and agency)
      SFMR                — SFMR surface wind (column 35)
      FL_WIND             — Flight-level wind (column 39)
      DROPSONDE           — Surface estimate from dropsonde (col 11, no SFMR/FL)
      AIRC_OTHER          — Other aircraft surface estimates
    """
    FIX_TYPES_WANTED = {"DVTS", "DVTO", "AIRC"}
    result = {"DVTS": [], "DVTO": [], "SFMR": [], "FL_WIND": [], "DROPSONDE": [], "AIRC_OTHER": []}

    for line in raw_text.strip().split("\n"):
        if not line.strip():
            continue
        cols = [c.strip() for c in line.split(",")]
        if len(cols) < 12:
            continue

        try:
            fix_type = cols[4]
        except (IndexError, ValueError):
            continue

        if fix_type not in FIX_TYPES_WANTED:
            continue

        # Parse datetime (column 2): YYYYMMDDHH
        dt_str = cols[2].strip()
        if len(dt_str) < 10:
            continue
        try:
            iso_dt = f"{dt_str[:4]}-{dt_str[4:6]}-{dt_str[6:8]}T{dt_str[8:10]}:00"
        except Exception:
            continue

        # Parse lat/lon (columns 7-8) — f-deck uses hundredths of degrees
        # e.g., "1380N" = 13.80°N, "3210W" = 32.10°W
        try:
            lat_str = cols[7].strip()
            lon_str = cols[8].strip()
            if not lat_str or not lon_str:
                continue
            lat = float(lat_str[:-1]) / 100
            if lat_str[-1] == "S":
                lat = -lat
            lon = float(lon_str[:-1]) / 100
            if lon_str[-1] == "W":
                lon = -lon
        except (ValueError, IndexError):
            continue

        # Agency/technique (column 3) — e.g., SAB, TAFB, JTWC for Dvorak
        agency = cols[3].strip() if len(cols) > 3 else ""

        # Parse wind columns
        # Column 11: composite surface intensity estimate (kt)
        wind_11 = None
        try:
            v = cols[11].strip()
            if v:
                wind_11 = float(v)
        except (ValueError, IndexError):
            pass

        # Column 35: SFMR surface wind (kt)
        sfmr_wind = None
        try:
            if len(cols) > 35 and cols[35].strip():
                sfmr_wind = float(cols[35].strip())
        except (ValueError, IndexError):
            pass

        # Column 39: flight-level wind (kt)
        fl_wind = None
        try:
            if len(cols) > 39 and cols[39].strip():
                fl_wind = float(cols[39].strip())
        except (ValueError, IndexError):
            pass

        # ── Dvorak fixes: use column 11 (intensity), tag with agency ──
        if fix_type in ("DVTS", "DVTO"):
            if wind_11 is None:
                continue
            ci_keys = sorted(_DVORAK_CI_TO_KT.keys())
            ci_winds = [_DVORAK_CI_TO_KT[k] for k in ci_keys]
            nearest_idx = min(range(len(ci_winds)), key=lambda i: abs(ci_winds[i] - wind_11))
            fix = {
                "time": iso_dt,
                "lat": round(lat, 2),
                "lon": round(lon, 2),
                "wind_kt": round(wind_11),
                "ci": ci_keys[nearest_idx],
            }
            if agency:
                fix["agency"] = agency
            result[fix_type].append(fix)
            continue

        # ── AIRC fixes: split into SFMR / FL_WIND / DROPSONDE / OTHER ──
        base = {"time": iso_dt, "lat": round(lat, 2), "lon": round(lon, 2)}

        # SFMR surface wind (column 35)
        if sfmr_wind is not None:
            fix = dict(base, wind_kt=round(sfmr_wind), source="SFMR")
            result["SFMR"].append(fix)

        # Flight-level wind (column 39)
        if fl_wind is not None:
            # Parse flight-level altitude/pressure from column 40 if available
            fl_alt = ""
            try:
                if len(cols) > 40 and cols[40].strip():
                    fl_alt = cols[40].strip()
            except (IndexError, ValueError):
                pass
            fix = dict(base, wind_kt=round(fl_wind), source="FL")
            if fl_alt:
                fix["level"] = fl_alt
            result["FL_WIND"].append(fix)

        # Surface estimate (column 11) — only if neither SFMR nor FL present
        if wind_11 is not None and sfmr_wind is None and fl_wind is None:
            fix = dict(base, wind_kt=round(wind_11), source="DROPSONDE")
            result["DROPSONDE"].append(fix)

    return result


def _fetch_fdeck(atcf_id: str) -> dict | None:
    """Fetch and parse f-deck data for an ATCF storm ID (e.g., 'AL122024').

    Tries current-year fix directory first, then archive (gzipped).
    Returns parsed fix dict or None on failure.
    """
    # Check cache
    if atcf_id in _fdeck_cache:
        _fdeck_cache.move_to_end(atcf_id)
        return _fdeck_cache[atcf_id]

    # Parse ATCF ID: e.g., "AL122024" -> basin="al", num="12", year="2024"
    atcf_id = atcf_id.upper().strip()
    if len(atcf_id) < 8:
        return None

    basin = atcf_id[:2].lower()
    num = atcf_id[2:4]
    year = atcf_id[4:]

    import requests as req

    # Try current fix directory first (HTTP, not FTP)
    urls = [
        f"https://ftp.nhc.noaa.gov/atcf/fix/f{basin}{num}{year}.dat",
        f"https://ftp.nhc.noaa.gov/atcf/archive/{year}/f{basin}{num}{year}.dat.gz",
    ]

    raw_text = None
    for url in urls:
        try:
            logger.info(f"Fetching f-deck: {url}")
            resp = req.get(url, timeout=15, headers=_HTTP_HEADERS)
            if resp.status_code == 200:
                if url.endswith(".gz"):
                    import gzip
                    raw_text = gzip.decompress(resp.content).decode("utf-8", errors="replace")
                else:
                    raw_text = resp.text
                logger.info(f"F-deck fetched: {len(raw_text)} bytes from {url}")
                break
        except Exception as e:
            logger.warning(f"F-deck fetch failed for {url}: {e}")
            continue

    if not raw_text:
        return None

    parsed = _parse_fdeck(raw_text)

    # Cache result
    _fdeck_cache[atcf_id] = parsed
    if len(_fdeck_cache) > _FDECK_CACHE_MAX:
        _fdeck_cache.popitem(last=False)

    return parsed


@router.get("/fdeck")
def get_fdeck(atcf_id: str = Query(..., description="ATCF storm ID, e.g., AL122024")):
    """Fetch NHC f-deck intensity fixes for a storm.

    Returns parsed fix data for Subjective Dvorak (DVTS), Objective Dvorak (DVTO),
    and Aircraft (AIRC) fix types with time, lat, lon, wind speed, and CI number.
    """
    result = _fetch_fdeck(atcf_id)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"F-deck data not found for {atcf_id}. "
                   f"Data is only available for NHC-monitored storms (Atlantic/East Pacific).",
        )

    counts = {k: len(v) for k, v in result.items()}
    return JSONResponse(
        content={"atcf_id": atcf_id, "fixes": result, "counts": counts},
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ═══════════════════════════════════════════════════════════════
# ── ATCF A-DECK (MODEL FORECAST) PARSER ───────────────────────
# ═══════════════════════════════════════════════════════════════

_adeck_cache: OrderedDict = OrderedDict()
_ADECK_CACHE_MAX = 30

# Models we care about — the "leading" dynamical & statistical models
# Tech IDs from ATCF: https://www.nrlmry.navy.mil/atcf_web/docs/database/new/
ADECK_MODELS = {
    # Official forecasts — show only final official (OFCL / JTWC)
    "OFCL": {"name": "NHC Official",  "color": "#ff4757", "type": "official", "interp": True},
    "JTWC": {"name": "JTWC Official", "color": "#ffa502", "type": "official", "interp": True},
    # Dynamical models — interpolated (corrected to observed position at t=0)
    # These are what NHC uses for verification — default display
    "AVNI": {"name": "GFS",       "color": "#ff6b6b", "type": "dynamical", "interp": True},
    "EMXI": {"name": "ECMWF",     "color": "#4ecdc4", "type": "dynamical", "interp": True},
    "CMCI": {"name": "CMC",       "color": "#ffe66d", "type": "dynamical", "interp": True},
    "UKMI": {"name": "UKMET",     "color": "#a29bfe", "type": "dynamical", "interp": True},
    "NGMI": {"name": "NAVGEM",    "color": "#6c5ce7", "type": "dynamical", "interp": True},
    "HWFI": {"name": "HWRF",      "color": "#00b894", "type": "dynamical", "interp": True},
    "HMNI": {"name": "HMON",      "color": "#e17055", "type": "dynamical", "interp": True},
    "EEMN": {"name": "ECMWF-EPS", "color": "#45b7aa", "type": "dynamical", "interp": True},
    # Dynamical models — non-interpolated (raw model output, may have initial position error)
    "AVNO": {"name": "GFS",       "color": "#ff6b6b", "type": "dynamical", "interp": False},
    "GFSO": {"name": "GFS",       "color": "#ff6b6b", "type": "dynamical", "interp": False},
    "EMX":  {"name": "ECMWF",     "color": "#4ecdc4", "type": "dynamical", "interp": False},
    "CMC":  {"name": "CMC",       "color": "#ffe66d", "type": "dynamical", "interp": False},
    "UKM":  {"name": "UKMET",     "color": "#a29bfe", "type": "dynamical", "interp": False},
    "NVGM": {"name": "NAVGEM",    "color": "#6c5ce7", "type": "dynamical", "interp": False},
    "HWRF": {"name": "HWRF",      "color": "#00b894", "type": "dynamical", "interp": False},
    "HMON": {"name": "HMON",      "color": "#e17055", "type": "dynamical", "interp": False},
    "NAM":  {"name": "NAM",       "color": "#fd79a8", "type": "dynamical", "interp": False},
    "HAFS": {"name": "HAFS-A",    "color": "#00cec9", "type": "dynamical", "interp": False},
    "HAFA": {"name": "HAFS-A",    "color": "#00cec9", "type": "dynamical", "interp": False},
    "HAFB": {"name": "HAFS-B",    "color": "#81ecec", "type": "dynamical", "interp": False},
    # HAFS operational (2023+) — replaced HWRF (→HFSA) and HMON (→HFSB)
    "HFSA": {"name": "HAFS-A",    "color": "#00cec9", "type": "dynamical", "interp": False},
    "HFSB": {"name": "HAFS-B",    "color": "#81ecec", "type": "dynamical", "interp": False},
    "HFAI": {"name": "HAFS-A",    "color": "#00cec9", "type": "dynamical", "interp": True},
    "HFBI": {"name": "HAFS-B",    "color": "#81ecec", "type": "dynamical", "interp": True},
    "CTCX": {"name": "COAMPS-TC", "color": "#fab1a0", "type": "dynamical", "interp": False},
    "COTC": {"name": "COAMPS-TC", "color": "#fab1a0", "type": "dynamical", "interp": False},
    "COTI": {"name": "COAMPS-TC", "color": "#fab1a0", "type": "dynamical", "interp": True},
    "GFDN": {"name": "GFDL-Navy", "color": "#e17055", "type": "dynamical", "interp": False},
    "GFNI": {"name": "GFDL-Navy", "color": "#e17055", "type": "dynamical", "interp": True},
    "AVNX": {"name": "GFS",       "color": "#ff6b6b", "type": "dynamical", "interp": False},
    "NGX":  {"name": "NAVGEM",    "color": "#6c5ce7", "type": "dynamical", "interp": False},
    "AEMN": {"name": "GFS-EPS",   "color": "#ff8a80", "type": "consensus", "interp": False},
    "NEMN": {"name": "NAVGEM-EPS","color": "#b388ff", "type": "consensus", "interp": False},
    "CEMN": {"name": "CMC-EPS",   "color": "#fff176", "type": "consensus", "interp": False},
    "CHIP": {"name": "CHIPS",     "color": "#ce93d8", "type": "statistical","interp": False},
    "JGSM": {"name": "JGSM",      "color": "#b2bec3", "type": "dynamical", "interp": False},
    # Legacy dynamical models (1990s–early 2000s)
    "GFDL": {"name": "GFDL",      "color": "#e17055", "type": "dynamical", "interp": False},
    "GFDI": {"name": "GFDL",      "color": "#e17055", "type": "dynamical", "interp": True},
    "NGPS": {"name": "NOGAPS",    "color": "#6c5ce7", "type": "dynamical", "interp": False},
    "NGPI": {"name": "NOGAPS",    "color": "#6c5ce7", "type": "dynamical", "interp": True},
    "UKMO": {"name": "UKMET",     "color": "#a29bfe", "type": "dynamical", "interp": False},
    "ETA":  {"name": "Eta",       "color": "#fd79a8", "type": "dynamical", "interp": False},
    "ETAI": {"name": "Eta",       "color": "#fd79a8", "type": "dynamical", "interp": True},
    "QLM":  {"name": "QLM",       "color": "#e056a0", "type": "dynamical", "interp": False},
    "QLMI": {"name": "QLM",       "color": "#e056a0", "type": "dynamical", "interp": True},
    "AVN":  {"name": "AVN",       "color": "#ff6b6b", "type": "dynamical", "interp": False},
    "AVNI": {"name": "AVN",       "color": "#ff6b6b", "type": "dynamical", "interp": True},
    "MFM":  {"name": "MFM",       "color": "#cf6a87", "type": "dynamical", "interp": False},
    "MRFO": {"name": "MRF",       "color": "#ff7979", "type": "dynamical", "interp": False},
    # Legacy statistical/trajectory models (baselines + BAM family)
    "LBAR": {"name": "LBAR",      "color": "#dfe6e9", "type": "statistical", "interp": False},
    "VBAR": {"name": "VICBAR",    "color": "#c8d6e5", "type": "statistical", "interp": False},
    "BAMD": {"name": "BAM Deep",  "color": "#b2bec3", "type": "statistical", "interp": False},
    "BAMM": {"name": "BAM Medium","color": "#a0a8b0", "type": "statistical", "interp": False},
    "BAMS": {"name": "BAM Shallow","color":"#8e96a0", "type": "statistical", "interp": False},
    "CLIP": {"name": "CLIPER",    "color": "#636e72", "type": "statistical", "interp": False},
    "CLP5": {"name": "CLIPER 5d", "color": "#636e72", "type": "statistical", "interp": False},
    "SHF5": {"name": "SHIFOR 5d", "color": "#b8a07e", "type": "statistical", "interp": False},
    "SHFR": {"name": "SHIFOR",    "color": "#b8a07e", "type": "statistical", "interp": False},
    "XTRP": {"name": "Extrap",    "color": "#576574", "type": "statistical", "interp": False},
    "A90E": {"name": "NHC90",     "color": "#a29bfe", "type": "statistical", "interp": False},
    "A98E": {"name": "NHC98",     "color": "#a29bfe", "type": "statistical", "interp": False},
    "SBAR": {"name": "SANBAR",    "color": "#7f8fa6", "type": "statistical", "interp": False},
    "SANL": {"name": "SANL",      "color": "#7f8fa6", "type": "statistical", "interp": False},
    # Legacy consensus aids
    "CONU": {"name": "CONU Con",  "color": "#dcdde1", "type": "consensus", "interp": False},
    # Statistical models
    "SHIP": {"name": "SHIPS",     "color": "#ffeaa7", "type": "statistical", "interp": True},
    "SHIA": {"name": "SHIPS-A",   "color": "#ffeaa7", "type": "statistical", "interp": True},
    "DSHP": {"name": "DSHIPS",    "color": "#fdcb6e", "type": "statistical", "interp": True},
    "LGEM": {"name": "LGEM",      "color": "#e2b04a", "type": "statistical", "interp": True},
    "RVCN": {"name": "RVCN",      "color": "#dfe6e9", "type": "statistical", "interp": True},
    # AI / Machine Learning models
    "GENI": {"name": "GenCast",      "color": "#00ff87", "type": "ai", "interp": True},
    "GEN2": {"name": "GenCast",      "color": "#00ff87", "type": "ai", "interp": False},
    "GRPI": {"name": "GraphCast",    "color": "#00e676", "type": "ai", "interp": True},
    "GRPH": {"name": "GraphCast",    "color": "#00e676", "type": "ai", "interp": False},
    "GRP2": {"name": "GraphCast",    "color": "#00e676", "type": "ai", "interp": False},
    "PTSI": {"name": "Pangu",        "color": "#76ff03", "type": "ai", "interp": True},
    "APTS": {"name": "Pangu",        "color": "#76ff03", "type": "ai", "interp": False},
    "AIFI": {"name": "ECMWF-AIFS",   "color": "#69f0ae", "type": "ai", "interp": True},
    "AIFS": {"name": "ECMWF-AIFS",   "color": "#69f0ae", "type": "ai", "interp": False},
    # Consensus aids (already interpolated by definition)
    "TVCN": {"name": "TVCA Con",  "color": "#ffffff", "type": "consensus", "interp": True},
    "TVCE": {"name": "TVCE Con",  "color": "#f0f0f0", "type": "consensus", "interp": True},
    "TVCA": {"name": "TVCA Con",  "color": "#ffffff", "type": "consensus", "interp": True},
    "TVCX": {"name": "TVCX Con",  "color": "#e0e0e0", "type": "consensus", "interp": True},
    "IVCN": {"name": "IVCN Con",  "color": "#dfe6e9", "type": "consensus", "interp": True},
    "ICON": {"name": "ICON Con",  "color": "#c8d6e5", "type": "consensus", "interp": True},
    "FSSE": {"name": "FSU Super", "color": "#74b9ff", "type": "consensus", "interp": True},
    "GUNA": {"name": "GUNS Con",  "color": "#b2bec3", "type": "consensus", "interp": True},
    "CGUN": {"name": "Corr GUNS", "color": "#636e72", "type": "consensus", "interp": True},
}


def _parse_adeck(raw_text: str) -> dict:
    """Parse an ATCF a-deck file into structured forecast data.

    Returns: {
        "cycles": {
            "2017090506": {    # init time YYYYMMDDHH
                "AVNO": {
                    "tech": "AVNO", "name": "GFS", "color": "#ff6b6b",
                    "points": [
                        {"tau": 0, "lat": 17.4, "lon": -57.2, "wind": 115, "pres": 940},
                        {"tau": 12, "lat": 18.1, "lon": -58.5, "wind": 110, "pres": 945},
                        ...
                    ]
                },
                ...
            },
            ...
        },
        "init_times": ["2017083000", "2017083006", ...],  # sorted
        "models": ["AVNO", "EMX", "HWRF", ...],           # unique models found
    }
    """
    cycles = {}
    models_seen = set()

    for line in raw_text.splitlines():
        line = line.strip()
        if not line:
            continue

        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 12:
            continue

        # ATCF a-deck columns:
        # 0: BASIN (AL, EP, WP, ...)
        # 1: CY (storm number 01-99)
        # 2: YYYYMMDDHH (init datetime)
        # 3: TECHNUM/MIN
        # 4: TECH (model ID)
        # 5: TAU (forecast hour)
        # 6: LatN/S (tenths of degrees, e.g., "174N")
        # 7: LonE/W (tenths of degrees, e.g., "572W")
        # 8: VMAX (kt)
        # 9: MSLP (hPa)
        # 10: TY (development level: TD, TS, HU, etc.)
        # 11+: wind radii and other fields

        try:
            init_time = parts[2].strip()
            tech = parts[4].strip().upper()
            tau = int(parts[5]) if parts[5].strip() else 0

            # Only keep models we care about
            if tech not in ADECK_MODELS:
                continue

            # Skip negative taus (CARQ/WRNG historical records)
            if tau < 0:
                continue

            # Parse latitude (tenths of degrees, N/S suffix)
            lat_str = parts[6].strip()
            if not lat_str:
                continue
            lat_hemi = lat_str[-1].upper() if lat_str[-1].isalpha() else "N"
            lat_val = float(lat_str[:-1]) / 10.0 if lat_str[-1].isalpha() else float(lat_str) / 10.0
            if lat_hemi == "S":
                lat_val = -lat_val

            # Parse longitude (tenths of degrees, E/W suffix)
            lon_str = parts[7].strip()
            if not lon_str:
                continue
            lon_hemi = lon_str[-1].upper() if lon_str[-1].isalpha() else "E"
            lon_val = float(lon_str[:-1]) / 10.0 if lon_str[-1].isalpha() else float(lon_str) / 10.0
            if lon_hemi == "W":
                lon_val = -lon_val

            # Parse wind and pressure (may be blank)
            wind = int(parts[8]) if parts[8].strip() else None
            pres = int(parts[9]) if parts[9].strip() else None

            # Build point
            point = {"tau": tau, "lat": round(lat_val, 2), "lon": round(lon_val, 2)}
            if wind is not None and wind > 0:
                point["wind"] = wind
            if pres is not None and pres > 0:
                point["pres"] = pres

            # Insert into cycles dict
            if init_time not in cycles:
                cycles[init_time] = {}

            if tech not in cycles[init_time]:
                model_info = ADECK_MODELS[tech]
                cycles[init_time][tech] = {
                    "tech": tech,
                    "name": model_info["name"],
                    "color": model_info["color"],
                    "type": model_info["type"],
                    "interp": model_info.get("interp", True),
                    "points": [],
                }

            cycles[init_time][tech]["points"].append(point)
            models_seen.add(tech)

        except (ValueError, IndexError):
            continue

    # Sort points within each forecast by tau
    for init_time in cycles:
        for tech in cycles[init_time]:
            cycles[init_time][tech]["points"].sort(key=lambda p: p["tau"])

    # Build sorted init times list
    init_times = sorted(cycles.keys())

    return {
        "cycles": cycles,
        "init_times": init_times,
        "models": sorted(models_seen),
    }


def _fetch_adeck(atcf_id: str) -> dict | None:
    """Fetch and parse a-deck model forecast data for an ATCF storm ID.

    Tries multiple sources in order:
      1. NHC current aid directory (active storms, all basins NHC monitors)
      2. NHC archive (historical, all basins including JTWC: AL, EP, CP, WP, IO, SH)
      3. NRL ATCF server (Naval Research Lab, primary JTWC source)
      4. UCAR TC Guidance Project repository (global aggregator)

    Returns parsed forecast dict or None on failure.
    """
    if atcf_id in _adeck_cache:
        _adeck_cache.move_to_end(atcf_id)
        return _adeck_cache[atcf_id]

    atcf_id = atcf_id.upper().strip()
    if len(atcf_id) < 8:
        return None

    basin = atcf_id[:2].lower()
    num = atcf_id[2:4]
    year = atcf_id[4:]

    import requests as req

    fname = f"a{basin}{num}{year}"

    def _fetch_url(url: str) -> str | None:
        """Fetch a single a-deck URL, return decoded text or None."""
        try:
            logger.info(f"Fetching a-deck: {url}")
            resp = req.get(url, timeout=20, headers=_HTTP_HEADERS)
            if resp.status_code == 200 and len(resp.content) > 100:
                if url.endswith(".gz"):
                    import gzip
                    text = gzip.decompress(resp.content).decode("utf-8", errors="replace")
                else:
                    text = resp.text
                logger.info(f"A-deck fetched: {len(text)} bytes from {url}")
                return text
        except Exception as e:
            logger.warning(f"A-deck fetch failed for {url}: {e}")
        return None

    if basin in ("al", "ep", "cp"):
        # NHC-monitored basins — NHC FTP is primary, one file has all models
        urls = [
            f"https://ftp.nhc.noaa.gov/atcf/aid_public/{fname}.dat.gz",
            f"https://ftp.nhc.noaa.gov/atcf/aid/{fname}.dat",
            f"https://ftp.nhc.noaa.gov/atcf/archive/{year}/{fname}.dat.gz",
            f"https://hurricanes.ral.ucar.edu/repository/data/adecks_open/{year}/{fname}.dat",
            f"https://ftp.nhc.noaa.gov/atcf/archive/{year}/{fname}.dat",
        ]
        # For NHC basins, one file has everything — stop at first success
        raw_text = None
        source = None
        for url in urls:
            text = _fetch_url(url)
            if text:
                raw_text = text
                source = url
                break
    else:
        # JTWC-monitored basins (WP, IO, SH)
        # A-deck data is fragmented across multiple data providers:
        #   - UCAR real-time : best source for ACTIVE JTWC storms (comprehensive)
        #   - NHC aid_public : sometimes mirrors JTWC active storms
        #   - adecks_open/   : HWRF and various models (archive)
        #   - fnmoc/         : NVGM, COTC, GFDN, NAVGEM ensembles
        #   - nrlmry/        : CTCX and other Navy models (2015+ only)
        # We COMBINE data from all available sources for the fullest picture.

        # UCAR real-time basin path mapping
        _UCAR_RT_BASINS = {
            "wp": "northwestpacific",
            "io": "northindian",
            "sh": "southernhemisphere",
        }

        raw_text = None
        source = None
        combined_parts = []
        sources_used = []

        # 1. Try UCAR real-time first — best source for ACTIVE JTWC storms
        ucar_rt_basin = _UCAR_RT_BASINS.get(basin)
        if ucar_rt_basin:
            ucar_rt_url = (
                f"https://hurricanes.ral.ucar.edu/realtime/plots/"
                f"{ucar_rt_basin}/{year}/{atcf_id.lower()}/{fname}.dat"
            )
            text = _fetch_url(ucar_rt_url)
            if text and len(text) > 500:
                raw_text = text
                source = ucar_rt_url

        # 2. Try NHC aid_public (sometimes mirrors JTWC active storms)
        if not raw_text:
            nhc_url = f"https://ftp.nhc.noaa.gov/atcf/aid_public/{fname}.dat.gz"
            text = _fetch_url(nhc_url)
            if text and len(text) > 5000:
                raw_text = text
                source = nhc_url

        if not raw_text:
            # 3. Historical storm — combine from multiple UCAR RAL directories
            ucar_sources = [
                f"https://hurricanes.ral.ucar.edu/repository/data/adecks_open/{year}/{fname}.dat",
                f"https://hurricanes.ral.ucar.edu/repository/data/fnmoc/{year}/{fname}.dat",
                f"https://hurricanes.ral.ucar.edu/repository/data/nrlmry/{year}/{fname}.dat",
            ]
            for url in ucar_sources:
                text = _fetch_url(url)
                if text:
                    combined_parts.append(text)
                    sources_used.append(url)

            # Also try NRL direct and NHC archive as fallbacks
            fallback_urls = [
                f"https://science.nrlmry.navy.mil/atcf/aidarchive/{year}/{fname}.dat.gz",
                f"https://science.nrlmry.navy.mil/atcf/archive/{year}/{fname}.dat.gz",
                f"https://ftp.nhc.noaa.gov/atcf/archive/{year}/{fname}.dat",
            ]
            if not combined_parts:
                for url in fallback_urls:
                    text = _fetch_url(url)
                    if text:
                        combined_parts.append(text)
                        sources_used.append(url)
                        break  # Fallbacks are single-source, stop at first

            if combined_parts:
                raw_text = "\n".join(combined_parts)
                source = " + ".join(sources_used)
                logger.info(f"A-deck combined from {len(sources_used)} sources: {source}")

    if not raw_text:
        return None

    parsed = _parse_adeck(raw_text)
    parsed["source"] = source

    # Cache result
    _adeck_cache[atcf_id] = parsed
    if len(_adeck_cache) > _ADECK_CACHE_MAX:
        _adeck_cache.popitem(last=False)

    return parsed


@router.get("/adeck")
def get_adeck(atcf_id: str = Query(..., description="ATCF storm ID, e.g., AL092017")):
    """Fetch ATCF a-deck model forecast tracks for a storm.

    Returns forecast cycles grouped by init time, with track and intensity
    forecast points for each model. Includes ~40 leading dynamical models,
    statistical models, and consensus aids.
    """
    result = _fetch_adeck(atcf_id)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"A-deck data not found for {atcf_id}. "
                   f"Data is only available for NHC/JTWC-monitored storms.",
        )

    return JSONResponse(
        content={
            "atcf_id": atcf_id,
            "cycles": result["cycles"],
            "init_times": result["init_times"],
            "models": result["models"],
            "n_cycles": len(result["init_times"]),
        },
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ── SHIPS Developmental Data (LSDIAG) ──────────────────────────
# Environmental diagnostics from the SHIPS statistical model.
# Available for Atlantic (AL), East Pacific (EP), and Central Pacific (CP).
# Source: CIRA/RAMMB developmental dataset & NHC ATCF lsdiag files.

# Variables we extract and their descriptions / scale factors
SHIPS_VARIABLES = {
    # Shear variables (kt)
    "SHDC": {"name": "Deep Shear (centered)", "unit": "kt", "scale": 0.1, "group": "shear",
             "desc": "200-850 hPa shear magnitude centered on vortex"},
    "SHGC": {"name": "Generalized Shear", "unit": "kt", "scale": 0.1, "group": "shear",
             "desc": "Generalized 200-850 hPa shear accounting for vortex depth"},
    "SHRD": {"name": "Deep Shear (area avg)", "unit": "kt", "scale": 0.1, "group": "shear",
             "desc": "200-850 hPa shear magnitude, 0-500 km area average"},
    # SST / Ocean
    "RSST": {"name": "SST", "unit": "°C", "scale": 0.1, "group": "ocean",
             "desc": "Reynolds SST at storm center"},
    "COHC": {"name": "Ocean Heat Content", "unit": "kJ/cm²", "scale": 0.1, "group": "ocean",
             "desc": "Ocean heat content from NCODA"},
    "VMPI": {"name": "Max Potential Intensity", "unit": "kt", "scale": 0.1, "group": "ocean",
             "desc": "Maximum potential intensity (Emanuel)"},
    # Moisture / Thermodynamic
    "RHMD": {"name": "Mid-level RH", "unit": "%", "scale": 0.1, "group": "moisture",
             "desc": "700-500 hPa relative humidity, 200-800 km annulus"},
    "RHLO": {"name": "Low-level RH", "unit": "%", "scale": 0.1, "group": "moisture",
             "desc": "850-700 hPa relative humidity, 200-800 km annulus"},
    "MTPW": {"name": "Total Precip. Water", "unit": "mm", "scale": 0.1, "group": "moisture",
             "desc": "Total precipitable water at t=0 from GFS analysis"},
    # Upper-level dynamics
    "D200": {"name": "200 hPa Divergence", "unit": "×10⁻⁷/s", "scale": 0.1, "group": "dynamics",
             "desc": "200 hPa divergence, 0-1000 km area"},
    "T200": {"name": "200 hPa Temp", "unit": "°C", "scale": 0.1, "group": "dynamics",
             "desc": "200 hPa temperature at storm center"},
    "PENV": {"name": "Environmental Pressure", "unit": "hPa", "scale": 0.1, "group": "dynamics",
             "desc": "Pressure of the outermost closed isobar"},
    # Vortex parameters
    "VMAX": {"name": "Best Track Vmax", "unit": "kt", "scale": 1.0, "group": "vortex",
             "desc": "Best track maximum sustained wind (from HEAD line)"},
}

# Which variables to return by default
SHIPS_DEFAULT_VARS = ["SHDC", "SHGC", "RSST", "COHC", "VMPI", "RHMD", "MTPW", "D200"]

# Tau offsets for 7-day files (hours relative to init time)
_SHIPS_TAUS_7DAY = list(range(-12, 169, 6))  # -12, -6, 0, 6, ..., 168
_SHIPS_TAUS_5DAY = list(range(-12, 121, 6))  # -12, -6, 0, ..., 120

_ships_cache: OrderedDict = OrderedDict()
_SHIPS_CACHE_MAX = 20


def _parse_ships_lsdiag(raw_text: str, atcf_id: str) -> dict:
    """Parse a SHIPS LSDIAG developmental data file.

    The file contains cases for one or more storms. Each case starts with a
    HEAD line and ends with a LAST line. Between them are predictor lines,
    each containing values at different forecast hours (-12 through +168h).

    HEAD line format (space-delimited):
        HEAD basin storm_num YYYYMMDDHH storm_name lat lon vmax mslp ...

    Predictor lines:
        val1  val2  val3  ... varname

    Values are integers, scaled (usually *10). Missing = 9999.

    Returns: {
        "cases": [
            {
                "init_time": "2017090506",
                "storm_name": "IRMA",
                "lat": 17.4, "lon": -57.2,
                "vmax": 115, "mslp": 940,
                "predictors": {
                    "SHDC": [{"tau": -12, "val": 12.3}, {"tau": -6, "val": 11.8}, ...],
                    "RSST": [...],
                    ...
                }
            },
            ...
        ],
        "variables": ["SHDC", "SHGC", ...],  # variables found
        "n_cases": 42,
    }
    """
    cases = []
    current_case = None
    variables_found = set()

    lines = raw_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1

        if not line:
            continue

        # Check for HEAD line
        if line.startswith("HEAD"):
            # Parse HEAD line — format varies but key fields are identifiable
            parts = line.split()
            if len(parts) < 8:
                continue

            try:
                # Typical: HEAD AL 09 2017090506 IRMA 17.4N 57.2W 115 940 ...
                # or:      HEAD  AL, 09, 2017090506, IRMA, ...
                # Try comma-separated first, then space-separated
                if "," in line:
                    cparts = [p.strip() for p in line.split(",")]
                    # HEAD, basin, num, datetime, name, lat, lon, vmax, mslp
                    init_time = cparts[2].strip() if len(cparts) > 2 else ""
                    storm_name = cparts[3].strip() if len(cparts) > 3 else ""
                    lat_str = cparts[4].strip() if len(cparts) > 4 else ""
                    lon_str = cparts[5].strip() if len(cparts) > 5 else ""
                    vmax_str = cparts[6].strip() if len(cparts) > 6 else ""
                    mslp_str = cparts[7].strip() if len(cparts) > 7 else ""
                else:
                    init_time = parts[3] if len(parts) > 3 else ""
                    storm_name = parts[4] if len(parts) > 4 else ""
                    lat_str = parts[5] if len(parts) > 5 else ""
                    lon_str = parts[6] if len(parts) > 6 else ""
                    vmax_str = parts[7] if len(parts) > 7 else ""
                    mslp_str = parts[8] if len(parts) > 8 else ""

                # Parse lat/lon with N/S/E/W suffix
                lat = _parse_ships_coord(lat_str, "NS")
                lon = _parse_ships_coord(lon_str, "EW")

                vmax = int(float(vmax_str)) if vmax_str and vmax_str != "9999" else None
                mslp = int(float(mslp_str)) if mslp_str and mslp_str != "9999" else None

                current_case = {
                    "init_time": init_time[:10] if len(init_time) >= 10 else init_time,
                    "storm_name": storm_name,
                    "lat": lat,
                    "lon": lon,
                    "vmax": vmax,
                    "mslp": mslp,
                    "predictors": {},
                }
            except (ValueError, IndexError):
                current_case = None
            continue

        # Check for LAST line — finalize case
        if line.startswith("LAST") or line.endswith("LAST"):
            if current_case is not None:
                cases.append(current_case)
                current_case = None
            continue

        # Predictor line: values followed by variable name at end
        if current_case is None:
            continue

        # The variable name is the last token (4 chars, alpha)
        parts = line.split()
        if len(parts) < 2:
            continue

        varname = parts[-1].strip()
        if not varname.isalpha() or len(varname) > 6:
            continue

        # Only extract variables we care about
        if varname not in SHIPS_VARIABLES:
            continue

        # Parse values (all tokens except the last one = varname)
        vals = parts[:-1]
        scale = SHIPS_VARIABLES[varname]["scale"]

        # Determine tau list based on number of values
        if len(vals) >= 28:
            taus = _SHIPS_TAUS_7DAY[:len(vals)]
        else:
            taus = _SHIPS_TAUS_5DAY[:len(vals)]

        series = []
        for j, v in enumerate(vals):
            try:
                ival = int(float(v))
                if ival == 9999 or ival == -9999:
                    continue
                tau = taus[j] if j < len(taus) else j * 6 - 12
                series.append({"tau": tau, "val": round(ival * scale, 2)})
            except (ValueError, IndexError):
                continue

        if series:
            current_case["predictors"][varname] = series
            variables_found.add(varname)

    # If file ended without LAST, add final case
    if current_case is not None and current_case.get("predictors"):
        cases.append(current_case)

    return {
        "cases": cases,
        "variables": sorted(variables_found),
        "n_cases": len(cases),
    }


def _parse_ships_coord(s: str, axes: str = "NS") -> float | None:
    """Parse a coordinate string like '17.4N' or '57.2W'."""
    if not s:
        return None
    s = s.strip()
    try:
        if s[-1].upper() in "NSEW":
            val = float(s[:-1])
            if s[-1].upper() in ("S", "W"):
                val = -val
            return round(val, 2)
        else:
            return round(float(s), 2)
    except (ValueError, IndexError):
        return None


def _fetch_ships(atcf_id: str) -> dict | None:
    """Fetch SHIPS developmental / LSDIAG data for a storm.

    Tries multiple sources:
      1. CIRA/RAMMB 7-day developmental data (bulk per basin/year)
      2. CIRA/RAMMB 5-day developmental data (older, but more complete)
      3. NHC ATCF lsdiag directory (per-storm diagnostic files)

    For bulk files, we filter to only the requested storm.
    Returns parsed dict or None on failure.
    """
    if atcf_id in _ships_cache:
        _ships_cache.move_to_end(atcf_id)
        return _ships_cache[atcf_id]

    atcf_id = atcf_id.upper().strip()
    if len(atcf_id) < 8:
        return None

    basin = atcf_id[:2].lower()
    num = atcf_id[2:4]
    year = atcf_id[4:]

    # SHIPS only available for AL, EP, CP
    if basin not in ("al", "ep", "cp"):
        return None

    import requests as req

    # URL patterns for CIRA/RAMMB developmental data
    # Files are per-basin, per-year: lsdiag_{basin}_7day_{year}.dat
    urls = [
        # RAMMB-data server (new CDN)
        f"https://rammb-data.cira.colostate.edu/ships/data/lsdiag_{basin}_7day_{year}.dat",
        # RAMMB main site
        f"https://rammb2.cira.colostate.edu/research/tropical-cyclones/ships/development_data/lsdiag_{basin}_7day_{year}.dat",
        # 5-day fallback
        f"https://rammb-data.cira.colostate.edu/ships/data/lsdiag_{basin}_5day_{year}.dat",
        f"https://rammb2.cira.colostate.edu/research/tropical-cyclones/ships/development_data/lsdiag_{basin}_5day_{year}.dat",
    ]

    raw_text = None
    source = None
    for url in urls:
        try:
            logger.info(f"Fetching SHIPS LSDIAG: {url}")
            resp = req.get(url, timeout=30, headers=_HTTP_HEADERS)
            if resp.status_code == 200 and len(resp.content) > 200:
                raw_text = resp.text
                source = url
                logger.info(f"SHIPS LSDIAG fetched: {len(raw_text)} bytes from {url}")
                break
        except Exception as e:
            logger.warning(f"SHIPS LSDIAG fetch failed for {url}: {e}")
            continue

    if not raw_text:
        return None

    # Parse the full file
    parsed = _parse_ships_lsdiag(raw_text, atcf_id)
    parsed["source"] = source
    parsed["basin"] = basin.upper()

    # The bulk file has ALL storms for this basin/year.
    # We filter to only the relevant storm number.
    # Storm identification: check init_time year matches and filter by proximity
    # to the storm's known positions (from best track).
    # For simplicity, we rely on storm_name matching or case timing.
    # The ATCF storm number (e.g., 09) corresponds to the 9th storm in the basin.
    # SHIPS HEAD lines include this.

    # Cache the full parsed result (includes all cases for the storm)
    _ships_cache[atcf_id] = parsed
    if len(_ships_cache) > _SHIPS_CACHE_MAX:
        _ships_cache.popitem(last=False)

    return parsed


@router.get("/ships")
def get_ships(atcf_id: str = Query(..., description="ATCF storm ID, e.g., AL092017")):
    """Fetch SHIPS environmental diagnostics (LSDIAG) for a storm.

    Returns time series of key environmental predictors (shear, SST, OHC,
    moisture, etc.) from the SHIPS developmental dataset.

    Only available for Atlantic (AL), East Pacific (EP), and Central Pacific (CP) storms.
    """
    atcf_id = atcf_id.upper().strip()
    basin = atcf_id[:2].upper() if len(atcf_id) >= 2 else ""

    if basin not in ("AL", "EP", "CP"):
        return JSONResponse(
            content={
                "atcf_id": atcf_id,
                "available": False,
                "reason": f"SHIPS data only available for AL/EP/CP basins, not {basin}",
                "cases": [],
                "variables": [],
            },
            headers={"Cache-Control": "public, max-age=3600"},
        )

    result = _fetch_ships(atcf_id)
    if result is None:
        return JSONResponse(
            content={
                "atcf_id": atcf_id,
                "available": False,
                "reason": "SHIPS LSDIAG data not found for this storm/year",
                "cases": [],
                "variables": [],
            },
            headers={"Cache-Control": "public, max-age=3600"},
        )

    return JSONResponse(
        content={
            "atcf_id": atcf_id,
            "available": True,
            "cases": result["cases"],
            "variables": result["variables"],
            "n_cases": result["n_cases"],
            "source": result.get("source", ""),
            "variable_meta": {
                k: {
                    "name": v["name"],
                    "unit": v["unit"],
                    "group": v["group"],
                    "desc": v["desc"],
                } for k, v in SHIPS_VARIABLES.items()
            },
        },
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ── TC-PRIMED Environmental Diagnostics (ERA5-based) ────────
# Global environmental context from TC-PRIMED env files.
# Uses ERA5 reanalysis — available for all basins (unlike SHIPS LSDIAG).
# Source: s3://noaa-nesdis-tcprimed-pds/v01r01/final/{season}/{basin}/{num}/
#         TCPRIMED_v01r01-final_{ATCF_ID}_env_s{start}_e{end}.nc
#
# The env file is ~230 MB per storm (mostly gridded fields).
# We only read the `diagnostics` + `storm_metadata` groups (~1-2 MB).
# Results are cached as lightweight JSON in GCS for instant subsequent access.

_TCPRIMED_BUCKET = "noaa-nesdis-tcprimed-pds"
_TCPRIMED_PREFIX = "v01r01/final"

# ATCF basin -> TC-PRIMED directory mapping
_TCPRIMED_BASIN_MAP = {
    "AL": "AL", "EP": "EP", "CP": "CP",
    "WP": "WP", "IO": "IO", "SH": "SH",
}

# IBTrACS basin codes -> ATCF basin
_IBTRACS_TO_ATCF_BASIN = {
    "NA": "AL", "EP": "EP", "WP": "WP",
    "NI": "IO", "SI": "SH", "SP": "SH", "SA": "AL",
}

# Variables to extract from the diagnostics group
_TCPRIMED_ENV_VARS = {
    "sst": {
        "name": "Sea Surface Temperature", "unit": "K", "group": "ocean",
        "desc": "ERA5 sea surface temperature at storm center",
    },
    "potential_intensity_theoretical": {
        "name": "Theoretical MPI", "unit": "kt", "group": "ocean",
        "desc": "Theoretical maximum potential intensity (Emanuel)",
    },
    "potential_intensity_empirical": {
        "name": "Empirical MPI", "unit": "kt", "group": "ocean",
        "desc": "Empirically derived maximum potential intensity",
    },
    "shear_magnitude": {
        "name": "Vertical Wind Shear", "unit": "m/s", "group": "shear",
        "desc": "Layered vertical wind shear magnitude (deep & shallow, multiple radii)",
    },
    "shear_direction": {
        "name": "Shear Direction", "unit": "deg", "group": "shear",
        "desc": "Direction of the vertical wind shear vector",
    },
    "shear_generalized": {
        "name": "Generalized Shear", "unit": "m/s", "group": "shear",
        "desc": "Generalized vertical wind shear magnitude",
    },
    "relative_humidity": {
        "name": "Relative Humidity", "unit": "%", "group": "moisture",
        "desc": "Relative humidity vertical profile at multiple radii",
    },
    "precipitable_water": {
        "name": "Precipitable Water", "unit": "kg/m²", "group": "moisture",
        "desc": "Total column precipitable water in radial bins",
    },
    "divergence": {
        "name": "Divergence", "unit": "1/s", "group": "dynamics",
        "desc": "Divergence vertical profile (area-averaged)",
    },
    "vorticity": {
        "name": "Relative Vorticity", "unit": "1/s", "group": "dynamics",
        "desc": "Relative vorticity vertical profile (area-averaged)",
    },
    "temperature_anomaly": {
        "name": "Warm-Core Anomaly", "unit": "K", "group": "dynamics",
        "desc": "Warm-core temperature anomaly relative to environment at 1500 km",
    },
    "central_min_pressure": {
        "name": "Central Pressure", "unit": "hPa", "group": "vortex",
        "desc": "Minimum central mean sea level pressure",
    },
    "cyclone_phase_space_b_parameter": {
        "name": "CPS B Parameter", "unit": "m", "group": "phase",
        "desc": "Hart CPS B parameter (900-600 hPa thickness asymmetry)",
    },
    "cyclone_phase_space_thermal_wind": {
        "name": "CPS Thermal Wind", "unit": "m/s", "group": "phase",
        "desc": "Hart CPS thermal wind (lower & upper level)",
    },
    "theta_e": {
        "name": "Equiv. Potential Temp", "unit": "K", "group": "thermo",
        "desc": "Equivalent potential temperature vertical profile",
    },
}

# In-memory LRU + GCS persistent cache
_tcprimed_env_cache: OrderedDict = OrderedDict()
_TCPRIMED_ENV_CACHE_MAX = 20
_GCS_ENV_CACHE_PREFIX = "rt-v1/tcprimed-env"


def _atcf_to_tcprimed_path_parts(atcf_id: str):
    """Convert ATCF ID (e.g., 'AL092017') to TC-PRIMED S3 path components.
    Returns (basin_dir, storm_num, season) or None.
    """
    atcf_id = atcf_id.upper().strip()
    if len(atcf_id) < 8:
        return None
    basin = atcf_id[:2]
    num = atcf_id[2:4]
    season = atcf_id[4:]
    if basin not in _TCPRIMED_BASIN_MAP:
        return None
    return (_TCPRIMED_BASIN_MAP[basin], num, season)


def _find_tcprimed_env_file(s3_client, basin_dir: str, num: str, season: str) -> str | None:
    """Find the env file key in TC-PRIMED S3 for a given storm."""
    prefix = f"{_TCPRIMED_PREFIX}/{season}/{basin_dir}/{num}/"
    try:
        resp = s3_client.list_objects_v2(
            Bucket=_TCPRIMED_BUCKET, Prefix=prefix, MaxKeys=500
        )
        for obj in resp.get("Contents", []):
            key = obj["Key"]
            fname = key.split("/")[-1]
            if "_env_" in fname and fname.endswith(".nc"):
                return key
        # Paginate if needed
        while resp.get("IsTruncated"):
            resp = s3_client.list_objects_v2(
                Bucket=_TCPRIMED_BUCKET, Prefix=prefix, MaxKeys=500,
                ContinuationToken=resp["NextContinuationToken"],
            )
            for obj in resp.get("Contents", []):
                key = obj["Key"]
                fname = key.split("/")[-1]
                if "_env_" in fname and fname.endswith(".nc"):
                    return key
    except Exception as e:
        logger.warning(f"TC-PRIMED env file search failed: {e}")
    return None


def _extract_tcprimed_env(data: bytes, atcf_id: str) -> dict:
    """Extract diagnostics and storm metadata from a TC-PRIMED env NetCDF file.
    Returns a JSON-serializable dict.
    """
    import h5py
    from datetime import datetime, timezone

    result = {
        "atcf_id": atcf_id,
        "source": "TC-PRIMED v01r01 (ERA5)",
        "available": True,
        "times": [],
        "storm_metadata": {},
        "diagnostics": {},
        "variable_meta": {},
        "pressure_levels": [],
        "radial_regions": [],
        "shear_layers": ["deep (200-850 hPa)", "shallow (500-850 hPa)"],
    }

    with h5py.File(io.BytesIO(data), "r") as f:
        # ── Pressure levels ──
        if "diagnostics/level" in f:
            result["pressure_levels"] = f["diagnostics/level"][:].tolist()

        # ── Radial regions ──
        if "diagnostics/regions" in f:
            result["radial_regions"] = f["diagnostics/regions"][:].tolist()

        # ── Time axis ──
        if "diagnostics/time" in f:
            raw_times = f["diagnostics/time"][:]
            times_iso = []
            for t in raw_times:
                try:
                    dt = datetime.fromtimestamp(int(t), tz=timezone.utc)
                    times_iso.append(dt.strftime("%Y-%m-%dT%H:%M:%SZ"))
                except Exception:
                    times_iso.append(None)
            result["times"] = times_iso

        # ── Storm metadata ──
        sm = f.get("storm_metadata")
        if sm:
            for key in ["intensity", "central_min_pressure", "storm_latitude",
                        "storm_longitude", "storm_speed", "storm_heading",
                        "distance_to_land", "development_level"]:
                if key in sm:
                    ds = sm[key]
                    vals = ds[:]
                    # Decode bytes/strings
                    if vals.dtype.kind in ("O", "S", "U"):
                        result["storm_metadata"][key] = [
                            v.decode() if isinstance(v, bytes) else str(v)
                            for v in vals.flat
                        ]
                    else:
                        # Apply scale factor if present
                        sf = ds.attrs.get("scale_factor", 1)
                        scale = float(np.asarray(sf).flat[0])
                        ao = ds.attrs.get("add_offset", 0)
                        offset = float(np.asarray(ao).flat[0])
                        vals = vals.astype(float) * scale + offset
                        # Handle missing values
                        fv = ds.attrs.get("_FillValue", None)
                        if fv is not None:
                            fill_val = float(np.asarray(fv).flat[0])
                            vals[np.isclose(vals, fill_val * scale + offset)] = float("nan")
                        result["storm_metadata"][key] = [
                            None if np.isnan(v) else round(float(v), 3)
                            for v in vals.flat
                        ]

        # ── Diagnostics ──
        diag = f.get("diagnostics")
        if diag:
            for varname, meta in _TCPRIMED_ENV_VARS.items():
                if varname not in diag:
                    continue
                ds = diag[varname]
                vals = ds[:].astype(float)

                # Apply scale/offset (attrs may be arrays, so flatten)
                sf = ds.attrs.get("scale_factor", 1)
                scale = float(np.asarray(sf).flat[0])
                ao = ds.attrs.get("add_offset", 0)
                offset = float(np.asarray(ao).flat[0])
                vals = vals * scale + offset

                # Handle fill values
                fv = ds.attrs.get("_FillValue", None)
                if fv is not None:
                    fill = float(np.asarray(fv).flat[0])
                    fill_scaled = fill * scale + offset
                    vals[np.isclose(vals, fill_scaled)] = float("nan")

                # Convert to nested lists, replacing NaN with None
                def to_json(arr):
                    if arr.ndim == 0:
                        v = float(arr)
                        return None if np.isnan(v) else round(v, 4)
                    elif arr.ndim == 1:
                        return [None if np.isnan(v) else round(float(v), 4) for v in arr]
                    else:
                        return [to_json(arr[i]) for i in range(arr.shape[0])]

                result["diagnostics"][varname] = to_json(vals)

                # Build variable metadata
                unit = ds.attrs.get("units", b"")
                if isinstance(unit, bytes):
                    unit = unit.decode()
                long_name = ds.attrs.get("long_name", b"")
                if isinstance(long_name, bytes):
                    long_name = long_name.decode()

                result["variable_meta"][varname] = {
                    "name": meta["name"],
                    "unit": str(unit) or meta["unit"],
                    "group": meta["group"],
                    "desc": str(long_name) or meta["desc"],
                    "shape": list(ds.shape),
                    "dims": _infer_dims(ds.shape, varname),
                }

    return result


def _infer_dims(shape, varname):
    """Infer dimension names based on variable shape patterns in TC-PRIMED diagnostics."""
    ndim = len(shape)
    if ndim == 1:
        return ["time"]
    elif ndim == 2:
        if "shear" in varname or "precipitable" in varname or "pressure_msl" in varname:
            return ["time", "region"]
        elif "phase" in varname and "b_param" in varname:
            return ["time", "region"]
        else:
            return ["time", "dim1"]
    elif ndim == 3:
        if "shear" in varname:
            return ["time", "layer", "region"]
        elif any(k in varname for k in ["humidity", "temperature", "divergence",
                                         "vorticity", "theta", "wind", "geopotential"]):
            return ["time", "level", "region"]
        elif "thermal_wind" in varname:
            return ["time", "layer", "region"]
        else:
            return ["time", "dim1", "dim2"]
    return [f"dim{i}" for i in range(ndim)]


def _fetch_tcprimed_env(atcf_id: str) -> dict | None:
    """Fetch TC-PRIMED environmental diagnostics for a storm.
    Checks GCS cache first, then fetches from S3 and caches result.
    """
    atcf_id = atcf_id.upper().strip()

    # 1. Check in-memory cache
    if atcf_id in _tcprimed_env_cache:
        _tcprimed_env_cache.move_to_end(atcf_id)
        logger.info(f"TC-PRIMED env cache hit (memory): {atcf_id}")
        return _tcprimed_env_cache[atcf_id]

    # 2. Check GCS cache
    gcs_key = f"{_GCS_ENV_CACHE_PREFIX}/{atcf_id}.json"
    bucket = _get_gcs_bucket()
    if bucket:
        try:
            blob = bucket.blob(gcs_key)
            if blob.exists():
                cached = json.loads(blob.download_as_text())
                _tcprimed_env_cache[atcf_id] = cached
                if len(_tcprimed_env_cache) > _TCPRIMED_ENV_CACHE_MAX:
                    _tcprimed_env_cache.popitem(last=False)
                logger.info(f"TC-PRIMED env cache hit (GCS): {atcf_id}")
                return cached
        except Exception as e:
            logger.warning(f"GCS env cache read failed for {atcf_id}: {e}")

    # 3. Fetch from TC-PRIMED S3
    parts = _atcf_to_tcprimed_path_parts(atcf_id)
    if not parts:
        return None

    basin_dir, num, season = parts

    try:
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config as BotoConfig
        s3 = boto3.client("s3", config=BotoConfig(signature_version=UNSIGNED))
    except Exception as e:
        logger.error(f"Failed to create S3 client: {e}")
        return None

    # Find the env file
    env_key = _find_tcprimed_env_file(s3, basin_dir, num, season)
    if not env_key:
        logger.info(f"No TC-PRIMED env file found for {atcf_id} "
                     f"(searched {_TCPRIMED_PREFIX}/{season}/{basin_dir}/{num}/)")
        return None

    # Download and parse
    logger.info(f"Downloading TC-PRIMED env file: s3://{_TCPRIMED_BUCKET}/{env_key}")
    try:
        obj = s3.get_object(Bucket=_TCPRIMED_BUCKET, Key=env_key)
        data = obj["Body"].read()
        logger.info(f"Downloaded {len(data)/1e6:.1f} MB for {atcf_id}")
    except Exception as e:
        logger.error(f"TC-PRIMED env download failed for {atcf_id}: {e}")
        return None

    try:
        result = _extract_tcprimed_env(data, atcf_id)
        result["s3_key"] = env_key
    except Exception as e:
        logger.error(f"TC-PRIMED env parse failed for {atcf_id}: {e}")
        return None

    # 4. Cache to GCS
    if bucket:
        try:
            blob = bucket.blob(gcs_key)
            blob.upload_from_string(
                json.dumps(result, separators=(",", ":")),
                content_type="application/json",
            )
            logger.info(f"TC-PRIMED env cached to GCS: {gcs_key}")
        except Exception as e:
            logger.warning(f"GCS env cache write failed for {atcf_id}: {e}")

    # 5. Cache in memory
    _tcprimed_env_cache[atcf_id] = result
    if len(_tcprimed_env_cache) > _TCPRIMED_ENV_CACHE_MAX:
        _tcprimed_env_cache.popitem(last=False)

    return result


@router.get("/tcprimed-env")
def get_tcprimed_env(
    atcf_id: str = Query(..., description="ATCF storm ID, e.g., AL092017 or WP112019"),
):
    """Fetch TC-PRIMED ERA5-based environmental diagnostics for a storm.

    Returns time series of environmental parameters (SST, shear, moisture,
    divergence, MPI, warm-core anomaly, CPS, etc.) derived from ERA5 reanalysis.
    Available globally — all basins, not just AL/EP/CP.

    Data is cached in GCS after first request for instant subsequent access.
    First request may take 15-30s to download the env file from TC-PRIMED S3.
    """
    atcf_id = atcf_id.upper().strip()
    if len(atcf_id) < 6:
        raise HTTPException(status_code=400, detail="Invalid ATCF ID format")

    result = _fetch_tcprimed_env(atcf_id)

    if result is None:
        return JSONResponse(
            content={
                "atcf_id": atcf_id,
                "available": False,
                "reason": "TC-PRIMED environmental data not found for this storm. "
                          "Data is available for storms from ~1998-2023.",
                "diagnostics": {},
                "times": [],
            },
            headers={"Cache-Control": "public, max-age=3600"},
        )

    return JSONResponse(
        content=result,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/health")
def global_health():
    """Health check for global archive endpoints."""
    return {
        "status": "ok",
        "hursat_cache_size": len(_extracted_cache),
        "frame_cache_size": len(_frame_cache),
        "hursat_meta_cache_size": len(_meta_cache),
        "ir_meta_cache_size": len(_mergir_meta_cache),
        "extracted_storms": list(_extracted_cache.keys()),
        "earthdata_configured": bool(EARTHDATA_TOKEN or EARTHDATA_USER),
        "earthdata_method": "token" if EARTHDATA_TOKEN else ("user/pass" if EARTHDATA_USER else "none"),
        "mergir_available": bool(EARTHDATA_TOKEN or EARTHDATA_USER),
        "mergir_circuit_breaker": {
            "open": _mergir_circuit_is_open(),
            "consecutive_failures": _mergir_consecutive_failures,
            "threshold": MERGIR_CIRCUIT_THRESHOLD,
            "cooldown_s": MERGIR_CIRCUIT_COOLDOWN,
        },
        "gridsat_available": True,
        "gcs_cache": {
            "enabled": bool(GCS_IR_CACHE_BUCKET),
            "bucket": GCS_IR_CACHE_BUCKET or None,
            "connected": _gcs_bucket is not None,
            "cache_version": _GCS_CACHE_VERSION,
        },
    }


@router.get("/ir/heal-status")
def ir_heal_status():
    """
    Diagnostic endpoint showing cache heal activity.
    Check this after loading a storm to verify healing is working.
    Example: GET /global/ir/heal-status
    """
    with _heal_lock:
        in_progress = list(_heal_in_progress)
    return {
        "attempted": _heal_stats["attempted"],
        "succeeded": _heal_stats["succeeded"],
        "failed": _heal_stats["failed"],
        "skipped": _heal_stats["skipped"],
        "in_progress": in_progress,
        "history": _heal_stats["history"][-20:],  # Last 20 events
    }


@router.get("/hursat/inspect")
def hursat_inspect(sid: str = Query("1992230N11325", description="IBTrACS storm ID")):
    """Inspect the first extracted NetCDF file to see variables and structure."""
    import xarray as xr

    frames = _get_extracted_frames(sid, storm_lon=0.0)
    if not frames:
        return {"error": "No frames extracted", "sid": sid}

    frame_tuple = frames[0]
    dt_str, nc_path = frame_tuple[0], frame_tuple[1]
    satellite = frame_tuple[2] if len(frame_tuple) > 2 else ""
    result = {"sid": sid, "n_frames": len(frames), "first_file": nc_path, "datetime": dt_str}
    if satellite:
        result["satellite"] = satellite

    try:
        ds = xr.open_dataset(nc_path, engine="h5netcdf")
        result["variables"] = {}
        for v in ds.data_vars:
            var = ds[v]
            result["variables"][v] = {
                "dims": list(var.dims),
                "shape": list(var.shape),
                "dtype": str(var.dtype),
            }
            # Add min/max for numeric vars
            try:
                vals = var.values
                if vals.size > 0 and vals.dtype.kind == 'f':
                    finite = vals[np.isfinite(vals)]
                    if len(finite) > 0:
                        result["variables"][v]["min"] = float(np.min(finite))
                        result["variables"][v]["max"] = float(np.max(finite))
            except Exception:
                pass
        result["dims"] = {k: v for k, v in ds.dims.items()}
        result["coords"] = list(ds.coords)
        ds.close()
    except Exception as e:
        result["error"] = str(e)

    return result


@router.get("/hursat/debug")
def hursat_debug(sid: str = Query("1992230N11325", description="IBTrACS storm ID to test")):
    """Debug endpoint: test NCEI connectivity for a storm."""
    import requests

    year = _parse_sid_year(sid)

    # Check year directory
    year_url = f"{HURSAT_V06_BASE}/{year}/"
    year_result = {}
    try:
        resp = requests.get(year_url, timeout=20, headers=_HTTP_HEADERS)
        year_result["url"] = year_url
        year_result["status"] = resp.status_code

        if resp.status_code == 200:
            # Find matching tarball
            pattern = rf'href="(HURSAT_b1_v06_{re.escape(sid)}_[^"]+\.tar\.gz)"'
            matches = re.findall(pattern, resp.text)
            year_result["matching_tarballs"] = matches

            # Also show sample tarballs for context
            all_tarballs = re.findall(r'href="(HURSAT_b1_v06_[^"]+\.tar\.gz)"', resp.text)
            year_result["total_tarballs"] = len(all_tarballs)
            year_result["sample_tarballs"] = all_tarballs[:5]
    except Exception as e:
        year_result["error"] = str(e)

    return {"sid": sid, "year": year, "year_directory": year_result}


# ══════════════════════════════════════════════════════════════════════
# Flight-Level Reconnaissance Data (AOML HRD Archive, 1960–present)
# ══════════════════════════════════════════════════════════════════════

# Import shared HRD helpers from the main TC-RADAR API module.
# These are loaded lazily to avoid circular imports at module level.
_fl_helpers_loaded = False
_fl_helpers = {}


def _load_fl_helpers():
    global _fl_helpers_loaded, _fl_helpers
    if _fl_helpers_loaded:
        return _fl_helpers
    try:
        from tc_radar_api import (
            HRD_FL_BASE,
            _hrd_fetch_text,
            _hrd_parse_directory,
            _resolve_hrd_storm_name,
            _parse_hrd_1sec,
            _hrd_average_window,
            _merge_hrd_header_tokens,
        )
        _fl_helpers = {
            "HRD_FL_BASE": HRD_FL_BASE,
            "fetch_text": _hrd_fetch_text,
            "parse_dir": _hrd_parse_directory,
            "resolve_name": _resolve_hrd_storm_name,
            "parse_1sec": _parse_hrd_1sec,
            "avg_window": _hrd_average_window,
            "merge_tokens": _merge_hrd_header_tokens,
        }
        _fl_helpers_loaded = True
    except ImportError as e:
        logger.warning(f"Could not import HRD helpers: {e}")
    return _fl_helpers


# Aircraft code → display name mapping
_AIRCRAFT_NAMES = {
    "H": "NOAA N42RF (P-3)",
    "I": "NOAA N43RF (P-3)",
    "N": "NOAA (G-IV)",
    "L": "NOAA (G-IV)",
    "U": "USAF (WC-130J)",
    "A": "AFRES (WC-130J)",
}

# Mission discovery cache — archive directory listings are quasi-static;
# new missions appear only during active season, 6h is a reasonable refresh.
_fl_mission_cache: OrderedDict = OrderedDict()
_FL_MISSION_CACHE_TTL = 6 * 3600   # 6 hours
_FL_MISSION_CACHE_MAX = 200

# Flight-level data cache — parsed file data is immutable once posted.
# Long TTL is safe; limit max entries to control memory (~1-2 MB each).
_fl_data_cache: OrderedDict = OrderedDict()
_FL_DATA_CACHE_TTL = 7 * 86400     # 7 days
_FL_DATA_CACHE_MAX = 50


def _detect_fl_format(filename: str) -> str:
    """Detect file format from filename extension."""
    fl = filename.lower()
    if fl.endswith(".1sec.txt") or fl.endswith(".sec.txt") or fl.endswith(".1sec"):
        return "noaa_1sec"
    if fl.endswith(".10sec.txt"):
        return "usaf_10sec"
    if re.match(r".*\.\d{2}\.txt$", fl):  # e.g., .01.txt
        return "usaf_01"
    if fl.endswith(".ten"):
        return "usaf_ten"
    if fl.endswith(".txt"):
        return "text_generic"  # Could be NOAA, USAF, or legacy
    return "unknown"


def _parse_fl_filename(filename: str, year: int):
    """Parse an HRD flight-level filename into mission metadata.

    Returns dict with mission_id, datetime, aircraft_code, sortie, format_hint
    or None if not parseable.
    """
    # Strip extensions to get base mission ID
    base = filename
    for ext in [".1sec.txt", ".10sec.txt", ".sec.txt", ".1sec", ".01.txt", ".ten", ".txt"]:
        if base.lower().endswith(ext):
            base = base[: -len(ext)]
            break

    # Match YYYYMMDDXN or YYMMDDXN pattern
    m = re.match(r"(\d{8})([A-Za-z])(\d+)", base)
    if not m:
        m = re.match(r"(\d{6})([A-Za-z])(\d+)", base)
        if m:
            short_date = m.group(1)
            century = str(year)[:2] if year else ("19" if int(short_date[:2]) >= 60 else "20")
            date_str = century + short_date
            aircraft_code = m.group(2).upper()
            sortie = int(m.group(3))
        else:
            return None
    else:
        date_str = m.group(1)
        aircraft_code = m.group(2).upper()
        sortie = int(m.group(3))

    # Parse date
    try:
        dt = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    except (IndexError, ValueError):
        return None

    aircraft = _AIRCRAFT_NAMES.get(aircraft_code, f"Aircraft {aircraft_code}")
    fmt = _detect_fl_format(filename)

    return {
        "filename": filename,
        "mission_id": f"{date_str}{aircraft_code}{sortie}",
        "datetime": dt,
        "aircraft_code": aircraft_code,
        "aircraft": aircraft,
        "sortie": sortie,
        "format_hint": fmt,
    }


@router.get("/flightlevel/missions")
def get_fl_missions(
    storm_name: str = Query(..., description="Storm name, e.g., 'Laura'"),
    year: int = Query(..., ge=1960, le=2030, description="Year"),
):
    """Discover available flight-level missions for a storm from AOML HRD FTP."""
    h = _load_fl_helpers()
    if not h:
        raise HTTPException(503, "Flight-level helpers not available")

    # Check cache
    import time as _time
    cache_key = f"{storm_name.lower()}_{year}"
    now = _time.time()
    if cache_key in _fl_mission_cache:
        cached, ts = _fl_mission_cache[cache_key]
        if now - ts < _FL_MISSION_CACHE_TTL:
            _fl_mission_cache.move_to_end(cache_key)
            return cached

    # Resolve storm name to HRD directory
    hrd_dir = h["resolve_name"](storm_name, year)
    if not hrd_dir:
        # Don't cache negative results — transient FTP failures would block
        # valid storms for the full 24-hour TTL.
        return {
            "success": True,
            "storm_name": storm_name,
            "year": year,
            "hrd_dir": None,
            "missions": [],
        }

    # Get directory listing
    dir_url = f"{h['HRD_FL_BASE']}/{year}/{hrd_dir}/"
    try:
        entries = h["parse_dir"](dir_url)
    except Exception as e:
        raise HTTPException(502, f"Could not list HRD directory: {e}")

    # Filter for data files and parse filenames
    missions = []
    seen_ids = set()
    for entry in entries:
        entry_clean = entry.rstrip("/")
        fmt = _detect_fl_format(entry_clean)
        if fmt == "unknown":
            continue
        # Skip non-data files (PDFs, JPGs, summaries, etc.)
        if entry_clean.lower().endswith((".pdf", ".jpg", ".png", ".SUM.txt")):
            continue
        if "SUM" in entry_clean.upper() or "FD" in entry_clean.upper():
            continue
        # Skip NetCDF files (we parse text files)
        if entry_clean.lower().endswith(".nc"):
            continue

        meta = _parse_fl_filename(entry_clean, year)
        if meta is None:
            continue
        # Deduplicate: prefer .1sec.txt over .txt for same mission
        mid = meta["mission_id"]
        if mid in seen_ids:
            # Replace only if new file is higher priority format
            if fmt == "noaa_1sec":
                missions = [m for m in missions if m["mission_id"] != mid]
            else:
                continue
        seen_ids.add(mid)
        meta["file_url"] = dir_url + entry_clean
        missions.append(meta)

    # Sort by date then sortie
    missions.sort(key=lambda m: (m["datetime"], m["aircraft_code"], m["sortie"]))

    result = {
        "success": True,
        "storm_name": storm_name,
        "year": year,
        "hrd_dir": hrd_dir,
        "missions": missions,
    }

    _fl_mission_cache[cache_key] = (result, now)
    if len(_fl_mission_cache) > _FL_MISSION_CACHE_MAX:
        _fl_mission_cache.popitem(last=False)

    return result


def _parse_hrd_legacy_csv(text: str) -> list:
    """Parse legacy CSV-format HRD flight-level files (1960s-1980s).

    These files have a header like:
    FLIGHT ID,STORM NAME,PROCESSED DATE,TIME,HDG,DRF,LAT,LONG,DD,FF,...

    Returns list of observation dicts matching the standard FL format.
    """
    import csv

    lines = text.strip().splitlines()
    if len(lines) < 2:
        return []

    # Find header line (contains "TIME" and commas)
    header_idx = 0
    for i, line in enumerate(lines[:5]):
        if "TIME" in line.upper() and "," in line:
            header_idx = i
            break

    reader = csv.reader(lines[header_idx:])
    header = None
    observations = []

    for row in reader:
        if header is None:
            header = [h.strip().upper() for h in row]
            continue

        if len(row) < len(header):
            continue

        def _get(name):
            try:
                idx = header.index(name)
                val = row[idx].strip()
                return float(val) if val and val != "999.00" and val != "-999.00" else None
            except (ValueError, IndexError):
                return None

        # Parse TIME
        time_str = None
        try:
            idx = header.index("TIME")
            time_str = row[idx].strip()
        except (ValueError, IndexError):
            continue
        if not time_str or len(time_str) < 4:
            continue

        # TIME could be HHMMSS or HH:MM:SS
        time_str = time_str.replace(":", "")
        try:
            hh = int(time_str[0:2])
            mm = int(time_str[2:4])
            ss = int(time_str[4:6]) if len(time_str) >= 6 else 0
        except (ValueError, IndexError):
            continue

        lat = _get("LAT")
        lon_raw = _get("LONG") or _get("LON")
        if lat is None or lon_raw is None:
            continue
        # Legacy files use positive-west longitude
        lon = -abs(lon_raw) if lon_raw > 0 else lon_raw

        wspd = _get("FF")  # Wind force/speed
        wdir = _get("DD")  # Wind direction
        pres = _get("PRES")
        alt = _get("PA") or _get("GEOAL")

        # Filter physically impossible wind speeds (calibration/test records)
        if wspd is not None and wspd > 200:
            wspd = None

        obs = {
            "time": f"{hh:02d}:{mm:02d}:{ss:02d}",
            "time_sec": hh * 3600 + mm * 60 + ss,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "fl_wspd_ms": round(wspd, 2) if wspd is not None else None,
            "fl_wdir_deg": round(wdir, 1) if wdir is not None else None,
            "gps_alt_m": round(alt, 1) if alt is not None else None,
            "static_pres_hpa": round(pres, 1) if pres is not None else None,
            "temp_c": None,
            "dewpoint_c": None,
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


_FL_GCS_CACHE_PREFIX = "recon/v6"  # v6: filter calibration records (wspd > 200), fix m/s unit heuristic


def _fl_gcs_cache_key(filename: str, center_lat: float, center_lon: float) -> str:
    """Build GCS object key for a cached flight-level result."""
    return f"{_FL_GCS_CACHE_PREFIX}/{filename}_{center_lat:.1f}_{center_lon:.1f}.json"


def _fl_gcs_get(filename: str, center_lat: float, center_lon: float):
    """Try reading a cached flight-level result from GCS."""
    bucket = _get_gcs_bucket()
    if bucket is None:
        return None
    key = _fl_gcs_cache_key(filename, center_lat, center_lon)
    try:
        blob = bucket.blob(key)
        data = blob.download_as_bytes(timeout=5)
        return json.loads(data)
    except Exception:
        return None


def _fl_gcs_put(filename: str, center_lat: float, center_lon: float, result: dict):
    """Write a parsed flight-level result to GCS (background, fire-and-forget)."""
    bucket = _get_gcs_bucket()
    if bucket is None:
        return

    def _upload():
        key = _fl_gcs_cache_key(filename, center_lat, center_lon)
        try:
            blob = bucket.blob(key)
            blob.upload_from_string(
                json.dumps(result, separators=(",", ":")),
                content_type="application/json",
            )
        except Exception as e:
            logger.warning(f"GCS recon cache write failed: {e}")

    import threading
    threading.Thread(target=_upload, daemon=True).start()



@router.get("/flightlevel/data")
def get_fl_data(
    file_url: str = Query(..., description="Full URL of the FL data file on AOML FTP"),
    center_lat: float = Query(0.0, description="Storm center latitude for relative coords"),
    center_lon: float = Query(0.0, description="Storm center longitude for relative coords"),
    include_1s: bool = Query(False, description="Include 1-second resolution data (large payload)"),
):
    """Fetch and parse a specific flight-level mission file."""
    h = _load_fl_helpers()
    if not h:
        raise HTTPException(503, "Flight-level helpers not available")

    # Security: only allow AOML FTP URLs
    if not file_url.startswith(h["HRD_FL_BASE"]):
        raise HTTPException(400, "Invalid file URL")

    filename = file_url.rsplit("/", 1)[-1]

    # Check in-memory cache
    import time as _time
    now = _time.time()
    cache_key = f"{file_url}_{center_lat}_{center_lon}"
    if cache_key in _fl_data_cache:
        cached, ts = _fl_data_cache[cache_key]
        if now - ts < _FL_DATA_CACHE_TTL:
            _fl_data_cache.move_to_end(cache_key)
            if not include_1s:
                return cached  # In-memory cache never has obs_1s (memory-efficient)
            # 1s requested: in-memory cache doesn't store obs_1s,
            # fall through to GCS/AOML for full data
            if cached.get("obs_1s"):
                return cached

    # Check GCS persistent cache
    gcs_result = _fl_gcs_get(filename, center_lat, center_lon)
    if gcs_result:
        cached_at = gcs_result.get("_cached_at", 0)
        import re
        year_m = re.search(r'(\d{4})', filename)
        file_year = int(year_m.group(1)) if year_m else 0
        current_year = int(_time.strftime("%Y"))
        age_days = (now - cached_at) / 86400 if cached_at else 9999

        # Historical data (≥2 years old): trust indefinitely
        # Recent data: trust for 7 days, then refetch to catch QC revisions
        if (current_year - file_year) >= 2 or age_days < 7:
            _fl_data_cache[cache_key] = (gcs_result, now)
            if not include_1s:
                # Return without 1s data for faster response
                resp = {k: v for k, v in gcs_result.items() if k != "obs_1s"}
                resp["obs_1s"] = []
                return resp
            # If 1s requested but GCS cache has empty obs_1s (stale entry),
            # fall through to re-fetch from AOML
            if gcs_result.get("obs_1s"):
                return gcs_result
            else:
                logger.info(f"GCS cache missing obs_1s for {filename}, re-fetching")
        else:
            logger.info(f"GCS recon cache expired ({age_days:.0f}d old): {filename}")

    # Fetch the file from AOML
    try:
        import requests as _req
        resp = _req.get(file_url, timeout=60)
        resp.raise_for_status()
        text = resp.text
        source_size = len(resp.content)
    except Exception as e:
        raise HTTPException(502, f"Could not fetch flight-level file: {e}")

    # Detect format and parse
    fmt = _detect_fl_format(filename)
    observations = []

    # Try standard parser first (handles both NOAA and most USAF formats)
    try:
        observations = h["parse_1sec"](text)
    except Exception as e:
        logger.warning(f"Standard parser failed for {filename}: {e}")

    # If standard parser returned too few results, try .ten parser (USAF deg-min format)
    if len(observations) < 10 and fmt in ("usaf_ten", "usaf_10sec", "text_generic"):
        try:
            from tc_radar_api import _parse_usaf_ten
            observations = _parse_usaf_ten(text)
            if observations:
                logger.info(f"USAF .ten parser succeeded for {filename}: {len(observations)} obs")
        except Exception as e:
            logger.warning(f"USAF .ten parser failed for {filename}: {e}")

    # If still too few results, try legacy CSV parser
    if len(observations) < 10 and "," in text[:500]:
        try:
            observations = _parse_hrd_legacy_csv(text)
            logger.info(f"Legacy CSV parser succeeded for {filename}: {len(observations)} obs")
        except Exception as e:
            logger.warning(f"Legacy CSV parser also failed for {filename}: {e}")

    if len(observations) < 10:
        return {
            "success": False,
            "reason": "parse_failed",
            "detail": f"Could not parse {filename} (format: {fmt}, got {len(observations)} obs)",
            "observations": [],
            "obs_1s": [],
            "obs_10s": [],
            "obs_30s": [],
        }

    # Compute storm-relative coordinates if center provided
    has_sr = False
    if abs(center_lat) > 0.1 and abs(center_lon) > 0.1:
        from math import radians, cos
        R = 6371.0  # Earth radius km
        clat_rad = radians(center_lat)
        for obs in observations:
            if obs["lat"] is not None and obs["lon"] is not None:
                dy = (obs["lat"] - center_lat) * (R * radians(1))
                dx = (obs["lon"] - center_lon) * (R * radians(1) * cos(clat_rad))
                obs["x_km"] = round(dx, 2)
                obs["y_km"] = round(dy, 2)
                obs["r_km"] = round((dx**2 + dy**2) ** 0.5, 2)
                has_sr = True
            else:
                obs["x_km"] = None
                obs["y_km"] = None
                obs["r_km"] = None

    # Multi-resolution averaging
    obs_1s = observations
    try:
        obs_10s = h["avg_window"](observations, 10.0)
        obs_30s = h["avg_window"](observations, 30.0)
    except Exception:
        obs_10s = observations
        obs_30s = observations

    # Detect if data is actually 1-second resolution
    has_1s = True
    if len(observations) >= 3:
        dt1 = observations[1]["time_sec"] - observations[0]["time_sec"]
        dt2 = observations[2]["time_sec"] - observations[1]["time_sec"]
        avg_dt = (dt1 + dt2) / 2.0
        if avg_dt > 5:  # > 5s average spacing means not 1-second data
            has_1s = False

    # Summary — compute from both 1s and 10s for operational consistency
    wspds_1s = [o["fl_wspd_ms"] for o in observations if o.get("fl_wspd_ms") is not None]
    sfcprs_1s = [o["sfcpr_hpa"] for o in observations
                 if o.get("sfcpr_hpa") is not None and 850 <= o["sfcpr_hpa"] <= 1100]
    wspds_10s = [o["fl_wspd_ms"] for o in obs_10s if o.get("fl_wspd_ms") is not None]
    sfcprs_10s = [o["sfcpr_hpa"] for o in obs_10s
                  if o.get("sfcpr_hpa") is not None and 850 <= o["sfcpr_hpa"] <= 1100]
    alts = [o["gps_alt_m"] for o in observations if o.get("gps_alt_m") is not None]

    summary = {
        # 10-second values (operational standard)
        "max_fl_wspd_ms": round(max(wspds_10s), 1) if wspds_10s else None,
        "min_sfcpr_hpa": round(min(sfcprs_10s), 1) if sfcprs_10s else None,
        # 1-second peak values
        "max_fl_wspd_ms_1s": round(max(wspds_1s), 1) if wspds_1s else None,
        "min_sfcpr_hpa_1s": round(min(sfcprs_1s), 1) if sfcprs_1s else None,
        "total_obs_1hz": len(observations),
        "mean_alt_m": round(sum(alts) / len(alts), 0) if alts else None,
        "start_time": observations[0]["time"] if observations else None,
        "end_time": observations[-1]["time"] if observations else None,
    }

    # Extract mission_id from filename
    meta = _parse_fl_filename(filename, None)
    mission_id = meta["mission_id"] if meta else filename

    # Always store full data (including 1s) in cache; strip obs_1s from
    # response only — this fixes the bug where include_1s=true requests
    # would return empty obs_1s from a cache populated by include_1s=false.
    result = {
        "success": True,
        "observations": obs_10s,  # Default resolution
        "obs_1s": obs_1s,         # Always cache full 1s data
        "obs_10s": obs_10s,
        "obs_30s": obs_30s,
        "mission_id": mission_id,
        "source_file": filename,
        "source_url": file_url,
        "n_obs": len(obs_10s),
        "n_obs_raw": len(observations),
        "has_1s": has_1s,
        "has_storm_relative": has_sr,
        "center_lat": center_lat if has_sr else None,
        "center_lon": center_lon if has_sr else None,
        "summary": summary,
        "_source_size": source_size,
        "_cached_at": now,  # epoch timestamp for GCS TTL check
    }

    # In-memory cache: store WITHOUT 1s data to control memory usage
    # (1s arrays can be 10+ MB per mission). GCS stores the full result.
    mem_result = {k: v for k, v in result.items() if k != "obs_1s"}
    mem_result["obs_1s"] = []
    _fl_data_cache[cache_key] = (mem_result, now)
    if len(_fl_data_cache) > _FL_DATA_CACHE_MAX:
        _fl_data_cache.popitem(last=False)

    # Persist full result (including 1s) to GCS for cross-instance cache hits
    _fl_gcs_put(filename, center_lat, center_lon, result)

    # Return without 1s data if not requested (reduces response size)
    if not include_1s:
        return mem_result

    return result


# ── Flight-Level Mission Stats (batch max-wind lookup) ───────────────

_fl_stats_cache: OrderedDict = OrderedDict()
_FL_STATS_CACHE_TTL = 24 * 3600   # 24 hours
_FL_STATS_CACHE_MAX = 100


def _extract_summary_from_caches(file_url: str) -> dict | None:
    """Try to extract summary stats from in-memory or GCS caches."""
    filename = file_url.rsplit("/", 1)[-1]
    # Check in-memory cache (any center coords)
    for ck, (cached, _ts) in _fl_data_cache.items():
        if ck.startswith(file_url + "_"):
            summ = cached.get("summary")
            if summ:
                return summ
    # Check GCS — try common center coord (0.0, 0.0) first
    gcs_result = _fl_gcs_get(filename, 0.0, 0.0)
    if gcs_result and gcs_result.get("summary"):
        return gcs_result["summary"]
    # Try listing GCS blobs with this filename prefix
    bucket = _get_gcs_bucket()
    if bucket:
        prefix = f"{_FL_GCS_CACHE_PREFIX}/{filename}_"
        try:
            blobs = list(bucket.list_blobs(prefix=prefix, max_results=1))
            if blobs:
                data = blobs[0].download_as_bytes(timeout=5)
                parsed = json.loads(data)
                if parsed.get("summary"):
                    return parsed["summary"]
        except Exception:
            pass
    return None


def _quick_max_wind_from_file(file_url: str) -> dict | None:
    """Fetch an FL file from AOML and extract only the max wind summary.

    This is a lightweight alternative to full parsing — it reuses the
    existing parser but discards observation arrays to save memory.
    """
    h = _load_fl_helpers()
    if not h:
        return None
    try:
        import requests as _req
        resp = _req.get(file_url, timeout=30)
        resp.raise_for_status()
        text = resp.text
    except Exception:
        return None

    filename = file_url.rsplit("/", 1)[-1]
    fmt = _detect_fl_format(filename)
    try:
        if fmt == "noaa_1sec":
            observations = h["parse_1sec"](text)
        elif fmt in ("usaf_10sec", "usaf_01", "usaf_ten"):
            observations = h["parse_1sec"](text)  # Unified parser handles both
        elif fmt == "legacy_csv":
            observations = _parse_hrd_legacy_csv(text)
        else:
            return None
    except Exception:
        return None

    if not observations:
        return None

    # Compute 10s averages for operational max wind
    obs_10s = h["avg_window"](observations, 10)
    wspds_10s = [o["fl_wspd_ms"] for o in obs_10s if o.get("fl_wspd_ms") is not None]
    wspds_1s = [o["fl_wspd_ms"] for o in observations if o.get("fl_wspd_ms") is not None]
    sfcprs_10s = [o["sfcpr_hpa"] for o in obs_10s
                  if o.get("sfcpr_hpa") is not None and 850 <= o["sfcpr_hpa"] <= 1100]

    return {
        "max_fl_wspd_ms": round(max(wspds_10s), 1) if wspds_10s else None,
        "max_fl_wspd_ms_1s": round(max(wspds_1s), 1) if wspds_1s else None,
        "min_sfcpr_hpa": round(min(sfcprs_10s), 1) if sfcprs_10s else None,
    }


@router.get("/flightlevel/missions/stats")
def get_fl_mission_stats(
    storm_name: str = Query(..., description="Storm name"),
    year: int = Query(..., ge=1960, le=2030, description="Year"),
):
    """Return max wind stats for all missions of a storm (hybrid: cached + background fetch)."""
    import time as _time
    import threading
    now = _time.time()

    stats_key = f"{storm_name.lower()}_{year}"

    # Check stats cache first
    if stats_key in _fl_stats_cache:
        cached, ts = _fl_stats_cache[stats_key]
        if now - ts < _FL_STATS_CACHE_TTL:
            _fl_stats_cache.move_to_end(stats_key)
            return cached

    # Get mission list (reuses the mission discovery cache)
    missions_resp = get_fl_missions(storm_name=storm_name, year=year)
    missions = missions_resp.get("missions", [])
    if not missions:
        return {"success": True, "stats": {}, "pending": []}

    stats = {}
    pending = []

    for m in missions:
        file_url = m.get("file_url", "")
        if not file_url:
            continue
        summ = _extract_summary_from_caches(file_url)
        if summ:
            max_wind_ms = summ.get("max_fl_wspd_ms")
            max_wind_kt = round(max_wind_ms * 1.944) if max_wind_ms is not None and max_wind_ms <= 120 else None
            min_pres = summ.get("min_sfcpr_hpa")
            if max_wind_kt is not None:
                stats[file_url] = {"max_wind_kt": max_wind_kt, "min_pres_hpa": min_pres}
            else:
                pending.append(file_url)
        else:
            pending.append(file_url)

    result = {"success": True, "stats": stats, "pending": pending}

    # If all stats are available, cache and return
    if not pending:
        _fl_stats_cache[stats_key] = (result, now)
        if len(_fl_stats_cache) > _FL_STATS_CACHE_MAX:
            _fl_stats_cache.popitem(last=False)
        return result

    # Fire background thread to fetch uncached missions
    def _bg_fetch():
        for furl in pending[:20]:  # Cap at 20 to avoid overloading AOML
            try:
                summ = _quick_max_wind_from_file(furl)
                if summ:
                    max_wind_ms = summ.get("max_fl_wspd_ms")
                    max_wind_kt = round(max_wind_ms * 1.944) if max_wind_ms is not None and max_wind_ms <= 120 else None
                    min_pres = summ.get("min_sfcpr_hpa")
                    if max_wind_kt is not None:
                        stats[furl] = {"max_wind_kt": max_wind_kt, "min_pres_hpa": min_pres}
            except Exception:
                pass
        # Update stats cache with completed results
        import time as _t2
        full_result = {"success": True, "stats": stats, "pending": []}
        _fl_stats_cache[stats_key] = (full_result, _t2.time())
        if len(_fl_stats_cache) > _FL_STATS_CACHE_MAX:
            _fl_stats_cache.popitem(last=False)

    threading.Thread(target=_bg_fetch, daemon=True).start()

    return result


# ══════════════════════════════════════════════════════════════════════
# Dropsonde Data (AOML HRD Archive, ~1996–present)
# ══════════════════════════════════════════════════════════════════════

_sonde_cache: OrderedDict = OrderedDict()
_SONDE_CACHE_TTL = 86400
_SONDE_CACHE_MAX = 20


@router.get("/dropsondes/data")
def get_global_dropsondes(
    storm_name: str = Query(..., description="Storm name"),
    year: int = Query(..., ge=1990, le=2030, description="Year"),
    mission_id: str = Query("", description="Mission ID (e.g., 20050823U1) to filter sondes"),
    center_lat: float = Query(0.0, description="Storm center latitude"),
    center_lon: float = Query(0.0, description="Storm center longitude"),
):
    """Fetch dropsonde profiles for a storm from AOML HRD archive."""
    import time as _time
    now = _time.time()
    cache_key = f"ga_sonde_{storm_name.lower()}_{year}_{mission_id}"
    if cache_key in _sonde_cache:
        cached, ts = _sonde_cache[cache_key]
        if now - ts < _SONDE_CACHE_TTL:
            _sonde_cache.move_to_end(cache_key)
            return cached

    # Import sonde helpers from tc_radar_api
    try:
        from tc_radar_api import (
            _resolve_hurr_season,
            _resolve_sonde_storm_dir,
            _find_frd_tarball,
            _fetch_and_extract_frd_tarball,
            _parse_frd_file,
            _filter_valid_frd_profile,
            _build_archive_sonde_response,
            HRD_SONDE_BASE,
            _hrd_parse_directory,
        )
    except ImportError as e:
        raise HTTPException(503, f"Dropsonde helpers not available: {e}")

    # Resolve storm → HRD archive path
    # Search both HURR{YY} (NOAA) and AFRES{YY} (USAF) directories
    yy = f"{year % 100:02d}"
    season_candidates = [f"HURR{yy}", f"AFRES{yy}"]
    operproc_urls = []
    for season_dir in season_candidates:
        storm_url = _resolve_sonde_storm_dir(season_dir, storm_name)
        if storm_url:
            operproc_urls.append(storm_url + "/operproc/")

    if not operproc_urls:
        return {"success": True, "dropsondes": [], "n_sondes": 0,
                "message": "No dropsonde archive for this year"}
    # Collect FRD tarballs from all archive directories (HURR + AFRES)
    import re as _re
    all_tarballs = []  # list of (operproc_url, tarball_name)
    for operproc_url in operproc_urls:
        try:
            entries = _hrd_parse_directory(operproc_url)
        except Exception:
            continue
        frd_tarballs = [e for e in entries
                        if e.lower().endswith(('.tar.gz', '.tgz'))
                        and ('frd' in e.lower() or 'FRD' in e)]
        if mission_id:
            mid_prefix = _re.sub(r'\d+$', '', mission_id).upper()
            # USAF flights use "U" in FL files but "A" in AFRES sonde archives
            alt_prefix = None
            if mid_prefix.endswith('U'):
                alt_prefix = mid_prefix[:-1] + 'A'
            elif mid_prefix.endswith('A'):
                alt_prefix = mid_prefix[:-1] + 'U'
            frd_tarballs = [t for t in frd_tarballs
                            if mid_prefix in t.upper() or
                            (alt_prefix and alt_prefix in t.upper())]
        for t in frd_tarballs:
            all_tarballs.append((operproc_url, t))

    if not all_tarballs:
        return {"success": True, "dropsondes": [], "n_sondes": 0,
                "message": "No dropsonde tarballs found" + (f" for mission {mission_id}" if mission_id else "")}

    # Fetch and parse all matching tarballs — use the same response builder
    # as TC-RADAR (_build_archive_sonde_response) for consistent output format
    all_sondes = []
    for operproc_url, tarball in all_tarballs[:8]:  # Limit to 8 tarballs
        tarball_url = operproc_url + tarball
        try:
            frd_contents = _fetch_and_extract_frd_tarball(tarball_url)
            for fname, text in frd_contents:
                try:
                    parsed = _parse_frd_file(text)
                    if not parsed or not parsed.get("profile"):
                        continue
                    result_sonde = _build_archive_sonde_response(
                        parsed, center_lat, center_lon,
                        analysis_dt=None,
                        storm_u=-999, storm_v=-999,
                    )
                    if result_sonde:
                        all_sondes.append(result_sonde)
                except Exception as e:
                    logger.warning(f"Failed to parse FRD file {fname}: {e}")
        except Exception as e:
            logger.warning(f"Failed to fetch/extract tarball {tarball}: {e}")

    # Sort by launch time
    all_sondes.sort(key=lambda s: s.get("launch_time", "") or "")

    result = {
        "success": True,
        "dropsondes": all_sondes,
        "n_sondes": len(all_sondes),
        "storm_name": storm_name,
        "year": year,
        "mission_id": mission_id,
        "center_lat": center_lat if abs(center_lat) > 0.1 else None,
        "center_lon": center_lon if abs(center_lon) > 0.1 else None,
    }

    # Only cache positive results — don't cache "no sondes" to avoid
    # blocking future requests when FRD files are posted later
    if all_sondes:
        _sonde_cache[cache_key] = (result, now)
        if len(_sonde_cache) > _SONDE_CACHE_MAX:
            _sonde_cache.popitem(last=False)

    return result


# ── Vortex Data Messages (VDM) ─────────────────────────────────────

NHC_RECON_BASE = "https://www.nhc.noaa.gov/archive/recon"

_vdm_cache: OrderedDict = OrderedDict()
_VDM_CACHE_TTL = 7 * 86400   # 7 days — archive data is immutable
_VDM_CACHE_MAX = 50


def _parse_vdm_position(line_b_text: str):
    """Parse VDM position component (lat or lon).

    Handles multiple formats:
        '16 deg 46 min N'       → 16.767   (deg-min)
        '058 deg 30 min W'      → -58.5    (deg-min)
        '12.98 deg N'           → 12.98    (decimal deg)
        '12.98 deg N 059.09 deg W' → 12.98 (first component only)
    """
    import re
    s = line_b_text.strip()
    # Try deg-min format: "16 deg 46 min N"
    m = re.match(r'(\d+)\s*(?:deg|DEG)\s+(\d+)\s*(?:min|MIN)\s+([NSEW])', s)
    if m:
        val = int(m.group(1)) + int(m.group(2)) / 60.0
        if m.group(3).upper() in ('S', 'W'):
            val = -val
        return round(val, 3)
    # Try decimal-deg format: "12.98 deg N"
    m = re.match(r'([\d.]+)\s*(?:deg|DEG)\s+([NSEW])', s)
    if m:
        val = float(m.group(1))
        if m.group(2).upper() in ('S', 'W'):
            val = -val
        return round(val, 3)
    return None


def _parse_vdm_latlon(lines: list) -> tuple:
    """Parse lat/lon from VDM line B, handling single-line and two-line formats.

    Returns (lat, lon) tuple.
    """
    import re
    for i, line in enumerate(lines):
        if not line.strip().startswith("B."):
            continue
        b_text = re.sub(r'^B\.\s*', '', line.strip())

        # Try single-line format: "12.98 deg N 059.09 deg W"
        m = re.findall(r'([\d.]+)\s*(?:deg|DEG)\s+(?:(\d+)\s*(?:min|MIN)\s+)?([NSEW])', b_text)
        if len(m) >= 2:
            lat_parts, lon_parts = m[0], m[1]
            lat = float(lat_parts[0])
            if lat_parts[1]:
                lat += int(lat_parts[1]) / 60.0
            if lat_parts[2].upper() == 'S':
                lat = -lat
            lon = float(lon_parts[0])
            if lon_parts[1]:
                lon += int(lon_parts[1]) / 60.0
            if lon_parts[2].upper() == 'W':
                lon = -lon
            return (round(lat, 3), round(lon, 3))

        # Try two-line format: lat on B line, lon on next
        lat = _parse_vdm_position(b_text)
        lon = None
        if i + 1 < len(lines):
            lon = _parse_vdm_position(lines[i + 1])
        return (lat, lon)

    return (None, None)


def _parse_vdm_text(text: str, year: int) -> dict | None:
    """Parse a single VDM text message into structured data.

    Handles both modern (2006+, 'VORTEX DATA MESSAGE AL{NN}{YYYY}')
    and legacy (pre-2006, 'DETAILED VORTEX DATA MESSAGE') formats.
    Returns dict with all extracted fields or None on failure.
    """
    import re

    lines = text.strip().splitlines()
    if len(lines) < 10:
        return None

    # Identify storm from header
    atcf_id = None
    for line in lines[:5]:
        m = re.search(r'(AL|EP|CP|WP|IO|SH)\s*(\d{2})\s*(\d{4})', line)
        if m:
            atcf_id = f"{m.group(1)}{m.group(2)}{m.group(3)}"
            break

    # Parse structured lines A–P/Q
    vdm = {"atcf_id": atcf_id, "raw_text": text}

    # Build a dict of line labels → content
    line_map = {}
    for line in lines:
        lm = re.match(r'^([A-Q])\.\s*(.*)', line.strip())
        if lm:
            line_map[lm.group(1)] = lm.group(2).strip()

    # A. Fix time: "05/14:49:00Z" or "27/0518Z"
    a = line_map.get("A", "")
    tm = re.match(r'(\d{1,2})/(\d{2}):?(\d{2}):?(\d{2})?Z?', a)
    if tm:
        day = int(tm.group(1))
        hh = int(tm.group(2))
        mm = int(tm.group(3))
        ss = int(tm.group(4)) if tm.group(4) else 0
        # Determine month from day + year context (we'll refine with start_date later)
        vdm["_day"] = day
        vdm["_hh"] = hh
        vdm["_mm"] = mm
        vdm["_ss"] = ss
    else:
        return None  # Can't parse time → skip

    # B. Position — single line or two lines
    lat, lon = _parse_vdm_latlon(lines)
    vdm["lat"] = lat
    vdm["lon"] = lon

    # C. Flight level: "700 mb 2454 m" or "700 MB 2343 M"
    c = line_map.get("C", "")
    cm = re.search(r'(\d+)\s*(?:mb|MB)', c)
    vdm["flight_level_mb"] = int(cm.group(1)) if cm else None

    # Format-agnostic parsing: the VDM format changed over time.
    # Old (pre-2020): D=max FL wind (kt), H=min SLP (mb), P=aircraft
    # New (2020+):    D=min SLP (mb), H=max FL wind (kt), U=aircraft
    # Solution: scan ALL lettered lines for pressure and wind values.
    vdm["max_fl_wind_kt"] = None
    vdm["min_slp_hpa"] = None
    vdm["eye_temp_c"] = None
    vdm["eyewall_temp_c"] = None
    vdm["eye_shape"] = None
    vdm["eye_diameter_nm"] = None

    for key in "DEFGHIJKLMNOPQRSTU":
        val = line_map.get(key, "")
        if not val:
            continue

        # SLP: standalone pressure value "927 mb" or "943 mb" (not flight level)
        if vdm["min_slp_hpa"] is None and key != "C":
            slp_m = re.match(r'^\s*(\d+)\s*(?:mb|MB|hPa)\s*$', val)
            if slp_m:
                p = int(slp_m.group(1))
                if 850 <= p <= 1050:  # valid SLP range
                    vdm["min_slp_hpa"] = p

        # Max FL wind: standalone wind value "147 kt"
        if vdm["max_fl_wind_kt"] is None:
            wm = re.match(r'^\s*(\d+)\s*(?:kt|KT)\s*$', val)
            if wm:
                w = int(wm.group(1))
                if 10 <= w <= 300:
                    vdm["max_fl_wind_kt"] = w

        # Eye shape: "CLOSED", "OPEN NW", etc.
        if val.upper().startswith("CLOSED") or val.upper().startswith("OPEN"):
            vdm["eye_shape"] = val.strip()

        # Eye diameter: "C25" or "C10"
        diam_m = re.match(r'^C\s*(\d+)\s*$', val.strip())
        if diam_m:
            vdm["eye_diameter_nm"] = int(diam_m.group(1))
        if vdm["eye_diameter_nm"] is None:
            diam_m2 = re.match(r'^E\s*(\d+)', val.strip())
            if diam_m2:
                vdm["eye_diameter_nm"] = int(diam_m2.group(1))

    # Eye/eyewall temperatures: look for "X C / YYYY m" pattern in any line
    temp_matches = []
    for key in "IJKLMNOPQR":
        val = line_map.get(key, "")
        tm = re.search(r'(-?\d+)\s*C\s*/\s*(\d+)\s*m', val)
        if tm:
            temp_matches.append(int(tm.group(1)))
    if len(temp_matches) >= 1:
        vdm["eye_temp_c"] = temp_matches[0]
    if len(temp_matches) >= 2:
        vdm["eyewall_temp_c"] = temp_matches[1]

    # Aircraft/mission/OB: search ALL lines (was in P, now in U)
    aircraft = mission_id = storm_name = None
    ob_number = None
    for line in lines:
        pm = re.search(
            r'(AF\d+|NOAA\d+)\s+(\w+)\s+(\w+)\s+OB\s+(\d+)',
            line.strip(), re.IGNORECASE
        )
        if pm:
            aircraft = pm.group(1).upper()
            mission_id = pm.group(2).upper()
            storm_name = pm.group(3).upper()
            ob_number = int(pm.group(4))
            break
    vdm["aircraft"] = aircraft
    vdm["mission_id"] = mission_id
    vdm["storm_name"] = storm_name
    vdm["ob_number"] = ob_number

    # Post-lettered lines: MAX FL WIND, MAX OUTBOUND, CNTR DROPSONDE, MAX SFMR
    # Use re.search (not re.match) since line wording varies across years
    max_fl = max_outbound = cntr_sonde = max_sfmr = None
    max_fl_bearing = max_fl_range = None
    for line in lines:
        lu = line.strip().upper()
        # "MAX FL WIND 152 KT..." or "MAX OUTBOUND AND MAX FL WIND 158 KT..."
        wm = re.search(r'MAX\s+FL\s+WIND\s+(\d+)\s*KT\s+(\d+)\s*/\s*(\d+)\s*NM', lu)
        if wm:
            w = int(wm.group(1))
            if max_fl is None or w > max_fl:
                max_fl = w
                max_fl_bearing = int(wm.group(2))
                max_fl_range = int(wm.group(3))
        # Simpler match without bearing/range
        wm2 = re.search(r'MAX\s+FL\s+WIND\s+(\d+)\s*KT', lu)
        if wm2 and max_fl is None:
            max_fl = int(wm2.group(1))
        # MAX OUTBOUND FL WIND 127 KT
        om = re.search(r'MAX\s+OUTBOUND\s+FL\s+WIND\s+(\d+)\s*KT', lu)
        if om:
            max_outbound = int(om.group(1))
        # CNTR DROPSONDE SFC WIND
        cm = re.search(r'CNTR\s+DROPSONDE\s+SFC\s+WIND\s+\d+\s*/\s*(\d+)\s*KT', lu)
        if cm:
            cntr_sonde = int(cm.group(1))
        # MAX SFMR or MAX SFC WIND
        sm = re.search(r'MAX\s+(?:SFMR\s+)?SFC\s+WIND\s+(\d+)\s*KT', lu)
        if sm:
            max_sfmr = int(sm.group(1))

    # Prefer post-P MAX FL WIND over line D
    if max_fl is not None:
        vdm["max_fl_wind_kt"] = max_fl
    vdm["max_fl_wind_bearing"] = max_fl_bearing
    vdm["max_fl_wind_range_nm"] = max_fl_range
    vdm["max_outbound_fl_wind_kt"] = max_outbound
    vdm["cntr_sonde_wind_kt"] = cntr_sonde
    vdm["max_sfmr_kt"] = max_sfmr

    return vdm


def _resolve_vdm_time(vdm: dict, year: int, start_date: str, end_date: str) -> str | None:
    """Resolve a VDM's day/time to a full ISO datetime using the storm date range.

    VDMs only have day-of-month + time, so we need the month context.
    """
    day = vdm.get("_day")
    if day is None:
        return None

    from datetime import datetime, timedelta

    try:
        sd = datetime.strptime(start_date, "%Y-%m-%d")
        ed = datetime.strptime(end_date, "%Y-%m-%d")
    except (ValueError, TypeError):
        return None

    # Search ±3 days around the storm date range for the matching day
    best = None
    best_dist = 999
    d = sd - timedelta(days=3)
    while d <= ed + timedelta(days=3):
        if d.day == day:
            # Prefer dates within the storm window
            dist = 0 if sd <= d <= ed else abs((d - sd).days if d < sd else (d - ed).days)
            if dist < best_dist:
                best = d
                best_dist = dist
        d += timedelta(days=1)

    if best is None:
        return None

    hh = vdm.get("_hh", 0)
    mm = vdm.get("_mm", 0)
    ss = vdm.get("_ss", 0)
    dt = best.replace(hour=hh, minute=mm, second=ss)
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


@router.get("/vdm")
def get_vdm(
    storm_name: str = Query(..., description="Storm name"),
    year: int = Query(..., ge=1989, le=2030, description="Year"),
    atcf_id: str = Query("", description="ATCF ID (e.g., AL112017) for filtering 2006+ VDMs"),
    start_date: str = Query("", description="Storm start date YYYY-MM-DD"),
    end_date: str = Query("", description="Storm end date YYYY-MM-DD"),
):
    """Fetch and parse VDMs from the NHC reconnaissance archive."""
    import time as _time
    now = _time.time()
    cache_key = f"vdm_{storm_name.lower()}_{year}"
    if cache_key in _vdm_cache:
        cached, ts = _vdm_cache[cache_key]
        if now - ts < _VDM_CACHE_TTL:
            _vdm_cache.move_to_end(cache_key)
            return cached

    from tc_radar_api import _hrd_fetch_text, _hrd_parse_directory

    vdms = []

    if year >= 2006:
        # Modern format: REPNT2 (Atlantic) or REPPN2 (East/Central Pacific)
        basin_prefix = "REPNT2"
        if atcf_id and atcf_id.upper().startswith("EP"):
            basin_prefix = "REPPN2"
        elif atcf_id and atcf_id.upper().startswith("CP"):
            basin_prefix = "REPPN2"  # Central Pacific also uses REPPN2
        repnt2_url = f"{NHC_RECON_BASE}/{year}/{basin_prefix}/"
        try:
            entries = _hrd_parse_directory(repnt2_url)
        except Exception:
            return {"success": True, "vdms": [], "n_vdms": 0,
                    "message": f"Could not list {basin_prefix} directory"}

        # Filter by date range from filenames (REPNT2-KNHC.YYYYMMDDHHmm.txt)
        import re
        target_files = []
        for entry in entries:
            if not entry.lower().endswith('.txt'):
                continue
            dm = re.search(r'(\d{12})\.txt$', entry)
            if not dm:
                continue
            file_date = dm.group(1)[:8]  # YYYYMMDD
            # Filter to storm date range ±2 days
            if start_date and end_date:
                from datetime import datetime, timedelta
                try:
                    fd = datetime.strptime(file_date, "%Y%m%d")
                    sd = datetime.strptime(start_date, "%Y-%m-%d") - timedelta(days=2)
                    ed = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=2)
                    if not (sd <= fd <= ed):
                        continue
                except ValueError:
                    pass
            target_files.append(entry)

        # Fetch and parse each VDM file (they're tiny, ~400 bytes each)
        storm_upper = storm_name.upper().strip()
        atcf_upper = atcf_id.upper().strip() if atcf_id else ""
        for fname in target_files:
            try:
                text = _hrd_fetch_text(repnt2_url + fname, timeout=10)
                vdm = _parse_vdm_text(text, year)
                if vdm is None:
                    continue
                # Filter by storm: match ATCF ID or storm name
                if atcf_upper and vdm.get("atcf_id") and atcf_upper != vdm["atcf_id"]:
                    continue
                if not atcf_upper and vdm.get("storm_name") and vdm["storm_name"] != storm_upper:
                    continue
                # Resolve full datetime
                iso_time = _resolve_vdm_time(vdm, year, start_date, end_date)
                if iso_time:
                    vdm["time"] = iso_time
                else:
                    continue  # can't resolve time → skip

                # Clean up internal fields (keep raw_text for display)
                for k in ("_day", "_hh", "_mm", "_ss"):
                    vdm.pop(k, None)
                vdms.append(vdm)
            except Exception as e:
                logger.warning(f"Failed to fetch/parse VDM {fname}: {e}")

    else:
        # Legacy format (1989-2005): storm-specific directory with V*.txt files
        # Try both lowercase and uppercase storm names
        storm_dir = None
        for name_variant in [storm_name.lower(), storm_name.upper(), storm_name.capitalize()]:
            test_url = f"{NHC_RECON_BASE}/{year}/{name_variant}/"
            try:
                entries = _hrd_parse_directory(test_url)
                if entries:
                    storm_dir = test_url
                    break
            except Exception:
                continue

        if storm_dir:
            v_files = [e for e in entries if e.upper().startswith("V") and e.lower().endswith(".txt")]
            for fname in v_files:
                try:
                    text = _hrd_fetch_text(storm_dir + fname, timeout=10)
                    vdm = _parse_vdm_text(text, year)
                    if vdm is None:
                        continue
                    iso_time = _resolve_vdm_time(vdm, year, start_date, end_date)
                    if iso_time:
                        vdm["time"] = iso_time
                    for k in ("_day", "_hh", "_mm", "_ss"):
                        vdm.pop(k, None)
                    vdms.append(vdm)
                except Exception as e:
                    logger.warning(f"Failed to fetch/parse legacy VDM {fname}: {e}")

    # Sort by time
    vdms.sort(key=lambda v: v.get("time", ""))

    result = {
        "success": True,
        "storm_name": storm_name,
        "year": year,
        "atcf_id": atcf_id or None,
        "vdms": vdms,
        "n_vdms": len(vdms),
    }

    _vdm_cache[cache_key] = (result, now)
    if len(_vdm_cache) > _VDM_CACHE_MAX:
        _vdm_cache.popitem(last=False)

    return result


# ── Minute Observations (MINOB / HDOB) ─────────────────────────────

_minob_cache: OrderedDict = OrderedDict()
_MINOB_CACHE_TTL = 7 * 86400
_MINOB_CACHE_MAX = 50
_MINOB_GCS_PREFIX = "recon/minob/v3"


def _minob_gcs_key(storm_name: str, year: int) -> str:
    return f"{_MINOB_GCS_PREFIX}/{year}_{storm_name.lower()}.json"


def _minob_gcs_get(storm_name: str, year: int):
    bucket = _get_gcs_bucket()
    if bucket is None:
        return None
    try:
        blob = bucket.blob(_minob_gcs_key(storm_name, year))
        data = blob.download_as_bytes(timeout=8)
        return json.loads(data)
    except Exception:
        return None


def _minob_gcs_put(storm_name: str, year: int, result: dict):
    bucket = _get_gcs_bucket()
    if bucket is None:
        return

    def _upload():
        try:
            blob = bucket.blob(_minob_gcs_key(storm_name, year))
            blob.upload_from_string(
                json.dumps(result, separators=(",", ":")),
                content_type="application/json",
            )
        except Exception as e:
            logger.warning(f"GCS minob cache write failed: {e}")

    import threading
    threading.Thread(target=_upload, daemon=True).start()


def _parse_minob_obs_urnt40(fields: list) -> dict | None:
    """Parse a URNT40 HDOB observation line (2005-era NOAA P-3).

    Format: HHMMSS  LatNN  LonNNN  Alt  ±Dval  DDDSSS  ±TTT  ±DDD  DDDPPP  SfmrKt  Rain
    - Lat/Lon are numeric: lat*100 (N assumed), lon*100 (W assumed)
    - Wind fields are 6-digit packed: dir(3)+speed(3)
    - Temp/dewpoint are signed tenths °C
    - 999 = missing
    """
    if len(fields) < 9:
        return None

    t = fields[0].rstrip(";")
    if not t.isdigit() or len(t) < 6:
        return None
    hh, mm, ss = int(t[:2]), int(t[2:4]), int(t[4:6])
    if hh > 47 or mm > 59:
        return None

    # Lat/Lon: numeric, implicit N/W for Atlantic
    try:
        lat_raw = int(fields[1].rstrip(";"))
        lon_raw = int(fields[2].rstrip(";"))
    except (ValueError, IndexError):
        return None
    lat = lat_raw / 100.0
    lon = -(lon_raw / 100.0)  # West longitude → negative

    def _safe_int(s):
        s = s.rstrip(";")
        if s in ("999", "9999", "/////"):
            return None
        try:
            return int(s)
        except ValueError:
            return None

    geo_alt = _safe_int(fields[3])

    # D-value (signed)
    d_val = _safe_int(fields[4])

    # 30-sec wind: DDDSSS (dir 3 digits, speed 3 digits)
    wdir, wspd_30s = None, None
    w30_raw = fields[5].rstrip(";") if len(fields) > 5 else ""
    if len(w30_raw) == 6 and w30_raw.isdigit():
        wdir = int(w30_raw[:3])
        wspd_30s = int(w30_raw[3:])

    # Temp/dewpoint (signed tenths °C)
    temp_raw = _safe_int(fields[6]) if len(fields) > 6 else None
    dewpt_raw = _safe_int(fields[7]) if len(fields) > 7 else None
    temp_c = round(temp_raw / 10.0, 1) if temp_raw is not None else None
    dewpt_c = round(dewpt_raw / 10.0, 1) if dewpt_raw is not None else None

    # Peak 10-sec wind: DDDPPP
    peak_10s = None
    pk_raw = fields[8].rstrip(";") if len(fields) > 8 else ""
    if len(pk_raw) == 6 and pk_raw.isdigit():
        peak_10s = int(pk_raw[3:])

    # Surface pressure from D-value + geopotential height
    sfc_pres_hpa = None
    # (D-value encoding varies; skip sfc pressure for URNT40)

    return {
        "_hh": hh, "_mm": mm, "_ss": ss,
        "lat": round(lat, 3),
        "lon": round(lon, 3),
        "geo_alt_m": geo_alt,
        "d_value_m": d_val,
        "sfc_pres_hpa": sfc_pres_hpa,
        "wdir_deg": wdir,
        "wspd_30s_kt": wspd_30s,
        "temp_c": temp_c,
        "dewpt_c": dewpt_c,
        "peak_10s_wspd_kt": peak_10s,
    }


def _parse_minob_obs_legacy(fields: list, colatitude: bool = False) -> dict | None:
    """Parse a single legacy MINOB/HDOB observation line (1989–2011).

    Two lat/lon encodings exist:
      SXXX50 format (1990+): HHMM DDMMH DDDMMH GeoHt ...  (hemisphere letters)
      URNT50 format (1989):  HHMM ColLat  Lon   GeoHt ...  (colatitude, numeric-only)

    When colatitude=True:
      field 1 = (90 - lat) * 100  (colatitude in hundredths of degrees)
      field 2 = lon * 100          (West longitude in hundredths of degrees)

    Half-minute timestamps (e.g. "1704.") are supported (2003+ files).
    """
    if len(fields) < 10:
        return None

    # Time — HHMM or HHMM.  (the dot means +30 seconds)
    t = fields[0].rstrip(";")
    half_min = t.endswith(".")
    t = t.rstrip(".")
    if not t.isdigit() or len(t) < 4:
        return None
    hh, mm = int(t[:2]), int(t[2:4])
    ss = 30 if half_min else 0
    if hh > 47 or mm > 59:
        return None

    if colatitude:
        # URNT50 format: numeric colatitude/longitude in hundredths of degrees
        try:
            colat = int(fields[1].rstrip(";"))
            lon_raw = int(fields[2].rstrip(";"))
        except (ValueError, IndexError):
            return None
        lat = 90.0 - colat / 100.0
        lon = -(lon_raw / 100.0)  # West longitude → negative
    else:
        # SXXX50 format: DDMMH hemisphere encoding
        lat_s = fields[1].rstrip(";")
        if lat_s.startswith("/"):
            return None
        lat_hem = lat_s[-1].upper()
        lat_num = lat_s[:-1]
        if len(lat_num) < 4:
            return None
        lat = int(lat_num[:-2]) + int(lat_num[-2:]) / 60.0
        if lat_hem == "S":
            lat = -lat

        lon_s = fields[2].rstrip(";")
        if lon_s.startswith("/"):
            return None
        lon_hem = lon_s[-1].upper()
        lon_num = lon_s[:-1]
        if len(lon_num) < 4:
            return None
        lon = int(lon_num[:-2]) + int(lon_num[-2:]) / 60.0
        if lon_hem == "W":
            lon = -lon

    def _safe_int(s):
        s = s.rstrip(";")
        if "/" in s or not s.lstrip("-").isdigit():
            return None
        return int(s)

    geo_alt = _safe_int(fields[3])               # geopotential height (m)
    xxxx = _safe_int(fields[4])                   # D-value or sfc pressure
    wdir = _safe_int(fields[5])                   # wind direction (deg)
    wspd_30s = _safe_int(fields[6])               # 30-sec avg wind (kt)
    temp_raw = _safe_int(fields[7])               # temp in tenths C
    dewpt_raw = _safe_int(fields[8])              # dewpoint in tenths C
    peak_10s = _safe_int(fields[9]) if len(fields) > 9 else None

    # Decode D-value / surface pressure
    d_value_m = None
    sfc_pres_hpa = None
    if xxxx is not None:
        if xxxx >= 5000:
            d_value_m = -(xxxx - 5000)
        else:
            if xxxx < 1000:
                sfc_pres_hpa = round(1000 + xxxx / 10.0, 1)
            else:
                sfc_pres_hpa = round(xxxx / 10.0, 1)

    # Decode temperature (tenths C, values > 500 mean negative)
    temp_c = None
    if temp_raw is not None:
        if temp_raw > 500:
            temp_c = -(temp_raw - 500) / 10.0
        else:
            temp_c = temp_raw / 10.0

    dewpt_c = None
    if dewpt_raw is not None:
        if dewpt_raw > 500:
            dewpt_c = -(dewpt_raw - 500) / 10.0
        else:
            dewpt_c = dewpt_raw / 10.0

    return {
        "_hh": hh, "_mm": mm, "_ss": ss,
        "lat": round(lat, 3),
        "lon": round(lon, 3),
        "geo_alt_m": geo_alt,
        "d_value_m": d_value_m,
        "sfc_pres_hpa": sfc_pres_hpa,
        "wdir_deg": wdir,
        "wspd_30s_kt": wspd_30s,
        "temp_c": round(temp_c, 1) if temp_c is not None else None,
        "dewpt_c": round(dewpt_c, 1) if dewpt_c is not None else None,
        "peak_10s_wspd_kt": peak_10s,
    }


def _parse_minob_obs_modern(fields: list) -> dict | None:
    """Parse a modern HDOB observation line (2012+, URNT15/AHONT1 format).

    Expected fields:
      HHMMSS  LatH  LonH  PPPP  GGGGG  DDDD  sTTT  sDDD  dddSSS  PKT  SFMR  RAIN  QC
    """
    if len(fields) < 10:
        return None

    t = fields[0].rstrip(";")
    if not t.isdigit() or len(t) < 6:
        return None
    hh, mm, ss = int(t[:2]), int(t[2:4]), int(t[4:6])
    if hh > 47 or mm > 59:
        return None

    lat_s = fields[1].rstrip(";")
    if lat_s.startswith("/"):
        return None
    lat_hem = lat_s[-1].upper()
    lat_num = lat_s[:-1]
    if len(lat_num) < 4:
        return None
    lat = int(lat_num[:-2]) + int(lat_num[-2:]) / 60.0
    if lat_hem == "S":
        lat = -lat

    lon_s = fields[2].rstrip(";")
    if lon_s.startswith("/"):
        return None
    lon_hem = lon_s[-1].upper()
    lon_num = lon_s[:-1]
    if len(lon_num) < 4:
        return None
    lon = int(lon_num[:-2]) + int(lon_num[-2:]) / 60.0
    if lon_hem == "W":
        lon = -lon

    def _safe_int(s):
        s = s.rstrip(";")
        if "/" in s:
            return None
        try:
            return int(s)
        except ValueError:
            return None

    pres_raw = _safe_int(fields[3])
    geo_alt = _safe_int(fields[4])
    d_val_raw = _safe_int(fields[5])

    try:
        temp_c = round(int(fields[6].rstrip(";")) / 10.0, 1)
    except (ValueError, IndexError):
        temp_c = None
    try:
        dewpt_c = round(int(fields[7].rstrip(";")) / 10.0, 1)
    except (ValueError, IndexError):
        dewpt_c = None

    # Wind — combined dddSSS (3-digit dir + 3-digit speed)
    wind_combined = fields[8].rstrip(";") if len(fields) > 8 else ""
    wdir = None
    wspd_30s = None
    if len(wind_combined) >= 6 and wind_combined.isdigit():
        wdir = int(wind_combined[:3])
        wspd_30s = int(wind_combined[3:])

    peak_10s = _safe_int(fields[9]) if len(fields) > 9 else None

    return {
        "_hh": hh, "_mm": mm, "_ss": ss,
        "lat": round(lat, 3),
        "lon": round(lon, 3),
        "geo_alt_m": geo_alt,
        "d_value_m": d_val_raw,
        "sfc_pres_hpa": round(pres_raw / 10.0, 1) if pres_raw is not None else None,
        "wdir_deg": wdir,
        "wspd_30s_kt": wspd_30s,
        "temp_c": temp_c,
        "dewpt_c": dewpt_c,
        "peak_10s_wspd_kt": peak_10s,
    }


def _parse_minob_message(text: str, year: int, start_date: str, end_date: str,
                         storm_filter: str = "") -> list:
    """Parse a MINOB/HDOB text message (one or more SXXX50/URNT15 bulletins).

    Returns list of message dicts, each containing header info and observations.
    """
    import re
    lines = text.strip().splitlines()
    if len(lines) < 3:
        return []

    messages = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Look for WMO header (SXXX50, URNT15, URNT40, or URNT50)
        if not (line.startswith("SXXX50") or line.startswith("URNT15")
                or line.startswith("URNT40") or line.startswith("URNT50")):
            i += 1
            continue

        # URNT50 (1989 era) uses colatitude encoding for lat/lon
        is_colatitude = line.startswith("URNT50")
        # URNT40 (2005 era, NOAA P-3) uses numeric lat/lon and packed wind fields
        is_urnt40 = line.startswith("URNT40")

        # Extract day from header timestamp (e.g., "SXXX50 KMIA 231531" → day=23)
        hdr_parts = line.split()
        hdr_day = None
        if len(hdr_parts) >= 3 and len(hdr_parts[2]) >= 2:
            try:
                hdr_day = int(hdr_parts[2][:2])
            except ValueError:
                pass

        # Next line: mission info
        i += 1
        if i >= len(lines):
            break
        info_line = lines[i].strip()
        info_parts = info_line.split()
        aircraft = info_parts[0] if len(info_parts) > 0 else ""
        mission_id = info_parts[1] if len(info_parts) > 1 else ""
        storm_name = ""
        ob_number = None
        is_modern = False

        # Find MINOB/HDOB keyword
        found_keyword = False
        for k, p in enumerate(info_parts):
            if p in ("MINOB", "HDOB"):
                storm_name = info_parts[k - 1] if k > 1 else ""
                ob_str = info_parts[k + 1] if k + 1 < len(info_parts) else ""
                try:
                    ob_number = int(ob_str)
                except ValueError:
                    pass
                # Modern format has 8-digit date after ob number
                if len(info_parts) > k + 2:
                    date_token = info_parts[k + 2]
                    if len(date_token) == 8 and date_token.isdigit():
                        is_modern = True
                found_keyword = True
                break

        # URNT40 format has no MINOB/HDOB keyword: "NOAA3 1812A KATRINA"
        if not found_keyword and len(info_parts) >= 3:
            storm_name = info_parts[2]

        if storm_filter and storm_name.upper() != storm_filter.upper():
            i += 1
            continue

        # Parse observation lines
        observations = []
        i += 1
        while i < len(lines):
            ol = lines[i].strip()
            if not ol or ol.startswith(("SXXX50", "URNT15", "URNT40", "URNT50")) or ol == "NNNN":
                break
            parts = ol.split()
            if len(parts) < 3:
                i += 1
                continue

            if is_modern:
                obs = _parse_minob_obs_modern(parts)
            elif is_urnt40:
                obs = _parse_minob_obs_urnt40(parts)
            else:
                obs = _parse_minob_obs_legacy(parts, colatitude=is_colatitude)

            if obs is not None:
                day = hdr_day
                h, m, s = obs.pop("_hh"), obs.pop("_mm"), obs.pop("_ss")

                if day is not None and start_date and end_date:
                    from datetime import datetime, timedelta
                    try:
                        sd = datetime.strptime(start_date, "%Y-%m-%d")
                        ed = datetime.strptime(end_date, "%Y-%m-%d")
                        best = None
                        best_dist = 999
                        d = sd - timedelta(days=3)
                        while d <= ed + timedelta(days=3):
                            if d.day == day:
                                dist = 0 if sd <= d <= ed else abs((d - sd).days if d < sd else (d - ed).days)
                                if dist < best_dist:
                                    best = d
                                    best_dist = dist
                            d += timedelta(days=1)
                        if best:
                            # Handle midnight crossing (h >= 24)
                            dt = best.replace(hour=0, minute=m, second=s)
                            dt += timedelta(hours=h)
                            obs["time"] = dt.strftime("%Y-%m-%dT%H:%M:%S")
                        else:
                            hh_wrap = h % 24
                            obs["time"] = f"{year}-01-01T{hh_wrap:02d}:{m:02d}:{s:02d}"
                    except (ValueError, TypeError):
                        hh_wrap = h % 24
                        obs["time"] = f"{year}-01-01T{hh_wrap:02d}:{m:02d}:{s:02d}"
                else:
                    hh_wrap = h % 24
                    obs["time"] = f"{year}-01-01T{hh_wrap:02d}:{m:02d}:{s:02d}"

                observations.append(obs)
            i += 1

        if observations:
            messages.append({
                "aircraft": aircraft,
                "mission_id": mission_id,
                "storm_name": storm_name,
                "ob_number": ob_number,
                "observations": observations,
            })

    return messages


@router.get("/minobs")
def get_minobs(
    storm_name: str = Query(..., description="Storm name"),
    year: int = Query(..., ge=1989, le=2030, description="Year"),
    atcf_id: str = Query("", description="ATCF ID for filtering"),
    start_date: str = Query("", description="Storm start date YYYY-MM-DD"),
    end_date: str = Query("", description="Storm end date YYYY-MM-DD"),
):
    """Fetch and parse MINOB/HDOB minute observations from NHC recon archive."""
    import time as _time
    now = _time.time()
    cache_key = f"minob_{storm_name.lower()}_{year}"
    if cache_key in _minob_cache:
        cached, ts = _minob_cache[cache_key]
        if now - ts < _MINOB_CACHE_TTL:
            _minob_cache.move_to_end(cache_key)
            return cached

    # Check GCS persistent cache (historical storms cached indefinitely)
    from datetime import datetime as _dt
    _is_historical = (year <= _dt.utcnow().year - 2)
    gcs_result = _minob_gcs_get(storm_name, year)
    if gcs_result is not None:
        _minob_cache[cache_key] = (gcs_result, now)
        if len(_minob_cache) > _MINOB_CACHE_MAX:
            _minob_cache.popitem(last=False)
        return gcs_result

    from tc_radar_api import _hrd_fetch_text, _hrd_parse_directory
    import re

    all_messages = []

    if year <= 2005:
        # Eras 1-3: storm-specific directory with M*.txt, H*.txt, or *_HDOBS_*.txt
        storm_dir = None
        for name_variant in [storm_name.lower(), storm_name.upper(), storm_name.capitalize()]:
            test_url = f"{NHC_RECON_BASE}/{year}/{name_variant}/"
            try:
                entries = _hrd_parse_directory(test_url)
                if entries:
                    storm_dir = test_url
                    break
            except Exception:
                continue

        if storm_dir:
            target_files = []
            for entry in entries:
                e_upper = entry.upper()
                if (e_upper.startswith("M") and len(e_upper) > 1 and e_upper[1].isdigit()
                        and entry.lower().endswith(".txt")):
                    target_files.append(entry)
                elif (e_upper.startswith("H") and len(e_upper) > 1 and e_upper[1].isdigit()
                      and entry.lower().endswith(".txt")):
                    target_files.append(entry)
                elif "HDOBS" in e_upper and entry.lower().endswith(".txt"):
                    target_files.append(entry)

            for fname in target_files:
                try:
                    text = _hrd_fetch_text(storm_dir + fname, timeout=10)
                    msgs = _parse_minob_message(text, year, start_date, end_date,
                                                storm_filter=storm_name)
                    all_messages.extend(msgs)
                except Exception as e:
                    logger.warning(f"Failed to fetch/parse MINOB {fname}: {e}")

    elif year <= 2011:
        # Era 4 (2006-2011): HDOB/ directory
        hdob_url = f"{NHC_RECON_BASE}/{year}/HDOB/"
        try:
            entries = _hrd_parse_directory(hdob_url)
        except Exception:
            entries = []

        if start_date and end_date:
            from datetime import datetime, timedelta
            try:
                sd = datetime.strptime(start_date, "%Y-%m-%d") - timedelta(days=2)
                ed = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=2)
            except ValueError:
                sd = ed = None
        else:
            sd = ed = None

        for entry in entries:
            if not entry.lower().endswith(".txt"):
                continue
            dm = re.search(r'(\d{12})\.txt$', entry)
            if not dm:
                continue
            if sd and ed:
                try:
                    fd = datetime.strptime(dm.group(1)[:8], "%Y%m%d")
                    if not (sd <= fd <= ed):
                        continue
                except ValueError:
                    pass
            try:
                text = _hrd_fetch_text(hdob_url + entry, timeout=10)
                msgs = _parse_minob_message(text, year, start_date, end_date)
                all_messages.extend(msgs)
            except Exception as e:
                logger.warning(f"Failed to fetch/parse HDOB {entry}: {e}")

    else:
        # Era 5 (2012+): AHONT1 (Atlantic) or AHOPN1 (Pacific)
        basin_dir = "AHONT1"
        if atcf_id and atcf_id.upper().startswith(("EP", "CP")):
            basin_dir = "AHOPN1"
        hdob_url = f"{NHC_RECON_BASE}/{year}/{basin_dir}/"
        try:
            entries = _hrd_parse_directory(hdob_url)
        except Exception:
            entries = []

        if start_date and end_date:
            from datetime import datetime, timedelta
            try:
                sd = datetime.strptime(start_date, "%Y-%m-%d") - timedelta(days=2)
                ed = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=2)
            except ValueError:
                sd = ed = None
        else:
            sd = ed = None

        for entry in entries:
            if not entry.lower().endswith(".txt"):
                continue
            dm = re.search(r'(\d{12})\.txt$', entry)
            if not dm:
                continue
            if sd and ed:
                try:
                    fd = datetime.strptime(dm.group(1)[:8], "%Y%m%d")
                    if not (sd <= fd <= ed):
                        continue
                except ValueError:
                    pass
            try:
                text = _hrd_fetch_text(hdob_url + entry, timeout=10)
                msgs = _parse_minob_message(text, year, start_date, end_date,
                                            storm_filter=storm_name)
                all_messages.extend(msgs)
            except Exception as e:
                logger.warning(f"Failed to fetch/parse AHONT1 {entry}: {e}")

    # Flatten observations with parent metadata
    flat_obs = []
    seen = set()
    for msg in all_messages:
        for obs in msg["observations"]:
            # Deduplicate by time+lat+lon (archive files often contain repeated messages)
            key = (obs.get("time", ""), obs.get("lat"), obs.get("lon"))
            if key in seen:
                continue
            seen.add(key)
            obs["aircraft"] = msg["aircraft"]
            obs["mission_id"] = msg["mission_id"]
            flat_obs.append(obs)

    flat_obs.sort(key=lambda o: o.get("time", ""))

    result = {
        "success": True,
        "storm_name": storm_name,
        "year": year,
        "observations": flat_obs,
        "n_obs": len(flat_obs),
        "n_messages": len(all_messages),
    }

    _minob_cache[cache_key] = (result, now)
    if len(_minob_cache) > _MINOB_CACHE_MAX:
        _minob_cache.popitem(last=False)

    # Persist to GCS (historical storms cached indefinitely, recent 7-day)
    if flat_obs:
        _minob_gcs_put(storm_name, year, result)

    return result
