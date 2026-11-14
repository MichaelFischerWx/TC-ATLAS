#!/usr/bin/env python3
"""Per-storm DeepMind PARDIG rain totals for the RT monitor storm cards.

For each active (or just-ended) tropical cyclone, sums PARDIG's 15-min rain
rate within RADIUS_KM of the storm center at each frame time -- the center
interpolated along the 6-hourly track -- into a storm-total rain swath, and
keeps a per-frame series of rain near the center. Incremental: the running
total and the frames already counted live on R2, so each run adds only the
frames posted since (a storm first seen mid-life is backfilled from the
start of its track, MAX_FRAMES_PER_RUN at a time).

R2, under pardig-v1/storms/<ATCF_ID>/:
  state.npz            running total (float32 mm on the source 0.1 deg grid,
                       S->N), swath coverage mask, frames counted, series
  total-<sha10>.png    8-bit index grid, north-up, equirectangular 0.1 deg,
                       cropped to the swath (immutable; named by content)
  index.json           grid edges, encoding, coverage, series, credit (the
                       cdn caches */index.json for its max-age)

Index encoding ("encoding" in index.json):
  0 = outside the swath (never within RADIUS_KM of the center),
  1 = inside the swath, < MIN_MM, 255 = >= MAX_MM,
  2..254 = log-spaced bins over [MIN_MM, MAX_MM): bin k spans
           MIN_MM * (MAX_MM/MIN_MM)**(k/NBINS) .. MIN_MM * (MAX_MM/MIN_MM)**((k+1)/NBINS).

PARDIG caps rain rate at 75 mm/h, so totals under the most intense eyewalls
run low; the series' `cap100` (share of the inner 100-km disk at the cap)
says how often that bites.

Usage:
  python3 pardig_storm_totals.py --storm WP312026 --out DIR   # one storm, local files
  (in production build_pardig_rain.py calls run() after the rain frames)
"""
import argparse
import hashlib
import io
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

import build_pardig_rain as pr

STORMS_URL = os.environ.get("PARDIG_STORMS_URL",
                            "https://api.tcatlas.org/ir-monitor/recent-storms?days={days}")
KEY_BASE = f"{pr.R2_PREFIX}/storms"
RADIUS_KM = 500.0                     # storm-total swath radius (the usual TC-rain convention)
INNER_KM = 100.0                      # "rain near the center" series
RECENT_HOURS = 36.0                   # storms with a fix this recent are candidates
EXTRAP_HOURS = 6.0                    # active storms: carry the last motion this far past the last fix
FINAL_GRACE_HOURS = 3.0               # ended storms: count frames up to the last fix + this
MAX_FRAMES_PER_RUN = int(os.environ.get("PARDIG_STORM_MAX_FRAMES", "480"))
FRAME_HOURS = 0.25                    # PARDIG NRT cadence
MIN_MM, MAX_MM, NBINS = 1.0, 3000.0, 253
RES = 0.1
NY, NX = pr.NY, pr.NX
EARTH_KM = 6371.0
INDEX_CACHE = "public, max-age=120"
STATE_CACHE = "no-store"

ATTRIBUTION = dict(pr.ATTRIBUTION)
ATTRIBUTION["modifications"] = (
    "Summed by TC-ATLAS within 500 km of the storm center at each 15-min frame (center interpolated "
    "along the 6-hourly best track or advisory positions) into a storm total on the 0.1 deg grid, "
    "binned into 253 log-spaced levels.")

_LOGSPAN = math.log(MAX_MM / MIN_MM)


def log(msg):
    pr.log(msg)


def encode_total(mm, cover):
    """Storm-total mm -> uint8 index (see module docstring)."""
    r = np.asarray(mm, dtype=np.float32)
    k = np.floor(NBINS * np.log(np.maximum(r, MIN_MM) / MIN_MM) / _LOGSPAN)
    idx = (2 + np.clip(k, 0, NBINS - 1)).astype(np.uint8)
    idx[r < MIN_MM] = 1
    idx[r >= MAX_MM] = 255
    idx[~cover] = 0
    return idx


# ── Storms and tracks ─────────────────────────────────────────────────────
def fetch_storms(days=21):
    raw = pr._get(STORMS_URL.format(days=days), timeout=90)
    return json.loads(raw).get("storms", [])


def _epoch(iso):
    return datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def track_arrays(storm):
    """(t epoch s, lat, continuous lon) sorted by time, duplicates dropped.
    Longitude is unwrapped so a dateline crossing stays continuous; the
    first point sits in [-180, 180)."""
    pts = {}
    for p in storm.get("track") or []:
        if p.get("lat") is None or p.get("lon") is None or not p.get("time"):
            continue
        pts[_epoch(p["time"])] = (float(p["lat"]), float(p["lon"]))
    if not pts:
        return None
    t = np.array(sorted(pts), dtype=np.float64)
    lat = np.array([pts[k][0] for k in t])
    lon = np.array([pts[k][1] for k in t])
    lon[0] = ((lon[0] + 180.0) % 360.0) - 180.0
    for i in range(1, len(lon)):
        d = lon[i] - lon[i - 1]
        lon[i] -= 360.0 * round(d / 360.0)
    return t, lat, lon


def center_at(tr, t, extrap_s):
    """Track position at epoch t: linear between fixes; past the last fix,
    the last 6-12 h motion carried forward up to extrap_s; else None."""
    tt, la, lo = tr
    if t < tt[0] - 1:
        return None
    if t <= tt[-1] + 1:
        if len(tt) == 1:
            return float(la[0]), float(lo[0])
        return float(np.interp(t, tt, la)), float(np.interp(t, tt, lo))
    if t - tt[-1] > extrap_s:
        return None
    k = len(tt) - 1
    j = k - 1
    while j > 0 and tt[k] - tt[j] < 6 * 3600:   # a motion vector over >= 6 h
        j -= 1
    if j < 0 or tt[k] == tt[j]:
        return float(la[k]), float(lo[k])
    f = (t - tt[k]) / (tt[k] - tt[j])
    return float(la[k] + f * (la[k] - la[j])), float(lo[k] + f * (lo[k] - lo[j]))


def window(lat_c, lon_c):
    """Source rows / continuous columns of the disk around (lat_c, lon_c)
    plus distances (km) and cos(lat) area weights."""
    ic = int(round((lat_c + 90.0) / RES))
    jc = int(round(lon_c / RES))
    deg = RADIUS_KM / 111.195
    di = int(math.ceil(deg / RES)) + 1
    coslat = max(math.cos(math.radians(min(abs(lat_c) + deg, 89.0))), 0.05)
    dj = int(math.ceil(deg / coslat / RES)) + 1
    rows = np.arange(max(ic - di, 0), min(ic + di, NY - 1) + 1)
    cols = np.arange(jc - dj, jc + dj + 1)
    plat = np.radians(rows * RES - 90.0)[:, None]
    dlon = np.radians(cols * RES - lon_c)[None, :]
    clat = math.radians(lat_c)
    a = (np.sin((plat - clat) / 2.0) ** 2
         + math.cos(clat) * np.cos(plat) * np.sin(dlon / 2.0) ** 2)
    d = 2.0 * EARTH_KM * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))
    w = np.broadcast_to(np.cos(plat), d.shape)
    return rows, cols, d, w


# ── State ─────────────────────────────────────────────────────────────────
SERIES = ("t", "lat", "lon", "r100", "r500", "cap100", "pmax")


def new_state():
    return {"accum": None, "cover": None, "i0": 0, "j0": 0, "done": set(),
            "series": {k: [] for k in SERIES}}


def ensure_box(st, r0, r1, c0, c1, margin=40):
    """Grow the state's grid (rows r0..r1, continuous cols c0..c1 inclusive)."""
    if st["accum"] is None:
        st["i0"], st["j0"] = max(r0 - margin, 0), c0 - margin
        ni = min(r1 + margin, NY - 1) - st["i0"] + 1
        nj = (c1 + margin) - st["j0"] + 1
        st["accum"] = np.zeros((ni, nj), np.float32)
        st["cover"] = np.zeros((ni, nj), bool)
        return
    i0, j0 = st["i0"], st["j0"]
    ni, nj = st["accum"].shape
    if r0 >= i0 and r1 < i0 + ni and c0 >= j0 and c1 < j0 + nj:
        return
    n_i0 = min(i0, max(r0 - margin, 0))
    n_i1 = max(i0 + ni - 1, min(r1 + margin, NY - 1))
    n_j0 = min(j0, c0 - margin)
    n_j1 = max(j0 + nj - 1, c1 + margin)
    acc = np.zeros((n_i1 - n_i0 + 1, n_j1 - n_j0 + 1), np.float32)
    cov = np.zeros(acc.shape, bool)
    acc[i0 - n_i0:i0 - n_i0 + ni, j0 - n_j0:j0 - n_j0 + nj] = st["accum"]
    cov[i0 - n_i0:i0 - n_i0 + ni, j0 - n_j0:j0 - n_j0 + nj] = st["cover"]
    st.update(accum=acc, cover=cov, i0=n_i0, j0=n_j0)


def add_frame(st, rate, ts, lat_c, lon_c):
    """Add one 15-min frame (rate mm/h, full source grid) to the storm."""
    rows, cols, d, w = window(lat_c, lon_c)
    ensure_box(st, int(rows[0]), int(rows[-1]), int(cols[0]), int(cols[-1]))
    r = rate[rows[:, None], (cols % NX)[None, :]]
    r = np.where(r > 0, r, 0.0).astype(np.float32)          # no-data (-1) counts as 0
    disk = d <= RADIUS_KM
    inner = d <= INNER_KM
    a = st["accum"][rows[0] - st["i0"]:rows[-1] - st["i0"] + 1,
                    cols[0] - st["j0"]:cols[-1] - st["j0"] + 1]
    a += np.where(disk, r * FRAME_HOURS, 0.0).astype(np.float32)
    c = st["cover"][rows[0] - st["i0"]:rows[-1] - st["i0"] + 1,
                    cols[0] - st["j0"]:cols[-1] - st["j0"] + 1]
    c |= disk

    def wmean(mask, v):
        ws = float((w * mask).sum())
        return float((w * mask * v).sum() / ws) if ws > 0 else 0.0
    s = st["series"]
    s["t"].append(int(ts))
    s["lat"].append(round(lat_c, 2))
    s["lon"].append(round(((lon_c + 180.0) % 360.0) - 180.0, 2))
    s["r100"].append(round(wmean(inner, r), 2))
    s["r500"].append(round(wmean(disk, r), 2))
    s["cap100"].append(round(wmean(inner, (r >= pr.CAP_AT).astype(np.float32)), 3))
    s["pmax"].append(round(float(r[disk].max()) if disk.any() else 0.0, 1))
    st["done"].add(ts)


def state_bytes(st):
    s = st["series"]
    order = np.argsort(np.array(s["t"], dtype=np.int64), kind="stable")
    buf = io.BytesIO()
    np.savez_compressed(
        buf, accum=st["accum"], cover=st["cover"].astype(np.uint8),
        i0=np.int64(st["i0"]), j0=np.int64(st["j0"]),
        done=np.array(sorted(int(x) for x in st["done"]), dtype=np.int64),
        **{"s_" + k: np.array(s[k])[order] if len(s[k]) else np.array([]) for k in SERIES})
    return buf.getvalue()


def state_from_bytes(b):
    z = np.load(io.BytesIO(b))
    st = new_state()
    st.update(accum=z["accum"].astype(np.float32), cover=z["cover"].astype(bool),
              i0=int(z["i0"]), j0=int(z["j0"]), done={f"{int(x):012d}" for x in z["done"]})
    for k in SERIES:
        v = z["s_" + k].tolist()
        st["series"][k] = [int(x) for x in v] if k == "t" else v
    return st


# ── Outputs ───────────────────────────────────────────────────────────────
def build_outputs(st, storm, posted, final, last_fix):
    """(png bytes, png name, index dict) for the swath cropped to its coverage."""
    from PIL import Image
    cov = st["cover"]
    rr = np.where(cov.any(axis=1))[0]
    cc = np.where(cov.any(axis=0))[0]
    r0, r1, c0, c1 = int(rr[0]), int(rr[-1]), int(cc[0]), int(cc[-1])
    acc = st["accum"][r0:r1 + 1, c0:c1 + 1]
    cv = cov[r0:r1 + 1, c0:c1 + 1]
    idx = encode_total(acc, cv)[::-1]                      # north-up
    bio = io.BytesIO()
    Image.fromarray(idx, mode="L").save(bio, format="PNG", optimize=True)
    png = bio.getvalue()
    name = f"total-{hashlib.sha1(png).hexdigest()[:10]}.png"

    i_s, j_w = st["i0"] + r0, st["j0"] + c0
    lat_s = i_s * RES - 90.0 - RES / 2
    lat_n = (i_s + acc.shape[0]) * RES - 90.0 - RES / 2
    lon_w = j_w * RES - RES / 2
    shift = 360.0 * math.floor((lon_w + 180.0) / 360.0)
    lon_w -= shift
    lon_e = lon_w + acc.shape[1] * RES
    k = int(np.argmax(np.where(cv, acc, -1)))
    ki, kj = divmod(k, acc.shape[1])

    s = st["series"]
    order = np.argsort(np.array(s["t"], dtype=np.int64), kind="stable")
    ser = {key: [s[key][i] for i in order] for key in SERIES}
    ser["t"] = [f"{x:012d}" for x in ser["t"]]
    frames = sorted(st["done"])
    t_first, t_last = pr.ts_to_dt(frames[0]), pr.ts_to_dt(frames[-1])
    expected = int(round((t_last - t_first).total_seconds() / (FRAME_HOURS * 3600))) + 1
    meta = {
        "atcf_id": storm["atcf_id"], "name": storm.get("name"),
        "radius_km": RADIUS_KM, "inner_km": INNER_KM,
        "png": name,
        "grid": {"res_deg": RES, "nx": int(acc.shape[1]), "ny": int(acc.shape[0]),
                 "lat_s": round(lat_s, 3), "lat_n": round(lat_n, 3),
                 "lon_w": round(lon_w, 3), "lon_e": round(lon_e, 3), "rows": "north-up"},
        "encoding": {"kind": "log", "min_mm": MIN_MM, "max_mm": MAX_MM, "bins": NBINS,
                     "idx_outside": 0, "idx_low": 1, "idx_first": 2, "idx_cap": 255},
        "first_frame": frames[0], "last_frame": frames[-1],
        "last_frame_posted": posted,
        "n_frames": len(frames), "expected_frames": expected,
        "track_last_fix": last_fix,
        "final": bool(final),
        "max_mm": round(float(acc[ki, kj]), 1),
        "max_at": [round(lat_s + (ki + 0.5) * RES, 2),         # acc rows run S->N
                   round(((lon_w + (kj + 0.5) * RES + 180.0) % 360.0) - 180.0, 2)],
        "rate_cap_mm_h": pr.CAP,
        "series": ser,
        **ATTRIBUTION,
    }
    return png, name, meta


# ── Storage (R2 or a local directory) ─────────────────────────────────────
class Store:
    def __init__(self, out_dir=None):
        self.out = out_dir

    def _path(self, key):
        return os.path.join(self.out, key[len(pr.R2_PREFIX) + 1:])

    def get(self, key):
        if self.out:
            p = self._path(key)
            return open(p, "rb").read() if os.path.exists(p) else None
        try:
            return pr.r2().get_object(Bucket=pr.bucket(), Key=key)["Body"].read()
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code in ("NoSuchKey", "404"):
                return None
            raise

    def put(self, key, body, ctype, cache):
        if self.out:
            p = self._path(key)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(body)
        else:
            pr.r2_put(key, body, ctype, cache)

    def prune_pngs(self, base, keep):
        if self.out:
            d = self._path(base)
            for f in os.listdir(d):
                if f.startswith("total-") and f.endswith(".png") and f not in keep:
                    os.remove(os.path.join(d, f))
            return
        resp = pr.r2().list_objects_v2(Bucket=pr.bucket(), Prefix=base + "/total-", MaxKeys=1000)
        old = [{"Key": o["Key"]} for o in resp.get("Contents", [])
               if o["Key"].rsplit("/", 1)[-1] not in keep]
        if old:
            pr.r2().delete_objects(Bucket=pr.bucket(), Delete={"Objects": old, "Quiet": True})


# ── Run ───────────────────────────────────────────────────────────────────
def run(out_dir=None, only=None, days=21, max_frames=MAX_FRAMES_PER_RUN, src=None, workers=4):
    """Update every candidate storm's total. `only` = an ATCF id to force
    (ignores the recency filter; for backfills/tests). Returns #storms written."""
    store = Store(out_dir)
    now = time.time()
    storms = fetch_storms(days)
    cands = []
    for s in storms:
        sid = (s.get("atcf_id") or "").upper()
        if not sid or (only and sid != only.upper()):
            continue
        tr = track_arrays(s)
        if tr is None:
            continue
        recent = now - tr[0][-1] <= RECENT_HOURS * 3600
        if not (only or s.get("active") or recent):
            continue
        cands.append((sid, s, tr))
    if not cands:
        log("storm totals: no active or recent storms")
        return 0

    # Cheap skip: a storm whose index.json already covers through its end
    # (or through the newest source frame) needs no state load.
    newest_src = None
    if src is None:
        earliest = min(tr[0][0] for _, _, tr in cands)
        start = datetime.fromtimestamp(earliest, timezone.utc) - timedelta(minutes=15)
        src = pr.list_source_frames(start=start)
    if not src:
        log("storm totals: no source frames")
        return 0
    src_ts = sorted(src)
    newest_src = pr.src_to_ts(src_ts[-1])

    plans = []            # (sid, storm, tr, state, [src_ts needed], final, extrap_s)
    for sid, s, tr in cands:
        base = f"{KEY_BASE}/{sid}"
        active = bool(s.get("active"))
        extrap_s = EXTRAP_HOURS * 3600 if active else FINAL_GRACE_HOURS * 3600
        t_end = tr[0][-1] + extrap_s
        prev = store.get(base + "/index.json")
        prev = json.loads(prev) if prev else None
        if prev and prev.get("final"):
            continue
        need_all = [x for x in src_ts
                    if tr[0][0] - 1 <= pr.ts_to_dt(pr.src_to_ts(x)).timestamp() <= t_end]
        # Ended storm, and the source has moved past its end: last update.
        final = (not active) and pr.ts_to_dt(newest_src).timestamp() > t_end
        if (prev and need_all and not final
                and (prev.get("last_frame") or "") >= pr.src_to_ts(need_all[-1])
                and prev.get("n_frames", 0) >= len(need_all)):
            continue
        sb = store.get(base + "/state.npz")
        st = state_from_bytes(sb) if sb else new_state()
        need = [x for x in need_all if pr.src_to_ts(x) not in st["done"]]
        if need or (final and st["done"]):
            plans.append((sid, s, tr, st, need, final, extrap_s, prev))
    if not plans:
        log(f"storm totals: {len(cands)} storm(s) up to date")
        return 0

    # One read per frame, shared by every storm that needs it; oldest first so
    # a long backfill advances in order. A capped run leaves the rest for the next.
    want = sorted({x for p in plans for x in p[4]})
    capped = len(want) > max_frames
    want = want[:max_frames]
    log(f"storm totals: {len(plans)} storm(s), {len(want)} frame(s) to read"
        + (" (capped)" if capped else ""))
    import concurrent.futures as cf
    users = {x: [p for p in plans if x in p[4]] for x in want}
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        it = ex.map(lambda x: (x, pr.read_frame(x)), want)
        for n, (x, rate) in enumerate(it):
            ts = pr.src_to_ts(x)
            t = pr.ts_to_dt(ts).timestamp()
            for sid, s, tr, st, need, final, extrap_s, prev in users[x]:
                c = center_at(tr, t, extrap_s)
                if c is not None:
                    add_frame(st, rate, ts, c[0], c[1])
            if (n + 1) % 50 == 0:
                log(f"  {n + 1}/{len(want)} frames ({time.time() - t0:.0f}s)")

    written = 0
    for sid, s, tr, st, need, final, extrap_s, prev in plans:
        if not st["done"] or st["accum"] is None:
            continue
        base = f"{KEY_BASE}/{sid}"
        done_all = all(pr.src_to_ts(x) in st["done"] for x in need)
        last = max(st["done"])
        posted = next((src[x] for x in src if pr.src_to_ts(x) == last), None)
        last_fix = datetime.fromtimestamp(tr[0][-1], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        png, name, meta = build_outputs(st, s, posted, final and done_all, last_fix)
        meta["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        store.put(f"{base}/state.npz", state_bytes(st), "application/octet-stream", STATE_CACHE)
        store.put(f"{base}/{name}", png, "image/png", pr.TILE_CACHE)
        store.put(f"{base}/index.json", json.dumps(meta, separators=(",", ":")).encode(),
                  "application/json", INDEX_CACHE)                # after the png
        keep = {name} | ({prev["png"]} if prev and prev.get("png") else set())
        store.prune_pngs(base, keep)
        written += 1
        log(f"  {sid} {s.get('name')}: {meta['n_frames']}/{meta['expected_frames']} frames "
            f"{meta['first_frame']}..{meta['last_frame']}, max {meta['max_mm']:.0f} mm, "
            f"grid {meta['grid']['nx']}x{meta['grid']['ny']}, png {len(png) / 1e3:.0f} kB"
            + (" FINAL" if meta["final"] else ""))
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--storm", help="ATCF id to build regardless of recency (e.g. WP312026)")
    ap.add_argument("--out", help="write under this dir instead of R2")
    ap.add_argument("--days", type=int, default=21, help="recent-storms lookback")
    ap.add_argument("--max-frames", type=int, default=MAX_FRAMES_PER_RUN)
    args = ap.parse_args()
    run(out_dir=args.out, only=args.storm, days=args.days, max_frames=args.max_frames)
    return 0


if __name__ == "__main__":
    sys.exit(main())
