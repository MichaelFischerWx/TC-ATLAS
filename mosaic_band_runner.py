#!/usr/bin/env python3
"""mosaic_band_runner.py — slim per-band orchestrator for the mosaic Cloud Run Job.

WHY: one process running ir→wv→vis accumulates glibc-arena garbage that
malloc_trim cannot return (cgroup-visible, getrusage-invisible), so by the VIS
band at the 19-00 UTC all-sats-daylight peak even the BASELINE full-disk read
no longer fits the 4 GiB tier (~10 failed executions/hr at the seasonal peak —
see project_mosaic_idx_oom). Running each band in a FRESH subprocess returns
ALL of a band's memory — arena floor included — to the OS at process exit, so
the VIS band starts with the container's full headroom instead of IR+WV's
leftovers.

Kept intentionally tiny (stdlib only, ~15 MB RSS) so the parent adds nothing to
the cgroup while a band child runs, and the kernel OOM killer always picks the
(biggest) child, never the orchestrator.

Containment: IR and WV upload before VIS runs; if the VIS child is still
OOM-killed at the extreme edge (SIGKILL → rc -9), that's the known accepted
drop — the frame self-heals in 10 min via the rolling window — so the execution
exits 0 instead of failing the whole job and paging. Any OTHER failure
(tracebacks, IR/WV dying at all) still fails the execution loudly.

Eye-fix handoff: the IR pass computes storm eye fixes, the WV pass augments
them with WV Tb and uploads the sidecar. Across processes that flows through
--eye-diags-out (ir) / --eye-diags-in (wv) as {ts: [diag,...]} JSON.

Usage: identical CLI to build_ir_mosaic.py; --bands is split and run serially:
  python mosaic_band_runner.py --r2 --storm --time --bands ir,wv,vis --frames 1
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone

BUILDER = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "build_ir_mosaic.py")


def log(msg):
    print(f"[band-runner] {msg}", flush=True)


def frame_ts():
    """The frame this run builds — build_ir_mosaic.main's formula (now - 20 min,
    floored to 10 min), computed ONCE and pinned on every child via --frame-ts,
    so a band that starts after the next 10-min boundary still builds the same
    frame (the backstop runs at +7 min, so its vis child would otherwise drift)."""
    now = datetime.now(timezone.utc) - timedelta(minutes=20)
    return now.replace(minute=now.minute - (now.minute % 10), second=0,
                       microsecond=0).strftime("%Y%m%d%H%M")


# ── Backstop (MOSAIC_BACKSTOP=1, the Cloud Run job) ──────────────────────────
# The primary builder runs on Michael's Mac at :00/:10/...; this job fires 7 min
# later and builds only the bands whose frame is NOT already in that band's
# frames.json — so a sleeping / offline / slow Mac costs nothing but Cloud Run
# time, and a healthy Mac costs one container start + three tiny GETs. Any read
# failure counts as "not published" (build): the safe direction.
_CDN = os.environ.get("MOSAIC_CDN_BASE", "https://cdn.tcatlas.org")
_UA = "tc-atlas-mosaic-backstop/1.0"   # Cloudflare 403s the default Python-urllib UA


def published(band, ts):
    prefix = os.environ.get("MOSAIC_R2_PREFIX", "mosaic-v3")
    url = f"{_CDN}/{prefix}/{band}/frames.json?t={int(time.time())}"  # bust the edge cache
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=10) as r:
            return ts in json.load(r).get("frames", [])
    except Exception as e:
        log(f"backstop: {band} frames.json unreadable ({e}) — building it")
        return False


def main():
    argv = sys.argv[1:]
    bands, rest = ["ir"], []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--bands":
            bands = [b.strip() for b in argv[i + 1].split(",") if b.strip()]
            i += 2
        elif a.startswith("--bands="):
            bands = [b.strip() for b in a.split("=", 1)[1].split(",") if b.strip()]
            i += 1
        else:
            rest.append(a)
            i += 1

    diags = os.path.join(tempfile.gettempdir(), "mosaic_eye_diags.json")
    try:
        os.unlink(diags)   # never let a previous run's fixes leak in
    except OSError:
        pass

    ts = frame_ts()
    if "--frame-ts" not in rest:
        rest += ["--frame-ts", ts]
    else:
        ts = rest[rest.index("--frame-ts") + 1]
    if os.environ.get("MOSAIC_BACKSTOP", "0") not in ("0", "false", "off", ""):
        missing = [b for b in bands if not published(b, ts)]
        if not missing:
            log(f"backstop: frame {ts} already published for {','.join(bands)} — nothing to do")
            sys.exit(0)
        log(f"backstop: frame {ts} missing {','.join(missing)} — building")
        bands = missing
    # Per-band wall clock (local runs set it; a hung S3 read must not hold the
    # lock past the next cycle). Unset = no limit (Cloud Run has task-timeout).
    band_timeout = float(os.environ.get("MOSAIC_BAND_TIMEOUT_S", "0")) or None

    hard_fail = None
    # Meteosat-9 pre-step: its own process, so the .nat download + satpy decode
    # transient never co-resides with a band child. Non-fatal: on failure the
    # bands simply blend without Meteosat-9 (read_met9_full_disk finds no cache).
    if os.environ.get("MOSAIC_MET9", "0") not in ("0", "false", "off", ""):
        fetch = os.path.join(os.path.dirname(BUILDER), "met9_fetch.py")
        log("── met9 fetch")
        try:
            rc = subprocess.run([sys.executable, fetch, "--dt", ts],
                                timeout=band_timeout).returncode
        except subprocess.TimeoutExpired:
            rc = "timeout"
        if rc != 0:
            log(f"met9 fetch failed (rc {rc}) — building without Meteosat-9")
    for band in bands:
        cmd = [sys.executable, BUILDER, "--bands", band] + rest
        if band == "ir" and "wv" in bands:
            cmd += ["--eye-diags-out", diags]     # hand fixes to the WV pass
        elif band == "wv" and os.path.exists(diags):
            cmd += ["--eye-diags-in", diags]      # augment + upload them
        log(f"── band {band}: {' '.join(cmd[1:])}")
        try:
            rc = subprocess.run(cmd, timeout=band_timeout).returncode
        except subprocess.TimeoutExpired:
            log(f"band {band} exceeded {band_timeout:.0f} s — killed (backstop rebuilds it)")
            hard_fail = hard_fail or 124
            continue
        if rc == 0:
            continue
        if band == "vis" and rc == -9:
            # cgroup OOM kill of the vis child at the seasonal peak: the known,
            # accepted intermittent drop (self-heals next cycle). IR/WV already
            # uploaded — don't fail the execution / page for it.
            log("band vis OOM-killed (rc -9) — accepted peak drop, continuing")
        else:
            log(f"band {band} FAILED (rc {rc})")
            hard_fail = hard_fail or rc

    sys.exit(1 if hard_fail else 0)


if __name__ == "__main__":
    main()
