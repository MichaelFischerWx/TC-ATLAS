# R2 / Egress Migration — Status & Handoff

**Last updated: 2026-06-13. Read this first** — it's the single source of truth
for the Cloudflare R2 egress-reduction effort. Detail docs:
[`R2_MIGRATION_PLAN.md`](R2_MIGRATION_PLAN.md) (R2 phases),
[`CLOUDFLARE_API_PROXY_PLAN.md`](CLOUDFLARE_API_PROXY_PLAN.md) (proxy — abandoned, see below).

## TL;DR

Goal: cut the ~$19/14d-and-climbing egress bill (Cloud Run egress 123 GiB/14d +
GCS downloads). Strategy: move browser-fetched bytes onto Cloudflare R2
(zero egress) via `cdn.tcatlas.org`, served either as direct objects (tiles,
bundles) or via write-through + 302 redirect (rendered frames).

**Done & live:** ERA5/seasonal tiles on R2; the 3 biggest Cloud Run egress
endpoints (~81%) moved to R2. **Parked:** RT-bundle serving cutover (needs an
active storm), microwave bucket, HD archive, genesis endpoint.

## Infrastructure facts (don't re-derive)

| Thing | Value |
|---|---|
| Cloudflare zone | `tcatlas.org` (Free plan) |
| R2 bucket | `tc-atlas-rt` |
| R2 public host | `cdn.tcatlas.org` (custom domain → bucket; CORS `*`, GET/HEAD) |
| Cloudflare account ID | `4f3e5ab095ae4962e91af5b33c6deb54` |
| R2 S3 endpoint | `https://4f3e5ab095ae4962e91af5b33c6deb54.r2.cloudflarestorage.com` |
| R2 token scope | **Object Read & Write only** — CANNOT set bucket lifecycle or zone config |
| GCP project | `tc-atlas-web` · region `us-east1` · service `tc-atlas-api` |
| Secrets (Secret Manager) | `r2-access-key-id`, `r2-secret-access-key` (compute SA has accessor) |
| Service env (already mounted) | `R2_ENDPOINT_URL`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `PUBLIC_BUNDLE_BASE` (empty) |
| Mirror job | `tc-atlas-r2-mirror` Cloud Run Job + scheduler (6h), `deploy_r2_mirror_job.sh` |

## DONE

- **Phase 0 — infra.** Bucket, `cdn.tcatlas.org`, CORS, secrets, R2 config+creds
  wired into `deploy.sh` / `deploy_prewarm_job.sh` / `deploy_mw_job.sh`.
- **Phase 1 — RT bundle dual-write** (commit `522ef499`). Public RT bundles
  dual-write GCS+R2; serving still GCS (`PUBLIC_BUNDLE_BASE` empty). Frontend
  `realtime_ir.js` reads `rt-version.json` `base` to switch roots. **Cutover
  pending** (see below). Validated via synthetic R2 write.
- **Phase 2a — archive tiles** (commit `b8206ed3`). `era5_daily_1deg`,
  `era5_climo`, `era5_monthly_vpi`, `seasonal`, `subseasonal` cut over to
  `cdn.tcatlas.org` (frontend constants in `realtime_seasonal.js`,
  `realtime_subseasonal.js`, `tc_climatology.js`). Mirror job keeps R2 fresh.
  Kept on GCS: `env/` (hourly churn), `era5_daily_00z` (HD, Phase 2b), `era5_daily` (dead).
- **Phase 3 — Cloud Run egress (~81% of heavy traffic):**
  - **band-raw-bundle** (commit `05dacaf4`, 67%) — new `/storm/{id}/band-raw-bundle`
    packs band frames, dual-writes GCS+R2, 302s; frontend `_fetchBandRawBundle`.
    Activates on next active storm.
  - **`/global/ir/frame`** (commit `fc552b10`, 10%) — mirror frame to R2 + 302.
    LIVE, verified on historical SID 1980201N08155.
  - **TC-RADAR `/ir_frame`** (rev `00405-bv8`, 4%) — same pattern. LIVE, verified
    on case 478/lag 7.

## REMAINING (pick up here)

### 1. Phase 1 cutover — RT bundles GCS→R2 serving  *(Task #8; biggest pending win)*
Bundles already dual-write to R2. Cutover = serve them from `cdn.tcatlas.org`.
- **Prereq A (Michael, Cloudflare dashboard):** Caching → Configuration →
  **Browser Cache TTL = "Respect Existing Headers"**. Currently overrides the
  bundles' `max-age=300` to 14400 (4h) → would stale the IR loop
  (`realtime_ir.js:4438` relies on origin Cache-Control). Phase-2 tiles are
  immutable so this didn't matter for them; for RT bundles it does.
- **Prereq B:** an **active storm** (0 at handoff) so R2 has real bundles to byte-compare.
- **Steps:** byte-compare a live bundle (GCS vs `cdn`); then set
  `PUBLIC_BUNDLE_BASE=https://cdn.tcatlas.org` on `tc-atlas-api` AND
  `tc-atlas-prewarm-job` via `gcloud run services/jobs update --update-env-vars`
  (NO rebuild needed). Confirm `rt-version.json` gains `"base"`. Watch 1 day.
  Validate the band-raw-bundle on the same storm.
- **Rollback:** unset `PUBLIC_BUNDLE_BASE` (frontend falls back to GCS; instant).

### 2. R2 lifecycle rule  *(Michael, dashboard — token can't do it via API)*
R2 → `tc-atlas-rt` → Settings → Object Lifecycle Rules → prefix `rt-v`, **delete
after 14 days** (bundle hygiene). Does NOT touch `era5_*`/`seasonal`/`v6/`/
`tcradar-ir/` (different prefixes — those persist, kept fresh by mirror / immutable).
Consider a separate longer-TTL rule for `v6/` + `tcradar-ir/` if they grow unbounded.

### 3. Microwave bucket  *(low priority — $0.28/14d)*
`tc-atlas-microwave-nrt`. `mw_ingest.py:1852,1861-1862` embeds absolute
`storage.googleapis.com` URLs in the manifest → coordinated change: builder emits
`cdn.tcatlas.org` URLs + copy bucket to R2 + mirror + frontend
(`realtime_ir.js:~18544/18549`, `tc_mw_layer.js:43-44`).

### 4. Phase 2b — HD archive  *(Task #9; cost-gated)*
`era5_daily_00z` (78 GiB, ~$9 one-time copy egress). Only if HD-toggle egress
justifies it. Copy GCS→R2, add to `deploy_r2_mirror_job.sh` PREFIXES, swap
`EVO_ARCHIVE_BASE_HD` (`realtime_seasonal.js:4029`) to `cdn`.

### 5. weatherlab-genesis  *(~16% Cloud Run egress; coordinate with Michael)*
His active genesis code (`ir_monitor_api.py` `get_weatherlab_genesis`). Options:
cache the computed ensemble JSON to R2 keyed by `init_time` + 302 (it already
emits `s-maxage`); OR the Cloudflare API proxy (see #6). Left alone for now.

### 6. Cloudflare API proxy — ABANDONED on Free plan
Origin-Rules **Host-Header override is paywalled** in Michael's dashboard, and
Cloudflare↔Cloud Run SNI/cert is fragile. **Do not retry via Origin Rules.** If
ever revisited, use **Cloud Run domain mapping** (`gcloud run domain-mappings`,
one DNS record) instead. A stray `api` CNAME + SSL=Full are left in the CF
dashboard — inert/harmless; delete the `api` record or ignore.

## The reusable R2+302 recipe (for any other immutable endpoint)
1. Reuse helpers in `global_archive_api.py`: `_r2_frame_exists(key)` (HEAD),
   `_r2_mirror_frame_async(key, dict)`, `_public_frame_url(key)` →
   `cdn.tcatlas.org/{key}`. (Lazy-import them, as `tc_radar_api.py:get_ir_frame` does.)
2. Pick a stable, sanitized R2 key from the request's immutable params.
3. Top of handler: `if _r2_frame_exists(key): return RedirectResponse(_public_frame_url(key), 302, headers={"Cache-Control":"no-store"})`.
4. Existing return path(s): `_r2_mirror_frame_async(key, result)` then return JSON.
5. Graceful by design: R2 unavailable → falls through to streaming. First hit
   streams once + mirrors; subsequent hits 302. No frontend change (fetch follows 302).

## Operational gotchas
- **`deploy.sh` default deploys CLEAN `origin/main`** (NOT the working tree —
  the old "ships dirty tree" note is stale). So: commit + push, then `./deploy.sh`.
  Use `--dirty` only for testing uncommitted WIP. It auto-redeploys the prewarm job.
- **GitHub Pages deploys from `main`** → pushing republishes the frontend.
- **Concurrent work:** Michael edits the genesis feature in `ir_monitor_api.py` +
  `realtime_ir.js` (shared files) in another session. Coordinate; never `--dirty`
  deploy or `git add` those files without confirming they're his-committed.
- **Cloudflare dashboard** intermittently renders blank panes / "unable to
  authenticate" — browser-extension/adblock issue; Incognito or hard-refresh fixes it.
- API origin host (for any proxy work): `tc-atlas-api-ip2bfs76hq-ue.a.run.app`
  (also `tc-atlas-api-361010099051.us-east1.run.app`).
