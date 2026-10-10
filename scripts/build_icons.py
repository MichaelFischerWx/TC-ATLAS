#!/usr/bin/env python3
"""Rebuild the site's logo PNGs from the 1024 px master (tc-atlas-icon.png).

Every favicon size is a downscale of the master. The master used to sit on an
opaque white square, so the logo showed white corners on any non-white
background (dark-mode top bar, dark browser tabs, export watermarks). This
script:

1. Cuts the master to its disc: transparent outside the circle, with an
   anti-aliased (4x4 supersampled) edge. The source edge was aliased, so
   edge pixels take the sphere color found just inside the circle instead of
   the white they had. Skipped when the master's corners are already
   transparent, so re-running only re-derives the sizes.
2. Writes tc-atlas-favicon-{16,32,64,96,192,512}.png by premultiplied Lanczos
   downscale.
3. Writes opaque-on-white copies where a platform needs a full square:
   tc-atlas-apple-touch-180.png (iOS fills transparency with black) and
   tc-atlas-maskable-512.png (Android's maskable icon must be opaque). They
   look the same as the old white-cornered files.

Run from the repo root:  python3 scripts/build_icons.py
"""
import os

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
MASTER = os.path.join(ROOT, 'tc-atlas-icon.png')
SIZES = (16, 32, 64, 96, 192, 512)
SS = 4  # supersamples per pixel side for edge coverage


def cut_disc(rgba):
    """Transparent outside the logo's circle, anti-aliased edge."""
    rgb = rgba[..., :3].astype(np.float64)
    h, w = rgb.shape[:2]
    inside = (255.0 - rgb).max(axis=-1) > 40          # not the white backdrop
    ys, xs = np.nonzero(inside)
    # Pixel i spans [i, i+1): the disc runs from the first to past the last
    # non-white column/row.
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    r = ((x1 - x0) + (y1 - y0)) / 4.0

    # Coverage of each pixel by the disc, from SS x SS subsamples.
    off = (np.arange(SS) + 0.5) / SS
    gy, gx = np.mgrid[0:h, 0:w].astype(np.float64)
    cover = np.zeros((h, w))
    for oy in off:
        for ox in off:
            cover += ((gx + ox - cx) ** 2 + (gy + oy - cy) ** 2) <= r * r
    cover /= SS * SS

    # Edge pixels: take the color 1.5 px inside the circle along the radius,
    # so partially covered pixels blend the sphere's edge color, not white.
    dx, dy = gx + 0.5 - cx, gy + 0.5 - cy
    d = np.hypot(dx, dy)
    edge = (cover > 0) & (d > r - 2.0)
    scale = np.where(d > 0, (r - 1.5) / np.maximum(d, 1e-9), 0)
    sx = np.clip(np.round(cx + dx * scale - 0.5), 0, w - 1).astype(int)
    sy = np.clip(np.round(cy + dy * scale - 0.5), 0, h - 1).astype(int)
    out_rgb = rgb.copy()
    out_rgb[edge] = rgb[sy[edge], sx[edge]]

    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., :3] = np.clip(np.round(out_rgb), 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(np.round(cover * 255), 0, 255).astype(np.uint8)
    out[cover == 0, :3] = 0
    return out, (cx, cy, r)


def downscale(img, n):
    # Resize in premultiplied alpha so the edge doesn't pick up a dark or
    # white fringe from the transparent pixels' color.
    return img.convert('RGBa').resize((n, n), Image.LANCZOS).convert('RGBA')


def on_white(img):
    bg = Image.new('RGBA', img.size, (255, 255, 255, 255))
    return Image.alpha_composite(bg, img).convert('RGB')


def main():
    master = Image.open(MASTER).convert('RGBA')
    arr = np.asarray(master)
    if arr[0, 0, 3] == 255:
        cut, (cx, cy, r) = cut_disc(arr)
        master = Image.fromarray(cut, 'RGBA')
        master.save(MASTER, optimize=True)
        print('cut master disc: center (%.1f, %.1f) r %.1f px' % (cx, cy, r))
    else:
        print('master already transparent; re-deriving sizes only')
    for n in SIZES:
        path = os.path.join(ROOT, 'tc-atlas-favicon-%d.png' % n)
        downscale(master, n).save(path, optimize=True)
        print('wrote', os.path.basename(path))
    on_white(downscale(master, 180)).save(os.path.join(ROOT, 'tc-atlas-apple-touch-180.png'), optimize=True)
    on_white(downscale(master, 512)).save(os.path.join(ROOT, 'tc-atlas-maskable-512.png'), optimize=True)
    print('wrote tc-atlas-apple-touch-180.png, tc-atlas-maskable-512.png')


if __name__ == '__main__':
    main()
