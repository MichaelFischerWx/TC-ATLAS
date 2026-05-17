# Plan: Real-time subseasonal forcing diagnostics on TC-ATLAS

Status: **planning + Phase 1 MVP in progress** (2026-05-16).

## What we want to enable

Three connected visualizations that show *current* subseasonal state alongside the live storm activity, complementing the TC Climatology Subseasonal page (which shows *historical* phase composites):

1. **Current MJO / BSISO phase clock** — small widget on the Real-Time Monitor showing today's RMM/OMI/BSISO position on the canonical (PC1, PC2) phase-space diagram, plus amplitude and "active basin" callouts.
2. **OLR anomaly overlay** — Leaflet image overlay on the RT Monitor global IR map. Suppressed OLR = active convection. Tells you at-a-glance where the MJO convective envelope is right now.
3. **Wheeler–Kiladis filtered Kelvin / ER / MRG contours** — separate togglable overlays for each wave type. Lets users isolate "is this storm being modulated by a passing Kelvin wave?" from the broader MJO envelope.

(1) is feasible today with data we already ship. (2) needs daily NOAA OLR + a thin backend cache or client-side NetCDF fetch. (3) needs a Wheeler–Kiladis filtering pipeline.

## Phase 1 — MJO/BSISO phase clock widget (this session)

**Scope:** a small panel on the RT Monitor that shows the current state of all four subseasonal indices we already have data for. Lives in the existing RT Monitor sidebar.

**Data:** [data/subseasonal_phases.json](data/subseasonal_phases.json) — already shipped, daily-resolution phase + amplitude through 2026-05-14 (RMM) / 2026-05-13 (BSISO) / 2024-05-20 (OMI). Loaded lazy on RT Monitor page open.

**Widget contents:**
- Phase-clock SVG diagram for MJO (RMM): 8 sectors labeled 1–8, current (PC1, PC2) plotted as a dot with a fading 7-day track. Amplitude readout. Active basin callout (Phase 1–3 → IO active, 4–5 → MC, 6–7 → WPac/W Hem, 8 → W Hem/Atl).
- One-line readouts for OMI, BSISO1, BSISO2: "Phase X · amp Y.YY · 7d trend ↗".
- Sticky link to the climatology page filtered to the matching phase: "see all storms that formed in this phase →".

**No new backend.** Just frontend JS + the existing JSON.

## Phase 2 — OLR anomaly overlay (next session, ~1–2 days)

**Goal:** a togglable layer on the RT Monitor global map showing daily NOAA OLR anomaly. Suppressed OLR (negative anomaly, < ~−20 W/m²) = active deep convection. The MJO envelope, ITCZ pulses, and major TC convection all light up.

**Data source options:**
- **A. Backend cache + render.** Pull NOAA Interpolated OLR daily (NetCDF from PSL THREDDS), compute anomaly vs 1991–2020 climatology, render PNG tiles or a single global PNG, cache on GCS like the IR cache. Pros: full control, no CORS issues, can derive Kelvin-filtered variants later from the same source. Cons: adds backend complexity, ~50 MB/day raw OLR but tiny once anomaly-only PNG.
- **B. Direct browser fetch.** NOAA PSL hosts the OLR daily as a self-contained PNG (`https://psl.noaa.gov/map/clim/olr.shtml`). We'd ingest as an L.imageOverlay. Pros: zero backend. Cons: NOAA's PNG isn't bbox-stable (font, margins, frame change between versions), so georeferencing is fragile.
- **C. Use NOAA NCEP CFS OLR / GFS analysis.** Available via a stable API on Cloud Run-able endpoints. Comparable to (A) in effort.

**Recommendation:** A. Mirrors the existing IR cache pattern, ships clean tiles, gives us the raw fields needed for Phase 3.

**Rendering:**
- L.imageOverlay or L.GridLayer over the existing IR map
- Diverging colormap: blue (suppressed OLR, active convection) ↔ red (enhanced OLR, suppressed convection)
- Opacity slider so users can layer over IR
- ToD: should anomaly use a 30-day running mean or just daily? Pentad-mean is the standard MJO research choice; we'd go pentad.

## Phase 3 — Wheeler–Kiladis filtered CCEW overlays (deferred, ~2–4 days)

**Goal:** four togglable contour overlays — Kelvin, equatorial Rossby (ER), mixed Rossby–gravity (MRG / TD-type), and MJO band — each showing the band-filtered OLR anomaly. This is what tells you "is the storm sitting on top of an active Kelvin wave right now?" — the question Phase 2 alone can't answer cleanly because raw OLR mixes all wave bands.

**Pipeline (`build_ccew_filtered_olr.py`):**
1. Pull NOAA Interpolated OLR for the last ~200 days (rolling window — WK filtering needs ~96–144 days of history for FFT-based decomposition with adequate edge handling).
2. Compute the 2D FFT in space–time (longitude × time) on equatorially-symmetric and antisymmetric components.
3. Mask to the canonical Wheeler–Kiladis 1999 dispersion bands for each wave (Kelvin: k > 0, ω/k = ~12–25 m/s; ER: k < 0, 9–48 d; MRG: |k| < 0, 3–8 d antisymmetric; MJO: k = 1–5, 30–96 d).
4. Inverse FFT → filtered OLR(lat, lon, time) per wave.
5. Save the most recent timestep as a PNG/GeoTIFF tile. Refresh daily.

**Validation:**
- Cross-check Kelvin output against Ventrice 2018 Atlantic AKWI events
- Verify the MJO filtered field tracks the RMM amplitude (correlation > 0.85 expected)

**Frontend:**
- Four new layer toggles in the RT Monitor's environment menu: "Convective forcing → MJO / Kelvin / ER / MRG"
- Contour rendering: GeoJSON contours (use Plotly's contour generation server-side or `d3-contour` on the fly client-side)
- Color: ±W/m² diverging palette, suppressed = warm color (active convection)

**Open questions for Phase 3:**
1. Filtering window: do we use 144 d (full Wheeler–Kiladis) or 96 d (sharper temporal cutoff at the cost of edge effects)?
2. Symmetric-only OLR or sym + antisym for MRG? Standard practice is sym for Kelvin/ER/MJO and antisym for MRG/IG.
3. Do we need to taper the temporal endpoint? Roundy's method uses a different windowing approach that's more robust for real-time end-of-window estimates.

## Phase 1 deliverable specifics (this session)

- **File touched:** [realtime_ir.html](realtime_ir.html), [realtime_ir.js](realtime_ir.js), [realtime_ir_styles.css](realtime_ir_styles.css)
- **New widget:** `<div id="rt-subseasonal-state">` — sidebar panel, collapsible
- **JS module:** new section in realtime_ir.js, lazy-load `data/subseasonal_phases.json`, render four small phase-clock SVGs
- **Phase clock SVG:** 240 × 240, 8 sectors, current dot + 7-day fading track. Sectors labeled with regional callouts. Amplitude ≥ 1 colored, amplitude < 1 grayed.
- **Telemetry:** `ga('rt_subseasonal_state_open', {mode, phase, amp})`

Defers: the actual OLR overlay (Phase 2), the WK contour overlays (Phase 3). Both blocked on the backend pipeline.

## Why this staging makes sense

Phase 1 gives users immediate subseasonal context on the live page — "the MJO is in Phase 4 right now, active phase for WPac genesis" — without any pipeline risk. It's the most-used widget in operational MJO monitoring (BoM's MJO Wheel is exactly this).

Phase 2 unlocks the "where's the active convection" question without committing to wave-band filtering. Users can already infer Kelvin/ER position from the raw anomaly with practice.

Phase 3 is the proper answer to the Kelvin contour question. It's blocked on the FFT-filtering pipeline being deployed and validated, which is real research-grade infrastructure.

By doing it in stages, we ship value at every step and the user can validate the direction before we commit to Phase 3's heavier investment.
