"""
Pixel-match validation: extract real NRL colors from Jiang 2018 Fig. 1 and
score each candidate recipe's predicted RGB against ground truth.
"""
import numpy as np
from PIL import Image

im = np.asarray(Image.open("fig1_full.png").convert("RGB")).astype(np.float64)
Y, X, _ = im.shape

# --- calibration (verified against gridlines) ---
# X: px 175 -> H37 150 K ; px 1006 -> 300 K
# Y: px 125 -> V37 300 K ; px 941 -> 150 K
def px_to_h(px): return 150.0 + (px - 175.0) / (1006.0 - 175.0) * 150.0
def px_to_v(py): return 300.0 - (py - 125.0) / (941.0 - 125.0) * 150.0

# --- isolate colored scatter points (exclude white bg, gray grid, black lines/text) ---
R, G, B = im[..., 0], im[..., 1], im[..., 2]
mx = im.max(2); mn = im.min(2); sat = mx - mn
xx, yy = np.meshgrid(np.arange(X), np.arange(Y))
inbox = (xx > 178) & (xx < 1003) & (yy > 128) & (yy < 938)
# Keep tinted pixels but reject pure-white background (mn>=232), black
# lines/text (mx<70), and neutral-gray gridlines (sat<18). Using sat>55 here
# silently DROPPED the pale salmon<->cyan transition band (low-saturation
# blend of near-opposite hues), which then biased the fit toward a too-sharp
# transition. mn<232 + sat>=18 recovers ~4.5k transition pixels.
colored = inbox & (mn < 232) & (mx > 70) & (sat >= 18)
ys, xs = np.where(colored)
truth = im[ys, xs] / 255.0
h37 = px_to_h(xs); v37 = px_to_v(ys)
print(f"extracted {len(ys)} colored scatter pixels")
print(f"H37 range {h37.min():.0f}-{h37.max():.0f}, V37 range {v37.min():.0f}-{v37.max():.0f}")


# --- recipes ---
def old_rgb(v, h):
    p = 2.18 * v - 1.18 * h
    return np.stack([np.clip((285 - p) / 100, 0, 1),
                     np.clip((v - 155) / 125, 0, 1) ** 1.6,
                     np.clip((h - 145) / 135, 0, 1) ** 1.1], -1)

def mine_rgb(v, h):
    p = 2.18 * v - 1.18 * h
    return np.stack([np.clip((284 - p) / 40, 0, 1),
                     np.clip((v - 178) / 120, 0, 1) ** 0.85,
                     np.clip((h - 175) / 120, 0, 1)], -1)

def user_rgb(v, h):
    p = 2.18 * v - 1.18 * h
    return np.stack([np.clip(1 - (p - 260) / 20, 0, 1),
                     np.clip((v - 180) / 120, 0, 1),
                     np.clip((h - 180) / 120, 0, 1)], -1)

def fit_rgb(v, h):  # salmon fit to Jiang 2018 Fig.1 pixels (reverse-engineered)
    p = 2.18 * v - 1.18 * h
    return np.stack([np.clip((275 - p) / 12.0, 0, 1),
                     np.clip((v - 112) / 185, 0, 1) ** 1.27,
                     np.clip((h - 185) / 124, 0, 1) ** 0.79], -1)

def canon_rgb(v, h):  # NOW LIVE: authoritative NRL/GeoIPS recipe (verbatim)
    p = 2.181 * v - 1.181 * h
    return np.stack([np.clip((280 - p) / 20.0, 0, 1),
                     np.clip((v - 180) / 120, 0, 1),
                     np.clip((h - 160) / 140, 0, 1)], -1)

def fitv_rgb(v, h):  # vivid-cyan variant
    p = 2.18 * v - 1.18 * h
    return np.stack([np.clip((275 - p) / 11.5, 0, 1),
                     np.clip((v - 135) / 162, 0, 1) ** 1.05,
                     np.clip((h - 205) / 60, 0, 1) ** 0.75], -1)


def score(name, fn):
    pred = fn(v37, h37)
    err = np.sqrt(((pred - truth) ** 2).sum(1))      # euclidean RGB dist (0..~1.73)
    print(f"{name:6s}  meanRGBerr={err.mean()*255:6.1f}  median={np.median(err)*255:6.1f}  "
          f"p90={np.percentile(err,90)*255:6.1f}  (0-255 scale)")
    return err, pred


print("\nlower = closer to real Fig. 1 colors:")
results = {n: score(n, f) for n, f in
          [("OLD", old_rgb), ("MINE", mine_rgb), ("USER", user_rgb),
           ("FIT", fit_rgb), ("FITV", fitv_rgb), ("CANON", canon_rgb)]}

# --- visual: paint truth vs each recipe back onto the plot grid ---
def paint(pred):
    canvas = np.ones((Y, X, 3))
    canvas[ys, xs] = pred
    return (canvas * 255).astype(np.uint8)

Image.fromarray(paint(truth)).save("match_truth.png")
for n in ("OLD", "MINE", "USER", "FIT", "FITV", "CANON"):
    Image.fromarray(paint(results[n][1])).save(f"match_{n.lower()}.png")
print("\nwrote match_truth/old/mine/user/fit/fitv/canon.png")
