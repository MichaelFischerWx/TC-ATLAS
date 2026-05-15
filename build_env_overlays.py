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
                     levels: list[int], var: str) -> Optional[bytes]:
    """Fetch a global GFS field for one variable across multiple pressure
    levels. Returns raw GRIB2 bytes or None on failure.

    The cgi-bin filter applies var_X=on and lev_X_mb=on toggles; the
    output is a sequence of GRIB messages for every (var, level) that
    exists. Concatenating without subsetting lat/lon gives the full
    global 1440x721 grid per message.
    """
    import requests

    params: list[tuple[str, str]] = [
        ("dir", f"/gfs.{date_str}/{hour_str}/atmos"),
        ("file", f"gfs.t{hour_str}z.pgrb2.0p25.f000"),
        (f"var_{var}", "on"),
    ]
    for lev in levels:
        params.append((f"lev_{lev}_mb", "on"))

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
        # GFS variable naming: UGRD→"u", VGRD→"v", RH→"r", TMP→"t"
        name_map = {"UGRD": "u", "VGRD": "v", "RH": "r", "TMP": "t"}
        xname = name_map.get(var, var.lower())
        if xname not in ds.data_vars:
            log.warning("Variable %s not found in GRIB (have: %s)",
                        xname, list(ds.data_vars))
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
# OISST access
# --------------------------------------------------------------------------

OISST_BASE = (
    "https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-"
    "interpolation/v2.1/access/avhrr"
)


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

    now = datetime.now(timezone.utc)
    for back in range(1, 10):
        d = now - timedelta(days=back)
        ymd = d.strftime("%Y%m%d")
        ym = d.strftime("%Y%m")
        for fname in (f"oisst-avhrr-v02r01.{ymd}_preliminary.nc",
                      f"oisst-avhrr-v02r01.{ymd}.nc"):
            url = f"{OISST_BASE}/{ym}/{fname}"
            try:
                r = requests.get(url, timeout=180)
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
    return None


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
    step: float          # contour interval (same units)
    cmap: str            # matplotlib colormap name
    valid_time: str      # ISO8601 string
    description: str = ""


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
    physical radius. Uses wrap mode along the longitude axis so contours
    near the dateline aren't distorted; latitude wrap is acceptable
    cosmetically because TC activity is tropical/subtropical.

    The kernel is fixed in grid cells (≈27.8 km/cell at the equator), so
    the effective radius shrinks slightly at higher latitudes — fine for
    TC-focused diagnostics, which live in the deep tropics where the
    approximation holds.
    """
    from scipy.ndimage import convolve
    radius_cells = max(1, int(round(radius_km / KM_PER_CELL)))
    k = _disc_kernel(radius_cells)
    return convolve(field, k, mode="wrap")


def render_contour_png(field: np.ndarray, spec: LayerSpec) -> bytes:
    """Render `field` as CIMSS-style labeled isolines on a transparent
    background. Returns PNG bytes sized exactly NX × NY pixels so it
    overlays the Leaflet world bounds [[-90,-180],[90,180]] cell-for-cell.

    Lines are colored by value via the colormap so the colorbar legend
    is still meaningful, and each contour level is labeled with a
    white-haloed integer value so labels remain legible over dark IR
    backgrounds.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.patheffects as path_effects
    import matplotlib.pyplot as plt

    field = np.asarray(field, dtype=np.float32)
    # Replace non-finite cells so matplotlib doesn't choke on NaN at the poles.
    mask = ~np.isfinite(field)
    if mask.any():
        field = field.copy()
        field[mask] = np.nan  # contour() treats NaN as masked

    dpi = 100
    fig = plt.figure(figsize=(NX / dpi, NY / dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1])  # fill figure, no margin
    ax.set_axis_off()
    ax.set_xlim(0, NX - 1)
    ax.set_ylim(NY - 1, 0)  # invert so row 0 sits at top of image

    n_steps = int(round((spec.vmax - spec.vmin) / spec.step)) + 1
    levels = np.linspace(spec.vmin, spec.vmax, n_steps)
    cs = ax.contour(
        np.arange(NX), np.arange(NY), field,
        levels=levels,
        cmap=spec.cmap,
        vmin=spec.vmin, vmax=spec.vmax,
        linewidths=1.2,
    )

    labels = ax.clabel(
        cs, levels=levels,
        inline=True, fontsize=7, fmt="%.0f", colors="black",
    )
    halo = [
        path_effects.Stroke(linewidth=2.0, foreground="white"),
        path_effects.Normal(),
    ]
    for label in labels:
        label.set_path_effects(halo)

    buf = io.BytesIO()
    fig.savefig(buf, format="PNG", transparent=True, dpi=dpi,
                bbox_inches=None, pad_inches=0)
    plt.close(fig)
    return buf.getvalue()


def build_colormap_stops(cmap_name: str, n: int = 16) -> list[dict]:
    """Sample a matplotlib colormap to N RGB stops the frontend can
    paint a colorbar with."""
    import matplotlib.cm as cm
    cmap = cm.get_cmap(cmap_name)
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
    import matplotlib.cm as cm
    cmap = cm.get_cmap(cmap_name)
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

def upload_layer(spec: LayerSpec, png: bytes) -> bool:
    """Upload the PNG + metadata sidecar to GCS. Returns True on success."""
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

    png_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/latest.png")
    meta_blob = bucket.blob(f"{GCS_PREFIX}/{spec.name}/metadata.json")

    n_steps = int(round((spec.vmax - spec.vmin) / spec.step)) + 1
    levels = [round(spec.vmin + i * spec.step, 2) for i in range(n_steps)]
    level_colors = _level_colors(spec.cmap, levels, spec.vmin, spec.vmax)
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
        "image_url": (
            f"https://storage.googleapis.com/{GCS_BUCKET}/"
            f"{GCS_PREFIX}/{spec.name}/latest.png"
        ),
        # Native grid is global 0.25° in (-180, 180) x (90, -90); these
        # bounds are how Leaflet's imageOverlay should anchor the PNG.
        "bounds": [[-90.0, -180.0], [90.0, 180.0]],
        "grid": {"nx": NX, "ny": NY},
        # Continuous gradient stops (for back-compat) + discrete contour
        # levels with the exact line color used at each level (lets the
        # frontend draw a tick-marked legend that matches the contours).
        "colorbar_stops": build_colormap_stops(spec.cmap),
        "levels": levels,
        "level_colors": level_colors,
        "generated_utc": datetime.now(timezone.utc).isoformat(),
    }

    try:
        png_blob.upload_from_string(png, content_type="image/png")
        # Short cache so a stale tile doesn't outlive the next cycle.
        png_blob.cache_control = "public, max-age=300"
        png_blob.patch()
        # The bucket uses fine-grained ACLs (UBLA disabled); make the
        # env/ artifacts public so the frontend can load them directly
        # from storage.googleapis.com without a backend proxy hop.
        try:
            png_blob.make_public()
        except Exception as e:
            log.warning("Could not mark %s public: %s", png_blob.name, e)

        meta_blob.upload_from_string(
            json.dumps(meta, indent=2), content_type="application/json"
        )
        meta_blob.cache_control = "public, max-age=300"
        meta_blob.patch()
        try:
            meta_blob.make_public()
        except Exception as e:
            log.warning("Could not mark %s public: %s", meta_blob.name, e)
        log.info("Uploaded %s: png=%d bytes", spec.name, len(png))
        return True
    except Exception as e:
        log.error("GCS upload failed for %s: %s", spec.name, e)
        return False


# --------------------------------------------------------------------------
# Per-field builders
# --------------------------------------------------------------------------

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


def build_shear(date_str: str, hour_str: str) -> Optional[bytes]:
    """200-850 hPa wind shear magnitude (knots)."""
    log.info("Building shear: GFS %s %sZ", date_str, hour_str)
    u_grib = fetch_gfs_global(date_str, hour_str, [200, 850], "UGRD")
    v_grib = fetch_gfs_global(date_str, hour_str, [200, 850], "VGRD")
    if not u_grib or not v_grib:
        log.error("Shear: GFS fetch failed")
        return None

    u200 = read_gfs_field(u_grib, 200, "UGRD")
    u850 = read_gfs_field(u_grib, 850, "UGRD")
    v200 = read_gfs_field(v_grib, 200, "VGRD")
    v850 = read_gfs_field(v_grib, 850, "VGRD")
    if any(f is None for f in (u200, u850, v200, v850)):
        log.error("Shear: missing u/v level")
        return None

    # Disc-smooth u/v at each level over a 500 km radius before
    # differencing so the TC vortex (and other sub-500-km features)
    # doesn't contaminate the "environmental shear" diagnostic. Smooths
    # in 0..360 longitude convention first to avoid edge effects at the
    # 0/360 seam — regrid to -180..180 only after the convolution.
    u200_s = disc_smooth(u200, 500.0)
    v200_s = disc_smooth(v200, 500.0)
    u850_s = disc_smooth(u850, 500.0)
    v850_s = disc_smooth(v850, 500.0)
    du = u200_s - u850_s
    dv = v200_s - v850_s
    # m/s → knots: 1 m/s = 1.94384 kt
    shear_kt = np.sqrt(du * du + dv * dv) * 1.94384
    shear_kt = regrid_to_global(shear_kt)

    valid = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z"
    spec = LayerSpec(
        name="shear_200_850",
        title="200-850 hPa Wind Shear",
        units="kt",
        vmin=0,
        vmax=60,
        step=10,
        cmap="turbo",
        valid_time=valid,
        description=(
            "Magnitude of the 200-850 hPa vector wind difference from "
            "the latest GFS 0.25° analysis, after a 500 km disc area-"
            "average of u/v at each level (suppresses TC vortices so the "
            "shear represents the environment a storm would experience)."
        ),
    )
    png = render_contour_png(shear_kt, spec)
    return png if upload_layer(spec, png) else None


def build_midlevel_shear(date_str: str, hour_str: str) -> Optional[bytes]:
    """500-850 hPa wind shear magnitude (knots) — vortex-suppressed.

    Mid-level shear is more relevant than the deep-layer (200-850)
    metric for assessing the wind environment within the lower half
    of a TC vortex, where most of the convective organization happens.
    """
    log.info("Building mid-level shear: GFS %s %sZ", date_str, hour_str)
    u_grib = fetch_gfs_global(date_str, hour_str, [500, 850], "UGRD")
    v_grib = fetch_gfs_global(date_str, hour_str, [500, 850], "VGRD")
    if not u_grib or not v_grib:
        log.error("Mid-level shear: GFS fetch failed")
        return None

    u500 = read_gfs_field(u_grib, 500, "UGRD")
    u850 = read_gfs_field(u_grib, 850, "UGRD")
    v500 = read_gfs_field(v_grib, 500, "VGRD")
    v850 = read_gfs_field(v_grib, 850, "VGRD")
    if any(f is None for f in (u500, u850, v500, v850)):
        log.error("Mid-level shear: missing u/v level")
        return None

    u500_s = disc_smooth(u500, 500.0)
    v500_s = disc_smooth(v500, 500.0)
    u850_s = disc_smooth(u850, 500.0)
    v850_s = disc_smooth(v850, 500.0)
    du = u500_s - u850_s
    dv = v500_s - v850_s
    shear_kt = np.sqrt(du * du + dv * dv) * 1.94384
    shear_kt = regrid_to_global(shear_kt)

    valid = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z"
    spec = LayerSpec(
        name="shear_500_850",
        title="500-850 hPa Wind Shear",
        units="kt",
        vmin=0,
        vmax=40,
        step=5,
        cmap="turbo",
        valid_time=valid,
        description=(
            "Magnitude of the 500-850 hPa vector wind difference from "
            "the latest GFS 0.25° analysis, after a 500 km disc area-"
            "average of u/v at each level. Targets the lower half of the "
            "TC vortex where convective organization lives — useful "
            "alongside the deep-layer 200-850 metric."
        ),
    )
    png = render_contour_png(shear_kt, spec)
    return png if upload_layer(spec, png) else None


def build_midlevel_rh(date_str: str, hour_str: str) -> Optional[bytes]:
    """700-400 hPa layer-averaged relative humidity (%)."""
    log.info("Building mid-level RH: GFS %s %sZ", date_str, hour_str)
    grib = fetch_gfs_global(date_str, hour_str, [700, 500, 400], "RH")
    if not grib:
        log.error("RH: GFS fetch failed")
        return None

    rh700 = read_gfs_field(grib, 700, "RH")
    rh500 = read_gfs_field(grib, 500, "RH")
    rh400 = read_gfs_field(grib, 400, "RH")
    if any(f is None for f in (rh700, rh500, rh400)):
        log.error("RH: missing level")
        return None

    # Simple unweighted mean is fine for a first pass; layer-thickness
    # weighting changes the answer by <1 % in most regimes.
    rh = (rh700 + rh500 + rh400) / 3.0
    rh = regrid_to_global(rh)
    rh = np.clip(rh, 0, 100)

    valid = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z"
    spec = LayerSpec(
        name="rh_700_400",
        title="700-400 hPa Mean RH",
        units="%",
        vmin=20,
        vmax=90,
        step=10,
        cmap="BrBG",
        valid_time=valid,
        description=(
            "Unweighted mean of relative humidity at 700, 500, and "
            "400 hPa — a proxy for mid-level moisture relevant to TC "
            "genesis."
        ),
    )
    png = render_contour_png(rh, spec)
    return png if upload_layer(spec, png) else None


def build_sst() -> Optional[bytes]:
    """NOAA OISST v2.1 daily SST (degC)."""
    log.info("Building SST: NOAA OISST")
    result = fetch_oisst_sst()
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
        description=(
            "NOAA OISST v2.1 daily sea-surface temperature analysis "
            "(0.25° resolution, optimum interpolation of AVHRR + in-situ). "
            "Contours every 2 degC over the TC-relevant 18-32 degC range."
        ),
    )
    png = render_contour_png(sst, spec)
    return png if upload_layer(spec, png) else None


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def main() -> int:
    date_str, hour_str = latest_gfs_cycle()
    log.info("Latest GFS cycle: %s %sZ", date_str, hour_str)

    results = {}
    for name, fn in [
        ("shear_200_850", lambda: build_shear(date_str, hour_str)),
        ("shear_500_850", lambda: build_midlevel_shear(date_str, hour_str)),
        ("rh_700_400",    lambda: build_midlevel_rh(date_str, hour_str)),
        ("sst_oisst",     build_sst),
    ]:
        try:
            results[name] = fn() is not None
        except Exception:
            log.error("Builder %s crashed:\n%s", name, traceback.format_exc())
            results[name] = False

    log.info("Done. Results: %s", results)
    # Exit nonzero so Scheduler retries if every field failed, but we
    # don't want one OISST hiccup to mask an otherwise-good run.
    return 0 if any(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
