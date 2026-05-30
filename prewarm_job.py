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
"""
import sys
import traceback

import ir_monitor_api


def main() -> int:
    try:
        summary = ir_monitor_api.run_prewarm_cycle()
        print(f"[Prewarm Job] Done: {summary}")
        return 0
    except Exception:
        print("[Prewarm Job] FAILED:", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
