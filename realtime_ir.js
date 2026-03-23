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

    // NASA GIBS WMTS tile config for IR imagery
    var GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
    var GIBS_IR_LAYERS = {
        'GOES-East':  'GOES-East_ABI_Band13_Clean_Infrared',
        'GOES-West':  'GOES-West_ABI_Band13_Clean_Infrared',
        'Himawari':   'Himawari_AHI_Band13_Clean_Infrared'
    };
    var GIBS_TILEMATRIX = 'GoogleMapsCompatible_Level6';
    var GIBS_MAX_ZOOM = 6;  // GIBS geostationary imagery max zoom
    var GIBS_IR_INTERVAL_MIN = 10;  // GIBS tiles every 10 minutes

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
    var gibsIRLayers = [];     // GIBS IR tile layers on main map
    var trackLayers = [];      // past track polylines + dots on main map

    // Storm detail mini-map state
    var detailMap = null;
    var detailTrackLayers = [];
    var detailSatName = '';     // which satellite is used for this storm

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

    // IR Vigor overlay state
    var vigorMode = false;          // true when vigor product is active
    var vigorLayer = null;          // L.GridLayer for client-side vigor tiles
    var vigorCache = {};            // keyed by atcf_id → computed vigor data
    var vigorFetching = false;      // true while vigor computation is running

    // GIBS Clean IR approximate Tb mapping (standard inverted grayscale)
    // white (255) = cold cloud top, black (0) = warm surface
    var GIBS_TB_MIN = 163.0;        // K — coldest (white)
    var GIBS_TB_MAX = 330.0;        // K — warmest (black)

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
    function createCompositeGIBSLayer(timeStr, opacity) {
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
                var ts = this._timeStr;

                if (sats.length === 1) {
                    // Single satellite — load with retry fallback
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

    /** Probe GIBS for the latest available time where ALL satellites have data.
     *  Tests a representative tile from each satellite (GOES-East, GOES-West, Himawari).
     *  Returns a promise that resolves with the first valid GIBS time string.
     *  Different satellites can have different processing delays, so we need a time
     *  where all three return 200. */
    function findLatestGIBSTime() {
        var offsets = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
        // Representative tiles for each satellite (z3 tiles within each footprint)
        var testTiles = [
            { layer: GIBS_IR_LAYERS['GOES-East'], suffix: '/GoogleMapsCompatible_Level6/3/3/2.png' },
            { layer: GIBS_IR_LAYERS['GOES-West'], suffix: '/GoogleMapsCompatible_Level6/3/3/0.png' },
            { layer: GIBS_IR_LAYERS['Himawari'],  suffix: '/GoogleMapsCompatible_Level6/3/3/6.png' }
        ];

        function tryOffset(idx) {
            if (idx >= offsets.length) {
                // All failed — fall back to 90 min ago as best guess
                var fb = roundToGIBSInterval(new Date());
                fb = new Date(fb.getTime() - 90 * 60 * 1000);
                return Promise.resolve(toGIBSTime(fb));
            }
            var dt = roundToGIBSInterval(new Date());
            dt = new Date(dt.getTime() - offsets[idx] * 60 * 1000);
            var ts = toGIBSTime(dt);

            // Check ALL satellites at this time
            var checks = testTiles.map(function (t) {
                var url = GIBS_BASE + '/' + t.layer + '/default/' + ts + t.suffix;
                return fetch(url).then(function (r) {
                    return r.ok;
                }).catch(function () {
                    return false;
                });
            });

            return Promise.all(checks).then(function (results) {
                var allOk = results.every(function (ok) { return ok; });
                if (allOk) return ts;
                return tryOffset(idx + 1);
            });
        }

        return tryOffset(0);
    }

    /** Add the seamless composite GIBS IR layer to the map */
    function addGIBSOverlay(targetMap, opacity) {
        findLatestGIBSTime().then(function (timeStr) {
            var lyr = createCompositeGIBSLayer(timeStr, opacity || 0.65);
            lyr.addTo(targetMap);
            gibsIRLayers = [lyr];
        });
        return []; // layers added asynchronously — gibsIRLayers updated in callback
    }

    /** Remove GIBS IR layers from a map */
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

    /** Build an array of GIBS time strings for animation (lookback_hours, every 30 min) */
    function buildFrameTimes(centerDt, lookbackHours) {
        var times = [];
        var end = roundToGIBSInterval(centerDt);
        // Go back 40 min for availability (GIBS has ~30 min processing delay + margin)
        end = new Date(end.getTime() - 40 * 60 * 1000);
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
                addGIBSOverlay(map, 0.65);
            }
        });
        // Fallback in case basemap load event doesn't fire (cached tiles)
        setTimeout(function () {
            if (!gibsRequested) {
                gibsRequested = true;
                addGIBSOverlay(map, 0.65);
            }
        }, 800);

        // Coastline/borders overlay — sits above IR so land boundaries are visible.
        // Uses CartoDB Voyager (no labels) with mix-blend-mode: screen so that only
        // the bright coastline/border strokes show through while the dark ocean areas
        // have zero effect on the IR underneath.  This avoids the white wash that
        // plain opacity caused with the old light_nolabels approach.
        map.createPane('coastlinePane');
        map.getPane('coastlinePane').style.zIndex = 450; // above tilePane (200) but below overlayPane (400)
        map.getPane('coastlinePane').style.pointerEvents = 'none';
        map.getPane('coastlinePane').style.mixBlendMode = 'screen';
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd',
            maxZoom: 19,
            opacity: 0.35,
            pane: 'coastlinePane'
        }).addTo(map);

        // Labels on top of IR
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | IR: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
            subdomains: 'abcd',
            maxZoom: 19,
            pane: 'overlayPane'
        }).addTo(map);

        map.zoomControl.setPosition('topleft');
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
            .catch(function () { /* silent — track is non-critical */ });
    }

    /** Draw a past track polyline + intensity dots on a Leaflet map */
    function drawTrackOnMap(targetMap, history, storm, layerArr) {
        // Build segments colored by intensity
        for (var i = 1; i < history.length; i++) {
            var prev = history[i - 1];
            var curr = history[i];
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
    }

    /** Show/hide the loading progress overlay on the detail map */
    function showLoadingProgress(show, pct) {
        var loader = document.getElementById('ir-image-loader');
        var loaderText = loader ? loader.querySelector('.ir-loader-text') : null;
        if (!loader) return;
        if (show) {
            loader.style.display = 'flex';
            if (loaderText) {
                loaderText.textContent = pct != null
                    ? 'Pre-loading IR frames\u2026 ' + pct + '%'
                    : 'Pre-loading IR frames\u2026';
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
            console.log('[IR Monitor] All ' + total + ' frames pre-loaded (' + detailSatName + '), ' + validFrames.length + ' valid');
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
        detailMap = L.map(mapDiv, {
            center: [storm.lat, storm.lon],
            zoom: 5,
            minZoom: 3,
            maxZoom: GIBS_MAX_ZOOM,
            zoomControl: true,
            attributionControl: false
        });

        // Dark basemap
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19
        }).addTo(detailMap);

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

        // Coastline/borders overlay — uses mix-blend-mode: screen so only the
        // bright coastline/border strokes show through without washing out the IR.
        detailMap.createPane('coastlinePane');
        detailMap.getPane('coastlinePane').style.zIndex = 450;
        detailMap.getPane('coastlinePane').style.pointerEvents = 'none';
        detailMap.getPane('coastlinePane').style.mixBlendMode = 'screen';
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19, opacity: 0.35, pane: 'coastlinePane'
        }).addTo(detailMap);

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
                showLoadingProgress(false);
                var playBtn = document.getElementById('ir-anim-play');
                if (playBtn) playBtn.disabled = false;
                var slider = document.getElementById('ir-anim-slider');
                if (slider && validFrames.length > 0) {
                    slider.max = validFrames.length - 1;
                    slider.value = validFrames.length - 1;
                    showFrame(validFrames[validFrames.length - 1]);
                } else {
                    showFrame(animFrameTimes.length - 1);
                }
                updateAnimCounter();
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

        // Reset vigor state for new storm
        vigorMode = false;
        vigorFetching = false;
        removeVigorLayer();
        var eirBtn = document.getElementById('ir-product-eir');
        var vigBtn = document.getElementById('ir-product-vigor');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
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

        // Reset vigor state
        removeVigorLayer();
        vigorMode = false;
        vigorFetching = false;
        var eirBtn = document.getElementById('ir-product-eir');
        var vigBtn = document.getElementById('ir-product-vigor');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
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
    function validFramePos() {
        for (var i = 0; i < validFrames.length; i++) {
            if (validFrames[i] === animIndex) return i;
        }
        return -1;
    }

    /** Update the frame counter text (shows position in valid frames) */
    function updateAnimCounter() {
        var counter = document.getElementById('ir-anim-counter');
        var pos = validFramePos();
        if (validFrames.length > 0 && pos >= 0) {
            counter.textContent = (pos + 1) + ' / ' + validFrames.length;
        } else {
            counter.textContent = (animIndex + 1) + ' / ' + animFrameTimes.length;
        }
    }

    /** Step to next valid frame */
    function nextFrame() {
        if (vigorMode) return;
        if (!framesReady) return;
        if (validFrames.length === 0) return;
        var pos = validFramePos();
        var nextPos = (pos + 1) % validFrames.length;
        showFrame(validFrames[nextPos]);
        document.getElementById('ir-anim-slider').value = nextPos;
        updateAnimCounter();
    }

    /** Step to previous valid frame */
    function prevFrame() {
        if (vigorMode) return;
        if (!framesReady) return;
        if (validFrames.length === 0) return;
        var pos = validFramePos();
        var prevPos = (pos - 1 + validFrames.length) % validFrames.length;
        showFrame(validFrames[prevPos]);
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
        if (vigorMode) return;
        if (animFrameTimes.length < 2 || !framesReady) return;
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

    /** Toggle between Enhanced IR and IR Vigor products */
    function setVigorMode(enabled) {
        vigorMode = enabled;

        // Update toggle button states
        var eirBtn = document.getElementById('ir-product-eir');
        var vigBtn = document.getElementById('ir-product-vigor');
        if (eirBtn) eirBtn.classList.toggle('ir-product-active', !enabled);
        if (vigBtn) vigBtn.classList.toggle('ir-product-active', enabled);

        // Show/hide legends
        var vigorLeg = document.getElementById('ir-vigor-legend');
        var tbLeg = document.getElementById('ir-tb-legend');
        if (vigorLeg) vigorLeg.style.display = enabled ? 'block' : 'none';
        if (tbLeg) tbLeg.style.display = enabled ? 'none' : 'block';

        if (enabled) {
            // Show vigor overlay, hide IR animation frames
            hideAllAnimFrames();
            stopAnimation();
            fetchAndShowVigor();
        } else {
            // Remove vigor overlay, restore IR animation
            removeVigorLayer();
            if (animFrameLayers.length > 0 && framesReady) {
                showFrame(animIndex);
            }
        }
    }

    /** Hide all IR animation frame layers */
    function hideAllAnimFrames() {
        for (var i = 0; i < animFrameLayers.length; i++) {
            animFrameLayers[i].setOpacity(0);
        }
    }

    /** Remove the vigor image overlay from the map */
    function removeVigorLayer() {
        if (vigorLayer && detailMap) {
            detailMap.removeLayer(vigorLayer);
            vigorLayer = null;
        }
    }

    // ── Client-Side Vigor Computation Helpers ────────────────

    /** Convert GIBS Clean IR grayscale pixel → approximate Tb (Kelvin).
     *  GIBS Band 13 "Clean IR" uses inverted grayscale: white=cold, black=warm. */
    function gibsPixelToTb(r, g, b) {
        var gray = (r * 0.299 + g * 0.587 + b * 0.114); // luminance
        return GIBS_TB_MAX - (gray / 255.0) * (GIBS_TB_MAX - GIBS_TB_MIN);
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
     *  vigor = current_Tb − local_min(temporal_avg_Tb) */
    function computeClientVigor() {
        if (!detailMap || animFrameLayers.length === 0 || validFrames.length === 0) return null;

        console.time('[Vigor] total computation');

        // 1. Extract Tb from all valid animation frames
        var allStitched = [];
        var refGrid = null;
        for (var fi = 0; fi < validFrames.length; fi++) {
            var layer = animFrameLayers[validFrames[fi]];
            var tileData = extractTbFromLayer(layer);
            var stitched = stitchTileTb(tileData);
            if (!stitched) continue;
            if (!refGrid) refGrid = stitched;
            allStitched.push(stitched);
        }

        if (allStitched.length < 2) {
            console.warn('[Vigor] Not enough frames with tile data:', allStitched.length);
            return null;
        }

        console.log('[Vigor] Extracted Tb from', allStitched.length, 'frames,',
                     'stitched size:', refGrid.w, '×', refGrid.h);

        // 2. Compute temporal average Tb
        var avgData = temporalAvgTb(allStitched);
        if (!avgData) return null;

        // 3. Compute spatial minimum filter radius in pixels
        var degPerPixelLon = (refGrid.bounds.east - refGrid.bounds.west) / refGrid.w;
        var radiusPx = Math.max(1, Math.round(VIGOR_RADIUS_DEG / degPerPixelLon));
        // Cap radius to avoid extremely slow computation
        if (radiusPx > 120) radiusPx = 120;
        console.log('[Vigor] Spatial min filter radius:', radiusPx, 'px (',
                     (radiusPx * degPerPixelLon).toFixed(2), '°)');

        // 4. Apply spatial minimum filter to temporal average
        console.time('[Vigor] spatial min filter');
        var minAvg = spatialMinFilter(avgData.tb, avgData.w, avgData.h, radiusPx);
        console.timeEnd('[Vigor] spatial min filter');

        // 5. Compute vigor using the latest frame: vigor = current_Tb - local_min(avg_Tb)
        //    Mask out warm pixels (Tb >= VIGOR_TB_THRESHOLD) so vigor only
        //    displays over cold cloud tops (convection), not clear sky.
        var latestIdx = validFrames[validFrames.length - 1];
        var latestStitched = allStitched[allStitched.length - 1];
        var vigorArr = new Float32Array(refGrid.w * refGrid.h);
        for (var i = 0; i < vigorArr.length; i++) {
            var curTb = latestStitched.tb[i];
            var minA = minAvg[i];
            if (isNaN(curTb) || !isFinite(minA) || curTb >= VIGOR_TB_THRESHOLD) {
                vigorArr[i] = NaN;
            } else {
                vigorArr[i] = curTb - minA;
            }
        }

        console.timeEnd('[Vigor] total computation');

        return {
            vigor: vigorArr,
            w: refGrid.w,
            h: refGrid.h,
            bounds: refGrid.bounds,
            grid: refGrid.grid,
            tileW: refGrid.tileW,
            tileH: refGrid.tileH,
            framesUsed: allStitched.length,
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

        if (!framesReady || validFrames.length < 2) {
            showVigorToast('IR Vigor requires at least 2 loaded animation frames. Please wait for frames to load.');
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
            if (!framesReady) return;
            stopAnimation();
            var sliderPos = parseInt(this.value, 10);
            // Map slider position to valid frame index
            if (validFrames.length > 0 && sliderPos < validFrames.length) {
                showFrame(validFrames[sliderPos]);
            }
            updateAnimCounter();
        });

        // Product toggle buttons (Enhanced IR / IR Vigor)
        document.getElementById('ir-product-eir').addEventListener('click', function () {
            if (!vigorMode) return;
            setVigorMode(false);
        });
        document.getElementById('ir-product-vigor').addEventListener('click', function () {
            if (vigorMode || vigorFetching) return;
            setVigorMode(true);
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

    function init() {
        initMap();
        bindEvents();

        // Initial poll
        pollActiveStorms();

        // Set up recurring poll
        pollTimer = setInterval(pollActiveStorms, POLL_INTERVAL_MS);

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
