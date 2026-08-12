#!/bin/bash
#
# run_env_overlays_local.sh — build the RT Monitor's environmental-analysis
# overlays on this Mac instead of Cloud Run, and publish them to GCS.
#
# Same shape as TC-SWARM's ghost-rt-cron.sh: launchd fires this on a plain
# StartInterval, and the script exits quietly when there is nothing to do.
# It does NOT try to align itself to the GFS cycle clock — that would need
# DST-aware calendar entries. Instead it wakes hourly, asks GCS whether the
# currently-available cycle has already been built, and returns in a couple
# of seconds if so. Roughly one wake-up in six does real work.
#
# The Cloud Run job (tc-atlas-env-job) stays scheduled as a BACKSTOP. It runs
# the same code with the same SKIP_IF_FRESH=1 and fires ~90 min after this
# one, so it exits immediately when the Mac did the work — and does the full
# build when the Mac was asleep, offline, or failed. Nothing here needs to
# detect its own failure: not writing the marker IS the failure signal.
#
# Cost: local runs are ~free. GCS charges nothing for ingress, so the ~439 MB
# a cycle produces costs only Class-A write ops (~$0.13/mo) against ~$5.25/mo
# for the same work on Cloud Run.
#
# Driven by ~/Library/LaunchAgents/com.fischerwx.tcatlas-env.plist
# Logs: ~/Library/Logs/tcatlas-env.{stdout,stderr}.log
# Disable with:
#   launchctl unload ~/Library/LaunchAgents/com.fischerwx.tcatlas-env.plist
# (Cloud Run then silently resumes carrying every cycle — verify with
#  `gcloud run jobs executions list --job tc-atlas-env-job --region us-east1`,
#  whose durations will jump from ~15 s back to ~23 min.)

set -u

# Anaconda's interpreter — it carries the stack this job needs (cfgrib +
# eccodes, cartopy, numba, and tcpypi 1.4 specifically; see the pin note in
# Dockerfile.env, 1.4.1 breaks the PI solve).
PY=/opt/anaconda3/bin/python3
cd "$(dirname "$0")" || exit 1

# ADC user credentials carry no project, so google-cloud-storage raises on
# every upload without this — the same trap ghost-rt-cron.sh documents.
export GOOGLE_CLOUD_PROJECT=tc-atlas-web
export GCS_IR_CACHE_BUCKET=tc-atlas-ir-cache

# Skip cycles somebody already built (this is what makes hourly polling cheap).
export SKIP_IF_FRESH=1
# Stamped into the run marker so `gsutil cat gs://…/env/_run_marker.json`
# tells you at a glance whether the Mac or the backstop carried a cycle.
export ENV_BUILD_SOURCE=local

# Cost telemetry reads these to price the run. On a local run the honest
# answer is zero, and leaving the Cloud Run defaults (2 vCPU / 2 GiB) in
# place would quietly inflate the monthly spend rollup with compute nobody
# paid for.
export CR_VCPU=0
export CR_MEM_GIB=0

# launchd will not start a second instance of a label while the first is
# still running, so a slow pass delays the next wake-up rather than
# overlapping with it. No lockfile needed.
exec $PY build_env_overlays.py
