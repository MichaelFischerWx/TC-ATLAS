#!/usr/bin/env python3
"""Fill the TC-RADAR MergIR IR store (gs://tc-atlas-zarr/<prefix>/mergir) for cases that have no IR yet.

Store layout (written by the original, uncommitted builder; reproduced here and checked against stored cases):
  Tb[case, 9, 550, 550] float32 K (NaN = no data), one chunk per case, Blosc zstd 3
  rows = MergIR native-grid latitudes, south first: the 550 pixels around the native pixel nearest the case's
         original fix (center_lat/lon), same for columns; lat/lon_offsets are the nominal offsets (shared)
  lag_hours 0, 0.5 ... 4: the frame is the MergIR half-hour slot nearest (analysis time - lag)
  ir_datetime[case, 9] = that slot in EPOCH MINUTES (-1 = missing); status[case] = 1 when the case has IR

MergIR comes from NASA GES DISC OPeNDAP (GPM_MERGIR.1), one server-side subset per file (each file = one hour,
two half-hourly grids), authenticated with the urs.earthdata.nasa.gov entry in ~/.netrc. Nothing here writes
~/.netrc (global_archive_api must not be imported on the Mac: its import-time setup overwrites it).

Usage:  python3 bin/build_tcradar_mergir_cases.py [--prefix tc-radar-v4] [--cases 1632,1530] [--check 900]
        --check N re-fetches a case that already has IR and compares it with the store (no writes)
"""
from __future__ import annotations

import argparse
import io
import json
import netrc
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[1]
OPENDAP = "https://disc2.gesdisc.eosdis.nasa.gov/opendap/MERGED_IR/GPM_MERGIR.1"
N = 550
HALF = N // 2
LAGS = [0.5 * k for k in range(9)]
DLAT, DLON = 0.036364, 0.036378           # MergIR native spacing (lat -60..60, lon -180..180)


def session() -> requests.Session:
    login, _, password = netrc.netrc().authenticators("urs.earthdata.nasa.gov")
    s = requests.Session(); s.auth = (login, password)
    return s


def slot(t: datetime) -> datetime:
    """nearest MergIR half-hour slot"""
    m = (t - t.replace(minute=0, second=0, microsecond=0)).total_seconds() / 60.0
    base = t.replace(minute=0, second=0, microsecond=0)
    return base + timedelta(minutes=30 * round(m / 30.0))


def fetch_hour(s: requests.Session, hour: datetime, i_lat: tuple, i_lon: tuple):
    """Both half-hour grids of one MergIR file over [i_lat, i_lon] index ranges -> (Tb[2, ny, nx], lat, lon)."""
    import xarray as xr
    url = (f"{OPENDAP}/{hour.year}/{hour.timetuple().tm_yday:03d}/merg_{hour:%Y%m%d%H}_4km-pixel.nc4.nc4?"
           f"Tb[0:1][{i_lat[0]}:{i_lat[1]}][{i_lon[0]}:{i_lon[1]}],lat[{i_lat[0]}:{i_lat[1]}],lon[{i_lon[0]}:{i_lon[1]}],time")
    for attempt in range(4):
        r = s.get(url, timeout=120)
        if r.status_code == 200 and r.content[:4] == b"\x89HDF":
            ds = xr.open_dataset(io.BytesIO(r.content), engine="h5netcdf")
            return ds["Tb"].values.astype(np.float32), ds["lat"].values, ds["lon"].values
        if r.status_code == 404:
            return None
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"MergIR {hour:%Y-%m-%d %H}Z: HTTP {r.status_code}")


def case_frames(s, t0: datetime, clat: float, clon: float):
    """Tb[9, 550, 550] and ir_datetime (epoch minutes) for one case; NaN / -1 where MergIR has no file."""
    lon = ((clon + 180.0) % 360.0) - 180.0
    ic_lat = int(round((clat + 60.0 - DLAT / 2) / DLAT)); ic_lon = int(round((lon + 180.0 - DLON / 2) / DLON))
    i_lat = (ic_lat - HALF, ic_lat + HALF - 1); i_lon = (ic_lon - HALF, ic_lon + HALF - 1)
    if i_lon[0] < 0 or i_lon[1] > 9895 or i_lat[0] < 0 or i_lat[1] > 3297:
        raise RuntimeError(f"domain crosses the grid edge (lat {clat}, lon {clon}) -- not handled")
    tb = np.full((len(LAGS), N, N), np.nan, np.float32); when = np.full(len(LAGS), -1, np.int64)
    cache = {}
    for k, lag in enumerate(LAGS):
        sl = slot(t0 - timedelta(hours=lag)); hr = sl.replace(minute=0)
        if hr not in cache:
            cache[hr] = fetch_hour(s, hr, i_lat, i_lon)
        got = cache[hr]
        if got is None:
            continue
        T, la, lo = got
        fr = T[0 if sl.minute == 0 else 1]
        if fr.shape != (N, N) or not np.isfinite(fr).any():
            continue
        if la[0] > la[-1]:
            fr = fr[::-1]
        fr = fr.copy(); fr[-1, :] = np.nan        # the original builder left the northernmost row empty (verified on Eta 900)
        tb[k] = fr; when[k] = int(sl.timestamp() // 60)
    return tb, when


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prefix", default="tc-radar-v4")
    ap.add_argument("--cases", default="", help="comma-separated case indices (default: every case with status 0)")
    ap.add_argument("--check", type=int, help="compare a re-fetch of this (already filled) case with the store")
    a = ap.parse_args()
    import gcsfs
    import zarr
    fs = gcsfs.GCSFileSystem()
    store = gcsfs.GCSMap(root=f"tc-atlas-zarr/{a.prefix}/mergir", gcs=fs, check=False)
    g = zarr.open_consolidated(store, mode="r+")
    meta = {c["case_index"]: c for c in json.loads((ROOT / "tc_radar_metadata_v4.json").read_text())["cases"]}
    s = session()

    def t_of(ci):
        return datetime.strptime(meta[ci]["datetime"], "%Y-%m-%d %H:%M UTC").replace(tzinfo=timezone.utc)

    if a.check is not None:
        ci = a.check
        tb, when = case_frames(s, t_of(ci), float(g["center_lat"][ci]), float(g["center_lon"][ci]))
        ref = g["Tb"][ci]; rw = g["ir_datetime"][ci]
        both = np.isfinite(tb) & np.isfinite(ref)
        print(f"case {ci}: ir_datetime built {list(when)} vs stored {list(rw)}")
        print(f"  Tb: {both.sum()} common pixels, max |diff| {np.nanmax(np.abs(tb - ref)[both]) if both.any() else 'n/a'} K, "
              f"NaN masks equal: {bool((np.isfinite(tb) == np.isfinite(ref)).all())}")
        return 0
    status = g["status"][:]
    todo = [int(c) for c in a.cases.split(",") if c] if a.cases else [int(i) for i in np.flatnonzero(status == 0)]
    todo = [c for c in todo if c in meta]
    print(f"{len(todo)} cases to fill", flush=True)
    t0 = time.time(); ok = 0
    for n, ci in enumerate(todo):
        try:
            clat, clon = float(meta[ci]["latitude"]), float(meta[ci]["longitude"])
            tb, when = case_frames(s, t_of(ci), clat, clon)
        except Exception as e:  # noqa: BLE001
            print(f"  case {ci} {meta[ci]['storm_name']} {meta[ci]['datetime']}: FAILED {type(e).__name__}: {e}", flush=True)
            continue
        if not (when >= 0).any():
            print(f"  case {ci}: no MergIR frames", flush=True); continue
        g["Tb"][ci] = tb; g["ir_datetime"][ci] = when
        g["center_lat"][ci] = clat; g["center_lon"][ci] = clon
        g["status"][ci] = 1; ok += 1
        print(f"  case {ci} {meta[ci]['storm_name']} {meta[ci]['datetime']}: {int((when >= 0).sum())}/9 frames "
              f"({n + 1}/{len(todo)}, {time.time() - t0:.0f} s)", flush=True)
    zarr.consolidate_metadata(store)
    print(f"filled {ok}/{len(todo)} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
