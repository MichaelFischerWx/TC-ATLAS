#!/usr/bin/env python3
"""Coverage report for the IR context archive on R2: per year, frames built
vs the expected 3-hourly calendar, and the exact missing timestamps.

  python3 bin/ir_context_coverage.py 1980 2026 > ~/ir_context_coverage.txt
"""
import sys, os, json
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_ir_context import get_r2_client, list_existing

start, end = int(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else int(sys.argv[1])
r2 = get_r2_client()
now = datetime.now(timezone.utc).replace(tzinfo=None)
tot_exp = tot_have = 0
allgaps = {}
for y in range(start, end + 1):
    have = list_existing(r2, y)
    t = datetime(y, 1, 1); stop = min(datetime(y + 1, 1, 1), now)
    exp = []
    while t < stop:
        exp.append(t.strftime("%Y%m%d%H")); t += timedelta(hours=3)
    gaps = [ts for ts in exp if ts not in have]
    tot_exp += len(exp); tot_have += len(exp) - len(gaps); allgaps[y] = gaps
    print(f"{y}: {len(exp)-len(gaps):5d}/{len(exp)} frames ({100*(len(exp)-len(gaps))/max(1,len(exp)):5.1f}%), {len(gaps)} missing")
print(f"\nTOTAL: {tot_have}/{tot_exp} ({100*tot_have/max(1,tot_exp):.2f}%), {tot_exp-tot_have} missing")
print("\nMissing timestamps by year:")
for y, g in allgaps.items():
    if g: print(f"  {y}: " + " ".join(g))
