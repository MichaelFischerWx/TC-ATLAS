#!/usr/bin/env python3
"""Per-season storm index for the Global Archive "Season Replay" page.

One small JSON per year (tens of KB) listing every IBTrACS storm of that
season with its 3-hourly best-track positions + intensity, and — where the
GHOST reanalysis (ghost-ra, default version from versions.json) covers the
storm — GHOST's Vmax/Pmin at the same times. The replay page draws these
over the 8 km IR context frames (ir-context/v1), so a user can animate a
whole season with every storm labelled.

Inputs: ibtracs_storms.json + ibtracs_tracks_*.json (repo), GHOST-RA from
cdn.tcatlas.org/ghost-ra/<default>/ (index.json + storm/<sid>.json).

Output on R2 (public via cdn.tcatlas.org):
  archive/seasons/v1/{YYYY}.json   {"year", "ghost_version", "storms": [
      {"sid","name","atcf","basin","peak_kt","min_hpa",
       "t":[ISO..],"la":[..],"lo":[..],"bv":[..],"bp":[..],"n":[..],
       "gv":[..]|null,"gp":[..]|null}]}
  archive/seasons/v1/index.json    {"years": {YYYY: {n_storms, n_ghost}}}

Usage:
  python3 bin/build_season_index.py 1980            # one year → R2
  python3 bin/build_season_index.py 1980 2026       # range
  python3 bin/build_season_index.py 2005 --dry-run --out /tmp/seasons
"""
import argparse, glob, json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_ir_context import get_r2_client, R2_BUCKET  # noqa: E402

CDN = "https://cdn.tcatlas.org"
PREFIX = "archive/seasons/v1"
UA = {"User-Agent": "Mozilla/5.0 tc-atlas-season-builder"}   # the CDN's bot rule 403s bare python-urllib


def get_json(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


def load_ibtracs(repo):
    storms = json.load(open(os.path.join(repo, "ibtracs_storms.json")))
    storms = storms if isinstance(storms, list) else storms.get("storms", storms)
    tracks = {}
    for f in sorted(glob.glob(os.path.join(repo, "ibtracs_tracks_*.json"))):
        d = json.load(open(f))
        for k, v in d.items():
            if k[:4].isdigit() and isinstance(v, list):
                tracks[k] = v
    return storms, tracks


def load_ghost():
    v = get_json(f"{CDN}/ghost-ra/versions.json")
    ver = v.get("default") or v["versions"][-1]["dir"]
    idx = get_json(f"{CDN}/ghost-ra/{ver}/index.json")
    by_sid = {s["sid"]: s for s in idx.get("storms", [])}
    return ver, by_sid


def ghost_series(ver, sid):
    try:
        s = get_json(f"{CDN}/ghost-ra/{ver}/storm/{sid}.json")
    except Exception:
        return None
    lt, lv, lp = s.get("lt") or [], s.get("lv") or [], s.get("lp") or []
    if not lt:
        return None
    return {t: (lv[i] if i < len(lv) else None, lp[i] if i < len(lp) else None) for i, t in enumerate(lt)}


def build_year(year, storms, tracks, ghost_ver, ghost_idx, workers=8):
    ys = [s for s in storms if int(s.get("year", 0)) == year and s["sid"] in tracks]
    ghost_sids = [s["sid"] for s in ys if s["sid"] in ghost_idx]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        gmap = dict(zip(ghost_sids, pool.map(lambda sid: ghost_series(ghost_ver, sid), ghost_sids)))
    out = []
    for s in ys:
        pts = tracks[s["sid"]]
        t = [p["t"] for p in pts]
        rec = {
            "sid": s["sid"], "name": s.get("name") or "UNNAMED", "atcf": s.get("atcf_id"),
            "basin": s.get("basin"), "peak_kt": s.get("peak_wind_kt"), "min_hpa": s.get("min_pres_hpa"),
            "t": t,
            "la": [p.get("la") for p in pts], "lo": [p.get("lo") for p in pts],
            "bv": [p.get("w") for p in pts], "bp": [p.get("p") for p in pts],
            "n": [p.get("n") for p in pts],
            "gv": None, "gp": None,
        }
        g = gmap.get(s["sid"])
        if g:
            gv = [g.get(tt, (None, None))[0] for tt in t]
            gp = [g.get(tt, (None, None))[1] for tt in t]
            if any(x is not None for x in gv):
                rec["gv"], rec["gp"] = gv, gp
        out.append(rec)
    out.sort(key=lambda r: r["t"][0] if r["t"] else "")
    return {"year": year, "ghost_version": ghost_ver, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "n_storms": len(out), "n_ghost": sum(1 for r in out if r["gv"]), "storms": out}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("start", type=int); ap.add_argument("end", type=int, nargs="?")
    ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--out", default=os.path.expanduser("~/seasons_out"))
    a = ap.parse_args()
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    storms, tracks = load_ibtracs(repo)
    ghost_ver, ghost_idx = load_ghost()
    r2 = None if a.dry_run else get_r2_client()
    if a.dry_run:
        os.makedirs(a.out, exist_ok=True)
    years_meta = {}
    if r2:
        try:
            prev = json.loads(r2.get_object(Bucket=R2_BUCKET, Key=f"{PREFIX}/index.json")["Body"].read())
            years_meta = prev.get("years", {})
        except Exception:
            pass
    for year in range(a.start, (a.end or a.start) + 1):
        doc = build_year(year, storms, tracks, ghost_ver, ghost_idx)
        body = json.dumps(doc, separators=(",", ":")).encode()
        if a.dry_run:
            open(os.path.join(a.out, f"{year}.json"), "wb").write(body)
        else:
            r2.put_object(Bucket=R2_BUCKET, Key=f"{PREFIX}/{year}.json", Body=body,
                          ContentType="application/json", CacheControl="public, max-age=86400")
        years_meta[str(year)] = {"n_storms": doc["n_storms"], "n_ghost": doc["n_ghost"]}
        print(f"{year}: {doc['n_storms']} storms, {doc['n_ghost']} with GHOST ({ghost_ver}), {len(body)/1024:.0f} KB", flush=True)
    idx = json.dumps({"prefix": PREFIX, "ghost_version": ghost_ver, "years": years_meta,
                      "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, separators=(",", ":")).encode()
    if a.dry_run:
        open(os.path.join(a.out, "index.json"), "wb").write(idx)
    else:
        r2.put_object(Bucket=R2_BUCKET, Key=f"{PREFIX}/index.json", Body=idx, ContentType="application/json", CacheControl="public, max-age=3600")


if __name__ == "__main__":
    main()
