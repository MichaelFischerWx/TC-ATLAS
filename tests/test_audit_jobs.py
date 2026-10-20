"""Regression tests for the 10-minute job fixes (microwave ingest + IR mosaic).

Covers:
  * microwave_api._bounds_contains matches storms across the dateline when
    the pass bounds run past ±180 (continuous-longitude regrid).
  * build_ir_mosaic.storm_tile_set wraps tile x at the antimeridian.
  * mw_ingest manifest-aware existence guard (_granule_skip_check):
    in-manifest → skip with no GCS LIST; rendered-but-missing → entries
    re-added from the per-granule sidecar; no sidecar → re-render.
  * upload_granule writes no GeoJSON and writes the entries sidecar last.
  * the operational run writes the manifest BEFORE releasing the lock, even
    when the run is interrupted (SIGTERM → SystemExit).

No network or credentials needed. Run: python3 tests/test_audit_jobs.py
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import mw_ingest as M  # noqa: E402
import microwave_api as MA  # noqa: E402


GMI_FNAME = "1C-R.GPM.GMI.XCAL2016-C.20260604-S014500-E031733.V07A.RT-NC"
GMI_FNAME2 = "1C-R.GPM.GMI.XCAL2016-C.20260604-S034500-E051733.V07A.RT-NC"


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


# ── dateline bounds ───────────────────────────────────────────────────────
def test_bounds_contains_dateline():
    b = [[10.0, 170.0], [30.0, 190.0]]          # continuous-lon arc
    assert MA._bounds_contains(b, 20.0, -175.0)
    assert MA._bounds_contains(b, 20.0, 175.0)
    assert not MA._bounds_contains(b, 20.0, -165.0)
    assert not MA._bounds_contains(b, 40.0, -175.0)
    assert MA._bounds_contains([[10, -190], [30, -170]], 20.0, 178.0)
    assert MA._bounds_contains([[10, 170], [30, -170]], 20.0, -175.0)
    assert MA._bounds_contains([[10, -60], [30, -40]], 20.0, -50.0)
    print("test_bounds_contains_dateline: PASS")


# ── mosaic storm tiles ────────────────────────────────────────────────────
def test_storm_tiles_wrap_antimeridian():
    import build_ir_mosaic as B
    n = 2 ** 5
    for lon in (178.0, -178.0):
        xs = {x for (_z, x, _y) in B.storm_tile_set([(15.0, lon)], (5,), 6.0)}
        assert xs == {0, n - 1}, (lon, xs)
    xs = {x for (_z, x, _y) in B.storm_tile_set([(15.0, -60.0)], (5,), 6.0)}
    assert xs == {10, 11}, xs
    for (_z, x, _y) in B.storm_tile_set([(0.0, 179.9)], (3, 4, 5, 6), 6.0):
        assert 0 <= x < 2 ** _z
    print("test_storm_tiles_wrap_antimeridian: PASS")


# ── manifest-aware guard ──────────────────────────────────────────────────
class _Blob:
    def __init__(self, name):
        self.name = name


class _Bucket:
    def __init__(self, objects=()):
        self.objects = list(objects)
        self.list_calls = 0

    def list_blobs(self, prefix="", max_results=None):
        self.list_calls += 1
        hits = [_Blob(n) for n in self.objects if n.startswith(prefix)]
        return iter(hits[:max_results] if max_results else hits)


def _with_bucket(bucket, texts=None):
    mp = _MP()
    mp.setattr(M, "_get_bucket", lambda: bucket)
    texts = texts or {}
    mp.setattr(M, "_download_text", lambda key: texts.get(key))
    return mp


def test_guard_in_manifest_skips_without_list():
    meta = M._pps_granule_meta("GMI", GMI_FNAME)
    known = M._manifest_granule_keys([
        {"sensor": "GMI", "orbit_id": meta.orbit_id + "-p0s1",
         "product": "89pct", "scan_start": meta.scan_start_utc.isoformat()}])
    bucket = _Bucket()
    mp = _with_bucket(bucket)
    try:
        skip, rep = M._granule_skip_check("GMI", GMI_FNAME, known)
    finally:
        mp.undo()
    assert skip and rep == [] and bucket.list_calls == 0
    print("test_guard_in_manifest_skips_without_list: PASS")


def test_guard_rendered_skip_sentinel_not_counted():
    meta = M._pps_granule_meta("GMI", GMI_FNAME)
    known = M._manifest_granule_keys([
        {"sensor": "GMI", "orbit_id": f"RENDERED-SKIP-{GMI_FNAME}",
         "product": M._RENDERED_SENTINEL_PRODUCT,
         "scan_start": meta.scan_start_utc.isoformat()}])
    assert known == set()
    known = M._manifest_granule_keys([
        {"sensor": "GMI", "orbit_id": f"TIMEOUT-SKIP-{GMI_FNAME}",
         "product": M._TIMEOUT_SENTINEL_PRODUCT,
         "scan_start": meta.scan_start_utc.isoformat()}])
    mp = _with_bucket(_Bucket())
    try:
        skip, _ = M._granule_skip_check("GMI", GMI_FNAME, known)
    finally:
        mp.undo()
    assert skip, "watchdog-timeout sentinel must stop retries"
    print("test_guard_rendered_skip_sentinel_not_counted: PASS")


def test_guard_orphan_repaired_from_sidecar():
    meta = M._pps_granule_meta("GMI", GMI_FNAME)
    png = M._granule_png_key(meta, "89pct")
    entry = {"sensor": "GMI", "orbit_id": meta.orbit_id, "product": "89pct",
             "scan_start": meta.scan_start_utc.isoformat(), "png_url": "x"}
    texts = {M._granule_sidecar_key(meta): json.dumps([entry])}
    known = set()
    mp = _with_bucket(_Bucket([png]), texts)
    try:
        skip, rep = M._granule_skip_check("GMI", GMI_FNAME, known)
    finally:
        mp.undo()
    assert skip and rep == [entry], (skip, rep)
    assert ("GMI", meta.orbit_id) in known
    print("test_guard_orphan_repaired_from_sidecar: PASS")


def test_guard_orphan_without_sidecar_rerenders():
    meta = M._pps_granule_meta("GMI", GMI_FNAME)
    mp = _with_bucket(_Bucket([M._granule_png_key(meta, "89pct")]))
    try:
        skip, rep = M._granule_skip_check("GMI", GMI_FNAME, set())
    finally:
        mp.undo()
    assert not skip and rep == []
    print("test_guard_orphan_without_sidecar_rerenders: PASS")


def test_guard_unreadable_manifest_falls_back_to_gcs():
    meta = M._pps_granule_meta("GMI", GMI_FNAME)
    mp = _with_bucket(_Bucket([M._granule_png_key(meta, "89pct")]))
    try:
        skip, rep = M._granule_skip_check("GMI", GMI_FNAME, None)
    finally:
        mp.undo()
    assert skip and rep == []
    print("test_guard_unreadable_manifest_falls_back_to_gcs: PASS")


# ── upload_granule ────────────────────────────────────────────────────────
def test_upload_granule_no_geojson_sidecar_last():
    meta = M._pps_granule_meta("GMI", GMI_FNAME)
    written = []
    mp = _MP()
    mp.setattr(M, "_upload_bytes",
               lambda key, data, ct, **k: written.append((key, data, k)) or False)
    try:
        prods = [M.RenderedProduct(product=p, png_bytes=b"PNG",
                                   bounds=[[0, 0], [1, 1]]) for p in ("89pct", "37color")]
        entries = M.upload_granule(meta, prods)
    finally:
        mp.undo()
    keys = [k for (k, _d, _kw) in written]
    assert not any(k.endswith(".geojson") for k in keys), keys
    assert keys[-1] == M._granule_sidecar_key(meta), keys
    assert keys[-1].startswith(M._granule_output_prefix(meta))
    assert written[-1][2].get("r2_mirror") is False
    assert json.loads(written[-1][1]) == entries
    assert all("geojson_url" not in e for e in entries)
    print("test_upload_granule_no_geojson_sidecar_last: PASS")


# ── final manifest write happens inside the lock, even on SIGTERM ─────────
def test_manifest_written_before_lock_release_on_sigterm():
    now = datetime(2026, 6, 4, 6, 0, tzinfo=timezone.utc)
    events = []
    g1 = M._pps_granule_meta("GMI", GMI_FNAME)
    g2 = M._pps_granule_meta("GMI", GMI_FNAME2)
    url1 = "https://pps.example/" + GMI_FNAME
    url2 = "https://pps.example/" + GMI_FNAME2

    class _Resp:
        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size=0):
            return iter([b"x"])

    class _Sess:
        def get(self, *a, **k):
            return _Resp()

    calls = []

    def _process_one(path, sensor, products, **k):
        # Frontfill goes newest-first: g2 renders, then SIGTERM lands
        # while g1 is in flight.
        calls.append(path)
        if path.endswith(GMI_FNAME2):
            return [{"sensor": "GMI", "orbit_id": g2.orbit_id,
                     "product": "89pct", "scan_start": g2.scan_start_utc.isoformat()}]
        raise SystemExit(0)      # what the SIGTERM handler raises

    manifest = {"entries": []}
    passes = {"updated": now.isoformat(), "horizon_hours": 24,
              "storms": [{"atcf_id": "WP012026", "passes": [
                  {"sensor": "GMI", "platform": "GPM",
                   "predicted_scan_start": now.isoformat(),
                   "eta_on_tcatlas": now.isoformat()}]}]}

    def _download_text(key):
        if key == M.MANIFEST_KEY:
            return json.dumps(manifest)
        if key == M.PASSES_KEY:
            return json.dumps(passes)
        if key == M._FULL_RUN_MARKER_KEY:
            return str(now.timestamp() - 60)
        return None

    class _FrozenDT(M._dt):
        @classmethod
        def now(cls, tz=None):
            return now if tz else now.replace(tzinfo=None)

    mp = _MP()
    mp.setattr(M, "_dt", _FrozenDT)
    mp.setattr(M, "_download_text", _download_text)
    mp.setattr(M, "_get_bucket", lambda: _Bucket())
    mp.setattr(M, "_acquire_ingest_lock", lambda *_a: True)
    mp.setattr(M, "_release_ingest_lock", lambda *_a: events.append("release"))
    mp.setattr(M, "_fetch_active_storms", lambda: [{"x": 1}])
    mp.setattr(M, "_fetch_genesis_disturbances", lambda: [])
    mp.setattr(M, "_full_run_mark_done", lambda *_a: None)
    mp.setattr(M, "_last_processed_start_utc", lambda sensor=None: now - timedelta(hours=1))
    mp.setattr(M, "_pps_session", lambda: _Sess())
    mp.setattr(M, "list_pps_granules",
               lambda sensor, since, until=None: [(url1, g1.scan_start_utc),
                                                  (url2, g2.scan_start_utc)])
    mp.setattr(M, "process_one", _process_one)
    mp.setattr(M, "update_manifest",
               lambda entries: events.append(("manifest", [e["orbit_id"] for e in entries])))
    exited = False
    try:
        M._cli(["--operational", "--sensors", "GMI"])
    except SystemExit:
        exited = True
    finally:
        mp.undo()
    assert exited, "interrupt should still propagate"
    assert len(calls) == 2, calls
    assert events == [("manifest", [g2.orbit_id]), "release"], events
    print("test_manifest_written_before_lock_release_on_sigterm: PASS")


if __name__ == "__main__":
    test_bounds_contains_dateline()
    test_storm_tiles_wrap_antimeridian()
    test_guard_in_manifest_skips_without_list()
    test_guard_rendered_skip_sentinel_not_counted()
    test_guard_orphan_repaired_from_sidecar()
    test_guard_orphan_without_sidecar_rerenders()
    test_guard_unreadable_manifest_falls_back_to_gcs()
    test_upload_granule_no_geojson_sidecar_last()
    test_manifest_written_before_lock_release_on_sigterm()
    print("\nALL TESTS PASSED")
