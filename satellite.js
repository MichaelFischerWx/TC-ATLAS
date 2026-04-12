/* ═══════════════════════════════════════════════════════════════
   Satellite Viewer — satellite.js
   Split-panel satellite imagery: IR + Vis/WV with coastlines,
   lat/lon axes, hover readout, and synchronized animation.
   No Leaflet — pure canvas rendering.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Config ──────────────────────────────────────────────────
    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var POLL_INTERVAL_MS = 10 * 60 * 1000;
    var DEFAULT_LOOKBACK_HOURS = 6;
    var DEFAULT_RADIUS_DEG = 10.0;
    var FRAME_INTERVAL_MIN = 30;
    var FETCH_CONCURRENCY = 3;
    var COASTLINE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson';

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

        // Water Vapor colormap (Band 8: 170-260 K range)
        IR_COLORMAPS['wv'] = (function () {
            var vmin = 170.0, vmax = 260.0, lut = new Uint8Array(256 * 4);
            lut[0]=0;lut[1]=0;lut[2]=0;lut[3]=0;
            var stops = [
                {f:0.00,r:10,g:10,b:30},    // warm/dry: near-black
                {f:0.20,r:30,g:30,b:80},    // dark blue
                {f:0.35,r:60,g:80,b:160},   // medium blue
                {f:0.50,r:100,g:140,b:200}, // light blue
                {f:0.65,r:160,g:200,b:230}, // pale blue
                {f:0.80,r:220,g:230,b:240}, // near-white
                {f:1.00,r:255,g:255,b:255}  // cold/moist: white
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
        if (!frame || !frame.tb_data || !ctx) return;
        var lut = IR_COLORMAPS[colormapName] || IR_COLORMAPS['enhanced'];
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

        // Fill background
        for (var i = 0; i < pixels.length; i += 4) {
            pixels[i] = 10; pixels[i+1] = 11; pixels[i+2] = 18; pixels[i+3] = 255;
        }

        // Render cropped region scaled to fill the full canvas
        var scaleY = frame.rows / crop.rows;
        var scaleX = frame.cols / crop.cols;

        for (var y = 0; y < frame.rows; y++) {
            var srcRow = crop.r0 + Math.floor(y / scaleY);
            if (srcRow < crop.r0 || srcRow >= crop.r1) continue;
            for (var x = 0; x < frame.cols; x++) {
                var srcCol = crop.c0 + Math.floor(x / scaleX);
                if (srcCol < crop.c0 || srcCol >= crop.c1) continue;
                var val = frame.tb_data[srcRow * frame.cols + srcCol];
                var pi = (y * frame.cols + x) * 4;
                if (val !== 0) {
                    var li = val * 4;
                    pixels[pi] = lut[li]; pixels[pi+1] = lut[li+1];
                    pixels[pi+2] = lut[li+2]; pixels[pi+3] = lut[li+3];
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
        var rightFrame = rightFrames[animIndex] || null;
        var irCmap = selectedColormap;
        var rightCmap = getRightCmap();

        renderFrame(canvasIR, ctxIR, irFrame, irCmap);
        if (rightFrame) {
            renderFrame(canvasRight, ctxRight, rightFrame, rightCmap);
        }

        // Draw overlays (grid lines + coastlines)
        drawOverlay(overlayIR, overlayCtxIR, irFrame);
        if (rightFrame) drawOverlay(overlayRight, overlayCtxRight, rightFrame);

        // Colorbars
        renderColorbar(cbIRCanvas, irCmap, cbIRTop, cbIRBot, 160, 330, 'K');
        if (rightFrame) {
            var rvmin = rightFrame.tb_vmin || 170, rvmax = rightFrame.tb_vmax || 260;
            var runit = rightDataType === 'reflectance' ? '%' : 'K';
            if (rightDataType === 'reflectance') { rvmin = 0; rvmax = 100; }
            renderColorbar(cbRightCanvas, rightCmap, cbRightTop, cbRightBot, rvmin, rvmax, runit);
        }

        // Update axes
        if (irFrame) {
            var vb = getViewBounds(irFrame);
            renderAxes(axesYIR, axesXIR, vb);
            renderAxes(axesYRight, axesXRight, vb);
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
            overlayCtx.strokeStyle = 'rgba(40, 40, 50, 0.7)';
            overlayCtx.lineWidth = 1;
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

        if (leftLabel) leftLabel.textContent = vmax + ' ' + unit;
        if (rightLabel) rightLabel.textContent = vmin + ' ' + unit;
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
        cctx.fillText(vmax + ' ' + unit, x, y + h + 12);
        cctx.textAlign = 'right';
        cctx.fillText(vmin + ' ' + unit, x + w, y + h + 12);
        cctx.textAlign = 'left';
    }

    function saveImage() {
        if (irFrames.length === 0) return;
        var irFrame = irFrames[animIndex];
        if (!irFrame) return;

        var pw = irFrame.cols, ph = irFrame.rows;
        var gap = 4;
        var headerH = 28;
        var cbH = 24;  // colorbar area height
        var totalW = pw * 2 + gap;
        var totalH = ph + headerH + cbH;

        var comp = document.createElement('canvas');
        comp.width = totalW;
        comp.height = totalH;
        var cctx = comp.getContext('2d');

        // Dark background
        cctx.fillStyle = '#0a0c12';
        cctx.fillRect(0, 0, totalW, totalH);

        // Header text
        cctx.fillStyle = '#e2e4ea';
        cctx.font = '14px sans-serif';
        var name = currentStorm ? (currentStorm.name || currentStormId) : currentStormId;
        var cat = currentStorm ? categoryShort(currentStorm.category) : '';
        var time = irFrame.datetime_utc ? irFrame.datetime_utc.replace('T', ' ').replace('Z', ' UTC') : '';
        var sat = irFrame.satellite || '';
        cctx.fillText(name + ' (' + cat + ')  \u2014  ' + time + '  ' + sat, 8, 18);

        // Panel labels
        cctx.font = '11px sans-serif';
        cctx.fillStyle = '#94a3b8';
        cctx.fillText('Enhanced IR', 8, headerH + 14);
        var rightLabel = rightBand === 2 ? 'Visible' : 'Water Vapor';
        cctx.fillText(rightLabel, pw + gap + 8, headerH + 14);

        // Draw IR canvas + overlay
        cctx.drawImage(canvasIR, 0, headerH, pw, ph);
        if (overlayIR) cctx.drawImage(overlayIR, 0, headerH, pw, ph);

        // Draw right canvas + overlay
        if (canvasRight && canvasRight.width > 0) {
            cctx.drawImage(canvasRight, pw + gap, headerH, pw, ph);
            if (overlayRight) cctx.drawImage(overlayRight, pw + gap, headerH, pw, ph);
        }

        // IR colorbar
        var cbY = headerH + ph + 4;
        var cbW = pw - 80;
        drawColorbarToCtx(cctx, 40, cbY, cbW, 8, selectedColormap, 160, 330, 'K');

        // Right panel colorbar
        var rightFrame = rightFrames[animIndex];
        if (rightFrame) {
            var rcmap = getRightCmap();
            var rvmin = rightFrame.tb_vmin || 170, rvmax = rightFrame.tb_vmax || 260;
            var runit = rightDataType === 'reflectance' ? '%' : 'K';
            if (rightDataType === 'reflectance') { rvmin = 0; rvmax = 100; }
            drawColorbarToCtx(cctx, pw + gap + 40, cbY, cbW, 8, rcmap, rvmin, rvmax, runit);
        }

        // TC-ATLAS watermark
        cctx.fillStyle = 'rgba(255,255,255,0.3)';
        cctx.font = '10px sans-serif';
        cctx.textAlign = 'right';
        cctx.fillText('TC-ATLAS', totalW - 8, totalH - 4);
        cctx.textAlign = 'left';

        // Download
        var link = document.createElement('a');
        link.download = (name || 'satellite') + '_' + (irFrame.datetime_utc || '').replace(/[:\-T]/g, '').replace('Z', '') + '.png';
        link.href = comp.toDataURL('image/png');
        link.click();
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

    // ── Storm List ──────────────────────────────────────────────

    function loadStorms() {
        fetch(API_BASE + '/ir-monitor/active-storms')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
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
        if (currentStormId === atcfId) return;
        stopAnimation();
        currentStormId = atcfId;
        currentStorm = storms.find(function (s) { return s.atcf_id === atcfId; }) || null;
        irFrames = []; rightFrames = [];
        animIndex = 0;
        irLoadedCount = 0; rightLoadedCount = 0;
        renderStormList();
        updateHash(atcfId);
        if (currentStorm) {
            var color = SS_COLORS[currentStorm.category] || SS_COLORS.TD;
            stormLabelEl.textContent = (currentStorm.name || atcfId) + ' (' + categoryShort(currentStorm.category) + ')';
            stormLabelEl.style.color = color;

            // Determine right panel band based on day/night at storm
            var sunEl = solarElevation(currentStorm.lat, currentStorm.lon, new Date());
            // Default to WV (works 24/7). User can toggle to Visible manually.
            rightBand = 8;
            rightDataType = rightBand <= 6 ? 'reflectance' : 'tb';
            if (rightLabelEl) rightLabelEl.textContent = rightBand === 2 ? 'Visible' : 'Water Vapor';
            // Update product toggle buttons
            var pbtns = document.querySelectorAll('.sat-product-btn');
            for (var pb = 0; pb < pbtns.length; pb++) {
                pbtns[pb].classList.toggle('active', parseInt(pbtns[pb].getAttribute('data-band'), 10) === rightBand);
            }
        }
        if (window.innerWidth <= 768 && sidebar) sidebar.classList.remove('open');
        noStormsEl.style.display = 'none';

        // Check browser-side cache
        var cached = frameCache[atcfId];
        if (cached && (Date.now() - cached.ts) < FRAME_CACHE_TTL) {
            irFrames = cached.ir;
            rightFrames = cached.right;
            buildValidIndices();
            animIndex = validFrameIndices.length > 0 ? validFrameIndices[0] : 0;
            updateSliderMax();
            renderBothPanels();
            updateAnimUI();
            console.log('[Satellite] Loaded ' + atcfId + ' from browser cache');
        } else {
            showLoader('Loading satellite data\u2026');
            loadFrames(atcfId);
        }
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
    }

    function _refetchRightFrames(stormId) {
        var totalFrames = 13;
        var rightDone = 0;

        function fetchOne(idx) {
            if (idx >= totalFrames || stormId !== currentStormId) return;
            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/band-raw-frame'
                + '?band=' + rightBand + '&frame_index=' + idx + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;
            fetch(url)
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
                })
                .catch(function () { rightDone++; })
                .finally(function () {
                    var next = idx + FETCH_CONCURRENCY;
                    if (next < totalFrames) fetchOne(next);
                });
        }
        for (var i = 0; i < Math.min(FETCH_CONCURRENCY, totalFrames); i++) fetchOne(i);
    }

    function loadFrames(stormId) {
        var totalFrames = 13;
        var irDone = 0, rightDone = 0, irFail = 0, rightFail = 0;

        function updateStatus() {
            if (loadStatusEl) {
                if (irDone < totalFrames || rightDone < totalFrames) {
                    loadStatusEl.textContent = 'IR ' + (irDone - irFail) + '/' + totalFrames +
                        ' \u00B7 ' + (rightBand === 2 ? 'Vis' : 'WV') + ' ' + (rightDone - rightFail) + '/' + totalFrames;
                } else {
                    loadStatusEl.textContent = '';
                }
            }
        }

        function fetchIRFrame(idx, retry) {
            if (idx >= totalFrames || stormId !== currentStormId) return;
            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/ir-raw-frame'
                + '?frame_index=' + idx + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;

            fetch(url)
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (data) {
                    if (data.total_frames) totalFrames = data.total_frames;
                    irFrames[idx] = {
                        tb_data: decodeTbData(data.tb_data), rows: data.tb_rows, cols: data.tb_cols,
                        bounds: data.bounds, datetime_utc: data.datetime_utc,
                        satellite: data.satellite || '', tb_vmin: data.tb_vmin || 160.0, tb_vmax: data.tb_vmax || 330.0
                    };
                    irDone++;
                    if (stormId === currentStormId) {
                        buildValidIndices();
                        updateSliderMax();
                        if (idx === 0) { animIndex = 0; hideLoader(); }
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
                    }
                })
                .finally(function () {
                    var next = idx + FETCH_CONCURRENCY;
                    if (next < totalFrames) fetchIRFrame(next);
                    if (irDone >= totalFrames && stormId === currentStormId) {
                        buildValidIndices();
                        updateSliderMax();
                        // Jump to most recent frame (highest index)
                        if (validFrameIndices.length > 0) {
                            animIndex = validFrameIndices[validFrameIndices.length - 1];
                        }
                        renderBothPanels();
                        updateAnimUI();
                    }
                });
        }

        function fetchRightFrame(idx, retry) {
            if (idx >= totalFrames || stormId !== currentStormId) return;
            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/band-raw-frame'
                + '?band=' + rightBand + '&frame_index=' + idx + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG + '&interval_min=' + FRAME_INTERVAL_MIN;

            fetch(url)
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
                    // Cache only when BOTH bands are fully loaded
                    if (irDone >= totalFrames && rightDone >= totalFrames) {
                        frameCache[stormId] = {
                            ir: irFrames.slice(), right: rightFrames.slice(), ts: Date.now()
                        };
                    }
                });
        }

        // Fetch IR and right-panel frames in parallel
        for (var i = 0; i < Math.min(FETCH_CONCURRENCY, totalFrames); i++) {
            fetchIRFrame(i);
            fetchRightFrame(i);
        }
    }

    // ── Animation ───────────────────────────────────────────────

    function showFrame(idx) {
        if (!irFrames[idx]) return;
        animIndex = idx;
        renderBothPanels();
        updateAnimUI();
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
    function startAnimation() { if (validFrameIndices.length < 2) return; animPlaying = true; animLastTick = 0; animTimer = requestAnimationFrame(animTick); updatePlayBtn(); }
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

        tooltip.innerHTML = valHtml +
            '<span class="sat-tb-sep"> &nbsp; </span>' +
            '<span class="sat-tb-coord">' + latStr + ', ' + lonStr + '</span>';

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

        // Right-panel product toggle (WV / Vis)
        var prodBtns = document.querySelectorAll('.sat-product-btn');
        for (var pb = 0; pb < prodBtns.length; pb++) {
            prodBtns[pb].addEventListener('click', function () {
                var newBand = parseInt(this.getAttribute('data-band'), 10);
                if (newBand === rightBand) return;
                rightBand = newBand;
                rightDataType = newBand <= 6 ? 'reflectance' : 'tb';
                if (rightLabelEl) rightLabelEl.textContent = newBand === 2 ? 'Visible' : 'Water Vapor';
                // Update active button
                for (var k = 0; k < prodBtns.length; k++) {
                    prodBtns[k].classList.toggle('active', parseInt(prodBtns[k].getAttribute('data-band'), 10) === newBand);
                }
                // Auto-select appropriate colormap
                if (newBand === 2) rightColormapName = 'vis';
                else if (rightColormapName === 'vis') rightColormapName = 'wv';
                if (rightCmapEl) rightCmapEl.value = rightColormapName;
                // Clear and refetch right frames
                rightFrames = [];
                renderBothPanels();
                if (currentStormId) {
                    // Refetch right panel frames with new band
                    _refetchRightFrames(currentStormId);
                }
            });
        }

        // Save button
        var saveBtn = document.getElementById('sat-save');
        if (saveBtn) saveBtn.addEventListener('click', saveImage);

        // Zoom buttons (10°, 5°, 2°)
        var zoomBtns = document.querySelectorAll('.sat-zoom-btn');
        for (var zi = 0; zi < zoomBtns.length; zi++) {
            zoomBtns[zi].addEventListener('click', function () {
                zoomDeg = parseInt(this.getAttribute('data-deg'), 10);
                for (var zj = 0; zj < zoomBtns.length; zj++) {
                    zoomBtns[zj].classList.toggle('active', zoomBtns[zj] === this);
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

        window.addEventListener('hashchange', function () {
            var hashStorm = getHashStorm();
            if (hashStorm && hashStorm.toUpperCase() !== (currentStormId || '').toUpperCase()) {
                var target = storms.find(function (s) { return s.atcf_id.toUpperCase() === hashStorm.toUpperCase(); });
                if (target) selectStorm(target.atcf_id);
            }
        });
    }

    // ── Polling ─────────────────────────────────────────────────

    function startPolling() {
        pollTimer = setInterval(function () {
            fetch(API_BASE + '/ir-monitor/active-storms')
                .then(function (r) { return r.ok ? r.json() : null; })
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
                                irFrames = []; rightFrames = []; validFrameIndices = [];
                                loadFrames(currentStormId);
                            } else {
                                currentStorm = updated;
                                // Auto-refresh frames to pick up newest imagery
                                console.log('[Satellite] Auto-refreshing frames for latest imagery');
                                irFrames = []; rightFrames = []; validFrameIndices = [];
                                loadFrames(currentStormId);
                            }
                        } else if (updated) {
                            currentStorm = updated;
                        }
                    }
                })
                .catch(function () {});
        }, POLL_INTERVAL_MS);
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
