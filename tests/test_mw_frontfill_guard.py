"""Tests for the microwave-ingest frontfill existence guard
(perf/mw-frontfill-guard).

The operational `--operational` frontfill phase re-pulls the freshest N
granules per sensor on EVERY 30-min tick. Microwave overpasses are
sporadic, so most ticks re-download + re-render granules already in GCS —
the dominant Cloud Run Jobs cost. The guard (`_frontfill_skip_granule`)
skips a frontfill candidate whose deterministic outputs already exist in
GCS, while still fully processing genuinely new passes and falling through
to processing on any error.

These tests monkeypatch GCS (a fake bucket) and the heavy fetch/render
(`process_one`) so they need no network or credentials.

Run: python3 tests/test_mw_frontfill_guard.py
"""
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import mw_ingest as M


# A real PPS GMI granule filename (single-pass sensor). _pps_granule_meta
# parses orbit_id = scan_start as %Y%m%dT%H%M%S from the -S<HHMMSS> field.
GMI_FNAME = ("1C-R.GPM.GMI.XCAL2016-C.20260604-S014500-E031733."
             "V07A.RT-NC")
GMI_URL = "https://arthurhouhttps.pps.eosdis.nasa.gov/text/1CR/" + GMI_FNAME
GMI_SENSOR = "GMI"


class _FakeBlob:
    def __init__(self, name):
        self.name = name


class _FakeBucket:
    """Minimal stand-in for a google.cloud.storage Bucket. `objects` is the
    set of object names that 'exist'. `raise_on_list` makes list_blobs
    raise, simulating a transient/bucket error."""
    def __init__(self, objects=(), raise_on_list=False):
        self.objects = list(objects)
        self.raise_on_list = raise_on_list
        self.list_calls = 0

    def list_blobs(self, prefix="", max_results=None):
        self.list_calls += 1
        if self.raise_on_list:
            raise RuntimeError("simulated GCS LIST failure")
        hits = [_FakeBlob(n) for n in self.objects if n.startswith(prefix)]
        if max_results is not None:
            hits = hits[:max_results]
        return iter(hits)


def _install_bucket(monkeypatch_target, bucket):
    """Force M._get_bucket() to return our fake bucket."""
    M._get_bucket = lambda: bucket  # noqa: E731


_orig_get_bucket = M._get_bucket


def _restore():
    M._get_bucket = _orig_get_bucket


def _meta_for(fname=GMI_FNAME, sensor=GMI_SENSOR):
    return M._pps_granule_meta(sensor, fname)


# ── Test 1: granule already in GCS → skipped, heavy fetch NOT called ──────
def test_already_rendered_is_skipped():
    meta = _meta_for()
    prefix = M._granule_output_prefix(meta)
    # Pretend the whole-arc 89pct PNG for this granule is already uploaded.
    existing = M._granule_png_key(meta, "89pct", "")
    assert existing.startswith(prefix), "writer key must sit under prefix"
    bucket = _FakeBucket(objects=[existing])
    _install_bucket(M, bucket)

    # Track that the heavy path is never entered.
    called = {"process_one": 0}
    _orig_process_one = M.process_one
    M.process_one = lambda *a, **k: called.__setitem__(
        "process_one", called["process_one"] + 1) or []
    try:
        skip = M._frontfill_skip_granule(GMI_SENSOR, GMI_FNAME)
        # Mirror the frontfill loop's `if skip: continue` so we can assert
        # the heavy fetch/render is bypassed.
        if not skip:
            M.process_one("/tmp/whatever", GMI_SENSOR, ["89pct"])
    finally:
        M.process_one = _orig_process_one
        _restore()

    assert skip is True, "granule with existing outputs must be skipped"
    assert called["process_one"] == 0, (
        "heavy fetch/render must NOT run for an already-rendered granule")
    assert bucket.list_calls == 1, "guard should do exactly one LIST"
    print("test_already_rendered_is_skipped: PASS")


# ── Test 2: genuinely new granule (no outputs) → fully processed ──────────
def test_new_granule_is_processed():
    # Bucket has objects only for a DIFFERENT granule/day — none match.
    other = "GMI/2026/01/01/20260101T000000_010000_89pct.png"
    bucket = _FakeBucket(objects=[other])
    _install_bucket(M, bucket)

    called = {"process_one": 0}
    _orig_process_one = M.process_one
    M.process_one = lambda *a, **k: called.__setitem__(
        "process_one", called["process_one"] + 1) or []
    try:
        skip = M._frontfill_skip_granule(GMI_SENSOR, GMI_FNAME)
        if not skip:
            M.process_one("/tmp/whatever", GMI_SENSOR, ["89pct"])
    finally:
        M.process_one = _orig_process_one
        _restore()

    assert skip is False, "new pass (no outputs) must NOT be skipped"
    assert called["process_one"] == 1, "new pass must be fully processed"
    print("test_new_granule_is_processed: PASS")


# ── Test 3: existence check raises → falls through to processing ──────────
def test_existence_error_falls_through():
    bucket = _FakeBucket(objects=[], raise_on_list=True)
    _install_bucket(M, bucket)

    called = {"process_one": 0}
    _orig_process_one = M.process_one
    M.process_one = lambda *a, **k: called.__setitem__(
        "process_one", called["process_one"] + 1) or []
    try:
        skip = M._frontfill_skip_granule(GMI_SENSOR, GMI_FNAME)
        if not skip:
            M.process_one("/tmp/whatever", GMI_SENSOR, ["89pct"])
    finally:
        M.process_one = _orig_process_one
        _restore()

    assert skip is False, (
        "a raising existence check must fall through (never drop a pass)")
    assert called["process_one"] == 1, (
        "granule must still be processed when the LIST errors")
    print("test_existence_error_falls_through: PASS")


# ── Test 4: key-derivation parity — guard prefix == writer's key root ─────
def test_key_parity_with_upload_granule():
    """The prefix the guard lists must be a prefix of EVERY key
    upload_granule actually writes for the same granule — for both a
    single-pass sensor (GMI, empty suffix) and a multi-pass sensor (SSMIS,
    -p0/-p1 suffixes). We capture the writer's keys by monkeypatching
    _upload_bytes and comparing against _granule_output_prefix."""
    # --- single-pass (GMI) ---
    meta = _meta_for()
    prefix = M._granule_output_prefix(meta)
    written = []
    _orig_upload = M._upload_bytes
    M._upload_bytes = lambda key, data, ct, **k: written.append(key)
    try:
        prod = M.RenderedProduct(
            product="89pct", png_bytes=b"PNG", footprint={"type": "Polygon"},
            bounds=[[0, 0], [1, 1]], center_track=[[0, 0]], pass_suffix="")
        entries = M.upload_granule(meta, [prod])
    finally:
        M._upload_bytes = _orig_upload

    assert written, "upload_granule should have written at least one object"
    for key in written:
        assert key.startswith(prefix), (
            f"writer key {key!r} not under guard prefix {prefix!r}")
    # The exact PNG key the writer used must equal the helper's PNG key.
    expected_png = M._granule_png_key(meta, "89pct", "")
    assert expected_png in written, (
        f"expected {expected_png!r} among written {written!r}")
    # And the manifest entry's png_url must carry that same key.
    assert entries[0]["png_url"].endswith(expected_png)

    # --- multi-pass (SSMIS, -p0 / -p1) ---
    ssmis_fname = ("1C.F18.SSMIS.XCAL2021-V.20260604-S014500-E031733."
                   "V08A.RT-NC")
    smeta = M._pps_granule_meta("SSMIS", ssmis_fname)
    sprefix = M._granule_output_prefix(smeta)
    written2 = []
    M._upload_bytes = lambda key, data, ct, **k: written2.append(key)
    try:
        prods = [
            M.RenderedProduct(
                product="89pct", png_bytes=b"P0", footprint={"type": "Polygon"},
                bounds=[[0, 0], [1, 1]], center_track=[[0, 0]],
                pass_suffix="-p0"),
            M.RenderedProduct(
                product="89pct", png_bytes=b"P1", footprint={"type": "Polygon"},
                bounds=[[0, 0], [1, 1]], center_track=[[0, 0]],
                pass_suffix="-p1"),
        ]
        M.upload_granule(smeta, prods)
    finally:
        M._upload_bytes = _orig_upload

    assert written2, "multi-pass upload should write objects"
    for key in written2:
        assert key.startswith(sprefix), (
            f"multi-pass key {key!r} not under prefix {sprefix!r}")
    # Both pass suffixes share the single orbit_id-rooted prefix the guard
    # lists, so one existing object skips the whole granule.
    assert M._granule_png_key(smeta, "89pct", "-p0") in written2
    assert M._granule_png_key(smeta, "89pct", "-p1") in written2
    print("test_key_parity_with_upload_granule: PASS")


if __name__ == "__main__":
    test_already_rendered_is_skipped()
    test_new_granule_is_processed()
    test_existence_error_falls_through()
    test_key_parity_with_upload_granule()
    print("\nALL TESTS PASSED")
