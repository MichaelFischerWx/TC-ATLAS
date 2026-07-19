# DeepMind Graphics — Quality & Consistency Roadmap

Goal: every DeepMind/FNV3 surface on the RT monitor (map overlays, storm-card
charts, the Invest Ensemble modal, and saved composites) reads as one
professionally designed system — same coastlines, same fonts, same palette,
same margins, same branding.

All line refs are `realtime_ir.js` as of 2026-07-19.

---

## Root causes of the issues in the attached export

1. **Coastline resolution mismatch.** Three different coastline sources are in
   play: the modal Tracks map uses Plotly built-in geo at `resolution: 50`
   (17603); the Trends track map (`_drawTrackTrend` 17073) builds its layout
   via `_genesisGeoLayout` (16995), which omits `resolution` → Plotly's
   default **110m** — the blocky coastlines in the export. The Leaflet
   global/detail maps use vendored NE **10m** GeoJSON (413).
2. **Map "smaller" than the trend chart.** The composite stitcher
   (`_genesisRenderComposite` 19901) gives every panel the full W=1800 slot,
   but scattergeo fits data bounds and centers in its box, leaving side
   whitespace — cartesian panels are full-bleed, geo panels are not.
3. **Font split.** `_genesisTheme` uses DM Sans, but geo axis labels and the
   composite canvas header use Inter/Helvetica (16986, 20034), and the
   watermark uses DM Sans (20115). Worse: Plotly `toImage` can't see Google
   web fonts (see memory `feedback_plotly_export_webfont_overflow`), so
   DM Sans panels silently rasterize in a fallback font in exports.
4. **Two brand colors for "ensemble mean":** cyan `#00e5ff` on card/global
   map (12456–57) vs orange `#f97316` in the modal (17480).

---

## Phase 1 — Shared foundations — ✅ SHIPPED 2026-07-19

Small refactor inside `realtime_ir.js`; no visual redesign yet.
Foundations block lives at the "DEEPMIND SHARED DESIGN TOKENS" banner
(search for it in realtime_ir.js; sits right above the WeatherLab overlay
section).

- [x] `_dmIsDark()` — dark-theme predicate (used by all new helpers; the
      remaining inline checks migrate opportunistically as functions are
      touched).
- [x] `_dmChartLayout(opts)` — cartesian layout builder (+ `_dmGridColor`,
      `_dmRefLineColor`, `_dmLegendInset`). Adopted by the IC panes
      (ΔV-dist core, P(RI), LMI-by-hour) and all four card DM histograms —
      this also FIXED their hardcoded dark-only grid/ref-line colors and
      fixed slate-on-dark `#5b6573` fonts (they now follow the theme).
      The big intensity fan chart keeps its tuned layout but inherits the
      font stack via `_genesisTheme`.
- [x] `_dmGeoLayout(bounds, opts)` + `_dmGeoInset()` — ONE geo builder used
      by both `_renderGenesisMap` and `_drawTrackTrend`; `resolution`
      defaults to 50. `_genesisGeoLayout` deleted.
- [x] SS palette: `_DM_SS_STOPS` single table now derives both
      `_GENESIS_SS_SCALE` (continuous) and `_DM_SS_COLORS`/`_dmWindColor`
      (discrete); super-Cat5 dark ramp aligned to the scale colors
      (light theme still deepens toward royal violet so bars don't vanish).
- [x] `_DM_MEAN_COLOR = '#f97316'`; `_WEATHERLAB_MEAN_COLOR` now aliases it
      (card fan, card/detail-map mean, global-map mean all orange); card
      histogram mean lines and IC median annotation switched cyan → orange.
      Cyan stays for members/spread and UI branding accents.
- [x] `_DM_FONT_STACK` (`"DM Sans", -apple-system, "Helvetica Neue", Arial`)
      enforced via `_genesisTheme` for every DM chart, used by all geo axis
      labels (was Inter), and added to `theme.js` `plotlyTheme()` site-wide.

Verified 2026-07-19 in browser (light + dark): modal Tracks map, Trends tab,
Intensity Change panes, composite export lightbox. Note: theme flips while
the modal is open don't re-render already-drawn modal charts (pre-existing
behavior — charts pick up the right theme on next render).

## Phase 2 — Map quality (the user-visible fix)

- [x] Coastlines: `resolution: 50` via `_dmGeoLayout` for all Plotly geo
      panels (110m → 50m fixes the Trends map) — shipped with Phase 1,
      verified in browser. Stretch (open): drop Plotly's
      built-in geo and render the vendored NE 10m GeoJSON as scattergeo line
      traces so all maps share literally the same coastline data as the
      Leaflet maps (also fixes the stale "50m" comment at 4638).
- [ ] Same bounds-fit logic on both maps (Tracks map fits container aspect at
      17433; trend map should share it) so screen and export aspect agree.
- [ ] Add the orthographic locator inset (`geo2`, `_renderGenesisMap`) to the
      Trends map — or deliberately omit it everywhere in trend context; make
      it an option flag, not drift.
- [x] Axis-label size: 12px everywhere (shipped with Phase 1 —
      `_genesisAxisLabelTraces` bumped 11 → 12px, font stack unified).
- [x] Consistent land/ocean tokens: `--surface` CSS var reads now live
      inside `_dmGeoLayout` (shipped with Phase 1).

## Phase 3 — Export/composite polish (the "saved figure" look)

- [ ] **Full-bleed geo panels**: in `_genesisMapExportFig` (19784), compute
      lon/lat bounds to exactly the panel's W:H aspect (pad the shorter axis)
      so the map fills its 1800px slot like the cartesian panels. This fixes
      the "map is a different size" complaint.
- [ ] Unify scale factors: composite uses SS=2 + FONT_SCALE=2.8; single-panel
      `_genesisSavePNG` uses scale=4 on native width. Pick one target
      (e.g. everything renders at a 1800×SS logical width, scale 2) so a
      single panel and its composite sibling look identical.
- [ ] Header/footer typography from the Phase-1 font stack; title, subtitle,
      footer, and watermark share one family + weight ramp (today header =
      Inter, watermark = DM Sans).
- [ ] Consistent branding block: TC-ATLAS wordmark + "DeepMind FNV3 …" credit
      + save timestamp in one styled footer for BOTH composite and
      single-panel exports (`_tcStampExport` vs `_drawExportCaption` differ).
- [ ] Keep the Safari geo→SVG path (`_panelExportURL` 19875) — it works;
      just make sure SVG panels embed the same font stack.
- [ ] Respect current theme in exports (already policy —
      `feedback_save_theme_matches_view`); spot-check dark-mode composites
      after the token unification.

## Phase 4 — Chart-level design pass

With shared builders in place, one deliberate pass over each panel:

- [ ] Standard heights per role (map 1000 / primary chart 760 / secondary
      540 / sparkline 380 are already in `_GENESIS_SUMMARY_SPECS` 19548 —
      name them, reuse on screen too).
- [ ] Gridlines: light hairlines only on the value axis; no full boxes.
- [ ] Direct labeling over legends where possible (trend chart already labels
      "47 kt" points — good; extend the pattern).
- [ ] Number formatting: kt as integers, probabilities as whole %, consistent
      date format (`07/19 06Z`) across trend axis, scrubber, and header.
- [ ] Prior-run ramp `_genesisPriorColor` (17032): check contrast of the
      slate→cyan steps on both themes; consider opacity ramp of one hue.
- [ ] Card DM histograms (23648–24030): adopt `_dmChartLayout`, bump 9px font
      to the standard small size, align bar palette with the unified SS
      module.

## Phase 5 — Nice-to-haves (backlog)

- [ ] Composite "report" layout: two-column grid option for the overview
      composite (map left, intensity right) instead of a long vertical strip.
- [ ] Subtle land shading / graticule on geo panels for a publication look.
- [ ] Shared colorbar/legend component between the map vmax colorbar
      (`_genesisVmaxColorbar` 20258) and modal panels.
- [ ] Export at true 2× "retina" with `@2x` filename suffix.

---

## Sequencing & effort

| Phase | Effort | Risk |
|---|---|---|
| 1 Foundations | ~1 session | Low (refactor, behavior-preserving) |
| 2 Map quality | ~½ session | Low |
| 3 Export polish | ~1 session | Medium (canvas stitcher math) |
| 4 Design pass | 1–2 sessions | Low, incremental |
| 5 Backlog | opportunistic | — |

Verification per phase: `node -c realtime_ir.js`, then browser check of
(a) global-map genesis overlay, (b) storm-card charts, (c) each modal tab,
(d) one saved composite per tab, light + dark theme, desktop + iOS save path.
