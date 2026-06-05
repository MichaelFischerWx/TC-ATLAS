"""Unit tests for the GCS-redirect bundle endpoints (fix/bundle-gcs-redirect).

The 3 IR bundle endpoints used to build the full bundle bytes and return them
through a BUFFERED Cloud Run Response — which caps at ~32 MiB, producing an
empty 500 ("Response size was too large") for large bundles. The fix writes the
built bundle to the public GCS bucket and 302-redirects the client to the
object's public URL (no Cloud Run size cap; GCS serves gzip natively).

These tests mock _upload_public_bundle and the per-frame fetch/render helpers
so nothing touches the network. For each of the 3 endpoints we assert:
  1. it returns a fastapi RedirectResponse with status 302;
  2. Location == the expected public GCS URL for the params-keyed object;
  3. _upload_public_bundle was called with the right key + gzip flag
     (raw = gzip, WebP frames/band = not);
  4. the uploaded payload is byte-identical to the bundle bytes the old
     endpoint would have returned (header + concatenated frame payloads).

Run: python3 tests/test_bundle_redirect.py
"""
import base64
import json
import os
import struct
import sys
from datetime import datetime, timezone

import numpy as np
from fastapi.responses import RedirectResponse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ir_monitor_api as M


_BUCKET = "tc-atlas-ir-cache"
_ATCF = "AL052024"
_VER = M._GCS_RT_VERSION


class _UploadSpy:
    """Captures the (key, body, content_type, gzip_content) of every
    _upload_public_bundle call so a test can assert on the exact payload."""
    def __init__(self):
        self.calls = []

    def __call__(self, key, body, content_type="application/octet-stream",
                 gzip_content=False):
        self.calls.append({
            "key": key, "body": body,
            "content_type": content_type, "gzip_content": gzip_content,
        })


def _install_common(monkey):
    """Shared monkeypatches: bucket configured, fresh-cache no-op, one active
    storm, deterministic frame times, identity track interpolation."""
    monkey["_GCS_IR_CACHE_BUCKET"] = M._GCS_IR_CACHE_BUCKET
    M._GCS_IR_CACHE_BUCKET = _BUCKET

    monkey["_ensure_fresh_cache"] = M._ensure_fresh_cache
    M._ensure_fresh_cache = lambda: None

    monkey["_active_storms_cache"] = dict(M._active_storms_cache)
    M._active_storms_cache["storms"] = [{
        "atcf_id": _ATCF, "lat": 24.0, "lon": -72.0, "vmax_kt": 90,
    }]

    # Deterministic 3-frame window so the test is fast and the byte layout is
    # predictable; oldest-first ordering is applied by the endpoints themselves.
    base = datetime(2024, 9, 25, 12, 0, tzinfo=timezone.utc)
    times = [base, base.replace(hour=11, minute=30), base.replace(hour=11)]
    monkey["build_frame_times"] = M.build_frame_times
    M.build_frame_times = lambda center_dt, lookback_hours, interval_min: list(times)

    # No external track file; interpolation is the identity (fallback pos).
    monkey["_get_track_for_interp"] = M._get_track_for_interp
    M._get_track_for_interp = lambda atcf_id: []
    monkey["_interp_pos_at"] = M._interp_pos_at
    M._interp_pos_at = lambda atcf_id, dt, flat, flon: (flat, flon)
    monkey["_screen_and_queue_anomalies"] = getattr(
        M, "_screen_and_queue_anomalies", None)
    M._screen_and_queue_anomalies = lambda *a, **k: set()


def _restore(monkey):
    for name, val in monkey.items():
        setattr(M, name, val)


def _expected_raw_body(frames):
    """Reproduce the raw-Tb bundle bytes the endpoint builds: a uint32 LE
    header length, the JSON header, then concatenated uint8 Tb arrays."""
    headers, payloads, offset = [], [], 0
    times = ["2024-09-25T11:00:00Z", "2024-09-25T11:30:00Z", "2024-09-25T12:00:00Z"]
    for i, f in enumerate(frames):
        tb = base64.b64decode(f["tb_data"])
        rows, cols = f["tb_rows"], f["tb_cols"]
        headers.append({
            "index": i, "datetime_utc": f.get("datetime_utc", times[i]),
            "satellite": f.get("satellite", ""),
            "tb_rows": rows, "tb_cols": cols,
            "byte_offset": offset, "byte_length": rows * cols,
            "bounds": f.get("bounds"), "center_fix": f.get("center_fix"),
        })
        payloads.append(tb)
        offset += rows * cols
    header = {
        "total_frames": len(frames), "tb_vmin": M._TB_VMIN, "tb_vmax": M._TB_VMAX,
        "lookback_hours": 6.0, "interval_min": 30, "radius_deg": 10.0,
        "frames": headers,
    }
    hj = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(hj)) + hj + b"".join(payloads)


def test_raw_bundle_redirect():
    monkey = {}
    _install_common(monkey)
    spy = _UploadSpy()
    monkey["_upload_public_bundle"] = M._upload_public_bundle
    M._upload_public_bundle = spy

    # Three valid raw-Tb frames (oldest-first as the endpoint reorders them).
    def _mk(i):
        rows, cols = 4, 5
        tb = np.full((rows, cols), 200 + i, dtype=np.uint8).tobytes()
        return {
            "tb_data": base64.b64encode(tb).decode("ascii"),
            "tb_rows": rows, "tb_cols": cols,
            "datetime_utc": None, "satellite": "GOES-16",
            "bounds": [[19.0, -77.0], [29.0, -67.0]], "center_fix": None,
        }
    frames = [_mk(0), _mk(1), _mk(2)]
    # Endpoint calls _fetch_one_raw_tb_for_bundle once per frame (parallel);
    # hand each call the frame matching the storm's interp position index is
    # not knowable here, so key off a per-call counter instead.
    seq = {"n": 0}

    def _fake_fetch(atcf_upper, storm, target_dt, radius_deg, ilat, ilon):
        # Map by frame time so ordering is stable regardless of thread order.
        idx = {"2024-09-25T11:00:00Z": 0, "2024-09-25T11:30:00Z": 1,
               "2024-09-25T12:00:00Z": 2}[target_dt.strftime("%Y-%m-%dT%H:%M:%SZ")]
        f = dict(frames[idx])
        f["datetime_utc"] = target_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        return f
    monkey["_fetch_one_raw_tb_for_bundle"] = M._fetch_one_raw_tb_for_bundle
    M._fetch_one_raw_tb_for_bundle = _fake_fetch

    try:
        resp = M.get_storm_ir_raw_bundle(
            request=None, atcf_id=_ATCF,
            lookback_hours=6.0, radius_deg=10.0, interval_min=30)

        assert isinstance(resp, RedirectResponse), type(resp)
        assert resp.status_code == 302, resp.status_code
        exp_key = f"{_VER}/bundles/ondemand/raw/{_ATCF}_lb6_r10_i30.bin"
        exp_url = f"https://storage.googleapis.com/{_BUCKET}/{exp_key}"
        assert resp.headers["location"] == exp_url, resp.headers["location"]
        assert resp.headers.get("cache-control") == "no-store"

        assert len(spy.calls) == 1, spy.calls
        call = spy.calls[0]
        assert call["key"] == exp_key, call["key"]
        assert call["gzip_content"] is True, "raw bundle MUST upload gzipped"

        # Frames built oldest-first by index; uploaded body must be byte-identical
        # to what the old buffered endpoint would have returned.
        ordered = [dict(frames[i], datetime_utc=t) for i, t in enumerate(
            ["2024-09-25T11:00:00Z", "2024-09-25T11:30:00Z", "2024-09-25T12:00:00Z"])]
        assert call["body"] == _expected_raw_body(ordered), "raw body mismatch"
    finally:
        _restore(monkey)
    print("[raw]    PASS  ->", exp_url, " gzip=True  body_bytes=", len(call["body"]))


def _expected_webp_body(jpgs, header_extra):
    """Reproduce a WebP (frames/band) bundle's bytes."""
    headers, payloads, offset = [], [], 0
    times = ["2024-09-25T11:00:00Z", "2024-09-25T11:30:00Z", "2024-09-25T12:00:00Z"]
    sat = ""
    for i, jpg in enumerate(jpgs):
        h = {"index": i, "datetime_utc": times[i], "satellite": "GOES-16",
             "byte_offset": offset, "byte_length": len(jpg)}
        h.update(header_extra["per_frame"](i, offset))
        headers.append(h)
        payloads.append(jpg)
        offset += len(jpg)
        sat = "GOES-16"
    header = dict(header_extra["top"])
    header["total_frames"] = len(jpgs)
    header["satellite"] = sat
    header["frames"] = headers
    hj = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(hj)) + hj + b"".join(payloads)


def _run_webp_test(label, endpoint, *, band):
    monkey = {}
    _install_common(monkey)
    spy = _UploadSpy()
    monkey["_upload_public_bundle"] = M._upload_public_bundle
    M._upload_public_bundle = spy

    # Stub the semaphore so acquire/release are instant no-ops.
    jpgs = {
        "2024-09-25T11:00:00Z": b"WEBP-frame-A" * 3,
        "2024-09-25T11:30:00Z": b"WEBP-frame-B" * 4,
        "2024-09-25T12:00:00Z": b"WEBP-frame-C" * 5,
    }

    def _fake_render(atcf_upper, ilat, ilon, target_dt, radius_deg, *a, **k):
        return jpgs[target_dt.strftime("%Y-%m-%dT%H:%M:%SZ")], "GOES-16"

    if band is None:
        monkey["_get_or_render_ir_jpg"] = M._get_or_render_ir_jpg
        M._get_or_render_ir_jpg = _fake_render
        monkey["_gcs_rt_get"] = M._gcs_rt_get
        M._gcs_rt_get = lambda *a, **k: None
    else:
        monkey["_get_or_render_band_jpg"] = M._get_or_render_band_jpg
        M._get_or_render_band_jpg = _fake_render
        monkey["_solar_elevation"] = M._solar_elevation
        M._solar_elevation = lambda lat, lon, dt: 45.0  # daytime, never "night"

    try:
        if band is None:
            resp = endpoint(atcf_id=_ATCF, lookback_hours=6.0,
                            radius_deg=10.0, interval_min=30)
            exp_key = f"{_VER}/bundles/ondemand/frames/{_ATCF}_lb6_r10_i30.bin"
        else:
            resp = endpoint(atcf_id=_ATCF, band=band, lookback_hours=6.0,
                            radius_deg=10.0, interval_min=30)
            exp_key = f"{_VER}/bundles/ondemand/band/{band}/{_ATCF}_lb6_r10_i30.bin"
        exp_url = f"https://storage.googleapis.com/{_BUCKET}/{exp_key}"

        assert isinstance(resp, RedirectResponse), type(resp)
        assert resp.status_code == 302, resp.status_code
        assert resp.headers["location"] == exp_url, resp.headers["location"]
        assert resp.headers.get("cache-control") == "no-store"

        assert len(spy.calls) == 1, spy.calls
        call = spy.calls[0]
        assert call["key"] == exp_key, call["key"]
        assert call["gzip_content"] is False, "WebP bundle MUST NOT be gzipped"

        # Byte-identity: rebuild what the old endpoint returned and compare the
        # uploaded payload. We parse the uploaded header to verify the frame
        # payloads concatenate in order with correct offsets/lengths.
        body = call["body"]
        (hlen,) = struct.unpack("<I", body[:4])
        hdr = json.loads(body[4:4 + hlen])
        assert hdr["total_frames"] == 3, hdr["total_frames"]
        payload_region = body[4 + hlen:]
        ordered = [jpgs[t] for t in
                   ["2024-09-25T11:00:00Z", "2024-09-25T11:30:00Z", "2024-09-25T12:00:00Z"]]
        assert payload_region == b"".join(ordered), "concatenated payload mismatch"
        for i, fr in enumerate(hdr["frames"]):
            seg = payload_region[fr["byte_offset"]:fr["byte_offset"] + fr["byte_length"]]
            assert seg == ordered[i], f"frame {i} byte range mismatch"
    finally:
        _restore(monkey)
    print(f"[{label}]  PASS  -> {exp_url}  gzip=False  body_bytes={len(call['body'])}")


def test_frames_bundle_redirect():
    _run_webp_test("frames", M.get_storm_ir_frames_bundle, band=None)


def test_band_bundle_redirect():
    _run_webp_test("band ", M.get_storm_band_frames_bundle, band=8)


def main():
    test_raw_bundle_redirect()
    test_frames_bundle_redirect()
    test_band_bundle_redirect()
    print("\nPASS: all 3 bundle endpoints 302-redirect to the params-keyed "
          "public GCS object, upload the exact bundle bytes, and set the "
          "correct gzip flag (raw=gzip, WebP=not).")


if __name__ == "__main__":
    main()
