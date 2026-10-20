#!/usr/bin/env python3
"""Regression tests for ir_monitor_api audit fixes (no network, no GCS).

Runnable standalone:  python3 tests/test_audit_ir_monitor.py
"""
import os
import sys
import time
from datetime import timedelta, timezone

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import ir_monitor_api as M  # noqa: E402


class _Patch:
    """Minimal attribute patcher for module-level names."""
    def __init__(self):
        self._saved = []

    def set(self, obj, name, val):
        self._saved.append((obj, name, getattr(obj, name)))
        setattr(obj, name, val)

    def undo(self):
        for obj, name, val in reversed(self._saved):
            setattr(obj, name, val)


# ── Storm poll: partial failure carry-forward ─────────────────────
def _poll(nhc_list, adecks, jtwc_list, bdecks, prev=None, shared=None,
          last_ok=None):
    """Run _poll_active_storms against stubbed upstreams. Returns
    (storms, published_list_or_None, degraded_flag)."""
    pt = _Patch()
    now = M._dt.now(timezone.utc)
    published = []

    def recs(lat):
        return [{"datetime": now - timedelta(hours=1), "tau": 0,
                 "tech": "BEST", "lat": lat, "lon": -50.0}]

    try:
        pt.set(M, "_list_nhc_active_storms", lambda: nhc_list)
        pt.set(M, "_fetch_adeck",
               lambda sid: recs(10.0) if adecks.get(sid) else [])
        pt.set(M, "_merge_jtwc_crossover", lambda sid, r, n: r)
        pt.set(M, "_get_latest_position", lambda r: r[-1] if r else None)
        pt.set(M, "_nhc_delisted", lambda *a: False)
        pt.set(M, "_fetch_nhc_storm_name", lambda sid: None)
        pt.set(M, "_list_jtwc_active_storms", lambda: jtwc_list)
        pt.set(M, "_fetch_jtwc_bdeck",
               lambda sid, url=None: recs(15.0) if bdecks.get(sid) else [])
        pt.set(M, "_fetch_jtwc_carq", lambda sid: [])
        pt.set(M, "_fetch_jtwc_tcw", lambda sid: ([], "X"))
        pt.set(M, "_build_storm_entry",
               lambda sid, r, name=None, source="NHC": {
                   "atcf_id": sid.upper(), "basin": "ATL", "lat": r[-1]["lat"],
                   "lon": r[-1]["lon"], "source": source, "fresh": True})
        pt.set(M, "_filter_genesis_invests", lambda s: s)
        pt.set(M, "_gcs_storm_cache_put",
               lambda storms, u, c: published.append(list(storms)))
        pt.set(M, "_gcs_storm_cache_get", lambda: dict(shared or {}))
        pt.set(M, "_INLINE_PREWARM", False)
        M._active_storms_cache["storms"] = list(prev or [])
        M._active_storms_cache["updated_utc"] = None
        M._storm_last_ok.clear()
        M._storm_last_ok.update(last_ok or {})
        M._storm_poll_degraded = False
        storms = M._poll_active_storms(spawn_prefetch=False)
        return storms, (published[0] if published else None), M._storm_poll_degraded
    finally:
        pt.undo()


def _ids(storms):
    return sorted(s["atcf_id"] for s in storms)


def test_partial_failure_carries_forward():
    prev = [{"atcf_id": "AL012026", "source": "NHC", "basin": "ATL", "fresh": False},
            {"atcf_id": "WP022026", "source": "JTWC", "basin": "WPAC", "fresh": False}]
    storms, pub, deg = _poll(
        ["al012026"], {"al012026": False},           # AL01 deck fetch fails
        [("WP022026", "u")], {"WP022026": True},
        prev=prev, last_ok={"AL012026": time.time() - 600})
    assert _ids(storms) == ["AL012026", "WP022026"], storms
    assert pub is None, "degraded poll must not be published"
    assert deg is True
    print("PASS test_partial_failure_carries_forward")


def test_dissipated_storm_drops():
    prev = [{"atcf_id": "AL012026", "source": "NHC", "basin": "ATL"}]
    # AL01 no longer listed; listings read fine -> drop and publish.
    storms, pub, deg = _poll([], {}, [], {}, prev=prev,
                             last_ok={"AL012026": time.time() - 600})
    assert storms == [] and pub == [] and deg is False, (storms, pub, deg)
    # Unrelated deck failure (not a previous storm) does not revive AL01.
    storms, pub, deg = _poll(["al022026"], {"al022026": False}, [], {},
                             prev=prev, last_ok={"AL012026": time.time() - 600})
    assert storms == [] and pub == [] and deg is False, (storms, pub, deg)
    print("PASS test_dissipated_storm_drops")


def test_carry_window_expires():
    prev = [{"atcf_id": "AL012026", "source": "NHC", "basin": "ATL"}]
    old = time.time() - (M._EMPTY_POLL_RETAIN_HOURS * 3600 + 60)
    storms, pub, deg = _poll(["al012026"], {"al012026": False}, [], {},
                             prev=prev, last_ok={"AL012026": old})
    assert storms == [] and pub == [] and deg is False, (storms, pub, deg)
    print("PASS test_carry_window_expires")


def test_listing_failure_carries_source():
    prev = [{"atcf_id": "AL012026", "source": "NHC", "basin": "ATL"},
            {"atcf_id": "WP022026", "source": "JTWC", "basin": "WPAC"}]
    now = time.time()
    storms, pub, deg = _poll(None, {}, [("WP022026", "u")], {"WP022026": True},
                             prev=prev, last_ok={"AL012026": now - 60,
                                                 "WP022026": now - 60})
    assert _ids(storms) == ["AL012026", "WP022026"], storms
    assert pub is None and deg is True
    print("PASS test_listing_failure_carries_source")


def test_cold_instance_total_failure():
    # Nothing in memory, nothing shared: [] stays local (not published).
    storms, pub, deg = _poll(None, {}, None, {})
    assert storms == [] and pub is None and deg is True, (storms, pub, deg)
    # Shared copy 1 h old: its storms are carried, still not republished.
    shared = {"polled_at": time.time() - 3600,
              "storms": [{"atcf_id": "AL012026", "source": "NHC", "basin": "ATL"}]}
    storms, pub, deg = _poll(None, {}, None, {}, shared=shared)
    assert _ids(storms) == ["AL012026"] and pub is None and deg is True
    print("PASS test_cold_instance_total_failure")


def test_active_storms_cache_control():
    pt = _Patch()
    try:
        pt.set(M, "_ensure_fresh_cache", lambda: None)
        M._active_storms_cache.update(storms=[], updated_utc="x", count_by_basin={})
        M._storm_poll_degraded = True
        r = M.get_active_storms(if_none_match=None)
        assert r.headers["cache-control"] == "no-store", r.headers
        M._storm_poll_degraded = False
        r = M.get_active_storms(if_none_match=None)
        assert r.headers["cache-control"].startswith("public, max-age=300")
    finally:
        pt.undo()
    print("PASS test_active_storms_cache_control")


# ── HTTP-level validation (FastAPI Query bounds, radius guard) ────
def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(M.router)
    return TestClient(app)


def test_cluster_param_bounds():
    c = _client()
    for qs in ("grid_deg=0", "grid_deg=0.5", "grid_deg=7", "peak_min_members=1",
               "assign_radius_km=50000", "time_window_h=1000",
               "cluster_min_members=1", "same_system_km=-1", "merge_km=5000",
               "merge_overlap_h=-5"):
        for path in ("/weatherlab-genesis-clusters",
                     "/weatherlab-genesis-cluster/tca-1",
                     "/weatherlab-genesis-family/fam-1"):
            r = c.get(f"{path}?{qs}")
            assert r.status_code == 422, (path, qs, r.status_code)
    r = c.get("/weatherlab-genesis-trend?lat=10&lon=-40&match_radius_km=0")
    assert r.status_code == 422, r.status_code
    r = c.get("/weatherlab-genesis-trend?lat=10&lon=-40&grid_deg=0")
    assert r.status_code == 422, r.status_code
    r = c.get("/weatherlab-genesis?max_members=0")
    assert r.status_code == 422, r.status_code
    print("PASS test_cluster_param_bounds")


def test_radius_guard():
    c = _client()
    for path in ("/storm/AL012026/band-raw-frame?radius_deg=6",
                 "/storm/AL012026/band-raw-bundle?radius_deg=6",
                 "/storm/AL012026/band-frame.jpg?radius_deg=6",
                 "/storm/AL012026/band-frames-bundle?radius_deg=6",
                 "/storm/AL012026/ir-frames-bundle?radius_deg=6",
                 "/storm/AL012026/ir-frame.jpg?radius_deg=6"):
        r = c.get(path)
        assert r.status_code == 400, (path, r.status_code)
    print("PASS test_radius_guard")


def test_band_bundle_interval_default():
    import inspect
    p = inspect.signature(M.get_storm_band_frames_bundle).parameters
    assert p["interval_min"].default.default == 15
    print("PASS test_band_bundle_interval_default")


# ── init_time validation ──────────────────────────────────────────
def test_init_time_validation():
    now = M._dt.now(timezone.utc)
    recent = (now - timedelta(days=1)).strftime("%Y%m%d") + "06"
    assert M._genesis_init_to_cycle(recent)[0] is not None
    bad = [recent[:8] + "07", recent[:8] + "24", "2026023012", "abcdefghij",
           "202610201", (now + timedelta(days=2)).strftime("%Y%m%d") + "00",
           (now - timedelta(days=60)).strftime("%Y%m%d") + "00", "", None]
    for b in bad:
        assert M._genesis_init_to_cycle(b) == (None, None), b
    print("PASS test_init_time_validation")


# ── NDBC parsing ──────────────────────────────────────────────────
_NDBC_SAMPLE = """#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE
#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft
15009     0.000   -3.051 2026 10 20 15 00 189   5.7    MM   MM  MM   MM  MM 1010.6    MM  26.8  27.6    MM   MM     MM
41043    21.03   -64.79  2026 10 20 16 00  99  20.0  25.0  4.5  10  MM  MM  999.0  -2.0  28.6  30.0  24.5   MM     MM
"""


def test_ndbc_latest_parse():
    rows = M._parse_ndbc_latest(_NDBC_SAMPLE)
    assert [r["id"] for r in rows] == ["15009", "41043"], rows
    assert rows[0]["pressure_hpa"] == 1010.6 and rows[0]["wind_gust_kt"] is None
    assert rows[1]["pressure_hpa"] == 999.0, rows[1]
    assert rows[1]["wind_dir_deg"] == 99.0, rows[1]
    print("PASS test_ndbc_latest_parse")


def test_ndbc_realtime2_values():
    assert M._ndbc_f("999.0") == 999.0 and M._ndbc_f("99") == 99.0
    assert M._ndbc_f("MM") is None
    print("PASS test_ndbc_realtime2_values")


def test_obs_history_failure_not_cached():
    pt = _Patch()
    try:
        calls = []
        pt.set(M, "_fetch_ndbc_history",
               lambda st, since: calls.append(1) or None)
        M._OBS_HISTORY_CACHE.clear()
        c = _client()
        r = c.get("/surface-obs/history?id=41043&source=NDBC")
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
        assert r.json()["series"] == [] and not M._OBS_HISTORY_CACHE
        pt.set(M, "_fetch_ndbc_history",
               lambda st, since: calls.append(1) or [{"time_utc": "x"}])
        r = c.get("/surface-obs/history?id=41043&source=NDBC")
        assert r.headers["cache-control"].startswith("public")
        assert len(M._OBS_HISTORY_CACHE) == 1 and len(calls) == 2
    finally:
        pt.undo()
        M._OBS_HISTORY_CACHE.clear()
    print("PASS test_obs_history_failure_not_cached")


# ── WeatherLab caching ────────────────────────────────────────────
class _Resp:
    def __init__(self, code, text=""):
        self.status_code = code
        self.text = text


class _Sess:
    def __init__(self, fn):
        self.fn = fn
        self.urls = []

    def get(self, url, **k):
        self.urls.append(url)
        return self.fn(url)


def test_non_404_is_short_miss():
    pt = _Patch()
    try:
        for code, expect_ttl in ((503, M._WEATHERLAB_TRANSIENT_MISS_TTL),
                                 (429, M._WEATHERLAB_TRANSIENT_MISS_TTL),
                                 (404, None)):
            pt.set(M, "_weatherlab_http", lambda c=code: _Sess(lambda u: _Resp(c)))
            M._weatherlab_genesis_cache.clear()
            assert M._fetch_weatherlab_genesis_csv("2026-10-19", "00", "large") is None
            e = M._weatherlab_genesis_cache[("2026-10-19", "00", "large")]
            assert e.get("ttl") == expect_ttl, (code, e)
            M._weatherlab_cache.clear()
            assert M._fetch_weatherlab_csv("2026-10-19", "00", "fnv3") is None
            e = M._weatherlab_cache[("2026-10-19", "00", "fnv3")]
            assert e.get("ttl") == expect_ttl, (code, e)
    finally:
        pt.undo()
        M._weatherlab_genesis_cache.clear()
        M._weatherlab_cache.clear()
    print("PASS test_non_404_is_short_miss")


def test_missing_mean_short_ttl():
    ens = ("init_time,track_id,sample,valid_time,lead_time,lat,lon,"
           "minimum_sea_level_pressure_hpa,maximum_sustained_wind_speed_knots\n"
           "2026-10-19 00:00:00,AL012026,0,2026-10-19 00:00:00,0 days 00:00:00,"
           "15.0,-50.0,1000,40\n")
    pt = _Patch()
    try:
        pt.set(M, "_weatherlab_http", lambda: _Sess(
            lambda u: _Resp(503) if "ensemble_mean" in u else _Resp(200, ens)))
        M._weatherlab_cache.clear()
        d = M._fetch_weatherlab_csv("2026-10-19", "00", "fnv3")
        assert d and "AL012026" in d, d
        e = M._weatherlab_cache[("2026-10-19", "00", "fnv3")]
        assert e.get("ttl") == M._WEATHERLAB_MISS_TTL, e
        # Positive entry past its short ttl is treated as expired.
        e["ts"] -= M._WEATHERLAB_MISS_TTL + 1
        assert M._weatherlab_cache_lookup(
            M._weatherlab_cache, ("2026-10-19", "00", "fnv3"),
            M._WEATHERLAB_CACHE_TTL, M._WEATHERLAB_MISS_TTL) is M._WL_CACHE_MISS
    finally:
        pt.undo()
        M._weatherlab_cache.clear()
    print("PASS test_missing_mean_short_ttl")


def test_cache_cap_protects_latest():
    cache = {}
    t = time.time()
    # Newest cycle per variant inserted FIRST (oldest ts), then older ones.
    for i, (d, h, v) in enumerate([("2026-10-20", "00", "large"),
                                   ("2026-10-20", "00", "small"),
                                   ("2026-10-19", "18", "large"),
                                   ("2026-10-19", "12", "large"),
                                   ("2026-10-19", "06", "large")]):
        cache[(d, h, v)] = {"data": {"x": 1}, "ts": t + i}
        M._weatherlab_cache_cap(cache, 4)
    assert ("2026-10-20", "00", "large") in cache
    assert ("2026-10-20", "00", "small") in cache
    assert len([k for k in cache]) == 4
    print("PASS test_cache_cap_protects_latest")


def test_absent_id_negative_cache():
    pt = _Patch()
    fetches = []
    try:
        cands = [("2026-10-20", "00"), ("2026-10-19", "18"), ("2026-10-19", "12")]
        pt.set(M, "_genesis_candidates", lambda now=None, **k: list(cands))
        pt.set(M, "_fetch_weatherlab_genesis_csv",
               lambda d, h, v="large": fetches.append((d, h)) or {"1": {}})
        M._WL_ID_ABSENT.clear()
        c = _client()
        assert c.get("/weatherlab-genesis/999").status_code == 404
        n = len(fetches)
        assert n == 3, fetches
        assert c.get("/weatherlab-genesis/999").status_code == 404
        assert len(fetches) == n, "repeat probe must not re-walk the cycles"
        # A new newest candidate invalidates the negative entry.
        cands.insert(0, ("2026-10-20", "06"))
        assert c.get("/weatherlab-genesis/999").status_code == 404
        assert len(fetches) == n + 4
    finally:
        pt.undo()
        M._WL_ID_ABSENT.clear()
    print("PASS test_absent_id_negative_cache")


def main():
    test_partial_failure_carries_forward()
    test_dissipated_storm_drops()
    test_carry_window_expires()
    test_listing_failure_carries_source()
    test_cold_instance_total_failure()
    test_active_storms_cache_control()
    test_cluster_param_bounds()
    test_radius_guard()
    test_band_bundle_interval_default()
    test_init_time_validation()
    test_ndbc_latest_parse()
    test_ndbc_realtime2_values()
    test_obs_history_failure_not_cached()
    test_non_404_is_short_miss()
    test_missing_mean_short_ttl()
    test_cache_cap_protects_latest()
    test_absent_id_negative_cache()
    print("\nALL TESTS PASSED")


if __name__ == "__main__":
    main()
