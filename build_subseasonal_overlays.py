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


WAVE_SPECS = [
    WaveSpec(
        name="anomaly",
        title="OLR Anomaly",
        description="Daily OLR anomaly vs 1991-2020 climatology. "
                    "Negative (blue) = suppressed OLR = enhanced deep convection.",
        component="raw",
        vmin=-60.0, vmax=60.0,
        cmap="RdBu_r",
    ),
    WaveSpec(
        name="mjo",
        title="MJO-filtered OLR",
        description="Wheeler-Kiladis MJO band — eastward wavenumbers 1-5, "
                    "period 30-96 d, symmetric component.",
        component="sym",
        k_lo=1, k_hi=5,
        freq_lo=1.0 / 96.0, freq_hi=1.0 / 30.0,
        vmin=-25.0, vmax=25.0,
    ),
    WaveSpec(
        name="kelvin",
        title="Kelvin-wave filtered OLR",
        description="Wheeler-Kiladis Kelvin band — eastward wavenumbers 1-14, "
                    "equivalent depth 8-90 m, symmetric component. "
                    "Active envelopes propagate eastward at ~12-25 m/s.",
        component="sym",
        k_lo=1, k_hi=14,
        h_lo=8.0, h_hi=90.0,
        vmin=-25.0, vmax=25.0,
    ),
    WaveSpec(
        name="er",
        title="Equatorial Rossby (n=1) OLR",
        description="Wheeler-Kiladis ER band — westward wavenumbers 1-10, "
                    "equivalent depth 8-90 m, n=1 Rossby branch, symmetric component.",
        component="sym",
        k_lo=-10, k_hi=-1,
        h_lo=8.0, h_hi=90.0,
        vmin=-20.0, vmax=20.0,
    ),
    WaveSpec(
        name="mrg",
        title="Mixed Rossby-Gravity / TD-type OLR",
        description="Wheeler-Kiladis MRG band — westward wavenumbers 1-10, "
                    "period 3-8 d, anti-symmetric component. Often the "
                    "direct WPac / Atlantic TC genesis trigger.",
        component="asym",
        k_lo=-10, k_hi=-1,
        freq_lo=1.0 / 8.0, freq_hi=1.0 / 3.0,
        vmin=-20.0, vmax=20.0,
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


def render_png(field2d: np.ndarray, lats: np.ndarray, lons: np.ndarray,
               spec: WaveSpec) -> bytes:
    """Render a 2D field as a Mercator-warped global PNG.

    Output is a global image in Web Mercator pixel-space (lat range
    ±85.05°) with transparent background. The metadata bounds returned
    by the caller must match (±WEB_MERC_LAT_MAX, ±180°) for L.imageOverlay
    to align correctly on the Mercator basemap. Returns PNG bytes.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import TwoSlopeNorm

    # Reorder lat to N→S (the convention _warp_eq_to_mercator expects)
    lat_order = np.argsort(-lats)
    field2d = field2d[lat_order, :]
    # Shift longitude to [-180, 180] from [0, 360]
    lon_order = np.argsort(((lons + 180) % 360) - 180)
    field2d = field2d[:, lon_order]

    # Apply Mercator warp so the PNG is geographically aligned when
    # CSS-stretched between ±WEB_MERC_LAT_MAX, ±180° corners by Leaflet.
    warped = _warp_eq_to_mercator(field2d)

    fig = plt.figure(figsize=(NX / 100, NY / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    norm = TwoSlopeNorm(vcenter=0.0, vmin=spec.vmin, vmax=spec.vmax)
    # Rows are now top→bottom = +MAX_LAT → -MAX_LAT. imshow's default
    # origin='upper' matches that, so no flip needed.
    ax.imshow(
        warped,
        cmap=spec.cmap,
        norm=norm,
        extent=[-180, 180, -WEB_MERC_LAT_MAX, WEB_MERC_LAT_MAX],
        origin="upper",
        interpolation="bilinear",
        aspect="auto",
    )
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, bbox_inches="tight",
                pad_inches=0)
    plt.close(fig)
    return buf.getvalue()


GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
GCS_PREFIX = "subseasonal"   # gs://{bucket}/{prefix}/{wave}/{latest.png|metadata.json}


def _meta_dict(spec: WaveSpec, valid_time: str, bounds: list,
               image_url: Optional[str] = None) -> dict:
    """Shared metadata payload for both local + GCS outputs. The frontend
    reads metadata.json to learn the public PNG URL, colorbar range,
    valid date, and bounds for L.imageOverlay."""
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
        "bounds": bounds,
    }
    if image_url:
        d["image_url"] = image_url
    return d


def write_local(out_dir: Path, spec: WaveSpec, png: bytes, valid_time: str,
                bounds: list):
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{spec.name}.png").write_bytes(png)
    meta = _meta_dict(spec, valid_time, bounds)
    (out_dir / f"{spec.name}.json").write_text(json.dumps(meta, indent=2))


def upload_gcs(spec: WaveSpec, png: bytes, valid_time: str, bounds: list) -> bool:
    """Upload latest.png + metadata.json to
        gs://{GCS_BUCKET}/{GCS_PREFIX}/{spec.name}/

    Mirrors the pattern of build_env_overlays.upload_layer. Returns
    True on success. Cloud Run Job credentials are picked up via the
    google-cloud-storage default chain.
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
    png_blob  = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest.png")
    meta_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/metadata.json")

    image_url = (f"https://storage.googleapis.com/{GCS_BUCKET}/"
                 f"{GCS_PREFIX}/{spec.name}/latest.png")
    meta = _meta_dict(spec, valid_time, bounds, image_url=image_url)

    png_blob.cache_control = "public, max-age=600"
    png_blob.upload_from_string(png, content_type="image/png")

    meta_blob.cache_control = "public, max-age=600"
    meta_blob.upload_from_string(json.dumps(meta), content_type="application/json")

    log.info("  uploaded gs://%s/%s/%s/{latest.png,metadata.json}",
             GCS_BUCKET, GCS_PREFIX, spec.name)
    return True


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Build subseasonal forcing overlays.")
    parser.add_argument("--out", default="data/subseasonal_overlays",
                        help="Local output directory.")
    parser.add_argument("--cache", default="data/_olr_cache",
                        help="Climatology cache directory.")
    parser.add_argument("--date", default=None,
                        help="Override 'today' (ISO date). Default: latest in OPeNDAP.")
    parser.add_argument("--local-only", action="store_true",
                        help="Skip GCS upload. Outputs to --out only.")
    args = parser.parse_args()

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
        write_local(out_dir, spec, png, valid_time_iso, bounds)
        log.info("  wrote %s.png (%d bytes)", spec.name, len(png))
        if not args.local_only:
            try:
                upload_gcs(spec, png, valid_time_iso, bounds)
            except Exception as e:
                log.exception("GCS upload failed for %s: %s", spec.name, e)

    log.info("Done. Outputs in %s%s",
             out_dir, "" if args.local_only else f" + gs://{GCS_BUCKET}/{GCS_PREFIX}/")


if __name__ == "__main__":
    sys.exit(main() or 0)
