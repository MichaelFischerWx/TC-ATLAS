# TC-ATLAS Site (tcatlas.org) — Deploy Notes

The site is published by GitHub Actions: `.github/workflows/deploy-site.yml`
runs on every push to `main` that touches the site and takes about a minute.
It needs repo Settings > Pages > Source set to **GitHub Actions**.

- **What it does.** `tools/site-build/build.mjs` copies the site into `_site/`
  with comments and whitespace stripped from first-party JS and CSS (45% fewer
  bytes over the wire) and a source map beside each file, then Pages serves
  that. Names, file paths and `?v=` tokens are unchanged. Everything else is
  copied as committed; Python, shell, Dockerfiles, plans and tests are left out.
- **The repo is still the source.** Edit and commit as before; local
  `python3 -m http.server` serves the unminified files. To see exactly what
  will be published: `npm ci --prefix tools/site-build && node tools/site-build/build.mjs`,
  then serve `_site/`.
- **Which build is live:** `https://tcatlas.org/build-info.json` (commit + time).
- **Usage log.** Each run's summary page (Actions tab > the run) ends with a
  month-to-date table of deploys and the Actions minutes they count for.
  Standard runners are free and uncapped while the repo is public.
- **A backend-only push does not deploy.** The workflow's `paths-ignore` and
  `NOT_SITE_*` in `build.mjs` list the same files; `node --test tools/site-build/`
  fails if they drift.
- **If a deploy fails** the site stays on the previous build. Re-run it from the
  Actions tab, or run it by hand: Actions > Deploy site > Run workflow.
- **To go back to the old way:** set Pages Source to "Deploy from a branch"
  (`main`, `/ (root)`). The site is then served straight from the repo again,
  unminified; nothing else needs to change.

# TC-ATLAS API — Deploy Notes

## Deploy Script (`deploy.sh`)

The deploy script uses `--set-env-vars` which **replaces all env vars** on every
deploy. If you need to add a new env var or secret, you **must** add it to
`deploy.sh` — otherwise the next deploy will wipe it out.

### Current env vars (line 91):
- `TC_RADAR_S3_BUCKET` — S3 bucket for TC-RADAR data (from `deploy.env`)
- `TC_RADAR_S3_PREFIX` — S3 key prefix (default: `tc-radar`)
- `AWS_DEFAULT_REGION` — AWS region (default: `us-east-1`)
- `GCS_IR_CACHE_BUCKET` — GCS bucket for persistent IR frame cache (default: `tc-atlas-ir-cache`)
- `CORS_ORIGINS` — Allowed CORS origins

### Current secrets (line 92, via Secret Manager):
- `EARTHDATA_TOKEN` — NASA Earthdata bearer token (`earthdata-token:latest`)
- `AWS_ACCESS_KEY_ID` — AWS access key (`aws-access-key-id:latest`)
- `AWS_SECRET_ACCESS_KEY` — AWS secret key (`aws-secret-access-key:latest`)

### Adding a new env var or secret
1. Add it to the `--set-env-vars` or `--set-secrets` line in `deploy.sh`
2. If it's a secret, first create it in Secret Manager:
   ```bash
   echo -n 'YOUR_SECRET_VALUE' | gcloud secrets create my-secret --data-file=-
   ```
   Then add `--set-secrets "MY_VAR=my-secret:latest"` to deploy.sh.

## AWS Credentials (Secret Manager)

AWS credentials are stored in GCP Secret Manager (not as plain env vars).

### One-time setup:
```bash
# Create the secrets (replace with your actual keys from deploy.env)
echo -n 'YOUR_AWS_ACCESS_KEY_ID' | gcloud secrets create aws-access-key-id --data-file=-
echo -n 'YOUR_AWS_SECRET_ACCESS_KEY' | gcloud secrets create aws-secret-access-key --data-file=-
```

### To rotate keys:
```bash
echo -n 'NEW_KEY' | gcloud secrets versions add aws-access-key-id --data-file=-
echo -n 'NEW_SECRET' | gcloud secrets versions add aws-secret-access-key --data-file=-
```
No redeploy needed — Cloud Run reads `latest` on next container start.

## GCS IR Frame Cache

- **Bucket:** `gs://tc-atlas-ir-cache`
- **Region:** us-east1 (same as Cloud Run)
- **Cache version:** Controlled by `_GCS_CACHE_VERSION` in `global_archive_api.py`
- **Key format:** `{version}/{source}/{sid}/{frame_idx}.json`
- **Service account:** `361010099051-compute@developer.gserviceaccount.com` needs `roles/storage.objectAdmin`

### Invalidating the cache
Bump `_GCS_CACHE_VERSION` in `global_archive_api.py` (e.g., `v4` → `v5`).
Also bump `irCacheVer` in `global_archive.js` to bust browser caches.
Old objects in GCS are orphaned (not served) — delete manually if needed:
```bash
gsutil -m rm -r gs://tc-atlas-ir-cache/v4/
```

## Earthdata Token

- Stored in GCP Secret Manager as `earthdata-token`
- Generate at: https://urs.earthdata.nasa.gov/profile → Generate Token
- To update:
  ```bash
  echo -n 'NEW_TOKEN_HERE' | gcloud secrets versions add earthdata-token --data-file=-
  ```
- No redeploy needed — Cloud Run reads `latest` version automatically on next container start.
  To force a restart: `gcloud run services update tc-atlas-api --region us-east1 --update-labels refresh=$(date +%s)`
