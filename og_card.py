#!/usr/bin/env python3
"""
Dynamic social-media "OG card" renderer for TC-ATLAS.

Produces a 1200x630 PNG suitable for og:image / twitter:image. When tropical
cyclones are active, the card features a live infrared image of the current
most-intense storm plus its vitals; in the off-season it falls back to a
branded card. The prewarm Cloud Run Job regenerates it every cycle and uploads
it to a STABLE, version-independent GCS key, so the og:image meta tag never
needs to change (see ir_monitor_api._build_and_upload_og_card).

Pure rendering only — no GCS or network here, so it stays trivially testable
with a synthetic Tb array. Fetch + upload orchestration lives in
ir_monitor_api.py, which already owns the satellite fetch and GCS helpers.
"""
from __future__ import annotations

import io
from datetime import datetime, timezone
from typing import Optional

import numpy as np

# Reuse the EXACT IR colormap + normalization the live frames use, so the card
# looks identical to what a visitor sees on the site.
from satellite_ir import _IR_LUT, IR_VMIN, IR_VMAX

CARD_W, CARD_H = 1200, 630
_IR_SQUARE = CARD_H          # IR backdrop is a CARD_H x CARD_H square on the right
_IR_X = CARD_W - _IR_SQUARE  # left edge of the IR square (570)

# Theme (matches realtime_ir_styles.css / the dark navy site theme)
_NAVY = (15, 23, 42)         # #0f172a background
_CYAN = (0, 229, 255)        # #00e5ff accent
_WHITE = (241, 245, 249)     # near-white text
_DIM = (148, 163, 184)       # slate-400 secondary text

# Saffir-Simpson swatch colors — mirror STORM_COLORS in realtime_ir.js.
_CAT_COLORS = {
    "TD": (96, 165, 250), "TS": (52, 211, 153), "C1": (251, 191, 36),
    "C2": (251, 146, 60), "C3": (248, 113, 113), "C4": (239, 68, 68),
    "C5": (220, 38, 38),
}


# --------------------------------------------------------------------------- #
# Fonts — matplotlib bundles DejaVu Sans TTFs, which are present in the deployed
# image (matplotlib>=3.8 is a hard dependency). python:3.11-slim ships no system
# fonts, so this is the reliable path. Resolved lazily + cached.
# --------------------------------------------------------------------------- #
_FONT_CACHE: dict = {}


def _font(size: int, bold: bool = False):
    key = (size, bold)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    from PIL import ImageFont
    font = None
    # Prefer the TTFs matplotlib bundles in mpl-data — referencing the file
    # directly avoids font_manager's full system-font scan/cache build on each
    # fresh Cloud Run Job process (faster + deterministic in the slim image).
    try:
        import os
        import matplotlib
        fname = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
        path = os.path.join(matplotlib.get_data_path(), "fonts", "ttf", fname)
        font = ImageFont.truetype(path, size)
    except Exception:
        try:
            from matplotlib import font_manager
            prop = font_manager.FontProperties(
                family="DejaVu Sans", weight=("bold" if bold else "normal"))
            font = ImageFont.truetype(
                font_manager.findfont(prop, fallback_to_default=True), size)
        except Exception:
            font = ImageFont.load_default()
    _FONT_CACHE[key] = font
    return font


def _cat_label_color(category: str, vmax_kt, basin: str) -> tuple:
    """Map a storm's category code to a human label + accent color.

    `category` is the short code from _build_storm_entry ("TD", "TS", "Cat 3").
    West-Pacific hurricanes are 'Typhoon' by convention.
    """
    cat = (category or "").strip()
    is_wpac = (basin or "").lower().startswith("west")
    hur_word = "Typhoon" if is_wpac else "Hurricane"
    if cat.lower().startswith("cat"):
        num = cat.split()[-1] if " " in cat else cat[3:]
        return (f"Category {num} {hur_word}", _CAT_COLORS.get("C" + str(num), _CAT_COLORS["C1"]))
    if cat.upper() == "TS":
        return ("Tropical Storm", _CAT_COLORS["TS"])
    if cat.upper() == "TD":
        return ("Tropical Depression", _CAT_COLORS["TD"])
    # Invests / unknown
    try:
        v = int(vmax_kt)
    except (TypeError, ValueError):
        v = 0
    if v >= 34:
        return ("Tropical Storm", _CAT_COLORS["TS"])
    return ("Disturbance", _DIM)


def _ir_backdrop(tb: np.ndarray):
    """Render a Tb array to an opaque RGB PIL image sized to the IR square,
    using the same colormap/normalization as the live frames. Cold clouds
    (low Tb) map bright; missing data falls back to navy."""
    from PIL import Image

    arr = np.asarray(tb, dtype=np.float32)
    frac = 1.0 - (arr - IR_VMIN) / (IR_VMAX - IR_VMIN)
    frac = np.clip(frac, 0.0, 1.0)
    indices = (frac * 255).astype(np.uint8)
    rgba = _IR_LUT[indices].copy()  # (H, W, 4)
    rgba[~np.isfinite(arr) | (arr <= 0)] = [_NAVY[0], _NAVY[1], _NAVY[2], 255]
    img = Image.fromarray(rgba, "RGBA").convert("RGB")
    return img.resize((_IR_SQUARE, _IR_SQUARE), Image.LANCZOS)


def _fmt_valid(valid_utc: Optional[str]) -> str:
    """ISO 'YYYY-MM-DDTHH:MM:SSZ' -> 'HH:MM UTC · DD Mon'."""
    if not valid_utc:
        return datetime.now(timezone.utc).strftime("%H:%M UTC · %d %b")
    try:
        dt = datetime.strptime(valid_utc, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return dt.strftime("%H:%M UTC · %d %b")
    except Exception:
        return valid_utc


def _draw_wordmark(draw, x: int, y: int):
    draw.text((x, y), "TC-ATLAS", font=_font(30, bold=True), fill=_CYAN)
    draw.text((x, y + 38), "Real-Time Tropical Cyclone Monitor",
              font=_font(16), fill=_DIM)


def _ir_square_from_image(img_bytes: bytes):
    """Decode a PRE-RENDERED IR image (the cached Mercator WebP the prewarm
    already produced) and fit it to the IR square. This is the zero-extra-cost
    backdrop path: it reuses the colormapped frame instead of re-fetching Tb
    from S3. Transparent / off-disk pixels fall back to navy."""
    from PIL import Image
    im = Image.open(io.BytesIO(img_bytes))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (_NAVY[0], _NAVY[1], _NAVY[2], 255))
        im = Image.alpha_composite(bg, im).convert("RGB")
    else:
        im = im.convert("RGB")
    return im.resize((_IR_SQUARE, _IR_SQUARE), Image.LANCZOS)


def _compose_storm_card(ir_square, storm: dict,
                        valid_utc: Optional[str]) -> Optional[bytes]:
    """Compose the final card from an already-prepared CARD_H x CARD_H RGB IR
    square plus the storm's text panel. Shared by both the Tb and pre-rendered-
    image entry points. Never raises (caller wraps)."""
    from PIL import Image, ImageDraw

    card = Image.new("RGB", (CARD_W, CARD_H), _NAVY)

    # IR backdrop on the right half.
    card.paste(ir_square, (_IR_X, 0))

    # Navy→transparent gradient over the IR's left edge to blend the seam
    # so the text panel reads cleanly into the imagery.
    grad_w = 160
    grad = Image.new("RGBA", (grad_w, CARD_H), (0, 0, 0, 0))
    gpx = grad.load()
    for gx in range(grad_w):
        a = int(255 * (1.0 - gx / grad_w))
        for gy in range(CARD_H):
            gpx[gx, gy] = (_NAVY[0], _NAVY[1], _NAVY[2], a)
    card.paste(grad, (_IR_X, 0), grad)

    draw = ImageDraw.Draw(card)
    pad = 48
    _draw_wordmark(draw, pad, 44)

    # LIVE badge (top, under the wordmark area on the right of the panel).
    badge = "● LIVE"
    bf = _font(16, bold=True)
    bw = draw.textlength(badge, font=bf)
    draw.text((_IR_X - pad - bw, 50), badge, font=bf, fill=(248, 113, 113))

    name = str(storm.get("name") or storm.get("atcf_id") or "Tropical Cyclone")
    label, accent = _cat_label_color(
        storm.get("category"), storm.get("vmax_kt"), storm.get("basin"))

    # Storm name — large, shrink to fit the panel width if needed.
    max_w = _IR_X - pad - 24
    size = 66
    while size > 34:
        f = _font(size, bold=True)
        if draw.textlength(name, font=f) <= max_w:
            break
        size -= 4
    name_font = _font(size, bold=True)
    draw.text((pad, 250), name, font=name_font, fill=_WHITE)

    # Category line (accent-colored).
    draw.text((pad, 250 + size + 14), label, font=_font(30, bold=True), fill=accent)

    # Vitals: wind · pressure.
    vmax = storm.get("vmax_kt")
    mslp = storm.get("mslp_hpa")
    vitals = []
    if vmax not in (None, ""):
        try:
            vitals.append(f"{int(round(float(vmax)))} kt")
        except (TypeError, ValueError):
            pass
    if mslp not in (None, ""):
        try:
            vitals.append(f"{int(round(float(mslp)))} hPa")
        except (TypeError, ValueError):
            pass
    if vitals:
        draw.text((pad, 250 + size + 58), "   ·   ".join(vitals),
                  font=_font(28), fill=_WHITE)

    # Basin · valid time · satellite.
    basin = str(storm.get("basin") or "").strip()
    sat = str(storm.get("satellite") or "").strip()
    meta_bits = [b for b in (basin, _fmt_valid(valid_utc), sat) if b]
    draw.text((pad, 250 + size + 100), "   ·   ".join(meta_bits),
              font=_font(17), fill=_DIM)

    # Footer CTA.
    draw.text((pad, CARD_H - 56),
              "Track it live  →  michaelfischerwx.github.io/TC-ATLAS",
              font=_font(18, bold=True), fill=_CYAN)

    return _encode(card)


def render_storm_card_from_image(storm: dict, ir_img_bytes: bytes,
                                 valid_utc: Optional[str] = None) -> Optional[bytes]:
    """Preferred entry point: render the live-storm card using a PRE-RENDERED
    IR image (the cached Mercator WebP the prewarm already wrote this cycle),
    so no Tb re-fetch / reproject is needed. Returns None on failure. Never
    raises."""
    try:
        return _compose_storm_card(_ir_square_from_image(ir_img_bytes), storm, valid_utc)
    except Exception:
        import traceback
        traceback.print_exc()
        return None


def render_storm_card_png(storm: dict, tb: np.ndarray,
                          valid_utc: Optional[str] = None) -> Optional[bytes]:
    """Fallback entry point: render the live-storm card from a raw brightness-
    temperature array `tb` (used only when no cached frame exists yet, e.g. a
    storm's first cycle). Returns None on failure. Never raises."""
    try:
        return _compose_storm_card(_ir_backdrop(tb), storm, valid_utc)
    except Exception:
        import traceback
        traceback.print_exc()
        return None


def render_branded_card_png() -> Optional[bytes]:
    """Off-season fallback card (no active storms). Branded, no imagery, so the
    og:image URL always resolves to something appropriate. Never raises."""
    try:
        from PIL import Image, ImageDraw

        card = Image.new("RGB", (CARD_W, CARD_H), _NAVY)
        draw = ImageDraw.Draw(card)

        # Subtle cyan accent bar down the left edge.
        draw.rectangle([0, 0, 10, CARD_H], fill=_CYAN)

        cx = 80
        draw.text((cx, 150), "TC-ATLAS", font=_font(88, bold=True), fill=_WHITE)
        draw.text((cx, 270), "Real-Time Tropical Cyclone Monitor",
                  font=_font(34), fill=_CYAN)
        draw.text((cx, 330),
                  "Live GOES & Himawari infrared  ·  global coverage  ·  intensity & forecast tracks",
                  font=_font(20), fill=_DIM)
        draw.text((cx, CARD_H - 70),
                  "michaelfischerwx.github.io/TC-ATLAS",
                  font=_font(20, bold=True), fill=_CYAN)
        return _encode(card)
    except Exception:
        import traceback
        traceback.print_exc()
        return None


def _encode(card) -> bytes:
    buf = io.BytesIO()
    card.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def pick_most_intense(storms: list) -> Optional[dict]:
    """Return the active storm with the highest sustained wind, or None.

    Ties broken by lower MSLP (deeper), then by name for determinism so the
    card doesn't flap between equally-rated storms on successive cycles."""
    if not storms:
        return None

    def _key(s):
        try:
            v = float(s.get("vmax_kt") or 0)
        except (TypeError, ValueError):
            v = 0.0
        try:
            p = float(s.get("mslp_hpa") or 9999)
        except (TypeError, ValueError):
            p = 9999.0
        return (v, -p, str(s.get("name") or s.get("atcf_id") or ""))

    return max(storms, key=_key)
