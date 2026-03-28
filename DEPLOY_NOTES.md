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
