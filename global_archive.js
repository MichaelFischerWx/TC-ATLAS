/* ══════════════════════════════════════════════════════════════
   Global TC Archive — Frontend Logic
   TC-RADAR · Dr. Michael Fischer · University of Miami / NOAA HRD
   ══════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ── GA4 analytics helper ─────────────────────────────────────
function _ga(action, params) {
    if (typeof gtag === 'function') {
        try { gtag('event', action, params || {}); } catch (e) { /* silent */ }
    }
}

// ── Configuration ────────────────────────────────────────────
var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
var STORMS_JSON = 'ibtracs_storms.json';
var TRACKS_MANIFEST = 'ibtracs_tracks_manifest.json';
var TRACKS_JSON_FALLBACK = 'ibtracs_tracks.json';  // Fallback for single-file mode
var TC_RADAR_LOOKUP_JSON = 'tc_radar_lookup.json';

// ── State ────────────────────────────────────────────────────
var tcRadarLookup = null;    // storm_name_year → {case, n} (loaded async)
var allStorms = [];          // Full storm metadata array
var allTracks = {};          // SID → track points dict
var filteredStorms = [];     // Currently filtered subset
var selectedStorm = null;    // Currently selected storm object
var stormMap = null;         // Leaflet map (browser tab)
var detailMap = null;        // Leaflet map (detail tab)
var markerCluster = null;    // MarkerClusterGroup
var allMarkerMap = {};       // SID → L.marker (for lookup)
var trackLayer = null;       // L.layerGroup for browser track
var detailTrackLayer = null; // L.layerGroup for detail track
var activeBasins = ['ALL'];  // Active basin filter
var filterDebounce = null;   // Debounce timer
var mapViewMode = 'tracks'; // 'cluster' or 'tracks'
var trackViewLayer = null;   // L.layerGroup for track-view polylines
var trackCanvasRenderer = null; // L.canvas renderer (created after map init)

// Overwater 24-h intensity change episodes (loaded from intensity_changes.json)
var intensityChangeData = null;

// F-Deck state
var fdeckVisible = false;       // Whether f-deck traces are currently shown
var fdeckData = null;           // Cached parsed f-deck data for current storm
var fdeckLoaded = false;        // Whether f-deck data has been fetched for current storm
var fdeckTraceCount = 0;        // Number of f-deck traces currently on the chart

// IR animation state
var irPlaying = false;
var irFrameIdx = 0;
var irFrames = [];           // Cached frame data
var irMeta = null;           // HURSAT metadata
var irTimer = null;
var irSpeed = 750;           // ms per frame
var irOverlayLayer = null;   // L.imageOverlay on detail map
var irPositionMarker = null; // L.circleMarker showing current storm center
var trackAnnotationMarkers = []; // Genesis, LMI, dissipation markers (hidden during IR)
var irOverlayVisible = false;
var irTrackVisible = true;       // Track + position marker visible on detail map
var detailTrackElements = [];    // All track polylines/markers added to detail map
var irOpacity = 0.8;
var irOpacityLevels = [0.8, 0.6, 0.4, 1.0];
var irOpacityIdx = 0;
var irFailedFrames = {};     // Track frames that permanently failed
var irMetaPrefetchCache = {};  // Pre-fetched IR metadata keyed by SID
var irFirstFrameCache = {};    // Pre-fetched first frame keyed by SID
var irFollowStorm = true;    // Lock map view to follow storm center
var irFollowZoomSet = false; // True after first fitBounds sets the zoom level
var irCurrentTbData = null;  // Uint8Array of raw Tb for current frame (for hover + render)
var irCurrentTbRows = 0;
var irCurrentTbCols = 0;
var irCurrentTbVmin = 170.0;
var irCurrentTbVmax = 310.0;
var irCurrentBounds = null;  // L.latLngBounds for current IR overlay
var irTbTooltip = null;      // L.popup for Tb hover display
var irSelectedColormap = 'enhanced';  // Current colormap name

// ── Coastline overlay cache ────────────────────────────────────────────
// Natural Earth 110m coastlines as GeoJSON — loaded once, shared by all maps.
var _coastlineGeoJSON = null;
var _coastlineLoading = false;
var _coastlineQueue = []; // maps waiting for coastline data

/**
 * Load Natural Earth 110m coastlines and add as thin dark outlines to a map.
 * Uses the 'coastlines' pane (z=450) so lines render above IR but below markers.
 * Caches the GeoJSON so it's only fetched once across all maps.
 */
function _loadCoastlineOverlay(map) {
    function _addToMap(geojson, m) {
        L.geoJSON(geojson, {
            pane: 'coastlines',
            style: {
                color: '#000000',
                weight: 1.2,
                opacity: 0.7,
                fillColor: 'transparent',
                fillOpacity: 0,
                interactive: false
            }
        }).addTo(m);
    }

    if (_coastlineGeoJSON) {
        _addToMap(_coastlineGeoJSON, map);
        return;
    }

    _coastlineQueue.push(map);
    if (_coastlineLoading) return;
    _coastlineLoading = true;

    // Natural Earth 50m coastlines via GitHub CDN (~150KB gzipped)
    // 50m gives smooth coastlines at typical TC-scale zoom levels (z3-z8)
    fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_coastline.geojson')
        .then(function (r) { return r.json(); })
        .then(function (geojson) {
            _coastlineGeoJSON = geojson;
            _coastlineQueue.forEach(function (m) { _addToMap(geojson, m); });
            _coastlineQueue = [];
        })
        .catch(function (e) {
            console.warn('Coastline load failed:', e);
            _coastlineQueue = [];
        })
        .finally(function () { _coastlineLoading = false; });
}

// ── Colormap LUTs (256 entries: index 0 = transparent, 1-255 = Tb) ────
// Each LUT is a Uint8Array of length 256*4 (RGBA).
// Index 0 → [0,0,0,0] (transparent for invalid pixels)
// Indices 1-255 map linearly to Tb from TB_VMIN (170K) to TB_VMAX (310K)
var IR_COLORMAPS = {};

(function buildColormaps() {
    // Build a 256×4 RGBA LUT from fractional color stops.
    // Stops: [{f, r, g, b}] where f is 0.0 (warm/310K) to 1.0 (cold/170K).
    // This matches the server's original: frac = 1.0 - (Tb - vmin)/(vmax - vmin)
    // uint8 index 1 = 170K (cold, frac=1.0), index 255 = 310K (warm, frac=0.0)
    function buildLUT(stops) {
        var lut = new Uint8Array(256 * 4);
        // Index 0 = transparent (invalid pixel)
        lut[0] = 0; lut[1] = 0; lut[2] = 0; lut[3] = 0;
        for (var i = 1; i <= 255; i++) {
            var frac = 1.0 - (i - 1) / 254.0;  // i=1→frac=1.0 (cold), i=255→frac=0.0 (warm)
            var lo = stops[0], hi = stops[stops.length - 1];
            for (var s = 0; s < stops.length - 1; s++) {
                if (frac >= stops[s].f && frac <= stops[s + 1].f) {
                    lo = stops[s]; hi = stops[s + 1];
                    break;
                }
            }
            var t = (hi.f === lo.f) ? 0 : (frac - lo.f) / (hi.f - lo.f);
            t = Math.max(0, Math.min(1, t));
            var idx = i * 4;
            lut[idx]     = Math.round(lo.r + t * (hi.r - lo.r));
            lut[idx + 1] = Math.round(lo.g + t * (hi.g - lo.g));
            lut[idx + 2] = Math.round(lo.b + t * (hi.b - lo.b));
            lut[idx + 3] = 255;
        }
        return lut;
    }

    // Helper: convert Tb-based stops to frac-based stops
    function buildLUTfromTb(tbStops) {
        var vmin = 170.0, vmax = 310.0;
        var fracStops = tbStops.map(function(s) {
            return {f: 1.0 - (s.tb - vmin) / (vmax - vmin), r: s.r, g: s.g, b: s.b};
        });
        fracStops.sort(function(a, b) { return a.f - b.f; });
        return buildLUT(fracStops);
    }

    // Enhanced IR — exact match of server-side IR_COLORMAP_STOPS (NOAA-style)
    // Frac 0.00 (warm surface=black) → grays → colors → 1.00 (cold tops=white)
    IR_COLORMAPS['enhanced'] = buildLUT([
        {f: 0.00, r:   8, g:   8, b:   8},  // Warm surface → near-black
        {f: 0.15, r:  40, g:  40, b:  40},
        {f: 0.30, r:  90, g:  90, b:  90},
        {f: 0.40, r: 140, g: 140, b: 140},
        {f: 0.50, r: 200, g: 200, b: 200},  // Mid-level → light gray
        {f: 0.55, r:   0, g: 180, b: 255},  // Convective → cyan
        {f: 0.60, r:   0, g: 100, b: 255},  // → blue
        {f: 0.65, r:   0, g: 255, b:   0},  // → green
        {f: 0.70, r: 255, g: 255, b:   0},  // → yellow
        {f: 0.75, r: 255, g: 180, b:   0},  // → orange
        {f: 0.80, r: 255, g:  80, b:   0},  // → dark orange
        {f: 0.85, r: 255, g:   0, b:   0},  // → red
        {f: 0.90, r: 180, g:   0, b: 180},  // → magenta
        {f: 0.95, r: 255, g: 180, b: 255},  // → pink
        {f: 1.00, r: 255, g: 255, b: 255}   // Very cold tops → white
    ]);

    // Dvorak Enhanced (BD curve-inspired color scheme)
    IR_COLORMAPS['dvorak'] = buildLUTfromTb([
        {tb: 170, r: 255, g: 255, b: 255},  // < -100°C → white (overshooting)
        {tb: 183, r: 255, g:   0, b: 255},  // -90°C → magenta
        {tb: 193, r: 255, g:   0, b:   0},  // -80°C → red
        {tb: 203, r: 255, g: 128, b:   0},  // -70°C → orange
        {tb: 213, r: 255, g: 255, b:   0},  // -60°C → yellow
        {tb: 223, r:   0, g: 255, b:   0},  // -50°C → green
        {tb: 233, r:   0, g: 128, b: 255},  // -40°C → light blue
        {tb: 243, r:   0, g:   0, b: 255},  // -30°C → blue
        {tb: 253, r: 128, g: 128, b: 128},  // -20°C → gray
        {tb: 273, r: 180, g: 180, b: 180},  //   0°C → light gray
        {tb: 293, r:  60, g:  60, b:  60},  //  20°C → dark gray
        {tb: 310, r:  10, g:  10, b:  10}   //  37°C → near black
    ]);

    // Dvorak BD-curve grayscale (BW) — from satcmaps.bd05()
    // Exact operational BD enhancement with stepped cold bands:
    //   +30 to +9°C  (303–282K): black(0) → white(255) ramp
    //   +9  to -30°C (282–243K): gray 109 → 202 ramp
    //   -30 to -41°C (243–232K): flat gray 60
    //   -41 to -53°C (232–220K): flat gray 110
    //   -53 to -63°C (220–210K): flat gray 160
    //   -63 to -69°C (210–204K): flat BLACK (0)
    //   -69 to -75°C (204–198K): flat WHITE (255)
    //   -75 to -80°C (198–193K): flat gray 135
    //   below -80°C  (< 193K):   flat gray 85
    IR_COLORMAPS['grayscale'] = (function () {
        var vmin = 170.0, vmax = 310.0;
        var lut = new Uint8Array(256 * 4);
        lut[0] = 0; lut[1] = 0; lut[2] = 0; lut[3] = 0;  // index 0 = transparent

        for (var i = 1; i <= 255; i++) {
            var tb = vmin + (i - 1) * (vmax - vmin) / 254.0;
            var gray;

            if (tb < 193) {
                gray = 85;       // below -80°C
            } else if (tb < 198) {
                gray = 135;      // -80 to -75°C
            } else if (tb < 204) {
                gray = 255;      // -75 to -69°C (WHITE)
            } else if (tb < 210) {
                gray = 0;        // -69 to -63°C (BLACK)
            } else if (tb < 220) {
                gray = 160;      // -63 to -53°C
            } else if (tb < 232) {
                gray = 110;      // -53 to -41°C
            } else if (tb < 243) {
                gray = 60;       // -41 to -30°C
            } else if (tb < 282) {
                // -30 to +9°C: gray ramp 202 → 109
                gray = Math.round(202 + (tb - 243) * (109 - 202) / (282 - 243));
            } else if (tb <= 303) {
                // +9 to +30°C: white(255) → black(0)
                gray = Math.round(255 + (tb - 282) * (0 - 255) / (303 - 282));
            } else {
                gray = 0;        // above +30°C (black)
            }
            gray = Math.max(0, Math.min(255, gray));

            var idx = i * 4;
            lut[idx] = gray; lut[idx + 1] = gray; lut[idx + 2] = gray; lut[idx + 3] = 255;
        }
        return lut;
    })();

    // NOAA Funktop enhancement — stepped color bands (vmax=36°C, vmin=-92°C)
    IR_COLORMAPS['funktop'] = buildLUTfromTb([
        {tb: 309, r:   0, g:   0, b:   0},  // +36°C black
        {tb: 308, r:  20, g:  20, b:  20},  // +35°C
        {tb: 255, r: 216, g: 216, b: 216},  // -18°C light gray
        {tb: 254.9, r: 100, g: 100, b:   0},  // → olive
        {tb: 235, r: 248, g: 248, b:   0},  // -38°C yellow
        {tb: 234.9, r:   0, g:   0, b: 120},  // → navy
        {tb: 215, r:   0, g: 252, b: 252},  // -58°C cyan
        {tb: 214.9, r:  84, g:   0, b:   0},  // → dark red
        {tb: 203, r: 252, g:   0, b:   0},  // -70°C red
        {tb: 202.9, r: 252, g:  80, b:  80},  // → salmon
        {tb: 195, r: 252, g: 140, b: 140},  // -78°C pink
        {tb: 194.9, r:   0, g: 252, b:   0},  // → green
        {tb: 182, r: 252, g: 252, b: 252},  // -91°C white
        {tb: 181, r: 252, g: 252, b: 252}   // -92°C white
    ]);

    // AVN enhancement — aviation weather style (vmax=50°C, vmin=-81°C)
    IR_COLORMAPS['avn'] = buildLUTfromTb([
        {tb: 310, r:   0, g:   0, b:   0},  // warm edge black
        {tb: 243, r: 255, g: 255, b: 255},  // -30°C white
        {tb: 242.9, r:   0, g: 150, b: 255},  // → blue
        {tb: 223, r:   0, g: 110, b: 150},  // -50°C teal
        {tb: 222.9, r: 160, g: 160, b:   0},  // → olive-yellow
        {tb: 213, r: 250, g: 250, b:   0},  // -60°C yellow
        {tb: 212.9, r: 250, g: 250, b:   0},
        {tb: 203, r: 200, g: 120, b:   0},  // -70°C orange
        {tb: 202.9, r: 250, g:   0, b:   0},  // → red
        {tb: 193, r: 200, g:   0, b:   0},  // -80°C dark red
        {tb: 192, r:  88, g:  88, b:  88}   // -81°C gray
    ]);

    // NHC enhancement — blue/green/red (vmax=25°C, vmin=-110°C)
    IR_COLORMAPS['nhc'] = buildLUTfromTb([
        {tb: 298, r:   0, g:   0, b:   0},  // +25°C black
        {tb: 297, r:   0, g:   0, b:  24},  // +24°C
        {tb: 282, r:   0, g:   0, b: 252},  // +9°C blue
        {tb: 262, r:   0, g: 252, b:   0},  // -11°C green
        {tb: 242, r: 252, g:   0, b:   0},  // -31°C red
        {tb: 203, r: 252, g: 248, b: 248},  // -70°C near-white
        {tb: 202.9, r: 216, g: 216, b: 216},  // → light gray
        {tb: 170, r: 252, g: 252, b: 252}   // cold edge white
    ]);

    // RAMMB enhancement — multi-band (vmax=50°C, vmin=-100°C)
    IR_COLORMAPS['rammb'] = buildLUTfromTb([
        {tb: 310, r: 181, g:  85, b:  85},  // warm edge
        {tb: 298, r:   0, g:   0, b:   0},  // +25°C black
        {tb: 243, r: 254, g: 254, b: 254},  // -30°C white
        {tb: 242.9, r: 168, g: 253, b: 253},  // → cyan
        {tb: 223, r:  84, g:  84, b:  84},  // -50°C dark gray
        {tb: 222.9, r:   0, g:   0, b: 103},  // → dark blue
        {tb: 213, r:   0, g:   0, b: 254},  // -60°C blue
        {tb: 212.9, r:   0, g:  96, b:  13},  // → dark green
        {tb: 203, r:   0, g: 252, b:   0},  // -70°C green
        {tb: 202.9, r:  77, g:  13, b:   0},  // → dark red
        {tb: 193, r: 251, g:   0, b:   0},  // -80°C red
        {tb: 192.9, r: 252, g: 252, b:   0},  // → yellow
        {tb: 183, r:   0, g:   0, b:   0},  // -90°C black
        {tb: 182.9, r: 255, g: 255, b: 255},  // → white
        {tb: 173, r:   4, g:   4, b:   4}   // -100°C near-black
    ]);

    // IRB enhancement — vibrant multi-color (vmax=30°C, vmin=-100°C)
    IR_COLORMAPS['irb'] = buildLUTfromTb([
        {tb: 303, r:  18, g:  18, b:  18},  // +30°C dark gray
        {tb: 283, r: 120, g: 120, b: 120},  // +10°C gray
        {tb: 278, r: 215, g: 217, b: 219},  //  +5°C silver
        {tb: 273, r: 252, g: 252, b: 252},  //   0°C white
        {tb: 263, r:  43, g:  57, b: 161},  // -10°C blue
        {tb: 253, r:  61, g: 173, b: 143},  // -20°C teal
        {tb: 238, r: 255, g: 249, b:  87},  // -35°C yellow
        {tb: 233, r: 227, g: 192, b:  36},  // -40°C gold
        {tb: 218, r: 166, g:  35, b:  63},  // -55°C crimson
        {tb: 213, r:  77, g:  13, b:   7},  // -60°C dark red
        {tb: 203, r: 150, g:  73, b: 201},  // -70°C purple
        {tb: 193, r: 224, g: 224, b: 255},  // -80°C lavender
        {tb: 173, r:   0, g:   0, b:   0}   // -100°C black
    ]);

    // Claude — custom enhancement optimized for TC analysis
    // Design: cool-toned grayscale warm side preserves cloud texture;
    // color begins at convective onset (-20°C); teal→green→amber→terracotta
    // progression maps perceptually to intensifying convection; magenta/pink
    // for extreme cold tops; white overshooting stands out against any band.
    IR_COLORMAPS['claude'] = buildLUTfromTb([
        {tb: 310, r:  12, g:  12, b:  22},  // +37°C near-black (cool undertone)
        {tb: 293, r:  70, g:  70, b:  82},  // +20°C dark cool gray
        {tb: 283, r: 120, g: 120, b: 132},  // +10°C medium cool gray
        {tb: 273, r: 180, g: 180, b: 192},  //   0°C light cool gray
        {tb: 263, r: 216, g: 218, b: 228},  // -10°C pale silver-blue
        {tb: 253, r: 140, g: 210, b: 220},  // -20°C light teal (convective onset)
        {tb: 248, r:  68, g: 180, b: 196},  // -25°C medium teal
        {tb: 243, r:  32, g: 148, b: 166},  // -30°C deep teal
        {tb: 238, r:  40, g: 178, b: 116},  // -35°C emerald
        {tb: 233, r:  96, g: 208, b:  68},  // -40°C bright green
        {tb: 228, r: 192, g: 220, b:  40},  // -45°C chartreuse
        {tb: 223, r: 238, g: 196, b:  48},  // -50°C golden amber
        {tb: 218, r: 228, g: 132, b:  48},  // -55°C deep amber
        {tb: 213, r: 214, g:  78, b:  56},  // -60°C terracotta
        {tb: 208, r: 180, g:  36, b:  68},  // -65°C crimson
        {tb: 203, r: 196, g:  48, b: 156},  // -70°C magenta
        {tb: 198, r: 228, g: 112, b: 204},  // -75°C pink
        {tb: 193, r: 248, g: 196, b: 240},  // -80°C light pink
        {tb: 183, r: 255, g: 255, b: 255},  // -90°C white (overshooting)
        {tb: 173, r: 240, g: 240, b: 255}   // -100°C ice white
    ]);
})();

// Render Tb uint8 data to a data URI PNG using canvas + selected colormap
var _irRenderCanvas = null;
function renderTbToDataURI(tbData, rows, cols, colormap, southLat, northLat) {
    if (!_irRenderCanvas) {
        _irRenderCanvas = document.createElement('canvas');
    }

    var lut = IR_COLORMAPS[colormap] || IR_COLORMAPS['enhanced'];

    // If lat bounds provided, apply Mercator warping so the image aligns
    // correctly when Leaflet stretches it in Web Mercator screen space.
    // Without this, equirectangular data appears shifted (eye north of track).
    var warp = (southLat != null && northLat != null);
    var outRows = rows;
    var outCols = cols;

    _irRenderCanvas.width = outCols;
    _irRenderCanvas.height = outRows;
    var ctx = _irRenderCanvas.getContext('2d');
    var imgData = ctx.createImageData(outCols, outRows);
    var pixels = imgData.data;

    if (warp) {
        // Mercator projection: y = ln(tan(π/4 + lat/2))
        function _latToMercY(d) {
            var r = d * Math.PI / 180;
            return Math.log(Math.tan(Math.PI / 4 + r / 2));
        }
        var mercNorth = _latToMercY(northLat);
        var mercSouth = _latToMercY(southLat);
        var mercRange = mercNorth - mercSouth;

        for (var outRow = 0; outRow < outRows; outRow++) {
            // Output row maps to uniform Mercator Y spacing (row 0 = north)
            var mercY = mercNorth - (outRow / (outRows - 1)) * mercRange;
            // Convert Mercator Y back to geographic latitude
            var lat = (2 * Math.atan(Math.exp(mercY)) - Math.PI / 2) * 180 / Math.PI;
            // Map lat to source row in equirectangular grid (row 0 = north)
            var srcRowF = (northLat - lat) / (northLat - southLat) * (rows - 1);
            var srcRow = Math.round(srcRowF);
            if (srcRow < 0) srcRow = 0;
            if (srcRow >= rows) srcRow = rows - 1;

            for (var c = 0; c < outCols; c++) {
                var srcIdx = srcRow * cols + c;
                var val = tbData[srcIdx];
                var pi = (outRow * outCols + c) * 4;
                if (val === 0) {
                    pixels[pi] = 0; pixels[pi+1] = 0; pixels[pi+2] = 0; pixels[pi+3] = 0;
                } else {
                    var li = val * 4;
                    pixels[pi]     = lut[li];
                    pixels[pi + 1] = lut[li + 1];
                    pixels[pi + 2] = lut[li + 2];
                    pixels[pi + 3] = lut[li + 3];
                }
            }
        }
    } else {
        // No warping — direct pixel mapping (original behavior)
        for (var i = 0; i < tbData.length; i++) {
            var val = tbData[i];
            var pi = i * 4;
            if (val === 0) {
                pixels[pi] = 0; pixels[pi+1] = 0; pixels[pi+2] = 0; pixels[pi+3] = 0;
            } else {
                var li = val * 4;
                pixels[pi]     = lut[li];
                pixels[pi + 1] = lut[li + 1];
                pixels[pi + 2] = lut[li + 2];
                pixels[pi + 3] = lut[li + 3];
            }
        }
    }
    ctx.putImageData(imgData, 0, 0);
    return _irRenderCanvas.toDataURL('image/png');
}

// Decode base64 tb_data from server into Uint8Array
function decodeTbData(base64str) {
    var binary = atob(base64str);
    var arr = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
        arr[i] = binary.charCodeAt(i);
    }
    return arr;
}

// Render the colorbar canvas from the active colormap LUT
// This guarantees the colorbar exactly matches the map rendering.
// Warm (310K) on left → cold (170K) on right.
function renderColorbarCanvas(colormapName) {
    var canvas = document.getElementById('ir-colorbar-canvas');
    if (!canvas) return;
    var lut = IR_COLORMAPS[colormapName] || IR_COLORMAPS['enhanced'];
    // Draw 255 pixels wide (one per uint8 value 1-255), warm→cold = left→right
    canvas.width = 255;
    canvas.height = 1;
    var ctx = canvas.getContext('2d');
    var imgData = ctx.createImageData(255, 1);
    var px = imgData.data;
    for (var x = 0; x < 255; x++) {
        // x=0 → warmest (uint8=255=310K), x=254 → coldest (uint8=1=170K)
        var val = 255 - x;
        var li = val * 4;
        var pi = x * 4;
        px[pi]     = lut[li];
        px[pi + 1] = lut[li + 1];
        px[pi + 2] = lut[li + 2];
        px[pi + 3] = 255;  // Colorbar always fully opaque
    }
    ctx.putImageData(imgData, 0, 0);
}

// Switch colormap and re-render current frame (no server round-trip)
function switchColormap(name) {
    if (!IR_COLORMAPS[name]) return;
    irSelectedColormap = name;
    // Update colorbar to match
    renderColorbarCanvas(name);
    // Re-render current frame if we have data
    if (irCurrentTbData && irCurrentBounds && detailMap) {
        var sLat = irCurrentBounds ? irCurrentBounds.getSouth() : null;
        var nLat = irCurrentBounds ? irCurrentBounds.getNorth() : null;
        var dataURI = renderTbToDataURI(irCurrentTbData, irCurrentTbRows, irCurrentTbCols, name, sLat, nLat);
        if (irOverlayLayer) {
            try { detailMap.removeLayer(irOverlayLayer); } catch (e) {}
        }
        irOverlayLayer = L.imageOverlay(dataURI, irCurrentBounds, {
            opacity: irOpacity,
            interactive: false,
            className: 'ir-overlay-image'
        }).addTo(detailMap);
    }
    // Update button states
    var btns = document.querySelectorAll('.ir-cmap-btn');
    for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].getAttribute('data-cmap') === name);
    }
}
window.switchColormap = switchColormap;

// Climatology state
var climRendered = false;

// ── Basin metadata ───────────────────────────────────────────
var BASIN_NAMES = {
    NA: 'North Atlantic',
    EP: 'East Pacific',
    WP: 'West Pacific',
    NI: 'North Indian',
    SI: 'South Indian',
    SP: 'South Pacific',
    SA: 'South Atlantic'
};

var BASIN_COLORS = {
    NA: '#2e7dff',
    EP: '#00d4ff',
    WP: '#f87171',
    NI: '#fbbf24',
    SI: '#34d399',
    SP: '#a78bfa',
    SA: '#fb923c'
};

// ── Saffir-Simpson helpers ───────────────────────────────────
var SS_COLORS = {
    TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
    C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626',
    UN: '#6b7280'
};

function getIntensityColor(vmax) {
    if (!vmax) return '#6b7280';
    if (vmax < 34) return '#60a5fa';
    if (vmax < 64) return '#34d399';
    if (vmax < 83) return '#fbbf24';
    if (vmax < 96) return '#fb923c';
    if (vmax < 113) return '#f87171';
    if (vmax < 137) return '#ef4444';
    return '#dc2626';
}

function getIntensityCategory(vmax) {
    if (!vmax) return 'Unknown';
    if (vmax < 34) return 'TD';
    if (vmax < 64) return 'TS';
    if (vmax < 83) return 'Cat 1';
    if (vmax < 96) return 'Cat 2';
    if (vmax < 113) return 'Cat 3';
    if (vmax < 137) return 'Cat 4';
    return 'Cat 5';
}

function getCatKey(vmax) {
    if (!vmax) return 'UN';
    if (vmax < 34) return 'TD';
    if (vmax < 64) return 'TS';
    if (vmax < 83) return 'C1';
    if (vmax < 96) return 'C2';
    if (vmax < 113) return 'C3';
    if (vmax < 137) return 'C4';
    return 'C5';
}

// ── Plotly defaults ──────────────────────────────────────────
var PLOTLY_LAYOUT_BASE = {
    paper_bgcolor: '#0a1628',
    plot_bgcolor: '#0a1628',
    font: { family: 'DM Sans, sans-serif', color: '#e2e8f0' },
    margin: { l: 50, r: 20, t: 10, b: 40 },
    hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12, family: 'DM Sans' } }
};

var PLOTLY_CONFIG = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'],
    toImageButtonOptions: {
        format: 'png',
        filename: 'tc-radar-chart',
        height: 900,
        width: 1600,
        scale: 2
    }
};

// ══════════════════════════════════════════════════════════════
//  TAB SWITCHING
// ══════════════════════════════════════════════════════════════

window.switchTab = function (tabName) {
    _ga('ga_switch_tab', { tab_name: tabName });
    // If switching to detail without a selected storm, redirect through viewStormDetail
    if (tabName === 'detail' && !selectedStorm) {
        showToast('Select a storm first, then click "View Detail"');
        return;
    }

    // Update buttons
    document.querySelectorAll('.ga-tab').forEach(function (btn) {
        var isTarget = btn.getAttribute('data-tab') === tabName;
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });
    // Update panels
    document.querySelectorAll('.ga-tab-content').forEach(function (panel) {
        panel.classList.toggle('active', panel.id === 'tab-' + tabName);
    });
    // Lazy-init
    if (tabName === 'browser' && stormMap) {
        setTimeout(function () { stormMap.invalidateSize(); }, 100);
    }
    if (tabName === 'detail') {
        // If we already have a storm loaded but just switched tabs, re-render
        if (detailMap) {
            setTimeout(function () { detailMap.invalidateSize(); }, 100);
        } else if (selectedStorm) {
            renderStormDetail(selectedStorm);
        }
    }
    if (tabName === 'climatology' && !climRendered && allStorms.length > 0) {
        renderClimatology();
    }
    if (tabName === 'compare') {
        renderCompareView();
        if (compareMap) {
            setTimeout(function () { compareMap.invalidateSize(); }, 100);
        }
    }
    updateHashSilently();
};

// ══════════════════════════════════════════════════════════════
//  DATA LOADING
// ══════════════════════════════════════════════════════════════

function loadData() {
    var loadingEl = document.getElementById('map-loading');

    // Show loading indicator on map
    var mapEl = document.getElementById('browser-map');
    if (mapEl) {
        var loader = document.createElement('div');
        loader.id = 'ga-map-loader';
        loader.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1000;text-align:center;color:#8b9ec2;font-size:14px;font-family:DM Sans,sans-serif;';
        loader.innerHTML = '<div style="width:40px;height:40px;border:3px solid rgba(46,125,255,0.2);border-top-color:#2e7dff;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 12px;"></div>Loading storm database\u2026';
        mapEl.style.position = 'relative';
        mapEl.appendChild(loader);
    }

    // Load storms metadata
    fetch(STORMS_JSON)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            allStorms = data.storms || [];
            filteredStorms = allStorms.slice();

            // Update header stats
            var meta = data.metadata || {};
            document.getElementById('stat-storms').textContent = (meta.total_storms || allStorms.length).toLocaleString();
            document.getElementById('stat-years').textContent = meta.year_range ? meta.year_range[0] + '–' + meta.year_range[1] : '';
            document.getElementById('stat-basins').textContent = Object.keys(meta.basin_counts || BASIN_NAMES).length;
            document.getElementById('total-count').textContent = allStorms.length.toLocaleString();
            document.getElementById('filtered-count').textContent = allStorms.length.toLocaleString();

            initBrowserMap();
            if (mapViewMode === 'tracks') {
                renderTracks(filteredStorms);
            } else {
                renderMarkers(filteredStorms);
            }
            if (loadingEl) loadingEl.style.display = 'none';

            var _loader = document.getElementById('ga-map-loader');
            if (_loader) _loader.remove();

            showToast('Loaded ' + allStorms.length.toLocaleString() + ' storms');
        })
        .catch(function (err) {
            console.error('Failed to load storms:', err);
            if (loadingEl) loadingEl.innerHTML = '<span style="color:#f87171;">Failed to load storm data. Check console.</span>';
            var _loader = document.getElementById('ga-map-loader');
            if (_loader) _loader.innerHTML = '<div style="color:#ef4444;font-size:14px;">\u26A0 Could not load storm data. Try refreshing.</div>';
        });

    // Load track data — try chunked manifest first, fall back to single file
    showToast('Loading track data...');
    fetch(TRACKS_MANIFEST)
        .then(function (r) {
            if (!r.ok) throw new Error('No manifest');
            return r.json();
        })
        .then(function (manifest) {
            // Load chunks in parallel
            var chunks = manifest.chunks || [];
            console.log('Loading ' + chunks.length + ' track chunks...');
            return Promise.all(chunks.map(function (chunkFile) {
                return fetch(chunkFile).then(function (r) { return r.json(); });
            }));
        })
        .then(function (chunkDataArray) {
            // Merge all chunks into allTracks
            chunkDataArray.forEach(function (chunk) {
                Object.keys(chunk).forEach(function (sid) {
                    allTracks[sid] = chunk[sid];
                });
            });
            var n = Object.keys(allTracks).length;
            console.log('Loaded tracks for ' + n + ' storms from chunks');
            showToast('Track data ready — ' + n.toLocaleString() + ' storm tracks');
            // Re-render tracks now that data is available (initial render may
            // have fired before chunks finished loading)
            if (mapViewMode === 'tracks' && filteredStorms.length) {
                renderTracks(filteredStorms);
            }
        })
        .catch(function (manifestErr) {
            // Fallback: try loading single combined file
            console.log('Manifest not found, trying single file...');
            fetch(TRACKS_JSON_FALLBACK)
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    allTracks = data;
                    var n = Object.keys(data).length;
                    console.log('Loaded tracks for ' + n + ' storms (single file)');
                    showToast('Track data ready — ' + n.toLocaleString() + ' storm tracks');
                    if (mapViewMode === 'tracks' && filteredStorms.length) {
                        renderTracks(filteredStorms);
                    }
                })
                .catch(function (err) {
                    console.warn('Track data not loaded:', err);
                    showToast('Track data failed to load — storm details unavailable');
                });
        });

    // Load precomputed overwater 24-h intensity change episodes
    fetch('intensity_changes.json')
        .then(function (r) { if (!r.ok) throw new Error('Not found'); return r.json(); })
        .then(function (data) {
            intensityChangeData = data;
            console.log('Loaded intensity change data: ' + (data.total_episodes || 0) + ' episodes');
        })
        .catch(function (err) {
            console.warn('Intensity change data not loaded:', err);
        });
}

// ══════════════════════════════════════════════════════════════
//  STORM BROWSER TAB
// ══════════════════════════════════════════════════════════════

function initBrowserMap() {
    if (stormMap) return;

    stormMap = L.map('storm-map', {
        center: [20, -20],
        zoom: 2,
        zoomControl: true,
        worldCopyJump: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 12
    }).addTo(stormMap);

    markerCluster = L.markerClusterGroup({
        maxClusterRadius: 40,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        disableClusteringAtZoom: 8
    });
    trackLayer = L.layerGroup().addTo(stormMap);

    // Canvas renderer + layer for track view
    trackCanvasRenderer = L.canvas({ padding: 0.5 });
    trackViewLayer = L.layerGroup();

    // Default view: tracks (clusters ready but not added to map)
    if (mapViewMode === 'tracks') {
        stormMap.addLayer(trackViewLayer);
    } else {
        stormMap.addLayer(markerCluster);
    }

    // Add legend
    var legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
        var div = L.DomUtil.create('div', 'ga-legend');
        div.innerHTML = '<h4>Intensity (Saffir-Simpson)</h4>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#60a5fa;"></span> TD (&lt;34 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#34d399;"></span> TS (34–63 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#fbbf24;"></span> Cat 1 (64–82 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#fb923c;"></span> Cat 2 (83–95 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#f87171;"></span> Cat 3 (96–112 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#ef4444;"></span> Cat 4 (113–136 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#dc2626;"></span> Cat 5 (137+ kt)</div>';
        return div;
    };
    legend.addTo(stormMap);
}

function renderMarkers(storms) {
    if (!markerCluster) return;
    markerCluster.clearLayers();
    allMarkerMap = {};
    trackLayer.clearLayers();

    storms.forEach(function (s) {
        if (!s.genesis_lat || !s.genesis_lon) return;

        var color = getIntensityColor(s.peak_wind_kt);
        var icon = L.divIcon({
            className: 'custom-div-icon',
            html: '<div class="custom-marker" style="background-color:' + color + ';width:14px;height:14px;box-shadow:0 0 6px ' + color + '40;"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        });

        var marker = L.marker([s.genesis_lat, s.genesis_lon], { icon: icon });
        marker.stormData = s;

        var cat = getIntensityCategory(s.peak_wind_kt);
        var popupHtml =
            '<div style="min-width:180px;">' +
            '<div style="font-weight:700;font-size:14px;margin-bottom:4px;">' + (s.name || 'UNNAMED') +
            ' <span class="intensity-badge" style="background:' + color + ';font-size:10px;padding:1px 6px;">' + cat + '</span></div>' +
            '<div style="font-size:12px;color:#94a3b8;margin-bottom:6px;">' + s.year + ' &middot; ' + (BASIN_NAMES[s.basin] || s.basin) + '</div>' +
            '<div style="font-size:12px;"><b>Peak:</b> ' + (s.peak_wind_kt || '?') + ' kt &middot; ' + (s.min_pres_hpa || '?') + ' hPa</div>' +
            '<div style="font-size:12px;"><b>ACE:</b> ' + (s.ace || 0).toFixed(1) + '</div>' +
            '<div style="margin-top:8px;text-align:center;">' +
            '<button onclick="selectStormFromPopup(\'' + s.sid + '\')" style="background:linear-gradient(135deg,#2e7dff,#00d4ff);color:#fff;border:none;border-radius:4px;padding:4px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:DM Sans,sans-serif;">View Detail</button>' +
            '</div></div>';

        marker.bindPopup(popupHtml, {
            maxWidth: 280,
            minWidth: 200,
            autoPan: true,
            closeButton: true
        });

        marker.on('click', function () {
            selectStorm(s);
        });

        allMarkerMap[s.sid] = marker;
        markerCluster.addLayer(marker);
    });

    document.getElementById('filtered-count').textContent = storms.length.toLocaleString();
}

// ── Track view rendering ─────────────────────────────────────

function renderTracks(storms) {
    if (!trackViewLayer) return;
    trackViewLayer.clearLayers();

    var showMarkers = storms.length <= 3000;

    storms.forEach(function (s) {
        var track = allTracks[s.sid];
        if (!track || track.length < 2) return;

        // Collect valid points
        var pts = [];
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null) pts.push(p);
        }
        if (pts.length < 2) return;

        // Walk points and batch consecutive same-color segments into polylines
        // Each segment is colored by the LOCAL intensity at that point
        var segColor = _isTCNature(pts[0].n) ? getIntensityColor(pts[0].w) : '#6b7280';
        var segIsTC = _isTCNature(pts[0].n);
        var runCoords = [[pts[0].la, pts[0].lo]];

        for (var j = 1; j < pts.length; j++) {
            var p = pts[j];
            var isTC = _isTCNature(p.n);
            var ptColor = isTC ? getIntensityColor(p.w) : '#6b7280';

            if (ptColor !== segColor || isTC !== segIsTC) {
                // Color or phase changed — flush current run
                if (runCoords.length >= 2) {
                    _addTrackPolyline(runCoords, segIsTC, segColor, s);
                }
                // Start new run (include overlap point for continuity)
                runCoords = [[pts[j - 1].la, pts[j - 1].lo]];
                segColor = ptColor;
                segIsTC = isTC;
            }
            runCoords.push([p.la, p.lo]);
        }
        // Flush final run
        if (runCoords.length >= 2) {
            _addTrackPolyline(runCoords, segIsTC, segColor, s);
        }

        // Genesis marker
        if (showMarkers) {
            var gen = _trackGenesisPoint(track);
            if (gen) {
                L.circleMarker([gen.la, gen.lo], {
                    renderer: trackCanvasRenderer,
                    radius: 3, color: '#fff', weight: 1,
                    fillColor: '#60a5fa', fillOpacity: 0.9, opacity: 0.8
                }).bindTooltip((s.name || 'UNNAMED') + ' ' + s.year + ' genesis', { className: 'ga-tooltip' })
                 .on('click', function () { selectStorm(s); })
                 .addTo(trackViewLayer);
            }

            // LMI marker
            var lmiPt = null, lmiW = -1;
            for (var k = 0; k < pts.length; k++) {
                if (pts[k].w != null && pts[k].w > lmiW) { lmiW = pts[k].w; lmiPt = pts[k]; }
            }
            if (lmiPt && lmiW > 0) {
                L.circleMarker([lmiPt.la, lmiPt.lo], {
                    renderer: trackCanvasRenderer,
                    radius: 4, color: '#fff', weight: 1.5,
                    fillColor: getIntensityColor(lmiW), fillOpacity: 0.9, opacity: 0.9
                }).bindTooltip((s.name || 'UNNAMED') + ' ' + s.year + ' LMI: ' + lmiW + ' kt', { className: 'ga-tooltip' })
                 .on('click', function () { selectStorm(s); })
                 .addTo(trackViewLayer);
            }
        }
    });

    document.getElementById('filtered-count').textContent = storms.length.toLocaleString();
}

function _addTrackPolyline(coords, isTC, segColor, storm) {
    var opts = {
        renderer: trackCanvasRenderer,
        interactive: true
    };
    if (isTC) {
        opts.color = segColor;
        opts.weight = 1.8;
        opts.opacity = 0.6;
    } else {
        opts.color = '#6b7280';
        opts.weight = 0.8;
        opts.opacity = 0.25;
        opts.dashArray = '4,3';
    }
    var line = L.polyline(coords, opts);
    var cat = getIntensityCategory(storm.peak_wind_kt);
    line.bindTooltip(
        (storm.name || 'UNNAMED') + ' (' + storm.year + ') ' + cat + ' · ' +
        (storm.peak_wind_kt || '?') + ' kt · ACE ' + (storm.ace || 0).toFixed(1),
        { sticky: true, className: 'ga-tooltip' }
    );
    line.on('click', function () { selectStorm(storm); });
    line.on('mouseover', function () {
        if (isTC) this.setStyle({ weight: 3.5, opacity: 1 });
    });
    line.on('mouseout', function () {
        if (isTC) this.setStyle({ weight: 1.8, opacity: 0.6 });
    });
    line.addTo(trackViewLayer);
}

window.setMapView = function (mode) {
    mapViewMode = mode;
    // Update toggle buttons
    document.querySelectorAll('.view-toggle-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-view') === mode);
    });
    if (mode === 'cluster') {
        if (trackViewLayer) stormMap.removeLayer(trackViewLayer);
        stormMap.addLayer(markerCluster);
        renderMarkers(filteredStorms);
    } else {
        stormMap.removeLayer(markerCluster);
        stormMap.addLayer(trackViewLayer);
        renderTracks(filteredStorms);
    }
};

// ── Storm selection ──────────────────────────────────────────

function selectStorm(storm) {
    _ga('ga_select_storm', { sid: storm.sid, storm_name: storm.name, year: storm.year, basin: storm.basin, peak_wind_kt: storm.peak_wind_kt });
    selectedStorm = storm;
    var card = document.getElementById('storm-card');
    card.style.display = '';

    var color = getIntensityColor(storm.peak_wind_kt);
    var cat = getIntensityCategory(storm.peak_wind_kt);

    document.getElementById('card-name').textContent = storm.name || 'UNNAMED';
    document.getElementById('card-cat-badge').textContent = cat;
    document.getElementById('card-cat-badge').style.background = color;
    document.getElementById('card-year').textContent = storm.year;
    document.getElementById('card-basin').textContent = BASIN_NAMES[storm.basin] || storm.basin;
    document.getElementById('card-wind').textContent = storm.peak_wind_kt ? storm.peak_wind_kt + ' kt' : 'N/A';
    document.getElementById('card-pres').textContent = storm.min_pres_hpa ? storm.min_pres_hpa + ' hPa' : 'N/A';
    var dateStr = (storm.start_date || '?') + ' → ' + (storm.end_date || '?');
    var tcDur = _tcDuration(allTracks[storm.sid] || []);
    if (tcDur) dateStr += ' (' + tcDur + ' as TC)';
    document.getElementById('card-dates').textContent = dateStr;
    document.getElementById('card-ace').textContent = (storm.ace || 0).toFixed(1);

    var hursatEl = document.getElementById('card-hursat');
    if (storm.hursat) {
        hursatEl.innerHTML = '<span style="color:#34d399;">Available (1978–2015)</span>';
    } else {
        hursatEl.innerHTML = '<span style="color:#6b7280;">Not available</span>';
    }

    // TC-RADAR badge in sidebar card
    var radarRowEl = document.getElementById('card-tc-radar');
    var radarValEl = document.getElementById('card-tc-radar-value');
    if (radarRowEl && radarValEl) {
        var rk = (storm.name || '').toUpperCase() + '_' + storm.year;
        var re = tcRadarLookup && tcRadarLookup[rk];
        if (re) {
            radarValEl.innerHTML = '<span style="color:#ffad00;">🛩️ ' + re.n + ' ' + (re.n === 1 ? 'analysis' : 'analyses') + '</span>';
            radarRowEl.style.display = '';
        } else {
            radarRowEl.style.display = 'none';
        }
    }

    // Update the floating map card
    _showMapStormCard(storm, color, cat);

    // Scroll sidebar to show the storm card
    setTimeout(function () {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);

    // Show track on map if available
    showTrackOnBrowserMap(storm.sid);

    // Early IR metadata prefetch — kick off the metadata request now
    // so it's already cached when the user opens the detail panel.
    // IMPORTANT: For MergIR/GridSat-eligible storms (year >= 2000), we MUST
    // have track data to send with the request.  Without it, the server falls
    // back to HURSAT and caches that result, poisoning all subsequent requests
    // for this SID (including frame requests).  Skip prefetch if tracks aren't
    // loaded yet — the detail view will fetch properly when opened.
    var hasIR = storm.hursat || storm.year >= 1998;
    var needsTrack = storm.year >= 2000;  // MergIR/GridSat need track positions
    var track = allTracks[storm.sid] || [];
    if (hasIR && !irMetaPrefetchCache[storm.sid] && (!needsTrack || track.length > 0)) {
        var trackP = track.length > 0 ? '&track=' + encodeURIComponent(JSON.stringify(track)) : '';
        var lonP = storm.lmi_lon != null ? '&storm_lon=' + storm.lmi_lon : '';
        var prefetchUrl = API_BASE + '/global/ir/meta?sid=' + encodeURIComponent(storm.sid) + trackP + lonP;
        fetch(prefetchUrl)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (meta) {
                if (meta && meta.available && meta.n_frames > 0) {
                    irMetaPrefetchCache[storm.sid] = meta;
                    // Also prefetch the first frame so display is near-instant
                    var source = meta.source || 'hursat';
                    var frameUrl;
                    var irCacheVer = 'v5';  // bumped: raw Tb uint8 for client-side colormap rendering
                    if ((source === 'mergir' || source === 'gridsat') && meta.frames && meta.frames[0]) {
                        var fi = meta.frames[0];
                        frameUrl = API_BASE + '/global/ir/frame?sid=' + encodeURIComponent(storm.sid) +
                            '&frame_idx=0&lat=' + fi.lat + '&lon=' + fi.lon + '&_v=' + irCacheVer;
                    } else {
                        frameUrl = API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(storm.sid) + '&frame_idx=0&_v=' + irCacheVer;
                    }
                    fetch(frameUrl)
                        .then(function (r) { return r.ok ? r.json() : null; })
                        .then(function (data) {
                            if (data) irFirstFrameCache[storm.sid] = data;
                        })
                        .catch(function () {});
                }
            })
            .catch(function () {});
    }
}

function _showMapStormCard(storm, color, cat) {
    var mc = document.getElementById('map-storm-card');
    if (!mc) return;
    document.getElementById('map-card-name').textContent = storm.name || 'UNNAMED';
    var badge = document.getElementById('map-card-badge');
    badge.textContent = cat;
    badge.style.background = color;
    document.getElementById('map-card-wind').textContent = storm.peak_wind_kt ? storm.peak_wind_kt + ' kt' : 'N/A';
    document.getElementById('map-card-pres').textContent = storm.min_pres_hpa ? storm.min_pres_hpa + ' hPa' : 'N/A';
    document.getElementById('map-card-year').textContent = storm.year;
    document.getElementById('map-card-basin').textContent = BASIN_NAMES[storm.basin] || storm.basin;
    mc.style.display = '';
}

window.dismissMapStormCard = function () {
    var mc = document.getElementById('map-storm-card');
    if (mc) mc.style.display = 'none';
};

window.selectStormFromPopup = function (sid) {
    var storm = allStorms.find(function (s) { return s.sid === sid; });
    if (storm) {
        selectStorm(storm);
        viewStormDetail();
    }
};

function showTrackOnBrowserMap(sid) {
    if (!trackLayer) return;
    trackLayer.clearLayers();

    var track = allTracks[sid];
    if (!track || track.length < 2) return;

    // Draw track as colored segments
    for (var i = 1; i < track.length; i++) {
        var p0 = track[i - 1];
        var p1 = track[i];
        if (!p0.la || !p0.lo || !p1.la || !p1.lo) continue;

        var color = getIntensityColor(p1.w);
        var line = L.polyline(
            [[p0.la, p0.lo], [p1.la, p1.lo]],
            { color: color, weight: 2.5, opacity: 0.85 }
        );
        trackLayer.addLayer(line);
    }

    // Fit bounds
    var lats = track.filter(function (p) { return p.la; }).map(function (p) { return p.la; });
    var lons = track.filter(function (p) { return p.lo; }).map(function (p) { return p.lo; });
    if (lats.length > 0) {
        stormMap.fitBounds([
            [Math.min.apply(null, lats) - 2, Math.min.apply(null, lons) - 2],
            [Math.max.apply(null, lats) + 2, Math.max.apply(null, lons) + 2]
        ]);
    }
}

// ── Filtering ────────────────────────────────────────────────

window.toggleBasin = function (btn) {
    var basin = btn.getAttribute('data-basin');

    if (basin === 'ALL') {
        // Reset all to inactive, set ALL to active
        document.querySelectorAll('.basin-chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        activeBasins = ['ALL'];
    } else {
        // Deactivate ALL, toggle this basin
        document.querySelector('.basin-chip[data-basin="ALL"]').classList.remove('active');
        btn.classList.toggle('active');

        activeBasins = [];
        document.querySelectorAll('.basin-chip.active').forEach(function (c) {
            var b = c.getAttribute('data-basin');
            if (b !== 'ALL') activeBasins.push(b);
        });

        // If none selected, revert to ALL
        if (activeBasins.length === 0) {
            document.querySelector('.basin-chip[data-basin="ALL"]').classList.add('active');
            activeBasins = ['ALL'];
        }
    }
    onFilterChange();
    updateHashSilently();
};

window.onFilterChange = function () {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(applyFilters, 150);
};

window.onWindFilterChange = function () {
    var val = parseInt(document.getElementById('filter-wind-min').value) || 0;
    var label = document.getElementById('wind-min-label');
    if (val === 0) {
        label.textContent = '0 kt (All)';
    } else {
        label.textContent = val + ' kt (' + getIntensityCategory(val) + '+)';
    }
    onFilterChange();
};

window.onAceFilterChange = function () {
    var val = parseFloat(document.getElementById('filter-ace-min').value) || 0;
    document.getElementById('ace-min-label').textContent = val === 0 ? '0 (All)' : '\u2265 ' + val.toFixed(0);
    onFilterChange();
};

window.onRIFilterChange = function () {
    var val = parseInt(document.getElementById('filter-ri-min').value) || 0;
    document.getElementById('ri-min-label').textContent = val === 0 ? '0 kt (All)' : '\u2265 ' + val + ' kt/24h';
    onFilterChange();
};

window.onRWFilterChange = function () {
    var val = parseInt(document.getElementById('filter-rw-max').value) || 0;
    document.getElementById('rw-max-label').textContent = val === 0 ? '0 kt (All)' : '\u2264 ' + val + ' kt/24h';
    onFilterChange();
};

function applyFilters() {
    _ga('ga_apply_filters', {});
    var nameQuery = (document.getElementById('filter-name').value || '').trim().toUpperCase();
    var yearMin = parseInt(document.getElementById('filter-year-min').value) || 0;
    var yearMax = parseInt(document.getElementById('filter-year-max').value) || 9999;
    var windMin = parseInt(document.getElementById('filter-wind-min').value) || 0;
    var aceMin = parseFloat(document.getElementById('filter-ace-min').value) || 0;
    var riMin = parseInt(document.getElementById('filter-ri-min').value) || 0;
    var rwMax = parseInt(document.getElementById('filter-rw-max').value) || 0;

    filteredStorms = allStorms.filter(function (s) {
        // Name filter
        if (nameQuery && (!s.name || s.name.toUpperCase().indexOf(nameQuery) === -1)) return false;
        // Basin filter
        if (activeBasins[0] !== 'ALL' && activeBasins.indexOf(s.basin) === -1) return false;
        // Year filter
        if (s.year < yearMin || s.year > yearMax) return false;
        // Intensity filter
        if ((s.peak_wind_kt || 0) < windMin) return false;
        // ACE filter
        if (aceMin > 0 && (s.ace || 0) < aceMin) return false;
        // RI filter (only when threshold > 0)
        if (riMin > 0 && (s.ri_24h == null || s.ri_24h < riMin)) return false;
        // RW filter (only when threshold < 0)
        if (rwMax < 0 && (s.rw_24h == null || s.rw_24h > rwMax)) return false;
        return true;
    });

    // Sort
    var sortBy = document.getElementById('sort-by').value;
    var comparators = {
        'year-desc': function (a, b) { return (b.year || 0) - (a.year || 0); },
        'year-asc':  function (a, b) { return (a.year || 0) - (b.year || 0); },
        'wind-desc': function (a, b) { return (b.peak_wind_kt || 0) - (a.peak_wind_kt || 0); },
        'ri-desc':   function (a, b) { return (b.ri_24h || 0) - (a.ri_24h || 0); },
        'rw-desc':   function (a, b) { return (a.rw_24h || 0) - (b.rw_24h || 0); },
        'ace-desc':  function (a, b) { return (b.ace || 0) - (a.ace || 0); }
    };
    if (comparators[sortBy]) filteredStorms.sort(comparators[sortBy]);

    // Clear the previously selected individual storm track and card
    if (trackLayer) trackLayer.clearLayers();
    if (selectedStorm) {
        selectedStorm = null;
        var card = document.getElementById('storm-card');
        if (card) card.style.display = 'none';
        var mc = document.getElementById('map-storm-card');
        if (mc) mc.style.display = 'none';
    }

    if (mapViewMode === 'tracks') {
        renderTracks(filteredStorms);
    } else {
        renderMarkers(filteredStorms);
    }
}

window.resetFilters = function () {
    document.getElementById('filter-name').value = '';
    document.getElementById('filter-year-min').value = '';
    document.getElementById('filter-year-max').value = '';
    document.getElementById('filter-wind-min').value = 0;
    document.getElementById('wind-min-label').textContent = '0 kt (All)';
    document.getElementById('filter-ace-min').value = 0;
    document.getElementById('ace-min-label').textContent = '0 (All)';
    document.getElementById('filter-ri-min').value = 0;
    document.getElementById('ri-min-label').textContent = '0 kt (All)';
    document.getElementById('filter-rw-max').value = 0;
    document.getElementById('rw-max-label').textContent = '0 kt (All)';
    document.getElementById('sort-by').value = 'year-desc';

    document.querySelectorAll('.basin-chip').forEach(function (c) { c.classList.remove('active'); });
    document.querySelector('.basin-chip[data-basin="ALL"]').classList.add('active');
    activeBasins = ['ALL'];

    filteredStorms = allStorms.slice();
    if (mapViewMode === 'tracks') {
        renderTracks(filteredStorms);
    } else {
        renderMarkers(filteredStorms);
    }

    // Hide storm card
    document.getElementById('storm-card').style.display = 'none';
    selectedStorm = null;
    if (trackLayer) trackLayer.clearLayers();
};

// ══════════════════════════════════════════════════════════════
//  STORM DETAIL TAB
// ══════════════════════════════════════════════════════════════

window.viewStormDetail = function () {
    if (!selectedStorm) {
        showToast('Select a storm first');
        return;
    }

    // Check if tracks are loaded
    if (!allTracks || Object.keys(allTracks).length === 0) {
        showToast('Track data still loading, please wait...');
        // Retry after a short delay
        setTimeout(function () {
            if (selectedStorm) viewStormDetail();
        }, 1500);
        return;
    }

    // Force the tab switch (bypass the guard since we have a storm)
    document.querySelectorAll('.ga-tab').forEach(function (btn) {
        var isTarget = btn.getAttribute('data-tab') === 'detail';
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });
    document.querySelectorAll('.ga-tab-content').forEach(function (panel) {
        panel.classList.toggle('active', panel.id === 'tab-detail');
    });

    // Small delay to let the DOM settle before rendering charts/maps
    setTimeout(function () {
        renderStormDetail(selectedStorm);
    }, 50);
};

function renderStormDetail(storm) {
    var _radarKey = (storm.name || '').toUpperCase() + '_' + storm.year;
    _ga('ga_view_storm_detail', {
        sid: storm.sid, storm_name: storm.name, year: storm.year, basin: storm.basin,
        peak_wind_kt: storm.peak_wind_kt, has_tc_radar: !!(tcRadarLookup && tcRadarLookup[_radarKey])
    });
    // Header
    var color = getIntensityColor(storm.peak_wind_kt);
    var cat = getIntensityCategory(storm.peak_wind_kt);
    document.getElementById('detail-title').innerHTML =
        (storm.name || 'UNNAMED') +
        ' <span class="intensity-badge" style="background:' + color + '">' + cat + '</span>';
    document.getElementById('detail-subtitle').textContent =
        storm.year + ' · ' + (BASIN_NAMES[storm.basin] || storm.basin) +
        ' · Peak: ' + (storm.peak_wind_kt || '?') + ' kt / ' + (storm.min_pres_hpa || '?') + ' hPa' +
        ' · ACE: ' + (storm.ace || 0).toFixed(1);

    // TC-RADAR cross-link — show button if this storm has airborne radar analyses
    var radarLink = document.getElementById('tc-radar-link');
    var radarKey = (storm.name || '').toUpperCase() + '_' + storm.year;
    var radarEntry = tcRadarLookup && tcRadarLookup[radarKey];
    if (radarEntry) {
        radarLink.href = 'explorer.html#case=' + radarEntry.case;
        radarLink.title = radarEntry.n + ' airborne radar ' + (radarEntry.n === 1 ? 'analysis' : 'analyses') + ' available';
        radarLink.style.display = '';
    } else {
        radarLink.style.display = 'none';
    }

    // Get track data
    var track = allTracks[storm.sid];
    if (!track || track.length === 0) {
        document.getElementById('timeline-chart').innerHTML = '<div style="padding:40px;text-align:center;color:#8b9ec2;">Track data not available for this storm.</div>';
        return;
    }

    renderIntensityTimeline(track, storm);
    renderDetailMap(track, storm);

    // F-Deck toggle — show for storms with an ATCF ID (NHC-monitored)
    var fdeckToggleWrap = document.getElementById('fdeck-toggle-wrap');
    fdeckVisible = false;
    fdeckData = null;
    fdeckLoaded = false;
    fdeckTraceCount = 0;
    var hasNHCFDeck = storm.atcf_id && (storm.basin === 'NA' || storm.basin === 'EP');
    if (hasNHCFDeck) {
        fdeckToggleWrap.style.display = '';
        document.getElementById('fdeck-toggle-btn').textContent = 'Show F-Deck';
        document.getElementById('fdeck-toggle-btn').classList.remove('active');
        document.getElementById('fdeck-status').textContent = '';
    } else {
        fdeckToggleWrap.style.display = 'none';
    }

    // Reset VDM state on storm change
    vdmData = null;
    vdmLoaded = false;
    vdmMapLayers = [];

    // IR overlay — show toggle for storms with IR data (HURSAT 1978-2015, MergIR 1998+)
    var irToggleWrap = document.getElementById('ir-toggle-wrap');
    var hasIR = storm.hursat || storm.year >= 1998;
    if (hasIR) {
        irToggleWrap.style.display = '';
        document.getElementById('ir-status').textContent = 'Loading...';
        loadHURSAT(storm);
    } else {
        irToggleWrap.style.display = 'none';
        document.getElementById('ir-map-controls').style.display = 'none';
        stopIRPlayback();
        removeIROverlay();
    }

    // MW satellite overlay — show toggle if storm has an ATCF ID (TC-PRIMED coverage)
    var mwToggleWrap = document.getElementById('ga-mw-toggle-wrap');
    if (mwToggleWrap) {
        if (storm.atcf_id && storm.year >= 1987) {
            mwToggleWrap.style.display = '';
            document.getElementById('ga-mw-status').textContent = '';
            loadGlobalMWOverpasses(storm);
        } else {
            mwToggleWrap.style.display = 'none';
            removeGlobalMWOverlay();
        }
    }

    // NEXRAD 88D ground radar — show toggle and search for nearby sites
    var nexradToggleWrap = document.getElementById('ga-nexrad-toggle-wrap');
    if (nexradToggleWrap) {
        // Show toggle for storms with known positions from 1991+ (NEXRAD era)
        var hasPos = (storm.lmi_lat || storm.genesis_lat) && (storm.lmi_lon || storm.genesis_lon);
        if (hasPos && storm.year >= 1991) {
            nexradToggleWrap.style.display = '';
            document.getElementById('ga-nexrad-status').textContent = '';
            // Don't search sites yet — wait until user clicks 88D toggle,
            // which re-searches using the current IR frame position
        } else {
            nexradToggleWrap.style.display = 'none';
            removeGlobalNexradOverlay();
        }
    }

    // Flight-level reconnaissance — show toggle for all storms (HRD archive goes back to 1960)
    var flToggleWrap = document.getElementById('ga-fl-toggle-wrap');
    if (flToggleWrap) {
        var hasPos = (storm.lmi_lat || storm.genesis_lat) && (storm.lmi_lon || storm.genesis_lon);
        if (hasPos) {
            flToggleWrap.style.display = '';
            document.getElementById('ga-fl-status').textContent = '';
            if (typeof _gaFLReset === 'function') _gaFLReset();
        } else {
            flToggleWrap.style.display = 'none';
        }
    }

    // Model forecast overlay — load a-deck data if storm has ATCF ID
    if (storm.atcf_id && typeof loadModelForecasts === 'function') {
        loadModelForecasts(storm);
    } else if (typeof removeModelOverlay === 'function') {
        removeModelOverlay();
    }

    // Scorecard — reset and show toggle if storm has ATCF ID
    if (typeof removeScorecard === 'function') removeScorecard();
    var scorecardWrap = document.getElementById('scorecard-toggle-wrap');
    if (scorecardWrap) {
        scorecardWrap.style.display = storm.atcf_id ? '' : 'none';
    }

    // Pre-fetch environmental data in background so it's
    // ready when the user clicks the Environment button
    if (storm.atcf_id) {
        if (typeof loadTCPrimedEnvData === 'function') loadTCPrimedEnvData(storm);
        if (typeof loadSHIPSData === 'function') loadSHIPSData(storm);
    }
}

function renderIntensityTimeline(track, storm) {
    var times = [];
    var winds = [];
    var pres = [];
    var colors = [];

    track.forEach(function (pt) {
        if (!pt.t) return;
        times.push(pt.t);
        winds.push(pt.w);
        pres.push(pt.p);
        colors.push(getIntensityColor(pt.w));
    });

    // Saffir-Simpson category shading bands
    var shapes = [
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0,   y1: 34,  fillcolor: 'rgba(96,165,250,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 34,  y1: 64,  fillcolor: 'rgba(52,211,153,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 64,  y1: 83,  fillcolor: 'rgba(251,191,36,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 83,  y1: 96,  fillcolor: 'rgba(251,146,60,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 96,  y1: 113, fillcolor: 'rgba(248,113,113,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 113, y1: 137, fillcolor: 'rgba(239,68,68,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 137, y1: 200, fillcolor: 'rgba(220,38,38,0.06)', line: { width: 0 } }
    ];

    var windTrace = {
        x: times,
        y: winds,
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Wind (kt)',
        line: { color: '#00d4ff', width: 2.5 },
        marker: { color: colors, size: 6, line: { color: 'rgba(255,255,255,0.3)', width: 1 } },
        hovertemplate: '<b>%{x}</b><br>Wind: %{y} kt<extra></extra>',
        yaxis: 'y'
    };

    var presTrace = {
        x: times,
        y: pres,
        type: 'scatter',
        mode: 'lines',
        name: 'Pressure (hPa)',
        line: { color: '#a78bfa', width: 1.5, dash: 'dot' },
        hovertemplate: '<b>%{x}</b><br>Pressure: %{y} hPa<extra></extra>',
        yaxis: 'y2'
    };

    var maxWind = Math.max.apply(null, winds.filter(function (w) { return w != null; })) || 100;

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'Date/Time', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            linecolor: 'rgba(255,255,255,0.08)'
        },
        yaxis: {
            title: { text: 'Max Wind (kt)', font: { size: 11, color: '#00d4ff' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)',
            range: [0, Math.max(maxWind + 20, 180)],
            side: 'left'
        },
        yaxis2: {
            title: { text: 'Pressure (hPa)', font: { size: 11, color: '#a78bfa' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            overlaying: 'y',
            side: 'right',
            autorange: 'reversed',
            gridcolor: 'transparent'
        },
        shapes: shapes,
        showlegend: true,
        legend: {
            x: 0.01, y: 0.99,
            bgcolor: 'rgba(15,33,64,0.8)',
            bordercolor: 'rgba(255,255,255,0.08)',
            borderwidth: 1,
            font: { size: 11, color: '#e2e8f0' }
        },
        margin: { l: 55, r: 55, t: 10, b: 45 }
    });

    // Store base shapes for later (IR time marker is appended dynamically)
    window._timelineBaseShapes = shapes.slice();

    Plotly.newPlot('timeline-chart', [windTrace, presTrace], layout, PLOTLY_CONFIG);

    // Click handler to sync IR + Recon
    document.getElementById('timeline-chart').on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var clickedTime = data.points[0].x;
            syncIRToTime(clickedTime);

            // If an aircraft fix is clicked (FL_WIND, SFMR, DROPSONDE, AIRC_OTHER),
            // auto-activate Recon overlay and select the matching mission
            var pt = data.points[0];
            var traceName = pt.data && pt.data.name ? pt.data.name : '';
            var isReconFix = ['Flight-Level', 'SFMR', 'Dropsonde', 'Aircraft (Other)'].indexOf(traceName) >= 0;
            var isVDMFix = traceName.indexOf('VDM') >= 0;
            if ((isReconFix || isVDMFix) && clickedTime) {
                _gaFLSyncFromFDeckClick(clickedTime);
            }
        }
    });
}

/**
 * Update the vertical time marker on the intensity chart to match the
 * current IR frame time. Only visible when IR overlay is active.
 * Throttled to avoid expensive Plotly.relayout calls during fast animation.
 */
var _intensityMarkerTimer = null;
var _lastMarkerDt = null;

function updateIntensityMarker(dtStr) {
    // Skip if nothing changed
    if (dtStr === _lastMarkerDt) return;
    _lastMarkerDt = dtStr;

    // Throttle: during animation, delay updates slightly so we don't call
    // Plotly.relayout on every single frame tick (expensive)
    if (_intensityMarkerTimer) clearTimeout(_intensityMarkerTimer);
    _intensityMarkerTimer = setTimeout(function () {
        _applyIntensityMarker(dtStr);
    }, irPlaying ? 200 : 0);  // immediate when paused, 200ms throttle when playing
}

function _applyIntensityMarker(dtStr) {
    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || !chartEl.layout) return;

    var baseShapes = window._timelineBaseShapes || [];
    var extraShapes = [];

    // IR vertical line (yellow/gold) — show when IR or 88D is active
    if (dtStr && (irOverlayVisible || _gaNexradVisible)) {
        extraShapes.push({
            type: 'line',
            xref: 'x',
            yref: 'paper',
            x0: dtStr,
            x1: dtStr,
            y0: 0,
            y1: 1,
            line: { color: 'rgba(255,200,50,0.7)', width: 2, dash: 'solid' }
        });
    }

    // MW vertical line (cyan)
    if (_gaMwMarkerDt && _gaMwVisible) {
        extraShapes.push({
            type: 'line',
            xref: 'x',
            yref: 'paper',
            x0: _gaMwMarkerDt,
            x1: _gaMwMarkerDt,
            y0: 0,
            y1: 1,
            line: { color: 'rgba(0,220,255,0.7)', width: 2, dash: 'dot' }
        });
    }

    Plotly.relayout(chartEl, { shapes: baseShapes.concat(extraShapes) });
}


// ── NHC F-Deck Intensity Fixes ──────────────────────────────

// F-Deck fix type visual config — each category gets a distinct marker
var FDECK_STYLES = {
    DVTS:       { name: 'Subjective Dvorak', color: '#ff9f43', symbol: 'diamond',      size: 8 },
    DVTO:       { name: 'Objective Dvorak',  color: '#feca57', symbol: 'circle',        size: 7 },
    SFMR:       { name: 'SFMR',             color: '#ff6b6b', symbol: 'triangle-up',   size: 8 },
    FL_WIND:    { name: 'Flight-Level',      color: '#ee5a24', symbol: 'triangle-down', size: 8 },
    DROPSONDE:  { name: 'Dropsonde',         color: '#f8b739', symbol: 'square',        size: 7 },
    AIRC_OTHER: { name: 'Aircraft (Other)',  color: '#e17055', symbol: 'cross',         size: 7 }
};

window.toggleFDeck = function () {
    if (!selectedStorm || !selectedStorm.atcf_id) return;

    if (!fdeckLoaded) {
        // First time — fetch data
        var btn = document.getElementById('fdeck-toggle-btn');
        var status = document.getElementById('fdeck-status');
        btn.textContent = 'Loading...';
        btn.disabled = true;
        status.textContent = '';

        var url = API_BASE + '/global/fdeck?atcf_id=' + encodeURIComponent(selectedStorm.atcf_id);
        fetch(url)
            .then(function (resp) {
                if (!resp.ok) throw new Error('F-deck not available (' + resp.status + ')');
                return resp.json();
            })
            .then(function (data) {
                fdeckData = data.fixes;
                fdeckLoaded = true;
                fdeckVisible = true;
                btn.textContent = 'Hide F-Deck';
                btn.classList.add('active');
                btn.disabled = false;

                // Show counts
                var total = 0;
                Object.keys(data.counts).forEach(function (k) { total += data.counts[k] || 0; });
                status.textContent = total + ' fixes';

                addFDeckTraces();
            })
            .catch(function (err) {
                btn.textContent = 'Show F-Deck';
                btn.disabled = false;
                status.textContent = 'Not available';
                status.style.color = '#f87171';
                console.warn('F-deck fetch failed:', err);
            });
        return;
    }

    // Toggle visibility of existing traces
    fdeckVisible = !fdeckVisible;
    var btn = document.getElementById('fdeck-toggle-btn');

    if (fdeckVisible) {
        btn.textContent = 'Hide F-Deck';
        btn.classList.add('active');
        addFDeckTraces();
    } else {
        btn.textContent = 'Show F-Deck';
        btn.classList.remove('active');
        removeFDeckTraces();
    }
};

function addFDeckTraces() {
    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || !chartEl.data || !fdeckData) return;

    // Remove any existing f-deck traces first
    removeFDeckTraces();

    var newTraces = [];
    var fixTypes = ['DVTS', 'DVTO', 'SFMR', 'FL_WIND', 'DROPSONDE', 'AIRC_OTHER'];

    fixTypes.forEach(function (ft) {
        var fixes = fdeckData[ft];
        if (!fixes || fixes.length === 0) return;

        var style = FDECK_STYLES[ft];
        var times = [];
        var winds = [];
        var hovers = [];

        fixes.forEach(function (f) {
            times.push(f.time);
            winds.push(f.wind_kt);
            var hoverText = '<b>' + style.name + '</b><br>' +
                f.time + '<br>' +
                'Wind: ' + f.wind_kt + ' kt';
            if (f.ci !== undefined) {
                hoverText += '<br>CI#: ' + f.ci.toFixed(1);
            }
            if (f.agency) {
                hoverText += '<br>Agency: ' + f.agency;
            }
            if (f.level) {
                hoverText += '<br>Level: ' + f.level;
            }
            hoverText += '<br>(' + f.lat.toFixed(1) + '°, ' + f.lon.toFixed(1) + '°)';
            hovers.push(hoverText);
        });

        newTraces.push({
            x: times,
            y: winds,
            type: 'scatter',
            mode: 'markers',
            name: style.name,
            marker: {
                color: style.color,
                symbol: style.symbol,
                size: style.size,
                line: { color: 'rgba(255,255,255,0.5)', width: 1 }
            },
            hovertemplate: '%{text}<extra></extra>',
            text: hovers,
            yaxis: 'y'
        });
    });

    if (newTraces.length > 0) {
        Plotly.addTraces(chartEl, newTraces);
        fdeckTraceCount = newTraces.length;
    }
}

function removeFDeckTraces() {
    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || !chartEl.data || fdeckTraceCount === 0) return;

    // F-deck traces are always the last N traces added
    var totalTraces = chartEl.data.length;
    var indices = [];
    for (var i = totalTraces - fdeckTraceCount; i < totalTraces; i++) {
        indices.push(i);
    }
    Plotly.deleteTraces(chartEl, indices);
    fdeckTraceCount = 0;
}


// ── Vortex Data Messages (VDM) — auto-loaded with recon ────────

var vdmData = null;
var vdmLoaded = false;
var vdmMapLayers = [];

function _vdmFetch() {
    if (!selectedStorm || vdmLoaded) return;

    var track = allTracks[selectedStorm.sid] || [];
    var startDate = '', endDate = '';
    if (track.length > 0) {
        startDate = track[0].t.substring(0, 10);
        endDate = track[track.length - 1].t.substring(0, 10);
    }

    var url = API_BASE + '/global/vdm?storm_name=' + encodeURIComponent(selectedStorm.name) +
        '&year=' + selectedStorm.year;
    if (selectedStorm.atcf_id) url += '&atcf_id=' + encodeURIComponent(selectedStorm.atcf_id);
    if (startDate) url += '&start_date=' + startDate + '&end_date=' + endDate;

    fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (json) {
            if (!json.success || !json.vdms || json.vdms.length === 0) return;
            vdmData = json.vdms;
            vdmLoaded = true;
            _vdmRenderOnMap();
            // Re-render time series to include VDM markers
            if (_gaFLTSOpen && _gaFLData) _gaFLRenderTimeSeries();
        })
        .catch(function () {});
}

function _vdmReset() {
    _vdmRemoveFromMap();
    _vdmCloseTextOverlay();
    vdmData = null;
    vdmLoaded = false;
}

function _vdmShowTextOverlay(rawText) {
    _vdmCloseTextOverlay();
    var mapEl = document.getElementById('detail-map');
    if (!mapEl) return;
    var container = mapEl.parentNode;

    var overlay = document.createElement('div');
    overlay.id = 'ga-vdm-text-overlay';
    overlay.style.cssText = 'position:absolute;top:10px;right:10px;z-index:1000;' +
        'background:rgba(15,23,42,0.95);border:1px solid rgba(239,68,68,0.4);' +
        'border-radius:8px;padding:10px 12px;max-width:440px;max-height:360px;overflow-y:auto;';

    var closeBtn = '<div style="display:flex;justify-content:flex-end;margin-bottom:4px;">' +
        '<button onclick="_vdmCloseTextOverlay()" style="background:none;border:none;color:#f87171;' +
        'cursor:pointer;font-size:14px;padding:0 4px;">&#10005;</button></div>';

    var content = '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;' +
        'white-space:pre-wrap;color:#e2e8f0;line-height:1.4;">' +
        rawText.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';

    overlay.innerHTML = closeBtn + content;
    container.style.position = 'relative';
    container.appendChild(overlay);
}

window._vdmCloseTextOverlay = function () {
    var el = document.getElementById('ga-vdm-text-overlay');
    if (el) el.remove();
};

function _vdmRemoveFromMap() {
    for (var i = 0; i < vdmMapLayers.length; i++) {
        if (detailMap) detailMap.removeLayer(vdmMapLayers[i]);
    }
    vdmMapLayers = [];
}

function _vdmRenderOnMap() {
    _vdmRemoveFromMap();
    if (!detailMap || !vdmData || vdmData.length === 0) return;

    vdmData.forEach(function (v) {
        if (v.lat == null || v.lon == null) return;

        // Map aircraft code to readable name
        var acCode = (v.aircraft || '').toUpperCase();
        var acName = acCode;
        if (acCode.startsWith('AF')) acName = 'USAF ' + acCode;
        else if (acCode.startsWith('NOAA')) acName = 'NOAA ' + acCode.replace('NOAA', 'P-3 N');

        // Flight date from mission_id (e.g., "1111A" → mission 11 of storm 11 in year)
        var flightDate = v.time ? v.time.substring(0, 10) : '';

        var tip = '<b>VDM — ' + (v.storm_name || '') + ' OB ' + (v.ob_number || '?') + '</b><br>' +
            '<span style="color:#94a3b8;">' + acName + ' · ' + flightDate + '</span><br>' +
            (v.time ? v.time.substring(11, 19) + ' UTC<br>' : '') +
            (v.max_fl_wind_kt != null ? 'Max FL: ' + v.max_fl_wind_kt + ' kt<br>' : '') +
            (v.min_slp_hpa != null ? 'Min SLP: ' + v.min_slp_hpa + ' hPa<br>' : '') +
            (v.eye_diameter_nm != null ? 'Eye: ' + v.eye_diameter_nm + ' nm ' + (v.eye_shape || '') + '<br>' : '') +
            (v.max_sfmr_kt != null ? 'SFMR Sfc: ' + v.max_sfmr_kt + ' kt<br>' : '') +
            (v.cntr_sonde_wind_kt != null ? 'Cntr Sonde: ' + v.cntr_sonde_wind_kt + ' kt' : '');

        // Distinctive crosshair marker for VDM center fixes
        var icon = L.divIcon({
            className: '',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
            html: '<svg width="18" height="18" viewBox="0 0 18 18">' +
                '<circle cx="9" cy="9" r="6" fill="none" stroke="#ef4444" stroke-width="2" opacity="0.9"/>' +
                '<line x1="9" y1="1" x2="9" y2="5" stroke="#ef4444" stroke-width="1.5" opacity="0.8"/>' +
                '<line x1="9" y1="13" x2="9" y2="17" stroke="#ef4444" stroke-width="1.5" opacity="0.8"/>' +
                '<line x1="1" y1="9" x2="5" y2="9" stroke="#ef4444" stroke-width="1.5" opacity="0.8"/>' +
                '<line x1="13" y1="9" x2="17" y2="9" stroke="#ef4444" stroke-width="1.5" opacity="0.8"/>' +
                '<circle cx="9" cy="9" r="2" fill="#ef4444" opacity="0.9"/>' +
                '</svg>'
        });

        var marker = L.marker([v.lat, v.lon], { icon: icon, pane: 'markerPane' })
            .bindTooltip(tip, { sticky: true, className: 'ga-fl-tooltip' });
        marker.on('click', function () {
            if (typeof syncIRToTime === 'function') syncIRToTime(v.time);
            // Show decoded VDM text in a fixed overlay (not a Leaflet popup, which
            // would be closed by the IR hover handler's popup interactions)
            if (v.raw_text) {
                _vdmShowTextOverlay(v.raw_text);
            }
        });
        marker.on('tooltipopen', function () { _gaFLTooltipOpen = true; });
        marker.on('tooltipclose', function () { _gaFLTooltipOpen = false; });
        detailMap.addLayer(marker);
        vdmMapLayers.push(marker);

        // Eye diameter circle
        if (v.eye_diameter_nm != null && v.eye_diameter_nm > 0) {
            var radiusKm = v.eye_diameter_nm * 1.852 / 2;
            var eyeCircle = L.circle([v.lat, v.lon], {
                radius: radiusKm * 1000,
                color: '#ef4444', weight: 1.5, opacity: 0.4,
                fillColor: '#ef4444', fillOpacity: 0.06,
                interactive: false, pane: 'overlayPane'
            });
            detailMap.addLayer(eyeCircle);
            vdmMapLayers.push(eyeCircle);
        }
    });
}


// ── Storm Comparison Mode ───────────────────────────────────

var compareStorms = [];
var compareMap = null;
var compareAlign = 'genesis';
var COMPARE_COLORS = [
    '#00d4ff', '#ff6b6b', '#34d399', '#fbbf24',
    '#a78bfa', '#fb923c', '#f472b6', '#38bdf8'
];
var COMPARE_MAX = 8;
var compareSearchBasins = ['ALL'];
var compareSearchVisible = false;
var _compareSearchTimer = null;

// ── Compare Search / Filter ────────────────────────────────

window.toggleCompareBasin = function (btn) {
    var basin = btn.getAttribute('data-basin');
    var parent = btn.parentElement;
    if (basin === 'ALL') {
        compareSearchBasins = ['ALL'];
        parent.querySelectorAll('.basin-chip').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-basin') === 'ALL');
        });
    } else {
        // Remove ALL
        compareSearchBasins = compareSearchBasins.filter(function (b) { return b !== 'ALL'; });
        var idx = compareSearchBasins.indexOf(basin);
        if (idx >= 0) {
            compareSearchBasins.splice(idx, 1);
        } else {
            compareSearchBasins.push(basin);
        }
        if (compareSearchBasins.length === 0) compareSearchBasins = ['ALL'];
        parent.querySelectorAll('.basin-chip').forEach(function (b) {
            var d = b.getAttribute('data-basin');
            b.classList.toggle('active', compareSearchBasins.indexOf(d) >= 0);
        });
    }
    updateCompareSearch();
};

window.toggleCompareSearch = function () {
    compareSearchVisible = !compareSearchVisible;
    var inlinePanel = document.getElementById('compare-search-inline');
    var btn = document.getElementById('compare-add-btn');
    if (compareSearchVisible) {
        // Build inline search panel (mirrors the empty-state panel)
        inlinePanel.innerHTML = _buildCompareSearchHTML('inline');
        inlinePanel.style.display = '';
        if (btn) { btn.textContent = 'Hide Search'; btn.classList.add('active'); }
        // Sync basin chips in inline panel
        _syncCompareBasinChips(inlinePanel);
        _doCompareSearch('inline');
    } else {
        inlinePanel.style.display = 'none';
        inlinePanel.innerHTML = '';
        if (btn) { btn.textContent = '+ Add Storm'; btn.classList.remove('active'); }
    }
};

function _buildCompareSearchHTML(ctx) {
    var sfx = ctx === 'inline' ? '-i' : '';
    return '<h3 class="compare-search-title">Add Storms</h3>' +
        '<div class="compare-search-row">' +
            '<input type="text" id="compare-search-name' + sfx + '" class="ga-input" placeholder="Search by name (e.g. Katrina)" oninput="updateCompareSearch()">' +
        '</div>' +
        '<div class="compare-filter-row">' +
            '<span class="compare-filter-label">Basin:</span>' +
            '<div class="compare-basin-chips">' +
                '<button class="basin-chip active" data-basin="ALL" onclick="toggleCompareBasin(this)">All</button>' +
                '<button class="basin-chip" data-basin="AL" onclick="toggleCompareBasin(this)">AL</button>' +
                '<button class="basin-chip" data-basin="EP" onclick="toggleCompareBasin(this)">EP</button>' +
                '<button class="basin-chip" data-basin="WP" onclick="toggleCompareBasin(this)">WP</button>' +
                '<button class="basin-chip" data-basin="IO" onclick="toggleCompareBasin(this)">IO</button>' +
                '<button class="basin-chip" data-basin="SH" onclick="toggleCompareBasin(this)">SH</button>' +
            '</div>' +
        '</div>' +
        '<div class="compare-filter-row compare-filter-grid">' +
            '<div class="compare-filter-cell"><label>Year</label><div class="compare-range-inputs">' +
                '<input type="number" id="compare-year-min' + sfx + '" class="ga-input ga-input-sm" placeholder="1997" oninput="updateCompareSearch()">' +
                '<span>&ndash;</span>' +
                '<input type="number" id="compare-year-max' + sfx + '" class="ga-input ga-input-sm" placeholder="2024" oninput="updateCompareSearch()">' +
            '</div></div>' +
            '<div class="compare-filter-cell"><label>Min Wind (kt)</label>' +
                '<input type="number" id="compare-wind-min' + sfx + '" class="ga-input ga-input-sm" placeholder="0" oninput="updateCompareSearch()">' +
            '</div>' +
            '<div class="compare-filter-cell"><label>Min RI (kt/24h)</label>' +
                '<input type="number" id="compare-ri-min' + sfx + '" class="ga-input ga-input-sm" placeholder="0" oninput="updateCompareSearch()">' +
            '</div>' +
        '</div>' +
        '<div class="compare-filter-row">' +
            '<span class="compare-filter-label">Sort:</span>' +
            '<select id="compare-sort' + sfx + '" class="ga-select ga-select-sm" onchange="updateCompareSearch()">' +
                '<option value="year-desc">Year (newest)</option>' +
                '<option value="year-asc">Year (oldest)</option>' +
                '<option value="wind-desc">Peak Wind</option>' +
                '<option value="ri-desc">RI Rate</option>' +
                '<option value="ace-desc">ACE</option>' +
            '</select>' +
            '<span class="compare-result-count" id="compare-result-count' + sfx + '"></span>' +
        '</div>' +
        '<div id="compare-search-results' + sfx + '" class="compare-search-results"></div>';
}

function _syncCompareBasinChips(container) {
    container.querySelectorAll('.compare-basin-chips .basin-chip').forEach(function (b) {
        var d = b.getAttribute('data-basin');
        b.classList.toggle('active', compareSearchBasins.indexOf(d) >= 0);
    });
}

window.updateCompareSearch = function () {
    clearTimeout(_compareSearchTimer);
    _compareSearchTimer = setTimeout(function () {
        // Update both panels (empty-state and inline)
        _doCompareSearch('');
        _doCompareSearch('inline');
    }, 150);
};

function _doCompareSearch(ctx) {
    var sfx = ctx === 'inline' ? '-i' : '';
    var resultsEl = document.getElementById('compare-search-results' + sfx);
    if (!resultsEl) return;

    var nameInput = document.getElementById('compare-search-name' + sfx);
    var nameQuery = nameInput ? nameInput.value.trim().toUpperCase() : '';
    var yearMin = parseInt((document.getElementById('compare-year-min' + sfx) || {}).value) || 0;
    var yearMax = parseInt((document.getElementById('compare-year-max' + sfx) || {}).value) || 9999;
    var windMin = parseInt((document.getElementById('compare-wind-min' + sfx) || {}).value) || 0;
    var riMin = parseInt((document.getElementById('compare-ri-min' + sfx) || {}).value) || 0;
    var sortBy = (document.getElementById('compare-sort' + sfx) || {}).value || 'year-desc';

    var filtered = allStorms.filter(function (s) {
        if (nameQuery && (!s.name || s.name.toUpperCase().indexOf(nameQuery) === -1)) return false;
        if (compareSearchBasins[0] !== 'ALL' && compareSearchBasins.indexOf(s.basin) === -1) return false;
        if (s.year < yearMin || s.year > yearMax) return false;
        if ((s.peak_wind_kt || 0) < windMin) return false;
        if (riMin > 0 && (s.ri_24h == null || s.ri_24h < riMin)) return false;
        return true;
    });

    var comparators = {
        'year-desc': function (a, b) { return (b.year || 0) - (a.year || 0); },
        'year-asc':  function (a, b) { return (a.year || 0) - (b.year || 0); },
        'wind-desc': function (a, b) { return (b.peak_wind_kt || 0) - (a.peak_wind_kt || 0); },
        'ri-desc':   function (a, b) { return (b.ri_24h || 0) - (a.ri_24h || 0); },
        'ace-desc':  function (a, b) { return (b.ace || 0) - (a.ace || 0); }
    };
    if (comparators[sortBy]) filtered.sort(comparators[sortBy]);

    var total = filtered.length;
    filtered = filtered.slice(0, 50);

    // Update count
    var countEl = document.getElementById('compare-result-count' + sfx);
    if (countEl) countEl.textContent = total + ' storms' + (total > 50 ? ' (showing 50)' : '');

    // Render results
    _renderCompareSearchResults(resultsEl, filtered);
}

function _renderCompareSearchResults(container, storms) {
    if (!storms || storms.length === 0) {
        container.innerHTML = '<div class="compare-result-empty">No storms match your filters.</div>';
        return;
    }

    var alreadySids = {};
    compareStorms.forEach(function (s) { alreadySids[s.sid] = true; });
    var atMax = compareStorms.length >= COMPARE_MAX;

    var html = '';
    storms.forEach(function (s, i) {
        var isAdded = alreadySids[s.sid];
        var rowClass = 'compare-result-row' + (isAdded ? ' added' : '');
        var cat = _windCategory(s.peak_wind_kt);

        html += '<div class="' + rowClass + '" data-sid="' + s.sid + '" ' +
            (isAdded || atMax ? '' : 'onclick="addCompareFromSearch(\'' + s.sid + '\')"') + '>' +
            '<span class="compare-result-name">' + (s.name || 'UNNAMED') + '</span>' +
            '<span class="compare-result-meta">' + s.year + '</span>' +
            '<span class="compare-result-meta basin-badge-sm">' + (s.basin || '?') + '</span>' +
            '<span class="compare-result-meta">' + (s.peak_wind_kt || '-') + ' kt' +
                (cat ? ' <span class="cat-label-sm">' + cat + '</span>' : '') + '</span>' +
            '<span class="compare-result-meta">' + (s.ri_24h != null ? 'RI +' + s.ri_24h : '') + '</span>' +
            (isAdded
                ? '<span class="compare-result-add added">Added</span>'
                : atMax
                    ? '<span class="compare-result-add added">Full</span>'
                    : '<button class="compare-result-add" onclick="event.stopPropagation();addCompareFromSearch(\'' + s.sid + '\')">+ Add</button>'
            ) +
            '</div>';
    });
    container.innerHTML = html;
}

function _windCategory(kt) {
    if (!kt || kt < 34) return '';
    if (kt < 64) return 'TS';
    if (kt < 83) return 'Cat1';
    if (kt < 96) return 'Cat2';
    if (kt < 113) return 'Cat3';
    if (kt < 137) return 'Cat4';
    return 'Cat5';
}

window.addCompareFromSearch = function (sid) {
    var storm = allStorms.find(function (s) { return s.sid === sid; });
    if (storm) addToCompare(storm);
};

window.addCurrentToCompare = function () {
    if (!selectedStorm) return;
    addToCompare(selectedStorm);
};

function addToCompare(storm) {
    _ga('ga_add_to_compare', { storm_name: storm.name, year: storm.year, basin: storm.basin });
    if (compareStorms.length >= COMPARE_MAX) {
        showToast('Maximum ' + COMPARE_MAX + ' storms for comparison');
        return;
    }
    if (compareStorms.some(function (s) { return s.sid === storm.sid; })) {
        showToast(storm.name + ' already in comparison');
        return;
    }
    compareStorms.push(storm);
    showToast(storm.name + ' (' + storm.year + ') added to comparison');
    renderCompareView();
    updateHashSilently();
    // Refresh search results to update "Added" badges
    _doCompareSearch('');
    _doCompareSearch('inline');
}

window.removeFromCompare = function (sid) {
    compareStorms = compareStorms.filter(function (s) { return s.sid !== sid; });
    renderCompareView();
    updateHashSilently();
    _doCompareSearch('');
    _doCompareSearch('inline');
};

window.clearCompare = function () {
    compareStorms = [];
    compareSearchVisible = false;
    renderCompareView();
    updateHashSilently();
};

window.setCompareAlign = function (mode) {
    compareAlign = mode;
    document.querySelectorAll('.compare-align').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-align') === mode);
    });
    if (compareStorms.length > 0) renderCompareTimeline();
};

function renderCompareView() {
    var chips = document.getElementById('compare-chips');
    var empty = document.getElementById('compare-empty');
    var content = document.getElementById('compare-content');
    var tableWrap = document.getElementById('compare-table-wrap');
    var addBtn = document.getElementById('compare-add-btn');
    var inlinePanel = document.getElementById('compare-search-inline');

    // Render chips
    chips.innerHTML = compareStorms.map(function (s, i) {
        var c = COMPARE_COLORS[i % COMPARE_COLORS.length];
        return '<span class="compare-chip">' +
            '<span class="compare-chip-dot" style="background:' + c + '"></span>' +
            s.name + ' ' + s.year +
            '<span class="compare-chip-remove" onclick="removeFromCompare(\'' + s.sid + '\')">&times;</span>' +
            '</span>';
    }).join('');

    if (compareStorms.length === 0) {
        empty.style.display = '';
        content.style.display = 'none';
        tableWrap.style.display = 'none';
        if (addBtn) addBtn.style.display = 'none';
        if (inlinePanel) { inlinePanel.style.display = 'none'; inlinePanel.innerHTML = ''; }
        compareSearchVisible = false;
        // Hide IR comparison
        var irWrap = document.getElementById('compare-ir-wrap');
        if (irWrap) irWrap.style.display = 'none';
        // Stop any playing IR timers
        ['left','right'].forEach(function (side) {
            if (_cmpIR && _cmpIR[side] && _cmpIR[side].timer) {
                clearInterval(_cmpIR[side].timer);
                _cmpIR[side].timer = null;
                _cmpIR[side].playing = false;
            }
        });
        // Cleanup MW comparison
        if (typeof _cleanupCompareMW === 'function') _cleanupCompareMW();
        // Auto-populate search results in empty state
        setTimeout(function () { _doCompareSearch(''); }, 50);
        return;
    }

    empty.style.display = 'none';
    content.style.display = '';
    tableWrap.style.display = '';
    if (addBtn) addBtn.style.display = '';

    renderCompareTimeline();
    renderCompareMap();
    renderCompareTable();

    // Initialize side-by-side IR comparison if 2+ storms
    if (compareStorms.length >= 2 && typeof initCompareIR === 'function') {
        setTimeout(initCompareIR, 300);
    }
    // If MW mode is active, also init MW comparison
    if (compareStorms.length >= 2 && _compareMode === 'mw' && typeof initCompareMW === 'function') {
        setTimeout(initCompareMW, 400);
    }
}

function renderCompareTimeline() {
    var traces = [];
    var maxWind = 0;

    compareStorms.forEach(function (storm, idx) {
        var track = allTracks[storm.sid];
        if (!track || track.length === 0) return;

        var color = COMPARE_COLORS[idx % COMPARE_COLORS.length];
        var times = [];
        var winds = [];
        var pres = [];

        // Find reference point for alignment
        var refTime = null;
        if (compareAlign === 'genesis') {
            // Use genesis definition: first tropical/subtropical point w/ TD+ wind
            var genPt = _trackGenesisPoint(track);
            if (genPt && genPt.t) refTime = new Date(genPt.t).getTime();
        } else if (compareAlign === 'lmi') {
            var maxW = -1;
            for (var i = 0; i < track.length; i++) {
                if (track[i].w && track[i].w > maxW) {
                    maxW = track[i].w;
                    refTime = new Date(track[i].t).getTime();
                }
            }
        }

        track.forEach(function (pt) {
            if (!pt.t) return;
            if (compareAlign === 'absolute') {
                times.push(pt.t);
            } else {
                // Hours relative to reference point
                var h = (new Date(pt.t).getTime() - refTime) / 3600000;
                times.push(Math.round(h * 10) / 10);
            }
            winds.push(pt.w);
            pres.push(pt.p);
            if (pt.w && pt.w > maxWind) maxWind = pt.w;
        });

        traces.push({
            x: times, y: winds,
            type: 'scatter', mode: 'lines+markers',
            name: storm.name + ' ' + storm.year + ' (wind)',
            line: { color: color, width: 2.5 },
            marker: { color: color, size: 5 },
            hovertemplate: '<b>' + storm.name + ' ' + storm.year + '</b><br>%{x}<br>Wind: %{y} kt<extra></extra>',
            yaxis: 'y'
        });

        // Pressure trace (thinner, dashed)
        if (compareStorms.length <= 3) {
            traces.push({
                x: times, y: pres,
                type: 'scatter', mode: 'lines',
                name: storm.name + ' ' + storm.year + ' (pres)',
                line: { color: color, width: 1, dash: 'dot' },
                hovertemplate: '<b>' + storm.name + ' ' + storm.year + '</b><br>Pressure: %{y} hPa<extra></extra>',
                yaxis: 'y2',
                showlegend: false
            });
        }
    });

    var xTitle = compareAlign === 'absolute' ? 'Date/Time' :
                 compareAlign === 'genesis' ? 'Hours from Genesis' : 'Hours from LMI';

    var shapes = [
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0,   y1: 34,  fillcolor: 'rgba(96,165,250,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 34,  y1: 64,  fillcolor: 'rgba(52,211,153,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 64,  y1: 83,  fillcolor: 'rgba(251,191,36,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 83,  y1: 96,  fillcolor: 'rgba(251,146,60,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 96,  y1: 113, fillcolor: 'rgba(248,113,113,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 113, y1: 137, fillcolor: 'rgba(239,68,68,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 137, y1: 200, fillcolor: 'rgba(220,38,38,0.06)', line: { width: 0 } }
    ];

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: xTitle, font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        yaxis: {
            title: { text: 'Max Wind (kt)', font: { size: 11, color: '#00d4ff' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)',
            range: [0, Math.min(maxWind + 20, 200)]
        },
        yaxis2: {
            title: { text: 'Pressure (hPa)', font: { size: 11, color: '#a78bfa' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            overlaying: 'y', side: 'right',
            autorange: 'reversed', gridcolor: 'transparent'
        },
        shapes: shapes,
        showlegend: true,
        legend: {
            x: 0.01, y: 0.99,
            bgcolor: 'rgba(15,33,64,0.8)',
            bordercolor: 'rgba(255,255,255,0.08)',
            borderwidth: 1,
            font: { size: 10, color: '#e2e8f0' }
        },
        margin: { l: 55, r: 55, t: 10, b: 45 }
    });

    Plotly.newPlot('compare-timeline', traces, layout, PLOTLY_CONFIG);
}

function renderCompareMap() {
    if (compareMap) {
        compareMap.remove();
        compareMap = null;
    }

    compareMap = L.map('compare-map', {
        center: [20, -60], zoom: 3,
        zoomControl: true, worldCopyJump: true
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO', subdomains: 'abcd', maxZoom: 12
    }).addTo(compareMap);

    var allLats = [], allLons = [];

    compareStorms.forEach(function (storm, idx) {
        var track = allTracks[storm.sid];
        if (!track || track.length < 2) return;

        var color = COMPARE_COLORS[idx % COMPARE_COLORS.length];

        // Draw track segments — non-TC phases (disturbance, ET) shown thinner/dashed
        for (var i = 1; i < track.length; i++) {
            var p0 = track[i - 1], p1 = track[i];
            if (!p0.la || !p0.lo || !p1.la || !p1.lo) continue;
            var isTCPhase = _isTCNature(p1.n);
            L.polyline([[p0.la, p0.lo], [p1.la, p1.lo]], {
                color: color,
                weight: isTCPhase ? 3 : 1.5,
                opacity: isTCPhase ? 0.85 : 0.35,
                dashArray: isTCPhase ? null : '6,4'
            }).addTo(compareMap);
            allLats.push(p0.la, p1.la);
            allLons.push(p0.lo, p1.lo);
        }

        // Genesis marker (TD+ genesis, not first disturbance fix)
        var genCoords = _trackGenesis(track);
        var first = genCoords ? { la: genCoords[0], lo: genCoords[1] } : null;
        if (first) {
            L.circleMarker([first.la, first.lo], {
                radius: 5, color: color, fillColor: color,
                fillOpacity: 0.8, weight: 2
            }).bindTooltip(storm.name + ' ' + storm.year + ' (genesis)', {
                className: 'track-tooltip'
            }).addTo(compareMap);
        }

        // LMI marker
        var lmiPt = track.reduce(function (best, pt) {
            return (pt.w && (!best || pt.w > best.w)) ? pt : best;
        }, null);
        if (lmiPt && lmiPt.la && lmiPt.lo) {
            L.circleMarker([lmiPt.la, lmiPt.lo], {
                radius: 7, color: '#fff', fillColor: color,
                fillOpacity: 1, weight: 2
            }).bindTooltip(storm.name + ' ' + storm.year + ' LMI: ' + (lmiPt.w || '?') + ' kt', {
                className: 'track-tooltip'
            }).addTo(compareMap);
        }
    });

    // Fit bounds
    if (allLats.length > 0) {
        compareMap.fitBounds([
            [Math.min.apply(null, allLats) - 3, Math.min.apply(null, allLons) - 5],
            [Math.max.apply(null, allLats) + 3, Math.max.apply(null, allLons) + 5]
        ]);
    }
}

function renderCompareTable() {
    var html = '<table><thead><tr>' +
        '<th></th><th>Name</th><th>Year</th><th>Basin</th>' +
        '<th>Peak Wind</th><th>Min Pres</th><th>ACE</th><th>RI 24h</th><th>Duration</th>' +
        '</tr></thead><tbody>';

    compareStorms.forEach(function (s, idx) {
        var c = COMPARE_COLORS[idx % COMPARE_COLORS.length];
        var track = allTracks[s.sid] || [];
        var duration = _tcDuration(track);
        if (!duration && s.start_date && s.end_date) {
            // Fallback if no nature data: use total track span
            var days = Math.round((new Date(s.end_date) - new Date(s.start_date)) / 86400000);
            duration = days + 'd';
        }
        html += '<tr>' +
            '<td><span class="compare-chip-dot" style="background:' + c + '"></span></td>' +
            '<td style="font-family:DM Sans;font-weight:600;color:' + c + '">' + s.name + '</td>' +
            '<td>' + s.year + '</td>' +
            '<td>' + (s.basin || '-') + '</td>' +
            '<td>' + (s.peak_wind_kt || '-') + ' kt</td>' +
            '<td>' + (s.min_pres_hpa || '-') + '</td>' +
            '<td>' + (s.ace || 0).toFixed(1) + '</td>' +
            '<td>' + (s.ri_24h != null ? '+' + s.ri_24h + ' kt' : '-') + '</td>' +
            '<td>' + duration + '</td>' +
            '</tr>';
    });

    html += '</tbody></table>';
    document.getElementById('compare-table').innerHTML = html;
}


// ── Analog Storm Finder ─────────────────────────────────────

var analogReference = null;      // The storm being matched against
var analogResults = [];          // Computed results (top 20)
var analogChecked = {};          // SID → boolean for checkboxes
var analogBasinMode = 'same';    // 'same' or 'ALL'

window.openAnalogFinder = function () {
    if (!selectedStorm) {
        showToast('Select a storm first');
        return;
    }
    analogReference = selectedStorm;
    analogChecked = {};
    document.getElementById('analog-modal-title').textContent =
        'Analogs for ' + selectedStorm.name + ' (' + selectedStorm.year + ')';
    document.getElementById('analog-modal').style.display = 'flex';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    updateAnalogResults();
};

window.closeAnalogFinder = function () {
    document.getElementById('analog-modal').style.display = 'none';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};

// Hide EVERYTHING behind modals — the only truly bulletproof fix for
// elements bleeding through fixed-position overlays.
function _hideBackgroundElements() {
    var main = document.getElementById('global-main');
    if (main) main.style.display = 'none';
    var tabs = document.querySelector('.ga-tabs');
    if (tabs) tabs.style.display = 'none';
}
function _showBackgroundElements() {
    var main = document.getElementById('global-main');
    if (main) main.style.display = '';
    var tabs = document.querySelector('.ga-tabs');
    if (tabs) tabs.style.display = '';
    // Leaflet maps need a size refresh after being re-shown
    setTimeout(function () {
        if (stormMap) stormMap.invalidateSize();
        if (detailMap) detailMap.invalidateSize();
        if (compareMap) compareMap.invalidateSize();
    }, 50);
}

window.toggleAnalogBasin = function (btn) {
    var mode = btn.getAttribute('data-basin');
    analogBasinMode = mode;
    document.querySelectorAll('.analog-basin-filter .basin-chip').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-basin') === mode);
    });
    updateAnalogResults();
};

window.toggleAnalogCheck = function (sid) {
    analogChecked[sid] = !analogChecked[sid];
    var count = Object.keys(analogChecked).filter(function (k) { return analogChecked[k]; }).length;
    document.getElementById('analog-selected-count').textContent = count + ' selected';
};

window.compareSelectedAnalogs = function () {
    // Add reference storm + checked analogs to comparison
    compareStorms = [];
    addToCompare(analogReference);
    analogResults.forEach(function (r) {
        if (analogChecked[r.storm.sid]) {
            addToCompare(r.storm);
        }
    });
    closeAnalogFinder();
    switchTab('compare');
};

window.updateAnalogResults = function () {
    if (!analogReference) return;

    // Read weights from sliders
    var weights = {
        peak:    parseInt(document.getElementById('aw-peak').value),
        ri:      parseInt(document.getElementById('aw-ri').value),
        genesis: parseInt(document.getElementById('aw-genesis').value),
        track:   parseInt(document.getElementById('aw-track').value),
        season:  parseInt(document.getElementById('aw-season').value),
        ace:     parseInt(document.getElementById('aw-ace').value)
    };

    // Update displayed values
    document.getElementById('aw-peak-val').textContent = weights.peak;
    document.getElementById('aw-ri-val').textContent = weights.ri;
    document.getElementById('aw-genesis-val').textContent = weights.genesis;
    document.getElementById('aw-track-val').textContent = weights.track;
    document.getElementById('aw-season-val').textContent = weights.season;
    document.getElementById('aw-ace-val').textContent = weights.ace;

    var totalWeight = weights.peak + weights.ri + weights.genesis + weights.track + weights.season + weights.ace;
    if (totalWeight === 0) totalWeight = 1;

    var ref = analogReference;
    var refTrack = allTracks[ref.sid] || [];
    var refGenesis = _trackGenesis(refTrack);
    var refLMI = _trackLMI(refTrack);
    var refDOY = _stormDOY(ref);

    // Score all storms
    var scored = [];
    for (var i = 0; i < allStorms.length; i++) {
        var s = allStorms[i];
        if (s.sid === ref.sid) continue;
        if (analogBasinMode === 'same' && s.basin !== ref.basin) continue;

        var score = 0;

        // Peak intensity (0-1)
        if (weights.peak > 0 && ref.peak_wind_kt != null && s.peak_wind_kt != null) {
            score += weights.peak * (1 - Math.min(Math.abs(ref.peak_wind_kt - s.peak_wind_kt) / 100, 1));
        }

        // RI rate
        if (weights.ri > 0 && ref.ri_24h != null && s.ri_24h != null) {
            score += weights.ri * (1 - Math.min(Math.abs(ref.ri_24h - s.ri_24h) / 60, 1));
        }

        // Genesis location (haversine)
        if (weights.genesis > 0 && refGenesis) {
            var sGenesis = _trackGenesis(allTracks[s.sid] || []);
            if (sGenesis) {
                var dist = _haversineKm(refGenesis[0], refGenesis[1], sGenesis[0], sGenesis[1]);
                score += weights.genesis * (1 - Math.min(dist / 3000, 1));
            }
        }

        // Track shape (genesis→LMI bearing + distance)
        if (weights.track > 0 && refGenesis && refLMI) {
            var sTrack = allTracks[s.sid] || [];
            var sGenesis = _trackGenesis(sTrack);
            var sLMI = _trackLMI(sTrack);
            if (sGenesis && sLMI) {
                var refBearing = _bearing(refGenesis[0], refGenesis[1], refLMI[0], refLMI[1]);
                var sBearing = _bearing(sGenesis[0], sGenesis[1], sLMI[0], sLMI[1]);
                var bearingDiff = Math.abs(refBearing - sBearing);
                if (bearingDiff > 180) bearingDiff = 360 - bearingDiff;
                var refDist = _haversineKm(refGenesis[0], refGenesis[1], refLMI[0], refLMI[1]);
                var sDist = _haversineKm(sGenesis[0], sGenesis[1], sLMI[0], sLMI[1]);
                var distScore = 1 - Math.min(Math.abs(refDist - sDist) / 2000, 1);
                var bearingScore = 1 - bearingDiff / 180;
                score += weights.track * (bearingScore * 0.5 + distScore * 0.5);
            }
        }

        // Time of year (circular DOY)
        if (weights.season > 0 && refDOY != null) {
            var sDOY = _stormDOY(s);
            if (sDOY != null) {
                var doyDiff = Math.abs(refDOY - sDOY);
                if (doyDiff > 182) doyDiff = 365 - doyDiff;
                score += weights.season * (1 - doyDiff / 182);
            }
        }

        // ACE
        if (weights.ace > 0 && ref.ace != null && s.ace != null) {
            score += weights.ace * (1 - Math.min(Math.abs(ref.ace - s.ace) / 50, 1));
        }

        scored.push({ storm: s, score: score / totalWeight });
    }

    // Sort and take top 20
    scored.sort(function (a, b) { return b.score - a.score; });
    analogResults = scored.slice(0, 20);

    // Render results table
    _renderAnalogTable();
};

function _renderAnalogTable() {
    var container = document.getElementById('analog-results');
    if (analogResults.length === 0) {
        container.innerHTML = '<p style="color:#8b9ec2;text-align:center;padding:20px;">No matching storms found.</p>';
        return;
    }

    // Reference storm row
    var ref = analogReference;
    var html = '<table><thead><tr>' +
        '<th></th><th>#</th><th>Name</th><th>Year</th><th>Basin</th>' +
        '<th>Peak</th><th>RI 24h</th><th>ACE</th><th>Score</th>' +
        '</tr></thead><tbody>' +
        '<tr style="background:rgba(46,125,255,0.1);border-bottom:2px solid var(--blue);">' +
        '<td style="text-align:center;font-size:0.7rem;color:#00d4ff;">REF</td>' +
        '<td></td>' +
        '<td style="color:' + getIntensityColor(ref.peak_wind_kt) + ';font-family:DM Sans;font-weight:700">' + (ref.name || 'UNNAMED') + '</td>' +
        '<td>' + ref.year + '</td>' +
        '<td>' + (ref.basin || '-') + '</td>' +
        '<td style="font-weight:700">' + (ref.peak_wind_kt || '-') + '</td>' +
        '<td style="font-weight:700">' + (ref.ri_24h != null ? '+' + ref.ri_24h : '-') + '</td>' +
        '<td style="font-weight:700">' + (ref.ace || 0).toFixed(1) + '</td>' +
        '<td style="color:#00d4ff;">—</td>' +
        '</tr>';

    analogResults.forEach(function (r, i) {
        var s = r.storm;
        var checked = analogChecked[s.sid] ? ' checked' : '';
        var pct = Math.round(r.score * 100);
        var barW = Math.max(pct * 0.8, 2);
        html += '<tr>' +
            '<td><input type="checkbox" onchange="toggleAnalogCheck(\'' + s.sid + '\')"' + checked + '></td>' +
            '<td>' + (i + 1) + '</td>' +
            '<td style="color:' + getIntensityColor(s.peak_wind_kt) + ';font-family:DM Sans;font-weight:600">' + (s.name || 'UNNAMED') + '</td>' +
            '<td>' + s.year + '</td>' +
            '<td>' + (s.basin || '-') + '</td>' +
            '<td>' + (s.peak_wind_kt || '-') + '</td>' +
            '<td>' + (s.ri_24h != null ? '+' + s.ri_24h : '-') + '</td>' +
            '<td>' + (s.ace || 0).toFixed(1) + '</td>' +
            '<td>' + pct + '%<span class="analog-score-bar" style="width:' + barW + 'px"></span></td>' +
            '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

// ── Analog helper functions ─────────────────────────────────

/**
 * Genesis = first track point classified as a tropical or subtropical cyclone
 * with a closed circulation, per standard TC community genesis definitions.
 *
 * Priority:
 * 1. First point with NATURE = TS/SS (tropical/subtropical) AND wind >= 25 kt
 * 2. First point with NATURE = TS/SS (if wind data missing but nature exists)
 * 3. First point with wind >= 25 kt (if nature field not yet in track data)
 * 4. First valid coordinate (ultimate fallback for sparse records)
 */
function _trackGenesis(track) {
    if (!track) return null;
    var hasNature = track.some(function (p) { return p.n; });
    if (hasNature) {
        // Best: nature is tropical/subtropical AND has TD+ wind
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null && (p.n === 'TS' || p.n === 'SS') && p.w != null && p.w >= 25) {
                return [p.la, p.lo];
            }
        }
        // Nature-only fallback (no wind data at genesis point)
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null && (p.n === 'TS' || p.n === 'SS')) {
                return [p.la, p.lo];
            }
        }
    }
    // Wind-only fallback (nature field not yet in track data)
    for (var i = 0; i < track.length; i++) {
        if (track[i].la != null && track[i].lo != null && track[i].w != null && track[i].w >= 25) {
            return [track[i].la, track[i].lo];
        }
    }
    // Ultimate fallback: first valid coordinate
    for (var i = 0; i < track.length; i++) {
        if (track[i].la != null && track[i].lo != null) return [track[i].la, track[i].lo];
    }
    return null;
}

/**
 * Same logic as _trackGenesis but returns the full track point object
 * (with t, la, lo, w, p, n fields) instead of just [lat, lon].
 */
function _trackGenesisPoint(track) {
    if (!track) return null;
    var hasNature = track.some(function (p) { return p.n; });
    if (hasNature) {
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null && (p.n === 'TS' || p.n === 'SS') && p.w != null && p.w >= 25) return p;
        }
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null && (p.n === 'TS' || p.n === 'SS')) return p;
        }
    }
    for (var i = 0; i < track.length; i++) {
        if (track[i].la != null && track[i].lo != null && track[i].w != null && track[i].w >= 25) return track[i];
    }
    for (var i = 0; i < track.length; i++) {
        if (track[i].la != null && track[i].lo != null) return track[i];
    }
    return null;
}

function _trackLMI(track) {
    if (!track) return null;
    var best = null;
    for (var i = 0; i < track.length; i++) {
        if (track[i].w && (!best || track[i].w > best.w)) best = track[i];
    }
    return best && best.la != null ? [best.la, best.lo] : null;
}

/**
 * Compute TC-only duration: time span where NATURE is TS or SS.
 * Returns string like "5d" or "3.5d", or '' if no nature data.
 */
function _tcDuration(track) {
    if (!track || !track.some(function (p) { return p.n; })) return '';
    var tcPoints = track.filter(function (p) {
        return p.t && (p.n === 'TS' || p.n === 'SS');
    });
    if (tcPoints.length < 2) return tcPoints.length === 1 ? '<1d' : '';
    var first = new Date(tcPoints[0].t).getTime();
    var last = new Date(tcPoints[tcPoints.length - 1].t).getTime();
    var days = (last - first) / 86400000;
    return days < 1 ? '<1d' : (days % 1 > 0.2 ? days.toFixed(1) + 'd' : Math.round(days) + 'd');
}

/** Returns true if nature code indicates a TC phase (tropical or subtropical). */
function _isTCNature(n) {
    // If no nature data, assume TC (backward compat with pre-nature track data)
    if (!n) return true;
    return n === 'TS' || n === 'SS';
}

function _stormDOY(storm) {
    if (!storm.start_date) return null;
    var d = new Date(storm.start_date);
    var start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
}

function _haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _bearing(lat1, lon1, lat2, lon2) {
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    var x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function renderDetailMap(track, storm) {
    // Destroy existing map and IR overlay references
    irOverlayLayer = null;
    irPositionMarker = null;
    irTrackVisible = true;
    detailTrackElements = [];
    var trackBtn = document.getElementById('ir-track-toggle-btn');
    if (trackBtn) trackBtn.classList.add('active');
    if (detailMap) {
        detailMap.remove();
        detailMap = null;
    }

    // Create map centered on storm
    var centerLat = storm.lmi_lat || storm.genesis_lat || 20;
    var centerLon = storm.lmi_lon || storm.genesis_lon || -60;

    detailMap = L.map('detail-map', {
        center: [centerLat, centerLon],
        zoom: 4,
        zoomControl: true,
        worldCopyJump: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 12
    }).addTo(detailMap);

    // Create a pane for coastline outlines that renders ABOVE IR imagery
    // Leaflet default pane z-index: tile=200, overlay=400, shadow=500, marker=600
    // We put coastlines at z=450 — above IR overlays (400) but below markers (600)
    detailMap.createPane('coastlines');
    detailMap.getPane('coastlines').style.zIndex = 450;
    detailMap.getPane('coastlines').style.pointerEvents = 'none';

    // Load Natural Earth 110m coastlines as thin dark outlines above IR
    // Source: Natural Earth via GitHub (simplified 110m resolution, ~30KB)
    _loadCoastlineOverlay(detailMap);

    // Draw track — TC phases (TS/SS) get thick solid lines,
    // non-TC phases (DS=disturbance, ET=extratropical) get thin dashed lines
    detailTrackElements = [];
    for (var i = 1; i < track.length; i++) {
        var p0 = track[i - 1];
        var p1 = track[i];
        if (!p0.la || !p0.lo || !p1.la || !p1.lo) continue;

        var isTCPhase = _isTCNature(p1.n);
        var color = isTCPhase ? getIntensityColor(p1.w) : '#6b7280';
        var weight = isTCPhase ? 3.5 : 1.5;
        var opacity = isTCPhase ? 0.9 : 0.5;
        var dashArray = isTCPhase ? null : '6,4';
        var seg = L.polyline(
            [[p0.la, p0.lo], [p1.la, p1.lo]],
            { color: color, weight: weight, opacity: opacity, dashArray: dashArray }
        ).addTo(detailMap);
        detailTrackElements.push(seg);
    }

    // Add markers at key points
    var validPts = track.filter(function (p) { return p.la && p.lo; });
    if (validPts.length > 0) {
        // Genesis marker (first tropical/subtropical point w/ TD+ intensity)
        trackAnnotationMarkers = [];
        var genPt = _trackGenesisPoint(track);
        var gen = genPt || validPts[0]; // fallback to first point if no genesis found
        var genM = L.circleMarker([gen.la, gen.lo], {
            radius: 6, color: '#fff', fillColor: '#60a5fa', fillOpacity: 1, weight: 2
        }).bindTooltip('Genesis: ' + (gen.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
        trackAnnotationMarkers.push(genM);
        detailTrackElements.push(genM);

        // LMI marker
        var lmiPt = validPts.reduce(function (max, p) { return (p.w || 0) > (max.w || 0) ? p : max; }, validPts[0]);
        if (lmiPt) {
            var lmiM = L.circleMarker([lmiPt.la, lmiPt.lo], {
                radius: 8, color: '#fff', fillColor: getIntensityColor(lmiPt.w), fillOpacity: 1, weight: 2
            }).bindTooltip('Peak: ' + (lmiPt.w || '?') + ' kt @ ' + (lmiPt.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
            trackAnnotationMarkers.push(lmiM);
            detailTrackElements.push(lmiM);
        }

        // End marker
        var end = validPts[validPts.length - 1];
        var endM = L.circleMarker([end.la, end.lo], {
            radius: 5, color: '#fff', fillColor: '#6b7280', fillOpacity: 1, weight: 2
        }).bindTooltip('Dissipation: ' + (end.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
        trackAnnotationMarkers.push(endM);
        detailTrackElements.push(endM);

        // Fit bounds
        var lats = validPts.map(function (p) { return p.la; });
        var lons = validPts.map(function (p) { return p.lo; });
        detailMap.fitBounds([
            [Math.min.apply(null, lats) - 3, Math.min.apply(null, lons) - 5],
            [Math.max.apply(null, lats) + 3, Math.max.apply(null, lons) + 5]
        ]);
    }
}

// ══════════════════════════════════════════════════════════════
//  HURSAT IR ANIMATION
// ══════════════════════════════════════════════════════════════

function loadHURSAT(storm) {
    _ga('ga_load_ir_imagery', { sid: storm.sid, storm_name: storm.name, year: storm.year });
    irFrames = [];
    irMeta = null;
    irFrameIdx = 0;
    irPrefetchActive = 0;
    irFailedFrames = {};
    irFollowZoomSet = false;
    stopIRPlayback();
    removeIROverlay();

    // Build track data for MergIR (needed for storm-centered subsetting)
    var track = allTracks[storm.sid] || [];
    var trackParam = track.length > 0 ? '&track=' + encodeURIComponent(JSON.stringify(track)) : '';

    // Pass storm longitude for satellite viewing angle selection (HURSAT dedup)
    var lonParam = storm.lmi_lon != null ? '&storm_lon=' + storm.lmi_lon : '';

    // Use unified IR endpoint (auto-selects HURSAT vs MergIR)
    var metaUrl = API_BASE + '/global/ir/meta?sid=' + encodeURIComponent(storm.sid) + trackParam + lonParam;

    // Fall back to HURSAT-only endpoint if unified fails
    var fallbackUrl = API_BASE + '/global/hursat/meta?sid=' + encodeURIComponent(storm.sid) + lonParam;

    document.getElementById('ir-status').textContent = 'Checking satellite data...';

    // Use prefetched metadata if available (from selectStorm early prefetch)
    var metaPromise;
    if (irMetaPrefetchCache[storm.sid]) {
        metaPromise = Promise.resolve(irMetaPrefetchCache[storm.sid]);
    } else {
        metaPromise = fetch(metaUrl)
            .then(function (r) {
                if (!r.ok) throw new Error('IR metadata not available');
                return r.json();
            })
            .catch(function () {
                return fetch(fallbackUrl).then(function (r) {
                    if (!r.ok) throw new Error('HURSAT metadata not available');
                    return r.json();
                });
            });
    }

    metaPromise.then(function (meta) {
            if (!meta.available || meta.n_frames === 0) {
                var reason = meta.reason || 'No satellite frames found';
                document.getElementById('ir-status').textContent = reason;
                document.getElementById('ir-toggle-wrap').style.display = 'none';
                return;
            }
            irMeta = meta;
            document.getElementById('ir-slider').max = meta.n_frames - 1;
            document.getElementById('ir-slider').value = 0;

            var sourceLabel = meta.source === 'mergir' ? 'MergIR 4km' : (meta.source === 'gridsat' ? 'GridSat-B1' : 'HURSAT-B1');
            document.getElementById('ir-status').textContent =
                meta.n_frames + ' frames (' + sourceLabel + ')';
            document.getElementById('ir-source-badge').textContent = sourceLabel;

            // Auto-show IR overlay
            irOverlayVisible = true;
            // Hide genesis/LMI/dissipation markers so they don't obscure IR
            trackAnnotationMarkers.forEach(function (m) { if (detailMap) detailMap.removeLayer(m); });
            var toggleBtn = document.getElementById('ir-toggle-btn');
            toggleBtn.textContent = 'Hide IR';
            toggleBtn.classList.add('active');
            document.getElementById('ir-map-controls').style.display = '';

            // Show loading state for first frame
            var loadingEl = document.getElementById('ir-frame-loading');
            if (loadingEl) loadingEl.style.display = 'flex';
            if (meta.source === 'hursat') {
                setIRLoadingText('Downloading satellite archive...\nThis may take up to 60 seconds');
            } else {
                setIRLoadingText('Loading satellite imagery...');
            }

            // Load first frame — use prefetched data if available
            irFrameIdx = 0;
            if (irFirstFrameCache[storm.sid]) {
                // First frame was already prefetched — display instantly
                irFrames[0] = irFirstFrameCache[storm.sid];
                delete irFirstFrameCache[storm.sid]; // Free memory
                displayIROnMap(irFrames[0]);
                updateIRMeta(0);
                var loadingEl2 = document.getElementById('ir-frame-loading');
                if (loadingEl2) loadingEl2.style.display = 'none';
                prefetchIRFrames(0);
            } else {
                loadIRFrame(0);
            }

            // Prefetching is triggered by loadIRFrame's callback (or above)
        })
        .catch(function (err) {
            console.warn('IR load failed:', err);
            document.getElementById('ir-status').textContent = 'API not connected';
            document.getElementById('ir-toggle-wrap').style.display = 'none';
        });
}

function removeIROverlay() {
    if (irOverlayLayer && detailMap) {
        try { detailMap.removeLayer(irOverlayLayer); } catch (e) {}
    }
    irOverlayLayer = null;
    if (irPositionMarker && detailMap) {
        try { detailMap.removeLayer(irPositionMarker); } catch (e) {}
    }
    // Clear intensity chart marker
    _lastMarkerDt = null;
    if (typeof updateIntensityMarker === 'function') {
        updateIntensityMarker(null);
    }
    irPositionMarker = null;
    irOverlayVisible = false;
    // Clear Tb hover state
    irCurrentTbData = null;
    irCurrentTbRows = 0;
    irCurrentTbCols = 0;
    irCurrentBounds = null;
    if (irTbTooltip && detailMap) {
        try { detailMap.closePopup(irTbTooltip); } catch (e) {}
    }
}

window.toggleIROverlay = function () {
    if (!irMeta) return;
    irOverlayVisible = !irOverlayVisible;

    var toggleBtn = document.getElementById('ir-toggle-btn');
    var controls = document.getElementById('ir-map-controls');

    if (irOverlayVisible) {
        toggleBtn.textContent = 'Hide IR';
        toggleBtn.classList.add('active');
        controls.style.display = '';
        // Reposition MW controls above IR if MW is visible
        setTimeout(_repositionMWControls, 50);
        // Hide track annotation markers so they don't obscure IR
        trackAnnotationMarkers.forEach(function (m) { if (detailMap) detailMap.removeLayer(m); });
        if (irOverlayLayer && detailMap) {
            irOverlayLayer.addTo(detailMap);
            irOverlayLayer.setOpacity(irOpacity);
        }
        if (irPositionMarker && detailMap) {
            irPositionMarker.addTo(detailMap);
        }
        if (irFrames[irFrameIdx]) {
            displayIROnMap(irFrames[irFrameIdx]);
        } else {
            loadIRFrame(irFrameIdx);
        }
    } else {
        toggleBtn.textContent = 'Show IR';
        toggleBtn.classList.remove('active');
        controls.style.display = 'none';
        // Reposition MW controls back to bottom
        _repositionMWControls();
        stopIRPlayback();
        if (irOverlayLayer && detailMap) {
            detailMap.removeLayer(irOverlayLayer);
        }
        if (irPositionMarker && detailMap) {
            detailMap.removeLayer(irPositionMarker);
        }
        // Restore track annotation markers
        trackAnnotationMarkers.forEach(function (m) { if (detailMap) m.addTo(detailMap); });
        // Close Tb hover tooltip
        if (irTbTooltip && detailMap) {
            try { detailMap.closePopup(irTbTooltip); } catch (e) {}
        }
        // Remove intensity chart time marker
        updateIntensityMarker(null);
    }
};

window.cycleIROpacity = function () {
    irOpacityIdx = (irOpacityIdx + 1) % irOpacityLevels.length;
    irOpacity = irOpacityLevels[irOpacityIdx];
    document.getElementById('ir-opacity-label').textContent = Math.round(irOpacity * 100) + '%';
    if (irOverlayLayer) {
        irOverlayLayer.setOpacity(irOpacity);
    }
};

window.toggleIRFollow = function () {
    irFollowStorm = !irFollowStorm;
    irFollowZoomSet = false; // Reset so next frame establishes zoom
    var btn = document.getElementById('ir-follow-btn');
    if (btn) {
        btn.classList.toggle('active', irFollowStorm);
        btn.title = irFollowStorm ? 'View locked to storm center (click to unlock)' : 'Free pan mode (click to lock on storm)';
    }
    // If just enabled, immediately snap to current frame
    if (irFollowStorm && irOverlayLayer && detailMap) {
        var frameBounds = irOverlayLayer.getBounds();
        if (frameBounds) {
            detailMap.fitBounds(frameBounds.pad(0.15), { animate: true, duration: 0.3, maxZoom: 7 });
            irFollowZoomSet = true;
        }
    }
};

window.toggleTrackOverlay = function () {
    irTrackVisible = !irTrackVisible;
    var btn = document.getElementById('ir-track-toggle-btn');
    if (btn) {
        btn.classList.toggle('active', irTrackVisible);
        btn.title = irTrackVisible ? 'Hide track and position marker' : 'Show track and position marker';
    }
    // Toggle all track polylines and annotation markers
    detailTrackElements.forEach(function (el) {
        if (irTrackVisible) {
            if (detailMap && !detailMap.hasLayer(el)) el.addTo(detailMap);
        } else {
            if (detailMap && detailMap.hasLayer(el)) detailMap.removeLayer(el);
        }
    });
    // Toggle the position marker too
    if (irPositionMarker) {
        if (irTrackVisible) {
            if (detailMap && !detailMap.hasLayer(irPositionMarker)) irPositionMarker.addTo(detailMap);
        } else {
            if (detailMap && detailMap.hasLayer(irPositionMarker)) detailMap.removeLayer(irPositionMarker);
        }
    }
};

function displayIROnMap(data) {
    if (!detailMap || !irOverlayVisible) {
        console.log('displayIROnMap: skipped (map=' + !!detailMap + ', visible=' + irOverlayVisible + ')');
        return;
    }
    // Support both new tb_data format and legacy PNG format
    var hasTbData = data && data.tb_data;
    var hasFrame = data && data.frame;
    if (!hasTbData && !hasFrame) {
        console.warn('displayIROnMap: no frame data', data);
        return;
    }

    // Always compute bounds from frame metadata lat/lon for animation consistency.
    // API may return actual_bounds that vary slightly frame-to-frame; using the
    // requested domain (center ± 10°) ensures smooth, jitter-free animation.
    var frameMeta = irMeta && irMeta.frames ? irMeta.frames[irFrameIdx] : null;
    var centerLat, centerLon;
    if (frameMeta && frameMeta.lat != null) {
        centerLat = frameMeta.lat;
        centerLon = frameMeta.lon;
    } else if (data.bounds) {
        // Derive center from API bounds as fallback
        centerLat = (data.bounds.south + data.bounds.north) / 2;
        centerLon = (data.bounds.west + data.bounds.east) / 2;
    } else {
        var track = allTracks[selectedStorm.sid] || [];
        if (frameMeta && frameMeta.datetime) {
            var pt = findTrackPointAtTime(track, frameMeta.datetime);
            centerLat = pt ? pt.la : (selectedStorm.lmi_lat || 20);
            centerLon = pt ? pt.lo : (selectedStorm.lmi_lon || -60);
        } else {
            centerLat = selectedStorm.lmi_lat || 20;
            centerLon = selectedStorm.lmi_lon || -60;
        }
    }
    var halfDeg = 10.0;  // Consistent domain size across all sources (20°×20°)
    var bounds = {
        south: centerLat - halfDeg,
        north: centerLat + halfDeg,
        west: centerLon - halfDeg,
        east: centerLon + halfDeg
    };

    var imageBounds = L.latLngBounds(
        [bounds.south, bounds.west],
        [bounds.north, bounds.east]
    );

    // Build the image data URI — either from raw Tb or legacy PNG
    var imageURI;
    if (hasTbData) {
        var tbArr = decodeTbData(data.tb_data);
        irCurrentTbData = tbArr;
        irCurrentTbRows = data.tb_rows;
        irCurrentTbCols = data.tb_cols;
        irCurrentTbVmin = data.tb_vmin || 170.0;
        irCurrentTbVmax = data.tb_vmax || 310.0;
        console.log('[IR] Tb grid: ' + data.tb_rows + '×' + data.tb_cols +
            ' (' + tbArr.length + ' bytes), bounds: S=' + bounds.south +
            ' N=' + bounds.north + ' W=' + bounds.west + ' E=' + bounds.east);
        imageURI = renderTbToDataURI(tbArr, data.tb_rows, data.tb_cols, irSelectedColormap, bounds.south, bounds.north);
    } else {
        // Legacy PNG format (from old cache entries)
        irCurrentTbData = null;
        irCurrentTbRows = 0;
        irCurrentTbCols = 0;
        imageURI = data.frame;
    }

    // Remove old overlay and create fresh one each frame
    if (irOverlayLayer) {
        try { detailMap.removeLayer(irOverlayLayer); } catch (e) {}
    }
    irOverlayLayer = L.imageOverlay(imageURI, imageBounds, {
        opacity: irOpacity,
        interactive: false,
        className: 'ir-overlay-image'
    }).addTo(detailMap);

    // Store bounds for hover display
    irCurrentBounds = imageBounds;

    // Set up mousemove handler (once) for Tb hover
    if (!detailMap._irHoverAttached) {
        irTbTooltip = L.popup({
            closeButton: false, autoPan: false, autoClose: false,
            className: 'ir-tb-tooltip', offset: [12, -12]
        });
        detailMap.on('mousemove', _handleIRMouseMove);
        detailMap.on('mouseout', function () {
            if (irTbTooltip && detailMap.hasLayer(irTbTooltip)) {
                detailMap.closePopup(irTbTooltip);
            }
        });
        detailMap._irHoverAttached = true;
    }

    // Pan/zoom map based on follow mode
    if (irFollowStorm) {
        if (!irFollowZoomSet) {
            // First frame: fitBounds to establish correct zoom level
            var padded = imageBounds.pad(0.15);
            detailMap.fitBounds(padded, {
                animate: false,
                maxZoom: 7
            });
            irFollowZoomSet = true;
        } else {
            // Subsequent frames: panTo center at existing zoom (no zoom jitter)
            var center = imageBounds.getCenter();
            detailMap.panTo(center, {
                animate: irPlaying,
                duration: irPlaying ? 0.3 : 0
            });
        }
    } else if (!detailMap.getBounds().contains(imageBounds)) {
        // Free-pan mode: only refit when IR drifts off-screen
        var padded = imageBounds.pad(0.3);
        detailMap.fitBounds(padded, { animate: true, duration: 0.4, maxZoom: 7 });
    }

    // Update storm position marker
    updateIRPositionMarker(data);

    // Update NEXRAD sites/scans for current frame position (throttled)
    if (_gaNexradVisible && selectedStorm) {
        var fm = irMeta && irMeta.frames ? irMeta.frames[irFrameIdx] : null;
        if (fm && fm.lat != null) {
            _updateNexradForFrame(fm.lat, fm.lon);
        }
    }
}

var _irHoverThrottled = false;
function _handleIRMouseMove(e) {
    if (_irHoverThrottled) return;
    _irHoverThrottled = true;
    setTimeout(function () { _irHoverThrottled = false; }, 50); // ~20 Hz

    // Suppress IR hover when a FL/sonde tooltip is open (recon takes precedence)
    if (_gaFLVisible && _gaFLTooltipOpen) {
        if (irTbTooltip && detailMap.hasLayer(irTbTooltip)) detailMap.closePopup(irTbTooltip);
        return;
    }

    var hasIR = irOverlayVisible && irCurrentTbData && irCurrentBounds;
    var hasNexrad = _gaNexradVisible && _gaNexradData && _gaNexradBounds;
    if (!hasIR && !hasNexrad) {
        if (irTbTooltip && detailMap && detailMap.hasLayer(irTbTooltip)) {
            detailMap.closePopup(irTbTooltip);
        }
        return;
    }
    if (!detailMap) return;

    // NEXRAD-only hover (no IR visible)
    if (!hasIR && hasNexrad) {
        var nxOnly = _handleNexradMouseMove(e);
        if (nxOnly && irTbTooltip) {
            var latStr2 = Math.abs(e.latlng.lat).toFixed(2) + (e.latlng.lat >= 0 ? '°N' : '°S');
            var lngStr2 = Math.abs(e.latlng.lng).toFixed(2) + (e.latlng.lng >= 0 ? '°E' : '°W');
            var nxHtml = '<span class="ir-tb-val" style="color:#86efac;">' +
                         nxOnly.value + ' ' + nxOnly.units + '</span>' +
                         '<span class="ir-tb-sep" style="color:#86efac;"> (88D)</span>' +
                         '<span class="ir-tb-sep"> &nbsp; </span>' +
                         '<span class="ir-tb-coord">' + latStr2 + ', ' + lngStr2 + '</span>';
            irTbTooltip.setLatLng(e.latlng).setContent(nxHtml);
            if (!detailMap.hasLayer(irTbTooltip)) irTbTooltip.openOn(detailMap);
        } else if (irTbTooltip && detailMap.hasLayer(irTbTooltip)) {
            detailMap.closePopup(irTbTooltip);
        }
        return;
    }

    var lat = e.latlng.lat;
    var lng = e.latlng.lng;
    var b = irCurrentBounds;

    // Check if cursor is within IR image bounds
    if (lat < b.getSouth() || lat > b.getNorth() ||
        lng < b.getWest() || lng > b.getEast()) {
        if (irTbTooltip && detailMap.hasLayer(irTbTooltip)) {
            detailMap.closePopup(irTbTooltip);
        }
        return;
    }

    // Map lat/lon to grid indices in the equirectangular Tb data (row 0 = north).
    // The Tb data grid has uniform latitude spacing (equirectangular), so we use
    // geographic lat directly — NOT Mercator Y. The rendered *image* is warped to
    // Mercator for display, but the hover reads from the original data grid.
    var nRows = irCurrentTbRows;
    var nCols = irCurrentTbCols;
    if (nRows === 0 || nCols === 0) return;

    var fracY = (b.getNorth() - lat) / (b.getNorth() - b.getSouth());
    var fracX = (lng - b.getWest()) / (b.getEast() - b.getWest());
    var row = Math.min(Math.floor(fracY * nRows), nRows - 1);
    var col = Math.min(Math.floor(fracX * nCols), nCols - 1);

    var rawVal = irCurrentTbData[row * nCols + col];
    if (rawVal === 0) {
        // Invalid pixel
        if (irTbTooltip && detailMap.hasLayer(irTbTooltip)) {
            detailMap.closePopup(irTbTooltip);
        }
        return;
    }

    // Decode uint8 back to Tb in Kelvin: val 1-255 → TB_VMIN to TB_VMAX
    var tbK = irCurrentTbVmin + (rawVal - 1) * (irCurrentTbVmax - irCurrentTbVmin) / 254.0;
    var tbKStr = tbK.toFixed(1);
    var tbC = (tbK - 273.15).toFixed(1);
    var latStr = Math.abs(lat).toFixed(2) + (lat >= 0 ? '°N' : '°S');
    var lngStr = Math.abs(lng).toFixed(2) + (lng >= 0 ? '°E' : '°W');
    var html = '<span class="ir-tb-val">' + tbKStr + ' K</span>' +
               '<span class="ir-tb-sep"> / </span>' +
               '<span class="ir-tb-val">' + tbC + ' °C</span>' +
               '<span class="ir-tb-sep"> &nbsp; </span>' +
               '<span class="ir-tb-coord">' + latStr + ', ' + lngStr + '</span>';

    // Append NEXRAD readout if available
    var nxHover = _handleNexradMouseMove(e);
    if (nxHover) {
        html += '<br><span class="ir-tb-val" style="color:#86efac;">' +
                nxHover.value + ' ' + nxHover.units + '</span>' +
                '<span class="ir-tb-sep" style="color:#86efac;"> (88D)</span>';
    }

    irTbTooltip.setLatLng(e.latlng).setContent(html);
    if (!detailMap.hasLayer(irTbTooltip)) {
        irTbTooltip.openOn(detailMap);
    }
}

function updateIRPositionMarker(data) {
    if (!detailMap) return;

    var frameMeta = irMeta && irMeta.frames ? irMeta.frames[irFrameIdx] : null;
    var lat, lon;

    if (frameMeta && frameMeta.lat != null) {
        lat = frameMeta.lat;
        lon = frameMeta.lon;
    } else if (frameMeta && frameMeta.datetime) {
        var track = allTracks[selectedStorm.sid] || [];
        var pt = findTrackPointAtTime(track, frameMeta.datetime);
        if (pt) { lat = pt.la; lon = pt.lo; }
    }

    if (lat != null && lon != null) {
        if (irPositionMarker) {
            irPositionMarker.setLatLng([lat, lon]);
        } else {
            irPositionMarker = L.circleMarker([lat, lon], {
                radius: 4,
                color: 'rgba(255,255,255,0.85)',
                fillColor: 'transparent',
                fillOpacity: 0,
                weight: 1.5,
                pane: 'markerPane'
            });
            if (irTrackVisible) irPositionMarker.addTo(detailMap);
            irPositionMarker.bindTooltip('', { className: 'track-tooltip', permanent: false });
        }
        var tipText = (frameMeta.datetime || '');
        if (data && data.satellite) tipText += ' [' + data.satellite + ']';
        irPositionMarker.setTooltipContent(tipText);
    }
}

function findTrackPointAtTime(track, dtStr) {
    if (!track || !track.length || !dtStr) return null;
    var targetMs = new Date(dtStr).getTime();

    // Find the two flanking track points for interpolation
    var before = null, after = null;
    var beforeMs = -Infinity, afterMs = Infinity;

    for (var i = 0; i < track.length; i++) {
        if (!track[i].t || !track[i].la) continue;
        var ptMs = new Date(track[i].t).getTime();

        if (ptMs <= targetMs && ptMs > beforeMs) {
            before = track[i];
            beforeMs = ptMs;
        }
        if (ptMs >= targetMs && ptMs < afterMs) {
            after = track[i];
            afterMs = ptMs;
        }
    }

    // Exact match or only one side available
    if (!before && !after) return null;
    if (!before) return after;
    if (!after) return before;
    if (beforeMs === afterMs) return before;

    // Linear interpolation between flanking points
    var frac = (targetMs - beforeMs) / (afterMs - beforeMs);
    return {
        t: dtStr,
        la: before.la + frac * (after.la - before.la),
        lo: before.lo + frac * (after.lo - before.lo),
        w: before.w != null && after.w != null
            ? Math.round(before.w + frac * (after.w - before.w))
            : (before.w || after.w),
        p: before.p != null && after.p != null
            ? Math.round(before.p + frac * (after.p - before.p))
            : (before.p || after.p)
    };
}

function updateIRCacheStatus() {
    if (!irMeta) return;
    var cached = irFrames.filter(function (f) { return f; }).length;
    var total = irMeta.n_frames;
    var sourceLabels = {
        'mergir': 'MergIR 4km',
        'gridsat': 'GridSat 8km',
        'hursat': 'HURSAT-B1'
    };
    var plannedLabel = sourceLabels[irMeta.source] || irMeta.source;
    var statusEl = document.getElementById('ir-status');

    // Count how many cached frames came from a fallback source
    var fallbackCount = 0;
    if (irMeta.source) {
        irFrames.forEach(function (f) {
            if (f && f.source && f.source !== irMeta.source) fallbackCount++;
        });
    }

    var text;
    if (cached < total) {
        text = cached + ' / ' + total + ' frames loaded (' + plannedLabel + ')';
    } else {
        text = total + ' frames (' + plannedLabel + ')';
    }
    if (fallbackCount > 0) {
        text += ' · ' + fallbackCount + ' fallback';
    }
    statusEl.textContent = text;
}

var irPrefetchQueue = [];    // Frames queued for prefetch
var irPrefetchActive = 0;    // Number of active prefetch requests
var IR_PREFETCH_BATCH = 8;          // Concurrent prefetch requests (HURSAT)
var IR_PREFETCH_BATCH_GRIDSAT = 14; // Higher concurrency for GridSat (small subsets, no auth)
var IR_PREFETCH_BATCH_MERGIR = 6;   // MergIR: server-side rate limiter handles pacing
                                    // limiting (server also paces with 0.5s min interval)
var IR_PREFETCH_AHEAD = 20;  // How many frames ahead to prefetch

function setIRLoadingText(msg) {
    var el = document.getElementById('ir-loading-text');
    if (el) el.textContent = msg;
}

function loadIRFrame(idx) {
    if (!irMeta || !selectedStorm) return;

    var loadingEl = document.getElementById('ir-frame-loading');

    // Check cache
    if (irFrames[idx]) {
        displayIROnMap(irFrames[idx]);
        updateIRMeta(idx);
        if (loadingEl) loadingEl.style.display = 'none';
        prefetchIRFrames(idx);
        return;
    }

    if (loadingEl) loadingEl.style.display = 'flex';

    // Show context-specific loading message
    var cached = Object.keys(irFrames).length;
    var source = irMeta.source || 'hursat';
    if (cached === 0 && source === 'hursat') {
        setIRLoadingText('Downloading satellite archive...\nThis may take up to 60 seconds');
    } else if (cached === 0) {
        setIRLoadingText('Loading satellite imagery...');
    } else {
        setIRLoadingText('Loading frame ' + (idx + 1) + '...');
    }

    fetchIRFrameSingle(idx, function (data) {
        if (data && irFrameIdx === idx) {
            displayIROnMap(data);
        }
        if (!data && irFrameIdx === idx) {
            irFailedFrames[idx] = true;
            // During playback, auto-skip to next frame
            if (irPlaying && irMeta) {
                var nextIdx = (idx + 1) % irMeta.n_frames;
                // Prevent infinite loop if all frames failed
                var attempts = 0;
                while (irFailedFrames[nextIdx] && attempts < irMeta.n_frames) {
                    nextIdx = (nextIdx + 1) % irMeta.n_frames;
                    attempts++;
                }
                if (attempts < irMeta.n_frames) {
                    irFrameIdx = nextIdx;
                    if (loadingEl) loadingEl.style.display = 'none';
                    loadIRFrame(nextIdx);
                    return;
                }
            }
            setIRLoadingText('Frame ' + (idx + 1) + ' unavailable');
            setTimeout(function () {
                if (loadingEl) loadingEl.style.display = 'none';
            }, 1500);
            return;
        }
        updateIRMeta(idx);
        if (loadingEl) loadingEl.style.display = 'none';
        prefetchIRFrames(idx);
    });
}

function fetchIRFrameSingle(idx, callback) {
    if (!irMeta || !selectedStorm) return;
    if (irFrames[idx]) { callback(irFrames[idx]); return; }
    if (irFailedFrames[idx]) { if (callback) callback(null); return; }

    // Build URL based on source (MergIR needs lat/lon, use unified endpoint)
    var frameUrl;
    var source = irMeta.source || 'hursat';

    // Cache version — bump when rendering changes (domain size, colormap, etc.)
    // to force browsers to discard stale cached frames.
    var irCacheVer = 'v5';  // bumped: raw Tb uint8 for client-side colormap rendering

    if ((source === 'mergir' || source === 'gridsat') && irMeta.frames && irMeta.frames[idx]) {
        var fi = irMeta.frames[idx];
        frameUrl = API_BASE + '/global/ir/frame?sid=' + encodeURIComponent(selectedStorm.sid) +
            '&frame_idx=' + idx +
            '&lat=' + fi.lat + '&lon=' + fi.lon +
            '&_v=' + irCacheVer;
    } else {
        // HURSAT: use legacy endpoint directly (most reliable)
        frameUrl = API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(selectedStorm.sid) +
            '&frame_idx=' + idx +
            '&_v=' + irCacheVer;
    }

    // Timeout must be long enough for the full server-side cascade:
    // MergIR attempt (~30-90s) → GridSat attempt (~10-30s) → HURSAT (~5-60s)
    // First frame needs extra time for HURSAT tarball download.
    var cached = Object.keys(irFrames).length;
    var timeoutMs = cached === 0 ? 180000 : 120000;  // 3 min first, 2 min after
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

    fetch(frameUrl, { signal: controller.signal })
        .then(function (r) {
            clearTimeout(timer);
            if (!r.ok) throw new Error('Frame not available (HTTP ' + r.status + ')');
            return r.json();
        })
        .then(function (data) {
            irFrames[idx] = data;
            updateIRCacheStatus();
            if (callback) callback(data);
        })
        .catch(function (err) {
            clearTimeout(timer);
            console.warn('Frame ' + idx + ' load failed from ' + source + ':', err);
            // Fallback: try the other endpoint
            var fallbackUrl;
            if (source === 'hursat') {
                // HURSAT failed — try the unified /ir/frame with lat/lon so the
                // server can attempt MergIR → GridSat cascade.
                var fiFallback = (irMeta && irMeta.frames) ? irMeta.frames[idx] : null;
                var latParam = fiFallback ? ('&lat=' + fiFallback.lat + '&lon=' + fiFallback.lon) : '';
                fallbackUrl = API_BASE + '/global/ir/frame?sid=' + encodeURIComponent(selectedStorm.sid) + '&frame_idx=' + idx + latParam + '&_v=' + irCacheVer;
            } else {
                // For mergir/gridsat, fall back to HURSAT legacy endpoint
                fallbackUrl = API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(selectedStorm.sid) + '&frame_idx=' + idx + '&_v=' + irCacheVer;
            }
            fetch(fallbackUrl)
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (data) {
                        irFrames[idx] = data;
                        updateIRCacheStatus();
                    }
                    if (callback) callback(data);
                })
                .catch(function () { if (callback) callback(null); });
        });
}

function prefetchIRFrames(currentIdx) {
    if (!irMeta) return;
    var total = irMeta.n_frames;
    var source = irMeta.source || 'hursat';

    // All sources use parallel individual fetches with self-replenishing chains.
    // Each completed fetch triggers another prefetchIRFrames() call, keeping
    // all slots filled until every frame is cached.
    var maxConcurrent;
    if (source === 'gridsat') maxConcurrent = IR_PREFETCH_BATCH_GRIDSAT;
    else if (source === 'mergir') maxConcurrent = IR_PREFETCH_BATCH_MERGIR;
    else maxConcurrent = IR_PREFETCH_BATCH;

    if (irPrefetchActive >= maxConcurrent) return;

    // Scan forward from current display position, wrapping around the full
    // loop, to find uncached frames. Always prioritizes frames the user
    // is about to see. No frontier needed — the scan itself skips cached frames.
    var toFetch = [];
    var slots = maxConcurrent - irPrefetchActive;
    for (var i = 0; i < total && toFetch.length < slots; i++) {
        var idx = (currentIdx + 1 + i) % total;
        if (!irFrames[idx] && !irFailedFrames[idx]) {
            toFetch.push(idx);
        }
    }

    // Also prefetch a few behind current display (for rewinding)
    for (var j = 1; j <= 3; j++) {
        var prevIdx = (currentIdx - j + total) % total;
        if (!irFrames[prevIdx] && !irFailedFrames[prevIdx] &&
            toFetch.indexOf(prevIdx) === -1 && toFetch.length < slots + 3) {
            toFetch.push(prevIdx);
        }
    }

    if (toFetch.length === 0) return;

    // Fire individual fetches in parallel — self-replenishing chain
    toFetch.forEach(function (idx) {
        irPrefetchActive++;
        fetchIRFrameSingle(idx, function (data) {
            irPrefetchActive--;
            if (!data) {
                // Mark as failed so prefetch doesn't retry this frame endlessly
                irFailedFrames[idx] = true;
            }
            updateIRCacheStatus();
            // Chain: each completion immediately fills the empty slot
            prefetchIRFrames(irFrameIdx);
        });
    });
}

/* fetchIRBatch removed — all sources now use individual parallel fetches via prefetchIRFrames */

var _MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun',
                    'Jul','Aug','Sep','Oct','Nov','Dec'];

function _formatIRDatetime(isoStr) {
    // Convert "2025-10-21T06:00:00" → "06 UTC 21 October 2025"
    if (!isoStr) return '';
    try {
        var parts = isoStr.split('T');
        var dateParts = parts[0].split('-');
        var timeParts = (parts[1] || '00:00:00').split(':');
        var year = dateParts[0];
        var month = parseInt(dateParts[1], 10) - 1;
        var day = parseInt(dateParts[2], 10);
        var hour = timeParts[0];
        return hour + ' UTC ' + day + ' ' + _MONTH_NAMES[month] + ' ' + year;
    } catch (e) {
        return isoStr;  // Fallback to raw string
    }
}

function updateIRMeta(idx) {
    var datetimeEl = document.getElementById('ir-datetime');
    var frameInfoEl = document.getElementById('ir-frame-info');

    var dtText = '';
    var rawDt = '';
    if (irMeta && irMeta.frames && irMeta.frames[idx]) {
        rawDt = irMeta.frames[idx].datetime || '';
        var sat = irMeta.frames[idx].satellite || '';
        // Format: "06 UTC 21 Oct 2025"
        dtText = _formatIRDatetime(rawDt);
        if (datetimeEl) datetimeEl.textContent = dtText + (sat ? '  [' + sat + ']' : '');
        // Log NC file for HURSAT debugging
        var frameData = irFrames[idx];
        if (frameData && frameData.nc_file) {
            console.log('Frame ' + idx + ': ' + rawDt + ' → ' + frameData.nc_file);
        }
    }
    if (frameInfoEl) {
        frameInfoEl.textContent = 'Frame ' + (idx + 1) + ' / ' + (irMeta ? irMeta.n_frames : '?');
    }
    var slider = document.getElementById('ir-slider');
    if (slider) slider.value = idx;

    // Update per-frame source badge (shows actual source, not planned source)
    var frameData = irFrames[idx];
    var badgeEl = document.getElementById('ir-source-badge');
    if (badgeEl && frameData && frameData.source) {
        var actualSource = frameData.source;
        var plannedSource = irMeta ? irMeta.source : '';
        var sourceLabels = {
            'mergir': 'MergIR 4km',
            'gridsat': 'GridSat 8km',
            'hursat': 'HURSAT-B1'
        };
        var label = sourceLabels[actualSource] || actualSource;
        // If this frame fell back to a different source, indicate it
        var isFallback = plannedSource && actualSource !== plannedSource;
        badgeEl.textContent = label;
        badgeEl.className = 'panel-badge ir-source-' + actualSource +
            (isFallback ? ' ir-source-fallback' : '');
    }

    // Sync intensity chart marker to current IR time (use raw ISO datetime for Plotly)
    updateIntensityMarker(rawDt);

    // Sync model forecast overlay to current IR frame time
    if (_modelVisible && _modelAutoSync && _modelData) {
        _syncModelCycleToIR();
    }

    // Update cache status
    updateIRCacheStatus();
}

window.toggleIRPlay = function () {
    if (irPlaying) {
        stopIRPlayback();
    } else {
        startIRPlayback();
    }
};

function startIRPlayback() {
    if (!irMeta || irMeta.n_frames === 0) return;
    _ga('ga_ir_playback', { storm: selectedStorm ? selectedStorm.name : '', n_frames: irMeta.n_frames });
    irPlaying = true;
    document.getElementById('ir-play-btn').innerHTML = '&#9646;&#9646; Pause';

    // Kick a prefetch burst when playback starts so the buffer fills faster
    prefetchIRFrames(irFrameIdx);

    irTimer = setInterval(function () {
        var nextIdx = (irFrameIdx + 1) % irMeta.n_frames;

        // If next frame isn't cached and isn't a known failure, skip forward
        // to the nearest cached frame so playback never stalls on a spinner.
        if (!irFrames[nextIdx] && !irFailedFrames[nextIdx]) {
            var skipIdx = -1;
            // Look ahead for the next cached frame (up to full loop)
            for (var i = 1; i < irMeta.n_frames; i++) {
                var candidate = (nextIdx + i) % irMeta.n_frames;
                if (irFrames[candidate]) { skipIdx = candidate; break; }
            }
            if (skipIdx >= 0 && skipIdx !== irFrameIdx) {
                irFrameIdx = skipIdx;
                displayIROnMap(irFrames[skipIdx]);
                updateIRMeta(skipIdx);
                // Continue prefetching ahead of where we were blocked
                prefetchIRFrames(nextIdx);
                return;
            }
        }

        irFrameIdx = nextIdx;
        loadIRFrame(irFrameIdx);
    }, irSpeed);
}

function stopIRPlayback() {
    irPlaying = false;
    if (irTimer) clearInterval(irTimer);
    irTimer = null;
    var btn = document.getElementById('ir-play-btn');
    if (btn) btn.innerHTML = '&#9654; Play';
}

window.seekIRFrame = function (val) {
    irFrameIdx = parseInt(val);
    loadIRFrame(irFrameIdx);
};

window.stepIRFrame = function (delta) {
    if (!irMeta || !irMeta.frames) return;
    var maxIdx = irMeta.frames.length - 1;
    var newIdx = irFrameIdx + delta;
    if (newIdx < 0) newIdx = 0;
    if (newIdx > maxIdx) newIdx = maxIdx;
    if (newIdx !== irFrameIdx) {
        irFrameIdx = newIdx;
        var slider = document.getElementById('ir-slider');
        if (slider) slider.value = newIdx;
        loadIRFrame(newIdx);
    }
};

window.setIRSpeed = function (val) {
    irSpeed = parseInt(val);
    if (irPlaying) {
        stopIRPlayback();
        startIRPlayback();
    }
};

function syncIRToTime(clickedTime) {
    if (!irMeta || !irMeta.frames) return;

    // Find nearest frame to clicked time
    var targetMs = new Date(clickedTime).getTime();
    var bestIdx = 0;
    var bestDiff = Infinity;

    irMeta.frames.forEach(function (f, idx) {
        var diff = Math.abs(new Date(f.datetime).getTime() - targetMs);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = idx;
        }
    });

    irFrameIdx = bestIdx;
    loadIRFrame(bestIdx);
}

// ══════════════════════════════════════════════════════════════
//  CLIMATOLOGY TAB
// ══════════════════════════════════════════════════════════════

function renderClimatology() {
    _ga('ga_view_climatology', {});
    if (allStorms.length === 0) return;
    climRendered = true;

    // Year range
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y > 0; });
    var minYear = Math.min.apply(null, years);
    var maxYear = Math.max.apply(null, years);
    document.getElementById('clim-year-range').textContent = minYear + '–' + maxYear;

    renderACEChart(minYear, maxYear);
    renderFrequencyChart(minYear, maxYear);
    renderIntensityOverview();
    renderIntensityChangeOverview();
    renderBasinPie();
    renderLMILatOverview();
}

function renderACEChart(minYear, maxYear) {
    // Compute ACE by year and basin
    var basins = Object.keys(BASIN_NAMES);
    var yearRange = [];
    for (var y = Math.max(minYear, 1950); y <= maxYear; y++) yearRange.push(y);

    var traces = basins.map(function (basin) {
        var aceByYear = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr && s.basin === basin) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });

        return {
            x: yearRange,
            y: aceByYear,
            type: 'bar',
            name: basin,
            marker: { color: BASIN_COLORS[basin] || '#6b7280' },
            hovertemplate: '<b>' + basin + ' %{x}</b><br>ACE: %{y:.1f}<extra></extra>'
        };
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'stack',
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 55, r: 10, t: 30, b: 45 }
    });

    Plotly.newPlot('clim-ace-chart', traces, layout, PLOTLY_CONFIG);

    // Click handler: open ACE drill-down modal
    document.getElementById('clim-ace-chart').on('plotly_click', function () {
        openACEModal();
    });
}

function renderFrequencyChart(minYear, maxYear) {
    var catOrder = ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'];
    var yearRange = [];
    for (var y = Math.max(minYear, 1950); y <= maxYear; y++) yearRange.push(y);

    var traces = catOrder.map(function (cat) {
        var countsByYear = yearRange.map(function (yr) {
            return allStorms.filter(function (s) {
                return s.year === yr && getCatKey(s.peak_wind_kt) === cat;
            }).length;
        });

        return {
            x: yearRange,
            y: countsByYear,
            type: 'bar',
            name: cat,
            marker: { color: SS_COLORS[cat] },
            hovertemplate: '<b>%{x}</b><br>' + cat + ': %{y}<extra></extra>'
        };
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'stack',
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'Storm Count', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 50, r: 10, t: 30, b: 45 }
    });

    Plotly.newPlot('clim-freq-chart', traces, layout, PLOTLY_CONFIG);
}

function renderIntensityOverview() {
    // Box plots of peak wind by basin — overview for main panel
    var basins = Object.keys(BASIN_NAMES);
    var traces = [];
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; });
        if (winds.length === 0) return;
        traces.push({
            y: winds, name: basin, type: 'box',
            marker: { color: BASIN_COLORS[basin] },
            boxmean: 'sd',
            hovertemplate: '<b>' + basin + '</b><br>%{y} kt<extra></extra>'
        });
    });
    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        xaxis: { tickfont: { size: 10, color: '#8b9ec2' } },
        showlegend: false,
        margin: { l: 50, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('clim-hist-chart', traces, layout, PLOTLY_CONFIG);
}

function renderIntensityChangeOverview() {
    // Two overlaid histograms: ri_24h (max 24h intensification) and rw_24h (max 24h weakening)
    var riVals = allStorms.filter(function (s) { return s.ri_24h != null; }).map(function (s) { return s.ri_24h; });
    var rwVals = allStorms.filter(function (s) { return s.rw_24h != null; }).map(function (s) { return s.rw_24h; });
    var traces = [
        {
            x: riVals, type: 'histogram', name: 'Intensification',
            marker: { color: '#60a5fa', opacity: 0.7 },
            xbins: { size: 5 },
            hovertemplate: 'RI: %{x} kt/24h<br>%{y} storms<extra></extra>'
        },
        {
            x: rwVals, type: 'histogram', name: 'Weakening',
            marker: { color: '#f87171', opacity: 0.7 },
            xbins: { size: 5 },
            hovertemplate: 'RW: %{x} kt/24h<br>%{y} storms<extra></extra>'
        }
    ];
    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'overlay',
        xaxis: { title: { text: 'Max 24-h Wind Change (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Storms', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        shapes: [
            { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: -30, x1: -30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } }
        ],
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 9, color: '#8b9ec2' } },
        margin: { l: 45, r: 10, t: 30, b: 45 }
    });
    Plotly.newPlot('clim-ri-chart', traces, layout, PLOTLY_CONFIG);
}

function renderLMILatOverview() {
    // Box plots of LMI latitude by basin
    var basins = Object.keys(BASIN_NAMES);
    var traces = [];
    basins.forEach(function (basin) {
        var lats = allStorms
            .filter(function (s) { return s.basin === basin && s.lmi_lat != null; })
            .map(function (s) { return Math.abs(s.lmi_lat); }); // Use absolute for SH comparison
        if (lats.length === 0) return;
        traces.push({
            y: lats, name: basin, type: 'box',
            marker: { color: BASIN_COLORS[basin] },
            boxmean: true,
            hovertemplate: '<b>' + basin + '</b><br>|Lat|: %{y:.1f}&deg;<extra></extra>'
        });
    });
    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: '|Latitude| of LMI (\u00B0)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        xaxis: { tickfont: { size: 10, color: '#8b9ec2' } },
        showlegend: false,
        margin: { l: 50, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('clim-lmi-chart', traces, layout, PLOTLY_CONFIG);
}

function renderBasinPie() {
    var basinCounts = {};
    allStorms.forEach(function (s) {
        var b = s.basin || 'UN';
        basinCounts[b] = (basinCounts[b] || 0) + 1;
    });

    var labels = [];
    var values = [];
    var colors = [];
    Object.keys(BASIN_NAMES).forEach(function (b) {
        if (basinCounts[b]) {
            labels.push(BASIN_NAMES[b] + ' (' + b + ')');
            values.push(basinCounts[b]);
            colors.push(BASIN_COLORS[b] || '#6b7280');
        }
    });

    var trace = {
        labels: labels,
        values: values,
        type: 'pie',
        hole: 0.45,
        marker: { colors: colors, line: { color: '#0a1628', width: 2 } },
        textfont: { color: '#e2e8f0', size: 11, family: 'DM Sans' },
        textinfo: 'label+percent',
        textposition: 'outside',
        hovertemplate: '<b>%{label}</b><br>%{value} storms (%{percent})<extra></extra>'
    };

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        showlegend: false,
        margin: { l: 20, r: 20, t: 10, b: 10 }
    });

    Plotly.newPlot('clim-basin-chart', [trace], layout, PLOTLY_CONFIG);
}

// ══════════════════════════════════════════════════════════════
//  ACE DRILL-DOWN MODAL
// ══════════════════════════════════════════════════════════════

var aceModalBasins = ['ALL'];   // Active basins in ACE modal
var aceSeasonMap = null;        // Leaflet map for season track overview

window.openACEModal = function () {
    var modal = document.getElementById('ace-modal');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();

    // Reset basin chips
    aceModalBasins = ['ALL'];
    document.querySelectorAll('#ace-basin-chips .basin-chip').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-basin') === 'ALL');
    });

    // Hide year detail initially
    document.getElementById('ace-year-detail').style.display = 'none';

    renderACEDrillDownChart();
};

window.closeACEModal = function () {
    document.getElementById('ace-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
    // Destroy season map to free memory
    if (aceSeasonMap) {
        aceSeasonMap.remove();
        aceSeasonMap = null;
    }
};

window.toggleACEBasin = function (btn) {
    var basin = btn.getAttribute('data-basin');

    if (basin === 'ALL') {
        document.querySelectorAll('#ace-basin-chips .basin-chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        aceModalBasins = ['ALL'];
    } else {
        document.querySelector('#ace-basin-chips .basin-chip[data-basin="ALL"]').classList.remove('active');
        btn.classList.toggle('active');

        aceModalBasins = [];
        document.querySelectorAll('#ace-basin-chips .basin-chip.active').forEach(function (c) {
            var b = c.getAttribute('data-basin');
            if (b !== 'ALL') aceModalBasins.push(b);
        });
        if (aceModalBasins.length === 0) {
            document.querySelector('#ace-basin-chips .basin-chip[data-basin="ALL"]').classList.add('active');
            aceModalBasins = ['ALL'];
        }
    }

    renderACEDrillDownChart();
    document.getElementById('ace-year-detail').style.display = 'none';
};

function renderACEDrillDownChart() {
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y > 0; });
    var minYear = Math.max(Math.min.apply(null, years), 1950);
    var maxYear = Math.max.apply(null, years);
    var yearRange = [];
    for (var y = minYear; y <= maxYear; y++) yearRange.push(y);

    var basins = aceModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : aceModalBasins;
    var traces = [];

    basins.forEach(function (basin) {
        var aceByYear = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr && s.basin === basin) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });

        traces.push({
            x: yearRange,
            y: aceByYear,
            type: 'scatter',
            mode: 'lines',
            name: BASIN_NAMES[basin] || basin,
            line: { color: BASIN_COLORS[basin] || '#6b7280', width: 2 },
            hovertemplate: '<b>' + (BASIN_NAMES[basin] || basin) + ' %{x}</b><br>ACE: %{y:.1f}<extra></extra>'
        });
    });

    // Also add total ACE as a thicker dashed line if showing all basins
    if (aceModalBasins[0] === 'ALL') {
        var totalACE = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });
        traces.push({
            x: yearRange,
            y: totalACE,
            type: 'scatter',
            mode: 'lines',
            name: 'Global Total',
            line: { color: '#e2e8f0', width: 2.5, dash: 'dot' },
            hovertemplate: '<b>Global %{x}</b><br>Total ACE: %{y:.1f}<extra></extra>'
        });
    }

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.15,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 55, r: 10, t: 35, b: 45 },
        hovermode: 'x unified'
    });

    Plotly.newPlot('ace-drilldown-chart', traces, layout, PLOTLY_CONFIG);

    // Click handler for year drill-down
    var chartEl = document.getElementById('ace-drilldown-chart');
    chartEl.removeAllListeners && chartEl.removeAllListeners('plotly_click');
    chartEl.on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var clickedYear = data.points[0].x;
            renderACEYearDetail(clickedYear);
        }
    });
}

function renderACEYearDetail(year) {
    var detailDiv = document.getElementById('ace-year-detail');
    detailDiv.style.display = '';

    // Scroll to it
    detailDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    var basins = aceModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : aceModalBasins;

    // Get storms for this year matching basin filter
    var yearStorms = allStorms.filter(function (s) {
        return s.year === year && (aceModalBasins[0] === 'ALL' || aceModalBasins.indexOf(s.basin) !== -1);
    });

    // Sort by ACE descending
    yearStorms.sort(function (a, b) { return (b.ace || 0) - (a.ace || 0); });

    var totalACE = yearStorms.reduce(function (sum, s) { return sum + (s.ace || 0); }, 0);

    document.getElementById('ace-year-title').textContent =
        year + ' Season — ' + yearStorms.length + ' storms, ACE: ' + totalACE.toFixed(1);

    // Render season track map
    renderACESeasonMap(yearStorms);

    // Bar chart of storm ACE
    var stormNames = yearStorms.map(function (s) {
        return (s.name || 'UNNAMED') + ' (' + s.basin + ')';
    });
    var stormACE = yearStorms.map(function (s) { return Math.round((s.ace || 0) * 10) / 10; });
    var stormColors = yearStorms.map(function (s) { return getIntensityColor(s.peak_wind_kt); });

    var trace = {
        y: stormNames,
        x: stormACE,
        type: 'bar',
        orientation: 'h',
        marker: { color: stormColors },
        hovertemplate: '<b>%{y}</b><br>ACE: %{x:.1f}<extra></extra>',
        texttemplate: '%{x:.1f}',
        textposition: 'outside',
        textfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }
    };

    var chartHeight = Math.max(250, yearStorms.length * 26 + 60);

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        yaxis: {
            tickfont: { size: 10, color: '#e2e8f0' },
            autorange: 'reversed'
        },
        showlegend: false,
        margin: { l: 160, r: 50, t: 10, b: 40 },
        height: chartHeight
    });

    Plotly.newPlot('ace-year-chart', [trace], layout, PLOTLY_CONFIG);

    // Click handler to jump to storm detail
    document.getElementById('ace-year-chart').on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var idx = data.points[0].pointIndex;
            var storm = yearStorms[idx];
            if (storm) {
                closeACEModal();
                selectedStorm = storm;
                selectStorm(storm);
                viewStormDetail();
            }
        }
    });

    // Build table
    var maxACE = Math.max.apply(null, stormACE) || 1;
    var html = '<table><thead><tr>' +
        '<th>Storm</th><th>Basin</th><th>Peak Wind</th><th>Min Pres</th><th>ACE</th><th style="width:30%;">Contribution</th>' +
        '</tr></thead><tbody>';

    yearStorms.forEach(function (s) {
        var pct = totalACE > 0 ? ((s.ace || 0) / totalACE * 100) : 0;
        var barWidth = maxACE > 0 ? ((s.ace || 0) / maxACE * 100) : 0;
        var color = getIntensityColor(s.peak_wind_kt);
        html += '<tr>' +
            '<td><span class="ace-storm-name" style="color:' + color + ';" onclick="aceJumpToStorm(\'' + s.sid + '\')">' +
            (s.name || 'UNNAMED') + '</span></td>' +
            '<td>' + s.basin + '</td>' +
            '<td class="mono">' + (s.peak_wind_kt || '—') + ' kt</td>' +
            '<td class="mono">' + (s.min_pres_hpa || '—') + ' hPa</td>' +
            '<td class="mono">' + (s.ace || 0).toFixed(1) + '</td>' +
            '<td class="ace-bar-cell"><span class="ace-bar" style="width:' + barWidth + '%;background:' + color + ';"></span> ' +
            '<span style="font-size:0.72rem;color:var(--text-dim);">' + pct.toFixed(1) + '%</span></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('ace-year-table').innerHTML = html;
}

window.aceJumpToStorm = function (sid) {
    var storm = allStorms.find(function (s) { return s.sid === sid; });
    if (storm) {
        closeACEModal();
        selectedStorm = storm;
        selectStorm(storm);
        viewStormDetail();
    }
};

// ── Season Track Map ─────────────────────────────────────────

function renderACESeasonMap(yearStorms) {
    // Destroy previous instance
    if (aceSeasonMap) {
        aceSeasonMap.remove();
        aceSeasonMap = null;
    }

    var mapEl = document.getElementById('ace-season-map');
    if (!mapEl) return;

    // Collect storms that have track data
    var stormsWithTracks = yearStorms.filter(function (s) { return allTracks && allTracks[s.sid]; });
    if (stormsWithTracks.length === 0) {
        mapEl.style.display = 'none';
        return;
    }
    mapEl.style.display = '';

    // Initialize map
    aceSeasonMap = L.map('ace-season-map', {
        center: [20, -60],
        zoom: 3,
        zoomControl: true,
        worldCopyJump: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 12
    }).addTo(aceSeasonMap);

    var allLats = [];
    var allLons = [];

    // Compute median ACE for label filtering (reduce clutter in busy seasons)
    var aceValues = stormsWithTracks.map(function (s) { return s.ace || 0; }).sort(function (a, b) { return a - b; });
    var medianACE = aceValues.length > 0 ? aceValues[Math.floor(aceValues.length / 2)] : 0;
    var labelThreshold = stormsWithTracks.length > 20 ? medianACE : -1;

    stormsWithTracks.forEach(function (storm) {
        var track = allTracks[storm.sid];
        if (!track || track.length < 2) return;

        var validPts = track.filter(function (p) { return p.la && p.lo; });
        if (validPts.length < 2) return;

        // Draw intensity-colored polyline segments
        var segmentCoords = [];
        for (var i = 1; i < validPts.length; i++) {
            var p0 = validPts[i - 1];
            var p1 = validPts[i];
            var isTCPhase = _isTCNature(p1.n);
            var color = isTCPhase ? getIntensityColor(p1.w) : '#6b7280';
            var seg = L.polyline(
                [[p0.la, p0.lo], [p1.la, p1.lo]],
                { color: color, weight: isTCPhase ? 2.5 : 1, opacity: isTCPhase ? 0.85 : 0.35, dashArray: isTCPhase ? null : '4,3' }
            );
            seg._stormSid = storm.sid;
            seg.addTo(aceSeasonMap);

            // Tooltip on hover
            seg.bindTooltip(
                '<b style="color:' + getIntensityColor(storm.peak_wind_kt) + '">' +
                (storm.name || 'UNNAMED') + '</b><br>' +
                getIntensityCategory(storm.peak_wind_kt) + ' — ' + (storm.peak_wind_kt || '?') + ' kt' +
                (storm.ace ? '<br>ACE: ' + storm.ace.toFixed(1) : ''),
                { sticky: true, className: 'track-tooltip', direction: 'top', offset: [0, -8] }
            );

            // Click to jump to storm detail
            seg.on('click', (function (sid) {
                return function () { aceJumpToStorm(sid); };
            })(storm.sid));

            // Highlight on hover
            seg.on('mouseover', function () { this.setStyle({ weight: 5, opacity: 1 }); });
            seg.on('mouseout', function () { this.setStyle({ weight: 2.5, opacity: 0.85 }); });
        }

        // Collect bounds
        validPts.forEach(function (p) {
            allLats.push(p.la);
            allLons.push(p.lo);
        });

        // Add storm name label at LMI point (or midpoint)
        if ((storm.ace || 0) > labelThreshold) {
            var lmiPt = validPts.reduce(function (max, p) {
                return (p.w || 0) > (max.w || 0) ? p : max;
            }, validPts[0]);

            var labelColor = getIntensityColor(storm.peak_wind_kt);
            var icon = L.divIcon({
                className: 'ace-track-label',
                html: '<span style="color:' + labelColor + '">' + (storm.name || 'UNNAMED') + '</span>',
                iconSize: [0, 0],
                iconAnchor: [-5, 6]
            });
            L.marker([lmiPt.la, lmiPt.lo], { icon: icon, interactive: false }).addTo(aceSeasonMap);
        }

        // Genesis dot
        var gen = validPts[0];
        L.circleMarker([gen.la, gen.lo], {
            radius: 3, color: '#fff', fillColor: getIntensityColor(gen.w), fillOpacity: 0.9, weight: 1
        }).addTo(aceSeasonMap);
    });

    // Fit map bounds
    if (allLats.length > 0) {
        aceSeasonMap.fitBounds([
            [Math.min.apply(null, allLats) - 3, Math.min.apply(null, allLons) - 5],
            [Math.max.apply(null, allLats) + 3, Math.max.apply(null, allLons) + 5]
        ]);
    }
}

// ══════════════════════════════════════════════════════════════
//  INTENSITY DISTRIBUTION MODAL
// ══════════════════════════════════════════════════════════════

var intensityModalBasins = ['ALL'];

window.openIntensityModal = function () {
    document.getElementById('intensity-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    intensityModalBasins = ['ALL'];
    _resetBasinChips('intensity-basin-chips', 'ALL');
    renderIntensityModalCharts();
};
window.closeIntensityModal = function () {
    document.getElementById('intensity-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleIntensityBasin = function (btn) {
    intensityModalBasins = _toggleBasinChip(btn, 'intensity-basin-chips');
    renderIntensityModalCharts();
};

function renderIntensityModalCharts() {
    var basins = intensityModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : intensityModalBasins;

    // CDF chart
    var cdfTraces = [];
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; })
            .sort(function (a, b) { return a - b; });
        if (winds.length === 0) return;
        var cdf = winds.map(function (_, i) { return (i + 1) / winds.length; });
        cdfTraces.push({
            x: winds, y: cdf, type: 'scatter', mode: 'lines',
            name: BASIN_NAMES[basin],
            line: { color: BASIN_COLORS[basin], width: 2 },
            hovertemplate: '<b>' + basin + '</b><br>%{x:.0f} kt: %{y:.1%} cumulative<extra></extra>'
        });
    });
    // Add SS category reference lines
    var ssShapes = [64, 83, 96, 113, 137].map(function (kt) {
        return { type: 'line', x0: kt, x1: kt, y0: 0, y1: 1, line: { color: 'rgba(255,255,255,0.15)', width: 1, dash: 'dot' } };
    });
    var cdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Peak Wind Speed (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Cumulative Probability', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 1] },
        shapes: ssShapes,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.15, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 35, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('intensity-cdf-chart', cdfTraces, cdfLayout, PLOTLY_CONFIG);

    // Box plots
    var boxTraces = [];
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; });
        if (winds.length === 0) return;
        boxTraces.push({ y: winds, name: basin, type: 'box', marker: { color: BASIN_COLORS[basin] }, boxmean: 'sd' });
    });
    var boxLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: false, margin: { l: 55, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('intensity-box-chart', boxTraces, boxLayout, PLOTLY_CONFIG);

    // Stats table
    var html = '<table><thead><tr><th>Basin</th><th>Count</th><th>Mean</th><th>Median</th><th>P90</th><th>P99</th><th>Max</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; })
            .sort(function (a, b) { return a - b; });
        if (winds.length === 0) return;
        var mean = winds.reduce(function (a, b) { return a + b; }, 0) / winds.length;
        var med = winds[Math.floor(winds.length * 0.5)];
        var p90 = winds[Math.floor(winds.length * 0.9)];
        var p99 = winds[Math.floor(winds.length * 0.99)];
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td class="mono">' + winds.length + '</td><td class="mono">' + mean.toFixed(0) + '</td>' +
            '<td class="mono">' + med + '</td><td class="mono">' + p90 + '</td>' +
            '<td class="mono">' + p99 + '</td><td class="mono">' + Math.max.apply(null, winds) + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('intensity-stats-table').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
//  24-H INTENSITY CHANGE MODAL
// ══════════════════════════════════════════════════════════════

var riModalBasins = ['ALL'];
var riModalPeriod = 'modern'; // 'all', 'satellite', 'modern', '30yr', 'custom'

// Period definitions: [startYear, endYear]
var RI_PERIODS = {
    'all':       [0, 9999],
    'satellite': [1966, 9999],
    'modern':    [1980, 9999],
    '30yr':      [1991, 2020],
    'custom':    [1980, 2025]   // updated dynamically from inputs
};

// Helper: extract change values from intensityChangeData for a basin, filtered by period
function _riFilteredVals(basin) {
    if (!intensityChangeData || !intensityChangeData.basins || !intensityChangeData.basins[basin]) return [];
    var range = RI_PERIODS[riModalPeriod] || RI_PERIODS['modern'];
    var raw = intensityChangeData.basins[basin];
    // New format: each entry is [change, year]
    if (raw.length > 0 && Array.isArray(raw[0])) {
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var yr = raw[i][1];
            if (yr >= range[0] && yr <= range[1]) out.push(raw[i][0]);
        }
        return out;
    }
    // Legacy format: plain numbers (no year filtering possible)
    return raw;
}

// Helper: return [change, year] pairs for a basin (no period filter — used for trend analysis)
function _riAllPairs(basin) {
    if (!intensityChangeData || !intensityChangeData.basins || !intensityChangeData.basins[basin]) return [];
    var raw = intensityChangeData.basins[basin];
    if (raw.length > 0 && Array.isArray(raw[0])) return raw;
    return [];
}

function _showCustomRange(show) {
    var el = document.getElementById('ri-custom-range');
    if (el) el.style.display = show ? 'inline-flex' : 'none';
}

window.openIntensityChangeModal = function () {
    document.getElementById('intensity-change-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    riModalBasins = ['ALL'];
    riModalPeriod = 'modern';
    _resetBasinChips('ri-basin-chips', 'ALL');
    // Reset period chips
    var chips = document.querySelectorAll('#ri-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-period') === 'modern'); });
    _showCustomRange(false);
    renderRIModalCharts();
};
window.closeIntensityChangeModal = function () {
    document.getElementById('intensity-change-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleRIBasin = function (btn) {
    riModalBasins = _toggleBasinChip(btn, 'ri-basin-chips');
    renderRIModalCharts();
};
window.toggleRIPeriod = function (btn) {
    var chips = document.querySelectorAll('#ri-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.remove('active'); });
    btn.classList.add('active');
    riModalPeriod = btn.getAttribute('data-period');
    _showCustomRange(riModalPeriod === 'custom');
    if (riModalPeriod === 'custom') {
        // Read current input values
        var y1 = parseInt(document.getElementById('ri-year-start').value) || 1980;
        var y2 = parseInt(document.getElementById('ri-year-end').value) || 2025;
        RI_PERIODS['custom'] = [y1, y2];
    }
    renderRIModalCharts();
};
window.applyRICustomPeriod = function () {
    var y1 = parseInt(document.getElementById('ri-year-start').value) || 1980;
    var y2 = parseInt(document.getElementById('ri-year-end').value) || 2025;
    RI_PERIODS['custom'] = [Math.min(y1, y2), Math.max(y1, y2)];
    if (riModalPeriod === 'custom') renderRIModalCharts();
};

function renderRIModalCharts() {
    var basins = riModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : riModalBasins;

    // ── Histogram: all overwater 24-h intensity change episodes (pre-binned for percentiles) ──
    var BIN_SIZE = 5;
    var histTraces = [];
    basins.forEach(function (basin) {
        var vals = _riFilteredVals(basin);
        if (vals.length === 0) return;
        // Sort and bin manually so we can compute percentiles
        var sorted = vals.slice().sort(function (a, b) { return a - b; });
        var n = sorted.length;
        var binCounts = {};
        vals.forEach(function (v) {
            var b = Math.floor(v / BIN_SIZE) * BIN_SIZE;
            binCounts[b] = (binCounts[b] || 0) + 1;
        });
        // Build cumulative percentile at each bin's upper edge
        var binKeys = Object.keys(binCounts).map(Number).sort(function (a, b) { return a - b; });
        var cumul = 0;
        var binX = [], binY = [], binCustom = [];
        binKeys.forEach(function (b) {
            cumul += binCounts[b];
            var pctUpper = (cumul / n * 100).toFixed(1);
            var pctLower = ((cumul - binCounts[b]) / n * 100).toFixed(1);
            binX.push(b + BIN_SIZE / 2); // bin center
            binY.push(binCounts[b]);
            binCustom.push([b + ' to ' + (b + BIN_SIZE) + ' kt/24h', pctLower + '–' + pctUpper + ' pctl']);
        });
        histTraces.push({
            x: binX, y: binY, customdata: binCustom,
            type: 'bar', name: BASIN_NAMES[basin],
            marker: { color: BASIN_COLORS[basin], opacity: 0.65 },
            width: BIN_SIZE * 0.95,
            hovertemplate: '<b>' + basin + '</b><br>%{customdata[0]}<br>%{y} episodes (%{customdata[1]})<extra></extra>'
        });
    });
    var riShapes = [
        { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 35, x1: 35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 65, x1: 65, y0: 0, y1: 1, yref: 'paper', line: { color: '#a855f7', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: -30, x1: -30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: -35, x1: -35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } }
    ];
    var riAnnotations = [
        { x: 30, y: 1.02, yref: 'paper', xanchor: 'center', text: '30kt', showarrow: false, font: { size: 9, color: '#fbbf24' } },
        { x: 35, y: 1.06, yref: 'paper', xanchor: 'center', text: '35kt', showarrow: false, font: { size: 9, color: '#f87171' } },
        { x: 50, y: 1.02, yref: 'paper', xanchor: 'center', text: '50kt', showarrow: false, font: { size: 9, color: '#dc2626' } },
        { x: 65, y: 1.06, yref: 'paper', xanchor: 'center', text: '65kt', showarrow: false, font: { size: 9, color: '#a855f7' } },
        { x: -30, y: 1.02, yref: 'paper', xanchor: 'center', text: '-30kt', showarrow: false, font: { size: 9, color: '#fbbf24' } },
        { x: -35, y: 1.06, yref: 'paper', xanchor: 'center', text: '-35kt', showarrow: false, font: { size: 9, color: '#f87171' } }
    ];
    // Episode count + period — update HTML subtitle
    var totalEpisodes = 0;
    histTraces.forEach(function (t) { totalEpisodes += t.x.length; });
    var periodRange = RI_PERIODS[riModalPeriod] || RI_PERIODS['modern'];
    var yrMin = periodRange[0] || (intensityChangeData ? intensityChangeData.year_min : '?');
    var yrMax = periodRange[1] < 9000 ? periodRange[1] : (intensityChangeData ? intensityChangeData.year_max : '?');
    var epEl = document.getElementById('ri-episode-count');
    if (epEl) epEl.textContent = '(' + totalEpisodes.toLocaleString() + ' episodes, ' + yrMin + '–' + yrMax + ')';
    var histLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'overlay',
        xaxis: { title: { text: '24-h Wind Change (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Number of 24-h Episodes', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        shapes: riShapes, annotations: riAnnotations,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 35, b: 45 }
    });
    Plotly.newPlot('ri-hist-chart', histTraces, histLayout, PLOTLY_CONFIG);

    // ── Exceedance CDF: probability of exceeding RI threshold (per-episode) ──
    var cdfTraces = [];
    basins.forEach(function (basin) {
        // Use only positive (intensification) episodes for the exceedance curve
        var vals = _riFilteredVals(basin).filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
        if (vals.length === 0) return;
        var exceed = vals.map(function (_, i) { return 1 - (i / vals.length); });
        cdfTraces.push({
            x: vals, y: exceed, type: 'scatter', mode: 'lines',
            name: BASIN_NAMES[basin],
            line: { color: BASIN_COLORS[basin], width: 2 },
            hovertemplate: '<b>' + basin + '</b><br>%{x} kt/24h: %{y:.1%} exceed<extra></extra>'
        });
    });
    var cdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Intensification Threshold (kt/24h)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 100] },
        yaxis: { title: { text: 'Exceedance Probability', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 1] },
        shapes: [
            { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 35, x1: 35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 65, x1: 65, y0: 0, y1: 1, yref: 'paper', line: { color: '#a855f7', width: 1.5, dash: 'dash' } }
        ],
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('ri-cdf-chart', cdfTraces, cdfLayout, PLOTLY_CONFIG);

    // Stats table — episode-based statistics, filtered by period
    var range = RI_PERIODS[riModalPeriod] || RI_PERIODS['modern'];
    var periodLabel = riModalPeriod === 'all' ? 'All Years' : riModalPeriod === 'satellite' ? '1966–Present' : riModalPeriod === '30yr' ? '1991–2020' : '1980–Present';
    var plEl = document.getElementById('ri-period-label');
    if (plEl) plEl.textContent = '';  // period shown in chips, no extra label needed
    var html = '<table><thead><tr><th>Basin</th><th>Episodes</th><th>Mean</th><th>\u226530kt</th><th>\u226535kt</th><th>\u226550kt</th><th>% RI\u226530</th><th>Max RI</th><th>\u2264-30kt</th><th>Max RW</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var vals = _riFilteredVals(basin);
        if (vals.length === 0) return;
        var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        var ri30 = vals.filter(function (v) { return v >= 30; }).length;
        var ri35 = vals.filter(function (v) { return v >= 35; }).length;
        var ri50 = vals.filter(function (v) { return v >= 50; }).length;
        var maxRI = Math.max.apply(null, vals);
        var rw30 = vals.filter(function (v) { return v <= -30; }).length;
        var maxRW = Math.min.apply(null, vals);
        var pct = (ri30 / vals.length * 100).toFixed(1);
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td class="mono">' + vals.length.toLocaleString() + '</td><td class="mono">' + mean.toFixed(1) + '</td>' +
            '<td class="mono">' + ri30.toLocaleString() + '</td>' +
            '<td class="mono">' + ri35.toLocaleString() + '</td><td class="mono">' + ri50.toLocaleString() + '</td>' +
            '<td class="mono">' + pct + '%</td><td class="mono">+' + maxRI + '</td>' +
            '<td class="mono">' + rw30.toLocaleString() + '</td><td class="mono">' + maxRW + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('ri-stats-table').innerHTML = html;

    // ── RI Frequency Trend: % of episodes exceeding thresholds by 5-yr bins ──
    var BIN_YRS = 5;
    var RI_THRESHOLDS = [
        { val: 30, label: 'RI \u2265 30 kt', color: '#fbbf24' },
        { val: 35, label: 'RI \u2265 35 kt', color: '#f87171' },
        { val: 50, label: 'RI \u2265 50 kt', color: '#dc2626' },
        { val: 65, label: 'RI \u2265 65 kt', color: '#a855f7' }
    ];
    // Collect all [change, year] pairs for active basins (always use full satellite era for trend)
    var allPairs = [];
    basins.forEach(function (basin) {
        var pairs = _riAllPairs(basin);
        for (var i = 0; i < pairs.length; i++) {
            if (pairs[i][1] >= 1966) allPairs.push(pairs[i]); // satellite era only
        }
    });

    // Group by 5-yr bin
    var binMap = {};
    allPairs.forEach(function (p) {
        var yr = p[1];
        var binStart = Math.floor(yr / BIN_YRS) * BIN_YRS;
        if (!binMap[binStart]) binMap[binStart] = { total: 0, pos: 0, ri30: 0, ri35: 0, ri50: 0, ri65: 0 };
        binMap[binStart].total++;
        if (p[0] > 0) binMap[binStart].pos++;
        if (p[0] >= 30) binMap[binStart].ri30++;
        if (p[0] >= 35) binMap[binStart].ri35++;
        if (p[0] >= 50) binMap[binStart].ri50++;
        if (p[0] >= 65) binMap[binStart].ri65++;
    });

    var trendBins = Object.keys(binMap).map(Number).sort(function (a, b) { return a - b; });
    // Drop bins with very few episodes (< 50) as they produce noisy rates
    trendBins = trendBins.filter(function (b) { return binMap[b].total >= 50; });

    var trendTraces = RI_THRESHOLDS.map(function (th) {
        var key = 'ri' + th.val;
        return {
            x: trendBins.map(function (b) { return b + Math.floor(BIN_YRS / 2); }), // bin midpoint
            y: trendBins.map(function (b) { return binMap[b][key] / binMap[b].total * 100; }),
            customdata: trendBins.map(function (b) { return [binMap[b][key], binMap[b].total, b + '–' + (b + BIN_YRS - 1)]; }),
            type: 'scatter', mode: 'lines+markers',
            name: th.label,
            line: { color: th.color, width: 2 },
            marker: { size: 5, color: th.color },
            hovertemplate: '<b>' + th.label + '</b><br>%{customdata[2]}<br>%{y:.1f}% (%{customdata[0]} of %{customdata[1]})<extra></extra>'
        };
    });

    var trendLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: '% of 24-h Episodes Exceeding Threshold', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, rangemode: 'tozero' },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'x unified'
    });
    Plotly.newPlot('ri-trend-chart', trendTraces, trendLayout, PLOTLY_CONFIG);

    // ── Exceedance CDF by Era: overlay curves for different periods ──
    var ERA_DEFS = [
        { label: '1966–1979', range: [1966, 1979], color: '#94a3b8', dash: 'dot' },
        { label: '1980–1994', range: [1980, 1994], color: '#60a5fa', dash: 'dash' },
        { label: '1995–2009', range: [1995, 2009], color: '#34d399', dash: 'dashdot' },
        { label: '2010–2025', range: [2010, 2025], color: '#fbbf24', dash: 'solid' }
    ];

    var eraCdfTraces = [];
    ERA_DEFS.forEach(function (era) {
        // Gather positive (intensification) episodes for this era across active basins
        var eraVals = [];
        basins.forEach(function (basin) {
            var pairs = _riAllPairs(basin);
            for (var i = 0; i < pairs.length; i++) {
                if (pairs[i][1] >= era.range[0] && pairs[i][1] <= era.range[1] && pairs[i][0] > 0) {
                    eraVals.push(pairs[i][0]);
                }
            }
        });
        if (eraVals.length < 20) return; // skip eras with too few samples
        eraVals.sort(function (a, b) { return a - b; });
        var n = eraVals.length;
        eraCdfTraces.push({
            x: eraVals,
            y: eraVals.map(function (_, i) { return 1 - (i / n); }),
            type: 'scatter', mode: 'lines',
            name: era.label + ' (n=' + n.toLocaleString() + ')',
            line: { color: era.color, width: 2.5, dash: era.dash },
            hovertemplate: '<b>' + era.label + '</b><br>%{x} kt/24h: %{y:.1%} exceed<extra></extra>'
        });
    });

    var eraCdfShapes = [
        { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1, dash: 'dash' } },
        { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1, dash: 'dash' } }
    ];

    var eraCdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Intensification Threshold (kt/24h)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 100] },
        yaxis: { title: { text: 'Exceedance Probability', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 0.5] },
        shapes: eraCdfShapes,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('ri-era-cdf-chart', eraCdfTraces, eraCdfLayout, PLOTLY_CONFIG);

    // ── Era comparison stats table ──
    var eraHtml = '<table><thead><tr><th>Era</th><th>Episodes</th><th>Mean \u0394V</th><th>% \u226530</th><th>% \u226535</th><th>% \u226550</th><th>% \u226565</th><th>Max RI</th></tr></thead><tbody>';
    ERA_DEFS.forEach(function (era) {
        var eraVals = [];
        basins.forEach(function (basin) {
            var pairs = _riAllPairs(basin);
            for (var i = 0; i < pairs.length; i++) {
                if (pairs[i][1] >= era.range[0] && pairs[i][1] <= era.range[1]) eraVals.push(pairs[i][0]);
            }
        });
        if (eraVals.length < 20) return;
        var n = eraVals.length;
        var mean = eraVals.reduce(function (a, b) { return a + b; }, 0) / n;
        var ri30 = eraVals.filter(function (v) { return v >= 30; }).length;
        var ri35 = eraVals.filter(function (v) { return v >= 35; }).length;
        var ri50 = eraVals.filter(function (v) { return v >= 50; }).length;
        var ri65 = eraVals.filter(function (v) { return v >= 65; }).length;
        var maxRI = Math.max.apply(null, eraVals);
        eraHtml += '<tr><td style="color:' + era.color + '">' + era.label + '</td>' +
            '<td class="mono">' + n.toLocaleString() + '</td>' +
            '<td class="mono">' + mean.toFixed(1) + '</td>' +
            '<td class="mono">' + (ri30 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">' + (ri35 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">' + (ri50 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">' + (ri65 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">+' + maxRI + '</td></tr>';
    });
    eraHtml += '</tbody></table>';
    document.getElementById('ri-era-stats-table').innerHTML = eraHtml;
}

// ══════════════════════════════════════════════════════════════
//  SEASONAL CYCLE MODAL
// ══════════════════════════════════════════════════════════════

var seasonalModalBasins = ['ALL'];

window.openSeasonalModal = function () {
    document.getElementById('seasonal-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    seasonalModalBasins = ['ALL'];
    _resetBasinChips('seasonal-basin-chips', 'ALL');
    renderSeasonalModalChart();
};
window.closeSeasonalModal = function () {
    document.getElementById('seasonal-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleSeasonalBasin = function (btn) {
    seasonalModalBasins = _toggleBasinChip(btn, 'seasonal-basin-chips');
    renderSeasonalModalChart();
};

function renderSeasonalModalChart() {
    var basins = seasonalModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : seasonalModalBasins;
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Count storms per month per basin (use start_date month)
    // Compute mean storms per month = total / number of years in dataset
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y >= 1950; });
    var nYears = Math.max(1, new Set(years).size);

    var traces = [];
    basins.forEach(function (basin) {
        var monthlyCounts = new Array(12).fill(0);
        allStorms.forEach(function (s) {
            if (s.basin !== basin || !s.start_date || s.year < 1950) return;
            var m = parseInt(s.start_date.substring(5, 7), 10) - 1;
            if (m >= 0 && m < 12) monthlyCounts[m]++;
        });
        var avgPerMonth = monthlyCounts.map(function (c) { return Math.round(c / nYears * 10) / 10; });
        traces.push({
            x: monthNames, y: avgPerMonth, type: 'scatter', mode: 'lines+markers',
            name: BASIN_NAMES[basin],
            line: { color: BASIN_COLORS[basin], width: 2.5 },
            marker: { size: 5, color: BASIN_COLORS[basin] },
            hovertemplate: '<b>' + basin + ' %{x}</b><br>%{y:.1f} storms/yr<extra></extra>'
        });
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { tickfont: { size: 11, color: '#8b9ec2' }, gridcolor: 'rgba(255,255,255,0.04)' },
        yaxis: { title: { text: 'Mean Storms per Month', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.15, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 35, b: 40 }, hovermode: 'x unified'
    });
    Plotly.newPlot('seasonal-chart', traces, layout, PLOTLY_CONFIG);

    // Stats: peak month and season length per basin
    var html = '<table><thead><tr><th>Basin</th><th>Peak Month</th><th>Peak Rate</th><th>Annual Total</th><th>Active Months (>0.5/yr)</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var monthlyCounts = new Array(12).fill(0);
        var totalCount = 0;
        allStorms.forEach(function (s) {
            if (s.basin !== basin || !s.start_date || s.year < 1950) return;
            var m = parseInt(s.start_date.substring(5, 7), 10) - 1;
            if (m >= 0 && m < 12) { monthlyCounts[m]++; totalCount++; }
        });
        var avgPerMonth = monthlyCounts.map(function (c) { return c / nYears; });
        var peakIdx = avgPerMonth.indexOf(Math.max.apply(null, avgPerMonth));
        var activeMonths = avgPerMonth.filter(function (v) { return v >= 0.5; }).length;
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td>' + monthNames[peakIdx] + '</td>' +
            '<td class="mono">' + avgPerMonth[peakIdx].toFixed(1) + '/yr</td>' +
            '<td class="mono">' + (totalCount / nYears).toFixed(1) + '/yr</td>' +
            '<td class="mono">' + activeMonths + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('seasonal-stats-table').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
//  LMI LATITUDE MODAL
// ══════════════════════════════════════════════════════════════

var lmiModalBasins = ['ALL'];
var lmiModalPeriod = 'modern';

// Shared period definitions (same as RI modal)
var LMI_PERIODS = {
    'all':       [0, 9999],
    'satellite': [1966, 9999],
    'modern':    [1980, 9999],
    '30yr':      [1991, 2020],
    'custom':    [1980, 2025]
};

// Helper: filter allStorms by basin + LMI period
function _lmiFilteredStorms(basin) {
    var range = LMI_PERIODS[lmiModalPeriod] || LMI_PERIODS['modern'];
    return allStorms.filter(function (s) {
        return s.basin === basin && s.year >= range[0] && s.year <= range[1];
    });
}

window.openLMILatModal = function () {
    document.getElementById('lmi-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    lmiModalBasins = ['ALL'];
    lmiModalPeriod = 'modern';
    _resetBasinChips('lmi-basin-chips', 'ALL');
    var chips = document.querySelectorAll('#lmi-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-period') === 'modern'); });
    var cr = document.getElementById('lmi-custom-range');
    if (cr) cr.style.display = 'none';
    renderLMIModalCharts();
};
window.closeLMILatModal = function () {
    document.getElementById('lmi-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleLMIBasin = function (btn) {
    lmiModalBasins = _toggleBasinChip(btn, 'lmi-basin-chips');
    renderLMIModalCharts();
};
window.toggleLMIPeriod = function (btn) {
    var chips = document.querySelectorAll('#lmi-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.remove('active'); });
    btn.classList.add('active');
    lmiModalPeriod = btn.getAttribute('data-period');
    var cr = document.getElementById('lmi-custom-range');
    if (cr) cr.style.display = lmiModalPeriod === 'custom' ? 'inline-flex' : 'none';
    if (lmiModalPeriod === 'custom') {
        var y1 = parseInt(document.getElementById('lmi-year-start').value) || 1980;
        var y2 = parseInt(document.getElementById('lmi-year-end').value) || 2025;
        LMI_PERIODS['custom'] = [Math.min(y1, y2), Math.max(y1, y2)];
    }
    renderLMIModalCharts();
};
window.applyLMICustomPeriod = function () {
    var y1 = parseInt(document.getElementById('lmi-year-start').value) || 1980;
    var y2 = parseInt(document.getElementById('lmi-year-end').value) || 2025;
    LMI_PERIODS['custom'] = [Math.min(y1, y2), Math.max(y1, y2)];
    if (lmiModalPeriod === 'custom') renderLMIModalCharts();
};

function renderLMIModalCharts() {
    var basins = lmiModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : lmiModalBasins;

    // Period label
    var range = LMI_PERIODS[lmiModalPeriod] || LMI_PERIODS['modern'];
    var yrMin = range[0] || 1842;
    var yrMax = range[1] < 9000 ? range[1] : 2025;
    var totalStorms = 0;

    // Scatter: LMI latitude vs peak wind
    var scatterTraces = [];
    basins.forEach(function (basin) {
        var storms = _lmiFilteredStorms(basin).filter(function (s) {
            return s.lmi_lat != null && s.peak_wind_kt != null && s.peak_wind_kt > 0;
        });
        if (storms.length === 0) return;
        totalStorms += storms.length;
        scatterTraces.push({
            x: storms.map(function (s) { return s.peak_wind_kt; }),
            y: storms.map(function (s) { return s.lmi_lat; }),
            text: storms.map(function (s) { return (s.name || 'UNNAMED') + ' (' + s.year + ')'; }),
            type: 'scatter', mode: 'markers',
            name: BASIN_NAMES[basin],
            marker: { color: BASIN_COLORS[basin], size: 4, opacity: 0.5 },
            hovertemplate: '<b>%{text}</b><br>%{x} kt, %{y:.1f}\u00B0<extra>' + basin + '</extra>'
        });
    });
    // Update period info in header
    var piEl = document.getElementById('lmi-period-info');
    if (piEl) piEl.textContent = '(' + totalStorms.toLocaleString() + ' storms, ' + yrMin + '–' + yrMax + ')';

    var scatterLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'LMI Latitude (\u00B0)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 35, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('lmi-scatter-chart', scatterTraces, scatterLayout, PLOTLY_CONFIG);

    // Box plots of LMI latitude
    var boxTraces = [];
    basins.forEach(function (basin) {
        var lats = _lmiFilteredStorms(basin)
            .filter(function (s) { return s.lmi_lat != null; })
            .map(function (s) { return s.lmi_lat; });
        if (lats.length === 0) return;
        boxTraces.push({ y: lats, name: basin, type: 'box', marker: { color: BASIN_COLORS[basin] }, boxmean: true });
    });
    var boxLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: 'LMI Latitude (\u00B0)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: false, margin: { l: 55, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('lmi-box-chart', boxTraces, boxLayout, PLOTLY_CONFIG);

    // Stats table
    var html = '<table><thead><tr><th>Basin</th><th>Count</th><th>Mean Lat</th><th>Median Lat</th><th>Min |Lat|</th><th>Max |Lat|</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var lats = _lmiFilteredStorms(basin)
            .filter(function (s) { return s.lmi_lat != null; })
            .map(function (s) { return s.lmi_lat; })
            .sort(function (a, b) { return a - b; });
        if (lats.length === 0) return;
        var absLats = lats.map(function (l) { return Math.abs(l); });
        var mean = lats.reduce(function (a, b) { return a + b; }, 0) / lats.length;
        var med = lats[Math.floor(lats.length * 0.5)];
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td class="mono">' + lats.length.toLocaleString() + '</td><td class="mono">' + mean.toFixed(1) + '\u00B0</td>' +
            '<td class="mono">' + med.toFixed(1) + '\u00B0</td>' +
            '<td class="mono">' + Math.min.apply(null, absLats).toFixed(1) + '\u00B0</td>' +
            '<td class="mono">' + Math.max.apply(null, absLats).toFixed(1) + '\u00B0</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('lmi-stats-table').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
//  BASIN CHIP HELPERS (shared by all modals)
// ══════════════════════════════════════════════════════════════

function _resetBasinChips(containerId, activeBasin) {
    document.querySelectorAll('#' + containerId + ' .basin-chip').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-basin') === activeBasin);
    });
}

function _toggleBasinChip(btn, containerId) {
    var basin = btn.getAttribute('data-basin');
    if (basin === 'ALL') {
        _resetBasinChips(containerId, 'ALL');
        return ['ALL'];
    }
    document.querySelector('#' + containerId + ' .basin-chip[data-basin="ALL"]').classList.remove('active');
    btn.classList.toggle('active');
    var selected = [];
    document.querySelectorAll('#' + containerId + ' .basin-chip.active').forEach(function (c) {
        var b = c.getAttribute('data-basin');
        if (b !== 'ALL') selected.push(b);
    });
    if (selected.length === 0) {
        _resetBasinChips(containerId, 'ALL');
        return ['ALL'];
    }
    return selected;
}

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════

function showToast(message) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.style.display = '';
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
        el.style.display = 'none';
    }, 3000);
}

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function () {
    loadData();

    // Render colorbar canvas from default colormap
    renderColorbarCanvas(irSelectedColormap);

    // Load TC-RADAR lookup (tiny file, ~3KB) for cross-linking
    fetch(TC_RADAR_LOOKUP_JSON).then(function (r) { return r.json(); })
        .then(function (data) { tcRadarLookup = data; })
        .catch(function () { tcRadarLookup = {}; });

    // Warm up the API server on page load — a lightweight health check wakes
    // the Render instance so it's ready when the user selects a storm.
    fetch(API_BASE + '/health', { method: 'GET' }).catch(function () {});

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
        // Escape: close any open modal
        if (e.key === 'Escape') {
            var modals = [
                { id: 'analog-modal', close: closeAnalogFinder },
                { id: 'ace-modal', close: closeACEModal },
                { id: 'intensity-modal', close: closeIntensityModal },
                { id: 'intensity-change-modal', close: closeIntensityChangeModal },
                { id: 'seasonal-modal', close: closeSeasonalModal },
                { id: 'lmi-modal', close: closeLMILatModal }
            ];
            for (var i = 0; i < modals.length; i++) {
                var el = document.getElementById(modals[i].id);
                if (el && el.style.display !== 'none') {
                    modals[i].close();
                    break;
                }
            }
            return;
        }

        // Don't capture arrow/space when typing in inputs
        var tag = (document.activeElement || {}).tagName || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (document.activeElement && document.activeElement.isContentEditable) return;

        var activeTabEl = document.querySelector('.ga-tab.active');
        var tab = activeTabEl ? activeTabEl.getAttribute('data-tab') : 'browser';

        if (tab === 'detail') {
            if (irOverlayVisible && irMeta && irMeta.n_frames) {
                // IR active — arrows step frames, space toggles play
                if (e.key === 'ArrowLeft')  { e.preventDefault(); stepIRFrame(-1); }
                if (e.key === 'ArrowRight') { e.preventDefault(); stepIRFrame(1); }
                if (e.key === ' ')          { e.preventDefault(); toggleIRPlay(); }
            } else if (selectedStorm && filteredStorms.length > 0) {
                // No IR — arrows navigate to prev/next storm in filtered list
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    var idx = -1;
                    for (var si = 0; si < filteredStorms.length; si++) {
                        if (filteredStorms[si].sid === selectedStorm.sid) { idx = si; break; }
                    }
                    if (idx === -1) return;
                    var newIdx = e.key === 'ArrowLeft' ? idx - 1 : idx + 1;
                    if (newIdx >= 0 && newIdx < filteredStorms.length) {
                        selectStorm(filteredStorms[newIdx]);
                        viewStormDetail();
                    }
                }
            }
        } else if (tab === 'compare') {
            if (_cmpIR && (_cmpIR.left.meta || _cmpIR.right.meta)) {
                // Compare IR loaded — arrows step frames (sync handles both sides)
                if (e.key === 'ArrowLeft')  { e.preventDefault(); stepCompareIR('left', -1); }
                if (e.key === 'ArrowRight') { e.preventDefault(); stepCompareIR('left', 1); }
                if (e.key === ' ')          { e.preventDefault(); toggleCompareIRPlay('left'); }
            }
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// ── MICROWAVE SATELLITE OVERLAY (TC-PRIMED) — GLOBAL ARCHIVE ──
// ═══════════════════════════════════════════════════════════════

var _gaMwOverpassData = [];      // all overpasses for current storm
var _gaMwVisible = false;        // MW overlay is shown on the detail map
var _gaMwMapOverlay = null;      // L.imageOverlay for the current MW frame
var _gaMwMarkers = null;         // L.layerGroup of overpass time-markers on track
var _gaMwLastAtcf = null;        // last ATCF ID we fetched for
var _gaMwMarkerDt = null;        // current MW overpass datetime for intensity line

/**
 * Fetch all microwave overpasses for the selected storm's lifecycle.
 * Called from renderStormDetail() when a storm with an ATCF ID is viewed.
 */
function loadGlobalMWOverpasses(storm) {
    var status = document.getElementById('ga-mw-status');
    var sel = document.getElementById('ga-mw-overpass-select');
    if (!sel) return;

    var atcfId = storm.atcf_id;
    if (!atcfId) return;

    // Skip if already loaded for this storm
    if (atcfId === _gaMwLastAtcf && _gaMwOverpassData.length > 0) return;
    _gaMwLastAtcf = atcfId;

    sel.innerHTML = '<option value="">Loading...</option>';
    if (status) status.textContent = 'Searching TC-PRIMED...';

    fetch(API_BASE + '/microwave/storm_overpasses?atcf_id=' + encodeURIComponent(atcfId))
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            _gaMwOverpassData = json.overpasses || [];
            sel.innerHTML = '';

            if (_gaMwOverpassData.length === 0) {
                sel.innerHTML = '<option value="">No overpasses found</option>';
                if (status) status.textContent = 'No TC-PRIMED data';
                return;
            }

            for (var i = 0; i < _gaMwOverpassData.length; i++) {
                var op = _gaMwOverpassData[i];
                var label = op.sensor + ' / ' + op.platform + ' — ' + op.datetime;
                var opt = document.createElement('option');
                opt.value = i;
                opt.textContent = label;
                sel.appendChild(opt);
            }

            if (status) status.textContent = _gaMwOverpassData.length + ' overpass(es)';
        })
        .catch(function (e) {
            sel.innerHTML = '<option value="">Error</option>';
            if (status) status.textContent = 'Error: ' + e.message;
        });
}

/**
 * Toggle the MW overlay layer on the global archive detail map.
 */
window.toggleGlobalMWOverlay = function () {
    var btn = document.getElementById('ga-mw-toggle-btn');
    var controls = document.getElementById('ga-mw-controls');

    if (_gaMwVisible) {
        // Hide
        _gaMwVisible = false;
        if (btn) btn.textContent = '\uD83D\uDCE1 MW';
        if (controls) controls.style.display = 'none';
        if (_gaMwMapOverlay && detailMap) { detailMap.removeLayer(_gaMwMapOverlay); }
        if (_gaMwMarkers && detailMap) { detailMap.removeLayer(_gaMwMarkers); }
        // Remove MW line from intensity chart
        _applyIntensityMarker(_lastMarkerDt);
        return;
    }

    // Show
    _gaMwVisible = true;
    if (btn) btn.textContent = 'Hide MW';
    if (controls) controls.style.display = '';
    _repositionMWControls();

    // If overpasses loaded, show markers on track and auto-load first
    if (_gaMwOverpassData.length > 0) {
        addMWTrackMarkers();
        loadGlobalMWOverpass();
    }
};

/**
 * Reposition the MW controls panel (no-op: controls now in normal flow below map).
 */
function _repositionMWControls() {}

/**
 * Add small markers along the storm track showing overpass times.
 */
function addMWTrackMarkers() {
    if (_gaMwMarkers && detailMap) detailMap.removeLayer(_gaMwMarkers);
    _gaMwMarkers = L.layerGroup();

    // Sensor colour map
    var colors = {
        'GMI': '#00bcd4', 'SSMIS': '#ff7043', 'AMSR2': '#66bb6a',
        'SSMI': '#ab47bc', 'TMI': '#ffa726', 'ATMS': '#42a5f5', 'MHS': '#78909c'
    };

    // We don't have lat/lon for each overpass from the API directly,
    // but we can still render them as a visual indicator if the storm track
    // is available. For now, just skip track markers — the dropdown is the
    // primary navigation interface.
    // Future enhancement: interpolate overpass time to track lat/lon.

    if (detailMap) _gaMwMarkers.addTo(detailMap);
}

/**
 * Load the selected MW overpass image onto the detail map.
 */
window.loadGlobalMWOverpass = function () {
    var sel = document.getElementById('ga-mw-overpass-select');
    var prodSel = document.getElementById('ga-mw-product-select');
    var status = document.getElementById('ga-mw-frame-status');
    if (!sel || sel.value === '') return;

    var idx = parseInt(sel.value, 10);
    var op = _gaMwOverpassData[idx];
    if (!op) return;

    var product = (prodSel && prodSel.value) || '89pct';

    var is37 = (product === '37h' || product === '37v' || product === '37color');
    var is89 = (product === '89pct' || product === '89v' || product === '89h');
    if (is37 && !op.has_37) {
        if (status) status.textContent = op.sensor + ' has no 37 GHz';
        return;
    }
    if (is89 && !op.has_89) {
        if (status) status.textContent = op.sensor + ' has no 89 GHz';
        return;
    }

    if (status) status.textContent = 'Loading ' + product + '...';

    var url = API_BASE + '/microwave/data?s3_key=' + encodeURIComponent(op.s3_key) +
        '&product=' + product;

    // Pass storm center if available from the selected storm
    if (selectedStorm) {
        var lat = selectedStorm.lmi_lat || selectedStorm.genesis_lat || 0;
        var lon = selectedStorm.lmi_lon || selectedStorm.genesis_lon || 0;
        url += '&center_lat=' + lat + '&center_lon=' + lon;
    }

    fetch(url)
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            if (!json.image_b64 || !json.bounds) {
                if (status) status.textContent = 'No data returned';
                return;
            }

            var imgUrl = 'data:image/png;base64,' + json.image_b64;
            var bounds = L.latLngBounds(
                L.latLng(json.bounds[0][0], json.bounds[0][1]),
                L.latLng(json.bounds[1][0], json.bounds[1][1])
            );

            if (_gaMwMapOverlay && detailMap) {
                detailMap.removeLayer(_gaMwMapOverlay);
            }
            _gaMwMapOverlay = L.imageOverlay(imgUrl, bounds, {
                opacity: 0.8, interactive: false, zIndex: 650
            });
            if (_gaMwVisible && detailMap) _gaMwMapOverlay.addTo(detailMap);

            // Re-center map on the MW image so the overpass is visible
            if (detailMap && bounds.isValid()) {
                var mwCenter = bounds.getCenter();
                detailMap.flyTo(mwCenter, detailMap.getZoom(), {
                    animate: true, duration: 0.5
                });
            }

            if (status) status.textContent = json.sensor + ' ' + json.datetime;

            // Update MW marker on intensity chart
            // MW datetime is "YYYY-MM-DD HH:MM UTC" → convert to ISO for Plotly
            if (json.datetime) {
                var mwDt = json.datetime.replace(' UTC', '').replace(' ', 'T') + ':00';
                _gaMwMarkerDt = mwDt;
            }
            _applyIntensityMarker(_lastMarkerDt);
        })
        .catch(function (e) {
            if (status) status.textContent = 'Error: ' + e.message;
        });
};

/**
 * Remove the MW overlay and reset state (called when switching storms).
 */
function removeGlobalMWOverlay() {
    if (_gaMwMapOverlay && detailMap) { detailMap.removeLayer(_gaMwMapOverlay); _gaMwMapOverlay = null; }
    if (_gaMwMarkers && detailMap) { detailMap.removeLayer(_gaMwMarkers); _gaMwMarkers = null; }
    _gaMwOverpassData = [];
    _gaMwVisible = false;
    _gaMwLastAtcf = null;
    _gaMwMarkerDt = null;
    var btn = document.getElementById('ga-mw-toggle-btn');
    if (btn) btn.textContent = '\uD83D\uDCE1 MW';
    var controls = document.getElementById('ga-mw-controls');
    if (controls) controls.style.display = 'none';
}


// ═══════════════════════════════════════════════════════════════
// ── NEXRAD WSR-88D GROUND RADAR OVERLAY ───────────────────────
// ═══════════════════════════════════════════════════════════════

var _gaNexradVisible = false;
var _gaNexradMapOverlay = null;
var _gaNexradData = null;       // raw uint8 hover data
var _gaNexradRows = 0;
var _gaNexradCols = 0;
var _gaNexradVmin = -32;
var _gaNexradVmax = 95;
var _gaNexradBounds = null;     // L.latLngBounds
var _gaNexradUnits = 'dBZ';
var _gaNexradLastStormId = null;
var _gaNexradTooltip = null;
var _gaNexradUpdateTimer = null;
var _gaNexradLastFrameLat = null;
var _gaNexradLastFrameLon = null;

/**
 * Update NEXRAD sites and scans when IR frame position changes.
 * Throttled to avoid excessive API calls during animation.
 */
function _updateNexradForFrame(lat, lon) {
    // Skip if position hasn't changed significantly (>0.5°)
    if (_gaNexradLastFrameLat != null &&
        Math.abs(lat - _gaNexradLastFrameLat) < 0.5 &&
        Math.abs(lon - _gaNexradLastFrameLon) < 0.5) {
        return;
    }
    _gaNexradLastFrameLat = lat;
    _gaNexradLastFrameLon = lon;

    if (_gaNexradUpdateTimer) clearTimeout(_gaNexradUpdateTimer);
    _gaNexradUpdateTimer = setTimeout(function () {
        if (selectedStorm) {
            loadNexradSites(selectedStorm, lat, lon);
        }
    }, 500);
}

/**
 * Check for nearby NEXRAD sites when a storm is selected.
 * Uses the storm's current track position and time.
 */
function loadNexradSites(storm, frameLat, frameLon) {
    var siteSelect = document.getElementById('ga-nexrad-site-select');
    var status = document.getElementById('ga-nexrad-status');
    if (!siteSelect) return;

    // Prefer current IR frame position, fall back to LMI, then genesis
    var lat = frameLat || storm.lmi_lat || storm.genesis_lat;
    var lon = frameLon || storm.lmi_lon || storm.genesis_lon;
    if (!lat || !lon) {
        if (status) status.textContent = 'No position';
        return;
    }

    _gaNexradLastStormId = storm.sid;
    siteSelect.innerHTML = '<option value="">Searching...</option>';
    if (status) status.textContent = '';

    fetch(API_BASE + '/nexrad/sites?lat=' + lat + '&lon=' + lon + '&max_range_km=500')
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            siteSelect.innerHTML = '';
            if (!json.sites || json.sites.length === 0) {
                siteSelect.innerHTML = '<option value="">No nearby radars</option>';
                if (status) status.textContent = 'No 88D coverage';
                return;
            }

            for (var i = 0; i < json.sites.length; i++) {
                var s = json.sites[i];
                var opt = document.createElement('option');
                opt.value = s.site;
                opt.textContent = s.site + ' — ' + s.name + ' (' + s.distance_km + ' km)';
                siteSelect.appendChild(opt);
            }

            if (status) status.textContent = json.sites.length + ' site(s)';

            // Auto-trigger scan search if 88D is visible
            if (_gaNexradVisible) loadNexradScans();
        })
        .catch(function (e) {
            siteSelect.innerHTML = '<option value="">Error</option>';
            if (status) status.textContent = 'Error: ' + e.message;
        });
}

/**
 * Load available scans for the selected site near the current IR frame time.
 */
window.loadNexradScans = function () {
    var siteSelect = document.getElementById('ga-nexrad-site-select');
    var scanSelect = document.getElementById('ga-nexrad-scan-select');
    var status = document.getElementById('ga-nexrad-frame-status');
    if (!siteSelect || !scanSelect || !siteSelect.value) return;

    var site = siteSelect.value;

    // Get the current IR frame time as reference
    var refTime = null;
    // 1. Try IR frame metadata datetime
    var fm = irMeta && irMeta.frames ? irMeta.frames[irFrameIdx] : null;
    if (fm && fm.datetime) {
        // datetime format: "YYYY-MM-DD HH:MM UTC" → convert to ISO
        refTime = fm.datetime.replace(' UTC', '').replace(' ', 'T') + ':00';
    }
    // 2. Fall back to intensity marker datetime
    if (!refTime && typeof _lastMarkerDt !== 'undefined' && _lastMarkerDt) {
        refTime = _lastMarkerDt;
    }
    // 3. Fall back to storm genesis
    if (!refTime && selectedStorm) {
        var y = selectedStorm.year || 2020;
        var m = selectedStorm.month || 1;
        var d = selectedStorm.day || 1;
        refTime = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0') + 'T12:00:00';
    }
    if (!refTime) {
        if (status) status.textContent = 'No reference time';
        return;
    }

    scanSelect.innerHTML = '<option value="">Loading...</option>';
    if (status) status.textContent = 'Searching...';

    fetch(API_BASE + '/nexrad/scans?site=' + site + '&datetime=' + encodeURIComponent(refTime) + '&window_min=90')
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            scanSelect.innerHTML = '';
            if (!json.scans || json.scans.length === 0) {
                scanSelect.innerHTML = '<option value="">No scans found</option>';
                if (status) status.textContent = 'No scans';
                return;
            }

            for (var i = 0; i < json.scans.length; i++) {
                var sc = json.scans[i];
                var opt = document.createElement('option');
                opt.value = sc.s3_key;
                opt.textContent = sc.scan_time + ' (\u0394' + Math.round(sc.delta_sec) + 's)';
                scanSelect.appendChild(opt);
            }

            if (status) status.textContent = json.scans.length + ' scan(s)';

            // Pre-select the closest scan to the requested time
            var ci = json.closest_index || 0;
            if (ci < scanSelect.options.length) scanSelect.selectedIndex = ci;

            // Auto-load closest scan
            loadNexradFrame();
        })
        .catch(function (e) {
            scanSelect.innerHTML = '<option value="">Error</option>';
            if (status) status.textContent = 'Error: ' + e.message;
        });
};

/**
 * Load and display a NEXRAD radar frame on the detail map.
 */
window.loadNexradFrame = function () {
    var scanSelect = document.getElementById('ga-nexrad-scan-select');
    var siteSelect = document.getElementById('ga-nexrad-site-select');
    var prodSelect = document.getElementById('ga-nexrad-product-select');
    var status = document.getElementById('ga-nexrad-frame-status');
    if (!scanSelect || !scanSelect.value || !siteSelect || !siteSelect.value) return;

    var s3Key = scanSelect.value;
    var site = siteSelect.value;
    var product = (prodSelect && prodSelect.value) || 'reflectivity';

    if (status) status.textContent = 'Loading ' + product + '...';

    var url = API_BASE + '/nexrad/frame?site=' + encodeURIComponent(site) +
        '&s3_key=' + encodeURIComponent(s3Key) +
        '&product=' + product;

    fetch(url)
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            if (!json.image || !json.bounds) {
                if (status) status.textContent = 'No data returned';
                return;
            }

            var bounds = L.latLngBounds(
                L.latLng(json.bounds[0][0], json.bounds[0][1]),
                L.latLng(json.bounds[1][0], json.bounds[1][1])
            );

            // Store hover data
            if (json.data) {
                var raw = atob(json.data);
                _gaNexradData = new Uint8Array(raw.length);
                for (var i = 0; i < raw.length; i++) _gaNexradData[i] = raw.charCodeAt(i);
                _gaNexradRows = json.data_rows;
                _gaNexradCols = json.data_cols;
                _gaNexradVmin = json.data_vmin;
                _gaNexradVmax = json.data_vmax;
            }
            _gaNexradBounds = bounds;
            _gaNexradUnits = json.units || 'dBZ';

            // Update overlay
            if (_gaNexradMapOverlay && detailMap) {
                detailMap.removeLayer(_gaNexradMapOverlay);
            }
            _gaNexradMapOverlay = L.imageOverlay(json.image, bounds, {
                opacity: 0.75, interactive: false, zIndex: 640
            });
            if (_gaNexradVisible && detailMap) _gaNexradMapOverlay.addTo(detailMap);

            if (status) status.textContent = json.site + ' ' + json.scan_time + ' — ' + json.label + ' (tilt ' + json.tilt + '\u00B0)';

            // Update colorbar
            _updateGaNexradColorbar(product);
        })
        .catch(function (e) {
            if (status) status.textContent = 'Error: ' + e.message;
        });
};

/**
 * Toggle the NEXRAD overlay on/off.
 */
window.toggleGlobalNexradOverlay = function () {
    var btn = document.getElementById('ga-nexrad-toggle-btn');
    var controls = document.getElementById('ga-nexrad-controls');

    if (_gaNexradVisible) {
        _gaNexradVisible = false;
        if (btn) btn.textContent = '\uD83C\uDF00 88D';
        if (controls) controls.style.display = 'none';
        if (_gaNexradMapOverlay && detailMap) detailMap.removeLayer(_gaNexradMapOverlay);
        return;
    }

    _gaNexradVisible = true;
    if (btn) btn.textContent = 'Hide 88D';
    if (controls) controls.style.display = '';

    // If overlay already loaded, just show it
    if (_gaNexradMapOverlay && detailMap) _gaNexradMapOverlay.addTo(detailMap);

    // Search sites using current IR frame position, with LMI/genesis fallback
    if (selectedStorm) {
        var fm = irMeta && irMeta.frames ? irMeta.frames[irFrameIdx] : null;
        if (fm && fm.lat != null) {
            loadNexradSites(selectedStorm, fm.lat, fm.lon);
        } else {
            loadNexradSites(selectedStorm);
        }
    }

    // Load scans for currently selected site
    var siteSelect = document.getElementById('ga-nexrad-site-select');
    if (siteSelect && siteSelect.value) {
        loadNexradScans();
    }
};

/**
 * Handle hover readout for NEXRAD data.
 * Called from the shared mousemove handler on detailMap.
 */
function _handleNexradMouseMove(e) {
    if (!_gaNexradVisible || !_gaNexradData || !_gaNexradBounds || !detailMap) return null;

    var lat = e.latlng.lat;
    var lng = e.latlng.lng;
    var b = _gaNexradBounds;

    if (lat < b.getSouth() || lat > b.getNorth() ||
        lng < b.getWest() || lng > b.getEast()) {
        return null;
    }

    // Mercator-corrected interpolation (same as IR hover)
    function _latToMercY(d) {
        var r = d * Math.PI / 180;
        return Math.log(Math.tan(Math.PI / 4 + r / 2));
    }
    var mercNorth = _latToMercY(b.getNorth());
    var mercSouth = _latToMercY(b.getSouth());
    var mercLat   = _latToMercY(lat);
    var fracY = (mercNorth - mercLat) / (mercNorth - mercSouth);
    var fracX = (lng - b.getWest()) / (b.getEast() - b.getWest());
    var row = Math.min(Math.floor(fracY * _gaNexradRows), _gaNexradRows - 1);
    var col = Math.min(Math.floor(fracX * _gaNexradCols), _gaNexradCols - 1);

    var rawVal = _gaNexradData[row * _gaNexradCols + col];
    if (rawVal === 0) return null;

    // Decode uint8 → physical value
    var val = _gaNexradVmin + (rawVal - 1) * (_gaNexradVmax - _gaNexradVmin) / 254.0;
    return { value: val.toFixed(1), units: _gaNexradUnits };
}

/**
 * Update the NEXRAD colorbar in the global archive controls.
 */
function _updateGaNexradColorbar(product) {
    var el = document.getElementById('ga-nexrad-colorbar');
    if (!el) return;

    if (product === 'velocity') {
        el.innerHTML =
            '<div style="display:flex;height:8px;border-radius:3px;border:1px solid rgba(255,255,255,0.15);overflow:hidden;">' +
                '<div style="flex:1;background:#0000D0;"></div>' +
                '<div style="flex:1;background:#0050FF;"></div>' +
                '<div style="flex:1;background:#00C8FF;"></div>' +
                '<div style="flex:1;background:#00FF80;"></div>' +
                '<div style="flex:1;background:#80FF00;"></div>' +
                '<div style="flex:1;background:#FFFF00;"></div>' +
                '<div style="flex:1;background:#FF8000;"></div>' +
                '<div style="flex:1;background:#FF0000;"></div>' +
                '<div style="flex:1;background:#C80000;"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;font-size:8px;color:#94a3b8;margin-top:1px;">' +
                '<span>-50 m/s</span><span>0</span><span>+50 m/s</span>' +
            '</div>';
    } else {
        el.innerHTML =
            '<div style="display:flex;height:8px;border-radius:3px;border:1px solid rgba(255,255,255,0.15);overflow:hidden;">' +
                '<div style="flex:1;background:#04E9E7;"></div>' +
                '<div style="flex:1;background:#019FF4;"></div>' +
                '<div style="flex:1;background:#0300F4;"></div>' +
                '<div style="flex:1;background:#02FD02;"></div>' +
                '<div style="flex:1;background:#01C501;"></div>' +
                '<div style="flex:1;background:#008E00;"></div>' +
                '<div style="flex:1;background:#FDF802;"></div>' +
                '<div style="flex:1;background:#E5BC00;"></div>' +
                '<div style="flex:1;background:#FD9500;"></div>' +
                '<div style="flex:1;background:#FD0000;"></div>' +
                '<div style="flex:1;background:#D40000;"></div>' +
                '<div style="flex:1;background:#BC0000;"></div>' +
                '<div style="flex:1;background:#F800FD;"></div>' +
                '<div style="flex:1;background:#9854C6;"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;font-size:8px;color:#94a3b8;margin-top:1px;">' +
                '<span>5 dBZ</span><span>20</span><span>35</span><span>50</span><span>65</span>' +
            '</div>';
    }
}

/**
 * Remove the NEXRAD overlay and reset state.
 */
function removeGlobalNexradOverlay() {
    if (_gaNexradMapOverlay && detailMap) { detailMap.removeLayer(_gaNexradMapOverlay); _gaNexradMapOverlay = null; }
    _gaNexradData = null;
    _gaNexradBounds = null;
    _gaNexradVisible = false;
    _gaNexradLastStormId = null;
    var btn = document.getElementById('ga-nexrad-toggle-btn');
    if (btn) btn.textContent = '\uD83C\uDF00 88D';
    var controls = document.getElementById('ga-nexrad-controls');
    if (controls) controls.style.display = 'none';
    var siteSelect = document.getElementById('ga-nexrad-site-select');
    if (siteSelect) siteSelect.innerHTML = '';
    var scanSelect = document.getElementById('ga-nexrad-scan-select');
    if (scanSelect) scanSelect.innerHTML = '';
}


// ═══════════════════════════════════════════════════════════════
// ── MODEL FORECAST OVERLAY (ATCF A-DECK) ──────────────────────
// ═══════════════════════════════════════════════════════════════

var _modelData = null;           // Full a-deck response from API
var _modelVisible = false;       // Overlay is active
var _modelAutoSync = true;       // Auto-switch cycle based on IR frame time
var _modelShowIntensity = true;   // Show intensity forecasts on chart (on by default)
var _modelActiveCycle = null;    // Currently displayed init time (YYYYMMDDHH)
var _modelTrackLayers = [];      // Leaflet polylines on map
var _modelMarkerLayers = [];     // Leaflet circle markers for forecast points
var _modelLegendModels = [];     // Models visible in current cycle
var _modelLastAtcf = null;       // Last ATCF ID loaded
var _modelTypeFilters = { official: true, dynamical: true, ai: true, consensus: true, statistical: false };
var _modelShowInterp = false;    // false = show all models (default), true = interpolated/late-cycle only
var _modelIntensityTraces = [];  // Plotly trace indices for intensity chart

// Color map for models (sent from API, but also define fallbacks)
var MODEL_COLORS = {
    'OFCL': '#ff4757', 'JTWC': '#ffa502',
    'AVNO': '#ff6b6b', 'AVNI': '#ff6b6b', 'GFSO': '#ff6b6b',
    'EMX':  '#4ecdc4', 'EMXI': '#4ecdc4', 'EEMN': '#45b7aa',
    'CMC':  '#ffe66d', 'CMCI': '#ffe66d',
    'UKM':  '#a29bfe', 'UKMI': '#a29bfe',
    'NVGM': '#6c5ce7', 'NGMI': '#6c5ce7',
    'HWRF': '#00b894', 'HWFI': '#00b894',
    'HMON': '#e17055', 'HMNI': '#e17055',
    'HAFS': '#00cec9', 'HAFA': '#00cec9', 'HAFB': '#81ecec',
    'HFSA': '#00cec9', 'HFAI': '#00cec9', 'HFSB': '#81ecec', 'HFBI': '#81ecec',
    'CTCX': '#fab1a0', 'COTC': '#fab1a0', 'COTI': '#fab1a0',
    'GFDN': '#e17055', 'GFNI': '#e17055',
    'AVNX': '#ff6b6b', 'NGX': '#6c5ce7',
    'AEMN': '#ff8a80', 'NEMN': '#b388ff', 'CEMN': '#fff176',
    'CHIP': '#ce93d8',
    'GENI': '#00ff87', 'GEN2': '#00ff87',
    'GRPH': '#00e676', 'GRPI': '#00e676', 'GRP2': '#00e676',
    'APTS': '#76ff03', 'PTSI': '#76ff03',
    'AIFS': '#69f0ae', 'AIFI': '#69f0ae',
    'SHIP': '#ffeaa7', 'DSHP': '#fdcb6e', 'LGEM': '#e2b04a',
    'TVCN': '#ffffff', 'TVCA': '#ffffff', 'TVCE': '#f0f0f0', 'TVCX': '#e0e0e0',
    'IVCN': '#dfe6e9', 'ICON': '#c8d6e5', 'FSSE': '#74b9ff',
    'GUNA': '#b2bec3', 'CGUN': '#636e72'
};

/**
 * Load model forecast data when a storm is selected.
 * Called from renderStormDetail() alongside loadGlobalMWOverpasses().
 */
function loadModelForecasts(storm) {
    var toggleWrap = document.getElementById('ga-models-toggle-wrap');
    var statusEl = document.getElementById('ga-models-status');

    var atcfId = storm.atcf_id;
    if (!atcfId) {
        if (toggleWrap) toggleWrap.style.display = 'none';
        return;
    }
    if (toggleWrap) toggleWrap.style.display = '';

    // Skip if already loaded for this storm
    if (atcfId === _modelLastAtcf && _modelData) return;
    _modelLastAtcf = atcfId;
    _modelData = null;

    if (statusEl) statusEl.textContent = 'Loading...';

    fetch(API_BASE + '/global/adeck?atcf_id=' + encodeURIComponent(atcfId))
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            _modelData = json;

            // Populate cycle dropdown
            var sel = document.getElementById('model-cycle-select');
            if (sel) {
                sel.innerHTML = '';
                var inits = json.init_times || [];
                for (var i = 0; i < inits.length; i++) {
                    var dt = inits[i];
                    var opt = document.createElement('option');
                    opt.value = dt;
                    // Format YYYYMMDDHH → "YYYY-MM-DD HH UTC"
                    opt.textContent = dt.substring(0,4) + '-' + dt.substring(4,6) + '-' +
                        dt.substring(6,8) + ' ' + dt.substring(8,10) + ' UTC';
                    sel.appendChild(opt);
                }
            }

            if (statusEl) statusEl.textContent = json.n_cycles + ' cycles, ' + json.models.length + ' models';

            // Check if this storm has any interpolated models.
            // Pre-~2000 storms only have non-interpolated tech IDs (AVNO, EMX, etc.)
            // so the "Late Cycle" filter would hide everything. Auto-detect and adjust.
            var hasInterp = false;
            var cycles = json.cycles || {};
            var cKeys = Object.keys(cycles);
            for (var ci = 0; ci < cKeys.length && !hasInterp; ci++) {
                var cyc = cycles[cKeys[ci]];
                var tKeys = Object.keys(cyc);
                for (var tj = 0; tj < tKeys.length; tj++) {
                    if (cyc[tKeys[tj]].interp === true) { hasInterp = true; break; }
                }
            }

            var interpBtn = document.getElementById('model-interp-btn');
            // Default: show all models. Button lets user filter to late-cycle only.
            _modelShowInterp = false;
            if (!hasInterp) {
                // No interpolated models (legacy storm) — disable the button
                if (interpBtn) {
                    interpBtn.textContent = 'Late Cycle';
                    interpBtn.title = 'No interpolated models available for this storm era.';
                    interpBtn.style.color = '';
                    interpBtn.style.borderColor = '';
                    interpBtn.style.background = '';
                    interpBtn.disabled = true;
                    interpBtn.style.opacity = '0.4';
                }
            } else {
                // Has interpolated models — enable the late-cycle filter button
                if (interpBtn) {
                    interpBtn.textContent = 'Late Cycle';
                    interpBtn.title = 'Click to show only interpolated (late cycle) models — NHC verification standard.';
                    interpBtn.style.color = '';
                    interpBtn.style.borderColor = '';
                    interpBtn.style.background = '';
                    interpBtn.disabled = false;
                    interpBtn.style.opacity = '';
                }
            }

            // If overlay is active, render current cycle
            if (_modelVisible) {
                _syncModelCycleToIR();
            }
        })
        .catch(function (e) {
            if (statusEl) statusEl.textContent = 'Unavailable';
            console.warn('A-deck load failed', e);
        });
}

/**
 * Toggle the model forecast overlay on/off.
 */
window.toggleModelOverlay = function () {
    var btn = document.getElementById('ga-models-toggle-btn');
    var controls = document.getElementById('ga-model-controls');
    var chartControls = document.getElementById('model-chart-controls');

    if (_modelVisible) {
        _modelVisible = false;
        if (btn) btn.textContent = '\uD83C\uDF10 Models';
        if (controls) controls.style.display = 'none';
        if (chartControls) chartControls.style.display = 'none';
        _clearModelLayers();
        _clearModelIntensityTraces();
        return;
    }

    _modelVisible = true;
    if (btn) btn.textContent = 'Hide Models';
    if (controls) controls.style.display = '';
    if (chartControls) chartControls.style.display = '';

    // Update intensity buttons to reflect current state
    var intBtnStyle = _modelShowIntensity ? 'rgba(116,185,255,0.2)' : '';
    var intBtn = document.getElementById('model-intensity-btn');
    var intBtn2 = document.getElementById('model-intensity-btn2');
    if (intBtn) intBtn.style.background = intBtnStyle;
    if (intBtn2) intBtn2.style.background = intBtnStyle;

    if (_modelData) {
        _syncModelCycleToIR();
    }
};

/**
 * Toggle auto-sync of model cycle to IR frame time.
 */
window.toggleModelAutoSync = function () {
    _modelAutoSync = document.getElementById('model-auto-sync').checked;
    if (_modelAutoSync && _modelVisible) {
        _syncModelCycleToIR();
    }
};

/**
 * Immediately sync the model forecast cycle to the current IR frame time.
 * Also enables auto-sync and, if IR isn't active yet, turns it on.
 */
window.syncModelsToIRNow = function () {
    // If IR overlay isn't active but data is loaded, activate it first
    if (irMeta && !irOverlayVisible) {
        if (typeof toggleIROverlay === 'function') toggleIROverlay();
    }

    // Enable auto-sync
    _modelAutoSync = true;
    var syncCheck = document.getElementById('model-auto-sync');
    if (syncCheck) syncCheck.checked = true;

    // Force immediate sync
    if (_modelVisible && _modelData) {
        _modelActiveCycle = null; // Reset so it forces a re-render
        _syncModelCycleToIR();
    }

    // Flash the button to give visual feedback
    var btn = document.getElementById('model-sync-ir-btn');
    if (btn) {
        btn.style.background = 'rgba(251,191,36,0.3)';
        setTimeout(function () { btn.style.background = ''; }, 400);
    }
};

/**
 * Toggle a model type filter (official, dynamical, ai, consensus, statistical).
 */
window.toggleModelTypeFilter = function (mtype) {
    _modelTypeFilters[mtype] = !_modelTypeFilters[mtype];

    // Inline style definitions for specially-colored filter buttons
    var _filterBtnStyles = {
        official: { color: '#ff4757', border: 'rgba(255,71,87,0.4)', bg: 'rgba(255,71,87,0.15)' },
        ai:       { color: '#00ff87', border: 'rgba(0,255,135,0.4)', bg: 'rgba(0,255,135,0.15)' }
    };

    // Update button active state — handle inline-styled buttons properly
    document.querySelectorAll('.model-filter-btn').forEach(function (btn) {
        var t = btn.getAttribute('data-mtype');
        var isActive = _modelTypeFilters[t];
        btn.classList.toggle('active', isActive);

        // For buttons with custom color styling, toggle inline styles on/off
        var styles = _filterBtnStyles[t];
        if (styles) {
            if (isActive) {
                btn.style.color = styles.color;
                btn.style.borderColor = styles.border;
                btn.style.background = styles.bg;
            } else {
                btn.style.color = '';
                btn.style.borderColor = '';
                btn.style.background = '';
            }
        }
    });

    // Re-render map tracks AND intensity traces
    if (_modelVisible && _modelActiveCycle) {
        _renderModelCycle(_modelActiveCycle);
        if (_modelShowIntensity) {
            _renderModelIntensityTraces(_modelActiveCycle);
        }
    }
};

/**
 * Toggle interpolated-only vs all models.
 * When "Late Cycle" (interpolated) is active, only models corrected to the
 * observed storm position are shown — matching NHC's verification standard.
 * When toggled off, all models including raw/early-cycle output are shown.
 */
window.toggleModelInterp = function () {
    _modelShowInterp = !_modelShowInterp;

    // Update button visual state
    var btn = document.getElementById('model-interp-btn');
    if (btn) {
        if (_modelShowInterp) {
            // Filter is ON — only late-cycle/interpolated models shown
            btn.textContent = 'Late Cycle';
            btn.title = 'Filtering to late-cycle (interpolated) models only. Click to show all.';
            btn.style.color = '#fbbf24';
            btn.style.borderColor = 'rgba(251,191,36,0.4)';
            btn.style.background = 'rgba(251,191,36,0.15)';
        } else {
            // Filter is OFF — all models shown (default)
            btn.textContent = 'Late Cycle';
            btn.title = 'Click to show only late-cycle (interpolated) models — NHC verification standard.';
            btn.style.color = '';
            btn.style.borderColor = '';
            btn.style.background = '';
        }
    }

    // Re-render
    if (_modelVisible && _modelActiveCycle) {
        _renderModelCycle(_modelActiveCycle);
        if (_modelShowIntensity) {
            _renderModelIntensityTraces(_modelActiveCycle);
        }
    }
};

/**
 * Toggle intensity forecast traces on the intensity chart.
 */
window.toggleModelIntensity = function () {
    _modelShowIntensity = !_modelShowIntensity;
    var style = _modelShowIntensity ? 'rgba(116,185,255,0.2)' : '';
    var btn = document.getElementById('model-intensity-btn');
    var btn2 = document.getElementById('model-intensity-btn2');
    if (btn) btn.style.background = style;
    if (btn2) btn2.style.background = style;

    if (_modelShowIntensity && _modelActiveCycle) {
        _renderModelIntensityTraces(_modelActiveCycle);
    } else {
        _clearModelIntensityTraces();
    }
};

/**
 * Manually select a forecast cycle from the dropdown.
 */
window.selectModelCycle = function (initTime) {
    _modelAutoSync = false;
    document.getElementById('model-auto-sync').checked = false;
    _renderModelCycle(initTime);
    if (_modelShowIntensity) {
        _renderModelIntensityTraces(initTime);
    }
};

/**
 * Find the most recent init cycle at or before the current IR frame time.
 */
function _syncModelCycleToIR() {
    if (!_modelData || !_modelData.init_times || !_modelData.init_times.length) return;

    // Get current IR datetime
    var irDtStr = null;
    if (irMeta && irMeta.frames && irMeta.frames[irFrameIdx]) {
        irDtStr = irMeta.frames[irFrameIdx].datetime;
    }

    var inits = _modelData.init_times;
    var bestInit = inits[0]; // default to first

    if (irDtStr) {
        // Convert IR datetime to YYYYMMDDHH format for comparison
        // IR datetimes are like "2017-09-05T12:00:00" or "12 UTC 5 Sep 2017"
        var irDate = new Date(irDtStr);
        if (!isNaN(irDate.getTime())) {
            var irYMDH = irDate.getUTCFullYear().toString() +
                ('0' + (irDate.getUTCMonth() + 1)).slice(-2) +
                ('0' + irDate.getUTCDate()).slice(-2) +
                ('0' + irDate.getUTCHours()).slice(-2);

            // Find most recent init time <= current IR time
            for (var i = inits.length - 1; i >= 0; i--) {
                if (inits[i] <= irYMDH) {
                    bestInit = inits[i];
                    break;
                }
            }
        }
    }

    // Skip re-render if cycle hasn't changed
    if (bestInit === _modelActiveCycle) return;

    // Update dropdown
    var sel = document.getElementById('model-cycle-select');
    if (sel) sel.value = bestInit;

    _renderModelCycle(bestInit);
    if (_modelShowIntensity) {
        _renderModelIntensityTraces(bestInit);
    }
}

/**
 * Render forecast tracks for a given init cycle on the detail map.
 */
function _renderModelCycle(initTime) {
    _modelActiveCycle = initTime;
    _clearModelLayers();

    if (!_modelData || !_modelData.cycles || !_modelData.cycles[initTime]) return;
    if (!detailMap) return;

    var cycle = _modelData.cycles[initTime];
    var legendHtml = '';
    var _legendSeen = {};
    _modelLegendModels = [];

    // Convert initTime to Date for forecast hour → datetime conversion
    var initDate = new Date(
        parseInt(initTime.substring(0,4)),
        parseInt(initTime.substring(4,6)) - 1,
        parseInt(initTime.substring(6,8)),
        parseInt(initTime.substring(8,10))
    );

    var techKeys = Object.keys(cycle).sort();

    for (var ti = 0; ti < techKeys.length; ti++) {
        var tech = techKeys[ti];
        var forecast = cycle[tech];

        // Apply type filters
        if (!_modelTypeFilters[forecast.type]) continue;
        // Apply interpolation filter (skip non-interpolated when _modelShowInterp is true)
        if (_modelShowInterp && forecast.interp === false) continue;

        var points = forecast.points;
        if (!points || points.length < 2) continue;

        var color = forecast.color || MODEL_COLORS[tech] || '#888';
        var isOfficial = forecast.type === 'official';
        var isConsensus = forecast.type === 'consensus';
        var weight = isOfficial ? 3.5 : (isConsensus ? 2.5 : 1.5);
        var opacity = isOfficial ? 1.0 : (isConsensus ? 0.9 : 0.6);
        var dashArray = (isOfficial || isConsensus) ? null : '4,3';

        // Build polyline from forecast points
        var latlngs = [];
        for (var pi = 0; pi < points.length; pi++) {
            latlngs.push([points[pi].lat, points[pi].lon]);
        }

        var line = L.polyline(latlngs, {
            color: color,
            weight: weight,
            opacity: opacity,
            dashArray: dashArray,
            interactive: false,
            className: 'model-forecast-track'
        }).addTo(detailMap);
        _modelTrackLayers.push(line);

        // Add markers at tau-0 (init) and every 24h
        for (var mi = 0; mi < points.length; mi++) {
            var pt = points[mi];
            var isTau0 = (pt.tau === 0);
            var is24h = (pt.tau > 0 && pt.tau % 24 === 0);

            if (isTau0 || is24h) {
                var mRadius = isOfficial ? (isTau0 ? 5 : 4) : (isTau0 ? 3.5 : 2.5);
                var mWeight = isOfficial ? 2 : (isTau0 ? 1.5 : 1);
                var marker = L.circleMarker([pt.lat, pt.lon], {
                    radius: mRadius,
                    color: isTau0 ? '#fff' : color,
                    fillColor: color,
                    fillOpacity: isTau0 ? 1.0 : 0.7,
                    weight: mWeight,
                    opacity: 0.8,
                    interactive: true
                }).addTo(detailMap);

                // Tooltip with tau info
                var tauLabel = isTau0 ? forecast.name + ' init' : forecast.name + ' +' + pt.tau + 'h';
                if (pt.wind) tauLabel += ' · ' + pt.wind + ' kt';
                marker.bindTooltip(tauLabel, { direction: 'top', offset: [0, -6] });

                _modelMarkerLayers.push(marker);
            }
        }

        // Build legend entry — deduplicate by display name + color
        var legendKey = forecast.name + '|' + color;
        _modelLegendModels.push(tech);
        if (!_legendSeen[legendKey]) {
            _legendSeen[legendKey] = true;
            legendHtml += '<span class="model-legend-item" style="color:' + color + ';">' +
                '<span class="model-legend-swatch" style="background:' + color + ';"></span>' +
                forecast.name + '</span>';
        }
    }

    // Update legend
    var legendEl = document.getElementById('model-legend');
    if (legendEl) legendEl.innerHTML = legendHtml;
}

/**
 * Render model intensity forecast traces on the Plotly intensity chart.
 */
function _renderModelIntensityTraces(initTime) {
    _clearModelIntensityTraces();

    if (!_modelData || !_modelData.cycles || !_modelData.cycles[initTime]) return;

    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || !chartEl.data) return;

    var cycle = _modelData.cycles[initTime];
    var initDate = new Date(
        parseInt(initTime.substring(0,4)),
        parseInt(initTime.substring(4,6)) - 1,
        parseInt(initTime.substring(6,8)),
        parseInt(initTime.substring(8,10))
    );

    var newTraces = [];
    var techKeys = Object.keys(cycle).sort();

    for (var ti = 0; ti < techKeys.length; ti++) {
        var tech = techKeys[ti];
        var forecast = cycle[tech];
        if (!_modelTypeFilters[forecast.type]) continue;
        if (_modelShowInterp && forecast.interp === false) continue;

        var points = forecast.points;
        if (!points || points.length < 2) continue;

        // Only add intensity traces for models that have wind data
        var times = [];
        var winds = [];
        var hasWind = false;
        for (var pi = 0; pi < points.length; pi++) {
            if (points[pi].wind != null) {
                var fDate = new Date(initDate.getTime() + points[pi].tau * 3600000);
                times.push(fDate.toISOString());
                winds.push(points[pi].wind);
                hasWind = true;
            }
        }

        if (!hasWind || winds.length < 2) continue;

        var color = forecast.color || MODEL_COLORS[tech] || '#888';
        var isOfficial = forecast.type === 'official';
        var isConsensus = forecast.type === 'consensus';
        newTraces.push({
            x: times,
            y: winds,
            type: 'scatter',
            mode: isOfficial ? 'lines+markers' : 'lines',
            name: forecast.name,
            line: {
                color: color,
                width: isOfficial ? 3 : (isConsensus ? 2.5 : 1.5),
                dash: 'solid'
            },
            marker: isOfficial ? { size: 5, symbol: 'diamond', color: color } : undefined,
            opacity: isOfficial ? 1.0 : (isConsensus ? 0.85 : 0.65),
            showlegend: false,
            hovertemplate: forecast.name + ': %{y} kt<extra></extra>'
        });
    }

    if (newTraces.length > 0 && typeof Plotly !== 'undefined') {
        Plotly.addTraces(chartEl, newTraces);
        _modelIntensityTraces = [];
        var baseCount = chartEl.data.length - newTraces.length;
        for (var i = 0; i < newTraces.length; i++) {
            _modelIntensityTraces.push(baseCount + i);
        }
    }
}

/**
 * Remove all model forecast layers from the map.
 */
function _clearModelLayers() {
    for (var i = 0; i < _modelTrackLayers.length; i++) {
        if (detailMap) try { detailMap.removeLayer(_modelTrackLayers[i]); } catch (e) {}
    }
    _modelTrackLayers = [];
    for (var j = 0; j < _modelMarkerLayers.length; j++) {
        if (detailMap) try { detailMap.removeLayer(_modelMarkerLayers[j]); } catch (e) {}
    }
    _modelMarkerLayers = [];
}

/**
 * Remove model intensity traces from the Plotly chart.
 */
function _clearModelIntensityTraces() {
    if (_modelIntensityTraces.length === 0) return;
    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || typeof Plotly === 'undefined') return;

    try {
        // Delete traces in reverse order to preserve indices
        var sorted = _modelIntensityTraces.slice().sort(function (a, b) { return b - a; });
        Plotly.deleteTraces(chartEl, sorted);
    } catch (e) {
        console.warn('Failed to remove model intensity traces', e);
    }
    _modelIntensityTraces = [];
}

/**
 * Remove all model overlay state (called when switching storms).
 */
function removeModelOverlay() {
    _clearModelLayers();
    _clearModelIntensityTraces();
    _modelData = null;
    _modelActiveCycle = null;
    _modelLastAtcf = null;
    _modelVisible = false;
    var btn = document.getElementById('ga-models-toggle-btn');
    if (btn) btn.textContent = '\uD83C\uDF10 Models';
    var controls = document.getElementById('ga-model-controls');
    if (controls) controls.style.display = 'none';
    var chartControls = document.getElementById('model-chart-controls');
    if (chartControls) chartControls.style.display = 'none';
    var toggleWrap = document.getElementById('ga-models-toggle-wrap');
    if (toggleWrap) toggleWrap.style.display = 'none';
}


// ═══════════════════════════════════════════════════════════════
// ── ANIMATED GIF EXPORT (with settings panel) ─────────────────
// ═══════════════════════════════════════════════════════════════

var _gifExporter = null;
var _gifCancelled = false;

/**
 * Open the GIF settings panel (called by the GIF button).
 */
window.openGifSettings = function () {
    if (!irMeta || !selectedStorm) {
        showToast('Load IR imagery first');
        return;
    }

    var totalFrames = irMeta.n_frames;
    var cachedCount = 0;
    for (var i = 0; i < totalFrames; i++) {
        if (irFrames[i]) cachedCount++;
    }
    if (cachedCount < 3) {
        showToast('Play the IR loop first to cache frames (' + cachedCount + '/' + totalFrames + ' loaded)');
        return;
    }

    // Set up range sliders
    var startSlider = document.getElementById('gif-range-start');
    var endSlider = document.getElementById('gif-range-end');
    if (startSlider) { startSlider.max = totalFrames - 1; startSlider.value = 0; }
    if (endSlider) { endSlider.max = totalFrames - 1; endSlider.value = totalFrames - 1; }

    updateGifRangeUI();
    _updateGifEstimate();

    // Pre-load coastline GeoJSON if not already cached
    if (!_coastlineGeoJSON && !_coastlineLoading) {
        _coastlineLoading = true;
        fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_coastline.geojson')
            .then(function (r) { return r.json(); })
            .then(function (geojson) { _coastlineGeoJSON = geojson; })
            .catch(function (e) { console.warn('Coastline pre-load failed:', e); })
            .finally(function () { _coastlineLoading = false; });
    }

    // Enable/disable model checkbox based on whether model data is loaded
    var modelCb = document.getElementById('gif-show-models');
    if (modelCb) {
        if (_modelData && _modelData.cycles) {
            modelCb.disabled = false;
            modelCb.parentElement.style.opacity = '';
        } else {
            modelCb.disabled = true;
            modelCb.checked = false;
            modelCb.parentElement.style.opacity = '0.4';
        }
    }

    var overlay = document.getElementById('gif-settings-overlay');
    if (overlay) overlay.style.display = 'flex';
};

window.closeGifSettings = function () {
    var overlay = document.getElementById('gif-settings-overlay');
    if (overlay) overlay.style.display = 'none';
};

/**
 * Show/hide the custom range sliders based on mode selection.
 */
window.updateGifRangeUI = function () {
    var mode = document.getElementById('gif-range-mode').value;
    var customRow = document.getElementById('gif-custom-range');
    if (customRow) customRow.style.display = (mode === 'custom') ? 'flex' : 'none';
    updateGifRangeLabels();
    _updateGifEstimate();
};

window.updateGifRangeLabels = function () {
    var startSlider = document.getElementById('gif-range-start');
    var endSlider = document.getElementById('gif-range-end');
    var startLbl = document.getElementById('gif-range-start-lbl');
    var endLbl = document.getElementById('gif-range-end-lbl');
    if (startSlider && endSlider) {
        // Ensure start <= end
        if (parseInt(startSlider.value) > parseInt(endSlider.value)) {
            startSlider.value = endSlider.value;
        }
    }
    if (startLbl && startSlider) startLbl.textContent = parseInt(startSlider.value) + 1;
    if (endLbl && endSlider) endLbl.textContent = parseInt(endSlider.value) + 1;
    _updateGifEstimate();
};

/**
 * Compute the frame range based on current settings.
 * Returns { startIdx, endIdx } (inclusive).
 */
function _getGifFrameRange() {
    var mode = document.getElementById('gif-range-mode').value;
    var totalFrames = irMeta ? irMeta.n_frames : 0;

    if (mode === 'custom') {
        var s = parseInt(document.getElementById('gif-range-start').value) || 0;
        var e = parseInt(document.getElementById('gif-range-end').value) || (totalFrames - 1);
        return { startIdx: Math.max(0, s), endIdx: Math.min(totalFrames - 1, e) };
    }

    if (mode === 'full') {
        return { startIdx: 0, endIdx: totalFrames - 1 };
    }

    // Peak ± Nh modes
    var hours = 24;
    if (mode === 'peak12') hours = 12;
    else if (mode === 'peak24') hours = 24;
    else if (mode === 'peak48') hours = 48;

    // Find peak frame
    var track = selectedStorm ? (allTracks[selectedStorm.sid] || []) : [];
    var peakTime = null;
    var peakWind = -1;
    for (var t = 0; t < track.length; t++) {
        if (track[t].w != null && track[t].w > peakWind) {
            peakWind = track[t].w;
            peakTime = track[t].t;
        }
    }

    if (!peakTime || !irMeta.frames) {
        return { startIdx: 0, endIdx: totalFrames - 1 };
    }

    var peakMs = new Date(peakTime).getTime();
    var windowMs = hours * 3600000;
    var startIdx = 0, endIdx = totalFrames - 1;

    for (var i = 0; i < totalFrames; i++) {
        if (!irMeta.frames[i] || !irMeta.frames[i].datetime) continue;
        var fMs = new Date(irMeta.frames[i].datetime).getTime();
        if (fMs >= peakMs - windowMs) { startIdx = i; break; }
    }
    for (var j = totalFrames - 1; j >= 0; j--) {
        if (!irMeta.frames[j] || !irMeta.frames[j].datetime) continue;
        var fMs2 = new Date(irMeta.frames[j].datetime).getTime();
        if (fMs2 <= peakMs + windowMs) { endIdx = j; break; }
    }

    return { startIdx: startIdx, endIdx: endIdx };
}

function _updateGifEstimate() {
    var el = document.getElementById('gif-frame-estimate');
    if (!el || !irMeta) return;

    var range = _getGifFrameRange();
    var skip = parseInt(document.getElementById('gif-frame-skip').value) || 1;

    // Count cached frames in range after skipping
    var count = 0;
    for (var i = range.startIdx; i <= range.endIdx; i += skip) {
        if (irFrames[i]) count++;
    }

    var speed = parseInt(document.getElementById('gif-speed-setting').value) || 200;
    var duration = (count * speed / 1000).toFixed(1);

    el.textContent = count + ' frames · ~' + duration + 's duration';
}

// Wire up estimate updates on skip/speed change
document.addEventListener('change', function (e) {
    if (e.target.id === 'gif-frame-skip' || e.target.id === 'gif-speed-setting' ||
        e.target.id === 'gif-show-intensity' || e.target.id === 'gif-range-mode') {
        _updateGifEstimate();
    }
});

/**
 * Fetch gif.js worker as a blob URL to avoid CORS issues.
 */
function _createGifEncoder(cb) {
    if (window._gifWorkerBlobUrl) { cb(window._gifWorkerBlobUrl); return; }
    fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js')
        .then(function (r) { return r.text(); })
        .then(function (src) {
            var blob = new Blob([src], { type: 'application/javascript' });
            window._gifWorkerBlobUrl = URL.createObjectURL(blob);
            cb(window._gifWorkerBlobUrl);
        })
        .catch(function (e) {
            console.warn('Failed to fetch gif worker, using CDN fallback', e);
            cb('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
        });
}

/**
 * Start the actual GIF export using the current settings.
 */
window.startGifExport = function () {
    if (!irMeta || !selectedStorm || typeof GIF === 'undefined') return;

    // Read settings
    var range = _getGifFrameRange();
    var skip = parseInt(document.getElementById('gif-frame-skip').value) || 1;
    var delay = parseInt(document.getElementById('gif-speed-setting').value) || 200;
    var showIntensity = document.getElementById('gif-show-intensity').checked;
    var showCoastlines = document.getElementById('gif-show-coastlines').checked;
    var showModels = document.getElementById('gif-show-models').checked;

    // Close settings, show progress
    closeGifSettings();
    _gifCancelled = false;

    var overlay = document.getElementById('gif-export-overlay');
    var progressText = document.getElementById('gif-progress-text');
    var progressBar = document.getElementById('gif-progress-bar');
    if (overlay) overlay.style.display = 'flex';
    if (progressText) progressText.textContent = 'Preparing...';
    if (progressBar) progressBar.style.width = '0%';

    var gifBtn = document.getElementById('ir-gif-btn');
    if (gifBtn) { gifBtn.disabled = true; gifBtn.style.opacity = '0.4'; }

    // Build list of frame indices to export
    var frameIndices = [];
    for (var i = range.startIdx; i <= range.endIdx; i += skip) {
        if (irFrames[i]) frameIndices.push(i);
    }
    if (frameIndices.length === 0) { _gifCleanup(); showToast('No cached frames in range'); return; }

    // Determine output dimensions
    var sampleFrame = irFrames[frameIndices[0]];
    var irCols = sampleFrame.tb_cols || 200;
    var irRows = sampleFrame.tb_rows || 200;
    var scale = Math.max(1, Math.floor(480 / Math.max(irCols, irRows)));
    var irImageH = irRows * scale;
    var outW = irCols * scale;

    // Layout: 24px header + IR image + optional intensity chart (60px) + 24px footer
    var intensityH = showIntensity ? 60 : 0;
    var outH = 24 + irImageH + intensityH + 24;

    // Pre-build intensity data for chart if needed
    var track = (selectedStorm ? (allTracks[selectedStorm.sid] || []) : []);
    var intensityPts = []; // { frac: 0-1 position in our frame list, w: wind, p: pressure }
    if (showIntensity && track.length > 0) {
        // Get time range for normalization
        var firstDt = irMeta.frames[frameIndices[0]] ? irMeta.frames[frameIndices[0]].datetime : null;
        var lastDt = irMeta.frames[frameIndices[frameIndices.length - 1]] ? irMeta.frames[frameIndices[frameIndices.length - 1]].datetime : null;
        var firstMs = firstDt ? new Date(firstDt).getTime() : 0;
        var lastMs = lastDt ? new Date(lastDt).getTime() : 1;
        var spanMs = Math.max(1, lastMs - firstMs);

        // Sample track points that fall within our window
        for (var ti = 0; ti < track.length; ti++) {
            var tp = track[ti];
            if (!tp.t) continue;
            var tMs = new Date(tp.t).getTime();
            if (tMs < firstMs || tMs > lastMs) continue;
            var frac = (tMs - firstMs) / spanMs;
            intensityPts.push({ frac: frac, w: tp.w, p: tp.p });
        }
    }

    // Find max wind for scaling the chart
    var maxWind = 0;
    for (var k = 0; k < intensityPts.length; k++) {
        if (intensityPts[k].w != null && intensityPts[k].w > maxWind) maxWind = intensityPts[k].w;
    }
    if (maxWind < 40) maxWind = 80;

    _createGifEncoder(function (workerUrl) {
        var gif = new GIF({
            workers: 2, quality: 8, width: outW, height: outH,
            workerScript: workerUrl, transparent: null, background: '#0a1628'
        });
        _gifExporter = gif;

        var compCanvas = document.createElement('canvas');
        compCanvas.width = outW; compCanvas.height = outH;
        var compCtx = compCanvas.getContext('2d');
        var irCanvas = document.createElement('canvas');

        // Pre-render colorbar
        var lut = IR_COLORMAPS[irSelectedColormap] || IR_COLORMAPS['enhanced'];
        var cbarCanvas = document.createElement('canvas');
        cbarCanvas.width = 255; cbarCanvas.height = 1;
        var cbarCtx = cbarCanvas.getContext('2d');
        var cbarImg = cbarCtx.createImageData(255, 1);
        for (var cx = 0; cx < 255; cx++) {
            var cval = 255 - cx; var cli = cval * 4; var cpi = cx * 4;
            cbarImg.data[cpi] = lut[cli]; cbarImg.data[cpi+1] = lut[cli+1];
            cbarImg.data[cpi+2] = lut[cli+2]; cbarImg.data[cpi+3] = 255;
        }
        cbarCtx.putImageData(cbarImg, 0, 0);

        var stormLabel = (selectedStorm.name || 'UNNAMED') + ' ' + selectedStorm.year;
        var cat = getIntensityCategory(selectedStorm.peak_wind_kt);

        // Saffir-Simpson category thresholds for intensity chart background bands
        var catThresholds = [34, 64, 83, 96, 113, 137]; // TD, TS, Cat1-5
        var catColors = [
            'rgba(0,160,255,0.12)',   // TD
            'rgba(0,200,100,0.12)',   // TS
            'rgba(255,255,0,0.10)',   // Cat1
            'rgba(255,180,0,0.10)',   // Cat2
            'rgba(255,100,0,0.10)',   // Cat3
            'rgba(255,40,40,0.10)',   // Cat4
            'rgba(255,0,80,0.12)'     // Cat5
        ];

        /**
         * Draw the intensity trace chart at position (chartX, chartY) with size (chartW, chartH).
         * currentFrac = 0..1 position of the current frame in the time series.
         */
        function _drawIntensityChart(ctx, chartX, chartY, chartW, chartH, currentFrac) {
            // Background
            ctx.fillStyle = 'rgba(10,22,40,0.9)';
            ctx.fillRect(chartX, chartY, chartW, chartH);
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 0.5;
            ctx.strokeRect(chartX, chartY, chartW, chartH);

            // Category background bands
            for (var b = 0; b < catThresholds.length; b++) {
                var yBot = chartY + chartH - (catThresholds[b] / maxWind) * (chartH - 4);
                var yTop = (b + 1 < catThresholds.length)
                    ? chartY + chartH - (catThresholds[b + 1] / maxWind) * (chartH - 4)
                    : chartY;
                yBot = Math.max(chartY, Math.min(chartY + chartH, yBot));
                yTop = Math.max(chartY, Math.min(chartY + chartH, yTop));
                if (yTop < yBot) {
                    ctx.fillStyle = catColors[b + 1] || catColors[catColors.length - 1];
                    ctx.fillRect(chartX, yTop, chartW, yBot - yTop);
                }
            }

            // Wind trace line
            if (intensityPts.length > 1) {
                ctx.beginPath();
                ctx.strokeStyle = '#ff6b6b';
                ctx.lineWidth = 1.5;
                var first = true;
                for (var ip = 0; ip < intensityPts.length; ip++) {
                    var pt = intensityPts[ip];
                    if (pt.w == null) continue;
                    var px = chartX + pt.frac * chartW;
                    var py = chartY + chartH - 2 - (pt.w / maxWind) * (chartH - 4);
                    py = Math.max(chartY + 1, Math.min(chartY + chartH - 1, py));
                    if (first) { ctx.moveTo(px, py); first = false; }
                    else ctx.lineTo(px, py);
                }
                ctx.stroke();
            }

            // Current position marker (vertical line + dot)
            var markerX = chartX + currentFrac * chartW;
            ctx.strokeStyle = 'rgba(0,180,255,0.7)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(markerX, chartY);
            ctx.lineTo(markerX, chartY + chartH);
            ctx.stroke();
            ctx.setLineDash([]);

            // Find wind at this position for the dot
            var closestW = null;
            var closestDist = Infinity;
            for (var cp = 0; cp < intensityPts.length; cp++) {
                var d = Math.abs(intensityPts[cp].frac - currentFrac);
                if (d < closestDist && intensityPts[cp].w != null) {
                    closestDist = d;
                    closestW = intensityPts[cp].w;
                }
            }
            if (closestW != null) {
                var dotY = chartY + chartH - 2 - (closestW / maxWind) * (chartH - 4);
                dotY = Math.max(chartY + 2, Math.min(chartY + chartH - 2, dotY));
                ctx.beginPath();
                ctx.arc(markerX, dotY, 3, 0, Math.PI * 2);
                ctx.fillStyle = '#00d4ff';
                ctx.fill();

                // Label: wind value
                ctx.font = '9px monospace';
                ctx.fillStyle = '#c8d6e5';
                ctx.textBaseline = 'bottom';
                var wLabel = closestW + ' kt';
                var wLabelX = markerX + 5;
                if (wLabelX + 30 > chartX + chartW) wLabelX = markerX - 35;
                ctx.fillText(wLabel, wLabelX, dotY - 2);
            }

            // Y-axis label
            ctx.font = '7px sans-serif';
            ctx.fillStyle = 'rgba(150,170,190,0.5)';
            ctx.textBaseline = 'top';
            ctx.fillText('Wind (kt)', chartX + 2, chartY + 1);
        }

        // Time positions for each frame (for intensity chart marker)
        var firstDtMs = 0, spanMs2 = 1;
        if (irMeta.frames && irMeta.frames[frameIndices[0]] && irMeta.frames[frameIndices[frameIndices.length - 1]]) {
            firstDtMs = new Date(irMeta.frames[frameIndices[0]].datetime).getTime();
            var lastDtMs2 = new Date(irMeta.frames[frameIndices[frameIndices.length - 1]].datetime).getTime();
            spanMs2 = Math.max(1, lastDtMs2 - firstDtMs);
        }

        /**
         * Project lat/lon to pixel position on the IR image area of the composite canvas.
         * bounds = { south, north, west, east } in degrees.
         * Returns { x, y } in composite canvas coords (offset by irY = 24px header).
         */
        function _geoToPixel(lat, lon, bounds) {
            var xFrac = (lon - bounds.west) / (bounds.east - bounds.west);
            var yFrac = (bounds.north - lat) / (bounds.north - bounds.south);
            return { x: xFrac * outW, y: 24 + yFrac * irImageH };
        }

        /**
         * Draw coastline outlines from cached GeoJSON onto the composite canvas.
         */
        function _drawCoastlines(ctx, bounds) {
            if (!_coastlineGeoJSON || !_coastlineGeoJSON.features) return;
            ctx.strokeStyle = 'rgba(200,200,200,0.55)';
            ctx.lineWidth = 0.8;
            var bW = bounds.east - bounds.west;
            var bS = bounds.south, bN = bounds.north, bWest = bounds.west, bEast = bounds.east;

            for (var fi = 0; fi < _coastlineGeoJSON.features.length; fi++) {
                var geom = _coastlineGeoJSON.features[fi].geometry;
                if (!geom) continue;
                var coordSets = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
                for (var si = 0; si < coordSets.length; si++) {
                    var coords = coordSets[si];
                    if (!coords || coords.length < 2) continue;
                    // Quick bbox check — skip segments entirely outside our bounds
                    var anyIn = false;
                    for (var ci = 0; ci < coords.length; ci++) {
                        var clon = coords[ci][0], clat = coords[ci][1];
                        if (clat >= bS - 2 && clat <= bN + 2 && clon >= bWest - 2 && clon <= bEast + 2) {
                            anyIn = true; break;
                        }
                    }
                    if (!anyIn) continue;
                    ctx.beginPath();
                    var started = false;
                    for (var ci = 0; ci < coords.length; ci++) {
                        var p = _geoToPixel(coords[ci][1], coords[ci][0], bounds);
                        // Clip to canvas area (with some margin for line continuity)
                        if (p.x < -20 || p.x > outW + 20 || p.y < 4 || p.y > 24 + irImageH + 20) {
                            started = false; continue;
                        }
                        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                        else ctx.lineTo(p.x, p.y);
                    }
                    ctx.stroke();
                }
            }
        }

        /**
         * Draw model forecast tracks for the cycle closest to a given frame datetime.
         */
        function _drawModelTracks(ctx, bounds, frameDatetime) {
            if (!_modelData || !_modelData.cycles) return;
            // Find the best init cycle for this frame time
            var frameMs = frameDatetime ? new Date(frameDatetime).getTime() : 0;
            if (!frameMs) return;

            var inits = _modelData.init_times || [];
            var bestInit = null, bestDiff = Infinity;
            for (var ii = 0; ii < inits.length; ii++) {
                var iStr = inits[ii];
                var iDate = new Date(
                    parseInt(iStr.substring(0,4)),
                    parseInt(iStr.substring(4,6)) - 1,
                    parseInt(iStr.substring(6,8)),
                    parseInt(iStr.substring(8,10))
                );
                var diff = frameMs - iDate.getTime();
                // Use most recent init that is before or at this frame time
                if (diff >= 0 && diff < bestDiff) {
                    bestDiff = diff; bestInit = iStr;
                }
            }
            if (!bestInit) {
                // If no init before this frame, use the earliest available
                if (inits.length > 0) bestInit = inits[0];
                else return;
            }

            var cycle = _modelData.cycles[bestInit];
            if (!cycle) return;

            var techKeys = Object.keys(cycle).sort();
            var legendItems = [];

            for (var ti = 0; ti < techKeys.length; ti++) {
                var tech = techKeys[ti];
                var forecast = cycle[tech];
                // Apply same type filters as the live map
                if (!_modelTypeFilters[forecast.type]) continue;
                if (_modelShowInterp && forecast.interp === false) continue;

                var points = forecast.points;
                if (!points || points.length < 2) continue;

                var color = forecast.color || MODEL_COLORS[tech] || '#888';
                var isOfficial = forecast.type === 'official';
                var isConsensus = forecast.type === 'consensus';
                var weight = isOfficial ? 2.5 : (isConsensus ? 2 : 1.2);
                var opacity = isOfficial ? 0.9 : (isConsensus ? 0.8 : 0.5);

                // Draw polyline
                ctx.beginPath();
                ctx.strokeStyle = color;
                ctx.lineWidth = weight;
                ctx.globalAlpha = opacity;
                if (!isOfficial && !isConsensus) ctx.setLineDash([3, 2]);
                else ctx.setLineDash([]);

                var started = false;
                for (var pi = 0; pi < points.length; pi++) {
                    var p = _geoToPixel(points[pi].lat, points[pi].lon, bounds);
                    if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                    else ctx.lineTo(p.x, p.y);
                }
                ctx.stroke();
                ctx.setLineDash([]);

                // Draw tau markers (every 24h)
                for (var mi = 0; mi < points.length; mi++) {
                    var pt = points[mi];
                    if (pt.tau > 0 && pt.tau % 24 === 0) {
                        var mp = _geoToPixel(pt.lat, pt.lon, bounds);
                        ctx.beginPath();
                        ctx.arc(mp.x, mp.y, isOfficial ? 3 : 2, 0, Math.PI * 2);
                        ctx.fillStyle = color;
                        ctx.fill();
                    }
                }

                ctx.globalAlpha = 1.0;

                // Collect legend items (deduplicate by name)
                var lname = forecast.name || tech;
                var alreadyInLegend = false;
                for (var li = 0; li < legendItems.length; li++) {
                    if (legendItems[li].name === lname) { alreadyInLegend = true; break; }
                }
                if (!alreadyInLegend && (isOfficial || isConsensus || legendItems.length < 8)) {
                    legendItems.push({ name: lname, color: color, official: isOfficial });
                }
            }

            // Draw compact legend in bottom-right of IR area
            if (legendItems.length > 0) {
                // Sort: official first, then alphabetical
                legendItems.sort(function (a, b) {
                    if (a.official && !b.official) return -1;
                    if (!a.official && b.official) return 1;
                    return a.name < b.name ? -1 : 1;
                });
                var legendH = legendItems.length * 11 + 6;
                var legendW = 70;
                var legendX = outW - legendW - 4;
                var legendY = 24 + irImageH - legendH - 4;
                ctx.fillStyle = 'rgba(10,22,40,0.75)';
                ctx.fillRect(legendX, legendY, legendW, legendH);
                ctx.font = '8px sans-serif';
                ctx.textBaseline = 'middle';
                for (var li = 0; li < legendItems.length; li++) {
                    var ly = legendY + 6 + li * 11;
                    ctx.fillStyle = legendItems[li].color;
                    ctx.fillRect(legendX + 3, ly - 1.5, 10, 3);
                    ctx.fillStyle = '#c8d6e5';
                    ctx.fillText(legendItems[li].name, legendX + 16, ly);
                }
            }
        }

        var framesDone = 0;
        var batchSize = 4;

        function processBatch(startIdx) {
            if (_gifCancelled) { _gifCleanup(); return; }

            var endIdx = Math.min(startIdx + batchSize, frameIndices.length);
            for (var bi = startIdx; bi < endIdx; bi++) {
                var fIdx = frameIndices[bi];
                var frameData = irFrames[fIdx];
                if (!frameData || !frameData.tb_data) continue;

                var tbArr = decodeTbData(frameData.tb_data);
                var rows = frameData.tb_rows, cols = frameData.tb_cols;
                irCanvas.width = cols; irCanvas.height = rows;
                var irCtx = irCanvas.getContext('2d');
                var imgData = irCtx.createImageData(cols, rows);
                var px = imgData.data;
                for (var pi = 0; pi < tbArr.length; pi++) {
                    var v = tbArr[pi]; var li2 = v * 4; var pp = pi * 4;
                    px[pp] = lut[li2]; px[pp+1] = lut[li2+1]; px[pp+2] = lut[li2+2]; px[pp+3] = lut[li2+3];
                }
                irCtx.putImageData(imgData, 0, 0);

                // --- Composite ---
                compCtx.fillStyle = '#0a1628';
                compCtx.fillRect(0, 0, outW, outH);

                // Header (24px)
                compCtx.fillStyle = '#c8d6e5';
                compCtx.font = 'bold 13px sans-serif';
                compCtx.textBaseline = 'middle';
                compCtx.fillText(stormLabel + ' \u00B7 ' + cat, 8, 12);

                var dtStr = '';
                if (irMeta.frames && irMeta.frames[fIdx]) dtStr = irMeta.frames[fIdx].datetime || '';
                compCtx.font = '11px monospace';
                compCtx.fillStyle = '#8899aa';
                var dtW = compCtx.measureText(dtStr).width;
                compCtx.fillText(dtStr, outW - dtW - 8, 12);

                // IR image
                compCtx.imageSmoothingEnabled = false;
                compCtx.drawImage(irCanvas, 0, 24, outW, irImageH);

                // Compute geographic bounds for this frame (center ± 10°)
                var frameMeta = irMeta.frames ? irMeta.frames[fIdx] : null;
                var fCenterLat, fCenterLon;
                if (frameMeta && frameMeta.lat != null) {
                    fCenterLat = frameMeta.lat;
                    fCenterLon = frameMeta.lon;
                } else if (frameData.bounds) {
                    fCenterLat = (frameData.bounds.south + frameData.bounds.north) / 2;
                    fCenterLon = (frameData.bounds.west + frameData.bounds.east) / 2;
                } else {
                    fCenterLat = selectedStorm.lmi_lat || 20;
                    fCenterLon = selectedStorm.lmi_lon || -60;
                }
                var frameBounds = {
                    south: fCenterLat - 10, north: fCenterLat + 10,
                    west: fCenterLon - 10, east: fCenterLon + 10
                };

                // Coastline overlay
                if (showCoastlines) {
                    compCtx.save();
                    compCtx.beginPath();
                    compCtx.rect(0, 24, outW, irImageH);
                    compCtx.clip();
                    _drawCoastlines(compCtx, frameBounds);
                    compCtx.restore();
                }

                // Model forecast overlay
                if (showModels) {
                    compCtx.save();
                    compCtx.beginPath();
                    compCtx.rect(0, 24, outW, irImageH);
                    compCtx.clip();
                    _drawModelTracks(compCtx, frameBounds, dtStr);
                    compCtx.restore();
                }

                // Best track position marker (white dot at storm center)
                if (frameMeta && frameMeta.lat != null) {
                    var stormPx = _geoToPixel(frameMeta.lat, frameMeta.lon, frameBounds);
                    if (stormPx.y >= 24 && stormPx.y <= 24 + irImageH) {
                        compCtx.beginPath();
                        compCtx.arc(stormPx.x, stormPx.y, 3, 0, Math.PI * 2);
                        compCtx.strokeStyle = '#ffffff';
                        compCtx.lineWidth = 1.5;
                        compCtx.stroke();
                    }
                }

                // Intensity chart (if enabled)
                if (showIntensity && intensityPts.length > 1) {
                    var chartY = 24 + irImageH;
                    var chartX = 4;
                    var chartW = outW - 8;
                    var fMs = irMeta.frames[fIdx] ? new Date(irMeta.frames[fIdx].datetime).getTime() : 0;
                    var currentFrac = (fMs - firstDtMs) / spanMs2;
                    currentFrac = Math.max(0, Math.min(1, currentFrac));
                    _drawIntensityChart(compCtx, chartX, chartY, chartW, intensityH, currentFrac);
                }

                // Footer: colorbar
                var footerY = 24 + irImageH + intensityH;
                var cbarY = footerY + 2;
                var cbarX = 30;
                var cbarW = outW - 60;
                compCtx.drawImage(cbarCanvas, cbarX, cbarY, cbarW, 8);

                compCtx.font = '9px sans-serif';
                compCtx.fillStyle = '#6b7d8e';
                compCtx.textBaseline = 'top';
                compCtx.fillText('310 K', cbarX, cbarY + 10);
                var midW = compCtx.measureText('240').width;
                compCtx.fillText('240', cbarX + cbarW / 2 - midW / 2, cbarY + 10);
                compCtx.fillText('170 K', cbarX + cbarW - compCtx.measureText('170 K').width, cbarY + 10);

                // Watermark
                compCtx.font = '9px sans-serif';
                compCtx.fillStyle = 'rgba(100,120,140,0.4)';
                compCtx.fillText('TC-ATLAS', outW - 52, outH - 4);

                gif.addFrame(compCtx, { copy: true, delay: delay });
                framesDone++;
            }

            var pct = Math.round(framesDone / frameIndices.length * 60);
            if (progressText) progressText.textContent = 'Rendering (' + framesDone + '/' + frameIndices.length + ')...';
            if (progressBar) progressBar.style.width = pct + '%';

            if (endIdx < frameIndices.length) {
                requestAnimationFrame(function () { processBatch(endIdx); });
            } else {
                if (progressText) progressText.textContent = 'Encoding GIF...';

                gif.on('progress', function (p) {
                    if (progressBar) progressBar.style.width = (60 + Math.round(p * 40)) + '%';
                });

                gif.on('finished', function (blob) {
                    if (_gifCancelled) { _gifCleanup(); return; }

                    var name = (selectedStorm.name || 'UNNAMED').replace(/\s+/g, '_');
                    var filename = 'TC-ATLAS_' + name + '_' + selectedStorm.year + '_' + irSelectedColormap + '.gif';

                    var a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);

                    var sizeMB = (blob.size / 1024 / 1024).toFixed(1);
                    showToast('GIF exported! (' + framesDone + ' frames, ' + sizeMB + ' MB)');
                    _ga('ga_export_gif', {
                        sid: selectedStorm.sid, storm_name: selectedStorm.name,
                        frames: framesDone, cmap: irSelectedColormap, size_bytes: blob.size
                    });
                    _gifCleanup();
                });

                gif.render();
            }
        }

        requestAnimationFrame(function () { processBatch(0); });
    }); // end _createGifEncoder callback
};

window.cancelGifExport = function () {
    _gifCancelled = true;
    if (_gifExporter) { try { _gifExporter.abort(); } catch (e) {} }
    _gifCleanup();
    showToast('GIF export cancelled');
};

function _gifCleanup() {
    _gifExporter = null;
    var overlay = document.getElementById('gif-export-overlay');
    if (overlay) overlay.style.display = 'none';
    var gifBtn = document.getElementById('ir-gif-btn');
    if (gifBtn) { gifBtn.disabled = false; gifBtn.style.opacity = ''; }
}


// ═══════════════════════════════════════════════════════════════
// ── SIDE-BY-SIDE IR COMPARISON ────────────────────────────────
// ═══════════════════════════════════════════════════════════════

var _cmpIR = {
    left:  { map: null, storm: null, meta: null, frames: [], idx: 0, overlay: null, playing: false, timer: null },
    right: { map: null, storm: null, meta: null, frames: [], idx: 0, overlay: null, playing: false, timer: null },
    sync: false,
    cmap: 'enhanced',
    speed: 750
};

/**
 * Initialize the compare IR section whenever storms are added to compare.
 * Auto-assigns the first two compare storms to left and right viewers.
 */
function initCompareIR() {
    var wrap = document.getElementById('compare-ir-wrap');
    if (!wrap) return;
    if (compareStorms.length < 2) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';

    // Init maps if needed
    if (!_cmpIR.left.map) {
        _cmpIR.left.map = L.map('compare-ir-map-left', {
            zoomControl: true,
            attributionControl: false,
            minZoom: 2, maxZoom: 10,
            scrollWheelZoom: true
        }).setView([20, -60], 4);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
            maxZoom: 18
        }).addTo(_cmpIR.left.map);
        _cmpIR.left.map.createPane('coastlines');
        _cmpIR.left.map.getPane('coastlines').style.zIndex = 450;
        _cmpIR.left.map.getPane('coastlines').style.pointerEvents = 'none';
        _loadCoastlineOverlay(_cmpIR.left.map);
        _attachCompareIRHover('left');
    }
    if (!_cmpIR.right.map) {
        _cmpIR.right.map = L.map('compare-ir-map-right', {
            zoomControl: true,
            attributionControl: false,
            minZoom: 2, maxZoom: 10,
            scrollWheelZoom: true
        }).setView([20, -60], 4);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
            maxZoom: 18
        }).addTo(_cmpIR.right.map);
        _cmpIR.right.map.createPane('coastlines');
        _cmpIR.right.map.getPane('coastlines').style.zIndex = 450;
        _cmpIR.right.map.getPane('coastlines').style.pointerEvents = 'none';
        _loadCoastlineOverlay(_cmpIR.right.map);
        _attachCompareIRHover('right');
    }

    // Invalidate map sizes after display
    setTimeout(function () {
        _cmpIR.left.map.invalidateSize();
        _cmpIR.right.map.invalidateSize();
    }, 150);

    // Assign storms
    var s1 = compareStorms[0];
    var s2 = compareStorms[1];

    if (!_cmpIR.left.storm || _cmpIR.left.storm.sid !== s1.sid) {
        _loadCompareIRStorm('left', s1);
    }
    if (!_cmpIR.right.storm || _cmpIR.right.storm.sid !== s2.sid) {
        _loadCompareIRStorm('right', s2);
    }

    // Render colorbar
    _renderCompareColorbar();
}

function _renderCompareColorbar() {
    var canvas = document.getElementById('compare-ir-colorbar');
    if (!canvas) return;
    var lut = IR_COLORMAPS[_cmpIR.cmap] || IR_COLORMAPS['enhanced'];
    canvas.width = 255;
    canvas.height = 1;
    var ctx = canvas.getContext('2d');
    var imgData = ctx.createImageData(255, 1);
    var px = imgData.data;
    for (var x = 0; x < 255; x++) {
        var val = 255 - x;
        var li = val * 4;
        var pi = x * 4;
        px[pi] = lut[li]; px[pi+1] = lut[li+1]; px[pi+2] = lut[li+2]; px[pi+3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
}

/**
 * Load IR metadata + first frame for one side of the comparison.
 */
function _loadCompareIRStorm(side, storm) {
    var s = _cmpIR[side];
    s.storm = storm;
    s.meta = null;
    s.frames = [];
    s.idx = 0;
    if (s.timer) { clearInterval(s.timer); s.timer = null; s.playing = false; }
    if (s.overlay && s.map) { s.map.removeLayer(s.overlay); s.overlay = null; }

    var label = document.getElementById('compare-ir-' + side + '-label');
    if (label) {
        var cat = getIntensityCategory(storm.peak_wind_kt);
        var color = getIntensityColor(storm.peak_wind_kt);
        label.innerHTML = '<span style="color:' + color + ';font-weight:700;">' +
            (storm.name || 'UNNAMED') + '</span> ' + storm.year + ' <span style="font-size:0.7rem;color:' + color + ';">' + cat + '</span>';
    }

    // Build metadata URL
    var track = allTracks[storm.sid] || [];
    var trackParam = track.length > 0 ? '&track=' + encodeURIComponent(JSON.stringify(track)) : '';
    var lonParam = storm.lmi_lon != null ? '&storm_lon=' + storm.lmi_lon : '';
    var metaUrl = API_BASE + '/global/ir/meta?sid=' + encodeURIComponent(storm.sid) + trackParam + lonParam;

    var dtEl = document.getElementById('compare-ir-dt-' + side);
    if (dtEl) dtEl.textContent = 'Loading...';

    fetch(metaUrl)
        .then(function (r) { if (!r.ok) throw new Error('No IR data'); return r.json(); })
        .then(function (meta) {
            if (!meta.available || meta.n_frames === 0) {
                if (dtEl) dtEl.textContent = 'No IR data available';
                return;
            }
            s.meta = meta;
            var slider = document.getElementById('compare-ir-slider-' + side);
            if (slider) { slider.max = meta.n_frames - 1; slider.value = 0; }

            // Center map on storm LMI position
            var lat = storm.lmi_lat || 20;
            var lon = storm.lmi_lon || -60;
            s.map.setView([lat, lon], 5);

            // Load first frame
            _loadCompareIRFrame(side, 0);
        })
        .catch(function (e) {
            if (dtEl) dtEl.textContent = 'IR unavailable';
            console.warn('Compare IR load failed for ' + storm.sid, e);
        });
}

function _loadCompareIRFrame(side, idx) {
    var s = _cmpIR[side];
    if (!s.meta || !s.storm) return;

    // Check cache
    if (s.frames[idx]) {
        _displayCompareIR(side, s.frames[idx]);
        _updateCompareIRMeta(side, idx);
        return;
    }

    var source = s.meta.source || 'hursat';
    var irCacheVer = 'v5';
    var frameUrl;

    if ((source === 'mergir' || source === 'gridsat') && s.meta.frames && s.meta.frames[idx]) {
        var fi = s.meta.frames[idx];
        frameUrl = API_BASE + '/global/ir/frame?sid=' + encodeURIComponent(s.storm.sid) +
            '&frame_idx=' + idx + '&lat=' + fi.lat + '&lon=' + fi.lon + '&_v=' + irCacheVer;
    } else {
        frameUrl = API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(s.storm.sid) +
            '&frame_idx=' + idx + '&_v=' + irCacheVer;
    }

    fetch(frameUrl)
        .then(function (r) { if (!r.ok) throw new Error('Frame unavailable'); return r.json(); })
        .then(function (data) {
            s.frames[idx] = data;
            if (s.idx === idx) {
                _displayCompareIR(side, data);
            }
            _updateCompareIRMeta(side, idx);
        })
        .catch(function () {
            var dtEl = document.getElementById('compare-ir-dt-' + side);
            if (dtEl) dtEl.textContent = 'Frame ' + (idx + 1) + ' unavailable';
        });
}

function _displayCompareIR(side, data) {
    var s = _cmpIR[side];
    if (!s.map || !data) return;

    var bounds = data.bounds;
    if (!bounds) {
        var lat = s.storm.lmi_lat || 20;
        var lon = s.storm.lmi_lon || -60;
        bounds = { south: lat - 10, north: lat + 10, west: lon - 10, east: lon + 10 };
    }
    var imageBounds = L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);

    var imageURI;
    if (data.tb_data) {
        var tbArr = decodeTbData(data.tb_data);
        imageURI = renderTbToDataURI(tbArr, data.tb_rows, data.tb_cols, _cmpIR.cmap, bounds.south, bounds.north);
        // Store Tb data for hover display
        s.tbData = tbArr;
        s.tbRows = data.tb_rows;
        s.tbCols = data.tb_cols;
        s.tbBounds = imageBounds;
    } else if (data.frame) {
        imageURI = data.frame;
        s.tbData = null;
    } else {
        return;
    }

    if (s.overlay) { try { s.map.removeLayer(s.overlay); } catch (e) {} }
    s.overlay = L.imageOverlay(imageURI, imageBounds, {
        opacity: 0.8,
        interactive: false,
        className: 'ir-overlay-image'
    }).addTo(s.map);

    // Pan map to follow storm center
    s.map.panTo(imageBounds.getCenter(), { animate: false });
}

/**
 * Attach Tb hover display to a compare IR map.
 */
function _attachCompareIRHover(side) {
    var s = _cmpIR[side];
    if (!s.map) return;

    s.tooltip = L.popup({
        closeButton: false, autoPan: false, autoClose: false,
        className: 'ir-tb-tooltip', offset: [12, -12]
    });

    var throttled = false;
    s.map.on('mousemove', function (e) {
        if (throttled) return;
        throttled = true;
        setTimeout(function () { throttled = false; }, 50);

        if (!s.tbData || !s.tbBounds) {
            if (s.tooltip && s.map.hasLayer(s.tooltip)) s.map.closePopup(s.tooltip);
            return;
        }

        var lat = e.latlng.lat;
        var lng = e.latlng.lng;
        var b = s.tbBounds;

        if (lat < b.getSouth() || lat > b.getNorth() ||
            lng < b.getWest() || lng > b.getEast()) {
            if (s.tooltip && s.map.hasLayer(s.tooltip)) s.map.closePopup(s.tooltip);
            return;
        }

        // Mercator-corrected grid lookup (same as main viewer)
        var nRows = s.tbRows, nCols = s.tbCols;
        if (!nRows || !nCols) return;

        function _mercY(d) { var r = d * Math.PI / 180; return Math.log(Math.tan(Math.PI / 4 + r / 2)); }
        var mercN = _mercY(b.getNorth());
        var mercS = _mercY(b.getSouth());
        var mercL = _mercY(lat);
        var fracY = (mercN - mercL) / (mercN - mercS);
        var fracX = (lng - b.getWest()) / (b.getEast() - b.getWest());
        var row = Math.min(Math.floor(fracY * nRows), nRows - 1);
        var col = Math.min(Math.floor(fracX * nCols), nCols - 1);

        var rawVal = s.tbData[row * nCols + col];
        if (rawVal === 0) {
            if (s.tooltip && s.map.hasLayer(s.tooltip)) s.map.closePopup(s.tooltip);
            return;
        }

        var tbK = 170.0 + (rawVal - 1) * (310.0 - 170.0) / 254.0;
        var tbC = (tbK - 273.15).toFixed(1);
        var html = '<span class="ir-tb-val">' + tbK.toFixed(1) + ' K</span>' +
                   '<span class="ir-tb-sep"> / </span>' +
                   '<span class="ir-tb-val">' + tbC + ' °C</span>';

        s.tooltip.setLatLng(e.latlng).setContent(html);
        if (!s.map.hasLayer(s.tooltip)) s.tooltip.openOn(s.map);
    });

    s.map.on('mouseout', function () {
        if (s.tooltip && s.map.hasLayer(s.tooltip)) s.map.closePopup(s.tooltip);
    });
}

function _updateCompareIRMeta(side, idx) {
    var s = _cmpIR[side];
    var dtEl = document.getElementById('compare-ir-dt-' + side);
    var slider = document.getElementById('compare-ir-slider-' + side);
    var intensityEl = document.getElementById('compare-ir-intensity-' + side);
    if (slider) slider.value = idx;

    var dtStr = '';
    if (s.meta && s.meta.frames && s.meta.frames[idx]) {
        dtStr = s.meta.frames[idx].datetime || '';
    }
    if (dtEl) dtEl.textContent = dtStr || ('Frame ' + (idx + 1) + ' / ' + (s.meta ? s.meta.n_frames : '?'));

    // Look up intensity at this frame time from track data
    if (intensityEl && s.storm && dtStr) {
        var track = allTracks[s.storm.sid] || [];
        var pt = findTrackPointAtTime(track, dtStr);
        if (pt && (pt.w != null || pt.p != null)) {
            var windStr = pt.w != null ? '<span class="cmp-wind">' + pt.w + ' kt</span>' : '';
            var presStr = pt.p != null ? '<span class="cmp-pres">' + pt.p + ' hPa</span>' : '';
            var cat = pt.w != null ? getIntensityCategory(pt.w) : '';
            var color = pt.w != null ? getIntensityColor(pt.w) : '#8899aa';
            var catStr = cat ? '<span class="cmp-cat" style="color:' + color + ';border:1px solid ' + color + ';">' + cat + '</span>' : '';
            intensityEl.innerHTML = windStr + presStr + catStr;
        } else {
            intensityEl.innerHTML = '';
        }
    } else if (intensityEl) {
        intensityEl.innerHTML = '';
    }
}

/**
 * Find the frame index closest to peak intensity for a compare-IR side.
 */
function _findPeakFrameIdx(side) {
    var s = _cmpIR[side];
    if (!s.meta || !s.meta.frames || !s.storm) return 0;
    var track = allTracks[s.storm.sid] || [];
    if (!track.length) return 0;

    var bestIdx = 0;
    var bestWind = -1;
    for (var i = 0; i < s.meta.n_frames; i++) {
        var frameDt = s.meta.frames[i] ? s.meta.frames[i].datetime : null;
        if (!frameDt) continue;
        var pt = findTrackPointAtTime(track, frameDt);
        if (pt && pt.w != null && pt.w > bestWind) {
            bestWind = pt.w;
            bestIdx = i;
        }
    }
    return bestIdx;
}

/**
 * Jump one side to its peak intensity frame.
 */
window.jumpCompareIRToPeak = function (side) {
    var peakIdx = _findPeakFrameIdx(side);
    var s = _cmpIR[side];
    s.idx = peakIdx;
    _loadCompareIRFrame(side, peakIdx);
};

/**
 * Jump both sides to their respective peak intensity frames.
 */
window.jumpBothToPeak = function () {
    jumpCompareIRToPeak('left');
    jumpCompareIRToPeak('right');
    showToast('Jumped both storms to peak intensity');
};

window.seekCompareIR = function (side, val) {
    var s = _cmpIR[side];
    s.idx = parseInt(val);
    _loadCompareIRFrame(side, s.idx);

    // Sync: seek other side to same relative position
    if (_cmpIR.sync) {
        var other = side === 'left' ? 'right' : 'left';
        var os = _cmpIR[other];
        if (os.meta && os.meta.n_frames) {
            var ratio = s.idx / Math.max(1, (s.meta.n_frames - 1));
            os.idx = Math.round(ratio * (os.meta.n_frames - 1));
            _loadCompareIRFrame(other, os.idx);
        }
    }
};

window.stepCompareIR = function (side, delta) {
    var s = _cmpIR[side];
    if (!s.meta) return;
    var newIdx = s.idx + delta;
    if (newIdx < 0) newIdx = s.meta.n_frames - 1;
    if (newIdx >= s.meta.n_frames) newIdx = 0;
    s.idx = newIdx;
    _loadCompareIRFrame(side, s.idx);

    if (_cmpIR.sync) {
        var other = side === 'left' ? 'right' : 'left';
        stepCompareIR(other, delta);
    }
};

window.toggleCompareIRPlay = function (side) {
    var s = _cmpIR[side];
    if (s.playing) {
        clearInterval(s.timer); s.timer = null; s.playing = false;
        var btn = document.getElementById('compare-ir-play-' + side);
        if (btn) btn.innerHTML = '&#9654; Play';
        if (_cmpIR.sync) {
            var other = side === 'left' ? 'right' : 'left';
            var os = _cmpIR[other];
            if (os.playing) { clearInterval(os.timer); os.timer = null; os.playing = false; }
            var obtn = document.getElementById('compare-ir-play-' + other);
            if (obtn) obtn.innerHTML = '&#9654; Play';
        }
    } else {
        s.playing = true;
        var btn2 = document.getElementById('compare-ir-play-' + side);
        if (btn2) btn2.innerHTML = '&#9632; Stop';
        s.timer = setInterval(function () {
            stepCompareIR(side, 1);
        }, _cmpIR.speed);

        if (_cmpIR.sync) {
            var other2 = side === 'left' ? 'right' : 'left';
            var os2 = _cmpIR[other2];
            os2.playing = true;
            var obtn2 = document.getElementById('compare-ir-play-' + other2);
            if (obtn2) obtn2.innerHTML = '&#9632; Stop';
            os2.timer = setInterval(function () {
                stepCompareIR(other2, 1);
            }, _cmpIR.speed);
        }
    }
};

window.toggleCompareIRSync = function () {
    _cmpIR.sync = !_cmpIR.sync;
    var btn = document.getElementById('compare-ir-sync-btn');
    if (btn) {
        btn.classList.toggle('active', _cmpIR.sync);
        btn.style.background = _cmpIR.sync ? 'rgba(0, 180, 255, 0.25)' : '';
    }
    if (_cmpIR.sync) showToast('IR playback synced');
};

window.setCompareIRColormap = function (name) {
    if (!IR_COLORMAPS[name]) return;
    _cmpIR.cmap = name;
    _renderCompareColorbar();
    // Update button active states
    document.querySelectorAll('.compare-ir-cmap-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-cmap') === name);
    });
    // Re-render both sides with new colormap
    ['left', 'right'].forEach(function (side) {
        var s = _cmpIR[side];
        if (s.frames[s.idx]) {
            _displayCompareIR(side, s.frames[s.idx]);
        }
    });
};

// Hook into compare rendering to auto-init IR comparison
var _origRenderCompareTimeline = typeof renderCompareTimeline === 'function' ? renderCompareTimeline : null;


// ═══════════════════════════════════════════════════════════════
// ── SIDE-BY-SIDE MICROWAVE COMPARISON ─────────────────────────
// ═══════════════════════════════════════════════════════════════

var _compareMode = 'ir'; // 'ir' or 'mw'

var _cmpMW = {
    left:  { map: null, storm: null, overpasses: [], idx: 0, overlay: null, loading: false },
    right: { map: null, storm: null, overpasses: [], idx: 0, overlay: null, loading: false },
    product: '89pct'
};

/**
 * Switch between IR and MW compare modes.
 */
window.switchCompareMode = function (mode) {
    _compareMode = mode;
    var irGrid = document.getElementById('compare-ir-grid-ir');
    var irCmapRow = document.querySelector('#compare-ir-wrap .ir-cmap-row');
    var irColorbarRow = document.querySelector('#compare-ir-colorbar').parentElement;
    var mwPanel = document.getElementById('compare-mw-panel');
    var title = document.getElementById('compare-sat-title');
    var peakBtn = document.getElementById('compare-ir-peak-btn');
    var syncBtn = document.getElementById('compare-ir-sync-btn');

    // Update mode button active states
    document.getElementById('compare-mode-ir').classList.toggle('active', mode === 'ir');
    document.getElementById('compare-mode-mw').classList.toggle('active', mode === 'mw');

    if (mode === 'ir') {
        if (irGrid) irGrid.style.display = '';
        if (irCmapRow) irCmapRow.style.display = '';
        if (irColorbarRow) irColorbarRow.style.display = '';
        if (mwPanel) mwPanel.style.display = 'none';
        if (title) title.textContent = 'IR Satellite Comparison';
        if (peakBtn) peakBtn.style.display = '';
        if (syncBtn) syncBtn.style.display = '';
    } else {
        if (irGrid) irGrid.style.display = 'none';
        if (irCmapRow) irCmapRow.style.display = 'none';
        if (irColorbarRow) irColorbarRow.style.display = 'none';
        if (mwPanel) mwPanel.style.display = '';
        if (title) title.textContent = 'Microwave Satellite Comparison';
        if (peakBtn) peakBtn.style.display = 'none';
        if (syncBtn) syncBtn.style.display = 'none';
        initCompareMW();
    }
};

/**
 * Initialize MW comparison: set up maps and load overpass lists.
 */
function initCompareMW() {
    if (compareStorms.length < 2) return;

    // Init maps if needed
    if (!_cmpMW.left.map) {
        _cmpMW.left.map = L.map('compare-mw-map-left', {
            zoomControl: true,
            attributionControl: false,
            minZoom: 2, maxZoom: 10,
            scrollWheelZoom: true
        }).setView([20, -60], 4);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
            maxZoom: 18
        }).addTo(_cmpMW.left.map);
    }
    if (!_cmpMW.right.map) {
        _cmpMW.right.map = L.map('compare-mw-map-right', {
            zoomControl: true,
            attributionControl: false,
            minZoom: 2, maxZoom: 10,
            scrollWheelZoom: true
        }).setView([20, -60], 4);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
            maxZoom: 18
        }).addTo(_cmpMW.right.map);
    }

    setTimeout(function () {
        _cmpMW.left.map.invalidateSize();
        _cmpMW.right.map.invalidateSize();
    }, 150);

    // Assign storms
    var s1 = compareStorms[0];
    var s2 = compareStorms[1];
    if (!_cmpMW.left.storm || _cmpMW.left.storm.sid !== s1.sid) {
        _loadCompareMWStorm('left', s1);
    }
    if (!_cmpMW.right.storm || _cmpMW.right.storm.sid !== s2.sid) {
        _loadCompareMWStorm('right', s2);
    }

    // Render MW colorbar for current product
    _renderCompareMWColorbar();
}

/**
 * Load MW overpass list for one side.
 */
function _loadCompareMWStorm(side, storm) {
    var s = _cmpMW[side];
    s.storm = storm;
    s.overpasses = [];
    s.idx = 0;
    if (s.overlay && s.map) { s.map.removeLayer(s.overlay); s.overlay = null; }

    var label = document.getElementById('compare-mw-' + side + '-label');
    if (label) {
        var cat = getIntensityCategory(storm.peak_wind_kt);
        var color = getIntensityColor(storm.peak_wind_kt);
        label.innerHTML = '<span style="color:' + color + ';font-weight:700;">' +
            (storm.name || 'UNNAMED') + '</span> ' + storm.year +
            ' <span style="font-size:0.7rem;color:' + color + ';">' + cat + '</span>';
    }

    var sel = document.getElementById('compare-mw-sel-' + side);
    var statusEl = document.getElementById('compare-mw-status-' + side);
    var dtEl = document.getElementById('compare-mw-dt-' + side);
    if (sel) sel.innerHTML = '<option value="">Loading...</option>';
    if (statusEl) statusEl.textContent = 'Searching...';
    if (dtEl) dtEl.textContent = '';

    var atcfId = storm.atcf_id;
    if (!atcfId) {
        if (sel) sel.innerHTML = '<option value="">No ATCF ID</option>';
        if (statusEl) statusEl.textContent = 'No ATCF ID';
        return;
    }

    // Center map on storm
    var lat = storm.lmi_lat || 20;
    var lon = storm.lmi_lon || -60;
    s.map.setView([lat, lon], 5);

    fetch(API_BASE + '/microwave/storm_overpasses?atcf_id=' + encodeURIComponent(atcfId))
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            s.overpasses = json.overpasses || [];
            sel.innerHTML = '';

            if (s.overpasses.length === 0) {
                sel.innerHTML = '<option value="">No overpasses</option>';
                if (statusEl) statusEl.textContent = 'No data';
                return;
            }

            // Filter by current product capability
            var filtered = _filterMWOverpasses(s.overpasses, _cmpMW.product);

            if (filtered.length === 0) {
                sel.innerHTML = '<option value="">No ' + _cmpMW.product + ' data</option>';
                if (statusEl) statusEl.textContent = '0 passes';
                return;
            }

            for (var i = 0; i < filtered.length; i++) {
                var op = filtered[i];
                var opt = document.createElement('option');
                opt.value = op._origIdx;
                opt.textContent = op.sensor + ' / ' + op.platform + ' — ' + op.datetime;
                sel.appendChild(opt);
            }

            if (statusEl) statusEl.textContent = filtered.length + ' pass(es)';

            // Auto-load first overpass
            s.idx = 0;
            loadCompareMWOverpass(side);
        })
        .catch(function (e) {
            if (sel) sel.innerHTML = '<option value="">Error</option>';
            if (statusEl) statusEl.textContent = 'Error';
            console.warn('Compare MW load failed', e);
        });
}

/**
 * Filter overpasses by product capability (89 vs 37 GHz).
 */
function _filterMWOverpasses(overpasses, product) {
    var is37 = (product === '37h' || product === '37v' || product === '37color');
    var is89 = (product === '89pct' || product === '89v' || product === '89h');
    var result = [];
    for (var i = 0; i < overpasses.length; i++) {
        var op = overpasses[i];
        if (is37 && !op.has_37) continue;
        if (is89 && !op.has_89) continue;
        op._origIdx = i;
        result.push(op);
    }
    return result;
}

/**
 * Load the selected MW overpass image for one side.
 */
window.loadCompareMWOverpass = function (side) {
    var s = _cmpMW[side];
    var sel = document.getElementById('compare-mw-sel-' + side);
    var dtEl = document.getElementById('compare-mw-dt-' + side);
    var intensityEl = document.getElementById('compare-mw-intensity-' + side);
    if (!sel || sel.value === '') return;

    var origIdx = parseInt(sel.value, 10);
    var op = s.overpasses[origIdx];
    if (!op) return;

    s.loading = true;
    if (dtEl) dtEl.textContent = 'Loading...';

    var product = _cmpMW.product;
    var url = API_BASE + '/microwave/data?s3_key=' + encodeURIComponent(op.s3_key) +
        '&product=' + product;

    // Pass storm center for cropping
    if (s.storm) {
        var lat = s.storm.lmi_lat || s.storm.genesis_lat || 0;
        var lon = s.storm.lmi_lon || s.storm.genesis_lon || 0;
        url += '&center_lat=' + lat + '&center_lon=' + lon;
    }

    fetch(url)
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            s.loading = false;
            if (!json.image_b64 || !json.bounds) {
                if (dtEl) dtEl.textContent = 'No data returned';
                return;
            }

            var imgUrl = 'data:image/png;base64,' + json.image_b64;
            var bounds = L.latLngBounds(
                L.latLng(json.bounds[0][0], json.bounds[0][1]),
                L.latLng(json.bounds[1][0], json.bounds[1][1])
            );

            if (s.overlay && s.map) { s.map.removeLayer(s.overlay); }
            s.overlay = L.imageOverlay(imgUrl, bounds, {
                opacity: 0.85, interactive: false, zIndex: 650
            });
            s.overlay.addTo(s.map);

            // Pan to MW image center
            if (bounds.isValid()) {
                s.map.panTo(bounds.getCenter(), { animate: false });
            }

            // Update datetime display
            var dtStr = json.sensor + ' — ' + json.datetime;
            if (dtEl) dtEl.textContent = dtStr;

            // Update intensity from track data
            if (intensityEl && s.storm && json.datetime) {
                var track = allTracks[s.storm.sid] || [];
                // Parse MW datetime "YYYY-MM-DD HH:MM UTC"
                var isoStr = json.datetime.replace(' UTC', '').replace(' ', 'T') + ':00';
                var pt = findTrackPointAtTime(track, isoStr);
                if (pt && (pt.w != null || pt.p != null)) {
                    var windStr = pt.w != null ? '<span class="cmp-wind">' + pt.w + ' kt</span>' : '';
                    var presStr = pt.p != null ? '<span class="cmp-pres">' + pt.p + ' hPa</span>' : '';
                    var cat = pt.w != null ? getIntensityCategory(pt.w) : '';
                    var clr = pt.w != null ? getIntensityColor(pt.w) : '#8899aa';
                    var catStr = cat ? '<span class="cmp-cat" style="color:' + clr + ';border:1px solid ' + clr + ';">' + cat + '</span>' : '';
                    intensityEl.innerHTML = windStr + presStr + catStr;
                } else {
                    intensityEl.innerHTML = '';
                }
            }

            // GA4 event
            if (typeof _ga === 'function') _ga('ga_compare_mw', { product: product, sensor: json.sensor });
        })
        .catch(function (e) {
            s.loading = false;
            if (dtEl) dtEl.textContent = 'Error: ' + e.message;
            console.warn('MW compare frame load failed', e);
        });
};

/**
 * Step forward/backward through MW overpasses for one side.
 */
window.stepCompareMW = function (side, delta) {
    var sel = document.getElementById('compare-mw-sel-' + side);
    if (!sel || sel.options.length === 0) return;

    var curIdx = sel.selectedIndex;
    var newIdx = curIdx + delta;
    if (newIdx < 0) newIdx = sel.options.length - 1;
    if (newIdx >= sel.options.length) newIdx = 0;
    sel.selectedIndex = newIdx;
    loadCompareMWOverpass(side);
};

/**
 * Jump to the overpass closest to peak intensity for one side.
 */
window.jumpCompareMWToPeak = function (side) {
    var s = _cmpMW[side];
    if (!s.storm || !s.overpasses.length) return;

    var track = allTracks[s.storm.sid] || [];
    if (!track.length) return;

    // Find peak wind time from track
    var peakWind = -1;
    var peakTime = null;
    for (var t = 0; t < track.length; t++) {
        if (track[t].w != null && track[t].w > peakWind) {
            peakWind = track[t].w;
            peakTime = track[t].t;
        }
    }
    if (!peakTime) return;

    // Find the overpass with datetime closest to peak
    var peakMs = new Date(peakTime).getTime();
    var filtered = _filterMWOverpasses(s.overpasses, _cmpMW.product);
    if (!filtered.length) return;

    var bestDist = Infinity;
    var bestFilteredIdx = 0;
    for (var i = 0; i < filtered.length; i++) {
        var opDt = filtered[i].datetime.replace(' UTC', '').replace(' ', 'T') + ':00';
        var dist = Math.abs(new Date(opDt).getTime() - peakMs);
        if (dist < bestDist) {
            bestDist = dist;
            bestFilteredIdx = i;
        }
    }

    // Set dropdown selection
    var sel = document.getElementById('compare-mw-sel-' + side);
    if (sel && sel.options[bestFilteredIdx]) {
        sel.selectedIndex = bestFilteredIdx;
        loadCompareMWOverpass(side);
        showToast('Jumped to overpass nearest peak');
    }
};

/**
 * Change MW product and reload both sides.
 */
window.setCompareMWProduct = function (product) {
    _cmpMW.product = product;

    // Re-populate dropdown lists (filtering by capability)
    ['left', 'right'].forEach(function (side) {
        var s = _cmpMW[side];
        if (!s.storm || !s.overpasses.length) return;

        var sel = document.getElementById('compare-mw-sel-' + side);
        var statusEl = document.getElementById('compare-mw-status-' + side);
        if (!sel) return;

        sel.innerHTML = '';
        var filtered = _filterMWOverpasses(s.overpasses, product);

        if (filtered.length === 0) {
            sel.innerHTML = '<option value="">No ' + product + ' data</option>';
            if (statusEl) statusEl.textContent = '0 passes';
            return;
        }

        for (var i = 0; i < filtered.length; i++) {
            var op = filtered[i];
            var opt = document.createElement('option');
            opt.value = op._origIdx;
            opt.textContent = op.sensor + ' / ' + op.platform + ' — ' + op.datetime;
            sel.appendChild(opt);
        }

        if (statusEl) statusEl.textContent = filtered.length + ' pass(es)';

        // Reload current overpass with new product
        loadCompareMWOverpass(side);
    });

    _renderCompareMWColorbar();
};

/**
 * Render the MW colorbar for the current product.
 */
function _renderCompareMWColorbar() {
    var canvas = document.getElementById('compare-mw-colorbar');
    var labelsEl = document.getElementById('compare-mw-colorbar-labels');
    if (!canvas) return;

    var product = _cmpMW.product;

    // Fetch colorbar from API
    fetch(API_BASE + '/microwave/colorbar?product=' + product)
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            if (json.image_b64) {
                var img = new Image();
                img.onload = function () {
                    canvas.width = img.width;
                    canvas.height = 1;
                    var ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, img.width, 1);
                };
                img.src = 'data:image/png;base64,' + json.image_b64;
            }

            // Update labels based on product
            if (labelsEl) {
                if (product === '89pct') {
                    labelsEl.innerHTML = '<span>285 K</span><span>200</span><span>100 K</span>';
                } else if (product === '37color') {
                    labelsEl.innerHTML = '<span>Color Composite</span>';
                } else if (product.indexOf('37') === 0) {
                    labelsEl.innerHTML = '<span>290 K</span><span>240</span><span>150 K</span>';
                } else {
                    labelsEl.innerHTML = '<span>285 K</span><span>200</span><span>100 K</span>';
                }
            }
        })
        .catch(function () {
            // Fallback: just leave canvas blank
        });
}

/**
 * Cleanup MW compare state when storms are cleared.
 */
function _cleanupCompareMW() {
    ['left', 'right'].forEach(function (side) {
        var s = _cmpMW[side];
        if (s.overlay && s.map) { s.map.removeLayer(s.overlay); s.overlay = null; }
        s.storm = null;
        s.overpasses = [];
        s.idx = 0;
    });
}


// ═══════════════════════════════════════════════════════════════
// ── SHAREABLE DEEP LINKS ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

/**
 * Build a shareable URL that encodes the current view state.
 * Format: #storm=SID&frame=N&cmap=NAME&opacity=N&zoom=N&lat=N&lng=N&tab=NAME
 */
function buildShareHash() {
    var params = [];

    // Current tab
    var activeTab = document.querySelector('.ga-tab.active');
    var tab = activeTab ? activeTab.getAttribute('data-tab') : 'browser';
    params.push('tab=' + tab);

    // Storm (for detail)
    if (selectedStorm && tab === 'detail') {
        params.push('storm=' + encodeURIComponent(selectedStorm.sid));

        // IR state (only if IR overlay is visible)
        if (irOverlayVisible) {
            params.push('frame=' + irFrameIdx);
            params.push('cmap=' + irSelectedColormap);
            params.push('opacity=' + Math.round(irOpacity * 100));
        }

        // Map zoom/center
        if (detailMap) {
            var c = detailMap.getCenter();
            var z = detailMap.getZoom();
            params.push('zoom=' + z);
            params.push('lat=' + c.lat.toFixed(3));
            params.push('lng=' + c.lng.toFixed(3));
        }
    }

    // Compare tab: encode storm SIDs and alignment
    if (tab === 'compare' && compareStorms.length > 0) {
        params.push('storms=' + compareStorms.map(function (s) { return s.sid; }).join(','));
        params.push('align=' + (compareAlign || 'genesis'));
    }

    // Basin filter for browser/detail tabs
    if ((tab === 'browser' || tab === 'detail') && activeBasins[0] !== 'ALL') {
        params.push('basin=' + activeBasins.join(','));
    }

    // Climatology tab: encode basin filter if set
    if (tab === 'climatology') {
        var climBasinSel = document.getElementById('clim-basin-select');
        if (climBasinSel && climBasinSel.value) {
            params.push('basin=' + climBasinSel.value);
        }
    }

    return '#' + params.join('&');
}

/**
 * Copy a shareable link to the clipboard and show feedback.
 */
window.copyShareLink = function () {
    var hash = buildShareHash();
    var url = window.location.origin + window.location.pathname + hash;

    // Update the URL bar silently
    history.replaceState(null, '', hash);

    // Copy to clipboard
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
            showToast('Link copied to clipboard!');
            _ga('ga_share_link', { url: url });
        }).catch(function () {
            _fallbackCopy(url);
        });
    } else {
        _fallbackCopy(url);
    }
};

function _fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        showToast('Link copied to clipboard!');
    } catch (e) {
        showToast('Could not copy — check browser permissions');
    }
    document.body.removeChild(ta);
}

/**
 * Update hash in URL bar silently when user changes state.
 */
var _hashUpdateTimer = null;
function updateHashSilently() {
    // Debounce to avoid hammering history API during animation playback
    clearTimeout(_hashUpdateTimer);
    _hashUpdateTimer = setTimeout(function () {
        history.replaceState(null, '', buildShareHash());
    }, 500);
}

/**
 * Parse hash params on page load and restore state.
 */
var _hashRestored = false;
function restoreFromHash() {
    var hash = window.location.hash;
    if (!hash || hash.length < 2) return;
    if (_hashRestored) return;  // Only restore once on initial load

    var parts = hash.substring(1).split('&');
    var params = {};
    parts.forEach(function (p) {
        var kv = p.split('=');
        if (kv.length === 2) params[kv[0]] = decodeURIComponent(kv[1]);
    });

    if (!params.tab) return;

    // Wait for storm data to be loaded before restoring
    var _attempts = 0;
    var _restoreInterval = setInterval(function () {
        _attempts++;
        if (!allStorms || allStorms.length === 0) {
            if (_attempts > 100) clearInterval(_restoreInterval); // 20s timeout
            return;
        }
        clearInterval(_restoreInterval);
        _hashRestored = true;

        // ── Restore basin filter for browser/detail tabs ──
        if (params.basin && (params.tab === 'browser' || params.tab === 'detail')) {
            activeBasins = params.basin.split(',');
            document.querySelectorAll('.basin-chip').forEach(function (c) {
                var b = c.getAttribute('data-basin');
                if (b === 'ALL') {
                    c.classList.remove('active');
                } else {
                    c.classList.toggle('active', activeBasins.indexOf(b) !== -1);
                }
            });
            applyFilters();
        }

        // ── Restore storm detail view ──
        if (params.tab === 'detail' && params.storm) {
            var storm = allStorms.find(function (s) { return s.sid === params.storm; });
            if (!storm) {
                showToast('Storm not found: ' + params.storm);
                return;
            }
            selectedStorm = storm;
            viewStormDetail();

            // Wait for detail to render, then apply IR state
            setTimeout(function () {
                // Apply colormap first (before IR loads)
                if (params.cmap && IR_COLORMAPS[params.cmap]) {
                    _origSwitchColormap(params.cmap);
                }
                if (params.opacity) {
                    var opVal = parseInt(params.opacity) / 100;
                    if (opVal > 0 && opVal <= 1) {
                        irOpacity = opVal;
                        for (var oi = 0; oi < irOpacityLevels.length; oi++) {
                            if (Math.abs(irOpacityLevels[oi] - opVal) < 0.05) {
                                irOpacityIdx = oi;
                                break;
                            }
                        }
                        var opLabel = document.getElementById('ir-opacity-label');
                        if (opLabel) opLabel.textContent = Math.round(irOpacity * 100) + '%';
                    }
                }

                // Apply map position
                if (params.zoom && params.lat && params.lng && detailMap) {
                    detailMap.setView(
                        [parseFloat(params.lat), parseFloat(params.lng)],
                        parseInt(params.zoom)
                    );
                    irFollowStorm = false;
                    var followBtn = document.getElementById('ir-follow-btn');
                    if (followBtn) followBtn.classList.remove('active');
                }

                // Seek to specific frame (wait for IR metadata to load)
                if (params.frame !== undefined) {
                    var _fAttempts = 0;
                    var _frameInterval = setInterval(function () {
                        _fAttempts++;
                        if (!irMeta || !irMeta.n_frames) {
                            if (_fAttempts > 50) clearInterval(_frameInterval);
                            return;
                        }
                        clearInterval(_frameInterval);
                        var f = parseInt(params.frame);
                        if (f >= 0 && f < irMeta.n_frames) {
                            _origSeekIRFrame(f);
                        }
                    }, 300);
                }
            }, 800);
        }

        // ── Restore compare view ──
        if (params.tab === 'compare' && params.storms) {
            var sids = params.storms.split(',');
            sids.forEach(function (sid) {
                var s = allStorms.find(function (st) { return st.sid === sid; });
                if (s && !compareStorms.some(function (c) { return c.sid === sid; })) {
                    compareStorms.push(s);
                }
            });
            if (params.align) compareAlign = params.align;
            switchTab('compare');
        }

        // ── Restore climatology view ──
        if (params.tab === 'climatology') {
            switchTab('climatology');
            if (params.basin) {
                setTimeout(function () {
                    var climSel = document.getElementById('clim-basin-select');
                    if (climSel) {
                        climSel.value = params.basin;
                        climSel.dispatchEvent(new Event('change'));
                    }
                }, 200);
            }
        }

    }, 200);
}

// ═══════════════════════════════════════════════════════════════
// FORECAST SCORECARD & SHIPS ENVIRONMENTAL DATA
// Computes model verification (track/intensity errors from a-deck vs best track)
// and overlays SHIPS environmental diagnostics on the timeline.
// ═══════════════════════════════════════════════════════════════

var _scorecardVisible = false;
var _scorecardData = null;     // Computed scorecard { models: {...}, taus: [...] }
var _shipsData = null;         // SHIPS LSDIAG environmental data from API
var _shipsVisible = false;     // SHIPS traces on timeline
var _shipsTraceIndices = [];   // Plotly trace indices for SHIPS variables
var _scorecardLastAtcf = null;
var _tcprimedEnvData = null;   // TC-PRIMED ERA5-based environmental data

// SHIPS variable display config (matches backend SHIPS_VARIABLES)
var SHIPS_VAR_META = {
    SHDC: { name: 'Deep Shear (ctr)',  unit: 'kt',      color: '#ff6b6b', group: 'shear' },
    SHGC: { name: 'Gen. Shear',        unit: 'kt',      color: '#e17055', group: 'shear' },
    SHRD: { name: 'Deep Shear (avg)',   unit: 'kt',      color: '#fab1a0', group: 'shear' },
    RSST: { name: 'SST',               unit: '°C',       color: '#00d4ff', group: 'ocean' },
    COHC: { name: 'Ocean Heat Content', unit: 'kJ/cm²',  color: '#4ecdc4', group: 'ocean' },
    VMPI: { name: 'Max Pot. Intensity', unit: 'kt',      color: '#a78bfa', group: 'ocean' },
    RHMD: { name: 'Mid-level RH',      unit: '%',        color: '#34d399', group: 'moisture' },
    RHLO: { name: 'Low-level RH',      unit: '%',        color: '#6ee7b7', group: 'moisture' },
    MTPW: { name: 'Total Precip Water', unit: 'mm',      color: '#60a5fa', group: 'moisture' },
    D200: { name: '200 hPa Divergence', unit: '×10⁻⁷/s', color: '#fbbf24', group: 'dynamics' },
    T200: { name: '200 hPa Temp',       unit: '°C',       color: '#f472b6', group: 'dynamics' }
};

// Default variables to show
var SHIPS_DEFAULT_SHOW = ['SHDC', 'SHGC', 'RSST', 'COHC', 'MTPW'];

// TC-PRIMED ERA5 environmental variable display config
// For multi-dimensional variables, we pick representative slices:
//   shear_magnitude: [time, layer, region] → deep layer (idx 0), 0-500km (idx 0)
//   relative_humidity: [time, level, region] → pick specific levels, 0-500km
//   precipitable_water: [time, bins] → 0-200km bin (idx 0)
//   divergence/vorticity: [time, level, region] → 200 hPa for divergence, 850 for vorticity
//   temperature_anomaly: [time, level, region] → max across levels (warm core)
var TCPRIMED_VAR_META = {
    sst:                              { name: 'SST',               unit: 'K',    color: '#00d4ff', group: 'ocean',    extract: function(d) { return _tcpExtract1D(d, 0); } },
    potential_intensity_theoretical:  { name: 'MPI (theoretical)', unit: 'kt',   color: '#a78bfa', group: 'ocean',    extract: function(d) { return _tcpExtract1D(d, 0); } },
    potential_intensity_empirical:    { name: 'MPI (empirical)',   unit: 'kt',   color: '#818cf8', group: 'ocean',    extract: function(d) { return _tcpExtract1D(d, 0); } },
    shear_magnitude_deep:            { name: 'Deep Shear',        unit: 'm/s',  color: '#ff6b6b', group: 'shear',    srcVar: 'shear_magnitude', extract: function(d) { return _tcpExtract3D(d, 0, 0); } },
    shear_magnitude_shallow:         { name: 'Shallow Shear',     unit: 'm/s',  color: '#fab1a0', group: 'shear',    srcVar: 'shear_magnitude', extract: function(d) { return _tcpExtract3D(d, 1, 0); } },
    shear_generalized_inner:         { name: 'Gen. Shear (inner)',unit: 'm/s',  color: '#e17055', group: 'shear',    srcVar: 'shear_generalized', extract: function(d) { return _tcpExtract2D(d, 0); } },
    shear_direction_deep:            { name: 'Shear Dir (deep)',  unit: '°',    color: '#ff9f43', group: 'shear',    srcVar: 'shear_direction', extract: function(d) { return _tcpExtract3D(d, 0, 0); } },
    rh_mid:                          { name: 'Mid-level RH',     unit: '%',    color: '#34d399', group: 'moisture',  srcVar: 'relative_humidity', extract: function(d, meta) { return _tcpExtractLevel(d, meta, 700, 0); } },
    rh_low:                          { name: 'Low-level RH',     unit: '%',    color: '#6ee7b7', group: 'moisture',  srcVar: 'relative_humidity', extract: function(d, meta) { return _tcpExtractLevel(d, meta, 850, 0); } },
    precipitable_water_inner:        { name: 'Precip. Water (inner)', unit: 'kg/m²', color: '#60a5fa', group: 'moisture', srcVar: 'precipitable_water', extract: function(d) { return _tcpExtract2D(d, 0); } },
    divergence_200:                  { name: '200 hPa Divergence',unit: '×10⁻⁶/s', color: '#fbbf24', group: 'dynamics', srcVar: 'divergence', extract: function(d, meta) { return _tcpExtractLevel(d, meta, 200, 0, 1e6); } },
    vorticity_850:                   { name: '850 hPa Vorticity', unit: '×10⁻⁵/s', color: '#f472b6', group: 'dynamics', srcVar: 'vorticity', extract: function(d, meta) { return _tcpExtractLevel(d, meta, 850, 0, 1e5); } },
    warm_core_max:                   { name: 'Warm-Core Anomaly', unit: 'K',    color: '#fb923c', group: 'dynamics',  srcVar: 'temperature_anomaly', extract: function(d) { return _tcpExtractMaxLevel(d); } },
    cyclone_phase_space_b_parameter: { name: 'CPS B Parameter',   unit: 'm',    color: '#c084fc', group: 'phase',    extract: function(d) { return _tcpExtract1D(d, 0); } }
};

var TCPRIMED_DEFAULT_SHOW = ['potential_intensity_theoretical', 'shear_magnitude_deep', 'shear_magnitude_shallow'];

// ── TC-PRIMED extraction helpers ──
// Extract 1D: data is [time] or [time, 1] → return array of values
function _tcpExtract1D(data, colIdx) {
    if (!data || !Array.isArray(data)) return [];
    return data.map(function(v) {
        if (Array.isArray(v)) return v[colIdx != null ? colIdx : 0];
        return v;
    });
}

// Extract 2D: data is [time, dim1] → return array picking dim1[idx]
function _tcpExtract2D(data, idx) {
    if (!data || !Array.isArray(data)) return [];
    return data.map(function(row) {
        if (Array.isArray(row)) return row[idx] != null ? row[idx] : null;
        return row;
    });
}

// Extract 3D: data is [time, dim1, dim2] → return array picking dim1[i1][i2]
function _tcpExtract3D(data, i1, i2) {
    if (!data || !Array.isArray(data)) return [];
    return data.map(function(row) {
        if (Array.isArray(row) && Array.isArray(row[i1])) return row[i1][i2];
        if (Array.isArray(row)) return row[i1];
        return row;
    });
}

// Extract at a specific pressure level: data is [time, level, region]
function _tcpExtractLevel(data, meta, targetLevel, regionIdx, scaleFactor) {
    if (!data || !Array.isArray(data)) return [];
    var levels = _tcprimedEnvData ? _tcprimedEnvData.pressure_levels : [];
    var levelIdx = 0;
    for (var i = 0; i < levels.length; i++) {
        if (Math.abs(levels[i] - targetLevel) < Math.abs(levels[levelIdx] - targetLevel)) {
            levelIdx = i;
        }
    }
    var sf = scaleFactor || 1;
    return data.map(function(row) {
        if (!Array.isArray(row)) return row;
        var levelData = row[levelIdx];
        if (Array.isArray(levelData)) {
            var v = levelData[regionIdx != null ? regionIdx : 0];
            return v != null ? v * sf : null;
        }
        return levelData != null ? levelData * sf : null;
    });
}

// Extract max across levels: data is [time, level, region] → max per time step
function _tcpExtractMaxLevel(data) {
    if (!data || !Array.isArray(data)) return [];
    return data.map(function(row) {
        if (!Array.isArray(row)) return row;
        var maxVal = null;
        for (var i = 0; i < row.length; i++) {
            var v = Array.isArray(row[i]) ? row[i][0] : row[i];
            if (v != null && (maxVal == null || v > maxVal)) maxVal = v;
        }
        return maxVal;
    });
}

/**
 * Great-circle distance in nautical miles between two lat/lon points.
 */
function _gcDistNm(lat1, lon1, lat2, lon2) {
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return c * 3440.065; // Earth radius in nm
}

/**
 * Interpolate best track position at a given datetime.
 * Returns { lat, lon, wind } or null if outside track range.
 */
function _interpBestTrack(track, targetTime) {
    if (!track || track.length === 0) return null;

    var tgt = new Date(targetTime).getTime();
    if (isNaN(tgt)) return null;

    // Find bounding track points
    for (var i = 0; i < track.length - 1; i++) {
        var t0 = new Date(track[i].t).getTime();
        var t1 = new Date(track[i + 1].t).getTime();
        if (isNaN(t0) || isNaN(t1)) continue;

        if (tgt >= t0 && tgt <= t1) {
            var frac = (t1 === t0) ? 0 : (tgt - t0) / (t1 - t0);
            return {
                lat: track[i].la + frac * (track[i + 1].la - track[i].la),
                lon: track[i].lo + frac * (track[i + 1].lo - track[i].lo),
                wind: track[i].w != null && track[i + 1].w != null ?
                      Math.round(track[i].w + frac * (track[i + 1].w - track[i].w)) : null
            };
        }
    }

    // Exact match on first or last point
    var first = new Date(track[0].t).getTime();
    var last = new Date(track[track.length - 1].t).getTime();
    if (Math.abs(tgt - first) < 3600000) return { lat: track[0].la, lon: track[0].lo, wind: track[0].w };
    if (Math.abs(tgt - last) < 3600000) return { lat: track[track.length - 1].la, lon: track[track.length - 1].lo, wind: track[track.length - 1].w };

    return null;
}

/**
 * Compute forecast verification scorecard from a-deck data and best track.
 * Returns: {
 *   models: { 'AVNO': { name, color, type, errors: { 24: { trackErr: [...], intErr: [...], mean/n }, ... } }, ... },
 *   taus: [0, 12, 24, 36, 48, 72, 96, 120],
 *   summary: { ... }
 * }
 */
function computeScorecard(modelData, track, storm) {
    if (!modelData || !modelData.cycles || !track || track.length < 2) return null;

    var standardTaus = [0, 12, 24, 36, 48, 72, 96, 120];
    var result = { models: {}, taus: standardTaus, summary: {} };

    // Iterate all cycles and models
    var cycles = modelData.cycles;
    Object.keys(cycles).forEach(function (initTime) {
        var cycle = cycles[initTime];
        Object.keys(cycle).forEach(function (tech) {
            var forecast = cycle[tech];
            if (!forecast.points || forecast.points.length === 0) return;
            // Apply interpolation filter to scorecard too
            if (_modelShowInterp && forecast.interp === false) return;

            if (!result.models[tech]) {
                result.models[tech] = {
                    name: forecast.name,
                    color: forecast.color || MODEL_COLORS[tech] || '#888',
                    type: forecast.type,
                    errors: {}
                };
                standardTaus.forEach(function (tau) {
                    result.models[tech].errors[tau] = { trackErr: [], intErr: [], biasErr: [] };
                });
            }

            // Parse init time → Date
            var yr = parseInt(initTime.substring(0, 4));
            var mo = parseInt(initTime.substring(4, 6)) - 1;
            var dy = parseInt(initTime.substring(6, 8));
            var hr = parseInt(initTime.substring(8, 10));
            var initDate = new Date(Date.UTC(yr, mo, dy, hr));

            forecast.points.forEach(function (pt) {
                var tau = pt.tau;
                if (standardTaus.indexOf(tau) === -1) return;

                var validTime = new Date(initDate.getTime() + tau * 3600000);
                var bt = _interpBestTrack(track, validTime.toISOString());
                if (!bt) return;

                // Track error (nm)
                var trkErr = _gcDistNm(pt.lat, pt.lon, bt.lat, bt.lon);

                // Intensity error (kt) — signed (forecast - observed)
                var intErr = null;
                var biasErr = null;
                if (pt.wind != null && bt.wind != null) {
                    intErr = Math.abs(pt.wind - bt.wind);
                    biasErr = pt.wind - bt.wind;
                }

                result.models[tech].errors[tau].trackErr.push(trkErr);
                if (intErr !== null) {
                    result.models[tech].errors[tau].intErr.push(intErr);
                    result.models[tech].errors[tau].biasErr.push(biasErr);
                }
            });
        });
    });

    // Compute means and sample sizes
    Object.keys(result.models).forEach(function (tech) {
        var m = result.models[tech];
        var totalTrackSamples = 0;
        standardTaus.forEach(function (tau) {
            var e = m.errors[tau];
            e.n_track = e.trackErr.length;
            e.n_int = e.intErr.length;
            e.meanTrack = e.trackErr.length > 0 ?
                Math.round(e.trackErr.reduce(function (a, b) { return a + b; }, 0) / e.trackErr.length) : null;
            e.meanInt = e.intErr.length > 0 ?
                Math.round(e.intErr.reduce(function (a, b) { return a + b; }, 0) / e.intErr.length) : null;
            e.meanBias = e.biasErr.length > 0 ?
                Math.round(e.biasErr.reduce(function (a, b) { return a + b; }, 0) / e.biasErr.length) : null;
            totalTrackSamples += e.n_track;
        });
        m.totalSamples = totalTrackSamples;
    });

    return result;
}

/**
 * Toggle scorecard panel visibility. Computes scorecard on first open.
 */
window.toggleScorecard = function () {
    var panel = document.getElementById('scorecard-panel');
    var btn = document.getElementById('scorecard-toggle-btn');
    if (!panel || !btn) return;

    _scorecardVisible = !_scorecardVisible;

    if (_scorecardVisible) {
        panel.style.display = '';
        btn.classList.add('active');
        btn.textContent = '📊 Scorecard';

        // Compute scorecard if not already done
        if (!_scorecardData && _modelData && selectedStorm) {
            var track = allTracks[selectedStorm.sid];
            _scorecardData = computeScorecard(_modelData, track, selectedStorm);
        }

        renderScorecardTable();

        // Load SHIPS data if we have an ATCF ID in AL/EP/CP
        if (!_shipsData && selectedStorm && selectedStorm.atcf_id) {
            loadSHIPSData(selectedStorm);
        }

        // Scroll the scorecard panel into view
        setTimeout(function () {
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    } else {
        panel.style.display = 'none';
        btn.classList.remove('active');
        btn.textContent = '📊 Scorecard';
        removeSHIPSTraces();
    }
};

/**
 * Render the scorecard error table.
 */
function renderScorecardTable() {
    var container = document.getElementById('scorecard-content');
    if (!container) return;

    if (!_scorecardData || Object.keys(_scorecardData.models).length === 0) {
        container.innerHTML = '<div style="padding:30px;text-align:center;color:#8b9ec2;">No model forecast data available for scorecard computation. Enable the Models overlay first.</div>';
        return;
    }

    var sc = _scorecardData;
    var taus = sc.taus;

    // Build model list: official forecasts pinned to top, then sorted by 48h track error
    var modelList = Object.keys(sc.models).filter(function (tech) {
        return sc.models[tech].totalSamples > 0;
    }).sort(function (a, b) {
        // Official always first
        var aOff = sc.models[a].type === 'official' ? 0 : 1;
        var bOff = sc.models[b].type === 'official' ? 0 : 1;
        if (aOff !== bOff) return aOff - bOff;
        var ea = sc.models[a].errors[48] ? sc.models[a].errors[48].meanTrack : 9999;
        var eb = sc.models[b].errors[48] ? sc.models[b].errors[48].meanTrack : 9999;
        return (ea || 9999) - (eb || 9999);
    });

    if (modelList.length === 0) {
        container.innerHTML = '<div style="padding:30px;text-align:center;color:#8b9ec2;">No verification data available (model forecasts may not overlap with best track period).</div>';
        return;
    }

    // --- Tab buttons for Track / Intensity / Bias ---
    var html = '<div class="scorecard-tabs">';
    html += '<button class="scorecard-tab active" onclick="switchScorecardTab(\'track\')">Track Error (nm)</button>';
    html += '<button class="scorecard-tab" onclick="switchScorecardTab(\'intensity\')">Intensity MAE (kt)</button>';
    html += '<button class="scorecard-tab" onclick="switchScorecardTab(\'bias\')">Intensity Bias (kt)</button>';
    html += '</div>';

    // --- Track Error Table ---
    html += '<div id="scorecard-table-track" class="scorecard-table-wrap">';
    html += _buildScorecardTable(sc, modelList, taus, 'track');
    html += '</div>';

    // --- Intensity Error Table ---
    html += '<div id="scorecard-table-intensity" class="scorecard-table-wrap" style="display:none">';
    html += _buildScorecardTable(sc, modelList, taus, 'intensity');
    html += '</div>';

    // --- Bias Table ---
    html += '<div id="scorecard-table-bias" class="scorecard-table-wrap" style="display:none">';
    html += _buildScorecardTable(sc, modelList, taus, 'bias');
    html += '</div>';

    container.innerHTML = html;

    // Render SHIPS if we have data (still in scorecard for legacy compat)
    // Main env display is now in the separate Environment panel
}

function _buildScorecardTable(sc, modelList, taus, metric) {
    var html = '<table class="scorecard-table"><thead><tr>';
    html += '<th class="scorecard-model-col">Model</th>';
    html += '<th class="scorecard-n-col">N</th>';
    taus.forEach(function (tau) {
        html += '<th>' + tau + 'h</th>';
    });
    html += '</tr></thead><tbody>';

    // Find min value per tau for highlighting
    var mins = {};
    taus.forEach(function (tau) {
        var best = Infinity;
        modelList.forEach(function (tech) {
            var val = _getScorecardVal(sc.models[tech], tau, metric);
            if (val !== null && Math.abs(val) < best) best = Math.abs(val);
        });
        mins[tau] = best;
    });

    var _prevType = '';
    modelList.forEach(function (tech) {
        var m = sc.models[tech];
        // Insert separator after official rows
        if (_prevType === 'official' && m.type !== 'official') {
            html += '<tr class="scorecard-separator"><td colspan="' + (taus.length + 2) + '"></td></tr>';
        }
        _prevType = m.type;
        var rowCls = m.type === 'official' ? ' class="scorecard-official-row"' : '';
        html += '<tr' + rowCls + '>';
        html += '<td class="scorecard-model-col"><span class="scorecard-swatch" style="background:' + m.color + '"></span>' + m.name + ' <span class="scorecard-tech">(' + tech + ')</span></td>';

        // Sample count at tau=48 (representative)
        var n = m.errors[48] ? (metric === 'track' ? m.errors[48].n_track : m.errors[48].n_int) : 0;
        html += '<td class="scorecard-n-col">' + n + '</td>';

        taus.forEach(function (tau) {
            var val = _getScorecardVal(m, tau, metric);
            var cls = '';
            if (val !== null && mins[tau] !== Infinity && Math.abs(val) === mins[tau]) {
                cls = ' scorecard-best';
            }
            if (metric === 'bias' && val !== null) {
                cls += val > 0 ? ' scorecard-pos-bias' : (val < 0 ? ' scorecard-neg-bias' : '');
            }
            html += '<td class="scorecard-val' + cls + '">' + (val !== null ? val : '—') + '</td>';
        });
        html += '</tr>';
    });

    html += '</tbody></table>';
    return html;
}

function _getScorecardVal(model, tau, metric) {
    var e = model.errors[tau];
    if (!e) return null;
    if (metric === 'track') return e.meanTrack;
    if (metric === 'intensity') return e.meanInt;
    if (metric === 'bias') return e.meanBias;
    return null;
}

window.switchScorecardTab = function (tab) {
    ['track', 'intensity', 'bias'].forEach(function (t) {
        var el = document.getElementById('scorecard-table-' + t);
        if (el) el.style.display = (t === tab) ? '' : 'none';
    });
    // Update tab button active state
    document.querySelectorAll('.scorecard-tab').forEach(function (btn) {
        btn.classList.toggle('active', btn.textContent.toLowerCase().indexOf(tab) !== -1 ||
            (tab === 'track' && btn.textContent.indexOf('Track') !== -1) ||
            (tab === 'intensity' && btn.textContent.indexOf('MAE') !== -1) ||
            (tab === 'bias' && btn.textContent.indexOf('Bias') !== -1));
    });
};

/**
 * Load SHIPS LSDIAG environmental data.
 */
function loadSHIPSData(storm) {
    if (!storm.atcf_id || _shipsData) return;

    var basin = storm.atcf_id.substring(0, 2).toUpperCase();
    if (basin !== 'AL' && basin !== 'EP' && basin !== 'CP') {
        var s = document.getElementById('ships-status');
        if (s) s.textContent = 'SHIPS data only available for AL/EP/CP basins';
        return;
    }

    var s = document.getElementById('ships-status');
    if (s) s.textContent = 'Loading...';

    var url = API_BASE + '/global/ships?atcf_id=' + encodeURIComponent(storm.atcf_id);
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
        _shipsData = data;
        var s2 = document.getElementById('ships-status');
        if (data.available && data.cases && data.cases.length > 0) {
            if (s2) s2.textContent = data.n_cases + ' cases loaded';
            if (_envPanelVisible) {
                renderSHIPSControls();
                renderSHIPSChart();
            }
        } else {
            if (s2) s2.textContent = data.reason || 'No data available';
        }
    }).catch(function (err) {
        var s2 = document.getElementById('ships-status');
        if (s2) s2.textContent = 'Failed to load';
        console.warn('SHIPS load error:', err);
    });
}

/**
 * Render toggle buttons for each SHIPS variable.
 */
function renderSHIPSControls() {
    var container = document.getElementById('ships-var-toggles');
    if (!container || !_shipsData || !_shipsData.variables) return;

    var html = '';
    _shipsData.variables.forEach(function (varName) {
        var meta = SHIPS_VAR_META[varName];
        if (!meta) return;
        var active = SHIPS_DEFAULT_SHOW.indexOf(varName) !== -1;
        html += '<button class="ships-var-btn' + (active ? ' active' : '') + '" '
              + 'data-var="' + varName + '" '
              + 'style="border-color:' + meta.color + ';' + (active ? 'background:' + meta.color + '22;color:' + meta.color : '') + '" '
              + 'onclick="toggleSHIPSVar(\'' + varName + '\', this)">'
              + meta.name + '</button>';
    });
    container.innerHTML = html;
}

window.toggleSHIPSVar = function (varName, btn) {
    btn.classList.toggle('active');
    var meta = SHIPS_VAR_META[varName];
    if (btn.classList.contains('active')) {
        btn.style.background = meta.color + '22';
        btn.style.color = meta.color;
    } else {
        btn.style.background = '';
        btn.style.color = '';
    }
    renderSHIPSChart();
};

/**
 * Render SHIPS environmental variables chart using Plotly.
 */
function renderSHIPSChart() {
    var chartEl = document.getElementById('ships-chart');
    if (!chartEl || !_shipsData || !_shipsData.cases || _shipsData.cases.length === 0) return;

    // Get active variables
    var activeVars = [];
    document.querySelectorAll('.ships-var-btn.active').forEach(function (btn) {
        activeVars.push(btn.getAttribute('data-var'));
    });

    if (activeVars.length === 0) {
        Plotly.purge(chartEl);
        return;
    }

    // Build time series from SHIPS cases.
    // Each case has an init_time and predictors at tau=0 (analysis time).
    // We want the tau=0 values to form a time series across all cases.
    var traces = [];
    var yAxes = {};
    var axisCount = 0;

    activeVars.forEach(function (varName, idx) {
        var meta = SHIPS_VAR_META[varName];
        if (!meta) return;

        var times = [];
        var values = [];

        _shipsData.cases.forEach(function (c) {
            if (!c.predictors || !c.predictors[varName]) return;
            // Find tau=0 value
            var series = c.predictors[varName];
            for (var j = 0; j < series.length; j++) {
                if (series[j].tau === 0) {
                    // Convert init_time to Date string
                    var it = c.init_time;
                    if (it && it.length >= 10) {
                        var dateStr = it.substring(0, 4) + '-' + it.substring(4, 6) + '-' + it.substring(6, 8)
                                    + 'T' + it.substring(8, 10) + ':00:00Z';
                        times.push(dateStr);
                        values.push(series[j].val);
                    }
                    break;
                }
            }
        });

        if (times.length === 0) return;

        // Assign y-axis (group similar units on same axis)
        var axisKey = meta.unit;
        if (!yAxes[axisKey]) {
            axisCount++;
            yAxes[axisKey] = {
                idx: axisCount,
                unit: meta.unit,
                side: axisCount % 2 === 1 ? 'left' : 'right'
            };
        }

        var yAxisName = yAxes[axisKey].idx === 1 ? 'y' : 'y' + yAxes[axisKey].idx;

        traces.push({
            x: times,
            y: values,
            type: 'scatter',
            mode: 'lines+markers',
            name: meta.name + ' (' + meta.unit + ')',
            line: { color: meta.color, width: 2 },
            marker: { size: 4, color: meta.color },
            yaxis: yAxisName,
            hovertemplate: '<b>' + meta.name + '</b><br>%{x}<br>%{y} ' + meta.unit + '<extra></extra>'
        });
    });

    if (traces.length === 0) {
        Plotly.purge(chartEl);
        return;
    }

    // Build layout with dynamic y-axes
    var layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { family: 'Inter, sans-serif', color: '#e2e8f0' },
        margin: { l: 55, r: 55, t: 10, b: 40 },
        showlegend: true,
        legend: {
            x: 0.01, y: 0.99,
            bgcolor: 'rgba(15,33,64,0.8)',
            bordercolor: 'rgba(255,255,255,0.08)',
            borderwidth: 1,
            font: { size: 10, color: '#e2e8f0' },
            orientation: 'h'
        },
        xaxis: {
            tickfont: { size: 10, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            linecolor: 'rgba(255,255,255,0.08)'
        }
    };

    // Add y-axes
    var axisKeys = Object.keys(yAxes);
    axisKeys.forEach(function (key, i) {
        var ax = yAxes[key];
        var yKey = ax.idx === 1 ? 'yaxis' : 'yaxis' + ax.idx;
        layout[yKey] = {
            title: { text: ax.unit, font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2' },
            gridcolor: ax.idx === 1 ? 'rgba(255,255,255,0.04)' : 'transparent',
            side: ax.side,
            overlaying: ax.idx > 1 ? 'y' : undefined
        };
    });

    Plotly.newPlot(chartEl, traces, layout, { responsive: true, displayModeBar: false });
}

// ═══════════════════════════════════════════════════════════════
// TC-PRIMED ERA5 ENVIRONMENTAL DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════

var _envPanelVisible = false;

/**
 * Toggle the Environment panel (separate from Scorecard).
 */
window.toggleEnvironment = function () {
    _envPanelVisible = !_envPanelVisible;
    var panel = document.getElementById('environment-panel');
    var btn = document.getElementById('env-toggle-btn');
    if (!panel) return;

    if (_envPanelVisible) {
        panel.style.display = '';
        if (btn) btn.classList.add('active');

        // Build the environment panel content
        renderEnvironmentPanel();

        // Load data if needed
        if (!_tcprimedEnvData && selectedStorm && selectedStorm.atcf_id) {
            loadTCPrimedEnvData(selectedStorm);
        }
        if (!_shipsData && selectedStorm && selectedStorm.atcf_id) {
            loadSHIPSData(selectedStorm);
        }

        // Scroll into view
        setTimeout(function () {
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    } else {
        panel.style.display = 'none';
        if (btn) btn.classList.remove('active');
    }
};

/**
 * Render the Environment panel content with TC-PRIMED and SHIPS sections.
 */
function renderEnvironmentPanel() {
    var container = document.getElementById('environment-content');
    if (!container) return;

    var html = '';

    // --- TC-PRIMED ERA5 Environmental section (global, primary) ---
    html += '<div id="tcprimed-env-section" class="ships-section">';
    html += '<div class="ships-header">';
    html += '<h4 style="margin:0;color:#e2e8f0;font-size:0.92rem;">ERA5 Reanalysis <span style="font-size:0.75rem;color:#8b9ec2;">(TC-PRIMED, all basins)</span></h4>';
    html += '<span id="tcprimed-env-status" style="font-size:0.8rem;color:#8b9ec2;"></span>';
    html += '</div>';
    html += '<div id="tcprimed-env-toggles" class="ships-var-toggles"></div>';
    html += '<div id="tcprimed-env-chart" class="chart-container" style="height:320px;"></div>';
    html += '</div>';

    // --- SHIPS Environmental section (AL/EP/CP) ---
    html += '<div id="ships-section" class="ships-section">';
    html += '<div class="ships-header">';
    html += '<h4 style="margin:0;color:#e2e8f0;font-size:0.92rem;">SHIPS Diagnostics <span style="font-size:0.75rem;color:#8b9ec2;">(LSDIAG, AL/EP/CP only)</span></h4>';
    html += '<span id="ships-status" style="font-size:0.8rem;color:#8b9ec2;"></span>';
    html += '</div>';
    html += '<div id="ships-var-toggles" class="ships-var-toggles"></div>';
    html += '<div id="ships-chart" class="chart-container" style="height:280px;"></div>';
    html += '</div>';

    container.innerHTML = html;

    // Render existing data if already loaded
    if (_tcprimedEnvData && _tcprimedEnvData.available) {
        renderTCPrimedEnvControls();
        renderTCPrimedEnvChart();
    }
    if (_shipsData && _shipsData.available) {
        renderSHIPSControls();
        renderSHIPSChart();
    }
}

/**
 * Load TC-PRIMED ERA5-based environmental data.
 */
function loadTCPrimedEnvData(storm) {
    if (!storm.atcf_id || _tcprimedEnvData) return;

    var statusEl = document.getElementById('tcprimed-env-status');
    if (statusEl) statusEl.textContent = 'Loading ERA5 diagnostics...';

    var url = API_BASE + '/global/tcprimed-env?atcf_id=' + encodeURIComponent(storm.atcf_id);
    fetch(url).then(function(r) { return r.json(); }).then(function(data) {
        _tcprimedEnvData = data;
        // Update UI if the environment panel is currently visible
        var statusEl2 = document.getElementById('tcprimed-env-status');
        if (data.available && data.times && data.times.length > 0) {
            if (statusEl2) statusEl2.textContent = data.times.length + ' synoptic times (' + data.source + ')';
            if (_envPanelVisible) {
                renderTCPrimedEnvControls();
                renderTCPrimedEnvChart();
            }
        } else {
            if (statusEl2) statusEl2.textContent = data.reason || 'No TC-PRIMED data available';
        }
    }).catch(function(err) {
        var statusEl2 = document.getElementById('tcprimed-env-status');
        if (statusEl2) statusEl2.textContent = 'Failed to load';
        console.warn('TC-PRIMED env load error:', err);
    });
}

/**
 * Render toggle buttons for TC-PRIMED environmental variables.
 */
function renderTCPrimedEnvControls() {
    var container = document.getElementById('tcprimed-env-toggles');
    if (!container || !_tcprimedEnvData || !_tcprimedEnvData.available) return;

    var html = '';
    var varKeys = Object.keys(TCPRIMED_VAR_META);
    varKeys.forEach(function(varKey) {
        var meta = TCPRIMED_VAR_META[varKey];
        // Check that the source data exists
        var srcVar = meta.srcVar || varKey;
        if (!_tcprimedEnvData.diagnostics[srcVar]) return;

        var active = TCPRIMED_DEFAULT_SHOW.indexOf(varKey) !== -1;
        html += '<button class="ships-var-btn tcprimed-var-btn' + (active ? ' active' : '') + '" '
              + 'data-var="' + varKey + '" '
              + 'style="border-color:' + meta.color + ';' + (active ? 'background:' + meta.color + '22;color:' + meta.color : '') + '" '
              + 'onclick="toggleTCPrimedVar(\'' + varKey + '\', this)">'
              + meta.name + '</button>';
    });
    container.innerHTML = html;
}

window.toggleTCPrimedVar = function(varKey, btn) {
    btn.classList.toggle('active');
    var meta = TCPRIMED_VAR_META[varKey];
    if (btn.classList.contains('active')) {
        btn.style.background = meta.color + '22';
        btn.style.color = meta.color;
    } else {
        btn.style.background = '';
        btn.style.color = '';
    }
    renderTCPrimedEnvChart();
};

/**
 * Render TC-PRIMED environmental chart using Plotly.
 */
function renderTCPrimedEnvChart() {
    var chartEl = document.getElementById('tcprimed-env-chart');
    if (!chartEl || !_tcprimedEnvData || !_tcprimedEnvData.available) return;

    // Get active variables
    var activeVars = [];
    document.querySelectorAll('.tcprimed-var-btn.active').forEach(function(btn) {
        activeVars.push(btn.getAttribute('data-var'));
    });

    if (activeVars.length === 0) {
        Plotly.purge(chartEl);
        return;
    }

    var times = _tcprimedEnvData.times;
    var traces = [];
    var yAxes = {};
    var axisCount = 0;

    activeVars.forEach(function(varKey) {
        var meta = TCPRIMED_VAR_META[varKey];
        if (!meta) return;

        var srcVar = meta.srcVar || varKey;
        var rawData = _tcprimedEnvData.diagnostics[srcVar];
        if (!rawData) return;

        // Extract the time series using the variable-specific extractor
        var varMeta = _tcprimedEnvData.variable_meta[srcVar];
        var values = meta.extract(rawData, varMeta);

        // Filter out nulls and align with times
        var xVals = [];
        var yVals = [];
        for (var i = 0; i < Math.min(times.length, values.length); i++) {
            if (values[i] != null && times[i] != null) {
                xVals.push(times[i]);
                yVals.push(values[i]);
            }
        }

        if (xVals.length === 0) return;

        // Convert SST from K to °C for display
        var displayUnit = meta.unit;
        if (varKey === 'sst') {
            yVals = yVals.map(function(v) { return v != null ? Math.round((v - 273.15) * 100) / 100 : null; });
            displayUnit = '°C';
        }

        // Assign y-axis (group by unit)
        var axisKey = displayUnit;
        if (!yAxes[axisKey]) {
            axisCount++;
            yAxes[axisKey] = {
                idx: axisCount,
                unit: displayUnit,
                side: axisCount % 2 === 1 ? 'left' : 'right'
            };
        }

        var yAxisName = yAxes[axisKey].idx === 1 ? 'y' : 'y' + yAxes[axisKey].idx;

        traces.push({
            x: xVals,
            y: yVals,
            type: 'scatter',
            mode: 'lines+markers',
            name: meta.name + ' (' + displayUnit + ')',
            line: { color: meta.color, width: 2 },
            marker: { size: 3, color: meta.color },
            yaxis: yAxisName,
            hovertemplate: '<b>' + meta.name + '</b><br>%{x}<br>%{y:.2f} ' + displayUnit + '<extra></extra>'
        });
    });

    if (traces.length === 0) {
        Plotly.purge(chartEl);
        return;
    }

    // Also overlay intensity from storm_metadata if available
    var smIntensity = _tcprimedEnvData.storm_metadata ? _tcprimedEnvData.storm_metadata.intensity : null;
    if (smIntensity && smIntensity.length > 0) {
        var intX = [];
        var intY = [];
        for (var i = 0; i < Math.min(times.length, smIntensity.length); i++) {
            if (smIntensity[i] != null && times[i] != null) {
                intX.push(times[i]);
                intY.push(smIntensity[i]);
            }
        }
        if (intX.length > 0) {
            // Ensure kt axis exists
            if (!yAxes['kt']) {
                axisCount++;
                yAxes['kt'] = { idx: axisCount, unit: 'kt', side: axisCount % 2 === 1 ? 'left' : 'right' };
            }
            var intAxisName = yAxes['kt'].idx === 1 ? 'y' : 'y' + yAxes['kt'].idx;
            traces.push({
                x: intX,
                y: intY,
                type: 'scatter',
                mode: 'lines',
                name: 'Intensity (kt)',
                line: { color: '#e2e8f0', width: 2, dash: 'dot' },
                yaxis: intAxisName,
                hovertemplate: '<b>Intensity</b><br>%{x}<br>%{y} kt<extra></extra>'
            });
        }
    }

    var layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { family: 'Inter, sans-serif', color: '#e2e8f0' },
        margin: { l: 55, r: 55, t: 10, b: 40 },
        showlegend: true,
        legend: {
            x: 0.01, y: 0.99,
            bgcolor: 'rgba(15,33,64,0.8)',
            bordercolor: 'rgba(255,255,255,0.08)',
            borderwidth: 1,
            font: { size: 10, color: '#e2e8f0' },
            orientation: 'h'
        },
        xaxis: {
            tickfont: { size: 10, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            linecolor: 'rgba(255,255,255,0.08)'
        }
    };

    // Add y-axes
    Object.keys(yAxes).forEach(function(key) {
        var ax = yAxes[key];
        var yKey = ax.idx === 1 ? 'yaxis' : 'yaxis' + ax.idx;
        layout[yKey] = {
            title: { text: ax.unit, font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2' },
            gridcolor: ax.idx === 1 ? 'rgba(255,255,255,0.04)' : 'transparent',
            side: ax.side,
            overlaying: ax.idx > 1 ? 'y' : undefined
        };
    });

    Plotly.newPlot(chartEl, traces, layout, { responsive: true, displayModeBar: false });
}

/**
 * Remove SHIPS overlay traces from the main timeline chart.
 */
function removeSHIPSTraces() {
    _shipsTraceIndices = [];
}

/**
 * Clean up scorecard state when switching storms.
 */
function removeScorecard() {
    _scorecardVisible = false;
    _scorecardData = null;
    _shipsData = null;
    _shipsVisible = false;
    _scorecardLastAtcf = null;
    _tcprimedEnvData = null;
    _envPanelVisible = false;
    removeSHIPSTraces();
    var panel = document.getElementById('scorecard-panel');
    if (panel) panel.style.display = 'none';
    var envPanel = document.getElementById('environment-panel');
    if (envPanel) envPanel.style.display = 'none';
    var btn = document.getElementById('scorecard-toggle-btn');
    if (btn) {
        btn.classList.remove('active');
        btn.textContent = '📊 Scorecard';
    }
    var envBtn = document.getElementById('env-toggle-btn');
    if (envBtn) envBtn.classList.remove('active');
}

// ═══════════════════════════════════════════════════════════════
// END FORECAST SCORECARD
// ═══════════════════════════════════════════════════════════════

// ── Hook into state changes for silent URL updates ──
var _origSeekIRFrame = window.seekIRFrame;
window.seekIRFrame = function (val) {
    _origSeekIRFrame(val);
    updateHashSilently();
    // Model sync now handled centrally in updateIRMeta()
};

var _origSwitchColormap = switchColormap;
switchColormap = function (name) {
    _origSwitchColormap(name);
    updateHashSilently();
};
window.switchColormap = switchColormap;

// Restore state from hash on load
document.addEventListener('DOMContentLoaded', function () {
    restoreFromHash();
});

// ── KML Export ─────────────────────────────────────────────────
// Saffir-Simpson color mapping (KML uses aabbggrr format)
var KML_COLORS = {
    'TD':   'ffff8800',   // blue
    'TS':   'ff00cc00',   // green
    'Cat1': 'ff00aaff',   // orange
    'Cat2': 'ff0066ff',   // dark orange
    'Cat3': 'ff0000ff',   // red
    'Cat4': 'ff0000cc',   // dark red
    'Cat5': 'ff0000aa',   // deeper red
};

function _ssCatFromWind(w) {
    if (w == null) return 'TD';
    if (w < 34) return 'TD';
    if (w < 64) return 'TS';
    if (w < 83) return 'Cat1';
    if (w < 96) return 'Cat2';
    if (w < 113) return 'Cat3';
    if (w < 137) return 'Cat4';
    return 'Cat5';
}

function _escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildStormKML(stormName, stormYear, stormId, trackPoints) {
    var placemarks = '';

    // Track line
    var coords = [];
    for (var i = 0; i < trackPoints.length; i++) {
        var pt = trackPoints[i];
        coords.push(pt.lo + ',' + pt.la + ',0');
    }
    placemarks += '<Placemark>\n' +
        '  <name>' + _escXml(stormName) + ' Track</name>\n' +
        '  <Style><LineStyle><color>ffffffff</color><width>2</width></LineStyle></Style>\n' +
        '  <LineString><coordinates>' + coords.join(' ') + '</coordinates></LineString>\n' +
        '</Placemark>\n';

    // Individual fix placemarks with intensity coloring
    for (var j = 0; j < trackPoints.length; j++) {
        var p = trackPoints[j];
        var cat = _ssCatFromWind(p.w);
        var color = KML_COLORS[cat] || 'ffffffff';
        var desc = '';
        if (p.w != null) desc += 'Wind: ' + p.w + ' kt\\n';
        if (p.p != null) desc += 'Pressure: ' + p.p + ' hPa\\n';
        desc += 'Category: ' + cat;

        placemarks += '<Placemark>\n' +
            '  <name>' + _escXml(p.t || '') + '</name>\n' +
            '  <description>' + _escXml(desc) + '</description>\n' +
            '  <Style><IconStyle><color>' + color + '</color><scale>0.5</scale>' +
            '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon>' +
            '</IconStyle></Style>\n' +
            '  <Point><coordinates>' + p.lo + ',' + p.la + ',0</coordinates></Point>\n' +
            '</Placemark>\n';
    }

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
        '<Document>\n' +
        '  <name>' + _escXml(stormName + ' ' + stormYear) + '</name>\n' +
        '  <description>Track exported from TC-ATLAS (https://michaelfischerwx.github.io/TC-ATLAS/)</description>\n' +
        placemarks +
        '</Document>\n' +
        '</kml>';
}

function _downloadFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}

window.downloadStormKML = function () {
    if (!selectedStorm) {
        showToast('No storm selected');
        return;
    }
    var sid = selectedStorm.sid;
    var track = allTracks[sid];
    if (!track || track.length === 0) {
        showToast('No track data available');
        return;
    }
    var name = selectedStorm.name || 'UNNAMED';
    var year = selectedStorm.year || '';
    var kml = buildStormKML(name, year, sid, track);
    var filename = name.replace(/\s+/g, '_') + '_' + year + '.kml';
    _downloadFile(filename, kml, 'application/vnd.google-earth.kml+xml');
    showToast('KML downloaded: ' + filename);
};

// ══════════════════════════════════════════════════════════════════════
// ── FLIGHT-LEVEL RECONNAISSANCE OVERLAY (AOML HRD, 1960–present) ──
// ══════════════════════════════════════════════════════════════════════

var _gaFLVisible = false;
var _gaFLData = null;       // Current mission API response
var _gaFLData1s = null;
var _gaFLData10s = null;
var _gaFLData30s = null;
var _gaFLMissions = null;   // Mission discovery results
var _gaFLMapLayers = [];    // Leaflet layers for cleanup
var _gaFLColorVar = 'fl_wspd_ms';
var _gaFLAutoSync = true;
var _gaFLTooltipOpen = false;
var _gaFLFetching = false;
var _gaFLTSHighlight = null;
var _gaFLResVisible = { '1s': false, '10s': true, '30s': false };
var _gaFLXAxisMode = 'time';
var _gaFLTSOpen = false;

function _gaFLReset() {
    _gaFLVisible = false;
    _gaFLData = null;
    _gaFLData1s = null;
    _gaFLData10s = null;
    _gaFLData30s = null;
    _gaFLMissions = null;
    _gaFLFetching = false;
    _gaFLTSOpen = false;
    _gaFLClientCache = {};
    if (_gaFLZoomHandler && detailMap) {
        detailMap.off('zoomend', _gaFLZoomHandler);
        _gaFLZoomHandler = null;
    }
    _gaFLRemoveFromMap();
    var btn = document.getElementById('ga-fl-toggle-btn');
    if (btn) btn.textContent = '\u2708 Recon';
    var controls = document.getElementById('ga-fl-controls');
    if (controls) controls.style.display = 'none';
    var ts = document.getElementById('ga-fl-ts-panel');
    if (ts) ts.style.display = 'none';
}
window._gaFLReset = _gaFLReset;

function _gaFLWindColor(wspd) {
    if (wspd == null) return '#475569';
    if (wspd < 17.5) return '#60a5fa';
    if (wspd < 33.0) return '#34d399';
    if (wspd < 43.0) return '#fbbf24';
    if (wspd < 49.0) return '#fb923c';
    if (wspd < 58.0) return '#f87171';
    if (wspd < 70.0) return '#dc2626';
    return '#7f1d1d';
}

function _gaFLTempColor(t) {
    // Blue (cold) → cyan → green → yellow → red (warm)
    if (t == null) return '#475569';
    if (t < -20) return '#3b82f6';
    if (t < -10) return '#06b6d4';
    if (t < 0)   return '#22d3ee';
    if (t < 10)  return '#34d399';
    if (t < 20)  return '#fbbf24';
    if (t < 25)  return '#fb923c';
    if (t < 30)  return '#f87171';
    return '#dc2626';
}

function _gaFLThetaEColor(te) {
    // Cool → warm scale for equivalent potential temperature (K)
    if (te == null) return '#475569';
    if (te < 330) return '#3b82f6';
    if (te < 340) return '#06b6d4';
    if (te < 345) return '#34d399';
    if (te < 350) return '#a3e635';
    if (te < 355) return '#fbbf24';
    if (te < 360) return '#fb923c';
    if (te < 365) return '#f87171';
    return '#dc2626';
}

function _gaFLColorByVar(val) {
    if (_gaFLColorVar === 'fl_wspd_ms') return _gaFLWindColor(val);
    if (_gaFLColorVar === 'temp_c' || _gaFLColorVar === 'dewpoint_c') return _gaFLTempColor(val);
    if (_gaFLColorVar === 'theta_e') return _gaFLThetaEColor(val);
    return val != null ? '#60a5fa' : '#475569';
}

window.gaFLSetColorVar = function (varName) {
    _gaFLColorVar = varName;
    // Update button active states
    var btns = document.querySelectorAll('.ga-fl-color-btn');
    btns.forEach(function (b) {
        if (b.getAttribute('data-var') === varName) {
            b.classList.add('active');
        } else {
            b.classList.remove('active');
        }
    });
    // Update legend and re-render map with new coloring
    _gaFLInjectLegend();
    if (_gaFLData) _gaFLRenderOnMap();
};

window.toggleGlobalFLOverlay = function () {
    var btn = document.getElementById('ga-fl-toggle-btn');
    var controls = document.getElementById('ga-fl-controls');

    if (_gaFLVisible) {
        _gaFLVisible = false;
        if (btn) btn.textContent = '\u2708 Recon';
        if (controls) controls.style.display = 'none';
        _gaFLRemoveFromMap();
        return;
    }

    _gaFLVisible = true;
    if (btn) btn.textContent = 'Hide Recon';
    if (controls) controls.style.display = '';

    if (_gaFLData && detailMap) {
        _gaFLRenderOnMap();
        return;
    }

    if (selectedStorm) {
        _gaFLDiscoverMissions(selectedStorm);
    }
};

function _gaFLDiscoverMissions(storm) {
    var status = document.getElementById('ga-fl-frame-status');
    if (status) status.textContent = 'Searching\u2026';

    var url = API_BASE + '/global/flightlevel/missions?storm_name=' +
        encodeURIComponent(storm.name) + '&year=' + storm.year;

    fetch(url)
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            if (!json.success || !json.missions || json.missions.length === 0) {
                if (status) status.textContent = 'No FL data available';
                document.getElementById('ga-fl-status').textContent = 'No data';
                return;
            }
            _gaFLMissions = json.missions;
            _gaFLPopulateMissionDropdown();
            if (status) status.textContent = json.missions.length + ' mission(s)';
            _gaFLSyncToIRFrame();
        })
        .catch(function (e) {
            if (status) status.textContent = 'Error: ' + e.message;
        });
}

function _gaFLPopulateMissionDropdown() {
    var select = document.getElementById('ga-fl-mission-select');
    if (!select || !_gaFLMissions) return;
    select.innerHTML = '';
    for (var i = 0; i < _gaFLMissions.length; i++) {
        var m = _gaFLMissions[i];
        var opt = document.createElement('option');
        opt.value = m.file_url;
        opt.textContent = m.datetime + ' ' + m.aircraft_code + m.sortie +
            ' (' + m.aircraft + ')';
        select.appendChild(opt);
    }
}

window.gaFLSelectMission = function () {
    var select = document.getElementById('ga-fl-mission-select');
    if (!select || !select.value) return;
    _gaFLLoadMissionData(select.value);

    // Jump IR to the mission date when user manually selects a mission
    if (_gaFLAutoSync && _gaFLMissions && irMeta && irMeta.frames && irMeta.frames.length > 0) {
        var mission = _gaFLMissions[select.selectedIndex];
        if (mission && mission.datetime) {
            var mDate = new Date(mission.datetime + 'T12:00:00Z');  // noon guess; refined by _gaFLSyncIRToMissionMidpoint after data loads
            var bestIdx = 0, bestDelta = Infinity;
            for (var i = 0; i < irMeta.frames.length; i++) {
                if (!irMeta.frames[i] || !irMeta.frames[i].datetime) continue;
                // Handle "YYYY-MM-DD HH:MM UTC" format
                var dtStr = irMeta.frames[i].datetime.replace(' UTC', 'Z').replace(' ', 'T');
                var fDate = new Date(dtStr);
                if (isNaN(fDate.getTime())) continue;
                var delta = Math.abs(fDate - mDate);
                if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
            }
            if (bestIdx !== irFrameIdx) {
                irFrameIdx = bestIdx;
                loadIRFrame(bestIdx);
            }
        }
    }
};

var _gaFLClientCache = {};  // fileUrl → parsed JSON (browser-side cache)

function _gaFLApplyData(json) {
    var status = document.getElementById('ga-fl-frame-status');
    _gaFLData = json;
    _gaFLData1s = json.obs_1s;
    _gaFLData10s = json.obs_10s || json.observations;
    _gaFLData30s = json.obs_30s;

    // QC: if >10% of W values exceed ±30 m/s, the column is unreliable — null it out
    var datasets = [_gaFLData1s, _gaFLData10s, _gaFLData30s];
    var wTotal = 0, wBad = 0;
    if (_gaFLData10s) {
        for (var qi = 0; qi < _gaFLData10s.length; qi++) {
            var wv = _gaFLData10s[qi].vert_vel_ms;
            if (wv != null) { wTotal++; if (Math.abs(wv) > 30) wBad++; }
        }
    }
    if (wTotal > 0 && wBad / wTotal > 0.1) {
        datasets.forEach(function (ds) {
            if (!ds) return;
            for (var qi = 0; qi < ds.length; qi++) ds[qi].vert_vel_ms = null;
        });
    }

    // Build FL-derived center fixes from pressure minima (for radial/xsec views)
    _buildFLCenterFixes();

    var res1sBtn = document.getElementById('ga-fl-res-1s');
    if (res1sBtn) {
        res1sBtn.style.display = json.has_1s ? '' : 'none';
        if (!json.has_1s) _gaFLResVisible['1s'] = false;
    }

    if (status) {
        var summ = json.summary || {};
        var parts = [json.n_obs_raw + ' obs'];
        if (summ.max_fl_wspd_ms != null && summ.max_fl_wspd_ms <= 120) parts.push('Max: ' + Math.round(summ.max_fl_wspd_ms * 1.944) + ' kt');
        var minP = summ.min_sfcpr_hpa != null ? summ.min_sfcpr_hpa : summ.min_static_pres_hpa;
        if (minP != null && minP >= 850) parts.push('Min P: ' + minP + ' hPa');
        var max1s = summ.max_fl_wspd_ms_1s;
        var maxKt10 = summ.max_fl_wspd_ms != null ? Math.round(summ.max_fl_wspd_ms * 1.944) : null;
        var maxKt1s = max1s != null && max1s <= 120 ? Math.round(max1s * 1.944) : null;
        if (maxKt1s != null && maxKt10 != null && maxKt1s > maxKt10) {
            parts.push('(1s: ' + maxKt1s + ' kt)');
        }
        status.textContent = parts.join(' \u00b7 ');
    }

    _gaFLRenderOnMap();
    if (_gaFLTSOpen) _gaFLRenderTimeSeries();
    _gaFLHighlightOnTimeline(json);

    if (_gaFLSyncFromFDeck) {
        _gaFLSyncFromFDeck = false;
    } else {
        _gaFLSyncIRToMissionMidpoint(json);
    }
}

function _gaFLLoadMissionData(fileUrl) {
    if (_gaFLFetching) return;

    // Check browser-side cache first — instant load for previously viewed missions
    if (_gaFLClientCache[fileUrl]) {
        _gaFLApplyData(_gaFLClientCache[fileUrl]);
        return;
    }

    _gaFLFetching = true;
    var status = document.getElementById('ga-fl-frame-status');
    if (status) status.textContent = 'Loading\u2026';

    var centerLat = 0, centerLon = 0;
    if (selectedStorm) {
        centerLat = selectedStorm.lmi_lat || selectedStorm.genesis_lat || 0;
        centerLon = selectedStorm.lmi_lon || selectedStorm.genesis_lon || 0;
    }

    var url = API_BASE + '/global/flightlevel/data?file_url=' +
        encodeURIComponent(fileUrl);
    if (centerLat) url += '&center_lat=' + centerLat + '&center_lon=' + centerLon;

    fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (json) {
            _gaFLFetching = false;
            if (!json.success) {
                if (status) status.textContent = json.detail || 'Parse failed';
                return;
            }
            // Cache in browser for instant re-access
            _gaFLClientCache[fileUrl] = json;
            _gaFLApplyData(json);
        })
        .catch(function (e) {
            _gaFLFetching = false;
            if (status) status.textContent = 'Error: ' + e.message;
        });
}

function _gaFLSyncIRToMissionMidpoint(json) {
    if (!_gaFLAutoSync || !irMeta || !irMeta.frames || irMeta.frames.length === 0) return;
    var summ = json.summary;
    if (!summ || !summ.start_time || !summ.end_time) return;

    // Build a datetime from the mission date + midpoint time
    var select = document.getElementById('ga-fl-mission-select');
    if (!select || !_gaFLMissions) return;
    var mission = _gaFLMissions[select.selectedIndex];
    if (!mission || !mission.datetime) return;

    // Calculate midpoint time, handling midnight crossings
    var st = summ.start_time.split(':');
    var et = summ.end_time.split(':');
    var startSec = parseInt(st[0]) * 3600 + parseInt(st[1]) * 60 + (parseInt(st[2]) || 0);
    var endSec = parseInt(et[0]) * 3600 + parseInt(et[1]) * 60 + (parseInt(et[2]) || 0);
    if (endSec < startSec) endSec += 86400; // crossed midnight
    var midSec = (startSec + endSec) / 2;

    // Build midpoint datetime: start from mission date, add midSec as milliseconds
    // This correctly handles midnight crossings (midSec > 86400 → next day)
    var baseDate = new Date(mission.datetime + 'T00:00:00Z');
    var midDate = new Date(baseDate.getTime() + midSec * 1000);
    if (isNaN(midDate.getTime())) return;

    // Find nearest IR frame
    var bestIdx = irFrameIdx, bestDelta = Infinity;
    for (var i = 0; i < irMeta.frames.length; i++) {
        if (!irMeta.frames[i] || !irMeta.frames[i].datetime) continue;
        var dtStr = irMeta.frames[i].datetime.replace(' UTC', 'Z').replace(' ', 'T');
        var fDate = new Date(dtStr);
        if (isNaN(fDate.getTime())) continue;
        var delta = Math.abs(fDate - midDate);
        if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
    }
    if (bestIdx !== irFrameIdx) {
        irFrameIdx = bestIdx;
        loadIRFrame(bestIdx);
    }
}

function _gaFLRemoveFromMap() {
    for (var i = 0; i < _gaFLMapLayers.length; i++) {
        if (detailMap) detailMap.removeLayer(_gaFLMapLayers[i]);
    }
    _gaFLMapLayers = [];
    if (_gaFLTSHighlight && detailMap) {
        detailMap.removeLayer(_gaFLTSHighlight);
        _gaFLTSHighlight = null;
    }
}

function _gaFLRenderOnMap() {
    _gaFLRemoveFromMap();
    if (!detailMap || !_gaFLData10s || _gaFLData10s.length < 2) return;

    var obs = _gaFLData10s;

    // Zoom-adaptive marker density:
    // zoom 3-5: every 12th obs (~2 min), zoom 6-7: every 6th (~1 min),
    // zoom 8-9: every 2nd (~20s), zoom 10+: every obs (~10s)
    var zoom = detailMap.getZoom();
    var circleStep = zoom >= 10 ? 1 : zoom >= 8 ? 2 : zoom >= 6 ? 6 : 12;
    var barbStep = circleStep * 2;  // barbs at half the density of circles

    // Colored track segments (always full resolution)
    for (var i = 1; i < obs.length; i++) {
        var p0 = obs[i - 1], p1 = obs[i];
        if (p0.lat == null || p1.lat == null) continue;
        var val = p1[_gaFLColorVar];
        var color = _gaFLColorByVar(val);
        var seg = L.polyline([[p0.lat, p0.lon], [p1.lat, p1.lon]], {
            color: color, weight: 3.5, opacity: 0.9, interactive: false
        });
        seg.addTo(detailMap);
        _gaFLMapLayers.push(seg);
    }

    // Hover circles (zoom-adaptive density)
    for (var i = 0; i < obs.length; i += circleStep) {
        var o = obs[i];
        if (o.lat == null) continue;
        var wspd = o.fl_wspd_ms;
        var wkt = wspd != null ? Math.round(wspd * 1.944) : '?';
        var tip = '<b>' + o.time + ' UTC</b><br>' +
            'Wind: ' + (wspd != null ? wkt + ' kt' : '\u2014') + '<br>' +
            'Dir: ' + (o.fl_wdir_deg != null ? o.fl_wdir_deg + '\u00b0' : '\u2014') + '<br>' +
            'Alt: ' + (o.gps_alt_m != null ? Math.round(o.gps_alt_m) + ' m' : '\u2014') + '<br>' +
            'Pres: ' + (o.static_pres_hpa != null ? o.static_pres_hpa + ' hPa' : '\u2014') + '<br>' +
            'Temp: ' + (o.temp_c != null ? o.temp_c + ' \u00b0C' : '\u2014');
        var circle = L.circleMarker([o.lat, o.lon], {
            radius: 4, fillColor: _gaFLColorByVar(o[_gaFLColorVar]), fillOpacity: 0.8,
            color: '#fff', weight: 0.5, opacity: 0.6,
            pane: 'markerPane'
        }).bindTooltip(tip, { sticky: true, pane: 'tooltipPane', className: 'ga-fl-tooltip' });
        circle.on('tooltipopen', function () { _gaFLTooltipOpen = true; });
        circle.on('tooltipclose', function () { _gaFLTooltipOpen = false; });
        circle.addTo(detailMap);
        _gaFLMapLayers.push(circle);
    }

    // Wind barbs (zoom-adaptive density)
    for (var i = 0; i < obs.length; i += barbStep) {
        var o = obs[i];
        if (o.lat == null || o.fl_wdir_deg == null || o.fl_wspd_ms == null) continue;
        var barbHtml = _gaFLBarbSVG(o.fl_wspd_ms, o.fl_wdir_deg);
        var icon = L.divIcon({
            className: 'ga-fl-barb',
            html: barbHtml,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });
        var marker = L.marker([o.lat, o.lon], { icon: icon, interactive: false });
        marker.addTo(detailMap);
        _gaFLMapLayers.push(marker);
    }

    _gaFLInjectLegend();

    // Re-render markers on zoom change for adaptive density
    if (!_gaFLZoomHandler) {
        _gaFLZoomHandler = function () {
            if (_gaFLVisible && _gaFLData10s) _gaFLRenderOnMap();
        };
        detailMap.on('zoomend', _gaFLZoomHandler);
    }
}
var _gaFLZoomHandler = null;

function _gaFLBarbSVG(wspd_ms, wdir_deg) {
    var kt = wspd_ms * 1.944;
    var rot = wdir_deg;
    var remaining = Math.round(kt / 5) * 5;
    var flags = Math.floor(remaining / 50);
    remaining -= flags * 50;
    var full = Math.floor(remaining / 10);
    remaining -= full * 10;
    var half = remaining >= 5 ? 1 : 0;

    var svg = '<svg width="24" height="24" viewBox="0 0 24 24" style="transform:rotate(' + rot + 'deg);">';
    svg += '<line x1="12" y1="12" x2="12" y2="2" stroke="white" stroke-width="1.5" stroke-linecap="round"/>';
    var y = 2;
    for (var f = 0; f < flags; f++) {
        svg += '<polygon points="12,' + y + ' 18,' + (y + 1.5) + ' 12,' + (y + 3) + '" fill="white"/>';
        y += 3;
    }
    for (var b = 0; b < full; b++) {
        svg += '<line x1="12" y1="' + y + '" x2="18" y2="' + (y - 1.5) + '" stroke="white" stroke-width="1.2"/>';
        y += 2;
    }
    if (half) {
        svg += '<line x1="12" y1="' + y + '" x2="15" y2="' + (y - 1) + '" stroke="white" stroke-width="1.2"/>';
    }
    svg += '</svg>';
    return svg;
}

var _GA_FL_COLORBARS = {
    'fl_wspd_ms': {
        label: 'Wind (m/s)',
        stops: [
            { val: '<17.5', color: '#60a5fa', lbl: 'TD' },
            { val: '17.5', color: '#34d399', lbl: 'TS' },
            { val: '33',   color: '#fbbf24', lbl: 'C1' },
            { val: '43',   color: '#fb923c', lbl: 'C2' },
            { val: '49',   color: '#f87171', lbl: 'C3' },
            { val: '58',   color: '#dc2626', lbl: 'C4' },
            { val: '70+',  color: '#7f1d1d', lbl: 'C5' },
        ]
    },
    'temp_c': {
        label: 'Temperature (\u00b0C)',
        stops: [
            { val: '<-20', color: '#3b82f6' }, { val: '-10', color: '#06b6d4' },
            { val: '0', color: '#22d3ee' }, { val: '10', color: '#34d399' },
            { val: '20', color: '#fbbf24' }, { val: '25', color: '#fb923c' },
            { val: '30+', color: '#f87171' },
        ]
    },
    'dewpoint_c': {
        label: 'Dewpoint (\u00b0C)',
        stops: [
            { val: '<-20', color: '#3b82f6' }, { val: '-10', color: '#06b6d4' },
            { val: '0', color: '#22d3ee' }, { val: '10', color: '#34d399' },
            { val: '20', color: '#fbbf24' }, { val: '25', color: '#fb923c' },
            { val: '30+', color: '#f87171' },
        ]
    },
    'theta_e': {
        label: '\u03b8e (K)',
        stops: [
            { val: '<330', color: '#3b82f6' }, { val: '340', color: '#06b6d4' },
            { val: '345', color: '#34d399' }, { val: '350', color: '#a3e635' },
            { val: '355', color: '#fbbf24' }, { val: '360', color: '#fb923c' },
            { val: '365+', color: '#f87171' },
        ]
    },
};

function _gaFLInjectLegend() {
    var el = document.getElementById('ga-fl-legend');
    if (!el) return;
    var cb = _GA_FL_COLORBARS[_gaFLColorVar];
    if (!cb) return;
    var html = '<div style="display:flex;align-items:center;gap:6px;font-size:9px;color:#94a3b8;">';
    cb.stops.forEach(function (s) {
        html += '<span style="width:10px;height:10px;border-radius:50%;background:' + s.color + ';display:inline-block;"></span>';
        html += (s.lbl || s.val);
    });
    html += '<span style="margin-left:6px;color:#64748b;">' + cb.label + '</span></div>';
    el.innerHTML = html;
}

window.gaFLToggleAutoSync = function () {
    var cb = document.getElementById('ga-fl-auto-sync');
    _gaFLAutoSync = cb ? cb.checked : false;
};

function _gaFLSyncToIRFrame() {
    if (!_gaFLAutoSync || !_gaFLVisible || !_gaFLMissions || !_gaFLMissions.length) {
        if (_gaFLMissions && _gaFLMissions.length > 0 && !_gaFLData) {
            _gaFLLoadMissionData(_gaFLMissions[0].file_url);
        }
        return;
    }

    var irTime = null;
    if (typeof irMeta !== 'undefined' && irMeta && irMeta.frames && typeof irFrameIdx !== 'undefined') {
        var frame = irMeta.frames[irFrameIdx];
        if (frame && frame.datetime) {
            irTime = new Date(frame.datetime.replace(' UTC', 'Z').replace(' ', 'T'));
        }
    }

    if (!irTime) {
        if (!_gaFLData) _gaFLLoadMissionData(_gaFLMissions[0].file_url);
        return;
    }

    var bestIdx = 0, bestDelta = Infinity;
    for (var i = 0; i < _gaFLMissions.length; i++) {
        var mTime = new Date(_gaFLMissions[i].datetime + 'T12:00:00Z');
        var delta = Math.abs(irTime - mTime);
        if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
    }

    var select = document.getElementById('ga-fl-mission-select');
    if (select) {
        select.selectedIndex = bestIdx;
        _gaFLLoadMissionData(_gaFLMissions[bestIdx].file_url);
    }
}
window._gaFLSyncToIRFrame = _gaFLSyncToIRFrame;

// ── F-Deck ↔ Recon cross-linking ────────────────────────────────

var _gaFLSyncFromFDeck = false;  // when true, skip IR midpoint override (user clicked a specific fix time)

function _gaFLSyncFromFDeckClick(clickedTime) {
    // clickedTime is ISO like "2024-08-28T12:00"
    var fixDate = clickedTime.substring(0, 10); // "YYYY-MM-DD"
    _gaFLSyncFromFDeck = true;  // IR already synced to fix time by syncIRToTime; don't override

    // Auto-activate Recon if not already visible
    if (!_gaFLVisible) {
        toggleGlobalFLOverlay();
    }

    // Wait for missions to be discovered, then select matching mission
    function _tryMatch() {
        if (!_gaFLMissions || _gaFLMissions.length === 0) {
            // Still loading — retry in 500ms (up to 10s)
            if (!_tryMatch._retries) _tryMatch._retries = 0;
            _tryMatch._retries++;
            if (_tryMatch._retries < 20) setTimeout(_tryMatch, 500);
            return;
        }

        // Find the mission closest to the fix datetime.
        // Mission metadata only has a date (YYYY-MM-DD), not flight times.
        // Use the fix's own hour to bias toward missions on the same date:
        // compare fix time to mission_date + fix_hour (not hardcoded noon),
        // so an 00Z fix prefers a same-day mission over a previous-day one.
        var fixMs = new Date(clickedTime + ':00Z').getTime();
        var fixHour = new Date(fixMs).getUTCHours();
        var fixTimeStr = 'T' + String(fixHour).padStart(2, '0') + ':00:00Z';
        var bestIdx = 0, bestDelta = Infinity;
        for (var i = 0; i < _gaFLMissions.length; i++) {
            var mMs = new Date(_gaFLMissions[i].datetime + fixTimeStr).getTime();
            var delta = Math.abs(fixMs - mMs);
            if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
        }

        // Only auto-select if closest mission is within 24 hours of the fix
        var MAX_SYNC_DELTA_MS = 24 * 3600 * 1000;
        if (bestDelta > MAX_SYNC_DELTA_MS) {
            if (typeof showToast === 'function') {
                showToast('No recon mission within 24h of ' + fixDate);
            }
            return;
        }

        var select = document.getElementById('ga-fl-mission-select');
        if (select && select.selectedIndex !== bestIdx) {
            select.selectedIndex = bestIdx;
            _gaFLLoadMissionData(_gaFLMissions[bestIdx].file_url);
        }

        // Show a brief toast
        if (typeof showToast === 'function') {
            showToast('Recon synced to ' + fixDate + ' ' +
                (_gaFLMissions[bestIdx] ? _gaFLMissions[bestIdx].aircraft_code + _gaFLMissions[bestIdx].sortie : ''));
        }
    }
    _tryMatch();
}
window._gaFLSyncFromFDeckClick = _gaFLSyncFromFDeckClick;

function _gaFLHighlightOnTimeline(json) {
    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || !chartEl.layout) return;

    var summ = json.summary;
    if (!summ || !summ.start_time || !summ.end_time) return;

    // Get mission date from dropdown
    var select = document.getElementById('ga-fl-mission-select');
    if (!select || !_gaFLMissions) return;
    var mission = _gaFLMissions[select.selectedIndex];
    if (!mission || !mission.datetime) return;

    var startISO = mission.datetime + 'T' + summ.start_time;
    var endISO = mission.datetime + 'T' + summ.end_time;

    // Remove any existing FL highlight shape, keep other shapes
    var existingShapes = (chartEl.layout.shapes || []).filter(function (s) {
        return !s._flHighlight;
    });

    // Add a subtle vertical band for the mission time window
    existingShapes.push({
        type: 'rect',
        xref: 'x', yref: 'paper',
        x0: startISO, x1: endISO,
        y0: 0, y1: 1,
        fillcolor: 'rgba(96,165,250,0.08)',
        line: { color: 'rgba(96,165,250,0.3)', width: 1, dash: 'dot' },
        layer: 'below',
        _flHighlight: true,
    });

    Plotly.relayout(chartEl, { shapes: existingShapes });
}

// ── Dropsondes (within Recon) ────────────────────────────────────

var _gaSondeData = null;
var _gaSondeMapLayers = [];
var _SONDE_COLORS = [
    '#34d399','#60a5fa','#f472b6','#fbbf24','#a78bfa',
    '#fb923c','#38bdf8','#f87171','#4ade80','#e879f9',
    '#facc15','#2dd4bf','#f97316','#818cf8','#fb7185'
];

function _gaSondeFetch(stormName, year, missionId, centerLat, centerLon) {
    var url = API_BASE + '/global/dropsondes/data?storm_name=' +
        encodeURIComponent(stormName) + '&year=' + year;
    if (missionId) url += '&mission_id=' + encodeURIComponent(missionId);
    if (centerLat) url += '&center_lat=' + centerLat + '&center_lon=' + centerLon;

    fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (json) {
            if (!json.success || !json.dropsondes || json.dropsondes.length === 0) {
                _gaSondeHideUI();
                return;
            }
            _gaSondeData = json.dropsondes;
            _gaSondeShowUI();
            _gaSondeRenderOnMap();
            _gaSondeRenderTable();
        })
        .catch(function () { _gaSondeHideUI(); });
}

function _gaSondeShowUI() {
    var el = document.getElementById('ga-sonde-info');
    if (el) el.style.display = '';
    var cnt = document.getElementById('ga-sonde-count');
    if (cnt && _gaSondeData) {
        var nSfc = _gaSondeData.filter(function (s) { return s.hit_surface; }).length;
        cnt.textContent = _gaSondeData.length + ' sonde(s)' + (nSfc ? ', ' + nSfc + ' sfc' : '');
    }
}

function _gaSondeHideUI() {
    _gaSondeData = null;
    var el = document.getElementById('ga-sonde-info');
    if (el) el.style.display = 'none';
    var skewt = document.getElementById('ga-sonde-skewt-panel');
    if (skewt) skewt.style.display = 'none';
    _gaSondeRemoveFromMap();
    _gaSondePlanViewRemove();
}

function _gaSondeRemoveFromMap() {
    for (var i = 0; i < _gaSondeMapLayers.length; i++) {
        if (detailMap) detailMap.removeLayer(_gaSondeMapLayers[i]);
    }
    _gaSondeMapLayers = [];
}

function _gaSondeRenderOnMap() {
    _gaSondeRemoveFromMap();
    if (!detailMap || !_gaSondeData) return;

    for (var si = 0; si < _gaSondeData.length; si++) {
        var sonde = _gaSondeData[si];
        var prof = sonde.profile;
        if (!prof || !prof.lat || prof.lat.length < 2) continue;

        var color = _SONDE_COLORS[si % _SONDE_COLORS.length];

        // Trajectory polyline
        var coords = [];
        for (var pi = 0; pi < prof.lat.length; pi++) {
            if (prof.lat[pi] != null && prof.lon[pi] != null) {
                coords.push([prof.lat[pi], prof.lon[pi]]);
            }
        }
        if (coords.length > 1) {
            var traj = L.polyline(coords, {
                color: color, weight: 2.5, opacity: 0.8,
                dashArray: '6,4', interactive: false
            });
            traj.addTo(detailMap);
            _gaSondeMapLayers.push(traj);
        }

        // Launch marker (hollow circle at top)
        if (sonde.launch && sonde.launch.lat != null) {
            var launchMarker = L.circleMarker([sonde.launch.lat, sonde.launch.lon], {
                radius: 5, fillColor: color, fillOpacity: 0.3,
                color: color, weight: 1.5, opacity: 0.8
            });
            launchMarker.addTo(detailMap);
            _gaSondeMapLayers.push(launchMarker);
        }

        // Surface marker (filled circle at bottom)
        if (sonde.surface && sonde.surface.lat != null) {
            var sfcTip = '<b>Sonde ' + (si + 1) + '</b>' +
                (sonde.sonde_id ? ' (' + sonde.sonde_id + ')' : '') + '<br>' +
                (sonde.launch_time || '') + '<br>' +
                'Sfc: ' + (sonde.hit_surface ? 'Yes' : 'No') +
                (sonde.splash_pr ? ' · P: ' + sonde.splash_pr.toFixed(1) + ' hPa' : '');
            var sfcMarker = L.circleMarker([sonde.surface.lat, sonde.surface.lon], {
                radius: 6, fillColor: color, fillOpacity: 0.9,
                color: '#fff', weight: 1, opacity: 0.8
            }).bindTooltip(sfcTip, { sticky: true });
            // Click to show Skew-T
            (function (idx) {
                sfcMarker.on('click', function () { gaSondeShowSkewT(idx); });
            })(si);
            sfcMarker.addTo(detailMap);
            _gaSondeMapLayers.push(sfcMarker);
        }
    }
}

function _gaSondeRenderTable() {
    var wrap = document.getElementById('ga-sonde-table-wrap');
    if (!wrap || !_gaSondeData) return;

    var html = '<table style="width:100%;border-collapse:collapse;font-size:9px;font-family:\'JetBrains Mono\',monospace;">' +
        '<tr style="color:#6ee7b7;border-bottom:1px solid rgba(255,255,255,0.1);">' +
        '<th style="padding:2px 4px;text-align:left;">#</th>' +
        '<th style="padding:2px 4px;text-align:left;">Time</th>' +
        '<th style="padding:2px 4px;text-align:right;">Vmax</th>' +
        '<th style="padding:2px 4px;text-align:right;">WL150</th>' +
        '<th style="padding:2px 4px;text-align:right;">Psfc</th>' +
        '<th style="padding:2px 4px;text-align:center;">Sfc</th>' +
        '<th style="padding:2px 4px;"></th></tr>';

    for (var i = 0; i < _gaSondeData.length; i++) {
        var s = _gaSondeData[i];
        var prof = s.profile || {};
        var maxWspd = null;
        if (prof.wspd) {
            for (var wi = 0; wi < prof.wspd.length; wi++) {
                if (prof.wspd[wi] != null && (maxWspd == null || prof.wspd[wi] > maxWspd)) maxWspd = prof.wspd[wi];
            }
        }
        // WL150: vector-mean wind in the lowest 150m layer (Franklin et al. 2003)
        // Requirements: sonde reached within 10m of surface, ≥3 valid winds,
        // winds must span ≥75% of the 150m layer (112.5m coverage)
        var wl150 = null;
        if (prof.alt_km && prof.wspd && s.hit_surface && prof.uwnd && prof.vwnd) {
            var minAlt = null, maxAltInLayer = null;
            for (var ai = 0; ai < prof.alt_km.length; ai++) {
                if (prof.alt_km[ai] != null) {
                    if (minAlt == null || prof.alt_km[ai] < minAlt) minAlt = prof.alt_km[ai];
                }
            }
            if (minAlt != null && minAlt <= 0.5) {  // sonde must reach within 500m of surface
                var uSum = 0, vSum = 0, wCnt = 0;
                var layerTop = minAlt + 0.15; // 150m above lowest point
                var altMin = Infinity, altMax = -Infinity;
                for (var hi = 0; hi < prof.alt_km.length; hi++) {
                    if (prof.alt_km[hi] != null && prof.uwnd[hi] != null && prof.vwnd[hi] != null &&
                        prof.alt_km[hi] <= layerTop) {
                        uSum += prof.uwnd[hi];
                        vSum += prof.vwnd[hi];
                        wCnt++;
                        if (prof.alt_km[hi] < altMin) altMin = prof.alt_km[hi];
                        if (prof.alt_km[hi] > altMax) altMax = prof.alt_km[hi];
                    }
                }
                var layerSpan = (altMax - altMin) * 1000; // in meters
                // Franklin et al.: ≥3 winds spanning ≥75% of 150m (112.5m)
                if (wCnt >= 3 && layerSpan >= 112.5) {
                    var uMean = uSum / wCnt;
                    var vMean = vSum / wCnt;
                    wl150 = Math.sqrt(uMean * uMean + vMean * vMean);
                }
            }
        }
        // Surface pressure: prefer splash_pr, then hyd_sfcp, then last valid profile pressure
        var psfc = s.splash_pr || s.hyd_sfcp || null;
        if (psfc == null && prof.pres) {
            for (var pi = prof.pres.length - 1; pi >= 0; pi--) {
                if (prof.pres[pi] != null && prof.pres[pi] > 850) { psfc = prof.pres[pi]; break; }
            }
        }
        var timeShort = (s.launch_time || '').replace(/.*T/, '').replace('Z', '').substring(0, 8);

        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;" onclick="gaSondeShowSkewT(' + i + ')">' +
            '<td style="padding:2px 4px;color:' + _SONDE_COLORS[i % _SONDE_COLORS.length] + ';">' + (i + 1) + '</td>' +
            '<td style="padding:2px 4px;">' + timeShort + '</td>' +
            '<td style="padding:2px 4px;text-align:right;">' + (maxWspd != null ? (maxWspd * 1.944).toFixed(0) + ' kt' : '\u2014') + '</td>' +
            '<td style="padding:2px 4px;text-align:right;">' + (wl150 != null ? (wl150 * 1.944).toFixed(0) + ' kt' : '\u2014') + '</td>' +
            '<td style="padding:2px 4px;text-align:right;">' + (psfc != null ? psfc.toFixed(0) : '\u2014') + '</td>' +
            '<td style="padding:2px 4px;text-align:center;">' + (s.hit_surface ? '\u2705' : '\u274c') + '</td>' +
            '<td style="padding:2px 4px;"><button class="ga-btn ga-btn-xs" style="font-size:8px;color:#6ee7b7;" onclick="event.stopPropagation();gaSondeShowSkewT(' + i + ')">Skew-T</button></td></tr>';
    }
    html += '</table>';
    wrap.innerHTML = html;
}

// ── Sonde plan-view (colored markers at a specific pressure level) ──

var _gaSondePlanVar = null;
var _gaSondePlanLevel = 850;
var _gaSondePlanLayers = [];

function _gaFLRHColor(rh) {
    if (rh == null) return '#475569';
    if (rh < 30) return '#f87171';
    if (rh < 50) return '#fb923c';
    if (rh < 60) return '#fbbf24';
    if (rh < 70) return '#a3e635';
    if (rh < 80) return '#34d399';
    if (rh < 90) return '#06b6d4';
    return '#3b82f6';
}

function _sondePlanViewColor(varName, val) {
    if (varName === 'wspd') return _gaFLWindColor(val);
    if (varName === 'temp') return _gaFLTempColor(val);
    if (varName === 'theta_e') return _gaFLThetaEColor(val);
    if (varName === 'rh') return _gaFLRHColor(val);
    return '#60a5fa';
}

function _sondePlanViewUnits(varName) {
    if (varName === 'wspd') return 'kt';
    if (varName === 'temp') return '\u00b0C';
    if (varName === 'theta_e') return 'K';
    if (varName === 'rh') return '%';
    return '';
}

function _sondePlanViewFormat(varName, val) {
    if (val == null) return '\u2014';
    if (varName === 'wspd') return Math.round(val * 1.944) + ' kt';
    if (varName === 'temp') return val.toFixed(1) + ' \u00b0C';
    if (varName === 'theta_e') return val.toFixed(1) + ' K';
    if (varName === 'rh') return val.toFixed(0) + '%';
    return val.toFixed(1);
}

window.gaSondePlanView = function (varName) {
    _gaSondePlanVar = varName;
    var levelSel = document.getElementById('ga-sonde-pv-level');
    if (levelSel) _gaSondePlanLevel = parseInt(levelSel.value);
    // Update button active states
    var btns = document.querySelectorAll('.ga-sonde-pv-btn');
    btns.forEach(function (b) {
        var bvar = b.getAttribute('data-var');
        if ((!varName && bvar === '') || bvar === varName) {
            b.classList.add('active');
        } else {
            b.classList.remove('active');
        }
    });
    _gaSondePlanViewRender();
};

window.gaSondePlanViewRefresh = function () {
    var levelSel = document.getElementById('ga-sonde-pv-level');
    if (levelSel) _gaSondePlanLevel = parseInt(levelSel.value);
    _gaSondePlanViewRender();
};

function _gaSondePlanViewRemove() {
    for (var i = 0; i < _gaSondePlanLayers.length; i++) {
        if (detailMap) detailMap.removeLayer(_gaSondePlanLayers[i]);
    }
    _gaSondePlanLayers = [];
}

function _gaSondePlanViewRender() {
    _gaSondePlanViewRemove();
    if (!_gaSondePlanVar || !_gaSondeData || !detailMap) return;

    var targetP = _gaSondePlanLevel;
    var varName = _gaSondePlanVar;
    var tolerance = 25; // hPa

    _gaSondeData.forEach(function (s, si) {
        var prof = s.profile;
        if (!prof || !prof.pres || prof.pres.length === 0) return;

        // Find nearest pressure level
        var bestIdx = -1, bestDist = Infinity;
        for (var i = 0; i < prof.pres.length; i++) {
            if (prof.pres[i] == null) continue;
            var dist = Math.abs(prof.pres[i] - targetP);
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        if (bestIdx < 0 || bestDist > tolerance) return;

        var val = _getSondeVal(prof, varName, bestIdx);
        if (val == null) return;

        var lat = prof.lat[bestIdx];
        var lon = prof.lon[bestIdx];
        if (lat == null || lon == null) return;

        var color = _sondePlanViewColor(varName, val);
        var actualP = prof.pres[bestIdx];

        var tip = '<b>Sonde #' + (si + 1) + '</b><br>' +
            _sondePlanViewFormat(varName, val) + '<br>' +
            'at ' + Math.round(actualP) + ' hPa<br>' +
            (s.launch_time || '');

        var marker = L.circleMarker([lat, lon], {
            radius: 8, fillColor: color, fillOpacity: 0.95,
            color: '#fff', weight: 2, opacity: 1,
            pane: 'markerPane'
        }).bindTooltip(tip, { permanent: true, direction: 'top', offset: [0, -10],
                             className: 'ga-fl-tooltip',
                             style: 'font-size:10px;font-weight:600;' });

        // Show value as permanent label
        var labelIcon = L.divIcon({
            className: '',
            iconSize: [40, 14],
            iconAnchor: [20, -6],
            html: '<div style="font-size:10px;font-weight:700;color:#fff;text-shadow:0 0 4px #000,0 0 2px #000;text-align:center;white-space:nowrap;">' +
                _sondePlanViewFormat(varName, val) + '</div>'
        });
        var label = L.marker([lat, lon], { icon: labelIcon, interactive: false, pane: 'tooltipPane' });

        marker.addTo(detailMap);
        label.addTo(detailMap);
        _gaSondePlanLayers.push(marker);
        _gaSondePlanLayers.push(label);
    });
}

window.gaSondeShowSkewT = function (idx) {
    if (!_gaSondeData || idx >= _gaSondeData.length) return;
    var sonde = _gaSondeData[idx];
    var prof = sonde.profile;
    if (!prof) return;

    var panel = document.getElementById('ga-sonde-skewt-panel');
    if (panel) panel.style.display = '';

    // Build profiles object for renderSkewT
    var plev = prof.pres || [];
    var tK = (prof.temp || []).map(function (t) { return t != null ? t + 273.15 : null; });

    // Compute specific humidity from RH if dewpoint not available
    var qArr = [];
    if (prof.dewpoint && prof.dewpoint.some(function (d) { return d != null; })) {
        // Use dewpoint directly → convert to q
        for (var i = 0; i < plev.length; i++) {
            if (prof.dewpoint[i] != null && plev[i] != null) {
                var es = 6.112 * Math.exp(17.67 * prof.dewpoint[i] / (prof.dewpoint[i] + 243.5));
                qArr.push(0.622 * es / (plev[i] - es));
            } else { qArr.push(null); }
        }
    } else if (prof.rh) {
        // Compute from RH + temperature
        for (var i = 0; i < plev.length; i++) {
            if (prof.rh[i] != null && prof.temp[i] != null && plev[i] != null) {
                var esat = 6.112 * Math.exp(17.67 * prof.temp[i] / (prof.temp[i] + 243.5));
                var e = (prof.rh[i] / 100.0) * esat;
                qArr.push(0.622 * e / (plev[i] - e));
            } else { qArr.push(null); }
        }
    }

    var profiles = {
        plev: plev,
        t: tK,
        q: qArr.length > 0 ? qArr : null,
        u: prof.uwnd || null,
        v: prof.vwnd || null,
    };

    _gaSondeCurrentIdx = idx;

    // Render based on selected view mode
    if (_gaSondeViewMode === 'xsec') {
        _renderCrossSection('ga-sonde-skewt');
        return;  // cross-section doesn't depend on selected sonde
    } else if (_gaSondeViewMode === 'radial') {
        _renderRadialProfile('ga-sonde-skewt');
        return;
    } else if (_gaSondeViewMode === 'wind') {
        _renderSondeWindProfile(sonde, 'ga-sonde-skewt');
    } else if (typeof renderSkewT === 'function') {
        renderSkewT(profiles, 'ga-sonde-skewt');
    }

    // Title
    var title = document.getElementById('ga-sonde-skewt-title');
    if (title && _gaSondeViewMode === 'xsec') {
        title.textContent = 'Radius\u2013Height Cross-Section';
    } else if (title) {
        title.textContent = 'Sonde ' + (idx + 1) +
            (sonde.sonde_id ? ' (' + sonde.sonde_id + ')' : '') +
            ' \u2014 ' + (sonde.launch_time || '');
    }

    // Populate sonde selector dropdown
    var sel = document.getElementById('ga-sonde-skewt-select');
    if (sel && sel.options.length !== _gaSondeData.length) {
        sel.innerHTML = '';
        for (var j = 0; j < _gaSondeData.length; j++) {
            var opt = document.createElement('option');
            opt.value = j;
            var t = (_gaSondeData[j].launch_time || '').replace(/.*T/, '').replace('Z', '').substring(0, 8);
            opt.textContent = (j + 1) + ': ' + t;
            sel.appendChild(opt);
        }
    }
    if (sel) sel.value = idx;

    // Info panel with derived parameters
    _gaSondeRenderSkewTInfo(profiles, sonde, idx);
};

window.gaSondeCloseSkewT = function () {
    var panel = document.getElementById('ga-sonde-skewt-panel');
    if (panel) panel.style.display = 'none';
};

var _gaSondeViewMode = 'skewt';
var _gaSondeCurrentIdx = 0;

// Open cross-section or radial directly from the FL controls (no sonde selection needed)
// Move the panel above the sonde info so it's immediately visible
function _moveProfilePanelAboveSondes() {
    var panel = document.getElementById('ga-sonde-skewt-panel');
    var sondeInfo = document.getElementById('ga-sonde-info');
    if (panel && sondeInfo && panel.parentNode === sondeInfo.parentNode) {
        // Insert the profile panel before the sonde info
        sondeInfo.parentNode.insertBefore(panel, sondeInfo);
    }
}

window.gaFLOpenXSec = function () {
    _moveProfilePanelAboveSondes();
    var panel = document.getElementById('ga-sonde-skewt-panel');
    if (panel) panel.style.display = '';
    gaSondeSetView('xsec');
};
window.gaFLOpenRadial = function () {
    _moveProfilePanelAboveSondes();
    var panel = document.getElementById('ga-sonde-skewt-panel');
    if (panel) panel.style.display = '';
    gaSondeSetView('radial');
};

window.gaSondeSetView = function (mode) {
    _gaSondeViewMode = mode;
    document.getElementById('ga-sonde-view-skewt').classList.toggle('active', mode === 'skewt');
    document.getElementById('ga-sonde-view-wind').classList.toggle('active', mode === 'wind');
    document.getElementById('ga-sonde-view-xsec').classList.toggle('active', mode === 'xsec');
    document.getElementById('ga-sonde-view-radial').classList.toggle('active', mode === 'radial');
    var isStructure = (mode === 'xsec' || mode === 'radial');
    // Show/hide sonde selector (not relevant for cross-section/radial) and variable row
    var sel = document.getElementById('ga-sonde-skewt-select');
    if (sel) sel.style.display = isStructure ? 'none' : '';
    var varRow = document.getElementById('ga-xsec-var-row');
    if (varRow) varRow.style.display = isStructure ? '' : 'none';
    // Hide the derived params panel for structure views
    var info = document.getElementById('ga-sonde-skewt-info');
    if (info) info.style.display = isStructure ? 'none' : '';

    if (isStructure) {
        var panel = document.getElementById('ga-sonde-skewt-panel');
        if (panel) panel.style.display = '';
        var title = document.getElementById('ga-sonde-skewt-title');
        if (title) title.textContent = mode === 'xsec' ? 'Radius\u2013Height Cross-Section' : 'Radial Profile';
        if (mode === 'xsec') _renderCrossSection('ga-sonde-skewt');
        else _renderRadialProfile('ga-sonde-skewt');
    } else {
        gaSondeShowSkewT(_gaSondeCurrentIdx);
    }
};

function _renderSondeWindProfile(sonde, divId) {
    var prof = sonde.profile;
    if (!prof || !prof.wspd || !prof.alt_km) return;

    var altVals = [], wspdVals = [], wdirVals = [];
    for (var i = 0; i < prof.alt_km.length; i++) {
        if (prof.alt_km[i] == null || prof.wspd[i] == null) continue;
        altVals.push(prof.alt_km[i] * 1000); // convert to meters
        wspdVals.push(prof.wspd[i] * 1.944); // convert to kt
        wdirVals.push(prof.wdir ? prof.wdir[i] : null);
    }
    if (altVals.length < 3) return;

    var traces = [{
        x: wspdVals, y: altVals,
        type: 'scatter', mode: 'lines',
        name: 'Wind Speed',
        line: { color: '#60a5fa', width: 2 },
        hovertemplate: '%{x:.0f} kt at %{y:.0f} m<extra></extra>',
    }];

    // Add wind direction as a secondary trace if available
    var dirAlts = [], dirVals = [];
    for (var i = 0; i < altVals.length; i++) {
        if (wdirVals[i] != null) {
            dirAlts.push(altVals[i]);
            dirVals.push(wdirVals[i]);
        }
    }
    if (dirVals.length > 3) {
        traces.push({
            x: dirVals, y: dirAlts,
            type: 'scatter', mode: 'lines',
            name: 'Wind Dir',
            line: { color: '#fbbf24', width: 1.5, dash: 'dot' },
            xaxis: 'x2',
            hovertemplate: '%{x:.0f}\u00b0 at %{y:.0f} m<extra></extra>',
        });
    }

    var maxAlt = Math.min(Math.max.apply(null, altVals) * 1.05, 16000);

    var layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(10,22,40,0.5)',
        margin: { l: 50, r: 50, t: 35, b: 40 },
        xaxis: {
            title: { text: 'Wind Speed (kt)', font: { size: 9, color: '#60a5fa' } },
            color: '#60a5fa', tickfont: { size: 8 },
            gridcolor: 'rgba(255,255,255,0.06)', zeroline: false,
            range: [0, Math.max.apply(null, wspdVals) * 1.1],
        },
        xaxis2: {
            title: { text: 'Direction (\u00b0)', font: { size: 9, color: '#fbbf24' } },
            color: '#fbbf24', tickfont: { size: 8 },
            overlaying: 'x', side: 'top',
            range: [0, 360], dtick: 90,
            showgrid: false,
        },
        yaxis: {
            title: { text: 'Altitude (m)', font: { size: 9, color: '#8b9ec2' } },
            color: '#8b9ec2', tickfont: { size: 8 },
            gridcolor: 'rgba(255,255,255,0.06)', zeroline: false,
            range: [0, maxAlt],
        },
        legend: { font: { color: '#ccc', size: 9 }, x: 0.02, y: 0.98, bgcolor: 'rgba(0,0,0,0.4)' },
        showlegend: true,
    };

    Plotly.newPlot(divId, traces, layout, { responsive: true, displayModeBar: false });
}

// ── Radius-Height Cross-Section ─────────────────────────────────

var _xsecVar = 'wspd';

// Compute θe from T(°C), RH(%), P(hPa) using Bolton (1980) formula
function _computeThetaE(tc, rh, p) {
    if (tc == null || rh == null || p == null || p <= 0) return null;
    var tk = tc + 273.15;
    // Saturation vapor pressure (Bolton 1980)
    var es = 6.112 * Math.exp(17.67 * tc / (tc + 243.5));
    var e = (rh / 100.0) * es;
    if (e <= 0) return null;
    // Mixing ratio
    var r = 0.622 * e / (p - e);
    // LCL temperature (Bolton 1980)
    var tlcl = 1.0 / (1.0 / (tk - 55) - Math.log(rh / 100.0) / 2840.0) + 55;
    // θe (Bolton 1980, eq. 43)
    var theta_e = tk * Math.pow(1000.0 / p, 0.2854 * (1 - 0.28 * r)) *
        Math.exp((3.376 / tlcl - 0.00254) * r * 1000 * (1 + 0.81 * r));
    return isFinite(theta_e) ? theta_e : null;
}

// Get sonde profile value at a given index, computing θe if needed
function _getSondeVal(prof, varName, idx) {
    if (varName === 'wspd' && prof.wspd && prof.wspd[idx] != null) return prof.wspd[idx] * 1.944;
    if (varName === 'temp' && prof.temp && prof.temp[idx] != null) return prof.temp[idx];
    if (varName === 'rh' && prof.rh && prof.rh[idx] != null) return prof.rh[idx];
    if (varName === 'theta_e') {
        // Use stored θe if available, otherwise compute from T/RH/P
        if (prof.theta_e && prof.theta_e[idx] != null) return prof.theta_e[idx];
        if (prof.temp && prof.rh && prof.pres) {
            return _computeThetaE(prof.temp[idx], prof.rh[idx], prof.pres[idx]);
        }
    }
    return null;
}

window.gaXSecSetVar = function (v) {
    _xsecVar = v;
    document.querySelectorAll('.ga-xsec-var-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-var') === v);
    });
    // Re-render the current view (not always cross-section)
    if (_gaSondeViewMode === 'radial') _renderRadialProfile('ga-sonde-skewt');
    else _renderCrossSection('ga-sonde-skewt');
};

function _renderCrossSection(divId) {
    var el = document.getElementById(divId);
    if (!el) return;

    var track = selectedStorm ? allTracks[selectedStorm.sid] : null;
    if (!track || track.length < 2) return;

    // Get mission date for constructing ISO timestamps
    var missionDate = '';
    if (_gaFLMissions) {
        var sel = document.getElementById('ga-fl-mission-select');
        if (sel && _gaFLMissions[sel.selectedIndex]) {
            missionDate = _gaFLMissions[sel.selectedIndex].datetime;
        }
    }
    if (!missionDate) return;
    var baseDateMs = new Date(missionDate + 'T00:00:00Z').getTime();

    var rVals = [], altVals = [], colorVals = [], hoverTexts = [];
    var varLabels = { wspd: 'Wind (kt)', temp: 'Temp (°C)', theta_e: 'θe (K)', rh: 'RH (%)' };
    var varLabel = varLabels[_xsecVar] || _xsecVar;

    // ── Flight-level data ──
    var flObs = _gaFLData10s || [];
    for (var i = 0; i < flObs.length; i++) {
        var o = flObs[i];
        if (o.lat == null || o.lon == null || o.time_sec == null) continue;

        // Interpolate storm center at this observation's time
        var obsMs = baseDateMs + o.time_sec * 1000;
        var obsISO = new Date(obsMs).toISOString().substring(0, 16);
        var ctr = _findCenterAtTime(track, obsISO);
        if (!ctr) continue;

        var dx = (o.lon - ctr.lo) * 111 * Math.cos(ctr.la * Math.PI / 180);
        var dy = (o.lat - ctr.la) * 111;
        var r = Math.sqrt(dx * dx + dy * dy);
        var alt = (o.gps_alt_m != null ? o.gps_alt_m : 3000) / 1000;

        var val = null;
        if (_xsecVar === 'wspd' && o.fl_wspd_ms != null) val = o.fl_wspd_ms * 1.944;
        else if (_xsecVar === 'temp' && o.temp_c != null) val = o.temp_c;
        else if (_xsecVar === 'theta_e' && o.theta_e != null) val = o.theta_e;
        else if (_xsecVar === 'rh') continue;  // FL data doesn't have RH
        if (val == null) continue;

        rVals.push(r);
        altVals.push(alt);
        colorVals.push(val);
        hoverTexts.push(o.time + ' · r=' + r.toFixed(0) + ' km · ' + val.toFixed(1) + ' ' +
            (_xsecVar === 'wspd' ? 'kt' : _xsecVar === 'temp' ? '°C' : 'K'));
    }

    // ── Dropsonde data (filtered to current mission) ──
    var sondeRVals = [], sondeAltVals = [], sondeColorVals = [], sondeHovers = [];
    if (_gaSondeData) {
        for (var si = 0; si < _gaSondeData.length; si++) {
            var s = _gaSondeData[si];
            if (!_isSondeInMission(s, missionDate)) continue;
            var prof = s.profile;
            if (!prof || !prof.lat || !prof.alt_km) continue;

            // Interpolate center at sonde launch time
            var launchISO = (s.launch_time || '').replace('Z', '').substring(0, 16);
            var sCtr = _findCenterAtTime(track, launchISO);
            if (!sCtr) continue;

            for (var pi = 0; pi < prof.lat.length; pi++) {
                if (prof.lat[pi] == null || prof.lon[pi] == null || prof.alt_km[pi] == null) continue;

                var sdx = (prof.lon[pi] - sCtr.lo) * 111 * Math.cos(sCtr.la * Math.PI / 180);
                var sdy = (prof.lat[pi] - sCtr.la) * 111;
                var sr = Math.sqrt(sdx * sdx + sdy * sdy);
                var salt = prof.alt_km[pi];

                var sval = _getSondeVal(prof, _xsecVar, pi);
                if (sval == null) continue;

                sondeRVals.push(sr);
                sondeAltVals.push(salt);
                sondeColorVals.push(sval);
                sondeHovers.push('Sonde ' + (si + 1) + ' · r=' + sr.toFixed(0) + ' km · ' +
                    salt.toFixed(1) + ' km · ' + sval.toFixed(1));
            }
        }
    }

    // ── Color scale ──
    var colorscale, cmin, cmax;
    if (_xsecVar === 'wspd') {
        colorscale = [[0, '#3b82f6'], [0.2, '#34d399'], [0.4, '#fbbf24'],
                       [0.6, '#fb923c'], [0.8, '#f87171'], [1, '#7f1d1d']];
        cmin = 0; cmax = 180;
    } else if (_xsecVar === 'temp') {
        colorscale = [[0, '#3b82f6'], [0.3, '#22d3ee'], [0.5, '#34d399'],
                       [0.7, '#fbbf24'], [1, '#f87171']];
        cmin = -20; cmax = 30;
    } else if (_xsecVar === 'rh') {
        colorscale = [[0, '#f87171'], [0.3, '#fb923c'], [0.5, '#fbbf24'],
                       [0.7, '#34d399'], [0.85, '#06b6d4'], [1, '#3b82f6']];
        cmin = 0; cmax = 100;
    } else {
        colorscale = [[0, '#3b82f6'], [0.25, '#06b6d4'], [0.4, '#34d399'],
                       [0.6, '#fbbf24'], [0.8, '#fb923c'], [1, '#f87171']];
        cmin = 330; cmax = 370;
    }

    var traces = [];

    // Flight-level scatter
    if (rVals.length > 0) {
        traces.push({
            x: rVals, y: altVals,
            mode: 'markers', type: 'scatter',
            name: 'Flight Level',
            marker: { color: colorVals, colorscale: colorscale, cmin: cmin, cmax: cmax,
                      size: 3, opacity: 0.7,
                      colorbar: { title: varLabel, titleside: 'right', thickness: 12,
                                  len: 0.8, tickfont: { size: 8 } } },
            text: hoverTexts,
            hovertemplate: '%{text}<extra></extra>',
        });
    }

    // Sonde scatter
    if (sondeRVals.length > 0) {
        traces.push({
            x: sondeRVals, y: sondeAltVals,
            mode: 'markers', type: 'scatter',
            name: 'Dropsondes',
            marker: { color: sondeColorVals, colorscale: colorscale, cmin: cmin, cmax: cmax,
                      size: 4, opacity: 0.8, symbol: 'circle',
                      showscale: rVals.length === 0 },
            text: sondeHovers,
            hovertemplate: '%{text}<extra></extra>',
        });
    }

    if (traces.length === 0) return;

    var maxR = 300;
    var maxAlt = 16;

    var layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(10,22,40,0.5)',
        margin: { l: 50, r: 80, t: 10, b: 40 },
        xaxis: {
            title: { text: 'Radius from center (km)', font: { size: 9, color: '#8b9ec2' } },
            color: '#8b9ec2', tickfont: { size: 8 },
            gridcolor: 'rgba(255,255,255,0.06)', zeroline: true,
            zerolinecolor: 'rgba(255,255,255,0.15)',
            range: [0, maxR],
        },
        yaxis: {
            title: { text: 'Altitude (km)', font: { size: 9, color: '#8b9ec2' } },
            color: '#8b9ec2', tickfont: { size: 8 },
            gridcolor: 'rgba(255,255,255,0.06)', zeroline: false,
            range: [0, maxAlt],
        },
        legend: { font: { color: '#ccc', size: 9 }, x: 0.02, y: 0.98, bgcolor: 'rgba(0,0,0,0.4)' },
        showlegend: true,
    };

    Plotly.newPlot(divId, traces, layout, { responsive: true, displayModeBar: true, displaylogo: false });
}

function _getActiveMissionDate() {
    if (!_gaFLMissions) return '';
    var sel = document.getElementById('ga-fl-mission-select');
    return (sel && _gaFLMissions[sel.selectedIndex]) ? _gaFLMissions[sel.selectedIndex].datetime : '';
}

// Cache of FL-derived center fixes (pressure minima from eye passages)
var _flCenterFixes = null;

function _buildFLCenterFixes() {
    // Find eye passages by detecting local minima in static pressure.
    // Each minimum gives a center fix (lat, lon, time_sec).
    _flCenterFixes = [];
    var obs = _gaFLData10s;
    if (!obs || obs.length < 50) return;

    // Smooth pressure to avoid noise-triggered minima (simple 30-point running mean)
    var pSmooth = [];
    var halfWin = 15;
    for (var i = 0; i < obs.length; i++) {
        var sum = 0, cnt = 0;
        for (var j = Math.max(0, i - halfWin); j <= Math.min(obs.length - 1, i + halfWin); j++) {
            if (obs[j].static_pres_hpa != null) { sum += obs[j].static_pres_hpa; cnt++; }
        }
        pSmooth.push(cnt > 0 ? sum / cnt : null);
    }

    // Find local minima: pressure lower than surrounding ±100 points by at least 3 hPa
    var searchRadius = 100;
    for (var i = searchRadius; i < obs.length - searchRadius; i++) {
        if (pSmooth[i] == null || obs[i].lat == null) continue;
        var isMin = true;
        for (var j = i - searchRadius; j <= i + searchRadius; j++) {
            if (j === i || pSmooth[j] == null) continue;
            if (pSmooth[j] < pSmooth[i] - 0.5) { isMin = false; break; }
        }
        if (!isMin) continue;
        // Verify it's a significant minimum (at least 3 hPa below edges)
        var edgeP = Math.max(pSmooth[i - searchRadius] || 0, pSmooth[i + searchRadius] || 0);
        if (edgeP - pSmooth[i] < 3) continue;

        _flCenterFixes.push({
            la: obs[i].lat, lo: obs[i].lon,
            time_sec: obs[i].time_sec,
            pres: pSmooth[i],
        });
        // Skip ahead to avoid detecting the same eye passage multiple times
        i += searchRadius;
    }
}

function _findCenterAtTime(track, timeISO) {
    // Find storm center at a given time.
    // Priority: 1) VDM center fix (within 3h)
    //           2) FL pressure minimum (within 2h)
    //           3) IBTrACS interpolation
    var targetMs = new Date(timeISO).getTime();
    if (isNaN(targetMs)) return findTrackPointAtTime(track, timeISO);

    // 1) Check VDM fixes
    if (vdmData && vdmData.length > 0) {
        var bestVdm = null, bestDelta = Infinity;
        for (var vi = 0; vi < vdmData.length; vi++) {
            var v = vdmData[vi];
            if (v.lat == null || v.lon == null || !v.time) continue;
            var vMs = new Date(v.time).getTime();
            if (isNaN(vMs)) continue;
            var delta = Math.abs(vMs - targetMs);
            if (delta < bestDelta) { bestDelta = delta; bestVdm = v; }
        }
        if (bestVdm && bestDelta < 10800000) {
            return { la: bestVdm.lat, lo: bestVdm.lon };
        }
    }

    // 2) Check FL pressure minimum center fixes (within 2 hours)
    if (_flCenterFixes && _flCenterFixes.length > 0 && _gaFLData && _gaFLData.summary) {
        var missionDate = _getActiveMissionDate();
        if (missionDate) {
            var baseDateMs = new Date(missionDate + 'T00:00:00Z').getTime();
            var targetSec = (targetMs - baseDateMs) / 1000;
            var bestFL = null, bestFLDelta = Infinity;
            for (var fi = 0; fi < _flCenterFixes.length; fi++) {
                var fd = Math.abs(_flCenterFixes[fi].time_sec - targetSec);
                if (fd < bestFLDelta) { bestFLDelta = fd; bestFL = _flCenterFixes[fi]; }
            }
            // Use if within 2 hours (7200 seconds)
            if (bestFL && bestFLDelta < 7200) {
                return { la: bestFL.la, lo: bestFL.lo };
            }
        }
    }

    // 3) Fall back to IBTrACS interpolation
    return findTrackPointAtTime(track, timeISO);
}

function _isSondeInMission(sonde, missionDate) {
    // Check if a sonde's launch time falls on the mission date (±1 day for midnight crossings)
    if (!sonde.launch_time || !missionDate) return true; // if unknown, include it
    var sondeDate = sonde.launch_time.substring(0, 10);
    if (sondeDate === missionDate) return true;
    // Check next day for midnight-crossing missions
    var md = new Date(missionDate + 'T00:00:00Z');
    md.setUTCDate(md.getUTCDate() + 1);
    return sondeDate === md.toISOString().substring(0, 10);
}

function _renderRadialProfile(divId) {
    var el = document.getElementById(divId);
    if (!el) return;

    var track = selectedStorm ? allTracks[selectedStorm.sid] : null;
    if (!track || track.length < 2) return;

    var missionDate = _getActiveMissionDate();
    if (!missionDate) return;
    var baseDateMs = new Date(missionDate + 'T00:00:00Z').getTime();

    var varLabels2 = { wspd: 'Wind Speed (kt)', temp: 'Temperature (°C)', theta_e: 'θe (K)', rh: 'RH (%)' };
    var varColors2 = { wspd: '#60a5fa', temp: '#f87171', theta_e: '#e879f9', rh: '#06b6d4' };
    var varLabel = varLabels2[_xsecVar] || _xsecVar;
    var varColor = varColors2[_xsecVar] || '#60a5fa';

    // ── Flight-level radial profile ──
    var flR = [], flVals = [], flPres = [];
    var flObs = _gaFLData10s || [];
    for (var i = 0; i < flObs.length; i++) {
        var o = flObs[i];
        if (o.lat == null || o.lon == null || o.time_sec == null) continue;
        var obsMs = baseDateMs + o.time_sec * 1000;
        var obsISO = new Date(obsMs).toISOString().substring(0, 16);
        var ctr = _findCenterAtTime(track, obsISO);
        if (!ctr) continue;
        var dx = (o.lon - ctr.lo) * 111 * Math.cos(ctr.la * Math.PI / 180);
        var dy = (o.lat - ctr.la) * 111;
        var r = Math.sqrt(dx * dx + dy * dy);
        var val = null;
        if (_xsecVar === 'wspd' && o.fl_wspd_ms != null) val = o.fl_wspd_ms * 1.944;
        else if (_xsecVar === 'temp' && o.temp_c != null) val = o.temp_c;
        else if (_xsecVar === 'theta_e' && o.theta_e != null) val = o.theta_e;
        else if (_xsecVar === 'rh') continue;
        if (val == null) continue;
        flR.push(r);
        flVals.push(val);
        flPres.push(o.static_pres_hpa != null ? Math.round(o.static_pres_hpa) : null);
    }

    var traces = [];
    if (flR.length > 0) {
        // Individual observations colored by flight-level pressure
        traces.push({
            x: flR, y: flVals,
            type: 'scatter', mode: 'markers',
            name: 'Flight Level',
            marker: {
                color: flPres, colorscale: [[0, '#22d3ee'], [0.5, '#60a5fa'], [1, '#a78bfa']],
                cmin: 500, cmax: 900, size: 3, opacity: 0.5,
                colorbar: { title: 'hPa', titleside: 'right', thickness: 10, len: 0.5,
                             x: 1.02, tickfont: { size: 8 } },
            },
            hovertemplate: 'r=%{x:.0f} km · %{y:.1f} · %{marker.color} hPa<extra></extra>',
        });

        // Mean radial profile (5 km bins)
        var binSize = 5; // km
        var maxBin = 300;
        var binSums = {}, binCounts = {};
        for (var bi = 0; bi < flR.length; bi++) {
            var bin = Math.round(flR[bi] / binSize) * binSize;
            if (bin > maxBin) continue;
            if (!binCounts[bin]) { binSums[bin] = 0; binCounts[bin] = 0; }
            binSums[bin] += flVals[bi];
            binCounts[bin]++;
        }
        var meanR = [], meanVals = [];
        for (var b = 0; b <= maxBin; b += binSize) {
            if (binCounts[b] && binCounts[b] >= 3) { // require ≥3 obs per bin
                meanR.push(b);
                meanVals.push(binSums[b] / binCounts[b]);
            }
        }
        if (meanR.length > 3) {
            traces.push({
                x: meanR, y: meanVals,
                type: 'scatter', mode: 'lines',
                name: 'Mean Profile',
                line: { color: '#fff', width: 2.5 },
                hovertemplate: 'r=%{x:.0f} km · %{y:.1f}<extra>Mean</extra>',
            });
        }
    }

    if (traces.length === 0) return;

    var layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(10,22,40,0.5)',
        margin: { l: 55, r: 15, t: 10, b: 40 },
        xaxis: {
            title: { text: 'Radius from center (km)', font: { size: 9, color: '#8b9ec2' } },
            color: '#8b9ec2', tickfont: { size: 8 },
            gridcolor: 'rgba(255,255,255,0.06)', zeroline: true,
            zerolinecolor: 'rgba(255,255,255,0.15)', range: [0, 300],
        },
        yaxis: {
            title: { text: varLabel, font: { size: 9, color: varColor } },
            color: varColor, tickfont: { size: 8 },
            gridcolor: 'rgba(255,255,255,0.06)', zeroline: false,
        },
        legend: { font: { color: '#ccc', size: 9 }, x: 0.7, y: 0.98, bgcolor: 'rgba(0,0,0,0.4)' },
        showlegend: true,
    };

    Plotly.newPlot(divId, traces, layout, { responsive: true, displayModeBar: true, displaylogo: false });
}

function _gaSondeRenderSkewTInfo(profiles, sonde, idx) {
    var el = document.getElementById('ga-sonde-skewt-info');
    if (!el) return;

    var d = profiles._derived || {};
    var html = '<div style="font-weight:600;color:#6ee7b7;margin-bottom:6px;">Derived Parameters</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:9px;">';
    html += '<span style="color:#94a3b8;">CAPE:</span><span>' + (d.cape != null ? d.cape + ' J/kg' : '\u2014') + '</span>';
    html += '<span style="color:#94a3b8;">CIN:</span><span>' + (d.cin != null ? d.cin + ' J/kg' : '\u2014') + '</span>';
    html += '<span style="color:#94a3b8;">PWAT:</span><span>' + (d.pwat != null ? d.pwat.toFixed(1) + ' mm' : '\u2014') + '</span>';
    html += '<span style="color:#94a3b8;">LCL:</span><span>' + (d.lcl_p != null ? d.lcl_p.toFixed(0) + ' hPa' : '\u2014') + '</span>';
    html += '<span style="color:#94a3b8;">LFC:</span><span>' + (d.lfc_p != null ? d.lfc_p.toFixed(0) + ' hPa' : '\u2014') + '</span>';
    html += '<span style="color:#94a3b8;">EL:</span><span>' + (d.el_p != null ? d.el_p.toFixed(0) + ' hPa' : '\u2014') + '</span>';
    html += '<span style="color:#94a3b8;">0\u00b0C:</span><span>' + (d.freezing_p != null ? d.freezing_p.toFixed(0) + ' hPa' : '\u2014') + '</span>';
    html += '</div>';

    // Surface info
    html += '<div style="margin-top:8px;font-weight:600;color:#6ee7b7;margin-bottom:4px;">Surface</div>';
    html += '<div style="font-size:9px;">';
    html += 'Hit surface: ' + (sonde.hit_surface ? 'Yes' : 'No') + '<br>';
    if (sonde.splash_pr) html += 'Splash P: ' + sonde.splash_pr.toFixed(1) + ' hPa<br>';
    if (sonde.hyd_sfcp) html += 'Hyd SfcP: ' + sonde.hyd_sfcp.toFixed(1) + ' hPa<br>';
    html += '</div>';

    // Max wind in profile
    var prof = sonde.profile || {};
    if (prof.wspd) {
        var maxW = 0, maxWp = null;
        for (var i = 0; i < prof.wspd.length; i++) {
            if (prof.wspd[i] != null && prof.wspd[i] > maxW) {
                maxW = prof.wspd[i]; maxWp = prof.pres ? prof.pres[i] : null;
            }
        }
        if (maxW > 0) {
            html += '<div style="margin-top:6px;font-size:9px;">';
            html += 'Max wind: ' + maxW.toFixed(1) + ' m/s (' + (maxW * 1.944).toFixed(0) + ' kt)';
            if (maxWp) html += ' at ' + maxWp.toFixed(0) + ' hPa';
            html += '</div>';
        }
    }

    el.innerHTML = html;
}

// Hook: auto-fetch sondes when a FL mission loads
var _origGaFLLoadMissionData = _gaFLLoadMissionData;
// We can't directly wrap _gaFLLoadMissionData since it's a local function.
// Instead, hook into the success callback by watching _gaFLData changes.
// Simpler approach: add a call in the existing success path.
// (This is done via the _gaFLRenderOnMap call — we piggyback on it)

var _origGaFLRenderOnMap = _gaFLRenderOnMap;
_gaFLRenderOnMap = function () {
    _origGaFLRenderOnMap();
    // After FL renders on map, auto-fetch sondes and VDMs for the same mission
    if (_gaFLData && selectedStorm) {
        var missionId = _gaFLData.mission_id || '';
        var centerLat = selectedStorm.lmi_lat || selectedStorm.genesis_lat || 0;
        var centerLon = selectedStorm.lmi_lon || selectedStorm.genesis_lon || 0;
        _gaSondeFetch(selectedStorm.name, selectedStorm.year, missionId, centerLat, centerLon);
        // Fetch VDMs if not yet loaded; re-render if already loaded
        if (vdmLoaded && vdmData) {
            _vdmRenderOnMap();
        } else {
            _vdmFetch();
        }
    }
};

// Clean up sondes and VDMs on FL reset
var _origGaFLReset = _gaFLReset;
_gaFLReset = function () {
    _gaSondeHideUI();
    _gaSondeRemoveFromMap();
    _vdmReset();
    _origGaFLReset();
};
window._gaFLReset = _gaFLReset;

// ── Time Series ─────────────────────────────────────────────────

var _GA_FL_TS_CONFIG = {
    'fl_wspd_ms':      { label: 'FL Wind Speed',   btn: 'Wind',    units: 'kt', color: '#60a5fa', yaxis: 'y', scale: 1.944 },
    'static_pres_hpa': { label: 'Static Pressure',  btn: 'Pres',   units: 'hPa', color: '#fbbf24', yaxis: 'y2' },
    'sfcpr_hpa':       { label: 'Sfc Pressure',     btn: 'SfcP',   units: 'hPa', color: '#fb923c', yaxis: 'y5' },
    'temp_c':          { label: 'Temperature',       btn: 'T',     units: '\u00b0C', color: '#f87171', yaxis: 'y3' },
    'dewpoint_c':      { label: 'Dewpoint',          btn: 'Td',    units: '\u00b0C', color: '#a78bfa', yaxis: 'y3' },
    'theta_e':         { label: 'Theta-E',           btn: '\u03b8e', units: 'K',   color: '#e879f9', yaxis: 'y3' },
    'gps_alt_m':       { label: 'GPS Altitude',      btn: 'Alt',   units: 'm',   color: '#6b7280', yaxis: 'y4' },
    'vert_vel_ms':     { label: 'Vertical Velocity', btn: 'W',     units: 'm/s', color: '#a3e635', yaxis: 'y6' },
};

var _GA_FL_RES_STYLE = {
    '1s':  { opacity: 0.5, width: 1.0, color: '#0891b2' },
    '10s': { opacity: 0.7, width: 1.5, color: null },
    '30s': { opacity: 1.0, width: 2.5, color: null },
};

var _gaFLVarsVisible = { 'fl_wspd_ms': true, 'static_pres_hpa': true, 'temp_c': false, 'dewpoint_c': false, 'theta_e': false, 'gps_alt_m': false, 'sfcpr_hpa': false, 'vert_vel_ms': false };

window.gaFLOpenTimeSeries = function () {
    var panel = document.getElementById('ga-fl-ts-panel');
    if (!panel) return;
    _gaFLTSOpen = true;
    panel.style.display = '';
    // Move panel to the top of the left panel (above intensity timeline)
    var anchor = document.getElementById('ga-fl-ts-top-anchor');
    if (anchor && panel.parentNode !== anchor.parentNode) {
        anchor.parentNode.insertBefore(panel, anchor);
    }
    _gaFLPopulateVarToggles();
    if (_gaFLData) _gaFLRenderTimeSeries();
};

window.gaFLCloseTimeSeries = function () {
    var panel = document.getElementById('ga-fl-ts-panel');
    if (!panel) return;
    panel.style.display = 'none';
    _gaFLTSOpen = false;
    // Move panel back to right panel (after fl-controls)
    var flControls = document.getElementById('ga-fl-controls');
    if (flControls && panel.parentNode !== flControls.parentNode) {
        // Insert after the skew-T panel (or after fl-controls if skew-T absent)
        var skewtPanel = document.getElementById('ga-sonde-skewt-panel');
        var ref = skewtPanel || flControls;
        ref.parentNode.insertBefore(panel, ref.nextSibling);
    }
};

window.gaFLToggleRes = function (res) {
    _gaFLResVisible[res] = !_gaFLResVisible[res];
    var btns = document.querySelectorAll('.ga-fl-res-btn');
    btns.forEach(function (b) {
        var r = b.getAttribute('data-res');
        if (r === res) b.classList.toggle('active', _gaFLResVisible[res]);
    });
    if (_gaFLData) _gaFLRenderTimeSeries();
};

window.gaFLToggleXAxis = function () {
    _gaFLXAxisMode = _gaFLXAxisMode === 'time' ? 'radius' : 'time';
    var btn = document.getElementById('ga-fl-xaxis-btn');
    if (btn) btn.textContent = _gaFLXAxisMode === 'time' ? 'Time' : 'Radius';
    if (_gaFLData) _gaFLRenderTimeSeries();
};

function _gaFLPopulateVarToggles() {
    var container = document.getElementById('ga-fl-var-toggles');
    if (!container) return;
    container.innerHTML = '';
    Object.keys(_GA_FL_TS_CONFIG).forEach(function (key) {
        var cfg = _GA_FL_TS_CONFIG[key];
        var active = _gaFLVarsVisible[key];
        var btn = document.createElement('button');
        btn.className = 'ga-btn ga-btn-xs' + (active ? ' active' : '');
        btn.style.cssText = 'font-size:9px;border-color:' + cfg.color + ';color:' + cfg.color + ';' +
            (active ? 'background:' + cfg.color + '22;' : '');
        btn.textContent = cfg.btn;
        btn.onclick = function () {
            _gaFLVarsVisible[key] = !_gaFLVarsVisible[key];
            btn.classList.toggle('active', _gaFLVarsVisible[key]);
            btn.style.background = _gaFLVarsVisible[key] ? cfg.color + '22' : '';
            if (_gaFLData) _gaFLRenderTimeSeries();
        };
        container.appendChild(btn);
    });
}

function _gaFLRenderTimeSeries() {
    var chartDiv = document.getElementById('ga-fl-ts-chart');
    if (!chartDiv) return;

    var traces = [];
    var datasets = {};
    if (_gaFLResVisible['1s'] && _gaFLData1s) datasets['1s'] = _gaFLData1s;
    if (_gaFLResVisible['10s'] && _gaFLData10s) datasets['10s'] = _gaFLData10s;
    if (_gaFLResVisible['30s'] && _gaFLData30s) datasets['30s'] = _gaFLData30s;

    Object.keys(_GA_FL_TS_CONFIG).forEach(function (varKey) {
        if (!_gaFLVarsVisible[varKey]) return;
        var cfg = _GA_FL_TS_CONFIG[varKey];

        Object.keys(datasets).forEach(function (resKey) {
            var obs = datasets[resKey];
            var style = _GA_FL_RES_STYLE[resKey];
            var scaleFactor = cfg.scale || 1;
            var xVals = [], yVals = [];
            for (var i = 0; i < obs.length; i++) {
                var o = obs[i];
                var val = o[varKey];
                if (val == null || !isFinite(val)) continue;
                // Filter unrealistic values
                if (varKey === 'static_pres_hpa' && (val < 100 || val > 1100)) continue;
                if (varKey === 'sfcpr_hpa' && (val < 850 || val > 1100)) continue;
                if (varKey === 'fl_wspd_ms' && (val < 0 || val > 150)) continue;
                if (varKey === 'temp_c' && (val < -90 || val > 60)) continue;
                if (varKey === 'gps_alt_m' && (val < -100 || val > 25000)) continue;
                if (varKey === 'vert_vel_ms' && (val < -30 || val > 30)) continue;
                val = val * scaleFactor;
                var xVal;
                if (_gaFLXAxisMode === 'radius' && o.r_km != null) {
                    xVal = o.r_km;
                } else {
                    // Trim seconds and wrap hours past midnight (25:14 → 01:14)
                    var t = o.time || '';
                    var hhmm = t.length > 5 ? t.substring(0, 5) : t;
                    var hh = parseInt(hhmm.split(':')[0]);
                    if (hh >= 24) {
                        hhmm = String(hh - 24).padStart(2, '0') + hhmm.substring(2);
                    }
                    xVal = hhmm;
                }
                xVals.push(xVal);
                yVals.push(val);
            }
            if (xVals.length === 0) return;

            traces.push({
                x: xVals, y: yVals,
                mode: 'lines',
                name: cfg.btn + ' (' + resKey + ')',
                line: { color: style.color || cfg.color, width: style.width, shape: 'linear' },
                opacity: style.opacity,
                yaxis: cfg.yaxis,
                hovertemplate: '%{y:.1f} ' + cfg.units + '<extra>' + cfg.label + ' (' + resKey + ')</extra>',
                showlegend: resKey === '10s',
            });
        });
    });

    var layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        margin: { t: 10, r: 60, b: 40, l: 55 },
        font: { family: 'DM Sans, sans-serif', color: '#94a3b8', size: 10 },
        legend: { orientation: 'h', y: 1.12, font: { size: 9 } },
        xaxis: {
            title: _gaFLXAxisMode === 'time' ? 'Time (UTC)' : 'Radius from center (km)',
            gridcolor: 'rgba(255,255,255,0.06)',
            zeroline: false,
            nticks: 8,
            tickangle: 0,
        },
        yaxis: {
            title: 'Wind (kt)', titlefont: { color: '#60a5fa' },
            tickfont: { color: '#60a5fa' }, gridcolor: 'rgba(255,255,255,0.06)',
            zeroline: false, side: 'left',
        },
        yaxis2: {
            title: 'Pressure (hPa)', titlefont: { color: '#fbbf24' },
            tickfont: { color: '#fbbf24' }, overlaying: 'y', side: 'right',
            autorange: 'reversed', showgrid: false,
        },
        yaxis3: {
            title: 'Temp (\u00b0C)', titlefont: { color: '#f87171' },
            tickfont: { color: '#f87171' }, overlaying: 'y', side: 'left',
            position: 0, showgrid: false, visible: false, anchor: 'free',
        },
        yaxis4: {
            title: 'Alt (m)', titlefont: { color: '#6b7280' },
            tickfont: { color: '#6b7280' }, overlaying: 'y', side: 'right',
            showgrid: false, visible: false, anchor: 'free', position: 1,
        },
        yaxis5: {
            title: 'Sfc P (hPa)', titlefont: { color: '#fb923c' },
            tickfont: { color: '#fb923c' }, overlaying: 'y', side: 'right',
            autorange: 'reversed', showgrid: false, visible: false,
            anchor: 'free', position: 0.95,
        },
        yaxis6: {
            title: 'W (m/s)', titlefont: { color: '#a3e635' },
            tickfont: { color: '#a3e635', size: 8 }, overlaying: 'y', side: 'right',
            showgrid: false, visible: false, anchor: 'free', position: 0.92,
            zeroline: true, zerolinecolor: 'rgba(163,230,53,0.2)',
        },
    };

    if (_gaFLVarsVisible['temp_c'] || _gaFLVarsVisible['dewpoint_c'] || _gaFLVarsVisible['theta_e']) {
        layout.yaxis3.visible = true;
    }
    if (_gaFLVarsVisible['gps_alt_m']) {
        layout.yaxis4.visible = true;
    }
    if (_gaFLVarsVisible['sfcpr_hpa']) {
        layout.yaxis5.visible = true;
    }
    if (_gaFLVarsVisible['vert_vel_ms']) {
        layout.yaxis6.visible = true;
    }

    // Add VDM min SLP markers on pressure axis (filtered to mission time window)
    if (vdmData && vdmData.length > 0 && _gaFLData && _gaFLData.summary) {
        var summ = _gaFLData.summary;
        var missionDate = '';
        if (_gaFLMissions) {
            var sel = document.getElementById('ga-fl-mission-select');
            if (sel && _gaFLMissions[sel.selectedIndex]) {
                missionDate = _gaFLMissions[sel.selectedIndex].datetime;
            }
        }
        // Mission time window in seconds (with ±30 min buffer)
        var mStartSec = 0, mEndSec = 86400;
        if (summ.start_time) {
            var sp = summ.start_time.split(':');
            mStartSec = parseInt(sp[0]) * 3600 + parseInt(sp[1]) * 60 - 1800;
        }
        if (summ.end_time) {
            var ep = summ.end_time.split(':');
            mEndSec = parseInt(ep[0]) * 3600 + parseInt(ep[1]) * 60 + 1800;
            if (mEndSec < mStartSec) mEndSec += 86400; // crossed midnight
        }

        // For midnight-crossing missions, also accept VDMs from the next calendar day
        var missionDateNext = '';
        if (missionDate) {
            var md = new Date(missionDate + 'T00:00:00Z');
            md.setUTCDate(md.getUTCDate() + 1);
            missionDateNext = md.toISOString().substring(0, 10);
        }

        var vdmPTimes = [], vdmPVals = [], vdmPHovers = [];
        vdmData.forEach(function (v) {
            if (!v.time) return;
            // Must have at least SLP or wind to display
            if (v.min_slp_hpa == null && v.max_fl_wind_kt == null) return;
            var vDate = v.time.substring(0, 10);
            var vHH = parseInt(v.time.substring(11, 13));
            var vMM = parseInt(v.time.substring(14, 16));
            var vSec = vHH * 3600 + vMM * 60;

            // For VDMs on the next calendar day (midnight crossing), add 24h to vSec
            if (missionDate && vDate === missionDateNext) {
                vSec += 86400;
            } else if (missionDate && vDate !== missionDate) {
                return;  // wrong day entirely
            }

            if (vSec < mStartSec || vSec > mEndSec) return;

            // Wrap hours for x-axis label (match FL time series format)
            var displayHH = vHH;
            if (vDate === missionDateNext) displayHH = vHH + 24;  // keep raw for offset calc
            var wrappedHH = displayHH >= 24 ? displayHH - 24 : displayHH;
            var tHHMM = String(wrappedHH).padStart(2, '0') + ':' + String(vMM).padStart(2, '0');
            var hover = '<b>VDM OB ' + (v.ob_number || '?') + '</b><br>' +
                (v.aircraft || '') + ' ' + (v.mission_id || '') + '<br>' +
                'Min SLP: ' + v.min_slp_hpa + ' hPa';
            if (v.max_fl_wind_kt != null) hover += '<br>Max FL: ' + v.max_fl_wind_kt + ' kt';
            if (v.eye_diameter_nm != null) hover += '<br>Eye: ' + v.eye_diameter_nm + ' nm ' + (v.eye_shape || '');
            if (v.max_sfmr_kt != null) hover += '<br>SFMR: ' + v.max_sfmr_kt + ' kt';

            if (v.min_slp_hpa != null && v.min_slp_hpa >= 850) {
                vdmPTimes.push(tHHMM);
                vdmPVals.push(v.min_slp_hpa);
                vdmPHovers.push(hover);
            }
        });

        if (vdmPTimes.length > 0) {
            traces.push({
                x: vdmPTimes, y: vdmPVals,
                type: 'scatter', mode: 'markers',
                name: 'VDM SLP',
                marker: { color: '#ef4444', symbol: 'star-diamond', size: 12,
                          line: { color: '#fff', width: 1.5 } },
                hovertemplate: '%{text}<extra></extra>',
                text: vdmPHovers,
                yaxis: 'y2', showlegend: true,
            });
        }
    }

    Plotly.newPlot('ga-fl-ts-chart', traces, layout, { responsive: true, displayModeBar: true, displaylogo: false });

    // Click-to-highlight on map
    chartDiv.on('plotly_click', function (data) {
        if (!data.points || !data.points[0]) return;
        var pt = data.points[0];
        var obs10 = _gaFLData10s;
        if (!obs10) return;
        var xVal = pt.x;
        var bestObs = null, bestDist = Infinity;
        for (var i = 0; i < obs10.length; i++) {
            var cmp = _gaFLXAxisMode === 'radius' ? obs10[i].r_km : obs10[i].time;
            if (cmp == null) continue;
            var dist = typeof cmp === 'number' ? Math.abs(cmp - (typeof xVal === 'number' ? xVal : 0)) : (cmp === xVal ? 0 : 1);
            if (dist < bestDist) { bestDist = dist; bestObs = obs10[i]; }
        }
        if (bestObs && bestObs.lat != null && detailMap) {
            if (_gaFLTSHighlight) detailMap.removeLayer(_gaFLTSHighlight);
            _gaFLTSHighlight = L.circleMarker([bestObs.lat, bestObs.lon], {
                radius: 8, fillColor: '#fff', fillOpacity: 0.9,
                color: '#60a5fa', weight: 3
            }).addTo(detailMap);
            detailMap.panTo([bestObs.lat, bestObs.lon]);
        }
    });
}

})();
