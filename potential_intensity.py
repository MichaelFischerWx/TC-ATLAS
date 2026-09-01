"""Gridded potential intensity, ventilation index, and ventilated PI.

The physics core behind the RT Monitor's real-time MPI / VI / vPI overlay
layers. Everything here operates on 2-D (lat, lon) grids — the GFS 0.25°
analysis grid in production — and is deliberately free of any GFS/GCS
plumbing so it can be unit-tested and reused offline.

Three quantities, in dependency order:

  MPI   Bister & Emanuel (2002) maximum potential intensity, via tcpyPI
        (Gilford's vectorized BE-2002 port). Wrapped in a numba `prange`
        driver so a global grid costs seconds, not minutes.

  VI    Tang & Emanuel (2012) ventilation index, VI = V_shear · χ_m / PI.

  vPI   Chavas, Camargo & Tippett (2025) ventilated potential intensity —
        the equilibrium upper-branch solution of the T&E theory, i.e. the
        intensity a storm can actually reach once ventilation is accounted
        for. vPI = PI · f(VI/VI_max), f given in closed form below.

Validated against the authors' own MATLAB reference implementation and
published fields (Chavas 2025, Purdue Research Repository
doi:10.4231/EY35-9M10): `calculation_files_PI_vPI/{ventilation,pcmin,
Vp_VIreduced_calc}.m` and `Data4Figs/Data_Fig3/*.mat`. Deviations are
deliberate and flagged inline.

Re-audited 2026-08-28 against Chavas's successor package **tcpyVPI 1.1.0**
(github.com/drchavas/tcpyVPI, doi:10.5281/zenodo.19319996). Its 1.1.0
release fixed two results-changing unit bugs in its own input handling —
surface pressure passed to tcpyPI in Pa instead of hPa (~25% PI high
bias), and specific humidity passed as mixing ratio (~2% more) — neither
of which ever existed here: build_env_overlays converts PRMSL/100 and
q/(1−q)·1000 explicitly, and `pi_grid` masks on IFL (which tcpyVPI did
not even check before 1.1.0). Our trigonometric vPI closed form matches
tcpyVPI's verbatim Cardano code to 4e-15 over VI ∈ [0, VI_max]. Notably,
tcpyVPI's own parameter choices moved TOWARD ours relative to the 2025
MATLAB: it runs CKCD=0.9 + reversible ascent (we do too; the paper used
0.7 + pseudoadiabatic) and 850-200 shear (we do too; the paper used
850-250). Where it still differs from us: V_reduc=1.0 (we keep 0.8),
the standard L_v=2.501e6 (we keep Bryan 2008's inflated 2.555e6, the
pairing Bryan recommends for pseudoadiabatic entropy), NO disc/annulus
averaging for χ_m (pointwise; we keep the MATLAB's spatial averaging,
which is the right model of a hypothetical storm's environment on a
map), and vPI above VI_max emitted as NaN rather than the MATLAB's 0
(ours keeps 0 = "no equilibrium TC", which is the physically meaningful
answer for a map). It also adds a genesis index,
GPIv = (102.1·vPI·η_c)^4.9·cos(lat)·dx·dy, which we do not compute.

The same audit surfaced a code-vs-paper discrepancy in the published
bundle itself: the paper text puts the entropy deficit at 600 hPa
(following Hoogewind et al. 2019) with 850-200 shear, while the archived
setup_ventilation.m ran 700 hPa and 850-250. This module originally
followed the MATLAB (700); on 2026-08-28 CHI_MID_HPA moved to 600,
which is what T&E, Hoogewind, the paper text, tcpyVPI, and the storm
page's favorability.py all agree on. The regional validation table
above was computed at 700 and its VI values will read slightly
differently at 600; the reference .mat fields themselves appear to have
been produced with the MATLAB's 700/850-250 settings.

Three independent checks, all passed:

 1. The closed-form vPI here agrees with the reference's Cardano-radical
    form to floating point (max |Δ| = 3.3e-16 over VI ∈ [0, VI_max]).
 2. The χ_m NUMERATOR agrees to 1-2% with this repo's wholly separate
    Bryan-2008 reversible-entropy implementation
    (build_era5_chi_m_indices.compute_chi_m_grid) on identical GFS input
    — two different entropy formulations, same answer, as they should be
    since the constant offsets cancel in a difference.
 3. Regional values land on Chavas's published ERA5 annual-mean
    climatology. His numbers vs one GFS analysis (2026-08-11 12Z):

        region     Chavas VI   here    Chavas vPI
        Atl MDR      0.292     0.257     48.8 kt
        W Pac        0.103     0.162    117.8 kt
        E Pac        0.170     0.116     96.5 kt

    Do not be alarmed by large VI: in Chavas's own published field 77% of
    valid ocean (59% of the tropics) exceeds VI_max = 0.145 and VI reaches
    810. A ventilation index far above the genesis threshold is the normal
    state of most of the ocean most of the time.

── Parameter conventions ──────────────────────────────────────────────

PI is not a single number — it depends on C_k/C_D, the ascent assumption,
and whether the answer is a gradient wind or a 10 m wind. We follow the
GC-ATLAS convention (see Gen_Circ/pipeline/build_mpi.py) rather than
Chavas's, for one concrete reason: the MPI *anomaly* layer differences the
real-time field against the GC-ATLAS 1991-2020 monthly MPI climatology, and
that subtraction is only meaningful if both sides used identical PI
parameters. V_reduc=0.8 also makes the map's knots comparable to best-track
Vmax, which is what an operational user will do with it.

    TC-ATLAS / GC-ATLAS   CKCD=0.9  reversible ascent  V_reduc=0.8
    Chavas et al. (2025)  CKCD=0.7  pseudoadiabatic    V_reduc=1.0

The two differ by ~10% in absolute PI (PI ∝ √(C_k/C_D) · V_reduc). To
reproduce Chavas's published values instead, set PI_PARAMS_CHAVAS below —
but then rebuild the GC-ATLAS MPI tiles to match before trusting anomalies.
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np

log = logging.getLogger("tc-atlas.potential_intensity")

# ── Thermodynamic constants ───────────────────────────────────────────
# Match Chavas's setup_ventilation.m exactly. Note L_V is the INFLATED
# Bryan (2008) value used for pseudoadiabatic entropy — not the standard
# 2.501e6. This is the reference implementation's choice and it matters:
# the entropy deficit scales directly with it.
R_D = 287.04       # J/(kg K)
R_V = 461.50       # J/(kg K)
EPSILON = R_D / R_V
C_PD = 1005.7      # J/(kg K)
L_V = 2.555e6      # J/kg — inflated (Bryan 2008), per setup_ventilation.m

# ── Tunable physics parameters ────────────────────────────────────────
PI_CKCD = 0.9           # ratio C_k/C_D
PI_ASCENT_FLAG = 0      # 0 = reversible, 1 = pseudoadiabatic
PI_DISS_FLAG = 1        # dissipative heating on
PI_V_REDUC = 0.8        # gradient wind → 10 m wind
PI_PTOP = 50.0          # hPa, top of the PI integration
PI_MISS_HANDLE = 1      # tcpyPI's NaN policy for missing mixing ratio

# Chavas et al. (2025) exact — swap in to reproduce their published fields.
PI_PARAMS_CHAVAS = dict(ckcd=0.7, ascent_flag=1, v_reduc=1.0)

CHI_MID_HPA = 600.0     # entropy-deficit level. 600 hPa is what T&E
                        # (2012), Hoogewind et al. (2019), the Chavas
                        # et al. (2025) paper TEXT ("calculated at 600
                        # hPa, following Hoogewind"), tcpyVPI, and the
                        # storm page (favorability.py) all use. The lone
                        # dissenter is the archived MATLAB bundle
                        # (setup_ventilation.m: pmid = 70000 Pa), which
                        # this module originally followed — a code-vs-
                        # paper discrepancy in the published bundle
                        # itself. Switched 700 → 600 on 2026-08-28, and
                        # Chavas confirmed 600 is the intended level
                        # (pers. comm. to M. Fischer, 2026-09). The
                        # docstring's regional validation numbers predate
                        # the switch. build_era5_vpi_indices.py stays at
                        # 700 until its planned rebuild (the GC-ATLAS
                        # ERA5 manifest doesn't index 600 hPa).
CHI_R_INNER_KM = 100.0  # hypothetical inner-core disc (saturation entropy)
CHI_R_OUTER_KM = 300.0  # hypothetical environmental annulus outer radius

SHEAR_LOW_HPA = 850     # T&E 2012 deep-layer shear. Chavas's 2025 MATLAB
SHEAR_UPP_HPA = 200     # used 850-250, but his tcpyVPI now uses 850-200 too.

VI_MAX = 0.145          # genesis/ventilation threshold, Hoogewind et al. (2020)

# Latitude band the PI solve is restricted to. This is a TC product and
# the BE-2002 iteration is the expensive step (~224 µs per ocean cell on
# one core), so solving the Southern Ocean and the Arctic buys nothing.
# 50° comfortably covers the poleward edge of TC activity — the
# highest-latitude tropical systems in the Atlantic and WPac top out
# around 45-50°.
PI_LAT_MAX = 50.0

MS_TO_KT = 1.0 / 0.514444


# ── Bister-Emanuel PI over a grid ─────────────────────────────────────

def _build_pi_driver():
    """Compile the numba `prange` driver that calls tcpyPI per grid cell.

    tcpyPI's `pi()` is an njit scalar function — it can't take 3-D arrays,
    so something has to loop. The obvious `xr.apply_ufunc(vectorize=True)`
    (what GC-ATLAS's build_mpi.py does) is a Python-level loop at ~144
    µs/cell; calling the same njit function from an njit driver instead
    drops that to ~10 µs/cell threaded, ~35 µs/cell on a single core,
    because the per-call Python dispatch overhead disappears.

    Built lazily so importing this module doesn't pay numba's compile
    cost, and so environments without tcpyPI can still import the χ_m /
    vPI helpers below (which are pure numpy).
    """
    from numba import njit, prange
    from tcpyPI import pi as _pi_scalar

    # `pi` must be an njit Dispatcher for the driver below to call it from
    # nopython code. It is in tcpypi <= 1.4; in 1.4.1 it became a plain
    # Python wrapper around a private `_pi_numba`, and numba then fails deep
    # inside compilation with the unhelpful "Untyped global name
    # '_pi_scalar'". Fail loudly and actionably here instead. Do NOT "fix"
    # this by reaching for `_pi_numba`: 1.4.1 also added an
    # `outflow_source` option that can change PI, and the validation in this
    # module's docstring was all done against 1.4.
    if not hasattr(_pi_scalar, "py_func"):
        raise RuntimeError(
            "tcpyPI.pi is not numba-compiled (got %r). Install tcpypi==1.4 — "
            "1.4.1 moved the jit to a private _pi_numba and changed the "
            "outflow-source default." % type(_pi_scalar))

    @njit(parallel=True, cache=True)
    def _pi_grid(sst_c, msl_hpa, p_hpa, t_c, r_gkg,
                 ckcd, ascent_flag, diss_flag, v_reduc, ptop, miss_handle):
        ny, nx = sst_c.shape
        nz = p_hpa.size
        vmax = np.full((ny, nx), np.nan)
        pmin = np.full((ny, nx), np.nan)
        t_out = np.full((ny, nx), np.nan)
        ifl = np.zeros((ny, nx))
        for j in prange(ny):
            # Per-row float64 scratch for the two profile columns. The
            # 3-D inputs stay float32 (they arrive that way from cfgrib):
            # upcasting them whole would add ~380 MB on a 23-level 0.25°
            # grid, which is most of a 2 GiB job's headroom. Copying 23
            # values per cell instead is free next to the BE iteration,
            # and tcpyPI still sees the float64 it expects.
            tcol = np.empty(nz, dtype=np.float64)
            rcol = np.empty(nz, dtype=np.float64)
            for i in range(nx):
                s = sst_c[j, i]
                # NaN SST is the land mask — skip. tcpyPI itself bails on
                # SST <= 5 C, but checking here avoids the call entirely.
                if np.isnan(s) or s <= 5.0:
                    continue
                for k in range(nz):
                    tcol[k] = t_c[k, j, i]
                    rcol[k] = r_gkg[k, j, i]
                v, p_min, flag, to, _otl = _pi_scalar(
                    s, msl_hpa[j, i], p_hpa, tcol, rcol,
                    ckcd, ascent_flag, diss_flag, v_reduc, ptop, miss_handle)
                vmax[j, i] = v
                pmin[j, i] = p_min
                t_out[j, i] = to
                ifl[j, i] = flag
        return vmax, pmin, t_out, ifl

    return _pi_grid


_PI_GRID = None


def pi_grid(sst_c: np.ndarray, msl_hpa: np.ndarray, p_hpa: np.ndarray,
            t_c: np.ndarray, r_gkg: np.ndarray, *,
            ckcd: float = PI_CKCD,
            ascent_flag: int = PI_ASCENT_FLAG,
            diss_flag: int = PI_DISS_FLAG,
            v_reduc: float = PI_V_REDUC) -> dict:
    """Bister-Emanuel PI over a (lat, lon) grid.

    sst_c    : (ny, nx) sea-surface temperature, °C. NaN = land.
    msl_hpa  : (ny, nx) mean sea level pressure, hPa.
    p_hpa    : (nz,)    pressure levels, hPa, DESCENDING (1000 → 50).
    t_c      : (nz, ny, nx) temperature, °C.
    r_gkg    : (nz, ny, nx) mixing ratio, g/kg (NOT specific humidity).

    Returns {vmax_ms, pmin_hpa, t_out_k, asdeq, ifl}, all (ny, nx), with
    non-converged cells (IFL != 1) masked to NaN.

    The level ordering is load-bearing: tcpyPI's docstring claims ascending
    but the algorithm integrates from the surface upward and silently
    returns IFL=0 for ascending input. GC-ATLAS hit this too — see the
    comment in Gen_Circ/pipeline/build_mpi.py:361.
    """
    if p_hpa[0] < p_hpa[-1]:
        raise ValueError(
            "p_hpa must be DESCENDING (1000 → 50 hPa); tcpyPI returns "
            "IFL=0 for ascending input")
    if t_c.shape[0] != p_hpa.size or r_gkg.shape[0] != p_hpa.size:
        raise ValueError(
            f"profile arrays must lead with the level axis of size "
            f"{p_hpa.size}; got t_c{t_c.shape} r_gkg{r_gkg.shape}")

    global _PI_GRID
    if _PI_GRID is None:
        _PI_GRID = _build_pi_driver()

    # The 2-D fields are cheap to upcast; the 3-D profiles are not, so they
    # go in at whatever float dtype they arrive with (see the scratch-column
    # note in the driver).
    vmax, pmin, t_out, ifl = _PI_GRID(
        np.ascontiguousarray(sst_c, dtype=np.float64),
        np.ascontiguousarray(msl_hpa, dtype=np.float64),
        np.ascontiguousarray(p_hpa, dtype=np.float64),
        np.ascontiguousarray(t_c),
        np.ascontiguousarray(r_gkg),
        float(ckcd), int(ascent_flag), int(diss_flag),
        float(v_reduc), float(PI_PTOP), int(PI_MISS_HANDLE))

    # IFL == 1 is "converged and valid". 0 = hypercane / no convergence,
    # 2 = the CAPE subroutine failed. Mask everything else.
    ok = (ifl == 1)
    vmax = np.where(ok, vmax, np.nan)
    pmin = np.where(ok, pmin, np.nan)
    t_out = np.where(ok, t_out, np.nan)

    asdeq = air_sea_disequilibrium(vmax, t_out, sst_c, ckcd=ckcd,
                                   v_reduc=v_reduc)
    return {"vmax_ms": vmax, "pmin_hpa": pmin, "t_out_k": t_out,
            "asdeq": asdeq, "ifl": ifl}


def air_sea_disequilibrium(vmax_ms: np.ndarray, t_out_k: np.ndarray,
                           sst_c: np.ndarray, *, ckcd: float = PI_CKCD,
                           v_reduc: float = PI_V_REDUC) -> np.ndarray:
    """Air-sea enthalpy disequilibrium (s*_SST − s_b), J/(kg·K).

    This is the DENOMINATOR of the non-dimensional entropy deficit χ_m,
    and getting it from the PI algorithm — rather than computing s*_SST
    and s_b separately from gridded T/q — is what Tang & Emanuel (2012)
    actually specify. Their supplement (ES128, final paragraph) is
    explicit: the disequilibrium is "evaluated at the radius of maximum
    wind for a TC at its potential intensity using the same algorithm from
    Bister and Emanuel (2002)". Chavas's pcmin.m returns it as AIRSEA:

        AIRSEA = VMAX² · (1/CKCD) · T_o / (T_s (T_s − T_o))

    which is just their eq. (S9) solved for (s*_SST − s_b). tcpyPI doesn't
    return AIRSEA, but it does return T_o, so we reconstruct it here.

    NB: VMAX must be the GRADIENT wind. tcpyPI has already multiplied by
    V_reduc on the way out, so we divide it back off. Skipping that step
    with V_reduc=0.8 would shrink the disequilibrium by 36% and inflate
    every χ_m accordingly. (Chavas runs V_reduc=1.0, so his code has no
    such term and the omission is easy to miss.)
    """
    sst_k = np.asarray(sst_c, dtype=float) + 273.15
    v_grad = np.asarray(vmax_ms, dtype=float) / max(v_reduc, 1e-6)
    denom = sst_k * (sst_k - t_out_k)
    with np.errstate(invalid="ignore", divide="ignore"):
        asdeq = v_grad ** 2 * (1.0 / ckcd) * t_out_k / denom
    return np.where(np.isfinite(asdeq) & (denom > 0), asdeq, np.nan)


# ── Entropy / χ_m ─────────────────────────────────────────────────────

def _sat_vapor_pressure_pa(t_k: np.ndarray) -> np.ndarray:
    """Bolton (1980) saturation vapor pressure, Pa. Same expression as
    ventilation.m (which writes the denominator as 243.5 + T[°C]; that is
    algebraically identical to the T[K] − 29.65 form used elsewhere in
    this repo)."""
    t_c = t_k - 273.15
    return 611.2 * np.exp(17.67 * t_c / (243.5 + t_c))


def entropy_fields(t_mid_k: np.ndarray, q_mid: np.ndarray, *,
                   p_mid_hpa: float = CHI_MID_HPA
                   ) -> tuple[np.ndarray, np.ndarray]:
    """Mid-level saturation entropy s*_m and actual entropy s_m, J/(kg·K).

    Pseudoadiabatic entropy with the inflated L_v, exactly as
    ventilation.m computes `sstarm` and `sm`. Note this is a SIMPLER form
    than the reversible Bryan-2008 entropy used by favorability.py and
    build_era5_chi_m_indices.py — no (c_pd + r·c_l) heat capacity term.
    That is the reference implementation's choice, and since χ_m's
    numerator is a difference of two entropies the constant offsets
    largely cancel; the L_v value does not.

    t_mid_k : (ny, nx) temperature at p_mid, K
    q_mid   : (ny, nx) specific humidity at p_mid, kg/kg
    """
    p_mid_pa = p_mid_hpa * 100.0
    e_star = _sat_vapor_pressure_pa(t_mid_k)

    # Saturation: r* from e*, dry partial pressure p_d = p/(1 + r*/eps).
    r_star = EPSILON * e_star / np.maximum(p_mid_pa - e_star, 1e-3)
    pd_star = p_mid_pa / (1.0 + r_star / EPSILON)
    s_star = (C_PD * np.log(t_mid_k) - R_D * np.log(pd_star)
              + L_V * r_star / t_mid_k)

    # Actual: mixing ratio from specific humidity, then RH from the
    # vapor pressure implied by that mixing ratio.
    r_m = np.asarray(q_mid, dtype=float) / np.maximum(1.0 - q_mid, 1e-12)
    pd = p_mid_pa / (1.0 + r_m / EPSILON)
    vap_pres = r_m * pd / EPSILON
    rh = np.minimum(vap_pres / np.maximum(e_star, 1e-6), 1.0)
    s_m = (C_PD * np.log(t_mid_k) - R_D * np.log(pd)
           + L_V * r_m / t_mid_k
           - R_V * r_m * np.log(np.maximum(rh, 0.01)))
    return s_star, s_m


def chi_m_grid(s_star_disc: np.ndarray, s_m_annulus: np.ndarray,
               asdeq: np.ndarray) -> np.ndarray:
    """Non-dimensional mid-level entropy deficit χ_m (T&E 2012 eq. S12).

        χ_m = (s*_m − s_m) / (s*_SST − s_b)

    s_star_disc  : s*_m already averaged over the hypothetical 0-100 km
                   inner-core disc.
    s_m_annulus  : s_m already averaged over the 100-300 km environmental
                   annulus.
    asdeq        : air-sea disequilibrium from `air_sea_disequilibrium`.

    Follows ventilation.m's guards exactly: the numerator is clamped at 0
    (no supersaturation), the denominator floored at 1 J/(kg·K), and cells
    with a NET ENTHALPY FLUX INTO THE OCEAN (asdeq < 0) are dropped —
    χ_m is not defined there.
    """
    num = np.maximum(0.0, s_star_disc - s_m_annulus)
    with np.errstate(invalid="ignore", divide="ignore"):
        chi = num / np.maximum(asdeq, 1.0)
    return np.where(np.isfinite(chi) & (asdeq >= 0), chi, np.nan)


# ── Ventilation index and ventilated PI ───────────────────────────────

PI_FLOOR_MS = 20.0   # ~39 kt — below this VI is meaningless, see below


def ventilation_index(shear_ms: np.ndarray, chi_m: np.ndarray,
                      pi_ms: np.ndarray, *,
                      pi_floor_ms: float = PI_FLOOR_MS) -> np.ndarray:
    """VI = V_shear · χ_m / PI (T&E 2012 eq. S13), dimensionless.

    `shear_ms` must be the ENVIRONMENTAL shear with the TC circulation
    already removed — see `remove_tc_vortex` and the note in
    ventilation.m line 5.

    Cells with PI below `pi_floor_ms` are masked. This is a DISPLAY
    choice, not a correction: the reference merely floors the divisor at
    1 m/s (`vi = shear.*chim./max(pi,1)`) and its own published field
    runs to VI = 810, because where PI collapses toward zero the quotient
    runs away. Every such cell already means "no TC possible", which VI
    says at 0.145, so the runaway values carry no information and would
    wreck the hover readout's scale. Pass `pi_floor_ms=0` to reproduce
    the reference exactly.

    NB: mask this only for the VI layer. Feeding a masked VI into
    `vpi_from` turns "vPI is zero here" into "no data here" — see the
    two-call pattern in build_env_overlays._compute_pi_family.
    """
    with np.errstate(invalid="ignore", divide="ignore"):
        vi = shear_ms * chi_m / np.maximum(pi_ms, 1.0)
    ok = np.isfinite(pi_ms) & (pi_ms >= pi_floor_ms)
    return np.where(ok, vi, np.nan)


def vpi_from(pi_ms: np.ndarray, vi: np.ndarray, *,
             vi_max: float = VI_MAX) -> np.ndarray:
    """Ventilated potential intensity, m/s (Chavas et al. 2025).

    vPI = PI · f(VI/VI_max), where f is the equilibrium upper-branch
    solution of the T&E (2012) theory — Komaček, Chavas & Abbott (2020)
    eq. 7. The reference `Vp_VIreduced_calc.m` writes f in Cardano radical
    form, which needs complex arithmetic because both terms are complex
    below the threshold and only their sum is real. We use the equivalent
    trigonometric form of the same root, which is real throughout:

        f = (2/√3) · cos( (1/3) · arccos(−VI/VI_max) )

    Verified equal to the MATLAB radical form to floating-point precision
    (max |Δ| = 3.3e-16 over VI ∈ [0, VI_max]). Anchors from the reference:
    f(0) = 1 (unventilated), f(VI_max) = 1/√3 ≈ 0.5774 (the weakest storm
    ventilation can sustain). Above the threshold, vPI = 0 — no
    equilibrium TC exists.
    """
    r = np.asarray(vi, dtype=float) / vi_max
    frac = (2.0 / np.sqrt(3.0)) * np.cos(np.arccos(-np.clip(r, 0.0, 1.0)) / 3.0)
    vpi = np.where(r <= 1.0, np.asarray(pi_ms, dtype=float) * frac, 0.0)
    return np.where(np.isfinite(pi_ms) & np.isfinite(r), vpi, np.nan)


# ── Spatial averaging for χ_m ─────────────────────────────────────────
#
# T&E define χ_m at a TC's location: s*_m averaged over the inner-core
# disc, s_m over the surrounding environmental annulus. On a MAP there is
# no storm at most points, so — following ventilation.m — every grid cell
# is treated as a HYPOTHETICAL storm center and the same two averages are
# taken around it. That turns both averages into convolutions.
#
# The reference samples 8 azimuths at a few discrete radii and weights by
# r (an area weight, since area ∝ r dr dθ). A uniform-weight kernel over
# the disc/annulus is the exact continuum limit of that, and it uses every
# grid cell instead of 16-24 interpolated points, so it is both cheaper
# and less noisy. Kernel radii are in grid cells, fixed globally, so the
# effective physical radius shrinks with cos(lat) — the same approximation
# build_env_overlays.disc_smooth already makes, and acceptable for a
# tropical diagnostic.

def _radial_kernel(r_in_km: float, r_out_km: float,
                   km_per_cell: float) -> np.ndarray:
    """Normalized disc (r_in=0) or annulus kernel of the given radii."""
    r_out = max(1, int(round(r_out_km / km_per_cell)))
    r_in = r_in_km / km_per_cell
    yy, xx = np.ogrid[-r_out:r_out + 1, -r_out:r_out + 1]
    d = np.sqrt(xx * xx + yy * yy)
    k = ((d <= r_out) & (d >= r_in)).astype(np.float64)
    total = k.sum()
    if total <= 0:
        raise ValueError(f"empty kernel for radii {r_in_km}-{r_out_km} km "
                         f"at {km_per_cell:.1f} km/cell")
    return k / total


def radial_mean(field: np.ndarray, r_in_km: float, r_out_km: float,
                km_per_cell: float) -> np.ndarray:
    """NaN-aware area-average of `field` over a disc or annulus.

    Longitude wraps (mode="wrap") so the dateline isn't a seam. NaNs
    (land) are excluded from both numerator and denominator rather than
    poisoning the neighborhood, so coastal cells average over whatever
    ocean is in range instead of going NaN.
    """
    from scipy.ndimage import convolve
    k = _radial_kernel(r_in_km, r_out_km, km_per_cell)
    valid = np.isfinite(field).astype(np.float64)
    filled = np.where(np.isfinite(field), field, 0.0)
    num = convolve(filled, k, mode="wrap")
    den = convolve(valid, k, mode="wrap")
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    return np.where(den > 0.05, out, np.nan)


# ── TC vortex removal ─────────────────────────────────────────────────

def _harmonic_inpaint(sub: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Replace masked cells by the harmonic (Laplace) extension of the
    surrounding values. Direct sparse solve of ∇²φ = 0 inside `mask` with
    Dirichlet data taken from the unmasked ring around it.

    Neighbors that are themselves NaN (land) are dropped from the 5-point
    stencil rather than propagating NaN — effectively a zero-flux face,
    which is the sensible coastal behavior. If a masked cell ends up with
    no usable neighbor at all it is left untouched.
    """
    import scipy.sparse as sp
    import scipy.sparse.linalg as spla

    ny, nx = sub.shape
    idx = -np.ones((ny, nx), dtype=np.int64)
    ji = np.argwhere(mask)
    if ji.size == 0:
        return sub
    idx[mask] = np.arange(len(ji))

    rows, cols, vals = [], [], []
    rhs = np.zeros(len(ji))
    for n, (j, i) in enumerate(ji):
        diag = 0.0
        for dj, di in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            jj, ii = j + dj, i + di
            if not (0 <= jj < ny and 0 <= ii < nx):
                continue          # outside the sub-window: treat as no-flux
            if mask[jj, ii]:
                rows.append(n); cols.append(idx[jj, ii]); vals.append(-1.0)
                diag += 1.0
            else:
                v = sub[jj, ii]
                if not np.isfinite(v):
                    continue      # land neighbor: drop the face
                rhs[n] += v
                diag += 1.0
        if diag == 0.0:
            diag = 1.0
            rhs[n] = sub[j, i] if np.isfinite(sub[j, i]) else 0.0
        rows.append(n); cols.append(n); vals.append(diag)

    A = sp.csr_matrix((vals, (rows, cols)), shape=(len(ji), len(ji)))
    try:
        sol = spla.spsolve(A, rhs)
    except Exception as e:                      # pragma: no cover
        log.warning("inpaint solve failed (%s); leaving field untouched", e)
        return sub

    out = sub.copy()
    out[mask] = sol
    return out


def remove_tc_vortex(field: np.ndarray, lats: np.ndarray, lons: np.ndarray,
                     centers, *, radius_km: float = 500.0,
                     radii_km: Optional[list] = None,
                     km_per_cell: float = 27.8) -> np.ndarray:
    """Excise TC circulations from a SCALAR field and fill the hole with
    the harmonic extension of the surrounding environment.

    WHY NOT JUST SMOOTH: build_env_overlays.disc_smooth suppresses the TC
    in the SHEAR field because a vortex's u/v anomaly is roughly
    antisymmetric about the center, so an area average largely cancels it.
    PI's inputs are different: MSLP, the warm core in T, and the moistened
    q column are all MONOPOLE anomalies, and area-averaging a monopole
    does not cancel it — it just spreads the same signed error over a
    wider disc. Removal has to be explicit.

    WHY IT MATTERS: Tang & Emanuel's supplement (ES128) notes that a TC
    "will reflect a local minimum in the potential intensity that is not
    representative", and works around it by sampling PI three days ahead
    along the track. That trick is available to a track-following point
    diagnostic but not to a map, so a map has to remove the vortex in
    space instead. Left uncorrected, every active storm punches a spurious
    PI hole into its own environment.

    Measured on GFS 2026-08-11 12Z at a WPac TC (995.5 hPa center): the
    fill raised MSLP by 8.8 hPa and dried q700 by 2.0 g/kg, which moved
    MPI at the center from 132.5 kt to 154.5 kt — a 22 kt artifact, 28 kt
    at its worst over the disc — and χ_m from 0.385 to 0.437. Note the
    SIGN: removing the storm RAISES PI. The deep low on its own would
    raise the disequilibrium, but the storm's warm, near-saturated column
    cuts it by more, so the net signature is the local minimum T&E
    describe rather than a bullseye high.

    field    : (ny, nx) or (nz, ny, nx). 3-D input is inpainted per level.
    lats     : (ny,) latitudes, any monotonic order.
    lons     : (nx,) longitudes, same convention as the field.
    centers  : iterable whose first two elements are (lat, lon). Any
               further elements are IGNORED — `detect_tc_centers` returns
               (lat, lon, depth_hPa), and reading that depth as a radius
               silently shrinks the mask to a single cell.
    radii_km : optional per-center removal radius. Must match `centers`
               in length; otherwise `radius_km` applies to all.
    """
    if radii_km is not None and len(radii_km) != len(centers):
        raise ValueError(
            f"radii_km has {len(radii_km)} entries for {len(centers)} "
            f"centers")
    if field.ndim == 3:
        return np.stack([
            remove_tc_vortex(field[k], lats, lons, centers,
                             radius_km=radius_km, radii_km=radii_km,
                             km_per_cell=km_per_cell)
            for k in range(field.shape[0])])

    out = np.asarray(field, dtype=float).copy()
    ny, nx = out.shape
    lon_span = 360.0

    for n, c in enumerate(centers):
        clat, clon = float(c[0]), float(c[1])
        rad = float(radii_km[n]) if radii_km is not None else float(radius_km)
        pad = int(np.ceil(rad / km_per_cell)) + 2

        j0 = int(np.argmin(np.abs(lats - clat)))
        # Wrap-safe nearest longitude.
        dlon = (lons - clon + 180.0) % lon_span - 180.0
        i0 = int(np.argmin(np.abs(dlon)))

        js = np.arange(j0 - pad, j0 + pad + 1)
        js = js[(js >= 0) & (js < ny)]
        if js.size == 0:
            continue
        iw = np.arange(i0 - pad, i0 + pad + 1) % nx      # wraps at ±180

        sub = out[np.ix_(js, iw)]
        sub_lat = lats[js][:, None]
        sub_dlon = ((lons[iw] - clon + 180.0) % lon_span - 180.0)[None, :]
        # Local flat-earth distance is plenty at these radii.
        dy = (sub_lat - clat) * 111.32
        dx = sub_dlon * 111.32 * np.cos(np.radians(np.clip(sub_lat, -89, 89)))
        mask = (dx * dx + dy * dy) <= rad * rad
        # Never inpaint over land — there is no storm there to remove and
        # the harmonic fill would invent values inside the land mask.
        mask &= np.isfinite(sub)
        if not mask.any():
            continue
        out[np.ix_(js, iw)] = _harmonic_inpaint(sub, mask)

    return out


def detect_tc_centers(mslp_hpa: np.ndarray, cyc_vort: np.ndarray,
                      lats: np.ndarray, lons: np.ndarray, *,
                      km_per_cell: float = 27.8,
                      lat_max: float = 45.0,
                      min_depth_hpa: float = 2.0,
                      min_vort: float = 4.0,
                      bg_radius_km: float = 600.0,
                      min_sep_km: float = 500.0,
                      max_centers: int = 60) -> list:
    """Locate TC-like vortices from the analysis itself.

    Self-contained on purpose: seeding the vortex removal from a best-track
    or advisory feed would make this job depend on a service that can be
    late or down, and would miss the invests and pre-genesis disturbances
    that contaminate PI just as effectively as named storms do.

    A candidate is a cell that is simultaneously
      * a localized surface low — at least `min_depth_hpa` below the
        `bg_radius_km` disc-mean MSLP around it (a broad monsoon trough
        has little local deficit, a TC has a lot), and
      * cyclonic at 850 hPa above `min_vort` (units of 10⁻⁵ s⁻¹, already
        hemisphere-signed as build_vorticity emits it).

    Candidates are then taken strongest-first with a `min_sep_km`
    exclusion radius so one storm yields one center.

    False positives are cheap here — inpainting a genuine extratropical
    low barely moves PI, which is dominated by SST and the thermal
    profile — while a missed TC punches a real hole in the field. The
    defaults are deliberately permissive for that reason.

    Returns [(lat, lon, depth_hpa), ...] sorted by depth, deepest first.
    """
    bg = radial_mean(mslp_hpa, 0.0, bg_radius_km, km_per_cell)
    depth = bg - mslp_hpa

    lat2d = np.asarray(lats)[:, None] * np.ones((1, mslp_hpa.shape[1]))
    ok = (np.isfinite(depth) & np.isfinite(cyc_vort)
          & (depth >= min_depth_hpa)
          & (cyc_vort >= min_vort)
          & (np.abs(lat2d) <= lat_max))
    if not ok.any():
        return []

    js, iss = np.nonzero(ok)
    order = np.argsort(-depth[js, iss])
    js, iss = js[order], iss[order]

    centers: list = []
    for j, i in zip(js, iss):
        clat, clon = float(lats[j]), float(lons[i])
        too_close = False
        for (plat, plon, _d) in centers:
            dlat = (clat - plat) * 111.32
            dlon = ((clon - plon + 180.0) % 360.0 - 180.0) * 111.32 * \
                np.cos(np.radians(0.5 * (clat + plat)))
            if dlat * dlat + dlon * dlon < min_sep_km * min_sep_km:
                too_close = True
                break
        if too_close:
            continue
        centers.append((clat, clon, float(depth[j, i])))
        if len(centers) >= max_centers:
            break
    return centers


if __name__ == "__main__":
    # Fast self-test — no network, no tcpyPI. Covers the pieces that are
    # easy to break silently. Run: python3 potential_intensity.py
    logging.basicConfig(level=logging.INFO)

    # 1. vPI closed form vs the reference's Cardano-radical form
    #    (Vp_VIreduced_calc.m). Both solve the same cubic; the radical
    #    form needs complex arithmetic because only the SUM of its two
    #    terms is real below the threshold.
    def _chavas_frac(vi_in, vi_max=VI_MAX):
        x = np.asarray(vi_in, dtype=complex) / vi_max
        t1 = (1 / np.sqrt(3.0)) * (np.sqrt(x ** 2 - 1) - x) ** (1 / 3)
        t2 = (1 / 3.0) * (1 / t1)
        return np.where(np.real(x) > 1.0, 0.0, np.real(t1 + t2))

    vi_grid = np.linspace(0.0, VI_MAX, 101)
    ours = vpi_from(np.ones_like(vi_grid), vi_grid)
    ref = _chavas_frac(vi_grid)
    dmax = float(np.max(np.abs(ours - ref)))
    assert dmax < 1e-12, f"vPI disagrees with the MATLAB form by {dmax}"
    # Anchors quoted in the reference's own comments.
    assert abs(float(vpi_from(np.array([1.0]), np.array([0.0]))[0]) - 1.0) < 1e-12
    assert abs(float(vpi_from(np.array([1.0]), np.array([VI_MAX]))[0])
               - 0.5773502691896) < 1e-9
    assert float(vpi_from(np.array([1.0]), np.array([VI_MAX * 1.01]))[0]) == 0.0
    print(f"vPI closed form   OK  (max |Δ| vs MATLAB radical = {dmax:.1e}; "
          f"f(0)=1, f(VI_max)=0.5774, f(>VI_max)=0)")

    # 2. air_sea_disequilibrium inverts eq. (S9), and must be independent
    #    of C_k/C_D (PI² ∝ CKCD, and AIRSEA divides it back out) and of
    #    the gradient-wind reduction (which is undone internally).
    v10, t_o, sst = np.array([[70.0]]), np.array([[200.0]]), np.array([[28.0]])
    a1 = air_sea_disequilibrium(v10, t_o, sst, ckcd=0.9, v_reduc=0.8)
    a2 = air_sea_disequilibrium(v10 * np.sqrt(0.7 / 0.9), t_o, sst,
                                ckcd=0.7, v_reduc=0.8)
    a3 = air_sea_disequilibrium(v10 / 0.8, t_o, sst, ckcd=0.9, v_reduc=1.0)
    a1, a2, a3 = a1.item(), a2.item(), a3.item()
    assert abs(a1 - a2) < 1e-6, "AIRSEA leaked a CKCD dependence"
    assert abs(a1 - a3) < 1e-6, "AIRSEA leaked a V_reduc dependence"
    assert 20.0 < a1 < 80.0, f"AIRSEA {a1:.1f} off the T&E scale"
    print(f"air-sea disequil. OK  ({a1:.1f} J/(kg K); invariant to "
          f"C_k/C_D and V_reduc)")

    # 3. Harmonic inpainting removes a monopole and leaves the background.
    #    This is the case disc-smoothing cannot handle.
    ny, nx = 81, 81
    yy, xx = np.mgrid[0:ny, 0:nx]
    lats_t = 20.0 + (yy[:, 0] - 40) * 0.25
    lons_t = 140.0 + (xx[0] - 40) * 0.25
    background = 1012.0 + 0.02 * (xx - 40)          # gentle synoptic gradient
    r2 = (xx - 40.0) ** 2 + (yy - 40.0) ** 2
    storm = background - 25.0 * np.exp(-r2 / (2 * 4.0 ** 2))
    assert abs(storm[40, 40] - background[40, 40] + 25.0) < 0.5
    filled = remove_tc_vortex(storm, lats_t, lons_t, [(20.0, 140.0)],
                              radius_km=300.0, km_per_cell=27.8)
    err = abs(float(filled[40, 40] - background[40, 40]))
    assert err < 0.5, f"inpaint left {err:.2f} hPa of the vortex behind"
    far = np.abs(filled - storm) > 1e-9
    assert not far[0, :].any() and not far[-1, :].any(), "inpaint leaked outside"
    # The contrast with smoothing: a disc average spreads a monopole, and
    # leaves most of its amplitude at the center.
    from scipy.ndimage import uniform_filter
    smoothed = uniform_filter(storm, size=23)
    smooth_err = abs(float(smoothed[40, 40] - background[40, 40]))
    assert smooth_err > 2 * err
    print(f"vortex inpaint    OK  (residual {err:.3f} hPa vs {smooth_err:.2f} "
          f"hPa left by disc smoothing)")

    # 4. radial_mean: a disc mean over a linear field returns the field;
    #    an annulus excludes the center.
    lin = (xx * 1.0)
    disc = radial_mean(lin, 0.0, 100.0, 27.8)
    assert abs(float(disc[40, 40]) - 40.0) < 1e-9
    spike = np.zeros((ny, nx)); spike[40, 40] = 1.0
    ann = radial_mean(spike, 100.0, 300.0, 27.8)
    assert float(ann[40, 40]) == 0.0, "annulus kernel included its center"
    assert float(radial_mean(spike, 0.0, 100.0, 27.8)[40, 40]) > 0.0
    nan_field = lin.copy(); nan_field[:, :20] = np.nan
    assert np.isfinite(radial_mean(nan_field, 0.0, 100.0, 27.8)[40, 25]), \
        "NaN neighbors poisoned a coastal cell"
    print("radial mean       OK  (disc exact on a linear field; annulus "
          "excludes center; NaN-tolerant)")

    # 5. ventilation_index floor semantics — the distinction that decides
    #    whether vPI reads 0 or NaN over marginal water.
    shear = np.array([[15.0]]); chi = np.array([[0.5]]); weak = np.array([[5.0]])
    assert np.isnan(ventilation_index(shear, chi, weak)[0, 0])
    raw = ventilation_index(shear, chi, weak, pi_floor_ms=0.0)
    assert np.isfinite(raw[0, 0]) and raw[0, 0] > VI_MAX
    assert float(vpi_from(weak, raw)[0, 0]) == 0.0, \
        "unfloored VI must drive vPI to 0, not NaN"
    print("VI floor          OK  (floored -> NaN for display; unfloored -> "
          "vPI = 0)")
    print("\nall checks passed")
