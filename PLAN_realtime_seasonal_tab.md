# Plan — Real-Time Seasonal Tab (RT Monitor)

Status: draft 2026-05-17
Owner: Mike Fischer
Companion to: PLAN_realtime_subseasonal_overlay.md, PLAN_subseasonal_era5_composites.md

## Goal

Add a fourth tab to `realtime_ir.html` (peer to Satellite / Models / Subseasonal) called **Seasonal**. The tab uses OISST + the SPACE-core5 ACE work (`/Users/mfischer/github/ACE/`) to answer:

> *"How does the current SST background state compare to past Atlantic seasons, and what does that imply for ACE?"*

This is the **MVP** (SST + ACE only). MJO/ENSO/dust/shear climatology come later. Once forthcoming ACE-forecast work is peer-reviewed and published, Panel F is wired up to host the live forecast (in a separate change, gated by `feedback_ace_paper_embargo.md`).

---

## 1. Cost-minimizing data strategy

### Principle: ingest once, derive small, serve smaller

OISST v2.1 daily 0.25° is the largest moving piece. Strategy:

**Two-tier data strategy:**
1. **Historical (monthly resolution)** — from OISST v2.1 monthly mean at 0.25° (`sst.mon.mean.nc`, ~2 GB, already on local disk at `/Users/mfischer/Data/ACE/`). Single file covers 1981-present. Used to build the climatology, the historical indices time series, and the EOF basis for analog matching.
2. **Live (current-year daily resolution)** — OISST v2.1 high-res daily, single-day fetch via PSL OPeNDAP per cron run (~150 KB / fetch). Used for the live anomaly map and the date scrubber within the current year.

**No raw NetCDF is mirrored to GCS.** Every product stored is small and derived.

| Layer | Where it lives | Size | Refresh |
|---|---|---|---|
| Month-of-year climatology (1991–2020 mean + std, Atlantic+tropics subset) | `gs://tc-atlas-ir-cache/seasonal/oisst_monclim_1991_2020.nc` | ~30 MB | once (rebuild every ~5 yr) |
| Monthly region-index time series, 1982-present (basin + MDR + AMO + Caribbean + Gulf + NTA + TSA + Niño 3.4) | `gs://tc-atlas-ir-cache/seasonal/indices_monthly.parquet` | <1 MB total | monthly append from the live job |
| Current-year daily indices time series | `gs://tc-atlas-ir-cache/seasonal/indices_daily_current_year.parquet` | <50 KB | daily append (~few KB/day) |
| Daily anomaly maps (PNG, Atlantic-centric) | `gs://tc-atlas-ir-cache/seasonal/anom_png/YYYY-MM-DD.png` | ~80 KB each | daily, rolling last 365 |
| Annual ACE history (1982–present) | `gs://tc-atlas-ir-cache/seasonal/ace_annual.json` | <50 KB | weekly refresh from IBTrACS NA |
| Forthcoming ACE forecast (post-publication only) | `gs://tc-atlas-ir-cache/seasonal/ace_forecast_YYYY.json` | <100 KB | once per season, locked |

**Net wire cost to browser:** typical session loads the daily indices parquet, the current anomaly PNG, the climatology envelope JSON, and the ACE history JSON — **well under 1 MB total**. No per-day NetCDF fetches client-side; everything heavy is precomputed.

**Net Cloud cost:** the daily Cloud Run Job pulls one Atlantic+tropics subset slice (~3 MB) from NOAA PSL OPeNDAP, runs ~20 s of numpy, writes a ~80 KB PNG + appends a row to parquet. Expect ~$0.10–0.30/month, same envelope as the subseasonal overlay job we already run (`deploy_subseasonal_job.sh`).

**One-time backfill cost:** ~10 GB of OPeNDAP reads from PSL (subset, not global) to build climatology + historical indices. Pulled once, stays as a small derived blob in GCS forever.

### Ingest source

NOAA PSL THREDDS — `https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres/sst.day.mean.YYYY.nc`. Subset via OPeNDAP to Atlantic box + only most recent N days; never download the whole year for daily updates. PSL files are the same ones already at `/Users/mfischer/Data/ACE/sst.day.mean.2025.nc`, so the read pattern is proven.

### One-time backfill

A separate `build_oisst_history.py` (run locally, not as a cron) with four idempotent steps. All historical work uses the local `sst.mon.mean.nc` file (no PSL traffic):

1. **monthly_climatology** — from `sst.mon.mean.nc`, compute month-of-year mean + std over 1991–2020, write `oisst_monclim_1991_2020.nc`.
2. **monthly_indices** — same source file, compute region-mean monthly SST + anomalies 1982–present for all eight regions, write `indices_monthly.parquet`.
3. **ace** — pull IBTrACS NA (v04r01), compute annual ACE 1982–present from synoptic-time NA TS/SS points with v ≥ 35 kt, write `ace_annual.json`. ✓ verified against NHC published values.
4. **upload** — push derived blobs to GCS.

Each step can be run independently (`--step monthly_climatology`, etc.) and is idempotent. After this completes, the daily Cloud Run job appends to a separate `indices_daily_current_year.parquet` and refreshes the monthly indices on the first run of each month.

---

## 2. Pipeline (daily Cloud Run Job)

New file: `build_seasonal_diagnostics.py`. Mirrors the structure of `build_subseasonal_overlays.py`.

**Daily flow (UTC 12 Z, ~5 min after NOAA's daily OISST drop):**

1. **Fetch** today's (or most-recent-available) OISST v2.1 daily field via OPeNDAP, Atlantic + tropics subset (lat −5–60°, lon 260–360°).
2. **Anomaly** = today − doy-climatology, masked to Atlantic.
3. **Region means** (basin, MDR `10–20°N, 20–85°W`, AMO `10–50°N, 20–30°W`, Caribbean, Gulf, North Tropical Atlantic, Tropical South Atlantic, Niño 3.4 — for ENSO context).
4. **Update published climate indices** (AMM, Niño 3.4, NAO; from public sources — NOAA CPC / PSL / ESRL). Stored in indices parquet.
5. **Render PNG** of today's Atlantic anomaly with a fixed diverging colorbar (−3 to +3 °C).
6. **Append** today's row to `indices_daily.parquet` and overwrite a small `latest.json` for fast first-paint.
7. **Recompute analog rankings** (cheap; see §3).

All of this fits in a single ~5 min Cloud Run Job; we reuse the same Dockerfile pattern as `Dockerfile.env`.

---

## 3. Diagnostics — what the tab actually shows

Layout: vertical stack of panels (responsive on mobile). User's example scatter is **Panel C** below.

### Panel A — Live Atlantic SST anomaly map
- Leaflet map, Atlantic-centric.
- Today's anomaly PNG as `L.imageOverlay`, Mercator-warped (per `feedback_env_overlay_projection.md` — equirect on Mercator is forbidden).
- **Date scrubber** along the bottom: drag from Jan 1 of current year → today. PNG swaps via `<img src>` change.
- Hover tooltip shows local anomaly °C (read via a sidecar JSON of binned values, same pattern as env overlays).
- Toggle: anomaly vs raw SST.

### Panel B — Region time series (current year vs climo envelope + analogs)
- Multi-trace line chart (Plotly or D3).
- X = Jan 1 → Dec 31 day-of-year.
- Y = SST °C in the selected region (dropdown: Basin / MDR / AMO / Caribbean / Gulf / Niño 3.4).
- Traces:
  - 1991–2020 climatological mean (heavy line)
  - ±1σ envelope (shaded)
  - Top-N analog years (user-selectable N, default 5) — see §3 Panel D
  - Current year (bold)
- Click a year in the legend → toggles trace.

### Panel C — 2D phase-space scatter (the figure the user shared)
- X = mean MDR SST for user-selected month/window (default: today's date → 30-day mean).
- Y = mean AMO SST (same window).
- One dot per historical year, colored by Annual ACE (viridis or the user's existing palette).
- Current year highlighted as a magenta star (matches the user's mock).
- **Axis selectors** so any two region indices can be plotted against each other (MDR × AMO, MDR × Niño 3.4, AMO × Atl Niño, etc.).
- **Window selector**: "May mean", "JJA mean", "today − 30 days", "today − 90 days".
- Hover a dot → reveals year, ACE, named storms, US landfalls.
- Click → loads that year as an overlay in Panel B and Panel A (lets you compare 2010 SST evolution vs 2026).

### Panel D — Analog season ranking
- Live anomaly-pattern correlation between current year's running SST anomaly and each historical year's same-day anomaly.
- Table of top 10 closest analogs (rank, year, pattern r, that year's Annual ACE, named storms, US landfalls).
- "Composite" toggle: show mean SST + ACE of top-5 analogs vs current state.

### Panel E — Published climate-index dashboard
- Sparkline trio (or radial gauges) of standard, publicly-established Atlantic-relevant climate indices, scaled by historical percentile:
  - **AMM** (Atlantic Meridional Mode, Vimont & Kossin 2007) — daily/monthly value.
  - **Niño 3.4 SST anomaly** — ENSO state.
  - **NAO** — North Atlantic Oscillation.
  - Optional adds: classical AMO, TNA/TSA, IOD.
- Click an index → tile expands to a time-series plot (current vs climo envelope, same renderer as Panel B).
- These indices come from already-published methods and from `indices.json` (GC-ATLAS pipeline) where they exist.
- **Important:** no novel EOF basis, no predictor selection from in-prep work. Strictly public-domain indices.

### Panel F — Live ACE forecast (placeholder)
- Renders a generic placeholder card until peer-reviewed publication of forthcoming ACE forecast work:
  > *"Real-time seasonal ACE forecast — coming soon, pending peer review."*
- No mention of methodology, predictors, EOF basis, or framing language from the in-prep paper.
- Once the paper is accepted, this panel is wired up in a separate change (and `feedback_ace_paper_embargo.md` is revisited).

---

## 4. Frontend hookup

- Add a fourth `<button class="tab">` in `realtime_ir.html`.
- New JS module `realtime_seasonal.js`, lazy-loaded on first tab click (consistent with `realtime_subseasonal.js`).
- Reuse `subseasonal_clock.js`-style helpers where they fit (e.g., the date scrubber).
- New `realtime_seasonal_styles.css` (small; mostly grid layout for the panel stack).
- Endpoint: a thin extension of `ir_monitor_api.py` that signs URLs into `gs://tc-atlas-data/seasonal/`, same pattern as the env overlays.

---

## 5. Build order (MVP → polish)

1. **Backfill script** — one-time daily OISST mirror to GCS, doy climatology, historical indices parquet, annual ACE history. ~1 day.
2. **Daily cron job** (`build_seasonal_diagnostics.py` + `deploy_seasonal_job.sh`). Wires the anomaly PNG + appending parquet. ~1 day.
3. **Frontend skeleton** — new tab + Panel A (anomaly map + scrubber) + Panel B (region time series). ~1 day.
4. **Panel C** (scatter) + Panel D (analogs). ~1 day.
5. **Panel E** (published climate-index dashboard) — pulls AMM/Niño 3.4/NAO from public sources + indices parquet. ~0.5 day.
6. **Panel F** (ACE forecast) — placeholder card with no methodology mentions. Live wiring deferred until peer-reviewed publication.

Total MVP: ~4.5 days of work. Daily ops cost: <$0.30/mo.

---

## 6. Open questions / flagged risks

- **Pre-publication embargo**: Panels E and F are strictly public-domain indices and a generic placeholder, respectively. See `feedback_ace_paper_embargo.md`. Re-audit before adding any seasonal feature.
- **OISST PSL availability**: PSL occasionally lags 1–2 days. Fallback: NOAA NCEI THREDDS (`https://www.ncei.noaa.gov/thredds/oisst/`). Cron job retries with backoff.
- **Detrending**: live tab defaults to raw anomaly (intuitive); a detrended toggle (linear trend removed from doy climatology baseline) is available. Both are cheap to compute.
- **ACE estimate during current season**: until end-of-season, "current ACE" needs to come from real-time best-track (NHC ATCF) — already plumbed elsewhere in TC-ATLAS for the storm list. Reuse that.
- **Caching**: client-side, treat `latest.json` and the parquet as 6 hr cacheable; PNGs as 24 hr cacheable. Bust with the daily-job timestamp.

---

## 7. Files to create

```
TC-ATLAS/
  build_seasonal_diagnostics.py       # daily cron
  build_oisst_history.py              # one-time backfill
  deploy_seasonal_job.sh              # mirrors deploy_subseasonal_job.sh
  realtime_seasonal.js                # frontend, lazy-loaded
  realtime_seasonal_styles.css        # panel layout
  PLAN_realtime_seasonal_tab.md       # this file
  Dockerfile.seasonal                 # if env requirements diverge from Dockerfile.env
```

Plus minor edits to `realtime_ir.html` (tab button + container div) and `ir_monitor_api.py` (signed URL endpoint for `gs://tc-atlas-data/seasonal/...`).
