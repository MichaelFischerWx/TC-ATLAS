# RT Monitor — in-place MapLibre engine swap (plan)

**Goal:** the *exact* deployed RT-monitor interface, with the only difference being
the map + satellite rendering done on MapLibre (smooth WebGL). Developed on branch
`gl-engine-swap`; deployed `main` stays Leaflet until a single cutover at parity, so
the live site is never degraded.

## Architecture decision — a Leaflet-compat facade over MapLibre

Build **`lflet_gl.js`**: a focused facade implementing the *subset of the Leaflet API
that `realtime_ir.js` actually uses*, backed by a MapLibre map. The branch's
`realtime_ir.html` loads `lflet_gl.js` **instead of** `leaflet.js`; `realtime_ir.js`
(and therefore all chrome: panels, deck, tabs, storm card, state) runs **essentially
unchanged** → the UI is identical *by construction*. This is the only approach that
guarantees "exact UI" — a parallel rebuild can't (we proved that).

The **one intended edit** to `realtime_ir.js`: the composite IR `GridLayer` becomes a
MapLibre raster source on the `mosaic-v1` tiles (the mosaic *deletes* the hardest
Leaflet layer — see the 4 `*.GridLayer.extend` classes at 1277/1408/1480/1669).

**Why a facade is feasible** (incl. the hard parts): the custom canvas layers
(`L.Layer.extend`: env barbs @17206, recon barbs @22208, microwave `tc_mw_layer.js`
@322) project lat/lon → pixel and draw on a pane canvas. The facade supports this by:
pane → a positioned DOM `<div>`; `latLngToContainerPoint` → `map.project`; the layer's
`getEvents()` redraw → re-fired on MapLibre's `render`/`moveend` (so the canvas stays
synced during continuous zoom). Drawing logic is untouched.

**Cutover** = swap the one `<script>` (leaflet → lflet_gl), keep the IR-source edit,
merge to `main` — only after the parity sweep (increment 9).

## Surface to cover (~290 map calls: 220 `L.*`, 51 `map.*`, 82 pane/overlay/Grid/Dom, 17 projection)

| Leaflet | → MapLibre (via facade) |
|---|---|
| `L.map('ir-map', opts)` (initMap @2953) | `maplibregl.Map` + nav/scale ctrls; `preferCanvas`/`zoomSnap` no-ops |
| composite IR `GridLayer` ×4 | **raster source on mosaic-v1 tiles** (the intended edit) + `raster-resampling:nearest` |
| `globalAnimFrameLayers` / `showGlobalAnimFrame` @2743 | per-frame raster opacity swap (flicker-safe pattern) |
| `L.tileLayer` (basemap, labels) | raster source |
| `L.imageOverlay` (env overlays ×3 antimeridian) | `image` source (world-wrap native) |
| `L.geoJSON` (coastline @335, contours) | geojson source + line layer (GPU; fixes the 242 ms cost) |
| `L.marker`/`circleMarker`/`divIcon` + `L.popup` | `maplibregl.Marker`(HTML el) + `Popup` |
| `L.layerGroup`, panes, `L.DomUtil`/`DomEvent` | group bookkeeping; pane = DOM div; thin Dom helpers |
| `L.Layer.extend` canvas (barbs, microwave) | facade custom-canvas-layer (redraw on `render`, `project`) |
| detail map (initDetailMap @5296) + per-frame recenter (@6377) | 2nd `maplibregl.Map`; recenter = `map.jumpTo`/`easeTo` |
| PNG/GIF export (html2canvas / capture) | `preserveDrawingBuffer:true` + `map.getCanvas()` capture |

## Increments (each = one reviewable commit; branch GL page builds up; `main` untouched)

1. **Facade foundation + map init + IR mosaic + animation.** `lflet_gl.js` core
   (map nav/events/projection, raster/image/geojson sources, panes); swap the IR
   GridLayer → mosaic raster source; wire `showGlobalAnimFrame` to opacity swap.
   *Verify:* global IR animates on GL inside the real chrome; basemap, zoom smooth.
2. **Static overlays.** coastline, labels, graticule, env image + contour overlays
   through facade primitives. *Verify:* Labels/Grid/Legend rail + env "Model" menu.
3. **Markers + popups + chrome controls.** storm/genesis/invest markers, popups;
   confirm left rail, Layers dropdown (IR/GeoColor/Microwave), DeepMind deck all
   render+work (they call the facade). *Verify:* counts, pins, popups vs live.
4. **Custom canvas layers — env wind barbs + ASCAT.** facade canvas-layer + barb
   redraw on `render`. *Verify:* barbs track the map through continuous zoom.
5. **Storm-card detail map.** 2nd map; per-frame recenter (camera follow); the card
   IR loop sourced from `mosaic-v1` z6/z7 storm sectors. *Verify:* open a storm.
6. **Recon overlay.** HDOB barbs + dropsondes + VDM (facade canvas layer).
7. **Microwave** (`tc_mw_layer.js` `_MosaicClass`, 1598 lines → facade canvas layer).
   Biggest single rewrite; do it isolated.
8. **Export.** PNG/GIF capture (`preserveDrawingBuffer`, capture-once compositing).
9. **Parity sweep + cutover.** side-by-side vs deployed Leaflet page, feature by
   feature; fix gaps; flip the `<script>` + merge to `main`.

## Effort (focused-work estimate)

| Inc | Est | Inc | Est |
|---|---|---|---|
| 1 facade+map+IR | 3–4 d | 6 recon | ~2 d |
| 2 overlays | 1–2 d | 7 microwave | 3–5 d |
| 3 markers+ctrls | 1–2 d | 8 export | 1–2 d |
| 4 canvas barbs | 2–3 d | 9 parity+cutover | 2–3 d |
| 5 detail map | 2–3 d | **Total** | **~3–5 weeks** |

## Risks & mitigations
- **Facade projection/pane/canvas fidelity** → port incrementally, diff each overlay vs live.
- **Microwave layer size** → isolate to its own increment; it's self-contained.
- **Export** (WebGL capture differs from html2canvas) → `preserveDrawingBuffer`, test early on inc 8.
- **Perf of canvas barbs redrawing every frame** → throttle redraw during active zoom if needed.
- **Branch GL page is WIP mid-port** → fine; `main` (deployed) stays Leaflet; cutover only at parity.

## Parity gate (before merge to main)
Side-by-side the branch GL page and the deployed page across: global IR + animation,
all Layers panel controls, env model layers, storm markers/genesis pins, storm card
(IR loop + intensity + recon + microwave), export (PNG/GIF), and the four tabs render.
No visual/functional regressions → flip `<script>` + merge.
