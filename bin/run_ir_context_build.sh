#!/usr/bin/env bash
# Supervisor for bin/build_ir_context.py on the Mac.
#
# Survives sleep, lid-close, network drops and crashes: the builder is
# resumable (R2 is the progress record; a rerun skips frames that already
# exist), so this loop just restarts it until it exits 0 ("all done").
# caffeinate -i -s keeps the machine from idle-sleeping while it runs
# (lid-close on battery still sleeps; the loop resumes on wake — nothing
# is lost except the frames that were mid-download, which are rebuilt).
#
#   nohup bin/run_ir_context_build.sh 1980-01-01 2026-12-31 > ~/ir_context_build.log 2>&1 &
#   tail -f ~/ir_context_build.log
#   touch ~/.ir_context_stop        # graceful stop after the current pass
set -u
START="${1:?start YYYY-MM-DD}"; END="${2:?end YYYY-MM-DD}"; WORKERS="${3:-4}"
cd "$(dirname "$0")/.." || exit 1
STOPFILE="$HOME/.ir_context_stop"; rm -f "$STOPFILE"
attempt=0
while :; do
  attempt=$((attempt+1))
  echo "[$(date -u +%FT%TZ)] supervisor: pass $attempt ($START → $END, $WORKERS workers)"
  caffeinate -i -s python3 bin/build_ir_context.py --start "$START" --end "$END" --workers "$WORKERS"
  rc=$?
  if [ $rc -eq 0 ]; then echo "[$(date -u +%FT%TZ)] supervisor: build complete"; break; fi
  if [ -f "$STOPFILE" ] || [ $rc -eq 3 ]; then echo "[$(date -u +%FT%TZ)] supervisor: stopped (rc=$rc)"; break; fi
  echo "[$(date -u +%FT%TZ)] supervisor: builder exited rc=$rc; restarting in 60 s"
  sleep 60
done
