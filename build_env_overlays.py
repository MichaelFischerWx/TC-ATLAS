"""Build global environmental overlay PNGs for the RT Monitor.

Produces three fields the user (researchers) toggle on/off on the global map:

  1. Deep-layer vertical wind shear magnitude (200 hPa - 850 hPa)
       Source: latest GFS 0.25° analysis (NOMADS cgi-bin filter)
       Units: knots
  2. 700-400 hPa layer-averaged relative humidity
       Source: same GFS analysis (RH at 700, 500, 400 hPa, simple mean)
       Units: %
  3. Sea-surface temperature
       Source: latest NOAA OISST daily v2.1 (NCEI)
       Units: degC

Each field is rendered as a global 1440x720 PNG with an appropriate
colormap and a sidecar metadata.json (valid_time, value range, colormap
ramp), then uploaded to GCS under

    env/{field}/latest.png
    env/{field}/metadata.json

The frontend reads metadata.json to learn the public URL of latest.png
and the colorbar info, then drops it on the Leaflet map as an
L.imageOverlay over the full globe.

Designed to run as a one-shot Cloud Run Job invoked every 6 hours by
Cloud Scheduler. Local invocation also works for testing:

    GCS_IR_CACHE_BUCKET=tc-atlas-ir-cache python build_env_overlays.py

The script exits 0 on full success, 1 if any field failed (partial
uploads are still committed so a transient OISST outage doesn't block
shear). Cloud Scheduler retries on non-zero exit.
"""

from __future__ import annotations

import io
import json
import logging
import os
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("build_env_overlays")


# --------------------------------------------------------------------------
# Output layout
# --------------------------------------------------------------------------

GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
GCS_PREFIX = "env"  # gs://{bucket}/{GCS_PREFIX}/{field}/...

# Global 0.25° lat/lon grid: 1440 lon x 721 lat (full globe inclusive of poles)
NX = 1440
NY = 721

# Render visualization PNGs at 2× the data grid so lines and filled
# edges stay crisp when Leaflet upscales the overlay at higher zoom
# levels. Doubles file size (~250-500 KB → ~1-2 MB per PNG) which is
# still very reasonable for the cadence + bandwidth we're operating at.
RENDER_SCALE = 2
IMG_NX = NX * RENDER_SCALE
IMG_NY = NY * RENDER_SCALE


# --------------------------------------------------------------------------
# GFS access — reuse the NOMADS cgi-bin filter pattern from ir_monitor_api
# but request the GLOBAL field (no lat/lon subsetting).
# --------------------------------------------------------------------------

GFS_FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
GFS_LATENCY_HOURS = 4.0  # NOMADS typically publishes ~3.5h after cycle time


def latest_gfs_cycle() -> tuple[str, str]:
    """Most recent GFS analysis cycle that should be on NOMADS now."""
    now = datetime.now(timezone.utc) - timedelta(hours=GFS_LATENCY_HOURS)
    cyc_hour = (now.hour // 6) * 6
    cyc_dt = now.replace(hour=cyc_hour, minute=0, second=0, microsecond=0)
    return cyc_dt.strftime("%Y%m%d"), f"{cyc_hour:02d}"


def fetch_gfs_global(date_str: str, hour_str: str,
                     levels: list, var: str,
                     forecast_hour: int = 0) -> Optional[bytes]:
    """Fetch a global GFS field for one variable across multiple levels.
    Returns raw GRIB2 bytes or None on failure.

    The cgi-bin filter applies var_X=on and lev_X=on toggles; output is
    a sequence of GRIB messages for every (var, level) that exists.

    `levels` accepts:
      - int (e.g. 850) → adds `lev_850_mb=on` (pressure level in mb)
      - str (e.g. "mean_sea_level", "surface") → adds the raw toggle as-is
    `forecast_hour` selects the GFS forecast step (0 = analysis, 1-384 = forecast).
    Most builders use 0 (analysis); the multi-hour pipeline iterates 0..12 so the
    on-page valid_time can align to real-time satellite imagery instead of being
    pinned to the 6-hourly analysis cycle.
    """
    import requests

    fh_str = f"{forecast_hour:03d}"
    params: list[tuple[str, str]] = [
        ("dir", f"/gfs.{date_str}/{hour_str}/atmos"),
        ("file", f"gfs.t{hour_str}z.pgrb2.0p25.f{fh_str}"),
        (f"var_{var}", "on"),
    ]
    for lev in levels:
        if isinstance(lev, int):
            params.append((f"lev_{lev}_mb", "on"))
        else:
            # String sentinel — NOMADS toggle name verbatim
            # (mean_sea_level, surface, 2_m_above_ground, etc.)
            params.append((f"lev_{lev}", "on"))

    # Try a couple of times — NOMADS occasionally serves 503s during peak.
    for attempt in range(3):
        try:
            r = requests.get(GFS_FILTER_URL, params=params, timeout=180,
                             stream=False)
            if r.status_code != 200:
                log.warning("NOMADS %s level=%s HTTP %d", var, levels, r.status_code)
                time.sleep(2 ** attempt)
                continue
            if not r.content.startswith(b"GRIB"):
                # cgi-bin returns an HTML error page when the cycle isn't published.
                log.warning("NOMADS %s level=%s returned non-GRIB body (%d bytes)",
                            var, levels, len(r.content))
                time.sleep(2 ** attempt)
                continue
            return r.content
        except Exception as e:
            log.warning("NOMADS fetch attempt %d failed: %s", attempt + 1, e)
            time.sleep(2 ** attempt)
    return None


def read_gfs_field(grib_bytes: bytes, level: int, var: str
                   ) -> Optional[np.ndarray]:
    """Decode a GRIB2 byte string and return the 2D array for one
    (var, level). Latitude convention is preserved from GFS (90 → -90,
    north-to-south). Caller is responsible for flipping if needed.
    """
    import cfgrib
    import xarray as xr

    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
        tmp.write(grib_bytes)
        path = tmp.name
    try:
        ds = xr.open_dataset(
            path,
            engine="cfgrib",
            backend_kwargs={"indexpath": ""},  # disable index files
            decode_timedelta=False,
        )
        # GFS variable naming in cfgrib varies by typeOfLevel: pressure-
        # level u/v come out as "u"/"v" but 10-m surface winds come out
        # as "u10"/"v10" (and 2-m temp as "t2m" vs the pressure-level
        # "t"). We try the pressure-level name first and fall back to
        # the surface-level alias if the GRIB only carries the surface
        # variant — keeps a single decoder happy across both groups.
        candidates = {
            "UGRD":  ["u", "u10"],
            "VGRD":  ["v", "v10"],
            "RH":    ["r"],
            "TMP":   ["t", "t2m"],
            "HGT":   ["gh"],
            "PRMSL": ["prmsl"],
        }
        names = candidates.get(var, [var.lower()])
        xname = next((n for n in names if n in ds.data_vars), None)
        if xname is None:
            log.warning("Variable %s not found in GRIB (tried %s, have: %s)",
                        var, names, list(ds.data_vars))
            return None

        da = ds[xname]
        if "isobaricInhPa" in da.dims:
            da = da.sel(isobaricInhPa=level)
        return np.asarray(da.values)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# --------------------------------------------------------------------------
# Stage 1B: shared GFS fetch
# --------------------------------------------------------------------------
# The naïve pipeline made ~27 NOMADS round-trips per forecast hour
# because every builder fetched its own (var, level) GRIB — UGRD@850 was
# requested 5 times alone (shear, midlevel_shear, vort_850, div_850,
# winds_850). `fetch_gfs_bundle()` resolves the full set in ~7 calls
# (one per (var, typeOfLevel) group), and builders look up the
# pre-decoded fields via `_load_fields()`.
#
# Builders preserve their legacy fetch path (bundle=None) so they can
# still be invoked standalone for local testing.

# Full set of (var, level) tuples the pipeline needs across all
# GFS-driven builders. Used by `fetch_gfs_bundle` to decide what to
# request and by `_load_fields` to error early if something is missing.
GFS_PRESSURE_REQUESTS = {
    "UGRD": [200, 500, 700, 850],
    "VGRD": [200, 500, 700, 850],
    "HGT":  [500],
    "RH":   [700, 500, 400],
}
GFS_SURFACE_REQUESTS = [
    ("UGRD",  "10_m_above_ground"),
    ("VGRD",  "10_m_above_ground"),
    ("PRMSL", "mean_sea_level"),
]


def fetch_gfs_bundle(date_str: str, hour_str: str,
                     forecast_hour: int = 0) -> dict:
    """Pre-fetch every (var, level) the env-overlay pipeline needs in
    ~7 NOMADS calls per forecast hour (one per (var, typeOfLevel) group)
    instead of the ~27 round-trips the naïve per-builder pattern made.

    Returns `{(var, level): np.ndarray}` keyed exactly the way
    `read_gfs_field` returns fields — pressure-level keys are int
    (200, 500, 700, 850), non-pressure keys are the NOMADS sentinel
    strings ("10_m_above_ground", "mean_sea_level"). Missing keys are
    omitted (no exception) — builders fall back to per-builder fetch
    if a key isn't in the bundle.

    Pressure-level fetches bundle every level for a given variable into
    one cgi-bin request (multi-level toggles); non-pressure
    typeOfLevels are split out so each GRIB carries a single
    typeOfLevel — keeps cfgrib happy without filter_by_keys gymnastics.
    """
    bundle: dict = {}
    from concurrent.futures import ThreadPoolExecutor

    # Each fetch is an independent NOMADS HTTP call returning GRIB bytes —
    # pure I/O with no shared state — so fan them out concurrently. The serial
    # round-trips dominated the per-forecast-hour wall-clock (and thus billed
    # job time). cfgrib decode (read_gfs_field) stays on the main thread since
    # eccodes isn't guaranteed thread-safe, and concurrency is kept modest so
    # NOMADS doesn't throttle (fetch_gfs_global already retries 503s).
    # Task tuple: (var, fetch_levels) — pressure groups all levels per call;
    # surface fetches one sentinel level each.
    tasks = [(var, list(levels)) for var, levels in GFS_PRESSURE_REQUESTS.items()]
    tasks += [(var, [lvl]) for var, lvl in GFS_SURFACE_REQUESTS]

    def _fetch(task):
        var, levels = task
        return task, fetch_gfs_global(date_str, hour_str, levels, var,
                                      forecast_hour=forecast_hour)

    with ThreadPoolExecutor(max_workers=min(4, len(tasks))) as pool:
        results = list(pool.map(_fetch, tasks))

    for (var, levels), grib in results:
        if grib is None:
            log.warning("bundle: %s f%03d fetch failed (levels=%s)",
                        var, forecast_hour, levels)
            continue
        for lvl in levels:
            # int level → cfgrib pressure selection; str sentinel → the
            # isobaricInhPa branch is bypassed (no such dim), `sel` ignored.
            sel = lvl if isinstance(lvl, int) else 0
            arr = read_gfs_field(grib, sel, var)
            if arr is not None:
                bundle[(var, lvl)] = arr
    log.info("Bundle f%03d: %d/%d fields cached",
             forecast_hour, len(bundle),
             sum(len(v) for v in GFS_PRESSURE_REQUESTS.values())
             + len(GFS_SURFACE_REQUESTS))
    return bundle


def _load_fields(date_str: str, hour_str: str, forecast_hour: int,
                 needs: list,
                 bundle: Optional[dict] = None) -> Optional[dict]:
    """Resolve a list of (var, level) requests against an optional
    shared bundle, falling back to per-var NOMADS fetches when bundle
    is None or missing a key. Returns `{(var, level): np.ndarray}` or
    None on any unresolvable field.

    Missing-from-bundle keys are grouped by var so one fall-back call
    can still cover multiple levels at once.
    """
    out: dict = {}
    missing: list = []
    for var, lvl in needs:
        if bundle is not None and (var, lvl) in bundle:
            out[(var, lvl)] = bundle[(var, lvl)]
        else:
            missing.append((var, lvl))
    if missing:
        by_var: dict = {}
        for var, lvl in missing:
            by_var.setdefault(var, []).append(lvl)
        for var, levels in by_var.items():
            grib = fetch_gfs_global(date_str, hour_str, levels, var,
                                    forecast_hour=forecast_hour)
            if grib is None:
                log.error("_load_fields: NOMADS fetch failed for %s "
                          "levels=%s f%03d", var, levels, forecast_hour)
                return None
            for lvl in levels:
                # int level → cfgrib pressure selection; str sentinel
                # → unused (the GRIB has only one typeOfLevel anyway).
                sel = lvl if isinstance(lvl, int) else 0
                arr = read_gfs_field(grib, sel, var)
                if arr is None:
                    log.error("_load_fields: missing %s @ %s f%03d",
                              var, lvl, forecast_hour)
                    return None
                out[(var, lvl)] = arr
    return out


# --------------------------------------------------------------------------
# OISST access
# --------------------------------------------------------------------------

OISST_BASE = (
    "https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-"
    "interpolation/v2.1/access/avhrr"
)
# PSL THREDDS OPeNDAP daily file — a reliable fallback when the NCEI HTTP
# endpoint stalls from Cloud Run (the seasonal pipeline pulls OISST this way).
OISST_PSL_OPENDAP = (
    "https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres/"
    "sst.day.mean.{year}.nc"
)
# 1991-2020 daily long-term-mean climatology — GLOBAL 720x1440 OISST grid, the
# same as the daily files above, so the anomaly subtraction lines up pixel-for-
# pixel (the seasonal/ monthly-climo GCS file is a regional 480x1040 grid).
OISST_PSL_LTM = (
    "https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres/"
    "sst.day.mean.ltm.1991-2020.nc"
)


def _fetch_oisst_psl() -> Optional[tuple]:
    """Fallback OISST via PSL OPeNDAP. Opens the current-year (then prior-year)
    daily file, takes the last non-all-NaN time slice, and returns
    (sst, ymd) on the OISST native grid reoriented N->S, lon -180..180 — the
    same orientation as _read_oisst_nc, so build_sst()'s 720->721 pad applies."""
    import xarray as xr
    now = datetime.now(timezone.utc)
    for yr in (now.year, now.year - 1):
        url = OISST_PSL_OPENDAP.format(year=yr)
        try:
            # Force the netCDF4 backend — it carries OPeNDAP/DAP support, whereas
            # xarray could otherwise auto-pick h5netcdf (no DAP) for a .nc URL.
            ds = xr.open_dataset(url, engine="netcdf4")
        except Exception as e:
            log.warning("OISST PSL open failed for %d: %s", yr, e)
            continue
        try:
            da = ds["sst"]
            ti = None
            for k in range(da.sizes["time"] - 1, -1, -1):
                if bool(np.isfinite(da.isel(time=k).values).any()):
                    ti = k
                    break
            if ti is None:
                ds.close()
                continue
            sl = da.isel(time=ti)
            ymd = str(np.datetime_as_string(sl["time"].values, unit="D")).replace("-", "")
            arr = np.asarray(sl.values, dtype=np.float32)   # (lat, lon), degC
            lat0 = float(ds["lat"].values[0])
            ds.close()
        except Exception as e:
            log.warning("OISST PSL decode failed: %s", e)
            try:
                ds.close()
            except Exception:
                pass
            continue
        if lat0 < 0:                       # S->N -> N->S
            arr = arr[::-1, :]
        arr = np.roll(arr, NX // 2, axis=1)  # 0..360 -> -180..180
        log.info("OISST: using PSL OPeNDAP %s (%d)", ymd, yr)
        return arr, ymd
    return None


def fetch_oisst_sst() -> Optional[tuple[np.ndarray, str]]:
    """Fetch the latest NOAA OISST v2.1 daily SST. Returns (sst_array, valid_date)
    or None on failure.

    OISST runs in two stages. Recent days are served as
    ``oisst-avhrr-v02r01.YYYYMMDD_preliminary.nc`` until QC finalizes
    them (typically ~2 weeks); after that the file is renamed to
    ``oisst-avhrr-v02r01.YYYYMMDD.nc``. We try the preliminary name first
    (newer data) then fall back to the finalized one, walking back ~10
    days until something exists.
    """
    import requests
    import time as _time

    # Per-request and total-budget caps. NCEI's OISST endpoint is
    # intermittently slow; this loop used to use a 180 s per-request
    # timeout, which meant a hang could burn 20 × 180 s = 60 min of pure
    # Cloud Run vCPU before giving up. 20 s per call + 90 s wall-clock
    # cap on the whole walk-back loop bounds the worst case to ~90 s of
    # wasted compute and lets the rest of the job continue (the prior-
    # day SST PNG in GCS stays current as a fallback).
    # NCEI's OISST endpoint is chronically slow/unreachable from Cloud Run, so
    # keep its attempt window short and ALWAYS fall through to the PSL OPeNDAP
    # mirror — whether NCEI is exhausted (loop completes) or just too slow
    # (budget break). The earlier code `return None`-ed on budget exhaustion,
    # which skipped PSL entirely and left SST + SST-anomaly empty every run.
    PER_REQ_TIMEOUT = 15.0
    TOTAL_BUDGET_S  = 45.0

    now = datetime.now(timezone.utc)
    started = _time.monotonic()
    for back in range(1, 10):
        if _time.monotonic() - started > TOTAL_BUDGET_S:
            log.warning("OISST: NCEI walk-back exceeded %.0fs budget — trying PSL",
                        TOTAL_BUDGET_S)
            break
        d = now - timedelta(days=back)
        ymd = d.strftime("%Y%m%d")
        ym = d.strftime("%Y%m")
        for fname in (f"oisst-avhrr-v02r01.{ymd}_preliminary.nc",
                      f"oisst-avhrr-v02r01.{ymd}.nc"):
            if _time.monotonic() - started > TOTAL_BUDGET_S:
                break
            url = f"{OISST_BASE}/{ym}/{fname}"
            try:
                r = requests.get(url, timeout=PER_REQ_TIMEOUT)
                if r.status_code != 200:
                    continue
                sst = _read_oisst_nc(r.content)
                if sst is not None:
                    log.info("OISST: using %s (%s)", ymd,
                             "preliminary" if "_preliminary" in fname else "final")
                    return sst, ymd
                log.warning("OISST decode failed for %s", url)
            except Exception as e:
                log.warning("OISST fetch %s failed: %s", url, e)
    # NCEI HTTP exhausted/slow (chronic from Cloud Run) → PSL OPeNDAP mirror.
    log.info("OISST: NCEI unavailable, trying PSL OPeNDAP fallback")
    return _fetch_oisst_psl()


def _read_oisst_nc(blob: bytes) -> Optional[np.ndarray]:
    """Decode an OISST NetCDF into a 2D SST array on the OISST native
    0.25° grid (720 lat x 1440 lon), oriented south-to-north. We
    reorient to north-to-south (90 → -90) to match GFS convention before
    returning.
    """
    import xarray as xr
    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
        tmp.write(blob)
        path = tmp.name
    try:
        ds = xr.open_dataset(path)
        if "sst" not in ds.data_vars:
            log.warning("OISST: 'sst' missing (have: %s)", list(ds.data_vars))
            return None
        sst = ds["sst"].squeeze().values  # (lat, lon) in degC
        # OISST is south-to-north. Flip to north-to-south.
        if ds["lat"].values[0] < 0:
            sst = sst[::-1, :]
        # OISST lon is 0..360. Roll to -180..180 so the PNG aligns with
        # Leaflet's default world bounds.
        sst = np.roll(sst, NX // 2, axis=1)
        return sst.astype(np.float32)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

@dataclass
class LayerSpec:
    name: str            # short id, e.g. "shear"
    title: str           # display label
    units: str
    vmin: float          # colorbar / contour-range minimum
    vmax: float          # colorbar / contour-range maximum
    step: float          # contour interval (same units, used in contour mode)
    cmap: str            # matplotlib colormap name
    valid_time: str      # ISO8601 string
    description: str = ""
    # "contour" = labelled isolines (good for smooth gradients: shear, SST)
    # "filled"  = continuous shaded field (good for noisier scalars: RH)
    render_style: str = "contour"
    # Routes the layer into the right frontend menu. "env" = GFS/OISST
    # diagnostics; "genesis" = FNV3 cyclogenesis ML forecasts. Filtered
    # client-side so the Env Analysis menu doesn't mix observation
    # diagnostics with model forecast products.
    category: str = "env"
    # If set, overrides the linspace(vmin, vmax, step+1) contour levels.
    # Useful for fields with a wide dynamic range (vorticity) where a
    # finer-then-coarser ramp like [1, 2, 4, 6, 8, 10, 15, 20, 25]
    # reads better than evenly-spaced levels.
    levels_override: Optional[list] = None
    # Optional wider range for the hover data PNG so the readout can
    # report jet-stream-magnitude shear or extreme TC vortex values
    # without clipping at the contour vmax. Defaults to (vmin, vmax)
    # when None, which preserves back-compat for layers that don't
    # need a wider hover range.
    data_vmin: Optional[float] = None
    data_vmax: Optional[float] = None
    # When True, the filled renderer paints the field in solid color
    # BANDS keyed off `levels` (BoundaryNorm) instead of a continuous
    # gradient. Pairs naturally with the frontend's swatch-style legend
    # so individual probability tiers are immediately readable
    # (TC-RADAR radial-velocity style). Default False for back-compat
    # with smooth shaded fields like RH / SST.
    discrete_bins: bool = False
    # ── Hourly forecast architecture ──
    # GFS-driven fields are rendered at multiple forecast hours (f000..f012)
    # per cycle so the on-page valid_time can align to real-time satellite
    # imagery. forecast_hour=0 = analysis (back-compat with prior single-PNG
    # output). init_cycle = "YYYYMMDD-HH" of the GFS run we pulled from;
    # used in the GCS path init-{cycle}/f{HH}/ to keep cycles separated.
    # Fields without hourly forecasts (OISST, genesis_prob, subseasonal)
    # leave both at defaults — upload_layer falls back to the single-PNG
    # latest.png path.
    forecast_hour: Optional[int] = None
    init_cycle: Optional[str] = None


# Each 0.25° cell spans ~27.8 km in the latitude direction (and at the
# equator in longitude). Used to convert "500 km" → kernel cell-radius.
KM_PER_CELL = 27.8


def _disc_kernel(radius_cells: int) -> np.ndarray:
    """Normalized circular disc kernel for area-average smoothing."""
    n = 2 * radius_cells + 1
    yy, xx = np.ogrid[-radius_cells:radius_cells + 1,
                      -radius_cells:radius_cells + 1]
    mask = (xx * xx + yy * yy) <= radius_cells * radius_cells
    k = mask.astype(np.float32)
    return k / k.sum()


def disc_smooth(field: np.ndarray, radius_km: float) -> np.ndarray:
    """Smooth `field` with a circular disc area-average of the given
    physical radius. Uses wrap mode along the longitude axis so the
    field stays continuous across the prime meridian / dateline; pole
    wrap is acceptable cosmetically because TC activity is tropical.

    Default elsewhere is 400 km — a compromise between vortex/local
    suppression (SHIPS-style env shear) and not blurring out the
    synoptic peaks operations charts (CIMSS et al.) emphasize.

    The kernel is fixed in grid cells (≈27.8 km/cell at the equator), so
    the effective radius shrinks slightly at higher latitudes — fine for
    TC-focused diagnostics, which live in the deep tropics where the
    approximation holds.
    """
    from scipy.ndimage import convolve
    radius_cells = max(1, int(round(radius_km / KM_PER_CELL)))
    k = _disc_kernel(radius_cells)
    return convolve(field, k, mode="wrap")


def _render_contour_png(field: np.ndarray, spec: LayerSpec) -> bytes:
    """Render `field` as colored isolines on a transparent background.

    No inline value labels — matplotlib's text rasterizes at PNG bake
    time, which the Leaflet Mercator projection then stretches (badly
    at high latitudes and on zoom). The colorbar legend + hover tooltip
    handle value readout instead.

    Rendered at IMG_NX × IMG_NY (2× the data grid) so contour lines
    stay crisp when Leaflet upscales the overlay at higher zoom levels.
    matplotlib antialiases the lines at the higher figure resolution so
    each isoline gets sub-pixel-precise edges.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    field = np.asarray(field, dtype=np.float32)
    mask = ~np.isfinite(field)
    if mask.any():
        field = field.copy()
        field[mask] = np.nan

    dpi = 100
    fig = plt.figure(figsize=(IMG_NX / dpi, IMG_NY / dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    ax.set_xlim(0, NX - 1)
    ax.set_ylim(NY - 1, 0)

    if spec.levels_override:
        levels = np.asarray(spec.levels_override, dtype=np.float64)
    else:
        n_steps = int(round((spec.vmax - spec.vmin) / spec.step)) + 1
        levels = np.linspace(spec.vmin, spec.vmax, n_steps)
    ax.contour(
        np.arange(NX), np.arange(NY), field,
        levels=levels,
        cmap=spec.cmap,
        vmin=spec.vmin, vmax=spec.vmax,
        linewidths=1.6 * RENDER_SCALE,  # scale stroke too so they don't look thread-thin
    )

    buf = io.BytesIO()
    fig.savefig(buf, format="PNG", transparent=True, dpi=dpi,
                bbox_inches=None, pad_inches=0)
    plt.close(fig)
    return buf.getvalue()


def _render_filled_png(field: np.ndarray, spec: LayerSpec) -> bytes:
    """Render `field` as a continuous filled colormap (PIL-based) so a
    noisy scalar like 700-400 hPa RH reads as a shaded gradient instead
    of as a tangle of unstable isolines.

    NaN cells become transparent so the basemap shows through (notably
    over land for SST-style scalars). Upsamples the field to IMG_NX ×
    IMG_NY via bilinear before mapping to colors so the gradient stays
    smooth at zoom rather than turning into 0.25° pixel stippling.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.colors as mcolors
    from PIL import Image

    field = np.asarray(field, dtype=np.float32)
    cmap = matplotlib.colormaps.get_cmap(spec.cmap)

    # Discrete bands keyed off `levels_override` (or implicit linspace
    # via vmin/vmax/step). BoundaryNorm produces a stepped colormap so
    # each probability tier reads as a solid band — much easier to
    # discriminate at a glance than a smooth gradient. Frontend
    # colorbar already swatch-renders matching bins.
    if spec.discrete_bins:
        if spec.levels_override:
            bounds = list(spec.levels_override)
        else:
            n_steps = max(2, int(round((spec.vmax - spec.vmin) / spec.step)) + 1)
            bounds = list(np.linspace(spec.vmin, spec.vmax, n_steps))
        # BoundaryNorm needs len(bounds)-1 colors; sample the cmap
        # uniformly so swatch row + raster bands stay in lock-step.
        n_bins = max(1, len(bounds) - 1)
        sampled = cmap(np.linspace(0.0, 1.0, n_bins))
        cmap = mcolors.ListedColormap(sampled)
        norm = mcolors.BoundaryNorm(bounds, n_bins, clip=True)
    else:
        norm = mcolors.Normalize(vmin=spec.vmin, vmax=spec.vmax, clip=True)

    # Bilinear upsample BEFORE colormapping so the gradient stays smooth
    # at zoom. For BOTH continuous and discrete-bin layers we use
    # BILINEAR on the field — for discrete bins this is the key to
    # smooth band boundaries: the interpolated intermediate values get
    # snapped to the right bin by BoundaryNorm, so the band SHAPES are
    # smooth curves rather than 0.25°-cell stairsteps. NaN cells need a
    # sentinel that doesn't blend across the ocean/land boundary;
    # replace with vmin then re-mask after with a NEAREST-resampled
    # alpha so the masked-region edges stay crisp.
    finite_mask = np.isfinite(field)
    work = np.where(finite_mask, field, spec.vmin)
    img_f = Image.fromarray(work).resize((IMG_NX, IMG_NY), Image.BILINEAR)
    img_m = Image.fromarray((finite_mask * 255).astype(np.uint8)).resize(
        (IMG_NX, IMG_NY), Image.NEAREST)
    big = np.asarray(img_f, dtype=np.float32)
    big_mask = np.asarray(img_m) > 0

    rgba = cmap(norm(big))
    rgba_u8 = (rgba * 255).astype(np.uint8)
    rgba_u8[~big_mask, 3] = 0

    img = Image.fromarray(rgba_u8, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# Maximum latitude that Web Mercator can represent without diverging.
# Used for the y-axis limit of warped layer PNGs so Leaflet's L.imageOverlay
# can place them at the correct geographic latitudes on a Mercator basemap.
WEB_MERC_LAT_MAX = 85.05112877980659  # arctan(sinh(pi)) * 180/pi

def _warp_eq_to_mercator(field: np.ndarray, ny_out: Optional[int] = None
                         ) -> np.ndarray:
    """Re-sample an equirectangular field (lat ∈ [+90, -90], rows top→bottom)
    onto a Web Mercator pixel grid (lat ∈ [+85.05, -85.05], rows top→bottom
    spaced uniformly in Mercator y).

    Leaflet's L.imageOverlay places an image inside lat/lon bounds by
    CSS-stretching it linearly between the *projected* corner positions.
    On a Mercator basemap that means an equirectangular source is
    geographically displaced at every non-equatorial latitude — at 14°N
    the source row representing 14° actually paints at the screen
    position equivalent to ~26°N (a ~13° vertical shift). Pre-warping
    the field to Mercator pixel-space makes the linear stretch correct.

    NaN cells are preserved (nearest-neighbor sampling so band edges
    don't blur across masked regions).
    """
    ny_in, nx_in = field.shape
    if ny_out is None:
        ny_out = ny_in
    # Mercator y for the top/bottom rows of the output. We use ±MAX_LAT
    # rather than ±90 because Mercator diverges at the poles; the GIBS
    # tile basemap uses the same cap.
    max_my = np.log(np.tan(np.pi/4 + np.radians(WEB_MERC_LAT_MAX) / 2))
    # Inverse Mercator for each output row's center pixel.
    rows_out = np.arange(ny_out, dtype=np.float64)
    # Linear in Mercator y from +max_my (top) to -max_my (bottom).
    merc_y = max_my - (rows_out + 0.5) / ny_out * (2 * max_my)
    lats = np.degrees(np.arctan(np.sinh(merc_y)))
    # Equirectangular source row for each target lat. Nearest neighbor.
    src_rows = np.clip(np.round((90.0 - lats) / 180.0 * ny_in).astype(int),
                       0, ny_in - 1)
    return field[src_rows, :].copy()


def render_layer_png(field: np.ndarray, spec: LayerSpec) -> bytes:
    """Dispatch to the contour or filled renderer based on render_style.

    Both variants warp the field to Web Mercator pixel-space before
    encoding so L.imageOverlay's linear CSS-stretch produces a
    geographically-correct display on the Mercator basemap. (Without
    the warp, equirectangular pixels are displaced vertically — at
    14°N the image data lands ~13° too far north on screen.) The
    contour-layer GeoJSON sidecar uses real lat/lon polylines and is
    already projection-correct via L.geoJSON's per-point projection;
    this warp only matters for the raster fallback path."""
    warped = _warp_eq_to_mercator(field)
    if spec.render_style == "filled":
        return _render_filled_png(warped, spec)
    return _render_contour_png(warped, spec)


def render_contour_geojson(field: np.ndarray, spec: LayerSpec) -> bytes:
    """Extract contour line segments from matplotlib's `contour()` and
    serialize as a GeoJSON FeatureCollection of LineStrings with each
    feature tagged by its contour level + color.

    Why: contour layers rendered as raster PNG go soft when Leaflet
    upscales them at high zoom. Vector polylines stay crisp at any
    zoom — same as how the DeepMind track overlays look.

    Each cell on the 0.25° grid maps to a lat/lon pair via:
        lon = -180 + col * 0.25
        lat =  +90 - row * 0.25
    matplotlib emits segments in (col, row) pixel coords; we convert
    once here. Segments that span > 180° of longitude (almost always
    a false antimeridian crossing where matplotlib joined two distant
    contour pieces) get split into two so Leaflet doesn't draw a
    polyline across the entire globe.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    field = np.asarray(field, dtype=np.float32)
    mask = ~np.isfinite(field)
    if mask.any():
        field = field.copy()
        field[mask] = np.nan

    fig = plt.figure()
    ax = fig.add_subplot(111)
    if spec.levels_override:
        levels = np.asarray(spec.levels_override, dtype=np.float64)
    else:
        n_steps = int(round((spec.vmax - spec.vmin) / spec.step)) + 1
        levels = np.linspace(spec.vmin, spec.vmax, n_steps)
    cs = ax.contour(
        np.arange(NX), np.arange(NY), field,
        levels=levels,
    )
    plt.close(fig)

    cmap = matplotlib.colormaps.get_cmap(spec.cmap)
    span = (spec.vmax - spec.vmin) or 1.0

    def _split_antimeridian(coords: list) -> list:
        """Break a coord list anywhere it jumps > 180° in longitude."""
        if len(coords) < 2:
            return [coords]
        out, cur = [], [coords[0]]
        for i in range(1, len(coords)):
            if abs(coords[i][0] - coords[i - 1][0]) > 180.0:
                if len(cur) >= 2:
                    out.append(cur)
                cur = [coords[i]]
            else:
                cur.append(coords[i])
        if len(cur) >= 2:
            out.append(cur)
        return out

    features = []
    for lvl_idx, segs in enumerate(cs.allsegs):
        lvl = float(levels[lvl_idx])
        t = max(0.0, min(1.0, (lvl - spec.vmin) / span))
        r, g, b, _ = cmap(t)
        color = "#{:02x}{:02x}{:02x}".format(int(r * 255), int(g * 255), int(b * 255))
        for seg in segs:
            if len(seg) < 2:
                continue
            coords = []
            for px, py in seg:
                lon = -180.0 + float(px) * (360.0 / NX)
                lat = 90.0 - float(py) * (180.0 / (NY - 1))
                coords.append([round(lon, 3), round(lat, 3)])
            for sub in _split_antimeridian(coords):
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": sub},
                    "properties": {"level": lvl, "color": color},
                })

    fc = {"type": "FeatureCollection", "features": features}
    return json.dumps(fc, separators=(",", ":")).encode("utf-8")


def render_data_png(field: np.ndarray, spec: LayerSpec) -> bytes:
    """Encode the raw field as a native-resolution 8-bit grayscale PNG
    so the frontend can read exact values on hover.

    Pixel intensity 0-255 maps linearly to [spec.vmin, spec.vmax]; NaN
    cells become 0 with alpha=0 so the hover handler can skip them.
    Kept at the data's native 1440 × 721 (0.25°) so a hover at any
    lat/lon returns the same value the visualization is drawn from —
    we previously block-averaged to 720 × 361 and the bilinear-
    interpolated visualization (filled mode) sometimes disagreed with
    the discrete hover value at sharp gradients.

    File size: ~500 KB PNG-compressed per layer (8-bit greyscale of a
    1.04 M-pixel array). Frontend draws to an offscreen canvas once
    per layer activation and samples via getImageData(1,1) (~0.1 ms).
    """
    from PIL import Image

    field = np.asarray(field, dtype=np.float32)
    # Hover-encoding range may be wider than the contour range so the
    # tooltip can report jet-stream / extreme values without clipping.
    dv_min = spec.data_vmin if spec.data_vmin is not None else spec.vmin
    dv_max = spec.data_vmax if spec.data_vmax is not None else spec.vmax
    norm = np.clip((field - dv_min) / max(dv_max - dv_min, 1e-9),
                   0.0, 1.0)
    gray = (norm * 255).astype(np.uint8)

    h, w = gray.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., 0] = gray
    rgba[..., 1] = gray
    rgba[..., 2] = gray
    rgba[..., 3] = np.isfinite(field).astype(np.uint8) * 255

    img = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _get_cmap(cmap_name: str):
    """Wrapper around matplotlib's colormap accessor that uses the
    non-deprecated `colormaps[name]` interface."""
    import matplotlib
    return matplotlib.colormaps.get_cmap(cmap_name)


def build_colormap_stops(cmap_name: str, n: int = 16) -> list[dict]:
    """Sample a matplotlib colormap to N RGB stops the frontend can
    paint a colorbar with."""
    cmap = _get_cmap(cmap_name)
    stops = []
    for i in range(n):
        t = i / (n - 1)
        r, g, b, _ = cmap(t)
        stops.append({
            "t": round(t, 4),
            "rgb": [int(r * 255), int(g * 255), int(b * 255)],
        })
    return stops


def _level_colors(cmap_name: str, levels: list, vmin: float, vmax: float
                  ) -> list[list[int]]:
    """Return the exact RGB color (0-255) matplotlib uses for each
    contour level, so the frontend legend swatches match the rendered
    isolines pixel-for-pixel.
    """
    cmap = _get_cmap(cmap_name)
    span = (vmax - vmin) or 1.0
    out = []
    for lvl in levels:
        t = max(0.0, min(1.0, (lvl - vmin) / span))
        r, g, b, _ = cmap(t)
        out.append([int(r * 255), int(g * 255), int(b * 255)])
    return out


# --------------------------------------------------------------------------
# GCS upload
# --------------------------------------------------------------------------

def upload_layer(spec: LayerSpec, field: np.ndarray) -> bool:
    """Render and upload three artifacts for a layer: the visualization
    PNG (contour or filled), the data PNG (greyscale raw values for
    hover), and the metadata sidecar. All marked public on the GCS
    bucket so the frontend reads them directly.
    """
    try:
        from google.cloud import storage
    except ImportError:
        log.error("google-cloud-storage not installed; cannot upload")
        return False

    if not GCS_BUCKET:
        log.error("GCS_IR_CACHE_BUCKET not set; cannot upload")
        return False

    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)

    png = render_layer_png(field, spec)
    data_png = render_data_png(field, spec)

    # Contour-style layers also get a GeoJSON sidecar so Leaflet can
    # draw them as vector polylines (crisp at every zoom). Filled
    # layers skip this and render purely as raster.
    geojson = None
    if spec.render_style == "contour":
        try:
            geojson = render_contour_geojson(field, spec)
        except Exception as e:
            log.warning("Failed to render contour GeoJSON for %s: %s", spec.name, e)

    # Decide path layout: hourly-forecast scheme when spec carries a
    # forecast_hour + init_cycle, single-PNG legacy path otherwise.
    # The hourly scheme writes per-hour PNG/JSON to
    #   env/{name}/init-{cycle}/f{HH}.{png,geojson,_data.png,.json}
    # and, when forecast_hour == 0 (the analysis), ALSO clobbers
    # env/{name}/latest.png + metadata.json so the older frontend code
    # (and any external consumers caching that URL) keep working.
    is_hourly = spec.forecast_hour is not None and spec.init_cycle is not None
    if is_hourly:
        hh_str = f"{spec.forecast_hour:03d}"
        per_hour_dir = f"{GCS_PREFIX}/{spec.name}/init-{spec.init_cycle}"
        png_blob = bucket.blob(f"{per_hour_dir}/f{hh_str}.png")
        data_blob = bucket.blob(f"{per_hour_dir}/f{hh_str}_data.png")
        geojson_blob = bucket.blob(f"{per_hour_dir}/f{hh_str}.geojson")
        meta_blob = bucket.blob(f"{per_hour_dir}/f{hh_str}.json")
        # Back-compat blobs that also get written when forecast_hour == 0
        latest_png_blob  = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest.png")
        latest_data_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest_data.png")
        latest_gj_blob   = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest.geojson")
        latest_meta_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/metadata.json")
    else:
        png_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest.png")
        data_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest_data.png")
        geojson_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest.geojson")
        meta_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/metadata.json")

    if spec.levels_override:
        levels = [float(L) for L in spec.levels_override]
    else:
        n_steps = int(round((spec.vmax - spec.vmin) / spec.step)) + 1
        levels = [round(spec.vmin + i * spec.step, 2) for i in range(n_steps)]
    level_colors = _level_colors(spec.cmap, levels, spec.vmin, spec.vmax)

    # Data PNG is at native 0.25° resolution since v4 (no downsample);
    # the frontend uses these to map lat/lon → pixel.
    data_nx = NX
    data_ny = NY

    # URL paths follow the chosen layout. The per-hour metadata.json gets
    # the per-hour URLs; the back-compat metadata.json (at
    # env/{name}/metadata.json, written only at forecast_hour=0) gets the
    # legacy latest.png URLs so the existing frontend keeps working until
    # the new picker UI lands.
    if is_hourly:
        base = f"https://storage.googleapis.com/{GCS_BUCKET}/{per_hour_dir}/f{hh_str}"
        image_url_per_hour = f"{base}.png"
        data_url_per_hour  = f"{base}_data.png"
        geojson_url_per_hour = f"{base}.geojson" if geojson is not None else None
    else:
        image_url_per_hour = data_url_per_hour = geojson_url_per_hour = None

    meta = {
        "name": spec.name,
        "title": spec.title,
        "units": spec.units,
        "vmin": spec.vmin,
        "vmax": spec.vmax,
        "step": spec.step,
        "cmap": spec.cmap,
        "valid_time": spec.valid_time,
        "description": spec.description,
        "render_style": spec.render_style,
        "category": spec.category,
        # Hourly-forecast fields are populated for layers carrying a
        # forecast_hour. Frontend uses them to wire the auto-time picker
        # and the optional scrubber UI.
        "init_cycle": spec.init_cycle,
        "forecast_hour": spec.forecast_hour,
        "image_url": (
            image_url_per_hour if is_hourly
            else f"https://storage.googleapis.com/{GCS_BUCKET}/"
                 f"{GCS_PREFIX}/{spec.name}/latest.png"
        ),
        # Vector GeoJSON sidecar for contour layers — crisper than the
        # raster PNG at any zoom because the browser redraws polylines
        # at display resolution. Filled layers don't get one because
        # filled-region polygons would balloon JSON size.
        "geojson_url": (
            geojson_url_per_hour if is_hourly
            else (f"https://storage.googleapis.com/{GCS_BUCKET}/"
                  f"{GCS_PREFIX}/{spec.name}/latest.geojson"
                  if geojson is not None else None)
        ),
        # Greyscale data PNG (8-bit R channel = (value - vmin)/(vmax-vmin)
        # * 255; alpha=0 means NaN). Frontend draws to offscreen canvas
        # and reads pixels on hover for instant value tooltips.
        "data_url": (
            data_url_per_hour if is_hourly
            else f"https://storage.googleapis.com/{GCS_BUCKET}/"
                 f"{GCS_PREFIX}/{spec.name}/latest_data.png"
        ),
        "data_grid": {"nx": data_nx, "ny": data_ny},
        # Hover decode bounds — may be wider than vmin/vmax (contour
        # range) so the tooltip can report values that exceed the
        # rendered contour band without clipping.
        "data_vmin": spec.data_vmin if spec.data_vmin is not None else spec.vmin,
        "data_vmax": spec.data_vmax if spec.data_vmax is not None else spec.vmax,
        # Visualization PNG is Mercator-warped (see _warp_eq_to_mercator)
        # so L.imageOverlay's linear stretch produces the correct
        # geographic position on a Web Mercator basemap. Bounds anchor
        # to the Mercator pole-cap latitude (±85.05°) — the same limit
        # Leaflet, GIBS tiles, and EPSG:3857 use.
        "bounds": [[-WEB_MERC_LAT_MAX, -180.0], [WEB_MERC_LAT_MAX, 180.0]],
        # Data PNG used for hover sampling is the RAW equirectangular
        # field at 0.25° (90→-90 lat top-to-bottom, -180→180 lon left
        # -to-right). Frontend samples with lat → row math; do NOT
        # apply the Mercator warp here.
        "data_bounds": [[-90.0, -180.0], [90.0, 180.0]],
        "grid": {"nx": NX, "ny": NY},
        "colorbar_stops": build_colormap_stops(spec.cmap),
        "levels": levels,
        "level_colors": level_colors,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
    }

    def _put(blob, body: bytes | str, content_type: str) -> None:
        blob.upload_from_string(body, content_type=content_type)
        blob.cache_control = "public, max-age=300"
        blob.patch()
        try:
            blob.make_public()
        except Exception as e:
            log.warning("Could not mark %s public: %s", blob.name, e)

    try:
        _put(png_blob, png, "image/png")
        _put(data_blob, data_png, "image/png")
        if geojson is not None:
            _put(geojson_blob, geojson, "application/geo+json")
        _put(meta_blob, json.dumps(meta, indent=2), "application/json")

        # Back-compat layer for hourly outputs: when this is the f000
        # analysis, also clobber env/{name}/latest.png + metadata.json
        # with the same content + legacy URL paths. Keeps the previously-
        # deployed frontend rendering correctly while the picker UI lands.
        if is_hourly and spec.forecast_hour == 0:
            legacy_meta = dict(meta)
            legacy_meta["image_url"] = (
                f"https://storage.googleapis.com/{GCS_BUCKET}/"
                f"{GCS_PREFIX}/{spec.name}/latest.png"
            )
            legacy_meta["data_url"] = (
                f"https://storage.googleapis.com/{GCS_BUCKET}/"
                f"{GCS_PREFIX}/{spec.name}/latest_data.png"
            )
            if geojson is not None:
                legacy_meta["geojson_url"] = (
                    f"https://storage.googleapis.com/{GCS_BUCKET}/"
                    f"{GCS_PREFIX}/{spec.name}/latest.geojson"
                )
            _put(latest_png_blob, png, "image/png")
            _put(latest_data_blob, data_png, "image/png")
            if geojson is not None:
                _put(latest_gj_blob, geojson, "application/geo+json")
            _put(latest_meta_blob, json.dumps(legacy_meta, indent=2),
                 "application/json")

        log.info("Uploaded %s%s: vis=%d bytes data=%d bytes%s",
                 spec.name,
                 f" (f{spec.forecast_hour:03d})" if is_hourly else "",
                 len(png), len(data_png),
                 f" geojson={len(geojson)} bytes" if geojson else "")
        return True
    except Exception as e:
        log.error("GCS upload failed for %s: %s", spec.name, e)
        return False


def write_layer_indices(date_str: str, hour_str: str,
                         forecast_hours: list, layer_names: list) -> None:
    """For each hourly-forecast layer, write env/{name}/index.json listing
    which (init_cycle, forecast_hour, valid_time) tuples are currently
    available. The API endpoint reads these to enumerate hours without
    scanning GCS prefixes — much faster than blob.list().

    Per-layer index shape:
      {
        "name": "shear_200_850",
        "latest_init": "20260517-12",
        "forecast_hours": [
          {"forecast_hour": 0, "valid_time": "2026-05-17T12:00:00Z",
           "image_url": "...png", "data_url": "..._data.png", ...},
          ...
        ]
      }
    """
    try:
        from google.cloud import storage
    except ImportError:
        log.warning("google-cloud-storage not installed; skipping index writes")
        return
    if not GCS_BUCKET:
        return

    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    init_cycle = f"{date_str}-{hour_str}"
    base_url = f"https://storage.googleapis.com/{GCS_BUCKET}"

    for name in layer_names:
        hours_meta = []
        for fh in forecast_hours:
            valid = compute_valid_time(date_str, hour_str, fh)
            hh = f"{fh:03d}"
            per_hour_dir = f"{GCS_PREFIX}/{name}/init-{init_cycle}"
            entry = {
                "forecast_hour": fh,
                "valid_time": valid,
                "image_url": f"{base_url}/{per_hour_dir}/f{hh}.png",
                "metadata_url": f"{base_url}/{per_hour_dir}/f{hh}.json",
            }
            # Wind layers carry their values IN the visualization PNG (RG-packed
            # u/v) and never emit a data sidecar or contours — advertising those
            # URLs would point the frontend at 404s.
            if not name.startswith("winds_"):
                entry["data_url"] = f"{base_url}/{per_hour_dir}/f{hh}_data.png"
                entry["geojson_url"] = f"{base_url}/{per_hour_dir}/f{hh}.geojson"
            hours_meta.append(entry)

        index = {
            "name": name,
            "latest_init": init_cycle,
            "forecast_hours": hours_meta,
        }
        blob = bucket.blob(f"{GCS_PREFIX}/{name}/index.json")
        blob.cache_control = "public, max-age=300"
        blob.upload_from_string(json.dumps(index, indent=2),
                                content_type="application/json")
        try:
            blob.make_public()
        except Exception:
            pass
        log.info("Wrote index for %s (%d hours)", name, len(hours_meta))


# --------------------------------------------------------------------------
# Per-field builders
# --------------------------------------------------------------------------

def compute_valid_time(date_str: str, hour_str: str, forecast_hour: int) -> str:
    """ISO8601 valid time for a GFS (cycle, forecast_hour) pair.

    cycle_dt + forecast_hour hours → "YYYY-MM-DDTHH:00:00Z". Used by every
    GFS-driven builder to populate spec.valid_time so the per-hour
    metadata.json carries the right timestamp for the frontend's auto-time
    picker.
    """
    cycle_dt = datetime.strptime(
        f"{date_str}{hour_str}", "%Y%m%d%H"
    ).replace(tzinfo=timezone.utc)
    valid_dt = cycle_dt + timedelta(hours=forecast_hour)
    return valid_dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def regrid_to_global(field: np.ndarray) -> np.ndarray:
    """Ensure the field is on the canonical 1440x721 north-to-south
    -180..180 grid. GFS native is already 1440x721 N→S and 0..360 lon —
    just roll lon to -180..180.
    """
    if field.shape == (NY, NX):
        # Lon convention: GFS is 0..360. Detect by checking column 0 vs
        # column NX/2 — if column 0 is the prime meridian we need to roll.
        # GFS at f000 has data starting at lon=0, so roll by NX/2.
        return np.roll(field, NX // 2, axis=1)
    if field.shape == (720, 1440):
        # Some sources are 720 lat (no pole row). Pad to 721 by repeating
        # the polar row.
        padded = np.empty((NY, NX), dtype=field.dtype)
        padded[0] = field[0]
        padded[1:] = field
        return np.roll(padded, NX // 2, axis=1)
    log.warning("Unexpected GFS grid shape %s; using as-is", field.shape)
    return field


def _compute_smoothed_shear_kt(date_str: str, hour_str: str,
                              forecast_hour: int,
                              bundle: Optional[dict]) -> Optional[np.ndarray]:
    """Shared shear computation extracted so build_shear and
    build_shear_anomaly can reuse one result per (cycle, fh) without
    paying the disc_smooth cost twice. Returns the canonical-global
    (NY×NX) shear field in kt, or None on failure.

    Result is cached on the bundle under sentinel key ("__shear_kt", 0)
    so the second call within the same forecast hour reads from memory.
    """
    if bundle is not None:
        cached = bundle.get(("__shear_kt", 0))
        if cached is not None:
            return cached
    fields = _load_fields(date_str, hour_str, forecast_hour,
                          [("UGRD", 200), ("UGRD", 850),
                           ("VGRD", 200), ("VGRD", 850)],
                          bundle=bundle)
    if fields is None:
        return None
    u200 = fields[("UGRD", 200)]; u850 = fields[("UGRD", 850)]
    v200 = fields[("VGRD", 200)]; v850 = fields[("VGRD", 850)]
    # Disc-smooth u/v at each level over a 400 km radius before
    # differencing so the TC vortex (and other sub-500-km features)
    # doesn't contaminate the "environmental shear" diagnostic. Smooths
    # in 0..360 longitude convention first to avoid edge effects at the
    # 0/360 seam — regrid to -180..180 only after the convolution.
    u200_s = disc_smooth(u200, 400.0)
    v200_s = disc_smooth(v200, 400.0)
    u850_s = disc_smooth(u850, 400.0)
    v850_s = disc_smooth(v850, 400.0)
    du = u200_s - u850_s
    dv = v200_s - v850_s
    # m/s → knots: 1 m/s = 1.94384 kt
    shear_kt = np.sqrt(du * du + dv * dv) * 1.94384
    shear_kt = regrid_to_global(shear_kt)
    if bundle is not None:
        bundle[("__shear_kt", 0)] = shear_kt
    return shear_kt


def build_shear(date_str: str, hour_str: str, *, forecast_hour: int = 0,
                bundle: Optional[dict] = None) -> Optional[bytes]:
    """200-850 hPa wind shear magnitude (knots)."""
    log.info("Building shear: GFS %s %sZ", date_str, hour_str)
    shear_kt = _compute_smoothed_shear_kt(date_str, hour_str,
                                          forecast_hour, bundle)
    if shear_kt is None:
        log.error("Shear: field load failed")
        return None

    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    spec = LayerSpec(
        name="shear_200_850",
        title="200-850 hPa Wind Shear",
        units="kt",
        vmin=0,
        vmax=60,
        step=10,
        cmap="turbo",
        valid_time=valid,
        # Hourly forecast plumbing — set on every GFS-driven layer so
        # upload_layer routes to env/{name}/init-{cycle}/f{HH}.png and
        # the metadata.json carries enough info for the frontend's
        # auto-time picker. Non-GFS layers (SST, genesis_prob,
        # subseasonal) leave both at None and fall back to latest.png.
        forecast_hour=forecast_hour,
        init_cycle=f"{date_str}-{hour_str}",
        data_vmax=150,  # let hover report jet-stream shear past the 60-kt contour cap
        description=(
            "Magnitude of the 200-850 hPa vector wind difference from "
            "the latest GFS 0.25° analysis, after a 400 km disc area-"
            "average of u/v at each level (suppresses TC vortices so the "
            "shear represents the environment a storm would experience)."
        ),
    )
    # Side-effect: capture per-region shear means and append to the
    # tc-atlas-ir-cache/seasonal/shear_mtd_current_year.parquet that
    # Panel B's Atmosphere mode reads. See append_gfs_shear_regions().
    try:
        append_gfs_shear_regions(date_str, hour_str, forecast_hour, shear_kt)
    except Exception as e:
        log.warning("  region-mean shear append failed (non-fatal): %s", e)
    return shear_kt if upload_layer(spec, shear_kt) else None


# Cached ERA5 climatology grids — fetched lazily per calendar month
# and reused across cycles inside one job invocation. Keyed by month
# (1-12). Values are (121, 360) float32 arrays in kt, N→S, lon -180..179.
_SHEAR_CLIMO_KT_CACHE: dict = {}


def _load_shear_climo_kt(month: int) -> Optional[np.ndarray]:
    """Fetch the ERA5 1991-2020 climatology grid for `month` from
    gs://${GCS_IR_CACHE_BUCKET}/era5_climo/shear_{MM}.global.grid.json
    and return it in knots (matching build_shear's unit choice).
    Cached for the process lifetime — twelve months × a few KB each.
    """
    if month in _SHEAR_CLIMO_KT_CACHE:
        return _SHEAR_CLIMO_KT_CACHE[month]
    if not GCS_BUCKET:
        log.warning("Shear-anom: GCS_IR_CACHE_BUCKET not set")
        return None
    # google.cloud.storage is imported lazily inside each builder
    # (matches the pattern in upload_layer etc.) — there's no module-
    # level `import storage`, so we need to bring it in here too.
    try:
        from google.cloud import storage
    except ImportError:
        log.warning("Shear-anom: google-cloud-storage not installed")
        return None
    blob_path = f"era5_climo/shear_{month:02d}.global.grid.json"
    try:
        bucket = storage.Client().bucket(GCS_BUCKET)
        blob = bucket.blob(blob_path)
        if not blob.exists():
            log.warning("Shear-anom: climo grid missing at %s", blob_path)
            return None
        data = json.loads(blob.download_as_bytes())
    except Exception as e:
        log.warning("Shear-anom: climo fetch failed: %s", e)
        return None
    vals = np.array(data["values"], dtype=np.float32)
    if vals.shape != (121, 360):
        log.warning("Shear-anom: unexpected climo shape %s for %s",
                    vals.shape, blob_path)
        return None
    kt = vals * 1.94384  # m/s → kt
    _SHEAR_CLIMO_KT_CACHE[month] = kt
    return kt


def _climo_to_gfs_grid(climo_kt: np.ndarray) -> np.ndarray:
    """Bilinearly interpolate the 121×360 ERA5 climo grid (lat 60..-60,
    lon -180..179, 1°) onto the canonical NY×NX GFS grid (lat 90..-90,
    lon -180..179.75, 0.25°). Returns NaN outside the ±60° climo
    coverage so the anomaly field also goes NaN there — keeps users
    from misreading 0-kt cells at the poles as "no anomaly".
    """
    from scipy.interpolate import RegularGridInterpolator
    src_lat = np.linspace(60.0, -60.0, 121, dtype=np.float64)
    src_lon = np.linspace(-180.0, 179.0, 360, dtype=np.float64)
    # Longitude is periodic, but the source stops at 179.0 while the target
    # runs to 179.75 — without a wrap column the last three GFS columns fell
    # outside the interpolator and came back NaN, leaving a ~1°-wide hole in
    # the anomaly field right at the dateline. Append lon 180.0 carrying the
    # -180.0 column so the seam interpolates like anywhere else.
    src_lon = np.append(src_lon, 180.0)
    climo_wrapped = np.concatenate([climo_kt, climo_kt[:, :1]], axis=1)
    # RegularGridInterpolator wants ascending coords — flip lat axis.
    interp = RegularGridInterpolator(
        (src_lat[::-1], src_lon),
        climo_wrapped[::-1, :],
        method="linear", bounds_error=False, fill_value=np.nan,
    )
    dst_lat = np.linspace(90.0, -90.0, NY, dtype=np.float64)
    dst_lon = np.linspace(-180.0, 179.75, NX, dtype=np.float64)
    lat_mesh, lon_mesh = np.meshgrid(dst_lat, dst_lon, indexing="ij")
    pts = np.stack([lat_mesh.ravel(), lon_mesh.ravel()], axis=-1)
    out = interp(pts).reshape(NY, NX).astype(np.float32)
    return out


def build_shear_anomaly(date_str: str, hour_str: str, *,
                       forecast_hour: int = 0,
                       bundle: Optional[dict] = None) -> Optional[bytes]:
    """Current GFS 200-850 hPa shear ANOMALY vs ERA5 1991-2020 climo.

    Feeds Panel A's Atmosphere mode so the atmospheric panel matches
    the SST panel's "current anomaly" framing — users see where shear
    is currently above/below normal for the calendar month, not the
    long-term mean. Anomaly = (current GFS-derived |V200-V850|) −
    (ERA5 1991-2020 monthly-mean |V200-V850|) at GFS 0.25° resolution.
    The climo is bilinearly upscaled to match.

    Sign convention: positive = above-normal shear (suppressive for
    TCs); negative = below-normal (favorable). Plotted with RdBu_r so
    red = bad, blue = good — matches forecaster intuition.
    """
    log.info("Building shear anomaly: GFS %s %sZ f%03d",
             date_str, hour_str, forecast_hour)
    shear_kt = _compute_smoothed_shear_kt(date_str, hour_str,
                                          forecast_hour, bundle)
    if shear_kt is None:
        log.error("Shear-anom: shear field unavailable")
        return None
    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    # Use the VALID time's calendar month for the climo — at month
    # boundaries f012 may roll into the next month, and the user wants
    # to compare against the climo for the forecast valid time.
    month = int(valid[5:7])
    climo_kt_src = _load_shear_climo_kt(month)
    if climo_kt_src is None:
        log.warning("Shear-anom: skipping (no climo for month %d)", month)
        return None
    climo_on_gfs = _climo_to_gfs_grid(climo_kt_src)
    anom_kt = shear_kt - climo_on_gfs
    spec = LayerSpec(
        name="shear_anom_200_850",
        title="200-850 hPa Shear Anomaly",
        units="kt",
        vmin=-30, vmax=30, step=5,
        cmap="RdBu_r",
        render_style="filled",
        valid_time=valid,
        forecast_hour=forecast_hour,
        init_cycle=f"{date_str}-{hour_str}",
        data_vmin=-80, data_vmax=80,
        description=(
            "Current GFS-derived 200-850 hPa shear minus the ERA5 "
            "1991-2020 climatological mean for the same calendar "
            "month, after a 400 km disc smooth of u/v at each level. "
            "Blue = below-normal shear (favorable for TCs); red = "
            "above-normal (suppressive)."
        ),
    )
    ok = upload_layer(spec, anom_kt)
    # Panel A consumes a FLAT equirectangular colored PNG + grid sidecar
    # (the env-overlay Mercator warp would distort the rectangular
    # display in the seasonal page). Write those alongside the standard
    # env-overlay artifacts so Panel A can find the latest cycle by
    # reading env/shear_anom_200_850/metadata.json (already written by
    # upload_layer) and then loading the equirect.png sibling.
    _upload_shear_anom_panel_a(anom_kt, spec, valid)
    return anom_kt if ok else None


def _render_panel_a_anom_png(anom_kt: np.ndarray) -> bytes:
    """Equirectangular shear-anomaly PNG with cartopy coastlines.
    Matches build_era5_climo_pngs.render_shear_climo_png's geographic
    treatment so Panel A's two atmosphere views (climo + current
    anomaly) share the same look. Diverging RdBu_r centered at 0 kt
    so blue = below-normal (favorable for TCs), red = above-normal.

    Coverage: ±60° lat × 100..360°E lon, Pacific-centered. This
    matches the OISST and ERA5 climo PNGs that Panel A's basin-zoom
    presets (ANOM_ZOOMS in realtime_seasonal.js) are calibrated for:
        atlantic → x_frac 0.65, w 0.35 → lon 269..360 (NAtl basin)
        epac     → x_frac 0.42, w 0.36 → lon 209..302
        wpac     → x_frac 0.04, w 0.34 → lon 109..197
    Without the Pacific-centered roll, x_frac 0.65 of a -180..180
    image lands on lon 54°E (Asia) — that's the bug this addresses.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import Normalize
    import cartopy.crs as ccrs
    import cartopy.feature as cfeature

    # Build the ±60° slice from the GFS native 721×1440 grid (lat
    # 90..-90 N→S at 0.25°). ±60° = rows 120..600 inclusive (481
    # rows). Same lon coverage as the full grid (-180..180-ε).
    lat_full = np.linspace(90.0, -90.0, NY, dtype=np.float32)
    mask = (lat_full <= 60.0) & (lat_full >= -60.0)
    sub = anom_kt[mask, :]
    # Roll lon axis so column 0 → lon 100°E. GFS native lon convention
    # is -180..180-ε at 0.25° (1440 cols). To put lon 100 at col 0,
    # we shift left by (100 - (-180)) / 0.25 = 1120 columns; or
    # equivalently the right side wraps. np.roll with -1120 == +320.
    shift_cols = int(280.0 / 0.25)  # 1120 columns
    sub = np.roll(sub, -shift_cols, axis=1)
    # After the roll: col 0 → lon 100°E, col 1439 → lon 459.75°E.

    fig = plt.figure(figsize=(8.0, 8.0 * 120 / 260), dpi=200)
    ax = fig.add_subplot(1, 1, 1,
                         projection=ccrs.PlateCarree(central_longitude=180))
    # Visible window is 100..360°E (260° wide), matching the other
    # Panel-A PNGs.
    ax.set_extent([100.0, 360.0, -60.0, 60.0], crs=ccrs.PlateCarree())
    norm = Normalize(vmin=-30.0, vmax=30.0, clip=True)
    # imshow extent spans the FULL 360° of rolled data (100..460) so
    # the 1440 cells cover the whole globe; set_extent above crops to
    # the visible 100..360 window.
    ax.imshow(
        sub,
        cmap="RdBu_r", norm=norm,
        extent=[100.0, 460.0, -60.0, 60.0],
        origin="upper", interpolation="bilinear",
        transform=ccrs.PlateCarree(),
        zorder=1,
    )
    # Same continent + coastline + borders treatment as the climo
    # PNG so the two Atmosphere views read consistently.
    ax.add_feature(cfeature.LAND, facecolor="#9ca3af", alpha=0.18,
                   zorder=2)
    ax.add_feature(cfeature.COASTLINE, linewidth=0.8, edgecolor="#0f172a",
                   zorder=3)
    ax.add_feature(cfeature.BORDERS, linewidth=0.3, edgecolor="#475569",
                   linestyle=":", zorder=3)
    ax.set_axis_off()
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, pad_inches=0,
                bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


def _upload_shear_anom_panel_a(anom_kt: np.ndarray, spec: LayerSpec,
                              valid_time: str) -> None:
    """Render the equirectangular colored PNG + grid JSON Panel A needs
    (Seasonal tab > Live anomaly > Atmosphere mode). Writes alongside
    the env-overlay artifacts at env/shear_anom_200_850/. Failures are
    logged and swallowed — the primary env-overlay upload still ships.

    The equirectangular PNG mirrors the era5_climo PNGs the panel was
    already shaped to consume; the grid JSON shares the same schema as
    era5_climo/shear_MM.global.grid.json so the existing hover wiring
    in realtime_seasonal.js needs only a URL swap.
    """
    if not GCS_BUCKET:
        return
    try:
        # Cartopy-based render so the anomaly pattern sits over visible
        # coastlines + light land tint — matches the climo Panel-A view.
        png_bytes = _render_panel_a_anom_png(anom_kt)
    except Exception as e:
        log.warning("Panel-A equirect PNG render failed: %s", e)
        return
    # Downsample 721×1440 → 121×360 (1° lat × 1° lon, matching the
    # existing era5_climo grid JSON schema the frontend hover code
    # already supports). Block-average to preserve magnitudes through
    # the decimation; NaN values propagate as NaN.
    try:
        lat_full = np.linspace(90.0, -90.0, NY, dtype=np.float32)
        # Slice to ±60° (climo coverage) — every 6th row gives 1°.
        mask = (lat_full <= 60.0) & (lat_full >= -60.0)
        rows = np.where(mask)[0]
        # We have 481 rows in ±60° at 0.25°; decimate 4× to 1°.
        deci = anom_kt[rows[::4], ::4]  # ~121 × 360, lon -180..179
        if deci.shape[0] != 121 or deci.shape[1] != 360:
            log.warning("Panel-A: unexpected decimate shape %s", deci.shape)
            return
        # Roll to Pacific-centered (lon 100..360, with the dateline-
        # crossing tail covering 0..99 ≡ 360..459) so the grid axes
        # line up with the PNG and with the other Panel-A grids
        # (build_era5_climo_pngs.render_grid_sidecar). Shift = 280 cols
        # at 1° → col 0 = lon 100, col 259 = lon 359, col 260+ wraps
        # back into 0..99. We crop to the visible 100..360 window so
        # the frontend hover handler — which assumes lon_min..lon_max
        # is a contiguous span — doesn't see the wrap.
        rolled = np.roll(deci, -280, axis=1)         # 121 × 360
        visible = rolled[:, : 261]                    # cols 0..260 → lon 100..360
        if visible.shape[1] != 261:
            log.warning("Panel-A: unexpected visible shape %s", visible.shape)
            return
        grid = {
            "lat_min": -60.0, "lat_max": 60.0,
            "lon_min": 100.0, "lon_max": 360.0,
            "cell_size_deg": 1.0,
            "n_lat": 121, "n_lon": 261,
            "lat_first": 60.0, "lat_last": -60.0,
            "lon_first": 100.0, "lon_last": 360.0,
            "units": "kt",
            "valid_time": valid_time,
            "kind": "shear_anom_200_850",
            # NaN → null so JSON.parse can roundtrip.
            "values": [
                [None if not np.isfinite(v) else round(float(v), 3)
                 for v in row]
                for row in visible
            ],
        }
        from google.cloud import storage
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)
        png_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/equirect.png")
        png_blob.upload_from_string(png_bytes, content_type="image/png")
        grid_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/equirect.grid.json")
        grid_blob.upload_from_string(json.dumps(grid),
                                     content_type="application/json")
        log.info("Panel-A equirect artifacts uploaded for %s", spec.name)
    except Exception as e:
        log.warning("Panel-A equirect upload failed: %s", e)


def append_gfs_shear_regions(date_str: str, hour_str: str,
                             forecast_hour: int, shear_global_kt: np.ndarray) -> None:
    """Feed Panel B (Seasonal · Atmosphere mode) and Panel A's
    trailing-30-day current-anomaly view. Pulls per-region cos(lat)-
    weighted shear means out of the freshly-computed global GFS field,
    converts to m/s (to match ERA5 conventions) and upserts one row per
    (date, cycle, fh) into the seasonal/shear daily store on GCS.

    The cron writes a per-day mean across all of that day's f000 cycles
    so the downstream MTD / trailing-30-day calculations stay simple
    (one value per region per day) while the underlying cycle/fh rows
    preserve provenance.
    """
    # Lazy imports — keep build_env_overlays.py importable without these
    # if a user runs a single layer locally.
    from build_oisst_history import REGIONS    # noqa: WPS433
    import pandas as pd                         # noqa: WPS433

    # shear_global_kt is on the regrid_to_global() grid: 1° global,
    # lats descending 90..-90 (181 rows), lons -180..179 (360 cols).
    lats = np.arange(90.0, -90.5, -1.0)
    cos_lat = np.cos(np.deg2rad(lats))
    shear_mps = shear_global_kt / 1.94384      # back to m/s

    row = {
        "date": date_str,
        "cycle": hour_str,
        "fh": int(forecast_hour),
    }
    for name, (lat_s, lat_n, lon_w, lon_e) in REGIONS.items():
        # REGIONS use 0..360 longitudes; the global grid is -180..180.
        lw = lon_w - 360.0 if lon_w > 180.0 else lon_w
        le = lon_e - 360.0 if lon_e > 180.0 else lon_e
        lat_mask = (lats >= lat_s) & (lats <= lat_n)
        lons = np.arange(-180.0, 180.0, 1.0)
        if lw <= le:
            lon_mask = (lons >= lw) & (lons <= le)
        else:
            lon_mask = (lons >= lw) | (lons <= le)
        sub = shear_mps[lat_mask][:, lon_mask]
        w = cos_lat[lat_mask][:, None] * np.ones_like(sub)
        finite = np.isfinite(sub)
        w = np.where(finite, w, 0.0)
        s = np.where(finite, sub, 0.0)
        den = float(w.sum())
        row[f"{name}_shear"] = round(float((s * w).sum() / den), 4) if den > 0 else None

    # Idempotent append into a small parquet on GCS — same bucket the
    # env-overlay layers already live in, under a /seasonal/ prefix.
    if not GCS_BUCKET:
        log.info("  GCS_IR_CACHE_BUCKET not set; skipping shear append")
        return
    blob_name = "seasonal/shear_mtd_current_year.parquet"
    from google.cloud import storage   # match the lazy-import pattern
    bucket = storage.Client().bucket(GCS_BUCKET)
    blob = bucket.blob(blob_name)
    if blob.exists():
        buf = io.BytesIO(blob.download_as_bytes())
        df = pd.read_parquet(buf)
    else:
        df = pd.DataFrame(columns=list(row.keys()))
    # Upsert by (date, cycle, fh) — re-runs of the cron overwrite.
    mask = ((df["date"] == row["date"])
            & (df["cycle"] == row["cycle"])
            & (df["fh"] == row["fh"]))
    if mask.any():
        df = df[~mask]
    df = pd.concat([df, pd.DataFrame([row])], ignore_index=True)
    df.sort_values(["date", "cycle", "fh"], inplace=True)
    df.reset_index(drop=True, inplace=True)
    out = io.BytesIO()
    df.to_parquet(out, compression="snappy", index=False)
    blob.cache_control = "no-cache, max-age=60"
    blob.upload_from_string(out.getvalue(), content_type="application/octet-stream")


def build_midlevel_shear(date_str: str, hour_str: str, *, forecast_hour: int = 0,
                         bundle: Optional[dict] = None) -> Optional[bytes]:
    """500-850 hPa wind shear magnitude (knots) — vortex-suppressed.

    Mid-level shear is more relevant than the deep-layer (200-850)
    metric for assessing the wind environment within the lower half
    of a TC vortex, where most of the convective organization happens.
    """
    log.info("Building mid-level shear: GFS %s %sZ", date_str, hour_str)
    fields = _load_fields(date_str, hour_str, forecast_hour,
                          [("UGRD", 500), ("UGRD", 850),
                           ("VGRD", 500), ("VGRD", 850)],
                          bundle=bundle)
    if fields is None:
        log.error("Mid-level shear: field load failed")
        return None
    u500 = fields[("UGRD", 500)]; u850 = fields[("UGRD", 850)]
    v500 = fields[("VGRD", 500)]; v850 = fields[("VGRD", 850)]

    u500_s = disc_smooth(u500, 500.0)
    v500_s = disc_smooth(v500, 500.0)
    u850_s = disc_smooth(u850, 500.0)
    v850_s = disc_smooth(v850, 500.0)
    du = u500_s - u850_s
    dv = v500_s - v850_s
    shear_kt = np.sqrt(du * du + dv * dv) * 1.94384
    shear_kt = regrid_to_global(shear_kt)

    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    spec = LayerSpec(
        name="shear_500_850",
        title="500-850 hPa Wind Shear",
        units="kt",
        vmin=0,
        vmax=40,
        step=5,
        cmap="turbo",
        valid_time=valid,
        # Hourly forecast plumbing — set on every GFS-driven layer so
        # upload_layer routes to env/{name}/init-{cycle}/f{HH}.png and
        # the metadata.json carries enough info for the frontend's
        # auto-time picker. Non-GFS layers (SST, genesis_prob,
        # subseasonal) leave both at None and fall back to latest.png.
        forecast_hour=forecast_hour,
        init_cycle=f"{date_str}-{hour_str}",
        data_vmax=120,
        description=(
            "Magnitude of the 500-850 hPa vector wind difference from "
            "the latest GFS 0.25° analysis, after a 400 km disc area-"
            "average of u/v at each level. Targets the lower half of the "
            "TC vortex where convective organization lives — useful "
            "alongside the deep-layer 200-850 metric."
        ),
    )
    return shear_kt if upload_layer(spec, shear_kt) else None


# --------------------------------------------------------------------------
# Wind component layers (u, v packed into RG channels of an 8-bit PNG)
# --------------------------------------------------------------------------
# Frontend renders wind barbs by loading these PNGs into an offscreen
# canvas, sampling u/v at zoom-appropriate grid spacing, and drawing
# standard met-conv barbs (flag/long bar/half bar) on a Leaflet
# overlay canvas.

_WIND_VMIN = -60.0  # m/s (~120 kt — wider than realistic peak so 200 hPa jets fit)
_WIND_VMAX = 60.0


def render_uv_png(u: np.ndarray, v: np.ndarray) -> bytes:
    """Pack a (u, v) vector field into an 8-bit RGBA PNG.

      R channel = (u - WIND_VMIN) / (WIND_VMAX - WIND_VMIN) * 255
      G channel = same for v
      B channel = 0 (unused)
      A channel = 255 for valid cells, 0 for NaN

    The frontend's wind-barb canvas layer loads this PNG and decodes
    each pixel's u,v on demand. Total bytes ~500-900 KB per level
    after PNG compression.
    """
    from PIL import Image
    u = np.asarray(u, dtype=np.float32)
    v = np.asarray(v, dtype=np.float32)
    valid = np.isfinite(u) & np.isfinite(v)
    span = _WIND_VMAX - _WIND_VMIN

    u_clip = np.clip(u, _WIND_VMIN, _WIND_VMAX)
    v_clip = np.clip(v, _WIND_VMIN, _WIND_VMAX)
    u_enc = ((u_clip - _WIND_VMIN) / span * 255.0).astype(np.uint8)
    v_enc = ((v_clip - _WIND_VMIN) / span * 255.0).astype(np.uint8)

    h, w = u.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., 0] = u_enc
    rgba[..., 1] = v_enc
    rgba[..., 2] = 0
    rgba[..., 3] = valid.astype(np.uint8) * 255

    img = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _upload_winds(name: str, title: str, valid_time: str, png: bytes,
                  level: Optional[int] = None,
                  description: Optional[str] = None,
                  init_cycle: Optional[str] = None,
                  forecast_hour: Optional[int] = None) -> bool:
    """Upload an RG-packed wind PNG + metadata.json sidecar.

    `title` is the user-facing label ("850 hPa Wind Barbs", "10 m Wind
    Barbs"). `level` is optional (kept on pressure-level layers for
    sort/filter; absent for 10-m surface winds).

    Path layout mirrors write_layer_spec: with an (init_cycle,
    forecast_hour) pair the PNG lands at env/{name}/init-{cycle}/f{HHH}.png
    and f000 additionally clobbers the back-compat env/{name}/latest.png.
    Without them everything goes to latest.png — which, once the job started
    looping over f000..f012, meant every hour overwrote the previous one and
    "latest" ended up being the +12 h forecast."""
    try:
        from google.cloud import storage
    except ImportError:
        log.error("google-cloud-storage not installed; cannot upload winds")
        return False
    if not GCS_BUCKET:
        log.error("GCS_IR_CACHE_BUCKET not set; cannot upload winds")
        return False

    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    is_hourly = init_cycle is not None and forecast_hour is not None
    legacy_png_url = (
        f"https://storage.googleapis.com/{GCS_BUCKET}/"
        f"{GCS_PREFIX}/{name}/latest.png"
    )
    if is_hourly:
        hh_str = f"{forecast_hour:03d}"
        per_hour_dir = f"{GCS_PREFIX}/{name}/init-{init_cycle}"
        png_blob = bucket.blob(f"{per_hour_dir}/f{hh_str}.png")
        meta_blob = bucket.blob(f"{per_hour_dir}/f{hh_str}.json")
        image_url = (
            f"https://storage.googleapis.com/{GCS_BUCKET}/"
            f"{per_hour_dir}/f{hh_str}.png"
        )
        latest_png_blob = bucket.blob(f"{GCS_PREFIX}/{name}/latest.png")
        latest_meta_blob = bucket.blob(f"{GCS_PREFIX}/{name}/metadata.json")
    else:
        png_blob = bucket.blob(f"{GCS_PREFIX}/{name}/latest.png")
        meta_blob = bucket.blob(f"{GCS_PREFIX}/{name}/metadata.json")
        image_url = legacy_png_url

    meta = {
        "name": name,
        "title": title,
        "units": "kt",
        "category": "wind",
        "render_style": "wind_barb",
        "valid_time": valid_time,
        "init_cycle": init_cycle,
        "forecast_hour": forecast_hour,
        "image_url": image_url,
        "bounds": [[-90.0, -180.0], [90.0, 180.0]],
        "grid": {"nx": NX, "ny": NY},
        # Decoding parameters: u = u_min + (R/255)*(u_max - u_min)
        "u_min": _WIND_VMIN, "u_max": _WIND_VMAX,
        "v_min": _WIND_VMIN, "v_max": _WIND_VMAX,
        "wind_units_native": "m/s",
        "description": description or (
            f"u, v components ({title}) from the GFS 0.25° "
            f"{init_cycle or 'latest'} run, packed as RG channels of an 8-bit PNG "
            f"(±60 m/s range). Frontend decodes and draws standard "
            f"meteorological wind barbs."
        ),
        "generated_utc": datetime.now(timezone.utc).isoformat(),
    }
    if level is not None:
        meta["level"] = level

    def _put(blob, body, ct):
        blob.upload_from_string(body, content_type=ct)
        blob.cache_control = "public, max-age=300"
        blob.patch()
        try:
            blob.make_public()
        except Exception as e:
            log.warning("Could not mark %s public: %s", blob.name, e)

    try:
        _put(png_blob, png, "image/png")
        _put(meta_blob, json.dumps(meta, indent=2), "application/json")
        # Back-compat: the f000 analysis also lands at latest.png +
        # metadata.json, matching write_layer_spec's scheme. Forecast hours
        # must NOT touch those blobs — that was the bug that left latest.png
        # holding f012.
        if is_hourly and forecast_hour == 0:
            legacy_meta = dict(meta)
            legacy_meta["image_url"] = legacy_png_url
            _put(latest_png_blob, png, "image/png")
            _put(latest_meta_blob, json.dumps(legacy_meta, indent=2),
                 "application/json")
        log.info("Uploaded %s%s: png=%d bytes", name,
                 f" (f{forecast_hour:03d})" if is_hourly else "", len(png))
        return True
    except Exception as e:
        log.error("Wind upload failed for %s: %s", name, e)
        return False


def build_winds(date_str: str, hour_str: str, level: int, *, forecast_hour: int = 0,
                bundle: Optional[dict] = None) -> Optional[bytes]:
    """Fetch u, v at the given pressure level and upload as a packed
    wind-barb layer."""
    log.info("Building winds: GFS %s %sZ at %d hPa", date_str, hour_str, level)
    fields = _load_fields(date_str, hour_str, forecast_hour,
                          [("UGRD", level), ("VGRD", level)],
                          bundle=bundle)
    if fields is None:
        log.error("Winds: field load failed at %d hPa", level)
        return None
    u = fields[("UGRD", level)]
    v = fields[("VGRD", level)]

    # Light smoothing only — wind barbs should reflect the actual flow,
    # not a smeared synoptic mean. 100 km is tight enough to preserve
    # jet structures + outflow channels.
    u_s = disc_smooth(u, 100.0)
    v_s = disc_smooth(v, 100.0)
    u_s = regrid_to_global(u_s)
    v_s = regrid_to_global(v_s)

    png = render_uv_png(u_s, v_s)
    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    title = f"{level} hPa Wind Barbs"
    return png if _upload_winds(f"winds_{level}", title, valid, png, level=level,
                                init_cycle=f"{date_str}-{hour_str}",
                                forecast_hour=forecast_hour) else None


def build_winds_10m(date_str: str, hour_str: str, *, forecast_hour: int = 0,
                    bundle: Optional[dict] = None) -> Optional[bytes]:
    """Fetch u, v at 10 m above ground (the standard surface wind) and
    upload as a packed wind-barb layer.

    Pairs with MSLP to identify boundary-layer features: confluence
    bands, frontal wind shifts, low-level inflow into developing
    systems, and the surface circulation of TC vortices. cfgrib
    exposes the field at typeOfLevel='heightAboveGround', level=10.
    """
    log.info("Building 10-m winds: GFS %s %sZ", date_str, hour_str)
    fields = _load_fields(date_str, hour_str, forecast_hour,
                          [("UGRD", "10_m_above_ground"),
                           ("VGRD", "10_m_above_ground")],
                          bundle=bundle)
    if fields is None:
        log.error("10-m winds: field load failed")
        return None
    u = fields[("UGRD", "10_m_above_ground")]
    v = fields[("VGRD", "10_m_above_ground")]

    # Same light smoothing as the pressure-level wind builder so the
    # barb spacing/density reads consistently across all wind layers.
    u_s = disc_smooth(u, 100.0)
    v_s = disc_smooth(v, 100.0)
    u_s = regrid_to_global(u_s)
    v_s = regrid_to_global(v_s)

    png = render_uv_png(u_s, v_s)
    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    description = (
        f"10-m above-ground u, v from the GFS 0.25° {date_str} {hour_str}Z run "
        f"(f{forecast_hour:03d}), packed as RG channels of an 8-bit PNG "
        "(±60 m/s range). Pairs with MSLP to expose surface circulations, "
        "frontal wind shifts, and low-level inflow into developing systems."
    )
    return png if _upload_winds("winds_10m", "10 m Wind Barbs", valid, png,
                                description=description,
                                init_cycle=f"{date_str}-{hour_str}",
                                forecast_hour=forecast_hour) else None


def build_vorticity(date_str: str, hour_str: str, level: int, *, forecast_hour: int = 0,
                    bundle: Optional[dict] = None) -> Optional[bytes]:
    """Cyclonic-positive relative vorticity at the given pressure level
    (e.g. 850, 700, 500 hPa) in 10⁻⁵ s⁻¹.

    ζ = ∂v/∂x − ∂u/∂y computed by centered finite differences on the
    0.25° lat/lon grid, with dx = R·cos(φ)·Δλ honoring the spherical
    Earth so high-latitude grid spacing doesn't blow up the derivative.

    Sign-adjusted by hemisphere (×sign(latitude)) so positive values
    are cyclonic in both NH and SH — the TC-genesis-relevant signal.
    Anticyclonic cells are masked NaN so they don't crowd the contour
    set. u, v are 200 km disc-smoothed before differencing to suppress
    grid noise — vorticity is small-scale, so we use a tighter kernel
    than the 400 km shear smoothing.
    """
    log.info("Building vorticity: GFS %s %sZ at %d hPa",
             date_str, hour_str, level)
    fields = _load_fields(date_str, hour_str, forecast_hour,
                          [("UGRD", level), ("VGRD", level)],
                          bundle=bundle)
    if fields is None:
        log.error("Vorticity: field load failed at %d hPa", level)
        return None
    u = fields[("UGRD", level)]
    v = fields[("VGRD", level)]

    u_s = disc_smooth(u, 200.0)
    v_s = disc_smooth(v, 200.0)

    R_EARTH = 6.371e6
    DEG_TO_RAD = np.pi / 180.0
    dlat_m = 0.25 * DEG_TO_RAD * R_EARTH  # ≈ 27800 m
    ny, nx = u_s.shape
    lats = 90.0 - np.arange(ny) * 0.25
    cos_lat = np.maximum(np.cos(lats * DEG_TO_RAD), 1e-6)
    dx_m = dlat_m * cos_lat  # (ny,)

    # ∂v/∂x — periodic in longitude.
    dv_dx = (np.roll(v_s, -1, axis=1) - np.roll(v_s, 1, axis=1)) / (2 * dx_m[:, None])
    # ∂u/∂y — row index increases southward, so y-derivative needs a
    # sign flip relative to the row derivative. Leave pole rows at 0.
    du_dy = np.zeros_like(u_s)
    du_dy[1:-1, :] = -(u_s[2:, :] - u_s[:-2, :]) / (2 * dlat_m)

    vort = dv_dx - du_dy  # ζ in s⁻¹
    sign_lat = np.sign(lats)
    sign_lat[sign_lat == 0] = 1.0
    cyclonic = vort * sign_lat[:, None]
    cyclonic *= 1e5  # → 10⁻⁵ s⁻¹

    # Mask anticyclonic cells only — keep all positive values so the
    # contour algorithm has cells both above and below every level
    # (otherwise the lowest level can't be drawn because there's no
    # transition below it).
    cyclonic = np.where(cyclonic > 0.0, cyclonic, np.nan).astype(np.float32)
    cyclonic = regrid_to_global(cyclonic)

    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    spec = LayerSpec(
        name=f"vort_{level}",
        title=f"{level} hPa Cyclonic Vorticity",
        units="10⁻⁵ s⁻¹",
        vmin=0,
        vmax=25,
        step=5,
        cmap="Reds",
        # Non-uniform contour ramp: tight at low end where most
        # synoptic-scale cyclonic features live, coarser at the high
        # end where only TC-scale vortices reach.
        levels_override=[1, 2, 4, 6, 8, 10, 15, 20, 25],
        data_vmax=200,  # TC inner-core vortex can hit 200+ × 10⁻⁵ s⁻¹
        valid_time=valid,
        # Hourly forecast plumbing — set on every GFS-driven layer so
        # upload_layer routes to env/{name}/init-{cycle}/f{HH}.png and
        # the metadata.json carries enough info for the frontend's
        # auto-time picker. Non-GFS layers (SST, genesis_prob,
        # subseasonal) leave both at None and fall back to latest.png.
        forecast_hour=forecast_hour,
        init_cycle=f"{date_str}-{hour_str}",
        description=(
            f"Relative vorticity ζ at {level} hPa from the latest GFS "
            f"analysis, after a 200 km disc smooth of u, v. Multiplied "
            f"by sign(latitude) so positive = cyclonic globally; "
            f"anticyclonic cells are masked. Contour set [1, 2, 4, 6, "
            f"8, 10, 15, 20, 25] × 10⁻⁵ s⁻¹ — finer near synoptic "
            f"background, coarser at TC-vortex scales."
        ),
    )
    return cyclonic if upload_layer(spec, cyclonic) else None


def build_z500_heights(date_str: str, hour_str: str, *, forecast_hour: int = 0,
                       bundle: Optional[dict] = None) -> Optional[bytes]:
    """500 hPa geopotential height (decameters), contoured at 3 dam.

    The classic synoptic-overlay field — pairs naturally with low-level
    vorticity (shows where the upper-level support sits relative to the
    surface circulation) and with upper-level wind barbs (jet streaks +
    ridges). 3 dam intervals match NHC / SPC / WPC convention.

    Smoothed with a 200 km disc to suppress 0.25° grid noise without
    softening synoptic ridges/troughs (those have wavelengths well
    above 200 km). Cyclonic-color encoding via `viridis`: low heights
    (cool purple) = troughs / cold lows, high heights (warm yellow) =
    subtropical ridge.
    """
    log.info("Building Z500 heights: GFS %s %sZ", date_str, hour_str)
    fields = _load_fields(date_str, hour_str, forecast_hour,
                          [("HGT", 500)], bundle=bundle)
    if fields is None:
        log.error("Z500: field load failed")
        return None
    z_m = fields[("HGT", 500)]
    z_dam = (z_m / 10.0).astype(np.float32)  # m → dam
    z_s = disc_smooth(z_dam, 200.0)
    z_s = regrid_to_global(z_s)

    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    spec = LayerSpec(
        name="z500_heights",
        title="500 hPa Geopotential Height",
        units="dam",
        vmin=480,
        vmax=600,
        step=3,
        cmap="viridis",
        # Explicit list so contour selection doesn't drift if vmin/vmax
        # ever change. 3 dam from 480 to 600 inclusive = 41 contours,
        # which globally covers polar lows (~480 dam) through the deep-
        # tropics subtropical ridge (~595 dam).
        levels_override=list(range(480, 603, 3)),
        valid_time=valid,
        # Hourly forecast plumbing — set on every GFS-driven layer so
        # upload_layer routes to env/{name}/init-{cycle}/f{HH}.png and
        # the metadata.json carries enough info for the frontend's
        # auto-time picker. Non-GFS layers (SST, genesis_prob,
        # subseasonal) leave both at None and fall back to latest.png.
        forecast_hour=forecast_hour,
        init_cycle=f"{date_str}-{hour_str}",
        description=(
            "500 hPa geopotential height from the latest GFS 0.25° "
            "analysis (m → dam), 200 km disc-smoothed. Contoured every "
            "3 dam — pairs naturally with low-level vorticity + upper-"
            "level wind barbs to show ridge/trough structure relative "
            "to the surface circulation."
        ),
    )
    return z_s if upload_layer(spec, z_s) else None


def build_divergence(date_str: str, hour_str: str, level: int, *, forecast_hour: int = 0,
                     bundle: Optional[dict] = None) -> Optional[bytes]:
    """Horizontal mass divergence at the given pressure level (e.g. 850,
    200 hPa) in 10⁻⁵ s⁻¹. Signed: negative = convergence, positive =
    divergence. Pairs naturally to tell the genesis-favorable story
    (850 mb convergence beneath 200 mb divergence).

    div(V) = ∂u/∂x + ∂v/∂y, centered finite differences on the 0.25°
    grid with dx = R·cos(φ)·Δλ to honor the spherical Earth so high-
    latitude grid spacing doesn't blow up the derivative. u, v are
    200 km disc-smoothed before differencing — divergence is small-
    scale, same kernel as vorticity. No hemispheric sign flip (unlike
    vorticity): divergence has the same physical sign in both
    hemispheres.

    Rendered with a diverging RdBu_r colormap: blue = convergence,
    red = divergence.
    """
    log.info("Building divergence: GFS %s %sZ at %d hPa",
             date_str, hour_str, level)
    fields = _load_fields(date_str, hour_str, forecast_hour,
                          [("UGRD", level), ("VGRD", level)],
                          bundle=bundle)
    if fields is None:
        log.error("Divergence: field load failed at %d hPa", level)
        return None
    u = fields[("UGRD", level)]
    v = fields[("VGRD", level)]

    u_s = disc_smooth(u, 200.0)
    v_s = disc_smooth(v, 200.0)

    R_EARTH = 6.371e6
    DEG_TO_RAD = np.pi / 180.0
    dlat_m = 0.25 * DEG_TO_RAD * R_EARTH  # ≈ 27800 m
    ny, nx = u_s.shape
    lats = 90.0 - np.arange(ny) * 0.25
    cos_lat = np.maximum(np.cos(lats * DEG_TO_RAD), 1e-6)
    dx_m = dlat_m * cos_lat  # (ny,)

    # ∂u/∂x — periodic in longitude.
    du_dx = (np.roll(u_s, -1, axis=1) - np.roll(u_s, 1, axis=1)) / (2 * dx_m[:, None])
    # ∂v/∂y — row index increases southward, so y-derivative needs a
    # sign flip relative to the row derivative. Leave pole rows at 0.
    dv_dy = np.zeros_like(v_s)
    dv_dy[1:-1, :] = -(v_s[2:, :] - v_s[:-2, :]) / (2 * dlat_m)

    div = (du_dx + dv_dy) * 1e5  # → 10⁻⁵ s⁻¹
    div = div.astype(np.float32)
    # Mask cells with |div| < 3 × 10⁻⁵ s⁻¹ so the filled-raster overlay
    # doesn't paint a broad pale wash over the IR map. The prior 1.0
    # threshold left near-noise values rendering as pale pinks/blues
    # that obscured the underlying satellite imagery; 3.0 keeps only
    # synoptic-scale signal (Hadley/Walker branch divergence, TC
    # outflow, frontal convergence). Hover tooltip still returns null
    # over masked cells.
    div = np.where(np.abs(div) >= 3.0, div, np.nan).astype(np.float32)
    div = regrid_to_global(div)

    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    spec = LayerSpec(
        name=f"div_{level}",
        title=f"{level} hPa Divergence",
        units="10⁻⁵ s⁻¹",
        vmin=-20,
        vmax=20,
        step=2,
        # Reversed RdBu so red = divergence (positive) and blue =
        # convergence (negative) — matches NWS/SPC convention.
        cmap="RdBu_r",
        # Tightly-spaced symmetric ramp: 1-unit steps near the noise
        # floor where most synoptic features live, 2-3 unit steps
        # through the mid-range, 5-unit steps past ±10 where only
        # TC-scale features reach. 16 boundaries → 15 visible bands,
        # right at the colorbar swatch limit. Paired with filled
        # discrete bands below for instant readability vs. thin
        # contour lines.
        # Drop the inner ±1 / ±2 bands — those values are below the new
        # ±3 noise mask anyway, and including them in levels left the
        # colorbar legend implying we still paint them. 11 boundaries
        # → 10 visible bands, all well above the synoptic noise floor.
        levels_override=[-20, -15, -10, -7, -5, -3,
                          3, 5, 7, 10, 15, 20],
        render_style="filled",
        discrete_bins=True,
        data_vmin=-100,
        data_vmax=100,
        valid_time=valid,
        # Hourly forecast plumbing — set on every GFS-driven layer so
        # upload_layer routes to env/{name}/init-{cycle}/f{HH}.png and
        # the metadata.json carries enough info for the frontend's
        # auto-time picker. Non-GFS layers (SST, genesis_prob,
        # subseasonal) leave both at None and fall back to latest.png.
        forecast_hour=forecast_hour,
        init_cycle=f"{date_str}-{hour_str}",
        description=(
            f"Horizontal mass divergence at {level} hPa from the latest "
            f"GFS 0.25° analysis, after a 200 km disc smooth of u, v. "
            f"Sign convention: blue (negative) = convergence, red "
            f"(positive) = divergence. For TC genesis, look for 850 hPa "
            f"convergence under 200 hPa divergence — the classic "
            f"vertically-coupled inflow/outflow couplet. Filled in "
            f"10 discrete bands from ±3 (noise floor — cells inside that "
            f"are transparent) up to ±20 × 10⁻⁵ s⁻¹."
        ),
    )
    return div if upload_layer(spec, div) else None


def build_mslp(date_str: str, hour_str: str, *, forecast_hour: int = 0,
               bundle: Optional[dict] = None) -> Optional[bytes]:
    """Mean Sea Level Pressure (hPa) — the classic synoptic field.

    Contours identify closed lows, ridges, troughs, and gradient
    strength at a glance. Lighter smoothing than the upper-level
    diagnostics because PRMSL is already a smooth field; we just want
    to suppress 0.25° grid noise that would create wavy contours.

    Rendered with a diverging RdBu colormap centered on the
    standard-atmosphere value (~1013 hPa): low pressure (cyclones)
    reads RED, high pressure (ridges) reads BLUE — matches the
    informal "warm colors = stormy, cool colors = quiet" intuition.
    """
    log.info("Building MSLP: GFS %s %sZ", date_str, hour_str)
    fields = _load_fields(date_str, hour_str, forecast_hour,
                          [("PRMSL", "mean_sea_level")], bundle=bundle)
    if fields is None:
        log.error("MSLP: field load failed")
        return None
    pa = fields[("PRMSL", "mean_sea_level")]
    hpa = (pa / 100.0).astype(np.float32)  # Pa → hPa
    hpa_s = disc_smooth(hpa, 100.0)         # light smooth for clean contours
    hpa_s = regrid_to_global(hpa_s)

    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    spec = LayerSpec(
        name="mslp",
        title="Mean Sea Level Pressure",
        units="hPa",
        vmin=976,
        vmax=1048,        # symmetric ±36 hPa around 1012 ≈ standard atmosphere
        step=4,
        cmap="RdBu",      # NOT reversed: low values (lows) get red, high get blue
        # Explicit ramp: 4 hPa NWS-standard intervals from 976 to 1048
        # = 19 isobars. >16 so colorbar legend falls back to gradient,
        # which is the right look for MSLP anyway (smooth synoptic
        # field, not categorical bands).
        levels_override=[976, 980, 984, 988, 992, 996, 1000, 1004,
                          1008, 1012, 1016, 1020, 1024, 1028, 1032,
                          1036, 1040, 1044, 1048],
        data_vmin=870,    # extreme TC inner-core min on record (~870 hPa)
        data_vmax=1085,   # extreme winter Siberian high (~1085 hPa)
        valid_time=valid,
        # Hourly forecast plumbing — set on every GFS-driven layer so
        # upload_layer routes to env/{name}/init-{cycle}/f{HH}.png and
        # the metadata.json carries enough info for the frontend's
        # auto-time picker. Non-GFS layers (SST, genesis_prob,
        # subseasonal) leave both at None and fall back to latest.png.
        forecast_hour=forecast_hour,
        init_cycle=f"{date_str}-{hour_str}",
        description=(
            "Mean Sea Level Pressure from the latest GFS 0.25° analysis "
            "(Pa → hPa), 100 km disc-smoothed for clean contouring. "
            "Contoured every 4 hPa — the NWS surface-analysis standard. "
            "Diverging color scheme centered on the standard atmosphere "
            "(~1013 hPa): RED = low pressure (cyclones), BLUE = high "
            "pressure (subtropical ridge / cold-core surface highs)."
        ),
    )
    return hpa_s if upload_layer(spec, hpa_s) else None


def build_midlevel_rh(date_str: str, hour_str: str, *, forecast_hour: int = 0,
                      bundle: Optional[dict] = None) -> Optional[bytes]:
    """700-400 hPa layer-averaged relative humidity (%)."""
    log.info("Building mid-level RH: GFS %s %sZ", date_str, hour_str)
    fields = _load_fields(date_str, hour_str, forecast_hour,
                          [("RH", 700), ("RH", 500), ("RH", 400)],
                          bundle=bundle)
    if fields is None:
        log.error("RH: field load failed")
        return None
    rh700 = fields[("RH", 700)]
    rh500 = fields[("RH", 500)]
    rh400 = fields[("RH", 400)]

    # Simple unweighted mean is fine for a first pass; layer-thickness
    # weighting changes the answer by <1 % in most regimes.
    rh = (rh700 + rh500 + rh400) / 3.0
    rh = regrid_to_global(rh)
    rh = np.clip(rh, 0, 100)

    valid = compute_valid_time(date_str, hour_str, forecast_hour)
    spec = LayerSpec(
        name="rh_700_400",
        title="700-400 hPa Mean RH",
        units="%",
        vmin=20,
        vmax=90,
        step=10,
        cmap="BrBG",
        valid_time=valid,
        # Hourly forecast plumbing — set on every GFS-driven layer so
        # upload_layer routes to env/{name}/init-{cycle}/f{HH}.png and
        # the metadata.json carries enough info for the frontend's
        # auto-time picker. Non-GFS layers (SST, genesis_prob,
        # subseasonal) leave both at None and fall back to latest.png.
        forecast_hour=forecast_hour,
        init_cycle=f"{date_str}-{hour_str}",
        description=(
            "Unweighted mean of relative humidity at 700, 500, and "
            "400 hPa — a proxy for mid-level moisture relevant to TC "
            "genesis. Rendered as a shaded gradient because contour "
            "lines tend to tangle on a noisy small-scale scalar."
        ),
        render_style="filled",
    )
    return rh if upload_layer(spec, rh) else None


def build_sst(prefetched: "Optional[tuple]" = None) -> Optional[bytes]:
    """NOAA OISST v2.1 daily SST (degC). `prefetched` lets main() share a single
    OISST fetch with build_sst_anomalies (avoids two slow NCEI round-trips)."""
    log.info("Building SST: NOAA OISST")
    result = prefetched if prefetched else fetch_oisst_sst()
    if not result:
        log.error("SST: OISST fetch failed")
        return None
    sst, ymd = result

    if sst.shape != (NY, NX):
        # OISST native is 720x1440; pad to 721x1440 for consistency.
        if sst.shape == (720, NX):
            padded = np.empty((NY, NX), dtype=sst.dtype)
            padded[0] = sst[0]
            padded[1:] = sst
            sst = padded
        else:
            log.warning("OISST unexpected shape %s; rendering as-is", sst.shape)

    valid = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}T00:00:00Z"
    spec = LayerSpec(
        name="sst_oisst",
        title="Sea-Surface Temperature",
        units="degC",
        vmin=18,
        vmax=32,
        step=2,
        cmap="RdYlBu_r",
        valid_time=valid,
        # OISST is observation-only daily — no GFS init cycle, no
        # forecast hour. LayerSpec defaults (forecast_hour=None,
        # init_cycle=None) route the upload through the legacy
        # latest.png single-PNG path. The pre-edit version of this
        # spec referenced `forecast_hour` and `f"{date_str}-{hour_str}"`
        # which aren't in scope inside build_sst() — every cycle's
        # sst_oisst builder was crashing with NameError.
        description=(
            "NOAA OISST v2.1 daily sea-surface temperature analysis "
            "(0.25° resolution, optimum interpolation of AVHRR + in-situ). "
            "Contours every 2 degC over the TC-relevant 18-32 degC range."
        ),
    )
    return sst if upload_layer(spec, sst) else None


# Tropical band for the Vecchi-Soden relative anomaly (matches the seasonal
# Panel A "relative SST": area-weighted mean anomaly over 30S-30N).
_REL_TROP_LAT = 30.0


def _load_oisst_monclim_env() -> Optional[np.ndarray]:
    """1991-2020 monthly OISST climatology, reoriented to the env grid
    (12, NY, NX) — N->S, lon -180..180, padded to NY — so it aligns pixel-for-
    pixel with fetch_oisst_sst(). Cached in /tmp between runs. Returns None if
    unavailable (built by build_oisst_history.py → gs://.../seasonal/)."""
    local = os.path.join(tempfile.gettempdir(), "oisst_monclim_1991_2020.nc")
    if not os.path.exists(local):
        try:
            from google.cloud import storage
            blob = storage.Client().bucket(GCS_BUCKET).blob(
                "seasonal/oisst_monclim_1991_2020.nc")
            if not blob.exists():
                log.warning("SST-anom: climatology blob missing in GCS seasonal/")
                return None
            blob.download_to_filename(local)
        except Exception as e:
            log.warning("SST-anom: climatology download failed: %s", e)
            return None
    try:
        import xarray as xr
        ds = xr.open_dataset(local)
        var = "sst" if "sst" in ds.data_vars else list(ds.data_vars)[0]
        clim = np.asarray(ds[var].values, dtype=np.float32)   # (month, lat, lon)
        lat0 = float(ds["lat"].values[0])
        ds.close()
    except Exception as e:
        log.warning("SST-anom: climatology decode failed: %s", e)
        return None
    if clim.ndim != 3 or clim.shape[0] != 12:
        log.warning("SST-anom: unexpected climatology shape %s", clim.shape)
        return None
    if lat0 < 0:                          # S->N : flip to N->S
        clim = clim[:, ::-1, :]
    clim = np.roll(clim, NX // 2, axis=2)  # lon 0..360 -> -180..180
    if clim.shape[1] == NY - 1:           # pad 720 -> 721 (match fetch_oisst_sst)
        pad = np.empty((12, NY, NX), dtype=clim.dtype)
        pad[:, 0, :] = clim[:, 0, :]
        pad[:, 1:, :] = clim
        clim = pad
    return clim


def _load_oisst_ltm_env(ymd: str) -> Optional[np.ndarray]:
    """1991-2020 OISST daily long-term-mean for the day-of-year of `ymd`, from
    PSL OPeNDAP — same global 720x1440 grid as fetch_oisst_sst(), reoriented
    N->S, lon -180..180, padded 720->721. Day-of-year clamped to 365 (the LTM
    has no Feb 29; the ~1-day shift is negligible for a climatology)."""
    import xarray as xr
    try:
        doy = datetime(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:8])).timetuple().tm_yday
    except Exception:
        return None
    doy = min(max(doy, 1), 365)
    try:
        # decode_times=False: we index by integer day-of-year, so skip the
        # cftime decode of the LTM's pre-reform reference time axis.
        ds = xr.open_dataset(OISST_PSL_LTM, engine="netcdf4", decode_times=False)
        clim = np.asarray(ds["sst"].isel(time=doy - 1).values, dtype=np.float32)
        lat0 = float(ds["lat"].values[0])
        ds.close()
    except Exception as e:
        log.warning("SST-anom: PSL LTM fetch failed: %s", e)
        return None
    if lat0 < 0:                          # S->N -> N->S
        clim = clim[::-1, :]
    clim = np.roll(clim, NX // 2, axis=1)  # 0..360 -> -180..180
    if clim.shape == (NY - 1, NX):        # pad 720 -> 721 (match the SST)
        padded = np.empty((NY, NX), dtype=clim.dtype)
        padded[0] = clim[0]; padded[1:] = clim
        clim = padded
    log.info("SST-anom: PSL LTM climatology doy=%d", doy)
    return clim


def build_sst_anomalies(prefetched: "Optional[tuple]" = None) -> bool:
    """OISST SST anomaly + relative anomaly vs the 1991-2020 climatology.

    Brings the seasonal Panel A framing to the global map: where is the ocean
    warmer/cooler than normal for the calendar month (anomaly), and — after
    removing the area-weighted tropical-mean warming — where is it warm
    RELATIVE to the tropics (Vecchi & Soden 2007), which tracks TC potential
    intensity better than absolute SST in a warming climate. Reuses the OISST
    fetch + climatology that already exist; no new data source. `prefetched`
    shares main()'s single OISST fetch with build_sst. Returns True if either
    layer uploaded."""
    log.info("Building SST anomalies: OISST vs 1991-2020 climatology")
    result = prefetched if prefetched else fetch_oisst_sst()
    if not result:
        log.error("SST-anom: OISST fetch failed")
        return False
    sst, ymd = result
    if sst.shape == (NY - 1, NX):          # pad 720 -> 721 like build_sst()
        padded = np.empty((NY, NX), dtype=sst.dtype)
        padded[0] = sst[0]; padded[1:] = sst
        sst = padded
    clim = _load_oisst_ltm_env(ymd)
    if clim is None:
        return False
    month = int(ymd[4:6])
    anom = sst - clim
    valid = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}T00:00:00Z"

    # Vecchi-Soden relative anomaly: subtract the cos-lat-weighted 30S-30N
    # mean anomaly so the global/tropical warming signal drops out.
    lats = 90.0 - np.arange(NY) * (180.0 / (NY - 1))   # +90 .. -90
    band = np.abs(lats) <= _REL_TROP_LAT
    w = np.cos(np.deg2rad(lats))[band][:, None]
    sub = anom[band, :]
    finite = np.isfinite(sub)
    num = float(np.nansum(np.where(finite, sub * w, 0.0)))
    den = float(np.nansum(np.where(finite, w * np.ones_like(sub), 0.0)))
    trop_mean = num / den if den > 0 else 0.0
    anom_rel = anom - trop_mean
    log.info("SST-anom: month=%02d tropical-mean anomaly = %+.3f degC",
             month, trop_mean)

    ok = False
    ok |= upload_layer(LayerSpec(
        name="sst_anom", title="SST Anomaly", units="degC",
        vmin=-3, vmax=3, step=1, cmap="RdBu_r", render_style="filled",
        valid_time=valid, data_vmin=-6, data_vmax=6,
        description=("OISST daily SST minus the 1991-2020 monthly climatology. "
                     "Red = warmer than normal, blue = cooler."),
    ), anom)
    ok = upload_layer(LayerSpec(
        name="sst_rel", title="Relative SST", units="degC",
        vmin=-2, vmax=2, step=1, cmap="RdBu_r", render_style="filled",
        valid_time=valid, data_vmin=-5, data_vmax=5,
        description=("SST anomaly minus the area-weighted 30S-30N mean anomaly "
                     "(Vecchi & Soden 2007). Warm RELATIVE to the tropics — the "
                     "TC potential-intensity signal with the warming trend removed."),
    ), anom_rel) or ok
    return ok


# --------------------------------------------------------------------------
# FNV3 LARGE_ENSEMBLE cyclogenesis probability — derived from the
# 1000-member ensemble track CSV (DeepMind also publishes pre-baked
# NetCDF probability fields but they uncompress to ~2 GB, which exceeds
# our Cloud Run Job memory budget. The CSV is 9 MB and the gridding is
# straightforward.)
# --------------------------------------------------------------------------

_LARGE_ENSEMBLE_BASE = (
    "https://deepmind.google.com/science/weatherlab/download/cyclones/"
    "FNV3_LARGE_ENSEMBLE"
)


def fetch_cyclogenesis_csv(date_str: str, hour_str: str) -> Optional[str]:
    """Pull the latest FNV3 LARGE_ENSEMBLE cyclogenesis CSV. Returns the
    raw text or None on failure. Walks back through recent init cycles
    if today's isn't published yet.
    """
    import requests
    date_fmt = date_str.replace("-", "_")
    url = (f"{_LARGE_ENSEMBLE_BASE}/ensemble/cyclogenesis/csv/"
           f"FNV3_LARGE_ENSEMBLE_{date_fmt}T{hour_str}_00_cyclogenesis.csv")
    try:
        r = requests.get(url, timeout=120)
        if r.status_code != 200:
            log.warning("Cyclogenesis CSV %s HTTP %d", url, r.status_code)
            return None
        if not r.text.startswith("#"):
            log.warning("Cyclogenesis CSV unexpected body for %s", url)
            return None
        return r.text
    except Exception as e:
        log.warning("Cyclogenesis CSV fetch failed: %s", e)
        return None


def _grid_track_probability(csv_text: str, lead_hours_max: float,
                            radius_km: float = 300.0
                            ) -> Optional[np.ndarray]:
    """Compute TC FORMATION probability on a 0.25° grid: the fraction of
    1000-member ensemble members predicting tropical-cyclogenesis within
    `radius_km` of each cell within lead_hours_max.

    Design (radius-integrated, NHC-TWO style):

    1. Genesis point only (not cumulative track positions). Keep just
       the earliest-lead point per (track, sample) pair so the heatmap
       represents formation, not exposure.

    2. Probability is per ENSEMBLE MEMBER. The CSV's `sample` column is
       the FNV3 LARGE_ENSEMBLE member ID (0-999); a single member can
       have multiple tracks. We count each member at most once per cell.

    3. Radius integration. Counting members whose genesis lands in the
       *exact* 0.25° cell (~28 km) underestimates the operational
       genesis-probability metric by an order of magnitude — even an
       active day with strong member agreement only reaches ~3-8%. NHC,
       ECMWF, and other operational genesis products integrate over
       ~300-400 km. Here we set radius_km=300 by default, so each cell
       reports the fraction of members with ANY genesis predicted within
       a 300 km disc around it. Active-cluster peaks now reach the 30-70%
       range users expect.

    Returns a (NY, NX) float array in [0, 100] on the canonical global
    grid + 0..360 lon convention (regridded to -180..180 by the caller).
    """
    # Step 1: earliest detected point per (track_id, sample) pair.
    earliest: dict[tuple, tuple[float, int, int]] = {}
    for line in csv_text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        if line.startswith("init_time"):
            continue
        cols = line.split(",")
        if len(cols) < 10:
            continue
        try:
            track_id = cols[1].strip()
            sample = cols[2].strip()
            lead_h = float(cols[5])
            if lead_h > lead_hours_max:
                continue
            lat = float(cols[6])
            lon = float(cols[7])
        except (ValueError, IndexError):
            continue
        if lon < 0:
            lon += 360.0
        iy = int(round((90.0 - lat) / 0.25))
        ix = int(round(lon / 0.25)) % NX
        if iy < 0 or iy >= NY:
            continue
        key = (track_id, sample)
        cur = earliest.get(key)
        if cur is None or lead_h < cur[0]:
            earliest[key] = (lead_h, iy, ix)

    if not earliest:
        return None

    # Step 2: per ensemble member (= sample), collect set of genesis cells.
    sample_cells: dict[str, set] = {}
    for (_track_id, sample), (_lead, iy, ix) in earliest.items():
        sample_cells.setdefault(sample, set()).add((iy, ix))

    # Step 3: pre-compute the disc offsets (relative cell offsets that
    # land within `radius_km` of a center cell). KM_PER_CELL ≈ 27.8 so
    # 300 km → ~11 cell radius → ~380-cell disc.
    R_cells = max(1, int(round(radius_km / KM_PER_CELL)))
    dy_grid, dx_grid = np.ogrid[-R_cells:R_cells + 1, -R_cells:R_cells + 1]
    disc_mask = (dy_grid * dy_grid + dx_grid * dx_grid) <= R_cells * R_cells
    disc_dy, disc_dx = np.where(disc_mask)
    disc_dy = disc_dy - R_cells   # shift back to relative offsets
    disc_dx = disc_dx - R_cells

    # Step 4: per member, build the union of "cells within R of any
    # genesis", then add 1 to each such cell in `counts`. Vectorized via
    # flat-indexed unique to keep the per-member work O(N_genesis × disc_area).
    counts = np.zeros((NY, NX), dtype=np.float32)
    for cells in sample_cells.values():
        all_jy: list = []
        all_jx: list = []
        for (iy, ix) in cells:
            all_jy.append(iy + disc_dy)
            all_jx.append(ix + disc_dx)
        if not all_jy:
            continue
        jy = np.concatenate(all_jy)
        jx = np.concatenate(all_jx)
        valid = (jy >= 0) & (jy < NY)
        jy = jy[valid]
        jx = jx[valid] % NX                    # lon wrap
        flat = np.unique(jy * NX + jx)          # dedupe per-member
        counts.flat[flat] += 1.0

    # Normalize to the 1000-member ensemble size (FNV3 LARGE_ENSEMBLE
    # documented size). Falls back to observed sample count if larger.
    N_MEMBERS = max(1000, len(sample_cells))
    prob = counts / N_MEMBERS

    # Gaussian smooth (σ≈110 km, 4 cells × 27.8 km/cell) so the chunked
    # bands flow as smooth curves instead of 0.25° cell stairsteps when
    # rendered with BoundaryNorm + bilinear-interpolated upsample. The
    # disc-integration above already gives most of the spatial averaging
    # but Gaussian fills in the inter-cell jaggedness that BoundaryNorm
    # would otherwise expose.
    try:
        from scipy.ndimage import gaussian_filter
        try:
            prob = gaussian_filter(prob, sigma=(4.0, 4.0),
                                   mode=("constant", "wrap"))
        except TypeError:
            prob = gaussian_filter(prob, sigma=4.0, mode="wrap")
    except Exception as e:
        log.warning("gaussian_filter unavailable, returning unsmoothed: %s", e)

    return prob * 100.0  # convert to %


def build_genesis_prob(csv_text: str, lead_days: int, valid_time: str
                       ) -> Optional[bytes]:
    """Build one FNV3 cyclogenesis probability env layer at the given
    lead horizon (days). Always uploads (even when no tracks fall in
    the lead window) so the layer is always available in the env menu —
    quiet days just render fully transparent.
    """
    log.info("Building genesis_prob_%dd", lead_days)
    field = _grid_track_probability(csv_text, lead_hours_max=lead_days * 24.0)
    if field is None:
        # No genesis events within this horizon — upload a fully-NaN
        # field so the layer still appears, just with no shading.
        log.info("genesis_prob_%dd: no tracks in window, uploading empty layer",
                 lead_days)
        field = np.full((NY, NX), np.nan, dtype=np.float32)
    else:
        # Mask very-low cells to NaN so the basemap shows through outside
        # the active genesis area. Threshold 2% (radius-integrated metric
        # has a much higher floor than the old cell-only metric).
        field = np.where(field > 2.0, field, np.nan).astype(np.float32)
        field = regrid_to_global(field)

    spec = LayerSpec(
        name=f"genesis_prob_{lead_days}d",
        title=f"TC Formation Probability — Next {lead_days} day{'s' if lead_days > 1 else ''}",
        units="%",
        vmin=0,
        vmax=60,
        step=10,
        cmap="YlOrRd",
        valid_time=valid_time,
        data_vmax=100,  # hover tooltip can report through to 100%
        # Bin edges for the discrete-band renderer + matching swatch
        # legend. Tighter spacing at the low end so the "is this 5%
        # or 15%?" question is easy to answer; coarser at the high
        # end where any band > 40% is operationally "very likely".
        levels_override=[2, 5, 10, 20, 30, 40, 50, 60],
        discrete_bins=True,
        description=(
            f"Fraction of FNV3 LARGE_ENSEMBLE 1000-member realizations "
            f"predicting tropical-cyclogenesis (earliest detected point) "
            f"within 300 km of this cell during the next {lead_days} days. "
            f"Radius-integrated, NHC-TWO style — counts each member at "
            f"most once per cell. Light σ≈55 km Gaussian smooth applied "
            f"for readability."
        ),
        render_style="filled",
        category="genesis",
    )
    return field if upload_layer(spec, field) else None


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def emit_cost_telemetry(duration_s: float, layer_count: int) -> None:
    """Emit a structured log line for monthly Cloud Run spend tracking.
    Aggregate via:
      gcloud logging read \\
          'resource.type=cloud_run_job AND textPayload:"cost_telemetry"' \\
          --freshness=30d --format='value(textPayload)' \\
          | awk -F'est_cost_usd=' '{print $2}' \\
          | awk '{s+=$1} END {printf "$%.2f\\n", s}'

    Pricing constants match Cloud Run Jobs tier-1 zones (2026-05).
    Reads provisioned CR_VCPU + CR_MEM_GIB from env vars set by the
    deploy script; defaults to 2 vCPU / 2 GiB (current env-job spec)."""
    PRICE_VCPU_PER_S  = 0.000024
    PRICE_MEM_PER_S   = 0.0000025
    vcpu = float(os.environ.get("CR_VCPU", "2"))
    mem_gib = float(os.environ.get("CR_MEM_GIB", "2"))
    cost = duration_s * (vcpu * PRICE_VCPU_PER_S + mem_gib * PRICE_MEM_PER_S)
    log.info(
        "cost_telemetry script=%s duration_s=%.1f vcpu=%s mem_gib=%s "
        "layers=%d est_cost_usd=%.5f",
        "build_env_overlays", duration_s, vcpu, mem_gib, layer_count, cost,
    )


def main() -> int:
    import time as _time
    _t0 = _time.time()
    date_str, hour_str = latest_gfs_cycle()
    log.info("Latest GFS cycle: %s %sZ", date_str, hour_str)

    # Pull the cyclogenesis CSV ONCE up front so the three probability
    # builders share the same payload + init cycle. Walk back if today's
    # CSV isn't published yet.
    genesis_csv = None
    genesis_init = None
    now_utc = datetime.now(timezone.utc)
    for off in (0, 1):
        d = (now_utc - timedelta(days=off)).strftime("%Y-%m-%d")
        for h in ("18", "12", "06", "00"):
            txt = fetch_cyclogenesis_csv(d, h)
            if txt:
                genesis_csv = txt
                genesis_init = f"{d}T{h}:00:00Z"
                log.info("Cyclogenesis CSV: using %s %sZ (%d bytes)",
                         d, h, len(txt))
                break
        if genesis_csv:
            break

    results: dict = {}

    # Forecast-hour window for GFS-driven layers. f000 = analysis,
    # f001..f012 = +1h..+12h forecasts of the same init cycle. Lets the
    # on-page valid_time align to the satellite frame instead of being
    # pinned to the (often-6h-stale) analysis. Configurable via env var
    # for testing.
    fh_max = int(os.environ.get("FORECAST_HOURS_MAX", "12"))
    forecast_hours = list(range(0, fh_max + 1))

    # GFS-driven builders — each invoked once per forecast hour, all
    # sharing the same init cycle. Stage 1B (this commit): per-hour
    # `bundle` pre-fetches every (var, level) the pipeline needs in ~7
    # NOMADS calls, replacing the ~27 redundant per-builder round-trips.
    # Each lambda forwards the shared `bundle` to the builder; if the
    # bundle pre-fetch failed for a key the builder transparently falls
    # back to its own fetch (`_load_fields` handles that).
    gfs_builders = [
        ("shear_200_850", lambda fh, b: build_shear(date_str, hour_str, forecast_hour=fh, bundle=b)),
        # Runs right after shear_200_850 in the same forecast hour so
        # the cached smoothed-shear field on the bundle is reused (the
        # second _compute_smoothed_shear_kt call short-circuits via
        # bundle[("__shear_kt", 0)] — no double disc_smooth cost).
        ("shear_anom_200_850", lambda fh, b: build_shear_anomaly(date_str, hour_str, forecast_hour=fh, bundle=b)),
        ("shear_500_850", lambda fh, b: build_midlevel_shear(date_str, hour_str, forecast_hour=fh, bundle=b)),
        ("vort_850",      lambda fh, b: build_vorticity(date_str, hour_str, 850, forecast_hour=fh, bundle=b)),
        ("vort_700",      lambda fh, b: build_vorticity(date_str, hour_str, 700, forecast_hour=fh, bundle=b)),
        ("vort_500",      lambda fh, b: build_vorticity(date_str, hour_str, 500, forecast_hour=fh, bundle=b)),
        ("div_850",       lambda fh, b: build_divergence(date_str, hour_str, 850, forecast_hour=fh, bundle=b)),
        ("div_200",       lambda fh, b: build_divergence(date_str, hour_str, 200, forecast_hour=fh, bundle=b)),
        ("mslp",          lambda fh, b: build_mslp(date_str, hour_str, forecast_hour=fh, bundle=b)),
        ("z500_heights",  lambda fh, b: build_z500_heights(date_str, hour_str, forecast_hour=fh, bundle=b)),
        ("winds_10m",     lambda fh, b: build_winds_10m(date_str, hour_str, forecast_hour=fh, bundle=b)),
        ("winds_850",     lambda fh, b: build_winds(date_str, hour_str, 850, forecast_hour=fh, bundle=b)),
        ("winds_700",     lambda fh, b: build_winds(date_str, hour_str, 700, forecast_hour=fh, bundle=b)),
        ("winds_500",     lambda fh, b: build_winds(date_str, hour_str, 500, forecast_hour=fh, bundle=b)),
        ("winds_200",     lambda fh, b: build_winds(date_str, hour_str, 200, forecast_hour=fh, bundle=b)),
        ("rh_700_400",    lambda fh, b: build_midlevel_rh(date_str, hour_str, forecast_hour=fh, bundle=b)),
    ]

    # Hour-major iteration with a shared bundle per hour: one NOMADS
    # fetch per (var, typeOfLevel) up front, then every builder for
    # that hour reads pre-decoded fields out of the bundle.
    for fh in forecast_hours:
        log.info("=" * 70)
        log.info("=== Forecast hour f%03d ===", fh)
        log.info("=" * 70)
        bundle = fetch_gfs_bundle(date_str, hour_str, forecast_hour=fh)
        for name, fn in gfs_builders:
            key = f"{name}.f{fh:03d}"
            try:
                results[key] = fn(fh, bundle) is not None
            except Exception:
                log.error("Builder %s crashed:\n%s",
                          key, traceback.format_exc())
                results[key] = False

    # SST runs once per scheduler invocation — OISST is observation-only daily,
    # no forecast hours. Fetch OISST ONCE and share it across the absolute-SST
    # and anomaly builders so a slow NCEI endpoint costs one walk-back, not two
    # (each can burn up to the 90s budget). All use the legacy single-PNG path.
    try:
        _oisst = fetch_oisst_sst()
    except Exception:
        log.error("OISST shared fetch crashed:\n%s", traceback.format_exc())
        _oisst = None

    # OISST is a daily product but this job runs every 6 h — 3 of 4 runs used
    # to re-render and re-upload byte-identical SST/anomaly PNGs. Skip the
    # renders when the fetched field is unchanged since the last upload. The
    # marker hashes the DATA (not just the date) so a preliminary→final file
    # swap for the same ymd still triggers a re-render.
    _oisst_unchanged = False
    if _oisst is not None:
        import hashlib
        _sst_arr, _sst_ymd = _oisst
        _marker = f"{_sst_ymd}:{hashlib.sha1(_sst_arr.tobytes()).hexdigest()[:12]}"
        _marker_path = "env/oisst_last_rendered.txt"
        try:
            from google.cloud import storage as _st
            _mb = _st.Client().bucket(GCS_BUCKET).blob(_marker_path)
            _oisst_unchanged = (_mb.download_as_text(timeout=15).strip() == _marker)
        except Exception:
            _oisst_unchanged = False   # missing/unreadable marker → render

    if _oisst_unchanged:
        log.info("OISST %s unchanged since last render — skipping SST builders", _sst_ymd)
        results["sst_oisst"] = True
        results["sst_anomalies"] = True
    else:
        try:
            results["sst_oisst"] = build_sst(_oisst) is not None
        except Exception:
            log.error("Builder sst_oisst crashed:\n%s", traceback.format_exc())
            results["sst_oisst"] = False

        # SST anomaly + relative-SST (vs 1991-2020 climo) — same OISST fetch +
        # the cached climatology; observation-only, single-PNG path like
        # sst_oisst.
        try:
            results["sst_anomalies"] = build_sst_anomalies(_oisst)
        except Exception:
            log.error("Builder sst_anomalies crashed:\n%s", traceback.format_exc())
            results["sst_anomalies"] = False
        if _oisst is not None and results.get("sst_oisst") and results.get("sst_anomalies"):
            try:
                _mb.upload_from_string(_marker, content_type="text/plain", timeout=15)
            except Exception:
                log.warning("OISST render marker write failed (will re-render next run)")

    # After all forecast hours uploaded, write a per-layer index.json
    # listing the available hours so the API can enumerate them without
    # scanning GCS on every request.
    try:
        write_layer_indices(date_str, hour_str, forecast_hours,
                            [b[0] for b in gfs_builders])
    except Exception:
        log.error("write_layer_indices failed:\n%s", traceback.format_exc())

    if genesis_csv:
        for days in (2, 7, 14):
            key = f"genesis_prob_{days}d"
            try:
                results[key] = build_genesis_prob(
                    genesis_csv, days, genesis_init
                ) is not None
            except Exception:
                log.error("Builder %s crashed:\n%s", key, traceback.format_exc())
                results[key] = False
    else:
        log.warning("Skipping genesis_prob_* layers: cyclogenesis CSV unavailable")

    log.info("Done. Results: %s", results)
    emit_cost_telemetry(_time.time() - _t0, layer_count=len(results))
    # Exit nonzero so Scheduler retries if every field failed, but we
    # don't want one OISST hiccup to mask an otherwise-good run.
    return 0 if any(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
