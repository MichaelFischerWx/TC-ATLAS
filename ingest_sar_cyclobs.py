#!/usr/bin/env python3
"""
ingest_sar_cyclobs.py — Mirror IFREMER CyclObs SAR TC archive to GCS as COGs.

For each SAR acquisition in the CyclObs database:
  1. Pull the L2 OVW NetCDF (wind grid, ~5 MB)
  2. Pull the SARFIX+ NetCDF (center fix / RMW / R34-50-64, ~4 MB) when present
  3. Convert wind_speed (+ wind_direction if available) to a 2-band float32
     Cloud-Optimized GeoTIFF (DEFLATE), ~100-200 KB per scene
  4. Write a small JSON sidecar with SARFIX+ metadata + bbox + max wind
  5. Upload .tif + .json to gs://$GCS_SAR_BUCKET/v1/sar/{SID}/{ACQ}_{SAT}.{tif,json}
  6. Maintain per-storm and global indexes consumed by sar_api.py

The full archive (~2,900 acquisitions as of 2026-05) compresses from ~23 GB of
source NetCDFs to ~0.5 GB of COGs. Storage cost on Standard regional is
under $0.02/month at v1 scale.

Usage:
    # Mirror everything (one-shot)
    python ingest_sar_cyclobs.py

    # Single storm (for testing)
    python ingest_sar_cyclobs.py --sid 2019252N16331

    # Specific year range
    python ingest_sar_cyclobs.py --year-start 2024 --year-end 2026

    # Dry run: list what would be ingested
    python ingest_sar_cyclobs.py --dry-run

    # Resume an interrupted run (skip already-uploaded acquisitions)
    python ingest_sar_cyclobs.py --resume

    # Tune parallelism
    python ingest_sar_cyclobs.py --workers 8

Environment variables:
    GCS_SAR_BUCKET                  (default: "tc-atlas-sar")
    GOOGLE_APPLICATION_CREDENTIALS  (path to GCS service account key)
"""

import argparse
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.parse import urlencode

# ---------------------------------------------------------------------------
# Dependency check — install missing packages automatically
# ---------------------------------------------------------------------------

REQUIRED_PACKAGES = {
    "requests": "requests",
    "numpy": "numpy",
    "xarray": "xarray",
    "netCDF4": "netCDF4",
    "rasterio": "rasterio",
    "rioxarray": "rioxarray",
    "google.cloud.storage": "google-cloud-storage",
}


def _check_deps(dry_run=False):
    check = {"requests": "requests"} if dry_run else REQUIRED_PACKAGES
    missing = []
    for import_name, pip_name in check.items():
        try:
            __import__(import_name)
        except ImportError:
            missing.append(pip_name)
    if missing:
        print(f"Installing missing packages: {', '.join(missing)}")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet"] + missing
            )
        except subprocess.CalledProcessError:
            print(f"ERROR: pip install failed for: {', '.join(missing)}")
            sys.exit(1)


_check_deps(dry_run="--dry-run" in sys.argv)

import numpy as np
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CYCLOBS_API = "https://cyclobs.ifremer.fr/app/api/getData"
CYCLOBS_STATIC = "https://cyclobs.ifremer.fr/static/sarwing_datarmor"

GCS_SAR_VERSION = "v1"
DEFAULT_BUCKET = "tc-atlas-sar"

# CyclObs columns we request. Names follow the documented schema at
# https://cyclobs.ifremer.fr/app/docs/Retrieve_data_from_API.html
# The script is defensive about which of these actually come back populated.
REQUESTED_COLUMNS = [
    "sid",
    "cyclone_name",
    "data_url",
    "acquisition_start_time",
    "instrument",
    "mission",
    "tcva_url",
    "wind_max_kt",
]

# HTTP tuning
HTTP_TIMEOUT = (15, 90)        # (connect, read) seconds
HTTP_RETRY = 3
HTTP_BACKOFF = 4.0             # multiplied by attempt number

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ingest_sar_cyclobs")


# ---------------------------------------------------------------------------
# CyclObs listing
# ---------------------------------------------------------------------------

def list_acquisitions(year_start=None, year_end=None, sid=None, instrument=None):
    """
    Hit the CyclObs getData endpoint and return a list of acquisition dicts.

    We request JSON to avoid CSV quoting edge cases. The endpoint accepts:
      - include_cols=col1,col2,...
      - mission=...    (S1A,S1B,S1C,RS2,RCM-1,...)
      - instrument=C-Band_SAR
      - sid=<IBTrACS SID>
      - start_date / stop_date  (ISO yyyy-mm-dd)
      - format=json
    """
    params = {
        "include_cols": ",".join(REQUESTED_COLUMNS),
        "instrument": instrument or "C-Band_SAR",
        "format": "json",
    }
    if sid:
        params["sid"] = sid
    if year_start:
        params["start_date"] = f"{year_start}-01-01"
    if year_end:
        params["stop_date"] = f"{year_end}-12-31"

    url = f"{CYCLOBS_API}?{urlencode(params)}"
    log.info(f"CyclObs listing: {url}")

    for attempt in range(HTTP_RETRY):
        try:
            r = requests.get(url, timeout=HTTP_TIMEOUT)
            r.raise_for_status()
            payload = r.json()
            # API may return either a bare list or {"data": [...]}
            rows = payload if isinstance(payload, list) else payload.get("data", [])
            log.info(f"  → {len(rows)} acquisitions")
            return rows
        except Exception as e:
            log.warning(f"  listing attempt {attempt+1}/{HTTP_RETRY} failed: {e}")
            time.sleep(HTTP_BACKOFF * (attempt + 1))
    raise RuntimeError(f"CyclObs listing failed after {HTTP_RETRY} attempts")


def _row_field(row, *candidates):
    """Return the first non-empty field among candidate column names."""
    for c in candidates:
        v = row.get(c)
        if v not in (None, "", "null"):
            return v
    return None


def normalize_row(row):
    """
    Normalize a CyclObs row to the fields the rest of the pipeline expects.

    CyclObs has slightly different column conventions across product versions
    (e.g. acquisition_start_time vs measurementStartDate). Keep this tolerant.
    """
    sid = _row_field(row, "sid", "SID")
    acq = _row_field(row, "acquisition_start_time", "measurementStartDate", "time_coverage_start")
    mission = _row_field(row, "mission", "platform") or "unknown"
    ovw_url = _row_field(row, "data_url", "ll_gd_url", "ovw_url")
    tcva_url = _row_field(row, "tcva_url", "sarfix_url")
    wmax = _row_field(row, "wind_max_kt", "wind_max", "vmax_kt")
    cname = _row_field(row, "cyclone_name", "name") or ""

    if not sid or not acq or not ovw_url:
        return None

    # Normalize acquisition time to ISO basic (no colons) for filenames
    try:
        if isinstance(acq, (int, float)):
            t = datetime.utcfromtimestamp(float(acq))
        else:
            t = datetime.fromisoformat(str(acq).replace("Z", "").rstrip("+00:00"))
    except Exception:
        return None
    acq_basic = t.strftime("%Y%m%dT%H%M%S")

    # CyclObs paths in listings may be relative; promote to absolute.
    def _absolute(u):
        if u and u.startswith("/"):
            return f"https://cyclobs.ifremer.fr{u}"
        return u

    return {
        "sid": sid,
        "name": cname,
        "mission": mission,
        "acquired": t.isoformat() + "Z",
        "acquired_basic": acq_basic,
        "ovw_url": _absolute(ovw_url),
        "tcva_url": _absolute(tcva_url) if tcva_url else None,
        "wind_max_kt": float(wmax) if wmax not in (None, "") else None,
    }


# ---------------------------------------------------------------------------
# Download + COG conversion
# ---------------------------------------------------------------------------

def http_get(url, dest_path):
    """Stream a URL to a local file with retries."""
    for attempt in range(HTTP_RETRY):
        try:
            with requests.get(url, stream=True, timeout=HTTP_TIMEOUT) as r:
                r.raise_for_status()
                with open(dest_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1 << 16):
                        if chunk:
                            f.write(chunk)
            return True
        except Exception as e:
            log.debug(f"  GET {url} attempt {attempt+1} failed: {e}")
            time.sleep(HTTP_BACKOFF * (attempt + 1))
    return False


def ovw_to_cog(nc_path, cog_path):
    """
    Convert a CyclObs L2 OVW (nclight_L2M_ll_gd) NetCDF to a 1- or 2-band
    Cloud-Optimized GeoTIFF.

    Band 1: wind_speed (m/s)
    Band 2: wind_direction (deg, meteorological convention) — only if present

    Returns metadata dict with bbox and grid stats.
    """
    import xarray as xr
    import rioxarray  # noqa: F401  — registers .rio accessor

    ds = xr.open_dataset(nc_path)
    try:
        if "wind_speed" not in ds.variables:
            raise RuntimeError(f"{nc_path}: no wind_speed variable")

        ws = ds["wind_speed"].astype("float32")
        # Ensure lat/lon dimension order and CRS
        if "lat" in ws.dims and "lon" in ws.dims:
            ws = ws.rename({"lon": "x", "lat": "y"})
        ws.rio.write_crs("EPSG:4326", inplace=True)
        # rioxarray wants y descending (north-up) for many drivers
        if float(ws.y[0]) < float(ws.y[-1]):
            ws = ws.isel(y=slice(None, None, -1))

        bands = [ws]
        descriptions = ["wind_speed_m_s"]
        if "wind_direction" in ds.variables:
            wd = ds["wind_direction"].astype("float32")
            if "lat" in wd.dims and "lon" in wd.dims:
                wd = wd.rename({"lon": "x", "lat": "y"})
            wd.rio.write_crs("EPSG:4326", inplace=True)
            if float(wd.y[0]) < float(wd.y[-1]):
                wd = wd.isel(y=slice(None, None, -1))
            bands.append(wd)
            descriptions.append("wind_direction_deg")

        # Stack to (band, y, x) and write COG
        stack = xr.concat(bands, dim="band")
        stack = stack.assign_coords(band=("band", list(range(1, len(bands) + 1))))
        stack.rio.write_crs("EPSG:4326", inplace=True)

        stack.rio.to_raster(
            cog_path,
            driver="COG",
            compress="DEFLATE",
            predictor=3,           # float-friendly predictor
            blocksize=512,
            overview_resampling="average",
            BIGTIFF="IF_SAFER",
        )

        # Apply band descriptions
        try:
            import rasterio
            with rasterio.open(cog_path, "r+") as src:
                for i, name in enumerate(descriptions, start=1):
                    src.set_band_description(i, name)
        except Exception:
            pass  # descriptions are nice-to-have

        bbox = {
            "west":  float(np.nanmin(ws.x.values)),
            "east":  float(np.nanmax(ws.x.values)),
            "south": float(np.nanmin(ws.y.values)),
            "north": float(np.nanmax(ws.y.values)),
        }
        ws_finite = ws.values[np.isfinite(ws.values)]
        ws_stats = {
            "max_m_s": float(np.nanmax(ws_finite)) if ws_finite.size else None,
            "mean_m_s": float(np.nanmean(ws_finite)) if ws_finite.size else None,
            "n_pixels": int(ws_finite.size),
        }
        return {
            "bbox": bbox,
            "shape": [int(ws.sizes["y"]), int(ws.sizes["x"])],
            "wind_speed": ws_stats,
            "has_direction": len(bands) > 1,
        }
    finally:
        ds.close()


def extract_sarfix(tcva_path):
    """
    Pull the small handful of fields we care about from a SARFIX+ NetCDF.

    Returns {} if the file is unreadable or has none of the expected vars,
    so callers can merge it unconditionally into the sidecar.
    """
    import xarray as xr

    try:
        ds = xr.open_dataset(tcva_path)
    except Exception as e:
        log.debug(f"  SARFIX+ open failed: {e}")
        return {}

    def _scalar(name):
        if name in ds.variables or name in ds.attrs:
            try:
                v = ds[name].values if name in ds.variables else ds.attrs[name]
                v = float(np.asarray(v).reshape(-1)[0])
                if not np.isfinite(v):
                    return None
                return v
            except Exception:
                return None
        return None

    out = {}
    for key, names in {
        "center_lat": ["cyclone_center_latitude", "center_lat", "lat_center"],
        "center_lon": ["cyclone_center_longitude", "center_lon", "lon_center"],
        "rmw_km":     ["rmw", "radius_max_wind"],
        "r34_km":     ["r34", "radius_34kt"],
        "r50_km":     ["r50", "radius_50kt"],
        "r64_km":     ["r64", "radius_64kt"],
        "vmax_kt":    ["wind_max", "vmax"],
    }.items():
        for n in names:
            v = _scalar(n)
            if v is not None:
                out[key] = v
                break

    try:
        ds.close()
    except Exception:
        pass
    return out


# ---------------------------------------------------------------------------
# GCS helpers
# ---------------------------------------------------------------------------

_gcs_bucket = None


def get_bucket(name=None):
    global _gcs_bucket
    if _gcs_bucket is not None:
        return _gcs_bucket
    bucket_name = name or os.environ.get("GCS_SAR_BUCKET", DEFAULT_BUCKET)
    from google.cloud import storage
    client = storage.Client()
    _gcs_bucket = client.bucket(bucket_name)
    log.info(f"GCS bucket: {bucket_name}")
    return _gcs_bucket


def key_for(sid, acq_basic, mission, ext):
    return f"{GCS_SAR_VERSION}/sar/{sid}/{acq_basic}_{mission}.{ext}"


def blob_exists(bucket, key):
    return bucket.blob(key).exists()


def upload_file(bucket, key, local_path, content_type, cache_seconds=86400):
    blob = bucket.blob(key)
    blob.cache_control = f"public, max-age={cache_seconds}"
    blob.upload_from_filename(local_path, content_type=content_type, timeout=60)


def upload_json(bucket, key, obj, cache_seconds=300):
    blob = bucket.blob(key)
    blob.cache_control = f"public, max-age={cache_seconds}"
    blob.upload_from_string(
        json.dumps(obj, separators=(",", ":")),
        content_type="application/json",
        timeout=30,
    )


# ---------------------------------------------------------------------------
# Per-acquisition pipeline
# ---------------------------------------------------------------------------

def process_acquisition(row, bucket, resume=False):
    """
    Download → convert → upload one CyclObs acquisition.
    Returns a sidecar dict on success, None on skip/failure.
    """
    sid = row["sid"]
    mission = row["mission"].replace(" ", "")
    acq_basic = row["acquired_basic"]

    tif_key = key_for(sid, acq_basic, mission, "tif")
    json_key = key_for(sid, acq_basic, mission, "json")

    if resume and blob_exists(bucket, tif_key) and blob_exists(bucket, json_key):
        return None

    with tempfile.TemporaryDirectory(prefix="sar_") as tmp:
        nc_path = os.path.join(tmp, "ovw.nc")
        tif_path = os.path.join(tmp, "ovw.tif")

        if not http_get(row["ovw_url"], nc_path):
            log.warning(f"  download failed: {sid} {acq_basic} {mission}")
            return None

        try:
            cog_meta = ovw_to_cog(nc_path, tif_path)
        except Exception as e:
            log.warning(f"  COG conversion failed for {sid} {acq_basic}: {e}")
            return None

        sarfix = {}
        if row.get("tcva_url"):
            tcva_path = os.path.join(tmp, "tcva.nc")
            if http_get(row["tcva_url"], tcva_path):
                sarfix = extract_sarfix(tcva_path)

        sidecar = {
            "sid": sid,
            "name": row.get("name"),
            "mission": mission,
            "acquired": row["acquired"],
            "wind_max_kt": row.get("wind_max_kt"),
            "geotiff_url": f"https://storage.googleapis.com/{bucket.name}/{tif_key}",
            "bbox": cog_meta["bbox"],
            "shape": cog_meta["shape"],
            "wind_speed": cog_meta["wind_speed"],
            "has_direction": cog_meta["has_direction"],
            "sarfix": sarfix,
            "source": "cyclobs.ifremer.fr",
            "ingested": datetime.utcnow().isoformat() + "Z",
        }

        try:
            upload_file(bucket, tif_key, tif_path, content_type="image/tiff",
                        cache_seconds=86400 * 7)
            upload_json(bucket, json_key, sidecar)
        except Exception as e:
            log.error(f"  upload failed for {sid} {acq_basic}: {e}")
            return None

        return sidecar


def build_storm_index(bucket, sid, sidecars):
    """Write per-storm index.json listing every acquisition for a storm."""
    sidecars = sorted(sidecars, key=lambda s: s["acquired"])
    obj = {
        "sid": sid,
        "name": sidecars[0].get("name") if sidecars else None,
        "n_acquisitions": len(sidecars),
        "acquisitions": [
            {
                "acquired": s["acquired"],
                "mission": s["mission"],
                "geotiff_url": s["geotiff_url"],
                "bbox": s["bbox"],
                "wind_max_kt": s.get("wind_max_kt"),
                "sarfix": s.get("sarfix", {}),
            }
            for s in sidecars
        ],
        "updated": datetime.utcnow().isoformat() + "Z",
    }
    upload_json(bucket, f"{GCS_SAR_VERSION}/sar/{sid}/index.json", obj, cache_seconds=300)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Mirror CyclObs SAR TC archive to GCS as COGs")
    p.add_argument("--bucket", default=None, help=f"GCS bucket (default: ${{GCS_SAR_BUCKET}} or {DEFAULT_BUCKET})")
    p.add_argument("--sid", default=None, help="Process a single IBTrACS SID")
    p.add_argument("--year-start", type=int, default=None)
    p.add_argument("--year-end", type=int, default=None)
    p.add_argument("--mission", default=None, help="Filter to one mission (S1A, RCM-1, RS2, ...)")
    p.add_argument("--workers", type=int, default=4, help="Parallel downloads (default 4)")
    p.add_argument("--limit", type=int, default=None, help="Stop after N acquisitions (testing)")
    p.add_argument("--resume", action="store_true", help="Skip acquisitions already in GCS")
    p.add_argument("--dry-run", action="store_true", help="List acquisitions without downloading")
    args = p.parse_args()

    rows_raw = list_acquisitions(
        year_start=args.year_start,
        year_end=args.year_end,
        sid=args.sid,
        instrument=args.mission and None,  # mission filter applied below
    )

    rows = []
    for r in rows_raw:
        norm = normalize_row(r)
        if not norm:
            continue
        if args.mission and norm["mission"] != args.mission:
            continue
        rows.append(norm)

    if args.limit:
        rows = rows[: args.limit]

    log.info(f"Acquisitions to process: {len(rows)}")

    if args.dry_run:
        for r in rows[:20]:
            log.info(f"  {r['sid']}  {r['acquired']}  {r['mission']}  {r['ovw_url']}")
        if len(rows) > 20:
            log.info(f"  ... ({len(rows) - 20} more)")
        # ~5 MB OVW + ~4 MB SARFIX+ ≈ 9 MB per acquisition over the wire,
        # ~150 KB COG + ~2 KB sidecar after conversion.
        log.info(f"Estimated source download: {len(rows) * 9 / 1024:.2f} GB")
        log.info(f"Estimated COG storage:    {len(rows) * 0.15 / 1024:.3f} GB")
        return

    bucket = get_bucket(args.bucket)

    per_storm = {}  # sid -> list[sidecar]
    n_ok = 0
    n_skip = 0
    n_fail = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process_acquisition, r, bucket, args.resume): r for r in rows}
        for i, fut in enumerate(as_completed(futures), start=1):
            row = futures[fut]
            try:
                sidecar = fut.result()
            except Exception as e:
                log.error(f"  worker exception for {row['sid']} {row['acquired_basic']}: {e}")
                n_fail += 1
                continue

            if sidecar is None:
                n_skip += 1
            else:
                n_ok += 1
                per_storm.setdefault(sidecar["sid"], []).append(sidecar)

            if i % 25 == 0 or i == len(rows):
                elapsed = time.time() - t0
                rate = i / elapsed if elapsed > 0 else 0
                eta_min = (len(rows) - i) / rate / 60 if rate > 0 else 0
                log.info(
                    f"  [{i}/{len(rows)}]  ok={n_ok}  skip={n_skip}  fail={n_fail}"
                    f"  |  {rate:.1f}/s  ETA {eta_min:.1f} min"
                )

    log.info("Writing per-storm indexes…")
    for sid, sidecars in per_storm.items():
        try:
            build_storm_index(bucket, sid, sidecars)
        except Exception as e:
            log.error(f"  storm index failed for {sid}: {e}")

    log.info(
        f"\n{'='*60}\n"
        f"DONE  ok={n_ok}  skip={n_skip}  fail={n_fail}  "
        f"storms={len(per_storm)}  elapsed={(time.time()-t0)/60:.1f} min\n"
        f"{'='*60}"
    )


if __name__ == "__main__":
    main()
