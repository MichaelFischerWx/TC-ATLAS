#!/usr/bin/env bash
# Keep the Global Archive IR context layer current (launchd, every 6 h —
# com.fischerwx.ir-context-refresh). Rebuilds a rolling 5-day window: the
# builder skips frames already on R2, and MergIR posts with ~1 day latency,
# so each run adds the newest frames and retries recent upstream gaps.
# The per-year index.json is max-age 3600, so new frames reach the page
# within an hour.
set -u
cd "$(dirname "$0")/.." || exit 1
START=$(date -u -v-5d +%F); END=$(date -u +%F)
echo "[$(date -u +%FT%TZ)] ir-context refresh $START → $END"
caffeinate -i python3 bin/build_ir_context.py --start "$START" --end "$END" --workers 2
rc=$?
echo "[$(date -u +%FT%TZ)] ir-context refresh done rc=$rc"
exit $rc
