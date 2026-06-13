#!/usr/bin/env python3
"""
Standalone prewarm worker for the TC-ATLAS real-time satellite pipeline.

Runs ONE synchronous prewarm cycle and exits. Designed to run as a Cloud Run
Job on a Cloud Scheduler cadence (every ~10 min, matching the Himawari/GOES
Full Disk scan grid), replacing the in-process prewarm daemon that previously
forced the API to run with always-allocated CPU (min=1, cpu-throttling=false,
~$150/mo idle floor).

With this job handling the heavy render/upload work, the API service can run
cpu-throttled: it sets IR_INLINE_PREWARM=0, which disables the inline prewarm
daemon and the on-demand prefetch thread-spawn (see ir_monitor_api.py).

The job reuses the SAME container image as the API service, so it inherits the
identical render code, dependencies, and env-var contract (GCS_IR_CACHE_BUCKET,
EARTHDATA_*, AWS_* for NEXRAD prefetch, etc.).

── Quiet-tick cheap gate (cost) ────────────────────────────────────────────
Importing `ir_monitor_api` pulls in the full render stack (pyart, cartopy, …)
AND loads the ~13.5k-storm IBTrACS database at module init — ~3 min of 2-vCPU
cold-start work EVERY run. When there are no active storms, run_prewarm_cycle()
just early-exits (~12 s of real work), so at */10 that import tax was ~$50/mo
to render nothing. The gate below checks /active-storms over plain stdlib HTTP
BEFORE importing the heavy module: on a quiet off-hour tick it exits in ~1-2 s
with no import. The full cycle still runs when storms exist (so new-storm
pickup keeps its */10 responsiveness) or once per hour (so rt-version.json +
the off-season OG card stay fresh). Fail-safe: any uncertainty runs the full
cycle, and the API still renders frames on demand regardless.
"""
import os
import sys
import traceback


def _should_skip_quiet_cycle() -> bool:
    """True ⇒ skip the expensive full cycle this tick. Stdlib-only so the skip
    path never pays the heavy `import ir_monitor_api`. Skips ONLY when both:
      • this is NOT the hourly heartbeat tick (first */10 tick of the hour), and
      • /active-storms reports zero active storms.
    ANY error / unexpected shape ⇒ False (run the full cycle — never skip on
    uncertainty)."""
    import json
    import urllib.request
    from datetime import datetime, timezone

    # Hourly heartbeat: always run the first tick of each hour so rt-version
    # and the off-season OG card refresh even during a storm-free stretch.
    if datetime.now(timezone.utc).minute < 10:
        return False

    url = os.environ.get(
        "PREWARM_GATE_URL",
        "https://tc-atlas-api-ip2bfs76hq-ue.a.run.app/ir-monitor/active-storms",
    )
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[Prewarm Job] gate check failed ({e}) — running full cycle")
        return False

    storms = data.get("storms")
    if not isinstance(storms, list):
        # Unexpected response shape — don't trust it; run the full cycle.
        print("[Prewarm Job] gate: unexpected /active-storms shape — "
              "running full cycle")
        return False
    return len(storms) == 0


def main() -> int:
    if _should_skip_quiet_cycle():
        # MUST contain the literal "[Prewarm Job] Done:" token: the
        # prewarm_cycle_done log metric + 30-min absence alert (see
        # monitoring/) count this heartbeat on EVERY run, including 0-storm
        # ticks. A cheap skip is still a successful run, so emit it here too —
        # otherwise quiet ticks would go silent and false-fire the alert hourly.
        print("[Prewarm Job] Done: {'storm_count': 0, "
              "'skipped': 'quiet-tick cheap gate', 'heavy_import': False}")
        return 0
    try:
        # Imported HERE (not at module load) so the cheap-gate skip path above
        # never triggers the heavy pyart/cartopy/IBTrACS import.
        import ir_monitor_api
        summary = ir_monitor_api.run_prewarm_cycle()
        print(f"[Prewarm Job] Done: {summary}")
        return 0
    except Exception:
        print("[Prewarm Job] FAILED:", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
