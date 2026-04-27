// GC-ATLAS — Lorenz energy cycle (stationary-eddy form).
//
// From the monthly-mean fields u, v, w (= ω in Pa/s), t we form four
// reservoirs and four conversions on the global mass-weighted volume.
// Definitions follow Peixoto & Oort (1974, 1992 textbook), with the
// reference state taken as the global pressure-level mean of T:
//
//   T_ref(p) = global mean of T at pressure p
//   γ(p)     = κ T_ref/p - ∂T_ref/∂p             (K/Pa, the static-stability factor)
//   stability:  σ(p) = (R / γ(p))·(1/p) ; we work directly with γ.
//
//   T̂(φ, p) = [T] - T_ref       (zonal-mean departure from the global mean)
//   T*(λ, φ, p) = T - [T]         (stationary-eddy departure from the zonal mean)
//   u*, v*, ω*  defined likewise.
//
// Reservoirs (J/m², mass-weighted vertical integral over the column):
//   P_M = (R/2g) · ∫ T̂² / (γ · p) · dp · ⟨area⟩
//   P_E = (R/2g) · ∫ ⟨T*²⟩ / (γ · p) · dp
//   K_M = (1/2g) · ∫ ([u]² + [v]²) · dp
//   K_E = (1/2g) · ∫ ⟨u*² + v*²⟩ · dp
//
// (⟨·⟩ denotes the area-weighted horizontal mean over the globe.)
//
// The leading factor is R/(2g), NOT cp/(2g) — this matches the canonical
// Holton-Hakim / Vallis / Tian-Zhang derivation and reproduces Peixoto-Oort
// 1992's P_M ≈ 4 MJ/m². An earlier draft used cp/(2g) and overshot by ~3.5×.
//
// Conversions (W/m²):
//   C(P_M → P_E) = -(R/g) · ∫ ⟨v*T*⟩ / (γ p) · ∂[T]/∂y · dp
//                  -(R/g) · ∫ ⟨ω*T*⟩ / (γ p) · ∂[T]/∂p · dp
//   C(P_E → K_E) = -(R/g) · ∫ ⟨ω*T*⟩ / p · dp           (eddy buoyancy flux)
//   C(K_M → K_E) =  (1/g) · ∫ ⟨u*v*⟩ cosφ · ∂([u]/cosφ)/∂y · dp        (eddy momentum)
//                  +(1/g) · ∫ ⟨u*ω*⟩ · ∂[u]/∂p · dp
//   C(P_M → K_M) = -(R/g) · ∫ [ω][T] / p · dp           (mean meridional circulation)
//
// Stationary-eddy only — transient terms (covariances of high-frequency
// departures from the monthly mean) require daily data and are out of scope.
// Returns SI numbers; caller renders them in a schematic.

import { cachedMonth } from './era5.js';
import { LEVELS, GRID } from './data.js';

const R_DRY = 287.04;
const CP    = 1004;
const KAPPA = R_DRY / CP;
const G     = 9.80665;
const A_E   = 6.371e6;
const D2R   = Math.PI / 180;

function nlev() { return LEVELS.length; }

/**
 * Lorenz (1955) reference state by adiabatic mass-resorting.
 *
 * The minimum-PE configuration places highest-θ parcels at the top and
 * lowest-θ at the bottom, preserving mass. For each discrete level
 * LEVELS[k], the reference T_r(p) is the value such that the mass with
 * θ > θ_r(p) equals the mass between p_top and LEVELS[k].
 *
 * Procedure:
 *   1. Collect (θ, w) for every (k, i, j) where w ∝ cosφ_i · Δp_k
 *      (drop constant dλ, dφ, a², 1/g — we only need ratios).
 *   2. Sort descending by θ.
 *   3. For each LEVELS[k], find the rank where cumulative w equals
 *      (LEVELS[k] / p_s) × total_w; θ at that rank is θ_r(LEVELS[k]).
 *   4. Convert θ_r → T_r via T_r = θ_r · (LEVELS[k]/1000)^κ.
 *
 * Returns null if any T tile is missing.
 */
function lorenzReferenceState(month) {
    const { nlat, nlon } = GRID;
    const N = nlev();

    // Layer thickness (Pa) around each pressure level. Half-distance to
    // neighbours; one-sided at the top and bottom.
    const dpLayer = new Float32Array(N);
    for (let k = 0; k < N; k++) {
        const pTop = k === 0     ? LEVELS[0]   * 100 : (LEVELS[k] + LEVELS[k - 1]) * 50;
        const pBot = k === N - 1 ? LEVELS[N-1] * 100 : (LEVELS[k] + LEVELS[k + 1]) * 50;
        dpLayer[k] = pBot - pTop;
    }
    const pSurface = LEVELS[N - 1] * 100;

    // Pre-load all temperature tiles; bail early if any are missing.
    const tiles = new Array(N);
    for (let k = 0; k < N; k++) {
        const tile = cachedMonth('t', month, LEVELS[k]);
        if (!tile) return null;
        tiles[k] = tile;
    }

    // Build flat (θ, w) arrays. cosφ < 1e-3 (poles) skipped — they carry no
    // mass anyway. Rough size: 12 levels × 181 lats × 360 lons ≈ 780k entries.
    const cosArr = new Float32Array(nlat);
    let cosSum = 0;
    for (let i = 0; i < nlat; i++) {
        const c = Math.max(0, Math.cos((90 - i) * D2R));
        cosArr[i] = c;
        cosSum += c;
    }

    // Pre-count valid entries so we can use typed arrays (faster sort).
    let nValid = 0;
    for (let k = 0; k < N; k++) {
        const tile = tiles[k];
        for (let i = 0; i < nlat; i++) {
            if (cosArr[i] < 1e-3) continue;
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                if (Number.isFinite(tile[row + j])) nValid++;
            }
        }
    }
    if (nValid === 0) return null;

    const thetas  = new Float64Array(nValid);
    const weights = new Float64Array(nValid);
    let idx = 0;
    let totalW = 0;
    for (let k = 0; k < N; k++) {
        const tile = tiles[k];
        const thetaFactor = Math.pow(1000 / LEVELS[k], KAPPA);
        const dp_k = dpLayer[k];
        for (let i = 0; i < nlat; i++) {
            const c = cosArr[i];
            if (c < 1e-3) continue;
            const w = c * dp_k;
            const row = i * nlon;
            for (let j = 0; j < nlon; j++) {
                const T = tile[row + j];
                if (!Number.isFinite(T)) continue;
                thetas[idx]  = T * thetaFactor;
                weights[idx] = w;
                idx++;
                totalW += w;
            }
        }
    }

    // Sort by θ descending. Build an index array so we sort in O(N log N)
    // without copying the value/weight pairs around.
    const order = new Uint32Array(nValid);
    for (let i = 0; i < nValid; i++) order[i] = i;
    order.sort((a, b) => thetas[b] - thetas[a]);

    // Walk down the sorted list accumulating w; find the rank that crosses
    // the cumulative-mass threshold for each pressure level. Linear-interpolate
    // θ between adjacent ranks for a smooth profile.
    const Tref = new Float32Array(N);
    let cumW = 0;
    let rank = 0;
    for (let k = 0; k < N; k++) {
        const targetW = (LEVELS[k] * 100 / pSurface) * totalW;
        // Advance rank until cumW would exceed targetW with the next parcel.
        while (rank < nValid && cumW + weights[order[rank]] < targetW) {
            cumW += weights[order[rank]];
            rank++;
        }
        let theta_r;
        if (rank >= nValid) {
            theta_r = thetas[order[nValid - 1]];
        } else if (rank === 0) {
            theta_r = thetas[order[0]];
        } else {
            // Linear interpolation between θ at rank-1 and θ at rank, weighted
            // by how far targetW lies between cumW and cumW+w_next.
            const wNext = weights[order[rank]];
            const frac = wNext > 0 ? (targetW - cumW) / wNext : 0;
            theta_r = thetas[order[rank - 1]] * (1 - frac) + thetas[order[rank]] * frac;
        }
        Tref[k] = theta_r * Math.pow(LEVELS[k] / 1000, KAPPA);
    }
    return Tref;
}

/** Area-weighted (cos φ) horizontal mean of a (nlat × nlon) field. NaN-safe. */
function areaMean(values, nlat, nlon) {
    let s = 0, w = 0;
    for (let i = 0; i < nlat; i++) {
        const lat = 90 - i;
        const cosPhi = Math.max(0, Math.cos(lat * D2R));
        const row = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const v = values[row + j];
            if (!Number.isFinite(v)) continue;
            s += v * cosPhi;
            w += cosPhi;
        }
    }
    return w > 0 ? s / w : NaN;
}

/** Zonal mean of a (nlat × nlon) tile → Float32Array(nlat). */
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

/** Trapezoidal integral of f(p) over LEVELS in Pa, NaN-safe (skip NaN sub-intervals). */
function trapInP(arr) {
    const n = arr.length;
    let s = 0;
    for (let k = 0; k < n - 1; k++) {
        const a = arr[k], b = arr[k + 1];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const dp = (LEVELS[k + 1] - LEVELS[k]) * 100;
        s += 0.5 * (a + b) * dp;
    }
    return s;
}

/** Centred-difference (or one-sided) ∂[T]/∂y in degrees K per metre at each lat,
 *  given a zonal-mean column (one value per latitude). Returns Float32Array. */
function dByDy(zm, nlat) {
    const out = new Float32Array(nlat);
    for (let i = 0; i < nlat; i++) {
        const iN = Math.max(0, i - 1);
        const iS = Math.min(nlat - 1, i + 1);
        const dyN = (90 - iN);                 // lat to north (deg)
        const dyS = (90 - iS);                 // lat to south
        const dy_m = (dyN - dyS) * D2R * A_E;  // metres
        const num = zm[iN] - zm[iS];           // north - south
        out[i] = (Number.isFinite(num) && dy_m !== 0) ? (num / dy_m) : NaN;
    }
    return out;
}

/** Centred-difference ∂X/∂p (Pa⁻¹) over the level dimension. arr indexed [k * nlat + i]. */
function dByDp_levels(arr, nlat, k, i) {
    const N = nlev();
    if (k === 0) {
        const dp = (LEVELS[1] - LEVELS[0]) * 100;
        return (arr[1 * nlat + i] - arr[0 * nlat + i]) / dp;
    }
    if (k === N - 1) {
        const dp = (LEVELS[N - 1] - LEVELS[N - 2]) * 100;
        return (arr[(N - 1) * nlat + i] - arr[(N - 2) * nlat + i]) / dp;
    }
    const dp = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
    return (arr[(k + 1) * nlat + i] - arr[(k - 1) * nlat + i]) / dp;
}

/**
 * Compute the Lorenz energy cycle for a given month.
 *
 * @param {number} month            1..12
 * @param {string} refType          'lorenz' (adiabatic-resorted reference state,
 *                                   Lorenz 1955 original) or 'simple'
 *                                   (area-mean of T at each pressure level — the
 *                                   common approximation used in most reanalysis
 *                                   diagnostics; underestimates P_M by ~3×).
 */
export function computeLorenzCycle(month, refType = 'lorenz') {
    const { nlat, nlon } = GRID;
    const N = nlev();

    // Pull every needed pressure-level tile up front. If anything is missing,
    // the panel can't render yet — return null and the caller will retry as
    // tiles arrive.
    const U = [], V = [], W = [], T = [];
    for (let k = 0; k < N; k++) {
        const u = cachedMonth('u', month, LEVELS[k]);
        const v = cachedMonth('v', month, LEVELS[k]);
        const w = cachedMonth('w', month, LEVELS[k]);
        const t = cachedMonth('t', month, LEVELS[k]);
        if (!u || !v || !w || !t) return null;
        U.push(u); V.push(v); W.push(w); T.push(t);
    }

    // Per-level reference state and zonal means.
    // Choice of reference state matters substantially — see refType arg.
    let Tref;
    if (refType === 'lorenz') {
        Tref = lorenzReferenceState(month);
        if (!Tref) return null;
    } else {
        Tref = new Float32Array(N);
        for (let k = 0; k < N; k++) Tref[k] = areaMean(T[k], nlat, nlon);
    }
    const dTrefDp = new Float32Array(N);
    const gamma = new Float32Array(N);             // K/Pa, static-stability factor
    const Tzm = new Array(N), Uzm = new Array(N), Vzm = new Array(N), Wzm = new Array(N);
    for (let k = 0; k < N; k++) {
        Tzm[k]  = zonalMean(T[k], nlat, nlon);
        Uzm[k]  = zonalMean(U[k], nlat, nlon);
        Vzm[k]  = zonalMean(V[k], nlat, nlon);
        Wzm[k]  = zonalMean(W[k], nlat, nlon);
    }
    for (let k = 0; k < N; k++) {
        let dT;
        if (k === 0) {
            dT = (Tref[1] - Tref[0]) / ((LEVELS[1] - LEVELS[0]) * 100);
        } else if (k === N - 1) {
            dT = (Tref[N - 1] - Tref[N - 2]) / ((LEVELS[N - 1] - LEVELS[N - 2]) * 100);
        } else {
            dT = (Tref[k + 1] - Tref[k - 1]) / ((LEVELS[k + 1] - LEVELS[k - 1]) * 100);
        }
        dTrefDp[k] = dT;
        const p = LEVELS[k] * 100;
        // γ = κ T_ref/p - ∂T_ref/∂p   (positive in the troposphere)
        gamma[k] = KAPPA * Tref[k] / p - dT;
    }

    // Per-(lat) and per-(level) area / zonal aggregates we need.
    // Stationary eddy products: ⟨T*²⟩, ⟨u*²+v*²⟩, ⟨v*T*⟩, ⟨ω*T*⟩, ⟨u*v*⟩, ⟨u*ω*⟩
    // Built level-by-level. T̂ = [T] - T_ref also lives here.
    const PE_int = new Float32Array(N);    // (cp/2g)·⟨T*²⟩/(γp) per level (vertical integrand, J/m²/Pa weighted by dp later)
    const KE_int = new Float32Array(N);    // (1/2g)·⟨u*²+v*²⟩ per level
    const PM_int = new Float32Array(N);    // (cp/2g)·area-mean(T̂²/(γp))
    const KM_int = new Float32Array(N);    // (1/2g)·area-mean([u]²+[v]²)

    // Conversion integrands (per level, in p):
    const cPMPE_y = new Float32Array(N);   // -(cp/g)·area-mean(⟨v*T*⟩/(γp) · ∂[T]/∂y)  (per level dp)
    const cPMPE_p = new Float32Array(N);   // -(cp/g)·area-mean(⟨ω*T*⟩/(γp) · ∂[T]/∂p)
    const cPEKE   = new Float32Array(N);   // -(R/g)·area-mean(⟨ω*T*⟩/p)
    const cKMKE_y = new Float32Array(N);   // (1/g)·area-mean(⟨u*v*⟩ · cos·∂([u]/cos)/∂y)
    const cKMKE_p = new Float32Array(N);   // (1/g)·area-mean(⟨u*ω*⟩ · ∂[u]/∂p)
    const cPMKM   = new Float32Array(N);   // -(R/g)·area-mean([ω][T]/p)   — note T̂ form below

    // For the meridional gradient ∂[T]/∂y we need [T] at each level and lat;
    // for ∂[T]/∂p and ∂[u]/∂p we need vertical neighbours.
    for (let k = 0; k < N; k++) {
        const p = LEVELS[k] * 100;
        const gp = gamma[k] * p;
        const cosArr = new Float32Array(nlat);
        let cosSum = 0;
        for (let i = 0; i < nlat; i++) {
            const c = Math.max(0, Math.cos((90 - i) * D2R));
            cosArr[i] = c;
            cosSum += c;
        }

        // d[T]/dy at this level
        const dTdy = dByDy(Tzm[k], nlat);
        // u/cosφ for ∂(u/cos)/∂y
        const uOverCos = new Float32Array(nlat);
        for (let i = 0; i < nlat; i++) {
            const c = cosArr[i];
            uOverCos[i] = c > 1e-3 ? Uzm[k][i] / c : NaN;
        }
        const dUcosDy = dByDy(uOverCos, nlat);

        // Build per-(lat) area-weighted accumulators.
        let acc_Tstar2 = 0, w_Tstar2 = 0;
        let acc_uv2    = 0, w_uv2    = 0;
        let acc_That2  = 0, w_That2  = 0;
        let acc_Kmean  = 0, w_Kmean  = 0;
        let acc_vTbar  = 0, acc_wTbar = 0, acc_uvbar = 0, acc_uwbar = 0;
        let acc_term_y = 0, acc_term_p = 0;
        let acc_PEKE   = 0;
        let acc_KMKE_y = 0, acc_KMKE_p = 0;
        let acc_PMKM   = 0;

        // (∂[T]/∂p, ∂[u]/∂p computed inline per-lat below.)

        for (let i = 0; i < nlat; i++) {
            const c = cosArr[i];
            if (c < 1e-3) continue;
            // Stationary-eddy moments at (k, i): integrate over longitude.
            let s_T2 = 0, s_u2v2 = 0, s_vT = 0, s_wT = 0, s_uv = 0, s_uw = 0;
            let n = 0;
            const Tk = T[k], Uk = U[k], Vk = V[k], Wk = W[k];
            const Tbar = Tzm[k][i], Ubar = Uzm[k][i], Vbar = Vzm[k][i], Wbar = Wzm[k][i];
            for (let j = 0; j < nlon; j++) {
                const idx = i * nlon + j;
                const Tv = Tk[idx], Uv = Uk[idx], Vv = Vk[idx], Wv = Wk[idx];
                if (!Number.isFinite(Tv) || !Number.isFinite(Uv) ||
                    !Number.isFinite(Vv) || !Number.isFinite(Wv)) continue;
                const Tp = Tv - Tbar, Up = Uv - Ubar, Vp = Vv - Vbar, Wp = Wv - Wbar;
                s_T2   += Tp * Tp;
                s_u2v2 += Up * Up + Vp * Vp;
                s_vT   += Vp * Tp;
                s_wT   += Wp * Tp;
                s_uv   += Up * Vp;
                s_uw   += Up * Wp;
                n += 1;
            }
            if (n === 0) continue;
            const T2_zon  = s_T2   / n;
            const uv2_zon = s_u2v2 / n;
            const vT_zon  = s_vT   / n;
            const wT_zon  = s_wT   / n;
            const uv_zon  = s_uv   / n;
            const uw_zon  = s_uw   / n;

            // T̂ = [T] - T_ref
            const That = (Number.isFinite(Tbar) ? Tbar : 0) - Tref[k];
            const Kmean_lat = (Ubar * Ubar + Vbar * Vbar);

            // ∂[T]/∂p and ∂[u]/∂p centred-diff at (k, i)
            let dTbar_dp, dUbar_dp;
            if (k === 0) {
                const dp = (LEVELS[1] - LEVELS[0]) * 100;
                dTbar_dp = (Tzm[1][i] - Tzm[0][i]) / dp;
                dUbar_dp = (Uzm[1][i] - Uzm[0][i]) / dp;
            } else if (k === N - 1) {
                const dp = (LEVELS[N - 1] - LEVELS[N - 2]) * 100;
                dTbar_dp = (Tzm[N - 1][i] - Tzm[N - 2][i]) / dp;
                dUbar_dp = (Uzm[N - 1][i] - Uzm[N - 2][i]) / dp;
            } else {
                const dp = (LEVELS[k + 1] - LEVELS[k - 1]) * 100;
                dTbar_dp = (Tzm[k + 1][i] - Tzm[k - 1][i]) / dp;
                dUbar_dp = (Uzm[k + 1][i] - Uzm[k - 1][i]) / dp;
            }

            // Reservoirs at this (k, i): area-weight by c.
            acc_Tstar2 += T2_zon * c;          w_Tstar2 += c;
            acc_uv2    += uv2_zon * c;         w_uv2    += c;
            acc_That2  += (That * That) * c;   w_That2  += c;
            acc_Kmean  += Kmean_lat * c;       w_Kmean  += c;

            // Conversion integrands at this (k, i): area-weight by c.
            // C(P_M → P_E)  -- meridional eddy heat flux acting on the gradient.
            if (Number.isFinite(dTdy[i]) && Number.isFinite(vT_zon))
                acc_term_y += vT_zon * dTdy[i] * c;
            // Plus the vertical-eddy-flux term acting on ∂[T]/∂p (small but include).
            if (Number.isFinite(dTbar_dp) && Number.isFinite(wT_zon))
                acc_term_p += wT_zon * dTbar_dp * c;

            // C(P_E → K_E) — eddy buoyancy flux  -(R/g)·⟨ω*T*⟩/p
            if (Number.isFinite(wT_zon))
                acc_PEKE += wT_zon * c;

            // C(K_M → K_E) — eddy momentum on the ∂([u]/cosφ)/∂y, plus vertical leg.
            if (Number.isFinite(dUcosDy[i]) && Number.isFinite(uv_zon))
                acc_KMKE_y += uv_zon * c * c * dUcosDy[i];   // include cosφ once explicitly
            if (Number.isFinite(dUbar_dp) && Number.isFinite(uw_zon))
                acc_KMKE_p += uw_zon * dUbar_dp * c;

            // C(P_M → K_M) — mean meridional circulation: -(R/g)·[ω]·T̂/p
            if (Number.isFinite(Wbar) && Number.isFinite(That))
                acc_PMKM += Wbar * That * c;
        }

        const cs = cosSum > 0 ? cosSum : 1;
        const Tstar2_g = w_Tstar2 > 0 ? acc_Tstar2 / w_Tstar2 : NaN;
        const uv2_g    = w_uv2    > 0 ? acc_uv2    / w_uv2    : NaN;
        const That2_g  = w_That2  > 0 ? acc_That2  / w_That2  : NaN;
        const Kmean_g  = w_Kmean  > 0 ? acc_Kmean  / w_Kmean  : NaN;

        // Reservoir per-level (units J/m²/Pa, integrate in p later).
        // R/(2g) is the canonical Vallis/Holton-Hakim leading factor.
        PE_int[k] = (R_DRY / (2 * G)) * (Tstar2_g / Math.max(gp, 1e-9));
        KE_int[k] = (1 / (2 * G)) * uv2_g;
        PM_int[k] = (R_DRY / (2 * G)) * (That2_g / Math.max(gp, 1e-9));
        KM_int[k] = (1 / (2 * G)) * Kmean_g;

        // Conversion per-level integrands (units W/m²/Pa, integrate in p later).
        cPMPE_y[k] = -(R_DRY / G) * (acc_term_y / cs) / Math.max(gp, 1e-9);
        cPMPE_p[k] = -(R_DRY / G) * (acc_term_p / cs) / Math.max(gp, 1e-9);
        cPEKE[k]   = -(R_DRY / G) * (acc_PEKE / cs) / p;
        cKMKE_y[k] = (1 / G) * (acc_KMKE_y / cs);
        cKMKE_p[k] = (1 / G) * (acc_KMKE_p / cs);
        cPMKM[k]   = -(R_DRY / G) * (acc_PMKM / cs) / p;
    }

    const PM = trapInP(PM_int);
    const PE = trapInP(PE_int);
    const KM = trapInP(KM_int);
    const KE = trapInP(KE_int);

    const C_PM_PE = trapInP(cPMPE_y) + trapInP(cPMPE_p);
    const C_PE_KE = trapInP(cPEKE);
    // K_E → K_M: positive when stationary eddies surrender momentum to the
    // zonal-mean flow (eddies decaying into the jet). The integrand
    // ⟨u*v*⟩ cosφ ∂([u]/cosφ)/∂y already carries the right sign.
    const C_KE_KM = trapInP(cKMKE_y) + trapInP(cKMKE_p);
    const C_PM_KM = trapInP(cPMKM);

    return {
        refType,
        reservoirs: { PM, PE, KM, KE },                       // J/m²
        conversions: { C_PM_PE, C_PE_KE, C_KE_KM, C_PM_KM },  // W/m²
    };
}
