#!/usr/bin/env python3
"""
Precompute the RAW vortex metrics (Fischer et al. 2025, MWR, Table 1) for every
merged TC-RADAR case, ONCE, into tc_radar_vortex_raw.json (shipped with the API).

WHY
---
/scatter/vp_favorability needs vortex_height / vortex_width / vortex_favorability.
The API computes them in two passes: per-case raw metrics (pass 1, a hybrid-R_H
azimuthal mean of two 3-D fields per case) and a single database-mean centring
(pass 2). Pass 1 is too slow to run on every cold Cloud Run instance (minutes per
case under startup load), and the enrichment sidecar deliberately leaves it out,
so since 2026-06-04 the metrics were never ready. This script runs pass 1 offline
with the API's own function (identical numbers) and writes
    {"schema": 1, "built_utc": "...", "cases": {"<case_index>": {"raw_h1_max": .., "raw_width_diff": ..}}}
The API loads it at startup and runs only pass 2 (_finalize_vortex_metrics).

USAGE (from the repo root; reads the public TC-RADAR Zarr on GCS)
    python3 scripts/build_tc_radar_vortex_raw.py            # -> tc_radar_vortex_raw.json
Rebuild only when the merge Zarr, the merge metadata (vmax / RMW) or
climatology_hybrid.npz change.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tc_radar_api as A  # noqa: E402


def main():
    # Recreate the startup state _compute_vortex_metrics_for_case relies on.
    with open(A.MERGE_METADATA_PATH) as f:
        A._merge_metadata_cache = {c["case_index"]: c for c in json.load(f).get("cases", [])}
    clim = np.load(str(A.CLIMATOLOGY_PATH), allow_pickle=False)
    A._climatology = {k: clim[k] for k in clim.files}
    print(f"{len(A._merge_metadata_cache)} merge cases, climatology {len(A._climatology)} arrays")

    out, skipped = {}, 0
    early = A.CASE_COUNTS[("merge", "early")]
    for era in ("early", "recent"):
        # Open the public Zarr directly (consolidated, ~3 s) rather than via
        # A.get_dataset, which goes through the API's backend setup.
        import xarray as xr
        ds = xr.open_zarr(f"gs://tc-atlas-zarr/tc-radar/merge_{era}", consolidated=True)
        offset = 0 if era == "early" else early
        # Pull the two fields into memory once (one bulk read per variable)
        # instead of one GET per case.
        ds = ds[["merged_tangential_wind", "merged_relative_vorticity"]].load()
        n = ds.sizes.get("num_cases", 0)
        t0 = time.time()
        for local_idx in range(n):
            ci = local_idx + offset
            if ci not in A._merge_metadata_cache:
                continue
            raw = A._compute_vortex_metrics_for_case(ci, ds, local_idx, "merge")
            if raw:
                out[str(ci)] = {k: round(float(v), 6) for k, v in raw.items()}
            else:
                skipped += 1
        print(f"  merge/{era}: {n} cases in {time.time() - t0:.0f}s")

    payload = {"schema": 1, "built_utc": datetime.now(timezone.utc).isoformat(), "cases": out}
    with open("tc_radar_vortex_raw.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"wrote tc_radar_vortex_raw.json: {len(out)} cases, {skipped} skipped")


if __name__ == "__main__":
    main()
