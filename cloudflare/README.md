# Cloudflare cache ruleset (api.tcatlas.org)

Infrastructure-as-code for the **edge cache rules** that front the TC-ATLAS API
through Cloudflare. Without this, the rules only existed in the Cloudflare
dashboard — invisible to the repo, un-reviewable, and gone if the zone is ever
re-created. `cache_ruleset.json` is now the source of truth.

## Files

| File | Role |
|------|------|
| `cache_ruleset.json` | **Source of truth** — the full `http_request_cache_settings` rules array, plus the zone/ruleset ids. |
| `apply_cache_ruleset.py` | Reconciles the live Cloudflare ruleset to match the JSON. Diffs first; `--dry-run` to preview, `--force` to re-apply. |
| `verify_cache.sh` | Probes the live edge and asserts cacheable endpoints aren't `DYNAMIC` and bypassed ones are. |

## Usage

```bash
# Preview what would change (no writes):
python3 cloudflare/apply_cache_ruleset.py --dry-run

# Apply the repo's declared state to Cloudflare:
python3 cloudflare/apply_cache_ruleset.py

# Confirm live behavior matches intent:
cloudflare/verify_cache.sh
```

Auth: the API token is read at runtime from GCP Secret Manager
(`gcloud secrets versions access latest --secret cloudflare-rules-token`), or
from `$CF_RULES_TOKEN` if set. **No secret is stored in the repo.** The
`zone_id` / `ruleset_id` in the JSON are identifiers, not secrets.

## Design: why these rules

The API is fronted by Cloudflare (`api.tcatlas.org` → Cloud Run domain mapping).
Edge caching repeated GETs means repeat requests serve from the CF edge instead
of re-hitting the Cloud Run origin — cutting both origin **egress** and origin
**CPU**. The backend already declares cacheability via `Cache-Control` /
`max-age`; these rules just tell CF to **respect** it for the safe endpoints and
**bypass** it for the live ones.

Three rules, written to be **mutually exclusive** (so behavior never depends on
CF's last-match-wins ordering):

1. **CACHE** (respect-origin): `active-storms`, `season-summary`, and the
   `weatherlab-genesis-cluster*` (index + detail) and `weatherlab-genesis-trend`
   JSON. The genesis payloads are large (the cluster detail is ~8.7 MB raw /
   ~1.6 MB on the wire) and change only when a new DeepMind FNV3 cycle posts
   (~6 h), so caching them is a big egress win.
2. **BYPASS**: non-GET, plus the genuinely live endpoints — everything under
   `/weatherlab` **except** the cacheable genesis paths above, plus `/recon` and
   `/shear`.
3. **CACHE** (respect-origin): the IR frame endpoints (`band-raw-frame`,
   `ir-raw-frame`, `ir-frame.jpg`).

### Why these genesis endpoints are cache-safe

Their JSON carries wall-clock fields (`fetched_at`, `next_cycle_eta_hours`,
`cycle_age_hours`), but the frontend never trusts them as live values: the
countdown anchors to `fetched_at + eta` (an absolute instant — see
`realtime_ir.js`, `_genesisCycleEtaTargetMs`) and cycle age is recomputed from
the immutable `init_time`. So a frozen (edge-cached) response can't desync the
UI. Endpoints whose freeze-safety is **not** established (`/storm/{id}/weatherlab`,
`/weatherlab-ensemble`, `/weatherlab-genesis-near`, `/weatherlab-genesis-cycles`)
are deliberately left bypassed.

CORS composes safely because the origin sends `Vary: Origin` and CF caches a
separate variant per origin (no cross-origin poisoning).

## Gotchas (learned the hard way)

- **Whole-ruleset PUT only.** The per-rule endpoint
  `PUT /rulesets/{id}/rules/{rule_id}` returns `10405 "Method not allowed for
  this authentication scheme"` with this token. Replace the entire ruleset via
  `PUT /rulesets/{id}` with the full `rules` array. CF regenerates rule ids on
  every write, so never pin to a rule id.
- **`curl --compressed` is mandatory** when sending `Accept-Encoding: gzip`.
  Without it you get raw gzip bytes that look like an empty body and silently
  break `jq`/`json.load` — which once made an active storm look like "no
  clusters."
- **Host-header override is paywalled on CF Free**, which is why the API is
  fronted via a Cloud Run domain mapping, not an origin-rule host override. See
  the repo's `CLOUDFLARE_API_FRONTING_PLAN.md`.

## Rollback

Re-apply a previous `cache_ruleset.json` (git revert the file, then
`python3 cloudflare/apply_cache_ruleset.py`). To fully disable genesis caching
in a hurry, broaden rule 2 back to a blanket `/weatherlab` bypass and drop the
genesis paths from rule 1 — one whole-ruleset PUT, no deploy, effective in
seconds.
