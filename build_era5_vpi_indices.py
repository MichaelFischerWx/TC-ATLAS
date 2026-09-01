"""Ventilated Potential Intensity (vPI) — pointwise, à la Chavas et al. (2025).

Computes vPI on the GC-ATLAS 1° grid POINTWISE and emits two products:

(a) data/indices_monthly_era5_vpi.json — region-mean vPI per
    (year, month, region) for Panel B time series (already shipped).

(b) gs://${GCS_IR_CACHE_BUCKET}/era5_monthly_vpi/* — gridded vPI
    tiles in the same f16-gz format as GC-ATLAS, so Panel C can
    fetch them like any other monthly variable and render the
    spatial field directly. Layout:
        tiles_per_year/{YYYY}_{MM}.bin.gz       per-year monthly
        tiles/{MM}.bin.gz                       1991-2020 climo
        manifest.json                            tile metadata

Both outputs follow the equilibrium relation of Chavas, Camargo &
Tippett (2025, J. Climate; "Tropical cyclone genesis potential using
a ventilated potential intensity"), their Eq. 4:

    (vPI/PI)³ - (vPI/PI) + (2 / 3√3) · (VI / VI_max) = 0

with closed-form trigonometric solution

    vPI = PI · (2/√3) · cos((1/3) · arccos(-VI/VI_max))   for VI ≤ VI_max
    vPI = 0                                                for VI > VI_max

VI_max = 0.145 per Hoogewind et al. (2019) — the value Chavas uses
directly in their Fig. 1 + Eq. 4 derivation.

The ventilation index (Tang & Emanuel 2012) is
    VI = (V_shear · χ_m) / PI
where V_shear is the 200-850 hPa vector wind shear magnitude and χ_m
is the mid-tropospheric entropy deficit at 600 hPa — the T&E /
Hoogewind / Chavas level, confirmed by Chavas as intended (pers.
comm., 2026-09), and the level every other TC-ATLAS VI surface uses.
The GC-ATLAS tile store has no 600 hPa t/q, so the mid-level grids
come from the CDS sidecar era5_600_sidecar.py (700 was used here
until 2026-09-01 for that reason).

Pointwise computation is essential — basin-mean inputs run head-on
into Jensen's inequality (vPI is a strongly nonlinear function of VI
in the near-VI_max regime), so the basin-mean vPI computed from
basin-mean inputs systematically under-estimates the spatially-
averaged pointwise vPI by 20-100%. Chavas's Fig. 3c shows Atlantic
MDR annual-mean vPI ≈ 40-60 m/s; that's recoverable only by
computing pointwise then averaging.

Inputs (all monthly mean, 181 lat × 360 lon on the GC-ATLAS 1° frame):
    t + q at 600 mb                           (CDS via era5_600_sidecar)
    pressure_levels/u at 200, 850 mb         (m/s — GC-ATLAS tiles)
    pressure_levels/v at 200, 850 mb         (m/s — GC-ATLAS tiles)
    PI (VMAX) + BE-2002 asdeq                 (era5_pi_monthly: tcpyPI
        on the GC-ATLAS profile tiles + 600-mb sidecar; VMAX matches
        the catalog's mpi tile to r=1.0000, and asdeq is the T&E
        suppl.-ES128 χ_m denominator the old s*_SST − s_b gridded
        approximation overshot by ~38%)

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
    P_MID,
)

# Chavas et al. (2025) constants
VI_MAX = 0.145              # Hoogewind 2019 / Chavas Fig. 1
_TWO_OVER_SQRT3 = 2.0 / np.sqrt(3.0)


def compute_vpi_field(T_m: np.ndarray, q_m: np.ndarray,
                      mpi: np.ndarray, asdeq: np.ndarray,
                      u200: np.ndarray, v200: np.ndarray,
                      u850: np.ndarray, v850: np.ndarray
                      ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pointwise (vPI, VI, chi_m) fields on the GC-ATLAS grid.

    All inputs are 2-D (lat, lon) float arrays at the same shape.
    NaNs propagate (land cells → NaN vPI, via the PI solve's SST mask).
    `mpi` and `asdeq` come from the same era5_pi_monthly solve, so the
    VI normalization and the χ_m denominator are mutually consistent —
    the T&E (2012, suppl. ES128) definition, matching the RT map
    layers. The old gridded s*_SST − s_b denominator measured ~38% too
    large → χ_m too small → vPI biased high.
    """
    # χ_m numerator — same Bryan-entropy machinery as the chi_m builder.
    r_m   = mixing_ratio_from_q(q_m)
    s_m   = bryan_moist_entropy(T_m, r_m, P_MID,   saturated=False)
    r_m_s = sat_mixing_ratio(T_m, P_MID)
    s_m_s = bryan_moist_entropy(T_m, r_m_s, P_MID, saturated=True)
    num = np.maximum(0.0, s_m_s - s_m)
    with np.errstate(invalid="ignore", divide="ignore"):
        chi_m = num / np.maximum(asdeq, 1.0)
    chi_m = np.where(np.isfinite(chi_m) & (asdeq >= 0), chi_m, np.nan)

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
    """Fetch the 8 input grids for one (month, year). Returns None if
    any are missing — vPI requires all of them simultaneously."""
    kw = dict(kind="mean", period=period, year=year)
    fields = {
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
    # Mid-level t/q at 600 mb come from the CDS sidecar (the GC-ATLAS
    # tile store has no 600 mb level); climo when year is None.
    from era5_600_sidecar import load_tq600
    mid = load_tq600(month, year=None if period == "default" else year)
    if mid is None:
        return None
    out["T_m"], out["q_m"] = mid
    # PI + BE-2002 air-sea disequilibrium from the shared monthly solve
    # (cached on disk; the chi_m builder reuses the same solves). The
    # computed VMAX reproduces the catalog's mpi tile to r=1.0000 /
    # -0.08 m/s (checked Sep 2005), and using it keeps VI's
    # normalization and χ_m's denominator on the identical PI state.
    from era5_pi_monthly import pi_for
    pi = pi_for(manifest, month, period=period, year=year)
    if pi is None:
        return None
    out["mpi"] = pi["vmax_ms"]
    out["asdeq"] = pi["asdeq"]
    return out


def compute_vpi_for(manifest: dict, month: int, *,
                    period: str = "default", year: int | None = None
                    ) -> np.ndarray | None:
    """Pointwise vPI field on the GC-ATLAS 1° grid. Returns None on
    missing inputs. Centralizes the multi-tile fetch + entropy +
    cubic-vPI computation so callers can use the field for both
    region means (Panel B) and gridded tile encoding (Panel C)."""
    grids = grids_for(manifest, month, period=period, year=year)
    if grids is None:
        return None
    vpi, _, _ = compute_vpi_field(**grids)
    return vpi


def region_means_from_field(vpi: np.ndarray) -> dict[str, float]:
    """cos(lat)-weighted regional means from a pre-computed vPI field.
    Pointwise then averaged — recovers Chavas Fig. 3c values for the
    Atlantic MDR that the basin-mean approach drove to zero (Jensen's
    inequality near VI_max)."""
    return {r: region_mean(vpi, box) for r, box in REGIONS.items()}


# ── Gridded vPI tile encoding (GC-ATLAS-compatible f16-gz format) ────
#
# Same encoding as the GC-ATLAS tile catalog: uint16 quantized to
# vmin..vmax range with 0xFFFF as the NaN sentinel, then gzip-deflated.
# The frontend's _evoDecodeGcAtlasTile already handles this format —
# we just need to host the tiles under a custom prefix and provide a
# manifest that matches the GC-ATLAS manifest schema.

GRIDDED_PREFIX = "era5_monthly_vpi"   # GCS path prefix under tc-atlas-ir-cache

def encode_vpi_tile(vpi_field: np.ndarray) -> tuple[bytes, float, float]:
    """Quantize the (181, 360) vPI field to uint16 + gzip. Returns
    (gzipped bytes, vmin, vmax). NaNs map to the 0xFFFF sentinel.
    Range is clipped to 0..120 m/s — vPI is bounded below by 0 (by
    construction in the cubic solution) and 120 m/s is a generous cap
    that captures all observed values (Chavas Fig. 3a PI peaks at
    ~95 m/s; vPI ≤ PI everywhere)."""
    import gzip as _gz
    vmin = 0.0
    vmax = 120.0
    arr = np.asarray(vpi_field, dtype=np.float32)
    # Quantize. NaN → sentinel 0xFFFF; finite values clip to [vmin,vmax].
    finite = np.isfinite(arr)
    clipped = np.clip(arr, vmin, vmax)
    scaled = ((clipped - vmin) / (vmax - vmin) * 65534.0).round()
    u16 = np.where(finite, scaled.astype(np.uint16), np.uint16(0xFFFF))
    raw = u16.tobytes()
    return _gz.compress(raw, compresslevel=6), vmin, vmax


def upload_gridded_tile(blob_path: str, gz_bytes: bytes,
                       content_type: str = "application/octet-stream") -> None:
    """Upload a single gz-compressed tile to GCS at era5_monthly_vpi/{path}.
    Requires GCS_IR_CACHE_BUCKET env var (defaults to tc-atlas-ir-cache).
    Skipped silently if google-cloud-storage isn't installed (local-only mode).
    """
    bucket_name = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
    try:
        from google.cloud import storage   # type: ignore
    except ImportError:
        return
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(f"{GRIDDED_PREFIX}/{blob_path}")
    blob.cache_control = "public, max-age=86400"
    blob.upload_from_string(gz_bytes, content_type=content_type,
                            predefined_acl="publicRead")


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
            "source": "gc-atlas-era5 (T+q@1000 + SST + MPI + u/v@200,850) "
                      "+ CDS ERA5 monthly means (T+q@600, era5_600_sidecar)",
            "method": "Pointwise vPI per Chavas et al. (2025) Eq. 4; "
                      "χ_m denominator = BE-2002 asdeq inverted from the "
                      "PI solve (T&E 2012 suppl. ES128); "
                      "cos(lat)-weighted regional mean of the vPI field",
            "vi_max": VI_MAX,
            "boundary_level_hpa": 1000,
            "mid_level_hpa": 600,
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

    # Manifest accumulator for gridded tile output (mimics GC-ATLAS
    # tile manifest schema so the frontend decoder works unchanged).
    gridded_manifest = {
        "groups": {
            "vpi": {                # single pseudo-group for our derived var
                "vpi": {
                    "var": "vpi",
                    "group": "vpi",
                    "long_name": "Ventilated potential intensity",
                    "units": "m s⁻¹",
                    "shape": [181, 360],
                    "lat_descending": True,
                    "lat_first": 90.0, "lat_last": -90.0,
                    "tiles": {},        # populated below
                },
            },
        },
    }
    # Wrap the (181, 360) field with NaN rows for the polar bands —
    # the GC-ATLAS tiles are always 181 rows even though we only
    # compute over the ±60° band. Without this padding, the frontend
    # decoder's hardcoded `srcRow = i + 30` offset (which assumes the
    # source is the full 181-row tile) would read wrong rows. NaN
    # pads above row 30 (lats 60.5..90) and below row 150 (lats -60.5
    # ..−90). compute_vpi_field outputs 181×360 already (since input
    # SST/MPI tiles are 181×360), so we can use the field as-is.

    def _process_month(month: int, *,
                      period: str, year: int | None,
                      tile_path: str) -> dict[str, float] | None:
        """Compute vPI for one (period, year, month), upload gridded
        tile, return region means (or None on missing input)."""
        vpi = compute_vpi_for(manifest, month, period=period, year=year)
        if vpi is None:
            return None
        # Emit gridded tile + manifest entry.
        gz, vmin, vmax = encode_vpi_tile(vpi)
        if not args.no_upload:
            upload_gridded_tile(tile_path, gz)
        # Manifest entry — tile key matches the GC-ATLAS convention:
        # climo: "{MM}"; per-year: "{YYYY}_{MM}".
        if period == "default":
            tile_key = f"{month:02d}"
        else:
            tile_key = f"{year}_{month:02d}"
        gridded_manifest["groups"]["vpi"]["vpi"]["tiles"][tile_key] = {
            "vmin": float(vmin), "vmax": float(vmax),
        }
        return region_means_from_field(vpi)

    # ── Climatology mean (12 months) ─────────────────────────────────
    log.info("=== Climatology mean (%s) ===", CLIM_PERIOD)
    for month in range(1, 13):
        log.info("  month %d climo", month)
        means = _process_month(month, period="default", year=None,
                                tile_path=f"tiles/{month:02d}.bin.gz")
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
            tp = f"tiles_per_year/{year}_{month:02d}.bin.gz"
            means = _process_month(month, period="per_year", year=year,
                                    tile_path=tp)
            if means is None:
                continue
            for region, v in means.items():
                key = f"{region}_vpi"
                block.setdefault(key, [None] * 12)[month - 1] = (
                    None if not np.isfinite(v) else round(float(v), 4)
                )

    # Upload the gridded manifest after all tiles are in.
    if not args.no_upload:
        try:
            from google.cloud import storage   # type: ignore
            bucket_name = os.environ.get("GCS_IR_CACHE_BUCKET",
                                          "tc-atlas-ir-cache")
            client = storage.Client()
            bucket = client.bucket(bucket_name)
            blob = bucket.blob(f"{GRIDDED_PREFIX}/manifest.json")
            blob.cache_control = "public, max-age=300"
            blob.upload_from_string(json.dumps(gridded_manifest),
                                    content_type="application/json",
                                    predefined_acl="publicRead")
            log.info("Uploaded gridded manifest → gs://%s/%s/manifest.json",
                     bucket_name, GRIDDED_PREFIX)
        except Exception as e:
            log.warning("gridded manifest upload skipped: %s", e)

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
