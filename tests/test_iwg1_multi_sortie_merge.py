"""Regression test for the IWG1 multi-sortie merge
(fix/noaa-43-flight-visibility).

NOAA hurricane-hunter tracks come from the 1-Hz IWG1 feed, which overrides
the 30-s HDOB track. `_iwg1_active_flights` returns EVERY recent flight for
a tail — a just-launched sortie AND the prior one it flew the same day —
newest-first. The old `_merge_iwg1` did `aircraft[tail] = {…}` per flight,
an unconditional replace, so whichever flight was processed LAST (the
OLDEST, since the list is newest-first) won: the fresh sortie was silently
dropped. Users saw the previous NOAA 43 flight but not the one that had
just taken off.

The fix accumulates all of a tail's active IWG1 sorties into one obs map
(so `_split_sorties` can separate them into selectable flights), and lets
IWG1 override HDOB only across the spans it actually covers (so an older
HDOB-only sortie still survives).

These tests patch the IWG1 fetch/parse + directory listing — no network.

Run standalone:  python3 tests/test_iwg1_multi_sortie_merge.py
or via pytest:   python3 -m pytest tests/test_iwg1_multi_sortie_merge.py
"""
import os
import sys
import types
from datetime import datetime, timedelta, timezone

# ── sys.path bootstrap so `import recon_api` works from repo root, tests/,
#    or via pytest. ──────────────────────────────────────────────────────
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# recon_api imports fastapi at module load; stub a minimal shim when it's
# not installed so this test runs without the web stack (CI has the real one).
try:
    import fastapi  # noqa: F401
except ModuleNotFoundError:
    _fa = types.ModuleType("fastapi")

    class _APIRouter:
        def __init__(self, *a, **k):
            pass

        def get(self, *a, **k):
            return lambda fn: fn

    _fa.APIRouter = _APIRouter
    _fa.Query = lambda default=None, *a, **k: default
    sys.modules["fastapi"] = _fa
    _far = types.ModuleType("fastapi.responses")
    _far.JSONResponse = lambda *a, **k: None
    sys.modules["fastapi.responses"] = _far

import recon_api as R  # noqa: E402


NOW = datetime(2026, 7, 21, 6, 0, 0, tzinfo=timezone.utc)


# ── Minimal monkeypatch context (mirrors the repo's other tests) ────────
class _MP:
    def __init__(self):
        self._undo = []

    def setattr(self, obj, name, value):
        self._undo.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def undo(self):
        for obj, name, old in reversed(self._undo):
            setattr(obj, name, old)
        self._undo = []


def _obs(start, n, step_s=60):
    """n obs at step_s spacing from `start`, each a minimal IWG1-style row."""
    out = []
    for i in range(n):
        t = start + timedelta(seconds=i * step_s)
        out.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "lat": 25.0 + i * 0.01, "lon": -70.0 - i * 0.01,
                    "wspd_kt": 80})
    return out


# NOAA 43 = N43RF = IWG1 letter 'I'. Two sorties the same UTC day: an older
# one that landed, and one that just took off ~1 h before NOW.
_OLDER = _obs(datetime(2026, 7, 20, 20, 0, 0, tzinfo=timezone.utc), 60)   # 20 20–21Z
_NEWER = _obs(NOW - timedelta(hours=1), 50)                              # ~05:00–05:49Z
_OLD_FLID, _NEW_FLID = "20260720I1", "20260721I1"


def _install_iwg1(mp, flights, parse_map):
    """flights: newest-first list of {flid,tail,url}; parse_map: flid -> (obs,label)."""
    mp.setattr(R, "_iwg1_active_flights", lambda now: list(flights))
    # _merge_iwg1 calls _parse_iwg1_text(_iwg1_fetch_text(fl), …). Route the
    # flid through fetch so parse can return that flid's obs.
    mp.setattr(R, "_iwg1_fetch_text", lambda fl: fl["flid"])
    mp.setattr(R, "_parse_iwg1_text",
               lambda flid, sim_now, res=R._IWG1_DECIMATE_S: parse_map[flid])


def test_1_fresh_and_prior_sortie_both_survive():
    """Both the just-launched and the prior sortie must remain after merge —
    the fresh one is the regression (old code let the oldest overwrite it)."""
    flights = [  # newest-first, exactly as _iwg1_active_flights returns
        {"flid": _NEW_FLID, "tail": "NOAA3", "url": "u1"},
        {"flid": _OLD_FLID, "tail": "NOAA3", "url": "u2"},
    ]
    parse = {_NEW_FLID: (_NEWER, "AL022026"), _OLD_FLID: (_OLDER, "AL022026")}
    aircraft, names, src = {}, {}, {}
    mp = _MP()
    try:
        _install_iwg1(mp, flights, parse)
        R._merge_iwg1(aircraft, names, src, NOW)
    finally:
        mp.undo()

    track = [aircraft["NOAA3"][k] for k in sorted(aircraft["NOAA3"])]
    times = {o["t"] for o in track}
    assert _NEWER[0]["t"] in times, "fresh sortie's first ob was dropped"
    assert _NEWER[-1]["t"] in times, "fresh sortie's last ob was dropped"
    assert _OLDER[0]["t"] in times, "prior sortie's obs were dropped"
    assert src["NOAA3"] == "iwg1"
    # _split_sorties must recover TWO selectable flights (5 h idle gap > 3 h).
    sorties = R._split_sorties(track)
    assert len(sorties) == 2, f"expected 2 sorties, got {len(sorties)}"
    assert sorties[-1][-1]["t"] == _NEWER[-1]["t"], \
        "newest sortie must carry the just-launched obs"
    print("test_1_fresh_and_prior_sortie_both_survive: OK")


def test_2_single_active_flight_replaces_hdob():
    """One active IWG1 flight → its obs replace the tail's HDOB track for the
    span it covers (the original intent, still honored)."""
    flights = [{"flid": _NEW_FLID, "tail": "NOAA3", "url": "u1"}]
    parse = {_NEW_FLID: (_NEWER, "AL022026")}
    # Pre-seed an HDOB ob INSIDE the IWG1 span — must be overridden, not mixed.
    inside = (NOW - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    aircraft = {"NOAA3": {inside: {"t": inside, "lat": 9, "lon": 9, "src": "hdob"}}}
    names, src = {}, {}
    mp = _MP()
    try:
        _install_iwg1(mp, flights, parse)
        R._merge_iwg1(aircraft, names, src, NOW)
    finally:
        mp.undo()
    got = aircraft["NOAA3"].get(inside)
    assert got is not None and got.get("src") != "hdob", \
        "HDOB ob inside the IWG1 span should be overridden by the 1-s feed"
    assert src["NOAA3"] == "iwg1"
    print("test_2_single_active_flight_replaces_hdob: OK")


def test_3_hdob_only_sortie_outside_span_survives():
    """An older HDOB-only sortie (before the IWG1 window) must NOT be wiped
    just because the tail also has a live IWG1 flight."""
    flights = [{"flid": _NEW_FLID, "tail": "NOAA3", "url": "u1"}]
    parse = {_NEW_FLID: (_NEWER, "AL022026")}
    far = "2026-07-19T12:00:00Z"   # ~1.75 days before NOW, outside any IWG1 span
    aircraft = {"NOAA3": {far: {"t": far, "lat": 8, "lon": 8, "src": "hdob"}}}
    names, src = {}, {}
    mp = _MP()
    try:
        _install_iwg1(mp, flights, parse)
        R._merge_iwg1(aircraft, names, src, NOW)
    finally:
        mp.undo()
    assert far in aircraft["NOAA3"], \
        "HDOB-only sortie outside the IWG1 span was wrongly dropped"
    assert _NEWER[-1]["t"] in aircraft["NOAA3"], "IWG1 obs missing after merge"
    print("test_3_hdob_only_sortie_outside_span_survives: OK")


def _main():
    tests = [
        test_1_fresh_and_prior_sortie_both_survive,
        test_2_single_active_flight_replaces_hdob,
        test_3_hdob_only_sortie_outside_span_survives,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} IWG1 multi-sortie merge tests passed.")


if __name__ == "__main__":
    _main()
