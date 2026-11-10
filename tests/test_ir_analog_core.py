#!/usr/bin/env python3
"""Tests for ir_analog_core.py, the shared core of the IR Analog Finder
(PLAN_ir_analog_finder.md). No network, no GCS, numpy only.

Covers:
  parity    frame_list and scene_qc are the SAME logic as
            global_archive_api._build_mergir_frame_list / _mergir_scene_qc.
            The originals are lifted out of the source file by AST and run
            here, because importing global_archive_api needs FastAPI and
            rewrites ~/.netrc at import time.
  encoding  uint8 <-> K round trip; a sector frame decodes to what was encoded
  chips     pixel range is true great-circle distance at low and high
            latitude, across the dateline and on a global (wrapping) grid;
            the Southern Hemisphere mirror; missing data stays missing
  descriptor ring harmonics recover a known amplitude and phase; "any
            orientation" is rotation-invariant and "as seen" is not;
            align_angle recovers a known rotation; a ring short of data
            marks the descriptor not ok
  scaling   the "any" distance never exceeds the "seen" distance; block
            weights do what they say
  packing   int8 keeps distances; PCA recovers a low-rank subspace
  search    matches brute force, one match per storm, own storm excluded,
            row masks honoured, short archives pad with -1

Runnable standalone:  python3 tests/test_ir_analog_core.py
"""
import ast
import base64
import json
import os
import sys
from datetime import datetime

import numpy as np

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import ir_analog_core as C  # noqa: E402


# ── helpers ──────────────────────────────────────────────────────────────

def _lift(path, func_names, const_prefixes=()):
    """Exec the named top-level functions (and constants with the given name
    prefixes) of a source file in a fresh namespace, without importing it."""
    src = open(path).read()
    tree = ast.parse(src)
    ns = {"np": np, "datetime": datetime}
    for node in tree.body:
        keep = False
        if isinstance(node, ast.FunctionDef) and node.name in func_names:
            keep = True
        elif isinstance(node, ast.Assign) and const_prefixes:
            keep = any(isinstance(t, ast.Name) and t.id.startswith(const_prefixes) for t in node.targets)
        if keep:
            exec(compile(ast.Module(body=[node], type_ignores=[]), path, "exec"), ns)
    missing = [f for f in func_names if f not in ns]
    assert not missing, f"{os.path.basename(path)} no longer defines {missing}"
    return ns


_API = os.path.join(_REPO_ROOT, "global_archive_api.py")


def _gc_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(lon2 - lon1)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * C.EARTH_R_KM * np.arcsin(np.sqrt(a))


def _radial_frame(clat, clon, bounds, rows=550, cols=550, wrap_global=False):
    """A lat/lon frame whose Tb depends only on great-circle distance from
    (clat, clon): Tb = 200 + 0.1 K per km."""
    lats = bounds["north"] - (np.arange(rows) + 0.5) * (bounds["north"] - bounds["south"]) / rows
    lons = bounds["west"] + (np.arange(cols) + 0.5) * (bounds["east"] - bounds["west"]) / cols
    la, lo = np.meshgrid(lats, lons, indexing="ij")
    return (200.0 + 0.1 * _gc_km(clat, clon, la, lo)).astype(np.float32)


def _synthetic_chip(rot_deg=0.0, eye=True, px=C.CHIP_PX, km=C.CHIP_KM, seed=None,
                    size_km=220.0, depth=85.0, asym=12.0, band_r=260.0):
    """An idealised storm drawn directly on the chip grid at a given
    orientation (so a rotation is exact, with no image resampling): warm eye,
    cold central overcast, a wavenumber-1 asymmetry and a spiral band."""
    xx, yy, rng, _ = C._chip_grid(px, km)
    th = np.arctan2(yy, xx) - np.radians(rot_deg)
    tb = 290.0 - depth * np.exp(-(rng / size_km) ** 2)                 # central overcast
    if eye:
        tb += 60.0 * np.exp(-(rng / 18.0) ** 2)                        # warm eye
    tb += asym * np.exp(-((rng - 150.0) / 90.0) ** 2) * np.cos(th - 0.6)             # wn-1
    band = np.exp(-((rng - band_r - 40.0 * np.cos(th)) / 30.0) ** 2)
    tb -= 18.0 * band * (0.5 + 0.5 * np.tanh(4.0 * np.cos(th + rng / 200.0)))
    if seed is not None:
        tb += np.random.default_rng(seed).normal(0, 0.5, tb.shape)
    return tb.astype(np.float32)


def _random_storm(i):
    """A storm with its own size, depth, asymmetry, band and orientation."""
    r = np.random.default_rng(1000 + i)
    return _synthetic_chip(r.uniform(0, 360), eye=bool(r.integers(0, 2)), seed=i,
                           size_km=r.uniform(120, 320), depth=r.uniform(40, 100),
                           asym=r.uniform(0, 25), band_r=r.uniform(180, 340))


# ── parity with global_archive_api ───────────────────────────────────────

def test_frame_list_parity():
    api = _lift(_API, ["_build_mergir_frame_list"])["_build_mergir_frame_list"]
    cases = []
    for name in ("ibtracs_tracks_0.json", "ibtracs_tracks_1.json"):
        tracks = json.load(open(os.path.join(_REPO_ROOT, name)))
        sids = sorted(tracks)
        cases += [tracks[s] for s in sids[:: max(1, len(sids) // 150)]]
    # the awkward inputs: off-synoptic times, duplicates in one 3-h slot, a
    # zero latitude (dropped by the original), a bad time, out of order
    cases.append([
        {"t": "2020-09-01T04:30", "la": 12.0, "lo": -40.0},
        {"t": "2020-09-01T05:59", "la": 12.1, "lo": -40.2},
        {"t": "2020-09-01T00:00", "la": 0.0, "lo": -39.0},
        {"t": "2020-09-01T00:00Z", "la": 11.5, "lo": -39.5},
        {"t": "not a time", "la": 11.0, "lo": -39.0},
        {"t": "2020-08-31T21:00", "la": 11.2, "lo": -39.1},
        {"t": None, "la": 11.0, "lo": -39.0},
    ])
    n = 0
    for pts in cases:
        assert C.frame_list(pts) == api(pts)
        n += len(api(pts))
    assert n > 5000, n


def test_scene_qc_parity():
    api = _lift(_API, ["_mergir_scene_qc"], const_prefixes=("MERGIR_QC_",))["_mergir_scene_qc"]
    rng = np.random.default_rng(3)
    bounds = {"south": 10.0, "north": 30.0, "west": -70.0, "east": -50.0}
    base = 250.0 + rng.normal(0, 8, (550, 550)).cumsum(axis=0).cumsum(axis=1) / 400.0
    striped = base.copy(); striped[::2] += 25.0
    holed = base.copy(); holed[200:330, 200:330] = np.nan
    hot = base.copy(); hot[250:270, 250:270] = 400.0
    empty = np.full_like(base, np.nan)
    verdicts = []
    for tb in (base, striped, holed, hot, empty):
        a, b = C.scene_qc(tb, bounds, 20.0, -60.0), api(tb, bounds, 20.0, -60.0)
        assert a == b, (a, b)
        verdicts.append(a["is_bad"])
    assert verdicts == [False, True, True, True, True], verdicts


# ── encoding ─────────────────────────────────────────────────────────────

def test_tb_roundtrip_and_sector_decode():
    tb = np.linspace(171.0, 309.0, 600).astype(np.float32).reshape(20, 30)
    tb[0, 0] = np.nan
    u8 = C.tb_to_u8(tb)
    assert u8[0, 0] == 0 and u8.min() == 0 and u8[0, 1] >= 1
    back = C.u8_to_tb(u8)
    assert np.isnan(back[0, 0])
    assert np.nanmax(np.abs(back - tb)) <= 0.5 / C.TB_SCALE + 1e-4      # half a step
    doc = {"tb_data": base64.b64encode(u8.tobytes()).decode(), "tb_rows": 20, "tb_cols": 30,
           "bounds": {"south": 0, "north": 20, "west": -100, "east": -70}}
    dec, b = C.decode_sector(doc)
    assert dec.shape == (20, 30) and b["west"] == -100
    assert np.array_equal(np.isnan(dec), np.isnan(back)) and np.nanmax(np.abs(dec - back)) == 0
    try:
        C.decode_sector(dict(doc, tb_rows=21))
    except ValueError:
        pass
    else:
        raise AssertionError("a frame whose size disagrees with its data must not decode")


# ── chips ────────────────────────────────────────────────────────────────

def _check_radial_chip(clat, clon, bounds, rows=550, cols=550, tol_km=2.5):
    tb = _radial_frame(clat, clon, bounds, rows, cols)
    chip, info = C.cut_chip(tb, bounds, clat, clon)
    assert chip.shape == (C.CHIP_PX, C.CHIP_PX) and info["valid_frac"] == 1.0, info
    _, _, rng, _ = C._chip_grid(C.CHIP_PX, C.CHIP_KM)
    got_km = (chip - 200.0) / 0.1
    # bilinear sampling of a cone rounds its tip, so skip the innermost pixels
    far = rng > 12.0
    err = np.abs(got_km - rng)[far]
    assert err.max() < tol_km, (clat, clon, float(err.max()))


def test_chip_range_is_true_distance():
    _check_radial_chip(15.0, -60.0, {"south": 5.0, "north": 25.0, "west": -70.0, "east": -50.0})
    # At 45N a flat lat/lon crop would be ~30% narrower east-west than
    # north-south; the chip must still be isotropic.
    _check_radial_chip(45.0, -60.0, {"south": 35.0, "north": 55.0, "west": -70.0, "east": -50.0})
    _check_radial_chip(-22.0, 60.0, {"south": -32.0, "north": -12.0, "west": 50.0, "east": 70.0})


def test_chip_across_dateline_and_global_grid():
    # a sector whose bounds run past 180, as the archive writes them
    _check_radial_chip(18.0, 179.5, {"south": 8.0, "north": 28.0, "west": 169.5, "east": 189.5})
    _check_radial_chip(18.0, -179.0, {"south": 8.0, "north": 28.0, "west": -189.0, "east": -169.0})
    # the 8 km context layer: one global grid, seam at +/-180
    g = {"south": -60.0, "north": 60.0, "west": -180.0, "east": 180.0}
    _check_radial_chip(18.0, 179.9, g, rows=1650, cols=4950, tol_km=4.5)
    _check_radial_chip(18.0, -40.0, g, rows=1650, cols=4950, tol_km=4.5)


def test_chip_outside_frame_is_missing():
    bounds = {"south": 10.0, "north": 30.0, "west": -70.0, "east": -50.0}
    tb = np.full((550, 550), 250.0, dtype=np.float32)
    # centre near the frame's east edge: the chip's east half has no data and
    # must come back NaN, not wrapped around from the west edge
    chip, info = C.cut_chip(tb, bounds, 20.0, -50.5)
    assert np.isfinite(chip[:, :90]).all()
    assert np.isnan(chip[:, 140:]).all()
    assert 0.4 < info["valid_frac"] < 0.6, info
    # a NaN hole in the source stays a hole; valid neighbours are not smeared in
    tb2 = tb.copy(); tb2[260:290, 260:290] = np.nan
    chip2, info2 = C.cut_chip(tb2, bounds, 20.0, -60.0)
    assert np.isnan(chip2[112, 112]) and np.isfinite(chip2[20, 20])
    assert info2["gap_frac"] > 1.0 - info2["valid_frac"] > 0     # the rim was filled, the core was not
    assert abs(np.nanmax(chip2) - 250.0) < 1e-3 and abs(np.nanmin(chip2) - 250.0) < 1e-3


def test_small_gaps_filled_large_ones_kept():
    xx, yy, rng, _ = C._chip_grid(C.CHIP_PX, C.CHIP_KM)
    chip = (200.0 + 0.2 * rng).astype(np.float32)
    holed = chip.copy()
    holed[50, 20:200] = np.nan                    # a 1-pixel line, like a MergIR parallax gap
    holed[100:103, 30:60] = np.nan                # 3 pixels wide
    holed[150:190, 150:190] = np.nan              # a 40-pixel block: a real gap
    out = C.fill_small_gaps(holed, passes=3)
    assert np.isfinite(out[50, 20:200]).all() and np.isfinite(out[100:103, 30:60]).all()
    assert np.abs(out[50, 20:200] - chip[50, 20:200]).max() < 1.0     # filled with sensible values
    assert np.isnan(out[165:175, 165:175]).all()                      # the core of the block is still missing
    assert np.isfinite(out[150:153, 150:190]).all()                   # only its 3-pixel rim was filled
    kept = np.isfinite(holed)
    assert np.array_equal(out[kept], holed[kept])                     # valid pixels are never touched
    assert np.array_equal(C.fill_small_gaps(chip), chip)              # nothing to do
    assert np.isnan(C.fill_small_gaps(np.full((8, 8), np.nan, np.float32))).all()
    assert np.isnan(holed[50, 100])                                   # input not modified
    # lines through the centre empty the innermost ring; filled, every ring is usable
    line_only = chip.copy(); line_only[112, :] = np.nan; line_only[:, 112] = np.nan
    assert C.polar_descriptor(line_only)[1] is False
    assert C.polar_descriptor(C.fill_small_gaps(line_only))[1] is True


def test_southern_hemisphere_mirror():
    bounds_n = {"south": 5.0, "north": 25.0, "west": 50.0, "east": 70.0}
    bounds_s = {"south": -25.0, "north": -5.0, "west": 50.0, "east": 70.0}
    lats = bounds_n["north"] - (np.arange(550) + 0.5) * 20.0 / 550
    lons = 50.0 + (np.arange(550) + 0.5) * 20.0 / 550
    la, lo = np.meshgrid(lats, lons, indexing="ij")
    # a cold blob poleward and east of the centre in the NH frame ...
    tb_n = (280.0 - 60.0 * np.exp(-(((la - 17.0) / 1.0) ** 2 + ((lo - 61.5) / 1.0) ** 2))).astype(np.float32)
    # ... and the mirror-image scene in the SH (rows reversed = latitude negated)
    tb_s = tb_n[::-1].copy()
    chip_n, info_n = C.cut_chip(tb_n, bounds_n, 15.0, 60.0)
    chip_s, info_s = C.cut_chip(tb_s, bounds_s, -15.0, 60.0)
    assert info_n["flipped"] is False and info_s["flipped"] is True
    assert np.nanmax(np.abs(chip_n - chip_s)) < 0.05          # same picture after the mirror
    r, c = np.unravel_index(np.nanargmin(chip_s), chip_s.shape)
    assert r < 112 and c > 112                                 # poleward shown at the top
    raw_geo = C.unflip(chip_s, True)
    r2, _ = np.unravel_index(np.nanargmin(raw_geo), raw_geo.shape)
    assert r2 > 112                                            # geographically it is to the south
    chip_noflip, info = C.cut_chip(tb_s, bounds_s, -15.0, 60.0, flip_sh=False)
    assert info["flipped"] is False and np.array_equal(chip_noflip, raw_geo, equal_nan=True)


# ── descriptor ───────────────────────────────────────────────────────────

def test_descriptor_recovers_amplitude_and_phase():
    xx, yy, rng, _ = C._chip_grid(C.CHIP_PX, C.CHIP_KM)
    th = np.arctan2(yy, xx)
    A, th0 = 14.0, np.radians(70.0)
    chip = (240.0 + 0.05 * rng + A * np.cos(th - th0) + 5.0 * np.cos(2 * (th - 0.3))).astype(np.float32)
    raw, ok = C.polar_descriptor(chip)
    assert ok and raw.shape == (C.RAW_DIM,) and np.isfinite(raw).all()
    a = C.harmonics(raw)                                        # [3, rings]
    outer = slice(None)
    assert np.allclose(2 * np.abs(a[0]), A, atol=1e-3)
    assert np.allclose(-np.angle(a[0]), th0, atol=1e-3)
    assert np.allclose(2 * np.abs(a[1]), 5.0, atol=1e-3)
    assert np.allclose(-np.angle(a[1]) / 2, 0.3, atol=1e-3)
    assert np.all(2 * np.abs(a[2]) < 1e-3)                      # no wavenumber 3 was put in: none leaks in
    ring_mid = (np.arange(C.N_RINGS) + 0.5) * C.RING_DR_KM
    assert np.allclose(raw[C._S_MEAN][outer], 240.0 + 0.05 * ring_mid[outer], atol=0.3)
    assert abs(raw[C._S_HIST].sum() - 1.0) < 1e-6


def test_orientation_modes_and_alignment():
    base = _synthetic_chip(0.0)
    raws = [C.polar_descriptor(_synthetic_chip(a))[0] for a in (0.0, 40.0, 135.0, 250.0)]
    other = C.polar_descriptor(_synthetic_chip(0.0, eye=False))[0]
    pool = np.stack(raws + [other] + [C.polar_descriptor(_random_storm(i))[0] for i in range(60)])
    sc = C.fit_scaler(pool)
    any_v = C.search_vectors(np.stack(raws + [other]), sc, "any")
    seen_v = C.search_vectors(np.stack(raws + [other]), sc, "seen")
    d_any = np.linalg.norm(any_v - any_v[0], axis=1)
    d_seen = np.linalg.norm(seen_v - seen_v[0], axis=1)
    # "any": every rotation of the same storm is (nearly) the same point, and
    # far closer than a storm that differs in structure (no eye)
    assert d_any[1:4].max() < 0.15 * d_any[4], d_any
    # "seen": a rotated copy is clearly different
    assert d_seen[1:4].min() > 5 * d_any[1:4].max(), (d_seen, d_any)
    # align_angle: rotating the match by the returned angle brings it onto the query
    for ang, raw in zip((40.0, 135.0, 250.0), raws[1:]):
        got = C.align_angle(raws[0], raw)                       # match is rotated +ang ccw
        want = (-ang) % 360.0
        assert min(abs(got - want), 360 - abs(got - want)) <= 3.0, (ang, got, want)
        back = C.polar_descriptor(_synthetic_chip(ang + got))[0]
        v = C.search_vectors(np.stack([raws[0], back]), sc, "seen")
        assert np.linalg.norm(v[0] - v[1]) < 0.2 * d_seen[1:4].min()
    assert base.shape == (C.CHIP_PX, C.CHIP_PX)


def test_descriptor_flags_missing_rings():
    chip = _synthetic_chip(0.0)
    ok_chip = chip.copy(); ok_chip[5:9, 5:9] = np.nan             # a corner outside every ring
    assert C.polar_descriptor(ok_chip)[1] is True
    speck = chip.copy(); speck[112, 60] = np.nan                  # one pixel: ring still has >80%
    raw, ok = C.polar_descriptor(speck)
    assert ok and np.isfinite(raw).all()
    wedge = chip.copy(); wedge[112:, 112:] = np.nan               # a missing quadrant
    raw, ok = C.polar_descriptor(wedge)
    assert ok is False and np.isnan(raw[C._S_MEAN]).any()
    raw, ok = C.polar_descriptor(np.full_like(chip, np.nan))
    assert ok is False and np.isnan(raw).all()


# ── scaling ──────────────────────────────────────────────────────────────

def test_any_distance_bounded_by_seen_and_block_weights():
    raws = np.stack([C.polar_descriptor(_random_storm(i))[0] for i in range(60)])
    sc = C.fit_scaler(raws)
    a = C.search_vectors(raws, sc, "any")
    s = C.search_vectors(raws, sc, "seen")
    assert a.shape == (60, 2 * C.N_RINGS + C.N_WAVE * C.N_RINGS + C.N_HIST)
    assert s.shape == (60, 2 * C.N_RINGS + 2 * C.N_WAVE * C.N_RINGS + C.N_HIST)
    da = np.linalg.norm(a[:, None] - a[None], axis=2)
    ds = np.linalg.norm(s[:, None] - s[None], axis=2)
    assert np.all(da <= ds + 1e-4)                               # | |a|-|b| | <= |a-b|
    # shared Re/Im scale, no centring on the harmonics
    for m in range(1, C.N_WAVE + 1):
        assert np.array_equal(sc["scale"][C._harm(m, 0)], sc["scale"][C._harm(m, 1)])
        assert not sc["center"][C._harm(m, 0)].any() and not sc["center"][C._harm(m, 1)].any()
    # with only the mean block switched on, distance is the z-scored profile distance
    only = C.search_vectors(raws, sc, "any", {"mean": 1.0, "spread": 0.0, "asym": 0.0, "hist": 0.0})
    z = (raws[:, C._S_MEAN] - sc["center"][C._S_MEAN]) / sc["scale"][C._S_MEAN]
    want = np.linalg.norm(z[0] - z[1]) / np.sqrt(C.N_RINGS)
    assert abs(np.linalg.norm(only[0] - only[1]) - want) < 1e-4
    try:
        C.search_vectors(raws, sc, "sideways")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown mode must raise")


# ── packing ──────────────────────────────────────────────────────────────

def test_int8_keeps_distances_and_pca_recovers_subspace():
    rng = np.random.default_rng(5)
    X = rng.normal(0, 1, (400, 64)).astype(np.float32) * np.linspace(2.0, 0.2, 64, dtype=np.float32)
    Xi, step = C.pack_int8(X)
    assert Xi.dtype == np.int8 and np.abs(Xi).max() <= 127
    d_f = np.linalg.norm(X[:50, None] - X[None, :], axis=2)
    d_i = np.linalg.norm(C.unpack_int8(Xi, step)[:50, None] - C.unpack_int8(Xi, step)[None, :], axis=2)
    assert np.corrcoef(d_f.ravel(), d_i.ravel())[0, 1] > 0.999
    # the nearest neighbour survives quantisation almost always
    np.fill_diagonal(d_f[:, :50], np.inf); np.fill_diagonal(d_i[:, :50], np.inf)
    assert (d_f.argmin(1) == d_i.argmin(1)).mean() > 0.9

    basis = np.linalg.qr(rng.normal(size=(40, 6)))[0]              # a 6-D subspace of 40-D
    Y = (rng.normal(size=(500, 6)) * [9, 7, 5, 4, 3, 2]) @ basis.T + 3.0 + rng.normal(0, 0.01, (500, 40))
    pca = C.fit_pca(Y, 6)
    assert pca["components"].shape == (6, 40) and pca["explained"] > 0.999
    Z = C.apply_pca(Y, pca)
    recon = Z @ pca["components"] + pca["mean"]
    assert np.abs(recon - Y).max() < 0.1
    d_y = np.linalg.norm(Y[:30, None] - Y[None, :30], axis=2)
    d_z = np.linalg.norm(Z[:30, None] - Z[None, :30], axis=2)
    assert np.allclose(d_y, d_z, atol=0.1)


# ── search ───────────────────────────────────────────────────────────────

def _brute(q, X, storm, k, exclude=None, mask=None):
    d = np.linalg.norm(X.astype(np.float64) - q.astype(np.float64), axis=1)
    if mask is not None:
        d[~mask] = np.inf
    if exclude is not None:
        d[storm == exclude] = np.inf
    out = []
    for i in np.argsort(d, kind="stable"):
        if not np.isfinite(d[i]):
            break
        if storm[i] in {storm[j] for j in out}:
            continue
        out.append(i)
        if len(out) == k:
            break
    return out, d


def test_search_matches_brute_force_one_per_storm():
    rng = np.random.default_rng(7)
    lens = rng.integers(1, 40, 120)
    storm = np.repeat(np.arange(120), lens)
    N = len(storm)
    # frames of a storm cluster together, so a naive top-k would be all one storm
    centres = rng.normal(0, 1, (120, 24))
    X = (centres[storm] + rng.normal(0, 0.15, (N, 24))).astype(np.float32)
    starts = C.storm_segments(storm)
    assert len(starts) == 120 and starts[0] == 0

    qi = rng.choice(N, 25, replace=False)
    rows, dist = C.search(X[qi], X, starts, k=15, exclude_storm=storm[qi])
    assert rows.shape == (25, 15) and dist.shape == (25, 15)
    for b, i in enumerate(qi):
        want, d = _brute(X[i], X, storm, 15, exclude=storm[i])
        assert rows[b].tolist() == want, (b, rows[b].tolist(), want)
        assert np.allclose(dist[b], d[want], atol=2e-3)
        assert len(set(storm[rows[b]])) == 15                    # one match per storm
        assert storm[i] not in storm[rows[b]]                    # never its own storm
        assert np.all(np.diff(dist[b]) >= 0)                     # best first

    # without the exclusion the top match is the query frame itself
    rows0, dist0 = C.search(X[qi], X, starts, k=3)
    assert np.array_equal(rows0[:, 0], qi) and np.all(dist0[:, 0] < 1e-2)

    # row mask: only even storms may match
    mask = storm % 2 == 0
    rows_m, _ = C.search(X[qi[:5]], X, starts, k=10, exclude_storm=storm[qi[:5]], row_mask=mask)
    for b, i in enumerate(qi[:5]):
        want, _ = _brute(X[i], X, storm, 10, exclude=storm[i], mask=mask)
        assert rows_m[b].tolist() == want
        assert np.all(storm[rows_m[b]] % 2 == 0)

    # asking for more storms than exist pads with -1 / inf
    few = storm < 4
    rows_f, dist_f = C.search(X[qi[:2]], X, starts, k=10, row_mask=few)
    assert np.all((rows_f >= 0).sum(1) == 4) and np.all(rows_f[:, 4:] == -1) and np.all(np.isinf(dist_f[:, 4:]))
    rows_n, dist_n = C.search(X[qi[:2]], X, starts, k=5, row_mask=np.zeros(N, bool))
    assert np.all(rows_n == -1) and np.all(np.isinf(dist_n))

    # precomputed norms give the same answer
    rows_p, _ = C.search(X[qi], X, starts, k=15, exclude_storm=storm[qi], x_sq=(X * X).sum(1))
    assert np.array_equal(rows_p, rows)


def test_storm_segments_requires_grouping():
    assert C.storm_segments(np.array([5, 5, 2, 2, 2, 9])).tolist() == [0, 2, 5]
    for bad in (np.array([1, 1, 2, 1]), np.array([], dtype=int)):
        try:
            C.storm_segments(bad)
        except ValueError:
            continue
        raise AssertionError("ungrouped or empty rows must raise")


def test_closeness_table():
    d = np.linspace(1.0, 3.0, 2001)
    table = C.fit_closeness(np.append(d, np.inf))
    assert table.shape == (101,) and abs(table[50] - 2.0) < 1e-3
    assert C.closeness_percentile(0.5, table) == 0
    assert 48 <= C.closeness_percentile(2.0, table) <= 52
    assert C.closeness_percentile(9.0, table) == 100


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok    {name}")
        except Exception:
            failed += 1
            import traceback
            print(f"FAIL  {name}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
