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

    // Animation state
    var irFrames = [];         // array of {image_b64, datetime_utc, ...}
    var animIndex = 0;
    var animPlaying = false;
    var animTimer = null;

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

    // ═══════════════════════════════════════════════════════════
    //  MAP VIEW
    // ═══════════════════════════════════════════════════════════

    /** Initialize the Leaflet map */
    function initMap() {
        map = L.map('ir-map', {
            center: [20, -40],
            zoom: 3,
            minZoom: 2,
            maxZoom: 12,
            zoomControl: true,
            worldCopyJump: true
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 19
        }).addTo(map);

        // Move zoom control to top-left (default)
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

    /** Update the stats bar in the topbar */
    function updateStats(data) {
        var el = function (id) { return document.getElementById(id); };

        var totalActive = data.storms ? data.storms.length : 0;
        el('stat-active').textContent = totalActive;

        var byBasin = data.count_by_basin || {};
        el('stat-atl').textContent = (byBasin.ATL || 0);
        el('stat-epac').textContent = (byBasin.EPAC || 0);
        el('stat-wpac').textContent = (byBasin.WPAC || 0);

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

    /** Fetch IR frames for a storm */
    function fetchIRFrames(atcfId, callback) {
        var imageLoader = document.getElementById('ir-image-loader');
        if (imageLoader) imageLoader.style.display = 'flex';

        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) + '/ir' +
                  '?lookback_hours=' + DEFAULT_LOOKBACK_HOURS +
                  '&radius_deg=' + DEFAULT_RADIUS_DEG;

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                if (imageLoader) imageLoader.style.display = 'none';
                irFrames = data.frames || (data.image_b64 ? [data] : []);
                callback(null, irFrames);
                _ga('ir_fetch_frames', { atcf_id: atcfId, frame_count: irFrames.length });
            })
            .catch(function (err) {
                if (imageLoader) imageLoader.style.display = 'none';
                console.warn('[IR Monitor] IR fetch failed:', err.message);
                callback(err);
                _ga('ir_fetch_frames_error', { atcf_id: atcfId, error: err.message });
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

        // Fetch IR frames
        stopAnimation();
        irFrames = [];
        animIndex = 0;
        fetchIRFrames(atcfId, function (err, frames) {
            if (!err && frames && frames.length > 0) {
                initAnimation(frames);
            }
        });

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
    //  IR ANIMATION
    // ═══════════════════════════════════════════════════════════

    /** Initialize the animation with fetched frames */
    function initAnimation(frames) {
        irFrames = frames;
        animIndex = frames.length - 1; // start on most recent frame

        var slider = document.getElementById('ir-anim-slider');
        slider.max = frames.length - 1;
        slider.value = animIndex;

        updateAnimCounter();
        drawFrame(animIndex);
    }

    /** Draw a single IR frame to the canvas */
    function drawFrame(idx) {
        if (idx < 0 || idx >= irFrames.length) return;

        var frame = irFrames[idx];
        var canvas = document.getElementById('ir-canvas');
        var ctx = canvas.getContext('2d');

        var img = new Image();
        img.onload = function () {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
        };
        img.src = 'data:image/png;base64,' + frame.image_b64;

        // Update overlay info
        document.getElementById('ir-frame-time').textContent = fmtUTC(frame.datetime_utc);
        document.getElementById('ir-satellite-label').textContent = frame.satellite || '';
    }

    /** Update the frame counter text */
    function updateAnimCounter() {
        var counter = document.getElementById('ir-anim-counter');
        counter.textContent = (animIndex + 1) + ' / ' + irFrames.length;
    }

    /** Step to next frame */
    function nextFrame() {
        if (irFrames.length === 0) return;
        animIndex = (animIndex + 1) % irFrames.length;
        document.getElementById('ir-anim-slider').value = animIndex;
        updateAnimCounter();
        drawFrame(animIndex);
    }

    /** Step to previous frame */
    function prevFrame() {
        if (irFrames.length === 0) return;
        animIndex = (animIndex - 1 + irFrames.length) % irFrames.length;
        document.getElementById('ir-anim-slider').value = animIndex;
        updateAnimCounter();
        drawFrame(animIndex);
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
        if (irFrames.length < 2) return;
        animPlaying = true;
        var btn = document.getElementById('ir-anim-play');
        btn.innerHTML = '&#9646;&#9646;'; // pause icon
        btn.title = 'Pause';

        animTimer = setInterval(function () {
            nextFrame();
        }, 250); // 4 fps
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
            stopAnimation();
            animIndex = parseInt(this.value, 10);
            updateAnimCounter();
            drawFrame(animIndex);
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
