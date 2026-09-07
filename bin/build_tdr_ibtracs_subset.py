#!/usr/bin/env python3
"""Build ibtracs_tdr_subset.json — the IBTrACS storms + tracks the TC-RADAR
explorer actually draws.

The explorer's default "Tracks" map view needs best tracks for the ~90 storms
that have TC-RADAR analyses, but it used to fetch the entire IBTrACS archive
(ibtracs_storms.json + both track chunks: ~6.8 MB gzip, ~46 MB parsed) to get
them. This script selects the matching storms with the SAME name|year → SID
rule as tc_radar_app.js:_buildTDRtoSIDMapping (prefer NA/EP when a name+year
is shared across basins) and writes one small file:

    ibtracs_tdr_subset.json   { "metadata": {...},
                                "storms": [ <ibtracs_storms.json rows> ],
                                "tracks": { sid: [ {t, la, lo, w, p, n}, ... ] } }

Inputs (repo root): tc_radar_metadata.json, tc_radar_metadata_merge.json,
ibtracs_storms.json, ibtracs_tracks_manifest.json + chunks.
Re-run after pipeline/refresh_ibtracs.py (which also calls this) or whenever
the TC-RADAR metadata gains new storms.

Usage:  python3 bin/build_tdr_ibtracs_subset.py [--root PATH]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def build(root: Path) -> dict:
    keys: set[str] = set()
    for name in ("tc_radar_metadata.json", "tc_radar_metadata_merge.json"):
        p = root / name
        if not p.exists():
            continue
        for c in json.loads(p.read_text())["cases"]:
            if c.get("storm_name") and c.get("year") is not None:
                keys.add(f"{c['storm_name']}|{c['year']}")

    storms_all = json.loads((root / "ibtracs_storms.json").read_text())["storms"]
    # Same preference rule as the frontend: first seen wins unless a later
    # NA/EP storm shares the key.
    by_key: dict[str, dict] = {}
    for s in storms_all:
        if not (s.get("name") and s.get("year") is not None):
            continue
        k = f"{s['name']}|{s['year']}"
        if k not in keys:
            continue
        if k not in by_key or s.get("basin") in ("NA", "EP"):
            by_key[k] = s
    # Keep every storm that shares a matched name|year so the frontend's own
    # preference rule sees the same candidates it would in the full file.
    wanted_keys = set(by_key)
    storms = [s for s in storms_all
              if s.get("name") and s.get("year") is not None
              and f"{s['name']}|{s['year']}" in wanted_keys]
    sids = {s["sid"] for s in storms}

    tracks: dict[str, list] = {}
    manifest = json.loads((root / "ibtracs_tracks_manifest.json").read_text())
    for chunk in manifest["chunks"]:
        data = json.loads((root / chunk).read_text())
        for sid in sids:
            if sid in data:
                tracks[sid] = data[sid]

    missing = sorted(keys - wanted_keys)
    return {
        "metadata": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "ibtracs_storms.json + ibtracs_tracks_*.json",
            "tdr_storm_keys": len(keys),
            "matched_keys": len(wanted_keys),
            "unmatched_keys": missing,
            "n_storms": len(storms),
            "n_tracks": len(tracks),
        },
        "storms": storms,
        "tracks": tracks,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    args = ap.parse_args()
    root = Path(args.root)
    payload = build(root)
    out = root / "ibtracs_tdr_subset.json"
    tmp = out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")))
    tmp.replace(out)
    m = payload["metadata"]
    print(f"wrote {out.name}: {m['n_storms']} storms, {m['n_tracks']} tracks, "
          f"{out.stat().st_size/1e3:.0f} KB; {m['matched_keys']}/{m['tdr_storm_keys']} "
          f"TDR storm keys matched; unmatched: {m['unmatched_keys']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
