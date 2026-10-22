# GHOST experimental overlays: data flow

The Experimental tab (`realtime_ir.html#experimental`, `realtime_experimental.js`,
profile `blend`) can draw opt-in test versions of GHOST as dashed lines on the
chart. They are off by default, and each one's on/off state is remembered per
browser. The tiles, headline numbers and other panels always show the
published GHOST.

| Button | Gate (`PROFILES.blend.panels`) | localStorage key | Object prefix (R2, GCS fallback) | Producer |
|---|---|---|---|---|
| GHOST v6.1 (experimental) | `vit: true` | `tcatlas.exp.vit` | `ghostb-v61-rt/` | `realtime/v61/` (2026-10-22; was GHOST v6 (ViT) on `ghostb-vit-rt/`, 2026-10-20) |
| GHOST + CNN (test) | `cnn: false` (off; code kept) | `tcatlas.exp.cnn` | `ghostb-cnn-rt/` | `realtime/cnnghost/shadow_blend.py` |
| CNN RMW (test) | `rmwcnn: true` (unchanged) | `tcatlas.exp.rmwcnn` | `ghost-rmwcnn-rt/` | `realtime/cnnghost/rmw_hybrid_publish.py` |

Producer paths are in TC-SWARM (`~/Scripts/Test/Cowork/TC-SWARM`).

## Page side

1. A button click flips `_showVit` / `_showCnn` and calls `drawSeries()`.
2. `overlayFor(key, atcf)` fetches `<prefix>/index.json` once (`no-store`). Only
   if the storm is listed does it fetch `<prefix>/blend_<ATCF>.json` from
   `https://cdn.tcatlas.org/`, falling back to
   `https://storage.googleapis.com/tc-atlas-ir-cache/`.
3. The fetched frames supply `frames[].t`, `vmax_kt` and `pmin_hpa`, drawn as
   one dashed trace per panel with one legend entry. A storm missing from the
   index gets a legend entry "…: not run on this storm".
4. `refreshIfStale()` (every 10 min while the tab is visible) drops every
   overlay cache along with the series.

## Producer side (Mac launchd, TC-SWARM `realtime/`)

```
com.fischerwx.ghost-rt  (:15 / :45)  ghost-rt-cron.sh, lock /tmp/ghost-rt-cron.lock.d
  ghost_rt_all -> out/ghost_<ATCF>_goes.json      (live tree)       -> ghost-rt/
  fpm_rt_all   -> out/fpm_<ATCF>.json             (FPM member)      -> fpm-rt/
  blend_rt_all -> out/blend_<ATCF>.json           (published GHOST) -> ghostb-rt/
  IR chips cached in ~/Data/IR/ghost_frame_cache/<ATCF>_<YYYYmmddHHMM>_<tag>[_u<hash>].npz

com.fischerwx.ghost-cnn-shadow  (:28 / :58)  cnnghost/shadow_all.py, lock /tmp/ghost-cnn-shadow.lock.d
  waits for the live lock; never overlaps a live pass
  1 cnn_rt_reads.py        -> ~/Data/IR/ghost_cnn_reads/<ATCF>.parquet  (CNN reads)
  2 ghost_rt_cnn_shadow.py -> out_shadow_cnn/ghost_<ATCF>_goes.json     (SHADOW tree:
                              live ghost_rt.py + the GHOST + CNN Stage-0 bundle)
  3 shadow_blend.py        -> ghostb-cnn-rt/   live FPM + shadow tree through
                              blend_rt_all.build_payload            ["GHOST + CNN (test)"]
  [proposed hook, see below]
  4 rmw_hybrid_publish.py  -> ghost-rmwcnn-rt/                        ["CNN RMW (test)"]
```

`com.fischerwx.fpm-rt` no longer exists: FPM was folded into the ghost-rt
chain on 2026-08-18, and `fpm-rt-cron.sh` is now only a shim.

The CNN overlay is the shadow tree's own composition: the live blend code
(`blend_rt_all`) run on the shadow tree. In `realtime/v6/vit/ref/rt26_all.py`
its analogue is the `hyb` column, which recomputes it with the research port
of `blend_storm`. It has no land rule, because real time carries none until
the v6.1 port (GHOST_PARSIMONY doc §40.2).

## The ViT overlay (GHOST v6 image member, doc §38.6)

```
shadow_all.py, after step 3 (hook: realtime/vitghost/shadow_all_hook.patch, NOT applied)
  -> vitghost/shadow_vit.py --in-pass --publish <storms of the pass>
     a vit_rt_reads.py -> ~/Data/IR/ghost_vit_reads/vitP26_<ATCF>.parquet
        production ViT (DINOv2 ViT-S/14 fine-tuned, 4 seeds, 8-rotation TTA, MPS) on the
        cached chips of the live and shadow trees' frames; IQ2 flags; incremental (path + mtime)
     b vit_blend.py    -> out_shadow_vit/blend_<ATCF>.json + index.json (+ rt_<ATCF>.csv)
        -> ghostb-vit-rt/
```

The composition is `rt26_all.py`'s `blend_v` / `blend_p` with `CNN26_READS=vit`
and no `LAND_L1`. That is the same land/QC variant as the CNN overlay: the
real-time accept mask `qc_flag == 0` and no land rule.

- **Wind:** ½ tree (the shadow tree's `lay_v_sm`) + ½ ViT member. The ViT
  member is the reads under the causal 4-h kernel on accepted frames, with
  IQ2-flagged chips skipped and a log knee at 185 kt. Then the WPR step at
  ≥ 130 kt in AL/EP/CP (none in WP/IO), then the v5.1 fill.
- **Pmin:** `blend_storm(FPM, tree tier)`, then the DP1 guard.

The gate (real time == reanalysis) is `realtime/vitghost/gate_vit.py` against
`realtime/v6/vit/ref_outputs/rt26vit_<ATCF>.csv` on the finished 2026 storms.
On 2026-10-20 all 57 finished storms reproduced it exactly, both with the
reference's reads and end to end with the real-time reads. The per-storm
table is `realtime/vitghost/gate/gate_table.md`.

Status (2026-10-20): live. The producer has published `ghostb-vit-rt/`
since 21:50Z, with the hook in `cnnghost/shadow_all.py` since 21:51Z; this
page went out after it. The member carries the §58 physical pressure bound
(Pmin ≤ Penv − 1 hPa on the member and on the blend). Operations and
rollback are in TC-SWARM `realtime/vitghost/README.md`.

## The v6.1 overlay (2026-10-22, replaces the v6 ViT overlay on the same button)

The dashed button now reads `ghostb-v61-rt/`: GHOST v6.1 in real time, the model behind the GHOST Reanalysis v6.1.

- **Composition:** the reanalysis composition code itself, `realtime/v61/v61_core.py`, gated bit-exact against the GHOST-RA v6.1 chains.
- **Inputs:** the potential intensity comes from GFS (`realtime/rt_pi.py`).

```
com.fischerwx.ghost-v61-shadow  (:02 / :32)  v61/shadow_v61.py, holds /tmp/ghost-cnn-shadow.lock.d with its pid
  1 cnnghost/ghost_rt_v61_shadow.py -> out_shadow_v61/ghost_<ATCF>_goes.json  (v6.1 tree + R1 ViT reads + OISST + GFS PI)
  2 cnnghost/fpm_rt_v61_shadow.py   -> out_shadow_v61/fpm/fpm_<ATCF>.json    (FPM v2.1 member, GFS PI, v6.1 gate key)
  3 v61/v61_blend.py                -> out_shadow_v61/blend_<ATCF>.json      (v61_core: the GHOST-RA v6.1 composition)
  4 v61/publish_v61_rt.py           -> ghostb-v61-rt/ (changed payloads + merged index)
finished 2026 storms: v61/replay_v61_2026.py -> out_shadow_v61_2026/ (same steps in archive mode), published by step 4
```

The v6 ViT producer (`ghostb-vit-rt/`) still runs. Nothing on the page reads it now.
