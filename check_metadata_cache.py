"""Probe /metadata_all to see what's actually in _merge_metadata_cache on the live server."""
import sys
import urllib.request
import json

URL = "https://tc-atlas-api-361010099051.us-east1.run.app/metadata_all?data_type=merge"

with urllib.request.urlopen(URL) as r:
    d = json.load(r)

cases = d.get("cases", [])
print(f"total_cases: {d.get('total_cases')}")

if not cases:
    print("Cache is empty — no cases loaded on server.")
    sys.exit(0)

c = cases[0]
print(f"first case keys: {sorted(c.keys())}")
print(f"first case storm: {c.get('storm_name')} {c.get('datetime')}")
print(f"first case vp: {c.get('vp')}")
print(f"first case vmpi: {c.get('vmpi')}, rhlo: {c.get('rhlo')}, shgc: {c.get('shgc')}")
print(f"first case dvmax_12h: {c.get('dvmax_12h')}, dvmax_24h: {c.get('dvmax_24h')}")

with_vp = sum(1 for x in cases if x.get("vp") is not None)
with_vmpi = sum(1 for x in cases if x.get("vmpi") is not None)
with_dvmax = sum(1 for x in cases if x.get("dvmax_12h") is not None)
print(f"cases with vp populated: {with_vp}/{len(cases)}")
print(f"cases with vmpi populated: {with_vmpi}/{len(cases)}")
print(f"cases with dvmax_12h populated: {with_dvmax}/{len(cases)}")
