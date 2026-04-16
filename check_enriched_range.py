"""See which case_indexes got enriched with vp — should tell us whether one era ran and one didn't."""
import urllib.request
import json

URL = "https://tc-atlas-api-361010099051.us-east1.run.app/metadata_all?data_type=merge"
with urllib.request.urlopen(URL) as r:
    d = json.load(r)

cases = d.get("cases", [])
enriched = sorted(c.get("case_index") for c in cases if c.get("vp") is not None)
all_ci = sorted(c.get("case_index") for c in cases)

print(f"total cases: {len(cases)}")
print(f"case_index range (all): {min(all_ci)}..{max(all_ci)}")
print(f"enriched with vp: {len(enriched)}")
if enriched:
    print(f"enriched case_index range: {min(enriched)}..{max(enriched)}")
    print(f"first 20 enriched case_indexes: {enriched[:20]}")
    print(f"last 10 enriched case_indexes: {enriched[-10:]}")

    # Split by era boundary (merge_early = 0..214, merge_recent = 215..435)
    early_enriched = [ci for ci in enriched if ci < 215]
    recent_enriched = [ci for ci in enriched if ci >= 215]
    print(f"enriched in merge_early (0..214): {len(early_enriched)}")
    print(f"enriched in merge_recent (215..435): {len(recent_enriched)}")
