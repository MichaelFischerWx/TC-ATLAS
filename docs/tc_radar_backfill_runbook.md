# TC-RADAR Zarr Backfill / Rechunk / Consolidate Runbook

How to run one-time maintenance on the TC-RADAR Zarr stores
(`gs://tc-atlas-zarr/tc-radar/`) cheaply and safely, and how to keep the serving
service cheap the rest of the time.

## Background: what went wrong (late May)

- All six groups (`swath_early`, `swath_recent`, `merge_early`, `merge_recent`,
  `era5`, `mergir`) are chunked **one chunk per case** (`chunks[0] = 1`) →
  ~210,776 objects total.
- `era5` and `mergir` shipped **without consolidated metadata** (`.zmetadata`),
  so every cold open did a LIST + one GET per array.
- An **always-on service** re-ran **per-case startup enrichment**
  (`.isel(num_cases=idx)` loops) on every cold instance.
- Net: ~27M GCS ops / ~$36 over 3 days.

The fixes below are split into **code already shipped** and **one-time bucket ops
a human runs with confirmation**.

## Already shipped in the API (no bucket mutation)

1. **Defensive consolidated reads** — `tc_radar_api.py` `get_ir_dataset()` and
   `get_era5_dataset()` now try `zarr.open_consolidated()` and fall back to the
   plain open. Safe before or after consolidation.
2. **Enrichment sidecar loader** — at startup the API prefers a small precomputed
   sidecar (`TC_RADAR_ENRICHMENT_SIDECAR`, default
   `gs://tc-atlas-zarr/tc-radar/enrichment_sidecar.json`) and **skips** the live
   per-case enrichment loops when it is present. Absent → identical old behaviour.

## One-time bucket ops (run as a Cloud Run **Job**, not the always-on service)

> Never run maintenance inside the always-on serving service. Use a right-sized
> **Cloud Run Job** that runs to completion and exits — you pay only for the run.
> Pattern already in the repo: `deploy_prewarm_job.sh` / `prewarm_job.py`
> (a Cloud Run Job + Scheduler that moved prewarm OUT of the serving process so
> the API can run CPU-throttled with `--min-instances 0`).

General Job shape (mirror `deploy_prewarm_job.sh`):

```bash
gcloud run jobs create tc-radar-maint-job \
    --source . \
    --region us-east1 \
    --memory 4Gi --cpu 2 \
    --max-retries 0 --task-timeout 3600 \
    --set-env-vars TC_RADAR_GCS_BUCKET=tc-atlas-zarr,TC_RADAR_GCS_PREFIX=tc-radar
# then run on demand, to completion:
gcloud run jobs execute tc-radar-maint-job --region us-east1 --wait
```

### Step 1 — Consolidate metadata (`era5`, `mergir`)

`scripts/consolidate_zarr_metadata.py`. **Dry-run is the default**; it only
reports. Writing `.zmetadata` requires `--apply`.

```bash
# Report (safe):
python3 scripts/consolidate_zarr_metadata.py --bucket tc-atlas-zarr --prefix tc-radar
# Apply (HUMAN-CONFIRMED — writes .zmetadata in place, no chunk rewrite):
python3 scripts/consolidate_zarr_metadata.py --bucket tc-atlas-zarr --prefix tc-radar --apply
```

This is the highest-value, lowest-risk fix: it writes ONE object per group and
collapses cold opens to a single GET. Static data → run once, never again.

### Step 2 — Build the enrichment sidecar

`scripts/build_tc_radar_enrichment_sidecar.py`. Vectorized bulk reads (one GET
per variable per era, not per case). Writes one small JSON.

```bash
# Local (safe):
python3 scripts/build_tc_radar_enrichment_sidecar.py --out enrichment_sidecar.json
# Upload to the path the API reads (HUMAN-CONFIRMED — adds one small object):
python3 scripts/build_tc_radar_enrichment_sidecar.py \
    --out gs://tc-atlas-zarr/tc-radar/enrichment_sidecar.json
```

After upload, the API skips the per-case enrichment loops on every cold start.

### Step 3 — Rechunk the case axis (optional, larger job)

`scripts/rechunk_tc_radar.py`. **Report-only by default.** Writes ONLY to a NEW
prefix (never in place). See cost/object-count notes in the script docstring.

```bash
# Report proposed chunking + object-count estimate (safe):
python3 scripts/rechunk_tc_radar.py --src-bucket tc-atlas-zarr --src-prefix tc-radar
# Execute into a NEW prefix (HUMAN-CONFIRMED):
python3 scripts/rechunk_tc_radar.py \
    --src-bucket tc-atlas-zarr --src-prefix tc-radar \
    --dst-bucket tc-atlas-zarr --dst-prefix tc-radar-rechunked --apply
```

Then stage a deploy with `TC_RADAR_GCS_PREFIX=tc-radar-rechunked`, verify, and
only afterwards retire the old prefix.

## Copy / move data the cheap way

- Prefer **server-side GCS→GCS** copy (`gcloud storage cp -r` / `gsutil -m cp`)
  which stays in-region and avoids download→reupload egress.
- When refreshing an existing destination, **rsync only what changed**:
  `gsutil -m rsync -r SRC DST` (as `migrate_s3_to_gcs.sh` already does for the
  S3→GCS path). Do NOT re-sync static data that hasn't changed.
- `migrate_s3_to_gcs.sh` currently does S3→local→GCS because the source is S3;
  for GCS→GCS work there is no local hop — keep it server-side.
- The rechunk job inherently rewrites data, but it is GCS→GCS within the same
  bucket/region, so egress is free; the cost is the one-time op count.

## Idempotency / never re-run on static data

- Consolidate and the sidecar build are **one-time** — gate them on existence
  (the consolidate script skips groups that already have `.zmetadata`).
- TC-RADAR releases are static; only re-run any of the above when a **new
  TC-RADAR version** is ingested, never on a schedule.

## Return serving to cheap, request-based CPU

After the Jobs finish and the API is verified:

```bash
# Off-season: scale to zero, request-billed CPU.
gcloud run services update tc-atlas-api --region us-east1 --min-instances 0
# Hurricane season: keep one warm instance.
gcloud run services update tc-atlas-api --region us-east1 --min-instances 1
```

- Keep heavy/periodic work (real-time prewarm, backfills) in **Jobs**, not the
  service — the serving service should be request-billed CPU (`--cpu-throttling`,
  see `deploy_prewarm_job.sh` tail) with `--min-instances 0` off-season.
- `deploy.sh` prints these exact min-instances toggles after each deploy.

## References

- `migrate_s3_to_gcs.sh` — S3→GCS migration + `gsutil rsync` pattern.
- `deploy.sh` — service deploy; min-instances season toggles.
- `deploy_prewarm_job.sh` / `prewarm_job.py` — Cloud Run Job + Scheduler pattern
  that this runbook reuses for maintenance.
- `scripts/consolidate_zarr_metadata.py`, `scripts/rechunk_tc_radar.py`,
  `scripts/build_tc_radar_enrichment_sidecar.py` — the tooling above.
```
