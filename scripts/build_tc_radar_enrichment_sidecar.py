#!/usr/bin/env python3
"""
Build the TC-RADAR per-case enrichment sidecar ONCE (vectorized bulk reads).

WHY
---
tc_radar_api.py used to enrich the metadata caches at startup by looping over
every case with `.isel(num_cases=idx)` — _enrich_metadata_with_ships,
_enrich_metadata_with_max_wind, _enrich_metadata_with_ships_extended, plus vortex
metrics. On Cloud Run that meant millions of tiny GCS GETs re-issued on every
COLD instance. This script computes the same per-case fields a single time using
vectorized full-array reads (one GET per variable per era, not one per case) and
writes a small JSON sidecar. The API then loads the sidecar at startup
(`_apply_enrichment_sidecar`) and SKIPS the live loops entirely.

SCHEMA (consumed by tc_radar_api._apply_enrichment_sidecar)
-----------------------------------------------------------
    {"schema": 1,
     "built_utc": "...",
     "swath": {"<case_index>": {"sddc":..., "shdc":..., "max_er_wspd_05km":...,
                                "max_er_wspd_20km":..., "vmpi":..., "rhlo":...,
                                "shgc":..., "vp":..., "dvmax_12h":...,
                                "dvmax_24h":..., "dtl_min_12h":..., "dtl_min_24h":...}},
     "merge": {"<case_index>": { ...same... }}}

Keys/units match tc_radar_metadata.json conventions exactly so the loader can
merge field-by-field. Vortex metrics (merge-only, two-pass DB-mean centring) are
intentionally LEFT to the live path for now — they need the climatology and a
cross-era finalize; this sidecar covers the SHIPS + max-wind fields that dominate
the per-case GET volume.

USAGE
-----
    # Build to a local file (safe; writes only the small JSON):
    python3 scripts/build_tc_radar_enrichment_sidecar.py \
        --out enrichment_sidecar.json

    # Build and upload to GCS (the path the API reads by default):
    python3 scripts/build_tc_radar_enrichment_sidecar.py \
        --out gs://tc-atlas-zarr/tc-radar/enrichment_sidecar.json

NOTE: writing the sidecar object to gs:// adds ONE small object; it does not
touch the Zarr stores. Still, per project policy a human runs the GCS write.
"""
import argparse
import json
import sys
from datetime import datetime, timezone

import numpy as np
import xarray as xr


GCS_PREFIX = "gs://tc-atlas-zarr/tc-radar"

CASE_COUNTS = {
    ("swath", "early"):  710,
    ("swath", "recent"): 800,
    ("merge", "early"):  215,
    ("merge", "recent"): 221,
}

SHIPS_T0_IDX = 8
SHIPS_T12_IDX = 10
SHIPS_T24_IDX = 12
MISSING = 9999

# Earth-relative wind component candidates (first available pair wins),
# matching _enrich_metadata_with_max_wind in tc_radar_api.py.
UV_CANDIDATES = [
    ("recentered_earth_relative_eastward_wind", "recentered_earth_relative_northward_wind"),
    ("recentered_eastward_wind", "recentered_northward_wind"),
]


def _clean(arr):
    arr = arr.astype(np.float64)
    return np.where((arr == MISSING) | np.isnan(arr), np.nan, arr)


def _read_lag_slice(ds, varname, lag_idx):
    if varname not in ds:
        return None
    return _clean(ds[varname].isel(ships_lag_times=lag_idx).values)


def _read_lag_range(ds, varname, lag_start, lag_end):
    if varname not in ds:
        return None
    return _clean(ds[varname].isel(ships_lag_times=slice(lag_start, lag_end + 1)).values)


def _rounded(v, n=1):
    return None if (v is None or np.isnan(v)) else round(float(v), n)


def _max_wind_per_case(ds, n_cases):
    """Vectorized max earth-relative wind speed at 0.5 km and 2.0 km per case.

    Returns (arr05, arr20) length-n_cases float arrays (NaN where unavailable).
    Reads the two height slices for the full case axis at once instead of
    per-case .isel — the whole point of the sidecar.
    """
    if "height" not in ds:
        return None, None
    hv = ds["height"].values
    z05 = int(np.argmin(np.abs(hv - 0.5)))
    z20 = int(np.argmin(np.abs(hv - 2.0)))

    u_name = v_name = None
    for u_cand, v_cand in UV_CANDIDATES:
        if u_cand in ds and v_cand in ds:
            u_name, v_name = u_cand, v_cand
            break
    fallback = "recentered_wind_speed" if "recentered_wind_speed" in ds else None

    out = {}
    for tag, z in (("05", z05), ("20", z20)):
        if u_name is not None:
            u = ds[u_name].isel(height=z).values  # (n_cases, ny, nx)
            v = ds[v_name].isel(height=z).values
            wspd = np.sqrt(u.astype(np.float64) ** 2 + v.astype(np.float64) ** 2)
        elif fallback is not None:
            wspd = ds[fallback].isel(height=z).values.astype(np.float64)
        else:
            out[tag] = np.full(n_cases, np.nan)
            continue
        # max over the spatial dims, ignoring NaN
        flat = wspd.reshape(wspd.shape[0], -1)
        with np.errstate(invalid="ignore"):
            out[tag] = np.nanmax(flat, axis=1)
    return out.get("05"), out.get("20")


def build_for_type(data_type: str) -> dict:
    """Return {case_index(str): {fields}} for all eras of one data_type."""
    early_count = CASE_COUNTS[(data_type, "early")]
    result: dict[str, dict] = {}

    for era in ("early", "recent"):
        offset = 0 if era == "early" else early_count
        store = f"{GCS_PREFIX}/{data_type}_{era}"
        print(f"  opening {store} ...")
        try:
            ds = xr.open_zarr(store, consolidated=True)
        except Exception:
            ds = xr.open_zarr(store, consolidated=False)
        n_cases = ds.sizes.get("num_cases", 0)

        # ── SHIPS scalars (one GET per variable) ───────────────────
        sddc = _read_lag_slice(ds, "sddc_ships", SHIPS_T0_IDX)
        shdc = _read_lag_slice(ds, "shdc_ships", SHIPS_T0_IDX)
        vmpi = _read_lag_slice(ds, "mpi_ships", SHIPS_T0_IDX)
        rhlo = _read_lag_slice(ds, "rhlo_ships", SHIPS_T0_IDX)
        shgc = _read_lag_slice(ds, "shgc_ships", SHIPS_T0_IDX)
        vmax_t0 = _read_lag_slice(ds, "vmax_ships", SHIPS_T0_IDX)
        vmax_t12 = _read_lag_slice(ds, "vmax_ships", SHIPS_T12_IDX)
        vmax_t24 = _read_lag_slice(ds, "vmax_ships", SHIPS_T24_IDX)
        dtl_12 = _read_lag_range(ds, "dtl_ships", SHIPS_T0_IDX, SHIPS_T12_IDX)
        dtl_24 = _read_lag_range(ds, "dtl_ships", SHIPS_T0_IDX, SHIPS_T24_IDX)

        with np.errstate(invalid="ignore", divide="ignore"):
            vp = np.where(vmpi > 0, shgc * (100.0 - rhlo) / vmpi, np.nan) \
                if (vmpi is not None and rhlo is not None and shgc is not None) else None
            dvmax_12 = (vmax_t12 - vmax_t0) if (vmax_t0 is not None and vmax_t12 is not None) else None
            dvmax_24 = (vmax_t24 - vmax_t0) if (vmax_t0 is not None and vmax_t24 is not None) else None
            dtl_min_12 = np.nanmin(dtl_12, axis=1) if dtl_12 is not None else None
            dtl_min_24 = np.nanmin(dtl_24, axis=1) if dtl_24 is not None else None

        # ── Max earth-relative wind (vectorized height slices) ─────
        max05, max20 = _max_wind_per_case(ds, n_cases)

        def g(a, i):
            return None if a is None else a[i]

        for local_idx in range(n_cases):
            ci = local_idx + offset
            fields: dict = {}
            for key, arr in (
                ("sddc", sddc), ("shdc", shdc), ("vmpi", vmpi),
                ("rhlo", rhlo), ("shgc", shgc),
            ):
                r = _rounded(g(arr, local_idx))
                if r is not None:
                    fields[key] = r
            if vp is not None:
                r = _rounded(g(vp, local_idx), 2)
                if r is not None:
                    fields["vp"] = r
            for key, arr in (("dvmax_12h", dvmax_12), ("dvmax_24h", dvmax_24),
                             ("dtl_min_12h", dtl_min_12), ("dtl_min_24h", dtl_min_24)):
                r = _rounded(g(arr, local_idx))
                if r is not None:
                    fields[key] = r
            for key, arr in (("max_er_wspd_05km", max05), ("max_er_wspd_20km", max20)):
                r = _rounded(g(arr, local_idx))
                if r is not None:
                    fields[key] = r
            if fields:
                result[str(ci)] = fields

        print(f"    {era}: {n_cases} cases read, "
              f"{sum(1 for ci in range(offset, offset + n_cases) if str(ci) in result)} populated")
    return result


def _write_out(path: str, payload: dict) -> None:
    text = json.dumps(payload, indent=2)
    if path.startswith("gs://"):
        import gcsfs
        fs = gcsfs.GCSFileSystem()
        with fs.open(path, "w") as f:
            f.write(text)
    else:
        with open(path, "w") as f:
            f.write(text)
    print(f"Wrote sidecar → {path} ({len(text)//1024} KB)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="enrichment_sidecar.json",
                    help="Output path (local file or gs:// URL)")
    ap.add_argument("--types", nargs="+", default=["swath", "merge"],
                    choices=["swath", "merge"])
    args = ap.parse_args(argv)

    payload = {"schema": 1, "built_utc": datetime.now(timezone.utc).isoformat()}
    for data_type in args.types:
        print(f"=== {data_type} ===")
        payload[data_type] = build_for_type(data_type)

    _write_out(args.out, payload)
    print("Done. Set TC_RADAR_ENRICHMENT_SIDECAR (or place at the default GCS path) "
          "and redeploy; the API will skip live per-case enrichment.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
