const API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';

// ── GA4 analytics helper ─────────────────────────────────────
function _ga(action, params) {
    if (typeof gtag === 'function') {
        try { gtag('event', action, params || {}); } catch (e) { /* silent */ }
    }
}

// ── Deep linking: ?tab=realtime / ?tab=composites / #case=N&var=X&level=Y&dtype=Z ──
function _updatePermalink() {
    if (currentCaseIndex === null) return;
    var parts = ['case=' + currentCaseIndex];
    var varSel = document.getElementById('ep-var');
    var lvlSel = document.getElementById('ep-level');
    if (varSel && varSel.value) parts.push('var=' + encodeURIComponent(varSel.value));
    if (lvlSel && lvlSel.value) parts.push('level=' + lvlSel.value);
    if (_activeDataType && _activeDataType !== 'swath') parts.push('dtype=' + _activeDataType);
    history.replaceState(null, '', '#' + parts.join('&'));
}

function _getPermalink() {
    var base = window.location.origin + window.location.pathname;
    return base + window.location.hash;
}

function copyPermalink() {
    var url = _getPermalink();
    if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function() { showToast('Link copied to clipboard', 'info', 2500); });
    } else {
        // Fallback
        var ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast('Link copied to clipboard', 'info', 2500);
    }
}

function _handleDeepLink() {
    var params = new URLSearchParams(window.location.search);
    var tab = params.get('tab');
    if (tab === 'realtime' && typeof toggleRealtimeTab === 'function') {
        toggleRealtimeTab();
        return;
    }
    if (tab === 'composites' && typeof toggleCompositePanel === 'function') {
        toggleCompositePanel();
        return;
    }
    var hash = window.location.hash;
    var caseMatch = hash.match(/case=(\d+)/);
    if (caseMatch) {
        var targetIdx = parseInt(caseMatch[1]);
        // Parse additional deep-link params
        var dlVar = (hash.match(/var=([^&]+)/) || [])[1];
        var dlLevel = (hash.match(/level=([^&]+)/) || [])[1];
        var dlDtype = (hash.match(/dtype=([^&]+)/) || [])[1];
        if (dlVar) dlVar = decodeURIComponent(dlVar);

        // Switch data type if specified
        if (dlDtype && dlDtype !== _activeDataType && typeof switchDataType === 'function') {
            switchDataType(dlDtype);
        }

        // Wait for data to load, then open the case
        var _checkInterval = setInterval(function() {
            var d = _getActiveData();
            if (!d) return;
            clearInterval(_checkInterval);
            var caseData = d.cases.find(function(c) { return c.case_index === targetIdx; });
            if (caseData) {
                // Set dropdowns to match
                var yearSel = document.getElementById('year-select');
                if (yearSel) { yearSel.value = String(caseData.year); yearSel.dispatchEvent(new Event('change')); }
                setTimeout(function() {
                    var stormSel = document.getElementById('storm-select');
                    if (stormSel) { stormSel.value = caseData.storm_name; stormSel.dispatchEvent(new Event('change')); }
                    setTimeout(function() {
                        var caseSel = document.getElementById('case-select');
                        if (caseSel) { caseSel.value = String(targetIdx); }
                        exploreCaseGo();
                        // After case loads, set variable and level from deep link
                        if (dlVar || dlLevel) {
                            setTimeout(function() {
                                var varSel = document.getElementById('ep-var');
                                var lvlSel = document.getElementById('ep-level');
                                if (dlVar && varSel) varSel.value = dlVar;
                                if (dlLevel && lvlSel) lvlSel.value = dlLevel;
                                if (dlVar || dlLevel) generateCustomPlot();
                            }, 500);
                        }
                    }, 200);
                }, 200);
            }
        }, 300);
        // Safety: clear after 15s
        setTimeout(function() { clearInterval(_checkInterval); }, 15000);
    }
}

// ── Prevent browser from restoring previous scroll position on reload ──
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}
window.addEventListener('DOMContentLoaded', function() {
    window.scrollTo(0, 0);
});

// ── Toast notification system ────────────────────────────────
function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 5000;
    var container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;top:60px;right:16px;z-index:100000;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        document.body.appendChild(container);
    }
    var toast = document.createElement('div');
    var bgColor = type === 'error' ? 'rgba(239,68,68,0.95)' : type === 'warn' ? 'rgba(245,158,11,0.95)' : 'rgba(14,45,90,0.95)';
    var borderColor = type === 'error' ? '#f87171' : type === 'warn' ? '#fbbf24' : '#60a5fa';
    toast.style.cssText = 'background:' + bgColor + ';color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;font-family:DM Sans,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.4);border:1px solid ' + borderColor + ';backdrop-filter:blur(8px);pointer-events:auto;max-width:380px;opacity:0;transform:translateX(30px);transition:all 0.3s ease;';
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(function() { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
    setTimeout(function() {
        toast.style.opacity = '0'; toast.style.transform = 'translateX(30px)';
        setTimeout(function() { toast.remove(); }, 300);
    }, duration);
}

// ── Save plot as PNG ─────────────────────────────────────────
function archiveSavePlotPNG(chartDivId, defaultName) {
    var gd = document.getElementById(chartDivId);
    if (!gd || !gd.data) { showToast('No plot to save', 'warn'); return; }
    _ga('export_png', { chart: defaultName || chartDivId, module: 'archive' });
    var fname = defaultName || chartDivId;
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
}

// Save sonde plot with descriptive filename: StormName_MissionID_SondeID_PlotType
function archiveSaveSondePNG(chartDivId, plotType) {
    var gd = document.getElementById(chartDivId);
    if (!gd || !gd.data) { showToast('No plot to save', 'warn'); return; }
    var parts = [plotType || chartDivId];
    if (currentCaseData) {
        if (currentCaseData.storm_name) parts.unshift(currentCaseData.storm_name.replace(/\s+/g, '_'));
        if (currentCaseData.mission_id) parts.push(currentCaseData.mission_id);
    }
    // Try to get sonde ID from the title element
    var titleEl = document.getElementById(chartDivId === 'archive-skewt-chart' ? 'archive-skewt-title' : 'archive-wind-title');
    if (titleEl && titleEl.textContent) {
        var m = titleEl.textContent.match(/\b(\d{9})\b/);
        if (m) parts.push(m[1]);
    }
    Plotly.downloadImage(gd, {
        format: 'png',
        width: gd.offsetWidth * 2,
        height: gd.offsetHeight * 2,
        scale: 2,
        filename: parts.join('_'),
    });
}

function _archSaveBtnHTML(chartDivId, defaultName) {
    return '<button onclick="archiveSavePlotPNG(\'' + chartDivId + '\',\'' + (defaultName || chartDivId) + '\')" ' +
        'title="Save as PNG" class="rt-save-png-btn" style="position:absolute;top:6px;right:40px;z-index:10;">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>' +
        '<circle cx="12" cy="13" r="4"/></svg></button>';
}

// Returns a small export-data dropdown button (CSV + JSON) positioned absolutely
// within the chart wrapper. rightPx controls distance from right edge (default 74,
// use 40 when no PNG save button is present).
function _archExportBtnHTML(csvFn, jsonFn, dropId, rightPx) {
    if (rightPx === undefined) rightPx = 74;
    var itemStyle = 'padding:5px 12px;font-size:11px;color:#e2e8f0;cursor:pointer;white-space:nowrap;font-family:monospace;';
    var toggleJs = 'var d=document.getElementById(\'' + dropId + '\');d.style.display=d.style.display===\'none\'?\'block\':\'none\'';
    return '<div style="position:absolute;top:6px;right:' + rightPx + 'px;z-index:20;">' +
        '<button onclick="' + toggleJs + '" title="Export data (CSV / JSON)" class="rt-save-png-btn" style="position:static;">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>' +
        '<polyline points="7 10 12 15 17 10"/>' +
        '<line x1="12" y1="15" x2="12" y2="3"/></svg></button>' +
        '<div id="' + dropId + '" style="display:none;position:absolute;right:0;top:33px;background:#1e293b;border:1px solid #334155;border-radius:5px;overflow:hidden;z-index:200;min-width:80px;">' +
        '<div onclick="' + csvFn + '();document.getElementById(\'' + dropId + '\').style.display=\'none\'" ' +
        'style="' + itemStyle + '" onmouseover="this.style.background=\'#334155\'" onmouseout="this.style.background=\'\'">\u2193\u00a0CSV</div>' +
        '<div onclick="' + jsonFn + '();document.getElementById(\'' + dropId + '\').style.display=\'none\'" ' +
        'style="' + itemStyle + 'border-top:1px solid #334155;" onmouseover="this.style.background=\'#334155\'" onmouseout="this.style.background=\'\'">\u2193\u00a0JSON</div>' +
        '</div></div>';
}

// ── API cold-start pre-warming ───────────────────────────────
var _apiReady = false;
(function warmAPI() {
    var start = Date.now();
    fetch(API_BASE + '/health', { method: 'GET' })
        .then(function(r) {
            _apiReady = true;
            var elapsed = Date.now() - start;
            if (elapsed > 3000) {
                showToast('API server is ready (' + (elapsed / 1000).toFixed(1) + 's warm-up)', 'info', 3000);
            }
        })
        .catch(function() {
            // API might be cold-starting — retry once after 5s
            setTimeout(function() {
                fetch(API_BASE + '/health', { method: 'GET' })
                    .then(function() { _apiReady = true; })
                    .catch(function() {
                        showToast('API server may be waking up — first requests could take 30–60s', 'warn', 8000);
                    });
            }, 5000);
        });
})();

let allData = null;
var _activeDataType = 'swath';  // 'swath' or 'merge'
function _getActiveData() { return _activeDataType === 'merge' ? mergeData : allData; }
let markers = null;
let allMarkers = [];
let currentCaseIndex = null;
var currentCaseData = null;

const filters = {
    minIntensity:0, maxIntensity:200,
    minVmaxChange:-100, maxVmaxChange:85,
    minTilt:0, maxTilt:200,
    minWspd05:0, maxWspd05:100,
    minWspd20:0, maxWspd20:100,
    minYear:1997, maxYear:2024,
    stormName:'all'
};

// ── Dark-themed map ──────────────────────────────────────────
const map = L.map('map', { center:[20,-60], zoom:4, zoomControl:true, tap:true, tapTolerance:15 });

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom:19, subdomains:'abcd'
}).addTo(map);

// Coastline outlines rendered above overlays (NEXRAD, IR) but below markers
map.createPane('coastlines');
map.getPane('coastlines').style.zIndex = 450;
map.getPane('coastlines').style.pointerEvents = 'none';

(function() {
    fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_coastline.geojson')
        .then(function(r) { return r.json(); })
        .then(function(geojson) {
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
            }).addTo(map);
        })
        .catch(function() {});
})();

// ── Filter drawer toggle ─────────────────────────────────────
function toggleFilterDrawer() {
    const drawer = document.getElementById('filter-drawer');
    const btn = document.getElementById('filter-toggle');
    drawer.classList.toggle('open');
    var isOpen = drawer.classList.contains('open');
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    btn.classList.toggle('active');
    _ga('toggle_filter_drawer', { is_open: isOpen });
}

// ── Two-step Storm → Case selection ──────────────────────────
var _focusMode = false;
var _focusMarker = null;

function enterFocusMode(caseData) {
    _focusMode = true;
    if (markers) map.removeLayer(markers);
    if (_trackViewLayer) map.removeLayer(_trackViewLayer);
    if (_focusMarker) { map.removeLayer(_focusMarker); _focusMarker = null; }
    var color = getIntensityColor(caseData.vmax_kt);
    var icon = L.divIcon({
        className: 'custom-div-icon',
        html: '<div class="custom-marker" style="background-color:' + color + ';width:16px;height:16px;box-shadow:0 0 0 4px rgba(37,99,235,0.35);"></div>',
        iconSize: [16, 16], iconAnchor: [8, 8]
    });
    _focusMarker = L.marker([caseData.latitude, caseData.longitude], { icon: icon }).addTo(map);
    map.setView([caseData.latitude, caseData.longitude], 6, { animate: true });
    document.getElementById('map-wrapper').classList.add('focus-mode');
    document.getElementById('side-panel').classList.add('focus-panel');
    setTimeout(function() {
        map.invalidateSize();
        // If IR data was already fetched before focus mode, show it now
        if (_irData && _irFrameURLs.length) {
            _injectIRMapControls();
            showIRMapOverlay(0);
        }
    }, 380);
}

function exitFocusMode() {
    if (!_focusMode) return;
    _focusMode = false;
    if (_focusMarker) { map.removeLayer(_focusMarker); _focusMarker = null; }
    removeIRMapOverlay();
    removeNexradMapOverlay();
    cleanupERA5();
    if (_mapViewMode === 'tracks') {
        if (_trackViewLayer) map.addLayer(_trackViewLayer);
    } else {
        if (markers) map.addLayer(markers);
    }
    document.getElementById('map-wrapper').classList.remove('focus-mode');
    document.getElementById('side-panel').classList.remove('focus-panel');
    document.getElementById('storm-select').value = '';
    document.getElementById('case-select').innerHTML = '<option value="">\u2190 Select a storm first</option>';
    document.getElementById('case-select').disabled = true;
    document.getElementById('explore-btn').disabled = true;
    // Restore map filter to all
    filters.stormName = 'all';
    updateMarkers();
    setTimeout(function() { map.invalidateSize(); map.setView([20, -60], 4, { animate: true }); }, 380);
}

// Storm dropdown: filters the map AND populates the case dropdown
document.getElementById('storm-select').addEventListener('change', function() {
    var storm = this.value;
    var caseSelect = document.getElementById('case-select');
    var exploreBtn = document.getElementById('explore-btn');

    // Update map filter
    filters.stormName = storm || 'all';
    updateMarkers();

    // Populate case dropdown
    caseSelect.innerHTML = '';
    if (!storm) {
        caseSelect.innerHTML = '<option value="">\u2190 Select a storm first</option>';
        caseSelect.disabled = true;
        exploreBtn.disabled = true;
        return;
    }

    caseSelect.disabled = false;
    caseSelect.innerHTML = '<option value="">Choose a case\u2026</option>';
    var cases = _getActiveData().cases.filter(function(c) {
        if (c.storm_name !== storm) return false;
        if (_selectedYear && c.year !== _selectedYear) return false;
        return true;
    });
    cases.sort(function(a, b) { return a.datetime.localeCompare(b.datetime); });
    cases.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.case_index;
        var cat = getIntensityCategory(c.vmax_kt);
        var vStr = c.vmax_kt !== null ? ' [' + cat + ', ' + c.vmax_kt + ' kt]' : '';
        opt.textContent = c.datetime + vStr;
        caseSelect.appendChild(opt);
    });

    // Zoom map to storm's extent
    var lats = cases.map(function(c) { return c.latitude; });
    var lons = cases.map(function(c) { return c.longitude; });
    if (lats.length > 0) {
        var bounds = L.latLngBounds(
            [Math.min.apply(null, lats) - 2, Math.min.apply(null, lons) - 2],
            [Math.max.apply(null, lats) + 2, Math.max.apply(null, lons) + 2]
        );
        map.fitBounds(bounds, { padding: [40, 40], animate: true });
    }
});

// Case dropdown: enable explore button
document.getElementById('case-select').addEventListener('change', function() {
    document.getElementById('explore-btn').disabled = !this.value;
});

// Explore button
function exploreCaseGo() {
    var idx = parseInt(document.getElementById('case-select').value);
    if (isNaN(idx) || !_getActiveData()) return;
    var caseData = _getActiveData().cases.find(function(c) { return c.case_index === idx; });
    if (!caseData) return;
    _ga('explore_case', { case_index: idx, storm_name: caseData.storm_name, vmax_kt: caseData.vmax_kt, data_type: _activeDataType });
    enterFocusMode(caseData);
    openSidePanel(caseData, true);
}

// ── Side panel ───────────────────────────────────────────────
function openSidePanel(caseData, fromQuickSelect) {
    _archiveFLReset();
    _archiveSondeReset();
    currentCaseIndex = caseData.case_index;
    currentCaseData = caseData;
    _currentSddc = (caseData.sddc !== null && caseData.sddc !== undefined && caseData.sddc !== 9999) ? caseData.sddc : null;
    _updatePermalink();
    const idx = caseData.case_index;
    const padded = String(idx).padStart(4, '0');
    const imgPrefix = _activeDataType === 'merge' ? 'v3m_merge_cf_' : 'v3m_swath_cf_';
    const imageUrl = 'images/v3m/' + imgPrefix + padded + '.png';

    var backBtnHtml = _focusMode ?
        '<button class="focus-back-btn" onclick="exitFocusMode();closeSidePanel();">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>' +
        'Back to all cases</button>' :
        '<button class="focus-back-btn" style="background:var(--blue);color:white;border-color:var(--blue);" ' +
        'onclick="enterFocusMode(_lastCaseData);openSidePanel(_lastCaseData,false);">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg>' +
        'Focus &amp; IR Satellite</button>';

    window._lastCaseData = caseData;

    document.getElementById('side-panel-inner').innerHTML =
        '<button id="side-panel-close" onclick="closeSidePanel()">\u2715</button>' +
        backBtnHtml +
        '<div class="panel-storm-name">' + caseData.storm_name +
            (_activeDataType === 'merge' ? ' <span style="font-size:10px;background:#4f46e5;color:#fff;padding:1px 6px;border-radius:3px;vertical-align:middle;">MERGE</span>' : '') +
            '<button class="cite-btn" onclick="showCiteModal()" title="How to cite TC-ATLAS &amp; TC-RADAR">\uD83D\uDCCB Cite</button>' +
            '<button class="cite-btn" onclick="copyPermalink()" title="Copy shareable link" style="margin-left:4px;">\uD83D\uDD17 Share</button>' +
        '</div>' +
        '<div class="panel-mission">' + caseData.mission_id + ' \u00b7 ' + caseData.datetime +
            (caseData.number_of_swaths ? ' \u00b7 ' + caseData.number_of_swaths + ' swaths' : '') +
        '</div>' +

        '<div class="explorer-layout">' +
            // ── LEFT: Display area + action buttons ──
            '<div class="explorer-display">' +
                '<div id="display-area">' +
                    '<div id="thumbnail-wrap">' +
                        '<div class="panel-image-wrap" id="thumb-img-wrap">' +
                            '<img id="thumb-img" src="' + imageUrl + '" alt="Quick-look: ' + caseData.storm_name + '">' +
                        '</div>' +
                        '<div class="panel-image-label">Quick-look (2-km V<sub>t</sub>, WCM) \u00b7 ' + (_activeDataType === 'merge' ? 'Merged' : 'Swath') + ' \u00b7 click to enlarge</div>' +
                    '</div>' +
                    '<div class="explorer-result" id="ep-result"></div>' +
                    '<div class="cs-result" id="cs-result"></div>' +
                    '<div class="az-result" id="az-result"></div>' +
                    '<div class="sq-result" id="sq-result"></div>' +
                    '<div class="cs-status" id="cs-status"></div>' +
                '</div>' +
                // ── OVERLAYS: compact pill toggle strip ──
                '<div class="overlay-strip">' +
                    '<span class="overlay-strip-label">Layers</span>' +
                    '<button class="overlay-pill" id="ir-underlay-btn" onclick="toggleIRPlotlyUnderlay()" disabled data-color="cyan" title="IR Satellite Underlay">\uD83D\uDEF0 IR</button>' +
                    '<button class="overlay-pill active" id="tdr-toggle-btn" onclick="toggleTDRVisibility()" data-color="red" title="TDR Radar Visibility">\uD83C\uDF00 TDR</button>' +
                    '<button class="overlay-pill" id="btn-archive-fl" onclick="archiveToggleFlightLevel()" data-color="blue" title="Flight-Level Data">\u2708 FL</button>' +
                    '<button class="overlay-pill" id="btn-archive-sonde" onclick="archiveToggleDropsondes()" data-color="green" title="Dropsonde Data">\uD83E\uDE82 Sondes</button>' +
                    '<button class="overlay-pill" id="barb-btn" onclick="toggleWindBarbs()" data-color="slate" title="Wind Barbs">\uD83C\uDF2C Barbs</button>' +
                    '<button class="overlay-pill" id="tilt-btn" onclick="toggleTiltProfile()" data-color="pink" title="Vortex Tilt Profile">\uD83C\uDFAF Tilt</button>' +
                    '<button class="overlay-pill" id="env-case-btn" onclick="toggleEnvOverlay()" data-color="emerald" title="ERA5 Environment Diagnostics">\uD83C\uDF0D Env</button>' +
                    '<button class="overlay-pill" id="mw-overlay-btn" onclick="toggleMicrowaveOverlay()" data-color="orange" title="Microwave Satellite Overlay">\uD83D\uDCE1 MW</button>' +
                    '<button class="overlay-pill" id="nexrad-overlay-btn" onclick="toggleNexradOverlay()" data-color="green" title="NEXRAD 88D Ground Radar">\uD83C\uDF00 88D</button>' +
                '</div>' +
                // ── Microwave overpass selector (hidden by default) ──
                '<div id="mw-overpass-panel" style="display:none;margin-top:6px;background:rgba(30,41,59,0.95);border:1px solid rgba(251,146,60,0.35);border-radius:8px;padding:8px 12px;">' +
                    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
                        '<label style="font-size:10px;font-weight:600;color:#fdba74;text-transform:uppercase;letter-spacing:0.5px;">Overpass</label>' +
                        '<select id="mw-overpass-select" onchange="loadMicrowaveOverpass()" style="flex:1;min-width:180px;font-size:10px;padding:4px 6px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"></select>' +
                        '<label style="font-size:10px;color:#9ca3af;">Product</label>' +
                        '<select id="mw-product-select" onchange="loadMicrowaveOverpass()" style="font-size:10px;padding:4px 6px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                            '<option value="89pct">89 GHz PCT</option>' +
                            '<option value="89v">89 GHz V-pol</option>' +
                            '<option value="89h">89 GHz H-pol</option>' +
                            '<option value="37color">37 GHz Color</option>' +
                            '<option value="37v">37 GHz V-pol</option>' +
                            '<option value="37h">37 GHz H-pol</option>' +
                        '</select>' +
                        '<span id="mw-status" style="font-size:9px;color:#64748b;"></span>' +
                        '<span style="font-size:8px;color:#64748b;margin-left:auto;">Data: <a href="https://rammb-data.cira.colostate.edu/tcprimed/" target="_blank" rel="noopener" style="color:#94a3b8;text-decoration:none;border-bottom:1px dotted #64748b;">TC-PRIMED</a> (NOAA/CSU)</span>' +
                    '</div>' +
                    '<div style="display:flex;align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap;">' +
                        '<button id="mw-planview-btn" class="overlay-pill active" onclick="toggleMWPlanView()" style="font-size:9px;padding:2px 8px;background:rgba(251,146,60,0.2);border:1px solid rgba(251,146,60,0.4);border-radius:4px;color:#fdba74;cursor:pointer;" title="Toggle MW on Plan View">Plan View</button>' +
                        '<label style="font-size:9px;color:#9ca3af;">Range</label>' +
                        '<input id="mw-vmin" type="number" value="105" step="5" style="width:44px;font-size:9px;padding:2px 4px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;text-align:center;" onchange="updateMWColorBounds()">' +
                        '<span style="font-size:9px;color:#64748b;">–</span>' +
                        '<input id="mw-vmax" type="number" value="305" step="5" style="width:44px;font-size:9px;padding:2px 4px;border:1px solid rgba(255,255,255,0.1);border-radius:3px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;text-align:center;" onchange="updateMWColorBounds()">' +
                        '<span style="font-size:9px;color:#64748b;">K</span>' +
                    '</div>' +
                '</div>' +
                // ── NEXRAD 88D controls (hidden by default) ──
                '<div id="nexrad-panel" style="display:none;margin-top:6px;background:rgba(30,41,59,0.95);border:1px solid rgba(34,197,94,0.35);border-radius:8px;padding:8px 12px;">' +
                    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
                        '<label style="font-size:10px;font-weight:600;color:#86efac;text-transform:uppercase;letter-spacing:0.5px;">88D Site</label>' +
                        '<select id="nexrad-site-select" onchange="loadTdrNexradScans()" style="flex:1;min-width:120px;font-size:10px;padding:4px 6px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"></select>' +
                        '<select id="nexrad-scan-select" onchange="loadTdrNexradFrame()" style="flex:1;min-width:140px;font-size:10px;padding:4px 6px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"></select>' +
                        '<select id="nexrad-product-select" onchange="loadTdrNexradFrame()" style="font-size:10px;padding:4px 6px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                            '<option value="reflectivity">Reflectivity</option>' +
                            '<option value="velocity">Velocity</option>' +
                        '</select>' +
                        '<span id="nexrad-status" style="font-size:9px;color:#64748b;"></span>' +
                    '</div>' +
                    '<div style="display:flex;align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap;">' +
                        '<button id="nexrad-planview-btn" class="overlay-pill" onclick="toggleNexradPlanView()" style="font-size:9px;padding:2px 8px;background:rgba(34,197,94,0.2);border:1px solid rgba(34,197,94,0.4);border-radius:4px;color:#86efac;cursor:pointer;" title="Toggle storm-relative 88D on Plan View">Plan View</button>' +
                        '<span style="font-size:8px;color:#64748b;margin-left:auto;">Data: <a href="https://registry.opendata.aws/noaa-nexrad/" target="_blank" rel="noopener" style="color:#94a3b8;text-decoration:none;border-bottom:1px dotted #64748b;">NOAA NEXRAD L2</a> (AWS)</span>' +
                    '</div>' +
                    '<div id="nexrad-colorbar" style="margin-top:5px;"></div>' +
                '</div>' +
                '<div class="fl-archive-status" id="fl-archive-status" style="display:none;font-size:10px;color:#fbbf24;padding:2px 8px;"></div>' +
                // ── ANALYSIS: primary action buttons ──
                '<div class="action-section">' +
                    '<span class="action-section-label">Analysis</span>' +
                    '<div class="display-actions">' +
                        '<button class="cs-btn" id="cs-btn" onclick="toggleCrossSection()" disabled>\u2702 Cross Section</button>' +
                        '<button class="cs-btn" id="az-btn" onclick="dispatchAzimuthalMean()" disabled>\u27F3 Azim. Mean</button>' +
                        '<button class="cs-btn" id="sq-btn" onclick="fetchShearQuadrants()" disabled>\u25D1 Shear Quads</button>' +
                        '<button class="cs-btn" id="vol-btn" onclick="fetch3DVolume()" disabled>\uD83D\uDDA5 3D Volume</button>' +
                        '<button class="cs-btn" id="vp-scatter-btn" onclick="fetchVPScatter()" style="background:rgba(251,191,36,0.12);border-color:rgba(251,191,36,0.35);color:#fde68a;">\u2B24 VP Scatter</button>' +
                        '<button class="cs-btn" id="anom-btn" onclick="document.getElementById(\'az-coord-mode\').value=\'anomaly\';dispatchAzimuthalMean();" disabled style="background:rgba(52,211,153,0.12);border-color:rgba(52,211,153,0.35);color:#6ee7b7;">Z* Anomaly</button>' +
                        '<button class="cs-btn" id="cfad-btn" onclick="toggleSingleCFADConfig()" disabled style="background:rgba(168,85,247,0.12);border-color:rgba(168,85,247,0.35);color:#c4b5fd;">\u2593 CFAD</button>' +
                    '</div>' +
                '</div>' +
                // ── CFAD config panel (inline, hidden by default) ──
                '<div id="cfad-config-popover" style="display:none;margin-top:6px;background:rgba(30,41,59,0.95);border:1px solid rgba(168,85,247,0.35);border-radius:8px;padding:10px 12px;">' +
                    '<div style="font-size:10px;font-weight:600;color:#c4b5fd;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">\u2593 CFAD Options</div>' +
                    '<div style="display:flex;flex-wrap:wrap;gap:8px 16px;">' +
                        '<div style="display:flex;align-items:center;gap:6px;"><label style="font-size:10px;color:#9ca3af;width:70px;flex-shrink:0;">Bin Width</label><input type="number" id="sc-cfad-bin-width" placeholder="auto" min="0.1" step="any" style="width:65px;padding:3px 6px;font-size:10px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"></div>' +
                        '<div style="display:flex;align-items:center;gap:6px;"><label style="font-size:10px;color:#9ca3af;width:50px;flex-shrink:0;"># Bins</label><input type="number" id="sc-cfad-n-bins" value="40" min="5" max="200" step="1" style="width:55px;padding:3px 6px;font-size:10px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"><span style="font-size:8px;color:#6b7280;">(if no width)</span></div>' +
                        '<div style="display:flex;align-items:center;gap:6px;"><label style="font-size:10px;color:#9ca3af;width:70px;flex-shrink:0;">Bin Range</label><input type="number" id="sc-cfad-bin-min" placeholder="auto" step="any" style="width:55px;padding:3px 6px;font-size:10px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"><span style="font-size:9px;color:#6b7280;">to</span><input type="number" id="sc-cfad-bin-max" placeholder="auto" step="any" style="width:55px;padding:3px 6px;font-size:10px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"></div>' +
                        '<div style="display:flex;align-items:center;gap:6px;"><label style="font-size:10px;color:#9ca3af;width:70px;flex-shrink:0;">Normalise</label><select id="sc-cfad-normalise" style="font-size:10px;padding:3px 4px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"><option value="height">% at Each Height</option><option value="total">% of Total</option><option value="raw">Raw Counts</option></select></div>' +
                        '<div style="display:flex;align-items:center;gap:6px;"><label style="font-size:10px;color:#9ca3af;width:70px;flex-shrink:0;">Radial (km)</label><input type="number" id="sc-cfad-min-radius" value="0" min="0" max="500" step="any" style="width:55px;padding:3px 6px;font-size:10px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"><span style="font-size:9px;color:#6b7280;">to</span><input type="number" id="sc-cfad-max-radius" value="200" min="0.1" max="500" step="any" style="width:55px;padding:3px 6px;font-size:10px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;"></div>' +
                        '<div style="display:flex;align-items:center;gap:4px;"><input type="checkbox" id="sc-cfad-log-scale"><label for="sc-cfad-log-scale" style="font-size:10px;color:#9ca3af;">Log-scale colorbar</label></div>' +
                    '</div>' +
                    '<div style="display:flex;gap:6px;margin-top:10px;">' +
                        '<button onclick="fetchSingleCFAD()" style="padding:6px 16px;font-size:11px;font-weight:700;border:none;border-radius:5px;background:rgba(168,85,247,0.5);color:#e9d5ff;cursor:pointer;font-family:\'JetBrains Mono\',monospace;transition:background 0.2s;" onmouseover="this.style.background=\'rgba(168,85,247,0.7)\'" onmouseout="this.style.background=\'rgba(168,85,247,0.5)\'">Generate CFAD</button>' +
                        '<button onclick="toggleSingleCFADConfig()" style="padding:6px 12px;font-size:11px;font-weight:700;border:1px solid rgba(255,255,255,0.1);border-radius:5px;background:transparent;color:#9ca3af;cursor:pointer;font-family:\'JetBrains Mono\',monospace;">Cancel</button>' +
                    '</div>' +
                '</div>' +
                // ── STORM EVOLUTION: temporal context ──
                '<div class="action-section">' +
                    '<span class="action-section-label">Storm Evolution</span>' +
                    '<div class="display-actions">' +
                        '<button class="cs-btn" id="storm-timeline-btn" onclick="toggleStormTimeline()" style="background:rgba(0,212,255,0.12);border-color:rgba(0,212,255,0.35);color:#67e8f9;">\uD83D\uDCCA Intensity</button>' +
                        '<button class="cs-btn" id="hovmoller-btn" onclick="toggleHovmoller()" style="background:rgba(251,146,60,0.12);border-color:rgba(251,146,60,0.35);color:#fdba74;">\u2630 Hovm\u00f6ller</button>' +
                        '<button class="cs-btn" id="mw-timeline-btn" onclick="toggleMWTimeline()" style="background:rgba(251,146,60,0.12);border-color:rgba(251,146,60,0.35);color:#fde68a;">\uD83D\uDCE1 MW Timeline</button>' +
                    '</div>' +
                '</div>' +
                // ── Storm intensity timeline (hidden by default) ──
                '<div id="storm-timeline-panel" class="storm-timeline-panel" style="display:none;">' +
                    '<div class="fl-ts-header">' +
                        '<span class="fl-ts-title">\uD83C\uDF00 Best-Track Intensity</span>' +
                        '<div style="display:flex;align-items:center;gap:4px;">' +
                            '<button class="cs-btn" id="fdeck-archive-btn" onclick="toggleArchiveFDeck()" style="font-size:9px;padding:3px 8px;margin:0;min-width:0;flex:none;background:rgba(255,159,67,0.12);border-color:rgba(255,159,67,0.35);color:#ff9f43;">F-Deck</button>' +
                            '<span id="fdeck-archive-status" style="font-size:9px;color:#64748b;"></span>' +
                        '</div>' +
                        '<button onclick="archiveSavePlotPNG(\'storm-timeline-chart\',\'StormTimeline\')" class="rt-save-png-btn" style="margin-left:4px;" title="Save as PNG"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg></button>' +
                        '<button onclick="closeStormTimeline()" class="fl-ts-close" title="Close">&times;</button>' +
                    '</div>' +
                    '<div id="storm-timeline-chart" style="width:100%;height:280px;"></div>' +
                '</div>' +
                // ── Hovmöller panel (hidden by default) ──
                '<div id="hovmoller-panel" class="storm-timeline-panel" style="display:none;">' +
                    '<div class="fl-ts-header">' +
                        '<span class="fl-ts-title">\u2630 Hovm\u00f6ller (Time \u00d7 Radius)</span>' +
                        '<div style="display:flex;align-items:center;gap:4px;margin-left:auto;">' +
                            '<label style="font-size:9px;color:#8b9ec2;">Coverage:</label>' +
                            '<select id="hovmoller-coverage" style="font-size:9px;background:#0f2140;color:#e2e8f0;border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:1px 4px;" onchange="_fetchAndRenderHovmoller()">' +
                                '<option value="0.0">0%</option>' +
                                '<option value="0.1">10%</option>' +
                                '<option value="0.25" selected>25%</option>' +
                                '<option value="0.5">50%</option>' +
                                '<option value="0.75">75%</option>' +
                            '</select>' +
                        '</div>' +
                        '<button onclick="archiveSavePlotPNG(\'hovmoller-chart\',\'Hovmoller\')" class="rt-save-png-btn" style="margin-left:4px;" title="Save as PNG"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg></button>' +
                        '<button onclick="closeHovmoller()" class="fl-ts-close" title="Close">&times;</button>' +
                    '</div>' +
                    '<div id="hovmoller-status" style="font-size:10px;color:#64748b;padding:2px 8px;"></div>' +
                    '<div id="hovmoller-chart" style="width:100%;height:340px;"></div>' +
                '</div>' +
                // ── MW Timeline panel (hidden by default) ──
                '<div id="mw-timeline-panel" class="storm-timeline-panel" style="display:none;">' +
                    '<div class="fl-ts-header">' +
                        '<span class="fl-ts-title">\uD83D\uDCE1 MW Overpass Timeline</span>' +
                        '<button onclick="closeMWTimeline()" class="fl-ts-close" title="Close">&times;</button>' +
                    '</div>' +
                    '<div id="mw-timeline-status" style="font-size:10px;color:#64748b;padding:2px 8px;"></div>' +
                    '<div id="mw-timeline-chart" style="width:100%;height:260px;"></div>' +
                    '<div style="font-size:9px;color:#475569;padding:0 8px 4px;display:flex;justify-content:space-between;">' +
                        '<span>Data: <a href="https://rammb-data.cira.colostate.edu/tcprimed/" target="_blank" rel="noopener" style="color:#64748b;">TC-PRIMED</a> (NOAA/CSU)</span>' +
                        '<span>Click a marker to load that overpass</span>' +
                    '</div>' +
                '</div>' +
                // ── Pre-rendered FL time-series panel (hidden by default) ──
                '<div id="fl-archive-ts" class="fl-archive-ts" style="display:none;">' +
                    '<div class="fl-ts-header">' +
                        '<span class="fl-ts-title">\u2708 Along-Track Time Series</span>' +
                        '<div class="fl-ts-res-group" id="arch-fl-res-group"></div>' +
                        '<button onclick="archiveSavePlotPNG(\'fl-ts-chart\',\'FL_TimeSeries\')" class="rt-save-png-btn" style="margin-left:4px;" title="Save as PNG"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg></button>' +
                        '<button onclick="archFLCloseTimeSeries()" class="fl-ts-close" title="Close">&times;</button>' +
                    '</div>' +
                    '<div class="fl-ts-var-bar" id="arch-fl-ts-vars"></div>' +
                    '<div class="fl-ts-info" id="fl-ts-info"></div>' +
                    '<div id="fl-ts-chart" style="width:100%;height:340px;"></div>' +
                    '<div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:2px 0 6px;">' +
                        '<span style="color:#64748b;font-size:10px;">X-Axis:</span>' +
                        '<button class="fl-ts-xbtn' + (_archFLTSXAxis === 'time' ? ' active' : '') + '" onclick="_archFLSetXAxis(\'time\')" id="fl-ts-xbtn-time">Time</button>' +
                        '<button class="fl-ts-xbtn' + (_archFLTSXAxis === 'radius' ? ' active' : '') + '" onclick="_archFLSetXAxis(\'radius\')" id="fl-ts-xbtn-radius">Radius</button>' +
                        '<span style="color:#64748b;font-size:10px;margin-left:8px;">Click and drag to zoom \u00b7 Double-click to reset</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            // ── RIGHT: Controls panel ──
            '<div class="explorer-controls">' +
                '<div class="explorer-title">\uD83D\uDD2C Explore Data</div>' +
                '<div class="explorer-row"><label>Variable</label>' +
                    '<select class="explorer-select" id="ep-var">' +
                        '<optgroup label="WCM Recentered (2 km)">' +
                            '<option value="recentered_tangential_wind">Tangential Wind</option>' +
                            '<option value="recentered_radial_wind">Radial Wind</option>' +
                            '<option value="recentered_upward_air_velocity">Vertical Velocity</option>' +
                            '<option value="recentered_reflectivity">Reflectivity</option>' +
                            '<option value="recentered_wind_speed">Wind Speed</option>' +
                            '<option value="recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                            '<option value="recentered_relative_vorticity">Relative Vorticity</option>' +
                            '<option value="recentered_divergence">Divergence</option>' +
                        '</optgroup>' +
                        '<optgroup label="Tilt-Relative">' +
                            '<option value="total_recentered_tangential_wind">Tangential Wind</option>' +
                            '<option value="total_recentered_radial_wind">Radial Wind</option>' +
                            '<option value="total_recentered_upward_air_velocity">Vertical Velocity</option>' +
                            '<option value="total_recentered_reflectivity">Reflectivity</option>' +
                            '<option value="total_recentered_wind_speed">Wind Speed</option>' +
                            '<option value="total_recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                        '</optgroup>' +
                        '<optgroup label="Original Swath" id="ep-var-original">' +
                            '<option value="swath_tangential_wind">Tangential Wind</option>' +
                            '<option value="swath_radial_wind">Radial Wind</option>' +
                            '<option value="swath_reflectivity">Reflectivity</option>' +
                            '<option value="swath_wind_speed">Wind Speed</option>' +
                            '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                        '</optgroup>' +
                    '</select>' +
                '</div>' +
                '<div class="explorer-row"><label>Contour Overlay</label>' +
                    '<select class="explorer-select" id="ep-overlay" style="font-size:11px;">' +
                        '<option value="">None</option>' +
                        '<optgroup label="WCM Recentered (2 km)">' +
                            '<option value="recentered_tangential_wind">Tangential Wind</option>' +
                            '<option value="recentered_radial_wind">Radial Wind</option>' +
                            '<option value="recentered_upward_air_velocity">Vertical Velocity</option>' +
                            '<option value="recentered_reflectivity">Reflectivity</option>' +
                            '<option value="recentered_wind_speed">Wind Speed</option>' +
                            '<option value="recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                            '<option value="recentered_relative_vorticity">Relative Vorticity</option>' +
                            '<option value="recentered_divergence">Divergence</option>' +
                        '</optgroup>' +
                        '<optgroup label="Tilt-Relative">' +
                            '<option value="total_recentered_tangential_wind">Tangential Wind</option>' +
                            '<option value="total_recentered_radial_wind">Radial Wind</option>' +
                            '<option value="total_recentered_upward_air_velocity">Vertical Velocity</option>' +
                            '<option value="total_recentered_reflectivity">Reflectivity</option>' +
                            '<option value="total_recentered_wind_speed">Wind Speed</option>' +
                            '<option value="total_recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                        '</optgroup>' +
                        '<optgroup label="Original Swath" id="ep-overlay-original">' +
                            '<option value="swath_tangential_wind">Tangential Wind</option>' +
                            '<option value="swath_radial_wind">Radial Wind</option>' +
                            '<option value="swath_reflectivity">Reflectivity</option>' +
                            '<option value="swath_wind_speed">Wind Speed</option>' +
                            '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                        '</optgroup>' +
                    '</select>' +
                    '<div style="display:flex;align-items:center;gap:5px;margin-top:2px;">' +
                        '<label style="font-size:9px;white-space:nowrap;margin:0;">Int:</label>' +
                        '<input type="number" id="ep-contour-int" value="" placeholder="auto" style="width:55px;padding:2px 4px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);">' +
                        '<span style="font-size:9px;color:var(--slate);" id="ep-contour-units"></span>' +
                    '</div>' +
                '</div>' +
                '<div class="explorer-row"><label>Colormap</label>' +
                    '<select class="explorer-select" id="ep-cmap" style="font-size:11px;" onchange="applyCmap()">' +
                        '<option value="">Default (from variable)</option>' +
                        '<optgroup label="Sequential"><option value="Viridis">Viridis</option><option value="Inferno">Inferno</option><option value="Magma">Magma</option><option value="Plasma">Plasma</option><option value="Cividis">Cividis</option><option value="Hot">Hot</option><option value="YlOrRd">YlOrRd</option><option value="YlGnBu">YlGnBu</option><option value="Blues">Blues</option><option value="Reds">Reds</option><option value="Greys">Greys</option></optgroup>' +
                        '<optgroup label="Diverging"><option value="RdBu">RdBu (red-blue)</option><option value=\'[[0,"rgb(5,10,172)"],[0.5,"rgb(255,255,255)"],[1,"rgb(178,10,28)"]]\'>BuWtRd (blue-white-red)</option><option value="Picnic">Picnic</option><option value="Portland">Portland</option></optgroup>' +
                        '<optgroup label="Radar"><option value=\'[[0,"rgb(20,20,20)"],[0.2,"rgb(20,20,20)"],[0.2,"rgb(4,233,231)"],[0.2667,"rgb(4,233,231)"],[0.2667,"rgb(1,159,244)"],[0.3333,"rgb(1,159,244)"],[0.3333,"rgb(3,0,244)"],[0.4,"rgb(3,0,244)"],[0.4,"rgb(2,253,2)"],[0.4667,"rgb(2,253,2)"],[0.4667,"rgb(1,197,1)"],[0.5333,"rgb(1,197,1)"],[0.5333,"rgb(0,142,0)"],[0.6,"rgb(0,142,0)"],[0.6,"rgb(253,248,2)"],[0.6667,"rgb(253,248,2)"],[0.6667,"rgb(229,188,0)"],[0.7333,"rgb(229,188,0)"],[0.7333,"rgb(253,149,0)"],[0.8,"rgb(253,149,0)"],[0.8,"rgb(253,0,0)"],[0.8667,"rgb(253,0,0)"],[0.8667,"rgb(212,0,0)"],[0.9333,"rgb(212,0,0)"],[0.9333,"rgb(248,0,253)"],[1.0,"rgb(248,0,253)"]]\'>NWS Reflectivity</option></optgroup>' +
                        '<optgroup label="Other"><option value="Jet">Jet</option><option value="Rainbow">Rainbow</option><option value="Electric">Electric</option><option value="Earth">Earth</option><option value="Blackbody">Blackbody</option></optgroup>' +
                    '</select>' +
                '</div>' +
                '<div class="explorer-row"><label>Color Range</label>' +
                    '<div style="display:flex;align-items:center;gap:4px;">' +
                        '<input type="number" id="ep-vmin" placeholder="min" step="any" style="width:60px;padding:2px 4px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);" onchange="applyColorRange()">' +
                        '<span style="font-size:10px;color:var(--slate);">to</span>' +
                        '<input type="number" id="ep-vmax" placeholder="max" step="any" style="width:60px;padding:2px 4px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);" onchange="applyColorRange()">' +
                        '<button onclick="resetColorRange()" title="Reset" style="padding:2px 5px;font-size:9px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);cursor:pointer;color:var(--slate);">\u21BA</button>' +
                    '</div>' +
                '</div>' +
                '<div class="explorer-row"><label>Height Level</label>' +
                    '<div class="explorer-level-row">' +
                        '<input type="range" id="ep-level" min="0" max="18" step="0.5" value="2" oninput="document.getElementById(\'ep-level-val\').textContent = parseFloat(this.value).toFixed(1)+\' km\'">' +
                        '<span class="explorer-level-value" id="ep-level-val">2.0 km</span>' +
                    '</div>' +
                    '<div class="anim-controls">' +
                        '<button class="anim-btn" onclick="animStep(-1)" title="Previous level">\u25C0</button>' +
                        '<button class="anim-btn" id="anim-play-btn" onclick="animToggle()" title="Play/Pause">\u25B6</button>' +
                        '<button class="anim-btn" onclick="animStep(1)" title="Next level">\u25B6\u25B6</button>' +
                        '<span class="anim-speed" id="anim-speed-label">0.8s / level</span>' +
                    '</div>' +
                '</div>' +
                '<button class="generate-btn" id="ep-btn" onclick="generateCustomPlot()">Generate Plan View</button>' +
                '<div class="explorer-row" id="az-controls" style="margin-top:6px;"><label>Min. Coverage Threshold</label>' +
                    '<div style="display:flex;align-items:center;gap:6px;">' +
                        '<input type="range" id="az-coverage" min="0" max="100" step="5" value="50" class="az-cov-slider" oninput="document.getElementById(\'az-cov-val\').textContent = this.value+\'%\'">' +
                        '<span style="font-size:11px;font-weight:600;color:var(--cyan);min-width:32px;font-family:\'JetBrains Mono\',monospace;" id="az-cov-val">50%</span>' +
                    '</div>' +
                '</div>' +
                '<div class="explorer-row" style="margin-top:6px;"><label>Azim. Mean Coordinate</label>' +
                    '<select class="explorer-select" id="az-coord-mode" style="font-size:11px;">' +
                        '<option value="standard">Standard (km)</option>' +
                        '<option value="hybrid">R\u2095 Hybrid (Fischer et al. 2025)</option>' +
                        '<option value="anomaly">Z* Anomaly (Fischer et al. 2025)</option>' +
                    '</select>' +
                '</div>' +
            '</div>' +
        '</div>';

    // Set up thumbnail click-to-enlarge and error handling
    var thumbImg = document.getElementById('thumb-img');
    var thumbWrap = document.getElementById('thumb-img-wrap');
    if (thumbImg) {
        thumbImg.onerror = function() {
            // Try raw GitHub URL as fallback
            var fallback = 'https://raw.githubusercontent.com/MichaelFischerWx/michaelfischerwx.github.io/main/TC-RADAR/images/v3m/' + imgPrefix + padded + '.png';
            if (this.src.indexOf('raw.githubusercontent') === -1) {
                this.src = fallback;
            } else {
                // Both failed, hide thumbnail
                document.getElementById('thumbnail-wrap').style.display = 'none';
            }
        };
        thumbWrap.onclick = function() {
            var src = thumbImg.src;
            openImageModal(src, caseData.storm_name + ' \u2013 ' + caseData.datetime);
        };
    }

    // Update variable optgroups for current data type
    _updateExplorerOriginalGroups();

    document.getElementById('side-panel').classList.add('open');

    // Fetch IR satellite data for this case
    _irData = null; _irFrameURLs = []; _irPlotlyVisible = false; _irAllFramesLoaded = false; _irLoadedCount = 0;
    _showIRLoadingIndicator();
    fetchIRData(caseData.case_index, function(data) {
        _removeIRLoadingIndicator();
        if (data && currentCaseIndex === caseData.case_index) {
            var irBtn = document.getElementById('ir-underlay-btn');
            if (irBtn) irBtn.disabled = false;
            if (_focusMode) {
                _injectIRMapControls();
                showIRMapOverlay(0);
            }
        }
    });

    // Fetch ERA5 environmental data for this case
    _era5Data = null; _era5PlotlyVisible = false;
    fetchERA5Data(caseData.case_index, 'shear_mag', function(data) {
        // ERA5 data pre-fetched for the Environment overlay (top-nav)
    });

    // Fetch nearby NEXRAD 88D sites for this case
    _nexradMapOverlay = null; _nexradPlanViewVisible = false; _nexradSrData = null;
    fetchNexradSites(caseData);

    setTimeout(function() { map.invalidateSize(); }, 360);
}

function closeSidePanel() {
    document.getElementById('side-panel').classList.remove('open');
    currentCaseIndex = null;
    currentCaseData = null;
    animStop();
    removeIRMapOverlay();
    removeMicrowaveOverlay();
    removeNexradOverlay();
    _irPlotlyVisible = false;
    cleanupERA5();
    _csMode = false; _csPointA = null; _removeRubberBand();
    exitFocusMode();
    setTimeout(function() { map.invalidateSize(); }, 360);
}

// ── State for animation & cross-section ──────────────────────
var _animTimer = null;
var _animPlaying = false;
var _dataCache = {};
var _csMode = false;
var _csPointA = null;
var _csMouseHandler = null;
var _currentSddc = null;
var _currentShdc = null;       // shear magnitude (kt)
var _currentMotionDir = null;  // TC motion direction (met heading, deg)
var _currentMotionSpd = null;  // TC motion speed (kt)
var _lastSqJson = null;

// ── ASCII Hurricane Loading Animation ────────────────────────
var _hurricaneAnimId = null;
var _hurricanePhase = 0;


// ══════════════════════════════════════════════════════════════
// ERA5 Environmental Diagnostics Module
// ══════════════════════════════════════════════════════════════

// ── ERA5 state ───────────────────────────────────────────────
var _era5Data = null;
var _era5MapField = 'shear_mag';
var _era5Fetching = false;
var _era5PlotlyVisible = false;

// ── ERA5 colormaps ───────────────────────────────────────────
var _era5Colormaps = {
    shear_mag: {
        stops: [
            { pos: 0.00, r: 255, g: 255, b: 204 },
            { pos: 0.15, r: 255, g: 237, b: 160 },
            { pos: 0.30, r: 254, g: 217, b: 118 },
            { pos: 0.45, r: 254, g: 178, b: 76  },
            { pos: 0.60, r: 253, g: 141, b: 60  },
            { pos: 0.75, r: 240, g: 59,  b: 32  },
            { pos: 0.90, r: 189, g: 0,   b: 38  },
            { pos: 1.00, r: 128, g: 0,   b: 38  },
        ],
    },
    rh_mid: {
        stops: [
            { pos: 0.00, r: 140, g: 81,  b: 10  },
            { pos: 0.15, r: 191, g: 129, b: 45  },
            { pos: 0.30, r: 223, g: 194, b: 125 },
            { pos: 0.50, r: 245, g: 245, b: 220 },
            { pos: 0.70, r: 128, g: 205, b: 193 },
            { pos: 0.85, r: 53,  g: 151, b: 143 },
            { pos: 1.00, r: 1,   g: 102, b: 94  },
        ],
    },
    div200: {
        stops: [
            { pos: 0.00, r: 178, g: 24,  b: 43  },
            { pos: 0.25, r: 239, g: 138, b: 98  },
            { pos: 0.45, r: 253, g: 219, b: 199 },
            { pos: 0.55, r: 209, g: 229, b: 240 },
            { pos: 0.75, r: 103, g: 169, b: 207 },
            { pos: 1.00, r: 33,  g: 102, b: 172 },
        ],
    },
    sst: {
        stops: [
            { pos: 0.00, r: 49,  g: 54,  b: 149 },
            { pos: 0.15, r: 69,  g: 117, b: 180 },
            { pos: 0.30, r: 116, g: 173, b: 209 },
            { pos: 0.45, r: 171, g: 217, b: 233 },
            { pos: 0.55, r: 253, g: 174, b: 97  },
            { pos: 0.70, r: 244, g: 109, b: 67  },
            { pos: 0.85, r: 215, g: 48,  b: 39  },
            { pos: 1.00, r: 165, g: 0,   b: 38  },
        ],
    },
    entropy_def: {
        stops: [
            { pos: 0.00, r: 255, g: 247, b: 236 },
            { pos: 0.15, r: 254, g: 232, b: 200 },
            { pos: 0.30, r: 253, g: 212, b: 158 },
            { pos: 0.45, r: 253, g: 187, b: 132 },
            { pos: 0.60, r: 227, g: 145, b: 86  },
            { pos: 0.75, r: 189, g: 109, b: 53  },
            { pos: 0.90, r: 140, g: 81,  b: 10  },
            { pos: 1.00, r: 84,  g: 48,  b: 5   },
        ],
    },
};

function _era5ValToColor(val, field) {
    var cfg = _era5Data ? _era5Data.field_config : null;
    if (!cfg) return [0, 0, 0, 0];
    var vmin = cfg.vmin, vmax = cfg.vmax;
    if (val === null || val === undefined || isNaN(val)) return [0, 0, 0, 0];
    var frac = (val - vmin) / (vmax - vmin);
    frac = Math.max(0, Math.min(1, frac));
    var stops = _era5Colormaps[field] ? _era5Colormaps[field].stops : _era5Colormaps.shear_mag.stops;
    var lo = stops[0], hi = stops[stops.length - 1];
    for (var i = 0; i < stops.length - 1; i++) {
        if (frac >= stops[i].pos && frac <= stops[i + 1].pos) {
            lo = stops[i]; hi = stops[i + 1]; break;
        }
    }
    var t = (hi.pos === lo.pos) ? 0 : (frac - lo.pos) / (hi.pos - lo.pos);
    return [
        Math.round(lo.r + t * (hi.r - lo.r)),
        Math.round(lo.g + t * (hi.g - lo.g)),
        Math.round(lo.b + t * (hi.b - lo.b)),
        200
    ];
}

function _era5RenderCanvas(data2d, field) {
    var nLat = data2d.length, nLon = data2d[0].length;
    var canvas = document.createElement('canvas');
    canvas.width = nLon; canvas.height = nLat;
    var ctx = canvas.getContext('2d');
    var imgData = ctx.createImageData(nLon, nLat);
    var d = imgData.data;
    for (var yi = 0; yi < nLat; yi++) {
        var srcRow = nLat - 1 - yi;
        for (var xi = 0; xi < nLon; xi++) {
            var idx = (yi * nLon + xi) * 4;
            var rgba = _era5ValToColor(data2d[srcRow][xi], field);
            d[idx] = rgba[0]; d[idx + 1] = rgba[1]; d[idx + 2] = rgba[2]; d[idx + 3] = rgba[3];
        }
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

// ── ERA5 data fetch ──────────────────────────────────────────
function fetchERA5Data(caseIndex, field, callback) {
    _ga('fetch_era5', { case_index: caseIndex, field: field });
    if (_era5Fetching) return;
    _era5Fetching = true;
    var url = API_BASE + '/era5?case_index=' + caseIndex + '&field=' + (field || 'shear_mag') + '&radius_km=300' + '&data_type=' + _activeDataType;
    fetch(url)
        .then(function(r) {
            if (!r.ok) { _era5Fetching = false; if (callback) callback(null); return null; }
            return r.json();
        })
        .then(function(data) {
            _era5Fetching = false;
            if (!data) return;
            _era5Data = data;
            if (callback) callback(data);
        })
        .catch(function(err) {
            console.warn('ERA5 fetch failed:', err);
            _era5Fetching = false; _era5Data = null;
            if (callback) callback(null);
        });
}

// ── Leaflet map overlay ──────────────────────────────────────
function _era5GetBounds(data) {
    var latOff = data.lat_offsets, lonOff = data.lon_offsets;
    return L.latLngBounds(
        [data.center_lat + latOff[0], data.center_lon + lonOff[0]],
        [data.center_lat + latOff[latOff.length - 1], data.center_lon + lonOff[lonOff.length - 1]]
    );
}

// ── Plotly explorer underlay ─────────────────────────────────
function buildERA5PlotlyTrace(data) {
    if (!data || !data.data) return null;
    var frame = data.data;
    var latOff = data.lat_offsets, lonOff = data.lon_offsets;
    var centerLat = data.center_lat;
    var cosLat = Math.cos(centerLat * Math.PI / 180);
    var yKm = latOff.map(function(d) { return d * 111.0; });
    var xKm = lonOff.map(function(d) { return d * 111.0 * cosLat; });
    return {
        z: frame, x: xKm, y: yKm, type: 'heatmap',
        colorscale: data.field_config.colorscale,
        zmin: data.field_config.vmin, zmax: data.field_config.vmax,
        showscale: false, hoverongaps: false, opacity: 0.25,
        hovertemplate: '<b>' + data.field_config.display_name + '</b>: %{z:.2f} ' + data.field_config.units + '<extra>ERA5</extra>',
    };
}

function buildERA5QuiverTraces(data) {
    if (!data || !data.vectors) return [];
    var vecs = data.vectors;
    var latOff = data.lat_offsets, lonOff = data.lon_offsets;
    var centerLat = data.center_lat;
    var cosLat = Math.cos(centerLat * Math.PI / 180);
    var stride = vecs.stride;
    var traces = [];
    var arrowScale = 40;
    for (var yi = 0; yi < vecs.u.length; yi++) {
        for (var xi = 0; xi < vecs.u[yi].length; xi++) {
            var u = vecs.u[yi][xi], v = vecs.v[yi][xi];
            if (u === null || v === null) continue;
            var x0 = lonOff[xi * stride] * 111.0 * cosLat;
            var y0 = latOff[yi * stride] * 111.0;
            var mag = Math.sqrt(u * u + v * v);
            if (mag < 0.5) continue;
            var scale = arrowScale * mag / 20;
            traces.push({
                x: [x0, x0 + u / mag * scale], y: [y0, y0 + v / mag * scale],
                type: 'scatter', mode: 'lines',
                line: { color: 'rgba(255,255,255,0.4)', width: 1 },
                showlegend: false, hoverinfo: 'skip',
            });
        }
    }
    return traces;
}

function toggleERA5PlotlyUnderlay() {
    _era5PlotlyVisible = !_era5PlotlyVisible;
    var plotDiv = document.getElementById('plotly-chart');
    if (!plotDiv || !plotDiv.data) { _era5PlotlyVisible = false; return; }

    if (_era5PlotlyVisible && _era5Data) {
        var trace = buildERA5PlotlyTrace(_era5Data);
        if (trace) {
            // Insert at index 0 (or 1 if IR underlay present)
            var insertIdx = 0;
            if (plotDiv.data.length > 0 && plotDiv.data[0].hovertemplate &&
                plotDiv.data[0].hovertemplate.indexOf('satellite') !== -1) {
                insertIdx = 1;
            }
            Plotly.addTraces('plotly-chart', trace, insertIdx);
            // Add quiver traces
            var quivers = buildERA5QuiverTraces(_era5Data);
            if (quivers.length) {
                for (var qi = 0; qi < quivers.length; qi++) {
                    Plotly.addTraces('plotly-chart', quivers[qi]);
                }
            }
        }
    } else {
        _era5PlotlyVisible = false;
        // Remove ERA5 traces (tagged with 'ERA5' in hovertemplate)
        var toRemove = [];
        for (var i = plotDiv.data.length - 1; i >= 0; i--) {
            if ((plotDiv.data[i].hovertemplate && plotDiv.data[i].hovertemplate.indexOf('ERA5') !== -1) ||
                (plotDiv.data[i].hoverinfo === 'skip' && plotDiv.data[i].line && plotDiv.data[i].line.color === 'rgba(255,255,255,0.4)')) {
                toRemove.push(i);
            }
        }
        if (toRemove.length) Plotly.deleteTraces('plotly-chart', toRemove);
    }
    _updateERA5Buttons();
}

function _updateERA5Buttons() {
    var btn = document.getElementById('env-case-btn');
    if (btn) {
        btn.classList.toggle('active', _era5PlotlyVisible);
    }
}

// ── ERA5 field selector ──────────────────────────────────────
function showERA5FieldMenu() {
    var existing = document.getElementById('era5-field-menu');
    if (existing) { existing.remove(); return; }
    var btn = document.getElementById('env-case-btn');
    if (!btn) return;
    var menu = document.createElement('div');
    menu.id = 'era5-field-menu';
    menu.className = 'env-field-dropdown';

    // ── Toggle row at top ──
    var toggleRow = document.createElement('div');
    toggleRow.className = 'env-field-option env-toggle-row' + (_era5PlotlyVisible ? ' active' : '');
    toggleRow.textContent = _era5PlotlyVisible ? '\u2705 Overlay On' : '\u274C Overlay Off';
    toggleRow.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.15);font-weight:bold;';
    toggleRow.onclick = function() {
        menu.remove();
        toggleERA5PlotlyUnderlay();
    };
    menu.appendChild(toggleRow);

    // ── Field options ──
    var fields = [
        { key: 'shear_mag',   label: '\uD83C\uDF2C Shear (200\u2013850 hPa)' },
        { key: 'rh_mid',      label: '\uD83D\uDCA7 Mid-Level RH (500\u2013700)' },
        { key: 'div200',      label: '\u2B06 200 hPa Divergence' },
        { key: 'sst',         label: '\uD83C\uDF0A Sea Surface Temperature' },
        { key: 'entropy_def', label: '\uD83C\uDF21 Entropy Deficit (\u03c7\u2098)' },
    ];
    fields.forEach(function(f) {
        var opt = document.createElement('div');
        opt.className = 'env-field-option' + (_era5MapField === f.key ? ' active' : '');
        opt.textContent = f.label;
        opt.onclick = function() {
            menu.remove();
            _era5MapField = f.key;
            if (currentCaseIndex !== null) {
                fetchERA5Data(currentCaseIndex, f.key, function(data) {
                    if (data) {
                        // Turn on underlay if not already visible
                        if (!_era5PlotlyVisible) {
                            toggleERA5PlotlyUnderlay();
                        } else {
                            // Already visible — swap the field
                            _era5PlotlyVisible = false;
                            toggleERA5PlotlyUnderlay();
                        }
                        _updateERA5Buttons();
                    }
                });
            }
        };
        menu.appendChild(opt);
    });
    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(menu);
    setTimeout(function() {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target) && e.target !== btn) {
                menu.remove(); document.removeEventListener('click', closeMenu);
            }
        });
    }, 10);
}



// ── Hodograph ────────────────────────────────────────────────
function renderHodograph(profiles, divId) {
    var el = document.getElementById(divId);
    if (!el || !profiles.u || !profiles.v) return;

    var u = profiles.u, v = profiles.v, plev = profiles.plev;
    var n = plev.length;

    // Height-based colors: blue (low) → green (mid) → red (upper)
    function plevColor(p) {
        var logMin = Math.log(100), logMax = Math.log(1000);
        var frac = 1.0 - (Math.log(p) - logMin) / (logMax - logMin);
        frac = Math.max(0, Math.min(1, frac));
        if (frac < 0.5) {
            var t = frac / 0.5;
            return 'rgb(' + Math.round(30 + t * 0) + ',' + Math.round(100 + t * 155) + ',' + Math.round(255 - t * 100) + ')';
        } else {
            var t2 = (frac - 0.5) / 0.5;
            return 'rgb(' + Math.round(30 + t2 * 225) + ',' + Math.round(255 - t2 * 155) + ',' + Math.round(155 - t2 * 155) + ')';
        }
    }

    var colors = plev.map(plevColor);

    // Profile line trace
    var profileTrace = {
        x: u, y: v, type: 'scatter', mode: 'lines+markers',
        marker: { color: colors, size: 7, line: { color: 'rgba(255,255,255,0.6)', width: 1 } },
        line: { color: 'rgba(180,180,180,0.4)', width: 1.5 },
        text: plev.map(function(p, i) {
            return p + ' hPa<br>u=' + (u[i] != null ? u[i].toFixed(1) : '?') + ' v=' + (v[i] != null ? v[i].toFixed(1) : '?') + ' m/s';
        }),
        hovertemplate: '%{text}<extra></extra>',
        showlegend: false,
    };

    // Shear vector: 850 → 200 hPa
    var i850 = -1, i200 = -1;
    for (var i = 0; i < n; i++) {
        if (plev[i] === 850) i850 = i;
        if (plev[i] === 200) i200 = i;
    }

    var traces = [profileTrace];
    if (i850 >= 0 && i200 >= 0 && u[i850] != null && u[i200] != null) {
        traces.push({
            x: [u[i850], u[i200]], y: [v[i850], v[i200]],
            type: 'scatter', mode: 'lines+markers+text',
            line: { color: '#f59e0b', width: 2.5, dash: 'dash' },
            marker: { size: [8, 10], color: '#f59e0b', symbol: ['circle', 'triangle-up'] },
            text: ['850', '200'], textposition: 'top right',
            textfont: { color: '#f59e0b', size: 9 },
            showlegend: false, hoverinfo: 'skip',
        });
    }

    // Range rings
    var shapes = [];
    var maxWind = 0;
    for (var j = 0; j < n; j++) {
        if (u[j] != null && v[j] != null) {
            maxWind = Math.max(maxWind, Math.sqrt(u[j] * u[j] + v[j] * v[j]));
        }
    }
    var ringMax = Math.ceil(maxWind / 5) * 5 + 5;
    for (var r = 5; r <= ringMax; r += 5) {
        shapes.push({
            type: 'circle', xref: 'x', yref: 'y',
            x0: -r, y0: -r, x1: r, y1: r,
            line: { color: 'rgba(255,255,255,0.07)', width: 1 },
        });
    }
    // Crosshairs
    shapes.push({ type: 'line', xref: 'x', yref: 'y', x0: -ringMax, y0: 0, x1: ringMax, y1: 0,
        line: { color: 'rgba(255,255,255,0.1)', width: 1 } });
    shapes.push({ type: 'line', xref: 'x', yref: 'y', x0: 0, y0: -ringMax, x1: 0, y1: ringMax,
        line: { color: 'rgba(255,255,255,0.1)', width: 1 } });

    var layout = {
        xaxis: { title: { text: 'u (m/s)', font: { size: 10, color: '#8b9ec2' } },
            range: [-ringMax, ringMax], scaleanchor: 'y', scaleratio: 1,
            zeroline: false, gridcolor: 'rgba(255,255,255,0.04)', color: '#8b9ec2', tickfont: { size: 9 } },
        yaxis: { title: { text: 'v (m/s)', font: { size: 10, color: '#8b9ec2' } },
            range: [-ringMax, ringMax],
            zeroline: false, gridcolor: 'rgba(255,255,255,0.04)', color: '#8b9ec2', tickfont: { size: 9 } },
        shapes: shapes,
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(10,22,40,0.5)',
        margin: { l: 40, r: 10, t: 25, b: 35 },
        title: { text: 'Hodograph (200\u2013600 km)', font: { size: 11, color: '#00d4ff' }, x: 0.5, y: 0.98 },
        showlegend: false,
    };

    Plotly.newPlot(divId, traces, layout, { responsive: true, displayModeBar: false });
}

// ── RH Vertical Profile ─────────────────────────────────────
function renderRHProfile(profiles, divId) {
    var el = document.getElementById(divId);
    if (!el || !profiles.rh) return;

    var trace = {
        x: profiles.rh, y: profiles.plev, type: 'scatter', mode: 'lines+markers',
        fill: 'tozerox', fillcolor: 'rgba(53,151,143,0.2)',
        line: { color: '#35978f', width: 2 },
        marker: { color: '#35978f', size: 5 },
        hovertemplate: '%{y} hPa: %{x:.0f}%<extra>RH</extra>',
    };
    var layout = {
        xaxis: { title: { text: 'RH (%)', font: { size: 9, color: '#8b9ec2' } },
            range: [0, 105], color: '#8b9ec2', tickfont: { size: 8 } },
        yaxis: { title: { text: 'Pressure (hPa)', font: { size: 9, color: '#8b9ec2' } },
            autorange: 'reversed', type: 'log', color: '#8b9ec2', tickfont: { size: 8 },
            tickvals: [1000, 850, 700, 500, 300, 200, 100] },
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(10,22,40,0.5)',
        margin: { l: 45, r: 5, t: 22, b: 30 },
        title: { text: 'RH Profile', font: { size: 10, color: '#00d4ff' }, x: 0.5, y: 0.98 },
    };
    Plotly.newPlot(divId, [trace], layout, { responsive: true, displayModeBar: false });
}

// ── Theta / Theta-e Vertical Profile ─────────────────────────
function renderThetaProfile(profiles, divId) {
    var el = document.getElementById(divId);
    if (!el) return;

    var traces = [];

    // θ profile (potential temperature)
    if (profiles.theta) {
        traces.push({
            x: profiles.theta, y: profiles.plev, type: 'scatter', mode: 'lines+markers',
            name: '\u03b8',
            line: { color: '#f59e0b', width: 2 },
            marker: { color: '#f59e0b', size: 5 },
            hovertemplate: '%{y} hPa: \u03b8 = %{x:.1f} K<extra></extra>',
        });
    }

    // θe profile (equivalent potential temperature)
    if (profiles.theta_e) {
        traces.push({
            x: profiles.theta_e, y: profiles.plev, type: 'scatter', mode: 'lines+markers',
            name: '\u03b8e',
            line: { color: '#ef4444', width: 2 },
            marker: { color: '#ef4444', size: 5 },
            hovertemplate: '%{y} hPa: \u03b8e = %{x:.1f} K<extra></extra>',
        });
    }

    // Fallback to plain T if no theta data
    if (!traces.length && profiles.t) {
        var tC = profiles.t.map(function(t) { return t != null ? t - 273.15 : null; });
        traces.push({
            x: tC, y: profiles.plev, type: 'scatter', mode: 'lines+markers',
            name: 'T',
            line: { color: '#ef4444', width: 2 },
            marker: { color: '#ef4444', size: 5 },
            hovertemplate: '%{y} hPa: %{x:.1f}\u00b0C<extra>Temp</extra>',
        });
    }

    if (!traces.length) return;

    var layout = {
        xaxis: { title: { text: 'K', font: { size: 9, color: '#8b9ec2' } },
            color: '#8b9ec2', tickfont: { size: 8 } },
        yaxis: { title: '', autorange: 'reversed', type: 'log', color: '#8b9ec2', tickfont: { size: 8 },
            tickvals: [1000, 850, 700, 500, 300, 200, 100] },
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(10,22,40,0.5)',
        margin: { l: 30, r: 5, t: 22, b: 30 },
        title: { text: '\u03b8 / \u03b8e Profile', font: { size: 10, color: '#00d4ff' }, x: 0.5, y: 0.98 },
        legend: { font: { color: '#ccc', size: 9 }, x: 0.02, y: 0.02, bgcolor: 'rgba(0,0,0,0.3)' },
        showlegend: true,
    };
    Plotly.newPlot(divId, traces, layout, { responsive: true, displayModeBar: false });
}

// ── Wind barb helper for Skew-T ──────────────────────────────
// Draws standard meteorological wind barbs as Plotly shape arrays.
// Each barb: staff pointing INTO the wind, feathers on left side.
// Convention: half barb = 5 kt, full barb = 10 kt, flag = 50 kt.
// ── Plan-view wind barbs (for archive plan-view plots) ───────
// Draws standard meteorological wind barbs on a Cartesian (km) grid.
// barbData = { u:[[]], v:[[]], x:[], y:[], units:'m/s', type:'storm_relative'|'earth_relative' }
// axRanges = { xMin, xMax, yMin, yMax }
// Returns array of Plotly shape objects (type:'line', xref:'x', yref:'y').
function _buildPlanViewWindBarbs(barbData, axRanges) {
    var shapes = [];
    if (!barbData || !barbData.u || !barbData.v) return shapes;

    var uGrid = barbData.u, vGrid = barbData.v;
    var xCoords = barbData.x, yCoords = barbData.y;

    var xSpan = axRanges.xMax - axRanges.xMin;
    var ySpan = axRanges.yMax - axRanges.yMin;
    var span = Math.max(xSpan, ySpan);
    if (span <= 0) return shapes;

    // Staff length in data units (km) — ~4% of axis span
    var staffLen = span * 0.04;
    var barbFrac = 0.38;    // feather length as fraction of staff
    var gapFrac  = 0.12;    // gap between feathers
    var flagWFrac = 0.38;   // flag width (50-kt pennant)
    var flagHFrac = 0.18;   // flag height along staff

    var lineColor = 'rgba(0,0,0,0.8)';
    var lineWidth = 1.4;

    function mkLine(x0, y0, x1, y1) {
        return {
            type: 'line', xref: 'x', yref: 'y',
            x0: x0, y0: y0, x1: x1, y1: y1,
            line: { color: lineColor, width: lineWidth }
        };
    }

    for (var yi = 0; yi < uGrid.length; yi++) {
        for (var xi = 0; xi < uGrid[yi].length; xi++) {
            var uMs = uGrid[yi][xi], vMs = vGrid[yi][xi];
            if (uMs === null || vMs === null) continue;

            var spdKt = Math.sqrt(uMs * uMs + vMs * vMs) * 1.944;
            if (spdKt < 2.5) continue;  // calm — skip

            var xBase = xCoords[xi], yBase = yCoords[yi];

            // Direction wind is coming FROM (meteorological convention)
            var dirRad = Math.atan2(-uMs, -vMs);
            var sinD = Math.sin(dirRad), cosD = Math.cos(dirRad);

            // Staff: tip is in the "from" direction (away from base)
            var xTip = xBase + staffLen * sinD;
            var yTip = yBase + staffLen * cosD;

            // Draw staff line
            shapes.push(mkLine(xBase, yBase, xTip, yTip));

            // Feather encoding
            var remaining = Math.round(spdKt / 5) * 5;
            var nFlags = Math.floor(remaining / 50); remaining -= nFlags * 50;
            var nFull  = Math.floor(remaining / 10); remaining -= nFull * 10;
            var nHalf  = Math.floor(remaining / 5);

            // Perpendicular (left side of staff, looking from base to tip): rotate +90°
            var perpX = cosD;
            var perpY = -sinD;

            var barbLen = staffLen * barbFrac;
            var barbGap = staffLen * gapFrac;
            var flagW   = staffLen * flagWFrac;
            var flagH   = staffLen * flagHFrac;

            var featherPos = 0;

            // 50-kt flags (triangular pennants)
            for (var fi = 0; fi < nFlags; fi++) {
                var frac = featherPos / staffLen;
                var fx  = xTip - (xTip - xBase) * frac;
                var fy  = yTip - (yTip - yBase) * frac;
                var frac2 = (featherPos + flagH) / staffLen;
                var fx2 = xTip - (xTip - xBase) * frac2;
                var fy2 = yTip - (yTip - yBase) * frac2;
                var midFrac = (featherPos + flagH * 0.5) / staffLen;
                var mx = xTip - (xTip - xBase) * midFrac;
                var my = yTip - (yTip - yBase) * midFrac;
                var outX = mx + flagW * perpX;
                var outY = my + flagW * perpY;
                shapes.push(mkLine(fx, fy, outX, outY));
                shapes.push(mkLine(outX, outY, fx2, fy2));
                featherPos += flagH + barbGap * 0.3;
            }

            // 10-kt full barbs
            for (var fb = 0; fb < nFull; fb++) {
                var frac = featherPos / staffLen;
                var bx = xTip - (xTip - xBase) * frac;
                var by = yTip - (yTip - yBase) * frac;
                shapes.push(mkLine(bx, by, bx + barbLen * perpX, by + barbLen * perpY));
                featherPos += barbGap;
            }

            // 5-kt half barbs
            for (var hb = 0; hb < nHalf; hb++) {
                var frac = featherPos / staffLen;
                var hx = xTip - (xTip - xBase) * frac;
                var hy = yTip - (yTip - yBase) * frac;
                shapes.push(mkLine(hx, hy, hx + barbLen * 0.55 * perpX, hy + barbLen * 0.55 * perpY));
                featherPos += barbGap;
            }
        }
    }
    return shapes;
}

// Set of variable keys eligible for wind barbs (wind speed variables)
// Wind barbs are now available for ALL plan-view variables.
// The backend falls back to storm-relative recentered winds for non-wind-speed vars.
var _BARB_ELIGIBLE_VARS = null;  // null = all variables eligible
var _windBarbsEnabled = false;

function toggleWindBarbs() {
    _windBarbsEnabled = !_windBarbsEnabled;
    var btn = document.getElementById('barb-btn');
    if (btn) {
        btn.classList.toggle('active', _windBarbsEnabled);
    }
    // Re-generate current plot with or without barbs
    if (currentCaseIndex !== null) {
        generateCustomPlot();
    }
}

// ── Tilt Profile overlay ──────────────────────────────────────
var _tiltProfileEnabled = false;

function toggleTiltProfile() {
    _tiltProfileEnabled = !_tiltProfileEnabled;
    var btn = document.getElementById('tilt-btn');
    if (btn) {
        btn.classList.toggle('active', _tiltProfileEnabled);
        if (_tiltProfileEnabled) {
            // keep for backward compat — no-op since pills handle via CSS
        } else {
            btn.style.color = '';
        }
    }
    // Re-generate current plot with or without tilt profile
    if (currentCaseIndex !== null) {
        generateCustomPlot();
    }
}

/**
 * Build a Plotly scatter trace showing the vortex tilt profile on a plan-view plot.
 * Each marker represents the vortex center at a given height, colored by height.
 * @param {Object} tiltData - { x_km, y_km, height_km, tilt_magnitude_km, ref_height_km }
 * @returns {Object} Plotly scatter trace
 */
function _buildTiltProfileTrace(tiltData) {
    var x = [], y = [], colors = [], texts = [], sizes = [];
    var refH = tiltData.ref_height_km || 2.0;
    for (var i = 0; i < tiltData.height_km.length; i++) {
        if (tiltData.x_km[i] === null || tiltData.y_km[i] === null) continue;
        var h = tiltData.height_km[i];
        var tiltMag = tiltData.tilt_magnitude_km[i];
        x.push(tiltData.x_km[i]);
        y.push(tiltData.y_km[i]);
        colors.push(h);
        sizes.push(h === refH ? 12 : 8);
        var hoverText = '<b>Tilt Profile</b><br>' +
            'Height: ' + h.toFixed(1) + ' km<br>' +
            'X: ' + tiltData.x_km[i].toFixed(1) + ' km<br>' +
            'Y: ' + tiltData.y_km[i].toFixed(1) + ' km';
        if (tiltMag !== null) hoverText += '<br>Tilt from ' + refH.toFixed(1) + ' km: ' + tiltMag.toFixed(1) + ' km';
        if (tiltData.rmw_km && tiltData.rmw_km[i] !== null) hoverText += '<br>RMW: ' + tiltData.rmw_km[i].toFixed(1) + ' km';
        texts.push(hoverText);
    }
    if (x.length === 0) return null;

    // Build line trace connecting the centers (the tilt profile "path")
    var lineTrace = {
        x: x, y: y,
        type: 'scatter', mode: 'lines',
        line: { color: 'rgba(255,255,255,0.4)', width: 1.5, dash: 'dot' },
        hoverinfo: 'skip', showlegend: false
    };
    // Build scatter trace with markers colored by height
    var scatterTrace = {
        x: x, y: y,
        type: 'scatter', mode: 'markers',
        marker: {
            size: sizes,
            color: colors,
            colorscale: 'Viridis',
            cmin: 0, cmax: 14,
            colorbar: {
                title: { text: 'Tilt Height (km)', font: { color: '#ccc', size: 9 } },
                tickfont: { color: '#ccc', size: 8 },
                thickness: 10, len: 0.30,
                x: 1.01, xpad: 2, y: 0.02,
                yanchor: 'bottom',
                outlinewidth: 0
            },
            line: { color: 'rgba(255,255,255,0.8)', width: 1.2 }
        },
        text: texts,
        hovertemplate: '%{text}<extra></extra>',
        showlegend: false
    };
    return { line: lineTrace, scatter: scatterTrace };
}

//
// Works in paper-normalised space internally so barbs are
// aspect-ratio-independent, then converts back to data coords for Plotly.
// axRanges = { xMin, xMax, logPMin, logPMax } (logPMin > logPMax because
// the y-axis is reversed: bottom of plot = high pressure).
function _buildWindBarbShapes(u, v, plev, xPos, staffLen, axRanges) {
    var shapes = [];
    if (!u || !v) return shapes;

    // ── Coordinate helpers: data ↔ paper [0,1] ──────────────
    var xMin = axRanges.xMin, xMax = axRanges.xMax;
    var logPMin = axRanges.logPMin, logPMax = axRanges.logPMax;
    var xSpan = xMax - xMin;                    // e.g. 120 (temp units)
    var logPSpan = logPMin - logPMax;            // positive, ~1.02

    // paper x: 0 = left, 1 = right
    function xToPaper(x) { return (x - xMin) / xSpan; }
    // paper y: 0 = bottom (high P), 1 = top (low P) — matches Plotly paper y
    function logPToPaper(lp) { return (logPMin - lp) / logPSpan; }
    // inverse
    function paperToX(px) { return xMin + px * xSpan; }
    function paperToLogP(py) { return logPMin - py * logPSpan; }

    var barbLevels = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650,
                      600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];

    // Staff size in paper units — visually constant regardless of plot stretch.
    // Use a fixed fraction of plot height (~4.5% of the vertical extent).
    var staffPaper = 0.045;
    var barbFrac   = 0.38;
    var gapFrac    = 0.12;
    var flagWFrac  = 0.38;
    var flagHFrac  = 0.18;
    var lineColor  = 'rgba(220,220,240,0.85)';
    var lineWidth  = 1.4;

    for (var bi = 0; bi < barbLevels.length; bi++) {
        var pTarget = barbLevels[bi];
        var bestIdx = -1, bestDist = 1e9;
        for (var pi = 0; pi < plev.length; pi++) {
            if (u[pi] == null || v[pi] == null) continue;
            var d = Math.abs(plev[pi] - pTarget);
            if (d < bestDist) { bestDist = d; bestIdx = pi; }
        }
        if (bestIdx < 0 || bestDist > 15) continue;

        var uMs = u[bestIdx], vMs = v[bestIdx];
        var spdKt = Math.sqrt(uMs * uMs + vMs * vMs) * 1.944;
        if (spdKt < 2.5) continue;

        // Direction wind is coming FROM
        var dirRad = Math.atan2(-uMs, -vMs);
        var cosD = Math.cos(dirRad), sinD = Math.sin(dirRad);

        // Base position in paper coords
        var pxBase = xToPaper(xPos);
        var pyBase = logPToPaper(Math.log10(pTarget));

        // Staff tip — sinD is x-component, cosD is y-component (north = up)
        var pxTip = pxBase + staffPaper * sinD;
        var pyTip = pyBase + staffPaper * cosD;

        // Helper: paper → data for Plotly shape
        function mkLine(px0, py0, px1, py1) {
            return {
                type: 'line', xref: 'x', yref: 'y',
                x0: paperToX(px0), y0: Math.pow(10, paperToLogP(py0)),
                x1: paperToX(px1), y1: Math.pow(10, paperToLogP(py1)),
                line: { color: lineColor, width: lineWidth },
            };
        }

        shapes.push(mkLine(pxBase, pyBase, pxTip, pyTip));

        // Feather encoding
        var remaining = Math.round(spdKt / 5) * 5;
        var nFlags = Math.floor(remaining / 50); remaining -= nFlags * 50;
        var nFull  = Math.floor(remaining / 10); remaining -= nFull * 10;
        var nHalf  = Math.floor(remaining / 5);

        // Perpendicular to staff (left side): rotate +90°
        var perpPx = cosD;
        var perpPy = -sinD;

        var featherPos = 0;
        var barbLen = staffPaper * barbFrac;
        var barbGap = staffPaper * gapFrac;
        var flagW   = staffPaper * flagWFrac;
        var flagH   = staffPaper * flagHFrac;

        for (var fi = 0; fi < nFlags; fi++) {
            var frac  = featherPos / staffPaper;
            var fx  = pxTip - (pxTip - pxBase) * frac;
            var fy  = pyTip - (pyTip - pyBase) * frac;
            var frac2 = (featherPos + flagH) / staffPaper;
            var fx2 = pxTip - (pxTip - pxBase) * frac2;
            var fy2 = pyTip - (pyTip - pyBase) * frac2;
            var midFrac = (featherPos + flagH * 0.5) / staffPaper;
            var mx = pxTip - (pxTip - pxBase) * midFrac;
            var my = pyTip - (pyTip - pyBase) * midFrac;
            var outX = mx + flagW * perpPx;
            var outY = my + flagW * perpPy;
            shapes.push(mkLine(fx, fy, outX, outY));
            shapes.push(mkLine(outX, outY, fx2, fy2));
            featherPos += flagH + barbGap * 0.3;
        }

        for (var fb = 0; fb < nFull; fb++) {
            var frac = featherPos / staffPaper;
            var bx = pxTip - (pxTip - pxBase) * frac;
            var by = pyTip - (pyTip - pyBase) * frac;
            shapes.push(mkLine(bx, by, bx + barbLen * perpPx, by + barbLen * perpPy));
            featherPos += barbGap;
        }

        for (var hb = 0; hb < nHalf; hb++) {
            var frac = featherPos / staffPaper;
            var hx = pxTip - (pxTip - pxBase) * frac;
            var hy = pyTip - (pyTip - pyBase) * frac;
            shapes.push(mkLine(hx, hy, hx + barbLen * 0.55 * perpPx, hy + barbLen * 0.55 * perpPy));
            featherPos += barbGap;
        }
    }
    return shapes;
}

// ── Skew-T / Log-P Diagram ────────────────────────────────────
function renderSkewT(profiles, divId) {
    var el = document.getElementById(divId);
    if (!el || !profiles || !profiles.t || !profiles.plev) return;

    var plev = profiles.plev;
    var tK = profiles.t;
    var qRaw = profiles.q;

    // Convert T from K to °C
    var tC = tK.map(function(v) { return v != null ? v - 273.15 : null; });

    // Detect q units: if max(q) > 0.5 it's g/kg, otherwise already kg/kg
    var maxQ = 0;
    if (qRaw) {
        for (var qi = 0; qi < qRaw.length; qi++) {
            if (qRaw[qi] != null && qRaw[qi] > maxQ) maxQ = qRaw[qi];
        }
    }
    var qIsGkg = maxQ > 0.5;

    // Compute dewpoint from specific humidity and pressure
    // Cap vapor pressure at saturation (annular averaging can produce q > q_sat)
    var tdC = [];
    for (var i = 0; i < plev.length; i++) {
        if (qRaw && qRaw[i] != null && plev[i] != null && qRaw[i] > 0) {
            var qKg = qIsGkg ? qRaw[i] / 1000.0 : qRaw[i];
            var e = qKg * plev[i] / (0.622 + 0.378 * qKg);
            // Prevent supersaturation: cap e at saturation vapor pressure
            if (tC[i] != null) {
                var esSfc = 6.112 * Math.exp(17.67 * tC[i] / (tC[i] + 243.5));
                if (e > esSfc) e = esSfc;
            }
            if (e > 0.001) {
                var lnE = Math.log(e / 6.112);
                tdC.push(243.5 * lnE / (17.67 - lnE));
            } else { tdC.push(null); }
        } else { tdC.push(null); }
    }

    // ── Thermodynamic helper functions ──
    var Rd = 287.04, Rv = 461.5, Cp = 1005.7, Lv = 2.501e6, g = 9.81, eps = 0.622;

    function satVaporPres(tCelsius) {
        return 6.112 * Math.exp(17.67 * tCelsius / (tCelsius + 243.5));
    }
    function satMixRatio(tCelsius, pHpa) {
        var es = satVaporPres(tCelsius);
        return es > pHpa ? 0.04 : eps * es / (pHpa - es);
    }
    function moistLapseRate(tCelsius, pHpa) {
        var tKel = tCelsius + 273.15;
        var rs = satMixRatio(tCelsius, pHpa);
        var num = (Rd * tKel / pHpa) + (Lv * rs / pHpa);
        var den = Cp + (Lv * Lv * rs * eps / (Rd * tKel * tKel));
        return num / den;
    }
    // Lift parcel moist-adiabatically from startP to endP (endP < startP)
    function liftMoist(tStart, pStart, pEnd) {
        var t = tStart, p = pStart, dp = 2;
        while (p > pEnd) {
            var step = Math.min(dp, p - pEnd);
            t -= moistLapseRate(t, p) * step;
            p -= step;
        }
        return t;
    }

    // ── Conventional skew: ~45° tilt across the diagram ──
    // With log-P y-axis spanning ~1 decade (100–1000 hPa) and a typical
    // chart aspect ratio (~500×400 px), a skewFactor of ~70 gives the
    // classic ~45° isotherms.
    var skewFactor = 70;
    var pRef = 1000;

    function skewX(tempC, pHpa) {
        if (tempC == null || pHpa == null) return null;
        return tempC + skewFactor * Math.log10(pRef / pHpa);
    }

    // ── Compute derived quantities (store on profiles for info panel) ──
    // Find surface = highest-pressure level with valid T and Td
    // (robust to either top-down or bottom-up plev ordering)
    var sfcIdx = -1;
    var maxPressure = -1;
    for (var si = 0; si < plev.length; si++) {
        if (tC[si] != null && tdC[si] != null && plev[si] > maxPressure) {
            maxPressure = plev[si];
            sfcIdx = si;
        }
    }

    // Build a list of level indices sorted by DECREASING pressure (sfc → top)
    var sortedIdx = [];
    for (var sii = 0; sii < plev.length; sii++) sortedIdx.push(sii);
    sortedIdx.sort(function(a, b) { return plev[b] - plev[a]; });

    var derived = { cape: null, cin: null, pwat: null, lcl_p: null, lfc_p: null, el_p: null, freezing_p: null };

    if (sfcIdx >= 0) {
        var sfcT = tC[sfcIdx], sfcTd = tdC[sfcIdx], sfcP = plev[sfcIdx];

        // Mixed-layer averages (lowest 100 hPa)
        var mlDepth = 100, mlTsum = 0, mlTdSum = 0, mlN = 0;
        for (var mi = 0; mi < plev.length; mi++) {
            if (plev[mi] <= sfcP && plev[mi] >= sfcP - mlDepth) {
                if (tC[mi] != null && tdC[mi] != null) {
                    mlTsum += tC[mi]; mlTdSum += tdC[mi]; mlN++;
                }
            }
        }
        var mlT = mlN > 0 ? mlTsum / mlN : sfcT;
        var mlTd = mlN > 0 ? mlTdSum / mlN : sfcTd;

        // Surface parcel mixing ratio (conserved during dry lift below LCL)
        var sfcMixR = satMixRatio(mlTd, sfcP);

        // LCL via iterative dry lift until T == Td
        var lclP = sfcP, lclT = mlT, lclTd = mlTd;
        while (lclP > 100) {
            if (lclT <= lclTd + 0.1) break;
            lclP -= 2;
            lclT = (mlT + 273.15) * Math.pow(lclP / sfcP, 0.286) - 273.15;
            // Dewpoint tracks constant mixing ratio under dry lift
            var eNew = sfcMixR * lclP / (eps + sfcMixR);
            if (eNew > 0.001) {
                var lnEN = Math.log(eNew / 6.112);
                lclTd = 243.5 * lnEN / (17.67 - lnEN);
            }
        }
        derived.lcl_p = lclP;

        // Lift moist from LCL upward → build parcel profile, compute CAPE & CIN
        // Use pressure-based integration: CAPE = Rd * Σ (Tv_p − Tv_e) × ln(p_lo/p_hi)
        var parcelT = []; // parcel temperature at each plev
        var cape = 0, cin = 0, lfcP = null, elP = null, foundLFC = false;
        for (var pi = 0; pi < plev.length; pi++) {
            var pp = plev[pi];
            if (pp > sfcP) { parcelT.push(null); continue; }
            if (pp >= lclP) {
                // Dry adiabatic lift from surface
                parcelT.push((mlT + 273.15) * Math.pow(pp / sfcP, 0.286) - 273.15);
            } else {
                // Moist adiabatic lift from LCL
                parcelT.push(liftMoist(lclT, lclP, pp));
            }
        }

        // Buoyancy integration along sorted levels (surface → top)
        for (var sk = 0; sk < sortedIdx.length; sk++) {
            var li = sortedIdx[sk];
            var pp = plev[li];
            if (pp >= sfcP || tC[li] == null || parcelT[li] == null) continue;

            // Environment virtual temperature
            var envW = satMixRatio(tdC[li] != null ? tdC[li] : tC[li] - 30, pp);
            var envTv = (tC[li] + 273.15) * (1 + 0.61 * envW);
            // Parcel virtual temperature: use actual w below LCL, sat w above
            var parW = (pp >= lclP) ? sfcMixR : satMixRatio(parcelT[li], pp);
            var parTv = (parcelT[li] + 273.15) * (1 + 0.61 * parW);

            // Pressure-layer bounds from sorted neighbors
            var pAbove = (sk + 1 < sortedIdx.length) ? plev[sortedIdx[sk + 1]] : pp;
            var pBelow = (sk > 0) ? plev[sortedIdx[sk - 1]] : sfcP;
            // Half-layers on each side
            var pLo = 0.5 * (pp + pBelow);
            var pHi = 0.5 * (pp + pAbove);
            if (pLo <= pHi || pHi <= 0) continue;
            var dlnP = Math.log(pLo / pHi);

            var dCape = Rd * (parTv - envTv) * dlnP;
            if (dCape > 0) {
                cape += dCape;
                if (!foundLFC) { lfcP = pp; foundLFC = true; }
                elP = pp;
            } else if (!foundLFC && pp < lclP) {
                cin += dCape;
            }
        }
        derived.cape = cape > 0 ? Math.round(cape) : 0;
        derived.cin = cin < 0 ? Math.round(cin) : 0;
        derived.lfc_p = lfcP;
        derived.el_p = elP;

        // Total Precipitable Water: PWAT = (1/g) * ∫ q dp
        var pwat = 0;
        for (var pw = 0; pw < plev.length - 1; pw++) {
            if (qRaw && qRaw[pw] != null && qRaw[pw+1] != null) {
                var q1 = qIsGkg ? qRaw[pw] / 1000.0 : qRaw[pw];
                var q2 = qIsGkg ? qRaw[pw+1] / 1000.0 : qRaw[pw+1];
                var dpp = Math.abs(plev[pw] - plev[pw+1]) * 100; // Pa
                pwat += 0.5 * (q1 + q2) * dpp / g;
            }
        }
        derived.pwat = pwat > 0 ? pwat : null; // kg/m² ≈ mm

        // 0°C level
        for (var fk = 0; fk < plev.length - 1; fk++) {
            if (tC[fk] != null && tC[fk+1] != null && tC[fk] > 0 && tC[fk+1] <= 0) {
                var frac = tC[fk] / (tC[fk] - tC[fk+1]);
                derived.freezing_p = plev[fk] + frac * (plev[fk+1] - plev[fk]);
                break;
            }
        }
    }

    // Store derived quantities for the info panel
    profiles._derived = derived;
    profiles._parcelT = (typeof parcelT !== 'undefined') ? parcelT : null;
    profiles._tC = tC;
    profiles._tdC = tdC;

    // Compute skewed coordinates
    var tSkew = [], tdSkew = [];
    for (var j = 0; j < plev.length; j++) {
        tSkew.push(skewX(tC[j], plev[j]));
        tdSkew.push(skewX(tdC[j], plev[j]));
    }

    // ── Background reference lines ──
    var pRange = [];
    for (var pp2 = 1050; pp2 >= 100; pp2 -= 5) pRange.push(pp2);

    // Isotherms
    var isothermTraces = [];
    for (var tIso = -80; tIso <= 50; tIso += 10) {
        var xIso = [], yIso = [];
        pRange.forEach(function(p) {
            var sx = skewX(tIso, p);
            if (sx >= -70 && sx <= 120) { xIso.push(sx); yIso.push(p); }
        });
        if (xIso.length > 1) {
            isothermTraces.push({
                x: xIso, y: yIso, type: 'scatter', mode: 'lines',
                line: { color: tIso === 0 ? 'rgba(100,200,255,0.5)' : 'rgba(100,160,220,0.25)',
                        width: tIso === 0 ? 1.3 : 0.7,
                        dash: tIso === 0 ? 'dot' : 'solid' },
                showlegend: false, hoverinfo: 'skip',
            });
        }
    }

    // Dry adiabats
    var dryAdiabatTraces = [];
    var thetaVals = [-30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 100, 120, 150];
    thetaVals.forEach(function(theta) {
        var xDry = [], yDry = [];
        var thetaK = theta + 273.15;
        pRange.forEach(function(p) {
            var tAtP = thetaK * Math.pow(p / 1000.0, 0.286) - 273.15;
            var sx = skewX(tAtP, p);
            if (sx >= -70 && sx <= 120) { xDry.push(sx); yDry.push(p); }
        });
        if (xDry.length > 1) {
            dryAdiabatTraces.push({
                x: xDry, y: yDry, type: 'scatter', mode: 'lines',
                line: { color: 'rgba(200,120,80,0.22)', width: 0.8 },
                showlegend: false, hoverinfo: 'skip',
            });
        }
    });

    // Moist adiabats (Bolton 1980 pseudoadiabat)
    var moistAdiabatTraces = [];
    var moistThetaVals = [-10, 0, 6, 10, 14, 18, 22, 26, 30, 34, 38];
    moistThetaVals.forEach(function(tBase) {
        var xMoist = [], yMoist = [];
        var tCur = tBase;
        for (var p = 1000; p >= 100; p -= 5) {
            var sx = skewX(tCur, p);
            if (sx >= -70 && sx <= 120) { xMoist.push(sx); yMoist.push(p); }
            tCur -= moistLapseRate(tCur, p) * 5;
        }
        if (xMoist.length > 2) {
            moistAdiabatTraces.push({
                x: xMoist, y: yMoist, type: 'scatter', mode: 'lines',
                line: { color: 'rgba(80,200,120,0.22)', width: 0.8, dash: 'dot' },
                showlegend: false, hoverinfo: 'skip',
            });
        }
    });

    // Mixing ratio lines (constant w, in g/kg)
    var mixRatioTraces = [];
    var wVals = [0.4, 1, 2, 4, 7, 10, 16, 24];
    wVals.forEach(function(wGkg) {
        var w = wGkg / 1000.0;
        var xMix = [], yMix = [];
        pRange.forEach(function(p) {
            // e = w * p / (eps + w); T from inverted Clausius-Clapeyron
            var eMix = w * p / (eps + w);
            if (eMix > 0.001 && eMix < p) {
                var lnEM = Math.log(eMix / 6.112);
                var tMix = 243.5 * lnEM / (17.67 - lnEM);
                var sx = skewX(tMix, p);
                if (sx >= -70 && sx <= 120 && tMix > -50 && tMix < 50) {
                    xMix.push(sx); yMix.push(p);
                }
            }
        });
        if (xMix.length > 2) {
            mixRatioTraces.push({
                x: xMix, y: yMix, type: 'scatter', mode: 'lines',
                line: { color: 'rgba(160,120,200,0.2)', width: 0.6, dash: 'dash' },
                showlegend: false, hoverinfo: 'skip',
            });
        }
    });

    // ── Main data traces ──
    var traces = [];
    traces = traces.concat(isothermTraces, dryAdiabatTraces, moistAdiabatTraces, mixRatioTraces);

    // CAPE / CIN shading between parcel and environment
    if (profiles._parcelT && derived.cape > 0) {
        // Positive buoyancy (CAPE) shading
        var capeX = [], capeY = [], cinX = [], cinY = [];
        for (var ci = 0; ci < plev.length; ci++) {
            if (profiles._parcelT[ci] != null && tC[ci] != null && plev[ci] <= (sfcP || 1050)) {
                var pTv = profiles._parcelT[ci], eTv = tC[ci];
                if (pTv > eTv) {
                    // Positive buoyancy
                    capeX.push(skewX(pTv, plev[ci]));
                    capeX.push(skewX(eTv, plev[ci]));
                    capeY.push(plev[ci]);
                    capeY.push(plev[ci]);
                }
            }
        }
        // Build polygon for CAPE region (between LFC and EL)
        if (derived.lfc_p && derived.el_p) {
            var capeFwdX = [], capeFwdY = [], capeRevX = [], capeRevY = [];
            for (var cci = 0; cci < plev.length; cci++) {
                if (profiles._parcelT[cci] != null && tC[cci] != null &&
                    plev[cci] <= derived.lfc_p && plev[cci] >= derived.el_p) {
                    capeFwdX.push(skewX(profiles._parcelT[cci], plev[cci]));
                    capeFwdY.push(plev[cci]);
                    capeRevX.unshift(skewX(tC[cci], plev[cci]));
                    capeRevY.unshift(plev[cci]);
                }
            }
            if (capeFwdX.length > 1) {
                traces.push({
                    x: capeFwdX.concat(capeRevX), y: capeFwdY.concat(capeRevY),
                    type: 'scatter', mode: 'lines', fill: 'toself',
                    fillcolor: 'rgba(239,68,68,0.12)', line: { color: 'transparent' },
                    showlegend: false, hoverinfo: 'skip',
                });
            }
        }
        // CIN region (between LCL and LFC)
        if (derived.lcl_p && derived.lfc_p && derived.lcl_p > derived.lfc_p) {
            var cinFwdX = [], cinFwdY = [], cinRevX2 = [], cinRevY2 = [];
            for (var cni = 0; cni < plev.length; cni++) {
                if (profiles._parcelT[cni] != null && tC[cni] != null &&
                    plev[cni] <= derived.lcl_p && plev[cni] >= derived.lfc_p &&
                    profiles._parcelT[cni] < tC[cni]) {
                    cinFwdX.push(skewX(profiles._parcelT[cni], plev[cni]));
                    cinFwdY.push(plev[cni]);
                    cinRevX2.unshift(skewX(tC[cni], plev[cni]));
                    cinRevY2.unshift(plev[cni]);
                }
            }
            if (cinFwdX.length > 1) {
                traces.push({
                    x: cinFwdX.concat(cinRevX2), y: cinFwdY.concat(cinRevY2),
                    type: 'scatter', mode: 'lines', fill: 'toself',
                    fillcolor: 'rgba(96,165,250,0.12)', line: { color: 'transparent' },
                    showlegend: false, hoverinfo: 'skip',
                });
            }
        }
    }

    // Dewpoint trace (green)
    traces.push({
        x: tdSkew, y: plev, type: 'scatter', mode: 'lines',
        name: 'Td', line: { color: '#22c55e', width: 2.5 },
        hovertemplate: '%{text}<extra>Dewpoint</extra>',
        text: plev.map(function(p, idx) {
            return p + ' hPa: Td = ' + (tdC[idx] != null ? tdC[idx].toFixed(1) : '\u2014') + '\u00b0C';
        }),
    });

    // Temperature trace (red)
    traces.push({
        x: tSkew, y: plev, type: 'scatter', mode: 'lines',
        name: 'T', line: { color: '#ef4444', width: 2.5 },
        hovertemplate: '%{text}<extra>Temperature</extra>',
        text: plev.map(function(p, idx) {
            return p + ' hPa: T = ' + (tC[idx] != null ? tC[idx].toFixed(1) : '\u2014') + '\u00b0C';
        }),
    });

    // Parcel path (dashed purple)
    if (profiles._parcelT) {
        var parcelSkew = profiles._parcelT.map(function(t, idx) {
            return t != null ? skewX(t, plev[idx]) : null;
        });
        traces.push({
            x: parcelSkew, y: plev, type: 'scatter', mode: 'lines',
            name: 'Parcel', line: { color: '#c084fc', width: 1.8, dash: 'dash' },
            hovertemplate: '%{text}<extra>Parcel</extra>',
            text: plev.map(function(p, idx) {
                return p + ' hPa: Tp = ' + (profiles._parcelT[idx] != null ? profiles._parcelT[idx].toFixed(1) : '\u2014') + '\u00b0C';
            }),
        });
    }

    // ── Axis labels ──
    var xTickVals = [], xTickText = [];
    for (var tTick = -40; tTick <= 50; tTick += 10) {
        xTickVals.push(skewX(tTick, 1000));
        xTickText.push(tTick + '\u00b0C');
    }

    // ── Wind barbs (right side of diagram) ──
    var hasWind = profiles.u && profiles.v && profiles.u.length > 0;
    var barbXPos = 68;    // x-position for barb base (right edge of plot area)
    var barbShapes = [];
    var windAnnotations = [];
    var xRangeMax = hasWind ? 80 : 70;
    var skewTAxRanges = {
        xMin: -40, xMax: xRangeMax,
        logPMin: Math.log10(1050), logPMax: Math.log10(100),
    };
    if (hasWind) {
        barbShapes = _buildWindBarbShapes(profiles.u, profiles.v, plev, barbXPos, 5.5, skewTAxRanges);
        // Add a thin vertical line to separate barbs from the diagram
        barbShapes.push({
            type: 'line', xref: 'x', yref: 'y',
            x0: barbXPos - 2, y0: 1050, x1: barbXPos - 2, y1: 100,
            line: { color: 'rgba(255,255,255,0.08)', width: 0.5 },
        });
    }

    var layout = {
        xaxis: {
            title: { text: 'Temperature (\u00b0C)', font: { size: 9, color: '#8b9ec2' } },
            range: [-40, xRangeMax],
            tickvals: xTickVals, ticktext: xTickText,
            color: '#8b9ec2', tickfont: { size: 8 },
            zeroline: false, gridcolor: 'rgba(255,255,255,0.03)',
            showgrid: false,
        },
        yaxis: {
            title: { text: 'Pressure (hPa)', font: { size: 9, color: '#8b9ec2' } },
            autorange: false, type: 'log',
            range: [Math.log10(1050), Math.log10(100)],
            color: '#8b9ec2', tickfont: { size: 8 },
            tickvals: [1000, 850, 700, 500, 400, 300, 200, 150, 100],
            dtick: null,
            zeroline: false, gridcolor: 'rgba(255,255,255,0.06)',
        },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(10,22,40,0.5)',
        margin: { l: 45, r: 10, t: 22, b: 35 },
        title: { text: 'Skew-T / Log-P', font: { size: 10, color: '#00d4ff' }, x: 0.5, y: 0.98 },
        legend: { font: { color: '#ccc', size: 9 }, x: 0.68, y: 0.98, bgcolor: 'rgba(0,0,0,0.4)' },
        showlegend: true,
        shapes: barbShapes,
    };
    Plotly.newPlot(divId, traces, layout, { responsive: true, displayModeBar: false });
}

// ── Skew-T sounding fetch with configurable radius ──────────
function fetchSkewTSounding(caseIdx, radiusKm, callback) {
    var url = API_BASE + '/era5_sounding?case_index=' + caseIdx + '&radius_km=' + radiusKm + '&data_type=' + _activeDataType;
    fetch(url)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) { if (callback) callback(data); })
        .catch(function() { if (callback) callback(null); });
}

// ══════════════════════════════════════════════════════════════
// Environment Overlay Panel (full-screen ERA5 dashboard)
// ══════════════════════════════════════════════════════════════
var _envOverlayInit = false;
var _envOverlayField = 'shear_mag';
var _envOverlayCropKm = 500;
var _envOverlayData = null;  // separate ERA5 data for the overlay

function initEnvOverlay() {
    if (_envOverlayInit) return;
    _envOverlayInit = true;
    var overlay = document.createElement('div');
    overlay.id = 'env-overlay';
    overlay.className = 'env-overlay';
    overlay.innerHTML =
        '<div class="env-box">' +
            '<div class="env-ov-header">' +
                '<div class="env-ov-header-left">' +
                    '<span class="env-ov-logo">\uD83C\uDF21</span> ' +
                    '<span class="env-ov-title">Environmental Context</span>' +
                    '<span class="env-ov-subtitle">ERA5 Reanalysis Diagnostics</span>' +
                '</div>' +
                '<div class="env-nav-bar" id="env-nav-bar">' +
                    '<button class="env-nav-btn" id="env-nav-prev" onclick="envNavPrev()" title="Previous case">\u25C0</button>' +
                    '<select class="env-nav-select" id="env-nav-select" onchange="envNavJump(this.value)"></select>' +
                    '<button class="env-nav-btn" id="env-nav-next" onclick="envNavNext()" title="Next case">\u25B6</button>' +
                '</div>' +
                '<button class="env-ov-close" onclick="toggleEnvOverlay()">\u2715</button>' +
            '</div>' +
            '<div class="env-ov-body">' +
                // ── Left: Controls ──
                '<div class="env-ov-controls">' +
                    '<div id="env-ov-case-info" class="env-case-info" style="display:none;"></div>' +
                    '<div class="env-section-title">\uD83C\uDF0D 2D Field Display</div>' +
                    '<div class="env-ctrl-row"><label>Field</label>' +
                        '<select class="env-ctrl-select" id="env-ov-field" onchange="envOverlayChangeField(this.value)">' +
                            '<option value="shear_mag">Deep-Layer Shear (200\u2013850 hPa)</option>' +
                            '<option value="rh_mid">Mid-Level RH (500\u2013700 hPa)</option>' +
                            '<option value="div200">200 hPa Divergence</option>' +
                            '<option value="sst">Sea Surface Temperature</option>' +
                            '<option value="entropy_def">Entropy Deficit (\u03c7\u2098)</option>' +
                        '</select>' +
                    '</div>' +
                    '<div class="env-ctrl-row"><label>Crop Radius</label>' +
                        '<div class="env-slider-row">' +
                            '<input type="range" id="env-ov-radius" min="100" max="1000" step="50" value="500" oninput="envOverlayRadiusChange(this.value)">' +
                            '<span class="env-slider-val" id="env-ov-radius-val">500 km</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="env-section-title" style="margin-top:18px;">\uD83D\uDCCA Scalar Domain</div>' +
                    '<div class="env-ctrl-row"><label>Inner Radius</label>' +
                        '<div class="env-slider-row">' +
                            '<input type="range" id="env-ov-inner" min="0" max="600" step="50" value="200" oninput="document.getElementById(\'env-ov-inner-val\').textContent=this.value+\' km\'">' +
                            '<span class="env-slider-val" id="env-ov-inner-val">200 km</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="env-ctrl-row"><label>Outer Radius</label>' +
                        '<div class="env-slider-row">' +
                            '<input type="range" id="env-ov-outer" min="200" max="1200" step="50" value="800" oninput="document.getElementById(\'env-ov-outer-val\').textContent=this.value+\' km\'">' +
                            '<span class="env-slider-val" id="env-ov-outer-val">800 km</span>' +
                        '</div>' +
                    '</div>' +
                    '<button class="env-recompute-btn" id="env-ov-recompute" onclick="envOverlayRecomputeScalars()" disabled>Recompute Scalars</button>' +
                    '<div class="env-section-title" style="margin-top:18px;">\uD83C\uDF21 Skew-T Sounding</div>' +
                    '<div class="env-ctrl-row"><label>Averaging Radius</label>' +
                        '<div class="env-slider-row">' +
                            '<input type="range" id="env-ov-skewt-radius" min="50" max="800" step="50" value="200" oninput="envOverlaySkewTRadiusChange(this.value)">' +
                            '<span class="env-slider-val" id="env-ov-skewt-radius-val">200 km</span>' +
                        '</div>' +
                    '</div>' +
                    '<button class="env-recompute-btn" id="env-ov-skewt-btn" onclick="envOverlayRecomputeSkewT()" disabled>Generate Skew-T</button>' +
                    '<div class="env-domain-note" style="margin-top:12px;">' +
                        '<strong>Precomputed domains:</strong><br>' +
                        'Profiles/Skew-T: 200\u2013600 km annulus<br>' +
                        'Shear: 200\u2013800 km annulus<br>' +
                        'Thermo (RH, div, SST): 0\u2013500 km disc<br>' +
                        '\u03c7\u2098: inner 0\u2013100 km, env 100\u2013300 km<br>' +
                        'PI: 100\u2013300 km environment' +
                    '</div>' +
                '</div>' +
                // ── Right: Display area ──
                '<div class="env-ov-display" id="env-ov-display">' +
                    '<div class="env-no-case" id="env-ov-placeholder">' +
                        '<div class="env-no-case-icon">\uD83C\uDF0D</div>' +
                        '<div class="env-no-case-msg">Select a TC-RADAR case from the map and click <strong>Explore \u2192</strong> to load ERA5 environmental diagnostics.</div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    document.body.appendChild(overlay);

    // Close on ESC
    overlay.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') toggleEnvOverlay();
    });
    // Close on backdrop click
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) toggleEnvOverlay();
    });
}

function toggleEnvOverlay() {
    gtag('event', 'tab_click', { tab_name: 'environment_era5' });
    // Ensure Plotly is loaded for ERA5 visualizations
    if (typeof Plotly === 'undefined') {
        ensurePlotly(function() { toggleEnvOverlay(); });
        return;
    }
    initEnvOverlay();
    var panel = document.getElementById('env-overlay');
    panel.classList.toggle('active');
    if (!panel.classList.contains('active')) return;

    // Determine which case to show
    var caseIdx = currentCaseIndex;
    var caseData = currentCaseData;

    // If no case is actively explored, check the dropdown
    if (caseIdx === null || caseIdx === undefined) {
        var caseSelect = document.getElementById('case-select');
        if (caseSelect && caseSelect.value) {
            caseIdx = parseInt(caseSelect.value);
            if (!isNaN(caseIdx) && _getActiveData()) {
                caseData = _getActiveData().cases.find(function(c) { return c.case_index === caseIdx; });
                // Set globals so the overlay can reference them
                currentCaseIndex = caseIdx;
                currentCaseData = caseData || null;
            } else {
                caseIdx = null;
            }
        }
    }

    // Case 1: No case selected at all — show placeholder
    if (caseIdx === null || caseIdx === undefined) {
        _envOverlayData = null;
        renderEnvOverlay();
        return;
    }

    // Case 2: ERA5 data already loaded from the explorer
    if (_era5Data && _era5Data.case_index === caseIdx) {
        var radiusKm = parseInt(document.getElementById('env-ov-radius').value) || 500;
        if (radiusKm !== 300) {
            _envOverlayFetchAndRender(caseIdx, radiusKm);
        } else {
            _envOverlayData = _era5Data;
            renderEnvOverlay();
        }
        return;
    }

    // Case 3: Case selected but no ERA5 data yet — fetch it
    _envOverlayShowLoading();
    var radiusKm2 = parseInt(document.getElementById('env-ov-radius').value) || 500;
    _envOverlayFetchAndRender(caseIdx, radiusKm2);
}

function _envOverlayShowLoading() {
    _envNavPopulate();
    var display = document.getElementById('env-ov-display');
    if (!display) return;
    display.innerHTML =
        '<div class="env-no-case" style="display:flex;">' +
            '<div class="env-loading-spinner"></div>' +
            '<div class="env-no-case-msg" style="animation:envPulse 2s ease-in-out infinite;">Loading ERA5 environmental data\u2026</div>' +
        '</div>';
    // Update case info in the controls
    var caseInfo = document.getElementById('env-ov-case-info');
    if (caseInfo && currentCaseData) {
        caseInfo.style.display = 'block';
        var cd = currentCaseData;
        caseInfo.innerHTML =
            '<div class="env-case-name">' + (cd.storm_name || 'Unknown') + '</div>' +
            '<div class="env-case-detail">' + (cd.datetime || '') + '</div>' +
            '<div class="env-case-detail">' +
                (cd.latitude != null ? cd.latitude.toFixed(1) + '\u00b0N' : '') + ', ' +
                (cd.longitude != null ? cd.longitude.toFixed(1) + '\u00b0E' : '') +
                (cd.vmax_kt != null ? ' \u00b7 ' + cd.vmax_kt + ' kt' : '') +
            '</div>';
    }
}

function _envOverlayFetchAndRender(caseIdx, radiusKm) {
    var field = document.getElementById('env-ov-field').value || 'shear_mag';
    var url = API_BASE + '/era5?case_index=' + caseIdx + '&field=' + field + '&radius_km=' + radiusKm + '&data_type=' + _activeDataType;
    fetch(url)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
            if (data) {
                _era5Data = _era5Data || data;  // cache for explorer too
                _envOverlayData = data;
                renderEnvOverlay();
            } else {
                _envOverlayData = null;
                renderEnvOverlay();
            }
        })
        .catch(function() {
            _envOverlayData = null;
            renderEnvOverlay();
        });
}

function renderEnvOverlay() {
    _envNavPopulate();
    var display = document.getElementById('env-ov-display');
    var placeholder = document.getElementById('env-ov-placeholder');
    var caseInfo = document.getElementById('env-ov-case-info');
    var recomputeBtn = document.getElementById('env-ov-recompute');

    if (!_envOverlayData) {
        // Show a context-aware placeholder
        if (display) {
            var hasCase = document.getElementById('case-select') && document.getElementById('case-select').value;
            var hasStorm = document.getElementById('storm-select') && document.getElementById('storm-select').value;
            var msg, icon;
            if (!hasStorm) {
                icon = '\uD83C\uDF0A';
                msg = 'Select a <strong>storm</strong> and <strong>case</strong> from the toolbar dropdowns above, then open this panel to view ERA5 environmental diagnostics.';
            } else if (!hasCase) {
                icon = '\uD83C\uDF00';
                msg = 'Good \u2014 you\'ve selected a storm. Now choose a <strong>case</strong> from the toolbar dropdown, then reopen this panel.';
            } else {
                icon = '\u26A0\uFE0F';
                msg = 'ERA5 data could not be loaded for this case. It may not be available in the ERA5 store.';
            }
            display.innerHTML =
                '<div class="env-no-case" style="display:flex;">' +
                    '<div class="env-no-case-icon">' + icon + '</div>' +
                    '<div class="env-no-case-msg">' + msg + '</div>' +
                '</div>';
        }
        if (caseInfo) caseInfo.style.display = 'none';
        if (recomputeBtn) recomputeBtn.disabled = true;
        return;
    }
    if (placeholder) placeholder.style.display = 'none';
    if (recomputeBtn) recomputeBtn.disabled = false;

    // Show case info
    if (caseInfo && currentCaseData) {
        caseInfo.style.display = 'block';
        var cd = currentCaseData;
        caseInfo.innerHTML =
            '<div class="env-case-name">' + (cd.storm_name || 'Unknown') + '</div>' +
            '<div class="env-case-detail">' + (cd.datetime || '') + '</div>' +
            '<div class="env-case-detail">' +
                (cd.latitude != null ? cd.latitude.toFixed(1) + '\u00b0N' : '') + ', ' +
                (cd.longitude != null ? cd.longitude.toFixed(1) + '\u00b0E' : '') +
                (cd.vmax_kt != null ? ' \u00b7 ' + cd.vmax_kt + ' kt' : '') +
            '</div>';
    }

    // Build dashboard HTML
    var data = _envOverlayData;
    var scalars = data.scalars || {};
    var profiles = data.profiles;

    var html = '';

    // ── Row 1: 2D Map + Hodograph ──
    html += '<div class="env-dash-row two-col">' +
        '<div class="env-dash-card"><div class="env-dash-card-header">2D Spatial Field</div>' +
            '<div class="env-dash-card-body"><div id="env-ov-map" style="height:340px;"></div></div></div>' +
        '<div class="env-dash-card"><div class="env-dash-card-header">Hodograph (200\u2013600 km)</div>' +
            '<div class="env-dash-card-body"><div id="env-ov-hodo" style="height:340px;"></div></div></div>' +
    '</div>';

    // ── Row 2: Scalar cards ──
    html += '<div class="env-dash-card" style="margin-bottom:16px;">' +
        '<div class="env-dash-card-header">\uD83D\uDCCA Environmental Diagnostics</div>' +
        '<div class="env-dash-card-body">' +
            '<div class="env-scalars-grid" id="env-ov-scalars"></div>' +
        '</div></div>';

    // ── Row 3: Skew-T + RH Profile ──
    html += '<div class="env-dash-row two-col">' +
        '<div class="env-dash-card"><div class="env-dash-card-header">\uD83C\uDF21 Skew-T / Log-P Sounding</div>' +
            '<div class="env-dash-card-body"><div id="env-ov-skewt" style="height:400px;"></div></div></div>' +
        '<div class="env-dash-card"><div class="env-dash-card-header">Relative Humidity Profile</div>' +
            '<div class="env-dash-card-body"><div id="env-ov-rh-prof" style="height:400px;"></div></div></div>' +
    '</div>';

    // ── Row 4: θ/θe Profile ──
    html += '<div class="env-dash-row two-col">' +
        '<div class="env-dash-card"><div class="env-dash-card-header">\u03b8 / \u03b8e Profile</div>' +
            '<div class="env-dash-card-body"><div id="env-ov-theta-prof" style="height:300px;"></div></div></div>' +
        '<div class="env-dash-card" id="env-ov-skewt-info-card">' +
            '<div class="env-dash-card-header">\uD83D\uDCCB Sounding Info</div>' +
            '<div class="env-dash-card-body" id="env-ov-skewt-info" style="height:300px;font-size:12px;color:#9ca3af;overflow-y:auto;"></div>' +
        '</div>' +
    '</div>';

    display.innerHTML = html;

    // Enable/disable Skew-T radius controls based on 3D data availability
    var skewTBtn = document.getElementById('env-ov-skewt-btn');
    var skewTSlider = document.getElementById('env-ov-skewt-radius');
    var has3D = data && data.has_3d;
    if (skewTBtn) {
        skewTBtn.disabled = !has3D;
        skewTBtn.textContent = has3D ? 'Generate Skew-T' : 'Radius N/A (no 3D fields)';
        skewTBtn.title = has3D ? 'Recompute sounding at selected radius' :
            '3D T/q fields not in Zarr store — sounding uses precomputed 200–600 km annulus mean';
    }
    if (skewTSlider) {
        skewTSlider.disabled = !has3D;
        skewTSlider.style.opacity = has3D ? '1' : '0.35';
    }
    // Show a note below the slider when 3D is unavailable
    var radiusNote = document.getElementById('env-ov-skewt-radius-note');
    if (!radiusNote) {
        radiusNote = document.createElement('div');
        radiusNote.id = 'env-ov-skewt-radius-note';
        radiusNote.style.cssText = 'font-size:9px;color:#fbbf24;margin-top:2px;padding:3px 6px;' +
            'background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.15);border-radius:3px;line-height:1.3;';
        var sliderParent = skewTSlider ? skewTSlider.closest('.env-ctrl-row') : null;
        if (sliderParent) sliderParent.appendChild(radiusNote);
    }
    if (has3D) {
        radiusNote.style.display = 'none';
    } else {
        radiusNote.style.display = 'block';
        radiusNote.innerHTML = '\u26A0 3D T/q fields not in store \u2014 sounding fixed at precomputed 200\u2013600 km annulus.';
    }

    // Render each component
    setTimeout(function() {
        renderEnvOverlayMap(data);
        renderEnvOverlayScalars(scalars);
        if (profiles && profiles.u && profiles.v) {
            renderHodograph(profiles, 'env-ov-hodo');
        }
        if (profiles && profiles.plev) {
            renderSkewT(profiles, 'env-ov-skewt');
            renderRHProfile(profiles, 'env-ov-rh-prof');
            renderThetaProfile(profiles, 'env-ov-theta-prof');
            _renderSkewTInfo(profiles);
        }
    }, 60);
}

// ── 2D map inside the overlay ────────────────────────────────
function renderEnvOverlayMap(data) {
    if (!data || !data.data) return;
    var frame = data.data;
    var latOff = data.lat_offsets, lonOff = data.lon_offsets;
    var centerLat = data.center_lat;
    var cosLat = Math.cos(centerLat * Math.PI / 180);
    var yKm = latOff.map(function(d) { return d * 111.0; });
    var xKm = lonOff.map(function(d) { return d * 111.0 * cosLat; });

    var traces = [{
        z: frame, x: xKm, y: yKm, type: 'heatmap',
        colorscale: data.field_config.colorscale,
        zmin: data.field_config.vmin, zmax: data.field_config.vmax,
        colorbar: {
            title: { text: data.field_config.units, font: { size: 10, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            len: 0.9, thickness: 12,
        },
        hoverongaps: false,
        hovertemplate: '<b>' + data.field_config.display_name + '</b><br>%{z:.2f} ' + data.field_config.units + '<br>(%{x:.0f}, %{y:.0f}) km<extra></extra>',
    }];

    // Add quiver vectors if available
    if (data.vectors) {
        var vecs = data.vectors;
        var stride = vecs.stride;
        var arrowScale = 50;
        for (var yi = 0; yi < vecs.u.length; yi++) {
            for (var xi = 0; xi < vecs.u[yi].length; xi++) {
                var u = vecs.u[yi][xi], v = vecs.v[yi][xi];
                if (u === null || v === null) continue;
                var x0 = lonOff[xi * stride] * 111.0 * cosLat;
                var y0 = latOff[yi * stride] * 111.0;
                var mag = Math.sqrt(u * u + v * v);
                if (mag < 0.5) continue;
                var scale = arrowScale * mag / 20;
                traces.push({
                    x: [x0, x0 + u / mag * scale], y: [y0, y0 + v / mag * scale],
                    type: 'scatter', mode: 'lines',
                    line: { color: 'rgba(255,255,255,0.5)', width: 1.5 },
                    showlegend: false, hoverinfo: 'skip',
                });
            }
        }
    }

    // Add TC center marker
    traces.push({
        x: [0], y: [0], type: 'scatter', mode: 'markers',
        marker: { symbol: 'x', size: 12, color: '#ffffff', line: { width: 2, color: '#000' } },
        showlegend: false, hoverinfo: 'skip',
    });

    // Add annulus rings for scalar domain
    var innerKm = parseInt(document.getElementById('env-ov-inner') ? document.getElementById('env-ov-inner').value : '200');
    var outerKm = parseInt(document.getElementById('env-ov-outer') ? document.getElementById('env-ov-outer').value : '800');
    var ringPts = 72;
    function circleTrace(r, color, dash) {
        var cx = [], cy = [];
        for (var i = 0; i <= ringPts; i++) {
            var angle = 2 * Math.PI * i / ringPts;
            cx.push(r * Math.cos(angle));
            cy.push(r * Math.sin(angle));
        }
        return { x: cx, y: cy, type: 'scatter', mode: 'lines',
            line: { color: color, width: 1.5, dash: dash || 'solid' },
            showlegend: false, hoverinfo: 'skip' };
    }
    traces.push(circleTrace(innerKm, 'rgba(255,255,255,0.4)', 'dash'));
    traces.push(circleTrace(outerKm, 'rgba(255,255,255,0.4)', 'dash'));

    var maxR = Math.max(Math.abs(xKm[0]), Math.abs(xKm[xKm.length-1]), Math.abs(yKm[0]), Math.abs(yKm[yKm.length-1]));

    var layout = {
        xaxis: { title: { text: 'km (east)', font: { size: 10, color: '#8b9ec2' } },
            range: [-maxR, maxR], scaleanchor: 'y', scaleratio: 1,
            zeroline: false, gridcolor: 'rgba(255,255,255,0.04)', color: '#8b9ec2', tickfont: { size: 9 } },
        yaxis: { title: { text: 'km (north)', font: { size: 10, color: '#8b9ec2' } },
            range: [-maxR, maxR],
            zeroline: false, gridcolor: 'rgba(255,255,255,0.04)', color: '#8b9ec2', tickfont: { size: 9 } },
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(10,22,40,0.5)',
        margin: { l: 50, r: 10, t: 10, b: 45 },
        showlegend: false,
    };
    Plotly.newPlot('env-ov-map', traces, layout, { responsive: true, displayModeBar: false });
}

// ── Scalar diagnostic cards ──────────────────────────────────
function renderEnvOverlayScalars(scalars) {
    var el = document.getElementById('env-ov-scalars');
    if (!el) return;

    function scard(label, value, unit, sub, highlightClass) {
        return '<div class="env-scard' + (highlightClass ? ' ' + highlightClass : '') + '">' +
            '<div class="env-scard-value">' + value + '</div>' +
            '<div class="env-scard-unit">' + unit + '</div>' +
            '<div class="env-scard-label">' + label + '</div>' +
            (sub ? '<div class="env-scard-sub">' + sub + '</div>' : '') +
        '</div>';
    }

    // Shear
    var shearMs = scalars.shear_mag_env;
    var shearKt = shearMs != null ? (shearMs * 1.944).toFixed(0) : null;
    var shearDir = scalars.shear_dir_env;
    var shearHl = shearMs != null ? (shearMs < 5 ? 'highlight-good' : shearMs < 12 ? 'highlight-warn' : 'highlight-bad') : '';
    var shearVal = shearMs != null ? shearMs.toFixed(1) : '\u2014';
    var shearSub = '';
    if (shearKt != null) shearSub += shearKt + ' kt';
    if (shearDir != null) shearSub += ' from ' + shearDir.toFixed(0) + '\u00b0';

    // RH
    var rh = scalars.rh_mid_env;
    var rhHl = rh != null ? (rh > 70 ? 'highlight-good' : rh > 45 ? 'highlight-warn' : 'highlight-bad') : '';

    // Divergence
    var div = scalars.div200_env;
    var divScaled = div != null ? (div * 1e5).toFixed(1) : '\u2014';
    var divHl = div != null ? (div > 0.5e-5 ? 'highlight-good' : div > -0.5e-5 ? 'highlight-warn' : 'highlight-bad') : '';

    // SST
    var sst = scalars.sst_env;
    var sstHl = sst != null ? (sst >= 28 ? 'highlight-good' : sst >= 26 ? 'highlight-warn' : 'highlight-bad') : '';

    // PI
    var vpi = scalars.v_pi;
    var vpiKt = vpi != null ? (vpi * 1.944).toFixed(0) : null;
    var piHl = vpi != null ? (vpi >= 60 ? 'highlight-good' : vpi >= 40 ? 'highlight-warn' : 'highlight-bad') : '';

    // Entropy deficit
    var chiM = scalars.chi_m;
    var chiHl = chiM != null ? (chiM < 0.4 ? 'highlight-good' : chiM < 0.8 ? 'highlight-warn' : 'highlight-bad') : '';

    // Ventilation Index
    var ventIdx = scalars.vent_index;
    var ventHl = ventIdx != null ? (ventIdx < 0.1 ? 'highlight-good' : ventIdx < 0.2 ? 'highlight-warn' : 'highlight-bad') : '';

    // SHIPS comparison
    var shearShips = '';
    if (_currentSddc !== null && shearDir != null) {
        shearShips = 'SHIPS SDDC: ' + _currentSddc.toFixed(0) + '\u00b0 (\u0394' + Math.abs(shearDir - _currentSddc).toFixed(0) + '\u00b0)';
    }

    var html = '';
    html += scard('Deep-Layer Shear', shearVal, 'm/s', shearSub + (shearShips ? '<br>' + shearShips : ''), shearHl);
    html += scard('Mid-Level RH', rh != null ? rh.toFixed(0) : '\u2014', '%', '500\u2013700 hPa mean', rhHl);
    html += scard('200 hPa Div', divScaled, '\u00d710\u207b\u2075 s\u207b\u00b9', 'Positive = outflow', divHl);
    html += scard('SST', sst != null ? sst.toFixed(1) : '\u2014', '\u00b0C', '26\u00b0C threshold', sstHl);
    html += scard('Potential Intensity', vpi != null ? vpi.toFixed(1) : '\u2014', 'm/s', vpiKt != null ? vpiKt + ' kt (gradient level)' : '', piHl);
    html += scard('Entropy Deficit', chiM != null ? chiM.toFixed(2) : '\u2014', '\u03c7\u2098', 'Tang & Emanuel 2012', chiHl);
    html += scard('Ventilation Index', ventIdx != null ? ventIdx.toFixed(3) : '\u2014', '\u039b', 'V\u209b\u2095 \u00d7 \u03c7\u2098 / V\u209a\u1d62', ventHl);

    // Intensity vs PI gauge
    if (currentCaseData && currentCaseData.vmax_kt != null && vpi != null) {
        var vmaxMs = currentCaseData.vmax_kt / 1.944;
        var ratio = vmaxMs / vpi;
        var gaugeHl = ratio < 0.5 ? 'highlight-good' : ratio < 0.8 ? 'highlight-warn' : 'highlight-bad';
        html += scard('V / V\u209a\u1d62', (ratio * 100).toFixed(0) + '%', 'of PI', currentCaseData.vmax_kt + ' kt / ' + vpiKt + ' kt', gaugeHl);
    }

    el.innerHTML = html;
}

// ── Field change handler ─────────────────────────────────────
function envOverlayChangeField(field) {
    _envOverlayField = field;
    if (!currentCaseIndex && currentCaseIndex !== 0) return;
    var radiusKm = parseInt(document.getElementById('env-ov-radius').value) || 500;
    var url = API_BASE + '/era5?case_index=' + currentCaseIndex + '&field=' + field + '&radius_km=' + radiusKm + '&data_type=' + _activeDataType;
    fetch(url)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
            if (data) {
                _envOverlayData = data;
                renderEnvOverlayMap(data);
                renderEnvOverlayScalars(data.scalars || {});
            }
        });
}

// ── Radius change handler ────────────────────────────────────
function envOverlayRadiusChange(val) {
    _envOverlayCropKm = parseInt(val);
    document.getElementById('env-ov-radius-val').textContent = val + ' km';
    // Debounce: re-fetch with new radius after brief pause
    if (window._envRadiusTimer) clearTimeout(window._envRadiusTimer);
    window._envRadiusTimer = setTimeout(function() {
        if (!currentCaseIndex && currentCaseIndex !== 0) return;
        var field = document.getElementById('env-ov-field').value || 'shear_mag';
        var url = API_BASE + '/era5?case_index=' + currentCaseIndex + '&field=' + field + '&radius_km=' + _envOverlayCropKm + '&data_type=' + _activeDataType;
        fetch(url)
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(data) {
                if (data) {
                    _envOverlayData = data;
                    renderEnvOverlayMap(data);
                    renderEnvOverlayScalars(data.scalars || {});
                }
            });
    }, 400);
}

// ── Recompute scalars at custom annulus ───────────────────────
function envOverlayRecomputeScalars() {
    if (!currentCaseIndex && currentCaseIndex !== 0) return;
    var innerKm = parseInt(document.getElementById('env-ov-inner').value) || 200;
    var outerKm = parseInt(document.getElementById('env-ov-outer').value) || 800;
    var btn = document.getElementById('env-ov-recompute');
    if (btn) { btn.disabled = true; btn.textContent = 'Computing...'; }

    var url = API_BASE + '/era5_scalars?case_index=' + currentCaseIndex +
        '&inner_km=' + innerKm + '&outer_km=' + outerKm + '&data_type=' + _activeDataType;
    fetch(url)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
            if (btn) { btn.disabled = false; btn.textContent = 'Recompute Scalars'; }
            if (data) {
                // Merge recomputed scalars into the overlay data
                var merged = Object.assign({}, _envOverlayData.scalars || {}, data);
                renderEnvOverlayScalars(merged);
                // Re-render map to update annulus rings
                renderEnvOverlayMap(_envOverlayData);
            }
        })
        .catch(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Recompute Scalars'; }
        });
}

// ── Skew-T sounding info panel ────────────────────────────────
function _renderSkewTInfo(profiles) {
    var el = document.getElementById('env-ov-skewt-info');
    if (!el || !profiles || !profiles.t || !profiles.plev) return;

    var plev = profiles.plev;
    var tK = profiles.t;
    var qRaw = profiles.q;
    var rh = profiles.rh;
    var derived = profiles._derived || {};
    var tC = profiles._tC || tK.map(function(v) { return v != null ? v - 273.15 : null; });
    var tdC = profiles._tdC || [];

    // Detect q units
    var maxQ = 0;
    if (qRaw) {
        for (var qi = 0; qi < qRaw.length; qi++) {
            if (qRaw[qi] != null && qRaw[qi] > maxQ) maxQ = qRaw[qi];
        }
    }
    var qIsGkg = maxQ > 0.5;

    // ── Derived quantities summary (top) ──
    var html = '<div style="font-family:\'JetBrains Mono\',monospace;">';

    html += '<div style="color:#00d4ff;font-weight:700;margin-bottom:8px;font-size:11px;letter-spacing:1px;">DERIVED PARAMETERS</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:14px;">';

    function infoCard(label, value, unit, color) {
        return '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:6px 8px;text-align:center;">' +
            '<div style="font-size:14px;font-weight:700;color:' + (color || '#e5e7eb') + ';">' + value + '</div>' +
            '<div style="font-size:8px;color:#6b7280;margin-top:1px;">' + unit + '</div>' +
            '<div style="font-size:8px;color:#8b9ec2;font-weight:600;">' + label + '</div></div>';
    }

    // CAPE
    var capeVal = derived.cape != null ? derived.cape : '\u2014';
    var capeColor = derived.cape > 2500 ? '#ef4444' : derived.cape > 1000 ? '#f59e0b' : derived.cape > 500 ? '#fbbf24' : '#34d399';
    html += infoCard('CAPE', capeVal, 'J/kg', capeColor);

    // CIN
    var cinVal = derived.cin != null ? derived.cin : '\u2014';
    var cinColor = derived.cin < -200 ? '#60a5fa' : derived.cin < -50 ? '#93c5fd' : '#e5e7eb';
    html += infoCard('CIN', cinVal, 'J/kg', cinColor);

    // PWAT
    var pwatVal = derived.pwat != null ? derived.pwat.toFixed(1) : '\u2014';
    var pwatIn = derived.pwat != null ? (derived.pwat / 25.4).toFixed(2) : '\u2014';
    html += infoCard('PWAT', pwatVal, 'mm (' + pwatIn + ' in)', '#22d3ee');

    // Freezing level
    var frzVal = derived.freezing_p != null ? Math.round(derived.freezing_p) : '\u2014';
    html += infoCard('0\u00b0C Level', frzVal, 'hPa', '#60a5fa');

    // LCL
    var lclVal = derived.lcl_p != null ? Math.round(derived.lcl_p) : '\u2014';
    html += infoCard('LCL', lclVal, 'hPa', '#a78bfa');

    // LFC
    var lfcVal = derived.lfc_p != null ? Math.round(derived.lfc_p) : '\u2014';
    html += infoCard('LFC', lfcVal, 'hPa', '#fb923c');

    // EL
    var elVal = derived.el_p != null ? Math.round(derived.el_p) : '\u2014';
    html += infoCard('EL', elVal, 'hPa', '#c084fc');

    // Mean T-Td depression
    var totalDep = 0, countDep = 0;
    for (var m = 0; m < plev.length; m++) {
        if (tC[m] != null && tdC[m] != null) { totalDep += (tC[m] - tdC[m]); countDep++; }
    }
    var meanDep = countDep > 0 ? (totalDep / countDep).toFixed(1) : '\u2014';
    html += infoCard('Mean T\u2013Td', meanDep, '\u00b0C', '#f59e0b');

    html += '</div>';

    // ── Sounding table ──
    html += '<div style="color:#00d4ff;font-weight:700;margin-bottom:4px;font-size:10px;letter-spacing:1px;">SOUNDING TABLE</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:10px;">';
    html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.1);color:#8b9ec2;">' +
        '<th style="text-align:left;padding:3px 4px;">P</th>' +
        '<th style="text-align:right;padding:3px 4px;">T</th>' +
        '<th style="text-align:right;padding:3px 4px;">Td</th>' +
        '<th style="text-align:right;padding:3px 4px;">RH</th>' +
        '<th style="text-align:right;padding:3px 4px;">q</th></tr>';

    for (var j = 0; j < plev.length; j++) {
        var rowColor = plev[j] <= 200 ? 'rgba(100,160,255,0.6)' :
                       plev[j] <= 500 ? 'rgba(200,200,200,0.6)' : 'rgba(255,200,150,0.6)';
        var qDisplay = null;
        if (qRaw && qRaw[j] != null) {
            qDisplay = qIsGkg ? qRaw[j] : qRaw[j] * 1000.0;
        }
        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.04);color:' + rowColor + ';">' +
            '<td style="padding:2px 4px;">' + plev[j] + '</td>' +
            '<td style="text-align:right;padding:2px 4px;">' + (tC[j] != null ? tC[j].toFixed(1) : '\u2014') + '</td>' +
            '<td style="text-align:right;padding:2px 4px;">' + (tdC[j] != null ? tdC[j].toFixed(1) : '\u2014') + '</td>' +
            '<td style="text-align:right;padding:2px 4px;">' + (rh && rh[j] != null ? rh[j].toFixed(0) : '\u2014') + '</td>' +
            '<td style="text-align:right;padding:2px 4px;">' + (qDisplay != null ? qDisplay.toFixed(1) : '\u2014') + '</td></tr>';
    }
    html += '</table></div>';
    el.innerHTML = html;
}

// ── Skew-T radius UI handlers ────────────────────────────────
function envOverlaySkewTRadiusChange(val) {
    document.getElementById('env-ov-skewt-radius-val').textContent = val + ' km';
}

function envOverlayRecomputeSkewT() {
    if (!currentCaseIndex && currentCaseIndex !== 0) return;
    var radiusKm = parseInt(document.getElementById('env-ov-skewt-radius').value) || 200;
    var btn = document.getElementById('env-ov-skewt-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading\u2026'; }

    fetchSkewTSounding(currentCaseIndex, radiusKm, function(data) {
        if (data && data.profiles) {
            renderSkewT(data.profiles, 'env-ov-skewt');
            _renderSkewTInfo(data.profiles);

            // Update radius slider state based on API response
            var has3D = data.has_3d;
            var skewTSlider = document.getElementById('env-ov-skewt-radius');
            if (btn) {
                btn.disabled = !has3D;
                btn.textContent = has3D ? 'Generate Skew-T' : 'Radius N/A (no 3D fields)';
            }
            if (skewTSlider) {
                skewTSlider.disabled = !has3D;
                skewTSlider.style.opacity = has3D ? '1' : '0.35';
            }

            // Show subtitle on the Skew-T card with source info
            var skewDiv = document.getElementById('env-ov-skewt');
            var sourceNote = document.getElementById('env-ov-skewt-source-note');
            if (!sourceNote && skewDiv) {
                sourceNote = document.createElement('div');
                sourceNote.id = 'env-ov-skewt-source-note';
                sourceNote.style.cssText = 'font-size:9px;text-align:center;padding:2px 6px;margin-top:-2px;';
                skewDiv.parentNode.insertBefore(sourceNote, skewDiv.nextSibling);
            }
            if (sourceNote) {
                if (data.source === 'recomputed') {
                    sourceNote.style.color = '#22d3ee';
                    sourceNote.textContent = '\u2713 Recomputed at ' + radiusKm + ' km radius';
                } else {
                    sourceNote.style.color = '#fbbf24';
                    sourceNote.textContent = '\u26A0 Precomputed ' +
                        (data.precomputed_domain || '200\u2013600 km annulus') + ' mean';
                }
            }
        } else {
            if (btn) { btn.disabled = false; btn.textContent = 'Generate Skew-T'; }
        }
    });
}

// ── Environment overlay case navigation ──────────────────────

// Get the sorted list of cases for the currently-selected storm
function _envNavGetStormCases() {
    var d = _getActiveData();
    if (!d || !currentCaseData) return [];
    var storm = currentCaseData.storm_name;
    if (!storm) return [];
    var cases = d.cases.filter(function(c) { return c.storm_name === storm; });
    cases.sort(function(a, b) { return a.datetime.localeCompare(b.datetime); });
    return cases;
}

// Populate the env nav dropdown with the current storm's cases
function _envNavPopulate() {
    var sel = document.getElementById('env-nav-select');
    var nav = document.getElementById('env-nav-bar');
    if (!sel || !nav) return;

    var cases = _envNavGetStormCases();
    if (cases.length === 0) {
        nav.style.display = 'none';
        return;
    }
    nav.style.display = 'flex';

    sel.innerHTML = '';
    cases.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.case_index;
        var cat = typeof getIntensityCategory === 'function' ? getIntensityCategory(c.vmax_kt) : '';
        var vStr = c.vmax_kt !== null ? ' [' + cat + ', ' + c.vmax_kt + ' kt]' : '';
        opt.textContent = c.datetime + vStr;
        if (currentCaseIndex === c.case_index) opt.selected = true;
        sel.appendChild(opt);
    });

    // Enable/disable prev/next buttons
    var curIdx = -1;
    for (var i = 0; i < cases.length; i++) {
        if (cases[i].case_index === currentCaseIndex) { curIdx = i; break; }
    }
    var prevBtn = document.getElementById('env-nav-prev');
    var nextBtn = document.getElementById('env-nav-next');
    if (prevBtn) prevBtn.disabled = (curIdx <= 0);
    if (nextBtn) nextBtn.disabled = (curIdx < 0 || curIdx >= cases.length - 1);
}

function _envNavGoToCase(caseIdx) {
    var d = _getActiveData();
    if (!d) return;
    var caseData = d.cases.find(function(c) { return c.case_index === caseIdx; });
    if (!caseData) return;

    // Update globals
    currentCaseIndex = caseData.case_index;
    currentCaseData = caseData;

    // Also update main toolbar dropdown so it stays in sync
    var mainCaseSel = document.getElementById('case-select');
    if (mainCaseSel) mainCaseSel.value = caseIdx;

    // Show loading and fetch new env data
    _envOverlayShowLoading();
    _envNavPopulate();
    var radiusKm = parseInt(document.getElementById('env-ov-radius').value) || 500;
    _envOverlayFetchAndRender(caseIdx, radiusKm);
}

function envNavPrev() {
    var cases = _envNavGetStormCases();
    var curIdx = -1;
    for (var i = 0; i < cases.length; i++) {
        if (cases[i].case_index === currentCaseIndex) { curIdx = i; break; }
    }
    if (curIdx > 0) _envNavGoToCase(cases[curIdx - 1].case_index);
}

function envNavNext() {
    var cases = _envNavGetStormCases();
    var curIdx = -1;
    for (var i = 0; i < cases.length; i++) {
        if (cases[i].case_index === currentCaseIndex) { curIdx = i; break; }
    }
    if (curIdx >= 0 && curIdx < cases.length - 1) _envNavGoToCase(cases[curIdx + 1].case_index);
}

function envNavJump(val) {
    var idx = parseInt(val);
    if (!isNaN(idx) && idx !== currentCaseIndex) _envNavGoToCase(idx);
}

// ── ERA5 cleanup ─────────────────────────────────────────────
function cleanupERA5() {
    _era5Data = null;
    _era5PlotlyVisible = false;
    _envOverlayData = null;
    var menu = document.getElementById('era5-field-menu');
    if (menu) menu.remove();
    // Reset overlay display if open
    var ovDisplay = document.getElementById('env-ov-display');
    var ovPlaceholder = document.getElementById('env-ov-placeholder');
    if (ovDisplay && ovPlaceholder) {
        ovDisplay.innerHTML = '';
        ovDisplay.appendChild(ovPlaceholder);
        ovPlaceholder.style.display = 'flex';
    }
    var caseInfo = document.getElementById('env-ov-case-info');
    if (caseInfo) caseInfo.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════
// IR Satellite Imagery Module
// ══════════════════════════════════════════════════════════════

// ── IR state ─────────────────────────────────────────────────
var _irData = null;
var _irMapOverlay = null;
var _irFrameURLs = [];
var _irAnimFrame = 0;
var _irAnimTimer = null;
var _irAnimPlaying = false;
var _irMapVisible = true;
var _irPlotlyVisible = false;
var _tdrVisible = true;
var _irFetching = false;
var _irBoundsSet = false;
var _irDecodedImages = [];

// ── IR data fetch ────────────────────────────────────────────
// ── IR loading indicator on map ───────────────────────────────
function _showIRLoadingIndicator() {
    if (document.getElementById('ir-loading-indicator')) return;
    var mapEl = document.getElementById('map-container');
    if (!mapEl) return;
    var div = document.createElement('div');
    div.id = 'ir-loading-indicator';
    div.style.cssText = 'position:absolute;bottom:14px;left:14px;z-index:999;' +
        'background:rgba(10,22,40,0.88);backdrop-filter:blur(6px);' +
        'border:1px solid rgba(255,255,255,0.12);border-radius:8px;' +
        'padding:8px 16px;display:flex;align-items:center;gap:8px;';
    div.innerHTML =
        '<div style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.15);' +
        'border-top:2px solid #60a5fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
        '<span style="font-size:11px;color:#93c5fd;font-family:\'JetBrains Mono\',monospace;">IR loading\u2026</span>';
    mapEl.appendChild(div);
}
function _removeIRLoadingIndicator() {
    var el = document.getElementById('ir-loading-indicator');
    if (el) el.remove();
}

var _irAllFramesLoaded = false;
var _irLoadedCount = 0;

function fetchIRData(caseIndex, callback) {
    if (_irFetching) return;
    _irFetching = true;
    _irAllFramesLoaded = false;
    _irLoadedCount = 0;
    _irBoundsSet = false;  // force setBounds() on new case (center may differ)

    // Phase 1: Fetch metadata + t=0 frame for instant display
    var url = API_BASE + '/ir?case_index=' + caseIndex + '&data_type=' + _activeDataType;
    fetch(url)
        .then(function(r) {
            if (!r.ok) { _irFetching = false; if (callback) callback(null); return null; }
            return r.json();
        })
        .then(function(data) {
            _irFetching = false;
            if (!data) return;
            _irData = data;
            // Initialize frame array with just frame0 in position 0
            var n = data.n_frames || 9;
            _irFrameURLs = new Array(n);
            for (var i = 0; i < n; i++) _irFrameURLs[i] = null;
            if (data.frame0) {
                _irFrameURLs[0] = data.frame0;
                _irLoadedCount = 1;
            }

            if (callback) callback(data);

            // Phase 2: Fetch remaining frames in parallel
            _fetchRemainingFramesParallel(caseIndex, 1);
        })
        .catch(function(err) {
            console.warn('IR fetch failed:', err);
            _irFetching = false; _irData = null;
            if (callback) callback(null);
        });
}

function _fetchRemainingFramesParallel(caseIndex, startIdx) {
    // Stop if case changed or out of range
    if (!_irData || _irData.case_index !== caseIndex) return;
    if (startIdx >= _irFrameURLs.length) {
        _irAllFramesLoaded = true;
        _updateIRLoadingLabel();
        _preDecodeIRFrames();
        return;
    }

    var promises = [];
    for (var i = startIdx; i < _irFrameURLs.length; i++) {
        (function(lagIdx) {
            var url = API_BASE + '/ir_frame?case_index=' + caseIndex + '&lag_index=' + lagIdx + '&data_type=' + _activeDataType;
            promises.push(
                fetch(url)
                    .then(function(r) { return r.ok ? r.json() : null; })
                    .then(function(data) {
                        // Guard: user may have navigated away
                        if (!data || !_irData || _irData.case_index !== caseIndex) return;
                        if (data.frame) {
                            _irFrameURLs[data.lag_index] = data.frame;
                        }
                        // Update progress as each frame lands
                        _irLoadedCount = _countLoadedFrames();
                        _updateIRLoadingLabel();
                        if (_irLoadedCount >= 2) {
                            _enableIRAnimControls();
                        }
                    })
                    .catch(function(err) {
                        console.warn('IR frame ' + lagIdx + ' fetch failed:', err);
                    })
            );
        })(i);
    }

    Promise.all(promises).then(function() {
        // Final update once every request has resolved (success or failure)
        if (_irData && _irData.case_index === caseIndex) {
            _irLoadedCount = _countLoadedFrames();
            _irAllFramesLoaded = true;
            _updateIRLoadingLabel();
            if (_irLoadedCount >= 2) {
                _enableIRAnimControls();
            }
            _preDecodeIRFrames();
        }
    });
}

// ── Pre-decoded IR frame images for smooth animation ─────────

function _preDecodeIRFrames() {
    _irDecodedImages = new Array(_irFrameURLs.length);
    for (var i = 0; i < _irFrameURLs.length; i++) {
        if (_irFrameURLs[i]) {
            var img = new Image();
            img.src = _irFrameURLs[i];
            // Use decode() where available to pre-decode off main thread
            if (img.decode) {
                img.decode().catch(function() {});
            }
            _irDecodedImages[i] = img;
        } else {
            _irDecodedImages[i] = null;
        }
    }
}

function _countLoadedFrames() {
    var count = 0;
    for (var i = 0; i < _irFrameURLs.length; i++) {
        if (_irFrameURLs[i]) count++;
    }
    return count;
}

function _enableIRAnimControls() {
    var playBtn = document.getElementById('ir-play-btn');
    if (playBtn) playBtn.classList.remove('ir-ctrl-disabled');
    var stepBack = document.getElementById('ir-step-back');
    if (stepBack) stepBack.classList.remove('ir-ctrl-disabled');
    var stepFwd = document.getElementById('ir-step-fwd');
    if (stepFwd) stepFwd.classList.remove('ir-ctrl-disabled');
    var slider = document.getElementById('ir-frame-slider');
    if (slider) slider.disabled = false;
}

function _updateIRLoadingLabel() {
    var label = document.getElementById('ir-map-label');
    if (!label || !_irData) return;
    if (_irAllFramesLoaded) {
        // Show current frame info
        var lagHr = _irData.lag_hours[_irAnimFrame];
        var dtStr = _irData.ir_datetimes[_irAnimFrame] || '';
        label.textContent = 'IR ' + (lagHr > 0 ? 't\u2212' + lagHr.toFixed(1) + 'h' : 't=0') + (dtStr ? ' | ' + dtStr : '');
    } else {
        // Show loading progress alongside current frame info
        var lagHr = _irData.lag_hours[_irAnimFrame];
        var dtStr = _irData.ir_datetimes[_irAnimFrame] || '';
        var frameInfo = 'IR ' + (lagHr > 0 ? 't\u2212' + lagHr.toFixed(1) + 'h' : 't=0');
        label.textContent = frameInfo + ' | Loading ' + _irLoadedCount + '/' + _irFrameURLs.length + '...';
    }
}

// ── Leaflet map overlay ──────────────────────────────────────
function _irGetBounds(data) {
    var latOff = data.lat_offsets, lonOff = data.lon_offsets;
    return L.latLngBounds(
        [data.center_lat + latOff[0], data.center_lon + lonOff[0]],
        [data.center_lat + latOff[latOff.length - 1], data.center_lon + lonOff[lonOff.length - 1]]
    );
}

function showIRMapOverlay(frameIdx) {
    if (!_irData || !_irFrameURLs.length) return;
    var idx = (frameIdx !== undefined) ? frameIdx : _irAnimFrame;
    idx = Math.max(0, Math.min(idx, _irFrameURLs.length - 1));
    _irAnimFrame = idx;
    var url = _irFrameURLs[idx];
    if (!url) return;  // skip null frames
    var bounds = _irGetBounds(_irData);
    if (_irMapOverlay) {
        // Fast path: bypass Leaflet's setUrl() to avoid its async load cycle.
        // Directly set the <img> src — if a pre-decoded Image exists for this
        // frame, the browser can resolve the data URL from its cache near-instantly.
        var imgEl = _irMapOverlay.getElement ? _irMapOverlay.getElement() : _irMapOverlay._image;
        if (imgEl) {
            imgEl.src = url;
        } else {
            _irMapOverlay.setUrl(url);
        }
        // Bounds are identical for all frames in a case, so only set once
        if (!_irBoundsSet) {
            _irMapOverlay.setBounds(bounds);
            _irBoundsSet = true;
        }
    } else {
        _irMapOverlay = L.imageOverlay(url, bounds, { opacity: 0.75, interactive: false, zIndex: 200 });
        _irMapOverlay.addTo(map);
        _irBoundsSet = true;
    }
    _updateIRLoadingLabel();
    // Show IR colorbar on the Leaflet map
    _showIRMapColorbar();
}

function removeIRMapOverlay() {
    irAnimStop();
    _removeIRLoadingIndicator();
    _hideIRMapColorbar();
    if (_irMapOverlay) { map.removeLayer(_irMapOverlay); _irMapOverlay = null; }
    _irData = null; _irFrameURLs = []; _irAnimFrame = 0; _irMapVisible = true; _irAllFramesLoaded = false; _irLoadedCount = 0; _irBoundsSet = false; _irDecodedImages = [];
    var ctrl = document.getElementById('ir-map-controls');
    if (ctrl) ctrl.remove();
}

function irAnimStep(dir) {
    if (!_irData || _irLoadedCount < 2) return;
    var n = _irFrameURLs.length;
    // Step in direction, skipping null frames
    var startFrame = _irAnimFrame;
    for (var i = 0; i < n; i++) {
        _irAnimFrame = (_irAnimFrame + dir + n) % n;
        if (_irFrameURLs[_irAnimFrame]) break;
    }
    showIRMapOverlay(_irAnimFrame);
    _updateIRSlider();
}

function irAnimToggle() {
    if (_irLoadedCount < 2) return;
    if (_irAnimPlaying) { irAnimStop(); }
    else {
        _irAnimPlaying = true;
        // Start from the earliest (highest-index) loaded frame
        for (var i = _irFrameURLs.length - 1; i >= 0; i--) {
            if (_irFrameURLs[i]) { _irAnimFrame = i; break; }
        }
        showIRMapOverlay(_irAnimFrame);
        _updateIRSlider();
        _updateIRPlayBtn();
        irAnimTick();
    }
}

function irAnimTick() {
    if (!_irAnimPlaying) return;
    irAnimStep(-1);
    if (_irAnimFrame === 0) {
        _irAnimTimer = setTimeout(function() {
            // Reset to the earliest (highest-index) loaded frame
            for (var i = _irFrameURLs.length - 1; i >= 0; i--) {
                if (_irFrameURLs[i]) { _irAnimFrame = i; break; }
            }
            showIRMapOverlay(_irAnimFrame);
            _updateIRSlider();
            _irAnimTimer = setTimeout(irAnimTick, 600);
        }, 1500);
    } else {
        _irAnimTimer = setTimeout(irAnimTick, 600);
    }
}

function irAnimStop() {
    _irAnimPlaying = false;
    if (_irAnimTimer) { clearTimeout(_irAnimTimer); _irAnimTimer = null; }
    _updateIRPlayBtn();
}

function _updateIRPlayBtn() {
    var btn = document.getElementById('ir-play-btn');
    if (btn) btn.textContent = _irAnimPlaying ? '\u23F8' : '\u25B6';
}

function _updateIRSlider() {
    var slider = document.getElementById('ir-frame-slider');
    if (slider) slider.value = (_irFrameURLs.length - 1) - _irAnimFrame;
}

function toggleIRMapVisibility() {
    _irMapVisible = !_irMapVisible;
    if (_irMapOverlay) _irMapOverlay.setOpacity(_irMapVisible ? 0.75 : 0);
    if (_irMapVisible) { _showIRMapColorbar(); } else { _hideIRMapColorbar(); }
    var btn = document.getElementById('ir-toggle-btn');
    if (btn) btn.textContent = _irMapVisible ? '\uD83C\uDF0D IR On' : '\uD83C\uDF11 IR Off';
}

function _injectIRMapControls() {
    if (document.getElementById('ir-map-controls')) return;
    // Anchor to #map-container (not #map-wrapper) so controls stay pinned
    // to the bottom of the visible map, not the bottom of the full layout
    var mapWrapper = document.getElementById('map-container');
    if (!mapWrapper) return;
    var n = _irFrameURLs.length;
    var disabledCls = _irAllFramesLoaded ? '' : ' ir-ctrl-disabled';
    var disabledAttr = _irAllFramesLoaded ? '' : ' disabled';
    var ctrl = document.createElement('div');
    ctrl.id = 'ir-map-controls';
    ctrl.className = 'ir-map-controls';
    ctrl.innerHTML =
        '<div class="ir-ctrl-row">' +
            '<button class="ir-ctrl-btn" id="ir-toggle-btn" onclick="toggleIRMapVisibility()">\uD83C\uDF0D IR On</button>' +
            '<button class="ir-ctrl-btn' + disabledCls + '" id="ir-step-back" onclick="irAnimStep(1)" title="Previous (earlier)">\u25C0</button>' +
            '<button class="ir-ctrl-btn' + disabledCls + '" id="ir-play-btn" onclick="irAnimToggle()" title="Play/Pause">\u25B6</button>' +
            '<button class="ir-ctrl-btn' + disabledCls + '" id="ir-step-fwd" onclick="irAnimStep(-1)" title="Next (later)">\u25B6</button>' +
            '<input type="range" id="ir-frame-slider" min="0" max="' + (n - 1) + '" value="' + (n - 1) + '" ' +
                disabledAttr +
                ' oninput="showIRMapOverlay(' + (n - 1) + ' - parseInt(this.value))" class="ir-slider">' +
            '<span class="ir-label" id="ir-map-label">IR t=0</span>' +
        '</div>';
    mapWrapper.appendChild(ctrl);
}

// ── Plotly IR underlay ───────────────────────────────────────
function buildIRPlotlyImage(irData) {
    if (!irData || !_irFrameURLs.length) return null;
    // Use the t=0 frame (index 0 in the frames array)
    var url = _irFrameURLs[0];
    if (!url) return null;
    var latOff = irData.lat_offsets, lonOff = irData.lon_offsets;
    var centerLat = irData.center_lat;
    var cosLat = Math.cos(centerLat * Math.PI / 180);
    var yMin = latOff[0] * 111.0;
    var yMax = latOff[latOff.length - 1] * 111.0;
    var xMin = lonOff[0] * 111.0 * cosLat;
    var xMax = lonOff[lonOff.length - 1] * 111.0 * cosLat;
    return {
        source: url,
        xref: 'x', yref: 'y',
        x: xMin, y: yMax,
        sizex: xMax - xMin, sizey: yMax - yMin,
        sizing: 'stretch', opacity: 0.35, layer: 'below',
    };
}

function toggleIRPlotlyUnderlay() {
    _irPlotlyVisible = !_irPlotlyVisible;
    var plotDiv = document.getElementById('plotly-chart');
    if (!plotDiv || !plotDiv.data) { _irPlotlyVisible = false; return; }
    if (_irPlotlyVisible && _irData) {
        var irImg = buildIRPlotlyImage(_irData);
        if (irImg) {
            var existingImages = (plotDiv.layout.images || []).filter(function(img) {
                return !img._irUnderlay;
            });
            irImg._irUnderlay = true;
            existingImages.push(irImg);
            Plotly.relayout('plotly-chart', { images: existingImages });
            var fsdiv = document.getElementById('plotly-fullscreen');
            if (fsdiv && fsdiv.layout) {
                var fsImages = (fsdiv.layout.images || []).filter(function(img) {
                    return !img._irUnderlay;
                });
                var fsImg = JSON.parse(JSON.stringify(irImg));
                fsImg._irUnderlay = true;
                fsImages.push(fsImg);
                Plotly.relayout('plotly-fullscreen', { images: fsImages });
            }
        }
    } else {
        _irPlotlyVisible = false;
        var cleanImages = (plotDiv.layout.images || []).filter(function(img) {
            return !img._irUnderlay;
        });
        Plotly.relayout('plotly-chart', { images: cleanImages });
        var fsdiv2 = document.getElementById('plotly-fullscreen');
        if (fsdiv2 && fsdiv2.layout) {
            var fsClean = (fsdiv2.layout.images || []).filter(function(img) {
                return !img._irUnderlay;
            });
            Plotly.relayout('plotly-fullscreen', { images: fsClean });
        }
    }
    var btn = document.getElementById('ir-underlay-btn');
    if (btn) {
        btn.classList.toggle('active', _irPlotlyVisible);
    }
}



// ── Toggle TDR contour fill visibility ──
function toggleTDRVisibility() {
    _tdrVisible = !_tdrVisible;
    var plotDiv = document.getElementById('plotly-chart');
    if (!plotDiv || !plotDiv.data) { _tdrVisible = true; return; }

    // Collect TDR trace indices — skip any trace tagged as _isMW
    var lastPlotData = window._lastPlotlyData;
    var nBaseTDR = 1; // heatmap is always trace 0 (before MW insertion)
    if (lastPlotData) {
        nBaseTDR = 1 + (lastPlotData.overlayTraces ? lastPlotData.overlayTraces.length : 0) +
                       (lastPlotData.maxTraces ? lastPlotData.maxTraces.length : 0);
    }

    // Build indices of TDR-only traces (skip MW-tagged traces)
    var tdrIndices = [];
    var tdrFirstIdx = null;
    for (var i = 0; i < plotDiv.data.length; i++) {
        if (plotDiv.data[i]._isMW) continue;  // skip MW traces
        tdrIndices.push(i);
        if (tdrFirstIdx === null) tdrFirstIdx = i;
        if (tdrIndices.length >= nBaseTDR) break;
    }

    if (tdrIndices.length === 0) return;

    Plotly.update('plotly-chart', {}, {});  // force redraw
    Plotly.restyle('plotly-chart', {
        visible: _tdrVisible,
        showscale: _tdrVisible ? true : undefined
    }, tdrIndices);

    // Also update fullscreen if open
    var fsdiv = document.getElementById('plotly-fullscreen');
    if (fsdiv && fsdiv.data) {
        var fsIndices = [];
        for (var i = 0; i < fsdiv.data.length; i++) {
            if (fsdiv.data[i]._isMW) continue;
            fsIndices.push(i);
            if (fsIndices.length >= nBaseTDR) break;
        }
        if (fsIndices.length > 0) {
            Plotly.restyle('plotly-fullscreen', {
                visible: _tdrVisible,
                showscale: _tdrVisible ? true : undefined
            }, fsIndices);
        }
    }

    var btn = document.getElementById('tdr-toggle-btn');
    if (btn) {
        btn.classList.toggle('active', _tdrVisible);
    }
}

function _hurricaneLoadingHTML(message, compact) {
    var id = 'hurricane-anim-' + Date.now();
    var fontSize = compact ? '7.5px' : '8px';
    var html = '<div class="hurricane-loader" id="' + id + '">' +
        '<pre class="hurricane-pre" style="font-size:' + fontSize + ';"></pre>' +
        '<div class="hurricane-msg">' + (message || 'Loading\u2026') + '</div>' +
    '</div>';
    // Start animation on next tick
    setTimeout(function() { _startHurricaneAnim(id, compact); }, 30);
    return html;
}

function _startHurricaneAnim(containerId, compact) {
    _stopHurricaneAnim();
    _hurricanePhase = 0;
    var W = compact ? 55 : 75;
    var H = compact ? 21 : 31;
    _hurricaneAnimId = setInterval(function() {
        var container = document.getElementById(containerId);
        if (!container) { _stopHurricaneAnim(); return; }
        var pre = container.querySelector('.hurricane-pre');
        if (!pre) { _stopHurricaneAnim(); return; }
        pre.innerHTML = _renderHurricaneFrame(_hurricanePhase, W, H);
        _hurricanePhase += 0.18;  // counterclockwise: increasing phase = increasing arm angle = CCW
    }, 120);
}

function _stopHurricaneAnim() {
    if (_hurricaneAnimId) { clearInterval(_hurricaneAnimId); _hurricaneAnimId = null; }
}

function _renderHurricaneFrame(phase, W, H) {
    var cx = (W - 1) / 2, cy = (H - 1) / 2;
    var asp = 2.1;
    var maxR = cy - 0.5;
    var grid = [], bright = [];
    var r, c;
    for (r = 0; r < H; r++) {
        grid[r] = []; bright[r] = [];
        for (c = 0; c < W; c++) { grid[r][c] = ' '; bright[r][c] = 0; }
    }
    var chars = ['\u2500', '\\', '\u2502', '/', '\u2500', '\\', '\u2502', '/'];

    for (var row = 0; row < H; row++) {
        for (var col = 0; col < W; col++) {
            var dx = (col - cx) / asp;
            var dy = -(row - cy);
            var dist = Math.sqrt(dx * dx + dy * dy);
            var nr = dist / maxR;
            if (nr < 0.05 || nr > 1.0) continue;

            var angle = Math.atan2(dy, dx);
            if (angle < 0) angle += 2 * Math.PI;

            // Differential rotation: eyewall spins fast, outer bands slower
            var rotScale = 1.0 / (1.0 + 2.0 * nr);
            var effectivePhase = phase * rotScale;

            var a = 0.08;
            var nArms = 3;
            var minDist = Infinity;
            var bestArmTheta = 0;
            for (var arm = 0; arm < nArms; arm++) {
                var armOff = arm * 2 * Math.PI / nArms;
                var spiralTheta = nr / a + armOff + effectivePhase;
                var diff = angle - (spiralTheta % (2 * Math.PI));
                while (diff > Math.PI) diff -= 2 * Math.PI;
                while (diff < -Math.PI) diff += 2 * Math.PI;
                var arcDist = Math.abs(diff) * nr;
                if (arcDist < minDist) { minDist = arcDist; bestArmTheta = spiralTheta; }
            }

            var bandWidth;
            if (nr < 0.27) bandWidth = nr * 0.93;
            else if (nr < 0.48) bandWidth = 0.088;
            else if (nr < 0.72) bandWidth = 0.072;
            else bandWidth = 0.055;

            if (minDist < bandWidth) {
                var edgeFrac = minDist / bandWidth;

                var flowAngle;
                if (nr < 0.27) {
                    flowAngle = angle + Math.PI / 2;
                } else {
                    flowAngle = angle + Math.atan2(1, a / nr) + Math.PI;
                }
                if (flowAngle < 0) flowAngle += 2 * Math.PI;
                var dirIdx = Math.round(flowAngle / (Math.PI / 4)) % 8;

                // Trackable markers: evenly spaced dots along the spiral arc
                var markerSpacing = 1.8;
                var markerPos = bestArmTheta % markerSpacing;
                if (markerPos < 0) markerPos += markerSpacing;
                var isMarker = nr >= 0.27 && edgeFrac < 0.35 && markerPos < markerSpacing * 0.3;

                grid[row][col] = isMarker ? '\u2022' : chars[dirIdx];

                var radialFade = nr < 0.27 ? 1.0 : nr < 0.48 ? 0.85 : nr < 0.72 ? 0.65 : 0.45;
                var intensity = (1 - edgeFrac * 0.7) * radialFade;
                if (isMarker) intensity = Math.min(1.0, intensity + 0.25);
                if (intensity > 0.8)      bright[row][col] = 5;
                else if (intensity > 0.6) bright[row][col] = 4;
                else if (intensity > 0.4) bright[row][col] = 3;
                else if (intensity > 0.2) bright[row][col] = 2;
                else                      bright[row][col] = 1;
            }
        }
    }

    // Clear the eye
    var eyeLim = Math.ceil(maxR * 0.08);
    for (var ey = -eyeLim; ey <= eyeLim; ey++) {
        for (var ex = -Math.ceil(eyeLim * asp); ex <= Math.ceil(eyeLim * asp); ex++) {
            var ed = Math.sqrt((ex / asp) * (ex / asp) + ey * ey) / maxR;
            if (ed < 0.065) {
                var eiy = Math.round(cy + ey), eix = Math.round(cx + ex);
                if (eiy >= 0 && eiy < H && eix >= 0 && eix < W) { grid[eiy][eix] = ' '; bright[eiy][eix] = 0; }
            }
        }
    }
    grid[Math.round(cy)][Math.round(cx)] = '\u25C9';
    bright[Math.round(cy)][Math.round(cx)] = 6;

    // Build colored HTML — 6 tiers for smooth gradient
    var colors = ['', 'rgba(34,211,238,0.12)', 'rgba(34,211,238,0.24)', 'rgba(34,211,238,0.40)', 'rgba(34,211,238,0.62)', 'rgba(34,211,238,0.85)', '#22d3ee'];
    var lines = [];
    for (r = 0; r < H; r++) {
        var line = '';
        var curBright = 0;
        for (c = 0; c < W; c++) {
            var b2 = bright[r][c];
            if (b2 !== curBright) {
                if (curBright > 0) line += '</span>';
                if (b2 > 0) line += '<span style="color:' + colors[b2] + '">';
                curBright = b2;
            }
            line += grid[r][c];
        }
        if (curBright > 0) line += '</span>';
        lines.push(line);
    }
    return lines.join('\n');
}

// Supplement API case_meta with local frontend metadata when fields are missing.
// This handles cases where the API's merge metadata may not be deployed.
function _enrichCaseMeta(meta) {
    if (!meta) meta = {};
    if ((!meta.storm_name || meta.storm_name === '') && currentCaseIndex !== null) {
        var d = _getActiveData();
        if (d) {
            var local = d.cases.find(function(c) { return c.case_index === currentCaseIndex; });
            if (local) {
                if (!meta.storm_name) meta.storm_name = local.storm_name || '';
                if (!meta.datetime) meta.datetime = local.datetime || '';
                if (meta.vmax_kt === undefined || meta.vmax_kt === null) meta.vmax_kt = local.vmax_kt;
                if (meta.rmw_km === undefined || meta.rmw_km === null) meta.rmw_km = local.rmw_km;
                if (!meta.mission_id) meta.mission_id = local.mission_id || '';
                if ((meta.sddc === undefined || meta.sddc === null || meta.sddc === 9999) && local.sddc !== undefined && local.sddc !== null && local.sddc !== 9999) meta.sddc = local.sddc;
            }
        }
    }
    return meta;
}

function _startRubberBand(plotDiv, pxA, pyA) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'cs-rubber-band';
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
    _csMouseHandler = function(e) {
        var rect = plotDiv.getBoundingClientRect();
        line.setAttribute('x2', e.clientX - rect.left);
        line.setAttribute('y2', e.clientY - rect.top);
        circle.setAttribute('cx', e.clientX - rect.left);
        circle.setAttribute('cy', e.clientY - rect.top);
    };
    plotDiv.addEventListener('mousemove', _csMouseHandler);
}

function _removeRubberBand() {
    var svg = document.getElementById('cs-rubber-band');
    if (svg) svg.remove();
    if (_csMouseHandler) {
        var plotDiv = document.getElementById('plotly-chart');
        if (plotDiv) plotDiv.removeEventListener('mousemove', _csMouseHandler);
        _csMouseHandler = null;
    }
}

function generateCustomPlot(callback) {
    if (currentCaseIndex === null) return;
    // Ensure Plotly is loaded before generating any plots
    if (typeof Plotly === 'undefined') {
        ensurePlotly(function() { generateCustomPlot(callback); });
        var resultDiv = document.getElementById('ep-result');
        if (resultDiv) resultDiv.innerHTML = '<div class="explorer-status loading">Loading visualization library\u2026</div>';
        return;
    }
    _lastAzJson = null;
    _lastSqJson = null;
    var variable = document.getElementById('ep-var').value;
    var level_km = document.getElementById('ep-level').value;
    _ga('generate_plan_view', { case_index: currentCaseIndex, variable: variable, level_km: level_km, data_type: _activeDataType });
    _updatePermalink();
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var resultDiv = document.getElementById('ep-result');
    var btn = document.getElementById('ep-btn');
    btn.disabled = true; btn.textContent = 'Generating\u2026';
    // Clear previous az/sq/cs results so stale data from a different variable doesn't persist
    var azResult = document.getElementById('az-result'); if (azResult) azResult.innerHTML = '';
    var sqResult = document.getElementById('sq-result'); if (sqResult) sqResult.innerHTML = '';
    var csResult = document.getElementById('cs-result'); if (csResult) csResult.innerHTML = '';
    var csStatus = document.getElementById('cs-status'); if (csStatus) csStatus.textContent = '';
    if (!_animPlaying) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        resultDiv.innerHTML = _hurricaneLoadingHTML('Fetching data from API\u2026 (may take ~30s if service is waking up)', true);
        var panelInner = document.getElementById('side-panel-inner');
        if (panelInner) panelInner.scrollTop = 0;
    }
    // Wind barbs are available for all variables (backend uses fallback U/V)
    var barbBtn = document.getElementById('barb-btn');
    if (barbBtn) { barbBtn.disabled = false; }
    var wantBarbs = _windBarbsEnabled;
    var wantTilt = _tiltProfileEnabled;
    var cacheKey = _activeDataType + '_' + currentCaseIndex + '_' + variable + '_' + level_km + '_' + overlay + (wantBarbs ? '_barbs' : '') + (wantTilt ? '_tilt' : '');
    if (_dataCache[cacheKey]) {
        renderPlotFromJSON(_dataCache[cacheKey], resultDiv);
        btn.disabled = false; btn.textContent = 'Generate Plan View';
        if (callback) callback(); return;
    }
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    var url = API_BASE + '/data?case_index=' + currentCaseIndex + '&variable=' + variable + '&level_km=' + level_km + '&data_type=' + _activeDataType + '';
    if (overlay) url += '&overlay=' + overlay;
    if (wantBarbs) url += '&wind_barbs=true';
    if (wantTilt) url += '&tilt_profile=true';
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) { _dataCache[cacheKey] = json; renderPlotFromJSON(json, resultDiv); if (callback) callback(); })
        .catch(function(err) {
            var msg = err.name === 'AbortError' ? '\u26A0\uFE0F Request timed out (90s). The API may be cold-starting \u2014 try again in a minute.' : '\u26A0\uFE0F ' + err.message;
            resultDiv.innerHTML = '<div class="explorer-status error">' + msg + '</div>'; animStop();
        })
        .finally(function() { clearTimeout(timeout); btn.disabled = false; btn.textContent = 'Generate Plan View'; });
}

// ── Contour overlay helper ────────────────────────────────────
function buildOverlayContours(json, x, y, isCS) {
    if (!json.overlay) return [];
    var ov = json.overlay;
    var ovData = isCS ? ov.cross_section : ov.data;
    if (!ovData) return [];
    try {
        var intInput = document.getElementById('ep-contour-int');
        var interval = intInput ? parseFloat(intInput.value) : NaN;
        if (isNaN(interval) || interval <= 0) {
            var flat = ovData.flat().filter(function(v) { return v !== null && !isNaN(v); });
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
        if (ov.vmin < -interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (\u2212)', showlegend: false }));
        return traces;
    } catch (e) { console.warn('Contour overlay error:', e); return []; }
}

// ── Colormap switcher ────────────────────────────────────────
var _defaultColorscale = null, _defaultVmin = null, _defaultVmax = null;

function applyCmap() {
    var sel = document.getElementById('ep-cmap'); if (!sel) return;
    var cs = sel.value;
    if (!cs && _defaultColorscale) cs = _defaultColorscale; if (!cs) return;
    var colorscale; try { colorscale = JSON.parse(cs); } catch(e) { colorscale = cs; }
    ['plotly-chart','plotly-fullscreen','cs-fullscreen','az-chart','az-fullscreen','sq-chart','sq-fullscreen'].forEach(function(id) {
        var plotDiv = document.getElementById(id);
        if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
        Plotly.restyle(plotDiv, { colorscale: [colorscale] }, [0]);
    });
    if (window._lastPlotlyData) window._lastPlotlyData.heatmap.colorscale = colorscale;
}

function _getActiveVmin() { var inp = document.getElementById('ep-vmin'); if (inp && inp.value !== '') return parseFloat(inp.value); return _defaultVmin; }
function _getActiveVmax() { var inp = document.getElementById('ep-vmax'); if (inp && inp.value !== '') return parseFloat(inp.value); return _defaultVmax; }

function applyColorRange() {
    var zmin = _getActiveVmin(), zmax = _getActiveVmax(); if (zmin === null || zmax === null) return;
    ['plotly-chart','plotly-fullscreen','cs-fullscreen','az-chart','az-fullscreen','sq-chart','sq-fullscreen'].forEach(function(id) {
        var plotDiv = document.getElementById(id);
        if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
        Plotly.restyle(plotDiv, { zmin: [zmin], zmax: [zmax] }, [0]);
    });
    if (window._lastPlotlyData) { window._lastPlotlyData.heatmap.zmin = zmin; window._lastPlotlyData.heatmap.zmax = zmax; }
}

function resetColorRange() {
    var vminInput = document.getElementById('ep-vmin'), vmaxInput = document.getElementById('ep-vmax');
    if (vminInput) vminInput.value = ''; if (vmaxInput) vmaxInput.value = '';
    if (_defaultVmin !== null && _defaultVmax !== null) {
        ['plotly-chart','plotly-fullscreen','cs-fullscreen','az-chart','az-fullscreen','sq-chart','sq-fullscreen'].forEach(function(id) {
            var plotDiv = document.getElementById(id);
            if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
            Plotly.restyle(plotDiv, { zmin: [_defaultVmin], zmax: [_defaultVmax] }, [0]);
        });
        if (window._lastPlotlyData) { window._lastPlotlyData.heatmap.zmin = _defaultVmin; window._lastPlotlyData.heatmap.zmax = _defaultVmax; }
    }
}

// ── Composite colormap / color range helpers ─────────────────
var _compDefaultColorscale = null;
var _compDefaultVmin = null;
var _compDefaultVmax = null;

function _getCompColorscale(fallback) {
    var sel = document.getElementById('comp-cmap');
    if (sel && sel.value) { try { return JSON.parse(sel.value); } catch(e) { return sel.value; } }
    return fallback;
}
function _getCompVmin(fallback) { var inp = document.getElementById('comp-vmin'); if (inp && inp.value !== '') return parseFloat(inp.value); return fallback; }
function _getCompVmax(fallback) { var inp = document.getElementById('comp-vmax'); if (inp && inp.value !== '') return parseFloat(inp.value); return fallback; }

function _allCompChartIds() {
    // Non-diff charts + diff-mode Group A, Group B, and Difference panels
    return [
        'comp-az-chart','comp-sq-chart','comp-pv-chart',
        'comp-diff-az-a','comp-diff-az-b','comp-diff-az-d',
        'comp-diff-sq-a','comp-diff-sq-b','comp-diff-sq-d',
        'comp-diff-pv-a','comp-diff-pv-b','comp-diff-pv-d',
        'comp-diff-irpv-a','comp-diff-irpv-b','comp-diff-irpv-d',
        'comp-diff-iraz-a','comp-diff-iraz-b','comp-diff-iraz-d'
    ];
}

function applyCompCmap() {
    var sel = document.getElementById('comp-cmap'); if (!sel) return;
    var cs = sel.value;
    if (!cs && _compDefaultColorscale) cs = _compDefaultColorscale; if (!cs) return;
    var colorscale; try { colorscale = JSON.parse(cs); } catch(e) { colorscale = cs; }
    _allCompChartIds().forEach(function(id) {
        var plotDiv = document.getElementById(id);
        if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
        // Restyle all heatmap traces (quadrant view has 4)
        var indices = plotDiv.data.map(function(_,i){return i;});
        var csArr = indices.map(function(){return colorscale;});
        Plotly.restyle(plotDiv, { colorscale: csArr }, indices);
    });
}

function applyCompColorRange() {
    var zmin = _getCompVmin(_compDefaultVmin), zmax = _getCompVmax(_compDefaultVmax);
    if (zmin === null || zmax === null) return;
    _allCompChartIds().forEach(function(id) {
        var plotDiv = document.getElementById(id);
        if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
        var indices = plotDiv.data.map(function(_,i){return i;});
        var zminArr = indices.map(function(){return zmin;});
        var zmaxArr = indices.map(function(){return zmax;});
        Plotly.restyle(plotDiv, { zmin: zminArr, zmax: zmaxArr }, indices);
    });
}

function resetCompColorRange() {
    var vminInput = document.getElementById('comp-vmin'), vmaxInput = document.getElementById('comp-vmax');
    if (vminInput) vminInput.value = ''; if (vmaxInput) vmaxInput.value = '';
    if (_compDefaultVmin !== null && _compDefaultVmax !== null) {
        _allCompChartIds().forEach(function(id) {
            var plotDiv = document.getElementById(id);
            if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
            var indices = plotDiv.data.map(function(_,i){return i;});
            var zminArr = indices.map(function(){return _compDefaultVmin;});
            var zmaxArr = indices.map(function(){return _compDefaultVmax;});
            Plotly.restyle(plotDiv, { zmin: zminArr, zmax: zmaxArr }, indices);
        });
    }
}

// ── Inline shading toolbar helpers (Step 4) ─────────────────
// These sync the inline toolbar on the Results step with the
// existing comp-cmap / comp-vmin / comp-vmax controls on Step 3,
// then trigger the same Plotly.restyle logic.

function _syncCompCmapFromInline() {
    var inline = document.getElementById('comp-cmap-inline');
    var master = document.getElementById('comp-cmap');
    if (inline && master) { master.value = inline.value; }
    applyCompCmap();
}

function _syncCompRangeFromInline() {
    var inMin = document.getElementById('comp-vmin-inline');
    var inMax = document.getElementById('comp-vmax-inline');
    var master_min = document.getElementById('comp-vmin');
    var master_max = document.getElementById('comp-vmax');
    if (inMin && master_min) master_min.value = inMin.value;
    if (inMax && master_max) master_max.value = inMax.value;
    applyCompColorRange();
}

function _resetCompShadingInline() {
    var inMin = document.getElementById('comp-vmin-inline');
    var inMax = document.getElementById('comp-vmax-inline');
    var inCmap = document.getElementById('comp-cmap-inline');
    if (inMin) inMin.value = '';
    if (inMax) inMax.value = '';
    if (inCmap) inCmap.value = '';
    resetCompColorRange();
    // Also reset colormap to default
    var master = document.getElementById('comp-cmap');
    if (master) { master.value = ''; applyCompCmap(); }
}

function _showCompShadingToolbar() {
    // No-op: replaced by per-result _buildShadingControlsRow() controls
}

// ── Per-result shading controls ─────────────────────────────────────────
// Registry: maps prefix → { chartIds, defaultColorscale, defaultVmin, defaultVmax }
var _shadingRegistry = {};

function _registerShadingTargets(prefix, chartIds, colorscale, vmin, vmax) {
    _shadingRegistry[prefix] = {
        chartIds: chartIds,
        defaultColorscale: colorscale,
        defaultVmin: vmin,
        defaultVmax: vmax
    };
}

var _SHADING_CMAP_OPTIONS =
    '<option value="">Default</option>' +
    '<optgroup label="Sequential"><option value="Viridis">Viridis</option><option value="Inferno">Inferno</option><option value="Magma">Magma</option><option value="Plasma">Plasma</option><option value="Cividis">Cividis</option><option value="Hot">Hot</option><option value="YlOrRd">YlOrRd</option><option value="YlGnBu">YlGnBu</option><option value="Blues">Blues</option><option value="Reds">Reds</option><option value="Greys">Greys</option></optgroup>' +
    '<optgroup label="Diverging"><option value="RdBu">RdBu</option><option value=\'[[0,&quot;rgb(5,10,172)&quot;],[0.5,&quot;rgb(255,255,255)&quot;],[1,&quot;rgb(178,10,28)&quot;]]\'>BuWtRd</option><option value="Picnic">Picnic</option><option value="Portland">Portland</option></optgroup>' +
    '<optgroup label="Other"><option value="Jet">Jet</option><option value="Rainbow">Rainbow</option><option value="Electric">Electric</option></optgroup>';

function _buildShadingControlsRow(prefix, opts) {
    if (!opts) opts = {};
    var label = opts.label || '';
    var labelHtml = label
        ? '<span class="cst-label" style="margin-right:4px;">' + label + '</span><span class="cst-sep"></span>'
        : '';
    return '<div class="comp-shading-toolbar" style="margin-top:8px;">' +
        '<div class="cst-row">' +
            labelHtml +
            '<label class="cst-label">Colormap</label>' +
            '<select id="' + prefix + '-cmap" class="cst-select" onchange="_applyShadingFor(\'' + prefix + '\')">' +
                _SHADING_CMAP_OPTIONS +
            '</select>' +
            '<span class="cst-sep"></span>' +
            '<label class="cst-label">Range</label>' +
            '<input type="number" id="' + prefix + '-vmin" class="cst-input" placeholder="' + (opts.defaultVmin != null ? opts.defaultVmin : 'min') + '" step="any" onchange="_applyShadingFor(\'' + prefix + '\')">' +
            '<span class="cst-to">to</span>' +
            '<input type="number" id="' + prefix + '-vmax" class="cst-input" placeholder="' + (opts.defaultVmax != null ? opts.defaultVmax : 'max') + '" step="any" onchange="_applyShadingFor(\'' + prefix + '\')">' +
            '<button class="cst-reset" onclick="_resetShadingFor(\'' + prefix + '\')" title="Reset to default">\u21BA</button>' +
        '</div>' +
    '</div>';
}

function _applyShadingFor(prefix) {
    var reg = _shadingRegistry[prefix];
    if (!reg) return;
    var cmapEl = document.getElementById(prefix + '-cmap');
    var vminEl = document.getElementById(prefix + '-vmin');
    var vmaxEl = document.getElementById(prefix + '-vmax');

    // Colorscale
    var cs = cmapEl ? cmapEl.value : '';
    if (!cs) cs = reg.defaultColorscale;
    else { try { cs = JSON.parse(cs); } catch(e) { /* string name like "Viridis" */ } }

    // Range
    var zmin = (vminEl && vminEl.value !== '') ? parseFloat(vminEl.value) : reg.defaultVmin;
    var zmax = (vmaxEl && vmaxEl.value !== '') ? parseFloat(vmaxEl.value) : reg.defaultVmax;

    reg.chartIds.forEach(function(id) {
        var plotDiv = document.getElementById(id);
        if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
        // Restyle all heatmap traces (quad view has 4) — leave contour overlays untouched
        var heatmapIndices = [];
        plotDiv.data.forEach(function(t, i) { if (t.type === 'heatmap') heatmapIndices.push(i); });
        if (!heatmapIndices.length) return;
        var csArr = heatmapIndices.map(function() { return cs; });
        var zminArr = heatmapIndices.map(function() { return zmin; });
        var zmaxArr = heatmapIndices.map(function() { return zmax; });
        Plotly.restyle(plotDiv, { colorscale: csArr, zmin: zminArr, zmax: zmaxArr }, heatmapIndices);
    });
}

function _resetShadingFor(prefix) {
    var reg = _shadingRegistry[prefix];
    if (!reg) return;
    var cmapEl = document.getElementById(prefix + '-cmap');
    var vminEl = document.getElementById(prefix + '-vmin');
    var vmaxEl = document.getElementById(prefix + '-vmax');
    if (cmapEl) cmapEl.value = '';
    if (vminEl) vminEl.value = '';
    if (vmaxEl) vmaxEl.value = '';
    _applyShadingFor(prefix);
}

// ── Tight data-extent helper for plan-view axes ─────────────
// Scans a 2D array and returns the bounding box of non-NaN/non-null
// cells in terms of the provided x/y coordinate arrays.  Falls back
// to the full grid extent when the data is entirely NaN.
function _tightDataExtent(zData, xCoords, yCoords, pad) {
    if (pad === undefined) pad = 0.25;
    var minCol = Infinity, maxCol = -Infinity;
    var minRow = Infinity, maxRow = -Infinity;
    for (var r = 0; r < zData.length; r++) {
        if (!zData[r]) continue;
        for (var c = 0; c < zData[r].length; c++) {
            var v = zData[r][c];
            if (v !== null && v !== undefined && isFinite(v)) {
                if (c < minCol) minCol = c;
                if (c > maxCol) maxCol = c;
                if (r < minRow) minRow = r;
                if (r > maxRow) maxRow = r;
            }
        }
    }
    if (!isFinite(minCol)) {
        // All NaN — fall back to full grid
        return {
            xMin: xCoords[0] - pad,
            xMax: xCoords[xCoords.length - 1] + pad,
            yMin: yCoords[0] - pad,
            yMax: yCoords[yCoords.length - 1] + pad
        };
    }
    return {
        xMin: xCoords[minCol] - pad,
        xMax: xCoords[maxCol] + pad,
        yMin: yCoords[minRow] - pad,
        yMax: yCoords[maxRow] + pad
    };
}

// ── Max value helper ─────────────────────────────────────────
function findDataMax(zData, xCoords, yCoords) {
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

function findDataMin(zData, xCoords, yCoords) {
    var minVal = Infinity, minI = 0, minJ = 0;
    for (var i = 0; i < zData.length; i++) {
        if (!zData[i]) continue;
        for (var j = 0; j < zData[i].length; j++) {
            var v = zData[i][j];
            if (v !== null && v !== undefined && isFinite(v) && v < minVal) {
                minVal = v; minI = i; minJ = j;
            }
        }
    }
    if (!isFinite(minVal)) return null;
    return { value: minVal, x: xCoords[minJ], y: yCoords[minI] };
}

function isWindVariable(varName) {
    return varName && varName.toLowerCase().indexOf('wind') !== -1;
}

function buildMaxMarkerTrace(maxInfo, units) {
    if (!maxInfo) return null;
    return {
        x: [maxInfo.x], y: [maxInfo.y], type: 'scatter', mode: 'markers+text',
        marker: { symbol: 'x', size: 10, color: 'white', line: { color: 'rgba(0,0,0,0.6)', width: 1.5 } },
        text: [''], textposition: 'top right',
        textfont: { color: 'white', size: 9 },
        hoverinfo: 'text',
        hovertext: ['Max: ' + maxInfo.value.toFixed(2) + ' ' + units + '\n@ (' + maxInfo.x.toFixed(0) + ', ' + maxInfo.y.toFixed(0) + ')'],
        showlegend: false
    };
}

function buildMaxAnnotation(maxInfo, units, xLabel, yLabel, fontSize) {
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

function renderPlotFromJSON(json, resultDiv) {
    // Hide thumbnail, show plot in its place
    var thumbWrap = document.getElementById('thumbnail-wrap');
    if (thumbWrap) thumbWrap.style.display = 'none';

    // Build dual-panel HTML: plan view (left) + azimuthal mean placeholder (right)
    resultDiv.innerHTML =
        '<div class="dual-panel-wrap" id="dual-panel-wrap">' +
            '<div class="dual-pane" id="dual-pane-left">' +
                '<div class="dual-pane-label">Plan View</div>' +
                '<div class="dual-pane-inner" style="position:relative;">' +
                    '<div id="plotly-chart" style="width:100%;height:100%;min-height:360px;"></div>' +
                    '<button onclick="openPlotModal()" title="Expand to fullscreen" style="position:absolute;top:6px;left:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:28px;height:28px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">\u26F6</button>' +
                '</div>' +
            '</div>' +
            '<div class="dual-pane-divider" title="Toggle azimuthal mean panel" onclick="_toggleDualPane()"></div>' +
            '<div class="dual-pane" id="dual-pane-right">' +
                '<div class="dual-pane-label">Azimuthal Mean</div>' +
                '<div class="dual-pane-inner" id="dual-az-container">' +
                    '<div class="az-pane-placeholder" id="dual-az-placeholder">Generating azimuthal mean\u2026</div>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover for values \u00b7 scroll to zoom \u00b7 drag to pan \u00b7 \u26F6 expand</div>';

    // Scroll panel to top so plot is visible
    var panelInner = document.getElementById('side-panel-inner');
    if (panelInner) panelInner.scrollTop = 0;

    var zData = json.data, x = json.x, y = json.y, varInfo = json.variable, meta = _enrichCaseMeta(json.case_meta);
    _currentSddc = (meta.sddc !== undefined && meta.sddc !== null && meta.sddc !== 9999) ? meta.sddc : null;
    _currentShdc = (meta.shdc !== undefined && meta.shdc !== null && meta.shdc !== 9999) ? meta.shdc : null;
    _currentMotionDir = (meta.motion_dir !== undefined && meta.motion_dir !== null && meta.motion_dir !== 9999) ? meta.motion_dir : null;
    _currentMotionSpd = (meta.motion_spd !== undefined && meta.motion_spd !== null && meta.motion_spd !== 9999) ? meta.motion_spd : null;
    _defaultColorscale = varInfo.colorscale; _defaultVmin = varInfo.vmin; _defaultVmax = varInfo.vmax;
    var vminInput = document.getElementById('ep-vmin'), vmaxInput = document.getElementById('ep-vmax');
    if (vminInput) vminInput.placeholder = varInfo.vmin; if (vmaxInput) vmaxInput.placeholder = varInfo.vmax;

    var cmapSel = document.getElementById('ep-cmap');
    var activeColorscale = varInfo.colorscale;
    if (cmapSel && cmapSel.value) { try { activeColorscale = JSON.parse(cmapSel.value); } catch(e) { activeColorscale = cmapSel.value; } }
    var activeVmin = _getActiveVmin(), activeVmax = _getActiveVmax();

    var vmaxStr = meta.vmax_kt ? ' | Vmax = ' + meta.vmax_kt + ' kt' : '';
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    var title = meta.storm_name + ' | ' + meta.datetime + vmaxStr + '<br>' + varInfo.display_name + ' @ ' + json.actual_level_km.toFixed(1) + ' km' + overlayLabel;

    var heatmap = { z: zData, x: x, y: y, type: 'heatmap', colorscale: activeColorscale, zmin: activeVmin, zmax: activeVmax, colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: 10 } }, tickfont: { color: '#ccc', size: 9 }, thickness: 12, len: 0.85 }, hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>X: %{x:.0f} km<br>Y: %{y:.0f} km<extra></extra>', hoverongaps: false };
    var shapes = [];
    if (meta.rmw_km && !isNaN(meta.rmw_km)) shapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: -meta.rmw_km, y0: -meta.rmw_km, x1: meta.rmw_km, y1: meta.rmw_km, line: { color: 'white', width: 1.5, dash: 'dash' } });

    var plotBg = '#0a1628';
    var baseLayout = { paper_bgcolor: plotBg, plot_bgcolor: plotBg, xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#aaa' } }, tickfont: { color: '#aaa' }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false, scaleanchor: 'y', range: [-250, 250] }, yaxis: { title: { text: 'Northward distance (km)', font: { color: '#aaa' } }, tickfont: { color: '#aaa' }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false, range: [-250, 250] }, shapes: shapes, hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } }, showlegend: false };
    var config = { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d','select2d','toggleSpikelines'], displaylogo: false };
    var smallLayout = Object.assign({}, baseLayout, { title: { text: title, font: { color: '#e5e7eb', size: 11 }, y: 0.98, x: 0.5, xanchor: 'center', yanchor: 'top' }, margin: { l: 52, r: 16, t: json.overlay ? 72 : 60, b: 44 }, xaxis: Object.assign({}, baseLayout.xaxis, { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 } }), yaxis: Object.assign({}, baseLayout.yaxis, { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 } }) });

    var overlayTraces = buildOverlayContours(json, x, y);

    // Max value marker + annotation
    var maxInfo = findDataMax(zData, x, y);
    var maxTraces = [];
    if (maxInfo) {
        var maxAnnot = buildMaxAnnotation(maxInfo, varInfo.units, 'X', 'Y', 9);
        if (maxAnnot) {
            smallLayout.annotations = (smallLayout.annotations || []).concat([maxAnnot]);
            baseLayout.annotations = (baseLayout.annotations || []).concat([maxAnnot]);
        }
        if (isWindVariable((document.getElementById('ep-var') || {}).value || '')) {
            var maxMarker = buildMaxMarkerTrace(maxInfo, varInfo.units);
            if (maxMarker) maxTraces.push(maxMarker);
        }
    }

    // Metadata strip with compass widget (above dual panel)
    var _metaStripHTML = '';
    {
        var compassHTML = buildShearCompassHTML(_currentSddc, _currentShdc, _currentMotionDir, _currentMotionSpd);
        var badgeParts = [];
        if (meta.vmax_kt) badgeParts.push('<span style="color:' + getIntensityColor(meta.vmax_kt) + ';">' + getIntensityCategory(meta.vmax_kt) + '</span> ' + meta.vmax_kt + ' kt');
        if (meta.rmw_km) badgeParts.push('RMW ' + meta.rmw_km + ' km');
        if (meta.tilt_magnitude_km != null) badgeParts.push('Tilt ' + meta.tilt_magnitude_km + ' km');
        var metaText = badgeParts.length ? '<span class="meta-text">' + badgeParts.join('  &middot;  ') + '</span>' : '';
        if (compassHTML || metaText) {
            _metaStripHTML = '<div class="dual-panel-strip">' + compassHTML + metaText + '</div>';
        }
    }

    // Shear + motion vectors now rendered as HTML compass in the metadata strip (not in Plotly)

    // Wind barbs overlay
    var barbShapes = [];
    if (json.wind_barbs) {
        var xArr = x, yArr = y;
        var axR = { xMin: xArr[0], xMax: xArr[xArr.length - 1], yMin: yArr[0], yMax: yArr[yArr.length - 1] };
        barbShapes = _buildPlanViewWindBarbs(json.wind_barbs, axR);
        smallLayout.shapes = (smallLayout.shapes || []).concat(barbShapes);
        baseLayout.shapes = (baseLayout.shapes || []).concat(barbShapes);
    }

    // Tilt profile overlay
    var tiltTraces = [];
    if (json.tilt_profile) {
        var tiltResult = _buildTiltProfileTrace(json.tilt_profile);
        if (tiltResult) {
            tiltTraces.push(tiltResult.line);
            tiltTraces.push(tiltResult.scatter);
            // Stack colorbars vertically: shrink wind colorbar to upper portion
            heatmap.colorbar = Object.assign({}, heatmap.colorbar, {
                len: 0.42, y: 0.98, yanchor: 'top', x: 1.01, xpad: 2
            });
        }
    }

    // Insert metadata strip above the dual panel wrap
    var dualWrap = document.getElementById('dual-panel-wrap');
    if (dualWrap && _metaStripHTML) {
        dualWrap.insertAdjacentHTML('beforebegin', _metaStripHTML);
    }

    Plotly.newPlot('plotly-chart', [heatmap].concat(overlayTraces).concat(maxTraces).concat(tiltTraces), smallLayout, config);
    window._lastPlotlyData = { heatmap: heatmap, overlayTraces: overlayTraces, maxTraces: maxTraces, tiltTraces: tiltTraces, baseLayout: baseLayout, title: title, config: config, barbShapes: barbShapes };

    // Re-apply MW overlay if it was visible (e.g. was shown as standalone before TDR was generated)
    if (_mwPlanViewVisible && (_mwStormGrid || (_mwIsRGB && _mwStormGridRGBb64))) _applyMWPlanViewOverlay();

    // Auto-generate azimuthal mean in the right pane (non-blocking)
    _autoFetchDualAzimuthalMean();

    var csBtn = document.getElementById('cs-btn'); if (csBtn) csBtn.disabled = false;
    var azBtn = document.getElementById('az-btn'); if (azBtn) azBtn.disabled = false;
    var sqBtn = document.getElementById('sq-btn'); if (sqBtn) sqBtn.disabled = false;
    var volBtn = document.getElementById('vol-btn'); if (volBtn) volBtn.disabled = false;
    var anomBtn = document.getElementById('anom-btn'); if (anomBtn) anomBtn.disabled = false;
    var cfadBtn = document.getElementById('cfad-btn'); if (cfadBtn) cfadBtn.disabled = false;
    document.getElementById('plotly-chart').on('plotly_click', handlePlotClick);

    // Auto-scroll the side panel to show the plot (skip during animation)
    if (!_animPlaying) {
        setTimeout(function() {
            var chartEl = document.getElementById('plotly-chart');
            if (chartEl) chartEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 150);
    }
}

// ── Height animation ─────────────────────────────────────────
function animToggle() { if (_animPlaying) animStop(); else animStart(); }
function animStart() { _animPlaying = true; var btn = document.getElementById('anim-play-btn'); if (btn) { btn.textContent = '\u23F8'; btn.classList.add('active'); } animTick(); }
function animStop() { _animPlaying = false; if (_animTimer) { clearTimeout(_animTimer); _animTimer = null; } var btn = document.getElementById('anim-play-btn'); if (btn) { btn.textContent = '\u25B6'; btn.classList.remove('active'); } }
function animTick() { if (!_animPlaying) return; generateCustomPlot(function() { if (!_animPlaying) return; _animTimer = setTimeout(function() { animStep(1); animTick(); }, 800); }); }
function animStep(dir) { var slider = document.getElementById('ep-level'); if (!slider) return; var val = parseFloat(slider.value) + dir * 0.5; if (val > 18) val = 0; if (val < 0) val = 18; slider.value = val; document.getElementById('ep-level-val').textContent = val.toFixed(1) + ' km'; if (!_animPlaying) generateCustomPlot(); }

// ── Cross-section ────────────────────────────────────────────
function toggleCrossSection() {
    _csMode = !_csMode; _csPointA = null; _removeRubberBand();
    var btn = document.getElementById('cs-btn'), status = document.getElementById('cs-status');
    if (_csMode) { btn.classList.add('active'); btn.textContent = '\u2702 Click point A on plot\u2026'; if (status) status.textContent = 'Click the starting point on the plan view above'; }
    else { btn.classList.remove('active'); btn.textContent = '\u2702 Draw Cross Section'; if (status) status.textContent = ''; }
}

function handlePlotClick(eventData) {
    if (!_csMode || !eventData.points || !eventData.points.length) return;
    var pt = eventData.points[0], x = pt.x, y = pt.y;
    var status = document.getElementById('cs-status'), plotDiv = document.getElementById('plotly-chart');
    if (!_csPointA) {
        _csPointA = { x: x, y: y };
        var btn = document.getElementById('cs-btn'); if (btn) btn.textContent = '\u2702 Click point B on plot\u2026';
        if (status) status.textContent = 'A: (' + x.toFixed(0) + ', ' + y.toFixed(0) + ') km \u2014 now click the end point';
        var currentShapes = (plotDiv.layout.shapes || []).slice();
        currentShapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: x-4, y0: y-4, x1: x+4, y1: y+4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } });
        Plotly.relayout(plotDiv, { shapes: currentShapes });
        var rect = plotDiv.getBoundingClientRect();
        _startRubberBand(plotDiv, eventData.event.clientX - rect.left, eventData.event.clientY - rect.top);
    } else {
        var a = _csPointA, b = { x: x, y: y };
        _csMode = false; _csPointA = null; _removeRubberBand();
        var btn2 = document.getElementById('cs-btn'); if (btn2) { btn2.classList.remove('active'); btn2.textContent = '\u2702 Draw Cross Section'; }
        if (status) status.textContent = 'A\u2192B: (' + a.x.toFixed(0) + ',' + a.y.toFixed(0) + ') \u2192 (' + b.x.toFixed(0) + ',' + b.y.toFixed(0) + ') km';
        var currentShapes2 = (plotDiv.layout.shapes || []).slice();
        var csShapes = [
            { type: 'line', xref: 'x', yref: 'y', x0: a.x, y0: a.y, x1: b.x, y1: b.y, line: { color: '#ef4444', width: 2.5 } },
            { type: 'circle', xref: 'x', yref: 'y', x0: b.x-4, y0: b.y-4, x1: b.x+4, y1: b.y+4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } }
        ];
        Plotly.relayout(plotDiv, { shapes: currentShapes2.concat(csShapes) });
        if (window._lastPlotlyData) {
            var baseShapes = window._lastPlotlyData.baseLayout.shapes || [];
            window._lastPlotlyData.baseLayout.shapes = baseShapes.concat(csShapes).concat([{ type: 'circle', xref: 'x', yref: 'y', x0: a.x-4, y0: a.y-4, x1: a.x+4, y1: a.y+4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } }]);
        }
        fetchCrossSection(a, b);
    }
}

function fetchCrossSection(a, b) {
    var variable = document.getElementById('ep-var').value;
    _ga('cross_section', { case_index: currentCaseIndex, variable: variable, data_type: _activeDataType });
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var csResult = document.getElementById('cs-result'); if (!csResult) return;
    csResult.innerHTML = _hurricaneLoadingHTML('Computing cross-section\u2026', true);
    var url = API_BASE + '/cross_section?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=' + _activeDataType + '&x0=' + a.x + '&y0=' + a.y + '&x1=' + b.x + '&y1=' + b.y + '&n_points=150';
    if (overlay) url += '&overlay=' + overlay;
    fetch(url)
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) { csResult.innerHTML = '<div class="explorer-status" style="color:#10b981;">\u2713 Cross-section ready \u2014 opening expanded view</div>'; openPlotModal(json); })
        .catch(function(err) { csResult.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + err.message + '</div>'; });
}

function renderCrossSectionInto(targetId, json, fullsize) {
    var el = document.getElementById(targetId); if (!el) return;
    var csData = json.cross_section, distance_km = json.distance_km, height_km = json.height_km, varInfo = json.variable, meta = _enrichCaseMeta(json.case_meta), ep = json.endpoints;
    var fontSize = fullsize ? { title:13,axis:12,tick:10,cbar:12,cbarTick:10,hover:13 } : { title:10,axis:9,tick:8,cbar:9,cbarTick:8,hover:11 };
    var csColorscale = varInfo.colorscale;
    var cmapSel = document.getElementById('ep-cmap');
    if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch(e) { csColorscale = cmapSel.value; } }
    var av = _getActiveVmin(), avx = _getActiveVmax();
    var heatmap = { z: csData, x: distance_km, y: height_km, type: 'heatmap', colorscale: csColorscale, zmin: av !== null ? av : varInfo.vmin, zmax: avx !== null ? avx : varInfo.vmax, colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: fontSize.cbar } }, tickfont: { color: '#ccc', size: fontSize.cbarTick }, thickness: fullsize?14:10, len: 0.85 }, hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>Distance: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>', hoverongaps: false };
    var csOverlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    var title = 'Cross Section: (' + ep.x0.toFixed(0) + ',' + ep.y0.toFixed(0) + ') \u2192 (' + ep.x1.toFixed(0) + ',' + ep.y1.toFixed(0) + ') km' + csOverlayLabel;
    var plotBg = '#0a1628';
    var layout = { title: { text: title, font: { color: '#e5e7eb', size: fontSize.title }, y: 0.97, x: 0.5, xanchor: 'center' }, paper_bgcolor: plotBg, plot_bgcolor: plotBg, xaxis: { title: { text: 'Distance along line (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false }, yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false }, margin: fullsize ? { l:55,r:24,t:json.overlay?70:50,b:46 } : { l:45,r:12,t:json.overlay?62:44,b:38 }, hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: fontSize.hover } }, showlegend: false };
    var csOverlayTraces = buildOverlayContours(json, null, null, true);

    // Max value marker + annotation for cross-section
    var csMaxInfo = findDataMax(csData, distance_km, height_km);
    var csMaxTraces = [];
    if (csMaxInfo) {
        var csMaxAnnot = buildMaxAnnotation(csMaxInfo, varInfo.units, 'Dist', 'Z', fullsize ? 10 : 8);
        if (csMaxAnnot) layout.annotations = (layout.annotations || []).concat([csMaxAnnot]);
        if (isWindVariable((document.getElementById('ep-var') || {}).value || '')) {
            var csMaxMarker = buildMaxMarkerTrace(csMaxInfo, varInfo.units);
            if (csMaxMarker) csMaxTraces.push(csMaxMarker);
        }
    }

    // Shear vector inset for cross-section
    var csShearInset = buildShearInsetCS(_currentSddc, fullsize, _currentShdc);
    if (csShearInset.annotations.length) layout.annotations = (layout.annotations || []).concat(csShearInset.annotations);
    if (csShearInset.shapes.length) layout.shapes = (layout.shapes || []).concat(csShearInset.shapes);

    Plotly.newPlot(targetId, [heatmap].concat(csOverlayTraces).concat(csMaxTraces), layout, { responsive: true, displayModeBar: fullsize, displaylogo: false, modeBarButtonsToRemove: ['lasso2d','select2d','toggleSpikelines'] });
}

// ── Dual-pane toggle ─────────────────────────────────────────
function _toggleDualPane() {
    var wrap = document.getElementById('dual-panel-wrap');
    if (!wrap) return;
    wrap.classList.toggle('collapsed');
    // Re-layout Plotly charts after CSS transition
    setTimeout(function() {
        var chart = document.getElementById('plotly-chart');
        if (chart && chart.data) Plotly.Plots.resize(chart);
        var azChart = document.getElementById('dual-az-chart');
        if (azChart && azChart.data) Plotly.Plots.resize(azChart);
    }, 50);
}

// ── Auto-fetch azimuthal mean into the right dual pane ────────
function _autoFetchDualAzimuthalMean() {
    if (currentCaseIndex === null) return;
    var variable = document.getElementById('ep-var').value;
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var covSlider = document.getElementById('az-coverage');
    var coverage = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;
    var placeholder = document.getElementById('dual-az-placeholder');

    // Check cache first
    var azCacheKey = 'az_' + _activeDataType + '_' + currentCaseIndex + '_' + variable + '_' + coverage + '_' + overlay;
    if (_dataCache[azCacheKey]) {
        _lastAzJson = _dataCache[azCacheKey];
        _renderDualAzimuthalMean(_dataCache[azCacheKey]);
        var azBtn = document.getElementById('az-btn'); if (azBtn) azBtn.disabled = false;
        return;
    }

    if (placeholder) placeholder.textContent = 'Generating azimuthal mean\u2026';

    var url = API_BASE + '/azimuthal_mean?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=' + _activeDataType + '&coverage_min=' + coverage;
    if (overlay && overlay !== 'none') url += '&overlay=' + overlay;

    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) {
            _dataCache[azCacheKey] = json;
            _lastAzJson = json; _lastHybridAzJson = null; _lastAnomalyAzJson = null; _lastVPScatterJson = null;
            _renderDualAzimuthalMean(json);
            // Also enable the az button
            var azBtn = document.getElementById('az-btn'); if (azBtn) azBtn.disabled = false;
        })
        .catch(function(err) {
            var container = document.getElementById('dual-az-container');
            if (container) container.innerHTML = '<div class="az-pane-placeholder" style="color:#f87171;font-style:normal;font-size:0.7rem;">' + (err.name === 'AbortError' ? 'Timed out' : err.message) + '</div>';
        })
        .finally(function() { clearTimeout(timeout); });
}

// Render azimuthal mean into the dual-pane right panel
function _renderDualAzimuthalMean(json) {
    var container = document.getElementById('dual-az-container');
    if (!container) return;

    var azData = json.azimuthal_mean, radius_km = json.radius_km, height_km = json.height_km, varInfo = json.variable, meta = _enrichCaseMeta(json.case_meta);
    // Match font sizes to plan view (axis: 10, tick: 9, title: 11)
    var fontSize = { title:11, axis:10, tick:9, cbar:10, cbarTick:9, hover:11 };
    var csColorscale = varInfo.colorscale;
    var cmapSel = document.getElementById('ep-cmap');
    if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch(e) { csColorscale = cmapSel.value; } }
    var av = _getActiveVmin(), avx = _getActiveVmax();

    var heatmap = { z: azData, x: radius_km, y: height_km, type: 'heatmap', colorscale: csColorscale,
        zmin: av !== null ? av : varInfo.vmin, zmax: avx !== null ? avx : varInfo.vmax,
        colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: fontSize.cbar } }, tickfont: { color: '#ccc', size: fontSize.cbarTick }, thickness: 12, len: 0.85 },
        hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>', hoverongaps: false };

    var azOverlayTraces = buildAzOverlayContours(json, radius_km, height_km);
    var covPct = Math.round((json.coverage_min || 0.5) * 100);
    var vmaxStr = meta.vmax_kt ? ' | Vmax = ' + meta.vmax_kt + ' kt' : '';
    var title = meta.storm_name + ' | ' + meta.datetime + vmaxStr + '<br>Azimuthal Mean: ' + varInfo.display_name + ' (\u2265' + covPct + '%)';
    var shapes = [];
    if (meta.rmw_km && !isNaN(meta.rmw_km)) shapes.push({ type:'line',xref:'x',yref:'paper',x0:meta.rmw_km,x1:meta.rmw_km,y0:0,y1:1,line:{color:'white',width:1.5,dash:'dash'} });

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

    // Max value marker
    var azMaxInfo = findDataMax(azData, radius_km, height_km);
    var azMaxTraces = [];
    if (azMaxInfo) {
        var azMaxAnnot = buildMaxAnnotation(azMaxInfo, varInfo.units, 'R', 'Z', 9);
        if (azMaxAnnot) layout.annotations = (layout.annotations || []).concat([azMaxAnnot]);
        if (isWindVariable((document.getElementById('ep-var') || {}).value || '')) {
            var azMaxMarker = buildMaxMarkerTrace(azMaxInfo, varInfo.units);
            if (azMaxMarker) azMaxTraces.push(azMaxMarker);
        }
    }

    // No shear inset on azimuthal mean — it's already on the plan view

    container.innerHTML = '<div id="dual-az-chart" style="width:100%;height:100%;min-height:320px;"></div>';
    Plotly.newPlot('dual-az-chart', [heatmap].concat(azOverlayTraces).concat(azMaxTraces), layout, { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d','select2d','toggleSpikelines'], displaylogo: false });
}

// ── Azimuthal Mean (dispatcher for coordinate mode selector) ──
// Routes to the correct fetch function based on the az-coord-mode dropdown
function dispatchAzimuthalMean() {
    _ga('azimuthal_mean', { case_index: currentCaseIndex, data_type: _activeDataType });
    var mode = (document.getElementById('az-coord-mode') || {}).value || 'standard';
    if (mode === 'hybrid') {
        fetchHybridAzimuthalMean();
    } else if (mode === 'anomaly') {
        fetchAnomalyAzimuthalMean();
    } else {
        fetchAzimuthalMean();
    }
}

var _lastAzJson = null;

function fetchAzimuthalMean() {
    if (currentCaseIndex === null) return;
    var variable = document.getElementById('ep-var').value;
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var covSlider = document.getElementById('az-coverage');
    var coverage = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;
    var resultDiv = document.getElementById('az-result'), btn = document.getElementById('az-btn');
    resultDiv.innerHTML = _hurricaneLoadingHTML('Computing azimuthal mean\u2026', true);
    btn.disabled = true; btn.textContent = '\u27F3 Computing\u2026';
    var url = API_BASE + '/azimuthal_mean?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=' + _activeDataType + '&coverage_min=' + coverage;
    if (overlay && overlay !== 'none') url += '&overlay=' + overlay;
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) { _lastAzJson = json; _lastHybridAzJson = null; _lastAnomalyAzJson = null; _lastVPScatterJson = null; renderAzimuthalMeanInto('az-result', json, false); openPlotModal(); })
        .catch(function(err) { resultDiv.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (err.name === 'AbortError' ? 'Request timed out (90s).' : err.message) + '</div>'; })
        .finally(function() { clearTimeout(timeout); btn.disabled = false; btn.textContent = '\u27F3 Azimuthal Mean'; });
}


// ── Hybrid R_H Azimuthal Mean (Fischer et al. 2025) ─────────────────────

var _lastHybridAzJson = null;

function fetchHybridAzimuthalMean() {
    if (currentCaseIndex === null) return;
    var variable = document.getElementById('ep-var').value;
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var covSlider = document.getElementById('az-coverage');
    var coverage = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;
    var resultDiv = document.getElementById('az-result'), btn = document.getElementById('az-btn');
    resultDiv.innerHTML = _hurricaneLoadingHTML('Computing hybrid R\u2095 azimuthal mean\u2026', true);
    if (btn) { btn.disabled = true; btn.textContent = '\u27F3 Computing\u2026'; }
    var url = API_BASE + '/hybrid/azimuthal_mean?case_index=' + currentCaseIndex +
              '&variable=' + variable + '&data_type=' + _activeDataType +
              '&coverage_min=' + coverage;
    if (overlay && overlay !== 'none') url += '&overlay=' + overlay;
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) { _lastHybridAzJson = json; _lastAzJson = null; _lastAnomalyAzJson = null; _lastVPScatterJson = null; renderHybridAzimuthalMeanInto('az-result', json, false); openPlotModal(); })
        .catch(function(err) { resultDiv.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (err.name === 'AbortError' ? 'Request timed out (90s).' : err.message) + '</div>'; })
        .finally(function() { clearTimeout(timeout); if (btn) { btn.disabled = false; btn.textContent = '\u27F3 Azim. Mean'; } });
}


// ── Z-Score Anomaly Azimuthal Mean (Fischer et al. 2025) ────────────────

var _lastAnomalyAzJson = null;

function fetchAnomalyAzimuthalMean() {
    if (currentCaseIndex === null) return;
    var variable = document.getElementById('ep-var').value;
    var resultDiv = document.getElementById('az-result'), btn = document.getElementById('az-btn');
    resultDiv.innerHTML = _hurricaneLoadingHTML('Computing Z-score anomaly\u2026', true);
    if (btn) { btn.disabled = true; btn.textContent = '\u27F3 Computing\u2026'; }
    var url = API_BASE + '/anomaly/azimuthal_mean?case_index=' + currentCaseIndex +
              '&variable=' + variable + '&data_type=' + _activeDataType;
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) { _lastAnomalyAzJson = json; _lastAzJson = null; _lastHybridAzJson = null; _lastVPScatterJson = null; renderAnomalyAzimuthalMeanInto('az-result', json, false); openPlotModal(); })
        .catch(function(err) { resultDiv.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (err.name === 'AbortError' ? 'Request timed out (90s).' : err.message) + '</div>'; })
        .finally(function() { clearTimeout(timeout); if (btn) { btn.disabled = false; btn.textContent = '\u27F3 Azim. Mean'; } });
}


// ── VP vs Vortex Favorability Scatter (Fig. 9) ──────────────────────────

var _lastVPScatterJson = null;

function fetchVPScatter(colorBy) {
    colorBy = colorBy || 'dvmax_12h';
    var resultDiv = document.getElementById('az-result');
    var btn = document.getElementById('vp-scatter-btn');
    resultDiv.innerHTML = _hurricaneLoadingHTML('Loading VP scatter data\u2026', true);
    if (btn) { btn.disabled = true; btn.textContent = '\u27F3 Loading\u2026'; }
    var url = API_BASE + '/scatter/vp_favorability?data_type=merge&color_by=' + colorBy;
    fetch(url, { cache: 'no-store' })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) { _lastVPScatterJson = json; _lastAzJson = null; _lastHybridAzJson = null; _lastAnomalyAzJson = null; renderVPScatterInto('az-result', json, false); openPlotModal(); })
        .catch(function(err) { resultDiv.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + err.message + '</div>'; })
        .finally(function() { if (btn) { btn.disabled = false; btn.textContent = '\u2B24 VP Scatter'; } });
}


function renderAzimuthalMeanInto(targetId, json, fullsize) {
    var el = document.getElementById(targetId); if (!el) return;
    var azData = json.azimuthal_mean, radius_km = json.radius_km, height_km = json.height_km, varInfo = json.variable, meta = _enrichCaseMeta(json.case_meta);
    if (meta.sddc !== undefined && meta.sddc !== null && meta.sddc !== 9999) _currentSddc = meta.sddc;
    var fontSize = fullsize ? { title:13,axis:12,tick:10,cbar:12,cbarTick:10,hover:13 } : { title:10,axis:9,tick:8,cbar:9,cbarTick:8,hover:11 };
    var csColorscale = varInfo.colorscale;
    var cmapSel = document.getElementById('ep-cmap');
    if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch(e) { csColorscale = cmapSel.value; } }
    var av = _getActiveVmin(), avx = _getActiveVmax();
    var heatmap = { z: azData, x: radius_km, y: height_km, type: 'heatmap', colorscale: csColorscale, zmin: av !== null ? av : varInfo.vmin, zmax: avx !== null ? avx : varInfo.vmax, colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: fontSize.cbar } }, tickfont: { color: '#ccc', size: fontSize.cbarTick }, thickness: fullsize?14:10, len: 0.85 }, hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>', hoverongaps: false };
    var azOverlayTraces = buildAzOverlayContours(json, radius_km, height_km);
    var vmaxStr = meta.vmax_kt ? ' | Vmax = ' + meta.vmax_kt + ' kt' : '';
    var covPct = Math.round((json.coverage_min || 0.5) * 100);
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    var title = meta.storm_name + ' | ' + meta.datetime + vmaxStr + '<br>Azimuthal Mean: ' + varInfo.display_name + ' (\u2265' + covPct + '% coverage)' + overlayLabel;
    var shapes = [];
    if (meta.rmw_km && !isNaN(meta.rmw_km)) shapes.push({ type:'line',xref:'x',yref:'paper',x0:meta.rmw_km,x1:meta.rmw_km,y0:0,y1:1,line:{color:'white',width:1.5,dash:'dash'} });
    var plotBg = '#0a1628';
    var layout = { title: { text: title, font: { color: '#e5e7eb', size: fontSize.title }, y: 0.97, x: 0.5, xanchor: 'center' }, paper_bgcolor: plotBg, plot_bgcolor: plotBg, xaxis: { title: { text: 'Radius (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false }, yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false }, margin: fullsize ? { l:55,r:24,t:json.overlay?96:80,b:46 } : { l:45,r:12,t:json.overlay?78:64,b:38 }, shapes: shapes, hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: fontSize.hover } }, showlegend: false };

    // Max value marker + annotation for azimuthal mean
    var azMaxInfo = findDataMax(azData, radius_km, height_km);
    var azMaxTraces = [];
    if (azMaxInfo) {
        var azMaxAnnot = buildMaxAnnotation(azMaxInfo, varInfo.units, 'R', 'Z', fullsize ? 10 : 8);
        if (azMaxAnnot) layout.annotations = (layout.annotations || []).concat([azMaxAnnot]);
        if (isWindVariable((document.getElementById('ep-var') || {}).value || '')) {
            var azMaxMarker = buildMaxMarkerTrace(azMaxInfo, varInfo.units);
            if (azMaxMarker) azMaxTraces.push(azMaxMarker);
        }
    }

    // Shear vector inset for azimuthal mean
    var azShearInset = buildShearInsetCS(_currentSddc, fullsize, _currentShdc);
    if (azShearInset.annotations.length) layout.annotations = (layout.annotations || []).concat(azShearInset.annotations);
    if (azShearInset.shapes.length) layout.shapes = (layout.shapes || []).concat(azShearInset.shapes);

    if (!fullsize) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        el.innerHTML = '<div style="position:relative;"><div id="az-chart" style="width:100%;height:340px;border-radius:6px;overflow:hidden;"></div>' + _archSaveBtnHTML('az-chart', 'TDR_AzMean') + _archExportBtnHTML('exportAzMeanCSV','exportAzMeanJSON','az-exp-drop',74) + '<button onclick="openPlotModal()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">\u26F6</button></div><div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover \u00b7 zoom \u00b7 pan \u00b7 \u26F6 expand</div>';
        Plotly.newPlot('az-chart', [heatmap].concat(azOverlayTraces).concat(azMaxTraces), layout, { responsive:true,displayModeBar:false,displaylogo:false });
        var panelInner = document.getElementById('side-panel-inner');
        if (panelInner) panelInner.scrollTop = 0;
    } else {
        Plotly.newPlot(targetId, [heatmap].concat(azOverlayTraces).concat(azMaxTraces), layout, { responsive:true,displayModeBar:true,displaylogo:false,modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
    }
}

// ── Hybrid R_H Azimuthal Mean Renderer ──────────────────────────────────

var _fischerCitation = {
    text: 'Fischer et al. (2025, MWR) | doi:10.1175/MWR-D-24-0118.1',
    xref: 'paper', yref: 'paper', x: 1.0, y: -0.01,
    xanchor: 'right', yanchor: 'top', showarrow: false,
    font: { color: 'rgba(150,150,150,0.5)', size: 8 }
};

function _buildHybridXAxis(rHAxis, nInner) {
    // Build tick labels for the hybrid coordinate
    // Inner bins: show as fraction of RMW (e.g., 0.2, 0.4, ..., 0.8)
    // Outer bins: show as "RMW", "+20", "+40", etc.
    var tickvals = [], ticktext = [];
    for (var i = 0; i < rHAxis.length; i++) {
        if (i < nInner) {
            // Inner: show every 0.2 R*
            var val = rHAxis[i];
            if (Math.abs(val % 0.2) < 0.03) {
                tickvals.push(i);
                ticktext.push((val).toFixed(1));
            }
        } else {
            // Outer: show at RMW, +20, +40, +60, +80, +100
            var km = rHAxis[i];
            if (i === nInner) {
                tickvals.push(i);
                ticktext.push('RMW');
            } else {
                // Snap to nearest 20-km mark; only label once per target
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

function renderHybridAzimuthalMeanInto(targetId, json, fullsize) {
    var el = document.getElementById(targetId); if (!el) return;
    var azData = json.azimuthal_mean, rHAxis = json.r_h_axis, nInner = json.n_inner;
    var height_km = json.height_km, varInfo = json.variable, meta = _enrichCaseMeta(json.case_meta);

    var fontSize = fullsize ? { title:13,axis:12,tick:10,cbar:12,cbarTick:10 } : { title:10,axis:9,tick:8,cbar:9,cbarTick:8 };
    var csColorscale = varInfo.colorscale;
    var cmapSel = document.getElementById('ep-cmap');
    if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch(e) { csColorscale = cmapSel.value; } }

    var xIdxArr = []; for (var i = 0; i < rHAxis.length; i++) xIdxArr.push(i);
    var ticks = _buildHybridXAxis(rHAxis, nInner);

    var heatmap = {
        z: azData, x: xIdxArr, y: height_km, type: 'heatmap',
        colorscale: csColorscale, zmin: varInfo.vmin, zmax: varInfo.vmax,
        colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: fontSize.cbar } },
                    tickfont: { color: '#ccc', size: fontSize.cbarTick }, thickness: fullsize?14:10, len: 0.85 },
        hoverongaps: false
    };

    var vmaxStr = meta.vmax_kt ? ' | Vmax = ' + meta.vmax_kt + ' kt' : '';
    var rmwStr = meta.rmw_km ? ' | RMW = ' + meta.rmw_km + ' km' : '';
    var title = meta.storm_name + ' | ' + meta.datetime + vmaxStr + rmwStr +
                '<br>Hybrid R\u2095 Azimuthal Mean: ' + varInfo.display_name;

    var shapes = [{
        type: 'line', xref: 'x', yref: 'paper',
        x0: nInner, x1: nInner, y0: 0, y1: 1,
        line: { color: 'rgba(255,255,255,0.5)', width: 1.5, dash: 'dash' }
    }];

    var plotBg = '#0a1628';
    var layout = {
        title: { text: title, font: { color: '#e5e7eb', size: fontSize.title }, y: 0.97, x: 0.5, xanchor: 'center' },
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        xaxis: { title: { text: 'R\u2095 (RMW + km)', font: { color: '#aaa', size: fontSize.axis } },
                 tickvals: ticks.tickvals, ticktext: ticks.ticktext,
                 tickfont: { color: '#aaa', size: fontSize.tick },
                 gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
        yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } },
                 tickfont: { color: '#aaa', size: fontSize.tick },
                 gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
        margin: fullsize ? { l:55,r:24,t:80,b:46 } : { l:45,r:12,t:64,b:38 },
        shapes: shapes, showlegend: false,
        annotations: [_fischerCitation]
    };

    if (!fullsize) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        el.innerHTML = '<div style="position:relative;"><div id="az-chart" style="width:100%;height:340px;border-radius:6px;overflow:hidden;"></div>' + _archSaveBtnHTML('az-chart', 'TDR_HybridAzMean') + _archExportBtnHTML('exportAzMeanCSV','exportAzMeanJSON','az-exp-drop',74) + '<button onclick="openPlotModal()" title="Expand" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;">\u26F6</button></div>' +
            '<div style="text-align:right;margin-top:3px;"><a href="https://doi.org/10.1175/MWR-D-24-0118.1" target="_blank" rel="noopener" ' +
            'style="font-size:9px;color:rgba(180,195,220,0.5);text-decoration:none;" ' +
            'title="Fischer et al. (2025, MWR)">Fischer et al. 2025</a></div>';
        Plotly.newPlot('az-chart', [heatmap], layout, { responsive:true,displayModeBar:false });
    } else {
        Plotly.newPlot(targetId, [heatmap], layout, { responsive:true,displayModeBar:true,displaylogo:false });
    }
}


// ── Z-Score Anomaly Renderer ────────────────────────────────────────────

function renderAnomalyAzimuthalMeanInto(targetId, json, fullsize) {
    var el = document.getElementById(targetId); if (!el) return;

    if (json.error || !json.anomaly) {
        el.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (json.error || 'Anomaly data unavailable.') + '</div>';
        if (json.raw) {
            // Fall back to rendering raw hybrid field with natural colorbar range
            var vi = json.variable || {};
            var rawVar = Object.assign({}, vi, {
                vmin: vi.raw_vmin != null ? vi.raw_vmin : vi.vmin,
                vmax: vi.raw_vmax != null ? vi.raw_vmax : vi.vmax,
                colorscale: vi.raw_colorscale || vi.colorscale,
            });
            var fallback = Object.assign({}, json, { azimuthal_mean: json.raw, variable: rawVar });
            renderHybridAzimuthalMeanInto(targetId, fallback, fullsize);
        }
        return;
    }

    var anomData = json.anomaly, rHAxis = json.r_h_axis, nInner = json.n_inner;
    var height_km = json.height_km, varInfo = json.variable, meta = json.case_meta || {};

    var fontSize = fullsize ? { title:13,axis:12,tick:10,cbar:12,cbarTick:10 } : { title:10,axis:9,tick:8,cbar:9,cbarTick:8 };

    var xIdxArr = []; for (var i = 0; i < rHAxis.length; i++) xIdxArr.push(i);
    var ticks = _buildHybridXAxis(rHAxis, nInner);

    // Diverging colorscale for anomalies (RdBu_r)
    var anomColorscale = varInfo.colorscale || [
        [0.0, 'rgb(5,48,97)'], [0.1, 'rgb(33,102,172)'],
        [0.2, 'rgb(67,147,195)'], [0.3, 'rgb(146,197,222)'],
        [0.4, 'rgb(209,229,240)'], [0.5, 'rgb(247,247,247)'],
        [0.6, 'rgb(253,219,199)'], [0.7, 'rgb(244,165,130)'],
        [0.8, 'rgb(214,96,77)'], [0.9, 'rgb(178,24,43)'],
        [1.0, 'rgb(103,0,31)']
    ];

    var heatmap = {
        z: anomData, x: xIdxArr, y: height_km, type: 'heatmap',
        colorscale: anomColorscale, zmin: -3, zmax: 3, zmid: 0,
        colorbar: {
            title: { text: '\u03c3', font: { color: '#ccc', size: fontSize.cbar } },
            tickfont: { color: '#ccc', size: fontSize.cbarTick },
            thickness: fullsize?14:10, len: 0.85,
            tickvals: [-3, -2, -1, 0, 1, 2, 3],
        },
        hoverongaps: false,
        hovertemplate: '<b>Z-score</b>: %{z:.2f}\u03c3<br>R\u2095: %{customdata}<br>Height: %{y:.1f} km<extra></extra>',
        customdata: height_km.map(function() {
            return rHAxis.map(function(v, idx) {
                return idx < nInner ? (v.toFixed(2) + ' R/RMW') : ('+' + v.toFixed(0) + ' km');
            });
        })
    };

    var vmaxStr = meta.vmax_kt ? ' | Vmax = ' + meta.vmax_kt + ' kt' : '';
    var climInfo = json.clim_bin_kt ? ' (climo: \u00b110 kt of ' + json.clim_bin_kt + ' kt, n=' + json.clim_count + ')' : '';
    var title = (meta.storm_name || '') + ' | ' + (meta.datetime || '') + vmaxStr +
                '<br>Anomalous ' + varInfo.display_name + climInfo;

    var shapes = [{
        type: 'line', xref: 'x', yref: 'paper',
        x0: nInner, x1: nInner, y0: 0, y1: 1,
        line: { color: 'rgba(255,255,255,0.5)', width: 1.5, dash: 'dash' }
    }];

    var plotBg = '#0a1628';
    var layout = {
        title: { text: title, font: { color: '#e5e7eb', size: fontSize.title }, y: 0.97, x: 0.5, xanchor: 'center' },
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        xaxis: { title: { text: 'R\u2095 (RMW + km)', font: { color: '#aaa', size: fontSize.axis } },
                 tickvals: ticks.tickvals, ticktext: ticks.ticktext,
                 tickfont: { color: '#aaa', size: fontSize.tick },
                 gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
        yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } },
                 tickfont: { color: '#aaa', size: fontSize.tick },
                 gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
        margin: fullsize ? { l:55,r:24,t:96,b:46 } : { l:45,r:12,t:78,b:38 },
        shapes: shapes, showlegend: false,
        annotations: [_fischerCitation]
    };

    if (!fullsize) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        el.innerHTML = '<div style="position:relative;"><div id="az-chart" style="width:100%;height:340px;border-radius:6px;overflow:hidden;"></div>' + _archSaveBtnHTML('az-chart', 'TDR_Anomaly') + _archExportBtnHTML('exportAzMeanCSV','exportAzMeanJSON','az-exp-drop',74) + '<button onclick="openPlotModal()" title="Expand" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;">\u26F6</button></div>' +
            '<div style="text-align:right;margin-top:3px;"><a href="https://doi.org/10.1175/MWR-D-24-0118.1" target="_blank" rel="noopener" ' +
            'style="font-size:9px;color:rgba(180,195,220,0.5);text-decoration:none;" ' +
            'title="Fischer et al. (2025, MWR)">Fischer et al. 2025</a></div>';
        Plotly.newPlot('az-chart', [heatmap], layout, { responsive:true,displayModeBar:false });
    } else {
        Plotly.newPlot(targetId, [heatmap], layout, { responsive:true,displayModeBar:true,displaylogo:false });
    }
}


// ── VP vs Vortex Favorability Scatter Renderer ──────────────────────────

function renderVPScatterInto(targetId, json, fullsize) {
    var el = document.getElementById(targetId); if (!el) return;
    var points = json.points, ellipses = json.ellipses, colorBy = json.color_by;

    if (!points || points.length === 0) {
        el.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F No VP scatter data available. SHIPS variables (vmpi, rhlo, shgc) may not be in the Zarr stores.</div>';
        return;
    }

    // If vortex metrics haven't been computed yet (server still loading), show status
    if (json.vortex_ready === false) {
        var nVF = 0;
        for (var vi = 0; vi < points.length; vi++) {
            if (points[vi].vortex_favorability !== null && points[vi].vortex_favorability !== undefined) nVF++;
        }
        if (nVF === 0) {
            el.innerHTML = '<div class="explorer-status">\u23F3 Vortex metrics still loading on the server (' + points.length + ' cases have VP data). Please wait ~1 min and refresh.</div>';
            return;
        }
    }

    var fontSize = fullsize ? { title:13,axis:12,tick:10 } : { title:10,axis:9,tick:8 };

    // Separate points with and without vortex favorability
    var withVF = points.filter(function(p) { return p.vortex_favorability !== null && p.vortex_favorability !== undefined; });

    var traces = [];
    var dvmaxLabel = colorBy === 'dvmax_12h' ? '12-h \u0394Vmax (kt)' : '24-h \u0394Vmax (kt)';
    var dvmaxColorscale = [
        [0.0, 'rgb(0,128,128)'], [0.15, 'rgb(64,175,175)'],
        [0.3, 'rgb(140,210,210)'], [0.4, 'rgb(200,235,235)'],
        [0.5, 'rgb(245,245,245)'],
        [0.6, 'rgb(253,219,199)'], [0.7, 'rgb(244,165,130)'],
        [0.85, 'rgb(214,96,77)'], [1.0, 'rgb(178,24,43)']
    ];

    // ── Helper: build marker for background cases ──
    function buildMarker(dvs, showColorbar) {
        var m = {
            size: 7, color: dvs, colorscale: dvmaxColorscale, cmin: -30, cmax: 30,
            opacity: 0.85,
            line: { color: 'rgba(255,255,255,0.5)', width: 0.75 }
        };
        if (showColorbar) {
            m.colorbar = {
                title: { text: dvmaxLabel, font: { color: '#ccc', size: fontSize.tick } },
                tickfont: { color: '#ccc', size: fontSize.tick }, thickness: 12, len: 0.85
            };
        } else {
            m.showscale = false;
        }
        return m;
    }

    // ── Find current case in withVF for highlighting ──
    var curCase = null;
    for (var ci = 0; ci < withVF.length; ci++) {
        if (withVF[ci].case_index === currentCaseIndex) { curCase = withVF[ci]; break; }
    }

    if (withVF.length > 0) {
        var vps = withVF.map(function(p) { return p.vp; });
        var vfs = withVF.map(function(p) { return p.vortex_favorability; });
        var vhs = withVF.map(function(p) { return p.vortex_height; });
        var vws = withVF.map(function(p) { return p.vortex_width; });
        var dvs = withVF.map(function(p) { return p[colorBy] || 0; });
        var vmaxs = withVF.map(function(p) { return p.vmax_kt != null ? p.vmax_kt : ''; });
        var labels = withVF.map(function(p) { return p.storm_name + ' ' + p.datetime; });

        // ── Left panel: VP vs Vortex Favorability (xaxis, yaxis) ──
        traces.push({
            x: vps, y: vfs, mode: 'markers', type: 'scatter',
            xaxis: 'x', yaxis: 'y',
            marker: buildMarker(dvs, false),
            text: labels, customdata: vmaxs,
            hovertemplate: '<b>%{text}</b><br>Vmax: %{customdata} kt<br>VP: %{x:.1f}<br>Vortex Fav: %{y:.2f}<br>\u0394Vmax: %{marker.color:.0f} kt<extra></extra>',
            name: 'Cases', legendgroup: 'cases'
        });

        // ── Right panel: Vortex Width vs Vortex Height (xaxis2, yaxis2) ──
        traces.push({
            x: vws, y: vhs, mode: 'markers', type: 'scatter',
            xaxis: 'x2', yaxis: 'y2',
            marker: buildMarker(dvs, true),
            text: labels, customdata: vmaxs,
            hovertemplate: '<b>%{text}</b><br>Vmax: %{customdata} kt<br>Width: %{x:.2f}<br>Height: %{y:.2f}<br>\u0394Vmax: %{marker.color:.0f} kt<extra></extra>',
            name: 'Cases', legendgroup: 'cases', showlegend: false
        });
    }

    // ── 2σ ellipses (filtered: overwater, ≤100 kt) ──
    var grpColors = { RI: 'rgba(239,68,68,0.6)', SI: 'rgba(251,191,36,0.6)', NI: 'rgba(96,165,250,0.6)' };
    var dtlKey = colorBy === 'dvmax_24h' ? 'dtl_min_24h' : 'dtl_min_12h';

    // Filter for ellipse-eligible cases: overwater (DTL > 0) and Vmax ≤ 100 kt
    var ellipseEligible = withVF.filter(function(p) {
        if (p.vmax_kt == null || p.vmax_kt > 100) return false;
        var dtl = p[dtlKey];
        if (dtl == null || dtl <= 0) return false;
        return true;
    });

    // Group eligible cases by intensification rate
    var vpGroups = { RI: { vp: [], vf: [] }, SI: { vp: [], vf: [] }, NI: { vp: [], vf: [] } };
    var hwGroups = { RI: { h: [], w: [] }, SI: { h: [], w: [] }, NI: { h: [], w: [] } };
    var nEllipse = 0;
    for (var gi = 0; gi < ellipseEligible.length; gi++) {
        var p = ellipseEligible[gi];
        if (p.vortex_favorability === null || p.vortex_favorability === undefined) continue;
        var dv = p[colorBy] || 0;
        var gk = dv >= 20 ? 'RI' : (dv > 0 ? 'SI' : 'NI');
        vpGroups[gk].vp.push(p.vp);
        vpGroups[gk].vf.push(p.vortex_favorability);
        if (p.vortex_height != null && p.vortex_width != null) {
            hwGroups[gk].h.push(p.vortex_height);
            hwGroups[gk].w.push(p.vortex_width);
        }
        nEllipse++;
    }

    // Helper: compute mean and std of an array
    function _meanStd(arr) {
        var n = arr.length; if (n === 0) return { m: 0, s: 0 };
        var m = arr.reduce(function(a,b){return a+b;},0) / n;
        var s = Math.sqrt(arr.reduce(function(a,b){return a+(b-m)*(b-m);},0) / n);
        return { m: m, s: s };
    }

    var grpNames = ['RI', 'SI', 'NI'];
    for (var gIdx = 0; gIdx < grpNames.length; gIdx++) {
        var grp = grpNames[gIdx];
        var vg = vpGroups[grp];
        if (vg.vp.length < 3) continue;

        // Left panel ellipse (VP vs Favorability)
        var vpStat = _meanStd(vg.vp), vfStat = _meanStd(vg.vf);
        var ellX = [], ellY = [];
        for (var a = 0; a <= 360; a += 5) {
            var rad = a * Math.PI / 180;
            ellX.push(vpStat.m + 2 * vpStat.s * Math.cos(rad));
            ellY.push(vfStat.m + 2 * vfStat.s * Math.sin(rad));
        }
        traces.push({
            x: ellX, y: ellY, mode: 'lines', type: 'scatter',
            xaxis: 'x', yaxis: 'y',
            line: { color: grpColors[grp] || 'rgba(255,255,255,0.4)', width: 2, dash: 'dot' },
            name: grp + ' (2\u03c3, n=' + vg.vp.length + ')', legendgroup: grp, showlegend: true
        });
        traces.push({
            x: [vpStat.m], y: [vfStat.m], mode: 'markers', type: 'scatter',
            xaxis: 'x', yaxis: 'y',
            marker: { symbol: 'square', size: 10, color: grpColors[grp] || '#fff', line: { color: '#fff', width: 1 } },
            name: grp + ' mean', legendgroup: grp, showlegend: false
        });

        // Right panel ellipse (Width vs Height)
        var hw = hwGroups[grp];
        if (hw && hw.h.length >= 3) {
            var hStat = _meanStd(hw.h), wStat = _meanStd(hw.w);
            var eX2 = [], eY2 = [];
            for (var a2 = 0; a2 <= 360; a2 += 5) {
                var r2 = a2 * Math.PI / 180;
                eX2.push(wStat.m + 2 * wStat.s * Math.cos(r2));
                eY2.push(hStat.m + 2 * hStat.s * Math.sin(r2));
            }
            traces.push({
                x: eX2, y: eY2, mode: 'lines', type: 'scatter',
                xaxis: 'x2', yaxis: 'y2',
                line: { color: grpColors[grp] || 'rgba(255,255,255,0.4)', width: 2, dash: 'dot' },
                name: grp + ' (2\u03c3)', legendgroup: grp, showlegend: false
            });
            traces.push({
                x: [wStat.m], y: [hStat.m], mode: 'markers', type: 'scatter',
                xaxis: 'x2', yaxis: 'y2',
                marker: { symbol: 'square', size: 10, color: grpColors[grp] || '#fff', line: { color: '#fff', width: 1 } },
                name: grp + ' mean', legendgroup: grp, showlegend: false
            });
        }
    }

    // ── Current case highlight (rendered last = on top) ──
    if (curCase) {
        var curLabel = curCase.storm_name + ' ' + curCase.datetime;
        var curDv = curCase[colorBy] || 0;
        var curVmax = curCase.vmax_kt != null ? curCase.vmax_kt + ' kt' : 'N/A';
        var starStyle = {
            symbol: 'star', size: 18,
            color: '#facc15', opacity: 1,
            line: { color: '#ffffff', width: 2 }
        };
        // Left panel
        traces.push({
            x: [curCase.vp], y: [curCase.vortex_favorability],
            mode: 'markers', type: 'scatter',
            xaxis: 'x', yaxis: 'y',
            marker: starStyle,
            text: [curLabel],
            hovertemplate: '<b>%{text} \u2605</b><br>Vmax: ' + curVmax + '<br>VP: %{x:.1f}<br>Vortex Fav: %{y:.2f}<br>\u0394Vmax: ' + curDv + ' kt<extra></extra>',
            name: '\u2605 Current', legendgroup: 'current', showlegend: false
        });
        // Right panel
        if (curCase.vortex_height !== null && curCase.vortex_width !== null) {
            traces.push({
                x: [curCase.vortex_width], y: [curCase.vortex_height],
                mode: 'markers', type: 'scatter',
                xaxis: 'x2', yaxis: 'y2',
                marker: starStyle,
                text: [curLabel],
                hovertemplate: '<b>%{text} \u2605</b><br>Vmax: ' + curVmax + '<br>Width: %{x:.2f}<br>Height: %{y:.2f}<br>\u0394Vmax: ' + curDv + ' kt<extra></extra>',
                name: '\u2605 Current', legendgroup: 'current', showlegend: false
            });
        }
    }

    var plotBg = '#0a1628';
    var ellipseNote = nEllipse > 0 ? '  |  Ellipses: overwater, \u2264100 kt (n=' + nEllipse + ')' : '';
    var title = 'VP vs Vortex Favorability & Decomposition' + ellipseNote;
    var layout = {
        title: { text: title, font: { color: '#e5e7eb', size: fontSize.title }, y: 0.98, x: 0.5, xanchor: 'center' },
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        // Left panel: VP vs Favorability
        xaxis:  { title: { text: 'Ventilation Proxy', font: { color: '#aaa', size: fontSize.axis } },
                  tickfont: { color: '#aaa', size: fontSize.tick },
                  gridcolor: 'rgba(255,255,255,0.06)', zeroline: false,
                  domain: [0, 0.45] },
        yaxis:  { title: { text: 'Vortex Favorability', font: { color: '#aaa', size: fontSize.axis } },
                  tickfont: { color: '#aaa', size: fontSize.tick },
                  gridcolor: 'rgba(255,255,255,0.06)', zeroline: false },
        // Right panel: Vortex Height vs Width
        xaxis2: { title: { text: 'Anomalous Vortex Width (W1\u2013W2)', font: { color: '#aaa', size: fontSize.axis } },
                  tickfont: { color: '#aaa', size: fontSize.tick },
                  gridcolor: 'rgba(255,255,255,0.06)', zeroline: false,
                  domain: [0.55, 1.0], anchor: 'y2' },
        yaxis2: { title: { text: 'Anomalous Vortex Height (H1)', font: { color: '#aaa', size: fontSize.axis } },
                  tickfont: { color: '#aaa', size: fontSize.tick },
                  gridcolor: 'rgba(255,255,255,0.06)', zeroline: false,
                  anchor: 'x2' },
        margin: fullsize ? { l:60,r:60,t:60,b:65 } : { l:50,r:50,t:50,b:55 },
        showlegend: true,
        legend: { font: { color: '#aaa', size: 9 }, bgcolor: 'rgba(0,0,0,0.3)',
                  x: 0.46, y: 0.98, xanchor: 'right', yanchor: 'top',
                  orientation: 'h' },
        hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } },
        annotations: [Object.assign({}, _fischerCitation, { y: -0.12 })]
    };

    if (!fullsize) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        el.innerHTML = '<div style="position:relative;"><div id="az-chart" style="width:100%;height:360px;border-radius:6px;overflow:hidden;"></div>' + _archSaveBtnHTML('az-chart', 'VP_Scatter') + _archExportBtnHTML('exportVPScatterCSV','exportVPScatterJSON','vp-exp-drop',74) + '<button onclick="openPlotModal()" title="Expand" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;">\u26F6</button></div>' +
            '<div style="display:flex;gap:6px;justify-content:center;align-items:center;margin-top:6px;">' +
            '<button class="cs-btn" onclick="fetchVPScatter(\'dvmax_12h\')" style="font-size:10px;padding:2px 8px;">12-h \u0394Vmax</button>' +
            '<button class="cs-btn" onclick="fetchVPScatter(\'dvmax_24h\')" style="font-size:10px;padding:2px 8px;">24-h \u0394Vmax</button>' +
            '<a href="https://doi.org/10.1175/MWR-D-24-0118.1" target="_blank" rel="noopener" ' +
            'style="font-size:9px;color:rgba(180,195,220,0.5);text-decoration:none;margin-left:4px;" ' +
            'title="Fischer et al. (2025, MWR)">' +
            'Fischer et al. 2025</a>' +
            '</div>';
        Plotly.newPlot('az-chart', traces, layout, { responsive:true,displayModeBar:false });
    } else {
        Plotly.newPlot(targetId, traces, layout, { responsive:true,displayModeBar:true,displaylogo:false });
    }
}


// ── Single-Case CFAD ────────────────────────────────────────────
var _lastCFADJson = null;

function toggleSingleCFADConfig() {
    var pop = document.getElementById('cfad-config-popover');
    if (!pop) return;
    pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
}

function fetchSingleCFAD() {
    _ga('single_cfad', { case_index: currentCaseIndex });
    if (!currentCaseIndex && currentCaseIndex !== 0) return;
    var btn = document.getElementById('cfad-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

    // Hide the config panel
    var pop = document.getElementById('cfad-config-popover');
    if (pop) pop.style.display = 'none';

    var variable = (document.getElementById('ep-var') || {}).value || 'REFLECTIVITY';
    var dataType = _activeDataType || 'swath';

    // Read config from panel inputs
    var binWidth = parseFloat((document.getElementById('sc-cfad-bin-width') || {}).value) || 0;
    var nBins = parseInt((document.getElementById('sc-cfad-n-bins') || {}).value, 10) || 40;
    var binMinVal = (document.getElementById('sc-cfad-bin-min') || {}).value;
    var binMaxVal = (document.getElementById('sc-cfad-bin-max') || {}).value;
    var normalise = (document.getElementById('sc-cfad-normalise') || {}).value || 'height';
    var minRadius = parseFloat((document.getElementById('sc-cfad-min-radius') || {}).value) || 0;
    var maxRadius = parseFloat((document.getElementById('sc-cfad-max-radius') || {}).value) || 200;
    var logScale = !!(document.getElementById('sc-cfad-log-scale') || {}).checked;

    var url = API_BASE + '/cfad/single?case_index=' + currentCaseIndex +
        '&variable=' + variable + '&data_type=' + dataType +
        '&min_radius=' + minRadius + '&max_radius=' + maxRadius +
        '&normalise=' + encodeURIComponent(normalise) +
        '&n_bins=' + nBins;
    if (binWidth > 0) url += '&bin_width=' + binWidth;
    if (binMinVal !== '' && binMinVal !== undefined && !isNaN(parseFloat(binMinVal))) url += '&bin_min=' + parseFloat(binMinVal);
    if (binMaxVal !== '' && binMaxVal !== undefined && !isNaN(parseFloat(binMaxVal))) url += '&bin_max=' + parseFloat(binMaxVal);

    fetch(url)
        .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function(json) {
            json._logScale = logScale;
            _lastCFADJson = json;
            _lastAzJson = null; _lastHybridAzJson = null; _lastAnomalyAzJson = null; _lastVPScatterJson = null;
            renderSingleCFADInto('az-result', json, false);
            openPlotModal();
        })
        .catch(function(e) { alert('CFAD error: ' + e.message); })
        .finally(function() { if (btn) { btn.disabled = false; btn.textContent = '\u2593 CFAD'; } });
}

function renderSingleCFADInto(targetId, json, fullsize) {
    var cfad = json.cfad;
    var binCenters = json.bin_centers;
    var heightKm = json.height_km;
    var varInfo = json.variable;
    var normLabel = json.norm_label;
    var caseMeta = json.case_meta || {};
    var useLog = !!json._logScale;

    // Apply log transform if requested
    var plotData = cfad;
    if (useLog) {
        plotData = cfad.map(function(row) {
            return row.map(function(v) { return v > 0 ? Math.log10(v) : null; });
        });
    }

    // Build title
    var title = '';
    if (caseMeta.storm_name) title += caseMeta.storm_name;
    if (caseMeta.vmax) title += ' (' + caseMeta.vmax + ' kt)';
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
        title: { text: title, font: { color: '#e0e0e0', size: fullsize ? 15 : 13 }, x: 0.5 },
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
        margin: fullsize ? { t: 50, b: 50, l: 55, r: 20 } : { t: 50, b: 45, l: 50, r: 10 },
        font: { family: 'JetBrains Mono, monospace' },
    };

    var el = document.getElementById(targetId);
    if (!fullsize && el) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        el.innerHTML = '<div style="position:relative;"><div id="az-chart" style="width:100%;height:360px;border-radius:6px;overflow:hidden;"></div>' +
            _archExportBtnHTML('exportCFADCSV','exportCFADJSON','cfad-exp-drop',40) +
            '<button onclick="openPlotModal()" title="Expand" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;">\u26F6</button></div>';
        Plotly.newPlot('az-chart', [trace], layout, { responsive: true, displayModeBar: false });
    } else {
        Plotly.newPlot(targetId, [trace], layout, { responsive: true, displayModeBar: true, displaylogo: false });
    }
}


// ── Diagnostic panel data export ─────────────────────────────────────────

// ── Azimuthal Mean (standard / hybrid / anomaly) ──
function exportAzMeanCSV() {
    var json = _lastAzJson || _lastHybridAzJson || _lastAnomalyAzJson;
    if (!json) { showToast('No azimuthal mean data to export', 'warn'); return; }
    var isAnomaly = json === _lastAnomalyAzJson && !!_lastAnomalyAzJson;
    var isHybrid  = json === _lastHybridAzJson  && !!_lastHybridAzJson;
    var data2d = isAnomaly ? json.anomaly : json.azimuthal_mean;
    var radii  = (isHybrid || isAnomaly) ? json.r_h_axis : json.radius_km;
    var heights = json.height_km;
    var varInfo = json.variable || {};
    var meta    = json.case_meta || {};
    var rLabel  = (isHybrid || isAnomaly) ? 'r_h' : 'radius_km';
    var lines = [];
    lines.push('# TC-ATLAS Azimuthal Mean Export');
    if (meta.storm_name) lines.push('# Storm: ' + meta.storm_name);
    if (meta.datetime)   lines.push('# Time: '  + meta.datetime);
    if (meta.mission_id) lines.push('# Mission: ' + meta.mission_id);
    lines.push('# Variable: ' + (varInfo.display_name || '') + ' (' + (varInfo.units || '') + ')');
    if (isAnomaly) lines.push('# Type: Z-score anomaly (hybrid R_h coordinate)');
    else if (isHybrid) lines.push('# Type: Hybrid R_h coordinate');
    lines.push('#');
    lines.push('height_km,' + radii.map(function(r) { return rLabel + '=' + (+r).toFixed(3); }).join(','));
    for (var h = 0; h < heights.length; h++) {
        var row = [heights[h]];
        for (var r = 0; r < radii.length; r++) {
            var v = data2d[h] != null ? data2d[h][r] : null;
            row.push(v !== null && v !== undefined ? v : '');
        }
        lines.push(row.join(','));
    }
    var label    = isAnomaly ? 'anomaly' : (isHybrid ? 'hybrid_az_mean' : 'az_mean');
    var varLabel = (varInfo.display_name || 'data').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
    var storm    = meta.storm_name ? meta.storm_name.replace(/\s+/g,'_') + '_' : '';
    _triggerDownload(lines.join('\n'), 'tc_atlas_' + storm + label + '_' + varLabel + '.csv', 'text/csv');
    _ga('export_csv', { chart: 'az_mean', module: 'archive' });
}

function exportAzMeanJSON() {
    var json = _lastAzJson || _lastHybridAzJson || _lastAnomalyAzJson;
    if (!json) { showToast('No azimuthal mean data to export', 'warn'); return; }
    var isAnomaly = json === _lastAnomalyAzJson;
    var isHybrid  = json === _lastHybridAzJson;
    var label    = isAnomaly ? 'anomaly' : (isHybrid ? 'hybrid_az_mean' : 'az_mean');
    var varInfo  = json.variable || {};
    var meta     = json.case_meta || {};
    var varLabel = (varInfo.display_name || 'data').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
    var storm    = meta.storm_name ? meta.storm_name.replace(/\s+/g,'_') + '_' : '';
    _triggerDownload(JSON.stringify(json, null, 2), 'tc_atlas_' + storm + label + '_' + varLabel + '.json', 'application/json');
    _ga('export_json', { chart: 'az_mean', module: 'archive' });
}

// ── VP Scatter ──
function exportVPScatterCSV() {
    if (!_lastVPScatterJson) { showToast('No VP scatter data to export', 'warn'); return; }
    var json   = _lastVPScatterJson;
    var points = json.points || [];
    var colorBy = json.color_by || 'dvmax_12h';
    var lines = ['# TC-ATLAS VP Scatter Export', '# Color by: ' + colorBy,
                  '# Reference: Fischer et al. (2025, MWR) https://doi.org/10.1175/MWR-D-24-0118.1', '#'];
    lines.push('case_index,mission_id,storm_name,datetime,vmax_kt,vp,vortex_favorability,vortex_width,vortex_height,dvmax_12h,dvmax_24h');
    for (var i = 0; i < points.length; i++) {
        var p = points[i];
        lines.push([
            p.case_index  !== undefined ? p.case_index  : '',
            p.mission_id  || '',
            p.storm_name  || '',
            p.datetime    || '',
            p.vmax_kt     != null ? p.vmax_kt     : '',
            p.vp          != null ? p.vp          : '',
            p.vortex_favorability != null ? p.vortex_favorability : '',
            p.vortex_width  != null ? p.vortex_width  : '',
            p.vortex_height != null ? p.vortex_height : '',
            p.dvmax_12h   != null ? p.dvmax_12h   : '',
            p.dvmax_24h   != null ? p.dvmax_24h   : ''
        ].join(','));
    }
    _triggerDownload(lines.join('\n'), 'tc_atlas_vp_scatter_' + colorBy + '.csv', 'text/csv');
    _ga('export_csv', { chart: 'vp_scatter', module: 'archive' });
}

function exportVPScatterJSON() {
    if (!_lastVPScatterJson) { showToast('No VP scatter data to export', 'warn'); return; }
    var colorBy = _lastVPScatterJson.color_by || 'dvmax_12h';
    _triggerDownload(JSON.stringify(_lastVPScatterJson, null, 2), 'tc_atlas_vp_scatter_' + colorBy + '.json', 'application/json');
    _ga('export_json', { chart: 'vp_scatter', module: 'archive' });
}

// ── CFAD ──
function exportCFADCSV() {
    if (!_lastCFADJson) { showToast('No CFAD data to export', 'warn'); return; }
    var json    = _lastCFADJson;
    var cfad    = json.cfad;
    var bins    = json.bin_centers;
    var heights = json.height_km;
    var varInfo = json.variable || {};
    var meta    = json.case_meta || {};
    var lines   = ['# TC-ATLAS CFAD Export'];
    if (meta.storm_name) lines.push('# Storm: ' + meta.storm_name);
    if (meta.vmax)       lines.push('# Vmax: '  + meta.vmax + ' kt');
    lines.push('# Variable: ' + (varInfo.display_name || '') + ' (' + (varInfo.units || '') + ')');
    if (json.norm_label) lines.push('# Normalisation: ' + json.norm_label);
    lines.push('#');
    lines.push('height_km,' + bins.map(function(b) { return 'bin=' + (+b).toFixed(2); }).join(','));
    for (var h = 0; h < heights.length; h++) {
        var row = [heights[h]];
        for (var b = 0; b < bins.length; b++) {
            var v = cfad[h] != null ? cfad[h][b] : null;
            row.push(v !== null && v !== undefined ? v : '');
        }
        lines.push(row.join(','));
    }
    var varLabel = (varInfo.display_name || 'data').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
    var storm    = meta.storm_name ? meta.storm_name.replace(/\s+/g,'_') + '_' : '';
    _triggerDownload(lines.join('\n'), 'tc_atlas_cfad_' + storm + varLabel + '.csv', 'text/csv');
    _ga('export_csv', { chart: 'cfad', module: 'archive' });
}

function exportCFADJSON() {
    if (!_lastCFADJson) { showToast('No CFAD data to export', 'warn'); return; }
    var meta     = _lastCFADJson.case_meta || {};
    var varInfo  = _lastCFADJson.variable  || {};
    var varLabel = (varInfo.display_name || 'data').replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
    var storm    = meta.storm_name ? meta.storm_name.replace(/\s+/g,'_') + '_' : '';
    _triggerDownload(JSON.stringify(_lastCFADJson, null, 2), 'tc_atlas_cfad_' + storm + varLabel + '.json', 'application/json');
    _ga('export_json', { chart: 'cfad', module: 'archive' });
}

function buildAzOverlayContours(json, radius_km, height_km) {
    if (!json.overlay) return []; var ov = json.overlay; var ovData = ov.azimuthal_mean; if (!ovData) return [];
    try {
        var intInput = document.getElementById('ep-contour-int'); var interval = intInput ? parseFloat(intInput.value) : NaN;
        if (isNaN(interval) || interval <= 0) { var flat = ovData.flat().filter(function(v){return v!==null&&!isNaN(v);}); if (flat.length===0) return []; var mn=Infinity,mx=-Infinity; for(var i=0;i<flat.length;i++){if(flat[i]<mn)mn=flat[i];if(flat[i]>mx)mx=flat[i];} interval=parseFloat(((mx-mn)/10).toPrecision(1)); if(!isFinite(interval)||interval<=0) interval=(mx-mn)/10||1; }
        var baseContour = { z:ovData,x:radius_km,y:height_km,type:'contour',showscale:false,hoverongaps:false,contours:{coloring:'none',showlabels:true,labelfont:{size:9,color:'rgba(255,255,255,0.8)'}} };
        var traces = [];
        if (ov.vmax > interval) traces.push(Object.assign({},baseContour,{contours:Object.assign({},baseContour.contours,{start:interval,end:ov.vmax,size:interval}),line:{color:'rgba(0,0,0,0.7)',width:1.2,dash:'solid'},hovertemplate:'<b>'+ov.display_name+'</b>: %{z:.2f} '+ov.units+'<extra>contour</extra>',name:ov.display_name+' (+)',showlegend:false}));
        if (ov.vmin < -interval) traces.push(Object.assign({},baseContour,{contours:Object.assign({},baseContour.contours,{start:ov.vmin,end:-interval,size:interval}),line:{color:'rgba(0,0,0,0.7)',width:1.2,dash:'dash'},hovertemplate:'<b>'+ov.display_name+'</b>: %{z:.2f} '+ov.units+'<extra>contour</extra>',name:ov.display_name+' (\u2212)',showlegend:false}));
        return traces;
    } catch(e) { console.warn('Az overlay contour error:',e); return []; }
}

// ── Shear & Motion HTML compass widget (for metadata strip) ─────
// sddc: direction for the arrow (downshear direction)
// shdc: shear magnitude in kt
// motionDir/motionSpd: motion vector direction and speed
// sddcDisplay: optional — the direction value to show in the text label (if different from arrow direction)
function buildShearCompassHTML(sddc, shdc, motionDir, motionSpd, sddcDisplay) {
    var hasShear = (sddc !== null && sddc !== undefined && sddc !== 9999);
    var hasMotion = (motionDir !== null && motionDir !== undefined && motionDir !== 9999);
    if (!hasShear && !hasMotion) return '';

    var size = 50, cx = size / 2, cy = size / 2, r = 18, arrowR = 15;
    // SVG: circle + arrows
    var svg = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="vertical-align:middle;">';
    // Background circle
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="rgba(10,22,40,0.8)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>';
    // Center dot
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="rgba(255,255,255,0.5)"/>';

    // Arrow helper: meteorological direction (where FROM) → SVG angle
    // Met convention: 0°=N, 90°=E, clockwise. SVG: 0°=right, counter-clockwise.
    // Arrow points in the direction the vector is headed (downshear, not upshear)
    function drawArrow(dirDeg, color) {
        var rad = (90 - dirDeg) * Math.PI / 180;
        var tipX = cx + arrowR * Math.cos(rad);
        var tipY = cy - arrowR * Math.sin(rad);
        var baseX = cx - arrowR * 0.2 * Math.cos(rad);
        var baseY = cy + arrowR * 0.2 * Math.sin(rad);
        // Arrowhead
        var hl = 5, ha = 28 * Math.PI / 180;
        var aRad = Math.atan2(-(tipY - baseY), tipX - baseX);
        var h1x = tipX - hl * Math.cos(aRad - ha);
        var h1y = tipY + hl * Math.sin(aRad - ha);
        var h2x = tipX - hl * Math.cos(aRad + ha);
        var h2y = tipY + hl * Math.sin(aRad + ha);
        svg += '<line x1="' + baseX.toFixed(1) + '" y1="' + baseY.toFixed(1) + '" x2="' + tipX.toFixed(1) + '" y2="' + tipY.toFixed(1) + '" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
        svg += '<line x1="' + tipX.toFixed(1) + '" y1="' + tipY.toFixed(1) + '" x2="' + h1x.toFixed(1) + '" y2="' + h1y.toFixed(1) + '" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
        svg += '<line x1="' + tipX.toFixed(1) + '" y1="' + tipY.toFixed(1) + '" x2="' + h2x.toFixed(1) + '" y2="' + h2y.toFixed(1) + '" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
    }

    if (hasShear) drawArrow(sddc, '#f59e0b');
    if (hasMotion) drawArrow(motionDir, '#22d3ee');
    svg += '</svg>';

    // Text labels
    var labels = '<span class="compass-labels">';
    if (hasShear) {
        var shrStr = 'Shear';
        if (shdc !== null && shdc !== undefined && shdc !== 9999) shrStr += ' ' + shdc.toFixed(0) + ' kt';
        var displayDir = (sddcDisplay !== null && sddcDisplay !== undefined) ? sddcDisplay : sddc;
        shrStr += ' / ' + (typeof displayDir === 'number' ? displayDir.toFixed(0) : displayDir) + '\u00b0';
        labels += '<span class="shear-lbl">' + shrStr + '</span>';
    }
    if (hasMotion) {
        var motStr = 'Motion';
        if (motionSpd !== null && motionSpd !== undefined && motionSpd !== 9999) motStr += ' ' + motionSpd.toFixed(0) + ' kt';
        motStr += ' / ' + motionDir.toFixed(0) + '\u00b0';
        labels += '<span class="motion-lbl">' + motStr + '</span>';
    }
    labels += '</span>';

    return '<span class="shear-compass">' + svg + labels + '</span>';
}

// ── Shear & Motion vector inset (kept for cross-section/azimuthal mean Plotly plots) ──
function buildShearInset(sddc, isFullsize, shdc, motionDir, motionSpd) {
    var hasShear = (sddc !== null && sddc !== undefined && sddc !== 9999);
    var hasMotion = (motionDir !== null && motionDir !== undefined && motionDir !== 9999);
    if (!hasShear && !hasMotion) return { shapes: [], annotations: [] };

    // Inset center (paper coords) — top-left corner, leveraging blank space above data
    var cx = isFullsize ? 0.09 : 0.12;
    var cy = isFullsize ? 0.92 : 0.92;
    var r = isFullsize ? 0.060 : 0.075;
    var arrowLen = r * 0.85;
    var dotR = r * 0.07;
    var lw = isFullsize ? 2.5 : 2.5;
    var fsL = isFullsize ? 12 : 10;
    var labelGap = isFullsize ? 0.038 : 0.032;

    var shapes = [
        // Background circle (subtle)
        { type:'circle', xref:'paper', yref:'paper',
          x0: cx-r, y0: cy-r, x1: cx+r, y1: cy+r,
          fillcolor:'rgba(10,22,40,0.80)', line:{ color:'rgba(255,255,255,0.15)', width:1 } },
        // Center dot
        { type:'circle', xref:'paper', yref:'paper',
          x0: cx-dotR, y0: cy-dotR, x1: cx+dotR, y1: cy+dotR,
          fillcolor:'rgba(255,255,255,0.4)', line:{ width:0 } }
    ];
    var annotations = [];

    // Helper: draw an arrow + arrowhead in the inset
    function _addArrow(theta, color) {
        var adx = arrowLen * Math.cos(theta);
        var ady = arrowLen * Math.sin(theta);
        shapes.push({ type:'line', xref:'paper', yref:'paper',
            x0: cx - adx*0.25, y0: cy - ady*0.25, x1: cx + adx, y1: cy + ady,
            line:{ color: color, width: lw } });
        var hl = arrowLen * 0.32, ha = 25 * Math.PI / 180;
        var tx = cx + adx, ty = cy + ady;
        shapes.push({ type:'line', xref:'paper', yref:'paper',
            x0: tx, y0: ty,
            x1: tx + hl*Math.cos(theta+Math.PI-ha), y1: ty + hl*Math.sin(theta+Math.PI-ha),
            line:{ color: color, width: lw } });
        shapes.push({ type:'line', xref:'paper', yref:'paper',
            x0: tx, y0: ty,
            x1: tx + hl*Math.cos(theta+Math.PI+ha), y1: ty + hl*Math.sin(theta+Math.PI+ha),
            line:{ color: color, width: lw } });
    }

    // Draw arrows
    if (hasShear) _addArrow((90 - sddc) * Math.PI / 180, '#f59e0b');
    if (hasMotion) _addArrow((90 - motionDir) * Math.PI / 180, '#22d3ee');

    // ── Compact labels: one line per vector ──────────────────────
    // "SHR  12 kt / 276°" above circle
    if (hasShear) {
        var shrTxt = '<b>Shear</b>  ';
        if (shdc !== null && shdc !== undefined && shdc !== 9999) shrTxt += shdc.toFixed(0) + ' kt / ';
        shrTxt += sddc.toFixed(0) + '\u00b0';
        annotations.push({ text: shrTxt, xref:'paper', yref:'paper',
            x: cx, y: cy + r + labelGap,
            showarrow:false, font:{ color:'#f59e0b', size: fsL, family:'JetBrains Mono, monospace' },
            bgcolor:'rgba(10,22,40,0.7)', borderpad: 2 });
    }

    // "MOT  8 kt / 29°" below circle
    if (hasMotion) {
        var motTxt = '<b>Motion</b>  ';
        if (motionSpd !== null && motionSpd !== undefined && motionSpd !== 9999) motTxt += motionSpd.toFixed(0) + ' kt / ';
        motTxt += motionDir.toFixed(0) + '\u00b0';
        var motY = hasShear
            ? cy - r - labelGap
            : cy + r + labelGap;
        annotations.push({ text: motTxt, xref:'paper', yref:'paper',
            x: cx, y: motY,
            showarrow:false, font:{ color:'#22d3ee', size: fsL, family:'JetBrains Mono, monospace' },
            bgcolor:'rgba(10,22,40,0.7)', borderpad: 2 });
    }

    return { shapes: shapes, annotations: annotations };
}

// Build shear inset for cross-section (simpler: just show direction label)
function buildShearInsetCS(sddc, isFullsize, shdc) {
    if (sddc === null || sddc === undefined || sddc === 9999) return { shapes: [], annotations: [] };
    var shrText = '<b>Shear: ' + sddc.toFixed(0) + '\u00b0</b>';
    if (shdc !== null && shdc !== undefined && shdc !== 9999) {
        shrText = '<b>Shear: ' + sddc.toFixed(0) + '\u00b0 (' + shdc.toFixed(0) + ' kt)</b>';
    }
    var annotations = [
        { text: shrText,
          xref:'paper', yref:'paper', x: 0.01, y: 1.0,
          xanchor:'left', yanchor:'bottom', showarrow:false,
          font:{ color:'#f59e0b', size: isFullsize?10:8, family:'JetBrains Mono, monospace' },
          bgcolor:'rgba(10,22,40,0.8)', borderpad:2, bordercolor:'rgba(245,158,11,0.3)', borderwidth:1 }
    ];
    return { shapes: [], annotations: annotations };
}

// ── Shear-Relative Quadrant Means ───────────────────────────────
function fetchShearQuadrants() {
    if (currentCaseIndex === null) return;
    var variable = document.getElementById('ep-var').value;
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var covSlider = document.getElementById('az-coverage');
    var coverage = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;
    var resultDiv = document.getElementById('sq-result'), btn = document.getElementById('sq-btn');
    resultDiv.innerHTML = _hurricaneLoadingHTML('Computing shear-relative quadrant means\u2026', true);
    btn.disabled = true; btn.textContent = '\u25D1 Computing\u2026';
    var url = API_BASE + '/quadrant_mean?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=' + _activeDataType + '&coverage_min=' + coverage;
    if (overlay && overlay !== 'none') url += '&overlay=' + overlay;
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) {
            _lastSqJson = json;
            json.case_meta = _enrichCaseMeta(json.case_meta);
            if (json.case_meta && json.case_meta.sddc !== undefined) _currentSddc = (json.case_meta.sddc !== 9999) ? json.case_meta.sddc : null;
            resultDiv.innerHTML = '<div class="explorer-status" style="color:#10b981;">\u2713 Shear quadrants ready \u2014 opening expanded view</div>';
            openPlotModal();
        })
        .catch(function(err) { resultDiv.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (err.name === 'AbortError' ? 'Request timed out (90s).' : err.message) + '</div>'; })
        .finally(function() { clearTimeout(timeout); btn.disabled = false; btn.textContent = '\u25D1 Shear Quads'; });
}

function renderQuadrantMeansInto(targetId, json, fullsize) {
    var el = document.getElementById(targetId); if (!el) return;
    var quads = json.quadrant_means; // { DSL: {data:...}, DSR: ..., USL: ..., USR: ... }
    var radius_km = json.radius_km, height_km = json.height_km, varInfo = json.variable, meta = _enrichCaseMeta(json.case_meta);
    var sddc = (meta.sddc !== undefined && meta.sddc !== 9999) ? meta.sddc : null;
    var fontSize = fullsize ? { title:14,axis:11,tick:10,cbar:11,cbarTick:10,hover:12,panel:12 } : { title:11,axis:9,tick:8,cbar:9,cbarTick:8,hover:10,panel:10 };

    var csColorscale = varInfo.colorscale;
    var cmapSel = document.getElementById('ep-cmap');
    if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch(e) { csColorscale = cmapSel.value; } }
    var av = _getActiveVmin(), avx = _getActiveVmax();
    var zmin = av !== null ? av : varInfo.vmin;
    var zmax = avx !== null ? avx : varInfo.vmax;

    // 4-panel layout: USL(top-left), DSL(top-right), USR(bottom-left), DSR(bottom-right)
    // This orients as if shear is westerly: downshear=right, left-of-shear=top
    var panelOrder = [
        { key: 'USL', label: 'Upshear Left', row: 0, col: 0, xaxis: 'x', yaxis: 'y' },
        { key: 'DSL', label: 'Downshear Left', row: 0, col: 1, xaxis: 'x2', yaxis: 'y2' },
        { key: 'USR', label: 'Upshear Right', row: 1, col: 0, xaxis: 'x3', yaxis: 'y3' },
        { key: 'DSR', label: 'Downshear Right', row: 1, col: 1, xaxis: 'x4', yaxis: 'y4' }
    ];

    var traces = [];
    var annotations = [];
    var shapes = [];

    // Panel spacing
    var gap = fullsize ? 0.08 : 0.10;
    var cbarW = 0.04;
    var leftM = 0.06, rightM = 0.02 + cbarW + 0.02;
    var topM = fullsize ? 0.10 : 0.12;
    var botM = 0.06;
    var pw = (1 - leftM - rightM - gap) / 2;
    var ph = (1 - topM - botM - gap) / 2;

    // Quadrant panel colors for subtle border highlighting
    var quadColors = { DSL: '#f59e0b', DSR: '#f59e0b', USL: '#60a5fa', USR: '#60a5fa' };

    panelOrder.forEach(function(p, i) {
        var qData = quads[p.key];
        if (!qData || !qData.data) return;
        var x0 = leftM + p.col * (pw + gap);
        var x1 = x0 + pw;
        var y0 = botM + (1 - p.row) * (ph + gap); // row 0 = top
        var y1 = y0 + ph;
        // Adjust: row 0 should be higher y
        var yBottom = 1 - topM - (p.row + 1) * ph - p.row * gap;
        var yTop = 1 - topM - p.row * ph - p.row * gap;

        var axSuffix = i === 0 ? '' : String(i + 1);
        var showCbar = (i === 1); // only show colorbar on top-right panel

        traces.push({
            z: qData.data, x: radius_km, y: height_km,
            type: 'heatmap', colorscale: csColorscale, zmin: zmin, zmax: zmax,
            xaxis: 'x' + axSuffix, yaxis: 'y' + axSuffix,
            showscale: showCbar,
            colorbar: showCbar ? {
                title: { text: varInfo.units, font: { color: '#ccc', size: fontSize.cbar } },
                tickfont: { color: '#ccc', size: fontSize.cbarTick },
                thickness: fullsize ? 14 : 10, len: 0.85,
                x: 1.02, y: 0.5
            } : undefined,
            hovertemplate: '<b>' + p.label + '</b><br>' + varInfo.display_name + ': %{z:.2f} ' + varInfo.units + '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps: false
        });

        // Panel title annotation
        annotations.push({
            text: '<b>' + p.label + '</b>',
            xref: 'paper', yref: 'paper',
            x: (x0 + x1) / 2, y: yTop + 0.005,
            xanchor: 'center', yanchor: 'bottom', showarrow: false,
            font: { color: quadColors[p.key] || '#ccc', size: fontSize.panel, family: 'JetBrains Mono, monospace' },
            bgcolor: 'rgba(10,22,40,0.7)', borderpad: 2
        });

        // RMW line
        if (meta.rmw_km && !isNaN(meta.rmw_km)) {
            shapes.push({ type:'line', xref: 'x' + axSuffix, yref: 'y' + axSuffix,
                x0: meta.rmw_km, x1: meta.rmw_km, y0: height_km[0], y1: height_km[height_km.length-1],
                line:{ color:'white', width:1, dash:'dash' } });
        }
    });

    // Build axes
    var plotBg = '#0a1628';
    var layout = {
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        margin: fullsize ? { l:55, r:70, t:100, b:50 } : { l:45, r:55, t:84, b:42 },
        showlegend: false,
        annotations: annotations,
        shapes: shapes,
        hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: fontSize.hover } }
    };

    // Define axes for each panel
    var axConfigs = [
        { x0: leftM, x1: leftM + pw, y0: 1-topM-ph, y1: 1-topM },           // top-left (USL)
        { x0: leftM+pw+gap, x1: leftM+2*pw+gap, y0: 1-topM-ph, y1: 1-topM }, // top-right (DSL)
        { x0: leftM, x1: leftM+pw, y0: botM, y1: botM+ph },                    // bottom-left (USR)
        { x0: leftM+pw+gap, x1: leftM+2*pw+gap, y0: botM, y1: botM+ph }        // bottom-right (DSR)
    ];

    panelOrder.forEach(function(p, i) {
        var axSuffix = i === 0 ? '' : String(i + 1);
        var ac = axConfigs[i];
        var showXLabel = (p.row === 1); // only bottom row
        var showYLabel = (p.col === 0); // only left column
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

    // Main title
    var vmaxStr = meta.vmax_kt ? ' | Vmax = ' + meta.vmax_kt + ' kt' : '';
    var shearStr = sddc !== null ? ' | Shear: ' + sddc.toFixed(0) + '\u00b0' : '';
    var covPct = Math.round((json.coverage_min || 0.5) * 100);
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    layout.title = {
        text: meta.storm_name + ' | ' + meta.datetime + vmaxStr + shearStr + '<br>Shear-Relative Quadrant Mean: ' + varInfo.display_name + ' (\u2265' + covPct + '% cov.)' + overlayLabel,
        font: { color: '#e5e7eb', size: fontSize.title }, y: 0.99, x: 0.5, xanchor: 'center'
    };

    // Add shear vector inset between the 4 panels (center)
    if (sddc !== null) {
        var insetCx = leftM + pw + gap/2;
        var insetCy = botM + ph + gap/2;
        var insetR = Math.min(gap, 0.06) * 0.55;
        var theta = (90 - sddc) * Math.PI / 180;
        var arrowLen = insetR * 0.8;
        var adx = arrowLen * Math.cos(theta);
        var ady = arrowLen * Math.sin(theta);
        // Background circle
        shapes.push({ type:'circle', xref:'paper', yref:'paper',
            x0:insetCx-insetR, y0:insetCy-insetR, x1:insetCx+insetR, y1:insetCy+insetR,
            fillcolor:'rgba(10,22,40,0.9)', line:{color:'rgba(245,158,11,0.4)',width:1.5} });
        // Arrow shaft
        shapes.push({ type:'line', xref:'paper', yref:'paper',
            x0:insetCx - adx*0.3, y0:insetCy - ady*0.3, x1:insetCx + adx, y1:insetCy + ady,
            line:{color:'#f59e0b',width:2.5} });
        // Arrowhead
        var headLen2 = arrowLen * 0.35, headAngle2 = 25 * Math.PI / 180;
        var tipX2 = insetCx + adx, tipY2 = insetCy + ady;
        shapes.push({ type:'line', xref:'paper', yref:'paper',
            x0:tipX2, y0:tipY2, x1:tipX2+headLen2*Math.cos(theta+Math.PI-headAngle2), y1:tipY2+headLen2*Math.sin(theta+Math.PI-headAngle2),
            line:{color:'#f59e0b',width:2.5} });
        shapes.push({ type:'line', xref:'paper', yref:'paper',
            x0:tipX2, y0:tipY2, x1:tipX2+headLen2*Math.cos(theta+Math.PI+headAngle2), y1:tipY2+headLen2*Math.sin(theta+Math.PI+headAngle2),
            line:{color:'#f59e0b',width:2.5} });
        // "DS" label at arrowhead
        annotations.push({ text:'DS', xref:'paper', yref:'paper',
            x:insetCx + adx*1.6, y:insetCy + ady*1.6,
            showarrow:false, font:{color:'#f59e0b',size:fullsize?9:7,family:'JetBrains Mono,monospace'} });
    }

    // Add overlay contours for each quadrant if present
    if (json.overlay && json.overlay.quadrant_means) {
        var intInput = document.getElementById('ep-contour-int');
        var interval = intInput ? parseFloat(intInput.value) : NaN;
        panelOrder.forEach(function(p, i) {
            var ovQ = json.overlay.quadrant_means[p.key];
            if (!ovQ || !ovQ.data) return;
            if (isNaN(interval) || interval <= 0) {
                var flat = ovQ.data.flat().filter(function(v){return v!==null&&!isNaN(v);});
                if (flat.length === 0) return;
                var mn=Infinity,mx=-Infinity;
                for(var k=0;k<flat.length;k++){if(flat[k]<mn)mn=flat[k];if(flat[k]>mx)mx=flat[k];}
                interval=parseFloat(((mx-mn)/10).toPrecision(1));
                if(!isFinite(interval)||interval<=0) interval=(mx-mn)/10||1;
            }
            var axSuffix = i === 0 ? '' : String(i+1);
            var baseContour = { z:ovQ.data, x:radius_km, y:height_km, type:'contour', xaxis:'x'+axSuffix, yaxis:'y'+axSuffix, showscale:false, hoverongaps:false, contours:{coloring:'none',showlabels:true,labelfont:{size:8,color:'rgba(255,255,255,0.7)'}} };
            if (json.overlay.vmax > interval) traces.push(Object.assign({},baseContour,{contours:Object.assign({},baseContour.contours,{start:interval,end:json.overlay.vmax,size:interval}),line:{color:'rgba(0,0,0,0.6)',width:1,dash:'solid'},showlegend:false}));
            if (json.overlay.vmin < -interval) traces.push(Object.assign({},baseContour,{contours:Object.assign({},baseContour.contours,{start:json.overlay.vmin,end:-interval,size:interval}),line:{color:'rgba(0,0,0,0.6)',width:1,dash:'dash'},showlegend:false}));
        });
    }

    layout.shapes = shapes;
    layout.annotations = annotations;

    if (!fullsize) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        el.innerHTML = '<div style="position:relative;"><div id="sq-chart" style="width:100%;height:400px;border-radius:6px;overflow:hidden;"></div>' + _archSaveBtnHTML('sq-chart', 'TDR_Profile') + '<button onclick="openPlotModal()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">\u26F6</button></div><div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover \u00b7 zoom \u00b7 pan \u00b7 \u26F6 expand</div>';
        Plotly.newPlot('sq-chart', traces, layout, { responsive:true, displayModeBar:false, displaylogo:false });
        var panelInner = document.getElementById('side-panel-inner');
        if (panelInner) panelInner.scrollTop = 0;
    } else {
        Plotly.newPlot(targetId, traces, layout, { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
    }
}

// ── Intensity helpers ────────────────────────────────────────
function getIntensityColor(vmax) {
    if (!vmax) return '#6b7280'; if (vmax<34) return '#60a5fa'; if (vmax<64) return '#34d399';
    if (vmax<83) return '#fbbf24'; if (vmax<96) return '#fb923c'; if (vmax<113) return '#f87171';
    if (vmax<137) return '#ef4444'; return '#dc2626';
}
function getIntensityCategory(vmax) {
    if (!vmax) return 'Unknown'; if (vmax<34) return 'TD'; if (vmax<64) return 'TS';
    if (vmax<83) return 'Cat 1'; if (vmax<96) return 'Cat 2'; if (vmax<113) return 'Cat 3';
    if (vmax<137) return 'Cat 4'; return 'Cat 5';
}

function createPopupContent(caseData) {
    var intensity = caseData.vmax_kt !== null ? caseData.vmax_kt + ' kt' : 'N/A';
    var pressure = caseData.min_pressure_hpa !== null ? caseData.min_pressure_hpa + ' hPa' : 'N/A';
    var rmw = caseData.rmw_km !== null ? caseData.rmw_km + ' km' : 'N/A';
    var vmaxChange = caseData['24-h_vmax_change_kt'] !== null ? (caseData['24-h_vmax_change_kt']>0?'+':'') + caseData['24-h_vmax_change_kt'] + ' kt' : 'N/A';
    var tiltMag = caseData.tilt_magnitude_km !== null ? caseData.tilt_magnitude_km.toFixed(1) + ' km' : 'N/A';
    var shearDir = (caseData.sddc !== null && caseData.sddc !== undefined && caseData.sddc !== 9999) ? caseData.sddc.toFixed(0) + '\u00b0' : 'N/A';
    var category = getIntensityCategory(caseData.vmax_kt);
    var catColor = getIntensityColor(caseData.vmax_kt);
    var idx = caseData.case_index;
    var nSwathsRow = (caseData.number_of_swaths !== null && caseData.number_of_swaths !== undefined) ?
        '<div class="popup-row"><span class="popup-label">Swaths:</span><span class="popup-value">' + caseData.number_of_swaths + '</span></div>' : '';
    var dtBadge = _activeDataType === 'merge' ? '<span style="font-size:9px;background:#4f46e5;color:#fff;padding:1px 5px;border-radius:3px;margin-left:6px;">MERGE</span>' : '';
    return '<div class="popup-header"><div class="popup-storm-name">' + caseData.storm_name + dtBadge + '</div><div class="popup-mission">' + caseData.mission_id + '</div></div>' +
        '<div class="popup-row"><span class="popup-label">Date/Time:</span><span class="popup-value">' + caseData.datetime + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Intensity:</span><span class="popup-value"><span class="intensity-badge" style="background:' + catColor + '">' + category + '</span> ' + intensity + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">24-h Change:</span><span class="popup-value">' + vmaxChange + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Min Pressure:</span><span class="popup-value">' + pressure + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">RMW:</span><span class="popup-value">' + rmw + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Tilt Magnitude:</span><span class="popup-value">' + tiltMag + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Shear Dir:</span><span class="popup-value">' + shearDir + '</span></div>' +
        nSwathsRow +
        '<div class="popup-row"><span class="popup-label">Location:</span><span class="popup-value">' + Math.abs(caseData.latitude).toFixed(2) + '\u00b0' + (caseData.latitude>=0?'N':'S') + ', ' + Math.abs(caseData.longitude).toFixed(2) + '\u00b0' + (caseData.longitude<0?'W':'E') + '</span></div>' +
        '<button class="popup-explore-btn" onclick="openSidePanelById(' + idx + ')">\uD83D\uDD2C View Radar & Explore Data \u2192</button>';
}

function openSidePanelById(idx) { var d = _getActiveData(); if (!d) return; var caseData = d.cases.find(function(c) { return c.case_index === idx; }); if (caseData) openSidePanel(caseData); }

// ── "About this case" metadata panel ─────────────────────────
function buildCaseMetaPanel(caseData) {
    // IBTrACS lookup for ATCF ID and basin (if data is already loaded)
    var atcfId = null, basin = null;
    if (typeof _tdrToSID !== 'undefined' && typeof _ibtStormsBySID !== 'undefined') {
        var ibtKey = caseData.storm_name + '|' + caseData.year;
        var sid = _tdrToSID[ibtKey];
        var ibtStorm = sid ? _ibtStormsBySID[sid] : null;
        if (ibtStorm) { atcfId = ibtStorm.atcf_id || null; basin = ibtStorm.basin || null; }
    }

    var cat = getIntensityCategory(caseData.vmax_kt);
    var catColor = getIntensityColor(caseData.vmax_kt);

    // 24h intensity change: blue=weakening, red=intensifying, bold red for RI >=30
    var dv = caseData['24-h_vmax_change_kt'];
    var dvStr = (dv !== null && dv !== undefined) ? (dv > 0 ? '+' : '') + dv + ' kt/24h' : '\u2014';
    var dvStyle = '';
    if (dv !== null && dv !== undefined) {
        if (dv >= 30)       dvStyle = 'color:#ef4444;font-weight:700;';
        else if (dv > 0)    dvStyle = 'color:#f87171;';
        else if (dv < 0)    dvStyle = 'color:#60a5fa;';
    }

    // Shear colour: green <15 kt, amber 15-25 kt, red >25 kt
    var shearMag = caseData.shear_magnitude_kt;
    var shearColor = 'var(--text)';
    if (shearMag !== null && shearMag !== undefined) {
        if (shearMag >= 25) shearColor = '#f87171';
        else if (shearMag >= 15) shearColor = '#fbbf24';
        else shearColor = '#34d399';
    }

    function fmt(v, unit, dec) {
        if (v === null || v === undefined) return '\u2014';
        return (dec !== undefined ? parseFloat(v).toFixed(dec) : v) + (unit ? '\u00a0' + unit : '');
    }
    function latStr(v) { return v === null || v === undefined ? '\u2014' : Math.abs(v).toFixed(2) + '\u00b0' + (v >= 0 ? 'N' : 'S'); }
    function lonStr(v) { return v === null || v === undefined ? '\u2014' : Math.abs(v).toFixed(2) + '\u00b0' + (v >= 0 ? 'E' : 'W'); }

    var basinNames = { NA:'N. Atlantic', EP:'E. Pacific', WP:'W. Pacific', NI:'N. Indian', SI:'S. Indian', SP:'S. Pacific', SA:'S. Atlantic' };
    var basinStr = basin ? (basinNames[basin] || basin) : '\u2014';

    var dtLabel = _activeDataType === 'merge'
        ? 'Merged' + (caseData.number_of_swaths ? ' (' + caseData.number_of_swaths + ' swaths)' : '')
        : 'Single swath';

    var covStr = (caseData.coverage !== null && caseData.coverage !== undefined)
        ? (caseData.coverage * 100).toFixed(0) + '%' : '\u2014';

    var atcfHtml = atcfId
        ? '<a href="https://www.ncei.noaa.gov/products/international-best-track-archive?name=' + atcfId + '" target="_blank" rel="noopener" class="case-meta-link">' + atcfId + '\u00a0\u2197</a>'
        : '\u2014';

    function section(title, rows) {
        var h = '<div class="case-meta-section"><div class="case-meta-section-hdr">' + title + '</div>';
        rows.forEach(function(r) {
            h += '<div class="case-meta-cell"><span class="case-meta-lbl">' + r[0] + '</span><span class="case-meta-val">' + r[1] + '</span></div>';
        });
        return h + '</div>';
    }

    var html = '<div class="case-meta-panel">';

    html += section('Storm', [
        ['Name', caseData.storm_name],
        ['Basin', basinStr],
        ['ATCF ID', atcfHtml],
        ['Date / Time', caseData.datetime],
        ['Mission', caseData.mission_id],
        ['Type', dtLabel],
        ['Coverage', covStr],
    ]);

    html += section('Intensity', [
        ['Vmax', '<span class="case-cat-badge" style="background:' + catColor + ';">' + cat + '</span>' + fmt(caseData.vmax_kt, 'kt')],
        ['MSLP', fmt(caseData.min_pressure_hpa, 'hPa')],
        ['24h \u0394Vmax', '<span style="' + dvStyle + '">' + dvStr + '</span>'],
    ]);

    var structRows = [
        ['RMW', fmt(caseData.rmw_km, 'km')],
        ['Vortex tilt', fmt(caseData.tilt_magnitude_km, 'km', 1)],
    ];
    var hasShearMag = shearMag !== null && shearMag !== undefined;
    var hasShearDir = caseData.sddc !== null && caseData.sddc !== undefined && caseData.sddc !== 9999;
    if (hasShearMag) structRows.push(['DL shear', '<span style="color:' + shearColor + ';">' + parseFloat(shearMag).toFixed(1) + '\u00a0kt</span>']);
    if (hasShearDir) structRows.push(['Shear dir', parseFloat(caseData.sddc).toFixed(0) + '\u00b0']);
    structRows.push(['Position', latStr(caseData.latitude) + ', ' + lonStr(caseData.longitude)]);
    html += section('Structure', structRows);

    return html + '</div>';
}

// ── Filters ──────────────────────────────────────────────────
function passesFilters(c) {
    var vmax = c.vmax_kt || 0;
    if (vmax < filters.minIntensity || vmax > filters.maxIntensity) return false;
    if (filters.minVmaxChange !== -100 || filters.maxVmaxChange !== 85) { if (c['24-h_vmax_change_kt'] === null) return false; var vc = c['24-h_vmax_change_kt']; if (vc < filters.minVmaxChange || vc > filters.maxVmaxChange) return false; }
    if (filters.minTilt !== 0 || filters.maxTilt !== 200) { if (c.tilt_magnitude_km === null) return false; if (c.tilt_magnitude_km < filters.minTilt || c.tilt_magnitude_km > filters.maxTilt) return false; }
    if (filters.minWspd05 !== 0 || filters.maxWspd05 !== 100) { if (c.max_er_wspd_05km == null) return false; if (c.max_er_wspd_05km < filters.minWspd05 || c.max_er_wspd_05km > filters.maxWspd05) return false; }
    if (filters.minWspd20 !== 0 || filters.maxWspd20 !== 100) { if (c.max_er_wspd_20km == null) return false; if (c.max_er_wspd_20km < filters.minWspd20 || c.max_er_wspd_20km > filters.maxWspd20) return false; }
    if (c.year < filters.minYear || c.year > filters.maxYear) return false;
    if (filters.stormName !== 'all' && c.storm_name !== filters.stormName) return false;
    return true;
}

function updateMarkers() {
    if (!markers || !_getActiveData()) return; markers.clearLayers(); var n = 0;
    _getActiveData().cases.forEach(function(c) { if (passesFilters(c)) { var m = allMarkers.find(function(m) { return m.caseIndex === c.case_index; }); if (m) { markers.addLayer(m.marker); n++; } } });
    document.getElementById('filtered-count').textContent = n;
}

function updateIntensitySlider() {
    var min = parseInt(document.getElementById('min-intensity').value), max = parseInt(document.getElementById('max-intensity').value);
    if (min > max) { document.getElementById('min-intensity').value = max; min = max; }
    filters.minIntensity = min; filters.maxIntensity = max;
    document.getElementById('min-intensity-value').textContent = min; document.getElementById('max-intensity-value').textContent = max;
    var rf = document.getElementById('intensity-range-fill'); rf.style.left = (min/200*100)+'%'; rf.style.width = ((max-min)/200*100)+'%'; updateMarkers();
}
function updateVmaxChangeSlider() {
    var min = parseInt(document.getElementById('min-vmax-change').value), max = parseInt(document.getElementById('max-vmax-change').value);
    if (min > max) { document.getElementById('min-vmax-change').value = max; min = max; }
    filters.minVmaxChange = min; filters.maxVmaxChange = max;
    document.getElementById('min-vmax-change-value').textContent = min; document.getElementById('max-vmax-change-value').textContent = max;
    var rf = document.getElementById('vmax-change-range-fill'); rf.style.left = ((min+100)/185*100)+'%'; rf.style.width = ((max-min)/185*100)+'%'; updateMarkers();
}
function updateTiltSlider() {
    var min = parseInt(document.getElementById('min-tilt').value), max = parseInt(document.getElementById('max-tilt').value);
    if (min > max) { document.getElementById('min-tilt').value = max; min = max; }
    filters.minTilt = min; filters.maxTilt = max;
    document.getElementById('min-tilt-value').textContent = min; document.getElementById('max-tilt-value').textContent = max;
    var rf = document.getElementById('tilt-range-fill'); rf.style.left = (min/200*100)+'%'; rf.style.width = ((max-min)/200*100)+'%'; updateMarkers();
}
function updateWspd05Slider() {
    var min = parseInt(document.getElementById('min-wspd05').value), max = parseInt(document.getElementById('max-wspd05').value);
    if (min > max) { document.getElementById('min-wspd05').value = max; min = max; }
    filters.minWspd05 = min; filters.maxWspd05 = max;
    document.getElementById('min-wspd05-value').textContent = min; document.getElementById('max-wspd05-value').textContent = max;
    var rf = document.getElementById('wspd05-range-fill'); rf.style.left = (min/100*100)+'%'; rf.style.width = ((max-min)/100*100)+'%'; updateMarkers();
}
function updateWspd20Slider() {
    var min = parseInt(document.getElementById('min-wspd20').value), max = parseInt(document.getElementById('max-wspd20').value);
    if (min > max) { document.getElementById('min-wspd20').value = max; min = max; }
    filters.minWspd20 = min; filters.maxWspd20 = max;
    document.getElementById('min-wspd20-value').textContent = min; document.getElementById('max-wspd20-value').textContent = max;
    var rf = document.getElementById('wspd20-range-fill'); rf.style.left = (min/100*100)+'%'; rf.style.width = ((max-min)/100*100)+'%'; updateMarkers();
}
function updateYearFilter() { var min = parseInt(document.getElementById('min-year').value), max = parseInt(document.getElementById('max-year').value); if (min > max) { document.getElementById('min-year').value = max; min = max; } filters.minYear = min; filters.maxYear = max; updateMarkers(); }
function updateStormFilter() { filters.stormName = document.getElementById('storm-select').value || 'all'; updateMarkers(); }

function resetFilters() {
    filters.minIntensity=0; filters.maxIntensity=200; document.getElementById('min-intensity').value=0; document.getElementById('max-intensity').value=200; updateIntensitySlider();
    filters.minVmaxChange=-100; filters.maxVmaxChange=85; document.getElementById('min-vmax-change').value=-100; document.getElementById('max-vmax-change').value=85; updateVmaxChangeSlider();
    filters.minTilt=0; filters.maxTilt=200; document.getElementById('min-tilt').value=0; document.getElementById('max-tilt').value=200; updateTiltSlider();
    filters.minWspd05=0; filters.maxWspd05=100; document.getElementById('min-wspd05').value=0; document.getElementById('max-wspd05').value=100; updateWspd05Slider();
    filters.minWspd20=0; filters.maxWspd20=100; document.getElementById('min-wspd20').value=0; document.getElementById('max-wspd20').value=100; updateWspd20Slider();
    // Reset year filter to full range
    var _resetData = _getActiveData();
    if (_resetData) {
        var _yrs = _resetData.cases.map(function(c) { return c.year; });
        filters.minYear = Math.min.apply(null, _yrs); filters.maxYear = Math.max.apply(null, _yrs);
    } else {
        filters.minYear = 1997; filters.maxYear = 2024;
    }
    document.getElementById('min-year').value = filters.minYear; document.getElementById('max-year').value = filters.maxYear;
    // Reset year dropdown and rebuild storm list with years
    _selectedYear = '';
    document.getElementById('year-select').value = '';
    _populateStormDropdown('');
    filters.stormName='all'; document.getElementById('storm-select').value=''; updateMarkers();
    // Also reset case dropdown
    document.getElementById('case-select').innerHTML = '<option value="">\u2190 Select a storm first</option>';
    document.getElementById('case-select').disabled = true;
    document.getElementById('explore-btn').disabled = true;
}

function initializeFilters() {
    document.getElementById('min-intensity').addEventListener('input', updateIntensitySlider);
    document.getElementById('max-intensity').addEventListener('input', updateIntensitySlider);
    document.getElementById('min-vmax-change').addEventListener('input', updateVmaxChangeSlider);
    document.getElementById('max-vmax-change').addEventListener('input', updateVmaxChangeSlider);
    document.getElementById('min-tilt').addEventListener('input', updateTiltSlider);
    document.getElementById('max-tilt').addEventListener('input', updateTiltSlider);
    document.getElementById('min-wspd05').addEventListener('input', updateWspd05Slider);
    document.getElementById('max-wspd05').addEventListener('input', updateWspd05Slider);
    document.getElementById('min-wspd20').addEventListener('input', updateWspd20Slider);
    document.getElementById('max-wspd20').addEventListener('input', updateWspd20Slider);
    document.getElementById('min-year').addEventListener('change', updateYearFilter);
    document.getElementById('max-year').addEventListener('change', updateYearFilter);
    // Storm filtering handled by two-step handler at top of file
    updateIntensitySlider(); updateVmaxChangeSlider(); updateTiltSlider();
    updateWspd05Slider(); updateWspd20Slider();
}

// ── Fetch enriched metadata (max wind speeds from API) ───────
function _fetchEnrichedWindData(dataType) {
    fetch(API_BASE + '/metadata_all?data_type=' + dataType)
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(enriched) {
            var target = dataType === 'merge' ? mergeData : allData;
            if (!target || !target.cases) return;
            // Build lookup by case_index
            var lookup = {};
            enriched.cases.forEach(function(ec) { lookup[ec.case_index] = ec; });
            // Merge max wind speed fields into existing case objects
            var merged = 0;
            target.cases.forEach(function(c) {
                var ec = lookup[c.case_index];
                if (ec) {
                    if (ec.max_er_wspd_05km != null) { c.max_er_wspd_05km = ec.max_er_wspd_05km; merged++; }
                    if (ec.max_er_wspd_20km != null) { c.max_er_wspd_20km = ec.max_er_wspd_20km; }
                }
            });
            console.log('Enriched ' + merged + ' ' + dataType + ' cases with max wind speed data');
            updateMarkers();
        })
        .catch(function(err) { console.warn('Enriched metadata not available (' + dataType + '): ' + err.message); });
}

// ── Pre-warm API ─────────────────────────────────────────────
fetch(API_BASE + '/health').catch(function(){});

// ── Load data ────────────────────────────────────────────────
var mergeData = null;
fetch('tc_radar_metadata_merge.json')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) { mergeData = data; console.log('Merge metadata loaded: ' + data.total_cases + ' cases'); _fetchEnrichedWindData('merge'); })
    .catch(function(err) { console.warn('Merge metadata not available: ' + err.message); });

fetch('tc_radar_metadata.json')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
        allData = data;
        document.getElementById('loading').style.display = 'none';
        document.getElementById('total-cases').textContent = data.total_cases.toLocaleString();
        document.getElementById('total-count').textContent = data.total_cases.toLocaleString();
        document.getElementById('filtered-count').textContent = data.total_cases.toLocaleString();

        var storms = new Set(data.cases.map(function(c) { return c.storm_name; }));
        document.getElementById('unique-storms').textContent = storms.size.toLocaleString();
        var years = data.cases.map(function(c) { return c.year; });
        document.getElementById('year-range').textContent = Math.min.apply(null, years) + '\u2013' + Math.max.apply(null, years);

        // Populate year and storm dropdowns using shared helpers
        _populateYearDropdown();
        _populateStormDropdown('');

        markers = L.markerClusterGroup({
            maxClusterRadius: 30, disableClusteringAtZoom: 10, spiderfyOnMaxZoom: true, showCoverageOnHover: false, zoomToBoundsOnClick: true,
            iconCreateFunction: function(cluster) {
                var n = cluster.getChildCount();
                var bg = n<10?'rgba(46,125,255,0.25)':n<50?'rgba(46,125,255,0.4)':n<100?'rgba(46,125,255,0.6)':n<200?'rgba(46,125,255,0.75)':'rgba(46,125,255,0.9)';
                return L.divIcon({ html:'<div style="background:'+bg+';color:white;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid rgba(255,255,255,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.4);backdrop-filter:blur(4px);font-family:\'JetBrains Mono\',monospace;">'+n+'</div>', className:'custom-cluster-icon', iconSize:L.point(40,40) });
            }
        });

        data.cases.forEach(function(caseData) {
            var color = getIntensityColor(caseData.vmax_kt);
            var icon = L.divIcon({ className:'custom-div-icon', html:'<div class="custom-marker" style="background-color:'+color+';width:16px;height:16px;box-shadow:0 0 6px '+color+'40;"></div>', iconSize:[16,16], iconAnchor:[8,8] });
            var marker = L.marker([caseData.latitude, caseData.longitude], { icon: icon });
            marker.bindPopup(createPopupContent(caseData), { maxWidth:320,minWidth:260,autoPan:true,autoPanPadding:[50,50],keepInView:true,closeButton:true,closeOnEscapeKey:true });
            allMarkers.push({ caseIndex: caseData.case_index, marker: marker });
            markers.addLayer(marker);
        });

        // Default view: tracks (load IBTrACS); clusters kept ready but not added to map
        if (_mapViewMode === 'tracks') {
            _loadIBTrACSData(function() { _renderArchiveTracks(); });
        } else {
            map.addLayer(markers);
        }

        // ── Compact intensity legend (collapsed by default) ──
        var legend = L.control({ position:'bottomright' });
        legend.onAdd = function() {
            var div = L.DomUtil.create('div','intensity-legend intensity-legend-compact');
            div.innerHTML =
                '<div class="legend-header" onclick="this.parentNode.classList.toggle(\'expanded\')" style="cursor:pointer;display:flex;align-items:center;gap:4px;">' +
                    '<span style="font-size:9px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">Intensity</span>' +
                    '<span class="legend-toggle" style="font-size:8px;color:#64748b;">&#9660;</span>' +
                '</div>' +
                '<div class="legend-body" style="display:none;">' +
                    '<div class="legend-item"><div class="legend-color" style="background:#60a5fa"></div><span>TD</span></div>' +
                    '<div class="legend-item"><div class="legend-color" style="background:#34d399"></div><span>TS</span></div>' +
                    '<div class="legend-item"><div class="legend-color" style="background:#fbbf24"></div><span>C1</span></div>' +
                    '<div class="legend-item"><div class="legend-color" style="background:#fb923c"></div><span>C2</span></div>' +
                    '<div class="legend-item"><div class="legend-color" style="background:#f87171"></div><span>C3</span></div>' +
                    '<div class="legend-item"><div class="legend-color" style="background:#ef4444"></div><span>C4</span></div>' +
                    '<div class="legend-item"><div class="legend-color" style="background:#dc2626"></div><span>C5</span></div>' +
                '</div>';
            L.DomEvent.disableClickPropagation(div);
            return div;
        };
        legend.addTo(map);

        // ── MW / IR Colorbar controls on the Leaflet map ──
        _mwMapColorbar = L.control({ position:'bottomleft' });
        _mwMapColorbar.onAdd = function() {
            var div = L.DomUtil.create('div','map-colorbar mw-map-colorbar');
            div.id = 'mw-map-colorbar';
            div.style.display = 'none';
            return div;
        };
        _mwMapColorbar.addTo(map);

        _irMapColorbar = L.control({ position:'bottomleft' });
        _irMapColorbar.onAdd = function() {
            var div = L.DomUtil.create('div','map-colorbar ir-map-colorbar');
            div.id = 'ir-map-colorbar';
            div.style.display = 'none';
            return div;
        };
        _irMapColorbar.addTo(map);
        initializeFilters();

        // Fetch enriched metadata from API to populate max wind speed fields
        _fetchEnrichedWindData('swath');

        // Check for composite permalink in URL hash
        _checkCompPermalink();

        // Handle deep links for tabs and cases
        _handleDeepLink();
    })
    .catch(function(err) { document.getElementById('loading').innerHTML = '<div style="color:#f87171;"><strong>Error loading data</strong><br><small>' + err.message + '</small></div>'; });

// ── Data-type toggle (Swath / Merge) ──────────────────────────
function _injectDataTypeToggle() {
    var toolbar = document.querySelector('.map-toolbar');
    if (!toolbar) return;
    var grp = document.createElement('div');
    grp.className = 'toolbar-group';
    grp.innerHTML =
        '<span class="toolbar-label">Analysis</span>' +
        '<select id="map-data-type" class="toolbar-select" style="min-width:100px;" onchange="switchDataType(this.value)">' +
            '<option value="swath" title="Individual radar pass analysis">Swath</option>' +
            '<option value="merge" title="Combined multi-pass analysis">Merge</option>' +
        '</select>';
    grp.querySelector('select').title = 'Choose between individual radar pass (Swath) or combined multi-pass (Merge) analyses';
    toolbar.insertBefore(grp, toolbar.firstChild);
    // add a separator after
    var sep = document.createElement('div');
    sep.className = 'toolbar-sep';
    grp.parentNode.insertBefore(sep, grp.nextSibling);
}
_injectDataTypeToggle();

// ── Year dropdown logic ──────────────────────────────────────
var _selectedYear = '';  // '' means All Years

// Build a mapping of storm_name → array of years it appears in
function _getStormYears(data) {
    var map = {};
    if (!data || !data.cases) return map;
    data.cases.forEach(function(c) {
        if (!map[c.storm_name]) map[c.storm_name] = new Set();
        map[c.storm_name].add(c.year);
    });
    return map;
}

// Populate year dropdown from active dataset
function _populateYearDropdown() {
    var data = _getActiveData();
    var yearSelect = document.getElementById('year-select');
    if (!yearSelect || !data) return;
    var years = new Set(data.cases.map(function(c) { return c.year; }));
    var sorted = Array.from(years).sort(function(a, b) { return b - a; }); // newest first
    yearSelect.innerHTML = '<option value="">All Years</option>';
    sorted.forEach(function(y) {
        var count = data.cases.filter(function(c) { return c.year === y; }).length;
        var o = document.createElement('option');
        o.value = y;
        o.textContent = y + ' (' + count + ')';
        yearSelect.appendChild(o);
    });
}

// Populate storm dropdown, optionally filtered by year; show year(s) in label
function _populateStormDropdown(yearFilter) {
    var data = _getActiveData();
    var stormSelect = document.getElementById('storm-select');
    if (!stormSelect || !data) return;
    var stormYears = _getStormYears(data);
    var storms;
    if (yearFilter) {
        storms = new Set(data.cases.filter(function(c) { return c.year === yearFilter; }).map(function(c) { return c.storm_name; }));
    } else {
        storms = new Set(data.cases.map(function(c) { return c.storm_name; }));
    }
    stormSelect.innerHTML = '<option value="">All Storms</option>';
    Array.from(storms).sort().forEach(function(s) {
        var o = document.createElement('option');
        o.value = s;
        var yrs = Array.from(stormYears[s] || []).sort();
        if (yearFilter) {
            o.textContent = s;
        } else {
            o.textContent = s + ' (' + yrs.join(', ') + ')';
        }
        stormSelect.appendChild(o);
    });
}

// Year dropdown change handler
document.getElementById('year-select').addEventListener('change', function() {
    _selectedYear = this.value ? parseInt(this.value) : '';
    // Re-populate storm dropdown filtered by year
    _populateStormDropdown(_selectedYear);
    // Reset storm / case selection
    document.getElementById('storm-select').value = '';
    filters.stormName = 'all';
    document.getElementById('case-select').innerHTML = '<option value="">\u2190 Select a storm first</option>';
    document.getElementById('case-select').disabled = true;
    document.getElementById('explore-btn').disabled = true;
    // Update map markers (year filter applied via passesFilters min/maxYear)
    if (_selectedYear) {
        filters.minYear = _selectedYear;
        filters.maxYear = _selectedYear;
        document.getElementById('min-year').value = _selectedYear;
        document.getElementById('max-year').value = _selectedYear;
    } else {
        var data = _getActiveData();
        if (data) {
            var years = data.cases.map(function(c) { return c.year; });
            filters.minYear = Math.min.apply(null, years);
            filters.maxYear = Math.max.apply(null, years);
            document.getElementById('min-year').value = filters.minYear;
            document.getElementById('max-year').value = filters.maxYear;
        }
    }
    updateMarkers();
    _updateFilterBadge();
});

// ── Filter badge: show count of active (non-default) filters ──
function _injectFilterBadge() {
    var btn = document.getElementById('filter-toggle');
    if (!btn || btn.querySelector('.filter-badge')) return;
    var badge = document.createElement('span');
    badge.className = 'filter-badge';
    badge.id = 'filter-badge';
    badge.textContent = '0';
    btn.appendChild(badge);
}
_injectFilterBadge();

function _updateFilterBadge() {
    var badge = document.getElementById('filter-badge');
    if (!badge) return;
    var count = 0;
    if (filters.minIntensity !== 0 || filters.maxIntensity !== 200) count++;
    if (filters.minVmaxChange !== -100 || filters.maxVmaxChange !== 85) count++;
    if (filters.minTilt !== 0 || filters.maxTilt !== 200) count++;
    if (filters.minWspd05 !== 0 || filters.maxWspd05 !== 100) count++;
    if (filters.minWspd20 !== 0 || filters.maxWspd20 !== 100) count++;
    // Check if year filter is narrower than full range
    var data = _getActiveData();
    if (data) {
        var years = data.cases.map(function(c) { return c.year; });
        var minY = Math.min.apply(null, years), maxY = Math.max.apply(null, years);
        if (filters.minYear !== minY || filters.maxYear !== maxY) count++;
    }
    badge.textContent = count;
    if (count > 0) { badge.classList.add('visible'); } else { badge.classList.remove('visible'); }
}

// ── Case count flash on change ────────────────────────────────
var _lastFilteredCount = -1;
var _origUpdateMarkersV2 = null; // will be set after track view overrides updateMarkers

function _flashCaseCount() {
    var el = document.querySelector('.toolbar-count');
    if (!el) return;
    var currentCount = parseInt(document.getElementById('filtered-count').textContent.replace(/,/g, ''));
    if (_lastFilteredCount !== -1 && currentCount !== _lastFilteredCount) {
        el.classList.remove('flash');
        void el.offsetWidth; // reflow to restart animation
        el.classList.add('flash');
    }
    _lastFilteredCount = currentCount;
}

// ══════════════════════════════════════════════════════════════
// ── Track View (Clusters / Tracks toggle) ─────────────────────
// ══════════════════════════════════════════════════════════════
var _mapViewMode = 'tracks';    // 'cluster' or 'tracks'
var _trackViewLayer = null;     // L.layerGroup for track polylines + markers
var _trackCanvasRenderer = null;
// ── Storm Intensity Timeline (in main archive side panel) ─────────────
var _stormTimelineVisible = false;
var _stormTimelineBaseShapes = [];
var _archFdeckLoaded = false;
var _archFdeckVisible = false;
var _archFdeckData = null;
var _archFdeckTraceCount = 0;

// Saffir-Simpson intensity color for a given wind speed (kt)
function _getSSColor(w) {
    if (w == null) return '#64748b';
    if (w >= 137) return '#dc2626';
    if (w >= 113) return '#ef4444';
    if (w >= 96)  return '#f87171';
    if (w >= 83)  return '#fb923c';
    if (w >= 64)  return '#fbbf24';
    if (w >= 34)  return '#34d399';
    return '#60a5fa';
}

function toggleStormTimeline() {
    var panel = document.getElementById('storm-timeline-panel');
    var btn = document.getElementById('storm-timeline-btn');
    if (!panel || !btn) return;

    _stormTimelineVisible = !_stormTimelineVisible;
    if (_stormTimelineVisible) {
        panel.style.display = '';
        btn.classList.add('active');
        _loadAndRenderStormTimeline();
    } else {
        panel.style.display = 'none';
        btn.classList.remove('active');
    }
}

function closeStormTimeline() {
    _stormTimelineVisible = false;
    var panel = document.getElementById('storm-timeline-panel');
    var btn = document.getElementById('storm-timeline-btn');
    if (panel) panel.style.display = 'none';
    if (btn) btn.classList.remove('active');
}

function _loadAndRenderStormTimeline() {
    if (!currentCaseData) return;
    var stormName = currentCaseData.storm_name;
    var year = currentCaseData.year;
    var key = stormName + '|' + year;

    // Ensure IBTrACS is loaded (already loaded if Tracks view was activated)
    function doRender() {
        var sid = _tdrToSID[key];
        if (!sid || !_allTracks[sid]) {
            document.getElementById('storm-timeline-chart').innerHTML =
                '<div style="padding:20px;color:#64748b;text-align:center;font-size:11px;">No IBTrACS track found for ' + stormName + ' (' + year + ')</div>';
            return;
        }
        var track = _allTracks[sid];
        var storm = _ibtStormsBySID[sid];
        _renderArchiveIntensityTimeline(track, storm);
    }

    if (_tracksLoaded) {
        doRender();
    } else {
        document.getElementById('storm-timeline-chart').innerHTML =
            '<div style="padding:20px;color:#60a5fa;text-align:center;font-size:11px;">Loading IBTrACS data...</div>';
        _loadIBTrACSData(doRender);
    }
}

function _renderArchiveIntensityTimeline(track, storm) {
    var times = [], winds = [], pres = [], colors = [];
    track.forEach(function(pt) {
        if (!pt.t) return;
        times.push(pt.t);
        winds.push(pt.w);
        pres.push(pt.p);
        colors.push(_getSSColor(pt.w));
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

    // Add vertical line at current case time
    if (currentCaseData && currentCaseData.datetime) {
        var dtParts = currentCaseData.datetime.replace(' UTC', '').split(' ');
        if (dtParts.length >= 2) {
            var isoTime = dtParts[0] + 'T' + dtParts[1];
            shapes.push({
                type: 'line', xref: 'x', yref: 'paper',
                x0: isoTime, x1: isoTime, y0: 0, y1: 1,
                line: { color: 'rgba(255,200,50,0.8)', width: 2.5, dash: 'solid' }
            });
        }
    }

    // Add TDR analysis markers — show all cases for this storm
    var stormName = currentCaseData.storm_name;
    var year = currentCaseData.year;
    var tdrTimes = [], tdrWinds = [], tdrHovers = [], tdrColors = [];
    var allCases = _getActiveData().cases.filter(function(c) {
        return c.storm_name === stormName && c.year === year;
    });
    allCases.forEach(function(c) {
        var dtParts = c.datetime.replace(' UTC', '').split(' ');
        if (dtParts.length >= 2) {
            tdrTimes.push(dtParts[0] + 'T' + dtParts[1]);
            // Show max earth-relative wind speed at 2.0 km (m/s → kt)
            var maxErWind = (c.max_er_wspd_20km != null) ? Math.round(c.max_er_wspd_20km * 1.944) : null;
            tdrWinds.push(maxErWind);
            tdrHovers.push('<b>TDR Analysis</b><br>' + c.datetime + '<br>Mission: ' + c.mission_id +
                (maxErWind != null ? '<br>Max ER Wind (2 km): ' + maxErWind + ' kt' : '') +
                '<br>BT Vmax: ' + c.vmax_kt + ' kt' +
                (c.rmw_km ? '<br>RMW: ' + c.rmw_km + ' km' : ''));
            tdrColors.push(c.case_index === currentCaseData.case_index ? '#ffd700' : '#00d4ff');
        }
    });

    _stormTimelineBaseShapes = shapes.slice();

    var windTrace = {
        x: times, y: winds,
        type: 'scatter', mode: 'lines+markers',
        name: 'Wind (kt)',
        line: { color: '#00d4ff', width: 2.5 },
        marker: { color: colors, size: 5, line: { color: 'rgba(255,255,255,0.3)', width: 0.5 } },
        hovertemplate: '<b>%{x}</b><br>Wind: %{y} kt<extra></extra>',
        yaxis: 'y'
    };

    var presTrace = {
        x: times, y: pres,
        type: 'scatter', mode: 'lines',
        name: 'Pressure (hPa)',
        line: { color: '#a78bfa', width: 1.5, dash: 'dot' },
        hovertemplate: '<b>%{x}</b><br>Pressure: %{y} hPa<extra></extra>',
        yaxis: 'y2'
    };

    var tdrTrace = {
        x: tdrTimes, y: tdrWinds,
        type: 'scatter', mode: 'markers',
        name: 'TDR Analyses',
        marker: {
            color: tdrColors, size: 10, symbol: 'diamond',
            line: { color: '#fff', width: 1.5 }
        },
        text: tdrHovers,
        hovertemplate: '%{text}<extra></extra>',
        yaxis: 'y'
    };

    var maxWind = Math.max.apply(null, winds.filter(function(w) { return w != null; })) || 100;

    var layout = {
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0a1628',
        xaxis: {
            title: { text: 'Date/Time', font: { size: 10, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            linecolor: 'rgba(255,255,255,0.08)'
        },
        yaxis: {
            title: { text: 'Max Wind (kt)', font: { size: 10, color: '#00d4ff' } },
            tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)',
            range: [0, Math.min(maxWind + 20, 200)],
            side: 'left'
        },
        yaxis2: {
            title: { text: 'Pressure (hPa)', font: { size: 10, color: '#a78bfa' } },
            tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
            overlaying: 'y', side: 'right',
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
            font: { size: 9, color: '#e2e8f0' }
        },
        title: {
            text: stormName + ' (' + year + ')',
            font: { color: '#e5e7eb', size: 13 },
            x: 0.5, xanchor: 'center', y: 0.98
        },
        margin: { l: 50, r: 50, t: 28, b: 38 },
        hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } }
    };

    Plotly.newPlot('storm-timeline-chart', [windTrace, presTrace, tdrTrace], layout, {
        responsive: true, displayModeBar: false, displaylogo: false
    });

    // Reset F-deck state for new storm
    _archFdeckLoaded = false;
    _archFdeckVisible = false;
    _archFdeckData = null;
    _archFdeckTraceCount = 0;
    var fBtn = document.getElementById('fdeck-archive-btn');
    var fSt = document.getElementById('fdeck-archive-status');
    if (fBtn) { fBtn.textContent = 'F-Deck'; fBtn.classList.remove('active'); }
    if (fSt) fSt.textContent = '';
}

// ── F-Deck for archive intensity timeline ──

var ARCHIVE_FDECK_STYLES = {
    DVTS:       { name: 'Subjective Dvorak', color: '#ff9f43', symbol: 'diamond',      size: 7 },
    DVTO:       { name: 'Objective Dvorak',  color: '#feca57', symbol: 'circle',        size: 6 },
    SFMR:       { name: 'SFMR',             color: '#ff6b6b', symbol: 'triangle-up',   size: 7 },
    FL_WIND:    { name: 'Flight-Level',      color: '#ee5a24', symbol: 'triangle-down', size: 7 },
    DROPSONDE:  { name: 'Dropsonde',         color: '#f8b739', symbol: 'square',        size: 6 },
    AIRC_OTHER: { name: 'Aircraft (Other)',  color: '#e17055', symbol: 'cross',         size: 6 }
};

function toggleArchiveFDeck() {
    if (!currentCaseData) return;

    // Need atcf_id — look up from IBTrACS
    var key = currentCaseData.storm_name + '|' + currentCaseData.year;
    var sid = _tdrToSID[key];
    var storm = sid ? _ibtStormsBySID[sid] : null;
    if (!storm || !storm.atcf_id) {
        var st = document.getElementById('fdeck-archive-status');
        if (st) { st.textContent = 'No ATCF ID'; st.style.color = '#f87171'; }
        return;
    }

    var btn = document.getElementById('fdeck-archive-btn');
    var status = document.getElementById('fdeck-archive-status');

    if (!_archFdeckLoaded) {
        btn.textContent = 'Loading...';
        btn.disabled = true;
        fetch(API_BASE + '/global/fdeck?atcf_id=' + encodeURIComponent(storm.atcf_id))
            .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function(data) {
                _archFdeckData = data.fixes;
                _archFdeckLoaded = true;
                _archFdeckVisible = true;
                btn.textContent = 'Hide F-Deck';
                btn.classList.add('active');
                btn.disabled = false;
                var total = 0;
                Object.keys(data.counts).forEach(function(k) { total += data.counts[k] || 0; });
                status.textContent = total + ' fixes';
                status.style.color = '#64748b';
                _addArchiveFDeckTraces();
            })
            .catch(function(err) {
                btn.textContent = 'F-Deck';
                btn.disabled = false;
                status.textContent = 'Not available';
                status.style.color = '#f87171';
            });
        return;
    }

    _archFdeckVisible = !_archFdeckVisible;
    if (_archFdeckVisible) {
        btn.textContent = 'Hide F-Deck';
        btn.classList.add('active');
        _addArchiveFDeckTraces();
    } else {
        btn.textContent = 'F-Deck';
        btn.classList.remove('active');
        _removeArchiveFDeckTraces();
    }
}

function _addArchiveFDeckTraces() {
    var chartEl = document.getElementById('storm-timeline-chart');
    if (!chartEl || !chartEl.data || !_archFdeckData) return;
    _removeArchiveFDeckTraces();

    var newTraces = [];
    var fixTypes = ['DVTS', 'DVTO', 'SFMR', 'FL_WIND', 'DROPSONDE', 'AIRC_OTHER'];
    fixTypes.forEach(function(ft) {
        var fixes = _archFdeckData[ft];
        if (!fixes || fixes.length === 0) return;
        var style = ARCHIVE_FDECK_STYLES[ft];
        var ftTimes = [], ftWinds = [], ftHovers = [];
        fixes.forEach(function(f) {
            ftTimes.push(f.time);
            ftWinds.push(f.wind_kt);
            var ht = '<b>' + style.name + '</b><br>' + f.time + '<br>Wind: ' + f.wind_kt + ' kt';
            if (f.ci !== undefined) ht += '<br>CI#: ' + f.ci.toFixed(1);
            if (f.agency) ht += '<br>Agency: ' + f.agency;
            ftHovers.push(ht);
        });
        newTraces.push({
            x: ftTimes, y: ftWinds,
            type: 'scatter', mode: 'markers',
            name: style.name,
            marker: { color: style.color, symbol: style.symbol, size: style.size, line: { color: 'rgba(255,255,255,0.5)', width: 1 } },
            hovertemplate: '%{text}<extra></extra>',
            text: ftHovers, yaxis: 'y'
        });
    });

    if (newTraces.length > 0) {
        Plotly.addTraces(chartEl, newTraces);
        _archFdeckTraceCount = newTraces.length;
    }
}

function _removeArchiveFDeckTraces() {
    var chartEl = document.getElementById('storm-timeline-chart');
    if (!chartEl || !chartEl.data || _archFdeckTraceCount === 0) return;
    var totalTraces = chartEl.data.length;
    var indices = [];
    for (var i = totalTraces - _archFdeckTraceCount; i < totalTraces; i++) indices.push(i);
    Plotly.deleteTraces(chartEl, indices);
    _archFdeckTraceCount = 0;
}


// ── Hovmöller (Time × Radius) ────────────────────────────────────────
var _hovmollerVisible = false;

function toggleHovmoller() {
    _ga('toggle_hovmoller', { case_index: currentCaseIndex });
    var panel = document.getElementById('hovmoller-panel');
    var btn = document.getElementById('hovmoller-btn');
    if (!panel || !btn) return;

    _hovmollerVisible = !_hovmollerVisible;
    if (_hovmollerVisible) {
        panel.style.display = '';
        btn.classList.add('active');
        _fetchAndRenderHovmoller();
    } else {
        panel.style.display = 'none';
        btn.classList.remove('active');
    }
}

function closeHovmoller() {
    _hovmollerVisible = false;
    var panel = document.getElementById('hovmoller-panel');
    var btn = document.getElementById('hovmoller-btn');
    if (panel) panel.style.display = 'none';
    if (btn) btn.classList.remove('active');
}

function _fetchAndRenderHovmoller() {
    if (!currentCaseData) return;
    var statusEl = document.getElementById('hovmoller-status');
    var chartEl = document.getElementById('hovmoller-chart');
    var variable = document.getElementById('ep-var').value || 'recentered_tangential_wind';
    var heightKm = parseFloat(document.getElementById('ep-level').value) || 2.0;

    statusEl.textContent = 'Loading ' + currentCaseData.storm_name + ' (' + currentCaseData.year + ') at ' + heightKm.toFixed(1) + ' km...';
    statusEl.style.color = '#60a5fa';

    var covEl = document.getElementById('hovmoller-coverage');
    var coverageMin = covEl ? parseFloat(covEl.value) : 0.25;

    var url = API_BASE + '/hovmoller?' +
        'storm_name=' + encodeURIComponent(currentCaseData.storm_name) +
        '&year=' + currentCaseData.year +
        '&variable=' + encodeURIComponent(variable) +
        '&data_type=' + _activeDataType +
        '&height_km=' + heightKm +
        '&max_radius_km=200&dr_km=2&coverage_min=' + coverageMin;

    fetch(url)
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
            statusEl.textContent = data.n_cases + ' analyses';
            statusEl.style.color = '#64748b';
            _renderHovmoller(data);
        })
        .catch(function(err) {
            statusEl.textContent = 'Error: ' + err.message;
            statusEl.style.color = '#f87171';
            console.warn('Hovmöller fetch failed:', err);
        });
}

function _renderHovmoller(data) {
    var profiles = data.profiles;
    var radiusKm = data.radius_km;
    var varInfo = data.variable;

    // Build scatter data: one point per (time, radius) cell with valid data
    var scatterX = [];      // datetime strings
    var scatterY = [];      // radius values
    var scatterZ = [];      // variable values (for color)
    var scatterText = [];   // hover text
    var rmwValues = [];     // For RMW line

    profiles.forEach(function(p) {
        // Parse "YYYY-MM-DD HH:MM UTC" → ISO for Plotly
        var dtParts = p.datetime.replace(' UTC', '').split(' ');
        var isoTime = dtParts.length >= 2 ? dtParts[0] + 'T' + dtParts[1] : p.datetime;

        if (p.rmw_km) rmwValues.push({ x: isoTime, y: p.rmw_km });

        p.profile.forEach(function(val, ri) {
            if (val === null) return;
            scatterX.push(isoTime);
            scatterY.push(radiusKm[ri]);
            scatterZ.push(val);
            scatterText.push(
                '<b>' + varInfo.display_name + '</b>: ' + val.toFixed(2) + ' ' + varInfo.units +
                '<br>Radius: ' + radiusKm[ri] + ' km' +
                '<br>' + p.datetime +
                '<br>Mission: ' + p.mission_id +
                '<br>Vmax: ' + (p.vmax_kt || '?') + ' kt' +
                (p.rmw_km ? '<br>RMW: ' + p.rmw_km + ' km' : '')
            );
        });
    });

    // Use scatter with colored markers — each point is a (time, radius) cell
    var mainTrace = {
        x: scatterX, y: scatterY,
        type: 'scatter', mode: 'markers',
        name: varInfo.display_name,
        marker: {
            color: scatterZ,
            colorscale: varInfo.colorscale,
            cmin: varInfo.vmin,
            cmax: varInfo.vmax,
            size: 4,
            symbol: 'square',
            colorbar: {
                title: { text: varInfo.units, font: { color: '#ccc', size: 9 } },
                tickfont: { color: '#ccc', size: 8 },
                thickness: 10, len: 0.85
            }
        },
        text: scatterText,
        hovertemplate: '%{text}<extra></extra>',
        showlegend: false
    };

    var traces = [mainTrace];

    // Add RMW markers
    if (rmwValues.length > 0) {
        traces.push({
            x: rmwValues.map(function(r) { return r.x; }),
            y: rmwValues.map(function(r) { return r.y; }),
            type: 'scatter', mode: 'markers+lines',
            name: 'RMW',
            marker: { color: '#ffd700', size: 7, symbol: 'diamond',
                      line: { color: '#fff', width: 1 } },
            line: { color: 'rgba(255,215,0,0.3)', width: 1, dash: 'dot' },
            hovertemplate: '<b>RMW</b>: %{y:.0f} km<br>%{x}<extra></extra>'
        });
    }

    // Add vertical marker for current case
    var shapes = [];
    if (currentCaseData && currentCaseData.datetime) {
        var curParts = currentCaseData.datetime.replace(' UTC', '').split(' ');
        if (curParts.length >= 2) {
            shapes.push({
                type: 'line', xref: 'x', yref: 'paper',
                x0: curParts[0] + 'T' + curParts[1],
                x1: curParts[0] + 'T' + curParts[1],
                y0: 0, y1: 1,
                line: { color: 'rgba(255,200,50,0.7)', width: 2, dash: 'solid' }
            });
        }
    }

    var layout = {
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0a1628',
        title: {
            text: data.storm_name + ' (' + data.year + ') | ' + varInfo.display_name + ' @ ' + data.height_km.toFixed(1) + ' km',
            font: { color: '#e5e7eb', size: 11 }, x: 0.5, xanchor: 'center', y: 0.98
        },
        xaxis: {
            title: { text: 'Date/Time', font: { size: 10, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            linecolor: 'rgba(255,255,255,0.08)'
        },
        yaxis: {
            title: { text: 'Radius (km)', font: { size: 10, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)',
            range: [0, 200]
        },
        shapes: shapes,
        showlegend: true,
        legend: {
            x: 0.01, y: 0.99, bgcolor: 'rgba(15,33,64,0.8)',
            bordercolor: 'rgba(255,255,255,0.08)', borderwidth: 1,
            font: { size: 9, color: '#e2e8f0' }
        },
        margin: { l: 45, r: 12, t: 30, b: 38 },
        hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } }
    };

    Plotly.newPlot('hovmoller-chart', traces, layout, {
        responsive: true, displayModeBar: false, displaylogo: false
    });
}


var _allTracks = {};            // IBTrACS track data keyed by SID
var _tracksLoaded = false;
var _tracksLoading = false;
var _ibtStorms = [];            // IBTrACS storm metadata array
var _ibtStormsBySID = {};       // Lookup by SID
var _tdrToSID = {};             // Mapping: "STORMNAME|YEAR" → IBTrACS SID

// Helper: check if IBTrACS nature code represents TC phase
function _isTCNature(n) {
    if (!n) return true;  // Assume TC if no nature data
    return n === 'TS' || n === 'SS';
}

// Build TDR → IBTrACS SID mapping
function _buildTDRtoSIDMapping() {
    if (!_ibtStorms.length) return;
    _tdrToSID = {};
    _ibtStorms.forEach(function(s) {
        if (s.name && s.year) {
            var key = s.name + '|' + s.year;
            // Some storms share name+year across basins; prefer NA/EP
            if (!_tdrToSID[key] || (s.basin === 'NA' || s.basin === 'EP')) {
                _tdrToSID[key] = s.sid;
            }
        }
    });
}

// Load IBTrACS storms + tracks (chunked)
function _loadIBTrACSData(onDone) {
    if (_tracksLoaded || _tracksLoading) { if (onDone) onDone(); return; }
    _tracksLoading = true;

    // 1) Load storm metadata
    var stormsReady = false, tracksReady = false;
    function checkDone() { if (stormsReady && tracksReady) { _tracksLoaded = true; _tracksLoading = false; _buildTDRtoSIDMapping(); console.log('IBTrACS loaded: ' + _ibtStorms.length + ' storms, ' + Object.keys(_allTracks).length + ' tracks'); if (onDone) onDone(); } }

    fetch('ibtracs_storms.json')
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
            _ibtStorms = data.storms || [];
            _ibtStorms.forEach(function(s) { _ibtStormsBySID[s.sid] = s; });
            stormsReady = true;
            checkDone();
        })
        .catch(function(err) { console.warn('Failed to load IBTrACS storms: ' + err.message); _tracksLoading = false; });

    // 2) Load chunked tracks
    fetch('ibtracs_tracks_manifest.json')
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(manifest) {
            var nChunks = manifest.chunks.length;
            var loaded = 0;
            manifest.chunks.forEach(function(chunkName) {
                fetch(chunkName)
                    .then(function(r) { return r.json(); })
                    .then(function(chunk) {
                        var keys = Object.keys(chunk);
                        for (var i = 0; i < keys.length; i++) { _allTracks[keys[i]] = chunk[keys[i]]; }
                        loaded++;
                        if (loaded === nChunks) { tracksReady = true; checkDone(); }
                    })
                    .catch(function(err) { console.warn('Failed to load track chunk ' + chunkName + ': ' + err.message); loaded++; if (loaded === nChunks) { tracksReady = true; checkDone(); } });
            });
        })
        .catch(function() {
            // Fallback: single file
            fetch('ibtracs_tracks.json')
                .then(function(r) { return r.json(); })
                .then(function(data) { _allTracks = data; tracksReady = true; checkDone(); })
                .catch(function(err) { console.warn('Failed to load tracks: ' + err.message); _tracksLoading = false; });
        });
}

// Inject the Clusters / Tracks toggle into the toolbar
function _injectViewToggle() {
    var toolbar = document.querySelector('.map-toolbar');
    if (!toolbar) return;
    var grp = document.createElement('div');
    grp.className = 'toolbar-group view-toggle-group';
    grp.innerHTML =
        '<div class="archive-view-toggle">' +
            '<button class="archive-view-btn" data-view="cluster" onclick="setArchiveMapView(\'cluster\')" title="Show clustered markers">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="8" cy="18" r="2"/><circle cx="17" cy="17" r="2"/></svg>' +
                ' Clusters' +
            '</button>' +
            '<button class="archive-view-btn active" data-view="tracks" onclick="setArchiveMapView(\'tracks\')" title="Show best-track lines with TDR markers">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l4-4 4 4 4-8 5 6"/><circle cx="7" cy="13" r="1.5" fill="currentColor"/><circle cx="15" cy="9" r="1.5" fill="currentColor"/></svg>' +
                ' Tracks' +
            '</button>' +
        '</div>';
    // Insert after the Reset button (before the count span)
    var countSpan = toolbar.querySelector('.toolbar-count');
    if (countSpan) {
        toolbar.insertBefore(grp, countSpan);
    } else {
        toolbar.appendChild(grp);
    }
}
_injectViewToggle();

// Switch between cluster and track views
window.setArchiveMapView = function(mode) {
    if (mode === _mapViewMode) return;
    _mapViewMode = mode;

    // Update toggle button active states
    document.querySelectorAll('.archive-view-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-view') === mode);
    });

    if (mode === 'cluster') {
        // Remove tracks, show clusters
        if (_trackViewLayer) map.removeLayer(_trackViewLayer);
        map.addLayer(markers);
    } else {
        // Show tracks — load IBTrACS if not yet loaded
        map.removeLayer(markers);
        if (!_tracksLoaded) {
            showToast('Loading best-track data (~45 MB)…', 'info', 4000);
            _loadIBTrACSData(function() {
                _renderArchiveTracks();
            });
        } else {
            _renderArchiveTracks();
        }
    }
};

// Get unique storms from current active filtered data
function _getFilteredTDRStorms() {
    var data = _getActiveData();
    if (!data) return {};
    // Group filtered cases by storm_name|year
    var storms = {};
    data.cases.forEach(function(c) {
        if (!passesFilters(c)) return;
        var key = c.storm_name + '|' + c.year;
        if (!storms[key]) storms[key] = { name: c.storm_name, year: c.year, cases: [] };
        storms[key].cases.push(c);
    });
    return storms;
}

// Main track rendering function
function _renderArchiveTracks() {
    if (!_trackViewLayer) {
        _trackCanvasRenderer = L.canvas({ padding: 0.5 });
        _trackViewLayer = L.layerGroup();
    }
    _trackViewLayer.clearLayers();

    var tdrStorms = _getFilteredTDRStorms();
    var stormKeys = Object.keys(tdrStorms);
    var rendered = 0;

    stormKeys.forEach(function(key) {
        var storm = tdrStorms[key];
        var sid = _tdrToSID[key];
        var track = sid ? _allTracks[sid] : null;

        if (track && track.length >= 2) {
            // Draw best-track polyline
            _drawBestTrack(track, storm, sid);
            rendered++;
        }

        // Always draw TDR center-fix markers (even if no best-track match)
        storm.cases.forEach(function(c) {
            var color = getIntensityColor(c.vmax_kt);
            var cm = L.circleMarker([c.latitude, c.longitude], {
                renderer: _trackCanvasRenderer,
                radius: 5,
                color: '#fff',
                weight: 1.5,
                fillColor: color,
                fillOpacity: 0.95,
                opacity: 0.9
            });
            cm.bindTooltip(
                '<strong>' + c.storm_name + '</strong> (' + c.year + ')<br>' +
                c.datetime + '<br>' +
                (c.vmax_kt != null ? c.vmax_kt + ' kt' : '') +
                (c.tilt_magnitude_km != null ? ' · Tilt: ' + c.tilt_magnitude_km.toFixed(1) + ' km' : ''),
                { className: 'track-tooltip', direction: 'top', offset: [0, -6] }
            );
            cm.on('click', function() { openSidePanelById(c.case_index); });
            _trackViewLayer.addLayer(cm);
        });
    });

    _trackViewLayer.addTo(map);

    var nCases = 0;
    stormKeys.forEach(function(k) { nCases += tdrStorms[k].cases.length; });
    document.getElementById('filtered-count').textContent = nCases;
    console.log('Rendered ' + rendered + ' best tracks + TDR markers for ' + stormKeys.length + ' storms');
}

// Draw a single storm's best-track polyline
function _drawBestTrack(track, storm, sid) {
    // Collect valid points
    var pts = [];
    for (var i = 0; i < track.length; i++) {
        if (track[i].la != null && track[i].lo != null) pts.push(track[i]);
    }
    if (pts.length < 2) return;

    // Build color-segmented polyline
    var segColor = _isTCNature(pts[0].n) ? getIntensityColor(pts[0].w) : '#6b7280';
    var segIsTC = _isTCNature(pts[0].n);
    var runCoords = [[pts[0].la, pts[0].lo]];

    for (var j = 1; j < pts.length; j++) {
        var p = pts[j];
        var isTC = _isTCNature(p.n);
        var ptColor = isTC ? getIntensityColor(p.w) : '#6b7280';

        if (ptColor !== segColor || isTC !== segIsTC) {
            if (runCoords.length >= 2) {
                _addArchiveTrackPolyline(runCoords, segIsTC, segColor, storm);
            }
            runCoords = [[pts[j - 1].la, pts[j - 1].lo]];
            segColor = ptColor;
            segIsTC = isTC;
        }
        runCoords.push([p.la, p.lo]);
    }
    if (runCoords.length >= 2) {
        _addArchiveTrackPolyline(runCoords, segIsTC, segColor, storm);
    }
}

function _addArchiveTrackPolyline(coords, isTC, segColor, storm) {
    var opts = {
        renderer: _trackCanvasRenderer,
        interactive: true
    };
    if (isTC) {
        opts.color = segColor;
        opts.weight = 1.8;
        opts.opacity = 0.55;
    } else {
        opts.color = '#6b7280';
        opts.weight = 0.8;
        opts.opacity = 0.2;
        opts.dashArray = '4,3';
    }
    var line = L.polyline(coords, opts);
    line.bindTooltip(
        '<strong>' + storm.name + '</strong> (' + storm.year + ')',
        { sticky: true, className: 'track-tooltip' }
    );
    line.on('mouseover', function() { if (isTC) this.setStyle({ weight: 3.5, opacity: 1 }); });
    line.on('mouseout', function() { if (isTC) this.setStyle({ weight: 1.8, opacity: 0.55 }); });
    _trackViewLayer.addLayer(line);
}

// Hook into updateMarkers so track view also refreshes when filters change
var _origUpdateMarkers = updateMarkers;
updateMarkers = function() {
    _origUpdateMarkers();
    if (_mapViewMode === 'tracks' && _tracksLoaded) {
        _renderArchiveTracks();
    }
    // Update filter badge and flash case count
    _updateFilterBadge();
    _flashCaseCount();
};

function switchDataType(dt) {
    if (dt === _activeDataType) return;
    _ga('switch_data_type', { from: _activeDataType, to: dt });
    var src = dt === 'merge' ? mergeData : allData;
    if (!src) {
        alert(dt === 'merge' ? 'Merge metadata not loaded yet.' : 'Swath metadata not loaded yet.');
        document.getElementById('map-data-type').value = _activeDataType;
        return;
    }
    _activeDataType = dt;
    closeSidePanel();

    // Update hero stats
    document.getElementById('total-cases').textContent = src.total_cases.toLocaleString();
    document.getElementById('total-count').textContent = src.total_cases.toLocaleString();
    var storms = new Set(src.cases.map(function(c) { return c.storm_name; }));
    document.getElementById('unique-storms').textContent = storms.size.toLocaleString();
    var years = src.cases.map(function(c) { return c.year; });
    document.getElementById('year-range').textContent = Math.min.apply(null, years) + '\u2013' + Math.max.apply(null, years);

    // Rebuild year and storm dropdowns
    _selectedYear = '';
    document.getElementById('year-select').value = '';
    _populateYearDropdown();
    _populateStormDropdown('');

    // Reset year filter to full range of new dataset
    filters.minYear = Math.min.apply(null, years);
    filters.maxYear = Math.max.apply(null, years);
    document.getElementById('min-year').value = filters.minYear;
    document.getElementById('max-year').value = filters.maxYear;

    // Reset case dropdown
    document.getElementById('case-select').innerHTML = '<option value="">\u2190 Select a storm first</option>';
    document.getElementById('case-select').disabled = true;
    document.getElementById('explore-btn').disabled = true;
    filters.stormName = 'all';

    // Rebuild markers
    markers.clearLayers();
    allMarkers = [];
    src.cases.forEach(function(caseData) {
        var color = getIntensityColor(caseData.vmax_kt);
        var icon = L.divIcon({ className:'custom-div-icon', html:'<div class="custom-marker" style="background-color:'+color+';width:16px;height:16px;box-shadow:0 0 6px '+color+'40;"></div>', iconSize:[16,16], iconAnchor:[8,8] });
        var marker = L.marker([caseData.latitude, caseData.longitude], { icon: icon });
        marker.bindPopup(createPopupContent(caseData), { maxWidth:320,minWidth:260,autoPan:true,autoPanPadding:[50,50],keepInView:true,closeButton:true,closeOnEscapeKey:true });
        allMarkers.push({ caseIndex: caseData.case_index, marker: marker });
        markers.addLayer(marker);
    });
    updateMarkers();
}

// Update explorer panel Original optgroups when data type changes
function _updateExplorerOriginalGroups() {
    var isMerge = _activeDataType === 'merge';
    var label = isMerge ? 'Original Merged' : 'Original Swath';
    var options = isMerge ?
        '<option value="merged_tangential_wind">Tangential Wind</option>' +
        '<option value="merged_radial_wind">Radial Wind</option>' +
        '<option value="merged_reflectivity">Reflectivity</option>' +
        '<option value="merged_wind_speed">Wind Speed</option>' +
        '<option value="merged_upward_air_velocity">Vertical Velocity</option>' +
        '<option value="merged_relative_vorticity">Relative Vorticity</option>' +
        '<option value="merged_divergence">Divergence</option>'
        :
        '<option value="swath_tangential_wind">Tangential Wind</option>' +
        '<option value="swath_radial_wind">Radial Wind</option>' +
        '<option value="swath_reflectivity">Reflectivity</option>' +
        '<option value="swath_wind_speed">Wind Speed</option>' +
        '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>';
    ['ep-var-original','ep-overlay-original'].forEach(function(id) {
        var og = document.getElementById(id);
        if (og) { og.label = label; og.innerHTML = options; }
    });
}

// ── Smooth scroll ────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(function(a) {
    a.addEventListener('click', function(e) { e.preventDefault(); var t = document.querySelector(this.getAttribute('href')); if (t) t.scrollIntoView({ behavior:'smooth', block:'start' }); });
});

// ── Fullscreen plot modal ─────────────────────────────────────
function openPlotModal(csJson) {
    if (!window._lastPlotlyData) return;
    var modal = document.getElementById('plotModal'), box = document.getElementById('plotModalBox');
    var csFull = document.getElementById('cs-fullscreen'), csDivider = document.getElementById('cs-full-divider');
    var azFull = document.getElementById('az-fullscreen'), azDivider = document.getElementById('az-full-divider');
    var sqFull = document.getElementById('sq-fullscreen');
    var sqDivider = document.getElementById('sq-full-divider');
    modal.classList.add('active'); document.body.style.overflow = 'hidden';
    var hasCrossSection = !!csJson, hasAzMean = !!_lastAzJson || !!_lastHybridAzJson || !!_lastAnomalyAzJson || !!_lastVPScatterJson || !!_lastCFADJson, hasShearQuads = !!_lastSqJson;
    var hasSub = hasCrossSection || hasAzMean || hasShearQuads;
    if (hasSub) box.classList.add('split'); else box.classList.remove('split');
    csFull.style.display = hasCrossSection?'block':'none'; csDivider.style.display = hasCrossSection?'block':'none';
    azFull.style.display = hasAzMean?'block':'none'; azDivider.style.display = hasAzMean?'block':'none';
    sqFull.style.display = hasShearQuads?'block':'none'; sqDivider.style.display = hasShearQuads?'block':'none';
    var subCount = (hasCrossSection?1:0)+(hasAzMean?1:0)+(hasShearQuads?1:0);
    // Adjust heights based on what's being shown
    if (hasShearQuads && subCount === 1) {
        // Shear quads only: give it most of the space (it's a 4-panel plot)
        document.getElementById('plotly-fullscreen').style.height = '45%';
        sqFull.style.height = '52%';
    } else if (subCount === 0) {
        document.getElementById('plotly-fullscreen').style.height = '100%';
    } else if (subCount === 1) {
        document.getElementById('plotly-fullscreen').style.height = '55%';
        if (hasShearQuads) sqFull.style.height = '42%';
    } else if (subCount === 2) {
        document.getElementById('plotly-fullscreen').style.height = '40%';
        if (hasShearQuads) sqFull.style.height = '38%';
    } else {
        document.getElementById('plotly-fullscreen').style.height = '30%';
        if (hasShearQuads) sqFull.style.height = '32%';
    }

    var d = window._lastPlotlyData;
    var fullLayout = Object.assign({}, d.baseLayout, { title: { text: d.title, font: { color: '#e5e7eb', size: 15 }, y: 0.97, x: 0.5, xanchor: 'center', yanchor: 'top' }, margin: { l:65,r:30,t:d.overlayTraces&&d.overlayTraces.length?80:64,b:55 }, xaxis: Object.assign({}, d.baseLayout.xaxis, { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 13 } }, tickfont: { color: '#aaa', size: 11 } }), yaxis: Object.assign({}, d.baseLayout.yaxis, { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 13 } }, tickfont: { color: '#aaa', size: 11 } }) });
    // Scale up annotations for fullscreen
    if (fullLayout.annotations) {
        fullLayout.annotations = fullLayout.annotations.map(function(a) {
            return Object.assign({}, a, { font: Object.assign({}, a.font, { size: 11 }) });
        });
    }
    // Shear + motion vectors now rendered as HTML compass (not in Plotly)
    var fullCbar = { title: { text: d.heatmap.colorbar.title.text, font: { color: '#ccc', size: 13 } }, tickfont: { color: '#ccc', size: 11 }, thickness: 16, len: 0.85 };
    if (d.tiltTraces && d.tiltTraces.length > 0) {
        fullCbar.len = 0.42;
        fullCbar.y = 0.98;
        fullCbar.yanchor = 'top';
        fullCbar.x = 1.01;
        fullCbar.xpad = 2;
    }
    var fullHeatmap = Object.assign({}, d.heatmap, { colorbar: Object.assign({}, d.heatmap.colorbar, fullCbar) });

    // Capture dynamic overlays (FL traces, IR/MW images) from the live plot
    var livePlot = document.getElementById('plotly-chart');
    var liveTraces = d.overlayTraces || [];
    var liveImages = [];
    var mwTraces = [];  // MW traces to prepend (below TDR)
    if (livePlot && livePlot.data) {
        // Separate MW traces from other dynamic traces
        // MW traces are tagged with _isMW and inserted at index 0
        var baseCount = 1 + (d.overlayTraces||[]).length + (d.maxTraces||[]).length + (d.tiltTraces||[]).length;
        // Account for MW traces shifting indices
        var mwCount = 0;
        for (var i = 0; i < livePlot.data.length; i++) {
            if (livePlot.data[i]._isMW) {
                mwTraces.push(Object.assign({}, livePlot.data[i]));
                mwCount++;
            }
        }
        var adjustedBase = baseCount + mwCount;
        if (livePlot.data.length > adjustedBase) {
            var extraTraces = [];
            for (var i = 0; i < livePlot.data.length; i++) {
                if (livePlot.data[i]._isMW) continue;  // already captured
                // Skip the base TDR traces (heatmap, overlay, max, tilt)
                // They're recreated from _lastPlotlyData
            }
            // Collect non-MW, non-base traces (FL, sondes, etc.)
            var seen = 0;
            for (var i = 0; i < livePlot.data.length; i++) {
                if (livePlot.data[i]._isMW) continue;
                seen++;
                if (seen > baseCount) {
                    extraTraces.push(Object.assign({}, livePlot.data[i]));
                }
            }
            liveTraces = liveTraces.concat(extraTraces);
        }
        // Capture IR/MW images from the live layout
        if (livePlot.layout && livePlot.layout.images && livePlot.layout.images.length > 0) {
            liveImages = livePlot.layout.images.map(function(img) {
                return Object.assign({}, img);
            });
        }
    }
    if (liveImages.length > 0) {
        fullLayout.images = liveImages;
    }

    // Build fullscreen traces: MW (below) + TDR heatmap + overlays + max + tilt + dynamic
    var allTraces = mwTraces.concat([fullHeatmap]).concat(liveTraces).concat(d.maxTraces||[]).concat(d.tiltTraces||[]);
    Plotly.newPlot('plotly-fullscreen', allTraces, fullLayout, d.config);
    if (hasCrossSection) renderCrossSectionInto('cs-fullscreen', csJson, true);
    if (hasAzMean) {
        if (_lastCFADJson) renderSingleCFADInto('az-fullscreen', _lastCFADJson, true);
        else if (_lastVPScatterJson) renderVPScatterInto('az-fullscreen', _lastVPScatterJson, true);
        else if (_lastAnomalyAzJson) renderAnomalyAzimuthalMeanInto('az-fullscreen', _lastAnomalyAzJson, true);
        else if (_lastHybridAzJson) renderHybridAzimuthalMeanInto('az-fullscreen', _lastHybridAzJson, true);
        else renderAzimuthalMeanInto('az-fullscreen', _lastAzJson, true);
    }
    if (hasShearQuads) renderQuadrantMeansInto('sq-fullscreen', _lastSqJson, true);
}

function closePlotModal() {
    document.getElementById('plotModal').classList.remove('active');
    document.getElementById('plotModalBox').classList.remove('split');
    document.body.style.overflow = '';
    Plotly.purge('plotly-fullscreen');
    var csFull = document.getElementById('cs-fullscreen'); if (csFull) { Plotly.purge('cs-fullscreen'); csFull.style.display='none'; }
    document.getElementById('cs-full-divider').style.display='none';
    var azFull = document.getElementById('az-fullscreen'); if (azFull) { Plotly.purge('az-fullscreen'); azFull.style.display='none'; }
    document.getElementById('az-full-divider').style.display='none';
    var sqFull = document.getElementById('sq-fullscreen'); if (sqFull) { Plotly.purge('sq-fullscreen'); sqFull.style.display='none'; }
    var sqDiv = document.getElementById('sq-full-divider'); if (sqDiv) sqDiv.style.display='none';
}

// ── Image modal ──────────────────────────────────────────────
function openImageModal(url, caption) { document.getElementById('imageModal').style.display = 'block'; document.getElementById('modalImage').src = url; document.getElementById('modalCaption').textContent = caption; }
function closeImageModal() { document.getElementById('imageModal').style.display = 'none'; }
document.addEventListener('click', function(e) { if (e.target===document.getElementById('imageModal')) closeImageModal(); });
document.addEventListener('keydown', function(e) { if (e.key==='Escape') { closeImageModal(); closePlotModal(); close3DModal(); } });

// ── 3D Isosurface Volume Viewer ───────────────────────────────
var _last3DJson = null;

function fetch3DVolume() {
    if (currentCaseIndex === null) return;
    var variable = document.getElementById('ep-var').value;
    _ga('view_3d_volume', { case_index: currentCaseIndex, variable: variable, data_type: _activeDataType });
    var btn = document.getElementById('vol-btn');
    btn.disabled = true; btn.textContent = '\uD83D\uDDA5 Loading\u2026';

    // Check cache
    var cacheKey = '3d_' + _activeDataType + '_' + currentCaseIndex + '_' + variable;
    if (_dataCache[cacheKey]) {
        _last3DJson = _dataCache[cacheKey];
        open3DModal();
        btn.disabled = false; btn.textContent = '\uD83D\uDDA5 3D Volume';
        return;
    }

    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 120000);
    var url = API_BASE + '/volume?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=' + _activeDataType + '&stride=2&max_height_km=15&compact=true&tilt_profile=true';
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) {
            _dataCache[cacheKey] = json;
            _last3DJson = json;
            open3DModal();
        })
        .catch(function(err) {
            var msg = err.name === 'AbortError' ? 'Request timed out (120s).' : err.message;
            alert('\u26A0\uFE0F 3D Volume: ' + msg);
        })
        .finally(function() { clearTimeout(timeout); btn.disabled = false; btn.textContent = '\uD83D\uDDA5 3D Volume'; });
}

function open3DModal() {
    if (!_last3DJson) return;
    var modal = document.getElementById('vol3DModal');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    var json = _last3DJson;
    var vi = json.variable;

    // Build title
    var meta = json.case_meta || {};
    var title = (meta.storm_name || '') + '  |  ' + (meta.datetime || '') +
        (meta.vmax_kt !== null && meta.vmax_kt !== undefined ? ' [' + meta.vmax_kt + ' kt]' : '') +
        '\n' + vi.display_name + '  \u2014  3D Isosurface';

    // Set up control defaults from data range
    var isoMin = document.getElementById('vol-iso-min');
    var isoMax = document.getElementById('vol-iso-max');
    var surfs = document.getElementById('vol-surfaces');
    var opac = document.getElementById('vol-opacity');
    var capBtn = document.getElementById('vol-caps');

    // Reasonable defaults based on variable
    var dMin = vi.data_min, dMax = vi.data_max;
    var rangeMin = Math.max(vi.vmin, dMin);
    var rangeMax = Math.min(vi.vmax, dMax);
    // For diverging variables (vmin < 0), only show positive isosurfaces by default
    if (vi.vmin < 0) {
        rangeMin = Math.max(0, dMin);
    }
    // For reflectivity, start at 15 dBZ
    if (vi.key.indexOf('reflectivity') !== -1) {
        rangeMin = Math.max(15, rangeMin);
    }

    isoMin.value = rangeMin.toFixed(1);
    isoMax.value = rangeMax.toFixed(1);
    document.getElementById('vol-iso-min-val').textContent = rangeMin.toFixed(1);
    document.getElementById('vol-iso-max-val').textContent = rangeMax.toFixed(1);
    document.getElementById('vol-units').textContent = vi.units;

    render3DIsosurface();
}

function close3DModal() {
    var modal = document.getElementById('vol3DModal');
    if (!modal) return;
    modal.classList.remove('active');
    document.body.style.overflow = '';
    Plotly.purge('vol-3d-chart');
}

function render3DIsosurface() {
    var json = _last3DJson;
    if (!json) return;

    var vi = json.variable;
    var sentinel = json.sentinel;

    var isoMin = parseFloat(document.getElementById('vol-iso-min').value) || vi.vmin;
    var isoMax = parseFloat(document.getElementById('vol-iso-max').value) || vi.vmax;
    var nSurfaces = parseInt(document.getElementById('vol-surfaces').value) || 4;
    var opacity = parseFloat(document.getElementById('vol-opacity').value) || 0.3;
    var showCaps = document.getElementById('vol-caps').classList.contains('active');

    // Clamp iso range above sentinel
    if (isoMin <= sentinel + 1) isoMin = sentinel + 1;

    var meta = json.case_meta || {};
    var title = (meta.storm_name || '') + '  |  ' + (meta.datetime || '') +
        (meta.vmax_kt !== null && meta.vmax_kt !== undefined ? ' [' + meta.vmax_kt + ' kt]' : '') +
        '<br><span style="font-size:12px;">' + vi.display_name + ' (' + vi.units + ')  \u2014  3D Isosurface</span>';

    // Handle both compact (x_axis/y_axis/z_axis) and legacy (x/y/z) formats.
    // Compact sends 1D axis vectors; we reconstruct the flattened meshgrid here.
    // Legacy sends pre-flattened meshgrid arrays directly.
    var xFlat, yFlat, zFlat;
    if (json.x_axis) {
        // Compact format: reconstruct flattened meshgrid from 1D axes
        var xA = json.x_axis, yA = json.y_axis, zA = json.z_axis;
        var shape = json.grid_shape;
        var nz = shape[0], ny = shape[1], nx = shape[2];
        var total = nz * ny * nx;
        xFlat = new Array(total);
        yFlat = new Array(total);
        zFlat = new Array(total);
        var idx = 0;
        for (var iz = 0; iz < nz; iz++) {
            for (var iy = 0; iy < ny; iy++) {
                for (var ix = 0; ix < nx; ix++) {
                    xFlat[idx] = xA[ix];
                    yFlat[idx] = yA[iy];
                    zFlat[idx] = zA[iz];
                    idx++;
                }
            }
        }
    } else {
        // Legacy format: use pre-flattened arrays directly
        xFlat = json.x;
        yFlat = json.y;
        zFlat = json.z;
    }

    var plotBg = '#0d1117';

    var trace = {
        type: 'isosurface',
        x: xFlat,
        y: yFlat,
        z: zFlat,
        value: json.value,
        isomin: isoMin,
        isomax: isoMax,
        surface: { count: nSurfaces, fill: 1.0 },
        caps: {
            x: { show: showCaps },
            y: { show: showCaps },
            z: { show: showCaps }
        },
        opacity: opacity,
        colorscale: vi.colorscale,
        cmin: isoMin,
        cmax: isoMax,
        colorbar: {
            title: { text: vi.units, font: { color: '#ccc', size: 12 } },
            tickfont: { color: '#ccc', size: 10 },
            thickness: 14,
            len: 0.7,
            x: 1.02
        },
        showscale: true,
        hovertemplate: '<b>' + vi.display_name + '</b>: %{value:.1f} ' + vi.units +
            '<br>X: %{x:.0f} km  Y: %{y:.0f} km<br>Height: %{z:.1f} km<extra></extra>',
        lighting: {
            ambient: 0.6,
            diffuse: 0.7,
            specular: 0.3,
            roughness: 0.6,
            fresnel: 0.3
        },
        lightposition: { x: 1000, y: 1000, z: 2000 }
    };

    // Determine axis ranges — use compact axis vectors if available (faster),
    // otherwise fall back to first/last of flattened arrays
    var gs = json.grid_shape; // [nz, ny, nx]
    var xRange, yRange, zRange;
    if (json.x_axis) {
        xRange = [json.x_axis[0], json.x_axis[json.x_axis.length - 1]];
        yRange = [json.y_axis[0], json.y_axis[json.y_axis.length - 1]];
        zRange = [json.z_axis[0], json.z_axis[json.z_axis.length - 1]];
    } else {
        xRange = [xFlat[0], xFlat[xFlat.length - 1]];
        yRange = [yFlat[0], yFlat[yFlat.length - 1]];
        zRange = [zFlat[0], zFlat[zFlat.length - 1]];
    }

    // Horizontal span (km) vs vertical span
    var hSpan = Math.max(xRange[1] - xRange[0], yRange[1] - yRange[0]);
    var vSpan = zRange[1] - zRange[0];
    var vertExag = Math.min(hSpan / vSpan * 0.25, 8); // Exaggerate vertical but cap it

    var layout = {
        title: { text: title, font: { color: '#e5e7eb', size: 15 }, y: 0.97, x: 0.5, xanchor: 'center' },
        paper_bgcolor: plotBg,
        scene: {
            bgcolor: plotBg,
            xaxis: {
                title: { text: 'East (km)', font: { color: '#aaa', size: 11 } },
                tickfont: { color: '#888', size: 9 },
                gridcolor: 'rgba(255,255,255,0.06)',
                showbackground: true,
                backgroundcolor: '#0f1419'
            },
            yaxis: {
                title: { text: 'North (km)', font: { color: '#aaa', size: 11 } },
                tickfont: { color: '#888', size: 9 },
                gridcolor: 'rgba(255,255,255,0.06)',
                showbackground: true,
                backgroundcolor: '#0f1419'
            },
            zaxis: {
                title: { text: 'Height (km)', font: { color: '#aaa', size: 11 } },
                tickfont: { color: '#888', size: 9 },
                gridcolor: 'rgba(255,255,255,0.06)',
                showbackground: true,
                backgroundcolor: '#111822'
            },
            aspectmode: 'manual',
            aspectratio: { x: 1, y: 1, z: 1 / vertExag },
            camera: {
                eye: { x: 0, y: -2.2, z: 0.8 },
                up: { x: 0, y: 0, z: 1 },
                center: { x: 0, y: 0, z: -0.1 }
            }
        },
        margin: { l: 0, r: 0, t: 50, b: 0 },
        hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } }
    };

    // Preserve camera position across re-renders (caps/iso changes)
    var chartDiv = document.getElementById('vol-3d-chart');
    var savedCamera = null;
    if (chartDiv && chartDiv.layout && chartDiv.layout.scene && chartDiv.layout.scene.camera) {
        savedCamera = JSON.parse(JSON.stringify(chartDiv.layout.scene.camera));
    }
    if (savedCamera) layout.scene.camera = savedCamera;

    Plotly.newPlot('vol-3d-chart', [trace], layout, {
        responsive: true,
        displayModeBar: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['toImage', 'resetCameraLastSave3d']
    }).then(function() {
        // Reset TDR toggle to active (trace 0 is always visible after newPlot)
        var tdrBtn = document.getElementById('vol-tdr-toggle');
        if (tdrBtn && !tdrBtn.classList.contains('active')) tdrBtn.classList.add('active');

        // Reset overlay trace state and re-add any active overlays
        _3dTiltTraceStart = -1;
        _addTiltTo3D();
        // Fire a custom event so realtime_tdr.js can re-add its overlays (sondes, tilt)
        document.dispatchEvent(new CustomEvent('vol3d-rerendered'));
    });
}

function toggle3DCaps() {
    var btn = document.getElementById('vol-caps');
    btn.classList.toggle('active');
    render3DIsosurface();
}

// ── 3D Tilt Hodograph ──────────────────────────────────────────
var _3dTiltTraceStart = -1;   // index where tilt traces begin in chart data

function _build3DTiltTraces(tiltData) {
    /**
     * Build scatter3d traces for the vortex tilt path in the 3D viewer.
     * Returns an array of Plotly trace objects:
     *   [0] connecting line  (white dotted)
     *   [1] markers at each height  (coloured by height)
     */
    if (!tiltData || !tiltData.x_km || !tiltData.x_km.length) return [];
    var rawX = tiltData.x_km, rawY = tiltData.y_km, rawZ = tiltData.height_km;
    var rawMag = tiltData.tilt_magnitude_km || [];
    var rawRmw = tiltData.rmw_km || [];
    var refH = tiltData.ref_height_km || 2.0;

    // Filter out levels where any coordinate is null/undefined
    var x = [], y = [], z = [], tiltMag = [], rmw = [];
    for (var k = 0; k < rawZ.length; k++) {
        if (rawX[k] == null || rawY[k] == null || rawZ[k] == null) continue;
        x.push(rawX[k]); y.push(rawY[k]); z.push(rawZ[k]);
        tiltMag.push(rawMag[k] != null ? rawMag[k] : null);
        rmw.push(rawRmw[k] != null ? rawRmw[k] : null);
    }
    if (z.length < 2) return [];

    // Build hover text
    var hoverText = [];
    for (var i = 0; i < z.length; i++) {
        var txt = '<b>' + z[i].toFixed(1) + ' km</b>' +
            '<br>X: ' + x[i].toFixed(1) + ' km' +
            '<br>Y: ' + y[i].toFixed(1) + ' km';
        if (tiltMag[i] !== null) txt += '<br>Tilt: ' + tiltMag[i].toFixed(1) + ' km';
        if (rmw[i] !== null) txt += '<br>RMW: ' + rmw[i].toFixed(1) + ' km';
        hoverText.push(txt);
    }

    // Marker sizes: larger at reference height
    var sizes = [];
    for (var j = 0; j < z.length; j++) {
        sizes.push(Math.abs(z[j] - refH) < 0.3 ? 7 : 4);
    }

    var lineTrace = {
        type: 'scatter3d',
        mode: 'lines',
        x: x, y: y, z: z,
        line: { color: 'rgba(52,211,153,0.6)', width: 3, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: false
    };

    var markerTrace = {
        type: 'scatter3d',
        mode: 'markers+text',
        x: x, y: y, z: z,
        marker: {
            size: sizes,
            color: z,
            colorscale: 'Viridis',
            cmin: 0, cmax: 14,
            line: { color: 'rgba(255,255,255,0.4)', width: 0.5 },
            colorbar: {
                title: { text: 'Height (km)', font: { color: '#ccc', size: 10 } },
                tickfont: { color: '#ccc', size: 9 },
                thickness: 10, len: 0.35,
                x: 1.08, y: 0.15,
                xanchor: 'left'
            }
        },
        text: z.map(function(h) { return h.toFixed(1); }),
        textposition: 'top right',
        textfont: { size: 8, color: 'rgba(110,231,183,0.7)' },
        hovertext: hoverText,
        hoverinfo: 'text',
        hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } },
        showlegend: false
    };

    return [lineTrace, markerTrace];
}

function _addTiltTo3D() {
    var chartDiv = document.getElementById('vol-3d-chart');
    var btn = document.getElementById('vol-tilt-toggle');
    if (!_last3DJson || !_last3DJson.tilt_profile) {
        if (btn) { btn.disabled = true; btn.classList.remove('active'); }
        return;
    }
    if (btn) btn.disabled = false;

    var traces = _build3DTiltTraces(_last3DJson.tilt_profile);
    if (!traces.length) {
        if (btn) { btn.disabled = true; btn.classList.remove('active'); }
        return;
    }

    _3dTiltTraceStart = chartDiv.data.length;
    Plotly.addTraces(chartDiv, traces);
    if (btn) btn.classList.add('active');
}

function toggle3DTilt() {
    var chartDiv = document.getElementById('vol-3d-chart');
    var btn = document.getElementById('vol-tilt-toggle');
    if (!chartDiv || !chartDiv.data || _3dTiltTraceStart < 0) return;

    var isActive = btn.classList.contains('active');
    var vis = isActive ? false : true;
    var indices = [];
    for (var i = _3dTiltTraceStart; i < chartDiv.data.length; i++) {
        indices.push(i);
    }
    if (indices.length) {
        Plotly.restyle(chartDiv, { visible: vis }, indices);
    }
    btn.classList.toggle('active');
}


// ── Hide scroll prompt on scroll ─────────────────────────────
var _scrollPromptHidden = false;
window.addEventListener('scroll', function() {
    if (!_scrollPromptHidden && window.scrollY > 50) { _scrollPromptHidden = true; var el = document.querySelector('.scroll-prompt'); if (el) el.style.opacity = '0'; }
});


// ═══════════════════════════════════════════════════════════════
// ── COMPOSITE ANALYSIS PANEL ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════

var _compositePanel = null;
var _compositeCountTimeout = null;

function _varOptionsHTML(idPrefix) {
    return '<select class="explorer-select" id="' + idPrefix + '-var">' +
        '<optgroup label="WCM Recentered (2 km)">' +
            '<option value="recentered_tangential_wind">Tangential Wind</option>' +
            '<option value="recentered_radial_wind">Radial Wind</option>' +
            '<option value="recentered_upward_air_velocity">Vertical Velocity</option>' +
            '<option value="recentered_reflectivity">Reflectivity</option>' +
            '<option value="recentered_wind_speed">Wind Speed</option>' +
            '<option value="recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
            '<option value="recentered_relative_vorticity">Relative Vorticity</option>' +
            '<option value="recentered_divergence">Divergence</option>' +
        '</optgroup>' +
        '<optgroup label="Tilt-Relative">' +
            '<option value="total_recentered_tangential_wind">Tangential Wind</option>' +
            '<option value="total_recentered_radial_wind">Radial Wind</option>' +
            '<option value="total_recentered_upward_air_velocity">Vertical Velocity</option>' +
            '<option value="total_recentered_reflectivity">Reflectivity</option>' +
            '<option value="total_recentered_wind_speed">Wind Speed</option>' +
            '<option value="total_recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
        '</optgroup>' +
        '<optgroup label="Original Swath" id="' + idPrefix + '-var-original">' +
            '<option value="swath_tangential_wind">Tangential Wind</option>' +
            '<option value="swath_radial_wind">Radial Wind</option>' +
            '<option value="swath_reflectivity">Reflectivity</option>' +
            '<option value="swath_wind_speed">Wind Speed</option>' +
            '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
        '</optgroup>' +
    '</select>';
}

// ── Original-domain variable definitions per data type ───────
var _originalVarDefs = {
    swath: [
        { value: 'swath_tangential_wind', label: 'Tangential Wind' },
        { value: 'swath_radial_wind', label: 'Radial Wind' },
        { value: 'swath_reflectivity', label: 'Reflectivity' },
        { value: 'swath_wind_speed', label: 'Wind Speed' },
        { value: 'swath_earth_relative_wind_speed', label: 'Earth-Rel. Wind Speed' }
    ],
    merge: [
        { value: 'merged_tangential_wind', label: 'Tangential Wind' },
        { value: 'merged_radial_wind', label: 'Radial Wind' },
        { value: 'merged_reflectivity', label: 'Reflectivity' },
        { value: 'merged_wind_speed', label: 'Wind Speed' },
        { value: 'merged_upward_air_velocity', label: 'Vertical Velocity' },
        { value: 'merged_relative_vorticity', label: 'Relative Vorticity' },
        { value: 'merged_divergence', label: 'Divergence' }
    ]
};

function _updateOriginalVarGroup(idPrefix, dataType) {
    var og = document.getElementById(idPrefix + '-var-original');
    if (!og) return;
    var defs = _originalVarDefs[dataType] || _originalVarDefs.swath;
    og.label = dataType === 'merge' ? 'Original Merged' : 'Original Swath';
    og.innerHTML = '';
    defs.forEach(function(d) {
        var opt = document.createElement('option');
        opt.value = d.value; opt.textContent = d.label;
        og.appendChild(opt);
    });
    // If currently selected value was in the old original group, reset to first recentered
    var sel = document.getElementById(idPrefix + '-var');
    if (sel && sel.selectedOptions.length && sel.selectedOptions[0].parentElement === og) {
        sel.value = 'recentered_tangential_wind';
    }
}

function _updateCompOverlayOriginalGroup(dataType) {
    var og = document.getElementById('comp-overlay-original');
    if (!og) return;
    var defs = _originalVarDefs[dataType] || _originalVarDefs.swath;
    og.label = dataType === 'merge' ? 'Original Merged' : 'Original Swath';
    og.innerHTML = '';
    defs.forEach(function(d) {
        var opt = document.createElement('option');
        opt.value = d.value; opt.textContent = d.label;
        og.appendChild(opt);
    });
    var sel = document.getElementById('comp-overlay');
    if (sel && sel.selectedOptions.length && sel.selectedOptions[0].parentElement === og) {
        sel.value = '';  // reset to None
    }
}

function _buildRangeRow(label, idBase, min, max, step, defaultMin, defaultMax, units) {
    return '<div class="comp-filter-row"><label>' + label + '</label>' +
        '<div class="comp-range-inputs">' +
            '<input type="number" id="' + idBase + '-min" value="' + defaultMin + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
            '<span class="comp-range-sep">to</span>' +
            '<input type="number" id="' + idBase + '-max" value="' + defaultMax + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
            '<span class="comp-range-unit">' + units + '</span>' +
        '</div></div>';
}

function initCompositePanel() {
    if (_compositePanel) return;
    var overlay = document.createElement('div');
    overlay.id = 'composite-panel';
    overlay.className = 'wizard-overlay';

    // ── Height level options ──
    var levelOpts = '';
    for (var h = 0.5; h <= 18; h += 0.5) {
        levelOpts += '<option value="' + h.toFixed(1) + '"' + (h === 2.0 ? ' selected' : '') + '>' + h.toFixed(1) + ' km</option>';
    }

    // ── Build filter rows helper (compact wizard style) ──
    function wfRow(label, idBase, min, max, step, defaultMin, defaultMax, units) {
        return '<div class="wizard-filter-row">' +
            '<span class="wf-label">' + label + '</span>' +
            '<input type="number" id="' + idBase + '-min" value="' + defaultMin + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
            '<span class="wf-sep">\u2013</span>' +
            '<input type="number" id="' + idBase + '-max" value="' + defaultMax + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
            '<span class="wf-unit">' + units + '</span>' +
        '</div>';
    }

    // ── Build one filter column ──
    function filterCol(prefix) {
        return wfRow('Intensity', prefix + '-int', 0, 200, 5, 0, 200, 'kt') +
            wfRow('\u0394V\u2098\u2090\u2093 (24h)', prefix + '-dv', -100, 85, 5, -100, 85, 'kt') +
            wfRow('Tilt', prefix + '-tilt', 0, 200, 5, 0, 200, 'km') +
            wfRow('Year', prefix + '-year', 1997, 2024, 1, 1997, 2024, '') +
            wfRow('Shear Mag', prefix + '-shrmag', 0, 100, 2, 0, 100, 'kt') +
            wfRow('Shear Dir', prefix + '-shrdir', 0, 360, 5, 0, 360, '\u00b0') +
            '<div class="wizard-filter-row">' +
                '<span class="wf-label">Min DTL</span>' +
                '<input type="number" id="' + prefix + '-dtl-min" value="0" min="0" max="9999" step="10">' +
                '<span class="wf-sep">km</span>' +
                '<select id="' + prefix + '-dtl-win" style="width:62px;font-size:11px;padding:2px 4px;border:1px solid rgba(255,255,255,0.15);border-radius:4px;background:rgba(255,255,255,0.06);color:#e2e8f0;">' +
                    '<option value="12h">0\u201312 h</option>' +
                    '<option value="24h" selected>0\u201324 h</option>' +
                '</select>' +
            '</div>';
    }

    overlay.innerHTML =
        '<div class="wizard-box">' +
            // ── Header ──
            '<div class="wizard-header">' +
                '<div class="wizard-header-left">' +
                    '<span class="wizard-header-logo">\uD83D\uDCCA</span>' +
                    '<span class="wizard-header-title">Composite Analysis</span>' +
                    '<span class="wizard-header-sub">Multi-case averaged fields</span>' +
                '</div>' +
                '<button class="wizard-close" onclick="toggleCompositePanel()">\u2715</button>' +
            '</div>' +

            // ── Step indicator ──
            '<div class="wizard-stepper">' +
                '<div class="wizard-step-item active" onclick="_wizardGoToStep(1)">' +
                    '<div class="wizard-step-circle">1</div>' +
                    '<span class="wizard-step-label">Select</span>' +
                '</div>' +
                '<div class="wizard-step-connector"></div>' +
                '<div class="wizard-step-item" onclick="_wizardGoToStep(2)">' +
                    '<div class="wizard-step-circle">2</div>' +
                    '<span class="wizard-step-label">Filter</span>' +
                '</div>' +
                '<div class="wizard-step-connector"></div>' +
                '<div class="wizard-step-item" onclick="_wizardGoToStep(3)">' +
                    '<div class="wizard-step-circle">3</div>' +
                    '<span class="wizard-step-label">Configure</span>' +
                '</div>' +
                '<div class="wizard-step-connector"></div>' +
                '<div class="wizard-step-item" onclick="_wizardGoToStep(4)">' +
                    '<div class="wizard-step-circle">4</div>' +
                    '<span class="wizard-step-label">Results</span>' +
                '</div>' +
            '</div>' +

            // ── Summary strip ──
            '<div class="wizard-summary" id="wizard-summary"></div>' +

            // ── Body (step content) ──
            '<div class="wizard-body">' +

                // ═══ STEP 1: Select ═══
                '<div class="wizard-step-content active" id="wizard-step-1">' +
                    '<div class="wizard-section-title">Analysis Mode</div>' +
                    '<div class="wizard-mode-cards">' +
                        '<div class="wizard-mode-card selected" id="wiz-mode-single" onclick="_wizardSetMode(\'single\')">' +
                            '<div class="wizard-mode-icon">\uD83C\uDF00</div>' +
                            '<div class="wizard-mode-title">Single Group</div>' +
                            '<div class="wizard-mode-desc">Composite one set of cases defined by filter criteria</div>' +
                        '</div>' +
                        '<div class="wizard-mode-card" id="wiz-mode-diff" onclick="_wizardSetMode(\'diff\')">' +
                            '<div class="wizard-mode-icon">\u0394</div>' +
                            '<div class="wizard-mode-title">Compare (A vs B)</div>' +
                            '<div class="wizard-mode-desc">Define two groups and compute difference composites</div>' +
                        '</div>' +
                    '</div>' +

                    '<div class="wizard-section-title">TDR Radar Outputs</div>' +
                    '<div class="wizard-output-grid">' +
                        '<div class="wizard-output-item checked" id="wiz-out-az" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-az" checked>' +
                            '<label for="wiz-chk-az">\u27F3 Azimuthal Mean<small>Radius\u2013height cross-section</small></label>' +
                        '</div>' +
                        '<div class="wizard-output-item" id="wiz-out-sq" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-sq">' +
                            '<label for="wiz-chk-sq">\u25D1 Shear Quadrants<small>4-panel shear-relative</small></label>' +
                        '</div>' +
                        '<div class="wizard-output-item" id="wiz-out-pv" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-pv">' +
                            '<label for="wiz-chk-pv">\uD83D\uDDFA Plan View<small>Horizontal map at height</small></label>' +
                        '</div>' +
                        '<div class="wizard-output-item" id="wiz-out-cfad" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-cfad">' +
                            '<label for="wiz-chk-cfad">\uD83D\uDCCA CFAD<small>Frequency by altitude diagram</small></label>' +
                        '</div>' +
                        '<div class="wizard-output-item" id="wiz-out-anom" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-anom">' +
                            '<label for="wiz-chk-anom">Z* Anomaly<small>Intensity-normalised R\u2095 structure</small></label>' +
                        '</div>' +
                        '<div class="wizard-output-item" id="wiz-out-vpsc" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-vpsc">' +
                            '<label for="wiz-chk-vpsc">\u2B24 VP Scatter<small>Ventilation vs. vortex favorability</small></label>' +
                        '</div>' +
                    '</div>' +

                    '<div class="wizard-section-title sat">\uD83D\uDEF0\uFE0F Satellite Outputs</div>' +
                    '<div class="wizard-output-grid">' +
                        '<div class="wizard-output-item sat-item" id="wiz-out-ir-pv" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-ir-pv">' +
                            '<label for="wiz-chk-ir-pv">\uD83C\uDF21 IR Plan View<small>RMW-relative brightness temp</small></label>' +
                        '</div>' +
                        '<div class="wizard-output-item sat-item" id="wiz-out-ir-az" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-ir-az">' +
                            '<label for="wiz-chk-ir-az">\u27F3 IR Azimuthal Mean<small>Radial Tb profile</small></label>' +
                        '</div>' +
                    '</div>' +

                    '<div class="wizard-section-title env">Environment Outputs</div>' +
                    '<div class="wizard-output-grid">' +
                        '<div class="wizard-output-item env-item" id="wiz-out-env-pv" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-env-pv">' +
                            '<label for="wiz-chk-env-pv">\uD83C\uDF0D ERA5 Plan View<small>Spatial environmental field</small></label>' +
                        '</div>' +
                        '<div class="wizard-output-item env-item" id="wiz-out-env-sc" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-env-sc">' +
                            '<label for="wiz-chk-env-sc">\uD83D\uDCCA Scalar Diagnostics<small>SHIPS-style parameters</small></label>' +
                        '</div>' +
                        '<div class="wizard-output-item env-item" id="wiz-out-env-th" onclick="_wizardToggleOutput(this, event)">' +
                            '<input type="checkbox" id="wiz-chk-env-th">' +
                            '<label for="wiz-chk-env-th">\uD83C\uDF21 Thermo Profiles<small>Skew-T & Hodograph</small></label>' +
                        '</div>' +
                    '</div>' +

                    '<div class="wizard-dtype-row">' +
                        '<label>Data Type</label>' +
                        '<select id="comp-dtype"><option value="swath">Swath</option><option value="merge">Merge</option></select>' +
                    '</div>' +
                '</div>' +

                // ═══ STEP 2: Filter ═══
                '<div class="wizard-step-content" id="wizard-step-2">' +
                    '<div class="wizard-filter-columns" id="wizard-filter-cols">' +
                        // Group A (always shown)
                        '<div class="wizard-group-col group-a">' +
                            '<div class="wizard-group-label" id="wiz-group-a-title">Filter Criteria</div>' +
                            filterCol('comp') +
                            '<div class="wizard-case-count">' +
                                '<div class="wcc-label">Matching cases</div>' +
                                '<div class="wcc-num" id="comp-count-num">\u2014</div>' +
                                '<div class="wcc-cap-note" id="comp-cap-note">Composites are limited to 1,000 cases per group. If your filters match more, only the first 1,000 will be used.</div>' +
                            '</div>' +
                        '</div>' +
                        // Group B (hidden unless diff mode)
                        '<div class="wizard-group-col group-b" id="wiz-group-b-col" style="display:none;">' +
                            '<div class="wizard-group-label">Group B</div>' +
                            filterCol('compb') +
                            '<div class="wizard-case-count">' +
                                '<div class="wcc-label">Group B cases</div>' +
                                '<div class="wcc-num" id="compb-count-num">\u2014</div>' +
                                '<div class="wcc-cap-note" id="compb-cap-note">Composites are limited to 1,000 cases per group. If your filters match more, only the first 1,000 will be used.</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

                // ═══ STEP 3: Configure ═══
                '<div class="wizard-step-content" id="wizard-step-3">' +
                    '<div class="wizard-config-cols">' +
                        // TDR config section
                        '<div class="wizard-config-section" id="wiz-cfg-tdr">' +
                            '<div class="wizard-config-section-title" onclick="_wizardToggleSection(this.parentElement)">' +
                                '<span class="wcs-icon">\uD83C\uDF00</span> TDR Settings' +
                                '<span class="wcs-toggle">\u25BC</span>' +
                            '</div>' +
                            '<div class="wizard-config-body">' +
                                '<div class="wizard-config-row"><label>Variable</label>' + _varOptionsHTML('comp') + '</div>' +
                                '<div class="wizard-config-row" id="wiz-cfg-level-row"><label>Height Level</label>' +
                                    '<select id="comp-level">' + levelOpts + '</select>' +
                                    '<div class="wiz-level-hint" id="wiz-level-hint" style="display:none;font-size:10px;color:#6b7280;margin-top:4px;">Not applicable — Azimuthal Mean and Shear Quadrants use all levels.</div>' +
                                '</div>' +
                                '<div class="wizard-config-row"><label>Coverage Threshold</label>' +
                                    '<div class="wizard-slider-row">' +
                                        '<input type="range" id="comp-coverage" min="0" max="100" step="5" value="50" oninput="document.getElementById(\'comp-cov-val\').textContent=this.value+\'%\'">' +
                                        '<span class="wizard-slider-val" id="comp-cov-val">50%</span>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row">' +
                                    '<div class="wizard-config-inline">' +
                                        '<input type="checkbox" id="comp-norm-rmw">' +
                                        '<label for="comp-norm-rmw" style="font-size:11px;color:#9ca3af;">Normalize by RMW (2-km)</label>' +
                                    '</div>' +
                                '</div>' +
                                '<div id="comp-rmw-opts" style="display:none;">' +
                                    '<div class="wizard-config-row"><label>Max Extent (R/RMW)</label>' +
                                        '<input type="number" id="comp-max-r-rmw" value="5.0" min="1" max="20" step="0.5" style="width:80px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                    '</div>' +
                                    '<div class="wizard-config-row"><label>Bin Width (R/RMW)</label>' +
                                        '<input type="number" id="comp-dr-rmw" value="0.1" min="0.05" max="1" step="0.05" style="width:80px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row">' +
                                    '<div class="wizard-config-inline">' +
                                        '<input type="checkbox" id="comp-shear-rel">' +
                                        '<label for="comp-shear-rel" style="font-size:11px;color:#9ca3af;">Shear-Relative Rotation</label>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row"><label>Contour Overlay</label>' +
                                    '<select id="comp-overlay">' +
                                        '<option value="">None</option>' +
                                        '<optgroup label="WCM Recentered (2 km)">' +
                                            '<option value="recentered_tangential_wind">Tangential Wind</option>' +
                                            '<option value="recentered_radial_wind">Radial Wind</option>' +
                                            '<option value="recentered_upward_air_velocity">Vertical Velocity</option>' +
                                            '<option value="recentered_reflectivity">Reflectivity</option>' +
                                            '<option value="recentered_wind_speed">Wind Speed</option>' +
                                            '<option value="recentered_relative_vorticity">Relative Vorticity</option>' +
                                            '<option value="recentered_divergence">Divergence</option>' +
                                        '</optgroup>' +
                                        '<optgroup label="Tilt-Relative">' +
                                            '<option value="total_recentered_tangential_wind">Tangential Wind</option>' +
                                            '<option value="total_recentered_radial_wind">Radial Wind</option>' +
                                            '<option value="total_recentered_upward_air_velocity">Vertical Velocity</option>' +
                                            '<option value="total_recentered_reflectivity">Reflectivity</option>' +
                                            '<option value="total_recentered_wind_speed">Wind Speed</option>' +
                                        '</optgroup>' +
                                        '<optgroup label="Original Swath" id="comp-overlay-original">' +
                                            '<option value="swath_tangential_wind">Tangential Wind</option>' +
                                            '<option value="swath_radial_wind">Radial Wind</option>' +
                                            '<option value="swath_reflectivity">Reflectivity</option>' +
                                            '<option value="swath_wind_speed">Wind Speed</option>' +
                                        '</optgroup>' +
                                    '</select>' +
                                    '<div style="display:flex;align-items:center;gap:5px;margin-top:4px;">' +
                                        '<label style="font-size:9px;white-space:nowrap;margin:0;color:#9ca3af;">Interval:</label>' +
                                        '<input type="number" id="comp-contour-int" value="" placeholder="auto" style="width:55px;padding:2px 4px;font-size:10px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);">' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row"><label>Colormap</label>' +
                                    '<select id="comp-cmap" onchange="applyCompCmap()">' +
                                        '<option value="">Default (from variable)</option>' +
                                        '<optgroup label="Sequential"><option value="Viridis">Viridis</option><option value="Inferno">Inferno</option><option value="Magma">Magma</option><option value="Plasma">Plasma</option><option value="Cividis">Cividis</option><option value="Hot">Hot</option><option value="YlOrRd">YlOrRd</option><option value="YlGnBu">YlGnBu</option><option value="Blues">Blues</option><option value="Reds">Reds</option><option value="Greys">Greys</option></optgroup>' +
                                        '<optgroup label="Diverging"><option value="RdBu">RdBu (red-blue)</option><option value=\'[[0,"rgb(5,10,172)"],[0.5,"rgb(255,255,255)"],[1,"rgb(178,10,28)"]]\'>BuWtRd (blue-white-red)</option><option value="Picnic">Picnic</option><option value="Portland">Portland</option></optgroup>' +
                                        '<optgroup label="Other"><option value="Jet">Jet</option><option value="Rainbow">Rainbow</option><option value="Electric">Electric</option><option value="Earth">Earth</option><option value="Blackbody">Blackbody</option></optgroup>' +
                                    '</select>' +
                                '</div>' +
                                '<div class="wizard-config-row"><label>Color Range</label>' +
                                    '<div class="wizard-color-range">' +
                                        '<input type="number" id="comp-vmin" placeholder="min" step="any" onchange="applyCompColorRange()">' +
                                        '<span class="wcr-sep">to</span>' +
                                        '<input type="number" id="comp-vmax" placeholder="max" step="any" onchange="applyCompColorRange()">' +
                                        '<button onclick="resetCompColorRange()" title="Reset">\u21BA</button>' +
                                    '</div>' +
                                '</div>' +
                                // CFAD-specific options (visible only when CFAD is checked)
                                '<div id="wiz-cfg-cfad-opts" style="display:none;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;margin-top:4px;">' +
                                    '<div style="font-size:10px;font-weight:600;color:#22d3ee;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">\uD83D\uDCCA CFAD Options</div>' +

                                    // Bin width
                                    '<div class="wizard-config-row"><label>Bin Width</label>' +
                                        '<input type="number" id="cfad-bin-width" value="" placeholder="auto" min="0.1" step="any" style="width:80px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                        '<span style="font-size:9px;color:#6b7280;margin-left:4px;">(leave blank for auto)</span>' +
                                    '</div>' +

                                    // Number of bins
                                    '<div class="wizard-config-row"><label>Number of Bins</label>' +
                                        '<input type="number" id="cfad-n-bins" value="20" min="5" max="200" step="1" style="width:80px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                        '<span style="font-size:9px;color:#6b7280;margin-left:4px;">(used when bin width is blank)</span>' +
                                    '</div>' +

                                    // Bin range (min/max)
                                    '<div class="wizard-config-row"><label>Bin Range</label>' +
                                        '<div style="display:flex;align-items:center;gap:6px;">' +
                                            '<input type="number" id="cfad-bin-min" value="" placeholder="auto" step="any" style="width:72px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                            '<span style="font-size:10px;color:#6b7280;">to</span>' +
                                            '<input type="number" id="cfad-bin-max" value="" placeholder="auto" step="any" style="width:72px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                            '<span style="font-size:9px;color:#6b7280;margin-left:4px;">(blank = auto from variable)</span>' +
                                        '</div>' +
                                    '</div>' +

                                    // Normalisation
                                    '<div class="wizard-config-row"><label>Normalisation</label>' +
                                        '<select id="cfad-normalise" style="font-size:11px;">' +
                                            '<option value="height">% at Each Height (standard)</option>' +
                                            '<option value="total">% of Total Pixels</option>' +
                                            '<option value="raw">Raw Counts</option>' +
                                        '</select>' +
                                    '</div>' +

                                    // Radial domain (min + max)
                                    '<div class="wizard-config-row"><label>Radial Domain</label>' +
                                        '<div style="display:flex;align-items:center;gap:6px;">' +
                                            '<input type="number" id="cfad-min-radius" value="0" min="0" max="500" step="any" style="width:65px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                            '<span style="font-size:10px;color:#6b7280;">to</span>' +
                                            '<input type="number" id="cfad-max-radius" value="200" min="0.1" max="500" step="any" style="width:65px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                            '<span id="cfad-radius-unit" style="font-size:10px;color:#6b7280;">km</span>' +
                                        '</div>' +
                                    '</div>' +

                                    // RMW toggle
                                    '<div class="wizard-config-row">' +
                                        '<div class="wizard-config-inline">' +
                                            '<input type="checkbox" id="cfad-use-rmw" onchange="_cfadUpdateRadiusUnit()">' +
                                            '<label for="cfad-use-rmw" style="font-size:11px;color:#9ca3af;">Normalise by RMW (radii become R/RMW)</label>' +
                                        '</div>' +
                                    '</div>' +

                                    // Shear-relative quadrant selector (with MULTI button)
                                    '<div class="wizard-config-row"><label>Quadrant Filter</label>' +
                                        '<div id="cfad-quad-btns" style="display:flex;gap:4px;flex-wrap:wrap;">' +
                                            '<button type="button" class="cfad-quad-btn active" data-quad="ALL" onclick="_cfadToggleQuad(this)" style="padding:4px 10px;font-size:10px;font-weight:600;border:1px solid rgba(34,211,238,0.3);border-radius:4px;background:rgba(34,211,238,0.15);color:#22d3ee;cursor:pointer;font-family:\'JetBrains Mono\',monospace;">All</button>' +
                                            '<button type="button" class="cfad-quad-btn" data-quad="DSL" onclick="_cfadToggleQuad(this)" style="padding:4px 10px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:rgba(255,255,255,0.03);color:#9ca3af;cursor:pointer;font-family:\'JetBrains Mono\',monospace;">DSL</button>' +
                                            '<button type="button" class="cfad-quad-btn" data-quad="DSR" onclick="_cfadToggleQuad(this)" style="padding:4px 10px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:rgba(255,255,255,0.03);color:#9ca3af;cursor:pointer;font-family:\'JetBrains Mono\',monospace;">DSR</button>' +
                                            '<button type="button" class="cfad-quad-btn" data-quad="USL" onclick="_cfadToggleQuad(this)" style="padding:4px 10px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:rgba(255,255,255,0.03);color:#9ca3af;cursor:pointer;font-family:\'JetBrains Mono\',monospace;">USL</button>' +
                                            '<button type="button" class="cfad-quad-btn" data-quad="USR" onclick="_cfadToggleQuad(this)" style="padding:4px 10px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:rgba(255,255,255,0.03);color:#9ca3af;cursor:pointer;font-family:\'JetBrains Mono\',monospace;">USR</button>' +
                                            '<button type="button" class="cfad-quad-btn" data-quad="MULTI" onclick="_cfadToggleQuad(this)" style="padding:4px 10px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:rgba(255,255,255,0.03);color:#9ca3af;cursor:pointer;font-family:\'JetBrains Mono\',monospace;">Multi</button>' +
                                        '</div>' +
                                    '</div>' +

                                    // Log-scale toggle
                                    '<div class="wizard-config-row">' +
                                        '<div class="wizard-config-inline">' +
                                            '<input type="checkbox" id="cfad-log-scale" checked>' +
                                            '<label for="cfad-log-scale" style="font-size:11px;color:#9ca3af;">Log-scale colorbar</label>' +
                                        '</div>' +
                                    '</div>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +

                        // Satellite config section (shown when IR outputs checked)
                        '<div class="wizard-config-section" id="wiz-cfg-sat" style="display:none;">' +
                            '<div class="wizard-config-section-title" onclick="_wizardToggleSection(this.parentElement)">' +
                                '<span class="wcs-icon">\uD83D\uDEF0\uFE0F</span> Satellite Settings' +
                                '<span class="wcs-toggle">\u25BC</span>' +
                            '</div>' +
                            '<div class="wizard-config-body">' +
                                '<div class="wizard-config-row"><label>Coverage Threshold</label>' +
                                    '<div class="wizard-slider-row">' +
                                        '<input type="range" id="ir-coverage" min="0" max="100" step="5" value="25" oninput="document.getElementById(\'ir-cov-val\').textContent=this.value+\'%\'">' +
                                        '<span class="wizard-slider-val" id="ir-cov-val">25%</span>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row">' +
                                    '<div class="wizard-config-inline">' +
                                        '<input type="checkbox" id="ir-norm-rmw" checked onchange="var opts=document.getElementById(\'ir-rmw-opts\');if(opts)opts.style.display=this.checked?\'block\':\'none\';">' +
                                        '<label for="ir-norm-rmw" style="font-size:11px;color:#9ca3af;">Normalize by RMW (2-km)</label>' +
                                    '</div>' +
                                '</div>' +
                                '<div id="ir-rmw-opts">' +
                                    '<div class="wizard-config-row"><label>Max Extent (R/RMW)</label>' +
                                        '<input type="number" id="ir-max-r-rmw" value="5.0" min="1" max="20" step="0.5" style="width:80px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                    '</div>' +
                                    '<div class="wizard-config-row"><label>Bin Width (R/RMW)</label>' +
                                        '<input type="number" id="ir-dr-rmw" value="0.1" min="0.05" max="1" step="0.05" style="width:80px;padding:3px 6px;font-size:11px;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:var(--navy);color:var(--text);font-family:\'JetBrains Mono\',monospace;">' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row">' +
                                    '<div class="wizard-config-inline">' +
                                        '<input type="checkbox" id="ir-shear-rel">' +
                                        '<label for="ir-shear-rel" style="font-size:11px;color:#9ca3af;">Shear-Relative Rotation</label>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row">' +
                                    '<div class="wizard-config-inline">' +
                                        '<input type="checkbox" id="ir-tilt-overlay" checked>' +
                                        '<label for="ir-tilt-overlay" style="font-size:11px;color:#9ca3af;">Overlay Mean Vortex Tilt</label>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row"><label>Max Domain Radius</label>' +
                                    '<div class="wizard-slider-row">' +
                                        '<input type="range" id="ir-max-radius" min="200" max="1000" step="50" value="500" oninput="document.getElementById(\'ir-max-radius-val\').textContent=this.value+\' km\'">' +
                                        '<span class="wizard-slider-val" id="ir-max-radius-val">500 km</span>' +
                                    '</div>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +

                        // Environment config section
                        '<div class="wizard-config-section" id="wiz-cfg-env">' +
                            '<div class="wizard-config-section-title" onclick="_wizardToggleSection(this.parentElement)">' +
                                '<span class="wcs-icon">\uD83C\uDF0D</span> Environment Settings' +
                                '<span class="wcs-toggle">\u25BC</span>' +
                            '</div>' +
                            '<div class="wizard-config-body">' +
                                '<div class="wizard-config-row"><label>ERA5 Field</label>' +
                                    '<select id="comp-env-field">' +
                                        '<option value="shear_mag">Deep-Layer Shear (200\u2013850 hPa)</option>' +
                                        '<option value="rh_mid">Mid-Level RH (500\u2013700 hPa)</option>' +
                                        '<option value="div200">200 hPa Divergence</option>' +
                                        '<option value="sst">Sea Surface Temperature</option>' +
                                        '<option value="entropy_def">Entropy Deficit (\u03c7\u2098)</option>' +
                                    '</select>' +
                                '</div>' +
                                '<div class="wizard-config-row">' +
                                    '<div class="wizard-config-inline">' +
                                        '<input type="checkbox" id="comp-env-vectors">' +
                                        '<label for="comp-env-vectors" style="font-size:11px;color:#9ca3af;">Include Shear Vectors</label>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row">' +
                                    '<div class="wizard-config-inline">' +
                                        '<input type="checkbox" id="comp-env-shear-rel">' +
                                        '<label for="comp-env-shear-rel" style="font-size:11px;color:#9ca3af;">Shear-Relative Rotation</label>' +
                                    '</div>' +
                                '</div>' +
                                '<div class="wizard-config-row"><label>Crop Radius</label>' +
                                    '<div class="wizard-slider-row">' +
                                        '<input type="range" id="comp-env-radius" min="100" max="1000" step="50" value="500" oninput="document.getElementById(\'comp-env-radius-val\').textContent=this.value+\' km\'">' +
                                        '<span class="wizard-slider-val" id="comp-env-radius-val">500 km</span>' +
                                    '</div>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

                // ═══ STEP 4: Results ═══
                '<div class="wizard-step-content" id="wizard-step-4">' +
                    '<div class="wizard-generate-bar">' +
                        '<button class="wizard-generate-btn" id="wiz-generate-btn" onclick="_wizardGenerateSelected()">\u25B6 Generate Selected</button>' +
                        '<span class="wizard-generate-summary" id="wiz-generate-summary"></span>' +
                    '</div>' +
                    // ── Inline shading toolbar (mirrors Step 3 controls for live adjustment) ──
                    '<div class="comp-shading-toolbar" id="comp-shading-toolbar" style="display:none !important;">' +
                        '<div class="cst-row">' +
                            '<label class="cst-label">Colormap</label>' +
                            '<select id="comp-cmap-inline" class="cst-select" onchange="_syncCompCmapFromInline()">' +
                                '<option value="">Default</option>' +
                                '<optgroup label="Sequential"><option value="Viridis">Viridis</option><option value="Inferno">Inferno</option><option value="Magma">Magma</option><option value="Plasma">Plasma</option><option value="Cividis">Cividis</option><option value="Hot">Hot</option><option value="YlOrRd">YlOrRd</option><option value="YlGnBu">YlGnBu</option><option value="Blues">Blues</option><option value="Reds">Reds</option><option value="Greys">Greys</option></optgroup>' +
                                '<optgroup label="Diverging"><option value="RdBu">RdBu</option><option value=\'[[0,"rgb(5,10,172)"],[0.5,"rgb(255,255,255)"],[1,"rgb(178,10,28)"]]\'>BuWtRd</option><option value="Picnic">Picnic</option><option value="Portland">Portland</option></optgroup>' +
                                '<optgroup label="Other"><option value="Jet">Jet</option><option value="Rainbow">Rainbow</option><option value="Electric">Electric</option></optgroup>' +
                            '</select>' +
                            '<span class="cst-sep"></span>' +
                            '<label class="cst-label">Range</label>' +
                            '<input type="number" id="comp-vmin-inline" class="cst-input" placeholder="min" step="any" onchange="_syncCompRangeFromInline()">' +
                            '<span class="cst-to">to</span>' +
                            '<input type="number" id="comp-vmax-inline" class="cst-input" placeholder="max" step="any" onchange="_syncCompRangeFromInline()">' +
                            '<button class="cst-reset" onclick="_resetCompShadingInline()" title="Reset to default">\u21BA</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="wizard-results-area" id="wizard-results-area">' +
                        '<div class="wizard-result-placeholder" id="wiz-result-placeholder">' +
                            '<div class="wrp-icon">\uD83C\uDF00</div>' +
                            '<div class="wrp-msg">Select outputs in Step 1, set filters in Step 2, then click <strong>Generate Selected</strong> to compute composites.</div>' +
                        '</div>' +
                        // TDR result containers
                        '<div id="comp-status" style="display:none;"></div>' +
                        '<div id="comp-result-az" style="display:none;"></div>' +
                        '<div id="comp-result-sq" style="display:none;"></div>' +
                        '<div id="comp-result-pv" style="display:none;"></div>' +
                        '<div id="comp-result-ir-pv" style="display:none;"></div>' +
                        '<div id="comp-result-ir-az" style="display:none;"></div>' +
                        '<div id="comp-result-cfad" style="display:none;"></div>' +
                        '<div id="comp-result-anom" style="display:none;"></div>' +
                        '<div id="comp-result-vpsc" style="display:none;"></div>' +
                        // Environment result containers
                        '<div id="comp-env-status" style="display:none;"></div>' +
                        '<div id="comp-env-scalars" style="display:none;"></div>' +
                        '<div id="comp-env-plan-view" style="display:none;"></div>' +
                        '<div class="comp-env-row" style="display:none;" id="comp-env-thermo-row">' +
                            '<div id="comp-env-skewt" style="flex:1;min-width:0;"></div>' +
                            '<div id="comp-env-hodo" style="flex:1;min-width:0;"></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

            '</div>' + // end wizard-body

            // ── Bottom navigation ──
            '<div class="wizard-nav">' +
                '<button class="wizard-nav-btn secondary" id="wiz-back-btn" onclick="_wizardBack()" style="visibility:hidden;">\u2190 Back</button>' +
                '<div></div>' +
                '<button class="wizard-nav-btn primary" id="wiz-next-btn" onclick="_wizardNext()">Next \u2192</button>' +
            '</div>' +

        '</div>'; // end wizard-box

    document.body.appendChild(overlay);
    _compositePanel = overlay;

    // ── Wire up live case counts ──
    _wizardWireFilters();

    // ── Wire up data type change ──
    var dtypeSelect = document.getElementById('comp-dtype');
    if (dtypeSelect) {
        dtypeSelect.addEventListener('change', function() {
            var varType = this.value === 'merge' ? 'merge' : 'swath';
            _updateOriginalVarGroup('comp', varType);
            _updateCompOverlayOriginalGroup(varType);
            _debouncedCompositeCount();
            if (_wizardMode === 'diff') _debouncedGroupBCount();
        });
    }

    // ── Wire up RMW normalize toggle ──
    var normCheck = document.getElementById('comp-norm-rmw');
    if (normCheck) {
        normCheck.addEventListener('change', function() {
            var opts = document.getElementById('comp-rmw-opts');
            if (opts) opts.style.display = this.checked ? 'block' : 'none';
        });
    }

    // ── Wire up output checkboxes to update config visibility ──
    overlay.querySelectorAll('.wizard-output-item input[type="checkbox"]').forEach(function(cb) {
        cb.addEventListener('change', function() { _wizardUpdateConfigVisibility(); _wizardUpdateSummary(); });
    });
}

// ═══════════════════════════════════════════════════════════════
// ── WIZARD STATE & NAVIGATION ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════

var _wizardCurrentStep = 1;
var _wizardMode = 'single'; // 'single' or 'diff'

function _wizardGoToStep(n) {
    if (n < 1 || n > 4) return;
    _wizardCurrentStep = n;

    // Update step content visibility
    for (var i = 1; i <= 4; i++) {
        var content = document.getElementById('wizard-step-' + i);
        if (content) { content.classList.toggle('active', i === n); }
    }

    // Update step indicator
    var items = document.querySelectorAll('.wizard-step-item');
    var connectors = document.querySelectorAll('.wizard-step-connector');
    items.forEach(function(item, idx) {
        var stepNum = idx + 1;
        item.classList.remove('active', 'completed');
        if (stepNum === n) item.classList.add('active');
        else if (stepNum < n) item.classList.add('completed');
        // Update circle content for completed steps
        var circle = item.querySelector('.wizard-step-circle');
        if (circle) circle.innerHTML = stepNum < n ? '\u2713' : String(stepNum);
    });
    connectors.forEach(function(conn, idx) {
        conn.classList.toggle('completed', idx < n - 1);
    });

    // Update nav buttons
    var backBtn = document.getElementById('wiz-back-btn');
    var nextBtn = document.getElementById('wiz-next-btn');
    if (backBtn) backBtn.style.visibility = n === 1 ? 'hidden' : 'visible';
    if (nextBtn) {
        if (n === 4) {
            nextBtn.style.display = 'none';
        } else {
            nextBtn.style.display = '';
            nextBtn.textContent = 'Next \u2192';
        }
    }

    // Update summary
    _wizardUpdateSummary();

    // When entering step 2, trigger count update
    if (n === 2) {
        updateCompositeCount();
        if (_wizardMode === 'diff') _updateGroupBCount();
    }

    // When entering step 3, update config section visibility
    if (n === 3) _wizardUpdateConfigVisibility();

    // When entering step 4, update generate summary
    if (n === 4) _wizardUpdateGenerateSummary();
}

function _wizardNext() { _wizardGoToStep(_wizardCurrentStep + 1); }
function _wizardBack() { _wizardGoToStep(_wizardCurrentStep - 1); }

function _wizardSetMode(mode) {
    _wizardMode = mode;
    var singleCard = document.getElementById('wiz-mode-single');
    var diffCard = document.getElementById('wiz-mode-diff');
    var groupBCol = document.getElementById('wiz-group-b-col');
    var groupATitle = document.getElementById('wiz-group-a-title');

    if (mode === 'diff') {
        singleCard.classList.remove('selected');
        diffCard.classList.add('selected', 'diff');
        if (groupBCol) groupBCol.style.display = '';
        if (groupATitle) groupATitle.textContent = 'Group A';
    } else {
        singleCard.classList.add('selected');
        diffCard.classList.remove('selected', 'diff');
        if (groupBCol) groupBCol.style.display = 'none';
        if (groupATitle) groupATitle.textContent = 'Filter Criteria';
    }
    _wizardUpdateSummary();
}

function _wizardToggleOutput(el, ev) {
    var cb = el.querySelector('input[type="checkbox"]');
    // If click originated from the checkbox or its label, the browser already
    // toggled the checked state — don't toggle it again.
    if (ev && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'LABEL' || ev.target.tagName === 'SMALL')) {
        // Browser handled the toggle; just sync the visual state.
    } else {
        if (cb) { cb.checked = !cb.checked; }
    }
    el.classList.toggle('checked', cb && cb.checked);
    _wizardUpdateConfigVisibility();
    _wizardUpdateSummary();
}

function _wizardToggleSection(section) {
    section.classList.toggle('collapsed');
}

function _wizardUpdateConfigVisibility() {
    var chkAz = document.getElementById('wiz-chk-az').checked;
    var chkSq = document.getElementById('wiz-chk-sq').checked;
    var chkPv = document.getElementById('wiz-chk-pv').checked;
    var chkCfad = document.getElementById('wiz-chk-cfad') && document.getElementById('wiz-chk-cfad').checked;
    var chkAnom = document.getElementById('wiz-chk-anom') && document.getElementById('wiz-chk-anom').checked;
    var chkVpsc = document.getElementById('wiz-chk-vpsc') && document.getElementById('wiz-chk-vpsc').checked;
    var anyTDR = chkAz || chkSq || chkPv || chkCfad || chkAnom || chkVpsc;
    var envPV  = document.getElementById('wiz-chk-env-pv').checked;
    var envSC  = document.getElementById('wiz-chk-env-sc').checked;
    var envTH  = document.getElementById('wiz-chk-env-th').checked;
    var anyEnv = envPV || envSC || envTH;
    var chkIrPv = document.getElementById('wiz-chk-ir-pv') && document.getElementById('wiz-chk-ir-pv').checked;
    var chkIrAz = document.getElementById('wiz-chk-ir-az') && document.getElementById('wiz-chk-ir-az').checked;
    var anySat = chkIrPv || chkIrAz;
    var tdrCfg = document.getElementById('wiz-cfg-tdr');
    var satCfg = document.getElementById('wiz-cfg-sat');
    var envCfg = document.getElementById('wiz-cfg-env');
    if (tdrCfg) tdrCfg.style.display = anyTDR ? '' : 'none';
    if (satCfg) satCfg.style.display = anySat ? '' : 'none';
    if (envCfg) envCfg.style.display = anyEnv ? '' : 'none';
    // If nothing selected, show all sections
    if (!anyTDR && !anySat && !anyEnv) {
        if (tdrCfg) tdrCfg.style.display = '';
        if (satCfg) satCfg.style.display = '';
        if (envCfg) envCfg.style.display = '';
    }

    // Height Level is only relevant for Plan View — hide it when only
    // Azimuthal Mean and/or Shear Quadrants are selected.
    var levelRow = document.getElementById('wiz-cfg-level-row');
    var levelHint = document.getElementById('wiz-level-hint');
    if (levelRow) {
        if (chkPv) {
            // Plan View selected — show the height selector normally
            levelRow.style.display = '';
            var lvlSel = document.getElementById('comp-level');
            if (lvlSel) lvlSel.disabled = false;
            if (levelHint) levelHint.style.display = 'none';
        } else if (chkAz || chkSq) {
            // Only radius-height outputs — show row but indicate not applicable
            levelRow.style.display = '';
            var lvlSel = document.getElementById('comp-level');
            if (lvlSel) lvlSel.disabled = true;
            if (levelHint) levelHint.style.display = '';
        }
    }

    // CFAD options — show only when CFAD checkbox is checked
    var cfadOpts = document.getElementById('wiz-cfg-cfad-opts');
    if (cfadOpts) cfadOpts.style.display = chkCfad ? '' : 'none';

    // When Thermo Profiles is selected, auto-select Scalar Diagnostics too,
    // since shear/mid-level RH/SST etc. are needed for vertical profile context.
    if (envTH) {
        var scCb = document.getElementById('wiz-chk-env-sc');
        var scItem = document.getElementById('wiz-out-env-sc');
        if (scCb && !scCb.checked) {
            scCb.checked = true;
            if (scItem) scItem.classList.add('checked');
        }
    }

    // Hide ERA5 Plan View config options (field, vectors, rotation, crop radius)
    // when only Thermo Profiles / Scalar Diagnostics are selected (no ERA5 Plan View).
    if (envCfg) {
        var envBodyRows = envCfg.querySelectorAll('.wizard-config-body .wizard-config-row');
        var showPlanViewOpts = envPV;
        envBodyRows.forEach(function(row) {
            // The ERA5 Field, Shear Vectors, Shear-Relative, and Crop Radius rows
            // are only relevant to the ERA5 Plan View output.
            var hasField = row.querySelector('#comp-env-field');
            var hasVectors = row.querySelector('#comp-env-vectors');
            var hasShearRel = row.querySelector('#comp-env-shear-rel');
            var hasRadius = row.querySelector('#comp-env-radius');
            if (hasField || hasVectors || hasShearRel || hasRadius) {
                row.style.display = showPlanViewOpts ? '' : 'none';
            }
        });
    }
}

function _wizardUpdateSummary() {
    var el = document.getElementById('wizard-summary');
    if (!el) return;
    var parts = [];

    // Mode
    parts.push('<span class="ws-tag' + (_wizardMode === 'diff' ? ' amber' : ' cyan') + '">' +
        (_wizardMode === 'diff' ? '\u0394 Diff Mode' : 'Single Group') + '</span>');

    // Outputs
    var outputs = [];
    if (document.getElementById('wiz-chk-az') && document.getElementById('wiz-chk-az').checked) outputs.push('Az Mean');
    if (document.getElementById('wiz-chk-sq') && document.getElementById('wiz-chk-sq').checked) outputs.push('Quad');
    if (document.getElementById('wiz-chk-pv') && document.getElementById('wiz-chk-pv').checked) outputs.push('Plan');
    if (document.getElementById('wiz-chk-cfad') && document.getElementById('wiz-chk-cfad').checked) outputs.push('CFAD');
    if (document.getElementById('wiz-chk-env-pv') && document.getElementById('wiz-chk-env-pv').checked) outputs.push('Env PV');
    if (document.getElementById('wiz-chk-env-sc') && document.getElementById('wiz-chk-env-sc').checked) outputs.push('Env Scalars');
    if (document.getElementById('wiz-chk-env-th') && document.getElementById('wiz-chk-env-th').checked) outputs.push('Env Thermo');
    if (outputs.length > 0) {
        parts.push('<span class="ws-tag blue">' + outputs.join(', ') + '</span>');
    }

    // Case counts (if step 2+ and counts are available)
    var countA = document.getElementById('comp-count-num');
    if (countA && countA.textContent !== '\u2014' && countA.textContent !== '\u2026') {
        if (_wizardMode === 'diff') {
            var countB = document.getElementById('compb-count-num');
            var bText = countB ? countB.textContent : '?';
            parts.push('<span class="ws-tag green">N=' + countA.textContent + ' vs ' + bText + '</span>');
        } else {
            parts.push('<span class="ws-tag green">N=' + countA.textContent + '</span>');
        }
    }

    // Data type
    var dtype = document.getElementById('comp-dtype');
    if (dtype) parts.push('<span class="ws-tag">' + dtype.value + '</span>');

    el.innerHTML = parts.join(' ');
}

// Update the case-count badge from the actual composite result's n_cases.
// This is the authoritative count from the backend after filtering + processing.
function _updateBadgeFromResult(nCases) {
    if (nCases == null) return;
    var el = document.getElementById('comp-count-num');
    if (el) {
        el.textContent = nCases;
        _wizardUpdateSummary();
    }
}

function _wizardUpdateGenerateSummary() {
    var el = document.getElementById('wiz-generate-summary');
    if (!el) return;
    var outputs = [];
    if (document.getElementById('wiz-chk-az').checked) outputs.push('Azimuthal Mean');
    if (document.getElementById('wiz-chk-sq').checked) outputs.push('Shear Quadrants');
    if (document.getElementById('wiz-chk-pv').checked) outputs.push('Plan View');
    if (document.getElementById('wiz-chk-cfad') && document.getElementById('wiz-chk-cfad').checked) outputs.push('CFAD');
    if (document.getElementById('wiz-chk-env-pv').checked) outputs.push('ERA5 Plan View');
    if (document.getElementById('wiz-chk-env-sc').checked) outputs.push('Scalar Diagnostics');
    if (document.getElementById('wiz-chk-env-th').checked) outputs.push('Thermo Profiles');
    if (outputs.length === 0) {
        el.textContent = 'No outputs selected. Go back to Step 1 to choose outputs.';
    } else {
        el.textContent = 'Will generate: ' + outputs.join(', ') +
            (_wizardMode === 'diff' ? ' (with A\u2212B differences)' : '');
    }
}

function _wizardWireFilters() {
    // Group A
    var groupAInputs = document.querySelectorAll('.wizard-group-col.group-a input[type="number"]');
    groupAInputs.forEach(function(inp) {
        inp.addEventListener('change', _debouncedCompositeCount);
        inp.addEventListener('input', _debouncedCompositeCount);
    });
    // Group A selects (e.g. DTL window dropdown)
    var groupASelects = document.querySelectorAll('.wizard-group-col.group-a select');
    groupASelects.forEach(function(sel) {
        sel.addEventListener('change', _debouncedCompositeCount);
    });
    // Group B
    var groupBInputs = document.querySelectorAll('.wizard-group-col.group-b input[type="number"]');
    groupBInputs.forEach(function(inp) {
        inp.addEventListener('change', _debouncedGroupBCount);
        inp.addEventListener('input', _debouncedGroupBCount);
    });
    // Group B selects
    var groupBSelects = document.querySelectorAll('.wizard-group-col.group-b select');
    groupBSelects.forEach(function(sel) {
        sel.addEventListener('change', _debouncedGroupBCount);
    });
}

// ── Master generate function ──
function _wizardGenerateSelected() {
    var placeholder = document.getElementById('wiz-result-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    // Belt-and-suspenders: refresh the case count with current filters
    // right before generating, so the badge is up-to-date
    if (_wizardMode !== 'diff') {
        updateCompositeCount();
    }

    var isDiff = _wizardMode === 'diff';

    if (isDiff) {
        // In diff mode, serialize requests to avoid server overload
        // (each diff request does 2 composite fetches: Group A then B)
        var diffQueue = [];
        if (document.getElementById('wiz-chk-az').checked) {
            diffQueue.push({ fn: generateCompDiffAzMean, name: 'AzMean' });
        }
        if (document.getElementById('wiz-chk-sq').checked) {
            diffQueue.push({ fn: generateCompDiffQuadMean, name: 'QuadMean' });
        }
        if (document.getElementById('wiz-chk-pv').checked) {
            diffQueue.push({ fn: generateCompDiffPlanView, name: 'PlanView' });
        }
        if (document.getElementById('wiz-chk-cfad') && document.getElementById('wiz-chk-cfad').checked) {
            diffQueue.push({ fn: generateCompDiffCFAD, name: 'CFAD' });
        }
        if (document.getElementById('wiz-chk-anom') && document.getElementById('wiz-chk-anom').checked) {
            diffQueue.push({ fn: generateCompDiffAnomaly, name: 'Anomaly' });
        }
        // IR diff outputs (satellite)
        if (document.getElementById('wiz-chk-ir-pv') && document.getElementById('wiz-chk-ir-pv').checked) {
            diffQueue.push({ fn: generateCompDiffIRPlanView, name: 'IR PlanView' });
        }
        if (document.getElementById('wiz-chk-ir-az') && document.getElementById('wiz-chk-ir-az').checked) {
            diffQueue.push({ fn: generateCompDiffIRAzMean, name: 'IR AzMean' });
        }
        // Run diff functions sequentially via promise chain.
        // Each step catches its own error so the chain always continues.
        var chain = Promise.resolve();
        diffQueue.forEach(function(item) {
            chain = chain.then(function() {
                console.log('[Diff] Starting ' + item.name + '…');
                return item.fn();
            }).then(function() {
                console.log('[Diff] ' + item.name + ' complete.');
            }).catch(function(err) {
                console.warn('[Diff] ' + item.name + ' failed:', err);
                // Resolve so the chain continues to the next output
            });
        });
        // After all diffs, run non-diff outputs (VP scatter, env)
        chain.then(function() {
            if (document.getElementById('wiz-chk-vpsc') && document.getElementById('wiz-chk-vpsc').checked) {
                generateCompositeVPScatter();
            }
            var anyEnv = document.getElementById('wiz-chk-env-pv').checked ||
                         document.getElementById('wiz-chk-env-sc').checked ||
                         document.getElementById('wiz-chk-env-th').checked;
            if (anyEnv) generateEnvCompDiff();
        });
    } else {
        // Non-diff mode: fire all concurrently (each makes 1 API call)
        if (document.getElementById('wiz-chk-az').checked) generateCompositeAzMean();
        if (document.getElementById('wiz-chk-sq').checked) generateCompositeQuadMean();
        if (document.getElementById('wiz-chk-pv').checked) generateCompositePlanView();
        if (document.getElementById('wiz-chk-cfad') && document.getElementById('wiz-chk-cfad').checked) generateCompositeCFAD();
        if (document.getElementById('wiz-chk-anom') && document.getElementById('wiz-chk-anom').checked) generateCompositeAnomaly();
        if (document.getElementById('wiz-chk-vpsc') && document.getElementById('wiz-chk-vpsc').checked) generateCompositeVPScatter();
        if (document.getElementById('wiz-chk-ir-pv') && document.getElementById('wiz-chk-ir-pv').checked) generateCompositeIRPlanView();
        if (document.getElementById('wiz-chk-ir-az') && document.getElementById('wiz-chk-ir-az').checked) generateCompositeIRAzMean();
        var anyEnv = document.getElementById('wiz-chk-env-pv').checked ||
                     document.getElementById('wiz-chk-env-sc').checked ||
                     document.getElementById('wiz-chk-env-th').checked;
        if (anyEnv) generateEnvComposite();
    }
}

function _injectCompositeStyles() {
    // Styles now in external CSS file (tc_radar_styles.css)
    // Keep the old injected styles as fallback for any existing class references
    if (document.getElementById('composite-styles')) return;
    var style = document.createElement('style');
    style.id = 'composite-styles';
    style.textContent =
        '.comp-status { padding:12px 16px; border-radius:8px; font-size:12px; font-family:"JetBrains Mono",monospace; margin-bottom:12px; }' +
        '.comp-status.loading { background:rgba(34,211,238,0.08); color:var(--cyan, #22d3ee); border:1px solid rgba(34,211,238,0.2); }' +
        '.comp-status.success { background:rgba(16,185,129,0.08); color:#10b981; border:1px solid rgba(16,185,129,0.2); }' +
        '.comp-status.error { background:rgba(239,68,68,0.08); color:#ef4444; border:1px solid rgba(239,68,68,0.2); }' +
        '.comp-toolbar { display:flex; gap:8px; margin-top:10px; padding:10px 0 4px; border-top:1px solid rgba(255,255,255,0.06); }' +
        '.comp-tool-btn { padding:6px 12px; font-size:11px; font-weight:600; border:1px solid rgba(255,255,255,0.12); border-radius:6px; background:rgba(255,255,255,0.04); color:#9ca3af; cursor:pointer; font-family:"JetBrains Mono",monospace; transition:all 0.15s; }' +
        '.comp-tool-btn:hover { background:rgba(255,255,255,0.08); color:#e5e7eb; border-color:rgba(255,255,255,0.2); }' +
        '.comp-case-list-wrap { margin-top:10px; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:8px; overflow:hidden; }' +
        '.comp-cl-header { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border-bottom:1px solid rgba(255,255,255,0.06); background:rgba(255,255,255,0.02); }' +
        '.comp-cl-title { font-size:12px; font-weight:600; color:#e5e7eb; font-family:"JetBrains Mono",monospace; }' +
        '.comp-cl-scroll { max-height:280px; overflow-y:auto; }' +
        '.comp-cl-table { width:100%; border-collapse:collapse; font-size:11px; font-family:"JetBrains Mono",monospace; }' +
        '.comp-cl-table thead { position:sticky; top:0; background:#0a1628; }' +
        '.comp-cl-table th { padding:6px 10px; text-align:left; color:#9ca3af; font-weight:600; border-bottom:1px solid rgba(255,255,255,0.08); font-size:10px; text-transform:uppercase; letter-spacing:0.5px; }' +
        '.comp-cl-table td { padding:5px 10px; color:#d1d5db; border-bottom:1px solid rgba(255,255,255,0.03); }' +
        '.comp-cl-table tr:hover td { background:rgba(34,211,238,0.04); }' +
        '.comp-cl-empty { padding:16px; text-align:center; color:#6b7280; font-size:12px; }' +
        '.comp-cl-copy { font-size:10px !important; padding:3px 8px !important; }' +
        '.comp-link-btn { border-color:rgba(34,211,238,0.25); color:var(--cyan, #22d3ee); }' +
        '.comp-link-btn:hover { background:rgba(34,211,238,0.1); border-color:rgba(34,211,238,0.4); }' +
        '.comp-btn { padding:10px 16px; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:"JetBrains Mono",monospace; transition:all 0.15s; }' +
        '.comp-btn:disabled { opacity:0.4; cursor:not-allowed; }' +
        '.comp-btn-primary { background:var(--cyan, #22d3ee); color:#0a1628; }' +
        '.comp-btn-primary:hover:not(:disabled) { background:#67e8f9; }' +
        '.comp-btn-accent { background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); }' +
        '.comp-btn-accent:hover:not(:disabled) { background:rgba(245,158,11,0.25); }' +
        '.comp-btn-pv { background:rgba(16,185,129,0.15); color:#10b981; border:1px solid rgba(16,185,129,0.3); }' +
        '.comp-btn-pv:hover:not(:disabled) { background:rgba(16,185,129,0.25); }' +
        '.comp-btn-diff { background:rgba(245,158,11,0.12); color:#f59e0b; border:1px solid rgba(245,158,11,0.25); font-weight:600; }' +
        '.comp-btn-diff:hover:not(:disabled) { background:rgba(245,158,11,0.22); }' +
        '.hurricane-loader { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:16px 0 8px; }' +
        '.hurricane-pre { font-family:"JetBrains Mono","Fira Code",Consolas,monospace; line-height:1.1; letter-spacing:0.3px; margin:0; text-align:center; color:rgba(34,211,238,0.5); user-select:none; }' +
        '.hurricane-msg { margin-top:10px; font-size:12px; font-weight:600; color:#9ca3af; font-family:"JetBrains Mono",monospace; text-align:center; animation:hurricanePulse 2s ease-in-out infinite; }' +
        '@keyframes hurricanePulse { 0%,100% { opacity:0.5; } 50% { opacity:1; } }';
    document.head.appendChild(style);
}

function toggleCompositePanel() {
    gtag('event', 'tab_click', { tab_name: 'composites' });
    initCompositePanel();
    _injectCompositeStyles();
    var panel = document.getElementById('composite-panel');
    panel.classList.toggle('active');
    if (panel.classList.contains('active')) {
        updateCompositeCount();
        _wizardUpdateSummary();
    }
}


function _getCompositeFilters() {
    return {
        min_intensity:   parseFloat(document.getElementById('comp-int-min').value) || 0,
        max_intensity:   parseFloat(document.getElementById('comp-int-max').value) || 200,
        min_vmax_change: parseFloat(document.getElementById('comp-dv-min').value) || -100,
        max_vmax_change: parseFloat(document.getElementById('comp-dv-max').value) || 85,
        min_tilt:        parseFloat(document.getElementById('comp-tilt-min').value) || 0,
        max_tilt:        parseFloat(document.getElementById('comp-tilt-max').value) || 200,
        min_year:        parseInt(document.getElementById('comp-year-min').value) || 1997,
        max_year:        parseInt(document.getElementById('comp-year-max').value) || 2024,
        min_shear_mag:   parseFloat(document.getElementById('comp-shrmag-min').value) || 0,
        max_shear_mag:   parseFloat(document.getElementById('comp-shrmag-max').value) || 100,
        min_shear_dir:   parseFloat(document.getElementById('comp-shrdir-min').value) || 0,
        max_shear_dir:   parseFloat(document.getElementById('comp-shrdir-max').value) || 360,
        min_dtl:         parseFloat(document.getElementById('comp-dtl-min').value) || 0,
        dtl_window:      document.getElementById('comp-dtl-win').value || '24h',
    };
}

function _compositeQueryString(filters) {
    var parts = [];
    for (var k in filters) { parts.push(k + '=' + encodeURIComponent(filters[k])); }
    return parts.join('&');
}

function _debouncedCompositeCount() {
    clearTimeout(_compositeCountTimeout);
    _compositeCountTimeout = setTimeout(updateCompositeCount, 400);
}

function updateCompositeCount() {
    var filters = _getCompositeFilters();
    var dataType = document.getElementById('comp-dtype').value || 'swath';
    var el = document.getElementById('comp-count-num');
    el.textContent = '\u2026';
    fetch(API_BASE + '/composite/count?' + _compositeQueryString(filters) + '&data_type=' + dataType)
        .then(function(r) { return r.json(); })
        .then(function(json) {
            el.textContent = json.count;
            var capNote = document.getElementById('comp-cap-note');
            if (json.capped) {
                el.textContent = json.count + ' (max ' + json.max_cases + ')';
                el.style.color = '#fbbf24';
                el.title = 'Only the first ' + json.max_cases + ' cases will be composited.';
                if (capNote) { capNote.classList.add('capped'); capNote.textContent = 'Cap exceeded \u2014 only the first ' + json.max_cases + ' matching cases will be composited.'; }
            } else {
                el.style.color = '';
                el.title = '';
                if (capNote) { capNote.classList.remove('capped'); capNote.textContent = 'Composites are limited to ' + json.max_cases + ' cases per group.'; }
            }
            // Keep the summary badge in sync with the latest count
            _wizardUpdateSummary();
        })
        .catch(function() { el.textContent = '?'; });
}

function _compositeFilterSummary(filters, nCases) {
    var parts = [];
    if (filters.min_intensity > 0 || filters.max_intensity < 200)
        parts.push(filters.min_intensity + '\u2013' + filters.max_intensity + ' kt');
    if (filters.min_vmax_change > -100 || filters.max_vmax_change < 85)
        parts.push('\u0394V ' + filters.min_vmax_change + ' to ' + filters.max_vmax_change + ' kt');
    if (filters.min_tilt > 0 || filters.max_tilt < 200)
        parts.push('Tilt ' + filters.min_tilt + '\u2013' + filters.max_tilt + ' km');
    if (filters.min_year > 1997 || filters.max_year < 2024)
        parts.push(filters.min_year + '\u2013' + filters.max_year);
    if (filters.min_shear_mag > 0 || filters.max_shear_mag < 100)
        parts.push('Shr ' + filters.min_shear_mag + '\u2013' + filters.max_shear_mag + ' kt');
    if (filters.min_shear_dir > 0 || filters.max_shear_dir < 360)
        parts.push('Dir ' + filters.min_shear_dir + '\u2013' + filters.max_shear_dir + '\u00b0');
    if (filters.min_dtl > 0)
        parts.push('DTL \u2265 ' + filters.min_dtl + ' km (' + (filters.dtl_window || '24h') + ')');
    var summary = parts.length > 0 ? parts.join(' | ') : 'All cases';
    return 'Composite (N=' + nCases + ') | ' + summary;
}

function _computeCompositeMeanVmax(filters) {
    var dataType = document.getElementById('comp-dtype') ? document.getElementById('comp-dtype').value : 'swath';
    var source = (dataType === 'merge' && mergeData) ? mergeData : allData;
    if (!source || !source.cases) return null;
    var sum = 0, count = 0;
    source.cases.forEach(function(c) {
        if (c.vmax_kt === null || c.vmax_kt === undefined) return;
        var v = c.vmax_kt;
        if (v < filters.min_intensity || v > filters.max_intensity) return;
        if (filters.min_vmax_change > -100 || filters.max_vmax_change < 85) {
            if (c['24-h_vmax_change_kt'] === null || c['24-h_vmax_change_kt'] === undefined) return;
            var dv = c['24-h_vmax_change_kt'];
            if (dv < filters.min_vmax_change || dv > filters.max_vmax_change) return;
        }
        if (filters.min_tilt > 0 || filters.max_tilt < 200) {
            if (c.tilt_magnitude_km === null || c.tilt_magnitude_km === undefined) return;
            if (c.tilt_magnitude_km < filters.min_tilt || c.tilt_magnitude_km > filters.max_tilt) return;
        }
        if (c.year < filters.min_year || c.year > filters.max_year) return;
        if (filters.min_shear_mag > 0 || filters.max_shear_mag < 100) {
            var sm = c.shear_magnitude_kt !== undefined ? c.shear_magnitude_kt : null;
            if (sm === null) return;
            if (sm < filters.min_shear_mag || sm > filters.max_shear_mag) return;
        }
        if (filters.min_shear_dir > 0 || filters.max_shear_dir < 360) {
            var sd = c.sddc !== undefined ? c.sddc : null;
            if (sd === null) return;
            if (sd < filters.min_shear_dir || sd > filters.max_shear_dir) return;
        }
        if (filters.min_dtl > 0) {
            var dtlKey = filters.dtl_window === '12h' ? 'dtl_min_12h' : 'dtl_min_24h';
            var dtlVal = c[dtlKey];
            if (dtlVal == null || dtlVal < filters.min_dtl) return;
        }
        sum += v; count++;
    });
    return count > 0 ? Math.round(sum / count) : null;
}

/**
 * Fetch with a timeout — rejects with a clear message if the server doesn't
 * respond within `ms` milliseconds.  Helps surface crashes or stalls on the
 * Render server instead of leaving the user with a perpetual spinner.
 */
function _fetchWithTimeout(url, ms) {
    if (!ms) ms = 300000; // 5 minutes default (upgraded 2 GB Render plan)
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, ms);
    return fetch(url, { signal: controller.signal })
        .then(function(r) { clearTimeout(timer); return r; })
        .catch(function(err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') {
                throw new Error('Server timed out — the composite may be too large. Try narrowing your filters to reduce the case count.');
            }
            throw err;
        });
}

/**
 * Streaming composite fetch: reads NDJSON progress lines, updates the
 * loading status with a progress percentage, and returns the final result
 * JSON.  Falls back to a normal fetch if the browser doesn't support
 * ReadableStream (shouldn't happen in any modern browser).
 *
 * @param {string} url  – API URL (stream=true will be appended)
 * @param {string} label – Human label for the loading message
 * @param {number} [ms]  – Timeout in milliseconds (default 300 000)
 * @returns {Promise<Object>} – The final result JSON object
 */
function _fetchCompositeStream(url, label, ms) {
    if (!ms) ms = 300000;
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    var streamUrl = url + sep + 'stream=true';
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, ms);

    return fetch(streamUrl, { signal: controller.signal }).then(function(resp) {
        clearTimeout(timer);
        if (!resp.ok) {
            return resp.text().then(function(t) {
                try {
                    var j = JSON.parse(t);
                    var detail = j.detail;
                    if (typeof detail === 'object') detail = Array.isArray(detail) ? detail.map(function(d){return d.msg||JSON.stringify(d);}).join('; ') : JSON.stringify(detail);
                    throw new Error(detail || 'API error (HTTP ' + resp.status + ')');
                }
                catch(e) { if (e.message) throw e; throw new Error('API error: ' + t); }
            });
        }
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var lastResult = null;

        function pump() {
            return reader.read().then(function(chunk) {
                if (chunk.done) return lastResult;
                buffer += decoder.decode(chunk.value, { stream: true });
                // Process complete lines
                var lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line in buffer
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line) continue;
                    try {
                        var obj = JSON.parse(line);
                        if (obj.progress !== undefined && obj.total !== undefined) {
                            var pct = Math.round(100 * obj.progress / obj.total);
                            _showCompStatus('loading', label + ' — ' + obj.progress + ' / ' + obj.total + ' cases (' + pct + '%)');
                        } else if (obj.error) {
                            throw new Error(typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error));
                        } else {
                            // Final result JSON
                            lastResult = obj;
                        }
                    } catch(e) {
                        if (e.message && e.message !== 'Unexpected end of JSON input') throw e;
                    }
                }
                return pump();
            });
        }
        return pump();
    }).catch(function(err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            throw new Error('Server timed out — the composite may be too large. Try narrowing your filters to reduce the case count.');
        }
        throw err;
    });
}

function _showCompStatus(cls, msg) {
    var el = document.getElementById('comp-status');
    el.className = 'comp-status ' + cls;
    el.style.display = 'block';
    if (cls === 'loading') {
        el.innerHTML = _hurricaneLoadingHTML(msg, false);
    } else {
        _stopHurricaneAnim();
        el.textContent = msg;
    }
}

// ── Composite overlay contour helpers ─────────────────────────
function _compContourInterval(ovData) {
    var intInput = document.getElementById('comp-contour-int');
    var interval = intInput ? parseFloat(intInput.value) : NaN;
    if (isNaN(interval) || interval <= 0) {
        var flat = ovData.flat().filter(function(v) { return v !== null && !isNaN(v); });
        if (flat.length === 0) return 1;
        var mn = Infinity, mx = -Infinity;
        for (var i = 0; i < flat.length; i++) { if (flat[i] < mn) mn = flat[i]; if (flat[i] > mx) mx = flat[i]; }
        interval = parseFloat(((mx - mn) / 10).toPrecision(1));
        if (!isFinite(interval) || interval <= 0) interval = (mx - mn) / 10 || 1;
    }
    return interval;
}

function buildCompAzOverlayContours(json, radius, height_km) {
    if (!json.overlay) return [];
    var ov = json.overlay; var ovData = ov.azimuthal_mean; if (!ovData) return [];
    try {
        var interval = _compContourInterval(ovData);
        var baseContour = { z: ovData, x: radius, y: height_km, type: 'contour', showscale: false, hoverongaps: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 9, color: 'rgba(255,255,255,0.8)' } } };
        var traces = [];
        if (ov.vmax > interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'solid' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (+)', showlegend: false }));
        if (ov.vmin < -interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (\u2212)', showlegend: false }));
        return traces;
    } catch (e) { console.warn('Composite az overlay error:', e); return []; }
}

function buildCompQuadOverlayContours(json, radius, height_km, panelOrder) {
    if (!json.overlay || !json.overlay.quadrant_means) return [];
    var ov = json.overlay; var traces = [];
    try {
        // Use first available quadrant data for interval calc
        var firstQ = null;
        for (var k in ov.quadrant_means) { if (ov.quadrant_means[k] && ov.quadrant_means[k].data) { firstQ = ov.quadrant_means[k].data; break; } }
        if (!firstQ) return [];
        var interval = _compContourInterval(firstQ);
        panelOrder.forEach(function(p, i) {
            var ovQ = ov.quadrant_means[p.key]; if (!ovQ || !ovQ.data) return;
            var axSuffix = i === 0 ? '' : String(i + 1);
            var baseContour = { z: ovQ.data, x: radius, y: height_km, type: 'contour', xaxis: 'x' + axSuffix, yaxis: 'y' + axSuffix, showscale: false, hoverongaps: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 8, color: 'rgba(255,255,255,0.7)' } } };
            if (ov.vmax > interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.6)', width: 1, dash: 'solid' }, showlegend: false }));
            if (ov.vmin < -interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.6)', width: 1, dash: 'dash' }, showlegend: false }));
        });
        return traces;
    } catch (e) { console.warn('Composite quad overlay error:', e); return []; }
}

// ── Composite export & case-list utilities ──────────────────
var _lastCompJson = null;
var _lastCompType = null;  // 'az' or 'sq'

function _buildCompToolbar() {
    return '<div class="comp-toolbar">' +
        '<button class="comp-tool-btn" onclick="_downloadCompCSV()" title="Download data as CSV">\u2B07 CSV</button>' +
        '<button class="comp-tool-btn" onclick="_downloadCompJSON()" title="Download full API response as JSON">\u2B07 JSON</button>' +
        '<button class="comp-tool-btn" onclick="_toggleCompCaseList()" title="Show/hide cases used in this composite">\uD83D\uDCCB Cases</button>' +
        '<button class="comp-tool-btn comp-link-btn" onclick="_copyCompPermalink()" title="Copy shareable link with current settings">\uD83D\uDD17 Copy Link</button>' +
    '</div>' +
    '<div class="comp-case-list-wrap" id="comp-case-list" style="display:none;"></div>';
}

// ── Permalink: encode/decode composite state in URL hash ────
function _buildCompPermalinkHash() {
    var filters = _getCompositeFilters();
    var params = {};
    // Only include non-default filter values to keep the URL clean
    if (filters.min_intensity > 0)     params.min_intensity = filters.min_intensity;
    if (filters.max_intensity < 200)   params.max_intensity = filters.max_intensity;
    if (filters.min_vmax_change > -100) params.min_vmax_change = filters.min_vmax_change;
    if (filters.max_vmax_change < 85)  params.max_vmax_change = filters.max_vmax_change;
    if (filters.min_tilt > 0)          params.min_tilt = filters.min_tilt;
    if (filters.max_tilt < 200)        params.max_tilt = filters.max_tilt;
    if (filters.min_year > 1997)       params.min_year = filters.min_year;
    if (filters.max_year < 2024)       params.max_year = filters.max_year;
    if (filters.min_shear_mag > 0)     params.min_shear_mag = filters.min_shear_mag;
    if (filters.max_shear_mag < 100)   params.max_shear_mag = filters.max_shear_mag;
    if (filters.min_shear_dir > 0)     params.min_shear_dir = filters.min_shear_dir;
    if (filters.max_shear_dir < 360)   params.max_shear_dir = filters.max_shear_dir;
    // Variable, data type, coverage, overlay
    var variable = document.getElementById('comp-var');
    if (variable && variable.value !== 'recentered_tangential_wind') params.variable = variable.value;
    var dtype = document.getElementById('comp-dtype');
    if (dtype && dtype.value !== 'swath') params.dtype = dtype.value;
    var coverage = document.getElementById('comp-coverage');
    if (coverage && coverage.value !== '50') params.coverage = coverage.value;
    var overlay = document.getElementById('comp-overlay');
    if (overlay && overlay.value) params.overlay = overlay.value;
    // Plan-view parameters (only when relevant)
    var pvParams = _getCompositePlanViewParams();
    if (pvParams.level_km !== 2.0)    params.level_km = pvParams.level_km;
    if (pvParams.normalize_rmw)        params.normalize_rmw = 'true';
    if (pvParams.max_r_rmw !== 5.0)   params.max_r_rmw = pvParams.max_r_rmw;
    if (pvParams.dr_rmw !== 0.1)      params.dr_rmw = pvParams.dr_rmw;
    if (pvParams.shear_relative)       params.shear_relative = 'true';
    // Which view was generated
    if (_lastCompType) params.view = _lastCompType;
    var qs = Object.keys(params).map(function(k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return 'composite' + (qs ? '?' + qs : '');
}

function _copyCompPermalink() {
    initCompositePanel();  // ensure panel is created so filters exist
    var hash = _buildCompPermalinkHash();
    var url = window.location.origin + window.location.pathname + '#' + hash;
    navigator.clipboard.writeText(url).then(function() {
        var btn = document.querySelector('.comp-link-btn');
        if (btn) { var orig = btn.innerHTML; btn.innerHTML = '\u2713 Copied!'; setTimeout(function() { btn.innerHTML = orig; }, 1500); }
    });
    // Also update browser URL bar (without reloading)
    history.replaceState(null, '', '#' + hash);
}

function _parseCompHashParams() {
    var hash = window.location.hash;
    if (!hash || hash.indexOf('#composite') !== 0) return null;
    var qsIdx = hash.indexOf('?');
    if (qsIdx === -1) return {};  // just #composite with no params
    var qs = hash.substring(qsIdx + 1);
    var params = {};
    qs.split('&').forEach(function(pair) {
        var parts = pair.split('=');
        if (parts.length === 2) params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1]);
    });
    return params;
}

function _applyCompHashParams(params) {
    if (!params) return false;
    initCompositePanel();

    // Set filter values
    var fieldMap = {
        min_intensity: 'comp-int-min', max_intensity: 'comp-int-max',
        min_vmax_change: 'comp-dv-min', max_vmax_change: 'comp-dv-max',
        min_tilt: 'comp-tilt-min', max_tilt: 'comp-tilt-max',
        min_year: 'comp-year-min', max_year: 'comp-year-max',
        min_shear_mag: 'comp-shrmag-min', max_shear_mag: 'comp-shrmag-max',
        min_shear_dir: 'comp-shrdir-min', max_shear_dir: 'comp-shrdir-max'
    };
    for (var key in fieldMap) {
        if (params[key] !== undefined) {
            var el = document.getElementById(fieldMap[key]);
            if (el) el.value = params[key];
        }
    }
    // Variable
    if (params.variable) {
        var varSel = document.getElementById('comp-var');
        if (varSel) varSel.value = params.variable;
    }
    // Data type
    if (params.dtype) {
        var dtSel = document.getElementById('comp-dtype');
        if (dtSel) {
            dtSel.value = params.dtype;
            _updateOriginalVarGroup('comp', params.dtype);
            _updateCompOverlayOriginalGroup(params.dtype);
        }
    }
    // Coverage
    if (params.coverage) {
        var covSlider = document.getElementById('comp-coverage');
        if (covSlider) {
            covSlider.value = params.coverage;
            var covLabel = document.getElementById('comp-cov-val');
            if (covLabel) covLabel.textContent = params.coverage + '%';
        }
    }
    // Overlay
    if (params.overlay) {
        var ovSel = document.getElementById('comp-overlay');
        if (ovSel) ovSel.value = params.overlay;
    }

    // Plan-view parameters
    if (params.level_km) {
        var lvlSel = document.getElementById('comp-level');
        if (lvlSel) lvlSel.value = params.level_km;
    }
    if (params.normalize_rmw === 'true') {
        var nrmCheck = document.getElementById('comp-norm-rmw');
        if (nrmCheck) { nrmCheck.checked = true; nrmCheck.dispatchEvent(new Event('change')); }
    }
    if (params.max_r_rmw) {
        var mrEl = document.getElementById('comp-max-r-rmw');
        if (mrEl) mrEl.value = params.max_r_rmw;
    }
    if (params.dr_rmw) {
        var drEl = document.getElementById('comp-dr-rmw');
        if (drEl) drEl.value = params.dr_rmw;
    }
    if (params.shear_relative === 'true') {
        var srCheck = document.getElementById('comp-shear-rel');
        if (srCheck) srCheck.checked = true;
    }

    // Open the panel
    var panel = document.getElementById('composite-panel');
    if (!panel.classList.contains('active')) panel.classList.add('active');

    // Update the count then auto-generate if a view was specified
    updateCompositeCount();
    if (params.view === 'az') {
        _wizardGoToStep(4);
        setTimeout(generateCompositeAzMean, 600);
    } else if (params.view === 'sq') {
        _wizardGoToStep(4);
        setTimeout(generateCompositeQuadMean, 600);
    } else if (params.view === 'pv') {
        _wizardGoToStep(4);
        setTimeout(generateCompositePlanView, 600);
    }
    return true;
}

// Check for composite permalink on page load (called after data loads)
function _checkCompPermalink() {
    var params = _parseCompHashParams();
    if (params) {
        // Small delay to ensure composite panel DOM is ready
        setTimeout(function() { _applyCompHashParams(params); }, 300);
    }
}

function _triggerDownload(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function _downloadCompJSON() {
    if (!_lastCompJson) return;
    var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var filename = 'tc_radar_composite_' + _lastCompType + '_' + ts + '.json';
    _triggerDownload(JSON.stringify(_lastCompJson, null, 2), filename, 'application/json');
}

function _downloadCompCSV() {
    if (!_lastCompJson) return;
    var json = _lastCompJson;
    var radius = json.radius_rrmw;
    var height_km = json.height_km;
    var varInfo = json.variable;
    var rLabel = json.normalized ? 'R/RMW' : 'Radius_km';
    var lines = [];

    if (_lastCompType === 'az') {
        // Azimuthal mean: straightforward height × radius table
        lines.push('# TC-RADAR Composite Azimuthal Mean');
        lines.push('# Variable: ' + varInfo.display_name + ' (' + varInfo.units + ')');
        lines.push('# N cases: ' + json.n_cases);
        lines.push('# Coverage threshold: ' + Math.round((json.coverage_min || 0.5) * 100) + '%');
        lines.push('# Filters: ' + JSON.stringify(json.filters));
        lines.push('#');
        // Header row: Height_km, then each radius bin
        lines.push('Height_km,' + radius.map(function(r) { return rLabel + '=' + r; }).join(','));
        var azData = json.azimuthal_mean;
        for (var h = 0; h < height_km.length; h++) {
            var row = [height_km[h]];
            for (var r = 0; r < radius.length; r++) {
                var v = azData[h] && azData[h][r];
                row.push(v !== null && v !== undefined ? v : '');
            }
            lines.push(row.join(','));
        }
    } else if (_lastCompType === 'sq') {
        // Quadrant means: one block per quadrant
        lines.push('# TC-RADAR Composite Shear-Relative Quadrant Means');
        lines.push('# Variable: ' + varInfo.display_name + ' (' + varInfo.units + ')');
        lines.push('# N cases: ' + json.n_cases);
        lines.push('# Coverage threshold: ' + Math.round((json.coverage_min || 0.5) * 100) + '%');
        lines.push('# Filters: ' + JSON.stringify(json.filters));
        lines.push('#');
        var qOrder = ['DSL', 'DSR', 'USL', 'USR'];
        var qLabels = { DSL: 'Downshear Left', DSR: 'Downshear Right', USL: 'Upshear Left', USR: 'Upshear Right' };
        // Header row: Quadrant, Height_km, then each radius bin
        lines.push('Quadrant,Height_km,' + radius.map(function(r) { return rLabel + '=' + r; }).join(','));
        qOrder.forEach(function(q) {
            var qData = json.quadrant_means[q];
            if (!qData || !qData.data) return;
            for (var h = 0; h < height_km.length; h++) {
                var row = [qLabels[q], height_km[h]];
                for (var r = 0; r < radius.length; r++) {
                    var v = qData.data[h] && qData.data[h][r];
                    row.push(v !== null && v !== undefined ? v : '');
                }
                lines.push(row.join(','));
            }
        });
    } else if (_lastCompType === 'pv') {
        // Plan-view: Y × X table
        var xAxis = json.x_axis, yAxis = json.y_axis;
        lines.push('# TC-RADAR Composite Plan View');
        lines.push('# Variable: ' + varInfo.display_name + ' (' + varInfo.units + ')');
        lines.push('# Height: ' + json.level_km + ' km');
        lines.push('# N cases: ' + json.n_cases);
        lines.push('# RMW-normalized: ' + (json.normalize_rmw ? 'yes' : 'no'));
        lines.push('# Shear-relative: ' + (json.shear_relative ? 'yes' : 'no'));
        lines.push('# Filters: ' + JSON.stringify(json.filters));
        lines.push('#');
        lines.push(json.x_label + ',' + xAxis.join(','));
        var pvData = json.plan_view;
        for (var yi = 0; yi < yAxis.length; yi++) {
            var row = [yAxis[yi]];
            for (var xi = 0; xi < xAxis.length; xi++) {
                var v = pvData[yi] && pvData[yi][xi];
                row.push(v !== null && v !== undefined ? v : '');
            }
            lines.push(row.join(','));
        }
    }

    // Append case list(s)
    if (json.case_list && json.case_list.length > 0) {
        lines.push('');
        var groupLabel = json._isDiff ? '# Cases in Group A' : '# Cases used in composite';
        lines.push(groupLabel);
        lines.push('case_index,storm_name,datetime,vmax_kt');
        json.case_list.forEach(function(c) {
            lines.push([c.case_index, c.storm_name, c.datetime, c.vmax_kt !== null ? c.vmax_kt : ''].join(','));
        });
    }
    if (json._isDiff && json.case_list_b && json.case_list_b.length > 0) {
        lines.push('');
        lines.push('# Cases in Group B');
        lines.push('case_index,storm_name,datetime,vmax_kt');
        json.case_list_b.forEach(function(c) {
            lines.push([c.case_index, c.storm_name, c.datetime, c.vmax_kt !== null ? c.vmax_kt : ''].join(','));
        });
    }

    var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var filename = 'tc_radar_composite_' + _lastCompType + '_' + ts + '.csv';
    _triggerDownload(lines.join('\n'), filename, 'text/csv');
}

var _caseListShowingGroup = 'A';  // Track which group is visible in diff mode

function _toggleCompCaseList() {
    var el = document.getElementById('comp-case-list');
    if (!el || !_lastCompJson) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    _caseListShowingGroup = 'A';
    _renderCompCaseList();
}

function _renderCompCaseList() {
    var el = document.getElementById('comp-case-list');
    if (!el || !_lastCompJson) return;
    var isDiff = !!_lastCompJson._isDiff;
    var group = _caseListShowingGroup;
    var caseList = (isDiff && group === 'B') ? (_lastCompJson.case_list_b || []) : (_lastCompJson.case_list || []);

    if (caseList.length === 0) {
        el.innerHTML = '<div class="comp-cl-empty">No case list available for Group ' + group + '.</div>';
        el.style.display = 'block';
        return;
    }

    var html = '<div class="comp-cl-header">';
    // Add A/B toggle buttons in diff mode
    if (isDiff) {
        var nA = (_lastCompJson.case_list || []).length;
        var nB = (_lastCompJson.case_list_b || []).length;
        var activeA = group === 'A' ? 'background:rgba(96,165,250,0.2);border-color:rgba(96,165,250,0.5);color:#60a5fa;' : '';
        var activeB = group === 'B' ? 'background:rgba(245,158,11,0.2);border-color:rgba(245,158,11,0.5);color:#f59e0b;' : '';
        html += '<div style="display:flex;gap:4px;margin-right:8px;">' +
            '<button onclick="_switchCaseListGroup(\'A\')" style="padding:3px 10px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.15);border-radius:4px;cursor:pointer;font-family:\'JetBrains Mono\',monospace;' + activeA + '">Group A (' + nA + ')</button>' +
            '<button onclick="_switchCaseListGroup(\'B\')" style="padding:3px 10px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.15);border-radius:4px;cursor:pointer;font-family:\'JetBrains Mono\',monospace;' + activeB + '">Group B (' + nB + ')</button>' +
        '</div>';
        var groupColor = group === 'A' ? '#60a5fa' : '#f59e0b';
        html += '<span class="comp-cl-title" style="color:' + groupColor + ';">\uD83D\uDCCB Group ' + group + ': ' + caseList.length + ' cases</span>';
    } else {
        html += '<span class="comp-cl-title">\uD83D\uDCCB ' + caseList.length + ' cases used in composite</span>';
    }
    html += '<button class="comp-tool-btn comp-cl-copy" onclick="_copyCompCaseIndices()" title="Copy case indices to clipboard">\uD83D\uDCCB Copy Indices</button>' +
    '</div>' +
    '<div class="comp-cl-scroll"><table class="comp-cl-table"><thead><tr>' +
        '<th>Index</th><th>Storm</th><th>Date/Time</th><th>V<sub>max</sub> (kt)</th>' +
    '</tr></thead><tbody>';
    caseList.forEach(function(c) {
        var cat = getIntensityCategory(c.vmax_kt);
        var color = getIntensityColor(c.vmax_kt);
        html += '<tr><td>' + c.case_index + '</td><td>' + c.storm_name + '</td><td>' + c.datetime + '</td>' +
            '<td><span class="intensity-badge" style="background:' + color + ';font-size:9px;padding:1px 4px;">' + cat + '</span> ' + (c.vmax_kt !== null ? c.vmax_kt : 'N/A') + '</td></tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
    el.style.display = 'block';
}

function _switchCaseListGroup(group) {
    _caseListShowingGroup = group;
    _renderCompCaseList();
}

function _copyCompCaseIndices() {
    if (!_lastCompJson) return;
    var caseList = (_lastCompJson._isDiff && _caseListShowingGroup === 'B')
        ? (_lastCompJson.case_list_b || [])
        : (_lastCompJson.case_list || []);
    var indices = caseList.map(function(c) { return c.case_index; });
    navigator.clipboard.writeText(indices.join(', ')).then(function() {
        var btn = document.querySelector('.comp-cl-copy');
        if (btn) { var orig = btn.textContent; btn.textContent = '\u2713 Copied!'; setTimeout(function() { btn.textContent = orig; }, 1500); }
    });
}

function renderCompositeAzMeanInto(targetId, json, filters) {
    var el = document.getElementById(targetId); if (!el) return;
    var azData = json.azimuthal_mean, radius = json.radius_rrmw, height_km = json.height_km, varInfo = json.variable;
    var isNorm = json.normalized;
    var rLabel = isNorm ? 'R / RMW' : 'Radius (km)';
    var fontSize = { title:14, axis:12, tick:10, cbar:12, cbarTick:10, hover:13 };
    var heatmap = {
        z: azData, x: radius, y: height_km, type: 'heatmap',
        colorscale: varInfo.colorscale, zmin: varInfo.vmin, zmax: varInfo.vmax,
        colorbar: { title: { text: varInfo.units, font: { color:'#ccc', size:fontSize.cbar } }, tickfont: { color:'#ccc', size:fontSize.cbarTick }, thickness:14, len:0.85 },
        hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>' + rLabel + ': %{x:.2f}<br>Height: %{y:.1f} km<extra></extra>',
        hoverongaps: false
    };
    var covPct = Math.round((json.coverage_min || 0.5) * 100);
    var rmwNote = isNorm ? ' | N(RMW)=' + (json.n_with_rmw || json.n_cases) : '';
    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var meanVmax = _computeCompositeMeanVmax(filters);
    var vmaxNote = meanVmax !== null ? ' | Mean V<sub>max</sub>=' + meanVmax + ' kt' : '';
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    var title = _compositeFilterSummary(filters, json.n_cases) + vmaxNote + rmwNote +
               '<br>Azimuthal Mean: ' + varInfo.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)' + overlayLabel;
    var plotBg = '#0a1628';
    var shapes = [];
    // RMW reference line at R/RMW = 1
    if (isNorm) shapes.push({ type:'line', xref:'x', yref:'paper', x0:1, x1:1, y0:0, y1:1, line:{ color:'white', width:1.5, dash:'dash' } });
    var layout = {
        title: { text: title, font: { color:'#e5e7eb', size:fontSize.title }, y:0.97, x:0.5, xanchor:'center' },
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        xaxis: { title: { text:rLabel, font:{color:'#aaa',size:fontSize.axis} }, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
        yaxis: { title: { text:'Height (km)', font:{color:'#aaa',size:fontSize.axis} }, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
        margin: { l:55, r:24, t: json.overlay ? 170 : 156, b:46 }, shapes: shapes,
        hoverlabel: { bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
        showlegend: false
    };
    var maxInfo = findDataMax(azData, radius, height_km);
    if (maxInfo) {
        var maxAnnot = buildMaxAnnotation(maxInfo, varInfo.units, isNorm ? 'R/RMW' : 'R', 'Z', 10);
        if (maxAnnot) layout.annotations = (layout.annotations || []).concat([maxAnnot]);
    }
    var compAzOverlay = buildCompAzOverlayContours(json, radius, height_km);
    el.style.display = 'block';
    _lastCompJson = json; _lastCompType = 'az';
    _registerShadingTargets('shd-az', ['comp-az-chart'], varInfo.colorscale, varInfo.vmin, varInfo.vmax);
    el.innerHTML = '<div id="comp-az-chart" style="width:100%;height:560px;border-radius:8px;overflow:hidden;"></div>' + _buildShadingControlsRow('shd-az', {defaultVmin: varInfo.vmin, defaultVmax: varInfo.vmax}) + _buildCompToolbar();
    Plotly.newPlot('comp-az-chart', [heatmap].concat(compAzOverlay), layout, { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
    // Apply user-specified range from Step 3 controls if set
    var _userVmin = _getCompVmin(null), _userVmax = _getCompVmax(null);
    if (_userVmin !== null && _userVmax !== null) {
        Plotly.restyle('comp-az-chart', { zmin: [_userVmin], zmax: [_userVmax] }, [0]);
    }
}

// ── TC-centric quad layout ──────────────────────────────────
// When enabled, upshear (left) panels have their x-axis reversed so
// R=0 meets in the centre of the four panels, giving the visual
// impression of a continuous cross-section through the vortex.
var _compQuadTCCentric = true;

function _toggleQuadTCCentric() {
    _compQuadTCCentric = !_compQuadTCCentric;
    // Update all visible toggle buttons
    document.querySelectorAll('.sq-tc-toggle-btn').forEach(function(btn) {
        btn.textContent = _compQuadTCCentric ? '\u229A TC-Centric' : '\u229B Standard';
        btn.title = _compQuadTCCentric
            ? 'Upshear axes reversed so R=0 meets at centre (click for standard layout)'
            : 'Standard layout with all axes 0\u2192max (click for TC-centric)';
    });
    // Relayout every quad chart that currently exists
    _applyQuadTCCentricLayout('comp-sq-chart');
    ['comp-diff-sq-a', 'comp-diff-sq-b', 'comp-diff-sq-d'].forEach(function(id) {
        _applyQuadTCCentricLayout(id);
    });
}

function _applyQuadTCCentricLayout(chartId) {
    var plotDiv = document.getElementById(chartId);
    if (!plotDiv || !plotDiv.data) return;
    // Upshear panels: xaxis (i=0, suffix='') and xaxis3 (i=2, suffix='3')
    // Downshear panels: xaxis2 (i=1) and xaxis4 (i=3)
    var update = {};
    update['xaxis.autorange']  = _compQuadTCCentric ? 'reversed' : true;
    update['xaxis3.autorange'] = _compQuadTCCentric ? 'reversed' : true;
    update['xaxis2.autorange'] = true;
    update['xaxis4.autorange'] = true;
    Plotly.relayout(plotDiv, update);
}

function _buildQuadLayoutToggle() {
    var label = _compQuadTCCentric ? '\u229A TC-Centric' : '\u229B Standard';
    var tip = _compQuadTCCentric
        ? 'Upshear axes reversed so R=0 meets at centre (click for standard layout)'
        : 'Standard layout with all axes 0\u2192max (click for TC-centric)';
    return '<button class="comp-tool-btn sq-tc-toggle-btn" onclick="_toggleQuadTCCentric()" title="' + tip + '" ' +
           'style="font-weight:600;border:1px solid rgba(96,165,250,0.3);color:#60a5fa;">' + label + '</button>';
}

function renderCompositeQuadMeanInto(targetId, json, filters) {
    var el = document.getElementById(targetId); if (!el) return;
    var quads = json.quadrant_means;
    var radius = json.radius_rrmw, height_km = json.height_km, varInfo = json.variable;
    var isNorm = json.normalized;
    var rLabel = isNorm ? 'R / RMW' : 'Radius (km)';
    var fontSize = { title:14, axis:11, tick:10, cbar:11, cbarTick:10, hover:12, panel:12 };
    var zmin = varInfo.vmin, zmax = varInfo.vmax;
    var tcCentric = _compQuadTCCentric;

    var panelOrder = [
        { key:'USL', label:'Upshear Left', row:0, col:0 },
        { key:'DSL', label:'Downshear Left', row:0, col:1 },
        { key:'USR', label:'Upshear Right', row:1, col:0 },
        { key:'DSR', label:'Downshear Right', row:1, col:1 }
    ];

    var traces = [], annotations = [], shapes = [];
    var gap=0.04, cbarW=0.04, leftM=0.06, rightM=0.02+cbarW+0.02, topM=0.20, botM=0.06;
    var pw = (1-leftM-rightM-gap)/2, ph = (1-topM-botM-gap)/2;
    var quadColors = { DSL:'#f59e0b', DSR:'#f59e0b', USL:'#60a5fa', USR:'#60a5fa' };

    panelOrder.forEach(function(p, i) {
        var qData = quads[p.key];
        if (!qData || !qData.data) return;
        var x0 = leftM + p.col * (pw + gap);
        var x1 = x0 + pw;
        var yTop = 1 - topM - p.row * ph - p.row * gap;
        var yBottom = 1 - topM - (p.row+1) * ph - p.row * gap;
        var axSuffix = i === 0 ? '' : String(i+1);
        var showCbar = (i === 1);
        traces.push({
            z:qData.data, x:radius, y:height_km, type:'heatmap',
            colorscale:varInfo.colorscale, zmin:zmin, zmax:zmax,
            xaxis:'x'+axSuffix, yaxis:'y'+axSuffix,
            showscale:showCbar,
            colorbar: showCbar ? { title:{text:varInfo.units,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:14, len:0.85, x:1.02, y:0.5 } : undefined,
            hovertemplate:'<b>'+p.label+'</b><br>'+varInfo.display_name+': %{z:.2f} '+varInfo.units+'<br>'+rLabel+': %{x:.2f}<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps:false
        });
        annotations.push({
            text:'<b>'+p.label+'</b>', xref:'paper', yref:'paper',
            x:(x0+x1)/2, y:yTop+0.005, xanchor:'center', yanchor:'bottom', showarrow:false,
            font:{ color:quadColors[p.key]||'#ccc', size:fontSize.panel, family:'JetBrains Mono, monospace' },
            bgcolor:'rgba(10,22,40,0.7)', borderpad:2
        });
        // RMW reference line at R/RMW = 1
        if (isNorm) {
            shapes.push({ type:'line', xref:'x'+axSuffix, yref:'y'+axSuffix,
                x0:1, x1:1, y0:height_km[0], y1:height_km[height_km.length-1],
                line:{ color:'white', width:1, dash:'dash' } });
        }
    });

    // Shear arrow inset at center
    var shearInset = buildShearInset(90, true);
    annotations = annotations.concat(shearInset.annotations || []);

    var covPct = Math.round((json.coverage_min || 0.5) * 100);
    var rmwNote = isNorm ? ' | N(RMW+Shr)=' + (json.n_with_shear_and_rmw || json.n_cases) : '';
    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var meanVmax = _computeCompositeMeanVmax(filters);
    var vmaxNote = meanVmax !== null ? ' | Mean V<sub>max</sub>=' + meanVmax + ' kt' : '';
    var title = _compositeFilterSummary(filters, json.n_cases) + vmaxNote + rmwNote +
               '<br>Shear-Relative Quadrant Mean: ' + varInfo.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)';
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    title += overlayLabel;

    var plotBg = '#0a1628';
    var layoutAxes = {};
    panelOrder.forEach(function(p, i) {
        var x0 = leftM + p.col * (pw + gap);
        var x1 = x0 + pw;
        var yBottom = 1 - topM - (p.row+1) * ph - p.row * gap;
        var yTop = 1 - topM - p.row * ph - p.row * gap;
        var axSuffix = i === 0 ? '' : String(i+1);
        var isUpshear = (p.col === 0);
        var showYLabel = (p.col === 0), showXLabel = (p.row === 1);
        var xAxisDef = { domain:[x0,x1], title:showXLabel?{text:rLabel,font:{color:'#aaa',size:fontSize.axis}}:undefined, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false, anchor:'y'+axSuffix };
        if (tcCentric && isUpshear) xAxisDef.autorange = 'reversed';
        layoutAxes['xaxis' + axSuffix] = xAxisDef;
        layoutAxes['yaxis' + axSuffix] = { domain:[yBottom,yTop], title:showYLabel?{text:'Height (km)',font:{color:'#aaa',size:fontSize.axis}}:undefined, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false, anchor:'x'+axSuffix };
    });

    var compQuadOverlay = buildCompQuadOverlayContours(json, radius, height_km, panelOrder);

    var layout = Object.assign({
        title:{ text:title, font:{color:'#e5e7eb',size:fontSize.title}, y:0.98, x:0.5, xanchor:'center', yanchor:'top' },
        paper_bgcolor:plotBg, plot_bgcolor:plotBg,
        margin:{ l:50, r:60, t: json.overlay ? 170 : 156, b:50 },
        annotations:annotations, shapes:shapes.concat(shearInset.shapes || []),
        hoverlabel:{ bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
        showlegend:false
    }, layoutAxes);

    el.style.display = 'block';
    _lastCompJson = json; _lastCompType = 'sq';
    _registerShadingTargets('shd-sq', ['comp-sq-chart'], varInfo.colorscale, varInfo.vmin, varInfo.vmax);
    el.innerHTML = '<div id="comp-sq-chart" style="width:100%;height:740px;border-radius:8px;overflow:hidden;"></div>' + _buildShadingControlsRow('shd-sq', {defaultVmin: varInfo.vmin, defaultVmax: varInfo.vmax}) + _buildCompToolbar() + _buildQuadLayoutToggle();
    Plotly.newPlot('comp-sq-chart', traces.concat(compQuadOverlay), layout, { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
    // Apply user-specified range from Step 3 controls if set
    var _userVmin = _getCompVmin(null), _userVmax = _getCompVmax(null);
    if (_userVmin !== null && _userVmax !== null) {
        var _sqPlot = document.getElementById('comp-sq-chart');
        if (_sqPlot && _sqPlot.data) {
            var _heatmapIdx = [];
            _sqPlot.data.forEach(function(t, i) { if (t.type === 'heatmap') _heatmapIdx.push(i); });
            if (_heatmapIdx.length) {
                Plotly.restyle(_sqPlot, {
                    zmin: _heatmapIdx.map(function() { return _userVmin; }),
                    zmax: _heatmapIdx.map(function() { return _userVmax; })
                }, _heatmapIdx);
            }
        }
    }
}

function generateCompositeAzMean() {
    var filters = _getCompositeFilters();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    _ga('composite_az_mean', { variable: variable, data_type: dataType });
    var coverage = parseInt(document.getElementById('comp-coverage').value) / 100;
    var btnAz = document.getElementById('comp-btn-az'), btnSq = document.getElementById('comp-btn-sq'), btnPv = document.getElementById('comp-btn-pv');
    if (btnAz) if (btnAz) btnAz.disabled = true; if (btnSq) if (btnSq) btnSq.disabled = true; if (btnPv) if (btnPv) btnPv.disabled = true;
    if (btnAz) btnAz.textContent = '\u23F3 Computing\u2026';
    var _crp = document.getElementById('comp-result-placeholder') || document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing composite azimuthal mean \u2014 this may take 30\u201390 seconds for many cases\u2026');

    var overlay = (document.getElementById('comp-overlay') || {}).value || '';
    var normRmw = !!(document.getElementById('comp-norm-rmw') || {}).checked;
    var maxRRmw = normRmw ? (parseFloat((document.getElementById('comp-max-r-rmw') || {}).value) || 8.0) : (parseFloat((document.getElementById('comp-max-r-rmw') || {}).value) || 200);
    var drRmw   = normRmw ? Math.max(0.05, parseFloat((document.getElementById('comp-dr-rmw') || {}).value) || 0.25) : (parseFloat((document.getElementById('comp-dr-rmw') || {}).value) || 2);
    var qs = _compositeQueryString(filters) + '&variable=' + encodeURIComponent(variable) + '&data_type=' + dataType + '&coverage_min=' + coverage +
        '&normalize_rmw=' + (normRmw ? 'true' : 'false') + '&max_r_rmw=' + maxRRmw + '&dr_rmw=' + drRmw;
    if (overlay) qs += '&overlay=' + encodeURIComponent(overlay);
    _fetchCompositeStream(API_BASE + '/composite/azimuthal_mean?' + qs, 'Computing azimuthal mean')
        .then(function(json) {
            _showCompStatus('success', '\u2713 Composite computed: ' + json.n_cases + ' cases processed');
            _updateBadgeFromResult(json.n_cases);
            renderCompositeAzMeanInto('comp-result-az', json, filters);
            _showCompShadingToolbar();
            history.replaceState(null, '', '#' + _buildCompPermalinkHash());
        })
        .catch(function(err) { _showCompStatus('error', '\u2717 ' + (err.message || String(err))); })
        .finally(function() {
            if (btnAz) btnAz.disabled = false; if (btnSq) btnSq.disabled = false; if (btnPv) if (btnPv) btnPv.disabled = false;
            if (btnAz) btnAz.textContent = '\u27F3 Azimuthal Mean';
        });
}

// ── Composite Anomaly & VP Scatter ──────────────────────────────────────

function generateCompositeAnomaly() {
    _ga('composite_anomaly', {});
    var resultEl = document.getElementById('comp-result-anom');
    var dataType = document.getElementById('comp-dtype').value;
    if (dataType !== 'merge') {
        resultEl.style.display = 'block';
        resultEl.innerHTML = '<div class="explorer-status" style="color:#fbbf24;padding:12px;font-size:12px;">\u26A0\uFE0F Anomaly composites are only available for merged analyses. Switch data type to "Merge".</div>';
        return;
    }

    var filters = _getCompositeFilters();
    var variable = document.getElementById('comp-var').value;

    resultEl.style.display = 'block';
    resultEl.innerHTML = _hurricaneLoadingHTML('Computing composite Z-score anomaly (per-case anomaly \u2192 average)\u2026', true);

    var qs = _compositeQueryString(filters) + '&variable=' + encodeURIComponent(variable) +
             '&data_type=merge';

    _fetchCompositeStream(API_BASE + '/composite/anomaly_azimuthal_mean?' + qs, 'Computing composite anomaly')
        .then(function(json) {
            _showCompStatus('success', '\u2713 Composite anomaly computed: ' + json.n_cases + ' cases');
            _updateBadgeFromResult(json.n_cases);
            renderCompositeAnomalyInto('comp-result-anom', json, filters);
        })
        .catch(function(err) {
            resultEl.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (err.message || String(err)) + '</div>';
        });
}

function generateCompDiffAnomaly() {
    var resultEl = document.getElementById('comp-result-anom');
    var dataType = document.getElementById('comp-dtype').value;
    if (dataType !== 'merge') {
        resultEl.style.display = 'block';
        resultEl.innerHTML = '<div class="explorer-status" style="color:#fbbf24;padding:12px;font-size:12px;">\u26A0\uFE0F Anomaly composites are only available for merged analyses. Switch data type to "Merge".</div>';
        return Promise.resolve();
    }

    var filtersA = _getCompositeFilters();
    var filtersB = _getCompGroupBFilters();
    var variable = document.getElementById('comp-var').value;

    resultEl.style.display = 'block';
    resultEl.innerHTML = _hurricaneLoadingHTML('Computing difference anomaly composite (A\u2212B)\u2026', true);

    var baseQS = '&variable=' + encodeURIComponent(variable) + '&data_type=merge';
    var urlA = API_BASE + '/composite/anomaly_azimuthal_mean?' + _compositeQueryString(filtersA) + baseQS;
    var urlB = API_BASE + '/composite/anomaly_azimuthal_mean?' + _compositeQueryString(filtersB) + baseQS;

    var jsonA;
    return _fetchCompositeStream(urlA, 'Group A anomaly').then(function(result) {
        jsonA = result;
        _showCompStatus('loading', 'Group A done (' + jsonA.n_cases + ' cases). Computing Group B\u2026');
        return _fetchCompositeStream(urlB, 'Group B anomaly');
    }).then(function(jsonB) {
        var diffData = _subtractArrays2D(jsonA.anomaly, jsonB.anomaly);
        var symRange = _symmetricRange(diffData);

        var diffJson = {
            anomaly: diffData,
            r_h_axis: jsonA.r_h_axis,
            n_inner: jsonA.n_inner,
            height_km: jsonA.height_km,
            n_cases: jsonA.n_cases,
            case_list: jsonA.case_list,
            case_list_b: jsonB.case_list,
            _isDiff: true,
            _nA: jsonA.n_cases,
            _nB: jsonB.n_cases,
            _filtersA: filtersA,
            _filtersB: filtersB,
            variable: {
                key: jsonA.variable.key,
                display_name: '\u0394 ' + jsonA.variable.display_name,
                units: jsonA.variable.units,
                anomaly_units: '\u0394\u03c3',
                vmin: -symRange,
                vmax: symRange,
                colorscale: _DIFF_COLORSCALE,
            },
        };
        _showCompStatus('success', '\u2713 Difference anomaly: ' + jsonA.n_cases + ' (A) \u2212 ' + jsonB.n_cases + ' (B)');
        _updateBadgeFromResult(jsonA.n_cases);
        _renderDiffAnomaly('comp-result-anom', diffJson, jsonA, jsonB, filtersA, filtersB);
    }).catch(function(err) {
        resultEl.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (err.message || String(err)) + '</div>';
    });
}

function renderCompositeAnomalyInto(targetId, json, filters) {
    var el = document.getElementById(targetId); if (!el) return;

    if (!json.anomaly) {
        el.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F Anomaly data unavailable.</div>';
        return;
    }

    var anomData = json.anomaly, rHAxis = json.r_h_axis, nInner = json.n_inner;
    var height_km = json.height_km, varInfo = json.variable;
    var isDiff = !!json._isDiff;

    var fontSize = { title:14, axis:12, tick:10, cbar:12, cbarTick:10 };

    var xIdxArr = []; for (var i = 0; i < rHAxis.length; i++) xIdxArr.push(i);
    var ticks = _buildHybridXAxis(rHAxis, nInner);

    var zmin = varInfo.vmin != null ? varInfo.vmin : -3;
    var zmax = varInfo.vmax != null ? varInfo.vmax : 3;
    var cbarTitle = isDiff ? '\u0394\u03c3' : '\u03c3';
    var anomColorscale = varInfo.colorscale || [
        [0.0, 'rgb(5,48,97)'], [0.1, 'rgb(33,102,172)'],
        [0.2, 'rgb(67,147,195)'], [0.3, 'rgb(146,197,222)'],
        [0.4, 'rgb(209,229,240)'], [0.5, 'rgb(247,247,247)'],
        [0.6, 'rgb(253,219,199)'], [0.7, 'rgb(244,165,130)'],
        [0.8, 'rgb(214,96,77)'], [0.9, 'rgb(178,24,43)'],
        [1.0, 'rgb(103,0,31)']
    ];

    var heatmap = {
        z: anomData, x: xIdxArr, y: height_km, type: 'heatmap',
        colorscale: anomColorscale, zmin: zmin, zmax: zmax, zmid: 0,
        colorbar: {
            title: { text: cbarTitle, font: { color: '#ccc', size: fontSize.cbar } },
            tickfont: { color: '#ccc', size: fontSize.cbarTick },
            thickness: 14, len: 0.85,
        },
        hoverongaps: false,
        hovertemplate: '<b>Z-score</b>: %{z:.2f}\u03c3<br>R\u2095: %{customdata}<br>Height: %{y:.1f} km<extra></extra>',
        customdata: height_km.map(function() { return rHAxis.map(function(v, idx) { return idx < nInner ? (v.toFixed(2) + ' R/RMW') : ('+' + v.toFixed(0) + ' km'); }); })
    };

    var dtypeLabel = ' (Merge)';
    var meanVmax = _computeCompositeMeanVmax(filters);
    var vmaxNote = meanVmax !== null ? ' | Mean V<sub>max</sub>=' + meanVmax + ' kt' : '';
    var nLabel;
    if (isDiff) {
        nLabel = 'Composite \u0394Anomaly (N=' + json._nA + ' \u2212 ' + json._nB + ')';
    } else {
        nLabel = _compositeFilterSummary(filters, json.n_cases);
    }
    var title = nLabel + vmaxNote +
                '<br>Z-score Anomaly: ' + (isDiff ? '\u0394 ' : '') + varInfo.display_name + dtypeLabel;

    var shapes = [{
        type: 'line', xref: 'x', yref: 'paper',
        x0: nInner, x1: nInner, y0: 0, y1: 1,
        line: { color: 'rgba(255,255,255,0.5)', width: 1.5, dash: 'dash' }
    }];

    var plotBg = '#0a1628';
    var layout = {
        title: { text: title, font: { color: '#e5e7eb', size: fontSize.title }, y: 0.97, x: 0.5, xanchor: 'center' },
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        xaxis: { title: { text: 'R\u2095 (RMW + km)', font: { color: '#aaa', size: fontSize.axis } },
                 tickvals: ticks.tickvals, ticktext: ticks.ticktext,
                 tickfont: { color: '#aaa', size: fontSize.tick },
                 gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
        yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } },
                 tickfont: { color: '#aaa', size: fontSize.tick },
                 gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
        margin: { l: 55, r: 24, t: 156, b: 46 },
        shapes: shapes, showlegend: false,
        annotations: [_fischerCitation]
    };

    el.style.display = 'block';
    _lastCompJson = json; _lastCompType = 'anom';
    _registerShadingTargets('shd-anom', ['comp-anom-chart'], anomColorscale, zmin, zmax);
    el.innerHTML = '<div id="comp-anom-chart" style="width:100%;height:560px;border-radius:8px;overflow:hidden;"></div>' + _buildShadingControlsRow('shd-anom', {defaultVmin: zmin, defaultVmax: zmax}) + _buildCompToolbar();
    Plotly.newPlot('comp-anom-chart', [heatmap], layout, { responsive: true, displayModeBar: true, displaylogo: false });
}

function _renderDiffAnomaly(targetId, diffJson, jsonA, jsonB, filtersA, filtersB) {
    var el = document.getElementById(targetId); if (!el) return;
    el.style.display = 'block';
    _lastCompJson = diffJson; _lastCompType = 'anom';

    // Create 3 stacked chart containers + toolbar
    el.innerHTML =
        '<div style="margin-bottom:4px;padding:6px 10px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#60a5fa;">\uD83D\uDD35 Group A</div>' +
        '<div id="comp-diff-anom-a" style="width:100%;height:460px;border-radius:8px;overflow:hidden;"></div>' +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#f59e0b;">\uD83D\uDFE0 Group B</div>' +
        '<div id="comp-diff-anom-b" style="width:100%;height:460px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-danom-ab', {label: 'Panels A &amp; B', defaultVmin: -3, defaultVmax: 3}) +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#ef4444;">\u0394 Difference (A \u2212 B)</div>' +
        '<div id="comp-diff-anom-d" style="width:100%;height:460px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-danom-d', {label: 'Difference', defaultVmin: diffJson.variable.vmin, defaultVmax: diffJson.variable.vmax}) +
        _buildCompToolbar();

    _registerShadingTargets('shd-danom-ab', ['comp-diff-anom-a', 'comp-diff-anom-b'], jsonA.variable.colorscale || [
        [0.0,'rgb(5,48,97)'],[0.1,'rgb(33,102,172)'],[0.2,'rgb(67,147,195)'],[0.3,'rgb(146,197,222)'],
        [0.4,'rgb(209,229,240)'],[0.5,'rgb(247,247,247)'],[0.6,'rgb(253,219,199)'],
        [0.7,'rgb(244,165,130)'],[0.8,'rgb(214,96,77)'],[0.9,'rgb(178,24,43)'],[1.0,'rgb(103,0,31)']
    ], -3, 3);

    var plotOpts = { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] };
    var plotBg = '#0a1628';
    var rHAxis = jsonA.r_h_axis, nInner = jsonA.n_inner, height_km = jsonA.height_km;
    var xIdxArr = []; for (var i = 0; i < rHAxis.length; i++) xIdxArr.push(i);
    var ticks = _buildHybridXAxis(rHAxis, nInner);
    var fontSize = { title:13, axis:11, tick:10, cbar:11, cbarTick:10, hover:12 };
    var rmwShape = [{ type:'line', xref:'x', yref:'paper', x0:nInner, x1:nInner, y0:0, y1:1, line:{ color:'rgba(255,255,255,0.5)', width:1.5, dash:'dash' } }];

    // RdBu_r for individual group anomalies
    var anomColorscale = jsonA.variable.colorscale || [
        [0.0,'rgb(5,48,97)'],[0.1,'rgb(33,102,172)'],[0.2,'rgb(67,147,195)'],[0.3,'rgb(146,197,222)'],
        [0.4,'rgb(209,229,240)'],[0.5,'rgb(247,247,247)'],[0.6,'rgb(253,219,199)'],
        [0.7,'rgb(244,165,130)'],[0.8,'rgb(214,96,77)'],[0.9,'rgb(178,24,43)'],[1.0,'rgb(103,0,31)']
    ];

    // Helper to build one anomaly heatmap panel
    function buildAnomPlot(chartId, anomData, titleText, colorscale, zmin, zmax, cbarLabel) {
        var hm = {
            z: anomData, x: xIdxArr, y: height_km, type: 'heatmap',
            colorscale: colorscale, zmin: zmin, zmax: zmax, zmid: 0,
            colorbar: { title:{text:cbarLabel,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:14, len:0.85 },
            hovertemplate: '<b>Z-score</b>: %{z:.2f}\u03c3<br>R\u2095: %{customdata}<br>Height: %{y:.1f} km<extra></extra>',
        customdata: height_km.map(function() { return rHAxis.map(function(v, idx) { return idx < nInner ? (v.toFixed(2) + ' R/RMW') : ('+' + v.toFixed(0) + ' km'); }); }),
            hoverongaps: false
        };
        var layout = {
            title: { text:titleText, font:{color:'#e5e7eb',size:fontSize.title}, y:0.97, x:0.5, xanchor:'center' },
            paper_bgcolor:plotBg, plot_bgcolor:plotBg,
            xaxis: { title:{text:'R\u2095 (RMW + km)',font:{color:'#aaa',size:fontSize.axis}},
                     tickvals:ticks.tickvals, ticktext:ticks.ticktext,
                     tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
            yaxis: { title:{text:'Height (km)',font:{color:'#aaa',size:fontSize.axis}}, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
            margin:{ l:55, r:24, t:116, b:42 }, shapes:rmwShape,
            hoverlabel:{ bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
            showlegend:false, annotations:[_fischerCitation]
        };
        Plotly.newPlot(chartId, [hm], layout, plotOpts);
    }

    // Group A
    var meanVmaxA = _computeCompositeMeanVmax(filtersA);
    var vmaxNoteA = meanVmaxA !== null ? ' | Mean V<sub>max</sub>=' + meanVmaxA + ' kt' : '';
    var titleA = _compositeFilterSummary(filtersA, jsonA.n_cases) + vmaxNoteA +
                 '<br>Z-score Anomaly: ' + jsonA.variable.display_name + ' (Merge)';
    buildAnomPlot('comp-diff-anom-a', jsonA.anomaly, titleA, anomColorscale, -3, 3, '\u03c3');

    // Group B
    var meanVmaxB = _computeCompositeMeanVmax(filtersB);
    var vmaxNoteB = meanVmaxB !== null ? ' | Mean V<sub>max</sub>=' + meanVmaxB + ' kt' : '';
    var titleB = _compositeFilterSummary(filtersB, jsonB.n_cases) + vmaxNoteB +
                 '<br>Z-score Anomaly: ' + jsonB.variable.display_name + ' (Merge)';
    buildAnomPlot('comp-diff-anom-b', jsonB.anomaly, titleB, anomColorscale, -3, 3, '\u03c3');

    // Difference
    var diffVarInfo = diffJson.variable;
    var diffVmaxNote = '';
    if (meanVmaxA !== null || meanVmaxB !== null) {
        diffVmaxNote = ' | V\u0305<sub>max</sub>: ';
        if (meanVmaxA !== null) diffVmaxNote += '<span style="color:#60a5fa;">A=' + meanVmaxA + '</span>';
        if (meanVmaxA !== null && meanVmaxB !== null) diffVmaxNote += ', ';
        if (meanVmaxB !== null) diffVmaxNote += '<span style="color:#f59e0b;">B=' + meanVmaxB + '</span> kt';
    }
    var titleD = _diffFilterSummary(filtersA, filtersB, jsonA.n_cases, jsonB.n_cases) + diffVmaxNote +
                 '<br>\u0394 Z-score Anomaly: ' + jsonA.variable.display_name + ' (Merge)';

    _registerShadingTargets('shd-danom-d', ['comp-diff-anom-d'], _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax);
    buildAnomPlot('comp-diff-anom-d', diffJson.anomaly, titleD, _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax, '\u0394\u03c3');
}

function generateCompositeVPScatter() {
    var resultEl = document.getElementById('comp-result-vpsc');
    resultEl.style.display = 'block';
    resultEl.innerHTML = _hurricaneLoadingHTML('Loading VP scatter data\u2026', true);

    fetch(API_BASE + '/scatter/vp_favorability?data_type=merge&color_by=dvmax_12h')
        .then(function(r) {
            if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); });
            return r.json();
        })
        .then(function(json) {
            resultEl.innerHTML = '<div id="comp-vpsc-chart" style="width:100%;height:500px;border-radius:8px;overflow:hidden;"></div>' +
                '<div style="display:flex;gap:6px;justify-content:center;margin-top:6px;">' +
                '<button class="cs-btn" onclick="reloadCompVPScatter(\'dvmax_12h\')" style="font-size:10px;padding:2px 8px;">12-h \u0394Vmax</button>' +
                '<button class="cs-btn" onclick="reloadCompVPScatter(\'dvmax_24h\')" style="font-size:10px;padding:2px 8px;">24-h \u0394Vmax</button>' +
                '</div>';
            renderVPScatterInto('comp-vpsc-chart', json, true);
        })
        .catch(function(err) {
            resultEl.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (err.message || String(err)) + '</div>';
        });
}

function reloadCompVPScatter(colorBy) {
    var resultEl = document.getElementById('comp-result-vpsc');
    if (!resultEl) return;
    resultEl.innerHTML = _hurricaneLoadingHTML('Reloading VP scatter\u2026', true);
    fetch(API_BASE + '/scatter/vp_favorability?data_type=merge&color_by=' + colorBy)
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(json) {
            resultEl.innerHTML = '<div id="comp-vpsc-chart" style="width:100%;height:500px;border-radius:8px;overflow:hidden;"></div>' +
                '<div style="display:flex;gap:6px;justify-content:center;margin-top:6px;">' +
                '<button class="cs-btn" onclick="reloadCompVPScatter(\'dvmax_12h\')" style="font-size:10px;padding:2px 8px;">12-h \u0394Vmax</button>' +
                '<button class="cs-btn" onclick="reloadCompVPScatter(\'dvmax_24h\')" style="font-size:10px;padding:2px 8px;">24-h \u0394Vmax</button>' +
                '</div>';
            renderVPScatterInto('comp-vpsc-chart', json, true);
        })
        .catch(function(err) {
            resultEl.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + err.message + '</div>';
        });
}


// ── CFAD helper functions ──

function _cfadUpdateRadiusUnit() {
    var unitEl = document.getElementById('cfad-radius-unit');
    var useRmw = document.getElementById('cfad-use-rmw');
    if (unitEl && useRmw) {
        unitEl.textContent = useRmw.checked ? 'R/RMW' : 'km';
    }
}

function _cfadToggleQuad(btn) {
    var quad = btn.getAttribute('data-quad');
    var allBtns = document.querySelectorAll('#cfad-quad-btns .cfad-quad-btn');
    var activeStyle = 'padding:4px 10px;font-size:10px;font-weight:600;border:1px solid rgba(34,211,238,0.3);border-radius:4px;background:rgba(34,211,238,0.15);color:#22d3ee;cursor:pointer;font-family:\'JetBrains Mono\',monospace;';
    var inactiveStyle = 'padding:4px 10px;font-size:10px;font-weight:600;border:1px solid rgba(255,255,255,0.1);border-radius:4px;background:rgba(255,255,255,0.03);color:#9ca3af;cursor:pointer;font-family:\'JetBrains Mono\',monospace;';

    if (quad === 'ALL' || quad === 'MULTI') {
        // "All" and "Multi" are exclusive — deselect everything else, activate this one
        allBtns.forEach(function(b) {
            var match = b.getAttribute('data-quad') === quad;
            b.classList.toggle('active', match);
            b.style.cssText = match ? activeStyle : inactiveStyle;
        });
    } else {
        // Deselect "All" and "Multi" if either is active
        allBtns.forEach(function(b) {
            var d = b.getAttribute('data-quad');
            if ((d === 'ALL' || d === 'MULTI') && b.classList.contains('active')) {
                b.classList.remove('active');
                b.style.cssText = inactiveStyle;
            }
        });
        // Toggle this quadrant
        var isActive = btn.classList.toggle('active');
        btn.style.cssText = isActive ? activeStyle : inactiveStyle;
        // If no quadrants are selected, re-activate "All"
        var anyActive = document.querySelector('#cfad-quad-btns .cfad-quad-btn.active:not([data-quad="ALL"]):not([data-quad="MULTI"])');
        if (!anyActive) {
            var allBtn = document.querySelector('#cfad-quad-btns .cfad-quad-btn[data-quad="ALL"]');
            if (allBtn) {
                allBtn.classList.add('active');
                allBtn.style.cssText = activeStyle;
            }
        }
    }
}

function _cfadGetSelectedQuadrants() {
    var multiBtn = document.querySelector('#cfad-quad-btns .cfad-quad-btn.active[data-quad="MULTI"]');
    if (multiBtn) return ['MULTI'];
    var allBtn = document.querySelector('#cfad-quad-btns .cfad-quad-btn.active[data-quad="ALL"]');
    if (allBtn) return [];  // empty = all azimuths
    var selected = [];
    document.querySelectorAll('#cfad-quad-btns .cfad-quad-btn.active').forEach(function(b) {
        selected.push(b.getAttribute('data-quad'));
    });
    return selected;
}

function generateCompositeCFAD() {
    var filters = _getCompositeFilters();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    _ga('composite_cfad', { variable: variable, data_type: dataType });
    var _crp = document.getElementById('comp-result-placeholder') || document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing CFAD \u2014 this may take 30\u201390 seconds for many cases\u2026');

    // Gather CFAD-specific options
    var binWidth = parseFloat((document.getElementById('cfad-bin-width') || {}).value) || 0;
    var nBins = parseInt((document.getElementById('cfad-n-bins') || {}).value, 10) || 20;
    var binMinVal = (document.getElementById('cfad-bin-min') || {}).value;
    var binMaxVal = (document.getElementById('cfad-bin-max') || {}).value;
    var normalise = (document.getElementById('cfad-normalise') || {}).value || 'height';
    var minRadius = parseFloat((document.getElementById('cfad-min-radius') || {}).value) || 0;
    var maxRadius = parseFloat((document.getElementById('cfad-max-radius') || {}).value) || 200;
    var useRmw = !!(document.getElementById('cfad-use-rmw') || {}).checked;
    var quadrants = _cfadGetSelectedQuadrants();
    var isMulti = quadrants.length === 1 && quadrants[0] === 'MULTI';

    var qs = _compositeQueryString(filters) + '&variable=' + encodeURIComponent(variable) + '&data_type=' + dataType +
        '&min_radius=' + minRadius + '&max_radius=' + maxRadius + '&normalise=' + encodeURIComponent(normalise) +
        '&n_bins=' + nBins;
    if (useRmw) qs += '&use_rmw=true';
    if (binWidth > 0) qs += '&bin_width=' + binWidth;
    if (binMinVal !== '' && binMinVal !== undefined && !isNaN(parseFloat(binMinVal))) qs += '&bin_min=' + parseFloat(binMinVal);
    if (binMaxVal !== '' && binMaxVal !== undefined && !isNaN(parseFloat(binMaxVal))) qs += '&bin_max=' + parseFloat(binMaxVal);
    if (isMulti) {
        qs += '&quadrants=MULTI';
    } else if (quadrants.length > 0) {
        qs += '&quadrants=' + encodeURIComponent(quadrants.join(','));
    }

    _fetchCompositeStream(API_BASE + '/composite/cfad?' + qs, 'Computing CFAD')
        .then(function(json) {
            _showCompStatus('success', '\u2713 CFAD computed: ' + json.n_cases + ' cases processed');
            _updateBadgeFromResult(json.n_cases);
            if (json.multi) {
                renderCompositeCFADMultiInto('comp-result-cfad', json, filters);
            } else {
                renderCompositeCFADInto('comp-result-cfad', json, filters);
            }
        })
        .catch(function(err) { _showCompStatus('error', '\u2717 ' + (err.message || String(err))); });
}

function renderCompositeCFADInto(targetId, json, filters) {
    var el = document.getElementById(targetId); if (!el) return;
    var cfadData = json.cfad;
    var binCenters = json.bin_centers;
    var heightKm = json.height_km;
    var varInfo = json.variable;
    var normLabel = json.norm_label;

    var fontSize = { title:14, axis:12, tick:10, cbar:12, cbarTick:10, hover:13 };

    // Check if log scale is requested
    var useLog = !!(document.getElementById('cfad-log-scale') || {}).checked;

    // CFAD colorscale — Spectral_r from the backend (matplotlib), with fallback
    var cfadColorscale = json.cfad_colorscale || 'RdYlBu';

    // Find the actual min (non-zero) and max for colorbar scaling
    var zMax = 0, zMinPos = Infinity;
    for (var h = 0; h < cfadData.length; h++) {
        for (var b = 0; b < cfadData[h].length; b++) {
            var v = cfadData[h][b];
            if (v !== null && v > zMax) zMax = v;
            if (v !== null && v > 0 && v < zMinPos) zMinPos = v;
        }
    }
    if (zMax === 0) zMax = 1;
    if (zMinPos === Infinity) zMinPos = 0.001;

    // Apply log10 transform if requested
    var plotData, plotZmin, plotZmax, cbarTitle, hoverSuffix;
    if (useLog && zMax > 0) {
        // Log10 transform: replace 0/null with NaN so they render as gaps
        plotData = [];
        for (var h2 = 0; h2 < cfadData.length; h2++) {
            var row = [];
            for (var b2 = 0; b2 < cfadData[h2].length; b2++) {
                var val = cfadData[h2][b2];
                if (val === null || val <= 0) {
                    row.push(null);
                } else {
                    row.push(Math.log10(val));
                }
            }
            plotData.push(row);
        }
        plotZmin = Math.log10(Math.max(zMinPos * 0.5, 1e-6));
        plotZmax = Math.log10(zMax);

        // Build custom tick values for the colorbar in log space
        var tickVals = [], tickText = [];
        // Generate nice tick labels spanning the log range
        var logMin = Math.floor(plotZmin), logMax = Math.ceil(plotZmax);
        for (var p = logMin; p <= logMax; p++) {
            var tv = Math.pow(10, p);
            tickVals.push(p);
            if (normLabel === 'count') {
                tickText.push(tv >= 1 ? String(Math.round(tv)) : tv.toExponential(0));
            } else {
                // Percentage labels
                if (tv >= 1) tickText.push(tv.toFixed(0) + '%');
                else if (tv >= 0.1) tickText.push(tv.toFixed(1) + '%');
                else if (tv >= 0.01) tickText.push(tv.toFixed(2) + '%');
                else tickText.push(tv.toExponential(0) + '%');
            }
        }
        cbarTitle = normLabel + ' (log\u2081\u2080)';
        hoverSuffix = normLabel;
    } else {
        plotData = cfadData;
        plotZmin = 0;
        plotZmax = zMax;
        cbarTitle = normLabel;
        hoverSuffix = normLabel;
    }

    var colorbar = {
        title: { text: cbarTitle, font: { color:'#ccc', size:fontSize.cbar } },
        tickfont: { color:'#ccc', size:fontSize.cbarTick },
        thickness:14, len:0.85
    };
    if (useLog && typeof tickVals !== 'undefined' && tickVals.length > 0) {
        colorbar.tickvals = tickVals;
        colorbar.ticktext = tickText;
    }

    // Custom hovertemplate: show original (non-log) value on hover
    var customData = null;
    if (useLog) {
        // Store original values in customdata for hover
        customData = cfadData;
    }
    var heatmap = {
        z: plotData, x: binCenters, y: heightKm, type: 'heatmap',
        colorscale: cfadColorscale, zmin: plotZmin, zmax: plotZmax,
        colorbar: colorbar,
        hoverongaps: false
    };
    if (useLog && customData) {
        heatmap.customdata = customData;
        heatmap.hovertemplate = '<b>' + varInfo.display_name + '</b>: %{x:.1f} ' + varInfo.units +
            '<br>Height: %{y:.1f} km<br>Frequency: %{customdata:.3f} ' + hoverSuffix + '<extra></extra>';
    } else {
        heatmap.hovertemplate = '<b>' + varInfo.display_name + '</b>: %{x:.1f} ' + varInfo.units +
            '<br>Height: %{y:.1f} km<br>Frequency: %{z:.2f} ' + hoverSuffix + '<extra></extra>';
    }

    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var meanVmax = _computeCompositeMeanVmax(filters);
    var vmaxNote = meanVmax !== null ? ' | Mean V<sub>max</sub>=' + meanVmax + ' kt' : '';
    var binNote = ' | Bin=' + json.bin_width + ' ' + varInfo.units;
    var radialNote = '';
    if (json.radial_domain) {
        var rUnit = json.use_rmw ? ' R/RMW' : ' km';
        radialNote = ' | R=' + json.radial_domain[0] + '\u2013' + json.radial_domain[1] + rUnit;
    }
    var quadNote = '';
    if (json.quadrants && json.quadrants.length > 0) {
        quadNote = ' | ' + json.quadrants.join('+');
    }
    var title = _compositeFilterSummary(filters, json.n_cases) + vmaxNote +
        '<br>CFAD: ' + varInfo.display_name + dtypeLabel + binNote + radialNote + quadNote +
        ' | ' + normLabel + (useLog ? ' (log)' : '');

    var plotBg = '#0a1628';
    var layout = {
        title: { text: title, font: { color:'#e5e7eb', size:fontSize.title }, y:0.97, x:0.5, xanchor:'center' },
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        xaxis: { title: { text: varInfo.display_name + ' (' + varInfo.units + ')', font:{color:'#aaa',size:fontSize.axis} }, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
        yaxis: { title: { text:'Height (km)', font:{color:'#aaa',size:fontSize.axis} }, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
        margin: { l:55, r:24, t:156, b:50 },
        hoverlabel: { bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
        showlegend: false
    };

    el.style.display = 'block';
    _lastCompJson = json; _lastCompType = 'cfad';
    _registerShadingTargets('shd-cfad', ['comp-cfad-chart'], cfadColorscale, plotZmin, plotZmax);
    el.innerHTML = '<div id="comp-cfad-chart" style="width:100%;height:560px;border-radius:8px;overflow:hidden;"></div>' + _buildShadingControlsRow('shd-cfad', {defaultVmin: plotZmin, defaultVmax: plotZmax}) + _buildCompToolbar();
    Plotly.newPlot('comp-cfad-chart', [heatmap], layout, { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
}

function renderCompositeCFADMultiInto(targetId, json, filters) {
    var el = document.getElementById(targetId); if (!el) return;
    var cfadMulti = json.cfad_multi;
    var binCenters = json.bin_centers;
    var heightKm = json.height_km;
    var varInfo = json.variable;
    var normLabel = json.norm_label;
    var cfadColorscale = json.cfad_colorscale || 'RdYlBu';

    var useLog = !!(document.getElementById('cfad-log-scale') || {}).checked;
    var fontSize = { title:13, axis:11, tick:9, cbar:11, cbarTick:9, hover:12 };

    // Quadrant layout: 2x2 grid — shear vector points right
    // Top row: USL (left), DSL (right)  |  Bottom row: USR (left), DSR (right)
    var quadOrder = ['USL', 'DSL', 'USR', 'DSR'];
    var quadLabels = { 'USL': 'Upshear Left', 'USR': 'Upshear Right', 'DSL': 'Downshear Left', 'DSR': 'Downshear Right' };

    // Find global min/max across all quadrants for consistent color scaling
    var gZmax = 0, gZminPos = Infinity;
    for (var qi = 0; qi < quadOrder.length; qi++) {
        var qname = quadOrder[qi];
        var qdata = cfadMulti[qname];
        if (!qdata) continue;
        for (var h = 0; h < qdata.length; h++) {
            for (var b = 0; b < qdata[h].length; b++) {
                var v = qdata[h][b];
                if (v !== null && v > gZmax) gZmax = v;
                if (v !== null && v > 0 && v < gZminPos) gZminPos = v;
            }
        }
    }
    if (gZmax === 0) gZmax = 1;
    if (gZminPos === Infinity) gZminPos = 0.001;

    // Determine shared z-range
    var plotZmin, plotZmax, cbarTitle, hoverSuffix;
    var tickVals = [], tickText = [];
    if (useLog && gZmax > 0) {
        plotZmin = Math.log10(Math.max(gZminPos * 0.5, 1e-6));
        plotZmax = Math.log10(gZmax);
        var logMin = Math.floor(plotZmin), logMax = Math.ceil(plotZmax);
        for (var p = logMin; p <= logMax; p++) {
            var tv = Math.pow(10, p);
            tickVals.push(p);
            if (normLabel === 'count') {
                tickText.push(tv >= 1 ? String(Math.round(tv)) : tv.toExponential(0));
            } else {
                if (tv >= 1) tickText.push(tv.toFixed(0) + '%');
                else if (tv >= 0.1) tickText.push(tv.toFixed(1) + '%');
                else if (tv >= 0.01) tickText.push(tv.toFixed(2) + '%');
                else tickText.push(tv.toExponential(0) + '%');
            }
        }
        cbarTitle = normLabel + ' (log\u2081\u2080)';
        hoverSuffix = normLabel;
    } else {
        plotZmin = 0;
        plotZmax = gZmax;
        cbarTitle = normLabel;
        hoverSuffix = normLabel;
    }

    // Build 4 heatmap traces for subplots
    var traces = [];
    var annotations = [];
    for (var si = 0; si < quadOrder.length; si++) {
        var qn = quadOrder[si];
        var rawData = cfadMulti[qn];
        if (!rawData) continue;

        var plotData, customData = null;
        if (useLog && gZmax > 0) {
            plotData = [];
            customData = rawData;
            for (var rh = 0; rh < rawData.length; rh++) {
                var row = [];
                for (var rb = 0; rb < rawData[rh].length; rb++) {
                    var val = rawData[rh][rb];
                    row.push((val === null || val <= 0) ? null : Math.log10(val));
                }
                plotData.push(row);
            }
        } else {
            plotData = rawData;
        }

        var xRef = 'x' + (si === 0 ? '' : String(si + 1));
        var yRef = 'y' + (si === 0 ? '' : String(si + 1));
        var showCbar = (si === 1);  // show colorbar on top-right panel only

        var colorbar = showCbar ? {
            title: { text: cbarTitle, font: { color:'#ccc', size:fontSize.cbar } },
            tickfont: { color:'#ccc', size:fontSize.cbarTick },
            thickness: 12, len: 0.9, x: 1.02
        } : null;
        if (showCbar && useLog && tickVals.length > 0) {
            colorbar.tickvals = tickVals;
            colorbar.ticktext = tickText;
        }

        var trace = {
            z: plotData, x: binCenters, y: heightKm, type: 'heatmap',
            colorscale: cfadColorscale, zmin: plotZmin, zmax: plotZmax,
            xaxis: xRef, yaxis: yRef,
            showscale: showCbar, hoverongaps: false
        };
        if (showCbar && colorbar) trace.colorbar = colorbar;
        if (useLog && customData) {
            trace.customdata = customData;
            trace.hovertemplate = '<b>' + quadLabels[qn] + '</b><br>' + varInfo.display_name + ': %{x:.1f} ' + varInfo.units +
                '<br>Height: %{y:.1f} km<br>Frequency: %{customdata:.3f} ' + hoverSuffix + '<extra></extra>';
        } else {
            trace.hovertemplate = '<b>' + quadLabels[qn] + '</b><br>' + varInfo.display_name + ': %{x:.1f} ' + varInfo.units +
                '<br>Height: %{y:.1f} km<br>Frequency: %{z:.2f} ' + hoverSuffix + '<extra></extra>';
        }
        traces.push(trace);

        // Add annotation for quadrant label
        var row2 = si < 2 ? 0 : 1;
        var col2 = si % 2;
        annotations.push({
            text: '<b>' + quadLabels[qn] + '</b>',
            xref: xRef.replace('x', 'x') + ' domain',
            yref: yRef.replace('y', 'y') + ' domain',
            x: 0.5, y: 1.08, showarrow: false,
            font: { size: 12, color: '#e5e7eb' },
            xanchor: 'center', yanchor: 'bottom'
        });
    }

    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var meanVmax = _computeCompositeMeanVmax(filters);
    var vmaxNote = meanVmax !== null ? ' | Mean V<sub>max</sub>=' + meanVmax + ' kt' : '';
    var binNote = ' | Bin=' + json.bin_width + ' ' + varInfo.units;
    var radialNote = '';
    if (json.radial_domain) {
        var rUnit = json.use_rmw ? ' R/RMW' : ' km';
        radialNote = ' | R=' + json.radial_domain[0] + '\u2013' + json.radial_domain[1] + rUnit;
    }
    var title = _compositeFilterSummary(filters, json.n_cases) + vmaxNote +
        '<br>CFAD: ' + varInfo.display_name + dtypeLabel + binNote + radialNote +
        ' | 4-Quadrant | ' + normLabel + (useLog ? ' (log)' : '');

    var plotBg = '#0a1628';
    var layout = {
        title: { text: title, font: { color:'#e5e7eb', size:fontSize.title }, y:0.98, x:0.5, xanchor:'center' },
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        grid: { rows: 2, columns: 2, pattern: 'independent', xgap: 0.08, ygap: 0.12 },
        annotations: annotations,
        margin: { l:55, r:60, t:140, b:50 },
        hoverlabel: { bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
        showlegend: false
    };

    // Configure each subplot axis
    var axNames = [['xaxis','yaxis'],['xaxis2','yaxis2'],['xaxis3','yaxis3'],['xaxis4','yaxis4']];
    for (var ai = 0; ai < axNames.length; ai++) {
        var xName = axNames[ai][0], yName = axNames[ai][1];
        var isBottom = ai >= 2, isLeft = ai % 2 === 0;
        layout[xName] = {
            title: isBottom ? { text: varInfo.display_name + ' (' + varInfo.units + ')', font:{color:'#aaa',size:fontSize.axis} } : undefined,
            tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false
        };
        layout[yName] = {
            title: isLeft ? { text:'Height (km)', font:{color:'#aaa',size:fontSize.axis} } : undefined,
            tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false
        };
    }

    el.style.display = 'block';
    _lastCompJson = json; _lastCompType = 'cfad_multi';
    _registerShadingTargets('shd-cfadm', ['comp-cfad-chart'], cfadColorscale, plotZmin, plotZmax);
    el.innerHTML = '<div id="comp-cfad-chart" style="width:100%;height:820px;border-radius:8px;overflow:hidden;"></div>' + _buildShadingControlsRow('shd-cfadm', {defaultVmin: plotZmin, defaultVmax: plotZmax}) + _buildCompToolbar();
    Plotly.newPlot('comp-cfad-chart', traces, layout, { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
}

function generateCompositeQuadMean() {
    var filters = _getCompositeFilters();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    _ga('composite_quad_mean', { variable: variable, data_type: dataType });
    var coverage = parseInt(document.getElementById('comp-coverage').value) / 100;
    var btnAz = document.getElementById('comp-btn-az'), btnSq = document.getElementById('comp-btn-sq'), btnPv = document.getElementById('comp-btn-pv');
    if (btnAz) if (btnAz) btnAz.disabled = true; if (btnSq) if (btnSq) btnSq.disabled = true; if (btnPv) if (btnPv) btnPv.disabled = true;
    if (btnSq) btnSq.textContent = '\u23F3 Computing\u2026';
    var _crp = document.getElementById('comp-result-placeholder') || document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing composite shear quadrants \u2014 this may take 30\u201390 seconds for many cases\u2026');

    var overlay = (document.getElementById('comp-overlay') || {}).value || '';
    // Quad endpoint always RMW-normalises, so always read user-specified radial settings
    var maxRRmw = parseFloat((document.getElementById('comp-max-r-rmw') || {}).value) || 5.0;
    var drRmw   = Math.max(0.05, parseFloat((document.getElementById('comp-dr-rmw') || {}).value) || 0.25);
    var qs = _compositeQueryString(filters) + '&variable=' + encodeURIComponent(variable) + '&data_type=' + dataType + '&coverage_min=' + coverage +
        '&max_r_rmw=' + maxRRmw + '&dr_rmw=' + drRmw;
    if (overlay) qs += '&overlay=' + encodeURIComponent(overlay);
    _fetchCompositeStream(API_BASE + '/composite/quadrant_mean?' + qs, 'Computing shear quadrants')
        .then(function(json) {
            _showCompStatus('success', '\u2713 Composite computed: ' + json.n_cases + ' cases processed (' + (json.n_with_shear_and_rmw || json.n_with_shear || '?') + ' with shear data)');
            _updateBadgeFromResult(json.n_cases);
            renderCompositeQuadMeanInto('comp-result-sq', json, filters);
            _showCompShadingToolbar();
            history.replaceState(null, '', '#' + _buildCompPermalinkHash());
        })
        .catch(function(err) { _showCompStatus('error', '\u2717 ' + (err.message || String(err))); })
        .finally(function() {
            if (btnAz) btnAz.disabled = false; if (btnSq) btnSq.disabled = false; if (btnPv) if (btnPv) btnPv.disabled = false;
            if (btnSq) btnSq.textContent = '\u25D1 Shear Quadrants';
        });
}

// ── Composite Plan-View ─────────────────────────────

function _getCompositePlanViewParams() {
    return {
        level_km:      parseFloat((document.getElementById('comp-level') || {}).value) || 2.0,
        normalize_rmw: !!(document.getElementById('comp-norm-rmw') || {}).checked,
        max_r_rmw:     parseFloat((document.getElementById('comp-max-r-rmw') || {}).value) || 5.0,
        dr_rmw:        parseFloat((document.getElementById('comp-dr-rmw') || {}).value) || 0.1,
        shear_relative: !!(document.getElementById('comp-shear-rel') || {}).checked,
    };
}

function generateCompositePlanView() {
    var filters = _getCompositeFilters();
    var pvParams = _getCompositePlanViewParams();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    _ga('composite_plan_view', { variable: variable, data_type: dataType });
    var coverage = parseInt(document.getElementById('comp-coverage').value) / 100;

    var btnPv = document.getElementById('comp-btn-pv');
    var btnAz = document.getElementById('comp-btn-az');
    var btnSq = document.getElementById('comp-btn-sq');
    if (btnPv) btnPv.disabled = true; if (btnAz) btnAz.disabled = true; if (btnSq) btnSq.disabled = true;
    if (btnPv) btnPv.textContent = '\u23F3 Computing\u2026';
    var _crp = document.getElementById('comp-result-placeholder') || document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing plan-view composite at ' + pvParams.level_km + ' km \u2014 this may take 30\u201390 seconds for many cases\u2026');

    var overlay = (document.getElementById('comp-overlay') || {}).value || '';
    var qs = _compositeQueryString(filters) +
        '&variable=' + encodeURIComponent(variable) +
        '&data_type=' + dataType +
        '&coverage_min=' + coverage +
        '&level_km=' + pvParams.level_km +
        '&normalize_rmw=' + (pvParams.normalize_rmw ? 'true' : 'false') +
        '&max_r_rmw=' + pvParams.max_r_rmw +
        '&dr_rmw=' + pvParams.dr_rmw +
        '&shear_relative=' + (pvParams.shear_relative ? 'true' : 'false');
    if (overlay) qs += '&overlay=' + encodeURIComponent(overlay);

    _fetchCompositeStream(API_BASE + '/composite/plan_view?' + qs, 'Computing plan-view composite at ' + pvParams.level_km + ' km')
        .then(function(json) {
            _showCompStatus('success', '\u2713 Plan-view composite computed: ' + json.n_cases + ' cases processed');
            _updateBadgeFromResult(json.n_cases);
            renderCompositePlanViewInto('comp-result-pv', json, filters, pvParams);
            _showCompShadingToolbar();
            history.replaceState(null, '', '#' + _buildCompPermalinkHash());
        })
        .catch(function(err) { _showCompStatus('error', '\u2717 ' + (err.message || String(err))); })
        .finally(function() {
            if (btnPv) btnPv.disabled = false; if (btnAz) btnAz.disabled = false; if (btnSq) btnSq.disabled = false;
            if (btnPv) btnPv.textContent = '\uD83D\uDDFA Plan View';
        });
}

function buildCompPlanViewOverlayContours(json, xAxis, yAxis) {
    if (!json.overlay || !json.overlay.plan_view) return [];
    var ov = json.overlay;
    var ovData = ov.plan_view;
    try {
        var interval = _compContourInterval(ovData);
        var baseContour = {
            z: ovData, x: xAxis, y: yAxis, type: 'contour',
            showscale: false, hoverongaps: false,
            contours: { coloring: 'none', showlabels: true,
                        labelfont: { size: 9, color: 'rgba(255,255,255,0.85)' } }
        };
        var traces = [];
        if (ov.vmax > interval) {
            traces.push(Object.assign({}, baseContour, {
                contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }),
                line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'solid' },
                hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>',
                name: ov.display_name + ' (+)', showlegend: false
            }));
        }
        if (ov.vmin < -interval) {
            traces.push(Object.assign({}, baseContour, {
                contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }),
                line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' },
                hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>',
                name: ov.display_name + ' (\u2212)', showlegend: false
            }));
        }
        return traces;
    } catch (e) { console.warn('Plan-view overlay error:', e); return []; }
}

function renderCompositePlanViewInto(targetId, json, filters, pvParams) {
    var el = document.getElementById(targetId); if (!el) return;
    var planData = json.plan_view;
    var xAxis = json.x_axis, yAxis = json.y_axis;
    var varInfo = json.variable;
    var xLabel = json.x_label, yLabel = json.y_label;
    var levelKm = json.level_km;

    var fontSize = { title:14, axis:12, tick:10, cbar:12, cbarTick:10, hover:13 };

    var heatmap = {
        z: planData, x: xAxis, y: yAxis, type: 'heatmap',
        colorscale: varInfo.colorscale, zmin: varInfo.vmin, zmax: varInfo.vmax,
        colorbar: { title: { text: varInfo.units, font: { color:'#ccc', size:fontSize.cbar } },
                    tickfont: { color:'#ccc', size:fontSize.cbarTick }, thickness:14, len:0.85 },
        hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units +
                       '<br>' + xLabel + ': %{x:.1f}<br>' + yLabel + ': %{y:.1f}<extra></extra>',
        hoverongaps: false
    };

    // Build title
    var normLabel = json.normalize_rmw ? ' (RMW-norm)' : '';
    var shearLabel = json.shear_relative ? ' [Shear \u2192 Right]' : '';
    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var meanVmax = _computeCompositeMeanVmax(filters);
    var vmaxNote = meanVmax !== null ? ' | Mean V<sub>max</sub>=' + meanVmax + ' kt' : '';
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    var title = _compositeFilterSummary(filters, json.n_cases) + vmaxNote +
                '<br>Plan View @ ' + levelKm + ' km: ' + varInfo.display_name + dtypeLabel + normLabel + shearLabel + overlayLabel;

    var plotBg = '#0a1628';
    var shapes = [];
    var annotations = [];

    // If RMW-normalised, draw a circle at R/RMW = 1
    if (json.normalize_rmw) {
        var nPts = 100;
        var circleX = [], circleY = [];
        for (var i = 0; i <= nPts; i++) {
            var angle = 2 * Math.PI * i / nPts;
            circleX.push(Math.cos(angle));
            circleY.push(Math.sin(angle));
        }
        // Add as a scatter trace (drawn after heatmap)
    }

    // Shear arrow annotation if shear-relative
    if (json.shear_relative) {
        var shearInset = buildShearInset(90, true);
        if (shearInset) {
            shapes = shapes.concat(shearInset.shapes || []);
            annotations = annotations.concat(shearInset.annotations || []);
        }
    }

    // Compute tight axis range from actual non-NaN data extent
    var ext = _tightDataExtent(planData, xAxis, yAxis, 0.25);
    var layout = {
        title: { text: title, font: { color:'#e5e7eb', size:fontSize.title }, y:0.97, x:0.5, xanchor:'center' },
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        xaxis: { title: { text:xLabel, font:{color:'#aaa',size:fontSize.axis} },
                 tickfont:{color:'#aaa',size:fontSize.tick},
                 gridcolor:'rgba(255,255,255,0.04)', zeroline:true,
                 zerolinecolor:'rgba(255,255,255,0.12)',
                 range:[ext.xMin, ext.xMax] },
        yaxis: { title: { text:yLabel, font:{color:'#aaa',size:fontSize.axis} },
                 tickfont:{color:'#aaa',size:fontSize.tick},
                 gridcolor:'rgba(255,255,255,0.04)', zeroline:true,
                 zerolinecolor:'rgba(255,255,255,0.12)',
                 scaleanchor:'x', scaleratio:1,
                 range:[ext.yMin, ext.yMax] },
        margin: { l:60, r:24, t: json.overlay ? 170 : 156, b:50 },
        shapes: shapes, annotations: annotations,
        hoverlabel: { bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
        showlegend: false
    };

    // Build overlay contours
    var pvOverlay = buildCompPlanViewOverlayContours(json, xAxis, yAxis);

    // Optional RMW circle trace
    var extraTraces = [];
    if (json.normalize_rmw) {
        var nPts2 = 120;
        var cx = [], cy = [];
        for (var j = 0; j <= nPts2; j++) {
            var a = 2 * Math.PI * j / nPts2;
            cx.push(parseFloat(Math.cos(a).toFixed(4)));
            cy.push(parseFloat(Math.sin(a).toFixed(4)));
        }
        extraTraces.push({
            x: cx, y: cy, type: 'scatter', mode: 'lines',
            line: { color: 'white', width: 1.5, dash: 'dash' },
            showlegend: false, hoverinfo: 'skip',
            name: 'RMW'
        });
    }

    el.style.display = 'block';
    _lastCompJson = json; _lastCompType = 'pv';
    _registerShadingTargets('shd-pv', ['comp-pv-chart'], varInfo.colorscale, varInfo.vmin, varInfo.vmax);
    el.innerHTML = '<div id="comp-pv-chart" style="width:100%;height:620px;border-radius:8px;overflow:hidden;"></div>' + _buildShadingControlsRow('shd-pv', {defaultVmin: varInfo.vmin, defaultVmax: varInfo.vmax}) + _buildCompToolbar();
    Plotly.newPlot('comp-pv-chart', [heatmap].concat(pvOverlay).concat(extraTraces), layout,
        { responsive:true, displayModeBar:true, displaylogo:false,
          modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
    // Apply user-specified range from Step 3 controls if set
    var _userVmin = _getCompVmin(null), _userVmax = _getCompVmax(null);
    if (_userVmin !== null && _userVmax !== null) {
        Plotly.restyle('comp-pv-chart', { zmin: [_userVmin], zmax: [_userVmax] }, [0]);
    }
}

// ── Composite Difference Mode ───────────────────────
var _groupBCountTimeout;

function _toggleDiffMode() {
    // Now handled by wizard mode cards (_wizardSetMode)
    // Keep as no-op for backward compatibility
    var on = _wizardMode === 'diff';
    if (on) _updateGroupBCount();
}

function _getCompGroupBFilters() {
    return {
        min_intensity:   parseFloat(document.getElementById('compb-int-min').value) || 0,
        max_intensity:   parseFloat(document.getElementById('compb-int-max').value) || 200,
        min_vmax_change: parseFloat(document.getElementById('compb-dv-min').value) || -100,
        max_vmax_change: parseFloat(document.getElementById('compb-dv-max').value) || 85,
        min_tilt:        parseFloat(document.getElementById('compb-tilt-min').value) || 0,
        max_tilt:        parseFloat(document.getElementById('compb-tilt-max').value) || 200,
        min_year:        parseInt(document.getElementById('compb-year-min').value) || 1997,
        max_year:        parseInt(document.getElementById('compb-year-max').value) || 2024,
        min_shear_mag:   parseFloat(document.getElementById('compb-shrmag-min').value) || 0,
        max_shear_mag:   parseFloat(document.getElementById('compb-shrmag-max').value) || 100,
        min_shear_dir:   parseFloat(document.getElementById('compb-shrdir-min').value) || 0,
        max_shear_dir:   parseFloat(document.getElementById('compb-shrdir-max').value) || 360,
        min_dtl:         parseFloat(document.getElementById('compb-dtl-min').value) || 0,
        dtl_window:      document.getElementById('compb-dtl-win').value || '24h',
    };
}

function _debouncedGroupBCount() {
    clearTimeout(_groupBCountTimeout);
    _groupBCountTimeout = setTimeout(_updateGroupBCount, 400);
}

function _updateGroupBCount() {
    var filters = _getCompGroupBFilters();
    var dataType = document.getElementById('comp-dtype').value || 'swath';
    var el = document.getElementById('compb-count-num');
    if (!el) return;
    el.textContent = '\u2026';
    fetch(API_BASE + '/composite/count?' + _compositeQueryString(filters) + '&data_type=' + dataType)
        .then(function(r) { return r.json(); })
        .then(function(json) {
            el.textContent = json.count;
            var capNote = document.getElementById('compb-cap-note');
            if (json.capped) {
                el.textContent = json.count + ' (max ' + json.max_cases + ')';
                el.style.color = '#fbbf24';
                el.title = 'Only the first ' + json.max_cases + ' cases will be composited.';
                if (capNote) { capNote.classList.add('capped'); capNote.textContent = 'Cap exceeded \u2014 only the first ' + json.max_cases + ' matching cases will be composited.'; }
            } else {
                el.style.color = '';
                el.title = '';
                if (capNote) { capNote.classList.remove('capped'); capNote.textContent = 'Composites are limited to ' + json.max_cases + ' cases per group.'; }
            }
            // Keep the summary badge in sync with the latest count
            _wizardUpdateSummary();
        })
        .catch(function() { el.textContent = '?'; });
}

function _subtractArrays2D(a, b) {
    // Element-wise a - b, preserving NaN where either is null/NaN
    var result = [];
    for (var r = 0; r < a.length; r++) {
        var row = [];
        for (var c = 0; c < a[r].length; c++) {
            var va = a[r][c], vb = b[r][c];
            if (va === null || va === undefined || vb === null || vb === undefined ||
                (typeof va === 'number' && isNaN(va)) || (typeof vb === 'number' && isNaN(vb))) {
                row.push(null);
            } else {
                row.push(va - vb);
            }
        }
        result.push(row);
    }
    return result;
}

function _symmetricRange(data2d) {
    var maxAbs = 0;
    for (var r = 0; r < data2d.length; r++) {
        for (var c = 0; c < data2d[r].length; c++) {
            var v = data2d[r][c];
            if (v !== null && v !== undefined && !isNaN(v)) {
                var av = Math.abs(v);
                if (av > maxAbs) maxAbs = av;
            }
        }
    }
    // Round up to a clean number
    if (maxAbs === 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(maxAbs)));
    return Math.ceil(maxAbs / mag) * mag;
}

// ---------------------------------------------------------------------------
// IR Satellite Composite generation & rendering
// ---------------------------------------------------------------------------

function _getIRCompositeParams() {
    var normRmw = !!(document.getElementById('ir-norm-rmw') || {}).checked;
    return {
        normalize_rmw: normRmw,
        max_r_rmw: normRmw ? (parseFloat((document.getElementById('ir-max-r-rmw') || {}).value) || 5.0) : 5.0,
        dr_rmw: normRmw ? Math.max(0.05, parseFloat((document.getElementById('ir-dr-rmw') || {}).value) || 0.1) : 0.1,
        shear_relative: !!(document.getElementById('ir-shear-rel') || {}).checked,
        tilt_overlay: !!(document.getElementById('ir-tilt-overlay') || {}).checked,
        coverage: parseInt((document.getElementById('ir-coverage') || {}).value || '25') / 100,
        max_radius_km: parseInt((document.getElementById('ir-max-radius') || {}).value || '500'),
    };
}

function generateCompositeIRPlanView() {
    var filters = _getCompositeFilters();
    var irParams = _getIRCompositeParams();
    var dataType = document.getElementById('comp-dtype').value;

    var _crp = document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing IR plan-view composite \u2014 this may take 30\u201390 seconds\u2026');

    var qs = _compositeQueryString(filters) +
        '&ir_variable=ir_brightness_temp' +
        '&data_type=' + dataType +
        '&coverage_min=' + irParams.coverage +
        '&normalize_rmw=' + (irParams.normalize_rmw ? 'true' : 'false') +
        '&max_r_rmw=' + irParams.max_r_rmw +
        '&dr_rmw=' + irParams.dr_rmw +
        '&shear_relative=' + (irParams.shear_relative ? 'true' : 'false') +
        '&max_radius_km=' + irParams.max_radius_km +
        '&include_tilt=' + (irParams.tilt_overlay ? 'true' : 'false');

    _fetchCompositeStream(API_BASE + '/composite/ir_plan_view?' + qs, 'Computing IR plan-view composite')
        .then(function(json) {
            _showCompStatus('success', '\u2713 IR plan-view composite computed: ' + json.n_cases + ' / ' + json.n_matched + ' cases');
            _renderIRPlanView('comp-result-ir-pv', json, filters, irParams);
        })
        .catch(function(err) { _showCompStatus('error', '\u2717 IR Plan View: ' + (err.message || String(err))); });
}

function _renderIRPlanView(targetId, json, filters, pvParams) {
    var el = document.getElementById(targetId); if (!el) return;
    el.style.display = 'block';
    _lastCompJson = json; _lastCompType = 'ir-pv';
    var planData = json.plan_view;
    var xAxis = json.x_axis, yAxis = json.y_axis;
    var varInfo = json.variable;
    var xLabel = json.x_label, yLabel = json.y_label;

    var heatmap = {
        z: planData, x: xAxis, y: yAxis, type: 'heatmap',
        colorscale: varInfo.colorscale, zmin: varInfo.vmin, zmax: varInfo.vmax,
        colorbar: { title: { text: varInfo.units, font: { color:'#ccc', size:12 } },
                    tickfont: { color:'#ccc', size:10 }, thickness:14, len:0.85 },
        hovertemplate: '<b>IR Tb</b>: %{z:.1f} K<br>' + xLabel + ': %{x:.1f}<br>' + yLabel + ': %{y:.1f}<extra></extra>',
        hoverongaps: false,
        reversescale: true
    };

    var normLabel = json.normalize_rmw ? ' (RMW-norm)' : '';
    var shearLabel = json.shear_relative ? ' [Shear \u2192 Right]' : '';
    var title = _compositeFilterSummary(filters, json.n_cases) +
                '<br>\uD83D\uDEF0\uFE0F IR Brightness Temperature' + normLabel + shearLabel;

    var shapes = [];
    var annotations = [];
    if (json.normalize_rmw) {
        var nPts = 100; var circleX = [], circleY = [];
        for (var i = 0; i <= nPts; i++) {
            var angle = 2 * Math.PI * i / nPts;
            circleX.push(Math.cos(angle)); circleY.push(Math.sin(angle));
        }
    }
    if (json.shear_relative) {
        var maxX = xAxis[xAxis.length - 1];
        shapes.push({
            type: 'line', x0: 0, y0: 0, x1: maxX * 0.92, y1: 0,
            line: { color: 'rgba(255,255,255,0.6)', width: 2, dash: 'dot' }
        });
        annotations.push({
            x: maxX * 0.95, y: 0, text: 'Shear \u2192', showarrow: false,
            font: { color: 'rgba(255,255,255,0.7)', size: 10 }
        });
    }

    var traces = [heatmap];
    if (json.normalize_rmw) {
        traces.push({
            x: circleX, y: circleY, type: 'scatter', mode: 'lines',
            line: { color: 'rgba(255,255,255,0.5)', width: 1.5, dash: 'dash' },
            showlegend: false, hoverinfo: 'skip'
        });
    }

    // Tilt overlay — composite mean vortex tilt profile coloured by height
    if (json.tilt_overlay) {
        var tilt = json.tilt_overlay;
        var tiltX = [], tiltY = [], tiltColors = [], tiltText = [];
        for (var ti = 0; ti < tilt.height_km.length; ti++) {
            if (tilt.x[ti] !== null && tilt.y[ti] !== null) {
                tiltX.push(tilt.x[ti]);
                tiltY.push(tilt.y[ti]);
                tiltColors.push(tilt.height_km[ti]);
                tiltText.push(tilt.height_km[ti] + ' km');
            }
        }
        if (tiltX.length > 1) {
            // Line connecting tilt positions (white, thin)
            traces.push({
                x: tiltX, y: tiltY, type: 'scatter', mode: 'lines',
                line: { color: 'rgba(255,255,255,0.5)', width: 1.5 },
                showlegend: false, hoverinfo: 'skip'
            });
            // Markers coloured by height
            traces.push({
                x: tiltX, y: tiltY, type: 'scatter', mode: 'markers+text',
                marker: {
                    size: 8, color: tiltColors,
                    colorscale: [[0,'#22d3ee'],[0.5,'#a855f7'],[1,'#ef4444']],
                    cmin: 0, cmax: 15,
                    colorbar: {
                        title: { text: 'Height (km)', font: { color:'#ccc', size:10 } },
                        tickfont: { color:'#ccc', size:9 }, thickness: 10, len: 0.4,
                        x: 1.12, xpad: 2, y: 0.15, yanchor: 'bottom'
                    },
                    line: { width: 1, color: 'rgba(255,255,255,0.6)' }
                },
                text: tiltText, textposition: 'top right',
                textfont: { size: 8, color: 'rgba(255,255,255,0.6)' },
                hovertemplate: '<b>Tilt</b> at %{text}<br>X: %{x:.2f}<br>Y: %{y:.2f}<extra></extra>',
                name: 'Vortex Tilt', showlegend: false
            });
            // Start marker (2 km reference)
            traces.push({
                x: [tiltX[0]], y: [tiltY[0]], type: 'scatter', mode: 'markers',
                marker: { size: 12, symbol: 'circle-open', color: '#22d3ee', line: { width: 2 } },
                showlegend: false, hoverinfo: 'skip'
            });
            title += '<br><span style="font-size:0.8em;color:#c084fc;">Tilt overlay: N=' + tilt.n_cases + ' cases</span>';
        }
    }

    var layout = {
        title: { text: title, font: { color:'#e2e8f0', size:13 }, y:0.98 },
        xaxis: { title: { text: xLabel, font: { color:'#9ca3af', size:11 } },
                 tickfont: { color:'#6b7280', size:10 }, gridcolor:'rgba(255,255,255,0.05)',
                 zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)',
                 scaleanchor: 'y', scaleratio: 1 },
        yaxis: { title: { text: yLabel, font: { color:'#9ca3af', size:11 } },
                 tickfont: { color:'#6b7280', size:10 }, gridcolor:'rgba(255,255,255,0.05)',
                 zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)' },
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0a1628',
        margin: { l:60, r:20, t:80, b:55 }, shapes: shapes, annotations: annotations
    };

    Plotly.react(el, traces, layout, { responsive: true, displayModeBar: true,
        modeBarButtonsToRemove: ['select2d','lasso2d','autoScale2d'] });
}

function generateCompositeIRAzMean() {
    var filters = _getCompositeFilters();
    var dataType = document.getElementById('comp-dtype').value;
    var irParams = _getIRCompositeParams();

    var _crp = document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing IR azimuthal-mean composite\u2026');

    var qs = _compositeQueryString(filters) +
        '&ir_variable=ir_brightness_temp' +
        '&data_type=' + dataType +
        '&coverage_min=' + irParams.coverage +
        '&normalize_rmw=' + (irParams.normalize_rmw ? 'true' : 'false') +
        '&max_r_rmw=' + irParams.max_r_rmw +
        '&dr_rmw=' + irParams.dr_rmw +
        '&max_radius_km=' + irParams.max_radius_km;

    _fetchCompositeStream(API_BASE + '/composite/ir_azimuthal_mean?' + qs, 'Computing IR azimuthal-mean composite')
        .then(function(json) {
            _showCompStatus('success', '\u2713 IR azimuthal-mean composite: ' + json.n_cases + ' / ' + json.n_matched + ' cases');
            _renderIRAzMean('comp-result-ir-az', json, filters);
        })
        .catch(function(err) { _showCompStatus('error', '\u2717 IR Az Mean: ' + (err.message || String(err))); });
}

function _renderIRAzMean(targetId, json, filters) {
    var el = document.getElementById(targetId); if (!el) return;
    el.style.display = 'block';
    _lastCompJson = json; _lastCompType = 'ir-az';
    var profile = json.radial_profile;
    var rCenters = json.r_centers;
    var varInfo = json.variable;
    var rLabel = json.r_label;

    // Build line trace
    var trace = {
        x: rCenters, y: profile, type: 'scatter', mode: 'lines',
        line: { color: '#22d3ee', width: 2.5 },
        hovertemplate: '<b>Tb</b>: %{y:.1f} K<br>' + rLabel + ': %{x:.2f}<extra></extra>',
        name: 'IR Tb'
    };

    var normLabel = json.normalize_rmw ? ' (RMW-norm)' : '';
    var title = _compositeFilterSummary(filters, json.n_cases) +
                '<br>\uD83D\uDEF0\uFE0F Azimuthal Mean IR Brightness Temperature' + normLabel;

    var shapes = [];
    if (json.normalize_rmw) {
        shapes.push({
            type: 'line', x0: 1, x1: 1, y0: 0, y1: 1, yref: 'paper',
            line: { color: 'rgba(255,255,255,0.4)', width: 1.5, dash: 'dash' }
        });
    }

    var layout = {
        title: { text: title, font: { color:'#e2e8f0', size:13 }, y:0.98 },
        xaxis: { title: { text: rLabel, font: { color:'#9ca3af', size:11 } },
                 tickfont: { color:'#6b7280', size:10 }, gridcolor:'rgba(255,255,255,0.05)',
                 zeroline: false, range: [0, rCenters[rCenters.length - 1]] },
        yaxis: { title: { text: 'Brightness Temperature (K)', font: { color:'#9ca3af', size:11 } },
                 tickfont: { color:'#6b7280', size:10 }, gridcolor:'rgba(255,255,255,0.05)',
                 zeroline: false, autorange: 'reversed' },
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0a1628',
        margin: { l:65, r:20, t:70, b:55 }, shapes: shapes,
        showlegend: false
    };

    Plotly.react(el, [trace], layout, { responsive: true, displayModeBar: true,
        modeBarButtonsToRemove: ['select2d','lasso2d','autoScale2d'] });
}

function _appendCaseList(el, caseList, nCases) {
    // Remove any existing case list in this container
    var existing = el.querySelector('.comp-case-list-wrap');
    if (existing) existing.remove();
    if (!caseList || !caseList.length) return;

    var wrap = document.createElement('div');
    wrap.className = 'comp-case-list-wrap';
    wrap.innerHTML =
        '<div class="comp-cl-header">' +
            '<span class="comp-cl-title">' + nCases + ' Cases Used</span>' +
        '</div>' +
        '<div class="comp-cl-scroll">' +
            '<table class="comp-cl-table"><thead><tr>' +
                '<th>#</th><th>Storm</th><th>Date/Time</th><th>V<sub>max</sub> (kt)</th>' +
            '</tr></thead><tbody>' +
            caseList.map(function(c, i) {
                var cat = getIntensityCategory(c.vmax_kt);
                var color = getIntensityColor(c.vmax_kt);
                return '<tr><td>' + (i+1) + '</td><td>' + (c.storm_name || '?') + '</td><td>' + (c.datetime || '?') + '</td><td><span class="intensity-badge" style="background:' + color + ';font-size:9px;padding:1px 4px;">' + cat + '</span> ' + (c.vmax_kt != null ? c.vmax_kt : 'N/A') + '</td></tr>';
            }).join('') +
            '</tbody></table></div>';
    el.appendChild(wrap);
}

// ── IR Satellite Difference Composites ────────────────────────────────

function generateCompDiffIRPlanView() {
    var filtersA = _getCompositeFilters();
    var filtersB = _getCompGroupBFilters();
    var irParams = _getIRCompositeParams();
    var dataType = document.getElementById('comp-dtype').value;

    var _crp = document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing IR plan-view difference composite (A\u2212B)\u2026');

    var baseQS = '&ir_variable=ir_brightness_temp' +
        '&data_type=' + dataType +
        '&coverage_min=' + irParams.coverage +
        '&normalize_rmw=' + (irParams.normalize_rmw ? 'true' : 'false') +
        '&max_r_rmw=' + irParams.max_r_rmw +
        '&dr_rmw=' + irParams.dr_rmw +
        '&shear_relative=' + (irParams.shear_relative ? 'true' : 'false') +
        '&max_radius_km=' + irParams.max_radius_km +
        '&include_tilt=' + (irParams.tilt_overlay ? 'true' : 'false');
    var urlA = API_BASE + '/composite/ir_plan_view?' + _compositeQueryString(filtersA) + baseQS;
    var urlB = API_BASE + '/composite/ir_plan_view?' + _compositeQueryString(filtersB) + baseQS;

    var jsonA;
    return _fetchCompositeStream(urlA, 'Group A IR plan view').then(function(result) {
        jsonA = result;
        _showCompStatus('loading', 'Group A done (' + jsonA.n_cases + ' cases). Computing Group B\u2026');
        return _fetchCompositeStream(urlB, 'Group B IR plan view');
    }).then(function(jsonB) {
        var diffData = _subtractArrays2D(jsonA.plan_view, jsonB.plan_view);
        var symRange = _symmetricRange(diffData);

        var diffJson = {
            plan_view: diffData,
            x_axis: jsonA.x_axis,
            y_axis: jsonA.y_axis,
            x_label: jsonA.x_label,
            y_label: jsonA.y_label,
            normalize_rmw: jsonA.normalize_rmw,
            shear_relative: jsonA.shear_relative,
            coverage_min: jsonA.coverage_min,
            n_cases: jsonA.n_cases,
            case_list: jsonA.case_list,
            case_list_b: jsonB.case_list,
            _isDiff: true,
            _nA: jsonA.n_cases,
            _nB: jsonB.n_cases,
            _filtersA: filtersA,
            _filtersB: filtersB,
            variable: {
                key: jsonA.variable.key,
                display_name: '\u0394 ' + jsonA.variable.display_name,
                units: jsonA.variable.units,
                vmin: -symRange,
                vmax: symRange,
                colorscale: _DIFF_COLORSCALE,
            }
        };

        _showCompStatus('success', '\u2713 IR PV difference computed: Group A (' + jsonA.n_cases + ') \u2212 Group B (' + jsonB.n_cases + ')');
        _renderDiffIRPlanView('comp-result-ir-pv', diffJson, jsonA, jsonB, filtersA, filtersB, irParams);
    }).catch(function(err) {
        _showCompStatus('error', '\u2717 IR Plan View Diff: ' + (err.message || String(err)));
    });
}

function _renderDiffIRPlanView(targetId, diffJson, jsonA, jsonB, filtersA, filtersB, irParams) {
    var el = document.getElementById(targetId); if (!el) return;
    el.style.display = 'block';
    _lastCompJson = diffJson; _lastCompType = 'ir-pv';

    var varInfoA = jsonA.variable;
    var diffVarInfo = diffJson.variable;

    el.innerHTML =
        '<div style="margin-bottom:4px;padding:6px 10px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#60a5fa;">\uD83D\uDD35 Group A</div>' +
        '<div id="comp-diff-irpv-a" style="width:100%;height:520px;border-radius:8px;overflow:hidden;"></div>' +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#f59e0b;">\uD83D\uDFE0 Group B</div>' +
        '<div id="comp-diff-irpv-b" style="width:100%;height:520px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-dirpv-ab', {label: 'Panels A &amp; B', defaultVmin: varInfoA.vmin, defaultVmax: varInfoA.vmax}) +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#ef4444;">\u0394 Difference (A \u2212 B)</div>' +
        '<div id="comp-diff-irpv-d" style="width:100%;height:520px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-dirpv-d', {label: 'Difference', defaultVmin: diffVarInfo.vmin, defaultVmax: diffVarInfo.vmax}) +
        _buildCompToolbar();

    _registerShadingTargets('shd-dirpv-ab', ['comp-diff-irpv-a', 'comp-diff-irpv-b'], varInfoA.colorscale, varInfoA.vmin, varInfoA.vmax);

    var plotOpts = { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] };
    var plotBg = '#0a1628';
    var xAxis = jsonA.x_axis, yAxis = jsonA.y_axis;
    var xLabel = jsonA.x_label, yLabel = jsonA.y_label;
    var normLabel = jsonA.normalize_rmw ? ' (RMW-norm)' : '';
    var shearLabel = jsonA.shear_relative ? ' [Shear \u2192 Right]' : '';

    function rmwCircleTrace() {
        if (!jsonA.normalize_rmw) return [];
        var nPts = 120, cx = [], cy = [];
        for (var j = 0; j <= nPts; j++) {
            var a = 2 * Math.PI * j / nPts;
            cx.push(parseFloat(Math.cos(a).toFixed(4)));
            cy.push(parseFloat(Math.sin(a).toFixed(4)));
        }
        return [{ x:cx, y:cy, type:'scatter', mode:'lines', line:{color:'white',width:1.5,dash:'dash'}, showlegend:false, hoverinfo:'skip' }];
    }

    function shearShapes() {
        if (!jsonA.shear_relative) return { shapes:[], annotations:[] };
        return buildShearInset(90, true);
    }

    function buildIRPvPlot(chartId, data, titleText, colorscale, zmin, zmax, units, srcJson) {
        var hm = {
            z: data, x: xAxis, y: yAxis, type: 'heatmap',
            colorscale: colorscale, zmin: zmin, zmax: zmax,
            colorbar: { title:{text:units,font:{color:'#ccc',size:11}}, tickfont:{color:'#ccc',size:10}, thickness:14, len:0.85 },
            hovertemplate: '<b>IR Tb</b>: %{z:.1f} ' + units + '<br>' + xLabel + ': %{x:.1f}<br>' + yLabel + ': %{y:.1f}<extra></extra>',
            hoverongaps: false,
            reversescale: (colorscale !== _DIFF_COLORSCALE)
        };
        var traces = [hm].concat(rmwCircleTrace());
        // Add tilt overlay for individual group panels
        if (srcJson && srcJson.tilt_overlay) {
            var tilt = srcJson.tilt_overlay;
            var tiltX = [], tiltY = [], tiltColors = [], tiltText = [];
            for (var ti = 0; ti < tilt.height_km.length; ti++) {
                if (tilt.x[ti] !== null && tilt.y[ti] !== null) {
                    tiltX.push(tilt.x[ti]); tiltY.push(tilt.y[ti]);
                    tiltColors.push(tilt.height_km[ti]); tiltText.push(tilt.height_km[ti] + ' km');
                }
            }
            if (tiltX.length > 1) {
                traces.push({ x: tiltX, y: tiltY, type:'scatter', mode:'lines', line:{color:'rgba(255,255,255,0.5)',width:1.5}, showlegend:false, hoverinfo:'skip' });
                traces.push({ x: tiltX, y: tiltY, type:'scatter', mode:'markers+text',
                    marker: { size:8, color:tiltColors, colorscale:[[0,'#22d3ee'],[0.5,'#a855f7'],[1,'#ef4444']], cmin:0, cmax:15,
                        colorbar: { title:{text:'Height (km)',font:{color:'#ccc',size:10}}, tickfont:{color:'#ccc',size:9}, thickness:10, len:0.4, x:1.12, xpad:2, y:0.15, yanchor:'bottom' },
                        line:{width:1,color:'rgba(255,255,255,0.6)'} },
                    text: tiltText, textposition:'top right', textfont:{size:8,color:'rgba(255,255,255,0.6)'},
                    hovertemplate: '<b>Tilt</b> at %{text}<br>X: %{x:.2f}<br>Y: %{y:.2f}<extra></extra>', name:'Vortex Tilt', showlegend:false });
            }
        }
        var sInset = shearShapes();
        var layout = {
            title: { text:titleText, font:{color:'#e5e7eb',size:13}, y:0.97, x:0.5, xanchor:'center' },
            paper_bgcolor:plotBg, plot_bgcolor:plotBg,
            xaxis: { title:{text:xLabel,font:{color:'#aaa',size:11}}, tickfont:{color:'#aaa',size:10}, gridcolor:'rgba(255,255,255,0.04)', zeroline:true, zerolinecolor:'rgba(255,255,255,0.12)' },
            yaxis: { title:{text:yLabel,font:{color:'#aaa',size:11}}, tickfont:{color:'#aaa',size:10}, gridcolor:'rgba(255,255,255,0.04)', zeroline:true, zerolinecolor:'rgba(255,255,255,0.12)', scaleanchor:'x', scaleratio:1 },
            margin:{ l:60, r:24, t:100, b:50 },
            shapes: sInset.shapes || [], annotations: sInset.annotations || [],
            showlegend:false
        };
        Plotly.newPlot(chartId, traces, layout, plotOpts);
    }

    var activeColorscale = varInfoA.colorscale;
    var activeVmin = varInfoA.vmin;
    var activeVmax = varInfoA.vmax;

    // Group A
    var titleA = _compositeFilterSummary(filtersA, jsonA.n_cases) +
                 '<br>\uD83D\uDEF0\uFE0F IR Brightness Temperature' + normLabel + shearLabel;
    buildIRPvPlot('comp-diff-irpv-a', jsonA.plan_view, titleA, activeColorscale, activeVmin, activeVmax, varInfoA.units, jsonA);

    // Group B
    var titleB = _compositeFilterSummary(filtersB, jsonB.n_cases) +
                 '<br>\uD83D\uDEF0\uFE0F IR Brightness Temperature' + normLabel + shearLabel;
    buildIRPvPlot('comp-diff-irpv-b', jsonB.plan_view, titleB, activeColorscale, activeVmin, activeVmax, varInfoA.units, jsonB);

    // Difference
    var titleD = _diffFilterSummary(filtersA, filtersB, jsonA.n_cases, jsonB.n_cases) +
                 '<br>\u0394 \uD83D\uDEF0\uFE0F IR Brightness Temperature' + normLabel + shearLabel;
    _registerShadingTargets('shd-dirpv-d', ['comp-diff-irpv-d'], _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax);
    buildIRPvPlot('comp-diff-irpv-d', diffJson.plan_view, titleD, _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax, diffVarInfo.units, null);
}

function generateCompDiffIRAzMean() {
    var filtersA = _getCompositeFilters();
    var filtersB = _getCompGroupBFilters();
    var irParams = _getIRCompositeParams();
    var dataType = document.getElementById('comp-dtype').value;

    var _crp = document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing IR azimuthal mean difference composite (A\u2212B)\u2026');

    var baseQS = '&ir_variable=ir_brightness_temp' +
        '&data_type=' + dataType +
        '&coverage_min=' + irParams.coverage +
        '&normalize_rmw=' + (irParams.normalize_rmw ? 'true' : 'false') +
        '&max_r_rmw=' + irParams.max_r_rmw +
        '&dr_rmw=' + irParams.dr_rmw +
        '&max_radius_km=' + irParams.max_radius_km;
    var urlA = API_BASE + '/composite/ir_azimuthal_mean?' + _compositeQueryString(filtersA) + baseQS;
    var urlB = API_BASE + '/composite/ir_azimuthal_mean?' + _compositeQueryString(filtersB) + baseQS;

    var jsonA;
    return _fetchCompositeStream(urlA, 'Group A IR azimuthal mean').then(function(result) {
        jsonA = result;
        _showCompStatus('loading', 'Group A done (' + jsonA.n_cases + ' cases). Computing Group B\u2026');
        return _fetchCompositeStream(urlB, 'Group B IR azimuthal mean');
    }).then(function(jsonB) {
        // Element-wise subtraction of 1D radial profiles
        var diffProfile = jsonA.radial_profile.map(function(v, i) {
            var a = v, b = jsonB.radial_profile[i];
            if (a === null || a === undefined || isNaN(a)) return null;
            if (b === null || b === undefined || isNaN(b)) return null;
            return a - b;
        });
        var maxAbs = 0;
        diffProfile.forEach(function(v) { if (v !== null && Math.abs(v) > maxAbs) maxAbs = Math.abs(v); });
        if (maxAbs === 0) maxAbs = 1;

        _showCompStatus('success', '\u2713 IR Az Mean difference computed: Group A (' + jsonA.n_cases + ') \u2212 Group B (' + jsonB.n_cases + ')');
        _renderDiffIRAzMean('comp-result-ir-az', jsonA, jsonB, diffProfile, maxAbs, filtersA, filtersB);
    }).catch(function(err) {
        _showCompStatus('error', '\u2717 IR Az Mean Diff: ' + (err.message || String(err)));
    });
}

function _renderDiffIRAzMean(targetId, jsonA, jsonB, diffProfile, maxAbs, filtersA, filtersB) {
    var el = document.getElementById(targetId); if (!el) return;
    el.style.display = 'block';
    _lastCompJson = {
        _isDiff: true, _nA: jsonA.n_cases, _nB: jsonB.n_cases,
        _filtersA: filtersA, _filtersB: filtersB,
        case_list: jsonA.case_list, case_list_b: jsonB.case_list,
        n_cases: jsonA.n_cases, variable: jsonA.variable
    };
    _lastCompType = 'ir-az';

    var rCenters = jsonA.r_centers;
    var rLabel = jsonA.r_label;
    var varInfoA = jsonA.variable;
    var normLabel = jsonA.normalize_rmw ? ' (RMW-norm)' : '';
    var plotOpts = { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] };
    var plotBg = '#0a1628';

    el.innerHTML =
        '<div style="margin-bottom:4px;padding:6px 10px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#60a5fa;">\uD83D\uDD35 Group A</div>' +
        '<div id="comp-diff-iraz-a" style="width:100%;height:360px;border-radius:8px;overflow:hidden;"></div>' +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#f59e0b;">\uD83D\uDFE0 Group B</div>' +
        '<div id="comp-diff-iraz-b" style="width:100%;height:360px;border-radius:8px;overflow:hidden;"></div>' +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#ef4444;">\u0394 Difference (A \u2212 B)</div>' +
        '<div id="comp-diff-iraz-d" style="width:100%;height:360px;border-radius:8px;overflow:hidden;"></div>' +
        _buildCompToolbar();

    var rmwShapes = [];
    if (jsonA.normalize_rmw) {
        rmwShapes.push({
            type: 'line', x0: 1, x1: 1, y0: 0, y1: 1, yref: 'paper',
            line: { color: 'rgba(255,255,255,0.4)', width: 1.5, dash: 'dash' }
        });
    }

    function buildAzLine(chartId, profile, titleText, lineColor) {
        var trace = {
            x: rCenters, y: profile, type: 'scatter', mode: 'lines',
            line: { color: lineColor, width: 2.5 },
            hovertemplate: '<b>Tb</b>: %{y:.1f} K<br>' + rLabel + ': %{x:.2f}<extra></extra>',
            name: 'IR Tb'
        };
        var layout = {
            title: { text:titleText, font:{color:'#e2e8f0',size:13}, y:0.98 },
            xaxis: { title:{text:rLabel,font:{color:'#9ca3af',size:11}}, tickfont:{color:'#6b7280',size:10}, gridcolor:'rgba(255,255,255,0.05)', zeroline:false, range:[0, rCenters[rCenters.length-1]] },
            yaxis: { title:{text:'Brightness Temperature (K)',font:{color:'#9ca3af',size:11}}, tickfont:{color:'#6b7280',size:10}, gridcolor:'rgba(255,255,255,0.05)', zeroline:false, autorange:'reversed' },
            paper_bgcolor:plotBg, plot_bgcolor:plotBg,
            margin:{l:65,r:20,t:70,b:55}, shapes:rmwShapes, showlegend:false
        };
        Plotly.newPlot(chartId, [trace], layout, plotOpts);
    }

    function buildDiffLine(chartId, profile, titleText, maxRange) {
        var trace = {
            x: rCenters, y: profile, type: 'scatter', mode: 'lines',
            line: { color: '#ef4444', width: 2.5 },
            fill: 'tozeroy',
            fillcolor: 'rgba(239,68,68,0.15)',
            hovertemplate: '<b>\u0394Tb</b>: %{y:.1f} K<br>' + rLabel + ': %{x:.2f}<extra></extra>',
            name: '\u0394 IR Tb'
        };
        var layout = {
            title: { text:titleText, font:{color:'#e2e8f0',size:13}, y:0.98 },
            xaxis: { title:{text:rLabel,font:{color:'#9ca3af',size:11}}, tickfont:{color:'#6b7280',size:10}, gridcolor:'rgba(255,255,255,0.05)', zeroline:false, range:[0, rCenters[rCenters.length-1]] },
            yaxis: { title:{text:'\u0394 Brightness Temperature (K)',font:{color:'#9ca3af',size:11}}, tickfont:{color:'#6b7280',size:10}, gridcolor:'rgba(255,255,255,0.05)', zeroline:true, zerolinecolor:'rgba(255,255,255,0.2)', range:[-maxRange*1.1, maxRange*1.1] },
            paper_bgcolor:plotBg, plot_bgcolor:plotBg,
            margin:{l:65,r:20,t:70,b:55}, shapes:rmwShapes, showlegend:false
        };
        Plotly.newPlot(chartId, [trace], layout, plotOpts);
    }

    // Group A
    var titleA = _compositeFilterSummary(filtersA, jsonA.n_cases) +
                 '<br>\uD83D\uDEF0\uFE0F Azimuthal Mean IR Brightness Temperature' + normLabel;
    buildAzLine('comp-diff-iraz-a', jsonA.radial_profile, titleA, '#22d3ee');

    // Group B
    var titleB = _compositeFilterSummary(filtersB, jsonB.n_cases) +
                 '<br>\uD83D\uDEF0\uFE0F Azimuthal Mean IR Brightness Temperature' + normLabel;
    buildAzLine('comp-diff-iraz-b', jsonB.radial_profile, titleB, '#f59e0b');

    // Difference
    var titleD = _diffFilterSummary(filtersA, filtersB, jsonA.n_cases, jsonB.n_cases) +
                 '<br>\u0394 Azimuthal Mean IR Brightness Temperature' + normLabel;
    buildDiffLine('comp-diff-iraz-d', diffProfile, titleD, maxAbs);
}

var _DIFF_COLORSCALE = [[0,'rgb(5,48,97)'],[0.1,'rgb(33,102,172)'],[0.2,'rgb(67,147,195)'],[0.3,'rgb(146,197,222)'],[0.4,'rgb(209,229,240)'],[0.5,'rgb(247,247,247)'],[0.6,'rgb(253,219,199)'],[0.7,'rgb(239,163,128)'],[0.8,'rgb(214,96,77)'],[0.9,'rgb(178,24,43)'],[1,'rgb(103,0,31)']];

function _diffFilterSummary(filtersA, filtersB, nA, nB) {
    var summA = _compositeFilterSummary(filtersA, nA);
    var summB = _compositeFilterSummary(filtersB, nB);
    // Extract just the filter part (after "Composite (N=...) | ")
    var partA = summA.replace(/^Composite \(N=\d+\) \| ?/, '') || 'All';
    var partB = summB.replace(/^Composite \(N=\d+\) \| ?/, '') || 'All';
    return '<span style="color:#60a5fa;">A</span> (N=' + nA + '): ' + partA +
           ' \u2212 <span style="color:#f59e0b;">B</span> (N=' + nB + '): ' + partB;
}

function generateCompDiffAzMean() {
    var filtersA = _getCompositeFilters();
    var filtersB = _getCompGroupBFilters();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    var coverage = parseInt(document.getElementById('comp-coverage').value) / 100;
    var overlay = (document.getElementById('comp-overlay') || {}).value || '';

    var _crp = document.getElementById('comp-result-placeholder') || document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing difference composite (A\u2212B) azimuthal mean\u2026');

    var normRmw = !!(document.getElementById('comp-norm-rmw') || {}).checked;
    var maxRRmw = normRmw ? (parseFloat((document.getElementById('comp-max-r-rmw') || {}).value) || 8.0) : (parseFloat((document.getElementById('comp-max-r-rmw') || {}).value) || 200);
    var drRmw   = normRmw ? Math.max(0.05, parseFloat((document.getElementById('comp-dr-rmw') || {}).value) || 0.25) : (parseFloat((document.getElementById('comp-dr-rmw') || {}).value) || 2);
    var baseQS = '&variable=' + encodeURIComponent(variable) + '&data_type=' + dataType + '&coverage_min=' + coverage +
        '&normalize_rmw=' + (normRmw ? 'true' : 'false') + '&max_r_rmw=' + maxRRmw + '&dr_rmw=' + drRmw;
    if (overlay) baseQS += '&overlay=' + encodeURIComponent(overlay);
    var urlA = API_BASE + '/composite/azimuthal_mean?' + _compositeQueryString(filtersA) + baseQS;
    var urlB = API_BASE + '/composite/azimuthal_mean?' + _compositeQueryString(filtersB) + baseQS;

    // Sequential streaming: fetch Group A first, then Group B, to avoid
    // doubling memory/thread pressure on the server.
    var jsonA;
    return _fetchCompositeStream(urlA, 'Group A azimuthal mean').then(function(result) {
        jsonA = result;
        _showCompStatus('loading', 'Group A done (' + jsonA.n_cases + ' cases). Computing Group B\u2026');
        return _fetchCompositeStream(urlB, 'Group B azimuthal mean');
    }).then(function(jsonB) {
        var diffData = _subtractArrays2D(jsonA.azimuthal_mean, jsonB.azimuthal_mean);
        var symRange = _symmetricRange(diffData);

        // Build a synthetic json for the renderer
        var diffJson = {
            azimuthal_mean: diffData,
            radius_rrmw: jsonA.radius_rrmw,
            height_km: jsonA.height_km,
            normalized: jsonA.normalized,
            coverage_min: jsonA.coverage_min,
            n_cases: jsonA.n_cases,
            n_with_rmw: jsonA.n_with_rmw,
            case_list: jsonA.case_list,
            case_list_b: jsonB.case_list,
            _isDiff: true,
            _nA: jsonA.n_cases,
            _nB: jsonB.n_cases,
            _filtersA: filtersA,
            _filtersB: filtersB,
            variable: {
                key: jsonA.variable.key,
                display_name: '\u0394 ' + jsonA.variable.display_name,
                units: jsonA.variable.units,
                vmin: -symRange,
                vmax: symRange,
                colorscale: _DIFF_COLORSCALE,
            }
        };
        // Overlay difference
        if (jsonA.overlay && jsonB.overlay) {
            var ovDiff = _subtractArrays2D(jsonA.overlay.azimuthal_mean, jsonB.overlay.azimuthal_mean);
            diffJson.overlay = {
                display_name: '\u0394 ' + jsonA.overlay.display_name,
                key: jsonA.overlay.key,
                units: jsonA.overlay.units,
                azimuthal_mean: ovDiff,
                vmin: jsonA.overlay.vmin,
                vmax: jsonA.overlay.vmax,
            };
        }

        _showCompStatus('success', '\u2713 Difference computed: Group A (' + jsonA.n_cases + ' cases) \u2212 Group B (' + jsonB.n_cases + ' cases)');
        _renderDiffAzMean('comp-result-az', diffJson, jsonA, jsonB, filtersA, filtersB);
        _showCompShadingToolbar();
    }).catch(function(err) {
        _showCompStatus('error', '\u2717 Az Mean: ' + (err.message || String(err)));
    });
}

function generateCompDiffQuadMean() {
    var filtersA = _getCompositeFilters();
    var filtersB = _getCompGroupBFilters();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    var coverage = parseInt(document.getElementById('comp-coverage').value) / 100;
    var overlay = (document.getElementById('comp-overlay') || {}).value || '';

    var _crp = document.getElementById('comp-result-placeholder') || document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing difference composite (A\u2212B) shear quadrants\u2026');

    // Quad endpoint always RMW-normalises, so always read user-specified radial settings
    var maxRRmw = parseFloat((document.getElementById('comp-max-r-rmw') || {}).value) || 5.0;
    var drRmw   = Math.max(0.05, parseFloat((document.getElementById('comp-dr-rmw') || {}).value) || 0.25);
    var baseQS = '&variable=' + encodeURIComponent(variable) + '&data_type=' + dataType + '&coverage_min=' + coverage +
        '&max_r_rmw=' + maxRRmw + '&dr_rmw=' + drRmw;
    if (overlay) baseQS += '&overlay=' + encodeURIComponent(overlay);
    var urlA = API_BASE + '/composite/quadrant_mean?' + _compositeQueryString(filtersA) + baseQS;
    var urlB = API_BASE + '/composite/quadrant_mean?' + _compositeQueryString(filtersB) + baseQS;

    // Sequential streaming: fetch Group A first, then Group B, to avoid
    // doubling memory/thread pressure on the server.
    var jsonA;
    return _fetchCompositeStream(urlA, 'Group A shear quadrants').then(function(result) {
        jsonA = result;
        _showCompStatus('loading', 'Group A done (' + jsonA.n_cases + ' cases). Computing Group B\u2026');
        return _fetchCompositeStream(urlB, 'Group B shear quadrants');
    }).then(function(jsonB) {
        var diffQuads = {};
        var allDiffVals = [];
        var quadKeys = ['DSL','DSR','USL','USR'];
        quadKeys.forEach(function(k) {
            if (jsonA.quadrant_means[k] && jsonB.quadrant_means[k]) {
                var d = _subtractArrays2D(jsonA.quadrant_means[k].data, jsonB.quadrant_means[k].data);
                diffQuads[k] = { data: d, n_cases: jsonA.quadrant_means[k].n_cases };
                // Collect values for symmetric range
                for (var r = 0; r < d.length; r++) for (var c = 0; c < d[r].length; c++) {
                    var v = d[r][c];
                    if (v !== null && v !== undefined && !isNaN(v)) allDiffVals.push(Math.abs(v));
                }
            }
        });
        var symRange = allDiffVals.length > 0 ? _symmetricRange([allDiffVals]) : 1;

        var diffJson = {
            quadrant_means: diffQuads,
            radius_rrmw: jsonA.radius_rrmw,
            height_km: jsonA.height_km,
            normalized: jsonA.normalized,
            coverage_min: jsonA.coverage_min,
            n_cases: jsonA.n_cases,
            n_with_shear: jsonA.n_with_shear,
            n_with_shear_and_rmw: jsonA.n_with_shear_and_rmw,
            case_list: jsonA.case_list,
            case_list_b: jsonB.case_list,
            _isDiff: true,
            _nA: jsonA.n_cases,
            _nB: jsonB.n_cases,
            _filtersA: filtersA,
            _filtersB: filtersB,
            variable: {
                key: jsonA.variable.key,
                display_name: '\u0394 ' + jsonA.variable.display_name,
                units: jsonA.variable.units,
                vmin: -symRange,
                vmax: symRange,
                colorscale: _DIFF_COLORSCALE,
            }
        };
        if (jsonA.overlay && jsonB.overlay) {
            var ovDiffQuads = {};
            quadKeys.forEach(function(k) {
                if (jsonA.overlay.quadrant_means && jsonA.overlay.quadrant_means[k] &&
                    jsonB.overlay.quadrant_means && jsonB.overlay.quadrant_means[k]) {
                    ovDiffQuads[k] = _subtractArrays2D(jsonA.overlay.quadrant_means[k], jsonB.overlay.quadrant_means[k]);
                }
            });
            diffJson.overlay = {
                display_name: '\u0394 ' + jsonA.overlay.display_name,
                key: jsonA.overlay.key,
                units: jsonA.overlay.units,
                quadrant_means: ovDiffQuads,
                vmin: jsonA.overlay.vmin,
                vmax: jsonA.overlay.vmax,
            };
        }

        _showCompStatus('success', '\u2713 Difference computed: Group A (' + jsonA.n_cases + ' cases) \u2212 Group B (' + jsonB.n_cases + ' cases)');
        _renderDiffQuadMean('comp-result-sq', diffJson, jsonA, jsonB, filtersA, filtersB);
        _showCompShadingToolbar();
    }).catch(function(err) {
        _showCompStatus('error', '\u2717 Quad Mean: ' + (err.message || String(err)));
    });
}

function _renderDiffAzMean(targetId, diffJson, jsonA, jsonB, filtersA, filtersB) {
    var el = document.getElementById(targetId); if (!el) return;
    el.style.display = 'block';
    _lastCompJson = diffJson; _lastCompType = 'az';

    // Create 3 stacked chart containers + toolbar
    var varInfoA = jsonA.variable;
    var diffVarInfo = diffJson.variable;

    el.innerHTML =
        '<div style="margin-bottom:4px;padding:6px 10px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#60a5fa;">\uD83D\uDD35 Group A</div>' +
        '<div id="comp-diff-az-a" style="width:100%;height:460px;border-radius:8px;overflow:hidden;"></div>' +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#f59e0b;">\uD83D\uDFE0 Group B</div>' +
        '<div id="comp-diff-az-b" style="width:100%;height:460px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-daz-ab', {label: 'Panels A &amp; B', defaultVmin: varInfoA.vmin, defaultVmax: varInfoA.vmax}) +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#ef4444;">\u0394 Difference (A \u2212 B)</div>' +
        '<div id="comp-diff-az-d" style="width:100%;height:460px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-daz-d', {label: 'Difference', defaultVmin: diffVarInfo.vmin, defaultVmax: diffVarInfo.vmax}) +
        _buildCompToolbar();

    _registerShadingTargets('shd-daz-ab', ['comp-diff-az-a', 'comp-diff-az-b'], varInfoA.colorscale, varInfoA.vmin, varInfoA.vmax);

    var plotOpts = { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] };
    var plotBg = '#0a1628';
    var isNorm = jsonA.normalized;
    var rLabel = isNorm ? 'R / RMW' : 'Radius (km)';
    var radius = jsonA.radius_rrmw, height_km = jsonA.height_km;
    var covPct = Math.round((jsonA.coverage_min || 0.5) * 100);
    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var fontSize = { title:13, axis:11, tick:10, cbar:11, cbarTick:10, hover:12 };
    var rmwShape = isNorm ? [{ type:'line', xref:'x', yref:'paper', x0:1, x1:1, y0:0, y1:1, line:{ color:'white', width:1.5, dash:'dash' } }] : [];

    // Helper to build a single az mean plot (overlayJson optional)
    function buildAzPlot(chartId, data, titleText, colorscale, zmin, zmax, units, overlayJson) {
        var hm = {
            z: data, x: radius, y: height_km, type: 'heatmap',
            colorscale: colorscale, zmin: zmin, zmax: zmax,
            colorbar: { title:{text:units,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:14, len:0.85 },
            hovertemplate: '%{z:.2f} ' + units + '<br>' + rLabel + ': %{x:.2f}<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps: false
        };
        var ovTraces = overlayJson ? buildCompAzOverlayContours(overlayJson, radius, height_km) : [];
        var layout = {
            title: { text:titleText, font:{color:'#e5e7eb',size:fontSize.title}, y:0.97, x:0.5, xanchor:'center' },
            paper_bgcolor:plotBg, plot_bgcolor:plotBg,
            xaxis: { title:{text:rLabel,font:{color:'#aaa',size:fontSize.axis}}, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
            yaxis: { title:{text:'Height (km)',font:{color:'#aaa',size:fontSize.axis}}, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
            margin:{ l:55, r:24, t:116, b:42 }, shapes:rmwShape,
            hoverlabel:{ bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
            showlegend:false
        };
        Plotly.newPlot(chartId, [hm].concat(ovTraces), layout, plotOpts);
    }

    var activeColorscale = varInfoA.colorscale;
    var activeVmin = varInfoA.vmin;
    var activeVmax = varInfoA.vmax;

    var meanVmaxA = _computeCompositeMeanVmax(filtersA);
    var vmaxNoteA = meanVmaxA !== null ? ' | Mean V<sub>max</sub>=' + meanVmaxA + ' kt' : '';
    var titleA = _compositeFilterSummary(filtersA, jsonA.n_cases) + vmaxNoteA +
                 '<br>Azimuthal Mean: ' + varInfoA.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)';
    buildAzPlot('comp-diff-az-a', jsonA.azimuthal_mean, titleA, activeColorscale, activeVmin, activeVmax, varInfoA.units, jsonA);

    var meanVmaxB = _computeCompositeMeanVmax(filtersB);
    var vmaxNoteB = meanVmaxB !== null ? ' | Mean V<sub>max</sub>=' + meanVmaxB + ' kt' : '';
    var titleB = _compositeFilterSummary(filtersB, jsonB.n_cases) + vmaxNoteB +
                 '<br>Azimuthal Mean: ' + varInfoA.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)';
    buildAzPlot('comp-diff-az-b', jsonB.azimuthal_mean, titleB, activeColorscale, activeVmin, activeVmax, varInfoA.units, jsonB);

    var diffVmaxNote = '';
    if (meanVmaxA !== null || meanVmaxB !== null) {
        diffVmaxNote = ' | V\u0305<sub>max</sub>: ';
        if (meanVmaxA !== null) diffVmaxNote += '<span style="color:#60a5fa;">A=' + meanVmaxA + '</span>';
        if (meanVmaxA !== null && meanVmaxB !== null) diffVmaxNote += ', ';
        if (meanVmaxB !== null) diffVmaxNote += '<span style="color:#f59e0b;">B=' + meanVmaxB + '</span> kt';
    }
    var titleD = _diffFilterSummary(filtersA, filtersB, jsonA.n_cases, jsonB.n_cases) + diffVmaxNote +
                 '<br>\u0394 Azimuthal Mean: ' + varInfoA.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)';

    _registerShadingTargets('shd-daz-d', ['comp-diff-az-d'], _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax);
    buildAzPlot('comp-diff-az-d', diffJson.azimuthal_mean, titleD, _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax, diffVarInfo.units, diffJson);
}

function _renderDiffQuadMean(targetId, diffJson, jsonA, jsonB, filtersA, filtersB) {
    var el = document.getElementById(targetId); if (!el) return;
    el.style.display = 'block';
    _lastCompJson = diffJson; _lastCompType = 'sq';

    var varInfoA = jsonA.variable;
    var diffVarInfo = diffJson.variable;

    el.innerHTML =
        '<div style="margin-bottom:4px;padding:6px 10px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#60a5fa;">\uD83D\uDD35 Group A</div>' +
        '<div id="comp-diff-sq-a" style="width:100%;height:640px;border-radius:8px;overflow:hidden;"></div>' +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#f59e0b;">\uD83D\uDFE0 Group B</div>' +
        '<div id="comp-diff-sq-b" style="width:100%;height:640px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-dsq-ab', {label: 'Panels A &amp; B', defaultVmin: varInfoA.vmin, defaultVmax: varInfoA.vmax}) +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#ef4444;">\u0394 Difference (A \u2212 B)</div>' +
        '<div id="comp-diff-sq-d" style="width:100%;height:640px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-dsq-d', {label: 'Difference', defaultVmin: diffVarInfo.vmin, defaultVmax: diffVarInfo.vmax}) +
        _buildCompToolbar() + _buildQuadLayoutToggle();

    _registerShadingTargets('shd-dsq-ab', ['comp-diff-sq-a', 'comp-diff-sq-b'], varInfoA.colorscale, varInfoA.vmin, varInfoA.vmax);

    var plotOpts = { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] };
    var plotBg = '#0a1628';
    var isNorm = jsonA.normalized;
    var rLabel = isNorm ? 'R / RMW' : 'Radius (km)';
    var radius = jsonA.radius_rrmw, height_km = jsonA.height_km;
    var covPct = Math.round((jsonA.coverage_min || 0.5) * 100);
    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var fontSize = { title:12, axis:10, tick:9, cbar:10, cbarTick:9, hover:11, panel:11 };

    var panelOrder = [
        { key:'USL', label:'Upshear Left', row:0, col:0 },
        { key:'DSL', label:'Downshear Left', row:0, col:1 },
        { key:'USR', label:'Upshear Right', row:1, col:0 },
        { key:'DSR', label:'Downshear Right', row:1, col:1 }
    ];
    var quadColors = { DSL:'#f59e0b', DSR:'#f59e0b', USL:'#60a5fa', USR:'#60a5fa' };

    function buildQuadPlot(chartId, quads, titleText, colorscale, zmin, zmax, units, overlayJson) {
        var traces = [], annotations = [], shapes = [];
        var tcCentric = _compQuadTCCentric;
        var gap=0.04, cbarW=0.04, leftM=0.06, rightM=0.02+cbarW+0.02, topM=0.18, botM=0.06;
        var pw = (1-leftM-rightM-gap)/2, ph = (1-topM-botM-gap)/2;

        panelOrder.forEach(function(p, i) {
            var qData = quads[p.key];
            if (!qData) return;
            var data = qData.data || qData;  // handle both {data:...} and raw array
            var x0 = leftM + p.col * (pw + gap), x1 = x0 + pw;
            var yTop = 1 - topM - p.row * ph - p.row * gap;
            var yBottom = 1 - topM - (p.row+1) * ph - p.row * gap;
            var axSuffix = i === 0 ? '' : String(i+1);
            var showCbar = (i === 1);
            traces.push({
                z:data, x:radius, y:height_km, type:'heatmap',
                colorscale:colorscale, zmin:zmin, zmax:zmax,
                xaxis:'x'+axSuffix, yaxis:'y'+axSuffix,
                showscale:showCbar,
                colorbar: showCbar ? { title:{text:units,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:14, len:0.85, x:1.02, y:0.5 } : undefined,
                hovertemplate:'<b>'+p.label+'</b><br>%{z:.2f} '+units+'<br>'+rLabel+': %{x:.2f}<br>Height: %{y:.1f} km<extra></extra>',
                hoverongaps:false
            });
            annotations.push({
                text:'<b>'+p.label+'</b>', xref:'paper', yref:'paper',
                x:(x0+x1)/2, y:yTop+0.005, xanchor:'center', yanchor:'bottom', showarrow:false,
                font:{ color:quadColors[p.key]||'#ccc', size:fontSize.panel, family:'JetBrains Mono, monospace' },
                bgcolor:'rgba(10,22,40,0.7)', borderpad:2
            });
            if (isNorm) {
                shapes.push({ type:'line', xref:'x'+axSuffix, yref:'y'+axSuffix,
                    x0:1, x1:1, y0:height_km[0], y1:height_km[height_km.length-1],
                    line:{ color:'white', width:1, dash:'dash' } });
            }
        });

        var shearInset = buildShearInset(90, true);
        annotations = annotations.concat(shearInset.annotations || []);

        var layoutAxes = {};
        panelOrder.forEach(function(p, i) {
            var x0 = leftM + p.col * (pw + gap), x1 = x0 + pw;
            var yBottom = 1 - topM - (p.row+1) * ph - p.row * gap;
            var yTop = 1 - topM - p.row * ph - p.row * gap;
            var axSuffix = i === 0 ? '' : String(i+1);
            var isUpshear = (p.col === 0);
            var showYLabel = (p.col === 0), showXLabel = (p.row === 1);
            var xAxisDef = { domain:[x0,x1], title:showXLabel?{text:rLabel,font:{color:'#aaa',size:fontSize.axis}}:undefined, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false, anchor:'y'+axSuffix };
            if (tcCentric && isUpshear) xAxisDef.autorange = 'reversed';
            layoutAxes['xaxis' + axSuffix] = xAxisDef;
            layoutAxes['yaxis' + axSuffix] = { domain:[yBottom,yTop], title:showYLabel?{text:'Height (km)',font:{color:'#aaa',size:fontSize.axis}}:undefined, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false, anchor:'x'+axSuffix };
        });

        var layout = Object.assign({
            title:{ text:titleText, font:{color:'#e5e7eb',size:fontSize.title}, y:0.99, x:0.5, xanchor:'center' },
            paper_bgcolor:plotBg, plot_bgcolor:plotBg,
            margin:{ l:50, r:60, t:140, b:44 },
            annotations:annotations, shapes:shapes.concat(shearInset.shapes || []),
            hoverlabel:{ bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
            showlegend:false
        }, layoutAxes);

        var ovTraces = overlayJson ? buildCompQuadOverlayContours(overlayJson, radius, height_km, panelOrder) : [];
        Plotly.newPlot(chartId, traces.concat(ovTraces), layout, plotOpts);
    }

    var activeColorscale = varInfoA.colorscale;
    var activeVmin = varInfoA.vmin;
    var activeVmax = varInfoA.vmax;

    // Group A
    var meanVmaxA = _computeCompositeMeanVmax(filtersA);
    var vmaxNoteA = meanVmaxA !== null ? ' | Mean V<sub>max</sub>=' + meanVmaxA + ' kt' : '';
    var titleA = _compositeFilterSummary(filtersA, jsonA.n_cases) + vmaxNoteA +
                 '<br>Shear-Relative Quadrant Mean: ' + varInfoA.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)';
    buildQuadPlot('comp-diff-sq-a', jsonA.quadrant_means, titleA, activeColorscale, activeVmin, activeVmax, varInfoA.units, jsonA);

    // Group B
    var meanVmaxB = _computeCompositeMeanVmax(filtersB);
    var vmaxNoteB = meanVmaxB !== null ? ' | Mean V<sub>max</sub>=' + meanVmaxB + ' kt' : '';
    var titleB = _compositeFilterSummary(filtersB, jsonB.n_cases) + vmaxNoteB +
                 '<br>Shear-Relative Quadrant Mean: ' + varInfoA.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)';
    buildQuadPlot('comp-diff-sq-b', jsonB.quadrant_means, titleB, activeColorscale, activeVmin, activeVmax, varInfoA.units, jsonB);

    // Difference
    var diffVmaxNote = '';
    if (meanVmaxA !== null || meanVmaxB !== null) {
        diffVmaxNote = ' | V\u0305<sub>max</sub>: ';
        if (meanVmaxA !== null) diffVmaxNote += '<span style="color:#60a5fa;">A=' + meanVmaxA + '</span>';
        if (meanVmaxA !== null && meanVmaxB !== null) diffVmaxNote += ', ';
        if (meanVmaxB !== null) diffVmaxNote += '<span style="color:#f59e0b;">B=' + meanVmaxB + '</span> kt';
    }
    var titleD = _diffFilterSummary(filtersA, filtersB, jsonA.n_cases, jsonB.n_cases) + diffVmaxNote +
                 '<br>\u0394 Shear-Relative Quadrant Mean: ' + varInfoA.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)';

    _registerShadingTargets('shd-dsq-d', ['comp-diff-sq-d'], _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax);
    buildQuadPlot('comp-diff-sq-d', diffJson.quadrant_means, titleD, _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax, diffVarInfo.units, diffJson);
}

// ── Composite Difference Plan View ──────────────────

function generateCompDiffPlanView() {
    var filtersA = _getCompositeFilters();
    var filtersB = _getCompGroupBFilters();
    var pvParams = _getCompositePlanViewParams();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    var coverage = parseInt(document.getElementById('comp-coverage').value) / 100;
    var overlay = (document.getElementById('comp-overlay') || {}).value || '';

    var _crp = document.getElementById('comp-result-placeholder') || document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing difference plan-view composite (A\u2212B) at ' + pvParams.level_km + ' km\u2026');

    var baseQS = '&variable=' + encodeURIComponent(variable) +
        '&data_type=' + dataType + '&coverage_min=' + coverage +
        '&level_km=' + pvParams.level_km +
        '&normalize_rmw=' + (pvParams.normalize_rmw ? 'true' : 'false') +
        '&max_r_rmw=' + pvParams.max_r_rmw +
        '&dr_rmw=' + pvParams.dr_rmw +
        '&shear_relative=' + (pvParams.shear_relative ? 'true' : 'false');
    if (overlay) baseQS += '&overlay=' + encodeURIComponent(overlay);
    var urlA = API_BASE + '/composite/plan_view?' + _compositeQueryString(filtersA) + baseQS;
    var urlB = API_BASE + '/composite/plan_view?' + _compositeQueryString(filtersB) + baseQS;

    // Sequential streaming: fetch Group A first, then Group B, to avoid
    // doubling memory/thread pressure on the server.
    var jsonA;
    return _fetchCompositeStream(urlA, 'Group A plan view').then(function(result) {
        jsonA = result;
        _showCompStatus('loading', 'Group A done (' + jsonA.n_cases + ' cases). Computing Group B\u2026');
        return _fetchCompositeStream(urlB, 'Group B plan view');
    }).then(function(jsonB) {
        var diffData = _subtractArrays2D(jsonA.plan_view, jsonB.plan_view);
        var symRange = _symmetricRange(diffData);

        var diffJson = {
            plan_view: diffData,
            x_axis: jsonA.x_axis,
            y_axis: jsonA.y_axis,
            x_label: jsonA.x_label,
            y_label: jsonA.y_label,
            level_km: jsonA.level_km,
            normalize_rmw: jsonA.normalize_rmw,
            shear_relative: jsonA.shear_relative,
            coverage_min: jsonA.coverage_min,
            n_cases: jsonA.n_cases,
            case_list: jsonA.case_list,
            case_list_b: jsonB.case_list,
            _isDiff: true,
            _nA: jsonA.n_cases,
            _nB: jsonB.n_cases,
            _filtersA: filtersA,
            _filtersB: filtersB,
            variable: {
                key: jsonA.variable.key,
                display_name: '\u0394 ' + jsonA.variable.display_name,
                units: jsonA.variable.units,
                vmin: -symRange,
                vmax: symRange,
                colorscale: _DIFF_COLORSCALE,
            }
        };
        // Overlay difference
        if (jsonA.overlay && jsonB.overlay) {
            var ovDiff = _subtractArrays2D(jsonA.overlay.plan_view, jsonB.overlay.plan_view);
            diffJson.overlay = {
                display_name: '\u0394 ' + jsonA.overlay.display_name,
                key: jsonA.overlay.key,
                units: jsonA.overlay.units,
                plan_view: ovDiff,
                vmin: jsonA.overlay.vmin,
                vmax: jsonA.overlay.vmax,
            };
        }

        _showCompStatus('success', '\u2713 Difference computed: Group A (' + jsonA.n_cases + ' cases) \u2212 Group B (' + jsonB.n_cases + ' cases)');
        _renderDiffPlanView('comp-result-pv', diffJson, jsonA, jsonB, filtersA, filtersB, pvParams);
        _showCompShadingToolbar();
    }).catch(function(err) {
        _showCompStatus('error', '\u2717 Plan View: ' + (err.message || String(err)));
    });
}

function _renderDiffPlanView(targetId, diffJson, jsonA, jsonB, filtersA, filtersB, pvParams) {
    var el = document.getElementById(targetId); if (!el) return;
    el.style.display = 'block';
    _lastCompJson = diffJson; _lastCompType = 'pv';

    var varInfoA = jsonA.variable;
    var diffVarInfo = diffJson.variable;

    // Create 3 stacked chart containers + toolbar
    el.innerHTML =
        '<div style="margin-bottom:4px;padding:6px 10px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#60a5fa;">\uD83D\uDD35 Group A</div>' +
        '<div id="comp-diff-pv-a" style="width:100%;height:520px;border-radius:8px;overflow:hidden;"></div>' +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#f59e0b;">\uD83D\uDFE0 Group B</div>' +
        '<div id="comp-diff-pv-b" style="width:100%;height:520px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-dpv-ab', {label: 'Panels A &amp; B', defaultVmin: varInfoA.vmin, defaultVmax: varInfoA.vmax}) +
        '<div style="margin:12px 0 4px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font:600 11px \'JetBrains Mono\',monospace;color:#ef4444;">\u0394 Difference (A \u2212 B)</div>' +
        '<div id="comp-diff-pv-d" style="width:100%;height:520px;border-radius:8px;overflow:hidden;"></div>' +
        _buildShadingControlsRow('shd-dpv-d', {label: 'Difference', defaultVmin: diffVarInfo.vmin, defaultVmax: diffVarInfo.vmax}) +
        _buildCompToolbar();

    _registerShadingTargets('shd-dpv-ab', ['comp-diff-pv-a', 'comp-diff-pv-b'], varInfoA.colorscale, varInfoA.vmin, varInfoA.vmax);

    var plotOpts = { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] };
    var plotBg = '#0a1628';
    var levelKm = jsonA.level_km;
    var xAxis = jsonA.x_axis, yAxis = jsonA.y_axis;
    var xLabel = jsonA.x_label, yLabel = jsonA.y_label;
    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var normLabel = jsonA.normalize_rmw ? ' (RMW-norm)' : '';
    var shearLabel = jsonA.shear_relative ? ' [Shear \u2192 Right]' : '';
    var fontSize = { title:13, axis:11, tick:10, cbar:11, cbarTick:10, hover:12 };

    // Helper: build an RMW circle scatter trace
    function rmwCircleTrace() {
        if (!jsonA.normalize_rmw) return [];
        var nPts = 120, cx = [], cy = [];
        for (var j = 0; j <= nPts; j++) {
            var a = 2 * Math.PI * j / nPts;
            cx.push(parseFloat(Math.cos(a).toFixed(4)));
            cy.push(parseFloat(Math.sin(a).toFixed(4)));
        }
        return [{ x:cx, y:cy, type:'scatter', mode:'lines', line:{color:'white',width:1.5,dash:'dash'}, showlegend:false, hoverinfo:'skip' }];
    }

    // Helper: build a shear arrow
    function shearShapes() {
        if (!jsonA.shear_relative) return { shapes:[], annotations:[] };
        return buildShearInset(90, true);
    }

    // Helper to build a single plan-view plot
    function buildPvPlot(chartId, data, titleText, colorscale, zmin, zmax, units, overlayJson) {
        // Compute tight axis range from actual non-NaN data extent
        var ext = _tightDataExtent(data, xAxis, yAxis, 0.25);
        var hm = {
            z: data, x: xAxis, y: yAxis, type: 'heatmap',
            colorscale: colorscale, zmin: zmin, zmax: zmax,
            colorbar: { title:{text:units,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:14, len:0.85 },
            hovertemplate: '%{z:.2f} ' + units + '<br>' + xLabel + ': %{x:.1f}<br>' + yLabel + ': %{y:.1f}<extra></extra>',
            hoverongaps: false
        };
        var ovTraces = overlayJson ? buildCompPlanViewOverlayContours(overlayJson, xAxis, yAxis) : [];
        var sInset = shearShapes();
        var layout = {
            title: { text:titleText, font:{color:'#e5e7eb',size:fontSize.title}, y:0.97, x:0.5, xanchor:'center' },
            paper_bgcolor:plotBg, plot_bgcolor:plotBg,
            xaxis: { title:{text:xLabel,font:{color:'#aaa',size:fontSize.axis}}, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:true, zerolinecolor:'rgba(255,255,255,0.12)', range:[ext.xMin, ext.xMax] },
            yaxis: { title:{text:yLabel,font:{color:'#aaa',size:fontSize.axis}}, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:true, zerolinecolor:'rgba(255,255,255,0.12)', scaleanchor:'x', scaleratio:1, range:[ext.yMin, ext.yMax] },
            margin:{ l:60, r:24, t:140, b:50 },
            shapes: sInset.shapes || [], annotations: sInset.annotations || [],
            hoverlabel:{ bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
            showlegend:false
        };
        Plotly.newPlot(chartId, [hm].concat(ovTraces).concat(rmwCircleTrace()), layout, plotOpts);
    }

    var activeColorscale = varInfoA.colorscale;
    var activeVmin = varInfoA.vmin;
    var activeVmax = varInfoA.vmax;

    // ── Group A plot ──
    var meanVmaxA = _computeCompositeMeanVmax(filtersA);
    var vmaxNoteA = meanVmaxA !== null ? ' | Mean V<sub>max</sub>=' + meanVmaxA + ' kt' : '';
    var titleA = _compositeFilterSummary(filtersA, jsonA.n_cases) + vmaxNoteA +
                 '<br>Plan View @ ' + levelKm + ' km: ' + varInfoA.display_name + dtypeLabel + normLabel + shearLabel;
    buildPvPlot('comp-diff-pv-a', jsonA.plan_view, titleA, activeColorscale, activeVmin, activeVmax, varInfoA.units, jsonA);

    // ── Group B plot ──
    var meanVmaxB = _computeCompositeMeanVmax(filtersB);
    var vmaxNoteB = meanVmaxB !== null ? ' | Mean V<sub>max</sub>=' + meanVmaxB + ' kt' : '';
    var titleB = _compositeFilterSummary(filtersB, jsonB.n_cases) + vmaxNoteB +
                 '<br>Plan View @ ' + levelKm + ' km: ' + varInfoA.display_name + dtypeLabel + normLabel + shearLabel;
    buildPvPlot('comp-diff-pv-b', jsonB.plan_view, titleB, activeColorscale, activeVmin, activeVmax, varInfoA.units, jsonB);

    // ── Difference plot ──
    var diffVmaxNote = '';
    if (meanVmaxA !== null || meanVmaxB !== null) {
        diffVmaxNote = ' | V\u0305<sub>max</sub>: ';
        if (meanVmaxA !== null) diffVmaxNote += '<span style="color:#60a5fa;">A=' + meanVmaxA + '</span>';
        if (meanVmaxA !== null && meanVmaxB !== null) diffVmaxNote += ', ';
        if (meanVmaxB !== null) diffVmaxNote += '<span style="color:#f59e0b;">B=' + meanVmaxB + '</span>';
    }
    var titleD = _diffFilterSummary(filtersA, filtersB, jsonA.n_cases, jsonB.n_cases) + diffVmaxNote +
                 '<br>\u0394 Plan View @ ' + levelKm + ' km: ' + varInfoA.display_name + dtypeLabel + normLabel + shearLabel;

    _registerShadingTargets('shd-dpv-d', ['comp-diff-pv-d'], _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax);
    buildPvPlot('comp-diff-pv-d', diffJson.plan_view, titleD, _DIFF_COLORSCALE, diffVarInfo.vmin, diffVarInfo.vmax, diffVarInfo.units, diffJson);
}

// ── CFAD Difference ──

function generateCompDiffCFAD() {
    var filtersA = _getCompositeFilters();
    var filtersB = _getCompGroupBFilters();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    var _crp = document.getElementById('comp-result-placeholder') || document.getElementById('wiz-result-placeholder'); if (_crp) _crp.style.display = 'none';
    _showCompStatus('loading', 'Computing CFAD difference (A\u2212B)\u2026');

    // Gather CFAD options (shared for A and B)
    var binWidth = parseFloat((document.getElementById('cfad-bin-width') || {}).value) || 0;
    var nBins = parseInt((document.getElementById('cfad-n-bins') || {}).value, 10) || 20;
    var binMinVal = (document.getElementById('cfad-bin-min') || {}).value;
    var binMaxVal = (document.getElementById('cfad-bin-max') || {}).value;
    var normalise = (document.getElementById('cfad-normalise') || {}).value || 'height';
    var minRadius = parseFloat((document.getElementById('cfad-min-radius') || {}).value) || 0;
    var maxRadius = parseFloat((document.getElementById('cfad-max-radius') || {}).value) || 200;
    var useRmw = !!(document.getElementById('cfad-use-rmw') || {}).checked;
    var quadrants = _cfadGetSelectedQuadrants();
    var isMulti = quadrants.length === 1 && quadrants[0] === 'MULTI';

    var cfadQS = '&variable=' + encodeURIComponent(variable) + '&data_type=' + dataType +
        '&min_radius=' + minRadius + '&max_radius=' + maxRadius + '&normalise=' + encodeURIComponent(normalise) +
        '&n_bins=' + nBins;
    if (useRmw) cfadQS += '&use_rmw=true';
    if (binWidth > 0) cfadQS += '&bin_width=' + binWidth;
    if (binMinVal !== '' && binMinVal !== undefined && !isNaN(parseFloat(binMinVal))) cfadQS += '&bin_min=' + parseFloat(binMinVal);
    if (binMaxVal !== '' && binMaxVal !== undefined && !isNaN(parseFloat(binMaxVal))) cfadQS += '&bin_max=' + parseFloat(binMaxVal);
    if (isMulti) {
        cfadQS += '&quadrants=MULTI';
    } else if (quadrants.length > 0) {
        cfadQS += '&quadrants=' + encodeURIComponent(quadrants.join(','));
    }

    var urlA = API_BASE + '/composite/cfad?' + _compositeQueryString(filtersA) + cfadQS;
    var urlB = API_BASE + '/composite/cfad?' + _compositeQueryString(filtersB) + cfadQS;

    var jsonA;
    return _fetchCompositeStream(urlA, 'Group A CFAD').then(function(result) {
        jsonA = result;
        _showCompStatus('loading', 'Group A done (' + jsonA.n_cases + ' cases). Computing Group B\u2026');
        return _fetchCompositeStream(urlB, 'Group B CFAD');
    }).then(function(jsonB) {
        _showCompStatus('success', '\u2713 CFAD difference computed: A (' + jsonA.n_cases + ') \u2212 B (' + jsonB.n_cases + ')');
        _updateBadgeFromResult(jsonA.n_cases);

        if (jsonA.multi && jsonB.multi) {
            _renderDiffCFADMulti('comp-result-cfad', jsonA, jsonB, filtersA, filtersB);
        } else {
            _renderDiffCFAD('comp-result-cfad', jsonA, jsonB, filtersA, filtersB);
        }
    }).catch(function(err) {
        _showCompStatus('error', '\u2717 ' + (err.message || String(err)));
    });
}

function _buildCfadHeatmap(plotData, binCenters, heightKm, zmin, zmax, colorscale, cbar, xRef, yRef, varInfo, hoverSuffix, customData, showScale) {
    var trace = {
        z: plotData, x: binCenters, y: heightKm, type: 'heatmap',
        colorscale: colorscale, zmin: zmin, zmax: zmax,
        xaxis: xRef || 'x', yaxis: yRef || 'y',
        showscale: !!showScale, hoverongaps: false
    };
    if (cbar) trace.colorbar = cbar;
    if (customData) {
        trace.customdata = customData;
        trace.hovertemplate = varInfo.display_name + ': %{x:.1f} ' + varInfo.units +
            '<br>Height: %{y:.1f} km<br>Frequency: %{customdata:.3f} ' + hoverSuffix + '<extra></extra>';
    } else {
        trace.hovertemplate = varInfo.display_name + ': %{x:.1f} ' + varInfo.units +
            '<br>Height: %{y:.1f} km<br>Frequency: %{z:.2f} ' + hoverSuffix + '<extra></extra>';
    }
    return trace;
}

function _cfadApplyLog(rawData, zMinPos) {
    var plotData = [];
    for (var h = 0; h < rawData.length; h++) {
        var row = [];
        for (var b = 0; b < rawData[h].length; b++) {
            var val = rawData[h][b];
            row.push((val === null || val <= 0) ? null : Math.log10(val));
        }
        plotData.push(row);
    }
    return plotData;
}

function _cfadSignedLog(data2d) {
    // sign(x) * log10(1 + |x|) — preserves sign, compresses magnitude
    var result = [];
    for (var h = 0; h < data2d.length; h++) {
        var row = [];
        for (var b = 0; b < data2d[h].length; b++) {
            var v = data2d[h][b];
            if (v === null || v === undefined || isNaN(v)) { row.push(null); }
            else { row.push(v >= 0 ? Math.log10(1 + v) : -Math.log10(1 + Math.abs(v))); }
        }
        result.push(row);
    }
    return result;
}

function _cfadSignedLogTicks(symRange) {
    // Build colorbar ticks for signed-log space
    // symRange is in signed-log space (the max absolute transformed value)
    var tickVals = [0], tickText = ['0'];
    // Generate nice positive/negative ticks
    var origVals = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100];
    for (var i = 0; i < origVals.length; i++) {
        var ov = origVals[i];
        var tv = Math.log10(1 + ov);
        if (tv > symRange * 1.05) break;
        tickVals.push(tv);  tickText.push('+' + ov + '%');
        tickVals.push(-tv); tickText.push('\u2212' + ov + '%');
    }
    return { vals: tickVals, text: tickText };
}

function _renderDiffCFAD(targetId, jsonA, jsonB, filtersA, filtersB) {
    var el = document.getElementById(targetId); if (!el) return;
    var binCenters = jsonA.bin_centers;
    var heightKm = jsonA.height_km;
    var varInfo = jsonA.variable;
    var normLabel = jsonA.norm_label;
    var cfadColorscale = jsonA.cfad_colorscale || 'RdYlBu';
    var useLog = !!(document.getElementById('cfad-log-scale') || {}).checked;
    var fontSize = { title:13, axis:11, tick:9, cbar:11, cbarTick:9, hover:12 };

    // Compute difference (no log for diff — subtract raw percentages)
    var diffData = _subtractArrays2D(jsonA.cfad, jsonB.cfad);
    var symRange = _symmetricRange(diffData);

    // For groups A and B, find shared z range
    var gZmax = 0, gZminPos = Infinity;
    [jsonA.cfad, jsonB.cfad].forEach(function(data) {
        for (var h = 0; h < data.length; h++) {
            for (var b = 0; b < data[h].length; b++) {
                var v = data[h][b];
                if (v !== null && v > gZmax) gZmax = v;
                if (v !== null && v > 0 && v < gZminPos) gZminPos = v;
            }
        }
    });
    if (gZmax === 0) gZmax = 1;
    if (gZminPos === Infinity) gZminPos = 0.001;

    // Determine A/B plot params
    var plotZmin, plotZmax, cbarTitle;
    var cbarTickVals, cbarTickText;
    if (useLog) {
        plotZmin = Math.log10(Math.max(gZminPos * 0.5, 1e-6));
        plotZmax = Math.log10(gZmax);
        cbarTickVals = []; cbarTickText = [];
        for (var p = Math.floor(plotZmin); p <= Math.ceil(plotZmax); p++) {
            var tv = Math.pow(10, p);
            cbarTickVals.push(p);
            if (normLabel === 'count') cbarTickText.push(tv >= 1 ? String(Math.round(tv)) : tv.toExponential(0));
            else if (tv >= 1) cbarTickText.push(tv.toFixed(0) + '%');
            else if (tv >= 0.1) cbarTickText.push(tv.toFixed(1) + '%');
            else if (tv >= 0.01) cbarTickText.push(tv.toFixed(2) + '%');
            else cbarTickText.push(tv.toExponential(0) + '%');
        }
        cbarTitle = normLabel + ' (log\u2081\u2080)';
    } else {
        plotZmin = 0; plotZmax = gZmax;
        cbarTitle = normLabel;
    }

    var plotBg = '#0a1628';
    var radialNote = '';
    if (jsonA.radial_domain) {
        var rUnit = jsonA.use_rmw ? ' R/RMW' : ' km';
        radialNote = ' | R=' + jsonA.radial_domain[0] + '\u2013' + jsonA.radial_domain[1] + rUnit;
    }
    var quadNote = '';
    if (jsonA.quadrants && jsonA.quadrants.length > 0) quadNote = ' | ' + jsonA.quadrants.join('+');
    var binNote = ' | Bin=' + jsonA.bin_width + ' ' + varInfo.units;

    // Build 3 panels: A, B, Difference
    var panels = ['A', 'B', 'Diff'];
    var panelHtml = '';
    for (var pi = 0; pi < 3; pi++) {
        panelHtml += '<div id="comp-diff-cfad-' + panels[pi].toLowerCase() + '" style="width:100%;height:460px;border-radius:8px;overflow:hidden;margin-bottom:8px;"></div>';
    }

    el.style.display = 'block';
    jsonA._isDiff = true; jsonA.case_list_b = jsonB.case_list; jsonA._nA = jsonA.n_cases; jsonA._nB = jsonB.n_cases;
    _lastCompJson = jsonA; _lastCompType = 'cfad_diff';
    el.innerHTML = panelHtml +
        _buildShadingControlsRow('shd-dcfad-ab', {label: 'Panels A &amp; B', defaultVmin: plotZmin, defaultVmax: plotZmax}) +
        _buildShadingControlsRow('shd-dcfad-d', {label: 'Difference', defaultVmin: 'min', defaultVmax: 'max'}) +
        _buildCompToolbar();

    _registerShadingTargets('shd-dcfad-ab', ['comp-diff-cfad-a', 'comp-diff-cfad-b'], cfadColorscale, plotZmin, plotZmax);

    // Render A
    var dataA = useLog ? _cfadApplyLog(jsonA.cfad) : jsonA.cfad;
    var cbarA = { title:{text:cbarTitle,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:12, len:0.85 };
    if (useLog && cbarTickVals) { cbarA.tickvals = cbarTickVals; cbarA.ticktext = cbarTickText; }
    var trA = _buildCfadHeatmap(dataA, binCenters, heightKm, plotZmin, plotZmax, cfadColorscale, cbarA, 'x', 'y', varInfo, normLabel, useLog ? jsonA.cfad : null, true);
    var titleA = '<span style="color:#60a5fa;">Group A</span> (N=' + jsonA.n_cases + ')' + binNote + radialNote + quadNote;
    var layA = { title:{text:titleA,font:{color:'#e5e7eb',size:fontSize.title},y:0.97,x:0.5,xanchor:'center'}, paper_bgcolor:plotBg, plot_bgcolor:plotBg,
        xaxis:{title:{text:varInfo.display_name+' ('+varInfo.units+')',font:{color:'#aaa',size:fontSize.axis}},tickfont:{color:'#aaa',size:fontSize.tick},gridcolor:'rgba(255,255,255,0.04)',zeroline:false},
        yaxis:{title:{text:'Height (km)',font:{color:'#aaa',size:fontSize.axis}},tickfont:{color:'#aaa',size:fontSize.tick},gridcolor:'rgba(255,255,255,0.04)',zeroline:false},
        margin:{l:55,r:24,t:80,b:50}, hoverlabel:{bgcolor:'#1f2937',font:{color:'#e5e7eb',size:fontSize.hover}}, showlegend:false };
    Plotly.newPlot('comp-diff-cfad-a', [trA], layA, {responsive:true,displayModeBar:false});

    // Render B
    var dataB = useLog ? _cfadApplyLog(jsonB.cfad) : jsonB.cfad;
    var cbarB = { title:{text:cbarTitle,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:12, len:0.85 };
    if (useLog && cbarTickVals) { cbarB.tickvals = cbarTickVals; cbarB.ticktext = cbarTickText; }
    var trB = _buildCfadHeatmap(dataB, binCenters, heightKm, plotZmin, plotZmax, cfadColorscale, cbarB, 'x', 'y', varInfo, normLabel, useLog ? jsonB.cfad : null, true);
    var titleB = '<span style="color:#f59e0b;">Group B</span> (N=' + jsonB.n_cases + ')' + binNote + radialNote + quadNote;
    var layB = JSON.parse(JSON.stringify(layA));
    layB.title.text = titleB;
    Plotly.newPlot('comp-diff-cfad-b', [trB], layB, {responsive:true,displayModeBar:false});

    // Render Difference — apply signed log transform if log-scale enabled
    var diffPlotData, diffZmin, diffZmax, diffCbarTitle, diffCustomData = null;
    if (useLog) {
        diffPlotData = _cfadSignedLog(diffData);
        diffCustomData = diffData;
        var sLogMax = 0;
        for (var dh = 0; dh < diffPlotData.length; dh++) {
            for (var db = 0; db < diffPlotData[dh].length; db++) {
                var dv = diffPlotData[dh][db];
                if (dv !== null && Math.abs(dv) > sLogMax) sLogMax = Math.abs(dv);
            }
        }
        if (sLogMax === 0) sLogMax = 1;
        diffZmin = -sLogMax; diffZmax = sLogMax;
        diffCbarTitle = '\u0394 ' + normLabel + ' (signed log)';
    } else {
        diffPlotData = diffData;
        diffZmin = -symRange; diffZmax = symRange;
        diffCbarTitle = '\u0394 ' + normLabel;
    }

    var cbarD = { title:{text:diffCbarTitle,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:12, len:0.85 };
    if (useLog) {
        var slTicks = _cfadSignedLogTicks(diffZmax);
        cbarD.tickvals = slTicks.vals; cbarD.ticktext = slTicks.text;
    }
    var trD = _buildCfadHeatmap(diffPlotData, binCenters, heightKm, diffZmin, diffZmax, _DIFF_COLORSCALE, cbarD, 'x', 'y', varInfo,
        '\u0394 ' + normLabel, diffCustomData, true);
    var titleD = _diffFilterSummary(filtersA, filtersB, jsonA.n_cases, jsonB.n_cases) +
        '<br>\u0394 CFAD: ' + varInfo.display_name + binNote + radialNote + quadNote + (useLog ? ' (signed log)' : '');
    var layD = JSON.parse(JSON.stringify(layA));
    layD.title.text = titleD;

    _registerShadingTargets('shd-dcfad-d', ['comp-diff-cfad-diff'], _DIFF_COLORSCALE, diffZmin, diffZmax);
    Plotly.newPlot('comp-diff-cfad-diff', [trD], layD, {responsive:true,displayModeBar:true,displaylogo:false,modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines']});
}

function _renderDiffCFADMulti(targetId, jsonA, jsonB, filtersA, filtersB) {
    var el = document.getElementById(targetId); if (!el) return;
    var binCenters = jsonA.bin_centers;
    var heightKm = jsonA.height_km;
    var varInfo = jsonA.variable;
    var normLabel = jsonA.norm_label;
    var cfadColorscale = jsonA.cfad_colorscale || 'RdYlBu';
    var useLog = !!(document.getElementById('cfad-log-scale') || {}).checked;
    var fontSize = { title:12, axis:10, tick:9, cbar:10, cbarTick:9, hover:11 };
    // Shear vector points right: USL/DSL top, USR/DSR bottom
    var quadOrder = ['USL', 'DSL', 'USR', 'DSR'];
    var quadLabels = { 'USL': 'Upshear Left', 'USR': 'Upshear Right', 'DSL': 'Downshear Left', 'DSR': 'Downshear Right' };

    // Compute differences per quadrant
    var diffMulti = {};
    for (var qi = 0; qi < quadOrder.length; qi++) {
        var qn = quadOrder[qi];
        if (jsonA.cfad_multi[qn] && jsonB.cfad_multi[qn]) {
            diffMulti[qn] = _subtractArrays2D(jsonA.cfad_multi[qn], jsonB.cfad_multi[qn]);
        }
    }

    // Global z-range for A/B panels
    var gZmax = 0, gZminPos = Infinity;
    [jsonA.cfad_multi, jsonB.cfad_multi].forEach(function(multi) {
        for (var qi2 = 0; qi2 < quadOrder.length; qi2++) {
            var data = multi[quadOrder[qi2]];
            if (!data) continue;
            for (var h = 0; h < data.length; h++) {
                for (var b = 0; b < data[h].length; b++) {
                    var v = data[h][b];
                    if (v !== null && v > gZmax) gZmax = v;
                    if (v !== null && v > 0 && v < gZminPos) gZminPos = v;
                }
            }
        }
    });
    if (gZmax === 0) gZmax = 1;
    if (gZminPos === Infinity) gZminPos = 0.001;

    // Symmetric range for diff
    var allDiffVals = [];
    for (var qi3 = 0; qi3 < quadOrder.length; qi3++) {
        var dd = diffMulti[quadOrder[qi3]];
        if (!dd) continue;
        for (var h2 = 0; h2 < dd.length; h2++) {
            for (var b2 = 0; b2 < dd[h2].length; b2++) {
                if (dd[h2][b2] !== null) allDiffVals.push(dd[h2][b2]);
            }
        }
    }
    var symRange = _symmetricRange([allDiffVals]);

    var plotZmin, plotZmax, cbarTitle, cbarTickVals, cbarTickText;
    if (useLog) {
        plotZmin = Math.log10(Math.max(gZminPos * 0.5, 1e-6));
        plotZmax = Math.log10(gZmax);
        cbarTickVals = []; cbarTickText = [];
        for (var p = Math.floor(plotZmin); p <= Math.ceil(plotZmax); p++) {
            var tv = Math.pow(10, p);
            cbarTickVals.push(p);
            if (normLabel === 'count') cbarTickText.push(tv >= 1 ? String(Math.round(tv)) : tv.toExponential(0));
            else if (tv >= 1) cbarTickText.push(tv.toFixed(0) + '%');
            else if (tv >= 0.1) cbarTickText.push(tv.toFixed(1) + '%');
            else cbarTickText.push(tv.toExponential(0) + '%');
        }
        cbarTitle = normLabel + ' (log\u2081\u2080)';
    } else {
        plotZmin = 0; plotZmax = gZmax;
        cbarTitle = normLabel;
    }

    var plotBg = '#0a1628';
    var radialNote = '';
    if (jsonA.radial_domain) {
        var rUnit = jsonA.use_rmw ? ' R/RMW' : ' km';
        radialNote = ' | R=' + jsonA.radial_domain[0] + '\u2013' + jsonA.radial_domain[1] + rUnit;
    }
    var binNote = ' | Bin=' + jsonA.bin_width + ' ' + varInfo.units;

    // Create 3 chart containers: A (2x2), B (2x2), Diff (2x2)
    el.style.display = 'block';
    jsonA._isDiff = true; jsonA.case_list_b = jsonB.case_list; jsonA._nA = jsonA.n_cases; jsonA._nB = jsonB.n_cases;
    _lastCompJson = jsonA; _lastCompType = 'cfad_diff_multi';
    el.innerHTML =
        '<div id="comp-diff-cfadm-a" style="width:100%;height:720px;border-radius:8px;overflow:hidden;margin-bottom:8px;"></div>' +
        '<div id="comp-diff-cfadm-b" style="width:100%;height:720px;border-radius:8px;overflow:hidden;margin-bottom:8px;"></div>' +
        _buildShadingControlsRow('shd-dcfadm-ab', {label: 'Panels A &amp; B', defaultVmin: plotZmin, defaultVmax: plotZmax}) +
        '<div id="comp-diff-cfadm-diff" style="width:100%;height:720px;border-radius:8px;overflow:hidden;margin-bottom:8px;"></div>' +
        _buildShadingControlsRow('shd-dcfadm-d', {label: 'Difference', defaultVmin: 'min', defaultVmax: 'max'}) +
        _buildCompToolbar();

    _registerShadingTargets('shd-dcfadm-ab', ['comp-diff-cfadm-a', 'comp-diff-cfadm-b'], cfadColorscale, plotZmin, plotZmax);

    // Helper: build 2x2 subplot for a set of 4 quadrant CFADs
    // diffSignedLog: if true, apply signed log transform to data and use custom ticks
    function build2x2(chartId, multiData, titleText, colorscale, zMin, zMax, cbarObj, isLog, isDiff, diffSignedLog) {
        var traces = [];
        var anns = [];
        for (var si = 0; si < quadOrder.length; si++) {
            var qk = quadOrder[si];
            var raw = multiData[qk];
            if (!raw) continue;
            var pData, cData = null;
            if (diffSignedLog) {
                pData = _cfadSignedLog(raw);
                cData = raw;
            } else if (isLog && !isDiff) {
                pData = _cfadApplyLog(raw);
                cData = raw;
            } else {
                pData = raw;
            }
            var xR = 'x' + (si === 0 ? '' : String(si + 1));
            var yR = 'y' + (si === 0 ? '' : String(si + 1));
            var showCbar = (si === 1);
            var cb = showCbar ? JSON.parse(JSON.stringify(cbarObj)) : null;
            var tr = {
                z: pData, x: binCenters, y: heightKm, type: 'heatmap',
                colorscale: colorscale, zmin: zMin, zmax: zMax,
                xaxis: xR, yaxis: yR, showscale: showCbar, hoverongaps: false
            };
            if (cb) { cb.x = 1.02; tr.colorbar = cb; }
            if (cData) {
                tr.customdata = cData;
                tr.hovertemplate = '<b>' + quadLabels[qk] + '</b><br>' + varInfo.display_name + ': %{x:.1f} ' + varInfo.units +
                    '<br>Height: %{y:.1f} km<br>Freq: %{customdata:.3f} ' + (isDiff ? '\u0394 ' : '') + normLabel + '<extra></extra>';
            } else {
                tr.hovertemplate = '<b>' + quadLabels[qk] + '</b><br>' + varInfo.display_name + ': %{x:.1f} ' + varInfo.units +
                    '<br>Height: %{y:.1f} km<br>Freq: %{z:.2f} ' + (isDiff ? '\u0394 ' : '') + normLabel + '<extra></extra>';
            }
            traces.push(tr);
            anns.push({
                text: '<b>' + quadLabels[qk] + '</b>', showarrow: false,
                xref: xR + ' domain', yref: yR + ' domain',
                x: 0.5, y: 1.08, font: {size:11, color:'#e5e7eb'}, xanchor:'center', yanchor:'bottom'
            });
        }
        var layout = {
            title: { text: titleText, font:{color:'#e5e7eb',size:fontSize.title}, y:0.98, x:0.5, xanchor:'center' },
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            grid: { rows:2, columns:2, pattern:'independent', xgap:0.08, ygap:0.12 },
            annotations: anns,
            margin: { l:55, r:60, t:140, b:50 },
            hoverlabel: { bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
            showlegend: false
        };
        var axNames = [['xaxis','yaxis'],['xaxis2','yaxis2'],['xaxis3','yaxis3'],['xaxis4','yaxis4']];
        for (var ai = 0; ai < axNames.length; ai++) {
            var isBottom = ai >= 2, isLeft = ai % 2 === 0;
            layout[axNames[ai][0]] = {
                title: isBottom ? {text:varInfo.display_name+' ('+varInfo.units+')',font:{color:'#aaa',size:fontSize.axis}} : undefined,
                tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false
            };
            layout[axNames[ai][1]] = {
                title: isLeft ? {text:'Height (km)',font:{color:'#aaa',size:fontSize.axis}} : undefined,
                tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false
            };
        }
        Plotly.newPlot(chartId, traces, layout, {responsive:true, displayModeBar: isDiff, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines']});
    }

    // Render A
    var cbarAB = { title:{text:cbarTitle,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:12, len:0.9 };
    if (useLog && cbarTickVals) { cbarAB.tickvals = cbarTickVals; cbarAB.ticktext = cbarTickText; }
    build2x2('comp-diff-cfadm-a', jsonA.cfad_multi,
        '<span style="color:#60a5fa;">Group A</span> (N=' + jsonA.n_cases + ') | 4-Quadrant CFAD' + binNote + radialNote,
        cfadColorscale, plotZmin, plotZmax, cbarAB, useLog, false, false);

    // Render B
    build2x2('comp-diff-cfadm-b', jsonB.cfad_multi,
        '<span style="color:#f59e0b;">Group B</span> (N=' + jsonB.n_cases + ') | 4-Quadrant CFAD' + binNote + radialNote,
        cfadColorscale, plotZmin, plotZmax, cbarAB, useLog, false, false);

    // Render Difference — apply signed log if log-scale enabled
    var diffDZmin, diffDZmax, diffCbarTitle;
    var diffSignedLog = useLog;
    if (diffSignedLog) {
        // Compute signed-log range across all quadrant diffs
        var sLogMax = 0;
        for (var qi4 = 0; qi4 < quadOrder.length; qi4++) {
            var dq = diffMulti[quadOrder[qi4]];
            if (!dq) continue;
            var slData = _cfadSignedLog(dq);
            for (var sh = 0; sh < slData.length; sh++) {
                for (var sb = 0; sb < slData[sh].length; sb++) {
                    var sv = slData[sh][sb];
                    if (sv !== null && Math.abs(sv) > sLogMax) sLogMax = Math.abs(sv);
                }
            }
        }
        if (sLogMax === 0) sLogMax = 1;
        diffDZmin = -sLogMax; diffDZmax = sLogMax;
        diffCbarTitle = '\u0394 ' + normLabel + ' (signed log)';
    } else {
        diffDZmin = -symRange; diffDZmax = symRange;
        diffCbarTitle = '\u0394 ' + normLabel;
    }
    var cbarDiff = { title:{text:diffCbarTitle,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:12, len:0.9 };
    if (diffSignedLog) {
        var slTicks = _cfadSignedLogTicks(diffDZmax);
        cbarDiff.tickvals = slTicks.vals; cbarDiff.ticktext = slTicks.text;
    }

    _registerShadingTargets('shd-dcfadm-d', ['comp-diff-cfadm-diff'], _DIFF_COLORSCALE, diffDZmin, diffDZmax);
    build2x2('comp-diff-cfadm-diff', diffMulti,
        _diffFilterSummary(filtersA, filtersB, jsonA.n_cases, jsonB.n_cases) + '<br>\u0394 4-Quadrant CFAD: ' + varInfo.display_name + binNote + radialNote + (diffSignedLog ? ' (signed log)' : ''),
        _DIFF_COLORSCALE, diffDZmin, diffDZmax, cbarDiff, false, true, diffSignedLog);
}

// ══════════════════════════════════════════════════════════════
// Environmental Composite Functions
// ══════════════════════════════════════════════════════════════

function _switchCompTab(tab) {
    // Tab system replaced by wizard steps. No-op for backward compatibility.
    // Results now display in unified Step 4.
}

function _showEnvCompStatus(cls, msg) {
    var el = document.getElementById('comp-env-status');
    if (!el) return;
    el.style.display = 'block';
    el.className = 'explorer-status ' + cls;
    el.innerHTML = msg;
}

// ── Main generation function ──
function generateEnvComposite() {
    var filters = _getCompositeFilters();
    var dataType = document.getElementById('comp-dtype').value || 'swath';
    var field = document.getElementById('comp-env-field').value || 'shear_mag';
    var includeVec = document.getElementById('comp-env-vectors').checked;
    var envShearRel = !!(document.getElementById('comp-env-shear-rel') || {}).checked;
    var radiusKm = parseInt(document.getElementById('comp-env-radius').value) || 500;
    var qs = _compositeQueryString(filters) + '&data_type=' + dataType;

    // Switch to env tab and show loading
    _switchCompTab('env');
    var _cep = document.getElementById('comp-env-placeholder') || document.getElementById('wiz-result-placeholder'); if (_cep) _cep.style.display = 'none';
    _showEnvCompStatus('loading', '\u23F3 Computing environmental composites\u2026');

    // Hide previous results
    ['comp-env-scalars', 'comp-env-plan-view', 'comp-env-thermo-row'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    // Serialize requests: run the heavy plan view first, then profiles + scalars.
    // This avoids queuing multiple heavy requests on the single-worker backend.
    var planViewUrl = API_BASE + '/composite/era5_plan_view?' + qs +
        '&field=' + field + '&radius_km=' + radiusKm + '&include_vectors=' + includeVec +
        '&shear_relative=' + envShearRel;
    var profilesUrl = API_BASE + '/composite/era5_profiles?' + qs;
    var scalarsUrl = API_BASE + '/composite/era5_scalars?' + qs;

    var pvData, profData, scalarData;

    _fetchCompositeStream(planViewUrl, 'Computing ERA5 plan view').then(function(pv) {
        pvData = pv;
        _showEnvCompStatus('loading', '\u23F3 Plan view done. Computing profiles & scalars\u2026');
        // Profiles and scalars are lightweight — safe to run in parallel
        return Promise.all([
            _fetchWithTimeout(profilesUrl).then(function(r) { return r.ok ? r.json() : null; }),
            _fetchWithTimeout(scalarsUrl).then(function(r) { return r.ok ? r.json() : null; })
        ]);
    }).then(function(results) {
        profData = results[0];
        scalarData = results[1];
        var nCases = (pvData && pvData.n_cases) || (profData && profData.n_cases) || (scalarData && scalarData.n_cases) || 0;

        if (!pvData && !profData && !scalarData) {
            _showEnvCompStatus('error', '\u2717 No environmental data available for matching cases.');
            return;
        }

        _updateBadgeFromResult(nCases);
        var summary = _compositeFilterSummary(filters, nCases);
        _showEnvCompStatus('', '\u2713 ' + summary);

        if (scalarData) renderEnvCompositeScalars(scalarData);
        if (pvData) renderEnvCompositePlanView(pvData, filters);
        if (profData) renderEnvCompositeThermo(profData, filters);
    }).catch(function(err) {
        _showEnvCompStatus('error', '\u2717 Error: ' + err.message);
    });
}

// ── Scalar cards rendering ──
function renderEnvCompositeScalars(data) {
    var container = document.getElementById('comp-env-scalars');
    if (!container || !data.scalars) return;
    container.style.display = 'block';

    var html = '<div class="comp-env-section-title">\uD83D\uDCCA Scalar Diagnostics <span style="font-size:10px;color:#6b7280;">(N=' + data.n_cases + ')</span></div>';
    html += '<div class="env-comp-scalars-grid">';

    var order = ['shear_mag_env', 'rh_mid_env', 'sst_env', 'chi_m', 'v_pi', 'vent_index', 'div200_env', 'shear_dir_env'];
    for (var i = 0; i < order.length; i++) {
        var key = order[i];
        var s = data.scalars[key];
        if (!s) continue;

        var highlightClass = '';
        if (key === 'shear_mag_env') highlightClass = s.mean > 10 ? 'highlight-bad' : s.mean > 5 ? 'highlight-warn' : 'highlight-good';
        else if (key === 'rh_mid_env') highlightClass = s.mean > 60 ? 'highlight-good' : s.mean > 40 ? 'highlight-warn' : 'highlight-bad';
        else if (key === 'sst_env') highlightClass = s.mean > 28 ? 'highlight-good' : s.mean > 26 ? 'highlight-warn' : 'highlight-bad';

        html += '<div class="env-scard ' + highlightClass + '" data-scalar-key="' + key + '" onclick="_toggleScalarBoxWhisker(this, \'' + key + '\')" style="cursor:pointer;" title="Click for box-whisker">';
        html += '<div class="env-scard-value">' + s.mean + '</div>';
        html += '<div class="env-scard-unit">\u00b1 ' + s.std + ' ' + s.units + '</div>';
        html += '<div class="env-scard-label">' + s.display_name + '</div>';
        html += '<div class="env-scard-sub">med: ' + s.median + ' | IQR: ' + s.p25 + '\u2013' + s.p75 + '</div>';
        html += '</div>';
    }
    html += '</div>';
    html += '<div id="comp-env-boxwhisker" style="display:none;height:200px;margin-top:8px;"></div>';
    container.innerHTML = html;

    // Store scalar data for box-whisker expansion
    container._scalarData = data.scalars;
}

var _activeBoxWhiskerKey = null;
function _toggleScalarBoxWhisker(card, key) {
    var container = document.getElementById('comp-env-boxwhisker');
    var scalarsEl = document.getElementById('comp-env-scalars');
    if (!container || !scalarsEl || !scalarsEl._scalarData) return;

    if (_activeBoxWhiskerKey === key) {
        container.style.display = 'none';
        _activeBoxWhiskerKey = null;
        return;
    }
    _activeBoxWhiskerKey = key;
    var s = scalarsEl._scalarData[key];
    if (!s || !s.values) return;

    container.style.display = 'block';
    var trace = {
        y: s.values,
        type: 'box',
        name: s.display_name,
        marker: { color: 'rgba(0,212,255,0.6)' },
        line: { color: '#00d4ff' },
        boxpoints: 'outliers',
        jitter: 0.3,
        pointpos: -1.5
    };
    var layout = {
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0f2140',
        font: { color: '#e2e8f0', family: 'DM Sans, sans-serif', size: 11 },
        margin: { t: 30, b: 30, l: 50, r: 20 },
        yaxis: { title: s.display_name + ' (' + s.units + ')', gridcolor: 'rgba(255,255,255,0.06)' },
        showlegend: false
    };
    Plotly.newPlot(container, [trace], layout, { responsive: true, displayModeBar: false });
}

// ── Plan-view composite rendering ──
function renderEnvCompositePlanView(data, filters) {
    var container = document.getElementById('comp-env-plan-view');
    if (!container) return;
    container.style.display = 'block';
    container.innerHTML = '<div id="comp-env-pv-plot" style="width:100%;height:500px;"></div>';

    var cfg = data.field_config || {};
    var colorscale = cfg.colorscale || 'Viridis';
    var traces = [];

    // Main heatmap
    traces.push({
        z: data.mean, x: data.x_km, y: data.y_km,
        type: 'heatmap',
        colorscale: colorscale,
        zmin: cfg.vmin, zmax: cfg.vmax,
        colorbar: { title: cfg.units || '', titleside: 'right', thickness: 14, len: 0.8 },
        hovertemplate: '%{z:.2f} ' + (cfg.units || '') + '<br>x: %{x} km<br>y: %{y} km<extra></extra>'
    });

    // Vector arrows overlay
    if (data.vectors) {
        var stride = data.vectors.stride || 1;
        var xSub = [], ySub = [], uArr = [], vArr = [];
        var vU = data.vectors.u, vV = data.vectors.v;
        for (var j = 0; j < vU.length; j++) {
            for (var k = 0; k < vU[j].length; k++) {
                if (vU[j][k] !== null && vV[j][k] !== null) {
                    xSub.push(data.x_km[k * stride]);
                    ySub.push(data.y_km[j * stride]);
                    var u = vU[j][k], v = vV[j][k];
                    var mag = Math.sqrt(u * u + v * v);
                    var scale = 35;
                    uArr.push(u / Math.max(mag, 0.01) * scale);
                    vArr.push(v / Math.max(mag, 0.01) * scale);
                }
            }
        }
        // Draw arrows as annotation arrows
        var annotations = [];
        for (var a = 0; a < xSub.length; a++) {
            annotations.push({
                x: xSub[a] + uArr[a], y: ySub[a] + vArr[a],
                ax: xSub[a], ay: ySub[a],
                xref: 'x', yref: 'y', axref: 'x', ayref: 'y',
                showarrow: true,
                arrowhead: 2, arrowsize: 1, arrowwidth: 1.5,
                arrowcolor: 'rgba(255,255,255,0.6)'
            });
        }
    }

    // TC center marker
    traces.push({
        x: [0], y: [0], mode: 'markers',
        marker: { symbol: 'x', size: 12, color: '#fff', line: { width: 1 } },
        showlegend: false, hoverinfo: 'skip'
    });

    var shearRel = data.shear_relative;
    var shearLabel = shearRel ? ' [Shear \u2192 Right]' : '';
    var title = (cfg.display_name || data.field) + ' Composite (N=' + data.n_cases + ')' + shearLabel;
    var xLabel = shearRel ? 'Downshear Left/Right (km)' : 'East\u2013West (km)';
    var yLabel = shearRel ? 'Upshear/Downshear (km)' : 'North\u2013South (km)';
    var shearAnnotations = [];
    if (shearRel) {
        // Shear arrow pointing right
        shearAnnotations.push({
            x: 0.97, y: 0.97, xref: 'paper', yref: 'paper',
            text: 'Shear \u2192', font: { size: 12, color: '#fbbf24', family: 'JetBrains Mono, monospace' },
            showarrow: false, xanchor: 'right', yanchor: 'top',
            bgcolor: 'rgba(0,0,0,0.5)', borderpad: 3
        });
    }
    var layout = {
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0f2140',
        font: { color: '#e2e8f0', family: 'DM Sans, sans-serif', size: 11 },
        title: { text: title, font: { size: 13 } },
        xaxis: { title: xLabel, gridcolor: 'rgba(255,255,255,0.06)', zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)' },
        yaxis: { title: yLabel, gridcolor: 'rgba(255,255,255,0.06)', scaleanchor: 'x', zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)' },
        margin: { t: 50, b: 50, l: 60, r: 20 },
        annotations: (annotations || []).concat(shearAnnotations)
    };

    Plotly.newPlot('comp-env-pv-plot', traces, layout, { responsive: true });
}

// ── Composite Skew-T + Hodograph rendering ──
function renderEnvCompositeThermo(profData, filters) {
    var thermoRow = document.getElementById('comp-env-thermo-row');
    if (!thermoRow) return;
    thermoRow.style.display = 'flex';

    renderCompositeSkewT(profData);
    renderCompositeHodograph(profData);
}

// ── Composite Skew-T with mean ± 1σ envelope ──
function renderCompositeSkewT(profData) {
    var container = document.getElementById('comp-env-skewt');
    if (!container) return;
    container.innerHTML = '<div id="comp-env-skewt-plot" style="width:100%;height:520px;"></div>';

    var plev = profData.plev;
    var tMean = profData.t.mean;
    var tStd = profData.t.std;
    var tdMean = profData.td.mean;
    var tdStd = profData.td.std;
    var nCases = profData.n_cases;

    // Skew-T coordinate: skewX = T_C + skewFactor * log10(1000/p)
    var skewFactor = 70;
    function skewX(tc, p) { return tc + skewFactor * Math.log10(1000 / p); }

    // Convert K to C
    function kToC(k) { return k !== null ? k - 273.15 : null; }

    var traces = [];

    // Background isotherms
    for (var iso = -80; iso <= 50; iso += 10) {
        var isoX = [], isoY = [];
        for (var pp = 1050; pp >= 100; pp -= 10) {
            isoX.push(skewX(iso, pp));
            isoY.push(pp);
        }
        traces.push({
            x: isoX, y: isoY, mode: 'lines',
            line: { color: iso === 0 ? 'rgba(0,212,255,0.4)' : 'rgba(100,150,200,0.15)', width: iso === 0 ? 1.5 : 0.5 },
            showlegend: false, hoverinfo: 'skip'
        });
    }

    // ±1σ envelope for Temperature (red shading)
    var tUpperX = [], tUpperY = [], tLowerX = [], tLowerY = [];
    for (var i = 0; i < plev.length; i++) {
        if (tMean[i] !== null && tStd[i] !== null) {
            var tc = kToC(tMean[i]);
            var sd = tStd[i];
            tUpperX.push(skewX(tc + sd, plev[i]));
            tUpperY.push(plev[i]);
        }
    }
    for (var i = plev.length - 1; i >= 0; i--) {
        if (tMean[i] !== null && tStd[i] !== null) {
            var tc = kToC(tMean[i]);
            var sd = tStd[i];
            tLowerX.push(skewX(tc - sd, plev[i]));
            tLowerY.push(plev[i]);
        }
    }
    if (tUpperX.length > 0) {
        traces.push({
            x: tUpperX.concat(tLowerX), y: tUpperY.concat(tLowerY),
            fill: 'toself', fillcolor: 'rgba(255,80,80,0.15)',
            line: { color: 'transparent' }, showlegend: false, hoverinfo: 'skip'
        });
    }

    // ±1σ envelope for Dewpoint (blue shading)
    var tdUpperX = [], tdUpperY = [], tdLowerX = [], tdLowerY = [];
    for (var i = 0; i < plev.length; i++) {
        if (tdMean[i] !== null && tdStd[i] !== null) {
            var tdc = kToC(tdMean[i]);
            var sd = tdStd[i];
            tdUpperX.push(skewX(tdc + sd, plev[i]));
            tdUpperY.push(plev[i]);
        }
    }
    for (var i = plev.length - 1; i >= 0; i--) {
        if (tdMean[i] !== null && tdStd[i] !== null) {
            var tdc = kToC(tdMean[i]);
            var sd = tdStd[i];
            tdLowerX.push(skewX(tdc - sd, plev[i]));
            tdLowerY.push(plev[i]);
        }
    }
    if (tdUpperX.length > 0) {
        traces.push({
            x: tdUpperX.concat(tdLowerX), y: tdUpperY.concat(tdLowerY),
            fill: 'toself', fillcolor: 'rgba(80,150,255,0.15)',
            line: { color: 'transparent' }, showlegend: false, hoverinfo: 'skip'
        });
    }

    // Mean temperature line
    var tLineX = [], tLineY = [];
    for (var i = 0; i < plev.length; i++) {
        if (tMean[i] !== null) {
            tLineX.push(skewX(kToC(tMean[i]), plev[i]));
            tLineY.push(plev[i]);
        }
    }
    traces.push({
        x: tLineX, y: tLineY, mode: 'lines',
        line: { color: '#ff4444', width: 2.5 },
        name: 'T (mean)', hovertemplate: '%{text}\u00b0C @ %{y} hPa<extra></extra>',
        text: plev.map(function(p, i) { return tMean[i] !== null ? kToC(tMean[i]).toFixed(1) : ''; })
    });

    // Mean dewpoint line
    var tdLineX = [], tdLineY = [];
    for (var i = 0; i < plev.length; i++) {
        if (tdMean[i] !== null) {
            tdLineX.push(skewX(kToC(tdMean[i]), plev[i]));
            tdLineY.push(plev[i]);
        }
    }
    traces.push({
        x: tdLineX, y: tdLineY, mode: 'lines',
        line: { color: '#4488ff', width: 2.5 },
        name: 'Td (mean)', hovertemplate: '%{text}\u00b0C @ %{y} hPa<extra></extra>',
        text: plev.map(function(p, i) { return tdMean[i] !== null ? kToC(tdMean[i]).toFixed(1) : ''; })
    });

    var layout = {
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0f2140',
        font: { color: '#e2e8f0', family: 'DM Sans, sans-serif', size: 10 },
        title: { text: 'Composite Skew-T (N=' + nCases + ')', font: { size: 12 } },
        xaxis: {
            range: [-40, 90], showticklabels: false,
            gridcolor: 'rgba(255,255,255,0.04)', zeroline: false
        },
        yaxis: {
            type: 'log', autorange: 'reversed',
            range: [Math.log10(1050), Math.log10(100)],
            title: 'Pressure (hPa)',
            tickvals: [1000, 850, 700, 500, 300, 200, 100],
            ticktext: ['1000', '850', '700', '500', '300', '200', '100'],
            gridcolor: 'rgba(255,255,255,0.08)'
        },
        margin: { t: 40, b: 40, l: 50, r: 10 },
        legend: { x: 0.01, y: 0.01, bgcolor: 'rgba(10,22,40,0.8)', font: { size: 10 } },
        showlegend: true
    };

    Plotly.newPlot('comp-env-skewt-plot', traces, layout, { responsive: true, displayModeBar: false });
}

// ── Composite Hodograph with spread ellipses ──
function renderCompositeHodograph(profData) {
    var container = document.getElementById('comp-env-hodo');
    if (!container) return;
    container.innerHTML = '<div id="comp-env-hodo-plot" style="width:100%;height:520px;"></div>';

    var plev = profData.plev;
    var uMean = profData.u.mean;
    var vMean = profData.v.mean;
    var uStd = profData.u.std;
    var vStd = profData.v.std;
    var nCases = profData.n_cases;

    // Color scale by pressure level (warm colors low, cool colors high)
    var colors = [];
    for (var i = 0; i < plev.length; i++) {
        var frac = i / Math.max(plev.length - 1, 1);
        var r = Math.round(255 * (1 - frac));
        var g = Math.round(100 + 100 * (1 - Math.abs(frac - 0.5) * 2));
        var b = Math.round(255 * frac);
        colors.push('rgb(' + r + ',' + g + ',' + b + ')');
    }

    var traces = [];

    // Spread ellipses at each level
    for (var i = 0; i < plev.length; i++) {
        if (uMean[i] === null || vMean[i] === null || uStd[i] === null || vStd[i] === null) continue;
        var eX = [], eY = [];
        var su = uStd[i], sv = vStd[i];
        for (var a = 0; a <= 360; a += 10) {
            var rad = a * Math.PI / 180;
            eX.push(uMean[i] + su * Math.cos(rad));
            eY.push(vMean[i] + sv * Math.sin(rad));
        }
        traces.push({
            x: eX, y: eY, mode: 'lines',
            line: { color: colors[i], width: 0.8 },
            fill: 'toself', fillcolor: colors[i].replace('rgb', 'rgba').replace(')', ',0.08)'),
            showlegend: false, hoverinfo: 'skip'
        });
    }

    // Mean hodograph line
    var hodoU = [], hodoV = [], hodoText = [];
    for (var i = 0; i < plev.length; i++) {
        if (uMean[i] !== null && vMean[i] !== null) {
            hodoU.push(uMean[i]);
            hodoV.push(vMean[i]);
            hodoText.push(plev[i] + ' hPa');
        }
    }
    traces.push({
        x: hodoU, y: hodoV, mode: 'lines+markers',
        line: { color: '#00d4ff', width: 2 },
        marker: { size: 6, color: colors.slice(0, hodoU.length), line: { width: 1, color: '#fff' } },
        name: 'Mean Hodograph',
        text: hodoText, hovertemplate: '%{text}<br>u=%{x:.1f} m/s<br>v=%{y:.1f} m/s<extra></extra>'
    });

    // Range circles (10, 20, 30 m/s)
    for (var r = 10; r <= 30; r += 10) {
        var cx = [], cy = [];
        for (var a = 0; a <= 360; a += 5) {
            cx.push(r * Math.cos(a * Math.PI / 180));
            cy.push(r * Math.sin(a * Math.PI / 180));
        }
        traces.push({
            x: cx, y: cy, mode: 'lines',
            line: { color: 'rgba(255,255,255,0.1)', width: 0.5, dash: 'dot' },
            showlegend: false, hoverinfo: 'skip'
        });
    }

    // Find max extent for axes
    var maxVal = 10;
    for (var i = 0; i < hodoU.length; i++) {
        maxVal = Math.max(maxVal, Math.abs(hodoU[i]) + 5, Math.abs(hodoV[i]) + 5);
    }
    maxVal = Math.ceil(maxVal / 5) * 5;

    var layout = {
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0f2140',
        font: { color: '#e2e8f0', family: 'DM Sans, sans-serif', size: 10 },
        title: { text: 'Composite Hodograph (N=' + nCases + ')', font: { size: 12 } },
        xaxis: {
            title: 'u (m/s)', range: [-maxVal, maxVal],
            gridcolor: 'rgba(255,255,255,0.06)', zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)',
            scaleanchor: 'y'
        },
        yaxis: {
            title: 'v (m/s)', range: [-maxVal, maxVal],
            gridcolor: 'rgba(255,255,255,0.06)', zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)'
        },
        margin: { t: 40, b: 50, l: 50, r: 10 },
        showlegend: false
    };

    // Level annotations
    var annotations = [];
    for (var i = 0; i < plev.length; i++) {
        if (uMean[i] !== null && vMean[i] !== null && (plev[i] === 1000 || plev[i] === 850 || plev[i] === 500 || plev[i] === 200)) {
            annotations.push({
                x: uMean[i], y: vMean[i],
                text: plev[i] + '', font: { size: 9, color: colors[i] },
                showarrow: false, xshift: 10, yshift: 5
            });
        }
    }
    layout.annotations = annotations;

    Plotly.newPlot('comp-env-hodo-plot', traces, layout, { responsive: true, displayModeBar: false });
}

// ══════════════════════════════════════════════════════════════
// Environmental Composite Difference Mode (A − B)
// ══════════════════════════════════════════════════════════════

function generateEnvCompDiff() {
    var filtersA = _getCompositeFilters();
    var filtersB = _getCompGroupBFilters();
    var dataType = document.getElementById('comp-dtype').value || 'swath';
    var field = document.getElementById('comp-env-field').value || 'shear_mag';
    var includeVec = document.getElementById('comp-env-vectors').checked;
    var envShearRel = !!(document.getElementById('comp-env-shear-rel') || {}).checked;
    var radiusKm = parseInt(document.getElementById('comp-env-radius').value) || 500;

    _switchCompTab('env');
    _showEnvCompStatus('loading', '\u23F3 Computing \u0394 environmental composites (A\u2212B)\u2026');
    ['comp-env-scalars', 'comp-env-plan-view', 'comp-env-thermo-row'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    var qsA = _compositeQueryString(filtersA) + '&data_type=' + dataType;
    var qsB = _compositeQueryString(filtersB) + '&data_type=' + dataType;
    var pvSuffix = '&field=' + field + '&radius_km=' + radiusKm + '&include_vectors=' + includeVec + '&shear_relative=' + envShearRel;

    // Serialize: fetch Group A first, then Group B, to avoid overwhelming
    // the single-worker backend with 6 concurrent heavy requests.
    var pvA, pvB, profA, profB, scA, scB;

    _showEnvCompStatus('loading', '\u23F3 Computing Group A environmental composites\u2026');

    Promise.all([
        _fetchWithTimeout(API_BASE + '/composite/era5_plan_view?' + qsA + pvSuffix).then(function(r) { return r.ok ? r.json() : null; }),
        _fetchWithTimeout(API_BASE + '/composite/era5_profiles?' + qsA).then(function(r) { return r.ok ? r.json() : null; }),
        _fetchWithTimeout(API_BASE + '/composite/era5_scalars?' + qsA).then(function(r) { return r.ok ? r.json() : null; })
    ]).then(function(resultsA) {
        pvA = resultsA[0]; profA = resultsA[1]; scA = resultsA[2];

        if (!pvA && !profA && !scA) {
            _showEnvCompStatus('error', '\u2717 No data for Group A.');
            return Promise.reject('no_data_a');
        }

        _showEnvCompStatus('loading', '\u23F3 Group A done. Computing Group B environmental composites\u2026');

        return Promise.all([
            _fetchWithTimeout(API_BASE + '/composite/era5_plan_view?' + qsB + pvSuffix).then(function(r) { return r.ok ? r.json() : null; }),
            _fetchWithTimeout(API_BASE + '/composite/era5_profiles?' + qsB).then(function(r) { return r.ok ? r.json() : null; }),
            _fetchWithTimeout(API_BASE + '/composite/era5_scalars?' + qsB).then(function(r) { return r.ok ? r.json() : null; })
        ]);
    }).then(function(resultsB) {
        pvB = resultsB[0]; profB = resultsB[1]; scB = resultsB[2];

        if (!pvB && !profB && !scB) {
            _showEnvCompStatus('error', '\u2717 No data for Group B.');
            return;
        }

        var nA = (pvA && pvA.n_cases) || 0, nB = (pvB && pvB.n_cases) || 0;
        _showEnvCompStatus('', '\u2713 \u0394 Environment: A (N=' + nA + ') \u2212 B (N=' + nB + ')');

        // Difference scalars
        if (scA && scB) renderEnvDiffScalars(scA, scB);

        // Difference plan-view
        if (pvA && pvB) renderEnvDiffPlanView(pvA, pvB);

        // Overlay Skew-Ts
        if (profA && profB) renderEnvDiffThermo(profA, profB);
    }).catch(function(err) {
        if (err === 'no_data_a') return; // Already handled above
        _showEnvCompStatus('error', '\u2717 \u0394 Error: ' + err.message);
    });
}

function renderEnvDiffScalars(scA, scB) {
    var container = document.getElementById('comp-env-scalars');
    if (!container) return;
    container.style.display = 'block';

    var html = '<div class="comp-env-section-title">\u0394 Scalar Diagnostics (A: N=' + scA.n_cases + ' | B: N=' + scB.n_cases + ')</div>';
    html += '<div class="env-comp-scalars-grid">';

    var order = ['shear_mag_env', 'rh_mid_env', 'sst_env', 'chi_m', 'v_pi', 'vent_index', 'div200_env', 'shear_dir_env'];
    for (var i = 0; i < order.length; i++) {
        var key = order[i];
        var a = scA.scalars[key], b = scB.scalars[key];
        if (!a || !b) continue;
        var diff = (a.mean - b.mean);
        var diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(a.units === '' ? 2 : 1);

        html += '<div class="env-scard">';
        html += '<div class="env-scard-value" style="color:' + (diff > 0 ? '#f87171' : diff < 0 ? '#60a5fa' : '#e2e8f0') + ';">\u0394 ' + diffStr + '</div>';
        html += '<div class="env-scard-unit">' + a.units + '</div>';
        html += '<div class="env-scard-label">' + a.display_name + '</div>';
        html += '<div class="env-scard-sub"><span style="color:#60a5fa;">A: ' + a.mean + '</span> | <span style="color:#f59e0b;">B: ' + b.mean + '</span></div>';
        html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
}

function renderEnvDiffPlanView(pvA, pvB) {
    var container = document.getElementById('comp-env-plan-view');
    if (!container) return;
    container.style.display = 'block';
    container.innerHTML = '<div id="comp-env-pv-plot" style="width:100%;height:500px;"></div>';

    // Element-wise A - B
    var diff2d = [];
    for (var j = 0; j < pvA.mean.length; j++) {
        var row = [];
        for (var k = 0; k < pvA.mean[j].length; k++) {
            var a = pvA.mean[j][k], b = pvB.mean[j][k];
            row.push(a !== null && b !== null ? a - b : null);
        }
        diff2d.push(row);
    }

    // Symmetric color range
    var maxAbs = 0;
    for (var j = 0; j < diff2d.length; j++) {
        for (var k = 0; k < diff2d[j].length; k++) {
            if (diff2d[j][k] !== null) maxAbs = Math.max(maxAbs, Math.abs(diff2d[j][k]));
        }
    }
    maxAbs = maxAbs || 1;

    var diffColorscale = [
        [0, 'rgb(5,48,97)'], [0.1, 'rgb(33,102,172)'], [0.2, 'rgb(67,147,195)'],
        [0.3, 'rgb(146,197,222)'], [0.4, 'rgb(209,229,240)'], [0.5, 'rgb(255,255,255)'],
        [0.6, 'rgb(253,219,199)'], [0.7, 'rgb(244,165,130)'], [0.8, 'rgb(214,96,77)'],
        [0.9, 'rgb(178,24,43)'], [1.0, 'rgb(103,0,31)']
    ];

    var cfg = pvA.field_config || {};
    var traces = [{
        z: diff2d, x: pvA.x_km, y: pvA.y_km,
        type: 'heatmap', colorscale: diffColorscale,
        zmin: -maxAbs, zmax: maxAbs,
        colorbar: { title: '\u0394 ' + (cfg.units || ''), titleside: 'right', thickness: 14, len: 0.8 },
        hovertemplate: '\u0394 %{z:.3f}<br>x: %{x} km<br>y: %{y} km<extra></extra>'
    }, {
        x: [0], y: [0], mode: 'markers',
        marker: { symbol: 'x', size: 12, color: '#fff' },
        showlegend: false, hoverinfo: 'skip'
    }];

    var title = '\u0394 ' + (cfg.display_name || pvA.field) + ' (A: N=' + pvA.n_cases + ' \u2212 B: N=' + pvB.n_cases + ')';
    Plotly.newPlot('comp-env-pv-plot', traces, {
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0f2140',
        font: { color: '#e2e8f0', family: 'DM Sans, sans-serif', size: 11 },
        title: { text: title, font: { size: 13 } },
        xaxis: { title: 'East\u2013West (km)', gridcolor: 'rgba(255,255,255,0.06)', zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)' },
        yaxis: { title: 'North\u2013South (km)', gridcolor: 'rgba(255,255,255,0.06)', scaleanchor: 'x', zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)' },
        margin: { t: 50, b: 50, l: 60, r: 20 }
    }, { responsive: true });
}

function renderEnvDiffThermo(profA, profB) {
    var thermoRow = document.getElementById('comp-env-thermo-row');
    if (!thermoRow) return;
    thermoRow.style.display = 'flex';

    // Overlay both group Skew-Ts on same diagram
    renderDiffCompositeSkewT(profA, profB);
    renderDiffCompositeHodograph(profA, profB);
}

function renderDiffCompositeSkewT(profA, profB) {
    var container = document.getElementById('comp-env-skewt');
    if (!container) return;
    container.innerHTML = '<div id="comp-env-skewt-plot" style="width:100%;height:520px;"></div>';

    var plev = profA.plev;
    var skewFactor = 70;
    function skewX(tc, p) { return tc + skewFactor * Math.log10(1000 / p); }
    function kToC(k) { return k !== null ? k - 273.15 : null; }

    var traces = [];

    // Background isotherms
    for (var iso = -80; iso <= 50; iso += 10) {
        var isoX = [], isoY = [];
        for (var pp = 1050; pp >= 100; pp -= 10) { isoX.push(skewX(iso, pp)); isoY.push(pp); }
        traces.push({
            x: isoX, y: isoY, mode: 'lines',
            line: { color: iso === 0 ? 'rgba(0,212,255,0.4)' : 'rgba(100,150,200,0.15)', width: iso === 0 ? 1.5 : 0.5 },
            showlegend: false, hoverinfo: 'skip'
        });
    }

    // Group A: T and Td (blue)
    function addProfile(tArr, color, name, dash) {
        var lx = [], ly = [];
        for (var i = 0; i < plev.length; i++) {
            if (tArr[i] !== null) { lx.push(skewX(kToC(tArr[i]), plev[i])); ly.push(plev[i]); }
        }
        traces.push({ x: lx, y: ly, mode: 'lines', line: { color: color, width: 2, dash: dash || 'solid' }, name: name });
    }

    addProfile(profA.t.mean, '#60a5fa', 'T (Group A)');
    addProfile(profA.td.mean, '#93c5fd', 'Td (Group A)', 'dash');
    addProfile(profB.t.mean, '#f59e0b', 'T (Group B)');
    addProfile(profB.td.mean, '#fbbf24', 'Td (Group B)', 'dash');

    Plotly.newPlot('comp-env-skewt-plot', traces, {
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0f2140',
        font: { color: '#e2e8f0', family: 'DM Sans, sans-serif', size: 10 },
        title: { text: '\u0394 Skew-T (A: N=' + profA.n_cases + ', B: N=' + profB.n_cases + ')', font: { size: 12 } },
        xaxis: { range: [-40, 90], showticklabels: false, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
        yaxis: {
            type: 'log', autorange: 'reversed',
            range: [Math.log10(1050), Math.log10(100)],
            title: 'Pressure (hPa)',
            tickvals: [1000, 850, 700, 500, 300, 200, 100],
            ticktext: ['1000', '850', '700', '500', '300', '200', '100'],
            gridcolor: 'rgba(255,255,255,0.08)'
        },
        margin: { t: 40, b: 40, l: 50, r: 10 },
        legend: { x: 0.01, y: 0.01, bgcolor: 'rgba(10,22,40,0.8)', font: { size: 9 } },
        showlegend: true
    }, { responsive: true, displayModeBar: false });
}

function renderDiffCompositeHodograph(profA, profB) {
    var container = document.getElementById('comp-env-hodo');
    if (!container) return;
    container.innerHTML = '<div id="comp-env-hodo-plot" style="width:100%;height:520px;"></div>';

    var plev = profA.plev;
    var traces = [];

    // Range circles
    for (var r = 10; r <= 30; r += 10) {
        var cx = [], cy = [];
        for (var a = 0; a <= 360; a += 5) { cx.push(r * Math.cos(a * Math.PI / 180)); cy.push(r * Math.sin(a * Math.PI / 180)); }
        traces.push({ x: cx, y: cy, mode: 'lines', line: { color: 'rgba(255,255,255,0.1)', width: 0.5, dash: 'dot' }, showlegend: false, hoverinfo: 'skip' });
    }

    // Group A hodograph (blue)
    var uA = [], vA = [], textA = [];
    for (var i = 0; i < plev.length; i++) {
        if (profA.u.mean[i] !== null && profA.v.mean[i] !== null) {
            uA.push(profA.u.mean[i]); vA.push(profA.v.mean[i]); textA.push(plev[i] + ' hPa');
        }
    }
    traces.push({ x: uA, y: vA, mode: 'lines+markers', line: { color: '#60a5fa', width: 2 }, marker: { size: 5 }, name: 'Group A', text: textA, hovertemplate: '%{text}<br>u=%{x:.1f}<br>v=%{y:.1f}<extra></extra>' });

    // Group B hodograph (orange)
    var uB = [], vB = [], textB = [];
    for (var i = 0; i < plev.length; i++) {
        if (profB.u.mean[i] !== null && profB.v.mean[i] !== null) {
            uB.push(profB.u.mean[i]); vB.push(profB.v.mean[i]); textB.push(plev[i] + ' hPa');
        }
    }
    traces.push({ x: uB, y: vB, mode: 'lines+markers', line: { color: '#f59e0b', width: 2 }, marker: { size: 5 }, name: 'Group B', text: textB, hovertemplate: '%{text}<br>u=%{x:.1f}<br>v=%{y:.1f}<extra></extra>' });

    var maxVal = 10;
    uA.concat(uB).forEach(function(v) { maxVal = Math.max(maxVal, Math.abs(v) + 5); });
    vA.concat(vB).forEach(function(v) { maxVal = Math.max(maxVal, Math.abs(v) + 5); });
    maxVal = Math.ceil(maxVal / 5) * 5;

    Plotly.newPlot('comp-env-hodo-plot', traces, {
        paper_bgcolor: '#0a1628', plot_bgcolor: '#0f2140',
        font: { color: '#e2e8f0', family: 'DM Sans, sans-serif', size: 10 },
        title: { text: '\u0394 Hodograph (A vs B)', font: { size: 12 } },
        xaxis: { title: 'u (m/s)', range: [-maxVal, maxVal], gridcolor: 'rgba(255,255,255,0.06)', zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)', scaleanchor: 'y' },
        yaxis: { title: 'v (m/s)', range: [-maxVal, maxVal], gridcolor: 'rgba(255,255,255,0.06)', zeroline: true, zerolinecolor: 'rgba(255,255,255,0.15)' },
        margin: { t: 40, b: 50, l: 50, r: 10 },
        legend: { x: 0.01, y: 0.99, bgcolor: 'rgba(10,22,40,0.8)', font: { size: 10 } },
        showlegend: true
    }, { responsive: true, displayModeBar: false });
}


// =====================================================================
// Flight-Level Archive Overlay (HRD historical data)
// =====================================================================
var _archiveFLActive = false;
var _archiveFLData = null;
var _archiveFLTraceIndices = [];  // Plotly trace indices to remove

// Variable config for archive time series (matches real-time _FL_TS_CONFIG)
var _ARCH_FL_TS_CONFIG = {
    'fl_wspd_ms':       { label: 'FL Wind Speed',    btn: 'FL Wind',   units: 'm/s',  color: '#60a5fa', yaxis: 'y'  },
    'tdr_wspd_fl_alt':  { label: 'TDR at FL Alt',    btn: 'TDR@FL',    units: 'm/s',  color: '#f472b6', yaxis: 'y'  },
    'tdr_wspd_0p5km':   { label: 'TDR Wind 0.5 km',  btn: 'TDR 0.5km', units: 'm/s',  color: '#34d399', yaxis: 'y'  },
    'tdr_wspd_2km':     { label: 'TDR Wind 2.0 km',  btn: 'TDR 2km',   units: 'm/s',  color: '#c084fc', yaxis: 'y'  },
    'static_pres_hpa':  { label: 'Static Pressure',   btn: 'Static P',  units: 'hPa',  color: '#fb923c', yaxis: 'y2' },
    'sfcpr_hpa':        { label: 'Sfc Pressure',      btn: 'Sfc P',     units: 'hPa',  color: '#fbbf24', yaxis: 'y2' },
    'temp_c':           { label: 'Temperature',       btn: 'Temp',      units: '\u00b0C',   color: '#f87171', yaxis: 'y3' },
    'dewpoint_c':       { label: 'Dewpoint',          btn: 'Dewpt',     units: '\u00b0C',   color: '#a78bfa', yaxis: 'y3' },
    'theta_e':          { label: '\u03b8e',            btn: '\u03b8e',   units: 'K',    color: '#e879f9', yaxis: 'y3' },
    'gps_alt_m':        { label: 'GPS Altitude',      btn: 'Alt',       units: 'm',    color: '#6b7280', yaxis: 'y4' },
};

// Multi-resolution config (matches real-time _FL_RES_STYLE)
var _ARCH_FL_RES_STYLE = {
    '1s':  { width: 0.7, opacity: 0.35, dash: 'solid', suffix: ' (1 s)'  },
    '10s': { width: 1.8, opacity: 0.85, dash: 'solid', suffix: ' (10 s)' },
    '30s': { width: 3.0, opacity: 1.0,  dash: 'solid', suffix: ' (30 s)' },
};
var _archFLResVisible = { '1s': true, '10s': true, '30s': true };

var _archFLTSXAxis = 'time'; // 'time' or 'radius'

function archiveToggleFlightLevel() {
    _ga('toggle_flight_level', { case_index: currentCaseIndex });
    var btn = document.getElementById('btn-archive-fl');
    if (_archiveFLActive) {
        // Deactivate
        _archiveFLActive = false;
        _archiveRemoveFLOverlay();
        _archiveHideFLTimeSeries();
        if (btn) { btn.textContent = '\u2708 FL'; btn.classList.remove('fl-active'); btn.classList.remove('active'); }
        return;
    }

    // Activate: fetch FL data for current case
    if (currentCaseIndex === null) return;
    _archiveFLActive = true;
    if (btn) { btn.textContent = '\u2708 FL'; btn.classList.add('fl-active'); btn.disabled = true; }

    if (_archiveFLData && _archiveFLData._caseIndex === currentCaseIndex) {
        _archiveRenderFLOverlay(_archiveFLData);
        _archiveRenderFLTimeSeries(_archiveFLData);
        if (btn) { btn.textContent = '\u2708 FL'; btn.disabled = false; btn.classList.add('active'); }
        return;
    }

    var url = API_BASE + '/flightlevel/archive?case_index=' + currentCaseIndex + '&data_type=' + _activeDataType;
    fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(json) {
            if (!_archiveFLActive) return;
            json._caseIndex = currentCaseIndex;
            _archiveFLData = json;

            if (!json.success) {
                var msg = json.message || 'No flight-level data available for this case.';
                if (btn) { btn.textContent = '\u2708 FL'; btn.disabled = false; btn.classList.remove('fl-active'); btn.classList.remove('active'); }
                _archiveFLActive = false;
                var flStatus = document.getElementById('fl-archive-status');
                if (flStatus) {
                    flStatus.textContent = '\u2708 ' + msg;
                    flStatus.style.display = 'block';
                    setTimeout(function() { flStatus.style.display = 'none'; }, 5000);
                }
                return;
            }

            _archiveRenderFLOverlay(json);
            _archiveRenderFLTimeSeries(json);
            if (btn) { btn.textContent = '\u2708 FL'; btn.disabled = false; btn.classList.add('active'); }
        })
        .catch(function(err) {
            console.warn('FL archive fetch error:', err);
            _archiveFLActive = false;
            if (btn) { btn.textContent = '\u2708 FL'; btn.disabled = false; btn.classList.remove('fl-active'); btn.classList.remove('active'); }
        });
}

function _archiveRemoveFLOverlay() {
    var plotDiv = document.getElementById('plotly-chart');
    if (!plotDiv || !plotDiv.data) return;

    if (_archiveFLTraceIndices.length > 0) {
        var indicesToRemove = _archiveFLTraceIndices.slice().sort(function(a,b){return b-a;});
        for (var i = 0; i < indicesToRemove.length; i++) {
            if (indicesToRemove[i] < plotDiv.data.length) {
                Plotly.deleteTraces('plotly-chart', indicesToRemove[i]);
            }
        }
        _archiveFLTraceIndices = [];
    }
}

function _archiveRenderFLOverlay(flData) {
    var plotDiv = document.getElementById('plotly-chart');
    // Use obs_10s if available (multi-resolution response), fall back to observations
    var obs = flData.obs_10s || flData.observations;
    if (!plotDiv || !plotDiv.data || !obs || obs.length === 0) return;

    _archiveRemoveFLOverlay();
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
        if (o.tdr_wspd_2km != null) tdrStr += (tdrStr ? '<br>' : '') + 'TDR 2km: ' + o.tdr_wspd_2km.toFixed(1) + ' m/s';
        if (o.tdr_wspd_0p5km != null) tdrStr += (tdrStr ? '<br>' : '') + 'TDR 0.5km: ' + o.tdr_wspd_0p5km.toFixed(1) + ' m/s';

        // Build time offset string, handling null/undefined
        var tOffsetMin = (o.time_offset_s != null && isFinite(o.time_offset_s)) ? (o.time_offset_s / 60) : null;
        var timeStr = (o.time || '') + ' UTC';
        if (tOffsetMin != null) {
            timeStr += ' (T' + (tOffsetMin >= 0 ? '+' : '') + tOffsetMin.toFixed(1) + ' min)';
        }

        // Flight altitude string
        var altStr = '';
        if (o.gps_alt_m != null && isFinite(o.gps_alt_m)) {
            var altFt = Math.round(o.gps_alt_m * 3.28084);
            altStr = 'Alt: ' + o.gps_alt_m.toFixed(0) + ' m (' + altFt + ' ft)<br>';
        }

        texts.push(
            '<b>\u2708 Flight Level</b><br>' +
            'Wind: ' + (ws != null ? ws.toFixed(1) + ' m/s (' + (ws * 1.94384).toFixed(0) + ' kt)' : 'N/A') + '<br>' +
            'Dir: ' + (o.fl_wdir_deg != null ? o.fl_wdir_deg.toFixed(0) + '\u00b0' : 'N/A') + '<br>' +
            altStr +
            (tdrStr ? tdrStr + '<br>' : '') +
            'R: ' + (o.r_km != null ? o.r_km.toFixed(1) + ' km' : '') + '<br>' +
            'Time: ' + timeStr
        );
    }

    // Inherit the TDR heatmap's colorscale + range so scatter matches shading
    var tdrColorscale = 'Inferno';
    var tdrCmin = 0, tdrCmax = 80;
    if (plotDiv.data && plotDiv.data.length > 0) {
        var tdrTrace = plotDiv.data[0];
        if (tdrTrace.colorscale) tdrColorscale = tdrTrace.colorscale;
        if (tdrTrace.zmin != null) tdrCmin = tdrTrace.zmin;
        if (tdrTrace.zmax != null) tdrCmax = tdrTrace.zmax;
    }

    var flTrackTrace = {
        x: x,
        y: y,
        type: 'scatter',
        mode: 'markers',
        marker: {
            color: colors,
            colorscale: tdrColorscale,
            cmin: tdrCmin,
            cmax: tdrCmax,
            size: sizes,
            line: { width: 1, color: 'rgba(255,255,255,0.6)' },
            showscale: false,  // No separate colorbar — use legend in time series
        },
        text: texts,
        hovertemplate: '%{text}<extra></extra>',
        name: '\u2708 Flight Level',
        showlegend: true,
    };

    // Track line connecting points
    var flLineTrace = {
        x: x,
        y: y,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'rgba(255,255,255,0.3)', width: 1.5 },
        hoverinfo: 'skip',
        showlegend: false,
        name: 'FL Track Line',
    };

    var baseCount = plotDiv.data.length;
    Plotly.addTraces('plotly-chart', [flLineTrace, flTrackTrace]);
    _archiveFLTraceIndices = [baseCount, baseCount + 1];
}

function _archiveHideFLTimeSeries() {
    var container = document.getElementById('fl-archive-ts');
    if (container) container.style.display = 'none';
    // Purge plot to free memory
    var plotDiv = document.getElementById('fl-ts-chart');
    if (plotDiv) try { Plotly.purge(plotDiv); } catch(e) {}
}

function _archiveRenderFLTimeSeries(flData) {
    // Use obs_10s as primary; fall back to observations for backward compat
    var primaryObs = flData.obs_10s || flData.observations;
    if (!primaryObs || primaryObs.length === 0) return;

    // Get pre-rendered container from the openSidePanel() template
    var container = document.getElementById('fl-archive-ts');
    if (!container) return;
    container.style.display = 'block';

    // Populate the dynamic sections
    _archivePopulateFLResButtons(flData);
    _archivePopulateFLVarButtons(flData);
    _archivePopulateFLInfo(flData);
    _archFLTSRender(flData);
}

// ── FL Panel Helper: Populate resolution toggle buttons ──
function _archivePopulateFLResButtons(flData) {
    var el = document.getElementById('arch-fl-res-group');
    if (!el) return;
    var html = '<span style="color:#64748b;font-size:10px;margin-right:2px;">Avg:</span>';
    var resLabels = { '1s': '1 s', '10s': '10 s', '30s': '30 s' };
    var resOrder = ['1s', '10s', '30s'];
    for (var ri = 0; ri < resOrder.length; ri++) {
        var rk = resOrder[ri];
        var hasResData = (rk === '1s' && flData.obs_1s && flData.obs_1s.length > 0) ||
                         (rk === '10s' && (flData.obs_10s || flData.observations) && (flData.obs_10s || flData.observations).length > 0) ||
                         (rk === '30s' && flData.obs_30s && flData.obs_30s.length > 0);
        if (!hasResData) continue;
        html += '<button class="fl-ts-res-btn' + (_archFLResVisible[rk] ? ' active' : '') +
            '" id="arch-fl-res-' + rk + '" onclick="archFLToggleRes(\'' + rk + '\')">' + resLabels[rk] + '</button>';
    }
    el.innerHTML = html;
}

// ── FL Panel Helper: Populate variable toggle buttons ──
function _archivePopulateFLVarButtons(flData) {
    var el = document.getElementById('arch-fl-ts-vars');
    if (!el) return;
    var html = '';
    var defaultActive = ['fl_wspd_ms', 'tdr_wspd_fl_alt', 'tdr_wspd_0p5km', 'tdr_wspd_2km'];
    var varKeys = Object.keys(_ARCH_FL_TS_CONFIG);
    for (var vi = 0; vi < varKeys.length; vi++) {
        var vk = varKeys[vi];
        var vcfg = _ARCH_FL_TS_CONFIG[vk];
        var isActive = defaultActive.indexOf(vk) >= 0;
        // Skip variables that have no data in any resolution
        var hasData = false;
        var allObs = [flData.obs_1s, flData.obs_10s, flData.obs_30s, flData.observations];
        for (var ai = 0; ai < allObs.length && !hasData; ai++) {
            var checkObs = allObs[ai];
            if (!checkObs) continue;
            for (var di = 0; di < checkObs.length; di++) {
                if (checkObs[di][vk] != null) { hasData = true; break; }
            }
        }
        if (!hasData) continue;
        html += '<button class="fl-ts-var-btn' + (isActive ? ' active' : '') +
            '" data-var="' + vk + '" onclick="archFLToggleVar(this)" style="--var-color:' + vcfg.color + '">' +
            (vcfg.btn || vcfg.label) + '</button>';
    }
    el.innerHTML = html;
}

// ── FL Panel Helper: Populate info bar ──
function _archivePopulateFLInfo(flData) {
    var el = document.getElementById('fl-ts-info');
    if (!el) return;
    var primaryObs = flData.obs_10s || flData.observations;
    var n1s = flData.obs_1s ? flData.obs_1s.length : 0;
    var n10s = primaryObs ? primaryObs.length : 0;
    var n30s = flData.obs_30s ? flData.obs_30s.length : 0;
    el.innerHTML = flData.mission_id + ' \u00b7 1s/' + n1s + ', 10s/' + n10s + ', 30s/' + n30s +
        ' (' + flData.n_obs_raw + ' raw) \u00b7 \u00b1' + flData.time_window_min + ' min \u00b7 ' +
        '<a href="' + (flData.source_url || '#') + '" target="_blank" style="color:#60a5fa;font-size:10px;">HRD Archive</a>';
}

function _archFLSetXAxis(mode) {
    _archFLTSXAxis = mode;
    var tBtn = document.getElementById('fl-ts-xbtn-time');
    var rBtn = document.getElementById('fl-ts-xbtn-radius');
    if (tBtn) tBtn.classList.toggle('active', mode === 'time');
    if (rBtn) rBtn.classList.toggle('active', mode === 'radius');
    if (_archiveFLData && _archiveFLData.success) _archFLTSRender(_archiveFLData);
}

function archFLToggleVar(btnEl) {
    btnEl.classList.toggle('active');
    if (_archiveFLData && _archiveFLData.success) _archFLTSRender(_archiveFLData);
}

function archFLToggleRes(resKey) {
    _archFLResVisible[resKey] = !_archFLResVisible[resKey];
    var btn = document.getElementById('arch-fl-res-' + resKey);
    if (btn) {
        if (_archFLResVisible[resKey]) { btn.classList.add('active'); }
        else { btn.classList.remove('active'); }
    }
    if (_archiveFLData && _archiveFLData.success) _archFLTSRender(_archiveFLData);
}

function archFLCloseTimeSeries() {
    _archiveHideFLTimeSeries();
}

// Helper: get observation array for a given resolution key
function _archFLDataForRes(flData, resKey) {
    if (resKey === '1s')  return flData.obs_1s  || null;
    if (resKey === '10s') return flData.obs_10s  || flData.observations || null;
    if (resKey === '30s') return flData.obs_30s  || null;
    return null;
}

function _archFLTSRender(flData) {
    // Primary obs for stats (use 10s)
    var primaryObs = flData.obs_10s || flData.observations;
    if (!primaryObs || primaryObs.length === 0) return;

    // Get selected variables from toggle buttons
    var varContainer = document.getElementById('arch-fl-ts-vars');
    var selectedVars = [];
    if (varContainer) {
        var btns = varContainer.querySelectorAll('.fl-ts-var-btn.active');
        for (var bi = 0; bi < btns.length; bi++) {
            selectedVars.push(btns[bi].getAttribute('data-var'));
        }
    }
    if (selectedVars.length === 0) selectedVars = ['fl_wspd_ms'];

    // Build traces: iterate resolutions × selected variables (matching real-time pattern)
    var usedAxes = {};
    var traces = [];
    var resKeys = ['1s', '10s', '30s'];  // render order: 1s behind, 30s on top

    for (var si = 0; si < selectedVars.length; si++) {
        var varName = selectedVars[si];
        var cfg = _ARCH_FL_TS_CONFIG[varName];
        if (!cfg) continue;

        var isWind = (varName === 'fl_wspd_ms' || varName === 'tdr_wspd_fl_alt' ||
                      varName === 'tdr_wspd_0p5km' || varName === 'tdr_wspd_2km');

        for (var rr = 0; rr < resKeys.length; rr++) {
            var resKey = resKeys[rr];
            if (!_archFLResVisible[resKey]) continue;
            var obs = _archFLDataForRes(flData, resKey);
            if (!obs || obs.length === 0) continue;

            usedAxes[cfg.yaxis] = true;
            var style = _ARCH_FL_RES_STYLE[resKey];

            var xVals = [], yVals = [], customdata = [];
            for (var oi = 0; oi < obs.length; oi++) {
                var o = obs[oi];
                var tOffMin = (o.time_offset_s != null && isFinite(o.time_offset_s)) ? Math.round(o.time_offset_s / 6.0) / 10.0 : null;
                var xVal = _archFLTSXAxis === 'radius' ? o.r_km : tOffMin;
                if (xVal == null) continue;
                xVals.push(xVal);
                var v = o[varName];
                yVals.push((v != null && isFinite(v)) ? Math.round(v * 10) / 10 : null);

                var utc = o.time || '';
                var kt = '';
                if (isWind && v != null && isFinite(v)) kt = (v * 1.94384).toFixed(1);
                // For TDR at FL Alt, include the altitude in hover
                var altStr = '';
                if (varName === 'tdr_wspd_fl_alt' && o.gps_alt_m != null && isFinite(o.gps_alt_m)) {
                    altStr = (o.gps_alt_m / 1000).toFixed(2) + ' km';
                }
                customdata.push([utc, kt, altStr]);
            }

            var hoverTpl;
            if (varName === 'tdr_wspd_fl_alt') {
                hoverTpl = cfg.label + style.suffix + ': %{y} ' + cfg.units +
                    ' (%{customdata[1]} kt) @ %{customdata[2]}<br>%{customdata[0]} UTC<extra></extra>';
            } else if (isWind) {
                hoverTpl = cfg.label + style.suffix + ': %{y} ' + cfg.units +
                    ' (%{customdata[1]} kt)<br>%{customdata[0]} UTC<extra></extra>';
            } else {
                hoverTpl = cfg.label + style.suffix + ': %{y} ' + cfg.units +
                    '<br>%{customdata[0]} UTC<extra></extra>';
            }

            traces.push({
                x: xVals,
                y: yVals,
                customdata: customdata,
                name: cfg.label + style.suffix,
                legendgroup: varName,
                showlegend: resKey === '10s',  // only one legend entry per variable
                type: 'scatter',
                mode: 'lines',
                line: { color: cfg.color, width: style.width, dash: style.dash },
                opacity: style.opacity,
                yaxis: cfg.yaxis,
                hovertemplate: hoverTpl,
                connectgaps: false,
            });
        }
    }

    // Layout with multi-axis support
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
            title: { text: _archFLTSXAxis === 'radius' ? 'Distance from Center (km)' : 'Minutes from TDR Scan', font: { size: 11 } },
            color: '#94a3b8',
            gridcolor: gridColor,
            zeroline: _archFLTSXAxis === 'time',
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
            title: usedAxes['y3'] ? { text: 'Temp (\u00b0C) / \u03b8e (K)', font: { size: 10, color: '#f87171' } } : undefined,
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
    };

    // Add TDR scan time marker when in time mode
    if (_archFLTSXAxis === 'time') {
        layout.shapes = [{
            type: 'line',
            x0: 0, x1: 0, y0: 0, y1: 1, yref: 'paper',
            line: { color: 'rgba(96,165,250,0.6)', width: 2, dash: 'dash' },
        }];
        layout.annotations = [{
            x: 0.5, y: 0, yref: 'paper', xref: 'x',
            text: 'TDR Analysis', showarrow: false,
            font: { size: 9, color: 'rgba(96,165,250,0.7)' },
            yanchor: 'top', yshift: 8,
        }];
    }

    // Build max-wind / min-pressure inset annotation with per-resolution values
    // (matches real-time format: "FL Wind max — 1s: 98.7  10s: 83.7  30s: 78.7")
    var insetLines = [];
    var windVars = [
        { key: 'fl_wspd_ms',      label: 'FL Wind' },
        { key: 'tdr_wspd_fl_alt', label: 'TDR@FL' },
        { key: 'tdr_wspd_0p5km',  label: 'TDR 0.5 km' },
        { key: 'tdr_wspd_2km',    label: 'TDR 2.0 km' },
    ];
    for (var wi = 0; wi < windVars.length; wi++) {
        var wv = windVars[wi];
        if (selectedVars.indexOf(wv.key) === -1) continue;
        var row = [];
        for (var wr = 0; wr < resKeys.length; wr++) {
            var wResKey = resKeys[wr];
            if (!_archFLResVisible[wResKey]) continue;
            var wObs = _archFLDataForRes(flData, wResKey);
            if (!wObs || wObs.length === 0) continue;
            var maxVal = null;
            for (var mi = 0; mi < wObs.length; mi++) {
                var wval = wObs[mi][wv.key];
                if (wval != null && (maxVal === null || wval > maxVal)) maxVal = wval;
            }
            if (maxVal != null) {
                row.push(wResKey + ': <b>' + maxVal.toFixed(1) + '</b>');
            }
        }
        if (row.length > 0) {
            insetLines.push(wv.label + ' max \u2014 ' + row.join('  '));
        }
    }
    var presVars = [
        { key: 'static_pres_hpa', label: 'Static P min' },
        { key: 'sfcpr_hpa',       label: 'Sfc P min' },
    ];
    for (var pi = 0; pi < presVars.length; pi++) {
        var pv = presVars[pi];
        if (selectedVars.indexOf(pv.key) === -1) continue;
        var prow = [];
        for (var pr = 0; pr < resKeys.length; pr++) {
            var pResKey = resKeys[pr];
            if (!_archFLResVisible[pResKey]) continue;
            var pObs = _archFLDataForRes(flData, pResKey);
            if (!pObs || pObs.length === 0) continue;
            var minVal = null;
            for (var pj = 0; pj < pObs.length; pj++) {
                var pval = pObs[pj][pv.key];
                if (pval != null && (minVal === null || pval < minVal)) minVal = pval;
            }
            if (minVal != null) {
                prow.push(pResKey + ': <b>' + minVal.toFixed(1) + '</b>');
            }
        }
        if (prow.length > 0) {
            insetLines.push(pv.label + ' \u2014 ' + prow.join('  '));
        }
    }
    if (insetLines.length > 0) {
        if (!layout.annotations) layout.annotations = [];
        layout.annotations.push({
            x: 0.01, y: 0.98, xref: 'paper', yref: 'paper',
            text: insetLines.join('<br>'),
            showarrow: false,
            font: { family: 'DM Sans, sans-serif', size: 10, color: '#cbd5e1' },
            align: 'left', xanchor: 'left', yanchor: 'top',
            bgcolor: 'rgba(10,15,25,0.75)',
            bordercolor: 'rgba(96,165,250,0.3)',
            borderwidth: 1, borderpad: 6,
        });
    }

    Plotly.newPlot('fl-ts-chart', traces, layout, { responsive: true, displayModeBar: false, scrollZoom: false });
}

// Clear FL state when case changes
function _archiveFLReset() {
    _archiveFLActive = false;
    _archiveFLData = null;
    _archiveFLTraceIndices = [];
    var btn = document.getElementById('btn-archive-fl');
    if (btn) { btn.textContent = '\u2708 FL'; btn.classList.remove('fl-active'); btn.classList.remove('active'); btn.disabled = false; }
    _archiveHideFLTimeSeries();
    var status = document.getElementById('fl-archive-status');
    if (status) status.style.display = 'none';
}


// =====================================================================
// Archive Dropsonde Overlay (HRD .frd historical data)
// =====================================================================
var _archiveSondeActive = false;
var _archiveSondeData = null;
var _archiveSondeTraceIndices = [];
var _SONDE_COLORS = [
    '#34d399','#60a5fa','#f472b6','#fbbf24','#a78bfa',
    '#fb923c','#38bdf8','#f87171','#4ade80','#e879f9',
    '#facc15','#2dd4bf','#f97316','#818cf8','#fb7185'
];

function _archSondeColor(idx) {
    return _SONDE_COLORS[idx % _SONDE_COLORS.length];
}

function archiveToggleDropsondes() {
    _ga('toggle_dropsondes', { case_index: currentCaseIndex });
    var btn = document.getElementById('btn-archive-sonde');
    if (_archiveSondeActive) {
        _archiveSondeActive = false;
        _archiveRemoveSondeOverlay();
        _archiveHideSondePanel();
        if (btn) { btn.textContent = '\uD83E\uDE82 Sondes'; btn.classList.remove('sonde-active'); btn.classList.remove('active'); }
        return;
    }

    if (currentCaseIndex === null) return;
    _archiveSondeActive = true;
    if (btn) { btn.textContent = '\uD83E\uDE82 Loading\u2026'; btn.classList.add('sonde-active'); btn.disabled = true; }

    if (_archiveSondeData && _archiveSondeData._caseIndex === currentCaseIndex) {
        _archiveRenderSondeOverlay(_archiveSondeData);
        _archiveRenderSondePanel(_archiveSondeData);
        if (btn) { btn.textContent = '\uD83E\uDE82 Sondes'; btn.disabled = false; btn.classList.add('active'); }
        return;
    }

    var url = API_BASE + '/dropsondes/archive?case_index=' + currentCaseIndex + '&data_type=' + _activeDataType;
    fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(json) {
            if (!_archiveSondeActive) return;
            json._caseIndex = currentCaseIndex;
            // Sort dropsondes chronologically by launch time
            if (json.dropsondes) {
                json.dropsondes.sort(function(a, b) {
                    return (a.launch_time || '').localeCompare(b.launch_time || '');
                });
            }
            _archiveSondeData = json;

            if (!json.success && json.success !== undefined) {
                var msg = json.message || 'No dropsonde data available.';
                if (json._diag) console.log('Sonde diag:', JSON.stringify(json._diag, null, 2));
                var status = document.getElementById('fl-archive-status');
                if (status) { status.textContent = '\uD83E\uDE82 ' + msg; status.style.display = 'block'; }
                if (btn) { btn.textContent = '\uD83E\uDE82 Sondes'; btn.disabled = false; btn.classList.remove('active'); }
                _archiveSondeActive = false;
                return;
            }

            _archiveRenderSondeOverlay(json);
            _archiveRenderSondePanel(json);
            if (btn) { btn.textContent = '\uD83E\uDE82 Sondes'; btn.disabled = false; btn.classList.add('active'); }
        })
        .catch(function(err) {
            console.error('Archive sonde fetch error:', err);
            if (btn) { btn.textContent = '\uD83E\uDE82 Sondes'; btn.disabled = false; btn.classList.remove('active'); }
            _archiveSondeActive = false;
        });
}

function _archiveRemoveSondeOverlay() {
    var plotDiv = document.getElementById('plotly-chart');
    if (!plotDiv || !plotDiv.data) return;

    if (_archiveSondeTraceIndices.length > 0) {
        var indicesToRemove = _archiveSondeTraceIndices.slice().sort(function(a,b){return b-a;});
        for (var i = 0; i < indicesToRemove.length; i++) {
            if (indicesToRemove[i] < plotDiv.data.length) {
                Plotly.deleteTraces('plotly-chart', indicesToRemove[i]);
            }
        }
        _archiveSondeTraceIndices = [];
    }
}

function _archiveRenderSondeOverlay(data) {
    var plotDiv = document.getElementById('plotly-chart');
    if (!plotDiv || !plotDiv.data || !data.dropsondes || !data.dropsondes.length) return;
    _archiveRemoveSondeOverlay();

    var traces = [];
    var baseCount = plotDiv.data.length;

    data.dropsondes.forEach(function(sonde, idx) {
        var p = sonde.profile;
        if (!p.x_km || p.x_km.length < 2) return;

        var color = _archSondeColor(idx);

        // Trajectory line on plan view
        var lineTrace = {
            x: p.x_km,
            y: p.y_km,
            type: 'scatter',
            mode: 'lines',
            line: { color: color, width: 2, dash: 'dot' },
            hoverinfo: 'skip',
            showlegend: false,
            name: 'Sonde ' + (sonde.sonde_id || idx),
        };
        traces.push(lineTrace);

        // Surface marker (or bottom of drop)
        var sfcIdx = p.x_km.length - 1;
        var launchIdx = 0;

        // Max wind
        var maxWspd = -Infinity;
        for (var w = 0; w < p.wspd.length; w++) {
            if (p.wspd[w] != null && p.wspd[w] > maxWspd) maxWspd = p.wspd[w];
        }
        var maxWspdStr = isFinite(maxWspd) ? maxWspd.toFixed(1) + ' m/s (' + (maxWspd * 1.94384).toFixed(0) + ' kt)' : 'N/A';

        var tOffStr = sonde.time_offset_min != null ?
            (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min' : '';

        var launchAltStr = sonde.launch.alt_m != null ? (sonde.launch.alt_m / 1000).toFixed(1) + ' km' : '?';
        var sfcAltStr = sonde.surface.alt_m != null ? sonde.surface.alt_m.toFixed(0) + ' m' : '?';

        var hoverHtml =
            '<b>\uD83E\uDE82 ' + (sonde.sonde_id || 'Sonde ' + (idx+1)) + '</b><br>' +
            sonde.launch_time + ' (' + tOffStr + ')<br>' +
            (sonde.aircraft || '') + '<br>' +
            'Max wind: <b>' + maxWspdStr + '</b><br>' +
            'Alt: ' + launchAltStr + ' \u2192 ' + sfcAltStr +
            (sonde.hit_surface ? ' | Hit sfc' : ' | No sfc') +
            (sonde.estimated_pr_used ? ' | Est P' : '') +
            '<extra></extra>';

        // Surface/bottom marker
        var markerTrace = {
            x: [p.x_km[sfcIdx]],
            y: [p.y_km[sfcIdx]],
            type: 'scatter',
            mode: 'markers+text',
            marker: {
                color: color,
                size: 10,
                symbol: sonde.hit_surface ? 'circle' : 'circle-open',
                line: { width: 2, color: '#fff' },
            },
            text: [String(idx + 1)],
            textposition: 'top right',
            textfont: { color: color, size: 10, family: 'monospace' },
            hovertemplate: hoverHtml,
            showlegend: idx === 0,
            name: '\uD83E\uDE82 Dropsondes',
        };
        traces.push(markerTrace);
    });

    if (traces.length > 0) {
        Plotly.addTraces('plotly-chart', traces);
        for (var t = 0; t < traces.length; t++) {
            _archiveSondeTraceIndices.push(baseCount + t);
        }
    }
}

function _archiveHideSondePanel() {
    var panel = document.getElementById('archive-sonde-panel');
    if (panel) panel.style.display = 'none';
}

function _archiveRenderSondePanel(data) {
    if (!data.dropsondes || !data.dropsondes.length) return;

    // Get or create the sonde info panel
    var panel = document.getElementById('archive-sonde-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'archive-sonde-panel';
        panel.style.cssText = 'margin-top:8px;padding:8px 12px;background:rgba(6,78,59,0.15);border:1px solid rgba(52,211,153,0.3);border-radius:6px;font-size:11px;color:#d1d5db;';
        // Insert after the FL time series panel or after the side panel content
        var flTs = document.getElementById('fl-archive-ts');
        if (flTs && flTs.parentNode) {
            flTs.parentNode.insertBefore(panel, flTs.nextSibling);
        } else {
            var sp = document.getElementById('side-panel');
            if (sp) sp.appendChild(panel);
        }
    }
    panel.style.display = 'block';

    var nSondes = data.dropsondes.length;
    var nHitSfc = data.dropsondes.filter(function(s) { return s.hit_surface; }).length;
    var nEstPr = data.dropsondes.filter(function(s) { return s.estimated_pr_used; }).length;
    var timeWindow = data.time_window_min ? '\u00b1' + data.time_window_min + ' min' : 'all flight';

    var html = '<div style="margin-bottom:6px;">' +
        '<strong style="color:#6ee7b7;">\uD83E\uDE82 Archive Dropsondes</strong>' +
        '<span style="margin-left:8px;color:#9ca3af;">' + nSondes + ' sondes (' + timeWindow + ')</span>' +
        '<span style="margin-left:8px;color:#9ca3af;">' + nHitSfc + ' hit sfc' +
        (nEstPr > 0 ? ', ' + nEstPr + ' est P' : '') + '</span>' +
        '</div>';

    // Sonde table
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

    data.dropsondes.forEach(function(sonde, idx) {
        var color = _archSondeColor(idx);
        var maxWspd = null;
        var sfcPres = null;
        var wl150 = null;
        var p = sonde.profile;
        for (var j = 0; j < p.wspd.length; j++) {
            if (p.wspd[j] != null && (maxWspd === null || p.wspd[j] > maxWspd)) maxWspd = p.wspd[j];
        }
        // WL150: mean wind speed in the 0–150 m AGL layer (same as wind plot)
        if (p.alt_km && p.wspd) {
            // Find the lowest valid altitude (surface altitude)
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
        // Surface pressure: use splash_pr or hyd_sfcp from .frd metadata, else max pressure
        var splashSource = 'none';  // Track splash measurement source
        if (sonde.splash_pr != null && sonde.splash_pr > 0) {
            sfcPres = sonde.splash_pr;
            splashSource = 'splash';
        } else if (sonde.hyd_sfcp != null && sonde.hyd_sfcp > 0) {
            sfcPres = sonde.hyd_sfcp;
            splashSource = 'hyd';
        } else {
            for (var j = 0; j < p.pres.length; j++) {
                if (p.pres[j] != null && (sfcPres === null || p.pres[j] > sfcPres)) sfcPres = p.pres[j];
            }
            if (sfcPres != null) splashSource = 'est';
        }

        var timeStr = sonde.launch_time ? sonde.launch_time.substring(11, 19) : '?';
        var dtStr = sonde.time_offset_min != null ?
            (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) : '';
        var wl150Str = wl150 != null ? wl150.toFixed(1) : '-';
        var wspdStr = maxWspd != null ? maxWspd.toFixed(1) : '-';
        var presStr = sfcPres != null ? sfcPres.toFixed(0) : '-';
        // Color-code Psfc: green if measured splash, yellow if hydrostatic, red/dim if estimated from profile
        var presColor = splashSource === 'splash' ? '#34d399' :
                        splashSource === 'hyd' ? '#fbbf24' :
                        splashSource === 'est' ? '#f87171' : '#6b7280';
        var presTip = splashSource === 'splash' ? 'GPS splash measurement' :
                      splashSource === 'hyd' ? 'Hydrostatic surface estimate' :
                      splashSource === 'est' ? 'Estimated from max profile pressure' : 'No data';
        // Sfc column: green check if hit surface, red X if not; yellow warning if no valid splash
        var sfcIcon, sfcColor, sfcTip;
        if (sonde.hit_surface && (splashSource === 'splash' || splashSource === 'hyd')) {
            sfcIcon = '\u2713'; sfcColor = '#34d399'; sfcTip = 'Valid surface measurement';
        } else if (sonde.hit_surface && splashSource === 'est') {
            sfcIcon = '\u26A0'; sfcColor = '#fbbf24'; sfcTip = 'Hit surface but no splash pressure in metadata';
        } else {
            sfcIcon = '\u2717'; sfcColor = '#f87171'; sfcTip = 'Did not reach surface';
        }

        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;" ' +
            'onclick="archiveShowSondeSkewT(' + idx + ')" ' +
            'onmouseover="this.style.background=\'rgba(52,211,153,0.1)\'" ' +
            'onmouseout="this.style.background=\'none\'">' +
            '<td style="padding:2px 4px;color:' + color + ';font-weight:bold;">' + (idx+1) + '</td>' +
            '<td style="padding:2px 4px;">' + (sonde.sonde_id || '-') + '</td>' +
            '<td style="padding:2px 4px;">' + timeStr + '</td>' +
            '<td style="padding:2px 4px;text-align:right;">' + dtStr + '</td>' +
            '<td style="padding:2px 4px;text-align:right;" title="Wind at 150 m AGL (m/s)">' + wl150Str + '</td>' +
            '<td style="padding:2px 4px;text-align:right;">' + wspdStr + '</td>' +
            '<td style="padding:2px 4px;text-align:right;color:' + presColor + ';" title="' + presTip + '">' + presStr + '</td>' +
            '<td style="padding:2px 4px;text-align:center;color:' + sfcColor + ';" title="' + sfcTip + '">' + sfcIcon + '</td>' +
            '<td style="padding:2px 4px;"><button class="cs-btn" style="padding:1px 6px;font-size:9px;color:' + color + ';" ' +
            'onclick="event.stopPropagation();archiveShowSondeSkewT(' + idx + ')">Skew-T</button></td>' +
            '<td style="padding:2px 4px;"><button class="cs-btn" style="padding:1px 6px;font-size:9px;color:#22c55e;" ' +
            'onclick="event.stopPropagation();archiveShowSondeWind(' + idx + ')">Wind</button></td>' +
            '</tr>';
    });

    html += '</table></div>';

    // Splash/surface quality legend
    html += '<div style="font-size:9px;color:#9ca3af;padding:2px 6px;margin-top:2px;">' +
        'Psfc: <span style="color:#34d399;">green</span>=GPS splash, ' +
        '<span style="color:#fbbf24;">yellow</span>=hydrostatic, ' +
        '<span style="color:#f87171;">red</span>=estimated &nbsp;|&nbsp; ' +
        'Sfc: <span style="color:#34d399;">\u2713</span>=valid splash, ' +
        '<span style="color:#fbbf24;">\u26A0</span>=no splash data, ' +
        '<span style="color:#f87171;">\u2717</span>=no surface' +
        '</div>';

    // Skew-T chart container + info panel
    html += '<div id="archive-skewt-container" style="display:none;margin-top:8px;">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;padding:2px 6px;">' +
            '<div id="archive-skewt-title" style="color:#e5e7eb;font-size:11px;font-weight:600;flex:1;min-width:0;"></div>' +
            '<div style="display:flex;align-items:center;flex-shrink:0;margin-left:4px;">' +
                '<button onclick="archiveSaveSondePNG(\'archive-skewt-chart\',\'SkewT\')" ' +
                    'title="Save as PNG" class="rt-save-png-btn" style="margin-right:4px;">' +
                    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                    '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>' +
                    '<circle cx="12" cy="13" r="4"/></svg></button>' +
                '<button onclick="document.getElementById(\'archive-skewt-container\').style.display=\'none\'" ' +
                    'class="cs-btn" style="padding:0 6px;font-size:13px;line-height:1;">&times;</button>' +
            '</div>' +
        '</div>' +
        '<div id="archive-skewt-chart" style="width:100%;height:460px;"></div>' +
        '<div id="archive-skewt-info" style="padding:4px 8px;"></div>' +
        '</div>';

    // Wind profile chart container
    html += '<div id="archive-wind-container" style="display:none;margin-top:8px;">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;padding:2px 6px;">' +
            '<div id="archive-wind-title" style="color:#e5e7eb;font-size:11px;font-weight:600;flex:1;min-width:0;"></div>' +
            '<div style="display:flex;align-items:center;flex-shrink:0;margin-left:4px;">' +
                '<button onclick="archiveSaveSondePNG(\'archive-wind-chart\',\'WindProfile\')" ' +
                    'title="Save as PNG" class="rt-save-png-btn" style="margin-right:4px;">' +
                    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                    '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>' +
                    '<circle cx="12" cy="13" r="4"/></svg></button>' +
                '<button onclick="document.getElementById(\'archive-wind-container\').style.display=\'none\'" ' +
                    'class="cs-btn" style="padding:0 6px;font-size:13px;line-height:1;">&times;</button>' +
            '</div>' +
        '</div>' +
        '<div id="archive-wind-chart" style="width:100%;height:420px;"></div>' +
        '<div id="archive-wind-info" style="padding:4px 8px;"></div>' +
        '</div>';

    panel.innerHTML = html;
}

function archiveShowSondeSkewT(idx) {
    if (!_archiveSondeData || !_archiveSondeData.dropsondes[idx]) return;

    var sonde = _archiveSondeData.dropsondes[idx];
    var p = sonde.profile;
    var container = document.getElementById('archive-skewt-container');
    if (container) container.style.display = 'block';

    var chartDiv = document.getElementById('archive-skewt-chart');
    if (!chartDiv) return;

    if (!p.pres || !p.temp || p.pres.length < 5) return;

    // Build profiles object expected by renderSkewT():
    //   { plev: hPa[], t: Kelvin[], q: kg/kg[], u: m/s[], v: m/s[] }
    var plev = [], tK = [], qArr = [], uArr = [], vArr = [];
    var eps = 0.622;

    for (var i = 0; i < p.pres.length; i++) {
        if (p.pres[i] == null || p.temp[i] == null) continue;
        var pHpa = p.pres[i];
        var tCel = p.temp[i];
        if (pHpa < 50 || pHpa > 1100) continue;

        plev.push(pHpa);
        tK.push(tCel + 273.15);

        // Compute specific humidity q from RH
        var q = null;
        if (p.rh && p.rh[i] != null && p.rh[i] > 0) {
            var es = 6.112 * Math.exp(17.67 * tCel / (tCel + 243.5));
            var e = (p.rh[i] / 100.0) * es;
            if (e < pHpa) q = eps * e / (pHpa - e);
        }
        qArr.push(q);

        uArr.push(p.uwnd ? p.uwnd[i] : null);
        vArr.push(p.vwnd ? p.vwnd[i] : null);
    }

    if (plev.length < 5) return;

    var profiles = { plev: plev, t: tK, q: qArr, u: uArr, v: vArr };

    // Set title with storm name and mission ID
    var titleEl = document.getElementById('archive-skewt-title');
    if (titleEl) {
        var tOff = sonde.time_offset_min != null ?
            ' (T' + (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min)' : '';
        var stormLabel = currentCaseData ? currentCaseData.storm_name : '';
        var missionLabel = currentCaseData ? currentCaseData.mission_id : '';
        var sfcTag = sonde.hit_surface ?
            ' <span style="color:#34d399;">\u2713 Sfc</span>' :
            ' <span style="color:#f87171;">\u2717 No sfc</span>';
        titleEl.innerHTML =
            '\uD83E\uDE82 ' + (stormLabel || '') +
            (missionLabel ? ' <span style="color:#9ca3af;">(' + missionLabel + ')</span>' : '') +
            '<br>' +
            '<span style="color:#94a3b8;">' + (sonde.sonde_id || 'Sonde ' + (idx + 1)) +
            ' \u2014 ' + sonde.launch_time + tOff + '</span>' + sfcTag;
    }

    // Render proper Skew-T using the global renderSkewT function
    if (typeof renderSkewT === 'function') {
        renderSkewT(profiles, 'archive-skewt-chart');
    }

    // Dynamic vertical scaling: adjust y-axis to sonde's data range + rebuild barbs
    _archiveAdjustSkewTYAxis(plev, profiles);

    // Render info panel with WL150 / WL500
    _archiveRenderSondeSkewTInfo(profiles, sonde);

    // Scroll into view
    if (container) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Dynamic y-axis adjustment for archive Skew-T ──
function _archiveAdjustSkewTYAxis(plev, profiles) {
    var el = document.getElementById('archive-skewt-chart');
    if (!el || !el.layout) return;

    var pMin = 1100, pMax = 0;
    for (var i = 0; i < plev.length; i++) {
        if (plev[i] < pMin) pMin = plev[i];
        if (plev[i] > pMax) pMax = plev[i];
    }
    // Pad: 10 hPa above max, extend bottom to at least 1020
    pMax = Math.min(1060, Math.max(pMax + 10, 1020));
    pMin = Math.max(50, pMin - 10);

    var newRange = [Math.log10(pMax), Math.log10(pMin)];
    if (Math.abs(newRange[0] - el.layout.yaxis.range[0]) < 0.01 &&
        Math.abs(newRange[1] - el.layout.yaxis.range[1]) < 0.01) return;

    // Rebuild wind barbs for new y-range
    var xRange = el.layout.xaxis.range || [-30, 50];
    var barbShapes = [];
    if (typeof _buildWindBarbShapes === 'function' && profiles.u && profiles.v) {
        var barbX = xRange[1] - 3;
        barbShapes = _buildWindBarbShapes(profiles.u, profiles.v, profiles.plev, barbX, 0.045, {
            xMin: xRange[0], xMax: xRange[1],
            logPMin: newRange[0], logPMax: newRange[1],
        });
    }

    var existingShapes = (el.layout.shapes || []).filter(function(s) {
        return !(s.line && s.line.color && s.line.color.indexOf('220,220,240') >= 0);
    });

    Plotly.relayout('archive-skewt-chart', {
        'yaxis.range': newRange,
        shapes: existingShapes.concat(barbShapes),
    });
}

// ── Info panel with thermodynamic indices + WL150 / WL500 ──
function _archiveRenderSondeSkewTInfo(profiles, sonde) {
    var el = document.getElementById('archive-skewt-info');
    if (!el || !profiles || !profiles.t || !profiles.plev) { if (el) el.innerHTML = ''; return; }

    var plev = profiles.plev;
    var tK = profiles.t;
    var q = profiles.q;
    var eps = 0.622, Rd = 287.04, Cp = 1005.7, Lv = 2.501e6, g = 9.81;

    var tC = tK.map(function(v) { return v != null ? v - 273.15 : null; });

    // Dewpoint from q
    var tdC = [];
    for (var i = 0; i < plev.length; i++) {
        if (q[i] != null && q[i] > 0 && plev[i] != null) {
            var e = q[i] * plev[i] / (eps + q[i]);
            if (e > 0) {
                var lnE = Math.log(e / 6.112);
                tdC.push(243.5 * lnE / (17.67 - lnE));
            } else { tdC.push(null); }
        } else { tdC.push(null); }
    }

    // -- Precipitable Water (PWAT) via pressure integration --
    var pwat = null;
    var pw = 0;
    for (var i = 0; i < plev.length - 1; i++) {
        if (q[i] != null && q[i + 1] != null && plev[i] != null && plev[i + 1] != null) {
            var qAvg = (q[i] + q[i + 1]) / 2.0;
            var dp = Math.abs(plev[i] - plev[i + 1]) * 100; // Pa
            pw += qAvg * dp / g;
        }
    }
    if (pw > 0) pwat = pw; // kg/m² = mm

    // -- Freezing level --
    var frzLvl = null;
    for (var i = 0; i < plev.length - 1; i++) {
        if (tC[i] != null && tC[i + 1] != null && tC[i] > 0 && tC[i + 1] <= 0) {
            var frac = tC[i] / (tC[i] - tC[i + 1]);
            frzLvl = plev[i] + frac * (plev[i + 1] - plev[i]);
            break;
        }
    }

    // -- WL150 and WL500: mean wind speed over lowest 150m and 500m AGL --
    // Only compute for sondes that hit the surface (otherwise layer is meaningless)
    var sp = sonde.profile;
    var wl150 = null, wl500 = null;
    if (sonde.hit_surface && sp && sp.alt_km && sp.wspd && sp.alt_km.length > 3) {
        // Find surface altitude (lowest valid altitude near end of arrays)
        var sfcAltKm = null;
        for (var ai = sp.alt_km.length - 1; ai >= 0; ai--) {
            if (sp.alt_km[ai] != null) { sfcAltKm = sp.alt_km[ai]; break; }
        }
        if (sfcAltKm != null) {
            var layers = [
                { name: 'WL150', top: 0.15, sum: 0, cnt: 0 },
                { name: 'WL500', top: 0.50, sum: 0, cnt: 0 },
            ];
            for (var li = 0; li < layers.length; li++) {
                var topKm = sfcAltKm + layers[li].top;
                for (var wi = 0; wi < sp.alt_km.length; wi++) {
                    if (sp.alt_km[wi] == null || sp.wspd[wi] == null) continue;
                    if (sp.alt_km[wi] >= sfcAltKm && sp.alt_km[wi] <= topKm) {
                        layers[li].sum += sp.wspd[wi];
                        layers[li].cnt++;
                    }
                }
            }
            // Require minimum 3 data points for a meaningful average
            if (layers[0].cnt >= 3) wl150 = layers[0].sum / layers[0].cnt;
            if (layers[1].cnt >= 3) wl500 = layers[1].sum / layers[1].cnt;
        }
    }

    // -- Surface pressure & max wind --
    var sfcP = null;
    if (plev.length > 0) sfcP = plev[plev.length - 1] > plev[0] ? plev[plev.length - 1] : plev[0];
    var maxWspd = null;
    if (sp && sp.wspd) {
        for (var i = 0; i < sp.wspd.length; i++) {
            if (sp.wspd[i] != null && (maxWspd === null || sp.wspd[i] > maxWspd)) maxWspd = sp.wspd[i];
        }
    }

    // Determine splash quality
    var splashSrc = 'none';
    if (sonde.splash_pr != null && sonde.splash_pr > 0) splashSrc = 'splash';
    else if (sonde.hyd_sfcp != null && sonde.hyd_sfcp > 0) splashSrc = 'hyd';
    else if (sfcP != null) splashSrc = 'est';

    var splashColor = splashSrc === 'splash' ? '#34d399' :
                      splashSrc === 'hyd' ? '#fbbf24' :
                      splashSrc === 'est' ? '#f87171' : '#6b7280';
    var splashLabel = splashSrc === 'splash' ? ' (GPS)' :
                      splashSrc === 'hyd' ? ' (hyd)' :
                      splashSrc === 'est' ? ' (est)' : '';

    // Build HTML table
    var items = [];
    if (sfcP != null) items.push(['Psfc', '<span style="color:' + splashColor + ';">' + sfcP.toFixed(1) + ' hPa' + splashLabel + '</span>']);
    if (maxWspd != null) items.push(['Vmax', maxWspd.toFixed(1) + ' m/s (' + (maxWspd * 1.944).toFixed(0) + ' kt)']);
    if (wl150 != null) items.push(['WL150', wl150.toFixed(1) + ' m/s (' + (wl150 * 1.944).toFixed(0) + ' kt)']);
    else if (!sonde.hit_surface) items.push(['WL150', '<span style="color:#6b7280;">N/A (no sfc)</span>']);
    if (wl500 != null) items.push(['WL500', wl500.toFixed(1) + ' m/s (' + (wl500 * 1.944).toFixed(0) + ' kt)']);
    else if (!sonde.hit_surface) items.push(['WL500', '<span style="color:#6b7280;">N/A (no sfc)</span>']);
    if (pwat != null) items.push(['PWAT', pwat.toFixed(1) + ' mm']);
    if (frzLvl != null) items.push(['0\u00b0C', frzLvl.toFixed(0) + ' hPa']);
    items.push(['Aircraft', sonde.aircraft || '\u2014']);
    if (sonde.gps_verr != null) items.push(['GPS err', sonde.gps_verr.toFixed(1) + ' m']);

    if (items.length === 0) { el.innerHTML = ''; return; }

    var h = '<div style="display:flex;flex-wrap:wrap;gap:4px 12px;font-size:10px;color:#94a3b8;">';
    for (var i = 0; i < items.length; i++) {
        h += '<span><b style="color:#e2e8f0;">' + items[i][0] + ':</b> ' + items[i][1] + '</span>';
    }
    h += '</div>';
    el.innerHTML = h;
}

// ── Wind profile plot for archive dropsondes ──
function archiveShowSondeWind(idx) {
    if (!_archiveSondeData || !_archiveSondeData.dropsondes[idx]) return;

    var sonde = _archiveSondeData.dropsondes[idx];
    var p = sonde.profile;
    var container = document.getElementById('archive-wind-container');
    if (container) container.style.display = 'block';
    // Hide Skew-T if open
    var skContainer = document.getElementById('archive-skewt-container');
    if (skContainer) skContainer.style.display = 'none';

    var chartDiv = document.getElementById('archive-wind-chart');
    if (!chartDiv) return;

    if (!p.pres || !p.wspd || p.pres.length < 5) return;

    var color = _archSondeColor(idx);

    // Build filtered arrays for wind speed, temp, dewpoint vs pressure
    // Also build a pressure→altitude lookup for the right-side altitude axis and hover
    var wspdArr = [], presWspd = [], altWspd = [];
    var tempArr = [], presTemp = [], altTemp = [];
    var dewArr = [], presDew = [], altDew = [];
    var presAltMap = [];  // [{pres, alt_km}] for building the right axis
    for (var i = 0; i < p.pres.length; i++) {
        if (p.pres[i] == null) continue;
        var _altKm = (p.alt_km && p.alt_km[i] != null) ? p.alt_km[i] : null;
        if (_altKm != null) presAltMap.push({ pres: p.pres[i], alt: _altKm });
        if (p.wspd[i] != null) { wspdArr.push(p.wspd[i]); presWspd.push(p.pres[i]); altWspd.push(_altKm); }
        if (p.temp[i] != null) { tempArr.push(p.temp[i]); presTemp.push(p.pres[i]); altTemp.push(_altKm); }
        // Compute dewpoint from RH + T via Magnus formula
        if (p.temp[i] != null && p.rh && p.rh[i] != null && p.rh[i] > 0) {
            var _T = p.temp[i], _RH = p.rh[i];
            var _a = 17.27, _b = 237.7;
            var _gam = (_a * _T) / (_b + _T) + Math.log(_RH / 100.0);
            var _Td = (_b * _gam) / (_a - _gam);
            dewArr.push(_Td); presDew.push(p.pres[i]); altDew.push(_altKm);
        }
    }

    // Helper: interpolate altitude from pressure using the profile's pres/alt pairs
    function _interpAltKm(targetPres) {
        if (presAltMap.length < 2) return null;
        // presAltMap is in profile order (high→low pressure typically)
        // Find bracketing pair
        var best = null;
        for (var k = 0; k < presAltMap.length - 1; k++) {
            var p0 = presAltMap[k].pres, p1 = presAltMap[k + 1].pres;
            if ((p0 <= targetPres && p1 >= targetPres) || (p0 >= targetPres && p1 <= targetPres)) {
                var frac = (p1 !== p0) ? (targetPres - p0) / (p1 - p0) : 0;
                best = presAltMap[k].alt + frac * (presAltMap[k + 1].alt - presAltMap[k].alt);
                break;
            }
        }
        return best;
    }

    // Compute WL150 and WL500
    var wl150 = null, wl500 = null, wl150Top = null, wl500Top = null;
    var sfcAltKm = null;
    if (p.alt_km && p.alt_km.length > 3) {
        for (var ai = p.alt_km.length - 1; ai >= 0; ai--) {
            if (p.alt_km[ai] != null) { sfcAltKm = p.alt_km[ai]; break; }
        }
    }
    // Also find sfc pressure for WL layer annotation
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
                // Find pressure at the top of the layer
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

    // Wind speed trace (primary x-axis) — include altitude in hover
    traces.push({
        x: wspdArr, y: presWspd,
        type: 'scatter', mode: 'lines',
        line: { color: '#22c55e', width: 2.5 },
        name: 'Wind Speed (m/s)',
        customdata: altWspd,
        hovertemplate: '%{y:.0f} hPa (%{text} m): %{x:.1f} m/s<extra>Wspd</extra>',
        text: altWspd.map(function(a) { return a != null ? (a * 1000).toFixed(0) : '?'; }),
    });

    // Temperature trace (secondary x-axis, top)
    if (tempArr.length > 5) {
        traces.push({
            x: tempArr, y: presTemp,
            type: 'scatter', mode: 'lines',
            line: { color: '#ef4444', width: 1.8 },
            name: 'Temp (\u00b0C)',
            xaxis: 'x2', yaxis: 'y',
            customdata: altTemp,
            hovertemplate: '%{y:.0f} hPa (%{text} m): T = %{x:.1f}\u00b0C<extra></extra>',
            text: altTemp.map(function(a) { return a != null ? (a * 1000).toFixed(0) : '?'; }),
        });
    }

    // Dewpoint trace (secondary x-axis, top)
    if (dewArr.length > 5) {
        traces.push({
            x: dewArr, y: presDew,
            type: 'scatter', mode: 'lines',
            line: { color: '#3b82f6', width: 1.5, dash: 'dash' },
            name: 'Dewpoint (\u00b0C)',
            xaxis: 'x2', yaxis: 'y',
            customdata: altDew,
            hovertemplate: '%{y:.0f} hPa (%{text} m): Td = %{x:.1f}\u00b0C<extra></extra>',
            text: altDew.map(function(a) { return a != null ? (a * 1000).toFixed(0) : '?'; }),
        });
    }

    // WL150 and WL500 horizontal annotation lines + shading
    var shapes = [];
    var annotations = [];

    if (wl150 != null && sfcPresWL != null) {
        var p150Top = wl150Top || (sfcPresWL - 15); // rough estimate if no exact pressure
        shapes.push({
            type: 'rect', xref: 'paper', yref: 'y',
            x0: 0, x1: 1, y0: sfcPresWL, y1: p150Top,
            fillcolor: 'rgba(59,130,246,0.08)', line: { width: 0 },
        });
        // WL150 value line
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
        var p500Top = wl500Top || (sfcPresWL - 55); // rough estimate
        shapes.push({
            type: 'rect', xref: 'paper', yref: 'y',
            x0: 0, x1: 1, y0: sfcPresWL, y1: p500Top,
            fillcolor: 'rgba(251,191,36,0.06)', line: { width: 0 },
        });
        // WL500 value line
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

    // Title with storm name and mission ID
    var tOffStr = sonde.time_offset_min != null ?
        ' (T' + (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min)' : '';
    var titleEl = document.getElementById('archive-wind-title');
    if (titleEl) {
        var stormLabel = currentCaseData ? currentCaseData.storm_name : '';
        var missionLabel = currentCaseData ? currentCaseData.mission_id : '';
        var sfcTag = sonde.hit_surface ?
            ' <span style="color:#34d399;">\u2713 Sfc</span>' :
            ' <span style="color:#f87171;">\u2717 No sfc</span>';
        titleEl.innerHTML =
            '\uD83C\uDF2C\uFE0F ' + (stormLabel || '') +
            (missionLabel ? ' <span style="color:#9ca3af;">(' + missionLabel + ')</span>' : '') +
            '<br>' +
            '<span style="color:#94a3b8;">' + (sonde.sonde_id || 'Sonde ' + (idx + 1)) +
            ' \u2014 ' + sonde.launch_time + tOffStr + '</span>' + sfcTag;
    }

    // Build info strings for on-plot annotations (visible in saved PNG)
    var maxW = null;
    for (var wi2 = 0; wi2 < wspdArr.length; wi2++) {
        if (maxW === null || wspdArr[wi2] > maxW) maxW = wspdArr[wi2];
    }
    var plotSplashSrc = 'none';
    if (sonde.splash_pr != null && sonde.splash_pr > 0) plotSplashSrc = 'splash';
    else if (sonde.hyd_sfcp != null && sonde.hyd_sfcp > 0) plotSplashSrc = 'hyd';
    else plotSplashSrc = 'est';
    var plotSplashTag = plotSplashSrc === 'splash' ? ' (GPS)' : plotSplashSrc === 'hyd' ? ' (hyd)' : ' (est)';

    var plotTitleLine = (stormLabel || 'Unknown') +
        (missionLabel ? ' (' + missionLabel + ')' : '') +
        ' | ' + (sonde.sonde_id || '?') +
        ' | ' + sonde.launch_time + tOffStr;

    var plotInfoParts = [];
    if (maxW != null) plotInfoParts.push('Vmax: ' + maxW.toFixed(1) + ' m/s (' + (maxW * 1.944).toFixed(0) + ' kt)');
    if (wl150 != null) plotInfoParts.push('WL150: ' + wl150.toFixed(1) + ' m/s (' + (wl150 * 1.944).toFixed(0) + ' kt)');
    if (wl500 != null) plotInfoParts.push('WL500: ' + wl500.toFixed(1) + ' m/s (' + (wl500 * 1.944).toFixed(0) + ' kt)');
    plotInfoParts.push('Psfc: ' + (sfcPresWL ? sfcPresWL.toFixed(0) : '?') + ' hPa' + plotSplashTag);
    if (sonde.aircraft) plotInfoParts.push('Aircraft: ' + sonde.aircraft);

    // Build right-side altitude tick labels at standard pressure levels
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
            side: 'top',
            overlaying: 'x',
            anchor: 'y',
        },
        yaxis: {
            title: { text: 'Pressure (hPa)', font: { color: '#aaa', size: 12 } },
            tickfont: { color: '#aaa', size: 10 },
            gridcolor: 'rgba(255,255,255,0.08)',
            autorange: 'reversed',
            type: 'log',
            range: [Math.log10(pMax), Math.log10(pMin)],
            dtick: 'D1',
        },
        yaxis2: {
            title: { text: 'Altitude (km)', font: { color: '#9ca3af', size: 11 } },
            tickfont: { color: '#9ca3af', size: 9 },
            side: 'right',
            overlaying: 'y',
            type: 'log',
            range: [Math.log10(pMax), Math.log10(pMin)],
            tickvals: altTickVals,
            ticktext: altTickText,
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

    // Add on-plot title and info annotations (visible in saved PNG)
    // Position title above the top x-axis (temperature) so they don't overlap
    layout.annotations.push({
        text: plotTitleLine,
        xref: 'paper', yref: 'paper',
        x: 0.5, y: 1.14,
        showarrow: false,
        font: { color: '#e5e7eb', size: 11 },
        xanchor: 'center',
    });
    layout.annotations.push({
        text: plotInfoParts.join(' \u00b7 '),
        xref: 'paper', yref: 'paper',
        x: 0.5, y: -0.18,
        showarrow: false,
        font: { color: '#94a3b8', size: 9.5 },
        xanchor: 'center', yanchor: 'top',
    });

    Plotly.newPlot(chartDiv, traces, layout, { responsive: true, displayModeBar: false });

    // Clear the info div (info is now shown as on-plot annotation)
    var infoEl = document.getElementById('archive-wind-info');
    if (infoEl) infoEl.innerHTML = '';

    // Scroll into view
    if (container) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Clear sonde state when case changes (called from openSidePanel)
function _archiveSondeReset() {
    _archiveSondeActive = false;
    _archiveSondeData = null;
    _archiveSondeTraceIndices = [];
    var btn = document.getElementById('btn-archive-sonde');
    if (btn) { btn.textContent = '\uD83E\uDE82 Sondes'; btn.classList.remove('sonde-active'); btn.classList.remove('active'); btn.disabled = false; }
    _archiveHideSondePanel();
}


// ═══════════════════════════════════════════════════════════════
// ── MICROWAVE SATELLITE OVERLAY (TC-PRIMED) ──────────────────
// ═══════════════════════════════════════════════════════════════

var _mwMapOverlay = null;       // L.imageOverlay on the Leaflet map
var _mwOverpassData = [];       // array of overpass objects from the API
var _mwVisible = false;         // whether the MW layer is shown
var _mwLastCaseIndex = null;    // last case we fetched overpasses for
var _mwStormGrid = null;        // storm-relative grid data for Plotly overlay
var _mwPlanViewTraceIdx = null; // index of MW trace in Plotly chart (for removal)
var _mwPlanViewVisible = true;  // whether the MW contour is shown on plan view
var _mwColorscale = null;       // NRL colorscale from API
var _mwVmin = 105;              // current MW color bounds
var _mwVmax = 305;
var _mwIsRGB = false;           // true when showing 37color product
var _mwStormGridRGBb64 = null;  // base64 RGB image for 37color plan view
var _mwMapColorbar = null;      // L.control for MW colorbar on Leaflet map
var _irMapColorbar = null;      // L.control for IR colorbar on Leaflet map

/**
 * Toggle the microwave satellite overlay on/off.
 * First click: fetch overpasses for the current case & show the selector panel.
 * Subsequent: toggle visibility.
 */
function toggleMicrowaveOverlay() {
    _ga('toggle_microwave_overlay', { case_index: currentCaseIndex });
    var btn = document.getElementById('mw-overlay-btn');
    var panel = document.getElementById('mw-overpass-panel');
    if (!btn || !panel) return;

    if (_mwVisible) {
        // Hide
        _mwVisible = false;
        btn.classList.remove('active');
        panel.style.display = 'none';
        if (_mwMapOverlay) _mwMapOverlay.setOpacity(0);
        _hideMWMapColorbar();
        return;
    }

    // Show
    _mwVisible = true;
    btn.classList.add('active');
    panel.style.display = 'block';

    // If case changed or first time, fetch overpass list
    if (currentCaseIndex !== _mwLastCaseIndex) {
        _mwLastCaseIndex = currentCaseIndex;
        fetchMicrowaveOverpasses(currentCaseIndex);
    } else if (_mwMapOverlay) {
        _mwMapOverlay.setOpacity(0.8);
        var prodSel = document.getElementById('mw-product-select');
        var p = (prodSel && prodSel.value) || '89pct';
        _showMWMapColorbar(p, _mwVmin, _mwVmax);
    }
}

/**
 * Fetch the list of available microwave overpasses for a case.
 */
function fetchMicrowaveOverpasses(caseIdx) {
    var sel = document.getElementById('mw-overpass-select');
    var status = document.getElementById('mw-status');
    if (!sel) return;
    sel.innerHTML = '<option value="">Loading...</option>';
    if (status) status.textContent = '';

    fetch(API_BASE + '/microwave/overpasses?case_index=' + caseIdx)
        .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function(json) {
            _mwOverpassData = json.overpasses || [];
            sel.innerHTML = '';

            if (_mwOverpassData.length === 0) {
                sel.innerHTML = '<option value="">No overpasses found</option>';
                if (status) status.textContent = 'No MW data within \u00b1' + (json.window_hours || 6) + 'h';
                return;
            }

            // Build index array sorted chronologically (by offset_minutes)
            // while _mwOverpassData stays sorted by |offset| (closest first)
            var chronOrder = [];
            for (var i = 0; i < _mwOverpassData.length; i++) chronOrder.push(i);
            chronOrder.sort(function(a, b) {
                return _mwOverpassData[a].offset_minutes - _mwOverpassData[b].offset_minutes;
            });

            // The closest overpass is always index 0 in _mwOverpassData
            var closestIdx = 0;

            for (var ci = 0; ci < chronOrder.length; ci++) {
                var origIdx = chronOrder[ci];
                var op = _mwOverpassData[origIdx];
                var sign = op.offset_minutes >= 0 ? '+' : '';
                var label = op.sensor + ' / ' + op.platform +
                    ' (' + sign + Math.round(op.offset_minutes) + ' min)';
                var opt = document.createElement('option');
                opt.value = origIdx;
                opt.textContent = label;
                if (origIdx === closestIdx) opt.selected = true;
                sel.appendChild(opt);
            }

            if (status) status.textContent = _mwOverpassData.length + ' overpass(es)';

            // Auto-load the closest overpass (already selected)
            loadMicrowaveOverpass();
        })
        .catch(function(e) {
            sel.innerHTML = '<option value="">Error loading overpasses</option>';
            if (status) status.textContent = 'Error: ' + e.message;
        });
}

/**
 * Load the selected overpass image onto the Leaflet map.
 */
function loadMicrowaveOverpass() {
    var sel = document.getElementById('mw-overpass-select');
    var prodSel = document.getElementById('mw-product-select');
    var status = document.getElementById('mw-status');
    if (!sel || sel.value === '') return;

    var idx = parseInt(sel.value, 10);
    var op = _mwOverpassData[idx];
    if (!op) return;

    var product = (prodSel && prodSel.value) || '89pct';

    // Check if the sensor supports this product
    var is37 = (product === '37h' || product === '37v' || product === '37color');
    var is89 = (product === '89pct' || product === '89v' || product === '89h');
    if (is37 && !op.has_37) {
        if (status) status.textContent = op.sensor + ' does not have 37 GHz';
        return;
    }
    if (is89 && !op.has_89) {
        if (status) status.textContent = op.sensor + ' does not have 89 GHz';
        return;
    }

    if (status) status.textContent = 'Loading ' + product + '...';

    var url = API_BASE + '/microwave/data?s3_key=' + encodeURIComponent(op.s3_key) +
        '&product=' + product;
    if (currentCaseData) {
        url += '&center_lat=' + currentCaseData.latitude +
               '&center_lon=' + currentCaseData.longitude;
    }

    fetch(url)
        .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function(json) {
            if (!json.image_b64 || !json.bounds) {
                if (status) status.textContent = 'No data returned';
                return;
            }

            var imgUrl = 'data:image/png;base64,' + json.image_b64;
            var bounds = L.latLngBounds(
                L.latLng(json.bounds[0][0], json.bounds[0][1]),
                L.latLng(json.bounds[1][0], json.bounds[1][1])
            );

            console.log('[MW] Overlay bounds:', JSON.stringify(json.bounds),
                'img length:', json.image_b64.length, '_mwVisible:', _mwVisible,
                'map exists:', !!map);

            // ── Leaflet image overlay ──
            if (_mwMapOverlay) {
                map.removeLayer(_mwMapOverlay);
            }
            _mwMapOverlay = L.imageOverlay(imgUrl, bounds, {
                opacity: 0.85, interactive: false, zIndex: 650
            });
            _mwMapOverlay.addTo(map);

            // Store colorscale and bounds from API
            _mwIsRGB = !!json.is_rgb;
            if (json.colorscale) _mwColorscale = json.colorscale;
            if (json.vmin != null) _mwVmin = json.vmin;
            if (json.vmax != null) _mwVmax = json.vmax;
            _mwStormGridRGBb64 = json.storm_grid_rgb_b64 || null;

            // Update color bounds controls visibility (hide for 37color)
            var vminEl = document.getElementById('mw-vmin');
            var vmaxEl = document.getElementById('mw-vmax');
            if (vminEl) vminEl.style.display = _mwIsRGB ? 'none' : '';
            if (vmaxEl) vmaxEl.style.display = _mwIsRGB ? 'none' : '';
            // Update vmin/vmax inputs to reflect current values
            if (!_mwIsRGB) {
                if (vminEl) vminEl.value = _mwVmin;
                if (vmaxEl) vmaxEl.value = _mwVmax;
            }

            // ── Plotly plan-view overlay ──
            // Auto-enable MW plan view when storm grid data is available
            if ((_mwIsRGB && _mwStormGridRGBb64) || (json.storm_grid && json.storm_grid.z)) {
                _mwStormGrid = json.storm_grid;
                if (!_mwPlanViewVisible) {
                    _mwPlanViewVisible = true;
                    var pvBtn = document.getElementById('mw-planview-btn');
                    if (pvBtn) pvBtn.classList.add('active');
                }
                _applyMWPlanViewOverlay();
            }

            // Show MW colorbar on the Leaflet map
            _showMWMapColorbar(product, _mwVmin, _mwVmax);

            if (status) status.textContent = json.sensor + ' ' + json.datetime;

            // Add/update download button next to status text
            var dlBtn = document.getElementById('mw-download-btn');
            if (!dlBtn) {
                dlBtn = document.createElement('a');
                dlBtn.id = 'mw-download-btn';
                dlBtn.style.cssText = 'font-size:9px;padding:2px 6px;border:1px solid rgba(251,146,60,0.5);border-radius:3px;color:#fdba74;text-decoration:none;white-space:nowrap;cursor:pointer;';
                dlBtn.textContent = '\u2193 Save';
                if (status && status.parentNode) status.parentNode.insertBefore(dlBtn, status.nextSibling);
            }
            var dtSafe = (json.datetime || '').replace(/[^0-9A-Za-z]/g, '_').replace(/_+/g, '_').replace(/_$/, '');
            dlBtn.href = imgUrl;
            dlBtn.download = 'MW_' + (json.sensor || 'sensor') + '_' + product + '_' + dtSafe + '.png';
        })
        .catch(function(e) {
            if (status) status.textContent = 'Error: ' + e.message;
            var dlBtn = document.getElementById('mw-download-btn');
            if (dlBtn) dlBtn.remove();
        });
}

// ── MW Plan-View Overlay (Plotly contour on the TDR plan view) ──

function _createStandaloneMWPlanView() {
    var chartEl = document.getElementById('plotly-chart');
    if (!chartEl) {
        // The dual-panel structure hasn't been created yet (no TDR plot generated).
        // Create it now so we have a plotly-chart div to render into.
        var resultDiv = document.getElementById('explorer-result');
        if (!resultDiv) return;
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        resultDiv.innerHTML =
            '<div class="dual-panel-wrap" id="dual-panel-wrap">' +
                '<div class="dual-pane" id="dual-pane-left">' +
                    '<div class="dual-pane-label">Microwave Satellite</div>' +
                    '<div class="dual-pane-inner" style="position:relative;">' +
                        '<div id="plotly-chart" style="width:100%;height:100%;min-height:360px;"></div>' +
                        '<button onclick="openPlotModal()" title="Expand to fullscreen" style="position:absolute;top:6px;left:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:28px;height:28px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">\u26F6</button>' +
                    '</div>' +
                '</div>' +
                '<div class="dual-pane-divider" title="Toggle azimuthal mean panel" onclick="_toggleDualPane()"></div>' +
                '<div class="dual-pane" id="dual-pane-right">' +
                    '<div class="dual-pane-label">Azimuthal Mean</div>' +
                    '<div id="az-result" class="az-result"></div>' +
                '</div>' +
            '</div>';
        chartEl = document.getElementById('plotly-chart');
        if (!chartEl) return;
    }

    var prodSel = document.getElementById('mw-product-select');
    var product = (prodSel && prodSel.value) || '89pct';
    var sel = document.getElementById('mw-overpass-select');
    var idx = sel ? parseInt(sel.value, 10) : 0;
    var op = (_mwOverpassData && _mwOverpassData[idx]) || {};
    var statusEl = document.getElementById('mw-status');
    var sensorDt = statusEl ? statusEl.textContent : ((op.sensor || 'MW') + ' ' + (op.datetime || ''));
    var titleText = sensorDt + ' | ' + product.toUpperCase();

    var plotBg = '#0a1628';
    var config = { responsive: true, displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d','select2d','toggleSpikelines'], displaylogo: false };
    var centerTrace = { x: [0], y: [0], type: 'scatter', mode: 'markers',
        marker: { symbol: 'cross', size: 10, color: 'white', line: { color: 'white', width: 2 } },
        showlegend: false, hoverinfo: 'skip', _isMW: true };

    if (_mwIsRGB && _mwStormGridRGBb64) {
        var ext = (_mwStormGrid && _mwStormGrid.extent_km) || 250;
        var layout = {
            title: { text: titleText, font: { color: '#e5e7eb', size: 11 }, y: 0.96, x: 0.5, xanchor: 'center', yanchor: 'top' },
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 10 } },
                     tickfont: { color: '#aaa', size: 9 },
                     gridcolor: 'rgba(255,255,255,0.04)', zeroline: true,
                     zerolinecolor: 'rgba(255,255,255,0.12)',
                     scaleanchor: 'y', range: [-ext, ext] },
            yaxis: { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 10 } },
                     tickfont: { color: '#aaa', size: 9 },
                     gridcolor: 'rgba(255,255,255,0.04)', zeroline: true,
                     zerolinecolor: 'rgba(255,255,255,0.12)',
                     scaleanchor: 'x', scaleratio: 1, range: [-ext, ext] },
            margin: { l: 52, r: 16, t: 46, b: 44 },
            images: [{ source: 'data:image/png;base64,' + _mwStormGridRGBb64,
                xref: 'x', yref: 'y', x: -ext, y: ext,
                sizex: 2 * ext, sizey: 2 * ext,
                xanchor: 'left', yanchor: 'top',
                sizing: 'stretch', opacity: 0.95, layer: 'below', _isMW: true }],
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } },
            showlegend: false
        };
        Plotly.newPlot('plotly-chart', [centerTrace], layout, config);
        _mwPlanViewTraceIdx = -1;

    } else if (_mwStormGrid && _mwStormGrid.z) {
        var cs = _mwColorscale || [
            [0.000, '#303030'], [0.100, '#606060'], [0.225, '#800000'],
            [0.375, '#FF0000'], [0.500, '#FF8C00'], [0.535, '#FFD700'],
            [0.615, '#ADFF2F'], [0.700, '#00CC44'], [0.745, '#00DDCC'],
            [0.825, '#0066FF'], [0.875, '#0000CC'], [1.000, '#8888FF']
        ];
        var _CBAR_TITLES = {
            '89pct': 'PCT (K)', '89v': '89V TB (K)', '89h': '89H TB (K)',
            '37h': '37H TB (K)', '37v': '37V TB (K)', '37color': '37 Color'
        };
        var cbarTitle = _CBAR_TITLES[product] || 'TB (K)';
        var ext2 = _mwStormGrid.extent_km || 250;
        var mwTrace = {
            z: _mwStormGrid.z, x: _mwStormGrid.x_axis, y: _mwStormGrid.y_axis,
            type: 'heatmap', colorscale: cs, zmin: _mwVmin, zmax: _mwVmax,
            colorbar: { title: { text: cbarTitle, font: { color: '#ccc', size: 10 } },
                        tickfont: { color: '#ccc', size: 9 }, thickness: 12, len: 0.85 },
            hovertemplate: '<b>MW %{z:.0f} K</b><br>X: %{x:.0f} km  Y: %{y:.0f} km<extra>MW</extra>',
            hoverongaps: false, name: 'MW ' + cbarTitle.replace(' (K)', ''), _isMW: true
        };
        var layout2 = {
            title: { text: titleText, font: { color: '#e5e7eb', size: 11 }, y: 0.96, x: 0.5, xanchor: 'center', yanchor: 'top' },
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 10 } },
                     tickfont: { color: '#aaa', size: 9 },
                     gridcolor: 'rgba(255,255,255,0.04)', zeroline: true,
                     zerolinecolor: 'rgba(255,255,255,0.12)',
                     scaleanchor: 'y', range: [-ext2, ext2] },
            yaxis: { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 10 } },
                     tickfont: { color: '#aaa', size: 9 },
                     gridcolor: 'rgba(255,255,255,0.04)', zeroline: true,
                     zerolinecolor: 'rgba(255,255,255,0.12)',
                     scaleanchor: 'x', scaleratio: 1, range: [-ext2, ext2] },
            margin: { l: 52, r: 60, t: 46, b: 44 },
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } },
            showlegend: false
        };
        Plotly.newPlot('plotly-chart', [mwTrace, centerTrace], layout2, config);
        _mwPlanViewTraceIdx = 0;
    }
}

function _applyMWPlanViewOverlay() {
    if (!_mwPlanViewVisible) return;
    var chartEl = document.getElementById('plotly-chart');
    if (!chartEl) return;
    if (!chartEl.data || !chartEl.data.length) {
        _createStandaloneMWPlanView();
        return;
    }

    // Remove any existing MW trace/image first
    removeMWPlanViewOverlay();

    // ── 37 GHz Color Composite: overlay as a Plotly layout image ──
    if (_mwIsRGB && _mwStormGridRGBb64) {
        var ext = (_mwStormGrid && _mwStormGrid.extent_km) || 250;
        var imgSrc = 'data:image/png;base64,' + _mwStormGridRGBb64;
        var layoutUpdate = {
            images: (chartEl.layout.images || []).concat([{
                source: imgSrc,
                xref: 'x', yref: 'y',
                x: -ext, y: ext,
                sizex: 2 * ext, sizey: 2 * ext,
                xanchor: 'left', yanchor: 'top',
                sizing: 'stretch',
                opacity: 0.6,
                layer: 'below',
                _isMW: true
            }])
        };
        Plotly.relayout(chartEl, layoutUpdate);
        _mwPlanViewTraceIdx = -1; // sentinel: means image, not trace
        console.log('[MW] Plan-view 37color RGB image overlay added');
        return;
    }

    // ── Single-channel products: heatmap trace ──
    if (!_mwStormGrid) return;

    // NRL-style Plotly colorscale
    var cs = _mwColorscale || [
        [0.000, '#303030'], [0.100, '#606060'], [0.225, '#800000'],
        [0.375, '#FF0000'], [0.500, '#FF8C00'], [0.535, '#FFD700'],
        [0.615, '#ADFF2F'], [0.700, '#00CC44'], [0.745, '#00DDCC'],
        [0.825, '#0066FF'], [0.875, '#0000CC'], [1.000, '#8888FF']
    ];

    var prodSel = document.getElementById('mw-product-select');
    var product = (prodSel && prodSel.value) || '89pct';
    var _CBAR_TITLES2 = {
        '89pct': 'PCT (K)', '89v': '89V TB (K)', '89h': '89H TB (K)',
        '37h': '37H TB (K)', '37v': '37V TB (K)', '37color': '37 Color'
    };
    var cbarTitle = _CBAR_TITLES2[product] || 'TB (K)';

    var mwTrace = {
        z: _mwStormGrid.z,
        x: _mwStormGrid.x_axis,
        y: _mwStormGrid.y_axis,
        type: 'heatmap',
        colorscale: cs,
        zmin: _mwVmin,
        zmax: _mwVmax,
        opacity: 0.55,
        showscale: false,
        hovertemplate: '<b>MW %{z:.0f} K</b><br>X: %{x:.0f} km  Y: %{y:.0f} km<extra>MW</extra>',
        hoverongaps: false,
        name: 'MW ' + cbarTitle.replace(' (K)', ''),
        _isMW: true  // tag for identification
    };

    // Insert MW trace as the FIRST trace (below the TDR heatmap)
    Plotly.addTraces(chartEl, [mwTrace], [0]);
    _mwPlanViewTraceIdx = 0;
    console.log('[MW] Plan-view overlay added');
}

function removeMWPlanViewOverlay() {
    var chartEl = document.getElementById('plotly-chart');
    if (!chartEl || !chartEl.data) return;

    // Remove any MW heatmap traces
    for (var i = chartEl.data.length - 1; i >= 0; i--) {
        if (chartEl.data[i]._isMW) {
            Plotly.deleteTraces(chartEl, [i]);
        }
    }

    // Remove any MW layout images (37color RGB overlay)
    if (chartEl.layout && chartEl.layout.images && chartEl.layout.images.length > 0) {
        var filtered = chartEl.layout.images.filter(function(img) { return !img._isMW; });
        if (filtered.length !== chartEl.layout.images.length) {
            Plotly.relayout(chartEl, { images: filtered });
        }
    }

    _mwPlanViewTraceIdx = null;
}

function toggleMWPlanView() {
    _mwPlanViewVisible = !_mwPlanViewVisible;
    var btn = document.getElementById('mw-planview-btn');
    if (_mwPlanViewVisible) {
        if (btn) btn.classList.add('active');
        _applyMWPlanViewOverlay();
    } else {
        if (btn) btn.classList.remove('active');
        removeMWPlanViewOverlay();
    }
}

function updateMWColorBounds() {
    var vminEl = document.getElementById('mw-vmin');
    var vmaxEl = document.getElementById('mw-vmax');
    if (vminEl) _mwVmin = parseFloat(vminEl.value) || 105;
    if (vmaxEl) _mwVmax = parseFloat(vmaxEl.value) || 305;
    // Re-apply with new bounds
    if (_mwPlanViewVisible && _mwStormGrid) {
        removeMWPlanViewOverlay();
        _applyMWPlanViewOverlay();
    }
}

// ── Map Colorbars (MW + IR on Leaflet map) ──

/**
 * Show/update the MW colorbar on the Leaflet map.
 * Called when an MW overpass is loaded.
 */
function _showMWMapColorbar(product, vmin, vmax) {
    var el = document.getElementById('mw-map-colorbar');
    if (!el) return;

    if (product === '37color') {
        // 37color: show a compact legend with color patches
        el.innerHTML =
            '<div style="font-size:9px;font-weight:600;color:#fdba74;margin-bottom:3px;">37 GHz Color</div>' +
            '<div style="display:flex;gap:2px;align-items:center;">' +
                '<span style="display:inline-block;width:12px;height:10px;background:#008800;border-radius:2px;" title="Ocean"></span>' +
                '<span style="font-size:8px;color:#94a3b8;">Ocn</span>' +
                '<span style="display:inline-block;width:12px;height:10px;background:#00cccc;border-radius:2px;margin-left:3px;" title="Rain/Cloud"></span>' +
                '<span style="font-size:8px;color:#94a3b8;">Rain</span>' +
                '<span style="display:inline-block;width:12px;height:10px;background:#cc44cc;border-radius:2px;margin-left:3px;" title="Deep Convection"></span>' +
                '<span style="font-size:8px;color:#94a3b8;">Conv</span>' +
            '</div>';
    } else {
        // Single-channel: show a gradient colorbar
        var _CBAR_LABELS = {
            '89pct': '89 GHz PCT', '89v': '89 GHz V-pol', '89h': '89 GHz H-pol',
            '37h': '37 GHz H-pol', '37v': '37 GHz V-pol', '37color': '37 GHz Color'
        };
        var label = _CBAR_LABELS[product] || 'TB (K)';
        // NRL colormap gradient
        var gradientStops = 'linear-gradient(to right, #303030, #606060, #800000, #FF0000, #FF8C00, #FFD700, #ADFF2F, #00CC44, #00DDCC, #0066FF, #0000CC, #8888FF)';
        el.innerHTML =
            '<div style="font-size:9px;font-weight:600;color:#fdba74;margin-bottom:2px;">' + label + '</div>' +
            '<div style="width:140px;height:10px;border-radius:3px;background:' + gradientStops + ';border:1px solid rgba(255,255,255,0.15);"></div>' +
            '<div style="display:flex;justify-content:space-between;font-size:8px;color:#94a3b8;margin-top:1px;">' +
                '<span>' + vmin + ' K</span><span>' + vmax + ' K</span>' +
            '</div>';
    }
    el.style.display = 'block';
}

/**
 * Hide the MW colorbar.
 */
function _hideMWMapColorbar() {
    var el = document.getElementById('mw-map-colorbar');
    if (el) el.style.display = 'none';
}

/**
 * Show/update the IR colorbar on the Leaflet map.
 * Called when IR imagery is loaded and visible.
 */
function _showIRMapColorbar() {
    var el = document.getElementById('ir-map-colorbar');
    if (!el) return;

    // Standard IR brightness temperature colorbar (approx CIRA RAMMB style)
    var gradientStops = 'linear-gradient(to right, #FFFFFF, #C8C8C8, #969696, #646464, #323232, #003264, #0064C8, #0096FF, #00C8FF, #00FF96, #00C800, #96FF00, #FFFF00, #FFC800, #FF9600, #FF0000, #C80000, #960000, #640000, #320000)';
    el.innerHTML =
        '<div style="font-size:9px;font-weight:600;color:#60a5fa;margin-bottom:2px;">IR Brightness Temp</div>' +
        '<div style="width:140px;height:10px;border-radius:3px;background:' + gradientStops + ';border:1px solid rgba(255,255,255,0.15);"></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:8px;color:#94a3b8;margin-top:1px;">' +
            '<span>190 K</span><span>310 K</span>' +
        '</div>';
    el.style.display = 'block';
}

/**
 * Hide the IR colorbar.
 */
function _hideIRMapColorbar() {
    var el = document.getElementById('ir-map-colorbar');
    if (el) el.style.display = 'none';
}

// ── MW Timeline (Storm Evolution section) ──

var _mwTimelineOpen = false;

function toggleMWTimeline() {
    var panel = document.getElementById('mw-timeline-panel');
    if (!panel) return;
    if (_mwTimelineOpen) { closeMWTimeline(); return; }
    _mwTimelineOpen = true;
    panel.style.display = 'block';
    fetchMWTimeline();
}

function closeMWTimeline() {
    _mwTimelineOpen = false;
    var panel = document.getElementById('mw-timeline-panel');
    if (panel) panel.style.display = 'none';
}

function fetchMWTimeline() {
    if (!currentCaseData) return;
    var status = document.getElementById('mw-timeline-status');
    if (status) status.textContent = 'Loading storm overpasses...';

    var stormName = (currentCaseData.storm_name || '').toUpperCase();
    var year = currentCaseData.year;

    fetch(API_BASE + '/microwave/storm_overpasses?storm_name=' +
          encodeURIComponent(stormName) + '&year=' + year)
        .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function(json) {
            var ops = json.overpasses || [];
            if (ops.length === 0) {
                if (status) status.textContent = 'No overpasses found for ' + stormName + ' ' + year;
                return;
            }
            if (status) status.textContent = json.atcf_id + ': ' + ops.length + ' overpasses';
            renderMWTimeline(ops);
        })
        .catch(function(e) {
            if (status) status.textContent = 'Error: ' + e.message;
        });
}

function renderMWTimeline(overpasses) {
    var sensorColors = {
        'GMI': '#00bcd4', 'SSMIS': '#ff7043', 'AMSR2': '#66bb6a',
        'SSMI': '#ab47bc', 'TMI': '#ffa726', 'ATMS': '#42a5f5', 'MHS': '#78909c'
    };

    // Sort overpasses chronologically
    overpasses.sort(function(a, b) {
        return new Date(a.datetime) - new Date(b.datetime);
    });

    // Build ordered sensor list by first-appearance
    var sensorOrder = [];
    var sensorSeen = {};
    for (var i = 0; i < overpasses.length; i++) {
        var s = overpasses[i].sensor;
        if (!sensorSeen[s]) { sensorOrder.push(s); sensorSeen[s] = true; }
    }
    // Map sensor → numeric row (bottom to top for visual clarity)
    var sensorRow = {};
    for (var si = 0; si < sensorOrder.length; si++) {
        sensorRow[sensorOrder[si]] = si;
    }

    // Build traces per sensor using numeric y with small jitter to reduce overlap
    var traces = {};
    var sensorCount = {}; // count per sensor for jitter
    for (var j = 0; j < overpasses.length; j++) {
        var op = overpasses[j];
        var key = op.sensor;
        if (!sensorCount[key]) sensorCount[key] = 0;
        sensorCount[key]++;
    }
    sensorCount = {}; // reset to use as running index
    for (var k = 0; k < overpasses.length; k++) {
        var op2 = overpasses[k];
        var key2 = op2.sensor;
        if (!traces[key2]) {
            traces[key2] = {
                x: [], y: [], text: [], customdata: [], name: key2,
                mode: 'markers',
                marker: {
                    color: sensorColors[key2] || '#aaa',
                    size: 7, symbol: 'circle',
                    opacity: 0.85,
                    line: { width: 1, color: 'rgba(255,255,255,0.3)' }
                },
                hovertemplate: '<b>%{text}</b><extra></extra>',
                type: 'scatter'
            };
            sensorCount[key2] = 0;
        }
        var dt = op2.datetime.replace(' UTC', '').replace(' ', 'T');
        var baseY = sensorRow[key2];
        // Tiny y-jitter so overlapping same-time overpasses separate slightly
        var jitter = (sensorCount[key2] % 3 - 1) * 0.08;
        sensorCount[key2]++;
        traces[key2].x.push(dt);
        traces[key2].y.push(baseY + jitter);
        // Build hover text: sensor / platform / formatted time
        var dtObj = new Date(dt);
        var dateStr = (dtObj.getUTCMonth() + 1) + '/' + dtObj.getUTCDate() + ' ' +
            String(dtObj.getUTCHours()).padStart(2, '0') + ':' +
            String(dtObj.getUTCMinutes()).padStart(2, '0') + 'z';
        traces[key2].text.push(key2 + ' / ' + op2.platform + '<br>' + dateStr);
        traces[key2].customdata.push(k); // index into overpasses array
    }

    var data = [];
    for (var ts in traces) { data.push(traces[ts]); }

    // Current TDR case time indicator
    var shapes = [];
    var annotations = [];
    if (currentCaseData && currentCaseData.datetime) {
        var caseDt = currentCaseData.datetime.replace(' UTC', '').replace(' ', 'T');
        shapes.push({
            type: 'line', x0: caseDt, x1: caseDt,
            y0: -0.5, y1: sensorOrder.length - 0.5,
            line: { color: 'rgba(248,113,113,0.7)', width: 2, dash: 'dot' }
        });
        annotations.push({
            x: caseDt, y: sensorOrder.length - 0.5,
            text: 'TDR', showarrow: false,
            font: { color: '#f87171', size: 9, family: 'JetBrains Mono, monospace' },
            yshift: 10, xanchor: 'center'
        });
    }

    // Y-axis tick labels = sensor names
    var tickvals = [];
    var ticktext = [];
    for (var ti = 0; ti < sensorOrder.length; ti++) {
        tickvals.push(ti);
        ticktext.push(sensorOrder[ti]);
    }

    var layout = {
        xaxis: {
            title: { text: 'Date / Time (UTC)', font: { color: '#94a3b8', size: 10 } },
            color: '#94a3b8',
            gridcolor: 'rgba(255,255,255,0.05)',
            tickfont: { size: 9, color: '#94a3b8' },
            tickformat: '%b %d\n%Hz',
            hoverformat: '%Y-%m-%d %H:%Mz'
        },
        yaxis: {
            title: '',
            color: '#94a3b8',
            gridcolor: 'rgba(255,255,255,0.06)',
            tickvals: tickvals,
            ticktext: ticktext,
            tickfont: { size: 10, color: '#cbd5e1' },
            range: [-0.6, sensorOrder.length - 0.4],
            fixedrange: true
        },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: '#0f172a',
        margin: { t: 12, b: 44, l: 56, r: 8 },
        font: { family: 'JetBrains Mono, monospace' },
        showlegend: false, // sensor names are on y-axis — legend redundant
        shapes: shapes,
        annotations: annotations,
        hovermode: 'closest',
        dragmode: 'zoom'
    };

    var el = document.getElementById('mw-timeline-chart');
    if (!el) return;

    Plotly.newPlot(el, data, layout, {
        responsive: true,
        displayModeBar: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d']
    });

    // Click on a marker → load that overpass in the main archive view
    el.on('plotly_click', function(evtData) {
        if (!evtData || !evtData.points || !evtData.points[0]) return;
        var pt = evtData.points[0];
        var opIdx = pt.customdata;
        if (opIdx == null) return;
        var clicked = overpasses[opIdx];
        if (!clicked) return;
        // Find the matching entry in the overpass dropdown and select it
        var sel = document.getElementById('mw-overpass-select');
        if (sel) {
            for (var oi = 0; oi < sel.options.length; oi++) {
                if (sel.options[oi].value.indexOf(clicked.datetime) !== -1 &&
                    sel.options[oi].value.indexOf(clicked.sensor) !== -1) {
                    sel.selectedIndex = oi;
                    loadMicrowaveOverpass();
                    break;
                }
            }
        }
    });
}


/**
 * Remove the microwave overlay and reset state.
 */
function removeMicrowaveOverlay() {
    if (_mwMapOverlay) { map.removeLayer(_mwMapOverlay); _mwMapOverlay = null; }
    removeMWPlanViewOverlay();
    _hideMWMapColorbar();
    _mwStormGrid = null;
    _mwStormGridRGBb64 = null;
    _mwIsRGB = false;
    _mwOverpassData = [];
    _mwVisible = false;
    _mwLastCaseIndex = null;
    var btn = document.getElementById('mw-overlay-btn');
    if (btn) btn.classList.remove('active');
    var panel = document.getElementById('mw-overpass-panel');
    if (panel) panel.style.display = 'none';
    var dlBtn = document.getElementById('mw-download-btn');
    if (dlBtn) dlBtn.remove();
}


// ── Citation modal ───────────────────────────────────────────
var _CITATIONS = [
    {
        label: 'TC-RADAR Dataset',
        text: 'Fischer, M. S., P. D. Reasor, R. F. Rogers, and J. F. Gamache, 2022: An updated tropical cyclone radar database. Mon. Wea. Rev., 150, 2255\u20132278, https://doi.org/10.1175/MWR-D-21-0223.1.',
        bibtex: '@article{Fischer2022TCRadar,\n  author  = {Fischer, Michael S. and Reasor, Paul D. and Rogers, Robert F. and Gamache, John F.},\n  title   = {An updated tropical cyclone radar database},\n  journal = {Monthly Weather Review},\n  year    = {2022},\n  volume  = {150},\n  pages   = {2255--2278},\n  doi     = {10.1175/MWR-D-21-0223.1}\n}'
    },
    {
        label: 'Vortex Tilt & Precipitation Structure',
        text: 'Fischer, M. S., P. D. Reasor, J. P. Dunion, and R. F. Rogers, 2024: An observational analysis of the relationship between tropical cyclone vortex tilt, precipitation structure, and intensity change. Mon. Wea. Rev., 152, 203\u2013225, https://doi.org/10.1175/MWR-D-23-0089.1.',
        bibtex: '@article{Fischer2024VortexTilt,\n  author  = {Fischer, Michael S. and Reasor, Paul D. and Dunion, Jason P. and Rogers, Robert F.},\n  title   = {An observational analysis of the relationship between tropical cyclone vortex tilt, precipitation structure, and intensity change},\n  journal = {Monthly Weather Review},\n  year    = {2024},\n  volume  = {152},\n  pages   = {203--225},\n  doi     = {10.1175/MWR-D-23-0089.1}\n}'
    },
    {
        label: 'Anomaly-Based Vortex Diagnostics',
        text: 'Fischer, M. S., P. D. Reasor, J. P. Dunion, and R. F. Rogers, 2025: An anomaly-based framework for evaluating tropical cyclone vortex structure. Mon. Wea. Rev., 153, 857\u2013875, https://doi.org/10.1175/MWR-D-24-0101.1.',
        bibtex: '@article{Fischer2025AnomalyFramework,\n  author  = {Fischer, Michael S. and Reasor, Paul D. and Dunion, Jason P. and Rogers, Robert F.},\n  title   = {An anomaly-based framework for evaluating tropical cyclone vortex structure},\n  journal = {Monthly Weather Review},\n  year    = {2025},\n  volume  = {153},\n  pages   = {857--875},\n  doi     = {10.1175/MWR-D-24-0101.1}\n}'
    },
    {
        label: 'TC-ATLAS Web Tool',
        text: 'TC-ATLAS: Tropical Cyclone Analysis Tool for Live and Archived Structure. Available at https://michaelfischerwx.github.io/TC-ATLAS/',
        bibtex: '@misc{TCATLAS,\n  title  = {{TC-ATLAS}: Tropical Cyclone Analysis Tool for Live and Archived Structure},\n  author = {Fischer, Michael S.},\n  year   = {2024},\n  url    = {https://michaelfischerwx.github.io/TC-ATLAS/}\n}'
    }
];

function _citeCopy(text, btn) {
    navigator.clipboard.writeText(text).then(function() {
        var orig = btn.textContent;
        btn.textContent = '\u2713 Copied';
        btn.classList.add('copied');
        setTimeout(function() { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
    }).catch(function() { showToast('Copy failed \u2014 select text manually', 'warn'); });
}

function showCiteModal() {
    var existing = document.getElementById('cite-modal-overlay');
    if (existing) { existing.classList.add('active'); return; }

    var overlay = document.createElement('div');
    overlay.id = 'cite-modal-overlay';
    overlay.className = 'cite-modal-overlay active';
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) overlay.classList.remove('active');
    });

    var entriesHtml = _CITATIONS.map(function(c, i) {
        return '<div class="cite-entry">' +
            '<div class="cite-entry-label">' + c.label + '</div>' +
            '<div class="cite-entry-text">' + c.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
            '<button class="cite-copy-btn" onclick="(function(btn){_citeCopy(' + JSON.stringify(c.text) + ',btn);})(this)">Copy</button>' +
        '</div>';
    }).join('');

    var allBibtex = _CITATIONS.map(function(c) { return c.bibtex; }).join('\n\n');

    overlay.innerHTML =
        '<div class="cite-modal-box">' +
            '<button class="cite-modal-close" onclick="document.getElementById(\'cite-modal-overlay\').classList.remove(\'active\')">\u2715</button>' +
            '<div class="cite-modal-title">\uD83D\uDCCB How to Cite</div>' +
            entriesHtml +
            '<div class="cite-bibtex-row">' +
                '<button class="cite-bibtex-btn" onclick="(function(btn){_citeCopy(' + JSON.stringify(allBibtex) + ',btn);})(this)">' +
                    '\uD83D\uDCCB Copy All BibTeX' +
                '</button>' +
            '</div>' +
        '</div>';

    document.body.appendChild(overlay);

    document.addEventListener('keydown', function _citeEsc(e) {
        if (e.key === 'Escape') {
            var ov = document.getElementById('cite-modal-overlay');
            if (ov && ov.classList.contains('active')) { ov.classList.remove('active'); document.removeEventListener('keydown', _citeEsc); }
        }
    });
}

// Close composite panel on Escape
(function() {
    var orig = document.onkeydown;
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            var ep = document.getElementById('env-overlay');
            if (ep && ep.classList.contains('active')) { toggleEnvOverlay(); e.stopPropagation(); return; }
            var cp = document.getElementById('composite-panel');
            if (cp && cp.classList.contains('active')) { toggleCompositePanel(); e.stopPropagation(); }
        }
    });
})();


// ══════════════════════════════════════════════════════════════
// NEXRAD WSR-88D Ground Radar Module
// ══════════════════════════════════════════════════════════════

var _nexradVisible = false;
var _nexradMapOverlay = null;
var _nexradPlanViewVisible = false;
var _nexradSrData = null;  // storm-relative data for Plotly underlay

/**
 * Fetch nearby NEXRAD sites for the current case.
 */
function fetchNexradSites(caseData) {
    var siteSelect = document.getElementById('nexrad-site-select');
    if (!siteSelect) return;

    var lat = caseData.latitude;
    var lon = caseData.longitude;
    if (!lat || !lon) return;

    siteSelect.innerHTML = '<option value="">Searching...</option>';

    fetch(API_BASE + '/nexrad/sites?lat=' + lat + '&lon=' + lon + '&max_range_km=460')
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            siteSelect.innerHTML = '';
            if (!json.sites || json.sites.length === 0) {
                siteSelect.innerHTML = '<option value="">No nearby 88D</option>';
                var btn = document.getElementById('nexrad-overlay-btn');
                if (btn) btn.disabled = true;
                return;
            }

            var btn = document.getElementById('nexrad-overlay-btn');
            if (btn) btn.disabled = false;

            for (var i = 0; i < json.sites.length; i++) {
                var s = json.sites[i];
                var opt = document.createElement('option');
                opt.value = s.site;
                opt.textContent = s.site + ' — ' + s.name + ' (' + s.distance_km + ' km)';
                siteSelect.appendChild(opt);
            }
        })
        .catch(function () {
            siteSelect.innerHTML = '<option value="">Error</option>';
        });
}

/**
 * Load available scans for the selected NEXRAD site.
 */
window.loadTdrNexradScans = function () {
    var siteSelect = document.getElementById('nexrad-site-select');
    var scanSelect = document.getElementById('nexrad-scan-select');
    var status = document.getElementById('nexrad-status');
    if (!siteSelect || !scanSelect || !siteSelect.value) return;

    var site = siteSelect.value;

    // Build reference time from the current case datetime
    var refTime = null;
    if (currentCaseData) {
        var cd = currentCaseData;
        var y = cd.year || 2020;
        var mo = String(cd.month || 1).padStart(2, '0');
        var d = String(cd.day || 1).padStart(2, '0');
        var h = String(cd.hour || 0).padStart(2, '0');
        var mi = String(cd.minute || 0).padStart(2, '0');
        refTime = y + '-' + mo + '-' + d + 'T' + h + ':' + mi + ':00';
    }
    if (!refTime) return;

    scanSelect.innerHTML = '<option value="">Loading...</option>';
    if (status) status.textContent = 'Searching...';

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

            // Pre-select closest scan
            var ci = json.closest_index || 0;
            if (ci < scanSelect.options.length) scanSelect.selectedIndex = ci;

            // Auto-load closest scan
            if (_nexradVisible) loadTdrNexradFrame();
        })
        .catch(function (e) {
            scanSelect.innerHTML = '<option value="">Error</option>';
            if (status) status.textContent = 'Error';
        });
};

/**
 * Load a NEXRAD frame as a geographic overlay on the Leaflet map.
 */
window.loadTdrNexradFrame = function () {
    var scanSelect = document.getElementById('nexrad-scan-select');
    var siteSelect = document.getElementById('nexrad-site-select');
    var prodSelect = document.getElementById('nexrad-product-select');
    var status = document.getElementById('nexrad-status');
    if (!scanSelect || !scanSelect.value || !siteSelect || !siteSelect.value) return;

    var s3Key = scanSelect.value;
    var site = siteSelect.value;
    var product = (prodSelect && prodSelect.value) || 'reflectivity';

    if (status) status.textContent = 'Loading...';

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

            if (_nexradMapOverlay) {
                map.removeLayer(_nexradMapOverlay);
            }
            _nexradMapOverlay = L.imageOverlay(json.image, bounds, {
                opacity: 0.75, interactive: false, zIndex: 250
            });
            if (_nexradVisible) _nexradMapOverlay.addTo(map);

            if (status) status.textContent = json.site + ' ' + json.scan_time + ' — ' + json.label;

            // Update colorbar
            _updateNexradColorbar(product);

            // Auto-load storm-relative version for plan view
            _loadNexradStormRelative(site, s3Key, product);
        })
        .catch(function (e) {
            if (status) status.textContent = 'Error: ' + e.message;
        });
};

/**
 * Load storm-relative NEXRAD data for the Plotly plan view underlay.
 */
function _loadNexradStormRelative(site, s3Key, product) {
    if (!currentCaseData) return;

    var cd = currentCaseData;
    var url = API_BASE + '/nexrad/storm_relative?site=' + encodeURIComponent(site) +
        '&s3_key=' + encodeURIComponent(s3Key) +
        '&center_lat=' + cd.latitude + '&center_lon=' + cd.longitude +
        '&product=' + product +
        '&grid_spacing_km=2&domain_km=200';

    fetch(url)
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            _nexradSrData = json;
            _applyNexradPlanView();
        })
        .catch(function () {
            _nexradSrData = null;
        });
}

/**
 * Apply storm-relative NEXRAD as a Plotly image underlay.
 */
function _applyNexradPlanView() {
    var plotDiv = document.getElementById('plotly-chart');
    if (!plotDiv || !plotDiv.data || !_nexradSrData || !_nexradPlanViewVisible) return;

    var sr = _nexradSrData;
    var existingImages = (plotDiv.layout.images || []).filter(function(img) {
        return !img._nexradUnderlay;
    });

    var img = {
        source: sr.image,
        xref: 'x', yref: 'y',
        x: sr.x_km[0],
        y: sr.y_km[sr.y_km.length - 1],
        sizex: sr.x_km[sr.x_km.length - 1] - sr.x_km[0],
        sizey: sr.y_km[sr.y_km.length - 1] - sr.y_km[0],
        xanchor: 'left', yanchor: 'top',
        layer: 'below',
        opacity: 0.5,
        _nexradUnderlay: true,
    };

    existingImages.push(img);
    Plotly.relayout('plotly-chart', { images: existingImages });

    // Also update fullscreen plot if open
    var fsdiv = document.getElementById('plotly-fullscreen');
    if (fsdiv && fsdiv.layout) {
        var fsImages = (fsdiv.layout.images || []).filter(function(i) {
            return !i._nexradUnderlay;
        });
        var fsImg = JSON.parse(JSON.stringify(img));
        fsImg._nexradUnderlay = true;
        fsImages.push(fsImg);
        Plotly.relayout('plotly-fullscreen', { images: fsImages });
    }
}

/**
 * Remove NEXRAD plan view underlay from Plotly plots.
 */
function _removeNexradPlanView() {
    var plotDiv = document.getElementById('plotly-chart');
    if (plotDiv && plotDiv.layout) {
        var clean = (plotDiv.layout.images || []).filter(function(img) {
            return !img._nexradUnderlay;
        });
        Plotly.relayout('plotly-chart', { images: clean });
    }
    var fsdiv = document.getElementById('plotly-fullscreen');
    if (fsdiv && fsdiv.layout) {
        var fsClean = (fsdiv.layout.images || []).filter(function(img) {
            return !img._nexradUnderlay;
        });
        Plotly.relayout('plotly-fullscreen', { images: fsClean });
    }
}

/**
 * Toggle NEXRAD overlay visibility (map + controls panel).
 */
window.toggleNexradOverlay = function () {
    _nexradVisible = !_nexradVisible;
    var btn = document.getElementById('nexrad-overlay-btn');
    var panel = document.getElementById('nexrad-panel');

    if (_nexradVisible) {
        if (btn) btn.classList.add('active');
        if (panel) panel.style.display = '';
        if (_nexradMapOverlay) _nexradMapOverlay.addTo(map);

        // Auto-enable plan view
        _nexradPlanViewVisible = true;
        var pvBtn = document.getElementById('nexrad-planview-btn');
        if (pvBtn) pvBtn.classList.add('active');

        // Auto-load scans if site is selected
        var siteSelect = document.getElementById('nexrad-site-select');
        if (siteSelect && siteSelect.value) {
            loadTdrNexradScans();
        }
    } else {
        if (btn) btn.classList.remove('active');
        if (panel) panel.style.display = 'none';
        if (_nexradMapOverlay) map.removeLayer(_nexradMapOverlay);
        if (_nexradPlanViewVisible) {
            _nexradPlanViewVisible = false;
            _removeNexradPlanView();
            var pvBtn = document.getElementById('nexrad-planview-btn');
            if (pvBtn) pvBtn.classList.remove('active');
        }
    }
};

/**
 * Toggle storm-relative plan view underlay.
 */
window.toggleNexradPlanView = function () {
    _nexradPlanViewVisible = !_nexradPlanViewVisible;
    var btn = document.getElementById('nexrad-planview-btn');

    if (_nexradPlanViewVisible) {
        if (btn) btn.classList.add('active');
        // Load storm-relative data if we have a scan selected
        var scanSelect = document.getElementById('nexrad-scan-select');
        var siteSelect = document.getElementById('nexrad-site-select');
        var prodSelect = document.getElementById('nexrad-product-select');
        if (scanSelect && scanSelect.value && siteSelect && siteSelect.value) {
            var product = (prodSelect && prodSelect.value) || 'reflectivity';
            _loadNexradStormRelative(siteSelect.value, scanSelect.value, product);
        }
    } else {
        if (btn) btn.classList.remove('active');
        _removeNexradPlanView();
    }
};

/**
 * Update the NEXRAD colorbar based on the current product.
 */
function _updateNexradColorbar(product) {
    var el = document.getElementById('nexrad-colorbar');
    if (!el) return;

    if (product === 'velocity') {
        el.innerHTML =
            '<div style="font-size:9px;font-weight:600;color:#86efac;margin-bottom:2px;">Radial Velocity (m/s)</div>' +
            '<div style="display:flex;height:10px;border-radius:3px;border:1px solid rgba(255,255,255,0.15);overflow:hidden;">' +
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
                '<span>-50</span><span>0</span><span>+50</span>' +
            '</div>';
    } else {
        el.innerHTML =
            '<div style="font-size:9px;font-weight:600;color:#86efac;margin-bottom:2px;">Reflectivity (dBZ)</div>' +
            '<div style="display:flex;height:10px;border-radius:3px;border:1px solid rgba(255,255,255,0.15);overflow:hidden;">' +
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
                '<span>5</span><span>20</span><span>35</span><span>50</span><span>65</span>' +
            '</div>';
    }
}

/**
 * Remove NEXRAD map overlay (called on case close / focus exit).
 */
function removeNexradMapOverlay() {
    if (_nexradMapOverlay) { map.removeLayer(_nexradMapOverlay); _nexradMapOverlay = null; }
}

/**
 * Full cleanup of NEXRAD state.
 */
function removeNexradOverlay() {
    removeNexradMapOverlay();
    _nexradVisible = false;
    _nexradPlanViewVisible = false;
    _nexradSrData = null;
    _removeNexradPlanView();
    var btn = document.getElementById('nexrad-overlay-btn');
    if (btn) { btn.classList.remove('active'); btn.disabled = false; }
    var panel = document.getElementById('nexrad-panel');
    if (panel) panel.style.display = 'none';
}
