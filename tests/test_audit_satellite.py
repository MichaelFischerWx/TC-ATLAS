"""Regression tests for the Oct 20 audit satellite_ir.py fixes.

  * S9 / SAT-4: Himawari segments are placed by absolute index; a missing or
    failed needed segment returns None instead of a row-shifted frame.
  * S10 / SAT-12: reprojection does not smear a 0 K fill into gap edges;
    HSD error / outside-scan sentinels are masked.
  * SAT-13: scan finders pick the minimum |dt| (incl. GOES next-hour prefix),
    ties go to the earlier scan.
  * JOB-14: a partly posted Himawari scan is skipped for the earlier complete
    one (full disk needs all 10 segments; storm boxes need their segments).
  * SAT-10: Meteosat-gap storms return None before any S3 call.

No network. Run: python3 tests/test_audit_satellite.py  (or pytest)
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import satellite_ir as S  # noqa: E402


class _MP:
    def __init__(self):
        self._undo = []

    def setattr(self, obj, name, value):
        self._undo.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def undo(self):
        for obj, name, val in reversed(self._undo):
            setattr(obj, name, val)
        self._undo.clear()


def _hima_files(prefix, hhmm_date, segs, band=13):
    return [f"{prefix}HS_H09_{hhmm_date}_B{band:02d}_FLDK_R20_S{s:02d}10.DAT.bz2"
            for s in segs]


def _hima_prefix(dt):
    return (f"{S.HIMAWARI_BUCKET}/{S.HIMAWARI_L1B_PRODUCT}/"
            f"{dt:%Y/%m/%d/%H%M}/")


def _install_listing(mp, listing):
    def fake_ls(fs, prefix, detail=False):
        if prefix not in listing:
            raise FileNotFoundError(prefix)
        return listing[prefix]
    mp.setattr(S, "_cached_fs_ls", fake_ls)
    mp.setattr(S, "get_goes_fs", lambda: object())


# ---------------------------------------------------------------- S9 / SAT-4
def _install_segments(mp, prefix, segs, fail=()):
    """Serve fake segments through the seg-cache: segment k's counts == k.
    Segments in `fail` raise in the count conversion (simulating a corrupt
    download)."""
    nl, nc = S.HIMAWARI_NLINES_PER_SEG, S.HIMAWARI_NCOLS
    _install_listing(mp, {prefix: _hima_files(prefix, "20260101_0000", segs)})
    mp.setattr(S, "HIMAWARI_SEG_CACHE", True)
    S.himawari_seg_cache_clear()
    hdr = {"n_lines": nl, "n_columns": nc}
    store = {}
    for k in segs:
        store[(prefix, 13, k)] = (hdr, np.full((nl, nc), k, dtype=np.uint16))

    def fake_get(key):
        return store.get(key)
    mp.setattr(S, "_seg_cache_get", fake_get)
    mp.setattr(S, "_seg_cache_put", lambda *a, **k: None)

    def fake_tbb(counts, h):
        k = int(counts.flat[0])
        if k in fail:
            raise ValueError("corrupt segment")
        return counts.astype(np.float32)
    mp.setattr(S, "_hsd_counts_to_tbb", fake_tbb)


def test_himawari_segments_placed_by_absolute_row():
    mp = _MP()
    prefix = "noaa-himawari9/AHI-L1b-FLDK/2026/01/01/0000/"
    try:
        lat, box = 20.0, 20.0
        need = S._himawari_seg_for_lat(lat, box)
        assert len(need) >= 2, need
        _install_segments(mp, prefix, need)
        sub, ext = S.open_himawari_subset(prefix, lat, 140.7, box,
                                          return_extent=True)
        assert sub is not None and ext is not None
        # Each subset row must hold the segment its absolute row belongs to.
        res = 2000.0
        loff = S.HIMAWARI_NLINES_PER_SEG * S.HIMAWARI_N_SEGMENTS / 2.0
        r_top = int(round(loff - ext[2] / res))
        rows = np.arange(sub.shape[0]) + r_top
        expect = rows // S.HIMAWARI_NLINES_PER_SEG + 1
        np.testing.assert_array_equal(sub[:, sub.shape[1] // 2], expect)
    finally:
        mp.undo()
        S.himawari_seg_cache_clear()


def test_himawari_failed_segment_returns_none():
    mp = _MP()
    prefix = "noaa-himawari9/AHI-L1b-FLDK/2026/01/01/0000/"
    try:
        lat, box = 20.0, 20.0
        need = S._himawari_seg_for_lat(lat, box)
        _install_segments(mp, prefix, need, fail=(need[len(need) // 2],))
        assert S.open_himawari_subset(prefix, lat, 140.7, box,
                                      return_extent=True) == (None, None)
        assert S.open_himawari_subset(prefix, lat, 140.7, box) is None
    finally:
        mp.undo()
        S.himawari_seg_cache_clear()


def test_himawari_missing_needed_segment_returns_none():
    mp = _MP()
    prefix = "noaa-himawari9/AHI-L1b-FLDK/2026/01/01/0000/"
    try:
        lat, box = 20.0, 20.0
        need = S._himawari_seg_for_lat(lat, box)
        posted = [s for s in need if s != need[-1]]
        _install_segments(mp, prefix, posted)
        assert S.open_himawari_subset(prefix, lat, 140.7, box,
                                      return_extent=True) == (None, None)
    finally:
        mp.undo()
        S.himawari_seg_cache_clear()


# ------------------------------------------------------- SAT-13 + JOB-14 (Hima)
_T0 = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


def _listing_for(scans):
    """scans: {datetime: [segments]}"""
    out = {}
    for dt, segs in scans.items():
        p = _hima_prefix(dt)
        out[p] = _hima_files(p, dt.strftime("%Y%m%d_%H%M"), segs)
    return out


def test_himawari_nearest_scan_not_floor():
    mp = _MP()
    try:
        full = list(range(1, 11))
        _install_listing(mp, _listing_for({_T0: full,
                                           _T0 + timedelta(minutes=10): full}))
        _, dt = S.find_himawari_file(_T0 + timedelta(minutes=9), return_dt=True)
        assert dt == _T0 + timedelta(minutes=10), dt
        # 12:05 is equidistant → the earlier scan
        _, dt = S.find_himawari_file(_T0 + timedelta(minutes=5), return_dt=True)
        assert dt == _T0, dt
    finally:
        mp.undo()


def test_himawari_partial_scan_skipped_for_earlier_complete():
    mp = _MP()
    try:
        full = list(range(1, 11))
        _install_listing(mp, _listing_for({
            _T0 - timedelta(minutes=10): full,
            _T0: [1, 2, 3, 4, 5],            # still posting
        }))
        # full-disk (default) requires all 10 → falls back to 11:50
        _, dt = S.find_himawari_file(_T0, return_dt=True)
        assert dt == _T0 - timedelta(minutes=10), dt
        # a northern storm box only needs segments 2-3 → the 12:00 scan is fine
        _, dt = S.find_himawari_file(_T0, return_dt=True, segments=[2, 3])
        assert dt == _T0, dt
        # a southern box needs 7-8 → 11:50
        _, dt = S.find_himawari_file(_T0, return_dt=True, segments=[7, 8])
        assert dt == _T0 - timedelta(minutes=10), dt
    finally:
        mp.undo()


def test_himawari_exact_slot_still_first_for_animation():
    """Animation slots sit on the 10-min grid: the exact slot wins and the
    returned scan time equals the slot (cache keys / 7-min guard unchanged)."""
    mp = _MP()
    try:
        full = list(range(1, 11))
        _install_listing(mp, _listing_for({_T0 + timedelta(minutes=m): full
                                           for m in (-10, 0, 10)}))
        _, dt = S.find_himawari_file(_T0, return_dt=True)
        assert dt == _T0
    finally:
        mp.undo()


# ----------------------------------------------------------------- SAT-13 (GOES)
def _goes_key(bucket, dt, band=13):
    jd = dt.timetuple().tm_yday
    return (f"{bucket}/{S.IR_PRODUCT}/{dt.year}/{jd:03d}/{dt.hour:02d}/"
            f"OR_ABI-L2-CMIPF-M6C{band:02d}_G19_s{dt.year}{jd:03d}"
            f"{dt:%H%M%S}0_e0_c0.nc")


def _goes_listing(bucket, scan_dts):
    out = {}
    for dt in scan_dts:
        jd = dt.timetuple().tm_yday
        p = f"{bucket}/{S.IR_PRODUCT}/{dt.year}/{jd:03d}/{dt.hour:02d}/"
        out.setdefault(p, []).append(_goes_key(bucket, dt))
    return out


def test_goes_next_hour_prefix_considered():
    mp = _MP()
    b = "noaa-goes19"
    try:
        scans = [_T0 + timedelta(minutes=m, seconds=20) for m in (40, 50, 60, 70)]
        _install_listing(mp, _goes_listing(b, scans))
        key, dt = S.find_goes_file(b, _T0 + timedelta(minutes=58), return_dt=True)
        assert dt == _T0 + timedelta(minutes=60, seconds=20), dt
        # previous-hour fallback still works at the top of the hour
        _install_listing(mp, _goes_listing(b, scans[:2]))
        key, dt = S.find_goes_file(b, _T0 + timedelta(minutes=60), return_dt=True)
        assert dt == _T0 + timedelta(minutes=50, seconds=20), dt
        # slot on the 10-min grid → the ~20 s-offset scan for that slot
        _install_listing(mp, _goes_listing(b, scans))
        key, dt = S.find_goes_file(b, _T0 + timedelta(minutes=50), return_dt=True)
        assert dt == _T0 + timedelta(minutes=50, seconds=20), dt
    finally:
        mp.undo()


# ------------------------------------------------------------------ S10 / SAT-12
def _geos_extent_for(lat, lon, box):
    import pyproj
    p = pyproj.Proj(proj="geos", h=S.HIMAWARI_SAT_HEIGHT,
                    lon_0=S.HIMAWARI_LON_0, sweep=S.HIMAWARI_SWEEP)
    h = box / 2.0 + 1.0
    xs, ys = [], []
    for la in (lat - h, lat + h):
        for lo in (lon - h, lon + h):
            x, y = p(lo, la)
            xs.append(x); ys.append(y)
    return (min(xs), max(xs), max(ys), min(ys))


def test_reproject_gap_has_no_cold_fringe():
    lat, lon, box = 15.0, 140.7, 6.0
    ext = _geos_extent_for(lat, lon, box)
    geo = np.full((400, 400), 280.0, dtype=np.float32)
    geo[150:250, 150:250] = np.nan            # a data gap
    out = S._reproject_geos_to_latlon(
        geo, lat, lon, box, S.HIMAWARI_SAT_HEIGHT, S.HIMAWARI_LON_0,
        S.HIMAWARI_SWEEP, res_deg=0.02, geos_extent=ext)
    fin = out[np.isfinite(out)]
    assert np.isnan(out).any(), "gap vanished"
    assert fin.size > 0.7 * out.size
    assert np.allclose(fin, 280.0, atol=1e-3), (fin.min(), fin.max())


def test_reproject_all_finite_unchanged():
    lat, lon, box = 15.0, 140.7, 6.0
    ext = _geos_extent_for(lat, lon, box)
    rng = np.random.default_rng(0)
    geo = (250 + 30 * rng.random((300, 300))).astype(np.float32)
    out = S._reproject_geos_to_latlon(
        geo, lat, lon, box, S.HIMAWARI_SAT_HEIGHT, S.HIMAWARI_LON_0,
        S.HIMAWARI_SWEEP, res_deg=0.05, geos_extent=ext)
    assert np.isfinite(out).all()
    assert 250 <= out.min() and out.max() <= 280


def test_hsd_sentinels_masked():
    hdr = {"gain": 0.001, "offset": 0.0, "central_wavelength": 0.64,
           "valid_bits": 11, "count_error": 65535, "count_outside": 65534}
    c = np.array([300, 2047, 2048, 65534, 65535, 0], dtype=np.uint16)
    refl = S._hsd_counts_to_reflectance(c, hdr)
    assert np.isfinite(refl[:2]).all()
    assert np.isnan(refl[2:]).all(), refl
    v = S._hsd_valid_counts(c, {"valid_bits": 12, "count_error": 65535,
                                "count_outside": 65534})
    assert v.tolist() == [True, True, True, False, False, False]


def test_hsd_header_parses_sentinels():
    import struct
    # Minimal fake HSD: blocks 1-4 of length 10, block 5 with the fields.
    buf = bytearray(400)
    for i, start in enumerate((0, 10, 20, 30)):
        buf[start] = i + 1
        struct.pack_into("<H", buf, start + 1, 10)
    b5 = 40
    buf[b5] = 5
    struct.pack_into("<HHH", buf, b5 + 13, 12, 65535, 65534)
    struct.pack_into("<I", buf, 70, 0)  # overlaps nothing important here
    h = S._parse_hsd_header(bytes(buf))
    assert (h["valid_bits"], h["count_error"], h["count_outside"]) == (12, 65535, 65534)


# ---------------------------------------------------------------------- SAT-10
def test_meteosat_gap_visibility():
    assert S.beyond_usable_view(-15.0, 50.0, "himawari")     # SWIO
    assert S.beyond_usable_view(-20.0, 40.0, "himawari")     # Mozambique Ch.
    assert S.beyond_usable_view(15.0, 65.0, "himawari")      # Arabian Sea W
    assert S.beyond_usable_view(10.0, 5.0, "east")           # past GOES-E limb
    assert not S.beyond_usable_view(15.0, 88.0, "himawari")  # Bay of Bengal
    assert not S.beyond_usable_view(15.0, 75.0, "himawari")  # mosaic edge
    assert not S.beyond_usable_view(15.0, -5.0, "east")      # mosaic edge
    assert not S.beyond_usable_view(15.0, -30.0, "east")
    assert not S.beyond_usable_view(20.0, -178.0, "west")
    assert not S.beyond_usable_view(20.0, 179.0, "himawari")
    assert not S.beyond_usable_view(20.0, 50.0, "goes16")    # unknown key


def test_gap_storm_returns_none_without_s3():
    mp = _MP()
    try:
        calls = []

        def boom(*a, **k):
            calls.append(a)
            raise AssertionError("S3 touched for a gap storm")
        for name in ("find_himawari_file", "find_goes_file",
                     "open_himawari_subset", "open_goes_subset", "get_goes_fs"):
            mp.setattr(S, name, boom)
        dt = datetime(2026, 2, 1, 6, 0, tzinfo=timezone.utc)
        assert S.fetch_ir_tb_raw(-15.0, 50.0, dt, box_deg=20.0) is None
        assert S.fetch_band_raw(-15.0, 50.0, dt, box_deg=20.0, band=8) is None
        assert S.fetch_ir_frame(-15.0, 50.0, dt, box_deg=20.0) is None
        assert S.fetch_ir_tb_raw(12.0, 5.0, dt, box_deg=20.0) is None
        assert not calls, f"{len(calls)} S3-path call(s) for gap storms"
    finally:
        mp.undo()


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"{len(fns)} passed")
