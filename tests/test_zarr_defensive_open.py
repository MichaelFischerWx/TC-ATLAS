"""
Offline, mocked tests for the cost-control changes in tc_radar_api.py:

  1. `_open_zarr_group_consolidated` — uses consolidated open when it succeeds,
     falls back to the plain open when it raises.
  2. `_apply_enrichment_sidecar` — applies the sidecar when present, falls back
     (returns False) when absent.

We do NOT import tc_radar_api as a whole: its module body starts background
threads (`_ir_start_bg()` etc.) that hit GCS/network. Instead we extract just
the functions under test from the source with `ast` and exec them in a clean
namespace with mocked `zarr` / `gcsfs`. This keeps the tests credential- and
network-free.
"""
import ast
import json
import os
import sys
import types
import unittest

API_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "tc_radar_api.py")


def _extract_functions(names):
    """Return a namespace with the named top-level functions from tc_radar_api.py
    defined, plus injectable globals (json, Path, Optional, os, module-level
    sidecar globals/path placeholder)."""
    with open(API_PATH) as f:
        tree = ast.parse(f.read(), filename=API_PATH)
    wanted = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            wanted[node.name] = node
    missing = set(names) - set(wanted)
    if missing:
        raise AssertionError(f"functions not found in source: {missing}")

    from pathlib import Path
    from typing import Optional
    ns = {
        "json": json, "os": os, "Path": Path, "Optional": Optional,
        "print": lambda *a, **k: None,  # silence
        # module-level globals referenced by the functions:
        "ENRICHMENT_SIDECAR_PATH": "",
        "_metadata_cache": {},
        "_merge_metadata_cache": {},
        "_enrichment_sidecar_applied": False,
    }
    mod = ast.Module(body=list(wanted.values()), type_ignores=[])
    ast.fix_missing_locations(mod)
    exec(compile(mod, API_PATH, "exec"), ns)
    return ns


class TestDefensiveOpen(unittest.TestCase):
    def _run_with_fake_zarr(self, consolidated_raises):
        ns = _extract_functions(["_open_zarr_group_consolidated"])
        calls = {"consolidated": 0, "plain": 0}

        fake_zarr = types.ModuleType("zarr")
        sentinel_cons = object()
        sentinel_plain = object()

        def open_consolidated(store, mode="r"):
            calls["consolidated"] += 1
            if consolidated_raises:
                raise KeyError(".zmetadata")
            return sentinel_cons

        def zopen(store, mode="r"):
            calls["plain"] += 1
            return sentinel_plain

        fake_zarr.open_consolidated = open_consolidated
        fake_zarr.open = zopen

        saved = sys.modules.get("zarr")
        sys.modules["zarr"] = fake_zarr
        try:
            result = ns["_open_zarr_group_consolidated"](object(), "TEST")
        finally:
            if saved is not None:
                sys.modules["zarr"] = saved
            else:
                sys.modules.pop("zarr", None)
        return result, calls, sentinel_cons, sentinel_plain

    def test_uses_consolidated_when_it_succeeds(self):
        result, calls, sentinel_cons, sentinel_plain = self._run_with_fake_zarr(
            consolidated_raises=False)
        self.assertIs(result, sentinel_cons)
        self.assertEqual(calls["consolidated"], 1)
        self.assertEqual(calls["plain"], 0, "must NOT do a plain open when consolidated works")

    def test_falls_back_when_consolidated_raises(self):
        result, calls, sentinel_cons, sentinel_plain = self._run_with_fake_zarr(
            consolidated_raises=True)
        self.assertIs(result, sentinel_plain)
        self.assertEqual(calls["consolidated"], 1)
        self.assertEqual(calls["plain"], 1, "must fall back to the plain open on failure")


class TestSidecarLoader(unittest.TestCase):
    def _make_ns(self, sidecar_bytes, swath_cache, merge_cache):
        ns = _extract_functions(["_read_sidecar_bytes", "_apply_enrichment_sidecar"])
        ns["ENRICHMENT_SIDECAR_PATH"] = "/tmp/does-not-matter.json"
        ns["_metadata_cache"] = swath_cache
        ns["_merge_metadata_cache"] = merge_cache
        # Stub _read_sidecar_bytes so no filesystem/GCS is touched.
        ns["_read_sidecar_bytes"] = lambda path: sidecar_bytes
        return ns

    def test_applies_sidecar_when_present(self):
        swath = {0: {"storm_name": "A"}, 1: {"storm_name": "B"}}
        merge = {0: {"storm_name": "M"}}
        sidecar = json.dumps({
            "schema": 1,
            "swath": {"0": {"sddc": 90.0, "shdc": 12.0, "max_er_wspd_05km": 55.5},
                      "1": {"vp": None, "vmpi": 130.0}},  # None must NOT overwrite
            "merge": {"0": {"shdc": 8.0}},
        }).encode()
        ns = self._make_ns(sidecar, swath, merge)

        ok = ns["_apply_enrichment_sidecar"]()
        self.assertTrue(ok, "loader must report success when the sidecar is present")
        self.assertEqual(swath[0]["sddc"], 90.0)
        self.assertEqual(swath[0]["max_er_wspd_05km"], 55.5)
        self.assertEqual(swath[1]["vmpi"], 130.0)
        self.assertNotIn("vp", swath[1], "null sidecar values must not be written")
        self.assertEqual(merge[0]["shdc"], 8.0)
        # untouched base field preserved
        self.assertEqual(swath[0]["storm_name"], "A")

    def test_falls_back_when_sidecar_absent(self):
        swath = {0: {"storm_name": "A"}}
        merge = {}
        ns = self._make_ns(None, swath, merge)  # _read_sidecar_bytes returns None

        ok = ns["_apply_enrichment_sidecar"]()
        self.assertFalse(ok, "loader must report failure (fall back) when absent")
        self.assertEqual(swath[0], {"storm_name": "A"}, "cache must be unchanged")

    def test_falls_back_on_corrupt_sidecar(self):
        swath = {0: {"storm_name": "A"}}
        ns = self._make_ns(b"{not json", swath, {})
        ok = ns["_apply_enrichment_sidecar"]()
        self.assertFalse(ok)
        self.assertEqual(swath[0], {"storm_name": "A"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
