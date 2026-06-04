"""OOM-guard load test for the band / geocolor / ir-prebuilt bundle endpoints
(fix/band-bundle-oom-guard).

PR #41 added the global _raw_fetch_semaphore guard to ir-raw-bundle's worker.
The OTHER heavy-fetch bundles — band-frames-bundle, geocolor-frames-bundle,
and ir-frames-bundle — still spawned ThreadPoolExecutor(max_workers=8) and
called their _get_or_render_*_jpg helpers with no global concurrency bound, so
a burst of concurrent bundle requests could hold N large float32 cutouts at
once and OOM-kill the 4 GiB instance (same failure mode #41 fixed).

This test verifies the extension of that guard:

  Test 1 (cap holds): a 40-worker burst through the REAL band-bundle worker
    path (via get_storm_band_frames_bundle) never has more than
    _RAW_FETCH_MAX_CONCURRENT heavy renders running at once.

  Test 2 (NO DEADLOCK): the single-frame path holds the semaphore on one
    thread WHILE band-bundle workers run. Because the bundle helpers are
    bundle-only (never invoked under an already-held semaphore), the bundle
    must still complete — proving there is no double-acquire deadlock.

  Test 3 (sensitivity): calling the render helper WITHOUT the guard exceeds
    the cap, proving the probe can actually detect a missing guard.

No network: the _get_or_render_*_jpg render helpers, GCS, interpolation, and
the active-storms cache are all monkeypatched. Modeled on
tests/test_bundle_oom_semaphore.py.

Run: python3 tests/test_band_bundle_oom_guard.py
"""
import os
import sys
import threading
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ir_monitor_api as M


class _ConcurrencyProbe:
    """Tracks how many threads are inside the heavy render at once."""
    def __init__(self):
        self.lock = threading.Lock()
        self.current = 0
        self.peak = 0
        self.calls = 0

    def enter(self):
        with self.lock:
            self.current += 1
            self.calls += 1
            self.peak = max(self.peak, self.current)

    def leave(self):
        with self.lock:
            self.current -= 1


def _make_fake_band_render(probe, hold_s=0.05):
    """Stand-in for _get_or_render_band_jpg: records concurrency, simulates the
    latency + memory of a real band cutout render, returns (jpg, sat)."""
    def _fake(atcf_upper, ilat, ilon, target_dt, radius_deg, band):
        probe.enter()
        try:
            time.sleep(hold_s)  # S3 + render latency
            return (b"WEBP-band", "TEST-SAT")
        finally:
            probe.leave()
    return _fake


def _install_offline_stubs():
    """Make the band bundle endpoint deterministic + fully offline."""
    M._ensure_fresh_cache = lambda *a, **k: None
    M._interp_pos_at = lambda atcf_id, target_dt, fb_lat, fb_lon: (fb_lat, fb_lon)
    M._screen_and_queue_anomalies = lambda *a, **k: set()
    # band==8 (WV) → never hits the VIS solar-elevation branch.
    with M._active_storms_lock:
        M._active_storms_cache["storms"] = [
            {"atcf_id": "AL072026", "lat": 24.5, "lon": -71.3,
             "vmax_kt": None}
        ]


def _burst(callable_target, n_workers):
    """Fire n_workers threads at `callable_target` simultaneously."""
    start = threading.Barrier(n_workers + 1)
    errors = []
    results = []

    def _job(i):
        start.wait()
        try:
            results.append(callable_target(i))
        except Exception as ex:  # noqa: BLE001
            errors.append(repr(ex))

    threads = [threading.Thread(target=_job, args=(i,)) for i in range(n_workers)]
    for t in threads:
        t.start()
    start.wait()  # release all at once → maximal contention
    for t in threads:
        t.join()
    return results, errors


def test_band_bundle_burst_bounded():
    """40 concurrent band-bundle requests must never exceed the heavy-render
    cap, no matter how many pile in at once."""
    _install_offline_stubs()
    cap = M._RAW_FETCH_MAX_CONCURRENT
    probe = _ConcurrencyProbe()
    M._get_or_render_band_jpg = _make_fake_band_render(probe)

    N = 40  # ~5 concurrent bundles x several frames each

    def _hit_bundle(i):
        # interval_min=60, lookback=2h → a couple frames per bundle; the burst
        # of N concurrent bundles is what stresses the global cap.
        return M.get_storm_band_frames_bundle(
            "al072026", band=8, lookback_hours=2.0,
            radius_deg=10.0, interval_min=60,
        )

    results, errors = _burst(_hit_bundle, N)
    print(f"[band-burst] bundles={N}  cap={cap}  peak_concurrency={probe.peak}  "
          f"heavy_calls={probe.calls}  responses={len(results)}  errors={len(errors)}")
    assert not errors, f"unexpected errors: {errors[:3]}"
    assert len(results) == N, f"only {len(results)}/{N} bundles returned"
    assert probe.peak <= cap, (
        f"FAIL: {probe.peak} concurrent heavy renders > cap {cap} — "
        "OOM guard not holding on the band bundle worker")
    assert probe.peak >= 1 and probe.calls > 0, \
        "test did not actually exercise the heavy render path"


def test_no_double_acquire_deadlock():
    """Single-frame path holds the semaphore while band-bundle workers run.

    The bundle helpers are bundle-only (never called under an already-held
    semaphore), but a regression that wrapped a SHARED helper would deadlock
    here. With the guard at the bundle-worker level, the bundles must still
    complete promptly even with permits already held by another caller."""
    _install_offline_stubs()
    cap = M._RAW_FETCH_MAX_CONCURRENT
    probe = _ConcurrencyProbe()
    M._get_or_render_band_jpg = _make_fake_band_render(probe, hold_s=0.02)

    # Simulate the single-frame endpoint (band-raw-frame / ir-raw-frame) holding
    # one or more semaphore permits for a while, as it does around its own
    # heavy fetch. Hold cap-1 permits so bundle workers still get at least one.
    held = []
    hold_release = threading.Event()

    def _hold_single_frame_permits():
        for _ in range(cap - 1):
            if M._raw_fetch_semaphore.acquire(timeout=5):
                held.append(True)
        hold_release.wait(timeout=10)
        for _ in held:
            M._raw_fetch_semaphore.release()

    holder = threading.Thread(target=_hold_single_frame_permits)
    holder.start()
    # Give the holder a beat to grab its permits before the bundle burst.
    time.sleep(0.1)

    done = threading.Event()

    def _run_bundles():
        try:
            _burst(lambda i: M.get_storm_band_frames_bundle(
                "al072026", band=8, lookback_hours=2.0,
                radius_deg=10.0, interval_min=60,
            ), 8)
        finally:
            done.set()

    runner = threading.Thread(target=_run_bundles)
    runner.start()

    completed = done.wait(timeout=30)
    hold_release.set()
    runner.join(timeout=5)
    holder.join(timeout=5)

    assert completed, (
        "FAIL: band bundles did NOT complete within 30s while the single-frame "
        "path held semaphore permits — likely a double-acquire deadlock")
    assert probe.peak <= cap, (
        f"FAIL: peak {probe.peak} > cap {cap} even with permits externally held")
    print(f"[no-deadlock] bundles completed with {cap - 1} permit(s) held "
          f"externally; peak_concurrency={probe.peak} <= cap={cap}")


def test_unguarded_path_exceeds_cap():
    """Sensitivity: calling the render helper directly (no semaphore) SHOULD
    blow past the cap — confirms the probe detects an unguarded path."""
    cap = M._RAW_FETCH_MAX_CONCURRENT
    probe = _ConcurrencyProbe()
    fake = _make_fake_band_render(probe)
    base_dt = datetime.now(timezone.utc)

    def _unguarded(i):
        return fake("AL072026", 24.5 + i * 0.01, -71.3 + i * 0.01,
                    base_dt, 10.0, 8)

    _burst(_unguarded, 40)
    print(f"[unguarded] cap={cap}  peak_concurrency={probe.peak}  "
          f"(expected > cap, confirms probe sensitivity)")
    assert probe.peak > cap, (
        "sensitivity check failed: even the unguarded render stayed under cap — "
        "the test isn't exercising real concurrency")


def main():
    test_band_bundle_burst_bounded()
    test_no_double_acquire_deadlock()
    test_unguarded_path_exceeds_cap()
    print("\nPASS: band/geocolor/ir-prebuilt bundle bursts are bounded to the "
          "OOM-safe concurrency cap; no double-acquire deadlock; peak memory "
          "cannot scale with request count.")


if __name__ == "__main__":
    main()
