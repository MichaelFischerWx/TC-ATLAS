#!/usr/bin/env python3
"""Build an intensity-conditioned TC structure climatology from IBTrACS.

For every 5-kt Vmax bin (per basin + a global fallback) we summarize the
observed distribution of the storm-structure parameters that the DeepMind
FNV3 LARGE_ENSEMBLE forecast carries:

    rmw_km        radius of maximum winds
    r34_mean_km   gale-force (34 kt) wind radius, averaged over 4 quadrants
    r50_mean_km   damaging-wind (50 kt) radius, quadrant mean
    r64_mean_km   hurricane-force (64 kt) radius, quadrant mean

Source: IBTrACS USA agency columns (NHC for NA/EP, JTWC elsewhere) — usa_wind
(kt), usa_rmw (nm), usa_r34/r50/r64 (nm, by quadrant). Radii are converted
nm -> km so the climatology is directly comparable to the DeepMind CSV (km/kt).

Output `structure_climo.json` is a compact lookup the RT-monitor frontend
fetches to express each ensemble member's structure as an anomaly relative to
storms of the same forecast intensity (conditional-climatology framing).

Run once (and occasionally to refresh):  python3 build_structure_climo.py
"""
import json
import os

import numpy as np
import xarray as xr

NC_PATH = "data/_ibtracs_cache/IBTrACS.ALL.v04r01.nc"
OUT_PATH = "structure_climo.json"
NM_TO_KM = 1.852
# Floor the climatology at 1990 — earlier best-track wind-radii/RMW estimates
# are sparse and less reliable (the operational radii era ramps up post-1988).
MIN_SEASON = 1990

# 5-kt Vmax bins. Each value in BIN_EDGES is a bin's LOWER edge; the final
# edge (155) opens an unbounded top bin [155, inf) so the rare Cat-5 fixes
# (>~155 kt, where per-basin samples get thin) pool into one robust bin.
BIN_EDGES = list(range(20, 160, 5))          # 20,25,...,155 (155 = open top bin)
MIN_COUNT = 30                               # below this, a per-basin bin is dropped
PCTS = [10, 25, 50, 75, 90]


def _quad_mean(arr):
    """Mean over the 4 quadrants, ignoring NaN. Returns NaN if all-NaN.
    A legitimate reported 0 (no winds of that strength in a quadrant) counts."""
    with np.errstate(invalid="ignore"):
        return np.nanmean(arr, axis=-1)


def _summarize(vals):
    """vals: 1-D array of a structure metric (km) for one Vmax bin. Drops NaN."""
    v = vals[np.isfinite(vals)]
    if v.size == 0:
        return None
    rec = {
        "n": int(v.size),
        "mean": round(float(np.mean(v)), 1),
        "std": round(float(np.std(v, ddof=1)) if v.size > 1 else 0.0, 1),
    }
    for p in PCTS:
        rec["p%d" % p] = round(float(np.percentile(v, p)), 1)
    return rec


def main():
    if not os.path.exists(NC_PATH):
        raise SystemExit("IBTrACS file not found: %s" % NC_PATH)
    ds = xr.open_dataset(NC_PATH)

    wind = ds["usa_wind"].values.astype("float64")             # (storm, dt) kt
    rmw = ds["usa_rmw"].values.astype("float64") * NM_TO_KM    # -> km
    r34 = _quad_mean(ds["usa_r34"].values.astype("float64")) * NM_TO_KM
    r50 = _quad_mean(ds["usa_r50"].values.astype("float64")) * NM_TO_KM
    r64 = _quad_mean(ds["usa_r64"].values.astype("float64")) * NM_TO_KM

    # Basin per fix (2-char byte strings).
    basin = ds["basin"].values  # (storm, dt) |S2
    basin = np.char.strip(basin.astype(str))

    # Season is per-storm; broadcast to per-fix so we can floor at MIN_SEASON.
    season = ds["season"].values.astype("float64")          # (storm,)
    season2d = np.broadcast_to(season[:, None], wind.shape)  # (storm, dt)

    metrics = {"rmw_km": rmw, "r34_mean_km": r34,
               "r50_mean_km": r50, "r64_mean_km": r64}

    # Flatten everything to 1-D over valid (finite wind, season >= MIN_SEASON) fixes.
    wflat = wind.reshape(-1)
    bflat = basin.reshape(-1)
    sflat = season2d.reshape(-1)
    mflat = {k: v.reshape(-1) for k, v in metrics.items()}
    keep = np.isfinite(wflat) & (wflat > 0) & (sflat >= MIN_SEASON)
    wflat = wflat[keep]
    bflat = bflat[keep]
    mflat = {k: v[keep] for k, v in mflat.items()}

    # Each edge starts a bin; the last edge (155) is the open top bin [155, inf).
    # digitize-1 maps w>=155 (incl. >170) to the final index, pooling them.
    bin_idx = np.digitize(wflat, BIN_EDGES) - 1
    n_bins = len(BIN_EDGES)
    centers = [BIN_EDGES[i] + 2.5 for i in range(n_bins - 1)] + [BIN_EDGES[-1] + 2.5]

    basins = ["NA", "EP", "WP", "NI", "SI", "SP", "SA"]

    def build_for(mask):
        """Return per-metric list of bin summaries for fixes selected by mask."""
        out = {}
        for k, arr in mflat.items():
            rows = []
            for bi in range(n_bins):
                sel = mask & (bin_idx == bi)
                rec = _summarize(arr[sel]) if sel.any() else None
                rows.append(rec)
            out[k] = rows
        return out

    result = {
        "_about": "IBTrACS USA-agency intensity-conditioned structure climatology. "
                  "Radii in km, Vmax bins in kt. mean R34/R50/R64 averaged over quadrants.",
        "source": "IBTrACS.ALL.v04r01",
        "min_season": MIN_SEASON,
        "nm_to_km": NM_TO_KM,
        "bin_centers_kt": centers,
        "bin_edges_kt": BIN_EDGES,
        "top_bin_open": True,   # last bin is [bin_edges[-1], inf); clamp Vmax lookups to it
        "min_count": MIN_COUNT,
        "metrics": list(metrics.keys()),
        "global": build_for(np.ones_like(wflat, dtype=bool)),
        "by_basin": {},
    }

    # Per-basin: drop bins thinner than MIN_COUNT (frontend falls back to global).
    for b in basins:
        bm = (bflat == b)
        if not bm.any():
            continue
        per = build_for(bm)
        for k in per:
            per[k] = [r if (r and r["n"] >= MIN_COUNT) else None for r in per[k]]
        # Skip a basin entirely if it has essentially no radius data.
        if all(all(r is None for r in per[k]) for k in per):
            continue
        result["by_basin"][b] = per

    with open(OUT_PATH, "w") as f:
        json.dump(result, f, separators=(",", ":"))
    sz = os.path.getsize(OUT_PATH) / 1024.0

    # Console sanity summary.
    print("Wrote %s (%.1f KB)" % (OUT_PATH, sz))
    print("Basins with data:", list(result["by_basin"].keys()))
    print("\nGlobal RMW / mean-R34 by Vmax bin (km):")
    print("  %5s %8s %8s   %8s %8s" % ("Vmax", "RMW_n", "RMW_mean", "R34_n", "R34_mean"))
    for i, c in enumerate(centers):
        rr = result["global"]["rmw_km"][i]
        r3 = result["global"]["r34_mean_km"][i]
        if not rr and not r3:
            continue
        print("  %5.0f %8s %8s   %8s %8s" % (
            c,
            rr["n"] if rr else "-", ("%.1f" % rr["mean"]) if rr else "-",
            r3["n"] if r3 else "-", ("%.1f" % r3["mean"]) if r3 else "-",
        ))


if __name__ == "__main__":
    main()
