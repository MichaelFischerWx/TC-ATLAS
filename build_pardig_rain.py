#!/usr/bin/env python3
"""DeepMind PARDIG near-real-time rain rate -> single-channel map tiles on R2.

PARDIG (Google DeepMind, CC BY 4.0, experimental) estimates near-surface rain
rate from geostationary imagery on a 0.1 deg global grid every 15 min. The
near-real-time run posts in 6-hourly batches tied to the ECMWF HRES cycles:
the newest frame is ~2 h old when a batch lands and ~8 h old just before the
next one.

Each run:
  1. lists the frames whose `success` marker exists in gs://pardig_1 (anonymous
     HTTPS, not requester-pays);
  2. builds any of the newest KEEP_FRAMES that R2 does not have yet: one
     1801x3600 float32 zstd chunk (m/h, latitude S->N, longitude 0..359.9)
     -> log-encoded rain index -> Web-Mercator 512-px tiles z0..ZMAX -> one
     content-hashed pack + index.json per frame (the mosaic-v3 pack format,
     so the RT monitor's packed-tile reader serves both);
  3. pairs each rain frame with the nearest archived IR mosaic frame on R2
     (mosaic-v3 keeps 54 h), so the global map shows IR from the rain's time
     underneath instead of the live IR hours later;
  4. rewrites <prefix>/rain/frames.json when anything changed and prunes frames
     older than ARCHIVE_HOURS.

Index encoding (frames.json "encoding"):
  0 = no data, 1 = dry (< DRY mm/h), 255 = at the model's 75 mm/h cap,
  2..254 = log-spaced bins over [DRY, CAP): bin k spans
           DRY * (CAP/DRY)**(k/NBINS) .. DRY * (CAP/DRY)**((k+1)/NBINS).
  z3-z4 sample the 0.1 deg grid nearest-neighbor (z3 ~= native resolution);
  z0-z2 are area means of the z3 rate field (mm/h), then re-encoded.

Usage:
  python3 build_pardig_rain.py                 # publish to R2 (needs R2 env)
  python3 build_pardig_rain.py --out DIR       # write tiles locally, no R2
  python3 build_pardig_rain.py --frames 4 --out DIR
"""
import argparse
import concurrent.futures as _cf
import hashlib
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

SRC_BUCKET = "pardig_1"
SRC_PREFIX = "NRT/zarr/2026_to_present/"
SRC_CHUNK = "predictions.zarr/precipitation/c/0/0"
GCS_LIST = f"https://storage.googleapis.com/storage/v1/b/{SRC_BUCKET}/o"
GCS_OBJ = f"https://storage.googleapis.com/{SRC_BUCKET}/"

NY, NX, RES = 1801, 3600, 0.1          # source grid: lat -90..90 (S->N), lon 0..359.9

R2_PREFIX = os.environ.get("PARDIG_R2_PREFIX", "pardig-v1")
PRODUCT = "rain"
IR_PREFIX = os.environ.get("PARDIG_IR_PREFIX", "mosaic-v3/ir")
KEEP_FRAMES = int(os.environ.get("PARDIG_KEEP_FRAMES", "24"))      # 6 h loop
ARCHIVE_HOURS = float(os.environ.get("PARDIG_ARCHIVE_HOURS", "72"))
IR_PAIR_MAX_MIN = 7                    # IR is every 10 min, rain every 15 -> |dt| <= 5

ZMAX = 4
TILE = 512
DRY = 0.1                              # mm/h
CAP = 75.0                             # PARDIG's own ceiling
CAP_AT = 74.995
NBINS = 253                            # idx 2..254
TILE_CACHE = "public, max-age=604800, immutable"
MANIFEST_CACHE = "public, max-age=60"
UA = "tc-atlas-pardig/1.0"

# Credit as Google DeepMind asks (developers.google.com/weathernext/guides/pardig
# and .../guides/disclaimers): CC BY 4.0, cite the paper, point to the
# third-party attributions, and state what we changed. Stamped into every
# frames.json because the tiles themselves are public on the CDN.
ATTRIBUTION = {
    "source": "PARDIG near-real-time rain rate, Google DeepMind (experimental)",
    "source_url": "https://developers.google.com/weathernext/guides/pardig",
    "license": "CC BY 4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "citation": ("Shalev, G., S. Rasp, B. Babenko, and Coauthors, 2026: PARDIG: Global precipitation "
                 "estimates learned from sparse satellite observations. arXiv:2611.13941."),
    "third_party_attributions": "https://storage.googleapis.com/weathernext-public/pardig-attributions-acknowledgements.pdf",
    "modifications": ("Resampled by TC-ATLAS from the 0.1 deg grid to Web-Mercator 512-px tiles (nearest "
                      "neighbor at z3-z4, area means at z0-z2) and binned into 253 log-spaced levels."),
    "disclaimer": "Experimental; not an official forecast or observation.",
}


def log(msg):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


def _get(url, timeout=120, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # network blip: back off and retry
            last = e
            time.sleep(2 * (i + 1))
    raise last


# ── Source listing ────────────────────────────────────────────────────────
def list_source_frames(hours=48):
    """{src_ts: posted_iso} for frames with a `success` marker in the last
    `hours` (src_ts like 20261114T103000). Posted = the marker's timeCreated."""
    start = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y%m%dT%H%M%S")
    q = {"prefix": SRC_PREFIX, "startOffset": SRC_PREFIX + start,
         "matchGlob": SRC_PREFIX + "*/success",
         "fields": "items(name,timeCreated),nextPageToken"}
    out, tok = {}, None
    while True:
        if tok:
            q["pageToken"] = tok
        j = json.loads(_get(GCS_LIST + "?" + urllib.parse.urlencode(q), timeout=60))
        for it in j.get("items", []):
            ts = it["name"][len(SRC_PREFIX):].split("/")[0]
            if len(ts) == 15 and ts[8] == "T":
                out[ts] = it["timeCreated"]
        tok = j.get("nextPageToken")
        if not tok:
            return out


def src_to_ts(s):          # 20261114T103000 -> 202611141030
    return s[:8] + s[9:13]


def ts_to_dt(ts):
    return datetime.strptime(ts, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def read_frame(src_ts):
    """Rain rate in mm/h, (1801, 3600), latitude S->N, longitude 0..359.9."""
    import zstandard
    raw = _get(f"{GCS_OBJ}{SRC_PREFIX}{src_ts}/{SRC_CHUNK}", timeout=180)
    buf = zstandard.ZstdDecompressor().decompress(raw, max_output_size=NY * NX * 4 + 1024)
    a = np.frombuffer(buf, "<f4").reshape(NY, NX) * np.float32(1000.0)
    return np.nan_to_num(a, nan=-1.0)          # NaN (none seen so far) -> no-data


# ── Encoding ──────────────────────────────────────────────────────────────
_LOGSPAN = np.log(CAP / DRY)


def encode(rate):
    """mm/h -> uint8 index (see module docstring)."""
    r = np.asarray(rate, dtype=np.float32)
    k = np.floor(NBINS * np.log(np.maximum(r, DRY) / DRY) / _LOGSPAN)
    idx = (2 + np.clip(k, 0, NBINS - 1)).astype(np.uint8)
    idx[r < DRY] = 1
    idx[r >= CAP_AT] = 255
    idx[r < 0] = 0
    return idx


def decode_center(idx):
    """Representative mm/h for an index (geometric bin center) — for tests."""
    idx = int(idx)
    if idx <= 1:
        return 0.0
    if idx == 255:
        return CAP
    k = idx - 2
    return float(DRY * (CAP / DRY) ** ((k + 0.5) / NBINS))


# ── Web-Mercator resampling ───────────────────────────────────────────────
_MAPS = {}


def mercator_maps(z):
    """(row_idx, col_idx) into the source grid for the 512*2^z square."""
    if z in _MAPS:
        return _MAPS[z]
    n = TILE * (1 << z)
    yc = (np.arange(n) + 0.5) / n
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * yc))))
    rows = np.clip(np.rint((lat + 90.0) / RES), 0, NY - 1).astype(np.int32)
    lon = (np.arange(n) + 0.5) / n * 360.0 - 180.0
    cols = (np.rint(np.mod(lon, 360.0) / RES).astype(np.int64) % NX).astype(np.int32)
    _MAPS[z] = (rows, cols)
    return _MAPS[z]


def block_mean(a, f):
    """Mean over f x f blocks; no-data (<0) cells are left out of the mean."""
    n = a.shape[0] // f
    v = a.reshape(n, f, n, f)
    ok = v >= 0
    s = np.where(ok, v, 0).sum(axis=(1, 3), dtype=np.float64)
    c = ok.sum(axis=(1, 3))
    out = np.full((n, n), -1.0, dtype=np.float32)
    np.divide(s, c, out=out, where=c > 0, casting="unsafe")
    return out


def _png(tile):
    from PIL import Image
    b = io.BytesIO()
    Image.fromarray(tile, "L").save(b, format="PNG", compress_level=9)
    return b.getvalue()


def frame_tiles(rate):
    """rate (S->N grid, mm/h) -> [(z, x, y, png_bytes)], skipping all-dry tiles
    (a tile absent from the pack index renders as no rain)."""
    entries = []
    r3, c3 = mercator_maps(3)
    z3 = rate[r3][:, c3]                                   # 4096^2 float32, N->S
    idx_src = encode(rate)
    grids = {}
    r4, c4 = mercator_maps(4)
    grids[4] = idx_src[r4][:, c4]
    grids[3] = encode(z3)
    for z, f in ((2, 2), (1, 4), (0, 8)):
        grids[z] = encode(block_mean(z3, f))
    del z3
    for z in range(ZMAX + 1):
        g = grids[z]
        n = 1 << z
        for ty in range(n):
            for tx in range(n):
                t = g[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE]
                if t.max() <= 1:
                    continue
                entries.append((z, tx, ty, _png(np.ascontiguousarray(t))))
    return entries


def build_pack(entries):
    """Same layout as build_ir_mosaic.build_pack_bytes: PNGs concatenated in
    (z, x, y) order; index.json maps "z/x/y" -> [offset, length]. The pack is
    content-hash named so a rebuild can never pair a cached index with
    another build's bytes."""
    entries = sorted(entries, key=lambda e: (e[0], e[1], e[2]))
    parts, index, off = [], {}, 0
    for z, x, y, body in entries:
        index[f"{z}/{x}/{y}"] = [off, len(body)]
        parts.append(body)
        off += len(body)
    pk = b"".join(parts)
    name = f"pack-{hashlib.sha1(pk).hexdigest()[:10]}.bin"
    ix = json.dumps({"pack": name, "tiles": index, "size": off, "count": len(parts)},
                    separators=(",", ":")).encode()
    return pk, ix, name


# ── R2 ────────────────────────────────────────────────────────────────────
_r2 = None


def r2():
    global _r2
    if _r2 is None:
        import boto3
        from botocore.config import Config
        ep = os.environ.get("R2_ENDPOINT_URL", "").rstrip("/")
        ak = os.environ.get("R2_ACCESS_KEY_ID", "")
        sk = os.environ.get("R2_SECRET_ACCESS_KEY", "")
        if not (ep and ak and sk):
            sys.exit("R2 creds missing: set R2_ENDPOINT_URL / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY")
        _r2 = boto3.client("s3", endpoint_url=ep, aws_access_key_id=ak,
                           aws_secret_access_key=sk, region_name="auto",
                           config=Config(signature_version="s3v4",
                                         retries={"max_attempts": 4, "mode": "standard"}))
    return _r2


def bucket():
    return os.environ.get("R2_BUCKET", "tc-atlas-rt")


def r2_put(key, body, ctype, cache):
    r2().put_object(Bucket=bucket(), Key=key, Body=body, ContentType=ctype, CacheControl=cache)


def r2_ts_prefixes(base):
    """12-digit timestamps of the <base>/<ts>/ prefixes on R2."""
    out, tok = set(), None
    while True:
        kw = {"Bucket": bucket(), "Prefix": base.rstrip("/") + "/", "Delimiter": "/", "MaxKeys": 1000}
        if tok:
            kw["ContinuationToken"] = tok
        resp = r2().list_objects_v2(**kw)
        for cp in resp.get("CommonPrefixes", []):
            ts = cp["Prefix"][len(kw["Prefix"]):].strip("/")
            if len(ts) == 12 and ts.isdigit():
                out.add(ts)
        if not resp.get("IsTruncated"):
            return out
        tok = resp.get("NextContinuationToken")


def r2_delete_prefix(prefix):
    n, tok = 0, None
    while True:
        kw = {"Bucket": bucket(), "Prefix": prefix, "MaxKeys": 1000}
        if tok:
            kw["ContinuationToken"] = tok
        resp = r2().list_objects_v2(**kw)
        keys = [{"Key": o["Key"]} for o in resp.get("Contents", [])]
        if keys:
            r2().delete_objects(Bucket=bucket(), Delete={"Objects": keys, "Quiet": True})
            n += len(keys)
        if not resp.get("IsTruncated"):
            return n
        tok = resp.get("NextContinuationToken")


def r2_get_json(key):
    try:
        return json.loads(r2().get_object(Bucket=bucket(), Key=key)["Body"].read())
    except Exception:
        return None


# ── IR pairing ────────────────────────────────────────────────────────────
def pair_ir(rain_ts, ir_ts):
    """Nearest IR mosaic frame within IR_PAIR_MAX_MIN; ties go to the earlier."""
    t0 = ts_to_dt(rain_ts)
    best, bd = None, None
    for s in ir_ts:
        d = abs((ts_to_dt(s) - t0).total_seconds()) / 60.0
        if d > IR_PAIR_MAX_MIN:
            continue
        if bd is None or d < bd or (d == bd and s < best):
            best, bd = s, d
    return best


# ── Main ──────────────────────────────────────────────────────────────────
def build_one(src_ts, out_dir=None):
    t0 = time.time()
    ts = src_to_ts(src_ts)
    rate = read_frame(src_ts)
    t1 = time.time()
    entries = frame_tiles(rate)
    pk, ix, name = build_pack(entries)
    t2 = time.time()
    base = f"{R2_PREFIX}/{PRODUCT}/{ts}"
    if out_dir:
        d = os.path.join(out_dir, PRODUCT, ts)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "wb") as f:
            f.write(pk)
        with open(os.path.join(d, "index.json"), "wb") as f:
            f.write(ix)
    else:
        r2_put(f"{base}/{name}", pk, "application/octet-stream", TILE_CACHE)
        r2_put(f"{base}/index.json", ix, "application/json", TILE_CACHE)   # after the pack
    log(f"  {ts}: {len(entries)} tiles, {len(pk) / 1e3:.0f} kB "
        f"(read {t1 - t0:.1f}s, tile {t2 - t1:.1f}s, put {time.time() - t2:.1f}s)")
    return ts


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--frames", type=int, default=KEEP_FRAMES, help="newest N frames to keep/build")
    ap.add_argument("--out", help="write tiles + frames.json under this dir instead of R2")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    t_start = time.time()

    src = list_source_frames()
    if not src:
        log("no PARDIG frames with a success marker in the last 48 h — nothing to do")
        return 0
    want_src = sorted(src)[-args.frames:]
    want = [src_to_ts(s) for s in want_src]
    log(f"PARDIG: {len(src)} frames in 48 h; newest {want[-1]} posted {src[want_src[-1]]}")

    if args.out:
        built = {t for t in want if os.path.exists(os.path.join(args.out, PRODUCT, t, "index.json"))}
    else:
        built = r2_ts_prefixes(f"{R2_PREFIX}/{PRODUCT}")
    todo = [s for s in want_src if src_to_ts(s) not in built]
    failed = set()
    if todo:
        log(f"building {len(todo)} frame(s)")
        with _cf.ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
            futs = {ex.submit(build_one, s, args.out): s for s in todo}
            for f in _cf.as_completed(futs):
                try:
                    built.add(f.result())
                except Exception as e:
                    failed.add(src_to_ts(futs[f]))
                    log(f"  FAILED {futs[f]}: {e!r}")
    frames = [t for t in want if t in built and t not in failed]

    ir_ts = set() if args.out else r2_ts_prefixes(IR_PREFIX)
    posted = {src_to_ts(s): src[s] for s in want_src}
    manifest = {
        "frames": frames,
        "posted": {t: posted[t] for t in frames},
        "ir_pair": {t: pair_ir(t, ir_ts) for t in frames},
        "zmax": ZMAX, "tile_size": TILE,
        "encoding": {"kind": "log", "dry_mm_h": DRY, "cap_mm_h": CAP, "bins": NBINS,
                     "idx_nodata": 0, "idx_dry": 1, "idx_first": 2, "idx_cap": 255},
        **ATTRIBUTION,
    }
    key = f"{R2_PREFIX}/{PRODUCT}/frames.json"
    cur = (json.load(open(os.path.join(args.out, PRODUCT, "frames.json")))
           if args.out and os.path.exists(os.path.join(args.out, PRODUCT, "frames.json"))
           else (None if args.out else r2_get_json(key)))
    if cur:
        cur = {k: v for k, v in cur.items() if k != "updated"}
    if cur != manifest and frames:
        manifest["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        body = json.dumps(manifest, separators=(",", ":")).encode()
        if args.out:
            with open(os.path.join(args.out, PRODUCT, "frames.json"), "wb") as f:
                f.write(body)
        else:
            r2_put(key, body, "application/json", MANIFEST_CACHE)
        unpaired = [t for t in frames if not manifest["ir_pair"][t]]
        log(f"frames.json: {len(frames)} frames {frames[0]}..{frames[-1]}"
            + (f"; no IR pair for {unpaired}" if unpaired else ""))
    else:
        log("frames.json unchanged")

    if not args.out:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=ARCHIVE_HOURS)).strftime("%Y%m%d%H%M")
        keep = set(frames)
        for t in sorted(built):
            if t < cutoff and t not in keep:
                n = r2_delete_prefix(f"{R2_PREFIX}/{PRODUCT}/{t}/")
                log(f"  pruned {t} ({n} objects)")
    log(f"done in {time.time() - t_start:.1f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
