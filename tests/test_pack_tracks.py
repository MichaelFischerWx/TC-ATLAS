#!/usr/bin/env python3
"""Packed IBTrACS track chunks (pipeline/pack_tracks.py) are lossless.

The pages download ibtracs_tracks_pN.json and rebuild the per-fix objects
(tc_tracks.js), so a packed file that disagrees with its chunk would put
wrong tracks on every map. Covers:
  - round trip of every shape a fix takes (with/without w and p, off-hour
    times, negative and dateline-crossing coordinates)
  - values the format can't hold exactly are refused, not rounded
  - refresh_ibtracs.write_outputs writes packed files that match its chunks
  - the packed files committed in the repo root match the committed chunks

Runnable standalone:  python3 tests/test_pack_tracks.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (_REPO_ROOT, os.path.join(_REPO_ROOT, "pipeline")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pack_tracks as P  # noqa: E402

CHUNK = {
    "2017242N16333": [
        {"t": "2017-08-30T00:00", "la": 16.1, "lo": -26.9, "n": "TS", "w": 30.0, "p": 1008.0},
        {"t": "2017-08-30T03:00", "la": 16.2, "lo": -27.6, "n": "TS"},
        {"t": "2017-08-30T06:00", "la": 16.2, "lo": -28.3, "n": "TS", "w": 35.0},
        {"t": "2017-08-30T07:45", "la": 16.3, "lo": -28.7, "n": "SS", "p": 1004.0},
        {"t": "2017-09-01T00:00", "la": 18.0, "lo": -34.0, "n": "ET", "w": 100.0, "p": 967.0},
    ],
    "1842298N11080": [
        {"t": "1842-10-25T03:00", "la": 10.9, "lo": 80.3, "n": "NR"},
        {"t": "1842-10-25T06:00", "la": 10.9, "lo": 79.8, "n": "NR"},
    ],
    "2020050S12170": [
        {"t": "2020-02-29T21:00", "la": -12.0, "lo": 179.9, "n": "DS", "w": 0.0},
        {"t": "2020-03-01T00:00", "la": -12.4, "lo": -179.8, "n": "MX", "w": 25.0, "p": 999.0},
    ],
}


def test_round_trip_keeps_values_and_order():
    packed = P.pack_chunk(CHUNK)
    # Survives the JSON the browser actually receives.
    back = P.unpack_chunk(json.loads(json.dumps(packed, separators=(",", ":"))))
    assert back == CHUNK
    assert list(back) == list(CHUNK)
    for sid in CHUNK:
        assert [list(pt) for pt in back[sid]] == [list(pt) for pt in CHUNK[sid]]


def test_missing_wind_and_pressure_stay_missing():
    back = P.unpack_chunk(P.pack_chunk(CHUNK))
    assert "w" not in back["2017242N16333"][1] and "p" not in back["2017242N16333"][1]
    assert "p" not in back["2017242N16333"][2]
    assert "w" not in back["2017242N16333"][3]
    assert back["2020050S12170"][0]["w"] == 0.0      # a real 0 kt is not "missing"


def _refused(point):
    try:
        P.pack_chunk({"X": [point]})
    except (ValueError, KeyError):
        return True
    return False


def test_values_the_format_cannot_hold_are_refused():
    ok = {"t": "2020-01-01T00:00", "la": 10.0, "lo": 20.0, "n": "TS"}
    assert not _refused(ok)
    assert _refused(dict(ok, la=10.05))               # two decimals
    assert _refused(dict(ok, w=32.5))                 # fractional wind
    assert _refused(dict(ok, p=None))                 # explicit null
    assert _refused(dict(ok, n="XX"))                 # unknown nature
    assert _refused(dict(ok, t="2020-01-01T00:00:30"))  # seconds
    assert _refused(dict(ok, extra=1))                # a field it would drop
    try:
        P.pack_chunk({"X": []})
        assert False, "empty track should be refused"
    except ValueError:
        pass


def test_packed_name():
    assert P.packed_name("ibtracs_tracks_0.json") == "ibtracs_tracks_p0.json"
    assert P.packed_name("ibtracs_tracks_12.json") == "ibtracs_tracks_p12.json"
    try:
        P.packed_name("ibtracs_tracks.json")
        assert False
    except ValueError:
        pass


def test_refresh_writes_matching_packed_files():
    import refresh_ibtracs as R
    sids = list(CHUNK)
    chunk0 = {s: CHUNK[s] for s in sids[:1]}
    chunk1 = {s: CHUNK[s] for s in sids[1:]}
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        # write_outputs shells out to bin/build_tdr_ibtracs_subset.py at the
        # end and only warns if that fails, which it does in an empty root.
        R.write_outputs(CHUNK, [], chunk0, chunk1, {}, root)
        for name, chunk in (("ibtracs_tracks_0.json", chunk0), ("ibtracs_tracks_1.json", chunk1)):
            assert json.loads((root / name).read_text()) == chunk
            packed = json.loads((root / P.packed_name(name)).read_text())
            assert P.unpack_chunk(packed) == chunk
        # A chunk that can't be packed leaves NO packed file behind (the
        # pages then read the per-fix chunk), not last refresh's copy.
        bad = {"X": [{"t": "2020-01-01T00:00", "la": 10.05, "lo": 20.0, "n": "TS"}]}
        R.write_outputs(bad, [], bad, chunk1, {}, root)
        assert not (root / "ibtracs_tracks_p0.json").exists()
        assert (root / "ibtracs_tracks_p1.json").exists()


def test_committed_packed_files_match_committed_chunks():
    root = Path(_REPO_ROOT)
    for name in json.loads((root / "ibtracs_tracks_manifest.json").read_text())["chunks"]:
        chunk = json.loads((root / name).read_text())
        packed = json.loads((root / P.packed_name(name)).read_text())
        back = P.unpack_chunk(packed)
        assert back == chunk, name
        assert list(back) == list(chunk), name


if __name__ == "__main__":
    failed = 0
    for _name, _fn in sorted(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            try:
                _fn()
                print(f"PASS  {_name}")
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"FAIL  {_name}: {type(e).__name__}: {e}")
    sys.exit(1 if failed else 0)
