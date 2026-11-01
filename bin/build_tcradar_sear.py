#!/usr/bin/env python3
"""Precompute the experimental SEAR 10-m wind for every TC-RADAR explorer case (v3m swath + merge).

Recipe = MLBT realtime/sear_swath.compute_field, i.e. the live Recon-tab TDR swath: the case's own
WCM-recentered earth-relative 500-m and 2-km winds -> realtime/sear_tdr_features -> the swath's SEAR
Stage 2 (sear_swath.swath_model_path(), V2c since 2026-09-29) -> WL150 -> 10 m (interpolated sonde
factor), no estimate inside 0.5 local RMW, 80% band at the peak cell, and the ruling-56 peak term
(sear_swath.peak_multiplier: up to +4.7% near the maximum of fields >= 113 kt with a 2-km RMW < 30 km). Environment = ERA5 850-200 hPa shear
(0-500 km) from the TC-RADAR v4.0 case on the same mission nearest in time (the environment
Stage 2 was trained on). Cases with no v4.0 match are skipped and listed in the index.

NOTE: Stage 2 was trained on dropsondes collocated with these same analyses (all years <= 2024),
so these fields are IN-SAMPLE -- the explorer labels them that way.

Output (one gzip JSON per case, in the /data response shape the explorer already renders):
  tcradar-sear/v3/{swath|merge}/{case_index}.json   {data: [[kt|null]], x, y, units, rmw_km, max_kt, max_band_kt, ...}
  tcradar-sear/v3/{swath|merge}/index.json          {cases: {idx: max_kt}, skipped: {...}, model, generated}
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
import sear_swath  # noqa: E402  (model path / tag -- the live TDR swath's model)
from config import STAGE2_BASE_RMW_FLOOR_KM, TC_RADAR_SWATH_FILE  # noqa: E402
from reduction import wl150_to_10m_factor  # noqa: E402
from sear_tdr_features import tdr_stage2_features  # noqa: E402
from stage1_features import build_case_environment  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
TCR = Path.home() / "Data" / "TDR" / "TCRADAR"
FILES = {("swath", "early"): "tc_radar_v3m_1997_2019_xy_rel_swath_ships.nc",
         ("swath", "recent"): "tc_radar_v3m_2020_2024_xy_rel_swath_ships.nc",
         ("merge", "early"): "tc_radar_v3m_1997_2019_xy_rel_merge_ships.nc",
         ("merge", "recent"): "tc_radar_v3m_2020_2024_xy_rel_merge_ships.nc"}
META = {"swath": REPO / "tc_radar_metadata.json", "merge": REPO / "tc_radar_metadata_merge.json"}
PREFIX = "tcradar-sear/v3"     # v3 = V2c + ruling 56 peak term (2026-11-01); v2 = V2c; v1 = Stage 2 v8 (rollbacks)
OUT = Path(os.environ.get("TCRADAR_SEAR_OUT", Path.home() / "Data" / "tcradar_sear" / PREFIX.split("/")[-1]))
KT = 1.943844
MAX_MATCH_H = 4.0          # v4.0 case on the same mission within this many hours supplies the ERA5 env


def v4_env_table() -> pd.DataFrame:
    ds = xr.open_dataset(TC_RADAR_SWATH_FILE, decode_times=False)
    env = build_case_environment(ds).set_index("case_idx")
    t = pd.DataFrame({"mission": np.char.strip(ds["mission_ID"].values.astype(str)), "t": ds["time"].values.astype(float)})
    t = t.join(env[["era5_shear_mag_850_200_0_500", "era5_shear_dir_850_200_0_500", "era5_rh_low_0_500"]])
    return t.dropna(subset=["era5_shear_mag_850_200_0_500", "era5_shear_dir_850_200_0_500"])


def field(u5, v5, u2, v2, x, y, rmw, lat, env, art):
    """sear_swath.compute_field on an already-recentered grid (center at x=y=0): the same feature builder
    (sear_tdr_features), the same artifact (the live swath model), eye mask, 80% band and WL150 -> 10 m."""
    FT = tdr_stage2_features(u5, v5, u2, v2, x, y, 0.0, 0.0, rmw, lat, env["shear"], env["dir"])
    cols, r, s5 = FT["cols"], FT["r"], FT["s5"]
    missing = [f for f in art["features"] if f not in cols]
    if missing:
        raise RuntimeError(f"Stage 2 artifact needs features sear_tdr_features does not build: {missing}")
    F = pd.DataFrame({f: np.asarray(cols[f], dtype=float).ravel() for f in art["features"]})
    ok = np.isfinite(F.to_numpy(float)).all(1) & (s5.ravel() > 0) & (r.ravel() <= 200)
    eye = art.get("eye_mask_r_over_rmw")
    if eye:                                           # no estimate inside half the local RMW (artifact-declared)
        ok &= np.asarray(cols[art.get("eye_mask_feature", "r_over_rmw_g")], float).ravel() >= float(eye)
    ln_rmw = float(np.log(max(rmw, 2.0)))
    wl, wl_lo, wl_hi = (np.full(r.size, np.nan) for _ in range(3))
    if ok.any():
        base = art.get("base")
        floor = float(base.get("floor_km", STAGE2_BASE_RMW_FLOOR_KM)) if base else STAGE2_BASE_RMW_FLOOR_KM
        b0 = (base["c0"] + base["c1"] * max(ln_rmw, np.log(floor))) if base else 0.0
        s5k = s5.ravel()[ok]
        wl[ok] = (b0 + art["model"].predict(F[ok])) * s5k
        q = art.get("quantiles")
        if q:                                         # 80% band: conformalized 10th/90th-percentile ratio models
            adj = float(art.get("band_adjust_ratio", 0.0))
            wl_lo[ok] = (q["0.1"].predict(F[ok]) - adj) * s5k
            wl_hi[ok] = (q["0.9"].predict(F[ok]) + adj) * s5k
    to10 = lambda w: (wl150_to_10m_factor(w) * w).reshape(r.shape)  # noqa: E731
    w10, lo10, hi10 = to10(wl), to10(wl_lo), to10(wl_hi)
    mult, _ = sear_swath.peak_multiplier(w10, rmw)                 # ruling 56 peak term, as the live swath
    return w10 * mult * KT, lo10 * mult * KT, hi10 * mult * KT, r


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
    art = joblib.load(sear_swath.swath_model_path())
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
            w, w_lo, w_hi, r = field(u5, v5, u2, v2, x, y, rmw, float(m["latitude"]), env, art)
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
                   "max_band_kt": ([int(round(w_lo[k])), int(round(w_hi[k]))]
                                   if np.isfinite(w_lo[k]) and np.isfinite(w_hi[k]) else None),
                   "coverage_r60": round(float(np.isfinite(w[r < 60]).mean()), 2),
                   "env": {"shear_ms": round(env["shear"], 1), "shear_dir": round(env["dir"]), "src": "ERA5 via TC-RADAR v4.0",
                           "match_dt_min": round(float(abs(e.t - tm) / 60))},
                   "model": sear_swath.SWATH_MODEL_TAG, "in_sample": True, "generated": now}
            fp = odir / f"{ci}.json"
            raw = gzip.compress(json.dumps(out, separators=(",", ":"), allow_nan=False).encode(), 9)
            fp.write_bytes(raw)
            index["cases"][str(ci)] = out["max_kt"]; index["skipped"].pop(str(ci), None)
            if cli is not None:
                cli.put_object(Bucket="tc-atlas-rt", Key=f"{PREFIX}/{dt}/{ci}.json", Body=raw, ContentType="application/json",
                               ContentEncoding="gzip", CacheControl="public, max-age=86400")
            if n % 100 == 0:
                print(f"{dt}: {n} cases ({len(index['cases'])} ok, {len(index['skipped'])} skipped) {time.time() - t0:.0f}s", flush=True)
        index.update({"model": sear_swath.SWATH_MODEL_TAG, "generated": now, "units": "kt", "in_sample": True,
                      "note": "SEAR 10-m wind (experimental) from the TDR 500-m wind; Stage 2 trained on sondes collocated with these analyses"})
        idx_p.write_text(json.dumps(index, separators=(",", ":")))
        if cli is not None:
            cli.put_object(Bucket="tc-atlas-rt", Key=f"{PREFIX}/{dt}/index.json", Body=idx_p.read_bytes(),
                           ContentType="application/json", CacheControl="public, max-age=3600")
        print(f"{dt}: done -- {len(index['cases'])} cases, {len(index['skipped'])} skipped, {time.time() - t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
