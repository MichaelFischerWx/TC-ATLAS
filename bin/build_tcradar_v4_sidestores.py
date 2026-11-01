#!/usr/bin/env python3
"""Re-key the swath-indexed TC-RADAR side stores (MergIR IR, ERA5 environment) from v3m to v4.0 case numbers.

v4.0 renumbers the swath cases from 710 on (Nestor 2019 inserted, extra 2024 cases, 127 new 2025 cases). Every v3m
case exists in v4.0 with the same (mission_id, datetime), so the v3m stores are carried over, not rebuilt:
  * per-case chunks (Tb, the ERA5 plan-view fields, profiles) are COPIED server-side within GCS to the v4 index
    (no download);
  * whole-axis arrays (status, center_lat/lon, datetimes, env scalars) are read, re-indexed and rewritten;
  * cases new in v4.0 get status 0 (the API answers 404 "No IR / ERA5 data") until their data are built.

Also writes tc_radar_v3m_to_v4.json ({"swath": {v3m: v4}, "merge": {v3m: v4}}) -- the map the explorer uses to
translate old #case= links -- from the committed v3m metadata and the v4 metadata (tc_radar_metadata*_v4.json).

Usage: python3 bin/build_tcradar_v4_sidestores.py [--stores mergir era5] [--map-only] [--workers 32]
"""
from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SRC, DST = "tc-atlas-zarr/tc-radar", "tc-atlas-zarr/tc-radar-v4"


def case_map() -> dict:
    out = {}
    for dt, a, b in (("swath", "tc_radar_metadata.json", "tc_radar_metadata_v4.json"),
                     ("merge", "tc_radar_metadata_merge.json", "tc_radar_metadata_merge_v4.json")):
        old = json.loads((ROOT / a).read_text())["cases"]; new = json.loads((ROOT / b).read_text())["cases"]
        idx = {(c["mission_id"], c["datetime"]): c["case_index"] for c in new}
        m = {c["case_index"]: idx.get((c["mission_id"], c["datetime"])) for c in old}
        miss = [k for k, v in m.items() if v is None]
        if miss:
            raise SystemExit(f"{dt}: {len(miss)} v3m cases have no v4.0 match, e.g. {miss[:5]}")
        out[dt] = {"n_v3m": len(old), "n_v4": len(new), "map": {str(k): v for k, v in m.items()}}
    return out


def rekey_store(name: str, smap: dict[int, int], n_new: int, workers: int, log) -> None:
    import gcsfs
    import zarr
    fs = gcsfs.GCSFileSystem()
    src = zarr.open_consolidated(gcsfs.GCSMap(root=f"{SRC}/{name}", gcs=fs, check=False), mode="r")
    dmap = gcsfs.GCSMap(root=f"{DST}/{name}", gcs=fs, check=False)
    dst = zarr.open_group(dmap, mode="w")
    dst.attrs.update(dict(src.attrs))
    n_old = max(smap) + 1
    copies = []
    for key, a in src.arrays():
        if a.ndim == 0 or a.shape[0] != n_old:                       # coordinate-like (lags, offsets, plev): as is
            d = dst.create_dataset(key, data=a[...], chunks=a.chunks, dtype=a.dtype, compressor=a.compressor,
                                   fill_value=a.fill_value, overwrite=True)
            d.attrs.update(dict(a.attrs)); continue
        shape = (n_new,) + a.shape[1:]
        if a.chunks[0] == 1:                                          # one chunk per case: server-side copy
            d = dst.create_dataset(key, shape=shape, chunks=a.chunks, dtype=a.dtype, compressor=a.compressor,
                                   fill_value=a.fill_value, overwrite=True)
            d.attrs.update(dict(a.attrs))
            rest = "." + ".".join("0" for _ in a.shape[1:]) if a.ndim > 1 else ""
            for o, nw in smap.items():
                copies.append((f"{SRC}/{name}/{key}/{o}{rest}", f"{DST}/{name}/{key}/{nw}{rest}"))
        else:                                                         # whole-axis array: re-index in memory
            old = a[...]
            fill = 0 if key == "status" else (np.nan if np.issubdtype(a.dtype, np.floating) else
                                              (a.fill_value if a.fill_value is not None else 0))
            new = np.full(shape, fill, dtype=a.dtype)
            for o, nw in smap.items():
                new[nw] = old[o]
            chunks = (n_new,) + tuple(a.chunks[1:])
            d = dst.create_dataset(key, data=new, chunks=chunks, dtype=a.dtype, compressor=a.compressor,
                                   fill_value=a.fill_value, overwrite=True)
            d.attrs.update(dict(a.attrs))
        log(f"  {name}/{key}: {a.shape} -> {shape}")
    log(f"  {name}: {len(copies)} chunk objects to copy server-side")
    t0 = time.time(); done = [0]; missing = [0]

    def cp(pair):
        s, t = pair
        try:
            fs.copy(s, t)
        except FileNotFoundError:
            missing[0] += 1                                           # an all-fill chunk zarr never wrote
        done[0] += 1
        if done[0] % 2000 == 0:
            log(f"    {done[0]}/{len(copies)} copied ({time.time() - t0:.0f} s)")
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(cp, copies))
    zarr.consolidate_metadata(dmap)
    log(f"  {name}: done in {time.time() - t0:.0f} s ({missing[0]} source chunks absent = fill)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stores", nargs="+", default=["mergir", "era5"])
    ap.add_argument("--map-only", action="store_true")
    ap.add_argument("--workers", type=int, default=32)
    a = ap.parse_args()
    log = lambda m: print(time.strftime("%H:%M:%S"), m, flush=True)  # noqa: E731
    cm = case_map()
    (ROOT / "tc_radar_v3m_to_v4.json").write_text(json.dumps(cm, separators=(",", ":")))
    log(f"wrote tc_radar_v3m_to_v4.json: swath {cm['swath']['n_v3m']}->{cm['swath']['n_v4']}, merge {cm['merge']['n_v3m']}->{cm['merge']['n_v4']}")
    if a.map_only:
        return 0
    smap = {int(k): v for k, v in cm["swath"]["map"].items()}
    for s in a.stores:
        rekey_store(s, smap, cm["swath"]["n_v4"], a.workers, log)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
