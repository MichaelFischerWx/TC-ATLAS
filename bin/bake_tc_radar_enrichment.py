#!/usr/bin/env python3
"""Bake the API's per-case enrichment fields into the static TC-RADAR metadata.

The explorer used to call /metadata_all twice at boot (swath + merge, ~90 KB
gzip each, uncached) only to copy four Zarr-derived fields into the case
objects it already had from tc_radar_metadata*.json:

    max_er_wspd_05km, max_er_wspd_20km   (filter sliders)
    sddc, shdc                           (shear direction, side panel)

Those fields come from the enrichment sidecar the API loads at startup, so
they are static per case. This script pulls them once (from the live API by
default, or from a local sidecar JSON) and writes them into the static files;
the frontend then skips /metadata_all unless the fields are missing.

Usage:
    python3 bin/bake_tc_radar_enrichment.py                 # from api.tcatlas.org
    python3 bin/bake_tc_radar_enrichment.py --sidecar enrichment_sidecar.json
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

FIELDS = ("max_er_wspd_05km", "max_er_wspd_20km", "sddc", "shdc")
FILES = {"swath": "tc_radar_metadata.json", "merge": "tc_radar_metadata_merge.json"}


def _from_api(api: str, dt: str) -> dict[int, dict]:
    req = urllib.request.Request(f"{api}/metadata_all?data_type={dt}",
                                 headers={"User-Agent": "tc-atlas-bake/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        cases = json.load(r)["cases"]
    return {c["case_index"]: c for c in cases}


def _from_sidecar(path: Path, dt: str) -> dict[int, dict]:
    sec = json.loads(path.read_text()).get(dt, {})
    return {int(k): v for k, v in sec.items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    ap.add_argument("--api", default="https://api.tcatlas.org")
    ap.add_argument("--sidecar", help="local enrichment_sidecar.json instead of the API")
    args = ap.parse_args()
    root = Path(args.root)

    for dt, fname in FILES.items():
        p = root / fname
        static = json.loads(p.read_text())
        src = _from_sidecar(Path(args.sidecar), dt) if args.sidecar else _from_api(args.api, dt)
        n = {f: 0 for f in FIELDS}
        for c in static["cases"]:
            e = src.get(c["case_index"])
            if not e:
                continue
            for f in FIELDS:
                v = e.get(f)
                if v is not None:
                    c[f] = v
                    n[f] += 1
        static["enrichment_baked"] = True
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(static, separators=(",", ":")))
        tmp.replace(p)
        print(f"{fname}: {len(static['cases'])} cases; baked {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
