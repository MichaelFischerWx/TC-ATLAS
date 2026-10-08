#!/usr/bin/env python3
"""Light-weight social OG-card + rt-version refresh, decoupled from the heavy
ir_monitor_api render stack.

This module imports ONLY satellite_ir (light: numpy at load, xarray/s3fs lazy)
and og_card (numpy + PIL) — and crucially NOT ir_monitor_api, which loads
pyart/cartopy + the ~13.5k-storm IBTrACS DB at import (~minutes of cold-start
work). That lets a standalone Cloud Run Job (ogcard_job.py) refresh the card on
a cheap hourly cadence so the prewarm job — whose only remaining UNIQUE outputs
were the OG card + rt-version.json — can be paused now that the storm card
defaults to the lite mosaic view (raw-Tb frames render on demand via Detailed).

Both ir_monitor_api (inside a prewarm cycle, while prewarm still runs) and
ogcard_job delegate here, so the card-building logic lives in exactly one place.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional


def put_rt_version(bucket, version: str, base: Optional[str] = None,
                   log: Callable[[str], None] = print) -> None:
    """Publish {"version": <ver>[, "base": <cdn>]} to rt-version.json at the
    bucket root so the frontend discovers the live cache version at runtime (it
    fetches bundles straight from GCS/R2 and can't otherwise see a server-side
    bump). ~30 bytes, idempotent; only the contents change at deploy time."""
    if bucket is None:
        return
    try:
        payload = {"version": version}
        if base:
            payload["base"] = base
        blob = bucket.blob("rt-version.json")
        blob.cache_control = "public, max-age=120"
        blob.upload_from_string(
            json.dumps(payload),
            content_type="application/json",
            predefined_acl="publicRead", timeout=15,
        )
    except Exception as ex:
        log(f"[OG] rt-version.json upload failed: {ex}")


def build_and_upload_og_card(
    storms: list, *, bucket, og_key: str,
    ir_webp_locator: Optional[Callable[[str], tuple]] = None,
    interval_min: int = 30, force: bool = False,
    log: Callable[[str], None] = print,
) -> bool:
    """Render the dynamic social OG card and upload it to og_key. Count-adaptive:
    0 active storms → branded fallback; exactly 1 → single-storm hero; ≥2 → a
    roster of every active system over the strongest storm's IR backdrop.
    Best-effort — returns True on a successful upload, False otherwise; never
    raises (so it can't break a caller's cycle).

    ir_webp_locator(atcf_id) -> (webp_bytes, dt_str): OPTIONAL fast path that
    reuses an already-rendered Mercator IR WebP (the prewarm cycle passes its
    _latest_ir_webp). When None or it yields nothing, this falls back to a direct
    satellite_ir fetch — so the card builds with no prewarm-produced frame
    present (the standalone hourly job relies on exactly this).

    force: skip the every-`interval_min` throttle. The standalone hourly job sets
    this (it's already infrequent); the prewarm cycle leaves it False so the card
    self-throttles within prewarm's */15 grid (render churn stays ~48×/day)."""
    if bucket is None:
        return False
    blob = bucket.blob(og_key)

    if not force:
        # Off-cycle: skip the render+IR-fetch unless the card is missing, so the
        # expensive path runs ~every interval_min yet self-heals a first run or a
        # deleted object. blob.exists() is a cheap Class-B GCS op.
        interval = max(10, int(interval_min))
        is_og_cycle = (datetime.now(timezone.utc).minute % interval) < 10
        if not is_og_cycle:
            try:
                if blob.exists():
                    return False
            except Exception:
                return False

    try:
        import og_card
    except Exception as ex:
        log(f"[OG] card module import failed: {ex}")
        return False

    png = None
    ordered = og_card._sorted_by_intensity(storms) if storms else []
    storm = ordered[0] if ordered else None
    # Count-adaptive: ≥2 → roster card over one storm's IR backdrop; avoids
    # arbitrarily anointing one storm when the tropics are busy.
    multi = len(ordered) >= 2
    # Backdrop: strongest storm first, but fall through the rest when its IR
    # isn't available — before this, a single missing Himawari scan (the :00
    # slot isn't on S3 yet when the hourly job runs) dropped a 6-storm day to
    # the branded card every hour. Storms poleward of 35° (usually going
    # extratropical — a shapeless backdrop) drop to the back of the queue; the
    # roster itself stays in strict intensity order.
    def _poleward(s):
        try:
            return abs(float(s.get("lat"))) > 35.0
        except (TypeError, ValueError):
            return False
    for cand in sorted(ordered, key=_poleward)[:4]:
        webp, valid, tb = _backdrop_for(cand, ir_webp_locator, log)
        if webp is None and tb is None:
            continue
        if multi:
            png = (og_card.render_multistorm_card_from_image(
                       storms, webp, valid_utc=valid, backdrop_storm=cand)
                   if webp else
                   og_card.render_multistorm_card_png(
                       storms, tb, valid_utc=valid, backdrop_storm=cand))
        else:
            png = (og_card.render_storm_card_from_image(cand, webp, valid_utc=valid)
                   if webp else
                   og_card.render_storm_card_png(cand, tb, valid_utc=valid))
        if png:
            storm = cand
            break

    if png is None:
        # No active storms, or the IR fetch/render failed → branded fallback so
        # the og:image URL always resolves to a good image.
        png = og_card.render_branded_card_png()
        storm = None
    if not png:
        return False

    try:
        # Short TTL so social re-scrapes pick up the live storm.
        blob.cache_control = "public, max-age=600"
        blob.upload_from_string(
            png, content_type="image/png",
            predefined_acl="publicRead", timeout=30)
        if not storm:
            tag = "branded fallback"
        elif multi:
            tag = f"{len(storms)} systems (backdrop {storm['atcf_id']})"
        else:
            tag = "storm " + storm["atcf_id"]
        log(f"[OG] card updated ({tag})")
        return True
    except Exception as ex:
        log(f"[OG] card upload failed: {ex}")
        return False


def _backdrop_for(storm: dict, ir_webp_locator, log) -> tuple:
    """IR backdrop for one storm → (webp_bytes, valid_iso, tb). Tries the
    cached-WebP fast path, then a direct fetch at now, then 20 min earlier
    (Himawari/Meteosat full disks land on S3 ~15-20 min after nominal).
    Returns (None, None, None) when nothing is available."""
    if ir_webp_locator is not None:
        try:
            webp, dstr = ir_webp_locator(storm["atcf_id"])
        except Exception:
            webp, dstr = None, None
        if webp:
            valid = None
            if dstr and len(dstr) >= 12 and dstr[:12].isdigit():
                valid = (f"{dstr[0:4]}-{dstr[4:6]}-{dstr[6:8]}"
                         f"T{dstr[8:10]}:{dstr[10:12]}:00Z")
            return webp, valid, None
    try:
        from satellite_ir import fetch_ir_tb_raw
    except Exception as ex:
        log(f"[OG] satellite_ir import failed: {ex}")
        return None, None, None
    now = datetime.now(timezone.utc)
    for lag in (0, 20):
        try:
            raw = fetch_ir_tb_raw(
                float(storm["lat"]), float(storm["lon"]),
                now - timedelta(minutes=lag), box_deg=10.0)
        except Exception as ex:
            log(f"[OG] IR fetch failed for {storm.get('atcf_id')} (-{lag} min): {ex}")
            raw = None
        if raw is not None and raw.get("tb") is not None:
            valid = raw.get("scan_dt") or raw.get("datetime_utc")
            if isinstance(valid, datetime):
                valid = valid.strftime("%Y-%m-%dT%H:%M:%SZ")
            return None, valid, raw["tb"]
    return None, None, None
