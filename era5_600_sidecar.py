"""ERA5 600 hPa monthly-mean t/q sidecar for the seasonal χ_m / vPI builders.

Chavas confirmed (pers. comm. to M. Fischer, 2026-09) that the entropy
deficit belongs at 600 hPa — the level Tang & Emanuel (2012), Hoogewind
et al. (2019), the Chavas et al. (2025) paper text, and tcpyVPI all use,
and the level the RT map layers and the storm page's per-storm VI already
compute. The monthly ERA5 products (build_era5_chi_m_indices.py,
build_era5_vpi_indices.py) were the last holdouts at 700 hPa because the
GC-ATLAS tile store carries t/q at {..., 500, 700, 850, ...} but not 600
(its manifest's `levels` array lists 600 aspirationally; the tiles do not
exist — verified 2026-09-01).

This module closes that gap with real data rather than interpolation:
ERA5 *monthly averaged* temperature + specific humidity at 600 hPa,
downloaded straight from the Copernicus CDS at 1°, one small NetCDF per
year under data/era5_600_monthly/. Grids are re-oriented to the GC-ATLAS
tile frame (181 x 360, lat 90..-90 descending, lon -180..179) so callers
can mix them freely with `fetch_field_grid` output.

CLI:
    python3 era5_600_sidecar.py            # fetch any missing years 1991..now
    python3 era5_600_sidecar.py --refresh  # re-fetch the current year only
                                           # (new months appear with ~1 month
                                           # CDS lag; cheap, for cron use)

Library:
    from era5_600_sidecar import load_tq600
    T, q = load_tq600(month)               # 1991-2020 climo mean
    T, q = load_tq600(month, year=2026)    # one (year, month); None if absent

Requires ~/.cdsapirc (already present for build_era5_daily_archive.py).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import logging
from pathlib import Path

import numpy as np

log = logging.getLogger("era5_600_sidecar")

REPO = Path(__file__).parent
SIDECAR_DIR = REPO / "data" / "era5_600_monthly"

YEAR_START = 1991          # matches build_era5_indices.PER_YEAR_START
CLIM_YEARS = range(1991, 2021)   # matches CLIM_PERIOD "1991-2020"

_DATASET = "reanalysis-era5-pressure-levels-monthly-means"


def _year_path(year: int) -> Path:
    return SIDECAR_DIR / f"tq600_{year}.nc"


def fetch_year(year: int) -> bool:
    """Download one year of monthly-mean t/q @600 hPa at 1°. True on success.
    A year with no published months yet (fresh January) raises inside CDS;
    that is reported as False rather than an exception so callers can treat
    'nothing there yet' and 'already have it' uniformly."""
    import cdsapi  # lazy: keep module import cheap for library users

    SIDECAR_DIR.mkdir(parents=True, exist_ok=True)
    target = _year_path(year)
    tmp = target.with_suffix(".nc.part")
    c = cdsapi.Client()
    request = {
        "product_type": ["monthly_averaged_reanalysis"],
        "variable": ["temperature", "specific_humidity"],
        "pressure_level": ["600"],
        "year": [str(year)],
        "month": [f"{m:02d}" for m in range(1, 13)],
        "time": ["00:00"],
        # CDS regrids server-side; 1.0 matches the GC-ATLAS tile grid.
        "grid": [1.0, 1.0],
        "data_format": "netcdf",
        "download_format": "unarchived",
    }
    try:
        c.retrieve(_DATASET, request, str(tmp))
    except Exception as e:
        log.warning("CDS fetch failed for %d: %s", year, e)
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(target)
    log.info("fetched %s (%.1f KB)", target.name,
             target.stat().st_size / 1024.0)
    return True


def _open_year(year: int):
    """xarray Dataset for one cached year, or None."""
    p = _year_path(year)
    if not p.exists():
        return None
    import xarray as xr
    return xr.open_dataset(p)


def _to_tile_frame(arr: np.ndarray, lats: np.ndarray,
                   lons: np.ndarray) -> np.ndarray:
    """Re-orient a (lat, lon) grid to the GC-ATLAS tile frame:
    181 rows lat 90..-90 descending, 360 cols lon -180..179."""
    a = np.asarray(arr, dtype=np.float64)
    if lats[0] < lats[-1]:                     # ascending → flip to 90..-90
        a = a[::-1, :]
    if lons.min() >= 0.0:                      # 0..359 → roll to -180..179
        a = np.roll(a, 180, axis=1)
    if a.shape != (181, 360):
        raise ValueError(f"unexpected sidecar grid shape {a.shape}")
    return a


def _month_slab(ds, month: int) -> tuple[np.ndarray, np.ndarray] | None:
    """(T, q) tile-frame grids for one month out of a year's Dataset."""
    tname = "t" if "t" in ds else "temperature"
    qname = "q" if "q" in ds else "specific_humidity"
    timec = next((c for c in ("valid_time", "time", "date") if c in ds.coords
                  or c in ds.dims), None)
    latc = next(c for c in ("latitude", "lat") if c in ds.coords)
    lonc = next(c for c in ("longitude", "lon") if c in ds.coords)
    if timec is None:
        return None
    tv = ds[timec].values
    months = np.array([np.datetime64(v, "M").astype(object).month
                       if np.issubdtype(np.asarray(v).dtype, np.datetime64)
                       else int(str(v)[4:6]) for v in np.atleast_1d(tv)])
    idx = np.nonzero(months == month)[0]
    if idx.size == 0:
        return None
    sel = {timec: int(idx[0])}
    t2 = ds[tname].isel(**sel)
    q2 = ds[qname].isel(**sel)
    # Squeeze any leftover singleton (pressure_level) axes.
    t2 = np.squeeze(np.asarray(t2.values, dtype=np.float64))
    q2 = np.squeeze(np.asarray(q2.values, dtype=np.float64))
    lats = np.asarray(ds[latc].values, dtype=np.float64)
    lons = np.asarray(ds[lonc].values, dtype=np.float64)
    return (_to_tile_frame(t2, lats, lons), _to_tile_frame(q2, lats, lons))


def load_tq600(month: int, year: int | None = None
               ) -> tuple[np.ndarray, np.ndarray] | None:
    """(T_600 [K], q_600 [kg/kg]) on the GC-ATLAS tile frame.

    year=None → the 1991-2020 climatological mean of `month` (requires
    every climo year to be cached — a partial climo would silently bias
    the baseline). Otherwise that (year, month), or None if the sidecar
    file / month is absent (e.g. not yet published by CDS)."""
    if year is not None:
        ds = _open_year(year)
        if ds is None:
            return None
        try:
            return _month_slab(ds, month)
        finally:
            ds.close()
    ts, qs = [], []
    for y in CLIM_YEARS:
        ds = _open_year(y)
        if ds is None:
            log.warning("climo year %d missing from sidecar", y)
            return None
        try:
            slab = _month_slab(ds, month)
        finally:
            ds.close()
        if slab is None:
            log.warning("climo year %d lacks month %d", y, month)
            return None
        ts.append(slab[0]); qs.append(slab[1])
    return (np.mean(ts, axis=0), np.mean(qs, axis=0))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true",
                    help="re-fetch the current year only (for cron)")
    args = ap.parse_args()

    now = _dt.date.today()
    if args.refresh:
        years = [now.year]
        # January: the current year may have nothing published yet, but
        # December of last year lands with the same lag — refresh it too.
        if now.month <= 2:
            years.insert(0, now.year - 1)
    else:
        years = [y for y in range(YEAR_START, now.year + 1)
                 if not _year_path(y).exists()]
        # Always re-fetch the current (still-growing) year.
        if now.year not in years:
            years.append(now.year)

    log.info("fetching %d year(s): %s", len(years), years)
    ok = 0
    for y in years:
        ok += bool(fetch_year(y))
    log.info("done: %d/%d fetched", ok, len(years))


if __name__ == "__main__":
    main()
