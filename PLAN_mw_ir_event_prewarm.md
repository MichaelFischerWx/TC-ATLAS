# PLAN — Event-driven IR prewarm on microwave-pass arrival (Fix B)

## Problem

The IR↔Microwave compare modal (`realtime_ir.js:_rtRenderMwCompare` →
`_rtDrawIrCompareFrame`) fetches the storm-centered IR frame closest to the
MW overpass time from `GET /ir-monitor/storm/{atcf}/ir-frame.jpg`. On a GCS
cache hit it loads in ~0.5 s. On a miss it does a **synchronous cold render
from S3** (~10 s), and if the granule isn't renderable yet the endpoint
returns **502 `No IR data for frame`** → the modal shows "IR frame
unavailable for this pass."

The slots that *should* be warm are already pre-rendered by
`_mw_compare_ir_slots()` (`ir_monitor_api.py:2452`), wired into
`run_prewarm_cycle()` at `ir_monitor_api.py:2775`. The gap is **timing**, not
absence:

- MW pass times are **discovered reactively** — `nrt_passes_for_storm`
  (`microwave_api.py:580`) reads `manifest_latest_48h.json`, which only gains
  an entry **after `mw_ingest.py` processes the granule** (NRT latency
  ~45 min GMI … ~200 min AMSR2).
- The matching IR slot is then rendered on the **next ~10-min prewarm
  cycle**. A freshly-detected invest may not have completed *any* cycle yet.
- A user who opens the modal inside that window hits the cold path.

**Fix A (shipped)** extended the client retry budget (~18 s / 4 sequential
attempts) so transient errors self-heal and the failure message is honest.
Fix B closes the underlying latency so even the first viewer is fast.

## Goal

When a new MW pass lands in the NRT manifest, render+cache the matching IR
slot(s) **immediately**, not on the next scheduled cycle — without adding
render *volume* (these slots are already rendered each cycle today) and
without duplicate concurrent renders.

## Key constraint: where CPU lives

- The API (`ir_monitor_api.py`) runs cpu-throttled (`min=1`) when
  `IR_INLINE_PREWARM=0`; background threads there are CPU-starved between
  requests. This is exactly why prewarm was moved OUT of the API into
  `prewarm_job.py` (a Cloud Run Job that gets full CPU).
- ∴ The render must happen in a CPU-bearing job (`prewarm_job` or
  `mw_ingest` itself), **not** in an API background thread.

## Recommended design (tiered)

### Tier 1 — MW catch-up sub-cycle (low effort, do first)

Add a lightweight scheduled pass that runs more often than the full 6 h
prewarm and renders **only newly-appeared MW slots**:

- New entry point alongside `run_prewarm_cycle()`, e.g.
  `run_mw_catchup_cycle()`, scheduled every ~2–3 min (separate Cloud
  Scheduler → `prewarm_job.py` arg, or a `--mode mw-catchup` flag).
- For each active storm: `slots = _mw_compare_ir_slots(lat, lon, frame_times)`,
  then render via the existing `_fetch_and_cache_ir(...)` worker.
- Because every slot is **cache-checked before render** (`_gcs_jpg_get` /
  `_gcs_rt_get`), already-warm slots are no-ops. Real new-slot count per
  tick is ~0–1, so this is nearly free.

Cuts worst-case staleness from ~10 min to ~2–3 min. Reuses everything;
no ingest changes, no new infra beyond a second scheduler trigger.

### Tier 2 — true event trigger from `mw_ingest` (optional, after Tier 1)

After `mw_ingest.py` writes the manifest, trigger an immediate render of the
matched IR slot(s) for the affected storm:

- Cleanest, CPU-correct path: `mw_ingest` (already a CPU-bearing job) imports
  and calls the render directly for just `(atcf, rounded_slot, interp_pos)`
  after publish — or executes a tiny scoped `prewarm_job` task via the Cloud
  Run Jobs API.
- Avoid triggering the API endpoint for the render (CPU-throttled; see
  constraint above). An API endpoint may *enqueue* but must not *render*.

Shrinks staleness to seconds. Only worth it if Tier 1's ~2–3 min proves
insufficient in practice.

## Dedup (baked in — applies to both tiers)

There is **no per-frame single-flight lock today**: `_ir_frame_cache_lock`
(`ir_monitor_api.py:1003`) guards an in-memory dict, not render coalescing.
Two cheap guards, layered:

1. **Cache-check-before-render (already present).** Both `_fetch_and_cache_ir`
   and the endpoint check `_gcs_jpg_get` / `_gcs_rt_get` first, keyed by
   `(ATCF, YYYYMMDDHHMM, _pos_key)` where `_pos_key` (`:164`) rounds the
   interpolated center to 0.1°. This already prevents re-rendering anything
   already cached — so the periodic cycle won't redo what catch-up/event did.
2. **In-flight set** to stop *concurrent* renders of the same uncached frame
   (catch-up tick vs full cycle vs Tier-2 trigger racing):
   ```python
   _ir_inflight: set = set()            # {(ATCF, dt_str, pos_key)}
   _ir_inflight_lock = threading.Lock()

   def _claim_render(key) -> bool:
       with _ir_inflight_lock:
           if key in _ir_inflight:
               return False             # someone else is rendering it
           _ir_inflight.add(key)
           return True
   # ... finally: discard in a try/finally around the render
   ```
   Wrap the render body in `_fetch_and_cache_ir` (and the endpoint's S3
   fallback) with `_claim_render` / `finally: _ir_inflight.discard(key)`.
   Use the SAME `_pos_key` so the claim key matches the cache key exactly.

`_prefetch_lock` (`:2446`, `acquire(blocking=False)` at `:2495`) already
serializes whole prewarm *cycles* against each other; the catch-up sub-cycle
should share it (or its own non-blocking lock) so a catch-up tick is skipped
while a full cycle is mid-flight.

## Touch points

| File | Change |
|---|---|
| `ir_monitor_api.py` | `run_mw_catchup_cycle()`; `_ir_inflight` set + `_claim_render`; wrap render bodies in `_fetch_and_cache_ir` (`:2612`) and `get_ir_frame_jpg` S3 fallback (`:5643`) |
| `prewarm_job.py` | `--mode mw-catchup` (or new entry) dispatching to the catch-up cycle |
| `deploy_prewarm_job.sh` / scheduler | second Cloud Scheduler trigger @ ~2–3 min for catch-up mode |
| `mw_ingest.py` *(Tier 2 only)* | post-publish hook → scoped render / job execute |

## Effort / risk

- **Tier 1:** ~half a day. Low risk — reuses cache-checked render path; worst
  case is a few redundant cache-hit lookups every couple minutes.
- **Dedup:** ~1–2 h. Low risk; purely additive guard.
- **Tier 2:** ~1 day incl. wiring + testing the ingest→render trigger.
  Medium risk (cross-job coupling); defer unless Tier 1 is insufficient.

## Open questions

1. Catch-up cadence — 2 min vs 3 min? (Cost is trivial either way; pick by how
   fresh the modal needs to feel.)
2. Should the catch-up cycle also cover the newest 6 h slots (publish-lag
   self-heal), or strictly MW-matched slots? Strictly-MW keeps it cheapest.
3. Tier 2 trigger mechanism if pursued: direct in-process render in
   `mw_ingest` vs Cloud Run Jobs API execute. Lean in-process (simpler, no
   new IAM).
