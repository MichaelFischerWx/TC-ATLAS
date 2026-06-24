#!/usr/bin/env python3
"""build_ir_mosaic.py — POC global IR mosaic tile builder (GOES-19 + GOES-18).

Proof-of-concept for project_global_sat_mosaic: server-side composited,
reprojected, seamless IR as Web-Mercator XYZ PNG tiles that a WebGL map
(MapLibre) consumes as one clean raster source.

Validates the THREE POC questions:
  1. compute cost/cycle  — the cached-kernel approach (precompute geos→Mercator
     gather indices once; per cycle is just array indexing, not a warp)
  2. blend quality       — viewing-angle (cos-zenith) feathered blend over the
     GOES-East/West overlap (eastern Pacific)
  3. end-to-end          — z/x/y PNG tiles a raster source can drop in

Reuses satellite_ir.py: GOES S3 access, file finder, IR colormap LUT, the
exact render normalization, and the geostationary projection constants.

Usage:
  python build_ir_mosaic.py --build-kernel        # one-time: precompute kernels
  python build_ir_mosaic.py                        # render latest → ./mosaic_out
  python build_ir_mosaic.py --zmax 5 --time        # with per-stage timings
"""
import argparse
import os
import sys
import time
from datetime import datetime, timezone, timedelta

import numpy as np

# ── Reuse the production satellite stack ───────────────────────────────────
import satellite_ir as S
from satellite_ir import (
    GOES_BUCKETS, GOES_SAT_HEIGHT, GOES_TRANSITION_DT,
    IR_PRODUCT, IR_BAND, IR_VMIN, IR_VMAX, _IR_LUT,
    find_goes_file, get_goes_fs,
)

OUT_DIR = os.environ.get("MOSAIC_OUT", "mosaic_out")
KERNEL_DIR = os.path.join(OUT_DIR, "kernels")
TILE_SIZE = 256
WEB_MERC_LAT_MAX = 85.05112877980659

# The two satellites this POC blends. (key, bucket, human label, sub-lon used
# only as a weight fallback — the real lon_0 is read from each file.)
SATS = [
    ("east", GOES_BUCKETS["east_19"], "GOES-19", -75.0),
    ("west", GOES_BUCKETS["west"],    "GOES-18", -137.0),
]


def log(msg):
    print(f"[mosaic] {msg}", flush=True)


# ── Web Mercator <-> lon/lat (slippy-map convention) ───────────────────────
def mercator_lonlat_grid(zoom):
    """Return (lon, lat) arrays for every pixel centre of the global z-level
    Mercator raster (size S×S, S = 256·2^zoom). Shapes (S,) lon and (S,) lat —
    lon varies by column, lat by row (a separable grid)."""
    S = TILE_SIZE * (2 ** zoom)
    px = np.arange(S, dtype=np.float64) + 0.5
    lon = px / S * 360.0 - 180.0                      # (S,) by column
    n = np.pi - 2.0 * np.pi * px / S
    lat = np.degrees(np.arctan(np.sinh(n)))           # (S,) by row
    return S, lon, lat


# ── Read a full-disk GOES CMI Band-13 file → Tb(K) on the fixed grid ───────
def read_full_disk(bucket, dt):
    """Find + open the GOES full-disk CMIP B13 file nearest dt. Returns
    (tb 2D float32, x_rad 1D, y_rad 1D, lon_0, sat_h, sweep, scan_dt) or None."""
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
        tb = ds[var].values.astype(np.float32)        # brightness temp, Kelvin
        x = ds["x"].values.astype(np.float64)         # scan angle, radians (W→E)
        y = ds["y"].values.astype(np.float64)         # scan angle, radians (N→S)
        gip = ds["goes_imager_projection"].attrs
        sat_h = float(gip.get("perspective_point_height", GOES_SAT_HEIGHT))
        lon_0 = float(gip.get("longitude_of_projection_origin"))
        sweep = str(gip.get("sweep_angle_axis", "x"))
    finally:
        ds.close()
        fobj.close()
    return tb, x, y, lon_0, sat_h, sweep, scan_dt


# ── Kernel: precompute geos→Mercator gather index + mask + blend weight ────
def build_kernel(zoom, x, y, lon_0, sat_h, sweep):
    """For the global z-level Mercator grid, return per-pixel:
        idx  (S,S) int32  flat index into the satellite's fixed grid (row*nx+col)
        mask (S,S) bool   pixel falls on this satellite's disk
        wgt  (S,S) f32    blend weight = cos(angle from sub-point), feathered
    The mapping is fixed by geometry → compute ONCE, reuse every cycle."""
    import pyproj
    S, lon, lat = mercator_lonlat_grid(zoom)
    nx, ny = x.size, y.size
    x0, dx = x[0], (x[-1] - x[0]) / (nx - 1)
    y0, dy = y[0], (y[-1] - y[0]) / (ny - 1)

    # 2D lon/lat (broadcast the separable grid)
    LON = np.broadcast_to(lon[None, :], (S, S))
    LAT = np.broadcast_to(lat[:, None], (S, S))

    proj = pyproj.Proj(proj="geos", h=sat_h, lon_0=lon_0, sweep=sweep)
    xm, ym = proj(LON, LAT, errcheck=False)           # metres; off-disk → inf
    xr_ = np.asarray(xm) / sat_h
    yr_ = np.asarray(ym) / sat_h

    # cos of great-circle angle from the sub-satellite point (0, lon_0)
    cos_t = (np.cos(np.radians(LAT)) * np.cos(np.radians(LON - lon_0)))

    # Drop the extreme limb (angle > LIMB_DEG off-nadir): there the IR is badly
    # stretched/noisy and the Mercator sampling combs the disk edge. Production
    # has a perimeter-crop; this is the cheap equivalent.
    LIMB_COS = np.cos(np.radians(76.0))
    on_disk = (np.isfinite(xr_) & np.isfinite(yr_) &
               (np.abs(xr_) < 1e3) & (cos_t > LIMB_COS))
    xr_s = np.where(on_disk, xr_, x0)                  # avoid NaN→int cast warns
    yr_s = np.where(on_disk, yr_, y0)
    col = np.round((xr_s - x0) / dx).astype(np.int32)
    row = np.round((yr_s - y0) / dy).astype(np.int32)
    mask = on_disk & (col >= 0) & (col < nx) & (row >= 0) & (row < ny)
    col = np.clip(col, 0, nx - 1)
    row = np.clip(row, 0, ny - 1)
    idx = (row.astype(np.int64) * nx + col).astype(np.int32)

    # blend weight: ~1 near nadir, →0 at the limb. Squared to tighten the handoff.
    wgt = np.clip(cos_t, 0.0, 1.0).astype(np.float32) ** 2
    wgt[~mask] = 0.0
    return idx, mask, wgt


def kernel_path(sat_key, zoom):
    return os.path.join(KERNEL_DIR, f"{sat_key}_z{zoom}.npz")


def ensure_kernels(zoom, sample_dt, rebuild=False):
    """Build (or load) the per-satellite kernels for this zoom. Returns a dict
    sat_key → (idx, mask, wgt). Also returns the read full-disk geometry reused
    by the caller to avoid a second S3 read during --build-kernel."""
    os.makedirs(KERNEL_DIR, exist_ok=True)
    kernels = {}
    for sat_key, bucket, label, _ in SATS:
        kp = kernel_path(sat_key, zoom)
        if os.path.exists(kp) and not rebuild:
            log(f"kernel {label} z{zoom}: load {kp}")
            d = np.load(kp)
            kernels[sat_key] = (d["idx"], d["mask"], d["wgt"])
            continue
        log(f"kernel {label} z{zoom}: building (one-time)…")
        fd = read_full_disk(bucket, sample_dt)
        if fd is None:
            log(f"  !! no recent {label} file — skipping kernel")
            continue
        _, x, y, lon_0, sat_h, sweep, _ = fd
        t0 = time.time()
        idx, mask, wgt = build_kernel(zoom, x, y, lon_0, sat_h, sweep)
        np.savez_compressed(kp, idx=idx, mask=mask, wgt=wgt)
        log(f"  {label} kernel: {mask.sum()/1e6:.1f}M on-disk px in "
            f"{time.time()-t0:.1f}s → {kp}")
        kernels[sat_key] = (idx, mask, wgt)
    return kernels


# ── Per-cycle render: gather → blend → colormap → tiles ────────────────────
def render_mosaic(zoom, dt, kernels, timings):
    """Return an (S,S,4) uint8 RGBA Web-Mercator mosaic for time dt."""
    S = TILE_SIZE * (2 ** zoom)
    num = np.zeros((S, S), dtype=np.float32)          # Σ w·Tb
    den = np.zeros((S, S), dtype=np.float32)          # Σ w

    for sat_key, bucket, label, _ in SATS:
        if sat_key not in kernels:
            continue
        t0 = time.time()
        fd = read_full_disk(bucket, dt)
        if fd is None:
            log(f"  {label}: no file near {dt:%H:%M}Z — skip")
            continue
        tb, x, y, lon_0, sat_h, sweep, scan_dt = fd
        timings.setdefault("read", 0.0)
        timings["read"] += time.time() - t0

        t1 = time.time()
        idx, mask, wgt = kernels[sat_key]
        flat = tb.reshape(-1)
        if flat.size != (x.size * y.size):
            log(f"  !! {label} grid {flat.size} ≠ kernel grid "
                f"{x.size*y.size}; rebuild kernel (--build-kernel)")
            continue
        gathered = flat[idx]                          # the cheap gather
        valid = mask & np.isfinite(gathered) & (gathered > 0)
        w = np.where(valid, wgt, 0.0)
        num += w * np.where(valid, gathered, 0.0)
        den += w
        timings.setdefault("gather", 0.0)
        timings["gather"] += time.time() - t1
        log(f"  {label}: scan {scan_dt:%H:%M}Z, {valid.sum()/1e6:.1f}M px")

    t2 = time.time()
    with np.errstate(invalid="ignore", divide="ignore"):
        tb_merc = np.where(den > 0, num / den, np.nan).astype(np.float32)
    # colormap — identical normalization to satellite_ir.render_ir_png
    frac = np.clip(1.0 - (tb_merc - IR_VMIN) / (IR_VMAX - IR_VMIN), 0.0, 1.0)
    indices = (np.nan_to_num(frac) * 255).astype(np.uint8)
    rgba = _IR_LUT[indices]
    rgba[den <= 0] = (0, 0, 0, 0)                     # transparent where no sat
    timings["colormap"] = time.time() - t2
    return rgba


# ── Tile the global raster into z/x/y PNGs (skip empty) ────────────────────
def write_tiles(rgba, zmax, out_dir, timings):
    from PIL import Image
    t0 = time.time()
    os.makedirs(out_dir, exist_ok=True)
    level = rgba
    n_written = 0
    for z in range(zmax, -1, -1):
        S = level.shape[0]
        ntiles = S // TILE_SIZE
        for ty in range(ntiles):
            for tx in range(ntiles):
                tile = level[ty*TILE_SIZE:(ty+1)*TILE_SIZE,
                             tx*TILE_SIZE:(tx+1)*TILE_SIZE]
                if not tile[..., 3].any():            # fully transparent → skip
                    continue
                d = os.path.join(out_dir, str(z), str(tx))
                os.makedirs(d, exist_ok=True)
                Image.fromarray(tile, "RGBA").save(
                    os.path.join(d, f"{ty}.png"), compress_level=6)
                n_written += 1
        # downsample 2× (mean over 2×2 blocks) for the next-lower zoom
        if z > 0:
            h = (S // 2) * 2
            level = (level[:h:2, :h:2].astype(np.uint16) +
                     level[1:h:2, :h:2] + level[:h:2, 1:h:2] +
                     level[1:h:2, 1:h:2]) // 4
            level = level.astype(np.uint8)
    timings["tile"] = time.time() - t0
    return n_written


def write_preview(rgba, out_dir, width=1536):
    """A single stitched, downsampled PNG so the blend/coverage is inspectable
    without a browser."""
    from PIL import Image
    img = Image.fromarray(rgba, "RGBA")
    img.thumbnail((width, width))
    # composite over dark navy so transparent ocean reads like the site
    bg = Image.new("RGBA", img.size, (15, 23, 42, 255))
    bg.alpha_composite(img)
    p = os.path.join(out_dir, "preview.png")
    bg.convert("RGB").save(p)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zmax", type=int, default=5, help="max native zoom (POC)")
    ap.add_argument("--build-kernel", action="store_true",
                    help="(re)build the geos→Mercator kernels, then exit")
    ap.add_argument("--time", action="store_true", help="print stage timings")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args()

    # a recent 10-min slot, backed off ~20 min for GOES ingest latency
    now = datetime.now(timezone.utc) - timedelta(minutes=20)
    dt = now.replace(minute=now.minute - (now.minute % 10),
                     second=0, microsecond=0)
    log(f"target time {dt:%Y-%m-%d %H:%M}Z · zmax {args.zmax}")

    tk = time.time()
    kernels = ensure_kernels(args.zmax, dt, rebuild=args.build_kernel)
    if not kernels:
        log("no kernels — aborting"); sys.exit(1)
    if args.build_kernel:
        log(f"kernels ready in {time.time()-tk:.1f}s "
            f"(this is the ONE-TIME cost)"); return

    timings = {}
    t0 = time.time()
    rgba = render_mosaic(args.zmax, dt, kernels, timings)
    tiles_dir = os.path.join(args.out, "ir", dt.strftime("%Y%m%d%H%M"))
    n = write_tiles(rgba, args.zmax, tiles_dir, timings)
    preview = write_preview(rgba, args.out)
    wall = time.time() - t0

    log(f"wrote {n} tiles → {tiles_dir}")
    log(f"preview → {preview}")
    if args.time:
        log("─ per-cycle timings (the every-10-min cost) ─")
        for k in ("read", "gather", "colormap", "tile"):
            if k in timings:
                log(f"  {k:9s} {timings[k]:6.2f}s")
        log(f"  {'TOTAL':9s} {wall:6.2f}s")


if __name__ == "__main__":
    main()
