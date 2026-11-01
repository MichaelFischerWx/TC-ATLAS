#!/usr/bin/env python3
"""Build the TC-RADAR explorer metadata JSONs (swath + merge) from the Zarr stores the API serves.

One script for every field the explorer and API read, vectorized (one read per variable per store):
  base     latitude/longitude (original fix), datetime (swath_* / merge_*), vmax_kt, 24-h_vmax_change_kt,
           min_pressure_hpa (t=0 / +24 h of the *_ships lag axis), rmw_km (2 km), tilt_magnitude_km (swath 6 km, merge 8 km),
           coverage (swath: swath_coverage at 2 km; merge: core_mean_quadrant_coverage at 70 km / 2 km when the
           store has it -- v4.0 -- which matches the old merge value with bias 0.000, r 0.973), number_of_swaths
           and shear_magnitude_kt (= shdc; the "kt" in the name is historical, values are m/s) for merges
  env      vmpi rhlo rhmd rhhi sst shgc sddc shdc vp dvmax_12h dvmax_24h dtl_min_12h dtl_min_24h (t=0 lag;
           same formulas as scripts/build_tc_radar_enrichment_sidecar.py / precompute_ships_enrichment.py)
  wind     max_er_wspd_05km / _20km (max earth-relative wind speed at 0.5 / 2 km)
  sst_rel  OISST monthly SST at the case minus the 30S-30N mean (precompute_relative_sst.enrich)

The early/recent split and case counts come from the stores themselves (gs://tc-atlas-zarr/<prefix>/
{swath,merge}_{early,recent}); global case_index = early offset + local index, as tc_radar_api.resolve_case.

Validation: --prefix tc-radar (v3m) reproduces the committed tc_radar_metadata*.json (--check).

Usage:
  python3 bin/build_tc_radar_metadata.py --prefix tc-radar-v4 --suffix _v4      # writes tc_radar_metadata_v4.json ...
  python3 bin/build_tc_radar_metadata.py --prefix tc-radar --check               # compare with the v3m JSONs
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
BUCKET = "tc-atlas-zarr"
T0, T12, T24 = 8, 10, 12
MISSING = 9999
MERGE_COV_RADIUS_KM = 70.0


LOCAL = {"swath": Path.home() / "Data/TDR/Level3/tc_radar_v4.0_xy_rel_swath.nc",
         "merge": Path.home() / "Data/TDR/Level3/tc_radar_v4.0_xy_rel_merge.nc"}
_LOCAL_SPLIT = {}


def _open(prefix: str, dt: str, era: str) -> xr.Dataset:
    if _LOCAL_SPLIT.get("on"):
        # the v4.0 NetCDF the stores were converted from (verified identical): same early/recent split, read locally
        ds = xr.open_dataset(LOCAL[dt], decode_times=False)
        if "manifest" not in _LOCAL_SPLIT:
            import gcsfs
            _LOCAL_SPLIT["manifest"] = json.loads(gcsfs.GCSFileSystem().cat(f"{BUCKET}/{prefix}/manifest.json"))
        ne = _LOCAL_SPLIT["manifest"]["counts"][f"{dt}_early"]
        return ds.isel(num_cases=slice(0, ne) if era == "early" else slice(ne, None))
    import gcsfs
    fs = gcsfs.GCSFileSystem()
    return xr.open_zarr(gcsfs.GCSMap(root=f"gs://{BUCKET}/{prefix}/{dt}_{era}", gcs=fs, check=False),
                        consolidated=True, decode_times=False)


def _clean(a):
    a = np.asarray(a, dtype=np.float64)
    return np.where((a == MISSING) | ~np.isfinite(a), np.nan, a)


def _lag(ds, v, i):
    return _clean(ds[v].isel(ships_lag_times=i).values) if v in ds else None


def _lag_range(ds, v, i0, i1):
    return _clean(ds[v].isel(ships_lag_times=slice(i0, i1 + 1)).values) if v in ds else None


def _r(v, n=1):
    return None if v is None or not np.isfinite(v) else round(float(v), n)


def _max_wind(ds, z):
    for u, v in (("recentered_earth_relative_eastward_wind", "recentered_earth_relative_northward_wind"),
                 ("recentered_eastward_wind", "recentered_northward_wind")):
        if u in ds and v in ds:
            U = ds[u].isel(height=z).values.astype(np.float64); V = ds[v].isel(height=z).values.astype(np.float64)
            w = np.sqrt(U ** 2 + V ** 2)
            with np.errstate(invalid="ignore"), __import__("warnings").catch_warnings():
                __import__("warnings").simplefilter("ignore", RuntimeWarning)
                return np.nanmax(w.reshape(w.shape[0], -1), axis=1)
    return None


def build(prefix: str, dt: str) -> list[dict]:
    cases, offset = [], 0
    for era in ("early", "recent"):
        ds = _open(prefix, dt, era); n = ds.sizes["num_cases"]
        h = ds["height"].values; z05, z2 = (int(np.argmin(np.abs(h - v))) for v in (0.5, 2.0))
        z6 = int(np.argmin(np.abs(h - (8.0 if dt == "merge" else 6.0))))   # the committed v3m JSONs: swath tilt at 6 km, merge at 8 km
        tp = "merge_" if dt == "merge" else "swath_"
        T = {k: ds[f"{tp}{k}"].values.astype(int) for k in ("year", "month", "day", "hour")}
        T["minute"] = ds[f"{tp}minute" if f"{tp}minute" in ds else f"{tp}min"].values.astype(int)
        lat = ds["original_fix_latitude"].values; lon = ds["original_fix_longitude"].values
        names = np.char.strip(ds["storm_name"].values.astype(str)); mis = np.char.strip(ds["mission_ID"].values.astype(str))
        vmax0, vmax12, vmax24 = _lag(ds, "vmax_ships", T0), _lag(ds, "vmax_ships", T12), _lag(ds, "vmax_ships", T24)
        pres = _lag(ds, "pres_ships", T0)
        rmw = _clean(ds["tc_rmw"].isel(height=z2).values)
        tilt = _clean(ds["tc_tilt_magnitude"].isel(height=z6).values)
        if dt == "swath":
            cov, cov_nd = _clean(ds["swath_coverage"].isel(height=z2).values), 3
        elif "core_mean_quadrant_coverage" in ds:
            ir = int(np.argmin(np.abs(ds["core_radii"].values - MERGE_COV_RADIUS_KM)))
            cov, cov_nd = _clean(ds["core_mean_quadrant_coverage"].isel(core_radii=ir, height=z2).values), 2
        else:
            cov, cov_nd = None, 2
        env = {k: _lag(ds, f"{v}_ships", T0) for k, v in (("vmpi", "mpi"), ("rhlo", "rhlo"), ("rhmd", "rhmd"), ("rhhi", "rhhi"),
                                                           ("sst", "sst"), ("shgc", "shgc"), ("sddc", "sddc"), ("shdc", "shdc"))}
        dtl12, dtl24 = _lag_range(ds, "dtl_ships", T0, T12), _lag_range(ds, "dtl_ships", T0, T24)
        with np.errstate(invalid="ignore", divide="ignore"), __import__("warnings").catch_warnings():
            __import__("warnings").simplefilter("ignore", RuntimeWarning)
            vp = np.where(env["vmpi"] > 0, env["shgc"] * (100.0 - env["rhlo"]) / env["vmpi"], np.nan)
            dtlmin12 = np.nanmin(dtl12, axis=1) if dtl12 is not None else None
            dtlmin24 = np.nanmin(dtl24, axis=1) if dtl24 is not None else None
        w05, w20 = _max_wind(ds, z05), _max_wind(ds, z2)
        nsw = ds["number_of_swaths"].values if "number_of_swaths" in ds else None
        for i in range(n):
            c = {"case_index": offset + i,
                 "latitude": float(lat[i]) if dt == "swath" else round(float(lat[i]), 2),
                 "longitude": float(lon[i]) if dt == "swath" else round(float(lon[i]), 2),
                 "storm_name": str(names[i]), "mission_id": str(mis[i]),
                 "datetime": f"{T['year'][i]:04d}-{T['month'][i]:02d}-{T['day'][i]:02d} {T['hour'][i]:02d}:{T['minute'][i]:02d} UTC",
                 "year": int(T["year"][i]), "month": int(T["month"][i]), "day": int(T["day"][i]),
                 "hour": int(T["hour"][i]), "minute": int(T["minute"][i]),
                 "vmax_kt": _r(vmax0[i]), "24-h_vmax_change_kt": _r(vmax24[i] - vmax0[i]), "min_pressure_hpa": _r(pres[i]),
                 "rmw_km": _r(rmw[i]), "tilt_magnitude_km": _r(tilt[i]),
                 "coverage": _r(cov[i], cov_nd) if cov is not None else None}
            if dt == "merge":
                c["number_of_swaths"] = int(nsw[i]) if nsw is not None and np.isfinite(nsw[i]) else None
                c["shear_magnitude_kt"] = _r(env["shdc"][i])
            for k in ("vmpi", "rhlo", "shgc"):
                c[k] = _r(env[k][i])
            c["vp"] = _r(vp[i], 2)
            c["dvmax_12h"] = _r(vmax12[i] - vmax0[i]); c["dvmax_24h"] = _r(vmax24[i] - vmax0[i])
            c["dtl_min_12h"] = _r(dtlmin12[i]) if dtlmin12 is not None else None
            c["dtl_min_24h"] = _r(dtlmin24[i]) if dtlmin24 is not None else None
            for k in ("rhmd", "rhhi", "sst"):
                c[k] = _r(env[k][i])
            c["max_er_wspd_05km"] = _r(w05[i]) if w05 is not None else None
            c["max_er_wspd_20km"] = _r(w20[i]) if w20 is not None else None
            c["sddc"] = _r(env["sddc"][i]); c["shdc"] = _r(env["shdc"][i])
            cases.append({k: v for k, v in c.items() if v is not None or k in ("vmax_kt", "rmw_km", "coverage", "tilt_magnitude_km")})
        print(f"  {prefix}/{dt}_{era}: {n} cases (case_index {offset}..{offset + n - 1})", flush=True)
        offset += n
    return cases


def add_sst_rel(cases: list[dict]) -> None:
    import precompute_relative_sst as P
    from build_oisst_history import OISST_MONTHLY_LOCAL_DEFAULT
    da = xr.open_dataset(OISST_MONTHLY_LOCAL_DEFAULT)["sst"].squeeze()
    if da.lat.values[0] > da.lat.values[-1]:
        da = da.sortby("lat")
    P.enrich(cases, da, P._build_month_index(da), P._tropical_mean_per_month(da))


def check(new: list[dict], path: Path) -> None:
    old = {c["case_index"]: c for c in json.loads(path.read_text())["cases"]}
    keys = sorted({k for c in old.values() for k in c} - {"case_index"})
    print(f"  check vs {path.name}: {len(new)} built / {len(old)} committed")
    for k in keys:
        n = same = 0; ex = None
        for c in new:
            o = old.get(c["case_index"])
            if o is None or k not in o:
                continue
            n += 1; a, b = c.get(k), o.get(k)
            ok = (a == b) or (isinstance(a, float) and isinstance(b, (int, float)) and abs(a - b) <= 0.051) or (a is None and b is None)
            same += ok
            if not ok and ex is None:
                ex = (c["case_index"], a, b)
        print(f"    {k:22s} {same}/{n} match" + (f"   e.g. case {ex[0]}: built {ex[1]!r} vs {ex[2]!r}" if ex else ""))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prefix", default="tc-radar-v4")
    ap.add_argument("--suffix", default="_v4", help="output file suffix: tc_radar_metadata<suffix>.json, ..._merge<suffix>.json")
    ap.add_argument("--check", action="store_true", help="compare with the committed (v3m) JSONs instead of writing")
    ap.add_argument("--local", action="store_true", help="read the local v4.0 NetCDF (split by the prefix's manifest)")
    a = ap.parse_args()
    _LOCAL_SPLIT["on"] = a.local
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for dt, base in (("swath", "tc_radar_metadata"), ("merge", "tc_radar_metadata_merge")):
        cases = build(a.prefix, dt); add_sst_rel(cases)
        if a.check:
            check(cases, ROOT / f"{base}.json"); continue
        out = {"total_cases": len(cases), "generated_at": now, "source": f"gs://{BUCKET}/{a.prefix}", "cases": cases,
               "enrichment_baked": True}
        if dt == "merge":
            out["data_type"] = "merge"
        p = ROOT / f"{base}{a.suffix}.json"
        p.write_text(json.dumps(out, indent=2)); print(f"  wrote {p.name}: {len(cases)} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
