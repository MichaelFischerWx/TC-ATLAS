/* ═══════════════════════════════════════════════════════════════
   Real-Time IR Monitor — realtime_ir.js
   Self-contained IIFE for the Real-Time IR Monitor page.
   Provides: global map with active TC markers, click-through
   to storm detail with IR animation + intensity timeline.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Config ──────────────────────────────────────────────────
    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    var DEFAULT_LOOKBACK_HOURS = 6;
    var DEFAULT_RADIUS_DEG = 3.0;

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
        fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_coastline.geojson')
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
    var SAT_ZONES = [
        { name: 'GOES-East', sublon: -75.2,  coreWest: -110, coreEast:   15 },
        { name: 'GOES-West', sublon: -137.2, coreWest: -180, coreEast: -110 },
        { name: 'Himawari',  sublon:  140.7, coreWest:   60, coreEast:  180 }
    ];
    var BLEND_WIDTH_DEG = 5; // narrow cross-fade to avoid blurry dual-source artifacts

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
    var gibsVisLayers = [];          // GIBS GeoColor tile layers on main map
    var latestGIBSTime = null;       // cached latest GIBS time string (oldest satellite — used for animation)
    var latestGIBSTimes = {};         // per-satellite latest times, e.g. {'GOES-East': '...', 'Himawari': '...'}

    // Global map animation state
    var GLOBAL_ANIM_LOOKBACK_H = 4;  // 4-hour lookback for global animation
    var GLOBAL_ANIM_STEP_MIN = 30;   // 30-min steps
    var globalAnimFrameTimes = [];    // ISO time strings
    var globalAnimFrameLayers = [];   // parallel composite L.GridLayer (one per frame, opacity 0 until shown)
    var globalAnimIndex = 0;
    var globalAnimPlaying = false;
    var globalAnimTimer = null;
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
    var animTimer = null;
    var framesLoaded = 0;      // how many frames have finished loading tiles
    var framesReady = false;   // true once all frames loaded
    var validFrames = [];      // indices of frames that loaded actual tile data
    var frameHasError = [];    // parallel to animFrameLayers — true if frame had tile errors

    // Product mode: 'eir' (Enhanced IR), 'geocolor', or 'vigor'
    var productMode = 'eir';

    // GeoColor overlay state
    var geocolorFrameLayers = [];   // parallel array of L.tileLayer for GeoColor frames
    var geocolorFrameTimes = [];    // ISO time strings for GeoColor frames
    var geocolorFramesLoaded = 0;
    var geocolorFramesReady = false;
    var geocolorValidFrames = [];
    var geocolorFrameHasError = [];

    // IR Vigor overlay state
    var vigorMode = false;          // true when vigor product is active
    var vigorLayer = null;          // L.GridLayer for client-side vigor tiles
    var vigorCache = {};            // keyed by atcf_id → computed vigor data
    var vigorFetching = false;      // true while vigor computation is running

    // ── GIBS Clean IR Colormap Reverse LUT ───────────────────
    // GIBS Band 13 "Clean Infrared" uses an enhanced colormap:
    //   warm (330K) → black/dark gray → mid gray → light gray (248K)
    //   → cyan → blue → green → yellow → orange → red → pink → white (163K)
    // The forward stops below were derived empirically from GIBS tile
    // pixel data and calibrated against known meteorological Tb ranges.
    // The reverse LUT maps any RGB → approximate Tb via nearest-colour.
    var GIBS_TB_MIN = 163.0;        // K — coldest (white)
    var GIBS_TB_MAX = 330.0;        // K — warmest (black)

    // Forward colormap stops: [Tb_kelvin, R, G, B]
    var GIBS_CMAP_STOPS = [
        [330,   0,   0,   0],     // black (warmest)
        [320,  18,  18,  18],
        [310,  40,  40,  40],
        [300,  68,  68,  68],     // dark gray (warm ocean surface)
        [290, 100, 100, 100],     // mid gray (typical SST)
        [280, 133, 133, 133],
        [270, 165, 165, 165],
        [260, 195, 195, 195],
        [250, 218, 218, 218],     // light gray
        [245,   0, 210, 240],     // light cyan (gray→colour transition)
        [240,   0, 180, 220],     // cyan
        [235,   0, 140, 200],     // cyan-blue
        [230,   0, 100, 175],     // blue
        [225,   0,  60, 150],     // dark blue
        [220,   0,  25, 125],     // very dark blue
        [215,   0, 100,  30],     // dark green (blue→green transition)
        [210,   0, 200,  40],     // green
        [205,  60, 240,   0],     // yellow-green
        [200, 180, 255,   0],     // yellow
        [195, 255, 220,   0],     // golden yellow
        [190, 255, 160,   0],     // orange
        [185, 255,  80,   0],     // red-orange
        [180, 255,   0,   0],     // red
        [175, 200,   0, 120],     // dark magenta
        [170, 255, 150, 255],     // pink
        [163, 255, 255, 255]      // white (coldest)
    ];

    // Build 512-entry forward table (Tb → RGB) by interpolating stops
    var GIBS_FWD_LUT_SIZE = 512;
    var GIBS_FWD_LUT = (function () {
        var n = GIBS_FWD_LUT_SIZE;
        var lut = new Uint8Array(n * 3); // [R,G,B, R,G,B, ...]
        var tbArr = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            // Map index to Tb: 0 → GIBS_TB_MAX (warm), n-1 → GIBS_TB_MIN (cold)
            var tb = GIBS_TB_MAX - (i / (n - 1)) * (GIBS_TB_MAX - GIBS_TB_MIN);
            tbArr[i] = tb;
            // Find surrounding stops (stops are sorted warm→cold, descending Tb)
            var lo = GIBS_CMAP_STOPS[0], hi = GIBS_CMAP_STOPS[GIBS_CMAP_STOPS.length - 1];
            for (var s = 0; s < GIBS_CMAP_STOPS.length - 1; s++) {
                if (tb <= GIBS_CMAP_STOPS[s][0] && tb >= GIBS_CMAP_STOPS[s + 1][0]) {
                    lo = GIBS_CMAP_STOPS[s];
                    hi = GIBS_CMAP_STOPS[s + 1];
                    break;
                }
            }
            var t = (lo[0] === hi[0]) ? 0 : (lo[0] - tb) / (lo[0] - hi[0]);
            lut[i * 3]     = Math.round(lo[1] + t * (hi[1] - lo[1]));
            lut[i * 3 + 1] = Math.round(lo[2] + t * (hi[2] - lo[2]));
            lut[i * 3 + 2] = Math.round(lo[3] + t * (hi[3] - lo[3]));
        }
        return { rgb: lut, tb: tbArr };
    })();

    // Build 3D reverse lookup table (quantised RGB → forward LUT index → Tb)
    // Quantise to 32 levels per channel → 32³ = 32768 entries
    var GIBS_REV_Q = 32;
    var GIBS_REV_SHIFT = 3; // 256 / 32 = 8, log2(8) = 3
    var GIBS_REV_LUT = (function () {
        var q = GIBS_REV_Q;
        var table = new Uint16Array(q * q * q); // stores forward LUT index (0..511)
        var fwd = GIBS_FWD_LUT.rgb;
        var n = GIBS_FWD_LUT_SIZE;

        for (var ri = 0; ri < q; ri++) {
            var rc = ri * 8 + 4; // centre of quantisation bin
            for (var gi = 0; gi < q; gi++) {
                var gc = gi * 8 + 4;
                for (var bi = 0; bi < q; bi++) {
                    var bc = bi * 8 + 4;
                    var bestDist = Infinity, bestIdx = 0;
                    for (var j = 0; j < n; j++) {
                        var dr = rc - fwd[j * 3];
                        var dg = gc - fwd[j * 3 + 1];
                        var db = bc - fwd[j * 3 + 2];
                        var d = dr * dr + dg * dg + db * db;
                        if (d < bestDist) { bestDist = d; bestIdx = j; }
                    }
                    table[(ri * q + gi) * q + bi] = bestIdx;
                }
            }
        }
        return table;
    })();

    // Vigor rendering range (K)
    var VIGOR_VMIN = -10.0;         // strong deepening convection
    var VIGOR_VMAX =  80.0;         // clear sky well above local min

    // Vigor colormap stops (matches backend _VIGOR_STOPS)
    var VIGOR_STOPS = [
        [0.00,  10,  10,  30],
        [0.10,  20,  40, 120],
        [0.20,  40,  80, 180],
        [0.30,  80, 140, 220],
        [0.40, 160, 200, 240],
        [0.50, 230, 230, 230],
        [0.60, 255, 255, 150],
        [0.70, 255, 220,  50],
        [0.80, 255, 140,   0],
        [0.90, 230,  50,   0],
        [1.00, 200,   0, 150]
    ];

    // Pre-built 256-entry vigor RGBA LUT
    var VIGOR_LUT = (function () {
        var lut = new Uint8Array(256 * 4);
        for (var i = 0; i < 256; i++) {
            var frac = i / 255.0;
            var lo = VIGOR_STOPS[0], hi = VIGOR_STOPS[VIGOR_STOPS.length - 1];
            for (var s = 0; s < VIGOR_STOPS.length - 1; s++) {
                if (VIGOR_STOPS[s][0] <= frac && frac <= VIGOR_STOPS[s + 1][0]) {
                    lo = VIGOR_STOPS[s];
                    hi = VIGOR_STOPS[s + 1];
                    break;
                }
            }
            var t = (hi[0] === lo[0]) ? 0 : (frac - lo[0]) / (hi[0] - lo[0]);
            lut[i * 4]     = Math.round(lo[1] + t * (hi[1] - lo[1]));
            lut[i * 4 + 1] = Math.round(lo[2] + t * (hi[2] - lo[2]));
            lut[i * 4 + 2] = Math.round(lo[3] + t * (hi[3] - lo[3]));
            lut[i * 4 + 3] = 255;
        }
        return lut;
    })();

    // Spatial min filter radius in degrees (~200 km at equator)
    var VIGOR_RADIUS_DEG = 1.8;

    // Cold-cloud Tb threshold for vigor display (only show vigor where
    // current Tb < this value, i.e. convective cloud tops only)
    var VIGOR_TB_THRESHOLD = 253.15;  // -20°C in Kelvin

    // ── Helpers ─────────────────────────────────────────────────

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

        var bestSat = null;
        var bestScore = -Infinity;

        for (var i = 0; i < SAT_ZONES.length; i++) {
            var sat = SAT_ZONES[i];
            var hasGeoColor = !!GIBS_GEOCOLOR_LAYERS[sat.name];
            var layerName = GIBS_GEOCOLOR_LAYERS[sat.name] || GIBS_VIS_LAYERS[sat.name];
            if (!layerName) continue;

            var score;
            if (centerLon >= sat.coreWest && centerLon <= sat.coreEast) {
                score = 1.0;
            } else {
                var distW = sat.coreWest - centerLon;
                var distE = centerLon - sat.coreEast;
                score = -Math.min(Math.abs(distW), Math.abs(distE));
            }

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
            var best = SAT_SUBLONS[0], bestDist = 999;
            for (var j = 0; j < SAT_SUBLONS.length; j++) {
                var d = Math.abs(centerLon - SAT_SUBLONS[j].sublon);
                if (d > 180) d = 360 - d;
                if (d < bestDist) { bestDist = d; best = SAT_SUBLONS[j]; }
            }
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

        // Score each satellite by how close the tile center is to the core zone
        var bestSat = null;
        var bestScore = -Infinity;

        for (var i = 0; i < SAT_ZONES.length; i++) {
            var sat = SAT_ZONES[i];
            var layerName = GIBS_IR_LAYERS[sat.name];
            if (!layerName) continue;

            // Score = 1.0 if inside core, ramps down with distance outside core
            var score;
            if (centerLon >= sat.coreWest && centerLon <= sat.coreEast) {
                // Inside core — score based on distance to nearest edge (prefer center)
                score = 1.0;
            } else {
                // Outside core — negative distance (further = worse)
                var distW = sat.coreWest - centerLon;
                var distE = centerLon - sat.coreEast;
                score = -Math.min(Math.abs(distW), Math.abs(distE));
            }

            if (score > bestScore) {
                bestScore = score;
                bestSat = { name: sat.name, layerName: layerName, weight: 1.0 };
            }
        }

        // Fallback to nearest sub-satellite point if nothing scored well
        if (!bestSat) {
            var best = SAT_SUBLONS[0], bestDist = 999;
            for (var j = 0; j < SAT_SUBLONS.length; j++) {
                var d = Math.abs(centerLon - SAT_SUBLONS[j].sublon);
                if (d > 180) d = 360 - d;
                if (d < bestDist) { bestDist = d; best = SAT_SUBLONS[j]; }
            }
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
        var offsets = [15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
        // Representative tiles for each satellite (z3 tiles within each footprint)
        var satellites = [
            { name: 'GOES-East', layer: GIBS_IR_LAYERS['GOES-East'], suffix: '/GoogleMapsCompatible_Level6/3/3/2.png' },
            { name: 'GOES-West', layer: GIBS_IR_LAYERS['GOES-West'], suffix: '/GoogleMapsCompatible_Level6/3/3/0.png' },
            { name: 'Himawari',  layer: GIBS_IR_LAYERS['Himawari'],  suffix: '/GoogleMapsCompatible_Level6/3/3/6.png' }
        ];

        function findTimeForSat(sat) {
            function tryOffset(idx) {
                if (idx >= offsets.length) {
                    // All failed — fall back to 90 min ago
                    var fb = roundToGIBSInterval(new Date());
                    fb = new Date(fb.getTime() - 90 * 60 * 1000);
                    return Promise.resolve(toGIBSTime(fb));
                }
                var dt = roundToGIBSInterval(new Date());
                dt = new Date(dt.getTime() - offsets[idx] * 60 * 1000);
                var ts = toGIBSTime(dt);
                var url = GIBS_BASE + '/' + sat.layer + '/default/' + ts + sat.suffix;
                return fetch(url).then(function (r) {
                    if (r.ok) return ts;
                    return tryOffset(idx + 1);
                }).catch(function (err) {
                    console.warn('[IR Monitor] GIBS probe failed for', sat.layer, 'offset', offsets[idx], err.message || '');
                    return tryOffset(idx + 1);
                });
            }
            return tryOffset(0);
        }

        return Promise.all(satellites.map(function (sat) {
            return findTimeForSat(sat).then(function (ts) {
                return { name: sat.name, time: ts };
            });
        })).then(function (results) {
            var perSat = {};
            var oldestMs = Infinity;
            for (var i = 0; i < results.length; i++) {
                perSat[results[i].name] = results[i].time;
                var ms = new Date(results[i].time).getTime();
                if (ms < oldestMs) oldestMs = ms;
            }
            var oldest = toGIBSTime(new Date(oldestMs));
            return { perSat: perSat, oldest: oldest };
        });
    }

    /** Legacy wrapper — returns the oldest satellite time (for animation compatibility) */
    function findLatestGIBSTime() {
        return findLatestGIBSTimes().then(function (result) {
            latestGIBSTimes = result.perSat;
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
            var lyr = createCompositeGIBSLayer(result.oldest, opacity || 0.65, result.perSat);
            lyr.addTo(targetMap);
            gibsIRLayers = [lyr];
            console.log('GIBS per-satellite times:', JSON.stringify(result.perSat),
                        '| oldest (animation):', result.oldest);
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
        var lyr = createCompositeGIBSLayer(timeStr, opacity || 0.7);
        lyr.addTo(targetMap);
        return [lyr];
    }

    /** Toggle the global map between IR and GeoColor */
    function setGlobalProduct(mode) {
        if (mode === globalProduct) return;
        globalProduct = mode;

        // Update toggle button
        var toggleBtn = document.getElementById('ir-global-product-toggle');
        if (toggleBtn) {
            toggleBtn.textContent = (mode === 'geocolor') ? 'Switch to IR' : 'Switch to GeoColor';
            toggleBtn.title = (mode === 'geocolor')
                ? 'Currently showing GeoColor — click to switch to Enhanced IR'
                : 'Currently showing Enhanced IR — click to switch to GeoColor';
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
            var irLyr = createCompositeGIBSLayer(timeStr, 0.65, perSat);
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
        globalAnimFrameLayers[idx].setOpacity(globalProduct === 'geocolor' ? 0.75 : 0.65);

        // Update time display
        var timeEl = document.getElementById('ir-global-anim-time');
        if (timeEl && globalAnimFrameTimes[idx]) {
            timeEl.textContent = fmtUTC(globalAnimFrameTimes[idx]);
        }

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

    /** Start global animation loop */
    function startGlobalAnimation() {
        if (!globalAnimReady) {
            // Start loading if not yet loaded
            loadGlobalAnimation();
            return;
        }
        globalAnimPlaying = true;
        updateGlobalAnimControls('playing');
        var ms = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].ms;
        globalAnimTimer = setInterval(function () {
            nextGlobalFrame();
        }, ms);
    }

    /** Cycle to the next animation speed and restart if playing */
    function cycleGlobalAnimSpeed() {
        globalAnimSpeedIdx = (globalAnimSpeedIdx + 1) % GLOBAL_ANIM_SPEEDS.length;
        var speedBtn = document.getElementById('ir-global-anim-speed');
        if (speedBtn) speedBtn.textContent = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].label;
        // Restart timer with new speed if playing
        if (globalAnimPlaying && globalAnimTimer) {
            clearInterval(globalAnimTimer);
            var ms = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].ms;
            globalAnimTimer = setInterval(function () {
                nextGlobalFrame();
            }, ms);
        }
    }

    /** Stop global animation loop */
    function stopGlobalAnimation() {
        globalAnimPlaying = false;
        if (globalAnimTimer) clearInterval(globalAnimTimer);
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

    /** Update the global animation control panel state.
     *  States: 'idle', 'loading', 'ready', 'playing' */
    function updateGlobalAnimControls(state, pct) {
        var panel = document.getElementById('ir-global-anim-panel');
        if (!panel) return;

        var playBtn = document.getElementById('ir-global-anim-play');
        var timeEl = document.getElementById('ir-global-anim-time');
        var statusEl = document.getElementById('ir-global-anim-status');

        if (state === 'idle') {
            if (playBtn) { playBtn.innerHTML = '&#9654;'; playBtn.title = 'Load & play global animation'; }
            if (timeEl) timeEl.textContent = '';
            if (statusEl) statusEl.textContent = '';
        } else if (state === 'loading') {
            if (playBtn) { playBtn.innerHTML = '&#8987;'; playBtn.title = 'Loading frames\u2026'; playBtn.disabled = true; }
            if (statusEl) statusEl.textContent = (pct != null ? pct + '%' : 'Loading\u2026');
        } else if (state === 'ready') {
            if (playBtn) { playBtn.innerHTML = '&#9654;'; playBtn.title = 'Play'; playBtn.disabled = false; }
            if (statusEl) statusEl.textContent = (globalAnimIndex + 1) + '/' + globalAnimFrameLayers.length;
        } else if (state === 'playing') {
            if (playBtn) { playBtn.innerHTML = '&#9646;&#9646;'; playBtn.title = 'Pause'; playBtn.disabled = false; }
            if (statusEl) statusEl.textContent = '';
        }
    }

    /** Build an array of GIBS time strings for animation (lookback_hours, every 30 min) */
    function buildFrameTimes(centerDt, lookbackHours) {
        var times = [];
        var end = roundToGIBSInterval(centerDt);
        // Reduced from 40 min to 15 min: findLatestGIBSTimes already probes actual
        // availability, so the extra margin only needs to cover the 10-min GIBS
        // rounding interval plus a small buffer.  Per-tile retry (loadImageWithRetry)
        // handles any remaining gaps by falling back 10/20/30 min automatically.
        end = new Date(end.getTime() - 15 * 60 * 1000);
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
        var basemap = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
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

        // Labels on top of IR
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | IR: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
            subdomains: 'abcd',
            maxZoom: 19,
            pane: 'overlayPane'
        }).addTo(map);

        map.zoomControl.setPosition('topleft');

        // Allow zoom 7 (GeoColor tiles go up to Level7)
        map.setMaxZoom(GIBS_VIS_MAX_ZOOM);

        // Add IR/GeoColor toggle control (bottom-right of map)
        var ProductToggle = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                var btn = L.DomUtil.create('button', 'ir-global-toggle-btn');
                btn.id = 'ir-global-product-toggle';
                btn.textContent = 'Switch to GeoColor';
                btn.title = 'Currently showing Enhanced IR — click to switch to GeoColor';
                btn.style.cssText = 'padding:6px 14px;font-family:DM Sans,sans-serif;font-size:0.72rem;font-weight:500;color:#8b9ec2;background:rgba(15,33,64,0.88);border:1px solid rgba(255,255,255,0.12);border-radius:5px;cursor:pointer;white-space:nowrap;backdrop-filter:blur(4px);';
                L.DomEvent.disableClickPropagation(btn);
                btn.addEventListener('click', function () {
                    setGlobalProduct(globalProduct === 'eir' ? 'geocolor' : 'eir');
                });
                btn.addEventListener('mouseenter', function () {
                    btn.style.background = 'rgba(30,60,110,0.9)';
                    btn.style.color = '#c0d0ea';
                });
                btn.addEventListener('mouseleave', function () {
                    btn.style.background = 'rgba(15,33,64,0.88)';
                    btn.style.color = '#8b9ec2';
                });
                return btn;
            }
        });
        map.addControl(new ProductToggle());

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

        // Add global animation control panel (bottom-right, above status bar)
        var AnimPanel = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                var container = L.DomUtil.create('div', 'ir-global-anim-panel');
                container.id = 'ir-global-anim-panel';
                container.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 10px;font-family:DM Sans,sans-serif;font-size:0.72rem;color:#8b9ec2;background:rgba(15,33,64,0.88);border:1px solid rgba(255,255,255,0.12);border-radius:5px;backdrop-filter:blur(4px);margin-bottom:36px;';
                L.DomEvent.disableClickPropagation(container);

                // Prev button
                var prevBtn = L.DomUtil.create('button', '', container);
                prevBtn.innerHTML = '&#9664;';
                prevBtn.title = 'Previous frame';
                prevBtn.style.cssText = 'background:none;border:none;color:#8b9ec2;cursor:pointer;font-size:0.7rem;padding:2px 4px;';
                prevBtn.addEventListener('click', function () {
                    stopGlobalAnimation();
                    prevGlobalFrame();
                });

                // Play/Pause button
                var playBtn = L.DomUtil.create('button', '', container);
                playBtn.id = 'ir-global-anim-play';
                playBtn.innerHTML = '&#9654;';
                playBtn.title = 'Load & play global animation';
                playBtn.style.cssText = 'background:none;border:none;color:#60a5fa;cursor:pointer;font-size:0.85rem;padding:2px 6px;';
                playBtn.addEventListener('click', toggleGlobalAnimation);

                // Next button
                var nextBtn = L.DomUtil.create('button', '', container);
                nextBtn.innerHTML = '&#9654;';
                nextBtn.title = 'Next frame';
                nextBtn.style.cssText = 'background:none;border:none;color:#8b9ec2;cursor:pointer;font-size:0.7rem;padding:2px 4px;';
                nextBtn.addEventListener('click', function () {
                    stopGlobalAnimation();
                    nextGlobalFrame();
                });

                // Time display
                var timeSpan = L.DomUtil.create('span', '', container);
                timeSpan.id = 'ir-global-anim-time';
                timeSpan.style.cssText = 'color:#e2e8f0;font-weight:500;font-size:0.68rem;letter-spacing:0.03em;min-width:90px;';

                // Speed toggle button
                var speedBtn = L.DomUtil.create('button', '', container);
                speedBtn.id = 'ir-global-anim-speed';
                speedBtn.textContent = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].label;
                speedBtn.title = 'Cycle animation speed';
                speedBtn.style.cssText = 'background:rgba(96,165,250,0.15);border:1px solid rgba(96,165,250,0.3);color:#60a5fa;cursor:pointer;font-size:0.6rem;font-weight:600;padding:1px 6px;border-radius:3px;font-family:JetBrains Mono,monospace;';
                speedBtn.addEventListener('click', cycleGlobalAnimSpeed);

                // Status display
                var statusSpan = L.DomUtil.create('span', '', container);
                statusSpan.id = 'ir-global-anim-status';
                statusSpan.style.cssText = 'color:#64748b;font-size:0.65rem;';

                // Stop/reset button
                var stopBtn = L.DomUtil.create('button', '', container);
                stopBtn.innerHTML = '&#9632;';
                stopBtn.title = 'Stop animation and return to latest';
                stopBtn.style.cssText = 'background:none;border:none;color:#8b9ec2;cursor:pointer;font-size:0.65rem;padding:2px 4px;';
                stopBtn.addEventListener('click', function () {
                    if (globalAnimFrameLayers.length === 0) return;
                    cleanupGlobalAnimation();
                    // Restore static single-frame layer (with per-satellite times for IR)
                    if (latestGIBSTime) {
                        if (globalProduct === 'geocolor') {
                            var visLyr = createCompositeGIBSLayerVis(latestGIBSTime, 0.75);
                            visLyr.addTo(map);
                            gibsVisLayers = [visLyr];
                        } else {
                            var perSat = (Object.keys(latestGIBSTimes).length > 0) ? latestGIBSTimes : null;
                            var irLyr = createCompositeGIBSLayer(latestGIBSTime, 0.65, perSat);
                            irLyr.addTo(map);
                            gibsIRLayers = [irLyr];
                        }
                    }
                });

                return container;
            }
        });
        map.addControl(new AnimPanel());
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

        fetch(url)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (meta) {
                if (!meta || !meta.intensity_history || meta.intensity_history.length < 2) return;
                drawTrackOnMap(map, meta.intensity_history, storm, trackLayers);
            })
            .catch(function (err) { console.warn('[IR Monitor] Track fetch failed:', err.message || ''); });
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
            var cosLat = Math.cos((curr.lat + prev.lat) * 0.5 * Math.PI / 180);
            var dist = Math.sqrt(dlat * dlat + (dlon * cosLat) * (dlon * cosLat));
            if (dist > 8) continue;  // >8° (~900 km) in one fix interval = invest recycling

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

    /** Poll /ir-monitor/active-storms */
    function pollActiveStorms() {
        var loaderEl = document.getElementById('ir-loader');
        var noStormsEl = document.getElementById('ir-no-storms');

        fetch(API_BASE + '/ir-monitor/active-storms')
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                stormData = data.storms || [];

                // Hide loader
                if (loaderEl) loaderEl.style.display = 'none';

                // Update UI
                updateStats(data);
                renderStormMarkers(stormData);
                fetchAllTracks(stormData);

                // Show/hide no-storms message
                if (noStormsEl) {
                    noStormsEl.style.display = stormData.length === 0 ? 'block' : 'none';
                }

                // Handle deep link on first load
                handleDeepLink();

                _ga('ir_poll_success', { storm_count: stormData.length });
            })
            .catch(function (err) {
                console.warn('[IR Monitor] Poll failed:', err.message);

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

    /** Called when a single frame layer finishes loading its tiles */
    function onFrameLayerLoaded(frameIdx) {
        framesLoaded++;
        var total = animFrameTimes.length;
        var pct = Math.round((framesLoaded / total) * 100);
        showLoadingProgress(true, pct);

        // Track this frame as valid if it didn't have tile errors
        if (!frameHasError[frameIdx]) {
            validFrames.push(frameIdx);
            validFrames.sort(function (a, b) { return a - b; });
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
            console.log('[IR Monitor] All ' + total + ' IR frames pre-loaded (' + detailSatName + '), ' + validFrames.length + ' valid');
        }
    }

    /** Initialize the GIBS-based detail mini-map for a storm with PRE-LOADED frames */
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
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19
        }).addTo(detailMap);

        // Store storm position for solar elevation calculations (GeoColor day/night)
        detailStormLat = storm.lat;
        detailStormLon = storm.lon;

        // Pick the single best satellite for this storm's longitude
        detailSatName = bestSatelliteForLon(storm.lon);
        var satLayerName = GIBS_IR_LAYERS[detailSatName];

        // Build animation frame times (30-min steps, 6h lookback)
        var lastFix = storm.last_fix_utc ? new Date(storm.last_fix_utc) : new Date();
        animFrameTimes = buildFrameTimes(lastFix, DEFAULT_LOOKBACK_HOURS);
        animIndex = animFrameTimes.length - 1;
        framesLoaded = 0;
        framesReady = false;

        // Disable play button until frames load
        var playBtn = document.getElementById('ir-anim-play');
        if (playBtn) playBtn.disabled = true;

        // Show loading progress
        showLoadingProgress(true, 0);

        // Pre-create ALL frame tile layers (hidden at opacity 0)
        animFrameLayers = [];
        validFrames = [];
        frameHasError = [];
        for (var i = 0; i < animFrameTimes.length; i++) {
            var timeStr = animFrameTimes[i];
            var lyr = createGIBSLayer(satLayerName, timeStr, 0); // opacity 0 = hidden
            lyr.addTo(detailMap);
            frameHasError.push(false);

            // Listen for tile load completion AND tile errors
            (function (layer, idx) {
                layer.on('tileerror', function () {
                    frameHasError[idx] = true;
                });
                layer.on('load', function () {
                    onFrameLayerLoaded(idx);
                });
            })(lyr, i);

            animFrameLayers.push(lyr);
        }

        // Coastline overlay — Natural Earth 50m black outlines (matches global archive)
        detailMap.createPane('coastlinePane');
        detailMap.getPane('coastlinePane').style.zIndex = 450;
        detailMap.getPane('coastlinePane').style.pointerEvents = 'none';
        _loadCoastlineOverlay(detailMap);

        // Labels on top (in overlay pane so above IR tiles)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
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

        // Update animation controls
        var slider = document.getElementById('ir-anim-slider');
        slider.max = animFrameTimes.length - 1;
        slider.value = animIndex;
        updateAnimCounter();
        updateFrameOverlay();

        // Show IR Tb colorbar legend (vigor legend stays hidden until toggled)
        var tbLeg = document.getElementById('ir-tb-legend');
        if (tbLeg) tbLeg.style.display = 'block';

        // Force map resize after layout settles
        setTimeout(function () { detailMap.invalidateSize(); }, 100);

        // Safety timeout: if tiles haven't all loaded within 30s, start anyway
        setTimeout(function () {
            if (!framesReady && animFrameLayers.length > 0) {
                console.warn('[IR Monitor] Frame preload timeout — enabling animation with ' + framesLoaded + '/' + animFrameTimes.length + ' frames (' + validFrames.length + ' valid)');
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

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                callback(null, data);
            })
            .catch(function (err) {
                console.warn('[IR Monitor] Metadata fetch failed:', err.message);
                callback(err);
            });
    }

    // ═══════════════════════════════════════════════════════════
    //  STORM DETAIL VIEW
    // ═══════════════════════════════════════════════════════════

    /** Open the storm detail view */
    function openStormDetail(atcfId) {
        currentStormId = atcfId;

        // Stop global animation if running (frames stay in memory for return)
        stopGlobalAnimation();

        // Reset product state for new storm
        productMode = 'eir';
        vigorMode = false;
        vigorFetching = false;
        removeVigorLayer();
        cleanupGeocolorFrameLayers();
        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        var vigBtn = document.getElementById('ir-product-vigor');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
        if (geoBtn) { geoBtn.classList.remove('ir-product-active'); geoBtn.classList.remove('ir-vigor-loading'); geoBtn.textContent = 'GeoColor'; }
        if (vigBtn) { vigBtn.classList.remove('ir-product-active'); vigBtn.classList.remove('ir-vigor-loading'); vigBtn.textContent = 'IR Vigor'; }
        var vigorLegend = document.getElementById('ir-vigor-legend');
        if (vigorLegend) vigorLegend.style.display = 'none';

        // Find storm in current data
        var storm = null;
        for (var i = 0; i < stormData.length; i++) {
            if (stormData[i].atcf_id === atcfId) {
                storm = stormData[i];
                break;
            }
        }

        if (!storm) {
            console.warn('[IR Monitor] Storm not found:', atcfId);
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

        // Initialize GIBS-based IR mini-map
        stopAnimation();
        animFrameTimes = [];
        animIndex = 0;
        initDetailMap(storm);

        // Fetch metadata for intensity chart
        fetchStormMetadata(atcfId, function (err, meta) {
            if (!err && meta) {
                renderIntensityChart(meta);

                // Recon cross-reference
                if (meta.has_recon) {
                    document.getElementById('ir-recon-section').style.display = 'block';
                    document.getElementById('ir-recon-info').innerHTML =
                        '<span style="color:#34d399;">\u25CF Active reconnaissance</span><br>' +
                        '<a href="explorer.html?tab=realtime">\u2192 Open in Real-Time TDR</a>';
                } else {
                    document.getElementById('ir-recon-section').style.display = 'none';
                }
            }
        });

        _ga('ir_open_detail', { atcf_id: atcfId, name: storm.name, category: cat });
    }

    /** Close the detail view and return to the map */
    function closeStormDetail() {
        currentStormId = null;
        stopAnimation();

        // Reset product state
        removeVigorLayer();
        cleanupGeocolorFrameLayers();
        productMode = 'eir';
        vigorMode = false;
        vigorFetching = false;
        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        var vigBtn = document.getElementById('ir-product-vigor');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
        if (geoBtn) { geoBtn.classList.remove('ir-product-active'); geoBtn.classList.remove('ir-vigor-loading'); geoBtn.textContent = 'GeoColor'; }
        if (vigBtn) { vigBtn.classList.remove('ir-product-active'); vigBtn.classList.remove('ir-vigor-loading'); vigBtn.textContent = 'IR Vigor'; }
        var vigorLegend = document.getElementById('ir-vigor-legend');
        if (vigorLegend) vigorLegend.style.display = 'none';
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
        document.getElementById('ir-legend').style.display = 'block';

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
        var timeStr = animFrameTimes[animIndex];
        document.getElementById('ir-frame-time').textContent = fmtUTC(timeStr);
        document.getElementById('ir-satellite-label').textContent = detailSatName || 'GIBS IR';
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
        var counter = document.getElementById('ir-anim-counter');
        var state = activeFrameState();
        var pos = activeValidFramePos();
        if (state.valid.length > 0 && pos >= 0) {
            counter.textContent = (pos + 1) + ' / ' + state.valid.length;
        } else {
            counter.textContent = (animIndex + 1) + ' / ' + state.times.length;
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
        if (productMode === 'vigor') return;
        var state = activeFrameState();
        if (!state.ready) return;
        if (state.valid.length === 0) return;
        var pos = activeValidFramePos();
        var nextPos = (pos + 1) % state.valid.length;
        state.showFn(state.valid[nextPos]);
        document.getElementById('ir-anim-slider').value = nextPos;
        updateAnimCounter();
    }

    /** Step to previous valid frame */
    function prevFrame() {
        if (productMode === 'vigor') return;
        var state = activeFrameState();
        if (!state.ready) return;
        if (state.valid.length === 0) return;
        var pos = activeValidFramePos();
        var prevPos = (pos - 1 + state.valid.length) % state.valid.length;
        state.showFn(state.valid[prevPos]);
        document.getElementById('ir-anim-slider').value = prevPos;
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

    /** Start animation loop */
    function startAnimation() {
        if (productMode === 'vigor') return;
        var state = activeFrameState();
        if (state.times.length < 2 || !state.ready) return;
        animPlaying = true;
        var btn = document.getElementById('ir-anim-play');
        btn.innerHTML = '&#9646;&#9646;'; // pause icon
        btn.title = 'Pause';

        // Faster frame rate since all tiles are pre-loaded (no network wait)
        animTimer = setInterval(function () {
            nextFrame();
        }, 500); // ~2 fps — smooth enough for convective evolution
    }

    /** Stop animation loop */
    function stopAnimation() {
        animPlaying = false;
        if (animTimer) clearInterval(animTimer);
        animTimer = null;
        var btn = document.getElementById('ir-anim-play');
        if (btn) {
            btn.innerHTML = '&#9654;'; // play icon
            btn.title = 'Play';
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  INTENSITY CHART (Plotly)
    // ═══════════════════════════════════════════════════════════

    /** Render the intensity timeline chart */
    function renderIntensityChart(meta) {
        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || typeof Plotly === 'undefined') return;

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
            line: { color: '#2e7dff', width: 2 },
            marker: { color: colors, size: 5 }
        };

        var layout = {
            margin: { t: 8, r: 10, b: 36, l: 42 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            xaxis: {
                gridcolor: 'rgba(255,255,255,0.04)',
                tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
                tickformat: '%m/%d %Hz'
            },
            yaxis: {
                title: { text: 'Vmax (kt)', font: { size: 10, color: '#8b9ec2' } },
                gridcolor: 'rgba(255,255,255,0.04)',
                tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' }
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
            responsive: true
        };

        Plotly.newPlot(chartEl, [trace], layout, config);
    }

    // ═══════════════════════════════════════════════════════════
    //  IR VIGOR PRODUCT
    // ═══════════════════════════════════════════════════════════

    /** Switch between product modes: 'eir', 'geocolor', 'vigor' */
    function setProductMode(mode) {
        var prevMode = productMode;
        productMode = mode;
        vigorMode = (mode === 'vigor');

        // Update toggle button active states
        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        var vigBtn = document.getElementById('ir-product-vigor');
        if (eirBtn) eirBtn.classList.toggle('ir-product-active', mode === 'eir');
        if (geoBtn) geoBtn.classList.toggle('ir-product-active', mode === 'geocolor');
        if (vigBtn) vigBtn.classList.toggle('ir-product-active', mode === 'vigor');

        // Show/hide legends
        var vigorLeg = document.getElementById('ir-vigor-legend');
        var tbLeg = document.getElementById('ir-tb-legend');
        if (vigorLeg) vigorLeg.style.display = (mode === 'vigor') ? 'block' : 'none';
        if (tbLeg) tbLeg.style.display = (mode === 'eir') ? 'block' : 'none';

        // --- Deactivate previous mode ---
        if (prevMode === 'eir') {
            hideAllAnimFrames();
            stopAnimation();
        } else if (prevMode === 'geocolor') {
            hideAllGeocolorFrames();
            stopAnimation();
        } else if (prevMode === 'vigor') {
            removeVigorLayer();
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
        } else if (mode === 'vigor') {
            hideAllAnimFrames();
            hideAllGeocolorFrames();
            stopAnimation();
            fetchAndShowVigor();
        }
    }

    /** Backward-compatible wrapper for vigor toggle */
    function setVigorMode(enabled) {
        setProductMode(enabled ? 'vigor' : 'eir');
    }

    /** Hide all IR animation frame layers */
    function hideAllAnimFrames() {
        for (var i = 0; i < animFrameLayers.length; i++) {
            animFrameLayers[i].setOpacity(0);
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

    /** Remove the vigor image overlay from the map */
    function removeVigorLayer() {
        if (vigorLayer && detailMap) {
            detailMap.removeLayer(vigorLayer);
            vigorLayer = null;
        }
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
            showVigorToast('No visible imagery available for ' + detailSatName);
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
            geoBtn.classList.add('ir-vigor-loading');
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
                console.warn('[IR Monitor] GeoColor preload timeout — enabling with ' + geocolorFramesLoaded + '/' + geocolorFrameTimes.length + ' frames');
                geocolorFramesReady = true;
                showLoadingProgress(false);
                if (geoBtn) {
                    geoBtn.classList.remove('ir-vigor-loading');
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
                geoBtn.classList.remove('ir-vigor-loading');
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
    }

    // ── Client-Side Vigor Computation Helpers ────────────────

    /** Convert GIBS Clean IR pixel → approximate Tb (Kelvin).
     *  Uses the pre-computed 3D reverse LUT for O(1) nearest-colour lookup.
     *  Handles both the grayscale (warm) and enhanced-colour (cold) regions. */
    function gibsPixelToTb(r, g, b) {
        var ri = r >> GIBS_REV_SHIFT;
        var gi = g >> GIBS_REV_SHIFT;
        var bi = b >> GIBS_REV_SHIFT;
        var idx = GIBS_REV_LUT[(ri * GIBS_REV_Q + gi) * GIBS_REV_Q + bi];
        return GIBS_FWD_LUT.tb[idx];
    }

    /** Read pixel data from all visible tiles in a GridLayer.
     *  Returns { tiles: { 'z:x:y': { tb: Float32Array, w, h, coords } }, tileKeys: [] } */
    function extractTbFromLayer(layer) {
        var tiles = layer._tiles;
        var result = {};
        var keys = [];
        if (!tiles) return { tiles: result, tileKeys: keys };
        for (var key in tiles) {
            if (!tiles.hasOwnProperty(key)) continue;
            var tile = tiles[key];
            if (!tile.el || !tile.current) continue;
            var canvas = tile.el;
            try {
                var ctx = canvas.getContext('2d');
                var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                var pixels = imgData.data;
                var n = canvas.width * canvas.height;
                var tb = new Float32Array(n);
                for (var i = 0; i < n; i++) {
                    var off = i * 4;
                    if (pixels[off + 3] < 128) {
                        tb[i] = NaN;
                    } else {
                        tb[i] = gibsPixelToTb(pixels[off], pixels[off + 1], pixels[off + 2]);
                    }
                }
                result[key] = { tb: tb, w: canvas.width, h: canvas.height, coords: tile.coords };
                keys.push(key);
            } catch (e) {
                // Cross-origin canvas or empty tile — skip
            }
        }
        return { tiles: result, tileKeys: keys };
    }

    /** Stitch tile Tb arrays into a single large 2D array.
     *  Returns { tb: Float32Array, w, h, bounds: {south,north,west,east}, tileW, tileH, grid } */
    function stitchTileTb(tileData) {
        var tiles = tileData.tiles;
        var keys = tileData.tileKeys;
        if (keys.length === 0) return null;

        // Find bounding tile coords
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        var zoom = 0, tileW = 256, tileH = 256;
        for (var i = 0; i < keys.length; i++) {
            var t = tiles[keys[i]];
            var c = t.coords;
            zoom = c.z;
            tileW = t.w;
            tileH = t.h;
            if (c.x < minX) minX = c.x;
            if (c.x > maxX) maxX = c.x;
            if (c.y < minY) minY = c.y;
            if (c.y > maxY) maxY = c.y;
        }

        var gridW = maxX - minX + 1;
        var gridH = maxY - minY + 1;
        var totalW = gridW * tileW;
        var totalH = gridH * tileH;
        var stitched = new Float32Array(totalW * totalH);
        stitched.fill(NaN);

        // Place each tile's data
        for (var i = 0; i < keys.length; i++) {
            var t = tiles[keys[i]];
            var c = t.coords;
            var ox = (c.x - minX) * tileW;
            var oy = (c.y - minY) * tileH;
            for (var row = 0; row < t.h; row++) {
                for (var col = 0; col < t.w; col++) {
                    stitched[(oy + row) * totalW + (ox + col)] = t.tb[row * t.w + col];
                }
            }
        }

        // Compute geographic bounds (Web Mercator tile → lat/lon)
        var n = Math.pow(2, zoom);
        var west = minX / n * 360 - 180;
        var east = (maxX + 1) / n * 360 - 180;
        // Y → lat via Mercator inverse
        var north = Math.atan(Math.sinh(Math.PI * (1 - 2 * minY / n))) * 180 / Math.PI;
        var south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (maxY + 1) / n))) * 180 / Math.PI;

        return {
            tb: stitched, w: totalW, h: totalH,
            bounds: { south: south, north: north, west: west, east: east },
            tileW: tileW, tileH: tileH,
            grid: { minX: minX, maxX: maxX, minY: minY, maxY: maxY, zoom: zoom }
        };
    }

    /** Compute pixel-wise temporal average across multiple stitched Tb frames.
     *  All frames must have the same dimensions. */
    function temporalAvgTb(stitchedFrames) {
        if (stitchedFrames.length === 0) return null;
        var ref = stitchedFrames[0];
        var n = ref.w * ref.h;
        var sum = new Float32Array(n);
        var cnt = new Uint8Array(n);

        for (var f = 0; f < stitchedFrames.length; f++) {
            var tb = stitchedFrames[f].tb;
            for (var i = 0; i < n; i++) {
                if (!isNaN(tb[i])) {
                    sum[i] += tb[i];
                    cnt[i]++;
                }
            }
        }
        var avg = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            avg[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
        }
        return { tb: avg, w: ref.w, h: ref.h, bounds: ref.bounds, grid: ref.grid, tileW: ref.tileW, tileH: ref.tileH };
    }

    /** Separable 2D spatial minimum filter.
     *  Operates on a flat Float32Array of size w×h with given pixel radius.
     *  NaN pixels are skipped; if an entire window is NaN the output is NaN. */
    function spatialMinFilter(tb, w, h, radius) {
        var n = w * h;
        var temp = new Float32Array(n);
        var out = new Float32Array(n);

        // Horizontal pass
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var minVal = Infinity;
                var x0 = Math.max(0, x - radius);
                var x1 = Math.min(w - 1, x + radius);
                for (var xx = x0; xx <= x1; xx++) {
                    var v = tb[y * w + xx];
                    if (!isNaN(v) && v < minVal) minVal = v;
                }
                temp[y * w + x] = (minVal === Infinity) ? NaN : minVal;
            }
        }

        // Vertical pass
        for (var x = 0; x < w; x++) {
            for (var y = 0; y < h; y++) {
                var minVal = Infinity;
                var y0 = Math.max(0, y - radius);
                var y1 = Math.min(h - 1, y + radius);
                for (var yy = y0; yy <= y1; yy++) {
                    var v = temp[yy * w + x];
                    if (!isNaN(v) && v < minVal) minVal = v;
                }
                out[y * w + x] = (minVal === Infinity) ? NaN : minVal;
            }
        }
        return out;
    }

    /** Map a vigor value (K) to RGBA using the pre-built LUT */
    function vigorToRGBA(vigor) {
        if (isNaN(vigor)) return [0, 0, 0, 0];
        var frac = (vigor - VIGOR_VMIN) / (VIGOR_VMAX - VIGOR_VMIN);
        frac = Math.max(0, Math.min(1, frac));
        var idx = Math.round(frac * 255);
        return [VIGOR_LUT[idx * 4], VIGOR_LUT[idx * 4 + 1], VIGOR_LUT[idx * 4 + 2], VIGOR_LUT[idx * 4 + 3]];
    }

    /** Compute client-side vigor from pre-loaded animation frame tile canvases.
     *  vigor = current_Tb − domain_min(temporal_avg_Tb)
     *
     *  The reference is the DOMAIN-WIDE minimum of the temporal-average Tb —
     *  a single scalar representing the coldest persistent convection in the
     *  entire storm system.  This means only the CDO core (where current Tb
     *  is colder than the coldest time-averaged point) can go negative.
     *  Most grid points will be positive (warmer than the CDO reference). */
    function computeClientVigor() {
        if (!detailMap || animFrameLayers.length === 0 || validFrames.length === 0) return null;

        console.time('[Vigor] total computation');

        // Use only the latest valid frame — no temporal averaging needed.
        // This avoids the storm-following problem: a fixed Eulerian grid
        // smears the CDO when computing temporal averages because the storm
        // translates through the domain over the lookback window.
        var latestIdx = validFrames[validFrames.length - 1];
        var layer = animFrameLayers[latestIdx];
        var tileData = extractTbFromLayer(layer);
        var stitched = stitchTileTb(tileData);
        if (!stitched) {
            console.warn('[Vigor] Could not extract Tb from latest frame');
            return null;
        }

        console.log('[Vigor] Stitched size:', stitched.w, '×', stitched.h);

        // 1. Collect all convective pixels (Tb < -20°C / 253.15 K)
        var coldPixels = [];
        for (var j = 0; j < stitched.tb.length; j++) {
            var t = stitched.tb[j];
            if (!isNaN(t) && t < VIGOR_TB_THRESHOLD) {
                coldPixels.push(t);
            }
        }

        if (coldPixels.length < 20) {
            console.warn('[Vigor] Too few cold pixels:', coldPixels.length);
            return null;
        }

        // 2. Find the 5th percentile of cold-pixel Tb (the coldest 5% of
        //    convective cloud tops).  This is the vigor reference — robust to
        //    single-pixel noise unlike an absolute minimum.
        coldPixels.sort(function (a, b) { return a - b; });
        var p05idx = Math.floor(coldPixels.length * 0.05);
        var p05 = coldPixels[p05idx];

        console.log('[Vigor] Cold pixels:', coldPixels.length,
                     '| P05 Tb:', p05.toFixed(1), 'K (' + (p05 - 273.15).toFixed(1) + '°C)',
                     '| Min Tb:', coldPixels[0].toFixed(1), 'K');

        // 3. Compute vigor: current_Tb − P05(cold_Tb)
        //    - Negative → colder than the 5th percentile (overshooting tops,
        //      vigorous convective cores)
        //    - Near zero → among the coldest sustained convection (CDO core)
        //    - Positive → warmer than the coldest convection (thinning anvil,
        //      outer rain bands, warming CDO)
        //    Warm pixels (Tb >= threshold) are masked out.
        var vigorArr = new Float32Array(stitched.w * stitched.h);
        for (var i = 0; i < vigorArr.length; i++) {
            var curTb = stitched.tb[i];
            if (isNaN(curTb) || curTb >= VIGOR_TB_THRESHOLD) {
                vigorArr[i] = NaN;
            } else {
                vigorArr[i] = curTb - p05;
            }
        }

        console.timeEnd('[Vigor] total computation');

        return {
            vigor: vigorArr,
            w: stitched.w,
            h: stitched.h,
            bounds: stitched.bounds,
            grid: stitched.grid,
            tileW: stitched.tileW,
            tileH: stitched.tileH,
            framesUsed: 1,
            datetime_utc: animFrameTimes[latestIdx]
        };
    }

    /** Compute vigor and display as tile overlay (called when vigor mode is activated) */
    function fetchAndShowVigor() {
        if (!currentStormId || !detailMap) return;

        // Check cache first
        if (vigorCache[currentStormId]) {
            showVigorOverlay(vigorCache[currentStormId]);
            return;
        }

        if (!framesReady || validFrames.length < 1) {
            showVigorToast('IR Vigor requires at least 1 loaded animation frame. Please wait for frames to load.');
            setVigorMode(false);
            return;
        }

        // Show loading state
        var vigBtn = document.getElementById('ir-product-vigor');
        if (vigBtn) {
            vigBtn.classList.add('ir-vigor-loading');
            vigBtn.textContent = 'Computing\u2026';
        }
        vigorFetching = true;

        // Run computation asynchronously (setTimeout to allow UI update)
        setTimeout(function () {
            try {
                var result = computeClientVigor();
                vigorFetching = false;

                if (vigBtn) {
                    vigBtn.classList.remove('ir-vigor-loading');
                    vigBtn.textContent = 'IR Vigor';
                }

                if (!result) {
                    showVigorToast('IR Vigor computation failed — not enough tile data available.');
                    setVigorMode(false);
                    return;
                }

                vigorCache[currentStormId] = result;

                if (vigorMode) {
                    showVigorOverlay(result);
                }

                _ga('ir_vigor_loaded', {
                    atcf_id: currentStormId,
                    frames_used: result.framesUsed
                });
            } catch (err) {
                console.warn('[IR Monitor] Vigor computation error:', err);
                vigorFetching = false;
                if (vigBtn) {
                    vigBtn.classList.remove('ir-vigor-loading');
                    vigBtn.textContent = 'IR Vigor';
                }
                showVigorToast('IR Vigor computation failed: ' + err.message);
                setVigorMode(false);
            }
        }, 50);
    }

    /** Show a temporary toast message */
    function showVigorToast(msg) {
        var toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(180,80,20,0.95);color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:10000;max-width:500px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
        document.body.appendChild(toast);
        setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 6000);
    }

    /** Render the computed vigor data as a canvas-based Leaflet ImageOverlay.
     *  The vigor array is painted into an offscreen canvas at full tile resolution,
     *  then displayed as an image overlay with proper geographic bounds.
     *  This scales naturally with zoom (Leaflet handles the CSS transform). */
    function showVigorOverlay(data) {
        removeVigorLayer();
        if (!detailMap || !data.vigor || !data.bounds) return;

        var vigorArr = data.vigor;
        var vw = data.w;
        var vh = data.h;
        var bnd = data.bounds;

        // Render vigor into an offscreen canvas at full computed resolution
        var canvas = document.createElement('canvas');
        canvas.width = vw;
        canvas.height = vh;
        var ctx = canvas.getContext('2d');
        var imgData = ctx.createImageData(vw, vh);
        var pix = imgData.data;

        for (var i = 0; i < vigorArr.length; i++) {
            var v = vigorArr[i];
            if (isNaN(v)) continue;

            var frac = (v - VIGOR_VMIN) / (VIGOR_VMAX - VIGOR_VMIN);
            frac = Math.max(0, Math.min(1, frac));
            var idx = Math.round(frac * 255);
            var off = i * 4;
            pix[off]     = VIGOR_LUT[idx * 4];
            pix[off + 1] = VIGOR_LUT[idx * 4 + 1];
            pix[off + 2] = VIGOR_LUT[idx * 4 + 2];
            pix[off + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);

        // Convert canvas to data URL and create image overlay
        var dataUrl = canvas.toDataURL('image/png');
        var bounds = L.latLngBounds(
            L.latLng(bnd.south, bnd.west),
            L.latLng(bnd.north, bnd.east)
        );

        vigorLayer = L.imageOverlay(dataUrl, bounds, { opacity: 0.92 });
        vigorLayer.addTo(detailMap);

        // Use crisp rendering so individual pixels stay sharp when zoomed
        var imgEl = vigorLayer.getElement();
        if (imgEl) {
            imgEl.style.imageRendering = 'pixelated';
            imgEl.style.imageRendering = '-moz-crisp-edges';
        }

        // Update the overlay info label
        var satLabel = document.getElementById('ir-satellite-label');
        if (satLabel) satLabel.textContent = 'IR Vigor (' + data.framesUsed + ' frames)';
        var timeLabel = document.getElementById('ir-frame-time');
        if (timeLabel) timeLabel.textContent = fmtUTC(data.datetime_utc);
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
        document.getElementById('ir-product-vigor').addEventListener('click', function () {
            if (productMode === 'vigor' || vigorFetching) return;
            setProductMode('vigor');
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
        fetch(API_BASE + '/ir-monitor/season-summary')
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                seasonSummaryData = data;
                renderBasinSidebar();
            })
            .catch(function (err) {
                console.warn('[IR Monitor] Season summary fetch failed:', err.message || '');
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

        // Clean up timers on page unload to prevent memory leaks
        window.addEventListener('beforeunload', function () {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (globalAnimTimer) { clearInterval(globalAnimTimer); globalAnimTimer = null; }
            if (animTimer) { clearInterval(animTimer); animTimer = null; }
            if (seasonSummaryTimer) { clearInterval(seasonSummaryTimer); seasonSummaryTimer = null; }
        });

        _ga('ir_page_load');
        console.log('[IR Monitor] Initialized — polling every', POLL_INTERVAL_MS / 1000, 'seconds');
    }

    // Boot on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
