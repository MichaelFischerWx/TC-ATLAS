#!/usr/bin/env python3
"""Publish MLBT's historical SEAR record (experimental 10-m wind from flight-level recon) for the
Global Archive recon section.

Source: MLBT phase1/out/sear/ (Atlantic HDOB 2008-2025), phase1/out/sear_ep/ (E/C Pacific 2008-2024) and
phase1/out/sear_hrd_all/ (HRD flight-level files 1998-2007, 10-m recomputed under ruling 53),
written by phase1/sear_operator.py with the same Stage 1 v4 / Stage 2 v8 chain as the live product
(re-scoring AL142024 on 2026-09-26 reproduced the record exactly).

Output on R2 (cdn.tcatlas.org), one gzip JSON per storm + an index:
  sear-hist/v1/<ATCF>.json   {atcf, model, n, max_kt,
                              obs: {t:[epoch s], lat:[..], lon:[..], y:[kt], y30:[kt], r:[km], az:[deg], ac:[i]},
                              aircraft: [tail...],            # ac indexes this list
                              passes: [{t, mission, tail, lat, lon, y_kt, y_corr_kt, y_30s_kt, fl_peak_kt, rmw_km, r_over_rmw}]}
  sear-hist/v1/index.json    {storms: {ATCF: {max_kt, n, n_passes}}, model, generated}
y = pred_10m_peak_rmwcorr (10-s-peak scale, RMW-corrected; the live product's headline column),
y30 = pred_10m_rmwcorr (30-s scale). The page joins obs by time (+-20 s) and aircraft position (<= 8 km),
so it works for both the 30-s HDOB missions and NOAA's 1-s/10-s HRD flight-level files.

Usage: python3 bin/build_sear_hist.py [--atcf AL142024 ...] [--no-upload]
"""
from __future__ import annotations

import argparse
import gzip
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

MLBT = Path.home() / "github" / "MLBT"
# (dir, recompute_10m, thin_s): sear_hrd_all = HRD flight-level files 1998-2007 (NOAA 1-s/10-s, USAF 10-s;
# ruling 45 addendum 3), scored before ruling 53 -> its 10-m values are recomputed from the stored WL150
# with the current factor, and its 1-s rows thinned to the strongest per aircraft per 10 s.
SRC = [(MLBT / "phase1" / "out" / "sear", False, 0), (MLBT / "phase1" / "out" / "sear_ep", False, 0),
       (MLBT / "phase1" / "out" / "sear_hrd_all", True, 10)]
OUT = Path.home() / "Data" / "sear_hist"
PREFIX = "sear-hist/v1"
KT = 1.943844
MODEL = "SEAR Stage 1 v4 (local RMW, w_rel) / Stage 2 v8, trained through 2024 -- MLBT historical record"
COLS = ["atcf", "mission_id", "tail", "observation_time_utc", "aircraft_latitude", "aircraft_longitude",
        "pred_10m_peak_rmwcorr_ms", "pred_10m_peak_ms", "pred_10m_rmwcorr_ms", "pred_10m_ms", "radius_km", "azimuth_deg",
        "stage2_pred_wl150_ms", "wl150_peak_ms", "tdr_resolution_factor"]


def r2_client():
    def secret(n):
        return subprocess.run(["/opt/homebrew/bin/gcloud", "secrets", "versions", "access", "latest", f"--secret={n}",
                               "--project=tc-atlas-web"], capture_output=True, text=True, check=True).stdout.strip()
    import boto3
    return boto3.client("s3", endpoint_url="https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com",
                        aws_access_key_id=secret("r2-access-key-id"), aws_secret_access_key=secret("r2-secret-access-key"),
                        region_name="auto")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--atcf", nargs="*")
    ap.add_argument("--no-upload", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    cli = None if a.no_upload else r2_client()
    idx_p = OUT / "index.json"
    index = json.load(open(idx_p)) if idx_p.exists() else {"storms": {}}
    sys.path.insert(0, str(MLBT / "external" / "SEAR" / "Scripts"))
    from reduction import wl150_to_10m_factor
    frames, legs, hdob_atcf = {}, {}, set()
    for src, recompute, thin_s in SRC:
        s = pd.read_parquet(src / "sear_samples.parquet", columns=COLS)
        lm = pd.read_parquet(src / "sear_legmax.parquet")
        if a.atcf:
            s = s[s.atcf.isin(a.atcf)]; lm = lm[lm.atcf.isin(a.atcf)]
        s["y"] = s.pred_10m_peak_rmwcorr_ms.fillna(s.pred_10m_peak_ms) * KT
        s["y30"] = s.pred_10m_rmwcorr_ms.fillna(s.pred_10m_ms) * KT
        s["y_old"] = s.y
        if recompute:   # ruling 53 on a pre-ruling record: same WL150, current WL150->10 m factor
            corr = s.tdr_resolution_factor.fillna(1.0)
            wp = s.wl150_peak_ms.to_numpy(float); w = s.stage2_pred_wl150_ms.to_numpy(float)
            s["y"] = np.where(np.isfinite(wp), wl150_to_10m_factor(wp) * wp * corr * KT, s.y)
            s["y30"] = np.where(np.isfinite(w), wl150_to_10m_factor(w) * w * corr * KT, s.y30)
        s = s[np.isfinite(s.y) & np.isfinite(s.aircraft_latitude)].sort_values("observation_time_utc")
        if thin_s:      # strongest estimate per aircraft per thin_s seconds
            s["_bin"] = s.observation_time_utc.astype("int64") // (thin_s * 10**9)
            s = s.loc[s.groupby(["atcf", "tail", "_bin"]).y.idxmax()].sort_values("observation_time_utc")
        for atcf, g in s.groupby("atcf"):   # a storm can be in several sources (HDOB + HRD legs): merge obs
            frames.setdefault(atcf, []).append(g.drop(columns=["_bin"], errors="ignore"))
        for atcf, l in lm.groupby("atcf"):
            l = l.copy(); l["extra"] = bool(recompute)
            legs.setdefault(atcf, []).append(l)
            if not recompute:
                hdob_atcf.add(atcf)
    # Fix operator (VDM max 10-s FL wind / F-deck; phase1/sear_fix_operator.py): the passes the 1-s / 30-s legs
    # miss. Combined exactly like phase1/fuse_wind.py (ruling 45 + addendum): HDOB legs win; HRD legs only for
    # storms without HDOB; a fix is dropped when a leg flight covers it (+-2 h), except that an HRD leg replaces
    # a fix only if the leg's FL peak is within 10% of the fix's (Georges 1998 147-kt pass kept).
    fx = pd.read_parquet(MLBT / "phase1" / "out" / "sear" / "sear_fix.parquet")
    if a.atcf:
        fx = fx[fx.atcf.isin(a.atcf)]
    fx["t"] = pd.to_datetime(fx.time, utc=True)
    wref = fx.wl150_atpeak_ms.where(np.isfinite(fx.wl150_atpeak_ms), fx.stage2_pred_wl150_ms).to_numpy(float)
    f_old = np.array([0.925, 0.898, 0.875, 0.853, 0.875])[np.clip(np.searchsorted([0, 20, 30, 40, 50], wref, side="right") - 1, 0, 4)]
    fx["sc53"] = np.where(np.isfinite(wref), wl150_to_10m_factor(wref) / f_old, 1.0)   # fix record predates ruling 53
    FX = dict(list(fx.groupby("atcf")))
    iso = lambda t: pd.Timestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ")
    fnum = lambda v, nd=1: None if v is None or not np.isfinite(v) else round(float(v), nd)
    for atcf in sorted(set(frames) | set(legs) | set(FX)):
        g = pd.concat(frames[atcf], ignore_index=True).sort_values("observation_time_utc") if atcf in frames else pd.DataFrame(columns=COLS + ["y", "y30", "y_old"])
        L = pd.concat(legs.get(atcf, [pd.DataFrame()]), ignore_index=True)
        if len(L):
            L = L[~L.extra] if atcf in hdob_atcf else L        # HRD legs only where HDOB has no legs
            L["t"] = pd.to_datetime(L.time, utc=True)
        tails = sorted(g["tail"].astype(str).unique()) if len(g) else []
        ti = {t: i for i, t in enumerate(tails)}
        obs = {"t": (g.observation_time_utc.astype("int64") // 10**9).tolist() if len(g) else [],
               "lat": g.aircraft_latitude.astype(float).round(3).tolist() if len(g) else [],
               "lon": g.aircraft_longitude.astype(float).round(3).tolist() if len(g) else [],
               "y": g.y.round().astype(int).tolist() if len(g) else [], "y30": g.y30.round().fillna(-1).astype(int).tolist() if len(g) else [],
               "r": g.radius_km.round(1).where(np.isfinite(g.radius_km), None).tolist() if len(g) else [],
               "az": g.azimuth_deg.round().where(np.isfinite(g.azimuth_deg), None).tolist() if len(g) else [],
               "ac": [ti[str(t)] for t in g["tail"]] if len(g) else []}
        passes = []
        for p in (L.sort_values("time").itertuples() if len(L) else []):
            tp = int(pd.Timestamp(p.time).timestamp())
            near = g[g.mission_id == p.mission] if len(g) else g
            k = int(np.argmin(np.abs((near.observation_time_utc.astype("int64") // 10**9).to_numpy() - tp))) if len(near) else None
            row = near.iloc[k] if k is not None else None
            sc = float(row.y / row.y_old) if row is not None and row.y_old and np.isfinite(row.y_old) else 1.0
            passes.append({"t": iso(p.time), "src": "hrd" if p.extra else "hdob", "mission": p.mission,
                           "tail": None if row is None else str(row["tail"]),
                           "lat": None if row is None else fnum(row.aircraft_latitude, 3), "lon": None if row is None else fnum(row.aircraft_longitude, 3),
                           "y_kt": fnum(p.y_kt * sc), "y_corr_kt": fnum(p.y_corr_kt * sc), "y_30s_kt": fnum(p.y_30s_kt * sc),
                           "fl_peak_kt": fnum(p.fl_peak_kt, 0), "rmw_km": fnum(p.rmw_km), "r_over_rmw": fnum(p.r_over_rmw, 2)})
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
                passes.append({"t": iso(p.t), "src": "fix-" + str(p.src).lower(), "mission": None, "tail": None,
                               "lat": fnum(p.lat, 3), "lon": None,
                               "y_kt": fnum(p.y_kt * p.sc53), "y_corr_kt": fnum(p.y_corr_kt * p.sc53), "y_30s_kt": None,
                               "fl_peak_kt": fnum(p.v_peak_kt, 0), "rmw_km": fnum(p.rmw_km), "r_over_rmw": fnum(p.r_over_rmw, 2)})
        passes.sort(key=lambda q: q["t"])
        pmax = max((q["y_corr_kt"] for q in passes if q["y_corr_kt"] is not None), default=None)
        omax = int(round(g.y.max())) if len(g) else None
        cand = [v for v in (pmax, omax) if v is not None]
        if not cand:
            continue
        mx = int(round(max(cand)))
        src_mx = "obs" if (omax is not None and omax >= (pmax or -1)) else next(q["src"] for q in passes if q["y_corr_kt"] == pmax)
        out = {"atcf": atcf, "model": MODEL, "n": len(g), "max_kt": mx, "max_src": src_mx, "obs_max_kt": omax, "pass_max_kt": pmax,
               "aircraft": tails, "obs": obs, "passes": passes, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        raw = gzip.compress(json.dumps(out, separators=(",", ":"), allow_nan=False).encode(), 9)
        (OUT / f"{atcf}.json").write_bytes(raw)
        index["storms"][atcf] = {"max_kt": mx, "max_src": src_mx, "n": len(g), "n_passes": len(passes)}
        if cli is not None:
            cli.put_object(Bucket="tc-atlas-rt", Key=f"{PREFIX}/{atcf}.json", Body=raw, ContentType="application/json",
                           ContentEncoding="gzip", CacheControl="public, max-age=86400")
        print(f"{atcf}: {len(g):,} obs, {len(passes)} passes, max {mx} kt ({src_mx}), {len(raw)/1024:.0f} KB", flush=True)
    index.update({"model": MODEL, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    idx_p.write_text(json.dumps(index, separators=(",", ":")))
    if cli is not None:
        cli.put_object(Bucket="tc-atlas-rt", Key=f"{PREFIX}/index.json", Body=idx_p.read_bytes(), ContentType="application/json",
                       CacheControl="public, max-age=3600")
    print(f"index: {len(index['storms'])} storms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
