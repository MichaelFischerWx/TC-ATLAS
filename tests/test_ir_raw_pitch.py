"""Guards the IR raw-Tb reprojection pitch (perf/raw-tb-ir-pitch).

The raw-Tb IR path was oversampling: native GOES/Himawari Band-13 IR is 2 km
≈ 0.018°, so the legacy 0.013° reproject pitch synthesized ~45-48% more pixels
than the sensor actually resolves (SSIM=1.0 to native truth). We coarsen ONLY
the IR Tb path to _IR_RAW_RES_DEG (0.018°) to cut egress/storage with zero
visible degradation.

CRITICAL: the same _reproject_geos_to_latlon helper serves the VISIBLE band
(0.5 km native, already undersampled at 0.013°) via fetch_band_raw. Coarsening
that would visibly degrade cumulus texture. So fetch_band_raw MUST keep the
finer 0.013° default. These tests lock in both halves of that invariant.

No network / GDAL: we monkeypatch the file-finding + subset openers and the
reproject helper itself, capturing the res_deg kwarg it is called with.

Run: python3 tests/test_ir_raw_pitch.py
"""
import os
import sys
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import satellite_ir as S


# --------------------------------------------------------------------------
# Test harness: stub the GOES path so fetch_ir_tb_raw / fetch_band_raw run end
# to end without touching S3 or GDAL, and capture the reproject res_deg kwarg.
# --------------------------------------------------------------------------
class _ReprojectSpy:
    """Records the res_deg every _reproject_geos_to_latlon call receives."""
    def __init__(self):
        self.res_degs = []

    def __call__(self, tb_geo, center_lat, center_lon, box_deg,
                 sat_height, lon_0, sweep, res_deg=0.013, geos_extent=None):
        self.res_degs.append(res_deg)
        # Return a grid sized exactly as the real helper would, so dimension
        # sanity checks are meaningful.
        n = int(box_deg / res_deg)
        return np.full((n, n), 250.0, dtype=np.float32)


def _install_goes_stubs(monkeypatch_attrs):
    """Force the GOES branch and stub its I/O. Returns a teardown dict of
    original attributes (caller restores)."""
    saved = {}

    def _save(name):
        saved[name] = getattr(S, name)

    for name in ("select_goes_sat", "find_goes_file", "open_goes_subset",
                 "_scan_substitution_too_stale", "satellite_name_from_bucket"):
        _save(name)

    # Force GOES (not himawari) so we exercise the GOES reproject site.
    S.select_goes_sat = lambda lon, dt: ("goes-east-bucket", "goes16")
    S.find_goes_file = lambda bucket, dt, band=13, return_dt=True: (
        "fake_key.nc", dt)
    S._scan_substitution_too_stale = lambda scan_dt, target_dt, m: False
    S.satellite_name_from_bucket = lambda bucket: "GOES-16"

    def _fake_open_goes_subset(s3_key, lat, lon, sat_key, box_deg,
                               band=13, return_extent=False):
        geo = np.full((100, 100), 250.0, dtype=np.float32)
        gm = {"sat_height": 35786023.0, "lon_0": -75.0, "sweep": "x",
              "extent": (-1e6, -1e6, 1e6, 1e6)}
        if return_extent:
            return geo, gm
        return geo

    S.open_goes_subset = _fake_open_goes_subset

    for k, v in monkeypatch_attrs.items():
        _save(k)
        setattr(S, k, v)

    return saved


def _restore(saved):
    for k, v in saved.items():
        setattr(S, k, v)


def _run_with_stubs(extra_attrs, fn):
    saved = _install_goes_stubs(extra_attrs)
    try:
        return fn()
    finally:
        _restore(saved)


_DT = datetime(2024, 9, 26, 18, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# Test 1: fetch_ir_tb_raw reprojects at 0.018° (native Band-13 pitch).
# --------------------------------------------------------------------------
def test_ir_tb_raw_uses_018():
    spy = _ReprojectSpy()
    out = _run_with_stubs(
        {"_reproject_geos_to_latlon": spy},
        lambda: S.fetch_ir_tb_raw(25.0, -75.0, _DT, box_deg=20.0),
    )
    assert out is not None, "fetch_ir_tb_raw returned None under stubs"
    assert spy.res_degs, "reproject was never called"
    assert all(r == S._IR_RAW_RES_DEG for r in spy.res_degs), (
        f"IR raw path must reproject at _IR_RAW_RES_DEG; got {spy.res_degs}")
    assert spy.res_degs[-1] == 0.018, (
        f"expected 0.018 IR pitch, got {spy.res_degs[-1]}")
    print(f"  [1] fetch_ir_tb_raw res_deg={spy.res_degs[-1]} OK")


# --------------------------------------------------------------------------
# Test 2: fetch_band_raw (visible/WV) keeps the finer 0.013° default.
# This guards the quality constraint — the 0.5km visible band must NOT be
# coarsened to 0.018°.
# --------------------------------------------------------------------------
def test_band_raw_keeps_013():
    spy = _ReprojectSpy()
    # Visible band (2) — the sensitive 0.5 km case.
    out = _run_with_stubs(
        {"_reproject_geos_to_latlon": spy},
        lambda: S.fetch_band_raw(25.0, -75.0, _DT, box_deg=20.0,
                                 band=S.VIS_BAND),
    )
    assert out is not None, "fetch_band_raw returned None under stubs"
    assert spy.res_degs, "reproject was never called"
    assert all(r == 0.013 for r in spy.res_degs), (
        f"visible/WV path must stay at finer 0.013°; got {spy.res_degs}")
    assert all(r != S._IR_RAW_RES_DEG for r in spy.res_degs), (
        "visible band must NOT use the coarse IR raw pitch")
    print(f"  [2] fetch_band_raw (visible) res_deg={spy.res_degs[-1]} OK")


# --------------------------------------------------------------------------
# Test 3: dimension sanity — a 20° box at 0.018° → ~1111×1111 grid.
# --------------------------------------------------------------------------
def test_grid_dims_at_018():
    # The spy reproject sizes its output with the SAME formula the real helper
    # uses, n = int(box_deg / res_deg), so the emitted grid is the genuine
    # 0.018° dimensions without needing pyproj-consistent fake extents.
    spy = _ReprojectSpy()
    out = _run_with_stubs(
        {"_reproject_geos_to_latlon": spy},
        lambda: S.fetch_ir_tb_raw(25.0, -75.0, _DT, box_deg=20.0),
    )
    assert out is not None, "fetch_ir_tb_raw returned None"
    rows, cols = out["tb"].shape
    expected = int(20.0 / 0.018)  # == 1111
    assert rows == expected and cols == expected, (
        f"expected {expected}x{expected} at 0.018° for a 20° box, "
        f"got {rows}x{cols}")
    assert 1100 <= rows <= 1120, f"grid {rows} not ~1111 as expected"
    print(f"  [3] 20° box @0.018° -> {rows}x{cols} (expected {expected}) OK")


if __name__ == "__main__":
    test_ir_tb_raw_uses_018()
    test_band_raw_keeps_013()
    test_grid_dims_at_018()
    print("\nAll IR raw-pitch tests passed.")
