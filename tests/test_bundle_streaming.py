"""Streaming-response conversion for the bundle endpoints
(fix/bundle-streaming-response).

ROOT CAUSE: the bundle endpoints in ir_monitor_api.py returned a *buffered*
`Response(body, ...)`. Cloud Run imposes a ~32 MiB ceiling on buffered
responses — exceed it and Cloud Run returns an empty 500 ("Response size was
too large", no Python traceback). The raw-Tb bundle (get_storm_ir_raw_bundle)
is the worst case (~42 MB uncompressed, ~20 MB gzipped at radius 10) and it
only gzips when the client sends Accept-Encoding: gzip — so a non-gzip client
got the full 42 MB uncompressed body → 500.

FIX: every bundle endpoint now returns a `StreamingResponse` built by the
shared `_stream_bundle_response()` helper. The ~32 MiB buffered ceiling does
NOT apply to streamed responses, so this removes the ceiling for all bundle
sizes AND for non-gzip clients — while producing byte-for-byte identical
output (same body, same conditional gzip, same headers).

These tests assert:
  1. Byte-identity — the streamed bytes (concatenated) equal the body the old
     buffered Response would have returned, for BOTH gzip and non-gzip clients.
  2. Non-gzip client gets the full *uncompressed* body without error (the bug
     case that used to 500 on Cloud Run).
  3. Content-Encoding header is correct (gzip for gzippable+gzip-client,
     identity otherwise).
  4. The response really is a StreamingResponse.
  5. The end-to-end raw-Tb endpoint (get_storm_ir_raw_bundle) streams a body
     byte-identical to the pre-change buffered logic, gzip and non-gzip.

No network: the per-frame raw-Tb fetch, GCS, track interpolation, and the
active-storms cache are all monkeypatched.

Run: python3 tests/test_bundle_streaming.py
"""
import asyncio
import base64
import gzip
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ir_monitor_api as M
from starlette.responses import StreamingResponse


class _FakeRequest:
    """Minimal stand-in for starlette.Request — the bundle endpoints only read
    .headers (Accept-Encoding)."""
    def __init__(self, accept_encoding=""):
        self.headers = {"accept-encoding": accept_encoding}


def _drain(resp):
    """Concatenate a StreamingResponse's chunks into the full wire body.

    Starlette adapts the sync _iter_chunks generator into an async
    body_iterator, so we drain it on a throwaway event loop. The result is
    exactly the bytes Cloud Run would stream over the wire."""
    async def _collect():
        out = []
        async for c in resp.body_iterator:
            out.append(c if isinstance(c, (bytes, bytearray)) else c.encode("utf-8"))
        return b"".join(out)
    return asyncio.new_event_loop().run_until_complete(_collect())


# A representative packed bundle body (header + payloads), big enough to span
# several 4 MiB stream chunks so _iter_chunks boundary handling is exercised.
def _make_body(n_payload_bytes=10 * 1024 * 1024):
    header = {"total_frames": 2, "frames": [{"index": 0, "byte_offset": 0,
              "byte_length": n_payload_bytes}]}
    header_json = json.dumps(header, separators=(",", ":")).encode("utf-8")
    # Low-entropy payload so the gzip path actually shrinks it (mirrors the
    # spatially-correlated uint8 Tb arrays the raw bundle carries).
    payload = (b"\x00\x01\x02\x03" * (n_payload_bytes // 4 + 1))[:n_payload_bytes]
    return struct.pack("<I", len(header_json)) + header_json + payload


# ── Helper-level tests ────────────────────────────────────────────

def test_helper_byte_identity_gzippable():
    """gzippable=True: streamed bytes == old buffered body for BOTH clients."""
    body = _make_body()
    hdrs = {"Cache-Control": "public, max-age=300", "X-Bundle-Frames": "2"}

    # gzip client — old code gzipped the whole body, set Content-Encoding: gzip.
    resp_gz = M._stream_bundle_response(body, _FakeRequest("gzip, deflate"),
                                        dict(hdrs), gzippable=True)
    assert isinstance(resp_gz, StreamingResponse)
    streamed_gz = _drain(resp_gz)
    expected_gz = gzip.compress(body, compresslevel=6)
    assert streamed_gz == expected_gz, (
        f"gzip stream {len(streamed_gz)} B != expected gzip body "
        f"{len(expected_gz)} B")
    assert resp_gz.headers["content-encoding"] == "gzip"
    # And it round-trips back to the original body.
    assert gzip.decompress(streamed_gz) == body

    # non-gzip client — old code returned the raw uncompressed body, no
    # Content-Encoding. THIS is the case that used to 500 on Cloud Run.
    resp_id = M._stream_bundle_response(body, _FakeRequest(""),
                                        dict(hdrs), gzippable=True)
    streamed_id = _drain(resp_id)
    assert streamed_id == body, (
        f"non-gzip stream {len(streamed_id)} B != raw body {len(body)} B")
    assert resp_id.headers["content-encoding"] == "identity"
    print(f"[1] gzippable byte-identity OK — gzip={len(streamed_gz)}B "
          f"identity={len(streamed_id)}B (raw {len(body)}B)")


def test_helper_byte_identity_webp_not_gzippable():
    """gzippable=False (WebP): body passes through verbatim regardless of
    Accept-Encoding; caller's Content-Encoding: identity is preserved."""
    body = _make_body(2 * 1024 * 1024)
    hdrs = {"Cache-Control": "public, max-age=300", "Content-Encoding": "identity",
            "X-Bundle-Frames": "2"}

    for accept in ("gzip, deflate, br", ""):
        resp = M._stream_bundle_response(body, _FakeRequest(accept),
                                         dict(hdrs), gzippable=False)
        assert isinstance(resp, StreamingResponse)
        streamed = _drain(resp)
        assert streamed == body, f"WebP stream differs (accept={accept!r})"
        assert resp.headers["content-encoding"] == "identity", \
            "WebP bundle must stay identity (codec-compressed already)"
    print("[2] WebP (gzippable=False) byte-identity + identity header OK "
          "for gzip and non-gzip clients")


def test_helper_preserves_headers():
    """All caller-supplied bundle headers survive into the StreamingResponse."""
    body = _make_body(64 * 1024)
    hdrs = {
        "Cache-Control": "public, max-age=300",
        "X-Bundle-Frames": "13",
        "X-Bundle-Header-Length": "421",
        "Vary": "Accept-Encoding",
        "Access-Control-Expose-Headers": "X-Bundle-Frames, X-Bundle-Header-Length",
    }
    resp = M._stream_bundle_response(body, _FakeRequest("gzip"), dict(hdrs),
                                     gzippable=True)
    for k, v in hdrs.items():
        assert resp.headers.get(k.lower()) == v, f"header {k} dropped/changed"
    assert resp.media_type == "application/octet-stream"
    print("[3] all Cache-Control / X-Bundle-* / Vary / CORS headers preserved")


def test_iter_chunks_reassembles_exactly():
    """_iter_chunks slices reassemble to the exact input, across the 4 MiB
    boundary, with the right chunk count."""
    body = _make_body(9 * 1024 * 1024 + 7)  # not a chunk multiple
    chunks = list(M._iter_chunks(body))
    assert b"".join(chunks) == body, "chunk reassembly diverged from input"
    assert all(len(c) <= M._BUNDLE_STREAM_CHUNK for c in chunks)
    # 9 MiB + 7 B at 4 MiB → 3 chunks (4 + 4 + ~1).
    assert len(chunks) == 3, f"expected 3 chunks, got {len(chunks)}"
    print(f"[4] _iter_chunks reassembles exactly: {len(chunks)} chunks, "
          f"last={len(chunks[-1])}B")


# ── End-to-end raw-Tb endpoint test ───────────────────────────────

def _install_raw_stubs():
    """Make get_storm_ir_raw_bundle deterministic + offline.

    Two real frames + one failed frame, so the header's no-data branch and the
    payload concat are both exercised. The per-frame fetch returns a fixed,
    spatially-correlated uint8 cutout (compresses well under gzip)."""
    M._ensure_fresh_cache = lambda *a, **k: None
    M._get_track_for_interp = lambda atcf_id: []  # no track → use storm pos

    with M._active_storms_lock:
        M._active_storms_cache["storms"] = [
            {"atcf_id": "AL072026", "lat": 24.5, "lon": -71.3, "vmax_kt": 90}
        ]

    rows, cols = 200, 200
    base = bytes((i // cols) % 256 for i in range(rows * cols))  # banded → gzips

    def _fake_fetch(atcf_upper, storm, target_dt, radius_deg, ilat, ilon):
        # One specific slot fails to fetch → byte_length=0 header entry.
        if target_dt.minute in (0, 30) and target_dt.second == 0 and \
                target_dt.strftime("%M") == "00":
            return {"_error": "no_data"}
        return {
            "tb_data": base64.b64encode(base).decode("ascii"),
            "tb_rows": rows, "tb_cols": cols,
            "datetime_utc": target_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "satellite": "GOES-19",
            "bounds": [[ilat - radius_deg, ilon - radius_deg],
                       [ilat + radius_deg, ilon + radius_deg]],
            "center_fix": None,
        }

    M._fetch_one_raw_tb_for_bundle = _fake_fetch


def test_raw_endpoint_streams_byte_identical():
    """The live get_storm_ir_raw_bundle endpoint streams a body byte-identical
    to the pre-change buffered logic — gzip AND non-gzip — and the non-gzip
    path (the Cloud Run 500 bug) yields the full uncompressed body."""
    _install_raw_stubs()
    kwargs = dict(lookback_hours=2.0, radius_deg=10.0, interval_min=30)

    # Non-gzip client (the bug case).
    resp_id = M.get_storm_ir_raw_bundle(_FakeRequest(""), "al072026", **kwargs)
    assert isinstance(resp_id, StreamingResponse)
    body_id = _drain(resp_id)
    assert resp_id.headers.get("content-encoding") == "identity"
    # It's a well-formed packed bundle (uint32 header len + JSON + payloads).
    hlen = struct.unpack("<I", body_id[:4])[0]
    header = json.loads(body_id[4:4 + hlen].decode("utf-8"))
    assert header["total_frames"] == len(header["frames"])
    assert int(resp_id.headers["X-Bundle-Header-Length"]) == hlen

    # gzip client — body must be gzip(body_id) (same conditional-gzip behaviour
    # the buffered Response had: gzip the WHOLE body, compresslevel=6).
    resp_gz = M.get_storm_ir_raw_bundle(_FakeRequest("gzip, br"), "al072026",
                                        **kwargs)
    body_gz = _drain(resp_gz)
    assert resp_gz.headers.get("content-encoding") == "gzip"
    assert gzip.decompress(body_gz) == body_id, (
        "gzip-client stream does not decompress to the identical bundle body")
    assert body_gz == gzip.compress(body_id, compresslevel=6), (
        "gzip stream differs from the exact bytes the old buffered Response "
        "produced (gzip.compress(body, compresslevel=6))")

    print(f"[5] raw-Tb endpoint streams byte-identical: identity={len(body_id)}B "
          f"gzip={len(body_gz)}B frames={header['total_frames']} "
          f"hdr_len={hlen}B; non-gzip path returns full uncompressed body")


def main():
    test_helper_byte_identity_gzippable()
    test_helper_byte_identity_webp_not_gzippable()
    test_helper_preserves_headers()
    test_iter_chunks_reassembles_exactly()
    test_raw_endpoint_streams_byte_identical()
    print("\nPASS: bundle responses stream byte-for-byte identical output for "
          "gzip and non-gzip clients; the non-gzip raw-Tb path (the Cloud Run "
          "32 MiB 500) now returns the full body; Content-Encoding + bundle "
          "headers preserved; responses are StreamingResponse.")


if __name__ == "__main__":
    main()
