#!/usr/bin/env python3
"""build_ir_mosaic.py — POC IR mosaic tile builder (GOES-19 + GOES-18).

One cached-kernel pipeline that serves BOTH:
  • global mosaic  (z0–zmax)          — the whole GOES-E/W field
  • storm detail   (--storm, z6–z7)   — high-zoom tiles over active storms,
                                         the SAME tiles a "storm card" needs

Web-Mercator XYZ PNG tiles a WebGL map (MapLibre) consumes as one raster
source → continuous zoom from the globe straight into a storm.

Reuses satellite_ir.py: GOES S3 access, file finder, IR colormap LUT, the
exact render normalization, and the geostationary projection constants.

Blend: each pixel takes the NEARER-NADIR satellite via a near-cutline weight
(cosz**BLEND_P, normalized) — a thin feather instead of a wide average, which
avoids parallax double-imaging of tall cold tops and limb bleed.

Usage:
  python build_ir_mosaic.py --build-kernel              # one-time kernels
  python build_ir_mosaic.py --time                      # global render
  python build_ir_mosaic.py --storm --time              # global + active storms
  python build_ir_mosaic.py --storm-at 16,-95           # global + a test point
"""
import argparse
import concurrent.futures as _cf
import gc
import io
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

import numpy as np

# ── Reuse the production satellite stack ───────────────────────────────────
from satellite_ir import (
    GOES_BUCKETS, GOES_SAT_HEIGHT, IR_BAND, IR_VMIN, IR_VMAX, _IR_LUT,
    find_goes_file, get_goes_fs,
    HIMAWARI_BUCKET, HIMAWARI_LON_0, HIMAWARI_SAT_HEIGHT, HIMAWARI_SWEEP,
    find_himawari_file, open_himawari_subset,
    VIS_BAND, WV_BAND, HIMAWARI_VIS_BAND, HIMAWARI_WV_BAND, BAND_RANGES,
)
# Shared gated IR center-finder (g1/g2/g3 policy) — reused, never reimplemented.
from tc_center_fix import apply_center_gates

OUT_DIR = os.environ.get("MOSAIC_OUT", "mosaic_out")
KERNEL_DIR = os.path.join(OUT_DIR, "kernels")
API_BASE = "https://api.tcatlas.org"
TILE_SIZE = 512   # 512px tiles: 4× fewer tiles/frame than 256 for the same native
                  # pixels (S = TILE_SIZE·2^zmax stays 8192 with zmax 4). Frontend
                  # passes tileSize:512 so MapLibre maps map-zoom→tile-z directly.

# Blend / crop tuning -------------------------------------------------------
BLEND_P = 40.0        # cutline sharpness: w = (cosz/cosz_max)**P. Higher =
                      # narrower feather (less parallax ghost), risk of seam.
LIMB_DEG = 76.0       # drop pixels seen more than this far off-nadir (limb junk)
STORM_BOX_DEG = 6.0   # half-box baked around each storm
STORM_ZOOMS = (5, 6)  # storm-detail zoom levels. With 512px tiles, z5/z6 give the
                      # same resolution the old 256px z6/z7 did (512@zN == 256@z(N+1)).
# Visible storm sectors go one level deeper (z7 ≈ 0.61 km/px at the equator) and
# are fed by a 1-km hi-res Vis read (coarsen 2 instead of 4; Himawari 1000 m grid)
# so the extra zoom carries real detail — IR/WV are 2-km native, already fully
# resolved at z6, and stay at STORM_ZOOMS. The hi-res read only happens when
# there are active storms to bake (quiet cycles are byte-identical to today).
VIS_STORM_ZMAX = int(os.environ.get("MOSAIC_VIS_STORM_ZMAX", "7"))
VIS_HIRES = os.environ.get("MOSAIC_VIS_HIRES", "1") not in ("0", "false", "off")
# Skip a sat's hi-res window when the storm is > ~50° off-nadir: the P=40
# cutline blend gives that sat ~zero weight there anyway (a nearer sat's native
# window carries the tile), and every skipped window is ~37 MB not held at the
# 4 GiB job's peak. Live 2026-07-21 00Z: 3 storms → 3 windows on EACH GOES →
# first attempt OOM'd (signal 9) every run; the gate + float16 halve that load.
_VIS_HIRES_MIN_COSW = 0.64


def storm_zooms_for(product):
    if PRODUCTS[product]["kind"] == "vis" and VIS_HIRES and VIS_STORM_ZMAX > STORM_ZOOMS[-1]:
        return tuple(range(STORM_ZOOMS[0], VIS_STORM_ZMAX + 1))
    return STORM_ZOOMS

# (key, kind, bucket, label). lon_0/grid come from each file's own navigation.
SATS = [
    ("east", "goes",     GOES_BUCKETS["east_19"], "GOES-19"),
    ("west", "goes",     GOES_BUCKETS["west"],    "GOES-18"),
    ("hima", "himawari", HIMAWARI_BUCKET,         "Himawari-9"),
]


def log(msg):
    print(f"[mosaic] {msg}", flush=True)


# ── Cloudflare R2 output (production) — mirrors ir_monitor_api._r2_put_public ──
R2_PREFIX = os.environ.get("MOSAIC_R2_PREFIX", "mosaic-v2")  # bump to invalidate all
                                        # tiles/kernels (v2 = 512px tiles / zmax 4)
# Tile pixel format. "rgba" = baked-colormap RGBA PNG (current/default; the frontend
# displays it directly). "idx" = single-channel 8-bit brightness-INDEX PNG (0 = no-data
# sentinel) colormapped on the CLIENT (GPU forward-LUT) — ~64% smaller egress, exact-Tb
# hover, no banding, zero data-quality loss (the index is the same 256-level quantization
# baked today). Flag-gated: the live job leaves MOSAIC_TILE_MODE unset → "rgba" → byte-
# identical to today. Pair an idx run with MOSAIC_R2_PREFIX=mosaic-v3 so it never touches v2.
TILE_MODE = os.environ.get("MOSAIC_TILE_MODE", "rgba").lower()
IDX_PNG_LEVEL = int(os.environ.get("MOSAIC_IDX_PNG_LEVEL", "6"))  # spike: L6 = -64% egress, +~1s/frame
# Packed-frame output. "off" (default) = one R2 PUT per tile (~260 Class-A ops/
# product-frame). "dual" = tiles AND a single pack.bin (concatenated PNGs) +
# index.json per product-frame (transition mode: pack-aware clients range-read
# the pack, old clients keep the tiles). "only" = pack alone (~3 PUTs/product-
# frame — the Class-A saving lands). Packed frames are advertised per-frame in
# frames.json `pack_frames`; the frontend range-reads via the index (and skips
# the network entirely for tiles the index says don't exist).
PACK_MODE = os.environ.get("MOSAIC_PACK", "off").lower()
R2_KEEP_FRAMES = 18                     # rolling loop kept hot (~3 h at 10-min)
_r2_client = None


def _get_r2():
    """Lazy boto3 S3 client against R2; creds from env (Secret Manager in prod)."""
    global _r2_client
    if _r2_client is not None:
        return _r2_client
    import boto3
    from botocore.config import Config as _Cfg
    ep = os.environ.get("R2_ENDPOINT_URL", "").rstrip("/")
    ak = os.environ.get("R2_ACCESS_KEY_ID", "")
    sk = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not (ep and ak and sk):
        log("R2 creds/endpoint missing — set R2_ENDPOINT_URL/R2_ACCESS_KEY_ID/"
            "R2_SECRET_ACCESS_KEY"); return None
    _r2_client = boto3.client("s3", endpoint_url=ep, aws_access_key_id=ak,
                              aws_secret_access_key=sk, region_name="auto",
                              config=_Cfg(signature_version="s3v4",
                                          retries={"max_attempts": 3, "mode": "standard"}))
    return _r2_client


def _r2_bucket():
    return os.environ.get("R2_BUCKET", "tc-atlas-rt")


def r2_put(key, body, content_type, cache_control):
    c = _get_r2()
    if c is None:
        raise RuntimeError("R2 not configured")
    c.put_object(Bucket=_r2_bucket(), Key=key, Body=body,
                 ContentType=content_type, CacheControl=cache_control)


# Immutable per-timestamp tiles (content never changes) vs short-TTL manifest.
TILE_CACHE = "public, max-age=604800, immutable"
MANIFEST_CACHE = "public, max-age=60"


# ── Web Mercator helpers (slippy-map convention) ───────────────────────────
def pixels_to_lonlat(px, py, S):
    """Global Mercator pixel centres (px col, py row; image size S) → lon, lat."""
    lon = px / S * 360.0 - 180.0
    n = np.pi - 2.0 * np.pi * py / S
    lat = np.degrees(np.arctan(np.sinh(n)))
    return lon, lat


def lon_to_tilex(lon, z):
    return int((lon + 180.0) / 360.0 * (2 ** z))


def lat_to_tiley(lat, z):
    r = np.radians(max(-85.0, min(85.0, lat)))
    return int((1.0 - np.arcsinh(np.tan(r)) / np.pi) / 2.0 * (2 ** z))


def tile_lonlat(z, x, y):
    """(256,256) LON, LAT grids for tile (z,x,y)."""
    S = TILE_SIZE * (2 ** z)
    col = (x * TILE_SIZE + np.arange(TILE_SIZE) + 0.5)
    row = (y * TILE_SIZE + np.arange(TILE_SIZE) + 0.5)
    lon = col / S * 360.0 - 180.0
    n = np.pi - 2.0 * np.pi * row / S
    lat = np.degrees(np.arctan(np.sinh(n)))
    return (np.broadcast_to(lon[None, :], (TILE_SIZE, TILE_SIZE)),
            np.broadcast_to(lat[:, None], (TILE_SIZE, TILE_SIZE)))


# ── Geostationary projection core (shared by global kernel & storm tiles) ──
def grid_of(x, y):
    return (x[0], (x[-1] - x[0]) / (x.size - 1), x.size,
            y[0], (y[-1] - y[0]) / (y.size - 1), y.size)


def project_to_sat(LON, LAT, grid, lon_0, sat_h, sweep):
    """Map geographic LON/LAT (any shape) onto a satellite's fixed grid.
    Returns idx (flat row*nx+col, int32), cosz (cos viewing angle, limb-masked
    to 0, float32), mask (bool on-disk & within the LIMB_DEG crop)."""
    import pyproj
    x0, dx, nx, y0, dy, ny = grid
    proj = pyproj.Proj(proj="geos", h=sat_h, lon_0=lon_0, sweep=sweep)
    xm, ym = proj(np.asarray(LON), np.asarray(LAT), errcheck=False)
    xr_ = np.asarray(xm) / sat_h
    yr_ = np.asarray(ym) / sat_h
    cosw = np.cos(np.radians(LAT)) * np.cos(np.radians(np.asarray(LON) - lon_0))
    limb_cos = np.cos(np.radians(LIMB_DEG))
    on = (np.isfinite(xr_) & np.isfinite(yr_) & (np.abs(xr_) < 1e3) &
          (cosw > limb_cos))
    xs = np.where(on, xr_, x0)
    ys = np.where(on, yr_, y0)
    col = np.round((xs - x0) / dx).astype(np.int32)
    row = np.round((ys - y0) / dy).astype(np.int32)
    mask = on & (col >= 0) & (col < nx) & (row >= 0) & (row < ny)
    col = np.clip(col, 0, nx - 1)
    row = np.clip(row, 0, ny - 1)
    idx = (row.astype(np.int64) * nx + col).astype(np.int32)
    cosz = np.clip(cosw, 0.0, 1.0).astype(np.float32)
    cosz[~mask] = 0.0
    return idx, cosz, mask


def blend_samples(samples):
    """samples: list of (gathered_tb, cosz, valid_mask), all same shape.
    Near-cutline blend: normalize each sat's cosz by the per-pixel max, raise to
    BLEND_P, weight-average. Nearer-nadir wins outside a thin feather → no
    wide-area averaging of parallax-offset cold tops."""
    shape = samples[0][0].shape
    # float32 (was float64): halves the peak blend footprint — the cosz_stack +
    # num/den at 8192² are what forced 16 GiB — so the job can run at 8 GiB. Tb
    # (180-310 K) and the cos² cutline weights are well within float32's ~7 sig
    # figs; where ratio**BLEND_P underflows it's a far-off-nadir pixel whose weight
    # is meant to be ~0 anyway, so the cutline result is unchanged.
    cosz_stack = np.stack([np.where(v, c, 0.0).astype(np.float32)
                           for (_, c, v) in samples])
    cmax = cosz_stack.max(axis=0)
    num = np.zeros(shape, np.float32)
    den = np.zeros(shape, np.float32)
    with np.errstate(divide="ignore", invalid="ignore"):
        for k, (tb_g, _c, v) in enumerate(samples):
            ratio = np.where(cmax > 0, cosz_stack[k] / cmax, 0.0)
            w = np.where(v, ratio ** BLEND_P, 0.0)
            num += w * np.where(v, tb_g, 0.0)
            den += w
        out = np.where(den > 0, num / den, np.nan)
    return out.astype(np.float32)


# ── Multi-band products (IR + Water Vapor + Visible) ───────────────────────
# Each product reads a different band but reuses the SAME geos→Mercator kernels:
# WV (Band 8) is native 2 km = the IR grid; Visible (Band 2/3) is 0.5 km and is
# block-averaged 4× down to the 2 km grid on read, so the IR kernel applies.
# (GOES Band 2 21696² / 4 = 5424² = the Band-13 grid; Himawari Band 3 likewise.)
PRODUCTS = {
    "ir":  dict(goes=IR_BAND,  hima=IR_BAND,          coarsen=1, kind="ir",  night=False),
    "wv":  dict(goes=WV_BAND,  hima=HIMAWARI_WV_BAND, coarsen=1, kind="wv",  night=False),
    # Visible: 0.5 km → coarsen 4× to 2 km; night side masked to transparent.
    # tol 60: 0.5 km Vis posts later than IR/WV, so accept an older scan (Vis
    # changes slowly and the night side is masked anyway).
    "vis": dict(goes=VIS_BAND, hima=HIMAWARI_VIS_BAND, coarsen=4, kind="vis", night=True, tol=60),
}
_NIGHT_ELEV_DEG = -6.0   # civil twilight: below this, Visible is masked clear
# Vis STORM tiles only: drop extreme-limb pixels (cos of view angle below this).
# Reflectance from a far-limb satellite (e.g. GOES-West's far-western edge over
# the WPac, cosz~0.32 at 152°E) is dim + geometrically distorted; when it was
# used ALONE — because Himawari's slower 0.5 km Vis hadn't posted at build time —
# the storm tile came out ~half brightness and flashed as a "jump" in the loop.
# 0.35 excludes that (~69° view) while passing Himawari everywhere it covers
# (cosz ≥ ~0.40 even at its 75°E western edge) and GOES-West when it's a decent
# view (≥0.36). No near-nadir view → tile skipped → frame becomes a gap.
_VIS_STORM_MIN_COSZ = 0.35

# Keep the standard 170-260 K WV range so the global mosaic, the storm-card raw-WV
# encoding (BAND_RANGES[8]) and the client LUT all share ONE Tb→color mapping
# (matched). frac = 1 - (Tb-170)/90.
_WV_VMIN, _WV_VMAX = 170.0, 260.0

# IR *index-encoding* range — DELIBERATELY WIDER than the display colour limits
# (IR_VMIN/IR_VMAX = 190/310, imported from satellite_ir). to_index() quantizes Tb
# into the 1..255 idx over THIS range; the client decodes idx→Tb with the same
# limits (published per-frame as `ir_trange` in frames.json) so cold tops below
# −83 °C (190 K) read their real temperature instead of saturating. Precision is
# (330-160)/254 ≈ 0.67 K/step (was 0.47 over 190-310) — inside ABI noise. Do NOT
# fold these into IR_VMIN/IR_VMAX: those anchor the DISPLAY colormap for every
# rendered IR product (ir-frame.jpg, OG card, archive) and the client clamps the
# decoded Tb back to [IR_VMIN, IR_VMAX] before colouring, so the look is unchanged.
IR_IDX_VMIN, IR_IDX_VMAX = 160.0, 330.0


# Diverging Water-Vapor LUT — the SHARED design (mirrored in ir_monitor_api.py
# _CLAUDE_WV_FRAC_STOPS and satellite.js IR_COLORMAPS['wv'] so global + storm-card
# WV look identical). Colors anchored to Tb: DRY warm tail → dark→tan brown; a
# light cream NEUTRAL near ~232 K; then MOIST → pale-blue→blue→teal→green→mint
# (deep convection). The earlier CIMSS port's divergence sat too cold so mid-trop
# Tb read brown ("too much brown"); this moves the neutral warmer and lets
# lightness carry the gradient so moist pockets pop as white/blue against the dry.
_CLAUDE_WV_FRAC_STOPS = [
    (0.000,  45,  28,  12),   # 260 K  very dry — darkest brown
    (0.056,  60,  38,  18),   # 255 K  dark espresso
    (0.122, 105,  68,  34),   # 249 K  brown
    (0.178, 158, 110,  60),   # 244 K  tan-brown
    (0.233, 205, 162, 105),   # 239 K  sand
    (0.278, 238, 212, 170),   # 235 K  pale sand
    (0.311, 250, 244, 230),   # 232 K  cream (neutral, lightest)
    (0.356, 212, 234, 246),   # 228 K  pale blue — moisture onset
    (0.411, 158, 206, 238),   # 223 K  light blue
    (0.467,  96, 170, 222),   # 218 K  blue
    (0.511,  48, 124, 200),   # 214 K  medium blue
    (0.567,  26,  88, 175),   # 209 K  deep blue
    (0.611,  26, 118, 156),   # 205 K  blue-teal
    (0.656,  34, 158, 128),   # 201 K  teal-green
    (0.711,  78, 198,  98),   # 196 K  green
    (0.800, 140, 225, 130),   # 188 K  light green
    (0.889, 200, 245, 195),   # 180 K  pale green
    (1.000, 240, 252, 228),   # 170 K  mint — deep convection / overshoot
]


def _build_wv_lut():
    stops = sorted(_CLAUDE_WV_FRAC_STOPS, key=lambda s: s[0])
    lut = np.zeros((256, 4), dtype=np.uint8)
    for i in range(256):
        f = i / 255.0
        lo, hi = stops[0], stops[-1]
        for s in range(len(stops) - 1):
            if stops[s][0] <= f <= stops[s + 1][0]:
                lo, hi = stops[s], stops[s + 1]; break
        t = 0.0 if hi[0] == lo[0] else max(0.0, min(1.0, (f - lo[0]) / (hi[0] - lo[0])))
        lut[i, :3] = [int(lo[1 + c] + t * (hi[1 + c] - lo[1 + c]) + 0.5) for c in range(3)]
        lut[i, 3] = 255
    return lut


_WV_LUT = _build_wv_lut()


def coarsen2d(a, f):
    """Block-average a 2-D array by integer factor f (f=1 → unchanged). Crops to a
    multiple of f first. Used to bring 0.5 km Visible down to the 2 km IR grid."""
    if f <= 1:
        return a
    ny, nx = a.shape
    ny2, nx2 = (ny // f) * f, (nx // f) * f
    a = a[:ny2, :nx2]
    return a.reshape(ny2 // f, f, nx2 // f, f).mean(axis=(1, 3))


# Strip-decode factor for the coarsen (0.5 km Visible) read. GOES Band-2 is a
# 21696² disk that decodes to ~1.9 GiB float32; materializing it whole is the
# single biggest term in the mosaic's peak RSS (VIS-only 4.6 GiB vs IR 2.8).
# Reading it in N row-strips and block-averaging each strip caps the transient
# at ~one strip, dropping VIS peak to ≈ the IR peak. Set 0 to fall back to the
# legacy whole-array read.
_READ_STRIPS = int(os.environ.get("MOSAIC_READ_STRIPS", "8"))


def _coarsen_read(da, f, n_strips):
    """Block-average a lazy 2-D DataArray by factor f, decoding only ~1/n_strips
    of the source rows at a time so the full-resolution array is never
    materialized. Byte-identical to coarsen2d(np.asarray(da.values, f32), f):
    same crop-to-multiple-of-f, same block mean, and strip boundaries are forced
    onto multiples of f so no block is ever split across strips."""
    ny, nx = da.shape
    ny_c, nx_c = (ny // f) * f, (nx // f) * f
    if ny_c == 0 or nx_c == 0:
        return np.empty((0, 0), np.float32)
    out = np.empty((ny_c // f, nx_c // f), np.float32)
    rows_c = ny_c // f                                  # output rows
    per = max(1, math.ceil(rows_c / max(1, n_strips)))  # output rows per strip
    step = per * f                                       # source rows per strip (× f)
    for r0 in range(0, ny_c, step):
        r1 = min(r0 + step, ny_c)
        block = np.asarray(da[r0:r1, :nx_c].values, dtype=np.float32)  # one strip only
        out[r0 // f:r1 // f] = coarsen2d(block, f)
        del block
    return out


_libc = None


def _release_memory():
    """gc + glibc malloc_trim(0) so freed per-product arrays are returned to the
    OS between bands, preventing the ir→wv→vis arena retention (~1.8 GiB) that
    pushes the full run's peak well above any single band's. No-op off glibc
    (e.g. local macOS dev)."""
    global _libc
    gc.collect()
    try:
        if _libc is None:
            import ctypes
            _libc = ctypes.CDLL("libc.so.6", use_errno=False)
        _libc.malloc_trim(0)
    except Exception:
        pass


def solar_elev_grid(LAT, LON, dt):
    """Vectorized solar elevation (deg) over lat/lon arrays — vectorized twin of
    ir_monitor_api._solar_elevation; drives the Visible night mask."""
    doy = dt.timetuple().tm_yday
    decl = math.radians(-23.44 * math.cos(math.radians(360.0 / 365.0 * (doy + 10))))
    utc_h = dt.hour + dt.minute / 60.0 + dt.second / 3600.0
    ha = np.radians((utc_h - 12.0) * 15.0 + LON)
    latr = np.radians(LAT)
    sin_elev = (np.sin(latr) * math.sin(decl) +
                np.cos(latr) * math.cos(decl) * np.cos(ha))
    return np.degrees(np.arcsin(np.clip(sin_elev, -1.0, 1.0)))


def colormap(arr, product):
    """Blended band value → RGBA uint8 for the given product; NaN→clear.
    IR/WV are Tb (K) with inverted frac + their LUT; Visible is reflectance (0–1),
    grayscale, no inversion. Night masking (Visible) is applied by the caller,
    which has the per-pixel lat/lon to compute solar elevation."""
    kind = PRODUCTS[product]["kind"]
    if kind == "ir":
        frac = np.clip(1.0 - (arr - IR_VMIN) / (IR_VMAX - IR_VMIN), 0.0, 1.0)
        rgba = _IR_LUT[(np.nan_to_num(frac) * 255).astype(np.uint8)].copy()
    elif kind == "wv":
        frac = np.clip(1.0 - (arr - _WV_VMIN) / (_WV_VMAX - _WV_VMIN), 0.0, 1.0)
        rgba = _WV_LUT[(np.nan_to_num(frac) * 255).astype(np.uint8)].copy()
    else:  # vis: reflectance 0–1, grayscale, gamma-free
        frac = np.clip(arr, 0.0, 1.0)
        gray = (np.nan_to_num(frac) * 245.0 + 10.0).astype(np.uint8)
        rgba = np.zeros(arr.shape + (4,), np.uint8)
        rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = gray
        rgba[..., 3] = 255
    rgba[~np.isfinite(arr)] = (0, 0, 0, 0)
    return rgba


def to_index(arr, product):
    """Blended band value → single-channel uint8 brightness INDEX (idx mode).
    Mirrors colormap()'s frac math EXACTLY so idx→Tb is the identical mapping the
    client forward-LUT uses; only the final LUT expansion is skipped. 0 is reserved
    as the no-data sentinel (the client renders it transparent), so valid data is
    clamped to 1..255 — this only nudges the single warmest level (idx 0 ≈ 330 K,
    extremely rare) up by ~0.7 K, invisibly. NaN (off-disk/limb) → 0.

    IR uses the WIDER IR_IDX_VMIN/VMAX (160-330), NOT the display IR_VMIN/VMAX, so
    the encoded index preserves real cold-top Tb below 190 K; the client publishes
    this range per-frame (ir_trange) and clamps to [IR_VMIN,IR_VMAX] for colour."""
    kind = PRODUCTS[product]["kind"]
    if kind == "ir":
        frac = np.clip(1.0 - (arr - IR_IDX_VMIN) / (IR_IDX_VMAX - IR_IDX_VMIN), 0.0, 1.0)
        idx = (np.nan_to_num(frac) * 255).astype(np.uint8)
    elif kind == "wv":
        frac = np.clip(1.0 - (arr - _WV_VMIN) / (_WV_VMAX - _WV_VMIN), 0.0, 1.0)
        idx = (np.nan_to_num(frac) * 255).astype(np.uint8)
    else:  # vis: reflectance 0–1 → 10..255 gray (matches colormap()'s gray ramp)
        frac = np.clip(arr, 0.0, 1.0)
        idx = (np.nan_to_num(frac) * 245.0 + 10.0).astype(np.uint8)
    np.maximum(idx, 1, out=idx)          # reserve 0 for no-data; valid is 1..255
    idx[~np.isfinite(arr)] = 0           # no-data sentinel
    return idx


# ── Read a full-disk band for every satellite, once per cycle ──────────────
# `band` + `coarsen` come from PRODUCTS[product]. Visible (0.5 km) is block-
# averaged by `coarsen` (4×) inside the reader so only the 2 km grid is retained
# (frees the big native array promptly) and the IR-grid kernels stay applicable.
def _goes_hires_windows(da, x, y, lon_0, sat_h, sweep, windows):
    """Decode NATIVE-resolution sub-windows of an open (in-memory) GOES CMI var
    for the given lat/lon boxes [(lat0, lat1, lon0, lon1), ...] — the hi-res
    source for Vis z7 storm-sector tiles. Slicing `da` decodes only the HDF5
    chunks the window touches, so this adds ~tens of MB per storm, not the
    ~1.9 GB full native field. Returns [(data, x_w, y_w), ...]."""
    import pyproj
    out = []
    proj = pyproj.Proj(proj="geos", h=sat_h, lon_0=lon_0, sweep=sweep)
    x_asc = bool(x[-1] > x[0]); y_asc = bool(y[-1] > y[0])
    for (lat0, lat1, lon0, lon1) in windows:
        clat = 0.5 * (lat0 + lat1); clon = 0.5 * (lon0 + lon1)
        cosw = math.cos(math.radians(clat)) * math.cos(math.radians(clon - lon_0))
        if cosw < _VIS_HIRES_MIN_COSW:
            continue                      # far off-nadir: ~zero blend weight, skip
        # Perimeter-sample the box (geos maps a lat/lon box to a skewed quad).
        ts_ = np.linspace(0.0, 1.0, 9)
        lats = np.concatenate([np.full(9, lat0), np.full(9, lat1),
                               lat0 + ts_ * (lat1 - lat0), lat0 + ts_ * (lat1 - lat0)])
        lons = np.concatenate([lon0 + ts_ * (lon1 - lon0), lon0 + ts_ * (lon1 - lon0),
                               np.full(9, lon0), np.full(9, lon1)])
        xm, ym = proj(lons, lats, errcheck=False)
        xr_ = np.asarray(xm) / sat_h; yr_ = np.asarray(ym) / sat_h
        ok = np.isfinite(xr_) & np.isfinite(yr_) & (np.abs(xr_) < 1e3) & (np.abs(yr_) < 1e3)
        if not ok.any():
            continue                      # box entirely off this sat's disk
        xw0, xw1 = float(xr_[ok].min()), float(xr_[ok].max())
        yw0, yw1 = float(yr_[ok].min()), float(yr_[ok].max())
        def _rng(axis, lo, hi, asc):
            i0 = np.searchsorted(axis if asc else axis[::-1], lo)
            i1 = np.searchsorted(axis if asc else axis[::-1], hi, side="right")
            n = axis.size
            if not asc:
                i0, i1 = n - i1, n - i0
            return max(0, int(i0) - 4), min(n, int(i1) + 4)
        c0, c1 = _rng(x, xw0, xw1, x_asc)
        r0, r1 = _rng(y, yw0, yw1, y_asc)
        if r1 - r0 < 8 or c1 - c0 < 8:
            continue
        # float16: reflectance (0-1, display-quantized to 1/255) is comfortably
        # inside f16 precision, and it halves what the window holds at peak RAM.
        w = np.asarray(da[r0:r1, c0:c1].values, dtype=np.float32).astype(np.float16)
        out.append((w, x[c0:c1].copy(), y[r0:r1].copy()))
    return out


def read_full_disk(bucket, dt, band=IR_BAND, coarsen=1, tol=20, hires_windows=None,
                   windows_only=False):
    import xarray as xr
    key, scan_dt = find_goes_file(bucket, dt, tolerance_min=tol, band=band,
                                  return_dt=True)
    if not key:
        return None
    fs = get_goes_fs()
    # Full download → BytesIO (like the Himawari path). Streaming via fs.open +
    # h5netcdf needs random access that s3fs doesn't reliably provide in the slim
    # container — it failed there while working locally. cat_file is robust.
    raw = fs.cat_file(key)
    ds = xr.open_dataset(io.BytesIO(raw), engine="h5netcdf")
    try:
        var = "CMI" if "CMI" in ds else f"CMI_C{band:02d}"
        da = ds[var]
        x = ds["x"].values.astype(np.float64)
        y = ds["y"].values.astype(np.float64)
        gip = ds["goes_imager_projection"].attrs
        sat_h = float(gip.get("perspective_point_height", GOES_SAT_HEIGHT))
        lon_0 = float(gip.get("longitude_of_projection_origin"))
        sweep = str(gip.get("sweep_angle_axis", "x"))
        # Native-res storm windows (Vis hi-res sectors) — decoded from the SAME
        # in-memory file before the coarsened full-disk read, no second download.
        hires = []
        if hires_windows and coarsen > 1 and getattr(da, "ndim", 0) == 2:
            try:
                hires = _goes_hires_windows(da, x, y, lon_0, sat_h, sweep,
                                            hires_windows)
            except Exception as e:
                log(f"  hires window decode failed ({e}) — sectors stay 2 km")
        # For the coarsened (0.5 km Visible) read, strip-decode so the full
        # native array is never materialized (peak-RAM fix). Byte-identical to
        # the whole-array path. Falls back to the legacy read for IR/WV
        # (coarsen==1), when disabled (MOSAIC_READ_STRIPS=0), or non-2-D vars.
        if windows_only:
            data = None                       # z7 second pass: skip the full-disk decode
        elif coarsen > 1 and _READ_STRIPS >= 1 and getattr(da, "ndim", 0) == 2:
            data = _coarsen_read(da, coarsen, _READ_STRIPS)
            pre_coarsened = True
        else:
            data = np.asarray(da.values, dtype=np.float32)
            pre_coarsened = False
    finally:
        ds.close()
    if windows_only:
        # Decoupled z7 pass: only the native storm windows were decoded (the full
        # disk is never materialized), so these crops can't co-reside with the
        # pass-A full-disk grids — keeps worst-case daytime multi-storm Vis in 4 GiB.
        return None, x, y, lon_0, sat_h, sweep, scan_dt, hires
    if data.size == 0 or x.size == 0 or y.size == 0:
        return None      # empty/partial file (seen on freshly-posting 0.5 km Vis)
    if coarsen > 1:
        if not pre_coarsened:
            data = coarsen2d(data, coarsen)
        # Coarsen the 1-D x/y coordinate axes by block-averaging. (coarsen2d on
        # x[None,:] would collapse the singleton row dim to length 0 → the
        # "index 0 out of bounds for axis 0 with size 0" crash on GOES Visible.)
        nx2 = (x.size // coarsen) * coarsen
        ny2 = (y.size // coarsen) * coarsen
        x = x[:nx2].reshape(-1, coarsen).mean(axis=1)
        y = y[:ny2].reshape(-1, coarsen).mean(axis=1)
    return data, x, y, lon_0, sat_h, sweep, scan_dt, hires


def read_himawari_full_disk(dt, band=IR_BAND, coarsen=1, tol=20, hires_windows=None,
                            windows_only=False):
    """Full-disk Himawari band via the existing HSD reader: a huge box centred on
    the sub-point pulls all 10 segments; the returned geos array + extent give us
    the same (data, x, y, lon_0, sat_h, sweep) shape as the GOES reader.

    hires_windows: lat/lon boxes to ALSO read at native resolution (Vis z7 storm
    sectors) via a second, small open_himawari_subset call per box (target 500 m
    → scale_factor 1). Re-downloads the 1-3 segments the box touches (~30 MB
    compressed each) — acceptable next to the full-disk read, and the returned
    window is only ~tens of MB."""
    prefix, scan_dt = find_himawari_file(dt, tolerance_min=tol, band=band,
                                         return_dt=True)
    if not prefix:
        return None
    if windows_only:
        data = x = y = None          # z7 second pass: skip the full-disk subset read
    else:
        data, extent = open_himawari_subset(prefix, 0.0, HIMAWARI_LON_0,
                                            box_deg=160.0, band=band,
                                            return_extent=True)
        if data is None or extent is None:
            return None
        data = data.astype(np.float32)
        if coarsen > 1:
            data = coarsen2d(data, coarsen)
        ny, nx = data.shape
        x = np.linspace(extent[0], extent[1], nx) / HIMAWARI_SAT_HEIGHT
        y = np.linspace(extent[2], extent[3], ny) / HIMAWARI_SAT_HEIGHT
    hires = []
    for (lat0, lat1, lon0, lon1) in (hires_windows or []):
        clat = 0.5 * (lat0 + lat1); clon = 0.5 * (lon0 + lon1)
        dlon = ((clon - HIMAWARI_LON_0 + 180.0) % 360.0) - 180.0
        cosw = math.cos(math.radians(clat)) * math.cos(math.radians(dlon))
        if cosw < _VIS_HIRES_MIN_COSW:
            continue                      # far off-nadir: ~zero blend weight, skip
        try:
            wdat, wext = open_himawari_subset(prefix, clat, clon,
                                              box_deg=max(lat1 - lat0, lon1 - lon0),
                                              band=band, return_extent=True,
                                              target_res_m=500)
            if wdat is None or wext is None:
                continue
            wdat = wdat.astype(np.float16)   # reflectance: f16 halves peak RAM
            wy, wx = wdat.shape
            hires.append((wdat,
                          np.linspace(wext[0], wext[1], wx) / HIMAWARI_SAT_HEIGHT,
                          np.linspace(wext[2], wext[3], wy) / HIMAWARI_SAT_HEIGHT))
        except Exception as e:
            log(f"  himawari hires window failed ({e}) — sector stays 2 km")
    return (data, x, y, HIMAWARI_LON_0,
            HIMAWARI_SAT_HEIGHT, HIMAWARI_SWEEP, scan_dt, hires)


def read_all_sats(dt, timings, product="ir", hires_windows=None):
    """hires_windows (Vis only): lat/lon boxes around active storms ALSO read at
    NATIVE 0.5-km resolution for the z7 storm-sector tiles — GOES decodes the
    windows from the already-downloaded file, Himawari re-reads the 1-3 segments
    each box touches. The full-disk read (and so the kernel-driven global render)
    is byte-identical to today; the windows ride along as sats[k]['hi'] =
    [(flat, grid), ...] at ~tens of MB per storm, keeping the job in the
    1 vCPU / 4 GiB tier (a full-disk fine read measured ~6 GiB peak)."""
    cfg = PRODUCTS[product]
    want_hi = bool(hires_windows) and cfg["kind"] == "vis" and cfg["coarsen"] > 1
    sats = {}
    for sat_key, kind, bucket, label in SATS:
        band = cfg["hima"] if kind == "himawari" else cfg["goes"]
        # The Himawari HSD reader already subsamples fine bands to 2 km (the IR
        # grid) internally, so it needs NO extra coarsen. GOES is read native, so
        # 0.5 km Visible must be coarsened here.
        coarsen = 1 if kind == "himawari" else cfg["coarsen"]
        # Visible (0.5 km, ~10× larger) posts later than IR/WV; allow an older scan.
        tol = cfg.get("tol", 20)
        hw = hires_windows if want_hi else None
        t0 = time.time()
        try:
            fd = (read_himawari_full_disk(dt, band=band, coarsen=coarsen, tol=tol,
                                          hires_windows=hw)
                  if kind == "himawari"
                  else read_full_disk(bucket, dt, band=band, coarsen=coarsen,
                                      tol=tol, hires_windows=hw))
        except Exception as e:
            log(f"  {label} {product}: read failed ({e}) — skip"); fd = None
        timings["read"] = timings.get("read", 0.0) + time.time() - t0
        if fd is None:
            log(f"  {label} {product}: no file near {dt:%H:%M}Z — skip"); continue
        data, x, y, lon_0, sat_h, sweep, scan_dt, hires = fd
        sats[sat_key] = dict(flat=data.reshape(-1), npix=data.size, x=x, y=y,
                             lon_0=lon_0, sat_h=sat_h, sweep=sweep,
                             grid=grid_of(x, y), label=label, scan_dt=scan_dt,
                             hi=[(w.reshape(-1), grid_of(wx, wy))
                                 for (w, wx, wy) in (hires or [])])
        log(f"  {label} {product}: scan {scan_dt:%H:%M}Z ({data.size/1e6:.0f}M px"
            + (f", {len(sats[sat_key]['hi'])} native window(s)" if sats[sat_key]["hi"] else "")
            + ")")
        # Visible reads pull a few-hundred-MB 0.5 km CMIP file per GOES sat
        # (cat_file BytesIO + h5netcdf/strip decode). _release_memory only fires
        # BETWEEN bands, so across the 2-3 sequential VIS sat reads that transient
        # garbage accumulates in the glibc arena (getrusage-invisible, the same
        # effect the S6 note flags) and tips the cgroup over 4 GiB mid-band on
        # ~11% of runs. Trim per-sat here so each file's transient is returned to
        # the OS before the next sat's read. The kept flat/x/y are live refs, so
        # the trim only reclaims the freed decode buffers. IR/WV (2 km, ~50 MB
        # files) have coarsen==1 and don't need it. See project_mosaic_tile_format.
        if cfg["coarsen"] > 1:
            _release_memory()
    return sats


def read_all_sat_windows(dt, timings, product="vis", hires_windows=None):
    """Decoupled SECOND pass for Vis z7 storm sectors: re-open each sat's file and
    decode ONLY the native storm windows — the full disk is never retained. Run
    AFTER the pass-A full-disk grids (global + z5/z6) are freed, so the two never
    co-reside; this is what lets worst-case daytime multi-storm Vis (both GOES in
    daylight, a storm in each cone) stay inside the 1 vCPU / 4 GiB tier instead of
    OOM'ing on every frame. Cost: GOES re-downloads its 0.5 km CMIP file (NOAA S3
    egress is free) and Himawari re-reads the 1-3 touched segments — both small
    next to a full-disk read. Returns {sat_key: {hi, lon_0, sat_h, sweep, label}},
    the subset render_storm_tiles(..., hi_only=True) needs. See project_mosaic_idx_oom."""
    cfg = PRODUCTS[product]
    if not (hires_windows and cfg["kind"] == "vis" and cfg["coarsen"] > 1):
        return {}
    out = {}
    for sat_key, kind, bucket, label in SATS:
        band = cfg["hima"] if kind == "himawari" else cfg["goes"]
        coarsen = 1 if kind == "himawari" else cfg["coarsen"]
        tol = cfg.get("tol", 20)
        t0 = time.time()
        try:
            fd = (read_himawari_full_disk(dt, band=band, coarsen=coarsen, tol=tol,
                                          hires_windows=hires_windows, windows_only=True)
                  if kind == "himawari"
                  else read_full_disk(bucket, dt, band=band, coarsen=coarsen,
                                      tol=tol, hires_windows=hires_windows,
                                      windows_only=True))
        except Exception as e:
            log(f"  {label} {product} windows: read failed ({e}) — skip"); fd = None
        timings["read"] = timings.get("read", 0.0) + time.time() - t0
        if fd is None:
            continue
        _data, _x, _y, lon_0, sat_h, sweep, _scan_dt, hires = fd
        if hires:
            out[sat_key] = dict(lon_0=lon_0, sat_h=sat_h, sweep=sweep, label=label,
                                hi=[(w.reshape(-1), grid_of(wx, wy))
                                    for (w, wx, wy) in hires])
            log(f"  {label} {product}: {len(out[sat_key]['hi'])} native window(s) (z7 pass)")
        _release_memory()      # return each file's transient before the next sat
    return out


# ── Global kernel (cached): geos→Mercator gather for the whole field ───────
def kernel_path(sat_key, zoom):
    return os.path.join(KERNEL_DIR, f"{sat_key}_z{zoom}.npz")


def _r2_kernel_key(sat_key, zoom):
    return f"{R2_PREFIX}/kernels/{sat_key}_z{zoom}.npz"


def ensure_global_kernels(zoom, sats, rebuild=False, use_r2=False):
    """Resolve each satellite's geos→Mercator kernel: local file → R2 cache →
    build (+ upload to R2). The geometry is fixed, so kernels are built once ever
    and reused every run — this removes the ~30-50 s per-cold-start rebuild AND
    the transient 1 GB LON/LAT build grids (so it also lowers peak memory). The
    LON/LAT grids are now built lazily, only when a kernel actually needs building."""
    os.makedirs(KERNEL_DIR, exist_ok=True)
    kernels = {}
    _g = {}

    def grids():                       # lazy global LON/LAT (only if building)
        if not _g:
            S = TILE_SIZE * (2 ** zoom)
            px = np.arange(S, dtype=np.float64) + 0.5
            lon, lat = pixels_to_lonlat(px[None, :], px[:, None], S)
            _g["LON"] = np.broadcast_to(lon, (S, S))
            _g["LAT"] = np.broadcast_to(lat, (S, S))
        return _g["LON"], _g["LAT"]

    for sat_key, _kind, _b, label in SATS:
        kp = kernel_path(sat_key, zoom)
        # 1. local file (warm container)
        if os.path.exists(kp) and not rebuild:
            d = np.load(kp); kernels[sat_key] = (d["idx"], d["cosz"], d["mask"])
            log(f"  kernel {label} z{zoom}: loaded (local)"); continue
        # 2. R2 cache (cold container)
        if use_r2 and not rebuild:
            try:
                t0 = time.time()
                data = _get_r2().get_object(Bucket=_r2_bucket(),
                                            Key=_r2_kernel_key(sat_key, zoom))["Body"].read()
                with open(kp, "wb") as f:
                    f.write(data)
                d = np.load(kp); kernels[sat_key] = (d["idx"], d["cosz"], d["mask"])
                log(f"  kernel {label} z{zoom}: loaded from R2 "
                    f"({len(data)//1048576} MB in {time.time()-t0:.1f}s)"); continue
            except Exception:
                pass                   # not cached yet → build below
        # 3. build (+ upload to R2)
        if sat_key not in sats:
            continue
        t0 = time.time()
        s = sats[sat_key]
        LON, LAT = grids()
        idx, cosz, mask = project_to_sat(LON, LAT, s["grid"], s["lon_0"],
                                         s["sat_h"], s["sweep"])
        np.savez_compressed(kp, idx=idx, cosz=cosz, mask=mask)
        kernels[sat_key] = (idx, cosz, mask)
        log(f"  kernel {label} z{zoom}: {mask.sum()/1e6:.0f}M px built in "
            f"{time.time()-t0:.1f}s")
        if use_r2:
            try:
                with open(kp, "rb") as f:
                    r2_put(_r2_kernel_key(sat_key, zoom), f.read(),
                           "application/octet-stream", "public, max-age=86400")
                log(f"  kernel {label}: uploaded to R2 cache")
            except Exception as ex:
                log(f"  kernel {label}: R2 upload failed: {ex}")
    return kernels


# Per-pixel Mercator lon/lat for the global field (cached by side length S) —
# used to mask the Visible night side to transparent.
_MERC_LL = {}
def _merc_lonlat(S):
    if S not in _MERC_LL:
        px = np.arange(S, dtype=np.float64) + 0.5
        lon, lat = pixels_to_lonlat(px[None, :], px[:, None], S)
        _MERC_LL[S] = (np.broadcast_to(lon, (S, S)), np.broadcast_to(lat, (S, S)))
    return _MERC_LL[S]


# Number of latitude strips for the global blend. The 8192² blend is per-pixel
# INDEPENDENT (each output pixel reads only the sats at that pixel), so processing
# it in horizontal row-bands caps the transient footprint — the per-sat gathered
# Tb + cosz_stack + num/den, which at full 8192² are ~3 GB — at strip height
# instead of full height. That + a per-strip (uncached) night lon/lat grid drops
# peak memory under 4 GiB so the job runs at 1 vCPU / 4 GiB. The persistent kernel
# arrays (idx/cosz/mask, ~1.7 GB for 3 sats) are the remaining floor. Output is
# byte-identical to a single-strip render; MOSAIC_STRIPS=1 reproduces the old path.
_MOSAIC_STRIPS = max(1, int(os.environ.get("MOSAIC_STRIPS", "8")))


def _merc_lonlat_rows(S, r0, r1):
    """LON/LAT (float64, broadcast) for global-Mercator rows [r0, r1) at size S.
    Computed per-strip (uncached) so the Visible night mask never materializes the
    full 8192² lon/lat grid (~1 GB) that _merc_lonlat would."""
    px = np.arange(S, dtype=np.float64) + 0.5
    py = np.arange(r0, r1, dtype=np.float64) + 0.5
    lon, lat = pixels_to_lonlat(px[None, :], py[:, None], S)
    return (np.broadcast_to(lon, (r1 - r0, S)),
            np.broadcast_to(lat, (r1 - r0, S)))


def global_render(zoom, sats, kernels, timings, product="ir", dt=None):
    S = TILE_SIZE * (2 ** zoom)
    # Resolve the active sats + their (kernel, flat) once; the size-mismatch guard
    # runs on the full kernel before any striping (matches the pre-strip behavior).
    active = []
    for sat_key in sats:
        if sat_key not in kernels:
            continue
        idx, cosz, mask = kernels[sat_key]
        flat = sats[sat_key]["flat"]
        if idx.size and int(idx.max()) >= flat.size:
            log(f"  {sats[sat_key]['label']} {product}: grid {flat.size} ≠ kernel "
                f"(size mismatch — skip)"); continue
        active.append((idx, cosz, mask, flat))

    out = (np.zeros((S, S), np.uint8) if TILE_MODE == "idx"
           else np.zeros((S, S, 4), np.uint8))
    night = PRODUCTS[product]["night"] and dt is not None
    is_vis = PRODUCTS[product]["kind"] == "vis"
    edges = np.linspace(0, S, _MOSAIC_STRIPS + 1).round().astype(int)
    tg = tc = 0.0
    for si in range(_MOSAIC_STRIPS):
        r0, r1 = int(edges[si]), int(edges[si + 1])
        if r1 <= r0:
            continue
        t0 = time.time()
        samples = []
        for (idx, cosz, mask, flat) in active:
            g = flat[idx[r0:r1]]                       # gather this strip's rows only
            # Visible reflectance has no "0 = no-data" sentinel; only gate IR/WV on g>0.
            valid = mask[r0:r1] & np.isfinite(g)
            if not is_vis:
                valid = valid & (g > 0)
            samples.append((g, cosz[r0:r1], valid))    # cosz slice is a view (no copy)
        tg += time.time() - t0
        if not samples:
            continue
        t1 = time.time()
        field = blend_samples(samples)
        img_s = (to_index(field, product) if TILE_MODE == "idx"
                 else colormap(field, product))
        if night:
            LON, LAT = _merc_lonlat_rows(S, r0, r1)
            nightmask = solar_elev_grid(LAT, LON, dt) < _NIGHT_ELEV_DEG
            img_s[nightmask] = 0 if TILE_MODE == "idx" else (0, 0, 0, 0)
        out[r0:r1] = img_s
        tc += time.time() - t1
    timings["gather"] = timings.get("gather", 0.0) + tg
    timings["colormap"] = timings.get("colormap", 0.0) + tc
    return out


# ── Storm tiles: high-zoom z/x/y patches over a list of points ─────────────
def storm_tile_set(points, zooms, box_deg):
    tiles = set()
    for p in points:
        lat, lon = (p["lat"], p["lon"]) if isinstance(p, dict) else p
        for z in zooms:
            n = 2 ** z
            x0 = max(0, lon_to_tilex(lon - box_deg, z))
            x1 = min(n - 1, lon_to_tilex(lon + box_deg, z))
            y0 = max(0, lat_to_tiley(lat + box_deg, z))
            y1 = min(n - 1, lat_to_tiley(lat - box_deg, z))
            for ty in range(y0, y1 + 1):
                for tx in range(x0, x1 + 1):
                    tiles.add((z, tx, ty))
    return tiles


def render_storm_tiles(sats, tiles, emit, timings, product="ir", dt=None,
                       hi_only=False):
    is_vis = PRODUCTS[product]["kind"] == "vis"
    night = PRODUCTS[product]["night"]
    t0 = time.time()
    written = 0
    base_zmax = STORM_ZOOMS[-1]
    for (z, x, y) in sorted(tiles):
        LON, LAT = tile_lonlat(z, x, y)
        samples = []
        for sat_key, s in sats.items():
            # Above the base storm zooms (Vis z7+), sample the NATIVE-resolution
            # storm window instead of the 2-km full disk — the per-tile projection
            # is grid-agnostic, so deeper tiles carry real detail while z5/z6 and
            # the kernel-driven global render are byte-identical to today.
            s_flat, idx = s.get("flat"), None
            if z > base_zmax:
                for (hflat, hgrid) in s.get("hi") or []:
                    hidx, hcosz, hmask = project_to_sat(LON, LAT, hgrid, s["lon_0"],
                                                        s["sat_h"], s["sweep"])
                    if hmask.any():
                        s_flat, idx, cosz, mask = hflat, hidx, hcosz, hmask
                        break
            if idx is None and hi_only:
                # z7 second pass: the full disk was freed before this pass, so
                # there is no 2-km fallback — skip sats with no covering window.
                continue
            if idx is None:
                idx, cosz, mask = project_to_sat(LON, LAT, s["grid"], s["lon_0"],
                                                 s["sat_h"], s["sweep"])
            if not mask.any():
                continue
            g = s_flat[idx]
            valid = mask & np.isfinite(g)
            if not is_vis:
                valid = valid & (g > 0)
            else:
                # Storm tiles: reject far-limb (dim/distorted) Vis reflectance so
                # a frame built before Himawari's Vis posts doesn't freeze a dim
                # GOES-West-limb "jump" frame. See _VIS_STORM_MIN_COSZ.
                valid = valid & (cosz >= _VIS_STORM_MIN_COSZ)
            if valid.any():
                samples.append((g, cosz, valid))
        if not samples:
            continue
        field = blend_samples(samples)
        img = to_index(field, product) if TILE_MODE == "idx" else colormap(field, product)
        if night and dt is not None:
            nightmask = solar_elev_grid(LAT, LON, dt) < _NIGHT_ELEV_DEG
            img[nightmask] = 0 if TILE_MODE == "idx" else (0, 0, 0, 0)
        empty = (not img.any()) if TILE_MODE == "idx" else (not img[..., 3].any())
        if empty:
            continue
        emit(z, x, y, _png_bytes(img)); written += 1
    timings["storm_tile"] = time.time() - t0
    return written


# ── Storm IR diagnostics: objective eye-fix + warm-eye / cold-top Tb ───────
# For storms >= this intensity, run the shared gated center-finder on the raw IR
# already in memory and record: the objective eye position (so the frontend can
# snap the track pin onto the real eye instead of the lagging best-track fix),
# the warmest Tb within 50 km of that center (= subsident eye temperature, the
# "Max (TC Center)" CyclonicWx shows), and the coldest Tb in the crop (cloud-top
# minimum). Shipped as a tiny rolling sidecar. ~20-100 ms per storm; no extra S3.
_EYE_DIAG_MIN_VMAX = 65          # kt — hurricane strength (a clear eye to find)
_EYE_DIAG_HALF_DEG = 1.9         # crop half-width: covers 150 km search + 50 km ring
_EYE_DIAG_RES_DEG = 0.02         # ~2.2 km ≈ IR native
_EYE_RING_KM = 50.0              # warm-eye search radius around the center


def _haversine_km(lat, lon, lat0, lon0):
    R = 6371.0
    p1 = np.radians(lat); p2 = np.radians(lat0)
    dphi = np.radians(lat0 - lat); dlam = np.radians(lon0 - lon)
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlam / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def _dead_reckon(storm, target_dt):
    """Dead-reckon the storm's last fix forward to target_dt using its motion.
    Unlike the frontend display pin (capped at 9 h), this is UNcapped: it only
    needs to seed the center-finder within its search radius of the true eye —
    a raw 6-hourly fix can be >150 km stale for a moving storm, which would put
    the eye outside the search. The finder then refines to the actual eye."""
    lat0 = float(storm["lat"]); lon0 = float(storm["lon"])
    mk = storm.get("motion_kt"); md = storm.get("motion_deg")
    lf = storm.get("last_fix_utc")
    if mk is None or md is None or not lf:
        return lat0, lon0
    try:
        fix_dt = datetime.fromisoformat(str(lf).replace("Z", "+00:00"))
    except Exception:
        return lat0, lon0
    age_h = (target_dt - fix_dt).total_seconds() / 3600.0
    if age_h <= 0.0 or age_h > 24.0:      # sanity clamp only
        return lat0, lon0
    dist_km = float(mk) * age_h * 1.852
    brg = math.radians(float(md))
    d = dist_km / 6371.0
    p1 = math.radians(lat0); l1 = math.radians(lon0)
    p2 = math.asin(math.sin(p1) * math.cos(d) +
                   math.cos(p1) * math.sin(d) * math.cos(brg))
    l2 = l1 + math.atan2(math.sin(brg) * math.sin(d) * math.cos(p1),
                         math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def _reproject_tb_crop(sats, clat, clon, half):
    """Reproject a storm-centered equirect Tb crop (K) from in-memory sats — no
    extra S3 read. Returns (tb, LAT, LON) with row 0 = north, or (None,None,None).
    Band-agnostic: the sats' `flat` is whatever band was read (IR or WV Tb)."""
    n = int(round(2 * half / _EYE_DIAG_RES_DEG)) + 1
    lats = np.linspace(clat + half, clat - half, n)   # row 0 = NORTH (finder convention)
    lons = np.linspace(clon - half, clon + half, n)
    LON, LAT = np.meshgrid(lons, lats)
    samples = []
    for s in sats.values():
        idx, cosz, mask = project_to_sat(LON, LAT, s["grid"], s["lon_0"],
                                         s["sat_h"], s["sweep"])
        g = s["flat"][idx]
        valid = mask & np.isfinite(g) & (g > 0)
        if bool(valid.any()):
            samples.append((g, cosz, valid))
    if not samples:
        return None, None, None
    tb = blend_samples(samples)   # K, NaN where no data
    if not bool(np.isfinite(tb).any()):
        return None, None, None
    return tb, LAT, LON


def _eye_min_c(tb, LAT, LON, clat, clon):
    """(warmest Tb within 50 km of center = eye, coldest Tb in crop), in °C."""
    ring = np.isfinite(tb) & (_haversine_km(LAT, LON, clat, clon) <= _EYE_RING_KM)
    eye_c = (float(np.nanmax(np.where(ring, tb, np.nan))) - 273.15) if bool(ring.any()) else None
    min_c = float(np.nanmin(tb)) - 273.15
    return eye_c, min_c


def band_eye_min_at_center(sats, clat, clon):
    """Warm-eye + cold-top Tb for a band's sats at a KNOWN center (used for WV,
    reusing the IR-derived eye position — the eye is best located in IR). °C,
    rounded; (None,None) if no data."""
    if not sats:
        return None, None
    tb, LAT, LON = _reproject_tb_crop(sats, clat, clon, _EYE_DIAG_HALF_DEG)
    if tb is None:
        return None, None
    eye_c, min_c = _eye_min_c(tb, LAT, LON, clat, clon)
    return (round(eye_c, 1) if eye_c is not None else None,
            round(min_c, 1) if min_c is not None else None)


def storm_ir_diagnostic(sats, storm, target_dt):
    """Objective IR center fix (gated) + warm-eye / cold-top Tb for one storm.

    Reprojects a small storm-centered IR crop from the already-in-memory `sats`
    (no extra read), runs tc_center_fix.apply_center_gates (the same g1/g2/g3
    finder the Detailed view uses), then measures the max Tb within 50 km of the
    fix — or of the best-track position when the gates don't pass — as the eye
    temperature, plus the crop's coldest Tb. Returns a dict, or None if there's
    no usable IR over the storm."""
    if not sats:
        return None
    # Seed the crop + finder with a dead-reckoned position (raw fix can be
    # >150 km stale) so the search reliably reaches the true eye.
    lat0, lon0 = _dead_reckon(storm, target_dt)
    half = _EYE_DIAG_HALF_DEG
    tb, LAT, LON = _reproject_tb_crop(sats, lat0, lon0, half)
    if tb is None:
        return None
    bounds = [[lat0 - half, lon0 - half], [lat0 + half, lon0 + half]]
    fix_lat, fix_lon, fix_ok = lat0, lon0, False
    try:
        gated = apply_center_gates(tb, bounds, lat0, lon0, ref_lat=lat0, ref_lon=lon0)
        cf = gated.get("center_fix") if gated.get("passed") else None
        if cf and cf.get("lat") is not None:
            fix_lat, fix_lon, fix_ok = float(cf["lat"]), float(cf["lon"]), True
    except Exception as e:
        log(f"  eye diag: center-fix error {storm.get('atcf_id')}: {e}")
    eye_c, min_c = _eye_min_c(tb, LAT, LON, fix_lat, fix_lon)
    return {
        "atcf_id": storm.get("atcf_id"),
        "name": storm.get("name"),
        "lat": round(fix_lat, 3), "lon": round(fix_lon, 3),
        "fix": fix_ok,
        "eye_c": round(eye_c, 1) if eye_c is not None else None,
        "min_c": round(min_c, 1) if min_c is not None else None,
        "vmax": storm.get("vmax_kt"),
        "mslp": storm.get("mslp_hpa"),
    }


def _eye_window_floor(ts):
    """Oldest timestamp to retain in the rolling eye-fix sidecar (frame window
    + a little slack), as a comparable 'YYYYMMDDHHMM' string."""
    t = datetime.strptime(ts, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return (t - timedelta(minutes=R2_KEEP_FRAMES * 10 + 20)).strftime("%Y%m%d%H%M")


def update_r2_eye_fixes(ts, diags):
    """Roll the storm eye-fix / Tb-diagnostic sidecar (mosaic-v3/eye_fixes.json):
    per storm, per timestamp, trimmed to the frame window; dissipated storms drop
    out once their newest frame rolls off. Tiny (<1 KB)."""
    key = f"{R2_PREFIX}/eye_fixes.json"
    c = _get_r2()
    cur = {}
    try:
        cur = json.loads(c.get_object(Bucket=_r2_bucket(), Key=key)["Body"].read())
    except Exception:
        pass
    storms = cur.get("storms", {}) or {}
    for d in diags:
        aid = d.get("atcf_id")
        if not aid:
            continue
        st = storms.setdefault(aid, {"name": d.get("name"), "frames": {}})
        if d.get("name"):
            st["name"] = d["name"]
        st["frames"][ts] = {k: d.get(k) for k in
                            ("lat", "lon", "fix", "eye_c", "min_c", "vmax", "mslp",
                             "wv_eye_c", "wv_min_c")}
    floor = _eye_window_floor(ts)
    pruned = {}
    for aid, st in storms.items():
        frames = st.get("frames", {}) or {}
        keep = sorted(frames.keys())[-R2_KEEP_FRAMES:]
        frames = {t: frames[t] for t in keep}
        if frames and max(frames.keys()) >= floor:
            st["frames"] = frames
            pruned[aid] = st
    body = json.dumps({"storms": pruned, "updated": ts}).encode()
    r2_put(key, body, "application/json", MANIFEST_CACHE)
    return pruned


# ── tile sinks: local directory or concurrent R2 upload ───────────────────
def local_sink(out_dir):
    def emit(z, x, y, body):
        d = os.path.join(out_dir, str(z), str(x))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{y}.png"), "wb") as f:
            f.write(body)
    return emit


def r2_sink(ts, pool, futures, product="ir"):
    base = f"{R2_PREFIX}/{product}/{ts}"
    def emit(z, x, y, body):
        key = f"{base}/{z}/{x}/{y}.png"
        futures.append(pool.submit(r2_put, key, body, "image/png", TILE_CACHE))
    return emit


def _r2_delete_prefix(prefix):
    """Delete every object under `prefix` (paginated, 1000-key delete batches)."""
    c = _get_r2(); bucket = _r2_bucket(); n = 0; token = None
    while True:
        kw = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
        if token:
            kw["ContinuationToken"] = token
        resp = c.list_objects_v2(**kw)
        objs = resp.get("Contents", [])
        if objs:
            c.delete_objects(Bucket=bucket,
                             Delete={"Objects": [{"Key": o["Key"]} for o in objs]})
            n += len(objs)
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    return n


def _prune_old_frames(kept, product="ir"):
    """Delete tiles for any <product>/<ts>/ frame not in `kept`. The manifest rolls
    to the last R2_KEEP_FRAMES, but the dropped frames' tile OBJECTS were never
    deleted, so R2 grew unbounded (~1 GB/day). This self-heals: it lists the
    timestamp prefixes under <product>/ (cheap — Delimiter gives CommonPrefixes, not
    every tile) and purges any not in the kept window. frames.json is a key (not a
    prefix) so it's never touched."""
    c = _get_r2(); bucket = _r2_bucket(); base = f"{R2_PREFIX}/{product}/"
    keptset = set(kept); token = None; pf = 0; pt = 0
    while True:
        kw = {"Bucket": bucket, "Prefix": base, "Delimiter": "/", "MaxKeys": 1000}
        if token:
            kw["ContinuationToken"] = token
        resp = c.list_objects_v2(**kw)
        for cp in resp.get("CommonPrefixes", []):
            p = cp["Prefix"]; ts = p[len(base):].strip("/")
            if ts and ts not in keptset:
                pt += _r2_delete_prefix(p); pf += 1
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    if pf:
        log(f"  pruned {pf} old frame(s), {pt} tiles")


def build_pack_bytes(entries):
    """entries: [(z, x, y, png_bytes), ...] → (pack_bytes, index_json_bytes,
    pack_name). The pack is the tiles' PNG bytes concatenated in sorted (z,x,y)
    order; index.json maps "z/x/y" → [offset, length] for client Range reads. A
    tile absent from the index is definitively absent from the frame (the client
    skips the request entirely — no 404 round-trips).

    The pack object is CONTENT-HASH named (pack-<sha1[:10]>.bin, referenced by
    index.json "pack") so a re-render of the same frame — a Cloud Run task retry
    produces slightly different bytes — writes a NEW object instead of
    overwriting. With overwrite + the 7-day immutable edge cache, Cloudflare
    pinned a stale pack.bin against a fresh index.json and every offset shifted
    (live storm cards lost their sector tiles, 2026-07-21 00Z)."""
    import hashlib
    entries = sorted(entries, key=lambda e: (e[0], e[1], e[2]))
    parts, index, off = [], {}, 0
    for z, x, y, body in entries:
        index[f"{z}/{x}/{y}"] = [off, len(body)]
        parts.append(body)
        off += len(body)
    pk = b"".join(parts)
    name = f"pack-{hashlib.sha1(pk).hexdigest()[:10]}.bin"
    ix = json.dumps({"pack": name, "tiles": index, "size": off, "count": len(parts)},
                    separators=(",", ":")).encode()
    return pk, ix, name


def update_r2_manifest(new_ts, zmax, product="ir", is_gap=False,
                       pack=False, storm_zmax=None):
    """Append new_ts to <prefix>/<product>/frames.json, trim to the rolling window,
    and prune the tiles of any frame that fell out of the window (keeps R2 bounded).

    `is_gap` = this frame HAD active storms to cover but wrote NO z5/z6 storm tile
    (Visible night-mask or Band-2 scan gap). Persisted (rolling, like ir_trange) as
    `gap_frames` — a DENY-list the storm-card LITE loop excludes. The frame still
    belongs in `frames` (the global map wants it); it just can't anchor the storm
    loop, else the lite camera sits over a frame with no crisp tiles → overzooms to
    the blurry global parent = the "jumping to a random section" bug.

    DENY-list, not allow-list, on purpose: the job renders ONE frame per run, so an
    allow-list of covered frames would wrongly exclude every older frame rendered
    before this shipped until the window refills (~3 h) — collapsing the loop. A
    deny-list only grows with newly-observed gaps; unknown/old frames default to
    shown. IR never gaps so its gap_frames stays empty. See project_vis_loop_bounce."""
    c = _get_r2(); key = f"{R2_PREFIX}/{product}/frames.json"
    frames = []; ir_trange = {}; gap_frames = []; pack_frames = []; szm = {}
    try:
        cur = json.loads(c.get_object(Bucket=_r2_bucket(), Key=key)["Body"].read())
        frames = cur.get("frames", [])
        ir_trange = cur.get("ir_trange", {}) or {}
        gap_frames = cur.get("gap_frames", []) or []
        pack_frames = cur.get("pack_frames", []) or []
        szm = cur.get("storm_zmax", {}) or {}
    except Exception:
        pass
    if new_ts not in frames:
        frames.append(new_ts)
    frames = sorted(set(frames))[-R2_KEEP_FRAMES:]
    if is_gap and new_ts not in gap_frames:
        gap_frames.append(new_ts)
    # Keep only in-window entries (rolled-off frames drop out).
    gap_frames = [t for t in sorted(set(gap_frames)) if t in frames]
    # Per-frame flags, rolled like ir_trange: `pack_frames` = frames whose tiles
    # live in a single pack.bin (+index.json) the client range-reads; `storm_zmax`
    # = deepest storm-sector zoom THIS frame actually baked (frontend gates z7 per
    # frame so a mixed rollover window never requests tiles that don't exist).
    if pack and new_ts not in pack_frames:
        pack_frames.append(new_ts)
    pack_frames = [t for t in sorted(set(pack_frames)) if t in frames]
    if storm_zmax:
        szm[new_ts] = int(storm_zmax)
    manifest = {"frames": frames, "zmax": zmax, "storm_zooms": list(STORM_ZOOMS),
                "gap_frames": gap_frames, "pack_frames": pack_frames,
                "storm_zmax": {t: v for t, v in szm.items() if t in frames}}
    # Per-frame idx→Tb decode range (IR only). Stamp THIS frame with the current
    # encoding range; leave pre-existing frames' entries as-is (a mixed rollover
    # window stays correct) and drop entries for frames that fell out of the window.
    # Frames with no entry decode with the client's legacy [190,310] fallback.
    if PRODUCTS[product]["kind"] == "ir":
        ir_trange[new_ts] = [IR_IDX_VMIN, IR_IDX_VMAX]
        manifest["ir_trange"] = {t: r for t, r in ir_trange.items() if t in frames}
    body = json.dumps(manifest).encode()
    r2_put(key, body, "application/json", MANIFEST_CACHE)
    try:
        _prune_old_frames(frames, product)
    except Exception as e:
        log(f"  prune skipped: {e}")
    return frames


# ── Pyramid: slice the global raster into z/x/y (skip empty) ───────────────
def _png_bytes(tile):
    from PIL import Image
    buf = io.BytesIO()
    if tile.ndim == 2:   # single-channel brightness-index (idx mode); 0 = no-data
        # L6 measured −64% egress vs the RGBA-L1 baseline for ~+1 s/frame (spike,
        # 2026-06-26); WebP-lossless was only 4pp smaller for ~5× the encode time.
        Image.fromarray(tile, "L").save(buf, format="PNG", compress_level=IDX_PNG_LEVEL)
        return buf.getvalue()
    # compress_level=1 (was 6): IR tiles are noisy/photographic, so zlib effort
    # barely shrinks them — measured on real z2-z4 tiles, level 1 vs 6 is the SAME
    # size (±3%) but ~3.9× faster to encode. The tile step is the run's CPU hotspot,
    # and encode is single-threaded in write_pyramid, so this directly cuts vCPU-s.
    Image.fromarray(tile, "RGBA").save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def write_pyramid(img, zmax, emit, timings):
    """emit(z, x, y, png_bytes) routes each tile to a sink (local dir or R2).
    RGBA mode: empty = no opaque pixel; box-average down (alpha fades edges).
    idx mode (2D): empty = all no-data (0); MASKED box-average so the 0 sentinel
    never bleeds into a valid mean — a parent pixel is the mean of its non-zero
    children (or 0 if all four are no-data). Edges stay crisp instead of fading,
    and averaging the INDEX (≈ mean Tb) then colormapping on the client is more
    physical than averaging baked colours."""
    t0 = time.time()
    idx_mode = (img.ndim == 2)
    level = img
    n = 0
    for z in range(zmax, -1, -1):
        S = level.shape[0]
        for ty in range(S // TILE_SIZE):
            for tx in range(S // TILE_SIZE):
                tile = level[ty*TILE_SIZE:(ty+1)*TILE_SIZE,
                             tx*TILE_SIZE:(tx+1)*TILE_SIZE]
                empty = (not tile.any()) if idx_mode else (not tile[..., 3].any())
                if empty:
                    continue
                emit(z, tx, ty, _png_bytes(tile)); n += 1
        if z > 0:
            h = (S // 2) * 2
            if idx_mode:
                a = level[:h:2, :h:2]; b = level[1:h:2, :h:2]
                c = level[:h:2, 1:h:2]; d = level[1:h:2, 1:h:2]
                va = a != 0; vb = b != 0; vc = c != 0; vd = d != 0
                cnt = va.astype(np.uint16) + vb + vc + vd
                ssum = (a * va).astype(np.uint16) + b * vb + c * vc + d * vd
                level = np.where(cnt > 0, ssum // np.maximum(cnt, 1), 0).astype(np.uint8)
            else:
                level = ((level[:h:2, :h:2].astype(np.uint16) + level[1:h:2, :h:2] +
                          level[:h:2, 1:h:2] + level[1:h:2, 1:h:2]) // 4).astype(np.uint8)
    timings["tile"] = time.time() - t0
    return n


def write_preview(rgba, out_dir, width=1536):
    from PIL import Image
    img = Image.fromarray(rgba, "RGBA"); img.thumbnail((width, width))
    bg = Image.new("RGBA", img.size, (15, 23, 42, 255)); bg.alpha_composite(img)
    p = os.path.join(out_dir, "preview.png"); bg.convert("RGB").save(p)
    return p


def fetch_active_points():
    """Active storms within GOES-E/W + Himawari coverage → [(lat,lon),…].
    The API sits behind Cloudflare and 403s a bare urllib UA, so send a
    browser-ish User-Agent + Origin (production would call the origin URL)."""
    req = urllib.request.Request(
        API_BASE + "/ir-monitor/active-storms",
        headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) "
                               "Chrome/126 Safari/537.36",
                 "Origin": "https://tcatlas.org",
                 "Referer": "https://tcatlas.org/"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            storms = (json.load(r) or {}).get("storms", [])
    except Exception as e:
        log(f"  active-storms fetch failed: {e}"); return []
    pts = []
    for s in storms:
        lon = s.get("lon"); lat = s.get("lat")
        if lat is None or lon is None:
            continue
        lonn = ((lon + 180) % 360) - 180
        # covered = GOES-E/W (≤ -5°) or Himawari (≥ 75°); the -5..75 gap is
        # the Meteosat coverage we don't ingest yet.
        if lonn <= -5 or lonn >= 75:
            pts.append({"lat": lat, "lon": lonn, "atcf_id": s.get("atcf_id"),
                        "name": s.get("name"), "vmax_kt": s.get("vmax_kt"),
                        "mslp_hpa": s.get("mslp_hpa"),
                        "motion_kt": s.get("motion_kt"),
                        "motion_deg": s.get("motion_deg"),
                        "last_fix_utc": s.get("last_fix_utc")})
            log(f"  storm {s.get('name','?')} @ {lat:.1f},{lonn:.1f}")
        else:
            log(f"  storm {s.get('name','?')} @ {lonn:.1f}° in Meteosat gap — skip")
    return pts


def main():
    global BLEND_P
    ap = argparse.ArgumentParser()
    ap.add_argument("--zmax", type=int, default=4)   # 512px tiles → native S=8192 at z4
    ap.add_argument("--build-kernel", action="store_true")
    ap.add_argument("--storm", action="store_true",
                    help="also bake storm-sector tiles (z5–z6; Vis to z7) over active storms")
    ap.add_argument("--storm-at", default=None,
                    help="also bake a storm patch at 'lat,lon' (test point)")
    ap.add_argument("--blend-p", type=float, default=None,
                    help="override cutline sharpness (default %d)" % BLEND_P)
    ap.add_argument("--frames", type=int, default=1,
                    help="number of consecutive 10-min frames (for animation)")
    ap.add_argument("--bands", default="ir",
                    help="comma-separated products to build: ir,wv,vis "
                         "(each → mosaic-v2/<product>/...)")
    ap.add_argument("--r2", action="store_true",
                    help="upload tiles to R2 (mosaic-v1/) + roll the manifest "
                         "(production Cloud Run Job mode)")
    ap.add_argument("--time", action="store_true")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args()
    if args.blend_p:
        BLEND_P = args.blend_p

    now = datetime.now(timezone.utc) - timedelta(minutes=20)
    latest = now.replace(minute=now.minute - (now.minute % 10), second=0, microsecond=0)

    # storm points (resolved once, reused for every frame)
    points = []
    if args.storm:
        points += fetch_active_points()
    if args.storm_at:
        la, lo = (float(v) for v in args.storm_at.split(","))
        points.append({"lat": la, "lon": lo, "atcf_id": None, "name": None,
                       "vmax_kt": None, "mslp_hpa": None})
        log(f"test point @ {la},{lo}")

    products = [p.strip() for p in args.bands.split(",") if p.strip() in PRODUCTS]
    if not products:
        products = ["ir"]

    # render newest→oldest so the first frame seeds/loads the kernels
    frame_dts = [latest - timedelta(minutes=10 * i) for i in range(args.frames)]
    written, written_gap, kernels = {}, {}, None
    written_pack, written_zmax = {}, {}   # per-product: packed frames / storm zmax
    t0 = time.time()
    for fi, dt in enumerate(frame_dts):
        log(f"── frame {fi+1}/{args.frames}: {dt:%Y-%m-%d %H:%M}Z "
            f"(zmax {args.zmax}, blend_p {BLEND_P:g}, bands {','.join(products)})")
        ts = dt.strftime("%Y%m%d%H%M")
        frame_diags = []   # eye-fix / Tb diagnostics for storms >=65 kt (IR pass)
        # Each product reads its own band, renders, tiles, uploads to its prefix.
        # The reproject kernels are shared (IR grid) across all bands. Sats are read
        # + freed per product so peak memory stays ~one band at a time.
        for product in products:
            timings = {}
            # Storm zooms are per-product now (Vis bakes z7 from native windows).
            zooms = storm_zooms_for(product)
            tiles = storm_tile_set(points, zooms, STORM_BOX_DEG) if points else set()
            hw = None
            if tiles and PRODUCTS[product]["kind"] == "vis" and max(zooms) > STORM_ZOOMS[-1]:
                # Native-res read windows: storm box + the deepest tiles' snap-out
                # margin (tiles are chosen by overlap, so their edges extend up to
                # one z(base+1) tile width past the box) + a half-degree pad.
                W = STORM_BOX_DEG + 360.0 / (1 << (STORM_ZOOMS[-1] + 1)) + 0.5
                hw = []
                for p in points:
                    la, lo = (p["lat"], p["lon"]) if isinstance(p, dict) else p
                    hw.append((la - W, la + W, lo - W, lo + W))
            # Pass A reads full disks ONLY (no native windows). Vis z7 windows are
            # read in a decoupled second pass below, after these grids are freed, so
            # the two never co-reside — the fix for the daytime multi-storm 4 GiB OOM.
            sats = read_all_sats(dt, timings, product, hires_windows=None)
            if not sats:
                log(f"  {product}: no satellite data — skip"); continue
            if kernels is None:
                kernels = ensure_global_kernels(args.zmax, sats,
                                                rebuild=args.build_kernel,
                                                use_r2=args.r2)
                if args.build_kernel:
                    log("kernels ready (one-time cost) — done"); return

            pool, futures = None, []
            # Pack collection: in dual/only modes every emitted tile is ALSO kept
            # in memory (~5-20 MB/product-frame) and shipped as one pack.bin +
            # index.json after the tile step. "only" skips the per-tile PUTs.
            pack = [] if PACK_MODE in ("dual", "only") else None
            if args.r2:
                pool = _cf.ThreadPoolExecutor(max_workers=16)
                inner = r2_sink(ts, pool, futures, product) if PACK_MODE != "only" else None
            else:
                inner = (local_sink(os.path.join(args.out, product, ts))
                         if PACK_MODE != "only" else None)
            if pack is not None:
                def emit(z, x, y, body, _p=pack, _e=inner):
                    _p.append((z, x, y, body))
                    if _e:
                        _e(z, x, y, body)
            else:
                emit = inner

            rgba = global_render(args.zmax, sats, kernels, timings, product, dt)
            n_global = write_pyramid(rgba, args.zmax, emit, timings)
            n_storm = 0
            if tiles:
                tiles_lo = {t for t in tiles if t[0] <= STORM_ZOOMS[-1]}
                tiles_hi = {t for t in tiles if t[0] > STORM_ZOOMS[-1]}
                # z5/z6 storm sectors from the 2-km full disk (byte-identical to before).
                n_storm = render_storm_tiles(sats, tiles_lo, emit, timings, product, dt)
                if tiles_hi and hw:
                    # Vis z7 native sectors, DECOUPLED second pass: free the full-disk
                    # grids first so the native windows never co-reside with them (the
                    # OOM), then re-read only the windows. See project_mosaic_idx_oom.
                    for _s in sats.values():
                        _s.pop("flat", None); _s.pop("grid", None); _s.pop("npix", None)
                    _release_memory()
                    win = read_all_sat_windows(dt, timings, product, hw)
                    if win:
                        n_storm += render_storm_tiles(win, tiles_hi, emit, timings,
                                                      product, dt, hi_only=True)
                    del win
                    _release_memory()
            # Objective eye-fix + warm-eye/cold-top Tb, from the IR sats already
            # in memory (no extra read). IR pass only; storms >= 65 kt only.
            if product == "ir":
                for sm in points:
                    if not isinstance(sm, dict) or not sm.get("atcf_id"):
                        continue
                    v = sm.get("vmax_kt")
                    if v is None or v < _EYE_DIAG_MIN_VMAX:
                        continue
                    dg = storm_ir_diagnostic(sats, sm, dt)
                    if dg:
                        frame_diags.append(dg)
            elif product == "wv" and frame_diags:
                # WV Tb at the IR-derived eye center, so the header readout shows
                # band-relevant values when the user views Water Vapor (WV Tb runs
                # much colder than IR for the same scene).
                for dg in frame_diags:
                    we, wm = band_eye_min_at_center(sats, dg["lat"], dg["lon"])
                    dg["wv_eye_c"] = we
                    dg["wv_min_c"] = wm
            if fi == 0 and product == products[0] and TILE_MODE != "idx":
                write_preview(rgba, args.out)
            written.setdefault(product, []).append(ts)
            if tiles and n_storm == 0:
                written_gap.setdefault(product, []).append(ts)
            del rgba, sats   # free the big per-band arrays before the next band
            _release_memory()  # return the freed arena to the OS between bands

            # Deepest storm zoom this frame actually baked (None when no storm
            # tiles — the frontend then defaults to the base z6 sectors).
            frame_szm = max(zooms) if n_storm else None
            if frame_szm:
                written_zmax.setdefault(product, {})[ts] = frame_szm
            if args.r2:
                t1 = time.time(); ok = errs = 0
                for f in _cf.as_completed(futures):
                    try: f.result(); ok += 1
                    except Exception as ex: errs += 1; log(f"  R2 put failed: {ex}")
                pool.shutdown()
                pack_ok = False
                if pack is not None:
                    try:
                        pk, ix, pk_name = build_pack_bytes(pack)
                        base = f"{R2_PREFIX}/{product}/{ts}"
                        # pack FIRST, then the index that references it — a
                        # client can never see an index pointing at a missing pack.
                        r2_put(f"{base}/{pk_name}", pk,
                               "application/octet-stream", TILE_CACHE)
                        r2_put(f"{base}/index.json", ix,
                               "application/json", TILE_CACHE)
                        pack_ok = True
                        log(f"  {product} pack: {len(pack)} tiles, {len(pk)/1e6:.1f} MB → {pk_name}")
                    except Exception as ex:
                        # dual: clients fall back to the per-tile objects. only:
                        # the frame is unusable — do NOT stamp pack_frames (and
                        # there are no tiles), so it reads as a missing frame.
                        log(f"  {product} pack upload failed: {ex}")
                # A gap only counts when there WERE storms to cover (tiles
                # non-empty) but none rendered — not a no-storm quiet cycle.
                frames = update_r2_manifest(ts, args.zmax, product,
                                            is_gap=(bool(tiles) and n_storm == 0),
                                            pack=pack_ok, storm_zmax=frame_szm)
                timings["upload"] = time.time() - t1
                log(f"  {product} R2: {ok} up ({errs} failed); manifest {len(frames)} frames")
                if pack_ok:
                    written_pack.setdefault(product, []).append(ts)
            elif pack is not None:
                # Local mode: write the pack next to (or instead of) the tile dir
                # so the dev server / fixtures exercise the exact client path.
                pk, ix, pk_name = build_pack_bytes(pack)
                d = os.path.join(args.out, product, ts)
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, pk_name), "wb") as f:
                    f.write(pk)
                with open(os.path.join(d, "index.json"), "wb") as f:
                    f.write(ix)
                written_pack.setdefault(product, []).append(ts)
                log(f"  {product} pack: {len(pack)} tiles, {len(pk)/1e6:.1f} MB (local)")
            log(f"  {product}: {n_global} global + {n_storm} storm tiles → {ts}")
            if args.time:
                parts = " ".join(f"{k} {timings[k]:.1f}s" for k in
                                 ("read", "gather", "colormap", "tile", "storm_tile", "upload")
                                 if k in timings)
                log(f"    timings: {parts}")

        # Ship the per-frame eye-fix / Tb-diagnostic sidecar (R2 mode).
        if frame_diags and args.r2:
            try:
                st = update_r2_eye_fixes(ts, frame_diags)
                log(f"  eye_fixes: {len(frame_diags)} storm(s) this frame, "
                    f"{len(st)} in window → {ts}")
            except Exception as e:
                log(f"  eye_fixes write failed: {e}")

    # local animation manifests per product (R2 mode rolls its own per-frame above)
    if written and not args.r2:
        for product, ts_list in written.items():
            man = os.path.join(args.out, product, "frames.json")
            _gapframes = sorted(set(written_gap.get(product, [])) & set(ts_list))
            with open(man, "w") as f:
                json.dump({"frames": sorted(ts_list), "zmax": args.zmax,
                           "storm_zooms": list(STORM_ZOOMS),
                           "gap_frames": _gapframes,
                           "pack_frames": sorted(set(written_pack.get(product, [])) & set(ts_list)),
                           "storm_zmax": {t: v for t, v in written_zmax.get(product, {}).items()
                                          if t in ts_list}}, f)
            log(f"manifest {product} ({len(ts_list)} frames, "
                f"{len(_gapframes)} gap) → {man}")
    nfr = sum(len(v) for v in written.values())
    log(f"TOTAL {time.time()-t0:.1f}s for {nfr} product-frame(s)")
    # Peak RSS across the whole process (max over all frames — per-frame arrays are
    # freed between frames). Drives the strip-count / memory-limit sizing (S6).
    try:
        import resource
        log(f"PEAK RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MiB "
            f"(MOSAIC_STRIPS={_MOSAIC_STRIPS})")
    except Exception:
        pass


if __name__ == "__main__":
    main()
