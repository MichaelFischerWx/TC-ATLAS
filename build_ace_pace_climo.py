"""Per-basin ACE *pace* climatology for the RT Monitor Seasonal tab.

Panel A ("Season ACE pace") answers one question: given how far into the
season we are, is this year running ahead of or behind normal? That needs
cumulative ACE as a function of day-of-season — not the annual totals
`build_oisst_history.py --step ace` already writes.

This builder walks IBTrACS.ALL once and emits, per basin:

  * `climo`  — dense day-of-season arrays (p10/p25/p50/p75/p90/mean) of
               cumulative ACE over the 1991-2020 WMO normal period.
  * `years`  — per-season cumulative curves as SPARSE [day, cum] pairs
               (the curve is piecewise-constant, so only days where ACE
               actually accrued are stored; the frontend step-fills).
  * `totals` — season totals, for the year picker and record labels.

Wind convention
---------------
Unlike `build_ace_all_basins`, this builder prefers `usa_wind` (NHC/JTWC
1-minute sustained) over `wmo_wind`. That is deliberate: the live
season-to-date curve on the same axes comes from operational ATCF b-decks,
which are US-agency 1-minute winds. Using `wmo_wind` first would put a
JMA 10-minute West Pacific climatology (mean ≈ 208) underneath a JTWC
1-minute live curve (climatological mean ≈ 290) and every WP season would
look like a record. Same reason SI/SP use the JTWC winds.

Day-of-season axis
------------------
Northern Hemisphere basins (NA, EP, WP, NI) run Jan 1 → Dec 31.
Southern Hemisphere basins (SI, SP) run Jul 1 → Jun 30 and are labeled by
the year the season ENDS — the IBTrACS `season` convention, and the same
convention ATCF uses for its `sh##YYYY` storm ids. Both hemispheres are
mapped onto a 366-day leap-year frame so day indices are comparable
across years without a Feb 29 discontinuity.

Usage
-----
    python3 build_ace_pace_climo.py                 # build + upload
    python3 build_ace_pace_climo.py --local-only    # no GCS upload

Output: data/seasonal/ace_pace_climo.json (+ gs://<bucket>/seasonal/).
"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from build_oisst_history import (
    ACE_BASINS, ACE_VMAX_THRESH, IBTRACS_ALL_LOCAL,
    GCS_BUCKET, GCS_PREFIX,
)

IBTRACS_ALL_URL = (
    "https://www.ncei.noaa.gov/data/international-best-track-archive-for-"
    "climate-stewardship-ibtracs/v04r01/access/netcdf/IBTrACS.ALL.v04r01.nc"
)

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("build_ace_pace_climo")

CLIMO_START, CLIMO_END = 1991, 2020
HISTORY_START = 1982            # matches the SST-era start used site-wide
DAYS = 366                      # leap-year frame

# Basins whose season runs Jul → Jun and is named for the ending year.
SH_BASINS = {"SI", "SP"}

# Cumulative day-of-year for the 1st of each month in a LEAP year.
_LEAP_CUM = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]


def _leap_doy(month: int, day: int) -> int:
    """Day-of-year in a leap-year frame (Jan 1 = 1, Dec 31 = 366).

    Non-leap dates from Mar 1 on land one day later than their true DOY,
    which is what we want: it keeps Mar 1 aligned across all years.
    """
    return _LEAP_CUM[month - 1] + day


def _season_day(basin: str, year: int, month: int, day: int,
                season: int) -> int | None:
    """Index 1..366 along the basin's season axis, or None if the point
    falls outside the season it was filed under.

    Storms that are still going when the season's calendar window closes
    (Atlantic Zeta running Dec 30 → Jan 6, West Pacific Soulik into
    January) keep their original IBTrACS season, so their spillover points
    are pinned to the last day of the axis rather than dropped — dropping
    them silently shorted those storms, and their basins, by real ACE.
    """
    d = _leap_doy(month, day)
    if basin not in SH_BASINS:
        if year == season:
            return d
        # January of the following calendar year = tail of this season.
        return DAYS if (year == season + 1 and month == 1) else None
    # SH: Jul 1 of (season-1) = day 1, Jun 30 of season = day 366.
    if month >= 7:
        if year == season - 1:
            return d - 182
        # July of the season year = past Jun 30, i.e. the season's tail.
        return DAYS if (year == season and month == 7) else None
    return d + 184 if year == season else None


def _decode(x) -> str:
    return x.decode("utf-8") if isinstance(x, (bytes, bytearray)) else str(x)


def _season_is_over(basin: str, season: int,
                    today: datetime | None = None) -> bool:
    """Has this basin's `season` finished its calendar window?

    NH seasons close on Dec 31 of the season year; SH seasons close on
    Jun 30 of the season year (they open the previous Jul 1).
    """
    today = today or datetime.now(timezone.utc)
    if basin in SH_BASINS:
        current = today.year + 1 if today.month >= 7 else today.year
    else:
        current = today.year
    return season < current


def refresh_ibtracs(path: str) -> str:
    """Re-download IBTrACS.ALL (~23 MB, NCEI refreshes it every few weeks).

    Worth doing before a rebuild: the JTWC basins land in IBTrACS months
    after the fact, so a stale copy silently reports a near-zero WP/SI/SP
    season rather than a missing one.
    """
    import urllib.request
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    log.info("Downloading %s ...", IBTRACS_ALL_URL)
    with urllib.request.urlopen(IBTRACS_ALL_URL, timeout=300) as r, \
            open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.replace(dest)
    log.info("  saved %s (%.1f MB)", dest, dest.stat().st_size / 1e6)
    return str(dest)


def accumulate(ibtracs_path: str) -> dict:
    """Return {basin: {season: np.ndarray(366) cumulative ACE}}."""
    log.info("Reading %s ...", ibtracs_path)
    ds = xr.open_dataset(ibtracs_path)
    season_v = ds["season"].values
    wmo_wind = ds["wmo_wind"].values
    usa_wind = (ds["usa_wind"].values if "usa_wind" in ds
                else np.full_like(wmo_wind, np.nan))
    basin_v = ds["basin"].values
    track_type = ds["track_type"].values
    iso_time = ds["iso_time"].values
    nature = ds["nature"].values
    usa_status = (ds["usa_status"].values if "usa_status" in ds
                  else np.full(nature.shape, b"", dtype=object))
    storm_name = ds["name"].values if "name" in ds else None

    # US-PROVISIONAL covers storms IBTrACS has only from the US agencies
    # (NHC/JTWC) so far — that is nearly every JTWC-basin storm for the
    # last year or two. Dropping it (as the older annual-ACE builders did)
    # silently zeroes recent WP/NI/SP seasons. Since this builder reads
    # usa_wind anyway, those tracks are exactly the right ones to keep.
    ACCEPTED_TRACK_TYPES = {"main", "PROVISIONAL", "US-PROVISIONAL"}

    # Phase gate. ACE counts a point only while the system is tropical or
    # subtropical — never a disturbance, wave, remnant low, or
    # extratropical cyclone. Two fields carry that information and they
    # disagree on a small fraction of points:
    #   `nature`     — IBTrACS's cross-agency consensus (TS/SS/DS/ET/MX/NR)
    #   `usa_status` — the US agency's own call (TD/TS/HU/TY/ST/SD/SS/
    #                  EX/LO/DB/WV), which is the agency whose winds this
    #                  builder reads
    # Policy: accept when EITHER field says tropical/subtropical, but
    # reject outright whenever the US agency explicitly says it is not a
    # TC. That keeps the phase call aligned with the wind source, picks up
    # the ~0.8% of points IBTrACS marks MX (mixed agency reports) while
    # NHC/JTWC call them a tropical storm, and still drops every DS/ET
    # point the stricter nature-only gate dropped.
    ACE_NATURES = {"TS", "SS"}
    ACE_USA_STATUS = {"TD", "TS", "HU", "TY", "ST", "TC", "SD", "SS"}
    NON_TC_USA_STATUS = {"EX", "LO", "DB", "WV", "DS", "PT", "IN"}

    n_storms, n_times = wmo_wind.shape
    # daily[basin][season] = per-day (not cumulative) ACE increments
    daily: dict[str, dict[int, np.ndarray]] = {b: {} for b in ACE_BASINS}
    storms: dict[str, dict[int, int]] = {b: {} for b in ACE_BASINS}
    per_storm: dict[str, dict[int, list]] = {}

    for i in range(n_storms):
        s = season_v[i]
        if np.isnan(s):
            continue
        s = int(s)
        if s < HISTORY_START:
            continue
        if _decode(track_type[i]) not in ACCEPTED_TRACK_TYPES:
            continue
        # Per-storm tally, keyed by basin so a system that crosses the
        # SI/SP boundary is credited exactly the way the curve is.
        rec_by_basin: dict[str, dict] = {}
        for j in range(n_times):
            tstr = _decode(iso_time[i, j])
            # 6-hourly synoptic times only — IBTrACS also carries 3-hourly
            # interpolated points, which would double-count.
            if (len(tstr) < 16 or tstr[11:13] not in ("00", "06", "12", "18")
                    or tstr[14:16] != "00"):
                continue
            st = _decode(usa_status[i, j]).strip().upper()
            if st in NON_TC_USA_STATUS:
                continue
            if (_decode(nature[i, j]) not in ACE_NATURES
                    and st not in ACE_USA_STATUS):
                continue
            b = _decode(basin_v[i, j])
            if b not in ACE_BASINS:
                continue
            v = usa_wind[i, j]
            if np.isnan(v):
                v = wmo_wind[i, j]
            if np.isnan(v) or v < ACE_VMAX_THRESH:
                continue
            sd = _season_day(b, int(tstr[:4]), int(tstr[5:7]), int(tstr[8:10]), s)
            if sd is None or not (1 <= sd <= DAYS):
                continue
            arr = daily[b].get(s)
            if arr is None:
                arr = np.zeros(DAYS, dtype=np.float64)
                daily[b][s] = arr
            contrib = float(v) * float(v) * 1e-4
            arr[sd - 1] += contrib
            rec = rec_by_basin.get(b)
            if rec is None:
                rec = rec_by_basin[b] = {"ace": 0.0, "peak": 0.0, "pts": 0,
                                         "first": sd, "last": sd}
            rec["ace"] += contrib
            rec["peak"] = max(rec["peak"], float(v))
            rec["pts"] += 1
            rec["first"] = min(rec["first"], sd)
            rec["last"] = max(rec["last"], sd)
        nm = _decode(storm_name[i]).strip().upper() if storm_name is not None else ""
        if nm in ("NOT_NAMED", "UNNAMED", "NOT NAMED", "NONAME"):
            nm = ""
        for b, rec in rec_by_basin.items():
            storms[b][s] = storms[b].get(s, 0) + 1
            # Compact row: [name, ace, peak_kt, first_day, last_day, points]
            per_storm.setdefault(b, {}).setdefault(s, []).append(
                [nm, round(rec["ace"], 2), int(rec["peak"]),
                 rec["first"], rec["last"], rec["pts"]])

    ds.close()
    cum = {b: {s: np.cumsum(a) for s, a in per.items()}
           for b, per in daily.items()}
    for b in per_storm:
        for s in per_storm[b]:
            per_storm[b][s].sort(key=lambda r: r[1], reverse=True)
    return {"cum": cum, "storms": storms, "per_storm": per_storm}


def _sparse(curve: np.ndarray) -> list:
    """Compress a monotone cumulative curve to [day, value] pairs at the
    days where it changes, plus a closing point at day 366."""
    out = []
    prev = 0.0
    for k in range(DAYS):
        v = float(curve[k])
        if v - prev > 1e-9:
            out.append([k + 1, round(v, 2)])
            prev = v
    if not out:
        return []
    if out[-1][0] != DAYS:
        out.append([DAYS, out[-1][1]])
    return out


def build(ibtracs_path: str, out_path: Path) -> Path:
    acc = accumulate(ibtracs_path)
    cum, storms, per_storm = acc["cum"], acc["storms"], acc["per_storm"]

    payload = {
        "vmax_threshold_kt": ACE_VMAX_THRESH,
        "climo_period": f"{CLIMO_START}-{CLIMO_END}",
        "history_start": HISTORY_START,
        "days": DAYS,
        "wind_source": "usa_wind (1-min) with wmo_wind fallback",
        "source": ibtracs_path.split("/")[-1],
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "basins": {},
    }

    for b, label in ACE_BASINS.items():
        per_season = cum[b]
        seasons = sorted(per_season)
        if not seasons:
            log.warning("  %s: no seasons found; skipping", b)
            continue
        climo_seasons = [s for s in seasons if CLIMO_START <= s <= CLIMO_END]
        # Seasons with genuinely zero ACE never got an array; treat them as
        # flat-zero curves so the percentiles aren't biased high.
        stack = np.zeros((max(len(climo_seasons), 1), DAYS), dtype=np.float64)
        for k, s in enumerate(climo_seasons):
            stack[k] = per_season[s]
        n_climo = len(climo_seasons)
        if n_climo < 20:
            log.warning("  %s: only %d climo seasons (expected 30)", b, n_climo)

        climo = {
            "p10":  np.percentile(stack, 10, axis=0),
            "p25":  np.percentile(stack, 25, axis=0),
            "p50":  np.percentile(stack, 50, axis=0),
            "p75":  np.percentile(stack, 75, axis=0),
            "p90":  np.percentile(stack, 90, axis=0),
            "mean": stack.mean(axis=0),
        }

        totals = {str(s): round(float(per_season[s][-1]), 2) for s in seasons}
        # The last season in IBTrACS is usually PROVISIONAL and partial —
        # flag it so the frontend doesn't offer it as a comparison year
        # while the live curve already covers it.
        record_season = max(totals, key=lambda k: totals[k])

        # Per-day record envelope: the fastest and slowest any season has
        # ever been through this same calendar date. This is what makes
        # "is this season at record pace?" answerable at any point in the
        # season, rather than only against the final total.
        #
        # Computed over COMPLETE seasons only. A season still in progress
        # is flat-zero for every day after today, which would drag the
        # minimum envelope to zero across the back half of the year and
        # make every season look record-slow.
        done = [s for s in seasons if _season_is_over(b, s)]
        rec_max = rec_min = rec_max_season = None
        if done:
            rstack = np.zeros((len(done), DAYS), dtype=np.float64)
            for k, s in enumerate(done):
                rstack[k] = per_season[s]
            rec_max = rstack.max(axis=0)
            rec_min = rstack.min(axis=0)
            rec_max_season = [int(done[i]) for i in rstack.argmax(axis=0)]

        payload["basins"][b] = {
            "name": label,
            "hemisphere": "SH" if b in SH_BASINS else "NH",
            "season_start_month": 7 if b in SH_BASINS else 1,
            "n_climo_seasons": n_climo,
            "climo": {k: [round(float(x), 2) for x in v]
                      for k, v in climo.items()},
            "record_pace": ({
                "max": [round(float(x), 2) for x in rec_max],
                "min": [round(float(x), 2) for x in rec_min],
                "max_season": rec_max_season,
                "seasons": [int(s) for s in (done[0], done[-1])],
                "n_seasons": len(done),
            } if rec_max is not None else None),
            "years": {str(s): _sparse(per_season[s]) for s in seasons},
            "totals": totals,
            "storms": {str(s): int(storms[b].get(s, 0)) for s in seasons},
            "last_season": int(seasons[-1]),
            "record": {"season": int(record_season),
                       "ace": totals[record_season]},
        }
        log.info("  %s (%s): %d seasons, climo total=%.1f, record=%.1f (%s)",
                 b, label, len(seasons), climo["mean"][-1],
                 totals[record_season], record_season)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    log.info("wrote %s (%.1f KB)", out_path,
             out_path.stat().st_size / 1024.0)

    # Per-storm breakdowns ship in their OWN file, lazy-loaded by the panel
    # the first time a user picks a comparison season. Every season since
    # 1982 in one payload is a few hundred KB — worth it on demand, not
    # worth it on every Seasonal-tab open.
    storms_payload = {
        "generated_utc": payload["generated_utc"],
        "history_start": HISTORY_START,
        "days": DAYS,
        "columns": ["name", "ace", "peak_kt", "first_day", "last_day",
                    "points"],
        "vmax_threshold_kt": ACE_VMAX_THRESH,
        "wind_source": payload["wind_source"],
        "basins": {b: {str(s): rows for s, rows in sorted(per.items())}
                   for b, per in per_storm.items()},
    }
    storms_path = out_path.with_name("ace_pace_storms.json")
    storms_path.write_text(json.dumps(storms_payload, separators=(",", ":")))
    n_rows = sum(len(rows) for per in per_storm.values()
                 for rows in per.values())
    log.info("wrote %s (%.1f KB, %d storm-season rows)", storms_path,
             storms_path.stat().st_size / 1024.0, n_rows)
    return out_path


def upload(path: Path) -> None:
    from google.cloud import storage
    blob = storage.Client().bucket(GCS_BUCKET).blob(
        f"{GCS_PREFIX}/{path.name}")
    blob.upload_from_filename(str(path), content_type="application/json",
                              predefined_acl="publicRead")
    log.info("uploaded gs://%s/%s/%s", GCS_BUCKET, GCS_PREFIX, path.name)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ibtracs", default=IBTRACS_ALL_LOCAL,
                    help="Path to IBTrACS.ALL NetCDF")
    ap.add_argument("--out", default="data/seasonal/ace_pace_climo.json")
    ap.add_argument("--local-only", action="store_true",
                    help="Skip the GCS upload")
    ap.add_argument("--refresh-ibtracs", action="store_true",
                    help="Re-download IBTrACS.ALL from NCEI first")
    args = ap.parse_args()

    path = args.ibtracs
    if args.refresh_ibtracs or not Path(path).exists():
        path = refresh_ibtracs(path)
    out = build(path, Path(args.out))
    if not args.local_only:
        upload(out)
        upload(out.with_name("ace_pace_storms.json"))


if __name__ == "__main__":
    main()
