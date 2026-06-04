"""Load test for the bundle-endpoint OOM guard (fix/bundle-oom-semaphore).

Reproduces the May-2026 failure mode: many concurrent bundle frame-fetches
hitting the heavy S3+render path at once. Before the fix, every bundle worker
called fetch_ir_tb_raw directly, so N concurrent requests could hold N large
float32 cutouts in memory simultaneously and OOM-kill the 4 GiB instance.

The fix routes the cache-miss render through the global _raw_fetch_semaphore
(cap = _RAW_FETCH_MAX_CONCURRENT). This test asserts that no matter how many
workers pile in, the number SIMULTANEOUSLY inside fetch_ir_tb_raw never exceeds
that cap — which is what bounds peak memory.

Run: python3 tests/test_bundle_oom_semaphore.py
"""
import os
import sys
import threading
import time
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ir_monitor_api as M


class _ConcurrencyProbe:
    """Tracks how many threads are inside the heavy fetch at once."""
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


def _make_fake_fetch(probe, hold_s=0.05, cutout=(400, 400)):
    """Stand-in for fetch_ir_tb_raw: records concurrency, simulates the memory
    + latency of a real float32 satellite cutout, returns a valid raw dict."""
    def _fake(interp_lat, interp_lon, target_dt, box_deg, **kw):
        probe.enter()
        try:
            scratch = np.random.rand(*cutout).astype(np.float32)  # ~0.6 MB held
            time.sleep(hold_s)                                    # S3 latency
            return {
                "tb": scratch,
                "datetime_utc": target_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "satellite": "TEST",
                "bounds": [[interp_lat - 5, interp_lon - 5],
                           [interp_lat + 5, interp_lon + 5]],
            }
        finally:
            probe.leave()
    return _fake


def _run_burst(target, n_workers, probe):
    """Fire n_workers threads at `target` simultaneously via a start barrier."""
    start = threading.Barrier(n_workers + 1)
    errors = []
    results = []

    def _job(i):
        start.wait()
        try:
            results.append(target(i))
        except Exception as ex:  # noqa: BLE001
            errors.append(repr(ex))

    threads = [threading.Thread(target=_job, args=(i,)) for i in range(n_workers)]
    for t in threads:
        t.start()
    start.wait()  # release all at once → maximal contention
    for t in threads:
        t.join()
    return results, errors


def main():
    N = 40  # simulate ~7 concurrent bundles x several frames each
    cap = M._RAW_FETCH_MAX_CONCURRENT
    storm = {"vmax_kt": None}  # None → skip the >=65kt center-fix branch
    base_dt = datetime.now(timezone.utc)

    # Force every call down the cache-MISS (heavy) path, no real GCS.
    M._gcs_rt_get = lambda *a, **k: None
    M._gcs_rt_put = lambda *a, **k: None

    # ---- Test 1: the GUARDED public worker must never exceed the cap ----
    probe = _ConcurrencyProbe()
    M.fetch_ir_tb_raw = _make_fake_fetch(probe)

    def guarded(i):
        return M._fetch_one_raw_tb_for_bundle(
            "TEST01", storm, base_dt, 10.0,
            20.0 + i * 0.01, -60.0 + i * 0.01,  # distinct interp pos per call
        )

    results, errors = _run_burst(guarded, N, probe)
    ok_results = sum(1 for r in results if isinstance(r, dict))

    print(f"[guarded]   workers={N}  cap={cap}  peak_concurrency={probe.peak}  "
          f"heavy_calls={probe.calls}  ok_frames={ok_results}  errors={len(errors)}")
    assert not errors, f"unexpected errors: {errors[:3]}"
    assert probe.peak <= cap, (
        f"FAIL: {probe.peak} concurrent heavy fetches > cap {cap} — OOM guard not holding")
    assert ok_results == N, f"FAIL: only {ok_results}/{N} frames rendered"

    # ---- Test 2 (sensitivity): the UNGUARDED inner path SHOULD exceed cap,
    #      proving the test can actually detect a regression / missing guard ----
    probe2 = _ConcurrencyProbe()
    M.fetch_ir_tb_raw = _make_fake_fetch(probe2)

    def unguarded(i):
        return M._render_one_raw_tb_for_bundle(
            "TEST01", base_dt, 10.0,
            20.0 + i * 0.01, -60.0 + i * 0.01,
            20.0, 10.0, base_dt.strftime("%Y%m%d%H%M"), None,
        )

    _run_burst(unguarded, N, probe2)
    print(f"[unguarded] workers={N}  cap={cap}  peak_concurrency={probe2.peak}  "
          f"(expected > cap, confirms the probe is sensitive)")
    assert probe2.peak > cap, (
        "sensitivity check failed: even the unguarded path stayed under cap — "
        "the test isn't exercising real concurrency")

    print("\nPASS: bundle burst is bounded to the OOM-safe concurrency cap; "
          "peak memory cannot scale with request count.")


if __name__ == "__main__":
    main()
