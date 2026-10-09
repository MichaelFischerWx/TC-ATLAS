"""Ventilation-index → ΔV climatology from ERA5 (ARCO) + IBTrACS + OISST.

Builds the CLIMATOLOGICAL distribution of subsequent 24-h intensity change
(ΔV) as a function of the Tang & Emanuel (2012) ventilation index (VI), so
the RT storm page can show "where does this storm's live VI sit in the
historical ΔV distribution" (Phase 4 of the RT favorability dashboard, see
the project_favorability_vi memory / favorability.py).

Why this is cheap: it reuses `favorability.compute_vi` VERBATIM — the exact
same physics core the realtime /shear endpoint calls. Sharing the function is
not enough on its own: the regions and the SST product are chosen by the
caller, so they must mirror the live /shear path (_compute_gfs_shear +
_attach_ventilation in ir_monitor_api.py) for the two VIs to share a scale.
Environmental inputs come from the public ARCO ERA5 bucket
(`gs://gcp-public-data-arco-era5`, 0.25° hourly) — no CDS queue, anonymous
read. Per fix we sample, with great-circle (haversine) distances and plain
cell means as the live path does:

  * inner disc 0–100 km   → T @600 hPa (s*_m)
  * annulus 100–300 km    → T,q @600 hPa (environmental s_m) and T,q @1000 hPa
    (s_b for the air-sea disequilibrium — the live path's choice since
    2026-07-04; the inner-disc boundary layer inflates χ_m)
  * annulus 200–800 km    → u,v @200/850 hPa → 850–200 shear magnitude
    (SHIPS-style annulus mean; the cheap proxy the realtime VI also uses)

SST is the live card's: NOAA OISST v2.1 daily mean at the nearest 0.25° cell
from the PREVIOUS day (the newest OISST the live path can read at a GFS
cycle), looked up from the local PSL yearly files during `reduce`. χ_m moves
~26% per K of SST through its small denominator (s*_SST − s_b), so the ERA5
SST (HadISST2 before Sep 2007, OSTIA after) would put the climatology on a
different footing; it is kept in the rows as `sst_era5_c` (0–100 km disc)
and `sst_era5_pt_c` (nearest point) for comparison (`reduce --sst era5`).
The rows store the VI inputs rather than the VI, so a later change of SST
or definition is a cheap re-reduce, not a new ERA5 pass.

ERA5 access. The default `raw` source byte-range-reads the ARCO raw per-day
NetCDF-3 files (arco_era5_raw.py): one hour's latitude band of one field is
a single contiguous range, so a fix costs ~1 MB (±3° of latitude for T/q/SST,
±7.5° for the shear winds) and 1991–2025 is ~70 GB. The zarr stores (`wb13`
for 1959–2021, `full37` for 2022+) are kept as options, but their chunk is a
timestep's global all-level column: ~120 MB per timestep, ~5 TB for the
same years. `check` compares the two routes.

Two phases (idempotent, resumable — a multi-hour laptop run survives a crash):

    # 1. expensive: fetch ERA5, sample every fix, append per-fix rows to JSONL
    python build_era5_vi_climo.py sample --years 1991-2025 --workers 16

    # smoke test first (a handful of timesteps, local, no GCS)
    python build_era5_vi_climo.py sample --years 2020 --limit-timesteps 5
    # raw byte-range reader vs the zarr store, a few timesteps
    python build_era5_vi_climo.py check

    # 2. cheap: OISST lookup, VI, bin VI vs ΔV, write the climo JSON
    python build_era5_vi_climo.py reduce                    # local only
    python build_era5_vi_climo.py reduce --upload           # + GCS
    python build_era5_vi_climo.py reduce --sst era5         # ERA5-SST variant

Output: data/seasonal/vi_dv_climo.json (+ gs://${GCS_IR_CACHE_BUCKET}/
        seasonal/vi_dv_climo.json with --upload). The ERA5-SST variant goes
        to data/seasonal/vi_dv_climo_sst-era5.json and is never uploaded.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))
import arco_era5_raw as AR  # noqa: E402
import favorability as F  # the SHARED physics core — do not reimplement  # noqa: E402

log = logging.getLogger("vi_climo")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")

# ── Configuration ────────────────────────────────────────────────────────
# Data sources. raw (default): byte ranges of the per-day NetCDF files, all
# years. wb13 has only 13 pressure levels incl. the 4 we need (600/1000/200/
# 850) → ~2.85× less decompression per timestep than the 37-level store, and
# is 6-hourly native. It covers 1959–2021; use full37 for 2022+ (identical
# ERA5 values at our levels, so passes mix on one scale).
SOURCES = {
    "raw": "gs://" + AR.RAW_ROOT,
    "wb13": "gs://gcp-public-data-arco-era5/ar/1959-2022-wb13-6h-0p25deg-chunk-1.zarr-v2",
    "full37": "gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3",
}
ARCO_URL = os.environ.get("ARCO_ERA5_URL", SOURCES["wb13"])
GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
IBTRACS_NC = REPO / "data" / "_ibtracs_cache" / "IBTrACS.ALL.v04r01.nc"

# v2 rows hold the VI inputs (annulus s_b, lon, ERA5 SST) — a new work dir so
# the v1 rows (finished VI, inner-disc s_b, no lon) are never mixed in.
WORK_DIR = Path(os.environ.get("VI_CLIMO_WORK", "data/seasonal/_vi_climo_work_v2"))
SAMPLES_JSONL = WORK_DIR / "vi_samples.jsonl"      # per-fix rows (resumable)
DONE_FILE = WORK_DIR / "done_timesteps.txt"        # completed timestep keys
OUT_LOCAL = REPO / "data" / "seasonal" / "vi_dv_climo.json"
OUT_LOCAL_ERA5 = OUT_LOCAL.with_name("vi_dv_climo_sst-era5.json")
OUT_GCS_KEY = "seasonal/vi_dv_climo.json"

# OISST v2.1 daily means, PSL yearly files (sst.day.mean.YYYY.nc — the same
# dataset the live /ocean + /shear SST reads over OPeNDAP). Fetch missing years
# from https://downloads.psl.noaa.gov/Datasets/noaa.oisst.v2.highres/
OISST_DIR = Path(os.environ.get("OISST_DIR", str(Path.home() / "Data" / "OISST_daily")))
OISST_LAG_DAYS = 1         # live path reads the newest day: D-1 at most cycles

# Sampling geometry (km) — mirrors the live _compute_gfs_shear regions.
DISC_KM = 100.0            # inner disc: s*_m T
ENV_ANN_KM = (100.0, 300.0)   # environmental annulus: s_m and s_b
SHEAR_ANN_KM = (200.0, 800.0) # SHIPS-style deep-layer shear annulus
MIN_CELLS = 4              # min valid grid cells for a region mean to count
R_EARTH_KM = 6371.0        # as ir_monitor_api._haversine_km
KM_PER_DEG = R_EARTH_KM * math.pi / 180.0
ROW_MARGIN_DEG = 0.3       # extra latitude read beyond a region's reach

# Fields the VI needs: short name → (ARCO variable, level hPa or None for a
# single-level field, farthest distance (km) from the centre that any region
# using it reaches — sets the latitude band the raw route reads).
FIELDS = {
    "T600": ("temperature", 600, ENV_ANN_KM[1]),
    "T1000": ("temperature", 1000, ENV_ANN_KM[1]),
    "q600": ("specific_humidity", 600, ENV_ANN_KM[1]),
    "q1000": ("specific_humidity", 1000, ENV_ANN_KM[1]),
    "sst": ("sea_surface_temperature", None, DISC_KM),
    "u200": ("u_component_of_wind", 200, SHEAR_ANN_KM[1]),
    "v200": ("v_component_of_wind", 200, SHEAR_ANN_KM[1]),
    "u850": ("u_component_of_wind", 850, SHEAR_ANN_KM[1]),
    "v850": ("v_component_of_wind", 850, SHEAR_ANN_KM[1]),
}

# ΔV target + binning
DV_HOURS = 24                       # subsequent intensity change window
SYNOPTIC_HOURS = (0, 6, 12, 18)     # fix hours we sample (SHIPS convention)
MIN_SEASON = 1991                   # ARCO reliable + OISST/ERA5 modern era
# VI bins (log-friendly): storms live mostly in VI ~ 0.002 .. 0.5. The top
# bin is open-ended in `reduce` (VI ≥ 0.4, including the cool-water VI > 1
# cases), so a card lookup clamps any VI to the last bin.
VI_BIN_EDGES = [0.0, 0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.15,
                0.25, 0.4, 1.0]
PCTS = [10, 25, 50, 75, 90]
RI_KT = 30.0                        # ΔV24 ≥ 30 kt = rapid intensification
MIN_BIN_N = 10                      # bins with fewer fixes are null
MIN_QUANTILE_N = 200                # per-basin VI quantiles need this many

# Population: a TC climatology takes only tropical and subtropical stages
# (as the card, which shows systems with NHC/CPHC/JTWC advisories): fixes
# whose usa_status is a TC stage or, with no US status, whose IBTrACS nature
# is TS/SS. Disturbance, extratropical and other stages never enter a bin.
TC_STATUS = {"TD", "TS", "TY", "ST", "TC", "HU", "HR", "SD", "SS"}
TC_NATURE = {"TS", "SS"}

# zarr level indices we need (subset after the chunk lands).
LEVELS_TQ = [600, 1000]
LEVELS_UV = [200, 850]


# ── IBTrACS → per-fix records with ΔV ────────────────────────────────────
def _s(x) -> str:
    return x.decode("ascii", "ignore").strip() if \
        isinstance(x, (bytes, bytearray)) else str(x).strip()


def load_fixes() -> list[dict]:
    """Return synoptic fixes (season ≥ MIN_SEASON) with a finite next-24h ΔV.

    ΔV is matched by ACTUAL time (fix_time + 24 h) within the same storm,
    robust to IBTrACS's 3-hourly cadence and missing off-synoptic winds. Both
    ends of a ΔV come from ONE wind source: usa_wind (1-min, NHC/CPHC/JTWC)
    where it has both, else wmo_wind. Differencing the merged series spliced a
    JTWC 1-min value against an RSMC 10-min one for 3% of fixes (8% in SI/SP).
    Spur tracks (alternative agency segments that duplicate part of a main
    track) are skipped. Each fix keeps its IBTrACS nature, usa_status and
    distance to land; `reduce` applies the stage rule, so changing it needs
    no re-sample."""
    import xarray as xr
    if not IBTRACS_NC.exists():
        raise SystemExit(f"IBTrACS not found: {IBTRACS_NC}")
    ds = xr.open_dataset(IBTRACS_NC)
    sid = ds["sid"].values                         # (storm,) |S13
    season = ds["season"].values.astype("float64")  # (storm,)
    track_type = ds["track_type"].values           # main / PROVISIONAL / spur-*
    # round to the minute: decoded float times can carry µs jitter
    times = (ds["time"].values + np.timedelta64(30, "s")).astype("datetime64[m]")
    lat = ds["lat"].values.astype("float64")       # global spline position
    lon = ds["lon"].values.astype("float64")
    basin = ds["basin"].values                     # (storm, dt) |S2
    nature = ds["nature"].values                   # TS/SS/ET/DS/MX/NR
    status = ds["usa_status"].values               # TD/TS/HU/TY/EX/DB/...
    d2l = ds["dist2land"].values.astype("float64")  # km
    winds = {"usa": ds["usa_wind"].values.astype("float64"),
             "wmo": ds["wmo_wind"].values.astype("float64")}
    ds.close()

    fixes: list[dict] = []
    dv_delta = np.timedelta64(DV_HOURS, "h")
    tol = np.timedelta64(90, "m")   # allow ±90 min when matching t+24h
    syn_min = {h * 60 for h in SYNOPTIC_HOURS}
    n_spur = 0
    for s in range(season.size):
        if not (season[s] >= MIN_SEASON):
            continue
        if _s(track_type[s]).startswith("spur"):
            n_spur += 1
            continue
        t_row = times[s]
        pos_ok = ~np.isnat(t_row) & np.isfinite(lat[s]) & np.isfinite(lon[s])
        src_idx = {k: np.where(pos_ok & np.isfinite(w[s]))[0]
                   for k, w in winds.items()}
        for j in np.where(pos_ok)[0]:
            tt = t_row[j]
            if int(tt.astype("int64")) % 1440 not in syn_min:
                continue
            target = tt + dv_delta
            for src in ("usa", "wmo"):
                w_row, idx = winds[src][s], src_idx[src]
                if not np.isfinite(w_row[j]) or idx.size < 2:
                    continue
                d = np.abs(t_row[idx] - target)   # nearest fix to tt + 24 h
                m = int(np.argmin(d))
                if d[m] > tol:
                    continue
                k = int(idx[m])
                fixes.append({
                    "sid": _s(sid[s]),
                    "t": str(tt.astype("datetime64[s]")),   # ISO, hour-aligned
                    "lat": round(float(lat[s, j]), 3),
                    "lon": round(float(lon[s, j]), 3),
                    "vmax": round(float(w_row[j]), 1),
                    "dv24": round(float(w_row[k] - w_row[j]), 1),
                    "wsrc": src,
                    "basin": _s(basin[s, j]),
                    "nature": _s(nature[s, j]),
                    "status": _s(status[s, j]),
                    "d2l": None if not np.isfinite(d2l[s, j]) else int(d2l[s, j]),
                    "d2l24": None if not np.isfinite(d2l[s, k]) else int(d2l[s, k]),
                })
                break
    log.info("IBTrACS: %d synoptic fixes with finite ΔV%dh (season≥%d; "
             "%d spur tracks skipped)", len(fixes), DV_HOURS, MIN_SEASON, n_spur)
    return fixes


# ── ARCO ERA5 access ─────────────────────────────────────────────────────
# A sampled field is a list of latitude bands [(r0, array)], row r0 of the
# array being ERA5 row r0 (AR.ERA_LAT). The zarr route has one band, the
# whole globe; the raw route one band per cluster of fixes.
#
# zarr: workers are separate PROCESSES (decompression is CPU/GIL-bound, so
# threads don't scale). Each process opens the zarr once, lazily. The source
# URL is injected by the pool initializer because spawn-started children
# re-import this module with the default ARCO_URL.
_tls = threading.local()
_WORKER_URL = ARCO_URL


def _init_worker(url: str) -> None:
    global _WORKER_URL
    _WORKER_URL = url


def _get_ds():
    ds = getattr(_tls, "ds", None)
    if ds is None or getattr(_tls, "url", None) != _WORKER_URL:
        import xarray as xr
        ds = xr.open_zarr(_WORKER_URL, chunks=None,
                          storage_options={"token": "anon"})
        if not (np.allclose(ds.latitude.values, AR.ERA_LAT)
                and np.allclose(ds.longitude.values, AR.ERA_LON)):
            raise ValueError(f"{_WORKER_URL}: grid is not the ERA5 0.25° grid")
        _tls.ds, _tls.url = ds, _WORKER_URL
    return ds


def fetch_timestep(iso_time: str) -> dict:
    """zarr route: the global fields for one timestep. Each variable
    triggers exactly one (all-level) chunk read; we subset levels after."""
    ds = _get_ds()
    t = np.datetime64(iso_time)
    T = ds["temperature"].sel(time=t, level=LEVELS_TQ).values      # (2,721,1440)
    q = ds["specific_humidity"].sel(time=t, level=LEVELS_TQ).values
    u = ds["u_component_of_wind"].sel(time=t, level=LEVELS_UV).values
    v = ds["v_component_of_wind"].sel(time=t, level=LEVELS_UV).values
    sst = ds["sea_surface_temperature"].sel(time=t).values         # (721,1440)
    i600, i1000 = LEVELS_TQ.index(600), LEVELS_TQ.index(1000)
    i200, i850 = LEVELS_UV.index(200), LEVELS_UV.index(850)
    full = {
        "T600": T[i600], "T1000": T[i1000],
        "q600": q[i600], "q1000": q[i1000],
        "u200": u[i200], "v200": v[i200],
        "u850": u[i850], "v850": v[i850],
        "sst": sst,
    }
    return {k: [(0, a.astype(np.float64))] for k, a in full.items()}


_fs_lock = threading.Lock()
_fs = None


def _raw_fs():
    """Shared anonymous gcsfs handle. Each range is ≤ ~0.4 MB, so a socket
    that stalls is dropped after 20 s and gcsfs retries it (aiohttp's default
    is a 300 s total timeout, which left whole days waiting on one hung read)."""
    global _fs
    with _fs_lock:
        if _fs is None:
            import aiohttp
            import gcsfs
            _fs = gcsfs.GCSFileSystem(
                token="anon", requests_timeout=aiohttp.ClientTimeout(
                    total=120, sock_connect=15, sock_read=20))
        return _fs


def _band_rows(lat0: float, reach_km: float) -> tuple[int, int]:
    """Inclusive ERA5 row range holding every cell within reach_km of a fix
    at latitude lat0, plus ROW_MARGIN_DEG."""
    half = reach_km / KM_PER_DEG + ROW_MARGIN_DEG
    r0 = int(math.floor((90.0 - (lat0 + half)) / 0.25))
    r1 = int(math.ceil((90.0 - (lat0 - half)) / 0.25))
    return max(r0, 0), min(r1, AR.ERA_LAT.size - 1)


def _merge(intervals) -> list[tuple[int, int]]:
    out: list[list[int]] = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def fetch_day_raw(day: str, ts_fixes: dict[str, list[dict]]) -> dict:
    """raw route: every band the day's fixes need, in two GCS round trips
    → {timestep: {short: [(r0, array), ...]}}. Fixes at overlapping
    latitudes share one band per field."""
    reqs = []
    for ts, fl in ts_fixes.items():
        hour = int(ts[11:13])
        for short, (var, lev, reach) in FIELDS.items():
            for r0, r1 in _merge(_band_rows(f["lat"], reach) for f in fl):
                reqs.append(((ts, short, r0), var, lev, hour, r0, r1))
    got = AR.fetch_bands(_raw_fs(), day, reqs)
    out = {ts: {short: [] for short in FIELDS} for ts in ts_fixes}
    for (ts, short, r0), arr in got.items():
        out[ts][short].append((r0, arr))
    return out


# ── Per-fix sampling (shared by both routes) ─────────────────────────────
def _haversine_km(lat0: float, lon0: float, lat, lon):
    """Great-circle distance (km), as ir_monitor_api._haversine_km."""
    p0, p = np.radians(lat0), np.radians(lat)
    dphi = p - p0
    dlam = np.radians(((lon - lon0 + 180.0) % 360.0) - 180.0)
    a = np.sin(dphi / 2) ** 2 + np.cos(p0) * np.cos(p) * np.sin(dlam / 2) ** 2
    return 2 * R_EARTH_KM * np.arcsin(np.minimum(np.sqrt(a), 1.0))


def _region_masks(lat0: float, lon0: float):
    """Return (row_slice, disc, env_ann, shear_ann): boolean masks on the
    ERA5 rows within reach of the shear annulus, by great-circle distance
    (the live _compute_gfs_shear geometry). Longitude wrap is modular."""
    r0, r1 = _band_rows(lat0, SHEAR_ANN_KM[1])
    rows = slice(r0, r1 + 1)
    dist = _haversine_km(lat0, lon0 % 360.0, AR.ERA_LAT[rows][:, None],
                         AR.ERA_LON[None, :])
    disc = dist <= DISC_KM
    env = (dist >= ENV_ANN_KM[0]) & (dist <= ENV_ANN_KM[1])
    shr = (dist >= SHEAR_ANN_KM[0]) & (dist <= SHEAR_ANN_KM[1])
    return rows, disc, env, shr


def _mean(bands: list, rows: slice, mask: np.ndarray) -> float | None:
    """Plain mean of a field over a region mask (mask rows = `rows`)."""
    hit = np.flatnonzero(mask.any(axis=1))
    if hit.size == 0:
        return None
    a, b = rows.start + int(hit[0]), rows.start + int(hit[-1])
    for r0, arr in bands:
        if r0 <= a and b < r0 + arr.shape[0]:
            sub = arr[a - r0:b + 1 - r0][mask[hit[0]:hit[-1] + 1]]
            break
    else:
        raise ValueError(f"no band covers ERA5 rows {a}..{b}")
    good = np.isfinite(sub)
    if int(good.sum()) < MIN_CELLS:
        return None
    return float(sub[good].mean())


def _nearest(bands: list, lat0: float, lon0: float) -> float | None:
    """Field value at the nearest ERA5 grid point (None if NaN)."""
    i = int(round((90.0 - lat0) / 0.25))
    j = int(round((lon0 % 360.0) / 0.25)) % AR.ERA_LON.size
    for r0, arr in bands:
        if r0 <= i < r0 + arr.shape[0]:
            v = float(arr[i - r0, j])
            return v if np.isfinite(v) else None
    raise ValueError(f"no band covers ERA5 row {i}")


def sample_fix(fields: dict, lat0: float, lon0: float) -> dict | None:
    """Sample the disc/annulus means compute_vi needs (VI itself is formed in
    `reduce`, once the SST product is chosen). ERA5 SST may be None (land or
    coast); only missing atmosphere drops the fix."""
    rows, disc, env, shr = _region_masks(lat0, lon0)
    t_b = _mean(fields["T1000"], rows, env)       # annulus, as the live path
    q_b = _mean(fields["q1000"], rows, env)
    t_m_sat = _mean(fields["T600"], rows, disc)
    t_m_env = _mean(fields["T600"], rows, env)
    q_m_env = _mean(fields["q600"], rows, env)
    u2 = _mean(fields["u200"], rows, shr); v2 = _mean(fields["v200"], rows, shr)
    u8 = _mean(fields["u850"], rows, shr); v8 = _mean(fields["v850"], rows, shr)
    if None in (t_b, q_b, t_m_sat, t_m_env, q_m_env, u2, v2, u8, v8):
        return None
    sst_k = _mean(fields["sst"], rows, disc)      # NaN over land → None
    sst_pt = _nearest(fields["sst"], lat0, lon0)
    shear_ms = math.hypot(u2 - u8, v2 - v8)
    return {"shear_kt": round(shear_ms / F.KT_TO_MS, 2),
            "t_b_k": round(t_b, 3), "q_b": round(q_b, 7),
            "t_m_env_k": round(t_m_env, 3), "q_m_env": round(q_m_env, 7),
            "t_m_sat_k": round(t_m_sat, 3),
            "sst_era5_c": None if sst_k is None else round(sst_k - 273.15, 3),
            "sst_era5_pt_c": None if sst_pt is None else round(sst_pt - 273.15, 3)}


# ── Phase 1: sample ──────────────────────────────────────────────────────
_write_lock = threading.Lock()


def _load_done() -> set[str]:
    if DONE_FILE.exists():
        return set(DONE_FILE.read_text().split())
    return set()


def _rows_for(fields: dict, fixes: list[dict]) -> list[dict]:
    out = []
    for fx in fixes:
        inp = sample_fix(fields, fx["lat"], fx["lon"])
        if inp is not None:
            out.append({**inp, **fx})
    return out


def process_timestep(iso_time: str, fixes: list[dict]) -> list[dict]:
    """zarr route, one timestep (runs in a worker process)."""
    return _rows_for(fetch_timestep(iso_time), fixes)


def process_day_raw(day: str, ts_fixes: dict[str, list[dict]]) -> dict:
    """raw route, one UTC day (runs in a worker thread) → {timestep: rows}.
    Retries transient GCS errors; a layout error (ValueError) is final."""
    for attempt in range(4):
        try:
            bands = fetch_day_raw(day, ts_fixes)
            break
        except ValueError:
            raise
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 + 3 * attempt)
    return {ts: _rows_for(bands[ts], fl) for ts, fl in ts_fixes.items()}


def phase_sample(year_lo: int, year_hi: int, workers: int,
                 limit_timesteps: int | None, source: str) -> None:
    from concurrent.futures import (ProcessPoolExecutor, ThreadPoolExecutor,
                                    as_completed)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    fixes = [f for f in load_fixes()
             if year_lo <= int(f["t"][:4]) <= year_hi]
    # group by timestep
    by_ts: dict[str, list[dict]] = {}
    for f in fixes:
        by_ts.setdefault(f["t"], []).append(f)
    done = _load_done()
    todo = sorted(k for k in by_ts if k not in done)
    if limit_timesteps:
        todo = todo[:limit_timesteps]
    url = SOURCES[source]
    if source == "raw":
        # one task per UTC day: the raw files are per day, so a day's
        # timesteps share the header reads
        jobs: dict[str, dict[str, list[dict]]] = {}
        for ts in todo:
            jobs.setdefault(ts[:10], {})[ts] = by_ts[ts]
        pool = ThreadPoolExecutor(max_workers=workers)
        submit = lambda key: pool.submit(process_day_raw, key, jobs[key])
        unit = "days"
    else:
        jobs = {ts: by_ts[ts] for ts in todo}
        pool = ProcessPoolExecutor(max_workers=workers,
                                   initializer=_init_worker, initargs=(url,))
        submit = lambda key: pool.submit(process_timestep, key, jobs[key])
        unit = "timesteps"
    log.info("sample: %d timesteps (%d %s) to fetch (%d already done), "
             "%d workers, %s", len(todo), len(jobs), unit, len(done), workers,
             url.split("/")[-1])
    n_rows = n_fail = 0
    t0 = time.time()
    with open(SAMPLES_JSONL, "a") as fh, pool:
        futs = {submit(key): key for key in jobs}
        for i, fut in enumerate(as_completed(futs), 1):
            key = futs[fut]
            try:
                res = fut.result()
            except Exception as e:
                n_fail += 1
                log.warning("%s FAILED: %s", key, e)
                continue
            res = res if isinstance(res, dict) else {key: res}
            with _write_lock:
                for rows in res.values():
                    for r in rows:
                        fh.write(json.dumps(r, separators=(",", ":")) + "\n")
                fh.flush()
                with open(DONE_FILE, "a") as df:
                    df.write("".join(ts + "\n" for ts in res))
            n_rows += sum(len(rows) for rows in res.values())
            if i % 100 == 0 or i == len(jobs):
                el = time.time() - t0
                log.info("  %d/%d %s  (%d rows, %d failed)  %.0f s, ETA %.0f min",
                         i, len(jobs), unit, n_rows, n_fail, el,
                         el / i * (len(jobs) - i) / 60)
    log.info("sample done: +%d rows → %s (%d %s failed; re-run to retry)",
             n_rows, SAMPLES_JSONL, n_fail, unit)


# |raw − zarr| allowed per field family. Both routes decode the same packed
# ERA5 values, so they agree to float32 rounding (~3e-5 K) — except where
# ARCO re-ingested a day as final ERA5 after the zarr was written (late-2025
# u-wind: one packing step, ~0.009 m/s). A row or hour misalignment shows
# up as 0.1–1 K or m/s and ~1e-4 kg/kg, far above these.
CHECK_TOL = {"T": 0.01, "q": 1e-6, "u": 0.02, "v": 0.02, "s": 0.01}


def phase_check(timesteps: list[str]) -> None:
    """Validate the raw byte-range route against the zarr store: every
    field's bands and every fix's sampled inputs, per timestep (wb13 through
    2021, full37 after)."""
    by_ts: dict[str, list[dict]] = {}
    for f in load_fixes():
        by_ts.setdefault(f["t"], []).append(f)
    if not timesteps:
        # a busy timestep per decade, plus one from 2022+ (the full37 store)
        busy = sorted(by_ts, key=lambda t: -len(by_ts[t]))
        picks = [lambda t, d=d: t[:3] == d for d in ("199", "200", "201")]
        picks.append(lambda t: t[:4] >= "2022")
        timesteps = sorted({next(t for t in busy if p(t)) for p in picks})
    bad = []
    for ts in timesteps:
        fl = by_ts.get(ts)
        if not fl:
            raise SystemExit(f"{ts}: no fixes at this timestep")
        _init_worker(SOURCES["wb13" if ts[:4] <= "2021" else "full37"])
        z = fetch_timestep(ts)
        r = fetch_day_raw(ts[:10], {ts: fl})[ts]
        diffs = {}
        for short in FIELDS:
            zz = z[short][0][1]
            d = 0.0
            for r0, arr in r[short]:
                ref = zz[r0:r0 + arr.shape[0]]
                if not np.array_equal(np.isnan(ref), np.isnan(arr)):
                    raise SystemExit(f"{ts} {short}: NaN masks differ")
                d = max(d, float(np.nanmax(np.abs(ref - arr))))
            diffs[short] = d
        inp = 0.0
        for fx in fl:
            a, b = (sample_fix(z, fx["lat"], fx["lon"]),
                    sample_fix(r, fx["lat"], fx["lon"]))
            if (a is None) != (b is None):
                raise SystemExit(f"{ts} {fx['sid']}: sampled on one route only")
            for k in (a or {}):
                if (a[k] is None) != (b[k] is None):
                    raise SystemExit(f"{ts} {fx['sid']} {k}: None on one route")
                if a[k] is not None:
                    inp = max(inp, abs(a[k] - b[k]))
        bad += [f"{ts} {k} {v:.2g}" for k, v in diffs.items()
                if v > CHECK_TOL[k[0]]]
        log.info("check %s (%s, %d fixes): max |raw − zarr| %s; sampled "
                 "inputs differ by ≤ %.2g", ts, _WORKER_URL.split("/")[-1],
                 len(fl), ", ".join(f"{k} {v:.1e}" for k, v in diffs.items()),
                 inp)
    if bad:
        raise SystemExit("raw route disagrees with zarr: " + "; ".join(bad))
    log.info("check OK: raw byte-range route matches zarr within %s", CHECK_TOL)


# ── Phase 2: reduce ──────────────────────────────────────────────────────
def _bin_stats(dv: np.ndarray) -> dict:
    return {"n": int(dv.size),
            "mean": round(float(dv.mean()), 2),
            "std": round(float(dv.std()), 2),
            "pct": {str(p): round(float(np.percentile(dv, p)), 1)
                    for p in PCTS},
            "p_ri": round(float((dv >= RI_KT).mean()), 4)}


def oisst_lookup(rows: list[dict]) -> np.ndarray:
    """OISST v2.1 daily mean (°C) at each fix's nearest 0.25° cell, from day
    D − OISST_LAG_DAYS, indexed exactly as ir_monitor_api._fetch_oisst_psl_row.
    NaN over land/ice or when the year file is missing. One year in memory at
    a time (the PSL files are chunked 92 days deep, so per-day reads are slow)."""
    import xarray as xr
    lag = np.timedelta64(OISST_LAG_DAYS, "D")
    by_year: dict[int, list[tuple[int, np.datetime64]]] = {}
    for i, r in enumerate(rows):
        d = np.datetime64(r["t"][:10]) - lag
        by_year.setdefault(int(str(d)[:4]), []).append((i, d))
    out = np.full(len(rows), np.nan)
    for yr, items in sorted(by_year.items()):
        f = OISST_DIR / f"sst.day.mean.{yr}.nc"
        if not f.exists():
            log.warning("OISST %s missing — %d fixes dropped", f, len(items))
            continue
        with xr.open_dataset(f) as ds:
            day_idx = {d: k for k, d in
                       enumerate(ds["time"].values.astype("datetime64[D]"))}
            sst = ds["sst"].values                     # (day, 720, 1440) °C
        n_miss = 0
        for i, d in items:
            k = day_idx.get(d)
            if k is None:
                n_miss += 1
                continue
            lat, lon = rows[i]["lat"], rows[i]["lon"]
            ilat = min(719, max(0, int(round((lat + 89.875) / 0.25))))
            ilon = int(round(((lon % 360.0) - 0.125) / 0.25)) % 1440
            out[i] = sst[k, ilat, ilon]
        del sst
        if n_miss:
            log.warning("  OISST %d: %d fixes fall on days the file lacks",
                        yr, n_miss)
    return out


def is_tc_stage(r: dict) -> bool:
    """Tropical or subtropical stage (see TC_STATUS / TC_NATURE)."""
    st = r.get("status") or ""
    return st in TC_STATUS if st else (r.get("nature") in TC_NATURE)


def vi_for_rows(rows: list[dict], sst_source: str) -> tuple[np.ndarray, np.ndarray]:
    """(VI, SST °C) per row with the chosen SST; NaN where either is missing."""
    sst = (oisst_lookup(rows) if sst_source == "oisst"
           else np.array([np.nan if r["sst_era5_c"] is None else r["sst_era5_c"]
                          for r in rows], dtype=float))
    vi = np.full(len(rows), np.nan)
    for i, (r, s) in enumerate(zip(rows, sst)):
        if not np.isfinite(s):
            continue
        v = F.compute_vi(shear_kt=r["shear_kt"], t_b_k=r["t_b_k"], q_b=r["q_b"],
                         t_m_env_k=r["t_m_env_k"], q_m_env=r["q_m_env"],
                         t_m_sat_k=r["t_m_sat_k"], sst_c=float(s))
        if v is not None:
            vi[i] = v["vi"]
    return vi, sst


def load_rows() -> list[dict]:
    if not SAMPLES_JSONL.exists():
        raise SystemExit(f"no samples at {SAMPLES_JSONL}; run `sample` first")
    with open(SAMPLES_JSONL) as fh:
        rows = [json.loads(line) for line in fh]
    if rows and ("t_b_k" not in rows[0] or "status" not in rows[0]):
        raise SystemExit(f"{SAMPLES_JSONL} holds rows from an older builder "
                         "(no VI inputs or no IBTrACS stage); re-run `sample` "
                         "into a fresh work dir")
    kept = [r for r in rows if is_tc_stage(r)]
    log.info("reduce: %d sampled fixes, %d at tropical/subtropical stages",
             len(rows), len(kept))
    return kept


def bin_index(vi: np.ndarray) -> np.ndarray:
    """VI bin per value; the top bin is open-ended (VI ≥ its lower edge)."""
    nb = len(VI_BIN_EDGES) - 1
    return np.clip(np.searchsorted(VI_BIN_EDGES, vi, side="right") - 1, 0, nb - 1)


def phase_reduce(upload: bool, sst_source: str = "oisst") -> None:
    if upload and sst_source != "oisst":
        raise SystemExit("only the OISST build is the card's climatology; "
                         "the ERA5-SST variant stays local")
    rows = load_rows()
    vi_all, _ = vi_for_rows(rows, sst_source)
    ok = np.isfinite(vi_all)
    vi = vi_all[ok]
    sub = [r for r, k in zip(rows, ok) if k]
    dv = np.array([r["dv24"] for r in sub], dtype=float)
    basin = np.array([r["basin"] for r in sub])
    sids = np.array([r["sid"] for r in sub])
    years = sorted({int(r["t"][:4]) for r in sub})
    log.info("reduce: %d of %d fixes have a VI (SST: %s)",
             vi.size, len(rows), sst_source)

    edges = VI_BIN_EDGES
    nb = len(edges) - 1
    centers = [round((edges[i] + edges[i + 1]) / 2, 4) for i in range(nb)]
    k_bin = bin_index(vi)
    qpct = list(range(101))

    def binned(mask: np.ndarray) -> list[dict | None]:
        out = []
        for i in range(nb):
            d = dv[mask & (k_bin == i)]
            out.append(_bin_stats(d) if d.size >= MIN_BIN_N else None)
        return out

    def quantiles(mask: np.ndarray) -> list[float]:
        return [round(float(x), 5) for x in np.percentile(vi[mask], qpct)]

    all_mask = np.ones(vi.size, bool)
    basins = [b for b in sorted(set(basin.tolist())) if b]
    result = {
        "_about": ("Climatological next-%dh intensity change (ΔV, kt) vs the "
                   "Tang & Emanuel ventilation index. VI from "
                   "favorability.compute_vi with the realtime /shear regions "
                   "(s*_m: 600 hPa, 0-100 km disc; s_m and s_b: 600/1000 hPa, "
                   "100-300 km annulus; 850-200 hPa shear of 200-800 km "
                   "annulus means) from ARCO ERA5 and the SST below; ΔV from "
                   "IBTrACS (one wind source per pair). Bins are [edge_i, "
                   "edge_i+1); the top bin is open-ended (VI >= %g, incl. VI > "
                   "1), so a live VI clamps to the last bin; a bin with fewer "
                   "than %d fixes is null. p_ri = fraction with ΔV >= %g kt. "
                   "Percentile of a live VI: interpolate vi_quantiles (VI at "
                   "percentiles 0..100)." % (DV_HOURS, edges[-2], MIN_BIN_N, RI_KT)),
        "source": "ERA5 (ARCO gcp-public-data-arco-era5) + IBTrACS.ALL.v04r01",
        "sst": ("OISST v2.1 daily mean, nearest 0.25° cell, day D-%d "
                "(live-card convention)" % OISST_LAG_DAYS
                if sst_source == "oisst" else "ERA5 SST, 0-100 km disc mean"),
        "s_b_region_km": list(ENV_ANN_KM),
        "population": ("tropical/subtropical stages (usa_status %s; nature "
                       "TS/SS where no US status)" % "/".join(sorted(TC_STATUS))),
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "n_fixes": int(vi.size),
        "n_storms": int(np.unique(sids).size),
        "n_by_basin": {b: int((basin == b).sum()) for b in basins},
        "years": [years[0], years[-1]] if years else None,
        "min_season": MIN_SEASON,
        "dv_hours": DV_HOURS,
        "vi_bin_edges": edges,
        "vi_bin_centers": centers,
        "top_bin_open_ended": True,
        "percentiles": PCTS,
        "ri_kt": RI_KT,
        "vi_quantile_pcts": qpct,
        "vi_quantiles": {"global": quantiles(all_mask), "by_basin": {
            b: quantiles(basin == b) for b in basins
            if (basin == b).sum() >= MIN_QUANTILE_N}},
        "global": binned(all_mask),
        "by_basin": {b: binned(basin == b) for b in basins},
    }
    _log_table("global", result["global"])

    out = OUT_LOCAL if sst_source == "oisst" else OUT_LOCAL_ERA5
    out.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(result, separators=(",", ":")).encode()
    out.write_bytes(body)
    log.info("wrote %s (%d bytes)", out, len(body))
    if not upload:
        return
    from google.cloud import storage  # type: ignore
    blob = storage.Client().bucket(GCS_BUCKET).blob(OUT_GCS_KEY)
    blob.cache_control = "public, max-age=86400"
    blob.upload_from_string(body, content_type="application/json")
    try:
        blob.make_public()
    except Exception as e:
        log.warning("could not make public: %s", e)
    log.info("uploaded gs://%s/%s", GCS_BUCKET, OUT_GCS_KEY)


def _log_table(name: str, bins: list) -> None:
    log.info("%s: VI bin           n    mean   p10   p50   p90   P(RI)", name)
    for i, b in enumerate(bins):
        lo, hi = VI_BIN_EDGES[i], VI_BIN_EDGES[i + 1]
        lab = f"[{lo:g}, {hi:g})" if i < len(bins) - 1 else f"≥ {lo:g}"
        if b is None:
            log.info("  %-14s %6s", lab, "—")
            continue
        log.info("  %-14s %6d  %+5.1f %+5.0f %+5.0f %+5.0f  %5.1f%%", lab,
                 b["n"], b["mean"], b["pct"]["10"], b["pct"]["50"],
                 b["pct"]["90"], 100 * b["p_ri"])


# ── CLI ──────────────────────────────────────────────────────────────────
def _parse_years(s: str) -> tuple[int, int]:
    if "-" in s:
        a, b = s.split("-"); return int(a), int(b)
    return int(s), int(s)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="phase", required=True)
    ps = sub.add_parser("sample", help="fetch ERA5 + sample fixes → JSONL")
    ps.add_argument("--years", required=True, help="YYYY or YYYY-YYYY")
    ps.add_argument("--workers", type=int, default=12,
                    help="raw: threads (I/O bound, 12-16); zarr: processes "
                         "(≈ physical cores). Default 12")
    ps.add_argument("--source", choices=list(SOURCES), default="raw",
                    help="raw (byte ranges of the per-day files, default), "
                         "wb13 (zarr, 1959–2021) or full37 (zarr, 2022+)")
    ps.add_argument("--limit-timesteps", type=int, default=None,
                    help="smoke test: only the first N timesteps")
    pc = sub.add_parser("check", help="raw byte-range route vs zarr")
    pc.add_argument("--timesteps", nargs="*", default=[],
                    help="ISO timesteps (default: a busy one per decade + 2022+)")
    pr = sub.add_parser("reduce", help="bin VI vs ΔV → JSON (local; "
                                       "--upload for GCS)")
    pr.add_argument("--upload", action="store_true",
                    help="also upload the OISST JSON to GCS")
    pr.add_argument("--local-only", action="store_true",
                    help="no-op, kept for old command lines (local is the default)")
    pr.add_argument("--sst", choices=("oisst", "era5"), default="oisst",
                    help="oisst (live-card SST, default) or era5 (comparison)")
    args = ap.parse_args()

    if args.phase == "sample":
        lo, hi = _parse_years(args.years)
        phase_sample(lo, hi, args.workers, args.limit_timesteps, args.source)
    elif args.phase == "check":
        phase_check(args.timesteps)
    else:
        phase_reduce(args.upload and not args.local_only, args.sst)


if __name__ == "__main__":
    main()
