"""Fit the 37color recipe constants to Jiang 2018 Fig. 1 ground-truth pixels."""
import numpy as np
from PIL import Image
from scipy.optimize import minimize

im = np.asarray(Image.open("fig1_full.png").convert("RGB")).astype(np.float64)
Y, X, _ = im.shape
def px_to_h(px): return 150.0 + (px - 175.0) / (1006.0 - 175.0) * 150.0
def px_to_v(py): return 300.0 - (py - 125.0) / (941.0 - 125.0) * 150.0
mx = im.max(2); mn = im.min(2); sat = mx - mn
xx, yy = np.meshgrid(np.arange(X), np.arange(Y))
inbox = (xx > 178) & (xx < 1003) & (yy > 128) & (yy < 938)
# transition-inclusive: keep pale blend pixels, drop white bg / black / gray grid
# (sat>55 dropped the salmon<->cyan transition band and biased the fit sharp)
colored = inbox & (mn < 232) & (mx > 70) & (sat >= 18)
ys, xs = np.where(colored)
truth = im[ys, xs] / 255.0
h = px_to_h(xs); v = px_to_v(ys); pct = 2.18 * v - 1.18 * h

def model(p):
    a, b, c, d, g, e, f, gb = p
    R = np.clip((a - pct) / b, 0, 1)
    G = np.clip((v - c) / d, 0, 1) ** g
    B = np.clip((h - e) / f, 0, 1) ** gb
    return np.stack([R, G, B], -1)

def loss(p):
    return np.sqrt(((model(p) - truth) ** 2).sum(1)).mean()

# start from USER constants
x0 = [280, 20, 180, 120, 1.0, 180, 120, 1.0]
res = minimize(loss, x0, method="Nelder-Mead",
               options={"maxiter": 20000, "xatol": 1e-3, "fatol": 1e-6})
p = res.x
print("fitted params:")
names = ["R_a", "R_b", "G_c", "G_d", "G_gamma", "B_e", "B_f", "B_gamma"]
for n, val in zip(names, p):
    print(f"  {n:9s} = {val:8.2f}")
print(f"\nfitted mean RGB err = {loss(p)*255:.1f}  (USER was 50.3, MINE 50.3, OLD 97.3)")

# round to clean-ish numbers and re-check
pr = [round(p[0]), round(p[1]), round(p[2]), round(p[3]), round(p[4], 2),
      round(p[5]), round(p[6]), round(p[7], 2)]
print(f"rounded {pr} -> err {loss(pr)*255:.1f}")

# paint fitted
canvas = np.ones((Y, X, 3)); canvas[ys, xs] = model(p)
Image.fromarray((canvas * 255).astype(np.uint8)).save("match_fit.png")
print("wrote match_fit.png")
