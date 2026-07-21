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
import os
import subprocess
import sys
import tempfile

BUILDER = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "build_ir_mosaic.py")


def log(msg):
    print(f"[band-runner] {msg}", flush=True)


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

    hard_fail = None
    for band in bands:
        cmd = [sys.executable, BUILDER, "--bands", band] + rest
        if band == "ir" and "wv" in bands:
            cmd += ["--eye-diags-out", diags]     # hand fixes to the WV pass
        elif band == "wv" and os.path.exists(diags):
            cmd += ["--eye-diags-in", diags]      # augment + upload them
        log(f"── band {band}: {' '.join(cmd[1:])}")
        rc = subprocess.run(cmd).returncode
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
