# PLAN — Daily view for Panel B of the RT Monitor → Seasonal tab

Status: **spec, pending review**
Touches: `realtime_seasonal.js`, `realtime_ir.html`, `build_oisst_history.py`
(new helpers), `build_seasonal_diagnostics.py` (one tiny addition), GCS
blobs under `gs://tc-atlas-ir-cache/seasonal/`.

## 1 · What the user gets

A **Monthly | Daily** toggle on Panel B's existing controls (next to
Region / Variable / History / Highlight-year). When Daily is selected:

- X-axis: day-of-year 1…366, tick-labeled with month names at DOY
  `[1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]`
  (Jan 1, Feb 1, … Dec 1 in a non-leap-year reference frame; leap-year
  values for years with a Feb 29 are placed at their natural DOY of 60).
- Traces (mirroring the monthly look exactly):
  - **1991-2020 ±1σ envelope** — light-green fill of (mean ± std)
    computed per DOY from finalized OISST.
  - **1991-2020 mean** — heavier green line.
  - **Historical years 1982–present** — thin light-gray spaghetti
    (one polyline per year), drawn when `History ≠ none` and the
    per-region all-years blob has loaded.
  - **Highlight year** — bold blue line, fetched on demand.
  - **Current year so far** — bold orange line, with a translucent
    "preliminary tail" segment for the last ~2 days (OISST's near-real-time
    values may flip once NOAA finalizes the corresponding day's grid).
- Variable selector keeps the four current options:
  `sst` (absolute), `anom` (vs 1991-2020), `sst_dt` (detrended), and
  `sst_rel` (Vecchi-Soden relative). See §2c for how each is computed
  daily.
- Reuses `_addPlotSaveBtn('seasonal-panel-timeseries', 'seasonal-ts-plot',
  'seasonal_region_timeseries')` unchanged.
- Title becomes "{Region} — daily {variable}".

## 2 · Data prep

There are exactly **two new blobs**, both built once and never rebuilt:

### 2a · `indices_daily_full.parquet` (1982 → most-recent finalized day)

One-time backfill, run **locally** off
`/Users/mfischer/Data/OISST_daily/` (the `OISST_LOCAL_CACHE` already
populated by `build_oisst_history._download_oisst_year`). OPeNDAP is
unreliable for chunked reads at this size; the local `sst.day.mean.{year}.nc`
files are ~120 MB each and the full 44-year set is ~5 GB, already on
disk for years that have been touched.

**Schema** (same as `indices_daily_current_year.parquet`, just stretched):

| col                  | type    | notes                                  |
|----------------------|---------|----------------------------------------|
| `date`               | string  | `YYYY-MM-DD`                           |
| `{region}_sst`       | float32 | for each of 14 regions in `REGIONS`    |
| `{region}_anom`      | float32 | sst − climatology(month → DOY)         |
| `{region}_anom_rel`  | float32 | Vecchi-Soden: anom − 30°S-30°N anom    |

Row count ≈ 44 × 365.25 ≈ 16,074 (~16k).
Column count ≈ 1 + 14 × 3 = 43.
Parquet snappy-compressed estimate: **~1.5–2.5 MB**.

The backfill script is implemented as a new function
`build_daily_indices_full()` in `build_oisst_history.py` that:

1. Iterates years 1982 → current-year (or `--year-end`).
2. For each year: `_open_oisst_year(year)` → DataArray (time, lat, lon),
   subset to `LAT_MIN..LAT_MAX × LON_MIN..LON_MAX`.
3. Interpolates the 12-month climatology to each day's date with the
   existing helper `_interp_month_climatology` (used today by
   `compute_today_indices`). Yields `anom`.
4. Computes `_tropical_mean_sst(sst)` per day → 1D `(n_time,)`. Subtract
   from `anom` → `anom_rel`.
5. For every (region, day): area-weighted `_region_mean` to fill a row.
6. Appends to a growing list, writes parquet once per year (idempotent
   resume: skip a year whose rows are already present and complete).

**Idempotency / resume**: on startup, if `indices_daily_full.parquet`
exists, read it, find `years_already_complete = years whose row count
equals (365 or 366)`, skip those. Resumable by year, not by day, since
restarting mid-year wastes seconds, not hours.

**Wall-time estimate**: ~5–10 s/year × 44 years ≈ **3–8 minutes** on
the user's laptop with files already cached locally; longer the first
time per year, since `_download_oisst_year` would pull anything missing
from PSL.

Upload to `gs://tc-atlas-ir-cache/seasonal/indices_daily_full.parquet`
with `publicRead`. (Same blob ACL pattern as the deploy_seasonal_job
fix that already landed.)

### 2b · `clim_daily_1991_2020.json`

Per-region, per-DOY mean + std across the 1991–2020 climatology window.
Built **directly from the same 30-year slice of `indices_daily_full`**
once that's written — no separate pass over the gridded OISST file.

**Smoothing**: a 7-day centered rolling mean is applied to the per-DOY
mean and std after they're computed, with circular wrap at the
DOY-1/DOY-366 boundary so January 1 and December 31 share neighbors.
Reason: raw daily climatology over only 30 samples is visibly ragged
(a single warm Jan 14 in 1998 leaves a 0.1 °C bump); 7-day smoothing
matches the visual smoothness of the monthly envelope without losing
the seasonal cycle. **The smoothing is documented in the panel
hovertemplate**: `"1991-2020 ±1σ (7-day smooth)"`.

**Schema** (compact, JSON):

```json
{
  "version": 1,
  "doys": [1, 2, ..., 366],
  "regions": ["atl_basin", "atl_mdr", ...],
  "smoothing": "7-day-rolling-circular",
  "values": {
    "atl_mdr": {
      "sst":         { "mean": [366 floats], "std": [366 floats] },
      "anom":        { "mean": [366 floats], "std": [366 floats] },
      "sst_rel":     { "mean": [366 floats], "std": [366 floats] }
    },
    ...
  }
}
```

Size: 14 regions × 3 vars × 2 (mean/std) × 366 ≈ 30 k floats.
JSON pretty-printed ≈ 400 KB; minified ≈ 300 KB; gzipped on the wire
**≈ 60–90 KB**.

(`sst_dt` is handled separately — see §2c — and does not live in this
blob.)

### 2c · Detrended variant (`sst_dt`)

The monthly Panel B supports `sst_dt`. To match on the daily view we
need a per-DOY linear-in-year trend. Built once as a third blob:

`trend_daily_1982_present.json` — for every (region, DOY), the linear
regression slope (°C/yr) and intercept fit across years 1982 →
(current_year − 1) of the raw daily SST. Detrended value at
(year, DOY) = `sst(year, DOY) − (slope[DOY] · year + intercept[DOY])`.

Schema: `{ region: { sst: { slope: [366], intercept: [366] } } }`.
Size ≈ 14 × 2 × 366 ≈ 10 k floats → ~30 KB JSON, ~10 KB gzipped.

Also 7-day-circular-smoothed so the trend coefficients don't have
day-of-year jitter from the same 30-sample roughness issue.

### 2d · Steady state (no change)

`build_seasonal_diagnostics.py` continues to append one row per day to
`indices_daily_current_year.parquet` as it does today. **One small
addition**: after the parquet append, also write a JSON sidecar
`indices_daily_current_year.json` (same content, no parquet-in-browser
dependency). ~30–50 KB compact, ~10–15 KB on the wire.

The full-history and climatology blobs **never rebuild** unless we
extend the climatology period or detect a year-boundary roll. (The
trend blob should be refit at the start of each new year — a one-line
cron in the daily job, or a manual rerun.)

## 3 · Frontend changes (`realtime_seasonal.js`)

### 3a · State + controls

Add to `state.ts`:
```js
ts: {
  region: 'atl_mdr',
  variable: 'sst',
  history: 'all',
  highlight: 'none',
  resolution: 'monthly',   // NEW: 'monthly' | 'daily'
}
```

Add to `realtime_ir.html` inside `.seasonal-ts-controls` (line ~893):

```html
<label>Resolution
  <select id="seasonal-ts-resolution">
    <option value="monthly" selected>Monthly</option>
    <option value="daily">Daily</option>
  </select>
</label>
```

Wire it in `_bindTimeSeriesControls` (line ~1126) via the same `bind(id, key)`
pattern.

### 3b · New module-level cache

```js
var _dailyCache = {
  clim: null,            // clim_daily_1991_2020.json (small, fetched once)
  trend: null,           // trend_daily_1982_present.json (small, fetched once)
  currentYear: null,     // indices_daily_current_year.json (small)
  highlightYears: {},    // { 2005: { date:[], sst:[], anom:[], ... }, ... }
  regionAll: {},         // { atl_mdr: { years:[], data:{sst:[44×366], ...} } }
};
```

Highlight-year and regionAll lookups slice from the full parquet only
once the user opts in. The parquet stays on GCS — we **don't** ship a
JS parquet reader. Instead, we add an API endpoint that slices the
parquet server-side and returns JSON.

#### `/seasonal/daily?region=atl_mdr&year=2005` (NEW)

Backend: a new route in `ir_monitor_api.py` that:

- Reads `indices_daily_full.parquet` from GCS on first request, caches
  the resulting DataFrame in-process for 24 h. Cold-start parquet load
  is ~1–2 s (~2 MB blob, ~16 k rows).
- Accepts `region=<name>` (required) and `year=<int>|all` (default:
  the requested year only).
- Returns `{ region, year, date: [...], sst: [...], anom: [...],
  sst_rel: [...] }` (or, for `year=all`, the same shape with all
  years concatenated and `year` set to `"all"`).
- Sets `Cache-Control: public, max-age=3600` since the historical
  parquet only changes when the year rolls.

**Why API over static-on-GCS** (the path we picked):

- One source-of-truth blob. The parquet is the only thing the
  backfill writes; we don't ship 14 derived region JSONs that need
  to stay in sync when the climatology window or region list
  changes.
- Flexible query surface for future seasonal-tab features (multi-year
  overlays, custom climo windows, server-side LOESS detrend, joining
  daily SST with MJO/BSISO/ENSO indices). With static JSONs, every
  new slicing dimension becomes a new derived blob.
- Aligns with how the rest of the Seasonal tab is built — analogs,
  distance matrices, correlations all go through the API today.

Bandwidth per highlight-year click: 1 year × 365 × 3 vars × ~7 chars
≈ 8 KB → ~3 KB gzipped.

For `year=all` (full region spaghetti): 44 × 365 × 3 ≈ 350 KB →
~70 KB gzipped.

### 3c · Render function

Add `_buildDailyTimeSeriesData()` mirroring `_buildTimeSeriesData()`
but bucketed by DOY instead of month. Add `_renderTimeSeriesDaily()`
mirroring `_renderTimeSeries()`. The existing `_renderTimeSeries`
becomes a router:

```js
function _renderTimeSeries() {
  if (state.ts.resolution === 'daily') return _renderTimeSeriesDaily();
  return _renderTimeSeriesMonthly();   // (rename of current body)
}
```

The daily render path:

1. If `_dailyCache.clim` is null, fetch `clim_daily_1991_2020.json`
   and (lazily) `trend_daily_1982_present.json` — block render until
   both resolve, show status "Loading daily climatology…".
2. If `_dailyCache.currentYear` is null, fetch
   `indices_daily_current_year.json`.
3. Build envelope traces from `clim.values[region][variable]`.
   For `sst_dt`: compute detrended series on the fly from
   `cache.currentYear` + `trend.values[region].sst` (anom climatology
   for sst_dt is identically zero in expectation; we draw a flat
   zero-line envelope of std-of-detrended derived from the trend
   blob — added to the trend JSON: `{ region: { sst: { detrended_std:
   [366] } } }` precomputed once at backfill time so the daily
   render does no regression in the browser).
4. If `state.ts.history === 'all'` and `_dailyCache.regionAll[region]`
   isn't cached, fetch `indices_daily_region_<region>.json`.
   Push one trace per year (with `legendgroup: 'history'` so the legend
   stays one entry — same trick as monthly).
5. If `state.ts.highlight !== 'none'` and the highlighted year isn't
   in `_dailyCache.highlightYears`, fetch from regionAll (we already
   have it loaded) OR request its slice. Either way: bold blue trace.
6. Current-year orange line from `cache.currentYear`. Last 2 rows of
   the array are drawn with a lighter orange + dotted style as the
   "preliminary tail" — OISST's most recent 1–2 days flip on
   reprocessing. Annotate the legend entry: `"2026 (so far; last 2
   days preliminary)"`.

### 3d · Save-as-PNG

Already wired by the existing
`_addPlotSaveBtn('seasonal-panel-timeseries', 'seasonal-ts-plot',
 'seasonal_region_timeseries')` call in `_activate` (line 2385). No
changes — `Plotly.downloadImage` will capture the new render exactly
as drawn, and the existing theme-flip / restore dance carries over.

## 4 · Bandwidth and storage budget

| Asset                                       | Size on GCS | Wire (gzip) | When fetched                          |
|---------------------------------------------|-------------|-------------|---------------------------------------|
| `indices_daily_full.parquet`                | ~2 MB       | n/a         | API cold-start only (read by Cloud Run) |
| `clim_daily_1991_2020.json`                 | ~300 KB     | ~80 KB      | First Daily render (direct from GCS)  |
| `trend_daily_1982_present.json`             | ~30 KB      | ~10 KB      | First Daily render (direct from GCS)  |
| `indices_daily_current_year.json`           | ~50 KB      | ~15 KB      | First Daily render (direct from GCS)  |
| `/seasonal/daily?region=X&year=all` (API)   | —           | ~70 KB      | When user sets History=All for region X |
| `/seasonal/daily?region=X&year=Y` (API)     | —           | ~3 KB       | When user picks highlight year Y in region X |

**Per-page-load cost** (Daily toggled, default region atl_mdr, default
History=All, no highlight year selected):
- Clim + trend + current-year (direct GCS): 80 + 10 + 15 = ~105 KB.
- All-years for atl_mdr (API): ~70 KB.
- **Total ≈ 175 KB** on the wire.

Switching region: **~70 KB** to call `/seasonal/daily?region=<new>&year=all`
(if History=All; else 0). Switching variable, on the other hand, costs 0
— all three vars are in the same payload.

For comparison: the monthly Panel B today pulls `indices_monthly.json`
≈ 400 KB → ~50 KB gzipped. The daily view doubles this on first paint
and is region-local thereafter.

## 5 · Risks and mitigations

### 5a · Parquet-in-browser

`apache-arrow` JS + parquet wasm shim is ~1 MB minified and adds a
build step we don't have. **Mitigation**: never ship parquet to the
browser; convert the slice the frontend needs to JSON at build time
(per-region all-years JSONs) and at append time (current-year JSON
sidecar). Parquet stays the source-of-truth storage format.

### 5b · OISST preliminary flips

PSL's `sst.day.mean.{year}.nc` exposes new days within hours of valid
time, but those days can change values for ~1–2 days as the analysis
ingests more buoy/ship/Argo. **Mitigation**: render the last 2 days
of the current-year curve in a dotted half-opacity orange style, with
the legend entry calling it out. Same pattern as the existing
"preliminary month-to-date" star markers on the monthly view.

### 5c · Leap-year handling

The 1991–2020 climatology has 7 leap years contributing values at
DOY 60 (Feb 29) and 23 non-leap years not contributing. We resolve
this in **two passes**:

1. Build `mean[DOY]` and `std[DOY]` from whichever years contributed
   a value on that DOY (so DOY 60 averages over 7 years; all other
   DOYs average over 30).
2. Apply the 7-day circular rolling smoother. The Feb-29 point now
   blends with Feb 26–Mar 3 so its sample-size jump doesn't show as
   a visual notch.

For the current-year x-axis labeling, ticks are placed at:
- `[1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]` for leap
  years.
- `[1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]` minus 1
  for DOYs ≥ 60 in non-leap years.

Implementation detail: we always plot non-leap data on its natural
DOY (skipping DOY 60 for those years) and plot leap data including
DOY 60. Plotly handles missing values via gaps. We **do not**
collapse the calendar; user-facing semantics are "March 1 = March 1"
regardless of leap.

### 5d · 14 vs 15 regions

The task brief says "every region in REGIONS" implies 15; the actual
`REGIONS` dict in `build_oisst_history.py:100-120` has 14 entries
(atl_basin, atl_mdr, atl_mdr_east, atl_amo, caribbean, gulf, nta, tsa,
epac_mdr, wpac_mdr, nino12, nino3, nino34, nino4). Sticking with the
14 in code; flagging here in case I'm missing one.

### 5e · `sst_dt` semantics on the daily axis

The monthly `sst_dt` is the deviation from a linear-in-year fit
performed at monthly resolution. On daily, two valid framings exist:

- **Per-DOY linear trend** (recommended): fit slope+intercept of
  `sst(year, DOY)` vs `year` independently for each DOY. Yields a
  smooth seasonal trend pattern. Matches a "deseasonalized warming
  signal" view.
- **Annual-mean trend applied uniformly**: shift each day by a single
  year-dependent offset. Equivalent to monthly `sst_dt` if the user
  spot-checks Jan 1.

The recommended choice (per-DOY) generalizes the monthly behavior
naturally — at month-end the per-DOY fit averaged over DOYs in that
month equals the monthly fit. Documented in the hover label so the
user knows what they're looking at.

## 6 · Sequencing of work

Once the user OKs this spec:

1. **Backfill script** — add `build_daily_indices_full(out_path, …)`
   to `build_oisst_history.py`, plus `build_daily_climatology(…)`
   and `build_daily_trend(…)` helpers operating on the full parquet.
   Add a `--step daily_full` CLI option. Idempotent / resumable as
   described in §2a.
2. **Sidecar JSON in the daily job** — one ~10-line addition in
   `build_seasonal_diagnostics.py:append_to_daily_parquet` to also
   write `indices_daily_current_year.json` after the parquet write.
3. **API endpoint** — new `/seasonal/daily` route in
   `ir_monitor_api.py` that lazy-loads the parquet from GCS,
   caches the DataFrame in-process for 24 h, and serves
   `{region, year}` slices.
4. **GCS upload** — extend `upload_to_gcs` to include the new
   blobs (`indices_daily_full.parquet`, `clim_daily_1991_2020.json`,
   `trend_daily_1982_present.json`) with `publicRead` ACL, matching
   the cron-fix pattern.
5. **Frontend** — HTML control, JS toggle, fetch + cache, render
   function, leap-day handling, preliminary-tail styling.
6. **Smoke test** — load the page, toggle Daily, verify envelope
   shape, change region, change variable, pick a highlight year,
   save PNG, check the saved figure matches the live theme.

## 7 · What I will NOT do without further confirmation

- Run any backfill against the user's local OISST cache.
- Upload anything to `gs://tc-atlas-ir-cache/seasonal/`.
- Run `gcloud run jobs deploy` or `deploy.sh`.
- Restructure existing blobs (the monthly Panel B keeps working
  unchanged; this is purely additive).

— end of spec —
