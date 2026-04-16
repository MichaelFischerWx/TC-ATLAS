"""
Precompute SHIPS-derived fields (vp, dvmax_12h, dvmax_24h, dtl_min_*) into
tc_radar_metadata{,_merge}.json.

Why: on Cloud Run, `_enrich_metadata_with_ships_extended` runs in background
threads that get CPU-starved when the instance scales to zero, leaving most
cases without the `vp` field. Baking these fields into the JSON at build
time means the metadata cache is fully enriched from the moment startup()
loads the files — no runtime enrichment required.

Vectorized: reads each SHIPS variable once per era (full 2-D array) instead
of per-case slicing. Runtime ~30 seconds end-to-end.

    python precompute_ships_enrichment.py
"""
import json
from pathlib import Path

import numpy as np
import xarray as xr


GCS_PREFIX = "gs://tc-atlas-zarr/tc-radar"
SHIPS_T0_IDX = 8
SHIPS_T12_IDX = 10
SHIPS_T24_IDX = 12

CASE_COUNTS = {
    ("swath", "early"):  710,
    ("swath", "recent"): 800,
    ("merge", "early"):  215,
    ("merge", "recent"): 221,
}

MISSING = 9999


def _read_lag_slice(ds, varname, lag_idx):
    """Return 1-D array of length n_cases with t=lag_idx values, NaN where missing."""
    if varname not in ds:
        return None
    arr = ds[varname].isel(ships_lag_times=lag_idx).values.astype(np.float64)
    arr = np.where((arr == MISSING) | np.isnan(arr), np.nan, arr)
    return arr


def _read_lag_range(ds, varname, lag_start, lag_end):
    """Return 2-D array (n_cases, n_lags) for lag_idx in [start, end]."""
    if varname not in ds:
        return None
    arr = ds[varname].isel(ships_lag_times=slice(lag_start, lag_end + 1)).values.astype(np.float64)
    arr = np.where((arr == MISSING) | np.isnan(arr), np.nan, arr)
    return arr


def _rounded(v, n=1):
    return None if (v is None or np.isnan(v)) else round(float(v), n)


def enrich(cases_by_ci, data_type):
    """Mutate cases_by_ci in place with vp / dvmax / dtl fields."""
    early_count = CASE_COUNTS[(data_type, "early")]
    total_updated = 0

    for era in ("early", "recent"):
        offset = 0 if era == "early" else early_count
        store = f"{GCS_PREFIX}/{data_type}_{era}"
        print(f"  opening {store} ...")
        ds = xr.open_zarr(store, consolidated=True)
        n_cases = ds.sizes.get("num_cases", 0)

        # Vectorized reads: one GCS fetch per variable per era
        vmpi = _read_lag_slice(ds, "mpi_ships", SHIPS_T0_IDX)
        rhlo = _read_lag_slice(ds, "rhlo_ships", SHIPS_T0_IDX)
        shgc = _read_lag_slice(ds, "shgc_ships", SHIPS_T0_IDX)
        vmax_t0 = _read_lag_slice(ds, "vmax_ships", SHIPS_T0_IDX)
        vmax_t12 = _read_lag_slice(ds, "vmax_ships", SHIPS_T12_IDX)
        vmax_t24 = _read_lag_slice(ds, "vmax_ships", SHIPS_T24_IDX)
        dtl_range_12 = _read_lag_range(ds, "dtl_ships", SHIPS_T0_IDX, SHIPS_T12_IDX)
        dtl_range_24 = _read_lag_range(ds, "dtl_ships", SHIPS_T0_IDX, SHIPS_T24_IDX)

        with np.errstate(invalid="ignore", divide="ignore"):
            vp = np.where((vmpi > 0), shgc * (100.0 - rhlo) / vmpi, np.nan)
            dvmax_12 = vmax_t12 - vmax_t0
            dvmax_24 = vmax_t24 - vmax_t0
            dtl_min_12 = np.nanmin(dtl_range_12, axis=1) if dtl_range_12 is not None else None
            dtl_min_24 = np.nanmin(dtl_range_24, axis=1) if dtl_range_24 is not None else None

        updated = 0
        for local_idx in range(n_cases):
            case_index = local_idx + offset
            entry = cases_by_ci.get(case_index)
            if entry is None:
                continue

            if vmpi is not None and not np.isnan(vmpi[local_idx]):
                entry["vmpi"] = _rounded(vmpi[local_idx])
            if rhlo is not None and not np.isnan(rhlo[local_idx]):
                entry["rhlo"] = _rounded(rhlo[local_idx])
            if shgc is not None and not np.isnan(shgc[local_idx]):
                entry["shgc"] = _rounded(shgc[local_idx])
            if not np.isnan(vp[local_idx]):
                entry["vp"] = _rounded(vp[local_idx], 2)
            if not np.isnan(dvmax_12[local_idx]):
                entry["dvmax_12h"] = _rounded(dvmax_12[local_idx])
            if not np.isnan(dvmax_24[local_idx]):
                entry["dvmax_24h"] = _rounded(dvmax_24[local_idx])
            if dtl_min_12 is not None and not np.isnan(dtl_min_12[local_idx]):
                entry["dtl_min_12h"] = _rounded(dtl_min_12[local_idx])
            if dtl_min_24 is not None and not np.isnan(dtl_min_24[local_idx]):
                entry["dtl_min_24h"] = _rounded(dtl_min_24[local_idx])

            updated += 1

        print(f"    {era}: touched {updated} cases (of {n_cases} in Zarr)")
        total_updated += updated

    return total_updated


for data_type, path in (("swath", Path("tc_radar_metadata.json")),
                        ("merge", Path("tc_radar_metadata_merge.json"))):
    print(f"\n=== {data_type} ({path}) ===")
    with open(path) as f:
        data = json.load(f)
    cases = data["cases"]
    cases_by_ci = {c["case_index"]: c for c in cases}
    print(f"  {len(cases)} total cases in JSON")

    enrich(cases_by_ci, data_type)

    n_vp = sum(1 for c in cases if c.get("vp") is not None)
    n_dvmax = sum(1 for c in cases if c.get("dvmax_12h") is not None)
    print(f"  after: {n_vp}/{len(cases)} cases have vp, {n_dvmax} have dvmax_12h")

    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  wrote {path}")

print("\nDone. Commit the updated JSON files and redeploy.")
