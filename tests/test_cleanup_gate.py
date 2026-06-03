"""
test_cleanup_gate.py — unit tests for the hourly-gated GCS frame cleanup.

Covers the GCS-persisted marker gate that throttles
``_cleanup_old_gcs_frames`` from running every ~10-min prewarm cycle down
to at most once per hour. The standalone prewarm runs as a Cloud Run Job
(fresh process each cycle), so the gate state lives in a GCS marker object
rather than in-memory; these tests drive that marker + the clock with
monkeypatched fakes — no live GCS.

Runnable standalone:  python3 tests/test_cleanup_gate.py
or under pytest:      python3 -m pytest tests/test_cleanup_gate.py
"""

import os
import sys

# ── sys.path bootstrap so `import ir_monitor_api` works whether this file
#    is run from the repo root, from tests/, or via pytest. ───────────────
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import ir_monitor_api as ir  # noqa: E402


# ── Fake GCS primitives ─────────────────────────────────────────────────
class _NotFound(Exception):
    """Stand-in for google.cloud.exceptions.NotFound."""


class FakeBlob:
    """Minimal blob: holds string contents and records the last upload."""

    def __init__(self, store, key):
        self._store = store
        self._key = key
        # Attributes the production code sets/passes through.
        self.cache_control = None

    def download_as_text(self, timeout=None):
        if self._key not in self._store:
            raise _NotFound(f"no such object: {self._key}")
        val = self._store[self._key]
        if val is None:
            raise _NotFound(f"no such object: {self._key}")
        return val

    def upload_from_string(self, data, content_type=None, timeout=None,
                           predefined_acl=None):
        self._store[self._key] = data
        self._store["__last_upload__"] = {
            "key": self._key,
            "data": data,
            "content_type": content_type,
        }


class FakeBucket:
    def __init__(self, store):
        self._store = store

    def blob(self, key):
        return FakeBlob(self._store, key)


class ExplodingBlob:
    """Blob whose every operation raises — simulates transient read error."""

    def download_as_text(self, timeout=None):
        raise RuntimeError("boom")

    def upload_from_string(self, *a, **k):
        raise RuntimeError("boom")


class ExplodingBucket:
    def blob(self, key):
        return ExplodingBlob()


# ── Test harness helpers ────────────────────────────────────────────────
def _install_bucket(monkeypatch, bucket):
    monkeypatch.setattr(ir, "_get_rt_gcs_bucket", lambda: bucket)


def _install_clock(monkeypatch, clock):
    """clock is a 1-element list holding the current fake time()."""
    monkeypatch.setattr(ir.time, "time", lambda: clock[0])


# ── Tests ───────────────────────────────────────────────────────────────
def test_due_when_marker_missing(monkeypatch):
    store = {}
    _install_bucket(monkeypatch, FakeBucket(store))
    clock = [10_000.0]
    _install_clock(monkeypatch, clock)
    assert ir._cleanup_due() is True


def test_not_due_within_hour(monkeypatch):
    store = {}
    _install_bucket(monkeypatch, FakeBucket(store))
    clock = [10_000.0]
    _install_clock(monkeypatch, clock)

    ir._cleanup_mark_done()  # stamps marker at t=10_000
    assert store[ir._CLEANUP_MARKER_KEY] == "10000.0"

    # 59 minutes later → still within the hour → NOT due.
    clock[0] = 10_000.0 + 59 * 60
    assert ir._cleanup_due() is False


def test_due_after_interval(monkeypatch):
    store = {}
    _install_bucket(monkeypatch, FakeBucket(store))
    clock = [10_000.0]
    _install_clock(monkeypatch, clock)

    ir._cleanup_mark_done()

    # Exactly 3600s later → due (>= boundary).
    clock[0] = 10_000.0 + ir._CLEANUP_INTERVAL_SEC
    assert ir._cleanup_due() is True

    # Well past → still due.
    clock[0] = 10_000.0 + 7200
    assert ir._cleanup_due() is True


def test_corrupt_marker_runs_and_rewrites(monkeypatch):
    store = {ir._CLEANUP_MARKER_KEY: "not-a-float"}
    _install_bucket(monkeypatch, FakeBucket(store))
    clock = [55_555.0]
    _install_clock(monkeypatch, clock)

    # Garbled contents → fail-OPEN → due.
    assert ir._cleanup_due() is True

    # And marking done rewrites a clean float marker.
    ir._cleanup_mark_done()
    assert store[ir._CLEANUP_MARKER_KEY] == "55555.0"
    assert float(store[ir._CLEANUP_MARKER_KEY]) == 55_555.0
    # Subsequent check within the hour now correctly gates.
    clock[0] = 55_555.0 + 100
    assert ir._cleanup_due() is False


def test_empty_marker_fails_open(monkeypatch):
    store = {ir._CLEANUP_MARKER_KEY: "   "}
    _install_bucket(monkeypatch, FakeBucket(store))
    _install_clock(monkeypatch, [1.0])
    assert ir._cleanup_due() is True


def test_bucket_unavailable_skips(monkeypatch):
    _install_bucket(monkeypatch, None)
    _install_clock(monkeypatch, [1.0])
    # No bucket → skip (False), and mark_done is a silent no-op.
    assert ir._cleanup_due() is False
    ir._cleanup_mark_done()  # must not raise


def test_transient_read_error_fails_open(monkeypatch):
    _install_bucket(monkeypatch, ExplodingBucket())
    _install_clock(monkeypatch, [1.0])
    # Read blows up → fail-open → due.
    assert ir._cleanup_due() is True
    # mark_done swallows the upload error.
    ir._cleanup_mark_done()  # must not raise


def test_marker_content_type_is_text(monkeypatch):
    store = {}
    _install_bucket(monkeypatch, FakeBucket(store))
    _install_clock(monkeypatch, [42.0])
    ir._cleanup_mark_done()
    assert store["__last_upload__"]["content_type"] == "text/plain"
    assert store["__last_upload__"]["key"] == ir._CLEANUP_MARKER_KEY


def test_callsite_integration_runs_once_per_hour(monkeypatch):
    """Simulate the prewarm call-site gate over many 10-min cycles and
    confirm _cleanup_old_gcs_frames is invoked ~once/hour, not once/cycle.

    We replicate the exact call-site logic:
        if _cleanup_due():
            _cleanup_old_gcs_frames(storms)
            _cleanup_mark_done()
    driving _cleanup_due()/_cleanup_mark_done() through a real FakeBucket
    marker + a fake clock, with _cleanup_old_gcs_frames swapped for a
    counter.
    """
    store = {}
    _install_bucket(monkeypatch, FakeBucket(store))
    clock = [0.0]
    _install_clock(monkeypatch, clock)

    calls = {"n": 0}
    monkeypatch.setattr(
        ir, "_cleanup_old_gcs_frames",
        lambda storms: calls.__setitem__("n", calls["n"] + 1),
    )

    storms = [{"atcf_id": "AL012025"}]
    cycle_sec = 10 * 60          # 10-min prewarm cadence
    n_cycles = 24 * 6            # 24 simulated hours = 144 cycles

    for i in range(n_cycles):
        clock[0] = i * cycle_sec
        if ir._cleanup_due():
            ir._cleanup_old_gcs_frames(storms)
            ir._cleanup_mark_done()

    # 144 cycles over 24h: first cycle runs (marker missing → fail-open),
    # then once per full hour thereafter. Expect ~24-25 runs, definitely
    # far fewer than 144 (one-per-cycle), and at least ~1/hour.
    assert calls["n"] == 24, calls["n"]
    assert calls["n"] < n_cycles


# ── Standalone runner (no pytest required) ──────────────────────────────
class _MP:
    """Tiny monkeypatch shim so tests run without pytest installed."""

    def __init__(self):
        self._undo = []

    def setattr(self, target, name, value=None):
        if value is None:  # setattr(module.attr_path, val) form unused here
            raise NotImplementedError
        old = getattr(target, name)
        self._undo.append((target, name, old))
        setattr(target, name, value)

    def undo(self):
        for target, name, old in reversed(self._undo):
            setattr(target, name, old)
        self._undo.clear()


def _main():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failures = 0
    for fn in tests:
        mp = _MP()
        try:
            fn(mp)
            print(f"PASS  {fn.__name__}")
        except Exception as ex:  # noqa: BLE001
            failures += 1
            import traceback
            print(f"FAIL  {fn.__name__}: {ex!r}")
            traceback.print_exc()
        finally:
            mp.undo()
    total = len(tests)
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(_main())
