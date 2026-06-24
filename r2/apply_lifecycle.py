#!/usr/bin/env python3
"""Apply (or diff) TC-ATLAS R2 object-lifecycle rules.

The desired managed rules live in `lifecycle.json`. This script MERGES them BY
`ID` into whatever lifecycle config the bucket already has — any rule not named
in lifecycle.json is preserved untouched. (R2's S3 PutBucketLifecycleConfiguration
replaces the whole config, so we GET-merge-PUT to avoid clobbering unmanaged rules.)

Usage:
    python3 r2/apply_lifecycle.py            # show diff, then apply if changed
    python3 r2/apply_lifecycle.py --dry-run  # show current + desired, never write
    python3 r2/apply_lifecycle.py --force    # apply even if no diff detected

Auth: R2 keys are read at runtime from GCP Secret Manager
(`r2-access-key-id` / `r2-secret-access-key`) — nothing secret is stored in the
repo. Bucket + endpoint come from env (R2_BUCKET, R2_ENDPOINT_URL) with the same
defaults the deploy scripts use.
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC_PATH = os.path.join(HERE, "lifecycle.json")

R2_BUCKET = os.environ.get("R2_BUCKET", "tc-atlas-rt")
R2_ENDPOINT = os.environ.get(
    "R2_ENDPOINT_URL",
    "https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com")


def _secret(name: str) -> str:
    return subprocess.check_output(
        ["gcloud", "secrets", "versions", "access", "latest", "--secret", name],
        text=True).strip()


def _client():
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3", endpoint_url=R2_ENDPOINT,
        aws_access_key_id=_secret("r2-access-key-id"),
        aws_secret_access_key=_secret("r2-secret-access-key"),
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}))


def _strip_comments(rule: dict) -> dict:
    return {k: v for k, v in rule.items() if not k.startswith("_")}


def _load_spec():
    with open(SPEC_PATH) as f:
        spec = json.load(f)
    return [_strip_comments(r) for r in spec.get("rules", [])]


def _get_current(client):
    try:
        resp = client.get_bucket_lifecycle_configuration(Bucket=R2_BUCKET)
        return resp.get("Rules", [])
    except Exception as e:
        if "NoSuchLifecycleConfiguration" in str(e):
            return []
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    desired = _load_spec()
    managed_ids = {r["ID"] for r in desired}

    client = _client()
    current = _get_current(client)

    # Merge: keep unmanaged rules as-is, replace/add the managed ones.
    unmanaged = [r for r in current if r.get("ID") not in managed_ids]
    merged = unmanaged + desired

    def _norm(rules):
        return sorted((json.dumps(r, sort_keys=True) for r in rules))

    print(f"Bucket: {R2_BUCKET}")
    print(f"  current rules : {[r.get('ID') for r in current]}")
    print(f"  managed (spec): {[r['ID'] for r in desired]}")
    print(f"  preserved     : {[r.get('ID') for r in unmanaged]}")

    changed = _norm(current) != _norm(merged)
    if not changed and not args.force:
        print("No change — bucket lifecycle already matches desired state.")
        return
    if args.dry_run:
        print("\n--dry-run: would PUT this lifecycle config:")
        print(json.dumps({"Rules": merged}, indent=2))
        return

    client.put_bucket_lifecycle_configuration(
        Bucket=R2_BUCKET, LifecycleConfiguration={"Rules": merged})
    print(f"\nApplied {len(merged)} lifecycle rule(s) to {R2_BUCKET}.")


if __name__ == "__main__":
    sys.exit(main())
