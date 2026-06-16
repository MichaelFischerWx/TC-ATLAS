#!/usr/bin/env python3
"""Dev harness: replay a past recon mission through the live /recon endpoint.

The replay clock lives in recon_api itself (?replay=YYYYMMDDHHMM&speed=N): the
endpoint only reveals bulletins the simulated clock has "reached", so polling it
repeatedly reproduces a flight accumulating in real time — no separate feed.

This CLI:
  * polls the endpoint a few times and prints the growing counts, proving the
    clock advances and the assembly works against the real archive, and
  * prints the ready-to-paste frontend test URL (the ?reconreplay= override on
    realtime_ir.html drives the same params from the browser).

Examples
--------
  # Against a locally-running API (python tc_radar_api.py), replay Milton:
  python replay_recon.py --api http://localhost:8000 \
      --atcf AL142024 --anchor 202410081200 --speed 120 --name MILTON

  # Just print the browser test URL:
  python replay_recon.py --atcf AL142024 --anchor 202410081200 --name MILTON --url-only
"""

import argparse
import time
import urllib.parse
import urllib.request
import json


def poll(api, atcf, anchor, speed, name, n, interval):
    base = api.rstrip("/") + "/recon/realtime"
    q = {"atcf_id": atcf, "hours": 24, "replay": anchor, "speed": speed}
    if name:
        q["name"] = name
    url = base + "?" + urllib.parse.urlencode(q)
    print(f"polling {url}\n")
    for i in range(n):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                blob = json.loads(r.read())
            c = blob.get("counts", {})
            print(f"[{i+1}/{n}] sim={blob.get('updated_utc')}  "
                  f"obs={c.get('obs', 0)}  aircraft={c.get('aircraft', 0)}  "
                  f"sondes={c.get('dropsondes', 0)}  vdm={c.get('vdms', 0)}")
        except Exception as e:
            print(f"[{i+1}/{n}] ERROR: {e}")
        if i < n - 1:
            time.sleep(interval)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", default="http://localhost:8000",
                    help="API base (default: http://localhost:8000)")
    ap.add_argument("--frontend", default="http://localhost:8000/realtime_ir.html",
                    help="Frontend URL for the browser test link")
    ap.add_argument("--atcf", required=True, help="ATCF id, e.g. AL142024")
    ap.add_argument("--anchor", required=True, help="Replay start YYYYMMDDHHMM")
    ap.add_argument("--speed", default="120", help="Replay speed multiplier")
    ap.add_argument("--name", default="", help="Storm name (dropsonde attribution)")
    ap.add_argument("--n", type=int, default=5, help="Poll count")
    ap.add_argument("--interval", type=float, default=10.0, help="Seconds between polls")
    ap.add_argument("--url-only", action="store_true", help="Just print the browser URL")
    args = ap.parse_args()

    rr = ":".join([args.atcf, args.anchor, args.speed] + ([args.name] if args.name else []))
    test_url = f"{args.frontend}?reconreplay={urllib.parse.quote(rr)}"
    print(f"Browser test URL (open, then click the storm + toggle Recon):\n  {test_url}\n")
    if args.url_only:
        return
    poll(args.api, args.atcf, args.anchor, args.speed, args.name, args.n, args.interval)


if __name__ == "__main__":
    main()
