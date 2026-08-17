# GHOST Finalization — Recommendation

**2026-08-17.** Prepared from a full review of the TC-SWARM record (all `docs/*.md`
adjudication documents through 2026-08-16, the frozen FPM v1.0 manifests, the
GHOST-RA v2 release document, and the model/composition code). Paths below refer
to the TC-SWARM repo unless marked otherwise. This document answers: *what should
the final GHOST be — the model that feeds the TC-SWARM reanalysis and fits in a
paper?*

---

## 1. The recommendation in one page

**Finalize GHOST as a two-member, regime-blended consensus — not a winner-take-all
choice between the manuscript GBM and FPM:**

- **Vmax channel — GHOST's direct LightGBM head, unchanged, plus the two v2.4
  bias corrections** (upward-only ≥120 kt specialist; pressure-derived WPR blend
  above 130 kt). FPM contributes nothing to wind: its derived wind is at pooled
  parity but concedes ~6 kt of RMSE and −11 kt of bias at Cat 4–5 to the direct
  head. The Vmax channel is at the ±10 kt label-noise floor (SNR 0.12) — there is
  no headroom for any architecture to find, and the record explicitly closes
  further wind estimators.

- **Pmin channel — GHOST's composed pressure ladder owns the deep tail; FPM
  v1.0 enters as an independent ensemble member in the weak/mid regime**, with
  the blend window selected by the same nested per-fold machinery FPM already
  uses for its internal DUO handover (unanimous (960,15) across 216 LOSO folds).
  This is the one blend the data actually supports: the FPM member was the *only*
  resolved gain in the entire v3.x ladder (−0.716 hPa [−0.98,−0.47] pooled, 20×
  the best variant-to-variant delta), while at ≤920 hPa the leak-free comparison
  resolves **in GHOST's favor** (dRMSE +3.14 [+0.99,+4.63]; deep bias +4.36 GHOST
  vs +10.07 FPM-pure).

- **Ship it as GHOST-RA v3 through the release contract built for v2**
  (score-on-publish, immutable versions, per-basin protocol labels,
  `recon_fdeck_mslp` as the truth flag). Publish frozen estimates; quote held-out
  skill.

**Why a blend and not FPM alone:** the impression that FPM is more skillful at
the high end was true against the *manuscript's raw Stage-0 head* (≤920 recon
stratum: 11.96/+7.57 vs 19.06/+15.45 hPa) — but not against the *deployed GHOST
composition*, and the 2026-08-16 leak finding reversed the deep-tail verdict
outright. FPM's LOYO board fed `dp0`/`dph` seed features derived from a
leave-one-STORM-out board (97% of the effect through `mpi*dph`); purified, FPM's
≤920 line degrades 11.63/+6.84 → **13.44/+9.31**, and the deployed stack is now
*resolved better* at the deepest cut. FPM's real, surviving wins are the **weak
end** (>1000 hPa: 3.34/−0.84 vs the manuscript's 3.94/−2.03 — inside every
pre-registered bar) and **pooled ensemble diversity**. The blend takes exactly
those and nothing else.

**Why not the manuscript model alone:** its published Pmin head carries an
isotonic floor at 904.67 hPa and +15.5 hPa deep bias on the 28-season
population. The deep-pressure skill of the deployed stack is a *composition*
property — removing the Pmin specialist costs +0.71 hPa at ≤920, removing the D5
tier +5.19 — so the final model must keep those two stages. They are the only
composition stages that survive ablation on the pressure side.

**One caveat gates the freeze:** every FPM-vs-GHOST comparison to date pits FPM
held-out against GHOST frozen. The record's single named blocking run — a GHOST
leave-one-year-out board on the 28-season population — must be completed first
(§5.1). It is likely much cheaper than advertised.

---

## 2. What the evidence record actually shows

### 2.1 The evolution, compressed

| generation | what it is | verdict on record |
|---|---|---|
| Manuscript / Part 1 | 6-stage LightGBM: Vmax head + temporal/decay-inertia predictors + OOF isotonic + gated quantile tail heads + causal smoothing + coupled Pmin head; 72 features | **Ships as written.** Held-out 2025: Vmax 6.8 kt (beats D-PRINT, AiDT, ADT), Pmin 6.4 hPa; Cat 5 resolved better than D-PRINT. Limitation: isoP floor 904.67 hPa, deep bias |
| GHOST 2.0–2.1p | gated ridge specialists over production | **Rejected** (specialist overrides production where production is already right) |
| v2.3.x (deployed) | + corridor base, Pmin specialist, D5 deep tier, land bridge, de-circularized gates | ≤920 Pmin −8.41 hPa resolved vs v2.2; floor broken (Melissa 895.9 vs truth 892). A trade toward the tail |
| v2.4 (deployed) | + upward-only ≥120 specialist + WPR wind blend ≥130 kt | A **bias correction, not a skill gain**: Cat-5 wind \|bias\| 3.58 → 1.18 (71% of the systematic low bias removed) at a small resolved Cat-3/4 RMSE cost. Pmin unchanged (bit-identical to v2.3) |
| v2.5–v3.1 | base retrains, thirteen variant boards | **Gradient exhausted**: v3.0→best-v3.1 null (−0.036), 0.287 hPa spread across ten boards. Only the FPM ensemble member resolved (−0.716 pooled) |
| FPM-30→34 → v1.0 | ridge on √(Penv−Pmin), ~50 coefficients + deep-MPI specialist + weak head gated on GHOST's wind + WPR wind | Beats the manuscript head in every stratum; **null vs deployed pooled; resolved worse vs deployed at ≤920 leak-free**. Weak end inside all bars. C1–C3, C5 pass; C4 passes only on a purpose-built population |

### 2.2 Where each model is best, on recon truth (the decisive stratum)

Pmin, RMSE/bias in hPa, `recon_fdeck_mslp` frames:

| regime | manuscript head | deployed GHOST | FPM v1.0 | who wins |
|---|---|---|---|---|
| weak (>1000) | 3.94 / −2.03 | — | **3.34 / −0.84** | FPM |
| pooled | 6.96 / +0.70 | (GHOST-RA v2 recon: 7.84 / +1.27) | 7.25 / +0.78 (LOYO) | ~tie; FPM member adds −0.7 resolved |
| ≤940 (recon, 15 storms) | 14.69 / +9.63 | **11.15 / −0.94** | 10.50 / +3.50 | FPM on RMSE, GHOST on bias |
| ≤920 (recon, 14 storms) | 19.06 / +15.45 | **10.96 / +4.96** | 11.96 / +7.57 (leak-free worse) | **GHOST** (rule 5: bias decides the tail) |

Vmax: the direct head owns Cat 4–5 (deployed ~8.6 kt vs derived-wind 14.1 on
matched frames); everything is tied at the pooled label floor. The v2.4 WPR
blend exists precisely because the one defect that matters at Cat 5 — systematic
−5 kt bias — is fixable from the model's own pressure.

### 2.3 On simplicity — correcting the premise

The "FPM is simpler" claim was audited by its own author and downgraded
(`FPM_V1_CLAIM_AUDIT_2026-08-15.md`): like-for-like (Pmin + wind, AL) it is **10
stages vs 13**, and counting everything that ships FPM is the *larger* object (16
stages, 17 hand-set constants on the headline path, 23 across basins). What FPM
genuinely has is **explainability** — a printable ridge coefficient table and a
stated physical functional form — and the blend keeps that intact for the paper.
The pre-registered position stands: *"explainability does not buy a 9 hPa
weak-end deficit"* — and, symmetrically, it does not justify surrendering the
deep tail.

---

## 3. The RMW → Vmax question — explored, priced, closed

You remembered correctly: this was tested directly (`fpm_rmw_wind.py`), plus an
oracle decomposition that prices the entire idea.

- The shipped WPR **already carries an IR size term**: `log r_eyewall` (the
  coldest-ring radius, 6-h EWM) and its √ΔP interaction — deliberately an IR
  measurement, *not* an RMW estimate.
- A **TC-RADAR-Doppler-trained RMW head** (corr +0.64, MAE 15.3 km vs 20.5
  climo — real skill, and the right Part-2 deliverable) swapped into the WPR
  size term is **aggregate-null**: Milton +9 kt, Dorian unmoved. The head is
  built from 4-km IR and cannot see pinhole eyes either — the beam-filling wall
  is demonstrated at every layer (features, Pmin, RMW, wind).
- The **oracle ceiling**: true ΔP + true RMW gives 8.5 kt pooled and −7 kt at
  ≥137 — *oracle RMW adds nothing over oracle ΔP alone*. `corr(residual, log RMW
  | ≥113) = +0.204`: the mechanism is real but ~4% of variance. Intrinsic
  wind-pressure scatter at Cat 5 is ~7 kt — irreducible at label quality.
- Physical closures are worse: `V = c·√ΔP` +7.8 kt at ≥150; Holland-B from IR
  eyewall radius worse still; CLE inversion 22.99 kt pooled, −42 kt at ≥137
  (IR→R34 collapses to climatology, MAE 23 vs 24 km).

**Recommendation: do not spend more on this.** Keep Stage-1 RMW as the
TC-SWARM stage-1 product and Part-2 deliverable it already is; keep the IR ring
radius term in the WPR; route any future Cat-4/5 wind gain through *deeper Pmin*
(worth ~4 kt at Cat 4+ through the WPR, for free) via the microwave/ABI
compact-core door — the one identified lever.

---

## 4. Land interaction — your concern is confirmed, with one twist

**FPM has no land bridge and no inland-decay component.** Its entire land
treatment is two static ridge covariates added at FPM-34 (`land_fraction`,
`land_fraction × deficit` — a small resolved pooled gain, −0.125 hPa, and a
timing fix for Irma-at-Cuba, not a depth fix). There is a **measured, named,
unfixed defect**: FPM's 734 frames at `dist2land == 0` carry **−8.09 hPa** bias
(*"Land is a separate standing defect of the channel"* — `docs_decay_cell.md`).
No landfall reset, no decay memory, no time-over-land state.

**GHOST's treatment is layered and mostly published**: `dist2land` as a Vmax
predictor, the land-aware decay-inertia state with full-track landfall resets
(in Part 1), over-land exclusion from training/scoring (≥10 km), and the
v2.3.1 land bridge — a Kaplan–DeMaria-style exponential inland decay
(post-processor, unpublished).

**The twist:** the standing "delete the land bridge, it is inert (0 of 20,751
frames)" recommendation in `OPTIMAL_GHOST_2026-08-13.md` is a **population
artifact**. The bridge writes only onto QC-masked frames, and the scoreboard
filters to `ok==True` — so it *cannot* fire on any board frame by construction.
It was written for a real product defect (Melissa 2025 frozen at 161 kt for a
day through landfall) and still guards it. **Do not delete it.** Instead:

1. **Keep the land bridge in the product path**; fix the three-way spec drift
   (plan says 40 km taper, docstring 100 km, code 30-km-with-full-only-at-0) by
   making the code's behavior the documented one.
2. **Gate the FPM member over water.** Given FPM's −8 hPa over-land bias and
   absent decay state, the consensus must fall back to GHOST-only (bridge
   included) wherever `dist2land < 10 km`. This also removes the sharpest
   protocol inconsistency: today GHOST trains/scores over-water only while FPM
   trains/scores everything, so head-to-heads on the union population are
   comparing different problems.
3. **State the reanalysis land policy explicitly in the payload**: over-land
   frames carry a land flag; bridged spans render dashed (the explorer already
   does this); the paper states the policy in one sentence.
4. Future work, not blocking: the size-aware `d2l/RMW` taper (the Otis-vs-Keith
   discrimination) named in `land_bridge.py` — a natural Stage-1 tie-in.

---

## 5. Pre-freeze checklist (ordered; 1–2 gate the freeze, the rest gate the release)

1. **Run the blocking symmetry check — the GHOST LOYO board on the 28-season
   population.** Likely cheaper than advertised: `v23_lifecycle_build.py`
   already builds the lifecycle board per-LOYO-year (`loyo_models/prod_{Y}`,
   corridor ridges refit per fold, D5 tier year-subset), so what is genuinely
   un-nested is narrow — the WPR's 3 coefficients ("minutes"), five composition
   scalars swept on the scoring board ("hours"), and a board column actually
   labeled LOYO. Resolve that discrepancy first; worst case is one overnight
   28-bundle retrain (precedent: ~9.5 h). Then re-run the FPM-vs-GHOST deep
   comparison **held-out vs held-out**, recon-stratified. *Decision rule:* if
   GHOST held-out still wins ≤920 on bias, the §1 blend stands as specified; if
   it flips, widen the FPM window downward — the architecture is unchanged
   either way, and the nested selector sets the window.
2. **Fix the live deployed-GHOST defect before anything is re-scored**: the
   four floor rows + five uncontained warm-bound rows in
   `al_lifecycle_table.parquet` (corridor ridge driven to 236 kt / 805.5 hPa;
   Gonzalo 2014 published 944.2 vs 979 truth). The correct test already exists
   in `qc_provenance.flag_frames` and is disabled by a column-name mismatch;
   adopt the `drop` arm (frame-level better on both targets).
3. **Unify the recon flag everywhere**: `recon_fdeck_mslp` (barometer within
   ±3 h) is the authority; the legacy flag has a hard 64-kt floor and its fix
   lists end in 2024 (which silently deletes Melissa from the decisive
   stratum). The explorer still reads the floored flag
   (`build_fpm_e6_explorer.py:573`) — fix, and recompute the dropped per-storm
   recon metrics.
4. **Nested blend selection for the FPM member** (reuse the DUO-34b handover
   harness; no hand-set windows), with the over-water gate from §4. Note the
   FPM weak head's gate is keyed on GHOST's deployed wind — inside the
   consensus this becomes an internal dependency, which is cleaner than the
   current cross-product coupling, but it must be stated in the paper.
5. **Freeze and publish as GHOST-RA v3** under the release contract: manifest
   with column-by-name provenance and hashes, score-on-publish, immutable
   versions, per-basin protocol labels (AL/EP frozen with held-out channels
   beside; WP transfer, wind withheld outside AL — already decided). Remediate
   the two v2 gate failures (uniform_channels; the CP basin-label defect that
   fails open) as part of this.
6. **Prune the genuinely dead stages** (specialist floor on broad bias, tier
   arbitration, damping variants, peak rebasing and parity QC → reclassified as
   evaluation machinery) — but **not** the land bridge (§4) and **not** the Pmin
   specialist or D5 tier (ablation-protected).

---

## 6. How it fits in a paper

- **Part 1 ships as written** — the record re-affirms this after every
  challenge, most recently with *more* margin. It documents the 6-stage GHOST
  and is the citation for the Vmax channel and the base Pmin head.
- **The companion (FPM) paper is strengthened, not weakened, by the blend**:
  FPM v1.0's honest story — beats the published head everywhere, weak end
  inside pre-registered bars, deep tail resolved on a 15-storm expanded
  population, *and adopted into the final product as the weak/mid-regime
  member of a two-model consensus* — is a better adoption narrative than an
  overturned winner-take-all claim. The leak finding and its quantification
  belong in this paper; it is the kind of methods honesty that makes the
  reanalysis credible.
- **The final-model description is one section, not a paper**: two named
  estimators (one published, one fully specified as a coefficient table), one
  nested blend window, one WPR, one land policy. The GHOST-RA reanalysis paper
  (or the TC-SWARM stage-0 section) carries it, with the recon-stratified
  scoreboard as its verification table and the release-contract manifest as its
  provenance appendix.

## 7. What NOT to do (all measured, all closed)

- No more v3.x variant letters (0.287 hPa spread, nothing resolved).
- No predictor cuts (18 of 24 paired comparisons resolved worse; the 72-feature
  table stays).
- No new wind estimators, no RMW-informed WPR, no CLE closure, no output-side
  bias maps (five failures), no re-litigating the wind decision.
- No quoting the leaky FPM LOYO numbers, `duo_win950_990` beside LOYO numbers,
  or any deep claim in EP at ≤920 (the basin holds 7 such storms — the
  constraint is the ocean).
- Do not delete the land bridge on the strength of the board count (§4).

---

## Appendix — sources

Key documents (TC-SWARM repo): `docs/FPM_V2_RESCORE_2026-08-16.md` (the
reversal), `docs/OPTIMAL_GHOST_2026-08-13.md` + `docs/ONE_PAPER_GHOST_SPEC_2026-08-13.md`
(the one-paper spec), `docs/FPM_V1_0_REVIEW_2026-08-15.md` +
`experiments/stage0_intensity/docs_FPM_V1_0_MANIFEST.md` (frozen v1.0),
`docs/FPM_V1_CLAIM_AUDIT_2026-08-15.md` (simplicity audit),
`experiments/stage0_intensity/docs_GHOSTRA_V2_RELEASE.md` (release contract,
leak quantification), `docs/GHOST_24_SPEC.md` + `docs/GHOST24_25_ASSESSMENT_2026-08-09.md`
(v2.4), `docs/GHOST_3_ARCHITECTURE_V2.md` (SNR framing),
`experiments/stage0_intensity/docs_c4_truthsource_strat.md` (recon strata),
`realtime/FPM_RT_IMPLEMENTATION_PLAN.md` (wind decision),
`experiments/stage0_intensity/land_bridge.py` + `docs_decay_cell.md` (land).

Evaluation conventions carried forward: storm-clustered bootstrap NB=4000, seed
20260814/20260813 per doc; bias decisive at the tail (rule 5); truth-source
stratification mandatory (C5); `recon_fdeck_mslp` as the recon authority.
