"""Packed (columnar, delta-coded) copies of the IBTrACS track chunks.

The track chunks the frontend reads are one JSON object per fix:

    ibtracs_tracks_N.json    { sid: [{t, la, lo, n, w?, p?}, ...], ... }

That shape is convenient and very repetitive: ~720,000 fixes cost 46 MB of
JSON (6.4 MB gzipped), all of it parsed on the main thread before the
Global Archive can draw a track. The packed copy holds the same values as
six columns per storm:

    ibtracs_tracks_pN.json   { format, epoch, nature, tracks: { sid: [
                                 dt,   # minutes; dt[0] since `epoch`, then deltas
                                 dla,  # latitude  x10; dla[0] absolute, then deltas
                                 dlo,  # longitude x10; dlo[0] absolute, then deltas
                                 n,    # one letter per fix (see `nature`)
                                 w,    # wind (kt), -1 where the fix has none
                                 p     # pressure (hPa), -1 where the fix has none
                             ], ... } }

It is ~12.5 MB of JSON, 1.6 MB gzipped, and tc_tracks.js rebuilds the exact
per-fix objects from it in the browser. The per-fix chunks stay: the Python
jobs read them, and tc_tracks.js falls back to them if a packed file is
missing.

Lossless only for what the tracks actually hold, which pack_chunk checks:
times on a whole minute, la/lo at one decimal, integer w/p, a known nature
code. Anything else raises instead of being rounded away.

pipeline/refresh_ibtracs.py writes the packed files with the chunks. To
repack the chunks already in the repo root (and verify the round trip):

    python3 pipeline/pack_tracks.py
    python3 pipeline/pack_tracks.py --check    # verify only, write nothing
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

FORMAT = "tc-tracks-packed/1"
EPOCH = datetime(1800, 1, 1)
EPOCH_ISO = "1800-01-01T00:00"
# One letter per IBTrACS nature code. Order is the on-disk contract with
# tc_tracks.js, which reads the map from the file rather than hard-coding it.
NATURE = {"T": "TS", "N": "NR", "E": "ET", "D": "DS", "M": "MX", "S": "SS"}
_NATURE_CODE = {v: k for k, v in NATURE.items()}
_POINT_KEYS = {"t", "la", "lo", "n", "w", "p"}


def packed_name(chunk_name: str) -> str:
    """ibtracs_tracks_0.json -> ibtracs_tracks_p0.json (tc_tracks.js does the same)."""
    stem, sep, tail = chunk_name.rpartition("_")
    if not sep or not tail.endswith(".json") or not tail[:-5].isdigit():
        raise ValueError(f"not a track chunk name: {chunk_name!r}")
    return f"{stem}_p{tail}"


def _tenths(v, what: str, sid: str) -> int:
    i = round(v * 10)
    if abs(v * 10 - i) > 1e-6:
        raise ValueError(f"{sid}: {what}={v!r} has more than one decimal")
    return i


def _whole(v, what: str, sid: str) -> int:
    if v is None or float(v) != int(v) or int(v) < 0:
        raise ValueError(f"{sid}: {what}={v!r} is not a non-negative integer")
    return int(v)


def _deltas(vals: list) -> list:
    return [vals[0]] + [vals[i] - vals[i - 1] for i in range(1, len(vals))]


def pack_track(sid: str, pts: list) -> list:
    if not pts:
        raise ValueError(f"{sid}: empty track")
    mins, la, lo, nat, w, p = [], [], [], [], [], []
    for pt in pts:
        extra = set(pt) - _POINT_KEYS
        if extra:
            raise ValueError(f"{sid}: unexpected point keys {sorted(extra)}")
        t = pt["t"]
        dt = datetime.strptime(t, "%Y-%m-%dT%H:%M")
        if len(t) != 16:
            raise ValueError(f"{sid}: time {t!r} is not YYYY-MM-DDTHH:MM")
        mins.append(int((dt - EPOCH).total_seconds() // 60))
        la.append(_tenths(pt["la"], "la", sid))
        lo.append(_tenths(pt["lo"], "lo", sid))
        if pt["n"] not in _NATURE_CODE:
            raise ValueError(f"{sid}: unknown nature {pt['n']!r}")
        nat.append(_NATURE_CODE[pt["n"]])
        w.append(_whole(pt["w"], "w", sid) if "w" in pt else -1)
        p.append(_whole(pt["p"], "p", sid) if "p" in pt else -1)
    return [_deltas(mins), _deltas(la), _deltas(lo), "".join(nat), w, p]


def pack_chunk(chunk: dict) -> dict:
    """{sid: [point, ...]} -> the packed payload (storm order preserved)."""
    return {
        "format": FORMAT,
        "epoch": EPOCH_ISO,
        "nature": NATURE,
        "tracks": {sid: pack_track(sid, pts) for sid, pts in chunk.items()},
    }


def unpack_chunk(packed: dict) -> dict:
    """Inverse of pack_chunk; mirrors the decoder in tc_tracks.js."""
    if packed.get("format") != FORMAT:
        raise ValueError(f"unknown packed-track format {packed.get('format')!r}")
    epoch = datetime.strptime(packed["epoch"], "%Y-%m-%dT%H:%M")
    nature = packed["nature"]
    out = {}
    for sid, (dt, dla, dlo, nat, w, p) in packed["tracks"].items():
        m = la = lo = 0
        pts = []
        for i in range(len(dt)):
            m += dt[i]
            la += dla[i]
            lo += dlo[i]
            pt = {
                "t": (epoch + timedelta(minutes=m)).strftime("%Y-%m-%dT%H:%M"),
                "la": la / 10,
                "lo": lo / 10,
                "n": nature[nat[i]],
            }
            if w[i] >= 0:
                pt["w"] = float(w[i])
            if p[i] >= 0:
                pt["p"] = float(p[i])
            pts.append(pt)
        out[sid] = pts
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(Path(__file__).resolve().parent.parent),
                    help="directory holding ibtracs_tracks_manifest.json (default: repo root)")
    ap.add_argument("--check", action="store_true",
                    help="verify the packed files on disk match the chunks; write nothing")
    args = ap.parse_args()
    root = Path(args.root)
    chunks = json.loads((root / "ibtracs_tracks_manifest.json").read_text())["chunks"]
    ok = True
    for name in chunks:
        chunk = json.loads((root / name).read_text())
        out = root / packed_name(name)
        if args.check:
            if not out.exists():
                print(f"MISSING  {out.name}")
                ok = False
                continue
            packed = json.loads(out.read_text())
        else:
            packed = pack_chunk(chunk)
        back = unpack_chunk(packed)
        same = back == chunk and list(back) == list(chunk)
        ok = ok and same
        if not args.check and same:
            tmp = out.with_suffix(out.suffix + ".tmp")
            tmp.write_text(json.dumps(packed, separators=(",", ":")))
            tmp.replace(out)
        size = out.stat().st_size / 1e6 if out.exists() else 0.0
        print(f"{'OK      ' if same else 'MISMATCH'} {name} -> {out.name}  "
              f"{len(chunk)} storms, {(root / name).stat().st_size / 1e6:.1f} MB -> {size:.1f} MB")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
