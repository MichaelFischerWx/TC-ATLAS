#!/bin/bash
# --------------------------------------------------------------------------
# Global satellite mosaic — LOCAL primary builder (Michael's Mac, launchd).
# --------------------------------------------------------------------------
# Fires at :00/:10/:20/... (com.fischerwx.tcatlas-mosaic) and runs the SAME
# band runner the Cloud Run job uses (ir → wv → vis, each its own process),
# publishing to R2 mosaic-v3/ from home: Cloud Run compute and the job's
# GCP→R2 egress (~$62/mo together) drop to ~$1/mo.
#
# BACKSTOP: tc-atlas-mosaic-idx still runs on Cloud Run, 7 min later
# (MOSAIC_BACKSTOP=1, schedule 7-59/10). It checks each band's frames.json and
# builds only what this machine didn't publish — so a closed lid, a slow pass,
# or a failed run costs Cloud Run time, never a frame. Nothing here tries to
# detect failure; not publishing IS the signal.
#
# Code runs from an immutable snapshot (~/.tcatlas-mosaic/code, written by
# bin/install_mosaic_local.sh from git HEAD), never the working tree: this repo
# is edited by concurrent sessions, and a band that imports a half-edited
# build_ir_mosaic.py would publish garbage.
#
# Pause:   touch ~/.tcatlas-mosaic/STOP      (rm to resume)
# Logs:    ~/Library/Logs/tcatlas-mosaic.log
# Config:  ~/.tcatlas-mosaic/env (sourced; e.g. MOSAIC_MET9=1 at Meteosat go-live)
# --------------------------------------------------------------------------
set -u
HOME_DIR="${HOME}/.tcatlas-mosaic"
CODE="${HOME_DIR}/code"
PY="${HOME}/.venvs/tcatlas-mosaic/bin/python"
GCLOUD=/opt/homebrew/bin/gcloud          # absolute: launchd's PATH is minimal
LOCK="${HOME_DIR}/lock.d"
STALE_S=720                              # a lock older than this is a frozen (slept) run

log() { echo "[mosaic-local $(date -u +%H:%M:%SZ)] $*"; }

# launchd appends stdout here forever (~1.5 MB/day); keep the newest ~20k lines.
LOGF="${HOME}/Library/Logs/tcatlas-mosaic.log"
if [ -f "${LOGF}" ] && [ "$(stat -f %z "${LOGF}")" -gt 20000000 ]; then
    tail -n 20000 "${LOGF}" > "${LOGF}.tmp" && cat "${LOGF}.tmp" > "${LOGF}"; rm -f "${LOGF}.tmp"
fi

[ -e "${HOME_DIR}/STOP" ] && { log "STOP file present — skipping"; exit 0; }
[ -x "${PY}" ] && [ -f "${CODE}/mosaic_band_runner.py" ] || { log "not installed (run bin/install_mosaic_local.sh)"; exit 1; }

# ── One run at a time. A run frozen by sleep keeps its lock; once it is older
# than STALE_S its frame is the backstop's anyway, so take over.
if ! mkdir "${LOCK}" 2>/dev/null; then
    old_pid=$(cat "${LOCK}/pid" 2>/dev/null || echo "")
    age=$(( $(date +%s) - $(stat -f %m "${LOCK}" 2>/dev/null || date +%s) ))
    if [ -n "${old_pid}" ] && kill -0 "${old_pid}" 2>/dev/null && [ "${age}" -lt "${STALE_S}" ]; then
        log "previous run (pid ${old_pid}, ${age}s) still going — skipping"; exit 0
    fi
    log "taking over stale lock (pid ${old_pid:-?}, ${age}s)"
    [ -n "${old_pid}" ] && pkill -TERM -P "${old_pid}" 2>/dev/null; kill -TERM "${old_pid}" 2>/dev/null
    rm -rf "${LOCK}"; mkdir "${LOCK}" || exit 1
fi
echo $$ > "${LOCK}/pid"
trap 'rm -rf "${LOCK}"' EXIT

# Keep the Mac awake for exactly this run (-i idle, -s system-on-AC; a closed
# lid still sleeps it — the backstop covers that).
/usr/bin/caffeinate -is -w $$ &

# ── Credentials: fetched per run, held only in this process's environment.
R2_ACCESS_KEY_ID=$("${GCLOUD}" secrets versions access latest --secret=r2-access-key-id --project tc-atlas-web 2>/dev/null)
R2_SECRET_ACCESS_KEY=$("${GCLOUD}" secrets versions access latest --secret=r2-secret-access-key --project tc-atlas-web 2>/dev/null)
if [ -z "${R2_ACCESS_KEY_ID}" ] || [ -z "${R2_SECRET_ACCESS_KEY}" ]; then
    log "R2 credentials unavailable (gcloud auth?) — skipping; backstop builds this frame"; exit 1
fi
export R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

# ── Same settings as the Cloud Run job (deploy_mosaic_idx_job.sh), minus the
# backstop flag. Overrides (MOSAIC_MET9 etc.) go in ~/.tcatlas-mosaic/env.
export R2_ENDPOINT_URL="https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com"
export R2_BUCKET=tc-atlas-rt
export MOSAIC_TILE_MODE=idx MOSAIC_R2_PREFIX=mosaic-v3 MOSAIC_PACK=only MOSAIC_VIS_HIRES=1
export MOSAIC_MET9=0 MOSAIC_BACKSTOP=0
export MOSAIC_OUT="${HOME_DIR}/out"            # KERNEL_DIR = $MOSAIC_OUT/kernels
export MET9_CACHE_DIR="${HOME_DIR}/met9_cache"
export MOSAIC_BAND_TIMEOUT_S=420              # a hung read can't hold the lock into the next cycle
[ -f "${HOME_DIR}/env" ] && . "${HOME_DIR}/env"

cd "${CODE}" || exit 1
log "start ($(cat "${CODE}/VERSION" 2>/dev/null || echo '?'))"
t0=$(date +%s)
"${PY}" mosaic_band_runner.py --r2 --storm --time --bands ir,wv,vis --frames 1
rc=$?
log "done rc=${rc} in $(( $(date +%s) - t0 ))s"
exit ${rc}
