#!/usr/bin/env python3
"""Tests for the LIST-once prewarm existence path (Item 6).

Runnable standalone:  python3 tests/test_prewarm_list_membership.py

These tests do NOT require a live GCS bucket. A fake bucket records every
object name written (so we can prove KEY PARITY between the writer and the
shared key formatter) and answers list_blobs / .exists() from an in-memory
set so we can exercise the prewarm short-circuit.

Coverage:
  (1) KEY PARITY  — _ir_raw_key / _band_raw_key produce EXACTLY the object
      name _gcs_rt_put / _gcs_band_put write for the same args.
  (2) FULL CACHE HIT — every key present in the LIST set → zero heavy fetches
      for non-force frames.
  (3) COLD CACHE — empty LIST set → every non-force frame fetches.
  (4) LIST FAILURE — _gcs_rt_list_keys returns None → workers fall back to the
      per-object .exists() path; no crash, correctness preserved.
"""
import os
import sys
import time
import threading

# ── sys.path bootstrap to repo root ────────────────────────────────
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import ir_monitor_api as M  # noqa: E402


# ── Fake GCS plumbing ──────────────────────────────────────────────
class _FakeBlob:
    def __init__(self, bucket, name):
        self._bucket = bucket
        self.name = name

    def upload_from_string(self, *a, **k):
        # Record synchronously so the test can read it back after a short
        # join (the real _gcs_rt_put/_gcs_band_put upload on a daemon thread).
        with self._bucket._lock:
            self._bucket.written.add(self.name)

    def exists(self, *a, **k):
        with self._bucket._lock:
            self._bucket.exists_calls.append(self.name)
            return self.name in self._bucket.present


class _FakeBucket:
    def __init__(self, present=None):
        # `present` = object names the LIST/exists path should report as
        # already cached.
        self.present = set(present or ())
        self.written = set()
        self.list_calls = []
        self.exists_calls = []
        self.list_should_raise = False
        self._lock = threading.Lock()

    def blob(self, name):
        return _FakeBlob(self, name)

    def list_blobs(self, prefix=None, timeout=None):
        with self._lock:
            self.list_calls.append(prefix)
            if self.list_should_raise:
                raise RuntimeError("simulated LIST failure")
            return [
                _FakeBlob(self, n)
                for n in sorted(self.present)
                if prefix is None or n.startswith(prefix)
            ]


def _install_bucket(monkey_state, bucket):
    """Point ir_monitor_api at our fake bucket."""
    monkey_state["orig_get"] = M._get_rt_gcs_bucket
    M._get_rt_gcs_bucket = lambda: bucket


def _restore(monkey_state):
    if "orig_get" in monkey_state:
        M._get_rt_gcs_bucket = monkey_state["orig_get"]


def _join_daemon_writes():
    """_gcs_*_put upload on daemon threads; give them a moment to record."""
    deadline = time.time() + 2.0
    while threading.active_count() > 1 and time.time() < deadline:
        time.sleep(0.01)
    time.sleep(0.05)


# ── Test 1: KEY PARITY ─────────────────────────────────────────────
def test_key_parity():
    state = {}
    bucket = _FakeBucket()
    _install_bucket(state, bucket)
    try:
        atcf = "AL072024"           # already .upper()'d at the call sites
        dt_str = "202409151200"
        lat, lon, rad = 24.37, -71.94, M._PREFETCH_RADIUS_DEG

        # IR raw -------------------------------------------------------
        M._gcs_rt_put(atcf, dt_str, {"x": 1}, lat=lat, lon=lon, radius_deg=rad)
        _join_daemon_writes()
        expected_ir = M._ir_raw_key(atcf, dt_str, lat, lon, rad)
        assert bucket.written == {expected_ir}, (
            f"IR writer wrote {bucket.written}, formatter said {expected_ir}"
        )

        # Band raw -----------------------------------------------------
        bucket.written.clear()
        band = M.SWIR_BAND
        M._gcs_band_put(band, atcf, dt_str, {"y": 2}, lat=lat, lon=lon)
        _join_daemon_writes()
        expected_band = M._band_raw_key(band, atcf, dt_str, lat, lon)
        assert bucket.written == {expected_band}, (
            f"Band writer wrote {bucket.written}, formatter said {expected_band}"
        )

        # The reader (_gcs_rt_get) must also build the same key the writer
        # wrote — prove it round-trips a hit, not a miss.
        bucket.present.add(expected_ir)
        # download path differs; just confirm key parity via list set:
        got = M._gcs_rt_list_keys(f"{M._GCS_RT_VERSION}/ir-raw/{atcf}/")
        assert expected_ir in got
    finally:
        _restore(state)
    print("PASS test_key_parity")


# ── Shared harness for the prewarm worker tests ────────────────────
def _run_prewarm(bucket, *, record):
    """Drive _prefetch_ir_frames with one storm, stubbing every heavy
    collaborator so only the membership decision + (maybe) the fetch runs.

    `record` is a dict the stubbed fetchers append into when called.
    Returns nothing; assertions read `record` and the bucket.
    """
    state = {}
    _install_bucket(state, bucket)

    saved = {}

    def _save(name, val):
        saved[name] = getattr(M, name)
        setattr(M, name, val)

    try:
        # Force a tiny, deterministic frame window (newest→oldest).
        _save("_PREFETCH_LOOKBACK_HOURS", 0.5)   # 30 min
        _save("_PREFETCH_INTERVAL_MIN", 10)      # → ~3-4 slots
        _save("_SELF_HEAL_FRAMES", 0)            # no forced leading edge
        _save("_RENDER_ONCE", False)             # skip manifest GCS IO

        # Always-night so extra_bands == [SWIR] only (no VIS daylight path).
        _save("_solar_elevation", lambda *a, **k: -90.0)
        # Stable interpolated position so keys are deterministic.
        _save("_interp_pos_at", lambda atcf, tdt, flat, flon: (flat, flon))

        # Heavy fetchers — record calls; return a minimal valid payload so
        # the cache-write branch runs (cold-cache test wants real writes).
        def _fake_ir(ilat, ilon, tdt, box, max_substitution_min=None):
            record["ir"].append(tdt)
            return None  # short-circuit before JPG/encode — we only need to
            # know whether the fetch was attempted.

        def _fake_band(ilat, ilon, tdt, box, band=None,
                       max_substitution_min=None):
            record["band"].append((band, tdt))
            return None

        _save("fetch_ir_tb_raw", _fake_ir)
        _save("fetch_band_raw", _fake_band)

        # Stub everything after the fetch loop so the test stays hermetic.
        _save("_render_ir_jpg", lambda *a, **k: None)
        _save("_gcs_manifest_get", lambda *a, **k: {})
        _save("_gcs_manifest_put", lambda *a, **k: None)
        _save("_mw_compare_ir_slots", lambda *a, **k: [])
        _save("_build_and_upload_bundles", lambda *a, **k: None)
        _save("_build_band_bundle", lambda *a, **k: None)
        # GeoColor prewarm bundle (added later, separate geocolor-webp cache) is
        # orthogonal to the IR/band LIST-membership behavior under test here and
        # is covered by tests/test_geocolor_bundle.py — stub it so this test
        # stays scoped to IR/band existence checks.
        _save("_build_and_upload_geocolor_bundle", lambda *a, **k: None)
        _save("_prefetch_nexrad_for_storms", lambda *a, **k: None)
        _save("_cleanup_old_gcs_frames", lambda *a, **k: None)
        # The in-process PNG prefetch loop also calls fetch_ir_frame; stub it.
        _save("fetch_ir_frame", lambda *a, **k: None)
        # Speed up: no real sleep between fetch and bundle build.
        _save("time", _NoSleepTime(M.time))

        storms = [{"atcf_id": "al072024", "lat": 24.4, "lon": -71.9,
                   "name": "TEST"}]
        M._prefetch_ir_frames(storms)
        _join_daemon_writes()
    finally:
        for name, val in saved.items():
            setattr(M, name, val)
        _restore(state)
    return saved


class _NoSleepTime:
    """time shim that no-ops sleep but proxies everything else."""
    def __init__(self, real):
        self._real = real

    def sleep(self, *a, **k):
        return None

    def __getattr__(self, name):
        return getattr(self._real, name)


def _expected_keys_for_window(atcf_upper):
    """Recompute the exact IR + SWIR keys the workers would test, for the
    same tiny window _run_prewarm uses."""
    from datetime import timezone
    now = M._dt.now(timezone.utc)
    times = M.build_frame_times(now, 0.5, 10)
    lat, lon = 24.4, -71.9  # _interp_pos_at returns the fallback (storm pos)
    ir_keys, band_keys = set(), set()
    for t in times:
        ds = t.strftime("%Y%m%d%H%M")
        ir_keys.add(M._ir_raw_key(atcf_upper, ds, lat, lon,
                                  M._PREFETCH_RADIUS_DEG))
        band_keys.add(M._band_raw_key(M.SWIR_BAND, atcf_upper, ds, lat, lon))
        band_keys.add(M._band_raw_key(M.WV_BAND, atcf_upper, ds, lat, lon))
    return ir_keys, band_keys


# ── Test 2: FULL CACHE HIT → zero heavy fetches ────────────────────
def test_full_cache_hit_no_fetch():
    atcf_upper = "AL072024"
    ir_keys, band_keys = _expected_keys_for_window(atcf_upper)
    bucket = _FakeBucket(present=ir_keys | band_keys)
    record = {"ir": [], "band": []}
    _run_prewarm(bucket, record=record)

    assert record["ir"] == [], (
        f"expected zero IR fetches on full cache hit, got {len(record['ir'])}"
    )
    assert record["band"] == [], (
        f"expected zero band fetches on full cache hit, got {record['band']}"
    )
    # And it used LIST (not per-object exists) — exists() never called.
    assert bucket.exists_calls == [], (
        f"full-hit path should not call .exists(); got {bucket.exists_calls}"
    )
    assert bucket.list_calls, "expected at least one list_blobs call"
    print("PASS test_full_cache_hit_no_fetch")


# ── Test 3: COLD CACHE (empty set) → all non-force frames fetch ────
def test_cold_cache_all_fetch():
    bucket = _FakeBucket(present=set())   # nothing cached
    record = {"ir": [], "band": []}
    _run_prewarm(bucket, record=record)

    atcf_upper = "AL072024"
    ir_keys, _ = _expected_keys_for_window(atcf_upper)
    n_slots = len(ir_keys)
    assert len(record["ir"]) >= n_slots, (
        f"cold cache: expected >= {n_slots} IR fetches, got {len(record['ir'])}"
    )
    # SWIR (extra) + WV (primary) both fetched for each slot.
    swir = [b for b in record["band"] if b[0] == M.SWIR_BAND]
    wv = [b for b in record["band"] if b[0] == M.WV_BAND]
    assert len(swir) >= n_slots, f"cold cache: SWIR fetches {len(swir)} < {n_slots}"
    assert len(wv) >= n_slots, f"cold cache: WV fetches {len(wv)} < {n_slots}"
    # Still used LIST, not exists.
    assert bucket.exists_calls == [], (
        f"cold-cache path should use LIST set, not .exists(); got {bucket.exists_calls}"
    )
    print("PASS test_cold_cache_all_fetch")


# ── Test 4: LIST returns None → fall back to per-object exists ──────
def test_list_failure_falls_back_to_exists():
    # present set marks everything cached, but LIST raises → set is None →
    # workers must use the .exists() path (which consults `present`) and so
    # still skip every (already-cached) frame WITHOUT crashing.
    atcf_upper = "AL072024"
    ir_keys, band_keys = _expected_keys_for_window(atcf_upper)
    bucket = _FakeBucket(present=ir_keys | band_keys)
    bucket.list_should_raise = True
    record = {"ir": [], "band": []}
    _run_prewarm(bucket, record=record)

    # No crash, and because exists() reports them present, no heavy fetch.
    assert record["ir"] == [], (
        f"fallback exists() path should skip cached IR frames, got {record['ir']}"
    )
    assert record["band"] == [], (
        f"fallback exists() path should skip cached band frames, got {record['band']}"
    )
    # The fallback path MUST have actually called .exists() (proves we took
    # the None branch, not the set branch).
    assert bucket.exists_calls, (
        "expected .exists() fallback calls when LIST returns None"
    )
    print("PASS test_list_failure_falls_back_to_exists")


def main():
    test_key_parity()
    test_full_cache_hit_no_fetch()
    test_cold_cache_all_fetch()
    test_list_failure_falls_back_to_exists()
    print("\nALL TESTS PASSED")


if __name__ == "__main__":
    main()
