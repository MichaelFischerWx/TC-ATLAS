#!/usr/bin/env python3
"""Storm-total DeepMind PARDIG rain for the Global Archive (IBTrACS storms, 2016 on).

Same product as the storm-card totals (pardig_storm_totals.py): PARDIG's
15-min rain rate summed within 500 km of the storm center, the center
interpolated along the 3-hourly IBTrACS track the archive itself draws, plus
a per-frame series of rain near the center. One pass in time order: every
frame is read once and added to every storm active at that time.

Sources (Google DeepMind, CC BY 4.0, anonymous HTTPS):
  2016-01-01 07:45 .. 2025-12-31 23:45  NRT/zarr/2016_to_2025/predictions.zarr
      precipitation [350657, 1801, 3600] float32 m/h, chunks of 4 frames
      (15 min apart, contiguous), NaN fill; latitude S->N, longitude 0..359.9
  2026-01-01 00:00 on                   NRT/zarr/2026_to_present/<ts>/ (1 frame each)

Storms come from the archive's own static files (tcatlas.org
ibtracs_storms.json + ibtracs_tracks_*.json). A storm whose track starts
before 2016-01-01 07:45 gets the part the record covers (n_frames <
expected_frames).

R2, under pardig-v1/archive/:
  <SID>/index.json, <SID>/total-<sha10>.png   (same format as pardig-v1/storms/)
  parts/<year>.json                           per-task summary, merged by --merge
  manifest.json                               {sid: [max_mm, n_frames, expected_frames]}

Usage:
  python3 build_pardig_archive.py --missing              # monthly: new storms + storms whose
                                                          # track grew since, then merge
  python3 build_pardig_archive.py --sids 2017228N14314,2025294N14290 --out DIR
  python3 build_pardig_archive.py --year 2017            # one start-year to R2
  (Cloud Run: one task per start year; CLOUD_RUN_TASK_INDEX -> 2016 + index)
  python3 build_pardig_archive.py --merge                # parts -> manifest.json
"""
import argparse
import collections
import concurrent.futures as cf
import json
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np

import build_pardig_rain as pr
import pardig_storm_totals as T

ARCH_URL = ("https://storage.googleapis.com/pardig_1/NRT/zarr/2016_to_2025/"
            "predictions.zarr/precipitation/c/{k}/0/0")
ARCH_T0 = datetime(2016, 1, 1, 7, 45, tzinfo=timezone.utc)
ARCH_N = 350657
ARCH_CHUNK = 4
NRT_START = datetime(2026, 1, 1, tzinfo=timezone.utc)
SITE = os.environ.get("PARDIG_SITE", "https://tcatlas.org")
KEY_BASE = f"{pr.R2_PREFIX}/archive"
STEP = timedelta(minutes=15)
FIRST_YEAR = 2016

ATTRIBUTION = dict(pr.ATTRIBUTION)
ATTRIBUTION["modifications"] = (
    "Summed by TC-ATLAS within 500 km of the storm center at each 15-min frame (center interpolated "
    "along the 3-hourly IBTrACS track) into a storm total on the 0.1 deg grid, binned into 253 "
    "log-spaced levels.")


def log(msg):
    pr.log(msg)


# ── Storms ────────────────────────────────────────────────────────────────
def load_storms():
    """[(sid, meta, track points)] for every archive storm with a track."""
    storms = json.loads(pr._get(f"{SITE}/ibtracs_storms.json", timeout=120))["storms"]
    man = json.loads(pr._get(f"{SITE}/ibtracs_tracks_manifest.json", timeout=60))
    tracks = {}
    for c in man.get("chunks", []):
        name = c if isinstance(c, str) else (c.get("file") or c.get("name"))
        tracks.update(json.loads(pr._get(f"{SITE}/{name}", timeout=300)))
    out = []
    for s in storms:
        pts = tracks.get(s["sid"])
        if pts:
            out.append((s["sid"], s, pts))
    return out


def track_of(pts):
    """IBTrACS points -> (t epoch, lat, continuous lon) via T.track_arrays."""
    return T.track_arrays({"track": [{"time": p["t"] + ":00Z" if len(p["t"]) == 16 else p["t"],
                                      "lat": p["la"], "lon": p["lo"]} for p in pts]})


def natures(pts):
    tt = [datetime.strptime(p["t"][:16], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp()
          for p in pts]
    order = np.argsort(tt)
    return np.array(tt)[order], [pts[i].get("n") or "" for i in order]


def frame_times(tr):
    """15-min frame datetimes within the track span that the record covers."""
    t0 = datetime.fromtimestamp(tr[0][0], timezone.utc)
    t1 = datetime.fromtimestamp(tr[0][-1], timezone.utc)
    # first frame on the :00/:15/:30/:45 grid at or after t0
    t = t0.replace(second=0, microsecond=0)
    t += timedelta(minutes=(-t.minute) % 15)
    out = []
    while t <= t1:
        out.append(t)
        t += STEP
    return out


def expected_frames(tr):
    return len(frame_times(tr))


def arch_index(t):
    i = int(round((t - ARCH_T0).total_seconds() / 900.0))
    return i if 0 <= i < ARCH_N else None


# ── Reading ───────────────────────────────────────────────────────────────
def read_arch_chunk(k):
    import zstandard
    raw = pr._get(ARCH_URL.format(k=k), timeout=180)
    buf = zstandard.ZstdDecompressor().decompress(raw, max_output_size=ARCH_CHUNK * pr.NY * pr.NX * 4 + 1024)
    a = np.frombuffer(buf, "<f4").reshape(-1, pr.NY, pr.NX) * np.float32(1000.0)
    return np.nan_to_num(a, nan=-1.0)


def bounded_map(fn, items, workers=6, ahead=8):
    """Ordered map with at most `ahead` results in flight (each archive
    chunk decodes to ~100 MB, so an unbounded Executor.map can run away)."""
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        q = collections.deque()
        it = iter(items)
        for x in it:
            q.append((x, ex.submit(fn, x)))
            if len(q) >= ahead:
                break
        while q:
            x, f = q.popleft()
            try:
                res = f.result()
            except Exception as e:
                res = e
            nxt = next(it, None)
            if nxt is not None:
                q.append((nxt, ex.submit(fn, nxt)))
            yield x, res


# ── Outputs ───────────────────────────────────────────────────────────────
def finish(store, sid, s, pts, tr, st):
    if not st["done"] or st["accum"] is None:
        log(f"  {sid} {s.get('name')}: no frames in the record")
        return None
    png, name, meta = T.build_outputs(st, {"atcf_id": sid, "name": s.get("name")}, None, True,
                                      datetime.fromtimestamp(tr[0][-1], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    ntt, nn = natures(pts)
    ser = meta["series"]
    ser["nature"] = []
    for ts in ser["t"]:
        t = pr.ts_to_dt(ts).timestamp()
        j = int(np.searchsorted(ntt, t, side="right")) - 1
        ser["nature"].append(nn[max(j, 0)])
    meta.pop("track_last_fix", None)
    meta.pop("last_frame_posted", None)
    meta.update({
        "sid": sid, "atcf_id": s.get("atcf_id"), "name": s.get("name"), "year": s.get("year"),
        "basin": s.get("basin"),
        "track_source": "IBTrACS v04r01 (3-hourly)",
        "track_first": datetime.fromtimestamp(tr[0][0], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "track_last": datetime.fromtimestamp(tr[0][-1], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expected_frames": expected_frames(tr),
        "record_start": ARCH_T0.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "final": True,
        **ATTRIBUTION,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    base = f"{KEY_BASE}/{sid}"
    store.put(f"{base}/{name}", png, "image/png", pr.TILE_CACHE)
    store.put(f"{base}/index.json", json.dumps(meta, separators=(",", ":")).encode(),
              "application/json", "public, max-age=86400")
    store.prune_pngs(base, {name})
    log(f"  {sid} {s.get('name')} {s.get('year')}: {meta['n_frames']}/{meta['expected_frames']} frames, "
        f"max {meta['max_mm']:.0f} mm at {meta['max_at']}, grid {meta['grid']['nx']}x{meta['grid']['ny']}, "
        f"png {len(png) / 1e3:.0f} kB")
    return [meta["max_mm"], meta["n_frames"], meta["expected_frames"]]


def existing_sids(store):
    """SIDs that already have an index.json (written last, so a complete total)."""
    if store.out:
        d = os.path.join(store.out, "archive")
        return {x for x in os.listdir(d) if os.path.exists(os.path.join(d, x, "index.json"))} if os.path.isdir(d) else set()
    out, tok = set(), None
    while True:
        kw = {"Bucket": pr.bucket(), "Prefix": KEY_BASE + "/", "MaxKeys": 1000}
        if tok:
            kw["ContinuationToken"] = tok
        resp = pr.r2().list_objects_v2(**kw)
        for o in resp.get("Contents", []):
            parts = o["Key"][len(kw["Prefix"]):].split("/")
            if len(parts) == 2 and parts[1] == "index.json":
                out.add(parts[0])
        if not resp.get("IsTruncated"):
            return out
        tok = resp.get("NextContinuationToken")


# ── Run ───────────────────────────────────────────────────────────────────
def run(store, sids=None, year=None, force=False, workers=6, part=None, missing=False):
    t_start = time.time()
    all_storms = load_storms()
    sel = []
    for sid, s, pts in all_storms:
        tr = track_of(pts)
        if tr is None:
            continue
        t_last = datetime.fromtimestamp(tr[0][-1], timezone.utc)
        if t_last < ARCH_T0:
            continue
        if sids is not None:
            if sid not in sids:
                continue
        elif year is not None:
            y0 = max(datetime.fromtimestamp(tr[0][0], timezone.utc).year, FIRST_YEAR)
            if y0 != year:
                continue
        sel.append((sid, s, pts, tr))
    if not force:
        have = existing_sids(store)
        skipped = [x for x in sel if x[0] in have]
        sel = [x for x in sel if x[0] not in have]
        if missing:
            # A storm still active at an IBTrACS refresh got a partial track;
            # rebuild it once a later refresh extends the track.
            grown = []
            recent = time.time() - 400 * 86400
            for x in skipped:
                if x[3][0][-1] < recent:
                    continue
                b = store.get(f"{KEY_BASE}/{x[0]}/index.json")
                m = json.loads(b) if b else {}
                last = datetime.fromtimestamp(x[3][0][-1], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                if (m.get("track_last") or "") < last:
                    grown.append(x)
            if grown:
                log(f"rebuilding {len(grown)} storm(s) whose track grew: "
                    + ", ".join(f"{x[0]} {x[1].get('name')}" for x in grown))
            gs = {x[0] for x in grown}
            skipped = [x for x in skipped if x[0] not in gs]
            sel += grown
        if skipped:
            log(f"skipping {len(skipped)} storm(s) already built")
    if not sel:
        log("nothing to build")
        return {}
    log(f"{len(sel)} storm(s) to build" + (f" (start year {year})" if year else ""))

    # Frame plan in time order: archive chunks (4 frames) + NRT frames (1).
    need = collections.defaultdict(list)          # frame datetime -> [storm idx]
    for n, (_, _, _, tr) in enumerate(sel):
        for t in frame_times(tr):
            if t >= ARCH_T0:
                need[t].append(n)
    units = collections.OrderedDict()            # ("a", k) | ("n", src_ts) -> [frame datetimes]
    nrt_ts = None
    for t in sorted(need):
        if t < NRT_START:
            i = arch_index(t)
            if i is None:
                continue
            units.setdefault(("a", i // ARCH_CHUNK), []).append(t)
        else:
            if nrt_ts is None:
                nrt_ts = pr.list_source_frames(start=t - STEP)
            src = t.strftime("%Y%m%dT%H%M%S")
            if src in nrt_ts:
                units.setdefault(("n", src), []).append(t)
    n_frames = sum(len(v) for v in units.values())
    log(f"reading {len(units)} object(s) for {n_frames} frame(s) "
        f"({sum(1 for u in units if u[0] == 'a')} archive chunks, {sum(1 for u in units if u[0] == 'n')} NRT frames)")

    states = [T.new_state() for _ in sel]
    last_t = [datetime.fromtimestamp(tr[0][-1], timezone.utc) for _, _, _, tr in sel]
    pending = set(range(len(sel)))
    summary = {}

    def read(u):
        return read_arch_chunk(u[1]) if u[0] == "a" else pr.read_frame(u[1])

    done_frames = 0
    t0 = time.time()
    for u, data in bounded_map(read, list(units), workers=workers):
        frames = units[u]
        if isinstance(data, Exception):
            log(f"  read failed {u}: {data!r}")
            data = None
        for t in frames:
            if data is not None:
                rate = data[arch_index(t) % ARCH_CHUNK] if u[0] == "a" else data
                ts = t.strftime("%Y%m%d%H%M")
                te = t.timestamp()
                for n in need[t]:
                    c = T.center_at(sel[n][3], te, 0)
                    if c is not None:
                        T.add_frame(states[n], rate, ts, c[0], c[1])
            done_frames += 1
            # storms whose span is over: write them out and free their grids
            for n in [n for n in pending if last_t[n] <= t]:
                pending.discard(n)
                sid, s, pts, tr = sel[n]
                r = finish(store, sid, s, pts, tr, states[n])
                if r:
                    summary[sid] = r
                    if part and len(summary) % 10 == 0:
                        write_part(store, part, summary)
                states[n] = None
        if done_frames and done_frames % 2000 < len(frames):
            el = time.time() - t0
            log(f"  {done_frames}/{n_frames} frames ({el:.0f}s, {done_frames / max(el, 1e-6):.0f}/s)")
    for n in sorted(pending):                     # spans running past the last readable frame
        sid, s, pts, tr = sel[n]
        r = finish(store, sid, s, pts, tr, states[n])
        if r:
            summary[sid] = r
    log(f"built {len(summary)} storm(s) in {time.time() - t_start:.0f}s")
    return summary


def write_part(store, name, summary):
    if not summary:
        return
    key = f"{KEY_BASE}/parts/{name}.json"
    cur = store.get(key)
    cur = json.loads(cur) if cur else {}
    cur.update(summary)
    store.put(key, json.dumps(cur, separators=(",", ":")).encode(), "application/json", "no-store")


def merge(store):
    parts = {}
    if store.out:
        d = os.path.join(store.out, "archive", "parts")
        names = [f[:-5] for f in os.listdir(d) if f.endswith(".json")] if os.path.isdir(d) else []
    else:
        resp = pr.r2().list_objects_v2(Bucket=pr.bucket(), Prefix=f"{KEY_BASE}/parts/", MaxKeys=1000)
        names = [o["Key"].rsplit("/", 1)[-1][:-5] for o in resp.get("Contents", []) if o["Key"].endswith(".json")]
    for nm in sorted(names):
        parts.update(json.loads(store.get(f"{KEY_BASE}/parts/{nm}.json")))
    # Totals on R2 that no part lists (a task killed before writing its part):
    # read their index.json so the manifest covers everything built.
    missing = sorted(existing_sids(store) - set(parts))
    for sid in missing:
        b = store.get(f"{KEY_BASE}/{sid}/index.json")
        if b:
            m = json.loads(b)
            parts[sid] = [m.get("max_mm"), m.get("n_frames"), m.get("expected_frames")]
    if missing:
        log(f"added {len(missing)} storm(s) missing from the parts")
    man = {"storms": parts, "fields": ["max_mm", "n_frames", "expected_frames"],
           "radius_km": T.RADIUS_KM, **ATTRIBUTION,
           "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    store.put(f"{KEY_BASE}/manifest.json", json.dumps(man, separators=(",", ":")).encode(),
              "application/json", "public, max-age=3600")
    log(f"manifest.json: {len(parts)} storms from {len(names)} part(s)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--sids", help="comma-separated IBTrACS SIDs")
    ap.add_argument("--year", type=int, help="storms starting in this year (2016 includes earlier starts)")
    ap.add_argument("--out", help="write under this dir instead of R2")
    ap.add_argument("--force", action="store_true", help="rebuild storms that already have a total")
    ap.add_argument("--merge", action="store_true", help="merge parts/*.json into manifest.json")
    ap.add_argument("--missing", action="store_true",
                    help="build storms without a total (and ones whose track grew), then merge")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    store = T.Store(args.out)
    if args.merge:
        merge(store)
        return 0
    if args.missing:
        summary = run(store, force=False, workers=args.workers, part="updates", missing=True)
        write_part(store, "updates", summary)
        merge(store)
        return 0
    year = args.year
    if year is None and not args.sids and os.environ.get("CLOUD_RUN_TASK_INDEX"):
        year = FIRST_YEAR + int(os.environ["CLOUD_RUN_TASK_INDEX"])
    if year is None and not args.sids:
        sys.exit("give --sids, --year or run as a Cloud Run task")
    sids = set(args.sids.split(",")) if args.sids else None
    part = str(year) if year else "adhoc"
    summary = run(store, sids=sids, year=year, force=args.force, workers=args.workers, part=part)
    write_part(store, part, summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
