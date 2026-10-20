#!/usr/bin/env python3
"""Regression tests for audit items S11, S16 and the subseasonal filled-PNG
half-cell fix (no network, no GCS).

  S11  /storm/{id}/metadata forecast_track comes from the a-deck (OFCL) /
       JTWC warning even when a b-deck answered the request
  S16  the genesis next-cycle ETA anchors only on an observed 404 → 200
  SUB  the filled subseasonal PNG puts a single-node feature on its node

Runnable standalone:  python3 tests/test_audit_science_d.py
"""
import io
import json
import os
import sys
import time
from datetime import timedelta, timezone

import numpy as np

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import build_subseasonal_overlays as S  # noqa: E402
import ir_monitor_api as M  # noqa: E402


class _Patch:
    def __init__(self):
        self._saved = []

    def set(self, obj, name, val):
        self._saved.append((obj, name, getattr(obj, name)))
        setattr(obj, name, val)

    def undo(self):
        for obj, name, val in reversed(self._saved):
            setattr(obj, name, val)


# ── S11: official forecast track ─────────────────────────────────────

def _rec(dt, tech, tau, lat, lon, vmax=50):
    return {"datetime": dt, "tech": tech, "tau": tau, "lat": lat,
            "lon": lon, "vmax_kt": vmax, "mslp_hpa": 990, "ty": "TS"}


def _metadata(atcf_id):
    resp = M.get_storm_metadata(atcf_id)
    return json.loads(resp.body)


def _stub_common(pt, bdeck):
    pt.set(M, "_fetch_bdeck", lambda sid: bdeck)
    pt.set(M, "_has_active_recon", lambda *a, **k: False)
    M._OFFICIAL_FCST_CACHE.clear()


def test_ofcl_from_adeck_when_bdeck_exists():
    now = M._dt.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    t0 = now - timedelta(hours=6)
    bdeck = [_rec(t0 - timedelta(hours=6), "BEST", 0, 15.0, -60.0),
             _rec(t0, "BEST", 0, 15.5, -61.0)]
    old = t0 - timedelta(hours=6)
    adeck = (
        # older cycle — must be ignored
        [_rec(old, "OFCL", 12, 1.0, 1.0)]
        # latest cycle, each tau repeated per radii row (34/50/64 kt)
        + [_rec(t0, "OFCL", tau, 15.5 + tau / 24, -61.0 - tau / 12, 55)
           for tau in (12, 24, 3, 12, 24, 24)]
        + [_rec(t0, "OFCL", 0, 15.5, -61.0)]
        + [_rec(t0, "AVNO", 24, 30.0, -30.0)])
    calls = []
    pt = _Patch()
    try:
        _stub_common(pt, bdeck)

        def fake_adeck(sid, techs=None):
            calls.append((sid, techs))
            return [r for r in adeck if not techs or r["tech"] in techs]
        pt.set(M, "_fetch_adeck", fake_adeck)
        d = _metadata("AL142026")
        assert [p["tau_h"] for p in d["forecast_track"]] == [3, 12, 24]
        assert set(d["forecast_track"][0]) == {"tau_h", "lat", "lon",
                                               "vmax_kt"}
        assert abs(d["forecast_track"][-1]["lat"] - 16.5) < 1e-9
        assert calls == [("al142026", ("OFCL",))]
        # Second request is served from the cache — no new a-deck fetch.
        _metadata("AL142026")
        assert len(calls) == 1
    finally:
        pt.undo()
        M._OFFICIAL_FCST_CACHE.clear()


def test_failed_adeck_degrades_to_empty():
    now = M._dt.now(timezone.utc)
    bdeck = [_rec(now - timedelta(hours=3), "BEST", 0, 15.0, -60.0)]
    pt = _Patch()
    try:
        _stub_common(pt, bdeck)

        def boom(sid, techs=None):
            raise RuntimeError("upstream down")
        pt.set(M, "_fetch_adeck", boom)
        d = _metadata("EP212026")
        assert d["forecast_track"] == []
        assert d["intensity_history"]          # rest of metadata intact
        # The miss is negative-cached briefly (no hammering).
        assert M._OFFICIAL_FCST_CACHE["EP212026"]["track"] == []
    finally:
        pt.undo()
        M._OFFICIAL_FCST_CACHE.clear()


def test_stale_final_forecast_dropped():
    now = M._dt.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    bdeck = [_rec(now - timedelta(hours=3), "BEST", 0, 25.0, -70.0)]
    old = now - timedelta(hours=60)
    pt = _Patch()
    try:
        _stub_common(pt, bdeck)
        pt.set(M, "_fetch_adeck", lambda sid, techs=None: [
            _rec(old, "OFCL", 12, 20.0, -65.0)])
        assert _metadata("AL052026")["forecast_track"] == []
    finally:
        pt.undo()
        M._OFFICIAL_FCST_CACHE.clear()


_TCW = """WTPN52 PGTW 201500
WARNING    ATCG MIL 29W NWP 261020140020
2026102012 29W CHAMPI     025  01 290 14 SATL 030
T000 170N 1330E 155 R064 060 NE QD 055 SE QD 050 SW QD 090 NW QD
T012 181N 1305E 155 R064 070 NE QD 050 SE QD 050 SW QD 080 NW QD
T024 195N 1283E 150 R064 070 NE QD 060 SE QD 040 SW QD 070 NW QD
T120 337S 1795W 055 R050 020 NE QD 040 SE QD 030 SW QD 020 NW QD
AMP
    120HR BECOMING EXTRATROPICAL
"""


def test_jtwc_forecast_from_tcw_read():
    now = M._dt(2026, 10, 20, 12, tzinfo=timezone.utc)
    pt = _Patch()
    try:
        M._OFFICIAL_FCST_CACHE.clear()
        pt.set(M, "_http_get", lambda url, timeout=15: _TCW)
        recs, name = M._fetch_jtwc_tcw("wp292026")   # the poll's read
        assert recs and recs[0]["tau"] == 0 and name == "Champi"
        ent = M._OFFICIAL_FCST_CACHE["WP292026"]
        assert [p["tau_h"] for p in ent["track"]] == [12, 24, 120]
        assert ent["track"][0] == {"tau_h": 12, "lat": 18.1, "lon": 130.5,
                                   "vmax_kt": 155}
        assert ent["track"][-1]["lat"] == -33.7
        assert ent["track"][-1]["lon"] == -179.5
        assert ent["init"] == now
        # Metadata: served from that cache; lon unwrapped across 180°.
        bdeck = [_rec(M._dt.now(timezone.utc) - timedelta(hours=2),
                      "BEST", 0, 17.0, 133.0)]
        _stub_common(pt, bdeck)
        M._official_forecast_store("WP292026", {
            "init": M._dt.now(timezone.utc) - timedelta(hours=2),
            "track": ent["track"]})
        pt.set(M, "_http_get", lambda *a, **k: None)
        d = _metadata("WP292026")
        assert [p["lon"] for p in d["forecast_track"]] == [130.5, 128.3,
                                                           180.5]
    finally:
        pt.undo()
        M._OFFICIAL_FCST_CACHE.clear()


def test_poll_stores_ofcl():
    t0 = M._dt(2026, 10, 20, 0, tzinfo=timezone.utc)
    M._OFFICIAL_FCST_CACHE.clear()
    try:
        M._official_forecast_store("ep212026", M._official_forecast_from_records(
            [_rec(t0, "OFCL", 12, 19.3, -108.6), _rec(t0, "OFCL", 0, 19, -108)],
            "OFCL"))
        assert M._official_forecast_cached("EP212026")["track"][0]["tau_h"] == 12
    finally:
        M._OFFICIAL_FCST_CACHE.clear()


def test_adeck_tech_filter():
    line_ofcl = ("EP, 21, 2026102000, 03, OFCL,  12, 193N, 1086W,  30,    0, "
                 "PT,  34, NEQ,    0,    0,    0,    0")
    line_avno = ("EP, 21, 2026102000, 03, AVNO,  12, 193N, 1086W,  30,    0, "
                 "PT,  34, NEQ,    0,    0,    0,    0")
    pt = _Patch()
    try:
        pt.set(M, "_http_get",
               lambda url, timeout=15: line_ofcl + "\n" + line_avno + "\n")
        assert [r["tech"] for r in M._fetch_adeck("ep212026", ("OFCL",))] \
            == ["OFCL"]
        assert len(M._fetch_adeck("ep212026")) == 2
    finally:
        pt.undo()


# ── S16: next-cycle ETA anchor ───────────────────────────────────────

class _Resp:
    def __init__(self, status, text=""):
        self.status_code = status
        self.text = text


_CSV = ("init_time,track_id,sample,valid_time,lead_time,lat,lon,mslp,wind,rmw\n"
        "2026-10-20T06:00:00,T1,0,2026-10-20T06:00:00,0 days 00:00:00,"
        "10.0,140.0,1005,30,40\n")


def _genesis_reset():
    M._weatherlab_genesis_cache.clear()
    M._genesis_cycle_first_seen.clear()
    M._genesis_cycle_last_404.clear()


def test_first_fetch_after_restart_is_not_an_anchor():
    pt = _Patch()
    try:
        _genesis_reset()
        sess = type("S", (), {"get": lambda self, url, timeout=30: _Resp(200, _CSV)})()
        pt.set(M, "_weatherlab_http", lambda: sess)
        d = M._fetch_weatherlab_genesis_csv("2026-10-20", "06", "small")
        assert d and "T1" in d
        assert ("2026-10-20", "06") not in M._genesis_cycle_first_seen
        # ETA = init-only model (06Z + 6 h + 5 h lag = 17Z), restart-proof.
        now = M._dt(2026, 10, 20, 16, 0, tzinfo=timezone.utc)
        eta = M._genesis_next_cycle_eta_h(now=now, init_time="2026102006")
        assert abs(eta - 1.0) < 1e-6
    finally:
        pt.undo()
        _genesis_reset()


def test_observed_404_then_200_anchors():
    pt = _Patch()
    try:
        _genesis_reset()
        state = {"status": 404}
        sess = type("S", (), {"get": lambda self, url, timeout=30:
                              _Resp(state["status"], _CSV)})()
        pt.set(M, "_weatherlab_http", lambda: sess)
        assert M._fetch_weatherlab_genesis_csv("2026-10-20", "06", "small") is None
        assert ("2026-10-20", "06", "small") in M._genesis_cycle_last_404
        M._weatherlab_genesis_cache.clear()      # miss TTL elapsed
        state["status"] = 200
        t_before = time.time()
        assert M._fetch_weatherlab_genesis_csv("2026-10-20", "06", "small") is not None
        anchor = M._genesis_cycle_first_seen[("2026-10-20", "06")]
        assert anchor <= time.time() and anchor >= t_before - 1
    finally:
        pt.undo()
        _genesis_reset()


def test_stale_404_does_not_anchor():
    _genesis_reset()
    try:
        M._genesis_cycle_last_404[("2026-10-20", "06", "large")] = (
            time.time() - M._GENESIS_FIRST_SEEN_MAX_GAP_S - 60)
        M._genesis_note_published("2026-10-20", "06", "large")
        assert not M._genesis_cycle_first_seen
    finally:
        _genesis_reset()


# ── Subseasonal filled PNG: node features land on their node ─────────

LATS = np.linspace(90.0, -90.0, 73)
LONS = np.arange(144) * 2.5


def _filled(f):
    from PIL import Image
    spec = next(s for s in S.WAVE_SPECS if s.name == "anomaly")
    png = S._render_filled_png(f, LATS, LONS, spec)
    return np.asarray(Image.open(io.BytesIO(png)).convert("RGBA")).astype(float)


def test_filled_png_node_spike_on_node():
    base = _filled(np.zeros((73, 144)))
    h, w = base.shape[:2]
    lon_c = -180.0 + (np.arange(w) + 0.5) * 360.0 / w
    for lon0 in (120.0, 0.0, -177.5, -180.0):
        f = np.zeros((73, 144))
        f[36, int(round((lon0 % 360) / 2.5)) % 144] = -60.0   # 0°N node
        d = np.abs(_filled(f) - base).sum(-1)
        row = d[d.max(axis=1).argmax()]
        peak = np.flatnonzero(row >= row.max() - 1e-9)
        # Midpoint of the brightest pixel(s), circular across the seam.
        a = np.deg2rad(lon_c[peak])
        got = np.rad2deg(np.arctan2(np.sin(a).mean(), np.cos(a).mean()))
        err = ((got - lon0 + 180.0) % 360.0) - 180.0
        assert abs(err) < 0.1, (lon0, got)
        # Latitude: brightest row straddles / sits on the equator.
        rows = np.flatnonzero(d.max(axis=1) >= d.max() - 1e-9)
        max_my = np.log(np.tan(np.pi / 4 + np.radians(S.WEB_MERC_LAT_MAX) / 2))
        my = max_my - (rows.mean() + 0.5) / h * 2 * max_my
        assert abs(np.degrees(np.arctan(np.sinh(my)))) < 0.1


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as e:  # noqa: BLE001
                fails += 1
                import traceback
                traceback.print_exc()
                print(f"FAIL {name}: {e}")
    sys.exit(1 if fails else 0)
