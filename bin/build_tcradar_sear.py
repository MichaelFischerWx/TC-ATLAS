#!/usr/bin/env python3
"""Precompute the experimental SEAR 10-m wind for every TC-RADAR explorer case (v3m swath + merge).

Recipe = MLBT realtime/sear_swath.compute_field (validated in MLBT external/SEAR/Repro/tdr_swath):
the case's own WCM-recentered earth-relative 500-m and 2-km winds -> SEAR Stage 2 (the shipped
live model) -> WL150 -> 10 m (SEAR's binned sonde factor). Environment = ERA5 850-200 hPa shear
(0-500 km) from the TC-RADAR v4.0 case on the same mission nearest in time (the environment
Stage 2 was trained on). Cases with no v4.0 match are skipped and listed in the index.

NOTE: Stage 2 was trained on dropsondes collocated with these same analyses (all years <= 2024),
so these fields are IN-SAMPLE -- the explorer labels them that way.

Output (one gzip JSON per case, in the /data response shape the explorer already renders):
  tcradar-sear/v1/{swath|merge}/{case_index}.json   {data: [[kt|null]], x, y, units, rmw_km, max_kt, ...}
  tcradar-sear/v1/{swath|merge}/index.json          {cases: {idx: max_kt}, skipped: {...}, model, generated}
Uploaded to R2 (cdn.tcatlas.org) with the R2 creds from Secret Manager, like sear-rt-cron.sh.

Usage:  python3 bin/build_tcradar_sear.py [--dtype swath|merge|both] [--limit N] [--no-upload] [--cases 1,2]
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

MLBT = Path.home() / "github" / "MLBT"
sys.path.insert(0, str(MLBT / "realtime"))
sys.path.insert(0, str(MLBT / "external" / "SEAR" / "Scripts"))
import joblib  # noqa: E402
import sear_rt  # noqa: E402  (model paths / tag -- same model as the live product)
import sear_swath  # noqa: E402
from config import STAGE2_BASE_RMW_FLOOR_KM, TC_RADAR_SWATH_FILE  # noqa: E402
from reduction import wl150_to_10m_factor  # noqa: E402
from stage1_features import build_case_environment  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
TCR = Path.home() / "Data" / "TDR" / "TCRADAR"
FILES = {("swath", "early"): "tc_radar_v3m_1997_2019_xy_rel_swath_ships.nc",
         ("swath", "recent"): "tc_radar_v3m_2020_2024_xy_rel_swath_ships.nc",
         ("merge", "early"): "tc_radar_v3m_1997_2019_xy_rel_merge_ships.nc",
         ("merge", "recent"): "tc_radar_v3m_2020_2024_xy_rel_merge_ships.nc"}
META = {"swath": REPO / "tc_radar_metadata.json", "merge": REPO / "tc_radar_metadata_merge.json"}
PREFIX = "tcradar-sear/v1"
OUT = Path(os.environ.get("TCRADAR_SEAR_OUT", Path.home() / "Data" / "tcradar_sear"))
KT = 1.943844
MAX_MATCH_H = 4.0          # v4.0 case on the same mission within this many hours supplies the ERA5 env


def v4_env_table() -> pd.DataFrame:
    ds = xr.open_dataset(TC_RADAR_SWATH_FILE, decode_times=False)
    env = build_case_environment(ds).set_index("case_idx")
    t = pd.DataFrame({"mission": np.char.strip(ds["mission_ID"].values.astype(str)), "t": ds["time"].values.astype(float)})
    t = t.join(env[["era5_shear_mag_850_200_0_500", "era5_shear_dir_850_200_0_500", "era5_rh_low_0_500"]])
    return t.dropna(subset=["era5_shear_mag_850_200_0_500", "era5_shear_dir_850_200_0_500"])


def field(u5, v5, u2, v2, x, y, rmw, lat, env, art):
    """sear_swath.compute_field's recipe on an already-recentered grid (center at x=y=0)."""
    s5, s2 = np.hypot(u5, v5), np.hypot(u2, v2)
    X, Y = np.meshgrid(x, y); r = np.hypot(X, Y); az = (np.degrees(np.arctan2(X, Y)) + 360) % 360
    rb, pb = sear_swath._wedge_rmw(s2, x, y, 0.0, 0.0, rmw)
    b = np.minimum(az // 10, 35).astype(int); rl, pk = rb[b], pb[b]
    ring = np.abs(r - rmw) < 4
    pk_mean = np.nanmax(np.where(ring, s2, np.nan)) if np.isfinite(np.where(ring, s2, np.nan)).any() else np.nan
    fb = ~np.isfinite(rl); rmw_use = np.where(fb, rmw, rl); pk_use = np.where(fb, pk_mean, pk)
    sraz = np.radians((az - env["dir"] + 360) % 360); ln_rmw = np.log(max(rmw, 2.0))
    cols = {"stacked_tdr500_wind_ms": s5, "stacked_tdr500_u_ms": u5, "stacked_tdr500_v_ms": v5, "wind_ms": s2,
            "r_over_rmw": r / rmw_use, "sraz_sin": np.sin(sraz), "sraz_cos": np.cos(sraz), "latitude": lat,
            "era5_shear_mag_850_200_0_500": env["shear"], "era5_rh_low_0_500": env["rh"], "ln_rmw": ln_rmw,
            "w_rel": np.clip(s2 / pk_use, 0, 1.5), "radius_km": r}
    F = pd.DataFrame({f: np.broadcast_to(np.asarray(cols[f], float), r.shape).ravel() for f in art["features"]})
    ok = np.isfinite(F.to_numpy(float)).all(1) & (s5.ravel() > 0) & (r.ravel() <= 200)
    wl = np.full(r.size, np.nan)
    if ok.any():
        base = art.get("base")
        b0 = (base["c0"] + base["c1"] * max(ln_rmw, np.log(STAGE2_BASE_RMW_FLOOR_KM))) if base else 0.0
        wl[ok] = (b0 + art["model"].predict(F[ok])) * s5.ravel()[ok]
    return (wl150_to_10m_factor(wl) * wl).reshape(r.shape) * KT, r


def r2_client():
    ep = "https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com"
    def secret(n):
        return subprocess.run(["/opt/homebrew/bin/gcloud", "secrets", "versions", "access", "latest", f"--secret={n}",
                               "--project=tc-atlas-web"], capture_output=True, text=True, check=True).stdout.strip()
    import boto3
    return boto3.client("s3", endpoint_url=ep, aws_access_key_id=secret("r2-access-key-id"),
                        aws_secret_access_key=secret("r2-secret-access-key"), region_name="auto")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dtype", default="both", choices=["swath", "merge", "both"])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--cases", default="", help="comma-separated case indices (test runs)")
    ap.add_argument("--no-upload", action="store_true")
    a = ap.parse_args()
    art = joblib.load(sear_rt.STAGE2_MODEL)
    v4 = v4_env_table()
    cli = None if a.no_upload else r2_client()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for dt in (["swath", "merge"] if a.dtype == "both" else [a.dtype]):
        meta = json.load(open(META[dt]))["cases"]
        early_n = xr.open_dataset(TCR / FILES[(dt, "early")], decode_times=False).sizes["num_cases"]
        dss = {k: xr.open_dataset(TCR / FILES[(dt, k)], decode_times=False) for k in ("early", "recent")}
        want = {int(c) for c in a.cases.split(",") if c} if a.cases else None
        odir = OUT / dt; odir.mkdir(parents=True, exist_ok=True)
        idx_p = odir / "index.json"
        index = json.load(open(idx_p)) if idx_p.exists() else {"cases": {}, "skipped": {}}
        t0 = time.time(); n = 0
        for m in meta:
            ci = int(m["case_index"])
            if want is not None and ci not in want:
                continue
            if a.limit and n >= a.limit:
                break
            n += 1
            part, li = ("early", ci) if ci < early_n else ("recent", ci - early_n)
            ds = dss[part]
            tm = pd.Timestamp(m["datetime"].replace(" UTC", ""), tz="UTC").timestamp()
            cand = v4[v4.mission == str(m["mission_id"]).strip()]
            if cand.empty or (np.abs(cand.t - tm).min() > MAX_MATCH_H * 3600):
                index["skipped"][str(ci)] = "no TC-RADAR v4.0 case on this mission within 4 h (no ERA5 environment)"
                continue
            e = cand.iloc[int(np.argmin(np.abs(cand.t.to_numpy() - tm)))]
            env = {"shear": float(e.era5_shear_mag_850_200_0_500), "dir": float(e.era5_shear_dir_850_200_0_500),
                   "rh": float(e.era5_rh_low_0_500)}
            h = ds["height"].values; i2 = int(np.argmin(np.abs(h - 2))); i05 = int(np.argmin(np.abs(h - 0.5)))
            g = lambda v, i: ds[v].isel(num_cases=li, height=i).values.astype(float)
            u5, v5 = g("recentered_earth_relative_eastward_wind", i05), g("recentered_earth_relative_northward_wind", i05)
            u2, v2 = g("recentered_earth_relative_eastward_wind", i2), g("recentered_earth_relative_northward_wind", i2)
            x = ds["eastward_distance"].values.astype(float); y = ds["northward_distance"].values.astype(float)
            rmw = float(ds["tc_rmw"].isel(num_cases=li, height=i2).values)
            if not np.isfinite(rmw) or rmw <= 0:
                index["skipped"][str(ci)] = "no 2-km RMW"; continue
            w, r = field(u5, v5, u2, v2, x, y, rmw, float(m["latitude"]), env, art)
            if not np.isfinite(w).any():
                index["skipped"][str(ci)] = "no 500-m TDR data"; continue
            rows = np.where(np.isfinite(w).any(1))[0]; cols = np.where(np.isfinite(w).any(0))[0]
            sub = w[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
            k = np.unravel_index(np.nanargmax(w), w.shape)
            out = {"case_index": ci, "data_type": dt, "storm_name": m.get("storm_name"), "datetime": m.get("datetime"),
                   "x": [float(v) for v in x[cols[0]:cols[-1] + 1]], "y": [float(v) for v in y[rows[0]:rows[-1] + 1]],
                   "data": [[None if not np.isfinite(v) else int(round(v)) for v in row] for row in sub],
                   "units": "kt", "variable": {"key": "sear_10m", "display_name": "SEAR 10-m wind (exp)", "units": "kt"},
                   "rmw_km": rmw, "max_kt": int(round(w[k])), "max_r_km": round(float(r[k]), 1),
                   "coverage_r60": round(float(np.isfinite(w[r < 60]).mean()), 2),
                   "env": {"shear_ms": round(env["shear"], 1), "shear_dir": round(env["dir"]), "src": "ERA5 via TC-RADAR v4.0",
                           "match_dt_min": round(float(abs(e.t - tm) / 60))},
                   "model": sear_rt.MODEL_TAG, "in_sample": True, "generated": now}
            fp = odir / f"{ci}.json"
            raw = gzip.compress(json.dumps(out, separators=(",", ":"), allow_nan=False).encode(), 9)
            fp.write_bytes(raw)
            index["cases"][str(ci)] = out["max_kt"]; index["skipped"].pop(str(ci), None)
            if cli is not None:
                cli.put_object(Bucket="tc-atlas-rt", Key=f"{PREFIX}/{dt}/{ci}.json", Body=raw, ContentType="application/json",
                               ContentEncoding="gzip", CacheControl="public, max-age=86400")
            if n % 100 == 0:
                print(f"{dt}: {n} cases ({len(index['cases'])} ok, {len(index['skipped'])} skipped) {time.time() - t0:.0f}s", flush=True)
        index.update({"model": sear_rt.MODEL_TAG, "generated": now, "units": "kt", "in_sample": True,
                      "note": "SEAR 10-m wind (experimental) from the TDR 500-m wind; Stage 2 trained on sondes collocated with these analyses"})
        idx_p.write_text(json.dumps(index, separators=(",", ":")))
        if cli is not None:
            cli.put_object(Bucket="tc-atlas-rt", Key=f"{PREFIX}/{dt}/index.json", Body=idx_p.read_bytes(),
                           ContentType="application/json", CacheControl="public, max-age=3600")
        print(f"{dt}: done -- {len(index['cases'])} cases, {len(index['skipped'])} skipped, {time.time() - t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
