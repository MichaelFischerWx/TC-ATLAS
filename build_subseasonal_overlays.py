"""Build real-time subseasonal forcing overlays for the RT Monitor.

For each canonical convectively-coupled tropical wave type, renders a
global PNG of the *filtered* OLR anomaly (W/m²) at today's date:

    - "anomaly"  : raw daily OLR anomaly  (= today − climatology)
    - "mjo"      : MJO-band filtered      (k=1..5 east,  period 30–96 d)
    - "kelvin"   : Kelvin-wave filtered   (k=1..14 east, h=8–90 m, sym)
    - "er"       : Equatorial Rossby n=1  (k=−1..−10,    period 9–72 d, sym)
    - "mrg"      : Mixed Rossby–Gravity   (period 3–8 d, anti-symmetric)

Negative anomaly = enhanced convection (suppressed OLR). Diverging
colormap: green = enhanced convection (forced ascent), brown = suppressed.

Uses Wheeler & Kiladis (1999) space–time spectral filtering. Symmetric
and anti-symmetric components are decomposed about the equator before
FFT. The most recent timestep is what we render; earlier days remain
useful for animation if we add it later.

Data source: NOAA Interpolated OLR (PSL), 2.5° daily, 1979–present, via
OPeNDAP slice (avoids the 349 MB full download).

This script can run as a Cloud Run Job on a daily schedule, matching
the pattern of build_env_overlays.py — GCS upload code is parallel and
gated on $GCS_IR_CACHE_BUCKET being set.

Local invocation for validation:
    python build_subseasonal_overlays.py --local-only --out data/subseasonal_overlays

Outputs to:
    data/subseasonal_overlays/{name}.png
    data/subseasonal_overlays/{name}.json   (valid_time, vmin/vmax, cmap)
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import os
import sys
import tempfile

import requests  # daily index refresh (BOM RMM, APCC BSISO, NOAA ROMI)
from dataclasses import dataclass, field as dc_field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("build_subseasonal_overlays")


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

# Wheeler–Kiladis requires a long temporal window for adequate spectral
# resolution. We pull 200 days back from today; the latest ~30 days
# carries some end-of-window leakage which is acceptable for at-a-glance
# real-time monitoring (and standard in the WK community).
WINDOW_DAYS = 200

# Hovmöller (time × lon) diagnostics — written per WaveSpec for the
# Real-Time Monitor's Subseasonal tab. 60 days gives enough temporal
# context to see two MJO cycles or a half-dozen Kelvin transits without
# bloating page-load. Three lat bands cover the standard equatorial WK
# average (10°S-10°N), a tighter Kelvin-favored slice (5°S-5°N), and an
# off-equator slice that resolves MRG / TD-type signals better.
HOVMOLLER_LOOKBACK_DAYS = 60
HOVMOLLER_LAT_BANDS = [
    {"key": "trop10", "lat_min": -10.0, "lat_max": 10.0, "label": "10°S-10°N"},
    {"key": "eq5",    "lat_min":  -5.0, "lat_max":  5.0, "label":  "5°S-5°N"},
    {"key": "boreal", "lat_min":   5.0, "lat_max": 15.0, "label": "5°N-15°N"},
]

# Climatology reference period. Long enough to be stable, recent enough
# to reflect the current climate state. Matches what NOAA CPC uses for
# MJO/CCEW diagnostics.
# Default climatology window. Configurable via env vars so the validation
# pass can use a shorter range (5 yr → ~2 min OPeNDAP fetch) and prod can
# use the canonical 30-yr WMO baseline.
CLIMO_START = os.environ.get("OLR_CLIMO_START", "1991-01-01")
CLIMO_END   = os.environ.get("OLR_CLIMO_END",   "2020-12-31")

# Symmetric (Kelvin, ER, MJO) vs anti-symmetric (MRG/TD) latitudinal
# averaging window. ±15° is the canonical WK tropical band.
TROPIC_LAT = 15.0

# NOAA CPC Blended OLR via PSL THREDDS OPeNDAP. 2.5° daily, 1991-present,
# updated daily. (The older Liebmann/Smith interp_OLR product on PSL is
# frozen at end-2022; this CPC-blended one is the live successor.)
OPENDAP_URL = "https://psl.noaa.gov/thredds/dodsC/Datasets/cpc_blended_olr-2.5deg/olr.day.mean.nc"

# Output rendering. We keep the data grid at the native 2.5° resolution
# (144x73); Leaflet's image overlay scales it up smoothly with bilinear
# interpolation. Skipping the 2x render trick used in build_env_overlays
# keeps file sizes tiny for the daily delta.
NX = 144
NY = 73


# --------------------------------------------------------------------------
# Overlay specs
# --------------------------------------------------------------------------

@dataclass
class WaveSpec:
    name: str                # "anomaly" | "mjo" | "kelvin" | "er" | "mrg"
    title: str
    description: str
    # Symmetric (about equator) or anti-symmetric component. "anomaly"
    # uses the raw anomaly (no decomposition).
    component: str           # "sym" | "asym" | "raw"
    # Zonal wavenumber range. Positive = eastward, negative = westward.
    # None means use the union of east + west (for "anomaly" which we
    # don't band-filter).
    k_lo: Optional[int] = None
    k_hi: Optional[int] = None
    # Frequency range (cycles per day). Higher freq = shorter period.
    freq_lo: Optional[float] = None
    freq_hi: Optional[float] = None
    # Equivalent-depth gate (m). When set, masks the FFT to the
    # Wheeler-Kiladis Kelvin or n=1 ER dispersion curves between these
    # depths. Mutually exclusive with freq_lo/hi for that wave.
    h_lo: Optional[float] = None
    h_hi: Optional[float] = None
    # Visualization
    vmin: float = -40.0      # W/m² — typical OLR-anomaly range
    vmax: float = 40.0
    # CPC convention: GREEN = active convection (negative OLR anomaly,
    # cold cloud tops, forced ascent), BROWN = suppressed (positive
    # anomaly, dry/warm). Matplotlib's "BrBG_r" delivers this orientation:
    # low end green, high end brown. More intuitive than diverging red-blue,
    # which clashes with the temperature / vorticity palettes used in the
    # rest of the env-overlay stack.
    cmap: str = "BrBG_r"
    # Rendering mode. "filled" = diverging color shading (good for the
    # raw OLR anomaly, which spans 60+ W/m² with broad structure).
    # "contour" = symmetric pos/neg isolines on a transparent background
    # (right call for WK-filtered band products because their natural
    # amplitude is small, equatorially-trapped, and obscured under a
    # filled colormap). Per-band contour levels are listed below.
    render_style: str = "filled"
    # Contour levels in W/m². Symmetric pos/neg pairs (so -L, +L); the
    # renderer draws negative levels in green and positive in brown,
    # thickness scaling with magnitude. Used only when render_style ==
    # "contour".
    contour_levels: Optional[list] = None
    # Meridional projection onto the n-th parabolic cylinder function
    # (PCF). Pure (k, ω) WK filtering leaves the band amplitude defined
    # at every latitude, which yields physically meaningless extratropical
    # contours for equatorially-trapped wave modes. Projecting the
    # filtered field onto the canonical equatorial-wave meridional
    # eigenstructure (Matsuno 1966 / Yang, Hoskins & Slingo 2003) confines
    # the signal to its theoretical envelope. n=0 → D₀ = exp(-y²/2L²)
    # (Kelvin, ER symmetric); n=1 → D₁ = (y/L)·exp(-y²/2L²) (MRG, TD-type
    # antisymmetric, peaks off-equator at y=L). None → no projection.
    merid_pcf_n: Optional[int] = None
    # Equatorial trapping scale (degrees latitude). Yang, Hoskins & Slingo
    # (2003) fit L≈6° to wind fields, which gives a cleaner Matsuno
    # structure than is appropriate for OLR. The observed Kelvin/ER OLR
    # envelopes in Kiladis (2009 §3.2, Fig. 5) and Straub & Kiladis (2003)
    # are noticeably broader — convective coupling plus the h=8-90m
    # equivalent-depth spread broadens the meridional envelope vs the
    # single-mode theoretical decay. L=8° puts the outer ±2 W/m² contour
    # at ~±15° latitude (peak ~12 W/m²), matching the canonical observed
    # CCEW width. MJO is genuinely broader (±15-20°) and overrides this
    # to L=10° per Yang et al. (2007).
    trapping_scale_deg: float = 8.0


WAVE_SPECS = [
    WaveSpec(
        name="anomaly",
        title="OLR Anomaly",
        description="Daily OLR anomaly vs 1991-2020 climatology. "
                    "Negative (green) = suppressed OLR = enhanced deep convection. "
                    "Contours every 10 W/m².",
        component="raw",
        vmin=-60.0, vmax=60.0,
        cmap="BrBG_r",
        # Contour rendering matches the rest of the site's env-overlay
        # treatment: colored isolines on a transparent background read
        # cleanly over the IR / GeoColor underlay instead of washing it
        # out. Levels span ±50 W/m² in 10 W/m² steps — broad enough to
        # capture the canonical anomaly envelope without crowding the
        # map with isolines.
        render_style="contour",
        contour_levels=[-50, -40, -30, -20, -10, 10, 20, 30, 40, 50],
    ),
    WaveSpec(
        name="mjo",
        title="MJO-filtered OLR",
        description="Wheeler-Kiladis MJO band — eastward wavenumbers 1-5, "
                    "period 30-96 d, symmetric component. Contours every "
                    "3 W/m²; the equatorially-trapped envelope of active "
                    "(green) and suppressed (brown) convection should be "
                    "visible across the Indo-Pacific.",
        component="sym",
        k_lo=1, k_hi=5,
        freq_lo=1.0 / 96.0, freq_hi=1.0 / 30.0,
        vmin=-15.0, vmax=15.0,
        render_style="contour",
        contour_levels=[-12, -9, -6, -3, 3, 6, 9, 12],
        # MJO OLR projects predominantly onto the D₀ (Kelvin-like)
        # meridional eigenstructure (Kiladis 2009 §3.2), but with a wider
        # trapping scale than the Kelvin band itself. L=10° matches the
        # observed MJO convective envelope and is consistent with the
        # PCF-projected MJO frameworks (e.g. Yang et al. 2007).
        merid_pcf_n=0,
        trapping_scale_deg=10.0,
    ),
    WaveSpec(
        name="kelvin",
        title="Kelvin-wave filtered OLR",
        description="Wheeler-Kiladis Kelvin band — eastward wavenumbers 1-14, "
                    "period 2.5-30 d, equivalent depth h = 8-90 m (phase speed "
                    "c ≈ 9-30 m/s eastward), symmetric component. The period "
                    "bound prevents MJO-band leakage into the Kelvin filter; "
                    "the h-bound traces the dispersion curve in the (k, ω) "
                    "domain. Contours every 2 W/m².",
        component="sym",
        k_lo=1, k_hi=14,
        # 2.5-30 day periods (1/30 to 1/2.5 cpd). Without this bound the
        # h-gate alone admits low-frequency power that physically belongs
        # to the MJO band; the result is a broad smooth Kelvin field
        # with no resolvable wave envelopes (the original bug).
        freq_lo=1.0 / 30.0, freq_hi=1.0 / 2.5,
        h_lo=8.0, h_hi=90.0,
        vmin=-10.0, vmax=10.0,
        render_style="contour",
        contour_levels=[-8, -6, -4, -2, 2, 4, 6, 8],
        merid_pcf_n=0,  # Kelvin: D₀ (symmetric, equator-peaked)
    ),
    WaveSpec(
        name="er",
        title="Equatorial Rossby (n=1) OLR",
        description="Wheeler-Kiladis ER band — westward wavenumbers 1-10, "
                    "period 9.7-72 d (Kiladis 2009), equivalent depth "
                    "h = 8-90 m (phase speed c ≈ 9-30 m/s westward), n=1 "
                    "Rossby branch, symmetric component. Contours every 2 W/m².",
        component="sym",
        k_lo=-10, k_hi=-1,
        # 9.7-72 d period range — Kiladis et al. 2009 Rev. Geophys. canonical
        # specification (also used by Schreck's monitor).
        freq_lo=1.0 / 72.0, freq_hi=1.0 / 9.7,
        h_lo=8.0, h_hi=90.0,
        vmin=-10.0, vmax=10.0,
        render_style="contour",
        contour_levels=[-8, -6, -4, -2, 2, 4, 6, 8],
        merid_pcf_n=0,  # ER n=1 OLR: D₀-dominant (Kiladis 2009 Table 2)
    ),
    WaveSpec(
        name="mrg",
        title="Mixed Rossby-Gravity OLR",
        description="Wheeler-Kiladis MRG band — westward wavenumbers 1-10, "
                    "period 3-96 d, anti-symmetric component. The canonical "
                    "MRG mode lives at the slow westward (3-25 d) branch but "
                    "we keep the broader 3-96 d window so secondary low-freq "
                    "MRG-like structures are visible. Contours every 2 W/m².",
        component="asym",
        k_lo=-10, k_hi=-1,
        freq_lo=1.0 / 96.0, freq_hi=1.0 / 3.0,
        vmin=-6.0, vmax=6.0,
        render_style="contour",
        contour_levels=[-6, -4, -2, 2, 4, 6],
        merid_pcf_n=1,  # MRG: D₁ (antisymmetric, peaks at y=L≈6°)
    ),
    WaveSpec(
        name="td_type",
        title="TD-type Disturbances OLR",
        description="Roundy & Frank (2004) TD-type band — westward "
                    "wavenumbers 6-20, period 2.5-5 d, anti-symmetric "
                    "component. Often the direct WPac / Atlantic TC "
                    "genesis trigger. Contours every 1 W/m²; amplitudes "
                    "typically ±1-4 W/m².",
        component="asym",
        k_lo=-20, k_hi=-6,
        freq_lo=1.0 / 5.0, freq_hi=1.0 / 2.5,
        vmin=-5.0, vmax=5.0,
        render_style="contour",
        contour_levels=[-4, -3, -2, -1, 1, 2, 3, 4],
        merid_pcf_n=1,  # TD-type: D₁ (antisymmetric, monsoon-trough belt)
    ),
]


# --------------------------------------------------------------------------
# Data fetch
# --------------------------------------------------------------------------

def _open_opendap_with_retry(url: str, max_tries: int = 4,
                             backoffs=(30, 60, 120)):
    """Open a THREDDS/OPeNDAP dataset, retrying transient server errors.

    PSL's THREDDS server intermittently returns HTTP 503 (maintenance /
    capacity). A single blip at the 13:30 UTC scheduler tick otherwise
    forfeits the whole day's Hovmöller refresh — the OLR fetch is the one
    upstream we don't control. Retry with backoff so a short outage
    self-heals within one job run; a longer outage is caught by the second
    daily scheduler trigger (see deploy_subseasonal_job.sh).
    """
    import time as _t
    import xarray as xr
    last_err = None
    for attempt in range(max_tries):
        try:
            return xr.open_dataset(url)
        except Exception as e:  # OSError (DAP 503), netCDF DAP errors, etc.
            last_err = e
            if attempt == max_tries - 1:
                break
            wait = backoffs[min(attempt, len(backoffs) - 1)]
            log.warning("OPeNDAP open failed (attempt %d/%d): %s — retrying in %ds",
                        attempt + 1, max_tries, e, wait)
            _t.sleep(wait)
    raise RuntimeError(
        f"OPeNDAP open failed after {max_tries} attempts: {url}") from last_err


def _fetch_olr_range(ds, start: datetime, end: datetime, chunk_days: int = 60):
    """Fetch OLR over [start, end] via OPeNDAP, chunked by `chunk_days`.

    The PSL OPeNDAP endpoint returns silent NaN / zero for slices longer
    than ~100 days (likely a server-side response-size cap). Chunking
    reliably avoids it.
    """
    import xarray as xr
    chunks = []
    cur = start
    while cur <= end:
        chunk_end = min(cur + timedelta(days=chunk_days - 1), end)
        log.info("  fetching %s .. %s ...", cur.date(), chunk_end.date())
        c = ds.olr.sel(time=slice(cur, chunk_end)).load()
        if c.sizes["time"] == 0:
            break
        chunks.append(c)
        cur = chunk_end + timedelta(days=1)
    if not chunks:
        return None
    return xr.concat(chunks, dim="time")


def fetch_olr_window(today: datetime, days_back: int = WINDOW_DAYS):
    """Fetch the most recent `days_back` days of NOAA OLR via OPeNDAP."""
    import xarray as xr
    log.info("Opening OPeNDAP %s ...", OPENDAP_URL)
    ds = _open_opendap_with_retry(OPENDAP_URL)
    start = (today - timedelta(days=days_back)).replace(tzinfo=None)
    end = today.replace(tzinfo=None)
    log.info("Fetching OLR window %s .. %s in 60-day chunks", start.date(), end.date())
    da = _fetch_olr_range(ds, start, end)
    log.info("Loaded OLR shape %s, time %s .. %s",
             da.shape, str(da.time.values[0])[:10], str(da.time.values[-1])[:10])
    return da


def daily_climatology(today: datetime, cache_dir: Path):
    """Compute or load a smoothed 1991-2020 day-of-year climatology of OLR.

    Returns an xarray.DataArray indexed by day-of-year [1..366] of shape
    (366, lat, lon).
    """
    import xarray as xr
    cache_path = cache_dir / "olr_climo_1991_2020.nc"
    if cache_path.exists():
        log.info("Loading cached climatology from %s", cache_path)
        return xr.open_dataarray(cache_path).load()

    log.info("Building climatology from %s .. %s ...", CLIMO_START, CLIMO_END)
    ds = _open_opendap_with_retry(OPENDAP_URL)
    start = datetime.fromisoformat(CLIMO_START)
    end   = datetime.fromisoformat(CLIMO_END)
    da = _fetch_olr_range(ds, start, end)
    if da is None:
        raise RuntimeError("Could not load climatology window")
    log.info("  loaded %d days for climatology", da.sizes["time"])
    # Day-of-year mean. Leap-day handling: pandas dayofyear gives 366 for
    # Feb-29 only in leap years; ordinary day 60 = Mar 1 in non-leap years
    # and Feb 29 in leap years. For a real-time tool 1° precision is
    # plenty; we don't need to be fancier.
    doy = da.time.dt.dayofyear
    climo = da.groupby(doy).mean(dim="time")
    climo = climo.rename({"dayofyear": "doy"})
    # Smooth with a 5-day running mean to reduce day-of-year noise
    # (real interannual variability still shows up in the anomaly).
    climo_smooth = climo.rolling(doy=5, center=True, min_periods=1).mean()
    cache_dir.mkdir(parents=True, exist_ok=True)
    climo_smooth.to_netcdf(cache_path)
    log.info("Cached climatology to %s", cache_path)
    return climo_smooth


def daily_anomaly(window, climo):
    """Subtract day-of-year climatology from the window.

    Zeroes any NaNs in the result (CPC Blended OLR scatters ~0.5% missing
    cells across the grid; FFT propagates NaN globally, so we replace
    them with 'no anomaly' which is the least-biased fill for spectral
    filtering).
    """
    doy = window.time.dt.dayofyear
    aligned = climo.sel(doy=doy)
    aligned = aligned.assign_coords(time=window.time).drop_vars("doy")
    anom = window - aligned
    nan_count = int(np.isnan(anom.values).sum())
    if nan_count:
        log.info("  filled %d NaN cells in anomaly (%.2f%% of grid)",
                 nan_count, 100 * nan_count / anom.size)
        anom = anom.fillna(0.0)
    return anom


# --------------------------------------------------------------------------
# GEFS OLR forecast (Hovmöller extension)
# --------------------------------------------------------------------------
# The observed Hovmöller stops at the latest CPC OLR day (~2 days behind
# real-time). Appending a short-range forecast both shows where the wave
# envelopes are headed AND — because the WK band-pass is a global FFT —
# replaces the reflect-pad at the present-time edge with real model data,
# stabilizing the band amplitude over the most recent observed days.
#
# Source: GEFS ensemble-MEAN ULWRF (TOA upward longwave = OLR) from the
# public AWS mirror (noaa-gefs-pds), fetched via .idx byte-range so we
# pull one ~125 KB GRIB message per forecast hour instead of the whole
# 0.5° file. ULWRF is archived as 6-hour averages ("0-6 hour ave fcst",
# "6-12 hour ave fcst", …), so four consecutive steps average to a clean
# calendar-day mean that matches the daily-mean observed product. We use
# the 00Z cycle so each 24 h window aligns to a UTC calendar day.
#
# GEFS skill for the MJO/Kelvin bands is only useful to ~1-2 weeks, so we
# cap the extension at 10 days and the frontend de-emphasizes the tail.
GEFS_S3_HOST = "noaa-gefs-pds.s3.amazonaws.com"
GEFS_FORECAST_DAYS = 10
GEFS_LATENCY_HOURS = 7   # 00Z geavg is reliably published by ~06-07 UTC


def _gefs_cycle_for(today: datetime):
    """Pick the GEFS 00Z cycle to use. Prefers today's 00Z once it's had
    time to publish; otherwise falls back to yesterday's 00Z. Returns
    (YYYYMMDD, "00")."""
    now = datetime.now(timezone.utc)
    base = today
    # If 'today' is the current UTC day but 00Z hasn't had GEFS_LATENCY_HOURS
    # to publish, step back a day.
    if (base.date() == now.date()) and (now.hour < GEFS_LATENCY_HOURS):
        base = base - timedelta(days=1)
    return base.strftime("%Y%m%d"), "00"


def _fetch_gefs_ulwrf_toa(date_str: str, hour_str: str, fh: int):
    """Fetch one GEFS ensemble-mean ULWRF-at-TOA field (W/m²) for forecast
    hour `fh` via .idx byte-range. Returns an xarray.DataArray(lat, lon)
    on the native 0.5° grid, or None on failure."""
    import requests
    import xarray as xr
    base = (f"https://{GEFS_S3_HOST}/gefs.{date_str}/{hour_str}/atmos/"
            f"pgrb2ap5/geavg.t{hour_str}z.pgrb2a.0p50.f{fh:03d}")
    # Locate the ULWRF:top-of-atmosphere message in the .idx sidecar.
    start = end = None
    for attempt in range(3):
        try:
            idx = requests.get(base + ".idx", timeout=60).text
            lines = idx.strip().split("\n")
            for i, ln in enumerate(lines):
                p = ln.split(":")
                if len(p) >= 5 and p[3] == "ULWRF" and p[4] == "top of atmosphere":
                    start = int(p[1])
                    if i + 1 < len(lines):
                        end = int(lines[i + 1].split(":")[1]) - 1
                    break
            break
        except Exception as e:
            log.warning("GEFS idx fetch f%03d attempt %d failed: %s",
                        fh, attempt + 1, e)
    if start is None:
        log.warning("GEFS f%03d: ULWRF TOA not found in idx", fh)
        return None
    rng = f"bytes={start}-{end if end is not None else ''}"
    content = None
    for attempt in range(3):
        try:
            r = requests.get(base, headers={"Range": rng}, timeout=120)
            if r.status_code in (200, 206) and r.content.startswith(b"GRIB"):
                content = r.content
                break
            log.warning("GEFS f%03d range fetch HTTP %d", fh, r.status_code)
        except Exception as e:
            log.warning("GEFS f%03d range fetch attempt %d failed: %s",
                        fh, attempt + 1, e)
    if content is None:
        return None
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
        tmp.write(content)
        path = tmp.name
    try:
        ds = xr.open_dataset(path, engine="cfgrib",
                             backend_kwargs={"indexpath": ""},
                             decode_timedelta=False)
        # Single message → single data var; avoid shortName guessing.
        vname = list(ds.data_vars)[0]
        da = ds[vname]
        # cfgrib names the spatial coords latitude/longitude.
        da = da.rename({"latitude": "lat", "longitude": "lon"})
        # cfgrib decode is lazy; force the read into memory before the
        # finally clause deletes the backing temp file.
        return da.load()
    except Exception as e:
        log.warning("GEFS f%03d cfgrib decode failed: %s", fh, e)
        return None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def fetch_gefs_olr_forecast(today: datetime, target_lat, target_lon,
                            days: int = GEFS_FORECAST_DAYS):
    """Build daily-mean GEFS forecast OLR on the observed OLR grid.

    Returns an xarray.DataArray(time, lat, lon) of daily-mean ULWRF (W/m²)
    for `days` forecast calendar days, regridded (bilinear) to
    (target_lat, target_lon), or None if the cycle is unavailable. Forecast
    day k (1-based) is the mean of the four 6 h-average steps spanning hours
    [24(k-1)+6 … 24k], valid on calendar date cycle_date + (k-1).
    """
    import xarray as xr
    date_str, hour_str = _gefs_cycle_for(today)
    cycle_dt = datetime.strptime(date_str, "%Y%m%d").replace(tzinfo=timezone.utc)
    log.info("Fetching GEFS %s %sZ ULWRF forecast (%d days) ...",
             date_str, hour_str, days)
    daily, times = [], []
    for k in range(1, days + 1):
        fhs = [24 * (k - 1) + 6, 24 * (k - 1) + 12,
               24 * (k - 1) + 18, 24 * k]
        block = [_fetch_gefs_ulwrf_toa(date_str, hour_str, fh) for fh in fhs]
        block = [b for b in block if b is not None]
        if len(block) < len(fhs):
            log.warning("GEFS day %d incomplete (%d/%d steps) — stopping forecast",
                        k, len(block), len(fhs))
            break
        day_mean = sum(block) / float(len(block))
        # Regrid native 0.5° → observed OLR grid. interp tolerates the
        # descending-lat source coordinate.
        reg = day_mean.interp(lat=target_lat, lon=target_lon)
        daily.append(reg)
        times.append(np.datetime64(cycle_dt.date(), "D") + np.timedelta64(k - 1, "D"))
    if not daily:
        log.warning("GEFS forecast produced no days")
        return None
    da = xr.concat(daily, dim="time")
    da = da.assign_coords(time=("time", np.array(times)))
    log.info("GEFS forecast: %d daily means %s .. %s",
             da.sizes["time"], str(times[0]), str(times[-1]))
    return da


# --------------------------------------------------------------------------
# Wheeler-Kiladis filtering
# --------------------------------------------------------------------------

def symmetric_antisymmetric(anom):
    """Decompose into (symmetric, antisymmetric) parts about the equator.

    Both outputs are returned with the original lat axis; the caller
    selects which one to feed into FFT filtering. Latitudes with no
    mirror partner (e.g., poles when grid isn't symmetric) keep their
    raw value in one component and zero in the other.
    """
    lat = anom.lat.values
    # Reverse-lat index by closest negative
    out_sym = anom.copy(deep=True)
    out_asym = anom.copy(deep=True)
    n = len(lat)
    for i in range(n):
        j = int(np.argmin(np.abs(lat + lat[i])))
        # Symmetric: (f(lat) + f(-lat)) / 2
        out_sym.values[..., i, :] = 0.5 * (anom.values[..., i, :]
                                            + anom.values[..., j, :])
        out_asym.values[..., i, :] = 0.5 * (anom.values[..., i, :]
                                             - anom.values[..., j, :])
    return out_sym, out_asym


def wk_filter(field, spec: WaveSpec):
    """Apply Wheeler-Kiladis band filter for the given wave spec.

    Input `field` is the symmetric or anti-symmetric anomaly already
    selected per spec.component. Returns filtered field with same shape
    (time, lat, lon).
    """
    g = 9.81
    arr = field.values  # (time, lat, lon)
    nt, ny, nx = arr.shape

    # Mean-remove before FFT so the cosine taper doesn't bias the DC bin.
    arr = arr - np.nanmean(arr, axis=0, keepdims=True)
    n_taper = max(2, int(0.10 * nt))

    # Reflect-pad each pixel's time series by n_taper days at both ends
    # so the Hanning taper sits entirely on synthetic (reflected) data,
    # not on real OLR. Without this pad the most recent n_taper days
    # come back amplitude-attenuated in the filtered output — exactly
    # the "quiet top of the Hovmöller" symptom for recent days.
    # Reflection preserves zero-DC across the boundary and is the
    # standard fix for FFT-based band-pass filtering at finite-record
    # edges.
    arr_padded = np.pad(arr, ((n_taper, n_taper), (0, 0), (0, 0)),
                        mode='reflect')
    nt_padded = nt + 2 * n_taper

    taper = np.ones(nt_padded)
    half = np.hanning(2 * n_taper)
    taper[:n_taper] = half[:n_taper]
    taper[-n_taper:] = half[-n_taper:]
    arr_padded = arr_padded * taper[:, None, None]

    # FFT in (time, lon). real → complex.
    # Convention: positive frequency = eastward wavenumber × positive
    # time-frequency. Using numpy's standard FFT, fft2 yields k indices
    # 0..nx/2 for positive (eastward) wavenumbers, then nx-1 .. nx/2+1
    # for negative (westward). Same idea on the freq axis.
    F = np.fft.fft2(arr_padded, axes=(0, 2))

    # Wavenumber and frequency coordinates — built on the *padded* length
    # so the WK gates pick up the right physical (cycles/day, cycles/globe)
    # bins after padding.
    freq = np.fft.fftfreq(nt_padded, d=1.0)  # cycles per day, time spacing 1 d
    k    = np.fft.fftfreq(nx, d=1.0/nx)      # zonal wavenumber (cycles around globe)
    # Build mask in (time-freq, lon-wavenumber) space, broadcast over lat
    mask = np.zeros((nt_padded, nx), dtype=bool)

    # Direction convention. A physical wave x = cos(k*lon - ω*t) with
    # k>0, ω>0 (eastward) decomposes into exp(i(klon-ωt)) and its
    # conjugate. Under numpy's FFT convention X[m] = Σ x[n] e^{-2πi mn/N},
    # the time factor exp(-iωt) maps to NEGATIVE freq_bin. So eastward
    # energy lives at numpy (k_bin>0, freq_bin<0) ∪ conjugate
    # (k_bin<0, freq_bin>0). The old code kept (k_bin>0, freq_bin>0)
    # which is actually the conjugate of WESTWARD — Kelvin and ER were
    # effectively swapped, producing reverse-direction streaks.
    if spec.name in ("kelvin", "mjo"):
        direction = "east"
    elif spec.name in ("er", "mrg", "td_type"):
        # ER, MRG, and TD-type all propagate westward in the physical
        # convention. MRG/TD-type get the antisymmetric component input.
        direction = "west"
    else:
        direction = None

    # Wavenumber filter — accept |k_bin| within the spec's magnitude range
    # for eastward/westward modes (the conjugate quadrant has k_bin of
    # the opposite sign). For undirected spec, fall back to signed range.
    if spec.k_lo is not None and spec.k_hi is not None:
        kk = np.round(k).astype(int)
        if direction in ("east", "west"):
            k_lo_abs = min(abs(spec.k_lo), abs(spec.k_hi))
            k_hi_abs = max(abs(spec.k_lo), abs(spec.k_hi))
            k_in = (np.abs(kk) >= k_lo_abs) & (np.abs(kk) <= k_hi_abs)
        else:
            k_in = (kk >= spec.k_lo) & (kk <= spec.k_hi)
    else:
        k_in = np.ones_like(k, dtype=bool)

    # Frequency filter. WK band ranges are written for positive (cycles
    # per day) magnitudes; the filter is symmetric in |freq_bin|.
    omega_abs = np.abs(freq)
    if spec.freq_lo is not None and spec.freq_hi is not None:
        f_in_basic = (omega_abs >= spec.freq_lo) & (omega_abs <= spec.freq_hi)
    else:
        f_in_basic = np.ones_like(freq, dtype=bool)

    # Build the 2-D mask.
    for ti, freq_i in enumerate(freq):
        if not f_in_basic[ti]:
            continue
        for xi, k_i in enumerate(k):
            if not k_in[xi]:
                continue
            # Direction quadrant gate. Both the primary quadrant and its
            # conjugate are kept so the inverse FFT recovers full amplitude
            # of the real-valued band-passed signal.
            if direction == "east":
                in_quadrant = (k_i > 0 and freq_i < 0) or (k_i < 0 and freq_i > 0)
            elif direction == "west":
                in_quadrant = (k_i < 0 and freq_i < 0) or (k_i > 0 and freq_i > 0)
            else:
                in_quadrant = True
            if not in_quadrant:
                continue

            keep = True
            # Optional h-equivalent-depth gate (Kelvin / ER dispersion).
            # All sign confusion is avoided by working with |k|, |ω|; the
            # dispersion curves are symmetric about (0,0) and the direction
            # gate above has already constrained us to the correct half.
            if spec.h_lo is not None and spec.h_hi is not None:
                a = 6.371e6
                k_abs = abs(k_i) / a                          # rad/m
                omega_a = abs(freq_i) * 2 * np.pi / 86400.0   # rad/s
                if k_abs == 0:
                    keep = False
                elif spec.name == "kelvin":
                    # Kelvin: |ω| = |k| * sqrt(gh) → c = |ω| / |k|
                    c = omega_a / k_abs
                    h = (c * c) / g
                    keep = (spec.h_lo <= h <= spec.h_hi)
                elif spec.name == "er":
                    # n=1 ER (westward): |ω| = β |k| / (k² + 3β/c)
                    # Solve: 3β/c = β |k| / |ω| − k² → c = 3β / (...)
                    beta = 2 * 7.292e-5 / a            # ≈ 2.29e-11 m⁻¹s⁻¹
                    denom = beta * k_abs / omega_a - k_abs * k_abs
                    if denom > 0:
                        c = 3 * beta / denom
                        h = (c * c) / g
                        keep = (spec.h_lo <= h <= spec.h_hi)
                    else:
                        keep = False
                else:
                    keep = False
            mask[ti, xi] = keep

    log.info("  WK mask for %s: %d / %d (k×ω) cells active",
             spec.name, mask.sum(), mask.size)

    F_filtered = F * mask[:, None, :]
    out_padded = np.real(np.fft.ifft2(F_filtered, axes=(0, 2)))
    # Strip the reflected pad so the returned array matches `field` in
    # shape. The real-data portion is now amplitude-preserved end-to-end
    # because the taper only attenuated the reflected synthetic samples.
    out = out_padded[n_taper:-n_taper]
    return field.copy(data=out)


# --------------------------------------------------------------------------
# Meridional PCF projection
# --------------------------------------------------------------------------

def _pcf_weight(lat_deg: np.ndarray, n: int, L_deg: float) -> np.ndarray:
    """Unnormalized parabolic cylinder function D_n(y/L) evaluated on a
    latitude grid (degrees). Hermite-weighted Gaussian; n=0 is the Kelvin
    eigenstructure (equator-peaked), n=1 is the MRG eigenstructure
    (antisymmetric, peaks off-equator at |y|=L), n=2 is the next symmetric
    mode (sign change near the equator)."""
    xi = lat_deg / float(L_deg)
    gauss = np.exp(-0.5 * xi * xi)
    if n == 0:
        return gauss
    if n == 1:
        return xi * gauss
    if n == 2:
        return (xi * xi - 1.0) * gauss
    raise ValueError(f"PCF order n={n} not supported (need 0, 1, or 2)")


def apply_pcf_projection(field, spec: WaveSpec):
    """Project the WK-filtered field onto its theoretical equatorial-wave
    meridional eigenstructure (Yang, Hoskins & Slingo 2003).

    Pure (k, ω) WK filtering leaves the band-passed amplitude defined at
    every latitude — equatorially-trapped wave modes thus get spurious
    extratropical contours. Projecting onto the n-th parabolic cylinder
    function with a fixed 6° trapping scale confines the signal to its
    physical envelope (effectively ±25° for n=0, n=1).

    Implementation is a least-squares projection onto a single mode:

        coef(t, x) = Σ_y field(t, y, x) · w_n(y) / Σ_y w_n(y)²
        out(t, y, x) = coef(t, x) · w_n(y)

    Self-normalizing (the trapping-scale and dy factors cancel out), so
    output units match input. Cost is O(nt · ny · nx) — negligible next
    to the upstream FFT.
    """
    if spec.merid_pcf_n is None:
        return field
    lat = field.lat.values.astype(np.float64)
    w = _pcf_weight(lat, spec.merid_pcf_n, spec.trapping_scale_deg)
    w_norm = float(np.sum(w * w))
    if w_norm <= 0:
        log.warning("PCF projection skipped for %s: zero weight norm",
                    spec.name)
        return field
    arr = field.values  # (nt, ny, nx)
    # Inner product along lat axis → projection coefficient at each (t, x).
    coef = np.einsum("tyx,y->tx", arr, w) / w_norm
    out = coef[:, None, :] * w[None, :, None]
    log.info("  PCF n=%d projection applied to %s (L=%.1f°, norm=%.3g)",
             spec.merid_pcf_n, spec.name, spec.trapping_scale_deg, w_norm)
    return field.copy(data=out)


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

WEB_MERC_LAT_MAX = 85.05112877980659  # arctan(sinh(pi)) * 180/pi


def _warp_eq_to_mercator(field: np.ndarray, ny_out: Optional[int] = None
                         ) -> np.ndarray:
    """Re-sample an equirectangular field (lat ∈ [+90, -90], rows top→bottom)
    onto a Web Mercator pixel grid (lat ∈ [+85.05, -85.05]). Mirrors the
    helper of the same name in build_env_overlays.py; copied rather than
    imported to keep this script self-contained for Cloud Run packaging.

    Without this warp, an equirectangular source PNG dropped onto
    Leaflet's Mercator basemap visually displaces every non-equatorial
    latitude — at 14°N the data lands at the screen position of ~26°N.
    """
    ny_in, nx_in = field.shape
    if ny_out is None:
        ny_out = ny_in
    max_my = np.log(np.tan(np.pi/4 + np.radians(WEB_MERC_LAT_MAX) / 2))
    rows_out = np.arange(ny_out, dtype=np.float64)
    merc_y = max_my - (rows_out + 0.5) / ny_out * (2 * max_my)
    lats = np.degrees(np.arctan(np.sinh(merc_y)))
    src_rows = np.clip(np.round((90.0 - lats) / 180.0 * ny_in).astype(int),
                       0, ny_in - 1)
    return field[src_rows, :].copy()


def _prepare_field_for_render(field2d: np.ndarray, lats: np.ndarray,
                               lons: np.ndarray):
    """Reorder lat N→S and shift lon to [-180, 180], then Mercator-warp.
    Returns the warped 2D array ready to feed matplotlib in the
    [-180, 180, -WEB_MERC_LAT_MAX, WEB_MERC_LAT_MAX] extent.
    """
    lat_order = np.argsort(-lats)
    f = field2d[lat_order, :]
    lon_order = np.argsort(((lons + 180) % 360) - 180)
    f = f[:, lon_order]
    return _warp_eq_to_mercator(f)


def _render_filled_png(field2d: np.ndarray, spec: WaveSpec) -> bytes:
    """Filled diverging-colormap render — used for the raw OLR anomaly
    (vmin/vmax ±60 W/m² is wide enough that the broad ITCZ + subtropical
    pattern reads cleanly under filled shading)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import TwoSlopeNorm

    fig = plt.figure(figsize=(NX / 100, NY / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    norm = TwoSlopeNorm(vcenter=0.0, vmin=spec.vmin, vmax=spec.vmax)
    ax.imshow(
        field2d, cmap=spec.cmap, norm=norm,
        extent=[-180, 180, -WEB_MERC_LAT_MAX, WEB_MERC_LAT_MAX],
        origin="upper", interpolation="bilinear", aspect="auto",
    )
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, bbox_inches="tight",
                pad_inches=0)
    plt.close(fig)
    return buf.getvalue()


def _render_contour_png(field2d: np.ndarray, spec: WaveSpec) -> bytes:
    """Render `field2d` as colored isolines on a transparent background.

    For WK-filtered bands whose natural amplitude is small (±2-15 W/m²),
    filled shading reads as a near-uniform pale wash that obscures the
    IR underlay. Line contours expose the equatorially-trapped wave
    envelopes as discrete loops while letting the IR show through
    everywhere outside the active signal.

    Smoothing pipeline:
    - Upsample the 2.5° native field (~144×73) by 5× via SciPy bicubic
      so the contour algorithm has enough density to draw smooth curves
      (instead of the chunky polygonal isolines that result when you
      contour a sparse grid directly).
    - Apply a light Gaussian blur (σ=1.5 cells in upsampled space) to
      damp the residual grid-cell facets — fine for WK-filtered fields
      which are already smooth, would over-smooth a noisy scalar.

    Contour levels come from spec.contour_levels (symmetric ±L pairs).
    Negative (active convection / forced ascent) draws in green,
    positive (suppressed) in brown. Stroke width scales with magnitude
    — weak ±2 envelopes thinner than strong ±8 ones.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from scipy.ndimage import zoom, gaussian_filter

    levels = list(spec.contour_levels or [])
    if not levels:
        return _render_filled_png(field2d, spec)

    # 5× bicubic upsample so contour curvature is well-defined; then a
    # small Gaussian (σ=1.5 cells in the dense field) softens the
    # grid-cell facets that survive bicubic interpolation.
    field_hi = zoom(field2d, zoom=5, order=3, mode="wrap")
    field_hi = gaussian_filter(field_hi, sigma=1.5, mode="wrap")

    out_nx, out_ny = field_hi.shape[1], field_hi.shape[0]
    dpi = 100

    fig = plt.figure(figsize=(out_nx / dpi, out_ny / dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    # x = lon, y = lat (top → bottom in Mercator pixel space)
    xs = np.linspace(-180, 180, out_nx)
    ys = np.linspace(WEB_MERC_LAT_MAX, -WEB_MERC_LAT_MAX, out_ny)
    # Per-level color + stroke width: deeper saturation + thicker stroke
    # for the outer (high-magnitude) contours.
    max_abs = max(abs(l) for l in levels)
    colors = []
    widths = []
    for L in levels:
        mag = abs(L) / max_abs            # 0..1
        # CPC BrBG palette: negative (ascent) green, positive (subsidence)
        # brown. Endpoints picked from ColorBrewer BrBG so the visual
        # intensity ramp matches the heatmap on the Subseasonal tab.
        if L < 0:
            # mag=0 → #80cdc1 (pale teal-green); mag=1 → #01665e (deep green)
            r = int(round(128 * (1 - mag) +   1 * mag))
            g = int(round(205 * (1 - mag) + 102 * mag))
            b = int(round(193 * (1 - mag) +  94 * mag))
        else:
            # mag=0 → #dfc27d (pale tan); mag=1 → #8c510a (saddle brown)
            r = int(round(223 * (1 - mag) + 140 * mag))
            g = int(round(194 * (1 - mag) +  81 * mag))
            b = int(round(125 * (1 - mag) +  10 * mag))
        colors.append((r / 255, g / 255, b / 255))
        widths.append(0.8 + 1.8 * mag)
    ax.contour(
        xs, ys, field_hi,
        levels=levels, colors=colors, linewidths=widths,
        antialiased=True,
    )
    ax.set_xlim(-180, 180)
    ax.set_ylim(-WEB_MERC_LAT_MAX, WEB_MERC_LAT_MAX)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, bbox_inches=None,
                pad_inches=0, dpi=dpi)
    plt.close(fig)
    return buf.getvalue()


def render_png(field2d: np.ndarray, lats: np.ndarray, lons: np.ndarray,
               spec: WaveSpec) -> bytes:
    """Dispatch to the contour or filled renderer based on spec.render_style.
    Both paths warp the field to Mercator pixel-space first so the
    output PNG aligns correctly when overlaid on Leaflet's Web Mercator
    basemap.
    """
    warped = _prepare_field_for_render(field2d, lats, lons)
    if spec.render_style == "contour":
        return _render_contour_png(warped, spec)
    return _render_filled_png(warped, spec)


def _contour_level_color(L: float, max_abs: float) -> str:
    """Hex string for a contour level — matches the per-level palette
    used in _render_contour_png so the GeoJSON polylines, PNG fallback,
    and frontend legend swatches all agree pixel-for-pixel."""
    mag = abs(L) / max_abs if max_abs else 0.0
    # Mirror the BrBG endpoints used in _render_contour_png so the
    # GeoJSON polylines, PNG fallback, and frontend legend swatches agree.
    if L < 0:
        # mag=0 → #80cdc1 (pale teal-green); mag=1 → #01665e (deep green)
        r = int(round(128 * (1 - mag) +   1 * mag))
        g = int(round(205 * (1 - mag) + 102 * mag))
        b = int(round(193 * (1 - mag) +  94 * mag))
    else:
        # mag=0 → #dfc27d (pale tan); mag=1 → #8c510a (saddle brown)
        r = int(round(223 * (1 - mag) + 140 * mag))
        g = int(round(194 * (1 - mag) +  81 * mag))
        b = int(round(125 * (1 - mag) +  10 * mag))
    return f"#{r:02x}{g:02x}{b:02x}"


def render_contour_geojson(field2d: np.ndarray, lats: np.ndarray,
                            lons: np.ndarray, spec: WaveSpec) -> Optional[bytes]:
    """Extract contour line segments as a GeoJSON FeatureCollection of
    LineStrings, with each feature tagged by its level + color + label.
    Used by the frontend's L.geoJSON path so the wave envelopes draw as
    crisp vector polylines (no pixelation at any zoom) and matplotlib
    text labels can be placed at midpoints by the frontend.

    Input is the equirectangular field (NOT Mercator-warped) — GeoJSON
    coords are lat/lon and Leaflet reprojects them for us.
    """
    if not spec.contour_levels:
        return None

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from scipy.ndimage import zoom, gaussian_filter

    # Equirectangular orientation: row 0 = +90 (north), col 0 = -180 (west)
    lat_order = np.argsort(-lats)
    f = field2d[lat_order, :]
    lon_order = np.argsort(((lons + 180) % 360) - 180)
    f = f[:, lon_order]

    # Same upsample + smoothing as the PNG renderer so the GeoJSON
    # polylines match what the contour PNG (fallback) shows.
    f_hi = zoom(f, zoom=5, order=3, mode="wrap")
    f_hi = gaussian_filter(f_hi, sigma=1.5, mode="wrap")
    ny_hi, nx_hi = f_hi.shape

    fig = plt.figure()
    ax = fig.add_subplot(111)
    cs = ax.contour(np.arange(nx_hi), np.arange(ny_hi), f_hi,
                    levels=list(spec.contour_levels))
    plt.close(fig)

    # (col, row) → (lon, lat) on the upsampled grid. Lon is uniform
    # over [-180, 180); lat is uniform over [+90, -90].
    deg_per_col = 360.0 / nx_hi
    deg_per_row = 180.0 / max(ny_hi - 1, 1)
    max_abs = max(abs(L) for L in spec.contour_levels)

    def _split_antimeridian(coords):
        if len(coords) < 2: return [coords]
        out, cur = [], [coords[0]]
        for i in range(1, len(coords)):
            if abs(coords[i][0] - coords[i - 1][0]) > 180.0:
                if len(cur) >= 2: out.append(cur)
                cur = [coords[i]]
            else:
                cur.append(coords[i])
        if len(cur) >= 2: out.append(cur)
        return out

    features = []
    levels_arr = list(spec.contour_levels)
    for lvl_idx, segs in enumerate(cs.allsegs):
        lvl = float(levels_arr[lvl_idx])
        color = _contour_level_color(lvl, max_abs)
        for seg in segs:
            if len(seg) < 2: continue
            coords = []
            for px, py in seg:
                lon = -180.0 + float(px) * deg_per_col
                lat =   90.0 - float(py) * deg_per_row
                coords.append([round(lon, 3), round(lat, 3)])
            for sub in _split_antimeridian(coords):
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": sub},
                    "properties": {"level": lvl, "color": color},
                })

    fc = {"type": "FeatureCollection", "features": features}
    return json.dumps(fc, separators=(",", ":")).encode("utf-8")


def build_colorbar_stops(spec: WaveSpec, n: int = 16) -> list:
    """16-stop colorbar gradient matching the per-level palette used in
    the contour renderer. Frontend paints this as a colorbar legend."""
    span = max(abs(spec.vmin), abs(spec.vmax)) or 1.0
    stops = []
    for i in range(n):
        t = i / (n - 1)                  # 0..1
        v = spec.vmin + t * (spec.vmax - spec.vmin)
        color_hex = _contour_level_color(v, span)
        r, g, b = int(color_hex[1:3], 16), int(color_hex[3:5], 16), int(color_hex[5:7], 16)
        stops.append({"t": round(t, 4), "rgb": [r, g, b]})
    return stops


def build_level_colors(spec: WaveSpec) -> list:
    """RGB triplets for each contour level — frontend uses these to
    paint the swatch legend so the menu colors match what's drawn."""
    if not spec.contour_levels:
        return []
    max_abs = max(abs(L) for L in spec.contour_levels)
    out = []
    for L in spec.contour_levels:
        c = _contour_level_color(L, max_abs)
        out.append([int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)])
    return out


GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
GCS_PREFIX = "subseasonal"   # gs://{bucket}/{prefix}/{wave}/{latest.png|metadata.json}


def build_hovmoller_slab(field, spec: WaveSpec, valid_time_iso: str,
                         n_forecast: int = 0) -> dict:
    """Slice the full (time, lat, lon) wave-band field into a Hovmöller
    payload: last HOVMOLLER_LOOKBACK_DAYS days, latitudinally averaged
    over each band in HOVMOLLER_LAT_BANDS. Output is a JSON-ready dict
    that the Real-Time Monitor's Subseasonal tab consumes directly to
    paint a Plotly heatmap (time × lon) per band.

    Values are rounded to 1 decimal place — OLR anomaly precision is
    well under 0.1 W/m² in practice, and rounding cuts JSON payload by
    ~2× without visible degradation.

    Colormap range is dynamic: vmin/vmax track the 95th percentile of
    |values| across all rendered bands in the window, clamped to
    [spec.vmax × 0.30, spec.vmax × 1.5] so off-season low-amplitude
    bands (e.g. TD-type in May) read pale instead of saturating the
    fixed ±spec.vmax scale on background noise, while strong-season
    activity still reaches full saturation without single-cell
    outliers stretching the scale unreasonably.
    """
    lats = field.lat.values
    lons = field.lon.values
    last_n = min(HOVMOLLER_LOOKBACK_DAYS + n_forecast, field.shape[0])
    sliced = field.isel(time=slice(-last_n, None))
    times = [str(np.datetime64(t, "D")) for t in sliced.time.values]

    out = {
        "band": spec.name,
        "title": spec.title,
        "valid_time": valid_time_iso,
        "units": "W/m²",
        # vmin/vmax filled in after the per-band loop so we can derive
        # them from the actual rendered values across all bands.
        "vmin": spec.vmin,
        "vmax": spec.vmax,
        "vmin_fixed": spec.vmin,        # spec defaults exposed for the
        "vmax_fixed": spec.vmax,        # frontend if it wants to override
        "lookback_days": last_n,
        "lons": [float(x) for x in lons],
        "times": times,
        "lat_bands": {},
    }
    if n_forecast > 0 and n_forecast <= len(times):
        # The trailing `n_forecast` entries of `times` are GEFS forecast
        # daily means; the frontend draws a divider at forecast_from and
        # styles that region (dashed / de-emphasized).
        out["n_forecast"] = n_forecast
        out["forecast_from"] = times[-n_forecast]
        out["analysis_valid_time"] = valid_time_iso
        out["forecast_source"] = "GEFS ens-mean OLR"
    all_vals = []
    for band in HOVMOLLER_LAT_BANDS:
        # Build a boolean mask on the lat axis instead of relying on
        # xarray slice direction (NOAA OLR is descending lat).
        mask = (lats >= band["lat_min"]) & (lats <= band["lat_max"])
        if not mask.any():
            log.warning("  hovmoller: no lats in band %s (%g..%g)",
                        band["key"], band["lat_min"], band["lat_max"])
            continue
        hov = sliced.values[:, mask, :].mean(axis=1)   # (time, lon)
        all_vals.append(hov)
        out["lat_bands"][band["key"]] = {
            "lat_min": band["lat_min"],
            "lat_max": band["lat_max"],
            "label": band["label"],
            "values": np.round(hov, 1).tolist(),
        }

    if all_vals:
        stacked = np.concatenate([v.ravel() for v in all_vals])
        finite = stacked[np.isfinite(stacked)]
        if finite.size:
            # 95th percentile of |values| as the symmetric colormap
            # range. Clamp lower bound so off-season tiny-amplitude
            # noise doesn't over-zoom into apparent waves; clamp upper
            # bound so a single rogue cell doesn't wash out the rest.
            p95 = float(np.percentile(np.abs(finite), 95))
            lo_floor = float(spec.vmax) * 0.30
            hi_ceil  = float(spec.vmax) * 1.50
            dyn_vmax = max(lo_floor, min(p95, hi_ceil))
            out["vmin"] = round(-dyn_vmax, 2)
            out["vmax"] = round( dyn_vmax, 2)
            out["scale_p95"] = round(p95, 2)
    return out


def write_hovmoller_local(out_dir: Path, spec: WaveSpec, slab: dict,
                          filename: str = "hovmoller.json") -> None:
    """Mirror the GCS path layout locally for `--local-only` debugging.
    Writes `<spec.name>.<filename>` alongside the existing PNG."""
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{spec.name}.{filename}").write_text(
        json.dumps(slab, separators=(",", ":"))
    )


def upload_hovmoller_gcs(spec: WaveSpec, slab: dict,
                         filename: str = "hovmoller.json") -> bool:
    """Upload Hovmöller slab to
    gs://{GCS_BUCKET}/{GCS_PREFIX}/{spec.name}/{filename}.
    Cache TTL matches the wave overlays (10 min) since the pipeline
    refreshes once daily."""
    try:
        from google.cloud import storage
    except ImportError:
        log.error("google-cloud-storage not installed; cannot upload hovmoller")
        return False
    if not GCS_BUCKET:
        log.error("GCS_IR_CACHE_BUCKET not set; cannot upload hovmoller")
        return False
    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/{filename}")
    blob.upload_from_string(json.dumps(slab, separators=(",", ":")),
                            content_type="application/json")
    blob.cache_control = "public, max-age=600"
    blob.patch()
    try:
        blob.make_public()
    except Exception as e:
        log.warning("Could not mark %s public: %s", blob.name, e)
    log.info("  uploaded gs://%s/%s/%s/%s",
             GCS_BUCKET, GCS_PREFIX, spec.name, filename)
    return True


def _meta_dict(spec: WaveSpec, valid_time: str, bounds: list,
               image_url: Optional[str] = None,
               geojson_url: Optional[str] = None) -> dict:
    """Shared metadata payload for both local + GCS outputs. The frontend
    reads metadata.json to learn the public PNG URL, colorbar range,
    valid date, and bounds for L.imageOverlay. For contour layers,
    geojson_url enables the vector-polyline + label rendering path."""
    d = {
        "name": spec.name,
        "title": spec.title,
        "description": spec.description,
        "category": "subseasonal",
        "valid_time": valid_time,
        "units": "W/m²",
        "vmin": spec.vmin,
        "vmax": spec.vmax,
        "cmap": spec.cmap,
        # render_style routes the frontend's L.imageOverlay handling.
        # "contour" + geojson_url → L.geoJSON path (crisp vector polylines
        # with value labels at midpoints, matches the other env layers).
        # "contour" without geojson_url → L.imageOverlay raster fallback.
        # "filled" → diverging colormap raster shading.
        "render_style": spec.render_style,
        "bounds": bounds,
        # Colorbar legend payload — frontend paints these stops as a
        # gradient + the per-level swatches in the layer menu. Without
        # them the legend renders empty (the bug the user just noticed).
        "colorbar_stops": build_colorbar_stops(spec),
        "levels": list(spec.contour_levels) if spec.contour_levels else [],
        "level_colors": build_level_colors(spec),
    }
    if image_url:
        d["image_url"] = image_url
    if geojson_url:
        d["geojson_url"] = geojson_url
    return d


def write_local(out_dir: Path, spec: WaveSpec, png: bytes, valid_time: str,
                bounds: list):
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{spec.name}.png").write_bytes(png)
    meta = _meta_dict(spec, valid_time, bounds)
    (out_dir / f"{spec.name}.json").write_text(json.dumps(meta, indent=2))


def upload_gcs(spec: WaveSpec, png: bytes, valid_time: str, bounds: list,
                geojson: Optional[bytes] = None) -> bool:
    """Upload latest.png (+ latest.geojson for contour layers) +
    metadata.json to gs://{GCS_BUCKET}/{GCS_PREFIX}/{spec.name}/."""
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
    png_blob  = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest.png")
    meta_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/metadata.json")
    gj_blob   = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest.geojson") if geojson else None

    image_url = (f"https://storage.googleapis.com/{GCS_BUCKET}/"
                 f"{GCS_PREFIX}/{spec.name}/latest.png")
    geojson_url = (f"https://storage.googleapis.com/{GCS_BUCKET}/"
                   f"{GCS_PREFIX}/{spec.name}/latest.geojson") if geojson else None
    meta = _meta_dict(spec, valid_time, bounds,
                      image_url=image_url, geojson_url=geojson_url)

    def _put(blob, body, content_type: str) -> None:
        blob.upload_from_string(body, content_type=content_type)
        blob.cache_control = "public, max-age=600"
        blob.patch()
        try:
            blob.make_public()
        except Exception as e:
            log.warning("Could not mark %s public: %s", blob.name, e)

    _put(png_blob,  png, "image/png")
    if gj_blob is not None:
        _put(gj_blob, geojson, "application/geo+json")
    _put(meta_blob, json.dumps(meta), "application/json")

    log.info("  uploaded gs://%s/%s/%s/{latest.png%s,metadata.json}",
             GCS_BUCKET, GCS_PREFIX, spec.name,
             ",latest.geojson" if geojson else "")
    return True


# --------------------------------------------------------------------------
# Daily index refresh (MJO RMM / BSISO1+2 / ROMI)
# --------------------------------------------------------------------------
# Pulls fresh daily values from each provider, merges with the existing
# subseasonal_phases.json baseline, and uploads to GCS for the
# tc_climatology subseasonal subview to consume.
#
# Sources:
#   MJO RMM  — BOM (http://www.bom.gov.au/clim_data/IDCKGEM000/rmm.74toRealtime.txt)
#              May be blocked by BOM's anti-scraping; in that case the
#              existing series is preserved unchanged (manual one-off
#              refresh by browser download + commit still works).
#   BSISO    — APCC (https://www.apcc21.org/.../BSISO.INDEX.NORM.data)
#              Single file contains both BSISO1 and BSISO2 PC pairs.
#   ROMI     — NOAA PSL (https://psl.noaa.gov/mjo/mjoindex/romi.cpcolr.1x.txt)
#              Replaces the deprecated OMI (frozen at 2024-05-20 upstream).
# --------------------------------------------------------------------------

INDICES_GCS_PATH = "subseasonal/indices/latest.json"
BUNDLED_INDICES_PATH = Path("data/subseasonal_phases.json")

_BOM_RMM_URL = "http://www.bom.gov.au/clim_data/IDCKGEM000/rmm.74toRealtime.txt"
_APCC_BSISO_URL = (
    "https://www.apcc21.org/prediction/file/download"
    "?targetKind=BSISO/down/&targetName=BSISO.INDEX.NORM.data"
)
_NOAA_ROMI_URL = "https://psl.noaa.gov/mjo/mjoindex/romi.cpcolr.1x.txt"

# Phase from (PC1, PC2) using the same 8-sector convention as the
# bundled JSON: phase 1 starts at angle = -180° (i.e. -π), advances
# counter-clockwise in 45° (π/4 rad) bins. Sources that don't emit
# phase explicitly (ROMI, BSISO) get it computed here.
def _phase_from_pcs(pc1: float, pc2: float) -> int:
    import math
    angle = math.atan2(pc2, pc1)  # [-π, π]
    # Shift so phase 1 starts at angle = -π (180°W) and advances ccw.
    sector = int(((angle + math.pi) / (math.pi / 4)) % 8) + 1
    return sector


def _densify_daily(records: dict, fill=(0, 0.0, 0.0, 0.0)) -> dict:
    """Expand a sparse {date_iso: (phase, amp, pc1, pc2)} dict into
    DENSE daily arrays from min(date) to max(date) inclusive. Missing
    days get `fill` so the frontend's `idx = dayKey - startKey` math
    always lands on the right row. Returns dict suitable for merging
    into the index entry: {start_date, end_date, phases, amplitudes,
    pc1, pc2}.

    Why: the frontend (tc_climatology.js:_phaseOnDay) assumes a dense
    daily series. Skipping missing-value rows in the parser shifts
    every subsequent date wrong by the cumulative gap — 290 gaps in
    BOM RMM's pre-1979 era pushed today's MJO label back to 2025.
    """
    if not records:
        return None
    from datetime import date, timedelta
    start = min(date.fromisoformat(k) for k in records.keys())
    end   = max(date.fromisoformat(k) for k in records.keys())
    n_days = (end - start).days + 1
    phases, amps, pc1s, pc2s = [], [], [], []
    cur = start
    for _ in range(n_days):
        rec = records.get(cur.isoformat())
        if rec is None:
            p, a, p1, p2 = fill
        else:
            p, a, p1, p2 = rec
        phases.append(p)
        amps.append(round(float(a), 4))
        pc1s.append(round(float(p1), 4))
        pc2s.append(round(float(p2), 4))
        cur += timedelta(days=1)
    return {
        "start_date": start.isoformat(),
        "end_date":   end.isoformat(),
        "phases": phases, "amplitudes": amps, "pc1": pc1s, "pc2": pc2s,
    }


def _load_baseline_indices() -> dict:
    """Load the seed JSON. Prefer the most recent copy from GCS so we
    pick up yesterday's merged version; fall back to the container-
    bundled file on the first run (or if GCS unreachable)."""
    try:
        from google.cloud import storage
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob(INDICES_GCS_PATH)
        if blob.exists():
            log.info("Loading baseline indices from gs://%s/%s",
                     GCS_BUCKET, INDICES_GCS_PATH)
            return json.loads(blob.download_as_text())
    except Exception as e:
        log.warning("GCS baseline read failed (using bundled): %s", e)
    log.info("Loading baseline indices from %s", BUNDLED_INDICES_PATH)
    with open(BUNDLED_INDICES_PATH) as f:
        return json.load(f)


def _fetch_bom_rmm():
    """Fetch BOM RMM. Returns dict of arrays keyed by 'phases',
    'amplitudes', 'pc1', 'pc2', 'start_date', 'end_date' or None on
    failure (BOM blocks automated access from many networks)."""
    try:
        # Pretend to be a browser — BOM blocks most bot UAs but
        # occasionally lets a desktop-Chrome UA through. If blocked, we
        # return None and the merge step leaves the existing series.
        r = requests.get(_BOM_RMM_URL, timeout=60, headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0 Safari/537.36"
            )
        })
        if r.status_code != 200 or "blocked" in r.text[:500].lower():
            log.warning("BOM RMM fetch blocked (HTTP %d) — keeping existing series",
                        r.status_code)
            return None
        text = r.text
    except Exception as e:
        log.warning("BOM RMM fetch failed: %s — keeping existing series", e)
        return None

    records = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 7 or not parts[0].isdigit():
            continue
        try:
            yr = int(parts[0]); mo = int(parts[1]); dy = int(parts[2])
            if yr < 1974 or yr > 2100:
                continue
            pc1 = float(parts[3]); pc2 = float(parts[4])
            phase = int(parts[5]); amp = float(parts[6])
            # Missing-value sentinel — skip the row (densify pads it).
            if abs(pc1) > 1e30 or abs(pc2) > 1e30:
                continue
        except (ValueError, IndexError):
            continue
        records[f"{yr:04d}-{mo:02d}-{dy:02d}"] = (phase, amp, pc1, pc2)

    out = _densify_daily(records)
    if out is None:
        log.warning("BOM RMM parse produced 0 records — keeping existing series")
        return None
    log.info("BOM RMM: %d days (%s → %s, %d source records densified)",
             len(out["phases"]), out["start_date"], out["end_date"], len(records))
    return out


def _fetch_apcc_bsiso():
    """Fetch APCC BSISO file. Returns dict with 'bsiso1' + 'bsiso2'
    sub-dicts, each containing the same array fields as above."""
    try:
        r = requests.get(_APCC_BSISO_URL, timeout=60, allow_redirects=True)
        r.raise_for_status()
        text = r.text
    except Exception as e:
        log.warning("APCC BSISO fetch failed: %s — keeping existing series", e)
        return None

    from datetime import date, timedelta
    rec1, rec2 = {}, {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 8 or not parts[0].isdigit():
            continue
        try:
            yr = int(parts[0]); doy = int(parts[1])
            if yr < 1981 or yr > 2100 or doy < 1 or doy > 366:
                continue
            b1_p1 = float(parts[2]); b1_p2 = float(parts[3])
            b2_p1 = float(parts[4]); b2_p2 = float(parts[5])
            b1_amp = float(parts[6]); b2_amp = float(parts[7])
        except (ValueError, IndexError):
            continue
        d_iso = (date(yr, 1, 1) + timedelta(days=doy - 1)).isoformat()
        rec1[d_iso] = (_phase_from_pcs(b1_p1, b1_p2), b1_amp, b1_p1, b1_p2)
        rec2[d_iso] = (_phase_from_pcs(b2_p1, b2_p2), b2_amp, b2_p1, b2_p2)

    d1 = _densify_daily(rec1); d2 = _densify_daily(rec2)
    if d1 is None or d2 is None:
        log.warning("APCC BSISO parse produced 0 records — keeping existing")
        return None
    log.info("APCC BSISO: %d days (%s → %s)",
             len(d1["phases"]), d1["start_date"], d1["end_date"])
    return {"bsiso1": d1, "bsiso2": d2}


def _fetch_noaa_romi():
    """Fetch NOAA PSL ROMI (Real-time OLR-based MJO Index — the modern
    replacement for OMI). Returns dict with same array fields."""
    try:
        r = requests.get(_NOAA_ROMI_URL, timeout=60)
        r.raise_for_status()
        text = r.text
    except Exception as e:
        log.warning("NOAA ROMI fetch failed: %s — keeping existing series", e)
        return None

    records = {}
    for line in text.splitlines():
        parts = line.split()
        # YYYY MM DD HH PC1 PC2 amp
        if len(parts) < 7 or not parts[0].isdigit():
            continue
        try:
            yr = int(parts[0]); mo = int(parts[1]); dy = int(parts[2])
            if yr < 1979 or yr > 2100:
                continue
            pc1 = float(parts[4]); pc2 = float(parts[5])
            amp = float(parts[6])
        except (ValueError, IndexError):
            continue
        records[f"{yr:04d}-{mo:02d}-{dy:02d}"] = (_phase_from_pcs(pc1, pc2),
                                                  amp, pc1, pc2)

    out = _densify_daily(records)
    if out is None:
        log.warning("NOAA ROMI parse produced 0 records — keeping existing")
        return None
    log.info("NOAA ROMI: %d days (%s → %s)",
             len(out["phases"]), out["start_date"], out["end_date"])
    return out


def refresh_indices() -> bool:
    """Daily refresh of MJO RMM / BSISO1 / BSISO2 / ROMI. Each source
    is independent: any single failure leaves the existing series in
    place and the merged JSON still uploads (so a temporary BOM
    blackhole doesn't lose the BSISO refresh).

    Note: the bundled JSON key 'mjo_omi' is REPLACED in-place with
    fresh ROMI data + ROMI metadata (NOAA stopped updating OMI in
    May 2024). The frontend keeps the same key so no UI change needed.
    """
    log.info("=== Refreshing subseasonal indices ===")
    base = _load_baseline_indices()
    base.setdefault("indices", {})

    rmm = _fetch_bom_rmm()
    if rmm:
        base["indices"].setdefault("mjo", {})
        base["indices"]["mjo"].update(rmm)

    bsiso = _fetch_apcc_bsiso()
    if bsiso:
        for k, payload in bsiso.items():
            base["indices"].setdefault(k, {})
            base["indices"][k].update(payload)

    romi = _fetch_noaa_romi()
    if romi:
        # Migrate the 'mjo_omi' slot to ROMI in place. Update the
        # provider metadata so the frontend tooltip stays accurate.
        slot = base["indices"].setdefault("mjo_omi", {})
        slot.update(romi)
        slot["label"] = "MJO (ROMI)"
        slot["long_name"] = "Madden-Julian Oscillation, Real-time OLR-based MJO Index"
        slot["description"] = (
            "Real-time OLR-based MJO Index (ROMI) — Kiladis et al. (2014). "
            "Daily-updated successor to OMI (which NOAA PSL stopped "
            "refreshing in May 2024). 8 phases derived from (PC1, PC2)."
        )
        slot["provider"] = "NOAA PSL"
        slot["provider_url"] = "https://psl.noaa.gov/mjo/mjoindex/"
        slot["source"] = _NOAA_ROMI_URL
        slot["paper"] = "Kiladis et al. 2014, MWR"
        slot["paper_url"] = "https://doi.org/10.1175/MWR-D-13-00301.1"

    base["updated"] = datetime.now(timezone.utc).date().isoformat()

    # Upload to GCS for the climatology page to fetch.
    try:
        from google.cloud import storage
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET)
        blob = bucket.blob(INDICES_GCS_PATH)
        body = json.dumps(base, separators=(",", ":"))
        blob.upload_from_string(body, content_type="application/json")
        blob.cache_control = "public, max-age=600"
        blob.patch()
        try:
            blob.make_public()
        except Exception as e:
            log.warning("indices blob make_public failed: %s", e)
        log.info("Uploaded indices to gs://%s/%s (%d bytes)",
                 GCS_BUCKET, INDICES_GCS_PATH, len(body))
        return True
    except Exception as e:
        log.exception("Index JSON upload failed: %s", e)
        return False


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def emit_cost_telemetry(duration_s: float) -> None:
    """Emit a structured log line with the run's compute usage + estimated
    cost (USD), so monthly Cloud Run spend can be summed from logs without
    needing to scrape the billing console.

    Reads provisioned resources from the CR_VCPU / CR_MEM_GIB env vars
    (set in deploy_subseasonal_job.sh / deploy_env_job.sh). Pricing
    constants below match Cloud Run Jobs tier-1 zones as of 2026-05.
    Aggregate via:
      gcloud logging read \\
          'resource.type=cloud_run_job AND textPayload:"cost_telemetry"' \\
          --freshness=30d --format='value(textPayload)' \\
          | awk -F'est_cost_usd=' '{print $2}' \\
          | awk '{s+=$1} END {printf "$%.2f\\n", s}'
    """
    import os as _os
    PRICE_VCPU_PER_S  = 0.000024     # USD per vCPU-second
    PRICE_MEM_PER_S   = 0.0000025    # USD per GiB-second
    vcpu = float(_os.environ.get("CR_VCPU", "1"))
    mem_gib = float(_os.environ.get("CR_MEM_GIB", "1"))
    cost = duration_s * (vcpu * PRICE_VCPU_PER_S + mem_gib * PRICE_MEM_PER_S)
    log.info(
        "cost_telemetry script=%s duration_s=%.1f vcpu=%s mem_gib=%s est_cost_usd=%.5f",
        "build_subseasonal_overlays", duration_s, vcpu, mem_gib, cost,
    )


def main():
    import time as _time
    _t0 = _time.time()

    parser = argparse.ArgumentParser(description="Build subseasonal forcing overlays.")
    parser.add_argument("--out", default="data/subseasonal_overlays",
                        help="Local output directory.")
    parser.add_argument("--cache", default="data/_olr_cache",
                        help="Climatology cache directory.")
    parser.add_argument("--date", default=None,
                        help="Override 'today' (ISO date). Default: latest in OPeNDAP.")
    parser.add_argument("--local-only", action="store_true",
                        help="Skip GCS upload. Outputs to --out only.")
    parser.add_argument("--skip-indices", action="store_true",
                        help="Skip the daily MJO/BSISO/ROMI index refresh "
                             "(useful for local OLR-only iteration).")
    parser.add_argument("--indices-only", action="store_true",
                        help="ONLY refresh the indices; skip the OLR + WK "
                             "filtering pipeline (fast smoke test).")
    parser.add_argument("--no-forecast", action="store_true",
                        help="Skip the GEFS OLR forecast extension of the "
                             "Hovmöller (observed-only).")
    args = parser.parse_args()

    # Daily index refresh runs alongside the OLR overlays so the
    # 13:30 UTC scheduler covers everything in one pass.
    if not args.local_only and not args.skip_indices:
        try:
            refresh_indices()
        except Exception as e:
            log.exception("refresh_indices() crashed: %s", e)

    if args.indices_only:
        log.info("--indices-only: skipping OLR pipeline")
        return 0

    out_dir = Path(args.out)
    cache_dir = Path(args.cache)
    if args.date:
        today = datetime.fromisoformat(args.date).replace(tzinfo=timezone.utc)
    else:
        today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    log.info("Building subseasonal overlays for %s", today.date())

    window = fetch_olr_window(today)
    # Trim 'today' to the last available timestep (OPeNDAP may lag a day or two)
    last_time = window.time.values[-1]
    valid_time_iso = str(np.datetime64(last_time, "D"))
    log.info("Latest available OLR: %s", valid_time_iso)

    climo = daily_climatology(today, cache_dir)
    anom = daily_anomaly(window, climo)

    sym, asym = symmetric_antisymmetric(anom)

    # GEFS forecast extension — used ONLY for the separate forecast
    # Hovmöller artifact (hovmoller_fcst.json). The map PNG, GeoJSON, and
    # the observed hovmoller.json are computed from the observed-only
    # series above and are intentionally left untouched, so the env-layer
    # overlay and the default Hovmöller are stable regardless of forecast
    # availability. Any failure here degrades to observed-only.
    n_forecast = 0
    sym_ext = asym_ext = anom_ext = None
    if not args.no_forecast:
        try:
            import xarray as xr
            fcst_olr = fetch_gefs_olr_forecast(today, window.lat, window.lon)
            if fcst_olr is not None and fcst_olr.sizes["time"] > 0:
                fcst_anom = daily_anomaly(fcst_olr, climo)
                anom_ext = xr.concat([anom, fcst_anom], dim="time")
                n_forecast = int(fcst_anom.sizes["time"])
                sym_ext, asym_ext = symmetric_antisymmetric(anom_ext)
                log.info("GEFS forecast appended to Hovmöller: +%d days",
                         n_forecast)
        except Exception as e:
            log.exception("GEFS forecast extension failed; observed-only: %s", e)
            n_forecast = 0

    lats = anom.lat.values
    lons = anom.lon.values
    # Bounds match the rendered (Mercator-warped) PNG so L.imageOverlay
    # aligns the image correctly on the Mercator basemap. The underlying
    # data covers ±90° but the warp truncates to ±WEB_MERC_LAT_MAX. The
    # array shape [[south, west], [north, east]] matches what the RT
    # Monitor's env-layer activation reads directly from layer.bounds.
    bounds = [[-WEB_MERC_LAT_MAX, -180.0], [WEB_MERC_LAT_MAX, 180.0]]

    for spec in WAVE_SPECS:
        log.info("--- Building %s overlay ---", spec.name)
        if spec.component == "raw":
            src = anom
        elif spec.component == "sym":
            src = sym
        else:
            src = asym

        if spec.component == "raw":
            filtered = src
        else:
            filtered = wk_filter(src, spec)
            # Confine each band to its theoretical meridional eigenstructure
            # (parabolic cylinder function). Suppresses the spurious
            # extratropical contour bullseyes that pure (k, ω) WK filtering
            # leaves behind for equatorially-trapped modes.
            filtered = apply_pcf_projection(filtered, spec)

        latest = filtered.isel(time=-1).values
        png = render_png(latest, lats, lons, spec)
        # Contour layers also emit a GeoJSON sidecar so the frontend's
        # L.geoJSON path can draw crisp vector polylines + value labels
        # (same treatment as the other env-layer contours like shear).
        geojson = None
        if spec.render_style == "contour":
            try:
                geojson = render_contour_geojson(latest, lats, lons, spec)
            except Exception as e:
                log.warning("GeoJSON contour render failed for %s: %s", spec.name, e)

        # Hovmöller slab (60d × 3 lat-bands) for the RT Monitor's
        # Subseasonal tab. Built from the same WK-filtered field that
        # feeds the latest-timestep PNG — no extra FFT cost.
        hov_slab = None
        try:
            hov_slab = build_hovmoller_slab(filtered, spec, valid_time_iso)
        except Exception as e:
            log.warning("Hovmöller build failed for %s: %s", spec.name, e)

        # Forecast Hovmöller — same WK filter + PCF projection re-run on the
        # observed+GEFS extended anomaly series so the wave bands (and thus
        # their contours) extend cleanly across the forecast window. Written
        # as a SEPARATE artifact so the observed-only hovmoller.json stays
        # byte-identical; the frontend opts in when the GEFS toggle is on.
        hov_fcst = None
        if n_forecast > 0:
            try:
                if spec.component == "raw":
                    filtered_ext = anom_ext
                elif spec.component == "sym":
                    filtered_ext = apply_pcf_projection(
                        wk_filter(sym_ext, spec), spec)
                else:
                    filtered_ext = apply_pcf_projection(
                        wk_filter(asym_ext, spec), spec)
                hov_fcst = build_hovmoller_slab(
                    filtered_ext, spec, valid_time_iso, n_forecast=n_forecast)
            except Exception as e:
                log.warning("Forecast Hovmöller build failed for %s: %s",
                            spec.name, e)

        write_local(out_dir, spec, png, valid_time_iso, bounds)
        if geojson:
            (out_dir / f"{spec.name}.geojson").write_bytes(geojson)
        if hov_slab:
            write_hovmoller_local(out_dir, spec, hov_slab)
        if hov_fcst:
            write_hovmoller_local(out_dir, spec, hov_fcst,
                                  filename="hovmoller_fcst.json")
        log.info("  wrote %s.png (%d bytes)%s%s%s",
                 spec.name, len(png),
                 f" + .geojson ({len(geojson)} bytes)" if geojson else "",
                 " + .hovmoller.json" if hov_slab else "",
                 f" + .hovmoller_fcst.json (+{n_forecast}d)" if hov_fcst else "")
        if not args.local_only:
            try:
                upload_gcs(spec, png, valid_time_iso, bounds, geojson=geojson)
            except Exception as e:
                log.exception("GCS upload failed for %s: %s", spec.name, e)
            if hov_slab:
                try:
                    upload_hovmoller_gcs(spec, hov_slab)
                except Exception as e:
                    log.exception("Hovmöller GCS upload failed for %s: %s",
                                  spec.name, e)
            if hov_fcst:
                try:
                    upload_hovmoller_gcs(spec, hov_fcst,
                                         filename="hovmoller_fcst.json")
                except Exception as e:
                    log.exception("Forecast Hovmöller GCS upload failed for "
                                  "%s: %s", spec.name, e)

    log.info("Done. Outputs in %s%s",
             out_dir, "" if args.local_only else f" + gs://{GCS_BUCKET}/{GCS_PREFIX}/")

    emit_cost_telemetry(_time.time() - _t0)


if __name__ == "__main__":
    sys.exit(main() or 0)
