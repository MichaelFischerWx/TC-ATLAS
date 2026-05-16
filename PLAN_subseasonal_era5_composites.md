# Tier 3 Plan: ERA5 Phase Composites on the Reanalysis Globe

Status: **planning** (2026-05-16). Tiers 1+2 (TC genesis dial + track density per phase) shipped on the TC Climatology page same day. This doc scopes the larger Tier 3 effort: compositing ERA5 fields (shear, RH, SST, OLR, Z500, …) on the existing GC-ATLAS-vendored climatology globe, binned by MJO / BSISO phase.

## What "Tier 3" would deliver

For each (mode ∈ {MJO, BSISO1, BSISO2}) × (phase ∈ {1..8}) × (field ∈ {SST, Tcw, OLR/OLRanom, 850/200 wind, shear, Z500, RHmid, …}), a globe-ready tile composed of the **time-mean of daily ERA5 over all active days** (amplitude ≥ 1) falling in that phase. Surfaced in the globe UI as either:

- a new "Subseasonal phase" composite mode in the existing composite builder (next to Index / Year-selection); pick mode + phase, and the globe paints the composite anomaly relative to the climo mean.
- OR a side-by-side 8-panel small-multiple view (heavier UI; defer).

Recommended first deliverable: **MJO-phase anomaly composite of OLR + 850-hPa zonal wind**, the canonical W-H 2004 figure 8. Validates the pipeline end-to-end before going broad.

## Why it's expensive (compared to Tiers 1+2)

| Cost driver | Tier 1+2 | Tier 3 |
|---|---|---|
| ERA5 data needed | none | **daily** (or pentad) ERA5 across all fields for ~50 yr |
| Tile storage | 0 | ~8 phases × ~10 fields × {anom, raw} × 1°-2° = 100s of tiles per mode × 3 modes |
| Pipeline work | one Python script | new compositing pipeline in Gen_Circ (mirrors existing monthly-mean pipeline but bins by phase) |
| Frontend changes | new subview + Plotly | extend GC-ATLAS composite engine to accept phase-bin manifests |
| Cache pressure | tiny | similar order of magnitude as the per-year tile tree (~10 GB) |

## Phased implementation plan

### Step 1 — Decide the time discretization (1–2 hr)
Two viable paths:
- **A. Pentad means (5-day blocks)**: ~73 pentads/yr × 50 yr ≈ 3,650 pentads. For each pentad, pick the *dominant* active phase across its 5 days (or skip if no phase covers ≥3 days). Lossy but cheap and historically common.
- **B. Daily fields**: ~18,000 days × N fields. ~5× bigger storage, but matches the daily index granularity exactly and is what modern phase composites use (Camargo et al. 2014, 2019).

Recommendation: **B (daily)**. Disk is cheap; the scientific result is sharper. ERA5 daily-mean reanalysis is already on GCS public bucket (`gs://gcp-public-data-arco-era5`).

### Step 2 — Compositing pipeline (1–2 days)
Likely lives in the Gen_Circ repo alongside `build_climatology.py`. New script `build_phase_composites.py`:

```
for mode in [MJO, BSISO1, BSISO2]:
    for field in fields:
        load daily ERA5 field (subset to mode's date coverage)
        load phase[day], amplitude[day] from subseasonal_phases.json
        for phase in 1..8:
            mask = (phase[day] == phase) & (amplitude[day] >= 1) & season_mask(month, mode)
            composite_mean = field[mask].mean(dim='time')
            composite_anom = composite_mean - climatology(field, month=...)
        write tile tree gs://tc-atlas-clim/phase_composites/{mode}/{field}/{phase}/...
```

Climatology subtraction is subtle: should subtract the **same-season** mean (e.g., May–Oct climatology when computing BSISO composites) to remove the seasonal cycle, not the annual-mean climatology.

### Step 3 — Tile manifest format (half day)
Add `phase_composites` manifest alongside the existing per-month and per-year manifests in the GC-ATLAS pipeline output. Schema:

```json
{
  "modes": ["mjo","bsiso1","bsiso2"],
  "phases": [1,2,3,4,5,6,7,8],
  "fields": ["sst","olr","u850","u200","dls","z500","rh500"],
  "season_filter": "mjjaso",
  "amplitude_threshold": 1.0,
  "n_days_per_phase": { "mjo": [2210, 1980, ...], ... },
  "date_range": {"start": "1974-06-01", "end": "2024-02-24"}
}
```

### Step 4 — Frontend wiring in climatology_globe.js (1 day)
- Add a new composite mode "Subseasonal phase" alongside the existing Index / Year-selection modes ([climatology_globe.html:180](climatology_globe.html:180)).
- UI: mode dropdown (MJO/BSISO1/BSISO2), phase chips (1–8), amplitude threshold readonly note.
- When applied, the composite engine fetches `phase_composites/{mode}/{field}/{phase}/...` tile path instead of `per_year/{year}/...`.
- The track-overlay logic should filter IBTrACS to only show **fixes that occurred on days of that phase**, not full storm tracks. Reuses the cross-reference from Tier 1+2.
- Reuse the existing sliding-climatology subtraction toggle for anomaly mode.

### Step 5 — UI polish (half day)
- Phase-dial badge in the composite header showing which phase is active.
- Quick "Cycle phases 1→8" button (timelapse through the 8 phases like the existing Month animator).
- Document n_days_per_phase prominently so users know if a thin phase has poor statistics.

## Open questions

1. **OLR availability**: ERA5 doesn't natively expose top-of-atmosphere OLR; NOAA Interpolated OLR is the canonical alternative. May want to ingest NOAA OLR alongside ERA5 fields. Adds another ~1 GB and a separate ingestor.
2. **Stratification**: do we want **active phases only** (amp ≥ 1) or **all 8 phases** including weak? Standard = active only, but Tier 3 could expose both.
3. **Phase 0 / "quiescent"**: should we also publish a "no active phase" composite as the natural reference? Useful for "MJO-active minus quiescent" subtraction. Adds 1 composite per mode.
4. **Storage cost**: ~3 modes × 8 phases × 10 fields × ~5 MB/tile-tree level × multiple zoom levels ≈ 5–10 GB on GCS. Trivial cost but worth confirming before kicking off the pipeline.
5. **Update cadence**: a static frozen archive (recompute yearly) vs. incremental (recompute when new pentads land). Suggest **frozen + yearly refresh** — phase composites are climatologies, not nowcasts.

## Estimated total effort

3–5 working days end-to-end:
- 1 day: pipeline (download daily ERA5 subset, compute composites, upload tiles)
- 1 day: frontend wiring on the globe + composite engine plumbing
- 1 day: anomaly mode, UI polish, documentation, attribution
- 0.5–2 days: validation against published figures (W-H Fig 8, Kikuchi Fig 8, Camargo et al. composites)

## Decision gate

Worth doing **after** Tiers 1+2 have been live for ~1 month and feedback validates that the subseasonal viewpoint gets used. If the genesis-dial-only view answers users' questions, Tier 3 may not pull its weight.
