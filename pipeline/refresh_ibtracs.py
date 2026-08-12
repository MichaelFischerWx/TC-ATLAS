"""Refresh TC-ATLAS's IBTrACS-derived JSON files from the latest v04r01.

Downloads `IBTrACS.ALL.v04r01.nc` from NCEI, parses it, and emits five
files in the repo root that the frontend reads at boot:

    ibtracs_tracks_manifest.json   { chunks: [...], total_tracks: N }
    ibtracs_tracks_0.json          { sid: [{t, la, lo, w, p, n}, ...], ... }  ~22 MB
    ibtracs_tracks_1.json          (size-balanced split — older storms in 0,
                                    newer + larger tracks in 1)
    ibtracs_tracks.json            single-file fallback (concat of both chunks)
    ibtracs_storms.json            per-storm metadata + global summary
    intensity_changes.json         { basins: { NA: [[Δw_kt, year], ...] } }

plus the wind-radii sidecar tree (lazy-loaded by the storm detail view,
never at boot — see global_archive.js loadWindRadii):

    ibtracs_radii/manifest.json    { years: [...], climo: {basin: {...}} }
    ibtracs_radii/radii_YYYY.json  { sid: { rows: [[t, r34[4], r50[4],
                                            r64[4], rmw, poci, roci], ...],
                                            s34: <MultiPolygon coords>|null,
                                            s64: ... }, ... }
                                   quadrant order NE/SE/SW/NW, nm; keyed by
                                   SEASON year (matches storm.year in
                                   ibtracs_storms.json, not the SID prefix).
                                   s34/s64 are precomputed lifetime swath
                                   unions (shapely at build time — the
                                   frontend has no polygon-clipping dep)
                                   in an unwrapped-longitude frame (values
                                   may exceed ±180 for dateline crossers).

Schema is fixed by what global_archive.js + track_overlay.js expect — la/lo
NOT lat/lon, t as ISO string ("YYYY-MM-DDTHH:MM"), w in knots, p in hPa.

Usage:
    python pipeline/refresh_ibtracs.py
    python pipeline/refresh_ibtracs.py --keep-cache  # don't re-download .nc
    python pipeline/refresh_ibtracs.py --since YEAR  # only emit storms ≥ YEAR
                                                       (smoke-test for changes)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional

import numpy as np

LOG = logging.getLogger("tc-atlas.refresh_ibtracs")

ROOT = Path(__file__).resolve().parent.parent
NC_URL = "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/netcdf/IBTrACS.ALL.v04r01.nc"
NC_CACHE = ROOT / "data" / "_ibtracs_cache" / "IBTrACS.ALL.v04r01.nc"

# Saffir-Simpson + tropical-cyclone subcategory thresholds (kt). Mirrors
# the JS-side intensityCat in correlation.js + climatology_globe.js.
def cat_for_wind(w_kt: Optional[float]) -> str:
    if w_kt is None or not np.isfinite(w_kt):
        return "UN"
    if w_kt < 34:  return "TD"
    if w_kt < 64:  return "TS"
    if w_kt < 83:  return "C1"
    if w_kt < 96:  return "C2"
    if w_kt < 113: return "C3"
    if w_kt < 137: return "C4"
    return "C5"


def _decode_str(v):
    """IBTrACS NetCDF strings are masked byte arrays. Strip + decode."""
    if v is None:
        return ""
    if isinstance(v, bytes):
        return v.decode("ascii", errors="replace").strip()
    if isinstance(v, np.ndarray):
        if v.dtype.kind == "S":
            return b"".join(v.tobytes().split(b"\x00")).decode("ascii", errors="replace").strip()
        # Object array of bytes
        return "".join(c.decode("ascii", errors="replace") if isinstance(c, bytes) else str(c)
                       for c in v.tolist()).strip().rstrip("\x00")
    return str(v).strip()


def _finite_or_none(v):
    """np scalar (possibly masked NaN) → Python float or None."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(f):
        return None
    return f


def _ts_iso(b):
    """IBTrACS iso_time entries are b'2024-09-15 12:00:00' style.
    Frontend expects 'YYYY-MM-DDTHH:MM' (no seconds / no Z — naive UTC,
    parseUTC in track_overlay.js appends Z explicitly).
    Returns None on missing / unparseable."""
    s = _decode_str(b)
    if not s or s == "":
        return None
    # Truncate seconds; convert space → T.
    if " " in s:
        date, ttime = s.split(" ", 1)
    else:
        date, ttime = s, "00:00:00"
    hh_mm = ttime[:5]
    return f"{date}T{hh_mm}"


def download_ibtracs(force: bool) -> Path:
    NC_CACHE.parent.mkdir(parents=True, exist_ok=True)
    if NC_CACHE.exists() and not force:
        age_h = (time.time() - NC_CACHE.stat().st_mtime) / 3600
        LOG.info(f"using cached netCDF (age {age_h:.1f}h) — pass --no-cache to re-download")
        return NC_CACHE
    LOG.info(f"downloading {NC_URL}  →  {NC_CACHE}")
    import requests
    t0 = time.time()
    with requests.get(NC_URL, stream=True, timeout=600) as r:
        r.raise_for_status()
        with open(NC_CACHE, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
    sz = NC_CACHE.stat().st_size / 1e6
    LOG.info(f"downloaded {sz:.0f} MB in {time.time() - t0:.0f}s")
    return NC_CACHE


def parse(nc_path: Path, since: Optional[int]) -> tuple[dict, list, dict]:
    """Returns (tracks_by_sid, storms_metadata_list, radii_by_sid).
    tracks_by_sid: { sid: [{t, la, lo, w?, p?, n}, ...] } — finite la/lo only
    storms_metadata_list: [{sid, name, year, basin, ...}, ...]
    radii_by_sid: { sid: [[t, r34[4], r50[4], r64[4], rmw, poci, roci], ...] }
                  — only fixes where at least one structure field is finite;
                  quadrant order NE/SE/SW/NW (IBTrACS quadrant dim), nm
    """
    import xarray as xr
    LOG.info(f"opening {nc_path.name}")
    ds = xr.open_dataset(nc_path, decode_times=False)

    # Vectorize the static per-storm fields.
    sids   = ds["sid"].values
    names  = ds["name"].values
    seasons = ds["season"].values         # int year (SH season convention applied by IBTrACS)
    basins = ds["basin"].values            # 2-D: storm × time, varies; use first valid as canonical
    nature = ds["nature"].values           # 2-D
    times  = ds["iso_time"].values         # 2-D
    lats   = ds["lat"].values              # 2-D float
    lons   = ds["lon"].values              # 2-D float
    track_type = ds["track_type"].values

    # Wind: prefer USA (operational best estimate), fall back to WMO.
    usa_w = ds["usa_wind"].values if "usa_wind" in ds else None
    wmo_w = ds["wmo_wind"].values if "wmo_wind" in ds else None
    usa_p = ds["usa_pres"].values if "usa_pres" in ds else None
    wmo_p = ds["wmo_pres"].values if "wmo_pres" in ds else None
    atcf  = ds["usa_atcf_id"].values if "usa_atcf_id" in ds else None
    hursat = ds["hursat_b1"].values if "hursat_b1" in ds else None

    # Wind-radii / structure fields (USA agency = NHC + JTWC, which covers
    # every basin; routinely analyzed ~2004 on, sparse 2001-2003).
    # Shape: storm × time × quadrant (NE/SE/SW/NW) for r34/r50/r64.
    r34_v = ds["usa_r34"].values if "usa_r34" in ds else None
    r50_v = ds["usa_r50"].values if "usa_r50" in ds else None
    r64_v = ds["usa_r64"].values if "usa_r64" in ds else None
    rmw_v = ds["usa_rmw"].values if "usa_rmw" in ds else None
    poci_v = ds["usa_poci"].values if "usa_poci" in ds else None
    roci_v = ds["usa_roci"].values if "usa_roci" in ds else None

    nstorms = lats.shape[0]
    LOG.info(f"parsing {nstorms} storms")

    tracks: dict[str, list] = {}
    storms: list[dict] = []
    radii: dict[str, list] = {}

    def _quad(arr, i, j):
        """usa_rXX[i, j, :] → [ne, se, sw, nw] ints, or None if all missing.
        Zero is meaningful (no such wind in that quadrant) and kept."""
        if arr is None:
            return None
        q = arr[i, j]
        if not np.isfinite(q).any():
            return None
        return [int(round(float(v))) if np.isfinite(v) else None for v in q]

    # ACE constant: 1e-4 × Σ v²(kt²) at synoptic 6-hourly fixes ≥ 34 kt
    # WHILE the storm has a tropical or subtropical designation. IBTrACS
    # `nature` codes used here:
    #   TS  tropical storm        TY  typhoon          TC  generic TC
    #   HU  hurricane             ST  subtropical      SS  subtropical storm
    #   SD  subtropical depression       TD  tropical depression
    # Explicitly EXCLUDED (per NHC / Bell+2000 ACE convention):
    #   ET  extratropical (post-transition)
    #   PT  post-tropical (a synonym for ET in some agencies)
    #   DB  disturbance (pre-genesis)         WV  tropical wave
    #   LO  low / non-tropical        IN  inland post-landfall remnant
    #   DS  disturbance / monsoon depression (pre-genesis)
    #   MX  mixed / uncertain         NR  not reported (mostly pre-1950)
    # TD is included because some agencies record sub-34kt synoptic fixes
    # before / after a storm's TS phase under a TD designation; ACE's
    # ≥34 kt filter already excludes those by intensity anyway.
    SYNOPTIC_HOURS = (0, 6, 12, 18)
    TC_NATURES = {"TS", "TY", "TC", "HU", "ST", "SS", "SD", "TD"}

    for i in range(nstorms):
        sid = _decode_str(sids[i])
        if not sid:
            continue
        year = int(seasons[i]) if np.isfinite(seasons[i]) else None
        if since is not None and (year is None or year < since):
            continue

        # First-valid basin (ignore '' / 'MM' missing).
        basin_code = ""
        for b in basins[i]:
            s = _decode_str(b)
            if s and s not in ("MM", ""):
                basin_code = s
                break
        # Storms whose basin we can't determine get bucketed under their first
        # genesis hemisphere code (rare — typically test/spurious entries).
        if basin_code == "":
            basin_code = "NA"  # fallback so downstream basin counts don't NaN

        # Track points: every fix where lat & lon are finite.
        pts: list[dict] = []
        rad_rows: list[list] = []
        atcf_id = None
        peak_w = None
        min_p = None
        ace = 0.0
        is_hursat = False
        # For RI / RW windows.
        wind_series = []
        for j in range(lats.shape[1]):
            la = lats[i, j]
            lo = lons[i, j]
            if not (np.isfinite(la) and np.isfinite(lo)):
                continue
            t = _ts_iso(times[i, j])
            if t is None:
                continue
            # Pick wind/pres preferring USA over WMO.
            w = None
            if usa_w is not None and np.isfinite(usa_w[i, j]): w = float(usa_w[i, j])
            elif wmo_w is not None and np.isfinite(wmo_w[i, j]): w = float(wmo_w[i, j])
            p = None
            if usa_p is not None and np.isfinite(usa_p[i, j]): p = float(usa_p[i, j])
            elif wmo_p is not None and np.isfinite(wmo_p[i, j]): p = float(wmo_p[i, j])
            n = _decode_str(nature[i, j]) or "NR"

            pt = {"t": t, "la": round(float(la), 2), "lo": round(float(lo), 2), "n": n}
            if w is not None: pt["w"] = round(w, 1)
            if p is not None: pt["p"] = round(p, 1)
            pts.append(pt)

            # Wind-radii sidecar row: [t, r34, r50, r64, rmw, poci, roci]
            # with trailing Nones trimmed (client destructures; missing
            # trailing slots read as undefined).
            q34 = _quad(r34_v, i, j)
            q50 = _quad(r50_v, i, j)
            q64 = _quad(r64_v, i, j)
            rmw = _finite_or_none(rmw_v[i, j]) if rmw_v is not None else None
            po  = _finite_or_none(poci_v[i, j]) if poci_v is not None else None
            ro  = _finite_or_none(roci_v[i, j]) if roci_v is not None else None
            if any(v is not None for v in (q34, q50, q64, rmw, po, ro)):
                row = [t, q34, q50, q64,
                       int(round(rmw)) if rmw is not None else None,
                       int(round(po)) if po is not None else None,
                       int(round(ro)) if ro is not None else None]
                while row[-1] is None:
                    row.pop()
                rad_rows.append(row)

            if w is not None:
                if peak_w is None or w > peak_w: peak_w = w
                # ACE: synoptic 6-hourly + ≥ 34 kt + TC/subtropical nature.
                # The nature filter is what excludes post-tropical /
                # extratropical fixes (which can hit 34+ kt over the open
                # ocean during a transition but aren't part of "tropical
                # cyclone activity" by the NHC definition).
                hh = int(t[11:13])
                if hh in SYNOPTIC_HOURS and w >= 34 and n in TC_NATURES:
                    ace += w * w
                wind_series.append((t, w))
            if p is not None and (min_p is None or p < min_p):
                min_p = p
            if atcf is None:
                pass
            else:
                a = _decode_str(atcf[i, j])
                if a and atcf_id is None: atcf_id = a
            if hursat is not None and not is_hursat:
                hb = hursat[i, j]
                if isinstance(hb, (bytes, np.bytes_)) and hb.strip():
                    is_hursat = True

        if len(pts) == 0:
            continue

        # 24-h max ±Δw over all (t_a, t_b) pairs separated by ~24 hours.
        ri = None
        rw = None
        if len(wind_series) > 1:
            from datetime import datetime
            parsed = [(datetime.fromisoformat(t), w) for t, w in wind_series]
            for a in range(len(parsed)):
                for b in range(a + 1, len(parsed)):
                    dt_h = (parsed[b][0] - parsed[a][0]).total_seconds() / 3600
                    if dt_h > 28: break  # pairs sorted by time; stop scanning
                    if 20 <= dt_h <= 28:
                        d = parsed[b][1] - parsed[a][1]
                        if ri is None or d > ri: ri = d
                        if rw is None or d < rw: rw = d

        # Find LMI (lifetime max intensity) lat/lon.
        lmi_lat, lmi_lon = pts[0]["la"], pts[0]["lo"]
        if peak_w is not None:
            for pt in pts:
                if pt.get("w") == peak_w:
                    lmi_lat, lmi_lon = pt["la"], pt["lo"]
                    break

        # Genesis = first track point.
        gen_lat = pts[0]["la"]
        gen_lon = pts[0]["lo"]
        start_date = pts[0]["t"][:10]
        end_date   = pts[-1]["t"][:10]

        ace_scaled = round(ace * 1e-4, 4)

        meta = {
            "sid": sid,
            "name": _decode_str(names[i]) or "UNNAMED",
            "year": year,
            "basin": basin_code,
            "peak_wind_kt": peak_w,
            "min_pres_hpa": min_p,
            "genesis_lat": gen_lat,
            "genesis_lon": gen_lon,
            "lmi_lat": lmi_lat,
            "lmi_lon": lmi_lon,
            "start_date": start_date,
            "end_date": end_date,
            "num_points": len(pts),
            "ace": ace_scaled,
            "hursat": is_hursat,
            "cat": cat_for_wind(peak_w),
            "ri_24h": round(ri, 1) if ri is not None else None,
            "rw_24h": round(rw, 1) if rw is not None else None,
        }
        if atcf_id:
            meta["atcf_id"] = atcf_id
        # Only ship the sidecar (and flag the storm) when there is at least
        # one actual wind-radii quadrant set — RMW/POCI/ROCI-only storms
        # (sparse pre-2001 reanalysis fixes) can't draw a wind field and
        # would emit hundreds of near-empty season files.
        has_quad = any(len(r) > 1 and (r[1] or r[2] or r[3]) for r in rad_rows)
        if has_quad:
            meta["radii"] = True
            radii[sid] = rad_rows

        tracks[sid] = pts
        storms.append(meta)

    LOG.info(f"parsed {len(tracks)} storms with valid tracks, "
             f"{len(radii)} with wind radii")
    return tracks, storms, radii


def chunk_tracks(tracks: dict) -> tuple[dict, dict]:
    """Size-balanced split: serialize each storm's track JSON to estimate
    bytes, then walk SIDs in sorted order and pick the cutoff where
    cumulative bytes cross half the total. Matches the existing chunking
    pattern (older storms cluster in chunk 0, modern storms in chunk 1)."""
    sids = sorted(tracks.keys())
    sizes = [len(json.dumps(tracks[s], separators=(",", ":"))) for s in sids]
    total = sum(sizes)
    cutoff = total // 2
    cum = 0
    split_idx = 0
    for k, sz in enumerate(sizes):
        cum += sz
        if cum >= cutoff:
            split_idx = k + 1
            break
    chunk0 = {s: tracks[s] for s in sids[:split_idx]}
    chunk1 = {s: tracks[s] for s in sids[split_idx:]}
    return chunk0, chunk1


def compute_intensity_changes(tracks: dict, storms_by_sid: dict) -> dict:
    """All overwater 24-h intensity changes, grouped by basin. Each event
    is [Δw_kt, year]. Frontend uses the empirical distribution for the
    Climatology tab's RI / RW histograms."""
    from datetime import datetime
    basins: dict[str, list] = {}
    SYNOPTIC = (0, 6, 12, 18)
    # Same TC/subtropical filter as ACE (in parse() above) — only count
    # 24-h Δw episodes during the storm's tropical / subtropical phase.
    # Excludes extratropical transition (ET/PT), pre-genesis disturbance
    # (DB/DS/WV), and post-landfall remnant (IN/LO).
    NATURE_TC = {"TS", "TY", "TC", "HU", "ST", "SS", "SD", "TD"}
    year_min = year_max = None
    for sid, pts in tracks.items():
        meta = storms_by_sid.get(sid)
        if not meta or meta["year"] is None: continue
        basin = meta["basin"]
        if basin not in basins: basins[basin] = []
        # Only use synoptic + TC-nature fixes with finite wind.
        synoptic = []
        for pt in pts:
            t = pt.get("t")
            if not t or "w" not in pt: continue
            hh = int(t[11:13])
            if hh not in SYNOPTIC: continue
            n = pt.get("n", "")
            if n not in NATURE_TC: continue
            try:
                d = datetime.fromisoformat(t)
            except ValueError:
                continue
            synoptic.append((d, pt["w"]))
        if len(synoptic) < 5: continue
        # 24-h pairs.
        for a in range(len(synoptic)):
            for b in range(a + 1, len(synoptic)):
                dh = (synoptic[b][0] - synoptic[a][0]).total_seconds() / 3600
                if dh > 28: break
                if 20 <= dh <= 28:
                    delta = int(round(synoptic[b][1] - synoptic[a][1]))
                    yr = meta["year"]
                    basins[basin].append([delta, yr])
                    if year_min is None or yr < year_min: year_min = yr
                    if year_max is None or yr > year_max: year_max = yr
    total = sum(len(v) for v in basins.values())
    return {
        "description": "All overwater 24-h intensity change episodes [change_kt, year] (synoptic, TC phases only)",
        "total_episodes": total,
        "year_min": year_min,
        "year_max": year_max,
        "basins": basins,
    }


def compute_radii_climo(tracks: dict, radii: dict, storms_by_sid: dict) -> dict:
    """Per-basin histograms of per-fix structure metrics, 2004+ (the era
    when radii are routinely analyzed — matches the climo window on Dan
    Chavas' extremewx viewer, whose percentile-bar design this feeds).

    Metrics (all per fix, joined to the track by timestamp for Vmax):
      r34: nonzero-quadrant mean R34 (nm), fixes with Vmax ≥ 34 kt
      r64: nonzero-quadrant mean R64 (nm), fixes with Vmax ≥ 64 kt
      rmw: RMW (nm), fixes with Vmax ≥ 34 kt

    Histogram spec: {"lo": min, "step": w, "counts": [...]} — overflow
    clipped into the last bin; percentile = cumsum client-side."""
    SPECS = {"r34": (0, 10, 40), "r64": (0, 5, 30), "rmw": (0, 5, 40)}
    out: dict[str, dict] = {}

    def _bump(basin, key, val):
        lo, step, nbins = SPECS[key]
        b = out.setdefault(basin, {})
        h = b.setdefault(key, {"lo": lo, "step": step, "counts": [0] * nbins, "n": 0})
        idx = min(int((val - lo) / step), nbins - 1)
        if idx < 0: idx = 0
        h["counts"][idx] += 1
        h["n"] += 1

    def _nzmean(quads):
        vals = [v for v in (quads or []) if v is not None and v > 0]
        return sum(vals) / len(vals) if vals else None

    for sid, rows in radii.items():
        meta = storms_by_sid.get(sid)
        if not meta or (meta.get("year") or 0) < 2004:
            continue
        basin = meta["basin"]
        w_by_t = {pt["t"]: pt.get("w") for pt in tracks.get(sid, [])}
        for row in rows:
            t = row[0]
            w = w_by_t.get(t)
            if w is None:
                continue
            r34 = _nzmean(row[1] if len(row) > 1 else None)
            r64 = _nzmean(row[3] if len(row) > 3 else None)
            rmw = row[4] if len(row) > 4 else None
            if w >= 34 and r34 is not None: _bump(basin, "r34", r34)
            if w >= 64 and r64 is not None: _bump(basin, "r64", r64)
            if w >= 34 and rmw is not None: _bump(basin, "rmw", rmw)
    return out


def _wedge_polygon(lat: float, lon: float, quads: list) -> Optional[list]:
    """Quadrant wind-radii wedge as a shapely-ready ring. Quarter-circle
    arcs (bearings NE=0-90, SE=90-180, SW=180-270, NW=270-360) with radial
    steps at quadrant boundaries — the honest NHC-style rendering; no
    smoothing across quadrants. Missing quadrants count as 0 (collapse to
    center). Returns None when all four are 0/missing."""
    import math
    rr = [(q if q else 0) for q in (quads or [0, 0, 0, 0])]
    if not any(rr):
        return None
    coslat = max(0.05, math.cos(math.radians(lat)))
    ring = []
    for q in range(4):
        r_deg = rr[q] / 60.0  # nm → great-circle degrees
        for b in range(q * 90, (q + 1) * 90 + 1, 10):
            th = math.radians(b)
            ring.append((lon + r_deg * math.sin(th) / coslat,
                         lat + r_deg * math.cos(th)))
    ring.append(ring[0])
    return ring


def compute_swaths(radii: dict, tracks: dict) -> dict:
    """Per-storm lifetime swath union of the R34 and R64 wedges.
    Longitudes are unwrapped along the track (continuous across the
    dateline) so the union doesn't smear across the map; the frontend
    renders >±180 fine (world copies). Returns
    { sid: {"s34": coords|None, "s64": coords|None} } with MultiPolygon-
    style coords rounded to 2 dp."""
    from shapely.geometry import Polygon, MultiPolygon
    from shapely.ops import unary_union

    def _round_coords(geom):
        polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
        out = []
        for p in polys:
            rings = [[[round(x, 2), round(y, 2)] for x, y in p.exterior.coords]]
            for hole in p.interiors:
                rings.append([[round(x, 2), round(y, 2)] for x, y in hole.coords])
            out.append(rings)
        return out

    swaths: dict[str, dict] = {}
    for sid, rows in radii.items():
        pos_by_t = {}
        prev_lo = None
        offset = 0.0
        for pt in tracks.get(sid, []):
            lo = pt["lo"]
            if prev_lo is not None:
                if lo - prev_lo > 180: offset -= 360
                elif lo - prev_lo < -180: offset += 360
            prev_lo = lo
            pos_by_t[pt["t"]] = (pt["la"], lo + offset)

        entry = {}
        for key, idx in (("s34", 1), ("s64", 3)):
            wedges = []
            for row in rows:
                pos = pos_by_t.get(row[0])
                quads = row[idx] if len(row) > idx else None
                if pos is None or not quads:
                    continue
                ring = _wedge_polygon(pos[0], pos[1], quads)
                if ring is None:
                    continue
                poly = Polygon(ring)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if not poly.is_empty:
                    wedges.append(poly)
            if not wedges:
                entry[key] = None
                continue
            union = unary_union(wedges).simplify(0.03, preserve_topology=True)
            entry[key] = _round_coords(union)
        swaths[sid] = entry
    return swaths


def write_radii_outputs(radii: dict, tracks: dict, storms_by_sid: dict,
                        root: Path) -> None:
    """Emit ibtracs_radii/radii_YYYY.json (keyed by SEASON year so the
    frontend can derive the filename from storm.year) + manifest with the
    per-basin climo histograms."""
    out_dir = root / "ibtracs_radii"
    out_dir.mkdir(parents=True, exist_ok=True)

    LOG.info("computing lifetime swath unions (shapely)")
    swaths = compute_swaths(radii, tracks)

    by_year: dict[int, dict] = {}
    for sid, rows in radii.items():
        meta = storms_by_sid.get(sid)
        if not meta or meta.get("year") is None:
            continue
        sw = swaths.get(sid) or {}
        by_year.setdefault(meta["year"], {})[sid] = {
            "rows": rows,
            "s34": sw.get("s34"),
            "s64": sw.get("s64"),
        }

    total_bytes = 0
    for year in sorted(by_year):
        path = out_dir / f"radii_{year}.json"
        tmp = path.with_suffix(".json.tmp")
        with tmp.open("w") as f:
            json.dump(by_year[year], f, separators=(",", ":"))
        tmp.replace(path)
        total_bytes += path.stat().st_size

    climo = compute_radii_climo(tracks, radii, storms_by_sid)
    manifest = {
        "years": sorted(by_year),
        "quadrant_order": ["NE", "SE", "SW", "NW"],
        "row_schema": ["t", "r34_nm", "r50_nm", "r64_nm", "rmw_nm",
                       "poci_mb", "roci_nm"],
        "climo_window": "2004+",
        "climo": climo,
    }
    tmp = (out_dir / "manifest.json").with_suffix(".json.tmp")
    with tmp.open("w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    tmp.replace(out_dir / "manifest.json")
    LOG.info(f"wrote ibtracs_radii/: {len(by_year)} season files, "
             f"{total_bytes / 1e6:.1f} MB total + manifest")


def write_outputs(tracks: dict, storms: list, chunk0: dict, chunk1: dict,
                  intensity_changes: dict, root: Path) -> None:
    """Write all five JSON files atomically (write to .tmp then rename)."""
    def atomic_write(path: Path, payload):
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w") as f:
            json.dump(payload, f, separators=(",", ":"))
        tmp.replace(path)
        LOG.info(f"wrote {path.name}  ({tmp.stat().st_size / 1e6:.1f} MB)" if False else f"wrote {path.name}  ({path.stat().st_size / 1e6:.1f} MB)")

    # Manifest (chunks list + total).
    atomic_write(root / "ibtracs_tracks_manifest.json",
                 {"chunks": ["ibtracs_tracks_0.json", "ibtracs_tracks_1.json"],
                  "total_tracks": len(tracks)})

    # Chunks + single-file fallback.
    atomic_write(root / "ibtracs_tracks_0.json", chunk0)
    atomic_write(root / "ibtracs_tracks_1.json", chunk1)
    atomic_write(root / "ibtracs_tracks.json", tracks)

    # Storms metadata + global summary.
    basin_counts: dict[str, int] = {}
    hursat_count = 0
    year_lo = year_hi = None
    for s in storms:
        b = s["basin"]
        basin_counts[b] = basin_counts.get(b, 0) + 1
        if s["hursat"]: hursat_count += 1
        if s["year"] is not None:
            if year_lo is None or s["year"] < year_lo: year_lo = s["year"]
            if year_hi is None or s["year"] > year_hi: year_hi = s["year"]
    atomic_write(root / "ibtracs_storms.json", {
        "metadata": {
            "version": "1.0",
            "ibtracs_version": "v04r01",
            "total_storms": len(storms),
            "hursat_storms": hursat_count,
            "year_range": [year_lo, year_hi],
            "basin_counts": basin_counts,
            "intensity_change_computed": True,
        },
        "storms": storms,
    })

    # Intensity-change episodes.
    atomic_write(root / "intensity_changes.json", intensity_changes)


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-cache", action="store_true", help="re-download even if cached")
    ap.add_argument("--keep-cache", action="store_true", help="reuse cached netCDF (default)")
    ap.add_argument("--since", type=int, help="only emit storms with year >= SINCE (smoke test)")
    return ap.parse_args()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args()
    nc = download_ibtracs(force=args.no_cache and not args.keep_cache)
    tracks, storms, radii = parse(nc, args.since)
    if not tracks:
        LOG.error("no storms parsed — aborting")
        return 1
    chunk0, chunk1 = chunk_tracks(tracks)
    LOG.info(f"chunked: {len(chunk0)} / {len(chunk1)} storms")
    storms_by_sid = {s["sid"]: s for s in storms}
    ic = compute_intensity_changes(tracks, storms_by_sid)
    LOG.info(f"intensity_changes: {ic['total_episodes']} episodes, "
             f"years {ic['year_min']}-{ic['year_max']}")
    # Smoke-test mode (--since): write to a sandbox dir so the production
    # files at the repo root don't get clobbered with a partial subset.
    # Diff from there before promoting to a full re-run.
    if args.since is not None:
        out = ROOT / "data" / "_ibtracs_smoketest"
        out.mkdir(parents=True, exist_ok=True)
        LOG.info(f"--since {args.since} → sandbox output (NOT clobbering production files)")
        LOG.info(f"  {out.relative_to(ROOT)}/")
    else:
        out = ROOT
    write_outputs(tracks, storms, chunk0, chunk1, ic, out)
    write_radii_outputs(radii, tracks, storms_by_sid, out)
    LOG.info("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
