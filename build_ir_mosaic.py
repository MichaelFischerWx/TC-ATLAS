#!/usr/bin/env python3
"""build_ir_mosaic.py — POC IR mosaic tile builder (GOES-19 + GOES-18).

One cached-kernel pipeline that serves BOTH:
  • global mosaic  (z0–zmax)          — the whole GOES-E/W field
  • storm detail   (--storm, z6–z7)   — high-zoom tiles over active storms,
                                         the SAME tiles a "storm card" needs

Web-Mercator XYZ PNG tiles a WebGL map (MapLibre) consumes as one raster
source → continuous zoom from the globe straight into a storm.

Reuses satellite_ir.py: GOES S3 access, file finder, IR colormap LUT, the
exact render normalization, and the geostationary projection constants.

Blend: each pixel takes the NEARER-NADIR satellite via a near-cutline weight
(cosz**BLEND_P, normalized) — a thin feather instead of a wide average, which
avoids parallax double-imaging of tall cold tops and limb bleed.

Usage:
  python build_ir_mosaic.py --build-kernel              # one-time kernels
  python build_ir_mosaic.py --time                      # global render
  python build_ir_mosaic.py --storm --time              # global + active storms
  python build_ir_mosaic.py --storm-at 16,-95           # global + a test point
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

import numpy as np

# ── Reuse the production satellite stack ───────────────────────────────────
from satellite_ir import (
    GOES_BUCKETS, GOES_SAT_HEIGHT, IR_BAND, IR_VMIN, IR_VMAX, _IR_LUT,
    find_goes_file, get_goes_fs,
    HIMAWARI_BUCKET, HIMAWARI_LON_0, HIMAWARI_SAT_HEIGHT, HIMAWARI_SWEEP,
    find_himawari_file, open_himawari_subset,
)

OUT_DIR = os.environ.get("MOSAIC_OUT", "mosaic_out")
KERNEL_DIR = os.path.join(OUT_DIR, "kernels")
API_BASE = "https://api.tcatlas.org"
TILE_SIZE = 256

# Blend / crop tuning -------------------------------------------------------
BLEND_P = 40.0        # cutline sharpness: w = (cosz/cosz_max)**P. Higher =
                      # narrower feather (less parallax ghost), risk of seam.
LIMB_DEG = 76.0       # drop pixels seen more than this far off-nadir (limb junk)
STORM_BOX_DEG = 6.0   # half-box baked around each storm
STORM_ZOOMS = (6, 7)  # storm-detail zoom levels (z6 ≈ native IR, z7 overzoom)

# (key, kind, bucket, label). lon_0/grid come from each file's own navigation.
SATS = [
    ("east", "goes",     GOES_BUCKETS["east_19"], "GOES-19"),
    ("west", "goes",     GOES_BUCKETS["west"],    "GOES-18"),
    ("hima", "himawari", HIMAWARI_BUCKET,         "Himawari-9"),
]


def log(msg):
    print(f"[mosaic] {msg}", flush=True)


# ── Web Mercator helpers (slippy-map convention) ───────────────────────────
def pixels_to_lonlat(px, py, S):
    """Global Mercator pixel centres (px col, py row; image size S) → lon, lat."""
    lon = px / S * 360.0 - 180.0
    n = np.pi - 2.0 * np.pi * py / S
    lat = np.degrees(np.arctan(np.sinh(n)))
    return lon, lat


def lon_to_tilex(lon, z):
    return int((lon + 180.0) / 360.0 * (2 ** z))


def lat_to_tiley(lat, z):
    r = np.radians(max(-85.0, min(85.0, lat)))
    return int((1.0 - np.arcsinh(np.tan(r)) / np.pi) / 2.0 * (2 ** z))


def tile_lonlat(z, x, y):
    """(256,256) LON, LAT grids for tile (z,x,y)."""
    S = TILE_SIZE * (2 ** z)
    col = (x * TILE_SIZE + np.arange(TILE_SIZE) + 0.5)
    row = (y * TILE_SIZE + np.arange(TILE_SIZE) + 0.5)
    lon = col / S * 360.0 - 180.0
    n = np.pi - 2.0 * np.pi * row / S
    lat = np.degrees(np.arctan(np.sinh(n)))
    return (np.broadcast_to(lon[None, :], (TILE_SIZE, TILE_SIZE)),
            np.broadcast_to(lat[:, None], (TILE_SIZE, TILE_SIZE)))


# ── Geostationary projection core (shared by global kernel & storm tiles) ──
def grid_of(x, y):
    return (x[0], (x[-1] - x[0]) / (x.size - 1), x.size,
            y[0], (y[-1] - y[0]) / (y.size - 1), y.size)


def project_to_sat(LON, LAT, grid, lon_0, sat_h, sweep):
    """Map geographic LON/LAT (any shape) onto a satellite's fixed grid.
    Returns idx (flat row*nx+col, int32), cosz (cos viewing angle, limb-masked
    to 0, float32), mask (bool on-disk & within the LIMB_DEG crop)."""
    import pyproj
    x0, dx, nx, y0, dy, ny = grid
    proj = pyproj.Proj(proj="geos", h=sat_h, lon_0=lon_0, sweep=sweep)
    xm, ym = proj(np.asarray(LON), np.asarray(LAT), errcheck=False)
    xr_ = np.asarray(xm) / sat_h
    yr_ = np.asarray(ym) / sat_h
    cosw = np.cos(np.radians(LAT)) * np.cos(np.radians(np.asarray(LON) - lon_0))
    limb_cos = np.cos(np.radians(LIMB_DEG))
    on = (np.isfinite(xr_) & np.isfinite(yr_) & (np.abs(xr_) < 1e3) &
          (cosw > limb_cos))
    xs = np.where(on, xr_, x0)
    ys = np.where(on, yr_, y0)
    col = np.round((xs - x0) / dx).astype(np.int32)
    row = np.round((ys - y0) / dy).astype(np.int32)
    mask = on & (col >= 0) & (col < nx) & (row >= 0) & (row < ny)
    col = np.clip(col, 0, nx - 1)
    row = np.clip(row, 0, ny - 1)
    idx = (row.astype(np.int64) * nx + col).astype(np.int32)
    cosz = np.clip(cosw, 0.0, 1.0).astype(np.float32)
    cosz[~mask] = 0.0
    return idx, cosz, mask


def blend_samples(samples):
    """samples: list of (gathered_tb, cosz, valid_mask), all same shape.
    Near-cutline blend: normalize each sat's cosz by the per-pixel max, raise to
    BLEND_P, weight-average. Nearer-nadir wins outside a thin feather → no
    wide-area averaging of parallax-offset cold tops."""
    shape = samples[0][0].shape
    cosz_stack = np.stack([np.where(v, c, 0.0).astype(np.float64)
                           for (_, c, v) in samples])
    cmax = cosz_stack.max(axis=0)
    num = np.zeros(shape, np.float64)
    den = np.zeros(shape, np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        for k, (tb_g, _c, v) in enumerate(samples):
            ratio = np.where(cmax > 0, cosz_stack[k] / cmax, 0.0)
            w = np.where(v, ratio ** BLEND_P, 0.0)
            num += w * np.where(v, tb_g, 0.0)
            den += w
        out = np.where(den > 0, num / den, np.nan)
    return out.astype(np.float32)


def colormap(tb):
    """Tb (K) → RGBA uint8, identical normalization to render_ir_png; NaN→clear."""
    frac = np.clip(1.0 - (tb - IR_VMIN) / (IR_VMAX - IR_VMIN), 0.0, 1.0)
    rgba = _IR_LUT[(np.nan_to_num(frac) * 255).astype(np.uint8)].copy()
    rgba[~np.isfinite(tb)] = (0, 0, 0, 0)
    return rgba


# ── Read full-disk B13 Tb for every satellite, once per cycle ──────────────
def read_full_disk(bucket, dt):
    import xarray as xr
    key, scan_dt = find_goes_file(bucket, dt, tolerance_min=20, band=IR_BAND,
                                  return_dt=True)
    if not key:
        return None
    fs = get_goes_fs()
    fobj = fs.open(f"s3://{key}", "rb")
    try:
        ds = xr.open_dataset(fobj, engine="h5netcdf")
        var = "CMI" if "CMI" in ds else f"CMI_C{IR_BAND:02d}"
        tb = ds[var].values.astype(np.float32)
        x = ds["x"].values.astype(np.float64)
        y = ds["y"].values.astype(np.float64)
        gip = ds["goes_imager_projection"].attrs
        sat_h = float(gip.get("perspective_point_height", GOES_SAT_HEIGHT))
        lon_0 = float(gip.get("longitude_of_projection_origin"))
        sweep = str(gip.get("sweep_angle_axis", "x"))
    finally:
        ds.close(); fobj.close()
    return tb, x, y, lon_0, sat_h, sweep, scan_dt


def read_himawari_full_disk(dt):
    """Full-disk Himawari B13 via the existing HSD reader: a huge box centred on
    the sub-point pulls all 10 segments; the returned geos array + extent give us
    the same (tb, x, y, lon_0, sat_h, sweep) shape as the GOES reader."""
    prefix, scan_dt = find_himawari_file(dt, tolerance_min=20, band=IR_BAND,
                                         return_dt=True)
    if not prefix:
        return None
    data, extent = open_himawari_subset(prefix, 0.0, HIMAWARI_LON_0,
                                        box_deg=160.0, band=IR_BAND,
                                        return_extent=True)
    if data is None or extent is None:
        return None
    ny, nx = data.shape
    x = np.linspace(extent[0], extent[1], nx) / HIMAWARI_SAT_HEIGHT
    y = np.linspace(extent[2], extent[3], ny) / HIMAWARI_SAT_HEIGHT
    return (data.astype(np.float32), x, y, HIMAWARI_LON_0,
            HIMAWARI_SAT_HEIGHT, HIMAWARI_SWEEP, scan_dt)


def read_all_sats(dt, timings):
    sats = {}
    for sat_key, kind, bucket, label in SATS:
        t0 = time.time()
        try:
            fd = (read_himawari_full_disk(dt) if kind == "himawari"
                  else read_full_disk(bucket, dt))
        except Exception as e:
            log(f"  {label}: read failed ({e}) — skip"); fd = None
        timings["read"] = timings.get("read", 0.0) + time.time() - t0
        if fd is None:
            log(f"  {label}: no file near {dt:%H:%M}Z — skip"); continue
        tb, x, y, lon_0, sat_h, sweep, scan_dt = fd
        sats[sat_key] = dict(flat=tb.reshape(-1), npix=tb.size, x=x, y=y,
                             lon_0=lon_0, sat_h=sat_h, sweep=sweep,
                             grid=grid_of(x, y), label=label, scan_dt=scan_dt)
        log(f"  {label}: scan {scan_dt:%H:%M}Z ({tb.size/1e6:.0f}M px)")
    return sats


# ── Global kernel (cached): geos→Mercator gather for the whole field ───────
def kernel_path(sat_key, zoom):
    return os.path.join(KERNEL_DIR, f"{sat_key}_z{zoom}.npz")


def ensure_global_kernels(zoom, sats, rebuild=False):
    os.makedirs(KERNEL_DIR, exist_ok=True)
    S = TILE_SIZE * (2 ** zoom)
    px = np.arange(S, dtype=np.float64) + 0.5
    LON, LAT = pixels_to_lonlat(px[None, :], px[:, None], S)
    LON = np.broadcast_to(LON, (S, S)); LAT = np.broadcast_to(LAT, (S, S))
    kernels = {}
    for sat_key, _kind, _b, label in SATS:
        kp = kernel_path(sat_key, zoom)
        if os.path.exists(kp) and not rebuild:
            d = np.load(kp); kernels[sat_key] = (d["idx"], d["cosz"], d["mask"])
            log(f"  kernel {label} z{zoom}: loaded"); continue
        if sat_key not in sats:
            continue
        t0 = time.time()
        s = sats[sat_key]
        idx, cosz, mask = project_to_sat(LON, LAT, s["grid"], s["lon_0"],
                                         s["sat_h"], s["sweep"])
        np.savez_compressed(kp, idx=idx, cosz=cosz, mask=mask)
        kernels[sat_key] = (idx, cosz, mask)
        log(f"  kernel {label} z{zoom}: {mask.sum()/1e6:.0f}M px in "
            f"{time.time()-t0:.1f}s (one-time)")
    return kernels


def global_render(zoom, sats, kernels, timings):
    t0 = time.time()
    samples = []
    for sat_key in sats:
        if sat_key not in kernels:
            continue
        idx, cosz, mask = kernels[sat_key]
        flat = sats[sat_key]["flat"]
        if idx.size and int(idx.max()) >= flat.size:
            log(f"  {sats[sat_key]['label']}: grid {flat.size} ≠ kernel "
                f"(rebuild with --build-kernel); skip"); continue
        g = flat[idx]
        samples.append((g, cosz, mask & np.isfinite(g) & (g > 0)))
    timings["gather"] = timings.get("gather", 0.0) + time.time() - t0
    t1 = time.time()
    rgba = colormap(blend_samples(samples))
    timings["colormap"] = timings.get("colormap", 0.0) + time.time() - t1
    return rgba


# ── Storm tiles: high-zoom z/x/y patches over a list of points ─────────────
def storm_tile_set(points, zooms, box_deg):
    tiles = set()
    for lat, lon in points:
        for z in zooms:
            n = 2 ** z
            x0 = max(0, lon_to_tilex(lon - box_deg, z))
            x1 = min(n - 1, lon_to_tilex(lon + box_deg, z))
            y0 = max(0, lat_to_tiley(lat + box_deg, z))
            y1 = min(n - 1, lat_to_tiley(lat - box_deg, z))
            for ty in range(y0, y1 + 1):
                for tx in range(x0, x1 + 1):
                    tiles.add((z, tx, ty))
    return tiles


def render_storm_tiles(sats, tiles, out_dir, timings):
    from PIL import Image
    t0 = time.time()
    written = 0
    for (z, x, y) in sorted(tiles):
        LON, LAT = tile_lonlat(z, x, y)
        samples = []
        for sat_key, s in sats.items():
            idx, cosz, mask = project_to_sat(LON, LAT, s["grid"], s["lon_0"],
                                             s["sat_h"], s["sweep"])
            if not mask.any():
                continue
            g = s["flat"][idx]
            samples.append((g, cosz, mask & np.isfinite(g) & (g > 0)))
        if not samples:
            continue
        rgba = colormap(blend_samples(samples))
        if not rgba[..., 3].any():
            continue
        d = os.path.join(out_dir, str(z), str(x))
        os.makedirs(d, exist_ok=True)
        Image.fromarray(rgba, "RGBA").save(os.path.join(d, f"{y}.png"),
                                           compress_level=6)
        written += 1
    timings["storm_tile"] = time.time() - t0
    return written


# ── Pyramid: slice the global raster into z/x/y (skip empty) ───────────────
def write_pyramid(rgba, zmax, out_dir, timings):
    from PIL import Image
    t0 = time.time()
    level = rgba
    n = 0
    for z in range(zmax, -1, -1):
        S = level.shape[0]
        for ty in range(S // TILE_SIZE):
            for tx in range(S // TILE_SIZE):
                tile = level[ty*TILE_SIZE:(ty+1)*TILE_SIZE,
                             tx*TILE_SIZE:(tx+1)*TILE_SIZE]
                if not tile[..., 3].any():
                    continue
                d = os.path.join(out_dir, str(z), str(tx))
                os.makedirs(d, exist_ok=True)
                Image.fromarray(tile, "RGBA").save(os.path.join(d, f"{ty}.png"),
                                                   compress_level=6)
                n += 1
        if z > 0:
            h = (S // 2) * 2
            level = ((level[:h:2, :h:2].astype(np.uint16) + level[1:h:2, :h:2] +
                      level[:h:2, 1:h:2] + level[1:h:2, 1:h:2]) // 4).astype(np.uint8)
    timings["tile"] = time.time() - t0
    return n


def write_preview(rgba, out_dir, width=1536):
    from PIL import Image
    img = Image.fromarray(rgba, "RGBA"); img.thumbnail((width, width))
    bg = Image.new("RGBA", img.size, (15, 23, 42, 255)); bg.alpha_composite(img)
    p = os.path.join(out_dir, "preview.png"); bg.convert("RGB").save(p)
    return p


def fetch_active_points():
    """Active storms within GOES-E/W coverage (lon -180..-5) → [(lat,lon),…]."""
    try:
        with urllib.request.urlopen(API_BASE + "/ir-monitor/active-storms",
                                    timeout=20) as r:
            storms = (json.load(r) or {}).get("storms", [])
    except Exception as e:
        log(f"  active-storms fetch failed: {e}"); return []
    pts = []
    for s in storms:
        lon = s.get("lon"); lat = s.get("lat")
        if lat is None or lon is None:
            continue
        lonn = ((lon + 180) % 360) - 180
        if -180 <= lonn <= -5:
            pts.append((lat, lonn))
            log(f"  storm {s.get('name','?')} @ {lat:.1f},{lonn:.1f}")
        else:
            log(f"  storm {s.get('name','?')} @ {lonn:.1f}°E outside GOES — skip")
    return pts


def main():
    global BLEND_P
    ap = argparse.ArgumentParser()
    ap.add_argument("--zmax", type=int, default=5)
    ap.add_argument("--build-kernel", action="store_true")
    ap.add_argument("--storm", action="store_true",
                    help="also bake z6–z7 tiles over active storms")
    ap.add_argument("--storm-at", default=None,
                    help="also bake a storm patch at 'lat,lon' (test point)")
    ap.add_argument("--blend-p", type=float, default=None,
                    help="override cutline sharpness (default %d)" % BLEND_P)
    ap.add_argument("--frames", type=int, default=1,
                    help="number of consecutive 10-min frames (for animation)")
    ap.add_argument("--time", action="store_true")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args()
    if args.blend_p:
        BLEND_P = args.blend_p

    now = datetime.now(timezone.utc) - timedelta(minutes=20)
    latest = now.replace(minute=now.minute - (now.minute % 10), second=0, microsecond=0)

    # storm points (resolved once, reused for every frame)
    points = []
    if args.storm:
        points += fetch_active_points()
    if args.storm_at:
        la, lo = (float(v) for v in args.storm_at.split(","))
        points.append((la, lo)); log(f"test point @ {la},{lo}")

    # render newest→oldest so the first frame seeds/loads the kernels
    frame_dts = [latest - timedelta(minutes=10 * i) for i in range(args.frames)]
    written, kernels = [], None
    t0 = time.time()
    for fi, dt in enumerate(frame_dts):
        log(f"── frame {fi+1}/{args.frames}: {dt:%Y-%m-%d %H:%M}Z "
            f"(zmax {args.zmax}, blend_p {BLEND_P:g})")
        timings = {}
        sats = read_all_sats(dt, timings)
        if not sats:
            log("  no satellite data — skip frame"); continue
        if kernels is None:
            kernels = ensure_global_kernels(args.zmax, sats,
                                            rebuild=args.build_kernel)
            if args.build_kernel:
                log("kernels ready (one-time cost) — done"); return

        ts = dt.strftime("%Y%m%d%H%M")
        tiles_dir = os.path.join(args.out, "ir", ts)
        rgba = global_render(args.zmax, sats, kernels, timings)
        n_global = write_pyramid(rgba, args.zmax, tiles_dir, timings)
        n_storm = 0
        if points:
            tiles = storm_tile_set(points, STORM_ZOOMS, STORM_BOX_DEG)
            n_storm = render_storm_tiles(sats, tiles, tiles_dir, timings)
        if fi == 0:
            write_preview(rgba, args.out)
        written.append(ts)
        log(f"  wrote {n_global} global + {n_storm} storm tiles → {ts}")
        if args.time:
            parts = " ".join(f"{k} {timings[k]:.1f}s" for k in
                             ("read", "gather", "colormap", "tile", "storm_tile")
                             if k in timings)
            log(f"  timings: {parts}")

    # animation manifest (oldest→newest) for the MapLibre POC
    if written:
        man = os.path.join(args.out, "ir", "frames.json")
        with open(man, "w") as f:
            json.dump({"frames": sorted(written), "zmax": args.zmax,
                       "storm_zooms": list(STORM_ZOOMS)}, f)
        log(f"manifest ({len(written)} frames) → {man}")
    log(f"TOTAL {time.time()-t0:.1f}s for {len(written)} frame(s)")


if __name__ == "__main__":
    main()
