// GC-ATLAS — zonal-mean moist-static-energy (MSE) budget on (lev, lat).
//
// MSE per unit mass: h = c_p·T + g·z + L_v·q  (J/kg).
//
// Per-mass tendency:
//   ∂[h]/∂t = -(1/(a cosφ))·∂([v][h] cosφ)/∂y - ∂([ω][h])/∂p     mean transport
//             -(1/(a cosφ))·∂([v*h*] cosφ)/∂y - ∂([ω*h*])/∂p     stationary eddies
//             + Q (atmospheric heating from surface fluxes + radiation)
//
// Column-integrated steady-state:
//   ∇·∫h·v dp = LH + SH + R_TOA - R_SFC
//   where LH = -slhf, SH = -sshf, R_TOA = tisr+ttr (net down at top),
//         R_SFC = ssr+str (net down at surface).
//
// Display forms:
//   form='h':  ∂[h]/(c_p·∂t) in K/day (interpretable as a "moist enthalpy
//              tendency in temperature units")
//   form='H':  same SI tendency, vertically integrated to W/m² (canonical
//              column-energy-budget form, directly comparable to surface +
//              TOA fluxes)
//
// Stationary eddies only — transients need daily data.
//
// Surface heating overlay: when 1D mode + slhf/sshf/ssr/str/tisr/ttr tiles
// cached, additional lines appear for LH+SH (turbulent), net column radiation,
// and total surface+TOA atmospheric heating that should equal -[transport].

import { cachedMonth } from './era5.js';
import { LEVELS, GRID } from './data.js';

const A_EARTH = 6.371e6;
const G       = 9.80665;
const D2R     = Math.PI / 180;
const DAY_SEC = 86400;
const CP      = 1004;          // J/(kg·K)
const L_V     = 2.501e6;       // J/kg
const Q_TO_SI = 1e-3;          // q stored as g/kg → divide by 1000 for kg/kg

function zonalMean(tile, nlat, nlon) {
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0, n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const v = tile[row + j];
            if (Number.isFinite(v)) { s += v; n += 1; }
        }
        out[i] = n > 0 ? s / n : NaN;
    }
    return out;
}

function zonalCov(tA, tB, mA, mB, nlat, nlon) {
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0, n = 0;
        const row = i * nlon;
        const ma = mA[i], mb = mB[i];
        if (!Number.isFinite(ma) || !Number.isFinite(mb)) { out[i] = NaN; continue; }
        for (let j = 0; j < nlon; j++) {
            const a = tA[row + j], b = tB[row + j];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            s += (a - ma) * (b - mb);
            n++;
        }
        out[i] = n > 0 ? s / n : NaN;
    }
    return out;
}

/** Compose MSE field h = c_p·T + g·z + L_v·q for a single tile. z is already
 *  in m (geopotential height, after era5.js's m²/s² → m conversion). */
function composeMSETile(t, z, q) {
    const out = new Float32Array(t.length);
    for (let i = 0; i < t.length; i++) {
        const T = t[i], Z = z[i], Q = q[i];
        if (!Number.isFinite(T) || !Number.isFinite(Z) || !Number.isFinite(Q)) {
            out[i] = NaN; continue;
        }
        out[i] = CP * T + G * Z + L_V * (Q * Q_TO_SI);
    }
    return out;
}

function computeHBudgetTerms(month, seasonal = false) {
    const { nlat, nlon } = GRID;
    const N = LEVELS.length;

    const U = [], V = [], W = [], H = [];
    for (let k = 0; k < N; k++) {
        const u = cachedMonth('u', month, LEVELS[k], 'mean', 'default', null, seasonal);
        const v = cachedMonth('v', month, LEVELS[k], 'mean', 'default', null, seasonal);
        const w = cachedMonth('w', month, LEVELS[k], 'mean', 'default', null, seasonal);
        const t = cachedMonth('t', month, LEVELS[k], 'mean', 'default', null, seasonal);
        const z = cachedMonth('z', month, LEVELS[k], 'mean', 'default', null, seasonal);
        const q = cachedMonth('q', month, LEVELS[k], 'mean', 'default', null, seasonal);
        if (!u || !v || !w || !t || !z || !q) return null;
        U.push(u); V.push(v); W.push(w);
        H.push(composeMSETile(t, z, q));
    }

    const cosphi = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) cosphi[i] = Math.cos((90 - i) * D2R);

    const Uzm = [], Vzm = [], Wzm = [], Hzm = [];
    const vhE = [], whE = [];
    for (let k = 0; k < N; k++) {
        const ub = zonalMean(U[k], nlat, nlon);
        const vb = zonalMean(V[k], nlat, nlon);
        const wb = zonalMean(W[k], nlat, nlon);
        const hb = zonalMean(H[k], nlat, nlon);
        Uzm.push(ub); Vzm.push(vb); Wzm.push(wb); Hzm.push(hb);
        vhE.push(zonalCov(V[k], H[k], vb, hb, nlat, nlon));
        whE.push(zonalCov(W[k], H[k], wb, hb, nlat, nlon));
    }

    const meanY = new Float32Array(N * nlat);
    const meanP = new Float32Array(N * nlat);
    const eddyY = new Float32Array(N * nlat);
    const eddyP = new Float32Array(N * nlat);

    for (let k = 0; k < N; k++) {
        for (let i = 0; i < nlat; i++) {
            const c = cosphi[i];
            const idx = k * nlat + i;
            if (c < 1e-3) {
                meanY[idx] = NaN; meanP[idx] = NaN;
                eddyY[idx] = NaN; eddyP[idx] = NaN;
                continue;
            }

            const iN = Math.max(0, i - 1);
            const iS = Math.min(nlat - 1, i + 1);
            const dy_m = A_EARTH * (iS - iN) * D2R;

            const fmN = Vzm[k][iN] * Hzm[k][iN] * cosphi[iN];
            const fmS = Vzm[k][iS] * Hzm[k][iS] * cosphi[iS];
            meanY[idx] = -((fmN - fmS) / dy_m) / c;

            let dWH_dp;
            if (k === 0) {
                const dp = (LEVELS[1] - LEVELS[0]) * 100;
                dWH_dp = (Wzm[1][i] * Hzm[1][i] - Wzm[0][i] * Hzm[0][i]) / dp;
            } else if (k === N - 1) {
                const dp = (LEVELS[N - 1] - LEVELS[N - 2]) * 100;
                dWH_dp = (Wzm[N - 1][i] * Hzm[N - 1][i] - Wzm[N - 2][i] * Hzm[N - 2][i]) / dp;
            } else {
                const dp = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
                dWH_dp = (Wzm[k + 1][i] * Hzm[k + 1][i] - Wzm[k - 1][i] * Hzm[k - 1][i]) / dp;
            }
            meanP[idx] = -dWH_dp;

            const eYN = vhE[k][iN] * cosphi[iN];
            const eYS = vhE[k][iS] * cosphi[iS];
            eddyY[idx] = -((eYN - eYS) / dy_m) / c;

            let duw_dp;
            if (k === 0) {
                const dp = (LEVELS[1] - LEVELS[0]) * 100;
                duw_dp = (whE[1][i] - whE[0][i]) / dp;
            } else if (k === N - 1) {
                const dp = (LEVELS[N - 1] - LEVELS[N - 2]) * 100;
                duw_dp = (whE[N - 1][i] - whE[N - 2][i]) / dp;
            } else {
                const dp = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
                duw_dp = (whE[k + 1][i] - whE[k - 1][i]) / dp;
            }
            eddyP[idx] = -duw_dp;
        }
    }

    const total  = new Float32Array(N * nlat);
    const source = new Float32Array(N * nlat);
    for (let i = 0; i < N * nlat; i++) {
        const my = Number.isFinite(meanY[i]) ? meanY[i] : 0;
        const mp = Number.isFinite(meanP[i]) ? meanP[i] : 0;
        const ey = Number.isFinite(eddyY[i]) ? eddyY[i] : 0;
        const ep = Number.isFinite(eddyP[i]) ? eddyP[i] : 0;
        const s = my + mp + ey + ep;
        total[i]  = s;
        source[i] = -s;
    }

    for (let pass = 0; pass < 3; pass++) {
        smoothLat(meanY,  N, nlat);
        smoothLat(meanP,  N, nlat);
        smoothLat(eddyY,  N, nlat);
        smoothLat(eddyP,  N, nlat);
        smoothLat(total,  N, nlat);
        smoothLat(source, N, nlat);
    }
    smoothLev(meanY,  N, nlat);
    smoothLev(meanP,  N, nlat);
    smoothLev(eddyY,  N, nlat);
    smoothLev(eddyP,  N, nlat);
    smoothLev(total,  N, nlat);
    smoothLev(source, N, nlat);

    return { meanY, meanP, eddyY, eddyP, total, source, N, nlat, cosphi, _month: month, _seasonal: seasonal };
}

const TERM_LABELS = {
    total:  'total',
    meanY:  'mean meridional',
    meanP:  'mean vertical',
    eddyY:  'eddy meridional',
    eddyP:  'eddy vertical',
    source: 'implied heating',
};

const SERIES_COLORS = {
    meanY:  { color: '#5A9CE0', label: 'mean meridional' },
    meanP:  { color: '#9B59B6', label: 'mean vertical' },
    eddyY:  { color: '#E08A4D', label: 'eddy meridional' },
    eddyP:  { color: '#D44E5E', label: 'eddy vertical' },
    source: { color: '#88BFA0', label: 'implied heating' },
    total:  { color: '#E8C26A', label: 'total' },
    turb:   { color: '#3FBFD9', label: 'LH + SH (turbulent)' },
    rad:    { color: '#C97AC2', label: 'net column radiation' },
    qNet:   { color: '#F0F0F0', label: 'total atm heating' },
};

/** Atmospheric heating components per latitude in W/m² (column integrated).
 *  Sign convention: positive = atmosphere gains energy. ERA5 surface fluxes
 *  are positive DOWNWARD (into surface), so atmospheric uptake = negation. */
function surfaceHeatingProfiles(month, seasonal = false) {
    const { nlat, nlon } = GRID;
    const slhf = cachedMonth('slhf', month, null, 'mean', 'default', null, seasonal);
    const sshf = cachedMonth('sshf', month, null, 'mean', 'default', null, seasonal);
    const ssr  = cachedMonth('ssr',  month, null, 'mean', 'default', null, seasonal);
    const str  = cachedMonth('str',  month, null, 'mean', 'default', null, seasonal);
    const tisr = cachedMonth('tisr', month, null, 'mean', 'default', null, seasonal);
    const ttr  = cachedMonth('ttr',  month, null, 'mean', 'default', null, seasonal);
    if (!slhf || !sshf || !ssr || !str || !tisr || !ttr) return null;

    const slhfZ = zonalMean(slhf, nlat, nlon);
    const sshfZ = zonalMean(sshf, nlat, nlon);
    const ssrZ  = zonalMean(ssr,  nlat, nlon);
    const strZ  = zonalMean(str,  nlat, nlon);
    const tisrZ = zonalMean(tisr, nlat, nlon);
    const ttrZ  = zonalMean(ttr,  nlat, nlon);

    const turb = new Float32Array(nlat);   // LH + SH atmospheric uptake
    const rad  = new Float32Array(nlat);   // R_TOA_net - R_SFC_net (atm column net rad)
    const tot  = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        const lh = -slhfZ[i];      // ERA5 slhf is downward (into sfc); atm gain = -slhf
        const sh = -sshfZ[i];
        const Rtoa = tisrZ[i] + ttrZ[i];        // net down at TOA
        const Rsfc = ssrZ[i]  + strZ[i];        // net down at surface
        const Rcol = Rtoa - Rsfc;               // atmospheric column net radiation
        turb[i] = lh + sh;
        rad[i]  = Rcol;
        tot[i]  = lh + sh + Rcol;
    }
    return { turb, rad, tot };
}

export function buildHBudgetView(month, opts = {}) {
    let term = opts.term || 'total';
    if (term === 'torque') term = 'source';
    const form = opts.form || 'h';
    const mode = opts.mode || '2d';
    const seasonal = !!opts.seasonal;

    const t = computeHBudgetTerms(month, seasonal);
    if (!t) return null;
    const { N, nlat, cosphi } = t;

    if (term === 'all' && (mode === '1d_mean' || mode === '1d_int')) {
        return buildAllTermsProfile(t, form, mode === '1d_int' ? 'integral' : 'mean');
    }

    const arr_si = t[term];
    if (!arr_si) return null;

    // arr_si is per-mass MSE tendency (J/kg/s). Convert to display unit.
    //   form='h': K/day  ⇒  arr_si / cp · DAY_SEC
    //   form='H': J/(kg·day) (display same form, vertical integral handles W/m²)
    const out = new Float32Array(arr_si.length);
    for (let i = 0; i < arr_si.length; i++) {
        const v = arr_si[i];
        if (form === 'h') {
            out[i] = Number.isFinite(v) ? (v / CP) * DAY_SEC : NaN;
        } else {
            // H form: scale by 1e-3 to put per-day MSE in kJ/kg/day for readability.
            out[i] = Number.isFinite(v) ? v * DAY_SEC / 1e3 : NaN;
        }
    }
    const unitsLabel = form === 'h' ? 'K day⁻¹' : 'kJ kg⁻¹ day⁻¹';
    const nameLabel  = `H budget · ${TERM_LABELS[term]}`;

    if (mode === '1d_mean') {
        const p_s = LEVELS[N - 1] * 100;
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            let s = 0;
            for (let k = 0; k < N - 1; k++) {
                const a = out[k * nlat + i], b = out[(k + 1) * nlat + i];
                if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                const dp = (LEVELS[k + 1] - LEVELS[k]) * 100;
                s += 0.5 * (a + b) * dp;
            }
            prof[i] = s / p_s;
        }
        let absMax = 0;
        for (const v of prof) if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
        if (absMax < 0.1) absMax = 0.1;
        return {
            kind: 'zonal', type: 'sl',
            values: prof, vmin: -absMax, vmax: absMax,
            name: nameLabel + ' · column-mean',
            units: unitsLabel,
            isSymmetric: true, isDiagnostic: true,
        };
    }

    if (mode === '1d_int') {
        // Vertical integral ∫ ∂h/∂t · (1/g) dp in W/m² (= J/m²/s).
        const prof = new Float32Array(nlat);
        let absMax = 0;
        for (let i = 0; i < nlat; i++) {
            let s = 0;
            for (let k = 0; k < N - 1; k++) {
                const aSI = arr_si[k * nlat + i];
                const bSI = arr_si[(k + 1) * nlat + i];
                if (!Number.isFinite(aSI) || !Number.isFinite(bSI)) continue;
                const dp = (LEVELS[k + 1] - LEVELS[k]) * 100;
                s += 0.5 * (aSI + bSI) * dp / G;
            }
            prof[i] = s;          // already W/m² (J/(kg·s) · kg/m² = W/m²)
            if (Number.isFinite(s) && Math.abs(s) > absMax) absMax = Math.abs(s);
        }
        if (absMax < 5)   absMax = 5;
        if (absMax > 300) absMax = 300;
        return {
            kind: 'zonal', type: 'sl',
            values: prof, vmin: -absMax, vmax: absMax,
            name: nameLabel + ' · vertical integral',
            units: 'W m⁻²',
            isSymmetric: true, isDiagnostic: true,
        };
    }

    // 2D
    const finiteAbs = [];
    for (const v of out) if (Number.isFinite(v)) finiteAbs.push(Math.abs(v));
    finiteAbs.sort((a, b) => a - b);
    let absMax = finiteAbs.length > 0
        ? finiteAbs[Math.floor(0.95 * (finiteAbs.length - 1))]
        : 1;
    if (absMax < (form === 'h' ? 0.5 : 5))  absMax = form === 'h' ? 0.5 : 5;
    if (absMax > (form === 'h' ? 30 : 300)) absMax = form === 'h' ? 30 : 300;
    return {
        kind: 'zonal', type: 'pl',
        values: out, vmin: -absMax, vmax: absMax,
        levels: LEVELS.slice(),
        name: nameLabel,
        units: unitsLabel,
        isSymmetric: true, isDiagnostic: true,
    };
}

function buildAllTermsProfile(terms, form, agg) {
    const { N, nlat, cosphi } = terms;
    const month = terms._month;
    const seasonal = !!terms._seasonal;
    const p_s = LEVELS[N - 1] * 100;

    const seriesKeys = ['meanY', 'meanP', 'eddyY', 'eddyP', 'total'];
    const profiles = {};
    let absMax = 0;

    for (const key of seriesKeys) {
        const arr_si = terms[key];
        const prof = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            let s = 0;
            for (let k = 0; k < N - 1; k++) {
                const aSI = arr_si[k * nlat + i];
                const bSI = arr_si[(k + 1) * nlat + i];
                if (!Number.isFinite(aSI) || !Number.isFinite(bSI)) continue;
                const dp = (LEVELS[k + 1] - LEVELS[k]) * 100;
                if (agg === 'integral') {
                    s += 0.5 * (aSI + bSI) * dp / G;        // → W/m²
                } else {
                    // Column-mean K/day if form='h', kJ/kg/day if form='H'.
                    const aDisp = (form === 'h') ? (aSI / CP) * DAY_SEC : aSI * DAY_SEC / 1e3;
                    const bDisp = (form === 'h') ? (bSI / CP) * DAY_SEC : bSI * DAY_SEC / 1e3;
                    s += 0.5 * (aDisp + bDisp) * dp;
                }
            }
            prof[i] = (agg === 'integral') ? s : s / p_s;
            if (Number.isFinite(prof[i]) && Math.abs(prof[i]) > absMax) absMax = Math.abs(prof[i]);
        }
        profiles[key] = prof;
    }

    // Surface heating overlays (W/m² intrinsic).
    const surf = month ? surfaceHeatingProfiles(month, seasonal) : null;
    const surfaceLines = [];
    if (surf) {
        const conv = (wm2) => {
            if (!Number.isFinite(wm2)) return NaN;
            if (agg === 'integral') return wm2;
            // For column-mean K/day: wm2 (W/m²) ÷ (mass·cp) = wm2·g/(p_s·cp) (K/s) → ×DAY_SEC
            if (form === 'h') return wm2 * G / (p_s * CP) * DAY_SEC;
            // For kJ/kg/day: wm2 ÷ mass × DAY/1e3
            return wm2 * G / p_s * DAY_SEC / 1e3;
        };
        const make = (arr, key) => {
            const v = new Float32Array(nlat);
            for (let i = 0; i < nlat; i++) v[i] = conv(arr[i]);
            surfaceLines.push({ values: v, color: SERIES_COLORS[key].color, label: SERIES_COLORS[key].label });
        };
        make(surf.turb, 'turb');
        make(surf.rad,  'rad');
        make(surf.tot,  'qNet');
        for (const s of surfaceLines) {
            for (const v of s.values) {
                if (Number.isFinite(v) && Math.abs(v) > absMax) absMax = Math.abs(v);
            }
        }
    }

    const units = (agg === 'integral')
        ? 'W m⁻²'
        : (form === 'h' ? 'K day⁻¹' : 'kJ kg⁻¹ day⁻¹');
    const suffix = (agg === 'integral') ? '· vertical integral' : '· column-mean';
    if (absMax < (agg === 'integral' ? 5 : 0.1)) absMax = (agg === 'integral' ? 5 : 0.1);

    return {
        kind: 'zonal', type: 'sl',
        values: profiles.total,
        vmin: -absMax, vmax: absMax,
        name: `H budget · all terms ${suffix}`,
        units,
        isSymmetric: true, isDiagnostic: true,
        series: [
            ...seriesKeys.map((k) => ({
                values: profiles[k],
                color:  SERIES_COLORS[k].color,
                label:  SERIES_COLORS[k].label,
            })),
            ...surfaceLines,
        ],
    };
}

function smoothLat(arr, N, nlat) {
    const tmp = new Float32Array(nlat);
    const W = [1, 4, 6, 4, 1];
    for (let k = 0; k < N; k++) {
        const off = k * nlat;
        for (let i = 0; i < nlat; i++) {
            let s = 0, w = 0;
            for (let m = -2; m <= 2; m++) {
                const ii = i + m;
                if (ii < 0 || ii >= nlat) continue;
                const v = arr[off + ii];
                if (!Number.isFinite(v)) continue;
                s += v * W[m + 2];
                w += W[m + 2];
            }
            tmp[i] = w > 0 ? s / w : NaN;
        }
        for (let i = 0; i < nlat; i++) arr[off + i] = tmp[i];
    }
}

function smoothLev(arr, N, nlat) {
    const tmp = new Float32Array(N);
    for (let i = 0; i < nlat; i++) {
        for (let k = 0; k < N; k++) {
            let s = 0, w = 0;
            for (let m = -1; m <= 1; m++) {
                const kk = k + m;
                if (kk < 0 || kk >= N) continue;
                const v = arr[kk * nlat + i];
                if (!Number.isFinite(v)) continue;
                const wt = m === 0 ? 2 : 1;
                s += v * wt;
                w += wt;
            }
            tmp[k] = w > 0 ? s / w : NaN;
        }
        for (let k = 0; k < N; k++) arr[k * nlat + i] = tmp[k];
    }
}
