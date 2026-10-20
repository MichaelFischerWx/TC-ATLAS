#!/usr/bin/env python3
"""Regression tests for the science-batch-B audit fixes (no network, no GCS).

Covers:
  S3 / SCI-3  pipeline/refresh_ibtracs.py
              - 24-h intensity-change windows need dist2land > 0 at BOTH ends
              - spur tracks skipped; main + PROVISIONAL / US-PROVISIONAL kept
              - per-storm ri_24h / rw_24h use exactly the histogram's windows
                (synoptic hours, TC phase, overwater)
              - nature filter = TS/SS (+ NR on provisional tracks); MX/ET/DS out
  S18         build_oisst_history.py
              - tropical-mean SST = cos-lat mean over 30S-30N, ALL longitudes
                (the env sst_rel definition), never the 100-360E crop
              - daily-derived / preliminary month rows use it; the regional
                grid stays cropped
              - daily-indices resume guard rejects pre-v2 parquets

Runnable standalone:  python3 tests/test_audit_science_b.py
"""
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import numpy as np
import xarray as xr

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (_REPO_ROOT, os.path.join(_REPO_ROOT, "pipeline")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import refresh_ibtracs as R  # noqa: E402
import build_oisst_history as B  # noqa: E402


# ───────────────────────────── S3 ─────────────────────────────

def _series(winds, overwater, start="2020-09-01T00:00", step_h=6):
    t0 = datetime.fromisoformat(start)
    return [(t0 + timedelta(hours=step_h * k), float(w), bool(o))
            for k, (w, o) in enumerate(zip(winds, overwater))]


def test_episodes_require_overwater_both_ends():
    # 9 synoptic fixes = 5 24-h windows (k -> k+4).
    winds = [30, 40, 50, 60, 70, 80, 90, 100, 110]
    ow = [True] * 9
    assert R.episodes_24h(_series(winds, ow)) == [40.0] * 5
    # Fix 6 over land kills the windows that START (2->6) or END (6->...) there.
    ow2 = list(ow)
    ow2[6] = False
    eps = R.episodes_24h(_series(winds, ow2))
    assert len(eps) == 4          # windows 0->4, 1->5, 3->7, 4->8
    ow3 = list(ow)
    ow3[0] = False
    ow3[8] = False
    assert len(R.episodes_24h(_series(winds, ow3))) == 3


def test_episodes_min_fixes_and_window():
    assert R.episodes_24h(_series([30, 40, 50, 60], [True] * 4)) == []
    # 12-hourly fixes: 24 h apart pairs only (dh 12 and 36 excluded).
    eps = R.episodes_24h(_series([30, 40, 50, 60, 70], [True] * 5, step_h=12))
    assert eps == [20.0, 20.0, 20.0]


def test_track_type_and_nature_filters():
    assert R.is_main_track("main")
    assert R.is_main_track("PROVISIONAL")
    assert R.is_main_track("US-PROVISIONAL")
    for spur in ("spur-split", "spur-merge", "spur-other"):
        assert not R.is_main_track(spur)
    assert R.TC_NATURES == {"TS", "SS"}
    for n in ("TS", "SS"):
        assert R.is_tc_phase(n, False)
    for n in ("ET", "DS", "MX", "NR"):
        assert not R.is_tc_phase(n, False)
    assert R.is_tc_phase("NR", True)          # provisional: no nature yet
    assert not R.is_tc_phase("ET", True)
    assert not R.is_tc_phase("MX", True)


def _write_synthetic_ibtracs(path):
    """Four storms: a main storm whose RI window ends over land, its spur,
    a provisional NR-only storm, and a main storm with MX/ET phases."""
    ntime = 12
    t0 = datetime(2020, 9, 1)
    iso = np.full((4, ntime), b"", dtype="S19")
    lat = np.full((4, ntime), np.nan)
    lon = np.full((4, ntime), np.nan)
    wind = np.full((4, ntime), np.nan)
    d2l = np.full((4, ntime), np.nan)
    nature = np.full((4, ntime), b"", dtype="S2")
    for i in range(4):
        for j in range(ntime):
            # 6-hourly with a 03Z interpolated-style fix inserted at j=1.
            hrs = [0, 3, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60][j]
            iso[i, j] = (t0 + timedelta(hours=hrs)).strftime("%Y-%m-%d %H:%M:%S").encode()
            lat[i, j] = 15.0 + 0.2 * j
            lon[i, j] = -60.0 - 0.5 * j
            d2l[i, j] = 300.0
            nature[i, j] = b"TS"
    # Storm 0: +40 kt 00Z->24Z, but 24Z (j=5) is over land; a 03Z fix has an
    # extreme value the old all-fix per-storm RI would have used.
    wind[0] = [40, 120, 45, 50, 60, 80, 85, 85, 80, 75, 70, 65]
    d2l[0, 5] = 0.0
    # Storm 1: spur copy of storm 0 (must vanish entirely).
    wind[1] = wind[0]
    # Storm 2: provisional, nature NR throughout.
    wind[2] = [35, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85]
    nature[2, :] = b"NR"
    # Storm 3: MX then ET — no TC-phase fixes beyond j<4.
    wind[3] = [40, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130]
    nature[3, 4:8] = b"MX"
    nature[3, 8:] = b"ET"
    ds = xr.Dataset(
        {
            "sid": (("storm",), np.array([b"2020245N15300", b"2020245N15301",
                                          b"2020245N15302", b"2020245N15303"], dtype="S13")),
            "name": (("storm",), np.array([b"AAA", b"AAA", b"BBB", b"CCC"], dtype="S8")),
            "season": (("storm",), np.array([2020, 2020, 2020, 2020], dtype=np.float32)),
            "track_type": (("storm",), np.array([b"main", b"spur-split", b"PROVISIONAL",
                                                 b"main"], dtype="S14")),
            "basin": (("storm", "date_time"), np.full((4, ntime), b"NA", dtype="S2")),
            "nature": (("storm", "date_time"), nature),
            "iso_time": (("storm", "date_time"), iso),
            "lat": (("storm", "date_time"), lat),
            "lon": (("storm", "date_time"), lon),
            "dist2land": (("storm", "date_time"), d2l),
            "usa_wind": (("storm", "date_time"), wind),
        })
    ds.to_netcdf(path)


def test_parse_synthetic_ibtracs():
    with tempfile.TemporaryDirectory() as td:
        nc = Path(td) / "ib.nc"
        _write_synthetic_ibtracs(nc)
        tracks, storms, radii, eps = R.parse(nc, None)
    by = {s["sid"]: s for s in storms}
    assert "2020245N15301" not in by and "2020245N15301" not in tracks   # spur
    assert set(by) == {"2020245N15300", "2020245N15302", "2020245N15303"}
    s0 = by["2020245N15300"]
    # Synoptic TC fixes j=0,2..11 (03Z dropped). 24-h windows whose ends
    # are both over water: 06->30, 12->36, 18->42, 30->54, 36->60 (00->24
    # and 24->48 touch the land fix at 24Z).
    assert sorted(eps["2020245N15300"]) == sorted([40.0, 35.0, 20.0, -15.0, -20.0])
    assert s0["ri_24h"] == 40.0 and s0["rw_24h"] == -20.0
    # Provisional NR storm counts as TC phase: ACE + episodes present.
    s2 = by["2020245N15302"]
    assert s2["ace"] > 0 and s2["ri_24h"] is not None
    # MX/ET storm: only 3 synoptic TC-phase fixes (j=0,2,3) -> < 5 -> none.
    assert eps["2020245N15303"] == [] and by["2020245N15303"]["ri_24h"] is None
    ic = R.compute_intensity_changes(eps, by)
    assert ic["total_episodes"] == sum(len(v) for v in eps.values())
    assert sorted(d for d, _ in ic["basins"]["NA"]) == sorted(
        int(round(d)) for v in eps.values() for d in v)


def test_committed_intensity_changes_consistent():
    """Committed outputs carry the new filter description and no spur SIDs
    in the TDR subset (cheap file-level checks)."""
    import json
    ic_path = Path(_REPO_ROOT) / "intensity_changes.json"
    st_path = Path(_REPO_ROOT) / "ibtracs_storms.json"
    if not ic_path.exists() or not st_path.exists():
        return
    ic = json.loads(ic_path.read_text())
    assert "dist2land > 0" in ic["description"]
    assert ic["total_episodes"] == sum(len(v) for v in ic["basins"].values())
    meta = json.loads(st_path.read_text())["metadata"]
    assert meta.get("track_types") == "main+provisional"


# ───────────────────────────── S18 ─────────────────────────────

def _grid(dlat=2.0, dlon=2.0):
    lat = np.arange(-60 + dlat / 2, 60, dlat)
    lon = np.arange(dlon / 2, 360, dlon)
    return lat, lon


def test_tropical_mean_uses_all_longitudes_coslat():
    lat, lon = _grid()
    field = np.full((lat.size, lon.size), 28.0)
    field[:, lon < 100] = 20.0                   # outside the old crop
    field[np.abs(lat) > 30, :] = 5.0             # outside the band
    got = B.tropical_mean_sst(field, lat, lon)
    band = np.abs(lat) <= 30
    w = np.cos(np.deg2rad(lat[band]))[:, None] * np.ones((1, lon.size))
    want = (field[band] * w).sum() / w.sum()
    assert abs(got - want) < 1e-9
    assert got < 27.0                            # 0-100E really counted
    # NaN (land) cells are excluded from the weights.
    f2 = field.copy()
    f2[band.nonzero()[0][0], :10] = np.nan
    assert np.isfinite(B.tropical_mean_sst(f2, lat, lon))
    # A lon crop is refused.
    crop = lon >= 100
    try:
        B.tropical_mean_sst(field[:, crop], lat, lon[crop])
    except ValueError:
        pass
    else:
        raise AssertionError("cropped longitudes accepted")
    # OISST 0.25 deg grid passes the guard.
    B._assert_full_lon(np.arange(0.125, 360, 0.25))


def _daily_ds(times, lat, lon, west_val=20.0, east_val=28.0):
    vals = np.full((len(times), lat.size, lon.size), east_val, dtype=np.float32)
    vals[:, :, lon < 100] = west_val
    return xr.Dataset({"sst": (("time", "lat", "lon"), vals)},
                      coords={"time": times, "lat": lat, "lon": lon})


def test_completed_month_rows_use_full_lon_trop_mean():
    lat, lon = _grid()
    times = np.array([np.datetime64(f"2025-02-{d:02d}") for d in range(1, 29)])
    ds = _daily_ds(times, lat, lon)
    crop_lon = lon[(lon >= B.LON_MIN) & (lon <= B.LON_MAX)]
    clim = xr.DataArray(np.full((12, lat.size, crop_lon.size), 27.0, np.float32),
                        dims=("month", "lat", "lon"),
                        coords={"month": np.arange(1, 13), "lat": lat, "lon": crop_lon})
    with mock.patch.object(B, "_open_daily_year", return_value=ds):
        row = B._fetch_completed_month_from_daily(clim, 2025, 2)
    want_trop = B.tropical_mean_sst(ds["sst"].values[0], lat, lon)
    assert abs(row["atl_mdr_sst_rel"] - (28.0 - want_trop)) < 1e-3
    assert row["atl_mdr_sst_rel"] > 0.5          # old crop would give 0.0
    with mock.patch.object(B, "_open_daily_year", return_value=_daily_ds(times, lat, lon)):
        grid, trop = B._fetch_completed_month_grid_from_daily(2025, 2, lat, crop_lon)
    assert grid.shape == (lat.size, crop_lon.size)   # regional grid still cropped
    assert abs(trop - want_trop) < 1e-6


def test_preliminary_month_uses_full_lon_and_trop_clim_attr():
    lat, lon = _grid()
    today = datetime.now(timezone.utc).date()
    times = np.array([np.datetime64(f"{today.year}-{today.month:02d}-{d:02d}")
                      for d in range(1, today.day + 1)])
    ds = _daily_ds(times, lat, lon)
    crop_lon = lon[(lon >= B.LON_MIN) & (lon <= B.LON_MAX)]
    clim = xr.DataArray(np.full((12, lat.size, crop_lon.size), 27.0, np.float32),
                        dims=("month", "lat", "lon"),
                        coords={"month": np.arange(1, 13), "lat": lat, "lon": crop_lon})
    clim.attrs[B.TROP_CLIM_ATTR] = [26.0] * 12
    with mock.patch.object(B.xr, "open_dataset", return_value=ds):
        row = B._fetch_current_month_preliminary(clim)
    want_trop = B.tropical_mean_sst(ds["sst"].values[0], lat, lon)
    assert abs(row["atl_mdr_sst_rel"] - (28.0 - want_trop)) < 1e-3
    # Flat climatology -> projected == MTD, so the relative values agree.
    assert abs(row["atl_mdr_sst_rel_projected"] - row["atl_mdr_sst_rel"]) < 1e-3


def test_trop_clim_helpers():
    tclim = np.arange(12, dtype=float) + 20.0
    daily = B._build_daily_trop_climo(tclim)
    for m in range(1, 13):
        ld = B._leap_doy(m, 15)
        assert abs(daily[ld - 1] - tclim[m - 1]) < 1e-9
    da = xr.DataArray(np.zeros((12, 2, 2)), dims=("month", "lat", "lon"))
    assert B._trop_mean_clim_monthly(da, allow_monthly_file=False) is None
    assert B.trop_clim_for_day(da, 2026, 7, 15) is None
    da.attrs[B.TROP_CLIM_ATTR] = list(tclim)
    assert abs(B.trop_clim_for_day(da, 2026, 7, 15) - tclim[6]) < 1e-9


def test_daily_parquet_resume_guard():
    import pandas as pd
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "d.parquet"
        df = pd.DataFrame({"date": ["2020-01-01"], "atl_mdr_anom_rel": [0.1]})
        df.to_parquet(p, index=False)
        assert B._parquet_trop_def(p) is None        # legacy file -> rebuilt
        B._write_parquet_trop_def(df, p)
        assert B._parquet_trop_def(p) == B._TROP_DEF_TAG
        assert pd.read_parquet(p).equals(df)


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {type(e).__name__}: {e}")
    sys.exit(1 if failed else 0)
