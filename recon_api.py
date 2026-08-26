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

# Low-latency "newest bulletin" feeds. The archive directory above lags the live
# data by ~1-2 bulletin cycles (~20 min) during an active flight; these tgftp
# collectives hold the single most-recent HDOB per WMO header and close that gap.
# URNT15 = Atlantic HDOB, URPN15 = E-Pacific HDOB (KNHC issues recon). We try
# both issuing centers and keep whatever parses.
_LATEST_HDOB_FEEDS = {
    "AL": ["https://tgftp.nws.noaa.gov/data/raw/ur/urnt15.knhc..txt",
           "https://tgftp.nws.noaa.gov/data/raw/ur/urnt15.kwbc..txt"],
    "EP": ["https://tgftp.nws.noaa.gov/data/raw/ur/urpn15.knhc..txt",
           "https://tgftp.nws.noaa.gov/data/raw/ur/urpn15.kwbc..txt"],
}

# Per-bulletin decoded cache (filename URL -> decoded payload). Bulletins never
# change once posted, so this is unbounded-safe within a season but we cap it.
_bulletin_cache: dict = {}
_BULLETIN_CACHE_MAX = 4000

# Assembled-blob cache (cache_key -> (blob, ts)). TTL sits just under the 60 s
# client poll so each poll returns a freshly-assembled blob (a rebuild only
# re-fetches the 1-2 newly-posted bulletins thanks to the per-bulletin cache, so
# it's cheap) while still collapsing bursts of concurrent polls onto one build.
_blob_cache: dict = {}
_BLOB_TTL = 50

# Directory-listing freshness for the recon endpoint. The shared archive default
# is 1 h (immutable data). We don't need to re-list NHC's big bulletin directories
# (1600+ files) every poll: the low-latency live feed (_fetch_latest_hdob, pulled
# on EVERY build) already keeps the HDOB track tip fresh, so the directory listing
# only supplies the cumulative history + VDM/dropsonde discovery and can lag a few
# minutes. Re-listing every poll was the dominant rebuild cost (~6-8 s); 4 min
# keeps it cheap while HDOB stays current. (Was 45 s — shorter than _BLOB_TTL,
# so every rebuild paid the re-list.)
_RECON_DIR_TTL = 240

# Replay wall-clock anchors: (atcf_id, replay_anchor, speed) -> wall_start_epoch.
_replay_anchors: dict = {}
_REPLAY_MAX_ADVANCE_S = 24 * 3600  # sim-seconds; replay freezes on full track after this
# Generic, NON-discriminating system labels USAF/NOAA put in the HDOB header when
# no NHC name applies. None of these identify a specific system, so a flight
# carrying one attaches by CORE PROXIMITY, not by label — and must never count as
# a "conflicting" (different-named-system) sortie. "INVEST" was the original case;
# "CYCLONE" is the placeholder USAF filed on AL02/AF301 (2026-07-19), which the
# INVEST-only gate misread as a conflicting name and dropped a live flight.
_GENERIC_LABELS = frozenset({"", "INVEST", "CYCLONE", "SUSPECT", "DISTURBANCE", "GENESIS"})

_STORM_GATE_DEG = 8.0   # (legacy) generous proximity window
_STORM_CORE_DEG = 5.0   # true-distance proximity for a non-conflicting flight (bare
                        # "INVEST"/unlabeled) to attach to this storm. Generous so an
                        # inbound ferry leg counts; a research flight is excluded by its
                        # CONFLICTING label regardless of distance, so this can be wide.

# HDOB mission-ID field — the token right after the aircraft tail in the header
# ("NOAA2 0201C PTC01-C  HDOB 10 20260812"). It packs mission number, CYCLONE
# NUMBER and BASIN LETTER as MMSSB, so "0201C" = mission 02, cyclone 01, Central
# Pacific = CP012026. This is the one AUTHORITATIVE storm identifier an HDOB
# carries: it holds on a ferry leg still 8° from the center, and it survives a
# header label the NHC name doesn't match (USAF filed "PTC01-C" for a storm NHC
# lists as "One-C"). USAF files a non-storm form ("WXWXA") on unnumbered
# missions, which resolves to None and leaves label/proximity attribution.
# Atlantic missions file the basin letter as "A", NOT ATCF's "L" ("2709A IAN"):
# every archive season 2018-2026 uses A, including the current one, so "L"
# here is defensive only. E/C are stable across eras. _MISSION_BASIN_LTR must
# stay AL->"L" — it feeds the ATCF short-form label match ("90L"/"01L") in
# _label_matches_storm, where the convention really is L.
_MISSION_BASIN = {"A": "AL", "L": "AL", "E": "EP", "C": "CP"}
_MISSION_BASIN_LTR = {"AL": "L", "EP": "E", "CP": "C"}   # ATCF short-form letters


def _mission_atcf(token: str, year: int):
    """'0201C' + 2026 -> 'CP012026'; '2709A' + 2022 -> 'AL092022'.
    None for a non-storm mission id ('WXWXA', '07WSA') or serial."""
    m = re.fullmatch(r"\d{2}(\d{2})([ALEC])", (token or "").upper().strip())
    if not m or m.group(1) == "00":
        return None
    return "%s%s%04d" % (_MISSION_BASIN[m.group(2)], m.group(1), year)


def _label_matches_storm(lbl: str, atcf_id: str, name: str = "") -> bool:
    """True only when an HDOB/TEMP-DROP system label SPECIFICALLY identifies this
    storm. Matching is name-INVARIANT (basin+cyclone AL01, short form 01L, and
    the bare cyclone number for a PTC/TD placeholder like PTC01-C) so it survives
    a TD→TS rename and a header label NHC's own name doesn't match — the storm's
    ATCF identity never changes. A bare generic 'INVEST' (no number) is
    deliberately NOT a match: it can't distinguish two simultaneous invests, so
    those rely on position instead.

    Module-level so the ✈ RECON badge (ir_monitor_api._has_active_recon) and the
    recon blob's own attribution apply ONE rule. They used to disagree — the
    badge compared the header label to the display name verbatim, so a NOAA2
    sortie filed as "PTC01-C" never flagged the storm NHC calls "One-C"."""
    n = re.sub(r"[^A-Z0-9]", "", (lbl or "").upper())
    if n in _GENERIC_LABELS:
        return False
    atcf_id = (atcf_id or "").upper()
    bcy = atcf_id[:4]                  # e.g. AL01 / AL90
    cy = atcf_id[2:4]                  # 01 / 90
    # Only NHC's own basins have a recon short form. Elsewhere (WP/IO/SH) there is
    # no basin letter, and matching on the bare cyclone number would fire on any
    # label that merely CONTAINS those two digits — WP01 on a "PTC01-C" bulletin.
    basin_ltr = _MISSION_BASIN_LTR.get(atcf_id[:2], "")
    # The query "name" is the storm display name ("One", "Milton", "Invest 90L").
    # For invests the meaningful identifier is the number/suffix ("90L"), so strip
    # the generic "INVEST" prefix to get the discriminating token.
    norm_q = re.sub(r"[^A-Z0-9]", "", (name or "").upper())
    qword = norm_q[6:] if norm_q.startswith("INVEST") else norm_q   # INVEST90L -> 90L
    if bcy and bcy in n:                       # AL01 / AL90 (basin+cyclone #)
        return True
    if basin_ltr and (cy + basin_ltr) in n:    # 01L / 90L / 01C — ATCF short form
        return True
    # PTC/TD placeholders carry the cyclone number with the basin letter split off
    # by a hyphen ("PTC01-C" -> PTC01C, which the short form above catches) or
    # dropped entirely ("PTC01", "TD01"). Anchor on the leading placeholder word so
    # a name that merely contains the digits can't collide.
    if basin_ltr and re.fullmatch(
            r"(?:PTC|TD|TS|STS|HU|PC)0*" + cy + "[" + basin_ltr + "]?", n):
        return True
    if qword and len(qword) >= 2 and (qword == n or qword in n or n in qword):
        return True                            # MILTON, ONE, 90L, INVEST90L
    return False


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


def _decode_fl_pres(tok):
    """Decode the HDOB static-pressure field (field 3). It's pressure×10 with the
    leading thousands digit dropped, so a near-surface reading ≥1000 mb (e.g.
    1002.3 mb → '0023') decodes naively to 2.3 — add the 1000 back. Recon never
    flies above ~150 mb, so any sub-100 mb decode means the leading 1 was dropped.
    Without this, low-level legs inject 2-12 mb values that wreck the chart's
    pressure axis."""
    p = _safe_div10(tok)
    if p is None:
        return None
    return round(p + 1000.0, 1) if p < 100 else p


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

    # Field 5 is the extrapolated SURFACE pressure (low-level flight) OR the
    # geopotential-height D-value (higher flight). Same decode as the global
    # archive HDOB parser (global_archive_api.py): >=5000 ⇒ negative D-value;
    # <1000 ⇒ 1000+x/10 mb; else x/10 mb. The extrapolated SLP is the headline
    # surface-pressure number from an eye penetration.
    _xxxx = _safe_int(fields[5])
    extrap_sfc_p_mb = dval_m = None
    if _xxxx is not None:
        if _xxxx >= 5000:
            dval_m = -(_xxxx - 5000)
        elif _xxxx < 1000:
            extrap_sfc_p_mb = round(1000 + _xxxx / 10.0, 1)
        else:
            extrap_sfc_p_mb = round(_xxxx / 10.0, 1)

    return {
        "t": obs_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "lat": lat, "lon": lon,
        "fl_pres_mb": _decode_fl_pres(fields[3]),
        "geo_alt_m": _safe_int(fields[4]),
        "sfc_p_or_dval": _safe_int(fields[5]),
        "extrap_sfc_p_mb": extrap_sfc_p_mb,
        "dval_m": dval_m,
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
    """Parse one URNT15/AHONT1 bulletin -> {tail, storm, atcf, obs:[...]} (or None).

    `storm` is the system label the aircraft is flying (the token before HDOB,
    e.g. ONE / AL01 / INVEST / a research-campaign name like TEXAQS11) — used to
    keep a non-TC research flight out of an actual storm's track.
    `atcf` is the storm this mission was FILED for, decoded from the mission-ID
    field (see _mission_atcf) — authoritative when present, None otherwise."""
    lines = text.strip().splitlines()
    tail = None
    storm = None
    mission = None
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
            # storm label = token immediately before HDOB. A valid label always
            # contains a letter (ONE / INVEST / SURVEY / AL01 / 90L); reject a
            # pure-digit token (a mission/serial number that occasionally lands
            # in that slot) so it can't masquerade as the system name.
            if "HDOB" in parts:
                hi = parts.index("HDOB")
                if hi >= 1:
                    cand = parts[hi - 1]
                    if re.search(r"[A-Z]", cand):
                        storm = cand
                # Mission id: the field after the tail. Scan the header tokens
                # rather than fixing an index — the label slot is sometimes
                # empty, which shifts everything left.
                for p in parts[1:hi]:
                    if _mission_atcf(p, base_date.year):
                        mission = p
                        break
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
    return {"tail": tail or "UNKN", "storm": storm, "mission": mission,
            "atcf": _mission_atcf(mission, base_date.year), "obs": obs}


# ── dropsondes (REPNT3 TEMP DROP) ────────────────────────────────────────────
#
# f-deck DRPS fixes carry no position for many storms (they're intensity-only),
# so dropsonde *locations* come from the TEMP DROP bulletins. We don't decode the
# full thermodynamic profile — just the release/splash position + time and the
# boundary-layer / surface (WL150) winds, which is the clickable-marker payload.

def _relspg_to_deg(d: str, ndeg: int):
    """REL/SPG coordinate -> decimal degrees magnitude.

    The ASPEN/AOC-appended REL (release) and SPG (splash) coords in a TEMP DROP
    are DEGREES + HUNDREDTHS packed without the point: 'DDdd' lat / 'DDDdd' lon
    (e.g. 2889N = 28.89°, 09342W = 93.42°). This is NOT degrees-minutes — the
    trailing pair routinely exceeds 59 (2889, 2599, 2861), which decimal-minutes
    can't represent. Decoding it as DDMM put sondes ~0.4-0.6° off (the bug TT's
    plot exposed). HDOB lat/lon, by contrast, ARE DDMM — see _parse_latlon_token."""
    return int(d[:ndeg]) + int(d[ndeg:]) / 100.0


# Mandatory-level pressure indicators (FM-37 TEMP) → mb.
_TEMP_MAND_P = {"00": 1000, "92": 925, "85": 850, "70": 700, "50": 500,
                "40": 400, "30": 300, "25": 250, "20": 200, "15": 150, "10": 100}
# Climatological thousands base for the coded geopotential height at each level
# (the coded 3 digits carry only the lower part). 1000 mb is handled separately
# (it can be slightly negative). e.g. 850 mb "473" → 1473 m.
_TEMP_MAND_HGT_BASE = {925: 0, 850: 1000, 700: 3000, 500: 5000, 400: 7000,
                       300: 9000, 250: 10000, 200: 11000, 150: 13000, 100: 16000}


def _td_temp(grp: str):
    """TTTaDD group → (temp_C, dewpoint_C). Temp is tenths with the last digit's
    PARITY giving the sign (even +, odd −); DD is dewpoint depression (00-50 ⇒
    ×0.1 °C, 56-99 ⇒ whole °C minus 50). Returns (None, None) on a missing group."""
    if not grp or "/" in grp or len(grp) < 3 or not grp[:3].isdigit():
        return None, None
    ttt = int(grp[:3])
    temp = ttt / 10.0
    if ttt % 2 == 1:           # odd units digit → negative
        temp = -temp
    td = None
    if len(grp) >= 5 and grp[3:5].isdigit():
        dd = int(grp[3:5])
        depr = dd / 10.0 if dd <= 50 else float(dd - 50)
        td = round(temp - depr, 1)
    return round(temp, 1), td


def _td_wind(grp: str):
    """ddff group → (dir_deg, speed_kt). Direction is to the nearest 5°; a units
    digit of 1-4 means that many hundreds of knots are folded out of the speed
    (FM-37 high-wind convention). Returns (None, None) on a missing group."""
    if not grp or "/" in grp or len(grp) < 5 or not grp.isdigit():
        return None, None
    d3, ff = int(grp[:3]), int(grp[3:5])
    extra = d3 % 5
    if extra:                  # speed ≥ 100 kt: hundreds encoded into direction
        ff += extra * 100
        d3 -= extra
    return d3 % 360, ff


def _td_pres(ppp: str, prev=None):
    """3-digit pressure → mb. Values < 100 carry an implied leading 1 (e.g. 006 ⇒
    1006 near the surface). `prev` keeps the sequence monotonic-decreasing as a
    tie-break for the rare ambiguous case."""
    if not ppp.isdigit():
        return None
    p = int(ppp)
    if p < 100:
        p += 1000
    return p


def _decode_tempdrop_profile(text: str) -> dict:
    """Decode the FM-37 TEMP DROP coded profile → {mandatory, sig_temp, sig_wind}.

    Each list element is {p, t, td, wdir, wspd, hgt} (subset per section). This is
    the same data Tropical Tidbits plots; verified field-for-field against a known
    sonde. Best-effort — a malformed section is skipped, never raised."""
    mand, sig_t, sig_w = [], [], []

    def _section(tag, end_tags):
        m = re.search(r"\b" + tag + r"\b(.*?)(?:" + "|".join(end_tags) + r"|$)",
                      text, re.DOTALL)
        return m.group(1).split() if m else []

    # ── XXAA mandatory levels (skip XXAA, YYGGId, 3 location groups) ──
    try:
        g = _section("XXAA", ["XXBB", "XXCC", "31313", "51515", "61616"])
        i = 4                       # past YYGGId(0) + lat(1)/lon(2)/marsden(3)
        while i + 2 < len(g):
            grp = g[i]
            ind = grp[:2]
            if ind in ("88", "77", "66") or grp.startswith(("31313", "51515", "21212")):
                break               # tropopause / max-wind / section change
            if grp[:2] == "99":     # surface: 99 + sfc pressure
                p = _td_pres(grp[2:5]); hgt = 0
            elif ind in _TEMP_MAND_P:
                p = _TEMP_MAND_P[ind]
                if grp[2:5].isdigit():
                    raw = int(grp[2:5])
                    if p == 1000:                 # 1000 mb height can be slightly negative
                        hgt = -(raw - 500) if raw >= 500 else raw
                    else:
                        hgt = raw + _TEMP_MAND_HGT_BASE.get(p, 0)
                else:
                    hgt = None
            else:
                break
            t, td = _td_temp(g[i + 1])
            wd, ws = _td_wind(g[i + 2])
            if p is not None:
                mand.append({"p": p, "hgt": hgt, "t": t, "td": td,
                             "wdir": wd, "wspd": ws})
            i += 3
    except Exception as e:
        logger.debug("tempdrop XXAA decode: %s", e)

    # ── XXBB significant temperature levels (pairs nnPPP / TTTaDD) ──
    try:
        g = _section("XXBB", ["21212", "31313", "51515", "61616"])
        i = 4
        while i + 1 < len(g):
            ga = g[i]
            if not ga[:5].isdigit():
                break
            p = _td_pres(ga[2:5])
            t, td = _td_temp(g[i + 1])
            if p is not None and t is not None:
                sig_t.append({"p": p, "t": t, "td": td})
            i += 2
    except Exception as e:
        logger.debug("tempdrop XXBB decode: %s", e)

    # ── 21212 significant wind levels (pairs nnPPP / ddff) ──
    try:
        m = re.search(r"\b21212\b(.*?)(?:31313|51515|61616|$)", text, re.DOTALL)
        g = m.group(1).split() if m else []
        i = 0
        while i + 1 < len(g):
            ga = g[i]
            if not ga[:5].isdigit():
                break
            p = _td_pres(ga[2:5])
            wd, ws = _td_wind(g[i + 1])
            if p is not None and ws is not None:
                sig_w.append({"p": p, "wdir": wd, "wspd": ws})
            i += 2
    except Exception as e:
        logger.debug("tempdrop sigwind decode: %s", e)

    return {"mandatory": mand, "sig_temp": sig_t, "sig_wind": sig_w}


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
    profile = _decode_tempdrop_profile(text)   # FM-37 mandatory + sig levels (skew-T)

    seen = set()
    for mm in re.finditer(
        r"REL\s+(\d{4})([NS])(\d{5})([EW])\s+(\d{6})"
        r"(?:\s+SPG?\s+(\d{4})([NS])(\d{5})([EW])\s+(\d{6}))?", text):
        rlat = _relspg_to_deg(mm.group(1), 2) * (1 if mm.group(2) == "N" else -1)
        rlon = _relspg_to_deg(mm.group(3), 3) * (1 if mm.group(4) == "E" else -1)
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
            splat = round(_relspg_to_deg(mm.group(6), 2) * (1 if mm.group(7) == "N" else -1), 3)
            splon = round(_relspg_to_deg(mm.group(8), 3) * (1 if mm.group(9) == "E" else -1), 3)
        out.append({
            "t": dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "lat": round(rlat, 3), "lon": round(rlon, 3),
            "splash_lat": splat, "splash_lon": splon,
            "sfc_dir": sfc_dir, "sfc_wind_kt": sfc_kt,
            "mbl_dir": mbl_dir, "mbl_wind_kt": mbl_kt,
            "tail": tail, "storm": storm, "ob": ob,
            "profile": profile,
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
    [since, until]. Filenames: <PREFIX>-<SRC>.YYYYMMDDHHMM.txt.

    Uses a SHORT directory-listing cache (`_RECON_DIR_TTL`) so newly-posted
    bulletins during a live flight become visible within ~a minute — the shared
    archive default is 1 h, which would freeze the listing and make the display
    fall behind the aircraft."""
    from tc_radar_api import _hrd_parse_directory
    try:
        names = _hrd_parse_directory(dir_url if dir_url.endswith("/") else dir_url + "/",
                                     max_age=_RECON_DIR_TTL)
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


def _fetch_texts(urls: list) -> dict:
    """Fetch many bulletin URLs CONCURRENTLY -> {url: text|None}. The cold-build
    bottleneck was fetching ~50+ files from NHC sequentially (~10-15 s); in
    parallel it's a couple seconds. Per-bulletin cache means warm builds only
    fetch the 1-2 newly-posted files."""
    if not urls:
        return {}
    out = {}
    try:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=12) as ex:
            for u, txt in zip(urls, ex.map(_fetch_text, urls)):
                out[u] = txt
    except Exception:
        for u in urls:           # fallback: sequential
            out[u] = _fetch_text(u)
    return out


def _fetch_latest_hdob(atcf_id: str, now: datetime) -> list:
    """Fetch the low-latency 'newest HDOB' feed(s) for this storm's basin and
    return parsed bulletins (list, possibly empty). Closes the ~20-min archive
    lag with the freshest leg. NOT cached on URL (the file's *contents* change in
    place each issuance, unlike the timestamped archive files)."""
    basin = "EP" if atcf_id[:2].upper() in ("EP", "CP") else "AL"
    urls = _LATEST_HDOB_FEEDS.get(basin, [])
    out = []
    seen = set()
    for url, txt in _fetch_texts(urls).items():
        if not txt:
            continue
        try:
            parsed = _parse_hdob_bulletin(txt, now)
        except Exception:
            parsed = None
        if not parsed or not parsed.get("obs"):
            continue
        # Two issuing centers can mirror the same bulletin — dedup by (tail, last ob time).
        key = (parsed.get("tail"), parsed["obs"][-1].get("t"))
        if key in seen:
            continue
        seen.add(key)
        out.append(parsed)
    return out


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


# ── NOAA 1-Hz flight-level (AOC "AAMPS" IWG1) ────────────────────────────────
#
# NOAA's WP-3D / G-IV aircraft broadcast a 1-second IWG1 packet that AOC mirrors
# as a growing per-flight text file. It is far richer + higher-res than the 30-s
# HDOB the same aircraft also file (per-second winds/thermo, continuous SFMR
# surface wind + rain, SST). For NOAA tails we source the track from IWG1 and
# fall back to HDOB only if IWG1 is unavailable; USAF aircraft (AFxxx) have no
# IWG1 feed and always use HDOB. We pull it server-side (cached, incremental
# Range fetch) so the public hits our API, never NOAA AOC directly.
IWG1_BASE = "https://seb.omao.noaa.gov/pub/flight/aamps_ingest/iwg1"

# AOC flight-id aircraft letter -> the HDOB tail string we key tracks by, so an
# IWG1 track REPLACES the same aircraft's HDOB track rather than double-counting.
# (Empirically, cross-checked vs the HDOB feed: I=N43RF=NOAA3, N=N49RF=NOAA9,
# H=N42RF=NOAA2.)
_IWG1_AIRCRAFT = {"H": "NOAA2", "I": "NOAA3", "N": "NOAA9"}

_IWG1_DECIMATE_S = 10     # default bin (s): 10-s vector-mean FL wind, matching ops
_IWG1_FINE_S = 1          # "1-s" toggle resolution (full-rate, on demand)
_IWG1_MEAN_WIN_S = 10     # averaging window for the 10-s mean wind (sustained + peak basis)
_IWG1_PEAK_WIN_S = 30     # window over which "peak FL wind" = max of the 10-s mean wind
_IWG1_MIN_FETCH_S = 120   # min seconds between upstream NOAA-AOC polls per flight
# Cache the NOAA flight-FOLDER discovery listing. Folders only appear at takeoff
# / vanish after landing, so re-listing the AAMPS iwg1 index on every ~60-s blob
# rebuild is wasted upstream load + handler time with zero freshness benefit (the
# actual track still comes from the incremental, Range-fetched _iwg1_fetch_text).
# Shared globally across storms/viewers. Last-good is served on a fetch error.
_IWG1_DIR_TTL = 180
_iwg1_flights_cache = {"flights": [], "ts": 0.0}
_MS2KT = 1.943844         # IWG1 wind speed is m/s (confirmed vs P-3 cruise TAS)

# 0-indexed column positions in the comma-split IWG1 data line (per the
# IWG1_NAMES trailer; verified against live airborne obs).
_IWG1_C = {
    "time": 1, "lat": 2, "lon": 3, "alt": 4, "ta": 20, "td": 21, "ps": 23,
    "ws": 26, "wd": 27, "storm": 35, "psurf": 106, "sst": 116,
    "sfmr_ws": 135, "sfmr_ws_alt": 115, "sfmr_rain": 136, "sfmr_rain_alt": 112,
}

# Per-flight raw-text cache: flid -> {"text": str, "len": int (bytes)}.
_iwg1_cache: dict = {}


def _iwg1_num(parts: list, idx: int):
    """Float at column idx, or None when missing/blank."""
    if idx >= len(parts):
        return None
    v = parts[idx].strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _iwg1_active_flights(now: datetime) -> list:
    """Discover recent NOAA flight folders (YYYYMMDD{H|I|N}{n}) from the AAMPS
    iwg1 directory. Returns [{flid, tail, url}] for flights dated within ~36 h
    (today/yesterday UTC), newest first. Result cached _IWG1_DIR_TTL s (folders
    change only at takeoff/landing); last-good served on a fetch error."""
    c = _iwg1_flights_cache
    if (time.time() - c["ts"]) < _IWG1_DIR_TTL:
        return list(c["flights"])
    try:
        from tc_radar_api import _hrd_fetch_text
        html = _hrd_fetch_text(IWG1_BASE + "/", timeout=15)
    except Exception as e:
        logger.warning("iwg1 dir list failed: %s", e)
        return list(c["flights"])   # serve last-good rather than dropping a flight
    if not html:
        return list(c["flights"])
    recent = {(now - timedelta(days=d)).strftime("%Y%m%d") for d in (0, 1)}
    out = {}
    for m in re.finditer(r'(\d{8})([HIN])(\d)/', html):
        ymd, letter, n = m.group(1), m.group(2), m.group(3)
        if ymd not in recent:
            continue
        tail = _IWG1_AIRCRAFT.get(letter)
        if not tail:
            continue
        flid = f"{ymd}{letter}{n}"
        out[flid] = {"flid": flid, "tail": tail,
                     "url": f"{IWG1_BASE}/{flid}/{flid}_iwg1.txt"}
    flights = sorted(out.values(), key=lambda f: f["flid"], reverse=True)
    c["flights"] = flights
    c["ts"] = time.time()
    return list(flights)


def _iwg1_fetch_text(flight: dict) -> str:
    """Fetch the flight's IWG1 file, INCREMENTALLY when possible. The file is
    append-only and grows to MBs over a sortie; an HTTP Range request pulls only
    the bytes added since the last poll. Falls back to a full GET if Range is
    unsupported.

    Throttled to `_IWG1_MIN_FETCH_S`: 1-s data refreshes plenty often at ~2 min,
    and the blob rebuilds every ~50 s, so without this we'd hit NOAA AOC 2-3× more
    than needed. Between fetches we serve the cached text (the public still polls
    OUR API every minute — only the upstream NOAA poll is rate-limited)."""
    flid = flight["flid"]
    cache = _iwg1_cache.setdefault(flid, {"text": "", "len": 0, "ts": 0.0})
    if cache["text"] and (time.time() - cache.get("ts", 0.0)) < _IWG1_MIN_FETCH_S:
        return cache["text"]            # within the upstream-poll window — reuse
    cache["ts"] = time.time()
    try:
        import requests
    except Exception:
        from tc_radar_api import _hrd_fetch_text
        txt = _hrd_fetch_text(flight["url"], timeout=25)
        if txt:
            cache["text"], cache["len"] = txt, len(txt.encode("utf-8", "replace"))
        return cache["text"]
    headers = {}
    if cache["len"]:
        headers["Range"] = f"bytes={cache['len']}-"
    try:
        r = requests.get(flight["url"], headers=headers, timeout=25)
    except Exception as e:
        logger.debug("iwg1 fetch %s: %s", flid, e)
        return cache["text"]
    if r.status_code == 206:            # partial — append the new tail bytes
        cache["text"] += r.content.decode("utf-8", "replace")
        cache["len"] += len(r.content)
    elif r.status_code == 200:          # full body (first fetch or Range ignored)
        cache["text"] = r.content.decode("utf-8", "replace")
        cache["len"] = len(r.content)
    elif r.status_code == 416:          # range past EOF — nothing new since last poll
        pass
    else:
        logger.debug("iwg1 fetch %s HTTP %s", flid, r.status_code)
    return cache["text"]


def _parse_iwg1_text(text: str, sim_now: datetime, res: int = _IWG1_DECIMATE_S) -> tuple:
    """Parse an IWG1 file body into (obs, label).

    obs are normalized to the HDOB ob schema (so the whole frontend renders them
    unchanged). The 1-s stream is binned into `res`-second windows; within each
    bin the flight-level wind (`wspd_kt`/`wdir`) is the VECTOR MEAN of the 1-s
    winds — so the default res=10 gives the operational 10-s mean wind rather than
    raw 1-s noise (res=1 = full 1-s, the "1-s" toggle). `peak_fl_kt` stays a
    rolling _IWG1_PEAK_WIN_S peak over the full 1-s stream (HDOB-style peak wind).
    label is the IWG1 STORMID (an ATCF id like 'AL012026' once the aircraft is
    on-station), used for storm attribution exactly like an HDOB system label."""
    raw = []
    label = ""
    C = _IWG1_C
    for ln in text.splitlines():
        # Data records start with the literal "IWG1," ; skip the interleaved
        # "IWG1_NAMES," schema lines and any partial trailing line.
        if not ln.startswith("IWG1,"):
            continue
        parts = ln.split(",")
        if parts[0] != "IWG1" or len(parts) <= C["wd"]:
            continue
        try:
            dt = datetime.strptime(parts[C["time"]].strip(),
                                   "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
        except (ValueError, IndexError):
            continue
        if dt > sim_now:        # never reveal obs past the (replay) clock
            continue
        lat = _iwg1_num(parts, C["lat"])
        lon = _iwg1_num(parts, C["lon"])
        if lat is None or lon is None or abs(lat) < 0.05 or abs(lon) < 0.05:
            continue            # pre-takeoff / missing-position rows
        st = parts[C["storm"]].strip() if C["storm"] < len(parts) else ""
        if st and st.upper() not in ("NONE", "NONE NONE"):
            label = st
        ws = _iwg1_num(parts, C["ws"])
        wd = _iwg1_num(parts, C["wd"])
        sfmr = _iwg1_num(parts, C["sfmr_ws"])
        if sfmr is None:
            sfmr = _iwg1_num(parts, C["sfmr_ws_alt"])
        rain = _iwg1_num(parts, C["sfmr_rain"])
        if rain is None:
            rain = _iwg1_num(parts, C["sfmr_rain_alt"])
        ps = _iwg1_num(parts, C["ps"])
        psurf = _iwg1_num(parts, C["psurf"])
        sst = _iwg1_num(parts, C["sst"])
        ta = _iwg1_num(parts, C["ta"])
        td = _iwg1_num(parts, C["td"])
        alt = _iwg1_num(parts, C["alt"])
        raw.append({
            "_dt": dt,
            "t": dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "lat": round(lat, 4), "lon": round(lon, 4),
            "fl_pres_mb": round(ps, 1) if ps is not None else None,
            "geo_alt_m": int(alt) if alt is not None else None,
            "sfc_p_or_dval": None, "dval_m": None,
            "extrap_sfc_p_mb": round(psurf, 1) if psurf is not None else None,
            "temp_c": round(ta, 1) if ta is not None else None,
            "dewpt_c": round(td, 1) if td is not None else None,
            "wdir": int(round(wd)) % 360 if wd is not None else None,
            "wspd_kt": round(ws * _MS2KT) if ws is not None else None,
            "sfmr_kt": round(sfmr * _MS2KT) if sfmr is not None else None,
            "sfmr_rain": round(rain) if rain is not None else None,
            "sst_c": round(sst, 1) if sst is not None else None,
            "qc": None, "src": "iwg1",
            "_ws_kt": ws * _MS2KT if ws is not None else None,
            # wind components (m/s, meteorological "from") for vector averaging
            "_u": (-ws * math.sin(math.radians(wd))) if (ws is not None and wd is not None) else None,
            "_v": (-ws * math.cos(math.radians(wd))) if (ws is not None and wd is not None) else None,
        })
    if not raw:
        return [], label
    raw.sort(key=lambda r: r["_dt"])

    # "Peak FL wind" must be the highest 10-SECOND-MEAN wind — NOT a raw 1-s gust
    # (peaking on 1-s data gave a misleadingly high value, e.g. 74 kt). So:
    #   (1) sliding _IWG1_MEAN_WIN_S (10-s) VECTOR-mean wind at each 1-s sample, then
    #   (2) the rolling MAX of that 10-s mean over a trailing _IWG1_PEAK_WIN_S (30-s)
    #       window — mirroring HDOB's "peak 10-s wind within the 30-s ob".
    mwin = timedelta(seconds=_IWG1_MEAN_WIN_S)
    lo, su, sv, nc = 0, 0.0, 0.0, 0
    for i in range(len(raw)):
        if raw[i]["_u"] is not None:
            su += raw[i]["_u"]; sv += raw[i]["_v"]; nc += 1
        while raw[lo]["_dt"] < raw[i]["_dt"] - mwin:
            if raw[lo]["_u"] is not None:
                su -= raw[lo]["_u"]; sv -= raw[lo]["_v"]; nc -= 1
            lo += 1
        raw[i]["_m10"] = (math.hypot(su / nc, sv / nc) * _MS2KT) if nc > 0 else None
    pwin = timedelta(seconds=_IWG1_PEAK_WIN_S)
    lo = 0
    for i in range(len(raw)):
        while raw[lo]["_dt"] < raw[i]["_dt"] - pwin:
            lo += 1
        peak = None
        for k in range(lo, i + 1):
            w = raw[k]["_m10"]
            if w is not None and (peak is None or w > peak):
                peak = w
        raw[i]["peak_fl_kt"] = round(peak) if peak is not None else None

    # Bin into `res`-second windows. The representative row (the freshest in the
    # bin) carries position/thermo/peak; its sustained wind is the VECTOR MEAN of
    # the bin's 1-s winds (res=1 ⇒ one row/bin ⇒ instantaneous 1-s wind).
    res = max(1, int(res or _IWG1_DECIMATE_S))
    obs = []
    t0 = raw[0]["_dt"]

    def _flush(rows):
        if not rows:
            return
        rep = rows[-1]
        us = [x["_u"] for x in rows if x["_u"] is not None]
        vs = [x["_v"] for x in rows if x["_v"] is not None]
        if us:
            mu, mv = sum(us) / len(us), sum(vs) / len(vs)
            sp = math.hypot(mu, mv)
            rep["wspd_kt"] = round(sp * _MS2KT)
            if sp > 0.1:
                rep["wdir"] = int(round((math.degrees(math.atan2(-mu, -mv)) + 360) % 360))
        obs.append(rep)

    cur_bin, bin_rows = None, []
    for r in raw:
        b = int((r["_dt"] - t0).total_seconds() // res)
        if cur_bin is None:
            cur_bin = b
        if b != cur_bin:
            _flush(bin_rows)
            bin_rows = []
            cur_bin = b
        bin_rows.append(r)
    _flush(bin_rows)
    for r in obs:                      # strip internal scratch fields
        for k in ("_dt", "_ws_kt", "_u", "_v", "_m10"):
            r.pop(k, None)
    return obs, label


def _merge_iwg1(aircraft: dict, aircraft_names: dict, aircraft_src: dict,
                sim_now: datetime, res: int = _IWG1_DECIMATE_S) -> None:
    """Source NOAA aircraft tracks from the 1-s IWG1 feed (overriding their 30-s
    HDOB track), binned to `res`-second mean winds. USAF aircraft are untouched.
    Best-effort: any flight that fails to fetch/parse leaves its HDOB track."""
    flights = _iwg1_active_flights(sim_now)
    # Drop cached raw text for flights no longer recent (each can be tens of MB).
    live_flids = {f["flid"] for f in flights}
    for stale in [k for k in _iwg1_cache if k not in live_flids]:
        _iwg1_cache.pop(stale, None)
    # Accumulate every active IWG1 sortie PER TAIL first. _iwg1_active_flights
    # returns each tail's recent flights (a just-launched sortie AND the prior
    # one it flew the same day), newest-first — so a plain `aircraft[tail] = …`
    # per flight lets whichever is processed LAST win, i.e. the OLDEST, silently
    # dropping the fresh sortie. Merge the sorties into one obs map instead;
    # _split_sorties later separates them back into selectable flights.
    iwg1_by_tail: dict = {}     # tail -> {ob_t: ob} across all its active sorties
    for fl in flights:
        try:
            obs, label = _parse_iwg1_text(_iwg1_fetch_text(fl), sim_now, res)
        except Exception as e:
            logger.warning("iwg1 parse %s: %s", fl.get("flid"), e)
            continue
        if not obs:
            continue
        tail = fl["tail"]
        acc = iwg1_by_tail.setdefault(tail, {})
        for ob in obs:
            acc[ob["t"]] = ob
        aircraft_src[tail] = "iwg1"
        if label:
            aircraft_names.setdefault(tail, set()).add(label)
    # IWG1 overrides the 30-s HDOB track, but only across the time spans it
    # actually covers: a NOAA sortie older than the IWG1 directory window
    # (HDOB-only) still survives, while an IWG1-covered sortie isn't polluted by
    # mixing 30-s HDOB obs into the 1-s feed.
    for tail, acc in iwg1_by_tail.items():
        iwg1_track = [acc[k] for k in sorted(acc)]
        spans = []
        for st in _split_sorties(iwg1_track):
            t0 = _parse_ob_iso(st[0].get("t"))
            t1 = _parse_ob_iso(st[-1].get("t"))
            if t0 and t1:
                spans.append((t0, t1))
        merged = {}
        for t, ob in aircraft.get(tail, {}).items():   # keep HDOB outside IWG1 spans
            ot = _parse_ob_iso(t)
            if ot is None or not any(s0 <= ot <= s1 for s0, s1 in spans):
                merged[t] = ob
        merged.update(acc)
        aircraft[tail] = merged


# A tail's obs come every ~30 s while it is airborne, so a multi-hour break in
# its track unambiguously means the plane landed and later flew a fresh sortie.
# 3 h is comfortably longer than any in-flight transmission gap yet shorter than
# a realistic turnaround, so it cleanly separates back-to-back missions by the
# same aircraft (which HDOB keys by tail, merging them into one long track).
_SORTIE_GAP_S = 3 * 3600


def _parse_ob_iso(t: str):
    """Parse an ob's ISO 't' (…T%H:%M:%SZ, or IWG1's fractional variant) → aware
    datetime, or None if unparseable."""
    if not t:
        return None
    try:
        return datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            return datetime.fromisoformat(t.replace("Z", "+00:00"))
        except ValueError:
            return None


def _split_sorties(track: list, gap_s: int = _SORTIE_GAP_S) -> list:
    """Split one tail's time-ordered track into separate sorties wherever there is
    a >gap_s idle break. Returns a list of contiguous sub-tracks, oldest first
    (a single-flight track returns [track])."""
    if not track:
        return []
    sorties, cur = [], [track[0]]
    prev = _parse_ob_iso(track[0].get("t"))
    for o in track[1:]:
        cur_t = _parse_ob_iso(o.get("t"))
        if (prev is not None and cur_t is not None and
                (cur_t - prev).total_seconds() > gap_s):
            sorties.append(cur)
            cur = []
        cur.append(o)
        if cur_t is not None:
            prev = cur_t
    if cur:
        sorties.append(cur)
    return sorties


def _build_blob(atcf_id: str, hours: int, sim_now: datetime, name: str = "",
                storm_lat: float = None, storm_lon: float = None,
                mission_tail: str = "", live_feed: bool = True,
                fl_res: int = _IWG1_DECIMATE_S) -> dict:
    """Assemble the cumulative recon blob for one storm as of sim_now. When
    mission_tail is set, run in MISSION mode: return only that aircraft's full
    track (+ sondes/VDM near it), bypassing storm attribution — this is how an
    airborne flight is shown even when its system isn't a tracked storm."""
    dirs = _basin_dirs(atcf_id)
    year = sim_now.year
    since = sim_now - timedelta(hours=hours)

    # ── HDOB → per-aircraft tracks ──
    aircraft: dict = {}
    aircraft_names: dict = {}   # tail -> {system labels from the bulletins}
    aircraft_atcf: dict = {}    # tail -> {ATCF ids decoded from the mission-ID field}
    aircraft_src: dict = {}     # tail -> data source ("iwg1" for NOAA 1-s)
    hdob_dir = f"{NHC_RECON_BASE}/{year}/{dirs['hdob']}/"
    hdob_urls = _list_recent_files(hdob_dir, since, sim_now)
    _hdob_fetched = _fetch_texts([u for u in hdob_urls if u not in _bulletin_cache])
    for url in hdob_urls:
        if url in _bulletin_cache:
            parsed = _bulletin_cache[url]
        else:
            txt = _hdob_fetched.get(url)
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
        if parsed.get("atcf"):
            aircraft_atcf.setdefault(parsed["tail"], set()).add(parsed["atcf"])
        for ob in parsed["obs"]:
            tk[ob["t"]] = ob  # dedup by ISO time within a tail

    # Merge the low-latency "newest bulletin" feed so the track reaches the
    # aircraft's latest leg instead of trailing the slower archive directory by
    # ~20 min. Same accumulation path (dedup by ISO time). Skipped in replay,
    # where the live feed would inject obs from after the simulated clock.
    if live_feed:
        for parsed in _fetch_latest_hdob(atcf_id, sim_now):
            tk = aircraft.setdefault(parsed["tail"], {})
            if parsed.get("storm"):
                aircraft_names.setdefault(parsed["tail"], set()).add(parsed["storm"])
            if parsed.get("atcf"):
                aircraft_atcf.setdefault(parsed["tail"], set()).add(parsed["atcf"])
            for ob in parsed["obs"]:
                tk[ob["t"]] = ob

    # NOAA aircraft: replace the 30-s HDOB track with the 1-s IWG1 feed (richer +
    # far higher-res). USAF aircraft have no IWG1 feed and keep HDOB. Live only —
    # the IWG1 file is the current sortie, so in replay it would inject obs past
    # the simulated clock.
    if live_feed:
        _merge_iwg1(aircraft, aircraft_names, aircraft_src, sim_now, fl_res)

    # In replay, hide obs the simulated clock hasn't "reached" yet.
    sim_iso = sim_now.strftime("%Y-%m-%dT%H:%M:%SZ")
    # The directory returns EVERY flight in the window — including non-TC research
    # sorties (e.g. TEXAQS) that share the AHONT1 feed. Attribute an aircraft to
    # this storm by its MISSION ID (authoritative when the crew filed a numbered
    # mission), else by its bulletin LABEL (ONE / AL01 / INVEST / cyclone number),
    # else by being demonstrably at the storm core; this keeps the real sortie
    # (even its ferry leg) while dropping a research flight that merely passes
    # within a few degrees.
    norm_q = re.sub(r"[^A-Z0-9]", "", (name or "").upper())

    def _label_matches(lbl: str) -> bool:
        return _label_matches_storm(lbl, atcf_id, name)

    aircraft_out = []

    def _emit_sorties(tail, track, src):
        """Append one aircraft entry per sortie (a plane that flew twice in the
        window becomes two selectable flights instead of one long merged track)."""
        sorties = _split_sorties(track)
        n = len(sorties)
        for si, st in enumerate(sorties):
            aircraft_out.append({
                "tail": tail, "track": st, "src": src,
                "sortie": st[0]["t"],        # stable per-tail id (start time)
                "sortie_start": st[0]["t"],
                "sortie_end": st[-1]["t"],
                "sortie_index": si,          # 0 = oldest of this tail's sorties
                "n_sorties": n,
            })

    for tail, obmap in aircraft.items():
        track = [obmap[k] for k in sorted(obmap) if k <= sim_iso]
        if not track:
            continue
        # Mission mode: keep only the requested aircraft, whole track, no
        # storm attribution (the user explicitly selected this flight).
        if mission_tail:
            if tail.upper() == mission_tail:
                _emit_sorties(tail, track, aircraft_src.get(tail, "hdob"))
            continue
        labels = aircraft_names.get(tail, set())
        name_ok = any(_label_matches(l) for l in labels)
        # The mission ID names the storm the sortie was FILED for, so it settles
        # attribution outright — both ways. A mission filed for a different storm
        # is that storm's, however close it flies to this one.
        mids = aircraft_atcf.get(tail, set())
        atcf_ok = atcf_id.upper() in mids
        atcf_conflict = bool(mids) and not atcf_ok
        # A flight that explicitly labels itself a DIFFERENT specific system
        # (not this storm, not a bare "INVEST") is that system's sortie — never
        # attribute it here, even if it passes within the core. This is what
        # keeps a non-TC research flight (e.g. TEXAQS surveying inland Texas)
        # out of a nearby offshore storm, regardless of how close it drifts.
        conflicting = any(
            re.sub(r"[^A-Z0-9]", "", (l or "").upper()) not in _GENERIC_LABELS
            and not _label_matches(l)
            for l in labels
        )
        at_core = (storm_lat is not None and storm_lon is not None and
                   any(_deg_dist(o["lat"], o["lon"], storm_lat, storm_lon) <= _STORM_CORE_DEG
                       for o in track))
        keep = atcf_ok or (not atcf_conflict and (name_ok or (at_core and not conflicting)))
        # Only filter when we have something to match against (a name and/or a
        # position). With neither (shouldn't happen via the UI) keep, as before.
        if (norm_q or storm_lat is not None) and not keep:
            continue
        _emit_sorties(tail, track, aircraft_src.get(tail, "hdob"))
    # Freshest sortie first, so the frontend's default (aircraft[0]) is the
    # current flight and older sorties fall below it in the flight selector.
    aircraft_out.sort(key=lambda a: a["track"][-1]["t"], reverse=True)

    # Points of the kept aircraft track(s) — used to attribute sondes/VDMs by
    # proximity (and the sole gate in mission mode).
    track_pts = [(o["lat"], o["lon"]) for a in aircraft_out for o in a["track"]]

    # ── VDM center fixes (reuse global_archive parser) ──
    vdms = []
    try:
        from global_archive_api import _parse_vdm_text, _resolve_vdm_time
        vdm_dir = f"{NHC_RECON_BASE}/{year}/{dirs['vdm']}/"
        sd = since.strftime("%Y-%m-%d")
        ed = sim_now.strftime("%Y-%m-%d")
        _vdm_urls = _list_recent_files(vdm_dir, since, sim_now)
        _vdm_fetched = _fetch_texts([u for u in _vdm_urls if ("vdm::" + u) not in _bulletin_cache])
        for url in _vdm_urls:
            txt = _bulletin_cache.get("vdm::" + url)
            if txt is None:
                raw = _vdm_fetched.get(url)
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
            if mission_tail:
                # Mission mode: keep VDMs near the selected aircraft's track.
                if not (track_pts and _near_track(v["lat"], v["lon"], track_pts)):
                    continue
            elif v.get("atcf_id") and v["atcf_id"].upper() != atcf_id.upper():
                continue
            tiso = v.get("time")
            if tiso and tiso > sim_iso:
                continue  # replay gate
            vdms.append({
                "t": tiso, "lat": v.get("lat"), "lon": v.get("lon"),
                "min_slp_hpa": v.get("min_slp_hpa"),
                "flight_level_mb": v.get("flight_level_mb"),
                "fix_height_m": v.get("fix_height_m"),
                "max_fl_wind_kt": v.get("max_fl_wind_kt"),
                "max_fl_wind_bearing": v.get("max_fl_wind_bearing"),
                "max_fl_wind_range_nm": v.get("max_fl_wind_range_nm"),
                "max_sfmr_kt": v.get("max_sfmr_kt"),
                "eye_temp_c": v.get("eye_temp_c"),
                "eyewall_temp_c": v.get("eyewall_temp_c"),
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
    # Attribute exactly like HDOB: keep a sonde if its TEMP DROP label identifies
    # THIS storm, or it is near the storm AND not explicitly labelled for a
    # different system. This keeps a research flight's sondes (e.g. TEXAQS) out
    # even after its HDOB has been filtered (so the aircraft track is empty) —
    # the old "near the track" gate became a no-op with no track and let them in.
    drops = []
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        drop_dir = f"{NHC_RECON_BASE}/{year}/{dirs['drop']}/"
        _drop_urls = _list_recent_files(drop_dir, since, sim_now)
        _drop_fetched = _fetch_texts([u for u in _drop_urls if ("drop::" + u) not in _bulletin_cache])
        for url in _drop_urls:
            cached = _bulletin_cache.get("drop::" + url)
            if cached is None:
                txt = _drop_fetched.get(url)
                m = re.search(r"\.(\d{12})\.txt$", url)
                fdt = datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
                cached = _parse_tempdrop_bulletin(txt, fdt) if txt else []
                if len(_bulletin_cache) < _BULLETIN_CACHE_MAX:
                    _bulletin_cache["drop::" + url] = cached
            for d in cached:
                if not (since_iso <= (d["t"] or "") <= sim_iso):
                    continue
                if mission_tail:
                    # Mission mode: keep sondes near the selected aircraft's track.
                    if not (track_pts and _near_track(d["lat"], d["lon"], track_pts)):
                        continue
                    drops.append(d)
                    continue
                lbl = d.get("storm")
                name_ok_d = _label_matches(lbl) if lbl else False
                conflicting_d = (re.sub(r"[^A-Z0-9]", "", (lbl or "").upper()) not in _GENERIC_LABELS
                                 and not name_ok_d)
                near_d = bool(track_pts) and _near_track(d["lat"], d["lon"], track_pts)
                if not near_d and storm_lat is not None and storm_lon is not None:
                    near_d = _deg_dist(d["lat"], d["lon"], storm_lat, storm_lon) <= _STORM_CORE_DEG
                if not (name_ok_d or (near_d and not conflicting_d)):
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
    tail: str = Query("", description="Mission mode: return ONLY this aircraft's track "
                                      "(+ nearby sondes/VDM), bypassing storm attribution"),
    replay: str = Query("", description="Replay anchor YYYYMMDDHHMM (dev/testing)"),
    speed: float = Query(60.0, ge=1.0, le=600.0, description="Replay speed multiplier"),
    fl1s: int = Query(0, description="1 = NOAA flight-level wind at full 1-s res "
                                     "(default 0 = operational 10-s mean wind)"),
):
    """Cumulative real-time recon for a storm (or a single mission via tail=)."""
    atcf_id = atcf_id.upper().strip()
    tail = (tail or "").upper().strip()
    if len(atcf_id) < 8:
        return JSONResponse({"error": "bad atcf_id"}, status_code=400)

    fl_res = _IWG1_FINE_S if fl1s else _IWG1_DECIMATE_S

    if replay and not _ALLOW_REPLAY:
        replay = ""  # ignore replay in production → live data only

    if replay:
        sim_now = _replay_now(atcf_id, replay, speed)
        if sim_now is None:
            return JSONResponse({"error": "bad replay anchor"}, status_code=400)
        cache_key = f"{atcf_id}:{hours}:{name}:{lat}:{lon}:{tail}:{fl_res}:replay:{replay}:{speed}:{int(time.time() // 5)}"
        cc = "no-store"
    else:
        sim_now = datetime.now(timezone.utc)
        cache_key = f"{atcf_id}:{hours}:{name}:{lat}:{lon}:{tail}:{fl_res}:live"
        cc = "public, max-age=45, s-maxage=45, stale-while-revalidate=60"

    now = time.time()
    hit = _blob_cache.get(cache_key)
    if hit and (now - hit[1]) < _BLOB_TTL:
        return JSONResponse(hit[0], headers={"Cache-Control": cc})

    blob = _build_blob(atcf_id, hours, sim_now, name=name, storm_lat=lat, storm_lon=lon,
                       mission_tail=tail, live_feed=not replay, fl_res=fl_res)
    _blob_cache[cache_key] = (blob, now)
    if len(_blob_cache) > 200:
        _blob_cache.pop(next(iter(_blob_cache)))
    return JSONResponse(blob, headers={"Cache-Control": cc})


@router.get("/active-missions")
def recon_active_missions(hours: int = Query(6, ge=1, le=24)):
    """Mission-centric discovery: every aircraft currently posting HDOB, grouped
    by tail — independent of whether its system is a tracked storm. Lets the UI
    surface a flight (e.g. into an undesignated disturbance) that storm-keyed
    attribution would miss. Cheap: reuses the per-bulletin cache."""
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=hours)
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    missions: dict = {}

    def _merge_mission(parsed, basin):
        if not parsed or not parsed.get("obs"):
            return
        last = parsed["obs"][-1]
        # The tgftp "newest bulletin" feeds hold whatever was posted LAST, which
        # during a quiet spell is days old and from another basin — NOAA2's
        # yesterday-ferry bulletin sat in the Atlantic feed and stamped its
        # in-progress Pacific mission "AL". Bound them by the same window the
        # archive listing is bounded by.
        if last["t"] < since_iso:
            return
        tail = parsed["tail"]
        mm = missions.setdefault(tail, {
            "tail": tail, "labels": set(), "n_obs": 0, "basin": basin,
            "atcf": None, "last_t": "", "lat": None, "lon": None})
        if parsed.get("storm"):
            mm["labels"].add(parsed["storm"])
        if parsed.get("atcf"):
            # Mission ID beats the directory the bulletin was found in: AHOPN1
            # carries both EP and CP missions.
            mm["atcf"] = parsed["atcf"]
            mm["basin"] = parsed["atcf"][:2]
        mm["n_obs"] += len(parsed["obs"])
        if last["t"] > mm["last_t"]:
            mm["last_t"], mm["lat"], mm["lon"] = last["t"], last["lat"], last["lon"]

    for basin, hdob in (("AL", "AHONT1"), ("EP", "AHOPN1")):
        dir_url = f"{NHC_RECON_BASE}/{now.year}/{hdob}/"
        _mis_urls = _list_recent_files(dir_url, since, now)
        _mis_fetched = _fetch_texts([u for u in _mis_urls if u not in _bulletin_cache])
        for url in _mis_urls:
            parsed = _bulletin_cache.get(url)
            if parsed is None:
                txt = _mis_fetched.get(url)
                m = re.search(r"\.(\d{12})\.txt$", url)
                fdt = datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
                parsed = _parse_hdob_bulletin(txt, fdt) if txt else None
                if len(_bulletin_cache) < _BULLETIN_CACHE_MAX:
                    _bulletin_cache[url] = parsed
            _merge_mission(parsed, basin)
        # Pull the low-latency newest bulletin so a just-launched flight (or the
        # freshest leg) shows up well before the archive directory catches up.
        for parsed in _fetch_latest_hdob("AL01" if basin == "AL" else "EP01", now):
            _merge_mission(parsed, basin)
    out = [{
        "tail": m["tail"],
        "label": (sorted(m["labels"])[0] if m["labels"] else ""),
        "labels": sorted(m["labels"]),
        "n_obs": m["n_obs"], "basin": m["basin"], "atcf": m["atcf"],
        "last_t": m["last_t"], "lat": m["lat"], "lon": m["lon"],
    } for m in missions.values()]
    out.sort(key=lambda x: x["last_t"], reverse=True)
    return JSONResponse(
        {"missions": out, "updated_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ")},
        headers={"Cache-Control": "public, max-age=45, s-maxage=45"})
