"""Offline checks for global_archive_api fixes.

* _sel_latlon_wrap selects the right pixels for boxes in any longitude frame
  (track lons run past 180) on both -180..180 and 0..360 grids, including
  boxes that straddle the grid seam, and returns lons in the caller's frame.
* SID validation and the client frame plausibility check.
* /ir/frame rejects bad sids and implausible client values without fetching.
* SHIPS parser reads the CIRA layout (HEAD/LAST at line end) and keeps only
  the requested storm.
* Duplicate ADECK "AVNI" key is gone (GFS label).
* VDM without dates is neither cached nor fetched; /ir/batch is removed;
  _mergir_meta_ts is pruned with the meta cache; Hovmöller keys by params.

No network. Run: python3 tests/test_audit_global_archive.py  (or via pytest)
"""
import json
import os
import sys
from datetime import datetime

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import numpy as np  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import global_archive_api as G  # noqa: E402


def _norm(lon):
    return ((np.asarray(lon) + 180.0) % 360.0) - 180.0


def _grid(lon0):
    import xarray as xr
    lats = np.arange(-60.0, 60.01, 0.5)
    lons = np.arange(lon0, lon0 + 360.0, 0.5)
    # value = true longitude in -180..180, so every pixel says where it is
    vals = np.broadcast_to(_norm(lons), (len(lats), len(lons))).copy()
    return xr.DataArray(vals, coords={"lat": lats, "lon": lons}, dims=("lat", "lon"))


def test_sel_latlon_wrap_any_frame():
    import xarray as xr
    boxes = [(10, 30), (190, 210), (169, 189), (-189, -169), (256.9, 276.9),
             (-30, -10), (350, 370), (-200, -180), (170, 190), (340, 360)]
    for lon0 in (-180.0, 0.0):
        da = _grid(lon0)
        for lo, hi in boxes:
            vals, lats, lons = G._sel_latlon_wrap(da, 10.0, 30.0, lo, hi, xr)
            assert vals.shape == (len(lats), len(lons)), (lon0, lo, hi)
            assert len(lons) >= int((hi - lo) / 0.5), (lon0, lo, hi, len(lons))
            assert np.all(np.diff(lons) > 0), (lon0, lo, hi)
            assert lons[0] >= lo - 1e-9 and lons[-1] <= hi + 1e-9, (lon0, lo, hi, lons[0], lons[-1])
            assert lons[-1] - lons[0] >= (hi - lo) - 0.51, (lon0, lo, hi)
            # pixels really come from the requested longitudes
            assert np.allclose(vals[0], _norm(lons)), (lon0, lo, hi)


def test_sel_latlon_wrap_truncated_source_raises():
    import xarray as xr
    da = _grid(-180.0).sel(lon=slice(100.0, 180.0))   # file clamped at the dateline
    try:
        G._sel_latlon_wrap(da, 10.0, 30.0, 170.0, 190.0, xr)
        raise AssertionError("truncated seam piece accepted")
    except ValueError:
        pass


def test_mergir_subset_url_normalizes_lon():
    dt = datetime(2015, 8, 1, 12)
    # 200E == -160: must be a narrow index window, not the full axis
    url = G._mergir_subset_url(dt, 15.0, 200.0)
    lon_rng = url.split("Tb[0:1]")[1].split("]")[1].lstrip("[")
    i0, i1 = (int(x) for x in lon_rng.split(":"))
    assert i1 - i0 < 1000, lon_rng
    assert url == G._mergir_subset_url(dt, 15.0, -160.0)


def test_require_sid():
    for ok in ("2005236N23285", "1976143N24271", "2023036S12117"):
        assert G._require_sid(ok) == ok
    for bad in ("", "2005236N2328", "../../x", "2005236X23285", "2005236N23285/1",
                "AL092017", "2005236n23285"):
        try:
            G._require_sid(bad)
            raise AssertionError(f"accepted {bad!r}")
        except HTTPException as e:
            assert e.status_code == 400


def test_client_frame_ok():
    sid = "2005236N23285"           # day 236 of 2005 = Aug 24
    good = datetime(2005, 8, 28, 18)
    assert G._client_frame_ok(sid, good, 25.0, -80.0)
    assert G._client_frame_ok(sid, good, 25.0, 266.9)
    assert not G._client_frame_ok(sid, datetime(2005, 8, 28, 19), 25.0, -80.0)   # off grid
    assert not G._client_frame_ok(sid, datetime(2005, 8, 28, 18, 30), 25.0, -80.0)
    assert not G._client_frame_ok(sid, datetime(2005, 12, 1, 0), 25.0, -80.0)    # past lifetime
    assert not G._client_frame_ok(sid, datetime(2005, 8, 20, 0), 25.0, -80.0)    # before genesis
    assert not G._client_frame_ok(sid, good, 95.0, -80.0)
    assert not G._client_frame_ok(sid, good, float("nan"), -80.0)


def test_ir_frame_rejects_bad_input_offline():
    try:
        G.ir_frame(sid="../evil", frame_idx=0, lat=None, lon=None, dt=None)
        raise AssertionError("bad sid accepted")
    except HTTPException as e:
        assert e.status_code == 400
    # no meta on this instance, client time off the synoptic grid -> 400
    # before any fetch (no R2/GCS configured in tests)
    G._mergir_meta_cache.pop("ir_2017242N16333", None)
    try:
        G.ir_frame(sid="2017242N16333", frame_idx=3, lat=17.0, lon=-50.0,
                   dt="2017-09-01T07:00:00")
        raise AssertionError("off-grid client dt accepted")
    except HTTPException as e:
        assert e.status_code == 400


def test_server_meta_wins_over_client():
    sid = "2017242N16333"
    seen = {}

    def fake_gridsat(dt, lat, lon):
        seen["args"] = (dt, lat, lon)
        return None, None

    orig = (G._load_gridsat_subset, G._load_mergir_subset, G._hursat_frame_near)
    G._load_gridsat_subset = fake_gridsat
    G._load_mergir_subset = lambda *a: (None, None)
    G._hursat_frame_near = lambda *a, **k: None
    G._mergir_meta_cache["ir_" + sid] = {
        "sid": sid, "available": True, "source": "gridsat",
        "frames": [{"index": 0, "datetime": "2017-09-01T06:00:00", "lat": 16.5, "lon": -33.0}],
    }
    try:
        try:
            G.ir_frame(sid=sid, frame_idx=0, lat=40.0, lon=100.0, dt="2017-09-03T00:00:00")
        except HTTPException as e:
            assert e.status_code == 502
        assert seen["args"] == (datetime(2017, 9, 1, 6), 16.5, -33.0), seen
    finally:
        G._load_gridsat_subset, G._load_mergir_subset, G._hursat_frame_near = orig
        G._mergir_meta_cache.pop("ir_" + sid, None)


_SHIPS_SAMPLE = "\n".join([
    " IRMA 170905 06  155   16.8   57.7  920 AL112017" + " " * 60 + "HEAD",
    "  -12   -6    0    6 TIME",
    " 9999 9999  123  130 SHDC",
    " 9999 9999   55   60 D200",
    " 9999 9999 9999 9999 LAST",
    " JOSE 170905 06   65   13.0   37.4 1000 AL122017" + " " * 60 + "HEAD",
    " 9999 9999  200  210 SHDC",
    " 9999 9999 9999 9999 LAST",
    " IRMA 170905 12  160   17.0   58.5  914 AL112017" + " " * 60 + "HEAD",
    " 9999 9999  110  100 SHDC",
    " 9999 9999 9999 9999 LAST",
])


def test_ships_parser_filters_storm():
    out = G._parse_ships_lsdiag(_SHIPS_SAMPLE, "AL112017")
    assert out["n_cases"] == 2, out
    c0 = out["cases"][0]
    assert c0["storm_name"] == "IRMA" and c0["init_time"] == "2017090506"
    assert c0["lat"] == 16.8 and c0["lon"] == -57.7 and c0["vmax"] == 155 and c0["mslp"] == 920
    assert c0["predictors"]["SHDC"][0] == {"tau": 0, "val": 12.3}
    assert "D200" in c0["predictors"]
    assert G._parse_ships_lsdiag(_SHIPS_SAMPLE, "AL122017")["n_cases"] == 1
    assert G._parse_ships_lsdiag(_SHIPS_SAMPLE, "AL052017")["n_cases"] == 0


def test_ships_empty_is_not_available():
    orig = G._fetch_ships
    G._fetch_ships = lambda a: {"cases": [], "variables": [], "n_cases": 0}
    try:
        r = G.get_ships(atcf_id="AL052017")
        body = json.loads(r.body)
        assert body["available"] is False
        assert r.headers["cache-control"] == "no-store"
    finally:
        G._fetch_ships = orig


def test_adeck_avni_is_gfs():
    assert G.ADECK_MODELS["AVNI"]["name"] == "GFS"


def test_vdm_without_dates_not_cached():
    before = dict(G._vdm_cache)
    r = G.get_vdm(storm_name="Irma", year=2017, atcf_id="AL112017",
                  start_date="", end_date="")
    assert r.headers["cache-control"] == "no-store"
    assert json.loads(r.body)["n_vdms"] == 0
    assert dict(G._vdm_cache) == before


def test_ir_batch_removed():
    paths = {getattr(r, "path", "") for r in G.router.routes}
    assert "/ir/batch" not in paths
    assert "/ir/frame" in paths


def test_meta_ts_pruned():
    # a cached Hovmöller means ir_meta starts no background precompute
    orig = G._gcs_get_hovmoller
    G._gcs_get_hovmoller = lambda sid: {"cached": True}
    try:
        track = json.dumps([{"t": "2017-09-01T00:00", "la": 16.0, "lo": -30.0},
                            {"t": "2017-09-01T03:00", "la": 16.2, "lo": -30.5}])
        for i in range(G._MERGIR_META_CACHE_MAX + 15):
            G.ir_meta(sid=f"2017{200 + i:03d}N16333", track=track, storm_lon=0.0)
        assert len(G._mergir_meta_cache) <= G._MERGIR_META_CACHE_MAX
        assert set(G._mergir_meta_ts) <= set(G._mergir_meta_cache), \
            (len(G._mergir_meta_ts), len(G._mergir_meta_cache))
    finally:
        G._gcs_get_hovmoller = orig


def test_hov_key():
    assert G._hov_key("2005236N23285") == "2005236N23285"
    assert G._hov_key("2005236N23285", 200, 4) == "2005236N23285"
    assert G._hov_key("2005236N23285", 300, 4) == "2005236N23285_r300_dr4"
    assert G._hov_key("2005236N23285", 200, 2.5) == "2005236N23285_r200_dr2.5"


def _main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"\nAll {len(tests)} global archive audit tests passed.")


if __name__ == "__main__":
    _main()
