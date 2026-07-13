#!/bin/bash
#
# seasonal-era5-refresh.sh — monthly refresh for the RT Monitor **Seasonal**
# tab's ERA5-derived data (Panel B environment indices + Panel C evolution
# map + the daily shear/winds parquets).
#
# WHY THIS EXISTS
# ---------------
# The climatology globe has its own monthly launchd job
# (com.fischerwx.era5-monthly-refresh → Gen_Circ/bin/era5-monthly-refresh.sh)
# which lands new ERA5 months on gs://gc-atlas-era5. But the TC-ATLAS seasonal
# derivatives were, until now, a MANUAL local step — so they silently froze
# (Panel B shear stuck at May 2026 while the globe rolled on to June). This
# script automates that missing step. Driven by
# ~/Library/LaunchAgents/com.fischerwx.seasonal-era5-refresh.plist (11th of
# each month, i.e. the day AFTER the globe refresh on the 10th).
#
# DEPENDENCY CHAIN (order matters)
# --------------------------------
#   A. build_era5_daily_archive.py --incremental   CDS → gs://…/era5_daily_00z + _1deg
#        └─ downloads the most-recent fully-closed month. THE LONG POLE.
#   B. from the daily archive (need A):
#        build_era5_shear_indices.py        → data/indices_monthly_era5_shear.json  (local → gsutil cp)
#        build_era5_daily_shear_indices.py  → seasonal/indices_daily_shear.parquet  (self-upload)
#        build_era5_daily_winds_indices.py  → seasonal/…daily winds…               (self-upload)
#   C. from the gc-atlas-era5 globe tiles (independent of A; globe already has June):
#        build_era5_indices.py              → data/indices_monthly_era5.json        (local → gsutil cp)
#        build_era5_chi_m_indices.py        → seasonal/indices_monthly_era5_chi_m.json (self-upload)
#        build_era5_vpi_indices.py          → seasonal/indices_monthly_era5_vpi.json   (self-upload)
#   D. trigger the R2 mirror so cdn.tcatlas.org (what the frontend reads) picks
#      up the new GCS objects immediately instead of waiting ≤6 h for the cron.
#
# build_era5_shear_indices.py and build_era5_indices.py write to REPO/data/
# only (no built-in GCS upload), so this wrapper does the gsutil cp for those
# two. The others self-upload to gs://tc-atlas-ir-cache/seasonal/.
#
# Steps are continue-on-error and logged individually: a CDS hiccup on A must
# not stop the globe-tile-based C steps, which don't depend on it. Exit code is
# non-zero if ANY step failed, so launchd/console surfaces trouble.

set -uo pipefail

REPO="$HOME/github/TC-ATLAS"
PY="/opt/anaconda3/bin/python"
BUCKET="gs://tc-atlas-ir-cache/seasonal"
LOG_DIR="$HOME/Library/Logs"
LOG="$LOG_DIR/seasonal-era5-refresh.log"
LOCK="/tmp/seasonal-era5-refresh.lock"      # mkdir-based (macOS has no flock)
DO_MIRROR=1
[ "${1:-}" = "--no-mirror" ] && DO_MIRROR=0

# anaconda first (numpy/xarray/cdsapi/google-cloud-storage), then homebrew for
# gsutil/gcloud, then system.
export PATH="/opt/anaconda3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME

mkdir -p "$LOG_DIR"

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Seasonal ERA5\"" 2>/dev/null || true; }

# Block overlapping runs (manual + scheduled). mkdir is atomic; trap removes it.
if ! mkdir "$LOCK" 2>/dev/null; then
    log "another seasonal-era5-refresh is running (lock $LOCK) — exit"
    exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

FAILED=""

# run <label> <command...> — logs, runs, records failure, returns cmd status.
run() {
    local label="$1"; shift
    log "▶ $label"
    if "$@" >> "$LOG" 2>&1; then
        log "✓ $label"
        return 0
    else
        local rc=$?
        log "✗ $label (exit $rc)"
        FAILED="$FAILED $label"
        return $rc
    fi
}

cd "$REPO" || { log "FATAL: cannot cd $REPO"; exit 1; }
log "=========================================================="
log "seasonal-era5-refresh start"

# ── A. Daily archive (CDS download of the most-recent closed month) ──────────
ARCHIVE_OK=0
if run "A. build_era5_daily_archive.py --incremental" \
       "$PY" build_era5_daily_archive.py --incremental; then
    ARCHIVE_OK=1
fi

# ── B. Indices derived from the daily archive (need A) ───────────────────────
if [ "$ARCHIVE_OK" = "1" ]; then
    if run "B1. build_era5_shear_indices.py" "$PY" build_era5_shear_indices.py; then
        run "B1-upload indices_monthly_era5_shear.json" \
            gsutil -h "Content-Type:application/json" \
                   cp data/indices_monthly_era5_shear.json "$BUCKET/indices_monthly_era5_shear.json"
    fi
    run "B2. build_era5_daily_shear_indices.py"  "$PY" build_era5_daily_shear_indices.py
    run "B3. build_era5_daily_winds_indices.py"  "$PY" build_era5_daily_winds_indices.py
else
    log "⨯ skipping B (shear/daily-shear/daily-winds) — daily archive step failed"
    FAILED="$FAILED B-skipped"
fi

# ── C. Indices derived from the gc-atlas-era5 globe tiles (independent of A) ──
if run "C1. build_era5_indices.py" "$PY" build_era5_indices.py; then
    run "C1-upload indices_monthly_era5.json" \
        gsutil -h "Content-Type:application/json" \
               cp data/indices_monthly_era5.json "$BUCKET/indices_monthly_era5.json"
fi
run "C2. build_era5_chi_m_indices.py"  "$PY" build_era5_chi_m_indices.py
run "C3. build_era5_vpi_indices.py"    "$PY" build_era5_vpi_indices.py

# ── D. Propagate GCS → R2/cdn immediately (frontend reads cdn.tcatlas.org) ───
if [ "$DO_MIRROR" = "1" ]; then
    run "D. trigger R2 mirror job" \
        gcloud run jobs execute tc-atlas-r2-mirror --region us-east1 --wait
else
    log "skip D (R2 mirror) — --no-mirror; ≤6 h cron will propagate"
fi

if [ -n "$FAILED" ]; then
    log "DONE with FAILURES:$FAILED"
    notify "Seasonal ERA5 refresh had failures:$FAILED"
    exit 1
fi
log "DONE — all steps succeeded"
notify "Seasonal ERA5 refresh complete"
log "seasonal-era5-refresh end"
