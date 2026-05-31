"""
Local preview: OLD vs NEW (NRL-faithful) 37 GHz color recipe.
Renders (1) a V37/H37 color-space map (Jiang 2018 Fig. 1 style) and
(2) a synthetic TC scene, for both recipes. No external data needed.
"""
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = __file__.rsplit("/", 1)[0]


# ---------------------------------------------------------------- recipes
def old_rgb(v37, h37):
    pct = 2.18 * v37 - 1.18 * h37
    r = np.clip((285.0 - pct) / 100.0, 0, 1)
    g = np.clip((v37 - 155.0) / 125.0, 0, 1) ** 1.6
    b = np.clip((h37 - 145.0) / 135.0, 0, 1) ** 1.1
    return np.stack([r, g, b], axis=-1)


def new_rgb(v37, h37):  # my fit (now live in microwave_api.py)
    pct = 2.18 * v37 - 1.18 * h37
    r = np.clip((284.0 - pct) / 40.0, 0, 1)
    g = np.clip((v37 - 178.0) / 120.0, 0, 1) ** 0.85
    b = np.clip((h37 - 175.0) / 120.0, 0, 1)
    return np.stack([r, g, b], axis=-1)


def user_rgb(v37, h37):  # candidate from user: paper-pinned constants
    pct = 2.18 * v37 - 1.18 * h37
    r = np.clip(1.0 - (pct - 260.0) / 20.0, 0, 1)   # reverse: 1@260, 0@280
    g = np.clip((v37 - 180.0) / 120.0, 0, 1)
    b = np.clip((h37 - 180.0) / 120.0, 0, 1)
    return np.stack([r, g, b], axis=-1)


def fit_rgb(v37, h37):  # salmon fit to Jiang 2018 Fig.1 pixels (reverse-engineered)
    pct = 2.18 * v37 - 1.18 * h37
    r = np.clip((275.0 - pct) / 12.0, 0, 1)
    g = np.clip((v37 - 112.0) / 185.0, 0, 1) ** 1.27
    b = np.clip((h37 - 185.0) / 124.0, 0, 1) ** 0.79
    return np.stack([r, g, b], axis=-1)


def canon_rgb(v37, h37):  # NOW LIVE: authoritative NRL/GeoIPS recipe (verbatim)
    # Linear guns, no gamma. Blue onset 160 K gives the operational NRL *pink*
    # deep-convection signature (vs the more salmon render in Jiang 2018 Fig.1).
    pct = 2.181 * v37 - 1.181 * h37
    r = np.clip((280.0 - pct) / 20.0, 0, 1)
    g = np.clip((v37 - 180.0) / 120.0, 0, 1)
    b = np.clip((h37 - 160.0) / 140.0, 0, 1)
    return np.stack([r, g, b], axis=-1)


def fitv_rgb(v37, h37):  # fit + more vivid cyan (blue boosted at high H37)
    pct = 2.18 * v37 - 1.18 * h37
    r = np.clip((275.0 - pct) / 11.5, 0, 1)
    g = np.clip((v37 - 135.0) / 162.0, 0, 1) ** 1.05
    # higher onset (205) keeps ocean green; tighter range (60) saturates cyan
    b = np.clip((h37 - 205.0) / 60.0, 0, 1) ** 0.75
    return np.stack([r, g, b], axis=-1)


# ------------------------------------------------- 1. color-space map
# Sweep H37 and V37; only show the physically realistic arrowhead
# (V37 >= H37, and not absurdly far from the PCT lines).
H = np.linspace(150, 290, 400)
V = np.linspace(150, 290, 400)
HH, VV = np.meshgrid(H, V)
valid = VV >= HH  # vertical pol >= horizontal pol (ocean & precip)

for name, fn in [("old", old_rgb), ("new", new_rgb), ("user", user_rgb),
                 ("fit", fit_rgb), ("fitv", fitv_rgb), ("canon", canon_rgb)]:
    rgb = fn(VV, HH)
    rgb[~valid] = 1.0  # white background outside arrowhead
    fig, ax = plt.subplots(figsize=(5, 5))
    ax.imshow(rgb, origin="lower", extent=[150, 290, 150, 290], aspect="auto")
    # --- Fig. 1 reference lines ---
    # diagonal constant-PCT37 lines (260, 270, 275 K)
    for pct, lab in ((260, "PCT37 = 260 K"), (270, "270 K"), (275, "275 K")):
        vline = (pct + 1.18 * H) / 2.18           # V = (PCT + 1.18 H)/2.18
        ax.plot(H, vline, "k-", lw=0.8)
        ax.text(287, (pct + 1.18 * 287) / 2.18, lab, fontsize=6,
                rotation=33, va="center", ha="right")
    # vertical H37 reference lines (225, 255 K)
    for hv in (225, 255):
        ax.axvline(hv, color="k", lw=0.8)
        ax.text(hv - 1.5, 287, f"H37 = {hv} K", fontsize=6,
                rotation=90, va="top", ha="right")
    ax.set_xlim(150, 290); ax.set_ylim(150, 290)
    ax.set_xlabel("37 GHz Horizontal H37 [K]")
    ax.set_ylabel("37 GHz Vertical V37 [K]")
    ax.set_title(f"Color space — {name.upper()} recipe\n(lines = const PCT37)")
    fig.tight_layout()
    fig.savefig(f"{OUT}/space_{name}.png", dpi=110)
    plt.close(fig)


# ------------------------------------------------- 2. synthetic TC scene
# Feature target (V37, H37) chosen from Jiang 2018 Table 1 so each region
# lands in its documented color. We weight-blend toward these targets
# (additive deltas overshoot and saturate, which is unrealistic).
#   ocean green     PCT37>270, H37<225  -> (235, 200)
#   rainband cyan   PCT37~280, H37>255  -> (262, 256)
#   eyewall pink    PCT37~240, warm H37 -> (238, 236)
#   intense red     PCT37~205, low H37  -> (198, 192)
#   eye (clear)     warm, low H37       -> (242, 206)
n = 400
y, x = np.mgrid[0:n, 0:n]
cx = cy = n / 2
r = np.hypot(x - cx, y - cy) / (n / 2)
ang = np.arctan2(y - cy, x - cx)

V_OCEAN, H_OCEAN = 235.0, 200.0
targets = []  # (weight, V37, H37)

band = np.clip(np.exp(-(((r - 0.65) * 6) ** 2)) *
               (0.5 + 0.5 * np.cos(3 * ang - 8 * r)), 0, 1)
targets.append((band, 262.0, 256.0))                       # cyan rainband

eyewall = np.exp(-(((r - 0.28) * 9) ** 2))
targets.append((eyewall, 238.0, 236.0))                    # pink eyewall

cell = np.exp(-((((x - cx) - 30) ** 2 + ((y - cy) + 25) ** 2) / (2 * 12 ** 2)))
targets.append((cell, 198.0, 192.0))                       # intense red cell

eye = np.exp(-((r * 9) ** 2))
targets.append((eye, 242.0, 206.0))                        # clear green eye

# Blend so a strong feature REPLACES ocean (instead of averaging 50/50,
# which muddies the color). alpha = how much feature vs ocean baseline.
eps = 1e-6
wtot = np.zeros((n, n))
mixv = np.zeros((n, n))
mixh = np.zeros((n, n))
for w, vt, ht in targets:
    wtot += w
    mixv += w * vt
    mixh += w * ht
mixv /= (wtot + eps)
mixh /= (wtot + eps)
alpha = np.clip(wtot, 0, 1)
v37 = V_OCEAN * (1 - alpha) + mixv * alpha
h37 = H_OCEAN * (1 - alpha) + mixh * alpha

v37 = np.clip(v37, 150, 290)
h37 = np.clip(h37, 150, 290)

for name, fn in [("old", old_rgb), ("new", new_rgb), ("user", user_rgb),
                 ("fit", fit_rgb), ("fitv", fitv_rgb), ("canon", canon_rgb)]:
    rgb = fn(v37, h37)
    fig, ax = plt.subplots(figsize=(5, 5))
    ax.imshow(rgb, origin="lower")
    ax.set_title(f"Synthetic TC — {name.upper()} recipe")
    ax.axis("off")
    fig.tight_layout()
    fig.savefig(f"{OUT}/scene_{name}.png", dpi=110)
    plt.close(fig)

print("wrote space_old/new.png and scene_old/new.png")
