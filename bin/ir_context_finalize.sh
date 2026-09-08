#!/usr/bin/env bash
# Runs after the main backfill finishes: one catch-up pass with the current
# builder (picks up frames that errored transiently in the main run, rebuilds
# every year index + the root index), then a coverage report. Anything still
# missing after this does not exist upstream (NCEI/GES DISC gaps).
#
#   nohup bash -c 'until grep -q "supervisor: build complete" ~/ir_context_build.log; do sleep 300; done; bin/ir_context_finalize.sh' > ~/ir_context_finalize.log 2>&1 &
set -u
cd "$(dirname "$0")/.." || exit 1
START="${1:-1980-01-01}"; END="${2:-2026-12-31}"
echo "[$(date -u +%FT%TZ)] finalize: catch-up pass $START → $END"
for pass in 1 2 3; do
  caffeinate -i -s python3 bin/build_ir_context.py --start "$START" --end "$END" --workers 8
  rc=$?
  echo "[$(date -u +%FT%TZ)] finalize: pass $pass exit $rc"
  [ $rc -ne 4 ] && break     # 0 = clean, 4 = transient errors remain → try again
  sleep 60
done
echo "[$(date -u +%FT%TZ)] finalize: storm sectors for the MergIR years that were built before sector cutting existed (1998-2001)"
caffeinate -i -s python3 bin/build_ir_context.py --start 1998-01-01 --end 2001-12-31 --sectors-only --workers 6
echo "[$(date -u +%FT%TZ)] finalize: sector pass exit $?"
echo "[$(date -u +%FT%TZ)] finalize: coverage report"
python3 bin/ir_context_coverage.py "${START:0:4}" "${END:0:4}" | tee ~/ir_context_coverage.txt | head -60
echo "[$(date -u +%FT%TZ)] finalize: done (full report in ~/ir_context_coverage.txt)"
