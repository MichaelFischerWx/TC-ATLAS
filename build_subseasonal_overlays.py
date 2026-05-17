"""Build real-time subseasonal forcing overlays for the RT Monitor.

For each canonical convectively-coupled tropical wave type, renders a
global PNG of the *filtered* OLR anomaly (W/m²) at today's date:

    - "anomaly"  : raw daily OLR anomaly  (= today − climatology)
    - "mjo"      : MJO-band filtered      (k=1..5 east,  period 30–96 d)
    - "kelvin"   : Kelvin-wave filtered   (k=1..14 east, h=8–90 m, sym)
    - "er"       : Equatorial Rossby n=1  (k=−1..−10,    period 9–72 d, sym)
    - "mrg"      : Mixed Rossby–Gravity   (period 3–8 d, anti-symmetric)

Negative anomaly = enhanced convection (suppressed OLR). Diverging
colormap: blue = enhanced convection, red = suppressed.

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
    # Wheeler-Kiladis convention: BLUE = active convection (negative OLR
    # anomaly, cold cloud tops), RED = suppressed (positive anomaly, dry/warm).
    # Matplotlib's "RdBu_r" delivers this orientation: r → swap so the
    # low end is blue and the high end is red.
    cmap: str = "RdBu_r"
    # Rendering mode. "filled" = diverging color shading (good for the
    # raw OLR anomaly, which spans 60+ W/m² with broad structure).
    # "contour" = symmetric pos/neg isolines on a transparent background
    # (right call for WK-filtered band products because their natural
    # amplitude is small, equatorially-trapped, and obscured under a
    # filled colormap). Per-band contour levels are listed below.
    render_style: str = "filled"
    # Contour levels in W/m². Symmetric pos/neg pairs (so -L, +L); the
    # renderer draws negative levels in blue and positive in red,
    # thickness scaling with magnitude. Used only when render_style ==
    # "contour".
    contour_levels: Optional[list] = None


WAVE_SPECS = [
    WaveSpec(
        name="anomaly",
        title="OLR Anomaly",
        description="Daily OLR anomaly vs 1991-2020 climatology. "
                    "Negative (blue) = suppressed OLR = enhanced deep convection. "
                    "Contours every 10 W/m².",
        component="raw",
        vmin=-60.0, vmax=60.0,
        cmap="RdBu_r",
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
                    "(blue) and suppressed (red) convection should be "
                    "visible across the Indo-Pacific.",
        component="sym",
        k_lo=1, k_hi=5,
        freq_lo=1.0 / 96.0, freq_hi=1.0 / 30.0,
        vmin=-15.0, vmax=15.0,
        render_style="contour",
        contour_levels=[-12, -9, -6, -3, 3, 6, 9, 12],
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
    ),
    WaveSpec(
        name="er",
        title="Equatorial Rossby (n=1) OLR",
        description="Wheeler-Kiladis ER band — westward wavenumbers 1-10, "
                    "period 9-72 d, equivalent depth h = 8-90 m (phase speed "
                    "c ≈ 9-30 m/s westward), n=1 Rossby branch, symmetric "
                    "component. Contours every 2 W/m².",
        component="sym",
        k_lo=-10, k_hi=-1,
        # 9-72 d period range — standard ER n=1 specification.
        freq_lo=1.0 / 72.0, freq_hi=1.0 / 9.0,
        h_lo=8.0, h_hi=90.0,
        vmin=-10.0, vmax=10.0,
        render_style="contour",
        contour_levels=[-8, -6, -4, -2, 2, 4, 6, 8],
    ),
    WaveSpec(
        name="mrg",
        title="Mixed Rossby-Gravity / TD-type OLR",
        description="Wheeler-Kiladis MRG band — westward wavenumbers 1-10, "
                    "period 3-8 d, anti-symmetric component. Often the "
                    "direct WPac / Atlantic TC genesis trigger. Contours "
                    "every 2 W/m²; MRG amplitudes are typically ±2-6 W/m².",
        component="asym",
        k_lo=-10, k_hi=-1,
        freq_lo=1.0 / 8.0, freq_hi=1.0 / 3.0,
        vmin=-6.0, vmax=6.0,
        render_style="contour",
        contour_levels=[-6, -4, -2, 2, 4, 6],
    ),
]


# --------------------------------------------------------------------------
# Data fetch
# --------------------------------------------------------------------------

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
    ds = xr.open_dataset(OPENDAP_URL)
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
    ds = xr.open_dataset(OPENDAP_URL)
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

    # Taper the time series with a Hanning window at each end (10% per
    # end) to reduce spectral leakage from the finite record. Mean is
    # removed before FFT so taper doesn't bias the low-freq bin.
    arr = arr - np.nanmean(arr, axis=0, keepdims=True)
    taper = np.ones(nt)
    n_taper = max(2, int(0.10 * nt))
    half = np.hanning(2 * n_taper)
    taper[:n_taper] = half[:n_taper]
    taper[-n_taper:] = half[-n_taper:]
    arr = arr * taper[:, None, None]

    # FFT in (time, lon). real → complex.
    # Convention: positive frequency = eastward wavenumber × positive
    # time-frequency. Using numpy's standard FFT, fft2 yields k indices
    # 0..nx/2 for positive (eastward) wavenumbers, then nx-1 .. nx/2+1
    # for negative (westward). Same idea on the freq axis.
    F = np.fft.fft2(arr, axes=(0, 2))

    # Wavenumber and frequency coordinates
    freq = np.fft.fftfreq(nt, d=1.0)         # cycles per day, time spacing 1 d
    k    = np.fft.fftfreq(nx, d=1.0/nx)      # zonal wavenumber (cycles around globe)
    # Build mask in (time-freq, lon-wavenumber) space, broadcast over lat
    mask = np.zeros((nt, nx), dtype=bool)

    # Wavenumber filter
    if spec.k_lo is not None and spec.k_hi is not None:
        # Match k values that fall in [k_lo, k_hi].
        kk = np.round(k).astype(int)
        k_in = (kk >= spec.k_lo) & (kk <= spec.k_hi)
    else:
        k_in = np.ones_like(k, dtype=bool)

    # Frequency filter (either freq range or h-equivalent-depth range).
    # WK convention: eastward waves have ω > 0 with k > 0, westward have
    # ω > 0 with k < 0. We work with the magnitude of ω here since the
    # dispersion curves are symmetric about ω = 0.
    omega = np.abs(freq)

    if spec.freq_lo is not None and spec.freq_hi is not None:
        f_in_basic = (omega >= spec.freq_lo) & (omega <= spec.freq_hi)
    else:
        f_in_basic = np.ones_like(freq, dtype=bool)

    # Build the 2-D mask.
    for ti, freq_i in enumerate(freq):
        if not f_in_basic[ti]:
            continue
        for xi, k_i in enumerate(k):
            if not k_in[xi]:
                continue
            keep = True
            # Optional h-equivalent-depth gate (Kelvin / ER dispersion).
            if spec.h_lo is not None and spec.h_hi is not None:
                # Dispersion: ω = sqrt(g*h) * k_phys, where k_phys is in
                # rad/m, ω in rad/s. Convert our k (cycles per globe)
                # and freq (cyc/day) to rad/m and rad/s respectively.
                a = 6.371e6
                k_rad_m = (k_i * 2 * np.pi) / (2 * np.pi * a)   # = k_i / a
                omega_rad_s = (freq_i * 2 * np.pi) / 86400.0
                # For positive k (eastward Kelvin): c = ω/k = sqrt(g*h).
                # For ER (k < 0, n=1 Rossby branch), the dispersion is
                # nonlinear: ω = −β*k / (k² + (2n+1)*β/c). Use simplified
                # h-gate by computing c from c² = (ω/k)² for Kelvin, or
                # via the Rossby branch fit for ER.
                if k_i == 0:
                    keep = False
                elif spec.name == "kelvin":
                    # Kelvin: c = ω / k (positive k, positive ω)
                    if k_i > 0 and freq_i > 0:
                        c = omega_rad_s / k_rad_m
                        h = (c * c) / g
                        keep = (spec.h_lo <= h <= spec.h_hi)
                    else:
                        keep = False
                elif spec.name == "er":
                    # n=1 ER (westward): use Roundy & Frank 2004 approx
                    # ω ≈ −β k / (k² + 3β/c). Test if the (k, ω) point
                    # is close to the dispersion curve for any c in
                    # [c_lo, c_hi] where c = sqrt(g*h).
                    if k_i < 0 and freq_i > 0:
                        beta = 2 * 7.292e-5 / a            # ≈ 2.29e-11 m⁻¹s⁻¹
                        c_lo = np.sqrt(g * spec.h_lo)
                        c_hi = np.sqrt(g * spec.h_hi)
                        # Solve for h that puts this (k, ω) on dispersion
                        # ω = −β k / (k² + 3β/c). For ω>0, k<0, rearrange:
                        # 3β/c = −β k/ω − k² → c = 3β / (−β k/ω − k²)
                        denom = (-beta * k_rad_m / omega_rad_s
                                 - k_rad_m * k_rad_m)
                        if denom > 0:
                            c = 3 * beta / denom
                            h = (c * c) / g
                            keep = (spec.h_lo <= h <= spec.h_hi)
                        else:
                            keep = False
                    else:
                        keep = False
                else:
                    keep = False
            mask[ti, xi] = keep

    log.info("  WK mask for %s: %d / %d (k×ω) cells active",
             spec.name, mask.sum(), mask.size)

    F_filtered = F * mask[:, None, :]
    out = np.real(np.fft.ifft2(F_filtered, axes=(0, 2)))
    # Un-taper would distort the signal asymmetrically; the canonical
    # WK output keeps the tapered amplitude. Frontend doesn't need un-tapering
    # because we use a fixed colormap, not absolute amplitude.
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
    Negative (active convection) draws in blue, positive (suppressed)
    in red. Stroke width scales with magnitude — weak ±2 envelopes
    thinner than strong ±8 ones.
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
        if L < 0:
            r = int(round(96  * (1 - mag) +   8 * mag))
            g = int(round(165 * (1 - mag) +  64 * mag))
            b = int(round(250 * (1 - mag) + 142 * mag))
        else:
            r = int(round(248 * (1 - mag) + 153 * mag))
            g = int(round(113 * (1 - mag) +  17 * mag))
            b = int(round(113 * (1 - mag) +  21 * mag))
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
    if L < 0:
        r = int(round( 96 * (1 - mag) +   8 * mag))
        g = int(round(165 * (1 - mag) +  64 * mag))
        b = int(round(250 * (1 - mag) + 142 * mag))
    else:
        r = int(round(248 * (1 - mag) + 153 * mag))
        g = int(round(113 * (1 - mag) +  17 * mag))
        b = int(round(113 * (1 - mag) +  21 * mag))
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
        write_local(out_dir, spec, png, valid_time_iso, bounds)
        if geojson:
            (out_dir / f"{spec.name}.geojson").write_bytes(geojson)
        log.info("  wrote %s.png (%d bytes)%s",
                 spec.name, len(png),
                 f" + .geojson ({len(geojson)} bytes)" if geojson else "")
        if not args.local_only:
            try:
                upload_gcs(spec, png, valid_time_iso, bounds, geojson=geojson)
            except Exception as e:
                log.exception("GCS upload failed for %s: %s", spec.name, e)

    log.info("Done. Outputs in %s%s",
             out_dir, "" if args.local_only else f" + gs://{GCS_BUCKET}/{GCS_PREFIX}/")

    emit_cost_telemetry(_time.time() - _t0)


if __name__ == "__main__":
    sys.exit(main() or 0)
