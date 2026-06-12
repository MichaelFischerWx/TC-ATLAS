# Cloudflare R2 Egress Migration Plan

**Status: NOT STARTED — blocked on domain registration (Michael's decision).**
Drafted 2026-06-09 from the egress cost review in that session.

## Why

BigQuery billing export (last 14 days, 2026-05-26 → 06-09):

| Source | Cost | Volume |
|---|---|---|
| Cloud Run data transfer out (NA + intercontinental) | $13.33 | 123 GiB |
| GCS downloads — `tc-atlas-ir-cache` | $5.57 | 168.5 GiB |
| GCS downloads — `tc-atlas-microwave-nrt` | $0.28 | 10.2 GiB |
| GCS downloads — China/APAC rates | (worst per-GiB: $0.23) | |

≈ $19/14d (~$40–60/mo annualized), growing with the season (Cloud Run egress
went $0.20/day in late May → $1–3/day in June; spike day 06-08 = $6.42).
R2 has **zero egress fees**; a Cloudflare-proxied custom domain also edge-caches
bundles (latency win for W-Pac users hitting a US bucket today).

Realistic savings: $12–25/mo in season from GCS downloads, plus whatever the
stream-vs-redirect audit (below) moves off Cloud Run's ~$0.10–0.12/GiB egress.

## Prerequisite (Michael) — DONE 2026-06-12

Registered **tcatlas.org** at Cloudflare Registrar (primary domain, active on
Cloudflare DNS). CDN host for R2 = **cdn.tcatlas.org**.
NOTE: R2's free `r2.dev` URL is rate-limited and NOT for production —
the custom domain is required, not optional.

## Phase 0 — Infrastructure (~1 hr, mostly dashboard)

1. Cloudflare account (free plan) + domain on Cloudflare DNS.
2. R2 bucket (e.g. `tc-atlas-rt`), connect to `cdn.<domain>`.
3. CORS on the bucket: mirror GCS config — allow `https://michaelfischerwx.github.io`,
   `http://localhost:8000`, `http://localhost:8091`, methods GET/HEAD.
4. R2 API token (S3-compatible keypair) → Secret Manager as
   `r2-access-key-id` / `r2-secret-access-key`; mount on `tc-atlas-api`,
   `tc-atlas-prewarm-job`, `tc-atlas-mw-job` via `--update-secrets`
   (same pattern as the AWS keys; edit `deploy.sh` + `deploy_prewarm_job.sh`
   + `deploy_mw_job.sh` so future deploys preserve them).
5. R2 lifecycle rules: expire `bundles/ondemand/` (storage hygiene; exact
   prefix confirmed in Phase 1 before setting). NOTE: the real GCS ir-cache
   lifecycle (verified 2026-06-12) is ONLY `env/`@7d + `genesis-clusters/`@14d —
   both tiers STAY on GCS, so neither gets an R2 rule. The plan's earlier
   "genesis-clusters@14d on R2" line was wrong and is dropped.

## Phase 1 — RT bundle tier (hot path, biggest win per line)

Backend (`ir_monitor_api.py`):
- Add R2 client: boto3 (already a dependency) with `endpoint_url` =
  `https://<account_id>.r2.cloudflarestorage.com`.
- `_upload_public_bundle()` → **dual-write** GCS + R2 (R2 write fire-and-forget,
  same thread pattern as `_gcs_rt_put`).
- `_public_bundle_url()` → emit R2 public URL behind env var
  `PUBLIC_BUNDLE_BASE` (default = current GCS root). The three 302-redirect
  endpoints (`ir_monitor_api.py` ~4831/5853/6339) inherit this automatically.
- `rt-version.json` writer (verified: `_gcs_rt_version_put`, line 596 — NOT
  `_write_rt_version`): currently writes only `{"version": _GCS_RT_VERSION}`
  (version is now `rt-v12`, const at line 177). Add a `"base"` field carrying
  the public root.
- Verified anchors (2026-06-12): `_upload_public_bundle` @531 (uses
  `bucket.upload_from_string(..., predefined_acl="publicRead")`, max-age 300);
  `_public_bundle_url` @588 (returns `https://storage.googleapis.com/{bucket}/{key}`);
  302 endpoints @4831/5853/6339 confirmed; public-root constant is
  `_GCS_IR_CACHE_BUCKET` @169 (no `PUBLIC_BUNDLE_BASE` yet — we add it).

Frontend (`realtime_ir.js`):
- `_loadBundleVersion()` (~line 4501) already fetches `rt-version.json` at
  startup; extend it to read `"base"` and override `_GCS_BUCKET_ROOT`
  (validate with a strict URL regex, fall back to the GCS constant).
- **Cutover/rollback = editing one field in rt-version.json. No frontend
  redeploy.**
- Stragglers found in inventory (fix or delete while here): `satellite.js`
  hardcodes stale `rt-v10` at **three** spots (5110 `_GCS_BAND_BUNDLE_BASE`,
  5661, 5843) and `sat_quick.js:28` (`GCS_BUNDLE_BASE`) — all rt-v10 while
  server is on rt-v12 (sat_quick.js is orphaned — see project_loop_only_popup
  memory).

Sequence: dual-write 1 day → byte-compare a few R2 vs GCS objects → flip
`base` → watch 1 day → disable GCS public-ACL writes for this tier.

## Phase 2 — Seasonal / ERA5 archive tiles (the spiky-GiB driver)

Panel C year-loads pull ~60 MB/field-year from `era5_daily_1deg/` (more via
the HD toggle from `era5_daily_00z/`) — matches the bursty $0→$3/day GCS
download pattern.

- One-time `rclone` copy to R2: `era5_daily_1deg/`, `era5_daily_00z/`,
  `era5_climo/`, `era5_monthly_vpi/`, `seasonal/`, `subseasonal/`, `env/`.
- Frontend constant swaps: `realtime_seasonal.js` (GCS_BASE, EVO_ARCHIVE_BASE_NEW,
  EVO_ARCHIVE_BASE_HD, EVO_CLIMO_BASE, ENV_OVERLAY_BASE, era5_monthly_vpi
  customBase), `realtime_subseasonal.js` (GCS_BASE), `tc_climatology.js:1857`.
- Build scripts add R2 to their upload step for monthly increments
  (`build_era5_daily_archive.py`, seasonal/subseasonal jobs, env job).
- `gc-atlas-era5` is GC-ATLAS's bucket, NOT ours — leave it.

## Phase 3 — Microwave bucket (smallest, last)

`tc-atlas-microwave-nrt`: mw-job writes manifests + pass imagery.
- CHECK FIRST: do manifests embed absolute `storage.googleapis.com` URLs?
  If yes, the builder must emit R2 URLs at the same time as the frontend swap.
- Frontend: `realtime_ir.js:~18544/18549` (_RT_MW_MANIFEST_URL,
  _RT_MW_PREDICTIONS_URL), `tc_mw_layer.js:43-44`.

## Fold-in: stream-vs-redirect audit (Cloud Run egress, 123 GiB/14d)

Identify heavy endpoints still STREAMING bytes through Cloud Run instead of
302-redirecting to object storage:
- Global-archive IR / HURSAT frame endpoints (`global_archive_api.py`)
- Per-frame `ir-raw-frame` / `band-raw-frame` (~2 MB base64 JSON each)
Anything immutable → write-through to R2 + 302 (same pattern as the
on-demand bundles). This is what shrinks the Cloud Run egress line; doing it
without R2 would just shift cost to GCS download rates.

## What stays on GCS (do NOT migrate)

Server-internal objects only the API/jobs read — same-region GCS access is
free, and keeping them off R2 keeps write ops inside R2's 1M/mo free tier:
`rt-vN/ir-raw/`, `rt-vN/band-raw/`, frame manifests, `genesis-clusters/`,
`recon/`, `nexrad/`, `v6/` (global-archive cache), zarr buckets.

## Cost / risk summary

- R2: storage ~$0.015/GB-mo (a few GB of public objects → pennies); writes
  ~100–200k/mo (prewarm bundles) → inside 1M free Class A; reads partially
  absorbed by Cloudflare edge cache in front of the custom domain.
- Rollback: dual-write + rt-version.json `base` flip = instant, no deploy.
- Classic failure mode: CORS misconfig — existing GCS-direct frontend code
  already falls back to the API path on fetch failure, so worst case is
  slower, not broken.

## Future (separate decision, same domain)

Cloudflare proxy in front of the API (`api.<domain>` → Cloud Run domain
mapping) to edge-cache the immutable frame endpoints — revisit when the
free-trial credit exhausts and real post-credit Cloud Run egress is visible,
or if another 429-saturation event occurs (see project_api_saturation_429).
