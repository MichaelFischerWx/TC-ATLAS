#!/usr/bin/env python3
"""Convert TC-RADAR v4.0 NetCDF (swath + merge) to the Zarr layout tc_radar_api.py serves.

Layout matches the v3m stores at gs://tc-atlas-zarr/tc-radar/{swath,merge}_{early,recent}:
zarr v2, consolidated metadata, float32 data (v4.0 packs most fields as int16 + scale_factor;
they are decoded and re-stored as float32, NaN fill), one case per chunk along num_cases,
Blosc lz4 clevel 5. "early" = cases through 2019, "recent" = 2020 on (the v3m file split),
so the API keeps its two-store resolve_case() and only the counts change.

Writes straight to GCS (the Mac's data volume has no room for a local copy), in batches of
--batch cases so memory stays bounded. Re-running a (dtype, era) with --resume skips stores
whose case count already matches.

Also writes gs://<bucket>/<prefix>/manifest.json: {product_version, counts{dt_era: n}, files}.

Usage: python3 bin/build_tcradar_v4_zarr.py [--dtype swath|merge|both] [--prefix tc-radar-v4]
                                            [--batch 20] [--limit N] [--resume]
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import xarray as xr

L3 = Path.home() / "Data" / "TDR" / "Level3"
FILES = {"swath": L3 / "tc_radar_v4.0_xy_rel_swath.nc", "merge": L3 / "tc_radar_v4.0_xy_rel_merge.nc"}
BUCKET = "tc-atlas-zarr"
EARLY_LAST_YEAR = 2019


def era_slices(ds: xr.Dataset) -> dict:
    yr = np.array([np.datetime64(int(t), "s").astype("datetime64[Y]").astype(int) + 1970 for t in ds["time"].values])
    n_early = int((yr <= EARLY_LAST_YEAR).sum())
    if not (yr[:n_early] <= EARLY_LAST_YEAR).all() or not (yr[n_early:] > EARLY_LAST_YEAR).all():
        raise RuntimeError("cases are not ordered by year across the 2019/2020 boundary")
    return {"early": slice(0, n_early), "recent": slice(n_early, ds.sizes["num_cases"])}


def as_stored(ds: xr.Dataset, str_widths: dict) -> xr.Dataset:
    """float64/packed -> float32, strings at the whole file's width (zarr fixes it on the first
    batch), chunks one case each; encodings reset."""
    import numcodecs
    comp = numcodecs.Blosc(cname="lz4", clevel=5, shuffle=numcodecs.Blosc.SHUFFLE)
    out = {}
    for name, v in ds.variables.items():
        a = v
        if a.dtype.kind == "f" and a.dtype != np.float32 and "since" not in str(a.attrs.get("units", "")):
            a = a.astype(np.float32)               # epoch-second times stay float64 (float32 steps ~128 s)
        elif a.dtype.kind in "US" and name in str_widths:
            a = a.astype(f"<U{str_widths[name]}")
        a = a.copy(deep=False)
        a.encoding = {}
        attrs = {k: val for k, val in a.attrs.items() if k not in ("scale_factor", "add_offset", "_FillValue", "missing_value")}
        a.attrs = attrs
        enc = {"compressor": comp}
        if a.dtype.kind == "f":
            enc["_FillValue"] = np.float32(np.nan)
        if "num_cases" in a.dims:
            enc["chunks"] = tuple(1 if d == "num_cases" else a.sizes[d] for d in a.dims)
        a.encoding = enc
        out[name] = a
    new = xr.Dataset({k: v for k, v in out.items() if k not in ds.coords}, coords={k: out[k] for k in ds.coords})
    new.attrs = dict(ds.attrs)
    return new


def write_store(src: xr.Dataset, sl: slice, url: str, batch: int, limit: int, log) -> int:
    widths = {k: max(1, int(np.char.str_len(v.values.astype(str)).max())) for k, v in src.variables.items() if v.dtype.kind in "US"}
    import gcsfs
    fs = gcsfs.GCSFileSystem()
    store = gcsfs.GCSMap(root=url, gcs=fs, check=False)
    n = sl.stop - sl.start
    if limit:
        n = min(n, limit)
    t0 = time.time()
    for i0 in range(0, n, batch):
        i1 = min(n, i0 + batch)
        part = as_stored(src.isel(num_cases=slice(sl.start + i0, sl.start + i1)).load(), widths)
        part = part.assign_coords(num_cases=np.arange(i0, i1, dtype=np.float32)) if "num_cases" in part.coords else part
        # one dask chunk per case so to_zarr PUTs the batch's chunks in parallel (serial PUTs at
        # ~200 ms latency ran ~0.15 MB/s)
        part = part.chunk({"num_cases": 1})
        if i0 == 0:
            part.to_zarr(store, mode="w", consolidated=False, compute=True)
        else:
            for v in part.variables.values():
                v.encoding = {}
            part.to_zarr(store, append_dim="num_cases", consolidated=False)
        log(f"  {url}: {i1}/{n} cases, {time.time() - t0:.0f} s")
    import zarr
    zarr.consolidate_metadata(store)
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dtype", default="both", choices=["swath", "merge", "both"])
    ap.add_argument("--prefix", default="tc-radar-v4")
    ap.add_argument("--batch", type=int, default=20)
    ap.add_argument("--limit", type=int, default=0, help="cases per store (test runs)")
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()
    log = lambda m: print(time.strftime("%H:%M:%S"), m, flush=True)  # noqa: E731
    import gcsfs
    fs = gcsfs.GCSFileSystem()
    man_path = f"{BUCKET}/{a.prefix}/manifest.json"
    manifest = json.loads(fs.cat(man_path)) if fs.exists(man_path) else {"counts": {}, "files": {}}
    for dt in (["swath", "merge"] if a.dtype == "both" else [a.dtype]):
        src = xr.open_dataset(FILES[dt], decode_times=False)
        manifest["product_version"] = src.attrs.get("product_version")
        manifest["files"][dt] = FILES[dt].name
        for era, sl in era_slices(src).items():
            url = f"gs://{BUCKET}/{a.prefix}/{dt}_{era}"
            want = (sl.stop - sl.start) if not a.limit else min(a.limit, sl.stop - sl.start)
            if a.resume and fs.exists(f"{url}/.zmetadata"):
                have = xr.open_zarr(gcsfs.GCSMap(root=url, gcs=fs, check=False), consolidated=True).sizes["num_cases"]
                if have == want:
                    log(f"{url}: complete ({have}) -- skipped"); manifest["counts"][f"{dt}_{era}"] = have; continue
            log(f"{dt}/{era}: cases {sl.start}..{sl.stop - 1} -> {url}")
            manifest["counts"][f"{dt}_{era}"] = write_store(src, sl, url, a.batch, a.limit, log)
            fs.pipe(man_path, json.dumps(manifest, indent=1).encode())
        src.close()
    log(f"manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
