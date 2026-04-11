/* ═══════════════════════════════════════════════════════════════
   Satellite Viewer — satellite.js
   Lightweight plan-view satellite imagery page.
   No Leaflet — pure canvas rendering with hover Tb readout.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Config ──────────────────────────────────────────────────
    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var POLL_INTERVAL_MS = 10 * 60 * 1000;  // 10 min
    var DEFAULT_LOOKBACK_HOURS = 6;
    var DEFAULT_RADIUS_DEG = 10.0;
    var FRAME_INTERVAL_MIN = 30;
    var FETCH_CONCURRENCY = 3;

    // ── State ───────────────────────────────────────────────────
    var storms = [];
    var currentStormId = null;
    var currentStorm = null;
    var frames = [];       // array of {tb_data, rows, cols, bounds, datetime_utc, satellite}
    var animIndex = 0;
    var animPlaying = false;
    var animTimer = null;
    var animLastTick = 0;
    var animSpeedIdx = 1;  // default 1x
    var hoverThrottled = false;
    var pollTimer = null;
    var selectedColormap = 'claude-ir';

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

        IR_COLORMAPS['claude-ir'] = buildLUTfromTb([
            {tb: 310, r:  12, g:  12, b:  22},
            {tb: 293, r:  70, g:  70, b:  82},
            {tb: 283, r: 120, g: 120, b: 132},
            {tb: 273, r: 180, g: 180, b: 192},
            {tb: 263, r: 216, g: 218, b: 228},
            {tb: 253, r: 140, g: 210, b: 220},
            {tb: 248, r:  68, g: 180, b: 196},
            {tb: 243, r:  32, g: 148, b: 166},
            {tb: 238, r:  40, g: 178, b: 116},
            {tb: 233, r:  96, g: 208, b:  68},
            {tb: 228, r: 192, g: 220, b:  40},
            {tb: 223, r: 238, g: 196, b:  48},
            {tb: 218, r: 228, g: 132, b:  48},
            {tb: 213, r: 214, g:  78, b:  56},
            {tb: 208, r: 180, g:  36, b:  68},
            {tb: 203, r: 196, g:  48, b: 156},
            {tb: 198, r: 168, g:  64, b: 200},
            {tb: 193, r: 120, g:  48, b: 180},
            {tb: 183, r:  64, g:  24, b: 140},
            {tb: 173, r:  28, g:  12, b:  96}
        ]);
    })();

    // ── DOM References ──────────────────────────────────────────
    var canvas, ctx, canvasWrap, tooltip, loader, loaderMsg, noStormsEl;
    var colorbarCanvas, colorbarWrap, cbWarmLabel, cbColdLabel;
    var sliderEl, frameCounterEl, timestampEl, satelliteEl, stormLabelEl;
    var playBtn, speedBtn, stormListEl;
    var sidebar, sidebarToggle, sidebarClose;

    function initDOM() {
        canvas = document.getElementById('sat-canvas');
        ctx = canvas.getContext('2d');
        canvasWrap = document.getElementById('sat-canvas-wrap');
        tooltip = document.getElementById('sat-tooltip');
        loader = document.getElementById('sat-loader');
        loaderMsg = document.getElementById('sat-loader-msg');
        noStormsEl = document.getElementById('sat-no-storms');
        colorbarCanvas = document.getElementById('sat-colorbar');
        colorbarWrap = document.getElementById('sat-colorbar-wrap');
        cbWarmLabel = document.getElementById('sat-cb-warm');
        cbColdLabel = document.getElementById('sat-cb-cold');
        sliderEl = document.getElementById('sat-slider');
        frameCounterEl = document.getElementById('sat-frame-counter');
        timestampEl = document.getElementById('sat-timestamp');
        satelliteEl = document.getElementById('sat-satellite');
        stormLabelEl = document.getElementById('sat-storm-label');
        playBtn = document.getElementById('sat-play');
        speedBtn = document.getElementById('sat-speed');
        stormListEl = document.getElementById('sat-storm-list');
        sidebar = document.getElementById('sat-sidebar');
        sidebarToggle = document.getElementById('sat-sidebar-toggle');
        sidebarClose = document.getElementById('sat-sidebar-close');
    }

    // ── Utility ─────────────────────────────────────────────────

    function decodeTbData(base64str) {
        var binary = atob(base64str);
        var arr = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            arr[i] = binary.charCodeAt(i);
        }
        return arr;
    }

    function categoryShort(cat) {
        if (!cat) return 'TD';
        if (cat === 'TD' || cat === 'TS') return cat;
        return 'Cat ' + cat.replace('C', '');
    }

    function fmtLatLon(lat, lon) {
        var latStr = Math.abs(lat).toFixed(1) + (lat >= 0 ? '\u00B0N' : '\u00B0S');
        var lonStr = Math.abs(lon).toFixed(1) + (lon >= 0 ? '\u00B0E' : '\u00B0W');
        return latStr + ', ' + lonStr;
    }

    function _ga(action, params) {
        if (typeof gtag === 'function') {
            try { gtag('event', action, params || {}); } catch (e) { /* silent */ }
        }
    }

    // ── Canvas Rendering ────────────────────────────────────────

    function renderFrameToCanvas(frame) {
        if (!frame || !frame.tb_data) return;
        var lut = IR_COLORMAPS[selectedColormap] || IR_COLORMAPS['enhanced'];
        var rows = frame.rows, cols = frame.cols;
        var tbData = frame.tb_data;

        canvas.width = cols;
        canvas.height = rows;
        var imgData = ctx.createImageData(cols, rows);
        var pixels = imgData.data;

        for (var i = 0; i < tbData.length; i++) {
            var val = tbData[i];
            var pi = i * 4;
            if (val === 0) {
                pixels[pi] = 10; pixels[pi + 1] = 11; pixels[pi + 2] = 18; pixels[pi + 3] = 255;
            } else {
                var li = val * 4;
                pixels[pi]     = lut[li];
                pixels[pi + 1] = lut[li + 1];
                pixels[pi + 2] = lut[li + 2];
                pixels[pi + 3] = lut[li + 3];
            }
        }
        ctx.putImageData(imgData, 0, 0);
    }

    function renderColorbar() {
        var lut = IR_COLORMAPS[selectedColormap] || IR_COLORMAPS['enhanced'];
        var cbCtx = colorbarCanvas.getContext('2d');
        var w = colorbarCanvas.width, h = colorbarCanvas.height;
        var imgData = cbCtx.createImageData(w, h);
        var pixels = imgData.data;

        // Cold on top (index 255 = coldest), warm on bottom (index 1 = warmest)
        for (var y = 0; y < h; y++) {
            var val = 255 - y;  // top row = 255, bottom row = 1
            if (val < 1) val = 1;
            var li = val * 4;
            for (var x = 0; x < w; x++) {
                var pi = (y * w + x) * 4;
                pixels[pi]     = lut[li];
                pixels[pi + 1] = lut[li + 1];
                pixels[pi + 2] = lut[li + 2];
                pixels[pi + 3] = 255;
            }
        }
        cbCtx.putImageData(imgData, 0, 0);

        // Labels: warm bottom, cold top (Tb range 160-330 K)
        if (cbWarmLabel) cbWarmLabel.textContent = '330 K';
        if (cbColdLabel) cbColdLabel.textContent = '160 K';
        colorbarWrap.classList.add('visible');
    }

    // ── Storm List ──────────────────────────────────────────────

    function loadStorms() {
        fetch(API_BASE + '/ir-monitor/active-storms', { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                storms = (data.storms || []).slice();
                // Sort: strongest first
                storms.sort(function (a, b) {
                    return (b.vmax_kt || 0) - (a.vmax_kt || 0);
                });
                renderStormList();

                if (storms.length === 0) {
                    showNoStorms();
                    return;
                }

                // Auto-select from hash or strongest storm
                var hashStorm = getHashStorm();
                var target = hashStorm ? storms.find(function (s) {
                    return s.atcf_id.toUpperCase() === hashStorm.toUpperCase();
                }) : null;
                if (!target) target = storms[0];
                selectStorm(target.atcf_id);
            })
            .catch(function (err) {
                console.error('[Satellite] Failed to load storms:', err);
                stormListEl.innerHTML = '<div class="sat-loading-msg">Failed to load storms. Retrying&hellip;</div>';
                setTimeout(loadStorms, 30000);
            });
    }

    function renderStormList() {
        if (!stormListEl) return;
        if (storms.length === 0) {
            stormListEl.innerHTML = '<div class="sat-loading-msg">No active storms</div>';
            return;
        }

        var html = '';
        for (var i = 0; i < storms.length; i++) {
            var s = storms[i];
            var color = SS_COLORS[s.category] || SS_COLORS.TD;
            var active = (s.atcf_id === currentStormId) ? ' active' : '';
            html += '<div class="sat-storm-item' + active + '" data-id="' + s.atcf_id + '" style="--storm-color:' + color + '">' +
                    '<div class="sat-storm-dot" style="background:' + color + '"></div>' +
                    '<div class="sat-storm-info">' +
                    '<div class="sat-storm-name">' + (s.name || s.atcf_id) + '</div>' +
                    '<div class="sat-storm-meta">' + categoryShort(s.category) +
                    (s.vmax_kt != null ? ' \u00B7 ' + s.vmax_kt + ' kt' : '') +
                    ' \u00B7 ' + (s.basin || '') + '</div>' +
                    '</div></div>';
        }
        stormListEl.innerHTML = html;

        // Click handlers
        var items = stormListEl.querySelectorAll('.sat-storm-item');
        for (var j = 0; j < items.length; j++) {
            items[j].addEventListener('click', function () {
                selectStorm(this.getAttribute('data-id'));
            });
        }
    }

    function selectStorm(atcfId) {
        if (currentStormId === atcfId) return;
        stopAnimation();
        currentStormId = atcfId;
        currentStorm = storms.find(function (s) { return s.atcf_id === atcfId; }) || null;
        frames = [];
        animIndex = 0;

        // Update UI
        renderStormList();
        updateHash(atcfId);
        if (currentStorm) {
            var color = SS_COLORS[currentStorm.category] || SS_COLORS.TD;
            stormLabelEl.textContent = (currentStorm.name || atcfId) + ' (' + categoryShort(currentStorm.category) + ')';
            stormLabelEl.style.color = color;
        }

        // Close sidebar on mobile after selection
        if (window.innerWidth <= 768) {
            sidebar.classList.remove('open');
        }

        noStormsEl.style.display = 'none';
        showLoader('Loading satellite data\u2026');
        loadFrames(atcfId);

        _ga('sat_select_storm', { storm: atcfId });
    }

    // ── Frame Loading ───────────────────────────────────────────

    function loadFrames(stormId) {
        var totalFrames = 13;
        var loadedFrames = [];
        var completed = 0;
        var failed = 0;

        function fetchFrame(idx) {
            if (idx >= totalFrames) return;
            if (stormId !== currentStormId) return;  // storm changed

            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/ir-raw-frame'
                + '?frame_index=' + idx
                + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG
                + '&interval_min=' + FRAME_INTERVAL_MIN;

            fetch(url, { cache: 'no-store' })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (data) {
                    if (data.total_frames) totalFrames = data.total_frames;
                    loadedFrames[idx] = {
                        tb_data: decodeTbData(data.tb_data),
                        rows: data.tb_rows,
                        cols: data.tb_cols,
                        bounds: data.bounds,
                        datetime_utc: data.datetime_utc,
                        satellite: data.satellite || '',
                        tb_vmin: data.tb_vmin || 160.0,
                        tb_vmax: data.tb_vmax || 330.0
                    };
                    completed++;

                    // Show first frame immediately
                    if (idx === 0 && stormId === currentStormId) {
                        frames[0] = loadedFrames[0];
                        animIndex = 0;
                        renderFrameToCanvas(frames[0]);
                        renderColorbar();
                        updateAnimUI();
                        hideLoader();
                    }

                    updateLoaderProgress(completed, totalFrames);
                })
                .catch(function (err) {
                    console.warn('[Satellite] Frame ' + idx + ' failed:', err.message);
                    failed++;
                    completed++;
                })
                .finally(function () {
                    var nextIdx = idx + FETCH_CONCURRENCY;
                    if (nextIdx < totalFrames) fetchFrame(nextIdx);

                    if (completed >= totalFrames) {
                        // Compact and store
                        var result = [];
                        for (var i = 0; i < totalFrames; i++) {
                            if (loadedFrames[i]) result.push(loadedFrames[i]);
                        }
                        if (stormId === currentStormId) {
                            frames = result;
                            updateSliderMax();
                            updateAnimUI();
                            hideLoader();
                        }
                        console.log('[Satellite] All frames loaded: ' + result.length + ' OK, ' + failed + ' failed');
                    }
                });
        }

        for (var i = 0; i < Math.min(FETCH_CONCURRENCY, totalFrames); i++) {
            fetchFrame(i);
        }
    }

    // ── Animation ───────────────────────────────────────────────

    function showFrame(idx) {
        if (idx < 0 || idx >= frames.length) return;
        animIndex = idx;
        renderFrameToCanvas(frames[idx]);
        updateAnimUI();
    }

    function nextFrame() {
        if (frames.length === 0) return;
        showFrame((animIndex + 1) % frames.length);
    }

    function prevFrame() {
        if (frames.length === 0) return;
        showFrame((animIndex - 1 + frames.length) % frames.length);
    }

    function animTick(ts) {
        if (!animPlaying) return;
        var ms = ANIM_SPEEDS[animSpeedIdx].ms;
        if (ts - animLastTick >= ms) {
            animLastTick = ts;
            nextFrame();
        }
        animTimer = requestAnimationFrame(animTick);
    }

    function startAnimation() {
        if (frames.length < 2) return;
        animPlaying = true;
        animLastTick = 0;
        animTimer = requestAnimationFrame(animTick);
        updatePlayBtn();
    }

    function stopAnimation() {
        animPlaying = false;
        if (animTimer) cancelAnimationFrame(animTimer);
        animTimer = null;
        updatePlayBtn();
    }

    function toggleAnimation() {
        if (animPlaying) stopAnimation();
        else startAnimation();
    }

    function cycleSpeed() {
        animSpeedIdx = (animSpeedIdx + 1) % ANIM_SPEEDS.length;
        if (speedBtn) speedBtn.textContent = ANIM_SPEEDS[animSpeedIdx].label;
    }

    // ── UI Updates ──────────────────────────────────────────────

    function updateAnimUI() {
        var frame = frames[animIndex];
        if (frameCounterEl) {
            frameCounterEl.textContent = (frames.length > 0 ? (animIndex + 1) : 0) + ' / ' + frames.length;
        }
        if (frame && timestampEl) {
            var dt = frame.datetime_utc || '';
            // Format: "2026-04-11 18:40 UTC"
            timestampEl.textContent = dt.replace('T', ' ').replace(/:\d{2}Z$/, ' UTC').replace('Z', ' UTC');
        }
        if (frame && satelliteEl) {
            satelliteEl.textContent = frame.satellite || '';
        }
        if (sliderEl && frames.length > 0) {
            sliderEl.value = animIndex;
        }
    }

    function updateSliderMax() {
        if (sliderEl) {
            sliderEl.max = Math.max(0, frames.length - 1);
        }
    }

    function updatePlayBtn() {
        if (!playBtn) return;
        playBtn.innerHTML = animPlaying ? '&#9646;&#9646;' : '&#9654;&#9654;';
        playBtn.title = animPlaying ? 'Pause (Space)' : 'Play (Space)';
    }

    function showLoader(msg) {
        if (loader) loader.classList.remove('hidden');
        if (loaderMsg) loaderMsg.textContent = msg || 'Loading\u2026';
    }

    function hideLoader() {
        if (loader) loader.classList.add('hidden');
    }

    function updateLoaderProgress(loaded, total) {
        if (loaderMsg && loaded < total) {
            loaderMsg.textContent = 'Loading frames\u2026 ' + loaded + ' / ' + total;
        }
    }

    function showNoStorms() {
        hideLoader();
        if (noStormsEl) noStormsEl.style.display = 'flex';
    }

    // ── Hover Readout ───────────────────────────────────────────

    function handleMouseMove(e) {
        if (hoverThrottled || frames.length === 0) return;
        hoverThrottled = true;
        setTimeout(function () { hoverThrottled = false; }, 50);

        var frame = frames[animIndex];
        if (!frame || !frame.tb_data || !frame.bounds) {
            tooltip.style.display = 'none';
            return;
        }

        var rect = canvas.getBoundingClientRect();
        var cx = (e.clientX - rect.left) / rect.width;
        var cy = (e.clientY - rect.top) / rect.height;

        // Bounds: [[south, west], [north, east]]
        var b = frame.bounds;
        var south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
        var lat = north - cy * (north - south);
        var lon = west + cx * (east - west);

        // Map to data indices
        var fracY = (north - lat) / (north - south);
        var fracX = (lon - west) / (east - west);
        var row = Math.min(Math.floor(fracY * frame.rows), frame.rows - 1);
        var col = Math.min(Math.floor(fracX * frame.cols), frame.cols - 1);

        if (row < 0 || col < 0 || row >= frame.rows || col >= frame.cols) {
            tooltip.style.display = 'none';
            return;
        }

        var rawVal = frame.tb_data[row * frame.cols + col];
        if (rawVal === 0) {
            tooltip.style.display = 'none';
            return;
        }

        var tbVmin = frame.tb_vmin || 160.0;
        var tbVmax = frame.tb_vmax || 330.0;
        var tbK = tbVmin + (rawVal - 1) * (tbVmax - tbVmin) / 254.0;
        var tbC = (tbK - 273.15).toFixed(1);
        var latStr = Math.abs(lat).toFixed(2) + (lat >= 0 ? '\u00B0N' : '\u00B0S');
        var lonStr = Math.abs(lon).toFixed(2) + (lon >= 0 ? '\u00B0E' : '\u00B0W');

        tooltip.innerHTML =
            '<span class="sat-tb-val">' + tbK.toFixed(1) + ' K</span>' +
            '<span class="sat-tb-sep"> / </span>' +
            '<span class="sat-tb-val">' + tbC + ' \u00B0C</span>' +
            '<span class="sat-tb-sep"> &nbsp; </span>' +
            '<span class="sat-tb-coord">' + latStr + ', ' + lonStr + '</span>';

        // Position tooltip near cursor (offset to avoid covering cursor)
        var tx = e.clientX - rect.left + 16;
        var ty = e.clientY - rect.top - 28;
        // Keep within canvas bounds
        var tw = tooltip.offsetWidth || 200;
        if (tx + tw > rect.width - 8) tx = e.clientX - rect.left - tw - 8;
        if (ty < 4) ty = e.clientY - rect.top + 16;
        tooltip.style.left = tx + 'px';
        tooltip.style.top = ty + 'px';
        tooltip.style.display = 'block';
    }

    function handleMouseOut() {
        tooltip.style.display = 'none';
    }

    // ── Deep Link ───────────────────────────────────────────────

    function getHashStorm() {
        var m = window.location.hash.match(/storm=([A-Za-z0-9]+)/);
        return m ? m[1] : null;
    }

    function updateHash(stormId) {
        if (stormId) {
            history.replaceState(null, '', '#storm=' + stormId);
        }
    }

    // ── Event Binding ───────────────────────────────────────────

    function bindEvents() {
        // Animation controls
        document.getElementById('sat-prev').addEventListener('click', function () {
            stopAnimation(); prevFrame();
        });
        document.getElementById('sat-next').addEventListener('click', function () {
            stopAnimation(); nextFrame();
        });
        playBtn.addEventListener('click', toggleAnimation);
        speedBtn.addEventListener('click', cycleSpeed);

        sliderEl.addEventListener('input', function () {
            stopAnimation();
            showFrame(parseInt(this.value, 10));
        });

        // Colormap
        document.getElementById('sat-colormap-select').addEventListener('change', function () {
            selectedColormap = this.value;
            if (frames.length > 0) {
                renderFrameToCanvas(frames[animIndex]);
                renderColorbar();
            }
            _ga('sat_colormap', { colormap: selectedColormap });
        });

        // Hover
        canvas.addEventListener('mousemove', handleMouseMove);
        canvas.addEventListener('mouseout', handleMouseOut);

        // Keyboard shortcuts
        document.addEventListener('keydown', function (e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    stopAnimation(); prevFrame();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    stopAnimation(); nextFrame();
                    break;
                case ' ':
                    e.preventDefault();
                    toggleAnimation();
                    break;
                case 'Escape':
                    if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
                        sidebar.classList.remove('open');
                    }
                    break;
            }
        });

        // Sidebar toggle (mobile)
        sidebarToggle.addEventListener('click', function () {
            sidebar.classList.add('open');
        });
        sidebarClose.addEventListener('click', function () {
            sidebar.classList.remove('open');
        });

        // Hash change
        window.addEventListener('hashchange', function () {
            var hashStorm = getHashStorm();
            if (hashStorm && hashStorm.toUpperCase() !== (currentStormId || '').toUpperCase()) {
                var target = storms.find(function (s) {
                    return s.atcf_id.toUpperCase() === hashStorm.toUpperCase();
                });
                if (target) selectStorm(target.atcf_id);
            }
        });
    }

    // ── Polling ─────────────────────────────────────────────────

    function startPolling() {
        pollTimer = setInterval(function () {
            fetch(API_BASE + '/ir-monitor/active-storms', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (!data) return;
                    storms = (data.storms || []).slice();
                    storms.sort(function (a, b) { return (b.vmax_kt || 0) - (a.vmax_kt || 0); });
                    renderStormList();
                    // Refresh current storm frames
                    if (currentStormId) {
                        currentStorm = storms.find(function (s) { return s.atcf_id === currentStormId; }) || currentStorm;
                    }
                })
                .catch(function () { /* silent retry next interval */ });
        }, POLL_INTERVAL_MS);
    }

    // ── Init ────────────────────────────────────────────────────

    var _activated = false;

    function init() {
        initDOM();
        if (!canvas) return;  // DOM elements not found — skip
        bindEvents();
        renderColorbar();
        console.log('[Satellite] Viewer ready (waiting for activation)');
    }

    /** Called when the Satellite tab is first shown */
    function activate() {
        if (_activated) return;
        _activated = true;
        loadStorms();
        startPolling();
        _ga('sat_page_load');
        console.log('[Satellite] Viewer activated');
    }

    // Expose for tab switching
    window.activateSatelliteView = activate;

    // Init DOM bindings when ready (but don't load data yet)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
