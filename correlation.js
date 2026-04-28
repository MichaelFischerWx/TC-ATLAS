// Climatology Globe — index correlation kernel.
//
// Computes per-pixel Pearson correlation between an ERA5 field's annual
// time series (for a fixed month) and a climate index time series. Used
// to ask questions like "where is September SST most correlated with
// Atlantic ACE?" or "does the Madden-Julian projection onto MPI line up
// with expectations from theory?".
//
// Three anomaly modes determine how each year's pixel value is detrended
// before correlation:
//
//   raw      No detrending. Includes climate-change trend → can mistake
//            shared trends for shared variability.
//   fixed    Subtract the 1991-2020 (or chosen) climatology mean once.
//            Removes the mean state but keeps multidecadal drift.
//   sliding  For each year Y, subtract the mean of the closest available
//            30-yr window centered near Y. Removes the warming trend so
//            the correlation isolates interannual variability — the
//            recommended default for climate-vs-ACE analyses.
//
// p-value is computed analytically from Pearson r and sample size n via
// the t-distribution: t = r·√((n-2)/(1-r²)), df = n-2, two-tailed p.
// Cells with sample size < 10 (after NaN exclusion) get NaN r and p.
//
// API
//
//   computeACE(allTracks) -> { [basin]: { [year]: ace_x10⁴_kt² } }
//     Walks the IBTrACS dict and emits per-(basin, year) ACE,
//     defined as Σ v² over track points where v ≥ 35 kt at 6-hourly
//     synoptic times, scaled by 10⁻⁴. Basin codes match IBTrACS:
//     NA, EP, WP, NI, SI, SP, SA. Plus 'NH', 'SH', 'GLOBAL' aggregates.
//
//   anomalyTransform(yearGrids, mode, options) -> Float32Array[]
//     Applies raw / fixed / sliding-30 anomaly transform per pixel.
//     yearGrids is a [{ year, values: Float32Array(nlat·nlon) }, …] list.
//
//   correlate(yearGrids, indexSeries, options) -> { r, p, n }
//     Each output is a Float32Array(nlat·nlon). NaN where insufficient
//     data. n is the per-pixel valid sample count (Float32Array too,
//     useful for diagnostics).

const D2R = Math.PI / 180;
const KT_THRESH = 34;     // ACE counts only TS-strength fixes (≥34 kt).
const ACE_SCALE = 1e-4;   // Conventional 10⁴-kt² units.

// ── ACE per (basin, year) from IBTrACS ────────────────────────────
//
// Walks each track, picks 6-hourly synoptic times (00/06/12/18 UTC), and
// accumulates v² above 34 kt. Year is the year of the first fix at
// TS-strength — this matches IBTrACS / NHC convention better than using
// the genesis year (which can disagree by a day at season boundaries).
//
// Basin classification uses the SID prefix:
//   NA: North Atlantic, EP: East Pacific, WP: West Pacific
//   NI: North Indian, SI: South Indian, SP: South Pacific, SA: South Atlantic
// SID format: YYYYDDDHLLOOO where character 8 = hemisphere ('N' or 'S').
// Basin can be reliably read from the SID prefix in the chunked JSON
// (positions 9-10 in v04 format), but a cleaner approach uses the
// genesis lat/lon — fall back to lat/lon binning when SID parsing fails.

function _basinFromLatLon(la, lo) {
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    if (la >= 0) {
        if (lo >= -100 && lo <= 0)   return 'NA';   // North Atlantic
        if (lo > -180 && lo < -100)  return 'EP';   // East Pacific
        if (lo >= 100 || lo <= -180) return 'WP';   // West Pacific (wraps)
        if (lo >= 30  && lo < 100)   return 'NI';   // North Indian
        return null;
    }
    if (lo >= -70 && lo <= 20)   return 'SA';       // South Atlantic (rare)
    if (lo > 20  && lo <= 135)   return 'SI';       // South Indian
    return 'SP';                                    // South Pacific
}

function _parseUTC(t) {
    if (t == null) return null;
    if (typeof t === 'number') return new Date(t);
    const s = String(t);
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
    return new Date(s + 'Z');
}

export function computeACE(allTracks) {
    const out = {};   // basin → year → ACE
    const ensure = (b, y) => {
        if (!out[b]) out[b] = {};
        if (out[b][y] == null) out[b][y] = 0;
    };
    for (const sid in allTracks) {
        const track = allTracks[sid];
        if (!track || track.length === 0) continue;
        // Use first fix's lat/lon to classify basin (genesis location).
        const g = track.find(p => p && Number.isFinite(p.la) && Number.isFinite(p.lo));
        if (!g) continue;
        const basin = _basinFromLatLon(g.la, g.lo);
        if (!basin) continue;
        for (const p of track) {
            if (!p || !p.t || !Number.isFinite(p.w)) continue;
            const dt = _parseUTC(p.t);
            if (!dt) continue;
            // Synoptic 00/06/12/18 UTC only (matches NHC ACE definition;
            // IBTrACS interpolates 3-hourly so we filter).
            const h = dt.getUTCHours();
            if (h % 6 !== 0) continue;
            if (p.w < KT_THRESH) continue;
            const y = dt.getUTCFullYear();
            ensure(basin, y);
            out[basin][y] += p.w * p.w;
        }
    }
    // Scale + add aggregates.
    const basins = Object.keys(out);
    const years = new Set();
    for (const b of basins) for (const y of Object.keys(out[b])) years.add(+y);
    out.NH = {}; out.SH = {}; out.GLOBAL = {};
    for (const y of years) {
        let nh = 0, sh = 0;
        for (const b of basins) {
            const v = out[b][y] || 0;
            if (b === 'NA' || b === 'EP' || b === 'WP' || b === 'NI') nh += v;
            else sh += v;
        }
        out.NH[y]     = nh * ACE_SCALE;
        out.SH[y]     = sh * ACE_SCALE;
        out.GLOBAL[y] = (nh + sh) * ACE_SCALE;
    }
    for (const b of basins) {
        for (const y of Object.keys(out[b])) out[b][y] *= ACE_SCALE;
    }
    return out;
}

// ── Anomaly transforms ────────────────────────────────────────────

const SLIDING_WINDOWS = [
    [1961, 1990], [1966, 1995], [1971, 2000], [1976, 2005],
    [1981, 2010], [1986, 2015], [1991, 2020], [1996, 2025],
];
function _bestMatchWindow(year) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < SLIDING_WINDOWS.length; i++) {
        const [s, e] = SLIDING_WINDOWS[i];
        const center = (s + e) / 2;
        const d = Math.abs(center - year);
        if (d < bestD) { bestD = d; bestI = i; }
    }
    return SLIDING_WINDOWS[bestI];
}

function _windowMean(yearGrids, span) {
    const [s, e] = span;
    const includes = yearGrids.filter(g => g.year >= s && g.year <= e);
    if (includes.length === 0) return null;
    const npx = includes[0].values.length;
    const sum = new Float64Array(npx);
    const cnt = new Uint16Array(npx);
    for (const g of includes) {
        for (let i = 0; i < npx; i++) {
            const v = g.values[i];
            if (Number.isFinite(v)) { sum[i] += v; cnt[i] += 1; }
        }
    }
    const mean = new Float32Array(npx);
    for (let i = 0; i < npx; i++) mean[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
    return mean;
}

/**
 * @param {Array<{year, values: Float32Array}>} yearGrids — one grid per year
 * @param {'raw'|'fixed'|'sliding'} mode
 * @param {{fixedSpan?: [number, number]}} options — only used for fixed mode
 * @returns {Array<{year, values: Float32Array}>} — same shape, anomalies
 */
export function anomalyTransform(yearGrids, mode, options = {}) {
    if (mode === 'raw') return yearGrids;
    const npx = yearGrids[0].values.length;

    if (mode === 'fixed') {
        const span = options.fixedSpan || [1991, 2020];
        const clim = _windowMean(yearGrids, span);
        if (!clim) return yearGrids;
        return yearGrids.map(g => {
            const out = new Float32Array(npx);
            for (let i = 0; i < npx; i++) out[i] = g.values[i] - clim[i];
            return { year: g.year, values: out };
        });
    }

    if (mode === 'sliding') {
        // Cache window means; reuse across event years that share a window.
        const cache = new Map();
        const out = [];
        for (const g of yearGrids) {
            const span = _bestMatchWindow(g.year);
            const key = `${span[0]}_${span[1]}`;
            let clim = cache.get(key);
            if (!clim) {
                clim = _windowMean(yearGrids, span);
                cache.set(key, clim);
            }
            const arr = new Float32Array(npx);
            if (clim) {
                for (let i = 0; i < npx; i++) arr[i] = g.values[i] - clim[i];
            } else {
                for (let i = 0; i < npx; i++) arr[i] = NaN;
            }
            out.push({ year: g.year, values: arr });
        }
        return out;
    }

    throw new Error(`unknown anomaly mode: ${mode}`);
}

// ── Pearson correlation + p-value ────────────────────────────────
//
// For each pixel, compute r and p across the years where both the field
// and the index are finite. n_min=10 below which we set r=p=NaN — small
// samples give nonsense p-values.

const N_MIN = 10;

/**
 * Inverse of the regularized incomplete beta function, used to convert
 * t-statistic + df → two-tailed p-value via:
 *   p = I_x(df/2, 0.5)  where x = df / (df + t²)
 * We implement just enough of betainc here (continued fraction Lentz)
 * to get four-digit p in the tails we care about.
 */
function _betacf(a, b, x) {
    const MAXIT = 200, EPS = 3e-7, FPMIN = 1e-30;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPS) return h;
    }
    return h;
}
function _gammaln(x) {
    // Stirling-ish. Good to ~1e-10 for x > 1.
    const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
                 -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function _betainc(a, b, x) {
    if (x <= 0 || x >= 1) return x <= 0 ? 0 : 1;
    const lnBeta = _gammaln(a) + _gammaln(b) - _gammaln(a + b);
    const bt = Math.exp(-lnBeta + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * _betacf(a, b, x) / a;
    return 1 - bt * _betacf(b, a, 1 - x) / b;
}
/** Two-tailed p-value for Pearson r at sample size n. */
function _pFromRN(r, n) {
    if (!Number.isFinite(r) || n < 3) return NaN;
    const r2 = Math.max(0, Math.min(0.999999, r * r));
    const df = n - 2;
    const x = df / (df + (r2 / (1 - r2)) * df);
    return _betainc(df / 2, 0.5, x);
}

/**
 * @param {Array<{year, values: Float32Array}>} yearGrids — already anomaly-transformed
 * @param {{[year]: number}} indexSeries — index value per year
 * @returns {{r: Float32Array, p: Float32Array, n: Float32Array, npx: number}}
 */
export function correlate(yearGrids, indexSeries) {
    if (!yearGrids.length) {
        return { r: new Float32Array(0), p: new Float32Array(0), n: new Float32Array(0), npx: 0 };
    }
    const npx = yearGrids[0].values.length;
    const r = new Float32Array(npx);
    const p = new Float32Array(npx);
    const n = new Float32Array(npx);

    // Pre-pull the (year, index) pairs that have a numeric index value.
    const pairs = [];
    for (const g of yearGrids) {
        const yi = indexSeries[g.year];
        if (Number.isFinite(yi)) pairs.push({ values: g.values, idx: yi });
    }

    if (pairs.length < N_MIN) {
        r.fill(NaN); p.fill(NaN); n.fill(0);
        return { r, p, n, npx };
    }

    // For each pixel, accumulate sums; finalize Pearson + p afterward.
    // Single pass over years × pixels to keep it cache-friendly.
    const sumX  = new Float64Array(npx);
    const sumY  = new Float64Array(npx);
    const sumX2 = new Float64Array(npx);
    const sumY2 = new Float64Array(npx);
    const sumXY = new Float64Array(npx);
    const cnt   = new Uint16Array(npx);

    for (const pair of pairs) {
        const y = pair.idx;
        const v = pair.values;
        for (let i = 0; i < npx; i++) {
            const x = v[i];
            if (!Number.isFinite(x)) continue;
            sumX[i]  += x;
            sumY[i]  += y;
            sumX2[i] += x * x;
            sumY2[i] += y * y;
            sumXY[i] += x * y;
            cnt[i]   += 1;
        }
    }

    for (let i = 0; i < npx; i++) {
        const ni = cnt[i];
        n[i] = ni;
        if (ni < N_MIN) { r[i] = NaN; p[i] = NaN; continue; }
        const meanX = sumX[i] / ni;
        const meanY = sumY[i] / ni;
        const varX = sumX2[i] / ni - meanX * meanX;
        const varY = sumY2[i] / ni - meanY * meanY;
        const covXY = sumXY[i] / ni - meanX * meanY;
        if (varX <= 0 || varY <= 0) { r[i] = NaN; p[i] = NaN; continue; }
        const ri = covXY / Math.sqrt(varX * varY);
        r[i] = ri;
        p[i] = _pFromRN(ri, ni);
    }
    return { r, p, n, npx };
}
