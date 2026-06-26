#!/usr/bin/env python3
"""Standalone hourly refresher for the social OG card (og:image / twitter:image)
plus rt-version.json.

Runs ONE cycle and exits — a Cloud Run Job on a Cloud Scheduler cadence (hourly).
It REUSES the API container image (like prewarm_job.py) but DELIBERATELY does not
import ir_monitor_api, so it skips the heavy pyart/cartopy + IBTrACS cold-start
tax: it imports only og_refresh → (og_card, satellite_ir) + google-cloud-storage
+ stdlib. Cold start is seconds, not minutes.

WHY THIS EXISTS — retiring the prewarm job
    The storm card now defaults to the lite mosaic view (built by the mosaic
    job), so prewarm's pre-rendered raw-Tb frames are no longer needed up front:
    the Detailed toggle renders them on demand. The ONLY other unique things the
    prewarm cycle produced were this OG card and rt-version.json. With this job
    owning both, the prewarm scheduler (tc-atlas-prewarm-schedule) can be paused:

        gcloud scheduler jobs pause tc-atlas-prewarm-schedule --location us-east1

    (Resume with `... resume ...`.) See the project_lite_storm_view and
    project_cost_status_2026_06 memories for the full rationale + cost numbers.

ENV CONTRACT
    GCS_IR_CACHE_BUCKET   target bucket (default tc-atlas-ir-cache)
    GCS_RT_VERSION        cache version string written to rt-version.json
                          (injected from ir_monitor_api.py by deploy_ogcard_job.sh)
    PUBLIC_BUNDLE_BASE    CDN base written as rt-version.json "base" (optional)
    OG_CARD_KEY           object key for the card (default og/realtime_ir.png)
    OG_GATE_URL           /active-storms endpoint (default = prod API)
"""
import json
import os
import sys
import traceback
import urllib.request


def _active_storms() -> list:
    """Fetch the live active-storm list over plain stdlib HTTP (no heavy import).
    The API sits behind Cloudflare and 403s a bare urllib UA, so send a
    browser-ish User-Agent + Origin (mirrors build_ir_mosaic.fetch_active_points
    and the prewarm gate)."""
    url = os.environ.get(
        "OG_GATE_URL",
        "https://tc-atlas-api-ip2bfs76hq-ue.a.run.app/ir-monitor/active-storms")
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/126 Safari/537.36",
        "Origin": "https://tcatlas.org", "Referer": "https://tcatlas.org/"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8"))
        storms = data.get("storms")
        return storms if isinstance(storms, list) else []
    except Exception as e:
        print(f"[OG Job] active-storms fetch failed ({e}) — branded fallback")
        return []


def _bucket():
    from google.cloud import storage
    name = os.environ.get("GCS_IR_CACHE_BUCKET", "tc-atlas-ir-cache")
    return storage.Client().bucket(name)


def main() -> int:
    try:
        import og_refresh
    except Exception:
        print("[OG Job] FAILED to import og_refresh:", file=sys.stderr)
        traceback.print_exc()
        return 1
    try:
        bucket = _bucket()
    except Exception as e:
        print(f"[OG Job] GCS bucket init failed: {e}", file=sys.stderr)
        return 1

    storms = _active_storms()

    # rt-version.json is authoritatively (re)written by deploy.sh on each deploy;
    # refresh it here too so it self-heals if the object is ever deleted and
    # stays in sync without a deploy. Idempotent, ~30 bytes.
    version = os.environ.get("GCS_RT_VERSION", "rt-v12")
    base = os.environ.get("PUBLIC_BUNDLE_BASE", "").rstrip("/") or None
    og_refresh.put_rt_version(bucket, version, base)

    og_key = os.environ.get("OG_CARD_KEY", "og/realtime_ir.png")
    ok = og_refresh.build_and_upload_og_card(
        storms, bucket=bucket, og_key=og_key,
        ir_webp_locator=None, force=True)
    print(f"[OG Job] Done: {{'storm_count': {len(storms)}, "
          f"'card_updated': {ok}}}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
