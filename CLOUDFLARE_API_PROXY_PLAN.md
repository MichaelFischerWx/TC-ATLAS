# Cloudflare API Proxy Plan (`api.tcatlas.org`)

**Status: PLANNED — not started. Drafted 2026-06-12.**
The highest-leverage remaining egress lever after Phases 1-3. Edge-caches the
immutable/semi-static API GETs that dominate Cloud Run egress, with ZERO
per-endpoint code changes — the responses already carry the right headers.

## Why (evidence)

Cloud Run egress was ~123 GiB/14d ($13.33), the single biggest cost line.
24h log analysis of responses >20 KB, AFTER the band-raw-bundle fix:

| Endpoint | ~% heavy egress | Cache-Control already emitted |
|---|---|---|
| `/global/ir/frame` | 10% | `public, max-age=86400, s-maxage=604800, immutable` |
| `/ir_frame` (TC-RADAR) | ~4% | `s-maxage=604800, immutable` (code: "let Cloud CDN absorb repeat hits") |
| `/ir-monitor/weatherlab-genesis(+clusters)` | ~16% | `max-age=180, s-maxage=600, stale-while-revalidate` |

Every one already sets `s-maxage` (a *shared-cache* directive). Nothing
consumes it because browsers hit `*.run.app` directly. A Cloudflare cache in
front of `api.tcatlas.org` that respects origin TTLs absorbs the repeat hits —
including `weatherlab-genesis` (the genesis page) WITHOUT touching that code.
Also delivers the edge-side 429 protection noted in
`project_api_saturation_429`.

Dynamic endpoints are safe: they already emit `Cache-Control: no-store`
(e.g. active-storms, the 302 redirects), which Cloudflare honors — never cached.

## Architecture

```
browser ──HTTPS──> api.tcatlas.org (Cloudflare edge, proxied/orange)
                       │  cache HIT  → served from edge (no origin hit)
                       │  cache MISS → origin fetch + store per origin TTL
                       ▼
                   tc-atlas-api-….run.app (Cloud Run, unchanged)
```

No Cloud Run domain mapping required. Use a Cloudflare **proxied CNAME** +
**Origin Rule** that rewrites the Host header to the `run.app` origin (Cloud
Run only accepts its own hostname or a mapped domain). SSL mode **Full**.

## Phased rollout (no prod impact until Phase B)

### Phase A — Stand up the proxy, verify in isolation (NO prod impact)
Production frontend still calls `*.run.app`, so nothing changes for users.

1. **(Cloudflare dashboard — Michael)** DNS: add `api` CNAME → the Cloud Run
   host `tc-atlas-api-ip2bfs76hq-ue.a.run.app`, **Proxied (orange cloud)**.
2. **(Cloudflare — Michael)** SSL/TLS mode = **Full** (origin presents a valid
   Google cert; "Full" avoids the "Flexible" redirect loop).
3. **(Cloudflare — Michael)** **Origin Rule** on `api.tcatlas.org`: set Host
   header → `tc-atlas-api-ip2bfs76hq-ue.a.run.app` (so Cloud Run accepts it).
4. **(Cloudflare — Michael)** **Cache Rule** on hostname `api.tcatlas.org`:
   - Match: all incoming requests to that hostname.
   - "Cache eligibility" = **Eligible for cache**.
   - "Edge TTL" = **Use cache-control header if present** (respect origin).
   - "Browser TTL" = **Respect origin**.
   Cloudflare only caches safe methods (GET/HEAD) and honors `no-store`/
   `private`/`Set-Cookie` → dynamic endpoints stay uncached automatically.
5. **(Claude — verify)** Curl an immutable endpoint twice through
   `api.tcatlas.org` and confirm `cf-cache-status: MISS` then `HIT`, bytes
   identical to the `run.app` origin, and a `no-store` endpoint stays
   `cf-cache-status: DYNAMIC` (never cached). All while prod is untouched.

### Phase B — Frontend cutover (the flip)
6. **(Claude)** Point the frontend `API_BASE` at `https://api.tcatlas.org`.
   Audited 2026-06-12 — exactly **8 files**, all the SAME hardcoded URL
   (`https://tc-atlas-api-361010099051.us-east1.run.app`), so a single
   find-replace: `global_archive.js:32`, `realtime_ir.js:11`,
   `realtime_seasonal.js:56`, `realtime_subseasonal.js:20`, `realtime_tdr.js:39`,
   `sat_quick.js:27` (orphaned but update for consistency), `satellite.js:11`,
   `tc_radar_app.js:1`. (`tc_climatology.js` uses no API_BASE — it reads R2/GCS
   directly.)
7. **(Cloudflare — Michael)** Add `https://api.tcatlas.org` to the Cloud Run
   service's `CORS_ORIGINS` (deploy.sh env) OR confirm CORS isn't the gate
   (same-site fetch from the Pages origin to api.tcatlas.org is cross-origin →
   the API's CORS must allow `https://michaelfischerwx.github.io`; it already
   does — the host the browser calls changes, the Origin header doesn't).
8. **(Claude)** Push → Pages republish → browsers now hit the edge.
9. **(Claude — verify)** Load each page, confirm requests go to
   `api.tcatlas.org`, `cf-cache-status: HIT` on repeat frame loads, no CORS
   errors, no functional regressions.

### Rollback
- Phase A is non-destructive (prod still on run.app).
- Phase B rollback = revert the `API_BASE` constants + republish Pages
  (~1 min). DNS/cache-rule can stay; they're inert once the frontend points
  back at run.app.

## Risks & mitigations
- **Caching a dynamic response** → respect-origin + GET-only + existing
  `no-store` headers on dynamic endpoints make this near-impossible. Spot-check
  in Phase A step 5.
- **Stale genesis data** → `s-maxage=600` caps edge staleness at 10 min;
  genesis cycles are hourly, so acceptable. Lower the rule's TTL or add a
  bypass for `/weatherlab-genesis*` if tighter freshness is wanted.
- **CORS** → the Origin header (Pages site) is unchanged by the host swap; the
  API already allows it. Verify in Phase B step 9; widen `CORS_ORIGINS` if needed.
- **Single point** → Cloudflare already fronts cdn.tcatlas.org (R2); no new
  dependency surface beyond what Phases 1-2 already rely on.

## Cost
- Cloudflare proxy + cache = free plan. Edge egress to browsers is free.
- Cuts Cloud Run egress on the cached endpoints to ~one origin fetch per
  object per edge-TTL window → expected 60-90% reduction on global-archive +
  TC-RADAR frames, meaningful reduction on genesis.

## Relationship to the R2 work
Complementary, not redundant:
- **R2 (Phases 1-3)** = browser fetches large immutable BLOBS (bundles, tiles)
  straight from object storage, zero egress, via 302 / direct URL.
- **API proxy (this)** = edge-caches the API's JSON/compute responses that
  aren't object-storage-backed (rendered frames, genesis ensembles).
Both ride the same `tcatlas.org` Cloudflare zone.
