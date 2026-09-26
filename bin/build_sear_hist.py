#!/usr/bin/env python3
"""Publish MLBT's historical SEAR record (experimental 10-m wind from flight-level recon) for the
Global Archive recon section.

Source: MLBT phase1/out/sear/ (Atlantic 2001-2025) and phase1/out/sear_ep/ (E/C Pacific 2008-2024),
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
SRC = [MLBT / "phase1" / "out" / "sear", MLBT / "phase1" / "out" / "sear_ep"]
OUT = Path.home() / "Data" / "sear_hist"
PREFIX = "sear-hist/v1"
KT = 1.943844
MODEL = "SEAR Stage 1 v4 (local RMW, w_rel) / Stage 2 v8, trained through 2024 -- MLBT historical record"
COLS = ["atcf", "mission_id", "tail", "observation_time_utc", "aircraft_latitude", "aircraft_longitude",
        "pred_10m_peak_rmwcorr_ms", "pred_10m_peak_ms", "pred_10m_rmwcorr_ms", "pred_10m_ms", "radius_km", "azimuth_deg"]


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
    for src in SRC:
        s = pd.read_parquet(src / "sear_samples.parquet", columns=COLS)
        lm = pd.read_parquet(src / "sear_legmax.parquet")
        if a.atcf:
            s = s[s.atcf.isin(a.atcf)]; lm = lm[lm.atcf.isin(a.atcf)]
        s["y"] = s.pred_10m_peak_rmwcorr_ms.fillna(s.pred_10m_peak_ms) * KT
        s["y30"] = s.pred_10m_rmwcorr_ms.fillna(s.pred_10m_ms) * KT
        s = s[np.isfinite(s.y) & np.isfinite(s.aircraft_latitude)].sort_values("observation_time_utc")
        for atcf, g in s.groupby("atcf"):
            tails = sorted(g["tail"].astype(str).unique())
            ti = {t: i for i, t in enumerate(tails)}
            ts = (g.observation_time_utc.astype("int64") // 10**9).to_numpy()
            obs = {"t": ts.tolist(), "lat": g.aircraft_latitude.round(3).tolist(), "lon": g.aircraft_longitude.round(3).tolist(),
                   "y": g.y.round().astype(int).tolist(), "y30": g.y30.round().fillna(-1).astype(int).tolist(),
                   "r": g.radius_km.round(1).where(np.isfinite(g.radius_km), None).tolist(),
                   "az": g.azimuth_deg.round().where(np.isfinite(g.azimuth_deg), None).tolist(),
                   "ac": [ti[str(t)] for t in g["tail"]]}
            passes = []
            for p in lm[lm.atcf == atcf].sort_values("time").itertuples():
                tp = int(pd.Timestamp(p.time).timestamp())
                near = g[(g.mission_id == p.mission)]
                k = int(np.argmin(np.abs((near.observation_time_utc.astype("int64") // 10**9).to_numpy() - tp))) if len(near) else None
                row = near.iloc[k] if k is not None else None
                f = lambda v, nd=1: None if v is None or not np.isfinite(v) else round(float(v), nd)
                passes.append({"t": pd.Timestamp(p.time).strftime("%Y-%m-%dT%H:%M:%SZ"), "mission": p.mission,
                               "tail": None if row is None else str(row["tail"]),
                               "lat": None if row is None else f(row.aircraft_latitude, 3), "lon": None if row is None else f(row.aircraft_longitude, 3),
                               "y_kt": f(p.y_kt), "y_corr_kt": f(p.y_corr_kt), "y_30s_kt": f(p.y_30s_kt), "fl_peak_kt": f(p.fl_peak_kt, 0),
                               "rmw_km": f(p.rmw_km), "r_over_rmw": f(p.r_over_rmw, 2)})
            mx = int(round(g.y.max()))
            out = {"atcf": atcf, "model": MODEL, "n": len(g), "max_kt": mx, "aircraft": tails, "obs": obs, "passes": passes,
                   "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
            raw = gzip.compress(json.dumps(out, separators=(",", ":"), allow_nan=False).encode(), 9)
            (OUT / f"{atcf}.json").write_bytes(raw)
            index["storms"][atcf] = {"max_kt": mx, "n": len(g), "n_passes": len(passes)}
            if cli is not None:
                cli.put_object(Bucket="tc-atlas-rt", Key=f"{PREFIX}/{atcf}.json", Body=raw, ContentType="application/json",
                               ContentEncoding="gzip", CacheControl="public, max-age=86400")
            print(f"{atcf}: {len(g):,} obs, {len(passes)} passes, max {mx} kt, {len(raw)/1024:.0f} KB", flush=True)
    index.update({"model": MODEL, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    idx_p.write_text(json.dumps(index, separators=(",", ":")))
    if cli is not None:
        cli.put_object(Bucket="tc-atlas-rt", Key=f"{PREFIX}/index.json", Body=idx_p.read_bytes(), ContentType="application/json",
                       CacheControl="public, max-age=3600")
    print(f"index: {len(index['storms'])} storms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
