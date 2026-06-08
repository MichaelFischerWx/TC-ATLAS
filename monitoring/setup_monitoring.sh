#!/usr/bin/env bash
# --------------------------------------------------------------------------
# TC-ATLAS — Cloud Monitoring alerting (idempotent provisioning)
# --------------------------------------------------------------------------
# Provisions the health alerting for the real-time pipeline. Re-running is
# safe: each resource is looked up by name/displayName and only created if
# absent. Uses the Monitoring REST API directly (curl + an OAuth token) so it
# needs NO alpha/beta gcloud components.
#
# What it creates:
#   1. Log-based metric  prewarm_cycle_done  — counts "[Prewarm Job] Done:"
#      heartbeat logs (emitted every successful prewarm cycle, storms or not).
#   2. Email notification channel  ->  ${ALERT_EMAIL}
#   3. Alert policy A — prewarm heartbeat ABSENT for 30 min (3 missed 10-min
#      cycles). This is the resilient backstop: it fires whether the job is
#      crash-looping, hung, can't pull its image, or the scheduler is off —
#      all of which previously went UNNOTICED until imagery visibly froze.
#   4. Alert policy B — ANY Cloud Run job execution failed (faster, per-job
#      signal across prewarm / mw / env / seasonal / subseasonal).
#
# Usage:
#   ALERT_EMAIL=you@example.com ./monitoring/setup_monitoring.sh
# --------------------------------------------------------------------------
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ALERT_EMAIL="${ALERT_EMAIL:-mikefischerwx@gmail.com}"
API="https://monitoring.googleapis.com/v3/projects/${PROJECT}"
TOKEN="$(gcloud auth print-access-token)"
auth=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")

echo "Project: ${PROJECT}   Alert email: ${ALERT_EMAIL}"

# ── 1. Log-based heartbeat metric ────────────────────────────────────────
if gcloud logging metrics describe prewarm_cycle_done --project="${PROJECT}" >/dev/null 2>&1; then
    echo "[1/4] log metric prewarm_cycle_done — exists"
else
    echo "[1/4] creating log metric prewarm_cycle_done"
    gcloud logging metrics create prewarm_cycle_done --project="${PROJECT}" \
        --description="Heartbeat: successful prewarm-job cycle completions. Absence = job not completing." \
        --log-filter='resource.type="cloud_run_job" AND resource.labels.job_name="tc-atlas-prewarm-job" AND textPayload:"[Prewarm Job] Done:"'
fi

# ── 2. Email notification channel (find by displayName, else create) ──────
CH_NAME="TC-ATLAS ops email"
CHANNEL="$(curl -s "${auth[@]}" "${API}/notificationChannels" \
    | python3 -c "import sys,json;
chs=json.load(sys.stdin).get('notificationChannels',[])
print(next((c['name'] for c in chs if c.get('displayName')=='${CH_NAME}'),''))")"
if [[ -n "${CHANNEL}" ]]; then
    echo "[2/4] notification channel — exists (${CHANNEL})"
else
    echo "[2/4] creating notification channel -> ${ALERT_EMAIL}"
    CHANNEL="$(curl -s -X POST "${auth[@]}" "${API}/notificationChannels" -d "{
        \"type\":\"email\",\"displayName\":\"${CH_NAME}\",
        \"description\":\"Primary ops alert channel for TC-ATLAS job health\",
        \"labels\":{\"email_address\":\"${ALERT_EMAIL}\"},\"enabled\":true
    }" | python3 -c "import sys,json;print(json.load(sys.stdin)['name'])")"
    echo "      created ${CHANNEL}"
fi

# ── helper: create an alert policy from stdin JSON unless its displayName
#            already exists. __CHANNEL__ is substituted with the channel name.
create_policy_if_absent() {
    local display="$1" json; json="$(cat)"
    local existing
    existing="$(curl -s "${auth[@]}" "${API}/alertPolicies" \
        | python3 -c "import sys,json;
ps=json.load(sys.stdin).get('alertPolicies',[])
print(next((p['name'] for p in ps if p.get('displayName')=='${display}'),''))")"
    if [[ -n "${existing}" ]]; then
        echo "      policy '${display}' — exists (${existing})"; return
    fi
    echo "${json}" | sed "s#__CHANNEL__#${CHANNEL}#g" \
        | curl -s -X POST "${auth[@]}" "${API}/alertPolicies" -d @- \
        | python3 -c "import sys,json;d=json.load(sys.stdin);print('      created',d.get('name','ERROR: '+json.dumps(d)[:300]))"
}

# ── 3. Policy A — prewarm heartbeat absent 30 min ─────────────────────────
echo "[3/4] alert policy A (prewarm heartbeat absent)"
create_policy_if_absent "TC-ATLAS prewarm job NOT completing (heartbeat absent 30m)" <<'JSON'
{
  "displayName": "TC-ATLAS prewarm job NOT completing (heartbeat absent 30m)",
  "documentation": {"mimeType": "text/markdown", "content": "No '[Prewarm Job] Done:' log from tc-atlas-prewarm-job in 30 min (3 missed 10-min cycles). The job is likely not running (scheduler disabled), failing to start (image-pull), hanging, or crash-looping — RT satellite imagery will go stale. Check: gcloud run jobs executions list --job tc-atlas-prewarm-job --region us-east1 ; gcloud scheduler jobs describe tc-atlas-prewarm-schedule --location us-east1"},
  "combiner": "OR",
  "conditions": [{
    "displayName": "No prewarm heartbeat for 30 min",
    "conditionAbsent": {
      "filter": "resource.type=\"cloud_run_job\" AND metric.type=\"logging.googleapis.com/user/prewarm_cycle_done\"",
      "aggregations": [{"alignmentPeriod": "600s", "perSeriesAligner": "ALIGN_COUNT"}],
      "duration": "1800s",
      "trigger": {"count": 1}
    }
  }],
  "notificationChannels": ["__CHANNEL__"],
  "alertStrategy": {"autoClose": "86400s"}
}
JSON

# ── 4. Policy B — any Cloud Run job execution failed ──────────────────────
echo "[4/4] alert policy B (any job execution failed)"
create_policy_if_absent "TC-ATLAS Cloud Run job execution FAILED" <<'JSON'
{
  "displayName": "TC-ATLAS Cloud Run job execution FAILED",
  "documentation": {"mimeType": "text/markdown", "content": "A Cloud Run job execution failed (crash, timeout, or image-pull). The firing resource.label.job_name names the job. Check: gcloud run jobs executions list --job <name> --region us-east1 ; gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=<name> AND severity>=ERROR' --freshness=1h"},
  "combiner": "OR",
  "conditions": [{
    "displayName": "Any job failed execution > 0",
    "conditionThreshold": {
      "filter": "resource.type=\"cloud_run_job\" AND metric.type=\"run.googleapis.com/job/completed_execution_count\" AND metric.label.\"result\"=\"failed\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": 0,
      "duration": "0s",
      "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_DELTA", "crossSeriesReducer": "REDUCE_SUM", "groupByFields": ["resource.label.job_name"]}],
      "trigger": {"count": 1}
    }
  }],
  "notificationChannels": ["__CHANNEL__"],
  "alertStrategy": {"autoClose": "86400s"}
}
JSON

echo "Done. Verify: https://console.cloud.google.com/monitoring/alerting/policies?project=${PROJECT}"
