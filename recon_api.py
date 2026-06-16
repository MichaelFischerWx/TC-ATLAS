"""Real-time aircraft reconnaissance API.

Serves a single per-storm JSON blob for the RT-monitor recon overlay: the
cumulative Air Force / NOAA flight-level track (HDOB, 30-s obs), dropsonde
fixes, and VDM center fixes, all keyed to an active storm's ATCF id.

Data sources (all plain HTTPS, no auth):
  HDOB (flight-level)  nhc.noaa.gov/archive/recon/{YYYY}/AHONT1|AHOPN1/   fixed-width
  VDM (center fixes)   nhc.noaa.gov/archive/recon/{YYYY}/REPNT2|REPPN2/   coded text
  Dropsonde fixes      ftp.nhc.noaa.gov/atcf/fix/f<bb><cy>{YYYY}.dat      ATCF f-deck

Design notes:
  * The HDOB line parser here is dedicated (NOT global_archive_api's MINOB
    parser) because that one drops the SFMR surface-wind column, which is a
    headline recon variable. The VDM parser IS reused by import.
  * Per-bulletin decode results are memoized by URL (bulletins are immutable
    once posted), so re-polls only fetch newly-posted files. The directory
    listing itself is cached upstream by _hrd_parse_directory (~5 min).
  * Replay: pass ?replay=YYYYMMDDHHMM&speed=N to drive the same fetch/decode
    path off a past mission on an accelerated clock — see _replay_now().
"""

import json
import logging
import math
import os
import re
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

logger = logging.getLogger("recon")

# Replay (?replay=) is a DEV/TEST affordance — replaying a past mission as if it
# were live. It is OFF unless RECON_ALLOW_REPLAY=1, so production never serves a
# past storm (e.g. Milton) and only ever shows the genuinely-live recon. Set the
# flag on a local/dev API to test against the real archive.
_ALLOW_REPLAY = os.environ.get("RECON_ALLOW_REPLAY", "0") == "1"

router = APIRouter(tags=["recon"])

NHC_RECON_BASE = "https://www.nhc.noaa.gov/archive/recon"

# Per-bulletin decoded cache (filename URL -> decoded payload). Bulletins never
# change once posted, so this is unbounded-safe within a season but we cap it.
_bulletin_cache: dict = {}
_BULLETIN_CACHE_MAX = 4000

# Assembled-blob cache (cache_key -> (blob, ts)). Short TTL: a flight posts a
# new HDOB bulletin ~every 10 min, so 120 s keeps the overlay fresh-enough while
# collapsing rapid client polls onto one assembly.
_blob_cache: dict = {}
_BLOB_TTL = 120

# Replay wall-clock anchors: (atcf_id, replay_anchor, speed) -> wall_start_epoch.
_replay_anchors: dict = {}
_REPLAY_MAX_ADVANCE_S = 24 * 3600  # sim-seconds; replay freezes on full track after this
_STORM_GATE_DEG = 8.0   # (legacy) generous proximity window
_STORM_CORE_DEG = 3.0   # true-distance "demonstrably in/at the storm" (covers broad
                        # invest circulations + the recon pattern; excludes TEXAQS @4.5°)


# ── basin → archive directory mapping ────────────────────────────────────────

def _basin_dirs(atcf_id: str) -> dict:
    """Map an ATCF id to its NHC recon directory + f-deck filename prefixes."""
    b = (atcf_id or "").upper()[:2]
    if b in ("EP", "CP"):
        return {"hdob": "AHOPN1", "vdm": "REPPN2", "drop": "REPPN3", "fdeck_basin": b.lower()}
    # Atlantic (and a sane default for anything else NHC archives this way)
    return {"hdob": "AHONT1", "vdm": "REPNT2", "drop": "REPNT3", "fdeck_basin": "al"}


# ── coordinate + field helpers ───────────────────────────────────────────────

def _parse_latlon_token(tok: str):
    """'3009N' -> 30.15 ; '08921W' -> -89.35 ; returns None on missing/junk."""
    tok = (tok or "").rstrip(";")
    if not tok or tok.startswith("/"):
        return None
    hem = tok[-1].upper()
    num = tok[:-1]
    if hem not in ("N", "S", "E", "W") or len(num) < 4 or not num.isdigit():
        return None
    deg = int(num[:-2]) + int(num[-2:]) / 60.0
    if hem in ("S", "W"):
        deg = -deg
    return round(deg, 3)


def _safe_div10(tok, signed=False):
    """Decode a tenths-coded field ('+027' -> 2.7, '5990' -> 599.0). None on '/'."""
    tok = (tok or "").rstrip(";")
    if not tok or "/" in tok:
        return None
    try:
        return round(int(tok) / 10.0, 1)
    except ValueError:
        return None


def _deg_dist(lat1, lon1, lat2, lon2) -> float:
    """Approx great-circle separation in degrees (cos-lat scaled longitude)."""
    dlat = lat1 - lat2
    dlon = (lon1 - lon2) * math.cos(math.radians((lat1 + lat2) / 2.0))
    return math.sqrt(dlat * dlat + dlon * dlon)


def _safe_int(tok):
    tok = (tok or "").rstrip(";")
    if not tok or "/" in tok:
        return None
    try:
        return int(tok)
    except ValueError:
        return None


# ── HDOB (flight-level) ──────────────────────────────────────────────────────

def _parse_hdob_line(fields: list, base_date: datetime):
    """Decode one 30-s HDOB observation line into a dict (or None).

    Field layout (NHC abouthdobs_2007):
      0 HHMMSS  1 lat  2 lon  3 staticP(x10)  4 geoAlt(m)  5 extrapSfcP/Dval
      6 Tair(x10)  7 Tdew(x10)  8 dir+spd(dddsss)  9 peakFLwind(kt)
      10 SFMRsfcWind(kt)  11 SFMRrain(mm/hr)  12 QCflags
    """
    if len(fields) < 10:
        return None
    t = fields[0].rstrip(";")
    if not t.isdigit() or len(t) < 6:
        return None
    hh, mm, ss = int(t[:2]), int(t[2:4]), int(t[4:6])
    if hh > 47 or mm > 59 or ss > 59:
        return None

    lat = _parse_latlon_token(fields[1])
    lon = _parse_latlon_token(fields[2])
    if lat is None or lon is None:
        return None
    # Reject missing-position placeholders (0000N/00000W → exactly 0°): HDOB
    # never legitimately reports 0° lat/lon, and these draw stray barbs at the
    # equator/prime meridian and blow up any track-bounds fit.
    if abs(lat) < 0.05 or abs(lon) < 0.05:
        return None

    # Wind dir/speed combined as dddsss
    wdir = wspd = None
    wc = fields[8].rstrip(";") if len(fields) > 8 else ""
    if len(wc) >= 6 and wc.isdigit():
        wdir, wspd = int(wc[:3]), int(wc[3:])

    # obs hour may roll past 24 to flag the next UTC day
    day_off, hh_wrap = divmod(hh, 24)
    obs_dt = base_date.replace(hour=hh_wrap, minute=mm, second=ss) + timedelta(days=day_off)

    return {
        "t": obs_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "lat": lat, "lon": lon,
        "fl_pres_mb": _safe_div10(fields[3]),
        "geo_alt_m": _safe_int(fields[4]),
        "sfc_p_or_dval": _safe_int(fields[5]),
        "temp_c": _safe_div10(fields[6]),
        "dewpt_c": _safe_div10(fields[7]),
        "wdir": wdir,
        "wspd_kt": wspd,
        "peak_fl_kt": _safe_int(fields[9]) if len(fields) > 9 else None,
        "sfmr_kt": _safe_int(fields[10]) if len(fields) > 10 else None,
        "sfmr_rain": _safe_int(fields[11]) if len(fields) > 11 else None,
        "qc": fields[12].rstrip(";") if len(fields) > 12 else None,
    }


def _parse_hdob_bulletin(text: str, fname_dt: datetime):
    """Parse one URNT15/AHONT1 bulletin -> {tail, storm, obs:[...]} (or None).

    `storm` is the system label the aircraft is flying (the token before HDOB,
    e.g. ONE / AL01 / INVEST / a research-campaign name like TEXAQS11) — used to
    keep a non-TC research flight out of an actual storm's track."""
    lines = text.strip().splitlines()
    tail = None
    storm = None
    base_date = fname_dt
    obs = []
    in_data = False
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        up = s.upper()
        if up.startswith(("URNT15", "AHONT1", "AHOPN1")) and " " in s:
            in_data = False
            continue
        # Info line carries the aircraft tail, the system label, + an 8-digit date
        if (not in_data) and ("HDOB" in up):
            parts = up.split()
            for p in parts:
                if re.fullmatch(r"(AF|NOAA)\d+", p):
                    tail = p
                if len(p) == 8 and p.isdigit():
                    try:
                        base_date = datetime(int(p[:4]), int(p[4:6]), int(p[6:8]),
                                             tzinfo=timezone.utc)
                    except ValueError:
                        pass
            # storm label = token immediately before HDOB
            if "HDOB" in parts:
                hi = parts.index("HDOB")
                if hi >= 1:
                    storm = parts[hi - 1]
            in_data = True
            continue
        if in_data:
            if up in ("NNNN", "$$") or up.startswith("REMARKS"):
                in_data = False
                continue
            row = _parse_hdob_line(s.split(), base_date)
            if row:
                obs.append(row)
    if not obs:
        return None
    return {"tail": tail or "UNKN", "storm": storm, "obs": obs}


# ── dropsondes (REPNT3 TEMP DROP) ────────────────────────────────────────────
#
# f-deck DRPS fixes carry no position for many storms (they're intensity-only),
# so dropsonde *locations* come from the TEMP DROP bulletins. We don't decode the
# full thermodynamic profile — just the release/splash position + time and the
# boundary-layer / surface (WL150) winds, which is the clickable-marker payload.

def _dm_to_deg(d: str, ndeg: int):
    """DDMM / DDDMM coded coordinate -> decimal degrees magnitude."""
    return int(d[:ndeg]) + int(d[ndeg:]) / 60.0


def _parse_tempdrop_bulletin(text: str, fname_dt: datetime) -> list:
    """Parse a REPNT3/REPPN3 TEMP DROP bulletin -> list of dropsonde dicts."""
    out = []
    tail = storm = ob = None
    m = re.search(r"61616\s+(\w+)\s+\w+\s+([A-Z][A-Z0-9\-]+)\s+OB\s+(\d+)", text)
    if m:
        tail, storm, ob = m.group(1).upper(), m.group(2).upper(), m.group(3)
    mbl = re.search(r"MBL WND\s+(\d{3})(\d{2})", text)
    wl = re.search(r"WL150\s+(\d{3})(\d{2})", text)
    mbl_dir, mbl_kt = (int(mbl.group(1)), int(mbl.group(2))) if mbl else (None, None)
    sfc_dir, sfc_kt = (int(wl.group(1)), int(wl.group(2))) if wl else (None, None)

    seen = set()
    for mm in re.finditer(
        r"REL\s+(\d{4})([NS])(\d{5})([EW])\s+(\d{6})"
        r"(?:\s+SPG?\s+(\d{4})([NS])(\d{5})([EW])\s+(\d{6}))?", text):
        rlat = _dm_to_deg(mm.group(1), 2) * (1 if mm.group(2) == "N" else -1)
        rlon = _dm_to_deg(mm.group(3), 3) * (1 if mm.group(4) == "E" else -1)
        if abs(rlat) < 0.05 or abs(rlon) < 0.05:
            continue  # missing-position placeholder
        rt = mm.group(5)
        hh, mn, ss = int(rt[:2]) % 24, int(rt[2:4]), int(rt[4:6])
        dt = fname_dt.replace(hour=hh, minute=mn, second=ss)
        if dt > fname_dt + timedelta(hours=2):  # drop precedes transmission
            dt -= timedelta(days=1)
        key = (rt, round(rlat, 2), round(rlon, 2))  # REL/SPG repeats per XXAA/XXBB
        if key in seen:
            continue
        seen.add(key)
        splat = splon = None
        if mm.group(6):
            splat = round(_dm_to_deg(mm.group(6), 2) * (1 if mm.group(7) == "N" else -1), 3)
            splon = round(_dm_to_deg(mm.group(8), 3) * (1 if mm.group(9) == "E" else -1), 3)
        out.append({
            "t": dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "lat": round(rlat, 3), "lon": round(rlon, 3),
            "splash_lat": splat, "splash_lon": splon,
            "sfc_dir": sfc_dir, "sfc_wind_kt": sfc_kt,
            "mbl_dir": mbl_dir, "mbl_wind_kt": mbl_kt,
            "tail": tail, "storm": storm, "ob": ob,
        })
    return out


# ── replay clock ─────────────────────────────────────────────────────────────

def _replay_now(atcf_id: str, replay: str, speed: float):
    """Simulated 'current' UTC time for a replayed mission.

    On first call for a (storm, anchor, speed) we pin the wall start; each later
    poll advances simulated time by elapsed_wall * speed. Returns a datetime.
    """
    try:
        anchor = datetime.strptime(replay, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    key = (atcf_id, replay, speed)
    wall_start = _replay_anchors.setdefault(key, time.time())
    elapsed = (time.time() - wall_start) * max(1.0, speed)
    # Cap the advance so a fast replay PLAYS the mission once then FREEZES on the
    # full cumulative track, instead of sliding the look-back window off the end
    # of the data into emptiness. 24 h of sim-time covers a full sortie set.
    elapsed = min(elapsed, _REPLAY_MAX_ADVANCE_S)
    return anchor + timedelta(seconds=elapsed)


# ── blob assembly ────────────────────────────────────────────────────────────

def _list_recent_files(dir_url: str, since: datetime, until: datetime) -> list:
    """Return absolute URLs for *.txt bulletins whose filename timestamp is in
    [since, until]. Filenames: <PREFIX>-<SRC>.YYYYMMDDHHMM.txt."""
    from tc_radar_api import _hrd_parse_directory
    try:
        names = _hrd_parse_directory(dir_url if dir_url.endswith("/") else dir_url + "/")
    except Exception as e:
        logger.warning("recon dir list failed %s: %s", dir_url, e)
        return []
    picked = []
    for nm in names:
        if not nm.lower().endswith(".txt"):
            continue
        m = re.search(r"\.(\d{12})\.txt$", nm)
        if not m:
            continue
        try:
            ts = datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if since <= ts <= until:
            base = dir_url if dir_url.endswith("/") else dir_url + "/"
            picked.append((ts, base + nm.lstrip("/")))
    picked.sort()
    return [u for _, u in picked]


def _fetch_text(url: str):
    from tc_radar_api import _hrd_fetch_text
    try:
        return _hrd_fetch_text(url, timeout=20)
    except Exception as e:
        logger.debug("recon fetch failed %s: %s", url, e)
        return None


def _near_track(lat, lon, track_pts, tol_deg=4.0) -> bool:
    """True if (lat,lon) is within tol_deg of any aircraft track point — used to
    attribute a season-wide TEMP DROP bulletin to this storm when it carries no
    ATCF id and the storm name didn't match."""
    if lat is None or lon is None:
        return False
    if not track_pts:
        return True  # no track to gate against yet → don't drop it
    for (plat, plon) in track_pts:
        if abs(plat - lat) <= tol_deg and abs(plon - lon) <= tol_deg:
            return True
    return False


def _build_blob(atcf_id: str, hours: int, sim_now: datetime, name: str = "",
                storm_lat: float = None, storm_lon: float = None) -> dict:
    """Assemble the cumulative recon blob for one storm as of sim_now."""
    dirs = _basin_dirs(atcf_id)
    year = sim_now.year
    since = sim_now - timedelta(hours=hours)

    # ── HDOB → per-aircraft tracks ──
    aircraft: dict = {}
    aircraft_names: dict = {}   # tail -> {system labels from the bulletins}
    hdob_dir = f"{NHC_RECON_BASE}/{year}/{dirs['hdob']}/"
    for url in _list_recent_files(hdob_dir, since, sim_now):
        if url in _bulletin_cache:
            parsed = _bulletin_cache[url]
        else:
            txt = _fetch_text(url)
            m = re.search(r"\.(\d{12})\.txt$", url)
            fdt = datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
            parsed = _parse_hdob_bulletin(txt, fdt) if txt else None
            if len(_bulletin_cache) < _BULLETIN_CACHE_MAX:
                _bulletin_cache[url] = parsed
        if not parsed:
            continue
        tk = aircraft.setdefault(parsed["tail"], {})
        if parsed.get("storm"):
            aircraft_names.setdefault(parsed["tail"], set()).add(parsed["storm"])
        for ob in parsed["obs"]:
            tk[ob["t"]] = ob  # dedup by ISO time within a tail

    # In replay, hide obs the simulated clock hasn't "reached" yet.
    sim_iso = sim_now.strftime("%Y-%m-%dT%H:%M:%SZ")
    # HDOB carries no ATCF id, so the directory returns EVERY flight in the
    # window — including non-TC research sorties (e.g. TEXAQS) that share the
    # AHONT1 feed. Attribute an aircraft to this storm by its bulletin LABEL
    # (ONE / AL01 / INVEST / cyclone number) OR by being demonstrably at the
    # storm core; this keeps the real sortie (even its ferry leg) while dropping
    # a research flight that merely passes within a few degrees.
    # The query "name" is the storm display name ("One", "Milton", "Invest 90L").
    # For invests the meaningful identifier is the number/suffix ("90L"), so strip
    # the generic "INVEST" prefix to get the discriminating token.
    norm_q = re.sub(r"[^A-Z0-9]", "", (name or "").upper())
    qword = norm_q[6:] if norm_q.startswith("INVEST") else norm_q   # INVEST90L -> 90L
    bcy = atcf_id[:4].upper()          # e.g. AL01 / AL90
    cy = atcf_id[2:4]                  # 01 / 90
    short = cy + {"AL": "L", "EP": "E", "CP": "C"}.get(atcf_id[:2].upper(), "")  # 01L

    def _label_matches(lbl: str) -> bool:
        """True only when the bulletin label SPECIFICALLY identifies this storm.
        Matching is name-INVARIANT (basin+cyclone AL01, short form 01L) so it
        survives a TD→TS rename — the storm's ATCF identity never changes. A bare
        generic 'INVEST' (no number) is deliberately NOT a match — it can't
        distinguish two simultaneous invests, so those rely on position instead."""
        n = re.sub(r"[^A-Z0-9]", "", (lbl or "").upper())
        if not n or n == "INVEST":
            return False
        if bcy and bcy in n:                       # AL01 / AL90 (basin+cyclone #)
            return True
        if len(short) >= 2 and short in n:         # 01L / 90L — ATCF short form
            return True
        if qword and len(qword) >= 2 and (qword == n or qword in n or n in qword):
            return True                            # MILTON, ONE, 90L, INVEST90L
        return False

    aircraft_out = []
    for tail, obmap in aircraft.items():
        track = [obmap[k] for k in sorted(obmap) if k <= sim_iso]
        if not track:
            continue
        labels = aircraft_names.get(tail, set())
        name_ok = any(_label_matches(l) for l in labels)
        at_core = (storm_lat is not None and storm_lon is not None and
                   any(_deg_dist(o["lat"], o["lon"], storm_lat, storm_lon) <= _STORM_CORE_DEG
                       for o in track))
        # Only filter when we have something to match against (a name and/or a
        # position). With neither (shouldn't happen via the UI) keep, as before.
        if (norm_q or storm_lat is not None) and not (name_ok or at_core):
            continue
        aircraft_out.append({"tail": tail, "track": track})
    aircraft_out.sort(key=lambda a: a["track"][-1]["t"], reverse=True)

    # ── VDM center fixes (reuse global_archive parser) ──
    vdms = []
    try:
        from global_archive_api import _parse_vdm_text, _resolve_vdm_time
        vdm_dir = f"{NHC_RECON_BASE}/{year}/{dirs['vdm']}/"
        sd = since.strftime("%Y-%m-%d")
        ed = sim_now.strftime("%Y-%m-%d")
        for url in _list_recent_files(vdm_dir, since, sim_now):
            txt = _bulletin_cache.get("vdm::" + url)
            if txt is None:
                raw = _fetch_text(url)
                parsed = _parse_vdm_text(raw, year) if raw else None
                if parsed is not None:
                    parsed["time"] = _resolve_vdm_time(parsed, year, sd, ed)
                if len(_bulletin_cache) < _BULLETIN_CACHE_MAX:
                    _bulletin_cache["vdm::" + url] = parsed if parsed else False
                txt = parsed if parsed else False
            if not txt:
                continue
            v = txt
            if v.get("lat") is None or v.get("lon") is None:
                continue
            if abs(v["lat"]) < 0.05 or abs(v["lon"]) < 0.05:
                continue
            if v.get("atcf_id") and v["atcf_id"].upper() != atcf_id.upper():
                continue
            tiso = v.get("time")
            if tiso and tiso > sim_iso:
                continue  # replay gate
            vdms.append({
                "t": tiso, "lat": v.get("lat"), "lon": v.get("lon"),
                "min_slp_hpa": v.get("min_slp_hpa"),
                "max_fl_wind_kt": v.get("max_fl_wind_kt"),
                "max_sfmr_kt": v.get("max_sfmr_kt"),
                "eye_diam_nm": v.get("eye_diameter_nm"),
                "eye_shape": v.get("eye_shape"),
                "aircraft": v.get("aircraft"),
                "ob_number": v.get("ob_number"),
                "raw_text": v.get("raw_text"),
            })
        vdms.sort(key=lambda x: x.get("t") or "")
    except Exception as e:
        logger.warning("recon VDM assembly failed for %s: %s", atcf_id, e)

    # ── Dropsondes (REPNT3 TEMP DROP) ──
    # No ATCF id in TEMP DROP, so attribute to this storm by name match, else by
    # spatial proximity to the aircraft track (the plane is sampling this storm).
    track_pts = [(o["lat"], o["lon"]) for a in aircraft_out for o in a["track"]]
    want_name = (name or "").upper().strip()
    drops = []
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        drop_dir = f"{NHC_RECON_BASE}/{year}/{dirs['drop']}/"
        for url in _list_recent_files(drop_dir, since, sim_now):
            cached = _bulletin_cache.get("drop::" + url)
            if cached is None:
                txt = _fetch_text(url)
                m = re.search(r"\.(\d{12})\.txt$", url)
                fdt = datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
                cached = _parse_tempdrop_bulletin(txt, fdt) if txt else []
                if len(_bulletin_cache) < _BULLETIN_CACHE_MAX:
                    _bulletin_cache["drop::" + url] = cached
            for d in cached:
                if not (since_iso <= (d["t"] or "") <= sim_iso):
                    continue
                if want_name and d.get("storm"):
                    if d["storm"] != want_name and not _near_track(d["lat"], d["lon"], track_pts):
                        continue
                elif not _near_track(d["lat"], d["lon"], track_pts):
                    continue
                drops.append(d)
        drops.sort(key=lambda x: x.get("t") or "")
    except Exception as e:
        logger.warning("recon dropsonde assembly failed for %s: %s", atcf_id, e)

    n_obs = sum(len(a["track"]) for a in aircraft_out)
    return {
        "atcf_id": atcf_id.upper(),
        "updated_utc": sim_iso,
        "has_recon": bool(aircraft_out or vdms or drops),
        "aircraft": aircraft_out,
        "dropsondes": drops,
        "vdms": vdms,
        "counts": {"obs": n_obs, "aircraft": len(aircraft_out),
                   "dropsondes": len(drops), "vdms": len(vdms)},
    }


# ── route ────────────────────────────────────────────────────────────────────

@router.get("/realtime")
def recon_realtime(
    atcf_id: str = Query(..., description="ATCF id, e.g. AL052026"),
    hours: int = Query(24, ge=1, le=72, description="Look-back window (hours)"),
    name: str = Query("", description="Storm name, for dropsonde attribution"),
    lat: float = Query(None, description="Storm lat — gates HDOB to nearby aircraft"),
    lon: float = Query(None, description="Storm lon — gates HDOB to nearby aircraft"),
    replay: str = Query("", description="Replay anchor YYYYMMDDHHMM (dev/testing)"),
    speed: float = Query(60.0, ge=1.0, le=600.0, description="Replay speed multiplier"),
):
    """Cumulative real-time recon for a storm: HDOB tracks, dropsondes, VDMs."""
    atcf_id = atcf_id.upper().strip()
    if len(atcf_id) < 8:
        return JSONResponse({"error": "bad atcf_id"}, status_code=400)

    if replay and not _ALLOW_REPLAY:
        replay = ""  # ignore replay in production → live data only

    if replay:
        sim_now = _replay_now(atcf_id, replay, speed)
        if sim_now is None:
            return JSONResponse({"error": "bad replay anchor"}, status_code=400)
        cache_key = f"{atcf_id}:{hours}:{name}:{lat}:{lon}:replay:{replay}:{speed}:{int(time.time() // 5)}"
        cc = "no-store"
    else:
        sim_now = datetime.now(timezone.utc)
        cache_key = f"{atcf_id}:{hours}:{name}:{lat}:{lon}:live"
        cc = "public, max-age=60, s-maxage=120, stale-while-revalidate=120"

    now = time.time()
    hit = _blob_cache.get(cache_key)
    if hit and (now - hit[1]) < _BLOB_TTL:
        return JSONResponse(hit[0], headers={"Cache-Control": cc})

    blob = _build_blob(atcf_id, hours, sim_now, name=name, storm_lat=lat, storm_lon=lon)
    _blob_cache[cache_key] = (blob, now)
    if len(_blob_cache) > 200:
        _blob_cache.pop(next(iter(_blob_cache)))
    return JSONResponse(blob, headers={"Cache-Control": cc})
