"""Diagnostic: how many cases actually have valid mpi/rhlo/shgc at t=0?"""
import xarray as xr
import numpy as np

SHIPS_T0_IDX = 8  # lag-hour axis: -48..0..+48 in 6-h steps, t=0 is idx 8


def _valid(val):
    if val is None:
        return False
    if val == 9999:
        return False
    try:
        return not np.isnan(val)
    except TypeError:
        return False


for store in ["swath_recent", "swath_early", "merge_recent", "merge_early"]:
    try:
        ds = xr.open_zarr(f"gs://tc-atlas-zarr/tc-radar/{store}", consolidated=True)
        n = ds.sizes.get("num_cases", 0)

        # Extract t=0 values for the three key variables
        vmpi = ds["mpi_ships"].isel(lag_time=SHIPS_T0_IDX).values if "lag_time" in ds["mpi_ships"].dims else ds["mpi_ships"].values[:, SHIPS_T0_IDX]
        rhlo = ds["rhlo_ships"].isel(lag_time=SHIPS_T0_IDX).values if "lag_time" in ds["rhlo_ships"].dims else ds["rhlo_ships"].values[:, SHIPS_T0_IDX]
        shgc = ds["shgc_ships"].isel(lag_time=SHIPS_T0_IDX).values if "lag_time" in ds["shgc_ships"].dims else ds["shgc_ships"].values[:, SHIPS_T0_IDX]

        # Count valid
        v_vmpi = sum(1 for v in vmpi if _valid(float(v)))
        v_rhlo = sum(1 for v in rhlo if _valid(float(v)))
        v_shgc = sum(1 for v in shgc if _valid(float(v)))
        all_three = sum(
            1 for i in range(n)
            if _valid(float(vmpi[i])) and _valid(float(rhlo[i])) and _valid(float(shgc[i])) and float(vmpi[i]) > 0
        )
        print(f"{store} (n={n}):")
        print(f"  valid mpi: {v_vmpi}, rhlo: {v_rhlo}, shgc: {v_shgc}")
        print(f"  cases with ALL three valid + mpi>0 (eligible for vp): {all_three}")

        # Show dims + dtype + sample values
        print(f"  mpi_ships dims: {ds['mpi_ships'].dims}, shape: {ds['mpi_ships'].shape}")
        print(f"  first 3 mpi t=0: {[float(v) for v in vmpi[:3]]}")
    except Exception as e:
        print(f"{store}: ERROR {type(e).__name__}: {e}")
    print()
