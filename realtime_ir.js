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

    // ── Shared async-state helpers ──────────────────────────────
    // A bare fetch() never rejects on a stalled connection until the
    // browser's (very long) socket timeout, so a hung request leaves a
    // panel spinning forever. Wrap fetch with an AbortController timeout
    // so stalls surface as a normal rejection the caller can show as a
    // retry-able error. Default 20 s — generous for a Cloud Run cold
    // start, short enough that a truly dead request doesn't hang the UI.
    function _rtFetchJSON(url, opts, timeoutMs) {
        opts = opts || {};
        if (!('cache' in opts)) opts.cache = 'no-store';
        var ms = timeoutMs || 20000;
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        if (ctrl && !opts.signal) opts.signal = ctrl.signal;
        var timer = ctrl ? setTimeout(function () {
            try { ctrl.abort(); } catch (e) {}
        }, ms) : null;
        return fetch(url, opts)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .finally(function () { if (timer) clearTimeout(timer); });
    }

    // Render a compact, retry-able error into a panel status element.
    // Keeps the wording + affordance consistent across every panel so a
    // failed load is always distinguishable from an empty result, and is
    // always one click from a retry instead of a full page reload.
    function _rtStatusError(el, retryFn, label) {
        if (!el) return;
        el.innerHTML = '';
        var span = document.createElement('span');
        span.className = 'rt-status-error';
        span.textContent = (label || 'Couldn’t load') + ' · ';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rt-retry-link';
        btn.textContent = 'Retry';
        if (typeof retryFn === 'function') {
            btn.addEventListener('click', function () { retryFn(); });
        }
        span.appendChild(btn);
        el.appendChild(span);
    }

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

    // GIBS mid-level Water Vapor (Band 8, ~6.2 µm) — same TileMatrix/zoom
    // family as IR (Level6) since GIBS publishes WV at the same 2-km resolution.
    var GIBS_WV_LAYERS = {
        'GOES-East':  'GOES-East_ABI_Band8_Upper-Level_Water_Vapor',
        'GOES-West':  'GOES-West_ABI_Band8_Upper-Level_Water_Vapor',
        'Himawari':   'Himawari_AHI_Band8_Upper-Level_Water_Vapor'
    };

    /** detailSatName comes from two sources: bestSatelliteForLon() returns
     *  'Himawari'/'GOES-East'/'GOES-West', but bundle headers may stamp the
     *  specific spacecraft ('Himawari-9', 'GOES-19', etc). Collapse to the
     *  GIBS-family key so layer lookups stay consistent. */
    function normalizeSatFamily(name) {
        if (!name) return '';
        if (/^Himawari/i.test(name))  return 'Himawari';
        if (/^GOES-East/i.test(name)) return 'GOES-East';
        if (/^GOES-West/i.test(name)) return 'GOES-West';
        if (/^GOES-1[678]|^GOES-19/i.test(name)) return 'GOES-East';   // GOES-16/17 = East legacy
        return name;
    }

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
    // Active-storm name-label markers, keyed by uppercase ATCF id.
    // Persists across clearTracks() on purpose: drawTrackOnMap removes the
    // prior marker for a storm before adding a new one, so overlapping
    // poll/fetch races can't leave two name labels for the same system on
    // the map. Used by _syncStormLabelVisibility to hide the redundant
    // text when a genesis disturbance pin already carries the same name.
    var _stormNameLabels = {};

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
    // Run-to-run cycle trend. _genesisCycleList holds the recent published
    // DeepMind cycles (freshest first) from /weatherlab-genesis-cycles;
    // _genesisActiveCycle is the init_time the user has stepped back to
    // (null = follow the latest cycle, the default). The on-map stepper
    // reads both; _loadGenesis appends ?init_time when a past cycle is
    // pinned. Degrades gracefully: if the cycles endpoint isn't deployed
    // yet, the list stays empty and the stepper hides.
    var _genesisCycleList = [];
    var _genesisActiveCycle = null;
    // init_time of the cycle whose markers we last played the pop-in
    // entrance animation for. Keyed by init so the *first* render that
    // draws markers for a new cycle animates them (catching the user's
    // eye when they populate a few seconds — cold cache — or up to 30
    // min — new cycle on a long-open tab — after the page first loaded),
    // while routine re-renders (cluster swap, tuner tweaks) stay still.
    var _genesisAnimatedInit = null;
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
    var _GENESIS_ASSIGN_RADIUS_KM   = 1000;  // max distance member ↔ peak
    // Time-window for member-to-peak assignment. A member's first-
    // genesis tau must be within ±_GENESIS_TIME_WINDOW_H of the peak's
    // mean first-genesis tau (computed from members whose first-genesis
    // lat/lon falls inside the peak cell). Prevents merging two storms
    // that happen to form at the same location but at very different
    // times.
    var _GENESIS_TIME_WINDOW_H      = 60;
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

    // Product mode: 'eir' (IR), 'geocolor', 'vis', 'wv'
    var productMode = 'eir';

    // GeoColor overlay state
    var geocolorFrameLayers = [];   // parallel array of L.tileLayer for GeoColor frames
    var geocolorFrameTimes = [];    // ISO time strings for GeoColor frames
    var geocolorFramesLoaded = 0;
    var geocolorFramesReady = false;
    var geocolorValidFrames = [];
    var geocolorFrameHasError = [];

    // Visible (Red Band 2/3) overlay state — daytime only; nighttime
    // frames are skipped (filtered by solar elevation at load time).
    var visFrameLayers = [];
    var visFrameTimes = [];
    var visFramesLoaded = 0;
    var visFramesReady = false;
    var visValidFrames = [];
    var visFrameHasError = [];

    // Water Vapor (Band 8) overlay state
    var wvFrameLayers = [];
    var wvFrameTimes = [];
    var wvFramesLoaded = 0;
    var wvFramesReady = false;
    var wvValidFrames = [];
    var wvFrameHasError = [];

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

    /** Human "x ago" for a UTC ISO string, used to flag stale fixes. */
    function _fmtAgo(isoStr) {
        if (!isoStr) return '';
        var t = Date.parse(isoStr);
        if (!isFinite(t)) return '';
        var mins = Math.round((Date.now() - t) / 60000);
        if (mins < 0) return '';            // future / clock skew — say nothing
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + ' min ago';
        var hrs = mins / 60;
        if (hrs < 24) return (hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)) + ' h ago';
        return Math.round(hrs / 24) + ' d ago';
    }
    // A fix older than this is visually flagged so a forecaster doesn't
    // read a hours-old position as current. 6 h ≈ two missed synoptic
    // fixes for a weak/sparsely-tracked system.
    var _LASTFIX_STALE_MIN = 6 * 60;

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
     *  satellites are stale; hide when all are fresh.
     *
     *  Show the banner only the FIRST time a user encounters a given
     *  stale-sat set, then never auto-pop it again. We persist a "seen"
     *  record the moment it's displayed (not just on explicit dismiss),
     *  so a returning user — or one who simply ignores the notice — isn't
     *  pestered on every visit. GOES-West in particular goes stale often
     *  for the East Pac, and one parallax heads-up is enough. A genuinely
     *  NEW outage (a different sat, or a different combination) is a new
     *  key, so it still surfaces once. */
    var _BANNER_SEEN_KEY = 'tc-atlas:ir-feed-banner-seen';

    function _bannerSeenKeys() {
        try {
            var raw = localStorage.getItem(_BANNER_SEEN_KEY);
            var obj = raw ? JSON.parse(raw) : null;
            return (obj && typeof obj === 'object') ? obj : {};
        } catch (e) { return {}; }
    }

    function _markBannerSeen(key) {
        try {
            var seen = _bannerSeenKeys();
            if (!seen[key]) {
                seen[key] = Date.now();
                localStorage.setItem(_BANNER_SEEN_KEY, JSON.stringify(seen));
            }
        } catch (e) {}
    }

    function _updateFeedStalenessBanner(staleSats) {
        var el = document.getElementById('ir-feed-banner');
        var txt = document.getElementById('ir-feed-banner-text');
        if (!el || !txt) return;
        if (!staleSats || staleSats.length === 0) {
            el.style.display = 'none';
            return;
        }
        // Suppress if the user has already seen the banner for this exact
        // stale-sat set. First-time-only, by design.
        var key = staleSats.slice().sort().join('|');
        if (_bannerSeenKeys()[key]) {
            el.style.display = 'none';
            return;
        }
        var label = staleSats.join(' & ');
        var msg = label + ' feed delayed (NASA GIBS) — that region is being backfilled from the nearest available satellite (expect higher parallax) until the upstream ingest catches up.';
        txt.textContent = msg;
        el.style.display = 'flex';
        // Record the view immediately so it won't auto-pop again for this
        // set, whether or not the user clicks the close button.
        _markBannerSeen(key);
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

    // ── Lat/lon graticule (RT Global Map + Storm Card) ────────────
    // L.layerGroup holding all polylines + label divIcons. Rebuilt on
    // moveend/zoomend with adaptive spacing so meso zooms get a fine
    // 1° grid while world view gets a sparse 10° grid. Two instances —
    // one for the global map (_rtGraticule) and one for the storm card
    // detail map (_detailGraticule) — sharing the same builder.
    var _rtGraticule = null;
    var _detailGraticule = null;
    function _rtGraticuleStep(z) {
        if (z >= 7) return 1;
        if (z >= 5) return 2;
        if (z >= 3) return 5;
        return 10;
    }
    /** Build polylines + labels for the active graticule on `targetMap`.
     *  Stops drawing if the graticule has been cleaned up. */
    function _buildGraticuleFor(layerGroup, targetMap) {
        if (!layerGroup || !targetMap) return;
        layerGroup.clearLayers();
        var step = _rtGraticuleStep(targetMap.getZoom());
        var b = targetMap.getBounds();
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
                .addTo(layerGroup);
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
            }).addTo(layerGroup);
        }
        for (var lon = wLon; lon <= eLon; lon += step) {
            L.polyline([[sLat, lon], [nLat, lon]], lineOpts)
                .addTo(layerGroup);
            var labelLat = b.getSouth() + (b.getNorth() - b.getSouth()) * 0.015;
            L.marker([labelLat, lon], {
                icon: L.divIcon({
                    className: 'rt-graticule-label',
                    html: _rtFmtLon(lon),
                    iconSize: [50, 14], iconAnchor: [25, 14]
                }),
                interactive: false, keyboard: false
            }).addTo(layerGroup);
        }
    }
    function _rtRebuildGraticule() { _buildGraticuleFor(_rtGraticule, map); }
    function _detailRebuildGraticule() { _buildGraticuleFor(_detailGraticule, detailMap); }

    /** Add the lat/lon graticule to the storm card's detail map. Called
     *  from openStormDetail after detailMap exists; cleaned up by
     *  closeStormDetail along with the rest of detailMap. */
    function _detailEnableGraticule() {
        if (!detailMap || _detailGraticule) return;
        _detailGraticule = L.layerGroup().addTo(detailMap);
        _detailRebuildGraticule();
        detailMap.on('moveend zoomend', _detailRebuildGraticule);
    }
    function _detailDisableGraticule() {
        if (!detailMap) return;
        if (_detailGraticule) {
            detailMap.removeLayer(_detailGraticule);
            detailMap.off('moveend zoomend', _detailRebuildGraticule);
            _detailGraticule = null;
        }
    }
    window._irToggleDetailGrid = function () {
        if (!detailMap) return;
        var btn = document.getElementById('ir-detail-grid-toggle');
        if (_detailGraticule) {
            _detailDisableGraticule();
            if (btn) btn.classList.remove('active');
            _ga('rt_detail_graticule_toggle', { on: false });
        } else {
            _detailEnableGraticule();
            if (btn) btn.classList.add('active');
            _ga('rt_detail_graticule_toggle', { on: true });
        }
    };

    // ── Surface obs overlay (NDBC buoys; Synoptic Data is planned) ───
    // Toggled by the "Obs" button in the card header. Renders each
    // station as a conventional met station plot: wind barb at the
    // station marker, temperature upper-left, dewpoint lower-left,
    // pressure upper-right (last 3 digits, tenths of mb), filled
    // circle indicating sky cover (NDBC doesn't report sky so we
    // skip that for now). Hover tooltip shows the full obs.
    var _surfaceObsLayer = null;
    var _surfaceObsAbortController = null;

    // Global-map (viewport) surface-obs overlay — independent of the
    // storm-card overlay above. Live METAR (land) + NDBC (marine) plots
    // fetched for the current map bounds, zoom-gated + pixel-thinned.
    var _rtObsOn = false;            // toggle state
    var _rtObsLayer = null;          // L.layerGroup of station-plot markers
    var _rtObsAbort = null;          // in-flight fetch AbortController
    var _rtObsDebounce = null;       // moveend debounce timer
    var _rtObsLastKey = '';          // last fetched bbox key (skip redundant pulls)
    var _RT_OBS_MIN_ZOOM = 5;        // below this the world is too dense to plot

    function _kt(v) { return (v == null) ? null : Math.round(v); }
    function _cToF(c) { return (c == null) ? null : Math.round(c * 9/5 + 32); }

    /** Build wind-barb SVG fragments as a string. `dir` is the FROM
     *  direction (0°=N). `speed` in knots. `isSH` flips the feather side
     *  in the Southern Hemisphere. Mirrors the GFS canvas barbs in
     *  `_drawWindBarb`: same WMO convention (pennants→feathers→half from
     *  the upwind tail, observer's-LEFT feathers in NH / right in SH),
     *  same glyph proportions, and the same cream "print ink" over a dark
     *  knockout halo so the two barb styles read identically on the map.
     *  Returns the inner SVG markup; caller wraps in an <svg>. */
    function _windBarbSvgString(speed, dir, isSH) {
        if (speed == null || dir == null) return '';
        if (speed < 3) return '';  // calm — render nothing (matches GFS)

        var STAFF = 20, FEATHER = 8, FEATHER_H = 4, SPACING = 2.4, PEN_BASE = 3.5;

        // Shaft points UPWIND. In SVG coords (x right, y down) the FROM
        // direction is (sin dir, -cos dir).
        var dirRad = dir * Math.PI / 180;
        var sx = Math.sin(dirRad), sy = -Math.cos(dirRad);   // station→tip unit

        // Feathers on the observer's LEFT in NH, right in SH — matches
        // _drawWindBarb's `side = isSH ? +1 : -1`. The GFS rotated-x screen
        // unit works out to (-cos dir, -sin dir); scale by that side.
        var side = isSH ? +1 : -1;
        var fx = side * -Math.cos(dirRad), fy = side * -Math.sin(dirRad);

        var kt = speed;
        var nPen  = Math.floor(kt / 50); kt -= nPen  * 50;
        var nFull = Math.floor(kt / 10); kt -= nFull * 10;
        var nHalf = (kt >= 4.5) ? 1 : 0;

        var segs = [];   // [x1, y1, x2, y2] line segments (shaft + feathers)
        var pens = [];   // "x1,y1 x2,y2 x3,y3" pennant triangles
        segs.push([0, 0, STAFF * sx, STAFF * sy]);

        var pos = STAFF;  // distance from station along the shaft; walk inward
        for (var i = 0; i < nPen; i++) {
            var ax = pos * sx, ay = pos * sy;
            var bx2 = (pos - PEN_BASE) * sx, by2 = (pos - PEN_BASE) * sy;
            pens.push(ax.toFixed(2) + ',' + ay.toFixed(2) + ' ' +
                      bx2.toFixed(2) + ',' + by2.toFixed(2) + ' ' +
                      (ax + FEATHER * fx).toFixed(2) + ',' + (ay + FEATHER * fy).toFixed(2));
            pos -= PEN_BASE + SPACING * 0.5;
        }
        for (var f = 0; f < nFull; f++) {
            var fxp = pos * sx, fyp = pos * sy;
            segs.push([fxp, fyp, fxp + FEATHER * fx, fyp + FEATHER * fy]);
            pos -= SPACING;
        }
        if (nHalf) {
            if (nPen === 0 && nFull === 0) pos -= SPACING;
            var hxp = pos * sx, hyp = pos * sy;
            segs.push([hxp, hyp, hxp + FEATHER_H * fx, hyp + FEATHER_H * fy]);
        }

        function pass(color, width) {
            var s = '';
            for (var k = 0; k < segs.length; k++) {
                var g = segs[k];
                s += '<line x1="' + g[0].toFixed(2) + '" y1="' + g[1].toFixed(2) +
                     '" x2="' + g[2].toFixed(2) + '" y2="' + g[3].toFixed(2) +
                     '" stroke="' + color + '" stroke-width="' + width + '"/>';
            }
            for (var p = 0; p < pens.length; p++) {
                s += '<polygon points="' + pens[p] + '" fill="' + color +
                     '" stroke="' + color + '" stroke-width="' + width + '"/>';
            }
            return s;
        }

        // Pass 1 — dark knockout halo; pass 2 — cream ink on top.
        return pass('rgba(0,0,0,0.55)', 3.0) + pass('rgba(244,240,224,0.95)', 1.4);
    }

    /** Build a station-plot SVG markup string for one observation.
     *  L.divIcon expects a string, so we synthesize the SVG directly
     *  instead of going through createElementNS / outerHTML (which
     *  was triggering an L.divIcon serialization issue). */
    function _renderStationPlot(ob) {
        var labels = '';
        function label(x, y, text, anchor) {
            if (text == null || text === '') return;
            labels += '<text x="' + x + '" y="' + y +
                      '" text-anchor="' + (anchor || 'middle') + '"' +
                      ' font-family="\'DM Sans\',sans-serif" font-size="9"' +
                      ' font-weight="600" fill="#0f172a" paint-order="stroke"' +
                      ' stroke="rgba(255,255,255,0.85)" stroke-width="2">' +
                      text + '</text>';
        }
        if (ob.air_temp_c != null) label(-9, -7, Math.round(ob.air_temp_c), 'end');
        if (ob.dewpoint_c != null) label(-9, 12, Math.round(ob.dewpoint_c), 'end');
        if (ob.pressure_hpa != null) {
            var p10 = Math.round(ob.pressure_hpa * 10);
            var p3 = ('000' + (p10 % 1000)).slice(-3);
            label(9, -7, p3, 'start');
        }
        return '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="56"' +
               ' viewBox="-36 -28 72 56" class="ir-stn-plot">' +
               '<circle cx="0" cy="0" r="1.5" fill="#0f172a"/>' +
               _windBarbSvgString(ob.wind_speed_kt, ob.wind_dir_deg, ob.lat < 0) +
               labels + '</svg>';
    }

    /** Toggle the surface-obs overlay on the card. Fetches from the
     *  backend's /surface-obs endpoint, parses, plots each station. */
    window._irToggleSurfaceObs = function () {
        var btn = document.getElementById('ir-detail-obs-toggle');
        if (!detailMap || !currentStormId) return;
        if (_surfaceObsLayer) {
            // Toggle off.
            detailMap.removeLayer(_surfaceObsLayer);
            _surfaceObsLayer = null;
            if (btn) btn.classList.remove('active');
            if (_surfaceObsAbortController) {
                try { _surfaceObsAbortController.abort(); } catch (e) {}
                _surfaceObsAbortController = null;
            }
            _ga('ir_surface_obs_toggle', { on: false });
            return;
        }
        if (btn) btn.classList.add('active');
        _ga('ir_surface_obs_toggle', { on: true });

        var atcfId = currentStormId;
        _surfaceObsAbortController = new AbortController();
        var sig = _surfaceObsAbortController.signal;
        fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) +
              '/surface-obs?radius_deg=10', { signal: sig })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (data) {
                if (currentStormId !== atcfId) return;
                var obs = (data && data.observations) || [];
                var lg = L.layerGroup();
                for (var i = 0; i < obs.length; i++) {
                    var ob = obs[i];
                    var html = _renderStationPlot(ob);
                    // Tooltip text — full obs detail on hover.
                    var lines = [];
                    lines.push('<b>' + ob.id + '</b> · ' + ob.source);
                    if (ob.wind_speed_kt != null && ob.wind_dir_deg != null) {
                        lines.push('Wind: ' + Math.round(ob.wind_dir_deg) + '° @ ' +
                                   Math.round(ob.wind_speed_kt) + ' kt' +
                                   (ob.wind_gust_kt != null ?
                                    ' (gusts ' + Math.round(ob.wind_gust_kt) + ')' : ''));
                    }
                    if (ob.air_temp_c != null) {
                        lines.push('T: ' + ob.air_temp_c.toFixed(1) + '°C / ' +
                                   _cToF(ob.air_temp_c) + '°F');
                    }
                    if (ob.dewpoint_c != null) {
                        lines.push('Td: ' + ob.dewpoint_c.toFixed(1) + '°C');
                    }
                    if (ob.sst_c != null) {
                        lines.push('SST: ' + ob.sst_c.toFixed(1) + '°C');
                    }
                    if (ob.pressure_hpa != null) {
                        lines.push('MSLP: ' + ob.pressure_hpa.toFixed(1) + ' hPa');
                    }
                    if (ob.wave_height_m != null) {
                        lines.push('Waves: ' + ob.wave_height_m.toFixed(1) + ' m');
                    }
                    if (ob.time_utc) lines.push('<i>' + ob.time_utc + '</i>');
                    var marker = L.marker([ob.lat, ob.lon], {
                        icon: L.divIcon({
                            className: 'ir-stn-plot-icon',
                            html: html,
                            iconSize: [72, 56],
                            iconAnchor: [36, 28],
                        }),
                        interactive: true, keyboard: false,
                    });
                    marker.bindTooltip(lines.join('<br>'), {
                        sticky: true, direction: 'top', offset: [0, -10],
                        className: 'ir-stn-plot-tooltip',
                    });
                    lg.addLayer(marker);
                }
                _surfaceObsLayer = lg.addTo(detailMap);
                console.log('[RT Monitor] Surface obs: ' + obs.length +
                            ' stations within ' +
                            (data.bbox ? '10°' : 'bbox'));
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') return;
                console.warn('[RT Monitor] surface obs fetch failed:', err && err.message);
                if (btn) btn.classList.remove('active');
            });
    };

    /** Clean up on storm switch / card close. */
    function _clearSurfaceObs() {
        if (_surfaceObsLayer && detailMap) {
            try { detailMap.removeLayer(_surfaceObsLayer); } catch (e) {}
        }
        _surfaceObsLayer = null;
        if (_surfaceObsAbortController) {
            try { _surfaceObsAbortController.abort(); } catch (e) {}
            _surfaceObsAbortController = null;
        }
        var btn = document.getElementById('ir-detail-obs-toggle');
        if (btn) btn.classList.remove('active');
    }

    // ── Global-map surface-obs overlay (viewport METAR + NDBC) ──────
    // Mirrors the storm-card overlay but is driven by the live map
    // bounds instead of a storm center. Zoom-gated so we never try to
    // draw the whole planet; pixel-grid declutter keeps dense regions
    // (e.g. CONUS airports) from stacking into mush.

    function _rtObsSetHint(text) {
        var el = document.getElementById('ir-obs-hint');
        if (!el) {
            if (!text) return;
            el = document.createElement('div');
            el.id = 'ir-obs-hint';
            el.className = 'ir-obs-hint-pos';
            document.body.appendChild(el);
        }
        el.textContent = text || '';
        el.style.display = text ? '' : 'none';
    }

    // Keep only the richest ob within each ~52px pixel cell at the
    // current zoom so plots never overlap into illegibility.
    function _rtObsDeclutter(obs) {
        if (!map || obs.length < 2) return obs;
        var CELL = 52, kept = {}, out = [];
        function richness(o) {
            var s = 0;
            if (o.pressure_hpa != null) s += 4;
            if (o.wind_speed_kt != null) s += 2;
            if (o.air_temp_c != null) s += 1;
            if (o.source === 'NDBC') s += 1;
            return s;
        }
        for (var i = 0; i < obs.length; i++) {
            var ob = obs[i];
            var pt;
            try { pt = map.latLngToContainerPoint([ob.lat, ob.lon]); }
            catch (e) { out.push(ob); continue; }
            var key = Math.floor(pt.x / CELL) + ':' + Math.floor(pt.y / CELL);
            var prev = kept[key];
            if (prev === undefined) { kept[key] = out.length; out.push(ob); }
            else if (richness(ob) > richness(out[prev])) { out[prev] = ob; }
        }
        return out;
    }

    function _rtObsRefresh() {
        if (!_rtObsOn || !map) return;
        var z = map.getZoom();
        if (z < _RT_OBS_MIN_ZOOM) {
            if (_rtObsLayer) { map.removeLayer(_rtObsLayer); _rtObsLayer = null; }
            _rtObsLastKey = '';
            _rtObsSetHint('Zoom in to see surface obs');
            return;
        }
        var b = map.getBounds();
        var n = Math.min(90, b.getNorth()), s = Math.max(-90, b.getSouth());
        var e = b.getEast(), w = b.getWest();
        // Dedupe identical viewports (rounded) to avoid redundant pulls.
        var key = [z, n.toFixed(1), s.toFixed(1), e.toFixed(1), w.toFixed(1)].join(',');
        if (key === _rtObsLastKey) return;
        _rtObsLastKey = key;
        _rtObsSetHint('Loading surface obs…');
        if (_rtObsAbort) { try { _rtObsAbort.abort(); } catch (e2) {} }
        _rtObsAbort = new AbortController();
        var sig = _rtObsAbort.signal;
        var url = API_BASE + '/ir-monitor/surface-obs/viewport?north=' +
                  n.toFixed(3) + '&south=' + s.toFixed(3) +
                  '&east=' + e.toFixed(3) + '&west=' + w.toFixed(3) +
                  '&max_stations=500';
        fetch(url, { signal: sig })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (data) {
                if (!_rtObsOn) return;
                var obs = (data && data.observations) || [];
                var total = obs.length;
                obs = _rtObsDeclutter(obs);
                var lg = L.layerGroup();
                for (var i = 0; i < obs.length; i++) {
                    var ob = obs[i];
                    var html = _renderStationPlot(ob);
                    var lines = [];
                    lines.push('<b>' + ob.id + '</b> · ' + ob.source);
                    if (ob.wind_speed_kt != null && ob.wind_dir_deg != null) {
                        lines.push('Wind: ' + Math.round(ob.wind_dir_deg) + '° @ ' +
                                   Math.round(ob.wind_speed_kt) + ' kt' +
                                   (ob.wind_gust_kt != null ?
                                    ' (gusts ' + Math.round(ob.wind_gust_kt) + ')' : ''));
                    }
                    if (ob.air_temp_c != null) {
                        lines.push('T: ' + ob.air_temp_c.toFixed(1) + '°C / ' +
                                   _cToF(ob.air_temp_c) + '°F');
                    }
                    if (ob.dewpoint_c != null) lines.push('Td: ' + ob.dewpoint_c.toFixed(1) + '°C');
                    if (ob.sst_c != null) lines.push('SST: ' + ob.sst_c.toFixed(1) + '°C');
                    if (ob.pressure_hpa != null) lines.push('MSLP: ' + ob.pressure_hpa.toFixed(1) + ' hPa');
                    if (ob.wave_height_m != null) lines.push('Waves: ' + ob.wave_height_m.toFixed(1) + ' m');
                    if (ob.time_utc) lines.push('<i>' + ob.time_utc + '</i>');
                    var marker = L.marker([ob.lat, ob.lon], {
                        icon: L.divIcon({
                            className: 'ir-stn-plot-icon',
                            html: html,
                            iconSize: [72, 56],
                            iconAnchor: [36, 28],
                        }),
                        interactive: true, keyboard: false,
                    });
                    marker.bindTooltip(lines.join('<br>'), {
                        sticky: true, direction: 'top', offset: [0, -10],
                        className: 'ir-stn-plot-tooltip',
                    });
                    lg.addLayer(marker);
                }
                if (_rtObsLayer) { map.removeLayer(_rtObsLayer); }
                _rtObsLayer = lg.addTo(map);
                var hint = obs.length + ' obs';
                if (obs.length < total) hint += ' (' + total + ' thinned)';
                _rtObsSetHint(hint);
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') return;
                console.warn('[RT Monitor] viewport surface obs fetch failed:', err && err.message);
                _rtObsSetHint('Surface obs unavailable');
            });
    }

    function _rtObsOnMove() {
        if (_rtObsDebounce) clearTimeout(_rtObsDebounce);
        _rtObsDebounce = setTimeout(_rtObsRefresh, 350);
    }

    window._rtToggleSurfaceObs = function () {
        var btn = document.getElementById('ir-obs-toggle');
        if (!map) return;
        _rtObsOn = !_rtObsOn;
        if (btn) btn.classList.toggle('active', _rtObsOn);
        _ga('rt_viewport_obs_toggle', { on: _rtObsOn });
        if (_rtObsOn) {
            map.on('moveend', _rtObsOnMove);
            _rtObsLastKey = '';
            _rtObsRefresh();
        } else {
            map.off('moveend', _rtObsOnMove);
            if (_rtObsDebounce) { clearTimeout(_rtObsDebounce); _rtObsDebounce = null; }
            if (_rtObsAbort) { try { _rtObsAbort.abort(); } catch (e) {} _rtObsAbort = null; }
            if (_rtObsLayer) { map.removeLayer(_rtObsLayer); _rtObsLayer = null; }
            _rtObsLastKey = '';
            _rtObsSetHint('');
        }
    };

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
        // 10-min steps — aligns with the underlying satellite scan grid
        // (Himawari + GOES Full Disk both scan every 10 min). 15-min
        // cadence was off-by-5-min on half the frames, causing storm
        // position alternation between consecutive frames.
        var step = 10 * 60 * 1000;
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

        // Surface Obs toggle — fifth in the top-left stack, beneath
        // Grid. Overlays live METAR (airports/land) + NDBC (marine
        // buoy) station plots for the current viewport. Zoom-gated
        // (≥5) so we never draw the whole planet; pixel-thinned so
        // dense regions stay legible. Default OFF.
        if (!document.getElementById('ir-obs-toggle')) {
            var otog = document.createElement('button');
            otog.id = 'ir-obs-toggle';
            otog.className = 'ir-legend-toggle ir-obs-toggle-pos';
            otog.type = 'button';
            otog.title = 'Show / hide live surface observations — METAR ' +
                         'airports/land + NDBC marine buoys — as conventional ' +
                         'station plots (wind barb, temperature, dewpoint, ' +
                         'pressure). Zoom in to regional scale to see them.';
            otog.innerHTML = '◎ Obs';
            otog.addEventListener('click', function () {
                window._rtToggleSurfaceObs();
            });
            document.body.appendChild(otog);
        }

        // Add IR Tb colorbar to global map (bottom-left, above animation panel)
        var TbColorbar = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                var container = L.DomUtil.create('div', 'ir-global-colorbar');
                container.id = 'ir-global-colorbar';
                container.style.cssText = 'background:rgba(0,0,0,0.65);padding:6px 10px;border-radius:4px;font-family:\'DM Sans\',sans-serif;font-variant-numeric:tabular-nums;font-size:0.65rem;color:rgba(255,255,255,0.7);pointer-events:none;margin-bottom:4px;';
                L.DomEvent.disableClickPropagation(container);

                var label = L.DomUtil.create('div', '', container);
                label.textContent = 'Brightness Temp (°C)';
                label.style.cssText = 'margin-bottom:2px;';

                var bar = L.DomUtil.create('div', '', container);
                // GIBS Band 13 Clean Infrared default colormap — matches
                // NASA's rendering of the tiles served on the global map
                // (NOT Claude IR; the storm-card bundles use Claude IR
                // because they go through satellite_ir.py first).
                bar.style.cssText = 'width:160px;height:10px;border-radius:2px;margin:4px 0 2px;background:linear-gradient(to right,rgb(8,8,8),rgb(90,90,90),rgb(200,200,200),rgb(0,100,255),rgb(0,255,0),rgb(255,180,0),rgb(255,0,0),rgb(180,0,180),rgb(255,255,255));';

                var labels = L.DomUtil.create('div', '', container);
                labels.style.cssText = 'display:flex;justify-content:space-between;font-size:0.6rem;';
                labels.innerHTML = '<span>+35</span><span>-25</span><span>-85</span>';

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
    /** Advance a storm's pin position forward in time from its last
     *  advisory fix using its reported motion vector. The IR cutout
     *  already does this on the backend (it crops each frame around
     *  the INTERPOLATED storm position), so without this the pin can
     *  drift visually behind the actual convection — especially when
     *  an advisory cycle is overdue (e.g. JTWC skipping the 00Z
     *  warning for a weak system, leaving the 18Z fix 7+ hours old).
     *  Conservative gate: only extrapolate when the fix is between
     *  30 min and 9 h old AND motion is reported. Outside that range
     *  the advisory's own position is the safer pin. */
    function _extrapolateStormPin(s) {
        if (!s || s.motion_kt == null || s.motion_deg == null
                || !s.last_fix_utc) {
            return { lat: s.lat, lon: s.lon, extrapolated: false, ageH: null };
        }
        var fixMs = Date.parse(s.last_fix_utc);
        if (!isFinite(fixMs)) {
            return { lat: s.lat, lon: s.lon, extrapolated: false, ageH: null };
        }
        var ageH = (Date.now() - fixMs) / 3600000;
        if (ageH < 0.5 || ageH > 9) {
            return { lat: s.lat, lon: s.lon, extrapolated: false, ageH: ageH };
        }
        // Great-circle forward azimuth. Small-distance approx is fine for
        // typical TC speeds (≤ 40 kt × 9 h ≈ 670 km).
        var distKm = s.motion_kt * ageH * 1.852;
        var bearing = s.motion_deg * Math.PI / 180;
        var R = 6371.0;
        var lat1 = s.lat * Math.PI / 180;
        var lon1 = s.lon * Math.PI / 180;
        var d = distKm / R;
        var lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(d) +
            Math.cos(lat1) * Math.sin(d) * Math.cos(bearing)
        );
        var lon2 = lon1 + Math.atan2(
            Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
            Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
        );
        return {
            lat: lat2 * 180 / Math.PI,
            lon: lon2 * 180 / Math.PI,
            extrapolated: true,
            ageH: ageH,
        };
    }

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

            // Extrapolate the pin forward from the last fix so it
            // tracks the convection in the IR loop instead of lagging
            // behind by an advisory cycle.
            var pin = _extrapolateStormPin(s);
            var marker = L.marker([pin.lat, pin.lon], { icon: icon });

            // Popup content
            var vmaxStr = s.vmax_kt != null ? s.vmax_kt + ' kt' : '\u2014';
            var mslpStr = s.mslp_hpa != null ? s.mslp_hpa + ' hPa' : '\u2014';
            // When extrapolated, show both positions so users can tell
            // the pin reflects motion-based dead-reckoning, not the
            // last advisory's stated coordinates.
            var posLine = pin.extrapolated
                ? (fmtLatLon(pin.lat, pin.lon) + ' <span style="color:#94a3b8;font-size:0.7em;">' +
                   '(extrapolated +' + pin.ageH.toFixed(1) + 'h from ' +
                   fmtLatLon(s.lat, s.lon) + ')</span>')
                : fmtLatLon(s.lat, s.lon);
            var reconBadge = s.has_recon
                ? '<span class="ir-recon-badge" title="Aircraft reconnaissance active (recent vortex data message)">✈ RECON</span>'
                : '';
            var popupHtml =
                '<div class="ir-popup">' +
                  '<div class="ir-popup-name">' + (s.name || 'UNNAMED') + reconBadge + '</div>' +
                  '<div class="ir-popup-meta">' +
                    '<strong>' + categoryShort(cat) + '</strong> &middot; ' + vmaxStr + '<br>' +
                    'MSLP: ' + mslpStr + '<br>' +
                    posLine + '<br>' +
                    '<span style="color:#64748b;">' + (s.atcf_id || '') + '</span>' +
                  '</div>' +
                  '<button class="ir-popup-btn" onclick="window._irOpenStorm(\'' + s.atcf_id + '\')">View IR Detail</button>' +
                '</div>';

            marker.bindPopup(popupHtml, { maxWidth: 260 });

            // Also open detail on double-click
            // + predictive prefetch on hover/popup: warm the browser cache
            // with this storm's display-WebP bundle so the eventual click
            // → openStormDetail feels instant (~400ms saved).
            (function (atcfId) {
                marker.on('dblclick', function () {
                    window._irOpenStorm(atcfId);
                });
                _bindPrefetchOnMarker(marker, atcfId);
            })(s.atcf_id);

            marker.addTo(map);
            stormMarkers.push(marker);
        }
    }

    // ── Predictive prefetch on hover (Tier-1 UX win) ─────────────
    // Warms the browser cache with this storm's display-WebP bundle
    // 200 ms after sustained hover, or instantly when the popup opens.
    // Guardrails:
    //   • Skip on touch (no hover, mobile bandwidth matters more)
    //   • Debounce 200 ms so casual mouse-pan over markers doesn't trigger
    //   • Only prefetch display bundle (~1.5 MB), not raw Tb (~2-5 MB) —
    //     the click will fetch raw Tb itself; this just removes the
    //     bigger latency component
    //   • Track prefetched storms per session so we don't re-fetch
    //   • Use default browser cache (NOT 'no-store') so the data lands
    //     in HTTP cache for the real fetch to consume
    var _prefetchedStorms = {};
    var _PREFETCH_HOVER_MS = 200;
    function _isPrefetchTouchDevice() {
        if (typeof window.matchMedia !== 'function') return false;
        return window.matchMedia('(pointer: coarse)').matches
            && window.matchMedia('(hover: none)').matches;
    }
    function _prefetchStormFramesBundle(atcfId) {
        if (!atcfId || _prefetchedStorms[atcfId]) return;
        _prefetchedStorms[atcfId] = true;
        var gcsUrl = _gcsFramesBundleUrl(atcfId);
        var apiUrl = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
            + '/ir-frames-bundle?lookback_hours=' + JPG_PRIMARY_LOOKBACK_H
            + '&radius_deg=' + JPG_PRIMARY_RADIUS_DEG
            + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;
        // Try GCS direct → silently fall through to API. We deliberately
        // don't use AbortController here — once started, let it finish
        // populating cache even if user mouses away.
        fetch(gcsUrl).then(function (r) {
            if (r.ok) return r;
            return fetch(apiUrl);
        }).catch(function () {
            // Prefetch is best-effort; failure just means the real click
            // will pay the full latency. Reset the flag so a retry can
            // happen if the user actually clicks.
            delete _prefetchedStorms[atcfId];
        });
    }
    function _bindPrefetchOnMarker(marker, atcfId) {
        if (_isPrefetchTouchDevice()) return;
        var timer = null;
        marker.on('mouseover', function () {
            if (_prefetchedStorms[atcfId]) return;
            timer = setTimeout(function () {
                _prefetchStormFramesBundle(atcfId);
            }, _PREFETCH_HOVER_MS);
        });
        marker.on('mouseout', function () {
            if (timer) { clearTimeout(timer); timer = null; }
        });
        // Popup open = strong intent → prefetch instantly, no debounce
        marker.on('popupopen', function () {
            if (timer) { clearTimeout(timer); timer = null; }
            _prefetchStormFramesBundle(atcfId);
        });
    }

    /** Clear past track layers from the map */
    function clearTracks() {
        for (var i = 0; i < trackLayers.length; i++) {
            map.removeLayer(trackLayers[i]);
        }
        trackLayers = [];
        // Intentionally NOT clearing _stormNameLabels: its markers were
        // just removed from the map via trackLayers above, but keeping the
        // by-id references lets the next drawTrackOnMap remove a stale
        // duplicate that a poll/fetch race might otherwise leave behind.
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

    /** Draw a past track polyline + intensity dots on a Leaflet map.
     *  `extrapPin` (optional): the dead-reckoned "now" position used to
     *  center the IR cutout. When given (detail map), the track is
     *  extended from the last official fix to this pin with a dashed
     *  segment and the name label is placed there, so the track lines up
     *  with the convection in the loop instead of lagging behind by an
     *  advisory cycle. */
    function drawTrackOnMap(targetMap, history, storm, layerArr, extrapPin) {
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

        // Extend the track to the dead-reckoned "now" pin so the line +
        // name label sit on the convection shown in the IR loop (the
        // cutout is centered on this same extrapolation). Dashed to mark
        // it as extrapolated rather than an official fix.
        var labelPos = last;
        if (extrapPin && extrapPin.extrapolated &&
                isFinite(extrapPin.lat) && isFinite(extrapPin.lon)) {
            var eDlon = extrapPin.lon - last.lon;
            if (Math.abs(eDlon) <= 180 &&
                    (Math.abs(extrapPin.lat - last.lat) > 0.02 || Math.abs(eDlon) > 0.02)) {
                var extColor = SS_COLORS[cat] || SS_COLORS.TD;
                var extSeg = L.polyline(
                    [[last.lat, last.lon], [extrapPin.lat, extrapPin.lon]],
                    { color: extColor, weight: 2.5, opacity: 0.7, dashArray: '4,5' }
                );
                extSeg.addTo(targetMap);
                layerArr.push(extSeg);
                labelPos = extrapPin;
            }
        }

        var label = L.marker([labelPos.lat, labelPos.lon], {
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

        // Register on the main map so genesis matching can hide the
        // redundant name text when a disturbance pin already shows it.
        // Remove any prior label for this storm first so a poll/fetch
        // race can't leave two name labels for the same system.
        if (targetMap === map && storm.atcf_id) {
            var key = String(storm.atcf_id).toUpperCase();
            var prev = _stormNameLabels[key];
            if (prev && map) { try { map.removeLayer(prev); } catch (e) {} }
            label._atcfId = key;
            _stormNameLabels[key] = label;
            _syncStormLabelVisibility();
        }
    }

    // Hide an active-storm's name label when its ATCF id is currently
    // represented by a genesis disturbance pin (which carries the same
    // official name). The colored past-track line stays — only the
    // duplicate text is suppressed — so the user sees one "Jangmi"
    // instead of two. Restores all labels when genesis is off.
    function _syncStormLabelVisibility() {
        var ids = Object.keys(_stormNameLabels);
        for (var i = 0; i < ids.length; i++) {
            var lbl = _stormNameLabels[ids[i]];
            if (!lbl) continue;
            var hide = _rtGenesisVisible && !!_genesisMatchedAtcfIds[ids[i]];
            if (typeof lbl.setOpacity === 'function') lbl.setOpacity(hide ? 0 : 1);
        }
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
                        try { window.dispatchEvent(new CustomEvent('ir-storms-loaded')); } catch (e) {}
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

                // Notify listeners (e.g. Storm Satellite tab) that a fresh
                // active-storms list is available so they can pick a default.
                if (stormData.length > 0) {
                    try { window.dispatchEvent(new CustomEvent('ir-storms-loaded')); } catch (e) {}
                }

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

                // Real-Time Monitor: if a storm card is open, see if the
                // frames bundle has fresher frames and swap them in. The
                // satellite source publishes every 10 min and the backend
                // prewarm rebuilds the bundle every 5 min, so a 10-min
                // poll naturally aligns with one new frame per cycle.
                if (currentStormId && detailMap) {
                    try { _refreshFramesIfNewer(currentStormId); }
                    catch (e) { console.warn('[RT Monitor] frame refresh failed:', e); }
                }

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
        // Revoke any blob URLs created by the bundle path so the backing
        // ArrayBuffer can be GC'd. No-op when the GIBS or per-frame path
        // is active (those don't populate _activeFrameBlobUrls).
        _revokeActiveFrameBlobUrls();
        // Also clean up GeoColor / Visible / WV frames
        cleanupGeocolorFrameLayers();
        cleanupVisFrameLayers();
        cleanupWvFrameLayers();
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
                    '<a href="realtime_ir.html#recon">\u2192 Open in Recon</a>';
            } else {
                document.getElementById('ir-recon-section').style.display = 'none';
            }
        }
        if (cached && cached.meta && (Date.now() - cached.cachedAt) < PANEL_CACHE_TTL_MS) {
            _handleMeta(cached.meta);
        } else {
            (function _loadMeta() {
                fetchStormMetadata(atcfId, function (err, meta) {
                    if (!err && meta) {
                        if (!_panelCache[atcfId]) _panelCache[atcfId] = { cachedAt: Date.now() };
                        _panelCache[atcfId].meta = meta;
                        _handleMeta(meta);
                    } else {
                        // Stop the skeleton from pulsing forever and give the
                        // user a one-click retry instead of a dead panel.
                        var chartEl = document.getElementById('ir-intensity-chart');
                        if (chartEl) {
                            chartEl.className = 'ir-intensity-chart';
                            chartEl.innerHTML = '';
                            _rtStatusError(chartEl, _loadMeta, 'Couldn’t load intensity history');
                        }
                    }
                });
            })();
        }
        // Raw Tb pre-fetch starts when ALL GIBS tiles finish loading
        // (see onFrameLayerLoaded). Panel requests get a natural head
        // start since they fire on the first tile, not the last.
    }

    // ── JPG primary path config ──────────────────────────────
    // The Storm Satellite animation now defaults to single-image WebP
    // frames served by the API's /ir-frame.jpg endpoint, with GIBS
    // tiles as the auto-fallback.  Why this is better:
    //
    //   * One ~60 KB image per frame replaces ~16 GIBS tile requests.
    //     For a 13-frame, 6-h × 30-min animation that's 13 requests
    //     instead of ~208 — fewer round-trips, fewer TLS handshakes,
    //     and no GIBS-side per-tile retry pipeline.
    //   * The backend already pre-renders these every 5 min into GCS
    //     (see _prefetch_ir_frames in ir_monitor_api.py), so the typical
    //     fetch is a warm-cache hit served by Cloud Run from GCS rather
    //     than a chain of NASA-CDN lookups.
    //   * The WebPs are Mercator-warped server-side (see
    //     _warp_eq_to_mercator_local) so L.imageOverlay's linear stretch
    //     on a Web-Mercator basemap is geographically correct.
    //
    // If the /ir-frames-meta probe fails or too many image overlays
    // error out, we fall through to _initDetailMapGIBS for that storm.
    var JPG_FALLBACK_ERROR_THRESHOLD = 0.5;  // >50% frame errors → swap to GIBS
    var JPG_PRIMARY_RADIUS_DEG = 10.0;
    var JPG_PRIMARY_LOOKBACK_H = DEFAULT_LOOKBACK_HOURS;
    // 10-min cadence — produces 37 frames in a 6h lookback. CHANGED from
    // 15-min because the satellite scan grid (Himawari + GOES Full Disk)
    // is every 10 min on 0/10/20/30/40/50, and a 15-min cadence is
    // off-by-5-min on half the frames: requested 00:15 → server picks
    // the 00:10 scan (5 min earlier than request) → cutout center is
    // at interp(00:15) but image data is from 00:10 → storm in image
    // appears OFFSET from cutout center by 5min*motion ≈ 0.04° for
    // typical TC speed. Adjacent frames at 00:00/00:30 use exact scans
    // → storm at image center. Result: visible alternation between two
    // storm positions every frame ("NW then SE then NW...") that users
    // see as bouncing. 10-min cadence aligns every frame with the
    // scan grid, eliminating the offset.
    var JPG_PRIMARY_INTERVAL_MIN = 10;
    // Same cadence used for the raw-Tb fetch so hover-Tb + colormap-switch
    // reuse the same prewarmed frame set.
    var RAW_TB_INTERVAL_MIN = 10;
    var _jpgPathFellBack = false;

    // Track blob URLs we create from bundle bytes so we can revoke them
    // on storm-switch and avoid leaking the underlying ArrayBuffer slices.
    var _activeFrameBlobUrls = [];

    function _revokeActiveFrameBlobUrls() {
        for (var i = 0; i < _activeFrameBlobUrls.length; i++) {
            try { URL.revokeObjectURL(_activeFrameBlobUrls[i]); } catch (e) {}
        }
        _activeFrameBlobUrls = [];
    }

    /** Primary animation path: ONE binary request → all 13 WebPs at once.
     *  This is what makes the animation feel "all frames are here, play
     *  smoothly" instead of "frames pop in randomly." On bundle failure
     *  (404, parse error, network), falls through to the per-frame path
     *  which itself falls through to GIBS if /ir-frames-meta is down. */
    /** Re-fetch the frames bundle and, if the latest frame is newer than
     *  the current latest, swap in the new bundle. Preserves the user's
     *  current playback by jumping to the latest frame (the typical
     *  "I want to see what's new" expectation in a Real-Time Monitor).
     *  Bandwidth-cheap because GCS bundle responses carry
     *  Cache-Control: public,max-age=300 and the browser issues a
     *  conditional request — returns 304 unchanged most of the time.
     *
     *  Refresh strategy:
     *  - When the user is on IR, refresh the IR bundle (the typical case).
     *  - When the user is on a non-IR product (GeoColor / Vis / WV),
     *    refresh THAT product so they see new frames there too. The IR
     *    bundle is small (~10 MB) and the satellite source publishes
     *    every 10 min, so a single per-poll fetch keeps the active view
     *    current without thrashing the IR pipeline. */
    function _refreshFramesIfNewer(atcfId) {
        if (!detailMap || currentStormId !== atcfId) return;
        // Dispatch by active product. Each helper checks its own state
        // and only swaps frames if the new bundle has a newer latest.
        if (productMode === 'eir') {
            _refreshIrFramesIfNewer(atcfId);
        } else if (productMode === 'geocolor') {
            _refreshGeocolorFramesIfNewer(atcfId);
        } else if (productMode === 'vis' || productMode === 'wv') {
            _refreshBandFramesIfNewer(atcfId, productMode);
        }
        // Also opportunistically refresh IR in the background even when
        // the user is on a non-IR product so coming back to IR shows
        // fresh data. Skipped if IR was never loaded (e.g. card opened
        // straight to GeoColor) — that's fine since clicking IR will
        // load fresh on first activation.
        if (productMode !== 'eir' && animFrameTimes.length > 0) {
            _refreshIrFramesIfNewer(atcfId);
        }
    }

    function _refreshIrFramesIfNewer(atcfId) {
        if (animFrameTimes.length === 0) return;
        var currentLatest = animFrameTimes[animFrameTimes.length - 1];
        var gcsUrl = _gcsFramesBundleUrl(atcfId);
        var apiUrl = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
            + '/ir-frames-bundle'
            + '?lookback_hours=' + JPG_PRIMARY_LOOKBACK_H
            + '&radius_deg=' + JPG_PRIMARY_RADIUS_DEG
            + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;

        // Conditional revalidation against GCS so the browser typically
        // gets a 304 when the prewarm hasn't run since the last poll.
        fetch(gcsUrl, { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('gcs ' + r.status);
                return r.arrayBuffer();
            })
            .catch(function () {
                return fetch(apiUrl).then(function (r) {
                    if (!r.ok) throw new Error('api ' + r.status);
                    return r.arrayBuffer();
                });
            })
            .then(function (buf) {
                if (currentStormId !== atcfId) return;  // user switched storms
                // Peek the bundle header to see if there's a newer frame.
                var dv = new DataView(buf);
                if (buf.byteLength < 4) return;
                var headerLen = dv.getUint32(0, true);
                if (4 + headerLen > buf.byteLength) return;
                var header = JSON.parse(new TextDecoder('utf-8').decode(
                    new Uint8Array(buf, 4, headerLen)));
                var newFrames = (header && header.frames) || [];
                if (!newFrames.length) return;
                var newLatest = newFrames[newFrames.length - 1].datetime_utc;
                if (!newLatest || newLatest <= currentLatest) return;

                // Newer data — rebuild the animation in place. Pause first
                // so the swap doesn't race the tick loop, then jump the
                // slider to the latest frame after rebuild (the user wants
                // to see what's new). _initDetailMapJPGWithBundle resets
                // animFrameLayers / Times etc. and re-adds overlays.
                var wasPlaying = animPlaying;
                if (wasPlaying) stopAnimation();
                // Find the storm record so the rebuild can reuse the same
                // satellite layer name selection.
                var storm = null;
                for (var i = 0; i < stormData.length; i++) {
                    if (stormData[i].atcf_id === atcfId) { storm = stormData[i]; break; }
                }
                if (!storm) return;
                var satLayerName = GIBS_IR_LAYERS[detailSatName] || null;
                // Tear down existing IR layers first (the rebuild adds new ones).
                cleanupFrameLayers();
                _initDetailMapJPGWithBundle(storm, satLayerName, buf);

                console.log('[RT Monitor] frames refreshed — latest ' + newLatest);
                if (wasPlaying) {
                    // Restart play once the new bundle has booted up.
                    setTimeout(function () {
                        if (framesReady && currentStormId === atcfId) startAnimation();
                    }, 250);
                }
            })
            .catch(function (err) {
                console.warn('[RT Monitor] frame refresh fetch failed:', err && err.message);
            });
    }

    /** Cheap "is there anything new?" probe for a generic bundle URL.
     *  Fetches with `cache: no-cache` (so GCS revalidates), peeks the
     *  JSON header, and resolves true iff the bundle's latest frame
     *  datetime is newer than `currentLatest`. Used by the non-IR
     *  refresh helpers so they don't tear down and rebuild layers on
     *  every poll when nothing has changed. */
    function _bundleHasNewerLatest(bundleUrl, fallbackUrl, currentLatest) {
        return fetch(bundleUrl, { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('GCS ' + r.status);
                return r.arrayBuffer();
            })
            .catch(function () {
                return fetch(fallbackUrl).then(function (r) {
                    if (!r.ok) throw new Error('API ' + r.status);
                    return r.arrayBuffer();
                });
            })
            .then(function (buf) {
                var dv = new DataView(buf);
                if (buf.byteLength < 4) return { newer: false, buf: buf };
                var headerLen = dv.getUint32(0, true);
                if (4 + headerLen > buf.byteLength) return { newer: false, buf: buf };
                var header = JSON.parse(new TextDecoder('utf-8').decode(
                    new Uint8Array(buf, 4, headerLen)));
                var frames = (header && header.frames) || [];
                if (!frames.length) return { newer: false, buf: buf };
                var newLatest = frames[frames.length - 1].datetime_utc;
                if (!newLatest || newLatest <= currentLatest) {
                    return { newer: false, buf: buf };
                }
                return { newer: true, buf: buf };
            });
    }

    /** GeoColor bundle refresh — same approach as IR but uses the
     *  GeoColor endpoint. If newer frames are available, fully reload
     *  via loadGeocolorFrames after clearing the existing layers. */
    function _refreshGeocolorFramesIfNewer(atcfId) {
        if (geocolorFrameTimes.length === 0) return;
        var currentLatest = geocolorFrameTimes[geocolorFrameTimes.length - 1];
        var gcsUrl = _GCS_GEOCOLOR_BUNDLE_BASE + '/' +
                     encodeURIComponent(atcfId.toUpperCase()) + '.bin';
        var apiUrl = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
            + '/geocolor-frames-bundle?lookback_hours=' + JPG_PRIMARY_LOOKBACK_H
            + '&radius_deg=' + JPG_PRIMARY_RADIUS_DEG
            + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;
        _bundleHasNewerLatest(gcsUrl, apiUrl, currentLatest)
            .then(function (probe) {
                if (currentStormId !== atcfId || productMode !== 'geocolor') return;
                if (!probe.newer) return;
                var wasPlaying = animPlaying;
                if (wasPlaying) stopAnimation();
                cleanupGeocolorFrameLayers();
                // Re-trigger the bundle ingest with the already-fetched buf
                // to avoid a second round trip.
                _ingestGeocolorBundle(probe.buf);
                console.log('[RT Monitor] GeoColor frames refreshed');
                if (wasPlaying) {
                    setTimeout(function () {
                        if (geocolorFramesReady && currentStormId === atcfId) startAnimation();
                    }, 250);
                }
            })
            .catch(function (err) {
                console.warn('[RT Monitor] GeoColor refresh failed:', err && err.message);
            });
    }

    /** Vis / WV bundle refresh. `productKey` is 'vis' or 'wv'. */
    function _refreshBandFramesIfNewer(atcfId, productKey) {
        var times = (productKey === 'vis') ? visFrameTimes : wvFrameTimes;
        if (times.length === 0) return;
        var currentLatest = times[times.length - 1];
        // Pick the band that matches the current view. For 'vis' we honor
        // the same day/night SWIR-fallback rule as loadVisFrames.
        var band;
        if (productKey === 'wv') {
            band = 8;
        } else {
            var sunEl = -90;
            if (detailStormLat != null && detailStormLon != null) {
                try { sunEl = solarElevation(detailStormLat, detailStormLon, new Date()); }
                catch (e) {}
            }
            band = (sunEl <= -6) ? 7 : 2;
        }
        var gcsUrl = _gcsBandBundleUrl(atcfId, band);
        var apiUrl = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
            + '/band-frames-bundle?band=' + band;
        _bundleHasNewerLatest(gcsUrl, apiUrl, currentLatest)
            .then(function (probe) {
                if (currentStormId !== atcfId || productMode !== productKey) return;
                if (!probe.newer) return;
                var wasPlaying = animPlaying;
                if (wasPlaying) stopAnimation();
                if (productKey === 'vis') cleanupVisFrameLayers();
                else cleanupWvFrameLayers();
                _ingestBandBundle(probe.buf, band, productKey);
                console.log('[RT Monitor] ' +
                    (productKey === 'vis' ? 'Visible' : 'WV') + ' frames refreshed');
                if (wasPlaying) {
                    setTimeout(function () {
                        var ready = (productKey === 'vis') ? visFramesReady : wvFramesReady;
                        if (ready && currentStormId === atcfId) startAnimation();
                    }, 250);
                }
            })
            .catch(function (err) {
                console.warn('[RT Monitor] ' + productKey + ' refresh failed:',
                             err && err.message);
            });
    }

    function _initDetailMapJPG(storm, satLayerName) {
        if (!detailMap) return;
        var atcfId = storm.atcf_id;

        var bundleUrl = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
            + '/ir-frames-bundle'
            + '?lookback_hours=' + JPG_PRIMARY_LOOKBACK_H
            + '&radius_deg=' + JPG_PRIMARY_RADIUS_DEG
            + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;

        // Two-tier fetch chain:
        //   1) Try the pre-built bundle in GCS (served direct from
        //      storage.googleapis.com, Cloud Run never sees the request).
        //      Built by the 5-min prewarm loop, so it's reliably warm for
        //      any active storm that's been alive for at least one cycle.
        //   2) Fall through to the API endpoint (assembles the bundle on
        //      demand from cached frames or fresh S3 pulls). Used for
        //      brand-new storms or when GCS misses for any reason.
        // No `cache: 'no-store'` — both responses carry Cache-Control:
        // public,max-age=300 so the browser can serve repeat opens
        // instantly without re-downloading.
        var gcsBundleUrl = _gcsFramesBundleUrl(atcfId);
        fetch(gcsBundleUrl)
            .then(function (r) {
                if (!r.ok) throw new Error('gcs bundle HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .catch(function () {
                // GCS miss — typical for brand-new storms before first prewarm.
                // Fall through to the API endpoint.
                return fetch(bundleUrl)
                    .then(function (r) {
                        if (!r.ok) throw new Error('api bundle HTTP ' + r.status);
                        return r.arrayBuffer();
                    });
            })
            .then(function (buf) {
                if (currentStormId !== atcfId || !detailMap) return;
                _initDetailMapJPGWithBundle(storm, satLayerName, buf);
            })
            .catch(function (err) {
                console.warn('[RT Monitor] Frames bundle unavailable (' +
                             (err && err.message) + '); falling through to per-frame JPG path');
                _initDetailMapJPGPerFrame(storm, satLayerName);
            });
    }

    // ── GCS direct-bundle URL helpers ────────────────────────────
    // The prewarm loop writes a fresh bundle blob every 5 min to
    // gs://tc-atlas-ir-cache/{version}/bundles/{kind}/{atcf_id}.bin with
    // publicRead ACL, so the browser can fetch it directly from
    // Google's storage edge instead of going through Cloud Run.
    //
    // The cache VERSION (rt-vN) is bumped server-side on render-format
    // changes. Because the browser reads bundles straight from GCS, it
    // can't see the server's version — so a bump used to silently freeze
    // the loop on the old prefix (whose stale object still returns 200).
    // We now discover the version at runtime from rt-version.json (written
    // each prewarm cycle by the backend), falling back to this pinned
    // default so a failed/blocked fetch still works for the current build.
    var _GCS_BUCKET_ROOT = 'https://storage.googleapis.com/tc-atlas-ir-cache';
    var _RT_BUNDLE_VERSION = 'rt-v11';   // fallback; _loadBundleVersion() may update
    var _GCS_BUNDLE_BASE = _GCS_BUCKET_ROOT + '/' + _RT_BUNDLE_VERSION + '/bundles';
    function _gcsFramesBundleUrl(atcfId) {
        return _GCS_BUNDLE_BASE + '/frames/' + encodeURIComponent(atcfId.toUpperCase()) + '.bin';
    }
    /** GCS URL for the per-band pre-rendered WebP bundle (band 2 = Vis,
     *  band 8 = WV). Same on-disk format as the IR frames bundle. */
    function _gcsBandBundleUrl(atcfId, band) {
        return _GCS_BUNDLE_BASE + '/band/' + band + '/' +
               encodeURIComponent(atcfId.toUpperCase()) + '.bin';
    }
    function _gcsRawBundleUrl(atcfId) {
        return _GCS_BUNDLE_BASE + '/raw/' + encodeURIComponent(atcfId.toUpperCase()) + '.bin';
    }

    /** Discover the live RT cache version from rt-version.json so a
     *  server-side version bump doesn't strand the browser on a stale
     *  old-prefix bundle. Best-effort: on any failure we keep the pinned
     *  _RT_BUNDLE_VERSION fallback. The fetched value is strictly
     *  validated (^rt-v<digits>$) before use so a corrupted/poisoned file
     *  can't redirect bundle fetches to an arbitrary path. Host is fixed
     *  (_GCS_BUCKET_ROOT) — only the version segment is dynamic. Returns a
     *  promise that always resolves (never rejects) so init() can await it
     *  without a guard. */
    function _loadBundleVersion() {
        var url = _GCS_BUCKET_ROOT + '/rt-version.json';
        return fetch(url, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                var v = j && j.version;
                if (typeof v === 'string' && /^rt-v\d+$/.test(v)) {
                    _RT_BUNDLE_VERSION = v;
                    _GCS_BUNDLE_BASE = _GCS_BUCKET_ROOT + '/' + v + '/bundles';
                    _GCS_GEOCOLOR_BUNDLE_BASE = _GCS_BUCKET_ROOT + '/' + v + '/bundles/geocolor';
                }
            })
            .catch(function () { /* keep pinned fallback */ });
    }

    // Mobile decoded-bitmap cap. Each animation frame is a ~10°-radius
    // WebP that decodes to a ~7 MB RGBA bitmap; a full 6 h / 10-min loop
    // is ~36 frames (~250 MB decoded). That overruns a phone tab's memory
    // budget and the browser kills the tab the moment playback forces all
    // frames to decode. On a mobile viewport we keep the encoded bundle
    // intact but only realize a capped, evenly-spaced subset of frames:
    // the loop still spans the full lookback window, just at a coarser
    // cadence. No-op on desktop. The most recent frame is always kept so
    // the "pause at present" anchor and latest imagery are preserved.
    var _MOBILE_MAX_FRAMES = 16;
    function _decimateFramesForMobile(frames) {
        // Windowed-decode mode bounds memory by capping how many frames
        // are *decoded* at once, so it wants the full-cadence frame list —
        // skip decimation entirely when it's active.
        if (_WINDOWED_DECODE) return frames;
        if (!_IS_MOBILE_VIEWPORT) return frames;
        if (!frames || frames.length <= _MOBILE_MAX_FRAMES) return frames;
        var n = frames.length;
        var stride = Math.ceil(n / _MOBILE_MAX_FRAMES);
        var keep = [];
        // Walk backward from the newest (last) frame so the present is
        // always retained regardless of where the stride lands.
        for (var i = n - 1; i >= 0; i -= stride) keep.push(frames[i]);
        keep.reverse(); // restore oldest-first ordering
        return keep;
    }

    // ── Windowed decode (opt-in, off by default) ──────────────────
    // The shipped mobile fix decimates the loop to cap decoded-bitmap
    // memory, which costs temporal cadence. Windowed decode instead keeps
    // EVERY frame in the loop but bounds how many carry a decoded bitmap
    // at once: a sliding window around the playhead holds the real WebP
    // src (each ~7 MB decoded); frames outside the window get a 1×1
    // transparent src so the browser frees their bitmap (the encoded blob
    // stays referenced, so re-entering the window just re-decodes). Peak
    // decoded memory ≈ (BACK+AHEAD+1) frames regardless of loop length,
    // so mobile can run the full-cadence loop without an OOM tab kill.
    //
    // Enabled per-session via ?decodewin=1 anywhere in the URL (query or
    // hash) so it can be validated on a real phone against a live storm
    // before becoming the default. When on, it supersedes decimation.
    var _WINDOWED_DECODE = (typeof location !== 'undefined') &&
                           (location.href || '').indexOf('decodewin=1') !== -1;
    var _DECODE_BACK = 3;    // frames kept decoded behind the playhead
    var _DECODE_AHEAD = 8;   // frames pre-decoded ahead (playback runs forward)
    var _TRANSPARENT_1PX =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    function _frameInDecodeWindow(i, idx, n) {
        for (var d = -_DECODE_BACK; d <= _DECODE_AHEAD; d++) {
            if (((idx + d) % n + n) % n === i) return true;
        }
        return false;
    }

    /** Promote frames inside the window (restore WebP src + force decode
     *  so they're warm before they're shown) and evict those outside it
     *  (swap to a 1×1 transparent src, freeing the decoded bitmap).
     *  `layers` is the active product's overlay array; `idx` is the
     *  raw layer index currently shown. No-op unless windowed mode is on
     *  and the loop is longer than the window. */
    function _applyDecodeWindow(layers, idx) {
        if (!_WINDOWED_DECODE || !layers) return;
        var n = layers.length;
        if (n <= _DECODE_BACK + _DECODE_AHEAD + 1) return; // whole loop fits — keep all decoded
        for (var i = 0; i < n; i++) {
            var ly = layers[i];
            if (!ly || !ly._frameBlobUrl) continue; // null/non-bundle layers untouched
            if (_frameInDecodeWindow(i, idx, n)) {
                if (ly._decodeEvicted) {
                    ly.setUrl(ly._frameBlobUrl);
                    ly._decodeEvicted = false;
                    // Force-decode now (even at opacity 0) so the frame is
                    // painted instantly when the playhead reaches it.
                    if (ly._image && ly._image.decode) {
                        try { ly._image.decode().catch(function () {}); } catch (e) {}
                    }
                }
            } else if (!ly._decodeEvicted) {
                ly.setUrl(_TRANSPARENT_1PX);
                ly._decodeEvicted = true;
            }
        }
    }

    // ── Cross-product memory cap (mobile) ─────────────────────────
    // Each product (IR / GeoColor / Vis / WV) keeps its own frame
    // overlays resident once loaded so switching back is instant. On
    // desktop that's free; on a phone the decoded bitmaps stack up —
    // IR + Visible (higher-res!) alone can OOM-kill the tab. So when
    // leaving a product on mobile we free its decoded bitmaps by swapping
    // every frame to a 1×1 transparent src; the encoded blobs and layer
    // objects stay (cheap), so returning re-decodes with no refetch.
    function _productLayers(mode) {
        if (mode === 'geocolor') return geocolorFrameLayers;
        if (mode === 'vis')      return visFrameLayers;
        if (mode === 'wv')       return wvFrameLayers;
        return animFrameLayers; // 'eir'
    }
    function _evictProductFrames(layers) {
        if (!layers) return;
        for (var i = 0; i < layers.length; i++) {
            var ly = layers[i];
            if (!ly || !ly._frameBlobUrl || ly._decodeEvicted) continue;
            ly.setUrl(_TRANSPARENT_1PX);
            ly._decodeEvicted = true;
        }
    }
    function _restoreProductFrames(layers) {
        if (!layers) return;
        for (var i = 0; i < layers.length; i++) {
            var ly = layers[i];
            if (!ly || !ly._frameBlobUrl || !ly._decodeEvicted) continue;
            ly.setUrl(ly._frameBlobUrl);
            ly._decodeEvicted = false;
        }
    }

    /** Parse the bundle ArrayBuffer and create N L.imageOverlays from blob
     *  URLs. All 13 frames arrive in one shot, so we add them to the map
     *  simultaneously (no batching needed — they're local memory). */
    function _initDetailMapJPGWithBundle(storm, satLayerName, buf) {
        if (!detailMap) return;
        var dv;
        var header;
        var binBase;
        try {
            dv = new DataView(buf);
            if (buf.byteLength < 4) throw new Error('bundle too small');
            var headerLen = dv.getUint32(0, true);
            if (4 + headerLen > buf.byteLength) throw new Error('bundle header overruns body');
            var headerBytes = new Uint8Array(buf, 4, headerLen);
            header = JSON.parse(new TextDecoder('utf-8').decode(headerBytes));
            binBase = 4 + headerLen;
        } catch (e) {
            console.warn('[RT Monitor] Bundle parse failed (' + e.message + '); per-frame fallback');
            _initDetailMapJPGPerFrame(storm, satLayerName);
            return;
        }

        var frames = (header && header.frames) || [];
        frames = _decimateFramesForMobile(frames);
        var bounds = header && header.bounds;
        if (!frames.length || !bounds) {
            console.warn('[RT Monitor] Bundle had no frames; per-frame fallback');
            _initDetailMapJPGPerFrame(storm, satLayerName);
            return;
        }

        // Match the existing animFrame ordering (oldest first)
        animFrameTimes = frames.map(function (f) { return f.datetime_utc; });
        animIndex = animFrameTimes.length - 1;
        if (header.satellite) detailSatName = header.satellite;

        // Geographic framing: each frame is placed at its OWN bounds.
        // The storm visually drifts through the viewport as it moves,
        // and track dots / lat/lon grid align exactly with where the
        // storm is in each frame. This makes the best-track markers
        // anchor properly to map coordinates instead of appearing to
        // "slide" against a fixed cutout.
        //
        // Trade-off: frame edges shift a few pixels per 10-min step
        // (subtle edge jitter). Previously we used the LATEST frame's
        // bounds for every overlay ("storm-relative" / co-moving), but
        // that caused the storm's IR signature to detach from the
        // best-track dots when the cutout's geographic center shifted
        // between frames. User explicitly chose geographic framing.

        var mediaType = header.media_type || 'image/webp';
        var goodCount = 0;
        _revokeActiveFrameBlobUrls();

        for (var i = 0; i < frames.length; i++) {
            var fh = frames[i];
            frameHasError.push(false);
            if (!fh.byte_length || fh.error) {
                // Failed frame: still push a null-ish placeholder so indices align
                animFrameLayers.push(null);
                frameHasError[frameHasError.length - 1] = true;
                continue;
            }
            // Zero-copy view into the bundle buffer, wrapped in a Blob
            var slice = new Uint8Array(buf, binBase + fh.byte_offset, fh.byte_length);
            var blob = new Blob([slice], { type: mediaType });
            var blobUrl = URL.createObjectURL(blob);
            _activeFrameBlobUrls.push(blobUrl);
            // Geographic framing: each frame at its own bounds so the
            // track dots / coastlines / lat-lon grid align with the
            // storm in every frame. Fall back to the bundle-level
            // bounds if a frame is missing per-frame bounds metadata.
            var fb = fh.bounds || bounds;
            var fBounds = L.latLngBounds(
                L.latLng(fb[0][0], fb[0][1]),
                L.latLng(fb[1][0], fb[1][1])
            );
            var overlay = L.imageOverlay(blobUrl, fBounds, {
                opacity: 0,
                interactive: false,
                pane: 'tilePane'
            });
            overlay._frameBlobUrl = blobUrl; // for windowed decode promote/evict
            animFrameLayers.push(overlay);
            goodCount++;
        }

        if (goodCount === 0) {
            console.warn('[RT Monitor] Bundle had 0 valid frames; per-frame fallback');
            // Clean up null placeholders before fallback
            animFrameLayers = [];
            frameHasError = [];
            _revokeActiveFrameBlobUrls();
            _initDetailMapJPGPerFrame(storm, satLayerName);
            return;
        }

        // Add every valid overlay to the map at once. Blob URLs are
        // in-memory references — Leaflet's 'load' event fires almost
        // immediately for each, no batching needed.
        for (var j = 0; j < animFrameLayers.length; j++) {
            if (!animFrameLayers[j]) {
                // Placeholder for a failed frame — count it as loaded with error
                onFrameLayerLoaded(j);
                continue;
            }
            (function (idx) {
                animFrameLayers[idx].once('error', function () {
                    frameHasError[idx] = true;
                    onFrameLayerLoaded(idx);
                });
                animFrameLayers[idx].once('load', function () {
                    onFrameLayerLoaded(idx);
                });
            })(j);
            animFrameLayers[j].addTo(detailMap);
        }

        var slider = document.getElementById('ir-anim-slider');
        if (slider) { slider.max = animFrameTimes.length - 1; slider.value = animIndex; }
        updateAnimCounter();
        updateFrameOverlay();

        console.log('[RT Monitor] Frames bundle: ' + goodCount + '/' + frames.length +
                    ' WebPs loaded as blob overlays (' + detailSatName + ', ' +
                    Math.round(buf.byteLength / 1024) + ' KB)');
    }

    /** Per-frame fallback: original behavior (one L.imageOverlay per frame
     *  pointed at /ir-frame.jpg, batched newest-first). Used when the
     *  bundle endpoint fails. */
    function _initDetailMapJPGPerFrame(storm, satLayerName) {
        if (!detailMap) return;
        var atcfId = storm.atcf_id;
        var metaUrl = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
            + '/ir-frames-meta'
            + '?lookback_hours=' + JPG_PRIMARY_LOOKBACK_H
            + '&radius_deg=' + JPG_PRIMARY_RADIUS_DEG
            + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;

        fetch(metaUrl, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('frames-meta HTTP ' + r.status);
                return r.json();
            })
            .then(function (meta) {
                // Guard against storm switch during the meta fetch
                if (currentStormId !== atcfId || !detailMap) return;
                _initDetailMapJPGWithMeta(storm, satLayerName, meta);
            })
            .catch(function (err) {
                console.warn('[RT Monitor] JPG per-frame path unavailable, falling back to GIBS:',
                             err && err.message);
                _jpgPathFellBack = true;
                _initDetailMapGIBS(storm, satLayerName);
            });
    }

    function _initDetailMapJPGWithMeta(storm, satLayerName, meta) {
        var atcfId = storm.atcf_id;
        var frames = (meta && meta.frames) || [];
        frames = _decimateFramesForMobile(frames);
        var bounds = meta && meta.bounds;
        if (!frames.length || !bounds) {
            console.warn('[RT Monitor] JPG meta returned no frames; falling back to GIBS');
            _jpgPathFellBack = true;
            _initDetailMapGIBS(storm, satLayerName);
            return;
        }

        // /ir-frames-meta returns frames oldest-first (index 0 = oldest,
        // index N-1 = most recent). Match the existing animFrame ordering.
        animFrameTimes = frames.map(function (f) { return f.datetime_utc; });
        animIndex = animFrameTimes.length - 1;

        if (meta.satellite) detailSatName = meta.satellite;

        // Create one L.imageOverlay per frame (opacity 0 until activated)
        for (var i = 0; i < frames.length; i++) {
            // Use the frame's intrinsic index (position in the server's
            // oldest-first frame_times) rather than the loop counter, so
            // the request stays correct after mobile decimation drops
            // frames. On desktop (no decimation) index === i.
            var serverIdx = (frames[i] && frames[i].index != null) ? frames[i].index : i;
            // Place each frame at its OWN interpolated bounds (mirrors the
            // bundle path at fb = fh.bounds || bounds). Falling back to the
            // shared meta.bounds pinned every frame to the latest fix, which
            // detached the IR signature from the track as the storm moved
            // through the lookback window.
            var fb = (frames[i] && frames[i].bounds) || bounds;
            var leafletBounds = L.latLngBounds(
                L.latLng(fb[0][0], fb[0][1]),
                L.latLng(fb[1][0], fb[1][1])
            );
            var url = API_BASE
                + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
                + '/ir-frame.jpg'
                + '?frame_index=' + serverIdx
                + '&lookback_hours=' + JPG_PRIMARY_LOOKBACK_H
                + '&radius_deg=' + JPG_PRIMARY_RADIUS_DEG
                + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;
            var overlay = L.imageOverlay(url, leafletBounds, {
                opacity: 0,
                interactive: false,
                crossOrigin: true,
                // L.imageOverlay defaults to overlayPane (z-index 400) which
                // would render ON TOP of the label tile layer added to the
                // same pane later in initDetailMap. Force tilePane so the IR
                // frames sit above the basemap but BELOW labels/coastlines —
                // matching the stacking the GIBS L.tileLayer path produces.
                pane: 'tilePane'
            });
            frameHasError.push(false);
            animFrameLayers.push(overlay);
        }

        // Batched newest-first load (mirrors _initDetailMapGIBS so the
        // user sees the latest frame ASAP while older ones backfill).
        var FRAME_BATCH_SIZE = 3;
        var totalFrames = animFrameTimes.length;
        var loadOrder = [];
        for (var k = totalFrames - 1; k >= 0; k--) loadOrder.push(k);
        var _batchAdded = {};
        var _batchNextIdx = 0;
        var _errorCount = 0;
        var _swappedToGibs = false;

        function _maybeSwapToGibs() {
            if (_swappedToGibs) return;
            // Only consider swapping while early in the load — once most
            // frames are up, the user already sees imagery and a swap
            // would be visually disruptive.
            var seen = framesLoaded + _errorCount;
            if (seen < Math.min(3, totalFrames)) return;
            var errFrac = _errorCount / Math.max(1, seen);
            if (errFrac > JPG_FALLBACK_ERROR_THRESHOLD) {
                _swappedToGibs = true;
                _jpgPathFellBack = true;
                console.warn('[RT Monitor] JPG path: ' + _errorCount + '/' +
                             seen + ' frame errors — swapping to GIBS');
                cleanupFrameLayers();
                // cleanupFrameLayers leaves frameHasError/validFrames/_firstFrameShown
                // intact (they're not cleared on storm switch, only on init).
                // Reset them here so _initDetailMapGIBS starts from a clean slate.
                validFrames = [];
                frameHasError = [];
                _firstFrameShown = false;
                _initDetailMapGIBS(storm, satLayerName);
            }
        }

        function _addNextBatch() {
            if (_swappedToGibs) return;
            var added = 0;
            while (_batchNextIdx < loadOrder.length && added < FRAME_BATCH_SIZE) {
                var fi = loadOrder[_batchNextIdx];
                _batchNextIdx++;
                if (_batchAdded[fi]) continue;
                _batchAdded[fi] = true;
                animFrameLayers[fi].addTo(detailMap);
                (function (idx) {
                    animFrameLayers[idx].once('error', function () {
                        frameHasError[idx] = true;
                        _errorCount++;
                        onFrameLayerLoaded(idx);
                        _maybeSwapToGibs();
                        _addNextBatch();
                    });
                    animFrameLayers[idx].once('load', function () {
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

        console.log('[RT Monitor] JPG primary: ' + totalFrames + ' WebP frame overlays (' +
                    detailSatName + ')');
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
            // Render vectors (track, graticule, storm marker) via Canvas
            // rather than SVG. html2canvas mis-positions Leaflet's SVG
            // overlay pane when the map has been panned (which the
            // per-frame recenter does), shifting the track in saved PNGs
            // even though it's correct on screen; a Canvas-rendered layer
            // is captured at the right position. (Verified: SVG centroid
            // offset ~100px vs canvas under an identical pan.)
            preferCanvas: true,
            center: [storm.lat, storm.lon],
            // zoom 6 fills the storm-relative crop tightly to the viewport
            // (the IR cutout is ±10° around the storm, ~2200 km wide;
            // zoom 5 left visible basemap margins around the cropped
            // imagery). zoom 6 keeps the storm centered without leaving
            // empty background showing.
            zoom: 6,
            minZoom: 3,
            maxZoom: GIBS_VIS_MAX_ZOOM,
            zoomControl: true,
            attributionControl: false
        });

        // Dark basemap
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19
        }).addTo(detailMap);

        // Lat/lon graticule — default ON for the storm card. Storm-relative
        // framing makes a reference grid genuinely useful (the imagery
        // moves with the storm; the grid stays anchored to real lat/lon).
        _detailEnableGraticule();
        var _gridBtn = document.getElementById('ir-detail-grid-toggle');
        if (_gridBtn) _gridBtn.classList.add('active');

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

        // ── Pre-rendered WebPs (primary) ──────────────────────
        // Single ~60 KB WebP per frame from /ir-frame.jpg (Mercator-warped
        // server-side, prewarmed every 5 min into GCS). One request per
        // frame instead of ~16 GIBS tiles. Auto-falls-back to GIBS on
        // /ir-frames-meta failure or excessive image-load errors.
        _jpgPathFellBack = false;
        _initDetailMapJPG(storm, satLayerName);

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
        // Extrapolated pin so it tracks the convection in the loop —
        // same dead-reckoning the backend uses to crop the IR cutout.
        var pinPos = _extrapolateStormPin(storm);
        L.circleMarker([pinPos.lat, pinPos.lon], {
            radius: 8, color: color, fillColor: color,
            fillOpacity: 0.7, weight: 2
        }).addTo(detailMap);

        // Fetch and draw past track on detail map
        detailTrackLayers = [];
        var stormCopy = storm;
        fetchStormMetadata(storm.atcf_id, function (metaErr, meta) {
            if (!metaErr && meta && meta.intensity_history && meta.intensity_history.length >= 2) {
                drawTrackOnMap(detailMap, meta.intensity_history, stormCopy,
                               detailTrackLayers, _extrapolateStormPin(stormCopy));
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
        cleanupVisFrameLayers();
        cleanupWvFrameLayers();
        _clearSurfaceObs();
        // Intensity Forecast is a model artifact — keep it hidden until the
        // user explicitly clicks Models. Otherwise switching storms would
        // expose a stale (or empty) forecast panel.
        var _intResetSec = document.getElementById('ir-intensity-section');
        if (_intResetSec) _intResetSec.style.display = 'none';
        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        var visBtnNew = document.getElementById('ir-product-vis');
        var wvBtnNew = document.getElementById('ir-product-wv');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
        if (geoBtn) geoBtn.classList.remove('ir-product-active');
        if (visBtnNew) visBtnNew.classList.remove('ir-product-active');
        if (wvBtnNew) wvBtnNew.classList.remove('ir-product-active');

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

        // Update URL hash for deep linking. Preserve the satellite-tab
        // marker when the card is the Sat tab's landing view, so reload
        // / share keeps the user on the tab they were on.
        if (window.history && window.history.replaceState) {
            var _view = document.documentElement.getAttribute('data-view');
            var _newHash = (_view === 'satellite')
                ? '#satellite&storm=' + atcfId
                : '#' + atcfId;
            window.history.replaceState(null, '', 'realtime_ir.html' + _newHash);
        }

        // Hide map view, show detail
        document.getElementById('ir-main').style.display = 'none';
        document.getElementById('ir-legend').style.display = 'none';
        var detailEl = document.getElementById('ir-detail');
        detailEl.style.display = 'block';

        // Populate the in-tab storm picker (so users can switch storms
        // without leaving the card).
        _populateDetailStormPicker(atcfId);

        // Populate header
        var cat = storm.category || windToCategory(storm.vmax_kt);
        var color = SS_COLORS[cat] || SS_COLORS.TD;
        document.getElementById('ir-detail-name').textContent = storm.name || 'UNNAMED';
        document.getElementById('ir-detail-id').textContent = storm.atcf_id;
        var reconEl = document.getElementById('ir-detail-recon');
        if (reconEl) reconEl.style.display = storm.has_recon ? '' : 'none';
        var catEl = document.getElementById('ir-detail-cat');
        catEl.textContent = categoryShort(cat) + (storm.vmax_kt != null ? ' \u00B7 ' + storm.vmax_kt + ' kt' : '');
        catEl.style.background = color;
        catEl.title = 'Saffir-Simpson category from 1-min sustained wind (kt). '
            + 'TD <34 \u00B7 TS 34\u201363 \u00B7 Cat1 64\u201382 \u00B7 Cat2 83\u201395 \u00B7 Cat3 96\u2013112 \u00B7 Cat4 113\u2013136 \u00B7 Cat5 137+';

        // Populate info grid
        document.getElementById('ir-info-basin').textContent = storm.basin || '\u2014';
        document.getElementById('ir-info-position').textContent = fmtLatLon(storm.lat, storm.lon);
        document.getElementById('ir-info-motion').textContent =
            storm.motion_deg != null ? storm.motion_deg + '\u00B0 at ' + (storm.motion_kt || '\u2014') + ' kt' : '\u2014';
        document.getElementById('ir-info-mslp').textContent =
            storm.mslp_hpa != null ? storm.mslp_hpa + ' hPa' : '\u2014';
        document.getElementById('ir-info-vmax').textContent =
            storm.vmax_kt != null ? storm.vmax_kt + ' kt (' + categoryShort(cat) + ')' : '\u2014';
        var lastfixEl = document.getElementById('ir-info-lastfix');
        if (lastfixEl) {
            var ago = _fmtAgo(storm.last_fix_utc);
            var tMs = Date.parse(storm.last_fix_utc);
            var staleMin = isFinite(tMs) ? (Date.now() - tMs) / 60000 : 0;
            lastfixEl.textContent = fmtUTC(storm.last_fix_utc);
            if (ago) {
                var agoSpan = document.createElement('span');
                agoSpan.className = 'ir-lastfix-ago' + (staleMin > _LASTFIX_STALE_MIN ? ' stale' : '');
                agoSpan.textContent = ' · ' + ago;
                if (staleMin > _LASTFIX_STALE_MIN) {
                    agoSpan.title = 'This fix is several hours old — the plotted position may no longer be current.';
                }
                lastfixEl.appendChild(agoSpan);
            }
        }

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
    var _rtCoreShearCache = {};    // Helmholtz 0–400 km core shear per storm
    var _rtShearProfileCache = {}; // /shear-profile (Helmholtz by-layer) per storm

    /** Inline arrow SVG pointing the way the shear blows. heading_deg is
     *  "toward" (0° = north = up); rotating an up-arrow clockwise by the
     *  heading aims it correctly. */
    function _shearArrowSvg(headingDeg) {
        var rot = (typeof headingDeg === 'number' && isFinite(headingDeg)) ? headingDeg : 0;
        return '<svg class="ir-shear-arrow" viewBox="0 0 24 24" width="12" height="12" ' +
            'style="transform:rotate(' + rot.toFixed(0) + 'deg);" aria-hidden="true">' +
            '<path d="M12 4 L12 20 M12 4 L7.5 9 M12 4 L16.5 9"/></svg>';
    }

    /** Compact "NN kt ↗ DIR" markup for a shear value object. */
    function _shearValueHtml(j) {
        if (!j || j.magnitude_kt == null) return '&mdash;';
        return j.magnitude_kt.toFixed(0) + ' kt ' + _shearArrowSvg(j.heading_deg) +
            ' <span style="opacity:.7;">' + _compassDir(j.heading_deg) + '</span>';
    }

    /**
     * Fetch GFS-derived shear for the active storm — TWO views:
     *   • Env shear  : SHIPS 200–800 km annulus, 850–200 hPa (the wider
     *     environment the storm sits in).
     *   • Core shear : Helmholtz vortex-removed 0–400 km, 850–200 hPa (the
     *     shear actually felt at the storm core).
     * Paints both Storm Info rows with a direction arrow; the env response
     * also carries the annular profile cached for the Env Profile reveal.
     * Quiet on failure — rows fall back to "—".
     */
    function loadStormShear(atcfId) {
        var el = document.getElementById('ir-info-shear');
        var elCore = document.getElementById('ir-info-shear-core');
        if (!el) return;

        // Env (SHIPS annulus) — also drives the Skew-T / profile reveal.
        fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) + '/shear')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                if (!j || currentStormId !== atcfId) return;
                _rtEnvCache[atcfId] = j;
                el.innerHTML = _shearValueHtml(j);
                el.title = 'GFS 0.25° analysis ' + (j.gfs_cycle_utc || '') + '\n' +
                    '850–200 hPa shear, 200–800 km annulus (environmental)\n' +
                    'heading ' + Math.round(j.heading_deg) + '° (toward)\n' +
                    'u200/v200: ' + j.u200_ms + '/' + j.v200_ms + ' m/s\n' +
                    'u850/v850: ' + j.u850_ms + '/' + j.v850_ms + ' m/s';
                var panel = document.getElementById('rt-env-panel');
                if (panel && panel.style.display !== 'none') {
                    _rtRenderEnvProfile(j);
                }
            })
            .catch(function () {
                if (currentStormId === atcfId) {
                    el.innerHTML = '&mdash;';
                    el.title = 'Shear unavailable';
                }
            });

        // Core (Helmholtz, vortex-removed, 0–400 km, same 850–200 layer).
        if (elCore) {
            elCore.textContent = '…';
            fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) +
                  '/shear?method=helmholtz&lower_hpa=850&upper_hpa=200&eval_km=400&mask_km=500')
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    if (!j || currentStormId !== atcfId) return;
                    _rtCoreShearCache[atcfId] = j;
                    elCore.innerHTML = _shearValueHtml(j);
                    elCore.title = 'GFS 0.25° analysis ' + (j.gfs_cycle_utc || '') + '\n' +
                        '850–200 hPa shear, Helmholtz decomposition\n' +
                        'vortex removed within 500 km; shear averaged over 0–400 km core\n' +
                        'heading ' + Math.round(j.heading_deg) + '° (toward)\n' +
                        (j.magnitude_center_kt != null
                            ? 'center cell: ' + j.magnitude_center_kt + ' kt' : '');
                })
                .catch(function () {
                    if (currentStormId === atcfId) {
                        elCore.innerHTML = '&mdash;';
                        elCore.title = 'Core shear unavailable';
                    }
                });
        }
    }

    /** Lazy-load + render the Helmholtz shear-by-layer heatmap when the
     *  Env Profile panel opens (heavier backend compute than the row
     *  values, so we defer it). Cached per storm. */
    function _rtLoadShearProfile(atcfId) {
        var el = document.getElementById('rt-env-shear-grid');
        if (!el || !atcfId) return;
        if (_rtShearProfileCache[atcfId]) {
            _rtRenderShearProfile(_rtShearProfileCache[atcfId]);
            return;
        }
        // eval_km=400 / mask_km=500 match the Core shear headline, so the
        // profile's 850→200 cell equals the displayed 0–400 km core value.
        fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) +
              '/shear-profile?eval_km=400&mask_km=500')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                if (!j || currentStormId !== atcfId) return;
                _rtShearProfileCache[atcfId] = j;
                _rtRenderShearProfile(j);
            })
            .catch(function () { /* leave the container empty on failure */ });
    }

    // Fixed 0–40 kt shear scale so the heatmap reads the same across every
    // storm (cross-storm context). Four hue classes at the 10/20/30 kt
    // thresholds — blue / yellow / orange / red — but each band ramps
    // light→dark WITHIN itself so neighboring values (e.g. 22 vs 28 kt) are
    // still distinguishable. Duplicated stops keep the class boundaries
    // crisp; values ≥40 kt clamp to dark red.
    var _SHEAR_PROFILE_ZMAX = 40;
    var _SHEAR_PROFILE_COLORSCALE = [
        [0.00, '#93c5fd'],   // 0 kt   — blue (light)
        [0.25, '#1d4ed8'],   // 10 kt  — blue (deep)
        [0.25, '#fef08a'],   // 10 kt  — yellow (light)
        [0.50, '#ca8a04'],   // 20 kt  — gold (deep)
        [0.50, '#fdba74'],   // 20 kt  — orange (light)
        [0.75, '#c2410c'],   // 30 kt  — orange (deep)
        [0.75, '#f87171'],   // 30 kt  — red (light)
        [1.00, '#7f1d1d'],   // 40 kt+ — dark red
    ];

    /** Build a scatter trace of arrow markers (one per valid cell) showing
     *  the shear heading ("toward") for each (bottom, top) layer. Drawn as a
     *  scatter OVERLAY rather than layout annotations: arrow annotations make
     *  Plotly silently drop the heatmap fill. marker.angle is measured
     *  clockwise from straight up, so it equals the compass "toward" heading
     *  1:1 (0°=N=up, 90°=E=right). hoverinfo:'skip' lets the heatmap keep its
     *  kt/heading tooltip. */
    function _shearProfileArrowTrace(prof, color, lineColor, size) {
        var xs = [], ys = [], ang = [];
        if (prof && prof.heading_deg) {
            var hdg = prof.heading_deg, mag = prof.magnitude_kt || [];
            for (var ti = 0; ti < hdg.length; ti++) {
                var row = hdg[ti] || [];
                for (var bi = 0; bi < row.length; bi++) {
                    var h = row[bi], m = mag[ti] ? mag[ti][bi] : null;
                    if (h == null || m == null) continue;
                    xs.push(String(prof.bottoms_hpa[bi]));
                    ys.push(String(prof.tops_hpa[ti]));
                    ang.push(h);
                }
            }
        }
        return {
            type: 'scatter', mode: 'markers', x: xs, y: ys,
            marker: {
                symbol: 'arrow', angle: ang, angleref: 'up',
                size: size || 12, color: color,
                line: { width: 0.6, color: lineColor },
            },
            hoverinfo: 'skip', showlegend: false,
        };
    }

    /** Plotly heatmap: x = layer bottom (hPa), y = layer top (hPa),
     *  color = Helmholtz 0–400 km env-shear magnitude (kt), fixed 0–40 kt.
     *  Arrows in each cell show the shear heading ("toward"). */
    function _rtRenderShearProfile(prof) {
        var el = document.getElementById('rt-env-shear-grid');
        if (!el || !prof || !prof.magnitude_kt || typeof Plotly === 'undefined') return;
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var axisCol = isDark ? '#8b9ec2' : '#374151';
        var gridCol = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,22,35,0.08)';
        var arrowCol = isDark ? '#e5e7eb' : '#111827';
        var arrowLine = isDark ? 'rgba(15,23,42,0.7)' : 'rgba(248,250,252,0.85)';
        Plotly.newPlot(el, [{
            type: 'heatmap',
            z: prof.magnitude_kt,
            x: prof.bottoms_hpa.map(String),
            y: prof.tops_hpa.map(String),
            customdata: prof.heading_deg,
            colorscale: _SHEAR_PROFILE_COLORSCALE,
            zmin: 0, zmax: _SHEAR_PROFILE_ZMAX,  // fixed scale for cross-storm comparison
            zsmooth: false,
            hoverongaps: false,
            colorbar: {
                title: { text: 'kt', font: { size: 9, color: axisCol } },
                tickfont: { size: 8, color: axisCol }, thickness: 12,
                tickmode: 'array',
                tickvals: [0, 10, 20, 30, 40],
                ticktext: ['0', '10', '20', '30', '40+'],
            },
            hovertemplate: 'bottom %{x} hPa → top %{y} hPa<br>' +
                           '%{z:.1f} kt · toward %{customdata:.0f}°<extra></extra>',
        }, _shearProfileArrowTrace(prof, arrowCol, arrowLine, 12)], {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            margin: { l: 52, r: 8, t: 24, b: 44 },
            font: { family: 'DM Sans, sans-serif', color: axisCol, size: 9 },
            title: {
                text: 'Deep-layer shear by layer (0–400 km, Helmholtz)',
                font: { size: 10, color: axisCol }, x: 0.5, y: 0.99,
            },
            xaxis: {
                title: { text: 'Layer bottom (hPa)', font: { size: 9, color: axisCol } },
                type: 'category', color: axisCol, tickfont: { size: 8 },
                gridcolor: gridCol,
            },
            yaxis: {
                title: { text: 'Layer top (hPa)', font: { size: 9, color: axisCol } },
                type: 'category', color: axisCol, tickfont: { size: 8 },
                gridcolor: gridCol,
            },
        }, { responsive: true, displayModeBar: false });
    }

    /** Save the shear-by-layer heatmap as a publication PNG in the current
     *  theme, with full provenance baked in (storm, GFS analysis cycle
     *  time, method) + a TC-ATLAS watermark. Clones the live figure so the
     *  on-screen plot is untouched. */
    window._irSaveShearProfile = function () {
        var chartEl = document.getElementById('rt-env-shear-grid');
        if (!chartEl || !chartEl.data || !chartEl.data.length || typeof Plotly === 'undefined') {
            console.warn('[RT Monitor] No shear-by-layer figure to export');
            return;
        }
        _ga('ir_export_shear_profile', { storm: currentStormId });

        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var bgColor   = isDark ? '#0f172a' : '#ffffff';
        var textColor = isDark ? '#e2e8f0' : '#1e293b';
        var axisColor = isDark ? '#94a3b8' : '#475569';
        var wmColor   = isDark ? '#64748b' : '#94a3b8';

        var prof = _rtShearProfileCache[currentStormId] || {};
        var stormName = (document.getElementById('ir-detail-name') || {}).textContent || '';
        var stormId = currentStormId || '';
        var cycle = prof.gfs_cycle_utc || '';
        var cycleFmt = (cycle.length >= 13)
            ? cycle.substring(0, 4) + '-' + cycle.substring(5, 7) + '-' +
              cycle.substring(8, 10) + ' ' + cycle.substring(11, 13) + 'Z'
            : '';
        var fix = prof.last_fix_utc || '';
        var fixFmt = (fix.length >= 13)
            ? fix.substring(5, 7) + '/' + fix.substring(8, 10) + ' ' + fix.substring(11, 13) + 'Z'
            : '';
        var evalKm = prof.eval_km != null ? Math.round(prof.eval_km) : 400;
        var maskKm = prof.mask_km != null ? Math.round(prof.mask_km) : 500;

        var title = 'Deep-layer Shear by Layer — ' + (stormName && stormId
            ? stormName + ' (' + stormId + ')' : (stormName || stormId || 'Storm'));
        var subtitle = 'Helmholtz environmental shear · vortex removed within ' + maskKm +
                       ' km · averaged over 0–' + evalKm + ' km core · arrows: shear direction (toward)';
        var srcLine = (prof.source || 'GFS 0.25° analysis') +
                      (cycleFmt ? ' · analysis ' + cycleFmt : '') +
                      (fixFmt ? '   ·   storm fix ' + fixFmt : '');

        var data = JSON.parse(JSON.stringify(chartEl.data));
        var layout = JSON.parse(JSON.stringify(chartEl.layout));
        layout.title = {
            text: title,
            font: { size: 16, color: textColor, family: 'DM Sans, sans-serif' },
            x: 0.5, xanchor: 'center', y: 0.975,
        };
        layout.paper_bgcolor = bgColor;
        layout.plot_bgcolor = bgColor;
        layout.font = { family: 'DM Sans, sans-serif', size: 13, color: axisColor };
        layout.margin = { l: 74, r: 30, t: 104, b: 96 };
        layout.width = 900;
        layout.height = 660;
        if (layout.xaxis) {
            layout.xaxis.tickfont = { size: 12, color: axisColor };
            if (layout.xaxis.title) layout.xaxis.title.font = { size: 14, color: textColor };
        }
        if (layout.yaxis) {
            layout.yaxis.tickfont = { size: 12, color: axisColor };
            if (layout.yaxis.title) layout.yaxis.title.font = { size: 14, color: textColor };
        }
        if (data[0] && data[0].colorbar) {
            data[0].colorbar.tickfont = { size: 12, color: axisColor };
            data[0].colorbar.title = { text: 'kt', font: { size: 13, color: textColor } };
            data[0].colorbar.thickness = 16;
        }
        // Enlarge the per-cell shear arrows for the larger export canvas.
        data.forEach(function (t) {
            if (t.type === 'scatter' && t.marker && t.marker.symbol === 'arrow') {
                t.marker.size = (t.marker.size || 12) * 1.8;
                if (t.marker.line) t.marker.line.width = (t.marker.line.width || 0.6) * 1.6;
            }
        });
        layout.annotations = (layout.annotations || []).concat([
            { text: subtitle, xref: 'paper', yref: 'paper', x: 0.5, y: 1.085,
              showarrow: false, xanchor: 'center', yanchor: 'bottom',
              font: { size: 12, color: axisColor, family: 'DM Sans, sans-serif' } },
            { text: srcLine, xref: 'paper', yref: 'paper', x: 0.5, y: 1.025,
              showarrow: false, xanchor: 'center', yanchor: 'bottom',
              font: { size: 11, color: axisColor, family: 'DM Sans, sans-serif' } },
            { text: 'TC-ATLAS', xref: 'paper', yref: 'paper', x: 0, y: -0.135,
              showarrow: false, xanchor: 'left', yanchor: 'top',
              font: { size: 11, color: wmColor, family: 'DM Sans, sans-serif' } },
            { text: 'michaelfischerwx.github.io/TC-ATLAS', xref: 'paper', yref: 'paper',
              x: 1, y: -0.135, showarrow: false, xanchor: 'right', yanchor: 'top',
              font: { size: 11, color: wmColor, family: 'DM Sans, sans-serif' } },
        ]);

        var tmpDiv = document.createElement('div');
        tmpDiv.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
        document.body.appendChild(tmpDiv);
        Plotly.newPlot(tmpDiv, data, layout, { displayModeBar: false }).then(function () {
            return Plotly.toImage(tmpDiv, {
                format: 'png', width: layout.width, height: layout.height, scale: 3
            });
        }).then(function (dataUrl) {
            var a = document.createElement('a');
            a.href = dataUrl;
            a.download = (stormId || 'storm') + '_shear_by_layer' +
                         (cycle ? '_' + cycle.replace(/[:\-T]/g, '').replace('Z', '').slice(0, 10) : '') +
                         '_' + (isDark ? 'dark' : 'light') + '.png';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            Plotly.purge(tmpDiv); document.body.removeChild(tmpDiv);
        }).catch(function (err) {
            console.warn('[RT Monitor] Shear profile export failed:', err);
            if (tmpDiv.parentNode) { Plotly.purge(tmpDiv); document.body.removeChild(tmpDiv); }
        });
    };

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
        // Lazy-load the Helmholtz shear-by-layer heatmap (heavier compute).
        _rtLoadShearProfile(currentStormId);
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

        var reconEl = document.getElementById('ir-detail-recon');
        if (reconEl) reconEl.style.display = storm.has_recon ? '' : 'none';

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
    function closeStormDetail(opts) {
        var skipTabRoute = !!(opts && opts.skipTabRoute);
        currentStormId = null;
        stopAnimation();

        // Clean up model overlay
        _rtRemoveModelOverlay();
        _rtRemoveAscatOverlay();
        _rtRemoveRadarOverlay();

        // Reset product state
        cleanupGeocolorFrameLayers();
        cleanupVisFrameLayers();
        cleanupWvFrameLayers();
        rawTbFrames = [];
        productMode = 'eir';

        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        var visBtnReset = document.getElementById('ir-product-vis');
        var wvBtnReset = document.getElementById('ir-product-wv');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
        if (geoBtn) geoBtn.classList.remove('ir-product-active');
        if (visBtnReset) visBtnReset.classList.remove('ir-product-active');
        if (wvBtnReset) wvBtnReset.classList.remove('ir-product-active');
        var tbLegend = document.getElementById('ir-tb-legend');
        if (tbLegend) tbLegend.style.display = 'none';
        var wvLegend = document.getElementById('ir-wv-legend');
        if (wvLegend) wvLegend.style.display = 'none';

        // Clean up pre-loaded frame layers
        cleanupFrameLayers();

        // Clean up detail mini-map
        if (detailMap) {
            // Detach graticule listeners before tearing the map down so
            // moveend/zoomend callbacks don't fire against a dead map.
            _detailDisableGraticule();
            detailMap.remove();
            detailMap = null;
        }
        _detailGraticule = null;
        var detailMapDiv = document.getElementById('ir-detail-map');
        if (detailMapDiv) detailMapDiv.style.display = 'none';

        // If the user is on the Storm Satellite tab when the back button
        // fires, route through the tab system so we land on the Map tab
        // properly (resets data-view, tab indicators, hash). Otherwise
        // the legacy in-place close (Map tab → hide card, show map).
        // Callers can pass {skipTabRoute:true} to do the cleanup without
        // changing tabs (used by "Loop Only" which manages the view itself).
        var _activeView = document.documentElement.getAttribute('data-view');
        document.getElementById('ir-detail').style.display = 'none';
        if (!skipTabRoute && _activeView === 'satellite' && typeof window.switchIRView === 'function') {
            window.switchIRView('map');
            _ga('ir_close_detail');
            return;
        }

        // Update URL — but only when this is a real close (going back
        // to the map). Loop Only / soft-close callers manage the hash
        // themselves and we'd just stomp on the Sat-tab marker.
        if (!skipTabRoute && window.history && window.history.replaceState) {
            window.history.replaceState(null, '', 'realtime_ir.html');
        }

        // Hide detail, show map
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
        // Name the channel (matches the Vis/WV/GeoColor labels) so the
        // saved image always states what's shown, even with the product
        // toggle stripped from the export.
        if (_elSatLabel) _elSatLabel.textContent = 'Infrared — ' + (detailSatName || 'GIBS IR');
    }

    /** Show a specific frame by toggling opacity (instant — no tile fetching) */
    /** Pan the detail map so the active frame's storm stays at viewport
     *  center (co-moving view). With geographic framing each frame is
     *  placed at its own true bounds, so without this the storm drifts
     *  across the viewport as the loop plays (its true position moves
     *  ~1°+ over a 6 h loop). Recentering on the shown frame keeps the
     *  storm centered AND keeps the best-track dots locked to it (both
     *  imagery and dots are in true geographic coordinates).
     *
     *  Only fires on frame changes, so a paused user can pan/zoom freely
     *  — their view persists until they scrub or resume the loop. */
    function _recenterDetailToFrame(layer) {
        if (!detailMap || !layer || typeof layer.getBounds !== 'function') return;
        try {
            var c = layer.getBounds().getCenter();
            var cur = detailMap.getCenter();
            // Skip a no-op setView (avoids needless tile churn).
            if (Math.abs(cur.lat - c.lat) < 1e-4 && Math.abs(cur.lng - c.lng) < 1e-4) return;
            detailMap.setView(c, detailMap.getZoom(), { animate: false });
        } catch (e) {}
    }

    function showFrame(idx) {
        if (idx < 0 || idx >= animFrameLayers.length || !detailMap) return;
        // Bundle path may leave null placeholders for frames that failed
        // server-side; skip them rather than throwing on .setOpacity().
        if (!animFrameLayers[idx]) return;

        // Ensure this frame + the lookahead are decoded, evict the rest.
        _applyDecodeWindow(animFrameLayers, idx);

        // Show the NEW frame first so the basemap never peeks through
        // during the swap. Doing setOpacity(0) on the old frame first
        // causes a single-frame "white flash" on mobile (the browser
        // commits the opacity-0 paint before the opacity-1 paint).
        //
        // Fully opaque: the IR overlay sits in tilePane directly on top
        // of the plain light-gray `light_nolabels` basemap. The old
        // 0.85 let that gray bleed through and washed the IR colors out
        // (a milky haze). Coastlines (z450), labels + graticule
        // (overlayPane z400) all render ABOVE the IR, so opacity 1.0
        // loses no reference context — it just makes the IR crisp.
        var prevIdx = animIndex;
        animIndex = idx;
        animFrameLayers[idx].setOpacity(1.0);

        // Now hide the previously-shown frame.
        if (prevIdx >= 0 && prevIdx !== idx && prevIdx < animFrameLayers.length
                && animFrameLayers[prevIdx]) {
            animFrameLayers[prevIdx].setOpacity(0);
        }

        // Keep the storm centered as the frame's true position moves.
        _recenterDetailToFrame(animFrameLayers[idx]);

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
        if (productMode === 'vis') {
            return {
                valid: visValidFrames,
                layers: visFrameLayers,
                times: visFrameTimes,
                ready: visFramesReady,
                showFn: showVisFrame
            };
        }
        if (productMode === 'wv') {
            return {
                valid: wvValidFrames,
                layers: wvFrameLayers,
                times: wvFrameTimes,
                ready: wvFramesReady,
                showFn: showWvFrame
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

    /** Playback speed multipliers, ordered slow → fast. 1× = legacy
     *  500 ms / frame. Stepping with the −/+ buttons cycles through this
     *  list; the chosen multiplier scales animIntervalMs.
     *
     *  Default depends on viewport: desktop starts at 4× because at 1×
     *  the loop feels sluggish on a fast machine and most users
     *  immediately bump it up. Mobile starts at 2× — the per-frame
     *  paint cost is higher there and 4× can stutter on weaker GPUs.
     *  The −/+ controls let users tune from 0.25× to 8× either way. */
    var ANIM_SPEED_STEPS = [0.25, 0.5, 1, 2, 4, 8];
    var ANIM_BASE_INTERVAL_MS = 500;
    var _IS_MOBILE_VIEWPORT = (typeof window !== 'undefined') &&
                              (window.innerWidth || 9999) < 768;
    // ANIM_SPEED_STEPS indices: 0=0.25×, 1=0.5×, 2=1×, 3=2×, 4=4×, 5=8×
    var animSpeedIdx = _IS_MOBILE_VIEWPORT ? 3 : 4;

    function _applyAnimSpeed() {
        var mult = ANIM_SPEED_STEPS[animSpeedIdx] || 1;
        animIntervalMs = Math.round(ANIM_BASE_INTERVAL_MS / mult);
        var lbl = document.getElementById('ir-anim-speed-label');
        if (lbl) {
            // Use × for integer multipliers, drop trailing zeros for fractions
            lbl.textContent = (mult >= 1 ? mult : mult.toString()) + '×';
        }
        var dn = document.getElementById('ir-anim-speed-down');
        var up = document.getElementById('ir-anim-speed-up');
        if (dn) dn.disabled = (animSpeedIdx <= 0);
        if (up) up.disabled = (animSpeedIdx >= ANIM_SPEED_STEPS.length - 1);
    }

    function bumpAnimSpeed(dir) {
        animSpeedIdx = Math.max(0, Math.min(ANIM_SPEED_STEPS.length - 1, animSpeedIdx + dir));
        _applyAnimSpeed();
        _ga('ir_anim_speed', { mult: ANIM_SPEED_STEPS[animSpeedIdx] });
    }

    /** Toggle play/pause */
    function togglePlay() {
        if (animPlaying) {
            stopAnimation();
        } else {
            startAnimation();
        }
    }

    /** rAF tick for detail animation. Holds the LAST valid frame for an
     *  extra dwell time so the viewer can orient before the loop restarts
     *  — a standard "pause at present" cue (Tropical Tidbits, MIMIC, etc).
     *  Multiplier scales with the player speed so 4× still gets a longer
     *  pause than every other frame, but is also shorter in wall-clock. */
    var ANIM_LAST_FRAME_PAUSE_MULT = 6;  // last frame held 6× normal interval (longer dwell so viewers can orient on the present)
    function _animTick(ts) {
        if (!animPlaying) return;
        var state = activeFrameState();
        var atLast = state && state.valid && state.valid.length > 0 &&
                     state.valid[state.valid.length - 1] === animIndex;
        var interval = atLast
            ? animIntervalMs * ANIM_LAST_FRAME_PAUSE_MULT
            : animIntervalMs;
        if (ts - animLastTick >= interval) {
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
        // If the DeepMind ensemble forecast is already rendered (the
        // richer per-tau percentile-bands view), don't stomp it with the
        // simpler best-track history line. Best-track is a fallback for
        // storms without WeatherLab coverage.
        if (_rtWeatherlabData) return;
        // We're rendering history (no forecast). Reflect that in the heading.
        var heading = document.getElementById('ir-intensity-heading');
        if (heading) heading.textContent = 'Intensity History';
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
                tickfont: { size: 9, color: '#5b6573', family: 'DM Sans, sans-serif' },
                tickformat: '%m/%d %Hz'
            },
            yaxis: {
                title: { text: 'Vmax (kt)', font: { size: 10, color: '#5b6573', family: 'DM Sans, sans-serif' } },
                gridcolor: 'rgba(255,255,255,0.04)',
                tickfont: { size: 9, color: '#5b6573', family: 'DM Sans, sans-serif' }
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
        var btnMap = {
            eir:      document.getElementById('ir-product-eir'),
            geocolor: document.getElementById('ir-product-geocolor'),
            vis:      document.getElementById('ir-product-vis'),
            wv:       document.getElementById('ir-product-wv')
        };
        for (var k in btnMap) {
            if (btnMap[k]) btnMap[k].classList.toggle('ir-product-active', mode === k);
        }

        // Show/hide legends — IR Tb gradient for 'eir', WV gradient for 'wv',
        // none for visible/GeoColor (those carry pre-rendered NASA colorbars).
        var tbLeg = document.getElementById('ir-tb-legend');
        if (tbLeg) tbLeg.style.display = (mode === 'eir') ? 'block' : 'none';
        var wvLeg = document.getElementById('ir-wv-legend');
        if (wvLeg) wvLeg.style.display = (mode === 'wv') ? 'block' : 'none';

        // --- Deactivate previous mode ---
        stopAnimation();
        if (prevMode === 'eir')           hideAllAnimFrames();
        else if (prevMode === 'geocolor') hideAllGeocolorFrames();
        else if (prevMode === 'vis')      hideAllVisFrames();
        else if (prevMode === 'wv')       hideAllWvFrames();

        // Mobile only: free the leaving product's decoded bitmaps so just
        // one product is resident at a time (prevents the IR→Vis/SWIR OOM
        // crash). Returning to a product re-decodes from its kept blobs —
        // no refetch. Restore the incoming product's frames here when NOT
        // in windowed mode; in windowed mode the show call's decode-window
        // re-decodes only what's needed.
        if (_IS_MOBILE_VIEWPORT && prevMode !== mode) {
            _evictProductFrames(_productLayers(prevMode));
            if (!_WINDOWED_DECODE) _restoreProductFrames(_productLayers(mode));
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
        } else if (mode === 'vis') {
            loadVisFrames();
        } else if (mode === 'wv') {
            loadWvFrames();
        }
    }

    /** Hide all IR animation frame layers */
    function hideAllAnimFrames() {
        for (var i = 0; i < animFrameLayers.length; i++) {
            if (!animFrameLayers[i]) continue;  // null bundle-fail placeholder
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

    /** Single-shot binary bundle path: one /ir-raw-bundle request returns
     *  all frames packed as [u32 header_len][JSON header][concat uint8 Tb].
     *  ~3-4× faster than the 13-request waterfall on warm cache, single
     *  TLS round-trip, no per-frame Cloud Run overhead. Returns a Promise
     *  that resolves to an array of frame objects matching the shape
     *  produced by the incremental path, or rejects on any failure so
     *  the caller can fall back to incremental fetching. */
    function _fetchRawTbBundle(stormId, signal) {
        var apiUrl = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/ir-raw-bundle'
            + '?lookback_hours=' + DEFAULT_LOOKBACK_HOURS
            + '&radius_deg=' + DEFAULT_RADIUS_DEG
            + '&interval_min=' + RAW_TB_INTERVAL_MIN;
        // Try direct-from-GCS (prewarmed, no Cloud Run hop) first.
        // Fall through to the API endpoint on miss / fresh storms.
        var gcsUrl = _gcsRawBundleUrl(stormId);
        return fetch(gcsUrl, { signal: signal })
            .then(function (r) {
                if (!r.ok) throw new Error('gcs raw bundle HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') throw err;
                return fetch(apiUrl, { signal: signal }).then(function (r) {
                    if (!r.ok) throw new Error('api raw bundle HTTP ' + r.status);
                    return r.arrayBuffer();
                });
            })
            .then(function (buf) {
                if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
                var dv = new DataView(buf);
                if (buf.byteLength < 4) throw new Error('bundle too small');
                var headerLen = dv.getUint32(0, true);  // little-endian
                if (4 + headerLen > buf.byteLength) throw new Error('bundle header overruns body');
                var headerBytes = new Uint8Array(buf, 4, headerLen);
                var headerJson = new TextDecoder('utf-8').decode(headerBytes);
                var header = JSON.parse(headerJson);
                var binBase = 4 + headerLen;
                var frames = [];
                var failed = 0;
                for (var i = 0; i < header.frames.length; i++) {
                    var fh = header.frames[i];
                    if (!fh.byte_length || fh.error) {
                        failed++;
                        continue;
                    }
                    // Slice into the buffer with NO copy — Uint8Array is a view
                    var tb = new Uint8Array(buf, binBase + fh.byte_offset, fh.byte_length);
                    frames.push({
                        tb_data: tb,
                        rows: fh.tb_rows,
                        cols: fh.tb_cols,
                        bounds: fh.bounds,
                        datetime_utc: fh.datetime_utc || '',
                        satellite: fh.satellite || '',
                        tb_vmin: header.tb_vmin || 160.0,
                        tb_vmax: header.tb_vmax || 330.0,
                        center_fix: fh.center_fix || null
                    });
                }
                return { frames: frames, total: header.total_frames, failed: failed };
            });
    }

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

        // ── Primary path: single binary bundle ────────────────
        // Try the packed bundle endpoint first; on any failure (404 if
        // backend not yet redeployed, parse error, network) fall through
        // to the legacy per-frame incremental waterfall below.
        if (!silent) showLoadingProgress(true, 5);
        _fetchRawTbBundle(stormId, controller.signal)
            .then(function (result) {
                if (controller.signal.aborted) return;
                var pos = _stormPositionForId(stormId);
                _rawTbCache[stormId] = {
                    rawTbFrames: result.frames, cachedAt: Date.now(),
                    lat: pos ? pos.lat : null, lon: pos ? pos.lon : null
                };
                if (stormId === currentStormId) rawTbFrames = result.frames;
                console.log('[RT Monitor] Raw Tb bundle loaded for ' + stormId +
                    ': ' + result.frames.length + ' OK, ' + result.failed + ' failed');
                if (!silent) showLoadingProgress(false);
                _fireRtReadyCallbacks(stormId);
                if (_rawTbAbortController === controller) _rawTbAbortController = null;
                if (onComplete) onComplete();
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') return;
                console.warn('[RT Monitor] Raw Tb bundle failed (' +
                    (err && err.message) + ') — falling back to incremental');
                _fetchRawTbIncrementalLegacy(stormId, silent, controller, onComplete);
            });
    }

    /** Legacy per-frame waterfall (kept as bundle-failure fallback). */
    function _fetchRawTbIncrementalLegacy(stormId, silent, controller, onComplete) {
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
                + '&interval_min=' + RAW_TB_INTERVAL_MIN;

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
                + '&interval_min=' + RAW_TB_INTERVAL_MIN;

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

    /** Track blob URLs minted from the GeoColor bundle so we can revoke
     *  them on storm-switch / cleanup. */
    var _activeGeocolorBlobUrls = [];

    /** Clean up GeoColor frame layers from the map */
    function cleanupGeocolorFrameLayers() {
        for (var i = 0; i < geocolorFrameLayers.length; i++) {
            if (detailMap && geocolorFrameLayers[i]) {
                detailMap.removeLayer(geocolorFrameLayers[i]);
            }
        }
        for (var b = 0; b < _activeGeocolorBlobUrls.length; b++) {
            try { URL.revokeObjectURL(_activeGeocolorBlobUrls[b]); } catch (e) {}
        }
        _activeGeocolorBlobUrls = [];
        geocolorFrameLayers = [];
        geocolorFrameTimes = [];
        geocolorValidFrames = [];
        geocolorFrameHasError = [];
        geocolorFramesLoaded = 0;
        geocolorFramesReady = false;
    }

    /** Load GeoColor animation frames from the backend bundle.
     *
     *  Replaces the legacy GIBS-tile path that did its own day/night
     *  Himawari switching in JS. The backend now produces a single
     *  per-frame bundle that handles the solar-elevation switch
     *  (Band 2 visible by day, Band 13 IR inverted-grayscale at night)
     *  and emits storm-relative-cropped WebPs ready for L.imageOverlay.
     *  Wire format mirrors the IR / band bundles so the parser is the
     *  same. GCS direct (publicRead) is tried first; the API endpoint
     *  is the fallback for storms whose bundle hasn't been prewarmed
     *  (currently always — GeoColor prewarm is deferred). */
    var _GCS_GEOCOLOR_BUNDLE_BASE =
        _GCS_BUCKET_ROOT + '/' + _RT_BUNDLE_VERSION + '/bundles/geocolor';

    function loadGeocolorFrames() {
        if (!detailMap || !currentStormId) return;

        // Already loaded → restore slider and show the latest frame.
        if (geocolorFramesReady && geocolorFrameLayers.length > 0) {
            var sliderR = document.getElementById('ir-anim-slider');
            if (sliderR && geocolorValidFrames.length > 0) {
                sliderR.max = geocolorValidFrames.length - 1;
                sliderR.value = geocolorValidFrames.length - 1;
            }
            var playBtnR = document.getElementById('ir-anim-play');
            if (playBtnR) playBtnR.disabled = false;
            showGeocolorFrame(geocolorValidFrames.length > 0
                ? geocolorValidFrames[geocolorValidFrames.length - 1]
                : geocolorFrameLayers.length - 1);
            updateAnimCounter();
            return;
        }
        // Bundle still in flight → bail.
        if (geocolorFrameLayers.length > 0 && !geocolorFramesReady) return;

        geocolorFrameTimes = [];
        geocolorFramesLoaded = 0;
        geocolorFramesReady = false;
        geocolorValidFrames = [];
        geocolorFrameHasError = [];

        var geoBtn = document.getElementById('ir-product-geocolor');
        if (geoBtn) { geoBtn.classList.add('ir-loading'); geoBtn.textContent = 'Loading…'; }
        showLoadingProgress(true, 0);

        var satLbl = document.getElementById('ir-satellite-label');
        if (satLbl) satLbl.textContent = 'GeoColor — ' + detailSatName;

        var atcfId = currentStormId;
        var gcsUrl = _GCS_GEOCOLOR_BUNDLE_BASE + '/' +
                     encodeURIComponent(atcfId.toUpperCase()) + '.bin';
        var apiUrl = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
            + '/geocolor-frames-bundle?lookback_hours=' + JPG_PRIMARY_LOOKBACK_H
            + '&radius_deg=' + JPG_PRIMARY_RADIUS_DEG
            + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;

        fetch(gcsUrl)
            .then(function (r) {
                if (!r.ok) throw new Error('GCS ' + r.status);
                return r.arrayBuffer();
            })
            .catch(function () {
                // GCS miss is the expected path right now (no prewarm).
                return fetch(apiUrl).then(function (r) {
                    if (!r.ok) throw new Error('API ' + r.status);
                    return r.arrayBuffer();
                });
            })
            .then(function (buf) {
                if (currentStormId !== atcfId || productMode !== 'geocolor') return;
                _ingestGeocolorBundle(buf);
            })
            .catch(function (err) {
                console.warn('[RT Monitor] GeoColor bundle unavailable:', err && err.message);
                if (geoBtn) { geoBtn.classList.remove('ir-loading'); geoBtn.textContent = 'GeoColor'; }
                showLoadingProgress(false);
                if (productMode === 'geocolor') setProductMode('eir');
            });
    }

    /** Parse the GeoColor bundle and create L.imageOverlay frame layers. */
    function _ingestGeocolorBundle(buf) {
        var dv;
        var header;
        var binBase;
        try {
            dv = new DataView(buf);
            if (buf.byteLength < 4) throw new Error('bundle too small');
            var headerLen = dv.getUint32(0, true);
            if (4 + headerLen > buf.byteLength) throw new Error('header overruns body');
            var headerBytes = new Uint8Array(buf, 4, headerLen);
            header = JSON.parse(new TextDecoder('utf-8').decode(headerBytes));
            binBase = 4 + headerLen;
        } catch (e) {
            console.warn('[RT Monitor] GeoColor bundle parse failed:', e.message);
            if (productMode === 'geocolor') setProductMode('eir');
            return;
        }

        var frames = (header && header.frames) || [];
        frames = _decimateFramesForMobile(frames);
        if (!frames.length) {
            console.warn('[RT Monitor] GeoColor bundle had no frames');
            if (productMode === 'geocolor') setProductMode('eir');
            return;
        }

        // Geographic framing: each frame placed at its own bounds so
        // track dots / coastlines align to the storm in every frame.
        // Mirrors the IR bundle behavior. Fallback: bundle-level bounds.
        var fallbackUb = header.bounds || null;
        // Sanity check: at least one frame (or the bundle) must carry bounds.
        var anyBounds = !!fallbackUb;
        if (!anyBounds) {
            for (var li = 0; li < frames.length; li++) {
                if (frames[li].bounds) { anyBounds = true; break; }
            }
        }
        if (!anyBounds) {
            console.warn('[RT Monitor] GeoColor bundle missing bounds');
            if (productMode === 'geocolor') setProductMode('eir');
            return;
        }

        var mediaType = header.media_type || 'image/webp';
        var loaded = 0;
        var goodCount = 0;
        var geoBtn = document.getElementById('ir-product-geocolor');

        function finalize() {
            geocolorFramesReady = true;
            geocolorFramesLoaded = frames.length;
            showLoadingProgress(false);
            if (geoBtn) { geoBtn.classList.remove('ir-loading'); geoBtn.textContent = 'GeoColor'; }
            var playBtnF = document.getElementById('ir-anim-play');
            if (playBtnF) playBtnF.disabled = (geocolorValidFrames.length === 0);
            var sliderF = document.getElementById('ir-anim-slider');
            if (sliderF && geocolorValidFrames.length > 0) {
                sliderF.max = geocolorValidFrames.length - 1;
                sliderF.value = geocolorValidFrames.length - 1;
                if (productMode === 'geocolor') {
                    showGeocolorFrame(geocolorValidFrames[geocolorValidFrames.length - 1]);
                }
            }
            updateAnimCounter();
            console.log('[RT Monitor] GeoColor bundle: ' + goodCount + '/' + frames.length +
                        ' WebPs loaded (' + (buf.byteLength / 1024 | 0) + ' KB, ' +
                        (header.n_day_frames || 0) + ' day, ' +
                        (header.n_night_frames || 0) + ' night)');
        }

        for (var i = 0; i < frames.length; i++) {
            var fh = frames[i];
            geocolorFrameTimes.push(fh.datetime_utc);
            if (!fh.byte_length || fh.error) {
                geocolorFrameLayers.push(null);
                geocolorFrameHasError.push(true);
                loaded++;
                continue;
            }
            var slice = new Uint8Array(buf, binBase + fh.byte_offset, fh.byte_length);
            var blob = new Blob([slice], { type: mediaType });
            var blobUrl = URL.createObjectURL(blob);
            _activeGeocolorBlobUrls.push(blobUrl);
            var fb = fh.bounds || fallbackUb;
            var fBounds = L.latLngBounds(
                L.latLng(fb[0][0], fb[0][1]), L.latLng(fb[1][0], fb[1][1]));
            var overlay = L.imageOverlay(blobUrl, fBounds, {
                opacity: 0, interactive: false, pane: 'tilePane'
            });
            overlay._frameBlobUrl = blobUrl; // for windowed decode promote/evict
            geocolorFrameHasError.push(false);
            (function (lyr, idx) {
                lyr.once('error', function () {
                    geocolorFrameHasError[idx] = true; loaded++;
                    if (loaded >= frames.length) finalize();
                });
                lyr.once('load', function () {
                    if (!geocolorFrameHasError[idx]) {
                        geocolorValidFrames.push(idx);
                        geocolorValidFrames.sort(function (a, b) { return a - b; });
                        goodCount++;
                    }
                    loaded++;
                    var pct = Math.round((loaded / frames.length) * 100);
                    showLoadingProgress(true, pct);
                    if (loaded >= frames.length) finalize();
                });
            })(overlay, i);
            geocolorFrameLayers.push(overlay);
            overlay.addTo(detailMap);
        }
        if (loaded >= frames.length) finalize();
    }

    // (kept for reference — the GIBS-tile path; superseded by the bundle
    //  loader above but left present for now in case a future fallback
    //  wants to revive it.)
    function loadGeocolorFrames_LEGACY_GIBS_UNUSED() {
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

        _applyDecodeWindow(geocolorFrameLayers, idx);

        // Show new BEFORE hiding old to avoid the mobile white-flash.
        var prevIdx = animIndex;
        animIndex = idx;
        if (geocolorFrameLayers[idx]) geocolorFrameLayers[idx].setOpacity(0.92);

        for (var i = 0; i < geocolorFrameLayers.length; i++) {
            if (i !== idx && geocolorFrameLayers[i]) {
                geocolorFrameLayers[i].setOpacity(0);
            }
        }

        _recenterDetailToFrame(geocolorFrameLayers[idx]);

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
    //  VISIBLE + WATER VAPOR PRODUCT PIPELINES
    //  GIBS tile-layer based, parallel to GeoColor. Frame times mirror
    //  the IR frame times so the slider/scrubber are interchangeable
    //  across product modes.
    // ═══════════════════════════════════════════════════════════

    function hideAllVisFrames() {
        for (var i = 0; i < visFrameLayers.length; i++) {
            if (visFrameLayers[i]) visFrameLayers[i].setOpacity(0);
        }
    }
    function hideAllWvFrames() {
        for (var i = 0; i < wvFrameLayers.length; i++) {
            if (wvFrameLayers[i]) wvFrameLayers[i].setOpacity(0);
        }
    }
    function cleanupVisFrameLayers() {
        for (var i = 0; i < visFrameLayers.length; i++) {
            if (detailMap && visFrameLayers[i]) detailMap.removeLayer(visFrameLayers[i]);
        }
        for (var b = 0; b < _activeVisBlobUrls.length; b++) {
            try { URL.revokeObjectURL(_activeVisBlobUrls[b]); } catch (e) {}
        }
        _activeVisBlobUrls = [];
        visFrameLayers = []; visFrameTimes = []; visValidFrames = [];
        visFrameHasError = []; visFramesLoaded = 0; visFramesReady = false;
    }
    function cleanupWvFrameLayers() {
        for (var i = 0; i < wvFrameLayers.length; i++) {
            if (detailMap && wvFrameLayers[i]) detailMap.removeLayer(wvFrameLayers[i]);
        }
        for (var b = 0; b < _activeWvBlobUrls.length; b++) {
            try { URL.revokeObjectURL(_activeWvBlobUrls[b]); } catch (e) {}
        }
        _activeWvBlobUrls = [];
        wvFrameLayers = []; wvFrameTimes = []; wvValidFrames = [];
        wvFrameHasError = []; wvFramesLoaded = 0; wvFramesReady = false;
    }

    /** Track blob URLs we create from band bundles so we can revoke them on
     *  cleanup (avoid leaking gigabytes of WebP data across storm switches). */
    var _activeVisBlobUrls = [];
    var _activeWvBlobUrls = [];

    /** Shared loader for the per-band WebP bundles. `band` is 2 (Visible) or
     *  8 (Water Vapor). Mirrors the IR frames-bundle path: fetch the .bin
     *  from GCS, parse header + payload offsets, slice the buffer into
     *  Blob → L.imageOverlay layers, animate them via the standard
     *  scrubber by toggling opacity. */
    function _loadBandFramesBundle(band, productKey) {
        if (!detailMap || !currentStormId) return;

        // Both Band 2 (Vis) and Band 7 (SWIR) share the 'vis' product
        // bucket on the frontend — SWIR is the nighttime fallback for
        // the Visible button. WV is its own bucket.
        var isVis = (productKey === 'vis');  // 'isVis' = vis-product bucket
        var stateLayers = isVis ? visFrameLayers : wvFrameLayers;
        var stateTimes  = isVis ? visFrameTimes  : wvFrameTimes;
        var stateValid  = isVis ? visValidFrames : wvValidFrames;
        var blobBucket  = isVis ? _activeVisBlobUrls : _activeWvBlobUrls;
        var btnId       = isVis ? 'ir-product-vis' : 'ir-product-wv';
        var label       = isVis ? 'Visible' : 'WV';
        var fullLabel;
        if (band === 8)      fullLabel = 'Water Vapor';
        else if (band === 7) fullLabel = 'Visible (SWIR night)';
        else                 fullLabel = 'Visible';

        // Already loaded → just restore slider and show latest frame.
        var readyFlag = isVis ? visFramesReady : wvFramesReady;
        if (readyFlag && stateLayers.length > 0) {
            var slider = document.getElementById('ir-anim-slider');
            if (slider && stateValid.length > 0) {
                slider.max = stateValid.length - 1;
                slider.value = stateValid.length - 1;
            }
            var playBtn = document.getElementById('ir-anim-play');
            if (playBtn) playBtn.disabled = false;
            var showFn = isVis ? showVisFrame : showWvFrame;
            showFn(stateValid.length > 0 ? stateValid[stateValid.length - 1] : stateLayers.length - 1);
            updateAnimCounter();
            return;
        }
        // Already loading → bail
        if (stateLayers.length > 0 && !readyFlag) return;

        // Reset state
        if (isVis) {
            visFrameTimes = []; visFramesLoaded = 0; visFramesReady = false;
            visValidFrames = []; visFrameHasError = [];
        } else {
            wvFrameTimes = []; wvFramesLoaded = 0; wvFramesReady = false;
            wvValidFrames = []; wvFrameHasError = [];
        }

        var btn = document.getElementById(btnId);
        if (btn) { btn.classList.add('ir-loading'); btn.textContent = 'Loading…'; }
        showLoadingProgress(true, 0);

        var satLabel = document.getElementById('ir-satellite-label');
        if (satLabel) satLabel.textContent = fullLabel + ' — ' + detailSatName;

        var gcsUrl = _gcsBandBundleUrl(currentStormId, band);
        // API fallback when the prewarmed GCS bundle is missing (typical
        // when this band isn't the one currently prewarmed for the storm —
        // e.g. Vis at night, WV during daytime).
        var apiUrl = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(currentStormId)
                   + '/band-frames-bundle?band=' + band;
        var stormIdAtFetch = currentStormId;

        fetch(gcsUrl)
            .then(function (r) {
                if (!r.ok) throw new Error('GCS bundle HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .catch(function () {
                // GCS miss — assemble fresh via the API.
                return fetch(apiUrl)
                    .then(function (r) {
                        if (!r.ok) throw new Error('API bundle HTTP ' + r.status);
                        return r.arrayBuffer();
                    });
            })
            .then(function (buf) {
                // Storm switched while we were fetching — drop the result.
                if (stormIdAtFetch !== currentStormId || productMode !== productKey) return;
                _ingestBandBundle(buf, band, productKey);
            })
            .catch(function (err) {
                console.warn('[RT Monitor] Band ' + band + ' bundle unavailable:', err.message);
                if (btn) { btn.classList.remove('ir-loading'); btn.textContent = label; }
                showLoadingProgress(false);
                if (productMode === productKey) setProductMode('eir');
            });
    }

    function _ingestBandBundle(buf, band, productKey) {
        var isVis = (productKey === 'vis');  // covers band 2 and band 7
        var blobBucket = isVis ? _activeVisBlobUrls : _activeWvBlobUrls;
        var label      = isVis ? 'Visible' : 'WV';
        var btnId      = isVis ? 'ir-product-vis' : 'ir-product-wv';
        var fullLabel;
        if (band === 8)      fullLabel = 'Water Vapor';
        else if (band === 7) fullLabel = 'Visible (SWIR night)';
        else                 fullLabel = 'Visible';

        var dv = new DataView(buf);
        var header;
        var binBase;
        try {
            if (buf.byteLength < 4) throw new Error('bundle too small');
            var headerLen = dv.getUint32(0, true);
            if (4 + headerLen > buf.byteLength) throw new Error('header overruns body');
            var headerBytes = new Uint8Array(buf, 4, headerLen);
            header = JSON.parse(new TextDecoder('utf-8').decode(headerBytes));
            binBase = 4 + headerLen;
        } catch (e) {
            console.warn('[RT Monitor] Band ' + band + ' bundle parse failed:', e.message);
            if (productMode === productKey) setProductMode('eir');
            return;
        }

        var frames = (header && header.frames) || [];
        frames = _decimateFramesForMobile(frames);
        if (!frames.length) {
            console.warn('[RT Monitor] Band ' + band + ' bundle had no frames');
            if (productMode === productKey) setProductMode('eir');
            return;
        }

        // Geographic framing: each frame placed at its own bounds so
        // track dots / coastlines align with the storm in every frame.
        // Mirrors the IR + GeoColor bundle behavior.
        var fallbackUb = header.bounds || null;
        var anyBounds = !!fallbackUb;
        if (!anyBounds) {
            for (var li = 0; li < frames.length; li++) {
                if (frames[li].bounds) { anyBounds = true; break; }
            }
        }
        if (!anyBounds) {
            console.warn('[RT Monitor] Band ' + band + ' bundle missing bounds');
            if (productMode === productKey) setProductMode('eir');
            return;
        }

        var mediaType = header.media_type || 'image/webp';
        var times = [];
        var hasErr = [];
        var layers = [];
        var validIdx = [];
        var loaded = 0;
        var goodCount = 0;

        var btn = document.getElementById(btnId);

        function finalize() {
            if (isVis) {
                visFrameTimes = times; visFrameLayers = layers; visFrameHasError = hasErr;
                visValidFrames = validIdx; visFramesReady = true; visFramesLoaded = frames.length;
            } else {
                wvFrameTimes = times; wvFrameLayers = layers; wvFrameHasError = hasErr;
                wvValidFrames = validIdx; wvFramesReady = true; wvFramesLoaded = frames.length;
            }
            showLoadingProgress(false);
            if (btn) { btn.classList.remove('ir-loading'); btn.textContent = label; }
            var playBtn = document.getElementById('ir-anim-play');
            if (playBtn) playBtn.disabled = (validIdx.length === 0);
            var slider = document.getElementById('ir-anim-slider');
            if (slider && validIdx.length > 0) {
                slider.max = validIdx.length - 1;
                slider.value = validIdx.length - 1;
                var showFn = isVis ? showVisFrame : showWvFrame;
                showFn(validIdx[validIdx.length - 1]);
            }
            updateAnimCounter();
            // If nothing came back (all nighttime for Vis, or upstream gap
            // for WV), tell the user instead of leaving them on a blank pane.
            if (validIdx.length === 0) {
                // Vis Band 2 with 0 valid frames → auto-fallback to SWIR
                // (Band 7). Covers two real cases: (a) most of the loop
                // window is dark even though "now" is daylight at the
                // storm, and (b) all Himawari Vis L1b cold fetches timed
                // out so the bundle came back empty. SWIR is 24/7 and
                // gives the user a usable visible-like view either way.
                if (isVis && band === 2) {
                    console.warn('[RT Monitor] Vis (Band 2) returned 0 valid frames; falling back to SWIR (Band 7)');
                    // Tear down state so _loadBandFramesBundle doesn't
                    // short-circuit on the "already loading" guard, and
                    // we don't leak the (empty) vis-2 blob set.
                    cleanupVisFrameLayers();
                    _loadBandFramesBundle(7, 'vis');
                    return;
                }
                var satLbl = document.getElementById('ir-satellite-label');
                var msg = isVis
                    ? 'No usable visible/SWIR frames available right now — try Water Vapor or IR.'
                    : 'No Water Vapor frames available right now — try IR or GeoColor.';
                if (satLbl) satLbl.textContent = msg;
                console.warn('[RT Monitor] Band ' + band + ' bundle had 0 valid frames');
            } else {
                console.log('[RT Monitor] Band ' + band + ' bundle: ' + goodCount + '/' + frames.length +
                            ' WebPs loaded (' + (buf.byteLength / 1024 | 0) + ' KB)');
            }
        }

        for (var i = 0; i < frames.length; i++) {
            var fh = frames[i];
            times.push(fh.datetime_utc);
            if (!fh.byte_length || fh.error) {
                layers.push(null);
                hasErr.push(true);
                loaded++;
                continue;
            }
            var slice = new Uint8Array(buf, binBase + fh.byte_offset, fh.byte_length);
            var blob = new Blob([slice], { type: mediaType });
            var blobUrl = URL.createObjectURL(blob);
            blobBucket.push(blobUrl);
            var fb = fh.bounds || fallbackUb;
            var fBounds = L.latLngBounds(
                L.latLng(fb[0][0], fb[0][1]), L.latLng(fb[1][0], fb[1][1]));
            var overlay = L.imageOverlay(blobUrl, fBounds, {
                opacity: 0, interactive: false, pane: 'tilePane'
            });
            overlay._frameBlobUrl = blobUrl; // for windowed decode promote/evict
            hasErr.push(false);
            (function (lyr, idx) {
                lyr.once('error', function () {
                    hasErr[idx] = true; loaded++;
                    if (loaded >= frames.length) finalize();
                });
                lyr.once('load', function () {
                    if (!hasErr[idx]) {
                        validIdx.push(idx);
                        validIdx.sort(function (a, b) { return a - b; });
                        goodCount++;
                    }
                    loaded++;
                    var pct = Math.round((loaded / frames.length) * 100);
                    showLoadingProgress(true, pct);
                    if (loaded >= frames.length) finalize();
                });
            })(overlay, i);
            layers.push(overlay);
            overlay.addTo(detailMap);
        }

        // If every frame was an error-stub (e.g. all nighttime for Vis), finalize now.
        if (loaded >= frames.length) finalize();
    }

    // ── Visible↔SWIR per-frame composite ──────────────────────────
    // The Visible panel should show TRUE visible imagery for daytime
    // frames and SWIR (3.9 µm, nighttime "visible-like") for dark frames,
    // so a loop spanning sunset transitions Vis→SWIR instead of locking to
    // whichever band it was at "now". The backend already classifies this:
    // the Band 2 (Vis) bundle marks night frames as error-stubs (per-frame
    // solar test in _build_and_upload_bundles), and the Band 7 (SWIR)
    // bundle is complete 24/7. We fetch both and, per frame, keep the Vis
    // image where it's valid (daytime) and fall back to SWIR where it
    // isn't. Frames are matched by timestamp so a stale Vis bundle (whose
    // frames fall outside the current window) is simply ignored.
    function _parseBundleHeader(buf) {
        var dv = new DataView(buf);
        if (buf.byteLength < 4) throw new Error('bundle too small');
        var headerLen = dv.getUint32(0, true);
        if (4 + headerLen > buf.byteLength) throw new Error('header overruns body');
        var headerBytes = new Uint8Array(buf, 4, headerLen);
        return { header: JSON.parse(new TextDecoder('utf-8').decode(headerBytes)),
                 binBase: 4 + headerLen };
    }

    function _fetchBandBundleBuf(stormId, band) {
        var gcsUrl = _gcsBandBundleUrl(stormId, band);
        var apiUrl = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId)
                   + '/band-frames-bundle?band=' + band;
        return fetch(gcsUrl)
            .then(function (r) { if (!r.ok) throw new Error('gcs ' + r.status); return r.arrayBuffer(); })
            .catch(function () {
                return fetch(apiUrl).then(function (r) {
                    if (!r.ok) throw new Error('api ' + r.status); return r.arrayBuffer();
                });
            });
    }

    /** Load the Visible panel as a per-frame Vis(day)↔SWIR(night) blend. */
    function _loadVisSwirComposite() {
        if (!detailMap || !currentStormId) return;
        // Already loaded → restore slider + show latest.
        if (visFramesReady && visFrameLayers.length > 0) {
            var sliderR = document.getElementById('ir-anim-slider');
            if (sliderR && visValidFrames.length > 0) {
                sliderR.max = visValidFrames.length - 1;
                sliderR.value = visValidFrames.length - 1;
            }
            var playBtnR = document.getElementById('ir-anim-play');
            if (playBtnR) playBtnR.disabled = (visValidFrames.length === 0);
            showVisFrame(visValidFrames.length > 0
                ? visValidFrames[visValidFrames.length - 1]
                : visFrameLayers.length - 1);
            updateAnimCounter();
            return;
        }
        // Already loading → bail.
        if (visFrameLayers.length > 0 && !visFramesReady) return;

        visFrameTimes = []; visFramesLoaded = 0; visFramesReady = false;
        visValidFrames = []; visFrameHasError = [];

        var btn = document.getElementById('ir-product-vis');
        if (btn) { btn.classList.add('ir-loading'); btn.textContent = 'Loading…'; }
        showLoadingProgress(true, 0);
        var satLabel = document.getElementById('ir-satellite-label');
        if (satLabel) satLabel.textContent = 'Visible — ' + detailSatName;

        var stormIdAtFetch = currentStormId;
        Promise.all([
            _fetchBandBundleBuf(currentStormId, 2).catch(function () { return null; }),
            _fetchBandBundleBuf(currentStormId, 7).catch(function () { return null; })
        ]).then(function (bufs) {
            if (stormIdAtFetch !== currentStormId || productMode !== 'vis') return;
            if (!bufs[0] && !bufs[1]) {
                console.warn('[RT Monitor] Vis + SWIR bundles both unavailable; back to IR');
                if (btn) { btn.classList.remove('ir-loading'); btn.textContent = 'Visible'; }
                showLoadingProgress(false);
                setProductMode('eir');
                return;
            }
            _ingestVisSwirComposite(bufs[0], bufs[1]);
        });
    }

    function _ingestVisSwirComposite(visBuf, swirBuf) {
        var visP = null, swirP = null;
        try { if (visBuf)  visP  = _parseBundleHeader(visBuf); }  catch (e) {}
        try { if (swirBuf) swirP = _parseBundleHeader(swirBuf); } catch (e) {}
        if (!visP && !swirP) { if (productMode === 'vis') setProductMode('eir'); return; }

        // Index Vis frames by timestamp; SWIR (complete 24/7) is the
        // canonical timeline (fall back to the Vis timeline if SWIR missing).
        var visByDt = {};
        if (visP) {
            var vfList = visP.header.frames || [];
            for (var a = 0; a < vfList.length; a++) visByDt[vfList[a].datetime_utc] = vfList[a];
        }
        var baseFrames = (swirP && swirP.header.frames) || (visP && visP.header.frames) || [];
        var globalBounds = (swirP && swirP.header.bounds) || (visP && visP.header.bounds) || null;
        var visMedia  = visP  ? (visP.header.media_type  || 'image/webp') : 'image/webp';
        var swirMedia = swirP ? (swirP.header.media_type || 'image/webp') : 'image/webp';

        // Per frame: prefer a valid Vis image (daytime), else SWIR.
        var merged = [];
        for (var k = 0; k < baseFrames.length; k++) {
            var sf = baseFrames[k];
            var dt = sf.datetime_utc;
            var vfr = visByDt[dt];
            if (visP && vfr && vfr.byte_length && !vfr.error) {
                merged.push({ datetime_utc: dt, bounds: vfr.bounds || sf.bounds || globalBounds,
                              buf: visBuf, base: visP.binBase, byte_offset: vfr.byte_offset,
                              byte_length: vfr.byte_length, mediaType: visMedia, source: 'vis' });
            } else if (swirP && sf.byte_length && !sf.error) {
                // SWIR fallback. It's only a true *night* frame when the sun is
                // actually down; a daytime Band-2 gap (upstream scan miss,
                // marked "no_data") is still daylight and should read "(SWIR)"
                // not "(SWIR night)". Trust the server's solar-gated label when
                // present ("nighttime"), else compute solar elevation locally so
                // the label is correct even if the Vis bundle is absent.
                var swirNight;
                if (vfr && vfr.error === 'nighttime') {
                    swirNight = true;
                } else if (vfr && vfr.error) {
                    swirNight = false;   // daytime gap (no_data / anomalous)
                } else {
                    var fb0 = sf.bounds || globalBounds;
                    var clat = fb0 ? (fb0[0][0] + fb0[1][0]) / 2 : detailStormLat;
                    var clon = fb0 ? (fb0[0][1] + fb0[1][1]) / 2 : detailStormLon;
                    swirNight = solarElevation(clat, clon, new Date(dt)) < -6;
                }
                merged.push({ datetime_utc: dt, bounds: sf.bounds || globalBounds,
                              buf: swirBuf, base: swirP.binBase, byte_offset: sf.byte_offset,
                              byte_length: sf.byte_length, mediaType: swirMedia,
                              source: 'swir', swirNight: swirNight });
            } else {
                merged.push({ datetime_utc: dt, bounds: sf.bounds || globalBounds,
                              buf: null, source: 'none' });
            }
        }
        merged = _decimateFramesForMobile(merged);
        if (!merged.length) { if (productMode === 'vis') setProductMode('eir'); return; }

        var times = [], hasErr = [], layers = [], validIdx = [];
        var goodCount = 0, loaded = 0;

        function finalize() {
            visFrameTimes = times; visFrameLayers = layers; visFrameHasError = hasErr;
            visValidFrames = validIdx; visFramesReady = true; visFramesLoaded = merged.length;
            showLoadingProgress(false);
            var fbtn = document.getElementById('ir-product-vis');
            if (fbtn) { fbtn.classList.remove('ir-loading'); fbtn.textContent = 'Visible'; }
            var playBtn = document.getElementById('ir-anim-play');
            if (playBtn) playBtn.disabled = (validIdx.length === 0);
            var slider = document.getElementById('ir-anim-slider');
            if (slider && validIdx.length > 0) {
                slider.max = validIdx.length - 1;
                slider.value = validIdx.length - 1;
                showVisFrame(validIdx[validIdx.length - 1]);
            }
            updateAnimCounter();
            if (validIdx.length === 0) {
                var satLbl = document.getElementById('ir-satellite-label');
                if (satLbl) satLbl.textContent =
                    'No usable visible/SWIR frames available right now — try Water Vapor or IR.';
                console.warn('[RT Monitor] Vis/SWIR composite had 0 valid frames');
            } else {
                var nVis = 0, nSwir = 0;
                for (var z = 0; z < merged.length; z++) {
                    if (merged[z].source === 'vis') nVis++;
                    else if (merged[z].source === 'swir') nSwir++;
                }
                console.log('[RT Monitor] Vis/SWIR composite: ' + validIdx.length + '/' +
                            merged.length + ' frames (' + nVis + ' vis, ' + nSwir + ' swir)');
            }
        }

        for (var i = 0; i < merged.length; i++) {
            var m = merged[i];
            times.push(m.datetime_utc);
            if (!m.buf || !m.byte_length) {
                layers.push(null); hasErr.push(true); loaded++;
                continue;
            }
            var slice = new Uint8Array(m.buf, m.base + m.byte_offset, m.byte_length);
            var blob = new Blob([slice], { type: m.mediaType });
            var blobUrl = URL.createObjectURL(blob);
            _activeVisBlobUrls.push(blobUrl);
            var fb = m.bounds || globalBounds;
            var fBounds = L.latLngBounds(L.latLng(fb[0][0], fb[0][1]), L.latLng(fb[1][0], fb[1][1]));
            var overlay = L.imageOverlay(blobUrl, fBounds, {
                opacity: 0, interactive: false, pane: 'tilePane'
            });
            overlay._frameBlobUrl = blobUrl;       // windowed-decode promote/evict
            overlay._bandSource = m.source;        // 'vis' | 'swir' → per-frame label
            overlay._swirNight = m.swirNight;      // true → real night, false → daytime gap
            hasErr.push(false);
            (function (lyr, idx) {
                lyr.once('error', function () {
                    hasErr[idx] = true; loaded++;
                    if (loaded >= merged.length) finalize();
                });
                lyr.once('load', function () {
                    if (!hasErr[idx]) {
                        validIdx.push(idx);
                        validIdx.sort(function (x, y) { return x - y; });
                        goodCount++;
                    }
                    loaded++;
                    var pct = Math.round((loaded / merged.length) * 100);
                    showLoadingProgress(true, pct);
                    if (loaded >= merged.length) finalize();
                });
            })(overlay, i);
            layers.push(overlay);
            overlay.addTo(detailMap);
        }
        if (loaded >= merged.length) finalize();
    }

    /** Load the Visible panel. Blends true Visible (Band 2) for daytime
     *  frames with SWIR (Band 7, 3.9 µm) for nighttime frames, so a loop
     *  that straddles sunset transitions Vis→SWIR rather than showing one
     *  band for the whole loop (Tropical Tidbits' vis_swir style). */
    function loadVisFrames() {
        _loadVisSwirComposite();
    }

    function showVisFrame(idx) {
        if (idx < 0 || idx >= visFrameLayers.length || !detailMap) return;
        _applyDecodeWindow(visFrameLayers, idx);
        // Show new BEFORE hiding old to avoid the mobile white-flash.
        animIndex = idx;
        if (visFrameLayers[idx]) visFrameLayers[idx].setOpacity(0.92);
        for (var i = 0; i < visFrameLayers.length; i++) {
            if (i !== idx && visFrameLayers[i]) visFrameLayers[i].setOpacity(0);
        }
        _recenterDetailToFrame(visFrameLayers[idx]);
        if (visFrameTimes[idx]) {
            document.getElementById('ir-frame-time').textContent = fmtUTC(visFrameTimes[idx]);
        }
        // Per-frame label so the user sees the Vis→SWIR handover explicitly.
        var lyr = visFrameLayers[idx];
        var srcLabel = 'Visible';
        if (lyr && lyr._bandSource === 'swir') {
            // "(SWIR night)" only when it's really night; a daytime Band-2 gap
            // falls back to SWIR too but is still daylight → "(SWIR)".
            srcLabel = lyr._swirNight === false ? 'Visible (SWIR)' : 'Visible (SWIR night)';
        }
        document.getElementById('ir-satellite-label').textContent = srcLabel + ' — ' + detailSatName;
        if (_rtModelVisible && _rtModelAutoSync && _rtModelData) _rtSyncModelCycleToIR();
    }

    /** Load Water Vapor (Band 8) frames from the pre-rendered band bundle
     *  in GCS. Available 24/7 — every frame should be present in the bundle. */
    function loadWvFrames() {
        _loadBandFramesBundle(8, 'wv');
    }

    function showWvFrame(idx) {
        if (idx < 0 || idx >= wvFrameLayers.length || !detailMap) return;
        _applyDecodeWindow(wvFrameLayers, idx);
        // Show new BEFORE hiding old to avoid the mobile white-flash.
        animIndex = idx;
        if (wvFrameLayers[idx]) wvFrameLayers[idx].setOpacity(0.92);
        for (var i = 0; i < wvFrameLayers.length; i++) {
            if (i !== idx && wvFrameLayers[i]) wvFrameLayers[i].setOpacity(0);
        }
        _recenterDetailToFrame(wvFrameLayers[idx]);
        if (wvFrameTimes[idx]) {
            document.getElementById('ir-frame-time').textContent = fmtUTC(wvFrameTimes[idx]);
        }
        document.getElementById('ir-satellite-label').textContent = 'Water Vapor — ' + detailSatName;
        if (_rtModelVisible && _rtModelAutoSync && _rtModelData) _rtSyncModelCycleToIR();
    }

    // ═══════════════════════════════════════════════════════════
    //  DEEP LINKING
    // ═══════════════════════════════════════════════════════════

    var deepLinkHandled = false;

    /** Extract the deep-linked storm id from the URL hash. Handles both the
     *  compound form written by openStormDetail ("satellite&storm=WP062026",
     *  optionally with loop=1/detailed=1) and the legacy bare-id form
     *  ("WP062026"). Returns the ATCF id (upper-case) or null. */
    function _stormIdFromHash() {
        var hash = window.location.hash.replace(/^#/, '').trim();
        if (!hash) return null;
        var m = hash.match(/storm=([A-Za-z]{2}\d{6})/);
        if (m) return m[1].toUpperCase();
        // Legacy: the whole hash is just an ATCF id.
        if (/^[A-Za-z]{2}\d{6}$/.test(hash)) return hash.toUpperCase();
        return null;
    }

    /** Check URL hash for a deep-linked storm and open it (once active
     *  storm data is available). Retries on later calls until matched. */
    function handleDeepLink() {
        if (deepLinkHandled) return;
        var stormId = _stormIdFromHash();
        if (!stormId) return;

        // Check if storm exists in current data
        for (var i = 0; i < stormData.length; i++) {
            if ((stormData[i].atcf_id || '').toUpperCase() === stormId) {
                deepLinkHandled = true;
                openStormDetail(stormData[i].atcf_id);
                return;
            }
        }
        // Storm not in active list yet (still loading) or expired — a later
        // poll re-calls handleDeepLink, so we retry until it appears.
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
        var _spdDn = document.getElementById('ir-anim-speed-down');
        var _spdUp = document.getElementById('ir-anim-speed-up');
        if (_spdDn) _spdDn.addEventListener('click', function () { bumpAnimSpeed(-1); });
        if (_spdUp) _spdUp.addEventListener('click', function () { bumpAnimSpeed(+1); });
        _applyAnimSpeed();  // seed label + disabled states

        // Product toggle buttons (IR / GeoColor / Visible / Water Vapor)
        document.getElementById('ir-product-eir').addEventListener('click', function () {
            if (productMode === 'eir') return;
            setProductMode('eir');
        });
        document.getElementById('ir-product-geocolor').addEventListener('click', function () {
            if (productMode === 'geocolor') return;
            setProductMode('geocolor');
        });
        var visBtn = document.getElementById('ir-product-vis');
        if (visBtn) visBtn.addEventListener('click', function () {
            if (productMode === 'vis') return;
            setProductMode('vis');
        });
        var wvBtn = document.getElementById('ir-product-wv');
        if (wvBtn) wvBtn.addEventListener('click', function () {
            if (productMode === 'wv') return;
            setProductMode('wv');
        });
        // Browser back/forward
        window.addEventListener('popstate', function () {
            var stormId = _stormIdFromHash();
            if (stormId && (currentStormId || '').toUpperCase() !== stormId) {
                openStormDetail(stormId);
            } else if (!stormId && currentStormId) {
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

    /** Render the in-card storm picker. Hidden when only one storm is
     *  active (no choice to offer) — otherwise lists every active storm
     *  sorted by intensity, with the current one selected. */
    function _populateDetailStormPicker(currentId) {
        var sel = document.getElementById('ir-detail-storm-select');
        if (!sel) return;
        if (!stormData || stormData.length < 2) {
            sel.style.display = 'none';
            return;
        }
        var sorted = stormData.slice().sort(function (a, b) {
            return (b.vmax_kt || 0) - (a.vmax_kt || 0);
        });
        var opts = [];
        for (var i = 0; i < sorted.length; i++) {
            var s = sorted[i];
            var c = s.category || windToCategory(s.vmax_kt);
            var label = (s.atcf_id || '') + ' · ' + (s.name || 'UNNAMED') +
                        ' (' + categoryShort(c) +
                        (s.vmax_kt != null ? ' ' + s.vmax_kt + ' kt' : '') + ')';
            var sel_attr = (s.atcf_id === currentId) ? ' selected' : '';
            opts.push('<option value="' + s.atcf_id + '"' + sel_attr + '>' +
                      label.replace(/</g, '&lt;') + '</option>');
        }
        sel.innerHTML = opts.join('');
        sel.style.display = '';
    }

    /** "Loop only" escape hatch on the storm card → switch to the bare
     *  Quick View animation. Preserves the active storm so the loop
     *  matches what the user was looking at. Soft-closes the card to
     *  release frame layers, then shows + activates Quick View directly
     *  (bypasses switchIRView early-return when already on the Sat tab). */
    window.openLoopOnlyView = function () {
        var sid = currentStormId;
        var parts = ['satellite', 'loop=1'];
        if (sid) parts.push('storm=' + sid);
        try {
            history.replaceState(null, '', 'realtime_ir.html#' + parts.join('&'));
        } catch (e) {}
        closeStormDetail({ skipTabRoute: true });
        var satMain = document.getElementById('sat-main');
        var satQuick = document.getElementById('sat-quick-view');
        if (satMain) satMain.style.display = 'none';
        if (satQuick) satQuick.style.display = 'flex';
        if (window.activateQuickView) window.activateQuickView();
        _ga('ir_loop_only');
    };

    /** Snapshot of active storms (used by the Storm Satellite tab to pick
     *  a sensible default when the user lands without a specific storm). */
    window._irGetActiveStorms = function () {
        return stormData.slice();
    };

    /** Fire a one-shot callback as soon as stormData is non-empty. If the
     *  list is already populated, the callback runs synchronously. */
    window._irOnceStormsLoaded = function (cb) {
        if (typeof cb !== 'function') return;
        if (stormData && stormData.length > 0) { cb(stormData.slice()); return; }
        var handler = function () {
            window.removeEventListener('ir-storms-loaded', handler);
            cb(stormData.slice());
        };
        window.addEventListener('ir-storms-loaded', handler);
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
        _rtFetchJSON(API_BASE + '/ir-monitor/season-summary')
            .then(function (data) {
                seasonSummaryData = data;
                renderBasinSidebar();
            })
            .catch(function (err) {
                console.warn('[RT Monitor] Season summary fetch failed:', err.message || '');
                // Keep any already-rendered data on screen; only replace the
                // placeholder on a first-load failure so a transient repoll
                // error doesn't blow away a good sidebar.
                if (seasonSummaryData) return;
                var content = document.getElementById('basin-sidebar-content');
                _rtStatusError(content, fetchSeasonSummary, 'Couldn’t load season data');
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
            if (statusEl) statusEl.textContent = 'Loading…';
            dataPromise = _rtFetchJSON(API_BASE + '/global/adeck?atcf_id=' + encodeURIComponent(atcfId))
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
                // Force a refetch next time by clearing the last-storm
                // memo so the Retry actually re-hits the network.
                _rtModelLastAtcf = null;
                _rtStatusError(statusEl, function () { _rtLoadModelForecasts(storm); },
                               'Models unavailable');
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
            // Also tear down DeepMind ensemble — it was auto-enabled when
            // Models turned on, so pair the teardown. Without this, the
            // DeepMind spaghetti + mean line stay on the map after the
            // user thinks they've turned models off.
            if (_rtWeatherlabVisible && typeof window._rtToggleWeatherlab === 'function') {
                window._rtToggleWeatherlab();
            }
            // Hide the forecast intensity panel — it's a model artifact too.
            var _intSec = document.getElementById('ir-intensity-section');
            if (_intSec) _intSec.style.display = 'none';
            return;
        }

        _rtModelVisible = true;
        if (btn) btn.textContent = 'Hide Models';
        if (controls) controls.style.display = '';
        // Reveal the forecast intensity panel. Renderer fires from the
        // WeatherLab .then(), so the chart populates once the data arrives.
        var _intSecShow = document.getElementById('ir-intensity-section');
        if (_intSecShow) _intSecShow.style.display = '';

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

        var newTraces = [];
        var techKeys = Object.keys(cycle).sort();

        for (var ti = 0; ti < techKeys.length; ti++) {
            var tech = techKeys[ti];
            var forecast = cycle[tech];
            if (!_rtModelTypeFilters[forecast.type]) continue;
            if (_rtModelShowInterp && forecast.interp === false) continue;

            var points = forecast.points;
            if (!points || points.length < 2) continue;

            // Use the WeatherLab categorical x-axis (+Xh tau labels) so
            // the model lines align with the percentile bands. Mixing
            // categorical and date-typed x values lets Plotly silently
            // append the dates as fresh categories, pushing the model
            // lines off the right edge of the plot — that was the visible
            // "deeply bugged" artifact past +216h.
            var times = [];
            var winds = [];
            var hasWind = false;
            for (var pi = 0; pi < points.length; pi++) {
                if (points[pi].wind != null) {
                    times.push('+' + Math.round(points[pi].tau) + 'h');
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
                // Render the percentile-bands forecast chart into the card's
                // intensity chart container, replacing the simple history
                // line with the ensemble fan-chart used in the genesis modal.
                try { _rtRenderCardForecastIntensity(json); }
                catch (e) { console.warn('[RT Monitor] card forecast chart render failed:', e); }
            })
            .catch(function () {
                // Silent — WeatherLab may not have data for this storm
            });
    }

    /** Render the ensemble percentile-bands forecast plot into the storm
     *  card's intensity chart container (`ir-intensity-chart`), mirroring
     *  the genesis-modal view but for an active named storm. Reuses
     *  _renderGenesisIntensity by passing the card's element id. */
    function _rtRenderCardForecastIntensity(json) {
        if (!json || !json.members) return;
        var el = document.getElementById('ir-intensity-chart');
        if (!el) return;
        el.className = 'ir-intensity-chart';  // remove skeleton

        var memberKeys = Object.keys(json.members);
        if (memberKeys.length === 0) return;

        // Named-storm view: no genesis dashed line (the storm already exists).
        // Pass stats with genesisMedianTau=null to skip that annotation.
        var stats = { genesisMedianTau: null };
        var mean = json.ensemble_mean;
        if (!mean || !mean.points) return;

        var heading = document.getElementById('ir-intensity-heading');
        if (heading) heading.textContent = 'Intensity Forecast';

        _renderGenesisIntensity(memberKeys, json.members, mean, stats,
                                'ir-intensity-chart');
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

        // If the percentile-bands forecast is the active card chart
        // (rendered by _rtRenderCardForecastIntensity), the 50-member
        // spread + mean overlay is redundant — it's the same data
        // visualised once already as the orange bands + mean line. It
        // also uses absolute-date x values which Plotly silently appends
        // to the categorical +Xh axis, producing the cyan curve that
        // ran off the right edge of the chart. Skip the overlay in that
        // case.
        for (var ci = 0; ci < chartEl.data.length; ci++) {
            var nm = (chartEl.data[ci] && chartEl.data[ci].name) || '';
            if (nm === 'P25 – P75 (IQR)' || nm === 'ensemble mean') return;
        }

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

        // True while we're showing the phase-1 client-side estimate computed
        // from the capped (100/1000) ensemble and still waiting on the
        // server's uncapped cluster probabilities. We draw the markers now
        // but hold the numeric formation probability so it fills in once
        // rather than visibly changing when the cluster fetch lands.
        // When the user has stepped back to a past cycle, the server's
        // uncapped cluster index (which only covers the latest run) will
        // never match — so don't wait on it. The client-side TCA fractions
        // computed from the pinned cycle's capped data are what we show.
        var probsPending = !_genesisActiveCycle
            && (_genesisClusterMethod === 'tcatlas')
            && !(_rtGenesisClusters
                 && _rtGenesisData
                 && _rtGenesisClusters.init_time === _rtGenesisData.init_time
                 && _genesisClusterParamsMatch(_rtGenesisClusters.params));

        // Play the pop-in entrance once per cycle, on whichever render
        // first draws markers for this init (deepmind pass or the later
        // tcatlas cluster swap — whichever wins). Subsequent re-renders
        // for the same cycle skip it so the map doesn't twitch.
        var initNow = (_rtGenesisData && _rtGenesisData.init_time) || null;
        var animateEntry = !!initNow && initNow !== _genesisAnimatedInit;

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
        // Hide the redundant track name labels for matched storms too —
        // the disturbance pin already shows the official name.
        _syncStormLabelVisibility();

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
                '<div class="rt-gen-marker' + (animateEntry ? ' rt-gen-marker--enter' : '') + '" style="background:' + style.bold + ';'
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

            var probLine = probsPending
                ? '<br><span style="opacity:0.75; font-style:italic;">Probabilities loading…</span>'
                : '<br>Formation probability: <strong>' + pctText + '</strong>'
                    + ' <span style="opacity:0.7;">(' + d.total + ' of '
                    + _GENESIS_ENSEMBLE_SIZE + ' members)</span>';
            var gInit = (_rtGenesisData && _rtGenesisData.init_time) || '';
            var initLine = gInit
                ? '<br><span style="opacity:0.75; font-size:0.85em;">Init: '
                    + gInit.slice(0, 4) + '-' + gInit.slice(4, 6) + '-'
                    + gInit.slice(6, 8) + ' ' + gInit.slice(8, 10) + 'Z</span>'
                : '';
            var tip = '<div style="min-width:180px;">'
                + '<b>' + d.displayLabel + '</b>'
                + initLine
                + probLine
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

        // This cycle has now had its entrance played; later re-renders
        // (cluster swap, tuner changes) for the same init won't re-pop.
        if (animateEntry) _genesisAnimatedInit = initNow;
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
                  // Composite exports. Each summary pairs a download (⤓)
                  // with a "view in new tab" (⤢) action. Which group is
                  // visible follows the active modal tab (set in
                  // _genesisShowPane): the "This run" tab shows Overall +
                  // Intensity; the "Trends" tab shows the run-to-run summary.
                  '<span id="rt-genesis-summary-actions" class="rt-genesis-summary-actions">' +
                    '<span class="rt-genesis-sum-group" data-pane="thisrun">' +
                      '<button type="button" id="rt-genesis-sum-overall-dl" class="rt-genesis-modal-summary-save" title="Download overall summary PNG (track map + intensity + genesis time)">⤓ Overall</button>' +
                      '<button type="button" id="rt-genesis-sum-overall-view" class="rt-genesis-modal-summary-view" title="Open overall summary in a new tab" aria-label="View overall summary in a new tab">⤢</button>' +
                      '<button type="button" id="rt-genesis-sum-int-dl" class="rt-genesis-modal-summary-save" title="Download intensity summary PNG (intensity spread + LMI distribution + LMI vs hour)">⤓ Intensity</button>' +
                      '<button type="button" id="rt-genesis-sum-int-view" class="rt-genesis-modal-summary-view" title="Open intensity summary in a new tab" aria-label="View intensity summary in a new tab">⤢</button>' +
                    '</span>' +
                    '<span class="rt-genesis-sum-group" data-pane="trends" style="display:none;">' +
                      '<button type="button" id="rt-genesis-sum-trends-dl" class="rt-genesis-modal-summary-save" title="Download run-to-run trends summary PNG">⤓ Trends</button>' +
                      '<button type="button" id="rt-genesis-sum-trends-view" class="rt-genesis-modal-summary-view" title="Open trends summary in a new tab" aria-label="View trends summary in a new tab">⤢</button>' +
                    '</span>' +
                  '</span>' +
                  '<button type="button" class="rt-genesis-modal-close" aria-label="Close" title="Close (Esc)">×</button>' +
                '</div>' +
              '</div>' +
              // Headline stats — pre-genesis-specific metrics the named-
              // storm panel never has to compute (formation probability,
              // P10/P50/P90 peak Vmax, most-likely genesis time).
              '<div id="rt-genesis-modal-stats" class="rt-genesis-stat-row"></div>' +
              // (Run-to-run trend lives in the Trends tab below, grouped
              // with the track + intensity run-to-run overlays.)
              // Sticky jump-nav — makes the existence of the intensity
              // envelope and genesis-time histogram discoverable without
              // relying on the scrollbar (the panels live below the
              // fold for most viewport sizes).
              // Two-mode tab toggle: "This run" (all per-disturbance
              // graphics for the loaded cycle) vs "Trends" (run-to-run
              // comparison across the last few cycles). Clicking swaps
              // which pane is visible — no scrolling between them.
              '<div id="rt-genesis-jump-nav" class="rt-genesis-jump-nav" role="tablist">' +
                '<button type="button" class="rt-genesis-jump-btn active" data-pane="thisrun" role="tab">This run</button>' +
                '<button type="button" class="rt-genesis-jump-btn" data-pane="trends" role="tab">Trends</button>' +
              '</div>' +
              '<div class="rt-genesis-modal-body">' +
                // ── Trends pane (hidden by default) ──────────────────
                // Run-to-run comparison across the last few DeepMind
                // cycles, grouped: formation %/Vmax bars, the cluster
                // mean-track overlay, and the mean-intensity-vs-hour
                // overlay. Each sub-panel reveals itself only when the
                // /weatherlab-genesis-trend fetch returns enough history
                // (genesis panel needs ≥2 matched cycles; the track +
                // intensity overlays need mean_track from the backend).
                '<div id="rt-genesis-pane-trends" class="rt-genesis-pane" style="display:none;">' +
                '<div id="rt-genesis-jump-trends" class="rt-genesis-modal-chart-wrap" style="position:relative;">' +
                  '<div id="rt-genesis-trends-empty" class="rt-genesis-trend-note" style="padding:10px 4px;">No multi-cycle history yet for this disturbance.</div>' +
                  '<div id="rt-genesis-modal-trend" class="rt-genesis-trend-wrap" style="display:none;">' +
                    '<div class="rt-genesis-trend-head">' +
                      '<span class="rt-genesis-trend-title">Run-to-run trend</span>' +
                      '<span id="rt-genesis-trend-note" class="rt-genesis-trend-note"></span>' +
                    '</div>' +
                    '<div id="rt-genesis-modal-trend-chart" style="width:100%; height:140px;"></div>' +
                  '</div>' +
                  '<div id="rt-genesis-trendmap-wrap" class="rt-genesis-trend-wrap" style="display:none; margin-top:14px;">' +
                    '<div class="rt-genesis-trend-head">' +
                      '<span class="rt-genesis-trend-title">Track trend</span>' +
                      '<span id="rt-genesis-trendmap-note" class="rt-genesis-trend-note"></span>' +
                    '</div>' +
                    '<div id="rt-genesis-modal-trendmap" style="width:100%; height:360px;"></div>' +
                  '</div>' +
                  '<div id="rt-genesis-trendint-wrap" class="rt-genesis-trend-wrap" style="display:none; margin-top:14px;">' +
                    '<div class="rt-genesis-trend-head">' +
                      '<span class="rt-genesis-trend-title">Intensity trend</span>' +
                      '<span id="rt-genesis-trendint-note" class="rt-genesis-trend-note"></span>' +
                    '</div>' +
                    '<div id="rt-genesis-modal-trendint" style="width:100%; height:280px;"></div>' +
                  '</div>' +
                '</div>' +
                '</div>' + // close #rt-genesis-pane-trends
                // ── This-run pane (visible by default) ───────────────
                '<div id="rt-genesis-pane-thisrun" class="rt-genesis-pane">' +
                // Sub-nav: the per-disturbance panels stack vertically and
                // most live below the fold. This lighter chip row makes
                // them discoverable and lets the user jump straight to one.
                '<div class="rt-genesis-subnav">' +
                  '<span class="rt-genesis-subnav-label">Jump to:</span>' +
                  '<button type="button" class="rt-genesis-subnav-chip active" data-jump="rt-genesis-jump-tracks">Tracks</button>' +
                  '<button type="button" class="rt-genesis-subnav-chip" data-jump="rt-genesis-jump-intensity">Intensity</button>' +
                  '<button type="button" class="rt-genesis-subnav-chip" data-jump="rt-genesis-jump-gtime">Genesis time</button>' +
                  '<button type="button" class="rt-genesis-subnav-chip" data-jump="rt-genesis-jump-rmw">RMW</button>' +
                  '<button type="button" class="rt-genesis-subnav-chip" data-jump="rt-genesis-jump-lmi">LMI</button>' +
                  '<button type="button" class="rt-genesis-subnav-chip" data-jump="rt-genesis-jump-lmitau">LMI vs hour</button>' +
                '</div>' +
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
                // Forecast RMW evolution — per-member radius-of-max-wind
                // fan-chart over lead time. Only members at TC strength
                // (≥34 kt) contribute, so the envelope tracks the storm
                // phase rather than the noisy pre-genesis disturbance.
                '<div id="rt-genesis-jump-rmw" class="rt-genesis-modal-chart-wrap" style="position:relative; margin-top:14px;">' +
                  '<button type="button" id="rt-genesis-rmw-save" class="rt-genesis-modal-save" title="Save RMW evolution as PNG">⤓ PNG</button>' +
                  '<div id="rt-genesis-modal-rmw" style="width:100%; height:300px;"></div>' +
                '</div>' +
                // Lifetime-max-intensity distribution — 1-D histogram of
                // each member\'s peak Vmax across the whole forecast.
                '<div id="rt-genesis-jump-lmi" class="rt-genesis-modal-chart-wrap" style="position:relative; margin-top:14px;">' +
                  '<button type="button" id="rt-genesis-lmi-save" class="rt-genesis-modal-save" title="Save LMI distribution as PNG">⤓ PNG</button>' +
                  '<div id="rt-genesis-modal-lmi" style="width:100%; height:220px;"></div>' +
                '</div>' +
                // LMI vs forecast hour — 2-D density of (lead time of
                // peak, peak Vmax). Shows WHEN and HOW STRONG members
                // peak at a glance. Mirrors the named-storm 1K heatmap.
                '<div id="rt-genesis-jump-lmitau" class="rt-genesis-modal-chart-wrap" style="position:relative; margin-top:14px;">' +
                  '<button type="button" id="rt-genesis-lmitau-save" class="rt-genesis-modal-save" title="Save LMI vs forecast hour as PNG">⤓ PNG</button>' +
                  '<div id="rt-genesis-modal-lmitau" style="width:100%; height:280px;"></div>' +
                '</div>' +
                '</div>' + // close #rt-genesis-pane-thisrun
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
        m.querySelector('#rt-genesis-rmw-save').addEventListener('click', function () {
            _genesisSavePNG('rt-genesis-modal-rmw', 'rmw-evolution');
        });
        m.querySelector('#rt-genesis-lmi-save').addEventListener('click', function () {
            _genesisSavePNG('rt-genesis-modal-lmi', 'lmi-distribution');
        });
        m.querySelector('#rt-genesis-lmitau-save').addEventListener('click', function () {
            _genesisSavePNG('rt-genesis-modal-lmitau', 'lmi-vs-hour');
        });
        // Composite summary exports — download (⤓) + view-in-new-tab (⤢).
        [
            ['rt-genesis-sum-overall-dl',  'overall',   'download'],
            ['rt-genesis-sum-overall-view','overall',   'view'],
            ['rt-genesis-sum-int-dl',      'intensity', 'download'],
            ['rt-genesis-sum-int-view',    'intensity', 'view'],
            ['rt-genesis-sum-trends-dl',   'trends',    'download'],
            ['rt-genesis-sum-trends-view', 'trends',    'view'],
        ].forEach(function (cfg) {
            var b = m.querySelector('#' + cfg[0]);
            if (b) b.addEventListener('click', function () {
                _genesisSummaryAction(cfg[1], cfg[2], b);
            });
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
        var panes = {
            thisrun: m.querySelector('#rt-genesis-pane-thisrun'),
            trends:  m.querySelector('#rt-genesis-pane-trends'),
        };
        function _genesisShowPane(name) {
            if (!panes[name]) return;
            Object.keys(panes).forEach(function (k) {
                if (panes[k]) panes[k].style.display = (k === name) ? '' : 'none';
            });
            jumpBtns.forEach(function (b) {
                b.classList.toggle('active', b.getAttribute('data-pane') === name);
            });
            // Show only the summary-export buttons relevant to the active
            // pane — Overall+Intensity on "This run", Trends on "Trends".
            m.querySelectorAll('#rt-genesis-summary-actions .rt-genesis-sum-group')
                .forEach(function (g) {
                    g.style.display =
                        (g.getAttribute('data-pane') === name) ? '' : 'none';
                });
            if (scroller) scroller.scrollTop = 0;
            // Plotly charts drawn while their pane was display:none render
            // at 0 width; resize them now that the pane is laid out.
            if (typeof Plotly !== 'undefined' && panes[name]) {
                panes[name].querySelectorAll('.js-plotly-plot').forEach(function (gd) {
                    try { Plotly.Plots.resize(gd); } catch (e) {}
                });
            }
        }
        jumpBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                _genesisShowPane(btn.getAttribute('data-pane'));
            });
        });

        // ── This-run sub-nav: jump-to + scroll-spy ───────────────────
        // The per-disturbance panels stack vertically; the chip row at the
        // top of the pane lets the user jump to any of them and shows
        // which one is currently in view.
        var subChips = m.querySelectorAll('.rt-genesis-subnav-chip');
        function _genesisScrollTo(id) {
            var target = m.querySelector('#' + id);
            if (!target || !scroller) return;
            // Land the panel just below the sticky tab nav, not under it.
            var nav = m.querySelector('#rt-genesis-jump-nav');
            var navH = nav ? nav.offsetHeight : 0;
            var srect = scroller.getBoundingClientRect();
            var trect = target.getBoundingClientRect();
            var delta = (trect.top - srect.top) + scroller.scrollTop - navH - 8;
            scroller.scrollTo({ top: delta, behavior: 'smooth' });
        }
        subChips.forEach(function (chip) {
            chip.addEventListener('click', function () {
                _genesisScrollTo(chip.getAttribute('data-jump'));
            });
        });
        if ('IntersectionObserver' in window && scroller) {
            var setActiveChip = function (id) {
                subChips.forEach(function (c) {
                    c.classList.toggle('active', c.getAttribute('data-jump') === id);
                });
            };
            var io = new IntersectionObserver(function (entries) {
                var best = null;
                entries.forEach(function (e) {
                    if (e.isIntersecting &&
                        (!best || e.intersectionRatio > best.intersectionRatio)) {
                        best = e;
                    }
                });
                if (best) setActiveChip(best.target.id);
            }, { root: scroller, threshold: [0.25, 0.5, 0.75] });
            ['rt-genesis-jump-tracks', 'rt-genesis-jump-intensity',
             'rt-genesis-jump-gtime', 'rt-genesis-jump-rmw',
             'rt-genesis-jump-lmi', 'rt-genesis-jump-lmitau'].forEach(function (id) {
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
            el.title = 'DeepMind FNV3 cycles run every 6 h (00/06/12/18 '
                + 'UTC). ETA is anchored on when the previous cycle was '
                + 'first observed available, plus 6 h. Estimated, not '
                + 'guaranteed — staging delays can push individual '
                + 'cycles later.';
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

        _renderGenesisTrend(json, stats);
        _renderGenesisMap(memberKeys, members, mean, stats);
        _renderGenesisIntensity(memberKeys, members, mean, stats);
        _renderGenesisTimeHistogram(stats);
        _renderGenesisRMW(memberKeys, members, stats);
        _renderGenesisLmiHist(stats);
        _renderGenesisLmiVsTau(stats);
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
        var peakTaus = [];
        for (var i = 0; i < memberKeys.length; i++) {
            var pts = members[memberKeys[i]].points || [];
            var firstTau = null, firstLat = null, firstLon = null;
            var peak = 0, peakTau = null;
            for (var j = 0; j < pts.length; j++) {
                var w = pts[j].wind;
                if (w == null) continue;
                if (firstTau == null && w >= 34) {
                    firstTau = pts[j].tau;
                    firstLat = pts[j].lat;
                    firstLon = pts[j].lon;
                }
                if (w > peak) { peak = w; peakTau = pts[j].tau; }
            }
            if (firstTau != null) {
                formationCount++;
                genesisTimes.push(firstTau);
                genLats.push(firstLat);
                genLons.push(firstLon);
            }
            peakWinds.push(peak);
            peakTaus.push(peakTau);
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
            peakTaus: peakTaus,
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
        [137/200,  '#8b5cf6'],   // C5 (137 kt) — Saffir–Simpson ends here
        // The official scale stops at C5, but FNV3 members can forecast
        // far stronger (Patricia peaked ~185 kt). Keep the C5 violet hue
        // and just push the lightness up — violet → pale lavender →
        // white-hot. On the dark navy map a lighter dot is also a
        // higher-contrast dot, so an "off-the-charts" 160-185+ kt member
        // is the brightest marker on screen. Staying in the violet family
        // (not rotating toward magenta) keeps it clear of the C4 color.
        [160/200,  '#b9a3f9'],   // beyond C5 — light violet
        [180/200,  '#dccdfb'],   // extreme — pale lavender
        [1,        '#f5f0ff'],   // 200 kt — white-hot (off the charts)
    ];

    /* Run-to-run trend sparkline.
       Fetches /weatherlab-genesis-trend for the clicked disturbance's
       genesis-density anchor (peak_lat/peak_lon — the only run-to-run-
       stable handle, since D-numbers are re-ranked each cycle) and draws
       a compact dual-axis chart: formation probability (bars, left axis)
       and predicted peak Vmax (line, right axis) across the last ~4
       DeepMind cycles. Degrades silently: if the endpoint isn't deployed
       or fewer than 2 cycles match, the panel stays hidden. */
    function _renderGenesisTrend(json, stats) {
        var wrap = document.getElementById('rt-genesis-modal-trend');
        var el = document.getElementById('rt-genesis-modal-trend-chart');
        var noteEl = document.getElementById('rt-genesis-trend-note');
        if (!wrap || !el) return;
        // Reset the Trends tab: hide all three figures, show the empty
        // note. Each draw un-hides its own wrap once it has data.
        var _tmw = document.getElementById('rt-genesis-trendmap-wrap');
        var _tiw = document.getElementById('rt-genesis-trendint-wrap');
        wrap.style.display = 'none';   // default hidden until data lands
        if (_tmw) _tmw.style.display = 'none';
        if (_tiw) _tiw.style.display = 'none';
        _genesisTrendsUpdateEmpty();

        // Resolve the genesis-density anchor for this disturbance.
        var meta = _genesisDisturbanceMeta[json && json.track_id] || {};
        var aLat = (meta.peakLat != null) ? meta.peakLat : null;
        var aLon = (meta.peakLon != null) ? meta.peakLon : null;
        if (aLat == null || aLon == null) {
            // Fall back to the ensemble-mean's first 34-kt (or first) point.
            var mpts = (json && json.ensemble_mean && json.ensemble_mean.points) || [];
            var anchorPt = null;
            for (var i = 0; i < mpts.length; i++) {
                if (mpts[i].wind != null && mpts[i].wind >= 34
                        && mpts[i].lat != null && mpts[i].lon != null) {
                    anchorPt = mpts[i]; break;
                }
            }
            if (!anchorPt && mpts.length) anchorPt = mpts[0];
            if (anchorPt) { aLat = anchorPt.lat; aLon = anchorPt.lon; }
        }
        if (aLat == null || aLon == null) return;   // no anchor → skip

        // Guard against a stale response landing after the user has
        // clicked through to a different disturbance.
        var reqTrackId = json && json.track_id;
        wrap.dataset.trackId = reqTrackId || '';
        var loadedInit = (json && json.init_time) || '';

        fetch(API_BASE + '/ir-monitor/weatherlab-genesis-trend'
                + '?lat=' + encodeURIComponent(aLat)
                + '&lon=' + encodeURIComponent(aLon)
                + '&count=4', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                if (wrap.dataset.trackId !== (reqTrackId || '')) return;  // stale
                _drawGenesisTrend(data, loadedInit);
                _drawTrackTrend(data, loadedInit);
                _drawIntensityTrend(data, loadedInit);
                _genesisTrendsUpdateEmpty();
            })
            .catch(function () { /* endpoint absent or failed — stay hidden */ });
    }

    function _drawGenesisTrend(data, loadedInit) {
        var wrap = document.getElementById('rt-genesis-modal-trend');
        var el = document.getElementById('rt-genesis-modal-trend-chart');
        var noteEl = document.getElementById('rt-genesis-trend-note');
        if (!wrap || !el || typeof Plotly === 'undefined') return;
        var raw = (data && data.trend) || [];
        // Oldest → newest, left to right (API returns freshest-first).
        var trend = raw.slice().reverse();
        var nMatched = trend.filter(function (t) { return t.matched; }).length;
        if (nMatched < 2) return;   // not enough history to show a trend

        var theme = _genesisTheme();
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var grid = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,22,35,0.06)';

        var xLabels = [], formPct = [], peakV = [], barColors = [], custom = [];
        for (var i = 0; i < trend.length; i++) {
            var t = trend[i];
            var it = t.init_time || '';
            var lbl = (it.length >= 10)
                ? it.slice(4, 6) + '/' + it.slice(6, 8) + ' ' + it.slice(8, 10) + 'Z'
                : it;
            var isLoaded = (it === loadedInit);
            xLabels.push(lbl + (isLoaded ? ' ★' : ''));
            formPct.push(t.matched ? +(t.formation_prob * 100).toFixed(0) : null);
            peakV.push(t.matched ? t.peak_wind : null);
            barColors.push(isLoaded ? '#00e5ff' : 'rgba(0,229,255,0.42)');
            custom.push(t.matched ? (t.display_short || '') : '—');
        }

        var barTrace = {
            type: 'bar', x: xLabels, y: formPct, name: 'Formation %',
            yaxis: 'y', marker: { color: barColors },
            customdata: custom,
            hovertemplate: '%{x}<br>Formation: %{y}%<br>(%{customdata})<extra></extra>',
        };
        var lineTrace = {
            type: 'scatter', mode: 'lines+markers', x: xLabels, y: peakV,
            name: 'Peak Vmax', yaxis: 'y2', connectgaps: true,
            line: { color: '#f97316', width: 2 },
            marker: { color: '#f97316', size: 6 },
            hovertemplate: '%{x}<br>Peak Vmax: %{y} kt<extra></extra>',
        };

        var layout = Object.assign({}, theme, {
            margin: { l: 40, r: 44, t: 8, b: 30 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            height: 140,
            showlegend: false,
            bargap: 0.45,
            xaxis: { tickfont: { size: 9.5 }, gridcolor: grid, fixedrange: true },
            yaxis: {
                title: { text: 'Form %', font: { size: 9.5 } },
                tickfont: { size: 9 }, range: [0, 100], gridcolor: grid,
                fixedrange: true,
            },
            yaxis2: {
                title: { text: 'Vmax', font: { size: 9.5 } },
                tickfont: { size: 9 }, overlaying: 'y', side: 'right',
                rangemode: 'tozero', showgrid: false, fixedrange: true,
            },
        });

        Plotly.react(el, [barTrace, lineTrace], layout,
                     { responsive: true, displayModeBar: false });
        if (noteEl) {
            noteEl.textContent = '★ = loaded run · formation % (bars) and '
                + 'peak Vmax (line) across the last ' + trend.length
                + ' cycles';
        }
        wrap.style.display = '';
    }

    // Compact "MM/DD HHZ" label from a YYYYMMDDHH init string.
    function _genesisFmtInit(it) {
        it = it || '';
        return (it.length >= 10)
            ? it.slice(4, 6) + '/' + it.slice(6, 8) + ' ' + it.slice(8, 10) + 'Z'
            : it;
    }

    // Show the "no history" note only when all three Trends figures are
    // hidden (no matched cycles / backend not yet serving mean_track).
    function _genesisTrendsUpdateEmpty() {
        var empty = document.getElementById('rt-genesis-trends-empty');
        if (!empty) return;
        var anyVisible = ['rt-genesis-modal-trend', 'rt-genesis-trendmap-wrap',
                          'rt-genesis-trendint-wrap'].some(function (id) {
            var n = document.getElementById(id);
            return n && n.style.display !== 'none';
        });
        empty.style.display = anyVisible ? 'none' : '';
    }

    // West/South edge tick labels for a scattergeo map (it has no built-in
    // axis labels) — mirrors the inset-text approach in _renderGenesisMap.
    function _genesisAxisLabelTraces(bounds, isDark) {
        var step = _genesisAxisDtick(bounds);
        var lonInset = (bounds.lat[1] - bounds.lat[0]) * 0.04;
        var latInset = (bounds.lon[1] - bounds.lon[0]) * 0.04;
        var loLat = [], loLon = [], loTxt = [];
        var lonStart = Math.ceil(bounds.lon[0] / step) * step;
        for (var lo = lonStart; lo <= bounds.lon[1]; lo += step) {
            if (lo - bounds.lon[0] < step * 0.4) continue;
            if (bounds.lon[1] - lo < step * 0.4) continue;
            loLat.push(bounds.lat[0] + lonInset);
            loLon.push(lo); loTxt.push(_genesisFormatLon(lo));
        }
        var laLat = [], laLon = [], laTxt = [];
        var latStart = Math.ceil(bounds.lat[0] / step) * step;
        for (var la = latStart; la <= bounds.lat[1]; la += step) {
            if (la - bounds.lat[0] < step * 0.4) continue;
            if (bounds.lat[1] - la < step * 0.4) continue;
            laLat.push(la); laLon.push(bounds.lon[0] + latInset);
            laTxt.push(_genesisFormatLat(la));
        }
        var fg = isDark ? '#f1f5f9' : '#0f172a';
        return [
            { type: 'scattergeo', mode: 'text', lon: loLon, lat: loLat,
              text: loTxt, textposition: 'top center', hoverinfo: 'skip',
              showlegend: false,
              textfont: { size: 11, color: fg, family: 'Inter, sans-serif' } },
            { type: 'scattergeo', mode: 'text', lon: laLon, lat: laLat,
              text: laTxt, textposition: 'middle right', hoverinfo: 'skip',
              showlegend: false,
              textfont: { size: 11, color: fg, family: 'Inter, sans-serif' } },
        ];
    }

    // Standard genesis scattergeo geo-layout for a given bounds box.
    function _genesisGeoLayout(bounds, isDark, theme) {
        var step = _genesisAxisDtick(bounds);
        var rootStyle = getComputedStyle(document.documentElement);
        var pageSurface = rootStyle.getPropertyValue('--surface-raised').trim()
                       || (isDark ? '#161b24' : '#ffffff');
        var pageLand = rootStyle.getPropertyValue('--surface').trim()
                    || (isDark ? '#11161f' : '#f7f8fa');
        var gridc = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,22,35,0.10)';
        return {
            margin: { l: 4, r: 4, t: 8, b: 4 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            font: theme.font,
            geo: {
                projection: { type: 'mercator' },
                domain: { x: [0, 1], y: [0, 1] },
                lonaxis: { range: bounds.lon, showgrid: true, gridcolor: gridc,
                           dtick: step },
                lataxis: { range: bounds.lat, showgrid: true, gridcolor: gridc,
                           dtick: step },
                showland: true, landcolor: pageLand,
                showocean: true, oceancolor: pageSurface,
                showcountries: true,
                countrycolor: isDark ? 'rgba(255,255,255,0.20)' : 'rgba(15,22,35,0.30)',
                coastlinecolor: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(15,22,35,0.55)',
                coastlinewidth: 0.8, showcoastlines: true,
                bgcolor: 'rgba(0,0,0,0)',
            },
            showlegend: false,
        };
    }

    // Grey color for a prior run, faded by recency rank (oldest faintest).
    function _genesisPriorGrey(rank, nPrior, isDark) {
        var op = (nPrior <= 1) ? 0.55 : 0.30 + 0.45 * (rank / (nPrior - 1));
        return isDark ? 'rgba(148,163,184,' + op.toFixed(2) + ')'
                      : 'rgba(100,116,139,' + op.toFixed(2) + ')';
    }

    /* Track trend (Trends tab, figure 2).
       Overlays each recent cycle's cluster-mean polyline so the user can
       see how the forecast TRACK has shifted run-to-run. Current run is
       bold orange with SS-colored markers; prior runs are grey, fainter
       the older they are. Mean-only (no spaghetti) to keep it legible.
       Needs the backend deployed with mean_track — degrades silently
       (stays hidden) when fewer than 2 cycles carry a polyline. */
    function _drawTrackTrend(data, loadedInit) {
        var wrap = document.getElementById('rt-genesis-trendmap-wrap');
        var el = document.getElementById('rt-genesis-modal-trendmap');
        var noteEl = document.getElementById('rt-genesis-trendmap-note');
        if (!wrap || !el || typeof Plotly === 'undefined') return;
        wrap.style.display = 'none';

        var trend = ((data && data.trend) || []).slice().reverse();  // old→new
        var cycles = trend.filter(function (t) {
            return t.mean_track && t.mean_track.length;
        });
        if (cycles.length < 2) return;   // need ≥2 runs to compare

        var theme = _genesisTheme();
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        var allLats = [], allLons = [];
        cycles.forEach(function (c) {
            c.mean_track.forEach(function (p) {
                if (p.lat != null && p.lon != null) {
                    allLats.push(p.lat); allLons.push(p.lon);
                }
            });
        });
        var rect = el.getBoundingClientRect();
        var aspect = rect.height > 0
            ? Math.max(0.8, (rect.width - 10) / rect.height) : 2.0;
        var bounds = _genesisBoundsFromMean(allLats, allLons, [], [], aspect);

        var priors = cycles.filter(function (c) { return c.init_time !== loadedInit; });
        var nPrior = priors.length;
        var priorRank = {};
        priors.forEach(function (c, i) { priorRank[c.init_time] = i; });

        // Draw priors first so the bold current run sits on top.
        var traces = [];
        cycles.slice().sort(function (a, b) {
            var ac = a.init_time === loadedInit ? 1 : 0;
            var bc = b.init_time === loadedInit ? 1 : 0;
            return ac - bc;
        }).forEach(function (c) {
            var lons = [], lats = [], prev = null;
            c.mean_track.forEach(function (p) {
                if (p.lat == null || p.lon == null) return;
                if (prev !== null && Math.abs(p.lon - prev) > 180) {
                    lons.push(null); lats.push(null);
                }
                lons.push(p.lon); lats.push(p.lat); prev = p.lon;
            });
            var lbl = _genesisFmtInit(c.init_time);
            if (c.init_time === loadedInit) {
                traces.push({
                    type: 'scattergeo', mode: 'lines', lon: lons, lat: lats,
                    line: { color: '#f97316', width: 2.8 },
                    connectgaps: false, hoverinfo: 'skip', showlegend: false,
                });
                var mLon = [], mLat = [], mW = [], mTau = [];
                c.mean_track.forEach(function (p) {
                    if (p.lat == null || p.lon == null) return;
                    mLon.push(p.lon); mLat.push(p.lat);
                    mW.push(p.wind != null ? p.wind : 0); mTau.push(p.tau);
                });
                traces.push({
                    type: 'scattergeo', mode: 'markers', lon: mLon, lat: mLat,
                    marker: {
                        size: 8, color: mW, colorscale: _GENESIS_SS_SCALE,
                        cmin: 0, cmax: 200, showscale: false,
                        line: { color: isDark ? '#0f172a' : '#1f2937', width: 0.8 },
                    },
                    text: mW.map(function (w, i) {
                        return lbl + ' (current)<br>+' + mTau[i] + ' h · '
                            + w.toFixed(0) + ' kt (' + windToCategory(w) + ')';
                    }),
                    hovertemplate: '%{text}<br>%{lat:.1f}°N, %{lon:.1f}°E<extra></extra>',
                    showlegend: false,
                });
            } else {
                var grey = _genesisPriorGrey(priorRank[c.init_time], nPrior, isDark);
                traces.push({
                    type: 'scattergeo', mode: 'lines', lon: lons, lat: lats,
                    line: { color: grey, width: 1.6 },
                    connectgaps: false, showlegend: false,
                    hovertemplate: lbl + '<br>%{lat:.1f}°N, %{lon:.1f}°E<extra></extra>',
                });
            }
        });
        traces = traces.concat(_genesisAxisLabelTraces(bounds, isDark));

        Plotly.react(el, traces, _genesisGeoLayout(bounds, isDark, theme),
                     { responsive: true, displayModeBar: false });
        if (noteEl) {
            noteEl.textContent = 'bold orange = current run · grey = prior runs '
                + '(fainter = older) · ' + cycles.length + ' cycles';
        }
        wrap.style.display = '';
    }

    /* Intensity trend (Trends tab, figure 3).
       Each recent cycle's cluster-mean Vmax vs forecast hour, so the user
       can see run-to-run intensity drift. Same color language as the
       track trend: current run bold orange + markers, priors grey faded
       by age. Hidden until ≥2 cycles carry a polyline. */
    function _drawIntensityTrend(data, loadedInit) {
        var wrap = document.getElementById('rt-genesis-trendint-wrap');
        var el = document.getElementById('rt-genesis-modal-trendint');
        var noteEl = document.getElementById('rt-genesis-trendint-note');
        if (!wrap || !el || typeof Plotly === 'undefined') return;
        wrap.style.display = 'none';

        var trend = ((data && data.trend) || []).slice().reverse();  // old→new
        var cycles = trend.filter(function (t) {
            return t.mean_track && t.mean_track.length;
        });
        if (cycles.length < 2) return;

        var theme = _genesisTheme();
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var grid = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,22,35,0.06)';

        var priors = cycles.filter(function (c) { return c.init_time !== loadedInit; });
        var nPrior = priors.length;
        var priorRank = {};
        priors.forEach(function (c, i) { priorRank[c.init_time] = i; });

        var traces = [];
        cycles.slice().sort(function (a, b) {
            var ac = a.init_time === loadedInit ? 1 : 0;
            var bc = b.init_time === loadedInit ? 1 : 0;
            return ac - bc;
        }).forEach(function (c) {
            var xs = [], ys = [];
            c.mean_track.forEach(function (p) {
                if (p.tau == null || p.wind == null) return;
                xs.push(p.tau); ys.push(p.wind);
            });
            var lbl = _genesisFmtInit(c.init_time);
            if (c.init_time === loadedInit) {
                traces.push({
                    type: 'scatter', mode: 'lines+markers', x: xs, y: ys,
                    line: { color: '#f97316', width: 2.6 },
                    marker: { color: '#f97316', size: 6 },
                    hovertemplate: lbl + ' (current)<br>+%{x} h · %{y} kt<extra></extra>',
                });
            } else {
                var grey = _genesisPriorGrey(priorRank[c.init_time], nPrior, isDark);
                traces.push({
                    type: 'scatter', mode: 'lines', x: xs, y: ys,
                    line: { color: grey, width: 1.6 },
                    hovertemplate: lbl + '<br>+%{x} h · %{y} kt<extra></extra>',
                });
            }
        });

        var layout = Object.assign({}, theme, {
            margin: { l: 46, r: 12, t: 8, b: 34 },
            paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
            height: 280, showlegend: false,
            xaxis: { title: { text: 'Forecast hour', font: { size: 10 } },
                     tickfont: { size: 9 }, gridcolor: grid, fixedrange: true,
                     rangemode: 'tozero' },
            yaxis: { title: { text: 'Mean Vmax (kt)', font: { size: 10 } },
                     tickfont: { size: 9 }, gridcolor: grid, fixedrange: true,
                     rangemode: 'tozero' },
        });
        Plotly.react(el, traces, layout,
                     { responsive: true, displayModeBar: false });
        if (noteEl) {
            noteEl.textContent = 'bold orange = current run · grey = prior runs '
                + '(fainter = older)';
        }
        wrap.style.display = '';
    }

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
        // Center for the locator-globe inset — the median first-genesis
        // position across members, so the red dot marks where the
        // ensemble actually expects this system to spin up rather than
        // the geometric center of the (track-skewed) display window.
        // Falls back to the bounds midpoint if too few members reach 34 kt.
        var insetLon, insetLat;
        if (stats.genLats && stats.genLats.length >= 5) {
            var sortedGenLats = stats.genLats.slice().sort(function (a, b) { return a - b; });
            var sortedGenLons = stats.genLons.slice().sort(function (a, b) { return a - b; });
            insetLat = sortedGenLats[Math.floor(sortedGenLats.length / 2)];
            insetLon = sortedGenLons[Math.floor(sortedGenLons.length / 2)];
        } else {
            insetLon = (bounds.lon[0] + bounds.lon[1]) / 2;
            insetLat = (bounds.lat[0] + bounds.lat[1]) / 2;
        }

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
                // Vertical on the right by default; horizontal under the
                // map on phone-width viewports (see _genesisVmaxColorbar).
                colorbar: _genesisVmaxColorbar(),
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
        // Locator-globe inset — a small orthographic disc pinned in the
        // bottom-left corner so a reader who doesn't recognize the
        // zoomed-in stretch of open ocean can see at a glance which
        // hemisphere/basin the disturbance is in. Red dot marks the spot.
        var insetMarker = {
            type: 'scattergeo', geo: 'geo2', mode: 'markers',
            lon: [insetLon], lat: [insetLat],
            marker: {
                size: 8, color: '#ef4444', symbol: 'circle',
                line: { color: '#ffffff', width: 1 },
            },
            hoverinfo: 'skip',
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

        // On phone width the Vmax colorbar lays out horizontally beneath the
        // map (see _genesisVmaxColorbar), so reserve a bottom band for it and
        // lift the locator-globe inset above that band.
        var _mapNarrow = _genesisNarrow();
        var _mapGeoDomainY = _mapNarrow ? [0.15, 1] : [0, 1];
        var _mapInsetDomain = _mapNarrow
            ? { x: [0.01, 0.20], y: [0.56, 0.92] }
            : { x: [0.01, 0.17], y: [0.02, 0.36] };
        var layout = {
            margin: { l: 4, r: 4, t: 8, b: 4 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            font: theme.font,
            geo: {
                projection: { type: 'mercator' },
                domain: { x: [0, 1], y: _mapGeoDomainY },
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
            // Locator globe — orthographic disc rotated onto the
            // disturbance, parked in the bottom-left corner. Domain is
            // taller than wide; Plotly fits the circle and centers it,
            // so the leftover space just pads the disc.
            geo2: {
                domain: _mapInsetDomain,
                projection: {
                    type: 'orthographic',
                    rotation: { lon: insetLon, lat: insetLat, roll: 0 },
                },
                showland: true,
                landcolor: isDark ? '#39434f' : '#cfd6e0',
                showocean: true,
                oceancolor: isDark ? '#0c121b' : '#9fb0c6',
                showcoastlines: true,
                coastlinecolor: isDark ? 'rgba(255,255,255,0.40)'
                                       : 'rgba(15,22,35,0.45)',
                coastlinewidth: 0.4,
                showcountries: false,
                showframe: true,
                framecolor: isDark ? 'rgba(255,255,255,0.40)'
                                   : 'rgba(15,22,35,0.45)',
                framewidth: 1,
                lonaxis: { showgrid: true, dtick: 30,
                           gridcolor: isDark ? 'rgba(255,255,255,0.12)'
                                             : 'rgba(15,22,35,0.15)' },
                lataxis: { showgrid: true, dtick: 30,
                           gridcolor: isDark ? 'rgba(255,255,255,0.12)'
                                             : 'rgba(15,22,35,0.15)' },
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
                      tauDensity0, tauDensity1, tauDensity2, tauDensity3,
                      insetMarker],
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
    function _renderGenesisIntensity(memberKeys, members, mean, stats, elId) {
        var el = document.getElementById(elId || 'rt-genesis-modal-int');
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

        // SS reference: dashed horizontal lines at category thresholds
        // (TS=34, C1=64, C2=83, C3=96, C4=113, C5=137 kt). Lines instead
        // of filled bands keep the plot background clean — the previous
        // stacked indigo ramp accumulated to ~α 0.27 on top and read as
        // a blue blob covering half the plot. Tick labels on the right
        // edge name each band so the user can map ribbon height to
        // category at a glance.
        var ssThresholds = [
            { y: 34,  label: 'TS' },
            { y: 64,  label: 'C1' },
            { y: 83,  label: 'C2' },
            { y: 96,  label: 'C3' },
            { y: 113, label: 'C4' },
            { y: 137, label: 'C5' },
        ];
        var gridStroke = isDark ? 'rgba(148,163,184,0.18)'
                                 : 'rgba(100,116,139,0.22)';
        var gridLabelColor = isDark ? 'rgba(203,213,225,0.75)'
                                     : 'rgba(71,85,105,0.85)';
        var shapes = [];
        var ssAnnotations = [];
        for (var sti = 0; sti < ssThresholds.length; sti++) {
            var st = ssThresholds[sti];
            shapes.push({
                type: 'line', xref: 'paper', yref: 'y',
                x0: 0, x1: 1, y0: st.y, y1: st.y,
                line: { color: gridStroke, width: 1, dash: 'dot' },
                layer: 'below',
            });
            // Label at the LEFT edge, just inside the plot. The data
            // starts low (~30 kt at +0h), so the upper-category labels
            // (C1–C5) sit in empty space and don't overlap the curve —
            // and the right side is freed for the legend.
            ssAnnotations.push({
                x: 0, y: st.y, xref: 'paper', yref: 'y',
                xanchor: 'left', yanchor: 'middle', xshift: 3,
                text: st.label, showarrow: false,
                font: { size: 8.5, color: gridLabelColor,
                        family: 'DM Sans, sans-serif' },
            });
        }

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
                size: 7,
                color: meanArr,
                colorscale: _GENESIS_SS_SCALE,
                cmin: 0, cmax: 200,
                // Subtle hairline outline; the prior 1px slate outline
                // dominated the markers and made them read as "blobby"
                // chips of color rather than data points.
                line: { color: isDark ? 'rgba(255,255,255,0.45)'
                                       : 'rgba(15,22,35,0.30)',
                        width: 0.5 },
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
            // SS labels now sit inside the left edge and the legend is
            // an inset (top-right, inside the plot), so the right margin
            // no longer needs reserved space — was r:126, which still
            // clipped the legend on the narrow storm card.
            margin: { l: 52, r: 16, t: 24, b: 60 },
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
            annotations: (stats.genesisMedianTau != null ? [{
                x: '+' + stats.genesisMedianTau + 'h',
                y: maxY * 0.97, xref: 'x', yref: 'y',
                text: 'median genesis', showarrow: false,
                font: { size: 9, color: '#f97316' },
                xanchor: 'left', xshift: 4,
            }] : []).concat(ssAnnotations),
            showlegend: true,
            legend: {
                // Inset at the top-right INSIDE the plot. The data is
                // low there (high lead time → weak storm), so the legend
                // sits over empty space and — unlike the old x:1.005
                // right-margin placement — can't be clipped by the
                // narrow card's container edge.
                x: 0.985, y: 0.98, xanchor: 'right', yanchor: 'top',
                bgcolor: isDark ? 'rgba(15,22,35,0.82)'
                                : 'rgba(255,255,255,0.88)',
                bordercolor: isDark ? 'rgba(255,255,255,0.10)'
                                    : 'rgba(15,22,35,0.10)',
                borderwidth: 1,
                font: { size: 9, color: isDark ? '#e2e8f0' : '#1f2937' },
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

    /* Forecast RMW evolution (figure 4).
       Per-member radius-of-maximum-wind fan-chart over lead time, in
       nautical miles. RMW is only physically meaningful once a member
       has a closed TC-strength circulation, so we gate each contributing
       point on wind ≥ 34 kt. Taus with fewer than 3 qualifying members
       are dropped to avoid 1-member "envelopes" that read as noise. The
       chart mirrors the intensity envelope's nested-ribbon fan so the
       two read as a matched pair. */
    function _renderGenesisRMW(memberKeys, members, stats) {
        var el = document.getElementById('rt-genesis-modal-rmw');
        if (!el || typeof Plotly === 'undefined') return;
        var theme = _genesisTheme();
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var KM_TO_NM = 0.5399568;

        // Bucket RMW (nm) by tau — TC-strength points only.
        var byTau = {};
        for (var i = 0; i < memberKeys.length; i++) {
            var pts = members[memberKeys[i]].points || [];
            for (var j = 0; j < pts.length; j++) {
                var p = pts[j];
                if (p.rmw_km == null || p.wind == null || p.wind < 34) continue;
                var t = p.tau;
                if (!byTau[t]) byTau[t] = [];
                byTau[t].push(p.rmw_km * KM_TO_NM);
            }
        }
        // Keep only taus with enough members for a stable distribution.
        var taus = Object.keys(byTau).map(Number).sort(function (a, b) {
            return a - b;
        }).filter(function (t) { return byTau[t].length >= 3; });

        if (!taus.length) {
            Plotly.react(el, [], Object.assign({}, theme, {
                margin: { l: 55, r: 12, t: 26, b: 42 },
                paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
                title: { text: 'Forecast radius of maximum wind',
                         x: 0, xanchor: 'left',
                         font: { size: 11, color: theme.font.color } },
                annotations: [{
                    xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
                    text: 'No member sustains TC strength (≥34 kt) with a '
                        + 'reported RMW in this cycle.',
                    showarrow: false,
                    font: { size: 12, color: theme.font.color },
                }],
                xaxis: { visible: false }, yaxis: { visible: false },
            }), { responsive: true, displayModeBar: false });
            return;
        }

        function pct(sorted, q) {
            if (!sorted.length) return null;
            var idx = Math.min(sorted.length - 1,
                               Math.max(0, Math.floor(q * (sorted.length - 1))));
            return sorted[idx];
        }
        var minArr = [], maxArr = [];
        var p10Arr = [], p25Arr = [], p50Arr = [], p75Arr = [], p90Arr = [];
        var nArr = [];
        for (var ti = 0; ti < taus.length; ti++) {
            var sorted = byTau[taus[ti]].slice().sort(function (a, b) { return a - b; });
            minArr.push(sorted[0]);
            maxArr.push(sorted[sorted.length - 1]);
            p10Arr.push(pct(sorted, 0.10));
            p25Arr.push(pct(sorted, 0.25));
            p50Arr.push(pct(sorted, 0.50));
            p75Arr.push(pct(sorted, 0.75));
            p90Arr.push(pct(sorted, 0.90));
            nArr.push(sorted.length);
        }
        var xVals = taus.map(function (t) { return '+' + t + 'h'; });

        var traces = [];
        function pushRibbon(low, high, fill, name) {
            traces.push({
                type: 'scatter', mode: 'lines', x: xVals, y: low,
                line: { color: 'rgba(0,0,0,0)' },
                showlegend: false, hoverinfo: 'skip',
            });
            traces.push({
                type: 'scatter', mode: 'lines', x: xVals, y: high,
                line: { color: 'rgba(0,0,0,0)' },
                fill: 'tonexty', fillcolor: fill,
                name: name, hoverinfo: 'skip', showlegend: true,
            });
        }
        // Teal/cyan ramp distinguishes the RMW fan from the orange
        // intensity fan at a glance (different physical quantity).
        pushRibbon(minArr, maxArr,
            isDark ? 'rgba(34,211,238,0.08)' : 'rgba(8,145,178,0.07)',
            'min – max');
        pushRibbon(p10Arr, p90Arr,
            isDark ? 'rgba(34,211,238,0.14)' : 'rgba(8,145,178,0.13)',
            'P10 – P90');
        pushRibbon(p25Arr, p75Arr,
            isDark ? 'rgba(34,211,238,0.20)' : 'rgba(8,145,178,0.19)',
            'P25 – P75 (IQR)');
        traces.push({
            type: 'scatter', mode: 'lines+markers', x: xVals, y: p50Arr,
            line: { color: isDark ? '#22d3ee' : '#0891b2', width: 2.4 },
            marker: { size: 5, color: isDark ? '#22d3ee' : '#0891b2',
                      line: { color: isDark ? 'rgba(255,255,255,0.45)'
                                            : 'rgba(15,22,35,0.30)', width: 0.5 } },
            name: 'median (P50)',
            customdata: nArr,
            hovertemplate: '%{x}<br>median RMW: %{y:.0f} nm'
                + '<br>%{customdata} members ≥34 kt<extra></extra>',
            showlegend: true,
        });

        var maxY = Math.max(60, Math.max.apply(null, maxArr) + 8);
        // Genesis-median reference, if it falls inside the qualifying window.
        var shapes = [];
        var annotations = [];
        if (stats.genesisMedianTau != null
            && taus.indexOf(stats.genesisMedianTau) !== -1) {
            shapes.push({
                type: 'line', xref: 'x', yref: 'paper',
                x0: '+' + stats.genesisMedianTau + 'h',
                x1: '+' + stats.genesisMedianTau + 'h',
                y0: 0, y1: 1,
                line: { color: '#f97316', width: 1.5, dash: 'dash' },
            });
            annotations.push({
                x: '+' + stats.genesisMedianTau + 'h', y: maxY * 0.97,
                xref: 'x', yref: 'y', text: 'median genesis',
                showarrow: false, font: { size: 9, color: '#f97316' },
                xanchor: 'left', xshift: 4,
            });
        }
        var layout = Object.assign({}, theme, {
            margin: { l: 52, r: 16, t: 26, b: 60 },
            paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
            title: { text: 'Forecast radius of maximum wind (members ≥34 kt)',
                     x: 0, xanchor: 'left',
                     font: { size: 11, color: theme.font.color } },
            xaxis: { title: { text: 'Lead time', font: { size: 11 },
                              standoff: 14 },
                     tickfont: { size: 10 },
                     tickmode: 'array',
                     tickvals: xVals.filter(function (_v, i) { return i % 4 === 0; }),
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)' },
            yaxis: { title: { text: 'RMW (nm)', font: { size: 11 } },
                     range: [0, maxY],
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)' },
            shapes: shapes,
            annotations: annotations,
            showlegend: true,
            legend: {
                x: 0.985, y: 0.98, xanchor: 'right', yanchor: 'top',
                bgcolor: isDark ? 'rgba(15,22,35,0.82)'
                                : 'rgba(255,255,255,0.88)',
                bordercolor: isDark ? 'rgba(255,255,255,0.10)'
                                    : 'rgba(15,22,35,0.10)',
                borderwidth: 1,
                font: { size: 9, color: isDark ? '#e2e8f0' : '#1f2937' },
                itemsizing: 'constant', itemwidth: 30, tracegroupgap: 0,
            },
        });
        Plotly.react(el, traces, layout,
                     { responsive: true, displayModeBar: false });
    }

    /* LMI distribution (figure 5).
       1-D histogram of each member's lifetime-max Vmax (peak across the
       whole forecast). Bars colored by SS category; mean + percentile
       summary annotated. Ports the named-storm _rtRenderLmiHist to the
       genesis modal's theme and stats object. */
    function _renderGenesisLmiHist(stats) {
        var el = document.getElementById('rt-genesis-modal-lmi');
        if (!el || typeof Plotly === 'undefined') return;
        var theme = _genesisTheme();
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        var lmi = (stats.peakWinds || []).filter(function (w) {
            return w != null && w > 0;
        });
        if (!lmi.length) {
            Plotly.react(el, [], Object.assign({}, theme, {
                margin: { l: 45, r: 12, t: 30, b: 36 },
                paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
                title: { text: 'Lifetime max intensity distribution',
                         x: 0, xanchor: 'left',
                         font: { size: 11, color: theme.font.color } },
                annotations: [{ xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
                    text: 'No member intensity data in this cycle.',
                    showarrow: false,
                    font: { size: 12, color: theme.font.color } }],
                xaxis: { visible: false }, yaxis: { visible: false },
            }), { responsive: true, displayModeBar: false });
            return;
        }

        var binSize = 5;
        var binCenters = [], binCounts = [], binColors = [];
        for (var b = 0; b < 185; b += binSize) {
            var center = b + binSize / 2;
            var count = 0;
            for (var wi = 0; wi < lmi.length; wi++) {
                if (lmi[wi] >= b && lmi[wi] < b + binSize) count++;
            }
            if (count > 0 || (b >= 20 && b <= 160)) {
                binCenters.push(center);
                binCounts.push(count);
                binColors.push(_dmWindColor(center));
            }
        }
        var sorted = lmi.slice().sort(function (a, b) { return a - b; });
        var p = function (q) { return sorted[Math.floor(q / 100 * (sorted.length - 1))]; };
        var mean = lmi.reduce(function (a, b) { return a + b; }, 0) / lmi.length;

        var trace = {
            x: binCenters, y: binCounts, type: 'bar', width: binSize * 0.9,
            marker: { color: binColors,
                      line: { color: isDark ? 'rgba(0,0,0,0.3)'
                                            : 'rgba(15,22,35,0.18)', width: 0.5 } },
            hovertemplate: '%{x:.0f} kt<br>%{y} members<extra></extra>',
            showlegend: false,
        };
        var gridStroke = isDark ? 'rgba(148,163,184,0.18)'
                                 : 'rgba(100,116,139,0.22)';
        var shapes = [34, 64, 83, 96, 113, 137].map(function (v) {
            return { type: 'line', x0: v, x1: v, y0: 0, y1: 1, yref: 'paper',
                     line: { color: gridStroke, width: 1, dash: 'dot' } };
        });
        shapes.push({ type: 'line', x0: mean, x1: mean, y0: 0, y1: 1, yref: 'paper',
                      line: { color: '#f97316', width: 1.5 } });

        var cats = [['C1+', 64], ['C3+', 96], ['C5', 137]];
        var catProbs = {};
        for (var ci = 0; ci < cats.length; ci++) {
            var cnt = lmi.filter(function (w) { return w >= cats[ci][1]; }).length;
            catProbs[cats[ci][0]] = Math.round(cnt / lmi.length * 100);
        }
        // Percentiles + category odds combined into one block parked in
        // the empty top-right of the plot (LMI mass sits at low kt, so the
        // high-kt corner is free). Keeps it clear of the title (top-left)
        // and the ⤓ PNG button (top-right, outside the plot).
        var statText = 'P10 / P50 / P90: ' + p(10).toFixed(0) + ' / '
            + p(50).toFixed(0) + ' / ' + p(90).toFixed(0) + ' kt<br>'
            + 'C1+: ' + catProbs['C1+'] + '%   C3+: ' + catProbs['C3+']
            + '%   C5: ' + catProbs['C5'] + '%';

        var layout = Object.assign({}, theme, {
            margin: { l: 45, r: 12, t: 30, b: 36 },
            paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
            title: { text: 'Lifetime max intensity distribution',
                     x: 0, xanchor: 'left',
                     font: { size: 11, color: theme.font.color } },
            xaxis: { title: { text: 'LMI Vmax (kt)', font: { size: 10 } },
                     range: [0, 185], dtick: 20, tickfont: { size: 10 },
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)', zeroline: false },
            yaxis: { title: { text: 'Members', font: { size: 10 } },
                     tickfont: { size: 10 },
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)', zeroline: false },
            shapes: shapes,
            annotations: [
                { x: 0.99, y: 0.97, xref: 'paper', yref: 'paper', text: statText,
                  showarrow: false, align: 'right',
                  font: { size: 9, color: theme.font.color },
                  xanchor: 'right', yanchor: 'top' },
            ],
            bargap: 0.08, showlegend: false,
        });
        Plotly.react(el, [trace], layout,
                     { responsive: true, displayModeBar: false });
    }

    /* LMI vs forecast hour (figure 6).
       2-D density of (lead time of peak, peak Vmax) across members —
       shows WHEN and HOW STRONG members peak at a single glance. Ports
       the named-storm _rtRenderLmiVsTau heatmap to the genesis modal,
       driven by stats.peakTaus / stats.peakWinds. */
    function _renderGenesisLmiVsTau(stats) {
        var el = document.getElementById('rt-genesis-modal-lmitau');
        if (!el || typeof Plotly === 'undefined') return;
        var theme = _genesisTheme();
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        var peakTaus = stats.peakTaus || [];
        var peakWinds = stats.peakWinds || [];
        var xPeakTau = [], yPeakVmax = [];
        for (var mi = 0; mi < peakWinds.length; mi++) {
            if (peakTaus[mi] == null || peakWinds[mi] == null
                || peakWinds[mi] <= 0) continue;
            xPeakTau.push(peakTaus[mi]);
            yPeakVmax.push(peakWinds[mi]);
        }
        if (!xPeakTau.length) {
            Plotly.react(el, [], Object.assign({}, theme, {
                margin: { l: 45, r: 60, t: 30, b: 36 },
                paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
                title: { text: 'LMI vs forecast hour',
                         x: 0, xanchor: 'left',
                         font: { size: 11, color: theme.font.color } },
                annotations: [{ xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
                    text: 'No member intensity data in this cycle.',
                    showarrow: false,
                    font: { size: 12, color: theme.font.color } }],
                xaxis: { visible: false }, yaxis: { visible: false },
            }), { responsive: true, displayModeBar: false });
            return;
        }

        var tauMax = Math.max.apply(null, xPeakTau);
        var vmaxMax = Math.max(160, Math.max.apply(null, yPeakVmax) + 10);

        var heatmap = {
            x: xPeakTau, y: yPeakVmax, type: 'histogram2d',
            xbins: { start: 0, end: tauMax + 12, size: 12 },
            ybins: { start: 0, end: vmaxMax, size: 10 },
            colorscale: [
                [0.00, 'rgba(255,247,237,0)'],
                [0.05, 'rgba(255,237,213,0.85)'],
                [0.20, 'rgba(254,215,170,1.0)'],
                [0.40, 'rgba(253,186,116,1.0)'],
                [0.60, 'rgba(251,146, 60,1.0)'],
                [0.80, 'rgba(249,115, 22,1.0)'],
                [1.00, 'rgba(194, 65, 12,1.0)'],
            ],
            hovertemplate:
                'Lead time of peak: <b>%{x:.0f} h</b><br>'
                + 'LMI Vmax: <b>%{y:.0f} kt</b><br>'
                + 'Members: <b>%{z:.0f}</b><extra></extra>',
            showscale: true,
            // Horizontal under the plot on phone-width viewports (matches
            // the track-map colorbar treatment); vertical on the right
            // otherwise. The layout bottom margin grows in tandem below so
            // the horizontal bar isn't clipped.
            colorbar: _genesisNarrow() ? {
                title: { text: 'Members', side: 'top',
                         font: { size: 9, family: 'DM Sans, sans-serif',
                                 color: theme.font.color } },
                orientation: 'h',
                thickness: 8, len: 1, outlinewidth: 0,
                x: 0.5, xanchor: 'center', y: -0.32, yanchor: 'top',
                tickfont: { size: 8, family: 'DM Sans, sans-serif',
                            color: theme.font.color },
                xpad: 0, ypad: 0,
            } : {
                title: { text: 'Members', font: { size: 9,
                         family: 'DM Sans, sans-serif', color: theme.font.color },
                         side: 'right' },
                thickness: 6, len: 0.85, outlinewidth: 0,
                tickfont: { size: 8, family: 'DM Sans, sans-serif',
                            color: theme.font.color },
                xpad: 4, ypad: 0,
            },
        };
        var gridStroke = isDark ? 'rgba(148,163,184,0.18)'
                                 : 'rgba(100,116,139,0.22)';
        var ssLines = [34, 64, 83, 96, 113, 137].map(function (v) {
            return { type: 'line', x0: 0, x1: tauMax + 12, y0: v, y1: v,
                     line: { color: gridStroke, width: 1, dash: 'dot' } };
        });
        // Reclaim the right margin (reserved for the vertical colorbar) and
        // give the bottom room for the horizontal bar when narrow.
        var lmiTauMargin = _genesisNarrow()
            ? { l: 45, r: 12, t: 30, b: 78 }
            : { l: 45, r: 60, t: 30, b: 40 };
        var layout = Object.assign({}, theme, {
            margin: lmiTauMargin,
            paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
            title: { text: 'LMI vs forecast hour',
                     x: 0, xanchor: 'left',
                     font: { size: 11, color: theme.font.color } },
            xaxis: { title: { text: 'Lead time of peak (h)', font: { size: 10 } },
                     range: [0, tauMax + 12], dtick: 24, tickfont: { size: 10 },
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)', zeroline: false },
            yaxis: { title: { text: 'LMI Vmax (kt)', font: { size: 10 } },
                     range: [0, vmaxMax], dtick: 30, tickfont: { size: 10 },
                     gridcolor: isDark ? 'rgba(255,255,255,0.06)'
                                       : 'rgba(15,22,35,0.06)', zeroline: false },
            shapes: ssLines,
            hovermode: 'closest',
        });
        Plotly.react(el, [heatmap], layout,
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

    function _dataURLToBlob(dataURL) {
        var parts = dataURL.split(',');
        var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
        var bin = atob(parts[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
    }

    // Deliver a generated PNG to the user. On mobile the <a download> +
    // click() trick is unreliable — iOS Safari ignores the download
    // attribute and the image either navigates away or never reaches the
    // camera roll. Prefer the Web Share API (native "Save Image" sheet)
    // when the device can share files; fall back to a download anchor on
    // desktop, and to opening the image in a new tab where even that is
    // unsupported (older iOS) so the user can long-press to save.
    function _saveImageBlob(blob, filename) {
        var file = null;
        try { file = new File([blob], filename, { type: 'image/png' }); }
        catch (e) { /* File ctor unsupported — fall through to download */ }
        if (file && navigator.canShare && typeof navigator.share === 'function'
                && navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file] }).catch(function (err) {
                // User dismissed the sheet — don't second-guess them.
                if (err && (err.name === 'AbortError'
                            || err.name === 'NotAllowedError')) return;
                _downloadOrOpenBlob(blob, filename);
            });
            return;
        }
        _downloadOrOpenBlob(blob, filename);
    }

    function _downloadOrOpenBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        if ('download' in a) {
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } else {
            window.open(url, '_blank');
        }
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    // ── Composite summary exports ───────────────────────────────────────
    // Three flavors, each a single stitched PNG built from the live Plotly
    // panels via Plotly.toImage + a canvas:
    //   • overall   — track map + intensity envelope + genesis-time histogram
    //   • intensity — intensity envelope + LMI distribution + LMI-vs-hour map
    //   • trends    — run-to-run formation bars + track trend + intensity trend
    // One stitcher (`_genesisRenderComposite`) drives all three; the spec just
    // lists which panels go in and how tall each renders. Delivery is either a
    // download or opening the rendered PNG in a new tab ('view').
    var _GENESIS_SUMMARY_SPECS = {
        overall: {
            subSuffix: '',
            usesMap: true,
            panels: [
                { el: 'rt-genesis-modal-map',    h: 1000 },
                { el: 'rt-genesis-modal-int',    h: 760 },
                { el: 'rt-genesis-modal-gtime',  h: 540, optional: true },
            ],
        },
        intensity: {
            subSuffix: ' · Intensity summary',
            usesMap: false,
            // Composite the same orthographic locator globe the overall
            // summary's track map carries, onto the top (intensity) panel —
            // so the intensity figure is geographically self-contained.
            globeInset: true,
            panels: [
                { el: 'rt-genesis-modal-int',    h: 640 },
                { el: 'rt-genesis-modal-lmi',    h: 560, optional: true },
                { el: 'rt-genesis-modal-lmitau', h: 640, optional: true },
            ],
        },
        trends: {
            subSuffix: ' · Run-to-run trends',
            usesMap: false,
            panels: [
                { el: 'rt-genesis-modal-trend-chart', h: 380, optional: true },
                { el: 'rt-genesis-modal-trendmap',    h: 720, optional: true },
                { el: 'rt-genesis-modal-trendint',    h: 620, optional: true },
            ],
        },
    };

    // True when the composite has at least its required panels rendered
    // right now (optional panels may legitimately be absent — no
    // genesis-time histogram, or a trends panel with no multi-cycle
    // history). Used to gate the buttons and to bail before opening a
    // view tab we'd only have to close.
    function _genesisCompositeReady(kind) {
        var spec = _GENESIS_SUMMARY_SPECS[kind];
        if (!spec) return false;
        var anyReady = false;
        for (var i = 0; i < spec.panels.length; i++) {
            var p = spec.panels[i];
            var el = document.getElementById(p.el);
            var ready = !!(el && el.data && el.data.length);
            if (!p.optional && !ready) return false;
            if (ready) anyReady = true;
        }
        return anyReady;
    }

    // Click dispatcher. Renders the requested composite, then either
    // downloads it or shows it in a new tab. For the view path the tab is
    // opened SYNCHRONOUSLY here (in the user-gesture) so the async render
    // doesn't get the popup blocked — mobile Safari rejects window.open
    // called later from a Promise.
    function _genesisSummaryAction(kind, mode, btn) {
        if (!_genesisCompositeReady(kind)) return;
        var viewWin = null;
        if (mode === 'view') {
            viewWin = window.open('', '_blank');
            if (viewWin && viewWin.document) {
                try {
                    viewWin.document.write(
                        '<title>TC-ATLAS — rendering…</title>'
                        + '<body style="margin:0;background:#0f172a;color:#94a3b8;'
                        + 'font:14px system-ui,sans-serif;display:flex;'
                        + 'align-items:center;justify-content:center;height:100vh;">'
                        + 'Rendering ' + kind + ' summary…</body>');
                } catch (e) { /* cross-origin guard — ignore */ }
            }
        }
        _genesisRenderComposite(kind, btn, function (blob, filename) {
            if (mode === 'view') {
                var url = URL.createObjectURL(blob);
                if (viewWin && !viewWin.closed) {
                    try { viewWin.location.href = url; }
                    catch (e) { window.open(url, '_blank'); }
                } else if (!window.open(url, '_blank')) {
                    // Popup blocked outright — fall back to a download so
                    // the user still ends up with the figure.
                    _saveImageBlob(blob, filename);
                }
                setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
                _ga('rt_genesis_view_summary', { kind: kind });
            } else {
                _saveImageBlob(blob, filename);
                _ga('rt_genesis_save_summary_png', { kind: kind });
            }
        }, function () {
            // Render failed/aborted — close the placeholder tab so it
            // doesn't hang on "Rendering…".
            if (viewWin && !viewWin.closed) { try { viewWin.close(); } catch (e) {} }
        });
    }

    // Render the orthographic locator globe as a standalone square PNG, so
    // it can be composited onto a non-map panel (the intensity summary's top
    // panel). Reuses the LIVE track map's geo2 config + rotation center, so
    // the globe is byte-for-byte the same projection/center as the one in the
    // overall summary — no recomputation, guaranteed consistency. Resolves to
    // an HTMLImageElement, or null if the map isn't available (graceful skip).
    function _genesisRenderGlobeInset(px) {
        return new Promise(function (resolve) {
            try {
                if (typeof Plotly === 'undefined') return resolve(null);
                var mapEl = document.getElementById('rt-genesis-modal-map');
                if (!mapEl || !mapEl.layout || !mapEl.layout.geo2) return resolve(null);
                var geo2 = _jsonClone(mapEl.layout.geo2);
                geo2.domain = { x: [0, 1], y: [0, 1] };   // fill the square
                var rot = (geo2.projection && geo2.projection.rotation) || {};
                var marker = {
                    type: 'scattergeo', geo: 'geo', mode: 'markers',
                    lon: [rot.lon != null ? rot.lon : 0],
                    lat: [rot.lat != null ? rot.lat : 0],
                    marker: { size: 9, color: '#ef4444', symbol: 'circle',
                              line: { color: '#ffffff', width: 1.5 } },
                    hoverinfo: 'skip', showlegend: false,
                };
                var fig = {
                    data: [marker],
                    layout: {
                        geo: geo2,
                        margin: { l: 0, r: 0, t: 0, b: 0 },
                        paper_bgcolor: 'rgba(0,0,0,0)',
                        plot_bgcolor: 'rgba(0,0,0,0)',
                        showlegend: false,
                    },
                };
                Plotly.toImage(fig, { format: 'png', width: px, height: px })
                    .then(function (u) {
                        var im = new Image();
                        im.onload = function () { resolve(im); };
                        im.onerror = function () { resolve(null); };
                        im.src = u;
                    })
                    .catch(function () { resolve(null); });
            } catch (e) { resolve(null); }
        });
    }

    // Generic stitcher: header strip + each available panel + footer onto
    // one canvas, then hand the PNG blob to `onBlob(blob, filename)`.
    // `onError` (optional) fires if anything throws/aborts so the caller
    // can clean up (e.g. close a placeholder view tab).
    function _genesisRenderComposite(kind, btn, onBlob, onError) {
        function fail() { if (onError) onError(); }
        if (typeof Plotly === 'undefined') { fail(); return; }
        var spec = _GENESIS_SUMMARY_SPECS[kind];
        if (!spec) { fail(); return; }

        // Resolve which panels actually have a rendered Plotly figure now.
        var panels = [];
        for (var i = 0; i < spec.panels.length; i++) {
            var p = spec.panels[i];
            var el = document.getElementById(p.el);
            var ready = !!(el && el.data && el.data.length);
            if (!ready) {
                if (p.optional) continue;
                fail(); return;   // required panel missing → don't half-render
            }
            panels.push({ el: el, h: p.h });
        }
        if (!panels.length) { fail(); return; }

        var origText = btn ? btn.textContent : null;
        if (btn) { btn.textContent = 'Rendering…'; btn.disabled = true; }
        function restoreBtn() {
            if (btn) { btn.textContent = origText; btn.disabled = false; }
        }

        // Density-mode square markers don't scale under Plotly.toImage, so
        // — only when this composite includes the track map — repaint it in
        // Members mode for the export and restore afterward.
        var modeWasDensity = false;
        if (spec.usesMap && _genesisTauState && _genesisTauState.mode === 'density'
                && _genesisTauState.taus) {
            modeWasDensity = true;
            var tau = _genesisTauState.taus[_genesisTauState.idx];
            _genesisTauState.mode = 'members';
            _genesisPaintTauCursor(tau, _genesisTauState.byTau[tau] || []);
        }
        function restoreMode() {
            if (modeWasDensity && _genesisTauState) {
                _genesisTauState.mode = 'density';
                var t = _genesisTauState.taus[_genesisTauState.idx];
                _genesisPaintTauCursor(t, _genesisTauState.byTau[t] || []);
            }
        }

        var W = 1800, HEAD = 180, GAP = 18, FOOT = 64;
        // Scale Plotly fonts ~2.8× so labels/ticks/legends/colorbars look
        // proportional at 1800-px export width (markers + line widths
        // scale inside _figForExport).
        var FONT_SCALE = 2.8;
        var totalH = HEAD + FOOT;
        for (var pi = 0; pi < panels.length; pi++) {
            totalH += panels[pi].h + (pi > 0 ? GAP : 0);
        }

        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var bg = isDark ? '#0f172a' : '#ffffff';
        var ink = isDark ? '#f1f5f9' : '#0f172a';
        var dim = isDark ? '#94a3b8' : '#475569';

        var titleEl = document.getElementById('rt-genesis-modal-title');
        var subEl   = document.getElementById('rt-genesis-modal-sub');
        var title = titleEl ? titleEl.textContent : 'FNV3 cyclogenesis ensemble';
        var sub = subEl ? subEl.textContent.replace(/\s+/g, ' ').trim() : '';
        // Strip the live "Next cycle ~Nm" countdown — meaningless offline.
        sub = sub.replace(/\s*·\s*Next cycle[^·]*/i, '').trim();
        sub = (sub + (spec.subSuffix || '')).trim();

        var tasks = panels.map(function (p) {
            return Plotly.toImage(_figForExport(p.el, FONT_SCALE),
                                  { format: 'png', width: W, height: p.h });
        });

        // Optional locator globe (intensity summary) — rendered in parallel
        // with the panels; resolves to null and is skipped if unavailable.
        var globeProm = spec.globeInset
            ? _genesisRenderGlobeInset(420) : Promise.resolve(null);

        Promise.all([
            Promise.all(tasks).then(function (urls) {
                return Promise.all(urls.map(function (u) {
                    return new Promise(function (res, rej) {
                        var im = new Image();
                        im.onload = function () { res(im); };
                        im.onerror = rej;
                        im.src = u;
                    });
                }));
            }),
            globeProm,
        ]).then(function (results) {
            var imgs = results[0];
            var globeImg = results[1];
            var canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = totalH;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, W, totalH);

            ctx.fillStyle = ink;
            ctx.font = '600 56px Inter, "Helvetica Neue", sans-serif';
            ctx.textBaseline = 'top';
            ctx.fillText(title, 40, 32);
            ctx.fillStyle = dim;
            ctx.font = '34px Inter, "Helvetica Neue", sans-serif';
            ctx.fillText(sub, 40, 108);

            var y = HEAD;
            for (var k = 0; k < imgs.length; k++) {
                ctx.drawImage(imgs[k], 0, y);
                y += panels[k].h + GAP;
            }

            // Overlay the locator globe in the top-right interior of the top
            // panel. The Saffir-Simpson category labels (TS/C1…C5) hug the
            // LEFT edge, so the right side stays clear; the only thing up
            // there is the thin top of the max-Vmax envelope. The disc is
            // opaque so it reads cleanly over the gridlines behind it.
            if (globeImg && panels.length) {
                var gSize = Math.round(panels[0].h * 0.30);
                var gx = W - gSize - Math.round(W * 0.02);
                var gy = HEAD + Math.round(panels[0].h * 0.045);
                ctx.drawImage(globeImg, gx, gy, gSize, gSize);
            }

            ctx.fillStyle = dim;
            ctx.font = '24px Inter, "Helvetica Neue", sans-serif';
            var saved = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
            ctx.fillText('TC-ATLAS · DeepMind FNV3 LARGE_ENSEMBLE · saved ' + saved,
                         40, totalH - 44);

            canvas.toBlob(function (blob) {
                restoreBtn();
                restoreMode();
                if (!blob) { fail(); return; }
                var dateISO = new Date().toISOString().slice(0, 10);
                var slug = title.replace(/[^a-z0-9]+/gi, '-')
                                .replace(/^-+|-+$/g, '').toLowerCase()
                                .slice(0, 40) || 'summary';
                onBlob(blob, 'tc-atlas-genesis-' + kind + '-' + slug
                             + '-' + dateISO + '.png');
            }, 'image/png');
        }).catch(function (err) {
            console.warn('[Genesis] ' + kind + ' summary export failed', err);
            restoreBtn();
            restoreMode();
            fail();
        });
    }

    function _genesisSavePNG(elId, slug) {
        var el = document.getElementById(elId);
        if (!el || typeof Plotly === 'undefined') return;
        var rect = el.getBoundingClientRect();
        var dateISO = new Date().toISOString().slice(0, 10);
        // Bake an opaque background into the export. Plotly.toImage on the
        // raw element produces a transparent PNG, which renders as broken
        // (invisible light-theme text on dark viewers, or a colorless
        // backdrop) — see the genesis "Lifetime max intensity" report.
        // The on-screen genesis charts are already theme-aware, so we
        // clone the live figure and only force paper/plot bg to match the
        // current theme; all other colors carry over correctly.
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var bgColor = isDark ? '#0f172a' : '#ffffff';
        var fig = (el.data && el.layout)
            ? { data: _jsonClone(el.data), layout: _jsonClone(el.layout) }
            : el;
        if (fig.layout) {
            fig.layout.paper_bgcolor = bgColor;
            fig.layout.plot_bgcolor = bgColor;
        }
        Plotly.toImage(fig, {
            format: 'png',
            width: Math.round(rect.width * 2),
            height: Math.round(rect.height * 2),
        }).then(function (url) {
            _saveImageBlob(_dataURLToBlob(url),
                'tc-atlas-genesis-' + slug + '-' + dateISO + '.png');
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

    // True on phone-width viewports. Used to lay the genesis-modal
    // colorbars out horizontally (under the panel) instead of as a tall
    // right-side strip that's disproportionate on a narrow modal.
    function _genesisNarrow() {
        return typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(max-width: 720px)').matches;
    }

    // Vmax category colorbar for the track-map ensemble-mean markers.
    // Horizontal under the map on mobile, vertical on the right otherwise.
    function _genesisVmaxColorbar() {
        var cb = {
            tickvals: [0, 34, 64, 83, 96, 113, 137, 170],
            ticktext: ['0', '34 TS', '64 C1', '83 C2',
                       '96 C3', '113 C4', '137 C5', '170+'],
            tickfont: { size: 11 },
            ticklen: 4,
            outlinewidth: 0,
        };
        if (_genesisNarrow()) {
            cb.orientation = 'h';
            cb.title = { text: 'Vmax (kt)', side: 'top', font: { size: 10 } };
            cb.thickness = 12;
            cb.len = 1;
            cb.x = 0.5; cb.xanchor = 'center';
            // Sits in the bottom band the track-map layout reserves on
            // narrow (geo.domain.y starts at 0.15 there).
            cb.y = 0.02; cb.yanchor = 'bottom';
            // Drop the category letters when horizontal — eight two-token
            // labels crowd a phone-width bar; the boundary values still read.
            cb.ticktext = ['0', '34', '64', '83', '96', '113', '137', '170+'];
            cb.tickfont = { size: 9 };
        } else {
            cb.orientation = 'v';
            cb.title = { text: 'Vmax (kt)', side: 'right', font: { size: 11 } };
            cb.thickness = 14;
            cb.len = 0.7;
        }
        return cb;
    }

    // Write the genesis menu status line. The headline count is the number
    // of DISTURBANCES (clustered density-peaks) — i.e. the markers actually
    // drawn on the map — not the raw DeepMind genesis-track count, which is
    // typically several times larger and was the source of the "banner says
    // 23, map shows 5" mismatch. The raw track count is kept as secondary
    // context. Called once after the ensemble payload lands (count may be a
    // client-side estimate at that point) and again after the server cluster
    // index resolves, so the headline refines to the uncapped server count.
    function _updateGenesisBanner() {
        var statusEl = document.getElementById('ir-genesis-status');
        if (!statusEl) return;
        var data = _rtGenesisData;
        var nTracks = (data && data.n_tracks) ? data.n_tracks : 0;
        var init = data && data.init_time;
        var initBit = init
            ? ' · init ' + init.slice(0, 8) + ' ' + init.slice(8) + 'Z' : '';
        var ageBit = (data && data.cycle_age_hours != null)
            ? ' · ' + _formatGenesisAge(data.cycle_age_hours) : '';
        if (nTracks === 0) {
            statusEl.textContent = 'No genesis predicted in next 15 days'
                + (init ? initBit + ageBit : '');
            return;
        }
        // Disturbance count = the markers _renderGenesis() actually draws
        // (same _genesisDisturbances() call), so banner ≡ map by construction.
        var nDist = 0;
        try { nDist = _genesisDisturbances(data.tracks || []).length; }
        catch (e) { nDist = 0; }
        var head, trackBit;
        if (nDist > 0) {
            head = nDist + ' disturbance' + (nDist === 1 ? '' : 's');
            trackBit = ' · ' + nTracks + ' genesis track'
                + (nTracks === 1 ? '' : 's');
        } else {
            // No cluster cleared the min-member floor — fall back to the raw
            // track count rather than reading "0 disturbances" while tracks
            // are present.
            head = nTracks + ' genesis track' + (nTracks === 1 ? '' : 's');
            trackBit = '';
        }
        statusEl.textContent = head + trackBit + initBit + ageBit;
    }

    // Fetch the server's precomputed TC-ATLAS clusters for the current
    // cycle + current tuner params. Replaces the old per-track prefetch
    // approach: one ~50 KB request, instant render, no per-user ~8 MB
    // download, no client-side clustering CPU. Server caches by
    // (init_time, params) so the default-param result is served from
    // RAM after the first hit each cycle.
    function _loadGenesisClusters() {
        if (_rtGenesisClustersLoading) return;
        // The cluster index is computed server-side for the LATEST cycle
        // only. When the user has stepped back to a past run, skip it —
        // _renderGenesis falls back to client-side TCA on the pinned data.
        if (_genesisActiveCycle) return;
        var curParams = _genesisCurrentClusterParams();
        // The clusters endpoint resolves the latest cycle itself, so it
        // doesn't need _rtGenesisData — we can fetch it in parallel with the
        // 9 MB genesis payload. The "already have it" short-circuit only
        // applies once we have data to compare the init against.
        if (_rtGenesisData
                && _rtGenesisClusters
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
                // Refine the banner now that uncapped server clusters are in —
                // the headline disturbance count may differ from the earlier
                // client-side estimate.
                _updateGenesisBanner();
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

    // ── Run-to-run cycle trend: stepper across recent DeepMind runs ──
    var _genesisCycleListLoading = false;

    function _fmtGenesisInit(it) {
        if (!it || it.length < 10) return '(unknown)';
        return it.slice(0, 4) + '-' + it.slice(4, 6) + '-' + it.slice(6, 8)
            + ' ' + it.slice(8, 10) + 'Z';
    }

    // Fetch the list of recent published cycles for the stepper. Degrades
    // silently: if the endpoint isn't deployed (older backend), the list
    // stays empty and the stepper hides — the latest-cycle path is intact.
    function _loadGenesisCycleList() {
        if (_genesisCycleListLoading) return;
        _genesisCycleListLoading = true;
        fetch(API_BASE + '/ir-monitor/weatherlab-genesis-cycles?count=4',
              { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                _genesisCycleList = (json && json.cycles) || [];
                // If the pinned cycle has aged out of the window, fall back
                // to following the latest again so the stepper stays valid.
                if (_genesisActiveCycle && !_genesisCycleList.some(function (c) {
                    return c.init_time === _genesisActiveCycle;
                })) {
                    _genesisActiveCycle = null;
                }
                _updateGenesisCycleBar();
            })
            .catch(function () {
                _genesisCycleList = [];
                _updateGenesisCycleBar();
            })
            .finally(function () { _genesisCycleListLoading = false; });
    }

    // Step the displayed cycle. dir < 0 → older run, dir > 0 → newer run.
    // List is freshest-first, so older = higher index. Reaching index 0
    // unpins (resumes following the latest, with auto-repoll).
    function _genesisStepCycle(dir) {
        if (!_genesisCycleList.length) return;
        var curInit = _genesisActiveCycle || _genesisCycleList[0].init_time;
        var idx = _genesisCycleList.findIndex(function (c) {
            return c.init_time === curInit;
        });
        if (idx < 0) idx = 0;
        var next = idx + (dir < 0 ? 1 : -1);
        next = Math.max(0, Math.min(_genesisCycleList.length - 1, next));
        if (next === idx) return;
        _genesisActiveCycle = (next === 0) ? null
            : _genesisCycleList[next].init_time;
        _updateGenesisCycleBar();
        _loadGenesis();   // re-fetch + re-render the selected cycle
        _ga('rt_genesis_cycle_step', {
            dir: dir < 0 ? 'older' : 'newer',
            init: _genesisActiveCycle || _genesisCycleList[0].init_time,
            pinned: !!_genesisActiveCycle,
        });
    }

    // Create (once) and update the floating cycle stepper. Shown only
    // when the cyclogenesis layer is active and we have a cycle list.
    function _updateGenesisCycleBar() {
        var bar = document.getElementById('ir-genesis-cycle-bar');
        var show = _rtGenesisVisible && _genesisCycleList.length > 1;
        if (!bar) {
            if (!show) return;
            bar = document.createElement('div');
            bar.id = 'ir-genesis-cycle-bar';
            bar.className = 'ir-genesis-cycle-bar';
            bar.innerHTML =
                '<button type="button" class="ir-gen-cyc-btn" data-dir="older"'
                + ' title="Older DeepMind run">◀</button>'
                + '<div class="ir-gen-cyc-label">'
                + '<span class="ir-gen-cyc-title">DeepMind run</span>'
                + '<span class="ir-gen-cyc-init"></span></div>'
                + '<button type="button" class="ir-gen-cyc-btn" data-dir="newer"'
                + ' title="Newer DeepMind run">▶</button>';
            bar.querySelector('[data-dir="older"]')
                .addEventListener('click', function () { _genesisStepCycle(-1); });
            bar.querySelector('[data-dir="newer"]')
                .addEventListener('click', function () { _genesisStepCycle(1); });
            document.body.appendChild(bar);
        }
        bar.style.display = show ? '' : 'none';
        if (!show) return;

        var list = _genesisCycleList;
        var curInit = _genesisActiveCycle || list[0].init_time;
        var idx = list.findIndex(function (c) { return c.init_time === curInit; });
        if (idx < 0) idx = 0;
        var isLatest = (idx === 0);
        var cyc = list[idx] || {};
        var initEl = bar.querySelector('.ir-gen-cyc-init');
        initEl.textContent = _fmtGenesisInit(curInit)
            + (isLatest ? ' · latest' : '')
            + (cyc.n_tracks != null
                ? ' · ' + cyc.n_tracks + ' track' + (cyc.n_tracks === 1 ? '' : 's')
                : '');
        var older = bar.querySelector('[data-dir="older"]');
        var newer = bar.querySelector('[data-dir="newer"]');
        older.disabled = (idx >= list.length - 1);
        newer.disabled = (idx <= 0);
        bar.classList.toggle('is-pinned', !isLatest);
    }

    // Transient on-map toast announcing that cyclogenesis disturbances
    // just populated. The markers themselves can land a few seconds
    // (cold backend cache) or up to 30 min (a new cycle on a long-open
    // tab) after the user first looked at the map — without this, they
    // silently appear and a user who already glanced away misses them.
    var _genesisToastTimer = null;
    function _genesisAnnounceArrival(nDisturbances, isAutoRefresh) {
        if (!map || typeof map.getContainer !== 'function') return;
        var container = map.getContainer();
        if (!container) return;
        // Replace any toast still on screen so we never stack them.
        var prev = container.querySelector('.rt-gen-toast');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        if (_genesisToastTimer) { clearTimeout(_genesisToastTimer); _genesisToastTimer = null; }

        var plural = nDisturbances === 1 ? '' : 's';
        var lead = isAutoRefresh ? 'Updated forecast · ' : '';
        var toast = document.createElement('div');
        toast.className = 'rt-gen-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.innerHTML =
            '<span class="rt-gen-toast-dot"></span>'
            + '<span class="rt-gen-toast-body">'
            + '<b>' + lead + nDisturbances + ' cyclogenesis disturbance' + plural + '</b>'
            + '<span class="rt-gen-toast-sub">Google DeepMind ensemble · tap a marker for the 1000-member detail</span>'
            + '</span>'
            + '<span class="rt-gen-toast-close" aria-label="Dismiss">×</span>';

        function dismiss() {
            if (_genesisToastTimer) { clearTimeout(_genesisToastTimer); _genesisToastTimer = null; }
            toast.classList.add('rt-gen-toast--out');
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 320);
        }
        toast.addEventListener('click', dismiss);
        container.appendChild(toast);
        // Drop below the GIBS feed-staleness banner when it's showing so
        // the two top-center notices don't stack on top of each other.
        var banner = document.getElementById('ir-feed-banner');
        if (banner && getComputedStyle(banner).display !== 'none') {
            var bRect = banner.getBoundingClientRect();
            var cRect = container.getBoundingClientRect();
            var topPx = Math.max(14, Math.round(bRect.bottom - cRect.top) + 16);
            toast.style.top = topPx + 'px';
        }
        // Auto-dismiss after long enough to read, short enough to stay
        // unobtrusive. Tab-hidden re-polls don't reach here (the repoll
        // is gated on visibilityState), so the timer always counts down
        // while the user is actually looking.
        _genesisToastTimer = setTimeout(dismiss, 8000);
        _ga('rt_genesis_toast', { n_disturbances: nDisturbances, auto: !!isAutoRefresh });
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

        // Fire the lightweight (~50 KB) cluster index fetch in PARALLEL with
        // the 9 MB ensemble payload below. The clusters carry the exact
        // uncapped probabilities; fetching them alongside (rather than after)
        // the big download means they usually land first, so the first paint
        // shows real probabilities instead of the capped estimate.
        _loadGenesisClusters();

        // Keep the cycle list fresh so the stepper can reach newly-published
        // runs. Independent of the main fetch; failure just hides the stepper.
        _loadGenesisCycleList();

        var _genQs = _genesisActiveCycle
            ? '?init_time=' + encodeURIComponent(_genesisActiveCycle) : '';
        fetch(API_BASE + '/ir-monitor/weatherlab-genesis' + _genQs, { cache: 'no-store' })
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
                    // Announce a fresh cycle's disturbances so they don't
                    // populate unnoticed. Fires on first load (prevInit
                    // null) and whenever a newer cycle arrives — but only
                    // when there's something to see and the layer is on.
                    var nNow = (data && data.n_tracks) ? data.n_tracks : 0;
                    if (newInit && newInit !== prevInit && nNow > 0 && _rtGenesisVisible) {
                        // Announce the DISTURBANCE (cluster) count so the
                        // toast matches the markers on the map — not n_tracks,
                        // which reads several times higher (the "27 vs ~5"
                        // mismatch). May be a client-side estimate if the
                        // server cluster index hasn't landed yet; close enough
                        // for a transient toast. Skip if nothing clusters.
                        var nDistToast = 0;
                        try { nDistToast = _genesisDisturbances(data.tracks || []).length; }
                        catch (e) { nDistToast = 0; }
                        if (nDistToast > 0) {
                            _genesisAnnounceArrival(nDistToast, isAutoRefresh);
                        }
                    }
                    // Fetch the server's precomputed TCA clusters so
                    // the on-map markers show accurate uncapped counts
                    // without any client-side clustering work.
                    _loadGenesisClusters();
                }

                // Banner reports the disturbance (cluster) count so it
                // matches the markers on the map. May start as a client-side
                // estimate; refined when _loadGenesisClusters() resolves.
                _updateGenesisBanner();
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
            // Drop the matched-storm set so the previously-suppressed
            // ATCF pins + name labels come back on the satellite-only view.
            _genesisMatchedAtcfIds = {};
            if (typeof renderStormMarkers === 'function' && stormData) {
                try { renderStormMarkers(stormData); } catch (e) { /* non-fatal */ }
            }
            _syncStormLabelVisibility();
        }
        _updateGenesisCycleBar();
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
                _GENESIS_ASSIGN_RADIUS_KM    = 1000;
                _GENESIS_TIME_WINDOW_H       = 60;
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
        if (w < 160) return _DM_SS_COLORS.C5;
        // Super-C5: the SS scale ends at C5, but members forecast far
        // stronger. Keep the C5 violet hue and step it so off-the-charts
        // bins don't flatline at one purple (mirrors the genesis map
        // colorbar, _GENESIS_SS_SCALE). Direction is background-dependent:
        // on the dark theme lighten toward white-hot like the map; on the
        // light theme deepen toward royal violet, since a near-white bar
        // would vanish on a white plot.
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (w < 180) return isDark ? '#b9a3f9' : '#7c3aed';   // 160–180 kt
        return isDark ? '#f0e9ff' : '#5b21b6';                 // ≥180 kt
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
        _rtRenderLmiVsTau();
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
            font: { family: 'DM Sans, sans-serif', size: 9, color: '#5b6573' },
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
            font: { family: 'DM Sans, sans-serif', size: 9, color: '#5b6573' },
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
            font: { family: 'DM Sans, sans-serif', size: 9, color: '#5b6573' },
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

    /** 2D density: for each ensemble member, find (lead time of peak,
     *  peak Vmax). Plot as a histogram2d heatmap so the user sees both
     *  WHEN the bulk of members peak and HOW STRONG those peaks are at
     *  a single glance. Complements the 1D LMI histogram above. */
    function _rtRenderLmiVsTau() {
        if (!_rtDmEnsData || typeof Plotly === 'undefined') return;
        var chartEl = document.getElementById('rt-dm-lmi-tau-chart');
        if (!chartEl) return;

        var intensity = _rtDmEnsData.intensity || {};
        var taus = (_rtDmEnsData.lead_times_h || []).slice();
        var nMembers = _rtDmEnsData.n_members || 0;
        if (taus.length === 0 || nMembers === 0) return;

        // Per-member argmax across taus → (peak-tau, peak-vmax) pairs.
        var xPeakTau = [];
        var yPeakVmax = [];
        for (var mi = 0; mi < nMembers; mi++) {
            var maxW = -Infinity;
            var argmaxTau = null;
            for (var ti = 0; ti < taus.length; ti++) {
                var tauKey = String(Math.round(taus[ti]));
                var data = intensity[tauKey];
                if (data && data.winds && data.winds[mi] != null) {
                    if (data.winds[mi] > maxW) {
                        maxW = data.winds[mi];
                        argmaxTau = taus[ti];
                    }
                }
            }
            if (argmaxTau != null && maxW > -Infinity) {
                xPeakTau.push(argmaxTau);
                yPeakVmax.push(maxW);
            }
        }
        if (xPeakTau.length === 0) return;

        var tauMax = Math.max.apply(null, taus);
        var vmaxMax = Math.max(160, Math.max.apply(null, yPeakVmax) + 10);

        var heatmap = {
            x: xPeakTau, y: yPeakVmax,
            type: 'histogram2d',
            // 12-hour x bins match the GDMI lead-time stride; 10-kt y bins
            // align with SS half-category resolution.
            xbins: { start: 0, end: tauMax, size: 12 },
            ybins: { start: 0, end: vmaxMax, size: 10 },
            // Crisp single-hue oranges ramp matching the percentile-bands
            // chart's palette. No zsmooth → individual bins read clean,
            // not the painterly blur the smoothed heatmap produced.
            colorscale: [
                [0.00, 'rgba(255,247,237,0)'],   // transparent (zero members)
                [0.05, 'rgba(255,237,213,0.85)'],
                [0.20, 'rgba(254,215,170,1.0)'],
                [0.40, 'rgba(253,186,116,1.0)'],
                [0.60, 'rgba(251,146, 60,1.0)'],
                [0.80, 'rgba(249,115, 22,1.0)'],
                [1.00, 'rgba(194, 65, 12,1.0)']
            ],
            // Per-bin hover. Plotly's histogram2d auto-supplies the bin
            // midpoint as x/y; show that plus the member count for the cell.
            hovertemplate:
                'Lead time of peak: <b>%{x:.0f} h</b><br>' +
                'LMI Vmax: <b>%{y:.0f} kt</b><br>' +
                'Members: <b>%{z:.0f}</b><extra></extra>',
            showscale: true,
            colorbar: {
                // Match the compact "DeepMind 1K" label style used elsewhere:
                // small DM-Sans title, slim bar, integer tick spacing.
                title: { text: 'Members', font: { size: 9, family: 'DM Sans, sans-serif', color: '#5b6573' }, side: 'right' },
                thickness: 6,
                len: 0.85,
                outlinewidth: 0,
                tickfont: { size: 8, family: 'DM Sans, sans-serif', color: '#5b6573' },
                xpad: 4,
                ypad: 0
            }
        };

        // SS category gridlines as faint horizontal references.
        var ssLines = [34, 64, 83, 96, 113, 137].map(function (v) {
            return {
                type: 'line', x0: 0, x1: tauMax, y0: v, y1: v,
                line: { color: 'rgba(148,163,184,0.18)', width: 1, dash: 'dot' }
            };
        });

        var layout = {
            height: 200,
            margin: { t: 12, r: 60, b: 32, l: 40 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'DM Sans, sans-serif', size: 9, color: '#5b6573' },
            xaxis: {
                title: { text: 'Lead time of peak (h)', font: { size: 9 } },
                range: [0, tauMax],
                dtick: 24,
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            yaxis: {
                title: { text: 'LMI Vmax (kt)', font: { size: 9 } },
                range: [0, vmaxMax],
                dtick: 30,
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            shapes: ssLines,
            // Hovermode: 'closest' so the tooltip snaps to the cell under
            // the cursor instead of the column-of-cells default.
            hovermode: 'closest'
        };

        // Drop staticPlot:true so users can hover over cells to read out
        // (lead time, LMI Vmax, member count). Keep the mode bar off.
        Plotly.newPlot(chartEl, [heatmap], layout, {
            displayModeBar: false, responsive: false
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
        else if (chartType === 'lmi-tau') _rtRenderLmiVsTau();

        // Map chart type to element ID and metadata
        var chartMap = {
            'intensity': { el: 'rt-dm-hist-chart', label: 'Intensity Distribution' },
            'change':    { el: 'rt-dm-change-chart', label: 'Intensity Change' },
            'lmi':       { el: 'rt-dm-lmi-chart', label: 'Lifetime Max Intensity' },
            'lmi-tau':   { el: 'rt-dm-lmi-tau-chart', label: 'LMI vs Forecast Hour' }
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
            font: { size: 16, color: textColor, family: 'DM Sans, sans-serif' },
            x: 0.5, xanchor: 'center', y: 0.98
        };
        layout.paper_bgcolor = bgColor;
        layout.plot_bgcolor = bgColor;
        layout.font = { family: 'DM Sans, sans-serif', size: 14, color: axisColor };
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

    /** Save the Intensity Forecast chart (DeepMind 1K ensemble bands, or
     *  best-track fallback) as a publication PNG. Renders in the CURRENT
     *  theme (matches the on-screen view) with a descriptive title and a
     *  TC-ATLAS + URL watermark. Clones the live Plotly figure so the
     *  on-screen chart is untouched. */
    window._irSaveIntensityChart = function () {
        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || !chartEl.data || !chartEl.data.length || typeof Plotly === 'undefined') {
            console.warn('[RT Monitor] No intensity chart to export');
            return;
        }
        _ga('ir_export_intensity', { storm: currentStormId });

        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var bgColor   = isDark ? '#0f172a' : '#ffffff';
        var textColor = isDark ? '#e2e8f0' : '#1e293b';
        var gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
        var axisColor = isDark ? '#94a3b8' : '#475569';
        var wmColor   = isDark ? '#64748b' : '#94a3b8';

        // Descriptive title from the storm + source + model init.
        var stormName = (document.getElementById('ir-detail-name') || {}).textContent || '';
        var stormId   = currentStormId || '';
        var source    = (document.getElementById('ir-intensity-source') || {}).textContent || '';
        var heading   = (document.getElementById('ir-intensity-heading') || {}).textContent || 'Intensity Forecast';
        var initTime  = (_rtDmEnsData && _rtDmEnsData.init_time) || '';
        var initFmt   = '';
        if (initTime.length >= 10) {
            initFmt = initTime.substring(4, 6) + '/' + initTime.substring(6, 8) +
                      ' ' + initTime.substring(8, 10) + 'Z';
        }
        var title = heading + ' — ' + (stormName && stormId
                        ? stormName + ' (' + stormId + ')'
                        : (stormName || stormId));
        if (source)  title += '  ·  ' + source;
        if (initFmt) title += ' — Init ' + initFmt;

        // Clone the live figure so the on-screen chart is untouched.
        var data = JSON.parse(JSON.stringify(chartEl.data));
        var layout = JSON.parse(JSON.stringify(chartEl.layout));

        layout.title = {
            text: title,
            font: { size: 14, color: textColor, family: 'DM Sans, sans-serif' },
            x: 0.5, xanchor: 'center', y: 0.97
        };
        layout.paper_bgcolor = bgColor;
        layout.plot_bgcolor = bgColor;
        layout.font = { family: 'DM Sans, sans-serif', size: 13, color: axisColor };
        layout.margin = { t: 60, r: 28, b: 92, l: 60 };
        layout.width = 820;
        layout.height = 470;
        layout.showlegend = true;
        if (layout.xaxis) {
            layout.xaxis.gridcolor = gridColor;
            layout.xaxis.tickfont = { size: 12, color: axisColor };
            if (layout.xaxis.title) layout.xaxis.title.font = { size: 13, color: textColor };
        }
        if (layout.yaxis) {
            layout.yaxis.gridcolor = gridColor;
            layout.yaxis.tickfont = { size: 12, color: axisColor };
            if (layout.yaxis.title) layout.yaxis.title.font = { size: 13, color: textColor };
        }
        // Recolor white-ish category gridlines / annotations for light theme.
        if (!isDark && layout.annotations) {
            for (var ci = 0; ci < layout.annotations.length; ci++) {
                var cann = layout.annotations[ci];
                if (cann.font && typeof cann.font.color === 'string' &&
                        cann.font.color.indexOf('255,255,255') >= 0) {
                    cann.font.color = axisColor;
                }
            }
        }
        // Watermark + URL in the bottom margin.
        layout.annotations = layout.annotations || [];
        layout.annotations.push({
            text: 'TC-ATLAS', xref: 'paper', yref: 'paper',
            x: 0, y: -0.18, showarrow: false, xanchor: 'left', yanchor: 'top',
            font: { size: 11, color: wmColor, family: 'DM Sans, sans-serif' }
        });
        layout.annotations.push({
            text: 'michaelfischerwx.github.io/TC-ATLAS', xref: 'paper', yref: 'paper',
            x: 1, y: -0.18, showarrow: false, xanchor: 'right', yanchor: 'top',
            font: { size: 11, color: wmColor, family: 'DM Sans, sans-serif' }
        });

        var tmpDiv = document.createElement('div');
        tmpDiv.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
        document.body.appendChild(tmpDiv);
        Plotly.newPlot(tmpDiv, data, layout, { displayModeBar: false }).then(function () {
            return Plotly.toImage(tmpDiv, {
                // scale 3 → 2460×1410 px (~8" at 300 DPI) for print-grade output
                format: 'png', width: layout.width, height: layout.height, scale: 3
            });
        }).then(function (dataUrl) {
            var a = document.createElement('a');
            a.href = dataUrl;
            a.download = (stormId || 'storm') + '_intensity_forecast' +
                         (initTime ? '_init' + initTime : '') +
                         '_' + (isDark ? 'dark' : 'light') + '.png';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            Plotly.purge(tmpDiv); document.body.removeChild(tmpDiv);
        }).catch(function (err) {
            console.warn('[RT Monitor] Intensity chart export failed:', err);
            if (tmpDiv.parentNode) { Plotly.purge(tmpDiv); document.body.removeChild(tmpDiv); }
        });
    };

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
                if (statusEl) statusEl.textContent = 'No scatterometer passes over this storm in the last 12 h';
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
                        if (statusEl) statusEl.textContent = 'No scatterometer passes over this storm in the last 12 h';
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
                    // Keep the section visible with a retry rather than
                    // silently vanishing — a disappearing panel reads as a
                    // bug, not as "the fetch failed, try again".
                    if (section) section.style.display = '';
                    _rtAscatLastAtcf = null;
                    _rtStatusError(statusEl, function () { _rtLoadAscatPasses(storm); },
                                   'Scatterometer data unavailable');
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
    // Predicted MW overpasses (built by mw_ingest.py --predict-passes,
    // refreshed every ~2 h). Used to tell the user when the NEXT pass per
    // sensor will scan this storm — and when it should land on TC-ATLAS.
    var _RT_MW_PREDICTIONS_URL = 'https://storage.googleapis.com/tc-atlas-microwave-nrt/passes_predicted.json';
    var _RT_MW_PREDICTIONS_TTL_MS = 10 * 60 * 1000;   // 10 min
    var _RT_MW_IMMINENT_MIN = 90;   // overpass <90 min out → flag as imminent
    // "In transit" = the satellite already flew over but the NRT product is
    // still propagating through the data pipeline (AMSR2 ~3 h, SSMIS ~3 h).
    // Once a pass's scan time is in the past the "next overpass" countdown
    // jumps to the FOLLOWING pass — so without this a user has no idea fresh
    // imagery is minutes-to-hours away. We surface the most-recent past pass
    // whose imagery hasn't landed yet, with its expected arrival time.
    var _RT_MW_INTRANSIT_COV_MIN = 0.05;  // ignore trivial grazes (<5% core)
    var _RT_MW_INTRANSIT_GRACE_MIN = 75;  // keep showing past the ETA estimate;
                                          // NRT latency is approximate, so don't
                                          // give up the instant the ETA elapses
    var _RT_MW_LANDED_MATCH_MIN = 25;     // predicted↔manifest scan-time tolerance
    var _rtMwPredictions = null;
    var _rtMwPredictionsFetchedAt = 0;
    // Sensor display order + labels for the upcoming-pass strip.
    var _RT_MW_SENSOR_ORDER = [
        { key: 'GMI',   label: 'GMI' },
        { key: 'AMSR2', label: 'AMSR2' },
        { key: 'SSMIS', label: 'SSMIS' },
        { key: 'ATMS',  label: 'ATMS' }
    ];
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
        orbits: [],   // grouped & sorted entries for the current storm
        // DOM id prefix for the current panel. Both the Global Map's
        // storm-detail right-rail (`rt-mw-storm-*`) and the Storm
        // Satellite tab's right-panel (`sat-mw-*`) hook the same loader
        // + renderer via this prefix — last-set-wins, only one panel
        // is ever visible at a time.
        prefix: 'rt-mw-storm'
    };

    var _rtMwStormRefreshTimer = null;
    var _RT_MW_STORM_REFRESH_MS = 150 * 1000;   // 2.5 min — pick up new passes

    // Poll the open Global-Map storm-detail MW panel for newly-ingested
    // passes. Refreshes silently (no "loading…" flash, list replaced
    // atomically). Self-cancels when the detail closes, the storm changes,
    // or focus moves to the Satellite tab (which runs its own refresh).
    function _rtMwStartStormRefresh() {
        if (_rtMwStormRefreshTimer) clearInterval(_rtMwStormRefreshTimer);
        var boundAtcf = _rtMwStormState.atcfId;
        _rtMwStormRefreshTimer = setInterval(function () {
            var detail = document.getElementById('ir-detail');
            var storm = _rtMwStormState.storm;
            if (!storm || _rtMwStormState.prefix !== 'rt-mw-storm'
                || _rtMwStormState.atcfId !== boundAtcf
                || !detail || detail.style.display === 'none') {
                clearInterval(_rtMwStormRefreshTimer);
                _rtMwStormRefreshTimer = null;
                return;
            }
            _rtLoadStormMwPasses(storm, undefined, true /* silent */);
        }, _RT_MW_STORM_REFRESH_MS);
    }

    function _rtMwBoundsContains(bounds, lat, lon) {
        if (!bounds || !bounds[0] || !bounds[1]) return false;
        var south = bounds[0][0], west = bounds[0][1];
        var north = bounds[1][0], east = bounds[1][1];
        if (lat < south || lat > north) return false;
        if (west <= east) return lon >= west && lon <= east;
        return lon >= west || lon <= east;   // dateline wrap
    }

    // Sensor swath half-widths (km), mirroring mw_ingest.py. Used with the
    // ingest-time center_track polyline as a cheap pre-filter: arcs whose
    // track passes farther than this from the storm never imaged it, so we
    // skip downloading their PNGs. The per-card PNG-crop check (frac <
    // _RT_MW_MIN_COVERAGE) remains the final authority — this gate only
    // matches the schedule dashboard's coverage definition in tc_mw_layer.js.
    var _RT_MW_SWATH_HALF_KM = { GMI: 445, SSMIS: 875, AMSR2: 725, ATMS: 1150 };
    var _RT_MW_SWATH_HALF_KM_DEFAULT = 900;
    // Loose by design: this is only a cheap PNG-download skip, and the
    // per-card crop check (frac < _RT_MW_MIN_COVERAGE) is the real authority.
    // 1.15 dropped genuine edge passes ~5 km short (e.g. GMI nadir 517 km from
    // a storm the swath edge actually imaged); 1.30 keeps them in the running.
    var _RT_MW_SWATH_COVER_MARGIN = 1.30;

    function _rtMwMinDistKmToTrack(track, lat, lon) {
        if (!track || !track.length) return Infinity;
        var KM_PER_DEG = 111.195;
        var cosLat = Math.cos(lat * Math.PI / 180);
        function proj(p) {
            var dLon = p[1] - lon;
            if (dLon > 180) dLon -= 360;
            else if (dLon < -180) dLon += 360;
            return [dLon * cosLat * KM_PER_DEG, (p[0] - lat) * KM_PER_DEG];
        }
        if (track.length === 1) {
            var q = proj(track[0]);
            return Math.sqrt(q[0] * q[0] + q[1] * q[1]);
        }
        var best = Infinity;
        for (var i = 0; i < track.length - 1; i++) {
            var a = proj(track[i]), b = proj(track[i + 1]);
            var vx = b[0] - a[0], vy = b[1] - a[1];
            var len2 = vx * vx + vy * vy;
            var t = len2 > 0 ? -(a[0] * vx + a[1] * vy) / len2 : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            var cx = a[0] + t * vx, cy = a[1] + t * vy;
            var d = Math.sqrt(cx * cx + cy * cy);
            if (d < best) best = d;
        }
        return best;
    }

    // Pick the storm-centered hi-res crop (if any) covering (lat, lon).
    // The ingest renders these at native ~2-5 km resolution over a small
    // window, vs the whole-arc PNG that _adaptive_grid_cap downsamples to
    // ~8-17 km/px over a wide arc. We prefer the crop whose bounds contain
    // the storm; ties (overlapping windows for nearby systems) break to
    // the nearest crop center. Returns {png_url, bounds} or null.
    function _rtMwPickCrop(entry, lat, lon) {
        var crops = entry && entry.crops;
        if (!crops || !crops.length || lat == null || lon == null) return null;
        // Storm-window crops near the dateline are stored in a continuous
        // longitude frame where east can exceed 180 (e.g. west=174,
        // east=188). The storm's reported lon may be on either side
        // (-179 ≡ 181), so test the storm lon shifted by 0/±360.
        function cropContains(b, la, lo) {
            var s = b[0][0], w = b[0][1], n = b[1][0], e = b[1][1];
            if (la < s || la > n) return false;
            return (lo >= w && lo <= e) ||
                   (lo + 360 >= w && lo + 360 <= e) ||
                   (lo - 360 >= w && lo - 360 <= e);
        }
        var best = null, bestD = Infinity;
        for (var i = 0; i < crops.length; i++) {
            var c = crops[i];
            if (!c || !c.png_url || !cropContains(c.bounds, lat, lon)) {
                continue;
            }
            var cLat = (c.bounds[0][0] + c.bounds[1][0]) / 2;
            var w = c.bounds[0][1], e = c.bounds[1][1];
            if (e < w) e += 360;                 // dateline-wrapped window
            var cLon = (w + e) / 2;
            var dLon = cLon - lon;
            while (dLon > 180) dLon -= 360;
            while (dLon < -180) dLon += 360;
            var d = (cLat - lat) * (cLat - lat) + dLon * dLon;
            if (d < bestD) { bestD = d; best = c; }
        }
        return best;
    }

    // Cheap geometric coverage gate. Prefers the center-track distance
    // test; falls back to bbox containment for entries predating the
    // center_track field (48 h rolling-window backfill).
    function _rtMwPassCoversStorm(entry, lat, lon) {
        if (!entry || lat == null || lon == null) return false;
        if (entry.center_track && entry.center_track.length) {
            var half = (_RT_MW_SWATH_HALF_KM[entry.sensor]
                        || _RT_MW_SWATH_HALF_KM_DEFAULT)
                     * _RT_MW_SWATH_COVER_MARGIN;
            return _rtMwMinDistKmToTrack(entry.center_track, lat, lon) <= half;
        }
        return _rtMwBoundsContains(entry.bounds, lat, lon);
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

    // Per-storm passes via the new server-side filter endpoint.
    // Returns a Promise of a manifest-shaped object (with `entries`
    // filtered to passes covering the storm position). Typical
    // response is 30-80 KB vs the 1 MB global manifest. Falls back
    // to the full-manifest path on any error so the UI keeps working
    // during gradual backend rollout.
    function _rtMwFetchStormPasses(storm) {
        if (!storm || storm.lat == null || storm.lon == null) {
            return _rtMwFetchManifest();
        }
        var url = API_BASE + '/microwave/nrt-storm-passes'
            + '?lat=' + encodeURIComponent(storm.lat)
            + '&lon=' + encodeURIComponent(storm.lon)
            + '&hours=24';
        return fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('per-storm passes HTTP ' + r.status);
                return r.json();
            })
            .catch(function (err) {
                console.warn('[RT MW] per-storm endpoint failed, '
                    + 'falling back to global manifest:', err);
                return _rtMwFetchManifest();
            });
    }

    // Fetch + cache the predicted-pass schedule (passes_predicted.json).
    // Resolves to the parsed payload, or null on failure (the upcoming
    // strip degrades gracefully — the past-pass list still renders).
    function _rtMwFetchPredictions() {
        var age = Date.now() - _rtMwPredictionsFetchedAt;
        if (_rtMwPredictions && age < _RT_MW_PREDICTIONS_TTL_MS) {
            return Promise.resolve(_rtMwPredictions);
        }
        return fetch(_RT_MW_PREDICTIONS_URL, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('predictions HTTP ' + r.status);
                return r.json();
            })
            .then(function (p) {
                _rtMwPredictions = p;
                _rtMwPredictionsFetchedAt = Date.now();
                return p;
            })
            .catch(function (err) {
                console.warn('[RT MW] predictions fetch failed:', err);
                return null;
            });
    }

    // Compact "time until" formatter for upcoming passes (mirror of
    // _rtMwFmtAgo for the future direction).
    function _rtMwFmtIn(min) {
        if (min <= 0)   return 'now';
        if (min < 60)   return 'in ' + Math.round(min) + ' min';
        var h = min / 60;
        if (h < 24)     return 'in ' + h.toFixed(1) + ' h';
        return 'in ' + (h / 24).toFixed(1) + ' d';
    }

    function _rtMwFmtAgo(min) {
        if (min < 1)    return 'just now';
        if (min < 60)   return Math.round(min) + ' min ago';
        var h = min / 60;
        if (h < 24)     return h.toFixed(1) + ' h ago';
        return (h / 24).toFixed(1) + ' d ago';
    }

    // Has this predicted pass already arrived in the manifest? Match by
    // sensor + scan time (predicted vs ingested can differ by a few minutes
    // since the predictor uses the orbit's closest-approach step, not the
    // granule boundary). Used to stop announcing "incoming" once the imagery
    // has actually landed in the pass list below.
    function _rtMwPassLanded(sensor, scanMs) {
        var orbits = _rtMwStormState.orbits || [];
        var tol = _RT_MW_LANDED_MATCH_MIN * 60000;
        for (var i = 0; i < orbits.length; i++) {
            if (orbits[i].sensor === sensor
                && Math.abs(orbits[i].scan_start_ms - scanMs) <= tol) {
                return true;
            }
        }
        return false;
    }

    // Turn a predicted pass's coverage geometry into a short badge.
    // coverage_frac is the fraction of the nominal inner-core disk
    // (radius coreR km) that falls inside the swath; coverage_radius_km
    // is the largest concentric radius fully imaged. Both come from the
    // predictor (passes_predicted.json). Returns null if absent (older
    // payloads) so callers can no-op gracefully.
    function _rtMwCoverage(p, coreR) {
        if (!p || !isFinite(p.coverage_frac)) return null;
        var frac = p.coverage_frac;
        var pct = Math.round(frac * 100);
        var rad = isFinite(p.coverage_radius_km)
            ? Math.round(p.coverage_radius_km) : null;
        var cls, label;
        if (frac >= 0.98)      { cls = 'full';  label = 'Full core'; }
        else if (frac >= 0.80) { cls = 'most';  label = 'Most of core'; }
        else if (frac >= 0.60) { cls = 'part';  label = 'Partial'; }
        else                   { cls = 'graze'; label = 'Grazing edge'; }
        var title = label + ' — ~' + pct + '% of inner ' + coreR + ' km'
            + (rad != null ? ', fully imaged out to ~' + rad + ' km radius' : '');
        return { cls: cls, label: label, pct: pct, radiusKm: rad, title: title };
    }

    function _rtMwDistKm(lat1, lon1, lat2, lon2) {
        var R = 6371, rad = Math.PI / 180;
        var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
        var s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
        var a = s1 * s1 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * s2 * s2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    // Match a storm to its prediction record: prefer the ATCF id, else
    // the nearest predicted storm within ~300 km (handles disturbances
    // and null/blank ATCF ids, e.g. early-season invests).
    function _rtMwPredStormFor(predictions, storm) {
        var list = (predictions && Array.isArray(predictions.storms))
            ? predictions.storms : [];
        if (!list.length || !storm) return null;
        if (storm.atcf_id) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].atcf_id === storm.atcf_id) return list[i];
            }
        }
        if (storm.lat == null || storm.lon == null) return null;
        var best = null, bestKm = Infinity;
        for (var j = 0; j < list.length; j++) {
            var ps = list[j];
            if (ps.lat == null || ps.lon == null) continue;
            var d = _rtMwDistKm(storm.lat, storm.lon, ps.lat, ps.lon);
            if (d < bestKm) { bestKm = d; best = ps; }
        }
        return bestKm <= 300 ? best : null;
    }

    // Render the per-storm "next overpass" strip into {prefix}-upcoming.
    // For each sensor: earliest future predicted pass, shown as time-to-scan
    // with the ETA-on-TC-ATLAS (scan + NRT latency) so users know both when
    // the satellite flies over AND when the imagery will appear here.
    function _rtRenderStormUpcomingPasses(storm, prefixOverride) {
        var px = prefixOverride || _rtMwStormState.prefix || 'rt-mw-storm';
        var box = document.getElementById(px + '-upcoming');
        if (!box) return;
        var reqAtcf = storm && storm.atcf_id;
        _rtMwFetchPredictions().then(function (pred) {
            if (!storm) return;
            // When driven by the shared loader (no override) the storm may
            // have changed while we were fetching; guard against that. When
            // called directly with an override (e.g. satellite.js), trust
            // the caller's storm reference.
            if (!prefixOverride && _rtMwStormState.atcfId !== reqAtcf) return;
            if (!pred) { box.style.display = 'none'; return; }
            var predStorm = _rtMwPredStormFor(pred, storm);
            var passes = (predStorm && Array.isArray(predStorm.passes))
                ? predStorm.passes : [];
            var now = Date.now();
            var horizonBySensor = pred.horizon_by_sensor || {};
            // Earliest future pass per sensor.
            var next = {};
            // In-transit: most-recent PAST scan per sensor whose imagery
            // hasn't landed yet (still inside the NRT latency window, not yet
            // in the manifest). Surfaced so the user knows fresh imagery is
            // inbound even though the countdown has rolled to the next pass.
            var incoming = {};
            for (var i = 0; i < passes.length; i++) {
                var p = passes[i];
                if (!p.sensor) continue;
                var t = Date.parse(p.predicted_scan_start);
                if (!isFinite(t)) continue;
                if (t > now) {
                    if (!next[p.sensor] || t < Date.parse(next[p.sensor].predicted_scan_start)) {
                        next[p.sensor] = p;
                    }
                    continue;
                }
                // Past scan — candidate for "in transit".
                if (isFinite(p.coverage_frac) && p.coverage_frac < _RT_MW_INTRANSIT_COV_MIN) continue;
                var eta = Date.parse(p.eta_on_tcatlas);
                if (!isFinite(eta)) continue;
                if (eta + _RT_MW_INTRANSIT_GRACE_MIN * 60000 < now) continue;  // long overdue — assume it won't arrive
                if (_rtMwPassLanded(p.sensor, t)) continue;                    // already on TC-ATLAS
                if (!incoming[p.sensor] || t > Date.parse(incoming[p.sensor].predicted_scan_start)) {
                    incoming[p.sensor] = p;
                }
            }
            var anyUpcoming = Object.keys(next).length > 0
                || Object.keys(incoming).length > 0;
            if (!predStorm) {
                // No prediction record for this system (e.g. just-formed,
                // or predictions stale) — hide rather than show an empty grid.
                box.style.display = 'none';
                return;
            }
            box.style.display = '';
            var coreR = Math.round(pred.coverage_core_radius_km || 200);
            var cells = [];
            for (var s = 0; s < _RT_MW_SENSOR_ORDER.length; s++) {
                var sk = _RT_MW_SENSOR_ORDER[s].key;
                var sLabel = _RT_MW_SENSOR_ORDER[s].label;
                var swatch = _RT_MW_SENSOR_COLOR[sk] || '#cbd5e1';
                var valHtml, cellTitle, farClass = '', covHtml = '';
                if (incoming[sk]) {
                    // Imagery in the NRT pipeline — flag it and estimate arrival.
                    var ip = incoming[sk];
                    var agoMin = (now - Date.parse(ip.predicted_scan_start)) / 60000;
                    var ipEtaMin = (Date.parse(ip.eta_on_tcatlas) - now) / 60000;
                    var ipCov = _rtMwCoverage(ip, coreR);
                    farClass = ' incoming-data';
                    var etaLabel = ipEtaMin > 0 ? _rtMwFmtIn(ipEtaMin) : 'any moment';
                    var nextNote = next[sk]
                        ? ' · next overpass ' + _rtMwFmtIn((Date.parse(next[sk].predicted_scan_start) - now) / 60000)
                        : '';
                    cellTitle = 'Overpass ' + _rtMwFmtAgo(agoMin)
                        + ' · in NRT transfer · imagery expected ' + etaLabel
                        + (ipCov ? ' · ' + ipCov.title : '')
                        + nextNote;
                    valHtml = '<span class="rt-mw-up-incoming">INCOMING</span>'
                        + '<span class="rt-mw-up-eta">' + _esc(etaLabel) + '</span>';
                    if (ipCov) {
                        covHtml = '<span class="rt-mw-up-cov ' + ipCov.cls + '">'
                            + '<span class="rt-mw-up-dot"></span>'
                            + _esc(ipCov.label) + '</span>';
                    }
                } else if (next[sk]) {
                    var p = next[sk];
                    var deltaMin = (Date.parse(p.predicted_scan_start) - now) / 60000;
                    var etaMin = (Date.parse(p.eta_on_tcatlas) - now) / 60000;
                    var isFar = deltaMin > 24 * 60;
                    // Imminent = overpass within ~90 min, so the strip visually
                    // flags an approaching pass instead of reading as plain text.
                    var isImminent = !isFar && deltaMin <= _RT_MW_IMMINENT_MIN;
                    farClass = isFar ? ' far' : (isImminent ? ' imminent' : '');
                    var off = isFinite(p.min_distance_km)
                        ? Math.round(p.min_distance_km) + ' km from center' : '';
                    var cov = _rtMwCoverage(p, coreR);
                    cellTitle = 'Scan ' + _rtMwFmtIn(deltaMin)
                        + ' · imagery on TC-ATLAS ' + _rtMwFmtIn(etaMin)
                        + (off ? ' · nadir ' + off : '')
                        + (cov ? ' · ' + cov.title : '')
                        + (isImminent ? ' · imminent — overpass soon' : '')
                        + (isFar ? ' · beyond 24h (sparse single-sat coverage)' : '');
                    valHtml = (isImminent ? '<span class="rt-mw-up-soon">SOON</span> ' : '')
                        + _esc(_rtMwFmtIn(deltaMin))
                        + '<span class="rt-mw-up-eta">&rarr; ' + _esc(_rtMwFmtIn(etaMin)) + '</span>';
                    if (cov) {
                        covHtml = '<span class="rt-mw-up-cov ' + cov.cls + '">'
                            + '<span class="rt-mw-up-dot"></span>'
                            + _esc(cov.label) + '</span>';
                    }
                } else {
                    var hz = horizonBySensor[sk] || 24;
                    cellTitle = 'No predicted pass within ' + Math.round(hz) + ' h';
                    valHtml = '<span class="rt-mw-up-none">&mdash;</span>';
                }
                cells.push(
                    '<div class="rt-mw-up-cell' + farClass + '" title="' + _esc(cellTitle) + '">'
                    + '<span class="rt-mw-up-sensor">'
                    +   '<span class="rt-mw-up-swatch" style="background:' + swatch + '"></span>'
                    +   _esc(sLabel)
                    + '</span>'
                    + '<span class="rt-mw-up-val">' + valHtml + '</span>'
                    + covHtml
                    + '</div>'
                );
            }
            var hasIncoming = Object.keys(incoming).length > 0;
            var note = hasIncoming
                ? 'INCOMING = overpass done, imagery in NRT transfer (est. arrival)'
                : (anyUpcoming
                    ? 'Time to next overpass &rarr; when imagery lands here'
                    : 'No overpasses predicted in the current window');
            box.innerHTML =
                '<div class="rt-mw-up-title">Next overpass</div>'
                + '<div class="rt-mw-up-grid">' + cells.join('') + '</div>'
                + '<div class="rt-mw-up-note">' + note + '</div>';
        });
    }

    // Entry point — called from the deferred-loads block once a storm
    // is selected. Fetches the manifest, filters to last-24h passes
    // covering the storm, groups by orbit, and renders.
    function _rtLoadStormMwPasses(storm, prefix, silent) {
        if (prefix) _rtMwStormState.prefix = prefix;
        var px = _rtMwStormState.prefix;
        var section  = document.getElementById(px + '-section');
        var statusEl = document.getElementById(px + '-status');
        var listEl   = document.getElementById(px + '-list');
        if (!section || !storm || storm.lat == null || storm.lon == null) {
            if (section) section.style.display = 'none';
            return;
        }
        section.style.display = '';
        // Silent (auto-refresh) re-runs keep the existing cards on screen until
        // the new render replaces them — no "loading…" flash, no blank gap.
        if (!silent) {
            if (statusEl) statusEl.textContent = 'loading…';
            if (listEl) listEl.innerHTML = '';
        }

        _rtMwStormState.atcfId = storm.atcf_id;
        _rtMwStormState.lat = storm.lat;
        _rtMwStormState.lon = storm.lon;
        _rtMwStormState.storm = storm;

        // Upcoming-pass strip (independent of the past-pass list — renders
        // into {prefix}-upcoming when present; no-op otherwise).
        _rtRenderStormUpcomingPasses(storm);

        // Keep the Global-Map storm-detail panel live. The Satellite tab
        // (sat-mw) drives its own refresh loop in satellite.js.
        if (px === 'rt-mw-storm') _rtMwStartStormRefresh();

        _rtMwFetchStormPasses(storm)
            .then(function (m) {
                if (_rtMwStormState.atcfId !== storm.atcf_id) return;  // moved on
                var entries = (m && m.entries) || [];
                var nowMs = Date.now();
                var orbitMap = {};
                for (var i = 0; i < entries.length; i++) {
                    var e = entries[i];
                    var t = Date.parse(e.scan_start);
                    if (!isFinite(t) || (nowMs - t) > _RT_MW_WINDOW_MS) continue;
                    if (!_rtMwPassCoversStorm(e, storm.lat, storm.lon)) continue;
                    var oid = e.orbit_id;
                    if (!orbitMap[oid]) {
                        orbitMap[oid] = {
                            orbit_id: oid,
                            sensor: e.sensor,
                            platform: e.platform,
                            scan_start: e.scan_start,
                            scan_start_ms: t,
                            bounds: e.bounds,
                            products: {}    // product -> { png_url, geojson_url, bounds }
                        };
                    }
                    // Each product PNG is regridded + Mercator-warped over
                    // its OWN finite-data bbox, so its bounds can differ from
                    // the orbit's first product. Store per-product bounds —
                    // the crop must un-warp using the bounds the PNG was
                    // warped with, else features land at the wrong latitude.
                    //
                    // Prefer the storm-centered hi-res crop when the ingest
                    // produced one for this storm: it's regridded at native
                    // resolution over a ±7° window instead of the
                    // _adaptive_grid_cap-downsampled whole-arc grid, so the
                    // thumbnail + compare modal render crisp (esp. AMSR2/
                    // SSMIS wide arcs). Falls back to the whole-arc PNG when
                    // no crop covers the storm (older entries, GMI, etc.).
                    var hiRes = _rtMwPickCrop(e, storm.lat, storm.lon);
                    orbitMap[oid].products[e.product] = {
                        png_url: hiRes ? hiRes.png_url : e.png_url,
                        geojson_url: e.geojson_url,
                        bounds: hiRes ? hiRes.bounds : e.bounds,
                        hi_res: !!hiRes
                    };
                }
                // Newest first — analyst typically wants "what's the latest
                // pass" at a glance; older context follows down the list.
                var orbits = Object.keys(orbitMap).map(function (k) { return orbitMap[k]; });
                orbits.sort(function (a, b) { return b.scan_start_ms - a.scan_start_ms; });
                // Skip the (thumbnail-reloading) re-render on silent refreshes
                // when the pass set is unchanged — avoids a flicker every cycle.
                var sig = orbits.map(function (o) { return o.orbit_id; }).join(',');
                var changed = sig !== _rtMwStormState._sig;
                _rtMwStormState._sig = sig;
                _rtMwStormState.orbits = orbits;
                if (statusEl) {
                    statusEl.textContent = orbits.length
                        ? (orbits.length + ' pass' + (orbits.length === 1 ? '' : 'es'))
                        : 'no passes';
                }
                if (!silent || changed) _rtRenderStormMwPasses();
            })
            .catch(function (err) {
                console.warn('[RT MW Storm] manifest fetch failed:', err);
                if (_rtMwStormState.atcfId !== storm.atcf_id) return;  // moved on
                if (listEl) listEl.innerHTML = '';
                _rtStatusError(statusEl, function () { _rtLoadStormMwPasses(storm); },
                               'Microwave passes unavailable');
            });
    }

    // Render the chronological pass list using the currently-selected
    // product (default 89pct). Each card shows: storm-cropped thumbnail,
    // sensor + platform, time-ago, full UTC timestamp. Click opens the
    // full pass PNG (full swath, not cropped) in a new tab.
    function _rtRenderStormMwPasses() {
        var px = _rtMwStormState.prefix || 'rt-mw-storm';
        var listEl = document.getElementById(px + '-list');
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
        var statusEl2 = document.getElementById(px + '-status');
        var coveredCount = 0;
        var resolvedCount = 0;
        if (statusEl2) statusEl2.textContent = 'filtering…';
        function _bumpStatus() {
            if (!statusEl2) return;
            statusEl2.textContent = coveredCount + ' pass'
                + (coveredCount === 1 ? '' : 'es');
        }
        // Some sensors only publish a subset of the standard MW products.
        // ATMS (NPP/JPSS cross-track scanner) only has 89v — no 89pct
        // (needs both V and H polarisations) and no 37 GHz at all.
        // When the user-selected product isn't available for this
        // orbit's sensor, fall back to the closest equivalent so the
        // thumbnail renders instead of showing a blank "n/a" tile.
        function _resolvedProduct(orbit, want) {
            if (orbit.products[want]) return want;
            // Fallback chain by physical-channel proximity:
            //   89pct → 89v (drop the polarisation correction)
            //   89h   → 89v
            //   37*   → 89v   (ATMS has nothing at 37 GHz)
            //   89v   → first available
            var chain = {
                '89pct':   ['89v'],
                '89h':     ['89v', '89pct'],
                '89v':     ['89pct', '89h'],
                '37color': ['37v',  '37h',   '89pct', '89v'],
                '37v':     ['37h',  '37color', '89v'],
                '37h':     ['37v',  '37color', '89v'],
            };
            var alt = chain[want] || [];
            for (var k = 0; k < alt.length; k++) {
                if (orbit.products[alt[k]]) return alt[k];
            }
            var keys = Object.keys(orbit.products);
            for (var j = 0; j < keys.length; j++) {
                if (keys[j] !== '_timed-out-skip') return keys[j];
            }
            return null;
        }

        var nowMs = Date.now();
        for (var i = 0; i < orbits.length; i++) {
            var o = orbits[i];
            var resolvedProd = _resolvedProduct(o, product);
            var pr = resolvedProd ? o.products[resolvedProd] : null;
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
                        + resolvedProd +
                        (resolvedProd !== product ? ' (substituted)' : '')
                        + ' — ' + utcStr;
                thumbWrap.appendChild(c);
                (function (cardEl) {
                    _rtDrawStormMwThumbnail(c, pr.bounds || o.bounds, lat, lon, pr.png_url,
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
                // Honest "n/a" only after the fallback chain failed.
                miss.textContent = product + ' n/a';
                miss.title = 'No ' + product + ' product available for ' +
                             o.sensor + ' (' + (o.platform || '?') + ')';
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

    // Paint the interpolated/extrapolated best-track position on a
    // storm-centered canvas. Reads _rtMwCompareState.interp, projects
    // its (lat, lon) onto the canvas using the centerLat/centerLon ±
    // halfDeg extent, and draws a small filled ring with a directional
    // hairline back to the canvas center. No-op when the interp state
    // is empty (initial paint before fetch resolves, side-panel thumbs,
    // etc).
    function _rtDrawInterpMarker(ctx, w, h, centerLat, centerLon, halfDeg) {
        var interp = _rtMwCompareState && _rtMwCompareState.interp;
        if (!interp || interp.lat == null || interp.lon == null) return;
        var dLon = interp.lon - centerLon;
        // Wrap longitudes onto the [-180, 180] range relative to center
        // so a center at 178°E with interp at -179°E (177°W) reads as
        // a +3° offset instead of -357°.
        while (dLon > 180)  dLon -= 360;
        while (dLon < -180) dLon += 360;
        var dLat = interp.lat - centerLat;
        if (Math.abs(dLat) > halfDeg || Math.abs(dLon) > halfDeg) return;
        var x = w / 2 + (dLon / (2 * halfDeg)) * w;
        var y = h / 2 - (dLat / (2 * halfDeg)) * h;   // y inverted
        ctx.save();
        // Hairline from storm-center cross to the interp position so the
        // user reads the motion vector at a glance.
        ctx.strokeStyle = 'rgba(251, 146, 60, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(w / 2, h / 2);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.setLineDash([]);
        // Filled ring at the interpolated position. Orange to contrast
        // with the yellow center cross.
        ctx.fillStyle = 'rgba(251, 146, 60, 0.9)';
        ctx.strokeStyle = 'rgba(15, 22, 36, 0.95)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

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

    // Optional `onCoverage(frac, centerFrac)` callback fires once after the
    // image loads + cropping completes. `frac` is overall swath coverage of
    // the crop; `centerFrac` is coverage of a small box at the storm center.
    // Callers use it to hide cards whose swath geometry happens not to touch
    // the storm position, or to flag passes that clipped the storm center.
    // `withGrid` (default false) draws a lat/lon graticule on top of
    // the swath — used by the compare-modal panels but not the small
    // 80-px side-panel thumbnails where a grid would just clutter.
    function _rtDrawStormMwThumbnail(canvas, bounds, lat, lon, pngUrl, onCoverage, withGrid, backdropImg) {
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
            var south = bounds[0][0], west = bounds[0][1];
            var north = bounds[1][0], east = bounds[1][1];
            // Handle dateline wrap: shift east-side bounds so west < east.
            var wWrapped = west, eWrapped = east, lonShift = lon;
            if (west > east) {
                eWrapped = east + 360;
                if (lonShift < west) lonShift += 360;
            }
            var spanLon = eWrapped - wWrapped;
            if (north <= south || spanLon <= 0) {
                if (onCoverage) onCoverage(0, 0);
                return;
            }
            var W = canvas.width, H = canvas.height;
            var HALF = _RT_MW_HALF_DEG;
            // The NRT MW PNG is Mercator-warped over [south, north] (rows
            // uniform in Mercator-y, row 0 = north) — see
            // mw_ingest._warp_eq_to_mercator_bbox. The canvas + lat/lon grid
            // here are LINEAR in latitude, so we un-warp per output row,
            // exactly like the IR panel (_rtDrawIrCompareFrame). Treating
            // the Mercator PNG as equirectangular displaced features by
            // ~0.3-0.8° at TC latitudes and misregistered MW vs IR.
            // Horizontal axis is linear in lon in both projections.
            var mercY = function (l) {
                return Math.log(Math.tan(Math.PI / 4 + l * Math.PI / 360));
            };
            var myTop = mercY(north), myBot = mercY(south);
            var srcY = function (latv) {
                return (myTop - mercY(latv)) / (myTop - myBot) * img.height;
            };
            var latMaxBox = lat + HALF;
            var lonMinBox = lonShift - HALF, lonMaxBox = lonShift + HALF;
            // Lon overlap between the ±HALF storm box and the swath bbox.
            var loLon = Math.max(lonMinBox, wWrapped);
            var hiLon = Math.min(lonMaxBox, eWrapped);
            if (hiLon > loLon) {
                var sxA = (loLon - wWrapped) / spanLon * img.width;
                var sxW = (hiLon - loLon) / spanLon * img.width;
                var dxA = (loLon - lonMinBox) / (2 * HALF) * W;
                var dxW = (hiLon - loLon) / (2 * HALF) * W;
                for (var oy = 0; oy < H; oy++) {
                    var latTop = latMaxBox - (oy / H) * (2 * HALF);
                    var latBot = latMaxBox - ((oy + 1) / H) * (2 * HALF);
                    // Skip rows whose lat band lies entirely off the swath.
                    if (latBot >= north || latTop <= south) continue;
                    var clTop = Math.min(latTop, north);
                    var clBot = Math.max(latBot, south);
                    var syA = srcY(clTop), syB = srcY(clBot);
                    if (syB - syA < 0.5) syB = syA + 0.5;
                    var dyA = (latMaxBox - clTop) / (2 * HALF) * H;
                    var dyB = (latMaxBox - clBot) / (2 * HALF) * H;
                    if (dyB - dyA < 0.5) dyB = dyA + 0.5;
                    ctx.drawImage(img, sxA, syA, sxW, syB - syA,
                                       dxA, dyA, dxW, dyB - dyA);
                }
            }

            // Measure swath coverage in the crop. CrossOrigin=anonymous
            // + the bucket's CORS config keep the canvas un-tainted so
            // getImageData succeeds. Empty swath margins leave alpha=0
            // pixels; any drawn pixel has alpha>0. We track two fractions:
            // overall coverage, and coverage of a small box at the panel
            // center (the storm), so we can tell "no swath at all" apart
            // from "swath present but it clipped the storm" — a common
            // sun-sync edge pass where the storm falls just off the swath.
            var frac = 0, centerFrac = 1;
            try {
                var W2 = canvas.width, H2 = canvas.height;
                var data = ctx.getImageData(0, 0, W2, H2).data;
                var nonEmpty = 0;
                for (var p = 3; p < data.length; p += 4) {
                    if (data[p] > 10) nonEmpty++;
                }
                frac = nonEmpty / (W2 * H2);
                // Center box: ±6% of the canvas around the storm cross.
                var cr = Math.max(2, Math.round(W2 * 0.06));
                var cx0 = (W2 / 2) | 0, cy0 = (H2 / 2) | 0;
                var cHit = 0, cTot = 0;
                for (var yy = cy0 - cr; yy <= cy0 + cr; yy++) {
                    if (yy < 0 || yy >= H2) continue;
                    for (var xx = cx0 - cr; xx <= cx0 + cr; xx++) {
                        if (xx < 0 || xx >= W2) continue;
                        cTot++;
                        if (data[(yy * W2 + xx) * 4 + 3] > 10) cHit++;
                    }
                }
                centerFrac = cTot ? cHit / cTot : 0;
            } catch (e) {
                // Tainted canvas (rare — implies CORS hiccup). Treat as
                // covered so we don't accidentally hide everything.
                frac = 1; centerFrac = 1;
            }

            // Optional day-Vis/night-SWIR satellite backdrop BEHIND the
            // swath, so the empty (non-swath) margins show surrounding
            // cloud context. The band frame is an equirectangular cutout
            // centered on the SAME interp center (lat/lon), spanning
            // ±_RT_MW_COMPARE_RADIUS — so we take the central
            // HALF/_RT_MW_COMPARE_RADIUS fraction in both axes to match
            // this ±HALF canvas extent. destination-over keeps it behind
            // the (already drawn) swath, filling only transparent pixels.
            if (backdropImg) {
                var fxB = HALF / _RT_MW_COMPARE_RADIUS;
                var sbx = backdropImg.width * (1 - fxB) / 2;
                var sby = backdropImg.height * (1 - fxB) / 2;
                var sbw = backdropImg.width * fxB;
                var sbh = backdropImg.height * fxB;
                ctx.globalCompositeOperation = 'destination-over';
                ctx.drawImage(backdropImg, sbx, sby, sbw, sbh,
                                           0, 0, canvas.width, canvas.height);
                ctx.globalCompositeOperation = 'source-over';
            }

            // Paint the dim navy bg BEHIND everything so any pixels the
            // swath + backdrop don't cover read as "no data" instead of
            // see-through to the modal bg.
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
                // Compare-modal extra: ring at the interpolated/extrapolated
                // best-track position for the MW pass time. Lives in
                // _rtMwCompareState.interp because both compare canvases
                // share the same storm-centered extent.
                _rtDrawInterpMarker(ctx, canvas.width, canvas.height,
                                    lat, lon, _RT_MW_HALF_DEG);
            }
            if (onCoverage) onCoverage(frac, centerFrac);
        };
        img.onerror = function () {
            ctx.fillStyle = 'rgba(239,68,68,0.4)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#fca5a5';
            ctx.font = '11px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('load failed', canvas.width / 2, canvas.height / 2);
            if (onCoverage) onCoverage(0, 0);
        };
        img.src = pngUrl;
    }

    // ── Colorbars for the IR ↔ MW compare panels ──────────────────
    // Palettes + value ranges mirror the server-side renderers:
    //  - 89 GHz family  → microwave_api.py NRL_89GHZ_PLOTLY_COLORSCALE
    //  - 37 GHz V/H      → microwave_api.py NRL_37GHZ_PLOTLY_COLORSCALE
    //  - IR              → satellite_ir.py Claude IR LUT (matches the
    //                      storm-card .ir-tb-legend-bar CSS gradient)
    // Gradient stop 0 = vmin (cold/scattering), stop 1 = vmax (warm).
    var _MW_CBAR_89 = [
        [0.000, '#303030'], [0.100, '#606060'], [0.225, '#800000'],
        [0.375, '#FF0000'], [0.500, '#FF8C00'], [0.535, '#FFD700'],
        [0.615, '#ADFF2F'], [0.700, '#00CC44'], [0.745, '#00DDCC'],
        [0.825, '#0066FF'], [0.875, '#0000CC'], [1.000, '#8888FF'],
    ];
    var _MW_CBAR_37 = [
        [0.000, '#CC00CC'], [0.086, '#9900CC'], [0.143, '#3333FF'],
        [0.229, '#0099FF'], [0.286, '#00CCCC'], [0.371, '#00CC66'],
        [0.429, '#33CC33'], [0.514, '#99CC00'], [0.543, '#CCCC00'],
        [0.600, '#FFD700'], [0.657, '#FFAA00'], [0.714, '#FF8800'],
        [0.743, '#FF6600'], [0.829, '#CC3300'], [0.886, '#993300'],
        [1.000, '#663300'],
    ];
    var _MW_CBAR_PRODUCT = {
        '89pct': { scale: _MW_CBAR_89, vmin: 105, vmax: 305, title: '89 PCT (K)' },
        '89v':   { scale: _MW_CBAR_89, vmin: 150, vmax: 300, title: '89V (K)' },
        '89h':   { scale: _MW_CBAR_89, vmin: 100, vmax: 290, title: '89H (K)' },
        '37v':   { scale: _MW_CBAR_37, vmin: 125, vmax: 300, title: '37V (K)' },
        '37h':   { scale: _MW_CBAR_37, vmin: 125, vmax: 300, title: '37H (K)' },
        // 37color is an RGB composite — no 1D scale; handled separately.
    };
    // Claude IR LUT (warm → cold, left → right). Same stops as the
    // .ir-tb-legend-bar CSS gradient.
    var _IR_CBAR = [
        [0.000, 'rgb(12,12,22)'],    [0.142, 'rgb(70,70,82)'],
        [0.225, 'rgb(120,120,132)'], [0.308, 'rgb(180,180,192)'],
        [0.392, 'rgb(216,218,228)'], [0.475, 'rgb(140,210,220)'],
        [0.517, 'rgb(68,180,196)'],  [0.558, 'rgb(32,148,166)'],
        [0.600, 'rgb(40,178,116)'],  [0.642, 'rgb(96,208,68)'],
        [0.683, 'rgb(192,220,40)'],  [0.725, 'rgb(238,196,48)'],
        [0.767, 'rgb(228,132,48)'],  [0.808, 'rgb(214,78,56)'],
        [0.850, 'rgb(180,36,68)'],   [0.892, 'rgb(196,48,156)'],
        [0.933, 'rgb(168,64,200)'],  [0.975, 'rgb(120,48,180)'],
        [1.000, 'rgb(64,24,140)'],
    ];

    function _rtRoundRectPath(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    /** Draw a compact horizontal colorbar in the bottom-left of a
     *  compare canvas. `labels` is an array of strings distributed
     *  left→right under the bar (first left-anchored, last
     *  right-anchored, any middle ones centered). Drawn onto the
     *  canvas so it's captured by Save PNG. */
    function _rtDrawCompareColorbar(ctx, w, h, stops, labels, title) {
        var barW = Math.min(168, w * 0.42);
        var barH = 9;
        var padL = 12, padB = 12;
        var x0 = padL;
        var yBar = h - padB - barH;
        // Panel behind the bar + labels + title.
        var panelX = x0 - 7;
        var panelY = yBar - 17;
        var panelW = barW + 14;
        var panelH = barH + 17 + 14;
        ctx.save();
        ctx.fillStyle = 'rgba(10,14,22,0.70)';
        _rtRoundRectPath(ctx, panelX, panelY, panelW, panelH, 4);
        ctx.fill();
        // Gradient bar.
        var g = ctx.createLinearGradient(x0, 0, x0 + barW, 0);
        for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
        ctx.fillStyle = g;
        ctx.fillRect(x0, yBar, barW, barH);
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, yBar + 0.5, barW - 1, barH - 1);
        // Title.
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '600 10px "DM Sans", sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillText(title, x0, yBar - 5);
        // Tick labels.
        ctx.font = '9px "DM Sans", sans-serif';
        ctx.fillStyle = 'rgba(226,232,240,0.92)';
        var ly = yBar + barH + 10;
        for (var k = 0; k < labels.length; k++) {
            var frac = labels.length === 1 ? 0 : k / (labels.length - 1);
            var lx = x0 + frac * barW;
            ctx.textAlign = (k === 0) ? 'left'
                          : (k === labels.length - 1) ? 'right' : 'center';
            ctx.fillText(labels[k], lx, ly);
        }
        ctx.restore();
    }

    /** RGB-composite legend for the 37color product (no 1D scale). */
    function _rtDraw37ColorLegend(ctx, w, h) {
        var items = [
            ['#00e0e0', 'ocean'],
            ['#ff5ae0', 'rain'],
            ['#39d353', 'ice / land'],
        ];
        var padL = 12, padB = 12;
        var rowH = 13;
        var sw = 11;
        var panelW = 92;
        var panelH = items.length * rowH + 18;
        var panelX = padL - 7;
        var panelY = h - padB - panelH + 4;
        ctx.save();
        ctx.fillStyle = 'rgba(10,14,22,0.70)';
        _rtRoundRectPath(ctx, panelX, panelY, panelW, panelH, 4);
        ctx.fill();
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '600 10px "DM Sans", sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillText('37 color', padL, panelY + 13);
        ctx.font = '9px "DM Sans", sans-serif';
        for (var i = 0; i < items.length; i++) {
            var ry = panelY + 22 + i * rowH;
            ctx.fillStyle = items[i][0];
            ctx.fillRect(padL, ry, sw, sw);
            ctx.fillStyle = 'rgba(226,232,240,0.92)';
            ctx.fillText(items[i][1], padL + sw + 5, ry + sw - 1);
        }
        ctx.restore();
    }

    /** Draw the appropriate MW colorbar/legend for the active product. */
    function _rtDrawMwCompareColorbar(ctx, w, h, product) {
        if (product === '37color') { _rtDraw37ColorLegend(ctx, w, h); return; }
        var cfg = _MW_CBAR_PRODUCT[product];
        if (!cfg) return;
        var mid = Math.round((cfg.vmin + cfg.vmax) / 2);
        _rtDrawCompareColorbar(ctx, w, h, cfg.scale,
            [String(cfg.vmin), String(mid), String(cfg.vmax)], cfg.title);
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

    // Product chip click — bound on document so both the Global Map's
    // storm-detail panel (#rt-mw-storm-products) and the Storm
    // Satellite tab's panel (#sat-mw-products) work through the same
    // listener. The chip bars use shared markup (.rt-mw-storm-chip)
    // for visual consistency; delegation keeps the JS lean.
    document.addEventListener('click', function (ev) {
        var btn = ev.target.closest && ev.target.closest('.rt-mw-storm-chip');
        if (!btn) return;
        // Ignore chips inside the compare modal — that bar has its own
        // handler that syncs both ways.
        if (btn.closest('#rt-mw-compare-modal')) return;
        var bar = btn.parentElement;
        if (!bar) return;
        var product = btn.getAttribute('data-product');
        if (!product || product === _rtMwStormState.product) return;
        _rtMwStormState.product = product;
        // Sync ALL chip bars on the page so panels switching out stay
        // visually consistent with the current selection.
        document.querySelectorAll('.rt-mw-storm-chip').forEach(function (b) {
            b.classList.toggle('active',
                b.getAttribute('data-product') === product);
        });
        _rtRenderStormMwPasses();
    });

    // Expose the loader so satellite.js (Storm Satellite tab) can
    // mount the same panel by passing prefix='sat-mw'. The compare
    // modal is already body-level, so it works from any view.
    window._rtLoadStormMwPasses = _rtLoadStormMwPasses;
    window._rtRenderStormUpcomingPasses = _rtRenderStormUpcomingPasses;
    // Low-level helpers also exposed so satellite.js's Leaflet-based
    // MW mode (Phase 1 of canvas→Leaflet migration) can do its own
    // rendering against the same manifest + interp pipeline without
    // duplicating the fetch/cache/dedup logic.
    window._rtMwFetchManifest = _rtMwFetchManifest;
    window._rtMwFetchStormPasses = _rtMwFetchStormPasses;
    window._rtMwBoundsContains = _rtMwBoundsContains;
    window._rtMwHalfDeg = function () { return _RT_MW_HALF_DEG; };
    window._rtMwWindowMs = function () { return _RT_MW_WINDOW_MS; };
    window._rtMwSensorColor = function (s) { return _RT_MW_SENSOR_COLOR[s] || '#cbd5e1'; };
    window._rtInterpTrack = _rtInterpTrack;
    window._rtFetchStormTrack = _rtFetchStormTrack;

    // Scroll the storm-detail body to the Microwave Passes section.
    // Wired to the new "Microwave" pill in the detail-header next to
    // KML / Satellite so users discover the section without having
    // to scroll the side rail. Falls back to scrolling the section
    // into the document if no scrollable ancestor matches.
    window._rtJumpToMwSection = function () {
        var section = document.getElementById('rt-mw-storm-section');
        if (!section) return;
        // Ensure the section is visible (it starts hidden until the
        // loader fires on storm-detail open).
        if (section.style.display === 'none') section.style.display = '';
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Brief highlight pulse so the user's eye lands on the panel.
        section.classList.add('ir-info-section-pulse');
        setTimeout(function () {
            section.classList.remove('ir-info-section-pulse');
        }, 1600);
    };

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
        track: null,         // cached intensity_history (with lat/lon/time)
        trackAtcf: null,     // atcf_id the track was fetched for
        interp: null,        // {lat, lon, mode, sourceTimeStr} at MW pass time
    };
    var _RT_MW_COMPARE_LOOKBACK_H = 24;  // matches MW window
    var _RT_MW_COMPARE_RADIUS = 10;      // IR JPG returns ±radius_deg box
    // Compare-canvas half-width matches the thumbnail crop so the two
    // panels show the exact same geographic extent — direct visual
    // alignment is the whole point of this view.
    var _RT_MW_COMPARE_HALF_DEG = _RT_MW_HALF_DEG;
    var _RT_MW_COMPARE_PX = 600;         // canvas display size
    // Day Visible / night SWIR satellite imagery behind the MW swath, so
    // the empty (non-swath) margins show surrounding cloud context instead
    // of flat navy. On by default; user-toggleable in the modal.
    var _rtMwCompareVisEnabled = true;
    // Min solar elevation (deg) to use Visible (vs SWIR) for the backdrop.
    // Below this, Visible Tb is near the dark floor — see _rtLoadMwCompareBackdrop.
    var _RT_MW_BACKDROP_VIS_MIN_ELEV = 12;

    // Linear interpolation / extrapolation of (lat, lon) at a target
    // time using two or more best-track fixes from intensity_history.
    // Returns {lat, lon, mode, neighborTimes} or null if not computable.
    //   mode = 'interp' (target between two fixes),
    //          'extrap-fwd' (target after last fix; linear from last 2),
    //          'extrap-bwd' (target before first fix; linear from first 2),
    //          'snap'   (only one fix available; just return it).
    function _rtInterpTrack(history, targetMs) {
        if (!history || !history.length) return null;
        var pts = history
            .map(function (h) {
                return {
                    t: Date.parse(h.time),
                    lat: h.lat, lon: h.lon,
                };
            })
            .filter(function (p) {
                return isFinite(p.t) && p.lat != null && p.lon != null;
            })
            .sort(function (a, b) { return a.t - b.t; });
        if (!pts.length) return null;
        if (pts.length === 1) {
            return { lat: pts[0].lat, lon: pts[0].lon, mode: 'snap',
                     neighborTimes: [pts[0].t] };
        }
        // Interpolation: find bracketing pair.
        for (var i = 1; i < pts.length; i++) {
            if (pts[i].t >= targetMs && pts[i - 1].t <= targetMs) {
                var a = pts[i - 1], b = pts[i];
                var dt = b.t - a.t;
                var f = dt > 0 ? (targetMs - a.t) / dt : 0;
                return {
                    lat: a.lat + f * (b.lat - a.lat),
                    lon: a.lon + f * (b.lon - a.lon),
                    mode: 'interp',
                    neighborTimes: [a.t, b.t],
                };
            }
        }
        // Extrapolation forward: target after last fix.
        if (targetMs > pts[pts.length - 1].t) {
            var n = pts.length;
            var p1 = pts[n - 2], p2 = pts[n - 1];
            var dt2 = p2.t - p1.t;
            if (dt2 <= 0) {
                return { lat: p2.lat, lon: p2.lon, mode: 'snap',
                         neighborTimes: [p2.t] };
            }
            var f2 = (targetMs - p2.t) / dt2;
            return {
                lat: p2.lat + f2 * (p2.lat - p1.lat),
                lon: p2.lon + f2 * (p2.lon - p1.lon),
                mode: 'extrap-fwd',
                neighborTimes: [p1.t, p2.t],
            };
        }
        // Extrapolation backward: target before first fix.
        var q1 = pts[0], q2 = pts[1];
        var dt3 = q2.t - q1.t;
        if (dt3 <= 0) {
            return { lat: q1.lat, lon: q1.lon, mode: 'snap',
                     neighborTimes: [q1.t] };
        }
        var f3 = (q1.t - targetMs) / dt3;
        return {
            lat: q1.lat - f3 * (q2.lat - q1.lat),
            lon: q1.lon - f3 * (q2.lon - q1.lon),
            mode: 'extrap-bwd',
            neighborTimes: [q1.t, q2.t],
        };
    }

    // Fetch + cache the storm's intensity_history (which carries
    // best-track positions at standard 00/06/12/18Z synoptic times).
    // Used by the compare modal to interpolate the storm's actual
    // position at the exact MW pass time.
    function _rtFetchStormTrack(storm) {
        if (_rtMwCompareState.trackAtcf === storm.atcf_id
                && _rtMwCompareState.track) {
            return Promise.resolve(_rtMwCompareState.track);
        }
        var url = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
            + '/metadata';
        return fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('metadata HTTP ' + r.status);
                return r.json();
            })
            .then(function (m) {
                var hist = (m && m.intensity_history) || [];
                _rtMwCompareState.track = hist;
                _rtMwCompareState.trackAtcf = storm.atcf_id;
                return hist;
            });
    }

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

        // Seed legend with latest fix (we already know it from `storm`).
        var fixLegend = document.getElementById('rt-mw-compare-legend-fix');
        if (fixLegend && storm.last_fix_utc) {
            var fixTime = storm.last_fix_utc.replace('T', ' ').slice(0, 16) + 'Z';
            fixLegend.textContent = fixTime + ' · '
                + storm.lat.toFixed(1) + '°' + (storm.lat >= 0 ? 'N' : 'S')
                + ' / ' + storm.lon.toFixed(1) + '°' + (storm.lon >= 0 ? 'E' : 'W');
        }
        var interpLegend = document.getElementById('rt-mw-compare-legend-interp');
        var interpLabel = document.getElementById('rt-mw-compare-legend-interp-label');
        if (interpLegend) interpLegend.textContent = 'computing…';
        if (interpLabel) interpLabel.textContent = 'Interpolated position';

        // Reset interp state — async fetch below will populate it.
        _rtMwCompareState.interp = null;
        _rtRenderMwCompare();   // initial paint without interp marker

        _rtFetchStormTrack(storm)
            .then(function (history) {
                if (_rtMwCompareState.orbit !== orbit) return;  // user closed/changed
                var mwMs = orbit.scan_start_ms;
                var interp = _rtInterpTrack(history, mwMs);
                _rtMwCompareState.interp = interp;
                if (interpLegend && interpLabel) {
                    if (!interp) {
                        interpLabel.textContent = 'Interpolated position';
                        interpLegend.textContent = 'no track data';
                    } else {
                        // Friendlier label based on which side of the
                        // fix window the MW pass landed.
                        var modeLabel = {
                            'interp':      'Interpolated position at MW pass',
                            'extrap-fwd':  'Extrapolated position at MW pass',
                            'extrap-bwd':  'Extrapolated position at MW pass',
                            'snap':        'Position (single track point)',
                        }[interp.mode] || 'Interpolated position';
                        interpLabel.textContent = modeLabel;
                        var passUtc = orbit.scan_start.replace('T', ' ').slice(0, 16) + 'Z';
                        interpLegend.textContent = passUtc + ' · '
                            + interp.lat.toFixed(1) + '°' + (interp.lat >= 0 ? 'N' : 'S')
                            + ' / ' + interp.lon.toFixed(1) + '°' + (interp.lon >= 0 ? 'E' : 'W');
                    }
                }
                _rtRenderMwCompare();   // repaint with the interp marker
            })
            .catch(function (err) {
                console.warn('[RT MW Compare] track fetch failed', err);
                if (interpLegend) interpLegend.textContent = 'unavailable';
            });

        _ga('rt_mw_compare_open', {
            sensor: orbit.sensor, product: _rtMwCompareState.product
        });
    }

    // Build a composite PNG of the IR + MW canvases with header (storm
    // name, sensor/platform, product), per-panel timestamps, and a
    // TC-ATLAS watermark with URL. Triggered by the modal's Save PNG
    // button. Colors of the panels are preserved — only the button itself
    // is monochrome in the UI.
    function _rtSaveMwCompare() {
        var orbit = _rtMwCompareState.orbit;
        var storm = _rtMwCompareState.storm;
        if (!orbit || !storm) return;
        var irCanvas = document.getElementById('rt-mw-compare-ir');
        var mwCanvas = document.getElementById('rt-mw-compare-mw');
        if (!irCanvas || !mwCanvas) return;

        var name = storm.name || storm.atcf_id || 'Storm';
        var sensorLabel = orbit.sensor
            + (orbit.platform ? ' (' + orbit.platform + ')' : '');
        var mwUtc = (orbit.scan_start || '').replace('T', ' ').slice(0, 16) + 'Z';
        var irTimeEl = document.getElementById('rt-mw-compare-mw-time');  // not used
        var irTime = (document.getElementById('rt-mw-compare-ir-time') || {}).textContent || '';
        var mwTime = (document.getElementById('rt-mw-compare-mw-time') || {}).textContent || mwUtc;

        // Map product slug → human label from the active chip text.
        var prodLabel = _rtMwCompareState.product;
        var chip = document.querySelector(
            '#rt-mw-compare-products .rt-mw-storm-chip[data-product="'
            + _rtMwCompareState.product + '"]');
        if (chip && chip.textContent) prodLabel = chip.textContent.trim();

        var pw = irCanvas.width, ph = irCanvas.height;
        // Layout scales with the panel size (600 px = original design
        // baseline), so the header/labels/watermark stay proportional now
        // that the source canvases render at higher resolution.
        var s = pw / 600;
        var gap = Math.round(6 * s);
        var headerH = Math.round(64 * s);
        var labelH = Math.round(24 * s);
        var footerH = Math.round(22 * s);
        var pad = Math.round(12 * s);
        var totalW = pw * 2 + gap;
        var totalH = headerH + labelH + ph + footerH;

        var comp = document.createElement('canvas');
        comp.width = totalW;
        comp.height = totalH;
        var ctx = comp.getContext('2d');

        ctx.fillStyle = '#0a0c12';
        ctx.fillRect(0, 0, totalW, totalH);

        // Header — title and metadata.
        ctx.fillStyle = '#f1f5f9';
        ctx.font = '700 ' + Math.round(18 * s) + 'px sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillText(name + ' — IR ↔ Microwave', pad, Math.round(24 * s));

        ctx.fillStyle = '#94a3b8';
        ctx.font = Math.round(13 * s) + 'px sans-serif';
        ctx.fillText(sensorLabel + ' · ' + prodLabel + ' · ' + mwUtc, pad, Math.round(46 * s));

        // Per-panel labels with timestamps.
        var labelY = headerH + Math.round(16 * s);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '700 ' + Math.round(13 * s) + 'px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('IR', pad, labelY);
        ctx.fillText('Microwave', pw + gap + pad, labelY);

        ctx.fillStyle = '#94a3b8';
        ctx.font = Math.round(11 * s) + 'px ui-monospace, "SF Mono", Menlo, monospace';
        ctx.textAlign = 'right';
        if (irTime) ctx.fillText(irTime, pw - pad, labelY);
        if (mwTime) ctx.fillText(mwTime, pw * 2 + gap - pad, labelY);

        // Panels.
        var panelY = headerH + labelH;
        ctx.drawImage(irCanvas, 0, panelY, pw, ph);
        ctx.drawImage(mwCanvas, pw + gap, panelY, pw, ph);

        // Footer watermark + URL.
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = Math.round(11 * s) + 'px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('TC-ATLAS', pad, totalH - Math.round(7 * s));
        ctx.textAlign = 'right';
        ctx.fillText('michaelfischerwx.github.io/TC-ATLAS',
                     totalW - pad, totalH - Math.round(7 * s));

        // Download.
        var stamp = (orbit.scan_start || '')
            .replace(/[:\-T]/g, '').replace('Z', '').slice(0, 12);
        var sensorSafe = (orbit.sensor || 'mw').toLowerCase().replace(/[^a-z0-9]+/g, '');
        var nameSafe = (storm.name || storm.atcf_id || 'storm')
            .toLowerCase().replace(/[^a-z0-9]+/g, '');
        var link = document.createElement('a');
        link.download = nameSafe + '_ir_vs_' + sensorSafe + '_'
            + _rtMwCompareState.product + '_' + stamp + '.png';
        link.href = comp.toDataURL('image/png');
        link.click();

        _ga('rt_mw_compare_save', {
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
    // Load the satellite-context backdrop for the MW compare panel: a
    // day-Visible (band 2) / night-SWIR (band 7) cutout matching the IR
    // frame's index (same lookback/radius/interval grid → same target
    // time + interp center). Returns an Image via `cb(img)`, or cb(null)
    // when the toggle is off, no IR frame matched, or the fetch fails
    // (the thumbnail then falls back to the dim navy bg as before). The
    // band-frame.jpg endpoint renders an equirectangular cutout centered
    // on the interp position — so _rtDrawStormMwThumbnail can crop its
    // central fraction directly (no Mercator un-warp needed).
    function _rtLoadMwCompareBackdrop(storm, frameIndex, cLat, cLon, mwMs, cb) {
        if (!_rtMwCompareVisEnabled || frameIndex == null || frameIndex < 0) {
            cb(null);
            return;
        }
        // Day → Visible; low sun / night → SWIR. The Vis panel uses a -6°
        // night cutoff, but it ALSO runs a server-side brightness dim-out
        // screen the single-frame band-frame.jpg endpoint doesn't — so a
        // Vis backdrop at a dusk/dawn pass renders near-black (measured Tb
        // crop mean ~9-16 below +12° sun vs SWIR's steady ~120-150). MW
        // sensors are sun-synchronous and frequently cross near the
        // terminator, so a -6° rule leaves the backdrop dark on common
        // passes. SWIR (3.9 µm) carries usable cloud context day and night,
        // so we only use Visible when the sun is solidly up (≥ +12°) and
        // fall back to SWIR otherwise (incl. when solar geometry is unknown).
        var band = 7;
        try {
            var sunEl = solarElevation(cLat, cLon, new Date(mwMs));
            band = (sunEl >= _RT_MW_BACKDROP_VIS_MIN_ELEV) ? 2 : 7;
        } catch (e) {}
        var url = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
            + '/band-frame.jpg?band=' + band
            + '&frame_index=' + frameIndex
            + '&lookback_hours=' + _RT_MW_COMPARE_LOOKBACK_H
            + '&radius_deg=' + _RT_MW_COMPARE_RADIUS
            + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () { cb(img); };
        img.onerror = function () { cb(null); };
        img.src = url;
    }

    // Toggle the spinner overlay on a compare panel ('ir' | 'mw'). The
    // overlay sits above the canvas so a slow PNG/JPG download reads as
    // "loading" rather than a blank panel with missing data.
    function _rtMwCompareLoading(which, on) {
        var el = document.getElementById('rt-mw-compare-' + which + '-loading');
        if (el) el.hidden = !on;
    }

    function _rtRenderMwCompare() {
        var orbit = _rtMwCompareState.orbit;
        var storm = _rtMwCompareState.storm;
        if (!orbit || !storm) return;
        var product = _rtMwCompareState.product;

        var mwCanvas = document.getElementById('rt-mw-compare-mw');
        var mwStatus = document.getElementById('rt-mw-compare-mw-status');
        var mwTimeEl = document.getElementById('rt-mw-compare-mw-time');
        if (mwTimeEl) {
            mwTimeEl.textContent =
                orbit.scan_start.replace('T', ' ').slice(0, 16) + 'Z';
        }

        // ── Common center for BOTH panels ─────────────────────────
        // Both crops + both graticules must share one reference latitude,
        // otherwise the panels misregister. storm.lat/lon is the last
        // ADVISORY fix, which can be many hours stale when JTWC skips a
        // cycle for a weak system — using it put the MW crop + grid at a
        // different latitude than the IR cutout (which the backend centers
        // on the storm's INTERPOLATED position at the frame time). We
        // resolve the common center from the closest IR frame's per-frame
        // `center` (the cutout's true center), so the IR imagery, the MW
        // crop, and the graticules all co-register. Falls back to the
        // advisory fix only if the IR meta is unavailable.
        var mwMs = orbit.scan_start_ms;

        function paintMw(cLat, cLon, frameIndex) {
            var pr = orbit.products[product];
            if (mwCanvas && pr && pr.png_url) {
                if (mwStatus) mwStatus.textContent = '';
                _rtMwCompareLoading('mw', true);   // spinner until the PNG paints
                // Load the day-Vis/night-SWIR backdrop first (async), then
                // paint the swath with it behind. Backdrop is null when the
                // toggle is off or no IR frame matched.
                _rtLoadMwCompareBackdrop(storm, frameIndex, cLat, cLon, mwMs,
                                         function (backdropImg) {
                    _rtDrawStormMwThumbnail(mwCanvas, pr.bounds || orbit.bounds, cLat, cLon,
                                            pr.png_url, function (frac, centerFrac) {
                        _rtMwCompareLoading('mw', false);
                        if (mwStatus) {
                            if (frac < _RT_MW_MIN_COVERAGE) {
                                mwStatus.textContent = 'storm sits outside the actual swath data';
                            } else if (centerFrac != null && centerFrac < 0.5) {
                                // Some swath in view, but the storm center fell
                                // off it — this overpass only clipped the storm.
                                mwStatus.textContent = 'this overpass clipped the storm — center fell at the swath edge';
                            } else {
                                mwStatus.textContent = '';
                            }
                        }
                        // Colorbar/legend for the active product, drawn after
                        // the swath image so it sits on top.
                        _rtDrawMwCompareColorbar(mwCanvas.getContext('2d'),
                            mwCanvas.width, mwCanvas.height, product);
                    }, true /* withGrid */, backdropImg);
                });
            } else if (mwCanvas) {
                _rtMwCompareLoading('mw', false);
                var ctx = mwCanvas.getContext('2d');
                ctx.fillStyle = 'rgba(15,22,36,0.55)';
                ctx.fillRect(0, 0, mwCanvas.width, mwCanvas.height);
                if (mwStatus) mwStatus.textContent = product + ' not available for this pass';
            }
        }

        // Spinner up front — the MW PNG can't paint until the IR-frames
        // meta resolves (it supplies the shared center), so show "loading"
        // immediately instead of leaving a blank panel during that fetch.
        _rtMwCompareLoading('mw', true);
        _rtMwCompareLoading('ir', true);

        // ── IR panel ──────────────────────────────────────────────
        var irCanvas = document.getElementById('rt-mw-compare-ir');
        var irStatus = document.getElementById('rt-mw-compare-ir-status');
        var irTimeEl = document.getElementById('rt-mw-compare-ir-time');
        if (irStatus) irStatus.textContent = 'finding closest IR…';
        if (irTimeEl) irTimeEl.textContent = '—';
        if (irCanvas) {
            var ctx2 = irCanvas.getContext('2d');
            ctx2.fillStyle = 'rgba(15,22,36,0.55)';
            ctx2.fillRect(0, 0, irCanvas.width, irCanvas.height);
        }

        _rtFetchIrFramesMeta(storm)
            .then(function (meta) {
                if (!meta || !meta.frames || !meta.frames.length) {
                    _rtMwCompareLoading('ir', false);
                    if (irStatus) irStatus.textContent = 'no IR frames available';
                    paintMw(storm.lat, storm.lon);  // best-effort fallback
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
                    _rtMwCompareLoading('ir', false);
                    if (irStatus) irStatus.textContent = 'no matchable IR frame';
                    paintMw(storm.lat, storm.lon);
                    return;
                }
                // Common center = this IR frame's true cutout center.
                var cLat = storm.lat, cLon = storm.lon;
                if (best.center && best.center.length === 2) {
                    cLat = best.center[0]; cLon = best.center[1];
                }
                var deltaMin = (Date.parse(best.datetime_utc) - mwMs) / 60000;
                if (irTimeEl) {
                    irTimeEl.textContent = best.datetime_utc.replace('T', ' ').slice(0, 16) + 'Z'
                        + ' (' + (deltaMin >= 0 ? '+' : '') + Math.round(deltaMin)
                        + ' min vs MW)';
                }
                if (irStatus) irStatus.textContent = 'loading IR frame…';
                // Paint MW on the SAME center so the two panels' swath/
                // imagery and graticules co-register. best.index also picks
                // the matching Vis/SWIR backdrop frame.
                paintMw(cLat, cLon, best.index);
                // Draw IR centered on cLat/cLon (its cutout center), with a
                // matching graticule.
                if (irCanvas) {
                    _rtDrawIrCompareFrame(irCanvas, storm, best.index,
                                          cLat, cLon, function (err) {
                        _rtMwCompareLoading('ir', false);
                        if (irStatus) {
                            irStatus.textContent = err
                                ? 'IR frame load failed'
                                : '';
                        }
                    });
                } else {
                    _rtMwCompareLoading('ir', false);
                }
            })
            .catch(function (err) {
                _rtMwCompareLoading('ir', false);
                console.warn('[RT MW Compare] frames-meta failed', err);
                if (irStatus) irStatus.textContent = 'IR meta unavailable';
                paintMw(storm.lat, storm.lon);  // still show MW
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
            + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;
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

    // Draw the ±_RT_MW_COMPARE_HALF_DEG crop of the IR JPG into the
    // supplied canvas. The IR JPG covers a 20° × 20° box (radius_deg = 10)
    // centered on the cutout's true center, so that center sits at image
    // center and the ±6° crop is the central 60% of the image. gLat/gLon
    // is that same center (the frame's per-frame `center` from
    // ir-frames-meta) — used for the graticule + marker so the IR grid
    // matches the IR imagery AND the MW panel (which is cropped + gridded
    // on the identical center). See _rtRenderMwCompare.
    function _rtDrawIrCompareFrame(canvas, storm, frameIndex, gLat, gLon, done) {
        // Use the DEFAULT (Mercator-warped) IR frame — it's pre-rendered and
        // cached in GCS, so it loads in ~0.5 s. The equirectangular variant
        // (warp=none) is rendered on demand and was 30–40 s. Instead of a
        // slow server render (or storing a second pre-rendered copy), we
        // fetch the fast cached Mercator frame and un-warp it to
        // equirectangular HERE, per row, so the IR panel is linear-in-lat
        // and co-registers exactly with the (equirectangular) MW panel and
        // the graticule. The Mercator cutout's rows are uniform in
        // Mercator-y over gLat ± _RT_MW_COMPARE_RADIUS.
        var url = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
            + '/ir-frame.jpg?frame_index=' + frameIndex
            + '&lookback_hours=' + _RT_MW_COMPARE_LOOKBACK_H
            + '&radius_deg=' + _RT_MW_COMPARE_RADIUS
            + '&interval_min=' + JPG_PRIMARY_INTERVAL_MIN;
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
            var ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
            ctx.fillStyle = 'rgba(15,22,36,0.55)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            var W = canvas.width, H = canvas.height;
            var RAD = _RT_MW_COMPARE_RADIUS, HALF = _RT_MW_COMPARE_HALF_DEG;
            // Horizontal crop is linear in lon: central HALF/RAD fraction.
            var fx = HALF / RAD;
            var sx0 = img.width * (1 - fx) / 2, sw = img.width * fx;
            // Vertical un-warp: Mercator-y is uniform across the source rows
            // spanning [gLat-RAD, gLat+RAD]; map each linear-lat output row
            // back to its Mercator source slice.
            var mercY = function (lat) {
                return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
            };
            var myN = mercY(gLat + RAD), myS = mercY(gLat - RAD);
            var srcY = function (lat) {
                return (myN - mercY(lat)) / (myN - myS) * img.height;
            };
            for (var oy = 0; oy < H; oy++) {
                var latTop = (gLat + HALF) - (oy / H) * (2 * HALF);
                var latBot = (gLat + HALF) - ((oy + 1) / H) * (2 * HALF);
                var syA = srcY(latTop), syB = srcY(latBot);
                if (syB - syA < 0.5) syB = syA + 0.5;   // guard thin slices
                ctx.drawImage(img, sx0, syA, sw, syB - syA, 0, oy, W, 1);
            }
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
                              gLat, gLon,
                              _RT_MW_COMPARE_HALF_DEG, 2);
            // Interpolated best-track marker at the MW pass time, if
            // the metadata fetch resolved with usable points.
            _rtDrawInterpMarker(ctx, canvas.width, canvas.height,
                                gLat, gLon,
                                _RT_MW_COMPARE_HALF_DEG);
            // IR brightness-temperature colorbar (Claude LUT). Labels
            // match the storm-card legend (+35 / -30 / -85 °C).
            _rtDrawCompareColorbar(ctx, canvas.width, canvas.height,
                _IR_CBAR, ['+35', '-30', '-85'], 'IR Tb (°C)');
            if (done) done(null);
        };
        // Old frames (outside the 6 h prewarm window) are rendered on
        // demand from S3 — slow (~10 s) and occasionally transient-fail
        // (cold start / S3 hiccup). Retry with backoff before giving up;
        // the server-side render cache usually warms between attempts. A
        // cache-buster on retries skips any stale browser/CDN miss.
        var _irAttempt = 0;
        var _IR_MAX_ATTEMPTS = 3;
        function _loadIrFrame() {
            _irAttempt++;
            img.src = (_irAttempt === 1) ? url : (url + '&_r=' + Date.now());
        }
        img.onerror = function () {
            if (_irAttempt < _IR_MAX_ATTEMPTS) {
                setTimeout(_loadIrFrame, _irAttempt * 2500);  // ~2.5s, ~5s
                return;
            }
            if (done) done(new Error('IR jpg load failed'));
        };
        _loadIrFrame();
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
        var saveBtn = document.getElementById('rt-mw-compare-save');
        if (saveBtn) saveBtn.addEventListener('click', function () {
            saveBtn.disabled = true;
            try { _rtSaveMwCompare(); }
            finally { setTimeout(function () { saveBtn.disabled = false; }, 400); }
        });
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
        // Satellite-backdrop toggle: re-render the MW side (with or
        // without the Vis/SWIR cutout behind the swath). IR side is
        // unaffected, but a full re-render is cheap + keeps both paths
        // in one place.
        var visToggle = document.getElementById('rt-mw-compare-vis-toggle');
        if (visToggle) {
            visToggle.checked = _rtMwCompareVisEnabled;
            visToggle.addEventListener('change', function () {
                _rtMwCompareVisEnabled = visToggle.checked;
                _rtRenderMwCompare();
            });
        }
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

        // Discover the live RT bundle version (best-effort, non-blocking).
        // Kicks off immediately so the correct prefix is usually set before
        // the first storm is opened; bundle fetches use the pinned fallback
        // if it hasn't resolved yet.
        _loadBundleVersion();

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

    // ─── Download dropdown (PNG / GIF / KML) ─────────────────────
    window._irToggleDownloadMenu = function () {
        var menu = document.getElementById('ir-download-menu');
        var btn = document.querySelector('#ir-download-wrap .ir-download-btn');
        if (!menu) return;
        var open = menu.style.display !== 'none';
        menu.style.display = open ? 'none' : 'block';
        if (btn) btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        if (!open) {
            // Bind a one-shot outside-click closer so the menu dismisses cleanly.
            setTimeout(function () {
                document.addEventListener('click', _irOutsideDownloadClick, { capture: true, once: true });
            }, 0);
            // Esc also dismisses — the menu reads as modal-ish, so users
            // reach for Escape; without this it can feel stuck (esp. if
            // opened by accident on touch).
            document.addEventListener('keydown', _irDownloadEscClose);
        }
    };
    function _irDownloadEscClose(e) {
        if (e.key === 'Escape' || e.keyCode === 27) window._irCloseDownloadMenu();
    }
    window._irCloseDownloadMenu = function () {
        var menu = document.getElementById('ir-download-menu');
        var btn = document.querySelector('#ir-download-wrap .ir-download-btn');
        if (menu) menu.style.display = 'none';
        if (btn) btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('keydown', _irDownloadEscClose);
    };
    function _irOutsideDownloadClick(e) {
        var wrap = document.getElementById('ir-download-wrap');
        if (wrap && wrap.contains(e.target)) {
            // Click landed inside the menu — re-arm the outside-click listener.
            setTimeout(function () {
                document.addEventListener('click', _irOutsideDownloadClick, { capture: true, once: true });
            }, 0);
            return;
        }
        window._irCloseDownloadMenu();
    }

    /** Whether the user wants the storm track included in saved images. */
    function _irExportShowTrack() {
        var cb = document.getElementById('ir-download-show-track');
        return !cb || cb.checked;   // default: show
    }

    /** Temporarily detach the track overlay (polyline / fix dots /
     *  extrapolation segment / name label) so it's absent from a saved
     *  image. The storm center marker is NOT part of detailTrackLayers, so
     *  it stays. Returns the removed layers for re-attachment. */
    function _irHideTrackForExport() {
        var removed = [];
        if (!detailMap) return removed;
        for (var i = 0; i < detailTrackLayers.length; i++) {
            var ly = detailTrackLayers[i];
            if (ly && detailMap.hasLayer(ly)) { detailMap.removeLayer(ly); removed.push(ly); }
        }
        return removed;
    }
    function _irRestoreTrackAfterExport(removed) {
        if (!detailMap || !removed) return;
        for (var i = 0; i < removed.length; i++) {
            try { removed[i].addTo(detailMap); } catch (e) {}
        }
    }

    /** html2canvas onclone hook: strip in-map UI chrome (zoom control,
     *  product/channel toggle) from the SNAPSHOT only and stamp the
     *  TC-ATLAS watermark + URL into the imagery panel. The live DOM is
     *  untouched. */
    function _irExportOnClone(clonedDoc) {
        ['.leaflet-control-zoom', '#ir-product-toggle', '#ir-image-loader'].forEach(function (sel) {
            var els = clonedDoc.querySelectorAll(sel);
            for (var i = 0; i < els.length; i++) els[i].style.display = 'none';
        });
        var host = clonedDoc.getElementById('ir-image-container');
        if (host) {
            // Top-right (freed by hiding the product toggle). The graticule
            // labels sit on the left edge (lat) and bottom edge (lon), so
            // the top-right corner is clear of the grid. Subtle chip keeps
            // it legible over bright imagery and mirrors the timestamp chip
            // at top-left.
            var wm = clonedDoc.createElement('div');
            wm.style.cssText = 'position:absolute;right:10px;top:8px;z-index:2000;' +
                'pointer-events:none;text-align:right;font-family:"DM Sans",sans-serif;' +
                'line-height:1.2;padding:4px 8px;border-radius:5px;' +
                'background:rgba(15,22,35,0.55);text-shadow:0 1px 2px rgba(0,0,0,0.7);';
            wm.innerHTML =
                '<div style="font-weight:700;font-size:12px;letter-spacing:0.3px;' +
                'color:rgba(255,255,255,0.95);">TC-ATLAS</div>' +
                '<div style="font-weight:500;font-size:9px;color:rgba(255,255,255,0.78);">' +
                'michaelfischerwx.github.io/TC-ATLAS</div>';
            host.appendChild(wm);
        }
    }

    /** Snapshot the visible imagery panel as a PNG, including the
     *  current frame timestamp / channel label and the Tb colorbar.
     *  Strips UI chrome, stamps a watermark, and (optionally) the track.
     *  Uses html2canvas (already used elsewhere on the site). */
    window._irDownloadCurrentFrame = function () {
        if (!currentStormId) return;
        _ga('ir_export_png', { storm: currentStormId });
        window._irCloseDownloadMenu();
        var node = document.getElementById('ir-image-container');
        if (!node) return;
        var hiddenTrack = _irExportShowTrack() ? null : _irHideTrackForExport();
        _ensureHtml2canvas().then(function () {
            return window.html2canvas(node, {
                useCORS: true, allowTaint: false, backgroundColor: '#0a0c12',
                // Fixed high scale → device-independent, print-grade PNG
                // (~2600 px wide ≈ 8.5" at 300 DPI) instead of the
                // display's pixel ratio (only ~880 px on a 1× screen).
                logging: false, scale: Math.max(3, window.devicePixelRatio || 1),
                onclone: _irExportOnClone
            });
        }).then(function (canvas) {
            // Capture done — restore the live track immediately.
            _irRestoreTrackAfterExport(hiddenTrack); hiddenTrack = null;
            canvas.toBlob(function (blob) {
                if (!blob) return;
                var ts = (animFrameTimes[animIndex] || '').replace(/[:\-T]/g, '').replace('Z', '');
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = currentStormId + '_' + (ts || 'frame') + '.png';
                a.click();
                requestAnimationFrame(function () { URL.revokeObjectURL(url); });
            }, 'image/png');
        }).catch(function (err) {
            _irRestoreTrackAfterExport(hiddenTrack);
            console.warn('[RT Monitor] PNG export failed:', err);
        });
    };

    /** Animated GIF of all valid frames. Steps the visible animation
     *  frame-by-frame, html2canvas-captures the imagery panel, and feeds
     *  each into gif.js. Same pattern as satellite.js's export but
     *  scoped to the card's simpler DOM. */
    window._irDownloadAnimGif = function () {
        if (!currentStormId) return;
        if (typeof window.GIF === 'undefined') {
            console.warn('[RT Monitor] gif.js not loaded');
            return;
        }
        _ga('ir_export_gif', { storm: currentStormId });
        window._irCloseDownloadMenu();

        var state = activeFrameState();
        if (!state || !state.valid || state.valid.length === 0) {
            console.warn('[RT Monitor] no valid frames to export');
            return;
        }

        var node = document.getElementById('ir-image-container');
        if (!node) return;

        // Pause animation so frame stepping is deterministic.
        var wasPlaying = animPlaying;
        if (wasPlaying) stopAnimation();
        var savedIndex = animIndex;

        // Honor the "Show storm track" toggle for the whole GIF.
        var hiddenTrackGif = _irExportShowTrack() ? null : _irHideTrackForExport();

        // Bottom-corner toast for progress.
        var toast = document.createElement('div');
        toast.style.cssText = 'position:absolute;bottom:8px;right:8px;background:rgba(15,22,35,0.85);color:#e2e8f0;font:600 11px/1.2 \'DM Sans\',sans-serif;padding:6px 10px;border-radius:4px;z-index:1000;pointer-events:none;';
        toast.textContent = 'GIF · capturing 0/' + state.valid.length;
        node.appendChild(toast);

        _ensureHtml2canvas().then(function () {
            var w = node.offsetWidth;
            var h = node.offsetHeight;
            // gif.js worker is served from CDN (matches what satellite.js does).
            var gif = new window.GIF({
                workers: 2, quality: 10, width: w, height: h,
                workerScript: 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js',
                background: '#0a0c12'
            });
            gif.on('progress', function (pct) {
                toast.textContent = 'GIF · encoding ' + Math.round(pct * 100) + '%';
            });
            gif.on('finished', function (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = currentStormId + '_animation.gif';
                a.click();
                requestAnimationFrame(function () { URL.revokeObjectURL(url); });
                // Restore track, animation state, and remove toast.
                _irRestoreTrackAfterExport(hiddenTrackGif);
                state.showFn(savedIndex);
                if (wasPlaying) startAnimation();
                if (toast.parentElement) toast.parentElement.removeChild(toast);
            });

            // Step through frames sequentially. html2canvas is async per frame.
            var i = 0;
            function captureNext() {
                if (i >= state.valid.length) {
                    toast.textContent = 'GIF · encoding…';
                    gif.render();
                    return;
                }
                state.showFn(state.valid[i]);
                toast.textContent = 'GIF · capturing ' + (i + 1) + '/' + state.valid.length;
                // Wait one frame so Leaflet/Plotly settle before capture.
                requestAnimationFrame(function () {
                    window.html2canvas(node, {
                        useCORS: true, allowTaint: false, backgroundColor: '#0a0c12',
                        logging: false, scale: 1, onclone: _irExportOnClone
                    }).then(function (cv) {
                        // delay per frame mirrors the player's animIntervalMs.
                        gif.addFrame(cv, { delay: animIntervalMs, copy: true });
                        i++;
                        captureNext();
                    }).catch(function (err) {
                        console.warn('[RT Monitor] frame capture failed:', err);
                        i++;
                        captureNext();
                    });
                });
            }
            captureNext();
        }).catch(function (err) {
            console.warn('[RT Monitor] GIF export setup failed:', err);
            _irRestoreTrackAfterExport(hiddenTrackGif);
            if (toast.parentElement) toast.parentElement.removeChild(toast);
        });
    };

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
