/**
 * realtime_tdr.js — Real-Time TDR Visualization Tab
 * ===================================================
 * Standalone module for browsing and visualizing real-time Tail Doppler
 * Radar analyses from seb.omao.noaa.gov/pub/flight/radar/.
 *
 * This file is completely independent of tc_radar_app.js — it manages
 * its own state, DOM elements, and API calls within the #realtime-section.
 *
 * Depends on: Plotly (loaded globally by index.html)
 */

(function () {
    'use strict';

    // ── Inline-SVG icon helper (Lucide-style; stroke:currentColor). ─
    // Returns an SVG string to prepend to button labels that are
    // dynamically updated via innerHTML. Keeps icons from being stripped
    // when textContent used to be reassigned to emoji+label.
    var _ICON_PATHS = {
        satellite: '<path d="M13 7 9 3 5 7l4 4"/><path d="M17 11l4 4-4 4-4-4"/><path d="M14 14 7 21"/><path d="M3.5 13.5 10 7"/>',
        plane:     '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z"/>',
        parachute: '<path d="M2 12a10 10 0 0 1 20 0"/><path d="M7 12l5 9"/><path d="M17 12l-5 9"/><path d="M12 12v9"/>',
        monitor:   '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
        dish:      '<path d="M4 10a7.31 7.31 0 0 0 10 10Z"/><path d="m9 15 3-3"/><path d="M17 13a6 6 0 0 0-6-6"/><path d="M21 13A10 10 0 0 0 11 3"/>'
    };
    function _icon(name) {
        return '<svg class="icon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (_ICON_PATHS[name] || '') + '</svg>';
    }

    // ── GA4 analytics helper ────────────────────────────────────
    function _ga(action, params) {
        if (typeof gtag === 'function') {
            try { gtag('event', action, params || {}); } catch (e) { /* silent */ }
        }
    }

    // ── Configuration ────────────────────────────────────────────
    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var RT_PREFIX = '/realtime';

    // ── State ────────────────────────────────────────────────────
    var _rtVisible = false;
    var _currentFileUrl = null;
    var _rtDataCache = {};
    var _rtCaseMeta = null;  // case_meta for current file (keyed by _currentFileUrl)
    var _rtLast3DJson = null;
    var _rtLastPlotlyData = null;
    var _rtCsMode = false;
    var _rtCsPointA = null;
    var _rtCsMouseHandler = null;
    var _rtAnimPlaying = false;
    var _rtAnimTimer = null;
    var _rtDefaultColorscale = null;
    var _rtDefaultVmin = null;
    var _rtDefaultVmax = null;

    // IR satellite imagery (GOES) state
    var _rtIRData = null;           // metadata from /realtime/ir
    var _rtIRFrameURLs = [];        // array of data-URL strings (or null)
    var _rtIRDecodedImages = [];    // pre-decoded Image objects
    var _rtIRAnimFrame = 0;
    var _rtIRAnimTimer = null;
    var _rtIRAnimPlaying = false;
    var _rtIRPlotlyVisible = false;
    var _rtIRAllLoaded = false;
    var _rtIRLoadedCount = 0;
    var _rtIRFetching = false;

    // Leaflet map state
    var _rtMap = null;
    var _rtMapMarker = null;
    var _rtIRMapOverlay = null;
    var _rtIRMapVisible = true;
    var _rtIRMapBoundsSet = false;
    var _rtMaxWind2km = null;

    // SHIPS environmental data state
    var _rtShipsData = null;      // Parsed SHIPS data from backend
    var _rtShipsLoading = false;

    // ── PNG Save helper ──────────────────────────────────────────
    // Downloads a Plotly chart div as a high-res PNG.
    window.rtSavePlotPNG = function (chartDivId, defaultName) {
        var gd = document.getElementById(chartDivId);
        if (!gd || !gd.data) { if (typeof rtToast === 'function') rtToast('No plot to save', 'warn'); return; }
        _ga('export_png', { chart: defaultName || chartDivId, module: 'realtime_tdr' });
        var fname = defaultName || chartDivId;
        // Build a timestamp suffix: YYYYMMDD_HHmmss
        var now = new Date();
        var ts = now.getFullYear() +
            String(now.getMonth() + 1).padStart(2, '0') +
            String(now.getDate()).padStart(2, '0') + '_' +
            String(now.getHours()).padStart(2, '0') +
            String(now.getMinutes()).padStart(2, '0') +
            String(now.getSeconds()).padStart(2, '0');
        Plotly.downloadImage(gd, {
            format: 'png',
            width: gd.offsetWidth * 2,
            height: gd.offsetHeight * 2,
            scale: 2,
            filename: fname + '_' + ts,
        });
    };

    // Returns an HTML string for a small camera save button.
    // posStyle: optional CSS for positioning (default: top-right absolute).
    function _rtSaveBtnHTML(chartDivId, defaultName, posStyle) {
        var pos = posStyle || 'position:absolute;top:6px;right:40px;z-index:10;';
        return '<button onclick="rtSavePlotPNG(\'' + chartDivId + '\',\'' + (defaultName || chartDivId) + '\')" ' +
            'title="Save as PNG" class="rt-save-png-btn" style="' + pos + '">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>' +
            '<circle cx="12" cy="13" r="4"/></svg></button>';
    }

    // ── Tab visibility toggle ────────────────────────────────────
    window.toggleRealtimeTab = function () {
        var section = document.getElementById('realtime-section');
        var archiveSections = document.querySelectorAll('#map-section, #about, #features, #download, #contact, footer');
        _rtVisible = !_rtVisible;
        var rtLink = document.getElementById('rt-nav-link');
        var archiveLink = document.getElementById('archive-nav-link');

        if (_rtVisible) {
            gtag('event', 'tab_click', { tab_name: 'real_time' });
            archiveSections.forEach(function (el) { el.style.display = 'none'; });
            section.style.display = 'block';
            // Transfer nav-active indicator from TC-RADAR to RT TDR
            if (archiveLink) archiveLink.classList.remove('nav-active');
            if (rtLink) rtLink.classList.add('nav-active');
            // Load missions if not yet loaded
            if (!document.getElementById('rt-mission-select').options.length ||
                document.getElementById('rt-mission-select').options[0].value === '') {
                loadMissions();
            }
        } else {
            archiveSections.forEach(function (el) { el.style.display = ''; });
            section.style.display = 'none';
            if (rtLink) rtLink.classList.remove('nav-active');
            if (archiveLink) archiveLink.classList.add('nav-active');
        }
    };

    window.showArchiveTab = function () {
        gtag('event', 'tab_click', { tab_name: 'archive' });
        if (_rtVisible) toggleRealtimeTab();
    };

    // ── Toast (reuse if available, otherwise standalone) ─────────
    function rtToast(message, type, duration) {
        if (typeof showToast === 'function') { showToast(message, type, duration); return; }
        type = type || 'info'; duration = duration || 5000;
        var container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.style.cssText = 'position:fixed;top:60px;right:16px;z-index:100000;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
            document.body.appendChild(container);
        }
        var toast = document.createElement('div');
        var bgColor = type === 'error' ? 'rgba(239,68,68,0.95)' : type === 'warn' ? 'rgba(245,158,11,0.95)' : 'rgba(14,45,90,0.95)';
        toast.style.cssText = 'background:' + bgColor + ';color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;font-family:DM Sans,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.4);border:1px solid rgba(96,165,250,0.4);pointer-events:auto;max-width:380px;opacity:0;transform:translateX(30px);transition:all 0.3s ease;';
        toast.textContent = message;
        container.appendChild(toast);
        requestAnimationFrame(function () { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
        setTimeout(function () { toast.style.opacity = '0'; toast.style.transform = 'translateX(30px)'; setTimeout(function () { toast.remove(); }, 300); }, duration);
    }

    // ── Hurricane loading animation (reuse pattern from main app) ──
    function _rtLoadingHTML(msg) {
        return '<div class="explorer-status loading" style="padding:24px 0;text-align:center;">' +
            '<div class="spinner" style="margin:0 auto 12px;"></div>' +
            '<div>' + msg + '</div></div>';
    }

    // ── Fetch with retry (handles Cloud Run cold-start 502/503) ──
    function fetchWithRetry(url, opts, retries, delay) {
        retries = retries || 3;
        delay = delay || 2000;
        return fetch(url, opts).then(function (r) {
            if ((r.status === 502 || r.status === 503) && retries > 0) {
                return new Promise(function (resolve) { setTimeout(resolve, delay); })
                    .then(function () { return fetchWithRetry(url, opts, retries - 1, delay * 1.5); });
            }
            return r;
        });
    }

    // ── Load mission list ────────────────────────────────────────
    function loadMissions() {
        var sel = document.getElementById('rt-mission-select');
        sel.innerHTML = '<option value="">Loading missions…</option>';
        sel.disabled = true;

        fetchWithRetry(API_BASE + RT_PREFIX + '/missions')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                sel.innerHTML = '<option value="">Select a mission…</option>';
                json.missions.forEach(function (m) {
                    var opt = document.createElement('option');
                    opt.value = m;
                    // Parse a readable label: e.g. "20251028H1" → "2025-10-28 H1"
                    var label = m;
                    var match = m.match(/^(\d{4})(\d{2})(\d{2})(.+)$/);
                    if (match) label = match[1] + '-' + match[2] + '-' + match[3] + ' ' + match[4];
                    opt.textContent = label;
                    sel.appendChild(opt);
                });
                sel.disabled = false;
            })
            .catch(function (err) {
                sel.innerHTML = '<option value="">Error loading missions</option>';
                rtToast('Could not load missions: ' + err.message, 'error');
            });
    }
    window._rtLoadMissions = loadMissions;

    // ── Load files for a mission ─────────────────────────────────
    function loadFiles(mission) {
        _ga('rt_select_mission', { mission: mission });
        var sel = document.getElementById('rt-file-select');
        var goBtn = document.getElementById('rt-go-btn');
        sel.innerHTML = '<option value="">Loading files…</option>';
        sel.disabled = true;
        goBtn.disabled = true;

        fetchWithRetry(API_BASE + RT_PREFIX + '/files?mission=' + encodeURIComponent(mission))
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                sel.innerHTML = '<option value="">Select an analysis…</option>';
                if (json.files.length === 0) {
                    sel.innerHTML = '<option value="">No xy analysis files found</option>';
                    return;
                }
                json.files.forEach(function (f) {
                    var opt = document.createElement('option');
                    opt.value = f.url;
                    var timeStr = f.time_label;
                    if (timeStr.length === 4) {
                        timeStr = timeStr.substring(0, 2) + ':' + timeStr.substring(2) + ' UTC';
                    }
                    opt.textContent = timeStr + '  (' + f.filename + ')';
                    sel.appendChild(opt);
                });
                sel.disabled = false;
            })
            .catch(function (err) {
                sel.innerHTML = '<option value="">Error loading files</option>';
                rtToast('Could not list files: ' + err.message, 'error');
            });
    }

    // ── Event: mission selected ──────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        var missionSel = document.getElementById('rt-mission-select');
        var fileSel = document.getElementById('rt-file-select');
        var goBtn = document.getElementById('rt-go-btn');

        if (missionSel) {
            missionSel.addEventListener('change', function () {
                if (this.value) loadFiles(this.value);
                else {
                    fileSel.innerHTML = '<option value="">← Select a mission first</option>';
                    fileSel.disabled = true;
                    goBtn.disabled = true;
                }
            });
        }
        if (fileSel) {
            fileSel.addEventListener('change', function () {
                goBtn.disabled = !this.value;
            });
        }
    });

    // ── Go button: load the file and show viz panel ──────────────
    window.rtExploreFile = function () {
        var fileUrl = document.getElementById('rt-file-select').value;
        if (!fileUrl) return;
        _ga('rt_explore_file', { file_url: fileUrl });
        _currentFileUrl = fileUrl;
        _rtDataCache = {};
        _rtCaseMeta = null;
        _rtLast3DJson = null;
        _rtLastPlotlyData = null;
        _rtCsMode = false;
        _rtCsPointA = null;
        _rtRemoveRubberBand();

        // Reset IR state + Leaflet map
        rtIRCleanup();
        _rtCleanupMap();

        // Show the viz panel
        var panel = document.getElementById('rt-viz-panel');
        panel.style.display = 'block';

        // Reset display
        document.getElementById('rt-display-area').innerHTML = _rtLoadingHTML('Loading TDR analysis… (may take ~30s for first file)');
        document.getElementById('rt-meta-panel').innerHTML = '';
        document.getElementById('rt-cs-result').innerHTML = '';
        document.getElementById('rt-cs-status').textContent = '';
        var azResult = document.getElementById('rt-az-result'); if (azResult) azResult.innerHTML = '';
        var quadResult = document.getElementById('rt-quad-result'); if (quadResult) quadResult.innerHTML = '';
        var anomalyResult = document.getElementById('rt-anomaly-result'); if (anomalyResult) anomalyResult.innerHTML = '';
        var shipsPanel = document.getElementById('rt-ships-panel'); if (shipsPanel) shipsPanel.style.display = 'none';
        _rtShipsData = null;

        // Disable action buttons until plot renders
        var csBtn = document.getElementById('rt-cs-btn'); if (csBtn) csBtn.disabled = true;
        var volBtn = document.getElementById('rt-vol-btn'); if (volBtn) volBtn.disabled = true;
        var azBtn = document.getElementById('rt-az-btn'); if (azBtn) azBtn.disabled = true;
        var quadBtn = document.getElementById('rt-quad-btn'); if (quadBtn) quadBtn.disabled = true;
        var anomalyBtn = document.getElementById('rt-anomaly-btn'); if (anomalyBtn) anomalyBtn.disabled = true;
        var vpBtn = document.getElementById('rt-vp-btn'); if (vpBtn) vpBtn.disabled = true;
        var tiltBtn = document.getElementById('rt-tilt-btn'); if (tiltBtn) { tiltBtn.disabled = true; tiltBtn.classList.remove('active'); }
        _rtTiltData = null; _rtTiltTraceStart = -1; _rtTiltEnabled = false;

        // Generate initial plot
        rtGeneratePlot();

        // Fetch metadata display
        rtFetchMeta(fileUrl);

        // Fetch GOES IR satellite imagery in parallel
        _rtShowIRLoadingIndicator();
        rtFetchIR._retried = false;  // reset retry flag for new file
        rtFetchIR();
    };

    // ── Fetch and display metadata ───────────────────────────────
    function rtFetchMeta(fileUrl) {
        fetchWithRetry(API_BASE + RT_PREFIX + '/data?file_url=' + encodeURIComponent(fileUrl) + '&variable=' + DEFAULT_RT_VAR + '&level_km=2')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                var m = json.case_meta || {};
                _rtCaseMeta = m;  // Store for SHIPS auto-fetch
                var html = '<div class="rt-meta-title">' + (m.storm_name || 'Unknown') + '</div>' +
                    '<div class="rt-meta-row">' + (m.mission_id || '') + ' · ' + (m.datetime || '') + '</div>' +
                    '<div class="rt-meta-grid">' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Position</span><span class="rt-meta-val">' +
                    (m.latitude ? m.latitude.toFixed(2) + '°N, ' + Math.abs(m.longitude).toFixed(2) + '°' + (m.longitude < 0 ? 'W' : 'E') : '—') + '</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Radar</span><span class="rt-meta-val">' + (m.radar || 'TAIL') + '</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Resolution</span><span class="rt-meta-val">' + (m.resolution_km || 2) + ' km</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Storm Motion</span><span class="rt-meta-val">' +
                    (m.storm_motion_north_ms > -999 ? m.storm_motion_north_ms.toFixed(1) + ' N, ' + m.storm_motion_east_ms.toFixed(1) + ' E m/s' : '—') + '</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Melting Level</span><span class="rt-meta-val">' +
                    (m.melting_height_km > 0 ? m.melting_height_km.toFixed(1) + ' km' : '—') + '</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Quality</span><span class="rt-meta-val">' +
                    (m.analysis_level === '1' ? 'Real-Time' : m.analysis_level === '2' ? 'Research' : m.analysis_level || '—') + '</span></div>' +
                    '</div>';
                document.getElementById('rt-meta-panel').innerHTML = html;

                // Init Leaflet map + fetch max 2-km wind for marker
                if (m.latitude && m.longitude) {
                    _rtInitMap(m);
                    _rtFetchMaxWind(_currentFileUrl, m);
                }
            })
            .catch(function () { /* metadata will show from the plot fetch anyway */ });
    }

    // ── Default variable ─────────────────────────────────────────
    var DEFAULT_RT_VAR = 'TANGENTIAL_WIND';

    // ── Generate plan-view plot ──────────────────────────────────
    window.rtGeneratePlot = function (callback) {
        if (!_currentFileUrl) return;
        var variable = document.getElementById('rt-var').value;
        var level_km = document.getElementById('rt-level').value;
        _ga('rt_generate_plot', { variable: variable, level_km: level_km });
        var overlay = (document.getElementById('rt-overlay') || {}).value || '';
        var resultDiv = document.getElementById('rt-display-area');
        var btn = document.getElementById('rt-gen-btn');
        btn.disabled = true; btn.textContent = 'Generating…';

        // Clear dependent results
        document.getElementById('rt-cs-result').innerHTML = '';
        document.getElementById('rt-cs-status').textContent = '';
        var azResult = document.getElementById('rt-az-result'); if (azResult) azResult.innerHTML = '';

        if (!_rtAnimPlaying) {
            resultDiv.innerHTML = _rtLoadingHTML('Fetching data from API…');
        }

        var cacheKey = _currentFileUrl + '_' + variable + '_' + level_km + '_' + overlay + (_rtBarbsEnabled ? '_barbs' : '');
        if (_rtDataCache[cacheKey]) {
            rtRenderPlot(_rtDataCache[cacheKey], resultDiv);
            btn.disabled = false; btn.textContent = 'Generate Plot';
            if (callback) callback(); return;
        }

        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 120000);
        var url = API_BASE + RT_PREFIX + '/data?file_url=' + encodeURIComponent(_currentFileUrl) + '&variable=' + variable + '&level_km=' + level_km;
        if (overlay) url += '&overlay=' + overlay;
        if (_rtBarbsEnabled) url += '&wind_barbs=true';

        fetch(url, { signal: controller.signal })
            .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
            .then(function (json) { _rtDataCache[cacheKey] = json; if (json.case_meta) _rtCaseMeta = json.case_meta; rtRenderPlot(json, resultDiv); if (callback) callback(); })
            .catch(function (err) {
                var msg = err.name === 'AbortError' ? '⚠️ Request timed out (120s).' : '⚠️ ' + err.message;
                resultDiv.innerHTML = '<div class="explorer-status error">' + msg + '</div>';
                rtAnimStop();
            })
            .finally(function () { clearTimeout(timeout); btn.disabled = false; btn.textContent = 'Generate Plot'; });
    };

    // ── Max value helpers (mirrors archive findDataMax / buildMaxMarkerTrace / buildMaxAnnotation) ──
    function rtFindDataMax(zData, xCoords, yCoords) {
        var maxVal = -Infinity, maxI = 0, maxJ = 0;
        for (var i = 0; i < zData.length; i++) {
            if (!zData[i]) continue;
            for (var j = 0; j < zData[i].length; j++) {
                var v = zData[i][j];
                if (v !== null && v !== undefined && isFinite(v) && v > maxVal) {
                    maxVal = v; maxI = i; maxJ = j;
                }
            }
        }
        if (!isFinite(maxVal)) return null;
        return { value: maxVal, x: xCoords[maxJ], y: yCoords[maxI] };
    }

    function rtIsWindVariable(varName) {
        return varName && varName.toLowerCase().indexOf('wind') !== -1;
    }

    function rtBuildMaxMarkerTrace(maxInfo, units) {
        if (!maxInfo) return null;
        return {
            x: [maxInfo.x], y: [maxInfo.y], type: 'scatter', mode: 'markers',
            marker: { symbol: 'x', size: 10, color: 'white', line: { color: 'rgba(0,0,0,0.6)', width: 1.5 } },
            hoverinfo: 'text',
            hovertext: ['Max: ' + maxInfo.value.toFixed(2) + ' ' + units + '\n@ (' + maxInfo.x.toFixed(0) + ', ' + maxInfo.y.toFixed(0) + ')'],
            showlegend: false
        };
    }

    function rtBuildMaxAnnotation(maxInfo, units, xLabel, yLabel, fontSize) {
        if (!maxInfo) return null;
        var fs = fontSize || 9;
        return {
            text: '<b>Max:</b> ' + maxInfo.value.toFixed(2) + ' ' + units +
                  '  @  ' + xLabel + '=' + maxInfo.x.toFixed(0) + ', ' + yLabel + '=' + (Math.abs(maxInfo.y) < 100 ? maxInfo.y.toFixed(1) : maxInfo.y.toFixed(0)),
            xref: 'paper', yref: 'paper', x: 0.01, y: -0.01,
            xanchor: 'left', yanchor: 'top',
            showarrow: false,
            font: { color: '#d1d5db', size: fs, family: 'DM Sans, sans-serif' },
            bgcolor: 'rgba(10,22,40,0.8)',
            borderpad: 3,
            bordercolor: 'rgba(255,255,255,0.15)',
            borderwidth: 1
        };
    }

    // ── Rubber-band line for cross-section (follows mouse from A to cursor) ──
    function _rtStartRubberBand(plotDiv, pxA, pyA) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'rt-cs-rubber-band';
        svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
        var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('stroke', '#ef4444'); line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '6,4');
        line.setAttribute('x1', pxA); line.setAttribute('y1', pyA);
        svg.appendChild(line);
        var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('r', '4'); circle.setAttribute('fill', 'rgba(239,68,68,0.5)');
        circle.setAttribute('stroke', 'white'); circle.setAttribute('stroke-width', '1');
        svg.appendChild(circle);
        plotDiv.parentElement.style.position = 'relative';
        plotDiv.parentElement.appendChild(svg);
        _rtCsMouseHandler = function (e) {
            var rect = plotDiv.getBoundingClientRect();
            line.setAttribute('x2', e.clientX - rect.left);
            line.setAttribute('y2', e.clientY - rect.top);
            circle.setAttribute('cx', e.clientX - rect.left);
            circle.setAttribute('cy', e.clientY - rect.top);
        };
        plotDiv.addEventListener('mousemove', _rtCsMouseHandler);
    }

    function _rtRemoveRubberBand() {
        var svg = document.getElementById('rt-cs-rubber-band');
        if (svg) svg.remove();
        if (_rtCsMouseHandler) {
            var plotDiv = document.getElementById('rt-plotly-chart');
            if (plotDiv) plotDiv.removeEventListener('mousemove', _rtCsMouseHandler);
            _rtCsMouseHandler = null;
        }
    }

    // ── Default colormap helper: returns 'Jet' for tangential wind / wind speed ──
    function _rtDefaultCmapForVariable(varName) {
        if (varName === 'TANGENTIAL_WIND' || varName === 'WIND_SPEED') return 'Jet';
        return null; // use server default
    }

    // ── Render plan-view from JSON ───────────────────────────────
    function rtRenderPlot(json, resultDiv) {
        // Build dual-panel HTML: plan view (left) + azimuthal mean placeholder (right)
        resultDiv.innerHTML =
            '<div class="dual-panel-wrap" id="rt-dual-panel-wrap">' +
                '<div class="dual-pane" id="rt-dual-pane-left">' +
                    '<div class="dual-pane-label">Plan View</div>' +
                    '<div class="dual-pane-inner" style="position:relative;">' +
                        '<div id="rt-plotly-chart" style="width:100%;height:100%;min-height:360px;"></div>' +
                        '<button onclick="rtOpenFullscreen()" title="Expand to fullscreen" style="position:absolute;top:6px;left:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:28px;height:28px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">⛶</button>' +
                    '</div>' +
                '</div>' +
                '<div class="dual-pane-divider" title="Toggle azimuthal mean panel" onclick="_rtToggleDualPane()"></div>' +
                '<div class="dual-pane" id="rt-dual-pane-right">' +
                    '<div class="dual-pane-label">Azimuthal Mean</div>' +
                    '<div class="dual-pane-inner" id="rt-dual-az-container">' +
                        '<div class="az-pane-placeholder" id="rt-dual-az-placeholder">Generating azimuthal mean\u2026</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover for values \u00b7 scroll to zoom \u00b7 drag to pan \u00b7 \u26F6 expand</div>';

        var zData = json.data, x = json.x, y = json.y, varInfo = json.variable, meta = json.case_meta || {};
        _rtDefaultColorscale = varInfo.colorscale;
        _rtDefaultVmin = varInfo.vmin;
        _rtDefaultVmax = varInfo.vmax;

        // Determine active colorscale: user override > variable-specific default > server default
        var cmapSel = document.getElementById('rt-cmap');
        var activeColorscale = varInfo.colorscale;
        var varDefault = _rtDefaultCmapForVariable(varInfo.key || (document.getElementById('rt-var') || {}).value || '');
        if (cmapSel && cmapSel.value) { try { activeColorscale = JSON.parse(cmapSel.value); } catch (e) { activeColorscale = cmapSel.value; } }
        else if (varDefault) { activeColorscale = varDefault; }

        var activeVmin = _rtGetVmin(), activeVmax = _rtGetVmax();
        var title = (meta.storm_name || 'Real-Time TDR') + ' | ' + (meta.datetime || '') +
            '<br>' + varInfo.display_name + ' @ ' + json.actual_level_km.toFixed(1) + ' km';
        if (json.overlay) title += '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>';

        var heatmap = {
            z: zData, x: x, y: y, type: 'heatmap',
            colorscale: activeColorscale,
            zmin: activeVmin, zmax: activeVmax,
            colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: 10 } }, tickfont: { color: '#ccc', size: 9 }, thickness: 12, len: 0.85 },
            hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>X: %{x:.0f} km<br>Y: %{y:.0f} km<extra></extra>',
            hoverongaps: false
        };

        var plotBg = '#0a1628';
        var baseLayout = {
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false, scaleanchor: 'y', range: [-250, 250] },
            yaxis: { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false, range: [-250, 250] },
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } },
            showlegend: false
        };
        // RMW dashed circle on plan view, centered at WCM center (not grid origin)
        var shapes = [];
        if (json.wcm_rmw_km && !isNaN(json.wcm_rmw_km)) {
            var wcmCx = json.wcm_center_x_km || 0;
            var wcmCy = json.wcm_center_y_km || 0;
            shapes.push({ type: 'circle', xref: 'x', yref: 'y',
                x0: wcmCx - json.wcm_rmw_km, y0: wcmCy - json.wcm_rmw_km,
                x1: wcmCx + json.wcm_rmw_km, y1: wcmCy + json.wcm_rmw_km,
                line: { color: 'white', width: 1.5, dash: 'dash' } });
        }
        baseLayout.shapes = shapes;

        var layout = Object.assign({}, baseLayout, {
            title: { text: title, font: { color: '#e5e7eb', size: 11 }, y: 0.96, x: 0.5, xanchor: 'center', yanchor: 'top' },
            margin: { l: 52, r: 16, t: json.overlay ? 58 : 46, b: 44 }
        });

        var overlayTraces = rtBuildOverlayContours(json, x, y, false);
        var config = { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'], displaylogo: false };

        // Max value marker + annotation (mirrors archive renderPlotFromJSON)
        var maxInfo = rtFindDataMax(zData, x, y);
        var maxTraces = [];
        if (maxInfo) {
            var maxAnnot = rtBuildMaxAnnotation(maxInfo, varInfo.units, 'X', 'Y', 9);
            if (maxAnnot) {
                layout.annotations = (layout.annotations || []).concat([maxAnnot]);
                baseLayout.annotations = (baseLayout.annotations || []).concat([maxAnnot]);
            }
            var currentVar = (document.getElementById('rt-var') || {}).value || '';
            if (rtIsWindVariable(currentVar)) {
                var maxMarker = rtBuildMaxMarkerTrace(maxInfo, varInfo.units);
                if (maxMarker) maxTraces.push(maxMarker);
            }
        }

        // Metadata strip with compass widget (above the dual panel)
        var meta = json.case_meta || {};
        var _sd = (_rtShipsData && _rtShipsData.ships_data) ? _rtShipsData.ships_data : {};
        var _vmax = _sd.vmax_kt || meta.vmax_kt;
        var badgeParts = [];
        if (_vmax) badgeParts.push('<span style="color:' + (typeof getIntensityColor === 'function' ? getIntensityColor(_vmax) : '#ccc') + ';">' + (typeof getIntensityCategory === 'function' ? getIntensityCategory(_vmax) : '') + '</span> ' + _vmax + ' kt');
        if (json.wcm_rmw_km != null) badgeParts.push('RMW ' + json.wcm_rmw_km + ' km');
        if (json.tilt_2_6_km != null) badgeParts.push('Tilt ' + json.tilt_2_6_km + ' km');
        // Build compass from available shear/motion data
        var _rtCompassHTML = '';
        if (typeof buildShearCompassHTML === 'function') {
            // Real-time SHIPS SDDC is "where shear comes FROM"; flip 180° to match archive convention (downshear direction)
            var _shSd = (_sd.sddc != null && _sd.sddc !== 9999) ? ((_sd.sddc + 180) % 360) : null;
            var _shKt = _sd.shear_kt || null;
            var _moDir = null, _moSpd = null;
            // case_meta provides U/V storm motion (m/s); convert to met direction + kt
            var _su = meta.storm_motion_east_ms, _sv = meta.storm_motion_north_ms;
            if (_su != null && _sv != null && _su !== -999 && _sv !== -999) {
                var _spdMs = Math.sqrt(_su * _su + _sv * _sv);
                if (_spdMs > 0.1) {
                    _moSpd = Math.round(_spdMs * 1.94384 * 10) / 10;
                    var _mathAng = Math.atan2(_sv, _su) * 180 / Math.PI;
                    _moDir = ((90 - _mathAng) % 360 + 360) % 360;
                }
            }
            _rtCompassHTML = buildShearCompassHTML(_shSd, _shKt, _moDir, _moSpd, _sd.sddc);
        }
        var metaText = badgeParts.length ? '<span class="meta-text">' + badgeParts.join('  &middot;  ') + '</span>' : '';
        var _rtMetaStripHTML = '';
        if (_rtCompassHTML || metaText) {
            _rtMetaStripHTML = '<div class="dual-panel-strip">' + _rtCompassHTML + metaText + '</div>';
        }

        // Shear + motion vectors now rendered as HTML compass in the metadata strip (not in Plotly)

        // Wind barb shapes (uses archive _buildPlanViewWindBarbs if available)
        if (json.wind_barbs && typeof _buildPlanViewWindBarbs === 'function') {
            var axR = { xMin: x[0], xMax: x[x.length - 1], yMin: y[0], yMax: y[y.length - 1] };
            var barbShapes = _buildPlanViewWindBarbs(json.wind_barbs, axR);
            layout.shapes = (layout.shapes || []).concat(barbShapes);
            baseLayout.shapes = (baseLayout.shapes || []).concat(barbShapes);
        }

        // Insert metadata strip above the dual panel
        var rtDualWrap = document.getElementById('rt-dual-panel-wrap');
        if (rtDualWrap && _rtMetaStripHTML) {
            rtDualWrap.insertAdjacentHTML('beforebegin', _rtMetaStripHTML);
        }

        Plotly.newPlot('rt-plotly-chart', [heatmap].concat(overlayTraces).concat(maxTraces), layout, config);
        _rtLastPlotlyData = { heatmap: heatmap, overlayTraces: overlayTraces, maxTraces: maxTraces, baseLayout: baseLayout, title: title, config: config, json: json };

        // Auto-generate azimuthal mean in the right dual pane
        _rtAutoFetchDualAzimuthalMean();

        // Enable action buttons
        var csBtn = document.getElementById('rt-cs-btn'); if (csBtn) csBtn.disabled = false;
        var volBtn = document.getElementById('rt-vol-btn'); if (volBtn) volBtn.disabled = false;
        var azBtn = document.getElementById('rt-az-btn'); if (azBtn) azBtn.disabled = false;
        var cfadBtn = document.getElementById('rt-cfad-btn'); if (cfadBtn) cfadBtn.disabled = false;
        var tiltBtn = document.getElementById('rt-tilt-btn'); if (tiltBtn) tiltBtn.disabled = false;
        var barbBtn = document.getElementById('rt-barb-btn'); if (barbBtn) barbBtn.disabled = false;
        // Anomaly + Quadrant buttons stay disabled until SHIPS is loaded
        // (they need Vmax / SDDC from SHIPS)

        // Auto-fetch SHIPS data in background (silent — no error toast on failure)
        if (!_rtShipsData && !_rtShipsLoading) {
            _rtAutoFetchSHIPS();
        }

        // Click handler for cross-section
        document.getElementById('rt-plotly-chart').on('plotly_click', rtHandlePlotClick);
    }

    // ── Shear vector inset (uses SHIPS SDDC) ─────────────────────
    function _rtBuildShearInset(isFullsize) {
        var result = { shapes: [], annotations: [] };
        // Shear from SHIPS
        var sd = (_rtShipsData && _rtShipsData.ships_data) ? _rtShipsData.ships_data : {};
        var sddc = sd.sddc;
        var hasShear = (sddc != null && sddc !== 9999);

        // Motion: try SHIPS first, then TDR file metadata (U/V components)
        var motDir = sd.stm_heading_deg;
        var motSpd = sd.stm_speed_kt;
        var hasMotion = (motDir != null && motSpd != null && motSpd > 0);
        if (!hasMotion && _rtCaseMeta) {
            var su = _rtCaseMeta.storm_motion_east_ms;
            var sv = _rtCaseMeta.storm_motion_north_ms;
            if (su != null && sv != null && su !== -999 && sv !== -999) {
                var spdMs = Math.sqrt(su * su + sv * sv);
                if (spdMs > 0.1) {
                    motSpd = Math.round(spdMs * 1.94384 * 10) / 10; // m/s → kt
                    var mathAng = Math.atan2(sv, su) * 180 / Math.PI;
                    motDir = ((90 - mathAng) % 360 + 360) % 360;
                    hasMotion = true;
                }
            }
        }
        if (!hasShear && !hasMotion) return result;

        var cx = isFullsize ? 0.09 : 0.12;
        var cy = isFullsize ? 0.92 : 0.92;
        var r = isFullsize ? 0.060 : 0.075;
        var arrowLen = r * 0.85;
        var dotR = r * 0.07;
        var lw = isFullsize ? 2.5 : 2.5;
        var fsL = isFullsize ? 12 : 10;
        var labelGap = isFullsize ? 0.038 : 0.032;

        var shapes = [
            { type: 'circle', xref: 'paper', yref: 'paper',
              x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r,
              fillcolor: 'rgba(10,22,40,0.80)', line: { color: 'rgba(255,255,255,0.15)', width: 1 } },
            { type: 'circle', xref: 'paper', yref: 'paper',
              x0: cx - dotR, y0: cy - dotR, x1: cx + dotR, y1: cy + dotR,
              fillcolor: 'rgba(255,255,255,0.4)', line: { width: 0 } }
        ];
        var annotations = [];

        function _addArrow(theta, color) {
            var adx = arrowLen * Math.cos(theta), ady = arrowLen * Math.sin(theta);
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper',
                x0: cx - adx * 0.25, y0: cy - ady * 0.25, x1: cx + adx, y1: cy + ady,
                line: { color: color, width: lw } });
            var hl = arrowLen * 0.32, ha = 25 * Math.PI / 180;
            var tx = cx + adx, ty = cy + ady;
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper',
                x0: tx, y0: ty, x1: tx + hl * Math.cos(theta + Math.PI - ha), y1: ty + hl * Math.sin(theta + Math.PI - ha),
                line: { color: color, width: lw } });
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper',
                x0: tx, y0: ty, x1: tx + hl * Math.cos(theta + Math.PI + ha), y1: ty + hl * Math.sin(theta + Math.PI + ha),
                line: { color: color, width: lw } });
        }

        if (hasShear) _addArrow((90 - sddc) * Math.PI / 180, '#f59e0b');
        if (hasMotion) _addArrow((90 - motDir) * Math.PI / 180, '#22d3ee');

        // Compact labels: "SHR 7 kt / 276°" above, "MOT 8 kt / 29°" below
        if (hasShear) {
            var shrTxt = '<b>Shear</b>  ';
            if (sd.shear_kt != null) shrTxt += Math.round(sd.shear_kt) + ' kt / ';
            shrTxt += sddc.toFixed(0) + '\u00b0';
            annotations.push({ text: shrTxt, xref: 'paper', yref: 'paper',
                x: cx, y: cy + r + labelGap,
                showarrow: false, font: { color: '#f59e0b', size: fsL, family: 'JetBrains Mono, monospace' },
                bgcolor: 'rgba(10,22,40,0.7)', borderpad: 2 });
        }
        if (hasMotion) {
            var motTxt = '<b>Motion</b>  ' + Math.round(motSpd) + ' kt / ' + motDir.toFixed(0) + '\u00b0';
            var motY = hasShear ? cy - r - labelGap : cy + r + labelGap;
            annotations.push({ text: motTxt, xref: 'paper', yref: 'paper',
                x: cx, y: motY,
                showarrow: false, font: { color: '#22d3ee', size: fsL, family: 'JetBrains Mono, monospace' },
                bgcolor: 'rgba(10,22,40,0.7)', borderpad: 2 });
        }

        // Tag all inset shapes/annotations so we can replace them later
        shapes.forEach(function (s) { s._rtInset = true; });
        annotations.forEach(function (a) { a._rtInset = true; });
        return { shapes: shapes, annotations: annotations };
    }

    // Apply shear+motion inset to an already-rendered plan-view plot.
    // Shear/motion vectors now rendered as HTML compass in metadata strip only.
    // This function is kept as a no-op to avoid breaking callers.
    function _rtApplyShearInsetToPlot() {
        // No longer adds shear inset to Plotly; compass strip handles display
    }

    // ── Rebuild the HTML compass strip above the dual panel ───────
    // Called after SHIPS loads so shear vector is incorporated.
    function _rtUpdateCompassStrip() {
        if (typeof buildShearCompassHTML !== 'function') return;
        var sd = (_rtShipsData && _rtShipsData.ships_data) ? _rtShipsData.ships_data : {};
        // Real-time SHIPS SDDC is "where shear comes FROM"; flip 180° to match archive convention (downshear direction)
        var sddc = (sd.sddc != null && sd.sddc !== 9999) ? ((sd.sddc + 180) % 360) : null;
        var shkt = sd.shear_kt || null;

        // Motion: prefer SHIPS heading/speed, fall back to TDR U/V
        var moDir = null, moSpd = null;
        if (sd.stm_heading_deg != null && sd.stm_speed_kt != null && sd.stm_speed_kt > 0) {
            moDir = sd.stm_heading_deg;
            moSpd = sd.stm_speed_kt;
        } else if (_rtCaseMeta) {
            var su = _rtCaseMeta.storm_motion_east_ms, sv = _rtCaseMeta.storm_motion_north_ms;
            if (su != null && sv != null && su !== -999 && sv !== -999) {
                var spdMs = Math.sqrt(su * su + sv * sv);
                if (spdMs > 0.1) {
                    moSpd = Math.round(spdMs * 1.94384 * 10) / 10;
                    var mathAng = Math.atan2(sv, su) * 180 / Math.PI;
                    moDir = ((90 - mathAng) % 360 + 360) % 360;
                }
            }
        }

        var compassHTML = buildShearCompassHTML(sddc, shkt, moDir, moSpd, sd.sddc);

        // Badge text (Vmax / RMW / Tilt)
        var meta = _rtCaseMeta || {};
        var _vmax = sd.vmax_kt || meta.vmax_kt;
        var badgeParts = [];
        if (_vmax) badgeParts.push('<span style="color:' + (typeof getIntensityColor === 'function' ? getIntensityColor(_vmax) : '#ccc') + ';">' + (typeof getIntensityCategory === 'function' ? getIntensityCategory(_vmax) : '') + '</span> ' + _vmax + ' kt');
        if (_rtLastPlotlyData && _rtLastPlotlyData.json) {
            var j = _rtLastPlotlyData.json;
            if (j.wcm_rmw_km != null) badgeParts.push('RMW ' + j.wcm_rmw_km + ' km');
            if (j.tilt_2_6_km != null) badgeParts.push('Tilt ' + j.tilt_2_6_km + ' km');
        }
        var metaText = badgeParts.length ? '<span class="meta-text">' + badgeParts.join('  &middot;  ') + '</span>' : '';

        if (!compassHTML && !metaText) return;
        var newStrip = '<div class="dual-panel-strip">' + compassHTML + metaText + '</div>';

        // Replace existing strip (if any), else insert before the dual panel wrap
        var old = document.querySelector('.dual-panel-strip');
        var rtDualWrap = document.getElementById('rt-dual-panel-wrap');
        if (old) {
            old.outerHTML = newStrip;
        } else if (rtDualWrap) {
            rtDualWrap.insertAdjacentHTML('beforebegin', newStrip);
        }
    }

    // ── Overlay contours ─────────────────────────────────────────
    function rtBuildOverlayContours(json, x, y, isCS) {
        if (!json.overlay) return [];
        var ov = json.overlay;
        var ovData = isCS ? ov.cross_section : ov.data;
        if (!ovData) return [];
        try {
            var intInput = document.getElementById('rt-contour-int');
            var interval = intInput ? parseFloat(intInput.value) : NaN;
            if (isNaN(interval) || interval <= 0) {
                var flat = ovData.flat().filter(function (v) { return v !== null && !isNaN(v); });
                if (flat.length === 0) return [];
                var mn = Infinity, mx = -Infinity;
                for (var i = 0; i < flat.length; i++) { if (flat[i] < mn) mn = flat[i]; if (flat[i] > mx) mx = flat[i]; }
                interval = parseFloat(((mx - mn) / 10).toPrecision(1));
                if (!isFinite(interval) || interval <= 0) interval = (mx - mn) / 10 || 1;
            }
            var xCoord = isCS ? json.distance_km : x;
            var yCoord = isCS ? json.height_km : y;
            var baseContour = { z: ovData, x: xCoord, y: yCoord, type: 'contour', showscale: false, hoverongaps: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 9, color: 'rgba(255,255,255,0.8)' } } };
            var traces = [];
            if (ov.vmax > interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'solid' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (+)', showlegend: false }));
            if (ov.vmin < -interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (−)', showlegend: false }));
            return traces;
        } catch (e) { return []; }
    }

    // ── Colormap / color range helpers ───────────────────────────
    function _rtGetVmin() { var inp = document.getElementById('rt-vmin'); if (inp && inp.value !== '') return parseFloat(inp.value); return _rtDefaultVmin; }
    function _rtGetVmax() { var inp = document.getElementById('rt-vmax'); if (inp && inp.value !== '') return parseFloat(inp.value); return _rtDefaultVmax; }

    window.rtApplyCmap = function () {
        var sel = document.getElementById('rt-cmap'); if (!sel) return;
        var cs = sel.value;
        if (!cs && _rtDefaultColorscale) cs = _rtDefaultColorscale; if (!cs) return;
        var colorscale; try { colorscale = JSON.parse(cs); } catch (e) { colorscale = cs; }
        ['rt-plotly-chart', 'rt-fullscreen-chart', 'rt-cs-fullscreen'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && el.data && el.data.length) Plotly.restyle(el, { colorscale: [colorscale] }, [0]);
        });
    };

    window.rtApplyColorRange = function () {
        var zmin = _rtGetVmin(), zmax = _rtGetVmax(); if (zmin === null || zmax === null) return;
        ['rt-plotly-chart', 'rt-fullscreen-chart', 'rt-cs-fullscreen'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && el.data && el.data.length) Plotly.restyle(el, { zmin: [zmin], zmax: [zmax] }, [0]);
        });
    };

    window.rtResetColorRange = function () {
        var vi = document.getElementById('rt-vmin'), va = document.getElementById('rt-vmax');
        if (vi) vi.value = ''; if (va) va.value = '';
        if (_rtDefaultVmin !== null && _rtDefaultVmax !== null) {
            ['rt-plotly-chart', 'rt-fullscreen-chart', 'rt-cs-fullscreen'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el && el.data && el.data.length) Plotly.restyle(el, { zmin: [_rtDefaultVmin], zmax: [_rtDefaultVmax] }, [0]);
            });
        }
    };

    // ── Fullscreen modal (reuse the existing plotModal) ──────────
    window.rtOpenFullscreen = function () {
        if (!_rtLastPlotlyData) return;
        var modal = document.getElementById('plotModal');
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        var d = _rtLastPlotlyData;
        var fullLayout = Object.assign({}, d.baseLayout, {
            title: { text: d.title, font: { color: '#e5e7eb', size: 14 }, y: 0.97, x: 0.5, xanchor: 'center', yanchor: 'top' },
            margin: { l: 60, r: 28, t: 64, b: 52 }
        });

        // Hide cross-section panes from main app
        var csFull = document.getElementById('cs-fullscreen'); if (csFull) csFull.style.display = 'none';
        var azFull = document.getElementById('az-fullscreen'); if (azFull) azFull.style.display = 'none';
        var csDiv = document.getElementById('cs-full-divider'); if (csDiv) csDiv.style.display = 'none';
        var azDiv = document.getElementById('az-full-divider'); if (azDiv) azDiv.style.display = 'none';

        // Capture dynamic overlays (tilt, FL traces, IR images) from the live plot
        var livePlot = document.getElementById('rt-plotly-chart');
        var liveTraces = d.overlayTraces || [];
        var liveImages = [];
        if (livePlot && livePlot.data) {
            var baseCount = 1 + (d.overlayTraces || []).length + (d.maxTraces || []).length;
            if (livePlot.data.length > baseCount) {
                var extraTraces = livePlot.data.slice(baseCount).map(function(t) {
                    return Object.assign({}, t);
                });
                liveTraces = liveTraces.concat(extraTraces);
            }
            if (livePlot.layout && livePlot.layout.images && livePlot.layout.images.length > 0) {
                liveImages = livePlot.layout.images.map(function(img) {
                    return Object.assign({}, img);
                });
            }
        }
        if (liveImages.length > 0) {
            fullLayout.images = liveImages;
        }

        // Adjust main colorbar if tilt traces are present
        var hasTilt = liveTraces.some(function(t) { return t.marker && t.marker.colorbar && t.marker.colorbar.title && t.marker.colorbar.title.text === 'Tilt Height (km)'; });
        if (hasTilt) {
            var fullHeatmap = Object.assign({}, d.heatmap, {
                colorbar: Object.assign({}, d.heatmap.colorbar, {
                    len: 0.42, y: 0.98, yanchor: 'top', x: 1.01, xpad: 2
                })
            });
            Plotly.newPlot('plotly-fullscreen', [fullHeatmap].concat(liveTraces).concat(d.maxTraces || []), fullLayout, d.config);
        } else {
            Plotly.newPlot('plotly-fullscreen', [d.heatmap].concat(liveTraces).concat(d.maxTraces || []), fullLayout, d.config);
        }
        document.getElementById('plotly-fullscreen').on('plotly_click', rtHandlePlotClick);
    };

    // ── Height animation ─────────────────────────────────────────
    window.rtAnimToggle = function () { if (_rtAnimPlaying) rtAnimStop(); else rtAnimStart(); };
    function rtAnimStart() {
        _rtAnimPlaying = true;
        var btn = document.getElementById('rt-anim-play'); if (btn) { btn.textContent = '⏸'; btn.classList.add('active'); }
        rtAnimTick();
    }
    function rtAnimStop() {
        _rtAnimPlaying = false;
        if (_rtAnimTimer) { clearTimeout(_rtAnimTimer); _rtAnimTimer = null; }
        var btn = document.getElementById('rt-anim-play'); if (btn) { btn.textContent = '▶'; btn.classList.remove('active'); }
    }
    function rtAnimTick() {
        if (!_rtAnimPlaying) return;
        rtGeneratePlot(function () {
            if (!_rtAnimPlaying) return;
            _rtAnimTimer = setTimeout(function () { rtAnimStep(1); rtAnimTick(); }, 800);
        });
    }
    window.rtAnimStep = function (dir) {
        var slider = document.getElementById('rt-level'); if (!slider) return;
        var val = parseFloat(slider.value) + dir * 0.5;
        if (val > 18) val = 0; if (val < 0) val = 18;
        slider.value = val;
        document.getElementById('rt-level-val').textContent = val.toFixed(1) + ' km';
        if (!_rtAnimPlaying) rtGeneratePlot();
    };

    // ── Cross-section ────────────────────────────────────────────
    window.rtToggleCrossSection = function () {
        _rtCsMode = !_rtCsMode; _rtCsPointA = null; _rtRemoveRubberBand();
        var btn = document.getElementById('rt-cs-btn'), status = document.getElementById('rt-cs-status');
        if (_rtCsMode) {
            btn.classList.add('active'); btn.textContent = '✂ Click point A on plot…';
            if (status) status.textContent = 'Click the starting point on the plan view above';
        } else {
            btn.classList.remove('active'); btn.textContent = '✂ Cross Section';
            if (status) status.textContent = '';
        }
    };

    function rtHandlePlotClick(eventData) {
        if (!_rtCsMode || !eventData.points || !eventData.points.length) return;
        var pt = eventData.points[0], x = pt.x, y = pt.y;
        var status = document.getElementById('rt-cs-status');
        var plotDiv = document.getElementById('rt-plotly-chart');

        if (!_rtCsPointA) {
            _rtCsPointA = { x: x, y: y };
            var btn = document.getElementById('rt-cs-btn'); if (btn) btn.textContent = '✂ Click point B…';
            if (status) status.textContent = 'A: (' + x.toFixed(0) + ', ' + y.toFixed(0) + ') km — now click end point';
            var shapes = (plotDiv.layout.shapes || []).slice();
            shapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: x - 4, y0: y - 4, x1: x + 4, y1: y + 4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } });
            Plotly.relayout(plotDiv, { shapes: shapes });
            // Start rubber-band line from Point A to cursor
            var rect = plotDiv.getBoundingClientRect();
            _rtStartRubberBand(plotDiv, eventData.event.clientX - rect.left, eventData.event.clientY - rect.top);
        } else {
            var a = _rtCsPointA, b = { x: x, y: y };
            _rtCsMode = false; _rtCsPointA = null; _rtRemoveRubberBand();
            var btn2 = document.getElementById('rt-cs-btn'); if (btn2) { btn2.classList.remove('active'); btn2.textContent = '✂ Cross Section'; }
            if (status) status.textContent = 'A→B: (' + a.x.toFixed(0) + ',' + a.y.toFixed(0) + ') → (' + b.x.toFixed(0) + ',' + b.y.toFixed(0) + ') km';
            var shapes2 = (plotDiv.layout.shapes || []).slice();
            shapes2.push(
                { type: 'line', xref: 'x', yref: 'y', x0: a.x, y0: a.y, x1: b.x, y1: b.y, line: { color: '#ef4444', width: 2.5 } },
                { type: 'circle', xref: 'x', yref: 'y', x0: b.x - 4, y0: b.y - 4, x1: b.x + 4, y1: b.y + 4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } }
            );
            Plotly.relayout(plotDiv, { shapes: shapes2 });
            rtFetchCrossSection(a, b);
        }
    }

    function rtFetchCrossSection(a, b) {
        _ga('rt_cross_section', {});
        var variable = document.getElementById('rt-var').value;
        var overlay = (document.getElementById('rt-overlay') || {}).value || '';
        var csResult = document.getElementById('rt-cs-result');
        csResult.innerHTML = _rtLoadingHTML('Computing cross-section…');

        var url = API_BASE + RT_PREFIX + '/cross_section?file_url=' + encodeURIComponent(_currentFileUrl) +
            '&variable=' + variable + '&x0=' + a.x + '&y0=' + a.y + '&x1=' + b.x + '&y1=' + b.y + '&n_points=150';
        if (overlay) url += '&overlay=' + overlay;

        fetch(url)
            .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
            .then(function (json) {
                csResult.innerHTML = '<div class="explorer-status" style="color:#10b981;">✓ Cross-section ready</div>';
                rtRenderCrossSection(json);
            })
            .catch(function (err) { csResult.innerHTML = '<div class="explorer-status error">⚠️ ' + err.message + '</div>'; });
    }

    function rtRenderCrossSection(json) {
        // Render inline below the plan view
        var csResult = document.getElementById('rt-cs-result');
        csResult.innerHTML = '<div style="position:relative;"><div id="rt-cs-chart" style="width:100%;height:300px;border-radius:6px;overflow:hidden;margin-top:8px;"></div>' +
            _rtSaveBtnHTML('rt-cs-chart', 'TDR_CrossSection', 'position:absolute;top:14px;right:6px;z-index:10;') + '</div>';

        var csData = json.cross_section, dist = json.distance_km, hgt = json.height_km, vi = json.variable, ep = json.endpoints;

        var cmapSel = document.getElementById('rt-cmap');
        var csColorscale = vi.colorscale;
        var csVarDefault = _rtDefaultCmapForVariable(vi.key || (document.getElementById('rt-var') || {}).value || '');
        if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch (e) { csColorscale = cmapSel.value; } }
        else if (csVarDefault) { csColorscale = csVarDefault; }
        var av = _rtGetVmin(), avx = _rtGetVmax();

        var heatmap = {
            z: csData, x: dist, y: hgt, type: 'heatmap',
            colorscale: csColorscale,
            zmin: av !== null ? av : vi.vmin,
            zmax: avx !== null ? avx : vi.vmax,
            colorbar: { title: { text: vi.units, font: { color: '#ccc', size: 10 } }, tickfont: { color: '#ccc', size: 9 }, thickness: 10, len: 0.85 },
            hovertemplate: '<b>' + vi.display_name + '</b>: %{z:.2f} ' + vi.units + '<br>Distance: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps: false
        };

        var title = 'Cross Section: (' + ep.x0.toFixed(0) + ',' + ep.y0.toFixed(0) + ') → (' + ep.x1.toFixed(0) + ',' + ep.y1.toFixed(0) + ') km';
        var plotBg = '#0a1628';
        var layout = {
            title: { text: title, font: { color: '#e5e7eb', size: 11 }, y: 0.97, x: 0.5, xanchor: 'center' },
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            xaxis: { title: { text: 'Distance along line (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            margin: { l: 45, r: 12, t: 44, b: 38 },
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } },
            showlegend: false
        };

        var csOverlays = rtBuildOverlayContours(json, null, null, true);
        Plotly.newPlot('rt-cs-chart', [heatmap].concat(csOverlays), layout, { responsive: true, displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'] });
    }

    // ── 3D Volume ────────────────────────────────────────────────
    window.rtFetch3DVolume = function () {
        if (!_currentFileUrl) return;
        var variable = document.getElementById('rt-var').value;
        var btn = document.getElementById('rt-vol-btn');
        btn.disabled = true; btn.innerHTML = _icon('monitor') + 'Loading…';

        var cacheKey = '3d_rt_' + _currentFileUrl + '_' + variable;
        if (_rtDataCache[cacheKey]) {
            _rtLast3DJson = _rtDataCache[cacheKey];
            rtOpen3DModal();
            btn.disabled = false; btn.innerHTML = _icon('monitor') + '3D Volume';
            return;
        }

        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 120000);
        var url = API_BASE + RT_PREFIX + '/volume?file_url=' + encodeURIComponent(_currentFileUrl) + '&variable=' + variable + '&stride=2&max_height_km=15&tilt_profile=true';

        fetch(url, { signal: controller.signal })
            .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
            .then(function (json) {
                _rtDataCache[cacheKey] = json;
                _rtLast3DJson = json;
                rtOpen3DModal();
            })
            .catch(function (err) {
                var msg = err.name === 'AbortError' ? 'Request timed out (120s).' : err.message;
                rtToast('3D Volume: ' + msg, 'error');
            })
            .finally(function () { clearTimeout(timeout); btn.disabled = false; btn.innerHTML = _icon('monitor') + '3D Volume'; });
    };

    function rtOpen3DModal() {
        _ga('rt_view_3d_volume', {});
        if (!_rtLast3DJson) return;
        // Reuse the existing vol3DModal from index.html
        // Store and swap the global _last3DJson temporarily
        var saved = window._last3DJson;
        window._last3DJson = _rtLast3DJson;

        // Call the existing open3DModal function if available
        if (typeof open3DModal === 'function') {
            open3DModal();
        }
        // Note: we don't restore saved because the modal references _last3DJson
        // while it's open. It'll be overwritten next time the archive mode uses it.
    }

    // ══════════════════════════════════════════════════════════════
    // Leaflet Map + IR Overlay Module
    // ══════════════════════════════════════════════════════════════

    // Wind-speed intensity color (m/s thresholds, mirrors archive kt thresholds)
    function _rtWindColor(wspd_ms) {
        if (wspd_ms == null || isNaN(wspd_ms)) return '#6b7280';
        if (wspd_ms < 17.5) return '#60a5fa';  // TD
        if (wspd_ms < 33.0) return '#34d399';  // TS
        if (wspd_ms < 43.0) return '#fbbf24';  // Cat 1
        if (wspd_ms < 49.5) return '#fb923c';  // Cat 2
        if (wspd_ms < 58.0) return '#f87171';  // Cat 3
        if (wspd_ms < 70.5) return '#ef4444';  // Cat 4
        return '#dc2626';                       // Cat 5
    }
    function _rtWindCategory(wspd_ms) {
        if (wspd_ms == null || isNaN(wspd_ms)) return '';
        if (wspd_ms < 17.5) return 'TD';
        if (wspd_ms < 33.0) return 'TS';
        if (wspd_ms < 43.0) return 'Cat 1';
        if (wspd_ms < 49.5) return 'Cat 2';
        if (wspd_ms < 58.0) return 'Cat 3';
        if (wspd_ms < 70.5) return 'Cat 4';
        return 'Cat 5';
    }

    function _rtInitMap(meta) {
        var wrapper = document.getElementById('rt-map-wrapper');
        if (!wrapper) return;

        if (_rtMap) {
            // Recenter existing map
            _rtMap.setView([meta.latitude, meta.longitude], 6, { animate: true });
            return;
        }

        _rtMap = L.map('rt-map', {
            center: [meta.latitude, meta.longitude],
            zoom: 6,
            zoomControl: true
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 12
        }).addTo(_rtMap);
    }

    function _rtUpdateMapMarker(meta, maxWind) {
        if (!_rtMap) return;
        if (_rtMapMarker) { _rtMap.removeLayer(_rtMapMarker); _rtMapMarker = null; }

        var color = _rtWindColor(maxWind);
        var cat = _rtWindCategory(maxWind);
        var icon = L.divIcon({
            className: 'custom-div-icon',
            html: '<div class="custom-marker" style="background-color:' + color +
                ';width:16px;height:16px;box-shadow:0 0 0 4px rgba(37,99,235,0.35);border-radius:50%;"></div>',
            iconSize: [16, 16], iconAnchor: [8, 8]
        });

        _rtMapMarker = L.marker([meta.latitude, meta.longitude], { icon: icon }).addTo(_rtMap);

        var windStr = maxWind != null ? maxWind.toFixed(1) + ' m/s' : 'N/A';
        var catStr = cat ? ' (' + cat + ')' : '';
        var popupHtml =
            '<div style="font-family:DM Sans,sans-serif;font-size:12px;line-height:1.5;min-width:180px;">' +
            '<strong style="font-size:14px;color:' + color + ';">' + (meta.storm_name || 'Unknown') + '</strong><br>' +
            '<span style="color:#aaa;">' + (meta.mission_id || '') + ' · ' + (meta.datetime || '') + '</span><br>' +
            '<span style="margin-top:4px;display:inline-block;">Max 2-km Wind: <strong style="color:' + color + ';">' + windStr + catStr + '</strong></span><br>' +
            '<span style="color:#aaa;font-size:10px;">' +
            (meta.latitude ? meta.latitude.toFixed(2) + '°N, ' + Math.abs(meta.longitude).toFixed(2) + '°' + (meta.longitude < 0 ? 'W' : 'E') : '') +
            '</span></div>';
        _rtMapMarker.bindPopup(popupHtml, { maxWidth: 280, minWidth: 200 });
    }

    function _rtFetchMaxWind(fileUrl, meta) {
        // Fetch WIND_SPEED at 2 km to get max wind for the marker
        var url = API_BASE + RT_PREFIX + '/data?file_url=' + encodeURIComponent(fileUrl) +
            '&variable=WIND_SPEED&level_km=2';
        fetch(url)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                var maxVal = -Infinity;
                var zData = json.data;
                for (var i = 0; i < zData.length; i++) {
                    if (!zData[i]) continue;
                    for (var j = 0; j < zData[i].length; j++) {
                        var v = zData[i][j];
                        if (v !== null && v !== undefined && isFinite(v) && v > maxVal) maxVal = v;
                    }
                }
                _rtMaxWind2km = isFinite(maxVal) ? maxVal : null;
                _rtUpdateMapMarker(meta, _rtMaxWind2km);
            })
            .catch(function () {
                _rtMaxWind2km = null;
                _rtUpdateMapMarker(meta, null);
            });
    }

    // ── IR overlay on Leaflet map ────────────────────────────────
    function _rtShowIROnMap(frameIdx) {
        if (!_rtMap || !_rtIRData || !_rtIRFrameURLs.length) return;
        var idx = (frameIdx !== undefined) ? frameIdx : _rtIRAnimFrame;
        idx = Math.max(0, Math.min(idx, _rtIRFrameURLs.length - 1));
        var url = _rtIRFrameURLs[idx];
        if (!url) return;

        var bd = _rtIRData.bounds_deg;
        if (!bd) return;
        var bounds = L.latLngBounds(
            [bd.lat_min, bd.lon_min],
            [bd.lat_max, bd.lon_max]
        );

        if (_rtIRMapOverlay) {
            // Fast path: swap image src directly (most reliable for data-URLs)
            var imgEl = _rtIRMapOverlay.getElement ? _rtIRMapOverlay.getElement() : _rtIRMapOverlay._image;
            if (imgEl) { imgEl.src = url; }
            else { _rtIRMapOverlay.setUrl(url); }
            // Always update bounds — they change when switching analysis files
            _rtIRMapOverlay.setBounds(bounds);
        } else {
            _rtIRMapOverlay = L.imageOverlay(url, bounds, {
                opacity: 0.75, interactive: false, zIndex: 200
            });
            if (_rtIRMapVisible) _rtIRMapOverlay.addTo(_rtMap);
        }
    }

    function _rtRemoveIRFromMap() {
        if (_rtIRMapOverlay && _rtMap) {
            _rtMap.removeLayer(_rtIRMapOverlay);
            _rtIRMapOverlay = null;
        }
        _rtIRMapBoundsSet = false;
        // Remove map IR controls
        var ctrl = document.getElementById('rt-map-ir-controls');
        if (ctrl) ctrl.remove();
    }

    window.rtToggleMapIRVisibility = function () {
        _rtIRMapVisible = !_rtIRMapVisible;
        if (_rtIRMapVisible && _rtIRMapOverlay) {
            _rtIRMapOverlay.addTo(_rtMap);
        } else if (!_rtIRMapVisible && _rtIRMapOverlay && _rtMap) {
            _rtMap.removeLayer(_rtIRMapOverlay);
        }
        var btn = document.getElementById('rt-map-ir-toggle');
        if (btn) btn.innerHTML = _icon('satellite') + (_rtIRMapVisible ? 'IR On' : 'IR Off');
    };

    window.rtMapIRAnimStep = function (dir) {
        if (!_rtIRData || _rtIRLoadedCount < 2) return;
        var n = _rtIRFrameURLs.length;
        for (var i = 0; i < n; i++) {
            _rtIRAnimFrame = (_rtIRAnimFrame + dir + n) % n;
            if (_rtIRFrameURLs[_rtIRAnimFrame]) break;
        }
        _rtShowIROnMap(_rtIRAnimFrame);
        rtIRShowFrame(_rtIRAnimFrame);
        _rtUpdateMapIRSlider();
    };

    function _rtUpdateMapIRSlider() {
        var slider = document.getElementById('rt-map-ir-slider');
        var label = document.getElementById('rt-map-ir-label');
        if (!_rtIRData) return;
        var n = _rtIRData.n_frames || 17;
        if (slider) slider.value = (n - 1) - _rtIRAnimFrame;
        if (label && _rtIRData.frame_datetimes && _rtIRData.frame_datetimes[_rtIRAnimFrame]) {
            var lag = _rtIRData.lag_minutes ? _rtIRData.lag_minutes[_rtIRAnimFrame] : 0;
            var lagStr = lag === 0 ? 't=0' : 't−' + Math.floor(lag / 60) + ':' + ('0' + (lag % 60)).slice(-2);
            label.textContent = 'IR ' + lagStr + ' | ' + _rtIRData.frame_datetimes[_rtIRAnimFrame];
        }
    }

    function _rtInjectMapIRControls() {
        if (document.getElementById('rt-map-ir-controls')) return;
        var wrapper = document.getElementById('rt-map-wrapper');
        if (!wrapper) return;
        var n = _rtIRFrameURLs.length;
        var disabledCls = _rtIRAllLoaded ? '' : ' rt-ir-ctrl-disabled';
        var disabledAttr = _rtIRAllLoaded ? '' : ' disabled';
        var ctrl = document.createElement('div');
        ctrl.id = 'rt-map-ir-controls';
        ctrl.className = 'rt-map-ir-controls';
        ctrl.innerHTML =
            '<div class="ir-ctrl-row">' +
                '<button class="ir-ctrl-btn" id="rt-map-ir-toggle" onclick="rtToggleMapIRVisibility()">' + _icon('satellite') + 'IR On</button>' +
                '<button class="ir-ctrl-btn' + disabledCls + '" id="rt-map-ir-step-back" onclick="rtMapIRAnimStep(1)" title="Earlier">◀</button>' +
                '<button class="ir-ctrl-btn' + disabledCls + '" id="rt-map-ir-play" onclick="rtMapIRAnimToggle()" title="Play / Pause">▶</button>' +
                '<button class="ir-ctrl-btn' + disabledCls + '" id="rt-map-ir-step-fwd" onclick="rtMapIRAnimStep(-1)" title="Later">▶</button>' +
                '<input type="range" id="rt-map-ir-slider" min="0" max="' + (n - 1) + '" value="' + (n - 1) + '"' +
                    disabledAttr +
                    ' oninput="rtMapIRSliderInput(parseInt(this.max) - parseInt(this.value))" class="ir-slider">' +
                '<span class="ir-label" id="rt-map-ir-label">IR t=0</span>' +
            '</div>';
        wrapper.appendChild(ctrl);
    }

    window.rtMapIRSliderInput = function (frameIdx) {
        _rtIRAnimFrame = frameIdx;
        _rtShowIROnMap(frameIdx);
        rtIRShowFrame(frameIdx);
        _rtUpdateMapIRSlider();
    };

    // Map IR play/pause
    var _rtMapIRAnimPlaying = false;
    var _rtMapIRAnimTimer = null;

    window.rtMapIRAnimToggle = function () {
        if (_rtIRLoadedCount < 2) return;
        if (_rtMapIRAnimPlaying) {
            _rtMapIRAnimPlaying = false;
            if (_rtMapIRAnimTimer) { clearTimeout(_rtMapIRAnimTimer); _rtMapIRAnimTimer = null; }
            var btn = document.getElementById('rt-map-ir-play');
            if (btn) btn.textContent = '▶';
        } else {
            _rtMapIRAnimPlaying = true;
            // Start from oldest loaded frame
            for (var i = _rtIRFrameURLs.length - 1; i >= 0; i--) {
                if (_rtIRFrameURLs[i]) { _rtIRAnimFrame = i; break; }
            }
            _rtShowIROnMap(_rtIRAnimFrame);
            rtIRShowFrame(_rtIRAnimFrame);
            _rtUpdateMapIRSlider();
            var playBtn = document.getElementById('rt-map-ir-play');
            if (playBtn) playBtn.textContent = '⏸';
            _rtMapIRAnimTick();
        }
    };

    function _rtMapIRAnimTick() {
        if (!_rtMapIRAnimPlaying) return;
        var n = _rtIRFrameURLs.length;
        // Advance to next loaded frame (going backward = older in time)
        for (var j = 0; j < n; j++) {
            _rtIRAnimFrame = (_rtIRAnimFrame - 1 + n) % n;
            if (_rtIRFrameURLs[_rtIRAnimFrame]) break;
        }
        _rtShowIROnMap(_rtIRAnimFrame);
        rtIRShowFrame(_rtIRAnimFrame);
        _rtUpdateMapIRSlider();
        // Dwell longer on the most recent (t=0) frame
        var delay = (_rtIRAnimFrame === 0) ? 1500 : 500;
        _rtMapIRAnimTimer = setTimeout(_rtMapIRAnimTick, delay);
    }

    function _rtEnableMapIRControls() {
        ['rt-map-ir-step-back', 'rt-map-ir-play', 'rt-map-ir-step-fwd'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.remove('rt-ir-ctrl-disabled');
        });
        var slider = document.getElementById('rt-map-ir-slider');
        if (slider) slider.disabled = false;
    }

    function _rtCleanupMap() {
        _rtRemoveIRFromMap();
        _rtIRMapVisible = true;
        _rtIRMapBoundsSet = false;
        _rtMaxWind2km = null;
        if (_rtMapMarker && _rtMap) { _rtMap.removeLayer(_rtMapMarker); _rtMapMarker = null; }
        if (_rtMapIRAnimPlaying) {
            _rtMapIRAnimPlaying = false;
            if (_rtMapIRAnimTimer) { clearTimeout(_rtMapIRAnimTimer); _rtMapIRAnimTimer = null; }
        }
    }

    // ══════════════════════════════════════════════════════════════
    // Azimuthal Mean Module
    // ══════════════════════════════════════════════════════════════

    var _rtLastAzJson = null;

    // ── Dual-pane toggle for real-time ────────────────────────────
    window._rtToggleDualPane = function() {
        var wrap = document.getElementById('rt-dual-panel-wrap');
        if (!wrap) return;
        wrap.classList.toggle('collapsed');
        setTimeout(function() {
            var chart = document.getElementById('rt-plotly-chart');
            if (chart && chart.data) Plotly.Plots.resize(chart);
            var azChart = document.getElementById('rt-dual-az-chart');
            if (azChart && azChart.data) Plotly.Plots.resize(azChart);
        }, 50);
    };

    // ── Auto-fetch azimuthal mean into the right dual pane ────────
    function _rtAutoFetchDualAzimuthalMean() {
        if (!_currentFileUrl) return;
        var variable = document.getElementById('rt-var').value;
        var overlay = (document.getElementById('rt-overlay') || {}).value || '';
        var covSlider = document.getElementById('rt-az-coverage');
        var coverage = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;
        var placeholder = document.getElementById('rt-dual-az-placeholder');

        // Check cache first
        var azCacheKey = 'az_' + _currentFileUrl + '_' + variable + '_' + coverage + '_' + overlay;
        if (_rtDataCache[azCacheKey]) {
            _rtLastAzJson = _rtDataCache[azCacheKey];
            _rtRenderDualAzimuthalMean(_rtDataCache[azCacheKey]);
            var azBtn = document.getElementById('rt-az-btn'); if (azBtn) azBtn.disabled = false;
            return;
        }

        if (placeholder) placeholder.textContent = 'Generating azimuthal mean\u2026';

        var url = API_BASE + RT_PREFIX + '/azimuthal_mean?file_url=' + encodeURIComponent(_currentFileUrl) +
            '&variable=' + variable + '&coverage_min=' + coverage;
        if (overlay) url += '&overlay=' + overlay;

        var controller = new AbortController();
        var timeout = setTimeout(function() { controller.abort(); }, 120000);
        fetch(url, { signal: controller.signal })
            .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
            .then(function(json) {
                _rtDataCache[azCacheKey] = json;
                _rtLastAzJson = json;
                _rtRenderDualAzimuthalMean(json);
                var azBtn = document.getElementById('rt-az-btn'); if (azBtn) azBtn.disabled = false;
            })
            .catch(function(err) {
                var container = document.getElementById('rt-dual-az-container');
                if (container) container.innerHTML = '<div class="az-pane-placeholder" style="color:#f87171;font-style:normal;font-size:0.7rem;">' + (err.name === 'AbortError' ? 'Timed out' : err.message) + '</div>';
            })
            .finally(function() { clearTimeout(timeout); });
    }

    // ── Render azimuthal mean into the dual-pane right panel ──────
    function _rtRenderDualAzimuthalMean(json) {
        var container = document.getElementById('rt-dual-az-container');
        if (!container) return;

        var azData = json.azimuthal_mean, radius_km = json.radius_km, height_km = json.height_km;
        var varInfo = json.variable, meta = json.case_meta || {};
        var fontSize = { title:11, axis:10, tick:9, cbar:10, cbarTick:9, hover:11 };

        var cmapSel = document.getElementById('rt-cmap');
        var azColorscale = varInfo.colorscale;
        var varDefault = _rtDefaultCmapForVariable(varInfo.key || (document.getElementById('rt-var') || {}).value || '');
        if (cmapSel && cmapSel.value) { try { azColorscale = JSON.parse(cmapSel.value); } catch(e) { azColorscale = cmapSel.value; } }
        else if (varDefault) { azColorscale = varDefault; }

        var av = _rtGetVmin(), avx = _rtGetVmax();
        var heatmap = { z: azData, x: radius_km, y: height_km, type: 'heatmap', colorscale: azColorscale,
            zmin: av !== null ? av : varInfo.vmin, zmax: avx !== null ? avx : varInfo.vmax,
            colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: fontSize.cbar } }, tickfont: { color: '#ccc', size: fontSize.cbarTick }, thickness: 12, len: 0.85 },
            hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>', hoverongaps: false };

        var covPct = Math.round((json.coverage_min || 0.5) * 100);
        var title = (meta.storm_name || 'Real-Time TDR') + ' | ' + (meta.datetime || '') +
            '<br>Azimuthal Mean: ' + varInfo.display_name + ' (\u2265' + covPct + '%)';

        var shapes = [];
        if (json.wcm_rmw_km && !isNaN(json.wcm_rmw_km)) shapes.push({ type:'line',xref:'x',yref:'paper',x0:json.wcm_rmw_km,x1:json.wcm_rmw_km,y0:0,y1:1,line:{color:'white',width:1.5,dash:'dash'} });

        var plotBg = '#0a1628';
        var layout = {
            title: { text: title, font: { color: '#e5e7eb', size: fontSize.title }, y: 0.96, x: 0.5, xanchor: 'center', yanchor: 'top' },
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            xaxis: { title: { text: 'Radius (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            margin: { l: 48, r: 14, t: json.overlay ? 58 : 46, b: 44 },
            shapes: shapes,
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: fontSize.hover } },
            showlegend: false
        };

        // Overlay contours
        var azOverlayTraces = [];
        if (json.overlay && json.overlay.azimuthal_mean) {
            try {
                var ov = json.overlay, ovData = ov.azimuthal_mean;
                var flat = ovData.flat().filter(function(v) { return v !== null && !isNaN(v); });
                if (flat.length > 0) {
                    var mn = Infinity, mx = -Infinity;
                    for (var i = 0; i < flat.length; i++) { if (flat[i] < mn) mn = flat[i]; if (flat[i] > mx) mx = flat[i]; }
                    var interval = parseFloat(((mx - mn) / 10).toPrecision(1));
                    if (!isFinite(interval) || interval <= 0) interval = (mx - mn) / 10 || 1;
                    var baseContour = { z: ovData, x: radius_km, y: height_km, type: 'contour', showscale: false, hoverongaps: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 9, color: 'rgba(255,255,255,0.8)' } } };
                    if (ov.vmax > interval) azOverlayTraces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'solid' }, showlegend: false }));
                    if (ov.vmin < -interval) azOverlayTraces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, showlegend: false }));
                }
            } catch(e) { /* ignore overlay errors */ }
        }

        // Max value marker
        var azMaxInfo = rtFindDataMax(azData, radius_km, height_km);
        var azMaxTraces = [];
        if (azMaxInfo) {
            var azMaxAnnot = rtBuildMaxAnnotation(azMaxInfo, varInfo.units, 'R', 'Z', 9);
            if (azMaxAnnot) layout.annotations = (layout.annotations || []).concat([azMaxAnnot]);
            var currentVar = (document.getElementById('rt-var') || {}).value || '';
            if (rtIsWindVariable(currentVar)) {
                var azMaxMarker = rtBuildMaxMarkerTrace(azMaxInfo, varInfo.units);
                if (azMaxMarker) azMaxTraces.push(azMaxMarker);
            }
        }

        container.innerHTML = '<div id="rt-dual-az-chart" style="width:100%;height:100%;min-height:320px;"></div>';
        Plotly.newPlot('rt-dual-az-chart', [heatmap].concat(azOverlayTraces).concat(azMaxTraces), layout, { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d','select2d','toggleSpikelines'], displaylogo: false });
    }

    // Coverage slider display update
    (function () {
        var slider = document.getElementById('rt-az-coverage');
        var label = document.getElementById('rt-az-cov-val');
        if (slider && label) {
            slider.addEventListener('input', function () { label.textContent = this.value + '%'; });
        }
    })();

    window.rtFetchAzimuthalMean = function () {
        if (!_currentFileUrl) return;
        var variable = document.getElementById('rt-var').value;
        var overlay = (document.getElementById('rt-overlay') || {}).value || '';
        var covSlider = document.getElementById('rt-az-coverage');
        var coverage = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;
        var resultDiv = document.getElementById('rt-az-result');
        var btn = document.getElementById('rt-az-btn');

        // Check cache first
        var azCacheKey = 'az_' + _currentFileUrl + '_' + variable + '_' + coverage + '_' + overlay;
        if (_rtDataCache[azCacheKey]) {
            _rtLastAzJson = _rtDataCache[azCacheKey];
            rtRenderAzimuthalMean(_rtDataCache[azCacheKey]);
            return;
        }

        resultDiv.innerHTML = _rtLoadingHTML('Computing azimuthal mean…');
        btn.disabled = true; btn.textContent = '↻ Computing…';

        var url = API_BASE + RT_PREFIX + '/azimuthal_mean?file_url=' + encodeURIComponent(_currentFileUrl) +
            '&variable=' + variable + '&coverage_min=' + coverage;
        if (overlay) url += '&overlay=' + overlay;

        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 120000);
        fetch(url, { signal: controller.signal })
            .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
            .then(function (json) { _rtDataCache[azCacheKey] = json; _rtLastAzJson = json; rtRenderAzimuthalMean(json); })
            .catch(function (err) {
                resultDiv.innerHTML = '<div class="explorer-status error">⚠️ ' + (err.name === 'AbortError' ? 'Request timed out (120s).' : err.message) + '</div>';
            })
            .finally(function () { clearTimeout(timeout); btn.disabled = false; btn.textContent = '↻ Azimuthal Mean'; });
    };

    function rtRenderAzimuthalMean(json) {
        var resultDiv = document.getElementById('rt-az-result');
        resultDiv.innerHTML = '<div style="position:relative;"><div id="rt-az-chart" style="width:100%;height:340px;border-radius:6px;overflow:hidden;margin-top:8px;"></div>' +
            _rtSaveBtnHTML('rt-az-chart', 'TDR_AzMean') +
            '<button onclick="rtOpenFullscreen()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">⛶</button></div>' +
            '<div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Radius–height azimuthal mean · hover for values · ⛶ expand</div>';

        var azData = json.azimuthal_mean, radius_km = json.radius_km, height_km = json.height_km;
        var varInfo = json.variable, meta = json.case_meta || {};
        var covPct = Math.round((json.coverage_min || 0.5) * 100);

        // Determine active colorscale
        var cmapSel = document.getElementById('rt-cmap');
        var azColorscale = varInfo.colorscale;
        var varDefault = _rtDefaultCmapForVariable(varInfo.key || (document.getElementById('rt-var') || {}).value || '');
        if (cmapSel && cmapSel.value) { try { azColorscale = JSON.parse(cmapSel.value); } catch (e) { azColorscale = cmapSel.value; } }
        else if (varDefault) { azColorscale = varDefault; }

        var av = _rtGetVmin(), avx = _rtGetVmax();

        var heatmap = {
            z: azData, x: radius_km, y: height_km, type: 'heatmap',
            colorscale: azColorscale,
            zmin: av !== null ? av : varInfo.vmin,
            zmax: avx !== null ? avx : varInfo.vmax,
            colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: 10 } }, tickfont: { color: '#ccc', size: 9 }, thickness: 10, len: 0.85 },
            hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps: false
        };

        var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
        var title = (meta.storm_name || 'Real-Time TDR') + ' | ' + (meta.datetime || '') +
            '<br>Azimuthal Mean: ' + varInfo.display_name + ' (≥' + covPct + '% coverage)' + overlayLabel;

        var plotBg = '#0a1628';
        var layout = {
            title: { text: title, font: { color: '#e5e7eb', size: 10 }, y: 0.97, x: 0.5, xanchor: 'center' },
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            xaxis: { title: { text: 'Radius (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            margin: { l: 48, r: 12, t: json.overlay ? 66 : 52, b: 38 },
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } },
            showlegend: false
        };

        // Overlay contours
        var azOverlayTraces = [];
        if (json.overlay && json.overlay.azimuthal_mean) {
            try {
                var ov = json.overlay, ovData = ov.azimuthal_mean;
                var flat = ovData.flat().filter(function (v) { return v !== null && !isNaN(v); });
                if (flat.length > 0) {
                    var mn = Infinity, mx = -Infinity;
                    for (var i = 0; i < flat.length; i++) { if (flat[i] < mn) mn = flat[i]; if (flat[i] > mx) mx = flat[i]; }
                    var interval = parseFloat(((mx - mn) / 10).toPrecision(1));
                    if (!isFinite(interval) || interval <= 0) interval = (mx - mn) / 10 || 1;
                    var baseContour = { z: ovData, x: radius_km, y: height_km, type: 'contour', showscale: false, hoverongaps: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 9, color: 'rgba(255,255,255,0.8)' } } };
                    if (ov.vmax > interval) azOverlayTraces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'solid' }, showlegend: false }));
                    if (ov.vmin < -interval) azOverlayTraces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, showlegend: false }));
                }
            } catch (e) { /* ignore overlay errors */ }
        }

        // Max value annotation for azimuthal mean
        var azMaxInfo = rtFindDataMax(azData, radius_km, height_km);
        var azMaxTraces = [];
        if (azMaxInfo) {
            var azMaxAnnot = rtBuildMaxAnnotation(azMaxInfo, varInfo.units, 'R', 'Z', 8);
            if (azMaxAnnot) layout.annotations = (layout.annotations || []).concat([azMaxAnnot]);
            var currentVar = (document.getElementById('rt-var') || {}).value || '';
            if (rtIsWindVariable(currentVar)) {
                var azMaxMarker = rtBuildMaxMarkerTrace(azMaxInfo, varInfo.units);
                if (azMaxMarker) azMaxTraces.push(azMaxMarker);
            }
        }

        var config = { responsive: true, displayModeBar: false, displaylogo: false };
        Plotly.newPlot('rt-az-chart', [heatmap].concat(azOverlayTraces).concat(azMaxTraces), layout, config);
    }

    // ══════════════════════════════════════════════════════════════
    // GOES IR Satellite Imagery Module
    // ══════════════════════════════════════════════════════════════

    // ── Cleanup ──────────────────────────────────────────────────
    // ── IR loading indicator on map (matches archive focus mode) ──
    function _rtShowIRLoadingIndicator() {
        if (document.getElementById('rt-ir-loading-indicator')) return;
        var wrapper = document.getElementById('rt-map-wrapper');
        if (!wrapper) return;
        var div = document.createElement('div');
        div.id = 'rt-ir-loading-indicator';
        div.style.cssText = 'position:absolute;top:14px;left:14px;z-index:999;' +
            'background:rgba(10,22,40,0.88);backdrop-filter:blur(6px);' +
            'border:1px solid rgba(96,165,250,0.25);border-radius:8px;' +
            'padding:8px 16px;display:flex;align-items:center;gap:8px;';
        div.innerHTML =
            '<div style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.15);' +
            'border-top:2px solid #60a5fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
            '<span id="rt-ir-loading-text" style="font-size:11px;color:#93c5fd;font-family:\'JetBrains Mono\',monospace;">' +
            'Loading IR satellite\u2026</span>';
        wrapper.appendChild(div);
    }
    function _rtRemoveIRLoadingIndicator() {
        var el = document.getElementById('rt-ir-loading-indicator');
        if (el) el.remove();
    }
    function _rtUpdateIRLoadingText(msg) {
        var el = document.getElementById('rt-ir-loading-text');
        if (el) el.textContent = msg;
    }

    function rtIRCleanup() {
        rtIRAnimStop();
        _rtRemoveIRFromMap();
        _rtRemoveIRLoadingIndicator();
        if (_rtMapIRAnimPlaying) {
            _rtMapIRAnimPlaying = false;
            if (_rtMapIRAnimTimer) { clearTimeout(_rtMapIRAnimTimer); _rtMapIRAnimTimer = null; }
        }
        _rtIRData = null;
        _rtIRFrameURLs = [];
        _rtIRDecodedImages = [];
        _rtIRAnimFrame = 0;
        _rtIRPlotlyVisible = false;
        _rtIRAllLoaded = false;
        _rtIRLoadedCount = 0;
        _rtIRFetching = false;
        _rtIRMapBoundsSet = false;
        var irBtn = document.getElementById('rt-ir-underlay-btn');
        if (irBtn) { irBtn.disabled = true; irBtn.innerHTML = _icon('satellite') + 'IR Off'; irBtn.classList.remove('active'); }
    }

    // ── Helper: show IR on map, with retry if map not ready yet ──
    function _rtShowIROnMapWhenReady(irJson, attempt) {
        attempt = attempt || 0;
        // Bail if IR state was cleaned up (user navigated away)
        if (!_rtIRData || !irJson.frame0) {
            _rtRemoveIRLoadingIndicator();
            return;
        }
        if (_rtMap) {
            _rtShowIROnMap(0);
            _rtInjectMapIRControls();
            _rtUpdateMapIRSlider();
            rtIRShowFrame(0);
            // Replace loading spinner with frame progress
            _rtUpdateIRLoadingText('IR t=0 loaded \u2014 fetching frames\u2026');
        } else if (attempt < 20) {
            // Map not ready yet — retry in 500ms (up to 10 seconds)
            _rtUpdateIRLoadingText('Waiting for map\u2026');
            setTimeout(function () { _rtShowIROnMapWhenReady(irJson, attempt + 1); }, 500);
        } else {
            _rtRemoveIRLoadingIndicator();
        }
    }

    // ── Two-phase IR fetch ───────────────────────────────────────
    function rtFetchIR() {
        _ga('rt_fetch_ir', {});
        if (!_currentFileUrl || _rtIRFetching) return;
        _rtIRFetching = true;
        _rtIRAllLoaded = false;
        _rtIRLoadedCount = 0;

        var url = API_BASE + RT_PREFIX + '/ir?file_url=' + encodeURIComponent(_currentFileUrl);

        // Abort after 45s to prevent browser CORS-masking of timeouts
        var controller = new AbortController();
        var abortTimer = setTimeout(function () { controller.abort(); }, 45000);

        fetch(url, { signal: controller.signal })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (json) {
                _rtIRData = json;
                var n = json.n_frames || 17;
                _rtIRFrameURLs = new Array(n);
                _rtIRDecodedImages = new Array(n);
                for (var i = 0; i < n; i++) { _rtIRFrameURLs[i] = null; _rtIRDecodedImages[i] = null; }

                // Store t=0 frame
                if (json.frame0) {
                    _rtIRFrameURLs[0] = json.frame0;
                    _rtIRLoadedCount = 1;
                    _rtPreDecodeIRFrame(0, json.frame0);
                }

                // Show IR on Leaflet map + inject map controls (primary IR display)
                // Handle race condition: map may not exist yet if metadata fetch
                // hasn't completed. Retry a few times with short delays.
                _rtShowIROnMapWhenReady(json);

                // Enable the Plotly underlay button
                var irBtn = document.getElementById('rt-ir-underlay-btn');
                if (irBtn && json.frame0) irBtn.disabled = false;

                // Phase 2: fetch remaining frames in parallel
                _rtFetchIRFramesParallel(1);
            })
            .catch(function (err) {
                console.warn('RT IR fetch failed:', err);
                _rtIRFetching = false;
                _rtIRData = null;
                // Retry once after 3s (handles Cloud Run cold-start failures)
                if (!rtFetchIR._retried) {
                    rtFetchIR._retried = true;
                    console.info('RT IR: retrying in 3s\u2026');
                    setTimeout(rtFetchIR, 3000);
                } else {
                    _rtRemoveIRLoadingIndicator();
                }
            })
            .finally(function () { clearTimeout(abortTimer); });
    }
    rtFetchIR._retried = false;
    window.rtFetchIR = rtFetchIR;

    function _rtFetchIRFramesParallel(startIdx) {
        if (!_rtIRData || !_currentFileUrl) { _rtIRFetching = false; return; }
        var n = _rtIRFrameURLs.length;
        var totalToFetch = n - startIdx;
        var completedCount = 0;  // tracks ALL completed requests (success, empty, or error)

        function _checkAllDone() {
            completedCount++;
            _rtIRLoadedCount = _rtCountIRLoaded();
            _rtUpdateIRLabel();
            var statusText = 'IR frames: ' + _rtIRLoadedCount + '/' + n;
            if (completedCount >= totalToFetch && _rtIRLoadedCount < n) {
                statusText = 'IR: ' + _rtIRLoadedCount + ' of ' + n + ' available';
            }
            _rtUpdateIRLoadingText(statusText);
            if (_rtIRLoadedCount >= 2) _rtEnableIRAnimControls();
            if (_rtIRLoadedCount === 2 && !_rtMapIRAnimPlaying) {
                rtMapIRAnimToggle();
            }
            if (completedCount >= totalToFetch) {
                _rtIRAllLoaded = true;
                _rtIRFetching = false;
                _rtRemoveIRLoadingIndicator();
            }
        }

        // Fire ALL requests in parallel (original working approach)
        for (var i = startIdx; i < n; i++) {
            (function (frameIdx) {
                var url = API_BASE + RT_PREFIX + '/ir_frame?file_url=' +
                    encodeURIComponent(_currentFileUrl) + '&frame_index=' + frameIdx;
                fetch(url)
                    .then(function (r) {
                        if (!r.ok) { console.warn('IR frame ' + frameIdx + ' HTTP ' + r.status); return null; }
                        return r.json();
                    })
                    .then(function (data) {
                        if (data && data.frame) {
                            _rtIRFrameURLs[data.frame_index] = data.frame;
                            _rtPreDecodeIRFrame(data.frame_index, data.frame);
                        }
                        _checkAllDone();
                    })
                    .catch(function (err) {
                        console.warn('IR frame ' + frameIdx + ' error:', err);
                        _checkAllDone();
                    });
            })(i);
        }
    }

    function _rtPreDecodeIRFrame(idx, dataUrl) {
        var img = new Image();
        img.src = dataUrl;
        if (img.decode) img.decode().catch(function () {});
        _rtIRDecodedImages[idx] = img;
    }

    function _rtCountIRLoaded() {
        var c = 0;
        for (var i = 0; i < _rtIRFrameURLs.length; i++) { if (_rtIRFrameURLs[i]) c++; }
        return c;
    }

    function _rtEnableIRAnimControls() {
        // Enable map IR overlay controls (primary IR display)
        _rtEnableMapIRControls();
    }

    // (Standalone IR panel removed — IR is shown via Leaflet map overlay only)

    // ── Display a specific IR frame ──────────────────────────────
    window.rtIRShowFrame = function (frameIdx) {
        if (!_rtIRData || frameIdx < 0 || frameIdx >= _rtIRFrameURLs.length) return;
        _rtIRAnimFrame = frameIdx;

        // Update Leaflet map IR overlay (primary display)
        if (_rtMap && _rtIRMapVisible) _rtShowIROnMap(frameIdx);
        _rtUpdateMapIRSlider();

        // If Plotly underlay is active, update it to current frame
        if (_rtIRPlotlyVisible) _rtApplyIRUnderlay();
    };

    function _rtUpdateIRLabel() {
        // Update the map overlay IR label (only label now — standalone panel removed)
        var label = document.getElementById('rt-map-ir-label');
        if (!label || !_rtIRData) return;
        var lagMin = _rtIRData.lag_minutes ? _rtIRData.lag_minutes[_rtIRAnimFrame] : 0;
        var dtStr = _rtIRData.frame_datetimes ? _rtIRData.frame_datetimes[_rtIRAnimFrame] : '';
        var lagStr = lagMin === 0 ? 't=0' : 't\u2212' + (lagMin >= 60 ? (lagMin / 60).toFixed(1) + 'h' : lagMin + 'min');
        if (_rtIRAllLoaded) {
            label.textContent = 'IR ' + lagStr + (dtStr ? ' | ' + dtStr : '');
        } else {
            label.textContent = 'IR ' + lagStr + ' | Loading ' + _rtIRLoadedCount + '/' + _rtIRFrameURLs.length + '…';
        }
    }

    // ── Animation ────────────────────────────────────────────────
    window.rtIRAnimToggle = function () {
        if (_rtIRLoadedCount < 2) return;
        if (_rtIRAnimPlaying) { rtIRAnimStop(); }
        else {
            _rtIRAnimPlaying = true;
            // Update map play button
            var mapBtn = document.getElementById('rt-map-ir-play');
            if (mapBtn) mapBtn.textContent = '⏸';
            // Start from earliest frame (highest index)
            for (var i = _rtIRFrameURLs.length - 1; i >= 0; i--) {
                if (_rtIRFrameURLs[i]) { _rtIRAnimFrame = i; break; }
            }
            rtIRShowFrame(_rtIRAnimFrame);
            _rtIRAnimTick();
        }
    };

    function _rtIRAnimTick() {
        if (!_rtIRAnimPlaying) return;
        // Step towards t=0 (decreasing index), skip null frames
        var n = _rtIRFrameURLs.length;
        var start = _rtIRAnimFrame;
        for (var i = 0; i < n; i++) {
            _rtIRAnimFrame = (_rtIRAnimFrame - 1 + n) % n;
            if (_rtIRFrameURLs[_rtIRAnimFrame]) break;
        }
        rtIRShowFrame(_rtIRAnimFrame);

        if (_rtIRAnimFrame === 0) {
            // Pause at t=0, then loop back to earliest
            _rtIRAnimTimer = setTimeout(function () {
                for (var i = _rtIRFrameURLs.length - 1; i >= 0; i--) {
                    if (_rtIRFrameURLs[i]) { _rtIRAnimFrame = i; break; }
                }
                rtIRShowFrame(_rtIRAnimFrame);
                _rtIRAnimTimer = setTimeout(_rtIRAnimTick, 500);
            }, 1500);
        } else {
            _rtIRAnimTimer = setTimeout(_rtIRAnimTick, 500);
        }
    }

    function rtIRAnimStop() {
        _rtIRAnimPlaying = false;
        if (_rtIRAnimTimer) { clearTimeout(_rtIRAnimTimer); _rtIRAnimTimer = null; }
        var mapBtn = document.getElementById('rt-map-ir-play');
        if (mapBtn) mapBtn.textContent = '▶';
    }

    window.rtIRAnimStep = function (dir) {
        if (_rtIRLoadedCount < 2) return;
        rtIRAnimStop();
        var n = _rtIRFrameURLs.length;
        for (var i = 0; i < n; i++) {
            _rtIRAnimFrame = (_rtIRAnimFrame + dir + n) % n;
            if (_rtIRFrameURLs[_rtIRAnimFrame]) break;
        }
        rtIRShowFrame(_rtIRAnimFrame);
    };

    // ── Plotly IR Underlay Toggle ────────────────────────────────
    window.rtToggleIRUnderlay = function () {
        _rtIRPlotlyVisible = !_rtIRPlotlyVisible;
        var btn = document.getElementById('rt-ir-underlay-btn');
        if (btn) {
            btn.classList.toggle('active', _rtIRPlotlyVisible);
            btn.innerHTML = _icon('satellite') + 'IR';
        }
        if (_rtIRPlotlyVisible) {
            _rtApplyIRUnderlay();
        } else {
            _rtRemoveIRUnderlay();
        }
    };

    function _rtBuildIRPlotlyImage() {
        if (!_rtIRData || !_rtIRFrameURLs.length) return null;
        var url = _rtIRFrameURLs[_rtIRAnimFrame] || _rtIRFrameURLs[0];
        if (!url) return null;

        var bk = _rtIRData.bounds_km;
        if (!bk) return null;

        return {
            source: url,
            xref: 'x', yref: 'y',
            x: bk.x_min_km,
            y: bk.y_max_km,
            sizex: bk.x_max_km - bk.x_min_km,
            sizey: bk.y_max_km - bk.y_min_km,
            sizing: 'stretch',
            opacity: 0.35,
            layer: 'below',
            _rtIRUnderlay: true,
        };
    }

    function _rtApplyIRUnderlay() {
        var irImg = _rtBuildIRPlotlyImage();
        if (!irImg) return;
        ['rt-plotly-chart', 'rt-fullscreen-chart'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || !el.layout) return;
            var images = (el.layout.images || []).filter(function (img) { return !img._rtIRUnderlay; });
            images.push(irImg);
            Plotly.relayout(el, { images: images });
        });
    }

    function _rtRemoveIRUnderlay() {
        ['rt-plotly-chart', 'rt-fullscreen-chart'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || !el.layout) return;
            var images = (el.layout.images || []).filter(function (img) { return !img._rtIRUnderlay; });
            Plotly.relayout(el, { images: images });
        });
    }

    // ══════════════════════════════════════════════════════════════
    // Dropsonde Observations Module
    // ══════════════════════════════════════════════════════════════

    var _rtSondeData = null;           // cached API response
    var _rtSondeVisible = false;       // toggle state
    var _rtSondeMode = 'off';         // 'off' | 'on' | 'only' (three-state cycle)
    var _rtSondeMapLayers = [];        // Leaflet layers for map view
    var _rtSondeTraceCount = 0;        // number of Plotly traces added to plan-view
    var _rtSondeFetching = false;      // prevent duplicate fetches

    // ── Sonde colour palette (by index, for distinguishing multiple sondes) ──
    var _SONDE_COLORS = [
        '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9',
        '#f0abfc', '#e879f9', '#d946ef', '#c026d3', '#a855f7',
        '#fb7185', '#f43f5e', '#e11d48', '#fbbf24', '#f59e0b',
        '#34d399', '#10b981', '#06b6d4', '#22d3ee', '#67e8f9'
    ];

    function _sondeColor(idx) {
        return _SONDE_COLORS[idx % _SONDE_COLORS.length];
    }

    // ── Wind speed → colour (matching TDR convention) ────────────
    function _sondeWindColor(wspd) {
        if (wspd == null || isNaN(wspd)) return '#6b7280';
        if (wspd < 17.5) return '#60a5fa';
        if (wspd < 33.0) return '#34d399';
        if (wspd < 43.0) return '#fbbf24';
        if (wspd < 49.5) return '#fb923c';
        if (wspd < 58.0) return '#f87171';
        if (wspd < 70.5) return '#ef4444';
        return '#dc2626';
    }

    // ── Cleanup on file switch ───────────────────────────────────
    var _rt3DSondeTraceStart = -1; // starting trace index in 3D chart for sonde traces

    function _rtSondeCleanup() {
        // Restore TDR visibility if it was hidden
        if (_rtSondeMode === 'only') _rtSetTDRVisible(true);
        _rtSondeData = null;
        _rtSondeVisible = false;
        _rtSondeMode = 'off';
        _rtSondeFetching = false;
        _rtSondeTraceCount = 0;
        _rt3DSondeTraceStart = -1;
        _rtRemoveSondesFromMap();
        // Close Skew-T panel if open
        if (typeof rtCloseSkewT === 'function') rtCloseSkewT();
        // Hide table and wind panels
        var tablePanel = document.getElementById('rt-sonde-table-panel');
        if (tablePanel) { tablePanel.style.display = 'none'; tablePanel.innerHTML = ''; }
        var windPanel = document.getElementById('rt-sonde-wind-panel');
        if (windPanel) windPanel.style.display = 'none';
        try { Plotly.purge('rt-sonde-wind'); } catch (e) { /* ok */ }
        // Hide and reset sonde dropdown
        var sel = document.getElementById('rt-sonde-select');
        if (sel) { sel.style.display = 'none'; sel.disabled = true; sel.innerHTML = '<option value="">\uD83E\uDE82 Select Sonde\u2026</option>'; }
        var btn = document.getElementById('rt-sonde-btn');
        if (btn) {
            btn.disabled = true;
            btn.classList.remove('active');
            btn.classList.remove('sonde-only');
            btn.innerHTML = _icon('parachute') + 'Sondes Off';
        }
    }

    // ── Show/hide TDR heatmap + contour traces on plan-view ─────
    function _rtSetTDRVisible(vis) {
        var plotDiv = document.getElementById('rt-plotly-chart');
        if (!plotDiv || !plotDiv.data) return;
        // Trace 0 is the heatmap; any non-sonde traces after that are contours/max markers
        var tdrIndices = [];
        for (var i = 0; i < plotDiv.data.length; i++) {
            if (!plotDiv.data[i]._rtSonde) tdrIndices.push(i);
        }
        if (tdrIndices.length > 0) {
            Plotly.restyle(plotDiv, { visible: vis }, tdrIndices);
        }
    }

    // ── Toggle button handler (3-state cycle: Off → On → Only → Off) ──
    function _rtUpdateSondeBtn() {
        var btn = document.getElementById('rt-sonde-btn');
        if (!btn) return;
        var nStr = _rtSondeData ? ' (' + _rtSondeData.n_sondes + ')' : '';
        btn.classList.remove('active', 'sonde-only');
        if (_rtSondeMode === 'on') {
            btn.classList.add('active');
            btn.innerHTML = _icon('parachute') + 'Sondes' + nStr;
        } else if (_rtSondeMode === 'only') {
            btn.classList.add('active', 'sonde-only');
            btn.innerHTML = _icon('parachute') + 'Only' + nStr;
        } else {
            btn.innerHTML = _icon('parachute') + 'Sondes';
        }
    }

    window.rtToggleDropsondes = function () {
        if (_rtSondeFetching) return;

        if (!_rtSondeData && _rtSondeMode === 'off') {
            // First activation: fetch data
            _rtSondeFetching = true;
            var btn = document.getElementById('rt-sonde-btn');
            if (btn) btn.innerHTML = _icon('parachute') + 'Loading\u2026';

            fetchWithRetry(API_BASE + RT_PREFIX + '/dropsondes?file_url=' + encodeURIComponent(_currentFileUrl))
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (json) {
                    _rtSondeData = json;
                    _rtSondeFetching = false;

                    // Sort dropsondes chronologically by launch_time
                    if (json.dropsondes) {
                        json.dropsondes.sort(function(a, b) {
                            return (a.launch_time || '').localeCompare(b.launch_time || '');
                        });
                    }

                    if (json.n_sondes === 0) {
                        rtToast('No dropsondes found within \u00b145 min of analysis time' +
                            (json.message ? ' (' + json.message + ')' : ''), 'warn', 6000);
                        if (btn) btn.innerHTML = _icon('parachute') + 'No Sondes';
                        return;
                    }

                    _rtSondeVisible = true;
                    _rtSondeMode = 'on';
                    _rtUpdateSondeBtn();
                    rtToast(json.n_sondes + ' dropsonde' + (json.n_sondes > 1 ? 's' : '') + ' loaded \u2014 click again for Sondes Only', 'info', 5000);

                    _rtPopulateSondeDropdowns();
                    _rtRenderSondeTable();
                    _rtRenderSondesOnMap();
                    _rtRenderSondesOnPlot();
                })
                .catch(function (err) {
                    _rtSondeFetching = false;
                    if (btn) btn.innerHTML = _icon('parachute') + 'Sondes Off';
                    rtToast('Dropsonde fetch failed: ' + err.message, 'error');
                });
            return;
        }

        // Three-state cycle: off → on → only → off
        if (_rtSondeMode === 'off') {
            // Off → On (overlay)
            _rtSondeMode = 'on';
            _rtSondeVisible = true;
            _rtSetTDRVisible(true);
            _rtRenderSondeTable();
            _rtRenderSondesOnMap();
            _rtRenderSondesOnPlot();
        } else if (_rtSondeMode === 'on') {
            // On → Only (hide TDR, boost sondes)
            _rtSondeMode = 'only';
            _rtSondeVisible = true;
            _rtSetTDRVisible(false);
            // Re-render sondes with bolder styling
            _rtRemoveSondesFromPlot();
            _rtRenderSondesOnPlot();
        } else {
            // Only → Off
            _rtSondeMode = 'off';
            _rtSondeVisible = false;
            _rtSetTDRVisible(true);
            _rtRemoveSondesFromMap();
            _rtRemoveSondesFromPlot();
            // Close Skew-T panel and hide table/wind panels
            if (typeof rtCloseSkewT === 'function') rtCloseSkewT();
            var _tbl = document.getElementById('rt-sonde-table-panel');
            if (_tbl) { _tbl.style.display = 'none'; _tbl.innerHTML = ''; }
            var _wp = document.getElementById('rt-sonde-wind-panel');
            if (_wp) _wp.style.display = 'none';
        }
        _rtUpdateSondeBtn();
    };

    // ── Leaflet Map: Render dropsonde trajectories ───────────────
    function _rtRenderSondesOnMap() {
        _rtRemoveSondesFromMap();
        if (!_rtMap || !_rtSondeData || !_rtSondeData.dropsondes.length) return;

        _rtSondeData.dropsondes.forEach(function (sonde, idx) {
            var p = sonde.profile;
            if (!p.lat || p.lat.length < 2) return;

            var color = _sondeColor(idx);

            // Build polyline coordinates (filter nulls)
            var coords = [];
            for (var i = 0; i < p.lat.length; i++) {
                if (p.lat[i] != null && p.lon[i] != null) {
                    coords.push([p.lat[i], p.lon[i]]);
                }
            }
            if (coords.length < 2) return;

            // Trajectory polyline
            var polyline = L.polyline(coords, {
                color: color,
                weight: 2.5,
                opacity: 0.8,
                dashArray: null
            }).addTo(_rtMap);
            _rtSondeMapLayers.push(polyline);

            // Launch marker (circle — top of drop)
            var launchMarker = L.circleMarker(coords[0], {
                radius: 5,
                fillColor: color,
                fillOpacity: 0.3,
                color: color,
                weight: 2,
                opacity: 1
            }).addTo(_rtMap);
            _rtSondeMapLayers.push(launchMarker);

            // Surface marker (filled circle — bottom of drop)
            var sfcMarker = L.circleMarker(coords[coords.length - 1], {
                radius: 6,
                fillColor: color,
                fillOpacity: 0.9,
                color: '#fff',
                weight: 1.5,
                opacity: 1
            }).addTo(_rtMap);
            _rtSondeMapLayers.push(sfcMarker);

            // Compute max wind for popup
            var maxWspd = -Infinity;
            for (var w = 0; w < p.wspd.length; w++) {
                if (p.wspd[w] != null && p.wspd[w] > maxWspd) maxWspd = p.wspd[w];
            }
            var maxWspdStr = isFinite(maxWspd) ? maxWspd.toFixed(1) + ' m/s' : 'N/A';
            var windColor = isFinite(maxWspd) ? _sondeWindColor(maxWspd) : '#aaa';

            // Time offset string
            var tOffStr = sonde.time_offset_min != null ?
                (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min' : '';

            // Alt drop string
            var launchAltStr = sonde.launch.alt_m != null ? (sonde.launch.alt_m / 1000).toFixed(1) + ' km' : '?';
            var sfcAltStr = sonde.surface.alt_m != null ? (sonde.surface.alt_m / 1000).toFixed(1) + ' km' : '?';

            // Horizontal drift
            var driftKm = Math.sqrt(
                Math.pow(sonde.surface.x_km - sonde.launch.x_km, 2) +
                Math.pow(sonde.surface.y_km - sonde.launch.y_km, 2)
            ).toFixed(1);

            var popupHtml =
                '<div class="sonde-popup">' +
                '<div class="sonde-title">' + _icon('parachute') + 'Dropsonde ' + (sonde.sonde_id || '#' + (idx + 1)) + '</div>' +
                '<div class="sonde-meta">' + sonde.launch_time + ' (' + tOffStr + ' from TDR)</div>' +
                '<div class="sonde-meta">' + (sonde.platform || '') + ' / ' + (sonde.flight || '') + '</div>' +
                '<div class="sonde-stats">' +
                'Max wind: <strong style="color:' + windColor + ';">' + maxWspdStr + '</strong><br>' +
                'Alt: ' + launchAltStr + ' \u2192 ' + sfcAltStr +
                ' | Drift: <strong>' + driftKm + ' km</strong>' +
                (sonde.hit_surface ? ' | Hit sfc' : '') +
                '</div>' +
                (sonde.comments ? '<div class="sonde-comment">' + sonde.comments + '</div>' : '') +
                '</div>';

            // Bind popup to all three layers
            polyline.bindPopup(popupHtml, { maxWidth: 300, minWidth: 220 });
            launchMarker.bindPopup(popupHtml, { maxWidth: 300, minWidth: 220 });
            sfcMarker.bindPopup(popupHtml, { maxWidth: 300, minWidth: 220 });
        });
    }

    function _rtRemoveSondesFromMap() {
        _rtSondeMapLayers.forEach(function (layer) {
            if (_rtMap) _rtMap.removeLayer(layer);
        });
        _rtSondeMapLayers = [];
    }

    // ── Plan-View Plotly: Render dropsonde at current height ─────
    function _rtRenderSondesOnPlot() {
        _rtRemoveSondesFromPlot();
        if (!_rtSondeVisible || !_rtSondeData || !_rtSondeData.dropsondes.length) return;

        var plotDiv = document.getElementById('rt-plotly-chart');
        if (!plotDiv || !plotDiv.data) return;

        var currentLevel = parseFloat((document.getElementById('rt-level') || {}).value || '2');
        var traces = [];
        var isBold = (_rtSondeMode === 'only');  // bolder styling when TDR is hidden

        _rtSondeData.dropsondes.forEach(function (sonde, idx) {
            var p = sonde.profile;
            if (!p.x_km || p.x_km.length < 2) return;

            var color = _sondeColor(idx);

            // Pre-compute column-max wind, min SLP, and launch alt for all hover labels
            var colMaxWspd = -Infinity, colMinPres = Infinity;
            for (var w = 0; w < p.wspd.length; w++) {
                if (p.wspd[w] != null && p.wspd[w] > colMaxWspd) colMaxWspd = p.wspd[w];
            }
            for (var pr = 0; pr < p.pres.length; pr++) {
                if (p.pres[pr] != null && p.pres[pr] < colMinPres) colMinPres = p.pres[pr];
            }
            var maxWspdStr = isFinite(colMaxWspd) ? colMaxWspd.toFixed(1) : '?';
            var maxWindColor = isFinite(colMaxWspd) ? _sondeWindColor(colMaxWspd) : '#aaa';

            // Time offset string
            var tOffStr = sonde.time_offset_min != null ?
                (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min' : '';

            // Horizontal drift
            var driftKm = Math.sqrt(
                Math.pow(sonde.surface.x_km - sonde.launch.x_km, 2) +
                Math.pow(sonde.surface.y_km - sonde.launch.y_km, 2)
            ).toFixed(1);

            // Shared sonde label for all markers
            var sondeLabel = sonde.sonde_id || '#' + (idx + 1);

            // Full trajectory line (faded) — show basic info on hover too
            var trajX = [], trajY = [], trajHover = [];
            for (var i = 0; i < p.x_km.length; i++) {
                if (p.x_km[i] != null && p.y_km[i] != null) {
                    trajX.push(p.x_km[i]);
                    trajY.push(p.y_km[i]);
                    var hParts = ['<b>' + sondeLabel + '</b>'];
                    if (p.alt_km[i] != null) hParts.push('Alt: ' + p.alt_km[i].toFixed(1) + ' km');
                    if (p.wspd[i] != null) hParts.push('Wind: ' + p.wspd[i].toFixed(1) + ' m/s');
                    if (p.temp[i] != null) hParts.push('T: ' + p.temp[i].toFixed(1) + '\u00b0C');
                    trajHover.push(hParts.join('<br>'));
                }
            }
            traces.push({
                x: trajX, y: trajY, type: 'scatter', mode: isBold ? 'lines+markers' : 'lines',
                line: { color: color, width: isBold ? 3 : 1.5, dash: isBold ? 'solid' : 'dot' },
                marker: isBold ? { size: 3, color: color, opacity: 0.6 } : undefined,
                opacity: isBold ? 0.85 : 0.4,
                hoverinfo: 'text',
                hovertext: trajHover,
                showlegend: false,
                _rtSonde: true
            });

            // Launch marker (top)
            var launchAlt = sonde.launch.alt_m != null ? (sonde.launch.alt_m / 1000).toFixed(1) + ' km' : '?';
            traces.push({
                x: [sonde.launch.x_km], y: [sonde.launch.y_km],
                type: 'scatter', mode: 'markers',
                marker: { symbol: 'circle-open', size: isBold ? 10 : 7, color: color, line: { width: isBold ? 2.5 : 1.5, color: color } },
                hoverinfo: 'text',
                hovertext: ['<b>\uD83E\uDE82 ' + sondeLabel + ' \u2014 LAUNCH</b>' +
                    '<br>Alt: ' + launchAlt +
                    '<br>Time: ' + sonde.launch_time + (tOffStr ? ' (' + tOffStr + ')' : '') +
                    '<br>Max Wind: ' + maxWspdStr + ' m/s  |  Drift: ' + driftKm + ' km' +
                    (sonde.platform ? '<br>' + sonde.platform + ' / ' + sonde.flight : '') +
                    (sonde.comments ? '<br>' + sonde.comments : '') +
                    '<br><i>\u25B6 Click for Skew-T</i>'],
                showlegend: false,
                _rtSonde: true,
                _rtSondeIdx: idx,
                _rtSondeClickable: true
            });

            // Surface marker (bottom)
            var sfcAlt = sonde.surface.alt_m != null ? (sonde.surface.alt_m / 1000).toFixed(1) + ' km' : 'sfc';
            // Get surface wind and temp (last valid values)
            var sfcWspd = null, sfcTemp = null;
            for (var si = p.wspd.length - 1; si >= 0; si--) {
                if (sfcWspd == null && p.wspd[si] != null) sfcWspd = p.wspd[si];
                if (sfcTemp == null && p.temp[si] != null) sfcTemp = p.temp[si];
                if (sfcWspd != null && sfcTemp != null) break;
            }
            traces.push({
                x: [sonde.surface.x_km], y: [sonde.surface.y_km],
                type: 'scatter', mode: 'markers+text',
                marker: { symbol: 'diamond', size: isBold ? 11 : 8, color: color },
                text: [String(idx + 1)],
                textposition: 'top right',
                textfont: { color: color, size: isBold ? 12 : 10, family: 'monospace' },
                hoverinfo: 'text',
                hovertext: ['<b>\uD83E\uDE82 ' + sondeLabel + ' \u2014 SURFACE</b>' +
                    '<br>Alt: ' + sfcAlt +
                    (sfcWspd != null ? '<br>Sfc Wind: ' + sfcWspd.toFixed(1) + ' m/s' : '') +
                    (sfcTemp != null ? '<br>Sfc Temp: ' + sfcTemp.toFixed(1) + ' \u00b0C' : '') +
                    '<br>Max Wind: ' + maxWspdStr + ' m/s  |  Drift: ' + driftKm + ' km' +
                    (sonde.hit_surface ? '<br>Hit Surface' : '') +
                    (sonde.comments ? '<br>' + sonde.comments : '') +
                    '<br><i>\u25B6 Click for Skew-T</i>'],
                showlegend: false,
                _rtSonde: true,
                _rtSondeIdx: idx,
                _rtSondeClickable: true
            });

            // Interpolated position at current height level
            var interpPt = _rtInterpolateSondeAtLevel(p, currentLevel);
            if (interpPt) {
                // Get wind speed for color
                var wspdColor = interpPt.wspd != null ? _sondeWindColor(interpPt.wspd) : color;
                var wspdText = interpPt.wspd != null ? interpPt.wspd.toFixed(1) + ' m/s' : '';
                var hoverContent = '<b>\uD83E\uDE82 ' + sondeLabel + ' @ ' + currentLevel.toFixed(1) + ' km</b>' +
                    (wspdText ? '<br>Wind: ' + wspdText : '') +
                    (interpPt.temp != null ? '<br>Temp: ' + interpPt.temp.toFixed(1) + ' \u00b0C' : '') +
                    '<br>Max Wind: ' + maxWspdStr + ' m/s' +
                    (tOffStr ? '<br>Offset: ' + tOffStr : '') +
                    (sonde.comments ? '<br>' + sonde.comments : '') +
                    '<br><i>\u25B6 Click for Skew-T</i>';
                // Invisible larger hit-target underneath for easier clicking
                traces.push({
                    x: [interpPt.x], y: [interpPt.y],
                    type: 'scatter', mode: 'markers',
                    marker: { symbol: 'circle', size: isBold ? 30 : 24, color: 'rgba(0,0,0,0)', line: { width: 0 } },
                    hoverinfo: 'text',
                    hovertext: [hoverContent],
                    showlegend: false,
                    _rtSonde: true,
                    _rtSondeIdx: idx,
                    _rtSondeClickable: true
                });
                // Visible marker on top
                traces.push({
                    x: [interpPt.x], y: [interpPt.y],
                    type: 'scatter', mode: 'markers',
                    marker: {
                        symbol: 'circle', size: isBold ? 16 : 13, color: wspdColor,
                        line: { color: '#fff', width: isBold ? 3 : 2 }
                    },
                    hoverinfo: 'text',
                    hovertext: [hoverContent],
                    showlegend: false,
                    _rtSonde: true,
                    _rtSondeIdx: idx,
                    _rtSondeClickable: true
                });
            }
        });

        if (traces.length > 0) {
            Plotly.addTraces(plotDiv, traces);
            _rtSondeTraceCount = traces.length;

            // Attach click handler for sonde markers (only once)
            if (!plotDiv._rtSondeClickBound) {
                plotDiv.on('plotly_click', function (eventData) {
                    if (!eventData || !eventData.points || !eventData.points.length) return;
                    var pt = eventData.points[0];
                    if (pt.data && pt.data._rtSondeClickable && pt.data._rtSondeIdx != null) {
                        _rtShowSondeSkewT(pt.data._rtSondeIdx);
                    }
                });
                // Change cursor to pointer when hovering over clickable sonde markers
                plotDiv.on('plotly_hover', function (eventData) {
                    if (!eventData || !eventData.points || !eventData.points.length) return;
                    var pt = eventData.points[0];
                    if (pt.data && pt.data._rtSondeClickable) {
                        plotDiv.style.cursor = 'pointer';
                    }
                });
                plotDiv.on('plotly_unhover', function () {
                    plotDiv.style.cursor = '';
                });
                plotDiv._rtSondeClickBound = true;
            }
        }
    }

    function _rtRemoveSondesFromPlot() {
        if (_rtSondeTraceCount <= 0) return;
        var plotDiv = document.getElementById('rt-plotly-chart');
        if (!plotDiv || !plotDiv.data) return;

        // Find indices of sonde traces (from end)
        var indices = [];
        for (var i = plotDiv.data.length - 1; i >= 0; i--) {
            if (plotDiv.data[i]._rtSonde) indices.push(i);
        }
        if (indices.length > 0) {
            try { Plotly.deleteTraces(plotDiv, indices); } catch (e) { /* ignore */ }
        }
        _rtSondeTraceCount = 0;
    }

    // ── Interpolate sonde position at a given altitude ───────────
    function _rtInterpolateSondeAtLevel(profile, levelKm) {
        if (!profile.alt_km || profile.alt_km.length < 2) return null;

        // Find the two bracketing points
        var bestIdx = -1;
        var bestDist = Infinity;
        for (var i = 0; i < profile.alt_km.length; i++) {
            if (profile.alt_km[i] == null || profile.x_km[i] == null) continue;
            var dist = Math.abs(profile.alt_km[i] - levelKm);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        // Only return if within 0.5 km of the requested level
        if (bestIdx < 0 || bestDist > 0.5) return null;

        return {
            x: profile.x_km[bestIdx],
            y: profile.y_km[bestIdx],
            alt: profile.alt_km[bestIdx],
            wspd: profile.wspd[bestIdx],
            temp: profile.temp[bestIdx]
        };
    }

    // ── Update sondes when height level changes ──────────────────
    function _rtUpdateSondeLevel() {
        if (!_rtSondeVisible || !_rtSondeData) return;
        _rtRenderSondesOnPlot();
    }

    // ── Skew-T from dropsonde click ──────────────────────────────
    function _rtShowSondeSkewT(sondeIdx) {
        if (!_rtSondeData || sondeIdx < 0 || sondeIdx >= _rtSondeData.dropsondes.length) return;
        var sonde = _rtSondeData.dropsondes[sondeIdx];
        var p = sonde.profile;

        if (!p.pres || !p.temp || p.pres.length < 5) {
            rtToast('Insufficient data for Skew-T', 'warn');
            return;
        }

        // Build profiles object expected by renderSkewT():
        //   { plev: hPa[], t: Kelvin[], q: kg/kg[], u: m/s[], v: m/s[] }
        // Dropsonde has: pres (hPa), temp (°C), dewpoint (°C) or rh (%), uwnd, vwnd
        var plev = [], tK = [], qArr = [], uArr = [], vArr = [];
        var eps = 0.622;

        for (var i = 0; i < p.pres.length; i++) {
            // Need at least pressure and temperature
            if (p.pres[i] == null || p.temp[i] == null) continue;
            var pHpa = p.pres[i];
            var tCel = p.temp[i];
            if (pHpa < 50 || pHpa > 1100) continue;

            plev.push(pHpa);
            tK.push(tCel + 273.15);

            // Compute specific humidity q from dewpoint or RH
            var q = null;
            if (p.dewpoint && p.dewpoint[i] != null) {
                // From dewpoint: e = 6.112 * exp(17.67 * Td / (Td + 243.5))
                var td = p.dewpoint[i];
                var e = 6.112 * Math.exp(17.67 * td / (td + 243.5));
                if (e < pHpa) q = eps * e / (pHpa - e);
            } else if (p.rh && p.rh[i] != null) {
                // From RH: es = 6.112 * exp(17.67 * T / (T + 243.5)), e = RH/100 * es
                var es = 6.112 * Math.exp(17.67 * tCel / (tCel + 243.5));
                var e2 = (p.rh[i] / 100.0) * es;
                if (e2 < pHpa) q = eps * e2 / (pHpa - e2);
            }
            qArr.push(q);

            uArr.push(p.uwnd ? p.uwnd[i] : null);
            vArr.push(p.vwnd ? p.vwnd[i] : null);
        }

        if (plev.length < 5) {
            rtToast('Insufficient valid data for Skew-T (' + plev.length + ' levels)', 'warn');
            return;
        }

        var profiles = { plev: plev, t: tK, q: qArr, u: uArr, v: vArr };

        // Set title with platform/flight metadata (two-line format)
        var titleEl = document.getElementById('rt-skewt-title');
        if (titleEl) {
            var tOff = sonde.time_offset_min != null ?
                ' (T' + (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min)' : '';
            var platLabel = sonde.platform || '';
            var flightLabel = sonde.flight || '';
            titleEl.innerHTML =
                '\uD83E\uDE82 ' + (platLabel || '') +
                (flightLabel ? ' <span style="color:#9ca3af;">(' + flightLabel + ')</span>' : '') +
                '<br>' +
                '<span style="color:#94a3b8;">' + (sonde.sonde_id || 'Sonde ' + (sondeIdx + 1)) +
                ' \u2014 ' + sonde.launch_time + tOff + '</span>' +
                (sonde.comments ? ' <span style="color:#fbbf24;font-size:10px;">' + sonde.comments + '</span>' : '');
        }

        // Show panel
        var panel = document.getElementById('rt-sonde-skewt-panel');
        if (panel) panel.style.display = 'block';

        // Render Skew-T using the existing global renderSkewT function
        if (typeof renderSkewT === 'function') {
            renderSkewT(profiles, 'rt-sonde-skewt');
        }

        // Dynamic vertical scaling: adjust y-axis to fit the sonde's data range
        // Also rebuild wind barbs with correct aspect ratio for the new y-range
        _rtAdjustSkewTYAxis(plev, profiles);

        // Render info panel (custom for RT since _renderSkewTInfo targets a hardcoded div)
        _rtRenderSondeSkewTInfo(profiles, sonde);

        // Sync dropdown selections
        var sel = document.getElementById('rt-sonde-select');
        if (sel) sel.value = String(sondeIdx);
        var sel2 = document.getElementById('rt-skewt-sonde-select');
        if (sel2) sel2.value = String(sondeIdx);

        // Scroll into view
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ── Render dropsonde Skew-T info panel ───────────────────────
    function _rtRenderSondeSkewTInfo(profiles, sonde) {
        var el = document.getElementById('rt-sonde-skewt-info');
        if (!el) return;

        var derived = profiles._derived || {};
        var tC = profiles._tC || [];
        var tdC = profiles._tdC || [];
        var plev = profiles.plev;

        var html = '<div style="font-family:DM Sans,monospace;">';

        // Sonde metadata
        html += '<div style="color:#c4b5fd;font-weight:700;margin-bottom:6px;">' +
            '\uD83E\uDE82 ' + (sonde.sonde_id || 'Unknown') + '</div>';
        html += '<div style="margin-bottom:8px;font-size:10px;color:#8899aa;">' +
            (sonde.platform || '') + ' / ' + (sonde.flight || '') + '<br>' +
            sonde.launch_time + '<br>' +
            (sonde.comments ? '<span style="color:#fbbf24;">' + sonde.comments + '</span>' : '') +
            '</div>';

        // Derived thermodynamic parameters
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 8px;margin-bottom:10px;font-size:10px;">';

        function _val(v, unit, dp) {
            return v != null && isFinite(v) ? v.toFixed(dp || 0) + ' ' + (unit || '') : '\u2014';
        }

        html += '<div>CAPE</div><div style="color:#ef4444;font-weight:700;">' + _val(derived.cape, 'J/kg') + '</div>';
        html += '<div>CIN</div><div style="color:#60a5fa;">' + _val(derived.cin, 'J/kg') + '</div>';
        html += '<div>PWAT</div><div style="color:#06b6d4;">' + _val(derived.pwat, 'mm', 1) + '</div>';
        html += '<div>LCL</div><div>' + _val(derived.lcl_p, 'hPa') + '</div>';
        html += '<div>LFC</div><div>' + _val(derived.lfc_p, 'hPa') + '</div>';
        html += '<div>EL</div><div>' + _val(derived.el_p, 'hPa') + '</div>';
        html += '<div>0\u00b0C</div><div>' + _val(derived.freezing_p, 'hPa') + '</div>';

        // Surface conditions
        if (plev.length > 0) {
            // Find surface (highest pressure)
            var sfcIdx = 0;
            for (var si = 1; si < plev.length; si++) {
                if (plev[si] > plev[sfcIdx]) sfcIdx = si;
            }
            html += '<div>Sfc P</div><div>' + _val(plev[sfcIdx], 'hPa') + '</div>';
            if (tC[sfcIdx] != null) html += '<div>Sfc T</div><div>' + _val(tC[sfcIdx], '\u00b0C', 1) + '</div>';
            if (tdC[sfcIdx] != null) html += '<div>Sfc Td</div><div>' + _val(tdC[sfcIdx], '\u00b0C', 1) + '</div>';
        }

        // WL150 and WL500: mean wind speed over the lowest 150 m and 500 m AGL
        var sp = sonde.profile;
        if (sp && sp.alt_km && sp.wspd && sp.alt_km.length > 3) {
            // Find surface altitude (lowest valid altitude)
            var sfcAltKm = null;
            for (var ai = sp.alt_km.length - 1; ai >= 0; ai--) {
                if (sp.alt_km[ai] != null) { sfcAltKm = sp.alt_km[ai]; break; }
            }
            if (sfcAltKm != null) {
                var layers = [
                    { name: 'WL150', top: 0.15, val: null },
                    { name: 'WL500', top: 0.50, val: null },
                ];
                for (var li = 0; li < layers.length; li++) {
                    var topKm = sfcAltKm + layers[li].top;
                    var sum = 0, cnt = 0;
                    for (var wi = 0; wi < sp.alt_km.length; wi++) {
                        if (sp.alt_km[wi] == null || sp.wspd[wi] == null) continue;
                        if (sp.alt_km[wi] >= sfcAltKm && sp.alt_km[wi] <= topKm) {
                            sum += sp.wspd[wi];
                            cnt++;
                        }
                    }
                    if (cnt >= 2) layers[li].val = sum / cnt;
                }
                for (var li2 = 0; li2 < layers.length; li2++) {
                    var wl = layers[li2];
                    var ktStr = '';
                    if (wl.val != null) {
                        ktStr = ' (' + (wl.val * 1.94384).toFixed(0) + ' kt)';
                    }
                    html += '<div>' + wl.name + '</div><div style="color:#34d399;font-weight:700;">' +
                        (wl.val != null ? wl.val.toFixed(1) + ' m/s' + ktStr : '\u2014') + '</div>';
                }
            }
        }

        html += '</div>';

        // Mini vertical profile table
        html += '<div style="font-size:9px;color:#667;margin-top:4px;">PROFILE (' + plev.length + ' levels)</div>';
        html += '<table style="width:100%;font-size:9px;border-collapse:collapse;margin-top:2px;">';
        html += '<tr style="color:#667;border-bottom:1px solid rgba(255,255,255,0.06);">' +
            '<th style="text-align:left;padding:1px 2px;">P</th>' +
            '<th style="text-align:right;padding:1px 2px;">T</th>' +
            '<th style="text-align:right;padding:1px 2px;">Td</th>' +
            '<th style="text-align:right;padding:1px 2px;">Ws</th></tr>';

        // Show every ~25 hPa for a compact table
        var lastP = 9999;
        for (var ri = 0; ri < plev.length; ri++) {
            if (Math.abs(plev[ri] - lastP) < 25 && ri > 0 && ri < plev.length - 1) continue;
            lastP = plev[ri];
            var wspd = null;
            if (profiles.u && profiles.v && profiles.u[ri] != null && profiles.v[ri] != null) {
                wspd = Math.sqrt(profiles.u[ri] * profiles.u[ri] + profiles.v[ri] * profiles.v[ri]);
            }
            html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.03);">' +
                '<td style="padding:1px 2px;">' + (plev[ri] != null ? plev[ri].toFixed(0) : '') + '</td>' +
                '<td style="text-align:right;padding:1px 2px;color:#ef4444;">' + (tC[ri] != null ? tC[ri].toFixed(1) : '') + '</td>' +
                '<td style="text-align:right;padding:1px 2px;color:#22c55e;">' + (tdC[ri] != null ? tdC[ri].toFixed(1) : '') + '</td>' +
                '<td style="text-align:right;padding:1px 2px;">' + (wspd != null ? wspd.toFixed(1) : '') + '</td></tr>';
        }
        html += '</table>';
        html += '</div>';
        el.innerHTML = html;
    }

    // ── Dynamic Skew-T vertical scaling ────────────────────────
    function _rtAdjustSkewTYAxis(plev, profiles) {
        var skDiv = document.getElementById('rt-sonde-skewt');
        if (!skDiv || !skDiv.layout) return;

        // Find min pressure (highest altitude) in the sonde data
        var minP = Infinity;
        for (var i = 0; i < plev.length; i++) {
            if (plev[i] != null && plev[i] < minP) minP = plev[i];
        }

        // Add 15% headroom above the highest data point
        var topP = Math.max(minP * 0.85, 80);

        // Choose sensible top boundary and tick values based on sonde depth
        var yTop, tickVals;
        if (topP >= 550) {
            // Shallow sonde (P-3, ~700+ hPa range): zoom in
            yTop = 550;
            tickVals = [1000, 950, 900, 850, 800, 750, 700, 650, 600];
        } else if (topP >= 350) {
            // Mid-depth sonde (~400-550 hPa top)
            yTop = topP < 400 ? 350 : Math.round(topP / 50) * 50;
            tickVals = [1000, 900, 850, 800, 700, 600, 500, 400];
            if (yTop <= 350) tickVals.push(350);
        } else {
            // Deep sonde (G-IV or full troposphere): keep full range
            yTop = 100;
            tickVals = [1000, 850, 700, 500, 400, 300, 200, 150, 100];
        }

        // Rebuild wind barb shapes with correct aspect ratio for the adjusted y-range
        var hasWind = profiles && profiles.u && profiles.v && profiles.u.length > 0;
        var xRangeMax = hasWind ? 80 : 70;
        var newAxRanges = {
            xMin: -40, xMax: xRangeMax,
            logPMin: Math.log10(1050), logPMax: Math.log10(yTop),
        };
        var newShapes = [];
        if (hasWind && typeof _buildWindBarbShapes === 'function') {
            var barbXPos = 68;
            newShapes = _buildWindBarbShapes(profiles.u, profiles.v, plev, barbXPos, 5.5, newAxRanges);
            newShapes.push({
                type: 'line', xref: 'x', yref: 'y',
                x0: barbXPos - 2, y0: 1050, x1: barbXPos - 2, y1: yTop,
                line: { color: 'rgba(255,255,255,0.08)', width: 0.5 },
            });
        }

        Plotly.relayout(skDiv, {
            'yaxis.range': [Math.log10(1050), Math.log10(yTop)],
            'yaxis.tickvals': tickVals,
            'shapes': newShapes,
        });
    }

    // ── Close Skew-T panel ───────────────────────────────────────
    window.rtCloseSkewT = function () {
        var panel = document.getElementById('rt-sonde-skewt-panel');
        if (panel) panel.style.display = 'none';
        try { Plotly.purge('rt-sonde-skewt'); } catch (e) { /* ok */ }
        // Clear dropdown selection
        var sel = document.getElementById('rt-sonde-select');
        if (sel) sel.value = '';
        var sel2 = document.getElementById('rt-skewt-sonde-select');
        if (sel2) sel2.value = '';
    };

    // ── Render dropsonde summary table (matches archive viewer) ──
    function _rtRenderSondeTable() {
        var panel = document.getElementById('rt-sonde-table-panel');
        if (!panel || !_rtSondeData || !_rtSondeData.dropsondes) return;

        var sondes = _rtSondeData.dropsondes;
        var html = '<div style="padding:6px 8px;background:rgba(168,85,247,0.06);border-top:1px solid rgba(168,85,247,0.15);">';
        html += '<div style="color:#c4b5fd;font-size:12px;font-weight:700;margin-bottom:4px;">' +
            '\uD83E\uDE82 Dropsondes (' + sondes.length + ')';
        // Add platform/flight if available from first sonde
        if (sondes.length > 0) {
            var s0 = sondes[0];
            if (s0.platform || s0.flight) {
                html += ' <span style="color:#8899aa;font-weight:400;font-size:10px;">' +
                    (s0.platform || '') + (s0.flight ? ' / ' + s0.flight : '') + '</span>';
            }
        }
        html += '</div>';

        html += '<div style="max-height:180px;overflow-y:auto;">';
        html += '<table style="width:100%;border-collapse:collapse;font-size:10px;">';
        html += '<tr style="color:#9ca3af;border-bottom:1px solid rgba(255,255,255,0.1);">' +
            '<th style="text-align:left;padding:2px 4px;">#</th>' +
            '<th style="text-align:left;padding:2px 4px;">ID</th>' +
            '<th style="text-align:left;padding:2px 4px;">Time</th>' +
            '<th style="text-align:right;padding:2px 4px;">\u0394t</th>' +
            '<th style="text-align:right;padding:2px 4px;">WL150</th>' +
            '<th style="text-align:right;padding:2px 4px;">Vmax</th>' +
            '<th style="text-align:right;padding:2px 4px;">Psfc</th>' +
            '<th style="text-align:center;padding:2px 4px;">Sfc</th>' +
            '<th style="text-align:left;padding:2px 4px;" colspan="2">Plots</th>' +
            '</tr>';

        sondes.forEach(function(sonde, idx) {
            var color = _sondeColor(idx);
            var p = sonde.profile;
            var maxWspd = null;
            var sfcPres = null;
            var wl150 = null;

            // Max wind
            if (p.wspd) {
                for (var j = 0; j < p.wspd.length; j++) {
                    if (p.wspd[j] != null && (maxWspd === null || p.wspd[j] > maxWspd)) maxWspd = p.wspd[j];
                }
            }

            // WL150: mean wind speed in 0–150 m AGL layer
            if (p.alt_km && p.wspd) {
                var tblSfcAlt = null;
                for (var j = p.alt_km.length - 1; j >= 0; j--) {
                    if (p.alt_km[j] != null) { tblSfcAlt = p.alt_km[j]; break; }
                }
                if (tblSfcAlt != null) {
                    var wlSum = 0, wlCnt = 0;
                    var topKm = tblSfcAlt + 0.15;
                    for (var j = 0; j < p.alt_km.length; j++) {
                        if (p.alt_km[j] != null && p.wspd[j] != null &&
                            p.alt_km[j] >= tblSfcAlt && p.alt_km[j] <= topKm) {
                            wlSum += p.wspd[j]; wlCnt++;
                        }
                    }
                    if (wlCnt >= 3) wl150 = wlSum / wlCnt;
                }
            }

            // Surface pressure: max profile pressure (RT sondes don't have splash_pr/hyd_sfcp)
            if (p.pres) {
                for (var j = 0; j < p.pres.length; j++) {
                    if (p.pres[j] != null && (sfcPres === null || p.pres[j] > sfcPres)) sfcPres = p.pres[j];
                }
            }

            // Surface detection: check if min altitude is 0
            var hitSurface = false;
            if (p.alt_km) {
                var validAlts = [];
                for (var j = 0; j < p.alt_km.length; j++) {
                    if (p.alt_km[j] != null) validAlts.push(p.alt_km[j]);
                }
                if (validAlts.length > 0 && Math.min.apply(null, validAlts) === 0) hitSurface = true;
            }

            var timeStr = sonde.launch_time ? sonde.launch_time.substring(11, 19) : '?';
            var dtStr = sonde.time_offset_min != null ?
                (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) : '';
            var wl150Str = wl150 != null ? wl150.toFixed(1) : '-';
            var wspdStr = maxWspd != null ? maxWspd.toFixed(1) : '-';
            var presStr = sfcPres != null ? sfcPres.toFixed(0) : '-';

            var sfcIcon, sfcColor, sfcTip;
            if (hitSurface) {
                sfcIcon = '\u2713'; sfcColor = '#34d399'; sfcTip = 'Reached surface (alt=0m)';
            } else {
                sfcIcon = '\u2717'; sfcColor = '#f87171'; sfcTip = 'Did not reach surface';
            }

            html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;" ' +
                'onclick="rtSelectSonde(' + idx + ')" ' +
                'onmouseover="this.style.background=\'rgba(52,211,153,0.1)\'" ' +
                'onmouseout="this.style.background=\'none\'">' +
                '<td style="padding:2px 4px;color:' + color + ';font-weight:bold;">' + (idx+1) + '</td>' +
                '<td style="padding:2px 4px;">' + (sonde.sonde_id || '-') + '</td>' +
                '<td style="padding:2px 4px;">' + timeStr + '</td>' +
                '<td style="padding:2px 4px;text-align:right;">' + dtStr + '</td>' +
                '<td style="padding:2px 4px;text-align:right;" title="Mean wind 0\u2013150m AGL (m/s)">' + wl150Str + '</td>' +
                '<td style="padding:2px 4px;text-align:right;">' + wspdStr + '</td>' +
                '<td style="padding:2px 4px;text-align:right;color:#f59e0b;" title="Max profile pressure">' + presStr + '</td>' +
                '<td style="padding:2px 4px;text-align:center;color:' + sfcColor + ';" title="' + sfcTip + '">' + sfcIcon + '</td>' +
                '<td style="padding:2px 4px;"><button class="cs-btn" style="padding:1px 6px;font-size:9px;color:' + color + ';" ' +
                'onclick="event.stopPropagation();rtSelectSonde(' + idx + ')">Skew-T</button></td>' +
                '<td style="padding:2px 4px;"><button class="cs-btn" style="padding:1px 6px;font-size:9px;color:#22c55e;" ' +
                'onclick="event.stopPropagation();rtShowSondeWind(' + idx + ')">Wind</button></td>' +
                '</tr>';
        });

        html += '</table></div>';
        html += '<div style="font-size:9px;color:#9ca3af;padding:2px 6px;margin-top:2px;">' +
            'Psfc: max profile P &nbsp;|&nbsp; ' +
            'Sfc: <span style="color:#34d399;">\u2713</span>=reached sfc, ' +
            '<span style="color:#f87171;">\u2717</span>=no surface' +
            '</div>';
        html += '</div>';

        panel.innerHTML = html;
        panel.style.display = 'block';
    }

    // ── Wind profile plot (matches archive viewer) ────────────────
    window.rtShowSondeWind = function (sondeIdx) {
        if (!_rtSondeData || sondeIdx < 0 || sondeIdx >= _rtSondeData.dropsondes.length) return;

        var sonde = _rtSondeData.dropsondes[sondeIdx];
        var p = sonde.profile;
        var container = document.getElementById('rt-sonde-wind-panel');
        if (container) container.style.display = 'block';
        // Hide Skew-T if open
        var skPanel = document.getElementById('rt-sonde-skewt-panel');
        if (skPanel) skPanel.style.display = 'none';

        var chartDiv = document.getElementById('rt-sonde-wind');
        if (!chartDiv) return;

        if (!p.pres || !p.wspd || p.pres.length < 5) {
            rtToast('Insufficient data for wind profile', 'warn');
            return;
        }

        var color = _sondeColor(sondeIdx);

        // Build arrays
        var wspdArr = [], presWspd = [], altWspd = [];
        var tempArr = [], presTemp = [], altTemp = [];
        var dewArr = [], presDew = [], altDew = [];
        var presAltMap = [];
        for (var i = 0; i < p.pres.length; i++) {
            if (p.pres[i] == null) continue;
            var _altKm = (p.alt_km && p.alt_km[i] != null) ? p.alt_km[i] : null;
            if (_altKm != null) presAltMap.push({ pres: p.pres[i], alt: _altKm });
            if (p.wspd[i] != null) { wspdArr.push(p.wspd[i]); presWspd.push(p.pres[i]); altWspd.push(_altKm); }
            if (p.temp[i] != null) { tempArr.push(p.temp[i]); presTemp.push(p.pres[i]); altTemp.push(_altKm); }
            // Dewpoint from RH + T
            if (p.temp[i] != null && p.rh && p.rh[i] != null && p.rh[i] > 0) {
                var _T = p.temp[i], _RH = p.rh[i];
                var _a = 17.27, _b = 237.7;
                var _gam = (_a * _T) / (_b + _T) + Math.log(_RH / 100.0);
                var _Td = (_b * _gam) / (_a - _gam);
                dewArr.push(_Td); presDew.push(p.pres[i]); altDew.push(_altKm);
            } else if (p.dewpoint && p.dewpoint[i] != null) {
                dewArr.push(p.dewpoint[i]); presDew.push(p.pres[i]); altDew.push(_altKm);
            }
        }

        // Alt interpolation helper
        function _interpAltKm(targetPres) {
            if (presAltMap.length < 2) return null;
            for (var k = 0; k < presAltMap.length - 1; k++) {
                var p0 = presAltMap[k].pres, p1 = presAltMap[k + 1].pres;
                if ((p0 <= targetPres && p1 >= targetPres) || (p0 >= targetPres && p1 <= targetPres)) {
                    var frac = (p1 !== p0) ? (targetPres - p0) / (p1 - p0) : 0;
                    return presAltMap[k].alt + frac * (presAltMap[k + 1].alt - presAltMap[k].alt);
                }
            }
            return null;
        }

        // Compute WL150 and WL500
        var wl150 = null, wl500 = null, wl150Top = null, wl500Top = null;
        var sfcAltKm = null;
        if (p.alt_km && p.alt_km.length > 3) {
            for (var ai = p.alt_km.length - 1; ai >= 0; ai--) {
                if (p.alt_km[ai] != null) { sfcAltKm = p.alt_km[ai]; break; }
            }
        }
        var sfcPresWL = null;
        if (presWspd.length > 0) sfcPresWL = Math.max.apply(null, presWspd);

        if (sfcAltKm != null) {
            var layers = [
                { top: 0.15, sum: 0, cnt: 0, topP: null },
                { top: 0.50, sum: 0, cnt: 0, topP: null },
            ];
            for (var li = 0; li < layers.length; li++) {
                var topKm = sfcAltKm + layers[li].top;
                for (var wi = 0; wi < p.alt_km.length; wi++) {
                    if (p.alt_km[wi] == null || p.wspd[wi] == null || p.pres[wi] == null) continue;
                    if (p.alt_km[wi] >= sfcAltKm && p.alt_km[wi] <= topKm) {
                        layers[li].sum += p.wspd[wi];
                        layers[li].cnt++;
                    }
                    if (p.alt_km[wi] != null && Math.abs(p.alt_km[wi] - topKm) < 0.02 && layers[li].topP === null) {
                        layers[li].topP = p.pres[wi];
                    }
                }
            }
            if (layers[0].cnt >= 3) wl150 = layers[0].sum / layers[0].cnt;
            if (layers[1].cnt >= 3) wl500 = layers[1].sum / layers[1].cnt;
            wl150Top = layers[0].topP;
            wl500Top = layers[1].topP;
        }

        // Pressure range
        var pMin = Math.min.apply(null, presWspd);
        var pMax = Math.max.apply(null, presWspd);
        pMin = Math.max(50, Math.floor(pMin / 50) * 50);
        pMax = Math.min(1060, Math.ceil(pMax / 50) * 50 + 10);

        var traces = [];

        // Wind speed trace
        traces.push({
            x: wspdArr, y: presWspd,
            type: 'scatter', mode: 'lines',
            line: { color: '#22c55e', width: 2.5 },
            name: 'Wind Speed (m/s)',
            hovertemplate: '%{y:.0f} hPa (%{text} m): %{x:.1f} m/s<extra>Wspd</extra>',
            text: altWspd.map(function(a) { return a != null ? (a * 1000).toFixed(0) : '?'; }),
        });

        // Temperature trace
        if (tempArr.length > 5) {
            traces.push({
                x: tempArr, y: presTemp,
                type: 'scatter', mode: 'lines',
                line: { color: '#ef4444', width: 1.8 },
                name: 'Temp (\u00b0C)',
                xaxis: 'x2', yaxis: 'y',
                hovertemplate: '%{y:.0f} hPa (%{text} m): T = %{x:.1f}\u00b0C<extra></extra>',
                text: altTemp.map(function(a) { return a != null ? (a * 1000).toFixed(0) : '?'; }),
            });
        }

        // Dewpoint trace
        if (dewArr.length > 5) {
            traces.push({
                x: dewArr, y: presDew,
                type: 'scatter', mode: 'lines',
                line: { color: '#3b82f6', width: 1.5, dash: 'dash' },
                name: 'Dewpoint (\u00b0C)',
                xaxis: 'x2', yaxis: 'y',
                hovertemplate: '%{y:.0f} hPa (%{text} m): Td = %{x:.1f}\u00b0C<extra></extra>',
                text: altDew.map(function(a) { return a != null ? (a * 1000).toFixed(0) : '?'; }),
            });
        }

        // WL150 / WL500 annotation shapes
        var shapes = [];
        var annotations = [];

        if (wl150 != null && sfcPresWL != null) {
            var p150Top = wl150Top || (sfcPresWL - 15);
            shapes.push({
                type: 'rect', xref: 'paper', yref: 'y',
                x0: 0, x1: 1, y0: sfcPresWL, y1: p150Top,
                fillcolor: 'rgba(59,130,246,0.08)', line: { width: 0 },
            });
            shapes.push({
                type: 'line', xref: 'x', yref: 'y',
                x0: wl150, x1: wl150, y0: sfcPresWL, y1: p150Top,
                line: { color: '#3b82f6', width: 2, dash: 'dash' },
            });
            annotations.push({
                x: wl150, y: p150Top, xref: 'x', yref: 'y',
                text: '<b>WL150</b> ' + wl150.toFixed(1) + ' m/s (' + (wl150 * 1.944).toFixed(0) + ' kt)',
                showarrow: true, arrowhead: 0, arrowcolor: '#3b82f6', ax: 40, ay: -18,
                font: { color: '#3b82f6', size: 10 },
                bgcolor: 'rgba(17,24,39,0.85)', bordercolor: '#3b82f6', borderwidth: 1, borderpad: 2,
            });
        }

        if (wl500 != null && sfcPresWL != null) {
            var p500Top = wl500Top || (sfcPresWL - 55);
            shapes.push({
                type: 'rect', xref: 'paper', yref: 'y',
                x0: 0, x1: 1, y0: sfcPresWL, y1: p500Top,
                fillcolor: 'rgba(251,191,36,0.06)', line: { width: 0 },
            });
            shapes.push({
                type: 'line', xref: 'x', yref: 'y',
                x0: wl500, x1: wl500, y0: sfcPresWL, y1: p500Top,
                line: { color: '#f59e0b', width: 2, dash: 'dash' },
            });
            annotations.push({
                x: wl500, y: p500Top, xref: 'x', yref: 'y',
                text: '<b>WL500</b> ' + wl500.toFixed(1) + ' m/s (' + (wl500 * 1.944).toFixed(0) + ' kt)',
                showarrow: true, arrowhead: 0, arrowcolor: '#f59e0b', ax: 50, ay: -18,
                font: { color: '#f59e0b', size: 10 },
                bgcolor: 'rgba(17,24,39,0.85)', bordercolor: '#f59e0b', borderwidth: 1, borderpad: 2,
            });
        }

        // Title
        var tOffStr = sonde.time_offset_min != null ?
            ' (T' + (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min)' : '';
        var titleEl = document.getElementById('rt-wind-title');
        if (titleEl) {
            var platLabel = sonde.platform || '';
            var flightLabel = sonde.flight || '';
            titleEl.innerHTML =
                '\uD83C\uDF2C\uFE0F ' + (platLabel || '') +
                (flightLabel ? ' <span style="color:#9ca3af;">(' + flightLabel + ')</span>' : '') +
                '<br>' +
                '<span style="color:#94a3b8;">' + (sonde.sonde_id || 'Sonde ' + (sondeIdx + 1)) +
                ' \u2014 ' + sonde.launch_time + tOffStr + '</span>';
        }

        // On-plot annotations
        var maxW = null;
        for (var wi2 = 0; wi2 < wspdArr.length; wi2++) {
            if (maxW === null || wspdArr[wi2] > maxW) maxW = wspdArr[wi2];
        }

        var plotTitleLine = (sonde.platform || 'Unknown') +
            (sonde.flight ? ' (' + sonde.flight + ')' : '') +
            ' | ' + (sonde.sonde_id || '?') +
            ' | ' + sonde.launch_time + tOffStr;

        var plotInfoParts = [];
        if (maxW != null) plotInfoParts.push('Vmax: ' + maxW.toFixed(1) + ' m/s (' + (maxW * 1.944).toFixed(0) + ' kt)');
        if (wl150 != null) plotInfoParts.push('WL150: ' + wl150.toFixed(1) + ' m/s (' + (wl150 * 1.944).toFixed(0) + ' kt)');
        if (wl500 != null) plotInfoParts.push('WL500: ' + wl500.toFixed(1) + ' m/s (' + (wl500 * 1.944).toFixed(0) + ' kt)');
        plotInfoParts.push('Psfc: ' + (sfcPresWL ? sfcPresWL.toFixed(0) : '?') + ' hPa');
        if (sonde.platform) plotInfoParts.push(sonde.platform);

        // Right-side altitude ticks
        var altTickVals = [], altTickText = [];
        var stdLevels = [1000, 925, 850, 700, 500, 400, 300, 200, 150, 100];
        for (var si = 0; si < stdLevels.length; si++) {
            var sp = stdLevels[si];
            if (sp >= pMin && sp <= pMax) {
                var altAtLevel = _interpAltKm(sp);
                if (altAtLevel != null) {
                    altTickVals.push(sp);
                    altTickText.push((altAtLevel < 10 ? altAtLevel.toFixed(1) : altAtLevel.toFixed(0)) + ' km');
                }
            }
        }

        var layout = {
            paper_bgcolor: '#111827',
            plot_bgcolor: '#111827',
            xaxis: {
                title: { text: 'Wind Speed (m/s)', font: { color: '#22c55e', size: 12 } },
                tickfont: { color: '#22c55e', size: 10 },
                gridcolor: 'rgba(255,255,255,0.08)',
                zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)',
                side: 'bottom',
            },
            xaxis2: {
                title: { text: 'Temperature (\u00b0C)', font: { color: '#ef4444', size: 11 } },
                tickfont: { color: '#ef4444', size: 9 },
                gridcolor: 'rgba(239,68,68,0.08)',
                side: 'top', overlaying: 'x', anchor: 'y',
            },
            yaxis: {
                title: { text: 'Pressure (hPa)', font: { color: '#aaa', size: 12 } },
                tickfont: { color: '#aaa', size: 10 },
                gridcolor: 'rgba(255,255,255,0.08)',
                autorange: 'reversed', type: 'log',
                range: [Math.log10(pMax), Math.log10(pMin)],
                dtick: 'D1',
            },
            yaxis2: {
                title: { text: 'Altitude (km)', font: { color: '#9ca3af', size: 11 } },
                tickfont: { color: '#9ca3af', size: 9 },
                side: 'right', overlaying: 'y', type: 'log',
                range: [Math.log10(pMax), Math.log10(pMin)],
                tickvals: altTickVals, ticktext: altTickText,
                showgrid: false,
            },
            margin: { l: 55, r: 55, t: 70, b: 82 },
            legend: { x: 0.01, y: 0.01, bgcolor: 'rgba(17,24,39,0.85)', font: { color: '#d1d5db', size: 10 },
                      xanchor: 'left', yanchor: 'bottom' },
            showlegend: true,
            shapes: shapes,
            annotations: annotations,
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } },
        };

        // On-plot title and info annotations (visible in saved PNG)
        // Position title above the top x-axis (temperature) so they don't overlap
        layout.annotations.push({
            text: plotTitleLine,
            xref: 'paper', yref: 'paper', x: 0.5, y: 1.14,
            showarrow: false, font: { color: '#e5e7eb', size: 11 }, xanchor: 'center',
        });
        layout.annotations.push({
            text: plotInfoParts.join(' \u00b7 '),
            xref: 'paper', yref: 'paper', x: 0.5, y: -0.18,
            showarrow: false, font: { color: '#94a3b8', size: 9.5 }, xanchor: 'center', yanchor: 'top',
        });

        Plotly.newPlot(chartDiv, traces, layout, { responsive: true, displayModeBar: false });

        // Clear the info div (info is now shown as on-plot annotation)
        var infoEl = document.getElementById('rt-sonde-wind-info');
        if (infoEl) infoEl.innerHTML = '';

        if (container) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    // ── Populate dropsonde selector dropdowns ────────────────────
    function _rtPopulateSondeDropdowns() {
        if (!_rtSondeData || !_rtSondeData.dropsondes) return;
        var sondes = _rtSondeData.dropsondes;

        var optionsHtml = '<option value="">\uD83E\uDE82 Select Sonde\u2026</option>';
        for (var i = 0; i < sondes.length; i++) {
            var s = sondes[i];
            var tOff = s.time_offset_min != null ?
                (s.time_offset_min >= 0 ? '+' : '') + s.time_offset_min.toFixed(0) + 'm' : '';
            var label = (s.sonde_id || '#' + (i + 1));
            if (tOff) label += ' (' + tOff + ')';
            if (s.comments) label += ' \u2014 ' + s.comments;
            optionsHtml += '<option value="' + i + '">' + label + '</option>';
        }

        // Main dropdown (below action buttons) — keep hidden since we have the table
        var sel = document.getElementById('rt-sonde-select');
        if (sel) {
            sel.innerHTML = optionsHtml;
            sel.disabled = false;
            // sel.style.display = '';  // hidden — table replaces this
        }

        // Skew-T panel dropdown (for quick switching)
        var sel2 = document.getElementById('rt-skewt-sonde-select');
        if (sel2) {
            sel2.innerHTML = optionsHtml;
        }
    }

    // ── Select sonde from dropdown ───────────────────────────────
    window.rtSelectSonde = function (val) {
        if (val === '' || val == null) return;
        var idx = parseInt(val, 10);
        if (isNaN(idx)) return;

        // Ensure sondes are visible
        if (_rtSondeMode === 'off' && _rtSondeData) {
            _rtSondeMode = 'on';
            _rtSondeVisible = true;
            _rtSetTDRVisible(true);
            _rtRenderSondesOnMap();
            _rtRenderSondesOnPlot();
            _rtUpdateSondeBtn();
        }

        // Show the Skew-T
        _rtShowSondeSkewT(idx);

        // Sync both dropdowns
        var sel = document.getElementById('rt-sonde-select');
        if (sel) sel.value = val;
        var sel2 = document.getElementById('rt-skewt-sonde-select');
        if (sel2) sel2.value = val;
    };

    // ── 3D Volume: Toggle TDR isosurfaces ────────────────────────
    window.rtToggle3DTDR = function () {
        var btn = document.getElementById('vol-tdr-toggle');
        var chartDiv = document.getElementById('vol-3d-chart');
        if (!btn || !chartDiv || !chartDiv.data || chartDiv.data.length < 1) return;

        btn.classList.toggle('active');
        var vis = btn.classList.contains('active');
        Plotly.restyle(chartDiv, { visible: vis }, [0]);
    };

    // ── 3D Volume: Toggle dropsonde traces ───────────────────────
    window.rtToggle3DSondes = function () {
        var btn = document.getElementById('vol-sonde-toggle');
        var chartDiv = document.getElementById('vol-3d-chart');
        if (!btn || !chartDiv || !chartDiv.data) return;
        if (_rt3DSondeTraceStart < 0) return;

        btn.classList.toggle('active');
        var vis = btn.classList.contains('active');

        // Sonde traces are indices _rt3DSondeTraceStart to end
        var indices = [];
        for (var i = _rt3DSondeTraceStart; i < chartDiv.data.length; i++) {
            indices.push(i);
        }
        if (indices.length > 0) {
            Plotly.restyle(chartDiv, { visible: vis }, indices);
        }
    };

    // ── 3D Volume: Add sonde trajectories ────────────────────────
    function _rtAddSondesTo3D() {
        if (!_rtSondeVisible || !_rtSondeData || !_rtSondeData.dropsondes.length) return;
        var chartDiv = document.getElementById('vol-3d-chart');
        if (!chartDiv || !chartDiv.data) return;

        var sondeTraces = [];
        _rtSondeData.dropsondes.forEach(function (sonde, idx) {
            var p = sonde.profile;
            if (!p.x_km || p.x_km.length < 2) return;

            var color = _sondeColor(idx);

            // Build arrays filtering nulls
            var xs = [], ys = [], zs = [], texts = [], colors = [];
            for (var i = 0; i < p.x_km.length; i++) {
                if (p.x_km[i] != null && p.y_km[i] != null && p.alt_km[i] != null) {
                    xs.push(p.x_km[i]);
                    ys.push(p.y_km[i]);
                    zs.push(p.alt_km[i]);
                    var wspd = p.wspd[i];
                    colors.push(wspd != null ? wspd : 0);
                    texts.push(
                        '<b>\uD83E\uDE82 ' + sonde.sonde_id + '</b>' +
                        '<br>Alt: ' + p.alt_km[i].toFixed(2) + ' km' +
                        (wspd != null ? '<br>Wind: ' + wspd.toFixed(1) + ' m/s' : '') +
                        (p.temp[i] != null ? '<br>Temp: ' + p.temp[i].toFixed(1) + ' \u00b0C' : '')
                    );
                }
            }

            if (xs.length < 2) return;

            sondeTraces.push({
                type: 'scatter3d',
                mode: 'lines+markers',
                x: xs, y: ys, z: zs,
                line: { color: colors, colorscale: 'Jet', width: 4, cmin: 0, cmax: 80 },
                marker: { size: 2, color: colors, colorscale: 'Jet', cmin: 0, cmax: 80 },
                text: texts,
                hoverinfo: 'text',
                showlegend: false,
                name: '\uD83E\uDE82 ' + (sonde.sonde_id || '#' + (idx + 1))
            });

            // Launch marker (larger, at top)
            sondeTraces.push({
                type: 'scatter3d',
                mode: 'markers',
                x: [xs[0]], y: [ys[0]], z: [zs[0]],
                marker: { size: 6, color: color, symbol: 'circle',
                          line: { color: '#fff', width: 1 } },
                hoverinfo: 'text',
                text: ['\uD83E\uDE82 Launch: ' + sonde.sonde_id],
                showlegend: false
            });

            // Surface marker
            sondeTraces.push({
                type: 'scatter3d',
                mode: 'markers',
                x: [xs[xs.length - 1]], y: [ys[ys.length - 1]], z: [zs[zs.length - 1]],
                marker: { size: 6, color: color, symbol: 'diamond',
                          line: { color: '#fff', width: 1 } },
                hoverinfo: 'text',
                text: ['\uD83E\uDE82 Surface: ' + sonde.sonde_id],
                showlegend: false
            });
        });

        if (sondeTraces.length > 0) {
            _rt3DSondeTraceStart = chartDiv.data.length; // before addTraces
            Plotly.addTraces(chartDiv, sondeTraces);
            // Enable and activate the Sondes toggle button
            var sondeBtn3D = document.getElementById('vol-sonde-toggle');
            if (sondeBtn3D) { sondeBtn3D.disabled = false; sondeBtn3D.classList.add('active'); }
        }
        // Reset TDR toggle to active state
        var tdrBtn3D = document.getElementById('vol-tdr-toggle');
        if (tdrBtn3D) tdrBtn3D.classList.add('active');
    }

    // ── Hook: patch rtExploreFile to reset sonde state ───────────
    var _origRtExploreFile = window.rtExploreFile;
    window.rtExploreFile = function () {
        _rtSondeCleanup();
        _origRtExploreFile();
    };

    // ── Hook: patch rtRenderPlot to re-add sondes after re-render ──
    var _origRtRenderPlot = rtRenderPlot;
    rtRenderPlot = function (json, resultDiv) {
        _origRtRenderPlot(json, resultDiv);
        // Enable sonde + FL buttons after plot loads
        var sondeBtn = document.getElementById('rt-sonde-btn');
        if (sondeBtn) sondeBtn.disabled = false;
        var flBtn = document.getElementById('rt-fl-btn');
        if (flBtn) flBtn.disabled = false;
        // Re-render sondes if they were visible
        if (_rtSondeVisible && _rtSondeData) {
            // Slight delay to ensure plot is fully rendered
            setTimeout(function () {
                _rtRenderSondesOnPlot();
                // Re-hide TDR if in "only" mode (since newPlot recreated all traces)
                if (_rtSondeMode === 'only') _rtSetTDRVisible(false);
            }, 100);
        }
    };

    // ── Hook: patch height slider to update sonde markers ────────
    var _origLevelSlider = document.getElementById('rt-level');
    if (_origLevelSlider) {
        var _origOninput = _origLevelSlider.oninput;
        _origLevelSlider.oninput = function () {
            if (_origOninput) _origOninput.call(this);
            document.getElementById('rt-level-val').textContent =
                parseFloat(this.value).toFixed(1) + ' km';
            if (_rtSondeVisible) {
                // Debounce: update after a short delay
                clearTimeout(_rtSondeLevelTimer);
                _rtSondeLevelTimer = setTimeout(_rtUpdateSondeLevel, 150);
            }
        };
    }
    var _rtSondeLevelTimer = null;

    // ── Hook: patch rtOpen3DModal to add sonde + tilt traces to 3D ──
    var _origRtOpen3DModal = rtOpen3DModal;
    rtOpen3DModal = function () {
        _origRtOpen3DModal();
        _rt3DSondeTraceStart = -1; // reset for fresh 3D scene
        _rtTilt3DTraceStart = -1;  // reset tilt traces too
        var sondeBtn3D = document.getElementById('vol-sonde-toggle');
        if (_rtSondeVisible && _rtSondeData && _rtSondeData.dropsondes.length > 0) {
            // Delay to ensure 3D scene is rendered
            setTimeout(function () { _rtAddSondesTo3D(); }, 500);
        } else {
            // No sondes — disable the toggle
            if (sondeBtn3D) { sondeBtn3D.disabled = true; sondeBtn3D.classList.remove('active'); }
        }
        // Add tilt hodograph to 3D if data available (from /volume?tilt_profile=true or plan-view fetch)
        var tilt = (_rtLast3DJson && _rtLast3DJson.tilt_profile) ? _rtLast3DJson.tilt_profile : _rtTiltData;
        setTimeout(function () { window._rtAddTiltTo3D(tilt); }, 600);
    };

    // ── Listen for 3D re-renders (iso slider, caps toggle, etc.) ──
    // When render3DIsosurface() does Plotly.newPlot, all addTraces overlays
    // are destroyed. Re-add active overlays when the event fires.
    document.addEventListener('vol3d-rerendered', function () {
        // Only act if we're on the realtime tab
        var rtTab = document.querySelector('.tab-btn.active[data-tab="realtime"]');
        if (!rtTab) return;

        _rt3DSondeTraceStart = -1;
        _rtTilt3DTraceStart = -1;

        if (_rtSondeVisible && _rtSondeData && _rtSondeData.dropsondes.length > 0) {
            setTimeout(function () { _rtAddSondesTo3D(); }, 100);
        }
        var tilt = (_rtLast3DJson && _rtLast3DJson.tilt_profile) ? _rtLast3DJson.tilt_profile : _rtTiltData;
        if (tilt) {
            setTimeout(function () { window._rtAddTiltTo3D(tilt); }, 200);
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Flight-Level (In Situ) Observations — IWG1/MELISSA
    // ═══════════════════════════════════════════════════════════

    var _rtFLData = null;               // cached API response (10-s avg, used for map)
    var _rtFLData1s = null;             // 1-second resolution data
    var _rtFLData10s = null;            // 10-second average data
    var _rtFLData30s = null;            // 30-second average data
    var _rtFLVisible = false;           // toggle state
    var _rtFLMode = 'off';             // 'off' | 'on'
    var _rtFLMapLayers = [];            // Leaflet layers for map view
    var _rtFLPlotTraceIndices = [];     // Plotly trace indices on XY chart
    var _rtFLFetching = false;          // prevent duplicate fetches
    var _rtFLColorVar = 'fl_wspd_ms';  // which variable colours the track
    // Which resolutions are visible on the time series
    var _rtFLResVisible = { '1s': true, '10s': true, '30s': true };

    // Colour variable options for flight-level track
    var _FL_COLOR_VARS = {
        'fl_wspd_ms':   { label: 'FL Wind Speed',   units: 'm/s',  cmin: 0,   cmax: 80  },
        'slp_hpa':      { label: 'Sea-Level Pres',   units: 'hPa',  cmin: 880, cmax: 1015 },
        'temp_c':       { label: 'Temperature',      units: '\u00b0C',   cmin: 10,  cmax: 30  },
        'gps_alt_m':    { label: 'GPS Altitude',     units: 'm',    cmin: 0,   cmax: 5000 },
        'static_pres_hpa': { label: 'Static Pres',   units: 'hPa',  cmin: 500, cmax: 1020 },
    };

    // ── Wind speed → colour for flight-level (matches TDR Saffir-Simpson) ──
    function _flWindColor(wspd) {
        if (wspd == null || isNaN(wspd)) return '#6b7280';
        if (wspd < 17.5) return '#60a5fa';    // TD
        if (wspd < 33.0) return '#34d399';    // TS
        if (wspd < 43.0) return '#fbbf24';    // Cat 1
        if (wspd < 49.5) return '#fb923c';    // Cat 2
        if (wspd < 58.0) return '#f87171';    // Cat 3
        if (wspd < 70.5) return '#ef4444';    // Cat 4
        return '#dc2626';                      // Cat 5
    }

    // ── Generic colour interpolation for non-wind variables ──
    function _flColorInterpolate(val, cmin, cmax) {
        if (val == null || isNaN(val)) return '#6b7280';
        var frac = Math.max(0, Math.min(1, (val - cmin) / (cmax - cmin || 1)));
        // Blue → cyan → green → yellow → red gradient
        var stops = [
            [0.0,  96, 165, 250],   // blue
            [0.25,  6, 182, 212],   // cyan
            [0.5,  52, 211, 153],   // green
            [0.75,251, 191,  36],   // yellow
            [1.0, 239,  68,  68],   // red
        ];
        var lo = stops[0], hi = stops[stops.length - 1];
        for (var s = 0; s < stops.length - 1; s++) {
            if (frac >= stops[s][0] && frac <= stops[s + 1][0]) {
                lo = stops[s]; hi = stops[s + 1]; break;
            }
        }
        var t = (hi[0] === lo[0]) ? 0 : (frac - lo[0]) / (hi[0] - lo[0]);
        var r = Math.round(lo[1] + t * (hi[1] - lo[1]));
        var g = Math.round(lo[2] + t * (hi[2] - lo[2]));
        var b = Math.round(lo[3] + t * (hi[3] - lo[3]));
        return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    function _flObsColor(obs) {
        var val = obs[_rtFLColorVar];
        if (_rtFLColorVar === 'fl_wspd_ms') {
            return _flWindColor(val);
        }
        var info = _FL_COLOR_VARS[_rtFLColorVar] || { cmin: 0, cmax: 100 };
        // Reverse for pressure (lower = more intense = red)
        if (_rtFLColorVar === 'slp_hpa' || _rtFLColorVar === 'static_pres_hpa') {
            return _flColorInterpolate(val, info.cmax, info.cmin);
        }
        return _flColorInterpolate(val, info.cmin, info.cmax);
    }

    // ── Cleanup on file switch ────────────────────────────────
    function _rtFLCleanup() {
        _rtFLData = null;
        _rtFLData1s = null;
        _rtFLData10s = null;
        _rtFLData30s = null;
        _rtFLVisible = false;
        _rtFLMode = 'off';
        _rtFLFetching = false;
        _rtRemoveFLFromMap();
        _rtRemoveFLFromPlot();
        var btn = document.getElementById('rt-fl-btn');
        if (btn) { btn.innerHTML = _icon('plane') + 'FL'; btn.classList.remove('active'); }
    }

    // ── Leaflet Map: Render flight track ──────────────────────
    function _rtRenderFLOnMap() {
        _rtRemoveFLFromMap();
        if (!_rtMap || !_rtFLData || !_rtFLData.observations.length) return;

        var obs = _rtFLData.observations;

        // Draw coloured segments (each segment coloured by the chosen variable)
        for (var i = 0; i < obs.length - 1; i++) {
            var o1 = obs[i], o2 = obs[i + 1];
            if (o1.lat == null || o2.lat == null) continue;

            // Skip if gap is too large (> 120s between thinned points = likely data gap)
            if (Math.abs(o2.time_offset_s - o1.time_offset_s) > 120) continue;

            var color = _flObsColor(o1);
            var seg = L.polyline(
                [[o1.lat, o1.lon], [o2.lat, o2.lon]],
                { color: color, weight: 3.5, opacity: 0.9 }
            ).addTo(_rtMap);
            _rtFLMapLayers.push(seg);
        }

        // Add aircraft position marker at the analysis time (closest point to t=0)
        var closest = null;
        var closestDelta = Infinity;
        for (var j = 0; j < obs.length; j++) {
            var delta = Math.abs(obs[j].time_offset_s);
            if (delta < closestDelta) {
                closestDelta = delta;
                closest = obs[j];
            }
        }

        if (closest) {
            var acIcon = L.divIcon({
                className: 'fl-aircraft-icon',
                html: '<div style="font-size:16px;text-shadow:0 0 6px rgba(0,0,0,0.8);">\u2708</div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            var acMarker = L.marker([closest.lat, closest.lon], { icon: acIcon }).addTo(_rtMap);
            _rtFLMapLayers.push(acMarker);

            // Summary popup on the aircraft marker
            var sm = _rtFLData.summary || {};
            var popupHtml =
                '<div style="font-family:DM Sans,sans-serif;font-size:12px;line-height:1.6;min-width:200px;">' +
                '<strong style="font-size:13px;color:#60a5fa;">\u2708 Flight-Level Data</strong><br>' +
                '<span style="color:#aaa;">' + (_rtFLData.mission_id || '') + '</span><br>' +
                (sm.mean_alt_m != null ? 'Mean Alt: <strong>' + (sm.mean_alt_m / 1000).toFixed(1) + ' km</strong><br>' : '') +
                (sm.max_fl_wspd_ms != null ? 'Max FL Wind: <strong style="color:' + _flWindColor(sm.max_fl_wspd_ms) + ';">' + sm.max_fl_wspd_ms.toFixed(1) + ' m/s (' + (sm.max_fl_wspd_ms * 1.94384).toFixed(0) + ' kt)</strong><br>' : '') +
                (sm.min_slp_hpa != null ? 'Min SLP: <strong>' + sm.min_slp_hpa.toFixed(1) + ' hPa</strong><br>' : '') +
                '<span style="color:#aaa;font-size:10px;">' + (_rtFLData.n_obs_total || 0) + ' obs (\u00b1' + (_rtFLData.time_window_min || 45) + ' min)' +
                (_rtFLData.storm_motion_corrected ? ' \u00b7 Motion-corrected' : '') + '</span>' +
                '</div>';
            acMarker.bindPopup(popupHtml, { maxWidth: 300, minWidth: 220 });
        }

        // Inject colour-variable legend into map controls area
        _rtInjectFLLegend();
    }

    function _rtRemoveFLFromMap() {
        _rtFLMapLayers.forEach(function (layer) {
            if (_rtMap) _rtMap.removeLayer(layer);
        });
        _rtFLMapLayers = [];
        var legend = document.getElementById('rt-fl-legend');
        if (legend) legend.remove();
    }

    // ── Plotly XY chart: FL scatter overlay ─────────────────────
    function _rtRemoveFLFromPlot() {
        var plotDiv = document.getElementById('rt-plotly-chart');
        if (!plotDiv || !plotDiv.data) return;
        if (_rtFLPlotTraceIndices.length > 0) {
            var toRemove = _rtFLPlotTraceIndices.slice().sort(function (a, b) { return b - a; });
            for (var i = 0; i < toRemove.length; i++) {
                if (toRemove[i] < plotDiv.data.length) {
                    Plotly.deleteTraces('rt-plotly-chart', toRemove[i]);
                }
            }
            _rtFLPlotTraceIndices = [];
        }
    }

    function _rtRenderFLOnPlot() {
        var plotDiv = document.getElementById('rt-plotly-chart');
        var obs = _rtFLData ? _rtFLData.observations : [];
        if (!plotDiv || !plotDiv.data || !obs || obs.length === 0) return;

        _rtRemoveFLFromPlot();
        var x = [], y = [], colors = [], texts = [], sizes = [];
        for (var i = 0; i < obs.length; i++) {
            var o = obs[i];
            if (o.x_km == null || o.y_km == null) continue;
            x.push(o.x_km);
            y.push(o.y_km);
            var ws = o.fl_wspd_ms;
            colors.push(ws != null ? ws : 0);
            sizes.push(ws != null ? Math.max(5, Math.min(12, ws / 5)) : 5);

            var tdrStr = '';
            if (o.tdr_wspd_fl_alt != null) {
                var altKm = (o.gps_alt_m != null) ? (o.gps_alt_m / 1000).toFixed(2) + ' km' : '?';
                tdrStr += 'TDR@FL (' + altKm + '): ' + o.tdr_wspd_fl_alt.toFixed(1) + ' m/s';
            }
            if (o.tdr_wspd_0p5km != null) tdrStr += (tdrStr ? '<br>' : '') + 'TDR 0.5km: ' + o.tdr_wspd_0p5km.toFixed(1) + ' m/s';
            if (o.tdr_wspd_2km != null) tdrStr += (tdrStr ? '<br>' : '') + 'TDR 2km: ' + o.tdr_wspd_2km.toFixed(1) + ' m/s';

            var tOffsetMin = (o.time_offset_s != null && isFinite(o.time_offset_s)) ? (o.time_offset_s / 60) : null;
            var timeStr = (o.time || '') + ' UTC';
            if (tOffsetMin != null) timeStr += ' (T' + (tOffsetMin >= 0 ? '+' : '') + tOffsetMin.toFixed(1) + ' min)';

            var altStr = '';
            if (o.gps_alt_m != null && isFinite(o.gps_alt_m)) {
                altStr = 'Alt: ' + o.gps_alt_m.toFixed(0) + ' m (' + Math.round(o.gps_alt_m * 3.28084) + ' ft)<br>';
            }

            texts.push(
                '<b>\u2708 Flight Level</b><br>' +
                'Wind: ' + (ws != null ? ws.toFixed(1) + ' m/s (' + (ws * 1.94384).toFixed(0) + ' kt)' : 'N/A') + '<br>' +
                'Dir: ' + (o.fl_wdir_deg != null ? o.fl_wdir_deg.toFixed(0) + '\u00b0' : 'N/A') + '<br>' +
                altStr +
                (tdrStr ? tdrStr + '<br>' : '') +
                'Time: ' + timeStr
            );
        }

        // Inherit TDR heatmap colorscale + range
        var tdrColorscale = 'Jet';
        var tdrCmin = 0, tdrCmax = 80;
        if (plotDiv.data && plotDiv.data.length > 0) {
            var tdrTrace = plotDiv.data[0];
            if (tdrTrace.colorscale) tdrColorscale = tdrTrace.colorscale;
            if (tdrTrace.zmin != null) tdrCmin = tdrTrace.zmin;
            if (tdrTrace.zmax != null) tdrCmax = tdrTrace.zmax;
        }

        var flLineTrace = {
            x: x, y: y,
            type: 'scatter', mode: 'lines',
            line: { color: 'rgba(255,255,255,0.3)', width: 1.5 },
            hoverinfo: 'skip', showlegend: false,
            name: 'FL Track Line',
        };
        var flScatterTrace = {
            x: x, y: y,
            type: 'scatter', mode: 'markers',
            marker: {
                color: colors,
                colorscale: tdrColorscale,
                cmin: tdrCmin, cmax: tdrCmax,
                size: sizes,
                line: { width: 1, color: 'rgba(255,255,255,0.6)' },
                showscale: false,
            },
            text: texts,
            hovertemplate: '%{text}<extra></extra>',
            name: '\u2708 Flight Level',
            showlegend: true,
        };

        var baseCount = plotDiv.data.length;
        Plotly.addTraces('rt-plotly-chart', [flLineTrace, flScatterTrace]);
        _rtFLPlotTraceIndices = [baseCount, baseCount + 1];
    }

    // ── Legend / colour variable selector (injected into map wrapper) ──
    function _rtInjectFLLegend() {
        var existing = document.getElementById('rt-fl-legend');
        if (existing) existing.remove();

        var wrapper = document.getElementById('rt-map-wrapper');
        if (!wrapper) return;

        var info = _FL_COLOR_VARS[_rtFLColorVar] || { label: 'Wind', units: 'm/s' };

        var legend = document.createElement('div');
        legend.id = 'rt-fl-legend';
        legend.className = 'rt-fl-legend';
        legend.innerHTML =
            '<div class="fl-legend-row">' +
            '<span class="fl-legend-label">' + _icon('plane') + info.label + ' (' + info.units + ')</span>' +
            '<select id="rt-fl-color-var" class="fl-legend-select" onchange="rtFLChangeColor(this.value)">' +
            Object.keys(_FL_COLOR_VARS).map(function (k) {
                var v = _FL_COLOR_VARS[k];
                return '<option value="' + k + '"' + (k === _rtFLColorVar ? ' selected' : '') + '>' + v.label + '</option>';
            }).join('') +
            '</select>' +
            '</div>' +
            '<div class="fl-legend-bar"></div>' +
            '<div class="fl-legend-range"><span>' + info.cmin + '</span><span>' + info.cmax + '</span></div>';
        wrapper.appendChild(legend);
    }

    window.rtFLChangeColor = function (varName) {
        if (_FL_COLOR_VARS[varName]) {
            _rtFLColorVar = varName;
            _rtRenderFLOnMap();
        }
    };

    // ── Toggle button handler ─────────────────────────────────
    window.rtToggleFlightLevel = function () {
        if (_rtFLFetching) return;

        if (!_rtFLData && _rtFLMode === 'off') {
            // First activation: fetch all 3 resolutions in parallel
            _rtFLFetching = true;
            var btn = document.getElementById('rt-fl-btn');
            if (btn) btn.innerHTML = _icon('plane') + 'Loading\u2026';

            var baseUrl = API_BASE + RT_PREFIX + '/flightlevel?file_url=' + encodeURIComponent(_currentFileUrl);
            var fetchJson = function (url) {
                return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
            };

            Promise.all([
                fetchJson(baseUrl + '&avg_interval_s=1'),
                fetchJson(baseUrl + '&avg_interval_s=10'),
                fetchJson(baseUrl + '&avg_interval_s=30'),
            ])
                .then(function (results) {
                    _rtFLData1s  = results[0];
                    _rtFLData10s = results[1];
                    _rtFLData30s = results[2];
                    _rtFLData = _rtFLData10s;  // map uses 10-s avg
                    _rtFLFetching = false;

                    if (_rtFLData10s.n_obs === 0) {
                        rtToast('No flight-level data found within \u00b145 min' +
                            (_rtFLData10s.message ? ' (' + _rtFLData10s.message + ')' : ''), 'warn', 6000);
                        if (btn) btn.innerHTML = _icon('plane') + 'No FL Data';
                        return;
                    }

                    _rtFLVisible = true;
                    _rtFLMode = 'on';
                    if (btn) { btn.innerHTML = _icon('plane') + 'FL'; btn.classList.add('active'); }
                    var _nTot = _rtFLData10s.n_obs_total;
                    var _maxW = _rtFLData10s.summary && _rtFLData10s.summary.max_fl_wspd_ms;
                    var _toastMsg = _nTot + ' obs \u2192 1s/' + _rtFLData1s.n_obs +
                        ', 10s/' + _rtFLData10s.n_obs + ', 30s/' + _rtFLData30s.n_obs;
                    if (_maxW != null) _toastMsg += ' \u00b7 Max FL wind ' + _maxW.toFixed(1) + ' m/s';
                    if (_rtFLData10s.storm_motion_corrected) _toastMsg += ' \u00b7 Storm-motion adjusted';
                    rtToast(_toastMsg, 'info', 6000);

                    _rtRenderFLOnMap();
                    _rtRenderFLOnPlot();
                    _rtRenderFLTimeSeries();
                })
                .catch(function (err) {
                    _rtFLFetching = false;
                    if (btn) btn.innerHTML = _icon('plane') + 'FL';
                    rtToast('Flight-level fetch failed: ' + err.message, 'error');
                });
            return;
        }

        // Simple toggle: on → off → on
        if (_rtFLMode === 'on') {
            _rtFLMode = 'off';
            _rtFLVisible = false;
            _rtRemoveFLFromMap();
            _rtRemoveFLFromPlot();
            window.rtFLCloseTimeSeries();
            var offBtn = document.getElementById('rt-fl-btn');
            if (offBtn) { offBtn.innerHTML = _icon('plane') + 'FL Off'; offBtn.classList.remove('active'); }
        } else {
            _rtFLMode = 'on';
            _rtFLVisible = true;
            _rtRenderFLOnMap();
            _rtRenderFLOnPlot();
            _rtRenderFLTimeSeries();
            var onBtn = document.getElementById('rt-fl-btn');
            if (onBtn) {
                onBtn.innerHTML = _icon('plane') + 'FL On';
                onBtn.classList.add('active');
            }
        }
    };

    // ═══════════════════════════════════════════════════════════
    // Along-Track Time Series (Phase 3)
    // ═══════════════════════════════════════════════════════════

    var _rtFLTSHighlight = null;  // Leaflet marker for click-highlight on map

    // Variable config for time series traces
    var _FL_TS_CONFIG = {
        'fl_wspd_ms':       { label: 'FL Wind Speed',    units: 'm/s',  color: '#60a5fa', yaxis: 'y'  },
        'tdr_wspd_fl_alt':  { label: 'TDR @ FL Alt',    units: 'm/s',  color: '#f472b6', yaxis: 'y'  },
        'tdr_wspd_0p5km':   { label: 'TDR Wind 0.5 km', units: 'm/s',  color: '#34d399', yaxis: 'y'  },
        'tdr_wspd_2km':     { label: 'TDR Wind 2.0 km', units: 'm/s',  color: '#c084fc', yaxis: 'y'  },
        'slp_hpa':         { label: 'Sea-Level Pres',   units: 'hPa',  color: '#fbbf24', yaxis: 'y2' },
        'static_pres_hpa': { label: 'Static Pressure',  units: 'hPa',  color: '#fb923c', yaxis: 'y2' },
        'temp_c':          { label: 'Temperature',      units: '\u00b0C',   color: '#f87171', yaxis: 'y3' },
        'dewpoint_c':      { label: 'Dewpoint',         units: '\u00b0C',   color: '#a78bfa', yaxis: 'y3' },
        'gps_alt_m':       { label: 'GPS Altitude',     units: 'm',    color: '#6b7280', yaxis: 'y4' },
    };

    // Resolution style config: line weight + opacity for each averaging window
    var _FL_RES_STYLE = {
        '1s':  { width: 0.7, opacity: 0.35, dash: 'solid', suffix: ' (1 s)'  },
        '10s': { width: 1.8, opacity: 0.85, dash: 'solid', suffix: ' (10 s)' },
        '30s': { width: 3.0, opacity: 1.0,  dash: 'solid', suffix: ' (30 s)' },
    };

    // Helper: get data for a resolution key
    function _flDataForRes(resKey) {
        if (resKey === '1s')  return _rtFLData1s;
        if (resKey === '10s') return _rtFLData10s;
        if (resKey === '30s') return _rtFLData30s;
        return null;
    }

    // Show/update the time series panel when FL data is available
    function _rtRenderFLTimeSeries() {
        var panel = document.getElementById('rt-fl-timeseries-panel');
        if (!panel || !_rtFLData10s || !_rtFLData10s.observations || _rtFLData10s.observations.length === 0) return;

        panel.style.display = 'block';

        // Get selected variables from toggle buttons
        var varContainer = document.getElementById('rt-fl-ts-vars');
        var selectedVars = [];
        if (varContainer) {
            var btns = varContainer.querySelectorAll('.fl-ts-var-btn.active');
            for (var i = 0; i < btns.length; i++) {
                selectedVars.push(btns[i].getAttribute('data-var'));
            }
        }
        if (selectedVars.length === 0) selectedVars = ['fl_wspd_ms'];

        // Determine which y-axes are needed and build traces
        var usedAxes = {};
        var traces = [];
        var resKeys = ['1s', '10s', '30s'];  // render order: 1s behind, 30s on top

        selectedVars.forEach(function (varName) {
            var cfg = _FL_TS_CONFIG[varName];
            if (!cfg) return;

            resKeys.forEach(function (resKey) {
                if (!_rtFLResVisible[resKey]) return;
                var data = _flDataForRes(resKey);
                if (!data || !data.observations || data.observations.length === 0) return;

                usedAxes[cfg.yaxis] = true;
                var obs = data.observations;
                var style = _FL_RES_STYLE[resKey];

                // Pre-round time to 1 decimal to avoid floating-point noise in hover
                var times = obs.map(function (o) { return Math.round(o.time_offset_s / 6.0) / 10.0; });
                var vals  = obs.map(function (o) {
                    var v = o[varName];
                    return (v != null && isFinite(v)) ? Math.round(v * 10) / 10 : null;
                });

                // Build customdata: [utc_time_str, knots_str]
                var isWind = (varName === 'fl_wspd_ms' || varName === 'tdr_wspd_0p5km' || varName === 'tdr_wspd_2km');
                var customdata = obs.map(function (o) {
                    // Extract HH:MM:SS from ISO timestamp (e.g. "2025-10-28T13:49:08Z")
                    var utc = '';
                    if (o.time) {
                        var tIdx = o.time.indexOf('T');
                        utc = tIdx >= 0 ? o.time.substring(tIdx + 1).replace('Z', '') : o.time;
                    }
                    var kt = '';
                    if (isWind) {
                        var v = o[varName];
                        if (v != null && isFinite(v)) kt = (v * 1.94384).toFixed(1);
                    }
                    return [utc, kt];
                });

                var hoverTpl;
                if (isWind) {
                    hoverTpl = cfg.label + style.suffix + ': %{y} ' + cfg.units +
                        ' (%{customdata[1]} kt)<br>%{customdata[0]} UTC · T%{x:+} min<extra></extra>';
                } else {
                    hoverTpl = cfg.label + style.suffix + ': %{y} ' + cfg.units +
                        '<br>%{customdata[0]} UTC · T%{x:+} min<extra></extra>';
                }

                traces.push({
                    x: times,
                    y: vals,
                    customdata: customdata,
                    name: cfg.label + style.suffix,
                    legendgroup: varName,
                    showlegend: resKey === '10s',  // only show one legend entry per variable
                    type: 'scatter',
                    mode: 'lines',
                    line: { color: cfg.color, width: style.width, dash: style.dash },
                    opacity: style.opacity,
                    yaxis: cfg.yaxis,
                    hovertemplate: hoverTpl,
                    connectgaps: false,
                });
            });
        });

        // Layout with up to 4 y-axes
        var gridColor = 'rgba(148,163,184,0.08)';
        var layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(10,15,25,0.5)',
            margin: { l: 55, r: 55, t: 8, b: 40 },
            font: { family: 'DM Sans, sans-serif', size: 11, color: '#94a3b8' },
            legend: {
                orientation: 'v', x: 1.0, xanchor: 'right', y: 1.0, yanchor: 'top',
                font: { size: 9 }, bgcolor: 'rgba(10,15,25,0.7)',
                bordercolor: 'rgba(148,163,184,0.15)', borderwidth: 1,
                traceorder: 'grouped', tracegroupgap: 4,
            },
            hovermode: 'x unified',
            xaxis: {
                title: { text: 'Minutes from Analysis Time', font: { size: 11 } },
                color: '#94a3b8',
                gridcolor: gridColor,
                zeroline: true,
                zerolinecolor: 'rgba(96,165,250,0.5)',
                zerolinewidth: 2,
            },
            yaxis: {
                title: usedAxes['y'] ? { text: 'Wind Speed (m/s)', font: { size: 10, color: '#60a5fa' } } : undefined,
                color: '#60a5fa',
                gridcolor: gridColor,
                side: 'left',
                visible: !!usedAxes['y'],
            },
            yaxis2: {
                title: usedAxes['y2'] ? { text: 'Pressure (hPa)', font: { size: 10, color: '#fbbf24' } } : undefined,
                color: '#fbbf24',
                overlaying: 'y',
                side: 'right',
                gridcolor: 'transparent',
                visible: !!usedAxes['y2'],
                autorange: 'reversed',
            },
            yaxis3: {
                title: usedAxes['y3'] ? { text: 'Temp (\u00b0C)', font: { size: 10, color: '#f87171' } } : undefined,
                color: '#f87171',
                overlaying: 'y',
                side: 'left',
                position: 0.0,
                anchor: 'free',
                gridcolor: 'transparent',
                visible: !!usedAxes['y3'],
            },
            yaxis4: {
                title: usedAxes['y4'] ? { text: 'Altitude (m)', font: { size: 10, color: '#6b7280' } } : undefined,
                color: '#6b7280',
                overlaying: 'y',
                side: 'right',
                anchor: 'free',
                position: 1.0,
                gridcolor: 'transparent',
                visible: !!usedAxes['y4'],
            },
            shapes: [{
                type: 'line',
                x0: 0, x1: 0,
                y0: 0, y1: 1,
                yref: 'paper',
                line: { color: 'rgba(96,165,250,0.6)', width: 2, dash: 'dash' },
            }],
            annotations: [{
                x: 0.5, y: 0,
                yref: 'paper',
                xref: 'x',
                text: 'TDR Analysis',
                showarrow: false,
                font: { size: 9, color: 'rgba(96,165,250,0.7)' },
                yanchor: 'top',
                yshift: 8,
            }],
        };

        // ── Build max-wind inset annotation ──────────────────────
        var insetLines = [];
        var windVars = [
            { key: 'fl_wspd_ms',      label: 'FL Wind'      },
            { key: 'tdr_wspd_fl_alt', label: 'TDR@FL'       },
            { key: 'tdr_wspd_0p5km',  label: 'TDR 0.5 km'   },
            { key: 'tdr_wspd_2km',    label: 'TDR 2.0 km'   },
        ];
        windVars.forEach(function (wv) {
            // Only show if the variable is selected in the multi-select
            if (selectedVars.indexOf(wv.key) === -1) return;
            var row = [];
            resKeys.forEach(function (resKey) {
                if (!_rtFLResVisible[resKey]) return;
                var data = _flDataForRes(resKey);
                if (!data || !data.observations || data.observations.length === 0) return;
                // Compute max from observations
                var maxVal = null;
                data.observations.forEach(function (o) {
                    var v = o[wv.key];
                    if (v != null && (maxVal === null || v > maxVal)) maxVal = v;
                });
                if (maxVal != null) {
                    row.push(resKey + ': <b>' + maxVal.toFixed(1) + '</b>');
                }
            });
            if (row.length > 0) {
                insetLines.push(wv.label + ' max — ' + row.join('  '));
            }
        });
        // Also show min pressure if pressure is selected
        var presVars = [
            { key: 'static_pres_hpa', label: 'Static P min' },
            { key: 'slp_hpa',         label: 'SLP min' },
        ];
        presVars.forEach(function (pv) {
            if (selectedVars.indexOf(pv.key) === -1) return;
            var row = [];
            resKeys.forEach(function (resKey) {
                if (!_rtFLResVisible[resKey]) return;
                var data = _flDataForRes(resKey);
                if (!data || !data.observations || data.observations.length === 0) return;
                var minVal = null;
                data.observations.forEach(function (o) {
                    var v = o[pv.key];
                    if (v != null && (minVal === null || v < minVal)) minVal = v;
                });
                if (minVal != null) {
                    row.push(resKey + ': <b>' + minVal.toFixed(1) + '</b>');
                }
            });
            if (row.length > 0) {
                insetLines.push(pv.label + ' — ' + row.join('  '));
            }
        });

        if (insetLines.length > 0) {
            layout.annotations.push({
                x: 0.01,
                y: 0.98,
                xref: 'paper',
                yref: 'paper',
                text: insetLines.join('<br>'),
                showarrow: false,
                font: { family: 'DM Sans, sans-serif', size: 10, color: '#cbd5e1' },
                align: 'left',
                xanchor: 'left',
                yanchor: 'top',
                bgcolor: 'rgba(10,15,25,0.75)',
                bordercolor: 'rgba(96,165,250,0.3)',
                borderwidth: 1,
                borderpad: 6,
            });
        }

        var config = {
            responsive: true,
            displayModeBar: false,
            scrollZoom: false,
        };

        var plotDiv = document.getElementById('rt-fl-ts-plot');
        if (!plotDiv) return;

        Plotly.newPlot(plotDiv, traces, layout, config);

        // Click-to-highlight: find nearest point in 10-s data for map marker
        plotDiv.on('plotly_click', function (eventData) {
            if (!eventData || !eventData.points || !eventData.points.length) return;
            var pt = eventData.points[0];
            var clickTimeMin = pt.x;  // minutes from analysis

            // Find closest 10-s observation to the clicked time
            var obs10 = _rtFLData10s.observations;
            var bestIdx = 0, bestDelta = Infinity;
            for (var k = 0; k < obs10.length; k++) {
                var d = Math.abs(obs10[k].time_offset_s / 60.0 - clickTimeMin);
                if (d < bestDelta) { bestDelta = d; bestIdx = k; }
            }
            var o = obs10[bestIdx];
            if (o.lat == null || o.lon == null) return;

            // Remove previous highlight marker
            if (_rtFLTSHighlight && _rtMap) {
                _rtMap.removeLayer(_rtFLTSHighlight);
            }

            var hlIcon = L.divIcon({
                className: '',
                html: '<div style="width:14px;height:14px;background:rgba(96,165,250,0.9);border-radius:50%;border:2px solid #fff;box-shadow:0 0 10px rgba(96,165,250,0.8);"></div>',
                iconSize: [14, 14],
                iconAnchor: [7, 7],
            });
            _rtFLTSHighlight = L.marker([o.lat, o.lon], { icon: hlIcon, zIndexOffset: 1000 }).addTo(_rtMap);

            // Build popup with all 3 resolutions at this time
            var popTxt = '<div style="font-family:DM Sans,sans-serif;font-size:11px;line-height:1.5;">' +
                '<strong style="color:#60a5fa;">T' + (o.time_offset_s >= 0 ? '+' : '') + (o.time_offset_s / 60).toFixed(1) + ' min</strong><br>';
            if (o.fl_wspd_ms != null) popTxt += 'FL Wind (10s): <strong>' + o.fl_wspd_ms.toFixed(1) + ' m/s (' + (o.fl_wspd_ms * 1.94384).toFixed(0) + ' kt)</strong><br>';
            if (o.fl_wdir_deg != null) popTxt += 'FL Dir: ' + o.fl_wdir_deg.toFixed(0) + '\u00b0<br>';
            if (o.tdr_wspd_fl_alt != null) popTxt += 'TDR @ FL: <strong>' + o.tdr_wspd_fl_alt.toFixed(1) + ' m/s (' + (o.tdr_wspd_fl_alt * 1.94384).toFixed(0) + ' kt)</strong><br>';
            if (o.tdr_wspd_0p5km != null) popTxt += 'TDR 0.5 km: ' + o.tdr_wspd_0p5km.toFixed(1) + ' m/s (' + (o.tdr_wspd_0p5km * 1.94384).toFixed(0) + ' kt)<br>';
            if (o.tdr_wspd_2km != null) popTxt += 'TDR 2.0 km: ' + o.tdr_wspd_2km.toFixed(1) + ' m/s (' + (o.tdr_wspd_2km * 1.94384).toFixed(0) + ' kt)<br>';
            if (o.slp_hpa != null) popTxt += 'SLP: <strong>' + o.slp_hpa.toFixed(1) + ' hPa</strong><br>';
            if (o.static_pres_hpa != null) popTxt += 'Static P: ' + o.static_pres_hpa.toFixed(1) + ' hPa<br>';
            if (o.temp_c != null) popTxt += 'Temp: ' + o.temp_c.toFixed(1) + '\u00b0C<br>';
            if (o.gps_alt_m != null) popTxt += 'Alt: ' + o.gps_alt_m.toFixed(0) + ' m';
            popTxt += '</div>';

            _rtFLTSHighlight.bindPopup(popTxt, { maxWidth: 250, minWidth: 180 }).openPopup();
            _rtMap.panTo([o.lat, o.lon], { animate: true, duration: 0.3 });
        });
    }

    // Resolution toggle handler
    window.rtFLToggleRes = function (resKey) {
        _rtFLResVisible[resKey] = !_rtFLResVisible[resKey];
        // Update button visual
        var btn = document.getElementById('rt-fl-res-' + resKey);
        if (btn) {
            if (_rtFLResVisible[resKey]) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
        _rtRenderFLTimeSeries();
    };

    window.rtFLToggleVar = function (btnEl) {
        btnEl.classList.toggle('active');
        _rtRenderFLTimeSeries();
    };

    window.rtFLUpdateTimeSeries = function () {
        _rtRenderFLTimeSeries();
    };

    window.rtFLCloseTimeSeries = function () {
        var panel = document.getElementById('rt-fl-timeseries-panel');
        if (panel) panel.style.display = 'none';
        var plotDiv = document.getElementById('rt-fl-ts-plot');
        if (plotDiv) Plotly.purge(plotDiv);
        if (_rtFLTSHighlight && _rtMap) {
            _rtMap.removeLayer(_rtFLTSHighlight);
            _rtFLTSHighlight = null;
        }
    };

    // ── Patch rtExploreFile to clean up flight-level state ──────
    var _origRtExploreFile2 = window.rtExploreFile;
    window.rtExploreFile = function () {
        _rtFLCleanup();
        window.rtFLCloseTimeSeries();
        _origRtExploreFile2();
    };

    // ── Patch _rtCleanupMap to also remove FL layers ──────────
    var _origCleanupMap2 = _rtCleanupMap;
    _rtCleanupMap = function () {
        _rtRemoveFLFromMap();
        if (_rtFLTSHighlight) {
            _rtMap.removeLayer(_rtFLTSHighlight);
            _rtFLTSHighlight = null;
        }
        _origCleanupMap2();
    };

    // ── SHIPS Environmental Data ──────────────────────────────────
    window.rtFetchSHIPS = function () {
        if (!_currentFileUrl) { rtToast('Load a TDR file first', 'warn'); return; }
        var btn = document.getElementById('rt-ships-btn');
        var panel = document.getElementById('rt-ships-panel');
        if (!btn) return;

        btn.disabled = true;
        btn.textContent = 'Loading SHIPS...';
        _rtShipsLoading = true;

        // Extract storm info from current metadata
        var stormName = '', year = '', analysisDt = '', lat = 0, lon = 0;
        if (_rtCaseMeta) {
            var meta = _rtCaseMeta;
            stormName = (meta.storm_name || '').toUpperCase();
            year = meta.datetime ? meta.datetime.substring(0, 4) : '';
            analysisDt = meta.datetime ? meta.datetime.replace('Z', '').replace(' ', 'T') : '';
            lat = meta.latitude || 0;
            lon = meta.longitude || 0;
        }

        if (!stormName || !year || !analysisDt) {
            rtToast('Generate a plot first to get storm metadata', 'warn');
            btn.disabled = false;
            btn.innerHTML = _icon('dish') + 'Fetch SHIPS Data';
            _rtShipsLoading = false;
            return;
        }

        // Check if user has explicitly set basin/storm# controls
        var basinEl = document.getElementById('rt-ships-basin');
        var stNumEl = document.getElementById('rt-ships-stnum');
        var basin = basinEl ? basinEl.value : '';
        var stNum = stNumEl ? parseInt(stNumEl.value) : 0;

        var url = API_BASE + RT_PREFIX + '/ships?' +
            'storm_name=' + encodeURIComponent(stormName) +
            '&year=' + year +
            '&analysis_dt=' + encodeURIComponent(analysisDt) +
            '&lat=' + lat + '&lon=' + lon;

        // If basin and storm_number are set, use exact ATCF search
        if (basin && stNum > 0) {
            url += '&basin=' + basin + '&storm_number=' + stNum;
        }

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                if (data.status === 'not_found') {
                    throw new Error(data.message || 'SHIPS file not found');
                }
                _rtShipsData = data;
                _rtShipsLoading = false;
                _rtRenderSHIPSPanel(data);
                _rtEnableSHIPSDiagnostics();
                _rtUpdateCompassStrip();
                _rtApplyShearInsetToPlot();
                btn.textContent = '\u2713 SHIPS Loaded';
                btn.style.borderColor = 'rgba(52,211,153,0.5)';
                btn.disabled = false;
                // Hide manual override panel and status on success
                var statusEl = document.getElementById('rt-ships-status');
                if (statusEl) statusEl.style.display = 'none';
                var manualEl = document.getElementById('rt-ships-manual');
                if (manualEl) manualEl.style.display = 'none';
                // If auto-detected, update basin/storm# controls
                if (data.auto_detected && data.basin && data.storm_number) {
                    if (basinEl) basinEl.value = data.basin;
                    if (stNumEl) stNumEl.value = data.storm_number;
                }
                var autoTag = data.auto_detected ? ' (auto ' + (data.atcf_id || '') + ')' : '';
                rtToast('SHIPS loaded: Vmax=' + (data.ships_data.vmax_kt || '?') + ' kt, Shear=' + (data.ships_data.shear_kt || '?') + ' kt' + autoTag, 'success');
            })
            .catch(function (err) {
                _rtShipsLoading = false;
                btn.innerHTML = _icon('dish') + 'Fetch SHIPS Data';
                btn.disabled = false;
                rtToast('SHIPS: ' + err.message, 'error');
            });
    };

    // Auto-fetch SHIPS silently (called after first plot render)
    // Strategy: try auto-detect (no basin/storm#) first; if that fails (e.g. old backend),
    // fall back to explicit basin=AL, storm_number=1.
    function _rtAutoFetchSHIPS() {
        if (!_currentFileUrl || _rtShipsData || _rtShipsLoading) return;

        var stormName = '', year = '', analysisDt = '', lat = 0, lon = 0;
        if (_rtCaseMeta) {
            var meta = _rtCaseMeta;
            stormName = (meta.storm_name || '').toUpperCase();
            year = meta.datetime ? meta.datetime.substring(0, 4) : '';
            analysisDt = meta.datetime ? meta.datetime.replace('Z', '').replace(' ', 'T') : '';
            lat = meta.latitude || 0;
            lon = meta.longitude || 0;
        }
        if (!stormName || !year || !analysisDt) return;

        _rtShipsLoading = true;

        // Show inline status
        var statusEl = document.getElementById('rt-ships-status');
        if (statusEl) { statusEl.style.display = ''; statusEl.innerHTML = '<span style="color:#fdba74;">\u27F3 Auto-detecting SHIPS data for ' + stormName + '...</span>'; }

        // Common success handler
        function _onShipsSuccess(data, isAutoDetect) {
            if (data.status === 'not_found') throw new Error('not found');
            _rtShipsData = data;
            _rtShipsLoading = false;
            _rtRenderSHIPSPanel(data);
            _rtEnableSHIPSDiagnostics();
            // Update HTML compass strip and Plotly inset now that SHIPS is available
            _rtUpdateCompassStrip();
            _rtApplyShearInsetToPlot();
            if (statusEl) statusEl.style.display = 'none';
            var manualEl = document.getElementById('rt-ships-manual');
            if (manualEl) manualEl.style.display = 'none';
            if (data.auto_detected && data.basin && data.storm_number) {
                var basinSel = document.getElementById('rt-ships-basin');
                var stNumInput = document.getElementById('rt-ships-stnum');
                if (basinSel) basinSel.value = data.basin;
                if (stNumInput) stNumInput.value = data.storm_number;
            }
            var autoTag = data.auto_detected ? ' (auto ' + (data.atcf_id || '') + ')' : '';
            rtToast('SHIPS loaded: Vmax=' + (data.ships_data.vmax_kt || '?') + ' kt' + autoTag, 'success');
        }

        // Guess basin from longitude
        var guessBasin = 'AL';
        if (lon !== 0) {
            var normLon = lon > 180 ? lon - 360 : lon;
            if (normLon < -100) guessBasin = 'EP';
        }

        // Try 1: Auto-detect mode (new backend — omit basin & storm_number)
        var autoUrl = API_BASE + RT_PREFIX + '/ships?' +
            'storm_name=' + encodeURIComponent(stormName) +
            '&year=' + year +
            '&analysis_dt=' + encodeURIComponent(analysisDt) +
            '&lat=' + lat + '&lon=' + lon;

        fetch(autoUrl)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) { _onShipsSuccess(data, true); })
            .catch(function () {
                // Backend handles parallel ATCF discovery internally —
                // if it returned not_found, show manual override.
                _rtShipsLoading = false;
                if (statusEl) {
                    statusEl.style.display = '';
                    statusEl.innerHTML = '<span style="color:#f87171;">SHIPS not found for ' + stormName + '. Use manual override below.</span>';
                }
                var manualEl = document.getElementById('rt-ships-manual');
                if (manualEl) manualEl.style.display = '';
            });
    }

    // Enable all SHIPS-dependent diagnostic buttons
    function _rtEnableSHIPSDiagnostics() {
        var quadBtn = document.getElementById('rt-quad-btn');
        var anomalyBtn = document.getElementById('rt-anomaly-btn');
        var vpBtn = document.getElementById('rt-vp-btn');
        if (quadBtn) quadBtn.disabled = false;
        if (anomalyBtn) anomalyBtn.disabled = false;
        if (vpBtn) vpBtn.disabled = false;

        // Add shear vector inset to existing plan-view plot (if rendered)
        _rtAddShearToPlot();
    }

    // Shear vector overlay now handled by HTML compass strip.
    // This function is kept as a no-op to avoid breaking callers.
    function _rtAddShearToPlot() {
        // No longer adds shear inset to Plotly; compass strip handles display
    }

    function _rtRenderSHIPSPanel(data) {
        var panel = document.getElementById('rt-ships-panel');
        if (!panel) return;

        var sd = data.ships_data || {};
        var vp = data.ventilation_proxy;
        var atcfTag = data.atcf_id ? ' <span style="color:#8b9ec2;font-weight:400;">(' + data.atcf_id + ')</span>' : '';
        var autoTag = data.auto_detected ? ' <span style="color:#34d399;font-size:9px;">auto</span>' : '';

        var rows = [
            '<div style="font-size:11px;font-weight:600;color:#fdba74;margin-bottom:4px;">\ud83d\udce1 SHIPS Environmental Data' + atcfTag + autoTag + '</div>',
            '<table style="width:100%;font-size:10px;color:#d1d5db;border-collapse:collapse;">',
        ];

        var shgcEst = data.vp_components && data.vp_components.shgc_est_kt
            ? data.vp_components.shgc_est_kt : null;
        var shgcRatio = data.vp_components && data.vp_components.shgc_shdc_ratio
            ? data.vp_components.shgc_shdc_ratio : null;
        var shearVal = '\u2014';
        if (sd.shear_kt != null) {
            shearVal = sd.shear_kt + ' kt / ' + (sd.sddc != null ? sd.sddc + '\u00b0' : '?');
        }
        var shgcVal = '\u2014';
        if (shgcEst != null) {
            shgcVal = shgcEst.toFixed(1) + ' kt' + (shgcRatio != null ? ' (\u00d7' + shgcRatio.toFixed(2) + ')' : '');
        }
        var fields = [
            ['Vmax', sd.vmax_kt != null ? sd.vmax_kt + ' kt' : '\u2014'],
            ['Shear (SHDC)', shearVal],
            ['SHGC Est', shgcVal],
            ['SST', sd.sst_c != null ? sd.sst_c + ' \u00b0C' : '\u2014'],
            ['MPI', sd.pot_int_kt != null ? sd.pot_int_kt + ' kt' : '\u2014'],
            ['RH (700-500)', sd.rhmd != null ? sd.rhmd + '%' : '\u2014'],
            ['VP', vp != null ? vp.toFixed(2) : '\u2014'],
        ];

        fields.forEach(function (f) {
            rows.push('<tr><td style="padding:1px 4px;color:#8b9ec2;white-space:nowrap;">' + f[0] + '</td>' +
                '<td style="padding:1px 4px;text-align:right;font-family:JetBrains Mono,monospace;">' + f[1] + '</td></tr>');
        });

        rows.push('</table>');
        panel.innerHTML = rows.join('');
        panel.style.display = '';
    }

    window.rtFetchQuadrants = function () {
        if (!_currentFileUrl || !_rtShipsData) {
            rtToast('Load SHIPS data first', 'warn');
            return;
        }

        var sddc = _rtShipsData.ships_data.sddc;
        if (sddc == null) {
            rtToast('SHIPS shear direction not available', 'warn');
            return;
        }

        var btn = document.getElementById('rt-quad-btn');
        var container = document.getElementById('rt-quad-result');
        if (!btn || !container) return;

        btn.disabled = true;
        btn.textContent = 'Loading...';

        var variable = document.getElementById('rt-var').value || 'TANGENTIAL_WIND';
        var overlay = document.getElementById('rt-overlay').value || '';

        var covSlider = document.getElementById('coverage-slider');
        var covVal = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;

        var url = API_BASE + RT_PREFIX + '/quadrant_mean?' +
            'file_url=' + encodeURIComponent(_currentFileUrl) +
            '&variable=' + encodeURIComponent(variable) +
            '&sddc=' + sddc +
            '&max_radius_km=200&dr_km=2&coverage_min=' + covVal +
            (overlay ? '&overlay=' + encodeURIComponent(overlay) : '');

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                _rtRenderQuadrants(data, variable);
            })
            .catch(function (err) {
                rtToast('Quadrant error: ' + err.message, 'error');
            })
            .finally(function () {
                btn.disabled = false;
                btn.textContent = '⊙ Shear Quads';
            });
    };

    function _rtRenderQuadrants(data, variable) {
        var container = document.getElementById('rt-quad-result');
        if (!container) return;

        // ── Single-chart subplot approach (matches archive) ──
        // One Plotly.newPlot with 4 traces on 4 subplot axes — no CSS Grid.
        container.innerHTML =
            '<div class="storm-timeline-panel" style="margin-top:10px;">' +
            '<div class="fl-ts-header">' +
            '<span class="fl-ts-title">\u2299 Shear-Relative Quadrant Means (SDDC: ' + data.sddc + '\u00b0)</span>' +
            _rtSaveBtnHTML('rt-quad-chart', 'QuadrantMeans', 'margin-left:auto;') +
            '<button onclick="document.getElementById(\'rt-quad-result\').innerHTML=\'\'" class="fl-ts-close" title="Close">&times;</button>' +
            '</div>' +
            '<div id="rt-quad-chart" style="width:100%;height:550px;border-radius:6px;overflow:hidden;"></div>' +
            '</div>';

        var varInfo = null;
        if (_rtLastPlotlyData && _rtLastPlotlyData.json && _rtLastPlotlyData.json.variable) {
            varInfo = _rtLastPlotlyData.json.variable;
        }
        var cmap = varInfo ? varInfo.colorscale : 'RdBu';
        var units = varInfo ? varInfo.units : '';
        var dispName = varInfo ? varInfo.display_name : variable;
        var vmin = varInfo ? varInfo.vmin : 0;
        var vmax_val = varInfo ? varInfo.vmax : 80;

        // Panel layout: shear points RIGHT
        //   USL (top-left)  |  DSL (top-right)
        //   USR (bot-left)  |  DSR (bot-right)
        var panelOrder = [
            { key: 'USL', label: 'Upshear Left',     row: 0, col: 0 },
            { key: 'DSL', label: 'Downshear Left',   row: 0, col: 1 },
            { key: 'USR', label: 'Upshear Right',    row: 1, col: 0 },
            { key: 'DSR', label: 'Downshear Right',  row: 1, col: 1 }
        ];

        var quadColors = { DSL: '#f59e0b', DSR: '#f59e0b', USL: '#60a5fa', USR: '#60a5fa' };
        var fontSize = { title: 11, axis: 9, tick: 8, cbar: 9, cbarTick: 8, hover: 10, panel: 10 };

        // Subplot geometry (paper coordinates)
        var gap = 0.10;
        var cbarW = 0.04;
        var leftM = 0.06, rightM = 0.02 + cbarW + 0.02;
        var topM = 0.10, botM = 0.06;
        var pw = (1 - leftM - rightM - gap) / 2;
        var ph = (1 - topM - botM - gap) / 2;

        var axConfigs = [
            { x0: leftM,          x1: leftM + pw,          y0: 1 - topM - ph, y1: 1 - topM },
            { x0: leftM + pw + gap, x1: leftM + 2*pw + gap, y0: 1 - topM - ph, y1: 1 - topM },
            { x0: leftM,          x1: leftM + pw,          y0: botM,           y1: botM + ph },
            { x0: leftM + pw + gap, x1: leftM + 2*pw + gap, y0: botM,           y1: botM + ph }
        ];

        var traces = [];
        var annotations = [];
        var shapes = [];
        var plotBg = '#0a1628';

        var layout = {
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            margin: { l: 45, r: 55, t: 70, b: 42 },
            showlegend: false,
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: fontSize.hover } }
        };

        panelOrder.forEach(function (p, i) {
            var qData = data.quadrant_means[p.key];
            if (!qData || !qData.data) return;

            var axSuffix = i === 0 ? '' : String(i + 1);
            var showCbar = (i === 1); // top-right panel
            var ac = axConfigs[i];

            traces.push({
                z: qData.data,
                x: data.radius_km,
                y: data.height_km,
                type: 'heatmap',
                colorscale: cmap,
                zmin: vmin,
                zmax: vmax_val,
                xaxis: 'x' + axSuffix,
                yaxis: 'y' + axSuffix,
                showscale: showCbar,
                colorbar: showCbar ? {
                    title: { text: units, font: { color: '#ccc', size: fontSize.cbar } },
                    tickfont: { color: '#ccc', size: fontSize.cbarTick },
                    thickness: 10, len: 0.85, x: 1.02, y: 0.5
                } : undefined,
                hovertemplate: '<b>' + p.label + '</b><br>' + dispName + ': %{z:.2f} ' + units +
                    '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>',
                hoverongaps: false
            });

            // Panel title annotation
            annotations.push({
                text: '<b>' + p.label + '</b>',
                xref: 'paper', yref: 'paper',
                x: (ac.x0 + ac.x1) / 2, y: ac.y1 + 0.005,
                xanchor: 'center', yanchor: 'bottom', showarrow: false,
                font: { color: quadColors[p.key] || '#ccc', size: fontSize.panel, family: 'JetBrains Mono, monospace' },
                bgcolor: 'rgba(10,22,40,0.7)', borderpad: 2
            });

            // Axes
            var showXLabel = (p.row === 1);
            var showYLabel = (p.col === 0);
            layout['xaxis' + axSuffix] = {
                domain: [ac.x0, ac.x1],
                title: showXLabel ? { text: 'Radius (km)', font: { color: '#aaa', size: fontSize.axis } } : undefined,
                tickfont: { color: '#aaa', size: fontSize.tick },
                gridcolor: 'rgba(255,255,255,0.04)', zeroline: false,
                anchor: 'y' + axSuffix
            };
            layout['yaxis' + axSuffix] = {
                domain: [ac.y0, ac.y1],
                title: showYLabel ? { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } } : undefined,
                tickfont: { color: '#aaa', size: fontSize.tick },
                gridcolor: 'rgba(255,255,255,0.04)', zeroline: false,
                anchor: 'x' + axSuffix
            };
        });

        // Shear vector inset between the 4 panels
        var sddc = data.sddc;
        if (sddc !== null && sddc !== undefined && sddc !== 9999) {
            var insetCx = leftM + pw + gap / 2;
            var insetCy = botM + ph + gap / 2;
            var insetR = Math.min(gap, 0.06) * 0.55;
            var theta = (90 - sddc) * Math.PI / 180;
            var arrowLen = insetR * 0.8;
            var adx = arrowLen * Math.cos(theta);
            var ady = arrowLen * Math.sin(theta);
            shapes.push({ type: 'circle', xref: 'paper', yref: 'paper',
                x0: insetCx - insetR, y0: insetCy - insetR, x1: insetCx + insetR, y1: insetCy + insetR,
                fillcolor: 'rgba(10,22,40,0.9)', line: { color: 'rgba(245,158,11,0.4)', width: 1.5 } });
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper',
                x0: insetCx - adx * 0.3, y0: insetCy - ady * 0.3, x1: insetCx + adx, y1: insetCy + ady,
                line: { color: '#f59e0b', width: 2.5 } });
            var headLen = arrowLen * 0.35, headAng = 25 * Math.PI / 180;
            var tipX = insetCx + adx, tipY = insetCy + ady;
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper',
                x0: tipX, y0: tipY,
                x1: tipX + headLen * Math.cos(theta + Math.PI - headAng),
                y1: tipY + headLen * Math.sin(theta + Math.PI - headAng),
                line: { color: '#f59e0b', width: 2.5 } });
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper',
                x0: tipX, y0: tipY,
                x1: tipX + headLen * Math.cos(theta + Math.PI + headAng),
                y1: tipY + headLen * Math.sin(theta + Math.PI + headAng),
                line: { color: '#f59e0b', width: 2.5 } });
            annotations.push({ text: 'DS', xref: 'paper', yref: 'paper',
                x: insetCx + adx * 1.6, y: insetCy + ady * 1.6,
                showarrow: false, font: { color: '#f59e0b', size: 7, family: 'JetBrains Mono,monospace' } });
        }

        // Main title
        var shearStr = (sddc !== null && sddc !== undefined && sddc !== 9999) ? ' | Shear: ' + Number(sddc).toFixed(0) + '\u00b0' : '';
        layout.title = {
            text: 'Shear-Relative Quadrant Mean: ' + dispName + shearStr,
            font: { color: '#e5e7eb', size: fontSize.title }, y: 0.99, x: 0.5, xanchor: 'center'
        };
        layout.shapes = shapes;
        layout.annotations = annotations;

        Plotly.newPlot('rt-quad-chart', traces, layout, {
            responsive: true, displayModeBar: false, displaylogo: false
        });
    }

    window.rtFetchAnomaly = function () {
        if (!_currentFileUrl) {
            rtToast('Load a TDR file first', 'warn');
            return;
        }

        var btn = document.getElementById('rt-anomaly-btn');
        var container = document.getElementById('rt-anomaly-result');
        if (!btn || !container) return;

        btn.disabled = true;
        btn.textContent = 'Loading...';

        var variable = document.getElementById('rt-var').value || 'TANGENTIAL_WIND';

        // Get Vmax from SHIPS (required — button should only be enabled after SHIPS loads)
        var vmax = null;
        if (_rtShipsData && _rtShipsData.ships_data && _rtShipsData.ships_data.vmax_kt != null) {
            vmax = _rtShipsData.ships_data.vmax_kt;
        } else {
            rtToast('SHIPS data required for Z* anomaly — fetch SHIPS first', 'warn');
            btn.disabled = false; btn.textContent = 'Z* Anomaly';
            return;
        }

        var covSlider = document.getElementById('coverage-slider');
        var covVal = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;

        var url = API_BASE + RT_PREFIX + '/anomaly_azimuthal_mean?' +
            'file_url=' + encodeURIComponent(_currentFileUrl) +
            '&variable=' + encodeURIComponent(variable) +
            '&vmax_kt=' + vmax +
            '&coverage_min=' + covVal;

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                _rtRenderAnomaly(data, variable);
            })
            .catch(function (err) {
                rtToast('Anomaly error: ' + err.message, 'error');
            })
            .finally(function () {
                btn.disabled = false;
                btn.textContent = 'Z* Anomaly';
            });
    };

    // Build custom tick labels for hybrid R_H axis (matches archive behavior)
    function _rtBuildHybridXAxis(rHAxis, nInner) {
        var tickvals = [], ticktext = [];
        for (var i = 0; i < rHAxis.length; i++) {
            if (i < nInner) {
                // Inner: show every 0.2 R/RMW
                var val = rHAxis[i];
                if (Math.abs(val % 0.2) < 0.03) {
                    tickvals.push(i);
                    ticktext.push(val.toFixed(1));
                }
            } else {
                // Outer: show at RMW, +20, +40, +60, +80, +100
                var km = rHAxis[i];
                if (i === nInner) {
                    tickvals.push(i);
                    ticktext.push('RMW');
                } else {
                    var target = Math.round(km / 20) * 20;
                    if (target > 0 && Math.abs(km - target) < 2.0) {
                        var thisLabel = '+' + target;
                        if (ticktext.length === 0 || ticktext[ticktext.length - 1] !== thisLabel) {
                            tickvals.push(i);
                            ticktext.push(thisLabel);
                        }
                    }
                }
            }
        }
        return { tickvals: tickvals, ticktext: ticktext };
    }

    function _rtRenderAnomaly(data, variable) {
        var container = document.getElementById('rt-anomaly-result');
        if (!container) return;

        var climNote = data.climatology_available ?
            'Clim. bin: ' + data.climatology_intensity_bin + ' kt (' + data.climatology_count + ' cases)' :
            'Climatology not available';

        var vmaxStr = data.vmax_kt != null ? data.vmax_kt : '?';

        container.innerHTML =
            '<div class="storm-timeline-panel" style="margin-top:10px;">' +
            '<div class="fl-ts-header">' +
            '<span class="fl-ts-title">Z* Anomaly \u2014 ' + variable + ' (Vmax: ' + vmaxStr + ' kt, RMW: ' + data.rmw_km + ' km)</span>' +
            _rtSaveBtnHTML('rt-anomaly-chart', 'ZstarAnomaly', 'margin-left:auto;') +
            '<button onclick="document.getElementById(\'rt-anomaly-result\').innerHTML=\'\'" class="fl-ts-close" title="Close">&times;</button>' +
            '</div>' +
            '<div style="font-size:9px;color:#8b9ec2;padding:2px 8px;">' + climNote + '</div>' +
            '<div id="rt-anomaly-chart" style="width:100%;height:320px;"></div>' +
            '</div>';

        // Diverging colorscale: blue (negative) → white (0) → red (positive)
        var zColorscale = [
            [0.0, 'rgb(5,48,97)'], [0.1, 'rgb(33,102,172)'],
            [0.2, 'rgb(67,147,195)'], [0.3, 'rgb(146,197,222)'],
            [0.4, 'rgb(209,229,240)'], [0.5, 'rgb(247,247,247)'],
            [0.6, 'rgb(253,219,199)'], [0.7, 'rgb(244,165,130)'],
            [0.8, 'rgb(214,96,77)'], [0.9, 'rgb(178,24,43)'],
            [1.0, 'rgb(103,0,31)']
        ];

        // Use sequential integer indices for x (equally spaced), with custom tick labels
        var rHAxis = data.r_h_axis, nInner = data.n_inner;
        var xIdxArr = [];
        for (var i = 0; i < rHAxis.length; i++) xIdxArr.push(i);
        var ticks = _rtBuildHybridXAxis(rHAxis, nInner);

        // Vertical dashed line at the RMW boundary (index = nInner)
        var shapes = [];
        if (nInner > 0) {
            shapes.push({
                type: 'line', xref: 'x', yref: 'paper',
                x0: nInner, x1: nInner, y0: 0, y1: 1,
                line: { color: 'rgba(255,255,255,0.5)', width: 1.5, dash: 'dash' }
            });
        }

        var trace = {
            z: data.anomaly,
            x: xIdxArr,
            y: data.height_km,
            type: 'heatmap',
            colorscale: zColorscale,
            zmin: -3, zmax: 3, zmid: 0,
            colorbar: {
                title: { text: '\u03c3', font: { color: '#ccc', size: 9 } },
                tickfont: { color: '#ccc', size: 8 },
                thickness: 10, len: 0.85,
                tickvals: [-3, -2, -1, 0, 1, 2, 3],
            },
            hoverongaps: false,
            hovertemplate: '<b>Z*</b>: %{z:.2f}\u03c3<br>R\u2095: %{customdata}<br>Height: %{y:.1f} km<extra></extra>',
            customdata: data.height_km.map(function() {
                return rHAxis.map(function(v, idx) {
                    return idx < nInner ? (v.toFixed(2) + ' R/RMW') : ('+' + v.toFixed(0) + ' km');
                });
            })
        };

        var layout = {
            paper_bgcolor: '#0a1628', plot_bgcolor: '#0a1628',
            xaxis: {
                title: { text: 'R\u2095 (inner: R/RMW | outer: RMW + km)', font: { size: 10, color: '#8b9ec2' } },
                tickvals: ticks.tickvals, ticktext: ticks.ticktext,
                tickfont: { size: 9, color: '#8b9ec2' },
                gridcolor: 'rgba(255,255,255,0.04)', zeroline: false,
            },
            yaxis: {
                title: { text: 'Height (km)', font: { size: 10, color: '#8b9ec2' } },
                tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
                gridcolor: 'rgba(255,255,255,0.04)',
                range: [0, 15]
            },
            shapes: shapes,
            margin: { l: 45, r: 12, t: 8, b: 40 },
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } }
        };

        Plotly.newPlot('rt-anomaly-chart', [trace], layout, {
            responsive: true, displayModeBar: false, displaylogo: false
        });
    }

    // ── VP Favorability Scatter ──────────────────────────────────────
    // Fetches the archive VP scatter and overlays the current real-time case
    window.rtFetchVPScatter = function (colorBy) {
        colorBy = colorBy || 'dvmax_12h';
        if (!_currentFileUrl || !_rtShipsData) {
            rtToast('Load SHIPS data first', 'warn');
            return;
        }

        var btn = document.getElementById('rt-vp-btn');
        var container = document.getElementById('rt-vp-result');
        if (!btn || !container) return;

        btn.disabled = true;
        btn.textContent = 'Loading...';

        var currentVP = _rtShipsData.ventilation_proxy;
        var currentVmax = _rtShipsData.ships_data ? _rtShipsData.ships_data.vmax_kt : null;
        var stormName = _rtShipsData.storm_name || '';

        // Fetch archive VP scatter data AND real-time vortex metrics in parallel
        var scatterUrl = API_BASE + '/scatter/vp_favorability?data_type=merge&color_by=' + colorBy;

        var vortexPromise = Promise.resolve(null);
        if (_currentFileUrl && currentVmax != null) {
            var vortexUrl = API_BASE + RT_PREFIX + '/vortex_raw?' +
                'file_url=' + encodeURIComponent(_currentFileUrl) +
                '&vmax_kt=' + currentVmax;
            vortexPromise = fetch(vortexUrl)
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { return null; });
        }

        Promise.all([
            fetch(scatterUrl, { cache: 'no-store' })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                }),
            vortexPromise
        ])
            .then(function (results) {
                var json = results[0];
                var vortex = results[1];
                var currentVF = (vortex && vortex.vortex_favorability != null)
                    ? vortex.vortex_favorability : null;
                var currentVH = (vortex && vortex.vortex_height != null)
                    ? vortex.vortex_height : null;
                var currentVW = (vortex && vortex.vortex_width != null)
                    ? vortex.vortex_width : null;
                _rtRenderVPScatter(json, colorBy, currentVP, currentVmax, stormName, currentVF, currentVH, currentVW);
            })
            .catch(function (err) {
                rtToast('VP Scatter: ' + err.message, 'error');
            })
            .finally(function () {
                btn.disabled = false;
                btn.textContent = '\u2B24 VP Scatter';
            });
    };

    function _rtRenderVPScatter(json, colorBy, currentVP, currentVmax, stormName, currentVF, currentVH, currentVW) {
        var container = document.getElementById('rt-vp-result');
        if (!container) return;

        var points = json.points || [];
        var dvmaxLabel = colorBy === 'dvmax_12h' ? '12-h \u0394Vmax (kt)' : '24-h \u0394Vmax (kt)';

        // Filter points with valid vortex favorability
        var withVF = points.filter(function (p) {
            return p.vortex_favorability != null;
        });

        container.innerHTML =
            '<div class="storm-timeline-panel" style="margin-top:10px;">' +
            '<div class="fl-ts-header">' +
            '<span class="fl-ts-title">\u2B24 VP Favorability Scatter' +
            (currentVP != null ? ' (VP = ' + currentVP.toFixed(2) + ')' : '') + '</span>' +
            '<div style="display:flex;gap:4px;margin-left:auto;">' +
            '<button class="cs-btn" onclick="rtFetchVPScatter(\'dvmax_12h\')" style="font-size:10px;padding:2px 8px;">12-h</button>' +
            '<button class="cs-btn" onclick="rtFetchVPScatter(\'dvmax_24h\')" style="font-size:10px;padding:2px 8px;">24-h</button>' +
            '</div>' +
            _rtSaveBtnHTML('rt-vp-chart', 'VPScatter', '') +
            '<button onclick="document.getElementById(\'rt-vp-result\').innerHTML=\'\'" class="fl-ts-close" title="Close">&times;</button>' +
            '</div>' +
            '<div id="rt-vp-chart" style="width:100%;height:400px;"></div>' +
            '</div>';

        if (withVF.length === 0) {
            container.querySelector('#rt-vp-chart').innerHTML =
                '<div style="color:#8b9ec2;text-align:center;padding:40px;">Archive VP scatter data not yet loaded on server. Try again in ~1 min.</div>';
            return;
        }

        var dvmaxColorscale = [
            [0.0, 'rgb(0,128,128)'], [0.15, 'rgb(64,175,175)'],
            [0.3, 'rgb(140,210,210)'], [0.4, 'rgb(200,235,235)'],
            [0.5, 'rgb(245,245,245)'],
            [0.6, 'rgb(253,219,199)'], [0.7, 'rgb(244,165,130)'],
            [0.85, 'rgb(214,96,77)'], [1.0, 'rgb(178,24,43)']
        ];

        var vps = withVF.map(function (p) { return p.vp; });
        var vfs = withVF.map(function (p) { return p.vortex_favorability; });
        var dvs = withVF.map(function (p) { return p[colorBy] || 0; });
        var labels = withVF.map(function (p) { return p.storm_name + ' ' + p.datetime; });
        var vmaxs = withVF.map(function (p) { return p.vmax_kt != null ? p.vmax_kt : ''; });

        // Also extract height/width for the right panel
        var withHW = withVF.filter(function (p) {
            return p.vortex_height != null && p.vortex_width != null;
        });
        var vhs = withHW.map(function (p) { return p.vortex_height; });
        var vws = withHW.map(function (p) { return p.vortex_width; });
        var hwDvs = withHW.map(function (p) { return p[colorBy] || 0; });
        var hwLabels = withHW.map(function (p) { return p.storm_name + ' ' + p.datetime; });
        var hwVmaxs = withHW.map(function (p) { return p.vmax_kt != null ? p.vmax_kt : ''; });

        var traces = [];

        // ── Left panel: VP vs Vortex Favorability ──
        traces.push({
            x: vps, y: vfs, mode: 'markers', type: 'scatter',
            xaxis: 'x', yaxis: 'y',
            marker: {
                size: 6, color: dvs, colorscale: dvmaxColorscale, cmin: -30, cmax: 30,
                opacity: 0.7,
                line: { color: 'rgba(255,255,255,0.3)', width: 0.5 },
                colorbar: {
                    title: { text: dvmaxLabel, font: { color: '#ccc', size: 9 } },
                    tickfont: { color: '#ccc', size: 8 }, thickness: 10, len: 0.85
                }
            },
            text: labels, customdata: vmaxs,
            hovertemplate: '<b>%{text}</b><br>Vmax: %{customdata} kt<br>VP: %{x:.2f}<br>Favorability: %{y:.2f}<br>\u0394Vmax: %{marker.color:.0f} kt<extra></extra>',
            name: 'Archive (' + withVF.length + ')', showlegend: true
        });

        // ── Right panel: Anomalous Height vs Width ──
        if (withHW.length > 0) {
            traces.push({
                x: vws, y: vhs, mode: 'markers', type: 'scatter',
                xaxis: 'x2', yaxis: 'y2',
                marker: {
                    size: 6, color: hwDvs, colorscale: dvmaxColorscale, cmin: -30, cmax: 30,
                    opacity: 0.7,
                    line: { color: 'rgba(255,255,255,0.3)', width: 0.5 },
                    showscale: false
                },
                text: hwLabels, customdata: hwVmaxs,
                hovertemplate: '<b>%{text}</b><br>Vmax: %{customdata} kt<br>Width: %{x:.2f}<br>Height: %{y:.2f}<br>\u0394Vmax: %{marker.color:.0f} kt<extra></extra>',
                name: 'Archive (H\u00d7W)', showlegend: false
            });
        }

        // 2-sigma ellipses for RI/SI/NI groups
        var grpColors = { RI: 'rgba(239,68,68,0.6)', SI: 'rgba(251,191,36,0.6)', NI: 'rgba(96,165,250,0.6)' };
        var vpGroups = { RI: { vp: [], vf: [] }, SI: { vp: [], vf: [] }, NI: { vp: [], vf: [] } };
        var hwGroups = { RI: { h: [], w: [] }, SI: { h: [], w: [] }, NI: { h: [], w: [] } };

        for (var i = 0; i < withVF.length; i++) {
            var p = withVF[i];
            if (p.vmax_kt != null && p.vmax_kt > 100) continue;
            var dv = p[colorBy] || 0;
            var gk = dv >= 20 ? 'RI' : (dv > 0 ? 'SI' : 'NI');
            vpGroups[gk].vp.push(p.vp);
            vpGroups[gk].vf.push(p.vortex_favorability);
            if (p.vortex_height != null && p.vortex_width != null) {
                hwGroups[gk].h.push(p.vortex_height);
                hwGroups[gk].w.push(p.vortex_width);
            }
        }

        function _ms(arr) {
            var n = arr.length; if (n === 0) return { m: 0, s: 0 };
            var m = arr.reduce(function (a, b) { return a + b; }, 0) / n;
            var s = Math.sqrt(arr.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / n);
            return { m: m, s: s };
        }

        var grpNames = ['RI', 'SI', 'NI'];
        for (var gi = 0; gi < grpNames.length; gi++) {
            var grp = grpNames[gi];

            // Left panel ellipse (VP vs Favorability)
            var g = vpGroups[grp];
            if (g.vp.length >= 3) {
                var vpS = _ms(g.vp), vfS = _ms(g.vf);
                var ellX = [], ellY = [];
                for (var a = 0; a <= 360; a += 5) {
                    var rad = a * Math.PI / 180;
                    ellX.push(vpS.m + 2 * vpS.s * Math.cos(rad));
                    ellY.push(vfS.m + 2 * vfS.s * Math.sin(rad));
                }
                traces.push({
                    x: ellX, y: ellY, mode: 'lines', type: 'scatter',
                    xaxis: 'x', yaxis: 'y',
                    line: { color: grpColors[grp], width: 2, dash: 'dot' },
                    name: grp + ' (n=' + g.vp.length + ')', legendgroup: grp, showlegend: true
                });
            }

            // Right panel ellipse (Width vs Height)
            var hw = hwGroups[grp];
            if (hw && hw.h.length >= 3) {
                var hStat = _ms(hw.h), wStat = _ms(hw.w);
                var eX2 = [], eY2 = [];
                for (var a2 = 0; a2 <= 360; a2 += 5) {
                    var r2 = a2 * Math.PI / 180;
                    eX2.push(wStat.m + 2 * wStat.s * Math.cos(r2));
                    eY2.push(hStat.m + 2 * hStat.s * Math.sin(r2));
                }
                traces.push({
                    x: eX2, y: eY2, mode: 'lines', type: 'scatter',
                    xaxis: 'x2', yaxis: 'y2',
                    line: { color: grpColors[grp], width: 2, dash: 'dot' },
                    name: grp + ' (2\u03c3)', legendgroup: grp, showlegend: false
                });
            }
        }

        // Current real-time case: star markers on both panels
        var annotations = [];
        if (currentVP != null) {
            var starY = currentVF != null ? currentVF : 0;
            var vfLabel = currentVF != null ? ', VF=' + currentVF.toFixed(2) : '';
            var hoverVF = currentVF != null
                ? 'Favorability: ' + currentVF.toFixed(2)
                : 'Favorability: computing...';

            annotations.push({
                x: currentVP, y: 1.05, xref: 'x', yref: 'paper',
                text: stormName + ' (VP=' + currentVP.toFixed(2) + vfLabel + ')',
                showarrow: false,
                font: { color: '#22d3ee', size: 11, family: 'JetBrains Mono' },
                xanchor: 'center'
            });
            // Star marker on left panel at (VP, VF)
            traces.push({
                x: [currentVP], y: [starY], mode: 'markers', type: 'scatter',
                xaxis: 'x', yaxis: 'y',
                marker: {
                    symbol: 'star', size: 18, color: '#22d3ee',
                    line: { color: '#ffffff', width: 2 }
                },
                name: stormName + ' (current)',
                showlegend: true,
                hovertemplate: '<b>' + stormName + '</b><br>VP: ' + currentVP.toFixed(2) + '<br>' + hoverVF + '<extra></extra>'
            });

            // Star marker on right panel at (Width, Height)
            if (currentVH != null && currentVW != null) {
                annotations.push({
                    x: currentVW, y: 1.05, xref: 'x2', yref: 'paper',
                    text: stormName + ' (VH=' + currentVH.toFixed(2) + ', VW=' + currentVW.toFixed(2) + ')',
                    showarrow: false,
                    font: { color: '#22d3ee', size: 11, family: 'JetBrains Mono' },
                    xanchor: 'center'
                });
                traces.push({
                    x: [currentVW], y: [currentVH], mode: 'markers', type: 'scatter',
                    xaxis: 'x2', yaxis: 'y2',
                    marker: {
                        symbol: 'star', size: 18, color: '#22d3ee',
                        line: { color: '#ffffff', width: 2 }
                    },
                    name: stormName + ' (current)',
                    showlegend: false,
                    hovertemplate: '<b>' + stormName + '</b><br>Width: ' + currentVW.toFixed(2) + '<br>Height: ' + currentVH.toFixed(2) + '<extra></extra>'
                });
            }
        }

        var layout = {
            paper_bgcolor: '#0a1628', plot_bgcolor: '#0a1628',
            // Left panel: VP vs Favorability
            xaxis: {
                title: { text: 'Ventilation Proxy (VP)', font: { size: 10, color: '#8b9ec2' } },
                tickfont: { size: 9, color: '#8b9ec2' },
                gridcolor: 'rgba(255,255,255,0.04)', zeroline: false,
                domain: [0, 0.45]
            },
            yaxis: {
                title: { text: 'Vortex Favorability (VH \u2212 VW)', font: { size: 10, color: '#8b9ec2' } },
                tickfont: { size: 9, color: '#8b9ec2' },
                gridcolor: 'rgba(255,255,255,0.04)', zeroline: true,
                zerolinecolor: 'rgba(255,255,255,0.1)',
            },
            // Right panel: Height vs Width
            xaxis2: {
                title: { text: 'Anomalous Vortex Width (W1\u2013W2)', font: { size: 10, color: '#8b9ec2' } },
                tickfont: { size: 9, color: '#8b9ec2' },
                gridcolor: 'rgba(255,255,255,0.04)', zeroline: false,
                domain: [0.55, 1.0], anchor: 'y2'
            },
            yaxis2: {
                title: { text: 'Anomalous Vortex Height (H1)', font: { size: 10, color: '#8b9ec2' } },
                tickfont: { size: 9, color: '#8b9ec2' },
                gridcolor: 'rgba(255,255,255,0.04)', zeroline: false,
                anchor: 'x2'
            },
            annotations: annotations,
            margin: { l: 50, r: 50, t: 30, b: 45 },
            legend: {
                x: 0.45, y: 0.99, xanchor: 'right', yanchor: 'top',
                font: { color: '#aaa', size: 9 },
                bgcolor: 'rgba(10,22,40,0.8)', bordercolor: 'rgba(255,255,255,0.1)', borderwidth: 1,
                orientation: 'h'
            },
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 10 } }
        };

        Plotly.newPlot('rt-vp-chart', traces, layout, {
            responsive: true, displayModeBar: true, displaylogo: false,
            modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines']
        });
    }

    // ── Real-Time Wind Barbs ────────────────────────────────────

    var _rtBarbsEnabled = false;

    window.rtToggleBarbs = function () {
        var btn = document.getElementById('rt-barb-btn');
        _rtBarbsEnabled = !_rtBarbsEnabled;
        if (btn) btn.classList.toggle('active', _rtBarbsEnabled);
        // Re-generate the plot (barbs are added as Plotly shapes during render)
        rtGeneratePlot();
    };

    // ── Real-Time Tilt Hodograph ──────────────────────────────────

    var _rtTiltData = null;          // tilt profile from API
    var _rtTiltTraceStart = -1;      // index where tilt traces start in plan-view
    var _rtTiltEnabled = false;      // toggle state
    var _rtTilt3DTraceStart = -1;    // index where tilt traces start in 3D viewer

    window.rtToggleTilt = function () {
        var btn = document.getElementById('rt-tilt-btn');
        if (!btn) return;

        if (_rtTiltEnabled) {
            // Turn off: hide traces
            _rtTiltEnabled = false;
            btn.classList.remove('active');
            _rtRemoveTiltTraces();
            return;
        }

        // Turn on: fetch if needed, then draw
        if (_rtTiltData) {
            _rtTiltEnabled = true;
            btn.classList.add('active');
            _rtAddTiltTraces(_rtTiltData);
            return;
        }

        // Fetch tilt profile from API
        if (!_currentFileUrl) return;
        btn.disabled = true;
        btn.classList.add('pill-pulse');

        // Show elapsed-time progress indicator
        var tiltStartTime = Date.now();
        var tiltStatusEl = document.getElementById('rt-tilt-status');
        if (!tiltStatusEl) {
            tiltStatusEl = document.createElement('div');
            tiltStatusEl.id = 'rt-tilt-status';
            tiltStatusEl.style.cssText = 'font-size:10px;color:#6ee7b7;padding:4px 8px;font-family:JetBrains Mono,monospace;';
            // Insert after the layers strip
            var layerStrip = btn.closest('.overlay-strip');
            if (layerStrip && layerStrip.parentElement) layerStrip.parentElement.insertBefore(tiltStatusEl, layerStrip.nextSibling);
        }
        tiltStatusEl.style.display = 'block';
        tiltStatusEl.textContent = '\u23F3 Computing WCM centres at 16 heights (0.5\u20138 km)\u2026 0s';
        var tiltTimer = setInterval(function () {
            var elapsed = ((Date.now() - tiltStartTime) / 1000).toFixed(0);
            tiltStatusEl.textContent = '\u23F3 Computing WCM centres at 16 heights (0.5\u20138 km)\u2026 ' + elapsed + 's';
        }, 1000);

        var url = API_BASE + RT_PREFIX + '/tilt_profile?file_url=' + encodeURIComponent(_currentFileUrl);
        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 120000);
        fetch(url, { signal: controller.signal })
            .then(function (r) {
                if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); });
                return r.json();
            })
            .then(function (json) {
                _rtTiltData = json;
                _rtTiltEnabled = true;
                btn.classList.add('active');
                _rtAddTiltTraces(json);
                var nLevels = json.height_km ? json.height_km.length : '?';
                var elapsed = json.compute_time_s !== undefined ? json.compute_time_s.toFixed(1) : ((Date.now() - tiltStartTime) / 1000).toFixed(1);
                tiltStatusEl.textContent = '\u2713 Tilt profile: ' + nLevels + ' levels in ' + elapsed + 's';
                setTimeout(function () { tiltStatusEl.style.display = 'none'; }, 6000);
            })
            .catch(function (err) {
                var msg = err.name === 'AbortError' ? 'Tilt request timed out (120s).' : err.message;
                rtToast('Tilt: ' + msg, 'error');
                btn.classList.remove('active');
                tiltStatusEl.textContent = '\u2717 ' + msg;
                setTimeout(function () { tiltStatusEl.style.display = 'none'; }, 8000);
            })
            .finally(function () { clearInterval(tiltTimer); clearTimeout(timeout); btn.disabled = false; btn.classList.remove('pill-pulse'); });
    };

    function _rtAddTiltTraces(tiltData) {
        var chartDiv = document.getElementById('rt-plotly-chart');
        if (!chartDiv || !chartDiv.data || !tiltData || !tiltData.x_km || !tiltData.x_km.length) return;

        var rawX = tiltData.x_km, rawY = tiltData.y_km, rawZ = tiltData.height_km;
        var rawMag = tiltData.tilt_magnitude_km || [];
        var rawRmw = tiltData.rmw_km || [];
        var refH = tiltData.ref_height_km || 2.0;
        var offX = tiltData.ref_center_x_km || 0;
        var offY = tiltData.ref_center_y_km || 0;

        // Filter out levels with null coordinates
        var xAbs = [], yAbs = [], z = [], tiltMag = [], rmw = [];
        for (var k = 0; k < rawZ.length; k++) {
            if (rawX[k] == null || rawY[k] == null || rawZ[k] == null) continue;
            xAbs.push(rawX[k] + offX); yAbs.push(rawY[k] + offY); z.push(rawZ[k]);
            tiltMag.push(rawMag[k] != null ? rawMag[k] : null);
            rmw.push(rawRmw[k] != null ? rawRmw[k] : null);
        }
        if (z.length < 2) return;

        // Hover text
        var hoverText = [];
        for (var i = 0; i < z.length; i++) {
            var txt = '<b>' + z[i].toFixed(1) + ' km</b>' +
                '<br>\u0394X: ' + (xAbs[i] - offX).toFixed(1) + ' km' +
                '<br>\u0394Y: ' + (yAbs[i] - offY).toFixed(1) + ' km';
            if (tiltMag[i] !== null) txt += '<br>Tilt: ' + tiltMag[i].toFixed(1) + ' km';
            if (rmw[i] !== null) txt += '<br>RMW: ' + rmw[i].toFixed(1) + ' km';
            hoverText.push(txt);
        }

        var sizes = z.map(function (h) { return Math.abs(h - refH) < 0.3 ? 12 : 8; });

        var lineTrace = {
            x: xAbs, y: yAbs,
            mode: 'lines', type: 'scatter',
            line: { color: 'rgba(52,211,153,0.5)', width: 1.5, dash: 'dot' },
            hoverinfo: 'skip', showlegend: false
        };

        var markerTrace = {
            x: xAbs, y: yAbs,
            mode: 'markers', type: 'scatter',
            marker: {
                size: sizes, color: z,
                colorscale: 'Viridis', cmin: 0, cmax: 14,
                line: { color: 'rgba(255,255,255,0.5)', width: 0.5 },
                colorbar: {
                    title: { text: 'Tilt Height (km)', font: { color: '#ccc', size: 9 } },
                    tickfont: { color: '#ccc', size: 8 },
                    thickness: 10, len: 0.30,
                    x: 1.01, xpad: 2, y: 0.02,
                    yanchor: 'bottom', outlinewidth: 0
                }
            },
            text: hoverText, hoverinfo: 'text',
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } },
            showlegend: false
        };

        _rtTiltTraceStart = chartDiv.data.length;
        Plotly.addTraces(chartDiv, [lineTrace, markerTrace]);

        // Shrink main heatmap colorbar to make room for tilt colorbar
        if (chartDiv.data && chartDiv.data.length > 0) {
            Plotly.restyle(chartDiv, {
                'colorbar.len': [0.42],
                'colorbar.y': [0.98],
                'colorbar.yanchor': ['top'],
                'colorbar.x': [1.01],
                'colorbar.xpad': [2]
            }, [0]);
        }
    }

    function _rtRemoveTiltTraces() {
        var chartDiv = document.getElementById('rt-plotly-chart');
        if (!chartDiv || !chartDiv.data || _rtTiltTraceStart < 0) return;
        var indices = [];
        for (var i = _rtTiltTraceStart; i < chartDiv.data.length; i++) indices.push(i);
        if (indices.length) Plotly.deleteTraces(chartDiv, indices);
        _rtTiltTraceStart = -1;

        // Restore main heatmap colorbar to full length
        if (chartDiv.data && chartDiv.data.length > 0) {
            Plotly.restyle(chartDiv, {
                'colorbar.len': [0.85],
                'colorbar.y': [0.5],
                'colorbar.yanchor': ['middle'],
                'colorbar.x': [null],
                'colorbar.xpad': [null]
            }, [0]);
        }
    }

    // ── Real-Time 3D Tilt Hodograph ─────────────────────────────

    window.rtToggle3DTilt = function () {
        var chartDiv = document.getElementById('vol-3d-chart');
        var btn = document.getElementById('vol-tilt-toggle');
        if (!chartDiv || !chartDiv.data || _rtTilt3DTraceStart < 0) return;
        var isActive = btn.classList.contains('active');
        var vis = !isActive;
        var indices = [];
        for (var i = _rtTilt3DTraceStart; i < chartDiv.data.length; i++) indices.push(i);
        if (indices.length) Plotly.restyle(chartDiv, { visible: vis }, indices);
        btn.classList.toggle('active');
    };

    window._rtAddTiltTo3D = function (tiltData) {
        var chartDiv = document.getElementById('vol-3d-chart');
        var btn = document.getElementById('vol-tilt-toggle');
        if (!tiltData || !tiltData.x_km || !tiltData.x_km.length) {
            if (btn) { btn.disabled = true; btn.classList.remove('active'); }
            return;
        }
        if (btn) btn.disabled = false;

        var rawX = tiltData.x_km, rawY = tiltData.y_km, rawZ = tiltData.height_km;
        var rawMag = tiltData.tilt_magnitude_km || [];
        var rawRmw = tiltData.rmw_km || [];
        var refH = tiltData.ref_height_km || 2.0;
        var offX = tiltData.ref_center_x_km || 0;
        var offY = tiltData.ref_center_y_km || 0;

        // Filter out levels with null coordinates
        var xAbs = [], yAbs = [], z = [], tiltMag = [], rmw = [], dx = [], dy = [];
        for (var k = 0; k < rawZ.length; k++) {
            if (rawX[k] == null || rawY[k] == null || rawZ[k] == null) continue;
            xAbs.push(rawX[k] + offX); yAbs.push(rawY[k] + offY); z.push(rawZ[k]);
            dx.push(rawX[k]); dy.push(rawY[k]);
            tiltMag.push(rawMag[k] != null ? rawMag[k] : null);
            rmw.push(rawRmw[k] != null ? rawRmw[k] : null);
        }
        if (z.length < 2) {
            if (btn) { btn.disabled = true; btn.classList.remove('active'); }
            return;
        }

        var hoverText = [];
        for (var i = 0; i < z.length; i++) {
            var txt = '<b>' + z[i].toFixed(1) + ' km</b>' +
                '<br>\u0394X: ' + dx[i].toFixed(1) + ', \u0394Y: ' + dy[i].toFixed(1) + ' km';
            if (tiltMag[i] != null) txt += '<br>Tilt: ' + tiltMag[i].toFixed(1) + ' km';
            if (rmw[i] != null) txt += '<br>RMW: ' + rmw[i].toFixed(1) + ' km';
            hoverText.push(txt);
        }
        var sizes = z.map(function (h) { return Math.abs(h - refH) < 0.3 ? 7 : 4; });

        var lineTrace = {
            type: 'scatter3d', mode: 'lines',
            x: xAbs, y: yAbs, z: z,
            line: { color: 'rgba(52,211,153,0.6)', width: 3, dash: 'dot' },
            hoverinfo: 'skip', showlegend: false
        };
        var markerTrace = {
            type: 'scatter3d', mode: 'markers+text',
            x: xAbs, y: yAbs, z: z,
            marker: {
                size: sizes, color: z,
                colorscale: 'Viridis', cmin: 0, cmax: 14,
                line: { color: 'rgba(255,255,255,0.4)', width: 0.5 },
                colorbar: {
                    title: { text: 'Height (km)', font: { color: '#ccc', size: 10 } },
                    tickfont: { color: '#ccc', size: 9 },
                    thickness: 10, len: 0.35,
                    x: 1.08, y: 0.15, xanchor: 'left'
                }
            },
            text: z.map(function (h) { return h.toFixed(1); }),
            textposition: 'top right',
            textfont: { size: 8, color: 'rgba(110,231,183,0.7)' },
            hovertext: hoverText, hoverinfo: 'text',
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } },
            showlegend: false
        };

        _rtTilt3DTraceStart = chartDiv.data.length;
        Plotly.addTraces(chartDiv, [lineTrace, markerTrace]);
        if (btn) btn.classList.add('active');
    };


    // ── Single-Case CFAD for Real-Time TDR ──────────────────────────
    window.rtToggleCFADConfig = function () {
        var pop = document.getElementById('rt-cfad-config-popover');
        if (!pop) return;
        pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
    };

    window.rtFetchCFAD = function () {
        if (!_currentFileUrl) return;
        var btn = document.getElementById('rt-cfad-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

        // Hide config popover
        var pop = document.getElementById('rt-cfad-config-popover');
        if (pop) pop.style.display = 'none';

        var variable = (document.getElementById('rt-var') || {}).value || 'REFLECTIVITY';

        // Read config from popover inputs
        var binWidth = parseFloat((document.getElementById('rt-cfad-bin-width') || {}).value) || 0;
        var nBins = parseInt((document.getElementById('rt-cfad-n-bins') || {}).value, 10) || 40;
        var binMinVal = (document.getElementById('rt-cfad-bin-min') || {}).value;
        var binMaxVal = (document.getElementById('rt-cfad-bin-max') || {}).value;
        var normalise = (document.getElementById('rt-cfad-normalise') || {}).value || 'height';
        var minRadius = parseFloat((document.getElementById('rt-cfad-min-radius') || {}).value) || 0;
        var maxRadius = parseFloat((document.getElementById('rt-cfad-max-radius') || {}).value) || 200;
        var logScale = !!(document.getElementById('rt-cfad-log-scale') || {}).checked;

        var url = API_BASE + RT_PREFIX + '/cfad?file_url=' + encodeURIComponent(_currentFileUrl) +
            '&variable=' + variable +
            '&min_radius=' + minRadius + '&max_radius=' + maxRadius +
            '&normalise=' + encodeURIComponent(normalise) +
            '&n_bins=' + nBins;
        if (binWidth > 0) url += '&bin_width=' + binWidth;
        if (binMinVal !== '' && binMinVal !== undefined && !isNaN(parseFloat(binMinVal))) url += '&bin_min=' + parseFloat(binMinVal);
        if (binMaxVal !== '' && binMaxVal !== undefined && !isNaN(parseFloat(binMaxVal))) url += '&bin_max=' + parseFloat(binMaxVal);

        fetch(url)
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) { json._logScale = logScale; _rtRenderCFAD(json); })
            .catch(function (e) { alert('CFAD error: ' + e.message); })
            .finally(function () { if (btn) { btn.disabled = false; btn.textContent = '\u2593 CFAD'; } });
    };

    function _rtRenderCFAD(json) {
        var cfad = json.cfad;
        var binCenters = json.bin_centers;
        var heightKm = json.height_km;
        var varInfo = json.variable;
        var normLabel = json.norm_label;
        var meta = json.case_meta || {};
        var useLog = !!json._logScale;

        // Apply log transform if requested
        var plotData = cfad;
        if (useLog) {
            plotData = cfad.map(function(row) {
                return row.map(function(v) { return v > 0 ? Math.log10(v) : null; });
            });
        }

        var title = '';
        if (meta.storm_name) title += meta.storm_name;
        if (meta.datetime) title += ' | ' + meta.datetime;
        title += '<br>CFAD: ' + varInfo.display_name + ' (' + varInfo.units + ')';
        if (useLog) title += ' [log scale]';

        var trace = {
            z: plotData,
            x: binCenters,
            y: heightKm,
            type: 'heatmap',
            colorscale: [
                [0,    'rgba(10,10,30,0)'],
                [0.01, '#1a1a4e'],
                [0.05, '#2d1b69'],
                [0.10, '#4a0e7f'],
                [0.20, '#7b2a8e'],
                [0.35, '#b84e8e'],
                [0.50, '#e0735e'],
                [0.70, '#f5a623'],
                [0.85, '#f5d76e'],
                [1.0,  '#fafafa']
            ],
            colorbar: {
                title: { text: useLog ? 'log₁₀(' + normLabel + ')' : normLabel, font: { color: '#ccc', size: 11 } },
                tickfont: { color: '#aaa', size: 10 },
                thickness: 12,
                len: 0.7,
            },
            hoverongaps: false,
            hovertemplate: useLog
                ? '<b>' + varInfo.display_name + ':</b> %{x:.2f} ' + varInfo.units +
                  '<br><b>Height:</b> %{y:.1f} km<br><b>log₁₀(Freq):</b> %{z:.2f}<extra></extra>'
                : '<b>' + varInfo.display_name + ':</b> %{x:.2f} ' + varInfo.units +
                  '<br><b>Height:</b> %{y:.1f} km<br><b>Freq:</b> %{z:.2f}' +
                  (json.normalise === 'raw' ? '' : '%') + '<extra></extra>',
        };

        var layout = {
            title: { text: title, font: { color: '#e0e0e0', size: 13 }, x: 0.5 },
            xaxis: {
                title: { text: varInfo.display_name + ' (' + varInfo.units + ')', font: { color: '#aaa', size: 12 } },
                color: '#aaa', gridcolor: 'rgba(255,255,255,0.06)', zeroline: true, zerolinecolor: 'rgba(255,255,255,0.2)',
            },
            yaxis: {
                title: { text: 'Height (km)', font: { color: '#aaa', size: 12 } },
                color: '#aaa', gridcolor: 'rgba(255,255,255,0.06)',
            },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: '#0f172a',
            margin: { t: 50, b: 45, l: 50, r: 10 },
            font: { family: 'JetBrains Mono, monospace' },
        };

        var el = document.getElementById('rt-az-result');
        if (!el) el = document.getElementById('rt-cs-result');
        if (el) {
            el.innerHTML = '<div id="rt-cfad-chart" style="width:100%;height:400px;border-radius:6px;overflow:hidden;"></div>';
            Plotly.newPlot('rt-cfad-chart', [trace], layout, { responsive: true, displayModeBar: true, displaylogo: false });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ── NEXRAD WSR-88D GROUND RADAR — REALTIME MODE ──────────────
    // ═══════════════════════════════════════════════════════════════

    var _rtNexradVisible = false;
    var _rtNexradMapOverlay = null;
    var _rtNexradPlanViewVisible = false;
    var _rtNexradSrData = null;
    var _rtNexradSitesLoaded = false;

    function _rtBuildNexradRefTime() {
        if (!_rtCaseMeta || !_rtCaseMeta.datetime) return null;
        var dt = _rtCaseMeta.datetime.replace(' UTC', '').replace(' ', 'T');
        if (dt.length === 16) dt += ':00';
        return dt;
    }

    function _rtFetchNexradSites() {
        var siteSelect = document.getElementById('rt-nexrad-site-select');
        if (!siteSelect || !_rtCaseMeta) return;

        var lat = _rtCaseMeta.latitude;
        var lon = _rtCaseMeta.longitude;
        if (!lat || !lon) return;

        siteSelect.innerHTML = '<option value="">Searching\u2026</option>';

        fetch(API_BASE + '/nexrad/sites?lat=' + lat + '&lon=' + lon + '&max_range_km=460')
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                siteSelect.innerHTML = '';
                if (!json.sites || json.sites.length === 0) {
                    siteSelect.innerHTML = '<option value="">No nearby 88D</option>';
                    var btn = document.getElementById('rt-nexrad-btn');
                    if (btn) btn.disabled = true;
                    return;
                }
                _rtNexradSitesLoaded = true;
                for (var i = 0; i < json.sites.length; i++) {
                    var s = json.sites[i];
                    var opt = document.createElement('option');
                    opt.value = s.site;
                    opt.textContent = s.site + ' \u2014 ' + s.name + ' (' + s.distance_km + ' km)';
                    siteSelect.appendChild(opt);
                }
                // Auto-load scans for the first site
                if (_rtNexradVisible) rtLoadNexradScans();
            })
            .catch(function () {
                siteSelect.innerHTML = '<option value="">Error</option>';
            });
    }

    window.rtLoadNexradScans = function () {
        var siteSelect = document.getElementById('rt-nexrad-site-select');
        var scanSelect = document.getElementById('rt-nexrad-scan-select');
        var status = document.getElementById('rt-nexrad-status');
        if (!siteSelect || !scanSelect || !siteSelect.value) return;

        var site = siteSelect.value;
        var refTime = _rtBuildNexradRefTime();
        if (!refTime) return;

        scanSelect.innerHTML = '<option value="">Loading\u2026</option>';
        if (status) status.textContent = 'Searching\u2026';

        fetch(API_BASE + '/nexrad/scans?site=' + site + '&datetime=' + encodeURIComponent(refTime) + '&window_min=60')
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
                var ci = json.closest_index || 0;
                if (ci < scanSelect.options.length) scanSelect.selectedIndex = ci;
                if (_rtNexradVisible) rtLoadNexradFrame();
            })
            .catch(function () {
                scanSelect.innerHTML = '<option value="">Error</option>';
                if (status) status.textContent = 'Error';
            });
    };

    window.rtLoadNexradFrame = function () {
        var scanSelect = document.getElementById('rt-nexrad-scan-select');
        var siteSelect = document.getElementById('rt-nexrad-site-select');
        var prodSelect = document.getElementById('rt-nexrad-product-select');
        var status = document.getElementById('rt-nexrad-status');
        if (!scanSelect || !scanSelect.value || !siteSelect || !siteSelect.value) return;

        var s3Key = scanSelect.value;
        var site = siteSelect.value;
        var product = (prodSelect && prodSelect.value) || 'reflectivity';

        if (status) status.textContent = 'Loading\u2026';

        var url = API_BASE + '/nexrad/frame?site=' + encodeURIComponent(site) +
            '&s3_key=' + encodeURIComponent(s3Key) +
            '&product=' + product;

        fetch(url)
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                if (!json.image || !json.bounds) {
                    if (status) status.textContent = 'No data';
                    return;
                }

                var bounds = L.latLngBounds(
                    L.latLng(json.bounds[0][0], json.bounds[0][1]),
                    L.latLng(json.bounds[1][0], json.bounds[1][1])
                );

                if (_rtNexradMapOverlay && _rtMap) {
                    _rtMap.removeLayer(_rtNexradMapOverlay);
                }
                _rtNexradMapOverlay = L.imageOverlay(json.image, bounds, {
                    opacity: 0.75, interactive: false, zIndex: 250
                });
                if (_rtNexradVisible && _rtMap) _rtNexradMapOverlay.addTo(_rtMap);

                if (status) status.textContent = json.site + ' ' + json.scan_time + ' \u2014 ' + json.label;
                _rtUpdateNexradColorbar(product);
                _rtLoadNexradStormRelative(site, s3Key, product);
            })
            .catch(function (e) {
                if (status) status.textContent = 'Error: ' + e.message;
            });
    };

    function _rtLoadNexradStormRelative(site, s3Key, product) {
        if (!_rtCaseMeta) return;

        var url = API_BASE + '/nexrad/storm_relative?site=' + encodeURIComponent(site) +
            '&s3_key=' + encodeURIComponent(s3Key) +
            '&center_lat=' + _rtCaseMeta.latitude + '&center_lon=' + _rtCaseMeta.longitude +
            '&product=' + product +
            '&grid_spacing_km=2&domain_km=200';

        fetch(url)
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                _rtNexradSrData = json;
                _rtApplyNexradPlanView();
            })
            .catch(function () { _rtNexradSrData = null; });
    }

    function _rtApplyNexradPlanView() {
        var plotDiv = document.getElementById('rt-plotly-chart');
        if (!plotDiv || !plotDiv.data || !_rtNexradSrData || !_rtNexradPlanViewVisible) return;

        var sr = _rtNexradSrData;
        ['rt-plotly-chart', 'rt-fullscreen-chart'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || !el.layout) return;
            var existing = (el.layout.images || []).filter(function (img) { return !img._rtNexradUnderlay; });
            existing.push({
                source: sr.image,
                xref: 'x', yref: 'y',
                x: sr.x_km[0],
                y: sr.y_km[sr.y_km.length - 1],
                sizex: sr.x_km[sr.x_km.length - 1] - sr.x_km[0],
                sizey: sr.y_km[sr.y_km.length - 1] - sr.y_km[0],
                xanchor: 'left', yanchor: 'top',
                layer: 'below',
                opacity: 0.8,
                _rtNexradUnderlay: true,
            });
            Plotly.relayout(id, { images: existing });
        });
    }

    function _rtRemoveNexradPlanView() {
        ['rt-plotly-chart', 'rt-fullscreen-chart'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || !el.layout) return;
            var clean = (el.layout.images || []).filter(function (img) { return !img._rtNexradUnderlay; });
            Plotly.relayout(id, { images: clean });
        });
    }

    window.rtToggleNexradOverlay = function () {
        _rtNexradVisible = !_rtNexradVisible;
        var btn = document.getElementById('rt-nexrad-btn');
        var panel = document.getElementById('rt-nexrad-panel');

        if (_rtNexradVisible) {
            if (btn) btn.classList.add('active');
            if (panel) panel.style.display = '';
            if (_rtNexradMapOverlay && _rtMap) _rtNexradMapOverlay.addTo(_rtMap);

            _rtNexradPlanViewVisible = true;
            var pvBtn = document.getElementById('rt-nexrad-planview-btn');
            if (pvBtn) pvBtn.classList.add('active');

            // Wait for metadata if not yet available
            if (!_rtCaseMeta) {
                var _waitMeta = setInterval(function () {
                    if (_rtCaseMeta) {
                        clearInterval(_waitMeta);
                        if (!_rtNexradSitesLoaded) _rtFetchNexradSites();
                    }
                }, 500);
                setTimeout(function () { clearInterval(_waitMeta); }, 15000);
            } else if (!_rtNexradSitesLoaded) {
                _rtFetchNexradSites();
            } else {
                rtLoadNexradScans();
            }
        } else {
            if (btn) btn.classList.remove('active');
            if (panel) panel.style.display = 'none';
            if (_rtNexradMapOverlay && _rtMap) _rtMap.removeLayer(_rtNexradMapOverlay);
            if (_rtNexradPlanViewVisible) {
                _rtNexradPlanViewVisible = false;
                _rtRemoveNexradPlanView();
                var pvBtn = document.getElementById('rt-nexrad-planview-btn');
                if (pvBtn) pvBtn.classList.remove('active');
            }
        }
    };

    window.rtToggleNexradPlanView = function () {
        _rtNexradPlanViewVisible = !_rtNexradPlanViewVisible;
        var btn = document.getElementById('rt-nexrad-planview-btn');

        if (_rtNexradPlanViewVisible) {
            if (btn) btn.classList.add('active');
            var scanSelect = document.getElementById('rt-nexrad-scan-select');
            var siteSelect = document.getElementById('rt-nexrad-site-select');
            var prodSelect = document.getElementById('rt-nexrad-product-select');
            if (scanSelect && scanSelect.value && siteSelect && siteSelect.value) {
                var product = (prodSelect && prodSelect.value) || 'reflectivity';
                _rtLoadNexradStormRelative(siteSelect.value, scanSelect.value, product);
            }
        } else {
            if (btn) btn.classList.remove('active');
            _rtRemoveNexradPlanView();
        }
    };

    function _rtUpdateNexradColorbar(product) {
        var el = document.getElementById('rt-nexrad-colorbar');
        if (!el) return;
        if (product === 'velocity') {
            el.innerHTML =
                '<div style="display:flex;height:10px;border-radius:3px;border:1px solid rgba(255,255,255,0.15);overflow:hidden;">' +
                    '<div style="flex:1;background:#0000D0;"></div><div style="flex:1;background:#0050FF;"></div>' +
                    '<div style="flex:1;background:#00C8FF;"></div><div style="flex:1;background:#00FF80;"></div>' +
                    '<div style="flex:1;background:#80FF00;"></div><div style="flex:1;background:#FFFF00;"></div>' +
                    '<div style="flex:1;background:#FF8000;"></div><div style="flex:1;background:#FF0000;"></div>' +
                    '<div style="flex:1;background:#C80000;"></div></div>' +
                '<div style="display:flex;justify-content:space-between;font-size:8px;color:#94a3b8;margin-top:1px;">' +
                    '<span>-50 m/s</span><span>0</span><span>+50 m/s</span></div>';
        } else {
            el.innerHTML =
                '<div style="display:flex;height:10px;border-radius:3px;border:1px solid rgba(255,255,255,0.15);overflow:hidden;">' +
                    '<div style="flex:1;background:#04E9E7;"></div><div style="flex:1;background:#019FF4;"></div>' +
                    '<div style="flex:1;background:#0300F4;"></div><div style="flex:1;background:#02FD02;"></div>' +
                    '<div style="flex:1;background:#01C501;"></div><div style="flex:1;background:#008E00;"></div>' +
                    '<div style="flex:1;background:#FDF802;"></div><div style="flex:1;background:#E5BC00;"></div>' +
                    '<div style="flex:1;background:#FD9500;"></div><div style="flex:1;background:#FD0000;"></div>' +
                    '<div style="flex:1;background:#D40000;"></div><div style="flex:1;background:#BC0000;"></div>' +
                    '<div style="flex:1;background:#F800FD;"></div><div style="flex:1;background:#9854C6;"></div></div>' +
                '<div style="display:flex;justify-content:space-between;font-size:8px;color:#94a3b8;margin-top:1px;">' +
                    '<span>5 dBZ</span><span>20</span><span>35</span><span>50</span><span>65</span></div>';
        }
    }

    function _rtRemoveNexradOverlay() {
        if (_rtNexradMapOverlay && _rtMap) { _rtMap.removeLayer(_rtNexradMapOverlay); _rtNexradMapOverlay = null; }
        _rtNexradVisible = false;
        _rtNexradPlanViewVisible = false;
        _rtNexradSrData = null;
        _rtNexradSitesLoaded = false;
        _rtRemoveNexradPlanView();
        var btn = document.getElementById('rt-nexrad-btn');
        if (btn) btn.classList.remove('active');
        var panel = document.getElementById('rt-nexrad-panel');
        if (panel) panel.style.display = 'none';
        var pvBtn = document.getElementById('rt-nexrad-planview-btn');
        if (pvBtn) pvBtn.classList.remove('active');
        var cb = document.getElementById('rt-nexrad-colorbar');
        if (cb) cb.innerHTML = '';
    }

    // ── Patch rtExploreFile to reset NEXRAD state ──────────────
    var _origRtExploreFileNx = window.rtExploreFile;
    window.rtExploreFile = function () {
        _rtRemoveNexradOverlay();
        _origRtExploreFileNx();
    };

    // ── Patch _rtCleanupMap to also remove NEXRAD layers ──────
    var _origCleanupMapNx = _rtCleanupMap;
    _rtCleanupMap = function () {
        if (_rtNexradMapOverlay && _rtMap) { _rtMap.removeLayer(_rtNexradMapOverlay); _rtNexradMapOverlay = null; }
        _origCleanupMapNx();
    };

    // ═══════════════════════════════════════════════════════════════
    // ── MICROWAVE SATELLITE OVERLAY (TC-PRIMED) — REALTIME MODE ──
    // ═══════════════════════════════════════════════════════════════

    var _rtMwMapOverlay = null;
    var _rtMwOverpassData = [];
    var _rtMwVisible = false;
    var _rtMwLastFileUrl = null;
    var _rtMwCurrentJson = null;

    window.rtToggleMicrowaveOverlay = function () {
        var btn = document.getElementById('rt-mw-overlay-btn');
        var panel = document.getElementById('rt-mw-overpass-panel');
        if (!btn || !panel) return;

        if (_rtMwVisible) {
            _rtMwVisible = false;
            btn.classList.remove('active');
            panel.style.display = 'none';
            if (_rtMwMapOverlay) _rtMwMapOverlay.setOpacity(0);
            return;
        }

        _rtMwVisible = true;
        btn.classList.add('active');
        panel.style.display = 'block';

        // If metadata not yet loaded, show status and retry until it arrives
        if (!_rtCaseMeta) {
            var status = document.getElementById('rt-mw-status');
            var sel = document.getElementById('rt-mw-overpass-select');
            if (status) status.textContent = 'Loading metadata...';
            if (sel) sel.innerHTML = '<option value="">Waiting for metadata\u2026</option>';
            var _retryMwFetch = function () {
                if (!_rtMwVisible) return; // user toggled off while waiting
                if (_rtCaseMeta) {
                    _rtMwLastFileUrl = null; // force fresh fetch
                    _rtFetchMicrowaveOverpasses();
                } else {
                    setTimeout(_retryMwFetch, 500);
                }
            };
            setTimeout(_retryMwFetch, 500);
            return;
        }

        if (_currentFileUrl !== _rtMwLastFileUrl) {
            _rtMwLastFileUrl = _currentFileUrl;
            _rtFetchMicrowaveOverpasses();
        } else if (_rtMwMapOverlay) {
            _rtMwMapOverlay.setOpacity(0.8);
        }
    };

    function _rtFetchMicrowaveOverpasses(retryCount) {
        retryCount = retryCount || 0;
        var sel = document.getElementById('rt-mw-overpass-select');
        var status = document.getElementById('rt-mw-status');
        if (!sel) return;
        sel.innerHTML = '<option value="">Loading...</option>';
        if (status) status.textContent = '';

        // Extract storm info from the loaded case meta
        var stormName = '', year = '', analysisDt = '';
        if (_rtCaseMeta) {
            stormName = (_rtCaseMeta.storm_name || '').toUpperCase();
            var dtStr = _rtCaseMeta.datetime || '';
            year = dtStr ? dtStr.substring(0, 4) : '';
            analysisDt = dtStr ? dtStr.replace(' UTC', '').replace(' ', 'T') + ':00+00:00' : '';
        }

        if (!stormName || !year) {
            sel.innerHTML = '<option value="">No storm metadata</option>';
            return;
        }

        var url = API_BASE + '/microwave/realtime_overpasses?storm_name=' +
            encodeURIComponent(stormName) + '&year=' + year +
            '&analysis_time=' + encodeURIComponent(analysisDt);

        fetch(url)
            .then(function (r) {
                if (r.status === 503 && retryCount < 3) {
                    if (status) status.textContent = 'Building index, retrying...';
                    sel.innerHTML = '<option value="">Building index...</option>';
                    setTimeout(function () { _rtFetchMicrowaveOverpasses(retryCount + 1); }, 3000);
                    return null;
                }
                if (!r.ok) throw new Error(r.status);
                return r.json();
            })
            .then(function (json) {
                if (!json) return;
                _rtMwOverpassData = json.overpasses || [];
                sel.innerHTML = '';

                if (_rtMwOverpassData.length === 0) {
                    sel.innerHTML = '<option value="">No overpasses found</option>';
                    if (status) status.textContent = 'No MW data within \u00b1' + (json.window_hours || 6) + 'h';
                    return;
                }

                for (var i = 0; i < _rtMwOverpassData.length; i++) {
                    var op = _rtMwOverpassData[i];
                    var sign = op.offset_minutes >= 0 ? '+' : '';
                    var label = op.sensor + ' / ' + op.platform +
                        ' (' + sign + Math.round(op.offset_minutes) + ' min)';
                    var opt = document.createElement('option');
                    opt.value = i;
                    opt.textContent = label;
                    sel.appendChild(opt);
                }

                if (status) status.textContent = _rtMwOverpassData.length + ' overpass(es)';
                window.rtLoadMicrowaveOverpass();
            })
            .catch(function (e) {
                sel.innerHTML = '<option value="">Error</option>';
                if (status) status.textContent = 'Error: ' + e.message;
            });
    }

    window.rtLoadMicrowaveOverpass = function () {
        var sel = document.getElementById('rt-mw-overpass-select');
        var prodSel = document.getElementById('rt-mw-product-select');
        var status = document.getElementById('rt-mw-status');
        if (!sel || sel.value === '') return;

        var idx = parseInt(sel.value, 10);
        var op = _rtMwOverpassData[idx];
        if (!op) return;

        var product = (prodSel && prodSel.value) || '89pct';

        if (product === '37h' && !op.has_37) {
            if (status) status.textContent = op.sensor + ' does not have 37 GHz';
            return;
        }

        if (status) status.textContent = 'Loading ' + product + '...';

        var dataUrl = API_BASE + '/microwave/data?s3_key=' + encodeURIComponent(op.s3_key) +
            '&product=' + product;
        if (_rtCaseMeta) {
            dataUrl += '&center_lat=' + (_rtCaseMeta.latitude || 0) +
                       '&center_lon=' + (_rtCaseMeta.longitude || 0);
        }

        fetch(dataUrl)
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

                if (_rtMwMapOverlay && _rtMap) {
                    _rtMap.removeLayer(_rtMwMapOverlay);
                }
                _rtMwMapOverlay = L.imageOverlay(imgUrl, bounds, {
                    opacity: 0.8, interactive: false, zIndex: 190
                });
                if (_rtMwVisible && _rtMap) _rtMwMapOverlay.addTo(_rtMap);

                _rtMwCurrentJson = json;
                _rtCreateStandaloneMWPlanView(json);

                if (status) status.textContent = json.sensor + ' ' + json.datetime;

                // Add/update download button next to status text
                var dlBtn = document.getElementById('rt-mw-download-btn');
                if (!dlBtn) {
                    dlBtn = document.createElement('a');
                    dlBtn.id = 'rt-mw-download-btn';
                    dlBtn.style.cssText = 'font-size:9px;padding:2px 6px;border:1px solid rgba(251,146,60,0.5);border-radius:3px;color:#fdba74;text-decoration:none;white-space:nowrap;cursor:pointer;';
                    dlBtn.textContent = '\u2193 Save';
                    if (status && status.parentNode) status.parentNode.insertBefore(dlBtn, status.nextSibling);
                }
                var dtSafe = (json.datetime || '').replace(/[^0-9A-Za-z]/g, '_').replace(/_+/g, '_').replace(/_$/, '');
                dlBtn.href = imgUrl;
                dlBtn.download = 'MW_' + (json.sensor || 'sensor') + '_' + product + '_' + dtSafe + '.png';
            })
            .catch(function (e) {
                if (status) status.textContent = 'Error: ' + e.message;
                var dlBtn = document.getElementById('rt-mw-download-btn');
                if (dlBtn) dlBtn.remove();
            });
    };

    function _rtCreateStandaloneMWPlanView(json) {
        // Only show standalone if no TDR plan view is currently displayed
        if (document.getElementById('rt-dual-panel-wrap')) return;

        var displayArea = document.getElementById('rt-display-area');
        if (!displayArea) return;

        var existing = document.getElementById('rt-mw-standalone-wrap');
        if (existing) existing.remove();

        var hasRGB = json.is_rgb && json.storm_grid_rgb_b64;
        var hasGrid = json.storm_grid && json.storm_grid.z;
        if (!hasRGB && !hasGrid) return;

        var wrap = document.createElement('div');
        wrap.id = 'rt-mw-standalone-wrap';
        wrap.innerHTML =
            '<div class="dual-panel-wrap" style="height:100%;">' +
                '<div class="dual-pane" id="rt-mw-standalone-pane" style="width:100%;flex:1;">' +
                    '<div class="dual-pane-label">Plan View (Microwave)</div>' +
                    '<div class="dual-pane-inner" style="position:relative;">' +
                        '<div id="rt-mw-plotly-chart" style="width:100%;height:100%;min-height:360px;"></div>' +
                    '</div>' +
                '</div>' +
            '</div>';
        displayArea.appendChild(wrap);

        var product = json.product || '89pct';
        var titleText = (json.sensor || 'MW') + ' ' + (json.platform || '') +
            ' | ' + product.toUpperCase() + '<br>' + (json.datetime || '');
        var plotBg = '#0a1628';
        var config = { responsive: true, displayModeBar: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'], displaylogo: false };
        var centerTrace = { x: [0], y: [0], type: 'scatter', mode: 'markers',
            marker: { symbol: 'cross', size: 10, color: 'white', line: { color: 'white', width: 2 } },
            showlegend: false, hoverinfo: 'skip' };

        if (hasRGB) {
            var ext = (json.storm_grid && json.storm_grid.extent_km) || 250;
            var layout = {
                title: { text: titleText, font: { color: '#e5e7eb', size: 11 }, y: 0.96, x: 0.5, xanchor: 'center', yanchor: 'top' },
                paper_bgcolor: plotBg, plot_bgcolor: plotBg,
                xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 10 } },
                         tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)',
                         zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)',
                         scaleanchor: 'y', range: [-ext, ext] },
                yaxis: { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 10 } },
                         tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)',
                         zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)',
                         scaleanchor: 'x', scaleratio: 1, range: [-ext, ext] },
                margin: { l: 52, r: 16, t: 46, b: 44 },
                images: [{ source: 'data:image/png;base64,' + json.storm_grid_rgb_b64,
                    xref: 'x', yref: 'y', x: -ext, y: ext,
                    sizex: 2 * ext, sizey: 2 * ext,
                    xanchor: 'left', yanchor: 'top',
                    sizing: 'stretch', opacity: 0.95, layer: 'below' }],
                hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } },
                showlegend: false
            };
            Plotly.newPlot('rt-mw-plotly-chart', [centerTrace], layout, config);
        } else {
            var sg = json.storm_grid;
            var ext2 = sg.extent_km || 250;
            var cs = json.colorscale || [
                [0.000, '#303030'], [0.100, '#606060'], [0.225, '#800000'],
                [0.375, '#FF0000'], [0.500, '#FF8C00'], [0.535, '#FFD700'],
                [0.615, '#ADFF2F'], [0.700, '#00CC44'], [0.745, '#00DDCC'],
                [0.825, '#0066FF'], [0.875, '#0000CC'], [1.000, '#8888FF']
            ];
            var cbarTitle = product === '37h' ? '37H (K)' : 'PCT (K)';
            var mwTrace = {
                z: sg.z, x: sg.x_axis, y: sg.y_axis,
                type: 'heatmap', colorscale: cs, zmin: json.vmin, zmax: json.vmax,
                colorbar: { title: { text: cbarTitle, font: { color: '#ccc', size: 10 } },
                            tickfont: { color: '#ccc', size: 9 }, thickness: 12, len: 0.85 },
                hovertemplate: '<b>MW %{z:.0f} K</b><br>X: %{x:.0f} km  Y: %{y:.0f} km<extra>MW</extra>',
                hoverongaps: false, name: 'MW ' + cbarTitle.replace(' (K)', '')
            };
            var layout2 = {
                title: { text: titleText, font: { color: '#e5e7eb', size: 11 }, y: 0.96, x: 0.5, xanchor: 'center', yanchor: 'top' },
                paper_bgcolor: plotBg, plot_bgcolor: plotBg,
                xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 10 } },
                         tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)',
                         zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)',
                         scaleanchor: 'y', range: [-ext2, ext2] },
                yaxis: { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 10 } },
                         tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)',
                         zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)',
                         scaleanchor: 'x', scaleratio: 1, range: [-ext2, ext2] },
                margin: { l: 52, r: 60, t: 46, b: 44 },
                hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } },
                showlegend: false
            };
            Plotly.newPlot('rt-mw-plotly-chart', [mwTrace, centerTrace], layout2, config);
        }
    }

    // Cleanup when switching files
    function _rtRemoveMicrowaveOverlay() {
        if (_rtMwMapOverlay && _rtMap) { _rtMap.removeLayer(_rtMwMapOverlay); _rtMwMapOverlay = null; }
        _rtMwOverpassData = [];
        _rtMwVisible = false;
        _rtMwLastFileUrl = null;
        _rtMwCurrentJson = null;
        var standaloneWrap = document.getElementById('rt-mw-standalone-wrap');
        if (standaloneWrap) standaloneWrap.remove();
        var btn = document.getElementById('rt-mw-overlay-btn');
        if (btn) btn.classList.remove('active');
        var panel = document.getElementById('rt-mw-overpass-panel');
        if (panel) panel.style.display = 'none';
        var dlBtn = document.getElementById('rt-mw-download-btn');
        if (dlBtn) dlBtn.remove();
    }

})();
