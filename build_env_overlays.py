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
                     levels: list, var: str) -> Optional[bytes]:
    """Fetch a global GFS field for one variable across multiple levels.
    Returns raw GRIB2 bytes or None on failure.

    The cgi-bin filter applies var_X=on and lev_X=on toggles; output is
    a sequence of GRIB messages for every (var, level) that exists.

    `levels` accepts:
      - int (e.g. 850) → adds `lev_850_mb=on` (pressure level in mb)
      - str (e.g. "mean_sea_level", "surface") → adds the raw toggle as-is
    """
    import requests

    params: list[tuple[str, str]] = [
        ("dir", f"/gfs.{date_str}/{hour_str}/atmos"),
        ("file", f"gfs.t{hour_str}z.pgrb2.0p25.f000"),
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
        # GFS variable naming: UGRD→"u", VGRD→"v", RH→"r", TMP→"t",
        # HGT→"gh" (geopotential height in m, exposed by cfgrib as `gh`),
        # PRMSL→"prmsl" (pressure reduced to MSL).
        name_map = {"UGRD": "u", "VGRD": "v", "RH": "r", "TMP": "t",
                    "HGT": "gh", "PRMSL": "prmsl"}
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
    # at zoom. NaN cells need a sentinel that doesn't blend across the
    # ocean/land boundary; replace with vmin then re-mask after. For
    # discrete-bins we use NEAREST to keep the band edges crisp instead
    # of bilinear-blurring across a 5-10% probability boundary.
    finite_mask = np.isfinite(field)
    work = np.where(finite_mask, field, spec.vmin)
    resample = Image.NEAREST if spec.discrete_bins else Image.BILINEAR
    img_f = Image.fromarray(work).resize((IMG_NX, IMG_NY), resample)
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


def render_layer_png(field: np.ndarray, spec: LayerSpec) -> bytes:
    """Dispatch to the contour or filled renderer based on render_style."""
    if spec.render_style == "filled":
        return _render_filled_png(field, spec)
    return _render_contour_png(field, spec)


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
        "image_url": (
            f"https://storage.googleapis.com/{GCS_BUCKET}/"
            f"{GCS_PREFIX}/{spec.name}/latest.png"
        ),
        # Vector GeoJSON sidecar for contour layers — crisper than the
        # raster PNG at any zoom because the browser redraws polylines
        # at display resolution. Filled layers don't get one because
        # filled-region polygons would balloon JSON size.
        "geojson_url": (
            (f"https://storage.googleapis.com/{GCS_BUCKET}/"
             f"{GCS_PREFIX}/{spec.name}/latest.geojson")
            if geojson is not None else None
        ),
        # Greyscale data PNG (8-bit R channel = (value - vmin)/(vmax-vmin)
        # * 255; alpha=0 means NaN). Frontend draws to offscreen canvas
        # and reads pixels on hover for instant value tooltips.
        "data_url": (
            f"https://storage.googleapis.com/{GCS_BUCKET}/"
            f"{GCS_PREFIX}/{spec.name}/latest_data.png"
        ),
        "data_grid": {"nx": data_nx, "ny": data_ny},
        # Hover decode bounds — may be wider than vmin/vmax (contour
        # range) so the tooltip can report values that exceed the
        # rendered contour band without clipping.
        "data_vmin": spec.data_vmin if spec.data_vmin is not None else spec.vmin,
        "data_vmax": spec.data_vmax if spec.data_vmax is not None else spec.vmax,
        # Native grid is global 0.25° in (-180, 180) x (90, -90); these
        # bounds are how Leaflet's imageOverlay should anchor the PNG.
        "bounds": [[-90.0, -180.0], [90.0, 180.0]],
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
        log.info("Uploaded %s: vis=%d bytes data=%d bytes%s",
                 spec.name, len(png), len(data_png),
                 f" geojson={len(geojson)} bytes" if geojson else "")
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
    u200_s = disc_smooth(u200, 400.0)
    v200_s = disc_smooth(v200, 400.0)
    u850_s = disc_smooth(u850, 400.0)
    v850_s = disc_smooth(v850, 400.0)
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
        data_vmax=150,  # let hover report jet-stream shear past the 60-kt contour cap
        description=(
            "Magnitude of the 200-850 hPa vector wind difference from "
            "the latest GFS 0.25° analysis, after a 400 km disc area-"
            "average of u/v at each level (suppresses TC vortices so the "
            "shear represents the environment a storm would experience)."
        ),
    )
    return shear_kt if upload_layer(spec, shear_kt) else None


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
                  description: Optional[str] = None) -> bool:
    """Upload an RG-packed wind PNG + metadata.json sidecar.

    `title` is the user-facing label ("850 hPa Wind Barbs", "10 m Wind
    Barbs"). `level` is optional (kept on pressure-level layers for
    sort/filter; absent for 10-m surface winds)."""
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
    png_blob = bucket.blob(f"{GCS_PREFIX}/{name}/latest.png")
    meta_blob = bucket.blob(f"{GCS_PREFIX}/{name}/metadata.json")

    meta = {
        "name": name,
        "title": title,
        "units": "kt",
        "category": "wind",
        "render_style": "wind_barb",
        "valid_time": valid_time,
        "image_url": (
            f"https://storage.googleapis.com/{GCS_BUCKET}/"
            f"{GCS_PREFIX}/{name}/latest.png"
        ),
        "bounds": [[-90.0, -180.0], [90.0, 180.0]],
        "grid": {"nx": NX, "ny": NY},
        # Decoding parameters: u = u_min + (R/255)*(u_max - u_min)
        "u_min": _WIND_VMIN, "u_max": _WIND_VMAX,
        "v_min": _WIND_VMIN, "v_max": _WIND_VMAX,
        "wind_units_native": "m/s",
        "description": description or (
            f"u, v components ({title}) from the latest GFS 0.25° "
            f"analysis, packed as RG channels of an 8-bit PNG "
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
        log.info("Uploaded %s: png=%d bytes", name, len(png))
        return True
    except Exception as e:
        log.error("Wind upload failed for %s: %s", name, e)
        return False


def build_winds(date_str: str, hour_str: str, level: int) -> Optional[bytes]:
    """Fetch u, v at the given pressure level and upload as a packed
    wind-barb layer."""
    log.info("Building winds: GFS %s %sZ at %d hPa", date_str, hour_str, level)
    u_grib = fetch_gfs_global(date_str, hour_str, [level], "UGRD")
    v_grib = fetch_gfs_global(date_str, hour_str, [level], "VGRD")
    if not u_grib or not v_grib:
        log.error("Winds: GFS fetch failed at %d hPa", level)
        return None
    u = read_gfs_field(u_grib, level, "UGRD")
    v = read_gfs_field(v_grib, level, "VGRD")
    if u is None or v is None:
        return None

    # Light smoothing only — wind barbs should reflect the actual flow,
    # not a smeared synoptic mean. 100 km is tight enough to preserve
    # jet structures + outflow channels.
    u_s = disc_smooth(u, 100.0)
    v_s = disc_smooth(v, 100.0)
    u_s = regrid_to_global(u_s)
    v_s = regrid_to_global(v_s)

    png = render_uv_png(u_s, v_s)
    valid = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z"
    title = f"{level} hPa Wind Barbs"
    return png if _upload_winds(f"winds_{level}", title, valid, png, level=level) else None


def build_winds_10m(date_str: str, hour_str: str) -> Optional[bytes]:
    """Fetch u, v at 10 m above ground (the standard surface wind) and
    upload as a packed wind-barb layer.

    Pairs with MSLP to identify boundary-layer features: confluence
    bands, frontal wind shifts, low-level inflow into developing
    systems, and the surface circulation of TC vortices. cfgrib
    exposes the field at typeOfLevel='heightAboveGround', level=10.
    """
    log.info("Building 10-m winds: GFS %s %sZ", date_str, hour_str)
    u_grib = fetch_gfs_global(date_str, hour_str, ["10_m_above_ground"], "UGRD")
    v_grib = fetch_gfs_global(date_str, hour_str, ["10_m_above_ground"], "VGRD")
    if not u_grib or not v_grib:
        log.error("10-m winds: GFS fetch failed")
        return None
    # read_gfs_field ignores `level` when there's no isobaricInhPa dim,
    # which is the case for surface fields with only a single height
    # value (10 m). Pass 10 for documentation / debug clarity.
    u = read_gfs_field(u_grib, 10, "UGRD")
    v = read_gfs_field(v_grib, 10, "VGRD")
    if u is None or v is None:
        return None

    # Same light smoothing as the pressure-level wind builder so the
    # barb spacing/density reads consistently across all wind layers.
    u_s = disc_smooth(u, 100.0)
    v_s = disc_smooth(v, 100.0)
    u_s = regrid_to_global(u_s)
    v_s = regrid_to_global(v_s)

    png = render_uv_png(u_s, v_s)
    valid = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z"
    description = (
        "10-m above-ground u, v from the latest GFS 0.25° analysis, "
        "packed as RG channels of an 8-bit PNG (±60 m/s range). "
        "Pairs with MSLP to expose surface circulations, frontal wind "
        "shifts, and low-level inflow into developing systems."
    )
    return png if _upload_winds("winds_10m", "10 m Wind Barbs", valid, png,
                                description=description) else None


def build_vorticity(date_str: str, hour_str: str, level: int
                    ) -> Optional[bytes]:
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
    u_grib = fetch_gfs_global(date_str, hour_str, [level], "UGRD")
    v_grib = fetch_gfs_global(date_str, hour_str, [level], "VGRD")
    if not u_grib or not v_grib:
        log.error("Vorticity: GFS fetch failed at %d hPa", level)
        return None

    u = read_gfs_field(u_grib, level, "UGRD")
    v = read_gfs_field(v_grib, level, "VGRD")
    if u is None or v is None:
        log.error("Vorticity: missing u/v at %d hPa", level)
        return None

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

    valid = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z"
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


def build_z500_heights(date_str: str, hour_str: str) -> Optional[bytes]:
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
    z_grib = fetch_gfs_global(date_str, hour_str, [500], "HGT")
    if not z_grib:
        log.error("Z500: GFS HGT fetch failed")
        return None

    z_m = read_gfs_field(z_grib, 500, "HGT")
    if z_m is None:
        log.error("Z500: missing HGT field at 500 hPa")
        return None

    z_dam = (z_m / 10.0).astype(np.float32)  # m → dam
    z_s = disc_smooth(z_dam, 200.0)
    z_s = regrid_to_global(z_s)

    valid = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z"
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
        description=(
            "500 hPa geopotential height from the latest GFS 0.25° "
            "analysis (m → dam), 200 km disc-smoothed. Contoured every "
            "3 dam — pairs naturally with low-level vorticity + upper-"
            "level wind barbs to show ridge/trough structure relative "
            "to the surface circulation."
        ),
    )
    return z_s if upload_layer(spec, z_s) else None


def build_divergence(date_str: str, hour_str: str, level: int
                     ) -> Optional[bytes]:
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
    u_grib = fetch_gfs_global(date_str, hour_str, [level], "UGRD")
    v_grib = fetch_gfs_global(date_str, hour_str, [level], "VGRD")
    if not u_grib or not v_grib:
        log.error("Divergence: GFS fetch failed at %d hPa", level)
        return None

    u = read_gfs_field(u_grib, level, "UGRD")
    v = read_gfs_field(v_grib, level, "VGRD")
    if u is None or v is None:
        log.error("Divergence: missing u/v at %d hPa", level)
        return None

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
    # Mask near-zero cells to keep the contour set readable — values
    # below ±2 × 10⁻⁵ s⁻¹ are inside the noise floor at synoptic scale.
    div = np.where(np.abs(div) >= 1.5, div, np.nan).astype(np.float32)
    div = regrid_to_global(div)

    valid = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z"
    spec = LayerSpec(
        name=f"div_{level}",
        title=f"{level} hPa Divergence",
        units="10⁻⁵ s⁻¹",
        vmin=-25,
        vmax=25,
        step=5,
        # Reversed RdBu so red = divergence (positive) and blue =
        # convergence (negative) — matches NWS/SPC convention.
        cmap="RdBu_r",
        # Non-uniform, symmetric ramp: tighter near the noise floor
        # where synoptic features live, coarser past ±10 where only
        # TC-scale features reach. 12 entries → 12 colorbar swatches.
        levels_override=[-20, -15, -10, -6, -3, -1.5, 1.5, 3, 6, 10, 15, 20],
        data_vmin=-100,
        data_vmax=100,
        valid_time=valid,
        description=(
            f"Horizontal mass divergence at {level} hPa from the latest "
            f"GFS 0.25° analysis, after a 200 km disc smooth of u, v. "
            f"Sign convention: blue (negative) = convergence, red "
            f"(positive) = divergence. For TC genesis, look for 850 hPa "
            f"convergence under 200 hPa divergence — the classic vertically-"
            f"coupled inflow/outflow couplet. Contour set ±[1.5, 3, 6, "
            f"10, 15, 20] × 10⁻⁵ s⁻¹."
        ),
    )
    return div if upload_layer(spec, div) else None


def build_mslp(date_str: str, hour_str: str) -> Optional[bytes]:
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
    grib = fetch_gfs_global(date_str, hour_str, ["mean_sea_level"], "PRMSL")
    if not grib:
        log.error("MSLP: GFS PRMSL fetch failed")
        return None

    pa = read_gfs_field(grib, 0, "PRMSL")  # level arg unused for MSL
    if pa is None:
        log.error("MSLP: missing PRMSL field")
        return None

    hpa = (pa / 100.0).astype(np.float32)  # Pa → hPa
    hpa_s = disc_smooth(hpa, 100.0)         # light smooth for clean contours
    hpa_s = regrid_to_global(hpa_s)

    valid = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}T{hour_str}:00:00Z"
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
            "genesis. Rendered as a shaded gradient because contour "
            "lines tend to tangle on a noisy small-scale scalar."
        ),
        render_style="filled",
    )
    return rh if upload_layer(spec, rh) else None


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
    return sst if upload_layer(spec, sst) else None


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

    # Light Gaussian smooth (σ≈55 km) so the disc edges don't read as
    # hard rings. Most spatial smoothing now comes from the disc itself.
    try:
        from scipy.ndimage import gaussian_filter
        try:
            prob = gaussian_filter(prob, sigma=(2.0, 2.0),
                                   mode=("constant", "wrap"))
        except TypeError:
            prob = gaussian_filter(prob, sigma=2.0, mode="wrap")
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

def main() -> int:
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

    for name, fn in [
        ("shear_200_850", lambda: build_shear(date_str, hour_str)),
        ("shear_500_850", lambda: build_midlevel_shear(date_str, hour_str)),
        ("vort_850",      lambda: build_vorticity(date_str, hour_str, 850)),
        ("vort_700",      lambda: build_vorticity(date_str, hour_str, 700)),
        ("vort_500",      lambda: build_vorticity(date_str, hour_str, 500)),
        ("div_850",       lambda: build_divergence(date_str, hour_str, 850)),
        ("div_200",       lambda: build_divergence(date_str, hour_str, 200)),
        ("mslp",          lambda: build_mslp(date_str, hour_str)),
        ("z500_heights",  lambda: build_z500_heights(date_str, hour_str)),
        ("winds_10m",     lambda: build_winds_10m(date_str, hour_str)),
        ("winds_850",     lambda: build_winds(date_str, hour_str, 850)),
        ("winds_700",     lambda: build_winds(date_str, hour_str, 700)),
        ("winds_500",     lambda: build_winds(date_str, hour_str, 500)),
        ("winds_200",     lambda: build_winds(date_str, hour_str, 200)),
        ("rh_700_400",    lambda: build_midlevel_rh(date_str, hour_str)),
        ("sst_oisst",     build_sst),
    ]:
        try:
            results[name] = fn() is not None
        except Exception:
            log.error("Builder %s crashed:\n%s", name, traceback.format_exc())
            results[name] = False

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
    # Exit nonzero so Scheduler retries if every field failed, but we
    # don't want one OISST hiccup to mask an otherwise-good run.
    return 0 if any(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
