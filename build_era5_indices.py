"""Precompute monthly region-mean ERA5 TC-relevant fields from the
gc-atlas tile catalog.

GC-ATLAS hosts a global 1° monthly-mean ERA5 tile tree at
gs://gc-atlas-era5/{tiles,tiles_per_year} encoded as gzip'd uint16 with
per-tile (vmin, vmax) recorded in a manifest. This script:

  1. Downloads the manifest.
  2. For each TC-relevant ERA5 variable, fetches the climatology
     (1991-2020 mean + std) and per-year monthly tiles.
  3. Decodes to float arrays, applies the same REGIONS boxes as
     build_oisst_history.py, and computes cos(lat)-weighted region means.
  4. Writes a single static JSON consumed by Panel B on the Seasonal
     tab — same structure as indices_monthly.json so the same envelope /
     highlight-year / current-year machinery can paint these variables
     without backend changes.

Output:
    data/indices_monthly_era5.json   (≈ 300 KB compressed)

Variables included:
  mpi       — Bister-Emanuel max potential intensity (m s⁻¹)
  rh700     — 700-hPa relative humidity (%)
  chi200    — 200-hPa velocity potential (10⁶ m² s⁻¹)
  vo850     — 850-hPa relative vorticity (10⁻⁵ s⁻¹)
  tcwv      — column-integrated water vapor (kg m⁻²)
  dls       — deep-layer shear magnitude derived from monthly-mean
              u, v at 200 and 850 hPa (m s⁻¹).

Re-run periodically (after each new monthly tile batch lands on
gc-atlas-era5). Bandwidth: ~200 MB one-time fetch; wall time ≈ 5-10 min.
"""
from __future__ import annotations

import gzip
import io
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable

import numpy as np
import requests

# REGIONS box list lives in build_oisst_history.py; import to stay in
# sync with the SST panels. Same (lat_s, lat_n, lon_w, lon_e) shape with
# longitudes in [0, 360). GC-ATLAS tiles are on -180..179 so we rotate.
REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))
from build_oisst_history import REGIONS  # type: ignore  # noqa: E402

# ── GC-ATLAS tile endpoints ────────────────────────────────────────────
TILES_BASE   = "https://storage.googleapis.com/gc-atlas-era5/tiles"
PER_YR_BASE  = "https://storage.googleapis.com/gc-atlas-era5/tiles_per_year"
MANIFEST_URL = f"{TILES_BASE}/manifest.json"

# ── Fields we want as Panel B variables ───────────────────────────────
# Each entry: short name (used in output keys) → spec.
#   name      : manifest var name (None for derived fields like DLS).
#   level     : pressure-level (None for single-level).
#   units_out : pretty units string for the frontend.
#   transform : optional Python lambda applied to the decoded grid
#               *before* region averaging (e.g. unit conversion).
FIELDS: dict[str, dict] = {
    "mpi": {
        "name": "mpi", "level": None, "units_out": "m s⁻¹",
        "long_name": "Max potential intensity (Bister-Emanuel)",
    },
    "rh700": {
        "name": "r", "level": 700, "units_out": "%",
        "long_name": "Mid-level relative humidity (700 hPa)",
    },
    "chi200": {
        "name": "chi", "level": 200, "units_out": "10⁶ m² s⁻¹",
        "long_name": "200-hPa velocity potential (χ)",
        # GC-ATLAS scales chi to 10⁶ m² s⁻¹ in era5.js's applyUnitConversions —
        # raw tile is in m² s⁻¹ so we divide by 1e6 to match.
        "transform": lambda a: a / 1e6,
    },
    "vo850": {
        "name": "vo", "level": 850, "units_out": "10⁻⁵ s⁻¹",
        "long_name": "Low-level relative vorticity (ζ850)",
        # vo tile is s⁻¹; GC-ATLAS scales to 1e-5 s⁻¹ for display.
        "transform": lambda a: a * 1e5,
    },
    "tcwv": {
        "name": "tcwv", "level": None, "units_out": "kg m⁻²",
        "long_name": "Total column water vapor",
    },
    "dls": {
        "name": None, "level": None, "units_out": "m s⁻¹",
        "long_name": "Deep-layer shear (|⟨V₂₀₀⟩−⟨V₈₅₀⟩|)",
        "derived": True,
    },
}

# Climatology window matches the GC-ATLAS default tree.
CLIM_PERIOD = "1991-2020"
PER_YEAR_START = 1991
PER_YEAR_END   = 2026  # inclusive; per-year tiles run through the most-recent full month


def fetch_manifest() -> dict:
    r = requests.get(MANIFEST_URL, timeout=30)
    r.raise_for_status()
    return r.json()


def resolve_meta(manifest: dict, name: str) -> tuple[str, dict]:
    for group, vars_ in manifest["groups"].items():
        if name in vars_:
            return group, vars_[name]
    raise KeyError(f"variable {name!r} not in manifest")


def tile_url(group: str, var: str, level: int | None,
             month: int, *, kind: str = "mean",
             period: str = "default", year: int | None = None) -> str:
    if period == "per_year" and year is not None:
        if level is not None:
            return f"{PER_YR_BASE}/{group}/{var}/{level}_{year}_{month:02d}.bin.gz"
        return f"{PER_YR_BASE}/{group}/{var}/{year}_{month:02d}.bin.gz"
    prefix = "std_" if kind == "std" else ""
    if level is not None:
        return f"{TILES_BASE}/{group}/{var}/{prefix}{level}_{month:02d}.bin.gz"
    return f"{TILES_BASE}/{group}/{var}/{prefix}{month:02d}.bin.gz"


def tile_meta_key(level: int | None, month: int, *,
                  period: str = "default", year: int | None = None) -> str:
    if period == "per_year" and year is not None:
        if level is not None:
            return f"{level}_{year}_{month:02d}"
        return f"{year}_{month:02d}"
    if level is not None:
        return f"{level}_{month:02d}"
    return f"{month:02d}"


def fetch_tile(url: str, vmin: float, vmax: float,
               shape: tuple[int, int] = (181, 360)) -> np.ndarray:
    """Stream-decompress, dequantize → float32 (lat, lon). NaN for sentinel."""
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    raw = gzip.decompress(r.content)
    u16 = np.frombuffer(raw, dtype=np.uint16)
    if u16.size != shape[0] * shape[1]:
        raise ValueError(f"{url}: expected {shape[0]*shape[1]} samples, got {u16.size}")
    rng = (vmax - vmin) / 65534.0
    out = vmin + u16.astype(np.float32) * rng
    out[u16 == 65535] = np.nan
    return out.reshape(shape)


# ── Region mean (matches build_seasonal_diagnostics._region_mean) ─────
# GC-ATLAS grid: lat descending 90..-90, lon -180..179.
LATS = np.arange(90.0, -90.5, -1.0)
LONS = np.arange(-180.0, 180.0, 1.0)
COS_LAT = np.cos(np.deg2rad(LATS))


def region_mean(field2d: np.ndarray, box: tuple[float, float, float, float]) -> float:
    """cos(lat)-weighted mean over (lat_s, lat_n, lon_w, lon_e).
    REGIONS uses lon in [0, 360); convert to the tile's [-180, 180) frame."""
    lat_s, lat_n, lon_w, lon_e = box
    # Convert 0..360 boxes to -180..180.
    lw = lon_w - 360.0 if lon_w > 180.0 else lon_w
    le = lon_e - 360.0 if lon_e > 180.0 else lon_e
    lat_mask = (LATS >= lat_s) & (LATS <= lat_n)
    if lw <= le:
        lon_mask = (LONS >= lw) & (LONS <= le)
    else:
        # Box wraps the dateline (e.g., 170..210 → 170..179 ∪ -180..-150).
        lon_mask = (LONS >= lw) | (LONS <= le)
    sub = field2d[lat_mask][:, lon_mask]
    w = COS_LAT[lat_mask][:, None] * np.ones_like(sub)
    finite = np.isfinite(sub)
    if not finite.any():
        return float("nan")
    w = np.where(finite, w, 0.0)
    s = np.where(finite, sub, 0.0)
    den = float(w.sum())
    return float((s * w).sum() / den) if den > 0 else float("nan")


# ── Top-level workflow ───────────────────────────────────────────────
def fetch_field_grid(manifest: dict, manifest_var: str, level: int | None,
                     month: int, *, kind: str = "mean",
                     period: str = "default", year: int | None = None
                     ) -> np.ndarray | None:
    """Resolve the manifest entry, fetch + decode the tile. None on miss."""
    try:
        group, meta = resolve_meta(manifest, manifest_var)
    except KeyError:
        return None
    if period == "per_year":
        url = tile_url(group, manifest_var, level, month,
                       kind="mean", period="per_year", year=year)
        # per-year metadata key isn't in the climo manifest; fetch the
        # per-year manifest the same way GC-ATLAS does. We only need
        # vmin/vmax which is recorded on the per-year tile manifest.
        py_manifest = _get_per_year_manifest()
        if py_manifest is None:
            return None
        py_meta = resolve_meta(py_manifest, manifest_var)[1]
        tk = tile_meta_key(level, month, period="per_year", year=year)
        t = py_meta.get("tiles", {}).get(tk)
        if not t:
            return None
        return fetch_tile(url, t["vmin"], t["vmax"], tuple(py_meta["shape"]))
    # default tree
    url = tile_url(group, manifest_var, level, month, kind=kind)
    tk = tile_meta_key(level, month)
    if kind == "std":
        # Per-tile std metadata lives in the SAME `tiles` dict under
        # keys std_LEVEL_MM (pressure-level) or std_MM (single-level).
        # The top-level `std_vmin` / `std_vmax` on the manifest entry
        # are the ERA5 fill-value sentinel range (~±3.4e38) and must
        # NOT be used for dequantization — doing so injects sentinel-
        # scaled values into the std grid and poisons every region
        # mean derived from it.
        std_tk = "std_" + tk
        t = meta.get("tiles", {}).get(std_tk)
        if not t:
            return None
        t_vmin = t["vmin"]; t_vmax = t["vmax"]
    else:
        t = meta.get("tiles", {}).get(tk)
        if not t:
            return None
        t_vmin = t["vmin"]; t_vmax = t["vmax"]
    return fetch_tile(url, t_vmin, t_vmax, tuple(meta["shape"]))


_per_year_manifest_cache: dict | None = None
def _get_per_year_manifest() -> dict | None:
    global _per_year_manifest_cache
    if _per_year_manifest_cache is not None:
        return _per_year_manifest_cache
    try:
        r = requests.get(f"{PER_YR_BASE}/manifest.json", timeout=30)
        r.raise_for_status()
        _per_year_manifest_cache = r.json()
    except Exception as e:
        print(f"  WARN: per-year manifest fetch failed: {e}", file=sys.stderr)
        _per_year_manifest_cache = None
    return _per_year_manifest_cache


def compute_field_for(manifest: dict, short: str, spec: dict, month: int,
                      *, kind: str = "mean", period: str = "default",
                      year: int | None = None) -> dict[str, float] | None:
    """Returns {region_name: value} for this (short field, month, year/clim).
    Returns None if any required tile is missing."""
    if spec.get("derived") and short == "dls":
        # Need u/v at 200 and 850 — kind/period/year passed through.
        u200 = fetch_field_grid(manifest, "u", 200, month, kind=kind, period=period, year=year)
        u850 = fetch_field_grid(manifest, "u", 850, month, kind=kind, period=period, year=year)
        v200 = fetch_field_grid(manifest, "v", 200, month, kind=kind, period=period, year=year)
        v850 = fetch_field_grid(manifest, "v", 850, month, kind=kind, period=period, year=year)
        if any(x is None for x in (u200, u850, v200, v850)):
            return None
        grid = np.sqrt((u200 - u850) ** 2 + (v200 - v850) ** 2)
    else:
        grid = fetch_field_grid(manifest, spec["name"], spec.get("level"),
                                month, kind=kind, period=period, year=year)
        if grid is None:
            return None
        tr = spec.get("transform")
        if tr is not None:
            grid = tr(grid)
    return {region: region_mean(grid, box) for region, box in REGIONS.items()}


def main() -> None:
    print("Fetching GC-ATLAS climatology manifest...")
    manifest = fetch_manifest()

    out: dict = {
        "metadata": {
            "source": "gc-atlas-era5",
            "clim_period": CLIM_PERIOD,
            "per_year_start": PER_YEAR_START,
            "per_year_end_inclusive": PER_YEAR_END,
        },
        "fields": {k: {"units": v["units_out"], "long_name": v["long_name"]}
                   for k, v in FIELDS.items()},
        "regions": {r: list(box) for r, box in REGIONS.items()},
        "values": {},          # region_var → [12] climo mean
        "std":    {},          # region_var → [12] climo std
        "by_year": {},         # year → region_var → [12]
    }

    # ── Climatology mean + std (12 months) ─────────────────────────────
    print(f"\n=== Climatology mean + std ({CLIM_PERIOD}) ===")
    for short, spec in FIELDS.items():
        print(f"  {short} ({spec['long_name']})...")
        for month in range(1, 13):
            means = compute_field_for(manifest, short, spec, month, kind="mean")
            if means is None:
                print(f"    month {month}: skipped (missing tile)")
                continue
            for region, v in means.items():
                key = f"{region}_{short}"
                out["values"].setdefault(key, [None] * 12)[month - 1] = (
                    None if not np.isfinite(v) else round(float(v), 4))
            # std — best-effort; for derived dls we skip the std since the
            # error propagation through sqrt((u200-u850)^2+(v200-v850)^2)
            # isn't well-defined from independent component std fields.
            if spec.get("derived"):
                continue
            stds = compute_field_for(manifest, short, spec, month, kind="std")
            if stds is None:
                continue
            for region, v in stds.items():
                key = f"{region}_{short}"
                out["std"].setdefault(key, [None] * 12)[month - 1] = (
                    None if not np.isfinite(v) else round(float(v), 4))

    # ── Per-year monthly values ─────────────────────────────────────
    print(f"\n=== Per-year {PER_YEAR_START}..{PER_YEAR_END} ===")
    for year in range(PER_YEAR_START, PER_YEAR_END + 1):
        print(f"  year {year}...", end=" ", flush=True)
        year_block: dict[str, list[float | None]] = {}
        any_data = False
        for short, spec in FIELDS.items():
            for month in range(1, 13):
                vals = compute_field_for(manifest, short, spec, month,
                                         kind="mean", period="per_year", year=year)
                if vals is None:
                    continue
                any_data = True
                for region, v in vals.items():
                    key = f"{region}_{short}"
                    year_block.setdefault(key, [None] * 12)[month - 1] = (
                        None if not np.isfinite(v) else round(float(v), 4))
        if any_data:
            out["by_year"][str(year)] = year_block
            print("ok")
        else:
            print("no tiles")

    out_path = REPO / "data" / "indices_monthly_era5.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"\nWrote {out_path} ({out_path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
