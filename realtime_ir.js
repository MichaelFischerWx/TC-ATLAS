/* ═══════════════════════════════════════════════════════════════
   Real-Time Monitor — realtime_ir.js
   Self-contained IIFE for the Real-Time Monitor page.
   Provides: global map with active TC markers, click-through
   to storm detail with IR animation + intensity timeline.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Config ──────────────────────────────────────────────────
    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    var DEFAULT_LOOKBACK_HOURS = 6;
    var DEFAULT_RADIUS_DEG = 10.0;

    // ── IR Colormap LUTs (for client-side raw Tb rendering) ────
    var IR_COLORMAPS = {};
    var irSelectedColormap = 'claude-ir';

    // Raw Tb frame storage — parallel to animFrameLayers
    var rawTbFrames = [];  // array of {tb_data: Uint8Array, rows, cols, bounds}

    (function buildColormaps() {
        function buildLUT(stops) {
            var lut = new Uint8Array(256 * 4);
            lut[0] = 0; lut[1] = 0; lut[2] = 0; lut[3] = 0;
            for (var i = 1; i <= 255; i++) {
                var frac = 1.0 - (i - 1) / 254.0;
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

        function buildLUTfromTb(tbStops) {
            var vmin = 160.0, vmax = 330.0;
            var fracStops = tbStops.map(function(s) {
                return {f: 1.0 - (s.tb - vmin) / (vmax - vmin), r: s.r, g: s.g, b: s.b};
            });
            fracStops.sort(function(a, b) { return a.f - b.f; });
            return buildLUT(fracStops);
        }

        // Enhanced IR — NOAA-style
        IR_COLORMAPS['enhanced'] = buildLUT([
            {f: 0.00, r:   8, g:   8, b:   8},
            {f: 0.15, r:  40, g:  40, b:  40},
            {f: 0.30, r:  90, g:  90, b:  90},
            {f: 0.40, r: 140, g: 140, b: 140},
            {f: 0.50, r: 200, g: 200, b: 200},
            {f: 0.55, r:   0, g: 180, b: 255},
            {f: 0.60, r:   0, g: 100, b: 255},
            {f: 0.65, r:   0, g: 255, b:   0},
            {f: 0.70, r: 255, g: 255, b:   0},
            {f: 0.75, r: 255, g: 180, b:   0},
            {f: 0.80, r: 255, g:  80, b:   0},
            {f: 0.85, r: 255, g:   0, b:   0},
            {f: 0.90, r: 180, g:   0, b: 180},
            {f: 0.95, r: 255, g: 180, b: 255},
            {f: 1.00, r: 255, g: 255, b: 255}
        ]);

        // Dvorak Enhanced
        IR_COLORMAPS['dvorak'] = buildLUTfromTb([
            {tb: 170, r: 255, g: 255, b: 255},
            {tb: 183, r: 255, g:   0, b: 255},
            {tb: 193, r: 255, g:   0, b:   0},
            {tb: 203, r: 255, g: 128, b:   0},
            {tb: 213, r: 255, g: 255, b:   0},
            {tb: 223, r:   0, g: 255, b:   0},
            {tb: 233, r:   0, g: 128, b: 255},
            {tb: 243, r:   0, g:   0, b: 255},
            {tb: 253, r: 128, g: 128, b: 128},
            {tb: 273, r: 180, g: 180, b: 180},
            {tb: 293, r:  60, g:  60, b:  60},
            {tb: 310, r:  10, g:  10, b:  10}
        ]);

        // BD Grayscale
        IR_COLORMAPS['grayscale'] = (function () {
            var vmin = 160.0, vmax = 330.0;
            var lut = new Uint8Array(256 * 4);
            lut[0] = 0; lut[1] = 0; lut[2] = 0; lut[3] = 0;
            for (var i = 1; i <= 255; i++) {
                var tb = vmin + (i - 1) * (vmax - vmin) / 254.0;
                var gray;
                if (tb < 193) gray = 85;
                else if (tb < 198) gray = 135;
                else if (tb < 204) gray = 255;
                else if (tb < 210) gray = 0;
                else if (tb < 220) gray = 160;
                else if (tb < 232) gray = 110;
                else if (tb < 243) gray = 60;
                else if (tb < 282) gray = Math.round(202 + (tb - 243) * (109 - 202) / (282 - 243));
                else if (tb <= 303) gray = Math.round(255 + (tb - 282) * (0 - 255) / (303 - 282));
                else gray = 0;
                gray = Math.max(0, Math.min(255, gray));
                var idx = i * 4;
                lut[idx] = gray; lut[idx + 1] = gray; lut[idx + 2] = gray; lut[idx + 3] = 255;
            }
            return lut;
        })();

        // Funktop
        IR_COLORMAPS['funktop'] = buildLUTfromTb([
            {tb: 309, r:   0, g:   0, b:   0},
            {tb: 308, r:  20, g:  20, b:  20},
            {tb: 255, r: 216, g: 216, b: 216},
            {tb: 254.9, r: 100, g: 100, b:   0},
            {tb: 235, r: 248, g: 248, b:   0},
            {tb: 234.9, r:   0, g:   0, b: 120},
            {tb: 215, r:   0, g: 252, b: 252},
            {tb: 214.9, r:  84, g:   0, b:   0},
            {tb: 203, r: 252, g:   0, b:   0},
            {tb: 202.9, r: 252, g:  80, b:  80},
            {tb: 195, r: 252, g: 140, b: 140},
            {tb: 194.9, r:   0, g: 252, b:   0},
            {tb: 182, r: 252, g: 252, b: 252},
            {tb: 181, r: 252, g: 252, b: 252}
        ]);

        // AVN
        IR_COLORMAPS['avn'] = buildLUTfromTb([
            {tb: 310, r:   0, g:   0, b:   0},
            {tb: 243, r: 255, g: 255, b: 255},
            {tb: 242.9, r:   0, g: 150, b: 255},
            {tb: 223, r:   0, g: 110, b: 150},
            {tb: 222.9, r: 160, g: 160, b:   0},
            {tb: 213, r: 250, g: 250, b:   0},
            {tb: 212.9, r: 250, g: 250, b:   0},
            {tb: 203, r: 200, g: 120, b:   0},
            {tb: 202.9, r: 250, g:   0, b:   0},
            {tb: 193, r: 200, g:   0, b:   0},
            {tb: 192, r:  88, g:  88, b:  88}
        ]);

        // NHC
        IR_COLORMAPS['nhc'] = buildLUTfromTb([
            {tb: 298, r:   0, g:   0, b:   0},
            {tb: 297, r:   0, g:   0, b:  24},
            {tb: 282, r:   0, g:   0, b: 252},
            {tb: 262, r:   0, g: 252, b:   0},
            {tb: 242, r: 252, g:   0, b:   0},
            {tb: 203, r: 252, g: 248, b: 248},
            {tb: 202.9, r: 216, g: 216, b: 216},
            {tb: 170, r: 252, g: 252, b: 252}
        ]);

        // RAMMB
        IR_COLORMAPS['rammb'] = buildLUTfromTb([
            {tb: 310, r: 181, g:  85, b:  85},
            {tb: 298, r:   0, g:   0, b:   0},
            {tb: 243, r: 254, g: 254, b: 254},
            {tb: 242.9, r: 168, g: 253, b: 253},
            {tb: 223, r:  84, g:  84, b:  84},
            {tb: 222.9, r:   0, g:   0, b: 103},
            {tb: 213, r:   0, g:   0, b: 254},
            {tb: 212.9, r:   0, g:  96, b:  13},
            {tb: 203, r:   0, g: 252, b:   0},
            {tb: 202.9, r:  77, g:  13, b:   0},
            {tb: 193, r: 251, g:   0, b:   0},
            {tb: 192.9, r: 252, g: 252, b:   0},
            {tb: 183, r:   0, g:   0, b:   0},
            {tb: 182.9, r: 255, g: 255, b: 255},
            {tb: 173, r:   4, g:   4, b:   4}
        ]);

        // IRB
        IR_COLORMAPS['irb'] = buildLUTfromTb([
            {tb: 303, r:  18, g:  18, b:  18},
            {tb: 283, r: 120, g: 120, b: 120},
            {tb: 278, r: 215, g: 217, b: 219},
            {tb: 273, r: 252, g: 252, b: 252},
            {tb: 263, r:  43, g:  57, b: 161},
            {tb: 253, r:  61, g: 173, b: 143},
            {tb: 238, r: 255, g: 249, b:  87},
            {tb: 233, r: 227, g: 192, b:  36},
            {tb: 218, r: 166, g:  35, b:  63},
            {tb: 213, r:  77, g:  13, b:   7},
            {tb: 203, r: 150, g:  73, b: 201},
            {tb: 193, r: 224, g: 224, b: 255},
            {tb: 173, r:   0, g:   0, b:   0}
        ]);

        // Claude — custom TC analysis enhancement
        IR_COLORMAPS['claude-ir'] = buildLUTfromTb([
            {tb: 310, r:  12, g:  12, b:  22},    // warm surface: near-black
            {tb: 293, r:  70, g:  70, b:  82},    // warm: dark grey-blue
            {tb: 283, r: 120, g: 120, b: 132},    // mild: medium grey
            {tb: 273, r: 180, g: 180, b: 192},    // freezing: light grey
            {tb: 263, r: 216, g: 218, b: 228},    // cold: pale blue-grey
            {tb: 253, r: 140, g: 210, b: 220},    // -20°C: light teal
            {tb: 248, r:  68, g: 180, b: 196},    // -25°C: teal
            {tb: 243, r:  32, g: 148, b: 166},    // -30°C: deep teal
            {tb: 238, r:  40, g: 178, b: 116},    // -35°C: teal-green
            {tb: 233, r:  96, g: 208, b:  68},    // -40°C: green
            {tb: 228, r: 192, g: 220, b:  40},    // -45°C: yellow-green
            {tb: 223, r: 238, g: 196, b:  48},    // -50°C: gold
            {tb: 218, r: 228, g: 132, b:  48},    // -55°C: orange
            {tb: 213, r: 214, g:  78, b:  56},    // -60°C: red-orange
            {tb: 208, r: 180, g:  36, b:  68},    // -65°C: crimson
            {tb: 203, r: 196, g:  48, b: 156},    // -70°C: magenta
            {tb: 198, r: 168, g:  64, b: 200},    // -75°C: purple
            {tb: 193, r: 120, g:  48, b: 180},    // -80°C: deep violet
            {tb: 183, r:  64, g:  24, b: 140},    // -90°C: indigo
            {tb: 173, r:  28, g:  12, b:  96}     // -100°C: near-black indigo
        ]);
    })();

    /** Decode base64 tb_data into Uint8Array */
    function decodeTbData(base64str) {
        var binary = atob(base64str);
        var arr = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            arr[i] = binary.charCodeAt(i);
        }
        return arr;
    }

    // ── Natural Earth coastline GeoJSON cache ──────────────────
    var _coastlineGeoJSON = null;
    var _coastlineLoading = false;
    var _coastlineQueue = [];

    function _loadCoastlineOverlay(targetMap) {
        function _addToMap(geojson, m) {
            L.geoJSON(geojson, {
                pane: 'coastlinePane',
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
        if (_coastlineGeoJSON) { _addToMap(_coastlineGeoJSON, targetMap); return; }
        _coastlineQueue.push(targetMap);
        if (_coastlineLoading) return;
        _coastlineLoading = true;
        fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson')
            .then(function (r) { return r.json(); })
            .then(function (geojson) {
                _coastlineGeoJSON = geojson;
                _coastlineQueue.forEach(function (m) { _addToMap(geojson, m); });
                _coastlineQueue = [];
            })
            .catch(function () { _coastlineQueue = []; })
            .finally(function () { _coastlineLoading = false; });
    }

    // NASA GIBS WMTS tile config for IR imagery
    var GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
    var GIBS_IR_LAYERS = {
        'GOES-East':  'GOES-East_ABI_Band13_Clean_Infrared',
        'GOES-West':  'GOES-West_ABI_Band13_Clean_Infrared',
        'Himawari':   'Himawari_AHI_Band13_Clean_Infrared'
    };
    var GIBS_TILEMATRIX = 'GoogleMapsCompatible_Level6';
    var GIBS_MAX_ZOOM = 6;  // GIBS geostationary IR imagery max zoom
    var GIBS_IR_INTERVAL_MIN = 10;  // GIBS tiles every 10 minutes

    // GIBS GeoColor (true-colour day, blended IR night) — higher zoom
    var GIBS_GEOCOLOR_LAYERS = {
        'GOES-East':  'GOES-East_ABI_GeoColor',
        'GOES-West':  'GOES-West_ABI_GeoColor',
        'Himawari':   null  // no native GIBS GeoColor; synthesized via day(vis)/night(IR) switching
    };
    // GIBS Red Visible (single-band daytime-only)
    var GIBS_VIS_LAYERS = {
        'GOES-East':  'GOES-East_ABI_Band2_Red_Visible_1km',
        'GOES-West':  'GOES-West_ABI_Band2_Red_Visible_1km',
        'Himawari':   'Himawari_AHI_Band3_Red_Visible_1km'
    };
    var GIBS_VIS_TILEMATRIX = 'GoogleMapsCompatible_Level7';
    var GIBS_VIS_MAX_ZOOM = 7;

    // Satellite coverage zones for seamless compositing.
    // Each satellite has a "core" range (full opacity) and a narrow cross-fade
    // at the boundary to the adjacent satellite.  Core zones are set so that
    // GOES-East and GOES-West meet cleanly near -110° with a tight 5° blend
    // (the old 25° blend created a visible 40° swath of blurry dual-source
    // compositing over the western US).  The Africa/Middle East gap (no
    // Meteosat in GIBS) is handled by the nearest-satellite fallback.
    //
    // ALL longitudes here are in -180..180 convention. Himawari's coreEast
    // can wrap past +180 (encoded as a negative number); resolveSatZones
    // below produces the active zone list with that wrap honored when
    // GOES-West is stale.
    var SAT_ZONES_BASE = [
        { name: 'GOES-East', sublon: -75.2,  coreWest: -110, coreEast:   15 },
        { name: 'GOES-West', sublon: -137.2, coreWest: -180, coreEast: -110 },
        { name: 'Himawari',  sublon:  140.7, coreWest:   60, coreEast:  180 }
    ];
    var BLEND_WIDTH_DEG = 5; // narrow cross-fade to avoid blurry dual-source artifacts

    /** Resolve the active satellite zones for the current stale state.
     *
     *  When GOES-West is healthy the three zones cover the globe with no
     *  gap (GOES-East: -110→+15, GOES-West: -180→-110, Himawari: +60→+180).
     *
     *  When GOES-West is stale (frequent occurrence for the East Pac), we
     *  extend Himawari EAST past the dateline to ~-150° and pull GOES-East
     *  WEST to the same -150° meridian, producing a sharp Himawari/GOES-East
     *  seam in the mid East Pacific instead of the previous gray gap.
     *  -150° is roughly equidistant from the two sub-satellite points
     *  (Himawari at +140.7° = 70.7° away, GOES-East at -75.2° = 74.8° away),
     *  so neither side's parallax is dramatically worse than the other's.
     */
    var GW_STALE_SEAM_LON = -150;

    function resolveSatZones() {
        var goesWestStale = !!staleGIBSSats['GOES-West'];
        if (!goesWestStale) return SAT_ZONES_BASE;
        return [
            { name: 'GOES-East', sublon: -75.2,  coreWest: GW_STALE_SEAM_LON, coreEast: 15 },
            // GOES-West omitted while stale so its zone doesn't shadow the
            // other satellites in the score loop.
            { name: 'Himawari',  sublon: 140.7, coreWest: 60, coreEast: GW_STALE_SEAM_LON }
            // Note: Himawari's coreEast (GW_STALE_SEAM_LON = -150) is LESS
            // than its coreWest (+60), signalling the dateline wrap. The
            // lonInCore helper handles that case.
        ];
    }

    /** Is `lon` (in -180..180) inside the zone [west, east]? Handles
     *  the wrap case where east < west (zone crosses the dateline). */
    function lonInCore(lon, west, east) {
        if (west <= east) return lon >= west && lon <= east;
        return lon >= west || lon <= east;  // wrap
    }

    /** Score a satellite zone for a tile at `centerLon`. 1.0 inside the
     *  core; negative (closer to 0 = better) outside. Uses spherical
     *  wraparound when measuring distance so the "outside" of a wrap
     *  zone correctly references its edges. */
    function scoreSatForLon(zone, centerLon) {
        if (lonInCore(centerLon, zone.coreWest, zone.coreEast)) return 1.0;
        function angDist(a, b) {
            var d = Math.abs(a - b);
            return Math.min(d, 360 - d);
        }
        return -Math.min(
            angDist(centerLon, zone.coreWest),
            angDist(centerLon, zone.coreEast)
        );
    }

    // Sub-satellite longitudes for choosing best satellite per storm
    var SAT_SUBLONS = [
        { name: 'GOES-East', sublon: -75.2 },
        { name: 'GOES-West', sublon: -137.2 },
        { name: 'Himawari',  sublon: 140.7 }
    ];

    // Saffir-Simpson color palette (matches global_archive.js)
    var SS_COLORS = {
        TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
        C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626'
    };

    // ── GA4 helper ──────────────────────────────────────────────
    function _ga(action, params) {
        if (typeof gtag === 'function') {
            try { gtag('event', action, params || {}); } catch (e) { /* silent */ }
        }
    }

    // ── State ───────────────────────────────────────────────────
    var map = null;
    var stormMarkers = [];     // L.marker references
    var stormData = [];        // latest active-storms response
    var pollTimer = null;
    var currentStormId = null; // ATCF ID of detail view

    // Basin activity sidebar
    var basinSidebarVisible = false;
    var seasonSummaryData = null;
    var seasonSummaryTimer = null;
    var SEASON_SUMMARY_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

    var BASIN_NAMES = {
        NA: 'North Atlantic', EP: 'East Pacific', WP: 'West Pacific',
        NI: 'North Indian', SI: 'South Indian', SP: 'South Pacific'
    };
    var BASIN_COLORS = {
        NA: '#2e7dff', EP: '#00d4ff', WP: '#f87171',
        NI: '#fbbf24', SI: '#34d399', SP: '#a78bfa'
    };
    var gibsIRLayers = [];     // GIBS IR tile layers on main map
    var trackLayers = [];      // past track polylines + dots on main map

    // Global map product state
    var globalProduct = 'eir';       // 'eir' or 'geocolor'
    var _labelsLayer = null;         // CARTO place-name tile layer (toggleable)
    var _labelsVisible = false;      // default: labels off (toggle in the top-left stack)
    var gibsVisLayers = [];          // GIBS GeoColor tile layers on main map
    var latestGIBSTime = null;       // cached latest GIBS time string (oldest satellite — used for animation)
    var latestGIBSTimes = {};         // per-satellite latest times, e.g. {'GOES-East': '...', 'Himawari': '...'}
    var staleGIBSSats = {};            // {satName: true} — satellites whose GIBS feed is currently stale; used to backfill from neighbors

    // Global map animation state
    var GLOBAL_ANIM_LOOKBACK_H = 4;  // 4-hour lookback for global animation
    var GLOBAL_ANIM_STEP_MIN = 30;   // 30-min steps
    var globalAnimFrameTimes = [];    // ISO time strings
    var globalAnimFrameLayers = [];   // parallel composite L.GridLayer (one per frame, opacity 0 until shown)
    var globalAnimIndex = 0;
    var globalAnimPlaying = false;
    var globalAnimTimer = null;       // rAF handle (global view)
    var globalAnimLastTick = 0;       // timestamp of last frame advance (global view)
    var globalAnimLoaded = 0;
    var globalAnimReady = false;
    var globalAnimLoading = false;    // true while frames are being pre-loaded
    var globalAnimSpeedIdx = 1;        // index into GLOBAL_ANIM_SPEEDS
    var GLOBAL_ANIM_SPEEDS = [
        { label: '0.5×', ms: 1200 },
        { label: '1×',   ms: 600 },
        { label: '1.5×', ms: 400 },
        { label: '2×',   ms: 300 }
    ];

    // Storm detail mini-map state
    var detailMap = null;
    var detailTrackLayers = [];
    var detailSatName = '';     // which satellite is used for this storm
    var detailStormLat = 0;    // storm latitude for solar position calc
    var detailStormLon = 0;    // storm longitude for solar position calc

    // Pre-loaded frame animation state
    var animFrameTimes = [];   // array of ISO time strings
    var animFrameLayers = [];  // parallel array of L.tileLayer (one per frame)
    var animIndex = 0;
    var animPlaying = false;
    var animTimer = null;       // rAF handle (detail view)
    var animLastTick = 0;       // timestamp of last frame advance (detail view)
    var animIntervalMs = 500;   // detail view frame interval (ms)
    var framesLoaded = 0;      // how many frames have finished loading tiles
    var framesReady = false;   // true once all frames loaded
    var validFrames = [];      // indices of frames that loaded actual tile data
    var frameHasError = [];    // parallel to animFrameLayers — true if frame had tile errors

    // ── Model Forecast Overlay State ──────────────────────────────
    var _rtModelData = null;           // Full a-deck response from API
    var _rtModelVisible = false;       // Overlay is active
    var _rtModelAutoSync = true;       // Auto-switch cycle based on IR frame time
    var _rtModelShowIntensity = true;  // Show intensity forecasts on chart
    var _rtModelActiveCycle = null;    // Currently displayed init time (YYYYMMDDHH)
    var _rtModelTrackLayers = [];      // Leaflet polylines on map
    var _rtModelMarkerLayers = [];     // Leaflet circle markers for forecast points
    var _rtModelLegendModels = [];     // Models visible in current cycle
    var _rtModelLastAtcf = null;       // Last ATCF ID loaded
    var _rtModelTypeFilters = { official: true, dynamical: true, ai: true, consensus: true, statistical: false };
    var _rtModelShowInterp = false;    // false = show all, true = interpolated/late-cycle only
    var _rtModelIntensityTraces = [];  // Plotly trace indices for intensity chart

    // ── DeepMind WeatherLab Ensemble State ────────────────────
    var _rtWeatherlabData = null;      // API response
    var _rtWeatherlabVisible = false;  // toggle state
    var _rtWeatherlabLayers = [];      // Leaflet polylines
    var _rtWeatherlabMarkers = [];     // Leaflet circle markers
    var _rtWeatherlabMeanTraces = [];  // Plotly trace indices
    var _rtWeatherlabMinCat = null;    // min category filter (null = show all)

    // ── DeepMind 1000-Member Ensemble Distribution State ──────
    var _rtDmEnsData = null;           // API response from /weatherlab-ensemble

    // ── Global DeepMind Ensemble Overlay (RT main map) ────────
    var _rtGlobalWLData = null;        // API response from /weatherlab-global
    var _rtGlobalWLVisible = false;    // toggle state
    var _rtGlobalWLLoading = false;
    var _rtGlobalWLLayers = [];        // Leaflet polylines + markers on `map`

    // ── FNV3 LARGE_ENSEMBLE Cyclogenesis Overlay (RT main map) ─
    // Distinct from the paired global weatherlab toggle above: this
    // shows the 1000-member pre-genesis tracks (no ATCF pairing
    // required), so it surfaces forecast cyclogenesis days before NHC
    // numbers an invest.
    var _rtGenesisData = null;
    // Precomputed TC-ATLAS clusters from the backend. Loaded after the
    // capped /weatherlab-genesis feed and used directly by the TCA
    // dispatcher — eliminates the per-user ~8 MB prefetch and the
    // transition window where the hover showed projection-based numbers.
    // Keyed by (init_time, params) so tuner-slider changes invalidate.
    var _rtGenesisClusters = null;        // { init_time, params, clusters }
    var _rtGenesisClustersLoading = false;
    var _rtGenesisVisible = false;
    var _rtGenesisLoading = false;
    var _rtGenesisLayers = [];
    // Optional per-member spaghetti layer — opt-in via the Layers menu
    // sub-toggle. Off by default because the disturbance markers above
    // are the canonical glance-view; spaghetti is for users who want
    // to see the per-member spread visually.
    var _rtGenesisSpaghettiVisible = false;
    var _rtGenesisSpaghettiLayers = [];
    // Raw ensemble layer — every member's first-genesis dot + its
    // track polyline, independent of any clustering. Sister toggle to
    // Cyclogenesis disturbances (not a sub-toggle). Chaotic but gives
    // the analyst the full ensemble distribution as context.
    var _rtGenesisRawVisible = false;
    var _rtGenesisRawLayers = [];
    // Disturbance clustering method.
    //   'deepmind' — trust DeepMind's CSV track_id grouping (each
    //                row's track_id field is the cluster boundary)
    //   'tcatlas'  — DBSCAN-style cluster on per-member first-genesis
    //                points (we ignore DeepMind's track_id and group
    //                trajectories whose first-cross-of-34kt positions
    //                lie within _GENESIS_CLUSTER_EPS_KM of each other)
    // Available as an A/B toggle in the Layers menu so a forecaster
    // can see whether the two methods agree on the current basin.
    // Default to the TC-ATLAS density-peak method — it splits nearby
    // distinct systems (e.g., WPac storm vs Philippines disturbance)
    // far better than DeepMind's track_id grouping does for this kind
    // of basin. DeepMind chip is still one click away if a forecaster
    // wants the raw source-side groupings.
    var _genesisClusterMethod = 'tcatlas';
    // Tuner disclosure state — collapsed by default. The user can
    // expand it via the disclosure summary; their preference persists
    // across menu re-renders within the page session.
    var _genesisTunerOpen = false;
    // 25 members = 2.5% of the 1000-member FNV3 ensemble. Lowered from
    // the original 5% (50) after live tuning showed that the density-
    // peak algorithm cleanly separates real disturbances at this
    // threshold without admitting noise clusters.
    var _GENESIS_CLUSTER_MIN_MEMBERS = 25;
    // Density-based clustering tunables.
    //
    // Algorithm (replaces the previous trajectory-overlap union-find,
    // which suffered from transitive merges where a single chain-link
    // pair lumped two physically distinct systems together):
    //
    //   1. For every member trajectory that reaches 34 kt, record its
    //      first-genesis (lat, lon).
    //   2. Bin those points into a 2D grid (cell = GRID_DEG degrees).
    //   3. A cell is a "density peak" iff its count ≥ PEAK_MIN_MEMBERS
    //      AND ≥ every neighboring cell in the 3×3 window. Adjacent
    //      cells of equal count are de-duplicated by keeping the
    //      higher-density (or earlier-in-sweep) cell as the peak.
    //   4. Assign each member to the NEAREST peak within
    //      ASSIGN_RADIUS_KM. Members beyond that radius from any peak
    //      are dropped from the clustered view.
    //   5. Final clusters keep only those with ≥ MIN_CLUSTER_MEMBERS.
    //
    // Why no transitivity: each member is independently assigned to
    // its nearest peak. Two distinct density peaks remain separate
    // regardless of how many members drift between them. Nearby
    // systems with their own density concentrations get their own
    // markers; transit members get pulled to whichever peak they're
    // closer to.
    var _GENESIS_GRID_DEG           = 3;     // density bin size (degrees)
    var _GENESIS_PEAK_MIN_MEMBERS   = 8;     // cell count to qualify as peak
    var _GENESIS_ASSIGN_RADIUS_KM   = 750;   // max distance member ↔ peak
    // Time-window for member-to-peak assignment. A member's first-
    // genesis tau must be within ±_GENESIS_TIME_WINDOW_H of the peak's
    // mean first-genesis tau (computed from members whose first-genesis
    // lat/lon falls inside the peak cell). Prevents merging two storms
    // that happen to form at the same location but at very different
    // times.
    var _GENESIS_TIME_WINDOW_H      = 48;
    // _GENESIS_CLUSTER_MIN_MEMBERS already defined above.
    var _GENESIS_MEMBER_COLOR = 'rgba(249, 115, 22, 0.12)';  // very soft so heatmap dominates
    var _GENESIS_MEAN_COLOR = '#f97316';                      // bold orange
    // Layer the genesis spaghetti pairs with by default — gives users
    // both the per-track ensemble paths AND the spatial probability
    // context at once. Toggled off when the genesis toggle is dismissed
    // (only if it was auto-enabled, so we don't surprise the user by
    // killing a layer they enabled manually).
    // Pair the 15-day spaghetti with the 14-day probability heatmap so
    // the horizons agree — the previous 7-day pairing made the
    // spaghetti's days 8-15 fall outside the heatmap, which looked
    // like a track/probability inconsistency.
    var _GENESIS_PAIR_LAYER = 'genesis_prob_14d';
    var _genesisPairedLayerAutoOn = false;

    // ── Environmental Analysis Overlays (RT main map) ─────────
    var _rtEnvMetadata = null;         // { layers: [...] } from /env/layers
    var _rtEnvLoading = false;
    var _rtEnvActive = {};             // { layerName: { overlay, opacity } }
    var _rtEnvMenuOpen = false;
    // Default opacity for filled raster overlays (RH, SST, MSLP, genesis_prob,
    // divergence). 0.85 keeps the colors readable while still letting just
    // enough of the IR underlay show through to give geographic context.
    // 0.65 (the previous default) had too much IR bleed-through — colorful
    // cloud-top pixels showed through under the env layer and confused the
    // visual reading. User can drag the slider lower if they want a
    // stronger crossfade.
    var _rtEnvOpacity = 0.85;

    // Formats WeatherLab size fields (rmw_km, r34/r50/r64 mean + per-quadrant)
    // for tooltip / popup HTML. Returns '' if no size data is available so
    // existing tooltips don't grow needlessly.
    function _rtFmtSize(pt) {
        if (!pt) return '';
        var KM_TO_NM = 0.5399568;
        var lines = [];
        if (pt.rmw_km != null) {
            lines.push('RMW: ' + Math.round(pt.rmw_km * KM_TO_NM) + ' nm');
        }
        function _ringLine(thresh) {
            var k = 'r' + thresh + '_mean_km';
            if (pt[k] == null || pt[k] === 0) return null;
            var nm = Math.round(pt[k] * KM_TO_NM);
            // Per-quadrant if any of the four are non-zero/distinct
            var quads = ['ne', 'se', 'sw', 'nw'];
            var qVals = quads.map(function (q) { return pt['r' + thresh + '_' + q + '_km']; });
            var nonZero = qVals.filter(function (v) { return v != null && v > 0; });
            var allEqual = nonZero.length > 0 && nonZero.every(function (v) { return Math.abs(v - nonZero[0]) < 0.5; });
            if (nonZero.length > 1 && !allEqual) {
                var qStr = quads.map(function (q, i) {
                    return q.toUpperCase() + ' ' + (qVals[i] != null ? Math.round(qVals[i] * KM_TO_NM) : '—');
                }).join(' / ');
                return 'R' + thresh + ' (nm): ' + qStr;
            }
            return 'R' + thresh + ': ' + nm + ' nm';
        }
        ['34', '50', '64'].forEach(function (t) {
            var line = _ringLine(t);
            if (line) lines.push(line);
        });
        if (lines.length === 0) return '';
        return '<br><span style="font-size:11px;opacity:0.85;">' + lines.join('<br>') + '</span>';
    }
    var _rtDmHistTauIdx = 0;           // current slider index for intensity histogram
    var _rtDmChangeTauIdx = 4;         // current slider index for change histogram
    var _rtDmChangeInt = 24;           // 12 or 24 hour change interval

    // ── Microwave passes (last N hrs) overlay ───────────────
    // Shared helper lives in tc_mw_layer.js (window.TCMicrowave).
    // Lazily constructed on first Layers-panel render so we don't
    // touch the helper before the map exists.
    var _rtMwLayer = null;             // window.TCMicrowave instance
    var _rtMwHost  = null;             // persistent DOM host for the helper's UI
    function _rtEnsureMwLayer() {
        if (_rtMwLayer || !window.TCMicrowave || !map) return _rtMwLayer;
        _rtMwHost = document.createElement('div');
        _rtMwHost.id = 'rt-mw-host';
        _rtMwLayer = window.TCMicrowave.create(map, {
            container: _rtMwHost,
            defaultHours: 6,
            maxHours: 48,
            compact: false,
            // Storm-highlight fallback: if the layer never receives a
            // setActiveStorms() push (shouldn't happen on this page,
            // but harmless safety net), it'll fetch the same endpoint
            // the page uses for the D1/D2 markers.
            activeStormsApiUrl: API_BASE + '/ir-monitor/active-storms',
            onAttribution: function (txt, on) {
                // RT map has no global attribution control; use the Leaflet default if present.
                if (map && map.attributionControl) {
                    if (on) map.attributionControl.addAttribution(txt);
                    else    map.attributionControl.removeAttribution(txt);
                }
            }
        });
        // Re-render the layer count badge AND the top-level MW pill
        // when MW toggles. The pill mirrors _rtMwLayer._enabled.
        var origToggle = _rtMwLayer.toggle.bind(_rtMwLayer);
        _rtMwLayer.toggle = function () {
            origToggle();
            if (typeof _refreshLayersCount === 'function') _refreshLayersCount();
            _rtUpdateMwTopBtn();
        };
        // Sync on construction in case prefs auto-enabled the layer.
        setTimeout(_rtUpdateMwTopBtn, 0);
        // If a storm list was already cached when the layer mounted,
        // seed it now so storm-highlighting works on the first paint.
        if (stormData && stormData.length) {
            _rtMwLayer.setActiveStorms(stormData);
        }
        // Park the UI host inside the popover (its canonical home).
        // The popover is hidden until the chevron is clicked, but the
        // host needs to be in a styled parent so geometry layout works
        // before the first reveal.
        var pop = document.getElementById('ir-mw-popover');
        if (pop && _rtMwHost && _rtMwHost.parentNode !== pop) {
            pop.appendChild(_rtMwHost);
        }
        return _rtMwLayer;
    }

    // Hand the latest active-storms array to the MW layer (if mounted)
    // so it can highlight the most recent pass over each storm. No-op
    // when the layer hasn't been created yet — the lazy constructor
    // above seeds itself from stormData on first mount.
    function _rtPushStormsToMwLayer() {
        if (_rtMwLayer && typeof _rtMwLayer.setActiveStorms === 'function') {
            _rtMwLayer.setActiveStorms(stormData || []);
        }
    }

    // Reflect _rtMwLayer's enabled state onto the top-level pill.
    // Called from the toggle override (above) and once on construction.
    function _rtUpdateMwTopBtn() {
        var btn = document.getElementById('ir-mw-toggle-btn');
        if (!btn) return;
        var on = !!(_rtMwLayer && _rtMwLayer.isEnabled && _rtMwLayer.isEnabled());
        btn.classList.toggle('active', on);
    }

    // ── ASCAT Wind Barb Overlay State ───────────────────────
    var _rtAscatPasses = null;         // API response: list of passes
    var _rtAscatVisible = false;       // overlay toggle state
    var _rtAscatLayers = [];           // L.marker references on map
    var _rtAscatLastAtcf = null;       // last storm we fetched passes for
    var _rtAscatActiveUrl = null;      // currently displayed pass data URL

    // ── 88D NEXRAD Radar Overlay State ───────────────────────
    var _rtRadarVisible = false;       // overlay toggle state
    var _rtRadarMapOverlay = null;     // L.imageOverlay on map
    var _rtRadarData = null;           // raw uint8 hover data
    var _rtRadarRows = 0;
    var _rtRadarCols = 0;
    var _rtRadarVmin = -32;
    var _rtRadarVmax = 95;
    var _rtRadarBounds = null;         // L.latLngBounds
    var _rtRadarUnits = 'dBZ';
    var _rtRadarProduct = 'reflectivity';
    var _rtRadarSiteLat = null;        // radar site latitude
    var _rtRadarSiteLon = null;        // radar site longitude
    var _rtRadarTilt = 0.5;            // elevation angle in degrees
    var _rtRadarLastAtcf = null;       // last storm we fetched sites for
    var _rtRadarUpdateTimer = null;    // throttle timer for frame-sync
    var _rtRadarAllScans = [];         // full scan list across 6h window
    var _rtRadarFrameCache = {};       // { s3_key:product: { image, bounds, data, ... } }
    var _rtRadarPrefetching = false;

    // ── IR Center Fix State ────────────────────────────────

    // ── Browser-Side Panel Cache ─────────────────────────────
    // Per-storm cache for panel data to avoid re-fetching on back/forward.
    var _panelCache = {};              // { atcfId: { models, weatherlab, dmEns, ascat, meta, cachedAt } }
    var PANEL_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

    var RT_MODEL_COLORS = {
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
        'AVNX': '#ff6b6b', 'NGX':  '#6c5ce7',
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

    // Cached DOM refs for animation hot path (populated on first use)
    var _elFrameTime = null;
    var _elSatLabel = null;
    var _elAnimCounter = null;
    var _elAnimSlider = null;
    var _elAnimPlay = null;
    function _cacheAnimEls() {
        if (!_elFrameTime) _elFrameTime = document.getElementById('ir-frame-time');
        if (!_elSatLabel) _elSatLabel = document.getElementById('ir-satellite-label');
        if (!_elAnimCounter) _elAnimCounter = document.getElementById('ir-anim-counter');
        if (!_elAnimSlider) _elAnimSlider = document.getElementById('ir-anim-slider');
        if (!_elAnimPlay) _elAnimPlay = document.getElementById('ir-anim-play');
    }

    // Product mode: 'eir' (IR) or 'geocolor'
    var productMode = 'eir';

    // GeoColor overlay state
    var geocolorFrameLayers = [];   // parallel array of L.tileLayer for GeoColor frames
    var geocolorFrameTimes = [];    // ISO time strings for GeoColor frames
    var geocolorFramesLoaded = 0;
    var geocolorFramesReady = false;
    var geocolorValidFrames = [];
    var geocolorFrameHasError = [];

    // ── Helpers ─────────────────────────────────────────────────

    /** Split a latlng array into segments at antimeridian crossings.
     *  Returns an array of arrays — each sub-array is a contiguous segment
     *  that doesn't cross ±180°. Use with L.polyline(segments) for
     *  multi-segment rendering. */
    function splitAtAntimeridian(latlngs) {
        if (latlngs.length < 2) return [latlngs];
        var segments = [];
        var current = [latlngs[0]];
        for (var i = 1; i < latlngs.length; i++) {
            var prevLon = latlngs[i - 1][1];
            var curLon = latlngs[i][1];
            // A jump > 180° in longitude indicates a dateline crossing
            if (Math.abs(curLon - prevLon) > 180) {
                segments.push(current);
                current = [];
            }
            current.push(latlngs[i]);
        }
        segments.push(current);
        return segments;
    }

    /** Classify wind speed (kt) to Saffir-Simpson category key */
    function windToCategory(vmax) {
        if (vmax == null) return 'TD';
        if (vmax < 34)  return 'TD';
        if (vmax < 64)  return 'TS';
        if (vmax < 83)  return 'C1';
        if (vmax < 96)  return 'C2';
        if (vmax < 113) return 'C3';
        if (vmax < 137) return 'C4';
        return 'C5';
    }

    /** Readable category label */
    function categoryLabel(cat) {
        var labels = {
            TD: 'Tropical Depression',
            TS: 'Tropical Storm',
            C1: 'Category 1', C2: 'Category 2', C3: 'Category 3',
            C4: 'Category 4', C5: 'Category 5'
        };
        return labels[cat] || cat;
    }

    /** Short category label for badges */
    function categoryShort(cat) {
        if (cat === 'TD') return 'TD';
        if (cat === 'TS') return 'TS';
        return 'Cat ' + cat.replace('C', '');
    }

    /** Format lat/lon for display */
    function fmtLatLon(lat, lon) {
        var ns = lat >= 0 ? 'N' : 'S';
        var ew = lon >= 0 ? 'E' : 'W';
        return Math.abs(lat).toFixed(1) + '\u00B0' + ns + ' ' +
               Math.abs(lon).toFixed(1) + '\u00B0' + ew;
    }

    /** Get the official forecast URL for a storm based on its source/basin */
    function getOfficialForecastUrl(storm) {
        var source = (storm.source || '').toUpperCase();
        var basin = (storm.basin || '').toUpperCase();
        var id = (storm.atcf_id || '').toUpperCase();

        if (source === 'NHC' || basin === 'ATL' || basin === 'EPAC' || basin === 'CPAC') {
            // NHC — link to the storm-specific advisory page
            // NHC URL pattern: https://www.nhc.noaa.gov/refresh/graphics_{basin_num}+shtml/...
            // Simpler: link to the main active storms page
            return 'https://www.nhc.noaa.gov/';
        } else if (source === 'JTWC' || basin === 'WPAC' || basin === 'IO' || basin === 'SHEM') {
            // JTWC — link to their tropical warnings page
            return 'https://www.metoc.navy.mil/jtwc/jtwc.html';
        }
        return null;
    }

    /** Format UTC timestamp for display */
    function fmtUTC(isoStr) {
        if (!isoStr) return '\u2014';
        try {
            var d = new Date(isoStr);
            var mo = String(d.getUTCMonth() + 1).padStart(2, '0');
            var day = String(d.getUTCDate()).padStart(2, '0');
            var hh = String(d.getUTCHours()).padStart(2, '0');
            var mm = String(d.getUTCMinutes()).padStart(2, '0');
            return mo + '/' + day + ' ' + hh + ':' + mm + ' UTC';
        } catch (e) { return isoStr; }
    }

    /** Pick the best satellite for a given longitude (angular distance to sub-satellite point) */
    function bestSatelliteForLon(lon) {
        var best = SAT_SUBLONS[0], bestDist = 999;
        for (var i = 0; i < SAT_SUBLONS.length; i++) {
            var d = Math.abs(lon - SAT_SUBLONS[i].sublon);
            if (d > 180) d = 360 - d;
            if (d < bestDist) { bestDist = d; best = SAT_SUBLONS[i]; }
        }
        return best.name;
    }

    // ═══════════════════════════════════════════════════════════
    //  GIBS TILE HELPERS
    // ═══════════════════════════════════════════════════════════

    /** Round a Date to the nearest GIBS interval (10 min) in the past */
    function roundToGIBSInterval(dt) {
        var d = new Date(dt.getTime());
        var m = d.getUTCMinutes();
        d.setUTCMinutes(m - (m % GIBS_IR_INTERVAL_MIN), 0, 0);
        return d;
    }

    /** Format a Date as GIBS subdaily time string: YYYY-MM-DDTHH:MI:SSZ */
    function toGIBSTime(dt) {
        return dt.getUTCFullYear() + '-' +
               String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
               String(dt.getUTCDate()).padStart(2, '0') + 'T' +
               String(dt.getUTCHours()).padStart(2, '0') + ':' +
               String(dt.getUTCMinutes()).padStart(2, '0') + ':00Z';
    }

    /** Approximate solar elevation angle (degrees) at a given lat/lon/time.
     *  Positive = sun above horizon, negative = below.
     *  Used to determine day/night for Himawari GeoColor compositing. */
    function solarElevation(lat, lon, date) {
        var d = new Date(date);
        var start = new Date(d.getUTCFullYear(), 0, 1);
        var dayOfYear = Math.floor((d - start) / 86400000) + 1;
        var declRad = (23.45 * Math.PI / 180) * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365);
        var utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
        var haRad = ((utcHours - 12) * 15 + lon) * Math.PI / 180;
        var latRad = lat * Math.PI / 180;
        return Math.asin(
            Math.sin(latRad) * Math.sin(declRad) +
            Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad)
        ) * 180 / Math.PI;
    }

    /** Create a GIBS IR tile URL for a given layer + time (direct, no Leaflet template) */
    function gibsTileUrl(layerName, timeStr) {
        return GIBS_BASE + '/' + layerName + '/default/' + timeStr +
               '/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png';
    }

    /** Create a direct GIBS tile URL (no Leaflet placeholders) */
    function gibsTileUrlDirect(layerName, timeStr, z, y, x) {
        return GIBS_BASE + '/' + layerName + '/default/' + timeStr +
               '/GoogleMapsCompatible_Level6/' + z + '/' + y + '/' + x + '.png';
    }

    /** Create a direct GIBS tile URL with configurable TileMatrixSet */
    function gibsTileUrlWithMatrix(layerName, timeStr, z, y, x, tileMatrix) {
        return GIBS_BASE + '/' + layerName + '/default/' + timeStr +
               '/' + tileMatrix + '/' + z + '/' + y + '/' + x + '.png';
    }

    /** Create a Leaflet tile layer for a single GIBS IR product at a given time
     *  (used for storm-detail animation where only one satellite is needed).
     *  Uses a custom GridLayer with per-tile retry so that individual tiles
     *  that 404 at the requested time automatically fall back to 10/20/30 min
     *  earlier, eliminating gaps in the animation frames. */
    function createGIBSLayer(layerName, timeStr, opacity, bounds) {
        var RetryLayer = L.GridLayer.extend({
            options: {
                maxZoom: GIBS_MAX_ZOOM,
                maxNativeZoom: GIBS_MAX_ZOOM,
                tileSize: 256,
                opacity: opacity || 0.6,
                attribution: '<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
                updateWhenZooming: false,
                keepBuffer: 3
            },

            _layerName: layerName,
            _timeStr: timeStr,

            createTile: function (coords, done) {
                var tile = document.createElement('canvas');
                var ctx = tile.getContext('2d');
                var size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;

                loadImageWithRetry(this._layerName, this._timeStr, coords.z, coords.y, coords.x)
                    .then(function (result) {
                        if (result.img) {
                            ctx.drawImage(result.img, 0, 0, size.x, size.y);
                        }
                        done(null, tile);
                    });

                return tile;
            }
        });

        var layer = new RetryLayer();
        if (bounds) {
            layer.options.bounds = L.latLngBounds(bounds);
        }
        return layer;
    }

    /** Like satellitesForTile but returns GeoColor/visible layer names.
     *  For Himawari, falls back to Red Visible + includes IR fallback layer name
     *  so the compositor can draw IR as base for nighttime tiles. */
    function satellitesForTileVis(x, z) {
        var lonRange = tileLonRange(x, z);
        var centerLon = (lonRange.west + lonRange.east) / 2;

        var zones = resolveSatZones();
        var bestSat = null;
        var bestScore = -Infinity;

        for (var i = 0; i < zones.length; i++) {
            var sat = zones[i];
            if (staleGIBSSats[sat.name]) continue;  // backfill: skip stale feeds
            var hasGeoColor = !!GIBS_GEOCOLOR_LAYERS[sat.name];
            var layerName = GIBS_GEOCOLOR_LAYERS[sat.name] || GIBS_VIS_LAYERS[sat.name];
            if (!layerName) continue;

            var score = scoreSatForLon(sat, centerLon);
            if (score > bestScore) {
                bestScore = score;
                bestSat = {
                    name: sat.name,
                    layerName: layerName,
                    weight: 1.0,
                    irFallback: hasGeoColor ? null : (GIBS_IR_LAYERS[sat.name] || null)
                };
            }
        }

        if (!bestSat) {
            var best = null, bestDist = 999;
            for (var j = 0; j < SAT_SUBLONS.length; j++) {
                if (staleGIBSSats[SAT_SUBLONS[j].name]) continue;
                var d = Math.abs(centerLon - SAT_SUBLONS[j].sublon);
                if (d > 180) d = 360 - d;
                if (d < bestDist) { bestDist = d; best = SAT_SUBLONS[j]; }
            }
            if (!best) best = SAT_SUBLONS[0];  // last-ditch: every feed stale
            var hasGC = !!GIBS_GEOCOLOR_LAYERS[best.name];
            var ln = GIBS_GEOCOLOR_LAYERS[best.name] || GIBS_VIS_LAYERS[best.name];
            bestSat = {
                name: best.name,
                layerName: ln,
                weight: 1.0,
                irFallback: hasGC ? null : (GIBS_IR_LAYERS[best.name] || null)
            };
        }

        return [bestSat];
    }

    /** Per-pixel blend: overlay visible image onto IR base in a canvas context.
     *  Daytime pixels (visible brightness above threshold) use the visible image.
     *  Nighttime pixels (dark visible) convert the colored IR to grayscale,
     *  mimicking the look of real GeoColor imagery (grayscale IR at night).
     *  This correctly handles tiles that span the day/night terminator. */
    function blendVisibleOverIR(ctx, visImg, w, h) {
        var VIS_BRIGHT_THRESHOLD = 12; // nighttime pixels are 0-2, daytime ocean ~15+
        var tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = w;
        tmpCanvas.height = h;
        var tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.drawImage(visImg, 0, 0, w, h);
        var visData = tmpCtx.getImageData(0, 0, w, h);
        var irData = ctx.getImageData(0, 0, w, h);
        var vd = visData.data;
        var id = irData.data;
        for (var p = 0; p < vd.length; p += 4) {
            var brightness = (vd[p] + vd[p + 1] + vd[p + 2]) / 3;
            if (brightness > VIS_BRIGHT_THRESHOLD) {
                // Daytime: use visible imagery
                id[p]     = vd[p];
                id[p + 1] = vd[p + 1];
                id[p + 2] = vd[p + 2];
                id[p + 3] = 255;
            } else {
                // Nighttime: convert colored IR to grayscale
                var gray = Math.round(0.299 * id[p] + 0.587 * id[p + 1] + 0.114 * id[p + 2]);
                id[p]     = gray;
                id[p + 1] = gray;
                id[p + 2] = gray;
            }
        }
        ctx.putImageData(irData, 0, 0);
    }

    /** Create a seamless composite GeoColor/Visible layer for the global map.
     *  For GOES: uses GeoColor (handles day/night automatically).
     *  For Himawari: hybrid — draws IR as base, overlays Red Visible during daytime. */
    function createCompositeGIBSLayerVis(timeStr, opacity) {
        var CompositeVisLayer = L.GridLayer.extend({
            options: {
                tileSize: 256,
                maxZoom: GIBS_VIS_MAX_ZOOM,
                maxNativeZoom: GIBS_VIS_MAX_ZOOM,
                opacity: opacity || 0.65,
                attribution: '<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
                updateWhenZooming: false,
                keepBuffer: 3
            },

            _timeStr: timeStr,

            createTile: function (coords, done) {
                var tile = document.createElement('canvas');
                var ctx = tile.getContext('2d');
                var size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;

                var sats = satellitesForTileVis(coords.x, coords.z);
                var z = coords.z;
                var y = coords.y;
                var x = coords.x;
                var ts = this._timeStr;
                var sat = sats[0];

                if (sat.irFallback) {
                    // Hybrid mode: IR base + per-pixel visible overlay
                    // Visible pixels brighter than threshold replace IR;
                    // dark (nighttime) pixels keep the IR base underneath.
                    Promise.all([
                        loadImageWithRetry(sat.irFallback, ts, z, y, x),
                        loadImageWithRetryVis(sat.layerName, ts, z, y, x)
                    ]).then(function (results) {
                        var irResult = results[0];
                        var visResult = results[1];
                        if (irResult.img) {
                            ctx.drawImage(irResult.img, 0, 0, size.x, size.y);
                        }
                        if (visResult.img) {
                            blendVisibleOverIR(ctx, visResult.img, size.x, size.y);
                        }
                        done(null, tile);
                    }).catch(function () {
                        done(null, tile);
                    });
                } else {
                    // Standard GeoColor (handles day/night itself)
                    loadImageWithRetryVis(sat.layerName, ts, z, y, x).then(function (result) {
                        if (result.img) {
                            ctx.drawImage(result.img, 0, 0, size.x, size.y);
                        }
                        done(null, tile);
                    }).catch(function () {
                        done(null, tile);
                    });
                }

                return tile;
            }
        });

        return new CompositeVisLayer();
    }

    /** Create a Leaflet tile layer for GIBS GeoColor/Visible at a given time.
     *  Uses GoogleMapsCompatible_Level7 (higher zoom than IR).
     *  For GOES: uses GeoColor which handles day/night automatically.
     *  For Himawari: uses hybrid mode — Enhanced IR as base with Red Visible
     *  composited on top during daytime. At night the IR shines through. */
    function createGIBSLayerVis(layerName, timeStr, opacity, irFallbackLayer) {
        var VisRetryLayer = L.GridLayer.extend({
            options: {
                maxZoom: GIBS_VIS_MAX_ZOOM,
                maxNativeZoom: GIBS_VIS_MAX_ZOOM,
                tileSize: 256,
                opacity: opacity || 0.6,
                attribution: '<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
                updateWhenZooming: false,
                keepBuffer: 3
            },

            _layerName: layerName,
            _timeStr: timeStr,
            _irFallback: irFallbackLayer || null,

            createTile: function (coords, done) {
                var tile = document.createElement('canvas');
                var ctx = tile.getContext('2d');
                var size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;
                var irLayer = this._irFallback;
                var visLayer = this._layerName;
                var ts = this._timeStr;

                if (irLayer) {
                    // Hybrid mode: IR base + per-pixel visible overlay
                    Promise.all([
                        loadImageWithRetry(irLayer, ts, coords.z, coords.y, coords.x),
                        loadImageWithRetryVis(visLayer, ts, coords.z, coords.y, coords.x)
                    ]).then(function (results) {
                        var irResult = results[0];
                        var visResult = results[1];
                        if (irResult.img) {
                            ctx.drawImage(irResult.img, 0, 0, size.x, size.y);
                        }
                        if (visResult.img) {
                            blendVisibleOverIR(ctx, visResult.img, size.x, size.y);
                        }
                        done(null, tile);
                    }).catch(function () {
                        done(null, tile);
                    });
                } else {
                    // Standard mode (GeoColor handles day/night itself)
                    loadImageWithRetryVis(visLayer, ts, coords.z, coords.y, coords.x)
                        .then(function (result) {
                            if (result.img) {
                                ctx.drawImage(result.img, 0, 0, size.x, size.y);
                            }
                            done(null, tile);
                        });
                }

                return tile;
            }
        });

        return new VisRetryLayer();
    }

    /** Load a GIBS visible/GeoColor tile with time-fallback retry.
     *  Same strategy as IR but uses the visible TileMatrixSet. */
    function loadImageWithRetryVis(layerName, timeStr, z, y, x) {
        // Wider retry window for visible/GeoColor tiles — Himawari data on
        // GIBS can lag 1-2 hours behind GOES due to the JMA→LANCE→GIBS pipeline
        var attempts = [0, 10, 20, 30, 60, 90, 120];
        var baseDate = new Date(timeStr);

        function tryAttempt(idx) {
            if (idx >= attempts.length) return Promise.resolve({ img: null });
            var dt = new Date(baseDate.getTime() - attempts[idx] * 60 * 1000);
            var ts = toGIBSTime(roundToGIBSInterval(dt));
            var url = gibsTileUrlWithMatrix(layerName, ts, z, y, x, GIBS_VIS_TILEMATRIX);
            return loadImage(url).then(function (img) {
                if (img) return { img: img, timeUsed: ts };
                return tryAttempt(idx + 1);
            });
        }

        return tryAttempt(0);
    }

    // ── Seamless Composite GIBS Layer ─────────────────────────
    // Replaces 3 separate bounded tile layers with a single
    // L.GridLayer that alpha-blends satellite imagery at boundaries.

    /** Convert tile coords to the longitude of the tile center */
    function tileCenterLon(x, z) {
        var n = Math.pow(2, z);
        return (x + 0.5) / n * 360 - 180;
    }

    /** Convert tile coords to the longitude range of the tile */
    function tileLonRange(x, z) {
        var n = Math.pow(2, z);
        var west = x / n * 360 - 180;
        var east = (x + 1) / n * 360 - 180;
        return { west: west, east: east };
    }

    /** Determine the single best satellite for a given tile.
     *  Always returns exactly one satellite — no multi-source blending.
     *  Alpha-blending two geostationary views (different angles + scan times)
     *  produces visible dark/blurry bands, especially at low zoom where tiles
     *  span 20-45° of longitude.  A hard cutoff is cleaner because GOES-East
     *  and GOES-West use the same ABI instrument on overlapping footprints. */
    function satellitesForTile(x, z) {
        var lonRange = tileLonRange(x, z);
        var centerLon = (lonRange.west + lonRange.east) / 2;

        // resolveSatZones reconfigures the zone list when GOES-West is
        // stale: Himawari extends past the dateline to a sharp -150°
        // seam with a westward-extended GOES-East. When all three sats
        // are healthy this returns the standard non-wrap zones.
        var zones = resolveSatZones();
        var bestSat = null;
        var bestScore = -Infinity;

        for (var i = 0; i < zones.length; i++) {
            var sat = zones[i];
            var layerName = GIBS_IR_LAYERS[sat.name];
            if (!layerName) continue;
            if (staleGIBSSats[sat.name]) continue;  // backfill: skip stale feeds

            var score = scoreSatForLon(sat, centerLon);
            if (score > bestScore) {
                bestScore = score;
                bestSat = { name: sat.name, layerName: layerName, weight: 1.0 };
            }
        }

        // Fallback to nearest sub-satellite point if nothing scored well
        // (also skipping stale feeds, falling through to any healthy sat).
        if (!bestSat) {
            var best = null, bestDist = 999;
            for (var j = 0; j < SAT_SUBLONS.length; j++) {
                if (staleGIBSSats[SAT_SUBLONS[j].name]) continue;
                var d = Math.abs(centerLon - SAT_SUBLONS[j].sublon);
                if (d > 180) d = 360 - d;
                if (d < bestDist) { bestDist = d; best = SAT_SUBLONS[j]; }
            }
            // If every satellite is stale, last-ditch: ignore stale flag entirely
            if (!best) best = SAT_SUBLONS[0];
            bestSat = { name: best.name, layerName: GIBS_IR_LAYERS[best.name], weight: 1.0 };
        }

        return [bestSat];
    }

    /** Load an image as a promise */
    function loadImage(url) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () { resolve(img); };
            img.onerror = function () { resolve(null); }; // resolve null on error (tile may not exist)
            img.src = url;
        });
    }

    /** Load an image with retry at progressively older GIBS times.
     *  Tries the primary time, then falls back 10/20/30 min earlier.
     *  Returns {img, timeUsed} or {img: null} if all attempts fail. */
    function loadImageWithRetry(layerName, timeStr, z, y, x) {
        var attempts = [0, 10, 20, 30]; // minute offsets to try
        var baseDate = new Date(timeStr);

        function tryAttempt(idx) {
            if (idx >= attempts.length) return Promise.resolve({ img: null });
            var dt = new Date(baseDate.getTime() - attempts[idx] * 60 * 1000);
            var ts = toGIBSTime(roundToGIBSInterval(dt));
            var url = gibsTileUrlDirect(layerName, ts, z, y, x);
            return loadImage(url).then(function (img) {
                if (img) return { img: img, timeUsed: ts };
                return tryAttempt(idx + 1);
            });
        }

        return tryAttempt(0);
    }

    /** Create the seamless composite GIBS GridLayer */
    function createCompositeGIBSLayer(timeStr, opacity, perSatTimes) {
        // perSatTimes is optional: {'GOES-East': ts, 'GOES-West': ts, 'Himawari': ts}
        // When provided, each tile uses the freshest time for its assigned satellite.
        // When absent (e.g. animation frames), all tiles share timeStr.
        var satTimes = perSatTimes || null;

        var CompositeLayer = L.GridLayer.extend({
            options: {
                tileSize: 256,
                maxZoom: GIBS_MAX_ZOOM,
                maxNativeZoom: GIBS_MAX_ZOOM,
                opacity: opacity || 0.65,
                attribution: '<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
                updateWhenZooming: false,
                keepBuffer: 3
            },

            _timeStr: timeStr,
            _satTimes: satTimes,

            createTile: function (coords, done) {
                var tile = document.createElement('canvas');
                var ctx = tile.getContext('2d');
                var size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;

                var sats = satellitesForTile(coords.x, coords.z);
                var z = coords.z;
                var y = coords.y;
                var x = coords.x;
                var layerSatTimes = this._satTimes;
                var fallbackTs = this._timeStr;

                if (sats.length === 1) {
                    // Single satellite — use per-satellite time if available
                    var ts = (layerSatTimes && layerSatTimes[sats[0].name]) || fallbackTs;
                    loadImageWithRetry(sats[0].layerName, ts, z, y, x).then(function (result) {
                        if (result.img) {
                            ctx.drawImage(result.img, 0, 0, size.x, size.y);
                        }
                        done(null, tile);
                    });
                } else {
                    // Multiple satellites — composite with alpha blending + retry
                    var promises = [];
                    for (var i = 0; i < sats.length; i++) {
                        var ts = (layerSatTimes && layerSatTimes[sats[i].name]) || fallbackTs;
                        promises.push(loadImageWithRetry(sats[i].layerName, ts, z, y, x));
                    }
                    Promise.all(promises).then(function (results) {
                        for (var j = 0; j < results.length; j++) {
                            if (!results[j].img) continue;
                            ctx.globalAlpha = sats[j].weight;
                            ctx.drawImage(results[j].img, 0, 0, size.x, size.y);
                        }
                        ctx.globalAlpha = 1.0;
                        done(null, tile);
                    });
                }

                return tile;
            }
        });

        return new CompositeLayer();
    }

    /** Probe GIBS for the latest available time for EACH satellite independently.
     *  GOES data typically arrives within 15-20 min; Himawari can lag 60-120 min
     *  due to the JMA → LANCE → GIBS pipeline.  By finding per-satellite times we
     *  avoid penalising GOES freshness for Himawari's slower pipeline.
     *
     *  Returns a promise that resolves with:
     *    { perSat: {'GOES-East': ts, 'GOES-West': ts, 'Himawari': ts},
     *      oldest: ts }    // oldest across all sats (safe for animation)
     */
    function findLatestGIBSTimes() {
        var ALL_OFFSETS = [15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
        // Representative tiles for each satellite (z3 tiles within each footprint)
        var satellites = [
            { name: 'GOES-East', layer: GIBS_IR_LAYERS['GOES-East'], suffix: '/GoogleMapsCompatible_Level6/3/3/2.png' },
            { name: 'GOES-West', layer: GIBS_IR_LAYERS['GOES-West'], suffix: '/GoogleMapsCompatible_Level6/3/3/0.png' },
            { name: 'Himawari',  layer: GIBS_IR_LAYERS['Himawari'],  suffix: '/GoogleMapsCompatible_Level6/3/3/6.png' }
        ];

        var PROBE_BATCH = 6;  // probe 6 offsets in parallel per batch
        var GIBS_HINT_KEY = 'tc-atlas-gibs-offsets';

        // Reorder offsets to start from the last-known good offset (sessionStorage hint).
        // This lets repeat visits and poll refreshes converge in a single batch.
        function getOffsetsForSat(satName) {
            try {
                var hints = JSON.parse(sessionStorage.getItem(GIBS_HINT_KEY) || '{}');
                var lastOffset = hints[satName];
                if (lastOffset && ALL_OFFSETS.indexOf(lastOffset) !== -1) {
                    // Put the hint and its neighbors first, then the rest
                    var idx = ALL_OFFSETS.indexOf(lastOffset);
                    var start = Math.max(0, idx - 1);
                    var priority = ALL_OFFSETS.slice(start, idx + 2);
                    var rest = ALL_OFFSETS.filter(function (o) { return priority.indexOf(o) === -1; });
                    return priority.concat(rest);
                }
            } catch (e) { /* sessionStorage unavailable */ }
            return ALL_OFFSETS.slice();
        }

        function saveOffsetHint(satName, offset) {
            try {
                var hints = JSON.parse(sessionStorage.getItem(GIBS_HINT_KEY) || '{}');
                hints[satName] = offset;
                sessionStorage.setItem(GIBS_HINT_KEY, JSON.stringify(hints));
            } catch (e) { /* ignore */ }
        }

        function findTimeForSat(sat) {
            var offsets = getOffsetsForSat(sat.name);
            function tryBatch(startIdx) {
                if (startIdx >= offsets.length) {
                    // Every probe in the standard window (15–120 min) returned
                    // 404 → this satellite's GIBS feed is stale. Return null so
                    // the caller can flag it in the staleness banner instead of
                    // silently animating a non-existent timestamp.
                    return Promise.resolve(null);
                }
                var batch = offsets.slice(startIdx, startIdx + PROBE_BATCH);
                var probes = batch.map(function (offset) {
                    var dt = roundToGIBSInterval(new Date());
                    dt = new Date(dt.getTime() - offset * 60 * 1000);
                    var ts = toGIBSTime(dt);
                    var url = GIBS_BASE + '/' + sat.layer + '/default/' + ts + sat.suffix;
                    return fetch(url, { cache: 'no-store' }).then(function (r) {
                        return r.ok ? { offset: offset, ts: ts } : null;
                    }).catch(function () {
                        return null;
                    });
                });
                return Promise.all(probes).then(function (results) {
                    // Pick the freshest (smallest offset) successful probe
                    var best = null;
                    for (var i = 0; i < results.length; i++) {
                        if (results[i] && (!best || results[i].offset < best.offset)) {
                            best = results[i];
                        }
                    }
                    if (best) {
                        saveOffsetHint(sat.name, best.offset);
                        return best.ts;
                    }
                    // None in this batch succeeded — try next batch
                    return tryBatch(startIdx + PROBE_BATCH);
                });
            }
            return tryBatch(0);
        }

        return Promise.all(satellites.map(function (sat) {
            return findTimeForSat(sat).then(function (ts) {
                return { name: sat.name, time: ts };
            });
        })).then(function (results) {
            var perSat = {};
            var oldestMs = Infinity;
            var staleSats = [];
            // Reset module-level stale set so backfill picks the latest state.
            staleGIBSSats = {};
            for (var i = 0; i < results.length; i++) {
                if (results[i].time === null) {
                    staleSats.push(results[i].name);
                    staleGIBSSats[results[i].name] = true;
                    continue;
                }
                perSat[results[i].name] = results[i].time;
                var ms = new Date(results[i].time).getTime();
                if (ms < oldestMs) oldestMs = ms;
            }
            // If at least one sat is fresh, animate against its time;
            // otherwise fall back to "now rounded to 10 min" (won't render
            // tiles, but avoids NaN dates downstream).
            var oldest;
            if (oldestMs !== Infinity) {
                oldest = toGIBSTime(new Date(oldestMs));
            } else {
                oldest = toGIBSTime(roundToGIBSInterval(new Date()));
            }
            return { perSat: perSat, oldest: oldest, staleSats: staleSats };
        });
    }

    /** Update the GIBS-feed staleness banner. Show when one or more
     *  satellites are stale; hide when all are fresh. The banner names
     *  the affected satellites and links to NASA's outages page. */
    function _updateFeedStalenessBanner(staleSats) {
        var el = document.getElementById('ir-feed-banner');
        var txt = document.getElementById('ir-feed-banner-text');
        if (!el || !txt) return;
        if (!staleSats || staleSats.length === 0) {
            el.style.display = 'none';
            return;
        }
        var label = staleSats.join(' & ');
        var msg = label + ' feed delayed (NASA GIBS) — that region is being backfilled from the nearest available satellite (expect higher parallax) until the upstream ingest catches up.';
        txt.textContent = msg;
        el.style.display = 'flex';
    }

    /** Legacy wrapper — returns the oldest satellite time (for animation compatibility) */
    function findLatestGIBSTime() {
        return findLatestGIBSTimes().then(function (result) {
            latestGIBSTimes = result.perSat;
            _updateFeedStalenessBanner(result.staleSats);
            return result.oldest;
        });
    }

    /** Add the seamless composite GIBS IR layer to the map.
     *  Uses per-satellite times so GOES tiles show the freshest data (~15-20 min)
     *  while Himawari tiles use their own latest (may be 60-120 min behind). */
    function addGIBSOverlay(targetMap, opacity) {
        findLatestGIBSTimes().then(function (result) {
            latestGIBSTimes = result.perSat;
            latestGIBSTime = result.oldest;  // animation fallback
            _updateFeedStalenessBanner(result.staleSats);
            var lyr = createCompositeGIBSLayer(result.oldest, opacity || 0.65, result.perSat);
            lyr.addTo(targetMap);
            gibsIRLayers = [lyr];
            console.log('GIBS per-satellite times:', JSON.stringify(result.perSat),
                        '| oldest (animation):', result.oldest,
                        '| stale:', result.staleSats);
        });
        return []; // layers added asynchronously — gibsIRLayers updated in callback
    }

    /** Remove GIBS layers from a map */
    function removeGIBSOverlay(targetMap, layers) {
        for (var i = 0; i < layers.length; i++) {
            targetMap.removeLayer(layers[i]);
        }
    }

    /** Swap composite GIBS layer to a new time string */
    function swapGIBSTime(targetMap, layers, timeStr, opacity) {
        for (var i = 0; i < layers.length; i++) {
            targetMap.removeLayer(layers[i]);
        }
        var lyr = createCompositeGIBSLayer(timeStr, opacity || 0.85);
        lyr.addTo(targetMap);
        return [lyr];
    }

    /** Toggle the global map between IR and GeoColor */
    /** Show / hide the CARTO place-name label tiles. The labels read
     *  as info overload once env contour overlays are active — this
     *  toggle lets the user clear them with one click. State is
     *  preserved across IR/GeoColor mode flips. */
    function toggleLabels(visible) {
        if (typeof visible === 'boolean') _labelsVisible = visible;
        else _labelsVisible = !_labelsVisible;
        if (!_labelsLayer || !map) return;
        if (_labelsVisible) {
            if (!map.hasLayer(_labelsLayer)) _labelsLayer.addTo(map);
        } else {
            if (map.hasLayer(_labelsLayer)) map.removeLayer(_labelsLayer);
        }
        var btn = document.getElementById('ir-labels-toggle');
        if (btn) btn.classList.toggle('active', _labelsVisible);
        _ga('rt_labels_toggle', { on: _labelsVisible });
    }
    window.toggleLabels = toggleLabels;

    // ── Lat/lon graticule (RT Global Map) ─────────────────────────
    // L.layerGroup holding all polylines + label divIcons. Rebuilt on
    // moveend/zoomend with adaptive spacing so meso zooms get a fine
    // 1° grid while world view gets a sparse 10° grid.
    var _rtGraticule = null;
    function _rtGraticuleStep(z) {
        if (z >= 7) return 1;
        if (z >= 5) return 2;
        if (z >= 3) return 5;
        return 10;
    }
    function _rtRebuildGraticule() {
        if (!_rtGraticule || !map) return;
        _rtGraticule.clearLayers();
        var step = _rtGraticuleStep(map.getZoom());
        var b = map.getBounds();
        var sLat = Math.max(-85, Math.floor(b.getSouth() / step) * step);
        var nLat = Math.min( 85, Math.ceil(b.getNorth() / step) * step);
        var wLon = Math.floor(b.getWest() / step) * step;
        var eLon = Math.ceil(b.getEast() / step) * step;
        var lineOpts = {
            color: '#f1f5f9', weight: 0.5, opacity: 0.5,
            dashArray: '3 5', interactive: false
        };
        for (var lat = sLat; lat <= nLat; lat += step) {
            L.polyline([[lat, wLon], [lat, eLon]], lineOpts)
                .addTo(_rtGraticule);
            // Latitude label — pinned to the left edge of the viewport,
            // not the line endpoint, so users don't have to scan across
            // the map for the label.
            var labelLng = b.getWest() + (b.getEast() - b.getWest()) * 0.015;
            L.marker([lat, labelLng], {
                icon: L.divIcon({
                    className: 'rt-graticule-label',
                    html: _rtFmtLat(lat),
                    iconSize: [40, 14], iconAnchor: [0, 7]
                }),
                interactive: false, keyboard: false
            }).addTo(_rtGraticule);
        }
        for (var lon = wLon; lon <= eLon; lon += step) {
            L.polyline([[sLat, lon], [nLat, lon]], lineOpts)
                .addTo(_rtGraticule);
            var labelLat = b.getSouth() + (b.getNorth() - b.getSouth()) * 0.015;
            L.marker([labelLat, lon], {
                icon: L.divIcon({
                    className: 'rt-graticule-label',
                    html: _rtFmtLon(lon),
                    iconSize: [50, 14], iconAnchor: [25, 14]
                }),
                interactive: false, keyboard: false
            }).addTo(_rtGraticule);
        }
    }
    function _rtToggleGraticule() {
        if (!map) return;
        if (_rtGraticule) {
            map.removeLayer(_rtGraticule);
            map.off('moveend zoomend', _rtRebuildGraticule);
            _rtGraticule = null;
            _ga('rt_graticule_toggle', { on: false });
            return;
        }
        _rtGraticule = L.layerGroup().addTo(map);
        _rtRebuildGraticule();
        map.on('moveend zoomend', _rtRebuildGraticule);
        _ga('rt_graticule_toggle', { on: true });
    }

    function setGlobalProduct(mode) {
        if (mode === globalProduct) return;
        globalProduct = mode;

        // Update IR/GeoColor segmented buttons inside the Layers panel
        var seg = document.getElementById('ir-mode-segment');
        if (seg) {
            var modeBtns = seg.querySelectorAll('.ir-mode-btn');
            for (var mi = 0; mi < modeBtns.length; mi++) {
                modeBtns[mi].classList.toggle('ir-mode-active',
                    modeBtns[mi].getAttribute('data-mode') === mode);
            }
        }

        // Show/hide IR colorbar
        var colorbar = document.getElementById('ir-global-colorbar');
        if (colorbar) colorbar.style.display = (mode === 'geocolor') ? 'none' : '';

        // If global animation is loaded, it needs to be rebuilt for the new product
        var hadAnim = globalAnimReady;
        if (globalAnimFrameLayers.length > 0) {
            cleanupGlobalAnimation();
        }

        var timeStr = latestGIBSTime;
        if (!timeStr) return; // GIBS time not resolved yet

        if (mode === 'geocolor') {
            removeGIBSOverlay(map, gibsIRLayers);
            gibsIRLayers = [];
            var visLyr = createCompositeGIBSLayerVis(timeStr, 0.75);
            visLyr.addTo(map);
            gibsVisLayers = [visLyr];
        } else {
            removeGIBSOverlay(map, gibsVisLayers);
            gibsVisLayers = [];
            // Use per-satellite times for static IR layer (fresher GOES tiles)
            var perSat = (Object.keys(latestGIBSTimes).length > 0) ? latestGIBSTimes : null;
            var irLyr = createCompositeGIBSLayer(timeStr, 0.85, perSat);
            irLyr.addTo(map);
            gibsIRLayers = [irLyr];
        }

        // Re-load animation if it was active
        if (hadAnim) {
            loadGlobalAnimation();
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GLOBAL MAP ANIMATION
    // ═══════════════════════════════════════════════════════════

    /** Create a composite layer for a given time based on the current global product. */
    function createGlobalAnimFrame(timeStr) {
        if (globalProduct === 'geocolor') {
            return createCompositeGIBSLayerVis(timeStr, 0);
        }
        return createCompositeGIBSLayer(timeStr, 0);
    }

    /** Load all global animation frames. Called when user clicks the play button. */
    function loadGlobalAnimation() {
        if (!map || !latestGIBSTime || globalAnimLoading) return;

        // If already loaded, just show the latest frame
        if (globalAnimReady && globalAnimFrameLayers.length > 0) {
            showGlobalAnimFrame(globalAnimFrameLayers.length - 1);
            return;
        }

        globalAnimLoading = true;
        globalAnimLoaded = 0;
        globalAnimReady = false;

        // Build frame times from latestGIBSTime
        var latest = new Date(latestGIBSTime);
        globalAnimFrameTimes = [];
        var step = GLOBAL_ANIM_STEP_MIN * 60 * 1000;
        var numFrames = Math.floor(GLOBAL_ANIM_LOOKBACK_H * 60 / GLOBAL_ANIM_STEP_MIN) + 1;
        for (var i = numFrames - 1; i >= 0; i--) {
            var dt = new Date(latest.getTime() - i * step);
            globalAnimFrameTimes.push(toGIBSTime(roundToGIBSInterval(dt)));
        }

        console.log('[Global Anim] Loading', globalAnimFrameTimes.length, 'frames for', globalProduct);

        // Update controls to show loading state
        updateGlobalAnimControls('loading', 0);

        // Remove static single-frame layer — animation frames will replace it
        if (globalProduct === 'geocolor') {
            removeGIBSOverlay(map, gibsVisLayers);
            gibsVisLayers = [];
        } else {
            removeGIBSOverlay(map, gibsIRLayers);
            gibsIRLayers = [];
        }

        // Pre-create all frame layers at opacity 0
        globalAnimFrameLayers = [];
        for (var f = 0; f < globalAnimFrameTimes.length; f++) {
            var lyr = createGlobalAnimFrame(globalAnimFrameTimes[f]);
            lyr.addTo(map);
            globalAnimFrameLayers.push(lyr);

            (function (layer, idx, total) {
                layer.on('load', function () {
                    globalAnimLoaded++;
                    var pct = Math.round((globalAnimLoaded / total) * 100);
                    updateGlobalAnimControls('loading', pct);

                    if (globalAnimLoaded >= total) {
                        globalAnimReady = true;
                        globalAnimLoading = false;
                        globalAnimIndex = total - 1;
                        showGlobalAnimFrame(globalAnimIndex);
                        updateGlobalAnimControls('ready');
                        console.log('[Global Anim] All', total, 'frames loaded');
                    }
                });
            })(lyr, f, globalAnimFrameTimes.length);
        }

        // Safety timeout: force-enable after 45s
        setTimeout(function () {
            if (globalAnimLoading && !globalAnimReady) {
                console.warn('[Global Anim] Timeout — enabling with', globalAnimLoaded, '/', globalAnimFrameTimes.length);
                globalAnimReady = true;
                globalAnimLoading = false;
                globalAnimIndex = globalAnimFrameTimes.length - 1;
                showGlobalAnimFrame(globalAnimIndex);
                updateGlobalAnimControls('ready');
            }
        }, 45000);
    }

    /** Show a specific global animation frame */
    function showGlobalAnimFrame(idx) {
        if (idx < 0 || idx >= globalAnimFrameLayers.length) return;

        // Hide all frames
        for (var i = 0; i < globalAnimFrameLayers.length; i++) {
            globalAnimFrameLayers[i].setOpacity(0);
        }

        // Show requested frame
        globalAnimIndex = idx;
        // IR uses 0.85 to match the initial still-overlay opacity set in
        // addGIBSOverlay (was 0.65 — the drop was visible the moment
        // animation took over). GeoColor stays at 0.75 since both its
        // still and animation paths already used that value.
        globalAnimFrameLayers[idx].setOpacity(globalProduct === 'geocolor' ? 0.75 : 0.85);

        // Update time display
        var timeEl = document.getElementById('ir-global-anim-time');
        if (timeEl && globalAnimFrameTimes[idx]) {
            timeEl.textContent = fmtUTC(globalAnimFrameTimes[idx]);
        }

        _refreshAnimSlider();
    }

    /** Keep the rt-anim slider, play button, and speed pill in sync
     *  with globalAnim* state. Called whenever a frame is shown, the
     *  animation starts/pauses, frames finish loading, or cleanup
     *  fires. */
    function _refreshAnimSlider() {
        var slider = document.getElementById('ir-global-anim-slider');
        var playBtn = document.getElementById('ir-global-anim-play');
        var speedBtn = document.getElementById('ir-global-anim-speed');
        var statusEl = document.getElementById('ir-global-anim-status');
        var timeEl = document.getElementById('ir-global-anim-time');

        var nFrames = globalAnimFrameLayers.length;
        if (slider) {
            if (nFrames > 0) {
                slider.disabled = false;
                slider.max = String(nFrames - 1);
                slider.value = String(globalAnimIndex);
            } else {
                slider.disabled = true;
                slider.max = '0';
                slider.value = '0';
            }
        }
        if (playBtn) {
            playBtn.innerHTML = globalAnimPlaying ? '&#10074;&#10074;' : '&#9654;';
            playBtn.title = globalAnimPlaying ? 'Pause' :
                (nFrames > 0 ? 'Resume animation' : 'Load & play global animation');
            playBtn.classList.toggle('active', globalAnimPlaying);
        }
        if (speedBtn) {
            speedBtn.textContent = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].label;
        }
        if (statusEl) {
            if (globalAnimLoading) {
                statusEl.textContent =
                    'loading ' + globalAnimLoaded + '/' + globalAnimFrameTimes.length;
            } else if (nFrames > 0) {
                statusEl.textContent = (globalAnimIndex + 1) + '/' + nFrames;
            } else {
                statusEl.textContent = '';
            }
        }
        if (timeEl && nFrames === 0) timeEl.textContent = '—';
    }

    /** Step to next global animation frame */
    function nextGlobalFrame() {
        if (!globalAnimReady || globalAnimFrameLayers.length === 0) return;
        var next = (globalAnimIndex + 1) % globalAnimFrameLayers.length;
        showGlobalAnimFrame(next);
    }

    /** Step to previous global animation frame */
    function prevGlobalFrame() {
        if (!globalAnimReady || globalAnimFrameLayers.length === 0) return;
        var prev = (globalAnimIndex - 1 + globalAnimFrameLayers.length) % globalAnimFrameLayers.length;
        showGlobalAnimFrame(prev);
    }

    /** rAF tick for global animation */
    function _globalAnimTick(ts) {
        if (!globalAnimPlaying) return;
        var ms = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].ms;
        if (ts - globalAnimLastTick >= ms) {
            globalAnimLastTick = ts;
            nextGlobalFrame();
        }
        globalAnimTimer = requestAnimationFrame(_globalAnimTick);
    }

    /** Start global animation loop */
    function startGlobalAnimation() {
        if (!globalAnimReady) {
            // Start loading if not yet loaded
            loadGlobalAnimation();
            return;
        }
        globalAnimPlaying = true;
        updateGlobalAnimControls('playing');
        globalAnimLastTick = 0;
        globalAnimTimer = requestAnimationFrame(_globalAnimTick);
    }

    /** Cycle to the next animation speed and restart if playing */
    function cycleGlobalAnimSpeed() {
        globalAnimSpeedIdx = (globalAnimSpeedIdx + 1) % GLOBAL_ANIM_SPEEDS.length;
        _refreshAnimSlider();
        // Speed change takes effect automatically on next rAF tick (no restart needed)
    }

    /** Stop global animation loop */
    function stopGlobalAnimation() {
        globalAnimPlaying = false;
        if (globalAnimTimer) cancelAnimationFrame(globalAnimTimer);
        globalAnimTimer = null;
        if (globalAnimReady) {
            updateGlobalAnimControls('ready');
        }
    }

    /** Toggle global animation play/pause */
    function toggleGlobalAnimation() {
        if (globalAnimPlaying) {
            stopGlobalAnimation();
        } else {
            startGlobalAnimation();
        }
    }

    /** Clean up global animation frames */
    function cleanupGlobalAnimation() {
        stopGlobalAnimation();
        for (var i = 0; i < globalAnimFrameLayers.length; i++) {
            if (map && globalAnimFrameLayers[i]) {
                map.removeLayer(globalAnimFrameLayers[i]);
            }
        }
        globalAnimFrameLayers = [];
        globalAnimFrameTimes = [];
        globalAnimLoaded = 0;
        globalAnimReady = false;
        globalAnimLoading = false;
        globalAnimIndex = 0;
        updateGlobalAnimControls('idle');
    }

    /** Update the global animation control panel state. State transitions
     *  ('idle', 'loading', 'ready', 'playing') are passed in so the
     *  loading-pct case can show a percentage, but most of the visual
     *  state is driven by the globalAnim* booleans via _refreshAnimSlider. */
    function updateGlobalAnimControls(state, pct) {
        var panel = document.getElementById('ir-global-anim-panel');
        if (!panel) return;
        var playBtn = document.getElementById('ir-global-anim-play');
        var statusEl = document.getElementById('ir-global-anim-status');

        if (state === 'loading') {
            if (playBtn) { playBtn.innerHTML = '&#8987;'; playBtn.title = 'Loading frames\u2026'; playBtn.disabled = true; }
            if (statusEl) statusEl.textContent = (pct != null ? pct + '%' : 'Loading\u2026');
        } else {
            if (playBtn) playBtn.disabled = false;
        }
        _refreshAnimSlider();
    }

    /** Build an array of GIBS time strings for animation (lookback_hours, every 30 min).
     *  @param {Date}    centerDt      - end time reference
     *  @param {number}  lookbackHours - how many hours to look back
     *  @param {boolean} verified      - if true, centerDt is an already-verified
     *                                   GIBS time so skip the 15-min safety margin */
    function buildFrameTimes(centerDt, lookbackHours, verified) {
        var times = [];
        var end = roundToGIBSInterval(centerDt);
        if (!verified) {
            // Apply 15-min safety margin when using unverified current time
            end = new Date(end.getTime() - 15 * 60 * 1000);
        }
        var start = new Date(end.getTime() - lookbackHours * 3600 * 1000);
        var step = 30 * 60 * 1000; // 30-min steps for animation (not every 10 min — too many frames)
        for (var t = start.getTime(); t <= end.getTime(); t += step) {
            var d = roundToGIBSInterval(new Date(t));
            times.push(toGIBSTime(d));
        }
        return times;
    }

    // ═══════════════════════════════════════════════════════════
    //  MAP VIEW
    // ═══════════════════════════════════════════════════════════

    /** Initialize the Leaflet map */
    function initMap() {
        map = L.map('ir-map', {
            center: [20, -40],
            zoom: 3,
            minZoom: 2,
            maxZoom: GIBS_MAX_ZOOM,
            zoomControl: true,
            worldCopyJump: true,
            preferCanvas: true  // faster rendering for vector overlays
        });

        // Dark basemap (underneath IR) — load first for fast initial paint
        var basemap = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd',
            maxZoom: 19
        }).addTo(map);

        // Defer GIBS overlay slightly so basemap tiles get priority in the browser's
        // connection pool (6 connections per host). This makes the map feel responsive
        // immediately rather than everything loading at once.
        // addGIBSOverlay is now async (probes for latest available GIBS time)
        // and updates gibsIRLayers directly when the layer is ready.
        var gibsRequested = false;
        basemap.once('load', function () {
            if (!gibsRequested) {
                gibsRequested = true;
                addGIBSOverlay(map, 0.85);
            }
        });
        // Fallback in case basemap load event doesn't fire (cached tiles)
        setTimeout(function () {
            if (!gibsRequested) {
                gibsRequested = true;
                addGIBSOverlay(map, 0.85);
            }
        }, 800);

        // Coastline overlay — Natural Earth 50m GeoJSON as thin black outlines
        // (same approach as global archive) so land masses are clearly visible.
        map.createPane('coastlinePane');
        map.getPane('coastlinePane').style.zIndex = 450;
        map.getPane('coastlinePane').style.pointerEvents = 'none';
        _loadCoastlineOverlay(map);

        // Labels on top of IR — stashed on `_labelsLayer` so the "Labels"
        // toggle in the right rail can add/remove it without rebuilding.
        _labelsLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | IR: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
            subdomains: 'abcd',
            maxZoom: 19,
            pane: 'overlayPane'
        });
        if (_labelsVisible) _labelsLayer.addTo(map);

        map.zoomControl.setPosition('topleft');

        // Allow zoom 7 (GeoColor tiles go up to Level7)
        map.setMaxZoom(GIBS_VIS_MAX_ZOOM);

        // ── Unified Layers panel (replaces the old stack of separate
        //    DeepMind / Genesis / Winds / Env Analysis pills) ────────
        // One trigger pill opens a single sectioned panel grouping
        // FORECAST / ANALYSIS / WIND BARBS so the right rail goes from
        // five disjointed buttons to one primary control with a count
        // badge that tells the user how many overlays are on without
        // having to open the panel. Save PNG sits beside it as a small
        // utility icon. All the underlying toggles (toggleGlobalWeatherlab,
        // toggleGenesis, _activate/_deactivateEnvLayer, _setEnvOpacity)
        // stay as the single source of truth — this is a UI shell only.
        var LayersControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                var wrap = L.DomUtil.create('div', 'ir-layers-wrap');
                L.DomEvent.disableClickPropagation(wrap);
                L.DomEvent.disableScrollPropagation(wrap);

                // ── Trigger row: [Layers ▾ (N)]  [📷] ─────────────
                var row = L.DomUtil.create('div', 'ir-layers-row', wrap);

                var btn = L.DomUtil.create('button', 'ir-global-toggle-btn ir-layers-toggle', row);
                btn.id = 'ir-layers-toggle';
                btn.title = 'Open the layers panel — forecast tracks, env analysis, wind barbs';
                btn.innerHTML = '<span class="ir-layers-label">Layers</span>'
                              + '<span class="ir-layers-caret">▾</span>'
                              + '<span class="ir-layers-count" id="ir-layers-count"></span>';
                btn.addEventListener('click', toggleLayersPanel);

                var exportBtn = L.DomUtil.create('button', 'ir-global-toggle-btn ir-layers-icon-btn', row);
                exportBtn.id = 'ir-global-export-btn';
                exportBtn.title = 'Save the current map view as a PNG image';
                exportBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
                    + '<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"'
                    + ' d="M3 11.5v1.5h10v-1.5M8 2.5v8M4.5 7L8 10.5L11.5 7"/>'
                    + '</svg>';
                exportBtn.addEventListener('click', _exportMapPng);

                // ── Compact IR/GeoColor mode switch (segmented) ─────
                var seg = L.DomUtil.create('div', 'ir-mode-segment', wrap);
                seg.id = 'ir-mode-segment';
                seg.innerHTML =
                      '<button type="button" class="ir-mode-btn ir-mode-active" data-mode="eir">IR</button>'
                    + '<button type="button" class="ir-mode-btn"               data-mode="geocolor">GeoColor</button>';
                var modeBtns = seg.querySelectorAll('.ir-mode-btn');
                for (var mi = 0; mi < modeBtns.length; mi++) {
                    modeBtns[mi].addEventListener('click', function (e) {
                        setGlobalProduct(e.target.getAttribute('data-mode'));
                    });
                }

                // ── Microwave one-click toggle + options chevron ────
                // Sibling of the IR/GeoColor pills so users don't have
                // to dig through the Layers panel to enable the MW
                // overlay. Split-button pattern:
                //   - Main pill (left): click toggles MW on/off
                //   - Chevron (right): opens the Layers panel and
                //     scrolls to the Microwave section so users can
                //     discover product picker / sensor toggles / time
                //     scrubber / legend without already knowing where
                //     to find them.
                var mwGroup = L.DomUtil.create('div', 'ir-mw-toggle-group', wrap);
                mwGroup.id = 'ir-mw-toggle-group';

                var mwTopBtn = L.DomUtil.create('button', 'ir-mw-toggle-btn', mwGroup);
                mwTopBtn.id = 'ir-mw-toggle-btn';
                mwTopBtn.type = 'button';
                mwTopBtn.title = 'Toggle real-time microwave swaths (GMI / SSMI/S / AMSR2)';
                mwTopBtn.innerHTML = '<span class="ir-mw-toggle-dot"></span>'
                                   + '<span class="ir-mw-toggle-text">Microwave</span>';
                mwTopBtn.addEventListener('click', function () {
                    var inst = _rtEnsureMwLayer();
                    if (inst) inst.toggle();
                });

                var mwExpandBtn = L.DomUtil.create('button', 'ir-mw-expand-btn', mwGroup);
                mwExpandBtn.id = 'ir-mw-expand-btn';
                mwExpandBtn.type = 'button';
                mwExpandBtn.title = 'Microwave options (product, sensors, time, legend, opacity)';
                mwExpandBtn.innerHTML = '<span aria-hidden="true">▾</span>';

                // Popover that holds the MW controls. Sibling of the
                // pill group so absolute positioning anchors to wrap.
                // Hidden by default — the chevron toggles visibility
                // and the helper's UI host lives inside permanently.
                var mwPopover = L.DomUtil.create('div', 'ir-mw-popover', wrap);
                mwPopover.id = 'ir-mw-popover';
                mwPopover.style.display = 'none';
                // Stop wheel + click from reaching the map.
                L.DomEvent.disableClickPropagation(mwPopover);
                L.DomEvent.disableScrollPropagation(mwPopover);

                mwExpandBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    // Lazily construct the helper so the controls UI
                    // (and its host) exists. _rtEnsureMwLayer hands
                    // _rtMwHost; we then re-parent it into the popover.
                    var inst = _rtEnsureMwLayer();
                    if (inst && _rtMwHost && _rtMwHost.parentNode !== mwPopover) {
                        mwPopover.appendChild(_rtMwHost);
                    }
                    var visible = mwPopover.style.display !== 'none';
                    mwPopover.style.display = visible ? 'none' : 'block';
                    mwExpandBtn.classList.toggle('open', !visible);
                });

                // Close on click outside (anywhere not inside the popover
                // or its trigger). Bound once at construction.
                document.addEventListener('mousedown', function (e) {
                    if (mwPopover.style.display === 'none') return;
                    if (mwPopover.contains(e.target)) return;
                    if (mwExpandBtn.contains(e.target)) return;
                    mwPopover.style.display = 'none';
                    mwExpandBtn.classList.remove('open');
                });
                // Close on Escape for keyboard users.
                document.addEventListener('keydown', function (e) {
                    if (e.key === 'Escape' && mwPopover.style.display !== 'none') {
                        mwPopover.style.display = 'none';
                        mwExpandBtn.classList.remove('open');
                    }
                });

                // ── DeepMind WeatherLab status pill ──────────────────
                // (Previously sat under its own dedicated button.) Now
                // lives just below the Layers trigger so the load state
                // is visible whenever DeepMind tracks are active.
                var status = L.DomUtil.create('span', 'ir-global-wl-status', wrap);
                status.id = 'ir-global-wl-status';
                status.style.display = 'none';

                // ── Panel container ───────────────────────────────────
                //  Two persistent children:
                //  (1) .ir-layers-sheet-header — mobile-only, holds the
                //      drag-handle pill + X close button. Tapping either
                //      closes the bottom sheet. Hidden on desktop.
                //  (2) .ir-layers-content — re-rendered on every panel
                //      open by _renderLayersPanel().
                //  The header lives OUTSIDE the content so innerHTML
                //  replacement in _renderLayersPanel doesn't blow it away.
                var panel = L.DomUtil.create('div', 'ir-layers-panel ir-global-menu', wrap);
                panel.id = 'ir-layers-panel';
                panel.style.display = 'none';

                var header = L.DomUtil.create('div', 'ir-layers-sheet-header', panel);
                var handle = L.DomUtil.create('button', 'ir-layers-handle', header);
                handle.type = 'button';
                handle.setAttribute('aria-label', 'Close layers panel');
                handle.addEventListener('click', function () {
                    if (_rtLayersPanelOpen) toggleLayersPanel();
                });
                var closeBtn = L.DomUtil.create('button', 'ir-layers-sheet-close', header);
                closeBtn.type = 'button';
                closeBtn.setAttribute('aria-label', 'Close layers panel');
                closeBtn.innerHTML = '&times;';
                closeBtn.addEventListener('click', function () {
                    if (_rtLayersPanelOpen) toggleLayersPanel();
                });

                var content = L.DomUtil.create('div', 'ir-layers-content', panel);
                content.id = 'ir-layers-content';
                content.innerHTML = '<div class="ir-global-menu-empty">Loading layers…</div>';

                return wrap;
            }
        });
        map.addControl(new LayersControl());

        // Eager-mount the MW helper if prefs say the user had it on
        // previously. Without this, anything that triggers a full page
        // reload (tab crash + Chrome auto-restore is the leading
        // candidate for the observed zoom-reload symptom) would leave
        // MW dormant until the user manually re-opened the Layers
        // panel. The helper's constructor reads its own prefs and
        // auto-enables, so a quiet pre-mount is sufficient.
        try {
            var _mwPrefRaw = window.localStorage && window.localStorage.getItem('tc-atlas-mw-prefs');
            if (_mwPrefRaw) {
                var _mwPref = JSON.parse(_mwPrefRaw);
                if (_mwPref && _mwPref.enabled === true) {
                    // Defer one tick so the layers panel control fully
                    // initializes before we ask for its slot.
                    setTimeout(_rtEnsureMwLayer, 0);
                }
            }
        } catch (e) { /* prefs unavailable — fine, lazy path still works */ }

        // Env colorbar — fixed-position bottom-LEFT, above the
        // Brightness Temp colorbar + animation panel. Previously lived
        // bottom-right, but the unified Layers panel claims that edge
        // and the colorbar stack would creep up into it as more
        // overlays were toggled on. The bottom-left is the dedicated
        // "data legends" zone and never collides with the Layers panel.
        if (!document.getElementById('ir-global-env-cbars')) {
            var ebox = document.createElement('div');
            ebox.id = 'ir-global-env-cbars';
            ebox.style.cssText =
                'position:fixed;left:12px;bottom:140px;display:none;' +
                'background:rgba(22,27,36,0.93);padding:8px 12px;' +
                'border-radius:6px;border:1px solid rgba(255,255,255,0.14);' +
                'backdrop-filter:blur(6px);z-index:700;' +
                'box-shadow:0 4px 14px rgba(0,0,0,0.25);' +
                'max-width:min(60vw, 420px);' +
                'max-height:calc(100vh - 240px);overflow-y:auto;';
            document.body.appendChild(ebox);
        }

        // Intensity legend toggle — small pill below the Basins button.
        // The legend itself is hidden by default; users opt in.
        if (!document.getElementById('ir-legend-toggle')) {
            var ltog = document.createElement('button');
            ltog.id = 'ir-legend-toggle';
            ltog.className = 'ir-legend-toggle';
            ltog.type = 'button';
            ltog.title = 'Show / hide Saffir-Simpson intensity legend';
            ltog.innerHTML = '✦ Legend';
            ltog.addEventListener('click', function () {
                var leg = document.getElementById('ir-legend');
                if (!leg) return;
                // Track via the toggle's own .active class — checking
                // leg.style.display fails after first toggle because
                // we set it to '' (falsy), which the old code read as
                // "hidden" and re-showed instead of hiding.
                var on = !ltog.classList.contains('active');
                leg.style.display = on ? '' : 'none';
                ltog.classList.toggle('active', on);
            });
            document.body.appendChild(ltog);
        }

        // Labels toggle — sits in the top-left stack under the Legend
        // toggle (Basins → Legend → Labels). Reuses the same pill
        // styling so the three controls read as one column. Default
        // OFF so env-overlay colors / contours read cleanly; users can
        // flip them on for geographic context.
        if (!document.getElementById('ir-labels-toggle')) {
            var labtog = document.createElement('button');
            labtog.id = 'ir-labels-toggle';
            labtog.className = 'ir-legend-toggle ir-labels-toggle-pos';
            labtog.type = 'button';
            labtog.title = 'Show / hide country & city labels on the basemap';
            labtog.innerHTML = '⌖ Labels';
            if (_labelsVisible) labtog.classList.add('active');
            labtog.addEventListener('click', function () { toggleLabels(); });
            document.body.appendChild(labtog);
        }

        // Lat/lon graticule toggle — sits below Labels in the same
        // top-left stack (Basins → Legend → Labels → Grid). Adaptive
        // spacing: 10° at world zoom, 5° at sub-basin, 2° at storm
        // zoom, 1° at meso. Labels at integer grid intersections.
        if (!document.getElementById('ir-grid-toggle')) {
            var gtog = document.createElement('button');
            gtog.id = 'ir-grid-toggle';
            gtog.className = 'ir-legend-toggle ir-grid-toggle-pos';
            gtog.type = 'button';
            gtog.title = 'Show / hide lat/lon graticule (scales with zoom)';
            gtog.innerHTML = '▦ Grid';
            gtog.addEventListener('click', function () {
                _rtToggleGraticule();
                gtog.classList.toggle('active', !!_rtGraticule);
            });
            document.body.appendChild(gtog);
        }

        // Add IR Tb colorbar to global map (bottom-left, above animation panel)
        var TbColorbar = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                var container = L.DomUtil.create('div', 'ir-global-colorbar');
                container.id = 'ir-global-colorbar';
                container.style.cssText = 'background:rgba(0,0,0,0.65);padding:6px 10px;border-radius:4px;font-family:JetBrains Mono,monospace;font-size:0.65rem;color:rgba(255,255,255,0.7);pointer-events:none;margin-bottom:4px;';
                L.DomEvent.disableClickPropagation(container);

                var label = L.DomUtil.create('div', '', container);
                label.textContent = 'Brightness Temp (K)';
                label.style.cssText = 'margin-bottom:2px;';

                var bar = L.DomUtil.create('div', '', container);
                bar.style.cssText = 'width:160px;height:10px;border-radius:2px;margin:4px 0 2px;background:linear-gradient(to right,rgb(8,8,8),rgb(90,90,90),rgb(200,200,200),rgb(0,100,255),rgb(0,255,0),rgb(255,180,0),rgb(255,0,0),rgb(180,0,180),rgb(255,255,255));';

                var labels = L.DomUtil.create('div', '', container);
                labels.style.cssText = 'display:flex;justify-content:space-between;font-size:0.6rem;';
                labels.innerHTML = '<span>310</span><span>250</span><span>190</span>';

                return container;
            }
        });
        map.addControl(new TbColorbar());

        // Global IR animation slider — mirrors the .ir-bar pattern on
        // the Global Archive storm detail page (step buttons + play +
        // draggable scrubber + monospace timestamp + speed pill) so
        // this scrubber feels like the rest of the site.
        var AnimPanel = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                var bar = L.DomUtil.create('div', 'rt-anim-bar');
                bar.id = 'ir-global-anim-panel';
                L.DomEvent.disableClickPropagation(bar);
                L.DomEvent.disableScrollPropagation(bar);

                var row = L.DomUtil.create('div', 'rt-anim-row', bar);

                var prevBtn = L.DomUtil.create('button', 'rt-anim-btn rt-anim-step', row);
                prevBtn.innerHTML = '&#9664;';
                prevBtn.title = 'Previous frame';
                prevBtn.addEventListener('click', function () {
                    stopGlobalAnimation();
                    prevGlobalFrame();
                });

                var playBtn = L.DomUtil.create('button', 'rt-anim-btn rt-anim-play', row);
                playBtn.id = 'ir-global-anim-play';
                playBtn.innerHTML = '&#9654;';
                playBtn.title = 'Load & play global animation';
                playBtn.addEventListener('click', toggleGlobalAnimation);

                var nextBtn = L.DomUtil.create('button', 'rt-anim-btn rt-anim-step', row);
                nextBtn.innerHTML = '&#9654;';
                nextBtn.title = 'Next frame';
                nextBtn.addEventListener('click', function () {
                    stopGlobalAnimation();
                    nextGlobalFrame();
                });

                var stopBtn = L.DomUtil.create('button', 'rt-anim-btn rt-anim-stop', row);
                stopBtn.innerHTML = '&#9632;';
                stopBtn.title = 'Stop animation and return to latest';
                stopBtn.addEventListener('click', function () {
                    if (globalAnimFrameLayers.length === 0) return;
                    cleanupGlobalAnimation();
                    if (latestGIBSTime) {
                        if (globalProduct === 'geocolor') {
                            var visLyr = createCompositeGIBSLayerVis(latestGIBSTime, 0.75);
                            visLyr.addTo(map);
                            gibsVisLayers = [visLyr];
                        } else {
                            var perSat = (Object.keys(latestGIBSTimes).length > 0) ? latestGIBSTimes : null;
                            var irLyr = createCompositeGIBSLayer(latestGIBSTime, 0.85, perSat);
                            irLyr.addTo(map);
                            gibsIRLayers = [irLyr];
                        }
                    }
                    _refreshAnimSlider();
                });

                var slider = L.DomUtil.create('input', 'rt-anim-slider', row);
                slider.id = 'ir-global-anim-slider';
                slider.type = 'range';
                slider.min = '0';
                slider.max = '0';
                slider.value = '0';
                slider.disabled = true;
                slider.title = 'Scrub through loaded animation frames';
                slider.addEventListener('input', function () {
                    if (!globalAnimReady) return;
                    stopGlobalAnimation();
                    var idx = parseInt(slider.value, 10);
                    if (!isNaN(idx)) showGlobalAnimFrame(idx);
                });

                var dt = L.DomUtil.create('span', 'rt-anim-dt', row);
                dt.id = 'ir-global-anim-time';
                dt.textContent = '—';

                var speedBtn = L.DomUtil.create('button', 'rt-anim-btn rt-anim-speed', row);
                speedBtn.id = 'ir-global-anim-speed';
                speedBtn.textContent = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].label;
                speedBtn.title = 'Cycle animation speed';
                speedBtn.addEventListener('click', cycleGlobalAnimSpeed);

                var statusSpan = L.DomUtil.create('span', 'rt-anim-status', row);
                statusSpan.id = 'ir-global-anim-status';

                return bar;
            }
        });
        map.addControl(new AnimPanel());

        // ── Keyboard shortcuts for the global IR animation ──────
        // ←/→  step prev/next frame   Space  play/pause
        // +/=  speed up                -      slow down
        // Skipped if focus is in an input/textarea/select, if the
        // global map view is hidden (storm-detail open), or if the
        // user is holding a modifier key (let browser shortcuts win).
        document.addEventListener('keydown', function (e) {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            var t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
                || t.tagName === 'SELECT' || t.isContentEditable)) return;
            // Only act when the global map is the visible view — bail if
            // the storm-detail overlay is up (it covers the global anim
            // panel, so scrubbing the unseen slider would surprise users).
            var detail = document.getElementById('ir-detail');
            if (detail && detail.style.display !== 'none' && detail.offsetParent !== null) return;
            var panel = document.getElementById('ir-global-anim-panel');
            if (!panel) return;

            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    stopGlobalAnimation();
                    prevGlobalFrame();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    stopGlobalAnimation();
                    nextGlobalFrame();
                    break;
                case ' ':
                case 'Spacebar':
                    e.preventDefault();
                    toggleGlobalAnimation();
                    break;
                case '+':
                case '=':
                    e.preventDefault();
                    cycleGlobalAnimSpeed();
                    break;
                case '-':
                case '_':
                    e.preventDefault();
                    // Step backward through the speed list — wrap by
                    // adding LENGTH before the modulo so −1 → last entry.
                    globalAnimSpeedIdx = (globalAnimSpeedIdx - 1 + GLOBAL_ANIM_SPEEDS.length) % GLOBAL_ANIM_SPEEDS.length;
                    _refreshAnimSlider();
                    break;
            }
        });
    }

    /** Clear existing storm markers from the map */
    function clearMarkers() {
        for (var i = 0; i < stormMarkers.length; i++) {
            map.removeLayer(stormMarkers[i]);
        }
        stormMarkers = [];
    }

    /** Place storm markers on the map */
    function renderStormMarkers(storms) {
        clearMarkers();

        for (var i = 0; i < storms.length; i++) {
            var s = storms[i];
            // Suppress storms already represented by an FNV3 disturbance
            // pin (matched within 600 km). The disturbance marker shows
            // the official ATCF name and its modal has a "View IR
            // Detail" button to reach the satellite page, so two pins
            // for the same system are pure clutter.
            if (s.atcf_id
                    && _genesisMatchedAtcfIds[String(s.atcf_id).toUpperCase()]) {
                continue;
            }
            var cat = s.category || windToCategory(s.vmax_kt);
            var color = SS_COLORS[cat] || SS_COLORS.TD;

            var icon = L.divIcon({
                className: '',
                html: '<div class="ir-storm-marker" style="' +
                      'width:18px;height:18px;background:' + color + ';' +
                      'color:' + color + ';' +
                      '"></div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9],
                popupAnchor: [0, -12]
            });

            var marker = L.marker([s.lat, s.lon], { icon: icon });

            // Popup content
            var vmaxStr = s.vmax_kt != null ? s.vmax_kt + ' kt' : '\u2014';
            var mslpStr = s.mslp_hpa != null ? s.mslp_hpa + ' hPa' : '\u2014';
            var popupHtml =
                '<div class="ir-popup">' +
                  '<div class="ir-popup-name">' + (s.name || 'UNNAMED') + '</div>' +
                  '<div class="ir-popup-meta">' +
                    '<strong>' + categoryShort(cat) + '</strong> &middot; ' + vmaxStr + '<br>' +
                    'MSLP: ' + mslpStr + '<br>' +
                    fmtLatLon(s.lat, s.lon) + '<br>' +
                    '<span style="color:#64748b;">' + (s.atcf_id || '') + '</span>' +
                  '</div>' +
                  '<button class="ir-popup-btn" onclick="window._irOpenStorm(\'' + s.atcf_id + '\')">View IR Detail</button>' +
                '</div>';

            marker.bindPopup(popupHtml, { maxWidth: 260 });

            // Also open detail on double-click
            (function (atcfId) {
                marker.on('dblclick', function () {
                    window._irOpenStorm(atcfId);
                });
            })(s.atcf_id);

            marker.addTo(map);
            stormMarkers.push(marker);
        }
    }

    /** Clear past track layers from the map */
    function clearTracks() {
        for (var i = 0; i < trackLayers.length; i++) {
            map.removeLayer(trackLayers[i]);
        }
        trackLayers = [];
    }

    /** Fetch metadata for a storm and draw its past track on the main map */
    function fetchAndDrawTrack(storm) {
        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id) + '/metadata';

        fetch(url, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (meta) {
                if (!meta || !meta.intensity_history || meta.intensity_history.length < 2) return;
                drawTrackOnMap(map, meta.intensity_history, storm, trackLayers);
            })
            .catch(function (err) { console.warn('[RT Monitor] Track fetch failed:', err.message || ''); });
    }

    /** Draw a past track polyline + intensity dots on a Leaflet map */
    function drawTrackOnMap(targetMap, history, storm, layerArr) {
        // Build segments colored by intensity
        for (var i = 1; i < history.length; i++) {
            var prev = history[i - 1];
            var curr = history[i];

            // Skip segments with impossibly large spatial jumps (recycled invest IDs)
            var dlat = curr.lat - prev.lat;
            var dlon = curr.lon - prev.lon;
            if (Math.abs(dlon) > 180) dlon = dlon - Math.sign(dlon) * 360; // antimeridian
            var cosLat = Math.cos((curr.lat + prev.lat) * 0.5 * Math.PI / 180);
            var dist = Math.sqrt(dlat * dlat + (dlon * cosLat) * (dlon * cosLat));
            if (dist > 8) continue;  // >8° (~900 km) in one fix interval = invest recycling

            // Skip drawing across antimeridian (2-point segments can't wrap)
            if (Math.abs(curr.lon - prev.lon) > 180) continue;

            var cat = windToCategory(curr.vmax_kt);
            var color = SS_COLORS[cat] || SS_COLORS.TD;

            // Segment polyline
            var seg = L.polyline(
                [[prev.lat, prev.lon], [curr.lat, curr.lon]],
                { color: color, weight: 2.5, opacity: 0.7 }
            );
            seg.addTo(targetMap);
            layerArr.push(seg);

            // Dot at each fix
            var dot = L.circleMarker([curr.lat, curr.lon], {
                radius: 3, color: color, fillColor: color,
                fillOpacity: 0.9, weight: 0
            });
            // Tooltip with time + wind
            var tipText = fmtUTC(curr.time) +
                (curr.vmax_kt != null ? ' — ' + curr.vmax_kt + ' kt' : '');
            dot.bindTooltip(tipText, { direction: 'top', offset: [0, -6] });
            dot.addTo(targetMap);
            layerArr.push(dot);
        }

        // Name label near the current position
        var last = history[history.length - 1];
        var cat = storm.category || windToCategory(storm.vmax_kt);
        var label = L.marker([last.lat, last.lon], {
            icon: L.divIcon({
                className: '',
                html: '<div style="color:#fff;font-size:11px;font-weight:600;' +
                      'text-shadow:0 1px 3px rgba(0,0,0,0.8);white-space:nowrap;' +
                      'pointer-events:none;transform:translate(12px,-6px);">' +
                      (storm.name || storm.atcf_id) + '</div>',
                iconSize: [0, 0]
            }),
            interactive: false
        });
        label.addTo(targetMap);
        layerArr.push(label);
    }

    /** Fetch tracks for all active storms */
    function fetchAllTracks(storms) {
        clearTracks();
        for (var i = 0; i < storms.length; i++) {
            fetchAndDrawTrack(storms[i]);
        }
    }

    /** Update the stats bar in the topbar */
    function updateStats(data) {
        var el = function (id) { return document.getElementById(id); };

        var totalActive = data.storms ? data.storms.length : 0;
        el('stat-active').textContent = totalActive;

        var byBasin = data.count_by_basin || {};
        el('stat-atl').textContent = (byBasin.ATL || 0);
        el('stat-epac').textContent = (byBasin.EPAC || 0);
        el('stat-wpac').textContent = (byBasin.WPAC || 0);
        el('stat-shem').textContent = (byBasin.SHEM || 0);

        // Update status bar
        if (totalActive === 0) {
            el('ir-status-text').textContent = 'No active tropical cyclones';
        } else {
            el('ir-status-text').textContent = totalActive + ' active system' + (totalActive === 1 ? '' : 's');
        }
        if (data.updated_utc) {
            el('ir-last-update').textContent = 'Updated: ' + fmtUTC(data.updated_utc);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  DATA FETCHING
    // ═══════════════════════════════════════════════════════════

    var _LS_STORMS_KEY = 'tc-atlas-rt-storms';
    var _activeStormsETag = null;  // last ETag served by /active-storms

    /** Poll /ir-monitor/active-storms */
    function pollActiveStorms() {
        var loaderEl = document.getElementById('ir-loader');

        // Show cached storms immediately while fresh fetch runs
        if (stormData.length === 0) {
            try {
                var cached = localStorage.getItem(_LS_STORMS_KEY);
                if (cached) {
                    var parsed = JSON.parse(cached);
                    if (parsed.storms && parsed.storms.length > 0) {
                        stormData = parsed.storms;
                        if (loaderEl) loaderEl.style.display = 'none';
                        updateStats(parsed);
                        renderStormMarkers(stormData);
                        _rtPushStormsToMwLayer();
                        handleDeepLink();
                        console.log('[RT Monitor] Showing ' + stormData.length + ' cached storms while fetching fresh data');
                    }
                }
            } catch (e) { /* ignore localStorage errors */ }
        }

        var headers = {};
        if (_activeStormsETag) headers['If-None-Match'] = _activeStormsETag;

        fetch(API_BASE + '/ir-monitor/active-storms', { cache: 'no-store', headers: headers })
            .then(function (r) {
                if (r.status === 304) {
                    // Server confirms our cached payload is still current — no work to do.
                    if (loaderEl) loaderEl.style.display = 'none';
                    return null;
                }
                if (!r.ok) throw new Error('HTTP ' + r.status);
                var et = r.headers.get('ETag');
                if (et) _activeStormsETag = et;
                return r.json();
            })
            .then(function (data) {
                if (data === null) return;  // 304 — nothing changed
                stormData = data.storms || [];

                // Cache to localStorage for instant display on next visit
                try { localStorage.setItem(_LS_STORMS_KEY, JSON.stringify(data)); } catch (e) { }

                // Hide loader
                if (loaderEl) loaderEl.style.display = 'none';

                // Update UI
                updateStats(data);
                renderStormMarkers(stormData);
                fetchAllTracks(stormData);
                _rtPushStormsToMwLayer();

                // If genesis data is already loaded, re-render so any
                // newly-arrived ATCF storm gets paired with its matching
                // FNV3 disturbance ("Disturbance 1" → "TD 01W"). Cheap
                // because the disturbance list is already cached.
                if (_rtGenesisData && typeof _renderGenesis === 'function') {
                    try { _renderGenesis(); } catch (e) { /* non-fatal */ }
                }

                // Handle deep link on first load
                handleDeepLink();

                // If viewing a storm detail, refresh the header with
                // latest data (name changes, position updates, etc.)
                if (currentStormId) {
                    _refreshDetailHeader(stormData);
                    // Also refresh the intensity chart with latest metadata
                    fetchStormMetadata(currentStormId, function (err, meta) {
                        if (!err && meta) renderIntensityChart(meta);
                    });
                }

                // Pre-warm raw Tb cache for all active storms so data is
                // ready instantly when a user clicks into the detail view.
                _prefetchAllStormsRawTb(stormData);

                _ga('ir_poll_success', { storm_count: stormData.length });
            })
            .catch(function (err) {
                console.warn('[RT Monitor] Poll failed:', err.message);

                // Hide loader, show status
                if (loaderEl) loaderEl.style.display = 'none';
                var statusEl = document.getElementById('ir-status-text');
                if (statusEl) statusEl.textContent = 'Unable to reach server — retrying in 10 min';

                _ga('ir_poll_error', { error: err.message });
            });
    }

    /** Clean up pre-loaded frame layers */
    function cleanupFrameLayers() {
        for (var i = 0; i < animFrameLayers.length; i++) {
            if (animFrameLayers[i] && detailMap) {
                detailMap.removeLayer(animFrameLayers[i]);
            }
        }
        animFrameLayers = [];
        animFrameTimes = [];
        framesLoaded = 0;
        _frameLoadedOnce = {};
        framesReady = false;
        // Also clean up GeoColor frames
        cleanupGeocolorFrameLayers();
    }

    /** Show/hide the loading progress overlay on the detail map */
    function showLoadingProgress(show, pct) {
        var loader = document.getElementById('ir-image-loader');
        var loaderText = loader ? loader.querySelector('.ir-loader-text') : null;
        if (!loader) return;
        if (show) {
            loader.style.display = 'flex';
            if (loaderText) {
                var label = (productMode === 'geocolor') ? 'GeoColor' : 'IR';
                loaderText.textContent = pct != null
                    ? 'Pre-loading ' + label + ' frames\u2026 ' + pct + '%'
                    : 'Pre-loading ' + label + ' frames\u2026';
            }
        } else {
            loader.style.display = 'none';
        }
    }

    var _frameLoadedOnce = {};  // track which frames have fired their initial load
    var _firstFrameShown = false;  // true once we've shown the first available frame
    var _rawTbPrefetchStarted = false;  // guard: only start raw Tb pre-fetch once per storm
    var _deferredLoadsStarted = false;  // guard: only start deferred data loads once per storm
    var _deferredStormRef = null;       // storm object for deferred loads

    /** Called when a single frame layer finishes loading its tiles */
    function onFrameLayerLoaded(frameIdx) {
        // Ignore re-fires from zoom/pan — only count the initial load
        if (_frameLoadedOnce[frameIdx]) return;
        _frameLoadedOnce[frameIdx] = true;

        framesLoaded++;
        var total = animFrameTimes.length;
        var pct = Math.round((framesLoaded / total) * 100);

        // Track this frame as valid if it didn't have tile errors
        if (!frameHasError[frameIdx]) {
            validFrames.push(frameIdx);
            validFrames.sort(function (a, b) { return a - b; });
        }

        // Show the FIRST valid frame immediately so the user sees imagery
        // right away instead of staring at a blank map while 12 more load.
        if (!_firstFrameShown && validFrames.length > 0 && productMode === 'eir') {
            _firstFrameShown = true;
            showFrame(validFrames[validFrames.length - 1]);
            // First frame visible — start loading secondary data
            _triggerDeferredLoads();
            // Switch loader text to indicate remaining frames loading in background
            showLoadingProgress(true, pct);
        } else {
            showLoadingProgress(true, pct);
        }

        if (framesLoaded >= total) {
            framesReady = true;
            // Only update UI if we're currently in EIR mode (GeoColor has its own handler)
            if (productMode === 'eir') {
                showLoadingProgress(false);
                // Show the latest VALID frame now that all tiles are cached
                if (validFrames.length > 0) {
                    showFrame(validFrames[validFrames.length - 1]);
                } else {
                    showFrame(animFrameTimes.length - 1);
                }
                // Update slider max to reflect valid frame count
                var slider = document.getElementById('ir-anim-slider');
                if (slider && validFrames.length > 0) {
                    slider.max = validFrames.length - 1;
                    slider.value = validFrames.length - 1;
                }
                // Enable animation controls
                var playBtn = document.getElementById('ir-anim-play');
                if (playBtn) playBtn.disabled = false;
                updateAnimCounter();
            }
            console.log('[RT Monitor] All ' + total + ' IR frames pre-loaded (' + detailSatName + '), ' + validFrames.length + ' valid');
            // Pre-fetch raw Tb in background so colormap switch is instant
            // when user selects a custom colormap. Do NOT auto-apply — keep
            // GIBS tiles as the default display.
            _fetchRawTbIncremental(currentStormId, true, function () {
                if (rawTbFrames.length > 0) {
                    console.log('[RT Monitor] Raw Tb pre-fetched (' + rawTbFrames.length + ' frames, ready for colormap switch)');
                }
            });
        }
    }

    /** Load secondary data (models, WeatherLab, ASCAT, intensity chart).
     *  Deferred until the first IR frame is visible so the satellite
     *  imagery gets full bandwidth priority. */
    function _triggerDeferredLoads() {
        if (_deferredLoadsStarted) return;
        _deferredLoadsStarted = true;
        var storm = _deferredStormRef;
        if (!storm) return;

        _rtLoadModelForecasts(storm);
        _rtLoadWeatherlab(storm);
        _rtLoadDmEnsemble(storm);
        _rtLoadAscatPasses(storm);
        _rtLoadStormMwPasses(storm);
        _rtLoadRadarSites(storm);

        // Intensity chart: check cache first
        var atcfId = storm.atcf_id;
        var cached = _panelCache[atcfId];
        function _handleMeta(meta) {
            renderIntensityChart(meta);
            if (meta.has_recon) {
                document.getElementById('ir-recon-section').style.display = 'block';
                document.getElementById('ir-recon-info').innerHTML =
                    '<span style="color:#34d399;">\u25CF Active reconnaissance</span><br>' +
                    '<a href="explorer.html?tab=realtime">\u2192 Open in Real-Time TDR</a>';
            } else {
                document.getElementById('ir-recon-section').style.display = 'none';
            }
        }
        if (cached && cached.meta && (Date.now() - cached.cachedAt) < PANEL_CACHE_TTL_MS) {
            _handleMeta(cached.meta);
        } else {
            fetchStormMetadata(atcfId, function (err, meta) {
                if (!err && meta) {
                    if (!_panelCache[atcfId]) _panelCache[atcfId] = { cachedAt: Date.now() };
                    _panelCache[atcfId].meta = meta;
                    _handleMeta(meta);
                }
            });
        }
        // Raw Tb pre-fetch starts when ALL GIBS tiles finish loading
        // (see onFrameLayerLoaded). Panel requests get a natural head
        // start since they fire on the first tile, not the last.
    }

    /** Fallback: load GIBS tile layers for animation (used when image overlay fails) */
    function _initDetailMapGIBS(storm, satLayerName) {
        if (!detailMap) return;

        var endTime;
        var gibsTimeVerified = false;
        if (latestGIBSTimes && latestGIBSTimes[detailSatName]) {
            endTime = new Date(latestGIBSTimes[detailSatName]);
            gibsTimeVerified = true;
        } else {
            endTime = new Date();
        }
        animFrameTimes = buildFrameTimes(endTime, DEFAULT_LOOKBACK_HOURS, gibsTimeVerified);
        animIndex = animFrameTimes.length - 1;

        var FRAME_BATCH_SIZE = 3;
        var totalFrames = animFrameTimes.length;
        var loadOrder = [];
        for (var k = totalFrames - 1; k >= 0; k--) loadOrder.push(k);

        for (var i = 0; i < totalFrames; i++) {
            var lyr = createGIBSLayer(satLayerName, animFrameTimes[i], 0);
            frameHasError.push(false);
            animFrameLayers.push(lyr);
        }

        var _batchAddedToMap = {};
        var _batchNextIdx = 0;

        function _addNextBatch() {
            var added = 0;
            while (_batchNextIdx < loadOrder.length && added < FRAME_BATCH_SIZE) {
                var fi = loadOrder[_batchNextIdx];
                _batchNextIdx++;
                if (_batchAddedToMap[fi]) continue;
                _batchAddedToMap[fi] = true;
                animFrameLayers[fi].addTo(detailMap);
                (function (idx) {
                    animFrameLayers[idx].on('tileerror', function () {
                        frameHasError[idx] = true;
                        onFrameLayerLoaded(idx);
                        _addNextBatch();
                    });
                    animFrameLayers[idx].on('load', function () {
                        onFrameLayerLoaded(idx);
                        _addNextBatch();
                    });
                })(fi);
                added++;
            }
        }
        _addNextBatch();

        var slider = document.getElementById('ir-anim-slider');
        if (slider) { slider.max = animFrameTimes.length - 1; slider.value = animIndex; }
        updateAnimCounter();
        updateFrameOverlay();

        console.log('[RT Monitor] GIBS fallback: loading ' + totalFrames + ' tile layers');
    }

    /** Initialize the detail mini-map for a storm */
    function initDetailMap(storm) {
        var container = document.getElementById('ir-image-container');

        // Destroy old mini-map if exists
        cleanupFrameLayers();
        if (detailMap) {
            detailMap.remove();
            detailMap = null;
        }

        // Hide the old canvas, ensure map div exists
        var canvas = document.getElementById('ir-canvas');
        if (canvas) canvas.style.display = 'none';

        var mapDiv = document.getElementById('ir-detail-map');
        if (!mapDiv) {
            mapDiv = document.createElement('div');
            mapDiv.id = 'ir-detail-map';
            mapDiv.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;z-index:1;';
            container.appendChild(mapDiv);
        }
        mapDiv.style.display = 'block';

        // Create mini-map centered on storm
        // Allow up to zoom 7 (GeoColor supports Level7); IR tiles still capped at Level6
        detailMap = L.map(mapDiv, {
            center: [storm.lat, storm.lon],
            zoom: 5,
            minZoom: 3,
            maxZoom: GIBS_VIS_MAX_ZOOM,
            zoomControl: true,
            attributionControl: false
        });

        // Dark basemap
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19
        }).addTo(detailMap);

        // Store storm position for solar elevation calculations (GeoColor day/night)
        detailStormLat = storm.lat;
        detailStormLon = storm.lon;

        // Pick the single best satellite for this storm's longitude
        detailSatName = bestSatelliteForLon(storm.lon);
        var satLayerName = GIBS_IR_LAYERS[detailSatName];

        // Reset animation state
        framesLoaded = 0;
        _frameLoadedOnce = {};
        _firstFrameShown = false;
        _rawTbPrefetchStarted = false;
        _deferredLoadsStarted = false;
        _deferredStormRef = storm;
        framesReady = false;
        animFrameLayers = [];
        validFrames = [];
        frameHasError = [];

        // Disable play button until frames load
        var playBtn = document.getElementById('ir-anim-play');
        if (playBtn) playBtn.disabled = true;

        // Show loading progress
        showLoadingProgress(true, 0);

        // ── GIBS tiles (immediate) ───────────────────────────
        // Load GIBS tiles from NASA's CDN — fast, reliable, no
        // backend dependency. User sees imagery within 3-5 seconds.
        _initDetailMapGIBS(storm, satLayerName);

        // Raw Tb pre-fetch starts inside _triggerDeferredLoads() with a
        // 3-second delay, giving panel requests (models, WeatherLab, etc.)
        // a head start on the backend before the heavy Tb fetches begin.

        // Coastline overlay — Natural Earth 50m black outlines (matches global archive)
        detailMap.createPane('coastlinePane');
        detailMap.getPane('coastlinePane').style.zIndex = 450;
        detailMap.getPane('coastlinePane').style.pointerEvents = 'none';
        _loadCoastlineOverlay(detailMap);

        // ASCAT wind barb pane — above tiles, below coastlines
        detailMap.createPane('ascatPane');
        detailMap.getPane('ascatPane').style.zIndex = 440;
        detailMap.getPane('ascatPane').style.pointerEvents = 'none';

        // 88D NEXRAD radar pane — above ASCAT, below coastlines
        detailMap.createPane('radarPane');
        detailMap.getPane('radarPane').style.zIndex = 445;
        detailMap.getPane('radarPane').style.pointerEvents = 'none';

        // Labels on top (in overlay pane so above IR tiles)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19, pane: 'overlayPane'
        }).addTo(detailMap);

        // Storm center marker
        var cat = storm.category || windToCategory(storm.vmax_kt);
        var color = SS_COLORS[cat] || SS_COLORS.TD;
        L.circleMarker([storm.lat, storm.lon], {
            radius: 8, color: color, fillColor: color,
            fillOpacity: 0.7, weight: 2
        }).addTo(detailMap);

        // Fetch and draw past track on detail map
        detailTrackLayers = [];
        var stormCopy = storm;
        fetchStormMetadata(storm.atcf_id, function (metaErr, meta) {
            if (!metaErr && meta && meta.intensity_history && meta.intensity_history.length >= 2) {
                drawTrackOnMap(detailMap, meta.intensity_history, stormCopy, detailTrackLayers);
            }
        });

        // Show IR Tb colorbar legend
        var tbLeg = document.getElementById('ir-tb-legend');
        if (tbLeg) tbLeg.style.display = 'block';

        // Force map resize after layout settles
        setTimeout(function () { detailMap.invalidateSize(); }, 100);

        // Safety timeout: if GIBS tiles haven't loaded within 30s, start anyway
        setTimeout(function () {
            if (!framesReady && animFrameLayers.length > 0) {
                console.warn('[RT Monitor] Frame preload timeout — enabling animation with ' + framesLoaded + '/' + animFrameTimes.length + ' frames (' + validFrames.length + ' valid)');
                framesReady = true;
                if (productMode === 'eir') {
                    showLoadingProgress(false);
                }
                var playBtn = document.getElementById('ir-anim-play');
                if (playBtn && productMode === 'eir') playBtn.disabled = false;
                var slider = document.getElementById('ir-anim-slider');
                if (productMode === 'eir') {
                    if (slider && validFrames.length > 0) {
                        slider.max = validFrames.length - 1;
                        slider.value = validFrames.length - 1;
                        showFrame(validFrames[validFrames.length - 1]);
                    } else {
                        showFrame(animFrameTimes.length - 1);
                    }
                    updateAnimCounter();
                }
                _triggerDeferredLoads();
            }
        }, 30000);

        _ga('ir_detail_map_init', {
            atcf_id: storm.atcf_id,
            satellite: detailSatName,
            frames: animFrameTimes.length
        });
    }

    /** Fetch storm metadata (intensity history, etc.) */
    function fetchStormMetadata(atcfId, callback) {
        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) + '/metadata';

        fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                callback(null, data);
            })
            .catch(function (err) {
                console.warn('[RT Monitor] Metadata fetch failed:', err.message);
                callback(err);
            });
    }

    // ═══════════════════════════════════════════════════════════
    //  STORM DETAIL VIEW
    // ═══════════════════════════════════════════════════════════

    /** Open the storm detail view */
    function openStormDetail(atcfId) {
        currentStormId = atcfId;

        // Clean up model overlay from previous storm
        _rtRemoveModelOverlay();

        // Stop global animation if running (frames stay in memory for return)
        stopGlobalAnimation();

        // Reset product state for new storm
        productMode = 'eir';
        cleanupGeocolorFrameLayers();
        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
        if (geoBtn) geoBtn.classList.remove('ir-product-active');

        // Find storm in current data
        var storm = null;
        for (var i = 0; i < stormData.length; i++) {
            if (stormData[i].atcf_id === atcfId) {
                storm = stormData[i];
                break;
            }
        }

        if (!storm) {
            console.warn('[RT Monitor] Storm not found:', atcfId);
            return;
        }

        // Update URL hash for deep linking
        if (window.history && window.history.replaceState) {
            window.history.replaceState(null, '', 'realtime_ir.html#' + atcfId);
        }

        // Hide map view, show detail
        document.getElementById('ir-main').style.display = 'none';
        document.getElementById('ir-legend').style.display = 'none';
        var detailEl = document.getElementById('ir-detail');
        detailEl.style.display = 'block';

        // Populate header
        var cat = storm.category || windToCategory(storm.vmax_kt);
        var color = SS_COLORS[cat] || SS_COLORS.TD;
        document.getElementById('ir-detail-name').textContent = storm.name || 'UNNAMED';
        document.getElementById('ir-detail-id').textContent = storm.atcf_id;
        var catEl = document.getElementById('ir-detail-cat');
        catEl.textContent = categoryShort(cat) + (storm.vmax_kt != null ? ' \u00B7 ' + storm.vmax_kt + ' kt' : '');
        catEl.style.background = color;

        // Populate info grid
        document.getElementById('ir-info-basin').textContent = storm.basin || '\u2014';
        document.getElementById('ir-info-position').textContent = fmtLatLon(storm.lat, storm.lon);
        document.getElementById('ir-info-motion').textContent =
            storm.motion_deg != null ? storm.motion_deg + '\u00B0 at ' + (storm.motion_kt || '\u2014') + ' kt' : '\u2014';
        document.getElementById('ir-info-mslp').textContent =
            storm.mslp_hpa != null ? storm.mslp_hpa + ' hPa' : '\u2014';
        document.getElementById('ir-info-vmax').textContent =
            storm.vmax_kt != null ? storm.vmax_kt + ' kt (' + categoryShort(cat) + ')' : '\u2014';
        document.getElementById('ir-info-lastfix').textContent = fmtUTC(storm.last_fix_utc);

        // Shear from GFS analysis (lazy: fires after the IR mini-map loads)
        var shearEl = document.getElementById('ir-info-shear');
        if (shearEl) shearEl.innerHTML = '<span class="skeleton-pulse skeleton-text" style="width:80px;display:inline-block;">&nbsp;</span>';
        loadStormShear(atcfId);

        // Official forecast link
        var officialSection = document.getElementById('ir-official-section');
        var officialLink = document.getElementById('ir-official-link');
        var officialUrl = getOfficialForecastUrl(storm);
        if (officialUrl) {
            officialLink.href = officialUrl;
            officialSection.style.display = 'block';
        } else {
            officialSection.style.display = 'none';
        }

        // Show skeleton placeholders while data loads
        var chartEl = document.getElementById('ir-intensity-chart');
        if (chartEl) {
            chartEl.innerHTML = '';
            chartEl.className = 'ir-intensity-chart skeleton-pulse skeleton-chart';
        }
        var modelsStatus = document.getElementById('rt-models-status');
        if (modelsStatus) modelsStatus.innerHTML = '<span class="skeleton-pulse skeleton-text"></span>';
        var modelsSection = document.getElementById('rt-models-section');
        if (modelsSection) modelsSection.style.display = '';
        var ascatStatus = document.getElementById('rt-ascat-status');
        if (ascatStatus) ascatStatus.innerHTML = '<span class="skeleton-pulse skeleton-text"></span>';
        var ascatSection = document.getElementById('rt-ascat-section');
        if (ascatSection) ascatSection.style.display = '';

        // Initialize GIBS-based IR mini-map
        stopAnimation();
        animFrameTimes = [];
        animIndex = 0;
        initDetailMap(storm);

        // Secondary data (models, WeatherLab, ASCAT, intensity chart) is
        // deferred until the first IR frame is visible — see _triggerDeferredLoads().
        // This gives the satellite imagery full bandwidth priority.

        _ga('ir_open_detail', { atcf_id: atcfId, name: storm.name, category: cat });
    }

    // 16-point compass abbreviation. 0° → N, 90° → E, 180° → S, 270° → W.
    function _compassDir(deg) {
        if (deg == null || !isFinite(deg)) return '';
        var dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                    'S','SSW','SW','WSW','W','WNW','NW','NNW'];
        var idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
        return dirs[idx];
    }

    // Per-storm cache of the full /shear response (includes the new
    // env-profile fields). Keyed by ATCF ID; reset on detail-view open.
    var _rtEnvCache = {};

    /**
     * Fetch GFS-derived shear + env profile for the active storm.
     * Paints the Storm Info "Shear" row immediately; profile data is
     * cached for the Env Profile reveal (Skew-T + shear-vs-pressure).
     * Quiet on failure — the row falls back to "—".
     */
    function loadStormShear(atcfId) {
        var el = document.getElementById('ir-info-shear');
        if (!el) return;
        fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) + '/shear')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                if (!j || currentStormId !== atcfId) return;
                _rtEnvCache[atcfId] = j;
                var dir = _compassDir(j.heading_deg);
                el.textContent = j.magnitude_kt.toFixed(0) + ' kt @ ' +
                    Math.round(j.heading_deg) + '° (' + dir + ')';
                el.title = 'GFS 0.25° analysis ' + (j.gfs_cycle_utc || '') + '\n' +
                    '850–200 hPa shear, 200–800 km annulus\n' +
                    'u200/v200: ' + j.u200_ms + '/' + j.v200_ms + ' m/s\n' +
                    'u850/v850: ' + j.u850_ms + '/' + j.v850_ms + ' m/s\n' +
                    'n grid points: ' + j.n_grid_points;
                // If the user already had Env Profile open from a prior
                // storm, re-render with the new data so it stays in sync.
                var panel = document.getElementById('rt-env-panel');
                if (panel && panel.style.display !== 'none') {
                    _rtRenderEnvProfile(j);
                }
            })
            .catch(function () {
                if (currentStormId === atcfId) {
                    el.textContent = '—';
                    el.title = 'Shear unavailable';
                }
            });
    }

    /**
     * Render the env Skew-T + shear-vs-pressure plot for the
     * cached /shear response of the active storm.
     */
    function _rtRenderEnvProfile(payload) {
        if (!payload || !payload.profile) return;
        var prof = payload.profile;
        if (!prof.plev_hpa || !prof.plev_hpa.length) return;

        // Skew-T: pressure (hPa), T (K), q (kg/kg), u/v (m/s).
        // showParcel:false because this is an *environmental* annular
        // profile, not a sounding — local-buoyancy parcel theory does
        // not apply to area-averaged TC environments.
        if (typeof renderSkewT === 'function') {
            renderSkewT({
                plev: prof.plev_hpa,
                t: prof.t_k,
                q: prof.q_kgkg,
                u: prof.u_ms,
                v: prof.v_ms,
                showParcel: false,
            }, 'rt-env-skewt');
        }

        // Shear-vs-pressure: take vector difference of u/v at each level
        // RELATIVE TO THE SURFACE (1000 hPa) so 0 → no shear vs the
        // boundary layer. Plot magnitude vs pressure on a log-y axis.
        var i0 = prof.plev_hpa.indexOf(1000);
        if (i0 < 0) i0 = 0;  // fall back to highest-pressure level
        var u0 = prof.u_ms[i0], v0 = prof.v_ms[i0];
        var shearMagKt = [];
        for (var i = 0; i < prof.plev_hpa.length; i++) {
            var du = prof.u_ms[i] - u0;
            var dv = prof.v_ms[i] - v0;
            var mag = Math.sqrt(du * du + dv * dv) * 1.94384;
            shearMagKt.push(mag);
        }

        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var axisCol = isDark ? '#8b9ec2' : '#374151';
        var lineCol = isDark ? '#60a5fa' : '#1d4ed8';
        var gridCol = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,22,35,0.08)';

        Plotly.newPlot('rt-env-shear-prof', [{
            x: shearMagKt,
            y: prof.plev_hpa,
            type: 'scatter',
            mode: 'lines+markers',
            name: 'Shear vs sfc',
            line: { color: lineCol, width: 2 },
            marker: { color: lineCol, size: 5 },
            hovertemplate: '%{x:.1f} kt @ %{y} hPa<extra></extra>',
        }], {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            margin: { l: 38, r: 8, t: 18, b: 32 },
            font: { family: 'DM Sans, sans-serif', color: axisCol, size: 9 },
            title: { text: '|shear| vs sfc', font: { size: 9, color: axisCol }, x: 0.5, y: 0.98 },
            xaxis: {
                title: { text: 'kt', font: { size: 8, color: axisCol } },
                color: axisCol, tickfont: { size: 8 },
                gridcolor: gridCol, zeroline: false,
            },
            yaxis: {
                title: { text: 'hPa', font: { size: 8, color: axisCol } },
                color: axisCol, tickfont: { size: 8 },
                gridcolor: gridCol, zeroline: false,
                type: 'log', autorange: 'reversed',
                tickvals: [100, 150, 200, 300, 500, 700, 1000],
            },
            showlegend: false,
        }, { responsive: true, displayModeBar: false });
    }

    window.toggleEnvProfile = function () {
        var btn = document.getElementById('rt-env-toggle-btn');
        var panel = document.getElementById('rt-env-panel');
        var status = document.getElementById('rt-env-status');
        if (!panel || !btn) return;
        var open = panel.style.display === 'none';
        if (!open) {
            panel.style.display = 'none';
            btn.classList.remove('active');
            return;
        }
        // Open. Show the panel and try to render from cache; if the
        // /shear request is still in flight, the loadStormShear callback
        // will re-render once it lands.
        panel.style.display = 'block';
        btn.classList.add('active');
        var cached = _rtEnvCache[currentStormId];
        if (cached) {
            if (status) status.textContent = '';
            _rtRenderEnvProfile(cached);
        } else if (status) {
            status.textContent = 'Loading…';
        }
    };

    /**
     * Refresh the detail view header with latest storm data from a poll.
     * Handles name changes (e.g. "Four" → "Sinlaku"), position updates,
     * and intensity changes while the detail view is open.
     */
    function _refreshDetailHeader(storms) {
        if (!currentStormId) return;
        var storm = null;
        for (var i = 0; i < storms.length; i++) {
            if (storms[i].atcf_id === currentStormId) {
                storm = storms[i];
                break;
            }
        }
        if (!storm) return;

        var cat = storm.category || windToCategory(storm.vmax_kt);
        var color = SS_COLORS[cat] || SS_COLORS.TD;

        var nameEl = document.getElementById('ir-detail-name');
        if (nameEl) nameEl.textContent = storm.name || 'UNNAMED';

        var catEl = document.getElementById('ir-detail-cat');
        if (catEl) {
            catEl.textContent = categoryShort(cat) + (storm.vmax_kt != null ? ' \u00B7 ' + storm.vmax_kt + ' kt' : '');
            catEl.style.background = color;
        }

        var posEl = document.getElementById('ir-info-position');
        if (posEl) posEl.textContent = fmtLatLon(storm.lat, storm.lon);

        var mslpEl = document.getElementById('ir-info-mslp');
        if (mslpEl) mslpEl.textContent = storm.mslp_hpa != null ? storm.mslp_hpa + ' hPa' : '\u2014';

        var vmaxEl = document.getElementById('ir-info-vmax');
        if (vmaxEl) vmaxEl.textContent = storm.vmax_kt != null ? storm.vmax_kt + ' kt (' + categoryShort(cat) + ')' : '\u2014';

        var fixEl = document.getElementById('ir-info-lastfix');
        if (fixEl) fixEl.textContent = fmtUTC(storm.last_fix_utc);

        var motionEl = document.getElementById('ir-info-motion');
        if (motionEl) motionEl.textContent =
            storm.motion_deg != null ? storm.motion_deg + '\u00B0 at ' + (storm.motion_kt || '\u2014') + ' kt' : '\u2014';
    }

    /** Close the detail view and return to the map */
    function closeStormDetail() {
        currentStormId = null;
        stopAnimation();

        // Clean up model overlay
        _rtRemoveModelOverlay();
        _rtRemoveAscatOverlay();
        _rtRemoveRadarOverlay();

        // Reset product state
        cleanupGeocolorFrameLayers();
        rawTbFrames = [];
        productMode = 'eir';

        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
        if (geoBtn) geoBtn.classList.remove('ir-product-active');
        var tbLegend = document.getElementById('ir-tb-legend');
        if (tbLegend) tbLegend.style.display = 'none';

        // Clean up pre-loaded frame layers
        cleanupFrameLayers();

        // Clean up detail mini-map
        if (detailMap) {
            detailMap.remove();
            detailMap = null;
        }
        var detailMapDiv = document.getElementById('ir-detail-map');
        if (detailMapDiv) detailMapDiv.style.display = 'none';

        // Update URL
        if (window.history && window.history.replaceState) {
            window.history.replaceState(null, '', 'realtime_ir.html');
        }

        // Hide detail, show map
        document.getElementById('ir-detail').style.display = 'none';
        document.getElementById('ir-main').style.display = 'block';
        // Restore legend visibility to whatever the toggle button reflects
        // (off by default; on only if the user explicitly opted in via the
        // ✦ Legend pill). Force-showing on detail-close used to cover the
        // env-overlay menu when no storms were active.
        var _legBtn = document.getElementById('ir-legend-toggle');
        var _legEl  = document.getElementById('ir-legend');
        if (_legEl) {
            _legEl.style.display = (_legBtn && _legBtn.classList.contains('active'))
                ? '' : 'none';
        }

        // Resize map (in case container changed)
        if (map) map.invalidateSize();

        _ga('ir_close_detail');
    }

    // ═══════════════════════════════════════════════════════════
    //  IR ANIMATION (GIBS time-stepping)
    // ═══════════════════════════════════════════════════════════

    /** Update the overlay info with the current frame time */
    function updateFrameOverlay() {
        if (animFrameTimes.length === 0) return;
        _cacheAnimEls();
        var timeStr = animFrameTimes[animIndex];
        if (_elFrameTime) _elFrameTime.textContent = fmtUTC(timeStr);
        if (_elSatLabel) _elSatLabel.textContent = detailSatName || 'GIBS IR';
    }

    /** Show a specific frame by toggling opacity (instant — no tile fetching) */
    function showFrame(idx) {
        if (idx < 0 || idx >= animFrameLayers.length || !detailMap) return;

        // Hide the current frame
        if (animIndex >= 0 && animIndex < animFrameLayers.length) {
            animFrameLayers[animIndex].setOpacity(0);
        }

        // Show the new frame
        animIndex = idx;
        animFrameLayers[idx].setOpacity(0.85);
        updateFrameOverlay();

        // Sync model overlay to new frame time
        if (_rtModelVisible && _rtModelAutoSync && _rtModelData) {
            _rtSyncModelCycleToIR();
        }

        // Sync radar overlay scan to new frame time
        _rtUpdateRadarForFrame();
    }

    /** Find the position of animIndex within validFrames (or -1) */
    /** Get the active set of valid frames and frame layers for the current product mode */
    function activeFrameState() {
        if (productMode === 'geocolor') {
            return {
                valid: geocolorValidFrames,
                layers: geocolorFrameLayers,
                times: geocolorFrameTimes,
                ready: geocolorFramesReady,
                showFn: showGeocolorFrame
            };
        }
        return {
            valid: validFrames,
            layers: animFrameLayers,
            times: animFrameTimes,
            ready: framesReady,
            showFn: showFrame
        };
    }

    /** Update the frame counter text (shows position in valid frames) */
    function updateAnimCounter() {
        _cacheAnimEls();
        if (!_elAnimCounter) return;
        var state = activeFrameState();
        var pos = activeValidFramePos();
        if (state.valid.length > 0 && pos >= 0) {
            _elAnimCounter.textContent = (pos + 1) + ' / ' + state.valid.length;
        } else {
            _elAnimCounter.textContent = (animIndex + 1) + ' / ' + state.times.length;
        }
    }

    /** Find position of animIndex within the active valid frames array */
    function activeValidFramePos() {
        var state = activeFrameState();
        for (var i = 0; i < state.valid.length; i++) {
            if (state.valid[i] === animIndex) return i;
        }
        return -1;
    }

    /** Step to next valid frame */
    function nextFrame() {
        var state = activeFrameState();
        if (!state.ready) return;
        if (state.valid.length === 0) return;
        var pos = activeValidFramePos();
        var nextPos = (pos + 1) % state.valid.length;
        state.showFn(state.valid[nextPos]);
        _cacheAnimEls();
        if (_elAnimSlider) _elAnimSlider.value = nextPos;
        updateAnimCounter();
    }

    /** Step to previous valid frame */
    function prevFrame() {
        var state = activeFrameState();
        if (!state.ready) return;
        if (state.valid.length === 0) return;
        var pos = activeValidFramePos();
        var prevPos = (pos - 1 + state.valid.length) % state.valid.length;
        state.showFn(state.valid[prevPos]);
        _cacheAnimEls();
        if (_elAnimSlider) _elAnimSlider.value = prevPos;
        updateAnimCounter();
    }

    /** Toggle play/pause */
    function togglePlay() {
        if (animPlaying) {
            stopAnimation();
        } else {
            startAnimation();
        }
    }

    /** rAF tick for detail animation */
    function _animTick(ts) {
        if (!animPlaying) return;
        if (ts - animLastTick >= animIntervalMs) {
            animLastTick = ts;
            nextFrame();
        }
        animTimer = requestAnimationFrame(_animTick);
    }

    /** Start animation loop */
    function startAnimation() {
        var state = activeFrameState();
        if (state.times.length < 2 || !state.ready) return;
        animPlaying = true;
        _ga('ir_animation_play');
        _cacheAnimEls();
        if (_elAnimPlay) {
            _elAnimPlay.innerHTML = '&#9646;&#9646;'; // pause icon
            _elAnimPlay.title = 'Pause';
        }

        // rAF-driven loop — ~2 fps via animIntervalMs (500ms)
        animLastTick = 0;
        animTimer = requestAnimationFrame(_animTick);
    }

    /** Stop animation loop */
    function stopAnimation() {
        animPlaying = false;
        if (animTimer) cancelAnimationFrame(animTimer);
        animTimer = null;
        _cacheAnimEls();
        if (_elAnimPlay) {
            _elAnimPlay.innerHTML = '&#9654;'; // play icon
            _elAnimPlay.title = 'Play';
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  INTENSITY CHART (Plotly)
    // ═══════════════════════════════════════════════════════════

    /** Render the intensity timeline chart */
    function renderIntensityChart(meta) {
        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || typeof Plotly === 'undefined') return;
        chartEl.className = 'ir-intensity-chart';  // remove skeleton

        var history = meta.intensity_history || [];
        if (history.length === 0) {
            chartEl.innerHTML = '<div style="text-align:center;color:#64748b;padding:40px 0;font-size:0.8rem;">No intensity data available</div>';
            return;
        }

        var times = [];
        var winds = [];
        var colors = [];
        for (var i = 0; i < history.length; i++) {
            times.push(history[i].time);
            winds.push(history[i].vmax_kt);
            var cat = windToCategory(history[i].vmax_kt);
            colors.push(SS_COLORS[cat]);
        }

        var trace = {
            x: times,
            y: winds,
            type: 'scatter',
            mode: 'lines+markers',
            name: 'Best Track',
            showlegend: false,
            line: { color: '#2e7dff', width: 2 },
            marker: { color: colors, size: 5 }
        };

        var layout = {
            margin: { t: 8, r: 10, b: 36, l: 42 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            xaxis: {
                gridcolor: 'rgba(255,255,255,0.04)',
                tickfont: { size: 9, color: '#5b6573', family: 'JetBrains Mono' },
                tickformat: '%m/%d %Hz'
            },
            yaxis: {
                title: { text: 'Vmax (kt)', font: { size: 10, color: '#5b6573' } },
                gridcolor: 'rgba(255,255,255,0.04)',
                tickfont: { size: 9, color: '#5b6573', family: 'JetBrains Mono' }
            },
            // SS category shading bands
            shapes: [
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 34,  y1: 64,  fillcolor: 'rgba(52,211,153,0.06)', line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 64,  y1: 83,  fillcolor: 'rgba(251,191,36,0.06)',  line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 83,  y1: 96,  fillcolor: 'rgba(251,146,60,0.06)',  line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 96,  y1: 113, fillcolor: 'rgba(248,113,113,0.06)', line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 113, y1: 137, fillcolor: 'rgba(239,68,68,0.06)',   line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 137, y1: 200, fillcolor: 'rgba(220,38,38,0.06)',   line: { width: 0 } }
            ]
        };

        var config = {
            displayModeBar: false,
            responsive: true,
            staticPlot: true  // disable drag/zoom — small status chart, not interactive
        };

        Plotly.newPlot(chartEl, [trace], layout, config);
    }

    // ═══════════════════════════════════════════════════════════
    //  PRODUCT MODE SWITCHING
    // ═══════════════════════════════════════════════════════════

    /** Switch between product modes: 'eir' or 'geocolor' */
    function setProductMode(mode) {
        var prevMode = productMode;
        productMode = mode;

        // Update toggle button active states
        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        if (eirBtn) eirBtn.classList.toggle('ir-product-active', mode === 'eir');
        if (geoBtn) geoBtn.classList.toggle('ir-product-active', mode === 'geocolor');

        // Show/hide legends
        var tbLeg = document.getElementById('ir-tb-legend');
        if (tbLeg) tbLeg.style.display = (mode === 'eir') ? 'block' : 'none';

        // --- Deactivate previous mode ---
        if (prevMode === 'eir') {
            hideAllAnimFrames();
            stopAnimation();
        } else if (prevMode === 'geocolor') {
            hideAllGeocolorFrames();
            stopAnimation();
        }

        // --- Activate new mode ---
        if (mode === 'eir') {
            // Restore IR slider state
            var slider = document.getElementById('ir-anim-slider');
            if (slider && validFrames.length > 0) {
                slider.max = validFrames.length - 1;
                var pos = -1;
                for (var vi = 0; vi < validFrames.length; vi++) {
                    if (validFrames[vi] === animIndex) { pos = vi; break; }
                }
                if (pos < 0) pos = validFrames.length - 1;
                slider.value = pos;
            }
            if (animFrameLayers.length > 0 && framesReady) {
                showFrame(animIndex);
            }
            var playBtn = document.getElementById('ir-anim-play');
            if (playBtn) playBtn.disabled = !framesReady;
            updateFrameOverlay();
            updateAnimCounter();
        } else if (mode === 'geocolor') {
            loadGeocolorFrames();
        }
    }

    /** Hide all IR animation frame layers */
    function hideAllAnimFrames() {
        for (var i = 0; i < animFrameLayers.length; i++) {
            animFrameLayers[i].setOpacity(0);
        }
    }

    // ── Raw Tb pre-fetch cache (per-storm, keyed by ATCF ID) ──
    // Each entry also stores the storm lat/lon at cache time so we can
    // invalidate when the storm moves significantly (> 0.3 deg ≈ 33 km).
    var _rawTbCache = {};  // { atcfId: { rawTbFrames: [...], cachedAt: ms, lat: n, lon: n } }
    var RAW_TB_CACHE_TTL_MS = POLL_INTERVAL_MS;  // invalidate after one poll cycle
    var RAW_TB_CACHE_MOVE_DEG = 0.3;  // invalidate if storm moved more than this

    function _stormPositionForId(stormId) {
        for (var i = 0; i < stormData.length; i++) {
            if (stormData[i].atcf_id === stormId) return stormData[i];
        }
        return null;
    }

    function _rawTbCacheValid(stormId) {
        var cached = _rawTbCache[stormId];
        if (!cached || !cached.rawTbFrames || cached.rawTbFrames.length === 0) return false;
        if ((Date.now() - cached.cachedAt) >= RAW_TB_CACHE_TTL_MS) return false;
        // Invalidate if storm has moved significantly since cache time
        if (cached.lat != null) {
            var s = _stormPositionForId(stormId);
            if (s && (Math.abs(s.lat - cached.lat) > RAW_TB_CACHE_MOVE_DEG ||
                      Math.abs(s.lon - cached.lon) > RAW_TB_CACHE_MOVE_DEG)) {
                return false;
            }
        }
        return true;
    }

    // Expose cached raw Tb frames for the satellite viewer to reuse
    window.getRtRawTbFrames = function (stormId) {
        return _rawTbCacheValid(stormId) ? _rawTbCache[stormId].rawTbFrames : null;
    };

    // Callback registry: satellite viewer can register to be notified
    // when raw Tb frames become available (avoids polling + duplicate fetches).
    var _rtReadyCallbacks = {};  // { stormId: [cb, cb, ...] }
    window.onRtRawTbReady = function (stormId, cb) {
        // If already cached, fire immediately
        if (_rawTbCacheValid(stormId)) { cb(_rawTbCache[stormId].rawTbFrames); return; }
        if (!_rtReadyCallbacks[stormId]) _rtReadyCallbacks[stormId] = [];
        _rtReadyCallbacks[stormId].push(cb);
    };
    function _fireRtReadyCallbacks(stormId) {
        var cbs = _rtReadyCallbacks[stormId];
        if (!cbs || cbs.length === 0) return;
        var frames = _rawTbCache[stormId] ? _rawTbCache[stormId].rawTbFrames : null;
        if (!frames) return;
        delete _rtReadyCallbacks[stormId];
        for (var i = 0; i < cbs.length; i++) {
            try { cbs[i](frames); } catch (e) { console.warn('[RT Monitor] Ready callback error:', e); }
        }
    }

    // ── Raw Band (WV/Vis) pre-fetch cache ──
    // Structure: { "8": { stormId: { frames: [...], cachedAt, lat, lon } } }
    var _rawBandCache = {};
    var DEFAULT_PREFETCH_BAND = 8;  // WV — works day and night

    function _rawBandCacheValid(stormId, band) {
        var bandCache = _rawBandCache[band];
        if (!bandCache) return false;
        var cached = bandCache[stormId];
        if (!cached || !cached.frames || cached.frames.length === 0) return false;
        if ((Date.now() - cached.cachedAt) >= RAW_TB_CACHE_TTL_MS) return false;
        if (cached.lat != null) {
            var s = _stormPositionForId(stormId);
            if (s && (Math.abs(s.lat - cached.lat) > RAW_TB_CACHE_MOVE_DEG ||
                      Math.abs(s.lon - cached.lon) > RAW_TB_CACHE_MOVE_DEG)) {
                return false;
            }
        }
        return true;
    }

    window.getRtRawBandFrames = function (stormId, band) {
        return _rawBandCacheValid(stormId, band) ? _rawBandCache[band][stormId].frames : null;
    };

    /**
     * Pre-fetch raw Tb frames for ALL active storms on page load.
     * Fires sequentially (one storm at a time) to avoid hammering the API.
     * Cached data is used by _prefetchRawTbSilent() and satellite viewer
     * when the user clicks into a storm detail view.
     */
    var MAX_PREFETCH_STORMS = 3;  // limit background prefetch to avoid bandwidth waste

    function _prefetchAllStormsRawTb(storms) {
        if (!storms || storms.length === 0) return;
        // Skip background prefetch while user is viewing a detail (prioritize foreground).
        // Also defer briefly so deep-link handling can set currentStormId first.
        if (currentStormId) return;
        // Double-check after a microtask to catch deep-link race
        setTimeout(function () { _prefetchAllStormsRawTbInner(storms); }, 0);
    }

    function _prefetchAllStormsRawTbInner(storms) {
        if (currentStormId) return;
        // Only prefetch the strongest storms (highest vmax_kt), capped at MAX_PREFETCH_STORMS
        var sorted = storms.slice().sort(function (a, b) {
            return (b.vmax_kt || 0) - (a.vmax_kt || 0);
        });
        var queue = sorted.slice(0, MAX_PREFETCH_STORMS);
        function fetchNext() {
            if (queue.length === 0) {
                // IR prefetch done — chain band prefetch
                _prefetchAllStormsBand(storms);
                return;
            }
            // Abort if user opened a detail view while prefetch was running
            if (currentStormId) return;
            var storm = queue.shift();
            var atcfId = storm.atcf_id;
            if (!atcfId || _rawTbCacheValid(atcfId)) { fetchNext(); return; }
            _fetchRawTbIncremental(atcfId, true, function () {
                console.log('[IR Pre-fetch] ' + atcfId + ': done (' +
                    ((_rawTbCache[atcfId] || {}).rawTbFrames || []).length + ' frames)');
                fetchNext();
            });
        }
        fetchNext();
    }

    /** Pre-fetch WV band frames for top storms (runs after IR prefetch). */
    function _prefetchAllStormsBand(storms) {
        if (!storms || storms.length === 0) return;
        if (currentStormId) return;
        // Defer band prefetch if the satellite viewer is active (it has its own fetches)
        var satMain = document.getElementById('sat-main');
        if (satMain && satMain.style.display !== 'none') return;
        var band = DEFAULT_PREFETCH_BAND;
        var sorted = storms.slice().sort(function (a, b) {
            return (b.vmax_kt || 0) - (a.vmax_kt || 0);
        });
        var queue = sorted.slice(0, MAX_PREFETCH_STORMS);
        function fetchNext() {
            if (queue.length === 0) return;
            if (currentStormId) return;
            var storm = queue.shift();
            var atcfId = storm.atcf_id;
            if (!atcfId || _rawBandCacheValid(atcfId, band)) { fetchNext(); return; }
            _fetchBandIncremental(atcfId, band, true, function () {
                var c = (_rawBandCache[band] && _rawBandCache[band][atcfId]) || {};
                console.log('[Band Pre-fetch] ' + atcfId + ' band ' + band + ': done (' +
                    (c.frames || []).length + ' frames)');
                fetchNext();
            });
        }
        fetchNext();
    }

    /**
     * Fetch raw Tb frames incrementally (one at a time) using the
     * /ir-raw-frame endpoint.  Each frame is fetched individually so
     * partial results are available immediately and Cloud Run doesn't
     * time out trying to generate all 13 frames in one request.
     *
     * @param {string} stormId - ATCF ID
     * @param {boolean} silent - if true, don't update loading UI
     * @param {function} onComplete - called when all frames are loaded
     */
    // Active AbortController for the current raw Tb fetch batch —
    // aborted when the user switches storms to cancel in-flight requests.
    var _rawTbAbortController = null;

    function _fetchRawTbIncremental(stormId, silent, onComplete) {
        if (!stormId) return;

        // Use cache if available, not expired, and storm hasn't moved
        if (_rawTbCacheValid(stormId)) {
            if (stormId === currentStormId) {
                rawTbFrames = _rawTbCache[stormId].rawTbFrames;
            }
            console.log('[RT Monitor] Loaded ' + _rawTbCache[stormId].rawTbFrames.length + ' raw Tb frames from cache for ' + stormId);
            if (onComplete) onComplete();
            return;
        }

        // Abort any previous in-flight fetch batch (e.g. user switched storms)
        if (_rawTbAbortController && !silent) {
            _rawTbAbortController.abort();
        }
        var controller = new AbortController();
        if (!silent) _rawTbAbortController = controller;

        var totalFrames = 13;  // will be updated from first response
        var loadedFrames = [];
        var completed = 0;
        var failed = 0;
        var concurrency = 3;   // fetch 3 frames in parallel (reduced to avoid 429s)

        function fetchFrame(idx) {
            if (idx >= totalFrames) return;
            if (controller.signal.aborted) return;

            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/ir-raw-frame'
                + '?frame_index=' + idx
                + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG
                + '&interval_min=30';

            fetch(url, { signal: controller.signal })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (frame) {
                    if (controller.signal.aborted) return;
                    if (frame.total_frames) totalFrames = frame.total_frames;

                    loadedFrames[idx] = {
                        tb_data: decodeTbData(frame.tb_data),
                        rows: frame.tb_rows,
                        cols: frame.tb_cols,
                        bounds: frame.bounds,
                        datetime_utc: frame.datetime_utc || '',
                        satellite: frame.satellite || '',
                        tb_vmin: frame.tb_vmin || 160.0,
                        tb_vmax: frame.tb_vmax || 330.0,
                        center_fix: frame.center_fix || null
                    };
                    completed++;

                    if (!silent) {
                        showLoadingProgress(true, Math.round(100 * completed / totalFrames));
                    }
                    console.log('[RT Monitor] Raw Tb frame ' + idx + '/' + totalFrames +
                        ' (' + frame.tb_cols + 'x' + frame.tb_rows + ' px)');
                })
                .catch(function (err) {
                    if (err.name === 'AbortError') return;  // expected on storm switch
                    console.warn('[RT Monitor] Frame ' + idx + ' failed:', err.message);
                    failed++;
                    completed++;
                })
                .finally(function () {
                    if (controller.signal.aborted) return;

                    // Launch next frame beyond the initial concurrent batch
                    var nextIdx = idx + concurrency;
                    if (nextIdx < totalFrames) fetchFrame(nextIdx);

                    // All done?
                    if (completed >= totalFrames) {
                        // Compact: remove holes from failed frames
                        var result = [];
                        for (var i = 0; i < totalFrames; i++) {
                            if (loadedFrames[i]) result.push(loadedFrames[i]);
                        }
                        var pos = _stormPositionForId(stormId);
                        _rawTbCache[stormId] = {
                            rawTbFrames: result, cachedAt: Date.now(),
                            lat: pos ? pos.lat : null, lon: pos ? pos.lon : null
                        };
                        // Only update the global rawTbFrames if this is
                        // the storm currently being viewed
                        if (stormId === currentStormId) {
                            rawTbFrames = result;
                        }
                        console.log('[RT Monitor] All raw Tb frames loaded for ' +
                            stormId + ': ' + result.length + ' OK, ' + failed + ' failed');
                        _fireRtReadyCallbacks(stormId);
                        if (_rawTbAbortController === controller) _rawTbAbortController = null;
                        if (onComplete) onComplete();
                    }
                });
        }

        // Launch initial batch of concurrent fetches
        for (var i = 0; i < Math.min(concurrency, totalFrames); i++) {
            fetchFrame(i);
        }
    }

    function _prefetchRawTbSilent() {
        _fetchRawTbIncremental(currentStormId, true, null);
    }

    /**
     * Fetch band (WV/Vis) frames incrementally, mirroring _fetchRawTbIncremental.
     * Cached in _rawBandCache for reuse by the satellite viewer.
     */
    function _fetchBandIncremental(stormId, band, silent, onComplete) {
        if (!stormId) return;

        if (_rawBandCacheValid(stormId, band)) {
            console.log('[RT Monitor] Loaded band ' + band + ' from cache for ' + stormId);
            if (onComplete) onComplete();
            return;
        }

        var totalFrames = 13;
        var loadedFrames = [];
        var completed = 0;
        var failed = 0;
        var concurrency = 3;

        function fetchFrame(idx) {
            if (idx >= totalFrames) return;

            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/band-raw-frame'
                + '?band=' + band
                + '&frame_index=' + idx
                + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG
                + '&interval_min=30';

            fetch(url)
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (frame) {
                    if (frame.total_frames) totalFrames = frame.total_frames;

                    loadedFrames[idx] = {
                        tb_data: decodeTbData(frame.tb_data),
                        tb_rows: frame.tb_rows,
                        tb_cols: frame.tb_cols,
                        bounds: frame.bounds,
                        datetime_utc: frame.datetime_utc,
                        satellite: frame.satellite || '',
                        tb_vmin: frame.tb_vmin,
                        tb_vmax: frame.tb_vmax,
                        data_type: frame.data_type || 'tb'
                    };
                    completed++;
                    console.log('[RT Monitor] Band ' + band + ' frame ' + idx + '/' + totalFrames +
                        ' (' + frame.tb_cols + 'x' + frame.tb_rows + ' px)');
                })
                .catch(function (err) {
                    console.warn('[RT Monitor] Band ' + band + ' frame ' + idx + ' failed:', err.message);
                    failed++;
                    completed++;
                })
                .finally(function () {
                    var nextIdx = idx + concurrency;
                    if (nextIdx < totalFrames) fetchFrame(nextIdx);

                    if (completed >= totalFrames) {
                        var result = [];
                        for (var i = 0; i < totalFrames; i++) {
                            if (loadedFrames[i]) result.push(loadedFrames[i]);
                        }
                        if (!_rawBandCache[band]) _rawBandCache[band] = {};
                        var pos = _stormPositionForId(stormId);
                        _rawBandCache[band][stormId] = {
                            frames: result, cachedAt: Date.now(),
                            lat: pos ? pos.lat : null, lon: pos ? pos.lon : null
                        };
                        console.log('[RT Monitor] All band ' + band + ' frames loaded for ' +
                            stormId + ': ' + result.length + ' OK, ' + failed + ' failed');
                        if (onComplete) onComplete();
                    }
                });
        }

        for (var i = 0; i < Math.min(concurrency, totalFrames); i++) {
            fetchFrame(i);
        }
    }

    /** Hide all GeoColor animation frame layers */
    function hideAllGeocolorFrames() {
        for (var i = 0; i < geocolorFrameLayers.length; i++) {
            geocolorFrameLayers[i].setOpacity(0);
        }
    }

    /** Clean up GeoColor frame layers from the map */
    function cleanupGeocolorFrameLayers() {
        for (var i = 0; i < geocolorFrameLayers.length; i++) {
            if (detailMap && geocolorFrameLayers[i]) {
                detailMap.removeLayer(geocolorFrameLayers[i]);
            }
        }
        geocolorFrameLayers = [];
        geocolorFrameTimes = [];
        geocolorValidFrames = [];
        geocolorFrameHasError = [];
        geocolorFramesLoaded = 0;
        geocolorFramesReady = false;
    }

    /** Load GeoColor animation frames lazily (only when user switches to GeoColor mode).
     *  Uses same frame times as IR but with GeoColor/visible GIBS layers. */
    function loadGeocolorFrames() {
        if (!detailMap || !currentStormId) return;

        // If already loaded, just restore slider and show the current frame
        if (geocolorFramesReady && geocolorFrameLayers.length > 0) {
            var slider = document.getElementById('ir-anim-slider');
            if (slider && geocolorValidFrames.length > 0) {
                slider.max = geocolorValidFrames.length - 1;
                slider.value = geocolorValidFrames.length - 1;
            }
            var playBtn = document.getElementById('ir-anim-play');
            if (playBtn) playBtn.disabled = false;
            showGeocolorFrame(geocolorValidFrames.length > 0
                ? geocolorValidFrames[geocolorValidFrames.length - 1]
                : geocolorFrameLayers.length - 1);
            updateAnimCounter();
            return;
        }

        // If already loading, skip
        if (geocolorFrameLayers.length > 0 && !geocolorFramesReady) return;

        // Determine layer strategy
        var hasNativeGeoColor = !!GIBS_GEOCOLOR_LAYERS[detailSatName];
        var visLayerName = GIBS_GEOCOLOR_LAYERS[detailSatName] || GIBS_VIS_LAYERS[detailSatName];
        var irLayerName = GIBS_IR_LAYERS[detailSatName] || null;
        if (!visLayerName) {
            console.warn('[RT Monitor] No visible imagery available for ' + detailSatName);
            setProductMode('eir');
            return;
        }

        // Use the same frame times as IR
        geocolorFrameTimes = animFrameTimes.slice();
        geocolorFramesLoaded = 0;
        geocolorFramesReady = false;
        geocolorValidFrames = [];
        geocolorFrameHasError = [];

        // Show loading state on the GeoColor button
        var geoBtn = document.getElementById('ir-product-geocolor');
        if (geoBtn) {
            geoBtn.classList.add('ir-loading');
            geoBtn.textContent = 'Loading\u2026';
        }
        showLoadingProgress(true, 0);

        // Update satellite label — always "GeoColor" regardless of satellite
        var satLabel = document.getElementById('ir-satellite-label');
        if (satLabel) {
            satLabel.textContent = 'GeoColor \u2014 ' + detailSatName;
        }

        // Pre-create ALL GeoColor frame tile layers (hidden at opacity 0).
        // For satellites with native GeoColor (GOES): use createGIBSLayerVis.
        // For satellites without (Himawari): per-frame day/night switching —
        //   daytime → Red Visible tiles,  nighttime → Clean IR tiles (grayscale).
        for (var i = 0; i < geocolorFrameTimes.length; i++) {
            var timeStr = geocolorFrameTimes[i];
            var lyr;
            if (hasNativeGeoColor) {
                // GOES: use native GeoColor layer (handles day/night internally)
                lyr = createGIBSLayerVis(visLayerName, timeStr, 0, null);
            } else {
                // Himawari: choose visible or IR based on solar elevation
                var sunElev = solarElevation(detailStormLat, detailStormLon, new Date(timeStr));
                if (sunElev > -6) {
                    // Daytime / civil twilight: use visible tiles (Level7)
                    lyr = createGIBSLayerVis(visLayerName, timeStr, 0, null);
                } else {
                    // Nighttime: use clean IR tiles (grayscale, Level6)
                    lyr = createGIBSLayer(irLayerName, timeStr, 0);
                }
            }
            lyr.addTo(detailMap);
            geocolorFrameHasError.push(false);

            (function (layer, idx) {
                layer.on('tileerror', function () {
                    geocolorFrameHasError[idx] = true;
                });
                layer.on('load', function () {
                    onGeocolorFrameLoaded(idx);
                });
            })(lyr, i);

            geocolorFrameLayers.push(lyr);
        }

        // Safety timeout
        setTimeout(function () {
            if (!geocolorFramesReady && geocolorFrameLayers.length > 0 && productMode === 'geocolor') {
                console.warn('[RT Monitor] GeoColor preload timeout — enabling with ' + geocolorFramesLoaded + '/' + geocolorFrameTimes.length + ' frames');
                geocolorFramesReady = true;
                showLoadingProgress(false);
                if (geoBtn) {
                    geoBtn.classList.remove('ir-loading');
                    geoBtn.textContent = 'GeoColor';
                }
                var playBtn = document.getElementById('ir-anim-play');
                if (playBtn) playBtn.disabled = false;
                var slider = document.getElementById('ir-anim-slider');
                if (slider && geocolorValidFrames.length > 0) {
                    slider.max = geocolorValidFrames.length - 1;
                    slider.value = geocolorValidFrames.length - 1;
                    showGeocolorFrame(geocolorValidFrames[geocolorValidFrames.length - 1]);
                }
                updateAnimCounter();
            }
        }, 30000);
    }

    /** Called when a GeoColor frame tile layer finishes loading */
    function onGeocolorFrameLoaded(idx) {
        geocolorFramesLoaded++;
        if (!geocolorFrameHasError[idx]) {
            geocolorValidFrames.push(idx);
            geocolorValidFrames.sort(function (a, b) { return a - b; });
        }

        var total = geocolorFrameTimes.length;
        var pct = Math.round((geocolorFramesLoaded / total) * 100);
        showLoadingProgress(true, pct);

        if (geocolorFramesLoaded >= total) {
            geocolorFramesReady = true;
            showLoadingProgress(false);
            var geoBtn = document.getElementById('ir-product-geocolor');
            if (geoBtn) {
                geoBtn.classList.remove('ir-loading');
                geoBtn.textContent = 'GeoColor';
            }

            var playBtn = document.getElementById('ir-anim-play');
            if (playBtn) playBtn.disabled = false;

            // Update slider for GeoColor valid frames
            var slider = document.getElementById('ir-anim-slider');
            if (slider && geocolorValidFrames.length > 0) {
                slider.max = geocolorValidFrames.length - 1;
                slider.value = geocolorValidFrames.length - 1;
            }

            // Show last frame if still in GeoColor mode
            if (productMode === 'geocolor' && geocolorValidFrames.length > 0) {
                showGeocolorFrame(geocolorValidFrames[geocolorValidFrames.length - 1]);
            }
            updateAnimCounter();
        }
    }

    /** Show a specific GeoColor frame by toggling opacity */
    function showGeocolorFrame(idx) {
        if (idx < 0 || idx >= geocolorFrameLayers.length || !detailMap) return;

        // Hide all GeoColor frames
        for (var i = 0; i < geocolorFrameLayers.length; i++) {
            geocolorFrameLayers[i].setOpacity(0);
        }

        // Show the requested frame
        animIndex = idx;
        geocolorFrameLayers[idx].setOpacity(0.92);

        // Update overlay info
        if (geocolorFrameTimes[idx]) {
            document.getElementById('ir-frame-time').textContent = fmtUTC(geocolorFrameTimes[idx]);
        }
        document.getElementById('ir-satellite-label').textContent =
            'GeoColor \u2014 ' + detailSatName;

        // Sync model overlay to new frame time
        if (_rtModelVisible && _rtModelAutoSync && _rtModelData) {
            _rtSyncModelCycleToIR();
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  DEEP LINKING
    // ═══════════════════════════════════════════════════════════

    var deepLinkHandled = false;

    /** Check URL hash for a deep-linked storm */
    function handleDeepLink() {
        if (deepLinkHandled) return;
        var hash = window.location.hash.replace('#', '').trim();
        if (!hash) return;

        // Check if storm exists in current data
        for (var i = 0; i < stormData.length; i++) {
            if (stormData[i].atcf_id === hash) {
                deepLinkHandled = true;
                openStormDetail(hash);
                return;
            }
        }
        // Storm not in active list — could be expired; just stay on map
    }

    // ═══════════════════════════════════════════════════════════
    //  EVENT BINDING
    // ═══════════════════════════════════════════════════════════

    function bindEvents() {
        // Back button
        document.getElementById('ir-back-btn').addEventListener('click', function () {
            closeStormDetail();
        });

        // Animation controls
        document.getElementById('ir-anim-prev').addEventListener('click', function () {
            stopAnimation();
            prevFrame();
        });
        document.getElementById('ir-anim-play').addEventListener('click', togglePlay);
        document.getElementById('ir-anim-next').addEventListener('click', function () {
            stopAnimation();
            nextFrame();
        });
        document.getElementById('ir-anim-slider').addEventListener('input', function () {
            var state = activeFrameState();
            if (!state.ready) return;
            stopAnimation();
            var sliderPos = parseInt(this.value, 10);
            if (state.valid.length > 0 && sliderPos < state.valid.length) {
                state.showFn(state.valid[sliderPos]);
            }
            updateAnimCounter();
        });

        // Product toggle buttons (Enhanced IR / GeoColor / IR Vigor)
        document.getElementById('ir-product-eir').addEventListener('click', function () {
            if (productMode === 'eir') return;
            setProductMode('eir');
        });
        document.getElementById('ir-product-geocolor').addEventListener('click', function () {
            if (productMode === 'geocolor') return;
            setProductMode('geocolor');
        });
        // Browser back/forward
        window.addEventListener('popstate', function () {
            var hash = window.location.hash.replace('#', '').trim();
            if (hash && currentStormId !== hash) {
                openStormDetail(hash);
            } else if (!hash && currentStormId) {
                closeStormDetail();
            }
        });

        // Keyboard shortcuts (detail view)
        document.addEventListener('keydown', function (e) {
            if (!currentStormId) return;
            if (e.key === 'ArrowLeft')  { stopAnimation(); prevFrame(); }
            if (e.key === 'ArrowRight') { stopAnimation(); nextFrame(); }
            if (e.key === ' ')          { e.preventDefault(); togglePlay(); }
            if (e.key === 'Escape')     { closeStormDetail(); }
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════════

    /** Global entry point called from popup buttons */
    window._irOpenStorm = function (atcfId) {
        openStormDetail(atcfId);
    };

    // ═══════════════════════════════════════════════════════════
    //  BASIN ACTIVITY SIDEBAR
    // ═══════════════════════════════════════════════════════════

    window.toggleBasinSidebar = function () {
        basinSidebarVisible = !basinSidebarVisible;
        var sidebar = document.getElementById('basin-sidebar');
        var toggle = document.getElementById('basin-sidebar-toggle');
        var mapEl = document.getElementById('ir-map');

        if (basinSidebarVisible) {
            sidebar.classList.add('open');
            toggle.classList.add('active');
            mapEl.classList.add('sidebar-open');
            // Fetch if we don't have data yet
            if (!seasonSummaryData) fetchSeasonSummary();
        } else {
            sidebar.classList.remove('open');
            toggle.classList.remove('active');
            mapEl.classList.remove('sidebar-open');
        }
        // Let Leaflet recalculate after CSS transition
        setTimeout(function () { if (map) map.invalidateSize(); }, 350);
        _ga('ir_basin_sidebar_toggle', { visible: basinSidebarVisible });
    };

    function fetchSeasonSummary() {
        fetch(API_BASE + '/ir-monitor/season-summary', { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                seasonSummaryData = data;
                renderBasinSidebar();
            })
            .catch(function (err) {
                console.warn('[RT Monitor] Season summary fetch failed:', err.message || '');
                var content = document.getElementById('basin-sidebar-content');
                if (content) content.innerHTML = '<div class="basin-sidebar-loading">Unable to load season data</div>';
            });
    }

    function renderBasinSidebar() {
        if (!seasonSummaryData) return;

        var yearEl = document.getElementById('basin-sidebar-year');
        if (yearEl) yearEl.textContent = seasonSummaryData.year;

        var climoLabel = document.getElementById('basin-sidebar-climo-label');
        if (climoLabel) climoLabel.textContent = 'Climatology: ' + (seasonSummaryData.climo_period || '1991-2020');

        var content = document.getElementById('basin-sidebar-content');
        if (!content) return;

        var basins = seasonSummaryData.basins || {};
        // Sort: active_now desc, then named_storms desc
        var keys = Object.keys(basins).sort(function (a, b) {
            var da = basins[a], db = basins[b];
            if (db.active_now !== da.active_now) return db.active_now - da.active_now;
            return db.named_storms - da.named_storms;
        });

        var html = '';
        for (var i = 0; i < keys.length; i++) {
            var basin = keys[i];
            var d = basins[basin];
            var color = BASIN_COLORS[basin] || '#64748b';
            var name = BASIN_NAMES[basin] || basin;

            // Skip basins with zero activity this season and no active storms
            if (d.named_storms === 0 && d.active_now === 0) continue;

            // Active badge
            var activeBadge = d.active_now > 0
                ? '<span class="basin-card-active">' + d.active_now + ' active</span>'
                : '<span class="basin-card-active none">quiet</span>';

            // ACE bar
            var acePct = d.climo_ace > 0 ? Math.round((d.ace / d.climo_ace) * 100) : 0;
            var aceBarWidth = Math.min(acePct, 150); // cap at 150% for display
            var aceColor = acePct >= 100 ? '#f87171' : acePct >= 75 ? '#fbbf24' : '#34d399';

            html += '<div class="basin-card" style="--basin-color:' + color + ';">' +
                '<div class="basin-card-header">' +
                    '<span class="basin-card-name">' + name + '</span>' +
                    activeBadge +
                '</div>' +
                '<div class="basin-card-stats">' +
                    '<div class="basin-stat">' +
                        '<div class="basin-stat-val">' + d.named_storms + '</div>' +
                        '<div class="basin-stat-label">Named</div>' +
                    '</div>' +
                    '<div class="basin-stat">' +
                        '<div class="basin-stat-val">' + d.hurricanes + '</div>' +
                        '<div class="basin-stat-label">Hurr</div>' +
                    '</div>' +
                    '<div class="basin-stat">' +
                        '<div class="basin-stat-val">' + d.major_hurricanes + '</div>' +
                        '<div class="basin-stat-label">Major</div>' +
                    '</div>' +
                '</div>' +
                '<div class="basin-ace-row">' +
                    '<span class="basin-ace-label">ACE ' + d.ace.toFixed(1) + '</span>' +
                    '<div class="basin-ace-bar">' +
                        '<div class="basin-ace-fill" style="width:' + aceBarWidth + '%;background:' + aceColor + ';"></div>' +
                    '</div>' +
                    '<span class="basin-ace-pct">' + acePct + '%</span>' +
                '</div>' +
            '</div>';
        }

        // If no basins have activity
        if (!html) {
            html = '<div class="basin-sidebar-loading">No tropical cyclone activity this season</div>';
        }

        content.innerHTML = html;
    }

    // ═══════════════════════════════════════════════════════════
    //  MODEL FORECAST OVERLAY (ATCF A-DECK)
    // ═══════════════════════════════════════════════════════════

    /**
     * Load model forecast data when a storm is selected.
     */
    function _rtLoadModelForecasts(storm) {
        var section = document.getElementById('rt-models-section');
        var statusEl = document.getElementById('rt-models-status');

        var atcfId = storm.atcf_id;
        if (!atcfId) {
            if (section) section.style.display = 'none';
            return;
        }
        if (section) section.style.display = '';

        // Skip if already loaded for this storm
        if (atcfId === _rtModelLastAtcf && _rtModelData) return;
        _rtModelLastAtcf = atcfId;
        _rtModelData = null;

        // Check panel cache
        var cached = _panelCache[atcfId];
        var dataPromise;
        if (cached && cached.models && (Date.now() - cached.cachedAt) < PANEL_CACHE_TTL_MS) {
            dataPromise = Promise.resolve(cached.models);
        } else {
            if (statusEl) statusEl.textContent = 'Loading...';
            dataPromise = fetch(API_BASE + '/global/adeck?atcf_id=' + encodeURIComponent(atcfId), { cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
                .then(function (json) {
                    if (!_panelCache[atcfId]) _panelCache[atcfId] = { cachedAt: Date.now() };
                    _panelCache[atcfId].models = json;
                    return json;
                });
        }

        dataPromise
            .then(function (json) {
                _rtModelData = json;

                // Populate cycle dropdown
                var sel = document.getElementById('rt-model-cycle-select');
                if (sel) {
                    sel.innerHTML = '';
                    var inits = json.init_times || [];
                    for (var i = 0; i < inits.length; i++) {
                        var dt = inits[i];
                        var opt = document.createElement('option');
                        opt.value = dt;
                        opt.textContent = dt.substring(0,4) + '-' + dt.substring(4,6) + '-' +
                            dt.substring(6,8) + ' ' + dt.substring(8,10) + ' UTC';
                        sel.appendChild(opt);
                    }
                }

                if (statusEl) statusEl.textContent = json.n_cycles + ' cycles, ' + json.models.length + ' models';

                // Check if this storm has any interpolated models
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

                var interpBtn = document.getElementById('rt-model-interp-btn');
                _rtModelShowInterp = false;
                if (!hasInterp) {
                    if (interpBtn) {
                        interpBtn.title = 'No interpolated models available for this storm era.';
                        interpBtn.disabled = true;
                        interpBtn.style.opacity = '0.4';
                    }
                } else {
                    if (interpBtn) {
                        interpBtn.title = 'Click to show only late-cycle (interpolated) models.';
                        interpBtn.disabled = false;
                        interpBtn.style.opacity = '';
                    }
                }

                // If overlay is active, render current cycle
                if (_rtModelVisible) {
                    _rtSyncModelCycleToIR();
                }
            })
            .catch(function (e) {
                if (statusEl) statusEl.textContent = 'Unavailable';
                console.warn('[RT Models] A-deck load failed', e);
            });
    }

    /**
     * Toggle the model forecast overlay on/off.
     */
    window._rtToggleModelOverlay = function () {
        var btn = document.getElementById('rt-models-toggle-btn');
        var controls = document.getElementById('rt-model-controls');

        if (_rtModelVisible) {
            _rtModelVisible = false;
            if (btn) btn.textContent = 'Models';
            if (controls) controls.style.display = 'none';
            _rtClearModelLayers();
            _rtClearModelIntensityTraces();
            return;
        }

        _rtModelVisible = true;
        if (btn) btn.textContent = 'Hide Models';
        if (controls) controls.style.display = '';

        // Update intensity button to reflect current state
        var intBtn = document.getElementById('rt-model-intensity-btn');
        if (intBtn) intBtn.style.background = _rtModelShowIntensity ? 'rgba(116,185,255,0.2)' : '';

        if (_rtModelData) {
            _rtSyncModelCycleToIR();
        }

        // Auto-activate DeepMind ensemble if data is loaded
        if (!_rtWeatherlabVisible && (_rtWeatherlabData || _rtDmEnsData)) {
            window._rtToggleWeatherlab();
        }
    };

    /**
     * Toggle auto-sync of model cycle to IR frame time.
     */
    window._rtToggleModelAutoSync = function () {
        _rtModelAutoSync = document.getElementById('rt-model-auto-sync').checked;
        if (_rtModelAutoSync && _rtModelVisible) {
            _rtSyncModelCycleToIR();
        }
    };

    /**
     * Manually select a forecast cycle from the dropdown.
     */
    window._rtSelectModelCycle = function (initTime) {
        _rtModelAutoSync = false;
        document.getElementById('rt-model-auto-sync').checked = false;
        _rtRenderModelCycle(initTime);
        if (_rtModelShowIntensity) {
            _rtRenderModelIntensityTraces(initTime);
        }
    };

    /**
     * Toggle a model type filter.
     */
    window._rtToggleModelTypeFilter = function (mtype) {
        _rtModelTypeFilters[mtype] = !_rtModelTypeFilters[mtype];

        var _filterBtnStyles = {
            official: { color: '#ff4757', border: 'rgba(255,71,87,0.4)', bg: 'rgba(255,71,87,0.15)' },
            ai:       { color: '#00ff87', border: 'rgba(0,255,135,0.4)', bg: 'rgba(0,255,135,0.15)' }
        };

        document.querySelectorAll('.rt-model-filter-btn').forEach(function (btn) {
            var t = btn.getAttribute('data-mtype');
            if (!t) return;
            var isActive = _rtModelTypeFilters[t];
            btn.classList.toggle('active', isActive);

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

        if (_rtModelVisible && _rtModelActiveCycle) {
            _rtRenderModelCycle(_rtModelActiveCycle);
            if (_rtModelShowIntensity) {
                _rtRenderModelIntensityTraces(_rtModelActiveCycle);
            }
        }
    };

    /**
     * Toggle interpolated-only vs all models.
     */
    window._rtToggleModelInterp = function () {
        _rtModelShowInterp = !_rtModelShowInterp;

        var btn = document.getElementById('rt-model-interp-btn');
        if (btn) {
            if (_rtModelShowInterp) {
                btn.title = 'Filtering to late-cycle (interpolated) models only. Click to show all.';
                btn.style.color = '#fbbf24';
                btn.style.borderColor = 'rgba(251,191,36,0.4)';
                btn.style.background = 'rgba(251,191,36,0.15)';
            } else {
                btn.title = 'Click to show only late-cycle (interpolated) models.';
                btn.style.color = '';
                btn.style.borderColor = '';
                btn.style.background = '';
            }
        }

        if (_rtModelVisible && _rtModelActiveCycle) {
            _rtRenderModelCycle(_rtModelActiveCycle);
            if (_rtModelShowIntensity) {
                _rtRenderModelIntensityTraces(_rtModelActiveCycle);
            }
        }
    };

    /**
     * Toggle intensity forecast traces on the chart.
     */
    window._rtToggleModelIntensity = function () {
        _rtModelShowIntensity = !_rtModelShowIntensity;
        var btn = document.getElementById('rt-model-intensity-btn');
        if (btn) btn.style.background = _rtModelShowIntensity ? 'rgba(116,185,255,0.2)' : '';

        if (_rtModelShowIntensity && _rtModelActiveCycle) {
            _rtRenderModelIntensityTraces(_rtModelActiveCycle);
        } else {
            _rtClearModelIntensityTraces();
        }
    };

    /**
     * Find the most recent init cycle at or before the current IR frame time.
     */
    function _rtSyncModelCycleToIR() {
        if (!_rtModelData || !_rtModelData.init_times || !_rtModelData.init_times.length) return;

        // Get current IR datetime from the animation frame
        var irDtStr = (animFrameTimes && animIndex >= 0 && animIndex < animFrameTimes.length)
            ? animFrameTimes[animIndex]
            : null;

        var inits = _rtModelData.init_times;
        var bestInit = inits[inits.length - 1]; // default to latest

        if (irDtStr) {
            var irDate = new Date(irDtStr);
            if (!isNaN(irDate.getTime())) {
                var irYMDH = irDate.getUTCFullYear().toString() +
                    ('0' + (irDate.getUTCMonth() + 1)).slice(-2) +
                    ('0' + irDate.getUTCDate()).slice(-2) +
                    ('0' + irDate.getUTCHours()).slice(-2);

                for (var i = inits.length - 1; i >= 0; i--) {
                    if (inits[i] <= irYMDH) {
                        bestInit = inits[i];
                        break;
                    }
                }
            }
        }

        // Skip re-render if cycle hasn't changed
        if (bestInit === _rtModelActiveCycle) return;

        // Update dropdown
        var sel = document.getElementById('rt-model-cycle-select');
        if (sel) sel.value = bestInit;

        _rtRenderModelCycle(bestInit);
        if (_rtModelShowIntensity) {
            _rtRenderModelIntensityTraces(bestInit);
        }
    }

    /**
     * Render forecast tracks for a given init cycle on the detail map.
     */
    function _rtRenderModelCycle(initTime) {
        _rtModelActiveCycle = initTime;
        _rtClearModelLayers();

        if (!_rtModelData || !_rtModelData.cycles || !_rtModelData.cycles[initTime]) return;
        if (!detailMap) return;

        var cycle = _rtModelData.cycles[initTime];
        var legendHtml = '';
        var _legendSeen = {};
        _rtModelLegendModels = [];

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
            if (!_rtModelTypeFilters[forecast.type]) continue;
            // Apply interpolation filter
            if (_rtModelShowInterp && forecast.interp === false) continue;

            var points = forecast.points;
            if (!points || points.length < 2) continue;

            var color = forecast.color || RT_MODEL_COLORS[tech] || '#888';
            var isOfficial = forecast.type === 'official';
            var isConsensus = forecast.type === 'consensus';
            var weight = isOfficial ? 3.5 : (isConsensus ? 2.5 : 1.5);
            var opacity = isOfficial ? 1.0 : (isConsensus ? 0.9 : 0.6);
            var dashArray = (isOfficial || isConsensus) ? null : '4,3';

            // Build polyline from forecast points (split at antimeridian)
            var latlngs = [];
            for (var pi = 0; pi < points.length; pi++) {
                latlngs.push([points[pi].lat, points[pi].lon]);
            }

            var segments = splitAtAntimeridian(latlngs);
            for (var si = 0; si < segments.length; si++) {
                if (segments[si].length < 2) continue;
                var line = L.polyline(segments[si], {
                    color: color,
                    weight: weight,
                    opacity: opacity,
                    dashArray: dashArray,
                    interactive: false
                }).addTo(detailMap);
                _rtModelTrackLayers.push(line);
            }

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

                    var tauLabel = isTau0 ? forecast.name + ' init' : forecast.name + ' +' + pt.tau + 'h';
                    if (pt.wind) tauLabel += ' \u00B7 ' + pt.wind + ' kt';
                    marker.bindTooltip(tauLabel, { direction: 'top', offset: [0, -6] });

                    _rtModelMarkerLayers.push(marker);
                }
            }

            // Build legend entry
            var legendKey = forecast.name + '|' + color;
            _rtModelLegendModels.push(tech);
            if (!_legendSeen[legendKey]) {
                _legendSeen[legendKey] = true;
                legendHtml += '<span class="rt-model-legend-item" style="color:' + color + ';">' +
                    '<span class="rt-model-legend-swatch" style="background:' + color + ';"></span>' +
                    forecast.name + '</span>';
            }
        }

        var legendEl = document.getElementById('rt-model-legend');
        if (legendEl) legendEl.innerHTML = legendHtml;
    }

    /**
     * Render model intensity forecast traces on the Plotly intensity chart.
     */
    function _rtRenderModelIntensityTraces(initTime) {
        _rtClearModelIntensityTraces();

        if (!_rtModelData || !_rtModelData.cycles || !_rtModelData.cycles[initTime]) return;

        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || !chartEl.data) return;

        var cycle = _rtModelData.cycles[initTime];
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
            if (!_rtModelTypeFilters[forecast.type]) continue;
            if (_rtModelShowInterp && forecast.interp === false) continue;

            var points = forecast.points;
            if (!points || points.length < 2) continue;

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

            var color = forecast.color || RT_MODEL_COLORS[tech] || '#888';
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
            _rtModelIntensityTraces = [];
            var baseCount = chartEl.data.length - newTraces.length;
            for (var i = 0; i < newTraces.length; i++) {
                _rtModelIntensityTraces.push(baseCount + i);
            }
        }
    }

    /**
     * Remove all model forecast layers from the map.
     */
    function _rtClearModelLayers() {
        for (var i = 0; i < _rtModelTrackLayers.length; i++) {
            if (detailMap) try { detailMap.removeLayer(_rtModelTrackLayers[i]); } catch (e) {}
        }
        _rtModelTrackLayers = [];
        for (var j = 0; j < _rtModelMarkerLayers.length; j++) {
            if (detailMap) try { detailMap.removeLayer(_rtModelMarkerLayers[j]); } catch (e) {}
        }
        _rtModelMarkerLayers = [];
    }

    /**
     * Remove model intensity traces from the Plotly chart.
     */
    function _rtClearModelIntensityTraces() {
        if (_rtModelIntensityTraces.length === 0) return;
        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || typeof Plotly === 'undefined') return;

        try {
            var sorted = _rtModelIntensityTraces.slice().sort(function (a, b) { return b - a; });
            Plotly.deleteTraces(chartEl, sorted);
        } catch (e) {
            console.warn('[RT Models] Failed to remove intensity traces', e);
        }
        _rtModelIntensityTraces = [];
    }

    // ═══════════════════════════════════════════════════════════
    //  DEEPMIND WEATHERLAB ENSEMBLE OVERLAY
    // ═══════════════════════════════════════════════════════════

    var _WEATHERLAB_MEMBER_COLOR = 'rgba(0, 229, 255, 0.25)';
    var _WEATHERLAB_MEAN_COLOR = '#00e5ff';

    /**
     * Load WeatherLab ensemble data for a storm (called from openStormDetail).
     */
    function _rtLoadWeatherlab(storm) {
        if (!storm || !storm.atcf_id) return;
        var atcfId = storm.atcf_id;
        _rtWeatherlabData = null;

        var cached = _panelCache[atcfId];
        var dataPromise;
        if (cached && cached.weatherlab && (Date.now() - cached.cachedAt) < PANEL_CACHE_TTL_MS) {
            dataPromise = Promise.resolve(cached.weatherlab);
        } else {
            dataPromise = fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) + '/weatherlab', { cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
                .then(function (json) {
                    if (!_panelCache[atcfId]) _panelCache[atcfId] = { cachedAt: Date.now() };
                    _panelCache[atcfId].weatherlab = json;
                    return json;
                });
        }

        dataPromise
            .then(function (json) {
                _rtWeatherlabData = json;
                var btn = document.getElementById('rt-weatherlab-btn');
                if (btn) btn.title = json.n_members + ' members, init ' + json.init_time;
                console.log('[WeatherLab] Loaded ' + json.n_members + ' members for ' + atcfId);
            })
            .catch(function () {
                // Silent — WeatherLab may not have data for this storm
            });
    }

    /**
     * Toggle DeepMind ensemble overlay on/off.
     */
    window._rtToggleWeatherlab = function () {
        var btn = document.getElementById('rt-weatherlab-btn');

        if (_rtWeatherlabVisible) {
            _rtWeatherlabVisible = false;
            _rtClearWeatherlabLayers();
            _rtClearWeatherlabIntensity();
            if (detailMap) detailMap.off('zoomend', _rtWeatherlabOnZoom);
            if (btn) { btn.style.background = 'rgba(0,229,255,0.15)'; }
            var filterEl = document.getElementById('rt-weatherlab-filter');
            if (filterEl) filterEl.style.display = 'none';
            _rtWeatherlabMinCat = null;
            var catSel = document.getElementById('rt-weatherlab-cat-filter');
            if (catSel) catSel.value = '';
            // Hide distribution panels
            var distEl = document.getElementById('rt-dm-intensity-dist');
            var changeEl = document.getElementById('rt-dm-change-dist');
            var lmiEl = document.getElementById('rt-dm-lmi-dist');
            if (distEl) distEl.style.display = 'none';
            if (changeEl) changeEl.style.display = 'none';
            if (lmiEl) lmiEl.style.display = 'none';
            return;
        }

        if (!_rtWeatherlabData) {
            if (btn) btn.title = 'No DeepMind data available';
            return;
        }

        _rtWeatherlabVisible = true;
        if (btn) { btn.style.background = 'rgba(0,229,255,0.35)'; }
        var filterEl = document.getElementById('rt-weatherlab-filter');
        if (filterEl) filterEl.style.display = '';
        _rtRenderWeatherlab();
        _rtRenderWeatherlabIntensity();
        if (detailMap) detailMap.on('zoomend', _rtWeatherlabOnZoom);

        // Show 1000-member distribution panels if data is loaded
        if (_rtDmEnsData) {
            _rtShowDmPanels();
        }
    };

    /**
     * Render 50 ensemble spaghetti tracks + mean on the detail map.
     */
    /** Zoom-based scale factor for ensemble rendering.
     *  At zoom 5 (default): 1.0x. Scales up gently at higher zooms. */
    /** Wind speed threshold for each Saffir-Simpson category */
    var _SS_WIND_THRESHOLDS = { 'TS': 34, 'C1': 64, 'C2': 83, 'C3': 96, 'C4': 113, 'C5': 137 };

    /** Check if a member's max wind reaches at least the given category */
    function _wlMemberReachesCat(pts, minCat) {
        if (!minCat || !pts) return true;
        var threshold = _SS_WIND_THRESHOLDS[minCat] || 0;
        for (var i = 0; i < pts.length; i++) {
            if (pts[i].wind != null && pts[i].wind >= threshold) return true;
        }
        return false;
    }

    /**
     * Filter ensemble members by max intensity category.
     */
    window._rtFilterWeatherlabByCat = function (cat) {
        _rtWeatherlabMinCat = cat || null;
        if (_rtWeatherlabVisible) {
            _rtRenderWeatherlab();
            _rtRenderWeatherlabIntensity();
        }
    };

    function _wlZoomScale() {
        if (!detailMap) return 1.0;
        var z = detailMap.getZoom();
        // z5=1.0, z6=1.3, z7=1.7, z8=2.1, z9=2.5
        return 1.0 + (z - 5) * 0.35;
    }

    /** Re-scale WeatherLab layers on zoom change */
    function _rtWeatherlabOnZoom() {
        if (!_rtWeatherlabVisible) return;
        var s = _wlZoomScale();
        for (var i = 0; i < _rtWeatherlabLayers.length; i++) {
            var lyr = _rtWeatherlabLayers[i];
            if (lyr._isMeanLine) {
                lyr.setStyle({ weight: 3 * s });
            } else {
                lyr.setStyle({ weight: Math.max(0.8, 1 * s) });
            }
        }
        for (var j = 0; j < _rtWeatherlabMarkers.length; j++) {
            var m = _rtWeatherlabMarkers[j];
            var base = m._wlBaseRadius || 2;
            m.setRadius(base * s);
        }
    }

    function _rtRenderWeatherlab() {
        _rtClearWeatherlabLayers();
        if (!_rtWeatherlabData || !detailMap) return;

        var s = _wlZoomScale();
        var members = _rtWeatherlabData.members || {};
        var memberKeys = Object.keys(members);
        var shownCount = 0;

        // Render ensemble members as thin spaghetti
        for (var mi = 0; mi < memberKeys.length; mi++) {
            var key = memberKeys[mi];
            var pts = members[key].points;
            if (!pts || pts.length < 2) continue;

            // Apply intensity filter
            if (!_wlMemberReachesCat(pts, _rtWeatherlabMinCat)) continue;
            shownCount++;

            var latlngs = [];
            for (var pi = 0; pi < pts.length; pi++) {
                latlngs.push([pts[pi].lat, pts[pi].lon]);
            }

            var segments = splitAtAntimeridian(latlngs);
            for (var si = 0; si < segments.length; si++) {
                if (segments[si].length < 2) continue;
                var line = L.polyline(segments[si], {
                    color: _WEATHERLAB_MEMBER_COLOR,
                    weight: Math.max(0.8, 1 * s),
                    opacity: 1,
                    interactive: false
                }).addTo(detailMap);
                _rtWeatherlabLayers.push(line);
            }

            // Add markers at 24h intervals with tooltips
            for (var pi = 0; pi < pts.length; pi++) {
                var pt = pts[pi];
                if (pt.tau > 0 && pt.tau % 24 !== 0) continue;

                var cat = windToCategory(pt.wind);
                var color = SS_COLORS[cat] || '#64748b';
                var baseR = pt.tau === 0 ? 3 : 2;
                var marker = L.circleMarker([pt.lat, pt.lon], {
                    radius: baseR * s,
                    color: color,
                    fillColor: color,
                    fillOpacity: 0.8,
                    weight: 0.5 * s,
                    opacity: 0.7,
                    interactive: true
                }).addTo(detailMap);
                marker._wlBaseRadius = baseR;

                var tipHtml = '<b>Member ' + key + '</b> +' + pt.tau + 'h<br>' +
                    pt.lat.toFixed(1) + '\u00B0N ' + pt.lon.toFixed(1) + '\u00B0E<br>' +
                    (pt.wind != null ? pt.wind.toFixed(0) + ' kt' : '') +
                    (pt.pres != null ? ' \u00B7 ' + pt.pres.toFixed(0) + ' hPa' : '') +
                    '<br><span style="color:' + color + ';">' + cat + '</span>';

                marker.bindTooltip(tipHtml, { direction: 'top', offset: [0, -4] });
                _rtWeatherlabMarkers.push(marker);
            }

            // LMI marker — diamond at the point of maximum intensity
            var lmiPt = null;
            var lmiWind = -1;
            for (var li = 0; li < pts.length; li++) {
                if (pts[li].wind != null && pts[li].wind > lmiWind) {
                    lmiWind = pts[li].wind;
                    lmiPt = pts[li];
                }
            }
            if (lmiPt && lmiWind >= 34) {
                var lmiCat = windToCategory(lmiWind);
                var lmiColor = SS_COLORS[lmiCat] || '#64748b';
                var lmiR = 3.5;
                var lmiMarker = L.circleMarker([lmiPt.lat, lmiPt.lon], {
                    radius: lmiR * s,
                    color: '#fff',
                    fillColor: lmiColor,
                    fillOpacity: 1,
                    weight: 1.2 * s,
                    opacity: 0.9,
                    interactive: true
                }).addTo(detailMap);
                lmiMarker._wlBaseRadius = lmiR;

                var lmiTip = '<b>Member ' + key + ' LMI</b><br>' +
                    '+' + lmiPt.tau + 'h \u00B7 ' + lmiWind.toFixed(0) + ' kt' +
                    (lmiPt.pres != null ? ' \u00B7 ' + lmiPt.pres.toFixed(0) + ' hPa' : '') +
                    '<br>' + lmiPt.lat.toFixed(1) + '\u00B0N ' + lmiPt.lon.toFixed(1) + '\u00B0E' +
                    '<br><span style="color:' + lmiColor + ';">' + lmiCat + '</span>';

                lmiMarker.bindTooltip(lmiTip, { direction: 'top', offset: [0, -5] });
                _rtWeatherlabMarkers.push(lmiMarker);
            }
        }

        // Render ensemble mean as thick line
        var mean = _rtWeatherlabData.ensemble_mean;
        if (mean && mean.points && mean.points.length >= 2) {
            var meanLatLngs = [];
            for (var i = 0; i < mean.points.length; i++) {
                meanLatLngs.push([mean.points[i].lat, mean.points[i].lon]);
            }

            var meanSegments = splitAtAntimeridian(meanLatLngs);
            for (var si = 0; si < meanSegments.length; si++) {
                if (meanSegments[si].length < 2) continue;
                var meanLine = L.polyline(meanSegments[si], {
                    color: _WEATHERLAB_MEAN_COLOR,
                    weight: 3 * s,
                    opacity: 0.95,
                    interactive: false
                }).addTo(detailMap);
                meanLine._isMeanLine = true;
                _rtWeatherlabLayers.push(meanLine);
            }

            // Markers at standard forecast hours on mean
            for (var i = 0; i < mean.points.length; i++) {
                var pt = mean.points[i];
                if (pt.tau > 0 && pt.tau % 24 !== 0) continue;

                var cat = windToCategory(pt.wind);
                var color = SS_COLORS[cat] || '#64748b';
                var baseR = pt.tau === 0 ? 5 : 4;
                var marker = L.circleMarker([pt.lat, pt.lon], {
                    radius: baseR * s,
                    color: '#fff',
                    fillColor: color,
                    fillOpacity: 1,
                    weight: 1.5 * s,
                    opacity: 1,
                    interactive: true
                }).addTo(detailMap);
                marker._wlBaseRadius = baseR;

                var tipHtml = '<b>DeepMind Mean</b> +' + pt.tau + 'h<br>' +
                    pt.lat.toFixed(1) + '\u00B0N ' + pt.lon.toFixed(1) + '\u00B0E<br>' +
                    (pt.wind != null ? pt.wind.toFixed(0) + ' kt' : '') +
                    (pt.pres != null ? ' \u00B7 ' + pt.pres.toFixed(0) + ' hPa' : '') +
                    '<br><span style="color:' + color + ';">' + cat + '</span>' +
                    _rtFmtSize(pt);

                marker.bindTooltip(tipHtml, { direction: 'top', offset: [0, -6] });
                _rtWeatherlabMarkers.push(marker);
            }

            // LMI marker for ensemble mean
            var meanLmiPt = null;
            var meanLmiWind = -1;
            for (var ml = 0; ml < mean.points.length; ml++) {
                if (mean.points[ml].wind != null && mean.points[ml].wind > meanLmiWind) {
                    meanLmiWind = mean.points[ml].wind;
                    meanLmiPt = mean.points[ml];
                }
            }
            if (meanLmiPt && meanLmiWind >= 34) {
                var mlCat = windToCategory(meanLmiWind);
                var mlColor = SS_COLORS[mlCat] || '#64748b';
                var mlR = 6;
                var mlMarker = L.circleMarker([meanLmiPt.lat, meanLmiPt.lon], {
                    radius: mlR * s,
                    color: '#fff',
                    fillColor: mlColor,
                    fillOpacity: 1,
                    weight: 2 * s,
                    opacity: 1,
                    interactive: true
                }).addTo(detailMap);
                mlMarker._wlBaseRadius = mlR;

                var mlTip = '<b>DeepMind Mean LMI</b><br>' +
                    '+' + meanLmiPt.tau + 'h \u00B7 ' + meanLmiWind.toFixed(0) + ' kt' +
                    (meanLmiPt.pres != null ? ' \u00B7 ' + meanLmiPt.pres.toFixed(0) + ' hPa' : '') +
                    '<br>' + meanLmiPt.lat.toFixed(1) + '\u00B0N ' + meanLmiPt.lon.toFixed(1) + '\u00B0E' +
                    '<br><span style="color:' + mlColor + ';">' + mlCat + '</span>' +
                    _rtFmtSize(meanLmiPt);

                mlMarker.bindTooltip(mlTip, { direction: 'top', offset: [0, -7] });
                _rtWeatherlabMarkers.push(mlMarker);
            }
        }

        // Update filter count
        var countEl = document.getElementById('rt-weatherlab-filter-count');
        if (countEl) {
            countEl.textContent = _rtWeatherlabMinCat
                ? shownCount + '/' + memberKeys.length + ' members'
                : memberKeys.length + ' members';
        }
    }

    /**
     * Add ensemble mean + spread envelope to the Plotly intensity chart.
     */
    function _rtRenderWeatherlabIntensity() {
        _rtClearWeatherlabIntensity();
        if (!_rtWeatherlabData) return;

        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || !chartEl.data) return;

        var initTime = _rtWeatherlabData.init_time;
        var initDate = new Date(
            parseInt(initTime.substring(0,4)),
            parseInt(initTime.substring(4,6)) - 1,
            parseInt(initTime.substring(6,8)),
            parseInt(initTime.substring(8,10))
        );

        var newTraces = [];

        // Compute min/max envelope across filtered members
        var members = _rtWeatherlabData.members || {};
        var memberKeys = Object.keys(members);
        var tauMap = {};  // tau -> {winds: [], times: ISO}
        for (var mi = 0; mi < memberKeys.length; mi++) {
            var pts = members[memberKeys[mi]].points;
            if (!_wlMemberReachesCat(pts, _rtWeatherlabMinCat)) continue;
            if (!pts) continue;
            for (var pi = 0; pi < pts.length; pi++) {
                var pt = pts[pi];
                if (pt.wind == null) continue;
                if (!tauMap[pt.tau]) {
                    var t = new Date(initDate.getTime() + pt.tau * 3600000);
                    tauMap[pt.tau] = { winds: [], time: t.toISOString() };
                }
                tauMap[pt.tau].winds.push(pt.wind);
            }
        }

        var taus = Object.keys(tauMap).map(Number).sort(function (a, b) { return a - b; });

        // Min envelope (bottom of spread)
        var minTimes = [];
        var minWinds = [];
        for (var i = 0; i < taus.length; i++) {
            minTimes.push(tauMap[taus[i]].time);
            minWinds.push(Math.min.apply(null, tauMap[taus[i]].winds));
        }
        newTraces.push({
            x: minTimes, y: minWinds,
            type: 'scatter', mode: 'lines',
            name: 'DeepMind min',
            line: { color: 'rgba(0,229,255,0.15)', width: 0 },
            showlegend: false, hoverinfo: 'skip'
        });

        // Max envelope (top of spread, filled to min)
        var maxTimes = [];
        var maxWinds = [];
        for (var i = 0; i < taus.length; i++) {
            maxTimes.push(tauMap[taus[i]].time);
            maxWinds.push(Math.max.apply(null, tauMap[taus[i]].winds));
        }
        newTraces.push({
            x: maxTimes, y: maxWinds,
            type: 'scatter', mode: 'lines',
            name: 'DeepMind spread',
            line: { color: 'rgba(0,229,255,0.15)', width: 0 },
            fill: 'tonexty',
            fillcolor: 'rgba(0,229,255,0.12)',
            showlegend: false, hoverinfo: 'skip'
        });

        // Ensemble mean line
        var mean = _rtWeatherlabData.ensemble_mean;
        if (mean && mean.points) {
            var meanTimes = [];
            var meanWinds = [];
            for (var i = 0; i < mean.points.length; i++) {
                if (mean.points[i].wind != null) {
                    var t = new Date(initDate.getTime() + mean.points[i].tau * 3600000);
                    meanTimes.push(t.toISOString());
                    meanWinds.push(mean.points[i].wind);
                }
            }
            newTraces.push({
                x: meanTimes, y: meanWinds,
                type: 'scatter', mode: 'lines+markers',
                name: 'DeepMind Mean',
                line: { color: _WEATHERLAB_MEAN_COLOR, width: 2.5 },
                marker: { size: 4, symbol: 'circle', color: _WEATHERLAB_MEAN_COLOR },
                opacity: 0.9,
                showlegend: false,
                hovertemplate: 'DeepMind: %{y:.0f} kt<extra></extra>'
            });
        }

        if (newTraces.length > 0 && typeof Plotly !== 'undefined') {
            Plotly.addTraces(chartEl, newTraces);
            _rtWeatherlabMeanTraces = [];
            var baseCount = chartEl.data.length - newTraces.length;
            for (var i = 0; i < newTraces.length; i++) {
                _rtWeatherlabMeanTraces.push(baseCount + i);
            }
        }
    }

    /**
     * Remove ensemble layers from map.
     */
    function _rtClearWeatherlabLayers() {
        for (var i = 0; i < _rtWeatherlabLayers.length; i++) {
            if (detailMap) try { detailMap.removeLayer(_rtWeatherlabLayers[i]); } catch (e) {}
        }
        _rtWeatherlabLayers = [];
        for (var j = 0; j < _rtWeatherlabMarkers.length; j++) {
            if (detailMap) try { detailMap.removeLayer(_rtWeatherlabMarkers[j]); } catch (e) {}
        }
        _rtWeatherlabMarkers = [];
    }

    /**
     * Remove ensemble intensity traces from chart.
     */
    function _rtClearWeatherlabIntensity() {
        if (_rtWeatherlabMeanTraces.length === 0) return;
        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || typeof Plotly === 'undefined') return;
        try {
            var sorted = _rtWeatherlabMeanTraces.slice().sort(function (a, b) { return b - a; });
            Plotly.deleteTraces(chartEl, sorted);
        } catch (e) {}
        _rtWeatherlabMeanTraces = [];
    }

    /**
     * Full cleanup of WeatherLab state.
     */
    // ═══════════════════════════════════════════════════════════
    //  GLOBAL DEEPMIND ENSEMBLE OVERLAY (RT main map)
    // ═══════════════════════════════════════════════════════════
    //
    //  Renders WeatherLab ensemble forecast tracks for *every* active
    //  storm + invest on the global RT map. WeatherLab's public CSV is
    //  ATCF-paired only, so this surfaces invests (90-99 IDs) but not
    //  pre-genesis disturbances that haven't been numbered yet.

    function _clearGlobalWeatherlab() {
        for (var i = 0; i < _rtGlobalWLLayers.length; i++) {
            if (map) map.removeLayer(_rtGlobalWLLayers[i]);
        }
        _rtGlobalWLLayers = [];
    }

    function _renderGlobalWeatherlab() {
        _clearGlobalWeatherlab();
        if (!_rtGlobalWLData || !map) return;
        var tracks = _rtGlobalWLData.tracks || [];
        if (tracks.length === 0) return;

        for (var ti = 0; ti < tracks.length; ti++) {
            var trk = tracks[ti];
            var trackId = trk.track_id || '';
            var isInvest = /9[0-9](?:[A-Z]|$)/.test(trackId);  // EP952025-style invest
            var members = trk.members || {};
            var memberKeys = Object.keys(members);

            // Thin spaghetti members
            for (var mi = 0; mi < memberKeys.length; mi++) {
                var pts = members[memberKeys[mi]].points;
                if (!pts || pts.length < 2) continue;
                var latlngs = [];
                for (var pi = 0; pi < pts.length; pi++) {
                    latlngs.push([pts[pi].lat, pts[pi].lon]);
                }
                var segs = splitAtAntimeridian(latlngs);
                for (var si = 0; si < segs.length; si++) {
                    if (segs[si].length < 2) continue;
                    var line = L.polyline(segs[si], {
                        color: _WEATHERLAB_MEMBER_COLOR,
                        weight: 0.8,
                        opacity: 0.55,
                        dashArray: isInvest ? '3,3' : null,
                        interactive: false
                    }).addTo(map);
                    _rtGlobalWLLayers.push(line);
                }
            }

            // Ensemble mean — thick highlight
            var mean = trk.ensemble_mean;
            if (mean && mean.points && mean.points.length >= 2) {
                var meanLatLngs = [];
                for (var pj = 0; pj < mean.points.length; pj++) {
                    meanLatLngs.push([mean.points[pj].lat, mean.points[pj].lon]);
                }
                var meanSegs = splitAtAntimeridian(meanLatLngs);
                for (var msi = 0; msi < meanSegs.length; msi++) {
                    if (meanSegs[msi].length < 2) continue;
                    var meanLine = L.polyline(meanSegs[msi], {
                        color: _WEATHERLAB_MEAN_COLOR,
                        weight: 2.2,
                        opacity: 0.95,
                        dashArray: isInvest ? '6,4' : null,
                        interactive: false
                    }).addTo(map);
                    _rtGlobalWLLayers.push(meanLine);
                }

                // Genesis-point marker (tau=0) labeled with track ID
                var p0 = mean.points[0];
                var labelHtml = '<b>' + trackId + '</b>' +
                    (isInvest ? ' <span style="opacity:0.7">(invest)</span>' : '') +
                    '<br>DeepMind ensemble · ' +
                    (trk.n_members || memberKeys.length) + ' members';
                var lmiPt = null, lmiWind = -1;
                for (var lj = 0; lj < mean.points.length; lj++) {
                    if (mean.points[lj].wind != null && mean.points[lj].wind > lmiWind) {
                        lmiWind = mean.points[lj].wind;
                        lmiPt = mean.points[lj];
                    }
                }
                if (lmiPt && lmiWind >= 34) {
                    var lmiCat = windToCategory(lmiWind);
                    labelHtml += '<br>Peak: +' + lmiPt.tau + 'h · ' +
                        lmiWind.toFixed(0) + ' kt · ' + lmiCat;
                }

                var startMarker = L.circleMarker([p0.lat, p0.lon], {
                    radius: 4,
                    color: '#fff',
                    fillColor: _WEATHERLAB_MEAN_COLOR,
                    fillOpacity: 1,
                    weight: 1.5,
                    opacity: 1,
                    interactive: true
                }).addTo(map);
                startMarker.bindTooltip(labelHtml, { direction: 'top', offset: [0, -6] });
                _rtGlobalWLLayers.push(startMarker);
            }
        }
    }

    function _loadGlobalWeatherlab() {
        if (_rtGlobalWLLoading) return;
        _rtGlobalWLLoading = true;
        var statusEl = document.getElementById('ir-global-wl-status');
        if (statusEl) statusEl.textContent = 'Loading…';

        fetch(API_BASE + '/ir-monitor/weatherlab-global', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                _rtGlobalWLData = data;
                if (_rtGlobalWLVisible) _renderGlobalWeatherlab();
                if (statusEl) {
                    var n = data && data.n_tracks ? data.n_tracks : 0;
                    statusEl.textContent = n === 0
                        ? '0 tracks · WeatherLab paired'
                        : n + ' track' + (n === 1 ? '' : 's') +
                          (data.init_time ? ' · init ' + data.init_time.slice(0, 8) + ' ' + data.init_time.slice(8) + 'Z' : '');
                }
                _ga('rt_global_wl_loaded', { n_tracks: data && data.n_tracks });
            })
            .catch(function (err) {
                console.warn('[Global WeatherLab] fetch failed', err);
                if (statusEl) statusEl.textContent = 'Unavailable';
            })
            .finally(function () { _rtGlobalWLLoading = false; });
    }

    function toggleGlobalWeatherlab() {
        _rtGlobalWLVisible = !_rtGlobalWLVisible;
        var status = document.getElementById('ir-global-wl-status');
        if (status) status.style.display = _rtGlobalWLVisible ? '' : 'none';
        if (_rtGlobalWLVisible) {
            if (!_rtGlobalWLData) {
                _loadGlobalWeatherlab();
            } else {
                _renderGlobalWeatherlab();
            }
        } else {
            _clearGlobalWeatherlab();
        }
        if (typeof _refreshLayersCount === 'function') _refreshLayersCount();
    }
    window.toggleGlobalWeatherlab = toggleGlobalWeatherlab;

    // ═══════════════════════════════════════════════════════════
    //  FNV3 LARGE_ENSEMBLE CYCLOGENESIS OVERLAY (RT main map)
    // ═══════════════════════════════════════════════════════════
    //  Same shape as the paired global weatherlab overlay above, but
    //  rendered in orange to visually separate "ATCF storms FNV3 is
    //  forecasting" from "pre-genesis features FNV3 predicts may
    //  form" — the second is what's missing from the paired CSV and
    //  what users see on WeatherNerds for the WPac genesis cluster.

    function _clearGenesis() {
        for (var i = 0; i < _rtGenesisLayers.length; i++) {
            if (map) map.removeLayer(_rtGenesisLayers[i]);
        }
        _rtGenesisLayers = [];
    }

    // Predicted-peak Saffir-Simpson palette for the Global Map genesis
    // layer. Picked from SS_COLORS but slightly desaturated for the
    // faint spaghetti so the bold mean stays the eye-catcher. Drives
    // the spaghetti color, the mean polyline color, and the marker
    // fill so a forecaster scanning the basin instantly sees which
    // genesis cluster is forecast to spin up vs which stays a TD.
    function _genesisCatStyle(peakWind) {
        var cat = windToCategory(peakWind);
        var bold = SS_COLORS[cat] || '#94a3b8';
        // Convert bold to faint translucent for the spaghetti pass —
        // 12% alpha keeps the layer readable on top of IR/visible base.
        function rgba(hex, a) {
            var r = parseInt(hex.slice(1, 3), 16);
            var g = parseInt(hex.slice(3, 5), 16);
            var b = parseInt(hex.slice(5, 7), 16);
            return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        }
        return {
            cat: cat,
            bold: bold,
            faint: rgba(bold, 0.18),
            // Marker scales with intensity — a forecast C5 deserves a
            // bigger dot than a system that stays TD.
            radius: cat === 'C5' ? 9
                  : cat === 'C4' ? 8
                  : cat === 'C3' ? 7
                  : cat === 'C2' ? 6
                  : cat === 'C1' ? 6
                  : cat === 'TS' ? 5
                  :                4,
        };
    }

    // Total ensemble size for FNV3 LARGE_ENSEMBLE. Formation probability
    // is computed per-track as n_members_total / this value, so a track
    // with 50 members is a 5% formation feature.
    var _GENESIS_ENSEMBLE_SIZE = 1000;
    // Minimum member fraction to call something a "Disturbance" on the
    // map. Below this it's likely noise — a few stray member detections
    // that didn't agree spatially. 5% (50/1000) matches NHC's "Low" /
    // "Medium" disturbance threshold conceptually.
    var _GENESIS_MIN_FRACTION = 0.05;

    // Track → "Disturbance N" naming. Ordered by formation probability
    // descending so D1 is always the most-likely-to-form, regardless of
    // what synthetic track_id DeepMind assigned. Stored on the track
    // object so the detail modal can look up the same display label.
    function _genesisQualifyingDisturbances(rawTracks) {
        var qualifying = [];
        for (var i = 0; i < rawTracks.length; i++) {
            var t = rawTracks[i];
            var total = t.n_members_total ||
                       (t.members ? Object.keys(t.members).length : 0);
            var frac = total / _GENESIS_ENSEMBLE_SIZE;
            if (frac < _GENESIS_MIN_FRACTION) continue;
            // Apply the same cross-basin outlier filter the modal uses,
            // BEFORE computing the displayed mean track. Otherwise a
            // single orphan member (e.g. the Gulf-of-Mexico sample
            // DeepMind's per-cycle tracker mis-labeled as WPac track 1)
            // drags the dashed mean line halfway across the globe even
            // though the cluster itself is regional. _filterDmOutliers
            // returns the original track unchanged when nothing crosses
            // the 1500 km gate, so this is a no-op for clean clusters.
            var filt = _filterDmOutliers(t);
            var displayTrack = filt.json;
            var mean = displayTrack.ensemble_mean || { points: [] };
            // Compute predicted peak Vmax + median genesis position
            // from the (filtered) ensemble mean. The marker sits at the
            // median current/early position (mean.points[0]), not at
            // the LMI — what the forecaster wants to see is "where the
            // disturbance IS right now", not "where it will peak".
            var peakWind = 0, peakTau = null;
            for (var p = 0; p < mean.points.length; p++) {
                if (mean.points[p].wind != null
                        && mean.points[p].wind > peakWind) {
                    peakWind = mean.points[p].wind;
                    peakTau = mean.points[p].tau;
                }
            }
            qualifying.push({
                raw: displayTrack, total: total, fraction: frac,
                peakWind: peakWind, peakTau: peakTau,
                mean: mean,
                excludedOutliers: filt.excluded,
            });
        }
        // Highest formation probability first → D1 is the most-confident
        // potential genesis.
        qualifying.sort(function (a, b) { return b.fraction - a.fraction; });
        for (var k = 0; k < qualifying.length; k++) {
            qualifying[k].displayLabel = 'Disturbance ' + (k + 1);
            qualifying[k].displayShort = 'D' + (k + 1);
        }
        return qualifying;
    }

    // Cache disturbance metadata keyed by track_id so the detail modal
    // can show the same "Disturbance N · 42% formation · peaks C2"
    // header without re-running the qualification scan.
    var _genesisDisturbanceMeta = {};

    // ATCF IDs (uppercase) currently represented by an FNV3 disturbance
    // pin. renderStormMarkers consults this set to suppress the redundant
    // active-storm marker — the disturbance pin already shows the
    // official storm name and the modal carries a "View IR Detail"
    // button to reach the satellite page. Rebuilt by every
    // _genesisApplyActiveStormMatches run.
    var _genesisMatchedAtcfIds = {};

    // Map an active-storm ATCF basin code to its single-letter suffix
    // used in JTWC/NHC nomenclature (e.g., "WP012026" → "01W").
    var _ATCF_BASIN_LETTER = {
        AL: 'L', EP: 'E', CP: 'C',
        WP: 'W', IO: 'A', SH: 'S',
    };

    // Format an active-storm record using JTWC/NHC nomenclature so a
    // matched FNV3 disturbance can carry the user-recognizable name
    // instead of our internal "Disturbance N" label. Returns:
    //   { full, short, atcfId }
    //   - invest (atcf number 90-99) → "Invest 90W" / "90W"
    //   - sub-TS unnamed (number-word names like "ONE")  → "TD 01W" / "01W"
    //   - named system (TS+)         → title-cased name  / first-word short
    function _genesisFormatStormLabel(storm) {
        if (!storm || !storm.atcf_id) return null;
        var id = String(storm.atcf_id);
        var basinCode = id.slice(0, 2).toUpperCase();
        var num = id.slice(2, 4);
        var n = parseInt(num, 10);
        var letter = _ATCF_BASIN_LETTER[basinCode] || '';
        var nnb = num + letter;  // e.g., "01W"
        if (isNaN(n)) return null;
        if (n >= 90 && n <= 99) {
            return { full: 'Invest ' + nnb, short: nnb, atcfId: id.toUpperCase() };
        }
        var cat = String(storm.category || '').toUpperCase();
        var name = String(storm.name || '').trim();
        // Number-word names = NHC's pre-name "Tropical Depression ONE/TWO"
        // convention. Treat as TD nomenclature so the user sees the more
        // familiar "TD 01W" instead of "ONE".
        var isNumberWord = /^(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY|TWENTY-?ONE|TWENTY-?TWO|TWENTY-?THREE|TWENTY-?FOUR|TWENTY-?FIVE|TWENTY-?SIX|TWENTY-?SEVEN|TWENTY-?EIGHT|TWENTY-?NINE|THIRTY)$/.test(name);
        var looksLikeAtcfId = /^[A-Z]{2}\d{2}\d{4}$/.test(name);
        var hasRealName = name && !isNumberWord && !looksLikeAtcfId;
        if (cat === 'TD' || cat === '' || cat === 'XX' || !hasRealName) {
            return { full: 'TD ' + nnb, short: nnb, atcfId: id.toUpperCase() };
        }
        var titled = name.toLowerCase().split(/\s+/).map(function (w) {
            return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
        return {
            full: titled,
            short: titled.split(/\s+/)[0],
            atcfId: id.toUpperCase(),
        };
    }

    // Find the active-storm record closest to a disturbance's current
    // ensemble-mean position, within 600 km. Returns null if no storm
    // qualifies. Used to re-label a disturbance that's already an
    // officially-tracked TC/invest by JTWC or NHC. Greedy: caller is
    // expected to remove the matched storm from the pool so two
    // disturbances can't claim the same system.
    function _genesisMatchStormToDisturbance(disturbance, stormsAvail) {
        if (!disturbance || !disturbance.mean
                || !disturbance.mean.points
                || !disturbance.mean.points.length) return null;
        if (!stormsAvail || !stormsAvail.length) return null;
        var p0 = disturbance.mean.points[0];
        if (p0.lat == null || p0.lon == null) return null;
        var best = null, bestDist = 600;  // km threshold
        for (var i = 0; i < stormsAvail.length; i++) {
            var s = stormsAvail[i];
            if (!s || s.lat == null || s.lon == null) continue;
            var d = _genesisHaversineKm(p0.lat, p0.lon, s.lat, s.lon);
            if (d < bestDist) { bestDist = d; best = s; }
        }
        if (!best) return null;
        return { storm: best, distKm: bestDist };
    }

    // Apply ATCF storm matches to a sorted disturbance list in place.
    // When a match is found, the disturbance's display label flips from
    // "Disturbance N / DN" to the storm's official name ("TD 01W" /
    // "01W" or "Bonnie" / "Bonnie"), and `atcfMatch` is stashed for
    // downstream UI (modal subtitle pill, tooltip).
    function _genesisApplyActiveStormMatches(disturbances, stormsArr) {
        // Always rebuild from scratch — stale matches from a prior run
        // would suppress storm markers that no longer have a partner.
        _genesisMatchedAtcfIds = {};
        if (!disturbances || !disturbances.length) return;
        var pool = (stormsArr || []).slice();
        for (var i = 0; i < disturbances.length; i++) {
            var d = disturbances[i];
            var match = _genesisMatchStormToDisturbance(d, pool);
            if (!match) continue;
            var label = _genesisFormatStormLabel(match.storm);
            if (!label) continue;
            d.atcfMatch = {
                atcfId: label.atcfId,
                name: match.storm.name,
                category: match.storm.category,
                vmaxKt: match.storm.vmax_kt,
                distKm: match.distKm,
            };
            d.atcfLabel = label;
            d.displayLabel = label.full;
            d.displayShort = label.short;
            _genesisMatchedAtcfIds[label.atcfId.toUpperCase()] = true;
            // Remove from pool so a second disturbance can't claim it.
            var idx = pool.indexOf(match.storm);
            if (idx >= 0) pool.splice(idx, 1);
        }
    }

    // Great-circle distance in km. Used by the TC-ATLAS clustering
    // path to test member-genesis spatial proximity. Identical math
    // to the haversine helpers in satellite.js / global_archive.js;
    // duplicated here to keep this module's genesis logic self-
    // contained (no cross-file dependency just for one cluster
    // routine).
    function _genesisHaversineKm(lat1, lon1, lat2, lon2) {
        var R = 6371;
        var rad = Math.PI / 180;
        var dLat = (lat2 - lat1) * rad;
        var dLon = (lon2 - lon1) * rad;
        var s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
        var a = s1 * s1 +
                Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * s2 * s2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    // Build an ensemble-mean trajectory from a set of member point
    // arrays: bucket by tau, then average lat/lon/wind per tau across
    // every contributing member. Used by the TC-ATLAS clustering path
    // since DeepMind's pre-computed ensemble_mean is per-track-id and
    // doesn't apply to our re-grouping.
    function _genesisMeanTrack(memberPointArrays) {
        var byTau = {};
        for (var i = 0; i < memberPointArrays.length; i++) {
            var pts = memberPointArrays[i];
            if (!pts) continue;
            for (var j = 0; j < pts.length; j++) {
                var p = pts[j];
                if (p.lat == null || p.lon == null) continue;
                if (!byTau[p.tau]) {
                    byTau[p.tau] = { latSum: 0, lonSum: 0,
                                     windSum: 0, windN: 0, n: 0 };
                }
                byTau[p.tau].latSum += p.lat;
                byTau[p.tau].lonSum += p.lon;
                byTau[p.tau].n++;
                if (p.wind != null && isFinite(p.wind)) {
                    byTau[p.tau].windSum += p.wind;
                    byTau[p.tau].windN++;
                }
            }
        }
        var taus = Object.keys(byTau).map(Number).sort(function (a, b) {
            return a - b;
        });
        return taus.map(function (tau) {
            var b = byTau[tau];
            return {
                tau: tau,
                lat: b.latSum / b.n,
                lon: b.lonSum / b.n,
                wind: b.windN > 0 ? b.windSum / b.windN : null,
            };
        });
    }

    // TC-ATLAS clustering — DENSITY-PEAK method.
    //
    // For each ensemble member that reaches TC strength, record its
    // FIRST-genesis lat/lon (where it first crosses 34 kt). Bin those
    // points into a 2D density grid and find local maxima. Each peak
    // is one Disturbance; each member is independently assigned to its
    // nearest peak within ASSIGN_RADIUS_KM. No union-find, no chain
    // links — nearby distinct systems get their own peaks and stay
    // separated regardless of any in-between transit members.
    function _genesisTCAtlasDisturbances_TrajOverlap_LEGACY(rawTracks) {
        if (!rawTracks || !rawTracks.length) return [];

        // Step 1: pool trajectories that reach TC strength. Each
        // trajectory keeps its full point sequence — we'll match
        // trajectories on whole-track overlap, not just genesis points.
        var trajs = [];
        for (var t = 0; t < rawTracks.length; t++) {
            var trk = rawTracks[t];
            var members = trk.members || {};
            var keys = Object.keys(members);
            for (var k = 0; k < keys.length; k++) {
                var pts = members[keys[k]].points;
                if (!pts || pts.length < 2) continue;
                var reachesTC = false;
                for (var p = 0; p < pts.length; p++) {
                    if (pts[p].wind != null && pts[p].wind >= 34) {
                        reachesTC = true;
                        break;
                    }
                }
                if (!reachesTC) continue;
                trajs.push({
                    fromTrackId: trk.track_id,
                    sampleKey: keys[k],
                    points: pts,
                });
            }
        }
        var n = trajs.length;
        if (n === 0) return [];

        // Per-trajectory duration (tau range). Used as the denominator
        // for the SPAN_FRAC check below — the previous version used
        // _GENESIS_TRAJ_HORIZON_H (168 h) globally, but that rejected
        // legitimate same-track matches whenever either trajectory's
        // own tau span was shorter than 0.5 × 168 = 84 h.
        var trajDuration = new Array(n);
        for (var td = 0; td < n; td++) {
            var dPts = trajs[td].points;
            var tauLo = Infinity, tauHi = -Infinity;
            for (var dp = 0; dp < dPts.length; dp++) {
                var dtau = dPts[dp].tau;
                if (dtau == null) continue;
                if (dtau < tauLo) tauLo = dtau;
                if (dtau > tauHi) tauHi = dtau;
            }
            trajDuration[td] = Math.max(0, tauHi - tauLo);
        }

        // Step 2: build a 5°×5° spatial grid index. Each cell stores
        // every (trajectory, point) tuple whose lat/lon falls in it.
        // We also stash tau so the matching step can compute Δt for
        // the time-offset consistency check.
        var CELL = 5;   // degrees
        var grid = {};
        for (var i = 0; i < n; i++) {
            var ipts = trajs[i].points;
            for (var jj = 0; jj < ipts.length; jj++) {
                var pp = ipts[jj];
                if (pp.lat == null || pp.lon == null) continue;
                var ix = Math.floor((pp.lon + 180) / CELL);
                var iy = Math.floor((pp.lat + 90) / CELL);
                var ck = ix + ',' + iy;
                if (!grid[ck]) grid[ck] = [];
                grid[ck].push({
                    trajIdx: i,
                    lat: pp.lat, lon: pp.lon, tau: pp.tau,
                });
            }
        }

        // Step 3: for each A-point, look up nearby grid cells, find
        // close B-points from HIGHER-indexed trajectories (each pair
        // processed once). For each match, accumulate (count, Δt sum,
        // Δt² sum) so we can later derive mean and stdev of the time
        // offset between the two trajectories.
        //
        // Per-A-point dedup so a slow-moving A track with multiple
        // consecutive points near one B point doesn't inflate the
        // count for that pair.
        var matchStats = {};      // pairKey → { n, dtSum, dtSqSum, minTauA, maxTauA }
        var PROX_KM     = _GENESIS_TRAJ_PROX_KM;
        var MIN_MATCH   = _GENESIS_TRAJ_MIN_MATCHES;
        var OFFSET_MAX  = _GENESIS_TRAJ_OFFSET_MAX_H;
        var STD_MAX     = _GENESIS_TRAJ_OFFSET_STD_MAX;
        var SPAN_FRAC   = _GENESIS_TRAJ_SPAN_FRAC_MIN;
        var PROX_KM_SQ  = PROX_KM * PROX_KM;
        var KM_PER_DEG  = 111.0;
        function pairKey(a, b) {
            // a, b ordered: a < b (we only consider that direction
            // in the matching loop, so this stays consistent).
            return a * 10000 + b;
        }
        for (var ia = 0; ia < n; ia++) {
            var aPts = trajs[ia].points;
            for (var ja = 0; ja < aPts.length; ja++) {
                var ap = aPts[ja];
                if (ap.lat == null || ap.lon == null) continue;
                var aix = Math.floor((ap.lon + 180) / CELL);
                var aiy = Math.floor((ap.lat + 90) / CELL);
                var seenForThisPoint = {};
                var apCosLat = Math.cos(ap.lat * Math.PI / 180);
                for (var dx = -1; dx <= 1; dx++) {
                    for (var dy = -1; dy <= 1; dy++) {
                        var bucket = grid[(aix + dx) + ',' + (aiy + dy)];
                        if (!bucket) continue;
                        for (var bi = 0; bi < bucket.length; bi++) {
                            var other = bucket[bi];
                            // Only A < B direction so each pair is
                            // processed once and Δt stats aren't double-
                            // counted with opposing signs.
                            if (other.trajIdx <= ia) continue;
                            if (seenForThisPoint[other.trajIdx]) continue;
                            var dLat = ap.lat - other.lat;
                            var dLon = ap.lon - other.lon;
                            var kmLat = dLat * KM_PER_DEG;
                            var kmLon = dLon * KM_PER_DEG * apCosLat;
                            var d2 = kmLat * kmLat + kmLon * kmLon;
                            if (d2 <= PROX_KM_SQ) {
                                seenForThisPoint[other.trajIdx] = true;
                                var pk = pairKey(ia, other.trajIdx);
                                var dt = other.tau - ap.tau;
                                var rec = matchStats[pk];
                                if (!rec) {
                                    rec = { n: 0, dtSum: 0, dtSqSum: 0,
                                            minTauA: ap.tau, maxTauA: ap.tau };
                                    matchStats[pk] = rec;
                                }
                                rec.n++;
                                rec.dtSum   += dt;
                                rec.dtSqSum += dt * dt;
                                if (ap.tau < rec.minTauA) rec.minTauA = ap.tau;
                                if (ap.tau > rec.maxTauA) rec.maxTauA = ap.tau;
                            }
                        }
                    }
                }
            }
        }

        // Step 4: union-find — merge pairs that pass BOTH the match-
        // count threshold AND the Δt-consistency filter. The latter is
        // what stops two physically distinct storms crossing paths from
        // being lumped together: same-wave members have all matches
        // near one offset (low stdev), unrelated storms have scattered
        // matches (high stdev).
        var parent = new Array(n);
        for (var u = 0; u < n; u++) parent[u] = u;
        function find(x) {
            while (parent[x] !== x) {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            return x;
        }
        function union(a, b) {
            var ra = find(a), rb = find(b);
            if (ra !== rb) parent[ra] = rb;
        }
        Object.keys(matchStats).forEach(function (pkStr) {
            var rec = matchStats[pkStr];
            if (rec.n < MIN_MATCH) return;
            var meanDt = rec.dtSum / rec.n;
            var absDt = Math.abs(meanDt);
            if (absDt > OFFSET_MAX) return;
            var variance = (rec.dtSqSum / rec.n) - meanDt * meanDt;
            var stdDt = Math.sqrt(Math.max(0, variance));
            if (stdDt > STD_MAX) return;
            // Matched-span check: the time range over which the two
            // tracks were close must be a meaningful fraction of the
            // available overlap window. ideal_span derived from the
            // SHORTER of the two trajectories' actual durations (not
            // the global forecast horizon) so members whose forecast
            // tracks are partially clipped (late genesis, early lysis)
            // can still cluster with each other.
            var pk = +pkStr;
            var lo = Math.floor(pk / 10000);
            var hi = pk % 10000;
            var minDuration = Math.min(trajDuration[lo], trajDuration[hi]);
            var idealSpan = Math.max(1, minDuration - absDt);
            var matchedSpan = rec.maxTauA - rec.minTauA;
            if (matchedSpan / idealSpan < SPAN_FRAC) return;
            union(lo, hi);
        });

        // Step 5: group by cluster root + build disturbance bundle.
        var clusters = {};
        for (var ii = 0; ii < n; ii++) {
            var r = find(ii);
            if (!clusters[r]) clusters[r] = [];
            clusters[r].push(trajs[ii]);
        }
        var disturbances = [];
        Object.keys(clusters).forEach(function (rootKey) {
            var cluster = clusters[rootKey];
            if (cluster.length < _GENESIS_CLUSTER_MIN_MEMBERS) return;
            var members = {};
            for (var ci = 0; ci < cluster.length; ci++) {
                members[String(ci)] = { points: cluster[ci].points };
            }
            var meanPts = _genesisMeanTrack(
                cluster.map(function (c) { return c.points; }));
            var peakWind = 0, peakTau = null;
            for (var mi = 0; mi < meanPts.length; mi++) {
                if (meanPts[mi].wind != null && meanPts[mi].wind > peakWind) {
                    peakWind = meanPts[mi].wind;
                    peakTau = meanPts[mi].tau;
                }
            }
            disturbances.push({
                raw: {
                    track_id: 'tca-' + rootKey,
                    members: members,
                    ensemble_mean: { points: meanPts },
                    n_members_total: cluster.length,
                },
                total: cluster.length,
                fraction: cluster.length / _GENESIS_ENSEMBLE_SIZE,
                peakWind: peakWind,
                peakTau: peakTau,
                mean: { points: meanPts },
            });
        });
        disturbances.sort(function (a, b) { return b.fraction - a.fraction; });
        disturbances.forEach(function (d, idx) {
            d.displayLabel = 'Disturbance ' + (idx + 1);
            d.displayShort = 'D' + (idx + 1);
        });
        return disturbances;
    }

    /* TC-ATLAS clustering — DENSITY-PEAK method.
       For each member trajectory that reaches 34 kt, record its first-
       genesis (lat, lon). Bin into a 2D density grid; find local maxima
       (cells whose count ≥ PEAK_MIN_MEMBERS and dominate the 3×3
       neighborhood). Each peak is one Disturbance center; each member
       is then INDEPENDENTLY assigned to its nearest peak within
       ASSIGN_RADIUS_KM. No union-find, no chain-link merges — two
       distinct density peaks remain separate regardless of transit
       members between them. */
    function _genesisTCAtlasDisturbances(rawTracks) {
        if (!rawTracks || !rawTracks.length) return [];

        // Build a basin-wide projection ratio so cluster tooltips can
        // report uncapped formation probabilities instead of the
        // misleading capped count. The global /weatherlab-genesis feed
        // thins each track to 100 members for spaghetti perf — a TCA
        // cluster built on that feed would show "291 of 1000" even
        // when the modal's uncapped re-cluster proves the cluster
        // really has ~700 unique members.
        //
        // We can't simply sum kept × (uncapped / capped) per
        // contributor: DeepMind double-counts samples (one forecast
        // member's trajectory can spawn 2-3 distinct DM track_ids), so
        // that over-counts. The right metric is UNIQUE samples per
        // cluster, projected by the ratio of (true_ensemble_size /
        // unique_samples_in_capped_feed). One basin-wide ratio handles
        // both the thinning AND the across-track dedup.
        var uniqueGlobalCapped = {};
        for (var ti = 0; ti < rawTracks.length; ti++) {
            var mk = rawTracks[ti].members || {};
            var ks = Object.keys(mk);
            for (var kk = 0; kk < ks.length; kk++) uniqueGlobalCapped[ks[kk]] = true;
        }
        var nUniqueGlobal = Object.keys(uniqueGlobalCapped).length;
        // If we've fed the uncapped data in (background prefetch lands
        // ≥95% of the true ensemble), skip the projection and report
        // the raw unique-sample count directly. Otherwise scale by the
        // basin-wide ratio so the capped-feed tooltip is at least
        // first-order correct.
        var isUncapped = nUniqueGlobal >= _GENESIS_ENSEMBLE_SIZE * 0.95;
        var projectionRatio = isUncapped ? 1
            : (nUniqueGlobal > 0
                ? _GENESIS_ENSEMBLE_SIZE / nUniqueGlobal : 1);

        // Step 1: pool member trajectories with first-genesis points.
        var entries = [];
        for (var t = 0; t < rawTracks.length; t++) {
            var trk = rawTracks[t];
            var members = trk.members || {};
            var keys = Object.keys(members);
            for (var k = 0; k < keys.length; k++) {
                var pts = members[keys[k]].points;
                if (!pts || pts.length < 2) continue;
                var first = null;
                for (var p = 0; p < pts.length; p++) {
                    if (pts[p].wind != null && pts[p].wind >= 34
                            && pts[p].lat != null && pts[p].lon != null) {
                        first = pts[p];
                        break;
                    }
                }
                if (!first) continue;
                entries.push({
                    fromTrackId: trk.track_id,
                    sampleKey: keys[k],
                    points: pts,
                    firstLat: first.lat,
                    firstLon: first.lon,
                    firstTau: first.tau,
                });
            }
        }
        if (entries.length === 0) return [];

        // Step 2: bin first-genesis points into a 2D density grid.
        var GRID = _GENESIS_GRID_DEG;
        var density = {};   // "ix,iy" → count
        var cellCenter = {};
        for (var i = 0; i < entries.length; i++) {
            var ix = Math.floor((entries[i].firstLon + 180) / GRID);
            var iy = Math.floor((entries[i].firstLat + 90) / GRID);
            var key = ix + ',' + iy;
            density[key] = (density[key] || 0) + 1;
            if (!cellCenter[key]) {
                cellCenter[key] = {
                    ix: ix, iy: iy,
                    lat: (iy + 0.5) * GRID - 90,
                    lon: (ix + 0.5) * GRID - 180,
                };
            }
        }

        // Step 3: find density peaks — cells with count ≥ threshold
        // that dominate their 3×3 neighborhood. Equal-count adjacencies
        // are resolved by keeping the lexicographically-first key so we
        // don't double-count plateau ridges.
        var peakMin = _GENESIS_PEAK_MIN_MEMBERS;
        var peaks = [];
        Object.keys(density).forEach(function (key) {
            var c = density[key];
            if (c < peakMin) return;
            var cc = cellCenter[key];
            var isPeak = true;
            for (var dx = -1; dx <= 1 && isPeak; dx++) {
                for (var dy = -1; dy <= 1 && isPeak; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    var nk = (cc.ix + dx) + ',' + (cc.iy + dy);
                    var nc = density[nk] || 0;
                    if (nc > c) { isPeak = false; break; }
                    // Plateau tie-break: only keep the cell whose key
                    // sorts first, so a flat ridge yields exactly one peak.
                    if (nc === c && nk < key) { isPeak = false; break; }
                }
            }
            if (isPeak) {
                peaks.push({
                    lat: cc.lat, lon: cc.lon, count: c,
                    ix: cc.ix, iy: cc.iy,
                    meanTau: null,   // filled in below
                });
            }
        });
        if (peaks.length === 0) return [];

        // Step 4: compute each peak's mean first-genesis tau from
        // members whose first-genesis falls IN the peak cell. This
        // gives a robust per-peak time anchor without bootstrapping
        // from a circular cluster definition.
        var GRID_HALF = 0;   // already integral cells, no half offset
        for (var pi = 0; pi < peaks.length; pi++) {
            var pk = peaks[pi];
            var tSum = 0, tN = 0;
            for (var ei = 0; ei < entries.length; ei++) {
                var e = entries[ei];
                var eix = Math.floor((e.firstLon + 180) / GRID);
                var eiy = Math.floor((e.firstLat + 90) / GRID);
                if (eix === pk.ix && eiy === pk.iy
                        && e.firstTau != null) {
                    tSum += e.firstTau;
                    tN++;
                }
            }
            pk.meanTau = tN > 0 ? tSum / tN : null;
        }

        // Step 5: assign each member to the NEAREST peak that
        // satisfies BOTH the spatial gate (≤ ASSIGN_RADIUS_KM) AND
        // the temporal gate (|firstTau − peak.meanTau| ≤
        // TIME_WINDOW_H). Members failing both gates for every peak
        // are dropped.
        var assignR = _GENESIS_ASSIGN_RADIUS_KM;
        var assignR2 = assignR * assignR;
        var timeWin = _GENESIS_TIME_WINDOW_H;
        var clusters = peaks.map(function () { return []; });
        for (var ei2 = 0; ei2 < entries.length; ei2++) {
            var e2 = entries[ei2];
            var bestIdx = -1, bestD2 = Infinity;
            var eCosLat = Math.cos(e2.firstLat * Math.PI / 180);
            for (var pi2 = 0; pi2 < peaks.length; pi2++) {
                var pk2 = peaks[pi2];
                var dLat = (e2.firstLat - pk2.lat) * 111;
                var dLon = (e2.firstLon - pk2.lon) * 111 * eCosLat;
                var d2 = dLat * dLat + dLon * dLon;
                if (d2 > assignR2) continue;
                // Temporal gate — skip when meanTau or firstTau missing
                // (treat as pass so we don't drop members for missing
                // metadata rather than physical incompatibility).
                if (pk2.meanTau != null && e2.firstTau != null) {
                    var dt = Math.abs(e2.firstTau - pk2.meanTau);
                    if (dt > timeWin) continue;
                }
                if (d2 < bestD2) { bestD2 = d2; bestIdx = pi2; }
            }
            if (bestIdx >= 0) {
                clusters[bestIdx].push(e2);
            }
        }

        // Step 5: build disturbance bundle, filter by min cluster size.
        var disturbances = [];
        for (var ci = 0; ci < clusters.length; ci++) {
            var cluster = clusters[ci];
            if (cluster.length < _GENESIS_CLUSTER_MIN_MEMBERS) continue;
            var members = {};
            // Track which DeepMind track_ids contributed members to this
            // cluster — the modal needs this to fetch uncapped per-track
            // data from the backend (the global /weatherlab-genesis feed
            // caps each track to 100 members for spaghetti perf, so the
            // capped cluster size we display here is a fraction of the
            // true membership we could show in the detail view).
            var contribTrackIds = {};
            for (var mi = 0; mi < cluster.length; mi++) {
                members[String(mi)] = { points: cluster[mi].points };
                var src = cluster[mi].fromTrackId;
                if (src != null) {
                    contribTrackIds[src] = (contribTrackIds[src] || 0) + 1;
                }
            }
            var meanPts = _genesisMeanTrack(
                cluster.map(function (c) { return c.points; }));
            var peakWind = 0, peakTau = null;
            for (var mp = 0; mp < meanPts.length; mp++) {
                if (meanPts[mp].wind != null && meanPts[mp].wind > peakWind) {
                    peakWind = meanPts[mp].wind;
                    peakTau = meanPts[mp].tau;
                }
            }
            var pk = peaks[ci];
            // Count UNIQUE forecast members in the cluster (dedup across
            // DeepMind track_ids — a single forecast member often spawns
            // multiple DM track_ids), then project up by the basin-wide
            // cap ratio. Clamp at the ensemble size as a safety rail.
            var uniqueInCluster = {};
            for (var ui = 0; ui < cluster.length; ui++) {
                uniqueInCluster[cluster[ui].sampleKey] = true;
            }
            var nUniqueInCluster = Object.keys(uniqueInCluster).length;
            var projectedTotal = Math.min(
                _GENESIS_ENSEMBLE_SIZE,
                Math.round(nUniqueInCluster * projectionRatio)
            );
            disturbances.push({
                raw: {
                    track_id: 'tca-' + ci,
                    members: members,
                    ensemble_mean: { points: meanPts },
                    n_members_total: projectedTotal,
                },
                total: projectedTotal,
                fraction: projectedTotal / _GENESIS_ENSEMBLE_SIZE,
                peakWind: peakWind,
                peakTau: peakTau,
                mean: { points: meanPts },
                // Cluster geometry — replayed in the modal to re-apply the
                // identical spatial+temporal gate against uncapped data.
                peakLat: pk.lat,
                peakLon: pk.lon,
                peakMeanTau: pk.meanTau,
                gateRadiusKm: _GENESIS_ASSIGN_RADIUS_KM,
                gateTimeH: _GENESIS_TIME_WINDOW_H,
                contribTrackIds: contribTrackIds,
                cappedTotal: cluster.length,   // for debugging/telemetry
            });
        }
        disturbances.sort(function (a, b) { return b.fraction - a.fraction; });
        disturbances.forEach(function (d, idx) {
            d.displayLabel = 'Disturbance ' + (idx + 1);
            d.displayShort = 'D' + (idx + 1);
        });
        return disturbances;
    }

    // Method dispatcher — single entry point so the render functions
    // don't have to branch on cluster method themselves. TC-ATLAS
    // prefers the server-precomputed clusters (instant, accurate).
    // Falls back to client-side clustering on capped data if the
    // precomputed endpoint hasn't returned yet (initial flicker on
    // first page load is the only time this fallback runs).
    function _genesisDisturbances(rawTracks) {
        if (_genesisClusterMethod === 'tcatlas') {
            var pc = _rtGenesisClusters;
            var initOk = pc && _rtGenesisData
                && pc.init_time === _rtGenesisData.init_time
                && _genesisClusterParamsMatch(pc.params);
            if (initOk) {
                return pc.clusters.map(_genesisServerClusterToDisturbance);
            }
            return _genesisTCAtlasDisturbances(rawTracks);
        }
        return _genesisQualifyingDisturbances(rawTracks);
    }

    // Current tuner params used by the active TCA computation. Sent to
    // the backend so user adjustments trigger a server recompute. The
    // defaults match the _GENESIS_* constants so the steady-state
    // request is always the same string → backend cache hit ~100% of
    // the time for the default-param result.
    function _genesisCurrentClusterParams() {
        return {
            grid_deg: _GENESIS_GRID_DEG,
            peak_min_members: _GENESIS_PEAK_MIN_MEMBERS,
            assign_radius_km: _GENESIS_ASSIGN_RADIUS_KM,
            time_window_h: _GENESIS_TIME_WINDOW_H,
            cluster_min_members: _GENESIS_CLUSTER_MIN_MEMBERS,
        };
    }

    function _genesisClusterParamsMatch(pcParams) {
        if (!pcParams) return false;
        var cur = _genesisCurrentClusterParams();
        return pcParams.grid_deg === cur.grid_deg
            && pcParams.peak_min_members === cur.peak_min_members
            && pcParams.assign_radius_km === cur.assign_radius_km
            && pcParams.time_window_h === cur.time_window_h
            && pcParams.cluster_min_members === cur.cluster_min_members;
    }

    // Convert one server-side cluster object into the disturbance shape
    // the rest of the modal/Global-Map code expects.
    function _genesisServerClusterToDisturbance(c) {
        return {
            raw: {
                track_id: c.track_id,
                members: c.members,
                ensemble_mean: c.ensemble_mean,
                n_members_total: c.n_members_total,
            },
            total: c.n_members_total,
            fraction: c.fraction,
            peakWind: c.peak_wind,
            peakTau: c.peak_tau,
            mean: c.ensemble_mean,
            peakLat: c.peak_lat,
            peakLon: c.peak_lon,
            peakMeanTau: c.peak_mean_tau,
            gateRadiusKm: c.gate_radius_km,
            gateTimeH: c.gate_time_h,
            contribTrackIds: c.contrib_track_ids,
            displayLabel: c.display_label,
            displayShort: c.display_short,
            cappedTotal: c.capped_total,
        };
    }

    function _renderGenesis() {
        _clearGenesis();
        _genesisDisturbanceMeta = {};
        if (!_rtGenesisData || !map) return;
        var tracks = _rtGenesisData.tracks || [];
        if (tracks.length === 0) return;

        var disturbances = _genesisDisturbances(tracks);
        if (disturbances.length === 0) return;

        // Re-label disturbances that overlap an officially-tracked
        // ATCF storm. After this call, d.displayLabel may be "TD 01W"
        // / "Invest 90W" / "Bonnie" instead of "Disturbance N", with
        // the matched storm cached on d.atcfMatch for the modal.
        _genesisApplyActiveStormMatches(disturbances, stormData);
        // Re-render active-storm markers so matched ATCF systems get
        // their (now redundant) pin suppressed. If renderStormMarkers
        // was already called by pollActiveStorms moments ago, this is
        // a quick re-pass with the updated _genesisMatchedAtcfIds set.
        if (typeof renderStormMarkers === 'function' && stormData) {
            try { renderStormMarkers(stormData); } catch (e) { /* non-fatal */ }
        }

        for (var di = 0; di < disturbances.length; di++) {
            var d = disturbances[di];
            var trackId = d.raw.track_id || '';
            var mean = d.mean;
            if (!mean.points || mean.points.length === 0) continue;

            var style = _genesisCatStyle(d.peakWind);
            var pctText = (d.fraction * 100).toFixed(0) + '%';

            // Stash for the modal. We include the raw member dict and
            // ensemble mean so the detail modal can render straight
            // from this cache without a backend round-trip. Required
            // for the TC-ATLAS clustering path (whose synthetic tca-N
            // IDs don't exist in DeepMind's CSV) and useful as a
            // fallback for the DeepMind path if the per-track endpoint
            // isn't deployed yet.
            _genesisDisturbanceMeta[trackId] = {
                label: d.displayLabel,
                short: d.displayShort,
                atcfMatch: d.atcfMatch || null,
                atcfLabel: d.atcfLabel || null,
                fraction: d.fraction,
                fractionText: pctText,
                peakWind: d.peakWind,
                peakTau: d.peakTau,
                peakCat: style.cat,
                peakColor: style.bold,
                totalMembers: d.total,
                members: d.raw && d.raw.members,
                ensembleMean: d.raw && d.raw.ensemble_mean,
                source: _genesisClusterMethod,   // 'deepmind' or 'tcatlas'
                initTime: (_rtGenesisData && _rtGenesisData.init_time) || null,
                // TCA-only fields — let the detail modal fetch uncapped
                // data from each contributing DM track endpoint and
                // re-apply the identical density-peak gate.
                peakLat: d.peakLat,
                peakLon: d.peakLon,
                peakMeanTau: d.peakMeanTau,
                gateRadiusKm: d.gateRadiusKm,
                gateTimeH: d.gateTimeH,
                contribTrackIds: d.contribTrackIds,
            };

            // ONE marker per disturbance instead of N member polylines.
            // Placed at the ensemble-mean genesis (or current) position.
            // Sized by formation probability (more confident → bigger);
            // colored by predicted peak Vmax. Label "D1" / "D2" baked
            // into a divIcon so the user can scan the basin and see
            // "WPac has a strong D1 (C2 peak), Atlantic has a weak D3
            // (TD only)" without clicking.
            var p0 = mean.points[0];
            // Confidence scales 50 → 1000 members onto 14 → 28 px.
            var baseSize = 14 + Math.min(14, Math.round((d.fraction - 0.05) * 18));
            var html =
                '<div class="rt-gen-marker" style="background:' + style.bold + ';'
                + 'width:' + baseSize + 'px;height:' + baseSize + 'px;line-height:'
                + baseSize + 'px;font-size:' + Math.max(9, Math.round(baseSize * 0.5))
                + 'px;">' + d.displayShort + '</div>';
            var icon = L.divIcon({
                html: html, className: 'rt-gen-divicon',
                iconSize: [baseSize, baseSize],
                iconAnchor: [baseSize / 2, baseSize / 2],
            });
            var marker = L.marker([p0.lat, p0.lon], {
                icon: icon, interactive: true, bubblingMouseEvents: false,
                riseOnHover: true, riseOffset: 800,
            }).addTo(map);

            var tip = '<div style="min-width:180px;">'
                + '<b>' + d.displayLabel + '</b>'
                + '<br>Formation probability: <strong>' + pctText + '</strong>'
                + ' <span style="opacity:0.7;">(' + d.total + ' of '
                + _GENESIS_ENSEMBLE_SIZE + ' members)</span>'
                + '<br>Predicted peak Vmax: <strong style="color:' + style.bold
                + ';">' + d.peakWind.toFixed(0) + ' kt · ' + style.cat
                + '</strong>'
                + (d.peakTau != null ? ' at +' + d.peakTau + 'h' : '')
                + '<br><span style="opacity:0.75; font-size:0.85em;">'
                + 'Click for full 1000-member detail →</span>'
                + '</div>';
            marker.bindTooltip(tip, { direction: 'top', offset: [0, -8] });
            (function (id) {
                marker.on('click', function (e) {
                    if (L.DomEvent && L.DomEvent.stopPropagation) {
                        L.DomEvent.stopPropagation(e);
                    }
                    openGenesisDetail(id);
                });
            })(trackId);
            _rtGenesisLayers.push(marker);

            // Thin ensemble-mean line so the forecaster can see the
            // predicted track at a glance without opening the detail
            // modal. No per-member spaghetti — that's what made the
            // layer chaotic; details live in the modal.
            if (mean.points.length >= 2) {
                var meanLatLngs = [];
                for (var mj = 0; mj < mean.points.length; mj++) {
                    meanLatLngs.push([mean.points[mj].lat, mean.points[mj].lon]);
                }
                var meanSegs = splitAtAntimeridian(meanLatLngs);
                for (var ms = 0; ms < meanSegs.length; ms++) {
                    if (meanSegs[ms].length < 2) continue;
                    var meanLine = L.polyline(meanSegs[ms], {
                        color: style.bold, weight: 1.8, opacity: 0.85,
                        dashArray: '4,3',
                        interactive: true, bubblingMouseEvents: false,
                    }).addTo(map);
                    (function (id) {
                        meanLine.on('click', function (e) {
                            if (L.DomEvent && L.DomEvent.stopPropagation) {
                                L.DomEvent.stopPropagation(e);
                            }
                            openGenesisDetail(id);
                        });
                    })(trackId);
                    _rtGenesisLayers.push(meanLine);
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GENESIS-TRACK DETAIL MODAL (full 1000-member view)
    // ═══════════════════════════════════════════════════════════
    //  Click any genesis spaghetti track → fetches /weatherlab-genesis/
    //  {track_id} for the FULL member set and renders two Plotly
    //  figures matching the colleague's matplotlib reference:
    //    1. Basin scattergeo: mean track (intensity-colored markers)
    //       on top of a 1000-member point cloud also colored by intensity
    //    2. Time series: per-member Vmax(t) scatter + mean line +
    //       ±0.5σ / ±1σ / ±2.5σ ribbons
    //
    //  The modal scaffolding mirrors rt-evo-modal — a single absolute-
    //  positioned overlay built lazily on first open.

    var _genesisDetailCache = {};   // track_id → JSON (TCA-synthesized or DM-fetched)
    // Countdown chip state for the disturbance detail modal. The chip
    // shows "next cycle in ~Xh Ym" derived from the backend's
    // `next_cycle_eta_hours` (estimated DeepMind publish time = cycle
    // init + 6h cadence + ~3h publish lag) and re-renders every 30 s
    // until the modal closes.
    var _genesisCycleEtaTimer = null;
    var _genesisCycleEtaTargetMs = null;
    // Per-DM-track full (uncapped) responses, keyed by DM track_id.
    // Shared by the TCA re-cluster path (which needs every contributing
    // track) and the DM detail path (which fetches one). One round-trip
    // per DM track even if multiple TCA clusters draw from it.
    var _genesisDmTrackCache = {};   // DM track_id → Promise<JSON>
    var _GENESIS_MODAL_ID = 'rt-genesis-detail-modal';
    // How far from the median first-genesis position we consider a member
    // to be a "cross-basin outlier" for the DeepMind detail modal. DM's
    // per-cycle tracker reuses numeric track_ids across ensemble members,
    // so the same track_id can collect a few members whose physical storm
    // is in a completely different basin (verified empirically: WPac
    // track 1 contains 8 EPac members + 1 Gulf-of-Mexico member out of
    // 410). 1500 km is wider than any single storm's first-genesis spread
    // we've seen, narrow enough to drop genuine cross-basin orphans.
    var _GENESIS_DM_OUTLIER_KM = 1500;

    // Fetch one DeepMind track's full uncapped member set. Cached so
    // re-opening clusters that share a contributor doesn't re-hit the
    // backend.
    function _fetchDmTrack(dmTrackId) {
        var key = String(dmTrackId);
        if (_genesisDmTrackCache[key]) return _genesisDmTrackCache[key];
        var p = fetch(API_BASE + '/ir-monitor/weatherlab-genesis/'
                + encodeURIComponent(key), { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            });
        _genesisDmTrackCache[key] = p;
        return p;
    }

    // Re-cluster a TCA disturbance against the FULL uncapped member set
    // by fetching each contributing DM track and replaying the same
    // spatial+temporal gate that the Global Map's clustering used. The
    // capped global feed limits each DM track to 100 members for
    // spaghetti perf, which artificially deflates cluster sizes in the
    // detail view (a Yap cluster that absorbs 998 unique members on full
    // data only shows 291 when each contributor is stride-thinned). Two
    // round-trips per TCA cluster open in the common case.
    function _fetchAndReclusterTCA(trackId, meta) {
        var contribIds = Object.keys(meta.contribTrackIds || {});
        if (contribIds.length === 0) {
            return Promise.reject(new Error('no contributing DM tracks'));
        }
        var fetches = contribIds.map(function (id) { return _fetchDmTrack(id); });
        return Promise.all(fetches).then(function (responses) {
            // Dedupe across contributing DM tracks BY SAMPLE ID. DeepMind
            // can label the same forecast member's trajectory under
            // multiple track_ids (the tracker treats it as multiple
            // storms), so the same sample can pass the gate from several
            // contributors. We want one entry per unique forecast member
            // — keep the candidate whose first-genesis is closest to the
            // cluster peak (that's the genesis event most clearly
            // belonging to this disturbance).
            var best = {};   // sampleId → { dist2, points }
            var peakLat = meta.peakLat;
            var peakLon = meta.peakLon;
            var peakMeanTau = meta.peakMeanTau;
            var radius = meta.gateRadiusKm;
            var radius2 = radius * radius;
            var timeWin = meta.gateTimeH;
            var initTime = null;
            for (var ri = 0; ri < responses.length; ri++) {
                var resp = responses[ri];
                if (!initTime) initTime = resp.init_time || null;
                var srcMembers = resp.members || {};
                var keys = Object.keys(srcMembers);
                for (var ki = 0; ki < keys.length; ki++) {
                    var sampleId = keys[ki];
                    var pts = srcMembers[sampleId].points;
                    if (!pts || pts.length < 2) continue;
                    var first = null;
                    for (var pi = 0; pi < pts.length; pi++) {
                        if (pts[pi].wind != null && pts[pi].wind >= 34
                                && pts[pi].lat != null && pts[pi].lon != null) {
                            first = pts[pi]; break;
                        }
                    }
                    if (!first) continue;
                    var cosLat = Math.cos(first.lat * Math.PI / 180);
                    var dLat = (first.lat - peakLat) * 111;
                    var dLon = (first.lon - peakLon) * 111 * cosLat;
                    var d2 = dLat * dLat + dLon * dLon;
                    if (d2 > radius2) continue;
                    if (peakMeanTau != null && first.tau != null) {
                        if (Math.abs(first.tau - peakMeanTau) > timeWin) continue;
                    }
                    if (!best[sampleId] || d2 < best[sampleId].dist2) {
                        best[sampleId] = { dist2: d2, points: pts };
                    }
                }
            }
            var members = {};
            var sampleKeys = Object.keys(best);
            for (var sk = 0; sk < sampleKeys.length; sk++) {
                members[sampleKeys[sk]] = { points: best[sampleKeys[sk]].points };
            }
            var memArrays = sampleKeys.map(function (k) { return best[k].points; });
            return {
                model: 'DeepMind FNV3 LARGE_ENSEMBLE',
                init_time: initTime || meta.initTime,
                track_id: trackId,
                n_members: sampleKeys.length,
                members: members,
                ensemble_mean: { points: _genesisMeanTrack(memArrays) },
                _source: 'tcatlas',
                _uncapped: true,
            };
        });
    }

    // Drop members whose first-genesis position lies > _GENESIS_DM_OUTLIER_KM
    // from the median first-genesis lat/lon. Only used for the DeepMind
    // detail path — TCA clusters are already gated tightly during build.
    // Returns { json, excluded } where json is a shallow-clone with a
    // filtered members dict (or the original if nothing was excluded).
    function _filterDmOutliers(json) {
        var members = json.members || {};
        var keys = Object.keys(members);
        var firsts = [];
        for (var i = 0; i < keys.length; i++) {
            var pts = members[keys[i]].points || [];
            for (var j = 0; j < pts.length; j++) {
                if (pts[j].wind != null && pts[j].wind >= 34
                        && pts[j].lat != null && pts[j].lon != null) {
                    firsts.push({ key: keys[i], lat: pts[j].lat, lon: pts[j].lon });
                    break;
                }
            }
        }
        if (firsts.length < 5) return { json: json, excluded: 0 };
        var lats = firsts.map(function (f) { return f.lat; }).sort(function (a, b) { return a - b; });
        var lons = firsts.map(function (f) { return f.lon; }).sort(function (a, b) { return a - b; });
        var medLat = lats[Math.floor(lats.length / 2)];
        var medLon = lons[Math.floor(lons.length / 2)];
        var keep = {};
        var excluded = 0;
        var keptKeysWithFirst = {};
        for (var k = 0; k < firsts.length; k++) {
            var f = firsts[k];
            var d = _genesisHaversineKm(f.lat, f.lon, medLat, medLon);
            if (d <= _GENESIS_DM_OUTLIER_KM) {
                keep[f.key] = members[f.key];
                keptKeysWithFirst[f.key] = true;
            } else {
                excluded++;
            }
        }
        // Members that never reach 34 kt have no first-genesis — keep
        // them (they're already invisible to the genesis map/histogram).
        for (var kk = 0; kk < keys.length; kk++) {
            if (!keptKeysWithFirst[keys[kk]]
                    && !firsts.some(function (f) { return f.key === keys[kk]; })) {
                keep[keys[kk]] = members[keys[kk]];
            }
        }
        if (excluded === 0) return { json: json, excluded: 0 };
        // Rebuild ensemble mean from kept members so the modal's mean
        // line doesn't get pulled toward the discarded outliers.
        var keptArrays = Object.keys(keep).map(function (k) {
            return keep[k].points;
        });
        var clone = {};
        for (var key in json) {
            if (Object.prototype.hasOwnProperty.call(json, key)) clone[key] = json[key];
        }
        clone.members = keep;
        clone.n_members = Object.keys(keep).length;
        clone.ensemble_mean = { points: _genesisMeanTrack(keptArrays) };
        return { json: clone, excluded: excluded };
    }

    function _ensureGenesisDetailModal() {
        var m = document.getElementById(_GENESIS_MODAL_ID);
        if (m) return m;
        m = document.createElement('div');
        m.id = _GENESIS_MODAL_ID;
        m.className = 'rt-genesis-modal';
        m.style.display = 'none';
        m.innerHTML =
            '<div class="rt-genesis-modal-content">' +
              '<div class="rt-genesis-modal-header">' +
                '<div>' +
                  '<h2 id="rt-genesis-modal-title">DeepMind genesis ensemble</h2>' +
                  '<p id="rt-genesis-modal-sub"></p>' +
                '</div>' +
                '<div style="display:flex; align-items:center; gap:8px;">' +
                  // Shown only when the disturbance is paired with an
                  // active ATCF storm — opens that storm's IR satellite
                  // detail page so the user can see real-time imagery
                  // alongside the FNV3 ensemble diagnostics.
                  '<button type="button" id="rt-genesis-open-storm" class="rt-genesis-modal-open-storm" style="display:none;" title="View this storm\'s IR / GeoColor satellite detail page">→ IR Detail</button>' +
                  '<button type="button" id="rt-genesis-summary-save" class="rt-genesis-modal-summary-save" title="Save 3-panel summary PNG (map + intensity + genesis time)">⤓ Summary PNG</button>' +
                  '<button type="button" class="rt-genesis-modal-close" aria-label="Close" title="Close (Esc)">×</button>' +
                '</div>' +
              '</div>' +
              // Headline stats — pre-genesis-specific metrics the named-
              // storm panel never has to compute (formation probability,
              // P10/P50/P90 peak Vmax, most-likely genesis time).
              '<div id="rt-genesis-modal-stats" class="rt-genesis-stat-row"></div>' +
              // Sticky jump-nav — makes the existence of the intensity
              // envelope and genesis-time histogram discoverable without
              // relying on the scrollbar (the panels live below the
              // fold for most viewport sizes).
              '<div id="rt-genesis-jump-nav" class="rt-genesis-jump-nav" role="tablist">' +
                '<span class="rt-genesis-jump-label">Jump to:</span>' +
                '<button type="button" class="rt-genesis-jump-btn active" data-target="rt-genesis-jump-tracks">Tracks</button>' +
                '<button type="button" class="rt-genesis-jump-btn" data-target="rt-genesis-jump-intensity">Intensity envelope</button>' +
                '<button type="button" class="rt-genesis-jump-btn" data-target="rt-genesis-jump-gtime">Genesis-time histogram</button>' +
              '</div>' +
              '<div class="rt-genesis-modal-body">' +
                // Forecast-hour scrubber — drives the map's "members at
                // tau=t" overlay and the intensity time-series cursor.
                // Same control pattern as the Global Map's IR scrubber
                // (◀ play ▶ ■ + range + monospace tau label).
                '<div class="rt-genesis-tau-bar" style="display:flex; align-items:center; gap:10px; padding:8px 4px; margin-bottom:6px;">' +
                  '<button type="button" id="rt-genesis-tau-prev" class="rt-genesis-tau-btn" title="Previous step (6 h)">&#9664;</button>' +
                  '<button type="button" id="rt-genesis-tau-play" class="rt-genesis-tau-btn" title="Play / pause">&#9654;</button>' +
                  '<button type="button" id="rt-genesis-tau-next" class="rt-genesis-tau-btn" title="Next step (6 h)">&#9654;</button>' +
                  '<button type="button" id="rt-genesis-tau-stop" class="rt-genesis-tau-btn" title="Reset to median genesis time">&#9632;</button>' +
                  '<input type="range" id="rt-genesis-tau-slider" min="0" max="0" value="0" step="1" ' +
                  'style="flex:1; min-width:160px;" title="Forecast hour — drag to see member positions and intensity at this tau">' +
                  '<span id="rt-genesis-tau-label" style="font-family:monospace; min-width:90px; text-align:right; opacity:0.85;">+0 h</span>' +
                  '<div class="rt-genesis-mode-toggle" role="group" title="Render member positions as a density field or as individual markers">' +
                    '<button type="button" id="rt-genesis-mode-density" class="rt-genesis-mode-btn active">Density</button>' +
                    '<button type="button" id="rt-genesis-mode-members" class="rt-genesis-mode-btn">Members</button>' +
                  '</div>' +
                '</div>' +
                // Density-mode key — sits BETWEEN the scrubber row and
                // the map so it doesn\'t compete with the in-map lat
                // axis labels for the top-left corner. Hidden in
                // Members mode (display: none).
                '<div id="rt-genesis-density-key" class="rt-genesis-density-key" style="display:none;"></div>' +
                '<div id="rt-genesis-jump-tracks" class="rt-genesis-modal-chart-wrap" style="position:relative;">' +
                  '<button type="button" id="rt-genesis-map-save" class="rt-genesis-modal-save" title="Save track map as PNG">⤓ PNG</button>' +
                  '<div id="rt-genesis-modal-map" style="width:100%; height:480px;"></div>' +
                '</div>' +
                '<div id="rt-genesis-jump-intensity" class="rt-genesis-modal-chart-wrap" style="position:relative; margin-top:14px;">' +
                  '<button type="button" id="rt-genesis-int-save" class="rt-genesis-modal-save" title="Save intensity time series as PNG">⤓ PNG</button>' +
                  '<div id="rt-genesis-modal-int" style="width:100%; height:300px;"></div>' +
                '</div>' +
                // Unique-to-pre-genesis: histogram of when each member
                // first reaches 34 kt. Useful for the "when does it
                // form?" question a named-storm view never has to ask.
                '<div id="rt-genesis-jump-gtime" class="rt-genesis-modal-chart-wrap" style="position:relative; margin-top:14px;">' +
                  '<button type="button" id="rt-genesis-gtime-save" class="rt-genesis-modal-save" title="Save genesis-time histogram as PNG">⤓ PNG</button>' +
                  '<div id="rt-genesis-modal-gtime" style="width:100%; height:180px;"></div>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(m);
        m.addEventListener('click', function (e) {
            if (e.target === m) closeGenesisDetail();
        });
        m.querySelector('.rt-genesis-modal-close')
            .addEventListener('click', closeGenesisDetail);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && m.style.display !== 'none') {
                closeGenesisDetail();
            }
        });
        m.querySelector('#rt-genesis-map-save').addEventListener('click', function () {
            _genesisSavePNG('rt-genesis-modal-map', 'tracks');
        });
        m.querySelector('#rt-genesis-int-save').addEventListener('click', function () {
            _genesisSavePNG('rt-genesis-modal-int', 'intensity');
        });
        m.querySelector('#rt-genesis-gtime-save').addEventListener('click', function () {
            _genesisSavePNG('rt-genesis-modal-gtime', 'genesis-time');
        });
        m.querySelector('#rt-genesis-summary-save').addEventListener('click', function () {
            _genesisSaveSummaryPNG();
        });
        // "→ IR Detail" — jumps to the matched ATCF storm's satellite
        // page. atcfId is stored on the button by _renderGenesisDetail
        // every time the modal opens with new data.
        m.querySelector('#rt-genesis-open-storm').addEventListener('click', function () {
            var atcfId = this.getAttribute('data-atcf-id');
            if (!atcfId || typeof window._irOpenStorm !== 'function') return;
            closeGenesisDetail();
            window._irOpenStorm(atcfId);
        });

        // Jump-nav: smooth-scroll the modal's scroll container to the
        // requested chart-wrap, and keep the active button highlighted
        // as the user scrolls through panels. The scroll container is
        // .rt-genesis-modal-content (the element with overflow:auto),
        // not the modal backdrop itself.
        var scroller = m.querySelector('.rt-genesis-modal-content');
        var jumpBtns = m.querySelectorAll('.rt-genesis-jump-btn');
        jumpBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var targetId = btn.getAttribute('data-target');
                var target = m.querySelector('#' + targetId);
                if (!target || !scroller) return;
                // getBoundingClientRect deltas survive the modal's
                // own absolute positioning. Pull the target's top into
                // the scroller, then subtract sticky-nav height so the
                // panel doesn't slide under the bar.
                var nav = m.querySelector('#rt-genesis-jump-nav');
                var navH = nav ? nav.offsetHeight : 0;
                var srect = scroller.getBoundingClientRect();
                var trect = target.getBoundingClientRect();
                var delta = (trect.top - srect.top) + scroller.scrollTop - navH - 8;
                scroller.scrollTo({ top: delta, behavior: 'smooth' });
            });
        });
        if ('IntersectionObserver' in window && scroller) {
            var setActive = function (id) {
                jumpBtns.forEach(function (b) {
                    b.classList.toggle('active',
                                       b.getAttribute('data-target') === id);
                });
            };
            var io = new IntersectionObserver(function (entries) {
                // Pick the highest-visibility entry currently in view.
                var best = null;
                entries.forEach(function (e) {
                    if (!best || e.intersectionRatio > best.intersectionRatio) {
                        best = e;
                    }
                });
                if (best && best.isIntersecting) {
                    setActive(best.target.id);
                }
            }, { root: scroller, threshold: [0.25, 0.5, 0.75] });
            ['rt-genesis-jump-tracks', 'rt-genesis-jump-intensity',
             'rt-genesis-jump-gtime'].forEach(function (id) {
                var el = m.querySelector('#' + id);
                if (el) io.observe(el);
            });
        }
        return m;
    }

    function closeGenesisDetail() {
        var m = document.getElementById(_GENESIS_MODAL_ID);
        if (!m) return;
        m.style.display = 'none';
        document.body.style.overflow = '';
        if (_genesisTauState && _genesisTauState.animTimer) {
            clearInterval(_genesisTauState.animTimer);
            _genesisTauState.animTimer = null;
            _genesisTauState.playing = false;
        }
        if (_genesisCycleEtaTimer) {
            clearInterval(_genesisCycleEtaTimer);
            _genesisCycleEtaTimer = null;
        }
        _genesisCycleEtaTargetMs = null;
        _ga('rt_genesis_detail_close');
    }
    window.closeGenesisDetail = closeGenesisDetail;

    function openGenesisDetail(trackId) {
        var m = _ensureGenesisDetailModal();
        var titleEl = m.querySelector('#rt-genesis-modal-title');
        var subEl   = m.querySelector('#rt-genesis-modal-sub');
        // Use the "Disturbance N" name from the Global Map render so
        // the modal header matches the marker the user clicked.
        var meta = _genesisDisturbanceMeta[trackId];
        var titleName = meta ? meta.label : ('Genesis track ' + trackId);
        titleEl.textContent = titleName + ' · FNV3 1000-member ensemble';
        subEl.innerHTML = 'Loading 1000 ensemble members…';
        m.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        _ga('rt_genesis_detail_open', { track_id: trackId });

        // Source-aware loader:
        //   • TC-ATLAS clusters (tca-N) — use the cached member set
        //     directly. There's no backend route for our synthetic IDs.
        //   • DeepMind track_ids — try the full 1000-member backend
        //     endpoint first; if it's not deployed (404/network error),
        //     fall back to the thinned member set already loaded for
        //     the Global Map render. Thinned ≠ full, but better than
        //     "Loading…" forever.
        var meta = _genesisDisturbanceMeta[trackId];
        var cachedFull = _genesisDetailCache[trackId];

        function _fromCache() {
            // Build a backend-shaped response from the cluster cache.
            return {
                model: 'DeepMind FNV3 LARGE_ENSEMBLE',
                init_time: meta && meta.initTime,
                track_id: trackId,
                n_members: meta ? Object.keys(meta.members || {}).length : 0,
                members: (meta && meta.members) || {},
                ensemble_mean: (meta && meta.ensembleMean) || { points: [] },
                _source: meta ? meta.source : null,
                _fromCache: true,
            };
        }

        var prom;
        if (cachedFull) {
            prom = Promise.resolve(cachedFull);
        } else if (trackId && trackId.indexOf('tca-') === 0) {
            // TC-ATLAS path — hit the per-cluster server endpoint which
            // returns the precomputed dedup'd member trajectories from
            // the same cached cluster the index endpoint built. One
            // request, no client clustering. Fall back to the legacy
            // per-track re-cluster path if the new endpoint 404s
            // (e.g. cycle rolled mid-session and cache invalidated).
            var clusterParams = _genesisCurrentClusterParams();
            var qsParts = Object.keys(clusterParams).map(function (k) {
                return k + '=' + encodeURIComponent(clusterParams[k]);
            });
            prom = fetch(API_BASE + '/ir-monitor/weatherlab-genesis-cluster/'
                    + encodeURIComponent(trackId) + '?' + qsParts.join('&'),
                    { cache: 'no-store' })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (json) {
                    json._source = 'tcatlas';
                    json._uncapped = true;
                    _genesisDetailCache[trackId] = json;
                    return json;
                })
                .catch(function (err) {
                    if (meta && meta.contribTrackIds && meta.peakLat != null) {
                        console.warn('[Genesis] TCA cluster endpoint failed, '
                            + 'falling back to per-track re-cluster:',
                            err.message);
                        return _fetchAndReclusterTCA(trackId, meta);
                    }
                    if (meta && meta.members) return _fromCache();
                    throw err;
                });
        } else {
            // DeepMind path — fetch full member set, then drop cross-
            // basin outliers (DM track_ids aren't spatially coherent
            // across ensemble members; the same numeric ID gets reused
            // on unrelated storms).
            prom = fetch(API_BASE + '/ir-monitor/weatherlab-genesis/'
                    + encodeURIComponent(trackId),
                    { cache: 'no-store' })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (json) {
                    var filtered = _filterDmOutliers(json);
                    filtered.json._dmExcluded = filtered.excluded;
                    _genesisDetailCache[trackId] = filtered.json;
                    return filtered.json;
                })
                .catch(function (err) {
                    if (meta && meta.members) {
                        console.warn('[Genesis] detail endpoint failed, '
                            + 'using cached thinned members:', err.message);
                        return _fromCache();
                    }
                    throw err;
                });
        }

        prom.then(function (json) {
            _renderGenesisDetail(json);
        }).catch(function (err) {
            subEl.innerHTML = '<span style="color:#ef4444;">'
                + 'Could not load detail: ' + (err.message || err) + '</span>';
        });
    }
    window.openGenesisDetail = openGenesisDetail;

    // Format a remaining-ms duration as "~Xh Ym" / "~Mm" / "<1m".
    function _formatEtaShort(ms) {
        if (ms == null || !isFinite(ms)) return '';
        if (ms <= 0) return 'imminent';
        var totalMin = Math.round(ms / 60000);
        if (totalMin < 1) return '<1m';
        if (totalMin < 60) return '~' + totalMin + 'm';
        var h = Math.floor(totalMin / 60);
        var mn = totalMin % 60;
        return mn === 0 ? '~' + h + 'h' : '~' + h + 'h ' + mn + 'm';
    }

    // Re-render the countdown chip from _genesisCycleEtaTargetMs. Called
    // once on modal open and every 30 s thereafter until close.
    function _tickGenesisCycleEta() {
        var el = document.getElementById('rt-genesis-cycle-eta');
        if (!el || _genesisCycleEtaTargetMs == null) return;
        var remain = _genesisCycleEtaTargetMs - Date.now();
        if (remain > 0) {
            el.innerHTML = '<span style="opacity:0.8;">Next cycle '
                + _formatEtaShort(remain) + '</span>';
            el.title = 'DeepMind FNV3 publishes ~3 h after each 6-hourly '
                + 'init (00/06/12/18 UTC). Estimated, not guaranteed.';
        } else {
            el.innerHTML = '<span style="color:#00e5ff;">'
                + 'Next cycle due — checking…</span>';
            el.title = 'Past expected publish time. The backend probes '
                + 'every request; reopen this disturbance to pick it up.';
        }
    }

    // Schedule the countdown ticker for the disturbance detail modal.
    // Computes the publish target (server's fetched_at + eta) so clock
    // drift between user and server doesn't matter once the page is open.
    function _startGenesisCycleEta(nextEtaH, fetchedAtIso) {
        if (_genesisCycleEtaTimer) {
            clearInterval(_genesisCycleEtaTimer);
            _genesisCycleEtaTimer = null;
        }
        _genesisCycleEtaTargetMs = null;
        if (nextEtaH == null || !isFinite(nextEtaH)) return;
        var baseMs;
        if (fetchedAtIso) {
            var t = Date.parse(fetchedAtIso);
            baseMs = isNaN(t) ? Date.now() : t;
        } else {
            baseMs = Date.now();
        }
        _genesisCycleEtaTargetMs = baseMs + nextEtaH * 3600 * 1000;
        _tickGenesisCycleEta();
        _genesisCycleEtaTimer = setInterval(_tickGenesisCycleEta, 30000);
    }

    function _renderGenesisDetail(json) {
        var m = document.getElementById(_GENESIS_MODAL_ID);
        if (!m) return;
        var subEl = m.querySelector('#rt-genesis-modal-sub');
        var members = json.members || {};
        var memberKeys = Object.keys(members);
        var mean = json.ensemble_mean || { points: [] };
        var init = json.init_time || '';
        var initLabel = init
            ? init.slice(0, 4) + '-' + init.slice(4, 6) + '-' + init.slice(6, 8)
              + ' ' + init.slice(8, 10) + 'Z'
            : '(unknown init)';

        // Pre-genesis-specific stats — computed once and threaded through
        // every figure so they all share the same definitions of
        // "formation" (first time a member reaches 34 kt) and "peak Vmax".
        var stats = _computeGenesisStats(memberKeys, members);
        _renderGenesisStatsStrip(stats, memberKeys.length);

        var subParts = [
            '<strong>Init:</strong> ' + initLabel,
            '<span id="rt-genesis-cycle-eta"></span>',
            '<strong>' + memberKeys.length + '</strong> ensemble members',
            '<span style="opacity:0.8;">FNV3 LARGE_ENSEMBLE</span>',
        ];
        // If this disturbance was paired with an officially-tracked ATCF
        // storm (named TC, TD, or invest within 600 km of the cluster's
        // current ensemble-mean position), surface the ATCF id so the
        // user knows the FNV3 ensemble is forecasting a real already-
        // classified system, not a model-only disturbance.
        var _metaForSub = _genesisDisturbanceMeta[json.track_id];
        // Show / hide the "→ IR Detail" button depending on whether
        // the disturbance has a matched ATCF storm. Stash the atcf_id
        // on the button so its click handler knows where to navigate.
        var _openStormBtn = m.querySelector('#rt-genesis-open-storm');
        if (_openStormBtn) {
            if (_metaForSub && _metaForSub.atcfMatch && _metaForSub.atcfMatch.atcfId) {
                _openStormBtn.setAttribute('data-atcf-id',
                                           _metaForSub.atcfMatch.atcfId);
                _openStormBtn.style.display = '';
            } else {
                _openStormBtn.removeAttribute('data-atcf-id');
                _openStormBtn.style.display = 'none';
            }
        }
        if (_metaForSub && _metaForSub.atcfMatch) {
            var _am = _metaForSub.atcfMatch;
            var _matchTip = 'Disturbance cluster center within '
                + Math.round(_am.distKm) + ' km of ' + _am.atcfId
                + ' (' + (_am.name || '?')
                + (_am.category ? ', ' + _am.category : '')
                + (_am.vmaxKt != null ? ', ' + _am.vmaxKt.toFixed(0) + ' kt' : '')
                + ') — labeled with the official ATCF name; the FNV3 '
                + '1000-member diagnostics below are TC-ATLAS\'s '
                + 'ensemble view of that same system.';
            subParts.push('<span class="rt-genesis-atcf-pill" title="'
                + _matchTip.replace(/"/g, '&quot;') + '">ATCF: '
                + _am.atcfId + '</span>');
        }
        // Internal "uncapped re-cluster" provenance flag intentionally
        // suppressed from the user-facing subtitle — it's an implementation
        // detail of the FNV3 backend (cluster member cap on/off) that
        // researchers don't need to read. Still tracked on json._uncapped
        // for downstream logic.
        if (json._dmExcluded) {
            subParts.push('<span style="opacity:0.8; color:#f97316;" '
                + 'title="DeepMind\'s per-cycle tracker reuses numeric track_ids '
                + 'across ensemble members, so the same ID can collect a few '
                + 'members from unrelated storms in distant basins. Members '
                + '> ' + _GENESIS_DM_OUTLIER_KM + ' km from the median first-genesis '
                + 'position have been excluded.">' + json._dmExcluded
                + ' cross-basin outlier' + (json._dmExcluded === 1 ? '' : 's')
                + ' excluded</span>');
        }
        subEl.innerHTML = subParts.join(' · ');
        _startGenesisCycleEta(json.next_cycle_eta_hours, json.fetched_at);

        _renderGenesisMap(memberKeys, members, mean, stats);
        _renderGenesisIntensity(memberKeys, members, mean, stats);
        _renderGenesisTimeHistogram(stats);
        _setupGenesisTauScrubber(memberKeys, members, mean, stats);
    }

    // Shared scrubber state — one modal at a time, so module-scope is fine.
    var _genesisTauState = null;

    function _setupGenesisTauScrubber(memberKeys, members, mean, stats) {
        var slider = document.getElementById('rt-genesis-tau-slider');
        var label  = document.getElementById('rt-genesis-tau-label');
        var playBtn = document.getElementById('rt-genesis-tau-play');
        var prevBtn = document.getElementById('rt-genesis-tau-prev');
        var nextBtn = document.getElementById('rt-genesis-tau-next');
        var stopBtn = document.getElementById('rt-genesis-tau-stop');
        if (!slider || !label) return;

        // Bucket every member point by tau. The members and mean line
        // share the same tau grid in WeatherLab CSVs, so we use the
        // mean's tau axis to drive the slider.
        var taus = [];
        var seenTau = {};
        for (var i = 0; i < mean.points.length; i++) {
            var t = mean.points[i].tau;
            if (t == null || seenTau[t]) continue;
            seenTau[t] = true; taus.push(t);
        }
        if (taus.length === 0) {
            // Fall back to member taus if mean is empty
            for (var mi = 0; mi < memberKeys.length; mi++) {
                var pts = members[memberKeys[mi]].points || [];
                for (var pj = 0; pj < pts.length; pj++) {
                    var tt = pts[pj].tau;
                    if (tt == null || seenTau[tt]) continue;
                    seenTau[tt] = true; taus.push(tt);
                }
            }
        }
        taus.sort(function (a, b) { return a - b; });
        if (taus.length === 0) {
            slider.disabled = true;
            label.textContent = '—';
            return;
        }

        // Index member positions: byTau[tau] = [{lat,lon,wind,key}, ...].
        var byTau = {};
        for (var k = 0; k < memberKeys.length; k++) {
            var key = memberKeys[k];
            var mpts = members[key].points || [];
            for (var pi = 0; pi < mpts.length; pi++) {
                var p = mpts[pi];
                if (p.tau == null || p.lat == null || p.lon == null) continue;
                if (!byTau[p.tau]) byTau[p.tau] = [];
                byTau[p.tau].push({
                    lat: p.lat, lon: p.lon,
                    wind: p.wind != null ? p.wind : null, key: key,
                });
            }
        }

        // Start cursor at median genesis time if we have one, else at
        // the middle of the tau range — these are usually the most
        // informative time slices to land on.
        var initialTau = stats.genesisMedianTau != null
            ? stats.genesisMedianTau : taus[Math.floor(taus.length / 2)];
        var initialIdx = 0;
        var bestD = Infinity;
        for (var ti = 0; ti < taus.length; ti++) {
            var d = Math.abs(taus[ti] - initialTau);
            if (d < bestD) { bestD = d; initialIdx = ti; }
        }

        slider.min = '0';
        slider.max = String(taus.length - 1);
        slider.value = String(initialIdx);
        slider.disabled = false;

        if (_genesisTauState && _genesisTauState.animTimer) {
            clearInterval(_genesisTauState.animTimer);
        }
        // Default to density when there are enough members for overplot
        // to be a problem; raw-marker mode is fine for small clusters
        // (you can see each member's color cleanly).
        var defaultMode = (memberKeys.length >= 80) ? 'density' : 'members';
        _genesisTauState = {
            taus: taus, byTau: byTau, idx: initialIdx,
            animTimer: null, playing: false,
            initialIdx: initialIdx,
            medianGenesisTau: stats.genesisMedianTau,
            mode: defaultMode,
        };
        var modeDensityBtn = document.getElementById('rt-genesis-mode-density');
        var modeMembersBtn = document.getElementById('rt-genesis-mode-members');
        if (modeDensityBtn && modeMembersBtn) {
            modeDensityBtn.classList.toggle('active', defaultMode === 'density');
            modeMembersBtn.classList.toggle('active', defaultMode === 'members');
        }

        function paint() {
            var tau = _genesisTauState.taus[_genesisTauState.idx];
            label.textContent = '+' + tau + ' h';
            _genesisPaintTauCursor(tau, _genesisTauState.byTau[tau] || []);
            _genesisPaintIntensityCursor(tau);
        }
        function step(delta) {
            var n = _genesisTauState.taus.length;
            var i = _genesisTauState.idx + delta;
            if (i < 0) i = 0;
            if (i > n - 1) i = n - 1;
            _genesisTauState.idx = i;
            slider.value = String(i);
            paint();
        }
        function play() {
            if (_genesisTauState.playing) return stop();
            _genesisTauState.playing = true;
            playBtn.classList.add('playing');
            playBtn.innerHTML = '&#10074;&#10074;';   // pause glyph
            // 750 ms/step keeps the eye on each tau long enough to read
            // the intensity cursor + map snapshot before the next frame.
            _genesisTauState.animTimer = setInterval(function () {
                var n = _genesisTauState.taus.length;
                _genesisTauState.idx = (_genesisTauState.idx + 1) % n;
                slider.value = String(_genesisTauState.idx);
                paint();
            }, 750);
        }
        function stop() {
            _genesisTauState.playing = false;
            playBtn.classList.remove('playing');
            playBtn.innerHTML = '&#9654;';
            if (_genesisTauState.animTimer) {
                clearInterval(_genesisTauState.animTimer);
                _genesisTauState.animTimer = null;
            }
        }
        function resetToMedian() {
            stop();
            _genesisTauState.idx = _genesisTauState.initialIdx;
            slider.value = String(_genesisTauState.idx);
            paint();
        }

        // Bind — replace existing handlers via cloneNode trick so we
        // don't stack listeners across modal re-opens.
        function rebind(el, evt, handler) {
            var clone = el.cloneNode(true);
            el.parentNode.replaceChild(clone, el);
            clone.addEventListener(evt, handler);
            return clone;
        }
        slider  = rebind(slider, 'input', function () {
            stop();
            _genesisTauState.idx = parseInt(slider.value, 10) || 0;
            paint();
        });
        prevBtn = rebind(prevBtn, 'click', function () { stop(); step(-1); });
        nextBtn = rebind(nextBtn, 'click', function () { stop(); step(1); });
        stopBtn = rebind(stopBtn, 'click', resetToMedian);
        playBtn = rebind(playBtn, 'click', play);
        if (modeDensityBtn && modeMembersBtn) {
            modeDensityBtn = rebind(modeDensityBtn, 'click', function () {
                _genesisTauState.mode = 'density';
                modeDensityBtn.classList.add('active');
                modeMembersBtn.classList.remove('active');
                paint();
            });
            modeMembersBtn = rebind(modeMembersBtn, 'click', function () {
                _genesisTauState.mode = 'members';
                modeMembersBtn.classList.add('active');
                modeDensityBtn.classList.remove('active');
                paint();
            });
        }

        paint();
    }

    // Paint member positions at tau=t onto the map. Implemented as
    // Plotly.restyle on a placeholder trace appended at render time
    // (index 6), so it doesn't reflow the whole map on every drag tick.
    //
    // Two render modes:
    //   • 'members' — one SS-colored dot per member (cleanest at small N)
    //   • 'density' — coarse-grid binned scatter sized + colored by
    //                 count (cleanest at large N where dots overplot)
    function _genesisPaintTauCursor(tau, positions) {
        var el = document.getElementById('rt-genesis-modal-map');
        if (!el || typeof Plotly === 'undefined' || !el.data) return;
        var mode = (_genesisTauState && _genesisTauState.mode) || 'members';
        // Iso-density band fractions (10/25/50/75 % of peak density).
        // Stacked + composited via translucent fills so the inner
        // bands read darker — operational ensemble-product convention.
        var BAND_FRACTIONS = [0.10, 0.25, 0.50, 0.75];

        if (mode === 'density' && positions.length >= 10) {
            // Adaptive bin size: tight clusters get a finer grid so
            // we don't get a 1-cell blob; sprawling clusters get
            // wider cells to keep the marker count reasonable.
            var lats = positions.map(function (p) { return p.lat; });
            var lons = positions.map(function (p) { return p.lon; });
            var spread = Math.max(
                Math.max.apply(null, lats) - Math.min.apply(null, lats),
                Math.max.apply(null, lons) - Math.min.apply(null, lons));
            var binDeg = Math.max(0.25, Math.min(0.6, spread / 30));
            var grid = _genesisDensityGrid(positions, binDeg, 1.2);
            var paths = _genesisDensityBandPaths(grid, BAND_FRACTIONS);
            // Match marker size to the cell size at the modal's view
            // scale so cells tile without gaps. ~26 px per degree at
            // the modal's typical width, scaled by binDeg + a small
            // overlap factor to hide cell-edge seams. Plotly markers
            // are sized in pixels (not data units) so this isn't
            // perfect at all zoom states but the modal view is fixed.
            var markerPx = Math.max(8, Math.round(binDeg * 26 * 1.25));
            // Empty the members trace + populate the 4 band traces in
            // a single restyle call (avoids inter-frame flicker).
            Plotly.restyle(el, {
                lon: [[], paths[0].lons, paths[1].lons,
                      paths[2].lons, paths[3].lons],
                lat: [[], paths[0].lats, paths[1].lats,
                      paths[2].lats, paths[3].lats],
                'marker.size': [7, markerPx, markerPx, markerPx, markerPx],
            }, [6, 7, 8, 9, 10]);
            // Dim the spaghetti trace (index 0) so the heatmap reads
            // clearly against it — the spaghetti is also orange, so at
            // its default 0.18 alpha the iso-bands get washed out.
            Plotly.restyle(el, {
                'line.color': 'rgba(249,115,22,0.06)',
            }, [0]);
            // Inset legend so the user knows what the heatmap means.
            // Peak density is reported as "N members per <bin>° cell"
            // so the absolute scale is interpretable, not just relative.
            _genesisSetDensityLegend(el, binDeg, grid.maxValue, positions.length, tau);
            return;
        }

        // Members mode (raw SS-colored dots) — clear the band traces
        // and populate the members trace. Restore spaghetti opacity.
        var lons2 = positions.map(function (p) { return p.lon; });
        var lats2 = positions.map(function (p) { return p.lat; });
        var winds2 = positions.map(function (p) { return p.wind != null ? p.wind : 0; });
        Plotly.restyle(el, {
            lon: [lons2, [], [], [], []],
            lat: [lats2, [], [], [], []],
            'marker.size': 7,
            'marker.color': [winds2],
            'marker.colorscale': [_GENESIS_SS_SCALE],
            'marker.cmin': [0],
            'marker.cmax': [200],
            'marker.line.width': [0.6],
            'marker.opacity': [0.95],
            text: [positions.map(function (p) {
                return 'Member ' + p.key + '<br>+' + tau + ' h<br>'
                    + (p.wind != null ? p.wind.toFixed(0) + ' kt' : '— kt');
            })],
        }, [6, 7, 8, 9, 10]);
        Plotly.restyle(el, {
            'line.color': 'rgba(249,115,22,0.18)',
        }, [0]);
        _genesisClearDensityLegend(el);
    }

    // Density-mode key shown as an HTML strip ABOVE the map (between
    // the scrubber row and the chart). Lives outside the Plotly
    // element so it doesn't fight the in-map lat axis labels or the
    // Vmax colorbar for the corners.
    function _genesisSetDensityLegend(el, binDeg, peakDensity, nPositions, tau) {
        var key = document.getElementById('rt-genesis-density-key');
        if (!key) return;
        var peakInt = Math.max(1, Math.round(peakDensity));
        key.style.display = 'flex';
        key.innerHTML =
            '<span class="rt-genesis-density-key-label">'
              + 'Member density at <strong>+' + tau + ' h</strong>'
              + '</span>'
            + '<span class="rt-genesis-density-key-swatches">'
              + '<span><i style="background:#FEDC8A"></i>≥ 10%</span>'
              + '<span><i style="background:#FBBF24"></i>≥ 25%</span>'
              + '<span><i style="background:#EA580C"></i>≥ 50%</span>'
              + '<span><i style="background:#9F1239"></i>≥ 75% of peak</span>'
            + '</span>'
            + '<span class="rt-genesis-density-key-meta">'
              + binDeg.toFixed(2) + '° bins · '
              + 'peak ≈ <strong>' + peakInt + '</strong> members/cell · '
              + nPositions + ' members at this τ'
            + '</span>';
    }

    function _genesisClearDensityLegend(_el) {
        var key = document.getElementById('rt-genesis-density-key');
        if (key) key.style.display = 'none';
    }

    // Bin member positions into a coarse lat/lon grid (degrees) for the
    // density view. Each bin returns the centroid lat/lon, member count,
    // and mean Vmax across the binned members.
    function _genesisBinDensity(positions, binDeg) {
        binDeg = binDeg || 0.6;
        var bins = {};
        for (var i = 0; i < positions.length; i++) {
            var p = positions[i];
            var bx = Math.floor(p.lon / binDeg);
            var by = Math.floor(p.lat / binDeg);
            var key = bx + ',' + by;
            if (!bins[key]) {
                bins[key] = { latSum: 0, lonSum: 0, count: 0,
                              windSum: 0, windN: 0 };
            }
            var b = bins[key];
            b.latSum += p.lat; b.lonSum += p.lon; b.count++;
            if (p.wind != null) { b.windSum += p.wind; b.windN++; }
        }
        var out = [];
        var keys = Object.keys(bins);
        for (var k = 0; k < keys.length; k++) {
            var bb = bins[keys[k]];
            out.push({
                lat: bb.latSum / bb.count,
                lon: bb.lonSum / bb.count,
                count: bb.count,
                wind: bb.windN > 0 ? bb.windSum / bb.windN : 0,
            });
        }
        return out;
    }

    // Draw / move a vertical cursor on the intensity time series.
    // The intensity chart's x-axis is CATEGORICAL ('+204h' strings,
    // not numeric tau), so we must match that format — passing a raw
    // numeric tau makes Plotly extend the axis past the data and
    // visually squeeze every datapoint into the left portion of the
    // chart. We also re-emit the SS reference bands + median-genesis
    // line that the initial render set, since Plotly.relayout's
    // shapes/annotations arrays REPLACE the existing arrays (don't
    // merge).
    function _genesisPaintIntensityCursor(tau) {
        var el = document.getElementById('rt-genesis-modal-int');
        if (!el || typeof Plotly === 'undefined' || !el.layout) return;
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var color = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(15,22,35,0.55)';
        var bandAlpha = isDark ? 0.10 : 0.06;
        function band(y0, y1, fill) {
            return { type: 'rect', xref: 'paper', yref: 'y',
                     x0: 0, x1: 1, y0: y0, y1: y1,
                     fillcolor: fill, line: { width: 0 }, layer: 'below' };
        }
        var shapes = [
            band(0,   34,  'rgba(96,165,250,'  + bandAlpha + ')'),
            band(34,  64,  'rgba(52,211,153,'  + bandAlpha + ')'),
            band(64,  83,  'rgba(251,191,36,'  + bandAlpha + ')'),
            band(83,  96,  'rgba(251,146,60,'  + bandAlpha + ')'),
            band(96,  113, 'rgba(239,68,68,'   + bandAlpha + ')'),
            band(113, 137, 'rgba(196,48,160,'  + bandAlpha + ')'),
            band(137, 200, 'rgba(139,92,246,'  + bandAlpha + ')'),
        ];
        var medTau = _genesisTauState && _genesisTauState.medianGenesisTau;
        if (medTau != null) {
            shapes.push({
                type: 'line', xref: 'x', yref: 'paper',
                x0: '+' + medTau + 'h', x1: '+' + medTau + 'h',
                y0: 0, y1: 1,
                line: { color: '#f97316', width: 1.5, dash: 'dash' },
            });
        }
        // Cursor — categorical x value matches the chart's tau strings.
        var tauStr = '+' + tau + 'h';
        shapes.push({
            type: 'line', xref: 'x', yref: 'paper',
            x0: tauStr, x1: tauStr, y0: 0, y1: 1,
            line: { color: color, width: 1.6, dash: 'dot' },
        });
        var annotations = [];
        if (medTau != null) {
            var maxY = (el.layout.yaxis && el.layout.yaxis.range)
                       ? el.layout.yaxis.range[1] : 160;
            annotations.push({
                x: '+' + medTau + 'h', y: maxY * 0.97,
                xref: 'x', yref: 'y',
                text: 'median genesis', showarrow: false,
                font: { size: 9, color: '#f97316' },
                xanchor: 'left', xshift: 4,
            });
        }
        annotations.push({
            xref: 'x', yref: 'paper', x: tauStr, y: 1.03,
            text: tauStr, showarrow: false,
            font: { size: 11, color: color },
            xanchor: 'center', yanchor: 'bottom',
        });
        Plotly.relayout(el, { shapes: shapes, annotations: annotations });
    }

    /* Compute the pre-genesis stat bundle once per modal open.
       - formationCount / formationProb: members that ever reach 34 kt
       - genesisTimes[]: per-member first-cross tau (null if never forms)
       - genesisLat/Lon[]: per-member first-cross position
       - peakWinds[]: per-member LMI
       - meanPeak, meanPeakTau: peak of the ensemble-mean line */
    function _computeGenesisStats(memberKeys, members) {
        var formationCount = 0;
        var genesisTimes = [];
        var genLats = [];
        var genLons = [];
        var peakWinds = [];
        for (var i = 0; i < memberKeys.length; i++) {
            var pts = members[memberKeys[i]].points || [];
            var firstTau = null, firstLat = null, firstLon = null;
            var peak = 0;
            for (var j = 0; j < pts.length; j++) {
                var w = pts[j].wind;
                if (w == null) continue;
                if (firstTau == null && w >= 34) {
                    firstTau = pts[j].tau;
                    firstLat = pts[j].lat;
                    firstLon = pts[j].lon;
                }
                if (w > peak) peak = w;
            }
            if (firstTau != null) {
                formationCount++;
                genesisTimes.push(firstTau);
                genLats.push(firstLat);
                genLons.push(firstLon);
            }
            peakWinds.push(peak);
        }
        // Percentile helper — needs caller-sorted array.
        function pct(sorted, q) {
            if (!sorted.length) return null;
            var idx = Math.min(sorted.length - 1,
                               Math.floor(q * (sorted.length - 1)));
            return sorted[idx];
        }
        var sortedPeaks = peakWinds.slice().sort(function (a, b) { return a - b; });
        var sortedTimes = genesisTimes.slice().sort(function (a, b) { return a - b; });
        return {
            n: memberKeys.length,
            formationCount: formationCount,
            // Divide by the TOTAL ensemble size (1000), not the
            // cluster's own member count. The cluster member count is
            // already the subset DeepMind (or our DBSCAN path) grouped
            // into this feature, so dividing by it always reads ~100%
            // and answers a meaningless question. The right question
            // is "what fraction of the 1000-member ensemble detected
            // this feature reaching TC strength?" — which matches the
            // disturbance-marker formation probability on the Global
            // Map, so the modal and the marker now agree.
            formationProb: formationCount / _GENESIS_ENSEMBLE_SIZE,
            ensembleSize: _GENESIS_ENSEMBLE_SIZE,
            genesisTimes: genesisTimes,
            genLats: genLats,
            genLons: genLons,
            peakWinds: peakWinds,
            peakP10: pct(sortedPeaks, 0.10),
            peakP50: pct(sortedPeaks, 0.50),
            peakP90: pct(sortedPeaks, 0.90),
            genesisMedianTau: pct(sortedTimes, 0.50),
        };
    }

    function _renderGenesisStatsStrip(stats, nMembers) {
        var el = document.getElementById('rt-genesis-modal-stats');
        if (!el) return;
        var formPct = (stats.formationProb * 100).toFixed(0) + '%';
        var medGen = (stats.genesisMedianTau != null)
            ? '+' + stats.genesisMedianTau + ' h'
            : '—';
        var p10 = stats.peakP10 != null ? stats.peakP10.toFixed(0) + ' kt' : '—';
        var p50 = stats.peakP50 != null ? stats.peakP50.toFixed(0) + ' kt' : '—';
        var p90 = stats.peakP90 != null ? stats.peakP90.toFixed(0) + ' kt' : '—';
        function tile(label, value, hint) {
            return '<div class="rt-genesis-stat">'
                +    '<div class="rt-genesis-stat-label">' + label + '</div>'
                +    '<div class="rt-genesis-stat-value">' + value + '</div>'
                +    (hint ? '<div class="rt-genesis-stat-hint">' + hint + '</div>' : '')
                + '</div>';
        }
        el.innerHTML =
            tile('Formation probability',
                 formPct,
                 stats.formationCount + ' / ' + stats.ensembleSize
                 + ' ensemble members detect this feature reaching 34 kt') +
            tile('Median genesis time',
                 medGen,
                 'first time any cluster member crosses 34 kt') +
            tile('Peak Vmax · P10 / P50 / P90',
                 p10 + ' · ' + p50 + ' · ' + p90,
                 'across cluster member lifetime-max intensities');
    }

    /* Theme palette + SS palette helpers ─────────────────────────
       Reads TCATheme.plotly() when available so the modal inherits
       the rest of the site's dark/light switching for free. The SS
       ramp matches realtime_ir.js's SS_COLORS used on the global map
       so colored markers read the same as track icons. */
    function _genesisTheme() {
        if (window.TCATheme && typeof window.TCATheme.plotly === 'function') {
            return window.TCATheme.plotly();
        }
        return {
            paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
            font: { family: 'DM Sans, system-ui, sans-serif',
                    color: '#0f1623', size: 11 },
            hoverlabel: { bgcolor: '#ffffff',
                          bordercolor: 'rgba(15,22,35,0.15)',
                          font: { color: '#0f1623', size: 11 } },
        };
    }
    var _GENESIS_SS_SCALE = [
        [0,        '#60a5fa'],   // TD
        [34/200,   '#34d399'],   // TS
        [64/200,   '#fbbf24'],   // C1
        [83/200,   '#fb923c'],   // C2
        [96/200,   '#ef4444'],   // C3
        [113/200,  '#c430a0'],   // C4
        [137/200,  '#8b5cf6'],   // C5
        [1,        '#8b5cf6'],
    ];

    /* Track map (figure 1).
       The TC-ATLAS visual: thin orange spaghetti polylines (matching
       the Global Map's genesis layer color #f97316) + a bold ensemble-
       mean track with SS-colored markers. Unique-to-pre-genesis
       additions:
         - "first-genesis" dots = the lat/lon where each member first
           reaches 34 kt. The cloud of these dots shows where genesis
           is forecast to occur (vs the colleague's all-position cloud
           which mostly shows where the storm sits, not where it forms). */
    function _renderGenesisMap(memberKeys, members, mean, stats) {
        var el = document.getElementById('rt-genesis-modal-map');
        if (!el || typeof Plotly === 'undefined') return;
        var theme = _genesisTheme();
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        // Per-member polylines collapsed into one trace via null separators
        // (cheap render: 1 trace × N members × M points vs N traces).
        // Insert a null between consecutive points whose longitudes
        // differ by >180° so Plotly doesn't draw a line wrapping the
        // entire globe when a member crosses the antimeridian.
        var spagX = [], spagY = [];
        for (var i = 0; i < memberKeys.length; i++) {
            var pts = members[memberKeys[i]].points || [];
            var lastLon = null;
            for (var j = 0; j < pts.length; j++) {
                if (pts[j].lat == null || pts[j].lon == null) continue;
                if (lastLon !== null && Math.abs(pts[j].lon - lastLon) > 180) {
                    spagX.push(null); spagY.push(null);
                }
                spagX.push(pts[j].lon);
                spagY.push(pts[j].lat);
                lastLon = pts[j].lon;
            }
            spagX.push(null); spagY.push(null);
        }
        // Mean track arrays — antimeridian split so the orange mean
        // line doesn't wrap the globe if the cluster recurves across
        // 180°. Markers (separate trace) don't need this — they're
        // independent points, no inter-point lines.
        var meanLons = [], meanLats = [], meanWinds = [], meanTaus = [];
        var meanLineLons = [], meanLineLats = [];
        var prevMeanLon = null;
        for (var k = 0; k < mean.points.length; k++) {
            var mp = mean.points[k];
            meanLons.push(mp.lon);
            meanLats.push(mp.lat);
            meanWinds.push(mp.wind != null ? mp.wind : 0);
            meanTaus.push(mp.tau);
            if (prevMeanLon !== null && Math.abs(mp.lon - prevMeanLon) > 180) {
                meanLineLons.push(null); meanLineLats.push(null);
            }
            meanLineLons.push(mp.lon);
            meanLineLats.push(mp.lat);
            prevMeanLon = mp.lon;
        }

        // Measure the container's actual aspect ratio and use that as
        // the bounds target — otherwise the natural Mercator projection
        // aspect of the data leaves big vertical strips of whitespace
        // on either side of the map. Subtract ~70 px for the colorbar
        // so we don't over-zoom and crowd the legend.
        var rect = el.getBoundingClientRect();
        var containerAspect = rect.height > 0
            ? Math.max(0.8, (rect.width - 70) / rect.height) : 2.2;
        var bounds = _genesisBoundsFromMean(meanLats, meanLons,
                                             stats.genLats, stats.genLons,
                                             containerAspect);

        var spaghetti = {
            type: 'scattergeo', mode: 'lines',
            lon: spagX, lat: spagY,
            line: { color: 'rgba(249,115,22,0.18)', width: 0.9 },
            name: 'Members',
            hoverinfo: 'skip',
            showlegend: false,
            connectgaps: false,
        };
        // First-genesis dots — a pre-genesis feature only this view has.
        var firstGenesis = {
            type: 'scattergeo', mode: 'markers',
            lon: stats.genLons, lat: stats.genLats,
            marker: {
                size: 5,
                color: 'rgba(249,115,22,0.55)',
                line: { color: 'rgba(124,45,18,0.65)', width: 0.4 },
            },
            name: 'First-genesis (≥ 34 kt)',
            hovertemplate: 'Member first reaches 34 kt<br>%{lat:.1f}°N, %{lon:.1f}°E<extra></extra>',
            showlegend: false,
        };
        var meanLine = {
            type: 'scattergeo', mode: 'lines',
            lon: meanLineLons, lat: meanLineLats,
            line: { color: '#f97316', width: 2.5 },
            name: 'Ensemble mean',
            hoverinfo: 'skip',
            showlegend: false,
            connectgaps: false,
        };
        var meanMarkers = {
            type: 'scattergeo', mode: 'markers',
            lon: meanLons, lat: meanLats,
            marker: {
                size: 10,
                color: meanWinds,
                colorscale: _GENESIS_SS_SCALE,
                cmin: 0, cmax: 200,
                line: { color: isDark ? '#0f172a' : '#1f2937', width: 1 },
                colorbar: {
                    title: { text: 'Vmax (kt)', side: 'right',
                             font: { size: 11 } },
                    thickness: 14, len: 0.92,
                    // Tick at every category boundary; "34 TS" reads as a
                    // single line so the bar doesn't need two-row spacing.
                    tickvals: [0, 34, 64, 83, 96, 113, 137],
                    ticktext: ['0', '34 TS', '64 C1', '83 C2',
                               '96 C3', '113 C4', '137 C5'],
                    tickfont: { size: 11 },
                    ticklen: 4,
                    outlinewidth: 0,
                },
                showscale: true,
            },
            text: meanWinds.map(function (w, idx) {
                return '+' + meanTaus[idx] + ' h<br>' + w.toFixed(0)
                    + ' kt (' + windToCategory(w) + ')';
            }),
            hovertemplate: '%{text}<br>%{lat:.1f}°N, %{lon:.1f}°E<extra></extra>',
            name: 'Ensemble mean',
            showlegend: false,
        };
        // Axis labels — scattergeo has no built-in tick labels, so we
        // place them as a text trace inset slightly inside the W/S
        // edges (placing at the very edge causes Plotly to clip them).
        // Grid step matches geo.lonaxis/lataxis dtick.
        var labelStep = _genesisAxisDtick(bounds);
        var lonInset = (bounds.lat[1] - bounds.lat[0]) * 0.04;
        var latInset = (bounds.lon[1] - bounds.lon[0]) * 0.04;
        var lonLabelLats = [], lonLabelLons = [], lonLabelText = [];
        var lonStart = Math.ceil(bounds.lon[0] / labelStep) * labelStep;
        for (var lo = lonStart; lo <= bounds.lon[1]; lo += labelStep) {
            // Skip labels too close to the bounding edge (would clip).
            if (lo - bounds.lon[0] < labelStep * 0.4) continue;
            if (bounds.lon[1] - lo < labelStep * 0.4) continue;
            lonLabelLats.push(bounds.lat[0] + lonInset);
            lonLabelLons.push(lo);
            lonLabelText.push(_genesisFormatLon(lo));
        }
        var latLabelLats = [], latLabelLons = [], latLabelText = [];
        var latStart = Math.ceil(bounds.lat[0] / labelStep) * labelStep;
        for (var la = latStart; la <= bounds.lat[1]; la += labelStep) {
            if (la - bounds.lat[0] < labelStep * 0.4) continue;
            if (bounds.lat[1] - la < labelStep * 0.4) continue;
            latLabelLats.push(la);
            latLabelLons.push(bounds.lon[0] + latInset);
            latLabelText.push(_genesisFormatLat(la));
        }
        // Bold bigger text reads clearly against both ocean and land
        // without needing a background pill (which scattergeo's SVG
        // text doesn't really support anyway).
        var labelFg = isDark ? '#f1f5f9' : '#0f172a';
        var lonLabels = {
            type: 'scattergeo', mode: 'text',
            lon: lonLabelLons, lat: lonLabelLats,
            text: lonLabelText,
            textfont: { size: 12, color: labelFg, family: 'Inter, sans-serif' },
            textposition: 'top center',
            hoverinfo: 'skip',
            showlegend: false,
        };
        var latLabels = {
            type: 'scattergeo', mode: 'text',
            lon: latLabelLons, lat: latLabelLats,
            text: latLabelText,
            textfont: { size: 12, color: labelFg, family: 'Inter, sans-serif' },
            textposition: 'middle right',
            hoverinfo: 'skip',
            showlegend: false,
        };
        // Read the live --surface tokens from CSS so the map ocean
        // matches the modal background exactly — no more "panel inside
        // a panel" two-tone look. Falls back to safe defaults if the
        // tokens aren't set on the page.
        var rootStyle = getComputedStyle(document.documentElement);
        var pageSurface = rootStyle.getPropertyValue('--surface-raised').trim()
                       || (isDark ? '#161b24' : '#ffffff');
        var pageLand    = rootStyle.getPropertyValue('--surface').trim()
                       || (isDark ? '#11161f' : '#f7f8fa');

        var layout = {
            margin: { l: 4, r: 4, t: 8, b: 4 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            font: theme.font,
            geo: {
                projection: { type: 'mercator' },
                domain: { x: [0, 1], y: [0, 1] },
                lonaxis: { range: bounds.lon, showgrid: true,
                           gridcolor: isDark ? 'rgba(255,255,255,0.10)'
                                             : 'rgba(15,22,35,0.10)',
                           dtick: labelStep },
                lataxis: { range: bounds.lat, showgrid: true,
                           gridcolor: isDark ? 'rgba(255,255,255,0.10)'
                                             : 'rgba(15,22,35,0.10)',
                           dtick: labelStep },
                showland: true,
                landcolor: pageLand,
                showocean: true,
                oceancolor: pageSurface,
                showcountries: true,
                countrycolor: isDark ? 'rgba(255,255,255,0.20)' : 'rgba(15,22,35,0.30)',
                coastlinecolor: isDark ? 'rgba(255,255,255,0.45)'
                                       : 'rgba(15,22,35,0.55)',
                coastlinewidth: 0.8,
                showcoastlines: true,
                bgcolor: 'rgba(0,0,0,0)',
            },
            showlegend: false,
        };
        // Tau-cursor placeholder — starts empty, gets populated by
        // _genesisPaintTauCursor when the user drags the scrubber. Has
        // its own SS-colored markers so the moving snapshot reads as
        // "where each member is right now" against the static spaghetti.
        var tauCursor = {
            type: 'scattergeo', mode: 'markers',
            lon: [], lat: [], text: [],
            marker: {
                size: 7,
                color: [], colorscale: _GENESIS_SS_SCALE,
                cmin: 0, cmax: 200,
                line: { color: isDark ? '#0f172a' : '#1f2937', width: 0.6 },
                opacity: 0.95,
            },
            hovertemplate: '%{text}<br>%{lat:.1f}°N, %{lon:.1f}°E<extra></extra>',
            showlegend: false,
        };
        // Density-mode placeholder traces — 4 stacked square-marker
        // bands at 10/25/50/75% of peak density. We use markers
        // (symbol: 'square') instead of fill:'toself' because Plotly's
        // scattergeo doesn't handle null-separated multi-polygon fills
        // correctly (treats the entire null-joined path as one polygon
        // → red wash across the whole map). Square markers per cell
        // give the same visual result without the bug.
        function densityBand(rgb, alpha) {
            return {
                type: 'scattergeo', mode: 'markers',
                lon: [], lat: [],
                marker: {
                    symbol: 'square',
                    size: 12,
                    color: 'rgba(' + rgb + ',' + alpha + ')',
                    line: { color: 'rgba(0,0,0,0)', width: 0 },
                    opacity: 1,
                },
                hoverinfo: 'skip',
                showlegend: false,
            };
        }
        // Warm sequential ramp — outermost (10%) pale yellow, innermost
        // (75%) deep crimson. Alphas chosen so the 4-band overlap at
        // the peak composites to a saturated red against the orange
        // spaghetti background. Yellow→red ramp reads more clearly as
        // a probability heatmap than orange→red.
        var tauDensity0 = densityBand('254, 240, 138', 0.55);  // ≥10% peak (pale yellow)
        var tauDensity1 = densityBand('251, 191,  36', 0.55);  // ≥25% (amber)
        var tauDensity2 = densityBand('234,  88,  12', 0.60);  // ≥50% (orange-red)
        var tauDensity3 = densityBand('159,  18,  57', 0.65);  // ≥75% (deep crimson)
        Plotly.react(el,
                     [spaghetti, firstGenesis, meanLine, meanMarkers,
                      lonLabels, latLabels, tauCursor,
                      tauDensity0, tauDensity1, tauDensity2, tauDensity3],
                     layout,
                     { responsive: true, displayModeBar: false });
    }

    // Build a 2D density grid from member positions: raw histogram
    // followed by a separable Gaussian smooth so the resulting iso-
    // contour bands have smooth boundaries instead of stepped corners
    // from the binning. binDeg controls cell size; sigmaCells is the
    // Gaussian sigma in cell units (1.0 → ~one-cell smoothing radius).
    function _genesisDensityGrid(positions, binDeg, sigmaCells) {
        if (!positions || !positions.length) return null;
        var lats = positions.map(function (p) { return p.lat; });
        var lons = positions.map(function (p) { return p.lon; });
        var latMin = Math.min.apply(null, lats);
        var latMax = Math.max.apply(null, lats);
        var lonMin = Math.min.apply(null, lons);
        var lonMax = Math.max.apply(null, lons);
        // Pad bounds by a few cells so the Gaussian tails fade
        // smoothly to zero past the data instead of being clipped.
        var pad = 4 * binDeg;
        latMin -= pad; latMax += pad;
        lonMin -= pad; lonMax += pad;
        var ny = Math.max(1, Math.ceil((latMax - latMin) / binDeg) + 1);
        var nx = Math.max(1, Math.ceil((lonMax - lonMin) / binDeg) + 1);
        // Pre-size grids (faster than Array.fill for typed-array-like
        // workloads at the ~100x100 sizes we use here).
        var values = new Array(ny);
        for (var y0 = 0; y0 < ny; y0++) {
            values[y0] = new Array(nx);
            for (var x0 = 0; x0 < nx; x0++) values[y0][x0] = 0;
        }
        // 1. Raw histogram
        for (var i = 0; i < positions.length; i++) {
            var ix = Math.floor((positions[i].lon - lonMin) / binDeg);
            var iy = Math.floor((positions[i].lat - latMin) / binDeg);
            if (ix >= 0 && ix < nx && iy >= 0 && iy < ny) {
                values[iy][ix] += 1;
            }
        }
        // 2. Separable Gaussian smooth (H then V).
        var sigma = sigmaCells || 1.0;
        var kr = Math.max(1, Math.ceil(sigma * 3));
        var kernel = new Array(2 * kr + 1);
        var ksum = 0;
        for (var k = -kr; k <= kr; k++) {
            var w = Math.exp(-(k * k) / (2 * sigma * sigma));
            kernel[k + kr] = w; ksum += w;
        }
        for (var ki = 0; ki < kernel.length; ki++) kernel[ki] /= ksum;
        var tmp = new Array(ny);
        for (var y1 = 0; y1 < ny; y1++) {
            tmp[y1] = new Array(nx);
            for (var x1 = 0; x1 < nx; x1++) {
                var sumH = 0;
                for (var kh = -kr; kh <= kr; kh++) {
                    var sx = x1 + kh;
                    if (sx < 0) sx = 0;
                    else if (sx >= nx) sx = nx - 1;
                    sumH += values[y1][sx] * kernel[kh + kr];
                }
                tmp[y1][x1] = sumH;
            }
        }
        var out = new Array(ny);
        var maxV = 0;
        for (var y2 = 0; y2 < ny; y2++) {
            out[y2] = new Array(nx);
            for (var x2 = 0; x2 < nx; x2++) {
                var sumV = 0;
                for (var kv = -kr; kv <= kr; kv++) {
                    var sy = y2 + kv;
                    if (sy < 0) sy = 0;
                    else if (sy >= ny) sy = ny - 1;
                    sumV += tmp[sy][x2] * kernel[kv + kr];
                }
                out[y2][x2] = sumV;
                if (sumV > maxV) maxV = sumV;
            }
        }
        return { values: out, ny: ny, nx: nx,
                 latMin: latMin, lonMin: lonMin,
                 binDeg: binDeg, maxValue: maxV };
    }

    // For each iso-threshold (as a fraction of peak density), collect
    // the centers of all grid cells at or above the threshold. The
    // density-band traces render these as fixed-size square markers,
    // sized to tile the grid without gaps at the modal's typical
    // view extent. Inner bands (high threshold) are SUBSETS of outer
    // bands — trace stacking + alpha compositing gives the heatmap.
    function _genesisDensityBandPaths(grid, fractions) {
        if (!grid || !grid.maxValue) {
            return fractions.map(function () { return { lons: [], lats: [] }; });
        }
        var b = grid.binDeg;
        return fractions.map(function (frac) {
            var thr = frac * grid.maxValue;
            var lons = [], lats = [];
            for (var iy = 0; iy < grid.ny; iy++) {
                var cellLat = grid.latMin + (iy + 0.5) * b;
                for (var ix = 0; ix < grid.nx; ix++) {
                    if (grid.values[iy][ix] < thr) continue;
                    lons.push(grid.lonMin + (ix + 0.5) * b);
                    lats.push(cellLat);
                }
            }
            return { lons: lons, lats: lats };
        });
    }

    // Axis label step that scales with the bounds — keeps the map from
    // either being label-spammed at continental scale or label-starved
    // when zoomed into a 6° box.
    function _genesisAxisDtick(bounds) {
        var span = Math.max(bounds.lat[1] - bounds.lat[0],
                            (bounds.lon[1] - bounds.lon[0]) * 0.75);
        if (span <= 8)  return 2;
        if (span <= 18) return 5;
        if (span <= 40) return 10;
        return 20;
    }

    function _genesisFormatLat(lat) {
        if (lat === 0) return '0°';
        return Math.abs(lat).toFixed(0) + '°' + (lat >= 0 ? 'N' : 'S');
    }
    function _genesisFormatLon(lon) {
        // Normalize for display: -120° → 120°W, 240° → 120°W, 135° → 135°E.
        var x = lon;
        while (x > 180) x -= 360;
        while (x < -180) x += 360;
        if (x === 0 || x === 180) return Math.abs(x).toFixed(0) + '°';
        return Math.abs(x).toFixed(0) + '°' + (x >= 0 ? 'E' : 'W');
    }

    /* Intensity time series (figure 2).
       TC-ATLAS style: matches realtime_ir.js's storm-detail intensity
       panel — soft orange min/max envelope + bold mean line with SS-
       colored markers. Categorical reference bands across the y axis
       give the analyst the SS context without busy dashed lines.
       (No ±σ ribbons or per-member dots — the user asked for the
       simpler "track and intensity forecasts" view, not the colleague's
       statistical layout.) */
    function _renderGenesisIntensity(memberKeys, members, mean, stats) {
        var el = document.getElementById('rt-genesis-modal-int');
        if (!el || typeof Plotly === 'undefined') return;
        var theme = _genesisTheme();
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        // Bucket every member's Vmax by tau so we can compute a per-tau
        // envelope without re-walking members per-point.
        var byTau = {};
        for (var i = 0; i < memberKeys.length; i++) {
            var pts = members[memberKeys[i]].points || [];
            for (var j = 0; j < pts.length; j++) {
                if (pts[j].wind == null) continue;
                var t = pts[j].tau;
                if (!byTau[t]) byTau[t] = [];
                byTau[t].push(pts[j].wind);
            }
        }
        var taus = Object.keys(byTau).map(Number).sort(function (a, b) {
            return a - b;
        });
        // Per-tau distribution: min/max envelope plus P10/P25/P50/P75/P90
        // ribbons so the modal shows the SHAPE of the distribution (where
        // the bulk of members sit) and not just the extremes.
        function pct(sorted, q) {
            if (!sorted.length) return null;
            var idx = Math.min(sorted.length - 1,
                               Math.max(0, Math.floor(q * (sorted.length - 1))));
            return sorted[idx];
        }
        var minArr = [], maxArr = [];
        var p10Arr = [], p25Arr = [], p50Arr = [], p75Arr = [], p90Arr = [];
        for (var ti = 0; ti < taus.length; ti++) {
            var sorted = byTau[taus[ti]].slice().sort(function (a, b) { return a - b; });
            minArr.push(sorted[0]);
            maxArr.push(sorted[sorted.length - 1]);
            p10Arr.push(pct(sorted, 0.10));
            p25Arr.push(pct(sorted, 0.25));
            p50Arr.push(pct(sorted, 0.50));
            p75Arr.push(pct(sorted, 0.75));
            p90Arr.push(pct(sorted, 0.90));
        }
        var xVals = taus.map(function (t) { return '+' + t + 'h'; });
        var meanByTau = {};
        for (var mi = 0; mi < mean.points.length; mi++) {
            if (mean.points[mi].wind != null) {
                meanByTau[mean.points[mi].tau] = mean.points[mi].wind;
            }
        }
        var meanArr = taus.map(function (t) { return meanByTau[t]; });

        // SS reference bands — cool monochrome ramp (light blue → deep
        // violet) so the background gives an "intensity increases upward"
        // cue without competing with the orange percentile ribbons. The
        // old SS rainbow had yellow (C1) and orange (C2) sitting right
        // where the data peaks, which made the ribbons disappear into
        // the background. The single-hue cool ramp leaves the warm
        // ribbon palette as the only warm thing on the plot.
        function bandShape(y0, y1, color) {
            return {
                type: 'rect', xref: 'paper', yref: 'y',
                x0: 0, x1: 1, y0: y0, y1: y1,
                fillcolor: color, line: { width: 0 }, layer: 'below',
            };
        }
        // Same hue family; alpha grows with category so darker = stronger.
        // Light theme uses the rgba(99,102,241,…) indigo ramp; dark theme
        // gets a touch more alpha since the navy surface eats some
        // contrast.
        var coolAlphas = isDark
            ? [0.06, 0.10, 0.14, 0.18, 0.22, 0.28, 0.34]
            : [0.04, 0.07, 0.10, 0.13, 0.17, 0.22, 0.27];
        function ind(a) { return 'rgba(99,102,241,' + a + ')'; }
        var shapes = [
            bandShape(0,   34,  ind(coolAlphas[0])),  // TD
            bandShape(34,  64,  ind(coolAlphas[1])),  // TS
            bandShape(64,  83,  ind(coolAlphas[2])),  // C1
            bandShape(83,  96,  ind(coolAlphas[3])),  // C2
            bandShape(96,  113, ind(coolAlphas[4])),  // C3
            bandShape(113, 137, ind(coolAlphas[5])),  // C4
            bandShape(137, 200, ind(coolAlphas[6])),  // C5
        ];

        // Nested percentile ribbons — outermost min/max (lightest),
        // P10/P90, then P25/P75 (darkest fill). Reads as a fan-chart:
        // the user sees both the distribution's extremes AND where the
        // bulk of members sit (50% inside the P25/P75 band) at a glance.
        //
        // Plotly's built-in legend decodes the bands (each filled trace
        // emits a color swatch); the invisible low trace of each
        // ribbon stays out of the legend with showlegend:false.
        var traces = [];
        function pushRibbon(low, high, fill, name) {
            traces.push({
                type: 'scatter', mode: 'lines',
                x: xVals, y: low,
                line: { color: 'rgba(0,0,0,0)' },
                showlegend: false, hoverinfo: 'skip',
            });
            traces.push({
                type: 'scatter', mode: 'lines',
                x: xVals, y: high,
                line: { color: 'rgba(0,0,0,0)' },
                fill: 'tonexty', fillcolor: fill,
                name: name, hoverinfo: 'skip', showlegend: true,
            });
        }
        // Layered light → dark so the inner bands stack cleanly on top
        // of the outer ones. Plotly composites in trace order.
        pushRibbon(minArr, maxArr,
            isDark ? 'rgba(249,115,22,0.10)' : 'rgba(249,115,22,0.08)',
            'min – max');
        pushRibbon(p10Arr, p90Arr,
            isDark ? 'rgba(249,115,22,0.16)' : 'rgba(249,115,22,0.14)',
            'P10 – P90');
        pushRibbon(p25Arr, p75Arr,
            isDark ? 'rgba(249,115,22,0.22)' : 'rgba(249,115,22,0.20)',
            'P25 – P75 (IQR)');
        // Median (P50) — thin dashed reference for the typical member.
        traces.push({
            type: 'scatter', mode: 'lines',
            x: xVals, y: p50Arr,
            line: { color: isDark ? 'rgba(254,215,170,0.85)'
                                  : 'rgba(180,83,9,0.75)',
                    width: 1.2, dash: 'dot' },
            name: 'median (P50)',
            hovertemplate: '%{x}<br>median: %{y:.1f} kt<extra></extra>',
            showlegend: true,
        });
        // Ensemble mean — solid bold line with SS-colored markers.
        // Marker color array would make the legend swatch ugly, so we
        // give the swatch a solid mean-line color via a small marker
        // override only used by the legend.
        traces.push({
            type: 'scatter', mode: 'lines+markers',
            x: xVals, y: meanArr,
            line: { color: '#f97316', width: 2.5 },
            marker: {
                size: 9,
                color: meanArr,
                colorscale: _GENESIS_SS_SCALE,
                cmin: 0, cmax: 200,
                line: { color: isDark ? '#0f172a' : '#1f2937', width: 1 },
                showscale: false,
            },
            name: 'ensemble mean',
            hovertemplate: '%{x}<br>%{y:.1f} kt<extra></extra>',
            showlegend: true,
        });

        // Genesis median line — marks the median +X h at which a
        // member first reaches 34 kt. A small contextual cue the named-
        // storm view doesn't need.
        if (stats.genesisMedianTau != null) {
            shapes.push({
                type: 'line', xref: 'x', yref: 'paper',
                x0: '+' + stats.genesisMedianTau + 'h',
                x1: '+' + stats.genesisMedianTau + 'h',
                y0: 0, y1: 1,
                line: { color: '#f97316', width: 1.5, dash: 'dash' },
            });
        }

        var maxY = Math.max(160, Math.max.apply(null, maxArr) + 10);
        var layout = Object.assign({}, theme, {
            // Extra bottom room for the rotated tick labels + the
            // "Lead time" title (was 42 px and crowded against the
            // ticks). r:96 leaves space for the inset legend.
            margin: { l: 55, r: 96, t: 26, b: 64 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            xaxis: { title: { text: 'Lead time', font: { size: 11 },
                              standoff: 14 },
                     tickfont: { size: 10 },
                     // Thin to every 4th tick so a 6-hourly grid renders
                     // as 24 h steps — readable without crowding the
                     // axis at the modal's typical 1300 px width.
                     tickmode: 'array',
                     tickvals: xVals.filter(function (_v, i) { return i % 4 === 0; }),
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)' },
            yaxis: { title: { text: 'Vmax (kt)', font: { size: 11 } },
                     range: [0, maxY],
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)' },
            shapes: shapes,
            annotations: stats.genesisMedianTau != null ? [{
                x: '+' + stats.genesisMedianTau + 'h',
                y: maxY * 0.97, xref: 'x', yref: 'y',
                text: 'median genesis', showarrow: false,
                font: { size: 9, color: '#f97316' },
                xanchor: 'left', xshift: 4,
            }] : [],
            showlegend: true,
            legend: {
                x: 1.005, y: 1, xanchor: 'left', yanchor: 'top',
                bgcolor: isDark ? 'rgba(15,22,35,0.75)'
                                : 'rgba(255,255,255,0.85)',
                bordercolor: isDark ? 'rgba(255,255,255,0.10)'
                                    : 'rgba(15,22,35,0.10)',
                borderwidth: 1,
                font: { size: 10, color: isDark ? '#e2e8f0' : '#1f2937' },
                itemsizing: 'constant',
                itemwidth: 30,
                tracegroupgap: 0,
            },
        });
        Plotly.react(el, traces, layout,
                     { responsive: true, displayModeBar: false });
    }

    /* Genesis-time histogram (figure 3).
       This is the chart only a pre-genesis ensemble needs: when does
       each member first reach 34 kt? Bins are 12 h so a slot lines
       up to a synoptic forecast cycle. Empty bins are kept so the
       reader sees where genesis is NOT predicted (e.g. "no members
       form before +24 h, then a cluster at +72-96 h"). */
    function _renderGenesisTimeHistogram(stats) {
        var el = document.getElementById('rt-genesis-modal-gtime');
        if (!el || typeof Plotly === 'undefined') return;
        var theme = _genesisTheme();
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var times = stats.genesisTimes || [];
        if (!times.length) {
            Plotly.react(el, [], Object.assign({}, theme, {
                margin: { l: 55, r: 12, t: 26, b: 42 },
                annotations: [{
                    xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
                    text: 'No member reaches 34 kt in the 15-day window.',
                    showarrow: false,
                    font: { size: 12, color: theme.font.color },
                }],
                xaxis: { visible: false }, yaxis: { visible: false },
            }), { responsive: true, displayModeBar: false });
            return;
        }
        // Build 12-h bins from min to max genesis tau, anchored to 0.
        var minT = 0;
        var maxT = Math.max.apply(null, times);
        var binW = 12;
        var nBins = Math.ceil((maxT - minT) / binW) + 1;
        var bins = new Array(nBins).fill(0);
        for (var i = 0; i < times.length; i++) {
            var b = Math.floor((times[i] - minT) / binW);
            if (b < 0) b = 0;
            if (b >= nBins) b = nBins - 1;
            bins[b]++;
        }
        var binCenters = [], binLabels = [];
        for (var k = 0; k < nBins; k++) {
            var lo = minT + k * binW;
            binCenters.push(lo + binW / 2);
            binLabels.push('+' + lo + '–' + (lo + binW) + 'h');
        }
        var maxCount = Math.max.apply(null, bins);
        var trace = {
            type: 'bar',
            x: binCenters, y: bins,
            width: binW * 0.85,
            marker: {
                color: 'rgba(249,115,22,0.78)',
                line: { color: '#f97316', width: 0.8 },
            },
            text: bins.map(function (c) { return c > 0 ? c : ''; }),
            textposition: 'outside',
            textfont: { size: 10, color: isDark ? '#e2e8f0' : '#0f172a' },
            customdata: binLabels,
            hovertemplate: '%{customdata}<br>%{y} members<extra></extra>',
            showlegend: false,
        };
        var layout = Object.assign({}, theme, {
            margin: { l: 55, r: 12, t: 26, b: 42 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            title: {
                text: 'When does each member first reach 34 kt?',
                x: 0, xanchor: 'left',
                font: { size: 11, color: theme.font.color },
            },
            xaxis: { title: { text: 'Lead time (h)', font: { size: 10 } },
                     tickfont: { size: 10 },
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)',
                     dtick: 24 },
            yaxis: { title: { text: 'Members', font: { size: 10 } },
                     tickfont: { size: 10 },
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)',
                     range: [0, Math.max(5, maxCount * 1.2)] },
            showlegend: false,
        });
        Plotly.react(el, [trace], layout,
                     { responsive: true, displayModeBar: false });
    }

    // Compute a basin window large enough to contain the mean track AND
    // the first-genesis cloud (if non-empty). Padded so the spaghetti
    // around the cloud edges doesn't get clipped at the axis margin.
    function _genesisBoundsFromMean(meanLats, meanLons, extraLats, extraLons,
                                     targetAspect) {
        var lats = meanLats.slice();
        var lons = meanLons.slice();
        if (extraLats && extraLats.length) lats = lats.concat(extraLats);
        if (extraLons && extraLons.length) lons = lons.concat(extraLons);
        if (!lats.length) {
            return { lat: [-10, 50], lon: [100, 180] };
        }
        var latMin = Math.min.apply(null, lats);
        var latMax = Math.max.apply(null, lats);
        var lonMin = Math.min.apply(null, lons);
        var lonMax = Math.max.apply(null, lons);
        var lpad = Math.max(6, 0.25 * (latMax - latMin));
        var npad = Math.max(8, 0.30 * (lonMax - lonMin));
        var bLat = [Math.max(-80, latMin - lpad), Math.min(80, latMax + lpad)];
        var bLon = [lonMin - npad, lonMax + npad];
        // Pad lon to hit the modal's target aspect ratio so we use the
        // horizontal whitespace instead of squeezing into a square. The
        // Mercator scale factor at the bounds' centerline maps geographic
        // degrees to roughly equal pixels in either direction.
        if (targetAspect && targetAspect > 0) {
            var centerLat = (bLat[0] + bLat[1]) / 2;
            var cosLat = Math.max(0.2, Math.cos(centerLat * Math.PI / 180));
            var latSpan = bLat[1] - bLat[0];
            var lonSpan = bLon[1] - bLon[0];
            var desiredLonSpan = latSpan * targetAspect / cosLat;
            if (desiredLonSpan > lonSpan) {
                var extra = (desiredLonSpan - lonSpan) / 2;
                bLon = [bLon[0] - extra, bLon[1] + extra];
            }
        }
        return { lat: bLat, lon: bLon };
    }

    // Deep-clone an object via JSON round-trip. Adequate for Plotly
    // layout/data (plain JSON-safe values; no functions, no DOM refs).
    function _jsonClone(obj) {
        try { return JSON.parse(JSON.stringify(obj)); }
        catch (_) { return obj; }
    }

    // Walk an object tree and scale every `size` field that lives inside
    // a `font` or `tickfont` container (Plotly's font-size convention).
    // Used at export time so all axis labels, tick labels, legends,
    // titles, annotations, and colorbar fonts grow proportionally with
    // the high-res output canvas instead of looking tiny.
    function _scaleFontSizes(node, scale, parentKey) {
        if (!node || typeof node !== 'object') return;
        // `textfont` covers Plotly bar/scatter `text=` annotations (the
        // numerical labels on top of histogram bars — easily missed
        // until they look like dust at 1800-px export width).
        var fontish = (parentKey === 'font' || parentKey === 'tickfont' ||
                       parentKey === 'titlefont' || parentKey === 'hoverlabel' ||
                       parentKey === 'textfont' || parentKey === 'outsidetextfont' ||
                       parentKey === 'insidetextfont');
        if (fontish && typeof node.size === 'number') {
            node.size = Math.round(node.size * scale);
        }
        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) {
                _scaleFontSizes(node[i], scale, parentKey);
            }
            return;
        }
        for (var k in node) {
            if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
            _scaleFontSizes(node[k], scale, k);
        }
    }

    // Build a Plotly figure spec `{data, layout}` from a live chart div
    // with all font sizes scaled by `scale`. Use this with Plotly.toImage
    // instead of passing the bare DOM element — the live chart keeps its
    // on-screen font sizes while the export gets readable proportions.
    // Also fills in default sizes for fields Plotly leaves implicit
    // (so the scale actually takes effect everywhere).
    function _figForExport(el, scale) {
        if (!el || !el.data || !el.layout) return el;
        var layout = _jsonClone(el.layout);
        var data = _jsonClone(el.data);
        // Seed defaults so the recursive scaler has something to multiply.
        // Plotly's stock default body-font size is 12 px.
        layout.font = layout.font || {};
        if (typeof layout.font.size !== 'number') layout.font.size = 12;
        // Force-scale the explicit font containers we care most about,
        // even if absent.
        ['xaxis', 'yaxis', 'xaxis2', 'yaxis2', 'xaxis3', 'yaxis3'].forEach(
            function (axKey) {
                var ax = layout[axKey];
                if (!ax) return;
                ax.tickfont = ax.tickfont || { size: 12 };
                if (typeof ax.tickfont.size !== 'number') ax.tickfont.size = 12;
                if (ax.title && typeof ax.title === 'object') {
                    ax.title.font = ax.title.font || { size: 14 };
                    if (typeof ax.title.font.size !== 'number') {
                        ax.title.font.size = 14;
                    }
                }
            });
        if (layout.legend) {
            layout.legend.font = layout.legend.font || { size: 12 };
            if (typeof layout.legend.font.size !== 'number') {
                layout.legend.font.size = 12;
            }
        }
        // Colorbars live on the data traces, not the layout. Two
        // export-specific tweaks:
        //   1. Seed default font sizes so the recursive scaler has
        //      something to multiply.
        //   2. Move the colorbar title above the bar (`side:'top'`) and
        //      add `xpad` for breathing room — at on-screen sizes a
        //      side-rotated "Vmax (kt)" sits cleanly next to short
        //      ticks like "30", but at 2.8× scale with wide ticks like
        //      "113 C4" the rotated title collides into the labels.
        for (var i = 0; i < data.length; i++) {
            var d = data[i];
            function _bumpColorbar(cb) {
                cb.tickfont = cb.tickfont || { size: 12 };
                if (typeof cb.tickfont.size !== 'number') {
                    cb.tickfont.size = 12;
                }
                if (cb.title && typeof cb.title === 'object') {
                    cb.title.font = cb.title.font || { size: 14 };
                    if (typeof cb.title.font.size !== 'number') {
                        cb.title.font.size = 14;
                    }
                    cb.title.side = 'top';
                } else if (typeof cb.title === 'string') {
                    cb.title = { text: cb.title,
                                 font: { size: 14 },
                                 side: 'top' };
                }
                // Extra padding so the (still-scaled) ticks don't crowd
                // the colorbar border. Defaults: xpad=10, ypad=10.
                cb.xpad = Math.max(cb.xpad || 10, 20);
                cb.ypad = Math.max(cb.ypad || 10, 20);
            }
            if (d && d.marker && d.marker.colorbar) _bumpColorbar(d.marker.colorbar);
            if (d && d.colorbar)                    _bumpColorbar(d.colorbar);
        }
        _scaleFontSizes(layout, scale);
        _scaleFontSizes(data, scale);
        // Scale per-trace marker sizes + line widths. Plotly markers
        // don't follow `font.size` — they're an independent dimension
        // measured in absolute pixels — so on a 1800-px export at
        // on-screen sizes they look like dots. Use full `scale` for
        // markers, sqrt(scale) for line widths so lines thicken
        // proportionally less than markers (keeps spaghetti tracks
        // from turning into bars).
        var lineScale = Math.sqrt(scale);
        for (var ti = 0; ti < data.length; ti++) {
            var dt = data[ti];
            if (!dt) continue;
            if (dt.marker && dt.marker.size != null) {
                if (Array.isArray(dt.marker.size)) {
                    dt.marker.size = dt.marker.size.map(function (s) {
                        return typeof s === 'number'
                            ? Math.round(s * scale) : s;
                    });
                } else if (typeof dt.marker.size === 'number') {
                    dt.marker.size = Math.round(dt.marker.size * scale);
                }
            }
            if (dt.marker && dt.marker.line
                && typeof dt.marker.line.width === 'number') {
                dt.marker.line.width = +(dt.marker.line.width
                                         * lineScale).toFixed(2);
            }
            if (dt.line && typeof dt.line.width === 'number') {
                dt.line.width = +(dt.line.width * lineScale).toFixed(2);
            }
        }
        // Scale margins too — bigger axis titles and tick labels need
        // proportionally more room or they get clipped at panel edges.
        // Use the existing margin as the baseline (fall back to Plotly
        // defaults: l/r=80, t=100, b=80) so we don't shrink margins
        // when the source chart already configured generous ones.
        var m = layout.margin || {};
        layout.margin = {
            l: Math.round(Math.max(m.l != null ? m.l : 80, 40) * scale),
            r: Math.round(Math.max(m.r != null ? m.r : 80, 40) * scale),
            t: Math.round(Math.max(m.t != null ? m.t : 50, 30) * scale),
            b: Math.round(Math.max(m.b != null ? m.b : 80, 50) * scale),
            pad: m.pad,
        };
        return { data: data, layout: layout };
    }

    // Export a 3-panel composite (map + intensity + genesis-time
    // histogram) as a single PNG. Uses Plotly.toImage for each subplot
    // then stitches them on a canvas with a header strip showing the
    // disturbance label, init time, formation %, and peak Vmax —
    // saves the user from having to assemble the three single-panel
    // PNGs in PowerPoint / Keynote.
    function _genesisSaveSummaryPNG() {
        if (typeof Plotly === 'undefined') return;
        var mapEl   = document.getElementById('rt-genesis-modal-map');
        var intEl   = document.getElementById('rt-genesis-modal-int');
        var gtimeEl = document.getElementById('rt-genesis-modal-gtime');
        if (!mapEl || !intEl) return;
        var btn = document.getElementById('rt-genesis-summary-save');
        var origText = btn ? btn.textContent : null;
        if (btn) { btn.textContent = 'Rendering…'; btn.disabled = true; }

        // Density-mode square markers are sized in absolute pixels and
        // don't scale correctly when Plotly.toImage resizes the chart
        // for the export — at 1800 px width the markers grow to fill
        // the whole map. Temporarily repaint in Members mode for the
        // export, then restore the user's selected mode after.
        var origMode = _genesisTauState && _genesisTauState.mode;
        var origIdx = _genesisTauState && _genesisTauState.idx;
        var modeWasDensity = (origMode === 'density');
        if (modeWasDensity && _genesisTauState && _genesisTauState.taus) {
            _genesisTauState.mode = 'members';
            var tau = _genesisTauState.taus[origIdx];
            _genesisPaintTauCursor(tau, _genesisTauState.byTau[tau] || []);
        }
        function restoreMode() {
            if (modeWasDensity && _genesisTauState) {
                _genesisTauState.mode = 'density';
                var t = _genesisTauState.taus[_genesisTauState.idx];
                _genesisPaintTauCursor(t, _genesisTauState.byTau[t] || []);
            }
        }

        var W = 1800;
        var HEAD = 180;
        var H_MAP = 1000;
        var H_INT = 760;
        var H_GTIME = gtimeEl ? 540 : 0;
        var GAP = 18;
        var FOOT = 64;
        var totalH = HEAD + H_MAP + GAP + H_INT + (H_GTIME ? GAP + H_GTIME : 0) + FOOT;
        // Scale Plotly fonts ~2.8× so axis labels, ticks, legends, and
        // colorbar labels look proportional at 1800-px export width
        // instead of carrying their on-screen ~12-px sizes. Markers
        // and line widths also scale (see _figForExport) so spaghetti
        // tracks and intensity dots read at the same visual weight as
        // the labels. Panel heights above grew correspondingly so the
        // scaled margins don't squeeze the plot area.
        var FONT_SCALE = 2.8;

        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var bg = isDark ? '#0f172a' : '#ffffff';
        var ink = isDark ? '#f1f5f9' : '#0f172a';
        var dim = isDark ? '#94a3b8' : '#475569';

        // Pull the header info out of the modal so the export reads
        // self-contained (init time, label, formation %, peak Vmax).
        var titleEl = document.getElementById('rt-genesis-modal-title');
        var subEl   = document.getElementById('rt-genesis-modal-sub');
        var statsEl = document.getElementById('rt-genesis-modal-stats');
        var title = titleEl ? titleEl.textContent : 'FNV3 cyclogenesis ensemble';
        var sub = subEl ? subEl.textContent.replace(/\s+/g, ' ').trim() : '';
        // Strip the "Next cycle ~Nm" ETA from the saved PNG — it's a
        // live countdown that's meaningless once the image is offline
        // (and dates the export the moment a new cycle drops). The
        // live modal still shows it; this only edits the export copy.
        sub = sub.replace(/\s*·\s*Next cycle[^·]*/i, '').trim();

        // Render each subplot to a PNG dataURL at the target width.
        // Pass a font-scaled figure spec instead of the live DOM element
        // so axis/tick/legend/colorbar fonts grow to readable proportions
        // at 1800-px export width without affecting the on-screen chart.
        var tasks = [
            Plotly.toImage(_figForExport(mapEl, FONT_SCALE),
                           { format: 'png', width: W, height: H_MAP }),
            Plotly.toImage(_figForExport(intEl, FONT_SCALE),
                           { format: 'png', width: W, height: H_INT }),
        ];
        if (gtimeEl) {
            tasks.push(Plotly.toImage(_figForExport(gtimeEl, FONT_SCALE),
                                      { format: 'png',
                                        width: W, height: H_GTIME }));
        }

        Promise.all(tasks).then(function (urls) {
            var imgs = urls.map(function (u) {
                var im = new Image();
                im.src = u;
                return im;
            });
            return Promise.all(imgs.map(function (im) {
                return new Promise(function (res, rej) {
                    if (im.complete) res(im);
                    else { im.onload = function () { res(im); }; im.onerror = rej; }
                });
            }));
        }).then(function (imgs) {
            var canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = totalH;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, W, totalH);

            // Header — sizes chosen for 1800-px export width. Subtitle
            // bumped 28 → 34 px so the init-time + members line is
            // legible alongside the bigger Plotly fonts inside the
            // panels below.
            ctx.fillStyle = ink;
            ctx.font = '600 56px Inter, "Helvetica Neue", sans-serif';
            ctx.textBaseline = 'top';
            ctx.fillText(title, 40, 32);
            ctx.fillStyle = dim;
            ctx.font = '34px Inter, "Helvetica Neue", sans-serif';
            ctx.fillText(sub, 40, 108);

            var y = HEAD;
            ctx.drawImage(imgs[0], 0, y);  y += H_MAP + GAP;
            ctx.drawImage(imgs[1], 0, y);  y += H_INT + GAP;
            if (imgs[2]) {
                ctx.drawImage(imgs[2], 0, y);
                y += H_GTIME;
            }

            // Footer attribution
            ctx.fillStyle = dim;
            ctx.font = '24px Inter, "Helvetica Neue", sans-serif';
            var saved = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
            ctx.fillText('TC-ATLAS · DeepMind FNV3 LARGE_ENSEMBLE · saved ' + saved,
                         40, totalH - 44);

            canvas.toBlob(function (blob) {
                if (!blob) throw new Error('toBlob returned null');
                var dateISO = new Date().toISOString().slice(0, 10);
                var slug = title.replace(/[^a-z0-9]+/gi, '-')
                                .replace(/^-+|-+$/g, '').toLowerCase()
                                .slice(0, 40) || 'summary';
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'tc-atlas-genesis-' + slug + '-' + dateISO + '.png';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
                if (btn) { btn.textContent = origText; btn.disabled = false; }
                restoreMode();
                _ga('rt_genesis_save_summary_png');
            }, 'image/png');
        }).catch(function (err) {
            console.warn('[Genesis] summary PNG export failed', err);
            if (btn) { btn.textContent = origText; btn.disabled = false; }
            restoreMode();
        });
    }

    function _genesisSavePNG(elId, slug) {
        var el = document.getElementById(elId);
        if (!el || typeof Plotly === 'undefined') return;
        var rect = el.getBoundingClientRect();
        var dateISO = new Date().toISOString().slice(0, 10);
        Plotly.toImage(el, {
            format: 'png',
            width: Math.round(rect.width * 2),
            height: Math.round(rect.height * 2),
        }).then(function (url) {
            var a = document.createElement('a');
            a.href = url;
            a.download = 'tc-atlas-genesis-' + slug + '-' + dateISO + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }).catch(function () { /* silent */ });
        _ga('rt_genesis_save_png', { chart: slug });
    }

    // Auto-repoll: re-check the genesis endpoint at most this often (ms).
    // 30 min lines up with the publish-lag window — DeepMind cycles drop
    // ~3–5 h after init, so a half-hour heartbeat picks up new cycles
    // within ~30 min of publication without hammering the backend.
    var _GENESIS_REPOLL_MS = 30 * 60 * 1000;
    var _genesisRepollTimer = null;
    var _genesisLastInit = null;

    function _formatGenesisAge(ageH) {
        if (ageH == null || !isFinite(ageH)) return '';
        if (ageH < 1) return Math.round(ageH * 60) + ' min old';
        if (ageH < 24) return ageH.toFixed(1) + ' h old';
        return Math.round(ageH / 24) + ' d old';
    }

    // Fetch the server's precomputed TC-ATLAS clusters for the current
    // cycle + current tuner params. Replaces the old per-track prefetch
    // approach: one ~50 KB request, instant render, no per-user ~8 MB
    // download, no client-side clustering CPU. Server caches by
    // (init_time, params) so the default-param result is served from
    // RAM after the first hit each cycle.
    function _loadGenesisClusters() {
        if (!_rtGenesisData || _rtGenesisClustersLoading) return;
        var curParams = _genesisCurrentClusterParams();
        if (_rtGenesisClusters
                && _rtGenesisClusters.init_time === _rtGenesisData.init_time
                && _genesisClusterParamsMatch(_rtGenesisClusters.params)) {
            return;   // already have it
        }
        _rtGenesisClustersLoading = true;
        var qs = '?' + Object.keys(curParams).map(function (k) {
            return k + '=' + encodeURIComponent(curParams[k]);
        }).join('&');
        fetch(API_BASE + '/ir-monitor/weatherlab-genesis-clusters' + qs,
              { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (json) {
                _rtGenesisClusters = {
                    init_time: json.init_time,
                    params: json.params,
                    clusters: json.clusters || [],
                };
                if (_rtGenesisVisible && _genesisClusterMethod === 'tcatlas') {
                    _renderGenesis();
                }
                _ga('rt_genesis_clusters_loaded', {
                    n_clusters: (json.clusters || []).length,
                    init: json.init_time,
                });
            })
            .catch(function (err) {
                console.warn('[Genesis] cluster fetch failed', err);
            })
            .finally(function () {
                _rtGenesisClustersLoading = false;
            });
    }

    function _loadGenesis(isAutoRefresh) {
        if (_rtGenesisLoading) return;
        _rtGenesisLoading = true;
        var statusEl = document.getElementById('ir-genesis-status');
        // Only show the "Loading…" placeholder on the first load — a
        // background re-poll shouldn't make the panel flicker.
        if (statusEl && !isAutoRefresh) {
            statusEl.textContent = 'Loading 1000-member ensemble…';
        }

        fetch(API_BASE + '/ir-monitor/weatherlab-genesis', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                var newInit = data && data.init_time;
                var prevInit = _genesisLastInit;
                _genesisLastInit = newInit;

                // If a background re-poll returned the same cycle we
                // already have, skip the re-render to avoid touching
                // active layers / popups for no benefit.
                if (isAutoRefresh && newInit && prevInit && newInit === prevInit) {
                    _ga('rt_genesis_repoll_nochange', { init: newInit });
                } else {
                    _rtGenesisData = data;
                    if (_rtGenesisVisible) _renderGenesis();
                    if (_rtGenesisSpaghettiVisible) _renderGenesisSpaghetti();
                    if (_rtGenesisRawVisible) _renderGenesisRaw();
                    if (isAutoRefresh && prevInit && newInit && newInit !== prevInit) {
                        _ga('rt_genesis_newer_cycle', { from: prevInit, to: newInit });
                    }
                    // Fetch the server's precomputed TCA clusters so
                    // the on-map markers show accurate uncapped counts
                    // without any client-side clustering work.
                    _loadGenesisClusters();
                }

                if (statusEl) {
                    var n = data && data.n_tracks ? data.n_tracks : 0;
                    var ageBit = data && data.cycle_age_hours != null
                        ? ' · ' + _formatGenesisAge(data.cycle_age_hours)
                        : '';
                    if (n === 0) {
                        statusEl.textContent = 'No genesis predicted in next 15 days'
                            + (newInit
                                ? ' · init ' + newInit.slice(0, 8) + ' ' + newInit.slice(8) + 'Z' + ageBit
                                : '');
                    } else {
                        statusEl.textContent = n + ' genesis track'
                            + (n === 1 ? '' : 's')
                            + (data.thinned_to ? ' · thinned to ' + data.thinned_to + '/track' : '')
                            + (newInit ? ' · init ' + newInit.slice(0,8) + ' ' + newInit.slice(8) + 'Z' : '')
                            + ageBit;
                    }
                }
                _ga('rt_genesis_loaded', { n_tracks: data && data.n_tracks,
                                            init: newInit,
                                            age_h: data && data.cycle_age_hours,
                                            auto: !!isAutoRefresh });
            })
            .catch(function (err) {
                console.warn('[Genesis] fetch failed', err);
                if (statusEl && !isAutoRefresh) statusEl.textContent = 'Unavailable';
            })
            .finally(function () { _rtGenesisLoading = false; });

        // (Re-)arm the background re-poll. setInterval would keep firing
        // even when the tab is hidden, so we use a setTimeout chain that
        // also gates on document.visibilityState — no point hitting the
        // backend on a backgrounded tab.
        if (_genesisRepollTimer) clearTimeout(_genesisRepollTimer);
        _genesisRepollTimer = setTimeout(function tick() {
            if (document.visibilityState === 'visible') {
                _loadGenesis(true);
            } else {
                // Tab hidden — reschedule a shorter retry so we catch
                // back up promptly when the user returns.
                _genesisRepollTimer = setTimeout(tick, 60 * 1000);
            }
        }, _GENESIS_REPOLL_MS);
    }

    /** Toggle just the spaghetti tracks layer (called from the menu). */
    function toggleGenesis() {
        _rtGenesisVisible = !_rtGenesisVisible;
        if (_rtGenesisVisible) {
            if (!_rtGenesisData) _loadGenesis(); else _renderGenesis();
            // Re-paint the spaghetti too if it was already toggled on
            // (e.g., user turned cyclogenesis off and back on).
            if (_rtGenesisSpaghettiVisible && _rtGenesisData) {
                _renderGenesisSpaghetti();
            }
        } else {
            _clearGenesis();
            _clearGenesisSpaghetti();   // dependent layer goes too
        }
        if (typeof _refreshLayersCount === 'function') _refreshLayersCount();
    }
    window.toggleGenesis = toggleGenesis;

    function _clearGenesisSpaghetti() {
        for (var i = 0; i < _rtGenesisSpaghettiLayers.length; i++) {
            if (map) map.removeLayer(_rtGenesisSpaghettiLayers[i]);
        }
        _rtGenesisSpaghettiLayers = [];
    }

    /** Draw per-member polylines for every qualifying disturbance,
     *  colored by that disturbance's predicted peak intensity. Each
     *  member is one faint line; the bunching pattern shows where
     *  the ensemble agrees vs diverges. Same color logic as the
     *  detail modal's track figure so the visual language stays
     *  consistent across surfaces. */
    function _renderGenesisSpaghetti() {
        _clearGenesisSpaghetti();
        if (!_rtGenesisData || !map) return;
        var rawTracks = _rtGenesisData.tracks || [];
        if (!rawTracks.length) return;
        var disturbances = _genesisDisturbances(rawTracks);
        for (var di = 0; di < disturbances.length; di++) {
            var d = disturbances[di];
            var style = _genesisCatStyle(d.peakWind);
            var members = d.raw.members || {};
            var memberKeys = Object.keys(members);
            for (var mi = 0; mi < memberKeys.length; mi++) {
                var pts = members[memberKeys[mi]].points;
                if (!pts || pts.length < 2) continue;
                var latlngs = [];
                for (var pi = 0; pi < pts.length; pi++) {
                    latlngs.push([pts[pi].lat, pts[pi].lon]);
                }
                var segs = splitAtAntimeridian(latlngs);
                // Per-member peak Vmax for the popup color (each member
                // gets its own SS shade, not just the cluster's).
                var memberPeak = 0;
                for (var pp = 0; pp < pts.length; pp++) {
                    if (pts[pp].wind != null && pts[pp].wind > memberPeak) memberPeak = pts[pp].wind;
                }
                var memberKeyLocal = memberKeys[mi];
                var ptsLocal = pts;
                var initIso = (_rtGenesisData && _rtGenesisData.init_time) || null;
                var trackLabel = d.displayLabel || null;
                for (var si = 0; si < segs.length; si++) {
                    if (segs[si].length < 2) continue;
                    var line = L.polyline(segs[si], {
                        color: style.faint,
                        weight: 0.7,
                        opacity: 1.0,      // alpha lives in style.faint
                        interactive: false,
                    }).addTo(map);
                    _rtGenesisSpaghettiLayers.push(line);

                    // Invisible hit-target so the user can actually click
                    // an individual member out of the spaghetti tangle.
                    (function (segLatLngs, mk, pp_, pw, init, label) {
                        var hit = _addGenesisMemberHitLayer(map, segLatLngs, function (e) {
                            _openGenesisMemberPopup(e.latlng, mk, pp_, init, pw, label);
                        });
                        _rtGenesisSpaghettiLayers.push(hit);
                    })(segs[si], memberKeyLocal, ptsLocal, memberPeak, initIso, trackLabel);
                }
            }
        }
    }

    function toggleGenesisSpaghetti() {
        _rtGenesisSpaghettiVisible = !_rtGenesisSpaghettiVisible;
        if (_rtGenesisSpaghettiVisible) {
            // Auto-enable the parent cyclogenesis layer if it's off —
            // the spaghetti only makes sense when the disturbance
            // markers are also visible.
            if (!_rtGenesisVisible) toggleGenesis();
            if (_rtGenesisData) _renderGenesisSpaghetti();
        } else {
            _clearGenesisSpaghetti();
        }
        if (typeof _refreshLayersCount === 'function') _refreshLayersCount();
    }
    window.toggleGenesisSpaghetti = toggleGenesisSpaghetti;

    function _clearGenesisRaw() {
        for (var i = 0; i < _rtGenesisRawLayers.length; i++) {
            if (map) map.removeLayer(_rtGenesisRawLayers[i]);
        }
        _rtGenesisRawLayers = [];
    }

    /** Open a small Leaflet popup at `latlng` showing this one member's
     *  forecast intensity time series. Built lazily so we only pay the
     *  Plotly draw cost when the user actually clicks something. Layout
     *  is theme-aware via the standard surface/text CSS vars so it
     *  matches whatever mode the user is in.
     *
     *  Args:
     *    latlng    — Leaflet LatLng where the click landed
     *    memberKey — string ID of the member (used in the popup header)
     *    pts       — array of { tau, lat, lon, wind } for this member
     *    initIso   — init time string like "20260523120000" (may be falsy)
     *    peakWind  — pre-computed peak Vmax (kt); drives the cat color
     *    trackLabel— optional context line ("D1 · 78% form prob", etc.)
     */
    function _openGenesisMemberPopup(latlng, memberKey, pts, initIso, peakWind, trackLabel) {
        if (!map || !pts || pts.length < 2) return;
        var style = _genesisCatStyle(peakWind);
        var cat = style.cat;

        // First-genesis time (first point at ≥34 kt).
        var firstGenTau = null;
        for (var i = 0; i < pts.length; i++) {
            if (pts[i].wind != null && pts[i].wind >= 34) {
                firstGenTau = pts[i].tau;
                break;
            }
        }

        // Init Date for x-axis labels. Parse "YYYYMMDDHH" or "YYYYMMDDHHMMSS".
        var initDate = null;
        if (initIso && initIso.length >= 10) {
            initDate = new Date(Date.UTC(
                +initIso.slice(0, 4), +initIso.slice(4, 6) - 1, +initIso.slice(6, 8),
                +initIso.slice(8, 10),
                initIso.length >= 12 ? +initIso.slice(10, 12) : 0));
        }

        var plotDivId = 'rt-gen-member-plot-' + Date.now();
        var headerBits = ['<b>Member ' + memberKey + '</b>'];
        if (trackLabel) headerBits.push('<span style="opacity:0.75;">' + trackLabel + '</span>');
        var peakLine = 'Peak: <b style="color:' + style.bold + ';">'
            + Math.round(peakWind) + ' kt</b> · ' + cat;
        var genLine = firstGenTau != null
            ? 'First 34 kt at +' + firstGenTau + 'h'
            : 'Never reaches TC strength';

        var html =
            '<div class="rt-gen-member-popup" style="width:300px;font-size:11px;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;'
                + 'margin-bottom:4px;gap:8px;">' +
                '<div>' + headerBits.join(' &middot; ') + '</div>' +
              '</div>' +
              '<div style="opacity:0.85;margin-bottom:6px;">' + peakLine + ' &middot; '
                + genLine + '</div>' +
              '<div id="' + plotDivId + '" style="width:300px;height:170px;"></div>' +
            '</div>';

        var popup = L.popup({
            maxWidth: 320,
            minWidth: 300,
            autoPanPadding: [40, 40],
            className: 'rt-gen-member-leaflet-popup',
            closeButton: true,
        })
            .setLatLng(latlng)
            .setContent(html)
            .openOn(map);

        // Plotly needs the div in the DOM before plotting. openOn already
        // injected the popup, but defer to next tick so layout is final.
        setTimeout(function () {
            var el = document.getElementById(plotDivId);
            if (!el || typeof Plotly === 'undefined') return;

            // Build x (forecast hour or absolute time) + y (wind) arrays.
            var xs = [], ys = [];
            for (var k = 0; k < pts.length; k++) {
                if (pts[k].wind == null || pts[k].tau == null) continue;
                if (initDate) {
                    xs.push(new Date(initDate.getTime() + pts[k].tau * 3600000));
                } else {
                    xs.push(pts[k].tau);
                }
                ys.push(pts[k].wind);
            }
            if (xs.length < 2) {
                el.innerHTML = '<div style="text-align:center;opacity:0.6;padding:30px;'
                    + 'font-size:11px;">No wind data</div>';
                return;
            }

            var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            var paper = 'rgba(0,0,0,0)';
            var grid  = isDark ? 'rgba(148,163,184,0.25)' : 'rgba(100,116,139,0.25)';
            var axis  = isDark ? '#e2e8f0' : '#1e293b';

            // Shaded SS bands behind the line — gives the eye an instant
            // "what cat is this" without reading the y-axis.
            var bands = [
                { y0: 34,  y1: 64,  c: 'rgba(56,189,248,0.10)' },   // TS
                { y0: 64,  y1: 83,  c: 'rgba(250,204,21,0.12)' },   // C1
                { y0: 83,  y1: 96,  c: 'rgba(249,115,22,0.12)' },   // C2
                { y0: 96,  y1: 113, c: 'rgba(239,68,68,0.12)' },    // C3
                { y0: 113, y1: 137, c: 'rgba(217,70,239,0.12)' },   // C4
                { y0: 137, y1: 200, c: 'rgba(168,85,247,0.14)' },   // C5
            ];
            var shapes = bands.map(function (b) {
                return { type: 'rect', xref: 'paper', yref: 'y',
                    x0: 0, x1: 1, y0: b.y0, y1: b.y1, fillcolor: b.c,
                    line: { width: 0 }, layer: 'below' };
            });
            // 34-kt genesis threshold
            shapes.push({
                type: 'line', xref: 'paper', yref: 'y',
                x0: 0, x1: 1, y0: 34, y1: 34,
                line: { color: axis, width: 0.7, dash: 'dot' },
                opacity: 0.5, layer: 'below',
            });

            var yMax = Math.max(80, Math.ceil(Math.max.apply(null, ys) / 10) * 10 + 10);

            Plotly.newPlot(el, [{
                x: xs, y: ys,
                type: 'scatter', mode: 'lines+markers',
                line: { color: style.bold, width: 2 },
                marker: { color: style.bold, size: 4 },
                hovertemplate: (initDate
                    ? '%{x|%b %d %HZ}'
                    : '+%{x}h'
                    ) + ' · <b>%{y:.0f} kt</b><extra></extra>',
                name: 'Member ' + memberKey,
            }], {
                paper_bgcolor: paper,
                plot_bgcolor: paper,
                margin: { l: 36, r: 8, t: 6, b: 28 },
                xaxis: {
                    color: axis, gridcolor: grid, zeroline: false,
                    tickfont: { size: 9 },
                    type: initDate ? 'date' : 'linear',
                },
                yaxis: {
                    title: { text: 'Vmax (kt)', font: { size: 10, color: axis } },
                    color: axis, gridcolor: grid, zeroline: false,
                    range: [0, yMax],
                    tickfont: { size: 9 },
                },
                shapes: shapes,
                showlegend: false,
                hovermode: 'x',
            }, { displayModeBar: false, responsive: false });
        }, 20);

        _ga('rt_genesis_member_inspect', { member: memberKey, peak_kt: Math.round(peakWind) });
    }

    /** Add a wider invisible hit-target polyline behind a thin visible
     *  one so clicking the 0.7-px stroke is actually possible. Returns
     *  the hit layer so it can be pushed into the cleanup array. The
     *  click handler fires `onClick(e)` with the Leaflet click event. */
    function _addGenesisMemberHitLayer(map_, segLatLngs, onClick) {
        var hit = L.polyline(segLatLngs, {
            color: '#000',
            weight: 10,
            opacity: 0,        // fully transparent — SVG still captures clicks
            interactive: true,
            bubblingMouseEvents: false,
        }).addTo(map_);
        hit.on('click', function (e) {
            try { onClick(e); }
            catch (err) { console.warn('[Genesis] member click handler failed:', err); }
            L.DomEvent.stopPropagation(e);
        });
        // Pointer cursor on hover so it's obvious lines are interactive.
        hit.on('mouseover', function () {
            var el = hit.getElement && hit.getElement();
            if (el) el.style.cursor = 'pointer';
        });
        return hit;
    }

    /** Render every ensemble member as: a small circle at its first-
     *  34kt point + its forecast track polyline. Independent of any
     *  clustering — gives the analyst the full ensemble distribution
     *  as context. Each member is colored by ITS OWN predicted peak
     *  Vmax (member-level SS color), not the cluster's, so high-end
     *  members stand out even within an otherwise weak cluster. */
    function _renderGenesisRaw() {
        _clearGenesisRaw();
        if (!_rtGenesisData || !map) return;
        var rawTracks = _rtGenesisData.tracks || [];
        if (!rawTracks.length) return;

        // Member-color helper — mirrors SS_COLORS via _genesisCatStyle
        // but returns rgba strings so we can directly stamp opacity.
        function rgba(hex, a) {
            var r = parseInt(hex.slice(1, 3), 16);
            var g = parseInt(hex.slice(3, 5), 16);
            var b = parseInt(hex.slice(5, 7), 16);
            return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        }

        for (var ti = 0; ti < rawTracks.length; ti++) {
            var trk = rawTracks[ti];
            var members = trk.members || {};
            var keys = Object.keys(members);
            for (var ki = 0; ki < keys.length; ki++) {
                var pts = members[keys[ki]].points;
                if (!pts || pts.length < 2) continue;

                // Find this member's peak Vmax + first-34kt point
                var firstGenPt = null, peakWind = 0;
                for (var pi = 0; pi < pts.length; pi++) {
                    var w = pts[pi].wind;
                    if (w == null) continue;
                    if (firstGenPt == null && w >= 34) firstGenPt = pts[pi];
                    if (w > peakWind) peakWind = w;
                }
                var style = _genesisCatStyle(peakWind);

                // Track polyline — faint, member's own peak color.
                var latlngs = [];
                for (var pj = 0; pj < pts.length; pj++) {
                    if (pts[pj].lat == null || pts[pj].lon == null) continue;
                    latlngs.push([pts[pj].lat, pts[pj].lon]);
                }
                if (latlngs.length < 2) continue;
                var segs = splitAtAntimeridian(latlngs);
                // Capture loop locals for the closure (avoids the var-
                // hoisting trap that would have every popup show the
                // last member's data).
                var memberKeyLocal = keys[ki];
                var ptsLocal = pts;
                var peakWindLocal = peakWind;
                var initIso = (_rtGenesisData && _rtGenesisData.init_time) || null;
                var trackLabel = null;
                if (trk.track_id && _genesisDisturbanceMeta[trk.track_id]) {
                    trackLabel = _genesisDisturbanceMeta[trk.track_id].label;
                }
                for (var si = 0; si < segs.length; si++) {
                    if (segs[si].length < 2) continue;
                    var line = L.polyline(segs[si], {
                        color: rgba(style.bold, 0.18),
                        weight: 0.7,
                        opacity: 1.0,
                        interactive: false,
                    }).addTo(map);
                    _rtGenesisRawLayers.push(line);

                    // Wider invisible hit-target so the thin visible
                    // line is actually clickable. Click → popup with
                    // this member's intensity time series.
                    (function (segLatLngs, mk, pp, pw, init, label) {
                        var hit = _addGenesisMemberHitLayer(map, segLatLngs, function (e) {
                            _openGenesisMemberPopup(e.latlng, mk, pp, init, pw, label);
                        });
                        _rtGenesisRawLayers.push(hit);
                    })(segs[si], memberKeyLocal, ptsLocal, peakWindLocal, initIso, trackLabel);
                }

                // Genesis dot — only if this member actually reaches
                // TC strength. Tiny circle at the first-34kt position.
                if (firstGenPt) {
                    var dot = L.circleMarker(
                        [firstGenPt.lat, firstGenPt.lon], {
                            radius: 2.2,
                            color: rgba(style.bold, 0.85),
                            fillColor: rgba(style.bold, 0.55),
                            fillOpacity: 1,
                            weight: 1,
                            opacity: 1,
                            interactive: false,
                        }).addTo(map);
                    _rtGenesisRawLayers.push(dot);
                }
            }
        }
    }

    function toggleGenesisRaw() {
        _rtGenesisRawVisible = !_rtGenesisRawVisible;
        if (_rtGenesisRawVisible) {
            // Auto-load the data if it isn't there yet. This layer
            // can run independently of the Cyclogenesis disturbance
            // layer — no auto-toggle of the parent here.
            if (!_rtGenesisData) {
                _loadGenesis();
            } else {
                _renderGenesisRaw();
            }
        } else {
            _clearGenesisRaw();
        }
        if (typeof _refreshLayersCount === 'function') _refreshLayersCount();
    }
    window.toggleGenesisRaw = toggleGenesisRaw;

    /** Activate a formation-probability env layer by name. Layers are
     *  categorized "genesis" but rendered exactly like env layers, so
     *  we reuse `_activateEnvLayer` to get the same hover + colorbar
     *  + opacity slider plumbing for free. */
    function _activateGenesisProbLayer(name) {
        var layers = (_rtEnvMetadata && _rtEnvMetadata.layers) || [];
        var L_ = layers.filter(function (x) { return x.name === name; })[0];
        if (L_) _activateEnvLayer(L_);
    }

    /** Legacy entry point — the dedicated Genesis dropdown is gone; the
     *  unified Layers panel now hosts all genesis controls. Kept as a
     *  redirect so any window.toggleGenesisMenu callers keep working. */
    function toggleGenesisMenu() { toggleLayersPanel(); }
    window.toggleGenesisMenu = toggleGenesisMenu;

    /** Legacy state-sync hook — the unified panel auto-syncs whenever
     *  _refreshLayersCount fires, so this is now just an alias. */
    function _refreshGenesisMenuStatus() { _refreshLayersCount(); }

    /** Legacy renderer — the standalone Genesis dropdown is gone.
     *  Re-routes to the unified Layers panel so any old call site
     *  keeps refreshing the visible UI. */
    function _renderGenesisMenu() { _renderLayersPanel(); }

    // ═══════════════════════════════════════════════════════════
    //  ENVIRONMENTAL ANALYSIS OVERLAYS (RT main map)
    // ═══════════════════════════════════════════════════════════
    //
    //  Reads /ir-monitor/env/layers (metadata.json sidecars produced by
    //  the build_env_overlays.py Cloud Run Job) and drops each requested
    //  layer onto the global Leaflet map as an L.imageOverlay covering
    //  the full world. Fields:
    //    * shear_200_850 — 200-850 hPa wind-shear magnitude (kt)
    //    * rh_700_400    — 700-400 hPa mean RH (%)
    //    * sst_oisst     — NOAA OISST daily SST (degC)

    function _loadEnvMetadata() {
        if (_rtEnvLoading || _rtEnvMetadata) return Promise.resolve();
        _rtEnvLoading = true;
        return fetch(API_BASE + '/ir-monitor/env/layers', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                _rtEnvMetadata = data;
                _renderEnvMenu();
            })
            .catch(function (err) {
                console.warn('[Env] metadata fetch failed', err);
                _rtEnvMetadata = { layers: [], error: String(err) };
                _renderEnvMenu();
            })
            .finally(function () { _rtEnvLoading = false; });
    }

    // ── Wind-barb canvas layer ──────────────────────────────
    //
    //  Custom Leaflet layer that draws standard meteorological wind
    //  barbs over the global map. Loads a packed (u, v) RGBA PNG into
    //  an offscreen canvas once, then on every map move/zoom samples
    //  u/v at zoom-appropriate grid spacing and draws barbs.

    var _WindBarbLayer = L.Layer.extend({
        initialize: function (meta) {
            this._meta = meta;
            this._uv = null;           // Uint8ClampedArray of RGBA pixels
            this._dw = 0;              // source width
            this._dh = 0;              // source height
            this._canvas = null;       // display canvas
            this._loaded = false;
        },

        onAdd: function (map) {
            this._map = map;
            var c = L.DomUtil.create('canvas', 'leaflet-wind-canvas');
            c.style.position = 'absolute';
            c.style.pointerEvents = 'none';
            c.style.zIndex = 425;
            map.getPanes().overlayPane.appendChild(c);
            this._canvas = c;

            var img = new Image();
            img.crossOrigin = 'anonymous';
            var self = this;
            img.onload = function () {
                var off = document.createElement('canvas');
                off.width = img.naturalWidth;
                off.height = img.naturalHeight;
                var ictx = off.getContext('2d', { willReadFrequently: true });
                ictx.drawImage(img, 0, 0);
                try {
                    self._uv = ictx.getImageData(0, 0, off.width, off.height).data;
                    self._dw = off.width;
                    self._dh = off.height;
                    self._loaded = true;
                    self._redraw();
                } catch (e) {
                    console.warn('[Wind] canvas tainted for ' + self._meta.name + '; barbs disabled', e);
                }
            };
            img.onerror = function () {
                console.warn('[Wind] PNG load failed for ' + self._meta.name);
            };
            img.src = this._meta.image_url;

            map.on('moveend zoomend resize', this._redraw, this);
            this._redraw();
            return this;
        },

        onRemove: function (map) {
            map.off('moveend zoomend resize', this._redraw, this);
            if (this._canvas && this._canvas.parentNode) {
                this._canvas.parentNode.removeChild(this._canvas);
            }
            this._canvas = null;
        },

        setOpacity: function (opacity) {
            if (this._canvas) this._canvas.style.opacity = opacity;
            return this;
        },

        _redraw: function () {
            if (!this._map || !this._canvas) return;
            var size = this._map.getSize();
            this._canvas.width = size.x;
            this._canvas.height = size.y;
            var topLeft = this._map.containerPointToLayerPoint([0, 0]);
            L.DomUtil.setPosition(this._canvas, topLeft);

            if (!this._loaded) return;

            var ctx = this._canvas.getContext('2d');
            ctx.clearRect(0, 0, size.x, size.y);
            // _drawWindBarb manages its own stroke/fill colors (halo +
            // cream ink). We just set the line caps once here.
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // Zoom-adaptive sampling spacing. Use whole degrees so the
            // barbs sit on a recognizable grid.
            var z = this._map.getZoom();
            var spacing = z <= 2 ? 8 : z <= 3 ? 5 : z <= 4 ? 3 : z <= 5 ? 1.5 : 1;

            var b = this._map.getBounds();
            var sLat = Math.floor(b.getSouth() / spacing) * spacing;
            var nLat = Math.ceil(b.getNorth() / spacing) * spacing;
            var wLon = Math.floor(b.getWest() / spacing) * spacing;
            var eLon = Math.ceil(b.getEast() / spacing) * spacing;

            var meta = this._meta;
            var uSpan = (meta.u_max - meta.u_min) / 255.0;
            var vSpan = (meta.v_max - meta.v_min) / 255.0;
            var uv = this._uv;
            var dw = this._dw;
            var dh = this._dh;

            for (var lat = sLat; lat <= nLat; lat += spacing) {
                for (var lon = wLon; lon <= eLon; lon += spacing) {
                    // Wrap lon into [-180, 180) so users panning past the
                    // dateline still sample the global UV grid (the map
                    // tiles repeat, so barbs need to as well).
                    var lonNorm = lon - 360 * Math.floor((lon + 180) / 360);
                    var sx = Math.floor((lonNorm + 180) / 360 * dw);
                    var sy = Math.floor((90 - lat) / 180 * dh);
                    if (sx < 0 || sx >= dw || sy < 0 || sy >= dh) continue;
                    var idx = (sy * dw + sx) * 4;
                    if (uv[idx + 3] === 0) continue;
                    var u_ms = meta.u_min + uv[idx] * uSpan;
                    var v_ms = meta.v_min + uv[idx + 1] * vSpan;
                    var pt = this._map.latLngToContainerPoint([lat, lon]);
                    _drawWindBarb(ctx, pt.x, pt.y, u_ms, v_ms, lat < 0);
                }
            }
        }
    });

    /**
     * Draw a single WMO-convention wind barb at (x, y) given (u, v) in
     * m/s. Style mirrors the climatology globe's `vendor/gc-atlas/
     * barbs.js`: tight glyph packing, cream "print ink" color, no
     * calm-marker circle, pennants→full feathers→half feather from
     * the tail (upwind end). NH places feathers on the observer's
     * LEFT when looking from station toward upwind (rotated -x);
     * SH flips to the RIGHT per Michael's request — most operational
     * charts use NH-only, but flipping is the geographically correct
     * thing to do.
     *
     * Glyph speeds:  pennant = 50 kt, full feather = 10 kt, half = 5 kt.
     */
    function _drawWindBarb(ctx, x, y, u, v, isSH) {
        var speed_kt = Math.sqrt(u * u + v * v) * 1.94384;
        if (speed_kt < 3) return;  // calm — render nothing (matches climatology)

        // Canvas-frame rotation that places the staff's tip (drawn at
        // rotated +y below) in the UPWIND direction. Working from the
        // ctx.rotate transform matrix:
        //   screen_x = x'·cos(θ) − y'·sin(θ)
        //   screen_y = x'·sin(θ) + y'·cos(θ)
        // we want (0, STAFF) → upwind on screen. For wind east
        // (u=1, v=0) upwind is west (screen −x), which requires θ=π/2
        // = atan2(u, v). For wind north (u=0, v=1) upwind is south
        // (screen +y), which needs θ=0 = atan2(0, 1) ✓.
        var fromRot = Math.atan2(u, v);

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(fromRot);

        var STAFF      = 20;
        var FEATHER    = 8;
        var FEATHER_H  = 4;
        var SPACING    = 2.4;     // tight packing (~30% of feather len)
        var PEN_BASE   = 3.5;     // pennant base along shaft

        // Empirical side per user feedback: my WMO derivation said
        // NH = +1 / SH = -1, but the resulting orientation read as
        // flipped on the live map. Inverting to NH = -1 / SH = +1
        // (feathers on rotated -x for NH, +x for SH). If this still
        // looks wrong, the answer is "flip the sign of `side`."
        var side = isSH ? +1 : -1;

        // Build paths once; we then stroke/fill them twice — first as
        // a wider dark "knockout" halo, then as the cream ink on top.
        // Without the halo the cream barbs blend into the lightest
        // vorticity / shear contour tones (pale pink ~ cream).
        var lines = new Path2D();
        lines.moveTo(0, 0);
        lines.lineTo(0, STAFF);

        // Speed decomposition (rounded down to 5-kt increments).
        var kt = speed_kt;
        var nPen  = Math.floor(kt / 50); kt -= nPen  * 50;
        var nFull = Math.floor(kt / 10); kt -= nFull * 10;
        var nHalf = (kt >= 4.5) ? 1 : 0;

        // Pennants closest to the tail (upwind tip), then feathers,
        // then a half feather. pos walks from the tail back toward
        // the station along the shaft.
        var pos = STAFF;
        var pennants = new Path2D();

        for (var i = 0; i < nPen; i++) {
            pennants.moveTo(0, pos);
            pennants.lineTo(0, pos - PEN_BASE);
            pennants.lineTo(side * FEATHER, pos);
            pennants.closePath();
            pos -= PEN_BASE + SPACING * 0.5;
        }
        for (var f = 0; f < nFull; f++) {
            lines.moveTo(0, pos);
            lines.lineTo(side * FEATHER, pos);
            pos -= SPACING;
        }
        if (nHalf) {
            // Set back one notch if the half feather is the only glyph
            // (matches the climatology globe convention so it doesn't
            // ride at the very tip alone).
            if (nPen === 0 && nFull === 0) pos -= SPACING;
            lines.moveTo(0, pos);
            lines.lineTo(side * FEATHER_H, pos);
        }

        // Pass 1 — dark halo (slightly wider than ink stroke).
        ctx.lineWidth = 3.0;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillStyle   = 'rgba(0, 0, 0, 0.55)';
        ctx.stroke(lines);
        if (nPen) { ctx.fill(pennants); ctx.stroke(pennants); }

        // Pass 2 — cream "print ink" on top (matches the climatology
        // globe). Reads warmer than pure white and stays legible over
        // both satellite IR and warm env-overlay tones.
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(244, 240, 224, 0.95)';
        ctx.fillStyle   = 'rgba(244, 240, 224, 0.95)';
        ctx.stroke(lines);
        if (nPen) { ctx.fill(pennants); ctx.stroke(pennants); }

        ctx.restore();
    }

    /** Return three L.imageOverlay copies at lon offsets [-360, 0, +360]
     *  so the raster repeats when the user pans past the dateline.
     *  Leaflet's worldCopyJump only re-centers — content layers don't
     *  auto-wrap, so we add the copies manually. */
    function _addRepeatingImageOverlays(image_url, bounds) {
        var b = L.latLngBounds(bounds);
        var sw = b.getSouthWest();
        var ne = b.getNorthEast();
        var copies = [];
        for (var off = -360; off <= 360; off += 360) {
            copies.push(L.imageOverlay(image_url, [
                [sw.lat, sw.lng + off],
                [ne.lat, ne.lng + off]
            ], { opacity: _rtEnvOpacity, interactive: false }).addTo(map));
        }
        return copies;
    }

    /** Deep-copy a GeoJSON FeatureCollection with every coordinate's
     *  longitude shifted by `dLon`. Used to produce ±360°-wrapped
     *  copies of contour layers so they remain visible when the user
     *  pans past the dateline. */
    function _shiftGeoJsonLon(geojson, dLon) {
        function shift(c) {
            if (typeof c[0] === 'number') return [c[0] + dLon, c[1]];
            var out = new Array(c.length);
            for (var i = 0; i < c.length; i++) out[i] = shift(c[i]);
            return out;
        }
        var feats = (geojson && geojson.features) || [];
        var outFeats = [];
        for (var i = 0; i < feats.length; i++) {
            var f = feats[i];
            if (!f.geometry || !f.geometry.coordinates) continue;
            outFeats.push({
                type: 'Feature',
                properties: f.properties,
                geometry: { type: f.geometry.type, coordinates: shift(f.geometry.coordinates) }
            });
        }
        return { type: 'FeatureCollection', features: outFeats };
    }

    function _activateEnvLayer(layer) {
        if (!map || !layer || _rtEnvActive[layer.name]) return;
        var bounds = layer.bounds || [[-90, -180], [90, 180]];

        // Three render paths depending on the layer's render_style:
        //   wind_barb   → custom WindBarbLayer (canvas, vector); wraps
        //                 internally by sampling lon mod 360
        //   contour     → L.geoJSON if geojson_url else L.imageOverlay;
        //                 add ±360°-shifted copies so contours repeat
        //   filled      → L.imageOverlay (raster); add ±360° copies too
        var overlays = [];
        var overlayKind;
        if (layer.render_style === 'wind_barb') {
            overlays = [new _WindBarbLayer(layer).addTo(map)];
            overlayKind = 'wind';
        } else if (layer.render_style === 'contour' && layer.geojson_url) {
            var geoLayer = L.geoJSON(null, {
                style: function (feature) {
                    return {
                        color: feature.properties.color || '#ffffff',
                        weight: 1.5,
                        opacity: _rtEnvOpacity,
                        interactive: false
                    };
                }
            }).addTo(map);
            overlays = [geoLayer];
            overlayKind = 'geojson';
            fetch(layer.geojson_url, { cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (geojson) {
                    if (!_rtEnvActive[layer.name]) return;  // user deactivated mid-fetch
                    // Add primary world + ±360° copies to the same
                    // L.geoJSON layer so contours stay visible past
                    // the dateline.
                    geoLayer.addData(geojson);
                    geoLayer.addData(_shiftGeoJsonLon(geojson, +360));
                    geoLayer.addData(_shiftGeoJsonLon(geojson, -360));
                    // Place value labels along each non-trivial line.
                    // Labels are only placed in the primary world copy
                    // to keep the DOM marker count manageable; users
                    // panning past the dateline still see the lines.
                    var labels = [];
                    var features = (geojson && geojson.features) || [];
                    for (var i = 0; i < features.length; i++) {
                        var ft = features[i];
                        var coords = ft.geometry && ft.geometry.coordinates;
                        if (!coords || coords.length < 20) continue;
                        var lvl = ft.properties && ft.properties.level;
                        if (lvl == null) continue;
                        var midIdx = Math.floor(coords.length / 2);
                        var mid = coords[midIdx];
                        var mk = L.marker([mid[1], mid[0]], {
                            icon: L.divIcon({
                                className: 'env-contour-label',
                                html: '' + Math.round(lvl),
                                iconSize: null,
                                iconAnchor: [10, 7]
                            }),
                            interactive: false,
                            keyboard: false,
                            opacity: _rtEnvOpacity
                        }).addTo(map);
                        labels.push(mk);
                    }
                    _rtEnvActive[layer.name].labels = labels;
                })
                .catch(function (err) {
                    console.warn('[Env] GeoJSON load failed for ' + layer.name + '; falling back to raster', err);
                    if (!_rtEnvActive[layer.name]) return;
                    map.removeLayer(geoLayer);
                    var rasters = _addRepeatingImageOverlays(layer.image_url, bounds);
                    _rtEnvActive[layer.name].overlays = rasters;
                    _rtEnvActive[layer.name].overlayKind = 'raster';
                });
        } else {
            overlays = _addRepeatingImageOverlays(layer.image_url, bounds);
            overlayKind = 'raster';
        }

        var entry = {
            overlays: overlays, layer: layer,
            overlayKind: overlayKind,
            canvas: null, ctx: null
        };
        _rtEnvActive[layer.name] = entry;

        // Preload the parallel data PNG into an offscreen canvas so we
        // can read raw values under the cursor for the hover tooltip.
        // crossOrigin='anonymous' is REQUIRED here — without it the canvas
        // becomes tainted and getImageData throws SecurityError. The bucket
        // serves PNGs with Access-Control-Allow-Origin via gsutil cors,
        // OR we set img.crossOrigin only on the data PNG (visualization
        // PNG stays without crossOrigin so it loads even if CORS isn't set).
        if (layer.data_url) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () {
                try {
                    var c = document.createElement('canvas');
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    var ctx = c.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(img, 0, 0);
                    entry.canvas = c;
                    entry.ctx = ctx;
                    entry.dataW = img.naturalWidth;
                    entry.dataH = img.naturalHeight;
                } catch (e) {
                    console.warn('[Env hover] canvas init failed for ' + layer.name, e);
                }
            };
            img.onerror = function () {
                console.warn('[Env hover] data PNG load failed (CORS?). Hover values disabled for ' + layer.name);
            };
            img.src = layer.data_url;
        }

        _ensureEnvHoverHandler();
        _renderEnvColorbar();
        if (typeof _refreshLayersCount === 'function') _refreshLayersCount();
        _ga('rt_env_layer_on', { layer: layer.name });
    }

    function _deactivateEnvLayer(name) {
        var entry = _rtEnvActive[name];
        if (!entry) return;
        if (entry.overlays && map) {
            for (var k = 0; k < entry.overlays.length; k++) {
                map.removeLayer(entry.overlays[k]);
            }
        }
        if (entry.labels && map) {
            for (var i = 0; i < entry.labels.length; i++) {
                map.removeLayer(entry.labels[i]);
            }
        }
        delete _rtEnvActive[name];
        _renderEnvColorbar();
        _hideEnvHoverTip();
        if (typeof _refreshLayersCount === 'function') _refreshLayersCount();
        _ga('rt_env_layer_off', { layer: name });
    }

    // ── Hover tooltip ────────────────────────────────────────
    //
    // On mousemove anywhere on the global map, sample the data canvas
    // for each active env layer at the cursor's lat/lon and show a
    // DM-Sans tooltip with the readout. Sampling is O(1) — one
    // getImageData(1,1) per active layer — so even half a dozen layers
    // stay smooth.

    var _envHoverBound = false;
    var _envHoverTip = null;

    function _envHoverTipEl() {
        if (_envHoverTip) return _envHoverTip;
        var el = document.createElement('div');
        el.id = 'ir-env-hover-tip';
        el.style.cssText =
            // position: fixed so clientX/Y from mousemove map directly
            // to top/left without any document-scroll math (absolute on
            // body was occasionally landing the tip off-screen).
            'position:fixed;pointer-events:none;display:none;z-index:900;' +
            'background:rgba(22,27,36,0.95);color:#e2e8f0;' +
            'font-family:"DM Sans","Helvetica Neue",sans-serif;font-size:0.72rem;' +
            'border:1px solid rgba(255,255,255,0.16);border-radius:5px;' +
            'padding:5px 8px;backdrop-filter:blur(6px);' +
            'box-shadow:0 4px 14px rgba(0,0,0,0.3);' +
            'white-space:nowrap;line-height:1.35;';
        document.body.appendChild(el);
        _envHoverTip = el;
        return el;
    }

    function _hideEnvHoverTip() {
        if (_envHoverTip) _envHoverTip.style.display = 'none';
    }

    function _sampleEnvLayer(entry, lat, lon) {
        if (!entry || !entry.ctx) return null;
        // Bounds are [[-90,-180],[90,180]] for our globe PNGs.
        var nx = entry.dataW, ny = entry.dataH;
        if (lon > 180) lon -= 360;
        if (lon < -180) lon += 360;
        var x = Math.floor((lon + 180) / 360 * nx);
        var y = Math.floor((90 - lat) / 180 * ny);  // y=0 at +90°
        if (x < 0) x = 0; else if (x >= nx) x = nx - 1;
        if (y < 0) y = 0; else if (y >= ny) y = ny - 1;
        try {
            var d = entry.ctx.getImageData(x, y, 1, 1).data;
            if (d[3] === 0) return null;  // NaN cell
            var L_ = entry.layer;
            // Prefer the data-encoding range when present (wider than
            // the contour vmin/vmax so jet-stream/extreme values aren't
            // clipped in the hover readout).
            var lo = (L_.data_vmin != null) ? L_.data_vmin : L_.vmin;
            var hi = (L_.data_vmax != null) ? L_.data_vmax : L_.vmax;
            return lo + (d[0] / 255) * (hi - lo);
        } catch (e) {
            // Canvas tainted (no CORS on the data PNG) — fail silently;
            // tooltip just hides. Visualization still works.
            entry.ctx = null;
            return null;
        }
    }

    function _ensureEnvHoverHandler() {
        if (_envHoverBound || !map) return;
        _envHoverBound = true;
        map.on('mousemove', function (e) {
            var actives = Object.values(_rtEnvActive);
            if (actives.length === 0) { _hideEnvHoverTip(); return; }
            var lat = e.latlng.lat;
            var lon = e.latlng.lng;
            var lines = [];
            for (var i = 0; i < actives.length; i++) {
                var v = _sampleEnvLayer(actives[i], lat, lon);
                if (v == null) continue;
                var L_ = actives[i].layer;
                // Format with 0-1 decimal depending on range size.
                var span = L_.vmax - L_.vmin;
                var nd = span >= 50 ? 0 : (span >= 10 ? 1 : 2);
                lines.push('<b>' + L_.title + ':</b> ' + v.toFixed(nd) + ' ' + L_.units);
            }
            var tip = _envHoverTipEl();
            if (lines.length === 0) { tip.style.display = 'none'; return; }
            lines.push('<span style="color:#94a3b8;font-size:0.62rem;">'
                + lat.toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S')
                + ' ' + Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W')
                + '</span>');
            tip.innerHTML = lines.join('<br>');
            // Position near the cursor, offset to the right of the pointer.
            var pt = e.originalEvent;
            if (pt) {
                tip.style.left = (pt.clientX + 14) + 'px';
                tip.style.top = (pt.clientY + 14) + 'px';
                tip.style.display = '';
            }
        });
        map.on('mouseout', _hideEnvHoverTip);
    }

    function _setEnvOpacity(v) {
        _rtEnvOpacity = Math.max(0, Math.min(1, v));
        Object.keys(_rtEnvActive).forEach(function (n) {
            var entry = _rtEnvActive[n];
            if (!entry) return;
            // Fade the overlay (raster image or geojson polylines).
            if (entry.overlays && entry.overlays.length) {
                for (var k = 0; k < entry.overlays.length; k++) {
                    var ov = entry.overlays[k];
                    if (entry.overlayKind === 'geojson') {
                        ov.setStyle({ opacity: _rtEnvOpacity });
                    } else {
                        ov.setOpacity(_rtEnvOpacity);
                    }
                }
            }
            // Fade the contour value labels too — without this they
            // stay full-strength while the contour lines themselves
            // fade, which reads as visual mismatch.
            if (entry.labels && entry.labels.length) {
                for (var li = 0; li < entry.labels.length; li++) {
                    if (entry.labels[li].setOpacity) {
                        entry.labels[li].setOpacity(_rtEnvOpacity);
                    }
                }
            }
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  UNIFIED LAYERS PANEL  (right-rail UI shell)
    // ═══════════════════════════════════════════════════════════
    //
    //  Single panel that owns the DeepMind / Genesis / Env Analysis /
    //  Wind Barbs sections — previously each was its own floating pill
    //  + dropdown, which gave the right rail no hierarchy. State is
    //  managed by the existing toggle / activate / deactivate functions;
    //  this layer is purely the UI shell.

    var _rtLayersPanelOpen = false;

    /** Mobile-aware open/close. On ≤768 px the panel renders as a
     *  bottom sheet driven by a CSS transform (see .ir-layers-panel
     *  rules in the mobile media query) so the transform can animate
     *  the slide-up. A tap-dismiss backdrop is summoned on first open.
     *
     *  Critical: the panel is created inside a Leaflet topright control
     *  wrap, and Leaflet positions controls via CSS `transform` on the
     *  map container. `position: fixed` resolves to the nearest
     *  transformed ancestor instead of the viewport, so the bottom-
     *  sheet rules would otherwise collapse to the tiny topright
     *  control box. Detach the panel to <body> on mobile-open and put
     *  it back in the wrap on close / desktop so each path gets the
     *  positioning it expects. */
    function toggleLayersPanel() {
        _rtLayersPanelOpen = !_rtLayersPanelOpen;
        var panel = document.getElementById('ir-layers-panel');
        var btn = document.getElementById('ir-layers-toggle');
        var wrap = document.querySelector('.ir-layers-wrap');
        var isMobile = window.matchMedia('(max-width: 768px)').matches;

        if (panel) {
            if (isMobile) {
                // Escape the Leaflet control's transform context so
                // position:fixed actually anchors to the viewport.
                if (panel.parentElement !== document.body) {
                    document.body.appendChild(panel);
                }
                // Keep `display` empty so the transform transition can
                // play; the slide is driven entirely by .is-open-mobile.
                panel.style.display = '';
                panel.classList.toggle('is-open-mobile', _rtLayersPanelOpen);
            } else {
                // Desktop: panel belongs back inside the Leaflet wrap
                // so it anchors below the trigger button as a dropdown.
                if (wrap && panel.parentElement !== wrap) {
                    wrap.appendChild(panel);
                }
                panel.style.display = _rtLayersPanelOpen ? '' : 'none';
                panel.classList.remove('is-open-mobile');
            }
        }
        if (btn) btn.classList.toggle('active', _rtLayersPanelOpen);

        // Body class lifts the env-cbar stack above the sheet's top edge
        // on mobile so users can read the legend while configuring.
        document.body.classList.toggle('rt-layers-sheet-open',
            isMobile && _rtLayersPanelOpen);

        // Lazy-create + show the tap-dismiss backdrop on mobile.
        var bd = document.getElementById('ir-layers-backdrop');
        if (isMobile && !bd) {
            bd = document.createElement('div');
            bd.id = 'ir-layers-backdrop';
            bd.className = 'ir-layers-backdrop';
            bd.addEventListener('click', function () {
                if (_rtLayersPanelOpen) toggleLayersPanel();
            });
            document.body.appendChild(bd);
        }
        if (bd) bd.classList.toggle('is-active', isMobile && _rtLayersPanelOpen);

        if (_rtLayersPanelOpen) {
            if (!_rtEnvMetadata) _loadEnvMetadata(); // _renderLayersPanel runs after the fetch
            _renderLayersPanel();
        }
    }
    window.toggleLayersPanel = toggleLayersPanel;

    /** Re-render the count badge on the "Layers ▾" trigger.
     *  Cheap O(N_layers) walk over current state; safe to call from
     *  every toggle/activate/deactivate site. */
    function _refreshLayersCount() {
        var n = 0;
        if (_rtGlobalWLVisible) n++;
        if (_rtGenesisVisible) n++;
        if (_rtGenesisRawVisible) n++;
        n += Object.keys(_rtEnvActive || {}).length;
        if (_rtMwLayer && _rtMwLayer.isEnabled()) n++;
        var el = document.getElementById('ir-layers-count');
        if (el) {
            el.textContent = n > 0 ? n : '';
            el.style.display = n > 0 ? '' : 'none';
        }
        var btn = document.getElementById('ir-layers-toggle');
        if (btn) btn.classList.toggle('has-active', n > 0);
        // If the panel is open, keep its checkboxes in sync with state.
        if (_rtLayersPanelOpen) _renderLayersPanel();
    }
    window._refreshLayersCount = _refreshLayersCount;

    /** Build the section-grouped HTML inside #ir-layers-panel. Reads
     *  current state directly so it stays correct across reopen/redraw.
     *  Groups are: FORECAST (DeepMind + Genesis), ANALYSIS (env layers
     *  grouped by physical category), WIND BARBS, and a shared opacity
     *  slider that drives every env layer. */
    function _renderLayersPanel() {
        var panel = document.getElementById('ir-layers-panel');
        // Write content into the dedicated sub-div so the persistent
        // .ir-layers-sheet-header (drag handle + X close button) at the
        // top of the panel survives across renders.
        var content = document.getElementById('ir-layers-content') || panel;
        if (!content) return;

        var allLayers = (_rtEnvMetadata && _rtEnvMetadata.layers) || [];
        var envLayers = allLayers.filter(function (L_) {
            return !L_.name.startsWith('winds_') && !L_.name.startsWith('genesis_');
        });
        var windLayers = allLayers.filter(function (L_) {
            return L_.name.indexOf('winds_') === 0;
        });
        var genesisProbLayers = allLayers.filter(function (L_) {
            return L_.name.indexOf('genesis_') === 0;
        });

        // Shared valid-time pulled from whichever env layer reports one.
        var validShort = '';
        var validSamples = allLayers.map(function (L_) { return L_.valid_time; }).filter(Boolean);
        if (validSamples.length) {
            var counts = {};
            for (var i = 0; i < validSamples.length; i++) counts[validSamples[i]] = (counts[validSamples[i]] || 0) + 1;
            var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
            validShort = (top || '').replace('T', ' ').replace(':00:00Z', 'Z');
        }

        function _escAttr(s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                .replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        function row(opts) {
            var sub = opts.substatus
                ? '<span class="substatus">' + opts.substatus + '</span>' : '';
            var units = opts.units
                ? '<span class="units">' + opts.units + '</span>' : '';
            // Optional per-row tooltip — used for layers whose name needs
            // unpacking (e.g. \"MRG / TD-type\"). Renders as a small ⓘ
            // hint at the row's end + a native title attribute so hovering
            // anywhere on the row surfaces the full description.
            var infoIcon = '';
            var titleAttr = '';
            if (opts.tooltip) {
                titleAttr = ' title="' + _escAttr(opts.tooltip) + '"';
                infoIcon = '<span class="ir-row-info" aria-hidden="true">ⓘ</span>';
            }
            return '<label class="ir-global-menu-row" data-action="' + opts.action + '"'
                + (opts.dataName ? ' data-name="' + opts.dataName + '"' : '')
                + titleAttr + '>'
                + '<input type="checkbox"' + (opts.checked ? ' checked' : '') + '>'
                + '<span class="label">' + opts.label + sub + '</span>'
                + units
                + infoIcon
                + '</label>';
        }

        var html = '';
        if (validShort) {
            html += '<div class="ir-global-menu-valid">valid <b>' + validShort + '</b></div>';
        }

        // ── FORECAST ────────────────────────────────────────────────
        html += '<div class="ir-global-menu-section">Forecast</div>';
        var wlStatus = _rtGlobalWLLoading ? 'Loading 50-member tracks…' : '';
        html += row({
            action: 'wl',
            label: '<b>DeepMind 10-day</b>',
            substatus: 'WeatherLab 50-member spaghetti for every active storm/invest' + (wlStatus ? ' — ' + wlStatus : ''),
            checked: !!_rtGlobalWLVisible
        });
        var genStatus = '';
        if (_rtGenesisLoading) genStatus = 'Loading 1000 members…';
        else if (_rtGenesisData) {
            var nt = _rtGenesisData.n_tracks || 0;
            genStatus = nt === 0 ? 'no genesis predicted in 15 days'
                                  : nt + ' track' + (nt === 1 ? '' : 's');
        }
        html += row({
            action: 'genesis',
            label: '<b>Cyclogenesis disturbances</b>',
            substatus: 'FNV3 LARGE_ENSEMBLE · ≥5% formation prob' + (genStatus ? ' — ' + genStatus : ''),
            checked: !!_rtGenesisVisible
        });
        // Clustering-method picker — two radio-style chips inline so
        // a forecaster can A/B DeepMind's own track_id grouping vs
        // our DBSCAN-style spatial clustering on member first-genesis
        // points. Active method is highlighted; inactive is clickable.
        var dmActive = _genesisClusterMethod === 'deepmind';
        var dmChipBg    = dmActive   ? 'rgba(249,115,22,0.32)' : 'transparent';
        var tcaChipBg   = !dmActive  ? 'rgba(249,115,22,0.32)' : 'transparent';
        var dmChipColor = dmActive   ? '#f97316' : 'inherit';
        var tcaChipColor = !dmActive ? '#f97316' : 'inherit';
        html += '<div class="ir-global-menu-row ir-global-method-row" style="opacity:'
            + (_rtGenesisVisible ? 1 : 0.45) + ';">'
            + '<span style="font-size:0.72rem; opacity:0.75; margin-right:8px;">Method:</span>'
            + '<button type="button" class="ir-global-method-chip" data-method="deepmind"'
            + ' style="background:' + dmChipBg + '; color:' + dmChipColor + ';">'
            + 'DeepMind</button>'
            + '<button type="button" class="ir-global-method-chip" data-method="tcatlas"'
            + ' style="background:' + tcaChipBg + '; color:' + tcaChipColor + ';">'
            + 'TC-ATLAS</button>'
            + '</div>';

        // Live tuner — visible only when TC-ATLAS (density-peak) is
        // the active clustering method. Sliders mutate the tunables
        // and re-cluster against the already-loaded data on every
        // input. Lets the user dial in a setting that matches their
        // meteorological intuition without push/reload cycles.
        if (!dmActive && _rtGenesisVisible) {
            var statusN = document.querySelectorAll('.rt-gen-marker').length;
            html += '<details class="ir-global-tuner"'
                + (_genesisTunerOpen ? ' open' : '') + '>'
                + '<summary class="ir-tuner-summary">'
                +   '<span class="ir-tuner-summary-label">Advanced clustering controls</span>'
                +   '<span class="ir-tuner-status">'
                +     '<strong>' + statusN + '</strong> disturbance'
                +     (statusN === 1 ? '' : 's')
                +   '</span>'
                + '</summary>'
                + '<div class="ir-tuner-row" data-key="grid">'
                +   '<label>Grid size'
                +     '<span class="ir-tuner-val">' + _GENESIS_GRID_DEG + '°</span>'
                +   '</label>'
                +   '<input type="range" min="1" max="6" step="0.5" '
                +     'value="' + _GENESIS_GRID_DEG + '">'
                + '</div>'
                + '<div class="ir-tuner-row" data-key="peakmin">'
                +   '<label>Peak threshold'
                +     '<span class="ir-tuner-val">' + _GENESIS_PEAK_MIN_MEMBERS + ' members</span>'
                +   '</label>'
                +   '<input type="range" min="2" max="40" step="1" '
                +     'value="' + _GENESIS_PEAK_MIN_MEMBERS + '">'
                + '</div>'
                + '<div class="ir-tuner-row" data-key="assignr">'
                +   '<label>Assign radius'
                +     '<span class="ir-tuner-val">' + _GENESIS_ASSIGN_RADIUS_KM + ' km</span>'
                +   '</label>'
                +   '<input type="range" min="100" max="1500" step="50" '
                +     'value="' + _GENESIS_ASSIGN_RADIUS_KM + '">'
                + '</div>'
                + '<div class="ir-tuner-row" data-key="timewin">'
                +   '<label>Time window'
                +     '<span class="ir-tuner-val">±' + _GENESIS_TIME_WINDOW_H + ' h</span>'
                +   '</label>'
                +   '<input type="range" min="6" max="168" step="6" '
                +     'value="' + _GENESIS_TIME_WINDOW_H + '">'
                + '</div>'
                + '<div class="ir-tuner-row" data-key="minmembers">'
                +   '<label>Min cluster size'
                +     '<span class="ir-tuner-val">' + _GENESIS_CLUSTER_MIN_MEMBERS + ' members</span>'
                +   '</label>'
                +   '<input type="range" min="10" max="200" step="5" '
                +     'value="' + _GENESIS_CLUSTER_MIN_MEMBERS + '">'
                + '</div>'
                + '<div class="ir-tuner-footer">'
                +   '<button type="button" class="ir-tuner-reset" '
                +     'title="Restore default values">Reset</button>'
                + '</div>'
                + '</details>';
        }
        // Opt-in sub-toggle for the raw member spaghetti. Off by
        // default — the disturbance markers above are the canonical
        // view. Spaghetti is for users who want to see the spread
        // visually (matches the detail modal's track-figure style).
        // Disabled until the cyclogenesis layer itself is on.
        html += row({
            action: 'genesis-spaghetti',
            label: 'Member spaghetti',
            substatus: 'Per-member track polylines, colored by parent disturbance',
            checked: !!_rtGenesisSpaghettiVisible,
            disabled: !_rtGenesisVisible
        });
        // Independent toggle for the raw ensemble view. NOT a sub-
        // toggle of Cyclogenesis — runs on the same /weatherlab-
        // genesis data but shows EVERY member as its own genesis dot
        // + track, colored by that member's own predicted peak Vmax.
        // Chaotic by design — gives the analyst the full ensemble
        // spread when the clustered disturbance markers feel too
        // abstracted.
        html += row({
            action: 'genesis-raw',
            label: '<b>Raw ensemble members</b>',
            substatus: 'Every member: genesis dot + forecast track (no clustering)',
            checked: !!_rtGenesisRawVisible,
        });
        for (var gi = 0; gi < genesisProbLayers.length; gi++) {
            var GL = genesisProbLayers[gi];
            html += row({
                action: 'genesis-prob',
                dataName: GL.name,
                label: GL.title.replace('TC Formation Probability — ', 'Formation prob — '),
                units: GL.units,
                checked: !!_rtEnvActive[GL.name]
            });
        }

        // ── ANALYSIS (env grouped by physical category) ─────────────
        if (envLayers.length) {
            html += '<div class="ir-global-menu-section with-divider">Analysis</div>';
            for (var ggi = 0; ggi < _ENV_MENU_GROUPS.length; ggi++) {
                var grp = _ENV_MENU_GROUPS[ggi];
                var inGroup = envLayers.filter(grp.match);
                if (inGroup.length === 0) continue;
                html += '<div class="ir-global-menu-subhead">' + grp.label + '</div>';
                for (var li = 0; li < inGroup.length; li++) {
                    var L_ = inGroup[li];
                    html += row({
                        action: 'env',
                        dataName: L_.name,
                        label: grp.shortTitle(L_),
                        units: L_.units,
                        tooltip: L_.description,
                        checked: !!_rtEnvActive[L_.name]
                    });
                }
            }
            // Anything env-categorized that didn't match a group
            var ungrouped = envLayers.filter(function (L_) {
                return !_ENV_MENU_GROUPS.some(function (g) { return g.match(L_); });
            });
            if (ungrouped.length) {
                html += '<div class="ir-global-menu-subhead">Other</div>';
                for (var ui = 0; ui < ungrouped.length; ui++) {
                    var Lu = ungrouped[ui];
                    html += row({
                        action: 'env',
                        dataName: Lu.name,
                        label: Lu.title,
                        units: Lu.units,
                        checked: !!_rtEnvActive[Lu.name]
                    });
                }
            }
        }

        // ── WIND BARBS ──────────────────────────────────────────────
        if (windLayers.length) {
            html += '<div class="ir-global-menu-section with-divider">Wind Barbs</div>';
            for (var wi = 0; wi < windLayers.length; wi++) {
                var WL = windLayers[wi];
                // Compact level label: strip "Wind Barbs" suffix. Handles
                // both pressure ("850 hPa Wind Barbs" → "850 hPa") and
                // surface ("10 m Wind Barbs" → "10 m") layers cleanly.
                var lvl = WL.title
                    .replace(/\s*hPa Wind Barbs\s*/i, ' hPa')
                    .replace(/\s*Wind Barbs\s*$/i, '');
                html += row({
                    action: 'env',
                    dataName: WL.name,
                    label: lvl,
                    units: WL.units,
                    checked: !!_rtEnvActive[WL.name]
                });
            }
        }

        // ── Microwave is NOT listed here ──────────────────────────
        // The MW controls live in their own popover anchored to the
        // top-level "Microwave" pill (sibling of IR/GeoColor). One
        // canonical home avoids the user having to learn two places
        // for the same controls.

        // ── Shared opacity slider (drives every env-style overlay) ──
        html += '<div class="ir-global-menu-opacity-wrap">'
              + '<label class="ir-global-menu-opacity">Opacity '
              + '<input id="ir-layers-opacity" type="range" min="0" max="100" value="'
              + Math.round(_rtEnvOpacity * 100) + '">'
              + '<span class="pct" id="ir-layers-opacity-val">'
              + Math.round(_rtEnvOpacity * 100) + '%</span>'
              + '</label></div>';

        if (allLayers.length === 0) {
            html = '<div class="ir-global-menu-empty">Loading layers…</div>';
        }

        content.innerHTML = html;

        // ── Wire up change handlers ─────────────────────────────────
        // The whole row is a <label> wrapping the checkbox, so any click
        // anywhere in the row flips the checkbox and fires `change` on
        // it exactly once — no manual label-forwarding gymnastics.
        var rows = content.querySelectorAll('label.ir-global-menu-row');
        for (var r = 0; r < rows.length; r++) {
            (function (rowEl) {
                var cb = rowEl.querySelector('input[type="checkbox"]');
                if (!cb) return;
                cb.addEventListener('change', function () {
                    _dispatchRow(rowEl, cb);
                });
            })(rows[r]);
        }

        // Cyclogenesis-method picker chips. Click the inactive one
        // to switch methods + re-render the disturbance layer in place.
        var chips = content.querySelectorAll('.ir-global-method-chip');
        for (var c = 0; c < chips.length; c++) {
            (function (chipEl) {
                chipEl.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    var m = chipEl.getAttribute('data-method');
                    if (!m || m === _genesisClusterMethod) return;
                    _genesisClusterMethod = m;
                    _ga('rt_genesis_cluster_method', { method: m });
                    if (_rtGenesisVisible) {
                        _renderGenesis();
                        if (_rtGenesisSpaghettiVisible) {
                            _renderGenesisSpaghetti();
                        }
                    }
                    // Re-open the menu so the chip-active style updates
                    // without the user having to close + reopen.
                    if (typeof toggleLayersPanel === 'function') {
                        toggleLayersPanel();  // close
                        toggleLayersPanel();  // reopen with refreshed HTML
                    }
                });
            })(chips[c]);
        }

        // TC-ATLAS tuner sliders — live re-clustering on every input.
        // Mutates the module-scope tunables, re-renders the disturbance
        // markers + dependent layers, and updates the in-panel count
        // status so the user sees the effect in real time.
        function _genesisReRender() {
            if (!_rtGenesisData) return;
            _renderGenesis();
            if (_rtGenesisSpaghettiVisible) _renderGenesisSpaghetti();
            if (_rtGenesisRawVisible)       _renderGenesisRaw();
            var status = document.querySelector('.ir-tuner-status');
            if (status) {
                var n = document.querySelectorAll('.rt-gen-marker').length;
                status.innerHTML =
                    '<strong>' + n + '</strong> disturbance'
                    + (n === 1 ? '' : 's');
            }
        }
        // Persist the disclosure's open/closed state across menu
        // re-renders so a slider drag (which can trigger a re-render
        // via _genesisReRender's status update) doesn't snap the
        // panel closed.
        var tunerDetails = content.querySelector('details.ir-global-tuner');
        if (tunerDetails) {
            tunerDetails.addEventListener('toggle', function () {
                _genesisTunerOpen = tunerDetails.open;
            });
        }

        var tunerRows = content.querySelectorAll('.ir-tuner-row');
        for (var tr = 0; tr < tunerRows.length; tr++) {
            (function (rowEl) {
                var key = rowEl.getAttribute('data-key');
                var input = rowEl.querySelector('input[type=range]');
                var valEl = rowEl.querySelector('.ir-tuner-val');
                if (!input || !valEl) return;
                input.addEventListener('input', function () {
                    var v = parseFloat(input.value);
                    if (key === 'grid') {
                        _GENESIS_GRID_DEG = v;
                        valEl.textContent = v + '°';
                    } else if (key === 'peakmin') {
                        _GENESIS_PEAK_MIN_MEMBERS = parseInt(v, 10);
                        valEl.textContent = parseInt(v, 10) + ' members';
                    } else if (key === 'assignr') {
                        _GENESIS_ASSIGN_RADIUS_KM = v;
                        valEl.textContent = v + ' km';
                    } else if (key === 'timewin') {
                        _GENESIS_TIME_WINDOW_H = v;
                        valEl.textContent = '±' + v + ' h';
                    } else if (key === 'minmembers') {
                        _GENESIS_CLUSTER_MIN_MEMBERS = parseInt(v, 10);
                        valEl.textContent = parseInt(v, 10) + ' members';
                    }
                    // Params changed → invalidate cache and re-fetch
                    // server-side clusters; render falls back to the
                    // client-side path until the new fetch lands so the
                    // user gets immediate feedback.
                    _rtGenesisClusters = null;
                    _loadGenesisClusters();
                    _genesisReRender();
                });
            })(tunerRows[tr]);
        }
        var resetBtn = content.querySelector('.ir-tuner-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                _GENESIS_GRID_DEG            = 3;
                _GENESIS_PEAK_MIN_MEMBERS    = 8;
                _GENESIS_ASSIGN_RADIUS_KM    = 750;
                _GENESIS_TIME_WINDOW_H       = 48;
                _GENESIS_CLUSTER_MIN_MEMBERS = 25;
                _rtGenesisClusters = null;
                _loadGenesisClusters();
                _genesisReRender();
                if (typeof toggleLayersPanel === 'function') {
                    toggleLayersPanel(); toggleLayersPanel();
                }
            });
        }

        var opacityEl = document.getElementById('ir-layers-opacity');
        if (opacityEl) {
            opacityEl.addEventListener('input', function (e) {
                var v = parseInt(e.target.value, 10) / 100;
                _setEnvOpacity(v);
                var lbl = document.getElementById('ir-layers-opacity-val');
                if (lbl) lbl.textContent = Math.round(v * 100) + '%';
            });
        }
    }

    function _dispatchRow(rowEl, cb) {
        var action = rowEl.getAttribute('data-action');
        var name = rowEl.getAttribute('data-name');
        var on = cb.checked;
        if (action === 'wl') {
            if (on !== _rtGlobalWLVisible) toggleGlobalWeatherlab();
        } else if (action === 'genesis') {
            if (on !== _rtGenesisVisible) toggleGenesis();
        } else if (action === 'genesis-spaghetti') {
            if (on !== _rtGenesisSpaghettiVisible) toggleGenesisSpaghetti();
        } else if (action === 'genesis-raw') {
            if (on !== _rtGenesisRawVisible) toggleGenesisRaw();
        } else if (action === 'genesis-prob') {
            if (on) _activateGenesisProbLayer(name);
            else _deactivateEnvLayer(name);
        } else if (action === 'env') {
            var layer = (_rtEnvMetadata && _rtEnvMetadata.layers || [])
                .filter(function (L_) { return L_.name === name; })[0];
            if (!layer) return;
            if (on) _activateEnvLayer(layer);
            else _deactivateEnvLayer(name);
        }
        _refreshLayersCount();
    }

    // ── PNG export of current global map view ────────────────────
    //
    // Lazy-loads html2canvas on first click (kept off the page-load
    // path since most users never export). Captures the #ir-map
    // container — Leaflet's panes, our env overlays, the wind-barb
    // canvas, the colorbar + animation panel are all DOM children of
    // the map root, so a single capture grabs everything that's
    // visible. NASA GIBS + our backend image overlays both serve
    // CORS headers, so html2canvas can read them without tainting.

    var _html2canvasLoadingPromise = null;
    function _ensureHtml2canvas() {
        if (window.html2canvas) return Promise.resolve();
        if (_html2canvasLoadingPromise) return _html2canvasLoadingPromise;
        _html2canvasLoadingPromise = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('Failed to load html2canvas')); };
            document.head.appendChild(s);
        });
        return _html2canvasLoadingPromise;
    }

    function _exportMapPng() {
        var btn = document.getElementById('ir-global-export-btn');
        var orig = btn ? btn.textContent : '';
        if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

        _ensureHtml2canvas().then(function () {
            var node = document.getElementById('ir-map');
            if (!node) throw new Error('Map element not found');
            return window.html2canvas(node, {
                useCORS: true,
                allowTaint: false,
                backgroundColor: null,
                logging: false,
                scale: window.devicePixelRatio || 1
            });
        }).then(function (canvas) {
            return new Promise(function (resolve, reject) {
                canvas.toBlob(function (blob) {
                    if (!blob) return reject(new Error('Canvas produced no blob (likely CORS taint)'));
                    resolve(blob);
                }, 'image/png');
            });
        }).then(function (blob) {
            // YYYYMMDDTHHMMSSZ — sortable, file-system-safe.
            var ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'tc-atlas-rt-' + ts + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Hold the URL briefly so Safari has time to start the download
            // before the blob is revoked.
            setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
            _ga('rt_export_png', { ok: true });
        }).catch(function (err) {
            console.error('[Export] PNG export failed', err);
            _ga('rt_export_png', { ok: false, msg: String(err && err.message) });
            alert('Couldn’t save PNG: ' + (err && err.message ? err.message : err));
        }).then(function () {
            if (btn) { btn.textContent = orig; btn.disabled = false; }
        });
    }

    // Group definition for the Env Analysis menu — collapses the
    // flat 11-layer list into ~4 short physical-category sections so
    // the dropdown doesn't run past the bottom of the map.
    // Ordered for narrative flow: pressure surfaces (synoptic baseline)
    // → wind dynamics (shear / vorticity / divergence) → thermodynamics
    // (moisture + SST). MSLP + z500 are grouped under "Pressure" because
    // they're both expressions of the pressure field (MSL scalar vs.
    // height of a constant-pressure surface). Wind barbs live in their
    // own dedicated menu inside the Layers panel so users can mix-and-
    // match wind levels with any diagnostic here (e.g. 850 mb vorticity
    // + 200 mb winds together).
    var _ENV_MENU_GROUPS = [
        {
            label: 'Pressure',
            match: function (L_) {
                return L_.name === 'mslp'
                    || (L_.name.indexOf('z') === 0 && L_.name.indexOf('_heights') > 0);
            },
            shortTitle: function (L_) {
                if (L_.name === 'mslp') return 'Mean Sea Level';
                return L_.title.replace(/\s*hPa Geopotential Height\s*/i, ' hPa');
            }
        },
        {
            label: 'Wind Shear',
            match: function (L_) { return L_.name.indexOf('shear_') === 0; },
            shortTitle: function (L_) {
                return L_.title.replace(/\s*hPa Wind Shear\s*/i, ' hPa');
            }
        },
        {
            label: 'Vorticity',
            match: function (L_) { return L_.name.indexOf('vort_') === 0; },
            shortTitle: function (L_) {
                return L_.title.replace(/\s*hPa Cyclonic Vorticity\s*/i, ' hPa');
            }
        },
        {
            label: 'Divergence',
            match: function (L_) { return L_.name.indexOf('div_') === 0; },
            shortTitle: function (L_) {
                return L_.title.replace(/\s*hPa Divergence\s*/i, ' hPa');
            }
        },
        {
            label: 'Moisture & SST',
            match: function (L_) {
                return L_.name === 'rh_700_400' || L_.name === 'sst_oisst';
            },
            shortTitle: function (L_) {
                if (L_.name === 'rh_700_400') return '700-400 hPa RH';
                return 'Sea-Surface Temperature';
            }
        },
        {
            // Wheeler-Kiladis-filtered OLR overlays produced by
            // build_subseasonal_overlays.py. Lets users layer real-time
            // MJO / Kelvin / ER / MRG forcing on top of the IR map to
            // contextualize active TC genesis vs the wave envelope.
            label: 'Subseasonal Forcing',
            match: function (L_) { return L_.category === 'subseasonal'; },
            shortTitle: function (L_) {
                // Period (days) where that's the natural axis, phase speed
                // (m/s) where the dispersion-curve depth is. Hides the
                // "h = 8-90 m equivalent depth" jargon behind the more
                // immediately-readable wave propagation speed.
                var labels = {
                    anomaly: 'OLR anomaly',
                    mjo:     'MJO band (30-96 d)',
                    kelvin:  'Kelvin band (c ≈ 9-30 m/s east)',
                    er:      'Equatorial Rossby (c ≈ 9-30 m/s west, n=1)',
                    mrg:     'MRG / TD-type (3-8 d)',
                };
                return labels[L_.name] || L_.title;
            }
        }
    ];

    /** Legacy renderer — superseded by the unified Layers panel. */
    function _renderEnvMenu() { _renderLayersPanel(); }

    // Above this many discrete contour levels (e.g. Z500's 41 at 3-dam
    // intervals) the swatch row becomes unreadably wide AND overflows
    // the colorbar container. Fall back to the continuous gradient with
    // min/mid/max ticks instead — much more compact + still legible.
    var _ENV_CBAR_MAX_SWATCHES = 16;

    function _renderEnvColorbar() {
        var box = document.getElementById('ir-global-env-cbars');
        if (!box) return;
        // Wind-barb layers don't have a continuous color scale — their
        // info channel is the feather glyphs, not color. They were
        // surfacing in the colorbar stack as "undefined" rows; skip them.
        var active = Object.values(_rtEnvActive).filter(function (e) {
            return e && e.overlayKind !== 'wind';
        });
        if (active.length === 0) {
            box.style.display = 'none';
            box.innerHTML = '';
            return;
        }
        box.style.display = '';
        var html = '';
        for (var i = 0; i < active.length; i++) {
            var L_ = active[i].layer;
            var lvls = L_.levels;
            var lvlColors = L_.level_colors;
            var useSwatches = lvls && lvls.length && lvlColors
                && lvlColors.length === lvls.length
                && lvls.length <= _ENV_CBAR_MAX_SWATCHES;
            if (useSwatches) {
                // CIMSS-style discrete legend: one swatch per contour level.
                var swatchHtml = '';
                for (var k = 0; k < lvls.length; k++) {
                    var rgb = lvlColors[k];
                    swatchHtml += '<div style="display:flex;flex-direction:column;align-items:center;">'
                        + '<div style="width:18px;height:14px;background:rgb(' + rgb.join(',') + ');border:1px solid rgba(255,255,255,0.18);border-radius:2px;"></div>'
                        + '<div style="font-size:0.55rem;color:#c7d2e0;margin-top:1px;">' + lvls[k] + '</div>'
                        + '</div>';
                }
                html += '<div style="margin-top:6px;font-family:DM Sans,sans-serif;color:#c7d2e0;">'
                    + '<div style="display:flex;justify-content:space-between;font-size:0.62rem;margin-bottom:4px;">'
                    + '<span>' + L_.title + '</span><span>' + L_.units + '</span></div>'
                    + '<div style="display:flex;gap:3px;">' + swatchHtml + '</div>'
                    + '</div>';
            } else {
                // Continuous-gradient rendering. Used by layers that
                // (a) never emitted discrete `levels` (older raster fields)
                // or (b) have too many discrete levels to fit as swatches
                // (Z500 at 3 dam = 41 levels). Adds a min/mid/max tick
                // row so users can still read values off the gradient.
                var stops = L_.colorbar_stops || [];
                var grad = stops.map(function (s) {
                    return 'rgb(' + s.rgb.join(',') + ') ' + Math.round(s.t * 100) + '%';
                }).join(',');
                // Fallback for layers without colorbar_stops: build a
                // gradient from level_colors if available.
                if (!grad && lvls && lvlColors && lvlColors.length === lvls.length) {
                    var span = (L_.vmax - L_.vmin) || 1;
                    grad = lvls.map(function (lvl, idx) {
                        var t = Math.max(0, Math.min(1, (lvl - L_.vmin) / span));
                        return 'rgb(' + lvlColors[idx].join(',') + ') ' + Math.round(t * 100) + '%';
                    }).join(',');
                }
                var mid = Math.round((L_.vmin + L_.vmax) / 2);
                html += '<div style="margin-top:6px;font-family:DM Sans,sans-serif;font-size:0.62rem;color:#c7d2e0;">'
                    + '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">'
                    + '<span>' + L_.title + '</span><span>' + L_.units + '</span></div>'
                    + '<div style="width:160px;height:8px;border-radius:2px;background:linear-gradient(to right,' + grad + ');"></div>'
                    + '<div style="display:flex;justify-content:space-between;font-size:0.55rem;color:#94a3b8;width:160px;">'
                    + '<span>' + L_.vmin + '</span><span>' + mid + '</span><span>' + L_.vmax + '</span></div>'
                    + '</div>';
            }
        }
        box.innerHTML = html;
    }

    // ── Wind Barbs menu (separate from Env Analysis) ─────────
    //
    //  Lives in its own dropdown so users can mix-and-match wind
    //  levels with the env diagnostics (e.g. 850 mb vorticity contours
    //  + 200 mb wind barbs).

    var _rtWindsMenuOpen = false;

    /** Legacy entry points — superseded by the unified Layers panel. */
    function toggleWindsMenu() { toggleLayersPanel(); }
    function _renderWindsMenu() { _renderLayersPanel(); }
    function _refreshWindsButton() { _refreshLayersCount(); }
    function toggleEnvMenu() { toggleLayersPanel(); }
    window.toggleWindsMenu = toggleWindsMenu;
    window.toggleEnvMenu = toggleEnvMenu;

    // ═══════════════════════════════════════════════════════════
    //  DEEPMIND 1000-MEMBER ENSEMBLE DISTRIBUTION PANELS
    // ═══════════════════════════════════════════════════════════

    var _DM_SS_COLORS = {
        TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24', C2: '#fb923c',
        C3: '#ef4444', C4: '#c430a0', C5: '#8b5cf6'
    };

    /** Assign SS color to a wind speed value */
    function _dmWindColor(w) {
        if (w == null) return '#64748b';
        if (w < 34) return _DM_SS_COLORS.TD;
        if (w < 64) return _DM_SS_COLORS.TS;
        if (w < 83) return _DM_SS_COLORS.C1;
        if (w < 96) return _DM_SS_COLORS.C2;
        if (w < 113) return _DM_SS_COLORS.C3;
        if (w < 137) return _DM_SS_COLORS.C4;
        return _DM_SS_COLORS.C5;
    }

    /**
     * Load 1000-member ensemble data for histogram panels.
     */
    function _rtLoadDmEnsemble(storm) {
        if (!storm || !storm.atcf_id) return;
        var atcfId = storm.atcf_id;
        _rtDmEnsData = null;

        var cached = _panelCache[atcfId];
        var dataPromise;
        if (cached && cached.dmEns && (Date.now() - cached.cachedAt) < PANEL_CACHE_TTL_MS) {
            dataPromise = Promise.resolve(cached.dmEns);
        } else {
            dataPromise = fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) + '/weatherlab-ensemble', { cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
                .then(function (json) {
                    if (!_panelCache[atcfId]) _panelCache[atcfId] = { cachedAt: Date.now() };
                    _panelCache[atcfId].dmEns = json;
                    return json;
                });
        }

        dataPromise
            .then(function (json) {
                _rtDmEnsData = json;
                console.log('[WeatherLab 1K] Loaded ' + json.n_members + ' members');
                if (_rtWeatherlabVisible) {
                    _rtShowDmPanels();
                }
            })
            .catch(function () {
                // Silent — 1000-member data may not be available
            });
    }

    /** Slider handler for intensity histogram */
    /** Show distribution panels and initialize sliders/charts */
    function _rtShowDmPanels() {
        if (!_rtDmEnsData) return;
        var taus = _rtDmEnsData.lead_times_h || [];

        var idx24 = taus.indexOf(24);
        var default24 = idx24 >= 0 ? idx24 : Math.min(4, taus.length - 1);

        var histSlider = document.getElementById('rt-dm-hist-slider');
        if (histSlider) { histSlider.max = taus.length - 1; histSlider.value = default24; }
        var changeSlider = document.getElementById('rt-dm-change-slider');
        if (changeSlider) {
            changeSlider.max = taus.length - 1;
            changeSlider.value = default24;
            _rtDmChangeTauIdx = default24;
        }

        var distEl = document.getElementById('rt-dm-intensity-dist');
        var changeEl = document.getElementById('rt-dm-change-dist');
        var lmiEl = document.getElementById('rt-dm-lmi-dist');
        if (distEl) distEl.style.display = '';
        if (changeEl) changeEl.style.display = '';
        if (lmiEl) lmiEl.style.display = '';

        _rtDmHistTauIdx = default24;
        _rtRenderIntensityHist();
        _rtRenderChangeHist();
        _rtRenderLmiHist();
    }

    window._rtDmHistSlide = function (idx) {
        _rtDmHistTauIdx = parseInt(idx);
        _rtRenderIntensityHist();
    };

    /** Slider handler for change histogram */
    window._rtDmChangeSlide = function (idx) {
        _rtDmChangeTauIdx = parseInt(idx);
        _rtRenderChangeHist();
    };

    /** Toggle 12h/24h change interval */
    window._rtDmChangeInterval = function (hours) {
        _rtDmChangeInt = hours;
        var btn12 = document.getElementById('rt-dm-change-12h-btn');
        var btn24 = document.getElementById('rt-dm-change-24h-btn');
        if (btn12) btn12.style.background = hours === 12 ? 'rgba(0,229,255,0.2)' : '';
        if (btn24) btn24.style.background = hours === 24 ? 'rgba(0,229,255,0.2)' : '';
        if (btn12) btn12.classList.toggle('active', hours === 12);
        if (btn24) btn24.classList.toggle('active', hours === 24);
        _rtRenderChangeHist();
    };

    /**
     * Render intensity histogram at the current slider tau.
     */
    function _rtRenderIntensityHist() {
        if (!_rtDmEnsData || typeof Plotly === 'undefined') return;

        var taus = _rtDmEnsData.lead_times_h || [];
        var tau = taus[_rtDmHistTauIdx];
        if (tau == null) return;

        var label = document.getElementById('rt-dm-hist-label');
        if (label) label.textContent = '+' + tau + 'h';

        var tauKey = String(Math.round(tau));
        var data = _rtDmEnsData.intensity[tauKey];
        if (!data || !data.winds) return;

        // Filter out nulls
        var winds = data.winds.filter(function (w) { return w != null; });
        if (winds.length === 0) return;

        // Compute percentiles
        var sorted = winds.slice().sort(function (a, b) { return a - b; });
        var p = function (pct) { return sorted[Math.floor(pct / 100 * (sorted.length - 1))]; };
        var mean = winds.reduce(function (a, b) { return a + b; }, 0) / winds.length;

        var chartEl = document.getElementById('rt-dm-hist-chart');
        if (!chartEl) return;

        // Pre-bin into 5-kt bins with SS-colored bars
        var binSize = 5;
        var binCenters = [];
        var binCounts = [];
        var binColors = [];
        for (var b = 0; b < 175; b += binSize) {
            var center = b + binSize / 2;
            var count = 0;
            for (var wi = 0; wi < winds.length; wi++) {
                if (winds[wi] >= b && winds[wi] < b + binSize) count++;
            }
            if (count > 0 || b < 170) {
                binCenters.push(center);
                binCounts.push(count);
                binColors.push(_dmWindColor(center));
            }
        }

        var trace = {
            x: binCenters,
            y: binCounts,
            type: 'bar',
            width: binSize * 0.9,
            marker: {
                color: binColors,
                line: { color: 'rgba(0,0,0,0.3)', width: 0.5 }
            },
            hovertemplate: '%{x:.0f} kt<br>%{y} members<extra></extra>'
        };

        // SS category threshold lines with labels
        var ssThresholds = [
            { v: 34, label: 'TS' }, { v: 64, label: 'C1' },
            { v: 83, label: 'C2' }, { v: 96, label: 'C3' },
            { v: 113, label: 'C4' }, { v: 137, label: 'C5' }
        ];
        var shapes = ssThresholds.map(function (t) {
            return {
                type: 'line', x0: t.v, x1: t.v, y0: 0, y1: 1, yref: 'paper',
                line: { color: 'rgba(255,255,255,0.15)', width: 1, dash: 'dot' }
            };
        });

        // Percentile summary as single line (avoids overlapping labels)
        var pctText = 'P10: ' + p(10).toFixed(0) + '  P50: ' + p(50).toFixed(0) +
            '  P90: ' + p(90).toFixed(0) + ' kt';
        var annotations = [
            { x: 0, y: 1.06, xref: 'paper', yref: 'paper', text: pctText,
              showarrow: false, font: { size: 8, color: '#5b6573' },
              xanchor: 'left', yanchor: 'bottom' }
        ];

        // Mean line
        shapes.push({
            type: 'line', x0: mean, x1: mean, y0: 0, y1: 1, yref: 'paper',
            line: { color: '#00e5ff', width: 1.5 }
        });

        var layout = {
            height: 180,
            margin: { t: 25, r: 10, b: 30, l: 40 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'JetBrains Mono, monospace', size: 9, color: '#5b6573' },
            xaxis: {
                title: { text: 'Vmax (kt)', font: { size: 9 } },
                range: [0, 175],
                dtick: 20,
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            yaxis: {
                title: { text: 'Count', font: { size: 9 } },
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            shapes: shapes,
            annotations: annotations,
            bargap: 0.08
        };

        Plotly.newPlot(chartEl, [trace], layout, {
            displayModeBar: false, responsive: false, staticPlot: true
        });
    }

    /**
     * Render intensity change histogram at the current slider tau.
     */
    function _rtRenderChangeHist() {
        if (!_rtDmEnsData || typeof Plotly === 'undefined') return;

        var taus = _rtDmEnsData.lead_times_h || [];
        var tau = taus[_rtDmChangeTauIdx];
        if (tau == null) return;

        var label = document.getElementById('rt-dm-change-label');
        if (label) label.textContent = '+' + tau + 'h';

        var changeData = _rtDmChangeInt === 12
            ? _rtDmEnsData.intensity_change_12h
            : _rtDmEnsData.intensity_change_24h;

        var tauKey = String(Math.round(tau));
        var data = changeData ? changeData[tauKey] : null;
        if (!data || !data.dv) {
            // No change data at this tau (too early)
            var chartEl = document.getElementById('rt-dm-change-chart');
            if (chartEl) Plotly.purge(chartEl);
            return;
        }

        var dv = data.dv.filter(function (v) { return v != null; });
        if (dv.length === 0) return;

        // RI threshold and probability
        var riThreshold = _rtDmChangeInt === 24 ? 30 : 20;
        var riCount = dv.filter(function (v) { return v >= riThreshold; }).length;
        var riPct = Math.round(riCount / dv.length * 100);
        var mean = dv.reduce(function (a, b) { return a + b; }, 0) / dv.length;

        var chartEl = document.getElementById('rt-dm-change-chart');
        if (!chartEl) return;

        // Pre-bin data into 5-kt bins and color by bin center value
        var binSize = 5;
        var dvMin = Math.floor(Math.min.apply(null, dv) / binSize) * binSize;
        var dvMax = Math.ceil(Math.max.apply(null, dv) / binSize) * binSize;
        var binCenters = [];
        var binCounts = [];
        var binColors = [];
        for (var b = dvMin; b < dvMax; b += binSize) {
            var center = b + binSize / 2;
            var count = 0;
            for (var di = 0; di < dv.length; di++) {
                if (dv[di] >= b && dv[di] < b + binSize) count++;
            }
            binCenters.push(center);
            binCounts.push(count);
            // Diverging: blue (weakening) → gray (neutral) → red (intensifying)
            if (center <= -30)     binColors.push('#1e40af');
            else if (center <= -15) binColors.push('#3b82f6');
            else if (center <= -5)  binColors.push('#93c5fd');
            else if (center < 5)    binColors.push('#94a3b8');
            else if (center < 15)   binColors.push('#fca5a5');
            else if (center < 30)   binColors.push('#ef4444');
            else                    binColors.push('#991b1b');
        }

        var trace = {
            x: binCenters,
            y: binCounts,
            type: 'bar',
            width: binSize * 0.9,
            marker: {
                color: binColors,
                line: { color: 'rgba(0,0,0,0.3)', width: 0.5 }
            },
            hovertemplate: '%{x:+.0f} kt/' + _rtDmChangeInt + 'h<br>%{y} members<extra></extra>'
        };

        var shapes = [
            // Zero line
            { type: 'line', x0: 0, x1: 0, y0: 0, y1: 1, yref: 'paper',
              line: { color: 'rgba(255,255,255,0.2)', width: 1 } },
            // RI threshold
            { type: 'line', x0: riThreshold, x1: riThreshold, y0: 0, y1: 1, yref: 'paper',
              line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
            // Mean
            { type: 'line', x0: mean, x1: mean, y0: 0, y1: 1, yref: 'paper',
              line: { color: '#00e5ff', width: 1.5 } }
        ];

        var annotations = [
            { x: riThreshold, y: 1, yref: 'paper', text: 'RI: ' + riPct + '%',
              showarrow: false, font: { size: 9, color: '#dc2626' },
              yanchor: 'bottom', xanchor: 'left', xshift: 4 }
        ];

        var layout = {
            height: 180,
            margin: { t: 20, r: 10, b: 30, l: 35 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'JetBrains Mono, monospace', size: 9, color: '#5b6573' },
            xaxis: {
                title: { text: '\u0394V (kt/' + _rtDmChangeInt + 'h)', font: { size: 9 } },
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            yaxis: {
                title: { text: 'Members', font: { size: 9 } },
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            shapes: shapes,
            annotations: annotations,
            bargap: 0.05
        };

        Plotly.newPlot(chartEl, [trace], layout, {
            displayModeBar: false, responsive: false, staticPlot: true
        });
    }

    /** Clean up ensemble distribution panels */
    /**
     * Render LMI distribution — histogram of each member's lifetime max wind.
     */
    function _rtRenderLmiHist() {
        if (!_rtDmEnsData || typeof Plotly === 'undefined') return;

        var chartEl = document.getElementById('rt-dm-lmi-chart');
        if (!chartEl) return;

        // Compute LMI for each member: max wind across all lead times
        var intensity = _rtDmEnsData.intensity || {};
        var taus = _rtDmEnsData.lead_times_h || [];
        var nMembers = _rtDmEnsData.n_members || 0;

        // For each member index, find the max wind across all taus
        var lmiWinds = [];
        for (var mi = 0; mi < nMembers; mi++) {
            var maxW = -Infinity;
            for (var ti = 0; ti < taus.length; ti++) {
                var tauKey = String(Math.round(taus[ti]));
                var data = intensity[tauKey];
                if (data && data.winds && data.winds[mi] != null) {
                    if (data.winds[mi] > maxW) maxW = data.winds[mi];
                }
            }
            if (maxW > -Infinity) lmiWinds.push(maxW);
        }

        if (lmiWinds.length === 0) return;

        // Pre-bin into 5-kt bins
        var binSize = 5;
        var binCenters = [];
        var binCounts = [];
        var binColors = [];
        for (var b = 0; b < 185; b += binSize) {
            var center = b + binSize / 2;
            var count = 0;
            for (var wi = 0; wi < lmiWinds.length; wi++) {
                if (lmiWinds[wi] >= b && lmiWinds[wi] < b + binSize) count++;
            }
            if (count > 0 || (b >= 20 && b <= 160)) {
                binCenters.push(center);
                binCounts.push(count);
                binColors.push(_dmWindColor(center));
            }
        }

        // Percentiles
        var sorted = lmiWinds.slice().sort(function (a, b) { return a - b; });
        var p = function (pct) { return sorted[Math.floor(pct / 100 * (sorted.length - 1))]; };
        var mean = lmiWinds.reduce(function (a, b) { return a + b; }, 0) / lmiWinds.length;

        var trace = {
            x: binCenters,
            y: binCounts,
            type: 'bar',
            width: binSize * 0.9,
            marker: {
                color: binColors,
                line: { color: 'rgba(0,0,0,0.3)', width: 0.5 }
            },
            hovertemplate: '%{x:.0f} kt<br>%{y} members<extra></extra>'
        };

        // SS threshold lines
        var shapes = [34, 64, 83, 96, 113, 137].map(function (v) {
            return {
                type: 'line', x0: v, x1: v, y0: 0, y1: 1, yref: 'paper',
                line: { color: 'rgba(255,255,255,0.15)', width: 1, dash: 'dot' }
            };
        });
        // Mean line
        shapes.push({
            type: 'line', x0: mean, x1: mean, y0: 0, y1: 1, yref: 'paper',
            line: { color: '#00e5ff', width: 1.5 }
        });

        // Compute category probabilities
        var catProbs = {};
        var cats = [['C1+', 64], ['C3+', 96], ['C5', 137]];
        for (var ci = 0; ci < cats.length; ci++) {
            var cnt = lmiWinds.filter(function (w) { return w >= cats[ci][1]; }).length;
            catProbs[cats[ci][0]] = Math.round(cnt / lmiWinds.length * 100);
        }

        // Compact summary as a single annotation at top-left (avoids overlap)
        var summaryText = 'P10: ' + p(10).toFixed(0) + '  P50: ' + p(50).toFixed(0) +
            '  P90: ' + p(90).toFixed(0) + ' kt';
        var catText = 'C1+: ' + catProbs['C1+'] + '%  C3+: ' + catProbs['C3+'] +
            '%  C5: ' + catProbs['C5'] + '%';

        var annotations = [
            { x: 0, y: 1.06, xref: 'paper', yref: 'paper', text: summaryText,
              showarrow: false, font: { size: 8, color: '#5b6573' },
              xanchor: 'left', yanchor: 'bottom' },
            { x: 1, y: 1.06, xref: 'paper', yref: 'paper', text: catText,
              showarrow: false, font: { size: 8, color: '#5b6573' },
              xanchor: 'right', yanchor: 'bottom' }
        ];

        var layout = {
            height: 180,
            margin: { t: 30, r: 10, b: 30, l: 40 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'JetBrains Mono, monospace', size: 9, color: '#5b6573' },
            xaxis: {
                title: { text: 'LMI Vmax (kt)', font: { size: 9 } },
                range: [0, 185],
                dtick: 20,
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            yaxis: {
                title: { text: 'Count', font: { size: 9 } },
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            shapes: shapes,
            annotations: annotations,
            bargap: 0.08
        };

        Plotly.newPlot(chartEl, [trace], layout, {
            displayModeBar: false, responsive: false, staticPlot: true
        });
    }

    function _rtRemoveDmEnsemble() {
        _rtDmEnsData = null;
        var distEl = document.getElementById('rt-dm-intensity-dist');
        var changeEl = document.getElementById('rt-dm-change-dist');
        var lmiEl = document.getElementById('rt-dm-lmi-dist');
        if (distEl) distEl.style.display = 'none';
        if (changeEl) changeEl.style.display = 'none';
        if (lmiEl) lmiEl.style.display = 'none';
        var histChart = document.getElementById('rt-dm-hist-chart');
        var changeChart = document.getElementById('rt-dm-change-chart');
        var lmiChart = document.getElementById('rt-dm-lmi-chart');
        if (histChart && typeof Plotly !== 'undefined') Plotly.purge(histChart);
        if (changeChart && typeof Plotly !== 'undefined') Plotly.purge(changeChart);
        if (lmiChart && typeof Plotly !== 'undefined') Plotly.purge(lmiChart);
    }

    // ── GDMI Chart PNG Export ─────────────────────────────────
    var _exportPopup = null;  // currently visible popup element
    var _exportTheme = 'dark';  // persistent preference

    function _rtDismissExportPopup() {
        if (_exportPopup && _exportPopup.parentNode) {
            _exportPopup.parentNode.removeChild(_exportPopup);
        }
        _exportPopup = null;
    }

    window._rtShowExportMenu = function (chartType, btnEl) {
        // If popup already open for this button, close it
        if (_exportPopup && _exportPopup.parentNode === btnEl) {
            _rtDismissExportPopup();
            return;
        }
        _rtDismissExportPopup();

        var popup = document.createElement('div');
        popup.className = 'rt-dm-export-popup';
        popup.onclick = function (e) { e.stopPropagation(); };

        var darkBtn = document.createElement('button');
        darkBtn.className = 'export-dark';
        darkBtn.textContent = 'Dark';
        darkBtn.onclick = function () { _rtDismissExportPopup(); _rtExportDmChart(chartType, 'dark'); };

        var lightBtn = document.createElement('button');
        lightBtn.className = 'export-light';
        lightBtn.textContent = 'Light';
        lightBtn.onclick = function () { _rtDismissExportPopup(); _rtExportDmChart(chartType, 'light'); };

        popup.appendChild(darkBtn);
        popup.appendChild(lightBtn);

        // Position relative to button
        btnEl.style.position = 'relative';
        btnEl.appendChild(popup);
        _exportPopup = popup;

        // Dismiss on outside click (next tick to avoid catching the opening click)
        function dismissHandler(e) {
            if (!popup.contains(e.target) && e.target !== btnEl) {
                _rtDismissExportPopup();
                document.removeEventListener('click', dismissHandler, true);
            }
        }
        setTimeout(function () {
            document.addEventListener('click', dismissHandler, true);
        }, 50);
    };

    function _rtExportDmChart(chartType, theme) {
        if (!_rtDmEnsData || typeof Plotly === 'undefined') return;

        // Re-render the chart to ensure it matches the current slider position
        if (chartType === 'intensity') _rtRenderIntensityHist();
        else if (chartType === 'change') _rtRenderChangeHist();
        else if (chartType === 'lmi') _rtRenderLmiHist();

        // Map chart type to element ID and metadata
        var chartMap = {
            'intensity': { el: 'rt-dm-hist-chart', label: 'Intensity Distribution' },
            'change':    { el: 'rt-dm-change-chart', label: 'Intensity Change' },
            'lmi':       { el: 'rt-dm-lmi-chart', label: 'Lifetime Max Intensity' }
        };
        var info = chartMap[chartType];
        if (!info) return;

        var chartEl = document.getElementById(info.el);
        if (!chartEl || !chartEl.data) return;

        // Build descriptive title
        var stormName = (document.getElementById('ir-detail-name') || {}).textContent || '';
        var stormId = currentStormId || '';
        var initTime = _rtDmEnsData.init_time || '';
        var initFmt = '';
        if (initTime.length >= 10) {
            initFmt = initTime.substring(4, 6) + '/' + initTime.substring(6, 8) + ' ' + initTime.substring(8, 10) + 'Z';
        }

        var tauStr = '';
        if (chartType === 'intensity') {
            var taus = _rtDmEnsData.lead_times_h || [];
            tauStr = ' \u2014 +' + (taus[_rtDmHistTauIdx] || 0) + 'h';
        } else if (chartType === 'change') {
            var taus = _rtDmEnsData.lead_times_h || [];
            tauStr = ' \u2014 +' + (taus[_rtDmChangeTauIdx] || 0) + 'h (' + _rtDmChangeInt + 'h change)';
        }

        var title = 'GDMI 1K ' + info.label + ' \u2014 ' + stormName + ' (' + stormId + ')' +
                    (initFmt ? ' \u2014 Init ' + initFmt : '') + tauStr;

        // Theme-dependent colors
        var isDark = theme === 'dark';
        var bgColor = isDark ? '#0f172a' : '#ffffff';
        var textColor = isDark ? '#e2e8f0' : '#1e293b';
        var gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
        var axisColor = isDark ? '#94a3b8' : '#475569';
        var lineColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';

        // Clone data and layout from the live chart
        var data = JSON.parse(JSON.stringify(chartEl.data));
        var layout = JSON.parse(JSON.stringify(chartEl.layout));

        // Apply publication overrides (8" × 6" at 2x scale = 1536 × 1152)
        layout.title = {
            text: title,
            font: { size: 16, color: textColor, family: 'JetBrains Mono, monospace' },
            x: 0.5, xanchor: 'center', y: 0.98
        };
        layout.paper_bgcolor = bgColor;
        layout.plot_bgcolor = bgColor;
        layout.font = { family: 'JetBrains Mono, monospace', size: 14, color: axisColor };
        layout.margin = { t: 75, r: 25, b: 60, l: 60 };
        layout.height = 576;
        layout.width = 768;

        // Update axis styles
        if (layout.xaxis) {
            layout.xaxis.gridcolor = gridColor;
            layout.xaxis.tickfont = { size: 14, color: axisColor };
            if (layout.xaxis.title) layout.xaxis.title.font = { size: 15, color: textColor };
        }
        if (layout.yaxis) {
            layout.yaxis.gridcolor = gridColor;
            layout.yaxis.tickfont = { size: 14, color: axisColor };
            if (layout.yaxis.title) layout.yaxis.title.font = { size: 15, color: textColor };
        }

        // Update shapes (threshold lines) colors for light theme
        if (layout.shapes) {
            for (var si = 0; si < layout.shapes.length; si++) {
                var shape = layout.shapes[si];
                if (shape.line && shape.line.color && shape.line.color.indexOf('255,255,255') >= 0) {
                    shape.line.color = lineColor;
                }
            }
        }

        // Update annotation colors and reposition percentile text below title
        if (layout.annotations) {
            for (var ai = 0; ai < layout.annotations.length; ai++) {
                var ann = layout.annotations[ai];
                if (ann.font && ann.font.color === '#94a3b8') {
                    ann.font.color = axisColor;
                }
                ann.font = ann.font || {};
                ann.font.size = Math.max((ann.font.size || 9) + 2, 10);
                // Move percentile summary (y > 1.0) below title — keep original x alignment
                if (ann.yref === 'paper' && ann.y > 1.0) {
                    ann.y = 1.01;
                    ann.font.size = 12;
                }
            }
        }

        // Add "TC-ATLAS" watermark
        layout.annotations = layout.annotations || [];
        layout.annotations.push({
            text: 'TC-ATLAS',
            xref: 'paper', yref: 'paper',
            x: 1, y: -0.12,
            showarrow: false,
            font: { size: 9, color: isDark ? '#475569' : '#94a3b8' },
            xanchor: 'right', yanchor: 'top'
        });

        // Render to temporary div and export
        var tmpDiv = document.createElement('div');
        tmpDiv.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
        document.body.appendChild(tmpDiv);

        Plotly.newPlot(tmpDiv, data, layout, { displayModeBar: false }).then(function () {
            return Plotly.toImage(tmpDiv, { format: 'png', width: 768, height: 576, scale: 2 });
        }).then(function (dataUrl) {
            // Trigger download
            var filename = 'GDMI_' + stormId + '_' + chartType;
            if (chartType !== 'lmi') {
                var taus = _rtDmEnsData.lead_times_h || [];
                var tau = chartType === 'intensity' ? taus[_rtDmHistTauIdx] : taus[_rtDmChangeTauIdx];
                filename += '_' + (tau || 0) + 'h';
            }
            filename += '_init' + initTime + '_' + theme + '.png';

            var a = document.createElement('a');
            a.href = dataUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Clean up temp div
            Plotly.purge(tmpDiv);
            document.body.removeChild(tmpDiv);
        }).catch(function (err) {
            console.warn('[RT Monitor] Chart export failed:', err);
            if (tmpDiv.parentNode) {
                Plotly.purge(tmpDiv);
                document.body.removeChild(tmpDiv);
            }
        });
    }

    function _rtRemoveWeatherlab() {
        _rtClearWeatherlabLayers();
        _rtClearWeatherlabIntensity();
        if (detailMap) detailMap.off('zoomend', _rtWeatherlabOnZoom);
        _rtWeatherlabData = null;
        _rtWeatherlabVisible = false;
        _rtWeatherlabMinCat = null;
        var btn = document.getElementById('rt-weatherlab-btn');
        if (btn) { btn.style.background = 'rgba(0,229,255,0.15)'; btn.title = ''; }
        var filterEl = document.getElementById('rt-weatherlab-filter');
        if (filterEl) filterEl.style.display = 'none';
    }

    // ═══════════════════════════════════════════════════════════
    //  ASCAT SCATTEROMETER WIND BARB OVERLAY
    // ═══════════════════════════════════════════════════════════

    /** Wind barb color scale by speed (knots) */
    var _ASCAT_COLORS = [
        [15,  '#60a5fa'],  // light blue: < 15 kt
        [25,  '#22c55e'],  // green: 15-25 kt
        [35,  '#eab308'],  // yellow: 25-35 kt
        [50,  '#f97316'],  // orange: 35-50 kt
        [64,  '#ef4444'],  // red: 50-64 kt
        [999, '#c026d3'],  // purple: 64+ kt (hurricane force)
    ];

    function _ascatColor(spdKt) {
        for (var i = 0; i < _ASCAT_COLORS.length; i++) {
            if (spdKt < _ASCAT_COLORS[i][0]) return _ASCAT_COLORS[i][1];
        }
        return _ASCAT_COLORS[_ASCAT_COLORS.length - 1][1];
    }

    /**
     * Build an SVG wind barb string for the given speed and direction.
     * Returns an SVG element string suitable for L.divIcon html.
     *
     * Meteorological convention: staff points toward the direction the
     * wind is coming FROM.  Feathers on the left side looking from base
     * to tip.
     */
    function _buildWindBarbSVG(speedKt, dirDeg) {
        var sz = 30;           // viewBox size
        var cx = sz / 2, cy = sz / 2;
        var staffLen = 12;     // pixels from center to tip
        var barbLen = 5;       // feather length
        var barbGap = 2.2;     // gap between feathers
        var flagH = 3;         // pennant height along staff
        var flagW = 5;         // pennant width

        var color = _ascatColor(speedKt);

        // Wind-from direction in radians (meteorological: 0° = from north, 90° = from east)
        var dirRad = (dirDeg) * Math.PI / 180;

        // Staff tip in the FROM direction (up = north = 0°)
        var sinD = Math.sin(dirRad), cosD = -Math.cos(dirRad);
        var tipX = cx + staffLen * sinD;
        var tipY = cy + staffLen * cosD;

        var paths = [];

        // Staff line
        paths.push('M' + cx.toFixed(1) + ',' + cy.toFixed(1) +
                   'L' + tipX.toFixed(1) + ',' + tipY.toFixed(1));

        // Feather encoding
        var remaining = Math.round(speedKt / 5) * 5;
        var nFlags = Math.floor(remaining / 50); remaining -= nFlags * 50;
        var nFull  = Math.floor(remaining / 10); remaining -= nFull * 10;
        var nHalf  = Math.floor(remaining / 5);

        // Perpendicular direction (left side looking from base to tip)
        var perpX = cosD;
        var perpY = -(-sinD);  // negated because SVG y-axis is inverted
        // Correct perpendicular: rotate staff direction 90° CCW
        perpX = -cosD;
        perpY = sinD;

        var pos = 0;  // distance from tip along staff

        // 50-kt pennant flags
        for (var fi = 0; fi < nFlags; fi++) {
            var frac1 = pos / staffLen;
            var fx1 = tipX + (cx - tipX) * frac1;
            var fy1 = tipY + (cy - tipY) * frac1;
            var frac2 = (pos + flagH) / staffLen;
            var fx2 = tipX + (cx - tipX) * frac2;
            var fy2 = tipY + (cy - tipY) * frac2;
            var midFrac = (pos + flagH * 0.5) / staffLen;
            var mx = tipX + (cx - tipX) * midFrac;
            var my = tipY + (cy - tipY) * midFrac;
            var outX = mx + flagW * perpX;
            var outY = my + flagW * perpY;
            // Filled triangle
            paths.push('M' + fx1.toFixed(1) + ',' + fy1.toFixed(1) +
                       'L' + outX.toFixed(1) + ',' + outY.toFixed(1) +
                       'L' + fx2.toFixed(1) + ',' + fy2.toFixed(1) + 'Z');
            pos += flagH + barbGap * 0.3;
        }

        // 10-kt full barbs
        for (var fb = 0; fb < nFull; fb++) {
            var frac = pos / staffLen;
            var bx = tipX + (cx - tipX) * frac;
            var by = tipY + (cy - tipY) * frac;
            paths.push('M' + bx.toFixed(1) + ',' + by.toFixed(1) +
                       'L' + (bx + barbLen * perpX).toFixed(1) + ',' +
                       (by + barbLen * perpY).toFixed(1));
            pos += barbGap;
        }

        // 5-kt half barbs
        for (var hb = 0; hb < nHalf; hb++) {
            // If this is the only feather, offset it slightly from the tip
            if (nFlags === 0 && nFull === 0 && pos === 0) pos = barbGap;
            var frac = pos / staffLen;
            var hx = tipX + (cx - tipX) * frac;
            var hy = tipY + (cy - tipY) * frac;
            paths.push('M' + hx.toFixed(1) + ',' + hy.toFixed(1) +
                       'L' + (hx + barbLen * 0.55 * perpX).toFixed(1) + ',' +
                       (hy + barbLen * 0.55 * perpY).toFixed(1));
            pos += barbGap;
        }

        // Combine into SVG
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + sz + '" height="' + sz +
            '" viewBox="0 0 ' + sz + ' ' + sz + '">' +
            '<path d="' + paths.join(' ') + '" stroke="' + color +
            '" stroke-width="1.5" fill="' + color + '" fill-opacity="0.3" ' +
            'stroke-linecap="round" stroke-linejoin="round"/></svg>';
        return svg;
    }

    /**
     * Load ASCAT pass list for a storm (called from openStormDetail).
     */
    function _rtLoadAscatPasses(storm) {
        var section = document.getElementById('rt-ascat-section');
        var statusEl = document.getElementById('rt-ascat-status');
        var atcfId = storm.atcf_id;

        if (!atcfId) {
            if (section) section.style.display = 'none';
            return;
        }

        // Skip if already loaded for this storm
        if (atcfId === _rtAscatLastAtcf && _rtAscatPasses) {
            if (section) section.style.display = '';
            return;
        }
        _rtAscatLastAtcf = atcfId;
        _rtAscatPasses = null;

        // Check panel cache
        var cached = _panelCache[atcfId];
        if (cached && cached.ascat && (Date.now() - cached.cachedAt) < PANEL_CACHE_TTL_MS) {
            _rtAscatPasses = cached.ascat;
            if (section) section.style.display = '';
            var json = cached.ascat;
            if (!json.passes || json.passes.length === 0) {
                if (statusEl) statusEl.textContent = 'No passes found';
            } else {
                if (statusEl) statusEl.textContent = json.passes.length + ' pass' + (json.passes.length > 1 ? 'es' : '');
                var sel = document.getElementById('rt-ascat-pass-select');
                if (sel) {
                    sel.innerHTML = '';
                    for (var ci = 0; ci < json.passes.length; ci++) {
                        var cp = json.passes[ci];
                        var copt = document.createElement('option');
                        copt.value = ci;
                        copt.textContent = cp.satellite + ' \u2014 ' + cp.datetime_utc;
                        sel.appendChild(copt);
                    }
                }
            }
            return;
        }

        if (statusEl) statusEl.textContent = 'Searching...';
        if (section) section.style.display = '';

        var retries = 0;
        function _doFetch() {
            fetch(API_BASE + '/ascat/passes?atcf_id=' + encodeURIComponent(atcfId) + '&hours=12', { cache: 'no-store' })
                .then(function (r) {
                    // Retry on 404 — backend storm cache may not be warm yet
                    if (r.status === 404 && retries < 2) {
                        retries++;
                        console.log('[RT ASCAT] Storm not in cache yet, retry ' + retries + '/2 in 5s...');
                        setTimeout(_doFetch, 5000);
                        return;
                    }
                    if (!r.ok) throw new Error(r.status);
                    return r.json();
                })
                .then(function (json) {
                    if (!json) return;  // was a retry
                    _rtAscatPasses = json;
                    if (!_panelCache[atcfId]) _panelCache[atcfId] = { cachedAt: Date.now() };
                    _panelCache[atcfId].ascat = json;

                    if (!json.passes || json.passes.length === 0) {
                        if (statusEl) statusEl.textContent = 'No passes found';
                        return;
                    }

                    if (statusEl) statusEl.textContent = json.passes.length + ' pass' + (json.passes.length > 1 ? 'es' : '');

                    // Populate pass dropdown
                    var sel = document.getElementById('rt-ascat-pass-select');
                    if (sel) {
                        sel.innerHTML = '';
                        for (var i = 0; i < json.passes.length; i++) {
                            var p = json.passes[i];
                            var opt = document.createElement('option');
                            opt.value = i;
                            opt.textContent = p.satellite + ' \u2014 ' + p.datetime_utc;
                            sel.appendChild(opt);
                        }
                    }
                })
                .catch(function (err) {
                    console.warn('[RT ASCAT] Failed to load passes:', err);
                    if (statusEl) statusEl.textContent = '';
                    if (section) section.style.display = 'none';
                });
        }
        _doFetch();
    }

    /**
     * Toggle ASCAT wind barb overlay on/off.
     */
    window._rtToggleAscatOverlay = function () {
        var btn = document.getElementById('rt-ascat-toggle-btn');
        var controls = document.getElementById('rt-ascat-controls');

        if (_rtAscatVisible) {
            _rtAscatVisible = false;
            if (btn) btn.textContent = 'ASCAT';
            if (controls) controls.style.display = 'none';
            _rtClearAscatLayers();
            return;
        }

        _rtAscatVisible = true;
        if (btn) btn.textContent = 'Hide';
        if (controls) controls.style.display = '';

        // Load winds for the selected pass
        var sel = document.getElementById('rt-ascat-pass-select');
        if (sel) {
            window._rtSelectAscatPass(sel.value);
        }
    };

    // ════════════════════════════════════════════════════════════════
    //  Storm-sector microwave passes (last 24h, chronological)
    //  Reads the same manifest_latest_48h.json that the Global Map's
    //  microwave layer consumes, filters to passes whose bounds
    //  contain the storm position, groups by orbit_id (one entry per
    //  product per orbit), and renders a chronological card list
    //  with storm-cropped canvas thumbnails. Default product = 89pct.
    // ════════════════════════════════════════════════════════════════
    var _RT_MW_MANIFEST_URL = 'https://storage.googleapis.com/tc-atlas-microwave-nrt/manifest_latest_48h.json';
    var _RT_MW_MANIFEST_TTL_MS = 5 * 60 * 1000;       // 5 min
    var _RT_MW_WINDOW_MS = 24 * 60 * 60 * 1000;       // 24 h list
    var _RT_MW_HALF_DEG = 6;                          // ±6° storm box
    var _RT_MW_THUMB_PX = 160;                        // canvas size
    var _RT_MW_SENSOR_COLOR = {
        GMI:   '#4ade80', SSMIS: '#60a5fa',
        AMSR2: '#fb923c', ATMS:  '#c084fc'
    };
    var _rtMwManifest = null;
    var _rtMwManifestFetchedAt = 0;
    var _rtMwStormState = {
        atcfId: null, lat: null, lon: null, product: '89pct',
        storm: null, // full storm record (for the compare modal header)
        orbits: []   // grouped & sorted entries for the current storm
    };

    function _rtMwBoundsContains(bounds, lat, lon) {
        if (!bounds || !bounds[0] || !bounds[1]) return false;
        var south = bounds[0][0], west = bounds[0][1];
        var north = bounds[1][0], east = bounds[1][1];
        if (lat < south || lat > north) return false;
        if (west <= east) return lon >= west && lon <= east;
        return lon >= west || lon <= east;   // dateline wrap
    }

    // Fetch + cache the public 48h manifest. ~5-min cache lines up
    // with the file's Cache-Control header from the ingest writer.
    function _rtMwFetchManifest() {
        var age = Date.now() - _rtMwManifestFetchedAt;
        if (_rtMwManifest && age < _RT_MW_MANIFEST_TTL_MS) {
            return Promise.resolve(_rtMwManifest);
        }
        return fetch(_RT_MW_MANIFEST_URL, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('manifest HTTP ' + r.status);
                return r.json();
            })
            .then(function (m) {
                _rtMwManifest = m;
                _rtMwManifestFetchedAt = Date.now();
                return m;
            });
    }

    // Entry point — called from the deferred-loads block once a storm
    // is selected. Fetches the manifest, filters to last-24h passes
    // covering the storm, groups by orbit, and renders.
    function _rtLoadStormMwPasses(storm) {
        var section  = document.getElementById('rt-mw-storm-section');
        var statusEl = document.getElementById('rt-mw-storm-status');
        var listEl   = document.getElementById('rt-mw-storm-list');
        if (!section || !storm || storm.lat == null || storm.lon == null) {
            if (section) section.style.display = 'none';
            return;
        }
        section.style.display = '';
        if (statusEl) statusEl.textContent = 'loading…';
        if (listEl) listEl.innerHTML = '';

        _rtMwStormState.atcfId = storm.atcf_id;
        _rtMwStormState.lat = storm.lat;
        _rtMwStormState.lon = storm.lon;
        _rtMwStormState.storm = storm;

        _rtMwFetchManifest()
            .then(function (m) {
                if (_rtMwStormState.atcfId !== storm.atcf_id) return;  // moved on
                var entries = (m && m.entries) || [];
                var nowMs = Date.now();
                var orbitMap = {};
                for (var i = 0; i < entries.length; i++) {
                    var e = entries[i];
                    var t = Date.parse(e.scan_start);
                    if (!isFinite(t) || (nowMs - t) > _RT_MW_WINDOW_MS) continue;
                    if (!_rtMwBoundsContains(e.bounds, storm.lat, storm.lon)) continue;
                    var oid = e.orbit_id;
                    if (!orbitMap[oid]) {
                        orbitMap[oid] = {
                            orbit_id: oid,
                            sensor: e.sensor,
                            platform: e.platform,
                            scan_start: e.scan_start,
                            scan_start_ms: t,
                            bounds: e.bounds,
                            products: {}    // product -> { png_url, geojson_url }
                        };
                    }
                    orbitMap[oid].products[e.product] = {
                        png_url: e.png_url,
                        geojson_url: e.geojson_url
                    };
                }
                // Newest first — analyst typically wants "what's the latest
                // pass" at a glance; older context follows down the list.
                var orbits = Object.keys(orbitMap).map(function (k) { return orbitMap[k]; });
                orbits.sort(function (a, b) { return b.scan_start_ms - a.scan_start_ms; });
                _rtMwStormState.orbits = orbits;
                if (statusEl) {
                    statusEl.textContent = orbits.length
                        ? (orbits.length + ' pass' + (orbits.length === 1 ? '' : 'es'))
                        : 'no passes';
                }
                _rtRenderStormMwPasses();
            })
            .catch(function (err) {
                console.warn('[RT MW Storm] manifest fetch failed:', err);
                if (statusEl) statusEl.textContent = 'unavailable';
                if (listEl) listEl.innerHTML = '';
            });
    }

    // Render the chronological pass list using the currently-selected
    // product (default 89pct). Each card shows: storm-cropped thumbnail,
    // sensor + platform, time-ago, full UTC timestamp. Click opens the
    // full pass PNG (full swath, not cropped) in a new tab.
    function _rtRenderStormMwPasses() {
        var listEl = document.getElementById('rt-mw-storm-list');
        if (!listEl) return;
        var orbits = _rtMwStormState.orbits || [];
        var product = _rtMwStormState.product || '89pct';
        var lat = _rtMwStormState.lat;
        var lon = _rtMwStormState.lon;
        if (!orbits.length) {
            listEl.innerHTML = '<div class="rt-mw-storm-empty">No microwave passes have covered this storm in the last 24 hours.</div>';
            return;
        }
        listEl.innerHTML = '';
        var statusEl2 = document.getElementById('rt-mw-storm-status');
        var coveredCount = 0;
        var resolvedCount = 0;
        if (statusEl2) statusEl2.textContent = 'filtering…';
        function _bumpStatus() {
            if (!statusEl2) return;
            statusEl2.textContent = coveredCount + ' pass'
                + (coveredCount === 1 ? '' : 'es');
        }
        var nowMs = Date.now();
        for (var i = 0; i < orbits.length; i++) {
            var o = orbits[i];
            var pr = o.products[product];
            var card = document.createElement('div');
            card.className = 'rt-mw-storm-card';
            var swatch = _RT_MW_SENSOR_COLOR[o.sensor] || '#cbd5e1';
            var ageMin = (nowMs - o.scan_start_ms) / 60000;
            var ageStr = _rtMwFmtAgo(ageMin);
            var utcStr = o.scan_start.replace('T', ' ').slice(0, 16) + 'Z';
            var thumbWrap = document.createElement('div');
            thumbWrap.className = 'rt-mw-storm-thumb-wrap';
            if (pr && pr.png_url) {
                var c = document.createElement('canvas');
                c.width = _RT_MW_THUMB_PX;
                c.height = _RT_MW_THUMB_PX;
                c.className = 'rt-mw-storm-thumb';
                c.title = o.sensor + ' (' + o.platform + ') — '
                        + product + ' — ' + utcStr;
                thumbWrap.appendChild(c);
                (function (cardEl) {
                    _rtDrawStormMwThumbnail(c, o, lat, lon, pr.png_url,
                        function (frac) {
                            resolvedCount++;
                            if (frac < _RT_MW_MIN_COVERAGE) {
                                // Swath bbox covered the storm but the
                                // data path didn't. Hide the card so the
                                // user only sees passes that actually
                                // saw the system.
                                cardEl.style.display = 'none';
                            } else {
                                coveredCount++;
                                _bumpStatus();
                            }
                            // Final status when all images have resolved.
                            if (resolvedCount === orbits.length && statusEl2) {
                                if (coveredCount === 0) {
                                    statusEl2.textContent = 'no passes covered storm';
                                } else {
                                    _bumpStatus();
                                }
                            }
                        });
                })(card);
                // Click handler lives on the whole card (not just the
                // thumbnail) so users can hit the meta column too — the
                // thumbnail-only target wasn't intuitive.
                card.classList.add('rt-mw-storm-card-clickable');
                card.setAttribute('role', 'button');
                card.setAttribute('tabindex', '0');
                card.setAttribute('title',
                    'Open side-by-side IR / Microwave compare for this pass');
                (function (orbit) {
                    card.addEventListener('click', function () {
                        _rtOpenMwCompare(orbit, _rtMwStormState.storm);
                    });
                    // Keyboard parity — Enter / Space activate the card
                    // when focused via tab navigation.
                    card.addEventListener('keydown', function (ev) {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                            ev.preventDefault();
                            _rtOpenMwCompare(orbit, _rtMwStormState.storm);
                        }
                    });
                })(o);
            } else {
                var miss = document.createElement('div');
                miss.className = 'rt-mw-storm-thumb-missing';
                miss.textContent = product + ' n/a';
                thumbWrap.appendChild(miss);
            }
            var meta = document.createElement('div');
            meta.className = 'rt-mw-storm-meta';
            meta.innerHTML =
                '<div class="rt-mw-storm-sensor">'
                + '<span class="rt-mw-storm-swatch" style="background:' + swatch + '"></span>'
                + '<strong>' + _esc(o.sensor) + '</strong> '
                + '<span class="rt-mw-storm-platform">' + _esc(o.platform || '') + '</span>'
                + '</div>'
                + '<div class="rt-mw-storm-time">' + _esc(ageStr) + '</div>'
                + '<div class="rt-mw-storm-utc">' + _esc(utcStr) + '</div>';
            card.appendChild(thumbWrap);
            card.appendChild(meta);
            listEl.appendChild(card);
        }
    }

    // Crop a storm-centered sub-rectangle out of the pass PNG. The
    // PNG is equirectangular over `entry.bounds` (Leaflet-style
    // [[south,west],[north,east]]); we compute the storm's ±_RT_MW_HALF_DEG
    // box in geographic coords, map it to pixel space via linear scaling,
    // and drawImage the crop into the thumbnail canvas. Off-bounds
    // regions stay transparent on the canvas (handled by drawImage).
    // Coverage threshold for filtering. The pass-arc's rectangular
    // bbox contains the storm position, but the actual swath data may
    // not — many swaths have NaN→transparent margins, and the storm
    // can fall in a polar-clipped gap or to one side of the swath.
    // After drawing the storm-crop, we measure colored-pixel fraction
    // and signal "no coverage" to the caller for cards that drew
    // basically nothing.
    var _RT_MW_MIN_COVERAGE = 0.02;   // ≥2% colored pixels = "covered"

    // Format a lat/lon as JTWC/NHC-style label (12°N / 138°E / 180°).
    function _rtFmtLat(v) {
        if (Math.abs(v) < 0.05) return '0°';
        return Math.abs(v).toFixed(0) + '°' + (v >= 0 ? 'N' : 'S');
    }
    function _rtFmtLon(v) {
        var x = v;
        while (x > 180) x -= 360;
        while (x < -180) x += 360;
        if (Math.abs(x) < 0.05) return '0°';
        if (Math.abs(Math.abs(x) - 180) < 0.05) return '180°';
        return Math.abs(x).toFixed(0) + '°' + (x >= 0 ? 'E' : 'W');
    }

    // Overlay a lat/lon graticule on a storm-centered canvas. The
    // canvas covers ±halfDeg around (centerLat, centerLon). `step`
    // is the gridline spacing in degrees. Dashed light strokes + edge
    // labels so the user can read off a position without clicking
    // through to a full Leaflet map.
    function _rtDrawLatLonGrid(ctx, w, h, centerLat, centerLon, halfDeg, step) {
        if (!step) step = 2;
        var latMin = centerLat - halfDeg, latMax = centerLat + halfDeg;
        var lonMin = centerLon - halfDeg, lonMax = centerLon + halfDeg;
        // Snap first gridline to nearest multiple of `step` inside extent.
        var firstLat = Math.ceil(latMin / step) * step;
        var firstLon = Math.ceil(lonMin / step) * step;
        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(241, 245, 249, 0.45)';
        ctx.setLineDash([3, 4]);
        ctx.font = '10px ui-monospace, "SF Mono", Menlo, monospace';
        ctx.fillStyle = 'rgba(241, 245, 249, 0.85)';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(15, 22, 36, 0.85)';
        ctx.shadowBlur = 3;
        // Parallels (lat).
        for (var lat = firstLat; lat <= latMax; lat += step) {
            var y = ((latMax - lat) / (2 * halfDeg)) * h;
            ctx.beginPath();
            ctx.moveTo(0, y); ctx.lineTo(w, y);
            ctx.stroke();
            ctx.textAlign = 'left';
            ctx.fillText(_rtFmtLat(lat), 4, y + 2);
        }
        // Meridians (lon).
        for (var lon = firstLon; lon <= lonMax; lon += step) {
            var x = ((lon - lonMin) / (2 * halfDeg)) * w;
            ctx.beginPath();
            ctx.moveTo(x, 0); ctx.lineTo(x, h);
            ctx.stroke();
            ctx.textAlign = 'center';
            ctx.fillText(_rtFmtLon(lon), x, h - 14);
        }
        ctx.restore();
    }

    // Optional `onCoverage(frac)` callback fires once after the image
    // loads + cropping completes. Callers use it to hide cards whose
    // swath geometry happens not to touch the storm position.
    // `withGrid` (default false) draws a lat/lon graticule on top of
    // the swath — used by the compare-modal panels but not the small
    // 80-px side-panel thumbnails where a grid would just clutter.
    function _rtDrawStormMwThumbnail(canvas, orbit, lat, lon, pngUrl, onCoverage, withGrid) {
        var ctx = canvas.getContext('2d');
        // High-quality interpolation — bicubic on most modern engines.
        // Helps when the storm crop pulls only a small slice of the
        // source PNG and has to upscale to the display canvas.
        ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
        // Start with a transparent canvas — we'll add the dim navy bg
        // BEHIND the image via globalCompositeOperation so the alpha
        // sampling below sees only the actual swath pixels.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
            var south = orbit.bounds[0][0], west = orbit.bounds[0][1];
            var north = orbit.bounds[1][0], east = orbit.bounds[1][1];
            // Handle dateline wrap: shift east-side bounds so west < east.
            var wWrapped = west, eWrapped = east, lonShift = lon;
            if (west > east) {
                eWrapped = east + 360;
                if (lonShift < west) lonShift += 360;
            }
            var spanLat = north - south;
            var spanLon = eWrapped - wWrapped;
            if (spanLat <= 0 || spanLon <= 0) {
                if (onCoverage) onCoverage(0);
                return;
            }
            // Pixel coords: top-left = (north, west). y increases southward.
            var stormBox = {
                latMax: lat + _RT_MW_HALF_DEG,
                latMin: lat - _RT_MW_HALF_DEG,
                lonMin: lonShift - _RT_MW_HALF_DEG,
                lonMax: lonShift + _RT_MW_HALF_DEG
            };
            var sx = (stormBox.lonMin - wWrapped) / spanLon * img.width;
            var sy = (north - stormBox.latMax) / spanLat * img.height;
            var sw = (2 * _RT_MW_HALF_DEG) / spanLon * img.width;
            var sh = (2 * _RT_MW_HALF_DEG) / spanLat * img.height;
            // Clamp source rect to image bounds.
            var sxC = Math.max(0, sx);
            var syC = Math.max(0, sy);
            var sxE = Math.min(img.width, sx + sw);
            var syE = Math.min(img.height, sy + sh);
            var swC = sxE - sxC;
            var shC = syE - syC;
            if (swC <= 0 || shC <= 0) {
                if (onCoverage) onCoverage(0);
                return;
            }
            var dx = (sxC - sx) / sw * canvas.width;
            var dy = (syC - sy) / sh * canvas.height;
            var dw = swC / sw * canvas.width;
            var dh = shC / sh * canvas.height;
            ctx.drawImage(img, sxC, syC, swC, shC, dx, dy, dw, dh);

            // Measure swath coverage in the crop. CrossOrigin=anonymous
            // + the bucket's CORS config keep the canvas un-tainted so
            // getImageData succeeds. Empty swath margins leave alpha=0
            // pixels; any drawn pixel has alpha>0.
            var frac = 0;
            try {
                var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                var nonEmpty = 0;
                for (var p = 3; p < data.length; p += 4) {
                    if (data[p] > 10) nonEmpty++;
                }
                frac = nonEmpty / (canvas.width * canvas.height);
            } catch (e) {
                // Tainted canvas (rare — implies CORS hiccup). Treat as
                // covered so we don't accidentally hide everything.
                frac = 1;
            }

            // Paint the dim navy bg BEHIND the swath so blank margins
            // read as "no data" instead of see-through to the modal bg.
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = 'rgba(15,22,36,0.55)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.globalCompositeOperation = 'source-over';

            // Storm-center cross only if there's actual coverage to mark.
            if (frac >= _RT_MW_MIN_COVERAGE) {
                var cx = canvas.width / 2;
                var cy = canvas.height / 2;
                ctx.strokeStyle = 'rgba(253, 224, 71, 0.95)';
                ctx.lineWidth = withGrid ? 2 : 1.5;
                var armLen = withGrid ? 10 : 6;
                ctx.beginPath();
                ctx.moveTo(cx - armLen, cy); ctx.lineTo(cx + armLen, cy);
                ctx.moveTo(cx, cy - armLen); ctx.lineTo(cx, cy + armLen);
                ctx.stroke();
            }
            if (withGrid) {
                _rtDrawLatLonGrid(ctx, canvas.width, canvas.height,
                                  lat, lon, _RT_MW_HALF_DEG, 2);
            }
            if (onCoverage) onCoverage(frac);
        };
        img.onerror = function () {
            ctx.fillStyle = 'rgba(239,68,68,0.4)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#fca5a5';
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('load failed', canvas.width / 2, canvas.height / 2);
            if (onCoverage) onCoverage(0);
        };
        img.src = pngUrl;
    }

    function _rtMwFmtAgo(ageMin) {
        if (ageMin < 1)  return 'just now';
        if (ageMin < 60) return Math.round(ageMin) + ' min ago';
        var h = ageMin / 60;
        if (h < 24) return h.toFixed(1) + ' h ago';
        return (h / 24).toFixed(1) + ' d ago';
    }

    // HTML-escape user-or-server strings before innerHTML. Same shape
    // as the helper in tc_mw_layer.js so the UI's defensive posture
    // stays consistent across both places this kind of label gets
    // built.
    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Product chip click — switch the active product and re-render.
    // Bound once at module init below.
    function _rtBindStormMwProductChips() {
        var bar = document.getElementById('rt-mw-storm-products');
        if (!bar) return;
        bar.addEventListener('click', function (ev) {
            var btn = ev.target.closest && ev.target.closest('.rt-mw-storm-chip');
            if (!btn) return;
            var product = btn.getAttribute('data-product');
            if (!product || product === _rtMwStormState.product) return;
            _rtMwStormState.product = product;
            var chips = bar.querySelectorAll('.rt-mw-storm-chip');
            for (var i = 0; i < chips.length; i++) {
                chips[i].classList.toggle('active',
                    chips[i].getAttribute('data-product') === product);
            }
            _rtRenderStormMwPasses();
        });
    }
    _rtBindStormMwProductChips();

    // ════════════════════════════════════════════════════════════════
    //  IR ↔ MW side-by-side compare modal
    //  Opens when a user clicks a MW pass thumbnail. Left panel shows
    //  the storm-cropped IR frame closest in time to the MW pass; right
    //  panel shows the same storm sector for the selected MW product.
    //  Product chips swap the MW side; IR stays pegged to the MW time.
    // ════════════════════════════════════════════════════════════════
    var _rtMwCompareState = {
        orbit: null,         // the clicked orbit row
        storm: null,         // current storm {atcf_id, name, lat, lon, ...}
        product: '89pct',
        irMeta: null,        // cached /ir-frames-meta response
        irMetaAtcf: null,    // atcf_id the irMeta was fetched for
    };
    var _RT_MW_COMPARE_LOOKBACK_H = 24;  // matches MW window
    var _RT_MW_COMPARE_RADIUS = 10;      // IR JPG returns ±radius_deg box
    // Compare-canvas half-width matches the thumbnail crop so the two
    // panels show the exact same geographic extent — direct visual
    // alignment is the whole point of this view.
    var _RT_MW_COMPARE_HALF_DEG = _RT_MW_HALF_DEG;
    var _RT_MW_COMPARE_PX = 600;         // canvas display size

    // Open the compare modal from a click on a MW pass card. The orbit
    // carries scan_start + products + bounds; storm carries lat/lon.
    function _rtOpenMwCompare(orbit, storm) {
        var modal = document.getElementById('rt-mw-compare-modal');
        if (!modal || !orbit || !storm) return;
        _rtMwCompareState.orbit = orbit;
        _rtMwCompareState.storm = storm;
        _rtMwCompareState.product = _rtMwStormState.product || '89pct';

        // Sync the modal's product chips to the current product so the
        // user sees the same selection they had in the side panel.
        var chips = modal.querySelectorAll('.rt-mw-storm-chip');
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.toggle('active',
                chips[i].getAttribute('data-product') === _rtMwCompareState.product);
        }

        // Title + subtitle
        var ttl = document.getElementById('rt-mw-compare-title');
        var sub = document.getElementById('rt-mw-compare-sub');
        if (ttl) {
            var nm = (storm.name || storm.atcf_id || 'Storm');
            ttl.textContent = nm + ' · IR ↔ Microwave';
        }
        if (sub) {
            var utcStr = orbit.scan_start.replace('T', ' ').slice(0, 16) + 'Z';
            sub.textContent = orbit.sensor + ' (' + (orbit.platform || '?') + ') · '
                            + utcStr;
        }

        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        _rtRenderMwCompare();
        _ga('rt_mw_compare_open', {
            sensor: orbit.sensor, product: _rtMwCompareState.product
        });
    }

    function _rtCloseMwCompare() {
        var modal = document.getElementById('rt-mw-compare-modal');
        if (!modal) return;
        modal.style.display = 'none';
        document.body.style.overflow = '';
        _rtMwCompareState.orbit = null;
    }
    window._rtCloseMwCompare = _rtCloseMwCompare;

    // Render both compare panels. MW panel always renders from the
    // currently-selected product's PNG; IR panel fetches the frames
    // meta (cached per storm) to pick the closest frame, then fetches
    // that frame's JPG and crops to the storm sector.
    function _rtRenderMwCompare() {
        var orbit = _rtMwCompareState.orbit;
        var storm = _rtMwCompareState.storm;
        if (!orbit || !storm) return;
        var product = _rtMwCompareState.product;

        // ── MW panel ──────────────────────────────────────────────
        var mwCanvas = document.getElementById('rt-mw-compare-mw');
        var mwStatus = document.getElementById('rt-mw-compare-mw-status');
        var mwTimeEl = document.getElementById('rt-mw-compare-mw-time');
        if (mwTimeEl) {
            mwTimeEl.textContent =
                orbit.scan_start.replace('T', ' ').slice(0, 16) + 'Z';
        }
        var pr = orbit.products[product];
        if (mwCanvas && pr && pr.png_url) {
            if (mwStatus) mwStatus.textContent = '';
            _rtDrawStormMwThumbnail(mwCanvas, orbit, storm.lat, storm.lon,
                                    pr.png_url, function (frac) {
                if (mwStatus) {
                    mwStatus.textContent = frac < _RT_MW_MIN_COVERAGE
                        ? 'storm sits outside the actual swath data'
                        : '';
                }
            }, true /* withGrid */);
        } else if (mwCanvas) {
            var ctx = mwCanvas.getContext('2d');
            ctx.fillStyle = 'rgba(15,22,36,0.55)';
            ctx.fillRect(0, 0, mwCanvas.width, mwCanvas.height);
            if (mwStatus) mwStatus.textContent = product + ' not available for this pass';
        }

        // ── IR panel ──────────────────────────────────────────────
        var irCanvas = document.getElementById('rt-mw-compare-ir');
        var irStatus = document.getElementById('rt-mw-compare-ir-status');
        var irTimeEl = document.getElementById('rt-mw-compare-ir-time');
        if (!irCanvas) return;
        if (irStatus) irStatus.textContent = 'finding closest IR…';
        if (irTimeEl) irTimeEl.textContent = '—';
        var ctx2 = irCanvas.getContext('2d');
        ctx2.fillStyle = 'rgba(15,22,36,0.55)';
        ctx2.fillRect(0, 0, irCanvas.width, irCanvas.height);

        var mwMs = orbit.scan_start_ms;
        _rtFetchIrFramesMeta(storm)
            .then(function (meta) {
                if (!meta || !meta.frames || !meta.frames.length) {
                    if (irStatus) irStatus.textContent = 'no IR frames available';
                    return;
                }
                // Closest frame by datetime_utc.
                var best = null, bestDist = Infinity;
                for (var i = 0; i < meta.frames.length; i++) {
                    var t = Date.parse(meta.frames[i].datetime_utc);
                    if (!isFinite(t)) continue;
                    var d = Math.abs(t - mwMs);
                    if (d < bestDist) { bestDist = d; best = meta.frames[i]; }
                }
                if (!best) {
                    if (irStatus) irStatus.textContent = 'no matchable IR frame';
                    return;
                }
                var deltaMin = (Date.parse(best.datetime_utc) - mwMs) / 60000;
                if (irTimeEl) {
                    irTimeEl.textContent = best.datetime_utc.replace('T', ' ').slice(0, 16) + 'Z'
                        + ' (' + (deltaMin >= 0 ? '+' : '') + Math.round(deltaMin)
                        + ' min vs MW)';
                }
                if (irStatus) irStatus.textContent = 'loading IR frame…';
                // Fetch the JPG, then draw the ±_RT_MW_COMPARE_HALF_DEG
                // sub-rect (storm-centered crop) onto the compare canvas.
                _rtDrawIrCompareFrame(irCanvas, storm, best.index, function (err) {
                    if (irStatus) {
                        irStatus.textContent = err
                            ? 'IR frame load failed'
                            : '';
                    }
                });
            })
            .catch(function (err) {
                console.warn('[RT MW Compare] frames-meta failed', err);
                if (irStatus) irStatus.textContent = 'IR meta unavailable';
            });
    }

    // Cache /ir-frames-meta per storm so swapping products doesn't
    // re-hit the API. Same shape as panelCache, smaller scope.
    function _rtFetchIrFramesMeta(storm) {
        if (_rtMwCompareState.irMetaAtcf === storm.atcf_id
                && _rtMwCompareState.irMeta) {
            return Promise.resolve(_rtMwCompareState.irMeta);
        }
        var url = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
            + '/ir-frames-meta?lookback_hours=' + _RT_MW_COMPARE_LOOKBACK_H
            + '&radius_deg=' + _RT_MW_COMPARE_RADIUS
            + '&interval_min=30';
        return fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('frames-meta HTTP ' + r.status);
                return r.json();
            })
            .then(function (m) {
                _rtMwCompareState.irMeta = m;
                _rtMwCompareState.irMetaAtcf = storm.atcf_id;
                return m;
            });
    }

    // Draw the storm-centered ±_RT_MW_COMPARE_HALF_DEG crop of the IR
    // JPG into the supplied canvas. The IR JPG covers a 20° × 20° box
    // (radius_deg = 10) centered on the storm, so the storm sits at
    // image center and the ±6° crop is the central 60% of the image.
    function _rtDrawIrCompareFrame(canvas, storm, frameIndex, done) {
        var url = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
            + '/ir-frame.jpg?frame_index=' + frameIndex
            + '&lookback_hours=' + _RT_MW_COMPARE_LOOKBACK_H
            + '&radius_deg=' + _RT_MW_COMPARE_RADIUS
            + '&interval_min=30';
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
            var ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
            ctx.fillStyle = 'rgba(15,22,36,0.55)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            var crop = _RT_MW_COMPARE_HALF_DEG / _RT_MW_COMPARE_RADIUS;
            var sx = img.width  * (1 - crop) / 2;
            var sy = img.height * (1 - crop) / 2;
            var sw = img.width  * crop;
            var sh = img.height * crop;
            ctx.drawImage(img, sx, sy, sw, sh,
                          0, 0, canvas.width, canvas.height);
            // Storm-center crosshair so the two panels feel like a true
            // side-by-side (both have the same yellow marker at center).
            var cx = canvas.width / 2;
            var cy = canvas.height / 2;
            ctx.strokeStyle = 'rgba(253, 224, 71, 0.95)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
            ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
            ctx.stroke();
            // Same lat/lon graticule as the MW panel so the two panels
            // share an explicit positional reference, not just a center
            // marker. Storm center is canvas center; ±_RT_MW_COMPARE_HALF_DEG.
            _rtDrawLatLonGrid(ctx, canvas.width, canvas.height,
                              storm.lat, storm.lon,
                              _RT_MW_COMPARE_HALF_DEG, 2);
            if (done) done(null);
        };
        img.onerror = function () { if (done) done(new Error('IR jpg load failed')); };
        img.src = url;
    }

    // Bind modal-level events: close button, Esc key, click-on-backdrop,
    // and product-chip clicks (re-render MW side without touching IR).
    // Idempotent (`_rtMwCompareBound` guard) since the deferred-readiness
    // path below may call this multiple times.
    var _rtMwCompareBound = false;
    function _rtBindMwCompareModal() {
        if (_rtMwCompareBound) return;
        var modal = document.getElementById('rt-mw-compare-modal');
        // realtime_ir.js loads before the modal HTML at the end of body
        // is parsed. If the element isn't there yet, retry on DOM ready.
        if (!modal) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded',
                                          _rtBindMwCompareModal,
                                          { once: true });
            }
            return;
        }
        _rtMwCompareBound = true;
        var closeBtn = modal.querySelector('.rt-mw-compare-close');
        if (closeBtn) closeBtn.addEventListener('click', _rtCloseMwCompare);
        modal.addEventListener('click', function (ev) {
            if (ev.target === modal) _rtCloseMwCompare();
        });
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && modal.style.display !== 'none') {
                _rtCloseMwCompare();
            }
        });
        var bar = document.getElementById('rt-mw-compare-products');
        if (!bar) return;
        bar.addEventListener('click', function (ev) {
            var btn = ev.target.closest && ev.target.closest('.rt-mw-storm-chip');
            if (!btn) return;
            var product = btn.getAttribute('data-product');
            if (!product || product === _rtMwCompareState.product) return;
            _rtMwCompareState.product = product;
            var chips = bar.querySelectorAll('.rt-mw-storm-chip');
            for (var i = 0; i < chips.length; i++) {
                chips[i].classList.toggle('active',
                    chips[i].getAttribute('data-product') === product);
            }
            // Also reflect the change back into the side-panel chips so
            // the user's selection is consistent across both surfaces.
            _rtMwStormState.product = product;
            var sideBar = document.getElementById('rt-mw-storm-products');
            if (sideBar) {
                var sideChips = sideBar.querySelectorAll('.rt-mw-storm-chip');
                for (var j = 0; j < sideChips.length; j++) {
                    sideChips[j].classList.toggle('active',
                        sideChips[j].getAttribute('data-product') === product);
                }
                _rtRenderStormMwPasses();
            }
            _rtRenderMwCompare();
        });
    }
    _rtBindMwCompareModal();

    /**
     * Select and render a specific ASCAT pass.
     */
    window._rtSelectAscatPass = function (idx) {
        idx = parseInt(idx);
        if (!_rtAscatPasses || !_rtAscatPasses.passes || isNaN(idx)) return;

        var pass = _rtAscatPasses.passes[idx];
        if (!pass) return;

        var dataUrl = pass.opendap_url || pass.download_url;
        if (!dataUrl) {
            console.warn('[RT ASCAT] No data URL for pass', pass);
            return;
        }

        // Skip if already showing this pass
        if (dataUrl === _rtAscatActiveUrl && _rtAscatLayers.length > 0) return;

        _rtClearAscatLayers();

        var statusEl = document.getElementById('rt-ascat-status');
        if (statusEl) statusEl.textContent = 'Loading winds...';

        var lat = _rtAscatPasses.storm_lat;
        var lon = _rtAscatPasses.storm_lon;

        fetch(API_BASE + '/ascat/winds?data_url=' + encodeURIComponent(dataUrl) +
              '&center_lat=' + lat + '&center_lon=' + lon + '&radius_deg=8', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                _rtAscatActiveUrl = dataUrl;

                if (!json.winds || json.winds.length === 0) {
                    if (statusEl) statusEl.textContent = 'No wind data in region';
                    return;
                }

                if (statusEl) statusEl.textContent = json.count + ' obs \u00B7 ' + pass.satellite;

                _rtRenderAscatWinds(json.winds);
            })
            .catch(function (err) {
                console.warn('[RT ASCAT] Failed to load winds:', err);
                if (statusEl) statusEl.textContent = 'Error loading winds';
            });
    };

    /**
     * Render ASCAT wind barbs as Leaflet divIcon markers.
     */
    function _rtRenderAscatWinds(winds) {
        _rtClearAscatLayers();

        for (var i = 0; i < winds.length; i++) {
            var w = winds[i];
            if (w.speed_kt < 2.5) continue;  // calm — skip

            var svg = _buildWindBarbSVG(w.speed_kt, w.dir_deg);
            var icon = L.divIcon({
                className: 'ascat-barb-icon',
                html: svg,
                iconSize: [30, 30],
                iconAnchor: [15, 15],
            });

            var marker = L.marker([w.lat, w.lon], {
                icon: icon,
                pane: 'ascatPane',
                interactive: true,
            });
            marker.bindTooltip(
                Math.round(w.speed_kt) + ' kt from ' + Math.round(w.dir_deg) + '\u00B0',
                { direction: 'top', offset: [0, -12], className: 'ascat-tooltip' }
            );
            marker.addTo(detailMap);
            _rtAscatLayers.push(marker);
        }
    }

    /**
     * Remove all ASCAT barb markers from the map.
     */
    function _rtClearAscatLayers() {
        for (var i = 0; i < _rtAscatLayers.length; i++) {
            if (detailMap) try { detailMap.removeLayer(_rtAscatLayers[i]); } catch (e) {}
        }
        _rtAscatLayers = [];
    }

    /**
     * Full ASCAT overlay cleanup (called when switching/closing storms).
     */
    function _rtRemoveAscatOverlay() {
        _rtClearAscatLayers();
        _rtAscatPasses = null;
        _rtAscatLastAtcf = null;
        _rtAscatActiveUrl = null;
        _rtAscatVisible = false;
        var btn = document.getElementById('rt-ascat-toggle-btn');
        if (btn) btn.textContent = 'ASCAT';
        var controls = document.getElementById('rt-ascat-controls');
        if (controls) controls.style.display = 'none';
        var section = document.getElementById('rt-ascat-section');
        if (section) section.style.display = 'none';
    }

    // ═══════════════════════════════════════════════════════════════
    // ── 88D NEXRAD RADAR OVERLAY ─────────────────────────────────
    // ═══════════════════════════════════════════════════════════════

    /** Haversine distance in km between two lat/lon points. */
    function _rtHaversineKm(lat1, lon1, lat2, lon2) {
        var R = 6371;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLon = (lon2 - lon1) * Math.PI / 180;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * Estimated beam center height (km ARL) using 4/3 effective Earth radius.
     */
    function _rtBeamHeightKm(distKm, tiltDeg) {
        var Re = 6371 * 4 / 3;
        var r = distKm;
        var theta = tiltDeg * Math.PI / 180;
        return Math.sqrt(r * r + Re * Re + 2 * r * Re * Math.sin(theta)) - Re;
    }

    /** Parse "YYYY-MM-DD HH:MM:SS UTC" to epoch ms */
    function _rtParseScanTime(s) {
        if (!s) return 0;
        return new Date(s.replace(' UTC', 'Z').replace(' ', 'T')).getTime();
    }

    /**
     * Search for nearby NEXRAD sites for the current storm.
     * Called from _triggerDeferredLoads() after IR frames load.
     */
    function _rtLoadRadarSites(storm) {
        var section = document.getElementById('rt-radar-section');
        var statusEl = document.getElementById('rt-radar-status');
        var siteSelect = document.getElementById('rt-radar-site-select');
        var atcfId = storm.atcf_id;
        if (!atcfId || !siteSelect) {
            if (section) section.style.display = 'none';
            return;
        }

        if (atcfId === _rtRadarLastAtcf) {
            if (section) section.style.display = '';
            return;
        }
        _rtRadarLastAtcf = atcfId;

        var lat = storm.lat;
        var lon = storm.lon;
        if (!lat || !lon) {
            if (section) section.style.display = 'none';
            return;
        }

        if (statusEl) statusEl.textContent = 'Searching...';
        if (section) section.style.display = '';
        siteSelect.innerHTML = '<option value="">Searching...</option>';

        fetch(API_BASE + '/nexrad/sites?lat=' + lat + '&lon=' + lon + '&max_range_km=500', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                siteSelect.innerHTML = '';
                if (!json.sites || json.sites.length === 0) {
                    siteSelect.innerHTML = '<option value="">No nearby radars</option>';
                    if (statusEl) statusEl.textContent = 'No 88D coverage';
                    return;
                }
                for (var i = 0; i < json.sites.length; i++) {
                    var s = json.sites[i];
                    var opt = document.createElement('option');
                    opt.value = s.site;
                    opt.setAttribute('data-lat', s.lat);
                    opt.setAttribute('data-lon', s.lon);
                    opt.textContent = s.site + ' \u2014 ' + s.name + ' (' + s.distance_km + ' km)';
                    siteSelect.appendChild(opt);
                }
                if (json.sites.length > 0) {
                    _rtRadarSiteLat = json.sites[0].lat;
                    _rtRadarSiteLon = json.sites[0].lon;
                }
                if (statusEl) statusEl.textContent = json.sites.length + ' site(s)';

                if (_rtRadarVisible) window._rtLoadRadarScans();
            })
            .catch(function (e) {
                siteSelect.innerHTML = '<option value="">Error</option>';
                if (statusEl) statusEl.textContent = 'Error: ' + e.message;
            });
    }

    /**
     * Load ALL scans for the selected site across the full 6h window.
     * Populates dropdown and kicks off key-frame pre-fetch.
     */
    window._rtLoadRadarScans = function () {
        var siteSelect = document.getElementById('rt-radar-site-select');
        var scanSelect = document.getElementById('rt-radar-scan-select');
        var status = document.getElementById('rt-radar-frame-status');
        if (!siteSelect || !scanSelect || !siteSelect.value) return;

        var site = siteSelect.value;

        // Update stored site position
        var selOpt = siteSelect.options[siteSelect.selectedIndex];
        if (selOpt && selOpt.getAttribute('data-lat')) {
            _rtRadarSiteLat = parseFloat(selOpt.getAttribute('data-lat'));
            _rtRadarSiteLon = parseFloat(selOpt.getAttribute('data-lon'));
        }

        // Use middle of animation window as reference
        var midIdx = Math.floor(animFrameTimes.length / 2);
        var refTime = (animFrameTimes && animFrameTimes.length > 0)
            ? (animFrameTimes[midIdx] || animFrameTimes[animIndex]) : null;
        if (!refTime) { if (status) status.textContent = 'No frame time'; return; }

        scanSelect.innerHTML = '<option value="">Loading...</option>';
        if (status) status.textContent = 'Searching 6h window...';

        fetch(API_BASE + '/nexrad/scans?site=' + encodeURIComponent(site) + '&datetime=' + encodeURIComponent(refTime) + '&window_min=360', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                _rtRadarAllScans = (json.scans || []).slice();
                _rtRadarAllScans.sort(function (a, b) {
                    return _rtParseScanTime(a.scan_time) - _rtParseScanTime(b.scan_time);
                });

                scanSelect.innerHTML = '';
                if (_rtRadarAllScans.length === 0) {
                    scanSelect.innerHTML = '<option value="">No scans</option>';
                    if (status) status.textContent = 'No scans in 6h window';
                    return;
                }
                for (var i = 0; i < _rtRadarAllScans.length; i++) {
                    var sc = _rtRadarAllScans[i];
                    var opt = document.createElement('option');
                    opt.value = sc.s3_key;
                    opt.textContent = sc.scan_time;
                    scanSelect.appendChild(opt);
                }
                if (status) status.textContent = _rtRadarAllScans.length + ' scans over 6h';

                _rtSyncRadarToFrame();
                _rtPrefetchKeyFrames();
            })
            .catch(function (e) {
                scanSelect.innerHTML = '<option value="">Error</option>';
                if (status) status.textContent = 'Error: ' + e.message;
            });
    };

    /**
     * Find the scan closest to the current IR frame time and display it.
     */
    function _rtSyncRadarToFrame() {
        if (_rtRadarAllScans.length === 0) return;
        var refTime = (animFrameTimes && animFrameTimes.length > 0 && animIndex >= 0)
            ? animFrameTimes[animIndex] : null;
        if (!refTime) return;

        var irTime = new Date(refTime).getTime();
        var bestIdx = 0, bestDelta = Infinity;
        for (var i = 0; i < _rtRadarAllScans.length; i++) {
            var d = Math.abs(_rtParseScanTime(_rtRadarAllScans[i].scan_time) - irTime);
            if (d < bestDelta) { bestDelta = d; bestIdx = i; }
        }

        var bestScan = _rtRadarAllScans[bestIdx];
        var scanSelect = document.getElementById('rt-radar-scan-select');
        if (scanSelect && bestIdx < scanSelect.options.length) {
            scanSelect.selectedIndex = bestIdx;
        }

        var cacheKey = bestScan.s3_key + ':' + _rtRadarProduct;
        var cached = _rtRadarFrameCache[cacheKey];
        if (cached) {
            _rtApplyRadarFrame(cached);
            return;
        }
        _rtFetchRadarFrame(bestScan.s3_key, true);
    }

    /**
     * Apply a cached radar frame to the Leaflet map.
     */
    function _rtApplyRadarFrame(frame) {
        _rtRadarData = frame.data;
        _rtRadarRows = frame.rows;
        _rtRadarCols = frame.cols;
        _rtRadarVmin = frame.vmin;
        _rtRadarVmax = frame.vmax;
        _rtRadarUnits = frame.units;
        _rtRadarTilt = frame.tilt || 0.5;

        var bounds = L.latLngBounds(
            L.latLng(frame.bounds[0][0], frame.bounds[0][1]),
            L.latLng(frame.bounds[1][0], frame.bounds[1][1])
        );
        _rtRadarBounds = bounds;

        if (_rtRadarMapOverlay && detailMap) detailMap.removeLayer(_rtRadarMapOverlay);
        _rtRadarMapOverlay = L.imageOverlay(frame.image, bounds, {
            opacity: 0.75, interactive: false, pane: 'radarPane'
        });
        if (_rtRadarVisible && detailMap) _rtRadarMapOverlay.addTo(detailMap);

        var status = document.getElementById('rt-radar-frame-status');
        if (status) status.textContent = frame.statusText || '';
    }

    /**
     * Fetch a single radar frame and cache it.
     */
    function _rtFetchRadarFrame(s3Key, display) {
        var siteSelect = document.getElementById('rt-radar-site-select');
        if (!siteSelect || !siteSelect.value) return;
        var site = siteSelect.value;
        var product = _rtRadarProduct;
        var status = document.getElementById('rt-radar-frame-status');

        if (display && status) status.textContent = 'Loading...';

        var url = API_BASE + '/nexrad/frame?site=' + encodeURIComponent(site) +
            '&s3_key=' + encodeURIComponent(s3Key) +
            '&product=' + product;

        fetch(url, { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                if (!json.image || !json.bounds) return;

                var hoverData = null;
                if (json.data) {
                    var raw = atob(json.data);
                    hoverData = new Uint8Array(raw.length);
                    for (var i = 0; i < raw.length; i++) hoverData[i] = raw.charCodeAt(i);
                }

                var entry = {
                    image: json.image,
                    bounds: json.bounds,
                    data: hoverData,
                    rows: json.data_rows,
                    cols: json.data_cols,
                    vmin: json.data_vmin,
                    vmax: json.data_vmax,
                    units: json.units || 'dBZ',
                    tilt: json.tilt || 0.5,
                    s3Key: s3Key,
                    statusText: json.site + ' ' + json.scan_time + ' \u2014 ' + json.label + ' (tilt ' + json.tilt + '\u00B0)'
                };
                _rtRadarFrameCache[s3Key + ':' + product] = entry;

                _rtUpdatePrefetchStatus();

                if (display) {
                    _rtApplyRadarFrame(entry);
                    _rtUpdateRadarColorbar(product);
                }
            })
            .catch(function (e) {
                if (display && status) status.textContent = 'Error: ' + e.message;
            });
    }

    /**
     * Load a specific scan from the dropdown (user manual selection).
     */
    window._rtLoadRadarFrame = function () {
        var scanSelect = document.getElementById('rt-radar-scan-select');
        if (!scanSelect || !scanSelect.value) return;

        var prodSelect = document.getElementById('rt-radar-product-select');
        _rtRadarProduct = (prodSelect && prodSelect.value) || 'reflectivity';

        var s3Key = scanSelect.value;
        var cacheKey = s3Key + ':' + _rtRadarProduct;
        var cached = _rtRadarFrameCache[cacheKey];
        if (cached) {
            _rtApplyRadarFrame(cached);
            _rtUpdateRadarColorbar(_rtRadarProduct);
            return;
        }
        _rtFetchRadarFrame(s3Key, true);
    };

    /**
     * Pre-fetch ~8 key frames evenly spaced across the scan list.
     */
    function _rtPrefetchKeyFrames() {
        if (_rtRadarAllScans.length === 0 || _rtRadarPrefetching) return;
        _rtRadarPrefetching = true;

        var total = _rtRadarAllScans.length;
        var maxKeys = 8;
        var step = Math.max(1, Math.floor(total / maxKeys));
        var keyIndices = [];
        for (var i = 0; i < total; i += step) keyIndices.push(i);
        if (keyIndices[keyIndices.length - 1] !== total - 1) keyIndices.push(total - 1);

        var CONCURRENCY = 2;
        var nextSlot = 0;

        function fetchNext() {
            if (nextSlot >= keyIndices.length) {
                _rtRadarPrefetching = false;
                _rtUpdatePrefetchStatus();
                return;
            }
            var idx = keyIndices[nextSlot++];
            var scan = _rtRadarAllScans[idx];
            var cacheKey = scan.s3_key + ':' + _rtRadarProduct;
            if (_rtRadarFrameCache[cacheKey]) { fetchNext(); return; }
            _rtFetchRadarFrame(scan.s3_key, false);
            setTimeout(fetchNext, 500);
        }

        for (var c = 0; c < Math.min(CONCURRENCY, keyIndices.length); c++) fetchNext();
    }

    /**
     * Update prefetch progress in status text.
     */
    function _rtUpdatePrefetchStatus() {
        var statusEl = document.getElementById('rt-radar-status');
        if (!statusEl) return;
        var cached = 0;
        for (var k in _rtRadarFrameCache) {
            if (_rtRadarFrameCache.hasOwnProperty(k)) cached++;
        }
        var total = _rtRadarAllScans.length;
        if (_rtRadarPrefetching) {
            statusEl.textContent = 'Caching ' + cached + '/' + total;
        } else if (cached > 0) {
            statusEl.textContent = cached + ' cached';
        }
    }

    /**
     * Toggle the 88D radar overlay on/off.
     */
    window._rtToggleRadarOverlay = function () {
        var btn = document.getElementById('rt-radar-toggle-btn');
        var controls = document.getElementById('rt-radar-controls');

        if (_rtRadarVisible) {
            _rtRadarVisible = false;
            if (btn) btn.textContent = '88D';
            if (controls) controls.style.display = 'none';
            if (_rtRadarMapOverlay && detailMap) detailMap.removeLayer(_rtRadarMapOverlay);
            return;
        }

        _rtRadarVisible = true;
        if (btn) btn.textContent = 'Hide 88D';
        if (controls) controls.style.display = '';
        _ga('ir_radar_toggle', { visible: true });

        if (_rtRadarMapOverlay && detailMap) _rtRadarMapOverlay.addTo(detailMap);

        var siteSelect = document.getElementById('rt-radar-site-select');
        if (siteSelect && siteSelect.value) {
            if (_rtRadarAllScans.length > 0) {
                _rtSyncRadarToFrame();
            } else {
                window._rtLoadRadarScans();
            }
        }
    };

    /**
     * Sync radar to nearest cached scan on frame change (throttled).
     * Called from showFrame().
     */
    function _rtUpdateRadarForFrame() {
        if (!_rtRadarVisible || _rtRadarAllScans.length === 0) return;
        if (_rtRadarUpdateTimer) clearTimeout(_rtRadarUpdateTimer);
        _rtRadarUpdateTimer = setTimeout(function () {
            _rtSyncRadarToFrame();
        }, 150);
    }

    /**
     * Handle hover readout for NEXRAD radar data on the RT monitor.
     * Returns { value, units } or null.
     */
    function _rtHandleRadarMouseMove(e) {
        if (!_rtRadarVisible || !_rtRadarData || !_rtRadarBounds || !detailMap) return null;

        var lat = e.latlng.lat;
        var lng = e.latlng.lng;
        var b = _rtRadarBounds;

        if (lat < b.getSouth() || lat > b.getNorth() ||
            lng < b.getWest() || lng > b.getEast()) {
            return null;
        }

        function _latToMercY(d) {
            var r = d * Math.PI / 180;
            return Math.log(Math.tan(Math.PI / 4 + r / 2));
        }
        var mercNorth = _latToMercY(b.getNorth());
        var mercSouth = _latToMercY(b.getSouth());
        var mercLat   = _latToMercY(lat);
        var fracY = (mercNorth - mercLat) / (mercNorth - mercSouth);
        var fracX = (lng - b.getWest()) / (b.getEast() - b.getWest());
        var row = Math.min(Math.floor(fracY * _rtRadarRows), _rtRadarRows - 1);
        var col = Math.min(Math.floor(fracX * _rtRadarCols), _rtRadarCols - 1);

        var rawVal = _rtRadarData[row * _rtRadarCols + col];
        if (rawVal === 0) return null;

        var val = _rtRadarVmin + (rawVal - 1) * (_rtRadarVmax - _rtRadarVmin) / 254.0;

        // Compute beam height
        var beamStr = '';
        if (_rtRadarSiteLat != null && _rtRadarSiteLon != null) {
            var distKm = _rtHaversineKm(_rtRadarSiteLat, _rtRadarSiteLon, lat, lng);
            var beamHt = _rtBeamHeightKm(distKm, _rtRadarTilt);
            if (beamHt < 1) {
                beamStr = ' ' + (beamHt * 1000).toFixed(0) + 'm ARL';
            } else {
                beamStr = ' ' + beamHt.toFixed(1) + 'km ARL';
            }
        }
        return { value: val.toFixed(1), units: _rtRadarUnits, beam: beamStr };
    }

    /**
     * Update the 88D colorbar in the RT radar controls.
     */
    function _rtUpdateRadarColorbar(product) {
        var el = document.getElementById('rt-radar-colorbar');
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
                    '<span>-100 m/s</span><span>0</span><span>+100 m/s</span>' +
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
     * Full radar overlay cleanup (called when switching/closing storms).
     */
    function _rtRemoveRadarOverlay() {
        if (_rtRadarMapOverlay && detailMap) {
            detailMap.removeLayer(_rtRadarMapOverlay);
            _rtRadarMapOverlay = null;
        }
        _rtRadarData = null;
        _rtRadarBounds = null;
        _rtRadarVisible = false;
        _rtRadarLastAtcf = null;
        _rtRadarAllScans = [];
        _rtRadarFrameCache = {};
        _rtRadarPrefetching = false;
        if (_rtRadarUpdateTimer) { clearTimeout(_rtRadarUpdateTimer); _rtRadarUpdateTimer = null; }
        var btn = document.getElementById('rt-radar-toggle-btn');
        if (btn) btn.textContent = '88D';
        var controls = document.getElementById('rt-radar-controls');
        if (controls) controls.style.display = 'none';
        var section = document.getElementById('rt-radar-section');
        if (section) section.style.display = 'none';
        var siteSelect = document.getElementById('rt-radar-site-select');
        if (siteSelect) siteSelect.innerHTML = '';
        var scanSelect = document.getElementById('rt-radar-scan-select');
        if (scanSelect) scanSelect.innerHTML = '';
    }

    /**
     * Remove all model overlay state (called when switching/closing storms).
     */
    function _rtRemoveModelOverlay() {
        _rtClearModelLayers();
        _rtClearModelIntensityTraces();
        _rtRemoveWeatherlab();
        _rtRemoveDmEnsemble();
        _rtModelData = null;
        _rtModelActiveCycle = null;
        _rtModelLastAtcf = null;
        _rtModelVisible = false;
        var btn = document.getElementById('rt-models-toggle-btn');
        if (btn) btn.textContent = 'Models';
        var controls = document.getElementById('rt-model-controls');
        if (controls) controls.style.display = 'none';
        var section = document.getElementById('rt-models-section');
        if (section) section.style.display = 'none';
    }

    function init() {
        initMap();
        bindEvents();

        // Initial poll
        pollActiveStorms();

        // Set up recurring poll
        pollTimer = setInterval(pollActiveStorms, POLL_INTERVAL_MS);

        // Fetch season summary (initial + recurring every 30 min)
        fetchSeasonSummary();
        seasonSummaryTimer = setInterval(fetchSeasonSummary, SEASON_SUMMARY_INTERVAL_MS);

        // Pause background polling when the tab is hidden; catch up on return.
        var _pollHiddenAt = 0;
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                if (pollTimer || seasonSummaryTimer) _pollHiddenAt = Date.now();
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                if (seasonSummaryTimer) { clearInterval(seasonSummaryTimer); seasonSummaryTimer = null; }
            } else {
                var awayMs = _pollHiddenAt ? Date.now() - _pollHiddenAt : 0;
                _pollHiddenAt = 0;
                if (awayMs > POLL_INTERVAL_MS / 2) pollActiveStorms();
                if (!pollTimer) pollTimer = setInterval(pollActiveStorms, POLL_INTERVAL_MS);
                if (!seasonSummaryTimer) seasonSummaryTimer = setInterval(fetchSeasonSummary, SEASON_SUMMARY_INTERVAL_MS);
            }
        });

        // Clean up timers on page unload to prevent memory leaks
        window.addEventListener('beforeunload', function () {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (globalAnimTimer) { cancelAnimationFrame(globalAnimTimer); globalAnimTimer = null; }
            if (animTimer) { cancelAnimationFrame(animTimer); animTimer = null; }
            if (seasonSummaryTimer) { clearInterval(seasonSummaryTimer); seasonSummaryTimer = null; }
        });

        // Default the Cyclogenesis disturbance layer to ON at page
        // load. The whole point of the layer is to surface potential
        // developing systems even in quiet periods — making the user
        // dig into the Layers menu to find it hides the value. They
        // can still toggle it off via the menu if they want a clean
        // satellite-only view. Auto-disable the legacy WeatherLab
        // 50-member spaghetti pair if the user hasn't expressed a
        // preference (kept opt-in to avoid two competing layers).
        _rtGenesisVisible = true;
        _loadGenesis();
        if (typeof _refreshLayersCount === 'function') _refreshLayersCount();

        _ga('ir_page_load');
        console.log('[RT Monitor] Initialized — polling every', POLL_INTERVAL_MS / 1000, 'seconds');
    }

    // ═══════════════════════════════════════════════════════════
    //  KML EXPORT
    // ═══════════════════════════════════════════════════════════

    var KML_COLORS = {
        'TD':   'ffff8800',
        'TS':   'ff00cc00',
        'Cat1': 'ff00aaff',
        'Cat2': 'ff0066ff',
        'Cat3': 'ff0000ff',
        'Cat4': 'ff0000cc',
        'Cat5': 'ff0000aa',
    };

    function _escXml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    window.downloadActiveStormKML = function () {
        if (!currentStormId) return;
        _ga('ir_export_kml', { storm: currentStormId });

        // Find the storm object
        var storm = null;
        for (var i = 0; i < stormData.length; i++) {
            if (stormData[i].atcf_id === currentStormId) {
                storm = stormData[i];
                break;
            }
        }
        if (!storm) return;

        // Fetch metadata to get the full track history
        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(currentStormId) + '/metadata';
        fetch(url, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (meta) {
                if (!meta || !meta.intensity_history || meta.intensity_history.length === 0) {
                    alert('No track data available for export');
                    return;
                }

                var history = meta.intensity_history;
                var name = storm.name || 'UNNAMED';
                var placemarks = '';

                // Track line
                var coords = [];
                for (var i = 0; i < history.length; i++) {
                    coords.push(history[i].lon + ',' + history[i].lat + ',0');
                }
                placemarks += '<Placemark>\n' +
                    '  <name>' + _escXml(name) + ' Track</name>\n' +
                    '  <Style><LineStyle><color>ffffffff</color><width>2</width></LineStyle></Style>\n' +
                    '  <LineString><coordinates>' + coords.join(' ') + '</coordinates></LineString>\n' +
                    '</Placemark>\n';

                // Fix placemarks
                for (var j = 0; j < history.length; j++) {
                    var p = history[j];
                    var cat = windToCategory(p.vmax_kt);
                    var color = KML_COLORS[cat] || 'ffffffff';
                    var desc = '';
                    if (p.vmax_kt != null) desc += 'Wind: ' + p.vmax_kt + ' kt\\n';
                    if (p.mslp_hpa != null) desc += 'Pressure: ' + p.mslp_hpa + ' hPa\\n';
                    desc += 'Category: ' + cat;

                    placemarks += '<Placemark>\n' +
                        '  <name>' + _escXml(p.time || '') + '</name>\n' +
                        '  <description>' + _escXml(desc) + '</description>\n' +
                        '  <Style><IconStyle><color>' + color + '</color><scale>0.5</scale>' +
                        '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon>' +
                        '</IconStyle></Style>\n' +
                        '  <Point><coordinates>' + p.lon + ',' + p.lat + ',0</coordinates></Point>\n' +
                        '</Placemark>\n';
                }

                var kml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
                    '<Document>\n' +
                    '  <name>' + _escXml(name + ' ' + currentStormId) + '</name>\n' +
                    '  <description>Track exported from TC-ATLAS (https://michaelfischerwx.github.io/TC-ATLAS/)</description>\n' +
                    placemarks +
                    '</Document>\n' +
                    '</kml>';

                var blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = name.replace(/\s+/g, '_') + '_' + currentStormId + '.kml';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(a.href);
            })
            .catch(function (err) {
                console.warn('[RT Monitor] KML export failed:', err.message || '');
                alert('KML export failed — could not fetch track data');
            });
    };

    // ── Open in Satellite Viewer ──────────────────────────────
    window.openSatelliteViewerForStorm = function () {
        if (!currentStormId) return;
        _ga('ir_open_satellite_viewer', { storm: currentStormId });
        // The URL hash already has the storm ID (set by openStormDetail),
        // and the satellite viewer reads it on activation.
        if (window.switchIRView) window.switchIRView('satellite');
    };

    // Boot on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
