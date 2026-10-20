#!/usr/bin/env python3
"""Regression tests for tc_radar_api.py audit fixes (no network, no GCS).

tc_radar_api's module body starts background threads that reach the network,
so (like test_zarr_defensive_open.py) we pull only the definitions under test
out of the source with `ast` and exec them in a clean namespace.

Runnable standalone:  python3 tests/test_audit_core_api.py
"""
import ast
import collections
import io
import os
import sys
import threading
import time
import unittest

import numpy as np

API_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "tc_radar_api.py")

_NAMES = {
    # rate limiting / CORS / cache headers
    "_rate_window", "_rate_max_requests", "_rate_alert_threshold", "_rate_buckets",
    "_rate_rejections", "_rate_lock", "_client_ip", "_bot_rate_max_requests",
    "_BOT_EXEMPT_UA_PREFIXES", "_is_automated_client", "RateLimitMiddleware",
    "CacheHeaderMiddleware", "_CORS_ALLOW_METHODS", "_CORS_EXPOSE_HEADERS",
    "PublicCORSMiddleware",
    # composites
    "_COMPOSITE_MAX_CASES", "_cap_composite_cases", "_era5_rows_for_composite",
    "_CFAD_MAX_BINS", "_CFAD_MAX_BOOT_BIN_ITERS", "_cfad_bin_edges",
    # levels / plot
    "_LEVELS_KM", "_snap_level_km", "VARIABLES", "DERIVED_VARIABLES", "render_planview",
}


def _load():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse
    from starlette.datastructures import Headers, MutableHeaders
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request as StarletteRequest
    from starlette.responses import PlainTextResponse

    with open(API_PATH) as f:
        tree = ast.parse(f.read())
    keep = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in _NAMES:
            keep.append(node)
        elif isinstance(node, ast.Assign):
            if any(isinstance(t, ast.Name) and t.id in _NAMES for t in node.targets):
                keep.append(node)
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and node.target.id in _NAMES:
                keep.append(node)
    import xarray as xr
    ns = {
        "os": os, "np": np, "xr": xr, "io": io, "plt": plt, "threading": threading,
        "_time": time, "_collections": collections, "Optional": None,
        "HTTPException": HTTPException, "JSONResponse": JSONResponse,
        "Headers": Headers, "MutableHeaders": MutableHeaders,
        "PlainTextResponse": PlainTextResponse, "BaseHTTPMiddleware": BaseHTTPMiddleware,
        "StarletteRequest": StarletteRequest,
        "_rate_logger": __import__("logging").getLogger("test"),
        "_merge_to_swath_index": {},
        "__name__": "tc_radar_api_extract",
    }
    exec(compile(ast.Module(body=keep, type_ignores=[]), API_PATH, "exec"), ns)
    missing = _NAMES - set(ns)
    assert not missing, f"not found in tc_radar_api.py: {missing}"
    return ns


T = _load()


def _app(rate_max=1000):
    """Tiny app with the production middleware order: rate limiter and cache
    headers inside, PublicCORSMiddleware registered last (outermost)."""
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse, StreamingResponse

    T["_rate_buckets"].clear()
    T["_rate_rejections"].clear()
    T["_rate_max_requests"] = rate_max
    T["_bot_rate_max_requests"] = rate_max

    app = FastAPI()

    @app.get("/data")
    def data():
        return {"ok": True}

    @app.post("/composite/thing")
    def post_thing(body: dict):
        return body

    @app.get("/scatter/vp_favorability")
    def scatter():
        return JSONResponse({"x": 1}, headers={"Cache-Control": "no-store"})

    @app.get("/vary")
    def vary():
        return JSONResponse({"x": 1}, headers={
            "Vary": "Origin, Accept-Encoding",
            "Access-Control-Allow-Origin": "https://example.org",
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Expose-Headers": "X-Frame-Index",
        })

    @app.get("/composite/stream")
    def stream():
        return StreamingResponse(iter([b'{"error": "x"}\n']), media_type="application/x-ndjson",
                                 headers={"Cache-Control": "no-store"})

    @app.get("/missing")
    def missing():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="nope")

    @app.get("/boom")
    def boom():
        raise RuntimeError("boom")

    app.add_middleware(T["RateLimitMiddleware"])
    app.add_middleware(T["CacheHeaderMiddleware"])
    app.add_middleware(T["PublicCORSMiddleware"])
    return app


class CORSTests(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient
        self.c = TestClient(_app(), raise_server_exceptions=False)

    def _assert_cors(self, r):
        self.assertEqual(r.headers.get("access-control-allow-origin"), "*")
        self.assertNotIn("access-control-allow-credentials", r.headers)
        self.assertNotIn("origin", r.headers.get("vary", "").lower())

    def test_constant_acao_with_and_without_origin(self):
        for hdrs in ({}, {"Origin": "https://tcatlas.org"}, {"Origin": "https://evil.example"}):
            r = self.c.get("/data", headers=hdrs)
            self.assertEqual(r.status_code, 200)
            self._assert_cors(r)
            self.assertIn("ETag", r.headers["access-control-expose-headers"])

    def test_handler_vary_and_expose_are_cleaned_not_clobbered(self):
        r = self.c.get("/vary", headers={"Origin": "https://tcatlas.org"})
        self._assert_cors(r)
        self.assertIn("accept-encoding", r.headers.get("vary", "").lower())
        exp = r.headers["access-control-expose-headers"]
        self.assertIn("X-Frame-Index", exp)
        self.assertIn("X-Cache", exp)

    def test_errors_and_stream_carry_acao(self):
        for path, code in (("/missing", 404), ("/boom", 500), ("/composite/stream", 200)):
            r = self.c.get(path, headers={"Origin": "https://tcatlas.org"})
            self.assertEqual(r.status_code, code, path)
            self._assert_cors(r)

    def test_rate_limit_429_carries_acao(self):
        from fastapi.testclient import TestClient
        c = TestClient(_app(rate_max=2))
        codes = [c.get("/data", headers={"Origin": "https://tcatlas.org",
                                         "User-Agent": "Mozilla/5.0"}) for _ in range(4)]
        self.assertEqual(codes[-1].status_code, 429)
        self._assert_cors(codes[-1])

    def test_preflight_for_json_post(self):
        r = self.c.options("/composite/thing", headers={
            "Origin": "https://tcatlas.org",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertIn("POST", r.headers["access-control-allow-methods"])
        self.assertEqual(r.headers["access-control-allow-headers"], "content-type")
        r = self.c.post("/composite/thing", json={"a": 1}, headers={"Origin": "https://tcatlas.org"})
        self.assertEqual(r.json(), {"a": 1})
        self._assert_cors(r)


class CacheHeaderTests(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient
        self.c = TestClient(_app(), raise_server_exceptions=False)

    def test_handler_cache_control_kept(self):
        self.assertEqual(self.c.get("/scatter/vp_favorability").headers["cache-control"], "no-store")
        self.assertEqual(self.c.get("/composite/stream").headers["cache-control"], "no-store")

    def test_default_applied_when_handler_silent(self):
        self.assertIn("immutable", self.c.get("/data").headers["cache-control"])

    def test_errors_no_store(self):
        self.assertEqual(self.c.get("/missing").headers["cache-control"], "no-store")


class AutomatedTierTests(unittest.TestCase):
    def _req(self, ua):
        from starlette.requests import Request
        headers = [] if ua is None else [(b"user-agent", ua.encode())]
        return Request({"type": "http", "headers": headers})

    def test_tiers(self):
        f = T["_is_automated_client"]
        self.assertTrue(f(self._req(None)))
        self.assertTrue(f(self._req("")))
        self.assertTrue(f(self._req("python-requests/2.31")))
        self.assertFalse(f(self._req("Mozilla/5.0 (Macintosh)")))
        self.assertFalse(f(self._req("Google-Cloud-Scheduler")))


class CompositeTests(unittest.TestCase):
    def test_cap_is_even_and_deterministic(self):
        cap = T["_COMPOSITE_MAX_CASES"]
        cases = list(range(1510))
        out = T["_cap_composite_cases"](cases)
        self.assertEqual(len(out), cap)
        self.assertEqual(len(set(out)), cap)
        self.assertEqual(out, sorted(out))
        self.assertEqual(out[0], 0)
        self.assertGreater(out[-1], 1500)          # recent cases kept
        self.assertEqual(out, T["_cap_composite_cases"](cases))
        small = list(range(10))
        self.assertIs(T["_cap_composite_cases"](small), small)

    def test_era5_rows_translate_merge_indices(self):
        T["_merge_to_swath_index"].clear()
        T["_merge_to_swath_index"].update({0: 5, 1: 7, 3: 2})   # 2 unmapped
        status = np.array([1, 1, 1, 1, 1, 1, 1, 0])               # row 7 has no ERA5
        f = T["_era5_rows_for_composite"]
        self.assertEqual(f([0, 1, 2, 3], "merge", status), [(0, 5), (3, 2)])
        self.assertEqual(f([0, 6, 7, 99], "swath", status), [(0, 0), (6, 6)])

    def test_cfad_bin_edges(self):
        from fastapi import HTTPException
        f = T["_cfad_bin_edges"]
        self.assertEqual(len(f(-10, 80, 0.1, 40)) - 1, 900)       # finest UI width
        self.assertEqual(len(f(-10, 80, None, 40)), 41)
        for args in ((-10, 80, 0.0001, 40), (80, -10, None, 40), (-10, 80, float("inf"), 40),
                     (0, 1, 5.0, 40), (float("nan"), 1, None, 40)):
            with self.assertRaises(HTTPException, msg=str(args)) as cm:
                f(*args)
            self.assertEqual(cm.exception.status_code, 400)


class LevelAndPlotTests(unittest.TestCase):
    def test_snap_matches_argmin(self):
        s = T["_snap_level_km"]
        self.assertEqual(s(2.75), 2.5)
        self.assertEqual(s(2.8), 3.0)
        self.assertEqual(s(2.5), 2.5)
        self.assertEqual(s(0.2), 0.0)
        self.assertEqual(s(18.0), 18.0)
        grid = np.arange(37) * 0.5
        for lv in np.linspace(0, 18, 721):
            self.assertEqual(s(float(lv)), float(grid[np.argmin(np.abs(grid - lv))]))

    def test_render_planview_null_vmax_no_leak(self):
        import matplotlib.pyplot as plt
        import xarray as xr
        n = 5
        ds = xr.Dataset(
            {"recentered_tangential_wind": (("num_cases", "height", "northward_distance",
                                             "eastward_distance"), np.random.rand(1, 3, n, n))},
            coords={"height": [0.0, 0.5, 1.0],
                    "northward_distance": np.arange(n, dtype=float),
                    "eastward_distance": np.arange(n, dtype=float)},
        )
        plt.close("all")
        png = T["render_planview"](ds, 0, "recentered_tangential_wind", 0.5,
                                   {"storm_name": "X", "vmax_kt": None, "rmw_km": None})
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertEqual(plt.get_fignums(), [])
        # A render that fails part-way must not leave the figure open either.
        with self.assertRaises(Exception):
            T["render_planview"](ds, 0, "recentered_tangential_wind", 0.5,
                                 {"vmax_kt": "not-a-number"})
        self.assertEqual(plt.get_fignums(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
