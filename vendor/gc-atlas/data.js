// Field provider for the globe.
//
// getField() first asks the ERA5 tile loader (js/era5.js); if the tile isn't
// cached yet, it returns the synthetic placeholder below and the loader
// triggers a background fetch — when it completes, the loader fires an event
// and the caller re-renders.
//
// The synthetic fields produce pedagogically plausible shapes (mid-latitude
// jets, Hadley return, stationary waves, subtropical highs). They exist so
// the renderer works offline / before real tiles are staged.

import { requestField as requestEra5, availableLevels, cachedMonth, getManifest } from './era5.js';

// Does the manifest for `period` carry pipeline-materialised std tiles for
// this derived field? Used to un-gate σ-anom on wspd / mse / dls once the
// tiles built by pipeline/build_derived_std.py are pushed to GCS — older
// trees without those tiles keep falling back to mean.
function derivedHasPipelineStd(name, period) {
    const m = getManifest(period === 'default' ? 'default' : period);
    if (!m) return false;
    for (const g of Object.values(m.groups)) {
        const v = g[name];
        if (v && v.has_std) return true;
    }
    return false;
}

// Does the active period's manifest carry σ tiles for this field?
// Used by the UI to disable the σ-anom button when it would silently
// fall back to mean (the default 1991-2020 tree is missing std for
// 8 pressure-level raw vars; derived vars rely on build_derived_std.py).
// Returns true optimistically when the manifest isn't loaded yet so we
// don't disable the control during the initial page paint.
/**
 * Estimate how many ERA5 tile fetches the current view needs for its
 * first paint. Used by the loading overlay to show an honest "X of Y"
 * counter. Based on static field/ingredient logic (FIELDS metadata,
 * θ-cube stack, σ-anom std tile, contour overlay, composite year
 * count) rather than live in-flight tiles — which drift as downstream
 * aggregation kicks in. This is therefore a FLOOR on the load, not
 * an exact total; background cross-month aggregation may add more
 * after the overlay has already hidden on first paint.
 */
export function expectedTilesForView(state) {
    const { field, vCoord, decompose, kind, contourField, customRange, referencePeriod } = state || {};
    const meta = FIELDS[field];
    if (!meta) return 1;

    const N_LEVELS = 12;
    const isTheta = vCoord === 'theta' && meta.type === 'pl';
    const perIngredient = isTheta ? N_LEVELS : 1;

    // Ingredient count by field type for the PRIMARY view (the thing that
    // makes f.isReal go true and hides the overlay). Wind-overlay tiles
    // and background cross-month aggregation load in parallel but don't
    // gate first paint, so they're intentionally excluded here — the
    // display Y grows upward in setLoadingProgress if actual in-flight
    // exceeds this floor, so no undercount visible to the user.
    let ingredients;
    let needsTCube = isTheta;
    if (meta.type === 'sl') {
        ingredients = 1;
        needsTCube = false;
    } else if (field === 'pv') {
        ingredients = 1;
    } else if (field === 'wspd') {
        ingredients = 2;
    } else if (field === 'mse') {
        ingredients = 3;
        needsTCube = false;
    } else if (field === 'dls') {
        return 2;
    } else {
        ingredients = 1;
        if (isTheta && field === 't') needsTCube = false;
    }

    let n = ingredients * perIngredient;
    if (needsTCube) n += N_LEVELS;

    if (decompose === 'zscore' || kind === 'std') n += 1;
    if ((decompose === 'anomaly' || decompose === 'zscore')
        && referencePeriod && referencePeriod !== 'default' && referencePeriod !== 'best-match') {
        n += ingredients * perIngredient;
    }
    if (contourField) n += 1;
    if (customRange?.years?.length) {
        const monthMultiplier = (Array.isArray(customRange.months) && customRange.months.length)
            ? customRange.months.length : 1;
        n += customRange.years.length * monthMultiplier * ingredients;
    }
    return Math.max(1, n);
}

/**
 * Returns true iff every raw ERA5 tile needed to compute `name` at
 * (month, level, coord, theta) is already in cache. NEVER triggers
 * fetches. Used by aggregatedDecompositionRange's cross-month callback
 * so peeking at not-yet-cached months doesn't leak ~11 needless tile
 * fetches per batch (buildThetaCube / requestEra5 in the compute path
 * kick off a fetch and THEN return null on the first miss, leaving
 * pointless work in flight).
 */
export function hasCachedIngredients(name, { month, level, coord = 'pressure', theta = 330, year = null, customRange = null } = {}) {
    const meta = FIELDS[name];
    if (!meta) return false;
    // Composites compute off per-year tiles; skip the cache check for
    // aggregation purposes (composite paths have their own logic).
    if (customRange?.years?.length) return false;
    const period = year != null ? 'per_year' : 'default';
    const has = (n, lvl) => !!cachedMonth(n, month, lvl, 'mean', period, year);

    if (meta.type === 'sl') return has(name, null);

    const isTheta = coord === 'theta';
    if (isTheta) {
        // θ-coord views need T at every pressure level for the θ cube,
        // plus the specific field's ingredient stacks.
        for (const L of LEVELS) if (!has('t', L)) return false;
        if (name === 'pv') {
            for (const L of LEVELS) if (!has('pv', L)) return false;
        } else if (name === 'mse') {
            for (const L of LEVELS) { if (!has('z', L) || !has('q', L)) return false; }
        } else if (name === 'wspd') {
            for (const L of LEVELS) { if (!has('u', L) || !has('v', L)) return false; }
        } else if (name === 'dls') {
            for (const L of [200, 850]) { if (!has('u', L) || !has('v', L)) return false; }
        } else if (name !== 't') {
            for (const L of LEVELS) if (!has(name, L)) return false;
        }
        return true;
    }
    // Pressure coord at a specific level.
    if (name === 'wspd') return has('u', level) && has('v', level);
    if (name === 'mse')  return has('t', level) && has('z', level) && has('q', level);
    if (name === 'dls')  return has('u', 200) && has('v', 200) && has('u', 850) && has('v', 850);
    if (name === 'pv')   return has('pv', level);
    return has(name, level);
}

export function fieldHasStdTiles(field, period) {
    const m = getManifest(period === 'default' ? 'default' : period);
    if (!m) return true;
    for (const g of Object.values(m.groups || {})) {
        if (field in g) return !!g[field].has_std;
    }
    // Derived fields aren't in any group's raw-variable list — fall
    // back to the derived-std check.
    return derivedHasPipelineStd(field, period);
}

export const GRID = { nlat: 181, nlon: 360 };
export const LEVELS = [10, 50, 100, 150, 200, 250, 300, 500, 700, 850, 925, 1000];
export const THETA_LEVELS = [280, 300, 315, 330, 350, 400, 500, 700];
export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Per-field colorbar policy:
//   symmetric: true  → vmin/vmax forced to ±max(|vmin|,|vmax|) so RdBu_r
//                      paints zero white. Apply to fields whose physical
//                      interpretation is "warm = +, cool = −".
//   clamp: {lo, hi}  → per-tile percentile clamp in [0,1]. Kills outliers
//                      from below-ground extrapolation under high terrain
//                      (Tibet, Antarctica, Andes) at low pressure levels,
//                      and from isolated convective spikes (precip, ω).
export const FIELDS = {
    t:    { type: 'pl', group: 'Dynamics',           name: 'Temperature',              units: 'K',       cmap: 'turbo',   defaultLevel: 500, contour: 10, clamp: { lo: 0.005, hi: 0.995 } },
    u:    { type: 'pl', group: 'Dynamics',           name: 'Zonal wind (u)',           units: 'm s⁻¹',   cmap: 'RdBu_r',  defaultLevel: 200, contour: 10, symmetric: true },
    v:    { type: 'pl', group: 'Dynamics',           name: 'Meridional wind (v)',      units: 'm s⁻¹',   cmap: 'RdBu_r',  defaultLevel: 200, contour: 5, symmetric: true },
    wspd: { type: 'pl', group: 'Dynamics',           name: 'Wind speed (|V|)',         units: 'm s⁻¹',   cmap: 'turbo',   defaultLevel: 200, derived: true, contour: 10 },
    vo:   { type: 'pl', group: 'Dynamics',           name: 'Relative vorticity (ζ)',   units: '10⁻⁵ s⁻¹', cmap: 'RdBu_r', defaultLevel: 500, contour: 2,  clamp: { lo: 0.03, hi: 0.97 }, symmetric: true },
    d:    { type: 'pl', group: 'Dynamics',           name: 'Horizontal divergence',    units: '10⁻⁵ s⁻¹', cmap: 'RdBu_r', defaultLevel: 200, contour: 1,  clamp: { lo: 0.03, hi: 0.97 }, symmetric: true },
    w:    { type: 'pl', group: 'Dynamics',           name: 'Vertical velocity (ω)',    units: 'Pa s⁻¹',  cmap: 'RdBu_r',  defaultLevel: 500, contour: 0.05, clamp: { lo: 0.05, hi: 0.95 }, symmetric: true },
    z:    { type: 'pl', group: 'Dynamics',           name: 'Geopotential height',      units: 'm',       cmap: 'viridis', defaultLevel: 500, contour: 60, clamp: { lo: 0.005, hi: 0.995 } },
    psi:  { type: 'pl', group: 'Dynamics',           name: 'Streamfunction (ψ)',       units: '10⁶ m² s⁻¹', cmap: 'RdBu_r', defaultLevel: 200, contour: 20, symmetric: true },
    chi:  { type: 'pl', group: 'Dynamics',           name: 'Velocity potential (χ)',   units: '10⁶ m² s⁻¹', cmap: 'RdBu_r', defaultLevel: 200, contour: 2, symmetric: true },
    q:    { type: 'pl', group: 'Moisture',           name: 'Specific humidity',        units: 'g kg⁻¹',  cmap: 'thalo',   defaultLevel: 850, contour: 2, clamp: { lo: 0.0, hi: 0.99 } },
    r:    { type: 'pl', group: 'Moisture',           name: 'Relative humidity',        units: '%',       cmap: 'thalo',   defaultLevel: 700, contour: 10, clamp: { lo: 0.0, hi: 0.995 } },
    pv:   { type: 'pl', group: 'Derived & PV',       name: 'Ertel PV',                 units: 'PVU',     cmap: 'RdBu_r',  defaultLevel: 330, contour: 1, derived: true, thetaOnly: true, symmetric: true },
    mse:  { type: 'pl', group: 'Derived & PV',       name: 'Moist static energy (h/c_p)', units: 'K',    cmap: 'magma',   defaultLevel: 850, contour: 5, derived: true, clamp: { lo: 0.005, hi: 0.995 } },
    t2m:  { type: 'sl', group: 'Surface',            name: '2-m temperature',          units: 'K',       cmap: 'turbo',   contour: 5 },
    d2m:  { type: 'sl', group: 'Surface',            name: '2-m dewpoint',             units: 'K',       cmap: 'turbo',   contour: 5 },
    sst:  { type: 'sl', group: 'Surface',            name: 'Sea surface temperature',  units: 'K',       cmap: 'turbo',   contour: 2 },
    msl:  { type: 'sl', group: 'Surface',            name: 'Mean sea-level pressure',  units: 'hPa',     cmap: 'plasma',  contour: 4 },
    // Deep-layer shear: |⟨V_200⟩ − ⟨V_850⟩|, magnitude of the difference of
    // the monthly-mean wind vectors at 200 hPa minus 850 hPa. Useful for TC
    // genesis climatology (Gray 1968) but UNDERESTIMATES instantaneous
    // shear because the magnitude of the mean vector ≤ the mean of the
    // magnitudes (Jensen). For operational TC work prefer ⟨|V_200−V_850|⟩
    // computed from daily winds.
    dls:  { type: 'sl', group: 'Derived & PV',       name: 'Deep-layer shear (mean-flow)', units: 'm s⁻¹', cmap: 'magma',   contour: 5, derived: true,
            note: '|⟨V₂₀₀⟩ − ⟨V₈₅₀⟩| from monthly-mean winds. Underestimates the climatology of instantaneous shear (Jensen) — for TC-genesis thresholds use a daily-resolved product.' },
    mpi:  { type: 'sl', group: 'Derived & PV',       name: 'Max potential intensity',     units: 'm s⁻¹', cmap: 'magma',   contour: 10,
            note: 'Bister-Emanuel 2002 maximum potential intensity (VMAX). Theoretical upper bound on TC wind speed given local SST + atmospheric profile (T, q at 14 levels). NaN over land and where the algorithm fails to converge.' },
    // Synthetic field — populated client-side by climatology_globe.js
    // when the user runs the Index Correlation panel. Values are Pearson r
    // in [-1, +1]; cells that fail the p-value threshold get NaN so the
    // engine renders them transparent. Hidden from the Field dropdown
    // (state.field is set programmatically by the correlation handler).
    corr: { type: 'sl', group: '_internal',          name: 'Index correlation (r)',       units: '',       cmap: 'RdBu_r',  contour: 0.2, hidden: true, symmetric: true,
            note: 'Per-pixel Pearson r against the chosen index time series. NaN cells fail the p-value threshold.' },
    sp:   { type: 'sl', group: 'Surface',            name: 'Surface pressure',         units: 'hPa',     cmap: 'plasma',  contour: 20, clamp: { lo: 0.005, hi: 0.995 } },
    blh:  { type: 'sl', group: 'Surface',            name: 'Boundary-layer height',    units: 'm',       cmap: 'plasma',  contour: 200 },
    tcwv: { type: 'sl', group: 'Moisture',           name: 'Precipitable water (TCWV)', units: 'kg m⁻²', cmap: 'thalo',   contour: 5 },
    tp:   { type: 'sl', group: 'Moisture',           name: 'Total precipitation',      units: 'mm day⁻¹', cmap: 'thalo',  contour: 2,  clamp: { lo: 0.0, hi: 0.99 } },
    ews:  { type: 'sl', group: 'Surface fluxes',     name: 'Eastward surface stress',  units: 'N m⁻²',  cmap: 'RdBu_r',  contour: 0.05, symmetric: true },
    sshf: { type: 'sl', group: 'Surface fluxes',     name: 'Surface sensible heat flux', units: 'W m⁻²', cmap: 'RdBu_r',  contour: 20, symmetric: true },
    slhf: { type: 'sl', group: 'Surface fluxes',     name: 'Surface latent heat flux',   units: 'W m⁻²', cmap: 'RdBu_r',  contour: 25, symmetric: true },
    ssr:  { type: 'sl', group: 'Surface fluxes',     name: 'Surface net SW radiation',   units: 'W m⁻²', cmap: 'plasma',  contour: 25 },
    str:  { type: 'sl', group: 'Surface fluxes',     name: 'Surface net LW radiation',   units: 'W m⁻²', cmap: 'RdBu_r',  contour: 10, symmetric: true },
    tisr: { type: 'sl', group: 'TOA',                name: 'TOA incoming solar',         units: 'W m⁻²', cmap: 'plasma',  contour: 50 },
    ttr:  { type: 'sl', group: 'TOA',                name: 'TOA net LW (OLR)',           units: 'W m⁻²', cmap: 'magma',   contour: 20 },
    // 10-m winds — surface-level u/v used by the particle/barb overlay when
    // a single-level field is displayed. Hidden from the field dropdown
    // (they're an overlay source, not a primary display field).
    u10:  { type: 'sl', group: '_internal',          name: '10-m zonal wind',            units: 'm s⁻¹', cmap: 'RdBu_r',  symmetric: true, hidden: true },
    v10:  { type: 'sl', group: '_internal',          name: '10-m meridional wind',       units: 'm s⁻¹', cmap: 'RdBu_r',  symmetric: true, hidden: true },
};

/** Fields that only make sense on isentropic surfaces. When user picks one of
 *  these, the vertical-coord toggle forces θ coordinates. */
export function isThetaOnly(name) { return !!FIELDS[name]?.thetaOnly; }

// ── lat/lon axes ─────────────────────────────────────────────────────────
const LATS = new Float32Array(GRID.nlat);
const LONS = new Float32Array(GRID.nlon);
for (let i = 0; i < GRID.nlat; i++) LATS[i] = 90 - i;
for (let j = 0; j < GRID.nlon; j++) LONS[j] = -180 + j;

// Pending-tile placeholder: all-NaN field. The colormap renders NaN as a
// neutral "no-data" colour (see colormap.js), so the user sees a muted
// globe for the split second before the ERA5 tile lands rather than a fake
// pattern that could be confused with the real data. Retired the
// per-variable synthetic generators — every tile exists on GCS now.
const PENDING_VALUES = new Float32Array(GRID.nlat * GRID.nlon);
PENDING_VALUES.fill(NaN);

function pendingField() {
    return { values: PENDING_VALUES, vmin: 0, vmax: 1 };
}

// ── Custom-range composite cache ──────────────────────────────────
// Browser-side mean of per-year tiles for an arbitrary [start, end] year
// range. The composite surfaces to the rest of the app as if it were a
// climatology — same values/vmin/vmax shape. Cache keyed by
// (name, level, month, start, end); entries persist across month-scrubs
// so users can scrub through a custom-window composite without refetching.
const _customRangeCache = new Map();
export function invalidateCustomRangeCache() { _customRangeCache.clear(); }

/** Return the year list implied by a customRange spec. Supports two
 *  shapes: a contiguous { start, end } range and an explicit
 *  { years: [...] } list. Used by the composer + the compose-relevance
 *  check in globe.js. */
export function customRangeYears(spec) {
    if (!spec) return [];
    if (Array.isArray(spec.years)) {
        return [...new Set(spec.years.filter(Number.isFinite))]
            .sort((a, b) => a - b);
    }
    if (Number.isFinite(spec.start) && Number.isFinite(spec.end)) {
        const out = [];
        for (let y = spec.start; y <= spec.end; y++) out.push(y);
        return out;
    }
    return [];
}

/** Stable cache-key suffix for a range/list spec. Separating the
 *  contiguous form ("2010-2024") from the explicit-year form
 *  ("y=1983,1998,2016,2024") avoids collisions. Multi-month composites
 *  append "|m=7,8,9" so JAS and the single-month-7 entries don't clash. */
function _spanKey(spec) {
    let base;
    if (Array.isArray(spec?.years)) {
        base = `y=${customRangeYears(spec).join(',')}`;
    } else {
        base = `${spec.start}-${spec.end}`;
    }
    if (Array.isArray(spec?.months) && spec.months.length) {
        base += `|m=${[...spec.months].sort((a, b) => a - b).join(',')}`;
    }
    return base;
}

/** Resolve the effective month list for a composite. If the spec carries
 *  an explicit months array, use it; otherwise fall back to the singleton
 *  month parameter (which is what every pre-multi-month caller passed). */
function _compositeMonths(spec, fallbackMonth) {
    if (Array.isArray(spec?.months) && spec.months.length) {
        return [...new Set(spec.months.filter(m => Number.isFinite(m) && m >= 1 && m <= 12))]
            .sort((a, b) => a - b);
    }
    return [fallbackMonth];
}

/** Compose a custom-range mean from per-year tiles. Returns
 *    { values, vmin, vmax, isReal: true }  when all tiles are cached,
 *    null when any is still loading (subscriber will re-call on arrival).
 *  `level` is the pressure level or null for single-level fields.
 *  `spec` is a { start, end } range OR a { years: [...] } list. When
 *  `spec.months` is provided, the composite averages over (years × months);
 *  otherwise the single `month` argument is used (back-compat). */
function composeCustomRangeMean(name, month, level, spec) {
    const years = customRangeYears(spec);
    if (years.length === 0) return null;
    const months = _compositeMonths(spec, month);
    const span = _spanKey(spec);
    // Cache key needs the singleton month too — when spec has no months[],
    // different fallback months must be cached separately.
    const monthTag = (Array.isArray(spec?.months) && spec.months.length)
        ? 'mm'             // multi-month: months baked into span via _spanKey
        : `m${month}`;     // single-month back-compat
    const key = level == null
        ? `${name}:sl:${monthTag}:${span}`
        : `${name}:${level}:${monthTag}:${span}`;
    const hit = _customRangeCache.get(key);
    if (hit) return hit;
    const { nlat, nlon } = GRID;
    const N = nlat * nlon;
    const sum = new Float32Array(N);
    const count = new Uint16Array(N);
    let anyMissing = false;
    for (const y of years) {
        for (const m of months) {
            const tile = requestEra5(name, {
                month: m, level, period: 'per_year', year: y, kind: 'mean',
            });
            if (!tile) { anyMissing = true; continue; }   // still loading
            const vals = tile.values;
            for (let i = 0; i < N; i++) {
                const v = vals[i];
                if (Number.isFinite(v)) { sum[i] += v; count[i] += 1; }
            }
        }
    }
    if (anyMissing) return null;
    const out = new Float32Array(N);
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < N; i++) {
        out[i] = count[i] > 0 ? sum[i] / count[i] : NaN;
        if (Number.isFinite(out[i])) {
            if (out[i] < vmin) vmin = out[i];
            if (out[i] > vmax) vmax = out[i];
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    const entry = { values: out, vmin, vmax, isReal: true };
    _customRangeCache.set(key, entry);
    return entry;
}
export { composeCustomRangeMean };

// ── Per-year evaluation cache for derived / θ-coord composites ──────
// Keyed by `${name}:${coord}:${level|theta}:${month}:${year}`. Stores
// the evaluated grid for one event year; the composite reuses these
// across month-scrubs and across composite-rebuilds so flipping
// thresholds is fast once the underlying tiles are warm.
const _derivedYearCache = new Map();

function _derivedYearKey(name, opts, year) {
    const { month, level, coord, theta } = opts;
    const z = coord === 'theta' ? `t${theta}` : `p${level ?? 'sl'}`;
    return `${name}:${coord}:${z}:${month}:${year}`;
}

/** Evaluate the derived / isen value-grid for one event year, with
 *  cache. Returns null when ingredient tiles are still loading. */
function _derivedYearEval(name, opts, year) {
    const key = _derivedYearKey(name, opts, year);
    const hit = _derivedYearCache.get(key);
    if (hit) return hit;
    const meta = FIELDS[name];
    const { month, level, coord, theta } = opts;
    const isenMode = (coord === 'theta') && meta.type === 'pl';
    let entry = null;
    if (meta.derived) {
        entry = computeDerived(name, month, level, coord, theta, year, null);
    } else if (isenMode) {
        entry = fieldOnIsentrope(name, month, theta, year, null);
    }
    if (!entry || !entry.values) return null;
    _derivedYearCache.set(key, entry);
    return entry;
}

/** Composite a derived / isen field across a list of event years. Each
 *  per-year evaluation is computed (and cached) separately, then the
 *  resulting grids are averaged point-wise. NaN-skipping so years that
 *  miss the θ surface in some columns still contribute elsewhere. */
function composeDerivedComposite(name, opts, years, months = null) {
    const monthList = Array.isArray(months) && months.length ? months : [opts.month];
    const grids = [];
    for (const y of years) {
        for (const m of monthList) {
            const perMonthOpts = (m === opts.month) ? opts : { ...opts, month: m };
            const e = _derivedYearEval(name, perMonthOpts, y);
            if (!e || !e.values) return null;   // pending → caller re-tries
            grids.push(e.values);
        }
    }
    if (grids.length === 0) return null;
    const N = grids[0].length;
    const out = new Float32Array(N);
    const cnt = new Uint16Array(N);
    for (const g of grids) {
        for (let i = 0; i < N; i++) {
            const v = g[i];
            if (Number.isFinite(v)) { out[i] += v; cnt[i] += 1; }
        }
    }
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < N; i++) {
        if (cnt[i] > 0) {
            out[i] /= cnt[i];
            if (out[i] < vmin) vmin = out[i];
            if (out[i] > vmax) vmax = out[i];
        } else {
            out[i] = NaN;
        }
    }
    return {
        values: out,
        vmin: Number.isFinite(vmin) ? vmin : 0,
        vmax: Number.isFinite(vmax) ? vmax : 1,
        isReal: true,
    };
}

// Force [-A, +A] when meta.symmetric so RdBu_r centres white on zero. Applied
// at getField return so it covers raw + derived + isentropic paths uniformly.
function symmetricRange(vmin, vmax, meta) {
    if (!meta?.symmetric || !Number.isFinite(vmin) || !Number.isFinite(vmax)) {
        return { vmin, vmax };
    }
    const a = Math.max(Math.abs(vmin), Math.abs(vmax));
    return { vmin: -a, vmax: a };
}

// NaN-safe percentile bounds for the values array. Mirrors era5.js's clamp
// (which runs at tile-load) — used here for derived fields whose values are
// computed from cached tiles and so bypass the era5 path.
function percentileBounds(values, lo, hi) {
    const finite = [];
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) finite.push(v);
    }
    if (finite.length === 0) return [0, 1];
    finite.sort((a, b) => a - b);
    const idxLo = Math.max(0, Math.min(finite.length - 1, Math.floor(lo * (finite.length - 1))));
    const idxHi = Math.max(0, Math.min(finite.length - 1, Math.floor(hi * (finite.length - 1))));
    return [finite[idxLo], finite[idxHi]];
}

// Replace {vmin, vmax} on an entry with percentile-clamped bounds when meta
// declares a clamp. Done once per cache insert so subsequent month-pools
// see clamped per-month bounds.
function applyClampToEntry(entry, meta) {
    if (!meta?.clamp || !entry?.values) return entry;
    const [vmin, vmax] = percentileBounds(entry.values, meta.clamp.lo, meta.clamp.hi);
    entry.vmin = vmin;
    entry.vmax = vmax;
    return entry;
}

/**
 * Return { values, vmin, vmax, shape, lats, lons, name, units, cmap, type, isReal }.
 * Prefers real ERA5 tiles when cached; returns an all-NaN placeholder while
 * the tile fetch is in flight (the ERA5 loader fires an event when it
 * arrives so the caller can re-render with real data).
 *
 * `coord` selects the vertical coordinate: 'pressure' (use `level`, hPa) or
 * 'theta' (use `theta`, K). Isentropic rendering interpolates pressure-level
 * tiles to the requested θ surface per column; tropics near low θ and the
 * upper stratosphere near high θ return NaN where θ₀ is out of range.
 */
export function getField(name, { month = 1, level = 500, coord = 'pressure', theta = 330, kind = 'mean', period = 'default', year = null, customRange = null, seasonal = false } = {}) {
    const meta = FIELDS[name];
    if (!meta) throw new Error(`unknown field: ${name}`);

    // Seasonal 3-month centered mean — short-circuit at the top so all the
    // per-month branching below (derived, isenMode, per-year, composites,
    // alt-periods, std) is reused unchanged. Fetch the three single-month
    // tiles, NaN-safe-average pointwise, pool vmin/vmax across them.
    //
    // If any of the three tiles is still pending, return the center month
    // so the display keeps painting — the seasonal mean fills in on the
    // next render tick once the tile arrives (onFieldLoaded → updateField).
    if (seasonal) {
        const prev = ((month + 10) % 12) + 1;   // m-1 with Dec wrap
        const next = (month %  12) + 1;         // m+1 with Dec wrap
        const months = [prev, month, next];
        const fs = months.map(m => getField(name, {
            month: m, level, coord, theta, kind, period, year, customRange,
            seasonal: false,
        }));
        if (!fs.every(f => f.isReal)) return fs[1];
        const N = fs[0].values.length;
        const out = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            let s = 0, n = 0;
            for (let j = 0; j < 3; j++) {
                const v = fs[j].values[i];
                if (Number.isFinite(v)) { s += v; n += 1; }
            }
            out[i] = n > 0 ? s / n : NaN;
        }
        const vmin = Math.min(fs[0].vmin, fs[1].vmin, fs[2].vmin);
        const vmax = Math.max(fs[0].vmax, fs[1].vmax, fs[2].vmax);
        return { ...fs[1], values: out, vmin, vmax, seasonal: true, seasonalMonths: months };
    }

    // Custom-range composite: browser-side mean of per-year tiles over an
    // arbitrary [start, end] year range. Surfaces to the rest of the app
    // as if it were a climatology (same shape). v1 scope: pressure-coord
    // raw fields + single-level fields only — derived and isentropic
    // composites are a follow-up (would need per-year θ cubes averaged
    // into a composite θ cube, which is doable but heavier).
    if (customRange && !meta.derived && (coord !== 'theta' || meta.type !== 'pl')) {
        const useLevel = meta.type === 'pl' ? level : null;
        const composed = composeCustomRangeMean(
            name, month, useLevel, customRange);
        if (composed) {
            const r = symmetricRange(composed.vmin, composed.vmax, meta);
            return {
                values: composed.values,
                vmin: r.vmin, vmax: r.vmax,
                shape: [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                long_name: meta.name,
                units: meta.units,
                isReal: true,
                kind: 'mean',
                period: 'custom_range',
                customRange,
            };
        }
        // Not all tiles cached yet — fall through to pending below.
        return {
            ...pendingField(),
            shape: [GRID.nlat, GRID.nlon],
            lats: LATS, lons: LONS,
            ...meta,
            isReal: false, kind: 'mean',
            period: 'custom_range',
            customRange,
        };
    }
    // Composite of a derived field (wspd, mse, pv, dls) or any θ-coord
    // pressure field (PV-on-θ, T-on-θ, etc.). The plain customRange
    // engine above can't help because it averages tile values directly,
    // and these fields need the per-year COMPUTED grid to be averaged.
    // Compute per-year, then mean across event years (NaN-skipping).
    // Without this branch, derived/θ composites silently returned the
    // climatology, which made the anomaly view paint zero everywhere.
    if (customRange && Array.isArray(customRange.years) && customRange.years.length
        && (meta.derived || (coord === 'theta' && meta.type === 'pl'))) {
        const composed = composeDerivedComposite(
            name, { month, level, coord, theta }, customRange.years,
            Array.isArray(customRange.months) && customRange.months.length
                ? customRange.months : null);
        if (composed) {
            const r = symmetricRange(composed.vmin, composed.vmax, meta);
            return {
                values: composed.values,
                vmin: r.vmin, vmax: r.vmax,
                shape: [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                long_name: meta.name,
                units: meta.units,
                isReal: true,
                kind: 'mean',
                period: 'custom_range',
                customRange,
            };
        }
        return {
            ...pendingField(),
            shape: [GRID.nlat, GRID.nlon],
            lats: LATS, lons: LONS,
            ...meta,
            isReal: false, kind: 'mean',
            period: 'custom_range',
            customRange,
        };
    }

    const isenMode = (coord === 'theta') && meta.type === 'pl';

    // Derived (pressure-coord) fields gain honest σ tiles via
    // pipeline/build_derived_std.py — computed year-by-year from raw
    // components, then cross-year std. When those tiles are present
    // in the manifest for `period`, fetch them like any raw std tile.
    // Otherwise (isentropic mode, or trees without the derived std tiles)
    // fall back to mean and flag stdUnavailable so the UI can surface it.
    const derivedStdAvailable = kind === 'std' && meta.derived && !isenMode
                                && derivedHasPipelineStd(name, period);
    const stdUnsupported = kind === 'std' && (isenMode ||
                                              (meta.derived && !derivedStdAvailable));
    const effKind = stdUnsupported ? 'mean' : kind;
    // Reference-period (non-default) is supported for raw fields (direct tile
    // fetch) AND for isentropic mode (the θ cube + interpolation machinery
    // thread `refPeriod` through — fetches 1961-1990 pressure tiles, builds
    // 1961-1990 θ cube, interpolates). Only pressure-coord *non-derived*
    // fields used the per-period path before; now isenMode gets it too.
    // Derived non-θ-only fields in pressure mode still fall back to default
    // period (they'd need more plumbing to compose).
    const periodUnsupported = period !== 'default'
        && meta.derived
        && !meta.thetaOnly
        && !isenMode;
    const effPeriod = periodUnsupported ? 'default' : period;
    // Year passes through for ALL derived fields. computeDerived handles
    // per-year sourcing internally for wspd / dls / mse via the
    // {period:'per_year', year} branch in its component lookups; pv is
    // theta-only so this branch is moot. Previously this nulled year for
    // derived non-θ-only fields, which made dls and friends silently
    // collapse to climatology and look the same for every year in
    // single-year mode.
    const effYear = year;

    // Derived fields (e.g. wind speed, PV) — compute from component tiles.
    // refPeriod (e.g. 1961-1990) is only propagated when year is null, since
    // year takes precedence as the tile-source selector.
    const refPeriodArg = (effYear == null && effPeriod !== 'default') ? effPeriod : null;
    // Derived σ: pipeline-materialised tiles (build_derived_std.py) live
    // alongside the raw σ tiles and load the same way. No per-year variant
    // for derived σ — σ is climatology-only by construction.
    if (meta.derived && derivedStdAvailable && effKind === 'std' && effYear == null) {
        const era = requestEra5(name, { month, level, kind: 'std', period: effPeriod });
        if (era) {
            return {
                values: era.values, vmin: era.vmin, vmax: era.vmax,
                shape: era.shape ?? [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                long_name: meta.name,
                units: meta.units,
                isReal: true,
                kind: 'std',
                period: effPeriod,
                year: null,
            };
        }
        // Tile still pending — fall through to pendingField at function tail.
        return {
            ...pendingField(),
            shape: [GRID.nlat, GRID.nlon],
            lats: LATS, lons: LONS,
            ...meta,
            isReal: false, kind: 'std',
            period: effPeriod,
        };
    }
    if (meta.derived) {
        const d = computeDerived(name, month, level, coord, theta, effYear, refPeriodArg);
        if (d) {
            const r = symmetricRange(d.vmin, d.vmax, meta);
            return {
                values: d.values, vmin: r.vmin, vmax: r.vmax,
                shape: d.shape ?? [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                isReal: d.isReal,
                kind: 'mean',
                stdUnavailable: stdUnsupported,
                year: effYear,
                period: effPeriod,
            };
        }
    } else if (isenMode) {
        const d = fieldOnIsentrope(name, month, theta, effYear, refPeriodArg);
        if (d) {
            const r = symmetricRange(d.vmin, d.vmax, meta);
            return {
                values: d.values, vmin: r.vmin, vmax: r.vmax,
                shape: [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                long_name: meta.name,
                units: meta.units,
                isReal: true,
                kind: 'mean',
                stdUnavailable: stdUnsupported,
                year: effYear,
                period: effPeriod,
            };
        }
    } else {
        // When `year` is set we use the per-year tile tree; route via the
        // 'per_year' period sentinel so era5.js picks the right base URL +
        // file naming. Falls back to the regular climatology path otherwise.
        const usePerYear = effYear != null;
        const requestPeriod = usePerYear ? 'per_year' : effPeriod;
        const era = requestEra5(name, {
            month, level,
            kind: usePerYear ? 'mean' : effKind,    // per-year tiles have no std
            period: requestPeriod,
            year: effYear,
        });
        if (era) {
            // Skip symmetric forcing for std tiles — they're non-negative by
            // definition, so a ±max range wastes half the colormap on values
            // that can't exist. Same for per-year tiles (single snapshots).
            const forceSym = meta.symmetric && effKind !== 'std';
            const r = forceSym
                ? symmetricRange(era.vmin, era.vmax, meta)
                : { vmin: era.vmin, vmax: era.vmax };
            return {
                values: era.values,
                vmin: r.vmin, vmax: r.vmax,
                shape: era.shape ?? [GRID.nlat, GRID.nlon],
                lats: LATS, lons: LONS,
                ...meta,
                // Prefer our human-friendly labels over the raw ERA5 strings
                // ("m" > "m**2 s**-2", "hPa" > "Pa", etc.).
                long_name: meta.name,
                units: meta.units,
                isReal: true,
                kind: effKind,
                period: requestPeriod,
                year: effYear,
            };
        }
    }

    return {
        ...pendingField(),
        shape: [GRID.nlat, GRID.nlon],
        lats: LATS, lons: LONS,
        ...meta,
        isReal: false,
        kind: effKind,
        period: effPeriod,
    };
}

function magnitudeFromUV(u, v) {
    const n = u.length;
    const values = new Float32Array(n);
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < n; i++) {
        const s = Math.hypot(u[i], v[i]);
        values[i] = s;
        if (s < vmin) vmin = s;
        if (s > vmax) vmax = s;
    }
    return { values, vmin, vmax };
}

// Magnitude of the vector difference (V_top − V_bot) for deep-layer shear.
// Operates point-wise on aligned grids of u/v at two levels.
function shearMagnitude(uTop, vTop, uBot, vBot) {
    const n = uTop.length;
    const values = new Float32Array(n);
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < n; i++) {
        const du = uTop[i] - uBot[i];
        const dv = vTop[i] - vBot[i];
        const s = Math.hypot(du, dv);
        values[i] = s;
        if (Number.isFinite(s)) {
            if (s < vmin) vmin = s;
            if (s > vmax) vmax = s;
        }
    }
    return { values, vmin: Number.isFinite(vmin) ? vmin : 0, vmax: Number.isFinite(vmax) ? vmax : 1 };
}

// Moist static energy: h = c_p·T + g·z + L_v·q, displayed as h/c_p (K).
// Pressure-coord uses cached t/z/q tiles; θ-coord interpolates each ingredient
// to the requested isentropic surface.  q is stored in g/kg (×1000 from raw),
// so divide back to kg/kg before applying L_v.
const CP_DRY = 1004;          // J kg⁻¹ K⁻¹
const G_MSE  = 9.80665;
const L_V    = 2.501e6;       // J kg⁻¹  (latent heat of vaporisation, ~273 K)
const _mseCache = new Map();  // `${coord}:${level|theta}:${month}` → {values, vmin, vmax}

function computeMSEFromTiles(tT, tZ, tQ) {
    const n = tT.length;
    const out = new Float32Array(n);
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < n; i++) {
        const T = tT[i], Z = tZ[i], Q = tQ[i];
        if (!Number.isFinite(T) || !Number.isFinite(Z) || !Number.isFinite(Q)) {
            out[i] = NaN; continue;
        }
        // Z is geopotential HEIGHT (m) after era5.js's m²/s² → m conversion;
        // multiply by g to recover g·z. Q is g/kg → divide by 1000 for kg/kg.
        const h = CP_DRY * T + G_MSE * Z + L_V * (Q / 1000);
        const hOverCp = h / CP_DRY;
        out[i] = hOverCp;
        if (hOverCp < vmin) vmin = hOverCp;
        if (hOverCp > vmax) vmax = hOverCp;
    }
    if (!Number.isFinite(vmin)) { vmin = 250; vmax = 360; }
    return { values: out, vmin, vmax };
}

function computeDerived(name, month, level, coord, theta, year = null, refPeriod = null) {
    // Year-aware + refPeriod-aware derived fields. Source precedence:
    //   year set → per-year tile tree for that year
    //   refPeriod set → alternate climatology (e.g. 1961-1990)
    //   neither → active default climatology
    const srcSfx = `${year ?? '_'}:${refPeriod ?? '_'}`;
    const period = year != null ? 'per_year' : (refPeriod || 'default');
    const yReq = year != null
        ? { period, year }
        : (refPeriod ? { period: refPeriod } : {});
    if (name === 'wspd') {
        for (let m = 1; m <= 12; m++) {
            const k = `${coord}:${coord === 'theta' ? theta : level}:${m}:${srcSfx}`;
            if (_wspdCache.has(k)) continue;
            let uVals, vVals;
            if (coord === 'theta') {
                const uI = fieldOnIsentrope('u', m, theta, year, refPeriod);
                const vI = fieldOnIsentrope('v', m, theta, year, refPeriod);
                if (!uI || !vI) continue;
                uVals = uI.values; vVals = vI.values;
            } else {
                const u = cachedMonth('u', m, level, 'mean', period, year);
                const v = cachedMonth('v', m, level, 'mean', period, year);
                if (!u || !v) continue;
                uVals = u; vVals = v;
            }
            _wspdCache.set(k, applyClampToEntry(magnitudeFromUV(uVals, vVals), FIELDS.wspd));
        }

        const key = `${coord}:${coord === 'theta' ? theta : level}:${month}:${srcSfx}`;
        let entry = _wspdCache.get(key);
        if (!entry) {
            let uVals, vVals;
            if (coord === 'theta') {
                const uI = fieldOnIsentrope('u', month, theta, year, refPeriod);
                const vI = fieldOnIsentrope('v', month, theta, year, refPeriod);
                if (!uI || !vI) return null;
                uVals = uI.values; vVals = vI.values;
            } else {
                const uE = requestEra5('u', { month, level, ...yReq });
                const vE = requestEra5('v', { month, level, ...yReq });
                if (!uE || !vE) return null;
                uVals = uE.values; vVals = vE.values;
            }
            entry = applyClampToEntry(magnitudeFromUV(uVals, vVals), FIELDS.wspd);
            _wspdCache.set(key, entry);
        }
        const prefix = `${coord}:${coord === 'theta' ? theta : level}:`;
        const suffix = `:${srcSfx}`;
        const agg = aggregateRangeByPrefixSuffix(_wspdCache, prefix, suffix);
        return {
            values: entry.values,
            vmin: agg ? agg.vmin : entry.vmin,
            vmax: agg ? agg.vmax : entry.vmax,
            isReal: true,
        };
    }
    if (name === 'dls') {
        // Deep-layer shear is a fixed-level diagnostic: |V_200 − V_850|.
        // Single-level field (no level knob), so the cache key only
        // varies on month + source slice.
        const yArgs = year != null
            ? { period: 'per_year', year }
            : (refPeriod ? { period: refPeriod } : {});
        const computeFor = (m) => {
            const u200 = cachedMonth('u', m, 200, 'mean', period, year);
            const v200 = cachedMonth('v', m, 200, 'mean', period, year);
            const u850 = cachedMonth('u', m, 850, 'mean', period, year);
            const v850 = cachedMonth('v', m, 850, 'mean', period, year);
            if (!u200 || !v200 || !u850 || !v850) return null;
            return applyClampToEntry(
                shearMagnitude(u200, v200, u850, v850), FIELDS.dls);
        };
        // Opportunistic 12-month fill so the cross-month colorbar is stable.
        for (let m = 1; m <= 12; m++) {
            const k = `${m}:${srcSfx}`;
            if (_dlsCache.has(k)) continue;
            const e = computeFor(m);
            if (e) _dlsCache.set(k, e);
        }
        const key = `${month}:${srcSfx}`;
        let entry = _dlsCache.get(key);
        if (!entry) {
            // Force-fetch the four ingredient tiles for the requested month.
            const u200E = requestEra5('u', { month, level: 200, ...yArgs });
            const v200E = requestEra5('v', { month, level: 200, ...yArgs });
            const u850E = requestEra5('u', { month, level: 850, ...yArgs });
            const v850E = requestEra5('v', { month, level: 850, ...yArgs });
            if (!u200E || !v200E || !u850E || !v850E) return null;
            entry = applyClampToEntry(
                shearMagnitude(u200E.values, v200E.values, u850E.values, v850E.values),
                FIELDS.dls);
            _dlsCache.set(key, entry);
        }
        const prefix = '';
        const suffix = `:${srcSfx}`;
        const agg = aggregateRangeByPrefixSuffix(_dlsCache, prefix, suffix);
        return {
            values: entry.values,
            vmin: agg ? agg.vmin : entry.vmin,
            vmax: agg ? agg.vmax : entry.vmax,
            isReal: true,
        };
    }
    if (name === 'pv') {
        const theta0 = (coord === 'theta') ? theta : 330;
        return computePVOnIsentrope(month, theta0, year, refPeriod);
    }
    if (name === 'mse') {
        for (let m = 1; m <= 12; m++) {
            const k = `${coord}:${coord === 'theta' ? theta : level}:${m}:${srcSfx}`;
            if (_mseCache.has(k)) continue;
            let t, z, q;
            if (coord === 'theta') {
                const Ti = fieldOnIsentrope('t', m, theta, year, refPeriod);
                const Zi = fieldOnIsentrope('z', m, theta, year, refPeriod);
                const Qi = fieldOnIsentrope('q', m, theta, year, refPeriod);
                if (!Ti || !Zi || !Qi) continue;
                t = Ti.values; z = Zi.values; q = Qi.values;
            } else {
                t = cachedMonth('t', m, level, 'mean', period, year);
                z = cachedMonth('z', m, level, 'mean', period, year);
                q = cachedMonth('q', m, level, 'mean', period, year);
                if (!t || !z || !q) continue;
            }
            _mseCache.set(k, applyClampToEntry(computeMSEFromTiles(t, z, q), FIELDS.mse));
        }
        const key = `${coord}:${coord === 'theta' ? theta : level}:${month}:${srcSfx}`;
        let entry = _mseCache.get(key);
        if (!entry) {
            let tT, tZ, tQ;
            if (coord === 'theta') {
                const Ti = fieldOnIsentrope('t', month, theta, year, refPeriod);
                const Zi = fieldOnIsentrope('z', month, theta, year, refPeriod);
                const Qi = fieldOnIsentrope('q', month, theta, year, refPeriod);
                if (!Ti || !Zi || !Qi) return null;
                tT = Ti.values; tZ = Zi.values; tQ = Qi.values;
            } else {
                const Te = requestEra5('t', { month, level, ...yReq });
                const Ze = requestEra5('z', { month, level, ...yReq });
                const Qe = requestEra5('q', { month, level, ...yReq });
                if (!Te || !Ze || !Qe) return null;
                tT = Te.values; tZ = Ze.values; tQ = Qe.values;
            }
            entry = applyClampToEntry(computeMSEFromTiles(tT, tZ, tQ), FIELDS.mse);
            _mseCache.set(key, entry);
        }
        const prefix = `${coord}:${coord === 'theta' ? theta : level}:`;
        const suffix = `:${srcSfx}`;
        const agg = aggregateRangeByPrefixSuffix(_mseCache, prefix, suffix);
        return {
            values: entry.values,
            vmin: agg ? agg.vmin : entry.vmin,
            vmax: agg ? agg.vmax : entry.vmax,
            isReal: true,
        };
    }
    return null;
}

// Aggregate vmin/vmax across every cached entry whose key matches both a
// prefix (coord / level or theta / ) and a suffix (year tag). Used by the
// year-aware derived caches.
function aggregateRangeByPrefixSuffix(cacheMap, prefix, suffix) {
    let vmin = Infinity, vmax = -Infinity, any = false;
    for (const [key, val] of cacheMap) {
        if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
        if (!Number.isFinite(val.vmin) || !Number.isFinite(val.vmax)) continue;
        if (val.vmin < vmin) vmin = val.vmin;
        if (val.vmax > vmax) vmax = val.vmax;
        any = true;
    }
    return any ? { vmin, vmax } : null;
}

// ── PV on an isentropic surface ──────────────────────────────────────────
// We use ERA5's canonical Ertel PV (computed by ECMWF from the spectral
// model state — full 3-D form with density-weighting, more accurate than
// the simplified -g·(ζ+f)·∂θ/∂p approximation) on pressure levels, and
// interpolate per column to the requested isentropic surface θ₀.

const KAPPA = 0.2854;      // R / cp for dry air — used by buildThetaCube

const _pvCache = new Map();
const _thetaCubeCache = new Map();    // month → Array<Float32Array> (θ per level)
const _isenFieldCache = new Map();    // `${name}:${month}:${theta0}` → {values, vmin, vmax}
const _wspdCache = new Map();         // `${month}:${level|theta}:${coord}` → {values, vmin, vmax}
const _dlsCache  = new Map();         // `${month}:${srcSfx}` → {values, vmin, vmax} (single-level diagnostic)

/** Aggregate vmin/vmax across every cached entry whose key matches `prefix`.
 *  Used so derived/isentropic fields keep a stable colorbar as the user
 *  scrubs months — mirrors what era5.js does for raw tiles. */
function aggregateRangeByPrefix(cacheMap, prefix) {
    let vmin = Infinity, vmax = -Infinity, any = false;
    for (const [key, val] of cacheMap) {
        if (!key.startsWith(prefix)) continue;
        if (!Number.isFinite(val.vmin) || !Number.isFinite(val.vmax)) continue;
        if (val.vmin < vmin) vmin = val.vmin;
        if (val.vmax > vmax) vmax = val.vmax;
        any = true;
    }
    return any ? { vmin, vmax } : null;
}

/** Build (or reuse) the per-level θ cube for `month`. Requires T tiles at
 *  every LEVEL; returns null if any are missing. Source selection:
 *    year set → per-year tiles for that year  (year-vs-* anomaly)
 *    refPeriod set → that climatology's tiles (climate-change anomaly)
 *    neither → active 30-year climatology (self-anomaly or total).
 *  year and refPeriod are mutually exclusive; year takes precedence. */
function buildThetaCube(month, year = null, refPeriod = null) {
    const ck = `${month}:${year ?? '_'}:${refPeriod ?? '_'}`;
    const hit = _thetaCubeCache.get(ck);
    if (hit) return hit;
    const tReq = year != null
        ? { period: 'per_year', year }
        : (refPeriod ? { period: refPeriod } : {});
    const { nlat, nlon } = GRID;
    const N = nlat * nlon;
    const thetas = [];
    for (let k = 0; k < LEVELS.length; k++) {
        const tT = requestEra5('t', { month, level: LEVELS[k], ...tReq });
        if (!tT) return null;
        const pFactor = Math.pow(1000 / LEVELS[k], KAPPA);
        const theta = new Float32Array(N);
        for (let i = 0; i < N; i++) theta[i] = tT.values[i] * pFactor;
        thetas.push(theta);
    }
    _thetaCubeCache.set(ck, thetas);
    return thetas;
}

/** Interpolate per-level values to the θ₀ surface, column by column. θ is
 *  monotonically decreasing with increasing LEVELS index (higher p → lower θ
 *  in a statically-stable atmosphere), so scan adjacent pairs for the first
 *  bracketing the target. Returns NaN when θ₀ is out of range for a column. */
function interpolateColumnToIsentrope(valsByLev, thetasByLev, theta0) {
    const { nlat, nlon } = GRID;
    const N = nlat * nlon;
    const nlev = LEVELS.length;
    const out = new Float32Array(N);
    let vmin = Infinity, vmax = -Infinity;
    for (let idx = 0; idx < N; idx++) {
        let kHi = -1;
        for (let k = 0; k < nlev - 1; k++) {
            const thUp = thetasByLev[k][idx];
            const thLo = thetasByLev[k + 1][idx];
            if (Number.isFinite(thUp) && Number.isFinite(thLo) &&
                thUp >= theta0 && theta0 > thLo) {
                kHi = k; break;
            }
        }
        if (kHi < 0) { out[idx] = NaN; continue; }
        const th1 = thetasByLev[kHi][idx];
        const th2 = thetasByLev[kHi + 1][idx];
        const frac = (th1 - theta0) / (th1 - th2);
        const val = valsByLev[kHi][idx] + frac * (valsByLev[kHi + 1][idx] - valsByLev[kHi][idx]);
        out[idx] = val;
        if (Number.isFinite(val)) {
            if (val < vmin) vmin = val;
            if (val > vmax) vmax = val;
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    return { values: out, vmin, vmax };
}

/** Return a named pressure-level field interpolated to the θ₀ isentropic
 *  surface. Caches the result keyed by (name, month, θ₀). Returns null if
 *  any required T or field tile is missing. Colorbar range (vmin/vmax) is
 *  aggregated across every cached month at the same (name, θ₀) so scrubbing
 *  months doesn't rescale the colormap. */
function fieldOnIsentrope(name, month, theta0, year = null, refPeriod = null) {
    // Cache keys distinguish by both year (per-year) AND refPeriod
    // (alternate climatology, e.g. 1961-1990) so all three sources
    // (year, refPeriod, active-default) coexist cleanly.
    const srcSfx = `${year ?? '_'}:${refPeriod ?? '_'}`;
    const reqBase = year != null
        ? { period: 'per_year', year }
        : (refPeriod ? { period: refPeriod } : {});
    const lookupPeriod = year != null ? 'per_year' : (refPeriod || 'default');
    // Opportunistic fill across all 12 months — needed for the cross-month
    // aggregate to be complete and the colorbar to stay stable as you scrub.
    for (let m = 1; m <= 12; m++) {
        const ck = `${name}:${m}:${theta0}:${srcSfx}`;
        if (_isenFieldCache.has(ck)) continue;
        // Need t at every level (for θ cube) AND the field tile at every level.
        let allHere = true;
        for (const L of LEVELS) {
            if (!cachedMonth('t', m, L, 'mean', lookupPeriod, year) ||
                !cachedMonth(name, m, L, 'mean', lookupPeriod, year)) {
                allHere = false; break;
            }
        }
        if (!allHere) continue;
        const thetas = buildThetaCube(m, year, refPeriod);
        if (!thetas) continue;
        const valsByLev = [];
        for (const L of LEVELS) {
            valsByLev.push(cachedMonth(name, m, L, 'mean', lookupPeriod, year));
        }
        _isenFieldCache.set(ck, interpolateColumnToIsentrope(valsByLev, thetas, theta0));
    }

    const key = `${name}:${month}:${theta0}:${srcSfx}`;
    let entry = _isenFieldCache.get(key);
    if (!entry) {
        const thetas = buildThetaCube(month, year, refPeriod);
        if (!thetas) return null;
        const valsByLev = [];
        for (let k = 0; k < LEVELS.length; k++) {
            const tile = requestEra5(name, { month, level: LEVELS[k], ...reqBase });
            if (!tile) return null;
            valsByLev.push(tile.values);
        }
        entry = interpolateColumnToIsentrope(valsByLev, thetas, theta0);
        _isenFieldCache.set(key, entry);
    }
    // Aggregate range across every cached month at (name, θ₀, source).
    let vmin = Infinity, vmax = -Infinity;
    const prefix = `${name}:`;
    const suffix = `:${theta0}:${srcSfx}`;
    for (const [k, v] of _isenFieldCache) {
        if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue;
        if (v.vmin < vmin) vmin = v.vmin;
        if (v.vmax > vmax) vmax = v.vmax;
    }
    return {
        values: entry.values,
        vmin: Number.isFinite(vmin) ? vmin : entry.vmin,
        vmax: Number.isFinite(vmax) ? vmax : entry.vmax,
    };
}


/** Invalidate every θ-coord cache — called when a new pressure-level tile
 *  lands so the next render uses the freshest data. */
export function invalidateIsentropicCache() {
    _pvCache.clear();
    _thetaCubeCache.clear();
    _isenFieldCache.clear();
    _wspdCache.clear();
    _dlsCache.clear();
    _mseCache.clear();
    _derivedYearCache.clear();
}
// Legacy name kept for callers that still import it.
export const invalidatePVCache = invalidateIsentropicCache;

function computePVOnIsentrope(month, theta0, year = null, refPeriod = null) {
    const srcSfx = `${year ?? '_'}:${refPeriod ?? '_'}`;
    const lookupPeriod = year != null ? 'per_year' : (refPeriod || 'default');
    // Opportunistic fill: build PV-on-θ for any month whose t and pv tiles
    // are all cached, so the aggregate colorbar stays stable as the user scrubs.
    for (let m = 1; m <= 12; m++) {
        const ck = `${m}:${theta0}:${srcSfx}`;
        if (_pvCache.has(ck) && _pvCache.get(ck).ready) continue;
        let allHere = true;
        for (const L of LEVELS) {
            if (!cachedMonth('t',  m, L, 'mean', lookupPeriod, year) ||
                !cachedMonth('pv', m, L, 'mean', lookupPeriod, year)) {
                allHere = false; break;
            }
        }
        if (!allHere) continue;
        _pvComputeRaw(m, theta0, year, refPeriod);
    }

    const cacheKey = `${month}:${theta0}:${srcSfx}`;
    let cached = _pvCache.get(cacheKey);
    if (!cached?.ready) {
        cached = _pvComputeRaw(month, theta0, year, refPeriod);
        if (!cached) return null;
    }
    // Aggregate range across every cached month at this (θ₀, source).
    let vmin = Infinity, vmax = -Infinity;
    const suffix = `:${theta0}:${srcSfx}`;
    for (const [k, v] of _pvCache) {
        if (!k.endsWith(suffix) || !v.ready) continue;
        if (v.vmin < vmin) vmin = v.vmin;
        if (v.vmax > vmax) vmax = v.vmax;
    }
    return {
        ...cached,
        vmin: Number.isFinite(vmin) ? vmin : cached.vmin,
        vmax: Number.isFinite(vmax) ? vmax : cached.vmax,
    };
}

/** PV-on-θ for a single (month, θ₀) — interpolate the canonical ERA5 PV
 *  (already in PVU after era5.js's unit conversion) to the requested θ surface,
 *  using the θ cube derived from T. Returns the cached entry or null if any
 *  required tile is missing. */
function _pvComputeRaw(month, theta0, year = null, refPeriod = null) {
    const thetas = buildThetaCube(month, year, refPeriod);
    if (!thetas) return null;

    const { nlat, nlon } = GRID;
    const nlev = LEVELS.length;
    const pvReq = year != null
        ? { period: 'per_year', year }
        : (refPeriod ? { period: refPeriod } : {});

    // Pull the canonical ERA5 PV tiles (already PVU from the era5.js unit pass).
    // No need to compute ζ from u, v or to apply the ∂θ/∂p approximation
    // ourselves — ECMWF's spectral computation is more accurate (full Ertel
    // form including density-weighting and 3-D vorticity components).
    const pvLevs = new Array(nlev);
    for (let k = 0; k < nlev; k++) {
        const tPV = requestEra5('pv', { month, level: LEVELS[k], ...pvReq });
        if (!tPV) return null;
        pvLevs[k] = tPV.values;
    }

    const interp = interpolateColumnToIsentrope(pvLevs, thetas, theta0);

    // Clamp display range — stratospheric intrusions reach hundreds of PVU;
    // ±10 keeps the tropospheric ribbon (where the dynamic story lives) crisp.
    const DISPLAY_CAP = 10;
    const result = {
        values: interp.values,
        vmin: Math.max(interp.vmin, -DISPLAY_CAP),
        vmax: Math.min(interp.vmax,  DISPLAY_CAP),
        shape: [nlat, nlon], isReal: true, ready: true,
    };
    _pvCache.set(`${month}:${theta0}:${year ?? '_'}:${refPeriod ?? '_'}`, result);
    return result;
}

/** True if ERA5 has the listed level (or sl fields w/ no level required). */
export function hasRealLevel(name, level) {
    const meta = FIELDS[name];
    if (!meta) return false;
    if (meta.type === 'sl') return true;
    const levels = availableLevels(name);
    return !!(levels && levels.includes(level));
}
