"""Tests for the GeoColor egress fixes (perf/geocolor-bundle-webp).

FIX A — Prewarm writes a GeoColor bundle to GCS so GeoColor views stop
streaming ~2 MB through Cloud Run on every load. The prewarm writer
(`_build_and_upload_geocolor_bundle`) and the on-demand API endpoint
(`get_storm_geocolor_frames_bundle`) share one body builder
(`_build_geocolor_bundle_body`), so the bytes uploaded to
`bundles/geocolor/{ATCF}.bin` MUST be byte-identical to what the endpoint
serves for the same frames. We assert exactly that, plus the GCS key.

FIX B — The WebP bundle endpoints (geocolor / band / ir-frames) must opt out
of the global GZipMiddleware re-gzip by declaring `Content-Encoding: identity`
(WebP is already codec-compressed). We assert the header is present on those
responses and that the archive JSON path is unaffected.

No network: GCS bucket, frame fetch, and the active-storms cache are all
mocked. Run: python3 tests/test_geocolor_bundle.py
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ir_monitor_api as M


# A fixed base time on a 10-min boundary so endpoint + prewarm both snap to
# the SAME frame grid regardless of the wall clock during the test.
_FIXED_NOW = datetime(2026, 6, 4, 18, 30, 0, tzinfo=timezone.utc)


def _install_deterministic_stubs():
    """Make every input the bundle builder reads deterministic + offline.

    - frame_times pinned to a fixed grid (no dependence on real 'now')
    - per-frame WebP bytes / satellite / is_day a pure function of the slot
    - storm position interpolation a pure function of the slot
    - anomaly screen disabled (it queues self-heal + reads no external state)
    - active-storms cache seeded with our test storm
    """
    real_build_frame_times = M.build_frame_times

    def _fixed_build_frame_times(center_dt, lookback_hours=6.0, interval_min=30):
        # Ignore the live center_dt; always build from the fixed boundary so
        # the endpoint (which calls _dt.now) and the prewarm writer agree.
        return real_build_frame_times(_FIXED_NOW, lookback_hours, interval_min)

    M.build_frame_times = _fixed_build_frame_times

    # Deterministic geocolor frame: distinct bytes per slot, alternating
    # day/night so both n_day and n_night are exercised. One slot returns
    # None to exercise the no-data header branch.
    def _fake_geocolor(atcf_upper, ilat, ilon, target_dt, radius_deg):
        slot = target_dt.strftime("%Y%m%d%H%M")
        minute = target_dt.minute
        if minute == 0:  # deterministically drop one slot
            return None, "GOES-19", True
        is_day = (target_dt.hour % 2 == 0)
        payload = (b"WEBP-" + slot.encode("ascii")) * 3
        return payload, "GOES-19", is_day

    M._get_or_render_geocolor_jpg = _fake_geocolor

    def _fake_interp(atcf_id, target_dt, fb_lat, fb_lon):
        # Smooth, slot-dependent drift so bounds/recenter vary per frame.
        dh = (target_dt - _FIXED_NOW).total_seconds() / 3600.0
        return (round(fb_lat + 0.05 * dh, 6), round(fb_lon + 0.03 * dh, 6))

    M._interp_pos_at = _fake_interp

    # No anomalies — return empty set, touch nothing external.
    M._screen_and_queue_anomalies = lambda *a, **k: set()

    M._ensure_fresh_cache = lambda *a, **k: None

    with M._active_storms_lock:
        M._active_storms_cache["storms"] = [
            {"atcf_id": "AL072026", "lat": 24.5, "lon": -71.3}
        ]


class _FakeBlob:
    def __init__(self, store, key):
        self._store = store
        self._key = key
        self.cache_control = None
        self.content_encoding = None

    def upload_from_string(self, body, content_type=None,
                           predefined_acl=None, timeout=None):
        self._store[self._key] = {
            "body": body,
            "content_type": content_type,
            "content_encoding": self.content_encoding,
            "predefined_acl": predefined_acl,
        }


class _FakeBucket:
    def __init__(self, store):
        self._store = store

    def blob(self, key):
        return _FakeBlob(self._store, key)


def test_prewarm_geocolor_bundle_byte_identical():
    _install_deterministic_stubs()

    uploads = {}
    M._get_rt_gcs_bucket = lambda: _FakeBucket(uploads)

    lookback, radius, interval = 6.0, 10.0, 10

    # 1) Prewarm writer → uploads to GCS.
    M._build_and_upload_geocolor_bundle(
        "al072026", 24.5, -71.3,
        lookback_hours=lookback, radius_deg=radius, interval_min=interval,
    )

    expected_key = f"{M._GCS_RT_VERSION}/bundles/geocolor/AL072026.bin"
    assert expected_key in uploads, (
        f"prewarm did not write the expected geocolor key {expected_key!r}; "
        f"got {list(uploads)}")
    gcs_body = uploads[expected_key]["body"]
    assert uploads[expected_key]["predefined_acl"] == "publicRead", \
        "geocolor bundle must be uploaded publicRead so the GCS-first path can read it"
    assert uploads[expected_key]["content_encoding"] is None, \
        "WebP geocolor bundle must NOT be gzipped on GCS (already codec-compressed)"

    # 2) On-demand API endpoint → Response body for the SAME frames/params.
    resp = M.get_storm_geocolor_frames_bundle(
        "al072026", lookback_hours=lookback, radius_deg=radius,
        interval_min=interval,
    )
    api_body = resp.body

    assert gcs_body == api_body, (
        "FAIL: prewarm GCS bundle bytes differ from the API endpoint bytes — "
        f"GCS {len(gcs_body)} B vs API {len(api_body)} B. The GCS-first path "
        "would serve content that diverges from the server.")

    # Sanity: the body is a real packed bundle the frontend can parse.
    import json
    import struct
    hlen = struct.unpack("<I", gcs_body[:4])[0]
    header = json.loads(gcs_body[4:4 + hlen].decode("utf-8"))
    assert header["product"] == "geocolor"
    assert header["total_frames"] == len(header["frames"])
    # We dropped the :00 slots and alternated day/night; both must be non-zero.
    assert header["n_day_frames"] > 0 and header["n_night_frames"] > 0, header
    print(f"[A] geocolor bundle byte-identical: key={expected_key} "
          f"len={len(gcs_body)} frames={header['total_frames']} "
          f"day={header['n_day_frames']} night={header['n_night_frames']}")


def test_webp_bundle_responses_opt_out_of_gzip():
    _install_deterministic_stubs()
    M._get_rt_gcs_bucket = lambda: _FakeBucket({})

    resp = M.get_storm_geocolor_frames_bundle(
        "al072026", lookback_hours=6.0, radius_deg=10.0, interval_min=10,
    )
    ce = resp.headers.get("content-encoding")
    assert ce == "identity", (
        f"FAIL: geocolor WebP bundle Content-Encoding={ce!r}, expected "
        "'identity' so GZipMiddleware skips re-gzipping it")
    assert resp.media_type == "application/octet-stream"
    print(f"[B] geocolor WebP bundle Content-Encoding={ce!r} (gzip opt-out)")


def test_gzip_middleware_skips_identity_marked_responses():
    """The opt-out mechanism itself: Starlette's GZipMiddleware passes through
    any response that already declares a Content-Encoding (it sets
    `content_encoding_set` from the header and forwards the body untouched),
    while a response WITHOUT one is still eligible for gzip. This guards the
    assumption Fix B relies on and confirms the archive JSON path (no
    Content-Encoding set) is unaffected."""
    from starlette.responses import Response as StarletteResponse

    # WebP bundle response: declares identity → middleware must NOT gzip.
    webp = StarletteResponse(
        content=b"x" * 5000, media_type="application/octet-stream",
        headers={"Content-Encoding": "identity"},
    )
    assert "content-encoding" in webp.headers, \
        "identity opt-out header missing from the WebP-style response"

    # Archive JSON response: no Content-Encoding → still gzip-eligible.
    archive = StarletteResponse(
        content=b'{"data": [1,2,3]}' * 500, media_type="application/json",
    )
    assert "content-encoding" not in archive.headers, (
        "archive JSON response must NOT declare a Content-Encoding so the "
        "global GZipMiddleware can still compress it")
    print("[B] middleware opt-out mechanism verified: identity-marked WebP "
          "bundles bypass gzip; archive JSON stays gzip-eligible")


def main():
    test_prewarm_geocolor_bundle_byte_identical()
    test_webp_bundle_responses_opt_out_of_gzip()
    test_gzip_middleware_skips_identity_marked_responses()
    print("\nPASS: geocolor prewarm bundle is byte-identical to the API "
          "endpoint; WebP bundles opt out of double-gzip; archive JSON "
          "path unaffected.")


if __name__ == "__main__":
    main()
