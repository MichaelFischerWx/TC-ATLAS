"""Tests for the overpass-aware microwave-ingest gate
(perf/mw-overpass-aware-ingest).

The operational `--operational` run reads passes_predicted.json and only
does the rapid frontfill pickup for sensors that are currently inside a
window around their predicted data-availability time (eta_on_tcatlas).
Ticks with no in-window sensor (and no safety-net full backfill due)
early-exit BEFORE any PPS auth/listing — that's what keeps the tighter
*/10 cron cost-neutral. A MISSING or STALE prediction, or the periodic
safety-net being due, forces a full run so data is never lost.

These tests drive `_cli(["--operational", ...])` end-to-end with the
network, GCS, clock, and heavy render monkeypatched — no credentials, no
PPS, no GCS. We assert on whether `_pps_session` / `list_pps_granules`
were called (the expensive paths) and which sensors they ran for.

Run standalone:  python3 tests/test_mw_overpass_gate.py
or via pytest:   python3 -m pytest tests/test_mw_overpass_gate.py
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

# ── sys.path bootstrap so `import mw_ingest` works from repo root, from
#    tests/, or via pytest. ────────────────────────────────────────────
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import mw_ingest as M  # noqa: E402


NOW = datetime(2026, 6, 5, 12, 0, 0, tzinfo=timezone.utc)


# ── A harness that wires up every dependency the operational run touches
#    before (and through) the gate, recording what got called. ──────────
class _Harness:
    def __init__(self, passes_doc, full_run_due=False,
                 active_storms=None):
        # passes_doc: dict to serialize as passes_predicted.json, or the
        # sentinel object MISSING to make _download_text return None.
        self.passes_doc = passes_doc
        self.full_run_due = full_run_due
        # Non-empty by default so the quiet-day narrowing does NOT fire
        # (we want the full sensor list reaching the overpass gate).
        self.active_storms = (
            active_storms if active_storms is not None else [{"x": 1}])

        self.pps_session_calls = 0
        self.list_calls = []          # (sensor, since) per list_pps_granules
        self.marker_written = []      # timestamps stamped via _full_run_mark_done
        self.manifest_updates = 0

    def install(self, mp):
        M_ = M
        # Clock: freeze _dt.now and time.time consistently.
        class _FrozenDT(M_._dt):
            @classmethod
            def now(cls, tz=None):
                return NOW if tz else NOW.replace(tzinfo=None)
        mp(M_, "_dt", _FrozenDT)
        mp(M_.time, "time", lambda: NOW.timestamp())

        # GCS reads: passes_predicted.json + the safety-net marker.
        def _download_text(key):
            if key == M_.PASSES_KEY:
                if self.passes_doc is MISSING:
                    return None
                return json.dumps(self.passes_doc)
            if key == M_._FULL_RUN_MARKER_KEY:
                # Return a marker old/new enough to drive _full_run_due.
                if self.full_run_due:
                    return str(NOW.timestamp() - 3 * 3600)  # 3h ago → due
                return str(NOW.timestamp() - 60)            # 1 min ago → not due
            return None
        mp(M_, "_download_text", _download_text)

        # Safety-net marker write (spy; no GCS).
        def _mark_done(now_ts=None):
            self.marker_written.append(now_ts or NOW.timestamp())
        mp(M_, "_full_run_mark_done", _mark_done)

        # Lock: always acquire; release is a no-op.
        mp(M_, "_acquire_ingest_lock", lambda *_a, **_k: True)
        mp(M_, "_release_ingest_lock", lambda *_a, **_k: None)

        # Quiet-day gate inputs — non-empty → full sensor list preserved.
        mp(M_, "_fetch_active_storms", lambda: self.active_storms)
        mp(M_, "_fetch_genesis_disturbances", lambda: [])

        # Staleness sort input (avoids a real manifest read).
        mp(M_, "_last_processed_start_utc",
           lambda sensor=None: NOW - timedelta(hours=1))

        # The expensive paths we're gating — spies that record calls.
        def _pps_session():
            self.pps_session_calls += 1
            return object()
        mp(M_, "_pps_session", _pps_session)

        def _list_pps_granules(sensor, since, until=None):
            self.list_calls.append((sensor, since))
            return []   # no granules → no download/render needed
        mp(M_, "list_pps_granules", _list_pps_granules)

        # Frontfill skip guard short-circuit (not reached with [] granules,
        # but patch defensively).
        mp(M_, "_frontfill_skip_granule", lambda *_a, **_k: True)

        # Manifest write (no GCS).
        def _update_manifest(entries):
            self.manifest_updates += 1
        mp(M_, "_update_manifest", _update_manifest)
        # update_manifest is referenced by name in the module.
        mp(M_, "update_manifest", _update_manifest)

    @property
    def list_sensors(self):
        return [s for (s, _since) in self.list_calls]


MISSING = object()  # sentinel: passes file absent


# ── Minimal monkeypatch context (no pytest dependency required) ─────────
class _MP:
    def __init__(self):
        self._undo = []

    def setattr(self, obj, name, value):
        had = hasattr(obj, name)
        old = getattr(obj, name, None)
        self._undo.append((obj, name, had, old))
        setattr(obj, name, value)

    def undo(self):
        for obj, name, had, old in reversed(self._undo):
            if had:
                setattr(obj, name, old)
            else:
                try:
                    delattr(obj, name)
                except AttributeError:
                    pass
        self._undo = []


def _run_cli(harness, sensors="GMI,AMSR2,SSMIS,ATMS"):
    mp = _MP()
    try:
        harness.install(mp.setattr)
        # --no-manifest keeps the test off the manifest path entirely.
        M._cli(["--operational", "--sensors", sensors, "--no-manifest"])
    finally:
        mp.undo()


def _pass(sensor, eta_dt):
    return {"sensor": sensor, "platform": "X",
            "predicted_scan_start": eta_dt.isoformat(),
            "eta_on_tcatlas": eta_dt.isoformat(),
            "min_distance_km": 10.0, "coverage_frac": 0.5}


def _doc(passes, updated=None):
    return {
        "updated": (updated or NOW).isoformat(),
        "horizon_hours": 24,
        "storms": [{"atcf_id": "WP012026", "passes": passes}],
    }


# ─────────────────────────── Tests ──────────────────────────────────────
def test_1_in_window_sensor_frontfills():
    """A sensor whose eta is right now (in-window) → frontfill runs for it;
    _pps_session IS called (we entered the real run)."""
    # GMI eta = now → in-window. Others far in the future → out-of-window.
    far = NOW + timedelta(hours=10)
    doc = _doc([_pass("GMI", NOW),
                _pass("SSMIS", far), _pass("AMSR2", far), _pass("ATMS", far)])
    h = _Harness(doc, full_run_due=False)
    _run_cli(h)
    assert h.pps_session_calls == 1, "expected the real run (session created)"
    # Frontfill listed GMI (in-window). Backfill is skipped (safety-net not
    # due, gate_full_run False), so GMI should be the only listed sensor.
    assert "GMI" in h.list_sensors, h.list_sensors
    assert set(h.list_sensors) == {"GMI"}, (
        "only in-window GMI should be listed", h.list_sensors)
    # In-window-only tick: full backfill skipped, marker NOT re-stamped.
    assert h.marker_written == [], (
        "in-window-only tick must not stamp the full-run marker",
        h.marker_written)
    print("test_1_in_window_sensor_frontfills: OK")


def test_2_all_out_of_window_cheap_exit():
    """No sensor in-window AND safety-net not due → cheap early-exit
    BEFORE _pps_session; nothing listed."""
    far = NOW + timedelta(hours=10)
    doc = _doc([_pass("GMI", far), _pass("SSMIS", far),
                _pass("AMSR2", far), _pass("ATMS", far)])
    h = _Harness(doc, full_run_due=False)
    _run_cli(h)
    assert h.pps_session_calls == 0, "early-exit must not create a PPS session"
    assert h.list_calls == [], "early-exit must not list any granules"
    assert h.marker_written == [], "early-exit must not stamp full-run marker"
    print("test_2_all_out_of_window_cheap_exit: OK")


def test_3_passes_missing_full_run():
    """passes_predicted.json absent → full run (fallback). Every active
    sensor is listed (frontfill + backfill); safety-net marker stamped."""
    h = _Harness(MISSING, full_run_due=False)
    _run_cli(h)
    assert h.pps_session_calls == 1
    # Full run → all four sensors reach listing.
    assert set(h.list_sensors) == {"GMI", "AMSR2", "SSMIS", "ATMS"}, \
        h.list_sensors
    assert h.marker_written, "full run must stamp the safety-net marker"
    print("test_3_passes_missing_full_run: OK")


def test_4_passes_stale_full_run():
    """passes_predicted.json older than 2.5h → full run."""
    stale_updated = NOW - timedelta(hours=3)   # > 2.5h
    far = NOW + timedelta(hours=10)
    doc = _doc([_pass("GMI", far)], updated=stale_updated)
    h = _Harness(doc, full_run_due=False)
    _run_cli(h)
    assert h.pps_session_calls == 1
    assert set(h.list_sensors) == {"GMI", "AMSR2", "SSMIS", "ATMS"}, \
        h.list_sensors
    assert h.marker_written, "stale → full run must stamp the marker"
    print("test_4_passes_stale_full_run: OK")


def test_5_safety_net_due_full_backfill():
    """No sensor in-window but the safety-net full backfill is DUE (>2h
    since last full run) → full backfill runs over all active sensors."""
    far = NOW + timedelta(hours=10)
    doc = _doc([_pass("GMI", far), _pass("SSMIS", far),
                _pass("AMSR2", far), _pass("ATMS", far)])
    h = _Harness(doc, full_run_due=True)
    _run_cli(h)
    assert h.pps_session_calls == 1, "safety-net run must create a session"
    # No sensor in-window → no frontfill; but backfill runs for all sensors.
    assert set(h.list_sensors) == {"GMI", "AMSR2", "SSMIS", "ATMS"}, \
        h.list_sensors
    assert h.marker_written, "safety-net run must re-stamp the marker"
    print("test_5_safety_net_due_full_backfill: OK")


def test_6_window_math_per_sensor_pad():
    """Per-sensor window math: window = [eta - PRE_PAD, eta + POST_PAD],
    POST_PAD is sensor-specific (GMI/ATMS 90m, SSMIS/AMSR2 120m)."""
    eta = NOW
    doc = _doc([_pass("GMI", eta), _pass("SSMIS", eta)])
    mp = _MP()
    try:
        mp.setattr(M, "_download_text",
                   lambda key: json.dumps(doc) if key == M.PASSES_KEY else None)
        windows, status = M._pass_windows(now=NOW)
    finally:
        mp.undo()
    assert status == "ok", status

    pre = timedelta(minutes=M._OVERPASS_PRE_PAD_MIN)
    (g_start, g_end), = windows["GMI"]
    assert g_start == eta - pre
    assert g_end == eta + timedelta(minutes=90), g_end   # GMI POST_PAD
    (s_start, s_end), = windows["SSMIS"]
    assert s_start == eta - pre
    assert s_end == eta + timedelta(minutes=120), s_end  # SSMIS POST_PAD

    # In-window detection at the pad boundaries.
    just_in_gmi = eta + timedelta(minutes=89)
    just_out_gmi = eta + timedelta(minutes=91)
    assert "GMI" in M._in_window_sensors(windows, now=just_in_gmi)
    assert "GMI" not in M._in_window_sensors(windows, now=just_out_gmi)
    # SSMIS still in-window at +91m (120m pad), GMI is not.
    hot = M._in_window_sensors(windows, now=just_out_gmi)
    assert hot == {"SSMIS"}, hot
    # PRE_PAD: in-window 29m before eta, out 31m before.
    assert "GMI" in M._in_window_sensors(
        windows, now=eta - timedelta(minutes=29))
    assert "GMI" not in M._in_window_sensors(
        windows, now=eta - timedelta(minutes=31))
    print("test_6_window_math_per_sensor_pad: OK")


def _main():
    tests = [
        test_1_in_window_sensor_frontfills,
        test_2_all_out_of_window_cheap_exit,
        test_3_passes_missing_full_run,
        test_4_passes_stale_full_run,
        test_5_safety_net_due_full_backfill,
        test_6_window_math_per_sensor_pad,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} overpass-gate tests passed.")


if __name__ == "__main__":
    _main()
