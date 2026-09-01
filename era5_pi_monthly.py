"""Monthly-mean Bister-Emanuel PI (+ outflow T_o and air-sea
disequilibrium) on the GC-ATLAS 1° frame — the shared physics feed for
build_era5_chi_m_indices.py and build_era5_vpi_indices.py.

WHY: Tang & Emanuel (2012, supplement ES128) define the χ_m denominator
as the air-sea enthalpy disequilibrium "evaluated at the radius of
maximum wind for a TC at its potential intensity" via the BE-2002
algorithm — i.e. pcmin's AIRSEA, reconstructible from the PI solve as

    AIRSEA = (VMAX/V_reduc)² · (1/CKCD) · T_o / (T_s (T_s − T_o))

(potential_intensity.air_sea_disequilibrium). The monthly seasonal
products instead approximated it as s*_SST − s_b from gridded 1000-mb
T/q, which measured ~38% TOO LARGE (86.1 vs 53.3 J/(kg·K) at 15N/45W)
→ χ_m too small → vPI biased high. The RT map layers already do this
right; this module brings the monthly products in line by running
tcpyPI on the GC-ATLAS monthly profile tiles directly.

The catalog's own `mpi` tile can't help — it carries VMAX but not T_o.
Rather than teaching the Gen_Circ pipeline to emit a T_o tile and
rebuilding 36 years of its catalog, we solve PI here: the profile
inputs all exist (t/q at 12 pressure levels + our 600-hPa CDS sidecar,
msl, sst), potential_intensity.pi_grid's njit driver does a 1° month in
under a second, and the parameter convention (CKCD=0.9, reversible,
V_reduc=0.8) matches the catalog's mpi tiles by construction — the
computed VMAX doubles as a cross-check against them.

Each solved month is cached as an .npz under data/era5_pi_cache/, so
the second builder in a refresh run (and every later refresh) pays
only for months it hasn't seen.

Library:
    from era5_pi_monthly import pi_for
    out = pi_for(manifest, month)                 # 1991-2020 climo
    out = pi_for(manifest, month, period="per_year", year=2026)
    # → {"vmax_ms", "t_out_k", "asdeq"} (181, 360) float32, or None
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

log = logging.getLogger("era5_pi_monthly")

REPO = Path(__file__).parent
CACHE_DIR = REPO / "data" / "era5_pi_cache"

# GC-ATLAS pressure levels with real t AND q tiles (400 and 600 are in
# the manifest's `levels` array but have no tiles; 600 comes from the
# CDS sidecar instead, and 10 hPa sits above the ptop=50 integration).
_CATALOG_LEVELS = [1000, 925, 850, 700, 500, 300, 250, 200, 150, 100, 50]
PROFILE_LEVELS = sorted(_CATALOG_LEVELS + [600], reverse=True)

# Poleward of this the monthly products don't render (the vPI tiles pad
# rows beyond ±60° with NaN) and PI is meaningless for TCs — blanking
# SST before the solve skips those cells entirely.
LAT_MAX = 60.0

_CACHE_VERSION = 1   # bump on any physics/input change to invalidate .npz


def _cache_path(month: int, period: str, year: int | None) -> Path:
    tag = "climo" if period == "default" else str(year)
    return CACHE_DIR / f"pi_v{_CACHE_VERSION}_{tag}_{month:02d}.npz"


def pi_for(manifest: dict, month: int, *, period: str = "default",
           year: int | None = None) -> dict[str, np.ndarray] | None:
    """PI solve for one (period, year, month). None on missing inputs."""
    cp = _cache_path(month, period, year)
    if cp.exists():
        with np.load(cp) as z:
            return {k: z[k] for k in ("vmax_ms", "t_out_k", "asdeq")}

    from build_era5_indices import fetch_field_grid
    from era5_600_sidecar import load_tq600
    import potential_intensity

    kw = dict(kind="mean", period=period, year=year)
    msl = fetch_field_grid(manifest, "msl", None, month, **kw)
    sst = fetch_field_grid(manifest, "sst", None, month, **kw)
    mid = load_tq600(month, year=None if period == "default" else year)
    if msl is None or sst is None or mid is None:
        return None

    t_prof, q_prof = [], []
    for lvl in PROFILE_LEVELS:
        if lvl == 600:
            t_g, q_g = mid
        else:
            t_g = fetch_field_grid(manifest, "t", lvl, month, **kw)
            q_g = fetch_field_grid(manifest, "q", lvl, month, **kw)
            if t_g is None or q_g is None:
                return None
        t_prof.append(t_g)
        q_prof.append(q_g)

    # Unit discipline (the exact bug class tcpyVPI 1.1.0 fixed): msl
    # tiles are Pa → hPa; t tiles K → °C; q is SPECIFIC HUMIDITY kg/kg
    # → mixing ratio g/kg; sst may arrive K or °C.
    msl_hpa = np.asarray(msl, dtype=np.float64) / 100.0
    sst_arr = np.asarray(sst, dtype=np.float64)
    sst_c = np.where(sst_arr > 200.0, sst_arr - 273.15, sst_arr)
    t_c = (np.stack(t_prof) - 273.15).astype(np.float32)
    q_kg = np.stack(q_prof)
    r_gkg = ((q_kg / np.clip(1.0 - q_kg, 1e-12, None))
             * 1000.0).astype(np.float32)

    lats = 90.0 - np.arange(181)
    sst_c = np.where(np.abs(lats)[:, None] <= LAT_MAX, sst_c, np.nan)

    out = potential_intensity.pi_grid(
        sst_c, msl_hpa, np.asarray(PROFILE_LEVELS, dtype=float),
        t_c, r_gkg)
    result = {k: out[k].astype(np.float32)
              for k in ("vmax_ms", "t_out_k", "asdeq")}

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cp, **result)
    n_ok = int(np.isfinite(result["vmax_ms"]).sum())
    log.info("PI solved %s (%d valid cells) → %s",
             cp.stem, n_ok, cp.name)
    return result


if __name__ == "__main__":
    # Self-check on one climo month: the computed VMAX should land on
    # the catalog's own mpi tile (same tcpyPI convention), and the
    # asdeq should sit on the T&E scale, well BELOW the old s*_SST−s_b
    # approximation.
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
    import sys
    sys.path.insert(0, str(REPO))
    from build_era5_indices import fetch_manifest, fetch_field_grid

    m = fetch_manifest()
    out = pi_for(m, 9)
    assert out is not None, "climo Sep solve failed"
    vmax, asdeq = out["vmax_ms"], out["asdeq"]
    mpi_tile = fetch_field_grid(m, "mpi", None, 9, kind="mean",
                                period="default")
    ok = np.isfinite(vmax) & np.isfinite(mpi_tile)
    r = float(np.corrcoef(vmax[ok], mpi_tile[ok])[0, 1])
    bias = float(np.mean(vmax[ok] - mpi_tile[ok]))
    print(f"vmax vs catalog mpi tile: r={r:.4f}  bias={bias:+.2f} m/s  "
          f"(n={int(ok.sum())})")
    # 15N, 45W — the spot the ~38% denominator error was measured at.
    j, i = 90 - 15, 180 - 45
    print(f"asdeq @15N,45W Sep climo: {asdeq[j, i]:.1f} J/(kg·K)  "
          f"(old s*_SST−s_b approx measured 86.1 vs pcmin 53.3 there)")
    assert r > 0.98, "computed PI does not reproduce the catalog mpi tile"
    print("self-check OK")
