# TC-ATLAS monitoring & alerting

Version-controlled Cloud Monitoring config for the real-time pipeline. Run
[`setup_monitoring.sh`](setup_monitoring.sh) to provision (idempotent):

```bash
ALERT_EMAIL=you@example.com ./monitoring/setup_monitoring.sh
```

## Why this exists

The prewarm Cloud Run Job is the **sole renderer** of RT satellite imagery
(the API runs `IR_INLINE_PREWARM=0`). It has twice gone **silently dead** —
once when an Artifact Registry digest-pin was pruned so the job couldn't pull
its image, once when a version bump froze the frontend — and both times the
only signal was a human noticing the loop had stopped. These alerts turn those
silent failures into a page.

## Alerts

| Policy | Fires when | Catches |
|---|---|---|
| **prewarm heartbeat absent 30m** | No `[Prewarm Job] Done:` log in 30 min (3 missed 10-min cycles) | Scheduler disabled, image-pull failure (job never starts), hang/timeout, crash-loop — the silent killers. Fires even with 0 active storms, because the job logs `Done:` on every successful run regardless. |
| **Cloud Run job execution FAILED** | Any job's failed-execution count > 0 | Crash / timeout / image-pull on prewarm, mw, env, seasonal, or subseasonal jobs. Faster, per-job signal. |

Heartbeat signal: `prewarm_job.py` prints `[Prewarm Job] Done: {summary}` after
`run_prewarm_cycle()` returns (both the storms and no-storms paths). The
log-based metric `prewarm_cycle_done` counts it; absence ⇒ unhealthy.

## Runbook (when an alert fires)

```bash
# Is the scheduler enabled and firing?
gcloud scheduler jobs describe tc-atlas-prewarm-schedule --location us-east1

# Recent executions — look for failed / running=0 / image errors
gcloud run jobs executions list --job tc-atlas-prewarm-job --region us-east1 --limit 5

# Error logs
gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=tc-atlas-prewarm-job AND severity>=ERROR' --freshness=1h --limit 30

# Most common root cause (digest prune): re-point the job at :latest
./deploy_prewarm_job.sh
```

## Notes

- Not covered: a *frontend* version-pin freeze (job healthy, browser stuck on a
  stale `rt-vN` bundle) — that's a code concern handled by the server-version
  tracking in `realtime_ir.js`, not infra alerting.
- `autoClose` is 24h; alerts self-resolve once the heartbeat resumes.
- To change the destination, edit the channel in the Cloud Console or re-run
  the script with a new `ALERT_EMAIL` (it finds the channel by display name).
