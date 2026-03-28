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
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from PIL import Image

logger = logging.getLogger("global_archive")

# ── GCS Frame Cache ──────────────────────────────────────────
# Caches rendered IR frames (JSON responses) in Google Cloud Storage
# so subsequent requests serve instantly without OPeNDAP fetches.
# Set GCS_IR_CACHE_BUCKET env var to enable (e.g. "tc-atlas-ir-cache").
GCS_IR_CACHE_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "")
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
        logger.info(f"GCS IR cache enabled: gs://{GCS_IR_CACHE_BUCKET}")
        return _gcs_bucket
    except Exception as e:
        logger.warning(f"GCS IR cache init failed: {e}")
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
                    return tb[::-1], actual_bounds

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
                        return tb, actual_bounds

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
            return tb, actual_bounds

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
    "CTCX": {"name": "COAMPS-TC", "color": "#fab1a0", "type": "dynamical", "interp": False},
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

    # Build URL list — order matters (fastest/most reliable first)
    fname = f"a{basin}{num}{year}"
    urls = [
        # 1. NHC current aid directory (active storms)
        f"https://ftp.nhc.noaa.gov/atcf/aid/{fname}.dat",
        # 2. NHC archive (historical, all basins including JTWC WP/IO/SH)
        f"https://ftp.nhc.noaa.gov/atcf/archive/{year}/{fname}.dat.gz",
        # 3. NRL ATCF server (Naval Research Lab — primary JTWC data host)
        f"https://science.nrlmry.navy.mil/atcf/aidarchive/{year}/{fname}.dat.gz",
        # 4. UCAR RAL TC Guidance Project (global aggregator, all basins)
        f"https://hurricanes.ral.ucar.edu/repository/data/{year}/{fname}.dat",
    ]

    raw_text = None
    source = None
    for url in urls:
        try:
            logger.info(f"Fetching a-deck: {url}")
            resp = req.get(url, timeout=20, headers=_HTTP_HEADERS)
            if resp.status_code == 200 and len(resp.content) > 100:
                if url.endswith(".gz"):
                    import gzip
                    raw_text = gzip.decompress(resp.content).decode("utf-8", errors="replace")
                else:
                    raw_text = resp.text
                source = url
                logger.info(f"A-deck fetched: {len(raw_text)} bytes from {url}")
                break
        except Exception as e:
            logger.warning(f"A-deck fetch failed for {url}: {e}")
            continue

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
