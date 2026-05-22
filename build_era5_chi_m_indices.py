"""Saturation entropy deficit (χ_m) monthly region indices for Panel B.

Computes the Emanuel (2010) / Tang & Emanuel (2012) saturation entropy
deficit, the moisture-instability metric used in tropical-cyclone
Genesis Potential Indices to quantify how subsaturated the mid-trop is
(the "ventilation" mechanism that suppresses TCs via dry-air-driven
downdraft cooling).

    χ_m = (s_m* - s_m) / (s_SST* - s_b)

where
    s_m*   = saturation moist entropy at the mid-trop (T_m, r_sat(T_m,p_m))
    s_m    = actual moist entropy at mid-trop          (T_m, r_v_m)
    s_SST* = saturation moist entropy at the SST       (T=SST, r_sat(SST,p_s))
    s_b    = actual moist entropy at the boundary layer (T_b, r_v_b)

Interpretation: χ_m ≈ 0 = saturated mid-trop = TC-favorable.
χ_m ≈ 1 (or larger) = strongly subsaturated mid-trop = TC-suppressive.
Camargo et al. (2014, J. Climate) found χ_m is the single largest
contributor to TGPI variability across basins — ahead of shear or
vorticity.

Levels:
    boundary layer = 1000 mb
    mid-trop       = 700 mb  (Tippett 2011 / Camargo 2014 convention —
                              the canonical Emanuel/Tang 600 mb level
                              is missing from the GC-ATLAS climo
                              manifest)

Entropy formulation: Bryan (2008) eq. (16), reversible moist entropy
(formally-exact thermodynamic entropy of a parcel that conserves total
water mass — preferred over pseudoadiabatic when computing climatology
means because it doesn't depend on integration history):

    s = (c_pd + r_t * c_l) * ln(T/T_0)
        - R_d * ln(p_d/p_0)
        + L_v(T) * r_v / T
        - r_v * R_v * ln(H)

For unsaturated parcels r_t = r_v. For saturated air H=1 so the last
term vanishes.

Inputs (all monthly, from GC-ATLAS):
    pressure_levels/t at 1000, 700 mb        (K)
    pressure_levels/q at 1000, 700 mb        (kg/kg)
    single_levels/sst                         (K — ERA5 native)

Outputs (added to data/indices_monthly_era5_chi_m.json + uploaded to
gs://${GCS_IR_CACHE_BUCKET}/seasonal/indices_monthly_era5_chi_m.json):
    {region}_chi_m   dimensionless
    {region}_s_b     J/(kg·K)   boundary-layer fuel state
    {region}_s_m     J/(kg·K)   mid-trop entropy

The split into chi_m + s_b + s_m lets users attribute χ_m anomalies to
the surface-fuel side (s_b) vs the mid-trop-saturation side
(s_m* - s_m, derivable from s_m + temperature) when diagnosing
genesis events.

Wall time: ~3 minutes (36 years × 12 months × 5 grids per month + climo).
Bandwidth: ~60 MB (1° monthly tiles, ~25 KB each, 5 fields × 36 years).
"""
from __future__ import annotations

import gzip
import json
import logging
import os
import sys
from pathlib import Path

import numpy as np

log = logging.getLogger("era5_chi_m")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))
from build_era5_indices import (  # type: ignore  # noqa: E402
    fetch_manifest, fetch_field_grid, region_mean,
    REGIONS, CLIM_PERIOD, PER_YEAR_START, PER_YEAR_END,
)

# ── Thermodynamic constants (Bryan 2008 conventions) ──────────────────
C_PD    = 1005.7      # J/(kg K)  dry-air specific heat at const p
C_L     = 4190.0      # J/(kg K)  liquid water
C_PV    = 1875.0      # J/(kg K)  water-vapor specific heat at const p
R_D     = 287.04      # J/(kg K)
R_V     = 461.5       # J/(kg K)
EPSILON = R_D / R_V   # ≈ 0.622
T_REF   = 273.15      # K
P_REF   = 100000.0    # Pa  (1000 hPa reference pressure)
L_V_0   = 2.501e6     # J/kg, latent heat of vaporization at T_REF

# Pressure-level constants for the three entropy evaluations.
# Mid-trop is 700 mb instead of the Emanuel/Tang canonical 600 mb:
# the GC-ATLAS climo manifest lists 500, 700, 850 (no 600 entry — its
# tile files exist in GCS but the manifest indexing skips that level).
# 700 mb is the level Tippett et al. (2011), Camargo et al. (2014),
# and most modern TGPI work use for χ_m anyway, so the literature
# alignment is fine. Qualitative interpretation is identical: low χ_m
# = saturated mid-trop = favorable; high χ_m = dry = suppressive.
P_BOUND = 100000.0    # 1000 mb (boundary-layer entropy)
P_MID   = 70000.0     # 700 mb  (mid-trop entropy)
P_SURF  = 101325.0    # standard surface pressure for SST saturation


def latent_heat_vap(T: np.ndarray) -> np.ndarray:
    """L_v(T) = 2.501e6 - (c_l - c_pv) * (T - T_REF)  [J/kg]
    Bryan (2008) eq. (12). At T=273 K → 2.501e6; at T=300 K → ~2.44e6."""
    return L_V_0 - (C_L - C_PV) * (T - T_REF)


def sat_vapor_pressure(T: np.ndarray) -> np.ndarray:
    """Bolton (1980) eq. 10 — saturation vapor pressure (Pa).
        e_s(T) = 611.2 * exp(17.67 * (T - 273.15) / (T - 29.65))
    Valid roughly -35..+35 °C, perfectly adequate for ±60° lat ERA5."""
    return 611.2 * np.exp(17.67 * (T - 273.15) / (T - 29.65))


def mixing_ratio_from_q(q: np.ndarray) -> np.ndarray:
    """Specific humidity q (kg/kg) → mixing ratio r (kg/kg).  r = q/(1-q)."""
    return q / np.maximum(1.0 - q, 1e-12)


def sat_mixing_ratio(T: np.ndarray, p: float) -> np.ndarray:
    """r_sat(T, p) at temperature T (K) and pressure p (Pa).
        r_sat = epsilon * e_s(T) / (p - e_s(T))."""
    e_s = sat_vapor_pressure(T)
    return EPSILON * e_s / np.maximum(p - e_s, 1e-3)


def bryan_moist_entropy(T: np.ndarray, r_v: np.ndarray, p: float, *,
                        saturated: bool = False) -> np.ndarray:
    """Reversible moist entropy (Bryan 2008 eq. 16), J/(kg·K).

    T:      temperature (K), array
    r_v:    water-vapor mixing ratio (kg/kg), array
    p:      pressure (Pa), scalar
    saturated: when True, the relative-humidity term is dropped because
               H = 1 → ln(H) = 0. (Numerically equivalent but skips a
               redundant sat_vapor_pressure evaluation.)

    Total water mixing ratio r_t is taken as r_v (unsaturated parcel).
    For saturated parcels the unrealized liquid term doesn't matter for
    χ_m because the same r_v is used to evaluate s_m at the same T_m;
    the saturation entropy s_m* and s_SST* are evaluated assuming all
    moisture is vapor at that T,p — Bryan's exact formula then reduces
    cleanly to the standard expression.
    """
    L_v = latent_heat_vap(T)
    # Partial pressure of dry air: p_d = p - e, where
    #   e = r_v * p / (epsilon + r_v)   (mixing-ratio definition)
    e = r_v * p / np.maximum(EPSILON + r_v, 1e-12)
    p_d = np.maximum(p - e, 1e-3)
    T_safe = np.maximum(T, 1e-3)
    term_T   = (C_PD + r_v * C_L) * np.log(T_safe / T_REF)
    term_p   = -R_D * np.log(p_d / P_REF)
    term_lat = L_v * r_v / T_safe
    s = term_T + term_p + term_lat
    if not saturated:
        e_s = sat_vapor_pressure(T)
        H = np.clip(e / np.maximum(e_s, 1e-3), 1e-3, 1.0)
        s = s - r_v * R_V * np.log(H)
    return s


def _ensure_sst_kelvin(sst: np.ndarray) -> np.ndarray:
    """ERA5 SST is in Kelvin natively. Some downstream catalogs strip
    the offset and serve °C. Detect either case by examining a finite
    ocean value: K → 270..310, °C → -3..37. Add 273.15 if it looks like
    Celsius. (Safe: the two ranges don't overlap.)"""
    finite = np.isfinite(sst)
    if not finite.any():
        return sst
    sample = float(sst[finite].ravel()[0])
    if sample < 100.0:
        log.info("  SST sample=%.2f → looks like °C, adding 273.15", sample)
        return sst + 273.15
    return sst


def compute_chi_m_grid(T_b: np.ndarray, q_b: np.ndarray,
                       T_m: np.ndarray, q_m: np.ndarray,
                       sst: np.ndarray
                       ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pointwise χ_m, s_b, s_m on a (lat, lon) grid."""
    r_b = mixing_ratio_from_q(q_b)
    r_m = mixing_ratio_from_q(q_m)
    s_b = bryan_moist_entropy(T_b, r_b, P_BOUND, saturated=False)
    s_m = bryan_moist_entropy(T_m, r_m, P_MID,   saturated=False)
    # Mid-trop SATURATION entropy: same T_m, but r_v = r_sat(T_m, p_m).
    r_m_sat = sat_mixing_ratio(T_m, P_MID)
    s_m_sat = bryan_moist_entropy(T_m, r_m_sat, P_MID, saturated=True)
    # SST saturation entropy: at sea-level p, with T = SST.
    r_sst_sat = sat_mixing_ratio(sst, P_SURF)
    s_sst_sat = bryan_moist_entropy(sst, r_sst_sat, P_SURF, saturated=True)
    # χ_m = (s_m* - s_m) / (s_SST* - s_b)
    num   = s_m_sat - s_m
    denom = s_sst_sat - s_b
    chi_m = np.where(denom > 1.0, num / denom, np.nan)   # 1 J/(kg·K) floor
    return chi_m, s_b, s_m


SHORT_FIELDS = ("chi_m", "s_b", "s_m")


def grids_for(manifest: dict, month: int, *,
              period: str = "default", year: int | None = None
              ) -> tuple[np.ndarray, np.ndarray, np.ndarray,
                         np.ndarray, np.ndarray] | None:
    """Fetch the 5 input grids for one (month, year) — T+q at 1000 and
    600 mb plus SST. Returns None if any are missing."""
    kw = dict(kind="mean", period=period, year=year)
    T_b = fetch_field_grid(manifest, "t", 1000, month, **kw)
    q_b = fetch_field_grid(manifest, "q", 1000, month, **kw)
    T_m = fetch_field_grid(manifest, "t", 700,  month, **kw)
    q_m = fetch_field_grid(manifest, "q", 700,  month, **kw)
    sst = fetch_field_grid(manifest, "sst", None, month, **kw)
    if any(g is None for g in (T_b, q_b, T_m, q_m, sst)):
        return None
    sst = _ensure_sst_kelvin(sst)
    return (T_b, q_b, T_m, q_m, sst)


def compute_region_means(manifest: dict, month: int, *,
                         period: str = "default", year: int | None = None
                         ) -> dict[str, dict[str, float]] | None:
    """Pointwise χ_m → cos(lat)-weighted region mean. The region mean is
    taken AFTER the pointwise nonlinear χ_m computation because the
    spatial average of a nonlinear function ≠ the function of spatial
    averages (Jensen's inequality)."""
    grids = grids_for(manifest, month, period=period, year=year)
    if grids is None:
        return None
    chi_m, s_b, s_m = compute_chi_m_grid(*grids)
    out: dict[str, dict[str, float]] = {}
    for short, grid in zip(SHORT_FIELDS, (chi_m, s_b, s_m)):
        out[short] = {r: region_mean(grid, box)
                      for r, box in REGIONS.items()}
    return out


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-upload", action="store_true",
                    help="Skip the GCS upload step (local JSON only)")
    args = ap.parse_args()

    log.info("Fetching GC-ATLAS climatology manifest...")
    manifest = fetch_manifest()

    out: dict = {
        "metadata": {
            "source": "gc-atlas-era5 (T+q@1000,600 + SST)",
            "method": "Bryan (2008) reversible moist entropy; "
                      "χ_m = (s_m* - s_m)/(s_SST* - s_b) "
                      "[Emanuel 2010, Tang & Emanuel 2012]",
            "boundary_level_hpa": 1000,
            "mid_level_hpa": 700,
            "clim_period": CLIM_PERIOD,
            "per_year_start": PER_YEAR_START,
            "per_year_end_inclusive": PER_YEAR_END,
        },
        "fields": {
            "chi_m": {
                "units": "1",
                "long_name": "Saturation entropy deficit χ_m "
                             "(Emanuel/Tang, ventilation index)",
            },
            "s_b": {
                "units": "J kg⁻¹ K⁻¹",
                "long_name": "Boundary-layer moist entropy (1000 mb)",
            },
            "s_m": {
                "units": "J kg⁻¹ K⁻¹",
                "long_name": "Mid-trop moist entropy (700 mb)",
            },
        },
        "regions": {r: list(box) for r, box in REGIONS.items()},
        "values":  {},   # region_field → [12] climo mean
        "std":     {},   # region_field → [12] across-years std
        "by_year": {},   # year → region_field → [12]
    }

    # ── Climatology mean (12 months) ─────────────────────────────────
    log.info("=== Climatology mean (%s) ===", CLIM_PERIOD)
    for month in range(1, 13):
        log.info("  month %d climo", month)
        means = compute_region_means(manifest, month, period="default")
        if means is None:
            log.warning("    skipped (missing tile)")
            continue
        for short in SHORT_FIELDS:
            for region, v in means[short].items():
                key = f"{region}_{short}"
                out["values"].setdefault(key, [None] * 12)[month - 1] = (
                    None if not np.isfinite(v) else round(float(v), 4)
                )

    # ── Per-year (year, month) ───────────────────────────────────────
    log.info("=== Per-year %d-%d ===", PER_YEAR_START, PER_YEAR_END)
    for year in range(PER_YEAR_START, PER_YEAR_END + 1):
        log.info("  %d", year)
        block = out["by_year"].setdefault(str(year), {})
        for month in range(1, 13):
            means = compute_region_means(manifest, month,
                                          period="per_year", year=year)
            if means is None:
                continue
            for short in SHORT_FIELDS:
                for region, v in means[short].items():
                    key = f"{region}_{short}"
                    block.setdefault(key, [None] * 12)[month - 1] = (
                        None if not np.isfinite(v) else round(float(v), 4)
                    )

    # ── Climatology std (across-years std of monthly means) ──────────
    # Computed from the per-year block (more robust than fetching the
    # GC-ATLAS std tile, which would be the std of DAILY values within
    # a month — a different quantity).
    log.info("=== Climatology across-years std (1991-2020) ===")
    by_year = out["by_year"]
    clim_years = [y for y in range(1991, 2021) if str(y) in by_year]
    for short in SHORT_FIELDS:
        for region in REGIONS:
            key = f"{region}_{short}"
            stds: list[float | None] = []
            for month in range(12):
                samples = []
                for y in clim_years:
                    row = by_year.get(str(y), {}).get(key)
                    if row and row[month] is not None:
                        samples.append(row[month])
                if len(samples) > 1:
                    stds.append(round(float(np.std(samples, ddof=1)), 4))
                else:
                    stds.append(None)
            out["std"][key] = stds

    # ── Write local + upload ─────────────────────────────────────────
    out_local = REPO / "data" / "indices_monthly_era5_chi_m.json"
    out_local.parent.mkdir(parents=True, exist_ok=True)
    out_local.write_text(json.dumps(out, separators=(",", ":")))
    log.info("Wrote %s (%.1f KB)", out_local,
             out_local.stat().st_size / 1024.0)

    # Spot-check Atlantic MDR for plausibility.
    try:
        atl_chi_m_climo = out["values"]["atl_mdr_chi_m"]
        log.info("  atl_mdr_chi_m climo (Aug/Sep): %.3f / %.3f "
                 "(operational range ~0.6-0.9 in peak TC season; "
                 "lower = moister mid-trop = more favorable)",
                 atl_chi_m_climo[7], atl_chi_m_climo[8])
    except Exception:
        pass

    if args.no_upload:
        return
    bucket_name = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
    try:
        from google.cloud import storage   # type: ignore
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob("seasonal/indices_monthly_era5_chi_m.json")
        blob.cache_control = "public, max-age=300"   # 5 min edge cache
        blob.upload_from_filename(str(out_local),
                                  content_type="application/json",
                                  predefined_acl="publicRead")
        log.info("Uploaded → gs://%s/seasonal/indices_monthly_era5_chi_m.json "
                 "(public-read)", bucket_name)
    except Exception as e:
        log.warning("GCS upload skipped: %s", e)


if __name__ == "__main__":
    main()
