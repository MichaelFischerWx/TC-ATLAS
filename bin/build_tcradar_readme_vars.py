#!/usr/bin/env python3
"""Build the variable catalog behind the TC-RADAR README page (tc_radar_readme.html).

Reads the released NetCDF headers (no data) and writes data/tc_radar_v4_variables.json:
one entry per variable name with its group, description, units, packing and, for
each file it appears in (merged / swath), its dimensions.

Usage:
  python3 bin/build_tcradar_readme_vars.py                     # ~/Data/TDR/Level3 v4.0 files
  python3 bin/build_tcradar_readme_vars.py --merge M.nc --swath S.nc --out data/x.json
"""
import argparse
import json
import os
import re

import netCDF4

L3 = os.path.expanduser("~/Data/TDR/Level3")
DEFAULT = {"merge": os.path.join(L3, "tc_radar_v4.0_xy_rel_merge.nc"),
           "swath": os.path.join(L3, "tc_radar_v4.0_xy_rel_swath.nc")}

CASE_INFO = re.compile(r"^(time|mission_ID|storm_name|number_of_swaths|swath_coverage|"
                       r"original_fix_(latitude|longitude)|"
                       r"(merge|swath|beg_swath|end_swath)_(year|month|day|hour|min|minute))$")
MASKS = {"land_mask", "recentered_land_mask", "land_fraction"}


def group_of(name, dims):
    if name in dims:
        return "dims"
    if CASE_INFO.match(name):
        return "case"
    if name in MASKS:
        return "masks"
    if name.startswith("total_recentered_"):
        return "tilt"
    if name.startswith("recentered_"):
        return "recentered"
    if name.startswith(("swath_", "merged_", "original_")):
        return "original"
    if name.startswith(("tc_", "core_")):
        return "vortex"
    if name.endswith("_ships"):
        return "ships"
    if name.startswith("era5_"):
        return "era5"
    return "other"


def _plain(v):
    return v.item() if hasattr(v, "item") else v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--merge", default=DEFAULT["merge"])
    ap.add_argument("--swath", default=DEFAULT["swath"])
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data",
                                                  "tc_radar_v4_variables.json"))
    a = ap.parse_args()

    catalog, order, meta = {}, [], {}
    for kind, path in (("merged", a.merge), ("swath", a.swath)):
        ds = netCDF4.Dataset(path)
        dims = {k: len(v) for k, v in ds.dimensions.items()}
        meta[kind] = {"file": os.path.basename(path), "bytes": os.path.getsize(path),
                      "num_cases": dims["num_cases"], "dims": dims,
                      "product_version": getattr(ds, "product_version", "")}
        for name, v in ds.variables.items():
            attrs = {k: _plain(v.getncattr(k)) for k in v.ncattrs()}
            e = catalog.get(name)
            if e is None:
                e = catalog[name] = {
                    "name": name,
                    "group": group_of(name, dims),
                    "long_name": attrs.get("long_name", ""),
                    "units": attrs.get("units", ""),
                    "dtype": "string" if v.dtype is str else str(v.dtype),
                    "packed": ({"scale_factor": attrs["scale_factor"]}
                               if "scale_factor" in attrs else None),
                    "notes": "; ".join(f"{k}: {attrs[k]}" for k in
                                       ("comment", "source", "regions", "layer")
                                       if k in attrs),
                    "files": {},
                }
                order.append(name)
            e["files"][kind] = list(v.dimensions)
        ds.close()

    out = {"version": meta["merged"]["product_version"], "files": meta,
           "variables": [catalog[n] for n in order]}
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {a.out}: {len(order)} variables, {os.path.getsize(a.out)/1e3:.0f} kB")


if __name__ == "__main__":
    main()
