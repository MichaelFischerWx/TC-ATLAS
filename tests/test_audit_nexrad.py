#!/usr/bin/env python3
"""Regression tests for nexrad_api audit fixes (no network, no GCS).

Runnable standalone:  python3 tests/test_audit_nexrad.py
"""
import os
import sys
from datetime import datetime, timezone

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from fastapi import HTTPException  # noqa: E402

import nexrad_api as N  # noqa: E402


def test_s3_key_validation():
    good = [
        "unidata-nexrad-level2/2024/09/26/KTLH/KTLH20240926_000218_V06",
        "unidata-nexrad-level2/2005/08/29/KLIX/KLIX20050829_000249.gz",
        "unidata-nexrad-level2/1999/09/15/KAMX/KAMX19990915_001031.gz",
    ]
    for k in good:
        assert N._validate_s3_key(k) == k
    bad = [
        "",
        "noaa-goes16/ABI-L1b-RadF/2024/270/00/big.nc",
        "unidata-nexrad-level2/2024/09/26/KTLH/KTLH20240926_000218_V06_MDM",
        "unidata-nexrad-level2/2024/09/26/KTLH/KAMX20240926_000218_V06",
        "unidata-nexrad-level2/2024/09/26/ZZZZ/ZZZZ20240926_000218_V06",
        "unidata-nexrad-level2/2024/09/26/KTLH/../KTLH20240926_000218_V06",
    ]
    for k in bad:
        try:
            N._validate_s3_key(k)
        except HTTPException as e:
            assert e.status_code == 400
        else:
            raise AssertionError(f"accepted bad key {k!r}")


def test_listing_spans_window_dates():
    listed = []

    class _FS:
        def ls(self, prefix):
            listed.append(prefix)
            return []

    saved = N._get_nexrad_fs
    N._get_nexrad_fs = lambda: _FS()
    try:
        dt = datetime(2024, 9, 26, 20, 0, tzinfo=timezone.utc)
        N._list_scans_s3("KTLH", dt, window_min=360)
        assert [p.split("/")[1:4] for p in listed] == [
            ["2024", "09", "26"], ["2024", "09", "27"]]
        listed.clear()
        dt = datetime(2024, 9, 26, 12, 0, tzinfo=timezone.utc)
        N._list_scans_s3("KTLH", dt, window_min=60)
        assert len(listed) == 1
    finally:
        N._get_nexrad_fs = saved


def test_gcs_key_default_unchanged():
    k = N._gcs_cache_key("KTLH", "a/b", "reflectivity", 0, 300)
    assert k.endswith("/reflectivity_0_300km.json"), k
    k2 = N._gcs_cache_key("KTLH", "a/b", "reflectivity", 0, 300, 500)
    assert k2.endswith("/reflectivity_0_300km_500m.json"), k2


def test_frame_cache_byte_cap():
    saved = (N._CACHE_MAX_BYTES, N._frame_cache_bytes)
    N._frame_cache.clear()
    N._frame_cache_sizes.clear()
    N._frame_cache_bytes = 0
    N._CACHE_MAX_BYTES = 3_000_000
    try:
        for i in range(10):
            N._cache_put(f"k{i}", {"data": "x" * 1_000_000})
        assert len(N._frame_cache) == 3
        assert N._frame_cache_bytes <= N._CACHE_MAX_BYTES
        assert "k9" in N._frame_cache and "k0" not in N._frame_cache
        N._cache_put("k9", {"data": "x" * 10})  # replace keeps accounting exact
        assert N._frame_cache_bytes == 2_000_010
    finally:
        N._frame_cache.clear()
        N._frame_cache_sizes.clear()
        N._CACHE_MAX_BYTES, N._frame_cache_bytes = saved[0], 0


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
