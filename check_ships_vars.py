"""Quick diagnostic: which SHIPS variables are in the TC-RADAR Zarr stores?"""
import xarray as xr

for store in ["swath_recent", "swath_early", "merge_recent", "merge_early"]:
    try:
        ds = xr.open_zarr(f"gs://tc-atlas-zarr/tc-radar/{store}", consolidated=True)
        ships_vars = sorted(v for v in ds.data_vars if "ships" in v.lower())
        need = ["mpi_ships", "rhlo_ships", "shgc_ships", "vmax_ships", "dtl_ships"]
        missing = [v for v in need if v not in ds]
        print(f"{store}:")
        print(f"  all ships vars: {ships_vars}")
        print(f"  required missing: {missing}")
    except Exception as e:
        print(f"{store}: ERROR {e}")
