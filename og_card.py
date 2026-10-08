#!/usr/bin/env python3
"""
Dynamic social-media "OG card" renderer for TC-ATLAS.

Produces a 1200x630 PNG suitable for og:image / twitter:image. When tropical
cyclones are active, the card features a live infrared image of the current
most-intense storm plus its vitals; in the off-season it falls back to a
branded card. The OG card job regenerates it every cycle and uploads it to a
STABLE, version-independent GCS key, so the og:image meta tag never needs to
change (see og_refresh.build_and_upload_og_card).

Visual language mirrors the site's dark theme (index.html / realtime_ir_styles
.css): #0a0e14 page, #161b24 raised surfaces with hairline borders, UM green +
UM orange accents, DM Sans for text and JetBrains Mono for numbers/times, and
the site icon (tc-atlas-icon.png, the browser-tab favicon). Fonts (SIL OFL) and
the icon are vendored in og_assets/ because python:3.11-slim ships no system
fonts and the frontend PNGs are excluded from the API image.

The whole card is drawn at 2x and downsampled, so shapes (pills, dots, the
rings) come out antialiased — PIL's primitives are not.

Pure rendering only — no GCS or network here, so it stays trivially testable
with a synthetic Tb array.
"""
from __future__ import annotations

import io
import os
from datetime import datetime, timezone
from typing import Optional

import numpy as np

# Reuse the EXACT IR colormap + normalization the live frames use, so the card
# looks identical to what a visitor sees on the site.
from satellite_ir import _IR_LUT, IR_VMIN, IR_VMAX

CARD_W, CARD_H = 1200, 630
_S = 2                       # supersample factor (draw at 2x, downsample)
_IR_SQUARE = CARD_H          # IR backdrop is a CARD_H x CARD_H square on the right
_IR_X = CARD_W - _IR_SQUARE  # left edge of the IR square (570)
_PAD = 56

# Theme — dark-mode tokens from index.html / realtime_ir_styles.css (--lp-*).
_BG = (10, 14, 20)           # --navy        #0a0e14
_SURFACE = (22, 27, 36)      # --lp-surface  #161b24
_TEXT = (230, 232, 235)      # --text        #e6e8eb
_MUTED = (138, 147, 163)     # --text-dim    #8a93a3
_LINE = (255, 255, 255, 20)  # --lp-line     rgba(255,255,255,.08)
_LINE_STRONG = (255, 255, 255, 31)
_GREEN = (74, 155, 110)      # --um-green (dark)  #4a9b6e
_ORANGE = (244, 115, 33)     # --um-orange        #F47321
_ORANGE_INK = (255, 210, 168)  # --lp-orange-ink  #ffd2a8

# Saffir-Simpson colors — mirror SS_COLORS in realtime_ir.js.
_CAT_COLORS = {
    "TD": (96, 165, 250), "TS": (52, 211, 153), "C1": (251, 191, 36),
    "C2": (251, 146, 60), "C3": (248, 113, 113), "C4": (239, 68, 68),
    "C5": (220, 38, 38),
}


# --------------------------------------------------------------------------- #
# Fonts — vendored site fonts (og_assets/), with matplotlib's DejaVu as the
# fallback so a missing file degrades instead of failing.
# --------------------------------------------------------------------------- #
_ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "og_assets")
_FONT_CACHE: dict = {}


def _font(size: float, weight: int = 400, mono: bool = False):
    """size is in 1x card pixels; the returned font is already scaled by _S."""
    px = int(round(size * _S))
    key = (px, weight, mono)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    from PIL import ImageFont
    font = None
    try:
        if mono:
            fname = "JetBrainsMono-Medium.ttf" if weight >= 500 else "JetBrainsMono-Regular.ttf"
            font = ImageFont.truetype(os.path.join(_ASSET_DIR, fname), px)
        else:
            font = ImageFont.truetype(os.path.join(_ASSET_DIR, "DMSans-var.ttf"), px)
            # Axes: [optical size 9-40, weight 100-1000]. Display sizes get the
            # tighter opsz-40 cut, matching the browser's auto optical sizing.
            font.set_variation_by_axes([max(9, min(40, size)), weight])
    except Exception:
        try:
            import matplotlib
            fname = "DejaVuSans-Bold.ttf" if weight >= 600 else "DejaVuSans.ttf"
            font = ImageFont.truetype(
                os.path.join(matplotlib.get_data_path(), "fonts", "ttf", fname), px)
        except Exception:
            font = ImageFont.load_default()
    _FONT_CACHE[key] = font
    return font


class _Canvas:
    """A 2x RGB card plus an alpha-blending ImageDraw, addressed in 1x card
    coordinates. finish() downsamples to CARD_W x CARD_H and encodes PNG."""

    def __init__(self):
        from PIL import Image, ImageDraw
        self.img = Image.new("RGB", (CARD_W * _S, CARD_H * _S), _BG)
        self.d = ImageDraw.Draw(self.img, "RGBA")

    @staticmethod
    def _xy(*vals):
        return [int(round(v * _S)) for v in vals]

    def textlength(self, s: str, font, tracking: float = 0.0) -> float:
        return (self.d.textlength(s, font=font) + tracking * _S * max(0, len(s) - 1)) / _S

    def text(self, x, y, s: str, font, fill, tracking: float = 0.0,
             anchor: str = "ls") -> float:
        """Draw s with its BASELINE at y (anchor 'ls'), optional letter-spacing
        in 1x px (kerning preserved by measuring prefixes). Returns end x."""
        if anchor.startswith("r"):
            x -= self.textlength(s, font, tracking)
            anchor = "l" + anchor[1:]
        X, Y = self._xy(x, y)
        if not tracking:
            self.d.text((X, Y), s, font=font, fill=fill, anchor=anchor)
        else:
            for i, ch in enumerate(s):
                cx = X + self.d.textlength(s[:i], font=font) + tracking * _S * i
                self.d.text((cx, Y), ch, font=font, fill=fill, anchor=anchor)
        return x + self.textlength(s, font, tracking)

    def rrect(self, box, r, fill=None, outline=None, width=1.0):
        self.d.rounded_rectangle(self._xy(*box), radius=int(r * _S), fill=fill,
                                 outline=outline, width=max(1, int(round(width * _S))))

    def ellipse(self, box, fill=None, outline=None, width=1.0):
        self.d.ellipse(self._xy(*box), fill=fill, outline=outline,
                       width=max(1, int(round(width * _S))))

    def line(self, pts, fill, width=1.0):
        self.d.line(self._xy(*[c for p in pts for c in p]), fill=fill,
                    width=max(1, int(round(width * _S))), joint="curve")

    def paste(self, im, x, y, mask=None):
        self.img.paste(im, (int(x * _S), int(y * _S)), mask)

    def finish(self) -> bytes:
        from PIL import Image
        out = self.img.resize((CARD_W, CARD_H), Image.LANCZOS)
        buf = io.BytesIO()
        out.save(buf, format="PNG", optimize=True)
        return buf.getvalue()


# --------------------------------------------------------------------------- #
# Brand pieces
# --------------------------------------------------------------------------- #
_LOGO = None


def _draw_logo(cv: _Canvas, cx: float, cy: float, size: float,
               opacity: float = 1.0) -> None:
    """Paste the site icon (green disc + orange cyclone/globe) centered at
    (cx, cy), `size` px across. Missing file → no logo, never an error."""
    global _LOGO
    from PIL import Image
    if _LOGO is None:
        try:
            _LOGO = Image.open(os.path.join(_ASSET_DIR, "tc-atlas-icon.png")).convert("RGBA")
        except Exception:
            _LOGO = False
    if not _LOGO:
        return
    px = int(round(size * _S))
    im = _LOGO.resize((px, px), Image.LANCZOS)
    if opacity < 1.0:
        a = im.getchannel("A").point(lambda v: int(v * opacity))
        im.putalpha(a)
    cv.img.paste(im, (int(round((cx - size / 2) * _S)), int(round((cy - size / 2) * _S))), im)


def _draw_header(cv: _Canvas, right_x: Optional[float] = None) -> None:
    """Site-header lockup: icon tile · TC-ATLAS · | · REAL-TIME MONITOR."""
    y = 66
    _draw_logo(cv, _PAD + 20, y - 9, 42)
    x = cv.text(_PAD + 50, y, "TC-ATLAS", _font(28, 700), _TEXT, tracking=-0.6)
    cv.line([(x + 16, y - 24), (x + 16, y + 4)], fill=_LINE_STRONG, width=1)
    cv.text(x + 32, y - 3, "REAL-TIME MONITOR", _font(14, 500), _MUTED, tracking=1.6)


def _chip(cv: _Canvas, x_right: float, y_top: float, text: str, font,
          fill=_TEXT, dot=None, tracking: float = 0.0) -> None:
    """Dark floating chip like the map overlay controls (right-aligned)."""
    tw = cv.textlength(text, font, tracking)
    pad_x, h = 14, 34
    dot_w = 16 if dot else 0
    x0 = x_right - (tw + 2 * pad_x + dot_w)
    cv.rrect((x0, y_top, x_right, y_top + h), 7, fill=_SURFACE + (232,),
             outline=_LINE_STRONG, width=1)
    if dot:
        cv.ellipse((x0 + pad_x, y_top + h / 2 - 4, x0 + pad_x + 8, y_top + h / 2 + 4), fill=dot)
    cv.text(x0 + pad_x + dot_w, y_top + h / 2, text, font, fill,
            tracking=tracking, anchor="lm")


def _live_chip(cv: _Canvas) -> None:
    """Orange LIVE chip, top-right over the imagery (site: orange = live)."""
    f = _font(14, 600)
    tw = cv.textlength("LIVE", f, 1.4)
    x1, y0, h = CARD_W - 32, 32, 34
    x0 = x1 - (tw + 28 + 16)
    cv.rrect((x0, y0, x1, y0 + h), 7, fill=(46, 26, 14, 235),
             outline=_ORANGE + (150,), width=1)
    cv.ellipse((x0 + 14, y0 + h / 2 - 4, x0 + 22, y0 + h / 2 + 4), fill=_ORANGE)
    cv.text(x0 + 30, y0 + h / 2, "LIVE", f, _ORANGE_INK, tracking=1.4, anchor="lm")


# --------------------------------------------------------------------------- #
# Storm metadata helpers
# --------------------------------------------------------------------------- #
def _cat_code(category: str, vmax_kt) -> str:
    """Normalize to TD/TS/C1..C5, or '' for invests/unknown."""
    cat = (category or "").strip().upper().replace(" ", "")
    if cat.startswith("CAT"):
        cat = "C" + cat[3:]
    if cat in _CAT_COLORS:
        return cat
    try:
        v = int(vmax_kt)
    except (TypeError, ValueError):
        return ""
    for code, thr in (("C5", 137), ("C4", 113), ("C3", 96), ("C2", 83),
                      ("C1", 64), ("TS", 34)):
        if v >= thr:
            return code
    return ""


def _cat_label_color(category: str, vmax_kt, basin: str) -> tuple:
    """Human label + accent color. West-Pacific hurricanes are 'Typhoon',
    North-Indian / Southern-Hemisphere ones 'Cyclone'."""
    code = _cat_code(category, vmax_kt)
    b = str(basin or "").strip().lower().replace(" ", "")
    if b in ("wpac", "wp") or b.startswith("west"):
        hur_word = "Typhoon"
    elif b in ("nio", "io", "ni", "shem", "sh", "spac", "sio", "aus"):
        hur_word = "Cyclone"
    else:
        hur_word = "Hurricane"
    if code.startswith("C"):
        return (f"Category {code[1]} {hur_word}", _CAT_COLORS[code])
    if code == "TS":
        return ("Tropical Storm", _CAT_COLORS["TS"])
    if (category or "").strip().upper() == "TD":
        return ("Tropical Depression", _CAT_COLORS["TD"])
    return ("Disturbance", _MUTED)


# Friendly basin labels (endpoint emits codes like "WPAC"/"EPAC"). Unknown
# codes fall through to the raw string.
_BASIN_LABELS = {
    "atl": "Atlantic", "natl": "Atlantic", "al": "Atlantic",
    "epac": "East Pacific", "ep": "East Pacific",
    "cpac": "Central Pacific", "cp": "Central Pacific",
    "wpac": "West Pacific", "wp": "West Pacific",
    "nio": "North Indian", "io": "Indian Ocean", "ni": "North Indian",
    "shem": "Southern Hemisphere", "sh": "Southern Hemisphere",
    "spac": "South Pacific", "sio": "South Indian", "aus": "Australian",
}


def _basin_label(basin) -> str:
    key = str(basin or "").strip().lower().replace(" ", "")
    return _BASIN_LABELS.get(key, str(basin or "").strip())


def _short_id(storm: dict) -> str:
    """AL092026 -> AL09."""
    a = str(storm.get("atcf_id") or "").strip().upper()
    return a[:4] if len(a) >= 4 else a


def _num(v) -> Optional[int]:
    if v in (None, ""):
        return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


_COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def _motion(storm: dict) -> Optional[str]:
    d, s = _num(storm.get("motion_deg")), _num(storm.get("motion_kt"))
    if d is None or s is None:
        return None
    if s == 0:
        return "Stationary"
    return f"{_COMPASS[int((d % 360) / 22.5 + 0.5) % 16]} {s}"


def _parse_iso(valid_utc: Optional[str]) -> Optional[datetime]:
    if not valid_utc:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%MZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(valid_utc, fmt).replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
    return None


def _fmt_valid(valid_utc: Optional[str]) -> str:
    """ISO 'YYYY-MM-DDTHH:MM:SSZ' -> 'HH:MM UTC DD Mon'."""
    dt = _parse_iso(valid_utc) or (None if valid_utc else datetime.now(timezone.utc))
    if dt is None:
        return str(valid_utc)
    return dt.strftime("%H%M UTC %d %b")


# --------------------------------------------------------------------------- #
# IR backdrop
# --------------------------------------------------------------------------- #
def _ir_backdrop(tb: np.ndarray):
    """Render a Tb array to an opaque RGB PIL image sized to the IR square,
    using the same colormap/normalization as the live frames."""
    from PIL import Image

    arr = np.asarray(tb, dtype=np.float32)
    frac = 1.0 - (arr - IR_VMIN) / (IR_VMAX - IR_VMIN)
    frac = np.nan_to_num(np.clip(frac, 0.0, 1.0), nan=0.0)
    indices = (frac * 255).astype(np.uint8)
    rgba = _IR_LUT[indices].copy()  # (H, W, 4)
    rgba[~np.isfinite(arr) | (arr <= 0)] = [_BG[0], _BG[1], _BG[2], 255]
    img = Image.fromarray(rgba, "RGBA").convert("RGB")
    return img.resize((_IR_SQUARE * _S, _IR_SQUARE * _S), Image.LANCZOS)


def _ir_square_from_image(img_bytes: bytes):
    """Decode a PRE-RENDERED IR image (a cached Mercator WebP) and fit it to the
    IR square. Transparent / off-disk pixels fall back to the background."""
    from PIL import Image
    im = Image.open(io.BytesIO(img_bytes))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, _BG + (255,))
        im = Image.alpha_composite(bg, im).convert("RGB")
    else:
        im = im.convert("RGB")
    return im.resize((_IR_SQUARE * _S, _IR_SQUARE * _S), Image.LANCZOS)


def _paste_ir_backdrop(cv: _Canvas, ir_square) -> None:
    """Paste the IR square on the right and fade its left seam into the page
    background with an eased ramp, plus a soft bottom shade for the chips."""
    from PIL import Image

    cv.paste(ir_square, _IR_X, 0)
    grad_w = 240 * _S
    ramp = np.linspace(1.0, 0.0, grad_w, dtype=np.float32)
    alpha = (255 * ramp ** 1.6).astype(np.uint8)
    a = np.repeat(alpha[None, :], CARD_H * _S, axis=0)
    layer = np.zeros((CARD_H * _S, grad_w, 4), dtype=np.uint8)
    layer[..., :3] = _BG
    layer[..., 3] = a
    grad = Image.fromarray(layer, "RGBA")
    cv.img.paste(grad, (_IR_X * _S, 0), grad)

    # Faint center reticle — the cutout is storm-centered.
    cx, cy = _IR_X + _IR_SQUARE / 2, CARD_H / 2
    for x0, y0, x1, y1 in ((cx - 26, cy, cx - 12, cy), (cx + 12, cy, cx + 26, cy),
                           (cx, cy - 26, cx, cy - 12), (cx, cy + 12, cx, cy + 26)):
        cv.line([(x0, y0), (x1, y1)], fill=(255, 255, 255, 150), width=1.5)


# --------------------------------------------------------------------------- #
# Composers
# --------------------------------------------------------------------------- #
def _stat_tile(cv: _Canvas, x, y, w, label: str, value: str, unit: str) -> None:
    h = 92
    cv.rrect((x, y, x + w, y + h), 8, fill=_SURFACE, outline=_LINE_STRONG, width=1)
    cv.text(x + 16, y + 28, label, _font(12, 600), _MUTED, tracking=1.3)
    vf = _font(34, 500, mono=True)
    ex = cv.text(x + 16, y + 72, value, vf, _TEXT)
    if unit:
        cv.text(ex + 6, y + 72, unit, _font(16, 500), _MUTED)


def _compose_storm_card(ir_square, storm: dict,
                        valid_utc: Optional[str]) -> Optional[bytes]:
    """Single-storm hero: IR on the right, name/category/vitals on the left."""
    cv = _Canvas()
    _paste_ir_backdrop(cv, ir_square)
    _draw_header(cv)
    _live_chip(cv)

    label, accent = _cat_label_color(
        storm.get("category"), storm.get("vmax_kt"), storm.get("basin"))

    # Eyebrow: basin · AL09
    eyebrow = "  ·  ".join(b for b in (_basin_label(storm.get("basin")).upper(),
                                       _short_id(storm)) if b)
    cv.text(_PAD, 170, eyebrow, _font(15, 500, mono=True), _MUTED, tracking=1.2)

    # Name — large, shrink to fit the text column.
    name = str(storm.get("name") or storm.get("atcf_id") or "Tropical Cyclone")
    if name.isupper() and len(name) > 3:
        name = name.title()
    max_w = _IR_X - _PAD - 20
    size = 92
    while size > 44 and cv.textlength(name, _font(size, 650), -size * 0.025) > max_w:
        size -= 4
    cv.text(_PAD - 3, 172 + size * 0.86, name, _font(size, 650), _TEXT,
            tracking=-size * 0.025)

    # Category: colored dot + label.
    cy = 172 + size * 0.86 + 50
    cv.ellipse((_PAD, cy - 18, _PAD + 14, cy - 4), fill=accent)
    cv.text(_PAD + 26, cy, label, _font(26, 600), accent)

    # Vitals tiles.
    tiles = []
    v = _num(storm.get("vmax_kt"))
    if v is not None:
        tiles.append(("MAX WIND", str(v), "kt"))
    p = _num(storm.get("mslp_hpa"))
    if p is not None:
        tiles.append(("PRESSURE", str(p), "hPa"))
    m = _motion(storm)
    if m is not None:
        parts = m.split(" ")
        tiles.append(("MOTION", parts[0], parts[1] + " kt" if len(parts) > 1 else ""))
    if tiles:
        gap = 12
        tw = (max_w - gap * (len(tiles) - 1)) / len(tiles)
        tw = min(tw, 168)
        for i, (lab, val, unit) in enumerate(tiles):
            _stat_tile(cv, _PAD + i * (tw + gap), cy + 30, tw, lab, val, unit)

    # Imagery chip, bottom-right over the IR.
    sat = str(storm.get("satellite") or "").strip()
    chip = "  ".join(b for b in (f"{sat} IR" if sat else "IR", _fmt_valid(valid_utc)) if b)
    _chip(cv, CARD_W - 32, CARD_H - 32 - 34, chip, _font(14, 400, mono=True))

    # Advisory line (kept above the bottom-left strip X overlays its title on).
    adv = _parse_iso(storm.get("last_fix_utc"))
    src = str(storm.get("source") or "").strip()
    if adv:
        line = f"Advisory {adv.strftime('%H%M UTC %d %b')}" + (f"  ·  {src}" if src else "")
        cv.text(_PAD, cy + 30 + 92 + 40, line, _font(14, 400, mono=True), _MUTED)

    return cv.finish()


def render_storm_card_from_image(storm: dict, ir_img_bytes: bytes,
                                 valid_utc: Optional[str] = None) -> Optional[bytes]:
    """Preferred entry point: render the live-storm card using a PRE-RENDERED
    IR image. Returns None on failure. Never raises."""
    try:
        return _compose_storm_card(_ir_square_from_image(ir_img_bytes), storm, valid_utc)
    except Exception:
        import traceback
        traceback.print_exc()
        return None


def render_storm_card_png(storm: dict, tb: np.ndarray,
                          valid_utc: Optional[str] = None) -> Optional[bytes]:
    """Render the live-storm card from a raw brightness-temperature array `tb`.
    Returns None on failure. Never raises."""
    try:
        return _compose_storm_card(_ir_backdrop(tb), storm, valid_utc)
    except Exception:
        import traceback
        traceback.print_exc()
        return None


def render_branded_card_png() -> Optional[bytes]:
    """Off-season fallback card (no active storms, or no imagery). Never raises."""
    try:
        cv = _Canvas()

        # Big site icon on the right, with faint concentric rings around it.
        mx, my, ms = 905, 315, 430
        for r in (265, 335, 405, 475):
            cv.ellipse((mx - r, my - r, mx + r, my + r), outline=(255, 255, 255, 11), width=1)
        _draw_logo(cv, mx, my, ms)

        cv.text(_PAD - 4, 300, "TC-ATLAS", _font(104, 700), _TEXT, tracking=-3.6)
        cv.text(_PAD, 356, "Real-time tropical cyclone monitor", _font(32, 500), _TEXT)
        cv.text(_PAD, 400, "Global infrared  ·  recon  ·  microwave  ·  model guidance",
                _font(19, 400), _MUTED)
        cv.line([(_PAD, 448), (_PAD + 56, 448)], fill=_ORANGE, width=3)
        cv.text(_PAD, 488, "tcatlas.org", _font(18, 500, mono=True), _GREEN)
        return cv.finish()
    except Exception:
        import traceback
        traceback.print_exc()
        return None


def _intensity_key(s: dict):
    """Sort key: highest sustained wind, then lower MSLP (deeper), then name
    for determinism so the card doesn't flap between equally-rated storms."""
    try:
        v = float(s.get("vmax_kt") or 0)
    except (TypeError, ValueError):
        v = 0.0
    try:
        p = float(s.get("mslp_hpa") or 9999)
    except (TypeError, ValueError):
        p = 9999.0
    return (v, -p, str(s.get("name") or s.get("atcf_id") or ""))


def pick_most_intense(storms: list) -> Optional[dict]:
    """Return the active storm with the highest sustained wind, or None."""
    if not storms:
        return None
    return max(storms, key=_intensity_key)


def _sorted_by_intensity(storms: list) -> list:
    """All storms strongest-first (same ordering as pick_most_intense)."""
    return sorted(storms, key=_intensity_key, reverse=True)


_BASIN_CODES = {"atl": "ATL", "natl": "ATL", "al": "ATL", "epac": "EPAC",
                "ep": "EPAC", "cpac": "CPAC", "cp": "CPAC", "wpac": "WPAC",
                "wp": "WPAC", "nio": "NIO", "io": "NIO", "ni": "NIO"}


def _basin_code(basin) -> str:
    key = str(basin or "").strip().lower().replace(" ", "")
    return _BASIN_CODES.get(key, "SHEM" if key in ("shem", "sh", "spac", "sio", "aus")
                            else str(basin or "").strip().upper())


def _compose_multistorm_card(ir_square, storms: list, valid_utc: Optional[str],
                             backdrop_storm: Optional[dict] = None) -> Optional[bytes]:
    """Busy-tropics card: a roster of EVERY active system on the left over the
    backdrop storm's IR on the right. Never raises (caller wraps)."""
    cv = _Canvas()
    _paste_ir_backdrop(cv, ir_square)
    _draw_header(cv)
    _live_chip(cv)

    ordered = _sorted_by_intensity(storms)
    n = len(ordered)

    # Title + basin tally (echoes the site's status strip: "1 ATL 3 EPAC …").
    cv.text(_PAD - 2, 170, f"{n} active systems", _font(46, 650), _TEXT, tracking=-1.0)
    counts: dict = {}
    for s in ordered:
        c = _basin_code(s.get("basin"))
        counts[c] = counts.get(c, 0) + 1
    x = _PAD
    for code, cnt in counts.items():
        x = cv.text(x, 206, str(cnt), _font(15, 500, mono=True), _TEXT)
        x = cv.text(x + 6, 206, code, _font(15, 400, mono=True), _MUTED) + 20

    MAX_ROWS = 6
    if n > MAX_ROWS:
        shown, overflow = ordered[:MAX_ROWS - 1], n - (MAX_ROWS - 1)
    else:
        shown, overflow = ordered, 0

    col_r = _IR_X - 4            # right edge of the roster table
    row_y, row_h = 236, 50
    for s in shown:
        cv.line([(_PAD, row_y), (col_r, row_y)], fill=_LINE, width=1)
        code = _cat_code(s.get("category"), s.get("vmax_kt"))
        _, accent = _cat_label_color(s.get("category"), s.get("vmax_kt"), s.get("basin"))
        badge = code or "—"
        bf = _font(13, 500, mono=True)
        mid = row_y + row_h / 2
        cv.rrect((_PAD, mid - 13, _PAD + 40, mid + 13), 5, fill=accent + (46,),
                 outline=accent + (170,), width=1)
        cv.text(_PAD + 20 - cv.textlength(badge, bf) / 2, mid, badge, bf, accent, anchor="lm")

        name = str(s.get("name") or s.get("atcf_id") or "—")
        if name.isupper() and len(name) > 3:
            name = name.title()
        nf = _font(24, 600)
        cv.text(_PAD + 56, mid, name, nf, _TEXT, anchor="lm")

        v = _num(s.get("vmax_kt"))
        vx = col_r - 72
        if v is not None:
            ex = cv.text(vx, mid, str(v), _font(20, 500, mono=True), _TEXT, anchor="rm")
            cv.text(ex + 4, mid, "kt", _font(13, 500), _MUTED, anchor="lm")
        cv.text(vx - 74, mid, _basin_code(s.get("basin")), _font(14, 400, mono=True),
                _MUTED, anchor="rm")
        row_y += row_h
    cv.line([(_PAD, row_y), (col_r, row_y)], fill=_LINE, width=1)

    if overflow:
        cv.text(_PAD + 56, row_y + 30,
                f"+ {overflow} more active system{'s' if overflow != 1 else ''}",
                _font(16, 600), _ORANGE)

    bs = backdrop_storm or (ordered[0] if ordered else {})
    bname = str(bs.get("name") or bs.get("atcf_id") or "").strip()
    if bname.isupper() and len(bname) > 3:
        bname = bname.title()
    sat = str(bs.get("satellite") or "").strip()
    chip = "  ".join(b for b in (bname, f"{sat} IR" if sat else "IR",
                                 _fmt_valid(valid_utc)) if b)
    _chip(cv, CARD_W - 32, CARD_H - 32 - 34, chip, _font(14, 400, mono=True))

    return cv.finish()


def render_multistorm_card_from_image(storms: list, ir_img_bytes: bytes,
                                      valid_utc: Optional[str] = None,
                                      backdrop_storm: Optional[dict] = None
                                      ) -> Optional[bytes]:
    """Multi-storm roster card from a PRE-RENDERED IR backdrop. Returns None on
    failure; never raises."""
    try:
        return _compose_multistorm_card(
            _ir_square_from_image(ir_img_bytes), storms, valid_utc, backdrop_storm)
    except Exception:
        import traceback
        traceback.print_exc()
        return None


def render_multistorm_card_png(storms: list, tb: np.ndarray,
                               valid_utc: Optional[str] = None,
                               backdrop_storm: Optional[dict] = None
                               ) -> Optional[bytes]:
    """Multi-storm roster card from a raw Tb backdrop. Returns None on failure;
    never raises."""
    try:
        return _compose_multistorm_card(_ir_backdrop(tb), storms, valid_utc,
                                        backdrop_storm)
    except Exception:
        import traceback
        traceback.print_exc()
        return None
