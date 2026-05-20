# Subseasonal — MJO 14-day forecast trail (BLOCKED: data source)

**Goal.** Extend each MJO/BSISO phase clock on the RT Monitor's Subseasonal
tab with a dashed 14-day model-forecast trail, so operational forecasters
can see *where* the MJO is heading — "is it about to enter Phase 1
(Atlantic-favorable) by week 2?" — without leaving the page.

**Status.** Frontend rendering path is straightforward (mirror the
existing 15-day observed trail in `subseasonal_clock.js`, drawn dashed
instead of solid). Blocker is the **data source**: BoM no longer hosts
the `rmm.ECMWFforecast.txt` URL the historical implementations relied
on (404 as of 2026-05-19), and NOAA CPC only publishes PNG forecast
plumes from GEFS — no machine-readable RMM trajectory.

## Candidate sources to evaluate

1. **ECMWF S2S API** (ext-mjo-rt or equivalent product).
   - Pros: gold standard, daily 46-day deterministic + ensemble.
   - Cons: registration required, ToS forbids public re-distribution of
     raw forecast values. May be OK for inline display + caching.
   - Contact: <https://apps.ecmwf.int/datasets/data/s2s-realtime-instantaneous-accum-ecmf/>
2. **NCEP GEFS RMM** via NOMADS BUFR or operational GRIB.
   - Pros: free, US gov, no ToS issues.
   - Cons: not exposed as a clean RMM CSV — derived in-house at CPC and
     only PNG'd to the public. Would need to compute RMM from raw GEFS
     OLR + u200 + u850, projecting onto Wheeler-Hendon EOFs ourselves.
     ~1 hr of cron compute per day; non-trivial but feasible. CPC
     publishes the projection EOFs at
     `https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/proj.txt`
     (when up).
3. **APEC Climate Center (APCC)** S2S aggregator.
   - Pros: aggregates multi-model RMM forecasts.
   - Cons: registration required, less reliable uptime.
4. **NCAR Climate Data Guide / IRI Columbia** — likely just verification,
   not real-time forecasts.

## Recommended path

Compute RMM in-house from GEFS reforecasts: the env-overlay cron already
fetches GFS analyses, and extending it to pull the GEFS ensemble mean
forecast for 200/850 hPa zonal wind + OLR is a moderate addition. The
project of (u200_anom, u850_anom, OLR_anom) onto Wheeler-Hendon EOFs is
~100 lines of Python and the EOFs themselves are static (publishable as
a small NumPy `.npz`). Output: extend the existing
`subseasonal_phases.json` payload with a per-mode `forecast_phases` and
`forecast_amplitudes` array covering today + 14 days.

## Frontend skeleton (when source lands)

`subseasonal_clock.js`:
* Read `modeRec.forecast_phases` / `forecast_amplitudes` if present.
* Render a dashed polyline in a slightly lighter shade of the trail
  color, starting at today's PC1/PC2 and ending at +14 d.
* Hover-only tooltips per forecast point, distinguishable from observed.
* Same amplitude-1 ring; forecast trail honors the same active/quiescent
  rule as observed.

No backend changes needed once the JSON has the two extra arrays.

## Cost

* GFS analysis: already in env-overlay cron.
* GEFS forecast fetch: +~20 MB/day, +~30 s cron time.
* Storage: +500 bytes/day on `subseasonal_phases.json` (~14 floats × 2 × 4 modes).
* GCS bandwidth: trivial.

## To-do for the user

Pick a forecast source from the candidate list above. The
"compute-from-GEFS-EOFs" path is the most portable but the largest
implementation lift. The ECMWF S2S path is fastest if you're willing to
accept the registration overhead.
