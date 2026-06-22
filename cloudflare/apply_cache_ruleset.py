#!/usr/bin/env python3
"""Apply (or diff) the TC-ATLAS Cloudflare cache-settings ruleset.

The desired state lives in `cache_ruleset.json` (the source of truth). This
script reconciles the live Cloudflare ruleset to match it.

Usage:
    python3 cloudflare/apply_cache_ruleset.py            # show diff, then apply if changed
    python3 cloudflare/apply_cache_ruleset.py --dry-run  # show diff only, never write
    python3 cloudflare/apply_cache_ruleset.py --force    # apply even if no diff detected

Auth: the API token is read at runtime from GCP Secret Manager
(`cloudflare-rules-token`), so nothing secret is stored in the repo. The
zone/ruleset ids in cache_ruleset.json are identifiers, not secrets.

CF API gotcha (learned the hard way): the *per-rule* update endpoint
(`PUT /rulesets/{id}/rules/{rule_id}`) returns 10405 "Method not allowed for
this authentication scheme" with this token. You MUST replace the WHOLE
ruleset via `PUT /rulesets/{id}` with the full `rules` array. CF regenerates
each rule's id on write, so don't pin to rule ids.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC_PATH = os.path.join(HERE, "cache_ruleset.json")
SECRET_NAME = "cloudflare-rules-token"
API = "https://api.cloudflare.com/client/v4"


def load_spec():
    with open(SPEC_PATH) as f:
        return json.load(f)


def get_token():
    tok = os.environ.get("CF_RULES_TOKEN")
    if tok:
        return tok.strip()
    try:
        out = subprocess.check_output(
            ["gcloud", "secrets", "versions", "access", "latest",
             "--secret", SECRET_NAME],
            stderr=subprocess.DEVNULL)
        return out.decode().strip()
    except Exception as e:
        sys.exit(f"ERROR: could not read token from Secret Manager "
                 f"({SECRET_NAME}) or $CF_RULES_TOKEN: {e}")


def cf(method, url, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR: CF API {method} {url} -> {e.code}\n{e.read().decode()}")


def normalize(rules):
    """Comparable form: only the fields we manage, in order."""
    return [
        {"action": r["action"],
         "action_parameters": r.get("action_parameters", {}),
         "description": r.get("description", ""),
         "enabled": r.get("enabled", True),
         "expression": r["expression"]}
        for r in rules
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="show diff only, never write")
    ap.add_argument("--force", action="store_true",
                    help="apply even if no diff detected")
    args = ap.parse_args()

    spec = load_spec()
    zone, ruleset = spec["zone_id"], spec["ruleset_id"]
    desired = normalize(spec["rules"])
    token = get_token()

    cur = cf("GET", f"{API}/zones/{zone}/rulesets/{ruleset}", token)
    live = normalize(cur["result"].get("rules", []))

    if live == desired:
        print("Live ruleset already matches cache_ruleset.json "
              f"({len(desired)} rules).")
        if not args.force:
            return
        print("--force given; re-applying anyway.")
    else:
        print("DIFF — live ruleset does NOT match the spec:\n")
        for i in range(max(len(live), len(desired))):
            d = desired[i] if i < len(desired) else None
            l = live[i] if i < len(live) else None
            if d == l:
                continue
            print(f"  rule[{i}]")
            print(f"    live:    {json.dumps(l)}")
            print(f"    desired: {json.dumps(d)}")
        print()

    if args.dry_run:
        print("--dry-run: not writing.")
        sys.exit(0 if live == desired else 2)

    out = cf("PUT", f"{API}/zones/{zone}/rulesets/{ruleset}",
             token, {"rules": spec["rules"]})
    ok = out.get("success")
    print(f"\nPUT success: {ok}")
    if ok:
        print("Applied rules:")
        for r in out["result"]["rules"]:
            cache = r["action_parameters"].get("cache")
            print(f"  [cache={cache}] {r['description']}")
    else:
        sys.exit(f"CF reported failure: {out.get('errors')}")


if __name__ == "__main__":
    main()
