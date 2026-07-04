"""Ventilation-index favorability — shared physics core.

Computes the Tang & Emanuel (2012) ventilation index

    VI = V_shear · χ_m / PI

for a single tropical-cyclone environment, where χ_m is the
non-dimensional mid-tropospheric (600 hPa) entropy deficit and PI is the
maximum potential intensity. Lower VI = more favorable for
intensification.

Design choices (kept deliberately cheap so this runs per-storm per-GFS-
cycle with no heavy dependencies — no numba/tcpyPI):

  * χ_m uses the SAME Bryan (2008) reversible-moist-entropy machinery as
    the ERA5 climatology builder (build_era5_chi_m_indices.py), copied
    here verbatim so the realtime value and the historical climo VI are
    on an identical scale. That equality is what makes "where does this
    storm sit in the climatological ΔV distribution" a valid comparison.
  * PI uses the DeMaria & Kaplan (1994) EMPIRICAL maximum potential
    intensity — a closed form in SST alone — instead of Emanuel's
    thermodynamic pcmin. This avoids pulling numba/tcpyPI into the Cloud
    Run image (cold-start + size cost) for a monitoring dashboard, at the
    price of PI being SST-only. The empirical MPI is a standard,
    well-validated operational choice (it is one of the two MPI fields
    TC-ATLAS already surfaces in the archive).

BOTH the realtime endpoint (ir_monitor_api) and the offline climatology
builder import compute_vi() from here, so they can never drift apart.
"""

from __future__ import annotations

import math
from typing import Optional

# ── Thermodynamic constants (Bryan 2008 conventions) ──────────────────
# Copied verbatim from build_era5_chi_m_indices.py so this module has no
# import coupling to the ERA5 data-fetch stack.
C_PD = 1005.7      # J/(kg K)  dry-air specific heat at const p
C_L = 4190.0       # J/(kg K)  liquid water
C_PV = 1875.0      # J/(kg K)  water-vapor specific heat at const p
R_D = 287.04       # J/(kg K)
R_V = 461.5        # J/(kg K)
EPSILON = R_D / R_V   # ≈ 0.622
T_REF = 273.15     # K
P_REF = 100000.0   # Pa (1000 hPa reference)
L_V_0 = 2.501e6    # J/kg latent heat of vaporization at T_REF

P_BOUND = 100000.0    # 1000 mb (boundary-layer entropy)
P_MID = 60000.0       # 600 mb  (mid-trop entropy — Tang & Emanuel 2012)
P_SURF = 101325.0     # standard surface pressure for SST saturation

KT_TO_MS = 0.514444

# DeMaria & Kaplan (1994) empirical MPI (kt) = A + B·exp(C·(SST − T0)).
_MPI_A = 28.2
_MPI_B = 55.8
_MPI_C = 0.1813
_MPI_T0 = 30.0
_MPI_SST_CAP = 31.0   # empirical fit saturates; clamp to avoid runaway PI


def latent_heat_vap(T: float) -> float:
    """L_v(T) [J/kg] — Bryan (2008) eq. 12."""
    return L_V_0 - (C_L - C_PV) * (T - T_REF)


def sat_vapor_pressure(T: float) -> float:
    """Bolton (1980) saturation vapor pressure (Pa)."""
    return 611.2 * math.exp(17.67 * (T - 273.15) / (T - 29.65))


def mixing_ratio_from_q(q: float) -> float:
    """Specific humidity q (kg/kg) → mixing ratio r (kg/kg)."""
    return q / max(1.0 - q, 1e-12)


def sat_mixing_ratio(T: float, p: float) -> float:
    """r_sat(T, p): saturation mixing ratio at T (K), p (Pa)."""
    e_s = sat_vapor_pressure(T)
    return EPSILON * e_s / max(p - e_s, 1e-3)


def bryan_moist_entropy(T: float, r_v: float, p: float,
                        saturated: bool = False) -> float:
    """Reversible moist entropy (Bryan 2008 eq. 16), J/(kg·K). Scalar port
    of build_era5_chi_m_indices.bryan_moist_entropy (the `saturated` flag
    only skips a redundant RH term; H=1 → ln H = 0)."""
    L_v = latent_heat_vap(T)
    e = r_v * p / max(EPSILON + r_v, 1e-12)
    p_d = max(p - e, 1e-3)
    T_safe = max(T, 1e-3)
    term_T = (C_PD + r_v * C_L) * math.log(T_safe / T_REF)
    term_p = -R_D * math.log(p_d / P_REF)
    term_lat = L_v * r_v / T_safe
    s = term_T + term_p + term_lat
    if not saturated:
        # Unsaturated: subtract the vapor-pressure (RH) contribution.
        H = min(max(e / max(sat_vapor_pressure(T), 1e-6), 1e-6), 1.0)
        s += -R_V * r_v * math.log(H)
    return s


def chi_m(t_b_k: float, q_b: float,
          t_m_env_k: float, q_m_env: float, t_m_sat_k: float,
          sst_k: float) -> Optional[float]:
    """Non-dimensional mid-trop (600 hPa) entropy deficit χ_m (Tang &
    Emanuel 2012, eq. S12):

        χ_m = (s*_m − s_m) / (s*_SST − s_b)

    Per the supplement's "Calculation from Gridded Data" (+ Fig. S1 / eqs
    S6–S7), the numerator is the entropy CONTRAST between two DIFFERENT regions
    — the saturated inner core vs the drier environment:
      * s*_m — 600 hPa SATURATION entropy averaged over the inner 0–100 km disc
        (uses t_m_sat_k, the disc-mean temp = the saturated eyewall/eye).
      * s_m  — 600 hPa environmental (actual) entropy over the 100–300 km
        annulus (uses t_m_env_k / q_m_env).
    NB (also from the supplement): with coarse reanalysis / 0.25° GFS data the
    disc can't resolve the intense warm core, so the deficit is UNDERESTIMATED
    for strong TCs — a documented limitation, not an error. Do NOT "fix" the
    high χ_m by moving s*_m to the annulus temperature; that is a different
    (sub-saturation) quantity and is not T&E.
    The denominator is the air–sea disequilibrium (~ potential intensity; T&E
    2012 eq. 2 evaluates it at the RMW at PI). It uses SST saturation entropy
    s*_SST and boundary-layer entropy s_b from the ENVIRONMENTAL annulus — NOT
    the storm's near-saturated inner-core BL, which collapses the disequilibrium
    and inflates χ_m for intense TCs. (t_b_k/q_b are passed by the caller from
    the annulus.) All temperatures KELVIN; humidities specific humidity (kg/kg).
    Returns None if the denominator is non-physical."""
    r_b = mixing_ratio_from_q(q_b)
    r_m_env = mixing_ratio_from_q(q_m_env)
    s_b = bryan_moist_entropy(t_b_k, r_b, P_BOUND, saturated=False)
    s_m = bryan_moist_entropy(t_m_env_k, r_m_env, P_MID, saturated=False)
    r_m_sat = sat_mixing_ratio(t_m_sat_k, P_MID)
    s_m_s = bryan_moist_entropy(t_m_sat_k, r_m_sat, P_MID, saturated=True)
    r_sst = sat_mixing_ratio(sst_k, P_SURF)
    s_sst = bryan_moist_entropy(sst_k, r_sst, P_SURF, saturated=True)
    denom = s_sst - s_b
    if denom <= 1.0:
        return None
    return (s_m_s - s_m) / denom


def empirical_mpi_ms(sst_c: float) -> float:
    """DeMaria & Kaplan (1994) empirical maximum potential intensity in
    m/s from SST (°C): MPI = A + B·exp(C·(SST − T0)). Their coefficients
    give Vmax in m/s (~84 m/s ≈ 163 kt at 30 °C). Clamped at _MPI_SST_CAP
    so the exponential doesn't run away past the fit's valid range."""
    t = min(sst_c, _MPI_SST_CAP)
    return _MPI_A + _MPI_B * math.exp(_MPI_C * (t - _MPI_T0))


def compute_vi(shear_kt: float, t_b_k: float, q_b: float,
               t_m_env_k: float, q_m_env: float, t_m_sat_k: float,
               sst_c: float) -> Optional[dict]:
    """Ventilation index VI = V_shear · χ_m / PI (Tang & Emanuel 2012, S13).

    shear_kt   : 850–200 hPa environmental (vortex-removed) shear mag (kt)
    t_b_k/q_b  : 1000 hPa T (K) / specific humidity (kg/kg), inner 0–100 km disc
    t_m_env_k/q_m_env : 600 hPa environmental T/q, 100–300 km annulus
    t_m_sat_k  : 600 hPa temperature, inner 0–100 km disc (for s*_m)
    sst_c      : sea-surface temperature (°C)

    Returns {vi, chi_m, mpi_kt, shear_kt} or None if inputs are
    incomplete / non-physical. VI is dimensionless: shear and PI are both
    put in m/s before the ratio (χ_m is already non-dimensional)."""
    if None in (shear_kt, t_b_k, q_b, t_m_env_k, q_m_env, t_m_sat_k, sst_c):
        return None
    xm = chi_m(t_b_k, q_b, t_m_env_k, q_m_env, t_m_sat_k, sst_c + 273.15)
    if xm is None:
        return None
    mpi_ms = empirical_mpi_ms(sst_c)
    if mpi_ms <= 1.0:
        return None
    vi = (shear_kt * KT_TO_MS) * xm / mpi_ms
    return {
        "vi": round(vi, 5),
        "chi_m": round(xm, 4),
        "mpi_kt": round(mpi_ms / KT_TO_MS, 1),
        "shear_kt": round(shear_kt, 1),
    }


if __name__ == "__main__":
    # Sanity check: a favorable vs a hostile environment. Favorable should
    # give a markedly LOWER ventilation index than hostile.
    favorable = compute_vi(
        shear_kt=8.0,
        t_b_k=298.0, q_b=0.019,           # warm, moist boundary layer (disc)
        t_m_env_k=271.0, q_m_env=0.0045,  # moist 600 hPa env (small deficit)
        t_m_sat_k=272.0,                  # inner-disc 600 hPa T (for s*_m)
        sst_c=29.5,
    )
    hostile = compute_vi(
        shear_kt=38.0,
        t_b_k=297.0, q_b=0.017,
        t_m_env_k=270.0, q_m_env=0.0008,  # very dry 600 hPa env (large deficit)
        t_m_sat_k=271.0,
        sst_c=26.2,
    )
    print("favorable:", favorable)
    print("hostile:  ", hostile)
    assert favorable and hostile
    assert favorable["vi"] < hostile["vi"], "favorable VI should be lower"
    print("OK — favorable VI < hostile VI")
