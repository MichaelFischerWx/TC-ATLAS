# R2 bucket configuration (IaC)

Version-controlled config for the Cloudflare R2 bucket `tc-atlas-rt` (the public
serving origin behind `cdn.tcatlas.org`). Mirrors the `cloudflare/` cache-ruleset
pattern: the JSON is the source of truth; the apply script reconciles the live
bucket to it.

## Object lifecycle

`lifecycle.json` — managed object-expiration rules. Applied with:

```bash
python3 r2/apply_lifecycle.py --dry-run   # show current + desired, never write
python3 r2/apply_lifecycle.py             # merge managed rules in, apply if changed
python3 r2/apply_lifecycle.py --force     # apply even if no diff
```

The script **merges by rule `ID`**: rules in `lifecycle.json` are added/replaced,
any rule already on the bucket that we don't name is **preserved** (R2's S3
`PutBucketLifecycleConfiguration` replaces the whole config, so we GET-merge-PUT).

Auth: R2 keys are read at runtime from GCP Secret Manager
(`r2-access-key-id` / `r2-secret-access-key`) — nothing secret in the repo.
Bucket/endpoint default to the deploy-script values; override via `R2_BUCKET` /
`R2_ENDPOINT_URL` env.

### Current managed rules

- **`tcatlas-raw-frames-2d`** — expire `rt-v12/raw-frames/**` after 2 days.
  These are the per-frame immutable raw-Tb objects written by the prewarm job
  when `RAW_PERFRAME=1` (see `deploy_prewarm_job.sh`). Frames roll off the 6 h
  loop window and best-track position revisions orphan old keys, so a 2-day TTL
  reclaims them. **Bump the `rt-v12` prefix when `_GCS_RT_VERSION` bumps** (same
  convention as the GCS `ir_cache_lifecycle.json` rules).

> Note: R2 lifecycle is **separate** from the GCS bucket lifecycle
> (`ir_cache_lifecycle.json`, which governs `gs://tc-atlas-ir-cache`).
