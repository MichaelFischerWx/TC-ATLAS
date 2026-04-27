// GC-ATLAS — stationary-eddy Eliassen–Palm flux on the (lat, p) plane.
//
// From the monthly-mean fields u, v, w, t we form departures from the zonal
// mean ([·] denotes zonal mean):
//
//   u' = u - [u]    v' = v - [v]    θ' = θ - [θ]    where θ = T·(1000/p)^κ
//
// Then in quasi-geostrophic form (Edmon–Hoskins–McIntyre 1980):
//
//   F_φ = -a cos φ · [u'v']
//   F_p =  a cos φ · f · [v'θ'] / (∂[θ]/∂p)
//
// Divergence (the eddy forcing of [u]):
//
//   ∇·F = (1/(a cos φ))·∂(F_φ cos φ)/∂φ + ∂F_p/∂p
//
// IMPORTANT: This is the **stationary-eddy** EP flux — it captures wave
// activity carried by the time-mean field's longitudinal departures
// (e.g. planetary waves locked to topography / land–sea contrast). It does
// NOT include the transient-eddy contribution, which would require daily
// data. Label it that way in the UI.
//
// Output:
//   - values: ∇·F shading (m s⁻¹ day⁻¹) on the (nlev × nlat) panel grid
//   - arrows: per-(lat, level) (F_φ, F_p) for vector rendering, in panel-
//     normalised units so arrow length is visually proportional in (φ, log p)
//     space (Edmon–Hoskins–McIntyre convention).

import { cachedMonth } from './era5.js';
import { LEVELS, GRID } from './data.js';

const A_EARTH = 6.371e6;
const G       = 9.80665;
const OMEGA   = 7.2921e-5;
const KAPPA   = 0.2854;          // R_dry / cp
const D2R     = Math.PI / 180;
const DAY_SEC = 86400;
const DIV_UNIT = 1;              // m s⁻¹ day⁻¹  (typical |∇·F| ≈ 1–10)

// Subsample arrow positions so the panel doesn't get cluttered. One arrow
// every ARROW_LAT_STRIDE latitudes, and every ARROW_LEV_STRIDE levels.
// Values tuned for the standard panel; the renderer further trims arrows
// shorter than a dust threshold so the visible density stays sensible at
// any panel size.
const ARROW_LAT_STRIDE = 12;
const ARROW_LEV_STRIDE = 2;

/** NaN-safe zonal mean of a (nlat × nlon) tile, returning Float32Array(nlat). */
function zonalMean(tile, nlat, nlon) {
    const zm = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        let s = 0, n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const v = tile[row + j];
            if (Number.isFinite(v)) { s += v; n += 1; }
        }
        zm[i] = n > 0 ? s / n : NaN;
    }
    return zm;
}

/** NaN-safe zonal mean of (a · b) where a, b are co-located tiles, returning
 *  the zonal-mean COVARIANCE [a'b'] = [ab] - [a][b]. */
function zonalCov(tileA, tileB, nlat, nlon) {
    const cov = new Float32Array(nlat);
    const meanA = zonalMean(tileA, nlat, nlon);
    const meanB = zonalMean(tileB, nlat, nlon);
    for (let i = 0; i < nlat; i++) {
        let s = 0, n = 0;
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const a = tileA[row + j];
            const b = tileB[row + j];
            if (Number.isFinite(a) && Number.isFinite(b)) { s += a * b; n += 1; }
        }
        const meanAB = n > 0 ? s / n : NaN;
        cov[i] = (Number.isFinite(meanAB) && Number.isFinite(meanA[i]) && Number.isFinite(meanB[i]))
            ? meanAB - meanA[i] * meanB[i]
            : NaN;
    }
    return cov;
}

export function computeEPFlux(month, { seasonal = false } = {}) {
    const { nlat, nlon } = GRID;
    const nlev = LEVELS.length;

    // Zonal-mean θ at each level (for ∂[θ]/∂p in the stratification term),
    // plus zonal-mean covariances [u'v'] and [v'θ']  at each (k, lat).
    const Th_zm  = new Float32Array(nlev * nlat);     // [θ] (k,i)
    const cov_uv = new Float32Array(nlev * nlat);     // [u'v']
    const cov_vT = new Float32Array(nlev * nlat);     // [v'θ']
    const u_zm   = new Float32Array(nlev * nlat);     // for context (not used in QG form)

    for (let k = 0; k < nlev; k++) {
        const tU = cachedMonth('u', month, LEVELS[k], 'mean', 'default', null, seasonal);
        const tV = cachedMonth('v', month, LEVELS[k], 'mean', 'default', null, seasonal);
        const tT = cachedMonth('t', month, LEVELS[k], 'mean', 'default', null, seasonal);
        if (!tU || !tV || !tT) return null;
        const thetaFactor = Math.pow(1000 / LEVELS[k], KAPPA);
        // Compose θ tile in-place into a temporary array.
        const tTh = new Float32Array(tT.length);
        for (let i = 0; i < tT.length; i++) {
            const v = tT[i];
            tTh[i] = Number.isFinite(v) ? v * thetaFactor : NaN;
        }
        const thZ = zonalMean(tTh, nlat, nlon);
        const uZ  = zonalMean(tU,  nlat, nlon);
        const cuv = zonalCov(tU, tV, nlat, nlon);
        const cvT = zonalCov(tV, tTh, nlat, nlon);
        for (let i = 0; i < nlat; i++) {
            Th_zm [k * nlat + i] = thZ[i];
            u_zm  [k * nlat + i] = uZ[i];
            cov_uv[k * nlat + i] = cuv[i];
            cov_vT[k * nlat + i] = cvT[i];
        }
    }

    // ∂[θ]/∂p with centred differences on pressure (Pa).
    const dThdp = new Float32Array(nlev * nlat);
    for (let i = 0; i < nlat; i++) {
        for (let k = 0; k < nlev; k++) {
            let dp, num;
            if (k === 0) {
                dp  = (LEVELS[1] - LEVELS[0]) * 100;
                num = Th_zm[1 * nlat + i] - Th_zm[0 * nlat + i];
            } else if (k === nlev - 1) {
                dp  = (LEVELS[nlev - 1] - LEVELS[nlev - 2]) * 100;
                num = Th_zm[(nlev - 1) * nlat + i] - Th_zm[(nlev - 2) * nlat + i];
            } else {
                dp  = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
                num = Th_zm[(k + 1) * nlat + i] - Th_zm[(k - 1) * nlat + i];
            }
            dThdp[k * nlat + i] = num / dp;     // K / Pa
        }
    }

    // Coriolis parameter f(lat).
    const fCor = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        fCor[i] = 2 * OMEGA * Math.sin(lat * D2R);
    }

    // F_φ, F_p on the (k, i) grid in SI.
    //   F_φ = -a cos φ · [u'v']            units: m³ s⁻²
    //   F_p =  a cos φ · f · [v'θ'] / (∂[θ]/∂p)   units: Pa·m²·s⁻²
    const Fphi = new Float32Array(nlev * nlat);
    const Fp   = new Float32Array(nlev * nlat);
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        const cosPhi = Math.cos(lat * D2R);
        const aCos = A_EARTH * cosPhi;
        for (let k = 0; k < nlev; k++) {
            const idx = k * nlat + i;
            const cuv = cov_uv[idx];
            const cvT = cov_vT[idx];
            const dth = dThdp[idx];
            if (!Number.isFinite(cuv) || cosPhi < 1e-3) {
                Fphi[idx] = NaN;
            } else {
                Fphi[idx] = -aCos * cuv;
            }
            // ∂θ/∂p is negative in the troposphere — ratio v'θ'/(∂θ/∂p) carries
            // the right sign. Tiny |∂θ/∂p| near the model top can blow up; cap.
            if (!Number.isFinite(cvT) || !Number.isFinite(dth) ||
                Math.abs(dth) < 1e-7 || cosPhi < 1e-3) {
                Fp[idx] = NaN;
            } else {
                Fp[idx] = aCos * fCor[i] * cvT / dth;
            }
        }
    }

    // ∇·F = (1/(a cos φ)) · ∂(F_φ cos φ)/∂φ + ∂F_p/∂p     units: m³ s⁻² / m = m² s⁻²
    // To get the eddy forcing ON [u]: divide by (a cos φ). Convert to m s⁻¹ day⁻¹.
    const divF = new Float32Array(nlev * nlat);
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        const cosPhi = Math.cos(lat * D2R);
        const aCos = A_EARTH * cosPhi;
        const iN = Math.max(0, i - 1);
        const iS = Math.min(nlat - 1, i + 1);
        const dPhi = (iS - iN) * D2R;
        for (let k = 0; k < nlev; k++) {
            const idx = k * nlat + i;
            const FphiN = Fphi[k * nlat + iN] * Math.cos((90 - iN) * D2R);
            const FphiS = Fphi[k * nlat + iS] * Math.cos((90 - iS) * D2R);
            // Note: latitude index increases southward, so iS is south of iN.
            // ∂/∂φ in the *northward-positive* sense → (north - south) / (φN - φS).
            // φN > φS, and (iS - iN) is positive in degree-units, so dividing by
            // -dPhi flips to north-positive.
            let dFphi_dphi;
            if (Number.isFinite(FphiN) && Number.isFinite(FphiS) && cosPhi > 1e-3 && dPhi > 0) {
                dFphi_dphi = (FphiN - FphiS) / -dPhi;
            } else {
                divF[idx] = NaN; continue;
            }

            let dFp_dp;
            if (k === 0) {
                const dp = (LEVELS[1] - LEVELS[0]) * 100;
                dFp_dp = (Fp[1 * nlat + i] - Fp[0 * nlat + i]) / dp;
            } else if (k === nlev - 1) {
                const dp = (LEVELS[nlev - 1] - LEVELS[nlev - 2]) * 100;
                dFp_dp = (Fp[(nlev - 1) * nlat + i] - Fp[(nlev - 2) * nlat + i]) / dp;
            } else {
                const dp = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
                dFp_dp = (Fp[(k + 1) * nlat + i] - Fp[(k - 1) * nlat + i]) / dp;
            }

            if (!Number.isFinite(dFp_dp) || !Number.isFinite(aCos) || aCos === 0) {
                divF[idx] = NaN; continue;
            }
            // ∇·F in m² s⁻²; eddy momentum forcing on [u] = (∇·F)/(a cos φ) m/s²
            // Convert to m/s/day for readability.
            const div_si = dFphi_dphi / aCos + dFp_dp;
            const force_per_day = (div_si / aCos) * DAY_SEC / DIV_UNIT;
            divF[idx] = force_per_day;
            if (Number.isFinite(force_per_day)) {
                if (force_per_day < vmin) vmin = force_per_day;
                if (force_per_day > vmax) vmax = force_per_day;
            }
        }
    }
    if (!Number.isFinite(vmin)) { vmin = -1; vmax = 1; }
    // Symmetric, clamped range so the divergent colormap centres on zero
    // and extreme outliers near the boundaries don't squash the interior.
    let absMax = Math.max(Math.abs(vmin), Math.abs(vmax));
    if (absMax > 20) absMax = 20;
    if (absMax < 1) absMax = 1;
    vmin = -absMax; vmax = absMax;

    // Build the arrow sample grid. Visual normalisation (Edmon–Hoskins–McIntyre):
    // we plot vectors in (φ, log p) space, so the components must be scaled
    // into the same display units. We use:
    //   dx ∝ F_φ        (will be scaled to panel-φ in the renderer)
    //   dy ∝ F_p · A    where A is a heuristic giving the vertical leg
    //                   visual parity with the horizontal one.
    // The renderer normalises further so the longest arrow fits ~12° of lat.
    const arrowLats = [];
    const arrowPress = [];
    const arrowDx   = [];
    const arrowDy   = [];
    let absFphiMax = 0, absFpMax = 0;
    for (let i = 0; i < nlat; i++) {
        for (let k = 0; k < nlev; k++) {
            const fp = Fphi[k * nlat + i];
            const vp = Fp  [k * nlat + i];
            if (Number.isFinite(fp) && Math.abs(fp) > absFphiMax) absFphiMax = Math.abs(fp);
            if (Number.isFinite(vp) && Math.abs(vp) > absFpMax)   absFpMax   = Math.abs(vp);
        }
    }
    if (absFphiMax === 0) absFphiMax = 1;
    if (absFpMax   === 0) absFpMax   = 1;
    // Vertical-component visual gain: we want a 1:1 visual contribution between
    // F_φ at its max and F_p at its max in (φ, log p) panel space.
    const vGain = absFphiMax / absFpMax;
    for (let i = ARROW_LAT_STRIDE; i < nlat; i += ARROW_LAT_STRIDE) {
        const lat = 90 - i;
        if (Math.abs(lat) > 80) continue;
        for (let k = 0; k < nlev; k++) {
            const fp = Fphi[k * nlat + i];
            const vp = Fp  [k * nlat + i];
            if (!Number.isFinite(fp) || !Number.isFinite(vp)) continue;
            arrowLats.push(lat);
            arrowPress.push(LEVELS[k]);
            arrowDx.push(fp);
            arrowDy.push(vp * vGain);
        }
    }

    return {
        kind: 'zonal',
        type: 'pl',
        values: divF,
        vmin, vmax,
        levels: LEVELS.slice(),
        name: 'EP flux (stationary eddy)',
        units: 'm s⁻¹ day⁻¹',
        isSymmetric: true,
        isDiagnostic: true,
        arrows: {
            lats:  Float32Array.from(arrowLats),
            pressures: Float32Array.from(arrowPress),
            dx:    Float32Array.from(arrowDx),
            dy:    Float32Array.from(arrowDy),
        },
    };
}
