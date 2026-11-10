"""ir_analog_core.py — shared core of the IR Analog Finder.

Design: PLAN_ir_analog_finder.md. This module is everything that does NOT
need a neural network or the network: cutting a storm-centred chip from an
archive IR frame, the polar descriptor (method A in the plan), the scaling
that turns descriptors into search vectors, and exact nearest-neighbour
search with the one-match-per-storm rule. The chip builder, the index
builder and the live step all import it, so a chip or a distance means the
same thing everywhere (the way favorability.py is shared between the API and
the climatology builder).

Dependencies: numpy only (Pillow, lazily, for the 8 km context WebP).
Nothing here imports global_archive_api: its import-time Earthdata setup
rewrites ~/.netrc. The two pieces of its logic this module must match
exactly, the frame list and the scene QC, are vendored and held to the
original by tests/test_ir_analog_core.py.

Conventions
  chip      float32 [CHIP_PX, CHIP_PX] brightness temperature in K, NaN =
            missing. Row 0 is the north edge, column 0 the west edge, on an
            azimuthal-equidistant grid about the storm centre, so a pixel's
            distance from the chip centre is its true distance from the
            storm. Southern Hemisphere chips are mirrored north-south
            (flipped=True) so cyclonic rotation is counter-clockwise in
            every chip.
  azimuth   math convention on the chip: counter-clockwise from east.
  raw       float32 [RAW_DIM] descriptor of one chip (layout below).
"""
from __future__ import annotations

import base64
from datetime import datetime

import numpy as np

SPEC_VERSION = 1

# ── Chip spec ────────────────────────────────────────────────────────────
CHIP_PX = 224            # the ViT's native input; also what method A reads
CHIP_KM = 4.0            # MergIR's nominal pixel
EARTH_R_KM = 6371.0

# Archive Tb encoding (global_archive_api._encode_tb_uint8): 0 = missing,
# 1..255 = 170..310 K linear.
TB_VMIN = 170.0
TB_VMAX = 310.0
TB_SCALE = 254.0 / (TB_VMAX - TB_VMIN)

# ── Polar descriptor spec ────────────────────────────────────────────────
RING_DR_KM = 16.0
RING_RMAX_KM = 400.0
N_RINGS = int(RING_RMAX_KM / RING_DR_KM)          # 25
N_WAVE = 3                                         # azimuthal wavenumbers 1..3
RING_MIN_VALID = 0.8                               # finite fraction a ring needs
HIST_EDGES_K = np.array([193, 203, 213, 223, 233, 243, 253, 263, 273, 283, 293], dtype=np.float32)
N_HIST = len(HIST_EDGES_K) + 1                     # 12

# raw layout: [mean | spread | Re a1 | Im a1 | Re a2 | Im a2 | Re a3 | Im a3 | hist]
_S_MEAN = slice(0, N_RINGS)
_S_STD = slice(N_RINGS, 2 * N_RINGS)
_HARM0 = 2 * N_RINGS
_S_HIST = slice(_HARM0 + 2 * N_WAVE * N_RINGS, _HARM0 + 2 * N_WAVE * N_RINGS + N_HIST)
RAW_DIM = _S_HIST.stop                             # 212

# How much each block counts in the squared distance, whatever its length.
# First guesses: the blind comparison in Phase 0 is what sets them.
DEFAULT_BLOCK_WEIGHTS = {"mean": 1.0, "spread": 0.5, "asym": 1.0, "hist": 0.5}


def _harm(m: int, part: int) -> slice:
    """Slice of the raw vector holding wavenumber m (1-based); part 0 = Re, 1 = Im."""
    start = _HARM0 + ((m - 1) * 2 + part) * N_RINGS
    return slice(start, start + N_RINGS)


# ═════════════════════════════════════════════════════════════════════════
#  Frames
# ═════════════════════════════════════════════════════════════════════════

def frame_list(track_points: list) -> list:
    """The archive's 3-hourly frame list for one storm.

    Verbatim logic of global_archive_api._build_mergir_frame_list, so
    frame_idx here is the frame_idx of /global/ir/frame, of the
    v7/ir/{sid}/{idx}.json objects and of Storm Detail deep links. Note it
    drops a fix whose latitude or longitude is exactly 0 (falsy), as the
    original does; changing that here would shift every later index.
    """
    frames = []
    seen = set()
    for pt in track_points:
        if not pt.get("t") or not pt.get("la") or not pt.get("lo"):
            continue
        try:
            dt = datetime.fromisoformat(pt["t"].replace("Z", "+00:00").split("+")[0])
        except (ValueError, AttributeError):
            continue
        dt = dt.replace(hour=(dt.hour // 3) * 3, minute=0, second=0, microsecond=0)
        key = dt.strftime("%Y%m%d%H")
        if key in seen:
            continue
        seen.add(key)
        frames.append({
            "datetime": dt.strftime("%Y-%m-%dT%H:%M:00"),
            "lat": float(pt["la"]),
            "lon": float(pt["lo"]),
        })
    frames.sort(key=lambda f: f["datetime"])
    return frames


# ═════════════════════════════════════════════════════════════════════════
#  Tb encoding and source decoding
# ═════════════════════════════════════════════════════════════════════════

def u8_to_tb(idx) -> np.ndarray:
    """Archive uint8 index -> K (float32), 0 -> NaN."""
    idx = np.asarray(idx)
    tb = TB_VMIN + (idx.astype(np.float32) - 1.0) / TB_SCALE
    tb[idx == 0] = np.nan
    return tb


def tb_to_u8(tb) -> np.ndarray:
    """K -> archive uint8 index; NaN and non-positive -> 0. Rounds to nearest
    (the API's encoder truncates; rounding halves the round-trip error)."""
    a = np.asarray(tb, dtype=np.float32)
    bad = ~np.isfinite(a) | (a <= 0)
    out = np.clip(np.rint((np.where(bad, TB_VMIN, a) - TB_VMIN) * TB_SCALE + 1.0), 1, 255).astype(np.uint8)
    out[bad] = 0
    return out


def decode_sector(doc: dict):
    """A v7/ir/{sid}/{idx}.json frame -> (tb [rows, cols] K north-up, bounds).

    bounds is the frame's own {"south", "north", "west", "east"}; west can be
    below -180 or east above 180 for a storm near the dateline.
    """
    rows, cols = int(doc["tb_rows"]), int(doc["tb_cols"])
    idx = np.frombuffer(base64.b64decode(doc["tb_data"]), dtype=np.uint8)
    if idx.size != rows * cols:
        raise ValueError(f"tb_data holds {idx.size} bytes, expected {rows}x{cols}")
    return u8_to_tb(idx.reshape(rows, cols)), dict(doc["bounds"])


def decode_context(image_bytes: bytes, bounds: dict):
    """An ir-context/v1 WebP (bin/build_ir_context.py) -> (tb K north-up, bounds).

    RGB carries the Tb index, alpha the validity mask. The file is lossy
    (mean |error| about 0.7 K) and missing pixels were nearest-filled before
    encoding, so alpha, not the index, says what is missing.
    """
    import io
    from PIL import Image
    im = np.asarray(Image.open(io.BytesIO(image_bytes)).convert("RGBA"))
    tb = u8_to_tb(np.maximum(im[..., 0], 1))
    tb[im[..., 3] == 0] = np.nan
    return tb, dict(bounds)


# ═════════════════════════════════════════════════════════════════════════
#  Scene QC (vendored)
# ═════════════════════════════════════════════════════════════════════════

QC_HALF_DEG = 6.0
QC_FILL_MAX = 0.06        # missing fraction
QC_ANISO_MAX = 1.8        # row/col mean-|dTb| ratio (striping)
QC_UNPHYS_MAX = 0.002     # fraction outside [150, 340] K


def scene_qc(tb, bounds: dict, center_lat: float, center_lon: float) -> dict:
    """global_archive_api._mergir_scene_qc, verbatim: missing data, striping
    and unphysical values on the +/-6 deg box about the storm centre of a
    north-up frame. Thresholds were set on native 4 km MergIR; the 8 km
    context layer is smoother, so they are lenient there."""
    tb = np.asarray(tb, dtype=float)
    ny, nx = tb.shape
    lats = bounds["north"] - (np.arange(ny) + 0.5) * (bounds["north"] - bounds["south"]) / ny
    lons = bounds["west"] + (np.arange(nx) + 0.5) * (bounds["east"] - bounds["west"]) / nx
    sub = tb[np.ix_(np.abs(lats - center_lat) <= QC_HALF_DEG,
                    np.abs(lons - center_lon) <= QC_HALF_DEG)]
    fin = np.isfinite(sub)
    if fin.sum() < 100:
        return {"is_bad": True, "reason": "empty"}
    fill = float(1.0 - fin.mean())
    col_jump = float(np.nanmean(np.abs(np.diff(sub, axis=1))))
    row_jump = float(np.nanmean(np.abs(np.diff(sub, axis=0))))
    aniso = max(col_jump, row_jump) / max(min(col_jump, row_jump), 1e-6)
    unphys = float((fin & ((sub < 150) | (sub > 340))).mean())
    reasons = []
    if fill > QC_FILL_MAX:
        reasons.append(f"fill={fill:.3f}")
    if aniso > QC_ANISO_MAX:
        reasons.append(f"stripe_aniso={aniso:.2f}")
    if unphys > QC_UNPHYS_MAX:
        reasons.append(f"unphysical={unphys:.3f}")
    return {"is_bad": bool(reasons), "reason": ",".join(reasons)}


# ═════════════════════════════════════════════════════════════════════════
#  Chips
# ═════════════════════════════════════════════════════════════════════════

_GRID_CACHE: dict = {}


def _chip_grid(px: int, km: float):
    """East and north offsets (km) of every chip pixel centre; row 0 = north."""
    key = (px, float(km))
    g = _GRID_CACHE.get(key)
    if g is None:
        half = (px - 1) / 2.0
        x = (np.arange(px) - half) * km
        y = (half - np.arange(px)) * km
        xx, yy = np.meshgrid(x, y)
        g = (xx, yy, np.hypot(xx, yy), np.arctan2(xx, yy))   # east, north, range, bearing (cw from north)
        _GRID_CACHE[key] = g
    return g


def chip_latlon(center_lat: float, center_lon: float, px: int = CHIP_PX, km: float = CHIP_KM):
    """Latitude and longitude of every chip pixel: the point at that pixel's
    range and bearing from the centre along a great circle."""
    _, _, rng, brg = _chip_grid(px, km)
    d = rng / EARTH_R_KM
    p1 = np.radians(center_lat)
    sin_p2 = np.sin(p1) * np.cos(d) + np.cos(p1) * np.sin(d) * np.cos(brg)
    p2 = np.arcsin(np.clip(sin_p2, -1.0, 1.0))
    dl = np.arctan2(np.sin(brg) * np.sin(d) * np.cos(p1), np.cos(d) - np.sin(p1) * sin_p2)
    return np.degrees(p2), center_lon + np.degrees(dl)


def sample_latlon(tb, bounds: dict, lat, lon) -> np.ndarray:
    """Bilinear sample of a north-up, cell-registered lat/lon grid at (lat, lon).

    Missing (NaN) neighbours are left out and the rest renormalised; a point
    with under half its weight on valid cells is NaN. Longitude is taken
    modulo 360 from the grid's west edge, so a sector straddling the dateline
    and a global grid both work; a global grid also wraps at its seam.
    """
    tb = np.asarray(tb, dtype=np.float32)
    rows, cols = tb.shape
    south, north = float(bounds["south"]), float(bounds["north"])
    west, east = float(bounds["west"]), float(bounds["east"])
    dlat = (north - south) / rows
    dlon = (east - west) / cols
    wraps = (east - west) >= 359.5

    fr = (north - np.asarray(lat, dtype=np.float64)) / dlat - 0.5
    fc = np.mod(np.asarray(lon, dtype=np.float64) - west, 360.0) / dlon - 0.5
    if not wraps:
        # A longitude just west of the grid comes out near 360/dlon: bring it
        # back to a small negative column so the half-pixel edge rule applies.
        fc = np.where(fc > cols - 0.5 + (360.0 / dlon - cols) / 2.0, fc - 360.0 / dlon, fc)

    r0 = np.floor(fr).astype(np.int64)
    c0 = np.floor(fc).astype(np.int64)
    wr = (fr - r0).astype(np.float32)
    wc = (fc - c0).astype(np.float32)

    acc = np.zeros(fr.shape, dtype=np.float32)
    wsum = np.zeros(fr.shape, dtype=np.float32)
    for dr_, wr_ in ((0, 1.0 - wr), (1, wr)):
        rr = r0 + dr_
        r_ok = (rr >= 0) & (rr < rows)
        rr = np.clip(rr, 0, rows - 1)
        for dc_, wc_ in ((0, 1.0 - wc), (1, wc)):
            cc = c0 + dc_
            if wraps:
                c_ok = np.ones(cc.shape, dtype=bool)
                cc = np.mod(cc, cols)
            else:
                c_ok = (cc >= 0) & (cc < cols)
                cc = np.clip(cc, 0, cols - 1)
            v = tb[rr, cc]
            w = wr_ * wc_ * (r_ok & c_ok & np.isfinite(v))
            acc += w * np.where(np.isfinite(v), v, 0.0)
            wsum += w
    with np.errstate(invalid="ignore", divide="ignore"):
        out = acc / wsum
    out[wsum < 0.5] = np.nan
    return out


def fill_small_gaps(chip, passes: int = 3) -> np.ndarray:
    """Fill narrow holes from their neighbours; leave real gaps missing.

    MergIR's parallax correction leaves thin lines of missing pixels along
    the edges of high cloud: typically 2-5% of a storm chip, one or two
    pixels wide. Each pass gives a missing pixel the mean of its valid
    8-neighbours, so `passes` passes close a hole up to about 2 * passes
    pixels across. A missing swath or an off-disc area is far wider than
    that and keeps its NaN core.
    """
    out = np.array(chip, dtype=np.float32, copy=True)
    for _ in range(passes):
        nan = ~np.isfinite(out)
        if not nan.any():
            break
        p = np.pad(np.where(nan, 0.0, out), 1)
        c = np.pad((~nan).astype(np.float32), 1)
        h, w = out.shape
        tot = np.zeros_like(out)
        cnt = np.zeros_like(out)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                if dy == 1 and dx == 1:
                    continue
                tot += p[dy:dy + h, dx:dx + w]
                cnt += c[dy:dy + h, dx:dx + w]
        fill = nan & (cnt > 0)
        out[fill] = tot[fill] / cnt[fill]
    return out


def cut_chip(tb, bounds: dict, center_lat: float, center_lon: float, *,
             px: int = CHIP_PX, km: float = CHIP_KM, flip_sh: bool = True, fill_passes: int = 3):
    """Cut the storm-centred chip from a north-up lat/lon frame.

    Returns (chip, info): chip is float32 [px, px] K with NaN for missing;
    info = {"flipped": mirrored north-south because the centre is in the
    Southern Hemisphere, "gap_frac": missing fraction as sampled, before
    fill_small_gaps, "valid_frac": finite fraction of the returned chip}.
    fill_passes=0 returns the chip as sampled.
    """
    lat, lon = chip_latlon(center_lat, center_lon, px, km)
    chip = sample_latlon(tb, bounds, lat, lon)
    gap_frac = float(1.0 - np.isfinite(chip).mean())
    if fill_passes and gap_frac > 0:
        chip = fill_small_gaps(chip, fill_passes)
    flipped = bool(flip_sh and center_lat < 0)
    if flipped:
        chip = chip[::-1].copy()
    return chip, {"flipped": flipped, "gap_frac": gap_frac, "valid_frac": float(np.isfinite(chip).mean())}


def unflip(chip: np.ndarray, flipped: bool) -> np.ndarray:
    """Back to geographic north-up, for display."""
    return chip[::-1] if flipped else chip


# ═════════════════════════════════════════════════════════════════════════
#  Polar descriptor (method A)
# ═════════════════════════════════════════════════════════════════════════

_POLAR_CACHE: dict = {}


def _ring_gram_inv(ring, phi, n):
    """Inverse of each ring's Gram matrix <phi phi^T> over the given pixels."""
    nb = phi.shape[1]
    G = np.empty((N_RINGS, nb, nb))
    for i in range(nb):
        for j in range(i, nb):
            G[:, i, j] = G[:, j, i] = np.bincount(ring, weights=phi[:, i] * phi[:, j], minlength=N_RINGS)
    G /= np.maximum(n, 1.0)[:, None, None]
    # A ring with no usable pixels has an all-zero Gram; it is flagged not ok
    # by the caller, so give it the identity rather than fail the inversion.
    empty = n < 1
    G[empty] = np.eye(nb)
    return np.linalg.inv(G)


def _polar_geom(px: int, km: float):
    key = (px, float(km))
    g = _POLAR_CACHE.get(key)
    if g is None:
        xx, yy, rng, _ = _chip_grid(px, km)
        ring = np.floor(rng / RING_DR_KM).astype(np.int64).ravel()
        sel = np.flatnonzero(ring < N_RINGS)
        ring = ring[sel]
        theta = np.arctan2(yy, xx).ravel()[sel]          # ccw from east
        # basis [cos t, sin t, cos 2t, sin 2t, ...]
        phi = np.stack([f(m * theta) for m in range(1, N_WAVE + 1) for f in (np.cos, np.sin)], axis=1)
        count = np.bincount(ring, minlength=N_RINGS).astype(np.float64)
        if count.min() < 8 * N_WAVE:
            raise ValueError(f"chip {px}px at {km} km is too coarse for {RING_DR_KM} km rings")
        g = (sel, ring, phi, count, _ring_gram_inv(ring, phi, count))
        _POLAR_CACHE[key] = g
    return g


def polar_descriptor(chip, km: float = CHIP_KM):
    """Describe a chip by rings about its centre.

    For each of N_RINGS rings (RING_DR_KM wide, out to RING_RMAX_KM): the mean
    Tb, its azimuthal standard deviation, and the complex coefficients a_m of
    azimuthal wavenumbers 1..N_WAVE, from a least-squares fit of
    sum_m (c_m cos m theta + s_m sin m theta) to the ring's departures from
    its mean, with a_m = (c_m - i s_m) / 2. A ring field
    A cos(m (theta - theta0)) gives a_m = (A/2) exp(-i m theta0), and rotating
    the chip counter-clockwise by alpha multiplies a_m by exp(-i m alpha), so
    |a_m| does not depend on orientation. (A plain Fourier sum over the ring's
    pixels is not good enough: the pixels sit on a square lattice, which
    leaks a few percent of wavenumber 1 into wavenumber 3.) Plus the fraction
    of the disc in each Tb class (HIST_EDGES_K).

    Returns (raw, ok). raw is float32 [RAW_DIM] in the module's raw layout,
    with NaN in any ring short of RING_MIN_VALID finite pixels; ok is True
    when every ring is usable. Frames that are not ok stay out of the index.
    """
    chip = np.asarray(chip, dtype=np.float32)
    if chip.ndim != 2 or chip.shape[0] != chip.shape[1]:
        raise ValueError(f"chip must be square, got {chip.shape}")
    sel, ring, phi, count, gram_inv = _polar_geom(chip.shape[0], km)
    v = chip.ravel()[sel]
    fin = np.isfinite(v)
    complete = bool(fin.all())
    rf = ring if complete else ring[fin]
    pf = phi if complete else phi[fin]
    vf = v[fin].astype(np.float64)
    n = np.bincount(rf, minlength=N_RINGS).astype(np.float64)
    ring_ok = n >= RING_MIN_VALID * count

    raw = np.full(RAW_DIM, np.nan, dtype=np.float32)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.bincount(rf, weights=vf, minlength=N_RINGS) / n
        dev = vf - mean[rf]
        std = np.sqrt(np.bincount(rf, weights=dev * dev, minlength=N_RINGS) / n)
        raw[_S_MEAN] = np.where(ring_ok, mean, np.nan)
        raw[_S_STD] = np.where(ring_ok, std, np.nan)
        proj = np.stack([np.bincount(rf, weights=dev * pf[:, j], minlength=N_RINGS)
                         for j in range(pf.shape[1])], axis=1) / n[:, None]
        if not complete:
            gram_inv = _ring_gram_inv(rf, pf, n)       # fit on the pixels that exist
        fit = np.einsum("kij,kj->ki", gram_inv, np.nan_to_num(proj))     # [rings, 2 * N_WAVE]
        for m in range(1, N_WAVE + 1):
            raw[_harm(m, 0)] = np.where(ring_ok, fit[:, 2 * (m - 1)] / 2.0, np.nan)
            raw[_harm(m, 1)] = np.where(ring_ok, -fit[:, 2 * (m - 1) + 1] / 2.0, np.nan)
        if vf.size:
            hist = np.bincount(np.searchsorted(HIST_EDGES_K, vf, side="right"), minlength=N_HIST) / vf.size
            raw[_S_HIST] = hist
    return raw, bool(ring_ok.all())


def harmonics(raw) -> np.ndarray:
    """Complex coefficients a_m per ring from raw vector(s): [..., N_WAVE, N_RINGS]."""
    raw = np.asarray(raw)
    return np.stack([raw[..., _harm(m, 0)] + 1j * raw[..., _harm(m, 1)]
                     for m in range(1, N_WAVE + 1)], axis=-2)


def align_angle(raw_query, raw_match) -> float:
    """Degrees to rotate the MATCH chip counter-clockwise so its asymmetries
    best line up with the query's, from the wavenumber 1..N_WAVE coefficients
    of all rings. Meaningless for two axisymmetric storms (it then returns an
    arbitrary angle), which is harmless: rotating a symmetric chip changes
    nothing."""
    aq, ax = harmonics(raw_query), harmonics(raw_match)
    # Rotating the match by alpha turns its a_m into a_m exp(-i m alpha); the
    # best alpha maximises Re sum_m,k a_q conj(a_x exp(-i m alpha)).
    cross = np.nansum(aq * np.conj(ax), axis=-1)                 # [N_WAVE]
    alphas = np.radians(np.arange(360.0))
    m = np.arange(1, N_WAVE + 1)[:, None]
    score = np.real(cross[:, None] * np.exp(1j * m * alphas[None, :])).sum(axis=0)
    return float(np.argmax(score))


# ═════════════════════════════════════════════════════════════════════════
#  Scaling: raw descriptors -> search vectors
# ═════════════════════════════════════════════════════════════════════════

def fit_scaler(raws) -> dict:
    """Per-feature centre and scale from a stack of raw descriptors [N, RAW_DIM].

    Means, spreads and histogram fractions are z-scored. The harmonic
    coefficients are NOT centred and the real and imaginary part of a
    coefficient share one scale (its RMS amplitude in that ring): scaling the
    two parts separately would make the distance depend on which way north
    is, and with a shared scale the "any orientation" distance is never
    larger than the "as seen" one.
    """
    R = np.asarray(raws, dtype=np.float64)
    center = np.zeros(RAW_DIM)
    scale = np.ones(RAW_DIM)
    for sl in (_S_MEAN, _S_STD, _S_HIST):
        center[sl] = np.nanmean(R[:, sl], axis=0)
        scale[sl] = np.nanstd(R[:, sl], axis=0)
    for m in range(1, N_WAVE + 1):
        re, im = R[:, _harm(m, 0)], R[:, _harm(m, 1)]
        rms = np.sqrt(np.nanmean(re * re + im * im, axis=0))
        scale[_harm(m, 0)] = rms
        scale[_harm(m, 1)] = rms
    scale[~np.isfinite(scale) | (scale < 1e-6)] = 1.0     # a constant feature carries nothing
    return {"spec": SPEC_VERSION, "center": center.astype(np.float32), "scale": scale.astype(np.float32)}


def search_vectors(raws, scaler: dict, mode: str = "seen", weights: dict | None = None) -> np.ndarray:
    """Raw descriptors -> float32 vectors whose Euclidean distance is the
    analog distance.

    mode "seen": orientation matters (real and imaginary harmonic parts).
    mode "any":  orientation ignored (harmonic amplitudes only).
    Each block (mean / spread / asym / hist) is scaled so that it contributes
    its weight to the squared distance regardless of how many numbers it
    holds. Rows with a NaN stay NaN: keep only descriptors that were ok.
    """
    if mode not in ("seen", "any"):
        raise ValueError("mode must be 'seen' or 'any'")
    w = dict(DEFAULT_BLOCK_WEIGHTS)
    if weights:
        w.update(weights)
    R = np.atleast_2d(np.asarray(raws, dtype=np.float32))
    Z = (R - scaler["center"]) / scaler["scale"]

    def blk(a, weight):
        return a * np.float32(np.sqrt(weight / a.shape[1]))

    parts = [blk(Z[:, _S_MEAN], w["mean"]), blk(Z[:, _S_STD], w["spread"])]
    if mode == "seen":
        harm = np.concatenate([Z[:, _harm(m, p)] for m in range(1, N_WAVE + 1) for p in (0, 1)], axis=1)
    else:
        harm = np.concatenate([np.hypot(Z[:, _harm(m, 0)], Z[:, _harm(m, 1)])
                               for m in range(1, N_WAVE + 1)], axis=1)
    # Normalise the asym block by ring-coefficients, not by numbers stored, so
    # "seen" (two numbers per coefficient) and "any" (one) weigh it the same.
    parts.append(harm * np.float32(np.sqrt(w["asym"] / (N_WAVE * N_RINGS))))
    parts.append(blk(Z[:, _S_HIST], w["hist"]))
    return np.ascontiguousarray(np.concatenate(parts, axis=1), dtype=np.float32)


# ═════════════════════════════════════════════════════════════════════════
#  Packing (PCA for long embeddings, int8 for storage)
# ═════════════════════════════════════════════════════════════════════════

def fit_pca(X, k: int) -> dict:
    """Top-k principal axes of X [N, D] (for the 384-number ViT embeddings;
    the polar descriptor is short enough to store whole)."""
    X = np.asarray(X, dtype=np.float64)
    mean = X.mean(axis=0)
    cov = np.cov(X - mean, rowvar=False)
    vals, vecs = np.linalg.eigh(cov)
    order = np.argsort(vals)[::-1][:k]
    return {"mean": mean.astype(np.float32), "components": vecs[:, order].T.astype(np.float32),
            "explained": float(vals[order].sum() / max(vals.sum(), 1e-30))}


def apply_pca(X, pca: dict) -> np.ndarray:
    return ((np.asarray(X, dtype=np.float32) - pca["mean"]) @ pca["components"].T).astype(np.float32)


def pack_int8(X, clip_quantile: float = 0.9995):
    """float32 vectors -> (int8, step). One step size for every dimension, so
    Euclidean geometry survives: distance(float) ~= step * distance(int8)."""
    X = np.asarray(X, dtype=np.float32)
    top = float(np.quantile(np.abs(X), clip_quantile))
    step = max(top, 1e-12) / 127.0
    return np.clip(np.rint(X / step), -127, 127).astype(np.int8), step


def unpack_int8(Xi, step: float) -> np.ndarray:
    return np.asarray(Xi, dtype=np.float32) * np.float32(step)


# ═════════════════════════════════════════════════════════════════════════
#  Search
# ═════════════════════════════════════════════════════════════════════════

def storm_segments(storm_of_row) -> np.ndarray:
    """Start row of each storm. Index rows must be grouped by storm (every
    storm's frames contiguous), which is what makes one-match-per-storm
    cheap; raises if they are not."""
    s = np.asarray(storm_of_row)
    if s.ndim != 1 or s.size == 0:
        raise ValueError("storm_of_row must be a non-empty 1-D array")
    starts = np.flatnonzero(np.concatenate(([True], s[1:] != s[:-1])))
    if len(np.unique(s[starts])) != len(starts):
        raise ValueError("index rows are not grouped by storm")
    return starts


def search(Q, X, starts, *, k: int = 100, exclude_storm=None, row_mask=None, x_sq=None):
    """Exact nearest neighbours with at most one match per storm.

    Q [B, D] queries, X [N, D] index (rows grouped by storm), starts from
    storm_segments. exclude_storm: per-query storm number (position in
    `starts`) to leave out, normally the query's own storm; -1 or None for
    none. row_mask: bool [N], False rows cannot match (basin, intensity,
    year filters). x_sq: precomputed (X * X).sum(1) for repeated calls.

    Returns (rows [B, k] int64, dist [B, k] float32), best first: each
    storm's single best-matching row. Unfilled slots are -1 / inf.
    """
    Q = np.atleast_2d(np.asarray(Q, dtype=np.float32))
    X = np.asarray(X, dtype=np.float32)
    starts = np.asarray(starts, dtype=np.int64)
    B, N, S = Q.shape[0], X.shape[0], len(starts)
    if x_sq is None:
        x_sq = np.einsum("ij,ij->i", X, X)
    d2 = (np.einsum("ij,ij->i", Q, Q)[:, None] + x_sq[None, :] - 2.0 * (Q @ X.T)).astype(np.float32)
    np.maximum(d2, 0.0, out=d2)
    if row_mask is not None:
        d2[:, ~np.asarray(row_mask, dtype=bool)] = np.inf
    if exclude_storm is not None:
        ends = np.append(starts[1:], N)
        for b, s in enumerate(np.broadcast_to(np.asarray(exclude_storm, dtype=np.int64), (B,))):
            if s >= 0:
                d2[b, starts[s]:ends[s]] = np.inf

    storm_of_row = np.repeat(np.arange(S), np.diff(np.append(starts, N)))
    best = np.minimum.reduceat(d2, starts, axis=1)                # [B, S] each storm's best
    kk = min(k, S)
    rows = np.full((B, k), -1, dtype=np.int64)
    dist = np.full((B, k), np.inf, dtype=np.float32)
    for b in range(B):
        if kk < S:
            kth = np.partition(best[b], kk - 1)[kk - 1]
        else:
            kth = best[b].max()
        if not np.isfinite(kth):
            kth = np.max(best[b][np.isfinite(best[b])], initial=-1.0)
            if kth < 0:
                continue
        cand = np.flatnonzero(d2[b] <= kth)
        cand = cand[np.argsort(d2[b, cand], kind="stable")]
        _, first = np.unique(storm_of_row[cand], return_index=True)
        pick = cand[np.sort(first)][:kk]
        rows[b, :len(pick)] = pick
        dist[b, :len(pick)] = np.sqrt(d2[b, pick])
    return rows, dist


def fit_closeness(kth_dist) -> np.ndarray:
    """Percentiles 0..100 of a reference distance across the archive (the
    distance to each frame's 10th-best match, say). Stored with the index."""
    d = np.asarray(kth_dist, dtype=np.float64)
    return np.percentile(d[np.isfinite(d)], np.arange(101)).astype(np.float32)


def closeness_percentile(d: float, table) -> float:
    """Where a distance sits in fit_closeness's table: near 0 = unusually
    close look-alikes, near 100 = this frame has no close precedent."""
    return float(np.clip(np.searchsorted(np.asarray(table), d, side="left"), 0, 100))
