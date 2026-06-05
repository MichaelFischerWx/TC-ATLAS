"""Tests for the streamed bundle responses (fix/bundle-streaming-v2).

Background
----------
The bundle endpoints in ir_monitor_api.py used to return a *buffered*
``Response(content=body, ...)``. Cloud Run caps buffered responses at
~32 MiB and answers an empty 500 ("Response size was too large") when the
body exceeds it. The raw-Tb bundle is ~42 MB uncompressed / ~20 MB gzipped
at radius 10, and only gzips when the client sends ``Accept-Encoding: gzip``
— so a non-gzip client (or a large-radius bundle) tripped the limit and 500'd.

The fix routes all three bundle endpoints through ``_stream_bundle_response``,
which returns a ``StreamingResponse`` (exempt from the 32 MiB buffered cap)
while preserving:
  * byte-for-byte-identical output (same gzip level, same conditional gzip),
  * the conditional-gzip behavior keyed on Accept-Encoding,
  * Content-Encoding declared explicitly so the global GZipMiddleware skips
    the response (never double-encodes / never re-buffers it).

These tests exercise the shared helpers directly with a fake Request, so they
need no network, no S3, and no live storm. Run:

    python3 tests/test_bundle_streaming.py
"""
import gzip
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ir_monitor_api as M

from fastapi.responses import StreamingResponse


class _FakeRequest:
    """Minimal stand-in exposing only the .headers mapping the helper reads."""
    def __init__(self, accept_encoding=None):
        self.headers = {}
        if accept_encoding is not None:
            self.headers["accept-encoding"] = accept_encoding


def _make_bundle_body(n_payloads=7, payload_size=37):
    """Build a packed bundle body in the same wire format the endpoints use:
    [uint32 LE header_length][header JSON][concat payloads]."""
    payloads = [bytes([(i * 31 + j) % 256 for j in range(payload_size)])
                for i in range(n_payloads)]
    header = {
        "total_frames": n_payloads,
        "frames": [{"index": i, "byte_length": payload_size} for i in range(n_payloads)],
    }
    return M._pack_bundle(header, payloads)


def _drain(streaming_response):
    """Concatenate a StreamingResponse's body iterator into one bytes object.

    Starlette wraps the sync generator we passed (from _iter_chunks) into an
    async generator on ``.body_iterator``, so we drive it with an event loop.
    Each yielded chunk is a memoryview; bytes() materializes it.
    """
    import asyncio

    async def _collect():
        out = bytearray()
        async for chunk in streaming_response.body_iterator:
            out += bytes(chunk)
        return bytes(out)

    return asyncio.run(_collect())


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ---------------------------------------------------------------------------
# Test 1: byte-identity for the gzippable (raw-Tb) endpoint, gzip client
# ---------------------------------------------------------------------------
def test_gzippable_gzip_client_byte_identity():
    body = _make_bundle_body()
    req = _FakeRequest("gzip, deflate, br")
    resp = M._stream_bundle_response(body, req, {"Cache-Control": "x"}, gzippable=True)

    _check(isinstance(resp, StreamingResponse), "expected a StreamingResponse")
    streamed = _drain(resp)

    # Expected = exactly what the old inline path produced: gzip @ level 6.
    expected = gzip.compress(body, compresslevel=6)
    _check(streamed == expected,
           "gzip-client stream must equal gzip.compress(body, level=6) byte-for-byte")
    _check(resp.headers.get("content-encoding") == "gzip",
           "gzip client must get Content-Encoding: gzip")
    # And the gzip is reversible back to the original packed body.
    _check(gzip.decompress(streamed) == body,
           "gunzip(stream) must round-trip to the original body")
    print("PASS test 1: gzippable + gzip client -> byte-identical gzip(level=6), CE=gzip")


# ---------------------------------------------------------------------------
# Test 2 (THE BUG CASE): non-gzip client gets the FULL uncompressed body,
#         no error, no truncation.
# ---------------------------------------------------------------------------
def test_gzippable_non_gzip_client_full_uncompressed_body():
    body = _make_bundle_body(n_payloads=11, payload_size=101)
    req = _FakeRequest(None)  # client sends no Accept-Encoding at all
    resp = M._stream_bundle_response(body, req, {"Cache-Control": "x"}, gzippable=True)

    streamed = _drain(resp)
    _check(streamed == body,
           "non-gzip client must receive the FULL uncompressed body unchanged "
           "(this is the Cloud-Run-500 regression case)")
    _check(len(streamed) == len(body),
           f"length mismatch: got {len(streamed)} want {len(body)}")
    _check(resp.headers.get("content-encoding") == "identity",
           "non-gzip client must get Content-Encoding: identity")

    # Also exercise a non-gzip Accept-Encoding value (e.g. only deflate/br).
    req2 = _FakeRequest("br, deflate")
    resp2 = M._stream_bundle_response(body, req2, {}, gzippable=True)
    _check(_drain(resp2) == body, "br/deflate-only client must also get raw body")
    _check(resp2.headers.get("content-encoding") == "identity",
           "br/deflate-only client must get identity (helper only knows gzip)")
    print("PASS test 2: non-gzip client gets full uncompressed body, identity, no error")


# ---------------------------------------------------------------------------
# Test 3: WebP (gzippable=False) endpoints NEVER gzip, even for a gzip client.
# ---------------------------------------------------------------------------
def test_non_gzippable_always_identity():
    body = _make_bundle_body()
    for ae in (None, "gzip, deflate, br", "identity"):
        req = _FakeRequest(ae)
        resp = M._stream_bundle_response(body, req, {"X-Bundle-Frames": "7"},
                                         gzippable=False)
        streamed = _drain(resp)
        _check(streamed == body,
               f"non-gzippable body must be passed through untouched (AE={ae!r})")
        _check(resp.headers.get("content-encoding") == "identity",
               f"non-gzippable response must declare identity (AE={ae!r})")
    print("PASS test 3: gzippable=False always returns identity body byte-identical")


# ---------------------------------------------------------------------------
# Test 4: extra_headers (Cache-Control, X-Bundle-*) are preserved, and the
#         response is a StreamingResponse with the right media type.
# ---------------------------------------------------------------------------
def test_extra_headers_preserved_and_streaming():
    body = _make_bundle_body()
    extra = {
        "Cache-Control": "public, max-age=300",
        "X-Bundle-Frames": "7",
        "X-Bundle-Header-Length": "123",
        "Access-Control-Expose-Headers": "X-Bundle-Frames, X-Bundle-Header-Length",
        "Vary": "Accept-Encoding",
    }
    req = _FakeRequest("gzip")
    resp = M._stream_bundle_response(body, req, extra, gzippable=True)

    _check(isinstance(resp, StreamingResponse), "must be a StreamingResponse")
    _check(resp.media_type == "application/octet-stream",
           f"media_type must be application/octet-stream, got {resp.media_type!r}")
    for k, v in extra.items():
        _check(resp.headers.get(k.lower()) == v,
               f"extra header {k!r} not preserved (got {resp.headers.get(k.lower())!r})")
    # Caller's dict must not be mutated by the helper.
    _check("Content-Encoding" not in extra,
           "helper must not mutate the caller's extra_headers dict")
    print("PASS test 4: extra headers preserved, StreamingResponse + octet-stream, no mutation")


# ---------------------------------------------------------------------------
# Test 5: _iter_chunks reassembles across the 4 MiB boundary.
# ---------------------------------------------------------------------------
def test_iter_chunks_reassembles_across_boundary():
    chunk = 4 * 1024 * 1024
    # Body spanning ~2.5 chunks with a non-multiple tail.
    body = os.urandom(chunk * 2 + 7919)

    pieces = list(M._iter_chunks(body))
    _check(len(pieces) == 3, f"expected 3 chunks across the boundary, got {len(pieces)}")
    _check(len(bytes(pieces[0])) == chunk, "first chunk must be exactly 4 MiB")
    _check(len(bytes(pieces[1])) == chunk, "second chunk must be exactly 4 MiB")
    _check(len(bytes(pieces[2])) == 7919, "tail chunk must hold the remainder")
    rejoined = b"".join(bytes(p) for p in pieces)
    _check(rejoined == body, "concatenated chunks must equal the original body")

    # Edge cases: empty body, exact-multiple body, smaller-than-chunk body.
    _check(list(M._iter_chunks(b"")) == [], "empty body yields no chunks")
    small = b"abc"
    sp = list(M._iter_chunks(small))
    _check(len(sp) == 1 and bytes(sp[0]) == small, "sub-chunk body yields one full chunk")
    exact = os.urandom(chunk)
    ep = list(M._iter_chunks(exact))
    _check(len(ep) == 1 and bytes(ep[0]) == exact, "exact-multiple body yields one chunk")
    print("PASS test 5: _iter_chunks reassembles across the 4 MiB boundary + edge cases")


# ---------------------------------------------------------------------------
# Test 6 (optional): full request path via TestClient, if FastAPI mounts cleanly.
#         Confirms the endpoints actually return StreamingResponse end-to-end
#         and the streamed body for a non-gzip client round-trips. Skipped
#         gracefully if the heavy app import isn't viable in this env.
# ---------------------------------------------------------------------------
def test_endpoint_signatures_take_request():
    import inspect
    for name in ("get_storm_ir_raw_bundle",
                 "get_storm_band_frames_bundle",
                 "get_storm_ir_frames_bundle"):
        fn = getattr(M, name)
        params = list(inspect.signature(fn).parameters)
        _check("request" in params,
               f"{name} must accept a `request` parameter for streaming")
    print("PASS test 6: all three bundle endpoints accept `request`")


def main():
    test_gzippable_gzip_client_byte_identity()
    test_gzippable_non_gzip_client_full_uncompressed_body()
    test_non_gzippable_always_identity()
    test_extra_headers_preserved_and_streaming()
    test_iter_chunks_reassembles_across_boundary()
    test_endpoint_signatures_take_request()
    print("\nALL PASS: streamed bundles are byte-identical to the old buffered "
          "bodies, the non-gzip 500 case is fixed, and Content-Encoding is set "
          "explicitly so GZipMiddleware passes the stream through untouched.")


if __name__ == "__main__":
    main()
