"""Ventilation-index → ΔV climatology from ERA5 (ARCO) + IBTrACS.

Builds the CLIMATOLOGICAL distribution of subsequent 24-h intensity change
(ΔV) as a function of the Tang & Emanuel (2012) ventilation index (VI), so
the RT storm page can show "where does this storm's live VI sit in the
historical ΔV distribution" (Phase 4 of the RT favorability dashboard, see
the project_favorability_vi memory / favorability.py).

Why this is cheap: it reuses `favorability.compute_vi` VERBATIM — the exact
same physics core the realtime /shear endpoint calls — so the historical VI
and the live VI are on an identical scale. Environmental inputs come from the
public analysis-ready ERA5 zarr (ARCO, `gs://gcp-public-data-arco-era5`, 0.25°
hourly, all 37 levels) — no CDS queue, anonymous read. Per fix we sample:

  * inner disc 0–100 km   → T,q @1000 hPa (boundary), T @600 hPa (s*_m), SST
  * annulus 100–300 km    → T,q @600 hPa (environmental s_m)
  * annulus 200–800 km    → u,v @200/850 hPa → 850–200 shear magnitude
    (SHIPS-style annulus mean; the cheap proxy the realtime VI also uses)

ARCO chunking is (time=1, level=37, lat=721, lon=1440): one chunk = one
timestep's full global column. So we fetch each unique synoptic timestep ONCE
and sample every storm fix alive at that time — the access pattern the store
is built for.

Two phases (idempotent, resumable — a multi-hour laptop run survives a crash):

    # 1. expensive: fetch ERA5, sample every fix, append per-fix rows to JSONL
    python build_era5_vi_climo.py sample --years 1991-2025 --workers 16

    # smoke test first (a handful of timesteps, local, no GCS)
    python build_era5_vi_climo.py sample --years 2020 --limit-timesteps 5

    # 2. cheap: bin VI vs ΔV, write the climo JSON, upload to GCS
    python build_era5_vi_climo.py reduce
    python build_era5_vi_climo.py reduce --local-only    # skip upload

Output: gs://${GCS_IR_CACHE_BUCKET}/seasonal/vi_dv_climo.json
        (+ local data/seasonal/vi_dv_climo.json)
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

REPO = Path(__file__).parent
sys.path.insert(0, str(REPO))
import favorability as F  # the SHARED physics core — do not reimplement  # noqa: E402

log = logging.getLogger("vi_climo")
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")

# ── Configuration ────────────────────────────────────────────────────────
# Data sources. wb13 (default) has only 13 pressure levels incl. the 4 we
# need (600/1000/200/850) → ~2.85× less decompression per timestep than the
# 37-level store, and is 6-hourly native. It covers 1959–2021; use full37 for
# 2022+ (identical ERA5 values at our levels, so passes mix on one scale).
SOURCES = {
    "wb13": "gs://gcp-public-data-arco-era5/ar/1959-2022-wb13-6h-0p25deg-chunk-1.zarr-v2",
    "full37": "gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3",
}
ARCO_URL = os.environ.get("ARCO_ERA5_URL", SOURCES["wb13"])
GCS_BUCKET = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
IBTRACS_NC = REPO / "data" / "_ibtracs_cache" / "IBTrACS.ALL.v04r01.nc"

WORK_DIR = Path(os.environ.get("VI_CLIMO_WORK", "data/seasonal/_vi_climo_work"))
SAMPLES_JSONL = WORK_DIR / "vi_samples.jsonl"      # per-fix rows (resumable)
DONE_FILE = WORK_DIR / "done_timesteps.txt"        # completed timestep keys
OUT_LOCAL = REPO / "data" / "seasonal" / "vi_dv_climo.json"
OUT_GCS_KEY = "seasonal/vi_dv_climo.json"

# Sampling geometry (km) — mirrors favorability.chi_m's regions.
DISC_KM = 100.0            # inner disc: boundary T/q, s*_m T, SST
ENV_ANN_KM = (100.0, 300.0)   # environmental s_m annulus
SHEAR_ANN_KM = (200.0, 800.0) # SHIPS-style deep-layer shear annulus
LAT_BAND_DEG = 8.0         # bbox half-height for the per-fix distance mask
MIN_CELLS = 4              # min valid grid cells for a region mean to count
DEG_KM = 111.32

# ΔV target + binning
DV_HOURS = 24                       # subsequent intensity change window
SYNOPTIC_HOURS = (0, 6, 12, 18)     # fix hours we sample (SHIPS convention)
MIN_SEASON = 1991                   # ARCO reliable + OISST/ERA5 modern era
# VI bins (log-friendly): storms live mostly in VI ~ 0.002 .. 0.5
VI_BIN_EDGES = [0.0, 0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.15,
                0.25, 0.4, 1.0]
PCTS = [10, 25, 50, 75, 90]

# ARCO level indices we need (subset after the chunk lands).
LEVELS_TQ = [600, 1000]
LEVELS_UV = [200, 850]


# ── IBTrACS → per-fix records with ΔV ────────────────────────────────────
def load_fixes() -> list[dict]:
    """Return synoptic fixes (season ≥ MIN_SEASON) with a finite next-24h ΔV.

    ΔV is matched by ACTUAL time (fix_time + 24 h) within the same storm,
    robust to IBTrACS's 3-hourly cadence and missing off-synoptic winds."""
    import xarray as xr
    if not IBTRACS_NC.exists():
        raise SystemExit(f"IBTrACS not found: {IBTRACS_NC}")
    ds = xr.open_dataset(IBTRACS_NC)
    sid = ds["sid"].values                         # (storm,) |S13
    season = ds["season"].values.astype("float64")  # (storm,)
    times = ds["time"].values                      # (storm, dt) datetime64
    lat = ds["lat"].values.astype("float64")       # global spline position
    lon = ds["lon"].values.astype("float64")
    basin = ds["basin"].values                     # (storm, dt) |S2
    # Global wind: prefer usa_wind (1-min) where present, else wmo_wind.
    # ΔV (a *change*) is far less sensitive to averaging-period than Vmax.
    usa = ds["usa_wind"].values.astype("float64")
    wmo = ds["wmo_wind"].values.astype("float64")
    wind = np.where(np.isfinite(usa), usa, wmo)
    ds.close()

    fixes: list[dict] = []
    n_storm, n_dt = wind.shape
    dv_delta = np.timedelta64(DV_HOURS, "h")
    tol = np.timedelta64(90, "m")   # allow ±90 min when matching t+24h
    for s in range(n_storm):
        if not (season[s] >= MIN_SEASON):
            continue
        t_row = times[s]
        w_row = wind[s]
        valid = ~np.isnat(t_row) & np.isfinite(w_row) & \
            np.isfinite(lat[s]) & np.isfinite(lon[s])
        idx = np.where(valid)[0]
        if idx.size < 2:
            continue
        tvals = t_row[idx]
        for k, j in enumerate(idx):
            tt = t_row[j]
            hr = int((tt.astype("datetime64[h]").astype(int)) % 24)
            if hr not in SYNOPTIC_HOURS:
                continue
            # find the fix nearest tt + 24h within tolerance
            target = tt + dv_delta
            d = np.abs(tvals - target)
            m = int(np.argmin(d))
            if d[m] > tol:
                continue
            dv = float(w_row[idx[m]] - w_row[j])
            b = basin[s, j].decode("ascii", "ignore").strip() if \
                isinstance(basin[s, j], (bytes, bytearray)) else str(basin[s, j])
            fixes.append({
                "sid": sid[s].decode("ascii", "ignore") if
                isinstance(sid[s], (bytes, bytearray)) else str(sid[s]),
                "t": str(tt.astype("datetime64[s]")),   # ISO, hour-aligned
                "lat": round(float(lat[s, j]), 3),
                "lon": round(float(lon[s, j]), 3),
                "vmax": round(float(w_row[j]), 1),
                "dv24": round(dv, 1),
                "basin": b,
            })
    log.info("IBTrACS: %d synoptic fixes with finite ΔV%dh (season≥%d)",
             len(fixes), DV_HOURS, MIN_SEASON)
    return fixes


# ── ARCO ERA5 access (per-worker dataset handle) ─────────────────────────
# Workers are separate PROCESSES (decompression is CPU/GIL-bound, so threads
# don't scale). Each process opens the zarr once, lazily. The source URL is
# injected by the pool initializer because spawn-started children re-import
# this module with the default ARCO_URL.
_tls = threading.local()
_WORKER_URL = ARCO_URL


def _init_worker(url: str) -> None:
    global _WORKER_URL
    _WORKER_URL = url


def _get_ds():
    ds = getattr(_tls, "ds", None)
    if ds is None:
        import xarray as xr
        ds = xr.open_zarr(_WORKER_URL, chunks=None,
                          storage_options={"token": "anon"})
        _tls.ds = ds
        _tls.lat = ds.latitude.values
        _tls.lon = ds.longitude.values   # 0..359.75 ascending
    return ds


def fetch_timestep(iso_time: str) -> dict:
    """Fetch the global fields needed for one timestep. Each variable
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
    return {
        "T600": T[i600], "T1000": T[i1000],
        "q600": q[i600], "q1000": q[i1000],
        "u200": u[i200], "v200": v[i200],
        "u850": u[i850], "v850": v[i850],
        "sst": sst,
    }


def _region_masks(lat0: float, lon0: float):
    """Return (row_slice, disc, env_ann, shear_ann) boolean masks on a
    latitude-band subgrid around the fix. Equirectangular distance is
    accurate at TC scales; longitude wrap handled modularly."""
    LATS, LONS = _tls.lat, _tls.lon
    r0 = np.searchsorted(-LATS, -(lat0 + LAT_BAND_DEG))   # descending lat
    r1 = np.searchsorted(-LATS, -(lat0 - LAT_BAND_DEG))
    rows = slice(max(r0, 0), min(r1 + 1, LATS.size))
    la = LATS[rows][:, None]
    lo = LONS[None, :]
    dlat_km = (la - lat0) * DEG_KM
    dlon = ((lo - (lon0 % 360) + 180.0) % 360.0) - 180.0
    dlon_km = dlon * DEG_KM * math.cos(math.radians(lat0))
    dist = np.sqrt(dlat_km * dlat_km + dlon_km * dlon_km)
    disc = dist <= DISC_KM
    env = (dist >= ENV_ANN_KM[0]) & (dist <= ENV_ANN_KM[1])
    shr = (dist >= SHEAR_ANN_KM[0]) & (dist <= SHEAR_ANN_KM[1])
    return rows, disc, env, shr


def _mean(field: np.ndarray, rows, mask) -> float | None:
    sub = field[rows][mask]
    good = np.isfinite(sub)
    if int(good.sum()) < MIN_CELLS:
        return None
    return float(sub[good].mean())


def sample_fix(fields: dict, lat0: float, lon0: float) -> dict | None:
    """Sample disc/annulus means and compute VI via the shared core."""
    rows, disc, env, shr = _region_masks(lat0, lon0)
    t_b = _mean(fields["T1000"], rows, disc)
    q_b = _mean(fields["q1000"], rows, disc)
    t_m_sat = _mean(fields["T600"], rows, disc)
    t_m_env = _mean(fields["T600"], rows, env)
    q_m_env = _mean(fields["q600"], rows, env)
    sst_k = _mean(fields["sst"], rows, disc)      # NaN over land → None
    if None in (t_b, q_b, t_m_sat, t_m_env, q_m_env, sst_k):
        return None
    u2 = _mean(fields["u200"], rows, shr); v2 = _mean(fields["v200"], rows, shr)
    u8 = _mean(fields["u850"], rows, shr); v8 = _mean(fields["v850"], rows, shr)
    if None in (u2, v2, u8, v8):
        return None
    shear_ms = math.hypot(u2 - u8, v2 - v8)
    shear_kt = shear_ms / F.KT_TO_MS
    return F.compute_vi(
        shear_kt=shear_kt,
        t_b_k=t_b, q_b=q_b,
        t_m_env_k=t_m_env, q_m_env=q_m_env, t_m_sat_k=t_m_sat,
        sst_c=sst_k - 273.15,
    )


# ── Phase 1: sample ──────────────────────────────────────────────────────
_write_lock = threading.Lock()


def _load_done() -> set[str]:
    if DONE_FILE.exists():
        return set(DONE_FILE.read_text().split())
    return set()


def process_timestep(iso_time: str, fixes: list[dict]) -> list[dict]:
    fields = fetch_timestep(iso_time)
    out = []
    for fx in fixes:
        vi = sample_fix(fields, fx["lat"], fx["lon"])
        if vi is None:
            continue
        out.append({"vi": vi["vi"], "chi_m": vi["chi_m"],
                    "mpi_kt": vi["mpi_kt"], "shear_kt": vi["shear_kt"],
                    "dv24": fx["dv24"], "vmax": fx["vmax"],
                    "basin": fx["basin"], "lat": fx["lat"], "t": fx["t"]})
    return out


def phase_sample(year_lo: int, year_hi: int, workers: int,
                 limit_timesteps: int | None, url: str) -> None:
    from concurrent.futures import ProcessPoolExecutor, as_completed
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
    log.info("sample: %d timesteps to fetch (%d already done), %d procs, %s",
             len(todo), len(done), workers, url.split("/")[-1])
    n_rows = 0
    with open(SAMPLES_JSONL, "a") as fh, \
            ProcessPoolExecutor(max_workers=workers,
                                initializer=_init_worker,
                                initargs=(url,)) as ex:
        futs = {ex.submit(process_timestep, ts, by_ts[ts]): ts for ts in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            ts = futs[fut]
            try:
                rows = fut.result()
            except Exception as e:
                log.warning("timestep %s FAILED: %s", ts, e)
                continue
            with _write_lock:
                for r in rows:
                    fh.write(json.dumps(r, separators=(",", ":")) + "\n")
                fh.flush()
                with open(DONE_FILE, "a") as df:
                    df.write(ts + "\n")
            n_rows += len(rows)
            if i % 50 == 0 or i == len(todo):
                log.info("  %d/%d timesteps  (%d rows so far)",
                         i, len(todo), n_rows)
    log.info("sample done: +%d rows → %s", n_rows, SAMPLES_JSONL)


# ── Phase 2: reduce ──────────────────────────────────────────────────────
def _bin_stats(dv: np.ndarray) -> dict:
    return {"n": int(dv.size),
            "mean": round(float(dv.mean()), 2),
            "std": round(float(dv.std()), 2),
            "pct": {str(p): round(float(np.percentile(dv, p)), 1)
                    for p in PCTS}}


def phase_reduce(local_only: bool) -> None:
    if not SAMPLES_JSONL.exists():
        raise SystemExit(f"no samples at {SAMPLES_JSONL}; run `sample` first")
    vi, dv, basin = [], [], []
    with open(SAMPLES_JSONL) as fh:
        for line in fh:
            r = json.loads(line)
            vi.append(r["vi"]); dv.append(r["dv24"]); basin.append(r["basin"])
    vi = np.asarray(vi); dv = np.asarray(dv); basin = np.asarray(basin)
    log.info("reduce: %d sampled fixes", vi.size)

    edges = VI_BIN_EDGES
    centers = [round((edges[i] + edges[i + 1]) / 2, 4)
               for i in range(len(edges) - 1)]

    def binned(mask: np.ndarray) -> list[dict | None]:
        out = []
        for i in range(len(edges) - 1):
            sel = mask & (vi >= edges[i]) & (vi < edges[i + 1])
            d = dv[sel]
            out.append(_bin_stats(d) if d.size >= 10 else None)
        return out

    all_mask = np.ones(vi.size, bool)
    result = {
        "_about": ("Climatological next-%dh intensity change (ΔV, kt) vs "
                   "Tang & Emanuel ventilation index. VI computed by "
                   "favorability.compute_vi (identical to the realtime "
                   "/shear value) from ARCO ERA5; ΔV from IBTrACS." % DV_HOURS),
        "source": "ERA5 (ARCO gcp-public-data-arco-era5) + IBTrACS.ALL.v04r01",
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "n_fixes": int(vi.size),
        "min_season": MIN_SEASON,
        "dv_hours": DV_HOURS,
        "vi_bin_edges": edges,
        "vi_bin_centers": centers,
        "percentiles": PCTS,
        "global": binned(all_mask),
        "by_basin": {},
    }
    for b in sorted(set(basin.tolist())):
        if not b:
            continue
        result["by_basin"][b] = binned(basin == b)

    OUT_LOCAL.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(result, separators=(",", ":")).encode()
    OUT_LOCAL.write_bytes(body)
    log.info("wrote %s (%d bytes)", OUT_LOCAL, len(body))
    if local_only:
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
                    help="worker processes (default 12; ≈ physical cores)")
    ps.add_argument("--source", choices=list(SOURCES), default="wb13",
                    help="wb13 (13-level, 1959–2021, default) or full37 (2022+)")
    ps.add_argument("--limit-timesteps", type=int, default=None,
                    help="smoke test: only the first N timesteps")
    pr = sub.add_parser("reduce", help="bin VI vs ΔV → JSON (+ GCS upload)")
    pr.add_argument("--local-only", action="store_true")
    args = ap.parse_args()

    if args.phase == "sample":
        lo, hi = _parse_years(args.years)
        phase_sample(lo, hi, args.workers, args.limit_timesteps,
                     SOURCES[args.source])
    else:
        phase_reduce(args.local_only)


if __name__ == "__main__":
    main()
