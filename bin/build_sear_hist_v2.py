#!/usr/bin/env python3
"""Publish MLBT's historical SEAR record per FLIGHT for the Global Archive SEAR tab (schema v2).

v1 (bin/build_sear_hist.py, read by the Storm Detail recon section) carries one file per storm with SEAR's 10-m
values only at the scored observations. The SEAR tab needs the flight itself: the flight-level wind and height
along the whole track, SEAR's two steps, and which flight a pass belongs to. v2 adds that WITHOUT changing v1:
a new prefix, a storm file with the flight list and the pass maxima, and one file per flight.

Sources (read only; MLBT has uncommitted work in progress -- never write there):
  MLBT phase1/out/sear/          Atlantic HDOB (30-s; 2007-2025)
  MLBT phase1/out/sear_ep/       E/C Pacific HDOB
  MLBT phase1/out/sear_hrd_all/  HRD flight-level files 1998-2007 (NOAA 1-s, USAF 10-s); 10-m recomputed under
                                 ruling 53, 1-s rows thinned to the strongest estimate per aircraft per 10 s
  MLBT phase1/out/sear_hrd_pre/  HRD files before the record (1960s-1997): extrapolated era (ruling 54)
  MLBT phase1/out/sear/sear_fix.parquet  fix-operator passes (VDM max 10-s FL wind / F-deck)
All are written by phase1/sear_operator.py (+ sear_hrd_operator / sear_fix_operator) with the record's chain,
Stage 1 v4 / Stage 2 v8. The real-time job runs a different chain (Stage 1 v6.1 / Stage 2 v11, ruling 57):
never label this record as v6.1.

Pass maxima are built exactly as v1 builds them (HDOB legs win, HRD legs only for storms without HDOB legs,
fix passes dropped where a leg flight covers them), so a storm's maximum here equals v1's for the same sources.

Output (plain JSON in OUT; --upload gzips each object to R2 under sear-hist/v2/):
  index.json        {schema:2, model, chain, generated, sources:{name:{path, mtime}},
                     storms:{ATCF:{name, year, sid, basin, era, max_kt, max_src, max_at, n_flights, n_passes, fl_max_kt, fl_max_src, t0}}}
                    max_at = {t, lat, lon[, pos]} of the storm's maximum; a fix-operator pass has no aircraft longitude,
                    so it takes the best-track center at that time (pos:"bt")
  <ATCF>.json       {atcf, name, year, sid, basin, era, model, max_kt, max_src, max_at, obs_max_kt, pass_max_kt, fl_max_kt,
                     flights:[{key, mission, tail, src, kind, t0, t1, n, n_scored, fl_max_kt, y_max_kt,
                               pass_max_kt, n_passes, z_med_m}],
                     passes:[{t, src, mission, tail, f, lat, lon, r, az, y_kt, y_corr_kt, y_30s_kt, fl_peak_kt,
                              rmw_km, r_over_rmw, height_km}]}           # f = index into flights, or null
  <ATCF>/<key>.json {atcf, key, mission, tail, src, kind,
                     obs:{t:[epoch s], lat, lon, fl:[kt], z:[m], p:[hPa], y5:[kt], y:[kt], y30:[kt],
                          r:[km], az:[deg], rr:[r/RMW], sf:[kt]}}         # null where missing / not scored
  fl  = the flight-level wind SEAR scales (HDOB: the reported peak 10-s wind; HRD: the file's wind), unfiltered
  fl_max_kt (flights, storms) = the maximum within 250 km of the center with the aircraft at 0.3-5 km; a storm's
        also takes its passes' peaks, fl_max_src "vdm" when a vortex message's max flight-level wind sets it
  y5  = SEAR's 500-m step (Stage 1, 10-s-peak scale); y = 10-m, 10-s-peak scale, RMW-corrected (the headline,
        = v1 y); y30 = 10-m, 30-s scale; sf = SFMR as reported in the HDOB (shape / sanity reference only)

Usage:
  python3 bin/build_sear_hist_v2.py [--atcf AL092022 ...]          # build into OUT, no network
  python3 bin/build_sear_hist_v2.py --upload [--atcf ...]          # build, then gzip + upload to R2 (ask first)
  python3 bin/build_sear_hist_v2.py --upload-only                  # upload what OUT already holds
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

MLBT = Path.home() / "github" / "MLBT"
REPO = Path(__file__).resolve().parent.parent
# (name, dir, recompute_10m, thin_s, hrd) -- the same four sources and flags as build_sear_hist.py
SRC = [("hdob_al", MLBT / "phase1" / "out" / "sear", False, 0, False),
       ("hdob_ep", MLBT / "phase1" / "out" / "sear_ep", False, 0, False),
       ("hrd", MLBT / "phase1" / "out" / "sear_hrd_all", True, 10, True),
       ("hrd_pre", MLBT / "phase1" / "out" / "sear_hrd_pre", False, 0, True)]
FIX = MLBT / "phase1" / "out" / "sear" / "sear_fix.parquet"
OUT = Path.home() / "Data" / "sear_hist_v2"
PREFIX = "sear-hist/v2"
KT = 1.943844
MODEL = "SEAR Stage 1 v4 (local RMW, w_rel) / Stage 2 v8, trained through 2024 -- MLBT historical record"
CHAIN = {"stage1": "v4", "stage2": "v8", "note": "historical record; the real-time job runs Stage 1 v6.1 / Stage 2 v11"}
GAP_S = 3 * 3600          # a (mission, tail) record splits into flights at gaps longer than this
# Flight-level MAXIMA (not the arrays) count only the storm's core: within CORE_R_KM of the center with the
# aircraft between CORE_Z_M. Outside it the record carries G-IV jet-stream winds (Ingrid 2013: 176 kt at 13 km,
# 1,190 km out) and bad stretches in old USAF 10-s files (Mitch 1998: a ramp to 222 kt at 7.4 km, 360 km out).
CORE_R_KM = 250
CORE_Z_M = (300, 5000)
COLS = ["atcf", "mission_id", "tail", "observation_time_utc", "aircraft_latitude", "aircraft_longitude",
        "aircraft_height_km", "fl_pres_mb", "radius_km", "azimuth_deg", "r_over_rmw", "wind_ms",
        "flight_level_peak_kt", "sfmr_kt", "stage1_peak_500m_ms",
        "pred_10m_peak_rmwcorr_ms", "pred_10m_peak_ms", "pred_10m_rmwcorr_ms", "pred_10m_ms",
        "stage2_pred_wl150_ms", "wl150_peak_ms", "tdr_resolution_factor"]


def r2_client():
    def secret(n):
        return subprocess.run(["/opt/homebrew/bin/gcloud", "secrets", "versions", "access", "latest", f"--secret={n}",
                               "--project=tc-atlas-web"], capture_output=True, text=True, check=True).stdout.strip()
    import boto3
    return boto3.client("s3", endpoint_url="https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com",
                        aws_access_key_id=secret("r2-access-key-id"), aws_secret_access_key=secret("r2-secret-access-key"),
                        region_name="auto")


def fnum(v, nd=1):
    if v is None:
        return None
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return round(v, nd) if np.isfinite(v) else None


def arr(x, nd):
    """Rounded list with None for non-finite; nd=0 gives ints."""
    a = np.asarray(x, dtype=float)
    ok = np.isfinite(a)
    if nd == 0:
        r = np.where(ok, np.round(a), 0).astype(np.int64).tolist()
    else:
        r = np.round(np.where(ok, a, 0.0), nd).tolist()
    return [v if k else None for v, k in zip(r, ok.tolist())]


def iso(t):
    return pd.Timestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ")


def flight_kind(src, tail):
    if src.startswith("hdob"):
        return "HDOB 30-s (the reported peak 10-s wind)"
    if src == "hrd_pre":
        return "HRD flight-level file, 10-s means"
    if str(tail).endswith("-1s"):
        return "HRD 1-s file, strongest estimate per 10 s"
    return "HRD flight-level file, 10-s"


def load_sources(atcfs):
    sys.path.insert(0, str(MLBT / "external" / "SEAR" / "Scripts"))
    from reduction import wl150_to_10m_factor
    rows, legs, hdob_atcf, meta = [], [], set(), {}
    for name, src, recompute, thin_s, hrd in SRC:
        p = src / "sear_samples.parquet"
        if not p.exists():
            print(f"skip {name}: {p} missing", flush=True)
            continue
        meta[name] = {"path": str(src.relative_to(MLBT)),
                      "mtime": datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")}
        flt = [("atcf", "in", list(atcfs))] if atcfs else None
        s = pd.read_parquet(p, columns=COLS, filters=flt)
        lm = pd.read_parquet(src / "sear_legmax.parquet")
        if atcfs:
            lm = lm[lm.atcf.isin(atcfs)]
        s["y"] = s.pred_10m_peak_rmwcorr_ms.fillna(s.pred_10m_peak_ms) * KT
        s["y30"] = s.pred_10m_rmwcorr_ms.fillna(s.pred_10m_ms) * KT
        s["y_old"] = s.y
        if recompute:   # ruling 53 on a pre-ruling record: same WL150, current WL150 -> 10 m factor (as v1)
            corr = s.tdr_resolution_factor.fillna(1.0)
            wp = s.wl150_peak_ms.to_numpy(float); w = s.stage2_pred_wl150_ms.to_numpy(float)
            s["y"] = np.where(np.isfinite(wp), wl150_to_10m_factor(wp) * wp * corr * KT, s.y)
            s["y30"] = np.where(np.isfinite(w), wl150_to_10m_factor(w) * w * corr * KT, s.y30)
        s["fl"] = pd.to_numeric(s.flight_level_peak_kt, errors="coerce").fillna(s.wind_ms * KT)
        s = s[np.isfinite(s.aircraft_latitude) & np.isfinite(s.aircraft_longitude)
              & (np.isfinite(s.fl) | np.isfinite(s.y))]
        if thin_s:      # one row per aircraft per thin_s: the strongest estimate (v1's pick), else the strongest wind
            s["_bin"] = s.observation_time_utc.astype("int64") // (thin_s * 10**9)
            score = np.where(np.isfinite(s.y), 1e4 + s.y, s.fl.fillna(-1.0))
            s["_score"] = score
            s = s.loc[s.groupby(["atcf", "mission_id", "tail", "_bin"])._score.idxmax()]
            s = s.drop(columns=["_bin", "_score"])
        s["src"] = name
        rows.append(s.drop(columns=["pred_10m_peak_rmwcorr_ms", "pred_10m_peak_ms", "pred_10m_rmwcorr_ms",
                                    "pred_10m_ms", "stage2_pred_wl150_ms", "wl150_peak_ms", "wind_ms",
                                    "flight_level_peak_kt"]))
        lm = lm.copy(); lm["extra"] = bool(hrd); lm["src"] = name
        legs.append(lm)
        if not hrd:
            hdob_atcf.update(lm.atcf.unique())
        print(f"{name}: {len(s):,} rows, {s.atcf.nunique()} storms, {len(lm):,} leg maxima", flush=True)
    S = pd.concat(rows, ignore_index=True).sort_values(["atcf", "observation_time_utc"], kind="stable")
    L = pd.concat(legs, ignore_index=True) if legs else pd.DataFrame()
    fx = pd.read_parquet(FIX)
    if atcfs:
        fx = fx[fx.atcf.isin(atcfs)]
    fx["t"] = pd.to_datetime(fx.time, utc=True)
    meta["fix"] = {"path": str(FIX.relative_to(MLBT)),
                   "mtime": datetime.fromtimestamp(FIX.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")}
    return S, L, hdob_atcf, fx, meta


def ibtracs_by_atcf():
    p = REPO / "ibtracs_storms.json"
    if not p.exists():
        return {}
    out = {}
    for s in json.load(open(p)).get("storms", []):
        a = str(s.get("atcf_id") or "").upper()
        if a:
            out[a] = {"name": s.get("name"), "year": s.get("year"), "sid": s.get("sid"), "basin": s.get("basin")}
    return out


def ibtracs_tracks():
    """sid -> (epoch s array, lat array, lon array) from the repo's IBTrACS track chunks."""
    out = {}
    for f in sorted(REPO.glob("ibtracs_tracks_*.json")):
        if f.name.endswith("manifest.json"):
            continue
        for sid, pts in json.load(open(f)).items():
            t = np.array([pd.Timestamp(p["t"] + ("" if p["t"].endswith("Z") else "Z")).timestamp() for p in pts])
            lo = np.unwrap(np.radians([p["lo"] for p in pts]))
            out[sid] = (t, np.array([p["la"] for p in pts], float), np.degrees(lo))
    return out


def bt_pos(tracks, sid, t):
    """Best-track position at epoch t (linear; None outside the track)."""
    if not sid or sid not in tracks:
        return None
    T, la, lo = tracks[sid]
    if not len(T) or t < T[0] - 3 * 3600 or t > T[-1] + 3 * 3600:
        return None
    x = float(np.interp(t, T, lo))
    return float(np.interp(t, T, la)), ((x + 180) % 360) - 180


def core_mask(h):
    """Observations that count toward a flight-level maximum (see CORE_R_KM / CORE_Z_M)."""
    fl = h.fl.to_numpy(float); r = h.radius_km.to_numpy(float); z = h.aircraft_height_km.to_numpy(float) * 1000
    with np.errstate(invalid="ignore"):
        return np.isfinite(fl) & (r <= CORE_R_KM) & (z >= CORE_Z_M[0]) & (z <= CORE_Z_M[1])


def split_flights(g):
    """Flights = runs of one (mission, tail) with no gap > GAP_S. Returns a list of index arrays."""
    out = []
    for (mis, tail, src), h in g.groupby(["mission_id", "tail", "src"], sort=False):
        t = h.observation_time_utc.astype("int64").to_numpy() // 10**9
        o = np.argsort(t, kind="stable")
        t = t[o]; idx = h.index.to_numpy()[o]
        cut = np.flatnonzero(np.diff(t) > GAP_S) + 1
        for part in np.split(np.arange(len(t)), cut):
            out.append((str(mis), str(tail), str(src), idx[part], int(t[part[0]]), int(t[part[-1]])))
    out.sort(key=lambda f: f[4])
    return out


def safe_key(*parts):
    return re.sub(r"[^A-Za-z0-9_-]+", "-", "_".join(str(p) for p in parts)).strip("-")


def build(a):
    S, Lall, hdob_atcf, fx, meta = load_sources(a.atcf)
    names = ibtracs_by_atcf()
    tracks = ibtracs_tracks()
    OUT.mkdir(parents=True, exist_ok=True)
    idx_p = OUT / "index.json"
    index = json.load(open(idx_p)) if (a.atcf and idx_p.exists()) else {"storms": {}}
    FX = dict(list(fx.groupby("atcf")))
    LG = dict(list(Lall.groupby("atcf"))) if len(Lall) else {}
    SG = dict(list(S.groupby("atcf", sort=False)))
    total = 0
    for atcf in sorted(set(SG) | set(LG) | set(FX)):
        g = SG.get(atcf, S.iloc[0:0])
        L = LG.get(atcf, pd.DataFrame())
        if len(L):
            L = L[~L.extra] if atcf in hdob_atcf else L        # HRD legs only where HDOB has no legs (as v1)
            L = L.assign(t=pd.to_datetime(L.time, utc=True))
        T = g.observation_time_utc.astype("int64").to_numpy() // 10**9 if len(g) else np.array([], dtype=np.int64)
        y = g.y.to_numpy(float) if len(g) else np.array([])
        fl_arr = g.fl.to_numpy(float) if len(g) else np.array([])
        # ── flights ──
        flights, fl_files = [], []
        for mis, tail, src, ix, t0, t1 in (split_flights(g) if len(g) else []):
            h = g.loc[ix]
            yy = h.y.to_numpy(float); ff = h.fl.to_numpy(float)
            ffs = ff[core_mask(h)]
            key = safe_key(pd.Timestamp(t0, unit="s").strftime("%Y%m%dT%H%M"), tail, mis)
            z = h.aircraft_height_km.to_numpy(float) * 1000
            flights.append({"key": key, "mission": mis, "tail": tail, "src": src, "kind": flight_kind(src, tail),
                            "t0": t0, "t1": t1, "n": int(len(h)), "n_scored": int(np.isfinite(yy).sum()),
                            "fl_max_kt": int(round(ffs.max())) if len(ffs) else None,
                            "y_max_kt": int(round(np.nanmax(yy))) if np.isfinite(yy).any() else None,
                            "pass_max_kt": None, "n_passes": 0,
                            "z_med_m": int(round(np.nanmedian(z))) if np.isfinite(z).any() else None})
            fl_files.append((key, {"atcf": atcf, "key": key, "mission": mis, "tail": tail, "src": src,
                                   "kind": flight_kind(src, tail),
                                   "obs": {"t": (h.observation_time_utc.astype("int64") // 10**9).tolist(),
                                           "lat": arr(h.aircraft_latitude, 3), "lon": arr(h.aircraft_longitude, 3),
                                           "fl": arr(ff, 0), "z": arr(z, 0), "p": arr(h.fl_pres_mb, 1),
                                           "y5": arr(h.stage1_peak_500m_ms.to_numpy(float) * KT, 0),
                                           "y": arr(yy, 0), "y30": arr(h.y30, 0),
                                           "r": arr(h.radius_km, 1), "az": arr(h.azimuth_deg, 0),
                                           "rr": arr(h.r_over_rmw, 2), "sf": arr(h.sfmr_kt, 0)}}))

        def flight_of(tp, mission=None, tail=None):
            best, bd = None, None
            for i, f in enumerate(flights):
                if mission is not None and f["mission"] != mission:
                    continue
                if tail is not None and f["tail"] != tail:
                    continue
                if f["t0"] - 900 <= tp <= f["t1"] + 900:
                    d = 0 if f["t0"] <= tp <= f["t1"] else min(abs(tp - f["t0"]), abs(tp - f["t1"]))
                    if bd is None or d < bd:
                        best, bd = i, d
            return best

        # ── passes: exactly v1's set and values ──
        passes = []
        scored = np.isfinite(y)
        for p in (L.sort_values("time").itertuples() if len(L) else []):
            tp = int(pd.Timestamp(p.time).timestamp())
            m = (g.mission_id.to_numpy() == p.mission) & scored if len(g) else np.array([], dtype=bool)
            k = None
            if m.any():
                cand = np.flatnonzero(m)
                k = cand[int(np.argmin(np.abs(T[cand] - tp)))]
            row = g.iloc[k] if k is not None else None
            sc = float(row.y / row.y_old) if row is not None and row.y_old and np.isfinite(row.y_old) else 1.0
            tail = None if row is None else str(row["tail"])
            passes.append({"t": iso(p.time), "src": "hrd" if p.extra else "hdob", "mission": p.mission, "tail": tail,
                           "f": flight_of(tp, p.mission, tail),
                           "lat": None if row is None else fnum(row.aircraft_latitude, 3),
                           "lon": None if row is None else fnum(row.aircraft_longitude, 3),
                           "r": None if row is None else fnum(row.radius_km, 1),
                           "az": None if row is None else fnum(row.azimuth_deg, 0),
                           "y_kt": fnum(p.y_kt * sc), "y_corr_kt": fnum(p.y_corr_kt * sc), "y_30s_kt": fnum(p.y_30s_kt * sc),
                           "fl_peak_kt": fnum(p.fl_peak_kt, 0), "rmw_km": fnum(p.rmw_km), "r_over_rmw": fnum(p.r_over_rmw, 2),
                           "height_km": fnum(getattr(p, "height_km", None), 2)})
        if atcf in FX:
            f = FX[atcf]
            if len(L):
                keep = np.ones(len(f), dtype=bool)
                for mis, lg in L.groupby("mission"):
                    t0, t1, fp, ex = lg.t.min(), lg.t.max(), lg.fl_peak_kt.max(), bool(lg.extra.any())
                    cov = ((f.t >= t0 - pd.Timedelta("2h")) & (f.t <= t1 + pd.Timedelta("2h"))).to_numpy()
                    if ex:
                        cov &= (f.v_peak_kt.to_numpy() <= 1.1 * fp)
                    keep &= ~cov
                f = f[keep]
            for p in f.sort_values("t").itertuples():
                tp = int(p.t.timestamp())
                passes.append({"t": iso(p.t), "src": "fix-" + str(p.src).lower(), "mission": None, "tail": None,
                               "f": flight_of(tp), "lat": fnum(p.lat, 3), "lon": None, "r": fnum(p.radius_km, 1), "az": None,
                               "y_kt": fnum(p.y_kt), "y_corr_kt": fnum(p.y_corr_kt), "y_30s_kt": None,
                               "fl_peak_kt": fnum(p.v_peak_kt, 0), "rmw_km": fnum(p.rmw_km), "r_over_rmw": fnum(p.r_over_rmw, 2),
                               "height_km": fnum(p.height_km, 2)})
        passes.sort(key=lambda q: q["t"])
        for q in passes:
            if q["f"] is None or q["y_corr_kt"] is None:
                continue
            fr = flights[q["f"]]
            fr["n_passes"] += 1
            fr["pass_max_kt"] = max(fr["pass_max_kt"] or 0, q["y_corr_kt"])
        pmax = max((q["y_corr_kt"] for q in passes if q["y_corr_kt"] is not None), default=None)
        omax = int(round(np.nanmax(y))) if scored.any() else None
        cand = [v for v in (pmax, omax) if v is not None]
        if not cand:
            continue
        mx = int(round(max(cand)))
        src_mx = "obs" if (omax is not None and omax >= (pmax or -1)) else next(q["src"] for q in passes if q["y_corr_kt"] == pmax)
        if src_mx == "obs":                    # where the maximum is: the landing map puts the storm there
            k = int(np.nanargmax(np.where(scored, y, -np.inf)))
            at = {"t": int(T[k]), "lat": fnum(g.aircraft_latitude.iloc[k], 2), "lon": fnum(g.aircraft_longitude.iloc[k], 2)}
        else:
            q = next(q for q in passes if q["y_corr_kt"] == pmax)
            at = {"t": int(pd.Timestamp(q["t"]).timestamp()), "lat": fnum(q["lat"], 2), "lon": fnum(q["lon"], 2)}
            if at["lon"] is None:              # a fix pass has no aircraft position: the best-track center then
                bp = bt_pos(tracks, names.get(atcf, {}).get("sid"), at["t"])
                if bp:
                    at.update({"lat": at["lat"] if at["lat"] is not None else fnum(bp[0], 2), "lon": fnum(bp[1], 2), "pos": "bt"})
        # storm flight-level maximum: the core of the flight files, or a pass's own peak -- for a fix pass that is
        # the vortex message's maximum flight-level wind, the only flight-level number when no file covers it
        core = fl_arr[core_mask(g)] if len(g) else np.array([])
        flmax, fl_src = (int(round(core.max())), "flight") if len(core) else (None, None)
        for q in passes:
            v = q["fl_peak_kt"]
            if v is not None and (flmax is None or v > flmax):
                flmax, fl_src = int(round(v)), ("vdm" if q["src"].startswith("fix") else "flight")
        era = "extrapolated" if int(atcf[-4:]) < 1997 else "trained"   # SEAR training data start 1997 (ruling 54)
        nm = names.get(atcf, {})
        out = {"atcf": atcf, "name": nm.get("name"), "year": nm.get("year") or int(atcf[-4:]), "sid": nm.get("sid"),
               "basin": nm.get("basin"), "schema": 2, "model": MODEL, "chain": CHAIN, "era": era,
               "max_kt": mx, "max_src": src_mx, "max_at": at, "obs_max_kt": omax, "pass_max_kt": pmax,
               "fl_max_kt": flmax, "fl_max_src": fl_src,
               "flights": flights, "passes": passes,
               "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        sd = OUT / atcf
        sd.mkdir(exist_ok=True)
        for old in sd.glob("*.json"):          # a re-run may re-key flights: never leave orphans behind
            old.unlink()
        nb = 0
        for key, body in fl_files:
            raw = json.dumps(body, separators=(",", ":"), allow_nan=False)
            (sd / f"{key}.json").write_text(raw); nb += len(raw)
        raw = json.dumps(out, separators=(",", ":"), allow_nan=False)
        (OUT / f"{atcf}.json").write_text(raw); nb += len(raw)
        total += nb
        index["storms"][atcf] = {"name": nm.get("name"), "year": out["year"], "sid": nm.get("sid"), "basin": nm.get("basin"),
                                 "era": era, "max_kt": mx, "max_src": src_mx, "max_at": at,
                                 "fl_max_kt": flmax, "fl_max_src": fl_src,
                                 "n_flights": len(flights), "n_passes": len(passes),
                                 "t0": flights[0]["t0"] if flights else (int(pd.Timestamp(passes[0]["t"]).timestamp()) if passes else None)}
        print(f"{atcf} {nm.get('name') or '':<10} {len(flights):3d} flights {len(g):7,d} obs {len(passes):3d} passes "
              f"max {mx} kt ({src_mx}) {nb/1024:7.0f} KB", flush=True)
    index.update({"schema": 2, "model": MODEL, "chain": CHAIN, "sources": meta,
                  "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    idx_p.write_text(json.dumps(index, separators=(",", ":"), allow_nan=False))
    print(f"index: {len(index['storms'])} storms, {total/1e6:.1f} MB raw this run -> {OUT}")


def upload(atcfs):
    cli = r2_client()
    files = sorted(OUT.rglob("*.json"))
    if atcfs:
        keep = set(atcfs)
        files = [f for f in files if f.name == "index.json" or f.stem in keep or f.parent.name in keep]
    idx = [f for f in files if f.name == "index.json" and f.parent == OUT]
    body = [f for f in files if f not in idx]
    from concurrent.futures import ThreadPoolExecutor

    def put(f, cc):
        cli.put_object(Bucket="tc-atlas-rt", Key=f"{PREFIX}/{f.relative_to(OUT).as_posix()}",
                       Body=gzip.compress(f.read_bytes(), 9), ContentType="application/json",
                       ContentEncoding="gzip", CacheControl=cc)

    n = 0
    with ThreadPoolExecutor(max_workers=16) as ex:      # one put is ~1 s of latency; 16 at a time
        for _ in ex.map(lambda f: put(f, "public, max-age=86400"), body):
            n += 1
            if n % 500 == 0:
                print(f"  {n}/{len(files)}", flush=True)
    for f in idx:                              # the index goes last, so it never points at a missing object
        put(f, "public, max-age=3600"); n += 1
    print(f"uploaded {n} objects to {PREFIX}/")


def main() -> int:
    global OUT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--atcf", nargs="*")
    ap.add_argument("--upload", action="store_true", help="after building, gzip + upload to R2")
    ap.add_argument("--upload-only", action="store_true", help="upload OUT as it is, no rebuild")
    ap.add_argument("--out", help=f"build directory (default {OUT})")
    a = ap.parse_args()
    if a.out:
        OUT = Path(a.out).expanduser()
    if not a.upload_only:
        build(a)
    if a.upload or a.upload_only:
        upload(a.atcf)
    return 0


if __name__ == "__main__":
    sys.exit(main())
