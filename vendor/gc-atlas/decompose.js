// GC-ATLAS — field decomposition helpers.
//
// Given a 2D (nlat, nlon) scalar field, produce the derived scalar for any
// of four rendering modes:
//
//   total    — the raw field, unchanged.
//   zonal    — zonal mean at each latitude (no longitude dependence).
//   eddy     — value minus the zonal mean; the stationary-wave signal.
//   anomaly  — value minus the annual (12-month) mean at the same (lat, lon);
//              the seasonal-cycle signal.
//
// All helpers are NaN-aware: land-masked samples (e.g. SST over land) drop
// out of means and pass through as NaN in the derived field, so the colormap
// continues to paint them with the no-data colour.
//
// Range is recomputed per mode. For eddy / anomaly the output is symmetric
// about zero (vmax = -vmin = max|v|), which pairs with a divergent colormap
// at the caller.

const EPS = 1e-12;

/** { values, vmin, vmax } for the input, NaN-safe. */
function statsOf(values) {
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    return { vmin, vmax };
}

/** Symmetric range around zero from the field — for diverging display. */
/** 2nd-percentile floor on the finite σ values in a std grid — anything
 *  below this is treated as "variance too small to standardize" and
 *  returned as NaN instead of dividing by near-zero. Adapts per-field. */
function stdFloor(std) {
    const finite = [];
    for (let i = 0; i < std.length; i++) {
        const v = std[i];
        if (Number.isFinite(v) && v > 0) finite.push(v);
    }
    if (finite.length === 0) return 0;
    finite.sort((a, b) => a - b);
    return finite[Math.floor(finite.length * 0.02)] || 0;
}

function symStatsOf(values) {
    let a = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        const m = Math.abs(v);
        if (m > a) a = m;
    }
    if (a < EPS) a = 1;
    return { vmin: -a, vmax: a };
}

/** Symmetric range around zero, clipped at the `clamp.hi` percentile of |v|.
 *  Mirrors the per-tile percentile clamp in era5.js but applied to anomaly /
 *  eddy fields, where below-ground extrapolation under high terrain produces
 *  a few extreme cells that would otherwise blow out the colorbar (e.g. T at
 *  500 hPa anomaly running to ±29 K when the real signal is ±2 K). */
function symStatsOfClamped(values, hi) {
    const finite = [];
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) finite.push(Math.abs(v));
    }
    if (finite.length === 0) return { vmin: -1, vmax: 1 };
    finite.sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(finite.length - 1, Math.floor(hi * (finite.length - 1))));
    let a = finite[idx];
    if (!Number.isFinite(a) || a < EPS) a = 1;
    return { vmin: -a, vmax: a };
}

/** Per-latitude mean of the field (Float32Array, length nlat). NaN-safe. */
function zonalMean(values, nlat, nlon) {
    const zm = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0, n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const v = values[row + j];
            if (Number.isFinite(v)) { s += v; n += 1; }
        }
        zm[i] = n > 0 ? s / n : NaN;
    }
    return zm;
}

/**
 * Apply the decomposition mode to a field.
 * @param {Float32Array} values      — input field, row-major (nlat × nlon).
 * @param {number} nlat, nlon        — grid dims.
 * @param {string} mode              — 'total' | 'zonal' | 'eddy' | 'anomaly'.
 * @param {Float32Array} annualMean  — optional (nlat × nlon) 12-month mean
 *                                     for anomaly mode; ignored otherwise.
 * Returns { values, vmin, vmax, symmetric: bool, empty: bool }.
 *   symmetric: true if range is zero-centred (eddy, anomaly) — hint for
 *              colormap / colorbar presentation.
 *   empty:    true if the mode needs data we don't have (e.g. anomaly
 *              called without annualMean), in which case values is the
 *              original input passed through unchanged.
 */
export function decompose(values, nlat, nlon, mode, annualMean = null, opts = {}) {
    // `opts.clamp = { hi }` triggers percentile clamping on the symmetric
    // range for eddy / anomaly modes — see symStatsOfClamped().
    const clampHi = opts.clamp?.hi;
    const symStats = (out) => clampHi != null ? symStatsOfClamped(out, clampHi) : symStatsOf(out);

    if (mode === 'total' || !mode) {
        const s = statsOf(values);
        return { values, vmin: s.vmin, vmax: s.vmax, symmetric: false, empty: false };
    }

    if (mode === 'zonal') {
        const zm = zonalMean(values, nlat, nlon);
        const out = new Float32Array(nlat * nlon);
        for (let i = 0; i < nlat; i++) {
            const v = zm[i];
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) out[row + j] = v;
        }
        const s = statsOf(out);
        return { values: out, vmin: s.vmin, vmax: s.vmax, symmetric: false, empty: false };
    }

    if (mode === 'eddy') {
        const zm = zonalMean(values, nlat, nlon);
        const out = new Float32Array(nlat * nlon);
        for (let i = 0; i < nlat; i++) {
            const mean = zm[i];
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                const v = values[row + j];
                out[row + j] = Number.isFinite(v) && Number.isFinite(mean) ? (v - mean) : NaN;
            }
        }
        const s = symStats(out);
        return { values: out, vmin: s.vmin, vmax: s.vmax, symmetric: true, empty: false };
    }

    if (mode === 'anomaly') {
        if (!annualMean) {
            const s = statsOf(values);
            return { values, vmin: s.vmin, vmax: s.vmax, symmetric: false, empty: true };
        }
        const out = new Float32Array(nlat * nlon);
        const n = values.length;
        for (let i = 0; i < n; i++) {
            const v = values[i];
            const m = annualMean[i];
            out[i] = Number.isFinite(v) && Number.isFinite(m) ? (v - m) : NaN;
        }
        const s = symStats(out);
        return { values: out, vmin: s.vmin, vmax: s.vmax, symmetric: true, empty: false };
    }

    if (mode === 'zscore') {
        // Standardized anomaly: (value − climo mean) / climo σ.
        // `annualMean` here carries the same-month climo mean; `opts.stdTile`
        // carries the same-month climo std. Both are nlat×nlon Float32Arrays.
        const std = opts.stdTile;
        if (!annualMean || !std) {
            const s = statsOf(values);
            return { values, vmin: s.vmin, vmax: s.vmax, symmetric: false, empty: true };
        }
        // Soft denominator floor: clamp σ to the 2nd-percentile of finite
        // positive σ values in the tile. Keeps low-variance cells from
        // blowing up into implausible z-scores (|z| > 10) when a monthly
        // anomaly is modest but the climo σ happens to be tiny — common
        // for precipitation in normally-dry cells. Low-σ cells still
        // render (no NaN holes in the tropics, per the prior fix), but
        // their z saturates at |(v − m) / floor| instead of exploding.
        const sigmaFloor = stdFloor(std);
        const out = new Float32Array(nlat * nlon);
        const n = values.length;
        for (let i = 0; i < n; i++) {
            const v = values[i];
            const m = annualMean[i];
            const s = std[i];
            if (Number.isFinite(v) && Number.isFinite(m) && Number.isFinite(s) && s > 0) {
                const sEff = sigmaFloor > 0 ? Math.max(s, sigmaFloor) : s;
                out[i] = (v - m) / sEff;
            } else {
                out[i] = NaN;
            }
        }
        const stats = symStats(out);
        return { values: out, vmin: stats.vmin, vmax: stats.vmax, symmetric: true, empty: false };
    }

    // Unknown mode — pass through.
    const s = statsOf(values);
    return { values, vmin: s.vmin, vmax: s.vmax, symmetric: false, empty: false };
}

/**
 * Aggregate decomposition range across every month whose tiles are cached.
 * Keeps the colorbar stable as the user scrubs months instead of re-shifting
 * with each new month's local extrema.
 *
 * Mirrors `decompose()`'s symmetry rules: for symmetric modes (eddy, anomaly)
 * we widen ±absMax across months; for plain modes we take min(vmin) / max(vmax).
 *
 * @param {string} mode             'zonal' | 'eddy' | 'anomaly' (total uses the field's own range)
 * @param {(month:number)=>{values:Float32Array}|null} fetchMonth
 *                                  Returns the field for a given month, or null if not cached.
 * @param {number} nlat
 * @param {number} nlon
 * @param {Float32Array|null} annualMean  Required for 'anomaly' mode.
 *
 * Returns { vmin, vmax, symmetric } or null if nothing cached.
 */
export function aggregatedDecompositionRange(mode, fetchMonth, nlat, nlon, annualMean = null, opts = {}) {
    // `opts.symmetric` lets callers force ±max pooling for fields whose
    // FIELDS metadata declares `symmetric: true` even in zonal mode (where
    // decompose() itself wouldn't otherwise centre the range on zero).
    // `opts.clamp` propagates the per-field percentile clamp into per-month
    // decompose() calls for symmetric modes — keeps the pooled range from
    // being blown out by topography spikes in any single month.
    //
    // `annualMean` may be either a Float32Array (used for every month — the
    // self-anomaly case where the reference is the 12-month mean) OR a
    // function (m) => Float32Array | null (climate-change anomaly: the
    // reference is the same month from a different period). Without the
    // per-month variant, climate-change mode would compute month-m minus
    // January's reference for every iteration, mixing the seasonal cycle
    // into the colorbar.
    const { symmetric: forceSymmetric = false, clamp = null, stdTileForMonth = null } = opts;
    if (mode === 'total' || !mode) return null;
    const refForMonth = typeof annualMean === 'function'
        ? annualMean
        : (() => annualMean);
    let vmin = Infinity, vmax = -Infinity;
    let absMax = 0;
    let any = false;
    let symmetric = forceSymmetric;

    for (let m = 1; m <= 12; m++) {
        const f = fetchMonth(m);
        if (!f || !f.values) continue;
        const stdTile = stdTileForMonth ? stdTileForMonth(m) : null;
        const d = decompose(f.values, nlat, nlon, mode, refForMonth(m),
                            { clamp, stdTile });
        if (d.empty) continue;       // anomaly without annualMean
        if (d.symmetric) symmetric = true;
        if (symmetric) {
            absMax = Math.max(absMax, Math.abs(d.vmin), Math.abs(d.vmax));
        } else {
            if (d.vmin < vmin) vmin = d.vmin;
            if (d.vmax > vmax) vmax = d.vmax;
        }
        any = true;
    }
    if (!any) return null;
    if (symmetric) return { vmin: -absMax, vmax: absMax, symmetric: true };
    return { vmin, vmax, symmetric: false };
}

/**
 * Compute the annual (12-month) mean of a field at a fixed (name, level) by
 * averaging whatever tiles are currently available. Requires a getter that
 * returns { values } for a given month (or null if the tile isn't in cache).
 *
 * getMonth(month) → Float32Array | null
 *
 * Returns Float32Array (nlat × nlon) of the mean, or null if no months are
 * cached yet. Uses only the months that are cached; caller can re-invoke
 * once more tiles arrive.
 */
export function annualMeanFrom(getMonth, nlat, nlon) {
    const N = nlat * nlon;
    const sum = new Float32Array(N);
    const count = new Uint8Array(N);
    let haveAny = false;
    for (let m = 1; m <= 12; m++) {
        const v = getMonth(m);
        if (!v) continue;
        haveAny = true;
        for (let i = 0; i < N; i++) {
            const x = v[i];
            if (Number.isFinite(x)) { sum[i] += x; count[i] += 1; }
        }
    }
    if (!haveAny) return null;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = count[i] > 0 ? sum[i] / count[i] : NaN;
    return out;
}
