"""
Precompute relative SST (Vecchi & Soden 2007) per TC-RADAR case and bake it
into tc_radar_metadata{,_merge}.json as the `sst_rel` field.

Definition: sst_rel = (SST at storm location) - (area-weighted tropical mean
SST over 30°S-30°N at the same month). Removes the global warming trend by
construction and isolates "warmer-than-typical" basin signatures — the
key control for the BAMS Section 7 cross-scale composite analysis.

Source: OISST v2 monthly means (NOAA NCEI). Path comes from
build_oisst_history.OISST_MONTHLY_LOCAL_DEFAULT.

Usage:
    python precompute_relative_sst.py
"""
import json
from pathlib import Path

import numpy as np
import xarray as xr

from build_oisst_history import (
    OISST_MONTHLY_LOCAL_DEFAULT,
    TROPICAL_MEAN_LAT_MIN,
    TROPICAL_MEAN_LAT_MAX,
)


def _tropical_mean_per_month(sst_da: xr.DataArray) -> dict[tuple[int, int], float]:
    """Area-weighted (cos lat) mean SST over the tropical band per (year, month)."""
    sub = sst_da.sel(lat=slice(TROPICAL_MEAN_LAT_MIN, TROPICAL_MEAN_LAT_MAX))
    weights = np.cos(np.deg2rad(sub.lat))
    weights.name = "weights"
    trop = sub.weighted(weights).mean(("lat", "lon")).compute()
    out: dict[tuple[int, int], float] = {}
    for i, t in enumerate(trop.time.values):
        ts = np.datetime64(t, "M").astype(object)
        out[(ts.year, ts.month)] = float(trop.values[i])
    return out


def _build_month_index(sst_da: xr.DataArray) -> dict[tuple[int, int], int]:
    """Map (year, month) → index along OISST time axis."""
    idx: dict[tuple[int, int], int] = {}
    for i, t in enumerate(sst_da.time.values):
        ts = np.datetime64(t, "M").astype(object)
        idx[(ts.year, ts.month)] = i
    return idx


def enrich(cases: list[dict], sst_da: xr.DataArray,
           month_idx: dict[tuple[int, int], int],
           trop_means: dict[tuple[int, int], float]) -> int:
    """Mutate cases in place with `sst_rel`. Returns count updated."""
    lat_grid = sst_da.lat.values  # ascending
    lon_grid = sst_da.lon.values  # 0..360

    updated = 0
    skipped_no_time = 0
    skipped_no_sst = 0
    for c in cases:
        yr = c.get("year")
        mo = c.get("month")
        lat = c.get("latitude")
        lon = c.get("longitude")
        if yr is None or mo is None or lat is None or lon is None:
            skipped_no_time += 1
            continue
        key = (int(yr), int(mo))
        ti = month_idx.get(key)
        tmean = trop_means.get(key)
        if ti is None or tmean is None or np.isnan(tmean):
            skipped_no_time += 1
            continue
        # Convert IBTrACS lon (-180..180) to OISST grid (0..360)
        lon360 = float(lon) % 360.0
        # Nearest-neighbor lookup (OISST is 0.25° — no need for bilinear)
        i_lat = int(np.argmin(np.abs(lat_grid - float(lat))))
        i_lon = int(np.argmin(np.abs(lon_grid - lon360)))
        storm_sst = float(sst_da.values[ti, i_lat, i_lon])
        if np.isnan(storm_sst):
            skipped_no_sst += 1
            continue
        c["sst_rel"] = round(storm_sst - tmean, 2)
        updated += 1
    if skipped_no_time:
        print(f"    skipped {skipped_no_time} cases: missing year/month/lat/lon or OISST date out of range")
    if skipped_no_sst:
        print(f"    skipped {skipped_no_sst} cases: OISST land/missing at storm location")
    return updated


def main():
    print(f"Opening OISST monthly file: {OISST_MONTHLY_LOCAL_DEFAULT}")
    ds = xr.open_dataset(OISST_MONTHLY_LOCAL_DEFAULT)
    sst_da = ds["sst"]
    if sst_da.dims != ("time", "lat", "lon"):
        # Some OISST variants have ('time', 'level', 'lat', 'lon') — squeeze
        sst_da = sst_da.squeeze()
        if sst_da.dims != ("time", "lat", "lon"):
            raise RuntimeError(f"Unexpected SST dims: {sst_da.dims}")
    # Make sure lat is ascending (some OISST variants are descending)
    if sst_da.lat.values[0] > sst_da.lat.values[-1]:
        sst_da = sst_da.sortby("lat")

    print(f"  range: {sst_da.time.values[0]} → {sst_da.time.values[-1]}")
    print("  computing area-weighted tropical mean per month…")
    trop_means = _tropical_mean_per_month(sst_da)
    month_idx = _build_month_index(sst_da)
    print(f"  tropical-mean SST: {min(trop_means.values()):.2f} → {max(trop_means.values()):.2f} °C")

    for path in (Path("tc_radar_metadata.json"), Path("tc_radar_metadata_merge.json")):
        print(f"\n=== {path} ===")
        with open(path) as f:
            data = json.load(f)
        cases = data["cases"]
        n = enrich(cases, sst_da, month_idx, trop_means)
        n_total = len(cases)
        n_with = sum(1 for c in cases if c.get("sst_rel") is not None)
        print(f"  {n}/{n_total} cases enriched ({n_with} now have sst_rel)")
        # Quick distribution summary
        vals = [c["sst_rel"] for c in cases if c.get("sst_rel") is not None]
        if vals:
            vs = sorted(vals)
            q25 = vs[len(vs) // 4]; q50 = vs[len(vs) // 2]; q75 = vs[3 * len(vs) // 4]
            print(f"  sst_rel distribution: min={min(vals):.2f}  Q25={q25:.2f}  median={q50:.2f}  Q75={q75:.2f}  max={max(vals):.2f} °C")
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        print(f"  wrote {path}")

    print("\nDone. Commit the updated JSON files, then add min_sst_rel/max_sst_rel filter params + UI row.")


if __name__ == "__main__":
    main()
