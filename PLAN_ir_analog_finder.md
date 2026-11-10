# IR Analog Finder — design

Written 2026-11-10. Status: **proposed, nothing built.** Replaces the broader
multi-block "analog engine" draft; what survives of that is under §Later.

**Goal.** Pick any infrared frame of any storm and get back the historical
storm-moments whose IR structure looks most like it, drawn from the MergIR
archive (1998–present). It is image search over storm-centered IR: the result
is a grid of look-alike storms you can open, loop side by side, and compare.

**Why a neural network.** "Looks similar" is hard to write down as a formula. A
vision model turns each image into a short list of numbers (an embedding) such
that similar-looking images get similar numbers; finding analogs is then
finding the nearest lists. GHOST already uses the right model for this (DINOv2
ViT-S/14), so the tooling exists on the Mac.

---

## What the repo already gives us

| Asset | Where | Use here |
|---|---|---|
| IR context layer | `bin/build_ir_context.py` → R2 `ir-context/v1/{YYYY}/{YYYYMMDDHH}.webp` | One near-global 8 km image per 3-hourly time, MergIR from 1998. **One file serves every storm active at that time**, with no Earthdata calls. The fastest way to cut chips for the whole archive. |
| Storm sector frames | `global_archive_api.py`, cache key `v7/ir/{sid}/{frame_idx}.json` | 20°×20° at native 4 km, uint8 Tb. Filled on demand and by `precache_mergir.py`, so coverage is partial. The 4 km source where it exists. |
| Frame index space | `_build_mergir_frame_list` (`global_archive_api.py:1354`) | 3-hourly frames per storm. Using the same indexing means every analog deep-links straight to its frame in Storm Detail. |
| Scene QC | `_mergir_scene_qc` (`global_archive_api.py:1855`) | Rejects frames with missing data, striping or unphysical values. |
| IR center finder | `tc_center_fix.py` | Recenters a chip on the eye when best-track interpolation is off. |
| TC-RADAR IR store | `bin/build_tcradar_mergir_cases.py` | `Tb[case, 9, 550, 550]` for every radar case. Embedding these links IR look-alikes to radar analyses for free. |
| Lifetime Analog Finder | `global_archive.js:4891` | Whole-storm matching on six track and intensity numbers. Stays; this adds matching on what the storm looks like. |
| GHOST image model | TC-SWARM, per `docs/ghost_experimental_overlays.md` | DINOv2 ViT-S/14 on IR chips with 8-rotation averaging. Same backbone, existing inference code. |

**Size of the job** (counted from `ibtracs_tracks_*.json`): 3,007 storms and
180,655 three-hourly frames since 1998, spread over 72,911 distinct synoptic
times. 1980–1997 on GridSat would add 1,959 storms and 127,482 frames.

---

## Chips

One chip per storm-frame, the unit everything else is built on.

* **Extent:** ±448 km around the storm center. Covers the central overcast and
  the principal bands; excludes most of the neighbouring weather.
* **Grid:** 224×224 at 4 km, the model's native input. From the 8 km context
  layer that is a 112×112 crop upsampled 2×.
* **Values:** Tb mapped linearly from 170–310 K to 0–1, the same scale as
  `_encode_tb_uint8`. Never normalized per image: absolute cloud-top
  temperature is part of the structure.
* **Center:** best-track position at frame time, then `find_ir_center` with its
  existing gates. Small eyes are the case where 20–30 km of center error
  changes the picture.
* **Hemisphere:** Southern Hemisphere chips are flipped north–south so cyclonic
  rotation has one handedness. The flip is recorded and undone for display.
* **QC:** `_mergir_scene_qc` thresholds; rejected frames get no entry.

The chips go to a local Zarr store (`uint8 [N, 224, 224]`, ~9 GB before
compression at 4 km, ~2.3 GB at 8 km). That store is a reusable asset in its own
right: it is also the training set for any later model.

### 8 km or 4 km

Start at 8 km from the context layer: it is complete by construction, costs
nothing to read, and needs ~73k downloads (~95 GB, free egress) instead of 180k
rate-limited OPeNDAP subsets. A 20 km eye is 2–3 pixels at 8 km and 5 at 4 km, so
4 km should help exactly for pinhole eyes. Phase 0 measures that on the storms
whose 4 km sector frames already exist before any 4 km backfill is paid for.

The context layer is lossy WebP (mean error 0.7 K) and its docstring says it is
never read for values. Similarity is not a value read, and 0.7 K is far below
the differences that separate structures, but this is an explicit exception to
that rule and Phase 0 checks it against the lossless sector frames.

---

## What "similar" means

Three candidate ways to turn a chip into numbers. Phase 0 compares them; the
winner fills the index.

| | Method | Training | Notes |
|---|---|---|---|
| A | **Polar descriptor.** 25 rings out to 400 km; per ring the mean Tb, its azimuthal spread, and the amplitudes of wavenumbers 1–3. ~125 numbers, plus a Tb histogram. | None | Pure NumPy, fully interpretable, rotation-invariant by construction, and simple enough to run in the browser. The baseline the network has to beat. |
| B | **Frozen DINOv2 ViT-S/14.** 384-number embedding of the chip as a grayscale image. | None | General-purpose visual similarity, known to work for retrieval without fine-tuning. One line of inference code; GHOST's loader already handles it. |
| C | **GHOST's fine-tuned ViT.** The same network after training to estimate intensity. | Already done | Likely to group storms by strength more than by shape. Tested, not assumed. |

A fourth option, for later: fine-tune B on the chip store with no labels, using
frames of the same storm 3 hours apart as "should be similar" pairs. That
teaches TC-specific structure directly and is the natural upgrade if B is good
but not great.

### Orientation

Two vectors are stored per frame:

* **As seen:** the embedding of the north-up chip. Matches have convection on
  the same geographic side.
* **Any orientation:** the average embedding over 8 rotations (what GHOST
  already does at inference). A storm sheared from the west matches one sheared
  from the south.

The interface offers both. For "any orientation" results, the wavenumber-1
phase from descriptor A gives the angle that best aligns each match with the
query, so thumbnails can be shown rotated into register with a north arrow.

### Judging the candidates

There is no ground truth for "looks similar", so three checks:

1. **Sanity:** with same-storm matches allowed, a frame's nearest neighbour
   should usually be the same storm 3 h away. A method that fails this is not
   seeing structure.
2. **Unseen labels:** neighbours should agree on things the method was never
   told: best-track intensity, wind radii, and tilt and RMW on the TC-RADAR
   subset. Reported as the spread among the top 10, per method.
3. **Blind side-by-side:** a throwaway page shows one query and the top 5 from
   two unnamed methods; you pick the better row. Fifty queries settles it, and
   this is the check that counts, because the product is a visual one.

---

## Index and serving

Embeddings are reduced to 64 numbers by PCA and stored as int8: 180,655 frames
× 2 orientations ≈ 23 MB. Exact brute-force search over that takes milliseconds.
No vector database.

**Archive: precomputed, static, no API.** Every frame's neighbours are computed
once at build time (all pairs is a few minutes of matrix multiplication) and
written per storm, the way the GHOST Reanalysis is served:

```
R2  ir-analog/v1/
      index.json            method, version, chip spec, PCA, built_utc, counts
      nn/{sid}.json         per frame: top 100 matches (sid, frame_idx, similarity, align angle), both orientations
      thumbs/{sid}.webp     sprite sheet of the storm's chips, 96 px, grayscale Tb index
      vectors.bin           the int8 index itself, for the live step and for filtered search
      keys.json             per row: sid, frame_idx, time, lat, lon, Vmax, basin, flags
```

* Top 100 with **at most one frame per storm**, never the query storm. Without
  that rule the results are 100 frames of one or two storms.
* Thumbnails store the Tb index, not colors, so they are drawn with whichever
  colormap the user has selected, using the existing lookup table.
* Filters (basin, intensity range, years, over water) are applied in the
  browser to the 100. If filters regularly exhaust them, add
  `GET /global/ir/analogs` that searches `vectors.bin` server-side; the index
  is small enough for the API container's memory.
* Size: about 110 MB of neighbour files and 0.5 GB of thumbnails on R2.

**Live storms.** A producer step embeds each active storm's newest frame,
searches `vectors.bin`, and writes `ir-analog-rt/<ATCF>.json` under the same
contract as the GHOST overlays (index file, one file per storm, R2 with GCS
fallback). Two things to settle there:

* Live imagery is the geostationary mosaic, not MergIR. Chips must be resampled
  to the same 4 km grid and Tb scale, and Phase 2 checks that a live frame
  retrieves its own later MergIR version as a near-perfect match.
* Where inference runs. On the Mac beside GHOST is free and immediate. A Cloud
  Run backstop means exporting the ViT to ONNX and running it on CPU, which is
  plausible for a model this size but unmeasured.

### Files in this repo

| File | Role |
|---|---|
| `ir_analog_core.py` | Chip cutting, hemisphere flip, QC, polar descriptor, PCA/int8 packing, search with the one-per-storm rule. No torch. Shared by builder, live step and tests. |
| `build_ir_analog_chips.py` | Walks the frame list, cuts chips from the context layer (or sector frames with `--source sector`), writes the Zarr store. Resumable. |
| `build_ir_analog_index.py` | Embeds the chip store, fits PCA, computes neighbours, writes `ir-analog/v1/`. Torch is a builder-only dependency, kept out of `requirements.txt`. |
| `ir_analog_panel.js` | The results panel, used by Storm Detail, the Real-Time storm card and TC-RADAR. |
| `tests/test_ir_analog_core.py` | Frame indexing matches the archive's, flip round-trips, one-per-storm, descriptor rotation invariance. |

---

## Interface

**Global Archive, Storm Detail.** A "Similar IR" button on the IR player.

* A grid of matches: thumbnail, name, year, time, intensity at that moment,
  similarity. Hovering a thumbnail plays that storm ±12 h.
* **Synced loops.** Selecting a match opens it beside the query, aligned at the
  matched moment, stepping forward together. Seeing what the look-alike did
  next is the point, and it needs no statistics to be useful.
* As seen / Any orientation switch; basin, intensity and year filters.
* The matches follow the loop cursor: scrub the storm and the grid updates.
* Checkboxes send matches to the existing Compare view.
* When the 10th-best similarity is unusually low for the archive, the panel says
  "no close look-alikes" instead of presenting weak matches as good ones.

**Real-Time Monitor storm card.** A "Looks like" strip of the top matches for
the newest frame, each linking into the archive at the matched frame.

**TC-RADAR.** From a radar case, IR look-alikes; and from any storm, the
look-alikes that have radar analyses, with their tilt and RMW.

---

## Phases

Effort figures are rough guesses, for sequencing only.

| Phase | Deliverable | Effort |
|---|---|---|
| 0 | Pilot on ~8 seasons: chip builder, methods A/B/C, the three checks, the blind comparison page, 8 km vs 4 km. **Picks the method.** | 3–4 days |
| 1 | Full 1998–2025 chip store and index, thumbnails, static neighbour files, the Storm Detail panel with synced loops | 4–5 days |
| 2 | Live step and storm-card strip; TC-RADAR link | 3 days |
| 3 | Sequence matching, label-free fine-tune, 1980–1997 on GridSat | Open |

Phase 0 needs the Mac (torch and the model weights live there). Everything in
`ir_analog_core.py` and method A can be built and tested in this repo first.

---

## Later

* **Sequence analogs.** Match the last 12–24 h of evolution, not one frame:
  compare the series of embeddings. "Storms whose IR evolved like this" is a
  stronger and rarer question than "storms that looked like this".
* **Filters from the environment.** Restrict matches to similar shear or SST
  using the per-fix ERA5 sampling in `build_era5_vi_climo.py`. A filter on top
  of image search, not part of the similarity.
* **Pooled outcomes.** "7 of 25 look-alikes intensified by 30 kt in 24 h." Only
  after a leave-one-year-out hindcast shows the look-alike set beats
  intensity-conditioned climatology (`intensity_changes.json`) and the
  ventilation card (`vi_dv_climo.json`). Until then the interface shows
  individual storms and makes no probability statement.

---

## Risks

* **Similarity that is not structure.** The model may match on chip-wide
  brightness, land, or data seams. The blind comparison catches it; the
  label-free fine-tune is the remedy.
* **Center error** dominates the image for compact storms. Recentering plus the
  QC gates reduce it; the "any orientation" vector does not fix a shifted eye.
* **Intensity twins** from method C. Tested in Phase 0, with A and B as
  alternatives.
* **Live vs archive imagery mismatch**, checked directly in Phase 2.
* **Read as a forecast.** The Experimental label, and no pooled numbers until
  the hindcast under §Later is done.

---

## Open questions

1. Default orientation: "as seen" (what the eye expects) or "any orientation"
   (more and physically better matches, shown rotated)?
2. Is the IR context layer complete on R2 for 1998 onward
   (`bin/ir_context_coverage.py`), and roughly how much of the 4 km sector
   cache is filled? The CDN is not reachable from the session that wrote this.
3. Is ±448 km the right extent, or should the chip be tighter on the core?
4. Is there already a chip store in TC-SWARM from the GHOST Reanalysis that the
   pilot could reuse?
5. Should weak, disorganized systems be searchable, or should the index start
   at tropical-storm strength?
