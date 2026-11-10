# Structural Analog Engine — design

Written 2026-11-10. Status: **proposed, nothing built.**

**Goal.** For any storm at any moment, live or archived, find the historical
storm-moments that most resembled it in structure, environment and recent
history, and show what those storms did next. One index, three surfaces: the
Real-Time Monitor storm card, the Global Archive Storm Detail, and TC-RADAR.

**The one decision that gates everything else.** Whether the analog set is
shown as *guidance* ("7 of 25 similar storms rapidly intensified") or only as a
*browse tool* ("similar storms") is decided by a hindcast, not by taste. Phase 0
builds that hindcast before any UI. If the analog ensemble does not beat the
baselines in held-out years, the feature still ships, without the forecast
framing.

---

## What already exists

| Piece | Where | What it does | Limit |
|---|---|---|---|
| Analog Storm Finder | `global_archive.js:4891` | Scores whole storms on six hand-weighted lifetime scalars (peak, 24-h RI rate, genesis point, genesis→LMI bearing and distance, day of year, ACE). Client-side, top 20, feeds Compare. | Lifetime summaries. Cannot be asked of a storm mid-life, and knows nothing about structure or environment. |
| Ventilation context | `build_era5_vi_climo.py` → `vi_dv_climo.json`, card in `realtime_ir.js:10971` | Next-24-h ΔV distribution by ventilation-index bin, 1991–2025, per basin. | One variable. This is the engine's single-predictor special case and its first baseline. |
| Seasonal analog years | Seasonal tab | SST pattern correlation by year. | Season scale, unrelated index. |
| GHOST image member | TC-SWARM `realtime/vitghost/`, described in `docs/ghost_experimental_overlays.md` | DINOv2 ViT-S/14 fine-tuned on IR chips, 4 seeds, 8-rotation TTA, runs every 30 min on the Mac. Reanalysis covers 1998–2025 (42k+ frames, `global_archive_ghostra.js`). | Only the intensity read is published. The embedding behind it is discarded. |
| TC-RADAR case table | `tc_radar_metadata_v4.json` | 1,640 swath analyses with tilt, RMW, SHIPS-style environment and 12/24-h ΔV. | Sparse in time. |

**On the neural net.** The neural network in this repo's orbit is the GHOST
vision transformer (and the CNN it replaced). Its code lives in TC-SWARM, which
this repo only references, so everything below about it comes from
`docs/ghost_experimental_overlays.md` and the comments in
`realtime_experimental.js`. It is the natural backbone: it already runs on every
live frame and has already been run over the whole reanalysis, so the image
embedding costs one extra return value, not a new model. If the platform you
remember was something else, it is not visible from this repo and §Open
questions asks for a pointer.

---

## The state record

One record per storm-moment. Moments are GHOST frames for 1998–2025 (the image
block needs a chip) snapped to the nearest best-track time. Order of magnitude:
3,007 IBTrACS storms since 1998, 42k+ GHOST-RA frames.

Each record is five blocks. Every block carries a present/absent bit, and the
distance skips absent blocks instead of imputing them.

| Block | Fields | Archive source | Live source |
|---|---|---|---|
| **History** | Vmax, ΔV over the prior 12 and 24 h, \|latitude\|, translation speed, hours since genesis, distance to land | IBTrACS | ATCF + GHOST |
| **Environment** | 850–200 hPa shear magnitude, shear heading relative to motion, 600-hPa RH or χ_m, SST, potential intensity, ventilation index | The per-fix ERA5/OISST sampling `build_era5_vi_climo.py` already does (it computes all of these on the way to VI and keeps only VI) | The `/storm/{id}/shear` payload, which already carries `chi_inputs` and `ventilation` |
| **IR scalars** | Azimuthal-mean Tb profile (8 radial bins), eye-minus-eyewall Tb, cold-cloud fraction inside 100 and 300 km, wavenumber-1 amplitude, wavenumber-1 phase relative to shear, 6-h trend of each | GHOST chip cache | Same |
| **IR embedding** | ViT pooled embedding (384-d), PCA-reduced to ~24 | One pass of the production ViT over the GHOST-RA chips | `vit_rt_reads.py`, exported alongside the read |
| **Vortex** (sparse) | Tilt magnitude, RMW, eyewall-region wind at 0.5 and 2 km | `tc_radar_metadata_v4.json` | Recon-tab TDR analyses |

Three choices in that table are deliberate:

* **Scalars and embedding are separate blocks.** The scalars are interpretable
  and need no network. Phase 0 runs on them alone, which gives a result even if
  the embedding export is delayed, and tells us how much the network adds.
* **Asymmetry phase comes from the scalars, not the embedding.** Averaging the
  ViT over 8 rotations makes the embedding roughly rotation-invariant, so it
  cannot tell convection downshear from convection upshear. The shear-relative
  wavenumber-1 phase carries that.
* **Southern Hemisphere chips are mirrored** before the scalars and embedding so
  cyclonic rotation has one handedness in the index.

### The embedding caveat

The ViT was fine-tuned to regress intensity. Its embedding is therefore
organized mostly along intensity, and analogs chosen by it alone will tend to be
"storms of the same strength", which the History block already supplies. Three
candidates, compared in the Phase 1 ablation:

1. Fine-tuned embedding, with intensity projected out (regress each PCA
   component on Vmax, keep residuals).
2. Frozen DINOv2 ViT-S/14 features, before fine-tuning: generic texture, no
   intensity collapse, no TC knowledge.
3. Both concatenated.

A purpose-trained metric (a small projection trained so neighbours share
outcomes) is Phase 4 and only if 1–3 leave skill on the table. The effective
sample size is ~3,000 storms, not 42,000 frames, so a learned metric overfits
easily.

---

## Distance and retrieval

```
d(q, x) = Σ_b  w_b · m_b(q,x) · ‖z_b(q) − z_b(x)‖² / n_b   /   Σ_b w_b · m_b(q,x)
```

`z_b` is the block standardized on the training years, `n_b` its length, `m_b`
is 1 when both records have the block, `w_b` the block weight.

Retrieval rules, all of which matter more than the metric:

* **One match per storm.** Keep each historical storm's best-matching moment
  only. Without this the top 20 are 20 frames of one storm.
* **Never the storm itself**, and in the hindcast never a storm from the
  held-out year.
* **Land-matched outcomes.** An analog that made landfall inside the outcome
  window is dropped unless the query storm's track also crosses land in that
  window. Otherwise decay over land leaks into an over-water forecast.
* **Hard gates before distance:** tropical or subtropical phase, and Vmax within
  ±20 kt. Cheap, and it keeps a weak block from pulling in absurd matches.
* **Basin pooling is a user toggle**, default all basins. Latitude is in the
  History block, so the metric already prefers similar regimes.
* **Say when there are no good analogs.** Publish the distance of the k-th
  neighbour as a percentile of typical k-th-neighbour distances. A Category 5
  under 30 kt of shear has few precedents and the panel should say "no close
  analogs" instead of presenting the nearest far ones as if they were close.

`w_b` starts equal. Phase 0 then fits the five weights by minimizing hindcast
CRPS of ΔV24 with leave-one-year-out. Five parameters, not a network.

---

## Outcomes

Stored per record so retrieval returns them directly:

* ΔV at +12, +24, +48, +72 h (best track)
* RI flag (≥30 kt / 24 h) and rapid-weakening flag
* Land-in-window flag per lead time
* The storm's Vmax series from −24 to +72 h, for the aligned plume
* Where a TC-RADAR analysis falls within ±3 h: tilt and RMW

Best-track ΔV is noisy outside recon basins. The builder keeps a parallel set of
outcomes from GHOST-RA so the hindcast can be scored both ways.

---

## Hindcast (Phase 0, the go/no-go)

`analog_eval.py`, leave-one-year-out over 1998–2025.

For every held-out moment: retrieve k=25 analogs from the other years, form the
ΔV24 ensemble from their outcomes, score.

| Metric | Against |
|---|---|
| CRPS of ΔV24, and of ΔV48 | (a) intensity-conditioned climatology from `intensity_changes.json`; (b) the ventilation-bin distribution in `vi_dv_climo.json`; (c) persistence of the prior 12-h trend |
| Brier skill for RI | Same three |
| Reliability of the RI fraction, PIT histogram of ΔV24 | Flat |
| Block ablation | History only → +Environment → +IR scalars → +embedding (three variants) |

Reported per basin and per intensity class, because global skill can hide a
basin where the tool is worse than climatology.

**Go for the guidance framing:** positive CRPS skill against all three baselines
in held-out years, in at least the Atlantic, east Pacific and west Pacific, with
a reliability curve that does not need recalibration by more than a few points.
Anything less ships as "similar storms" with outcomes shown per storm and no
pooled probability.

The method has precedent: the analog-ensemble technique (Delle Monache et al.
2013, MWR) and its application to hurricane intensity from HWRF predictors
(Alessandrini et al. 2018, MWR). Both citations are from memory and need
checking before they go on the site. What is new here is matching on observed
structure instead of model output.

---

## Serving

The index is small. ~45k records × ~70 float32 ≈ 12 MB raw, ~3 MB as int8 after
standardizing. Brute-force nearest neighbours over that is a few milliseconds in
NumPy and under 50 ms in plain JavaScript. No vector database, no new service.

```
R2  analog/v1/
      index.json        schema, block layout, standardization, weights, version, built_utc
      features.bin      int8  [N × D]
      outcomes.bin      int16 [N × 12]   ΔV at 4 leads, flags, TDR tilt/RMW
      keys.json         per record: sid, ISO time, GHOST frame id, Vmax, lat, lon
      plumes.bin        int8  [N × 17]   Vmax −24…+72 h at 6-h steps
    analog-rt/
      index.json        storms in the current pass
      <ATCF>.json       query vector, top-25 with per-block distances, pooled stats, "no close analogs" flag
```

* **Archive queries run in the browser.** The query is a record already in the
  index. Storm Detail fetches the ~3 MB bundle once, then recomputes analogs as
  the loop is scrubbed or a block is toggled. This is how the current Analog
  Storm Finder works, and it costs nothing to serve.
* **Live queries are precomputed by the producer.** The storm card reads one
  small JSON and never downloads the index. This follows the GHOST overlay
  contract in `docs/ghost_experimental_overlays.md`: an `index.json` listing
  storms, one file per storm, R2 with GCS fallback, dropped with the series
  cache every 10 minutes.

### Producer (TC-SWARM, on the Mac)

A step after the v6.1 shadow pass, under the same lock:

1. `vit_rt_reads.py` returns the pooled embedding with each read.
2. `analog_rt.py` assembles the live record (History from ATCF + GHOST,
   Environment from the cached `/shear` payload, IR blocks from the chip), runs
   the shared distance code against `analog/v1`, writes `analog-rt/<ATCF>.json`.

Live analogs are therefore exactly as available as GHOST. SEAR has a Cloud Run
backstop (`Dockerfile.sear`); whether this needs one depends on whether the ViT
can run on CPU in a job, which is a question for the TC-SWARM side.

### Files in this repo

| File | Role |
|---|---|
| `analog_core.py` | Block layout, standardization, distance, retrieval rules. Imported by the builder, the hindcast and the producer, the way `favorability.py` is shared between the API and the climatology builder. |
| `build_analog_index.py` | Extends the `build_era5_vi_climo.py` per-fix sampling to keep the full Environment block, joins IBTrACS history and outcomes, joins the embeddings and IR scalars parquet exported from TC-SWARM, writes `analog/v1/`. |
| `analog_eval.py` | The hindcast and ablation above. Writes a JSON report the methods text is generated from. |
| `tc_analog.js` | Loads the bundle, runs the same distance in JS, renders the panel. Used by `realtime_ir.js` and `global_archive.js`. |
| `tests/test_analog_core.py` | One-per-storm, self-exclusion, land matching, absent-block masking, and a fixture asserting the JS and Python distances agree. |

---

## Interface

**Real-Time Monitor storm card: "Storms like this now".**

* A fan chart: analog Vmax plume aligned at now (median, 10–90%), with the
  official forecast and the DeepMind ensemble mean drawn over it.
* One sentence: "7 of 25 similar storms intensified by 30 kt or more in 24 h
  (typical for this intensity: 2 of 25)." Shown only if the hindcast passes.
* A strip of analog cards: IR thumbnail at the matched moment, name and year,
  intensity then, a sparkline of the next 72 h.
* "Why these match" on each card: one bar per block showing its share of the
  distance, in the spirit of GHOST's "Why this number".
* Click a card to open that storm in the Global Archive at the matched frame.
  "Compare" sends the selection to the existing Compare view.
* Block chips (Structure / Environment / History) to turn blocks off. On the
  live card this swaps between a few precomputed variants.

**Global Archive Storm Detail: "Moment analogs".** The same panel, following the
IR loop cursor. The existing finder stays and is relabelled "Lifetime analogs";
the two answer different questions.

**TC-RADAR bridge (Phase 3).** From a satellite-only moment, list the nearest
moments that *did* have a radar analysis, and show the distribution of their
tilt and RMW: "storms that looked like this from above had this vortex structure
when a P-3 sampled them." No other site can make that statement, and it turns
1,640 sparse analyses into context for every storm.

All of it carries the Experimental label and a line stating that it is a
historical comparison, not a forecast.

---

## Phases

Effort figures are rough guesses, for sequencing only.

| Phase | Deliverable | Needs TC-SWARM | Effort |
|---|---|---|---|
| 0 | `analog_core.py`, `build_analog_index.py` with History + Environment + IR scalars, `analog_eval.py`, the hindcast report. **Go/no-go.** | Chip cache access for the IR scalars; History + Environment alone need nothing | 3–4 days |
| 1 | Embedding export and backfill, three-variant ablation, pick one | Yes | 2 days |
| 2 | `tc_analog.js` and the Storm Detail panel, client-side | No | 3–4 days |
| 3 | Live producer step and the storm card; TC-RADAR bridge | Yes | 3–4 days |
| 4 | Microwave block from TC-PRIMED; learned metric; 1980–1997 extension on GridSat | Partly | Open |

Phase 0 restricted to History + Environment can start in this repo today and
already generalizes the ventilation card from one predictor to six.

---

## Risks

* **Intensity twins.** The embedding adds nothing beyond Vmax. Caught by the
  ablation; fallback is IR scalars only.
* **Thin precedent at the extremes**, exactly where interest is highest. Handled
  by the "no close analogs" flag, not by widening the search silently.
* **Read as a forecast.** Mitigated by labelling, by showing individual storms
  first and pooled numbers second, and by publishing the hindcast scores in the
  methods text, as the GHOST verification table does.
* **Best-track noise in the outcomes** outside recon basins. Scored both ways
  (best track and GHOST-RA); if they disagree, say so per basin.
* **Train/serve skew.** Archive Environment is ERA5, live is GFS. The ventilation
  climatology already documents matching regions and SST product between the two
  paths; the builder reuses that code instead of re-deriving it.

---

## Open questions

1. Is the GHOST ViT the neural-net platform you had in mind? If it was something
   else, where does it live?
2. Are the GHOST-RA chips still cached locally, so the embedding and IR-scalar
   backfill is one pass and not a re-download of MergIR?
3. Does the ViT run acceptably on CPU? That decides whether a Cloud Run backstop
   is possible for the live step.
4. Chip geometry (size in km, centering rule). The IR-scalar radial bins should
   match it.
5. Should outcomes default to best track or to GHOST-RA outside the Atlantic and
   east Pacific?
