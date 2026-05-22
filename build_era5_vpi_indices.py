"""Ventilated Potential Intensity (vPI) — pointwise, à la Chavas et al. (2025).

The companion script to `build_era5_chi_m_indices.py`. Computes vPI on
the GC-ATLAS 1° grid POINTWISE (per cell) following the equilibrium
relation of Chavas, Camargo & Tippett (2025, J. Climate; "Tropical
cyclone genesis potential using a ventilated potential intensity"),
their Eq. 4:

    (vPI/PI)³ - (vPI/PI) + (2 / 3√3) · (VI / VI_max) = 0

with closed-form trigonometric solution

    vPI = PI · (2/√3) · cos((1/3) · arccos(-VI/VI_max))   for VI ≤ VI_max
    vPI = 0                                                for VI > VI_max

VI_max = 0.145 per Hoogewind et al. (2019) — the value Chavas uses
directly in their Fig. 1 + Eq. 4 derivation.

The ventilation index (Tang & Emanuel 2012) is
    VI = (V_shear · χ_m) / PI
where V_shear is the 200-850 hPa vector wind shear magnitude and χ_m
is the mid-tropospheric entropy deficit (here at 700 hPa following the
constraint that GC-ATLAS's climo manifest doesn't index 600 hPa).

Pointwise computation is essential — basin-mean inputs run head-on
into Jensen's inequality (vPI is a strongly nonlinear function of VI
in the near-VI_max regime), so the basin-mean vPI computed from
basin-mean inputs systematically under-estimates the spatially-
averaged pointwise vPI by 20-100%. Chavas's Fig. 3c shows Atlantic
MDR annual-mean vPI ≈ 40-60 m/s; that's recoverable only by
computing pointwise then averaging.

Inputs (all monthly mean, GC-ATLAS 1° tiles, 181 lat × 360 lon):
    pressure_levels/t at 1000, 700 mb        (K)
    pressure_levels/q at 1000, 700 mb        (kg/kg)
    pressure_levels/u at 200, 850 mb         (m/s)
    pressure_levels/v at 200, 850 mb         (m/s)
    single_levels/sst                          (K)
    single_levels/mpi                          (m/s) — Bister & Emanuel

Outputs:
    data/indices_monthly_era5_vpi.json
    gs://${GCS_IR_CACHE_BUCKET}/seasonal/indices_monthly_era5_vpi.json
With per-region per-(year, month) vPI = cos(lat)-weighted mean of the
pointwise vPI field over the region's box.

Wall time: ~5 minutes (9 grids × 432 (year, month) pairs). Cached
locally for fast iteration.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

import numpy as np

log = logging.getLogger("era5_vpi")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))
from build_era5_indices import (  # type: ignore  # noqa: E402
    fetch_manifest, fetch_field_grid, region_mean,
    REGIONS, CLIM_PERIOD, PER_YEAR_START, PER_YEAR_END,
)
from build_era5_chi_m_indices import (  # type: ignore  # noqa: E402
    bryan_moist_entropy, sat_mixing_ratio, mixing_ratio_from_q,
    _ensure_sst_kelvin,
    P_BOUND, P_MID, P_SURF,
)

# Chavas et al. (2025) constants
VI_MAX = 0.145              # Hoogewind 2019 / Chavas Fig. 1
_TWO_OVER_SQRT3 = 2.0 / np.sqrt(3.0)


def compute_vpi_field(T_b: np.ndarray, q_b: np.ndarray,
                      T_m: np.ndarray, q_m: np.ndarray,
                      sst: np.ndarray, mpi: np.ndarray,
                      u200: np.ndarray, v200: np.ndarray,
                      u850: np.ndarray, v850: np.ndarray
                      ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pointwise (vPI, VI, chi_m) fields on the GC-ATLAS grid.

    All inputs are 2-D (lat, lon) float arrays at the same shape.
    NaNs propagate (land cells → NaN vPI). Land masking happens
    naturally via SST being NaN over land.
    """
    # χ_m field — same Bryan-entropy machinery as the chi_m builder.
    r_b   = mixing_ratio_from_q(q_b)
    r_m   = mixing_ratio_from_q(q_m)
    s_b   = bryan_moist_entropy(T_b, r_b, P_BOUND, saturated=False)
    s_m   = bryan_moist_entropy(T_m, r_m, P_MID,   saturated=False)
    r_m_s = sat_mixing_ratio(T_m, P_MID)
    s_m_s = bryan_moist_entropy(T_m, r_m_s, P_MID, saturated=True)
    r_SST = sat_mixing_ratio(sst, P_SURF)
    s_SST = bryan_moist_entropy(sst, r_SST, P_SURF, saturated=True)
    denom_chi = s_SST - s_b
    chi_m = np.where(denom_chi > 1.0, (s_m_s - s_m) / denom_chi, np.nan)

    # Shear field — magnitude of the 200-850 vector wind difference.
    du, dv = u200 - u850, v200 - v850
    shear = np.sqrt(du * du + dv * dv)

    # Ventilation index VI = shear · χ_m / PI.
    vi = np.where(mpi > 1.0, shear * chi_m / np.maximum(mpi, 1.0), np.nan)

    # vPI per Chavas Eq. 4 closed-form trig solution.
    # Clip to VI_max from above so arccos receives a value in [-1, 0].
    r = vi / VI_MAX
    safe_r = np.clip(r, 0.0, 1.0)
    # phi = (1/3) · arccos(-VI/VI_max), valid for VI/VI_max ∈ [0, 1].
    phi = np.arccos(-safe_r) / 3.0
    ratio = _TWO_OVER_SQRT3 * np.cos(phi)
    vpi = np.where(r <= 1.0, mpi * ratio, 0.0)
    # NaN out cells where VI itself is undefined (land, missing inputs).
    vpi = np.where(np.isfinite(vi), vpi, np.nan)
    return vpi, vi, chi_m


def grids_for(manifest: dict, month: int, *,
              period: str = "default", year: int | None = None
              ) -> dict | None:
    """Fetch the 10 input grids for one (month, year). Returns None if
    any are missing — vPI requires all of them simultaneously."""
    kw = dict(kind="mean", period=period, year=year)
    fields = {
        "T_b":  ("t",   1000),
        "q_b":  ("q",   1000),
        "T_m":  ("t",   700),
        "q_m":  ("q",   700),
        "sst":  ("sst", None),
        "mpi":  ("mpi", None),
        "u200": ("u",   200),
        "v200": ("v",   200),
        "u850": ("u",   850),
        "v850": ("v",   850),
    }
    out = {}
    for name, (var, lvl) in fields.items():
        g = fetch_field_grid(manifest, var, lvl, month, **kw)
        if g is None:
            return None
        out[name] = g
    out["sst"] = _ensure_sst_kelvin(out["sst"])
    return out


def compute_region_means(manifest: dict, month: int, *,
                         period: str = "default", year: int | None = None
                         ) -> dict[str, float] | None:
    """Pointwise vPI → cos(lat)-weighted regional mean.
    Returns {region: vpi_mean}. None on missing tile.

    Critically: averages the POINTWISE vPI field, not vPI of the
    region-mean inputs. This is the difference that recovers Chavas
    Fig. 3c values for the Atlantic MDR (which the basin-mean
    approach drives to zero in some months due to Jensen's
    inequality near VI_max)."""
    grids = grids_for(manifest, month, period=period, year=year)
    if grids is None:
        return None
    vpi, _, _ = compute_vpi_field(**grids)
    return {r: region_mean(vpi, box) for r, box in REGIONS.items()}


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-upload", action="store_true",
                    help="Skip the GCS upload step (local JSON only)")
    args = ap.parse_args()

    log.info("Fetching GC-ATLAS manifest...")
    manifest = fetch_manifest()

    out: dict = {
        "metadata": {
            "source": "gc-atlas-era5 (T+q@1000,700 + SST + MPI + u/v@200,850)",
            "method": "Pointwise vPI per Chavas et al. (2025) Eq. 4; "
                      "cos(lat)-weighted regional mean of the vPI field",
            "vi_max": VI_MAX,
            "boundary_level_hpa": 1000,
            "mid_level_hpa": 700,
            "clim_period": CLIM_PERIOD,
            "per_year_start": PER_YEAR_START,
            "per_year_end_inclusive": PER_YEAR_END,
        },
        "fields": {
            "vpi": {
                "units": "m s⁻¹",
                "long_name": "Ventilated potential intensity (Chavas 2025, "
                             "pointwise then region-mean)",
            },
        },
        "regions": {r: list(box) for r, box in REGIONS.items()},
        "values":  {},
        "std":     {},
        "by_year": {},
    }

    # ── Climatology mean (12 months) ─────────────────────────────────
    log.info("=== Climatology mean (%s) ===", CLIM_PERIOD)
    for month in range(1, 13):
        log.info("  month %d climo", month)
        means = compute_region_means(manifest, month, period="default")
        if means is None:
            log.warning("    skipped (missing tile)")
            continue
        for region, v in means.items():
            key = f"{region}_vpi"
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
            for region, v in means.items():
                key = f"{region}_vpi"
                block.setdefault(key, [None] * 12)[month - 1] = (
                    None if not np.isfinite(v) else round(float(v), 4)
                )

    # ── Climatology across-years std (1991-2020) ─────────────────────
    log.info("=== Climatology across-years std (1991-2020) ===")
    by_year = out["by_year"]
    clim_years = [y for y in range(1991, 2021) if str(y) in by_year]
    for region in REGIONS:
        key = f"{region}_vpi"
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
    out_local = REPO / "data" / "indices_monthly_era5_vpi.json"
    out_local.parent.mkdir(parents=True, exist_ok=True)
    out_local.write_text(json.dumps(out, separators=(",", ":")))
    log.info("Wrote %s (%.1f KB)", out_local,
             out_local.stat().st_size / 1024.0)

    # Spot-check Atlantic MDR.
    try:
        atl_vpi = out["values"]["atl_mdr_vpi"]
        log.info("  atl_mdr_vpi climo (Aug/Sep/Oct): %.1f / %.1f / %.1f m/s "
                 "(Chavas Fig 3c shows ATL MDR annual mean ~40-60 m/s)",
                 atl_vpi[7], atl_vpi[8], atl_vpi[9])
    except Exception:
        pass

    if args.no_upload:
        return
    bucket_name = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
    try:
        from google.cloud import storage   # type: ignore
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob("seasonal/indices_monthly_era5_vpi.json")
        blob.cache_control = "public, max-age=300"
        blob.upload_from_filename(str(out_local),
                                  content_type="application/json",
                                  predefined_acl="publicRead")
        log.info("Uploaded → gs://%s/seasonal/indices_monthly_era5_vpi.json",
                 bucket_name)
    except Exception as e:
        log.warning("GCS upload skipped: %s", e)


if __name__ == "__main__":
    main()
