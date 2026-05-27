/* ═══════════════════════════════════════════════════════════════
   Satellite Viewer — satellite.js
   IR satellite imagery with diagnostics panel (radial Tb profile,
   center-fix time series, Tb histogram) and optional WV/Vis
   comparison.  No Leaflet — pure canvas + Plotly rendering.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Config ──────────────────────────────────────────────────
    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var POLL_INTERVAL_MS = 10 * 60 * 1000;
    var DEFAULT_LOOKBACK_HOURS = 6;
    var DEFAULT_RADIUS_DEG = 10.0;
    // Cadence: desktop = 15-min (25 frames per 6h, smooth animation).
    // Mobile/touch = 30-min (13 frames) — halves decoded image memory
    // (~50 MB → ~25 MB at 1000×1000 WebPs) to stay well inside iOS
    // Safari's per-tab budget and prevent the OOM-triggered tab
    // reloads that look like a "crash" to users. Cached frames are
    // identical at both cadences (30-min ⊂ 15-min in time grid), so
    // mobile still hits the prewarmed cache for every frame it asks
    // for — no slowdown beyond fewer frames being shown.
    function _detectTouchCoarse() {
        if (typeof window.matchMedia !== 'function') return false;
        try {
            return window.matchMedia('(pointer: coarse)').matches
                && window.matchMedia('(hover: none)').matches;
        } catch (e) { return false; }
    }
    var FRAME_INTERVAL_MIN = _detectTouchCoarse() ? 30 : 15;
    var FETCH_CONCURRENCY = 5;
    var COASTLINE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson';

    // ── State ───────────────────────────────────────────────────
    var storms = [];
    var currentStormId = null;
    var currentStorm = null;
    var irFrames = [];
    var rightFrames = [];
    var animIndex = 0;
    var animPlaying = false;
    var animTimer = null;
    var animLastTick = 0;
    var animSpeedIdx = 1;
    var hoverThrottled = false;
    var pollTimer = null;
    var selectedColormap = 'claude-ir';
    var rightBand = 8;        // 8=WV, 2=Vis
    var rightDataType = 'tb'; // 'tb' or 'reflectance'
    var zoomDeg = 10;         // view radius in degrees (10, 5, or 2)
    var coastlineData = null;
    var frameCache = {};  // per-storm cache: { stormId: { ir: [], right: [], ts: Date.now() } }
    var FRAME_CACHE_TTL = 10 * 60 * 1000;  // 10 min
    var irLoadedCount = 0;
    var rightLoadedCount = 0;
    var totalExpectedFrames = 7;
    var viewMode = 'diagnostics';       // 'diagnostics' | 'compare-wv' | 'compare-vis'
    var showCrosshair = true;
    var followCenter = false;
    var diagChartsInitialized = false;
    var diagUpdateDebounceTimer = null;
    var DIAG_DEBOUNCE_MS = 100;
    var diagTab = 'charts';  // 'charts' | 'hovmoller'
    var hovLookbackHours = 6;    // current Hovmoller lookback (6, 12, 24)
    var hovExtFrames = null;     // extended frames for 12h/24h (null = use irFrames)
    var hovExtStormId = null;    // storm ID for which extended frames were fetched
    var hovExtFetching = false;  // true while fetching extended frames
    var hovServerData = null;    // server-side Hovmoller data {times, radii, profiles, extrapolated, _hours}
    var hovServerStormId = null; // storm ID for server Hovmoller cache

    // ── Fast JPG Preview State ──────────────────────────────
    var _previewPhase = false;   // true during JPG preview, false once raw Tb loaded
    var _previewDone = 0;        // count of preview JPGs loaded
    var _rawTbStarted = false;   // guard: only start raw Tb backfill once

    // Lazy raw-Tb trigger. Raw Tb is needed for:
    //   • Custom colormap rendering (Phase 4 offscreen bake)
    //   • Per-pixel hover Tb tooltip (Phase 6)
    //   • Asymmetry mode (WN-1 decomposition)
    // The pre-audit code auto-fired _startRawTbBackfill right after
    // the JPG previews finished, wasting ~2-4 MB of bandwidth per
    // storm-open for users who never trigger any of those features.
    // Now: callers trigger this when raw Tb is actually needed.
    window._satEnsureRawTbLoaded = function () {
        if (_rawTbStarted || !currentStormId) return;
        if (typeof _startRawTbBackfill === 'function') {
            // _startRawTbBackfill is a closure inside loadFrames — we
            // can't call it directly from outside. Instead, the
            // closure registers itself on this state hook.
        }
        _rawTbStarted = true;
        if (_satPendingRawTbTrigger) {
            try { _satPendingRawTbTrigger(); } catch (e) {}
        }
    };
    // Stashed by loadFrames so the closure-scoped _startRawTbBackfill
    // can be invoked from outside via window._satEnsureRawTbLoaded.
    var _satPendingRawTbTrigger = null;

    // ── 88D NEXRAD Radar Overlay State ───────────────────────
    var showRadar = false;           // overlay toggle
    var _satRadarImg = null;         // loaded Image element for current scan
    var _satRadarBounds = null;      // [[south,west],[north,east]]
    var _satRadarSites = null;       // API response from /nexrad/sites
    var _satRadarLastStormId = null; // last storm we fetched sites for
    var _satRadarScanKey = null;     // S3 key of loaded scan
    var _satRadarData = null;        // raw uint8 hover data
    var _satRadarRows = 0;
    var _satRadarCols = 0;
    var _satRadarVmin = -32;
    var _satRadarVmax = 95;
    var _satRadarUnits = 'dBZ';
    var _satRadarProduct = 'reflectivity';
    var _satRadarSiteLat = null;     // radar site latitude
    var _satRadarSiteLon = null;     // radar site longitude
    var _satRadarTilt = 0.5;         // elevation angle in degrees
    var _satRadarAllScans = [];      // full scan list across 6h window
    var _satRadarFrameCache = {};    // { s3_key: { img, bounds, data, rows, cols, vmin, vmax, units, scanTime } }
    var _satRadarPrefetching = false;
    var _satRadarSyncTimer = null;   // throttle timer for frame-sync

    var ANIM_SPEEDS = [
        { label: '0.5x', ms: 1200 },
        { label: '1x',   ms: 600 },
        { label: '2x',   ms: 300 },
        { label: '4x',   ms: 150 }
    ];

    var SS_COLORS = {
        TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
        C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626'
    };

    // ── IR Colormap LUTs ────────────────────────────────────────
    var IR_COLORMAPS = {};
    var IR_COLORMAPS_32 = {};

    function getLut32(name) {
        var cached = IR_COLORMAPS_32[name];
        if (cached) return cached;
        var lut = IR_COLORMAPS[name];
        if (!lut) return null;
        var lut32 = new Uint32Array(lut.buffer, lut.byteOffset, lut.length >> 2);
        IR_COLORMAPS_32[name] = lut32;
        return lut32;
    }

    (function buildColormaps() {
        function buildLUT(stops) {
            var lut = new Uint8Array(256 * 4);
            lut[0] = 0; lut[1] = 0; lut[2] = 0; lut[3] = 0;
            for (var i = 1; i <= 255; i++) {
                var frac = 1.0 - (i - 1) / 254.0;
                var lo = stops[0], hi = stops[stops.length - 1];
                for (var s = 0; s < stops.length - 1; s++) {
                    if (frac >= stops[s].f && frac <= stops[s + 1].f) {
                        lo = stops[s]; hi = stops[s + 1]; break;
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

        IR_COLORMAPS['enhanced'] = buildLUT([
            {f:0.00,r:8,g:8,b:8},{f:0.15,r:40,g:40,b:40},{f:0.30,r:90,g:90,b:90},
            {f:0.40,r:140,g:140,b:140},{f:0.50,r:200,g:200,b:200},{f:0.55,r:0,g:180,b:255},
            {f:0.60,r:0,g:100,b:255},{f:0.65,r:0,g:255,b:0},{f:0.70,r:255,g:255,b:0},
            {f:0.75,r:255,g:180,b:0},{f:0.80,r:255,g:80,b:0},{f:0.85,r:255,g:0,b:0},
            {f:0.90,r:180,g:0,b:180},{f:0.95,r:255,g:180,b:255},{f:1.00,r:255,g:255,b:255}
        ]);
        IR_COLORMAPS['dvorak'] = buildLUTfromTb([
            {tb:170,r:255,g:255,b:255},{tb:183,r:255,g:0,b:255},{tb:193,r:255,g:0,b:0},
            {tb:203,r:255,g:128,b:0},{tb:213,r:255,g:255,b:0},{tb:223,r:0,g:255,b:0},
            {tb:233,r:0,g:128,b:255},{tb:243,r:0,g:0,b:255},{tb:253,r:128,g:128,b:128},
            {tb:273,r:180,g:180,b:180},{tb:293,r:60,g:60,b:60},{tb:310,r:10,g:10,b:10}
        ]);
        IR_COLORMAPS['grayscale'] = (function () {
            var vmin = 160.0, vmax = 330.0, lut = new Uint8Array(256 * 4);
            lut[0]=0;lut[1]=0;lut[2]=0;lut[3]=0;
            for (var i=1;i<=255;i++) {
                var tb = vmin + (i-1) * (vmax-vmin) / 254.0, gray;
                if (tb<193) gray=85; else if (tb<198) gray=135; else if (tb<204) gray=255;
                else if (tb<210) gray=0; else if (tb<220) gray=160; else if (tb<232) gray=110;
                else if (tb<243) gray=60;
                else if (tb<282) gray=Math.round(202+(tb-243)*(109-202)/(282-243));
                else if (tb<=303) gray=Math.round(255+(tb-282)*(0-255)/(303-282));
                else gray=0;
                gray=Math.max(0,Math.min(255,gray));
                var idx=i*4; lut[idx]=gray;lut[idx+1]=gray;lut[idx+2]=gray;lut[idx+3]=255;
            }
            return lut;
        })();
        IR_COLORMAPS['funktop'] = buildLUTfromTb([
            {tb:309,r:0,g:0,b:0},{tb:308,r:20,g:20,b:20},{tb:255,r:216,g:216,b:216},
            {tb:254.9,r:100,g:100,b:0},{tb:235,r:248,g:248,b:0},{tb:234.9,r:0,g:0,b:120},
            {tb:215,r:0,g:252,b:252},{tb:214.9,r:84,g:0,b:0},{tb:203,r:252,g:0,b:0},
            {tb:202.9,r:252,g:80,b:80},{tb:195,r:252,g:140,b:140},{tb:194.9,r:0,g:252,b:0},
            {tb:182,r:252,g:252,b:252},{tb:181,r:252,g:252,b:252}
        ]);
        IR_COLORMAPS['avn'] = buildLUTfromTb([
            {tb:310,r:0,g:0,b:0},{tb:243,r:255,g:255,b:255},{tb:242.9,r:0,g:150,b:255},
            {tb:223,r:0,g:110,b:150},{tb:222.9,r:160,g:160,b:0},{tb:213,r:250,g:250,b:0},
            {tb:212.9,r:250,g:250,b:0},{tb:203,r:200,g:120,b:0},{tb:202.9,r:250,g:0,b:0},
            {tb:193,r:200,g:0,b:0},{tb:192,r:88,g:88,b:88}
        ]);
        IR_COLORMAPS['nhc'] = buildLUTfromTb([
            {tb:298,r:0,g:0,b:0},{tb:297,r:0,g:0,b:24},{tb:282,r:0,g:0,b:252},
            {tb:262,r:0,g:252,b:0},{tb:242,r:252,g:0,b:0},{tb:203,r:252,g:248,b:248},
            {tb:202.9,r:216,g:216,b:216},{tb:170,r:252,g:252,b:252}
        ]);
        IR_COLORMAPS['rammb'] = buildLUTfromTb([
            {tb:310,r:181,g:85,b:85},{tb:298,r:0,g:0,b:0},{tb:243,r:254,g:254,b:254},
            {tb:242.9,r:168,g:253,b:253},{tb:223,r:84,g:84,b:84},{tb:222.9,r:0,g:0,b:103},
            {tb:213,r:0,g:0,b:254},{tb:212.9,r:0,g:96,b:13},{tb:203,r:0,g:252,b:0},
            {tb:202.9,r:77,g:13,b:0},{tb:193,r:251,g:0,b:0},{tb:192.9,r:252,g:252,b:0},
            {tb:183,r:0,g:0,b:0},{tb:182.9,r:255,g:255,b:255},{tb:173,r:4,g:4,b:4}
        ]);
        IR_COLORMAPS['irb'] = buildLUTfromTb([
            {tb:303,r:18,g:18,b:18},{tb:283,r:120,g:120,b:120},{tb:278,r:215,g:217,b:219},
            {tb:273,r:252,g:252,b:252},{tb:263,r:43,g:57,b:161},{tb:253,r:61,g:173,b:143},
            {tb:238,r:255,g:249,b:87},{tb:233,r:227,g:192,b:36},{tb:218,r:166,g:35,b:63},
            {tb:213,r:77,g:13,b:7},{tb:203,r:150,g:73,b:201},{tb:193,r:224,g:224,b:255},
            {tb:173,r:0,g:0,b:0}
        ]);
        IR_COLORMAPS['claude-ir'] = buildLUTfromTb([
            {tb:310,r:12,g:12,b:22},{tb:293,r:70,g:70,b:82},{tb:283,r:120,g:120,b:132},
            {tb:273,r:180,g:180,b:192},{tb:263,r:216,g:218,b:228},{tb:253,r:140,g:210,b:220},
            {tb:248,r:68,g:180,b:196},{tb:243,r:32,g:148,b:166},{tb:238,r:40,g:178,b:116},
            {tb:233,r:96,g:208,b:68},{tb:228,r:192,g:220,b:40},{tb:223,r:238,g:196,b:48},
            {tb:218,r:228,g:132,b:48},{tb:213,r:214,g:78,b:56},{tb:208,r:180,g:36,b:68},
            {tb:203,r:196,g:48,b:156},{tb:198,r:168,g:64,b:200},{tb:193,r:120,g:48,b:180},
            {tb:183,r:64,g:24,b:140},{tb:173,r:28,g:12,b:96}
        ]);

        // Claude Water Vapor colormap (Band 8: 170-260 K range).
        // Designed to highlight dry-air signatures (CIMSS/CIRA convention):
        //   warm Tb → terra cotta / amber  (dry intrusions stand out)
        //   mid Tb  → cream → pale blue    (mid-trop moisture transition)
        //   cold Tb → cobalt → green       (deep convection / overshooting tops)
        // Mirrors the server-side _CLAUDE_WV_FRAC_STOPS in ir_monitor_api.py
        // so client-side colormap switching produces identical visuals to
        // the pre-rendered WebPs.
        IR_COLORMAPS['wv'] = (function () {
            var vmin = 170.0, vmax = 260.0, lut = new Uint8Array(256 * 4);
            lut[0]=0;lut[1]=0;lut[2]=0;lut[3]=0;
            var stops = [
                {f:0.000,r:235,g:110,b: 45},  // warm: terra cotta (dry)
                {f:0.080,r:215,g: 90,b: 50},  // rust red
                {f:0.160,r:195,g:105,b: 55},  // terracotta
                {f:0.240,r:220,g:150,b: 90},  // amber
                {f:0.310,r:235,g:200,b:165},  // warm cream
                {f:0.380,r:248,g:235,b:218},  // ivory
                {f:0.450,r:242,g:246,b:248},  // off-white
                {f:0.510,r:218,g:235,b:246},  // pale ice blue
                {f:0.580,r:160,g:210,b:240},  // light cyan
                {f:0.660,r: 95,g:175,b:225},  // sky blue
                {f:0.740,r: 45,g:130,b:200},  // cobalt
                {f:0.800,r: 20,g: 90,b:170},  // navy
                {f:0.860,r: 30,g:130,b:135},  // teal-green
                {f:0.910,r: 55,g:180,b: 95},  // forest green
                {f:0.960,r:140,g:230,b:145},  // emerald
                {f:1.000,r:230,g:250,b:220}   // pale mint (overshooting)
            ];
            for (var i=1;i<=255;i++) {
                var frac = 1.0 - (i-1) / 254.0;
                var lo = stops[0], hi = stops[stops.length-1];
                for (var s=0;s<stops.length-1;s++) {
                    if (frac >= stops[s].f && frac <= stops[s+1].f) { lo=stops[s]; hi=stops[s+1]; break; }
                }
                var t = (hi.f===lo.f)?0:(frac-lo.f)/(hi.f-lo.f);
                t = Math.max(0,Math.min(1,t));
                var idx = i*4;
                lut[idx]=Math.round(lo.r+t*(hi.r-lo.r));
                lut[idx+1]=Math.round(lo.g+t*(hi.g-lo.g));
                lut[idx+2]=Math.round(lo.b+t*(hi.b-lo.b));
                lut[idx+3]=255;
            }
            return lut;
        })();

        // Visible: inverted grayscale (bright=clouds/high reflectance, dark=ocean/low)
        // Uint8 encoding: 1=low reflectance, 255=high reflectance
        // Display: high reflectance should be bright white
        IR_COLORMAPS['vis'] = (function () {
            var lut = new Uint8Array(256 * 4);
            lut[0]=0;lut[1]=0;lut[2]=0;lut[3]=0;
            for (var i=1;i<=255;i++) {
                // Stretch contrast: map 1-255 to full 0-255 gray range
                // Apply gamma correction (1.5) to brighten mid-tones for dawn/dusk
                var frac = (i - 1) / 254.0;
                var gray = Math.round(Math.pow(frac, 0.7) * 255);
                var idx = i*4;
                lut[idx]=gray; lut[idx+1]=gray; lut[idx+2]=gray; lut[idx+3]=255;
            }
            return lut;
        })();
    })();

    // ── DOM ─────────────────────────────────────────────────────
    var canvasIR, ctxIR, canvasRight, ctxRight;
    var overlayIR, overlayCtxIR, overlayRight, overlayCtxRight;
    var tooltip, loader, loaderMsg, noStormsEl, loadStatusEl;
    var sliderEl, frameCounterEl, timestampEl, satelliteEl, stormLabelEl;
    var playBtn, speedBtn, stormListEl, rightLabelEl;
    var sidebar, sidebarToggle, sidebarClose;
    var axesYIR, axesXIR, axesYRight, axesXRight;
    var cbIRCanvas, cbRightCanvas, cbIRTop, cbIRBot, cbRightTop, cbRightBot;
    var rightColormapName = 'wv';  // default WV colormap for right panel

    function initDOM() {
        canvasIR = document.getElementById('sat-canvas-ir');
        ctxIR = canvasIR ? canvasIR.getContext('2d') : null;
        canvasRight = document.getElementById('sat-canvas-right');
        ctxRight = canvasRight ? canvasRight.getContext('2d') : null;
        overlayIR = document.getElementById('sat-overlay-ir');
        overlayCtxIR = overlayIR ? overlayIR.getContext('2d') : null;
        overlayRight = document.getElementById('sat-overlay-right');
        overlayCtxRight = overlayRight ? overlayRight.getContext('2d') : null;
        tooltip = document.getElementById('sat-tooltip');
        loader = document.getElementById('sat-loader');
        loaderMsg = document.getElementById('sat-loader-msg');
        noStormsEl = document.getElementById('sat-no-storms');
        loadStatusEl = document.getElementById('sat-load-status');
        sliderEl = document.getElementById('sat-slider');
        frameCounterEl = document.getElementById('sat-frame-counter');
        timestampEl = document.getElementById('sat-timestamp');
        satelliteEl = document.getElementById('sat-satellite');
        stormLabelEl = document.getElementById('sat-storm-label');
        playBtn = document.getElementById('sat-play');
        speedBtn = document.getElementById('sat-speed');
        stormListEl = document.getElementById('sat-storm-list');
        rightLabelEl = document.getElementById('sat-right-label');
        sidebar = document.getElementById('sat-sidebar');
        sidebarToggle = document.getElementById('sat-sidebar-toggle');
        sidebarClose = document.getElementById('sat-sidebar-close');
        axesYIR = document.getElementById('sat-axes-y-ir');
        axesXIR = document.getElementById('sat-axes-x-ir');
        axesYRight = document.getElementById('sat-axes-y-right');
        axesXRight = document.getElementById('sat-axes-x-right');
        cbIRCanvas = document.getElementById('sat-cb-ir-canvas');
        cbRightCanvas = document.getElementById('sat-cb-right-canvas');
        cbIRTop = document.getElementById('sat-cb-ir-top');
        cbIRBot = document.getElementById('sat-cb-ir-bot');
        cbRightTop = document.getElementById('sat-cb-right-top');
        cbRightBot = document.getElementById('sat-cb-right-bot');
    }

    // ── Utility ─────────────────────────────────────────────────

    function decodeTbData(base64str) {
        var binary = atob(base64str);
        var arr = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        return arr;
    }

    function categoryShort(cat) {
        if (!cat) return 'TD';
        if (cat === 'TD' || cat === 'TS') return cat;
        return 'Cat ' + cat.replace('C', '');
    }

    function _ga(action, params) {
        if (typeof gtag === 'function') {
            try { gtag('event', action, params || {}); } catch (e) {}
        }
    }

    function solarElevation(lat, lon, dt) {
        var doy = Math.floor((dt - new Date(dt.getFullYear(), 0, 0)) / 86400000);
        var decl = -23.44 * Math.cos(Math.PI / 180 * (360 / 365 * (doy + 10)));
        var utcH = dt.getUTCHours() + dt.getUTCMinutes() / 60;
        var ha = (utcH - 12) * 15 + lon;
        var latR = lat * Math.PI / 180, declR = decl * Math.PI / 180, haR = ha * Math.PI / 180;
        var sinE = Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(haR);
        return Math.asin(Math.max(-1, Math.min(1, sinE))) * 180 / Math.PI;
    }

    // ── Zoom helpers ────────────────────────────────────────────

    function getViewBounds(frame) {
        if (!frame || !frame.bounds) return null;
        var b = frame.bounds;
        var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
        if (zoomDeg < 10) {
            var cLat = (south + north) / 2, cLon = (west + east) / 2;
            // Follow mode: center on IR center_fix (or interpolated/extrapolated position)
            if (followCenter) {
                if (frame.center_fix && frame.center_fix.lat) {
                    cLat = frame.center_fix.lat;
                    cLon = frame.center_fix.lon;
                } else if (frame._interpCenter) {
                    cLat = frame._interpCenter.lat;
                    cLon = frame._interpCenter.lon;
                }
            }
            return { south: cLat - zoomDeg, north: cLat + zoomDeg, west: cLon - zoomDeg, east: cLon + zoomDeg };
        }
        return { south: south, north: north, west: west, east: east };
    }

    function getCropIndices(frame, vb) {
        var b = frame.bounds;
        var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
        var r0 = Math.max(0, Math.floor((north - vb.north) / (north - south) * frame.rows));
        var r1 = Math.min(frame.rows, Math.ceil((north - vb.south) / (north - south) * frame.rows));
        var c0 = Math.max(0, Math.floor((vb.west - west) / (east - west) * frame.cols));
        var c1 = Math.min(frame.cols, Math.ceil((vb.east - west) / (east - west) * frame.cols));
        return { r0: r0, r1: r1, c0: c0, c1: c1, rows: r1 - r0, cols: c1 - c0 };
    }

    // ── Canvas Rendering ────────────────────────────────────────

    function renderFrame(canvas, ctx, frame, colormapName) {
        if (!frame || !ctx) return;

        // Fast path: when on the default ('claude-ir') colormap, prefer
        // the server-rendered JPG (drawImage is ~10× faster than the
        // LUT decode + putImageData on a 600×600 canvas). Only fall
        // through to the LUT painter when the user actively switches
        // to a custom colormap — at that point the JPG can't represent
        // the requested palette so the raw Tb path is justified.
        // (Old behavior: JPG only used when tb_data was absent — meant
        // arriving raw Tb instantly demoted the panel to the slow path.)
        var preferJpg = (colormapName === 'claude-ir') && frame.previewImg;
        if (preferJpg || (!frame.tb_data && frame.previewImg)) {
            var iw = frame.previewImg.naturalWidth;
            var ih = frame.previewImg.naturalHeight;
            var vb = getViewBounds(frame);
            if (!vb || !frame.bounds) return;
            var b = frame.bounds;
            var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];

            if (zoomDeg >= 10) {
                // Full frame — no cropping needed
                canvas.width = iw;
                canvas.height = ih;
                ctx.fillStyle = '#0a0b12';
                ctx.fillRect(0, 0, iw, ih);
                ctx.drawImage(frame.previewImg, 0, 0);
            } else {
                // Zoomed — crop source image to match view bounds
                var sx = Math.max(0, (vb.west - west) / (east - west) * iw);
                var sy = Math.max(0, (north - vb.north) / (north - south) * ih);
                var sw = (vb.east - vb.west) / (east - west) * iw;
                var sh = (vb.north - vb.south) / (north - south) * ih;
                canvas.width = iw;
                canvas.height = ih;
                ctx.fillStyle = '#0a0b12';
                ctx.fillRect(0, 0, iw, ih);
                ctx.drawImage(frame.previewImg, sx, sy, sw, sh, 0, 0, iw, ih);
            }
            return;
        }

        if (!frame.tb_data) return;
        var lut32 = getLut32(colormapName) || getLut32('enhanced');
        var vb = getViewBounds(frame);
        if (!vb) return;
        var crop = getCropIndices(frame, vb);
        if (crop.rows <= 0 || crop.cols <= 0) return;

        // Always render at full data resolution, then let CSS scale
        // Use the FULL frame dimensions so zoomed images fill the same space
        canvas.width = frame.cols;
        canvas.height = frame.rows;
        var imgData = ctx.createImageData(frame.cols, frame.rows);
        var pixels = imgData.data;

        // Fast background fill via Uint32Array (4x fewer writes than per-channel)
        var buf32 = new Uint32Array(pixels.buffer);
        // ABGR little-endian for rgb(10, 11, 18) with alpha 255
        var bgColor32 = (255 << 24) | (18 << 16) | (11 << 8) | 10;
        buf32.fill(bgColor32);

        // Render cropped region scaled to fill the full canvas
        var scaleY = frame.rows / crop.rows;
        var scaleX = frame.cols / crop.cols;
        var fCols = frame.cols;
        var tb = frame.tb_data;

        // Precompute dst-col → src-col mapping once per frame
        var colLut = new Int32Array(fCols);
        for (var cx = 0; cx < fCols; cx++) {
            colLut[cx] = crop.c0 + (cx / scaleX | 0);
        }

        for (var y = 0; y < frame.rows; y++) {
            var srcRow = crop.r0 + (y / scaleY | 0);
            var dstRowOffset = y * fCols;
            var srcRowOffset = srcRow * fCols;
            for (var x = 0; x < fCols; x++) {
                var val = tb[srcRowOffset + colLut[x]];
                if (val !== 0) {
                    buf32[dstRowOffset + x] = lut32[val];
                }
            }
        }
        ctx.putImageData(imgData, 0, 0);
    }

    function getRightCmap() {
        // Use user-selected colormap, or auto-select based on data type
        if (rightDataType === 'reflectance' && rightColormapName === 'wv') return 'vis';
        return rightColormapName;
    }

    function renderBothPanels() {
        if (irFrames.length === 0) return;
        var irFrame = irFrames[animIndex];
        var irCmap = selectedColormap;

        // Always render IR panel — both canvas and Leaflet paths are
        // kept up to date. Visibility toggling happens inside
        // _satIrSyncLeaflet based on the current mode + colormap.
        // The canvas render is cheap when its container is hidden
        // (DOM still computes the image but no pixels reach screen).
        renderFrame(canvasIR, ctxIR, irFrame, irCmap);
        drawOverlay(overlayIR, overlayCtxIR, irFrame);
        renderColorbar(cbIRCanvas, irCmap, cbIRTop, cbIRBot, 160, 330, 'K');
        if (irFrame) {
            var vb = getViewBounds(irFrame);
            renderAxes(axesYIR, axesXIR, vb);
        }
        // Mirror the IR panel onto the Leaflet map when its mode/cmap
        // combination calls for it. Cheap when canvas is the active
        // path (just a visibility check + early return).
        if (typeof _satIrSyncLeaflet === 'function') {
            _satIrSyncLeaflet();
        }
        // Phase 3: same dispatch for the right-pane WV/Vis Leaflet
        // display (only active when in compare-wv / compare-vis mode
        // with the band's default colormap).
        if (typeof _satRightSyncLeaflet === 'function') {
            _satRightSyncLeaflet();
        }

        if (viewMode === 'diagnostics') {
            // Debounced diagnostics update during fast animation
            if (diagUpdateDebounceTimer) clearTimeout(diagUpdateDebounceTimer);
            if (animPlaying && animSpeedIdx >= 2) {
                diagUpdateDebounceTimer = setTimeout(renderDiagnostics, DIAG_DEBOUNCE_MS);
            } else {
                renderDiagnostics();
            }
        } else if (viewMode === 'track-map') {
            renderTrackMap();
        } else if (viewMode === 'asymmetry') {
            if (irFrame) computeAndRenderAsymmetry(irFrame);
        } else {
            // Compare mode: render right panel canvas
            var rightFrame = rightFrames[animIndex] || null;
            var rightCmap = getRightCmap();
            if (rightFrame) {
                // Update label with frame timestamp
                if (rightLabelEl) {
                    var rName = rightBand === 2 ? 'Visible' : 'Water Vapor';
                    var rTime = rightFrame.datetime_utc ? rightFrame.datetime_utc.replace('T', ' ').replace(/:\d{2}Z$/, ' UTC').replace('Z', ' UTC') : '';
                    rightLabelEl.textContent = rName + (rTime ? '  ' + rTime : '');
                }
                renderFrame(canvasRight, ctxRight, rightFrame, rightCmap);
                if (irFrame && irFrame.center_fix && !rightFrame.center_fix) {
                    rightFrame.center_fix = irFrame.center_fix;
                }
                drawOverlay(overlayRight, overlayCtxRight, rightFrame);
                var rvmin = rightFrame.tb_vmin || 170, rvmax = rightFrame.tb_vmax || 260;
                var runit = rightDataType === 'reflectance' ? '%' : 'K';
                if (rightDataType === 'reflectance') { rvmin = 0; rvmax = 100; }
                renderColorbar(cbRightCanvas, rightCmap, cbRightTop, cbRightBot, rvmin, rvmax, runit);
            } else if (rightLabelEl) {
                var rName2 = rightBand === 2 ? 'Visible' : 'Water Vapor';
                rightLabelEl.textContent = rName2 + '  (loading\u2026)';
            }
            if (irFrame) {
                var vb2 = getViewBounds(irFrame);
                renderAxes(axesYRight, axesXRight, vb2);
            }
        }
    }

    // ── Coastlines ──────────────────────────────────────────────

    function loadCoastlines() {
        if (coastlineData) return;
        fetch(COASTLINE_URL)
            .then(function (r) { return r.json(); })
            .then(function (geojson) {
                coastlineData = geojson;
                console.log('[Satellite] Coastlines loaded');
                renderBothPanels();
            })
            .catch(function (err) {
                console.warn('[Satellite] Coastline load failed:', err.message);
            });
    }

    function drawOverlay(overlayCanvas, overlayCtx, frame) {
        if (!overlayCanvas || !overlayCtx || !frame) return;
        var vb = getViewBounds(frame);
        if (!vb) return;

        // Size overlay to match the data canvas (always full frame dimensions)
        var w = frame.cols, h = frame.rows;
        overlayCanvas.width = w;
        overlayCanvas.height = h;
        overlayCanvas.style.maxWidth = '100%';
        overlayCanvas.style.maxHeight = '100%';
        var dataCanvas = overlayCanvas.previousElementSibling;
        if (dataCanvas) {
            overlayCanvas.style.width = dataCanvas.offsetWidth + 'px';
            overlayCanvas.style.height = dataCanvas.offsetHeight + 'px';
        }
        overlayCtx.clearRect(0, 0, w, h);

        // ── Grid lines (thin, subtle) ──
        var latSpan = vb.north - vb.south;
        var lonSpan = vb.east - vb.west;
        var gridStep = latSpan > 12 ? 5 : latSpan > 6 ? 2 : 1;

        overlayCtx.strokeStyle = 'rgba(200, 200, 220, 0.3)';
        overlayCtx.lineWidth = 1;

        // Latitude lines
        for (var lat = Math.ceil(vb.south / gridStep) * gridStep; lat <= vb.north; lat += gridStep) {
            var py = (vb.north - lat) / latSpan * h;
            overlayCtx.beginPath();
            overlayCtx.moveTo(0, py);
            overlayCtx.lineTo(w, py);
            overlayCtx.stroke();
        }
        // Longitude lines
        for (var lon = Math.ceil(vb.west / gridStep) * gridStep; lon <= vb.east; lon += gridStep) {
            var px = (lon - vb.west) / lonSpan * w;
            overlayCtx.beginPath();
            overlayCtx.moveTo(px, 0);
            overlayCtx.lineTo(px, h);
            overlayCtx.stroke();
        }

        // ── Coastlines ──
        if (coastlineData) {
            overlayCtx.strokeStyle = 'rgba(200, 180, 120, 0.6)';
            overlayCtx.lineWidth = 1.5;
            var features = coastlineData.features || [];
            for (var f = 0; f < features.length; f++) {
                var geom = features[f].geometry;
                if (!geom) continue;
                var coordSets = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
                for (var cs = 0; cs < coordSets.length; cs++) {
                    var coords = coordSets[cs];
                    if (!coords || coords.length < 2) continue;
                    overlayCtx.beginPath();
                    var started = false;
                    for (var c = 0; c < coords.length; c++) {
                        var clon = coords[c][0], clat = coords[c][1];
                        if (clon < vb.west || clon > vb.east || clat < vb.south || clat > vb.north) {
                            started = false; continue;
                        }
                        var cpx = (clon - vb.west) / lonSpan * w;
                        var cpy = (vb.north - clat) / latSpan * h;
                        if (!started) { overlayCtx.moveTo(cpx, cpy); started = true; }
                        else overlayCtx.lineTo(cpx, cpy);
                    }
                    overlayCtx.stroke();
                }
            }
        }

        // ── 88D Radar Overlay ──
        if (showRadar && _satRadarImg && _satRadarBounds) {
            var rb = _satRadarBounds;
            var rSouth = rb[0][0], rWest = rb[0][1], rNorth = rb[1][0], rEast = rb[1][1];
            // Map radar geographic bounds to canvas pixels
            var rx0 = (rWest - vb.west) / lonSpan * w;
            var ry0 = (vb.north - rNorth) / latSpan * h;
            var rx1 = (rEast - vb.west) / lonSpan * w;
            var ry1 = (vb.north - rSouth) / latSpan * h;
            var rw = rx1 - rx0, rh = ry1 - ry0;
            if (rw > 0 && rh > 0) {
                overlayCtx.globalAlpha = 0.7;
                overlayCtx.drawImage(_satRadarImg, rx0, ry0, rw, rh);
                overlayCtx.globalAlpha = 1.0;
            }
        }

        // ── IR Center Fix Crosshair ──
        //   cyan solid = IR-based objective fix (passed g1/g2/g3 gates)
        //   orange dashed = best-track / extrapolated position (no IR fix
        //                   passed; shows where the advisory says the
        //                   storm is so the user still has a reference)
        var _fixSrc = null; // 'objective' or 'extrapolated'
        var _fixLat = null, _fixLon = null;
        if (showCrosshair) {
            if (frame.center_fix && frame.center_fix.lat) {
                _fixSrc = 'objective';
                _fixLat = frame.center_fix.lat;
                _fixLon = frame.center_fix.lon;
            } else if (frame._interpCenter) {
                _fixSrc = 'extrapolated';
                _fixLat = frame._interpCenter.lat;
                _fixLon = frame._interpCenter.lon;
            } else if (currentStorm && currentStorm.lat != null && currentStorm.lon != null) {
                // Last-resort fallback: advisory position, for cases where
                // _interpolateCenters hasn't populated _interpCenter yet.
                _fixSrc = 'extrapolated';
                _fixLat = currentStorm.lat;
                _fixLon = currentStorm.lon;
            }
        }
        if (_fixSrc && _fixLat != null) {
            var fx = (_fixLon - vb.west) / lonSpan * w;
            var fy = (vb.north - _fixLat) / latSpan * h;

            if (fx >= 0 && fx <= w && fy >= 0 && fy <= h) {
                var r = Math.max(12, Math.round(w * 0.012));
                var armLen = r + 4;

                if (_fixSrc === 'objective') {
                    // Solid cyan — objective center fix
                    overlayCtx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
                    overlayCtx.lineWidth = 4;
                    overlayCtx.setLineDash([]);
                    overlayCtx.beginPath();
                    overlayCtx.arc(fx, fy, r, 0, 2 * Math.PI);
                    overlayCtx.stroke();

                    overlayCtx.strokeStyle = '#00e5ff';
                    overlayCtx.lineWidth = 2;
                    overlayCtx.beginPath();
                    overlayCtx.arc(fx, fy, r, 0, 2 * Math.PI);
                    overlayCtx.stroke();

                    overlayCtx.beginPath();
                    overlayCtx.moveTo(fx, fy - armLen); overlayCtx.lineTo(fx, fy + armLen);
                    overlayCtx.moveTo(fx - armLen, fy); overlayCtx.lineTo(fx + armLen, fy);
                    overlayCtx.stroke();
                } else {
                    // Dashed orange — extrapolated/interpolated center
                    overlayCtx.strokeStyle = 'rgba(251, 146, 60, 0.35)';
                    overlayCtx.lineWidth = 4;
                    overlayCtx.setLineDash([6, 4]);
                    overlayCtx.beginPath();
                    overlayCtx.arc(fx, fy, r, 0, 2 * Math.PI);
                    overlayCtx.stroke();

                    overlayCtx.strokeStyle = '#fb923c';
                    overlayCtx.lineWidth = 2;
                    overlayCtx.beginPath();
                    overlayCtx.arc(fx, fy, r, 0, 2 * Math.PI);
                    overlayCtx.stroke();

                    overlayCtx.beginPath();
                    overlayCtx.moveTo(fx, fy - armLen); overlayCtx.lineTo(fx, fy + armLen);
                    overlayCtx.moveTo(fx - armLen, fy); overlayCtx.lineTo(fx + armLen, fy);
                    overlayCtx.stroke();
                    overlayCtx.setLineDash([]);
                }
            }
        }
    }

    // ── Colorbar Rendering ────────────────────────────────────────

    function renderColorbar(cbCanvas, cmapName, leftLabel, rightLabel, vmin, vmax, unit) {
        if (!cbCanvas) return;
        var lut = IR_COLORMAPS[cmapName] || IR_COLORMAPS['enhanced'];
        var cbCtx = cbCanvas.getContext('2d');
        var w = cbCanvas.width, h = cbCanvas.height;
        var imgData = cbCtx.createImageData(w, h);
        var pixels = imgData.data;

        // Horizontal: left=warm (index 1), right=cold (index 255)
        for (var x = 0; x < w; x++) {
            var val = Math.round(1 + x / (w - 1) * 254);
            if (val > 255) val = 255;
            var li = val * 4;
            for (var y = 0; y < h; y++) {
                var pi = (y * w + x) * 4;
                pixels[pi] = lut[li]; pixels[pi+1] = lut[li+1];
                pixels[pi+2] = lut[li+2]; pixels[pi+3] = 255;
            }
        }
        cbCtx.putImageData(imgData, 0, 0);

        if (leftLabel) leftLabel.textContent = vmin + ' ' + unit;
        if (rightLabel) rightLabel.textContent = vmax + ' ' + unit;
    }

    // ── Save Image ──────────────────────────────────────────────

    function drawColorbarToCtx(cctx, x, y, w, h, cmapName, vmin, vmax, unit) {
        var lut = IR_COLORMAPS[cmapName] || IR_COLORMAPS['enhanced'];
        // Draw gradient bar (left=warm, right=cold)
        for (var bx = 0; bx < w; bx++) {
            var val = Math.round(1 + bx / (w - 1) * 254);
            if (val > 255) val = 255;
            var li = val * 4;
            cctx.fillStyle = 'rgb(' + lut[li] + ',' + lut[li+1] + ',' + lut[li+2] + ')';
            cctx.fillRect(x + bx, y, 1, h);
        }
        // Border
        cctx.strokeStyle = '#2a2d38';
        cctx.lineWidth = 1;
        cctx.strokeRect(x, y, w, h);
        // Labels
        cctx.fillStyle = '#94a3b8';
        cctx.font = '10px sans-serif';
        cctx.textAlign = 'left';
        cctx.fillText(vmin + ' ' + unit, x, y + h + 12);
        cctx.textAlign = 'right';
        cctx.fillText(vmax + ' ' + unit, x + w, y + h + 12);
        cctx.textAlign = 'left';
    }

    function saveImage() {
        if (irFrames.length === 0) return;
        var irFrame = irFrames[animIndex];
        if (!irFrame) return;
        _ga('sat_export_png', { storm: currentStormId, mode: viewMode });

        var name = currentStorm ? (currentStorm.name || currentStormId) : currentStormId;
        var cat = currentStorm ? categoryShort(currentStorm.category) : '';
        var time = irFrame.datetime_utc ? irFrame.datetime_utc.replace('T', ' ').replace('Z', ' UTC') : '';
        var sat = irFrame.satellite || '';

        // Build radar info string if radar overlay is active
        var radarInfo = '';
        if (showRadar && _satRadarImg) {
            var statusEl = document.getElementById('sat-radar-frame-status');
            if (statusEl && statusEl.textContent) {
                radarInfo = statusEl.textContent;
            }
        }

        // Check if Hovmoller is active — if so, export it alongside the IR frame
        var hovDiv = document.getElementById('sat-diag-hovmoller-chart');
        var hovActive = (viewMode === 'diagnostics' && diagTab === 'hovmoller' && hovDiv && hovDiv.data);

        if (hovActive) {
            _saveWithHovmoller(irFrame, name, cat, time, sat, hovDiv, radarInfo);
            return;
        }

        _saveStandard(irFrame, name, cat, time, sat, radarInfo);
    }

    /**
     * Build a composite canvas for the current frame state.
     * Used by both PNG save and GIF export.
     * @param {string} headerText - header line (storm name, time, etc.)
     * @returns {HTMLCanvasElement}
     */
    function _buildCompositeFrame(headerText, irOnly, radarInfo) {
        var irFrame = irFrames[animIndex];
        if (!irFrame) return null;
        var pw = irFrame.cols, ph = irFrame.rows;
        var gap = 4;
        var headerH = radarInfo ? 42 : 28;
        var cbH = 24;
        var hasDualPanel = !irOnly && (viewMode === 'compare-wv' || viewMode === 'compare-vis' || viewMode === 'asymmetry');
        var totalW = hasDualPanel ? pw * 2 + gap : pw;
        var totalH = ph + headerH + cbH;

        var comp = document.createElement('canvas');
        comp.width = totalW;
        comp.height = totalH;
        var cctx = comp.getContext('2d');

        cctx.fillStyle = '#0a0c12';
        cctx.fillRect(0, 0, totalW, totalH);

        cctx.fillStyle = '#e2e4ea';
        cctx.font = '16px sans-serif';
        cctx.fillText(headerText, 8, 20);

        if (radarInfo) {
            cctx.font = '12px sans-serif';
            cctx.fillStyle = '#86efac';
            cctx.fillText('88D: ' + radarInfo, 8, 36);
        }

        cctx.drawImage(canvasIR, 0, headerH, pw, ph);
        if (overlayIR) cctx.drawImage(overlayIR, 0, headerH, pw, ph);

        if (viewMode === 'asymmetry' && canvasAsym && canvasAsym.width > 0) {
            cctx.drawImage(canvasAsym, pw + gap, headerH, pw, ph);
            if (overlayAsym) cctx.drawImage(overlayAsym, pw + gap, headerH, pw, ph);
        } else if ((viewMode === 'compare-wv' || viewMode === 'compare-vis') && canvasRight && canvasRight.width > 0) {
            cctx.drawImage(canvasRight, pw + gap, headerH, pw, ph);
            if (overlayRight) cctx.drawImage(overlayRight, pw + gap, headerH, pw, ph);
        }

        // Panel labels (drawn ON TOP of images with background pill)
        function _drawPanelLabel(text, x, y) {
            cctx.font = '13px sans-serif';
            var tw = cctx.measureText(text).width;
            cctx.fillStyle = 'rgba(10, 12, 18, 0.7)';
            cctx.fillRect(x, y - 13, tw + 10, 18);
            cctx.fillStyle = '#e2e8f0';
            cctx.fillText(text, x + 5, y);
        }
        _drawPanelLabel('Enhanced IR', 4, headerH + 16);
        if (viewMode === 'compare-wv' || viewMode === 'compare-vis') {
            var rightLabel = rightBand === 2 ? 'Visible 0.64 µm (Band 2)' : 'Water Vapor 6.2 µm (Band 8, Upper-Trop)';
            _drawPanelLabel(rightLabel, pw + gap + 4, headerH + 16);
        } else if (viewMode === 'asymmetry') {
            _drawPanelLabel('IR Asymmetry (WN-1)', pw + gap + 4, headerH + 16);
        }

        var cbY = headerH + ph + 4;
        var cbW = pw - 80;
        drawColorbarToCtx(cctx, 40, cbY, cbW, 8, selectedColormap, 160, 330, 'K');

        if (viewMode === 'asymmetry') {
            var acbW = pw - 80;
            var acbX = pw + gap + 40;
            for (var abx = 0; abx < acbW; abx++) {
                var aval = Math.round(1 + abx / (acbW - 1) * 254);
                var ali = aval * 4;
                cctx.fillStyle = 'rgb(' + ASYM_LUT[ali] + ',' + ASYM_LUT[ali + 1] + ',' + ASYM_LUT[ali + 2] + ')';
                cctx.fillRect(acbX + abx, cbY, 1, 8);
            }
            cctx.strokeStyle = '#2a2d38'; cctx.lineWidth = 1;
            cctx.strokeRect(acbX, cbY, acbW, 8);
            cctx.fillStyle = '#94a3b8'; cctx.font = '10px sans-serif';
            cctx.textAlign = 'left'; cctx.fillText('-20 \u00B0C', acbX, cbY + 20);
            cctx.textAlign = 'right'; cctx.fillText('+20 \u00B0C', acbX + acbW, cbY + 20);
            cctx.textAlign = 'left';
        } else if (viewMode === 'compare-wv' || viewMode === 'compare-vis') {
            var rightFrame = rightFrames[animIndex];
            if (rightFrame) {
                var rcmap = getRightCmap();
                var rvmin = rightFrame.tb_vmin || 170, rvmax = rightFrame.tb_vmax || 260;
                var runit = rightDataType === 'reflectance' ? '%' : 'K';
                if (rightDataType === 'reflectance') { rvmin = 0; rvmax = 100; }
                drawColorbarToCtx(cctx, pw + gap + 40, cbY, cbW, 8, rcmap, rvmin, rvmax, runit);
            }
        }

        cctx.fillStyle = 'rgba(255,255,255,0.25)';
        cctx.font = '10px sans-serif';
        cctx.textAlign = 'right';
        cctx.fillText('TC-ATLAS', totalW - 8, 14);
        cctx.textAlign = 'left';

        return comp;
    }

    /** Standard save: IR frame (+ right panel if in compare/asymmetry mode) */
    function _saveStandard(irFrame, name, cat, time, sat, radarInfo) {
        var headerText = name + '  \u2014  ' + time + '  ' + sat;
        var comp = _buildCompositeFrame(headerText, false, radarInfo);
        if (!comp) return;

        var link = document.createElement('a');
        link.download = (name || 'satellite') + '_' + (irFrame.datetime_utc || '').replace(/[:\-T]/g, '').replace('Z', '') + '.png';
        link.href = comp.toDataURL('image/png');
        link.click();
    }

    /** Save with Hovmoller: IR frame on left, Hovmoller chart on right */
    function _saveWithHovmoller(irFrame, name, cat, time, sat, hovDiv, radarInfo) {
        var pw = irFrame.cols, ph = irFrame.rows;
        var headerH = radarInfo ? 42 : 28;
        var cbH = 24;
        var gap = 4;
        // Hovmoller panel sized to match IR panel height
        var hovW = pw;
        var hovH = ph + cbH;

        // Export Hovmoller chart as PNG via Plotly
        Plotly.toImage(hovDiv, { format: 'png', width: hovW, height: hovH, scale: 2 })
            .then(function (hovDataUrl) {
                var hovImg = new Image();
                hovImg.onload = function () {
                    var totalW = pw + gap + hovW;
                    var totalH = ph + headerH + cbH;

                    var comp = document.createElement('canvas');
                    comp.width = totalW;
                    comp.height = totalH;
                    var cctx = comp.getContext('2d');

                    cctx.fillStyle = '#0a0c12';
                    cctx.fillRect(0, 0, totalW, totalH);

                    // Header
                    cctx.fillStyle = '#e2e4ea';
                    cctx.font = '16px sans-serif';
                    cctx.fillText(name + '  \u2014  ' + time + '  ' + sat, 8, 20);

                    if (radarInfo) {
                        cctx.font = '12px sans-serif';
                        cctx.fillStyle = '#86efac';
                        cctx.fillText('88D: ' + radarInfo, 8, 36);
                    }

                    // IR frame + overlay
                    cctx.drawImage(canvasIR, 0, headerH, pw, ph);
                    if (overlayIR) cctx.drawImage(overlayIR, 0, headerH, pw, ph);

                    // IR colorbar
                    var cbY = headerH + ph + 4;
                    var cbW = pw - 80;
                    drawColorbarToCtx(cctx, 40, cbY, cbW, 8, selectedColormap, 160, 330, 'K');

                    // Hovmoller chart image
                    cctx.drawImage(hovImg, pw + gap, headerH, hovW, hovH);

                    // Panel labels (on top of images)
                    function _hovLabel(text, x, y) {
                        cctx.font = '13px sans-serif';
                        var tw2 = cctx.measureText(text).width;
                        cctx.fillStyle = 'rgba(10, 12, 18, 0.7)';
                        cctx.fillRect(x, y - 13, tw2 + 10, 18);
                        cctx.fillStyle = '#e2e8f0';
                        cctx.fillText(text, x + 5, y);
                    }
                    _hovLabel('Enhanced IR', 4, headerH + 16);
                    _hovLabel('Tb Hovmoller (' + hovLookbackHours + 'h)', pw + gap + 4, headerH + 16);

                    // Watermark
                    cctx.fillStyle = 'rgba(255,255,255,0.25)';
                    cctx.font = '10px sans-serif';
                    cctx.textAlign = 'right';
                    cctx.fillText('TC-ATLAS', totalW - 8, 14);
                    cctx.textAlign = 'left';

                    var link = document.createElement('a');
                    link.download = (name || 'satellite') + '_hovmoller_' +
                        (irFrame.datetime_utc || '').replace(/[:\-T]/g, '').replace('Z', '') + '.png';
                    link.href = comp.toDataURL('image/png');
                    link.click();
                };
                hovImg.src = hovDataUrl;
            })
            .catch(function (err) {
                console.warn('[Satellite] Hovmoller export failed, saving IR only:', err);
                _saveStandard(irFrame, name, cat, time, sat);
            });
    }

    // ── GIF Export ───────────────────────────────────────────────

    var _gifExporting = false;

    function _ensureGifWorker(cb) {
        if (window._gifWorkerBlobUrl) { cb(window._gifWorkerBlobUrl); return; }
        fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js')
            .then(function (r) { return r.text(); })
            .then(function (src) {
                var blob = new Blob([src], { type: 'application/javascript' });
                window._gifWorkerBlobUrl = URL.createObjectURL(blob);
                cb(window._gifWorkerBlobUrl);
            })
            .catch(function () {
                cb('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
            });
    }

    function saveGif(e) {
        if (_gifExporting || validFrameIndices.length < 2 || typeof GIF === 'undefined') return;
        _gifExporting = true;
        _ga('sat_export_gif', { storm: currentStormId, mode: viewMode });

        var name = currentStorm ? (currentStorm.name || currentStormId) : currentStormId;
        var cat = currentStorm ? categoryShort(currentStorm.category) : '';
        var savedAnimIndex = animIndex;
        var delay = ANIM_SPEEDS[animSpeedIdx].ms;

        // Shift+click = include right panel (Hovmoller/WV/Vis/Asymmetry)
        var wantDual = e && e.shiftKey;

        // Detect if Hovmoller should be included
        var hovDiv = document.getElementById('sat-diag-hovmoller-chart');
        var includeHovmoller = wantDual && (viewMode === 'diagnostics' && diagTab === 'hovmoller' && hovDiv && hovDiv.data);

        // Disable buttons during export
        var gifBtn = document.getElementById('sat-save-gif');
        var saveBtn = document.getElementById('sat-save');
        if (gifBtn) { gifBtn.disabled = true; gifBtn.style.opacity = '0.4'; }
        if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.4'; }

        if (loadStatusEl) loadStatusEl.textContent = 'GIF 0%';

        _ensureGifWorker(function (workerUrl) {
            var sampleFrame = irFrames[validFrameIndices[0]];
            if (!sampleFrame) { _gifCleanup(); return; }
            var pw = sampleFrame.cols, ph = sampleFrame.rows;
            var gap = 4;
            var headerH = 28;
            var cbH = 24;
            var hasDualPanel = wantDual && (viewMode === 'compare-wv' || viewMode === 'compare-vis' || viewMode === 'asymmetry');
            var hovW = includeHovmoller ? pw : 0;
            var outW = hasDualPanel ? pw * 2 + gap : (includeHovmoller ? pw + gap + hovW : pw);
            var outH = ph + headerH + cbH;

            var gif = new GIF({
                workers: 2, quality: 8, width: outW, height: outH,
                workerScript: workerUrl, transparent: null, background: '#0a0c12'
            });

            gif.on('progress', function (pct) {
                if (loadStatusEl) loadStatusEl.textContent = 'GIF ' + Math.round(pct * 100) + '%';
            });

            gif.on('finished', function (blob) {
                var url = URL.createObjectURL(blob);
                var link = document.createElement('a');
                var ts = (irFrames[validFrameIndices[0]] || {}).datetime_utc || '';
                var suffix = includeHovmoller ? '_hovmoller_anim_' : '_anim_';
                link.download = (name || 'satellite') + suffix + ts.replace(/[:\-T]/g, '').replace('Z', '') + '.gif';
                link.href = url;
                link.click();
                requestAnimationFrame(function () { URL.revokeObjectURL(url); });
                animIndex = savedAnimIndex;
                renderBothPanels();
                updateAnimUI();
                _gifCleanup();
                console.log('[Satellite] GIF export complete: ' + validFrameIndices.length + ' frames' +
                    (includeHovmoller ? ' (with Hovmoller)' : ''));
            });

            var frameIdx = 0;
            var frameList = validFrameIndices.slice();

            function addNextFrame() {
                if (frameIdx >= frameList.length) {
                    if (loadStatusEl) loadStatusEl.textContent = 'Encoding...';
                    gif.render();
                    return;
                }

                var fi = frameList[frameIdx];
                animIndex = fi;
                renderBothPanels();

                var frame = irFrames[fi];
                var time = frame && frame.datetime_utc ? frame.datetime_utc.replace('T', ' ').replace('Z', ' UTC') : '';
                var sat = frame && frame.satellite ? frame.satellite : '';
                var headerText = name + '  \u2014  ' + time + '  ' + sat;

                if (includeHovmoller) {
                    // Update Hovmoller horizontal line to this frame's time, then capture
                    var shapes = [];
                    if (frame && frame.datetime_utc) {
                        shapes = [{
                            type: 'line', y0: frame.datetime_utc, y1: frame.datetime_utc,
                            x0: 0, x1: 1, xref: 'paper',
                            line: { color: '#ffffff99', width: 2, dash: 'dot' }
                        }];
                    }
                    Plotly.relayout(hovDiv, { shapes: shapes }).then(function () {
                        return Plotly.toImage(hovDiv, { format: 'png', width: hovW, height: ph + cbH, scale: 1 });
                    }).then(function (hovDataUrl) {
                        var hovImg = new Image();
                        hovImg.onload = function () {
                            var irComp = _buildCompositeFrame(headerText, true);
                            if (!irComp) { frameIdx++; setTimeout(addNextFrame, 0); return; }

                            // Build wider canvas: IR left + Hovmoller right
                            var fullComp = document.createElement('canvas');
                            fullComp.width = outW;
                            fullComp.height = outH;
                            var fctx = fullComp.getContext('2d');
                            fctx.fillStyle = '#0a0c12';
                            fctx.fillRect(0, 0, outW, outH);
                            // Draw IR composite on the left
                            fctx.drawImage(irComp, 0, 0);
                            // Draw Hovmoller on the right
                            fctx.drawImage(hovImg, pw + gap, headerH, hovW, ph + cbH);
                            // Label
                            fctx.font = '13px sans-serif';
                            fctx.fillStyle = '#94a3b8';
                            fctx.fillText('Tb Hovmoller (' + hovLookbackHours + 'h)', pw + gap + 8, headerH + 16);
                            // Watermark (over full width)
                            fctx.fillStyle = 'rgba(255,255,255,0.3)';
                            fctx.font = '10px sans-serif';
                            fctx.textAlign = 'right';
                            fctx.fillText('TC-ATLAS', outW - 8, 14);
                            fctx.textAlign = 'left';

                            var frameDelay = (frameIdx === frameList.length - 1) ? delay * 2 : delay;
                            gif.addFrame(fctx, { copy: true, delay: frameDelay });

                            if (loadStatusEl) loadStatusEl.textContent = 'Frames ' + (frameIdx + 1) + '/' + frameList.length;
                            frameIdx++;
                            setTimeout(addNextFrame, 0);
                        };
                        hovImg.src = hovDataUrl;
                    }).catch(function () {
                        // Fallback: IR only for this frame
                        var comp = _buildCompositeFrame(headerText, true);
                        if (comp) gif.addFrame(comp.getContext('2d'), { copy: true, delay: delay });
                        frameIdx++;
                        setTimeout(addNextFrame, 0);
                    });
                } else {
                    // Standard: IR only, or IR + right panel if shift+click in compare mode
                    var comp = _buildCompositeFrame(headerText, !hasDualPanel);
                    if (comp) {
                        var frameDelay = (frameIdx === frameList.length - 1) ? delay * 2 : delay;
                        gif.addFrame(comp.getContext('2d'), { copy: true, delay: frameDelay });
                    }
                    if (loadStatusEl) loadStatusEl.textContent = 'Frames ' + (frameIdx + 1) + '/' + frameList.length;
                    frameIdx++;
                    setTimeout(addNextFrame, 0);
                }
            }

            addNextFrame();
        });

        function _gifCleanup() {
            _gifExporting = false;
            if (gifBtn) { gifBtn.disabled = false; gifBtn.style.opacity = ''; }
            if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; }
            if (loadStatusEl) loadStatusEl.textContent = '';
        }
    }

    // ── Lat/Lon Axes ────────────────────────────────────────────

    function renderAxes(yEl, xEl, vb) {
        if (!yEl || !xEl || !vb) return;

        // Latitude axis (left side)
        var latSpan = vb.north - vb.south;
        var latStep = latSpan > 12 ? 5 : latSpan > 6 ? 2 : 1;
        var html = '';
        for (var lat = Math.ceil(vb.south / latStep) * latStep; lat <= vb.north; lat += latStep) {
            var pct = ((vb.north - lat) / latSpan * 100).toFixed(1);
            var label = Math.abs(lat).toFixed(0) + (lat >= 0 ? 'N' : 'S');
            html += '<span class="sat-axis-label" style="position:absolute;top:' + pct + '%">' + label + '</span>';
        }
        yEl.innerHTML = html;

        // Longitude axis (bottom)
        var lonSpan = vb.east - vb.west;
        var lonStep = lonSpan > 12 ? 5 : lonSpan > 6 ? 2 : 1;
        html = '';
        for (var lon = Math.ceil(vb.west / lonStep) * lonStep; lon <= vb.east; lon += lonStep) {
            var pct2 = ((lon - vb.west) / lonSpan * 100).toFixed(1);
            var label2 = Math.abs(lon).toFixed(0) + (lon >= 0 ? 'E' : 'W');
            html += '<span class="sat-axis-label" style="position:absolute;left:' + pct2 + '%">' + label2 + '</span>';
        }
        xEl.innerHTML = html;
    }

    // ── Diagnostics: Client-Side Computation ─────────────────────

    function decodeTbValue(rawVal, vmin, vmax) {
        if (rawVal <= 0) return NaN;
        return vmin + (rawVal - 1) * (vmax - vmin) / 254.0;
    }

    function computeRadialProfile(frame) {
        if (!frame || !frame.center_fix || !frame.tb_data) return null;
        var cLat = frame.center_fix.lat, cLon = frame.center_fix.lon;
        var b = frame.bounds;
        var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
        var rows = frame.rows, cols = frame.cols;
        var vmin = frame.tb_vmin || 160.0, vmax = frame.tb_vmax || 330.0;

        // Center pixel
        var cy = (north - cLat) / (north - south) * (rows - 1);
        var cx = (cLon - west) / (east - west) * (cols - 1);

        // Grid spacing in km (flat-earth)
        var cosLat = Math.cos(cLat * Math.PI / 180);
        var dyKm = (north - south) / (rows - 1) * 111.0;
        var dxKm = (east - west) / (cols - 1) * 111.0 * cosLat;

        var maxRadKm = Math.min(zoomDeg * 111.0, 500);
        var dr = 2; // km bin width
        var nBins = Math.ceil(maxRadKm / dr);
        var sums = new Float64Array(nBins);
        var sumsSq = new Float64Array(nBins);
        var counts = new Int32Array(nBins);

        for (var r = 0; r < rows; r++) {
            var dY = (r - cy) * dyKm;
            for (var c = 0; c < cols; c++) {
                var rawVal = frame.tb_data[r * cols + c];
                if (rawVal === 0) continue;
                var dX = (c - cx) * dxKm;
                var dist = Math.sqrt(dY * dY + dX * dX);
                var bin = Math.floor(dist / dr);
                if (bin >= nBins) continue;
                var tbVal = decodeTbValue(rawVal, vmin, vmax);
                sums[bin] += tbVal;
                sumsSq[bin] += tbVal * tbVal;
                counts[bin]++;
            }
        }

        var radii = [];
        var meanC = [];
        var stdC = [];
        for (var i = 0; i < nBins; i++) {
            if (counts[i] >= 3) {
                var mean = sums[i] / counts[i];
                var variance = sumsSq[i] / counts[i] - mean * mean;
                var std = Math.sqrt(Math.max(variance, 0));
                var meanCelsius = mean - 273.15;
                if (meanCelsius < -100) continue; // skip extremely cold bins
                radii.push(i * dr + dr / 2);
                meanC.push(meanCelsius);
                stdC.push(std); // std same magnitude in K or C
            }
        }
        return radii.length > 5 ? { radii: radii, meanC: meanC, stdC: stdC } : null;
    }

    function computeTbHistogram(frame) {
        if (!frame || !frame.center_fix || !frame.tb_data) return null;
        var cLat = frame.center_fix.lat, cLon = frame.center_fix.lon;
        var b = frame.bounds;
        var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
        var rows = frame.rows, cols = frame.cols;
        var vmin = frame.tb_vmin || 160.0, vmax = frame.tb_vmax || 330.0;

        var cy = (north - cLat) / (north - south) * (rows - 1);
        var cx = (cLon - west) / (east - west) * (cols - 1);
        var cosLat = Math.cos(cLat * Math.PI / 180);
        var dyKm = (north - south) / (rows - 1) * 111.0;
        var dxKm = (east - west) / (cols - 1) * 111.0 * cosLat;

        var bandEdges = [0, 50, 100, 200, 500];
        var bandLabels = ['0\u201350 km', '50\u2013100 km', '100\u2013200 km', '200\u2013500 km'];
        var nBands = bandLabels.length;
        // Tb histogram bins: 170 to 310 K, 2K steps
        var tbMin = 170, tbMax = 310, tbStep = 2;
        var nTbBins = Math.ceil((tbMax - tbMin) / tbStep);
        var histCounts = [];
        for (var bi = 0; bi < nBands; bi++) histCounts.push(new Int32Array(nTbBins));

        for (var r = 0; r < rows; r++) {
            var dY = (r - cy) * dyKm;
            for (var c = 0; c < cols; c++) {
                var rawVal = frame.tb_data[r * cols + c];
                if (rawVal === 0) continue;
                var dX = (c - cx) * dxKm;
                var dist = Math.sqrt(dY * dY + dX * dX);
                // Determine band
                var band = -1;
                for (var bi2 = 0; bi2 < nBands; bi2++) {
                    if (dist >= bandEdges[bi2] && dist < bandEdges[bi2 + 1]) { band = bi2; break; }
                }
                if (band < 0) continue;
                var tb = decodeTbValue(rawVal, vmin, vmax);
                var tbBin = Math.floor((tb - tbMin) / tbStep);
                if (tbBin >= 0 && tbBin < nTbBins) histCounts[band][tbBin]++;
            }
        }

        var tbBinCenters = [];
        for (var t = 0; t < nTbBins; t++) tbBinCenters.push(tbMin + t * tbStep + tbStep / 2);

        var bands = [];
        for (var bi3 = 0; bi3 < nBands; bi3++) {
            var raw = histCounts[bi3];
            var total = 0;
            for (var ti = 0; ti < nTbBins; ti++) total += raw[ti];
            var frac = new Array(nTbBins);
            for (var ti2 = 0; ti2 < nTbBins; ti2++) frac[ti2] = total > 0 ? raw[ti2] / total : 0;
            bands.push({ label: bandLabels[bi3], tbBins: tbBinCenters, fractions: frac });
        }
        return { bands: bands };
    }

    function buildCenterFixTimeSeries() {
        var times = [], eyeScores = [], irRadDifs = [], meanStds = [];
        // Separate arrays for failed attempts (plotted as open markers)
        var failTimes = [], failScores = [], failRadDifs = [], failReasons = [], failGates = [];
        for (var i = 0; i < irFrames.length; i++) {
            var f = irFrames[i];
            if (!f || !f.center_fix) continue;
            if (f.center_fix.lat) {
                // Successful fix
                times.push(f.datetime_utc);
                eyeScores.push(f.center_fix.eye_score);
                irRadDifs.push(f.center_fix.ir_rad_dif);
                meanStds.push(f.center_fix.mean_std || null);
            } else if (f.center_fix.success === false) {
                // Failed attempt with diagnostics
                failTimes.push(f.datetime_utc);
                failScores.push(f.center_fix.best_score || 0);
                failRadDifs.push(f.center_fix.best_ir_rad_dif || 0);
                var reason = f.center_fix.reason || 'unknown';
                // Append position info for too_far failures
                if (reason === 'too_far' && f.center_fix.found_lat != null) {
                    reason += ' (found ' + f.center_fix.found_lat.toFixed(1) + ',' +
                        f.center_fix.found_lon.toFixed(1) + ' vs guess ' +
                        f.center_fix.guess_lat.toFixed(1) + ',' +
                        f.center_fix.guess_lon.toFixed(1) + ' d=' +
                        (f.center_fix.dist_deg || 0).toFixed(2) + '\u00B0)';
                }
                failReasons.push(reason);
                failGates.push(f.center_fix.gates || null);
            }
        }
        if (times.length < 2 && failTimes.length === 0) return null;
        return {
            times: times, eyeScores: eyeScores, irRadDifs: irRadDifs, meanStds: meanStds,
            failTimes: failTimes, failScores: failScores, failRadDifs: failRadDifs,
            failReasons: failReasons, failGates: failGates
        };
    }

    // ── Diagnostics: Plotly Chart Rendering ─────────────────────

    var DIAG_LAYOUT_BASE = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { family: 'DM Sans, sans-serif', color: '#5b6573', size: 10 },
        margin: { t: 28, r: 12, b: 36, l: 48 }
    };
    var _isMobile = window.innerWidth <= 768;
    var DIAG_CONFIG = { displayModeBar: false, responsive: true, staticPlot: _isMobile, scrollZoom: false };

    function renderRadialProfileChart(frame) {
        var div = document.getElementById('sat-diag-radial');
        if (!div) return;
        var profile = computeRadialProfile(frame);
        if (!profile) { div.style.display = 'none'; return; }
        div.style.display = 'block';

        // Build std deviation shaded band (mean +/- std)
        var upperC = [], lowerC = [];
        for (var si = 0; si < profile.meanC.length; si++) {
            upperC.push(profile.meanC[si] + profile.stdC[si]);
            lowerC.push(profile.meanC[si] - profile.stdC[si]);
        }

        var traces = [
            // Upper bound (invisible line, defines top of fill)
            {
                x: profile.radii, y: upperC,
                type: 'scatter', mode: 'lines',
                line: { width: 0 }, showlegend: false,
                hoverinfo: 'skip'
            },
            // Lower bound (fill to upper)
            {
                x: profile.radii, y: lowerC,
                type: 'scatter', mode: 'lines',
                line: { width: 0 }, showlegend: false,
                fill: 'tonexty', fillcolor: 'rgba(34,211,238,0.12)',
                hoverinfo: 'skip'
            },
            // Mean line
            {
                x: profile.radii, y: profile.meanC,
                type: 'scatter', mode: 'lines',
                line: { color: '#22d3ee', width: 2 },
                hovertemplate: '%{x:.0f} km: %{y:.1f} \u00B0C<extra></extra>'
            }
        ];
        var layout = JSON.parse(JSON.stringify(DIAG_LAYOUT_BASE));
        layout.title = { text: 'Azimuthal-Mean Radial Tb', font: { size: 11, color: '#5b6573' } };
        layout.xaxis = { title: { text: 'Radius (km)', font: { size: 10 } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 9, family: 'JetBrains Mono, monospace' } };
        layout.yaxis = { title: { text: 'Tb (\u00B0C)', font: { size: 10 } }, range: [40, -100], fixedrange: true, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 9, family: 'JetBrains Mono, monospace' }, ticksuffix: '\u00B0' };
        layout.showlegend = false;

        if (div.data) {
            Plotly.react(div, traces, layout, DIAG_CONFIG);
        } else {
            Plotly.newPlot(div, traces, layout, DIAG_CONFIG);
        }
    }

    function renderCenterFixTimeSeries() {
        var div = document.getElementById('sat-diag-timeseries');
        if (!div) return;
        var ts = buildCenterFixTimeSeries();
        if (!ts) { div.style.display = 'none'; return; }
        div.style.display = 'block';

        // Find current frame time for highlight
        var curFrame = irFrames[animIndex];
        var curTime = curFrame && curFrame.datetime_utc ? curFrame.datetime_utc : null;

        var traces = [
            {
                x: ts.times, y: ts.eyeScores, type: 'scatter', mode: 'lines+markers',
                name: 'Eye Score', line: { color: '#22d3ee', width: 2 },
                marker: { size: 4 }, yaxis: 'y',
                hovertemplate: 'Score: %{y:.1f}<extra></extra>'
            },
            {
                x: ts.times, y: ts.irRadDifs, type: 'scatter', mode: 'lines+markers',
                name: 'IR Rad Diff (K)', line: { color: '#a78bfa', width: 2 },
                marker: { size: 4 }, yaxis: 'y2',
                hovertemplate: '\u0394T: %{y:.1f} K<extra></extra>'
            }
        ];
        // Failed center-fix attempts — show as open red markers
        if (ts.failTimes && ts.failTimes.length > 0) {
            // Build hover text with failure reason
            var failHoverScore = [], failHoverRad = [];
            for (var fi = 0; fi < ts.failTimes.length; fi++) {
                var reason = (ts.failReasons[fi] || 'unknown').replace(/_/g, ' ');
                var gateLine = '';
                var gi = ts.failGates ? ts.failGates[fi] : null;
                if (gi) {
                    var g1Mark = (gi.g1_rad_dif >= 15) ? '\u2713' : '\u2717';
                    var g2Mark = (gi.g2_std_ratio < 0.7) ? '\u2713' : '\u2717';
                    var g3Mark = (gi.g3_diff != null && gi.g3_diff <= 7) ? '\u2713' : '\u2717';
                    gateLine = '<br>' + g1Mark + ' \u0394T=' + gi.g1_rad_dif + 'K' +
                        ' &nbsp; ' + g2Mark + ' \u03C3=' + gi.g2_std_ratio +
                        ' &nbsp; ' + g3Mark + ' ring\u0394=' +
                        (gi.g3_diff != null ? gi.g3_diff : '?') + 'K';
                }
                failHoverScore.push('FAILED: ' + reason + '<br>Best score: ' + (ts.failScores[fi] || 0).toFixed(1) + gateLine);
                failHoverRad.push('FAILED: ' + reason + '<br>Best \u0394T: ' + (ts.failRadDifs[fi] || 0).toFixed(1) + ' K' + gateLine);
            }
            traces.push({
                x: ts.failTimes, y: ts.failScores, type: 'scatter', mode: 'markers',
                name: 'Failed (score)', marker: { size: 7, color: 'rgba(0,0,0,0)', line: { color: '#fb923c', width: 2 }, symbol: 'x' },
                yaxis: 'y', showlegend: false,
                hovertext: failHoverScore, hoverinfo: 'text+x'
            });
            traces.push({
                x: ts.failTimes, y: ts.failRadDifs, type: 'scatter', mode: 'markers',
                name: 'Failed (\u0394T)', marker: { size: 7, color: 'rgba(0,0,0,0)', line: { color: '#fb923c', width: 2 }, symbol: 'x' },
                yaxis: 'y2', showlegend: false,
                hovertext: failHoverRad, hoverinfo: 'text+x'
            });
        }
        var layout = JSON.parse(JSON.stringify(DIAG_LAYOUT_BASE));
        layout.title = { text: 'Center Fix Time Series', font: { size: 11, color: '#5b6573' } };
        layout.xaxis = { gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 8, family: 'JetBrains Mono, monospace' }, tickangle: -30 };
        layout.yaxis = { title: { text: 'Eye Score', font: { size: 9, color: '#22d3ee' } }, side: 'left', gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 9, family: 'JetBrains Mono, monospace' } };
        layout.yaxis2 = { title: { text: 'IR Rad Diff (K)', font: { size: 9, color: '#a78bfa' } }, side: 'right', overlaying: 'y', gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 9, family: 'JetBrains Mono, monospace' } };
        layout.legend = { x: 0, y: 1.15, orientation: 'h', font: { size: 9 } };
        layout.margin = { t: 32, r: 48, b: 44, l: 48 };
        layout.showlegend = true;

        // Vertical line at current frame + horizontal threshold line for min_ir_rad_dif
        layout.shapes = [];
        if (curTime) {
            layout.shapes.push({
                type: 'line', x0: curTime, x1: curTime, y0: 0, y1: 1,
                yref: 'paper', line: { color: '#ffffff44', width: 1, dash: 'dot' }
            });
        }
        // min_ir_rad_dif threshold (10 K) on the y2 axis
        layout.shapes.push({
            type: 'line', x0: 0, x1: 1, xref: 'paper',
            y0: 10, y1: 10, yref: 'y2',
            line: { color: '#fb923c66', width: 1, dash: 'dash' }
        });
        // Threshold label
        layout.annotations = layout.annotations || [];
        layout.annotations.push({
            x: 1.0, xref: 'paper', y: 10, yref: 'y2',
            text: 'min \u0394T', font: { size: 8, color: '#fb923c88' },
            showarrow: false, xanchor: 'right', yanchor: 'bottom'
        });

        if (div.data) {
            Plotly.react(div, traces, layout, DIAG_CONFIG);
        } else {
            Plotly.newPlot(div, traces, layout, DIAG_CONFIG);
        }
    }

    function renderTbHistogramChart(frame) {
        var div = document.getElementById('sat-diag-histogram');
        if (!div) return;
        var hist = computeTbHistogram(frame);
        if (!hist) { div.style.display = 'none'; return; }
        div.style.display = 'block';

        var colors = ['#f87171', '#fbbf24', '#34d399', '#60a5fa'];
        var traces = [];
        for (var i = 0; i < hist.bands.length; i++) {
            traces.push({
                x: hist.bands[i].tbBins, y: hist.bands[i].fractions,
                type: 'bar', name: hist.bands[i].label,
                marker: { color: colors[i], opacity: 0.65 },
                hovertemplate: '%{x:.0f} K: %{y:.1%}<extra>' + hist.bands[i].label + '</extra>'
            });
        }
        var layout = JSON.parse(JSON.stringify(DIAG_LAYOUT_BASE));
        layout.title = { text: 'Tb Distribution by Radial Band', font: { size: 11, color: '#5b6573' } };
        layout.xaxis = { title: { text: 'Brightness Temp (K)', font: { size: 10 } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 9, family: 'JetBrains Mono, monospace' } };
        layout.yaxis = { title: { text: 'Fraction', font: { size: 10 } }, tickformat: '.0%', gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 9, family: 'JetBrains Mono, monospace' } };
        layout.barmode = 'overlay';
        layout.legend = { x: 0, y: 1.15, orientation: 'h', font: { size: 9 } };
        layout.margin = { t: 32, r: 12, b: 44, l: 48 };
        layout.showlegend = true;

        if (div.data) {
            Plotly.react(div, traces, layout, DIAG_CONFIG);
        } else {
            Plotly.newPlot(div, traces, layout, DIAG_CONFIG);
        }
    }

    function buildHovmollerData() {
        // Use extended frames for 12h/24h lookback if available
        var srcFrames = irFrames;
        if (hovLookbackHours > 6 && hovExtFrames && hovExtStormId === currentStormId) {
            // Merge: extended frames (older) + irFrames (recent 6h)
            srcFrames = hovExtFrames.concat(irFrames);
            console.log('[Satellite] Hovmoller merge: ' + hovExtFrames.length + ' ext + ' +
                irFrames.length + ' ir = ' + srcFrames.length + ' total');
            if (hovExtFrames.length > 0) {
                console.log('[Satellite]   ext range: ' + hovExtFrames[0].datetime_utc +
                    ' → ' + hovExtFrames[hovExtFrames.length - 1].datetime_utc);
            }
            if (irFrames.length > 0) {
                var firstIr = irFrames[irFrames.length - 1], lastIr = irFrames[0];
                console.log('[Satellite]   ir  range: ' +
                    (firstIr ? firstIr.datetime_utc : '?') + ' → ' +
                    (lastIr ? lastIr.datetime_utc : '?'));
            }
        }

        var maxRadKm = 200;
        var dr = 4; // km bin width (coarser than radial profile for cleaner heatmap)
        var nRadBins = Math.ceil(maxRadKm / dr);
        var times = [];
        var profiles = []; // array of arrays, one per frame

        // For frames without center_fix, interpolate between the nearest
        // known fixes (or extrapolate from the closest one at the edges).
        // This accounts for storm motion between fix points.
        var fixLat = [], fixLon = [], nFixes = 0;
        var knownIndices = []; // indices with real (successful) center fixes
        for (var pi = 0; pi < srcFrames.length; pi++) {
            var pf = srcFrames[pi];
            if (pf && pf.center_fix && pf.center_fix.lat) {
                fixLat[pi] = pf.center_fix.lat;
                fixLon[pi] = pf.center_fix.lon;
                knownIndices.push(pi);
                nFixes++;
            }
        }

        // Interpolate/extrapolate for frames without fixes
        if (knownIndices.length >= 2) {
            // Linear interpolation between known fixes, linear extrapolation at edges
            for (var ii = 0; ii < srcFrames.length; ii++) {
                if (fixLat[ii] != null) continue;
                // Find bounding known indices
                var lo = -1, hi = -1;
                for (var ki = 0; ki < knownIndices.length; ki++) {
                    if (knownIndices[ki] <= ii) lo = ki;
                    if (knownIndices[ki] >= ii && hi < 0) hi = ki;
                }
                if (lo >= 0 && hi >= 0 && lo !== hi) {
                    // Interpolate between knownIndices[lo] and knownIndices[hi]
                    var loIdx = knownIndices[lo], hiIdx = knownIndices[hi];
                    var frac = (ii - loIdx) / (hiIdx - loIdx);
                    fixLat[ii] = fixLat[loIdx] + frac * (fixLat[hiIdx] - fixLat[loIdx]);
                    fixLon[ii] = fixLon[loIdx] + frac * (fixLon[hiIdx] - fixLon[loIdx]);
                } else if (knownIndices.length >= 2) {
                    // Extrapolate from the two nearest known fixes
                    var a, b;
                    if (lo < 0) { a = knownIndices[0]; b = knownIndices[1]; }
                    else { a = knownIndices[knownIndices.length - 2]; b = knownIndices[knownIndices.length - 1]; }
                    var span = b - a;
                    if (span > 0) {
                        var ext = (ii - a) / span;
                        fixLat[ii] = fixLat[a] + ext * (fixLat[b] - fixLat[a]);
                        fixLon[ii] = fixLon[a] + ext * (fixLon[b] - fixLon[a]);
                    }
                }
            }
        } else if (knownIndices.length === 1) {
            // Only one fix — use it for all frames
            var onlyIdx = knownIndices[0];
            for (var si = 0; si < srcFrames.length; si++) {
                if (fixLat[si] == null) { fixLat[si] = fixLat[onlyIdx]; fixLon[si] = fixLon[onlyIdx]; }
            }
        }

        console.log('[Satellite] Hovmoller centers: ' + nFixes + '/' + srcFrames.length +
            ' frames have IR center fixes, ' + (srcFrames.length - nFixes) + ' interpolated');

        var extrapolated = []; // parallel to times[] — true if center was interpolated/extrapolated

        for (var fi = srcFrames.length - 1; fi >= 0; fi--) {
            var frame = srcFrames[fi];
            if (!frame || !frame.tb_data) continue;

            var cLat = fixLat[fi], cLon = fixLon[fi];
            if (cLat == null) continue;
            var b = frame.bounds;
            var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
            var rows = frame.rows, cols = frame.cols;
            var vmin = frame.tb_vmin || 160.0, vmax = frame.tb_vmax || 330.0;
            var cy = (north - cLat) / (north - south) * (rows - 1);
            var cx = (cLon - west) / (east - west) * (cols - 1);
            var cosLat = Math.cos(cLat * Math.PI / 180);
            var dyKm = (north - south) / (rows - 1) * 111.0;
            var dxKm = (east - west) / (cols - 1) * 111.0 * cosLat;

            var sums = new Float64Array(nRadBins);
            var counts = new Int32Array(nRadBins);

            for (var r = 0; r < rows; r++) {
                var dY = (r - cy) * dyKm;
                for (var c = 0; c < cols; c++) {
                    var rawVal = frame.tb_data[r * cols + c];
                    if (rawVal === 0) continue;
                    var dX = (c - cx) * dxKm;
                    var dist = Math.sqrt(dY * dY + dX * dX);
                    var bin = Math.floor(dist / dr);
                    if (bin >= nRadBins) continue;
                    sums[bin] += decodeTbValue(rawVal, vmin, vmax);
                    counts[bin]++;
                }
            }

            var profile = new Array(nRadBins);
            for (var i = 0; i < nRadBins; i++) {
                profile[i] = counts[i] >= 3 ? (sums[i] / counts[i]) - 273.15 : null;
            }
            times.push(frame.datetime_utc);
            extrapolated.push(!(frame.center_fix && frame.center_fix.lat));
            profiles.push(profile);
        }

        console.log('[Satellite] Hovmoller: ' + times.length + ' frames with data out of ' + srcFrames.length +
            ' total (lookback=' + hovLookbackHours + 'h)');

        if (times.length < 2) return null;

        // Build radii array
        var radii = [];
        for (var ri = 0; ri < nRadBins; ri++) radii.push(ri * dr + dr / 2);

        // Transpose profiles to z[radius][time] for Plotly heatmap
        var z = [];
        for (var ri2 = 0; ri2 < nRadBins; ri2++) {
            var row = [];
            for (var ti = 0; ti < profiles.length; ti++) {
                row.push(profiles[ti][ri2]);
            }
            z.push(row);
        }

        return { times: times, radii: radii, z: z, extrapolated: extrapolated };
    }

    /**
     * Fetch extended IR frames for the Hovmoller (12h or 24h lookback).
     * Fetches only the frames beyond the standard 6h set (indices 13+).
     * Results are stored in hovExtFrames for reuse.
     */
    function fetchHovmollerFrames(hours) {
        if (!currentStormId) return;
        // Already have data for this storm + lookback?
        if (hovExtFrames && hovExtStormId === currentStormId && hovExtFrames._hours >= hours) {
            renderHovmollerChart();
            return;
        }

        hovExtFetching = true;
        hovExtStormId = currentStormId;
        var stormId = currentStormId;

        // Determine total frames for the extended lookback.
        // The backend reverses frame_times so index 0 = oldest.
        // With lookback_hours=12: indices 0-12 = older half (12h→6h ago),
        // indices 13-24 = recent half (6h→now, already in irFrames).
        // We only need the older portion: indices 0 to (totalFrames - 13 - 1).
        var totalFrames = Math.floor(hours * 60 / FRAME_INTERVAL_MIN) + 1;
        var extCount = totalFrames - 13;  // number of older frames to fetch

        // Reuse existing extended frames when upgrading (e.g. 12h→24h).
        // The existing frames cover the most recent portion of the ext range;
        // we only need to fetch the additional older frames.
        var reusedFrames = [];
        var fetchCount = extCount;
        if (hovExtFrames && hovExtFrames._hours > 6 && hovExtFrames.length > 0 &&
            hovExtStormId === stormId) {
            reusedFrames = hovExtFrames.slice();
            var prevTotal = Math.floor(hovExtFrames._hours * 60 / FRAME_INTERVAL_MIN) + 1;
            var prevExtCount = prevTotal - 13;
            fetchCount = Math.max(0, extCount - prevExtCount);
            console.log('[Satellite] Hovmoller upgrade: reusing ' + reusedFrames.length +
                ' frames from ' + hovExtFrames._hours + 'h, fetching ' + fetchCount + ' new');
        }

        if (fetchCount === 0) {
            reusedFrames._hours = hours;
            hovExtFrames = reusedFrames;
            hovExtFetching = false;
            renderHovmollerChart();
            return;
        }

        var extFrames = [];
        var completed = 0;
        var failed = 0;
        var concurrency = 10;

        // Show loading status
        var hovChart = document.getElementById('sat-diag-hovmoller-chart');
        if (hovChart) hovChart.style.opacity = '0.4';

        function fetchFrame(idx) {
            if (idx >= fetchCount) return;
            if (stormId !== currentStormId) return;

            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/ir-raw-frame'
                + '?frame_index=' + idx
                + '&lookback_hours=' + hours
                + '&radius_deg=' + DEFAULT_RADIUS_DEG
                + '&interval_min=' + FRAME_INTERVAL_MIN;

            fetch(url, { cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (data) {
                    if (stormId !== currentStormId) return;
                    extFrames[idx] = {
                        tb_data: decodeTbData(data.tb_data),
                        rows: data.tb_rows, cols: data.tb_cols,
                        bounds: data.bounds,
                        datetime_utc: data.datetime_utc || '',
                        satellite: data.satellite || '',
                        tb_vmin: data.tb_vmin || 160.0, tb_vmax: data.tb_vmax || 330.0,
                        center_fix: data.center_fix || null,
                    };
                    completed++;
                })
                .catch(function (err) {
                    console.warn('[Satellite] Hovmoller frame ' + idx + ' failed:', err.message || err);
                    failed++;
                    completed++;
                })
                .finally(function () {
                    var nextIdx = idx + concurrency;
                    if (nextIdx < fetchCount) fetchFrame(nextIdx);

                    // Update loading status
                    if (loadStatusEl) loadStatusEl.textContent = 'Hov ' + completed + '/' + fetchCount;

                    if (completed >= fetchCount) {
                        // Compact newly fetched frames
                        var newFrames = [];
                        for (var i = 0; i < extFrames.length; i++) {
                            if (extFrames[i]) newFrames.push(extFrames[i]);
                        }
                        // Merge with reused frames from shorter lookback
                        var result = newFrames.concat(reusedFrames);
                        // Sort by datetime (oldest first) so concat with irFrames works
                        result.sort(function (a, b) {
                            return (a.datetime_utc || '').localeCompare(b.datetime_utc || '');
                        });
                        result._hours = hours;
                        hovExtFrames = result;
                        hovExtFetching = false;
                        // Log time range for debugging
                        if (result.length > 0) {
                            console.log('[Satellite] Hovmoller ext time range: ' +
                                result[0].datetime_utc + ' to ' +
                                result[result.length - 1].datetime_utc);
                        }
                        if (hovChart) hovChart.style.opacity = '1';
                        console.log('[Satellite] Hovmoller extended frames loaded: ' +
                            newFrames.length + ' new + ' + reusedFrames.length +
                            ' reused, ' + failed + ' failed (' + hours + 'h)');
                        if (stormId === currentStormId) renderHovmollerChart();
                    }
                });
        }

        // Launch initial batch — only the new older frames
        var batchSize = Math.min(concurrency, fetchCount);
        for (var i = 0; i < batchSize; i++) {
            fetchFrame(i);
        }
    }

    /**
     * Fetch pre-computed Hovmoller radial profiles from the server.
     * Single request replaces 25-49 individual ir-raw-frame fetches.
     */
    function fetchHovmollerFromServer(hours) {
        if (!currentStormId) return;
        // Reuse cached server data if available for same storm + sufficient lookback
        if (hovServerData && hovServerStormId === currentStormId && hovServerData._hours >= hours) {
            renderHovmollerChart();
            return;
        }
        hovExtFetching = true;
        var stormId = currentStormId;
        var hovChart = document.getElementById('sat-diag-hovmoller-chart');
        if (hovChart) hovChart.style.opacity = '0.4';
        if (loadStatusEl) loadStatusEl.textContent = 'Hov...';

        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/hovmoller'
            + '?lookback_hours=' + hours
            + '&radius_deg=' + DEFAULT_RADIUS_DEG
            + '&interval_min=' + FRAME_INTERVAL_MIN;

        fetch(url, { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                if (stormId !== currentStormId) return;
                data._hours = hours;
                hovServerData = data;
                hovServerStormId = stormId;
                hovExtFetching = false;
                if (loadStatusEl) loadStatusEl.textContent = '';
                if (hovChart) hovChart.style.opacity = '1';
                console.log('[Satellite] Server Hovmoller: ' + data.n_frames + ' frames (' + hours + 'h)');
                renderHovmollerChart();
            })
            .catch(function (err) {
                console.warn('[Satellite] Server Hovmoller failed, falling back to frame fetch:', err.message);
                hovExtFetching = false;
                if (loadStatusEl) loadStatusEl.textContent = '';
                if (hovChart) hovChart.style.opacity = '1';
                // Fall back to individual frame fetches
                fetchHovmollerFrames(hours);
            });
    }

    function renderHovmollerChart() {
        var div = document.getElementById('sat-diag-hovmoller-chart');
        if (!div) return;

        // Use server-side Hovmoller data for extended lookbacks if available
        var hov;
        if (hovLookbackHours > 6 && hovServerData && hovServerStormId === currentStormId &&
            hovServerData._hours >= hovLookbackHours && hovServerData.times && hovServerData.times.length >= 2) {
            // Server data: profiles[time][radius] — already in Plotly orientation
            hov = {
                times: hovServerData.times,
                radii: hovServerData.radii,
                z: hovServerData.profiles,  // already [time][radius]
                extrapolated: hovServerData.extrapolated,
                _fromServer: true
            };
        } else {
            hov = buildHovmollerData();
        }
        if (!hov) { div.style.display = 'none'; return; }
        div.style.display = 'block';

        // Claude IR colorscale mapped to Celsius (-100 to +40)
        // Tb stops from claude-ir LUT converted to fraction of [-100, 40] range
        var _hovCrange = [-100, 40], _hovSpan = _hovCrange[1] - _hovCrange[0];
        function _tbCtoFrac(tbK) { return Math.max(0, Math.min(1, ((tbK - 273.15) - _hovCrange[0]) / _hovSpan)); }
        var hovColorscale = [
            [0.00,                      'rgb(28,12,96)'],    // 173K = -100C
            [_tbCtoFrac(183),           'rgb(64,24,140)'],   // -90C
            [_tbCtoFrac(193),           'rgb(120,48,180)'],  // -80C
            [_tbCtoFrac(198),           'rgb(168,64,200)'],  // -75C
            [_tbCtoFrac(203),           'rgb(196,48,156)'],  // -70C
            [_tbCtoFrac(208),           'rgb(180,36,68)'],   // -65C
            [_tbCtoFrac(213),           'rgb(214,78,56)'],   // -60C
            [_tbCtoFrac(218),           'rgb(228,132,48)'],  // -55C
            [_tbCtoFrac(223),           'rgb(238,196,48)'],  // -50C
            [_tbCtoFrac(228),           'rgb(192,220,40)'],  // -45C
            [_tbCtoFrac(233),           'rgb(96,208,68)'],   // -40C
            [_tbCtoFrac(238),           'rgb(40,178,116)'],  // -35C
            [_tbCtoFrac(243),           'rgb(32,148,166)'],  // -30C
            [_tbCtoFrac(248),           'rgb(68,180,196)'],  // -25C
            [_tbCtoFrac(253),           'rgb(140,210,220)'], // -20C
            [_tbCtoFrac(263),           'rgb(216,218,228)'], // -10C
            [_tbCtoFrac(273),           'rgb(180,180,192)'], //  0C
            [_tbCtoFrac(283),           'rgb(120,120,132)'], // 10C
            [_tbCtoFrac(293),           'rgb(70,70,82)'],    // 20C
            [1.00,                      'rgb(12,12,22)']     // 310K = 37C
        ];

        // Transpose z to z[time][radius] so time is Y-axis
        // Server data is already in [time][radius] orientation
        var zT;
        if (hov._fromServer) {
            zT = hov.z;
        } else {
            zT = [];
            for (var ti = 0; ti < hov.times.length; ti++) {
                var row = [];
                for (var ri = 0; ri < hov.radii.length; ri++) {
                    row.push(hov.z[ri][ti]);
                }
                zT.push(row);
            }
        }

        var traces = [{
            x: hov.radii, y: hov.times, z: zT,
            type: 'heatmap',
            colorscale: hovColorscale,
            zmin: _hovCrange[0], zmax: _hovCrange[1],
            colorbar: {
                title: { text: '\u00B0C', font: { size: 13, color: '#5b6573' } },
                tickfont: { size: 12, family: 'JetBrains Mono, monospace', color: '#5b6573' },
                thickness: 14, len: 0.9
            },
            hovertemplate: '%{y|%H:%M UTC}<br>%{x:.0f} km<br>%{z:.1f} \u00B0C<extra></extra>'
        }];

        var layout = JSON.parse(JSON.stringify(DIAG_LAYOUT_BASE));
        layout.title = { text: 'Azimuthal-Mean Tb Hovmoller', font: { size: 15, color: '#5b6573' } };
        layout.xaxis = { title: { text: 'Radius (km)', font: { size: 13 } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 12, family: 'JetBrains Mono, monospace' } };
        layout.yaxis = { title: { text: 'Time (UTC)', font: { size: 13 } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 11, family: 'JetBrains Mono, monospace' }, autorange: true };
        layout.margin = { t: 36, r: 64, b: 44, l: 84 };

        // Horizontal line at current frame time
        var curFrame = irFrames[animIndex];
        if (curFrame && curFrame.datetime_utc) {
            layout.shapes = [{
                type: 'line', y0: curFrame.datetime_utc, y1: curFrame.datetime_utc,
                x0: 0, x1: 1, xref: 'paper',
                line: { color: '#ffffff66', width: 1.5, dash: 'dot' }
            }];
        }

        // Orange asterisks just left of data area for extrapolated center positions
        layout.annotations = layout.annotations || [];
        for (var ei = 0; ei < hov.extrapolated.length; ei++) {
            if (hov.extrapolated[ei]) {
                layout.annotations.push({
                    x: -2, xref: 'x',
                    y: hov.times[ei], yref: 'y',
                    text: '\u2731',
                    font: { size: 10, color: '#fb923c', family: 'sans-serif' },
                    showarrow: false,
                    xanchor: 'center'
                });
            }
        }

        // Purge and re-create the plot to ensure Plotly picks up new
        // Y-axis range when lookback changes (react can pin old range).
        Plotly.purge(div);
        Plotly.newPlot(div, traces, layout, DIAG_CONFIG);
    }

    function renderDiagnostics() {
        if (viewMode !== 'diagnostics') return;
        var frame = irFrames[animIndex];
        if (!frame) return;
        var emptyMsg = document.getElementById('sat-diag-empty');
        var chartsView = document.getElementById('sat-diag-charts');
        var hovView = document.getElementById('sat-diag-hovmoller');

        // Check if any frame has center_fix
        var hasCenterFix = false;
        var hasRawTb = false;
        if (frame.center_fix) {
            hasCenterFix = true;
        } else {
            for (var i = 0; i < irFrames.length; i++) {
                if (irFrames[i] && irFrames[i].center_fix) { hasCenterFix = true; break; }
            }
        }
        for (var j = 0; j < irFrames.length; j++) {
            if (irFrames[j] && irFrames[j].tb_data) { hasRawTb = true; break; }
        }

        if (!hasCenterFix) {
            if (chartsView) chartsView.style.display = 'none';
            if (hovView) hovView.style.display = 'none';
            if (emptyMsg) {
                emptyMsg.style.display = '';
                // Show loading message during preview phase (raw Tb not yet loaded)
                if (!hasRawTb) {
                    emptyMsg.innerHTML = 'Loading diagnostics\u2026';
                } else {
                    emptyMsg.innerHTML = 'No center fix available for this frame.<br>Diagnostics require a detected eye (storms \u2265 65 kt).';
                }
            }
            return;
        }
        if (emptyMsg) emptyMsg.style.display = 'none';

        if (diagTab === 'charts') {
            if (chartsView) chartsView.style.display = '';
            if (hovView) hovView.style.display = 'none';
            if (frame.center_fix && frame.center_fix.lat) {
                renderRadialProfileChart(frame);
                renderTbHistogramChart(frame);
            }
            renderCenterFixTimeSeries();
        } else {
            if (chartsView) chartsView.style.display = 'none';
            if (hovView) hovView.style.display = '';
            renderHovmollerChart();
        }
        diagChartsInitialized = true;
    }

    // ── Track Map (pure canvas) ──────────────────────────────

    var trackMetadata = null;
    var canvasTrack = null, ctxTrack = null;

    function loadTrackMetadata(stormId, cb) {
        if (trackMetadata && trackMetadata._stormId === stormId) { if (cb) cb(); return; }
        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/metadata';
        fetch(url, { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                trackMetadata = data;
                trackMetadata._stormId = stormId;
                if (cb) cb();
            })
            .catch(function (err) {
                console.warn('[Satellite] Track metadata fetch failed:', err.message);
                if (cb) cb();
            });
    }

    function renderTrackMap() {
        if (!canvasTrack) {
            canvasTrack = document.getElementById('sat-canvas-track');
            ctxTrack = canvasTrack ? canvasTrack.getContext('2d') : null;
        }
        if (!ctxTrack) return;

        // Collect all points to auto-fit bounds
        var allLats = [], allLons = [];

        // IR center fixes from loaded frames
        var irFixes = [];
        for (var i = 0; i < irFrames.length; i++) {
            var f = irFrames[i];
            if (f && f.center_fix && f.center_fix.lat) {
                irFixes.push({ lat: f.center_fix.lat, lon: f.center_fix.lon, time: f.datetime_utc, score: f.center_fix.eye_score, idx: i });
                allLats.push(f.center_fix.lat); allLons.push(f.center_fix.lon);
            }
        }

        // Official past track
        var pastTrack = [];
        if (trackMetadata && trackMetadata.intensity_history) {
            for (var j = 0; j < trackMetadata.intensity_history.length; j++) {
                var h = trackMetadata.intensity_history[j];
                pastTrack.push(h);
                allLats.push(h.lat); allLons.push(h.lon);
            }
        }

        // Forecast track
        var fcstTrack = [];
        if (trackMetadata && trackMetadata.forecast_track) {
            for (var k = 0; k < trackMetadata.forecast_track.length; k++) {
                var ft = trackMetadata.forecast_track[k];
                fcstTrack.push(ft);
                allLats.push(ft.lat); allLons.push(ft.lon);
            }
        }

        // Also include current storm position
        if (currentStorm) {
            allLats.push(currentStorm.lat); allLons.push(currentStorm.lon);
        }

        if (allLats.length === 0) return;

        // Compute bounds with padding
        var minLat = Math.min.apply(null, allLats) - 2;
        var maxLat = Math.max.apply(null, allLats) + 2;
        var minLon = Math.min.apply(null, allLons) - 2;
        var maxLon = Math.max.apply(null, allLons) + 2;
        // Ensure minimum span
        if (maxLat - minLat < 6) { var cLa = (minLat + maxLat) / 2; minLat = cLa - 3; maxLat = cLa + 3; }
        if (maxLon - minLon < 6) { var cLo = (minLon + maxLon) / 2; minLon = cLo - 3; maxLon = cLo + 3; }
        // Adjust aspect ratio for cos(lat) — 1° lon is shorter than 1° lat
        var midLat = (minLat + maxLat) / 2;
        var cosAdj = Math.cos(midLat * Math.PI / 180);
        var latSpan = maxLat - minLat;
        var lonSpan = maxLon - minLon;
        // Target: lonSpan * cosAdj should equal latSpan for equidistant projection
        var latKm = latSpan * 111;
        var lonKm = lonSpan * 111 * cosAdj;
        if (latKm > lonKm) {
            var needLonDeg = latKm / (111 * cosAdj);
            var d = (needLonDeg - lonSpan) / 2;
            minLon -= d; maxLon += d; lonSpan = maxLon - minLon;
        } else if (lonKm > latKm) {
            var needLatDeg = lonKm / 111;
            var d2 = (needLatDeg - latSpan) / 2;
            minLat -= d2; maxLat += d2; latSpan = maxLat - minLat;
        }

        // Canvas sizing
        var parent = canvasTrack.parentElement;
        var pw = parent ? parent.clientWidth : 600;
        var ph = parent ? parent.clientHeight : 600;
        var sz = Math.min(pw, ph, 800) || 600;
        canvasTrack.width = sz;
        canvasTrack.height = sz;
        canvasTrack.style.maxWidth = '100%';
        canvasTrack.style.maxHeight = '100%';
        var w = sz, h = sz;

        function lonToPx(lon) { return (lon - minLon) / lonSpan * w; }
        function latToPx(lat) { return (maxLat - lat) / latSpan * h; }

        // Background
        ctxTrack.fillStyle = '#0a0c12';
        ctxTrack.fillRect(0, 0, w, h);

        // Grid lines
        var gridStep = latSpan > 12 ? 5 : latSpan > 6 ? 2 : 1;
        ctxTrack.strokeStyle = 'rgba(200,200,220,0.15)';
        ctxTrack.lineWidth = 0.5;
        for (var glat = Math.ceil(minLat / gridStep) * gridStep; glat <= maxLat; glat += gridStep) {
            var gy = latToPx(glat);
            ctxTrack.beginPath(); ctxTrack.moveTo(0, gy); ctxTrack.lineTo(w, gy); ctxTrack.stroke();
        }
        for (var glon = Math.ceil(minLon / gridStep) * gridStep; glon <= maxLon; glon += gridStep) {
            var gx = lonToPx(glon);
            ctxTrack.beginPath(); ctxTrack.moveTo(gx, 0); ctxTrack.lineTo(gx, h); ctxTrack.stroke();
        }

        // Grid labels
        ctxTrack.fillStyle = '#5c6070';
        ctxTrack.font = '9px JetBrains Mono, monospace';
        for (var glat2 = Math.ceil(minLat / gridStep) * gridStep; glat2 <= maxLat; glat2 += gridStep) {
            ctxTrack.fillText(Math.abs(glat2) + (glat2 >= 0 ? 'N' : 'S'), 4, latToPx(glat2) - 3);
        }
        ctxTrack.textAlign = 'center';
        for (var glon2 = Math.ceil(minLon / gridStep) * gridStep; glon2 <= maxLon; glon2 += gridStep) {
            ctxTrack.fillText(Math.abs(glon2) + (glon2 >= 0 ? 'E' : 'W'), lonToPx(glon2), h - 4);
        }
        ctxTrack.textAlign = 'left';

        // Coastlines
        if (coastlineData) {
            ctxTrack.strokeStyle = 'rgba(200,180,120,0.5)';
            ctxTrack.lineWidth = 1;
            var features = coastlineData.features || [];
            for (var fi = 0; fi < features.length; fi++) {
                var geom = features[fi].geometry;
                if (!geom) continue;
                var coordSets = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
                for (var cs = 0; cs < coordSets.length; cs++) {
                    var coords = coordSets[cs];
                    if (!coords || coords.length < 2) continue;
                    ctxTrack.beginPath();
                    var started = false;
                    for (var ci = 0; ci < coords.length; ci++) {
                        var clon = coords[ci][0], clat = coords[ci][1];
                        if (clon < minLon || clon > maxLon || clat < minLat || clat > maxLat) { started = false; continue; }
                        var cpx = lonToPx(clon), cpy = latToPx(clat);
                        if (!started) { ctxTrack.moveTo(cpx, cpy); started = true; } else ctxTrack.lineTo(cpx, cpy);
                    }
                    ctxTrack.stroke();
                }
            }
        }

        // Official past track
        if (pastTrack.length > 1) {
            ctxTrack.lineWidth = 2;
            for (var pi = 1; pi < pastTrack.length; pi++) {
                var p0 = pastTrack[pi - 1], p1 = pastTrack[pi];
                var cat = p1.vmax_kt >= 137 ? 'C5' : p1.vmax_kt >= 113 ? 'C4' : p1.vmax_kt >= 96 ? 'C3' :
                    p1.vmax_kt >= 83 ? 'C2' : p1.vmax_kt >= 64 ? 'C1' : p1.vmax_kt >= 34 ? 'TS' : 'TD';
                ctxTrack.strokeStyle = SS_COLORS[cat] || '#60a5fa';
                ctxTrack.beginPath();
                ctxTrack.moveTo(lonToPx(p0.lon), latToPx(p0.lat));
                ctxTrack.lineTo(lonToPx(p1.lon), latToPx(p1.lat));
                ctxTrack.stroke();
            }
            // Dots at each fix
            for (var pd = 0; pd < pastTrack.length; pd++) {
                var pt = pastTrack[pd];
                var pcat = pt.vmax_kt >= 137 ? 'C5' : pt.vmax_kt >= 113 ? 'C4' : pt.vmax_kt >= 96 ? 'C3' :
                    pt.vmax_kt >= 83 ? 'C2' : pt.vmax_kt >= 64 ? 'C1' : pt.vmax_kt >= 34 ? 'TS' : 'TD';
                ctxTrack.fillStyle = SS_COLORS[pcat] || '#60a5fa';
                ctxTrack.beginPath();
                ctxTrack.arc(lonToPx(pt.lon), latToPx(pt.lat), 3, 0, 2 * Math.PI);
                ctxTrack.fill();
            }
        }

        // Forecast track (dashed)
        if (fcstTrack.length > 0) {
            var fcstStart = pastTrack.length > 0 ? pastTrack[pastTrack.length - 1] : (currentStorm || null);
            ctxTrack.strokeStyle = 'rgba(255,255,255,0.4)';
            ctxTrack.lineWidth = 1.5;
            ctxTrack.setLineDash([6, 4]);
            ctxTrack.beginPath();
            if (fcstStart) ctxTrack.moveTo(lonToPx(fcstStart.lon), latToPx(fcstStart.lat));
            for (var fci = 0; fci < fcstTrack.length; fci++) {
                ctxTrack.lineTo(lonToPx(fcstTrack[fci].lon), latToPx(fcstTrack[fci].lat));
            }
            ctxTrack.stroke();
            ctxTrack.setLineDash([]);
            // Forecast dots with tau labels
            ctxTrack.fillStyle = 'rgba(255,255,255,0.5)';
            ctxTrack.font = '8px JetBrains Mono, monospace';
            for (var fdi = 0; fdi < fcstTrack.length; fdi++) {
                var fp = fcstTrack[fdi];
                var fpx = lonToPx(fp.lon), fpy = latToPx(fp.lat);
                ctxTrack.beginPath();
                ctxTrack.arc(fpx, fpy, 3, 0, 2 * Math.PI);
                ctxTrack.fill();
                if (fp.tau_h % 24 === 0) {
                    ctxTrack.fillText(fp.tau_h + 'h', fpx + 5, fpy - 4);
                }
            }
        }

        // IR center-fix track (cyan)
        if (irFixes.length > 1) {
            ctxTrack.strokeStyle = '#22d3ee';
            ctxTrack.lineWidth = 2;
            ctxTrack.beginPath();
            ctxTrack.moveTo(lonToPx(irFixes[0].lon), latToPx(irFixes[0].lat));
            for (var iri = 1; iri < irFixes.length; iri++) {
                ctxTrack.lineTo(lonToPx(irFixes[iri].lon), latToPx(irFixes[iri].lat));
            }
            ctxTrack.stroke();
        }
        // IR fix dots
        for (var ird = 0; ird < irFixes.length; ird++) {
            var irp = irFixes[ird];
            var isCurrent = irp.idx === animIndex;
            ctxTrack.fillStyle = isCurrent ? '#ffffff' : '#22d3ee';
            ctxTrack.beginPath();
            ctxTrack.arc(lonToPx(irp.lon), latToPx(irp.lat), isCurrent ? 6 : 3, 0, 2 * Math.PI);
            ctxTrack.fill();
            if (isCurrent) {
                ctxTrack.strokeStyle = '#22d3ee';
                ctxTrack.lineWidth = 2;
                ctxTrack.stroke();
            }
        }

        // Legend
        ctxTrack.font = '9px DM Sans, sans-serif';
        var ly = 16;
        ctxTrack.fillStyle = '#22d3ee';
        ctxTrack.fillRect(8, ly - 6, 12, 3); ctxTrack.fillText('IR Fix', 24, ly); ly += 14;
        ctxTrack.fillStyle = '#60a5fa';
        ctxTrack.fillRect(8, ly - 6, 12, 3); ctxTrack.fillText('Best Track', 24, ly); ly += 14;
        ctxTrack.fillStyle = 'rgba(255,255,255,0.4)';
        ctxTrack.setLineDash([4, 3]); ctxTrack.beginPath(); ctxTrack.moveTo(8, ly - 4); ctxTrack.lineTo(20, ly - 4); ctxTrack.stroke(); ctxTrack.setLineDash([]);
        ctxTrack.fillStyle = 'rgba(255,255,255,0.5)';
        ctxTrack.fillText('Forecast', 24, ly);
    }

    // ── IR Asymmetry (WN-1 anomaly, canvas) ─────────────────

    var canvasAsym = null, ctxAsym = null;
    var overlayAsym = null, overlayCtxAsym = null;
    var cbAsymCanvas = null, cbAsymLeft = null, cbAsymRight = null;
    var axesYAsym = null, axesXAsym = null;

    // RdBu_r diverging colorscale LUT (blue=cold anomaly, red=warm anomaly)
    var ASYM_LUT = (function () {
        var stops = [
            { f: 0.00, r: 5, g: 48, b: 97 },
            { f: 0.10, r: 33, g: 102, b: 172 },
            { f: 0.20, r: 67, g: 147, b: 195 },
            { f: 0.30, r: 146, g: 197, b: 222 },
            { f: 0.40, r: 209, g: 229, b: 240 },
            { f: 0.50, r: 247, g: 247, b: 247 },
            { f: 0.60, r: 253, g: 219, b: 199 },
            { f: 0.70, r: 244, g: 165, b: 130 },
            { f: 0.80, r: 214, g: 96, b: 77 },
            { f: 0.90, r: 178, g: 24, b: 43 },
            { f: 1.00, r: 103, g: 0, b: 31 }
        ];
        var lut = new Uint8Array(256 * 4);
        lut[0] = 0; lut[1] = 0; lut[2] = 0; lut[3] = 0; // 0 = transparent (no data)
        for (var i = 1; i <= 255; i++) {
            var frac = (i - 1) / 254.0;
            var lo = stops[0], hi = stops[stops.length - 1];
            for (var s = 0; s < stops.length - 1; s++) {
                if (frac >= stops[s].f && frac <= stops[s + 1].f) { lo = stops[s]; hi = stops[s + 1]; break; }
            }
            var t = (hi.f === lo.f) ? 0 : (frac - lo.f) / (hi.f - lo.f);
            var idx = i * 4;
            lut[idx] = Math.round(lo.r + t * (hi.r - lo.r));
            lut[idx + 1] = Math.round(lo.g + t * (hi.g - lo.g));
            lut[idx + 2] = Math.round(lo.b + t * (hi.b - lo.b));
            lut[idx + 3] = 255;
        }
        return lut;
    })();

    function computeAndRenderAsymmetry(frame) {
        if (!frame || !frame.center_fix || !frame.tb_data) return false;
        if (!canvasAsym) {
            canvasAsym = document.getElementById('sat-canvas-asym');
            ctxAsym = canvasAsym ? canvasAsym.getContext('2d') : null;
            overlayAsym = document.getElementById('sat-overlay-asym');
            overlayCtxAsym = overlayAsym ? overlayAsym.getContext('2d') : null;
            cbAsymCanvas = document.getElementById('sat-cb-asym-canvas');
            cbAsymLeft = document.getElementById('sat-cb-asym-left');
            cbAsymRight = document.getElementById('sat-cb-asym-right');
            axesYAsym = document.getElementById('sat-axes-y-asym');
            axesXAsym = document.getElementById('sat-axes-x-asym');
        }
        if (!ctxAsym) return false;

        var cLat = frame.center_fix.lat, cLon = frame.center_fix.lon;
        var b = frame.bounds;
        var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
        var rows = frame.rows, cols = frame.cols;
        var vmin = frame.tb_vmin || 160.0, vmax = frame.tb_vmax || 330.0;
        var cy = (north - cLat) / (north - south) * (rows - 1);
        var cx = (cLon - west) / (east - west) * (cols - 1);
        var cosLat = Math.cos(cLat * Math.PI / 180);
        var dyKm = (north - south) / (rows - 1) * 111.0;
        var dxKm = (east - west) / (cols - 1) * 111.0 * cosLat;
        var maxRadKm = Math.min(zoomDeg * 111.0, 500);
        var dr = 2;
        var nBins = Math.ceil(maxRadKm / dr);

        // Pass 1: compute azimuthal-mean Tb per radial bin
        var sums = new Float64Array(nBins);
        var counts = new Int32Array(nBins);
        for (var r = 0; r < rows; r++) {
            var dY = (r - cy) * dyKm;
            for (var c = 0; c < cols; c++) {
                var rawVal = frame.tb_data[r * cols + c];
                if (rawVal === 0) continue;
                var dX = (c - cx) * dxKm;
                var dist = Math.sqrt(dY * dY + dX * dX);
                var bin = Math.floor(dist / dr);
                if (bin >= nBins) continue;
                sums[bin] += decodeTbValue(rawVal, vmin, vmax);
                counts[bin]++;
            }
        }
        var binMeans = new Float64Array(nBins);
        for (var bi = 0; bi < nBins; bi++) {
            binMeans[bi] = counts[bi] >= 3 ? sums[bi] / counts[bi] : NaN;
        }

        // Pass 2: render anomaly (Tb - azimuthal mean) to canvas
        var vb = getViewBounds(frame);
        if (!vb) return false;
        var crop = getCropIndices(frame, vb);
        if (crop.rows <= 0 || crop.cols <= 0) return false;

        canvasAsym.width = frame.cols;
        canvasAsym.height = frame.rows;
        var imgData = ctxAsym.createImageData(frame.cols, frame.rows);
        var pixels = imgData.data;

        // Fill background
        for (var p = 0; p < pixels.length; p += 4) {
            pixels[p] = 10; pixels[p + 1] = 11; pixels[p + 2] = 18; pixels[p + 3] = 255;
        }

        var scaleY = frame.rows / crop.rows;
        var scaleX = frame.cols / crop.cols;
        var anomMin = -20, anomMax = 20, anomSpan = anomMax - anomMin;

        for (var y = 0; y < frame.rows; y++) {
            var srcRow = crop.r0 + Math.floor(y / scaleY);
            if (srcRow < crop.r0 || srcRow >= crop.r1) continue;
            for (var x = 0; x < frame.cols; x++) {
                var srcCol = crop.c0 + Math.floor(x / scaleX);
                if (srcCol < crop.c0 || srcCol >= crop.c1) continue;
                var rv = frame.tb_data[srcRow * frame.cols + srcCol];
                if (rv === 0) continue;
                var dYa = (srcRow - cy) * dyKm;
                var dXa = (srcCol - cx) * dxKm;
                var distA = Math.sqrt(dYa * dYa + dXa * dXa);
                var binA = Math.floor(distA / dr);
                if (binA >= nBins || isNaN(binMeans[binA])) continue;
                var tbVal = decodeTbValue(rv, vmin, vmax);
                var anomaly = (tbVal - binMeans[binA]); // positive = warmer than mean
                // Convert anomaly in K to Celsius anomaly (same since it's a difference)
                var lutIdx = Math.round(Math.max(1, Math.min(255, (anomaly - anomMin) / anomSpan * 254 + 1)));
                var pi2 = (y * frame.cols + x) * 4;
                var li2 = lutIdx * 4;
                pixels[pi2] = ASYM_LUT[li2]; pixels[pi2 + 1] = ASYM_LUT[li2 + 1];
                pixels[pi2 + 2] = ASYM_LUT[li2 + 2]; pixels[pi2 + 3] = ASYM_LUT[li2 + 3];
            }
        }
        ctxAsym.putImageData(imgData, 0, 0);

        // Overlay (grid, coastlines, crosshair)
        drawOverlay(overlayAsym, overlayCtxAsym, frame);

        // Colorbar
        if (cbAsymCanvas) {
            var cbCtx = cbAsymCanvas.getContext('2d');
            var cbW = cbAsymCanvas.width, cbH = cbAsymCanvas.height;
            var cbImg = cbCtx.createImageData(cbW, cbH);
            var cbPx = cbImg.data;
            for (var cbx = 0; cbx < cbW; cbx++) {
                var cbVal = Math.round(1 + cbx / (cbW - 1) * 254);
                var cbLi = cbVal * 4;
                for (var cby = 0; cby < cbH; cby++) {
                    var cbPi = (cby * cbW + cbx) * 4;
                    cbPx[cbPi] = ASYM_LUT[cbLi]; cbPx[cbPi + 1] = ASYM_LUT[cbLi + 1];
                    cbPx[cbPi + 2] = ASYM_LUT[cbLi + 2]; cbPx[cbPi + 3] = 255;
                }
            }
            cbCtx.putImageData(cbImg, 0, 0);
            if (cbAsymLeft) cbAsymLeft.textContent = anomMin + ' \u00B0C';
            if (cbAsymRight) cbAsymRight.textContent = '+' + anomMax + ' \u00B0C';
        }

        // Axes
        if (vb) renderAxes(axesYAsym, axesXAsym, vb);

        return true;
    }

    // ── View Mode Toggle ───────────────────────────────────────

    function setViewMode(newMode) {
        // Mobile guard — WV/Vis comparison modes are hidden on mobile
        // because side-by-side dual-pane is unreadable at phone widths
        // and doubled the image memory footprint. If a stale hash or
        // programmatic call still tries to enter them, redirect to
        // diagnostics so the user lands somewhere usable.
        if (_satIsMobileLayout()
            && (newMode === 'compare-wv' || newMode === 'compare-vis')) {
            newMode = 'diagnostics';
        }
        if (newMode === viewMode) return;
        viewMode = newMode;

        var rightPanel = document.getElementById('sat-panel-right');
        var diagPanel = document.getElementById('sat-diag-panel');
        var comparePanel = document.getElementById('sat-compare-panel');
        var compareOptions = document.getElementById('sat-compare-options');
        var trackPanel = document.getElementById('sat-track-panel');
        var asymPanel = document.getElementById('sat-asym-panel');
        var mwPanel = document.getElementById('sat-mw-section');

        if (rightPanel) rightPanel.setAttribute('data-mode', newMode);

        // Hide all panels first
        if (diagPanel) diagPanel.style.display = 'none';
        if (comparePanel) comparePanel.style.display = 'none';
        if (compareOptions) compareOptions.style.display = 'none';
        if (trackPanel) trackPanel.style.display = 'none';
        if (asymPanel) asymPanel.style.display = 'none';
        if (mwPanel) mwPanel.style.display = 'none';

        // MW mode: show the dedicated MW dual-pane panel + ensure the
        // left IR pane is on Leaflet. _satMwActivate handles the
        // canvas/leaflet visibility swap so Phase 2 doesn't fight us.
        // Non-MW modes: leave the IR-pane visibility to Phase 2's
        // _satIrSyncLeaflet (called inside renderBothPanels), which
        // picks canvas vs leaflet based on mode + colormap.
        if (newMode === 'microwave') {
            if (mwPanel) mwPanel.style.display = '';
            _satMwActivate();
        } else {
            _satMwDeactivate();
        }

        if (newMode === 'microwave') {
            // (handled above)
        } else if (newMode === 'diagnostics') {
            if (diagPanel) diagPanel.style.display = '';
            setTimeout(function () {
                var r = document.getElementById('sat-diag-radial');
                var t = document.getElementById('sat-diag-timeseries');
                var h = document.getElementById('sat-diag-histogram');
                if (r && r.data) Plotly.Plots.resize(r);
                if (t && t.data) Plotly.Plots.resize(t);
                if (h && h.data) Plotly.Plots.resize(h);
                renderDiagnostics();
            }, 50);
        } else if (newMode === 'track-map') {
            if (trackPanel) trackPanel.style.display = '';
            if (currentStormId) {
                loadTrackMetadata(currentStormId, function () { renderTrackMap(); });
            }
            // Trigger renderBothPanels so the IR Leaflet dispatcher
            // (Phase 2 of the canvas→Leaflet migration) runs and
            // builds per-frame overlays for the now-visible IR pane.
            // Track mode used to be canvas-only — Phase 2 + my
            // recent IR-fast-path-on-WV/Vis/Track extension means it
            // needs the same Leaflet plumbing as Diagnostics.
            if (irFrames && irFrames.length > 0) renderBothPanels();
        } else if (newMode === 'asymmetry') {
            if (asymPanel) asymPanel.style.display = '';
            // Asymmetry needs raw Tb for the WN-1 decomposition.
            if (typeof window._satEnsureRawTbLoaded === 'function') {
                window._satEnsureRawTbLoaded();
            }
            var frame = irFrames[animIndex];
            if (frame) computeAndRenderAsymmetry(frame);
        } else {
            // compare-wv or compare-vis
            if (comparePanel) comparePanel.style.display = '';
            if (compareOptions) compareOptions.style.display = '';
            var newBand = (newMode === 'compare-vis') ? 2 : 8;

            // Check for nighttime before fetching Vis
            if (newBand === 2 && currentStorm) {
                var sunEl = solarElevation(currentStorm.lat, currentStorm.lon, new Date());
                if (sunEl < -6) {
                    if (rightLabelEl) rightLabelEl.textContent = 'Visible (Nighttime \u2014 no data)';
                    rightFrames = [];
                    renderBothPanels();
                    // Update button active states before returning
                    var mbtns = document.querySelectorAll('.sat-mode-btn');
                    for (var mi2 = 0; mi2 < mbtns.length; mi2++) {
                        mbtns[mi2].classList.toggle('active', mbtns[mi2].getAttribute('data-mode') === newMode);
                    }
                    _ga('sat_view_mode', { mode: newMode });
                    return;
                }
            }

            // Only refetch if band changed or no frames loaded
            var bandChanged = newBand !== rightBand;
            rightBand = newBand;
            rightDataType = newBand <= 6 ? 'reflectance' : 'tb';
            if (rightLabelEl) rightLabelEl.textContent = newBand === 2
                ? 'Visible 0.64 µm'
                : 'Water Vapor 6.2 µm (Upper-Trop)';
            rightColormapName = newBand === 2 ? 'vis' : 'wv';
            var rcEl = document.getElementById('sat-right-cmap-select');
            if (rcEl) rcEl.value = rightColormapName;
            if (bandChanged || rightFrames.length === 0) {
                rightFrames = [];
                if (currentStormId) _refetchRightFrames(currentStormId);
            }
            renderBothPanels();
        }

        // Update button active states
        var modeBtns = document.querySelectorAll('.sat-mode-btn');
        for (var i = 0; i < modeBtns.length; i++) {
            modeBtns[i].classList.toggle('active', modeBtns[i].getAttribute('data-mode') === newMode);
        }

        _ga('sat_view_mode', { mode: newMode });
    }

    // ════════════════════════════════════════════════════════════════
    //  Phase 1: MW mode on Leaflet (dual-pane)
    //  Two synced L.map instances replace the canvas pair when MW is
    //  active. Left = IR (storm-cropped /ir-frame.jpg). Right = MW
    //  (selected pass PNG from manifest). Pan/zoom synchronized.
    //  Storm-center cross + interp ring on both maps. Pass-strip
    //  along the bottom; click to select. Product chips swap MW
    //  variable. Markers and overlays use Leaflet primitives — no
    //  custom canvas drawing.
    // ════════════════════════════════════════════════════════════════
    var _satMwLeafletIr = null;       // L.map (left)
    var _satMwLeafletMw = null;       // L.map (right)
    var _satMwIrOverlay = null;       // current IR L.imageOverlay
    var _satMwMwOverlay = null;       // current MW L.imageOverlay
    var _satMwIrMarkers = { fix: null, interp: null };
    var _satMwMwMarkers = { fix: null, interp: null };
    var _satMwSelectedOrbit = null;
    var _satMwOrbits = [];
    var _satMwProduct = '89pct';
    var _satMwIrMetaCache = { atcfId: null, meta: null };
    var _satMwSyncing = false;
    var _RT_MW_HALF_DEG_FALLBACK = 6;
    var _RT_MW_LOOKBACK_H = 24;
    var _RT_MW_IR_RADIUS = 10;

    function _satMwHalfDeg() {
        return (typeof window._rtMwHalfDeg === 'function')
            ? window._rtMwHalfDeg() : _RT_MW_HALF_DEG_FALLBACK;
    }

    // Common Leaflet map options shared by both panes — flat, neutral
    // basemap (Carto Voyager) so storm structure is the visual focus.
    var _SAT_LEAFLET_OPTS = {
        zoomControl: true,
        attributionControl: false,
        preferCanvas: false,
        worldCopyJump: true,
        zoomSnap: 0.25,
        zoomDelta: 0.5,
    };
    var _SAT_LEAFLET_BASE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png';
    // Coastlines + admin borders rendered ABOVE the imagery overlay
    // so the user can locate storm structure relative to land.
    //   Carto voyager_only_labels: thin lines + labels, but the
    //   lines were too subtle to read through bright IR imagery.
    //   Esri Reference/World_Boundaries_and_Places: solid white
    //   coastlines + country borders, much more visible. The labels
    //   are a side-effect; for a TC viewer the coastline visibility
    //   is the priority.
    // Dropped into a custom pane at z-index 450 so it sits above the
    // IR/WV/MW imageOverlays (overlayPane=400) but below storm
    // markers + graticule labels (markerPane=600).
    var _SAT_LEAFLET_COAST_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
    var _satIrSyncWired = false;

    function _satAddCoastlines(map) {
        if (!map || map._satCoastlinesAdded) return;
        var pane = map.createPane('sat-coastlines');
        pane.style.zIndex = 450;
        pane.style.pointerEvents = 'none';
        L.tileLayer(_SAT_LEAFLET_COAST_URL, {
            maxZoom: 12,
            pane: 'sat-coastlines',
            opacity: 1.0,
            attribution: 'Boundaries © Esri',
        }).addTo(map);
        map._satCoastlinesAdded = true;
    }

    // Lazy-init for the LEFT (IR) Leaflet map. Shared between MW mode
    // (Phase 1) and the default Diagnostics IR animation (Phase 2)
    // because both display the same data on the same container.
    function _satEnsureIrMap() {
        if (_satMwLeafletIr) return;
        var irDiv = document.getElementById('sat-leaflet-ir');
        if (!irDiv) return;
        _satMwLeafletIr = L.map(irDiv, _SAT_LEAFLET_OPTS).setView([0, 0], 5);
        L.tileLayer(_SAT_LEAFLET_BASE_URL, { maxZoom: 12, opacity: 0.55 })
            .addTo(_satMwLeafletIr);
        // Phase 6: per-pixel Tb hover tooltip.
        _satAttachLeafletHover(_satMwLeafletIr, function () { return irFrames; }, 'IR');
        // Lat/lon graticule on by default — useful for storm-scale
        // positioning context (eye position vs nearest land, RMW
        // relative to specific latitudes, etc).
        _satAddGraticule(_satMwLeafletIr);
        // Coastlines + admin lines + place labels above the imagery.
        _satAddCoastlines(_satMwLeafletIr);
    }

    // Lazy-init for the RIGHT (MW) Leaflet map. Only used in MW mode.
    function _satEnsureMwMap() {
        if (_satMwLeafletMw) return;
        var mwDiv = document.getElementById('sat-leaflet-mw');
        if (!mwDiv) return;
        _satMwLeafletMw = L.map(mwDiv, _SAT_LEAFLET_OPTS).setView([0, 0], 5);
        L.tileLayer(_SAT_LEAFLET_BASE_URL, { maxZoom: 12, opacity: 0.55 })
            .addTo(_satMwLeafletMw);
        // MW pane doesn't have client-side Tb arrays (the brightness
        // values live in the server-rendered PNG), so we just show a
        // lat/lon readout on hover — still useful for locating
        // structure relative to the storm center.
        _satAttachLeafletHover(_satMwLeafletMw, function () { return null; }, 'MW');
        _satAddGraticule(_satMwLeafletMw);
        _satAddCoastlines(_satMwLeafletMw);
    }

    // Global toggle: when true, pan/zoom on any Leaflet pane mirrors
    // to the others. When false, each pane navigates independently.
    // User can flip via the chain-link control button on the map.
    var _satMapSyncEnabled = true;

    function _satMwInitMaps() {
        _satEnsureIrMap();
        _satEnsureMwMap();
        if (_satIrSyncWired || !_satMwLeafletIr || !_satMwLeafletMw) return;
        function _wireSync(src, dst) {
            src.on('moveend zoomend', function () {
                if (!_satMapSyncEnabled) return;
                if (_satMwSyncing) return;
                _satMwSyncing = true;
                dst.setView(src.getCenter(), src.getZoom(), { animate: false });
                _satMwSyncing = false;
            });
        }
        _wireSync(_satMwLeafletIr, _satMwLeafletMw);
        _wireSync(_satMwLeafletMw, _satMwLeafletIr);
        _satIrSyncWired = true;
        _satAddMapControls(_satMwLeafletIr);
        _satAddMapControls(_satMwLeafletMw);
        _satAddMapLegend(_satMwLeafletIr);
        _satAddMapLegend(_satMwLeafletMw);
    }

    // Recenter every active Leaflet map on the current storm, zoom 6.
    // Temporarily disables sync so each setView completes without
    // pingpong.
    function _satRecenterAllOnStorm() {
        if (!currentStorm) return;
        var c = [currentStorm.lat, currentStorm.lon];
        var z = 6;
        var prev = _satMapSyncEnabled;
        _satMapSyncEnabled = false;
        try {
            if (_satMwLeafletIr) {
                _satMwLeafletIr.invalidateSize(false);
                _satMwLeafletIr.setView(c, z, { animate: false });
            }
            if (_satMwLeafletMw) {
                _satMwLeafletMw.invalidateSize(false);
                _satMwLeafletMw.setView(c, z, { animate: false });
            }
            if (_satRightLeafletMap) {
                _satRightLeafletMap.invalidateSize(false);
                _satRightLeafletMap.setView(c, z, { animate: false });
            }
        } finally {
            _satMapSyncEnabled = prev;
        }
    }

    // Adaptive lat/lon graticule overlay for a Leaflet map. Lines +
    // edge labels rebuild on moveend/zoomend with spacing that scales
    // to zoom level so the grid is always readable without crowding.
    // On by default for every Storm Satellite Leaflet map — the user
    // can pan/zoom freely now (Leaflet UX), so positional reference
    // lines are useful for tying storm structure to coordinates.
    function _satGraticuleStep(z) {
        if (z >= 9) return 0.5;
        if (z >= 7) return 1;
        if (z >= 5) return 2;
        if (z >= 3) return 5;
        return 10;
    }
    function _satFmtLat(v) {
        if (Math.abs(v) < 0.05) return '0°';
        return Math.abs(v).toFixed(v >= 1 ? 0 : 1)
               + (v >= 0 ? '°N' : '°S');
    }
    function _satFmtLon(v) {
        var x = v;
        while (x > 180)  x -= 360;
        while (x < -180) x += 360;
        if (Math.abs(x) < 0.05) return '0°';
        if (Math.abs(Math.abs(x) - 180) < 0.05) return '180°';
        return Math.abs(x).toFixed(Math.abs(x) >= 1 ? 0 : 1)
               + (x >= 0 ? '°E' : '°W');
    }
    function _satAddGraticule(map) {
        if (!map || map._satGraticule) return;
        var layer = L.layerGroup().addTo(map);
        map._satGraticule = layer;
        function rebuild() {
            layer.clearLayers();
            var step = _satGraticuleStep(map.getZoom());
            var b = map.getBounds();
            var sLat = Math.max(-85, Math.floor(b.getSouth() / step) * step);
            var nLat = Math.min( 85, Math.ceil(b.getNorth() / step) * step);
            var wLon = Math.floor(b.getWest() / step) * step;
            var eLon = Math.ceil(b.getEast() / step) * step;
            var lineOpts = {
                color: '#ffffff', weight: 0.5, opacity: 0.45,
                dashArray: '3 5', interactive: false
            };
            // Parallels.
            for (var lat = sLat; lat <= nLat + 1e-6; lat += step) {
                L.polyline([[lat, wLon], [lat, eLon]], lineOpts)
                    .addTo(layer);
                var labelLng = b.getWest()
                    + (b.getEast() - b.getWest()) * 0.02;
                L.marker([lat, labelLng], {
                    icon: L.divIcon({
                        className: 'sat-graticule-label',
                        html: _satFmtLat(lat),
                        iconSize: [40, 14], iconAnchor: [0, 7]
                    }),
                    interactive: false, keyboard: false
                }).addTo(layer);
            }
            // Meridians.
            for (var lon = wLon; lon <= eLon + 1e-6; lon += step) {
                L.polyline([[sLat, lon], [nLat, lon]], lineOpts)
                    .addTo(layer);
                var labelLat = b.getSouth()
                    + (b.getNorth() - b.getSouth()) * 0.02;
                L.marker([labelLat, lon], {
                    icon: L.divIcon({
                        className: 'sat-graticule-label',
                        html: _satFmtLon(lon),
                        iconSize: [50, 14], iconAnchor: [25, 14]
                    }),
                    interactive: false, keyboard: false
                }).addTo(layer);
            }
        }
        rebuild();
        map.on('moveend zoomend', rebuild);
    }

    // ════════════════════════════════════════════════════════════════
    //  Phase 6: per-pixel Tb hover tooltip on Leaflet panes
    //  Looks up the active frame's raw Tb array at the cursor's
    //  lat/lon and reports the brightness temperature (or just the
    //  lat/lon when no Tb data is available — e.g., MW pane). Reuses
    //  the existing #sat-tooltip div so the tooltip styling matches
    //  the canvas-mode hover from the pre-Leaflet era.
    // ════════════════════════════════════════════════════════════════
    // Touch-device detection — used to short-circuit hover-driven
    // work on phones/tablets, where:
    //   • mousemove rarely fires (touch only emits it on tap),
    //   • iOS Safari's ~250-384 MB tab limit makes the lazy raw-Tb
    //     backfill (~2-4 MB JSON per storm) a real factor in OOM
    //     crashes during heavy IR+WV animation.
    // `pointer:coarse` + `hover:none` reliably identify touch-only UAs
    // without relying on userAgent string sniffing.
    function _satIsTouchDevice() {
        if (typeof window.matchMedia !== 'function') return false;
        return window.matchMedia('(pointer: coarse)').matches
            && window.matchMedia('(hover: none)').matches;
    }

    // Narrow-viewport detection. 640 px breakpoint (was 768) — keeps
    // phones (≤640) in single-pane mode while letting tablets
    // (iPad portrait = 768 px, larger Androids) get the full
    // dual-pane WV/Vis compare UX. Bundle architecture made the
    // doubled-image memory cost minor (one ~1.5 MB binary instead
    // of ~13 separate small requests) so the original memory argument
    // for hiding compare modes no longer applies on tablets; only
    // readability (~5-6" phone screens are genuinely too cramped for
    // side-by-side) drives the gate now.
    //
    // Re-evaluated on each call rather than cached — covers
    // orientation changes without a resize listener.
    function _satIsMobileLayout() {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(max-width: 640px)').matches;
    }

    function _satAttachLeafletHover(map, framesProvider, label) {
        if (!map || map._satHoverAttached) return;
        // Skip hover entirely on touch devices — mousemove is a
        // non-event on touch, and attaching the handler still wires
        // up the lazy raw-Tb trigger that wastes memory on mobile.
        if (_satIsTouchDevice()) {
            map._satHoverAttached = true;   // mark so we don't retry
            return;
        }
        map._satHoverAttached = true;
        var tooltip = document.getElementById('sat-tooltip');
        if (!tooltip) return;
        map.on('mousemove', function (e) {
            // First mousemove triggers lazy raw-Tb load if we don't
            // have it yet. Without this, the tooltip shows lat/lon
            // only until the user notices and explicitly waits.
            if (typeof window._satEnsureRawTbLoaded === 'function') {
                window._satEnsureRawTbLoaded();
            }
            var lat = e.latlng.lat, lng = e.latlng.lng;
            // Normalize lng to [-180, 180] for the tooltip readout.
            var lngNorm = lng;
            while (lngNorm > 180)  lngNorm -= 360;
            while (lngNorm < -180) lngNorm += 360;
            var posText = lat.toFixed(2) + (lat >= 0 ? '°N' : '°S').replace('-', '')
                + '  ' + Math.abs(lngNorm).toFixed(2)
                + (lngNorm >= 0 ? '°E' : '°W');

            var frames = typeof framesProvider === 'function' ? framesProvider() : null;
            var frame = frames && frames[animIndex];
            var valueText = '';
            if (frame && frame.tb_data && frame.bounds) {
                var b = frame.bounds;
                var south = b[0][0], west = b[0][1];
                var north = b[1][0], east = b[1][1];
                // Handle dateline-wrapping bounds (west > east).
                var w = west, e2 = east, lngForLookup = lng;
                if (west > east) {
                    e2 = east + 360;
                    if (lngForLookup < west) lngForLookup += 360;
                }
                if (lat >= south && lat <= north
                        && lngForLookup >= w && lngForLookup <= e2) {
                    var r = Math.floor((north - lat) / (north - south)
                                       * (frame.rows - 1));
                    var c = Math.floor((lngForLookup - w) / (e2 - w)
                                       * (frame.cols - 1));
                    if (r >= 0 && r < frame.rows
                            && c >= 0 && c < frame.cols) {
                        var rawVal = frame.tb_data[r * frame.cols + c];
                        if (rawVal !== 0) {
                            var vmin = frame.tb_vmin || 160;
                            var vmax = frame.tb_vmax || 330;
                            var tb = decodeTbValue(rawVal, vmin, vmax);
                            var unit = (frame.data_type === 'reflectance')
                                ? '%' : ' K';
                            valueText = tb.toFixed(1) + unit;
                        }
                    }
                }
            }
            tooltip.style.display = 'block';
            // Fixed-position the tooltip so client (viewport) coords
            // line up with it directly. Default sat-tooltip CSS is
            // position:absolute, which would offset relative to the
            // parent positioned ancestor — pageX/Y doesn't match that.
            tooltip.style.position = 'fixed';
            tooltip.style.left = (e.originalEvent.clientX + 14) + 'px';
            tooltip.style.top  = (e.originalEvent.clientY + 14) + 'px';
            tooltip.innerHTML = (valueText
                ? '<strong>' + label + ':</strong> ' + valueText
                  + '<br><span style="opacity:0.7;">' + posText + '</span>'
                : '<span style="opacity:0.85;">' + posText + '</span>');
        });
        map.on('mouseout', function () {
            tooltip.style.display = 'none';
        });
    }

    // Add a small floating control with two buttons to a Leaflet map:
    //   ⌖ Recenter on storm
    //   🔗 Toggle pane sync (active = linked)
    // Buttons sit just below Leaflet's built-in zoom control.
    function _satAddMapControls(map) {
        if (!map || map._satControlsAdded) return;
        var Ctrl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: function () {
                var bar = L.DomUtil.create('div', 'leaflet-bar sat-map-controls');
                var recenter = L.DomUtil.create('a', 'sat-map-ctrl-btn', bar);
                recenter.href = '#';
                recenter.title = 'Recenter every pane on the storm';
                recenter.innerHTML = '⌖';
                L.DomEvent.on(recenter, 'click', function (e) {
                    L.DomEvent.preventDefault(e); L.DomEvent.stop(e);
                    _satRecenterAllOnStorm();
                });
                var link = L.DomUtil.create('a', 'sat-map-ctrl-btn', bar);
                link.href = '#';
                link.title = 'Toggle pane sync — when off, each map pans independently';
                link.innerHTML = '🔗';
                if (_satMapSyncEnabled) link.classList.add('active');
                L.DomEvent.on(link, 'click', function (e) {
                    L.DomEvent.preventDefault(e); L.DomEvent.stop(e);
                    _satMapSyncEnabled = !_satMapSyncEnabled;
                    document.querySelectorAll('.sat-map-ctrl-btn').forEach(function (b) {
                        if (b.title.indexOf('sync') >= 0) {
                            b.classList.toggle('active', _satMapSyncEnabled);
                        }
                    });
                });
                L.DomEvent.disableClickPropagation(bar);
                return bar;
            }
        });
        new Ctrl().addTo(map);
        map._satControlsAdded = true;
    }

    // Bottom-left floating legend explaining the on-map markers.
    // Rows are toggled visible/hidden as markers are added/removed so
    // the legend only advertises what's actually drawn. The legend
    // hides itself entirely when none of its rows are visible.
    function _satAddMapLegend(map) {
        if (!map || map._satLegendAdded) return;
        var Ctrl = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                var box = L.DomUtil.create('div', 'sat-map-legend');
                box.innerHTML = ''
                    + '<div class="sat-legend-row" data-key="best-track" style="display:none;">'
                    +   '<span class="sat-legend-swatch sat-legend-cross"></span>'
                    +   '<span class="sat-legend-label">Best-track (latest fix)</span>'
                    + '</div>'
                    + '<div class="sat-legend-row" data-key="interp" style="display:none;">'
                    +   '<span class="sat-legend-swatch sat-legend-ring"></span>'
                    +   '<span class="sat-legend-label">Position at MW pass time (interp.)</span>'
                    + '</div>'
                    + '<div class="sat-legend-row" data-key="centerfix" style="display:none;">'
                    +   '<span class="sat-legend-swatch sat-legend-cyancross"></span>'
                    +   '<span class="sat-legend-label">IR center fix</span>'
                    + '</div>';
                box.style.display = 'none';
                L.DomEvent.disableClickPropagation(box);
                map._satLegendEl = box;
                return box;
            }
        });
        new Ctrl().addTo(map);
        map._satLegendAdded = true;
    }
    function _satLegendSetRow(map, key, visible) {
        if (!map || !map._satLegendEl) return;
        var row = map._satLegendEl.querySelector('[data-key="' + key + '"]');
        if (!row) return;
        row.style.display = visible ? '' : 'none';
        // Hide the whole legend if no rows are visible — keeps the
        // overlay out of the way when there's nothing to label.
        var anyVisible = false;
        var rows = map._satLegendEl.querySelectorAll('.sat-legend-row');
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].style.display !== 'none') { anyVisible = true; break; }
        }
        map._satLegendEl.style.display = anyVisible ? '' : 'none';
    }

    // Mobile MW path: reuse the storm-card's thumbnail-grid pattern
    // instead of the desktop dual-pane Leaflet experience. Tapping a
    // thumbnail opens the existing IR↔MW compare modal (body-level,
    // already mobile-friendly). This gives us:
    //   • single-pane mobile UX (no cramped dual maps),
    //   • zero per-frame layer stacking (modal is canvas-based),
    //   • code reuse — _rtLoadStormMwPasses just needs a different
    //     DOM prefix to render into the sat-mw-mobile-* containers.
    function _satMwActivateMobile() {
        var storm = currentStorm;
        // Hide every desktop-MW DOM child so only the mobile section
        // shows. We restore them in _satMwDeactivate so the desktop
        // entry next time the user resizes / reloads stays correct.
        var hideList = [
            document.querySelector('#sat-mw-section .sat-mw-leaflet-header'),
            document.querySelector('#sat-mw-section .sat-mw-controls-row'),
            document.getElementById('sat-leaflet-mw'),
            document.getElementById('sat-mw-cb')
        ];
        for (var i = 0; i < hideList.length; i++) {
            if (hideList[i]) hideList[i].style.display = 'none';
        }
        // Hide the IR pane too — the modal will show IR side-by-side
        // when a pass is tapped, so showing the IR animation here is
        // redundant and competes for screen height.
        var irPane = document.getElementById('sat-panel-ir');
        if (irPane) irPane.style.display = 'none';
        var mobileSec = document.getElementById('sat-mw-mobile-section');
        if (mobileSec) mobileSec.style.display = '';
        if (!storm) return;
        // Trigger the same loader the storm-card uses — different
        // prefix routes the thumbnails into our mobile container.
        if (typeof window._rtLoadStormMwPasses === 'function') {
            window._rtLoadStormMwPasses(storm, 'sat-mw-mobile');
        }
    }
    // Restore the desktop MW DOM children we hid on mobile entry,
    // and re-show the IR pane. Safe to call on any platform — it's a
    // no-op when none of the elements were hidden.
    function _satMwRestoreDesktopMwDom() {
        var showList = [
            document.querySelector('#sat-mw-section .sat-mw-leaflet-header'),
            document.querySelector('#sat-mw-section .sat-mw-controls-row'),
            document.getElementById('sat-leaflet-mw'),
            document.getElementById('sat-mw-cb')
        ];
        for (var i = 0; i < showList.length; i++) {
            if (showList[i]) showList[i].style.display = '';
        }
        var irPane = document.getElementById('sat-panel-ir');
        if (irPane) irPane.style.display = '';
        var mobileSec = document.getElementById('sat-mw-mobile-section');
        if (mobileSec) mobileSec.style.display = 'none';
    }

    function _satMwActivate() {
        // Mobile fast-path: skip the heavy Leaflet init entirely.
        // Tapping a thumbnail opens the existing compare modal, which
        // is canvas-based and already phone-friendly. This avoids:
        //   • OOM from two synced Leaflet maps + tile caches,
        //   • the cramped sub-180px-wide dual-pane on phones,
        //   • the broken mode-toggle navigation the user reported.
        if (_satIsMobileLayout()) {
            _satMwActivateMobile();
            return;
        }
        // Force the LEFT pane to Leaflet mode for the MW comparison
        // view. Without this, Phase 2's renderBothPanels → visibility
        // toggle could leave the canvas showing instead.
        var canvasWrap = document.getElementById('sat-panel-ir-canvas-wrap');
        var leafletDiv = document.getElementById('sat-leaflet-ir');
        var axesY = document.getElementById('sat-axes-y-ir');
        var axesX = document.getElementById('sat-axes-x-ir');
        if (canvasWrap) canvasWrap.style.display = 'none';
        if (leafletDiv) leafletDiv.style.display = '';
        if (axesY) axesY.style.display = 'none';
        if (axesX) axesX.style.display = 'none';
        // MW mode also uses Leaflet — hide the canvas-era zoom presets.
        document.body.classList.add('sat-leaflet-active');
        _satMwInitMaps();
        if (!currentStorm || currentStorm.lat == null || currentStorm.lon == null) {
            _satMwSetStatus('no active storm');
            return;
        }
        // Hide any Phase 2 per-frame IR overlays — in MW mode the
        // IR map is owned by Phase 1's single matched-time overlay.
        // Two stacks of L.imageOverlay on the same map would compete.
        for (var i = 0; i < _satIrFrameLayers.length; i++) {
            if (_satIrFrameLayers[i].setOpacity) _satIrFrameLayers[i].setOpacity(0);
        }
        // Use setView(center, zoom) instead of fitBounds — fitBounds
        // depends on the container being correctly measured at the
        // call moment, which is fragile across the display:none →
        // display:'' transition + flex layout settling. setView is
        // deterministic: storm always at geographic center, fixed
        // zoom regardless of container width (more of the surrounding
        // area visible in wider panes, less in narrower).
        //
        // Zoom 6 ≈ 14° visible at the equator in a 640-px-wide
        // container — close to the ±6° MW storm-crop convention,
        // but allows the IR overlay (±10°) to extend just past the
        // visible edges for nice framing.
        var _SAT_MW_ZOOM = 6;
        function _doFit() {
            if (_satMwLeafletIr) {
                _satMwLeafletIr.invalidateSize(false);
                _satMwLeafletIr.setView([currentStorm.lat, currentStorm.lon],
                                        _SAT_MW_ZOOM, { animate: false });
            }
            if (_satMwLeafletMw) {
                _satMwLeafletMw.invalidateSize(false);
                _satMwLeafletMw.setView([currentStorm.lat, currentStorm.lon],
                                        _SAT_MW_ZOOM, { animate: false });
            }
        }
        // First pass: rAF lets the just-shown containers measure.
        // Second pass at 200ms: belt-and-suspenders in case the layout
        // settles after the first paint (some browsers).
        requestAnimationFrame(function () {
            _doFit();
            _satMwUpdateMarkers();
            _satMwLoadPasses();
            // Render the colorbar immediately so the user sees the
            // temperature scale on MW mode entry, before any pass
            // selection. Re-fires inside _satMwRenderMwOverlay when
            // product changes.
            if (typeof _satMwRenderColorbar === 'function') {
                _satMwRenderColorbar();
            }
            setTimeout(_doFit, 200);
        });
    }

    function _satMwDeactivate() {
        // The next renderBothPanels (called by the diagnostics /
        // track / asym branch in setViewMode) will trigger Phase 2's
        // _satIrSyncLeaflet which picks canvas vs Leaflet based on
        // the new mode + colormap. So we DON'T preemptively show the
        // canvas here — that decision belongs to Phase 2. We just
        // ensure any single MW IR overlay is removed so it doesn't
        // sit underneath Phase 2's per-frame layers.
        if (_satMwIrOverlay && _satMwLeafletIr) {
            _satMwLeafletIr.removeLayer(_satMwIrOverlay);
            _satMwIrOverlay = null;
        }
        // Mobile cleanup: restore the desktop MW DOM children we
        // hid in _satMwActivateMobile, and re-show the IR pane.
        // Safe to call on desktop — no-op when nothing was hidden.
        _satMwRestoreDesktopMwDom();
    }

    function _satMwSetStatus(text) {
        var el = document.getElementById('sat-mw-status');
        if (el) el.textContent = text || '';
    }
    function _satMwSetPassTime(text) {
        var el = document.getElementById('sat-mw-pass-time');
        if (el) el.textContent = text || '—';
    }
    function _satMwSetProductLabel(text) {
        var el = document.getElementById('sat-mw-product-label');
        if (el) el.textContent = text || 'Microwave';
    }

    // Fetch the manifest, filter to last-24h passes covering the
    // current storm, group by orbit_id (preserving all products per
    // orbit), sort newest-first, then render the bottom strip.
    function _satMwLoadPasses() {
        var storm = currentStorm;
        if (!storm) return;
        _satMwSetStatus('loading…');
        // Prefer the per-storm endpoint (server-side filtered, ~30-80
        // KB) but fall back to the global manifest if it's unavailable.
        var fetcher = (typeof window._rtMwFetchStormPasses === 'function')
            ? function () { return window._rtMwFetchStormPasses(storm); }
            : window._rtMwFetchManifest;
        if (!fetcher) return;
        fetcher()
            .then(function (m) {
                if (!currentStorm || currentStorm.atcf_id !== storm.atcf_id) return;
                var entries = (m && m.entries) || [];
                var nowMs = Date.now();
                var winMs = (typeof window._rtMwWindowMs === 'function')
                    ? window._rtMwWindowMs() : 24 * 60 * 60 * 1000;
                var orbitMap = {};
                for (var i = 0; i < entries.length; i++) {
                    var e = entries[i];
                    var t = Date.parse(e.scan_start);
                    if (!isFinite(t) || (nowMs - t) > winMs) continue;
                    if (!window._rtMwBoundsContains(e.bounds, storm.lat, storm.lon)) continue;
                    var oid = e.orbit_id;
                    if (!orbitMap[oid]) {
                        orbitMap[oid] = {
                            orbit_id: oid, sensor: e.sensor, platform: e.platform,
                            scan_start: e.scan_start, scan_start_ms: t,
                            bounds: e.bounds, products: {}
                        };
                    }
                    orbitMap[oid].products[e.product] = {
                        png_url: e.png_url, geojson_url: e.geojson_url
                    };
                }
                var orbits = Object.keys(orbitMap).map(function (k) { return orbitMap[k]; });
                orbits.sort(function (a, b) { return b.scan_start_ms - a.scan_start_ms; });
                _satMwOrbits = orbits;
                _satMwRenderStrip();
                if (orbits.length) {
                    _satMwSelectPass(orbits[0]);   // auto-select latest
                    _satMwSetStatus(orbits.length + ' pass'
                        + (orbits.length === 1 ? '' : 'es'));
                } else {
                    _satMwSetStatus('no passes covered storm');
                    if (_satMwMwOverlay) {
                        _satMwLeafletMw.removeLayer(_satMwMwOverlay);
                        _satMwMwOverlay = null;
                    }
                }
            })
            .catch(function (err) {
                console.warn('[Sat MW] manifest fetch failed', err);
                _satMwSetStatus('unavailable');
            });
    }

    function _satMwRenderStrip() {
        // Renamed-but-kept-as-stub: now populates the pass-dropdown
        // selector. The horizontal strip was removed because it stole
        // ~80 px of vertical space from the MW pane, making the right
        // map visibly shorter than the left IR map.
        var sel = document.getElementById('sat-mw-pass-select');
        if (!sel) return;
        sel.innerHTML = '';
        if (!_satMwOrbits.length) {
            var opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '— no passes covered storm —';
            sel.appendChild(opt);
            sel.disabled = true;
            return;
        }
        sel.disabled = false;
        var nowMs = Date.now();
        for (var i = 0; i < _satMwOrbits.length; i++) {
            var o = _satMwOrbits[i];
            var pr = o.products[_satMwProduct];
            if (!pr) continue;
            var ageMin = (nowMs - o.scan_start_ms) / 60000;
            var ageStr = _satMwFmtAgo(ageMin);
            var utc = o.scan_start.replace('T', ' ').slice(0, 16) + 'Z';
            var opt2 = document.createElement('option');
            opt2.value = o.orbit_id;
            opt2.textContent = o.sensor + ' · ' + (o.platform || '?')
                             + ' — ' + utc + ' (' + ageStr + ')';
            if (_satMwSelectedOrbit && _satMwSelectedOrbit.orbit_id === o.orbit_id) {
                opt2.selected = true;
            }
            sel.appendChild(opt2);
        }
    }
    // Wire the dropdown's change handler once at module init.
    (function _satBindMwPassSelect() {
        var attach = function () {
            var sel = document.getElementById('sat-mw-pass-select');
            if (!sel || sel._satBound) return;
            sel._satBound = true;
            sel.addEventListener('change', function () {
                var oid = sel.value;
                if (!oid) return;
                var match = _satMwOrbits.find(function (o) {
                    return o.orbit_id === oid;
                });
                if (match) _satMwSelectPass(match);
            });
        };
        // Attach now if the element already exists, else on DOM ready.
        if (document.getElementById('sat-mw-pass-select')) attach();
        else document.addEventListener('DOMContentLoaded', attach, { once: true });
    })();

    function _satMwFmtAgo(min) {
        if (min < 1)  return 'just now';
        if (min < 60) return Math.round(min) + ' min ago';
        var h = min / 60;
        if (h < 24) return h.toFixed(1) + ' h ago';
        return (h / 24).toFixed(1) + ' d ago';
    }

    function _satMwSelectPass(orbit) {
        if (!orbit) return;
        _satMwSelectedOrbit = orbit;
        var storm = currentStorm;
        _satMwSetPassTime(orbit.scan_start.replace('T', ' ').slice(0, 16) + 'Z');
        // Reflect the selection back into the dropdown.
        var sel = document.getElementById('sat-mw-pass-select');
        if (sel) sel.value = orbit.orbit_id;
        _satMwRenderMwOverlay();
        _satMwRenderIrAtMatchedTime(orbit.scan_start_ms, storm);
        _satMwUpdateMarkersForOrbit(orbit, storm);
    }

    function _satMwRenderMwOverlay() {
        var orbit = _satMwSelectedOrbit;
        if (!orbit || !_satMwLeafletMw) return;
        var pr = orbit.products[_satMwProduct];
        _satMwSetProductLabel(orbit.sensor + ' · ' + (orbit.platform || '?') + ' · '
                              + _satMwProductLabel(_satMwProduct));
        _satMwRenderColorbar();
        if (_satMwMwOverlay) {
            _satMwLeafletMw.removeLayer(_satMwMwOverlay);
            _satMwMwOverlay = null;
        }
        if (!pr || !pr.png_url) return;
        // bounds = [[south, west], [north, east]] — Leaflet-native.
        _satMwMwOverlay = L.imageOverlay(pr.png_url, orbit.bounds, {
            opacity: 0.92,
            interactive: false,
            crossOrigin: 'anonymous',
        }).addTo(_satMwLeafletMw);
    }

    function _satMwProductLabel(p) {
        return ({ '89pct': '89 PCT', '37color': '37 color',
                  '89v': '89V', '89h': '89H',
                  '37v': '37V', '37h': '37H' })[p] || p;
    }

    // Approximate colormaps for each MW product. Server-side rendering
    // bakes these into the PNGs; we replicate the lookup table here
    // (loosely) just to populate the floating colorbar.
    var _SAT_MW_COLORBARS = {
        '89pct': {
            min: 180, max: 290, unit: 'K',
            stops: [
                [180, 'rgb(20, 0, 80)'],
                [220, 'rgb(0, 120, 200)'],
                [240, 'rgb(200, 200, 200)'],
                [260, 'rgb(255, 200, 50)'],
                [275, 'rgb(220, 50, 30)'],
                [290, 'rgb(50, 0, 30)'],
            ],
        },
        '37color': {
            min: null, max: null, unit: '',
            label: '37 color (R=PCT37, G=V37, B=H37)',
            stops: null,
        },
        '89v':  { min: 180, max: 300, unit: 'K (V)', stops: _satMwGrayStops() },
        '89h':  { min: 180, max: 300, unit: 'K (H)', stops: _satMwGrayStops() },
        '37v':  { min: 180, max: 300, unit: 'K (V)', stops: _satMwGrayStops() },
        '37h':  { min: 180, max: 300, unit: 'K (H)', stops: _satMwGrayStops() },
    };
    function _satMwGrayStops() {
        return [
            [180, 'rgb(10, 10, 30)'],
            [220, 'rgb(80, 80, 100)'],
            [260, 'rgb(180, 180, 200)'],
            [300, 'rgb(255, 255, 255)'],
        ];
    }

    function _satMwRenderColorbar() {
        var cb = _SAT_MW_COLORBARS[_satMwProduct];
        var canvas = document.getElementById('sat-mw-cb-canvas');
        var minEl = document.getElementById('sat-mw-cb-min');
        var maxEl = document.getElementById('sat-mw-cb-max');
        if (!canvas || !minEl || !maxEl) return;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!cb || !cb.stops) {
            // 37color is RGB — no traditional colorbar makes sense.
            minEl.textContent = '';
            maxEl.textContent = (cb && cb.label) || '';
            return;
        }
        // Build a linear-gradient with the product's color stops.
        var grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
        var range = cb.max - cb.min;
        cb.stops.forEach(function (s) {
            grad.addColorStop((s[0] - cb.min) / range, s[1]);
        });
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        minEl.textContent = cb.min + '';
        maxEl.textContent = cb.max + ' ' + cb.unit;
    }

    // Fetch /ir-frames-meta (cached per storm), pick the frame index
    // closest to the MW scan_start, then drop /ir-frame.jpg as an
    // L.imageOverlay on the IR map. radius_deg=10 → 20° box centered
    // on storm; bounds derived from storm + radius_deg.
    //
    // FAST PATH: when the IR animation already loaded per-frame layers
    // (`_satIrFrameLayers` parallel to `irFrames`), and the closest in-
    // memory frame is within a small tolerance of the MW pass time,
    // reuse THAT layer's already-decoded image instead of fetching a
    // fresh /ir-frame.jpg with different query params. Saves a network
    // round-trip + image decode every time the user clicks MW after
    // viewing IR. Falls through to the legacy fetch path when no close
    // match exists (e.g., MW pass older than DEFAULT_LOOKBACK_HOURS).
    function _satMwRenderIrAtMatchedTime(mwMs, storm) {
        if (!storm || !_satMwLeafletIr) return;

        // ── Fast path: reuse an already-loaded per-frame layer ────────
        if (irFrames && irFrames.length
            && _satIrFrameLayers.length === irFrames.length
            && _satIrFrameStormId === storm.atcf_id) {
            var bestIdx = -1, bestD = Infinity, bestMs = null;
            for (var i = 0; i < irFrames.length; i++) {
                var f = irFrames[i];
                if (!f || !f.datetime_utc) continue;
                var t = Date.parse(f.datetime_utc);
                if (!isFinite(t)) continue;
                var d = Math.abs(t - mwMs);
                if (d < bestD) { bestD = d; bestIdx = i; bestMs = t; }
            }
            // 30 minutes = one frame at the default interval. Anything
            // closer is "the right frame". Beyond that we'd be showing
            // imagery that doesn't actually match the pass time, so
            // defer to the network path which can reach further back.
            var TOL_MS = 30 * 60 * 1000;
            if (bestIdx >= 0 && bestD <= TOL_MS) {
                // Tear down any legacy single-overlay from a previous
                // entry to MW mode — we're going to use the per-frame
                // stack instead, so two overlays on the same map
                // would stack opacity.
                if (_satMwIrOverlay) {
                    _satMwLeafletIr.removeLayer(_satMwIrOverlay);
                    _satMwIrOverlay = null;
                }
                // Phase 4: honor the active colormap. If the user has
                // picked a non-default cmap, the layer URL may need a
                // bake — _satIrSyncFrameUrl is a no-op if already at
                // the target cmap, so this is cheap.
                if (typeof selectedColormap === 'string') {
                    _satIrSyncFrameUrl(bestIdx, selectedColormap);
                }
                for (var j = 0; j < _satIrFrameLayers.length; j++) {
                    _satIrFrameLayers[j].setOpacity(j === bestIdx ? 0.92 : 0);
                }
                // Update the IR pane label so the user sees the matched
                // IR frame time alongside the MW pass time.
                var lblFast = document.getElementById('sat-panel-ir-label');
                if (lblFast) {
                    var deltaMinFast = Math.round((bestMs - mwMs) / 60000);
                    var signFast = deltaMinFast >= 0 ? '+' : '';
                    lblFast.textContent = 'IR · '
                        + irFrames[bestIdx].datetime_utc.replace('T', ' ').slice(0, 16)
                        + 'Z (' + signFast + deltaMinFast + ' min vs MW)';
                }
                return;
            }
        }

        // ── Legacy path: pass is outside the in-memory IR window ──────
        var url = API_BASE
            + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
            + '/ir-frames-meta?lookback_hours=' + _RT_MW_LOOKBACK_H
            + '&radius_deg=' + _RT_MW_IR_RADIUS
            + '&interval_min=' + FRAME_INTERVAL_MIN;
        var pickFrame = function (meta) {
            if (!meta || !meta.frames || !meta.frames.length) return null;
            var best = null, bestD = Infinity;
            for (var i = 0; i < meta.frames.length; i++) {
                var t = Date.parse(meta.frames[i].datetime_utc);
                if (!isFinite(t)) continue;
                var d = Math.abs(t - mwMs);
                if (d < bestD) { bestD = d; best = meta.frames[i]; }
            }
            return best;
        };
        var apply = function (meta) {
            var best = pickFrame(meta);
            if (!best) return;
            // Bounds = storm-centered 20° box. /ir-frame.jpg uses the
            // storm's CURRENT position as center (latest fix) — we
            // mirror that here so the overlay aligns with the JPG.
            var bounds = [
                [storm.lat - _RT_MW_IR_RADIUS, storm.lon - _RT_MW_IR_RADIUS],
                [storm.lat + _RT_MW_IR_RADIUS, storm.lon + _RT_MW_IR_RADIUS]
            ];
            var jpgUrl = API_BASE
                + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
                + '/ir-frame.jpg?frame_index=' + best.index
                + '&lookback_hours=' + _RT_MW_LOOKBACK_H
                + '&radius_deg=' + _RT_MW_IR_RADIUS
                + '&interval_min=' + FRAME_INTERVAL_MIN;
            if (_satMwIrOverlay) {
                _satMwLeafletIr.removeLayer(_satMwIrOverlay);
                _satMwIrOverlay = null;
            }
            _satMwIrOverlay = L.imageOverlay(jpgUrl, bounds, {
                opacity: 0.92,
                interactive: false,
                crossOrigin: 'anonymous',
            }).addTo(_satMwLeafletIr);
            // Update the IR pane label so the user sees the matched
            // IR frame time alongside the MW pass time.
            var lbl = document.getElementById('sat-panel-ir-label');
            if (lbl) {
                var deltaMin = Math.round((Date.parse(best.datetime_utc) - mwMs) / 60000);
                var sign = deltaMin >= 0 ? '+' : '';
                lbl.textContent = 'IR · ' + best.datetime_utc.replace('T', ' ').slice(0, 16)
                                  + 'Z (' + sign + deltaMin + ' min vs MW)';
            }
        };
        if (_satMwIrMetaCache.atcfId === storm.atcf_id && _satMwIrMetaCache.meta) {
            apply(_satMwIrMetaCache.meta);
            return;
        }
        fetch(url, { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (m) {
                _satMwIrMetaCache = { atcfId: storm.atcf_id, meta: m };
                apply(m);
            })
            .catch(function (err) { console.warn('[Sat MW] IR meta fetch failed', err); });
    }

    // Markers: yellow cross at latest best-track fix; orange ring at
    // interpolated position for the MW pass time. Both placed on
    // both maps so panning the synced pair never loses the markers.
    function _satMwUpdateMarkers() {
        var storm = currentStorm;
        if (!storm) return;
        if (!_satMwLeafletIr || !_satMwLeafletMw) return;
        var fixIcon = L.divIcon({
            className: 'sat-mw-marker sat-mw-marker-cross',
            html: '<span class="sat-mw-cross"></span>',
            iconSize: [22, 22], iconAnchor: [11, 11]
        });
        function _placeFix(map, holder) {
            if (holder.fix) map.removeLayer(holder.fix);
            holder.fix = L.marker([storm.lat, storm.lon], {
                icon: fixIcon, interactive: false, keyboard: false
            }).addTo(map);
        }
        _placeFix(_satMwLeafletIr, _satMwIrMarkers);
        _placeFix(_satMwLeafletMw, _satMwMwMarkers);
        // Surface the legend row that explains this marker on each pane.
        _satLegendSetRow(_satMwLeafletIr, 'best-track', true);
        _satLegendSetRow(_satMwLeafletMw, 'best-track', true);
    }
    function _satMwUpdateMarkersForOrbit(orbit, storm) {
        if (!orbit || !storm || !_satMwLeafletIr || !_satMwLeafletMw) return;
        if (typeof window._rtFetchStormTrack !== 'function') return;
        window._rtFetchStormTrack(storm)
            .then(function (history) {
                if (!_satMwSelectedOrbit || _satMwSelectedOrbit.orbit_id !== orbit.orbit_id) return;
                var interp = (typeof window._rtInterpTrack === 'function')
                    ? window._rtInterpTrack(history, orbit.scan_start_ms) : null;
                if (!interp) return;
                var ringIcon = L.divIcon({
                    className: 'sat-mw-marker sat-mw-marker-ring',
                    html: '<span class="sat-mw-ring"></span>',
                    iconSize: [18, 18], iconAnchor: [9, 9]
                });
                function _placeInterp(map, holder) {
                    if (holder.interp) map.removeLayer(holder.interp);
                    holder.interp = L.marker([interp.lat, interp.lon], {
                        icon: ringIcon, interactive: false, keyboard: false
                    }).addTo(map);
                }
                _placeInterp(_satMwLeafletIr, _satMwIrMarkers);
                _placeInterp(_satMwLeafletMw, _satMwMwMarkers);
                _satLegendSetRow(_satMwLeafletIr, 'interp', true);
                _satLegendSetRow(_satMwLeafletMw, 'interp', true);
            })
            .catch(function () { /* ignore — interp marker optional */ });
    }

    // Product chip binding for the sat-mw-products bar lives in
    // realtime_ir.js (document-level delegation). It calls
    // _rtRenderStormMwPasses on change, which is a no-op for the
    // Leaflet view since the panel IDs differ. We add a local
    // listener that intercepts clicks inside the sat-mw bar and
    // re-renders the Leaflet MW overlay instead.
    document.addEventListener('click', function (ev) {
        var bar = document.getElementById('sat-mw-products');
        if (!bar || !bar.contains(ev.target)) return;
        var btn = ev.target.closest('.rt-mw-storm-chip');
        if (!btn) return;
        var product = btn.getAttribute('data-product');
        if (!product || product === _satMwProduct) return;
        _satMwProduct = product;
        // Sync chip active states (the global document handler will
        // also fire but only updates chips, so this stays safe).
        var chips = bar.querySelectorAll('.rt-mw-storm-chip');
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.toggle('active',
                chips[i].getAttribute('data-product') === product);
        }
        if (viewMode === 'microwave') {
            _satMwRenderMwOverlay();
            _satMwRenderStrip();   // strip product labels stay current
        }
    });

    // ════════════════════════════════════════════════════════════════
    //  Phase 2: Leaflet IR animation (default mode + default colormap)
    //  Replaces the canvas IR animation when:
    //    1. View mode is "diagnostics" (other modes still on canvas
    //       because they need canvas-based asymmetry / WV-Vis / track),
    //    2. AND the user has the default 'claude-ir' colormap selected
    //       (custom colormaps require the LUT path and stay on canvas).
    //  Frames are pre-loaded as L.imageOverlay layers with opacity 0;
    //  showFrame just toggles opacity. Storm-center crosshair + active
    //  best-track marker render as L.marker. Zoom buttons (10°/5°/2°)
    //  setView the map.
    // ════════════════════════════════════════════════════════════════
    var _satIrLeafletActive = false;           // mirrors current dispatch
    var _satIrFrameLayers = [];                // per-frame L.imageOverlay
    var _satIrFrameStormId = null;             // storm the layers were built for
    var _satIrCenterFixMarker = null;          // L.marker for center fix
    var _SAT_IR_RADIUS_DEG = 10;               // ir-frame.jpg radius_deg

    // Whether to use the Leaflet IR display right now. Phase 4 lifted
    // the default-colormap restriction — custom colormaps now bake
    // raw Tb → offscreen canvas → blob URL → L.imageOverlay.setUrl,
    // so the Leaflet pane works for every colormap. Asymmetry is the
    // only mode that still uses the canvas painter (it needs the raw
    // Tb arrays to compute the WN-1 decomposition before rendering).
    function _satIrShouldUseLeaflet() {
        return (viewMode === 'diagnostics'
                || viewMode === 'compare-wv'
                || viewMode === 'compare-vis'
                || viewMode === 'track-map');
    }

    // Toggle canvas vs Leaflet visibility for the left IR pane.
    function _satIrApplyLeafletVisibility() {
        var canvasWrap = document.getElementById('sat-panel-ir-canvas-wrap');
        var leafletDiv = document.getElementById('sat-leaflet-ir');
        var axesY = document.getElementById('sat-axes-y-ir');
        var axesX = document.getElementById('sat-axes-x-ir');
        var colorbar = document.getElementById('sat-cb-ir');
        var useLeaflet = _satIrShouldUseLeaflet();
        if (useLeaflet) {
            if (canvasWrap) canvasWrap.style.display = 'none';
            if (leafletDiv) leafletDiv.style.display = '';
            // Lat/lon labels come from Leaflet's basemap + the new
            // graticule overlay, so hide the canvas-era DOM axes.
            if (axesY) axesY.style.display = 'none';
            if (axesX) axesX.style.display = 'none';
            // Keep the colorbar visible — CSS pins it as a floating
            // overlay at the bottom of the panel when body has the
            // sat-leaflet-active class, so the Leaflet pane retains
            // full height and the user gets brightness-temp context.
            if (colorbar) colorbar.style.display = '';
        } else {
            if (canvasWrap) canvasWrap.style.display = '';
            if (leafletDiv) leafletDiv.style.display = 'none';
            if (axesY) axesY.style.display = '';
            if (axesX) axesX.style.display = '';
            if (colorbar) colorbar.style.display = '';
        }
        // Tag <body> so CSS can hide the 10°/5°/2° zoom buttons when
        // Leaflet's native pan/zoom is active. They're a leftover from
        // the canvas-era preset-zoom UX and just clutter the slider.
        document.body.classList.toggle('sat-leaflet-active', useLeaflet);
        _satIrLeafletActive = useLeaflet;
    }

    // Build (or rebuild) the per-frame L.imageOverlay layers for the
    // current storm. Each frame uses the /ir-frame.jpg endpoint with
    // frame_index = its position in animFrameTimes-equivalent order
    // (which matches the irFrames array index). The JPG itself is
    // storm-centered with radius_deg=10, so all overlays share the
    // same bounds — just storm.lat/lon ±10°.
    function _satIrRebuildFrameLayers() {
        if (!_satMwLeafletIr) return;
        // Release any blob URLs held by the old layers before they
        // become unreachable — createObjectURL leaks bytes until
        // revokeObjectURL is called.
        _satIrRevokeFrameBlobUrls();
        // Tear down old layers (e.g., on storm change).
        for (var i = 0; i < _satIrFrameLayers.length; i++) {
            _satMwLeafletIr.removeLayer(_satIrFrameLayers[i]);
        }
        _satIrFrameLayers = [];
        var storm = currentStorm;
        if (!storm || storm.lat == null || storm.lon == null) return;
        if (!irFrames || !irFrames.length) return;
        var bounds = [
            [storm.lat - _SAT_IR_RADIUS_DEG, storm.lon - _SAT_IR_RADIUS_DEG],
            [storm.lat + _SAT_IR_RADIUS_DEG, storm.lon + _SAT_IR_RADIUS_DEG]
        ];
        for (var k = 0; k < irFrames.length; k++) {
            var url = API_BASE
                + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
                + '/ir-frame.jpg?frame_index=' + k
                + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + _SAT_IR_RADIUS_DEG
                + '&interval_min=' + FRAME_INTERVAL_MIN;
            var layer = L.imageOverlay(url, bounds, {
                opacity: 0,
                interactive: false,
                crossOrigin: 'anonymous',
            }).addTo(_satMwLeafletIr);
            // Phase 4: tag the layer with its initial colormap so the
            // sync-URL helper can detect cmap changes and re-bake the
            // overlay when needed. Initial URL is /ir-frame.jpg, so
            // we start at 'claude-ir'.
            layer._currentCmap = 'claude-ir';
            layer._blobUrl = null;
            _satIrFrameLayers.push(layer);
        }
        _satIrFrameStormId = storm.atcf_id;
    }

    // Phase 4: bake a raw-Tb frame through the requested colormap's
    // LUT to a blob URL suitable for L.imageOverlay.setUrl. Async
    // because canvas.toBlob is async; resolves to null on failure.
    // Pure data plumbing — does NOT update any layers itself.
    function _satIrBakeFrameToBlobUrl(frame, cmapName) {
        return new Promise(function (resolve) {
            var lut32 = getLut32(cmapName) || getLut32('enhanced');
            if (!lut32 || !frame || !frame.tb_data) {
                resolve(null); return;
            }
            var off = document.createElement('canvas');
            off.width = frame.cols;
            off.height = frame.rows;
            var ctx = off.getContext('2d');
            var imgData = ctx.createImageData(frame.cols, frame.rows);
            // Transparent background — only paint where tb_data is
            // non-zero (matches the canvas painter's behavior). The
            // Leaflet basemap shows through transparent regions.
            var buf32 = new Uint32Array(imgData.data.buffer);
            buf32.fill(0);
            var tb = frame.tb_data;
            for (var i = 0; i < tb.length; i++) {
                if (tb[i] !== 0) buf32[i] = lut32[tb[i]];
            }
            ctx.putImageData(imgData, 0, 0);
            off.toBlob(function (blob) {
                if (!blob) { resolve(null); return; }
                resolve(URL.createObjectURL(blob));
            }, 'image/png');
        });
    }

    // For a given frame index + colormap, ensure the corresponding
    // L.imageOverlay layer's URL points at the right image source:
    //   - 'claude-ir' (default) → /ir-frame.jpg (cheap; server-baked)
    //   - any other colormap     → blob URL baked from raw Tb (Phase 4)
    // Async-safe: if the user switches colormaps mid-bake, the
    // stale resolution gets discarded and the blob URL revoked.
    function _satIrSyncFrameUrl(idx, cmapName) {
        var layer = _satIrFrameLayers[idx];
        if (!layer) return;
        // Guard: if this layer is already at the target cmap, no-op.
        if (layer._currentCmap === cmapName) return;

        if (cmapName === 'claude-ir') {
            var storm = currentStorm;
            if (!storm) return;
            var url = API_BASE
                + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
                + '/ir-frame.jpg?frame_index=' + idx
                + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + _SAT_IR_RADIUS_DEG
                + '&interval_min=' + FRAME_INTERVAL_MIN;
            layer.setUrl(url);
            layer._currentCmap = cmapName;
            // Revoke the previous blob URL if any — server-JPG path
            // doesn't use blob URLs, so any cached one is now stale.
            if (layer._blobUrl) {
                URL.revokeObjectURL(layer._blobUrl);
                layer._blobUrl = null;
            }
            return;
        }

        // Custom colormap path — need raw Tb to bake. If the raw Tb
        // hasn't loaded yet for this frame, just leave the layer at
        // its previous URL; once raw Tb lands, the next render tick
        // will re-fire this and bake the blob.
        var frame = irFrames[idx];
        if (!frame || !frame.tb_data) return;

        _satIrBakeFrameToBlobUrl(frame, cmapName).then(function (url) {
            if (!url) return;
            // The user may have flipped to a different colormap while
            // we were baking. Discard if so — and revoke the now-
            // orphaned blob URL so it doesn't leak.
            if (selectedColormap !== cmapName) {
                URL.revokeObjectURL(url);
                return;
            }
            if (layer._blobUrl) URL.revokeObjectURL(layer._blobUrl);
            layer._blobUrl = url;
            layer.setUrl(url);
            layer._currentCmap = cmapName;
        });
    }

    // Release all blob URLs held by per-frame layers. Called when
    // the storm changes or the layer set is rebuilt to avoid memory
    // leaks (createObjectURL holds a reference to the blob's bytes
    // until revokeObjectURL fires).
    function _satIrRevokeFrameBlobUrls() {
        for (var i = 0; i < _satIrFrameLayers.length; i++) {
            var L = _satIrFrameLayers[i];
            if (L && L._blobUrl) {
                URL.revokeObjectURL(L._blobUrl);
                L._blobUrl = null;
            }
        }
    }

    // Render the current frame on the Leaflet map by toggling opacity.
    // Also updates the center-fix marker if the frame carries one.
    function _satIrRenderLeafletFrame() {
        if (!_satMwLeafletIr || !_satIrFrameLayers.length) return;
        var idx = animIndex;
        if (idx < 0 || idx >= _satIrFrameLayers.length) return;
        // Phase 4: make sure each layer's URL points at the right
        // colormap source. _satIrSyncFrameUrl no-ops when already at
        // the target cmap, so this loop is cheap when nothing's
        // changed.
        for (var k = 0; k < _satIrFrameLayers.length; k++) {
            _satIrSyncFrameUrl(k, selectedColormap);
        }
        for (var i = 0; i < _satIrFrameLayers.length; i++) {
            _satIrFrameLayers[i].setOpacity(i === idx ? 0.92 : 0);
        }
        // Center-fix marker — only shown when the active frame has a
        // detected fix (eye-strength storms only, gated server-side).
        var frame = irFrames[idx];
        var cf = frame && frame.center_fix;
        if (cf && cf.lat != null && cf.lon != null) {
            var icon = L.divIcon({
                className: 'sat-leaflet-centerfix',
                html: '<span class="sat-leaflet-centerfix-inner"></span>',
                iconSize: [22, 22], iconAnchor: [11, 11]
            });
            if (!_satIrCenterFixMarker) {
                _satIrCenterFixMarker = L.marker([cf.lat, cf.lon], {
                    icon: icon, interactive: false, keyboard: false,
                });
                _satIrCenterFixMarker.addTo(_satMwLeafletIr);
            } else {
                _satIrCenterFixMarker.setLatLng([cf.lat, cf.lon]);
                _satIrCenterFixMarker.setIcon(icon);
                if (!_satMwLeafletIr.hasLayer(_satIrCenterFixMarker)) {
                    _satIrCenterFixMarker.addTo(_satMwLeafletIr);
                }
            }
        } else if (_satIrCenterFixMarker && _satMwLeafletIr.hasLayer(_satIrCenterFixMarker)) {
            _satMwLeafletIr.removeLayer(_satIrCenterFixMarker);
        }
        // Reflect centerfix presence in the on-map legend so users know
        // what the cyan crosshair means (only shown when a fix exists).
        _satLegendSetRow(_satMwLeafletIr, 'centerfix',
                         !!(cf && cf.lat != null && cf.lon != null));
    }

    // Frame the storm at the current zoomDeg (matches the zoom-button
    // expectation from the canvas era). Idempotent — caller decides
    // when to call (mode/colormap switch, storm select, zoom button).
    function _satIrCenterOnStorm() {
        if (!_satMwLeafletIr || !currentStorm) return;
        // setView is deterministic — storm always at geographic center.
        // fitBounds was sensitive to container measurement timing
        // (display:none → display:'' transitions), producing off-center
        // views when the size hadn't fully settled. Zoom 6 ≈ ±7° visible
        // in a 640-px pane, matching the canvas-era ±5°-±10° conventions.
        var z = 6;
        if (typeof zoomDeg === 'number') {
            // Map the canvas-era preset (10°/5°/2°) to a rough Leaflet
            // zoom level. Wider extent → smaller zoom number.
            z = zoomDeg <= 2 ? 8 : zoomDeg <= 5 ? 7 : 6;
        }
        _satMwLeafletIr.invalidateSize();
        _satMwLeafletIr.setView([currentStorm.lat, currentStorm.lon], z,
                                { animate: false });
    }

    // Append-only layer builder used when new frames arrive into an
    // already-set-up storm (incremental loadFrames path). Skips the
    // teardown that _satIrRebuildFrameLayers performs.
    function _satIrAppendNewFrameLayers() {
        var storm = currentStorm;
        if (!storm || !_satMwLeafletIr) return;
        var bounds = [
            [storm.lat - _SAT_IR_RADIUS_DEG, storm.lon - _SAT_IR_RADIUS_DEG],
            [storm.lat + _SAT_IR_RADIUS_DEG, storm.lon + _SAT_IR_RADIUS_DEG]
        ];
        for (var k = _satIrFrameLayers.length; k < irFrames.length; k++) {
            var url = API_BASE
                + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
                + '/ir-frame.jpg?frame_index=' + k
                + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + _SAT_IR_RADIUS_DEG
                + '&interval_min=' + FRAME_INTERVAL_MIN;
            var layer = L.imageOverlay(url, bounds, {
                opacity: 0, interactive: false, crossOrigin: 'anonymous',
            }).addTo(_satMwLeafletIr);
            _satIrFrameLayers.push(layer);
        }
    }

    // High-level entry: caller has changed mode, colormap, storm, or
    // frame data. We decide whether Leaflet is active, swap visibility,
    // (re-)build per-frame overlays if the storm changed or the frame
    // buffer reset, append new layers if frames trickled in, and
    // render the active frame.
    function _satIrSyncLeaflet(opts) {
        // MW mode owns the IR map directly (Phase 1) — let it manage
        // visibility, overlays, and the matched-time IR JPG without
        // interference from the Phase 2 animation pipeline. Without
        // this guard, _satIrApplyLeafletVisibility would hide the
        // Leaflet container the moment renderBothPanels runs in MW
        // mode, and the per-frame overlays would fight the single
        // matched-time overlay Phase 1 added.
        if (viewMode === 'microwave') return;
        opts = opts || {};
        _satIrApplyLeafletVisibility();
        if (!_satIrLeafletActive) return;
        _satEnsureIrMap();
        var stormId = currentStorm && currentStorm.atcf_id;
        var stormChanged = (_satIrFrameStormId !== stormId);
        // Detect frame-buffer reset (selectStorm clears irFrames=[]
        // before refetching) — same fix as a storm change but without
        // a stormId flip.
        var bufferReset = (_satIrFrameLayers.length > irFrames.length);
        if (opts.stormChanged || stormChanged || bufferReset) {
            _satIrRebuildFrameLayers();
            _satIrCenterOnStorm();
        } else if (_satIrFrameLayers.length < irFrames.length) {
            _satIrAppendNewFrameLayers();
        }
        if (opts.recenter) _satIrCenterOnStorm();
        _satIrRenderLeafletFrame();
    }

    // Expose so other functions can re-sync without poking globals.
    window._satIrSyncLeaflet = _satIrSyncLeaflet;

    // ════════════════════════════════════════════════════════════════
    //  Phase 3: WV/Vis right pane on Leaflet
    //  Replaces the canvas WV/Vis display when:
    //    1. View mode is "compare-wv" or "compare-vis" (other modes
    //       use the right pane for diagnostics/track/asym/MW),
    //    2. AND the user has the band's default colormap selected
    //       (`wv` for WV band, `vis` for Vis band — custom colormaps
    //       stay on the canvas LUT painter).
    //  Per-frame L.imageOverlay layers pre-loaded at opacity 0;
    //  showFrame just toggles opacity. Pan/zoom synced with the IR
    //  Leaflet map on the left.
    // ════════════════════════════════════════════════════════════════
    var _satRightLeafletMap = null;
    var _satRightFrameLayers = [];
    var _satRightFrameStormId = null;
    var _satRightFrameBand = null;
    var _SAT_RIGHT_BAND_TO_DEFAULT_CMAP = { 8: 'wv', 2: 'vis' };

    function _satRightShouldUseLeaflet() {
        if (viewMode !== 'compare-wv' && viewMode !== 'compare-vis') return false;
        var defaultCmap = _SAT_RIGHT_BAND_TO_DEFAULT_CMAP[rightBand];
        return defaultCmap && rightColormapName === defaultCmap;
    }

    function _satRightEnsureMap() {
        if (_satRightLeafletMap) return;
        var div = document.getElementById('sat-leaflet-right');
        if (!div) return;
        _satRightLeafletMap = L.map(div, _SAT_LEAFLET_OPTS).setView([0, 0], 5);
        L.tileLayer(_SAT_LEAFLET_BASE_URL, { maxZoom: 12, opacity: 0.55 })
            .addTo(_satRightLeafletMap);
        // Sync with the left IR map (Phase 1/2 init). Uses the shared
        // _satMwSyncing guard so we don't get feedback loops, AND
        // honors the _satMapSyncEnabled global toggle so the user
        // can pan/zoom each pane independently if desired.
        if (_satMwLeafletIr) {
            _satRightLeafletMap.on('moveend zoomend', function () {
                if (!_satMapSyncEnabled) return;
                if (_satMwSyncing) return;
                _satMwSyncing = true;
                _satMwLeafletIr.setView(_satRightLeafletMap.getCenter(),
                                        _satRightLeafletMap.getZoom(),
                                        { animate: false });
                _satMwSyncing = false;
            });
            _satMwLeafletIr.on('moveend zoomend', function () {
                if (!_satMapSyncEnabled) return;
                if (_satMwSyncing) return;
                _satMwSyncing = true;
                _satRightLeafletMap.setView(_satMwLeafletIr.getCenter(),
                                            _satMwLeafletIr.getZoom(),
                                            { animate: false });
                _satMwSyncing = false;
            });
        }
        _satAddMapControls(_satRightLeafletMap);
        // Phase 6: per-pixel Tb hover for the WV/Vis pane.
        _satAttachLeafletHover(_satRightLeafletMap, function () { return rightFrames; }, 'WV/Vis');
        _satAddGraticule(_satRightLeafletMap);
        _satAddCoastlines(_satRightLeafletMap);
    }

    function _satRightApplyLeafletVisibility() {
        var canvasWrap = document.getElementById('sat-panel-right-canvas-wrap');
        var leafletDiv = document.getElementById('sat-leaflet-right');
        var axesY = document.getElementById('sat-axes-y-right');
        var axesX = document.getElementById('sat-axes-x-right');
        var colorbar = document.getElementById('sat-cb-right');
        var useLeaflet = _satRightShouldUseLeaflet();
        if (useLeaflet) {
            if (canvasWrap) canvasWrap.style.display = 'none';
            if (leafletDiv) leafletDiv.style.display = '';
            if (axesY) axesY.style.display = 'none';
            if (axesX) axesX.style.display = 'none';
            // Keep the WV/Vis colorbar visible — pinned as a floating
            // overlay at the bottom of the panel via the
            // body.sat-leaflet-active CSS rule. Panes stay equal-
            // height because the colorbar floats over the map rather
            // than taking flex space.
            if (colorbar) colorbar.style.display = '';
        } else {
            if (canvasWrap) canvasWrap.style.display = '';
            if (leafletDiv) leafletDiv.style.display = 'none';
            if (axesY) axesY.style.display = '';
            if (axesX) axesX.style.display = '';
            if (colorbar) colorbar.style.display = '';
        }
    }

    function _satRightRebuildFrameLayers() {
        if (!_satRightLeafletMap) return;
        for (var i = 0; i < _satRightFrameLayers.length; i++) {
            _satRightLeafletMap.removeLayer(_satRightFrameLayers[i]);
        }
        _satRightFrameLayers = [];
        var storm = currentStorm;
        if (!storm || storm.lat == null || storm.lon == null) return;
        if (!rightFrames || !rightFrames.length) return;
        var bounds = [
            [storm.lat - _SAT_IR_RADIUS_DEG, storm.lon - _SAT_IR_RADIUS_DEG],
            [storm.lat + _SAT_IR_RADIUS_DEG, storm.lon + _SAT_IR_RADIUS_DEG]
        ];
        for (var k = 0; k < rightFrames.length; k++) {
            var url = API_BASE
                + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
                + '/band-frame.jpg?band=' + rightBand
                + '&frame_index=' + k
                + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + _SAT_IR_RADIUS_DEG
                + '&interval_min=' + FRAME_INTERVAL_MIN;
            var layer = L.imageOverlay(url, bounds, {
                opacity: 0, interactive: false, crossOrigin: 'anonymous',
            }).addTo(_satRightLeafletMap);
            _satRightFrameLayers.push(layer);
        }
        _satRightFrameStormId = storm.atcf_id;
        _satRightFrameBand = rightBand;
    }

    function _satRightAppendNewFrameLayers() {
        var storm = currentStorm;
        if (!storm || !_satRightLeafletMap) return;
        var bounds = [
            [storm.lat - _SAT_IR_RADIUS_DEG, storm.lon - _SAT_IR_RADIUS_DEG],
            [storm.lat + _SAT_IR_RADIUS_DEG, storm.lon + _SAT_IR_RADIUS_DEG]
        ];
        for (var k = _satRightFrameLayers.length; k < rightFrames.length; k++) {
            var url = API_BASE
                + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id)
                + '/band-frame.jpg?band=' + rightBand
                + '&frame_index=' + k
                + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + _SAT_IR_RADIUS_DEG
                + '&interval_min=' + FRAME_INTERVAL_MIN;
            var layer = L.imageOverlay(url, bounds, {
                opacity: 0, interactive: false, crossOrigin: 'anonymous',
            }).addTo(_satRightLeafletMap);
            _satRightFrameLayers.push(layer);
        }
    }

    function _satRightRenderLeafletFrame() {
        if (!_satRightLeafletMap || !_satRightFrameLayers.length) return;
        var idx = animIndex;
        if (idx < 0 || idx >= _satRightFrameLayers.length) return;
        for (var i = 0; i < _satRightFrameLayers.length; i++) {
            _satRightFrameLayers[i].setOpacity(i === idx ? 0.92 : 0);
        }
    }

    function _satRightSyncLeaflet(opts) {
        if (viewMode === 'microwave') return;     // MW owns the right pane
        opts = opts || {};
        _satRightApplyLeafletVisibility();
        if (!_satRightShouldUseLeaflet()) return;
        _satRightEnsureMap();
        var stormId = currentStorm && currentStorm.atcf_id;
        var stormChanged = (_satRightFrameStormId !== stormId);
        var bandChanged = (_satRightFrameBand !== rightBand);
        var bufferReset = (_satRightFrameLayers.length > rightFrames.length);
        if (opts.stormChanged || stormChanged || bandChanged || bufferReset) {
            _satRightRebuildFrameLayers();
            if (_satRightLeafletMap && currentStorm) {
                _satRightLeafletMap.invalidateSize(false);
                _satRightLeafletMap.setView([currentStorm.lat, currentStorm.lon],
                                            6, { animate: false });
            }
        } else if (_satRightFrameLayers.length < rightFrames.length) {
            _satRightAppendNewFrameLayers();
        }
        _satRightRenderLeafletFrame();
    }
    window._satRightSyncLeaflet = _satRightSyncLeaflet;

    // ── Window resize handler ───────────────────────────────────
    // When the browser window resizes (or the dev tools open / the
    // user drags the window edge), the flex panes re-size but
    // Leaflet maps and Plotly charts don't auto-detect that — they
    // keep painting at their old dimensions, leaving partial gray
    // backgrounds and clipped legends. Hook a debounced resize
    // listener that pokes both rendering layers.
    var _satResizeTimer = null;
    window.addEventListener('resize', function () {
        if (_satResizeTimer) clearTimeout(_satResizeTimer);
        _satResizeTimer = setTimeout(function () {
            // Leaflet maps (all three: IR left, MW right, WV/Vis right).
            if (_satMwLeafletIr) _satMwLeafletIr.invalidateSize(false);
            if (_satMwLeafletMw) _satMwLeafletMw.invalidateSize(false);
            if (_satRightLeafletMap) _satRightLeafletMap.invalidateSize(false);
            // Plotly diagnostic charts — only if they're initialized
            // (data attribute present) and visible.
            if (typeof Plotly !== 'undefined') {
                ['sat-diag-radial', 'sat-diag-timeseries',
                 'sat-diag-histogram', 'sat-diag-hovmoller-chart']
                .forEach(function (id) {
                    var el = document.getElementById(id);
                    if (el && el.data) {
                        try { Plotly.Plots.resize(el); } catch (e) {}
                    }
                });
            }
            // Canvas panes — repaint at the new container size.
            if (typeof renderBothPanels === 'function'
                && irFrames && irFrames.length > 0) {
                renderBothPanels();
            }
        }, 120);
    });

    // ── Storm List ──────────────────────────────────────────────

    var _satActiveStormsETag = null;

    function loadStorms() {
        var headers = {};
        if (_satActiveStormsETag) headers['If-None-Match'] = _satActiveStormsETag;
        fetch(API_BASE + '/ir-monitor/active-storms', { cache: 'no-store', headers: headers })
            .then(function (r) {
                if (r.status === 304) return null;
                if (!r.ok) throw new Error('HTTP ' + r.status);
                var et = r.headers.get('ETag');
                if (et) _satActiveStormsETag = et;
                return r.json();
            })
            .then(function (data) {
                if (data === null) return;  // 304 — nothing changed
                storms = (data.storms || []).slice();
                storms.sort(function (a, b) { return (b.vmax_kt || 0) - (a.vmax_kt || 0); });
                renderStormList();
                if (storms.length === 0) { showNoStorms(); return; }
                var hashStorm = getHashStorm();
                var target = hashStorm ? storms.find(function (s) {
                    return s.atcf_id.toUpperCase() === hashStorm.toUpperCase();
                }) : null;
                if (!target) target = storms[0];
                selectStorm(target.atcf_id);
            })
            .catch(function (err) {
                console.error('[Satellite] Failed to load storms:', err);
                if (stormListEl) stormListEl.innerHTML = '<div class="sat-loading-msg">Failed to load storms. Retrying\u2026</div>';
                setTimeout(loadStorms, 30000);
            });
    }

    function renderStormList() {
        if (!stormListEl) return;
        if (storms.length === 0) { stormListEl.innerHTML = '<div class="sat-loading-msg">No active storms</div>'; return; }
        var html = '';
        for (var i = 0; i < storms.length; i++) {
            var s = storms[i], color = SS_COLORS[s.category] || SS_COLORS.TD;
            var active = (s.atcf_id === currentStormId) ? ' active' : '';
            html += '<div class="sat-storm-item' + active + '" data-id="' + s.atcf_id + '" style="--storm-color:' + color + '">' +
                '<div class="sat-storm-dot" style="background:' + color + '"></div>' +
                '<div class="sat-storm-info"><div class="sat-storm-name">' + (s.name || s.atcf_id) + '</div>' +
                '<div class="sat-storm-meta">' + categoryShort(s.category) +
                (s.vmax_kt != null ? ' \u00B7 ' + s.vmax_kt + ' kt' : '') +
                ' \u00B7 ' + (s.basin || '') + '</div></div></div>';
        }
        stormListEl.innerHTML = html;
        var items = stormListEl.querySelectorAll('.sat-storm-item');
        for (var j = 0; j < items.length; j++) {
            items[j].addEventListener('click', function () { selectStorm(this.getAttribute('data-id')); });
        }
    }

    function selectStorm(atcfId) {
        var alreadySpeculative = (currentStormId === atcfId && irFrames.length > 0);
        // Skip re-select only if we already have frames loaded for this storm.
        // Don't bail out when currentStormId matches but irFrames is empty —
        // that means a prior speculative fetch failed and we need to retry.
        if (currentStormId === atcfId && !alreadySpeculative && validFrameIndices.length > 0) return;
        stopAnimation();
        currentStormId = atcfId;
        currentStorm = storms.find(function (s) { return s.atcf_id === atcfId; }) || null;
        if (!alreadySpeculative) { irFrames = []; rightFrames = []; }
        animIndex = 0;
        irLoadedCount = 0; rightLoadedCount = 0;
        diagChartsInitialized = false;
        hovExtFrames = null; hovExtStormId = null; hovExtFetching = false;
        hovServerData = null; hovServerStormId = null;
        trackMetadata = null;
        _previewPhase = false; _previewDone = 0; _rawTbStarted = false;
        _satRemoveRadar();
        renderStormList();
        updateHash(atcfId);

        // Smart default mode on storm change.
        //   • Storm ≥ 65 kt → Diagnostics (eye-detected inner-core
        //     analysis is informative for hurricanes and stronger).
        //   • Storm < 65 kt → WV compare (Diagnostics would just
        //     show "requires detected eye" with empty charts — a
        //     poor first impression for the user).
        //   • Microwave mode is preserved across storm changes
        //     (storm-bound but IR-frame-independent — just refresh
        //     the panel against the new storm).
        // ── Smart-default mode switch (deferred below) ────────────
        var smartMode = (currentStorm
                         && isFinite(currentStorm.vmax_kt)
                         && currentStorm.vmax_kt >= 65)
            ? 'diagnostics' : 'compare-wv';
        // Local helper — actually runs the mode switch. We hold off
        // calling this until AFTER loadFrames so IR fetches grab
        // the browser's connection slots first; otherwise the
        // setViewMode → _refetchRightFrames pipeline starts WV/Vis
        // fetches before IR and the user sees WV finish loading
        // first, which feels backwards.
        function _applySmartDefault() {
            if (viewMode === 'microwave') {
                _satMwActivate();
            } else if (viewMode !== smartMode) {
                viewMode = '__pre_smart_default';
                setViewMode(smartMode);
            }
        }

        if (currentStorm) {
            var color = SS_COLORS[currentStorm.category] || SS_COLORS.TD;
            stormLabelEl.textContent = (currentStorm.name || atcfId) + ' (' + categoryShort(currentStorm.category) + ')';
            stormLabelEl.style.color = color;
        }
        if (window.innerWidth <= 768 && sidebar) sidebar.classList.remove('open');
        noStormsEl.style.display = 'none';

        // Check browser-side cache
        var cached = frameCache[atcfId];
        if (cached && cached.ir && (Date.now() - cached.ts) < FRAME_CACHE_TTL) {
            irFrames = cached.ir;
            // Restore right frames only if in compare mode and band matches
            if (viewMode !== 'diagnostics' && cached.right && cached.rightBand === rightBand) {
                rightFrames = cached.right;
            }
            buildValidIndices();
            animIndex = validFrameIndices.length > 0 ? validFrameIndices[0] : 0;
            updateSliderMax();
            renderBothPanels();
            updateAnimUI();
            console.log('[Satellite] Loaded ' + atcfId + ' from browser cache');
        } else if (alreadySpeculative) {
            // Speculative frame 0 already displayed — just backfill the rest
            loadFrames(atcfId);
        } else {
            showLoader('Loading satellite data\u2026');
            loadFrames(atcfId);
        }

        // Now that IR loading is in flight, fire the smart-default
        // mode switch. setViewMode kicks off the WV/Vis band fetches,
        // which queue behind the already-pending IR fetches in the
        // browser's connection pool \u2014 so the LEFT pane (IR) lands
        // first, not the RIGHT pane (WV).
        _applySmartDefault();

        _ga('sat_select_storm', { storm: atcfId });
    }

    // ── Frame Loading ───────────────────────────────────────────

    // Valid frame indices (where IR loaded successfully) — used for animation
    var validFrameIndices = [];

    function buildValidIndices() {
        validFrameIndices = [];
        for (var i = 0; i < irFrames.length; i++) {
            if (irFrames[i]) validFrameIndices.push(i);
        }
        // _interpolateCenters is best-effort — only affects follow-storm
        // accuracy. If it throws for any reason (malformed bounds from a
        // stale bundle, unexpected frame shape, etc.), follow simply falls
        // back to the frame's own bounds-center via getViewBounds — the
        // viewer keeps animating.
        try {
            _interpolateCenters(irFrames);
        } catch (e) {
            console.warn('[Satellite] _interpolateCenters failed:', e && e.message);
        }
    }

    /**
     * Interpolate/extrapolate center positions for frames missing center_fix.
     * Same algorithm as buildHovmollerData uses, but stores the result on
     * each frame as _interpCenter = { lat, lon } for use by getViewBounds.
     *
     * Fallback chain (best → worst):
     *   1. IR center_fix on the frame (objective eye position)
     *   2. Interpolation between adjacent IR fixes (≥2 fixes exist)
     *   3. Per-frame bounds-center = interpolated/extrapolated best-track
     *      position the server used when it built each frame's cutout
     *      (always available since the bundle embeds it in `bounds`)
     *   4. Static currentStorm advisory position (last resort, no track)
     *
     * The bounds-center fallback means follow-storm now ACTUALLY follows
     * the storm even when no eye is detectable — it tracks the best-track
     * motion across the 6h window instead of pinning every frame to the
     * latest advisory position (which made follow look static for weak
     * or shear-disrupted storms).
     */
    function _interpolateCenters(frames) {
        // Helper: bounds-center = (interp_lat, interp_lon) at frame's time.
        // Defensively guard every level — malformed bounds from a stale
        // bundle or in-flight cache write must NOT throw and tear down
        // the viewer (especially on memory-constrained mobile browsers
        // where an uncaught exception in a render loop can compound into
        // a full reload).
        function _boundsCenter(f) {
            if (!f || !f.bounds) return null;
            var b = f.bounds;
            if (!Array.isArray(b) || b.length < 2) return null;
            if (!Array.isArray(b[0]) || b[0].length < 2) return null;
            if (!Array.isArray(b[1]) || b[1].length < 2) return null;
            var s = +b[0][0], w = +b[0][1], n = +b[1][0], e = +b[1][1];
            if (!isFinite(s) || !isFinite(w) || !isFinite(n) || !isFinite(e)) return null;
            return { lat: (s + n) / 2, lon: (w + e) / 2 };
        }
        function _trackOrAdvisory(f) {
            var bc = _boundsCenter(f);
            if (bc) return bc;
            if (currentStorm && currentStorm.lat != null && isFinite(currentStorm.lat)) {
                return { lat: currentStorm.lat, lon: currentStorm.lon };
            }
            return null;
        }

        var knownIndices = [];
        var fixLat = [], fixLon = [];
        for (var i = 0; i < frames.length; i++) {
            if (frames[i] && frames[i].center_fix && frames[i].center_fix.lat) {
                fixLat[i] = frames[i].center_fix.lat;
                fixLon[i] = frames[i].center_fix.lon;
                knownIndices.push(i);
            }
            if (frames[i]) frames[i]._interpCenter = null;
        }
        if (knownIndices.length === 0) {
            // No IR center fixes — use the per-frame interpolated best-track
            // position embedded in each frame's bounds. This is the key
            // upgrade: previously we used the static advisory for every
            // frame (so follow looked frozen); now follow tracks actual
            // best-track motion through the lookback window.
            for (var ai = 0; ai < frames.length; ai++) {
                if (!frames[ai]) continue;
                frames[ai]._interpCenter = _trackOrAdvisory(frames[ai]);
            }
            return;
        }

        if (knownIndices.length === 1) {
            // Only one IR fix — anchor that frame to its eye, fall back
            // to per-frame bounds-center for all others. Better than the
            // old behavior (pin every frame to a single eye position).
            var only = knownIndices[0];
            for (var si = 0; si < frames.length; si++) {
                if (!frames[si]) continue;
                if (si === only) {
                    frames[si]._interpCenter = { lat: fixLat[only], lon: fixLon[only] };
                } else {
                    frames[si]._interpCenter = _trackOrAdvisory(frames[si])
                        || { lat: fixLat[only], lon: fixLon[only] };
                }
            }
            return;
        }

        for (var ii = 0; ii < frames.length; ii++) {
            if (!frames[ii]) continue;
            if (fixLat[ii] != null) {
                frames[ii]._interpCenter = { lat: fixLat[ii], lon: fixLon[ii] };
                continue;
            }
            var lo = -1, hi = -1;
            for (var ki = 0; ki < knownIndices.length; ki++) {
                if (knownIndices[ki] <= ii) lo = ki;
                if (knownIndices[ki] >= ii && hi < 0) hi = ki;
            }
            var cLat, cLon;
            if (lo >= 0 && hi >= 0 && lo !== hi) {
                var loIdx = knownIndices[lo], hiIdx = knownIndices[hi];
                var frac = (ii - loIdx) / (hiIdx - loIdx);
                cLat = fixLat[loIdx] + frac * (fixLat[hiIdx] - fixLat[loIdx]);
                cLon = fixLon[loIdx] + frac * (fixLon[hiIdx] - fixLon[loIdx]);
            } else {
                var a, b;
                if (lo < 0) { a = knownIndices[0]; b = knownIndices[1]; }
                else { a = knownIndices[knownIndices.length - 2]; b = knownIndices[knownIndices.length - 1]; }
                var span = b - a;
                if (span > 0) {
                    var ext = (ii - a) / span;
                    cLat = fixLat[a] + ext * (fixLat[b] - fixLat[a]);
                    cLon = fixLon[a] + ext * (fixLon[b] - fixLon[a]);
                } else {
                    cLat = fixLat[a]; cLon = fixLon[a];
                }
            }
            frames[ii]._interpCenter = { lat: cLat, lon: cLon };
        }
    }

    function _refetchRightFrames(stormId) {
        // Try RT Monitor band cache first
        if (_tryRtBandCache(stormId)) return;

        var totalFrames = 13;
        var bandLabel = rightBand === 2 ? 'Vis' : 'WV';
        var bandName = rightBand === 2 ? 'Visible' : 'Water Vapor';
        var band = rightBand;

        // Set label immediately so user sees correct band name while loading
        if (rightLabelEl) rightLabelEl.textContent = bandName + '  (loading\u2026)';

        // Bundle-first path: one /band-frames-bundle request returns all
        // 25 WebPs (at 15-min cadence) packed as [u32 len][JSON][concat].
        // Replaces the per-frame waterfall that hit 21 cold-cache S3
        // fetches for Vis (prewarm only stores most-recent frames since
        // L1b is 16\u00d7 the IR data). Falls through to the per-frame
        // preview path on any failure.
        _satTryBandBundleThen(stormId, band, function (ok, parsed) {
            if (!ok) {
                console.log('[Satellite] Band bundle unavailable; using per-frame waterfall');
                _refetchRightFramesLegacy(stormId);
                return;
            }
            // parsed = { frames: [{previewImg, bounds, datetime_utc, satellite, ...}], total }
            if (stormId !== currentStormId || band !== rightBand) return;
            for (var i = 0; i < parsed.frames.length; i++) {
                rightFrames[parsed.frames[i].index] = parsed.frames[i].entry;
            }
            totalFrames = parsed.total;
            if (loadStatusEl) loadStatusEl.textContent = '';
            if (rightLabelEl) rightLabelEl.textContent = bandName;
            renderBothPanels();
            updateAnimUI();
            if (!frameCache[stormId]) frameCache[stormId] = { ts: Date.now() };
            frameCache[stormId].right = rightFrames.slice();
            frameCache[stormId].band = band;
            frameCache[stormId].ts = Date.now();
            console.log('[Satellite] Band bundle: ' + parsed.frames.length + '/' +
                        parsed.total + ' ' + bandLabel + ' frames loaded');
        });
        return;
    }

    /** Band bundle parser \u2014 fetches /band-frames-bundle (with direct-GCS
     *  try first), decodes the packed binary, returns an array of
     *  {index, entry} pairs where `entry` is shaped like rightFrames[i].
     *  Calls done(false) on any failure so caller can fall back. */
    var _GCS_BAND_BUNDLE_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/rt-v10/bundles/band';
    function _satTryBandBundleThen(sid, band, done) {
        var apiUrl = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(sid)
            + '/band-frames-bundle?band=' + band
            + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
            + '&radius_deg=' + DEFAULT_RADIUS_DEG
            + '&interval_min=' + FRAME_INTERVAL_MIN;
        var gcsUrl = _GCS_BAND_BUNDLE_BASE + '/' + band + '/'
            + encodeURIComponent(sid.toUpperCase()) + '.bin';
        // Try GCS direct first (prewarmed, no Cloud Run hop). Cold storm
        // or unwritten bundle \u2192 fall to API endpoint.
        fetch(gcsUrl)
            .then(function (r) {
                if (!r.ok) throw new Error('gcs band bundle HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .catch(function () {
                return fetch(apiUrl).then(function (r) {
                    if (!r.ok) throw new Error('api band bundle HTTP ' + r.status);
                    return r.arrayBuffer();
                });
            })
            .then(function (buf) {
                try {
                    var dv = new DataView(buf);
                    if (buf.byteLength < 4) throw new Error('bundle too small');
                    var hl = dv.getUint32(0, true);
                    if (4 + hl > buf.byteLength) throw new Error('bundle header overrun');
                    var header = JSON.parse(new TextDecoder('utf-8')
                        .decode(new Uint8Array(buf, 4, hl)));
                    var bin = 4 + hl;
                    var mediaType = header.media_type || 'image/webp';
                    var hdrFrames = header.frames || [];
                    var bandVmin = header.vmin || 170;
                    var bandVmax = header.vmax || 260;
                    var dataType = header.data_type || 'tb';

                    // Decode all frames. Frames with byte_length=0 are
                    // skipped (Vis nighttime / missing data).
                    var pending = 0;
                    var out = [];
                    var settled = false;
                    function maybeFinish() {
                        if (settled) return;
                        if (pending === 0) {
                            settled = true;
                            done(true, { frames: out, total: header.total_frames });
                        }
                    }
                    for (var i = 0; i < hdrFrames.length; i++) {
                        var f = hdrFrames[i];
                        if (!f.byte_length || f.error) continue;
                        var slice = new Uint8Array(buf, bin + f.byte_offset, f.byte_length);
                        var blob = new Blob([slice], { type: mediaType });
                        var url = URL.createObjectURL(blob);
                        pending++;
                        (function (fHdr) {
                            var img = new Image();
                            img.onload = function () {
                                out.push({
                                    index: fHdr.index,
                                    entry: {
                                        previewImg: img,
                                        tb_data: null,
                                        rows: img.naturalHeight,
                                        cols: img.naturalWidth,
                                        bounds: fHdr.bounds,
                                        datetime_utc: fHdr.datetime_utc || '',
                                        satellite: fHdr.satellite || '',
                                        tb_vmin: bandVmin,
                                        tb_vmax: bandVmax,
                                        data_type: dataType
                                    }
                                });
                                pending--;
                                maybeFinish();
                            };
                            img.onerror = function () {
                                pending--;
                                maybeFinish();
                            };
                            img.src = url;
                        })(f);
                    }
                    if (pending === 0) {
                        // No valid frames (all nighttime / missing)
                        done(false, null);
                    }
                } catch (e) {
                    console.warn('[Satellite] Band bundle parse failed:', e.message);
                    done(false, null);
                }
            })
            .catch(function (err) {
                console.warn('[Satellite] Band bundle fetch failed:',
                             err && err.message);
                done(false, null);
            });
    }

    /** Legacy per-frame band waterfall (fallback when bundle unavailable) */
    function _refetchRightFramesLegacy(stormId) {
        var totalFrames = 13;
        var bandLabel = rightBand === 2 ? 'Vis' : 'WV';
        var bandName = rightBand === 2 ? 'Visible' : 'Water Vapor';
        var band = rightBand;

        if (rightLabelEl) rightLabelEl.textContent = bandName + '  (loading\u2026)';

        // Phase 1: fast JPG preview for right panel
        var previewDone = 0;
        var rawStarted = false;

        function _fetchRightPreview(idx) {
            if (idx >= totalFrames || stormId !== currentStormId || band !== rightBand) return;
            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/band-frame.jpg'
                + '?band=' + band + '&frame_index=' + idx + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;

            fetch(url, { cache: 'no-store' })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    var hdrs = r.headers;
                    var meta = {
                        datetime_utc: (hdrs.get('X-Datetime') || ''),
                        satellite: hdrs.get('X-Satellite') || '',
                        bounds: null
                    };
                    try { meta.bounds = JSON.parse(hdrs.get('X-Bounds')); } catch (e) {}
                    var ft = hdrs.get('X-Total-Frames');
                    if (ft) totalFrames = parseInt(ft, 10) || totalFrames;
                    return r.blob().then(function (blob) { return { blob: blob, meta: meta }; });
                })
                .then(function (result) {
                    if (stormId !== currentStormId || band !== rightBand) return;
                    var img = new Image();
                    img.onload = function () {
                        if (!rightFrames[idx] || !rightFrames[idx].tb_data) {
                            rightFrames[idx] = {
                                previewImg: img, tb_data: null,
                                rows: img.naturalHeight, cols: img.naturalWidth,
                                bounds: result.meta.bounds,
                                datetime_utc: result.meta.datetime_utc,
                                satellite: result.meta.satellite,
                                tb_vmin: 170, tb_vmax: 260,
                                data_type: rightDataType
                            };
                        }
                        previewDone++;
                        if (loadStatusEl) loadStatusEl.textContent = bandLabel + ' preview ' + previewDone + '/' + totalFrames;
                        if (stormId === currentStormId) renderBothPanels();

                        if (previewDone >= totalFrames && !rawStarted) {
                            rawStarted = true;
                            _startRightRawBackfill();
                        }
                    };
                    img.src = URL.createObjectURL(result.blob);
                })
                .catch(function () {
                    previewDone++;
                    // Fallback: fetch raw Tb for this frame directly
                    if (!rightFrames[idx]) _fetchRightRaw(idx);
                    if (previewDone >= totalFrames && !rawStarted) {
                        rawStarted = true;
                        _startRightRawBackfill();
                    }
                })
                .finally(function () {
                    var next = idx + FETCH_CONCURRENCY;
                    if (next < totalFrames) _fetchRightPreview(next);
                });
        }

        // Phase 2: raw Tb backfill for hover/colormaps
        function _startRightRawBackfill() {
            if (loadStatusEl) loadStatusEl.textContent = 'Loading ' + bandLabel + ' data...';
            var tbDone = 0;
            for (var i = 0; i < Math.min(FETCH_CONCURRENCY, totalFrames); i++) _fetchRightRaw(i);

            function _onRawDone() {
                tbDone++;
                if (loadStatusEl) loadStatusEl.textContent = bandLabel + ' ' + tbDone + '/' + totalFrames;
                if (tbDone >= totalFrames) {
                    if (loadStatusEl) loadStatusEl.textContent = '';
                    if (!frameCache[stormId]) frameCache[stormId] = { ts: Date.now() };
                    frameCache[stormId].right = rightFrames.slice();
                    frameCache[stormId].rightBand = band;
                    frameCache[stormId].ts = Date.now();
                }
            }
            // Attach completion handler
            window._rightRawDone = _onRawDone;
        }

        function _fetchRightRaw(idx) {
            if (idx >= totalFrames || stormId !== currentStormId || band !== rightBand) return;
            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/band-raw-frame'
                + '?band=' + band + '&frame_index=' + idx + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;
            fetch(url, { cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (data) {
                    if (stormId !== currentStormId || band !== rightBand) return;
                    if (data.total_frames) totalFrames = data.total_frames;
                    var existing = rightFrames[idx] || {};
                    rightFrames[idx] = {
                        previewImg: existing.previewImg || null,
                        tb_data: decodeTbData(data.tb_data), rows: data.tb_rows, cols: data.tb_cols,
                        bounds: data.bounds, datetime_utc: data.datetime_utc,
                        satellite: data.satellite || '', tb_vmin: data.tb_vmin, tb_vmax: data.tb_vmax,
                        data_type: data.data_type || rightDataType
                    };
                    if (stormId === currentStormId) renderBothPanels();
                })
                .catch(function (err) {
                    console.warn('[Satellite] Right frame ' + idx + ' failed:', err.message);
                })
                .finally(function () {
                    if (window._rightRawDone) window._rightRawDone();
                    var next = idx + FETCH_CONCURRENCY;
                    if (next < totalFrames) _fetchRightRaw(next);
                });
        }

        console.log('[Satellite] _refetchRightFrames: band=' + band + ' storm=' + stormId + ' (JPG preview first)');
        for (var i = 0; i < Math.min(FETCH_CONCURRENCY, totalFrames); i++) _fetchRightPreview(i);
    }

    /** Try to populate rightFrames[] from the RT Monitor's band cache. */
    function _tryRtBandCache(stormId) {
        if (!window.getRtRawBandFrames) return false;
        var rtBand = window.getRtRawBandFrames(stormId, rightBand);
        if (!rtBand || rtBand.length === 0) return false;
        console.log('[Satellite] Reusing ' + rtBand.length + ' band ' + rightBand + ' frames from RT Monitor cache');
        for (var i = 0; i < rtBand.length; i++) {
            var rf = rtBand[i];
            if (!rf) continue;
            rightFrames[i] = {
                tb_data: (rf.tb_data instanceof Uint8Array) ? rf.tb_data : decodeTbData(rf.tb_data),
                rows: rf.tb_rows, cols: rf.tb_cols,
                bounds: rf.bounds, datetime_utc: rf.datetime_utc,
                satellite: rf.satellite || '', tb_vmin: rf.tb_vmin, tb_vmax: rf.tb_vmax,
                data_type: rf.data_type || rightDataType
            };
        }
        if (!frameCache[stormId]) frameCache[stormId] = { ts: Date.now() };
        frameCache[stormId].right = rightFrames.slice();
        frameCache[stormId].rightBand = rightBand;
        frameCache[stormId].ts = Date.now();
        renderBothPanels();
        return true;
    }

    function loadFrames(stormId) {
        var totalFrames = 13;
        var irDone = 0, rightDone = 0, irFail = 0, rightFail = 0;

        function updateStatus() {
            if (!loadStatusEl) return;
            if (irDone < totalFrames) {
                loadStatusEl.textContent = 'IR ' + (irDone - irFail) + '/' + totalFrames;
            } else if (viewMode !== 'diagnostics' && rightDone < totalFrames) {
                var label = rightBand === 2 ? 'Vis' : 'WV';
                loadStatusEl.textContent = label + ' ' + (rightDone - rightFail) + '/' + totalFrames;
            } else {
                loadStatusEl.textContent = '';
            }
        }

        function fetchIRFrame(idx, retry) {
            if (idx >= totalFrames || stormId !== currentStormId) return;
            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/ir-raw-frame'
                + '?frame_index=' + idx + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;

            fetch(url, { cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (data) {
                    if (data.total_frames) totalFrames = data.total_frames;
                    irFrames[idx] = {
                        tb_data: decodeTbData(data.tb_data), rows: data.tb_rows, cols: data.tb_cols,
                        bounds: data.bounds, datetime_utc: data.datetime_utc,
                        satellite: data.satellite || '', tb_vmin: data.tb_vmin || 160.0, tb_vmax: data.tb_vmax || 330.0,
                        center_fix: data.center_fix || null,
                    };
                    irDone++;
                    if (stormId === currentStormId) {
                        buildValidIndices();
                        updateSliderMax();
                        // Show the first frame that arrives (frame 0 = oldest, fetched first)
                        if (irDone === 1) {
                            animIndex = idx;
                            hideLoader();
                            // Deferred: search for nearby NEXRAD sites
                            _satLoadRadarSites();
                        }
                        if (idx === 0) startBackfill();
                        renderBothPanels();
                        updateAnimUI();
                    }
                    updateStatus();
                })
                .catch(function () {
                    if (!retry && stormId === currentStormId) {
                        // Retry once after 3 seconds
                        setTimeout(function () { fetchIRFrame(idx, true); }, 3000);
                    } else {
                        irFail++; irDone++; updateStatus();
                        if (idx === 0) startBackfill();
                    }
                })
                .finally(function () {
                    // Chain next frame in this concurrency slot
                    // (frame 0 doesn't chain — backfill handles the rest)
                    if (idx > 0) {
                        var next = idx + FETCH_CONCURRENCY;
                        if (next < totalFrames) fetchIRFrame(next);
                    }
                    if (irDone >= totalFrames && stormId === currentStormId) {
                        buildValidIndices();
                        updateSliderMax();
                        // Show oldest frame (index 0) after loading — animation plays forward in time
                        if (validFrameIndices.length > 0) {
                            animIndex = validFrameIndices[0];
                        }
                        renderBothPanels();
                        updateAnimUI();
                        // Cache IR frames independently
                        if (!frameCache[stormId]) frameCache[stormId] = { ts: Date.now() };
                        frameCache[stormId].ir = irFrames.slice();
                        frameCache[stormId].ts = Date.now();
                    }
                });
        }

        function fetchRightFrame(idx, retry) {
            if (idx >= totalFrames || stormId !== currentStormId) return;
            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/band-raw-frame'
                + '?band=' + rightBand + '&frame_index=' + idx + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;

            fetch(url, { cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (data) {
                    if (data.total_frames) totalFrames = data.total_frames;
                    rightFrames[idx] = {
                        tb_data: decodeTbData(data.tb_data), rows: data.tb_rows, cols: data.tb_cols,
                        bounds: data.bounds, datetime_utc: data.datetime_utc,
                        satellite: data.satellite || '', tb_vmin: data.tb_vmin, tb_vmax: data.tb_vmax,
                        data_type: data.data_type || rightDataType
                    };
                    rightDone++;
                    if (stormId === currentStormId) renderBothPanels();
                    updateStatus();
                })
                .catch(function () {
                    if (!retry && stormId === currentStormId) {
                        setTimeout(function () { fetchRightFrame(idx, true); }, 3000);
                    } else {
                        rightFail++; rightDone++; updateStatus();
                    }
                })
                .finally(function () {
                    var next = idx + FETCH_CONCURRENCY;
                    if (next < totalFrames) fetchRightFrame(next);
                    if (rightDone >= totalFrames && stormId === currentStormId) {
                        renderBothPanels();
                    }
                    // Cache right frames when done
                    if (rightDone >= totalFrames && stormId === currentStormId) {
                        if (!frameCache[stormId]) frameCache[stormId] = { ts: Date.now() };
                        frameCache[stormId].right = rightFrames.slice();
                        frameCache[stormId].rightBand = rightBand;
                        frameCache[stormId].ts = Date.now();
                    }
                });
        }

        // Try to reuse frames from the RT Monitor cache.
        // If not ready, register a callback AND start fetching frame 0
        // independently for fast first-frame display. Whichever source
        // completes all frames first wins.
        var _rtCacheUsed = false;

        function _applyRtFrames(rtFrames) {
            if (_rtCacheUsed || stormId !== currentStormId) return;
            // Check that the newest frame is reasonably current (within 45 min)
            // to avoid reusing stale RT Monitor frames after auto-refresh
            if (rtFrames.length > 0) {
                var newest = rtFrames[rtFrames.length - 1] || rtFrames[0];
                if (newest && newest.datetime_utc) {
                    var ageMs = Date.now() - new Date(newest.datetime_utc).getTime();
                    if (ageMs > 45 * 60 * 1000) {
                        console.log('[Satellite] RT cache too stale (' + Math.round(ageMs / 60000) + ' min) — fetching fresh');
                        _fetchIndependently();
                        return;
                    }
                }
            }
            _rtCacheUsed = true;
            console.log('[Satellite] Reusing ' + rtFrames.length + ' frames from RT Monitor cache');
            for (var ri = 0; ri < rtFrames.length; ri++) {
                var rf = rtFrames[ri];
                if (!rf) continue;
                // Preserve any previewImg that arrived earlier — without
                // this, the fast-default JPG path can't kick in once raw
                // Tb lands from the RT callback.
                var prevImg = (irFrames[ri] && irFrames[ri].previewImg) || null;
                irFrames[ri] = {
                    previewImg: prevImg,
                    tb_data: (rf.tb_data instanceof Uint8Array) ? rf.tb_data : decodeTbData(rf.tb_data),
                    rows: rf.rows || rf.tb_rows, cols: rf.cols || rf.tb_cols,
                    bounds: rf.bounds, datetime_utc: rf.datetime_utc,
                    satellite: rf.satellite || '', tb_vmin: rf.tb_vmin || 160.0, tb_vmax: rf.tb_vmax || 330.0,
                    center_fix: rf.center_fix || null
                };
                irDone++;
            }
            totalFrames = Math.max(totalFrames, rtFrames.length);
            buildValidIndices();
            updateSliderMax();
            animIndex = 0;
            hideLoader();
            renderBothPanels();
            updateAnimUI();
            updateStatus();
            if (!frameCache[stormId]) frameCache[stormId] = { ts: Date.now() };
            frameCache[stormId].ir = irFrames.slice();
            frameCache[stormId].ts = Date.now();
            _tryRtBandCache(stormId);
        }

        function _tryRtCache() {
            if (stormId !== currentStormId) return;
            // Check if already cached
            if (window.getRtRawTbFrames) {
                var rtFrames = window.getRtRawTbFrames(stormId);
                if (rtFrames && rtFrames.length > 0) {
                    _applyRtFrames(rtFrames);
                    // Kick off JPG previews in parallel so the default
                    // colormap can use the fast drawImage path instead
                    // of LUT-painting raw Tb. Cheap (~60 KB each, fully
                    // cached server-side) and decouples the default
                    // view from the slow LUT path entirely.
                    _fetchPreviewFrames();
                    return;
                }
            }
            // Not ready — register callback for when RT Monitor finishes,
            // and start independent fetch in parallel for fast first frame.
            if (window.onRtRawTbReady) {
                window.onRtRawTbReady(stormId, function (rtFrames) {
                    if (!_rtCacheUsed && stormId === currentStormId && rtFrames && rtFrames.length > 0) {
                        _applyRtFrames(rtFrames);
                    }
                });
            }
            console.log('[Satellite] RT cache not ready, fetching independently + waiting for RT callback');
            _fetchIndependently();
        }
        var _backfillStarted = false;
        function startBackfill() {
            if (_backfillStarted) return;
            _backfillStarted = true;
            var backfillCount = Math.min(FETCH_CONCURRENCY + 1, totalFrames);
            console.log('[Satellite] startBackfill: frames 1-' + (backfillCount - 1) + ' of ' + totalFrames);
            for (var i = 1; i < backfillCount; i++) {
                fetchIRFrame(i);
            }
        }

        function _fetchIndependently() {
            // Phase 1: fast JPG preview for all frames
            _fetchPreviewFrames();
        }

        /**
         * Fetch pre-rendered JPGs from /ir-frame.jpg for instant preview.
         * Once first preview loads, show it immediately. After all previews
         * load, kick off raw Tb backfill for hover/diagnostics/colormaps.
         */
        function _fetchPreviewFrames() {
            _previewPhase = true;
            _previewDone = 0;
            _rawTbStarted = false;
            var _firstPreviewShown = false;
            var previewTotal = totalFrames;
            console.log('[Satellite] Fetching ' + previewTotal + ' preview JPGs for ' + stormId);

            // Bundle-first: same pattern as the band path. One request
            // returns all 25 WebPs packed; fall through to per-frame
            // waterfall on bundle failure.
            _satTryIrFramesBundleThen(stormId, function (ok, parsed) {
                if (!ok) {
                    console.log('[Satellite] IR frames bundle unavailable; per-frame fallback');
                    _fetchPreviewFramesLegacy(previewTotal, _firstPreviewShown);
                    return;
                }
                if (stormId !== currentStormId) return;
                for (var i = 0; i < parsed.frames.length; i++) {
                    var p = parsed.frames[i];
                    if (!irFrames[p.index] || !irFrames[p.index].tb_data) {
                        irFrames[p.index] = {
                            previewImg: p.img,
                            tb_data: null,
                            rows: p.img.naturalHeight,
                            cols: p.img.naturalWidth,
                            bounds: p.bounds,
                            datetime_utc: p.datetime_utc,
                            satellite: p.satellite,
                            tb_vmin: 160.0, tb_vmax: 330.0,
                            // center_fix from display-bundle header so
                            // follow-storm works from frame 1 — no longer
                            // needs to wait for raw Tb to arrive.
                            center_fix: p.center_fix || null
                        };
                    } else {
                        irFrames[p.index].previewImg = p.img;
                        // Backfill center_fix if raw arrived first w/o it
                        if (!irFrames[p.index].center_fix && p.center_fix) {
                            irFrames[p.index].center_fix = p.center_fix;
                        }
                    }
                }
                _previewDone = parsed.frames.length;
                if (parsed.total) previewTotal = parsed.total;
                buildValidIndices();
                updateSliderMax();
                if (validFrameIndices.length > 0) {
                    animIndex = validFrameIndices[0];
                }
                hideLoader();
                _satLoadRadarSites();
                renderBothPanels();
                updateAnimUI();
                if (loadStatusEl) loadStatusEl.textContent = '';
                console.log('[Satellite] IR frames bundle: ' + parsed.frames.length +
                            '/' + parsed.total + ' previews loaded');
            });
            return;
        }

        /** IR display bundle parser — mirrors _satTryBandBundleThen but
         *  fetches /ir-frames-bundle (no band param). Returns to caller
         *  via done(true, { frames: [{index, img, bounds, ...}], total }). */
        function _satTryIrFramesBundleThen(sid, done) {
            var apiUrl = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(sid)
                + '/ir-frames-bundle?lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG
                + '&interval_min=' + FRAME_INTERVAL_MIN;
            var gcsUrl = 'https://storage.googleapis.com/tc-atlas-ir-cache/rt-v10/bundles/frames/'
                + encodeURIComponent(sid.toUpperCase()) + '.bin';
            fetch(gcsUrl)
                .then(function (r) {
                    if (!r.ok) throw new Error('gcs ir bundle HTTP ' + r.status);
                    return r.arrayBuffer();
                })
                .catch(function () {
                    return fetch(apiUrl).then(function (r) {
                        if (!r.ok) throw new Error('api ir bundle HTTP ' + r.status);
                        return r.arrayBuffer();
                    });
                })
                .then(function (buf) {
                    try {
                        var dv = new DataView(buf);
                        if (buf.byteLength < 4) throw new Error('bundle too small');
                        var hl = dv.getUint32(0, true);
                        if (4 + hl > buf.byteLength) throw new Error('bundle header overrun');
                        var header = JSON.parse(new TextDecoder('utf-8')
                            .decode(new Uint8Array(buf, 4, hl)));
                        var bin = 4 + hl;
                        var mediaType = header.media_type || 'image/webp';
                        var hdrFrames = header.frames || [];
                        var pending = 0, out = [], settled = false;
                        function maybeFinish() {
                            if (settled) return;
                            if (pending === 0) {
                                settled = true;
                                done(true, { frames: out, total: header.total_frames });
                            }
                        }
                        for (var i = 0; i < hdrFrames.length; i++) {
                            var f = hdrFrames[i];
                            if (!f.byte_length || f.error) continue;
                            var slice = new Uint8Array(buf, bin + f.byte_offset, f.byte_length);
                            var blob = new Blob([slice], { type: mediaType });
                            var url = URL.createObjectURL(blob);
                            pending++;
                            (function (fHdr) {
                                var img = new Image();
                                img.onload = function () {
                                    out.push({
                                        index: fHdr.index,
                                        img: img,
                                        bounds: fHdr.bounds,
                                        // center_fix lets follow-storm
                                        // recenter on the IR-derived eye
                                        // from the moment the display
                                        // bundle lands (server reads it
                                        // from the raw Tb cache).
                                        center_fix: fHdr.center_fix || null,
                                        datetime_utc: fHdr.datetime_utc || '',
                                        satellite: fHdr.satellite || ''
                                    });
                                    pending--;
                                    maybeFinish();
                                };
                                img.onerror = function () {
                                    pending--;
                                    maybeFinish();
                                };
                                img.src = url;
                            })(f);
                        }
                        if (pending === 0) done(false, null);
                    } catch (e) {
                        console.warn('[Satellite] IR bundle parse failed:', e.message);
                        done(false, null);
                    }
                })
                .catch(function (err) {
                    console.warn('[Satellite] IR bundle fetch failed:', err && err.message);
                    done(false, null);
                });
        }

        /** Per-frame IR preview waterfall — kept as bundle-failure fallback */
        function _fetchPreviewFramesLegacy(previewTotal, _firstPreviewShown) {
            function fetchPreview(idx) {
                if (idx >= previewTotal || stormId !== currentStormId) return;
                var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/ir-frame.jpg'
                    + '?frame_index=' + idx + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                    + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;

                fetch(url, { cache: 'no-store' })
                    .then(function (r) {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        var hdrs = r.headers;
                        var meta = {
                            datetime_utc: (hdrs.get('X-Datetime') || '').replace('Z', 'Z'),
                            satellite: hdrs.get('X-Satellite') || '',
                            bounds: null
                        };
                        try { meta.bounds = JSON.parse(hdrs.get('X-Bounds')); } catch (e) {}
                        var ft = hdrs.get('X-Total-Frames');
                        if (ft) previewTotal = parseInt(ft, 10) || previewTotal;
                        return r.blob().then(function (blob) { return { blob: blob, meta: meta }; });
                    })
                    .then(function (result) {
                        if (stormId !== currentStormId) return;
                        var img = new Image();
                        img.onload = function () {
                            // Only populate if raw Tb hasn't already arrived for this index
                            if (!irFrames[idx] || !irFrames[idx].tb_data) {
                                irFrames[idx] = {
                                    previewImg: img,
                                    tb_data: null,
                                    rows: img.naturalHeight,
                                    cols: img.naturalWidth,
                                    bounds: result.meta.bounds,
                                    datetime_utc: result.meta.datetime_utc,
                                    satellite: result.meta.satellite,
                                    tb_vmin: 160.0, tb_vmax: 330.0,
                                    center_fix: null
                                };
                            } else {
                                // Raw Tb already arrived — attach preview for potential fallback
                                irFrames[idx].previewImg = img;
                            }
                            _previewDone++;
                            buildValidIndices();
                            updateSliderMax();

                            // Show first successful preview immediately
                            if (!_firstPreviewShown) {
                                _firstPreviewShown = true;
                                animIndex = idx;
                                hideLoader();
                                _satLoadRadarSites();
                            }
                            renderBothPanels();
                            updateAnimUI();

                            if (loadStatusEl) {
                                loadStatusEl.textContent = _previewPhase
                                    ? 'Preview ' + _previewDone + '/' + previewTotal
                                    : '';
                            }

                            // All previews done. Raw Tb backfill is NO
                            // LONGER fired automatically — it's now lazy,
                            // triggered by user actions that actually
                            // need raw Tb (colormap change, hover, or
                            // Asymmetry mode entry). See
                            // _satEnsureRawTbLoaded(). Saves 2-4 MB per
                            // storm-open in the common case where the
                            // user never switches off the default
                            // colormap.
                            if (_previewDone >= previewTotal && _previewPhase) {
                                _previewPhase = false;
                                console.log('[Satellite] All previews loaded — raw Tb deferred until needed');
                            }
                        };
                        img.src = URL.createObjectURL(result.blob);
                    })
                    .catch(function () {
                        _previewDone++;
                        // If preview fails, fall back to raw Tb for this frame
                        if (!irFrames[idx]) fetchIRFrame(idx);
                        // Hide loader even on failure — raw Tb fallback will render
                        if (!loader.classList.contains('hidden')) hideLoader();
                        if (_previewDone >= previewTotal && _previewPhase) {
                            _previewPhase = false;
                        }
                    })
                    .finally(function () {
                        var next = idx + FETCH_CONCURRENCY;
                        if (next < previewTotal) fetchPreview(next);
                    });
            }

            // Launch concurrent preview fetches
            var c = Math.min(FETCH_CONCURRENCY, previewTotal);
            for (var i = 0; i < c; i++) fetchPreview(i);
        }

        // ── Bundle path (Option A — mobile colormap unlock) ────────
        // Tries the binary /ir-raw-bundle endpoint, with direct-GCS try
        // first (prewarmed) then API fallback. One request instead of
        // N — big win on cellular where each /ir-raw-frame call costs
        // 100-300 ms of TLS+routing.
        var _GCS_RAW_BUNDLE_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/rt-v10/bundles/raw';
        function _satTryRawTbBundleThen(sid, done) {
            var apiUrl = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(sid)
                + '/ir-raw-bundle?lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG
                + '&interval_min=' + FRAME_INTERVAL_MIN;
            var gcsUrl = _GCS_RAW_BUNDLE_BASE + '/' + encodeURIComponent(sid.toUpperCase()) + '.bin';
            fetch(gcsUrl)
                .then(function (r) {
                    if (!r.ok) throw new Error('gcs raw bundle HTTP ' + r.status);
                    return r.arrayBuffer();
                })
                .catch(function () {
                    return fetch(apiUrl).then(function (r) {
                        if (!r.ok) throw new Error('api raw bundle HTTP ' + r.status);
                        return r.arrayBuffer();
                    });
                })
                .then(function (buf) {
                    if (sid !== currentStormId) { done(false); return; }
                    try {
                        var dv = new DataView(buf);
                        if (buf.byteLength < 4) throw new Error('bundle too small');
                        var hl = dv.getUint32(0, true);
                        if (4 + hl > buf.byteLength) throw new Error('bundle header overrun');
                        var header = JSON.parse(new TextDecoder('utf-8')
                            .decode(new Uint8Array(buf, 4, hl)));
                        var bin = 4 + hl;
                        var ok = 0;
                        var hdrFrames = header.frames || [];
                        if (header.total_frames) totalFrames = header.total_frames;
                        for (var i = 0; i < hdrFrames.length; i++) {
                            var f = hdrFrames[i];
                            if (!f.byte_length || f.error) continue;
                            var tb = new Uint8Array(buf, bin + f.byte_offset, f.byte_length);
                            var existing = irFrames[f.index] || {};
                            irFrames[f.index] = {
                                previewImg: existing.previewImg || null,
                                tb_data: tb,
                                rows: f.tb_rows,
                                cols: f.tb_cols,
                                bounds: f.bounds,
                                datetime_utc: f.datetime_utc || '',
                                satellite: f.satellite || '',
                                tb_vmin: header.tb_vmin || 160.0,
                                tb_vmax: header.tb_vmax || 330.0,
                                center_fix: f.center_fix || null
                            };
                            ok++;
                        }
                        irDone = ok;
                        buildValidIndices();
                        updateSliderMax();
                        if (validFrameIndices.length > 0) {
                            animIndex = validFrameIndices[0];
                        }
                        renderBothPanels();
                        updateAnimUI();
                        if (loadStatusEl) loadStatusEl.textContent = '';
                        if (!frameCache[sid]) frameCache[sid] = { ts: Date.now() };
                        frameCache[sid].ir = irFrames.slice();
                        frameCache[sid].ts = Date.now();
                        console.log('[Satellite] Raw Tb bundle: ' + ok + '/' +
                                    hdrFrames.length + ' frames loaded');
                        done(true);
                    } catch (e) {
                        console.warn('[Satellite] Bundle parse failed:', e.message);
                        done(false);
                    }
                })
                .catch(function (err) {
                    console.warn('[Satellite] Raw Tb bundle fetch failed:', err && err.message);
                    done(false);
                });
        }

        /**
         * Start raw Tb backfill for all frames. No longer fired
         * automatically by the preview-finish handler — invoked
         * on-demand from window._satEnsureRawTbLoaded (colormap
         * change, hover, asymmetry-enter).
         *
         * Tries the binary /ir-raw-bundle endpoint first (one request,
         * ~5 MB packed binary, ~1-2 s on cellular). On any failure falls
         * back to the per-frame waterfall below. The bundle path is a
         * major win on mobile where each /ir-raw-frame JSON costs
         * 100-300 ms of TLS+routing overhead — 13 of those over LTE
         * totals 1.3-4 s of overhead alone. Bundle collapses that to
         * one round-trip.
         */
        function _startRawTbBackfill() {
            if (loadStatusEl) loadStatusEl.textContent = 'Loading Tb data...';
            // Bundle attempt first; only fall through to the per-frame
            // waterfall on failure (404 if backend not yet redeployed,
            // parse error, network).
            _satTryRawTbBundleThen(stormId, function (ok) {
                if (ok) return;
                console.log('[Satellite] Bundle path unavailable; using per-frame waterfall');
                _startRawTbBackfillLegacy();
            });
        }

        function _startRawTbBackfillLegacy() {
            var tbDone = 0;
            for (var i = 0; i < Math.min(FETCH_CONCURRENCY, totalFrames); i++) {
                _fetchRawTb(i);
            }

            function _fetchRawTb(idx) {
                if (idx >= totalFrames || stormId !== currentStormId) return;
                var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/ir-raw-frame'
                    + '?frame_index=' + idx + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                    + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;

                fetch(url, { cache: 'no-store' })
                    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                    .then(function (data) {
                        if (stormId !== currentStormId) return;
                        if (data.total_frames) totalFrames = data.total_frames;
                        // Merge raw Tb into existing frame (preserve previewImg)
                        var existing = irFrames[idx] || {};
                        irFrames[idx] = {
                            previewImg: existing.previewImg || null,
                            tb_data: decodeTbData(data.tb_data),
                            rows: data.tb_rows,
                            cols: data.tb_cols,
                            bounds: data.bounds,
                            datetime_utc: data.datetime_utc,
                            satellite: data.satellite || '',
                            tb_vmin: data.tb_vmin || 160.0,
                            tb_vmax: data.tb_vmax || 330.0,
                            center_fix: data.center_fix || null
                        };
                        tbDone++;
                        irDone = tbDone;
                        buildValidIndices();
                        updateSliderMax();
                        renderBothPanels();
                        updateAnimUI();
                        if (loadStatusEl) loadStatusEl.textContent = 'IR ' + tbDone + '/' + totalFrames;
                    })
                    .catch(function () {
                        tbDone++;
                        irDone = tbDone;
                    })
                    .finally(function () {
                        var next = idx + FETCH_CONCURRENCY;
                        if (next < totalFrames) _fetchRawTb(next);
                        if (tbDone >= totalFrames && stormId === currentStormId) {
                            if (loadStatusEl) loadStatusEl.textContent = '';
                            buildValidIndices();
                            updateSliderMax();
                            if (validFrameIndices.length > 0) {
                                animIndex = validFrameIndices[0];
                            }
                            renderBothPanels();
                            updateAnimUI();
                            if (!frameCache[stormId]) frameCache[stormId] = { ts: Date.now() };
                            frameCache[stormId].ir = irFrames.slice();
                            frameCache[stormId].ts = Date.now();
                        }
                    });
            }
        }

        // Start: try RT cache first, fall back to preview + raw Tb
        // Stash the closure-scoped raw-Tb starter on the outer hook so
        // window._satEnsureRawTbLoaded can fire it on demand (colormap
        // change, hover, asymmetry mode entry). Previously the backfill
        // ran automatically after previews; now it's gated by user
        // actions that actually need raw Tb.
        _satPendingRawTbTrigger = _startRawTbBackfill;

        _tryRtCache();
    }

    // ── Animation ───────────────────────────────────────────────

    function showFrame(idx) {
        if (!irFrames[idx]) return;
        animIndex = idx;
        renderBothPanels();
        updateAnimUI();
        _satRadarFrameSync();
    }
    function nextFrame() {
        if (validFrameIndices.length === 0) return;
        var pos = validFrameIndices.indexOf(animIndex);
        var next = (pos + 1) % validFrameIndices.length;
        showFrame(validFrameIndices[next]);
    }
    function prevFrame() {
        if (validFrameIndices.length === 0) return;
        var pos = validFrameIndices.indexOf(animIndex);
        var prev = (pos - 1 + validFrameIndices.length) % validFrameIndices.length;
        showFrame(validFrameIndices[prev]);
    }

    function animTick(ts) {
        if (!animPlaying) return;
        if (ts - animLastTick >= ANIM_SPEEDS[animSpeedIdx].ms) { animLastTick = ts; nextFrame(); }
        animTimer = requestAnimationFrame(animTick);
    }
    function startAnimation() { if (validFrameIndices.length < 2) return; animPlaying = true; _ga('sat_animation_play'); animLastTick = 0; animTimer = requestAnimationFrame(animTick); updatePlayBtn(); }
    function stopAnimation() { animPlaying = false; if (animTimer) cancelAnimationFrame(animTimer); animTimer = null; updatePlayBtn(); }
    function toggleAnimation() { if (animPlaying) stopAnimation(); else startAnimation(); }
    function cycleSpeed() { animSpeedIdx = (animSpeedIdx + 1) % ANIM_SPEEDS.length; if (speedBtn) speedBtn.textContent = ANIM_SPEEDS[animSpeedIdx].label; }

    // ── UI Updates ──────────────────────────────────────────────

    function updateAnimUI() {
        var frame = irFrames[animIndex];
        var pos = validFrameIndices.indexOf(animIndex);
        if (frameCounterEl) frameCounterEl.textContent = (pos >= 0 ? (pos + 1) : 0) + ' / ' + validFrameIndices.length;
        var timeStr = '';
        if (frame && frame.datetime_utc) {
            timeStr = frame.datetime_utc.replace('T', ' ').replace(/:\d{2}Z$/, ' UTC').replace('Z', ' UTC');
        }
        if (timestampEl) timestampEl.textContent = timeStr;
        if (frame && satelliteEl) satelliteEl.textContent = frame.satellite || '';
        if (sliderEl) sliderEl.value = pos >= 0 ? pos : 0;
    }
    function updateSliderMax() { if (sliderEl) sliderEl.max = Math.max(0, validFrameIndices.length - 1); }
    function updatePlayBtn() {
        if (!playBtn) return;
        playBtn.textContent = animPlaying ? '\u23F8' : '\u25B6';
        playBtn.title = animPlaying ? 'Pause (Space)' : 'Play (Space)';
    }
    function showLoader(msg) { if (loader) loader.classList.remove('hidden'); if (loaderMsg) loaderMsg.textContent = msg || 'Loading\u2026'; }
    function hideLoader() { if (loader) loader.classList.add('hidden'); }
    function showNoStorms() { hideLoader(); if (noStormsEl) noStormsEl.style.display = 'flex'; }

    // ── Hover Readout ───────────────────────────────────────────

    function handleHover(e, panelFrames, dataType) {
        if (hoverThrottled || panelFrames.length === 0) return;
        hoverThrottled = true;
        setTimeout(function () { hoverThrottled = false; }, 40);

        var frame = panelFrames[animIndex];
        if (!frame || !frame.tb_data || !frame.bounds) { tooltip.style.display = 'none'; return; }

        var canvas = e.target;
        var rect = canvas.getBoundingClientRect();
        var cx = (e.clientX - rect.left) / rect.width;
        var cy = (e.clientY - rect.top) / rect.height;

        var vb = getViewBounds(frame);
        if (!vb) return;
        var lat = vb.north - cy * (vb.north - vb.south);
        var lon = vb.west + cx * (vb.east - vb.west);

        var b = frame.bounds;
        var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
        var fracY = (north - lat) / (north - south);
        var fracX = (lon - west) / (east - west);
        var row = Math.min(Math.floor(fracY * frame.rows), frame.rows - 1);
        var col = Math.min(Math.floor(fracX * frame.cols), frame.cols - 1);
        if (row < 0 || col < 0 || row >= frame.rows || col >= frame.cols) { tooltip.style.display = 'none'; return; }

        var rawVal = frame.tb_data[row * frame.cols + col];
        // Search neighbors if gap
        if (rawVal === 0) {
            for (var sr = 1; sr <= 3 && rawVal === 0; sr++) {
                for (var dy = -sr; dy <= sr && rawVal === 0; dy++) {
                    for (var dx = -sr; dx <= sr && rawVal === 0; dx++) {
                        if (Math.abs(dy) !== sr && Math.abs(dx) !== sr) continue;
                        var nr = row + dy, nc = col + dx;
                        if (nr >= 0 && nr < frame.rows && nc >= 0 && nc < frame.cols) {
                            var nv = frame.tb_data[nr * frame.cols + nc];
                            if (nv > 0) rawVal = nv;
                        }
                    }
                }
            }
        }
        if (rawVal === 0) { tooltip.style.display = 'none'; return; }

        var vmin = frame.tb_vmin || 160.0, vmax = frame.tb_vmax || 330.0;
        var decoded = vmin + (rawVal - 1) * (vmax - vmin) / 254.0;
        var latStr = Math.abs(lat).toFixed(2) + (lat >= 0 ? '\u00B0N' : '\u00B0S');
        var lonStr = Math.abs(lon).toFixed(2) + (lon >= 0 ? '\u00B0E' : '\u00B0W');

        var valHtml;
        var dt = dataType || frame.data_type || 'tb';
        if (dt === 'reflectance') {
            var pct = (decoded * 100).toFixed(1);
            valHtml = '<span class="sat-tb-val">' + pct + '%</span>';
        } else {
            var tbC = (decoded - 273.15).toFixed(1);
            valHtml = '<span class="sat-tb-val">' + decoded.toFixed(1) + ' K</span>' +
                '<span class="sat-tb-sep"> / </span><span class="sat-tb-val">' + tbC + ' \u00B0C</span>';
        }

        // Append 88D radar readout if available
        var radarHtml = '';
        if (showRadar && _satRadarData && _satRadarBounds) {
            var rb = _satRadarBounds;
            var rS = rb[0][0], rW = rb[0][1], rN = rb[1][0], rE = rb[1][1];
            if (lat >= rS && lat <= rN && lon >= rW && lon <= rE) {
                var rfY = (rN - lat) / (rN - rS);
                var rfX = (lon - rW) / (rE - rW);
                var rRow = Math.min(Math.floor(rfY * _satRadarRows), _satRadarRows - 1);
                var rCol = Math.min(Math.floor(rfX * _satRadarCols), _satRadarCols - 1);
                var rv = _satRadarData[rRow * _satRadarCols + rCol];
                if (rv > 0) {
                    var rVal = _satRadarVmin + (rv - 1) * (_satRadarVmax - _satRadarVmin) / 254.0;
                    // Compute beam height using 4/3 Earth radius refraction model
                    var beamStr = '';
                    if (_satRadarSiteLat != null && _satRadarSiteLon != null) {
                        var distKm = _haversineKm(_satRadarSiteLat, _satRadarSiteLon, lat, lon);
                        var beamHt = _beamHeightKm(distKm, _satRadarTilt);
                        if (beamHt < 1) {
                            beamStr = ' ' + (beamHt * 1000).toFixed(0) + 'm ARL';
                        } else {
                            beamStr = ' ' + beamHt.toFixed(1) + 'km ARL';
                        }
                    }
                    radarHtml = '<span class="sat-tb-sep"> &nbsp; </span>' +
                        '<span class="sat-tb-val" style="color:#86efac;">' + rVal.toFixed(1) + ' ' + _satRadarUnits + beamStr + '</span>';
                }
            }
        }

        // If the cursor is near the IR-center-fix crosshair, append the
        // g1/g2/g3 quality gate diagnostics (same format as Global Archive).
        var gateHtml = '';
        var _fix = frame.center_fix;
        if (_fix && _fix.lat != null && _fix.lon != null && _fix.gates) {
            var _fxCss = (_fix.lon - vb.west) / (vb.east - vb.west) * rect.width;
            var _fyCss = (vb.north - _fix.lat) / (vb.north - vb.south) * rect.height;
            var _dx = (e.clientX - rect.left) - _fxCss;
            var _dy = (e.clientY - rect.top) - _fyCss;
            if (_dx * _dx + _dy * _dy <= 24 * 24) {
                var _g = _fix.gates;
                if (_g.g1_rad_dif != null || _g.g2_std_ratio != null) {
                    var _g1Pass = _g.g1_rad_dif >= 15;
                    var _g2Pass = _g.g2_std_ratio < 0.7;
                    var _g3Pass = _g.g3_diff != null && _g.g3_diff <= 7;
                    gateHtml = '<br><span style="font-size:10px;color:#94a3b8;">' +
                        (_g1Pass ? '\u2713' : '\u2717') + ' \u0394T=' + _g.g1_rad_dif + 'K (\u226515)' +
                        '<br>' + (_g2Pass ? '\u2713' : '\u2717') + ' \u03C3 ratio=' + _g.g2_std_ratio + ' (<0.7)' +
                        '<br>' + (_g3Pass ? '\u2713' : '\u2717') + ' Ring=' + _g.g3_ring_C + '\u00B0C, P1=' +
                        (_g.g3_p1_C != null ? _g.g3_p1_C : '?') + '\u00B0C (\u0394' +
                        (_g.g3_diff != null ? _g.g3_diff : '?') + '\u22647)' +
                        '</span>';
                }
            }
        }

        tooltip.innerHTML = valHtml + radarHtml +
            '<span class="sat-tb-sep"> &nbsp; </span>' +
            '<span class="sat-tb-coord">' + latStr + ', ' + lonStr + '</span>' +
            gateHtml;

        var wrapRect = document.getElementById('sat-canvas-wrap').getBoundingClientRect();
        var tx = e.clientX - wrapRect.left + 16;
        var ty = e.clientY - wrapRect.top - 28;
        var tw = tooltip.offsetWidth || 200;
        if (tx + tw > wrapRect.width - 8) tx = e.clientX - wrapRect.left - tw - 8;
        if (ty < 4) ty = e.clientY - wrapRect.top + 16;
        tooltip.style.left = tx + 'px';
        tooltip.style.top = ty + 'px';
        tooltip.style.display = 'block';
    }

    function handleMouseOut() { tooltip.style.display = 'none'; }

    // ── Deep Link ───────────────────────────────────────────────

    function getHashStorm() { var m = window.location.hash.match(/storm=([A-Za-z0-9]+)/); return m ? m[1] : null; }
    function getHashView() { return window.location.hash.indexOf('view=satellite') !== -1; }
    function updateHash(stormId) {
        if (stormId) history.replaceState(null, '', '#storm=' + stormId + '&view=satellite');
    }

    // ── Event Binding ───────────────────────────────────────────

    function bindEvents() {
        document.getElementById('sat-prev').addEventListener('click', function () { stopAnimation(); prevFrame(); });
        document.getElementById('sat-next').addEventListener('click', function () { stopAnimation(); nextFrame(); });
        playBtn.addEventListener('click', toggleAnimation);
        speedBtn.addEventListener('click', cycleSpeed);
        sliderEl.addEventListener('input', function () {
            stopAnimation();
            var pos = parseInt(this.value, 10);
            if (pos >= 0 && pos < validFrameIndices.length) showFrame(validFrameIndices[pos]);
        });

        document.getElementById('sat-colormap-select').addEventListener('change', function () {
            selectedColormap = this.value;
            // Custom colormaps need raw Tb to bake the per-frame
            // blob overlays. Trigger lazy backfill now (no-op if
            // already running or already done).
            if (selectedColormap !== 'claude-ir'
                    && typeof window._satEnsureRawTbLoaded === 'function') {
                window._satEnsureRawTbLoaded();
            }
            renderBothPanels();
            _ga('sat_colormap', { colormap: selectedColormap });
        });

        // Right-panel colormap
        var rightCmapEl = document.getElementById('sat-right-cmap-select');
        if (rightCmapEl) {
            rightCmapEl.addEventListener('change', function () {
                rightColormapName = this.value;
                renderBothPanels();
            });
        }

        // Crosshair toggle
        var crosshairEl = document.getElementById('sat-crosshair-toggle');
        if (crosshairEl) {
            crosshairEl.addEventListener('change', function () {
                showCrosshair = this.checked;
                // Redraw overlays only (fast — no need to re-render satellite data)
                var irFrame = irFrames[animIndex];
                if (irFrame) drawOverlay(overlayIR, overlayCtxIR, irFrame);
                if (viewMode === 'compare-wv' || viewMode === 'compare-vis') {
                    var rf = rightFrames[animIndex];
                    if (rf) drawOverlay(overlayRight, overlayCtxRight, rf);
                } else if (viewMode === 'asymmetry') {
                    if (irFrame) drawOverlay(overlayAsym, overlayCtxAsym, irFrame);
                }
            });
        }

        // Follow storm toggle
        var followEl = document.getElementById('sat-follow-toggle');
        if (followEl) {
            followEl.addEventListener('change', function () {
                followCenter = this.checked;
                renderBothPanels();
            });
        }

        // Diagnostics tab toggle (Charts / Hovmoller)
        var diagTabs = document.querySelectorAll('.sat-diag-tab');
        for (var dt = 0; dt < diagTabs.length; dt++) {
            diagTabs[dt].addEventListener('click', function () {
                var newTab = this.getAttribute('data-tab');
                if (newTab === diagTab) return;
                diagTab = newTab;
                for (var dj = 0; dj < diagTabs.length; dj++) {
                    diagTabs[dj].classList.toggle('active', diagTabs[dj].getAttribute('data-tab') === newTab);
                }
                // Immediately toggle view visibility
                var chartsView = document.getElementById('sat-diag-charts');
                var hovView = document.getElementById('sat-diag-hovmoller');
                if (chartsView) chartsView.style.display = newTab === 'charts' ? '' : 'none';
                if (hovView) hovView.style.display = newTab === 'hovmoller' ? '' : 'none';
                // Render and resize after switching
                setTimeout(function () {
                    renderDiagnostics();
                    var hovDiv = document.getElementById('sat-diag-hovmoller-chart');
                    if (hovDiv && hovDiv.data) Plotly.Plots.resize(hovDiv);
                }, 50);
            });
        }

        // Hovmoller lookback toggle (6h / 12h / 24h)
        var hovBtns = document.querySelectorAll('.sat-hov-lookback-btn');
        for (var hi = 0; hi < hovBtns.length; hi++) {
            hovBtns[hi].addEventListener('click', function () {
                var hours = parseInt(this.getAttribute('data-hours'), 10);
                if (hours === hovLookbackHours) return;
                hovLookbackHours = hours;
                for (var hj = 0; hj < hovBtns.length; hj++) {
                    hovBtns[hj].classList.toggle('active', hovBtns[hj] === this);
                }
                if (hours <= 6) {
                    renderHovmollerChart();
                } else {
                    fetchHovmollerFromServer(hours);
                }
            });
        }

        // View mode toggle (Diagnostics / WV / Vis / MW / Track / Asym)
        var modeBtns = document.querySelectorAll('.sat-mode-btn');
        for (var mi = 0; mi < modeBtns.length; mi++) {
            modeBtns[mi].addEventListener('click', function () {
                setViewMode(this.getAttribute('data-mode'));
                // On mobile, the mode-toggle lives inside the off-
                // canvas sidebar drawer. Without auto-close the user
                // taps a mode and still sees the sidebar covering the
                // view they just selected — they have to remember to
                // close it manually, which feels broken. Close it for
                // them as soon as the mode lands.
                if (_satIsMobileLayout() && sidebar) {
                    sidebar.classList.remove('open');
                }
                // After a mobile layout shift (e.g. entering MW mode
                // switches from 1-pane to 2-pane stack), Leaflet
                // doesn't know its containers resized. Invalidate
                // every map's size on the next paint so storms stay
                // centered and tiles fill cleanly.
                if (_satIsMobileLayout()) {
                    setTimeout(function () {
                        if (_satMwLeafletIr) _satMwLeafletIr.invalidateSize(false);
                        if (_satMwLeafletMw) _satMwLeafletMw.invalidateSize(false);
                        if (_satRightLeafletMap) _satRightLeafletMap.invalidateSize(false);
                    }, 250);
                }
            });
        }

        // Save buttons (PNG + GIF)
        var saveBtn = document.getElementById('sat-save');
        if (saveBtn) saveBtn.addEventListener('click', saveImage);
        var gifBtn = document.getElementById('sat-save-gif');
        if (gifBtn) gifBtn.addEventListener('click', saveGif);

        // Zoom buttons (10°, 5°, 2°)
        var zoomBtns = document.querySelectorAll('.sat-zoom-btn');
        for (var zi = 0; zi < zoomBtns.length; zi++) {
            zoomBtns[zi].addEventListener('click', function () {
                zoomDeg = parseInt(this.getAttribute('data-deg'), 10);
                for (var zj = 0; zj < zoomBtns.length; zj++) {
                    zoomBtns[zj].classList.toggle('active', zoomBtns[zj] === this);
                }
                // Recenter the Leaflet IR map (and the MW pair when
                // MW mode is active) on the new zoomDeg extent before
                // letting renderBothPanels paint. fitBounds handles
                // the user-initiated jump cleanly without animation.
                if (typeof _satIrSyncLeaflet === 'function') {
                    _satIrSyncLeaflet({ recenter: true });
                }
                renderBothPanels();
            });
        }

        // Hover on both canvases
        if (canvasIR) {
            canvasIR.addEventListener('mousemove', function (e) { handleHover(e, irFrames, 'tb'); });
            canvasIR.addEventListener('mouseout', handleMouseOut);
        }
        if (canvasRight) {
            canvasRight.addEventListener('mousemove', function (e) { handleHover(e, rightFrames, rightDataType); });
            canvasRight.addEventListener('mouseout', handleMouseOut);
        }

        document.addEventListener('keydown', function (e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            switch (e.key) {
                case 'ArrowLeft': e.preventDefault(); stopAnimation(); prevFrame(); break;
                case 'ArrowRight': e.preventDefault(); stopAnimation(); nextFrame(); break;
                case ' ': e.preventDefault(); toggleAnimation(); break;
                case 'Escape':
                    if (window.innerWidth <= 768 && sidebar.classList.contains('open')) sidebar.classList.remove('open');
                    break;
            }
        });

        if (sidebarToggle) sidebarToggle.addEventListener('click', function () { sidebar.classList.add('open'); });
        if (sidebarClose) sidebarClose.addEventListener('click', function () { sidebar.classList.remove('open'); });
        // Click the dimmed backdrop to dismiss the sidebar — matches
        // the "tap outside" convention every mobile drawer uses. Without
        // this the sidebar can feel sticky when the user changes their
        // mind mid-tap.
        var sidebarBackdrop = document.getElementById('sat-sidebar-backdrop');
        if (sidebarBackdrop) {
            sidebarBackdrop.addEventListener('click', function () {
                if (sidebar) sidebar.classList.remove('open');
            });
        }

        window.addEventListener('hashchange', function () {
            var hashStorm = getHashStorm();
            if (hashStorm && hashStorm.toUpperCase() !== (currentStormId || '').toUpperCase()) {
                var target = storms.find(function (s) { return s.atcf_id.toUpperCase() === hashStorm.toUpperCase(); });
                if (target) selectStorm(target.atcf_id);
            }
        });
    }

    // ── Polling ─────────────────────────────────────────────────

    var _pollHiddenAt = 0;

    function _pollOnce() {
        var headers = {};
        if (_satActiveStormsETag) headers['If-None-Match'] = _satActiveStormsETag;
        fetch(API_BASE + '/ir-monitor/active-storms', { cache: 'no-store', headers: headers })
            .then(function (r) {
                if (r.status === 304) return null;
                if (!r.ok) return null;
                var et = r.headers.get('ETag');
                if (et) _satActiveStormsETag = et;
                return r.json();
            })
            .then(function (data) {
                if (!data) return;
                storms = (data.storms || []).slice();
                storms.sort(function (a, b) { return (b.vmax_kt || 0) - (a.vmax_kt || 0); });
                renderStormList();
                if (currentStormId) {
                    var updated = storms.find(function (s) { return s.atcf_id === currentStormId; });
                    if (updated && currentStorm) {
                        // Check if position shifted enough to warrant refetch
                        var dLat = Math.abs((updated.lat || 0) - (currentStorm.lat || 0));
                        var dLon = Math.abs((updated.lon || 0) - (currentStorm.lon || 0));
                        if (dLat > 0.3 || dLon > 0.3) {
                            console.log('[Satellite] Storm position shifted (' +
                                dLat.toFixed(1) + '\u00B0 lat, ' + dLon.toFixed(1) + '\u00B0 lon) — refetching frames');
                            currentStorm = updated;
                            irFrames = []; validFrameIndices = [];
                            if (viewMode !== 'diagnostics') rightFrames = [];
                            loadFrames(currentStormId);
                        } else {
                            currentStorm = updated;
                            // Auto-refresh frames to pick up newest imagery
                            console.log('[Satellite] Auto-refreshing frames for latest imagery');
                            irFrames = []; validFrameIndices = [];
                            if (viewMode !== 'diagnostics') rightFrames = [];
                            loadFrames(currentStormId);
                        }
                    } else if (updated) {
                        currentStorm = updated;
                    }
                }
            })
            .catch(function () {});
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(_pollOnce, POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            if (pollTimer) {
                _pollHiddenAt = Date.now();
                stopPolling();
            }
        } else {
            var awayMs = _pollHiddenAt ? Date.now() - _pollHiddenAt : 0;
            _pollHiddenAt = 0;
            if (awayMs > POLL_INTERVAL_MS / 2) _pollOnce();
            startPolling();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // ── 88D NEXRAD RADAR OVERLAY ─────────────────────────────────
    // ═══════════════════════════════════════════════════════════════

    /** Haversine distance in km between two lat/lon points. */
    function _haversineKm(lat1, lon1, lat2, lon2) {
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
     * distKm = ground range, tiltDeg = elevation angle in degrees.
     */
    function _beamHeightKm(distKm, tiltDeg) {
        var Re = 6371 * 4 / 3;  // effective Earth radius (standard refraction)
        var r = distKm;
        var theta = tiltDeg * Math.PI / 180;
        // h = sqrt(r² + Re² + 2·r·Re·sin(θ)) − Re
        return Math.sqrt(r * r + Re * Re + 2 * r * Re * Math.sin(theta)) - Re;
    }

    /**
     * Search for nearby NEXRAD sites for the current storm.
     */
    function _satLoadRadarSites() {
        if (!currentStorm || !currentStorm.lat || !currentStorm.lon) return;
        if (currentStormId === _satRadarLastStormId && _satRadarSites) return;
        _satRadarLastStormId = currentStormId;

        var statusEl = document.getElementById('sat-radar-status');
        var siteSelect = document.getElementById('sat-radar-site-select');
        if (!siteSelect) return;

        siteSelect.innerHTML = '<option value="">Searching...</option>';
        if (statusEl) statusEl.textContent = '';

        fetch(API_BASE + '/nexrad/sites?lat=' + currentStorm.lat + '&lon=' + currentStorm.lon + '&max_range_km=500', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                _satRadarSites = json;
                siteSelect.innerHTML = '';
                if (!json.sites || json.sites.length === 0) {
                    siteSelect.innerHTML = '<option value="">No nearby radars</option>';
                    if (statusEl) statusEl.textContent = 'No 88D coverage';
                    var ctrl = document.getElementById('sat-radar-controls');
                    if (ctrl) ctrl.style.display = 'none';
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
                // Store first site's position as default
                if (json.sites.length > 0) {
                    _satRadarSiteLat = json.sites[0].lat;
                    _satRadarSiteLon = json.sites[0].lon;
                }
                if (statusEl) statusEl.textContent = json.sites.length + ' site(s)';

                // Auto-load full scan list if radar is toggled on
                if (showRadar) _satLoadRadarScans();
            })
            .catch(function (e) {
                siteSelect.innerHTML = '<option value="">Error</option>';
                if (statusEl) statusEl.textContent = 'Error';
            });
    }

    /** Parse "YYYY-MM-DD HH:MM:SS UTC" to epoch ms */
    function _parseScanTime(s) {
        if (!s) return 0;
        return new Date(s.replace(' UTC', 'Z').replace(' ', 'T')).getTime();
    }

    /**
     * Load ALL scans for the selected site across the full 6h animation window.
     * Populates dropdown and kicks off key-frame pre-fetch.
     */
    window._satLoadRadarScans = function () {
        var siteSelect = document.getElementById('sat-radar-site-select');
        var scanSelect = document.getElementById('sat-radar-scan-select');
        var status = document.getElementById('sat-radar-frame-status');
        if (!siteSelect || !siteSelect.value || !scanSelect) return;

        var site = siteSelect.value;

        // Update stored site position from selected option
        var selOpt = siteSelect.options[siteSelect.selectedIndex];
        if (selOpt && selOpt.getAttribute('data-lat')) {
            _satRadarSiteLat = parseFloat(selOpt.getAttribute('data-lat'));
            _satRadarSiteLon = parseFloat(selOpt.getAttribute('data-lon'));
        }

        // Use the middle of the animation window as reference time
        var midIdx = Math.floor(irFrames.length / 2);
        var refTime = (irFrames[midIdx] && irFrames[midIdx].datetime_utc) ||
                      (irFrames[animIndex] && irFrames[animIndex].datetime_utc) || null;
        if (!refTime) { if (status) status.textContent = 'No frame time'; return; }

        scanSelect.innerHTML = '<option value="">Loading...</option>';
        if (status) status.textContent = 'Searching 6h window...';

        fetch(API_BASE + '/nexrad/scans?site=' + encodeURIComponent(site) + '&datetime=' + encodeURIComponent(refTime) + '&window_min=360', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                _satRadarAllScans = (json.scans || []).slice();
                // Sort by scan time ascending
                _satRadarAllScans.sort(function (a, b) {
                    return _parseScanTime(a.scan_time) - _parseScanTime(b.scan_time);
                });

                scanSelect.innerHTML = '';
                if (_satRadarAllScans.length === 0) {
                    scanSelect.innerHTML = '<option value="">No scans</option>';
                    if (status) status.textContent = 'No scans in 6h window';
                    return;
                }
                for (var i = 0; i < _satRadarAllScans.length; i++) {
                    var sc = _satRadarAllScans[i];
                    var opt = document.createElement('option');
                    opt.value = sc.s3_key;
                    opt.textContent = sc.scan_time;
                    scanSelect.appendChild(opt);
                }
                if (status) status.textContent = _satRadarAllScans.length + ' scans over 6h';

                // Select closest to current frame and load it
                _satSyncRadarToFrame();

                // Pre-fetch key frames (~8 evenly-spaced scans)
                _satPrefetchKeyFrames();
            })
            .catch(function (e) {
                scanSelect.innerHTML = '<option value="">Error</option>';
                if (status) status.textContent = 'Error';
            });
    };

    /**
     * Find the scan closest to the current IR frame time and display it.
     */
    function _satSyncRadarToFrame() {
        if (_satRadarAllScans.length === 0) return;
        var irFrame = irFrames[animIndex];
        if (!irFrame || !irFrame.datetime_utc) return;

        var irTime = new Date(irFrame.datetime_utc).getTime();
        var bestIdx = 0, bestDelta = Infinity;
        for (var i = 0; i < _satRadarAllScans.length; i++) {
            var d = Math.abs(_parseScanTime(_satRadarAllScans[i].scan_time) - irTime);
            if (d < bestDelta) { bestDelta = d; bestIdx = i; }
        }

        var bestScan = _satRadarAllScans[bestIdx];
        // Update dropdown selection
        var scanSelect = document.getElementById('sat-radar-scan-select');
        if (scanSelect && bestIdx < scanSelect.options.length) {
            scanSelect.selectedIndex = bestIdx;
        }

        // Check if we have this frame cached
        var cacheKey = bestScan.s3_key + ':' + _satRadarProduct;
        var cached = _satRadarFrameCache[cacheKey];
        if (cached) {
            _satApplyRadarFrame(cached);
            return;
        }

        // Not cached — fetch it
        _satFetchRadarFrame(bestScan.s3_key, true);
    }

    /**
     * Apply a cached radar frame to the display.
     */
    function _satApplyRadarFrame(frame) {
        _satRadarImg = frame.img;
        _satRadarBounds = frame.bounds;
        _satRadarData = frame.data;
        _satRadarRows = frame.rows;
        _satRadarCols = frame.cols;
        _satRadarVmin = frame.vmin;
        _satRadarVmax = frame.vmax;
        _satRadarUnits = frame.units;
        _satRadarTilt = frame.tilt || 0.5;
        _satRadarScanKey = frame.s3Key;
        var status = document.getElementById('sat-radar-frame-status');
        if (status) status.textContent = frame.statusText || '';
        renderBothPanels();
    }

    /**
     * Fetch a single radar frame and cache it.
     * If display=true, also apply it to the current display.
     */
    function _satFetchRadarFrame(s3Key, display) {
        var siteSelect = document.getElementById('sat-radar-site-select');
        if (!siteSelect || !siteSelect.value) return;
        var site = siteSelect.value;
        var product = _satRadarProduct;
        var status = document.getElementById('sat-radar-frame-status');

        if (display && status) status.textContent = 'Loading...';

        var url = API_BASE + '/nexrad/frame?site=' + encodeURIComponent(site) +
            '&s3_key=' + encodeURIComponent(s3Key) +
            '&product=' + product;

        fetch(url, { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                if (!json.image || !json.bounds) return;

                // Decode hover data
                var hoverData = null;
                if (json.data) {
                    var raw = atob(json.data);
                    hoverData = new Uint8Array(raw.length);
                    for (var i = 0; i < raw.length; i++) hoverData[i] = raw.charCodeAt(i);
                }

                var statusText = json.site + ' ' + json.scan_time + ' \u2014 ' + json.label;

                // Load image then cache
                var img = new Image();
                img.onload = function () {
                    var entry = {
                        img: img,
                        bounds: json.bounds,
                        data: hoverData,
                        rows: json.data_rows,
                        cols: json.data_cols,
                        vmin: json.data_vmin,
                        vmax: json.data_vmax,
                        units: json.units || 'dBZ',
                        tilt: json.tilt || 0.5,
                        s3Key: s3Key,
                        statusText: statusText
                    };
                    _satRadarFrameCache[s3Key + ':' + product] = entry;

                    // Update prefetch progress
                    _satUpdatePrefetchStatus();

                    if (display) {
                        _satApplyRadarFrame(entry);
                        _satUpdateRadarColorbar();
                    }
                };
                img.src = json.image;
            })
            .catch(function (e) {
                if (display && status) status.textContent = 'Error: ' + e.message;
            });
    }

    /**
     * Load a specific scan from the dropdown (user manual selection).
     */
    window._satLoadRadarFrame = function () {
        var scanSelect = document.getElementById('sat-radar-scan-select');
        if (!scanSelect || !scanSelect.value) return;

        var prodSelect = document.getElementById('sat-radar-product-select');
        _satRadarProduct = (prodSelect && prodSelect.value) || 'reflectivity';

        var s3Key = scanSelect.value;
        var cacheKey = s3Key + ':' + _satRadarProduct;
        var cached = _satRadarFrameCache[cacheKey];
        if (cached) {
            _satApplyRadarFrame(cached);
            _satUpdateRadarColorbar();
            return;
        }
        _satFetchRadarFrame(s3Key, true);
    };

    /**
     * Pre-fetch ~8 key frames evenly spaced across the scan list.
     * Uses 2-at-a-time concurrency to avoid hammering the API.
     */
    function _satPrefetchKeyFrames() {
        if (_satRadarAllScans.length === 0 || _satRadarPrefetching) return;
        _satRadarPrefetching = true;

        var total = _satRadarAllScans.length;
        var maxKeys = 8;
        var step = Math.max(1, Math.floor(total / maxKeys));
        var keyIndices = [];
        for (var i = 0; i < total; i += step) keyIndices.push(i);
        // Always include the last scan
        if (keyIndices[keyIndices.length - 1] !== total - 1) keyIndices.push(total - 1);

        var CONCURRENCY = 2;
        var nextSlot = 0;

        function fetchNext() {
            if (nextSlot >= keyIndices.length) {
                _satRadarPrefetching = false;
                _satUpdatePrefetchStatus();
                return;
            }
            var idx = keyIndices[nextSlot++];
            var scan = _satRadarAllScans[idx];
            var cacheKey = scan.s3_key + ':' + _satRadarProduct;
            if (_satRadarFrameCache[cacheKey]) {
                // Already cached — skip to next
                fetchNext();
                return;
            }
            _satFetchRadarFrame(scan.s3_key, false);
            // Chain next fetch after a short delay (let the API breathe)
            setTimeout(fetchNext, 500);
        }

        // Launch concurrent slots
        for (var c = 0; c < Math.min(CONCURRENCY, keyIndices.length); c++) {
            fetchNext();
        }
    }

    /**
     * Update prefetch progress in status text.
     */
    function _satUpdatePrefetchStatus() {
        var status = document.getElementById('sat-radar-status');
        if (!status) return;
        var cached = 0;
        for (var k in _satRadarFrameCache) {
            if (_satRadarFrameCache.hasOwnProperty(k)) cached++;
        }
        var total = _satRadarAllScans.length;
        if (_satRadarPrefetching) {
            status.textContent = 'Caching ' + cached + '/' + total;
        } else if (cached > 0) {
            status.textContent = cached + ' cached';
        }
    }

    /**
     * Called from showFrame() — sync radar to nearest cached scan.
     * Throttled to avoid excessive work during fast animation.
     */
    function _satRadarFrameSync() {
        if (!showRadar || _satRadarAllScans.length === 0) return;
        if (_satRadarSyncTimer) clearTimeout(_satRadarSyncTimer);
        _satRadarSyncTimer = setTimeout(function () {
            _satSyncRadarToFrame();
        }, 150);
    }

    /**
     * Toggle the 88D radar overlay on/off.
     */
    window._satToggleRadar = function () {
        showRadar = !showRadar;
        var cb = document.getElementById('sat-radar-toggle');
        if (cb && cb.checked !== showRadar) cb.checked = showRadar;
        var ctrl = document.getElementById('sat-radar-controls');
        if (ctrl) ctrl.style.display = showRadar ? '' : 'none';

        if (showRadar) {
            _ga('sat_radar_toggle', { visible: true });
            _satLoadRadarSites();
            var siteSelect = document.getElementById('sat-radar-site-select');
            if (siteSelect && siteSelect.value) {
                if (_satRadarAllScans.length > 0) {
                    // Already have scans — just sync to current frame
                    _satSyncRadarToFrame();
                } else {
                    _satLoadRadarScans();
                }
            }
            _satUpdateRadarColorbar();
        }
        renderBothPanels();
    };

    /**
     * Update the radar colorbar.
     */
    function _satUpdateRadarColorbar() {
        var el = document.getElementById('sat-radar-colorbar');
        if (!el) return;

        if (_satRadarProduct === 'velocity') {
            el.innerHTML =
                '<div style="display:flex;height:6px;border-radius:2px;border:1px solid rgba(255,255,255,0.15);overflow:hidden;">' +
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
                '<div style="display:flex;justify-content:space-between;font-size:7px;color:#94a3b8;margin-top:1px;">' +
                    '<span>-100 m/s</span><span>0</span><span>+100 m/s</span>' +
                '</div>';
        } else {
            el.innerHTML =
                '<div style="display:flex;height:6px;border-radius:2px;border:1px solid rgba(255,255,255,0.15);overflow:hidden;">' +
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
                '<div style="display:flex;justify-content:space-between;font-size:7px;color:#94a3b8;margin-top:1px;">' +
                    '<span>5 dBZ</span><span>35</span><span>65</span>' +
                '</div>';
        }
    }

    /**
     * Clean up radar overlay state (called on storm change).
     */
    function _satRemoveRadar() {
        _satRadarImg = null;
        _satRadarBounds = null;
        _satRadarData = null;
        _satRadarSites = null;
        _satRadarLastStormId = null;
        _satRadarScanKey = null;
        _satRadarAllScans = [];
        _satRadarFrameCache = {};
        _satRadarPrefetching = false;
        if (_satRadarSyncTimer) { clearTimeout(_satRadarSyncTimer); _satRadarSyncTimer = null; }
        var ctrl = document.getElementById('sat-radar-controls');
        if (ctrl) ctrl.style.display = 'none';
        var siteSelect = document.getElementById('sat-radar-site-select');
        if (siteSelect) siteSelect.innerHTML = '';
        var scanSelect = document.getElementById('sat-radar-scan-select');
        if (scanSelect) scanSelect.innerHTML = '';
        var status = document.getElementById('sat-radar-frame-status');
        if (status) status.textContent = '';
        var statusEl = document.getElementById('sat-radar-status');
        if (statusEl) statusEl.textContent = '';
    }

    // ── Init ────────────────────────────────────────────────────

    var _activated = false;

    function init() {
        initDOM();
        if (!canvasIR) return;
        bindEvents();
        loadCoastlines();
        console.log('[Satellite] Viewer ready (waiting for activation)');
    }

    function activate() {
        if (_activated) return;
        _activated = true;

        // Speculative fetch: if URL hash has a storm ID, start fetching
        // frame 0 immediately — don't wait for the storm list API.
        var hashStorm = getHashStorm();
        if (hashStorm) {
            currentStormId = hashStorm.toUpperCase();
            showLoader('Loading satellite data\u2026');
            var url0 = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(currentStormId) + '/ir-raw-frame'
                + '?frame_index=0&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;
            fetch(url0)
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (data) {
                    if (currentStormId !== hashStorm.toUpperCase()) return; // storm changed
                    irFrames[0] = {
                        tb_data: decodeTbData(data.tb_data), rows: data.tb_rows, cols: data.tb_cols,
                        bounds: data.bounds, datetime_utc: data.datetime_utc,
                        satellite: data.satellite || '', tb_vmin: data.tb_vmin || 160.0, tb_vmax: data.tb_vmax || 330.0,
                        center_fix: data.center_fix || null,
                    };
                    if (data.total_frames) totalExpectedFrames = data.total_frames;
                    buildValidIndices();
                    updateSliderMax();
                    animIndex = 0;
                    hideLoader();
                    renderBothPanels();
                    updateAnimUI();
                    console.log('[Satellite] Speculative frame 0 loaded for ' + currentStormId);
                })
                .catch(function () {
                    console.log('[Satellite] Speculative fetch failed, waiting for storm list');
                });
        }

        loadStorms();
        startPolling();
        _ga('sat_page_load');
        console.log('[Satellite] Viewer activated');
    }

    window.activateSatelliteView = activate;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
