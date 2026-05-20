# Subseasonal + Seasonal ops/research features — implementation plan

User-requested items from the 2026-05-19 review of "what's missing for
the operational + research community". Implementation order matches
"cheapest first" per the user's preference.

## Status table

| # | Feature                              | State        | Effort  | Steady-state cost |
|---|--------------------------------------|--------------|---------|---|
| 3 | Genesis enhancement under clocks     | **SHIPPED**  | —       | $0 |
| 1 | MJO 14-day forecast trail            | **BLOCKED**  | 4 hr    | $0.01/mo |
| 6 | MDR vertical shear time series       | planned      | 8 hr    | $0.01/mo |
| 2 | χ200 (velocity potential) Hovmöller  | planned      | 8 hr    | $0.05/mo |
| 4 | OHC time series                      | planned      | 8 hr    | $0.10/mo |
| 5 | MPI + Chavas 2025 VPI/VGPI overlay   | planned      | 14 hr   | $1-2/mo |

Blocker on #1 documented in `PLAN_subseasonal_mjo_forecast.md`.

---

## #6 — MDR vertical wind shear time series (Panel B variant)

**Goal.** Mirror Panel B's SST evolution time series for 200-850 hPa
shear. Same envelope, same highlight-year, same daily-vs-monthly modes
— users see SST and shear evolve together as the classical SHIPS
seasonal-forecasting predictors.

**Why it's tractable.** Daily shear is already computed by
`build_env_overlays.py:build_shear()` (line 1153). The cron writes a
global shear grid every hour for f000-f012; we just need to extract
region means and append a row per day.

### Backfill (one-time)

Add `build_shear_history.py` modeled after `build_oisst_history.py`:

1. **ERA5 monthly mean fetch**, 1991-2020, fields:
   - `u_component_of_wind` at 200 and 850 hPa
   - `v_component_of_wind` at 200 and 850 hPa
2. Compute shear magnitude `sqrt((u200 - u850)² + (v200 - v850)²)` per
   month per region (reuse REGIONS from `build_oisst_history.py`).
3. Output: `indices_monthly_shear.parquet` on GCS with columns
   `date`, `atl_mdr_shear`, `atl_basin_shear`, … (same key suffixes as
   the SST parquet).
4. Daily 1991-present from ERA5 single-level reanalysis if you want
   the daily climatology envelope; alternatively use NCEP/CDAS-1 which
   is free and reaches back to 1948.

ERA5 fetch via `cdsapi`: ~1-2 hours on a workstation with a fast
connection. Storage: ~3 MB parquet snappy.

### Daily live (cron extension)

Hook into `build_env_overlays.py` after the existing `build_shear()`
call:

```python
# After build_shear(...) produces the global shear field:
from build_oisst_history import REGIONS, _region_mean
row = {"date": date_str, "cycle": cycle, "fh": forecast_hour}
for name, box in REGIONS.items():
    row[f"{name}_shear"] = float(_region_mean(shear_kt, box).values)
append_to_daily_shear_parquet(row)
```

Storage: ~30 floats × 24 cycles/day × 365 days ≈ 90 KB/year. Trivial.

### Frontend (Panel B variant)

In `realtime_seasonal.js`:

1. Add `'shear'` to the variable dropdown next to `sst`, `anom`,
   `sst_dt`, `sst_rel`.
2. Branch in `_buildTimeSeriesData()`: when `state.ts.variable === 'shear'`,
   read from a separately-fetched `indices_daily_shear_current_year.json`
   + `indices_monthly_shear.parquet`. Y-axis units in knots.
3. Climatology envelope built the same way; "highlight year" semantics
   unchanged.
4. Save-as-PNG/title labels: "MDR Wind Shear (200-850 hPa)".

### Deploy steps for the user

1. `python build_shear_history.py` (locally; uses your CDS credentials).
2. `gsutil cp indices_monthly_shear.parquet gs://tc-atlas-ir-cache/seasonal/`
3. `./deploy_env_job.sh` to roll out the cron extension.

---

## #2 — χ200 (velocity potential) Hovmöller

**Goal.** Add a sixth band to the Subseasonal Hovmöller stack (or a
top-row alternative for the combined view's base) showing 200-hPa
velocity-potential anomaly. χ200 is the canonical operational tracer
for upper-level divergence/convergence — captures the MJO + Kelvin
envelope more directly than OLR alone.

### Pipeline

1. **Source.** GFS analysis daily u,v at 200 hPa already pulled by env-
   overlay cron. Same `windspharm`-based Helmholtz decomposition the
   env-overlay machinery already uses for streamfunction.
2. **Historical context.** Need 60 days of history for the Hovmöller.
   Either store a rolling daily slab on GCS (~2 MB) or recompute from
   ERA5 once per cron run (~30 s).
3. **Cron extension.** Inside `build_subseasonal_overlays.py`, after
   the OLR slabs, fetch ERA5 daily u200/v200 for the 200-day window,
   Helmholtz → χ200, average lat band, write
   `subseasonal/chi200/hovmoller.json` mirroring the OLR slab shape.
4. **Climatology.** Use 1991-2020 ERA5 climatology of χ200 (build
   alongside OLR clim in same cron). Anomaly = χ200(t) - clim(doy).
5. **Frontend.** Add as a new entry in the `BANDS` array in
   `realtime_subseasonal.js` — wire the same lat-band toggle, same
   colorscale (use BrBu or PuOr instead of BrBG so the user can tell
   it apart from OLR).

### Cost

* Daily cron: +30-60 s wall time for the chi200 path.
* Storage: ~2 MB rolling slab + ~5 MB climatology.
* GCS bandwidth: +1 MB/day.

### Notes on combined view

Once χ200 is available, consider making the combined-view base
user-selectable: OLR (current default) vs χ200. χ200 is smoother
already (it's an integral of OLR-related forcing), so the 5-day
smoothing toggle would be less impactful for that base.

---

## #4 — OHC / TCHP time series

**Goal.** Add Tropical Cyclone Heat Potential (OHC ≥ 26°C isotherm) as
a Panel B variable. SST is shallow; OHC is what storms feed on during
RI. NESDIS publishes a real-time global 0.25° product daily.

### Source

NESDIS OSPO TCHP: `https://www.star.nesdis.noaa.gov/socd/sst/squam/`
or `ftp://eclipse.ncdc.noaa.gov/pub/OISST-V2-AVHRR/`. Several mirrors
exist; the NESDIS realtime product is updated by ~14 UTC daily.

### Backfill

* NCEI archive at <https://www.ncei.noaa.gov/data/oceans/cwp/>. Daily
  1998-present (TCHP records start in the satellite altimetry era).
* Backfill via small Python script: fetch daily netCDF, compute MDR-
  mean (and sub-basins) → parquet. ~3 hours of fetch + compute.
* Storage: full-history daily parquet ~3 MB.

### Daily live

Add a new cron task (or extend the existing seasonal cron) to fetch
yesterday's TCHP slab + append to `indices_daily_ohc_current_year.parquet`.

### Frontend

Same Panel B variant pattern as #6 — new dropdown entry, separate
parquet load, ocean-color (deep teal/blue) colorscale for the climo
envelope. Y-axis units: kJ/cm².

### Cost

* GCS storage: +3 MB one-time + ~30 KB/year. Negligible.
* Compute: ~1 min/day cron, $0.05/mo.

---

## #5 — MPI + Chavas 2025 VPI + VGPI overlay

**Goal.** Replace classical Bister-Emanuel GPI with the Chavas et al.
(2025) **ventilated** formulation. Ship three new daily env-overlay
layers:

1. **MPI** — unventilated maximum potential intensity (Bister-Emanuel).
2. **VPI** — ventilated PI (Chavas 2025): MPI reduced by the
   environmental ventilation parameter Λ derived from mid-level
   entropy deficit + vertical wind shear.
3. **VGPI** — ventilated GPI: classical GPI but with VPI replacing the
   PI term, embedding shear suppression more physically.

Also requested: **PI anomalies** against the Climatology page's
monthly mean field. Implementation route below.

### Theory recap (Chavas 2025)

* Ventilation parameter Λ = (V_shear × χ_m) / V_pot
  - V_pot = Bister-Emanuel MPI (m/s)
  - V_shear = 850-200 hPa shear magnitude (m/s)
  - χ_m = non-dimensional mid-level entropy deficit
    = (s_sat* - s_m) / (s_sst* - s_b)
    where s_sat* is saturation entropy at the SST, s_m is mid-level
    entropy at 600 hPa, s_b is boundary-layer entropy.
* VPI = V_pot × f(Λ), where f is a monotone-decreasing function
  calibrated against numerical experiments in Chavas et al. 2025.

### Dependencies

* `tcpypi` (pip) — Bister-Emanuel PI from python.
* `metpy` (already in env-overlay reqs) — entropy / saturation entropy
  helpers.
* No new GRIB fields needed — env-overlay cron already pulls T, q at
  multiple levels and SST.

### Cron extension

Add `build_pi_layers.py` (sibling of `build_env_overlays.py`) hooked
into the same scheduled cron:

1. Read GFS analysis grids: SST (or OISST passthrough), T(p), q(p) at
   pressure levels 1000, 925, 850, 700, 600, 500, 400, 300, 250, 200,
   150, 100 hPa.
2. Run `tcpypi.run_sample_dataset(...)` → MPI field.
3. Compute χ_m from T/q at 600 hPa vs SST and boundary layer.
4. Pull existing shear from env-overlay output.
5. Compute Λ → VPI → VGPI per Chavas 2025.
6. Write three env-layer outputs: PNG + grid sidecar + GeoJSON
   contours (matches existing env-overlay pattern).

### Anomalies vs monthly climatology

User suggestion: "anomalies can be computed from the monthly means in
the TC climatology page if you think that's relevant."

The TC Climatology page's monthly SST climatology is already on GCS
(`oisst_monclim_1991_2020.nc`). To compute PI anomalies, we need a
matching **MPI climatology**, which requires running tcpypi on monthly
mean T, q, SST for 1991-2020. One-time computation, ~5 hours on
Cloud Run, output: `mpi_monclim_1991_2020.nc` (~30 MB).

Then daily PI anomaly = today's MPI - day-of-year-interpolated climo MPI.

### Frontend integration

Add to env-overlay layer menu:
* "Max Potential Intensity (MPI)" — base unventilated PI.
* "Ventilated PI (VPI, Chavas 2025)" — operational forecast PI.
* "VGPI (Chavas 2025)" — formation favorability.
* "MPI anomaly" — vs 1991-2020 climo monthly mean.

Each ships as a colored shading + contour overlay layer in the env
sidebar — same code path as the existing shear / RH / SST overlays.

### Cost

* Docker image rebuild required (adds tcpypi + dependencies, ~80 MB).
* Cron compute: +1 min/run for the PI + Helmholtz + Λ + VGPI passes.
  Daily run (or sub-daily for f000-f012 if you want hourly nowcasts) →
  +$1-2/mo Cloud Run.
* Storage: same as one env layer (~200 KB warped PNG + contours per
  variable per cycle).

### Deploy steps for the user

1. Add `tcpypi` to `requirements.env.txt`.
2. Write `build_pi_layers.py` (skeleton in the planning notes).
3. One-time: run `build_mpi_climatology.py` against 1991-2020 ERA5
   monthly means → upload to GCS.
4. `./deploy_env_job.sh` to roll out the cron extension.
5. Frontend: add the three layer entries to the env menu.

---

## Recommended deploy order

1. **#6 shear time series** — lowest risk, reuses Panel B + existing
   shear computation; only the ERA5 backfill is new.
2. **#4 OHC time series** — independent of everything else, plugs into
   the same Panel B variant pattern as #6.
3. **#2 χ200 Hovmöller** — modest cron extension, adds a new band to
   an established frontend pattern.
4. **#5 MPI/VPI/VGPI** — largest lift (Docker dep + new science).
   Ship as a fresh env-overlay layer rollout once #6 is in to confirm
   the cron-extension pattern is solid.
5. **#1 MJO forecast trail** — unblocked once we have a forecast
   source (see `PLAN_subseasonal_mjo_forecast.md`).
