/* ══════════════════════════════════════════════════════════════
   Global TC Archive — Frontend Logic
   TC-RADAR · Dr. Michael Fischer · University of Miami / NOAA HRD
   ══════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ── GA4 analytics helper ─────────────────────────────────────
function _ga(action, params) {
    if (typeof gtag === 'function') {
        try { gtag('event', action, params || {}); } catch (e) { /* silent */ }
    }
}

// ── Configuration ────────────────────────────────────────────
var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
var STORMS_JSON = 'ibtracs_storms.json';
var TRACKS_MANIFEST = 'ibtracs_tracks_manifest.json';
var TRACKS_JSON_FALLBACK = 'ibtracs_tracks.json';  // Fallback for single-file mode

// ── State ────────────────────────────────────────────────────
var allStorms = [];          // Full storm metadata array
var allTracks = {};          // SID → track points dict
var filteredStorms = [];     // Currently filtered subset
var selectedStorm = null;    // Currently selected storm object
var stormMap = null;         // Leaflet map (browser tab)
var detailMap = null;        // Leaflet map (detail tab)
var markerCluster = null;    // MarkerClusterGroup
var allMarkerMap = {};       // SID → L.marker (for lookup)
var trackLayer = null;       // L.layerGroup for browser track
var detailTrackLayer = null; // L.layerGroup for detail track
var activeBasins = ['ALL'];  // Active basin filter
var filterDebounce = null;   // Debounce timer
var mapViewMode = 'tracks'; // 'cluster' or 'tracks'
var trackViewLayer = null;   // L.layerGroup for track-view polylines
var trackCanvasRenderer = null; // L.canvas renderer (created after map init)

// Overwater 24-h intensity change episodes (loaded from intensity_changes.json)
var intensityChangeData = null;

// F-Deck state
var fdeckVisible = false;       // Whether f-deck traces are currently shown
var fdeckData = null;           // Cached parsed f-deck data for current storm
var fdeckLoaded = false;        // Whether f-deck data has been fetched for current storm
var fdeckTraceCount = 0;        // Number of f-deck traces currently on the chart

// IR animation state
var irPlaying = false;
var irFrameIdx = 0;
var irFrames = [];           // Cached frame data
var irMeta = null;           // HURSAT metadata
var irTimer = null;
var irSpeed = 750;           // ms per frame
var irOverlayLayer = null;   // L.imageOverlay on detail map
var irPositionMarker = null; // L.circleMarker showing current storm center
var trackAnnotationMarkers = []; // Genesis, LMI, dissipation markers (hidden during IR)
var irOverlayVisible = false;
var irOpacity = 0.8;
var irOpacityLevels = [0.8, 0.6, 0.4, 1.0];
var irOpacityIdx = 0;
var irFailedFrames = {};     // Track frames that permanently failed
var irMetaPrefetchCache = {};  // Pre-fetched IR metadata keyed by SID
var irFirstFrameCache = {};    // Pre-fetched first frame keyed by SID
var irFollowStorm = true;    // Lock map view to follow storm center
var irFollowZoomSet = false; // True after first fitBounds sets the zoom level
var irCurrentTbGrid = null;  // Downsampled Tb grid for current frame (for hover)
var irCurrentBounds = null;  // L.latLngBounds for current IR overlay
var irTbTooltip = null;      // L.popup for Tb hover display

// Climatology state
var climRendered = false;

// ── Basin metadata ───────────────────────────────────────────
var BASIN_NAMES = {
    NA: 'North Atlantic',
    EP: 'East Pacific',
    WP: 'West Pacific',
    NI: 'North Indian',
    SI: 'South Indian',
    SP: 'South Pacific',
    SA: 'South Atlantic'
};

var BASIN_COLORS = {
    NA: '#2e7dff',
    EP: '#00d4ff',
    WP: '#f87171',
    NI: '#fbbf24',
    SI: '#34d399',
    SP: '#a78bfa',
    SA: '#fb923c'
};

// ── Saffir-Simpson helpers ───────────────────────────────────
var SS_COLORS = {
    TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
    C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626',
    UN: '#6b7280'
};

function getIntensityColor(vmax) {
    if (!vmax) return '#6b7280';
    if (vmax < 34) return '#60a5fa';
    if (vmax < 64) return '#34d399';
    if (vmax < 83) return '#fbbf24';
    if (vmax < 96) return '#fb923c';
    if (vmax < 113) return '#f87171';
    if (vmax < 137) return '#ef4444';
    return '#dc2626';
}

function getIntensityCategory(vmax) {
    if (!vmax) return 'Unknown';
    if (vmax < 34) return 'TD';
    if (vmax < 64) return 'TS';
    if (vmax < 83) return 'Cat 1';
    if (vmax < 96) return 'Cat 2';
    if (vmax < 113) return 'Cat 3';
    if (vmax < 137) return 'Cat 4';
    return 'Cat 5';
}

function getCatKey(vmax) {
    if (!vmax) return 'UN';
    if (vmax < 34) return 'TD';
    if (vmax < 64) return 'TS';
    if (vmax < 83) return 'C1';
    if (vmax < 96) return 'C2';
    if (vmax < 113) return 'C3';
    if (vmax < 137) return 'C4';
    return 'C5';
}

// ── Plotly defaults ──────────────────────────────────────────
var PLOTLY_LAYOUT_BASE = {
    paper_bgcolor: '#0a1628',
    plot_bgcolor: '#0a1628',
    font: { family: 'DM Sans, sans-serif', color: '#e2e8f0' },
    margin: { l: 50, r: 20, t: 10, b: 40 },
    hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12, family: 'DM Sans' } }
};

var PLOTLY_CONFIG = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'],
    toImageButtonOptions: {
        format: 'png',
        filename: 'tc-radar-chart',
        height: 900,
        width: 1600,
        scale: 2
    }
};

// ══════════════════════════════════════════════════════════════
//  TAB SWITCHING
// ══════════════════════════════════════════════════════════════

window.switchTab = function (tabName) {
    _ga('ga_switch_tab', { tab_name: tabName });
    // If switching to detail without a selected storm, redirect through viewStormDetail
    if (tabName === 'detail' && !selectedStorm) {
        showToast('Select a storm first, then click "View Detail"');
        return;
    }

    // Update buttons
    document.querySelectorAll('.ga-tab').forEach(function (btn) {
        var isTarget = btn.getAttribute('data-tab') === tabName;
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });
    // Update panels
    document.querySelectorAll('.ga-tab-content').forEach(function (panel) {
        panel.classList.toggle('active', panel.id === 'tab-' + tabName);
    });
    // Lazy-init
    if (tabName === 'browser' && stormMap) {
        setTimeout(function () { stormMap.invalidateSize(); }, 100);
    }
    if (tabName === 'detail') {
        // If we already have a storm loaded but just switched tabs, re-render
        if (detailMap) {
            setTimeout(function () { detailMap.invalidateSize(); }, 100);
        } else if (selectedStorm) {
            renderStormDetail(selectedStorm);
        }
    }
    if (tabName === 'climatology' && !climRendered && allStorms.length > 0) {
        renderClimatology();
    }
    if (tabName === 'compare') {
        renderCompareView();
        if (compareMap) {
            setTimeout(function () { compareMap.invalidateSize(); }, 100);
        }
    }
};

// ══════════════════════════════════════════════════════════════
//  DATA LOADING
// ══════════════════════════════════════════════════════════════

function loadData() {
    var loadingEl = document.getElementById('map-loading');

    // Show loading indicator on map
    var mapEl = document.getElementById('browser-map');
    if (mapEl) {
        var loader = document.createElement('div');
        loader.id = 'ga-map-loader';
        loader.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1000;text-align:center;color:#8b9ec2;font-size:14px;font-family:DM Sans,sans-serif;';
        loader.innerHTML = '<div style="width:40px;height:40px;border:3px solid rgba(46,125,255,0.2);border-top-color:#2e7dff;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 12px;"></div>Loading storm database\u2026';
        mapEl.style.position = 'relative';
        mapEl.appendChild(loader);
    }

    // Load storms metadata
    fetch(STORMS_JSON)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            allStorms = data.storms || [];
            filteredStorms = allStorms.slice();

            // Update header stats
            var meta = data.metadata || {};
            document.getElementById('stat-storms').textContent = (meta.total_storms || allStorms.length).toLocaleString();
            document.getElementById('stat-years').textContent = meta.year_range ? meta.year_range[0] + '–' + meta.year_range[1] : '';
            document.getElementById('stat-basins').textContent = Object.keys(meta.basin_counts || BASIN_NAMES).length;
            document.getElementById('total-count').textContent = allStorms.length.toLocaleString();
            document.getElementById('filtered-count').textContent = allStorms.length.toLocaleString();

            initBrowserMap();
            if (mapViewMode === 'tracks') {
                renderTracks(filteredStorms);
            } else {
                renderMarkers(filteredStorms);
            }
            if (loadingEl) loadingEl.style.display = 'none';

            var _loader = document.getElementById('ga-map-loader');
            if (_loader) _loader.remove();

            showToast('Loaded ' + allStorms.length.toLocaleString() + ' storms');
        })
        .catch(function (err) {
            console.error('Failed to load storms:', err);
            if (loadingEl) loadingEl.innerHTML = '<span style="color:#f87171;">Failed to load storm data. Check console.</span>';
            var _loader = document.getElementById('ga-map-loader');
            if (_loader) _loader.innerHTML = '<div style="color:#ef4444;font-size:14px;">\u26A0 Could not load storm data. Try refreshing.</div>';
        });

    // Load track data — try chunked manifest first, fall back to single file
    showToast('Loading track data...');
    fetch(TRACKS_MANIFEST)
        .then(function (r) {
            if (!r.ok) throw new Error('No manifest');
            return r.json();
        })
        .then(function (manifest) {
            // Load chunks in parallel
            var chunks = manifest.chunks || [];
            console.log('Loading ' + chunks.length + ' track chunks...');
            return Promise.all(chunks.map(function (chunkFile) {
                return fetch(chunkFile).then(function (r) { return r.json(); });
            }));
        })
        .then(function (chunkDataArray) {
            // Merge all chunks into allTracks
            chunkDataArray.forEach(function (chunk) {
                Object.keys(chunk).forEach(function (sid) {
                    allTracks[sid] = chunk[sid];
                });
            });
            var n = Object.keys(allTracks).length;
            console.log('Loaded tracks for ' + n + ' storms from chunks');
            showToast('Track data ready — ' + n.toLocaleString() + ' storm tracks');
            // Re-render tracks now that data is available (initial render may
            // have fired before chunks finished loading)
            if (mapViewMode === 'tracks' && filteredStorms.length) {
                renderTracks(filteredStorms);
            }
        })
        .catch(function (manifestErr) {
            // Fallback: try loading single combined file
            console.log('Manifest not found, trying single file...');
            fetch(TRACKS_JSON_FALLBACK)
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    allTracks = data;
                    var n = Object.keys(data).length;
                    console.log('Loaded tracks for ' + n + ' storms (single file)');
                    showToast('Track data ready — ' + n.toLocaleString() + ' storm tracks');
                    if (mapViewMode === 'tracks' && filteredStorms.length) {
                        renderTracks(filteredStorms);
                    }
                })
                .catch(function (err) {
                    console.warn('Track data not loaded:', err);
                    showToast('Track data failed to load — storm details unavailable');
                });
        });

    // Load precomputed overwater 24-h intensity change episodes
    fetch('intensity_changes.json')
        .then(function (r) { if (!r.ok) throw new Error('Not found'); return r.json(); })
        .then(function (data) {
            intensityChangeData = data;
            console.log('Loaded intensity change data: ' + (data.total_episodes || 0) + ' episodes');
        })
        .catch(function (err) {
            console.warn('Intensity change data not loaded:', err);
        });
}

// ══════════════════════════════════════════════════════════════
//  STORM BROWSER TAB
// ══════════════════════════════════════════════════════════════

function initBrowserMap() {
    if (stormMap) return;

    stormMap = L.map('storm-map', {
        center: [20, -20],
        zoom: 2,
        zoomControl: true,
        worldCopyJump: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 12
    }).addTo(stormMap);

    markerCluster = L.markerClusterGroup({
        maxClusterRadius: 40,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        disableClusteringAtZoom: 8
    });
    trackLayer = L.layerGroup().addTo(stormMap);

    // Canvas renderer + layer for track view
    trackCanvasRenderer = L.canvas({ padding: 0.5 });
    trackViewLayer = L.layerGroup();

    // Default view: tracks (clusters ready but not added to map)
    if (mapViewMode === 'tracks') {
        stormMap.addLayer(trackViewLayer);
    } else {
        stormMap.addLayer(markerCluster);
    }

    // Add legend
    var legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
        var div = L.DomUtil.create('div', 'ga-legend');
        div.innerHTML = '<h4>Intensity (Saffir-Simpson)</h4>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#60a5fa;"></span> TD (&lt;34 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#34d399;"></span> TS (34–63 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#fbbf24;"></span> Cat 1 (64–82 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#fb923c;"></span> Cat 2 (83–95 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#f87171;"></span> Cat 3 (96–112 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#ef4444;"></span> Cat 4 (113–136 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#dc2626;"></span> Cat 5 (137+ kt)</div>';
        return div;
    };
    legend.addTo(stormMap);
}

function renderMarkers(storms) {
    if (!markerCluster) return;
    markerCluster.clearLayers();
    allMarkerMap = {};
    trackLayer.clearLayers();

    storms.forEach(function (s) {
        if (!s.genesis_lat || !s.genesis_lon) return;

        var color = getIntensityColor(s.peak_wind_kt);
        var icon = L.divIcon({
            className: 'custom-div-icon',
            html: '<div class="custom-marker" style="background-color:' + color + ';width:14px;height:14px;box-shadow:0 0 6px ' + color + '40;"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        });

        var marker = L.marker([s.genesis_lat, s.genesis_lon], { icon: icon });
        marker.stormData = s;

        var cat = getIntensityCategory(s.peak_wind_kt);
        var popupHtml =
            '<div style="min-width:180px;">' +
            '<div style="font-weight:700;font-size:14px;margin-bottom:4px;">' + (s.name || 'UNNAMED') +
            ' <span class="intensity-badge" style="background:' + color + ';font-size:10px;padding:1px 6px;">' + cat + '</span></div>' +
            '<div style="font-size:12px;color:#94a3b8;margin-bottom:6px;">' + s.year + ' &middot; ' + (BASIN_NAMES[s.basin] || s.basin) + '</div>' +
            '<div style="font-size:12px;"><b>Peak:</b> ' + (s.peak_wind_kt || '?') + ' kt &middot; ' + (s.min_pres_hpa || '?') + ' hPa</div>' +
            '<div style="font-size:12px;"><b>ACE:</b> ' + (s.ace || 0).toFixed(1) + '</div>' +
            '<div style="margin-top:8px;text-align:center;">' +
            '<button onclick="selectStormFromPopup(\'' + s.sid + '\')" style="background:linear-gradient(135deg,#2e7dff,#00d4ff);color:#fff;border:none;border-radius:4px;padding:4px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:DM Sans,sans-serif;">View Detail</button>' +
            '</div></div>';

        marker.bindPopup(popupHtml, {
            maxWidth: 280,
            minWidth: 200,
            autoPan: true,
            closeButton: true
        });

        marker.on('click', function () {
            selectStorm(s);
        });

        allMarkerMap[s.sid] = marker;
        markerCluster.addLayer(marker);
    });

    document.getElementById('filtered-count').textContent = storms.length.toLocaleString();
}

// ── Track view rendering ─────────────────────────────────────

function renderTracks(storms) {
    if (!trackViewLayer) return;
    trackViewLayer.clearLayers();

    var showMarkers = storms.length <= 3000;

    storms.forEach(function (s) {
        var track = allTracks[s.sid];
        if (!track || track.length < 2) return;

        // Collect valid points
        var pts = [];
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null) pts.push(p);
        }
        if (pts.length < 2) return;

        // Walk points and batch consecutive same-color segments into polylines
        // Each segment is colored by the LOCAL intensity at that point
        var segColor = _isTCNature(pts[0].n) ? getIntensityColor(pts[0].w) : '#6b7280';
        var segIsTC = _isTCNature(pts[0].n);
        var runCoords = [[pts[0].la, pts[0].lo]];

        for (var j = 1; j < pts.length; j++) {
            var p = pts[j];
            var isTC = _isTCNature(p.n);
            var ptColor = isTC ? getIntensityColor(p.w) : '#6b7280';

            if (ptColor !== segColor || isTC !== segIsTC) {
                // Color or phase changed — flush current run
                if (runCoords.length >= 2) {
                    _addTrackPolyline(runCoords, segIsTC, segColor, s);
                }
                // Start new run (include overlap point for continuity)
                runCoords = [[pts[j - 1].la, pts[j - 1].lo]];
                segColor = ptColor;
                segIsTC = isTC;
            }
            runCoords.push([p.la, p.lo]);
        }
        // Flush final run
        if (runCoords.length >= 2) {
            _addTrackPolyline(runCoords, segIsTC, segColor, s);
        }

        // Genesis marker
        if (showMarkers) {
            var gen = _trackGenesisPoint(track);
            if (gen) {
                L.circleMarker([gen.la, gen.lo], {
                    renderer: trackCanvasRenderer,
                    radius: 3, color: '#fff', weight: 1,
                    fillColor: '#60a5fa', fillOpacity: 0.9, opacity: 0.8
                }).bindTooltip((s.name || 'UNNAMED') + ' ' + s.year + ' genesis', { className: 'ga-tooltip' })
                 .on('click', function () { selectStorm(s); })
                 .addTo(trackViewLayer);
            }

            // LMI marker
            var lmiPt = null, lmiW = -1;
            for (var k = 0; k < pts.length; k++) {
                if (pts[k].w != null && pts[k].w > lmiW) { lmiW = pts[k].w; lmiPt = pts[k]; }
            }
            if (lmiPt && lmiW > 0) {
                L.circleMarker([lmiPt.la, lmiPt.lo], {
                    renderer: trackCanvasRenderer,
                    radius: 4, color: '#fff', weight: 1.5,
                    fillColor: getIntensityColor(lmiW), fillOpacity: 0.9, opacity: 0.9
                }).bindTooltip((s.name || 'UNNAMED') + ' ' + s.year + ' LMI: ' + lmiW + ' kt', { className: 'ga-tooltip' })
                 .on('click', function () { selectStorm(s); })
                 .addTo(trackViewLayer);
            }
        }
    });

    document.getElementById('filtered-count').textContent = storms.length.toLocaleString();
}

function _addTrackPolyline(coords, isTC, segColor, storm) {
    var opts = {
        renderer: trackCanvasRenderer,
        interactive: true
    };
    if (isTC) {
        opts.color = segColor;
        opts.weight = 1.8;
        opts.opacity = 0.6;
    } else {
        opts.color = '#6b7280';
        opts.weight = 0.8;
        opts.opacity = 0.25;
        opts.dashArray = '4,3';
    }
    var line = L.polyline(coords, opts);
    var cat = getIntensityCategory(storm.peak_wind_kt);
    line.bindTooltip(
        (storm.name || 'UNNAMED') + ' (' + storm.year + ') ' + cat + ' · ' +
        (storm.peak_wind_kt || '?') + ' kt · ACE ' + (storm.ace || 0).toFixed(1),
        { sticky: true, className: 'ga-tooltip' }
    );
    line.on('click', function () { selectStorm(storm); });
    line.on('mouseover', function () {
        if (isTC) this.setStyle({ weight: 3.5, opacity: 1 });
    });
    line.on('mouseout', function () {
        if (isTC) this.setStyle({ weight: 1.8, opacity: 0.6 });
    });
    line.addTo(trackViewLayer);
}

window.setMapView = function (mode) {
    mapViewMode = mode;
    // Update toggle buttons
    document.querySelectorAll('.view-toggle-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-view') === mode);
    });
    if (mode === 'cluster') {
        if (trackViewLayer) stormMap.removeLayer(trackViewLayer);
        stormMap.addLayer(markerCluster);
        renderMarkers(filteredStorms);
    } else {
        stormMap.removeLayer(markerCluster);
        stormMap.addLayer(trackViewLayer);
        renderTracks(filteredStorms);
    }
};

// ── Storm selection ──────────────────────────────────────────

function selectStorm(storm) {
    _ga('ga_select_storm', { sid: storm.sid, storm_name: storm.name, year: storm.year, basin: storm.basin, peak_wind_kt: storm.peak_wind_kt });
    selectedStorm = storm;
    var card = document.getElementById('storm-card');
    card.style.display = '';

    var color = getIntensityColor(storm.peak_wind_kt);
    var cat = getIntensityCategory(storm.peak_wind_kt);

    document.getElementById('card-name').textContent = storm.name || 'UNNAMED';
    document.getElementById('card-cat-badge').textContent = cat;
    document.getElementById('card-cat-badge').style.background = color;
    document.getElementById('card-year').textContent = storm.year;
    document.getElementById('card-basin').textContent = BASIN_NAMES[storm.basin] || storm.basin;
    document.getElementById('card-wind').textContent = storm.peak_wind_kt ? storm.peak_wind_kt + ' kt' : 'N/A';
    document.getElementById('card-pres').textContent = storm.min_pres_hpa ? storm.min_pres_hpa + ' hPa' : 'N/A';
    var dateStr = (storm.start_date || '?') + ' → ' + (storm.end_date || '?');
    var tcDur = _tcDuration(allTracks[storm.sid] || []);
    if (tcDur) dateStr += ' (' + tcDur + ' as TC)';
    document.getElementById('card-dates').textContent = dateStr;
    document.getElementById('card-ace').textContent = (storm.ace || 0).toFixed(1);

    var hursatEl = document.getElementById('card-hursat');
    if (storm.hursat) {
        hursatEl.innerHTML = '<span style="color:#34d399;">Available (1978–2015)</span>';
    } else {
        hursatEl.innerHTML = '<span style="color:#6b7280;">Not available</span>';
    }

    // Update the floating map card
    _showMapStormCard(storm, color, cat);

    // Scroll sidebar to show the storm card
    setTimeout(function () {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);

    // Show track on map if available
    showTrackOnBrowserMap(storm.sid);

    // Early IR metadata prefetch — kick off the metadata request now
    // so it's already cached when the user opens the detail panel.
    var hasIR = storm.hursat || storm.year >= 1998;
    if (hasIR && !irMetaPrefetchCache[storm.sid]) {
        var track = allTracks[storm.sid] || [];
        var trackP = track.length > 0 ? '&track=' + encodeURIComponent(JSON.stringify(track)) : '';
        var lonP = storm.lmi_lon != null ? '&storm_lon=' + storm.lmi_lon : '';
        var prefetchUrl = API_BASE + '/global/ir/meta?sid=' + encodeURIComponent(storm.sid) + trackP + lonP;
        fetch(prefetchUrl)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (meta) {
                if (meta && meta.available && meta.n_frames > 0) {
                    irMetaPrefetchCache[storm.sid] = meta;
                    // Also prefetch the first frame so display is near-instant
                    var source = meta.source || 'hursat';
                    var frameUrl;
                    var irCacheVer = 'v3';
                    if ((source === 'mergir' || source === 'gridsat') && meta.frames && meta.frames[0]) {
                        var fi = meta.frames[0];
                        frameUrl = API_BASE + '/global/ir/frame?sid=' + encodeURIComponent(storm.sid) +
                            '&frame_idx=0&lat=' + fi.lat + '&lon=' + fi.lon + '&_v=' + irCacheVer;
                    } else {
                        frameUrl = API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(storm.sid) + '&frame_idx=0&_v=' + irCacheVer;
                    }
                    fetch(frameUrl)
                        .then(function (r) { return r.ok ? r.json() : null; })
                        .then(function (data) {
                            if (data) irFirstFrameCache[storm.sid] = data;
                        })
                        .catch(function () {});
                }
            })
            .catch(function () {});
    }
}

function _showMapStormCard(storm, color, cat) {
    var mc = document.getElementById('map-storm-card');
    if (!mc) return;
    document.getElementById('map-card-name').textContent = storm.name || 'UNNAMED';
    var badge = document.getElementById('map-card-badge');
    badge.textContent = cat;
    badge.style.background = color;
    document.getElementById('map-card-wind').textContent = storm.peak_wind_kt ? storm.peak_wind_kt + ' kt' : 'N/A';
    document.getElementById('map-card-pres').textContent = storm.min_pres_hpa ? storm.min_pres_hpa + ' hPa' : 'N/A';
    document.getElementById('map-card-year').textContent = storm.year;
    document.getElementById('map-card-basin').textContent = BASIN_NAMES[storm.basin] || storm.basin;
    mc.style.display = '';
}

window.dismissMapStormCard = function () {
    var mc = document.getElementById('map-storm-card');
    if (mc) mc.style.display = 'none';
};

window.selectStormFromPopup = function (sid) {
    var storm = allStorms.find(function (s) { return s.sid === sid; });
    if (storm) {
        selectStorm(storm);
        viewStormDetail();
    }
};

function showTrackOnBrowserMap(sid) {
    if (!trackLayer) return;
    trackLayer.clearLayers();

    var track = allTracks[sid];
    if (!track || track.length < 2) return;

    // Draw track as colored segments
    for (var i = 1; i < track.length; i++) {
        var p0 = track[i - 1];
        var p1 = track[i];
        if (!p0.la || !p0.lo || !p1.la || !p1.lo) continue;

        var color = getIntensityColor(p1.w);
        var line = L.polyline(
            [[p0.la, p0.lo], [p1.la, p1.lo]],
            { color: color, weight: 2.5, opacity: 0.85 }
        );
        trackLayer.addLayer(line);
    }

    // Fit bounds
    var lats = track.filter(function (p) { return p.la; }).map(function (p) { return p.la; });
    var lons = track.filter(function (p) { return p.lo; }).map(function (p) { return p.lo; });
    if (lats.length > 0) {
        stormMap.fitBounds([
            [Math.min.apply(null, lats) - 2, Math.min.apply(null, lons) - 2],
            [Math.max.apply(null, lats) + 2, Math.max.apply(null, lons) + 2]
        ]);
    }
}

// ── Filtering ────────────────────────────────────────────────

window.toggleBasin = function (btn) {
    var basin = btn.getAttribute('data-basin');

    if (basin === 'ALL') {
        // Reset all to inactive, set ALL to active
        document.querySelectorAll('.basin-chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        activeBasins = ['ALL'];
    } else {
        // Deactivate ALL, toggle this basin
        document.querySelector('.basin-chip[data-basin="ALL"]').classList.remove('active');
        btn.classList.toggle('active');

        activeBasins = [];
        document.querySelectorAll('.basin-chip.active').forEach(function (c) {
            var b = c.getAttribute('data-basin');
            if (b !== 'ALL') activeBasins.push(b);
        });

        // If none selected, revert to ALL
        if (activeBasins.length === 0) {
            document.querySelector('.basin-chip[data-basin="ALL"]').classList.add('active');
            activeBasins = ['ALL'];
        }
    }
    onFilterChange();
};

window.onFilterChange = function () {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(applyFilters, 150);
};

window.onWindFilterChange = function () {
    var val = parseInt(document.getElementById('filter-wind-min').value) || 0;
    var label = document.getElementById('wind-min-label');
    if (val === 0) {
        label.textContent = '0 kt (All)';
    } else {
        label.textContent = val + ' kt (' + getIntensityCategory(val) + '+)';
    }
    onFilterChange();
};

window.onAceFilterChange = function () {
    var val = parseFloat(document.getElementById('filter-ace-min').value) || 0;
    document.getElementById('ace-min-label').textContent = val === 0 ? '0 (All)' : '\u2265 ' + val.toFixed(0);
    onFilterChange();
};

window.onRIFilterChange = function () {
    var val = parseInt(document.getElementById('filter-ri-min').value) || 0;
    document.getElementById('ri-min-label').textContent = val === 0 ? '0 kt (All)' : '\u2265 ' + val + ' kt/24h';
    onFilterChange();
};

window.onRWFilterChange = function () {
    var val = parseInt(document.getElementById('filter-rw-max').value) || 0;
    document.getElementById('rw-max-label').textContent = val === 0 ? '0 kt (All)' : '\u2264 ' + val + ' kt/24h';
    onFilterChange();
};

function applyFilters() {
    _ga('ga_apply_filters', {});
    var nameQuery = (document.getElementById('filter-name').value || '').trim().toUpperCase();
    var yearMin = parseInt(document.getElementById('filter-year-min').value) || 0;
    var yearMax = parseInt(document.getElementById('filter-year-max').value) || 9999;
    var windMin = parseInt(document.getElementById('filter-wind-min').value) || 0;
    var aceMin = parseFloat(document.getElementById('filter-ace-min').value) || 0;
    var riMin = parseInt(document.getElementById('filter-ri-min').value) || 0;
    var rwMax = parseInt(document.getElementById('filter-rw-max').value) || 0;

    filteredStorms = allStorms.filter(function (s) {
        // Name filter
        if (nameQuery && (!s.name || s.name.toUpperCase().indexOf(nameQuery) === -1)) return false;
        // Basin filter
        if (activeBasins[0] !== 'ALL' && activeBasins.indexOf(s.basin) === -1) return false;
        // Year filter
        if (s.year < yearMin || s.year > yearMax) return false;
        // Intensity filter
        if ((s.peak_wind_kt || 0) < windMin) return false;
        // ACE filter
        if (aceMin > 0 && (s.ace || 0) < aceMin) return false;
        // RI filter (only when threshold > 0)
        if (riMin > 0 && (s.ri_24h == null || s.ri_24h < riMin)) return false;
        // RW filter (only when threshold < 0)
        if (rwMax < 0 && (s.rw_24h == null || s.rw_24h > rwMax)) return false;
        return true;
    });

    // Sort
    var sortBy = document.getElementById('sort-by').value;
    var comparators = {
        'year-desc': function (a, b) { return (b.year || 0) - (a.year || 0); },
        'year-asc':  function (a, b) { return (a.year || 0) - (b.year || 0); },
        'wind-desc': function (a, b) { return (b.peak_wind_kt || 0) - (a.peak_wind_kt || 0); },
        'ri-desc':   function (a, b) { return (b.ri_24h || 0) - (a.ri_24h || 0); },
        'rw-desc':   function (a, b) { return (a.rw_24h || 0) - (b.rw_24h || 0); },
        'ace-desc':  function (a, b) { return (b.ace || 0) - (a.ace || 0); }
    };
    if (comparators[sortBy]) filteredStorms.sort(comparators[sortBy]);

    // Clear the previously selected individual storm track and card
    if (trackLayer) trackLayer.clearLayers();
    if (selectedStorm) {
        selectedStorm = null;
        var card = document.getElementById('storm-card');
        if (card) card.style.display = 'none';
        var mc = document.getElementById('map-storm-card');
        if (mc) mc.style.display = 'none';
    }

    if (mapViewMode === 'tracks') {
        renderTracks(filteredStorms);
    } else {
        renderMarkers(filteredStorms);
    }
}

window.resetFilters = function () {
    document.getElementById('filter-name').value = '';
    document.getElementById('filter-year-min').value = '';
    document.getElementById('filter-year-max').value = '';
    document.getElementById('filter-wind-min').value = 0;
    document.getElementById('wind-min-label').textContent = '0 kt (All)';
    document.getElementById('filter-ace-min').value = 0;
    document.getElementById('ace-min-label').textContent = '0 (All)';
    document.getElementById('filter-ri-min').value = 0;
    document.getElementById('ri-min-label').textContent = '0 kt (All)';
    document.getElementById('filter-rw-max').value = 0;
    document.getElementById('rw-max-label').textContent = '0 kt (All)';
    document.getElementById('sort-by').value = 'year-desc';

    document.querySelectorAll('.basin-chip').forEach(function (c) { c.classList.remove('active'); });
    document.querySelector('.basin-chip[data-basin="ALL"]').classList.add('active');
    activeBasins = ['ALL'];

    filteredStorms = allStorms.slice();
    if (mapViewMode === 'tracks') {
        renderTracks(filteredStorms);
    } else {
        renderMarkers(filteredStorms);
    }

    // Hide storm card
    document.getElementById('storm-card').style.display = 'none';
    selectedStorm = null;
    if (trackLayer) trackLayer.clearLayers();
};

// ══════════════════════════════════════════════════════════════
//  STORM DETAIL TAB
// ══════════════════════════════════════════════════════════════

window.viewStormDetail = function () {
    if (!selectedStorm) {
        showToast('Select a storm first');
        return;
    }

    // Check if tracks are loaded
    if (!allTracks || Object.keys(allTracks).length === 0) {
        showToast('Track data still loading, please wait...');
        // Retry after a short delay
        setTimeout(function () {
            if (selectedStorm) viewStormDetail();
        }, 1500);
        return;
    }

    // Force the tab switch (bypass the guard since we have a storm)
    document.querySelectorAll('.ga-tab').forEach(function (btn) {
        var isTarget = btn.getAttribute('data-tab') === 'detail';
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });
    document.querySelectorAll('.ga-tab-content').forEach(function (panel) {
        panel.classList.toggle('active', panel.id === 'tab-detail');
    });

    // Small delay to let the DOM settle before rendering charts/maps
    setTimeout(function () {
        renderStormDetail(selectedStorm);
    }, 50);
};

function renderStormDetail(storm) {
    _ga('ga_view_storm_detail', { sid: storm.sid, storm_name: storm.name, year: storm.year, basin: storm.basin });
    // Header
    var color = getIntensityColor(storm.peak_wind_kt);
    var cat = getIntensityCategory(storm.peak_wind_kt);
    document.getElementById('detail-title').innerHTML =
        (storm.name || 'UNNAMED') +
        ' <span class="intensity-badge" style="background:' + color + '">' + cat + '</span>';
    document.getElementById('detail-subtitle').textContent =
        storm.year + ' · ' + (BASIN_NAMES[storm.basin] || storm.basin) +
        ' · Peak: ' + (storm.peak_wind_kt || '?') + ' kt / ' + (storm.min_pres_hpa || '?') + ' hPa' +
        ' · ACE: ' + (storm.ace || 0).toFixed(1);

    // Get track data
    var track = allTracks[storm.sid];
    if (!track || track.length === 0) {
        document.getElementById('timeline-chart').innerHTML = '<div style="padding:40px;text-align:center;color:#8b9ec2;">Track data not available for this storm.</div>';
        return;
    }

    renderIntensityTimeline(track, storm);
    renderDetailMap(track, storm);

    // F-Deck toggle — show for storms with an ATCF ID (NHC-monitored)
    var fdeckToggleWrap = document.getElementById('fdeck-toggle-wrap');
    fdeckVisible = false;
    fdeckData = null;
    fdeckLoaded = false;
    fdeckTraceCount = 0;
    var hasNHCFDeck = storm.atcf_id && (storm.basin === 'NA' || storm.basin === 'EP');
    if (hasNHCFDeck) {
        fdeckToggleWrap.style.display = '';
        document.getElementById('fdeck-toggle-btn').textContent = 'Show F-Deck';
        document.getElementById('fdeck-toggle-btn').classList.remove('active');
        document.getElementById('fdeck-status').textContent = '';
    } else {
        fdeckToggleWrap.style.display = 'none';
    }

    // IR overlay — show toggle for storms with IR data (HURSAT 1978-2015, MergIR 1998+)
    var irToggleWrap = document.getElementById('ir-toggle-wrap');
    var hasIR = storm.hursat || storm.year >= 1998;
    if (hasIR) {
        irToggleWrap.style.display = '';
        document.getElementById('ir-status').textContent = 'Loading...';
        loadHURSAT(storm);
    } else {
        irToggleWrap.style.display = 'none';
        document.getElementById('ir-map-controls').style.display = 'none';
        stopIRPlayback();
        removeIROverlay();
    }

    // MW satellite overlay — show toggle if storm has an ATCF ID (TC-PRIMED coverage)
    var mwToggleWrap = document.getElementById('ga-mw-toggle-wrap');
    if (mwToggleWrap) {
        if (storm.atcf_id && storm.year >= 1987) {
            mwToggleWrap.style.display = '';
            document.getElementById('ga-mw-status').textContent = '';
            loadGlobalMWOverpasses(storm);
        } else {
            mwToggleWrap.style.display = 'none';
            removeGlobalMWOverlay();
        }
    }
}

function renderIntensityTimeline(track, storm) {
    var times = [];
    var winds = [];
    var pres = [];
    var colors = [];

    track.forEach(function (pt) {
        if (!pt.t) return;
        times.push(pt.t);
        winds.push(pt.w);
        pres.push(pt.p);
        colors.push(getIntensityColor(pt.w));
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

    var windTrace = {
        x: times,
        y: winds,
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Wind (kt)',
        line: { color: '#00d4ff', width: 2.5 },
        marker: { color: colors, size: 6, line: { color: 'rgba(255,255,255,0.3)', width: 1 } },
        hovertemplate: '<b>%{x}</b><br>Wind: %{y} kt<extra></extra>',
        yaxis: 'y'
    };

    var presTrace = {
        x: times,
        y: pres,
        type: 'scatter',
        mode: 'lines',
        name: 'Pressure (hPa)',
        line: { color: '#a78bfa', width: 1.5, dash: 'dot' },
        hovertemplate: '<b>%{x}</b><br>Pressure: %{y} hPa<extra></extra>',
        yaxis: 'y2'
    };

    var maxWind = Math.max.apply(null, winds.filter(function (w) { return w != null; })) || 100;

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'Date/Time', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            linecolor: 'rgba(255,255,255,0.08)'
        },
        yaxis: {
            title: { text: 'Max Wind (kt)', font: { size: 11, color: '#00d4ff' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)',
            range: [0, Math.min(maxWind + 20, 200)],
            side: 'left'
        },
        yaxis2: {
            title: { text: 'Pressure (hPa)', font: { size: 11, color: '#a78bfa' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            overlaying: 'y',
            side: 'right',
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
            font: { size: 11, color: '#e2e8f0' }
        },
        margin: { l: 55, r: 55, t: 10, b: 45 }
    });

    // Store base shapes for later (IR time marker is appended dynamically)
    window._timelineBaseShapes = shapes.slice();

    Plotly.newPlot('timeline-chart', [windTrace, presTrace], layout, PLOTLY_CONFIG);

    // Click handler to sync IR
    document.getElementById('timeline-chart').on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var clickedTime = data.points[0].x;
            syncIRToTime(clickedTime);
        }
    });
}

/**
 * Update the vertical time marker on the intensity chart to match the
 * current IR frame time. Only visible when IR overlay is active.
 * Throttled to avoid expensive Plotly.relayout calls during fast animation.
 */
var _intensityMarkerTimer = null;
var _lastMarkerDt = null;

function updateIntensityMarker(dtStr) {
    // Skip if nothing changed
    if (dtStr === _lastMarkerDt) return;
    _lastMarkerDt = dtStr;

    // Throttle: during animation, delay updates slightly so we don't call
    // Plotly.relayout on every single frame tick (expensive)
    if (_intensityMarkerTimer) clearTimeout(_intensityMarkerTimer);
    _intensityMarkerTimer = setTimeout(function () {
        _applyIntensityMarker(dtStr);
    }, irPlaying ? 200 : 0);  // immediate when paused, 200ms throttle when playing
}

function _applyIntensityMarker(dtStr) {
    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || !chartEl.layout) return;

    var baseShapes = window._timelineBaseShapes || [];
    var extraShapes = [];

    // IR vertical line (yellow/gold)
    if (dtStr && irOverlayVisible) {
        extraShapes.push({
            type: 'line',
            xref: 'x',
            yref: 'paper',
            x0: dtStr,
            x1: dtStr,
            y0: 0,
            y1: 1,
            line: { color: 'rgba(255,200,50,0.7)', width: 2, dash: 'solid' }
        });
    }

    // MW vertical line (cyan)
    if (_gaMwMarkerDt && _gaMwVisible) {
        extraShapes.push({
            type: 'line',
            xref: 'x',
            yref: 'paper',
            x0: _gaMwMarkerDt,
            x1: _gaMwMarkerDt,
            y0: 0,
            y1: 1,
            line: { color: 'rgba(0,220,255,0.7)', width: 2, dash: 'dot' }
        });
    }

    Plotly.relayout(chartEl, { shapes: baseShapes.concat(extraShapes) });
}


// ── NHC F-Deck Intensity Fixes ──────────────────────────────

// F-Deck fix type visual config — each category gets a distinct marker
var FDECK_STYLES = {
    DVTS:       { name: 'Subjective Dvorak', color: '#ff9f43', symbol: 'diamond',      size: 8 },
    DVTO:       { name: 'Objective Dvorak',  color: '#feca57', symbol: 'circle',        size: 7 },
    SFMR:       { name: 'SFMR',             color: '#ff6b6b', symbol: 'triangle-up',   size: 8 },
    FL_WIND:    { name: 'Flight-Level',      color: '#ee5a24', symbol: 'triangle-down', size: 8 },
    DROPSONDE:  { name: 'Dropsonde',         color: '#f8b739', symbol: 'square',        size: 7 },
    AIRC_OTHER: { name: 'Aircraft (Other)',  color: '#e17055', symbol: 'cross',         size: 7 }
};

window.toggleFDeck = function () {
    if (!selectedStorm || !selectedStorm.atcf_id) return;

    if (!fdeckLoaded) {
        // First time — fetch data
        var btn = document.getElementById('fdeck-toggle-btn');
        var status = document.getElementById('fdeck-status');
        btn.textContent = 'Loading...';
        btn.disabled = true;
        status.textContent = '';

        var url = API_BASE + '/global/fdeck?atcf_id=' + encodeURIComponent(selectedStorm.atcf_id);
        fetch(url)
            .then(function (resp) {
                if (!resp.ok) throw new Error('F-deck not available (' + resp.status + ')');
                return resp.json();
            })
            .then(function (data) {
                fdeckData = data.fixes;
                fdeckLoaded = true;
                fdeckVisible = true;
                btn.textContent = 'Hide F-Deck';
                btn.classList.add('active');
                btn.disabled = false;

                // Show counts
                var total = 0;
                Object.keys(data.counts).forEach(function (k) { total += data.counts[k] || 0; });
                status.textContent = total + ' fixes';

                addFDeckTraces();
            })
            .catch(function (err) {
                btn.textContent = 'Show F-Deck';
                btn.disabled = false;
                status.textContent = 'Not available';
                status.style.color = '#f87171';
                console.warn('F-deck fetch failed:', err);
            });
        return;
    }

    // Toggle visibility of existing traces
    fdeckVisible = !fdeckVisible;
    var btn = document.getElementById('fdeck-toggle-btn');

    if (fdeckVisible) {
        btn.textContent = 'Hide F-Deck';
        btn.classList.add('active');
        addFDeckTraces();
    } else {
        btn.textContent = 'Show F-Deck';
        btn.classList.remove('active');
        removeFDeckTraces();
    }
};

function addFDeckTraces() {
    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || !chartEl.data || !fdeckData) return;

    // Remove any existing f-deck traces first
    removeFDeckTraces();

    var newTraces = [];
    var fixTypes = ['DVTS', 'DVTO', 'SFMR', 'FL_WIND', 'DROPSONDE', 'AIRC_OTHER'];

    fixTypes.forEach(function (ft) {
        var fixes = fdeckData[ft];
        if (!fixes || fixes.length === 0) return;

        var style = FDECK_STYLES[ft];
        var times = [];
        var winds = [];
        var hovers = [];

        fixes.forEach(function (f) {
            times.push(f.time);
            winds.push(f.wind_kt);
            var hoverText = '<b>' + style.name + '</b><br>' +
                f.time + '<br>' +
                'Wind: ' + f.wind_kt + ' kt';
            if (f.ci !== undefined) {
                hoverText += '<br>CI#: ' + f.ci.toFixed(1);
            }
            if (f.agency) {
                hoverText += '<br>Agency: ' + f.agency;
            }
            if (f.level) {
                hoverText += '<br>Level: ' + f.level;
            }
            hoverText += '<br>(' + f.lat.toFixed(1) + '°, ' + f.lon.toFixed(1) + '°)';
            hovers.push(hoverText);
        });

        newTraces.push({
            x: times,
            y: winds,
            type: 'scatter',
            mode: 'markers',
            name: style.name,
            marker: {
                color: style.color,
                symbol: style.symbol,
                size: style.size,
                line: { color: 'rgba(255,255,255,0.5)', width: 1 }
            },
            hovertemplate: '%{text}<extra></extra>',
            text: hovers,
            yaxis: 'y'
        });
    });

    if (newTraces.length > 0) {
        Plotly.addTraces(chartEl, newTraces);
        fdeckTraceCount = newTraces.length;
    }
}

function removeFDeckTraces() {
    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || !chartEl.data || fdeckTraceCount === 0) return;

    // F-deck traces are always the last N traces added
    var totalTraces = chartEl.data.length;
    var indices = [];
    for (var i = totalTraces - fdeckTraceCount; i < totalTraces; i++) {
        indices.push(i);
    }
    Plotly.deleteTraces(chartEl, indices);
    fdeckTraceCount = 0;
}


// ── Storm Comparison Mode ───────────────────────────────────

var compareStorms = [];
var compareMap = null;
var compareAlign = 'genesis';
var COMPARE_COLORS = [
    '#00d4ff', '#ff6b6b', '#34d399', '#fbbf24',
    '#a78bfa', '#fb923c', '#f472b6', '#38bdf8'
];
var COMPARE_MAX = 8;
var compareSearchBasins = ['ALL'];
var compareSearchVisible = false;
var _compareSearchTimer = null;

// ── Compare Search / Filter ────────────────────────────────

window.toggleCompareBasin = function (btn) {
    var basin = btn.getAttribute('data-basin');
    var parent = btn.parentElement;
    if (basin === 'ALL') {
        compareSearchBasins = ['ALL'];
        parent.querySelectorAll('.basin-chip').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-basin') === 'ALL');
        });
    } else {
        // Remove ALL
        compareSearchBasins = compareSearchBasins.filter(function (b) { return b !== 'ALL'; });
        var idx = compareSearchBasins.indexOf(basin);
        if (idx >= 0) {
            compareSearchBasins.splice(idx, 1);
        } else {
            compareSearchBasins.push(basin);
        }
        if (compareSearchBasins.length === 0) compareSearchBasins = ['ALL'];
        parent.querySelectorAll('.basin-chip').forEach(function (b) {
            var d = b.getAttribute('data-basin');
            b.classList.toggle('active', compareSearchBasins.indexOf(d) >= 0);
        });
    }
    updateCompareSearch();
};

window.toggleCompareSearch = function () {
    compareSearchVisible = !compareSearchVisible;
    var inlinePanel = document.getElementById('compare-search-inline');
    var btn = document.getElementById('compare-add-btn');
    if (compareSearchVisible) {
        // Build inline search panel (mirrors the empty-state panel)
        inlinePanel.innerHTML = _buildCompareSearchHTML('inline');
        inlinePanel.style.display = '';
        if (btn) { btn.textContent = 'Hide Search'; btn.classList.add('active'); }
        // Sync basin chips in inline panel
        _syncCompareBasinChips(inlinePanel);
        _doCompareSearch('inline');
    } else {
        inlinePanel.style.display = 'none';
        inlinePanel.innerHTML = '';
        if (btn) { btn.textContent = '+ Add Storm'; btn.classList.remove('active'); }
    }
};

function _buildCompareSearchHTML(ctx) {
    var sfx = ctx === 'inline' ? '-i' : '';
    return '<h3 class="compare-search-title">Add Storms</h3>' +
        '<div class="compare-search-row">' +
            '<input type="text" id="compare-search-name' + sfx + '" class="ga-input" placeholder="Search by name (e.g. Katrina)" oninput="updateCompareSearch()">' +
        '</div>' +
        '<div class="compare-filter-row">' +
            '<span class="compare-filter-label">Basin:</span>' +
            '<div class="compare-basin-chips">' +
                '<button class="basin-chip active" data-basin="ALL" onclick="toggleCompareBasin(this)">All</button>' +
                '<button class="basin-chip" data-basin="AL" onclick="toggleCompareBasin(this)">AL</button>' +
                '<button class="basin-chip" data-basin="EP" onclick="toggleCompareBasin(this)">EP</button>' +
                '<button class="basin-chip" data-basin="WP" onclick="toggleCompareBasin(this)">WP</button>' +
                '<button class="basin-chip" data-basin="IO" onclick="toggleCompareBasin(this)">IO</button>' +
                '<button class="basin-chip" data-basin="SH" onclick="toggleCompareBasin(this)">SH</button>' +
            '</div>' +
        '</div>' +
        '<div class="compare-filter-row compare-filter-grid">' +
            '<div class="compare-filter-cell"><label>Year</label><div class="compare-range-inputs">' +
                '<input type="number" id="compare-year-min' + sfx + '" class="ga-input ga-input-sm" placeholder="1997" oninput="updateCompareSearch()">' +
                '<span>&ndash;</span>' +
                '<input type="number" id="compare-year-max' + sfx + '" class="ga-input ga-input-sm" placeholder="2024" oninput="updateCompareSearch()">' +
            '</div></div>' +
            '<div class="compare-filter-cell"><label>Min Wind (kt)</label>' +
                '<input type="number" id="compare-wind-min' + sfx + '" class="ga-input ga-input-sm" placeholder="0" oninput="updateCompareSearch()">' +
            '</div>' +
            '<div class="compare-filter-cell"><label>Min RI (kt/24h)</label>' +
                '<input type="number" id="compare-ri-min' + sfx + '" class="ga-input ga-input-sm" placeholder="0" oninput="updateCompareSearch()">' +
            '</div>' +
        '</div>' +
        '<div class="compare-filter-row">' +
            '<span class="compare-filter-label">Sort:</span>' +
            '<select id="compare-sort' + sfx + '" class="ga-select ga-select-sm" onchange="updateCompareSearch()">' +
                '<option value="year-desc">Year (newest)</option>' +
                '<option value="year-asc">Year (oldest)</option>' +
                '<option value="wind-desc">Peak Wind</option>' +
                '<option value="ri-desc">RI Rate</option>' +
                '<option value="ace-desc">ACE</option>' +
            '</select>' +
            '<span class="compare-result-count" id="compare-result-count' + sfx + '"></span>' +
        '</div>' +
        '<div id="compare-search-results' + sfx + '" class="compare-search-results"></div>';
}

function _syncCompareBasinChips(container) {
    container.querySelectorAll('.compare-basin-chips .basin-chip').forEach(function (b) {
        var d = b.getAttribute('data-basin');
        b.classList.toggle('active', compareSearchBasins.indexOf(d) >= 0);
    });
}

window.updateCompareSearch = function () {
    clearTimeout(_compareSearchTimer);
    _compareSearchTimer = setTimeout(function () {
        // Update both panels (empty-state and inline)
        _doCompareSearch('');
        _doCompareSearch('inline');
    }, 150);
};

function _doCompareSearch(ctx) {
    var sfx = ctx === 'inline' ? '-i' : '';
    var resultsEl = document.getElementById('compare-search-results' + sfx);
    if (!resultsEl) return;

    var nameInput = document.getElementById('compare-search-name' + sfx);
    var nameQuery = nameInput ? nameInput.value.trim().toUpperCase() : '';
    var yearMin = parseInt((document.getElementById('compare-year-min' + sfx) || {}).value) || 0;
    var yearMax = parseInt((document.getElementById('compare-year-max' + sfx) || {}).value) || 9999;
    var windMin = parseInt((document.getElementById('compare-wind-min' + sfx) || {}).value) || 0;
    var riMin = parseInt((document.getElementById('compare-ri-min' + sfx) || {}).value) || 0;
    var sortBy = (document.getElementById('compare-sort' + sfx) || {}).value || 'year-desc';

    var filtered = allStorms.filter(function (s) {
        if (nameQuery && (!s.name || s.name.toUpperCase().indexOf(nameQuery) === -1)) return false;
        if (compareSearchBasins[0] !== 'ALL' && compareSearchBasins.indexOf(s.basin) === -1) return false;
        if (s.year < yearMin || s.year > yearMax) return false;
        if ((s.peak_wind_kt || 0) < windMin) return false;
        if (riMin > 0 && (s.ri_24h == null || s.ri_24h < riMin)) return false;
        return true;
    });

    var comparators = {
        'year-desc': function (a, b) { return (b.year || 0) - (a.year || 0); },
        'year-asc':  function (a, b) { return (a.year || 0) - (b.year || 0); },
        'wind-desc': function (a, b) { return (b.peak_wind_kt || 0) - (a.peak_wind_kt || 0); },
        'ri-desc':   function (a, b) { return (b.ri_24h || 0) - (a.ri_24h || 0); },
        'ace-desc':  function (a, b) { return (b.ace || 0) - (a.ace || 0); }
    };
    if (comparators[sortBy]) filtered.sort(comparators[sortBy]);

    var total = filtered.length;
    filtered = filtered.slice(0, 50);

    // Update count
    var countEl = document.getElementById('compare-result-count' + sfx);
    if (countEl) countEl.textContent = total + ' storms' + (total > 50 ? ' (showing 50)' : '');

    // Render results
    _renderCompareSearchResults(resultsEl, filtered);
}

function _renderCompareSearchResults(container, storms) {
    if (!storms || storms.length === 0) {
        container.innerHTML = '<div class="compare-result-empty">No storms match your filters.</div>';
        return;
    }

    var alreadySids = {};
    compareStorms.forEach(function (s) { alreadySids[s.sid] = true; });
    var atMax = compareStorms.length >= COMPARE_MAX;

    var html = '';
    storms.forEach(function (s, i) {
        var isAdded = alreadySids[s.sid];
        var rowClass = 'compare-result-row' + (isAdded ? ' added' : '');
        var cat = _windCategory(s.peak_wind_kt);

        html += '<div class="' + rowClass + '" data-sid="' + s.sid + '" ' +
            (isAdded || atMax ? '' : 'onclick="addCompareFromSearch(\'' + s.sid + '\')"') + '>' +
            '<span class="compare-result-name">' + (s.name || 'UNNAMED') + '</span>' +
            '<span class="compare-result-meta">' + s.year + '</span>' +
            '<span class="compare-result-meta basin-badge-sm">' + (s.basin || '?') + '</span>' +
            '<span class="compare-result-meta">' + (s.peak_wind_kt || '-') + ' kt' +
                (cat ? ' <span class="cat-label-sm">' + cat + '</span>' : '') + '</span>' +
            '<span class="compare-result-meta">' + (s.ri_24h != null ? 'RI +' + s.ri_24h : '') + '</span>' +
            (isAdded
                ? '<span class="compare-result-add added">Added</span>'
                : atMax
                    ? '<span class="compare-result-add added">Full</span>'
                    : '<button class="compare-result-add" onclick="event.stopPropagation();addCompareFromSearch(\'' + s.sid + '\')">+ Add</button>'
            ) +
            '</div>';
    });
    container.innerHTML = html;
}

function _windCategory(kt) {
    if (!kt || kt < 34) return '';
    if (kt < 64) return 'TS';
    if (kt < 83) return 'Cat1';
    if (kt < 96) return 'Cat2';
    if (kt < 113) return 'Cat3';
    if (kt < 137) return 'Cat4';
    return 'Cat5';
}

window.addCompareFromSearch = function (sid) {
    var storm = allStorms.find(function (s) { return s.sid === sid; });
    if (storm) addToCompare(storm);
};

window.addCurrentToCompare = function () {
    if (!selectedStorm) return;
    addToCompare(selectedStorm);
};

function addToCompare(storm) {
    _ga('ga_add_to_compare', { storm_name: storm.name, year: storm.year, basin: storm.basin });
    if (compareStorms.length >= COMPARE_MAX) {
        showToast('Maximum ' + COMPARE_MAX + ' storms for comparison');
        return;
    }
    if (compareStorms.some(function (s) { return s.sid === storm.sid; })) {
        showToast(storm.name + ' already in comparison');
        return;
    }
    compareStorms.push(storm);
    showToast(storm.name + ' (' + storm.year + ') added to comparison');
    renderCompareView();
    // Refresh search results to update "Added" badges
    _doCompareSearch('');
    _doCompareSearch('inline');
}

window.removeFromCompare = function (sid) {
    compareStorms = compareStorms.filter(function (s) { return s.sid !== sid; });
    renderCompareView();
    _doCompareSearch('');
    _doCompareSearch('inline');
};

window.clearCompare = function () {
    compareStorms = [];
    compareSearchVisible = false;
    renderCompareView();
};

window.setCompareAlign = function (mode) {
    compareAlign = mode;
    document.querySelectorAll('.compare-align').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-align') === mode);
    });
    if (compareStorms.length > 0) renderCompareTimeline();
};

function renderCompareView() {
    var chips = document.getElementById('compare-chips');
    var empty = document.getElementById('compare-empty');
    var content = document.getElementById('compare-content');
    var tableWrap = document.getElementById('compare-table-wrap');
    var addBtn = document.getElementById('compare-add-btn');
    var inlinePanel = document.getElementById('compare-search-inline');

    // Render chips
    chips.innerHTML = compareStorms.map(function (s, i) {
        var c = COMPARE_COLORS[i % COMPARE_COLORS.length];
        return '<span class="compare-chip">' +
            '<span class="compare-chip-dot" style="background:' + c + '"></span>' +
            s.name + ' ' + s.year +
            '<span class="compare-chip-remove" onclick="removeFromCompare(\'' + s.sid + '\')">&times;</span>' +
            '</span>';
    }).join('');

    if (compareStorms.length === 0) {
        empty.style.display = '';
        content.style.display = 'none';
        tableWrap.style.display = 'none';
        if (addBtn) addBtn.style.display = 'none';
        if (inlinePanel) { inlinePanel.style.display = 'none'; inlinePanel.innerHTML = ''; }
        compareSearchVisible = false;
        // Auto-populate search results in empty state
        setTimeout(function () { _doCompareSearch(''); }, 50);
        return;
    }

    empty.style.display = 'none';
    content.style.display = '';
    tableWrap.style.display = '';
    if (addBtn) addBtn.style.display = '';

    renderCompareTimeline();
    renderCompareMap();
    renderCompareTable();
}

function renderCompareTimeline() {
    var traces = [];
    var maxWind = 0;

    compareStorms.forEach(function (storm, idx) {
        var track = allTracks[storm.sid];
        if (!track || track.length === 0) return;

        var color = COMPARE_COLORS[idx % COMPARE_COLORS.length];
        var times = [];
        var winds = [];
        var pres = [];

        // Find reference point for alignment
        var refTime = null;
        if (compareAlign === 'genesis') {
            // Use genesis definition: first tropical/subtropical point w/ TD+ wind
            var genPt = _trackGenesisPoint(track);
            if (genPt && genPt.t) refTime = new Date(genPt.t).getTime();
        } else if (compareAlign === 'lmi') {
            var maxW = -1;
            for (var i = 0; i < track.length; i++) {
                if (track[i].w && track[i].w > maxW) {
                    maxW = track[i].w;
                    refTime = new Date(track[i].t).getTime();
                }
            }
        }

        track.forEach(function (pt) {
            if (!pt.t) return;
            if (compareAlign === 'absolute') {
                times.push(pt.t);
            } else {
                // Hours relative to reference point
                var h = (new Date(pt.t).getTime() - refTime) / 3600000;
                times.push(Math.round(h * 10) / 10);
            }
            winds.push(pt.w);
            pres.push(pt.p);
            if (pt.w && pt.w > maxWind) maxWind = pt.w;
        });

        traces.push({
            x: times, y: winds,
            type: 'scatter', mode: 'lines+markers',
            name: storm.name + ' ' + storm.year + ' (wind)',
            line: { color: color, width: 2.5 },
            marker: { color: color, size: 5 },
            hovertemplate: '<b>' + storm.name + ' ' + storm.year + '</b><br>%{x}<br>Wind: %{y} kt<extra></extra>',
            yaxis: 'y'
        });

        // Pressure trace (thinner, dashed)
        if (compareStorms.length <= 3) {
            traces.push({
                x: times, y: pres,
                type: 'scatter', mode: 'lines',
                name: storm.name + ' ' + storm.year + ' (pres)',
                line: { color: color, width: 1, dash: 'dot' },
                hovertemplate: '<b>' + storm.name + ' ' + storm.year + '</b><br>Pressure: %{y} hPa<extra></extra>',
                yaxis: 'y2',
                showlegend: false
            });
        }
    });

    var xTitle = compareAlign === 'absolute' ? 'Date/Time' :
                 compareAlign === 'genesis' ? 'Hours from Genesis' : 'Hours from LMI';

    var shapes = [
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0,   y1: 34,  fillcolor: 'rgba(96,165,250,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 34,  y1: 64,  fillcolor: 'rgba(52,211,153,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 64,  y1: 83,  fillcolor: 'rgba(251,191,36,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 83,  y1: 96,  fillcolor: 'rgba(251,146,60,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 96,  y1: 113, fillcolor: 'rgba(248,113,113,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 113, y1: 137, fillcolor: 'rgba(239,68,68,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 137, y1: 200, fillcolor: 'rgba(220,38,38,0.06)', line: { width: 0 } }
    ];

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: xTitle, font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        yaxis: {
            title: { text: 'Max Wind (kt)', font: { size: 11, color: '#00d4ff' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)',
            range: [0, Math.min(maxWind + 20, 200)]
        },
        yaxis2: {
            title: { text: 'Pressure (hPa)', font: { size: 11, color: '#a78bfa' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            overlaying: 'y', side: 'right',
            autorange: 'reversed', gridcolor: 'transparent'
        },
        shapes: shapes,
        showlegend: true,
        legend: {
            x: 0.01, y: 0.99,
            bgcolor: 'rgba(15,33,64,0.8)',
            bordercolor: 'rgba(255,255,255,0.08)',
            borderwidth: 1,
            font: { size: 10, color: '#e2e8f0' }
        },
        margin: { l: 55, r: 55, t: 10, b: 45 }
    });

    Plotly.newPlot('compare-timeline', traces, layout, PLOTLY_CONFIG);
}

function renderCompareMap() {
    if (compareMap) {
        compareMap.remove();
        compareMap = null;
    }

    compareMap = L.map('compare-map', {
        center: [20, -60], zoom: 3,
        zoomControl: true, worldCopyJump: true
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO', subdomains: 'abcd', maxZoom: 12
    }).addTo(compareMap);

    var allLats = [], allLons = [];

    compareStorms.forEach(function (storm, idx) {
        var track = allTracks[storm.sid];
        if (!track || track.length < 2) return;

        var color = COMPARE_COLORS[idx % COMPARE_COLORS.length];

        // Draw track segments — non-TC phases (disturbance, ET) shown thinner/dashed
        for (var i = 1; i < track.length; i++) {
            var p0 = track[i - 1], p1 = track[i];
            if (!p0.la || !p0.lo || !p1.la || !p1.lo) continue;
            var isTCPhase = _isTCNature(p1.n);
            L.polyline([[p0.la, p0.lo], [p1.la, p1.lo]], {
                color: color,
                weight: isTCPhase ? 3 : 1.5,
                opacity: isTCPhase ? 0.85 : 0.35,
                dashArray: isTCPhase ? null : '6,4'
            }).addTo(compareMap);
            allLats.push(p0.la, p1.la);
            allLons.push(p0.lo, p1.lo);
        }

        // Genesis marker (TD+ genesis, not first disturbance fix)
        var genCoords = _trackGenesis(track);
        var first = genCoords ? { la: genCoords[0], lo: genCoords[1] } : null;
        if (first) {
            L.circleMarker([first.la, first.lo], {
                radius: 5, color: color, fillColor: color,
                fillOpacity: 0.8, weight: 2
            }).bindTooltip(storm.name + ' ' + storm.year + ' (genesis)', {
                className: 'track-tooltip'
            }).addTo(compareMap);
        }

        // LMI marker
        var lmiPt = track.reduce(function (best, pt) {
            return (pt.w && (!best || pt.w > best.w)) ? pt : best;
        }, null);
        if (lmiPt && lmiPt.la && lmiPt.lo) {
            L.circleMarker([lmiPt.la, lmiPt.lo], {
                radius: 7, color: '#fff', fillColor: color,
                fillOpacity: 1, weight: 2
            }).bindTooltip(storm.name + ' ' + storm.year + ' LMI: ' + (lmiPt.w || '?') + ' kt', {
                className: 'track-tooltip'
            }).addTo(compareMap);
        }
    });

    // Fit bounds
    if (allLats.length > 0) {
        compareMap.fitBounds([
            [Math.min.apply(null, allLats) - 3, Math.min.apply(null, allLons) - 5],
            [Math.max.apply(null, allLats) + 3, Math.max.apply(null, allLons) + 5]
        ]);
    }
}

function renderCompareTable() {
    var html = '<table><thead><tr>' +
        '<th></th><th>Name</th><th>Year</th><th>Basin</th>' +
        '<th>Peak Wind</th><th>Min Pres</th><th>ACE</th><th>RI 24h</th><th>Duration</th>' +
        '</tr></thead><tbody>';

    compareStorms.forEach(function (s, idx) {
        var c = COMPARE_COLORS[idx % COMPARE_COLORS.length];
        var track = allTracks[s.sid] || [];
        var duration = _tcDuration(track);
        if (!duration && s.start_date && s.end_date) {
            // Fallback if no nature data: use total track span
            var days = Math.round((new Date(s.end_date) - new Date(s.start_date)) / 86400000);
            duration = days + 'd';
        }
        html += '<tr>' +
            '<td><span class="compare-chip-dot" style="background:' + c + '"></span></td>' +
            '<td style="font-family:DM Sans;font-weight:600;color:' + c + '">' + s.name + '</td>' +
            '<td>' + s.year + '</td>' +
            '<td>' + (s.basin || '-') + '</td>' +
            '<td>' + (s.peak_wind_kt || '-') + ' kt</td>' +
            '<td>' + (s.min_pres_hpa || '-') + '</td>' +
            '<td>' + (s.ace || 0).toFixed(1) + '</td>' +
            '<td>' + (s.ri_24h != null ? '+' + s.ri_24h + ' kt' : '-') + '</td>' +
            '<td>' + duration + '</td>' +
            '</tr>';
    });

    html += '</tbody></table>';
    document.getElementById('compare-table').innerHTML = html;
}


// ── Analog Storm Finder ─────────────────────────────────────

var analogReference = null;      // The storm being matched against
var analogResults = [];          // Computed results (top 20)
var analogChecked = {};          // SID → boolean for checkboxes
var analogBasinMode = 'same';    // 'same' or 'ALL'

window.openAnalogFinder = function () {
    if (!selectedStorm) {
        showToast('Select a storm first');
        return;
    }
    analogReference = selectedStorm;
    analogChecked = {};
    document.getElementById('analog-modal-title').textContent =
        'Analogs for ' + selectedStorm.name + ' (' + selectedStorm.year + ')';
    document.getElementById('analog-modal').style.display = 'flex';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    updateAnalogResults();
};

window.closeAnalogFinder = function () {
    document.getElementById('analog-modal').style.display = 'none';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};

// Hide EVERYTHING behind modals — the only truly bulletproof fix for
// elements bleeding through fixed-position overlays.
function _hideBackgroundElements() {
    var main = document.getElementById('global-main');
    if (main) main.style.display = 'none';
    var tabs = document.querySelector('.ga-tabs');
    if (tabs) tabs.style.display = 'none';
}
function _showBackgroundElements() {
    var main = document.getElementById('global-main');
    if (main) main.style.display = '';
    var tabs = document.querySelector('.ga-tabs');
    if (tabs) tabs.style.display = '';
    // Leaflet maps need a size refresh after being re-shown
    setTimeout(function () {
        if (stormMap) stormMap.invalidateSize();
        if (detailMap) detailMap.invalidateSize();
        if (compareMap) compareMap.invalidateSize();
    }, 50);
}

window.toggleAnalogBasin = function (btn) {
    var mode = btn.getAttribute('data-basin');
    analogBasinMode = mode;
    document.querySelectorAll('.analog-basin-filter .basin-chip').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-basin') === mode);
    });
    updateAnalogResults();
};

window.toggleAnalogCheck = function (sid) {
    analogChecked[sid] = !analogChecked[sid];
    var count = Object.keys(analogChecked).filter(function (k) { return analogChecked[k]; }).length;
    document.getElementById('analog-selected-count').textContent = count + ' selected';
};

window.compareSelectedAnalogs = function () {
    // Add reference storm + checked analogs to comparison
    compareStorms = [];
    addToCompare(analogReference);
    analogResults.forEach(function (r) {
        if (analogChecked[r.storm.sid]) {
            addToCompare(r.storm);
        }
    });
    closeAnalogFinder();
    switchTab('compare');
};

window.updateAnalogResults = function () {
    if (!analogReference) return;

    // Read weights from sliders
    var weights = {
        peak:    parseInt(document.getElementById('aw-peak').value),
        ri:      parseInt(document.getElementById('aw-ri').value),
        genesis: parseInt(document.getElementById('aw-genesis').value),
        track:   parseInt(document.getElementById('aw-track').value),
        season:  parseInt(document.getElementById('aw-season').value),
        ace:     parseInt(document.getElementById('aw-ace').value)
    };

    // Update displayed values
    document.getElementById('aw-peak-val').textContent = weights.peak;
    document.getElementById('aw-ri-val').textContent = weights.ri;
    document.getElementById('aw-genesis-val').textContent = weights.genesis;
    document.getElementById('aw-track-val').textContent = weights.track;
    document.getElementById('aw-season-val').textContent = weights.season;
    document.getElementById('aw-ace-val').textContent = weights.ace;

    var totalWeight = weights.peak + weights.ri + weights.genesis + weights.track + weights.season + weights.ace;
    if (totalWeight === 0) totalWeight = 1;

    var ref = analogReference;
    var refTrack = allTracks[ref.sid] || [];
    var refGenesis = _trackGenesis(refTrack);
    var refLMI = _trackLMI(refTrack);
    var refDOY = _stormDOY(ref);

    // Score all storms
    var scored = [];
    for (var i = 0; i < allStorms.length; i++) {
        var s = allStorms[i];
        if (s.sid === ref.sid) continue;
        if (analogBasinMode === 'same' && s.basin !== ref.basin) continue;

        var score = 0;

        // Peak intensity (0-1)
        if (weights.peak > 0 && ref.peak_wind_kt != null && s.peak_wind_kt != null) {
            score += weights.peak * (1 - Math.min(Math.abs(ref.peak_wind_kt - s.peak_wind_kt) / 100, 1));
        }

        // RI rate
        if (weights.ri > 0 && ref.ri_24h != null && s.ri_24h != null) {
            score += weights.ri * (1 - Math.min(Math.abs(ref.ri_24h - s.ri_24h) / 60, 1));
        }

        // Genesis location (haversine)
        if (weights.genesis > 0 && refGenesis) {
            var sGenesis = _trackGenesis(allTracks[s.sid] || []);
            if (sGenesis) {
                var dist = _haversineKm(refGenesis[0], refGenesis[1], sGenesis[0], sGenesis[1]);
                score += weights.genesis * (1 - Math.min(dist / 3000, 1));
            }
        }

        // Track shape (genesis→LMI bearing + distance)
        if (weights.track > 0 && refGenesis && refLMI) {
            var sTrack = allTracks[s.sid] || [];
            var sGenesis = _trackGenesis(sTrack);
            var sLMI = _trackLMI(sTrack);
            if (sGenesis && sLMI) {
                var refBearing = _bearing(refGenesis[0], refGenesis[1], refLMI[0], refLMI[1]);
                var sBearing = _bearing(sGenesis[0], sGenesis[1], sLMI[0], sLMI[1]);
                var bearingDiff = Math.abs(refBearing - sBearing);
                if (bearingDiff > 180) bearingDiff = 360 - bearingDiff;
                var refDist = _haversineKm(refGenesis[0], refGenesis[1], refLMI[0], refLMI[1]);
                var sDist = _haversineKm(sGenesis[0], sGenesis[1], sLMI[0], sLMI[1]);
                var distScore = 1 - Math.min(Math.abs(refDist - sDist) / 2000, 1);
                var bearingScore = 1 - bearingDiff / 180;
                score += weights.track * (bearingScore * 0.5 + distScore * 0.5);
            }
        }

        // Time of year (circular DOY)
        if (weights.season > 0 && refDOY != null) {
            var sDOY = _stormDOY(s);
            if (sDOY != null) {
                var doyDiff = Math.abs(refDOY - sDOY);
                if (doyDiff > 182) doyDiff = 365 - doyDiff;
                score += weights.season * (1 - doyDiff / 182);
            }
        }

        // ACE
        if (weights.ace > 0 && ref.ace != null && s.ace != null) {
            score += weights.ace * (1 - Math.min(Math.abs(ref.ace - s.ace) / 50, 1));
        }

        scored.push({ storm: s, score: score / totalWeight });
    }

    // Sort and take top 20
    scored.sort(function (a, b) { return b.score - a.score; });
    analogResults = scored.slice(0, 20);

    // Render results table
    _renderAnalogTable();
};

function _renderAnalogTable() {
    var container = document.getElementById('analog-results');
    if (analogResults.length === 0) {
        container.innerHTML = '<p style="color:#8b9ec2;text-align:center;padding:20px;">No matching storms found.</p>';
        return;
    }

    // Reference storm row
    var ref = analogReference;
    var html = '<table><thead><tr>' +
        '<th></th><th>#</th><th>Name</th><th>Year</th><th>Basin</th>' +
        '<th>Peak</th><th>RI 24h</th><th>ACE</th><th>Score</th>' +
        '</tr></thead><tbody>' +
        '<tr style="background:rgba(46,125,255,0.1);border-bottom:2px solid var(--blue);">' +
        '<td style="text-align:center;font-size:0.7rem;color:#00d4ff;">REF</td>' +
        '<td></td>' +
        '<td style="color:' + getIntensityColor(ref.peak_wind_kt) + ';font-family:DM Sans;font-weight:700">' + (ref.name || 'UNNAMED') + '</td>' +
        '<td>' + ref.year + '</td>' +
        '<td>' + (ref.basin || '-') + '</td>' +
        '<td style="font-weight:700">' + (ref.peak_wind_kt || '-') + '</td>' +
        '<td style="font-weight:700">' + (ref.ri_24h != null ? '+' + ref.ri_24h : '-') + '</td>' +
        '<td style="font-weight:700">' + (ref.ace || 0).toFixed(1) + '</td>' +
        '<td style="color:#00d4ff;">—</td>' +
        '</tr>';

    analogResults.forEach(function (r, i) {
        var s = r.storm;
        var checked = analogChecked[s.sid] ? ' checked' : '';
        var pct = Math.round(r.score * 100);
        var barW = Math.max(pct * 0.8, 2);
        html += '<tr>' +
            '<td><input type="checkbox" onchange="toggleAnalogCheck(\'' + s.sid + '\')"' + checked + '></td>' +
            '<td>' + (i + 1) + '</td>' +
            '<td style="color:' + getIntensityColor(s.peak_wind_kt) + ';font-family:DM Sans;font-weight:600">' + (s.name || 'UNNAMED') + '</td>' +
            '<td>' + s.year + '</td>' +
            '<td>' + (s.basin || '-') + '</td>' +
            '<td>' + (s.peak_wind_kt || '-') + '</td>' +
            '<td>' + (s.ri_24h != null ? '+' + s.ri_24h : '-') + '</td>' +
            '<td>' + (s.ace || 0).toFixed(1) + '</td>' +
            '<td>' + pct + '%<span class="analog-score-bar" style="width:' + barW + 'px"></span></td>' +
            '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

// ── Analog helper functions ─────────────────────────────────

/**
 * Genesis = first track point classified as a tropical or subtropical cyclone
 * with a closed circulation, per standard TC community genesis definitions.
 *
 * Priority:
 * 1. First point with NATURE = TS/SS (tropical/subtropical) AND wind >= 25 kt
 * 2. First point with NATURE = TS/SS (if wind data missing but nature exists)
 * 3. First point with wind >= 25 kt (if nature field not yet in track data)
 * 4. First valid coordinate (ultimate fallback for sparse records)
 */
function _trackGenesis(track) {
    if (!track) return null;
    var hasNature = track.some(function (p) { return p.n; });
    if (hasNature) {
        // Best: nature is tropical/subtropical AND has TD+ wind
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null && (p.n === 'TS' || p.n === 'SS') && p.w != null && p.w >= 25) {
                return [p.la, p.lo];
            }
        }
        // Nature-only fallback (no wind data at genesis point)
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null && (p.n === 'TS' || p.n === 'SS')) {
                return [p.la, p.lo];
            }
        }
    }
    // Wind-only fallback (nature field not yet in track data)
    for (var i = 0; i < track.length; i++) {
        if (track[i].la != null && track[i].lo != null && track[i].w != null && track[i].w >= 25) {
            return [track[i].la, track[i].lo];
        }
    }
    // Ultimate fallback: first valid coordinate
    for (var i = 0; i < track.length; i++) {
        if (track[i].la != null && track[i].lo != null) return [track[i].la, track[i].lo];
    }
    return null;
}

/**
 * Same logic as _trackGenesis but returns the full track point object
 * (with t, la, lo, w, p, n fields) instead of just [lat, lon].
 */
function _trackGenesisPoint(track) {
    if (!track) return null;
    var hasNature = track.some(function (p) { return p.n; });
    if (hasNature) {
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null && (p.n === 'TS' || p.n === 'SS') && p.w != null && p.w >= 25) return p;
        }
        for (var i = 0; i < track.length; i++) {
            var p = track[i];
            if (p.la != null && p.lo != null && (p.n === 'TS' || p.n === 'SS')) return p;
        }
    }
    for (var i = 0; i < track.length; i++) {
        if (track[i].la != null && track[i].lo != null && track[i].w != null && track[i].w >= 25) return track[i];
    }
    for (var i = 0; i < track.length; i++) {
        if (track[i].la != null && track[i].lo != null) return track[i];
    }
    return null;
}

function _trackLMI(track) {
    if (!track) return null;
    var best = null;
    for (var i = 0; i < track.length; i++) {
        if (track[i].w && (!best || track[i].w > best.w)) best = track[i];
    }
    return best && best.la != null ? [best.la, best.lo] : null;
}

/**
 * Compute TC-only duration: time span where NATURE is TS or SS.
 * Returns string like "5d" or "3.5d", or '' if no nature data.
 */
function _tcDuration(track) {
    if (!track || !track.some(function (p) { return p.n; })) return '';
    var tcPoints = track.filter(function (p) {
        return p.t && (p.n === 'TS' || p.n === 'SS');
    });
    if (tcPoints.length < 2) return tcPoints.length === 1 ? '<1d' : '';
    var first = new Date(tcPoints[0].t).getTime();
    var last = new Date(tcPoints[tcPoints.length - 1].t).getTime();
    var days = (last - first) / 86400000;
    return days < 1 ? '<1d' : (days % 1 > 0.2 ? days.toFixed(1) + 'd' : Math.round(days) + 'd');
}

/** Returns true if nature code indicates a TC phase (tropical or subtropical). */
function _isTCNature(n) {
    // If no nature data, assume TC (backward compat with pre-nature track data)
    if (!n) return true;
    return n === 'TS' || n === 'SS';
}

function _stormDOY(storm) {
    if (!storm.start_date) return null;
    var d = new Date(storm.start_date);
    var start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
}

function _haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _bearing(lat1, lon1, lat2, lon2) {
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    var x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function renderDetailMap(track, storm) {
    // Destroy existing map and IR overlay references
    irOverlayLayer = null;
    irPositionMarker = null;
    if (detailMap) {
        detailMap.remove();
        detailMap = null;
    }

    // Create map centered on storm
    var centerLat = storm.lmi_lat || storm.genesis_lat || 20;
    var centerLon = storm.lmi_lon || storm.genesis_lon || -60;

    detailMap = L.map('detail-map', {
        center: [centerLat, centerLon],
        zoom: 4,
        zoomControl: true,
        worldCopyJump: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 12
    }).addTo(detailMap);

    // Draw track — TC phases (TS/SS) get thick solid lines,
    // non-TC phases (DS=disturbance, ET=extratropical) get thin dashed lines
    for (var i = 1; i < track.length; i++) {
        var p0 = track[i - 1];
        var p1 = track[i];
        if (!p0.la || !p0.lo || !p1.la || !p1.lo) continue;

        var isTCPhase = _isTCNature(p1.n);
        var color = isTCPhase ? getIntensityColor(p1.w) : '#6b7280';
        var weight = isTCPhase ? 3.5 : 1.5;
        var opacity = isTCPhase ? 0.9 : 0.5;
        var dashArray = isTCPhase ? null : '6,4';
        L.polyline(
            [[p0.la, p0.lo], [p1.la, p1.lo]],
            { color: color, weight: weight, opacity: opacity, dashArray: dashArray }
        ).addTo(detailMap);
    }

    // Add markers at key points
    var validPts = track.filter(function (p) { return p.la && p.lo; });
    if (validPts.length > 0) {
        // Genesis marker (first tropical/subtropical point w/ TD+ intensity)
        trackAnnotationMarkers = [];
        var genPt = _trackGenesisPoint(track);
        var gen = genPt || validPts[0]; // fallback to first point if no genesis found
        var genM = L.circleMarker([gen.la, gen.lo], {
            radius: 6, color: '#fff', fillColor: '#60a5fa', fillOpacity: 1, weight: 2
        }).bindTooltip('Genesis: ' + (gen.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
        trackAnnotationMarkers.push(genM);

        // LMI marker
        var lmiPt = validPts.reduce(function (max, p) { return (p.w || 0) > (max.w || 0) ? p : max; }, validPts[0]);
        if (lmiPt) {
            var lmiM = L.circleMarker([lmiPt.la, lmiPt.lo], {
                radius: 8, color: '#fff', fillColor: getIntensityColor(lmiPt.w), fillOpacity: 1, weight: 2
            }).bindTooltip('Peak: ' + (lmiPt.w || '?') + ' kt @ ' + (lmiPt.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
            trackAnnotationMarkers.push(lmiM);
        }

        // End marker
        var end = validPts[validPts.length - 1];
        var endM = L.circleMarker([end.la, end.lo], {
            radius: 5, color: '#fff', fillColor: '#6b7280', fillOpacity: 1, weight: 2
        }).bindTooltip('Dissipation: ' + (end.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
        trackAnnotationMarkers.push(endM);

        // Fit bounds
        var lats = validPts.map(function (p) { return p.la; });
        var lons = validPts.map(function (p) { return p.lo; });
        detailMap.fitBounds([
            [Math.min.apply(null, lats) - 3, Math.min.apply(null, lons) - 5],
            [Math.max.apply(null, lats) + 3, Math.max.apply(null, lons) + 5]
        ]);
    }
}

// ══════════════════════════════════════════════════════════════
//  HURSAT IR ANIMATION
// ══════════════════════════════════════════════════════════════

function loadHURSAT(storm) {
    _ga('ga_load_ir_imagery', { sid: storm.sid, storm_name: storm.name, year: storm.year });
    irFrames = [];
    irMeta = null;
    irFrameIdx = 0;
    irPrefetchActive = 0;
    irFailedFrames = {};
    irFollowZoomSet = false;
    stopIRPlayback();
    removeIROverlay();

    // Build track data for MergIR (needed for storm-centered subsetting)
    var track = allTracks[storm.sid] || [];
    var trackParam = track.length > 0 ? '&track=' + encodeURIComponent(JSON.stringify(track)) : '';

    // Pass storm longitude for satellite viewing angle selection (HURSAT dedup)
    var lonParam = storm.lmi_lon != null ? '&storm_lon=' + storm.lmi_lon : '';

    // Use unified IR endpoint (auto-selects HURSAT vs MergIR)
    var metaUrl = API_BASE + '/global/ir/meta?sid=' + encodeURIComponent(storm.sid) + trackParam + lonParam;

    // Fall back to HURSAT-only endpoint if unified fails
    var fallbackUrl = API_BASE + '/global/hursat/meta?sid=' + encodeURIComponent(storm.sid) + lonParam;

    document.getElementById('ir-status').textContent = 'Checking satellite data...';

    // Use prefetched metadata if available (from selectStorm early prefetch)
    var metaPromise;
    if (irMetaPrefetchCache[storm.sid]) {
        metaPromise = Promise.resolve(irMetaPrefetchCache[storm.sid]);
    } else {
        metaPromise = fetch(metaUrl)
            .then(function (r) {
                if (!r.ok) throw new Error('IR metadata not available');
                return r.json();
            })
            .catch(function () {
                return fetch(fallbackUrl).then(function (r) {
                    if (!r.ok) throw new Error('HURSAT metadata not available');
                    return r.json();
                });
            });
    }

    metaPromise.then(function (meta) {
            if (!meta.available || meta.n_frames === 0) {
                var reason = meta.reason || 'No satellite frames found';
                document.getElementById('ir-status').textContent = reason;
                document.getElementById('ir-toggle-wrap').style.display = 'none';
                return;
            }
            irMeta = meta;
            document.getElementById('ir-slider').max = meta.n_frames - 1;
            document.getElementById('ir-slider').value = 0;

            var sourceLabel = meta.source === 'mergir' ? 'MergIR 4km' : (meta.source === 'gridsat' ? 'GridSat-B1' : 'HURSAT-B1');
            document.getElementById('ir-status').textContent =
                meta.n_frames + ' frames (' + sourceLabel + ')';
            document.getElementById('ir-source-badge').textContent = sourceLabel;

            // Auto-show IR overlay
            irOverlayVisible = true;
            // Hide genesis/LMI/dissipation markers so they don't obscure IR
            trackAnnotationMarkers.forEach(function (m) { if (detailMap) detailMap.removeLayer(m); });
            var toggleBtn = document.getElementById('ir-toggle-btn');
            toggleBtn.textContent = 'Hide IR';
            toggleBtn.classList.add('active');
            document.getElementById('ir-map-controls').style.display = '';

            // Show loading state for first frame
            var loadingEl = document.getElementById('ir-frame-loading');
            if (loadingEl) loadingEl.style.display = 'flex';
            if (meta.source === 'hursat') {
                setIRLoadingText('Downloading satellite archive...\nThis may take up to 60 seconds');
            } else {
                setIRLoadingText('Loading satellite imagery...');
            }

            // Load first frame — use prefetched data if available
            irFrameIdx = 0;
            if (irFirstFrameCache[storm.sid]) {
                // First frame was already prefetched — display instantly
                irFrames[0] = irFirstFrameCache[storm.sid];
                delete irFirstFrameCache[storm.sid]; // Free memory
                displayIROnMap(irFrames[0]);
                updateIRMeta(0);
                var loadingEl2 = document.getElementById('ir-frame-loading');
                if (loadingEl2) loadingEl2.style.display = 'none';
                prefetchIRFrames(0);
            } else {
                loadIRFrame(0);
            }

            // Prefetching is triggered by loadIRFrame's callback (or above)
        })
        .catch(function (err) {
            console.warn('IR load failed:', err);
            document.getElementById('ir-status').textContent = 'API not connected';
            document.getElementById('ir-toggle-wrap').style.display = 'none';
        });
}

function removeIROverlay() {
    if (irOverlayLayer && detailMap) {
        try { detailMap.removeLayer(irOverlayLayer); } catch (e) {}
    }
    irOverlayLayer = null;
    if (irPositionMarker && detailMap) {
        try { detailMap.removeLayer(irPositionMarker); } catch (e) {}
    }
    // Clear intensity chart marker
    _lastMarkerDt = null;
    if (typeof updateIntensityMarker === 'function') {
        updateIntensityMarker(null);
    }
    irPositionMarker = null;
    irOverlayVisible = false;
    // Clear Tb hover state
    irCurrentTbGrid = null;
    irCurrentBounds = null;
    if (irTbTooltip && detailMap) {
        try { detailMap.closePopup(irTbTooltip); } catch (e) {}
    }
}

window.toggleIROverlay = function () {
    if (!irMeta) return;
    irOverlayVisible = !irOverlayVisible;

    var toggleBtn = document.getElementById('ir-toggle-btn');
    var controls = document.getElementById('ir-map-controls');

    if (irOverlayVisible) {
        toggleBtn.textContent = 'Hide IR';
        toggleBtn.classList.add('active');
        controls.style.display = '';
        // Reposition MW controls above IR if MW is visible
        setTimeout(_repositionMWControls, 50);
        // Hide track annotation markers so they don't obscure IR
        trackAnnotationMarkers.forEach(function (m) { if (detailMap) detailMap.removeLayer(m); });
        if (irOverlayLayer && detailMap) {
            irOverlayLayer.addTo(detailMap);
            irOverlayLayer.setOpacity(irOpacity);
        }
        if (irPositionMarker && detailMap) {
            irPositionMarker.addTo(detailMap);
        }
        if (irFrames[irFrameIdx]) {
            displayIROnMap(irFrames[irFrameIdx]);
        } else {
            loadIRFrame(irFrameIdx);
        }
    } else {
        toggleBtn.textContent = 'Show IR';
        toggleBtn.classList.remove('active');
        controls.style.display = 'none';
        // Reposition MW controls back to bottom
        _repositionMWControls();
        stopIRPlayback();
        if (irOverlayLayer && detailMap) {
            detailMap.removeLayer(irOverlayLayer);
        }
        if (irPositionMarker && detailMap) {
            detailMap.removeLayer(irPositionMarker);
        }
        // Restore track annotation markers
        trackAnnotationMarkers.forEach(function (m) { if (detailMap) m.addTo(detailMap); });
        // Close Tb hover tooltip
        if (irTbTooltip && detailMap) {
            try { detailMap.closePopup(irTbTooltip); } catch (e) {}
        }
        // Remove intensity chart time marker
        updateIntensityMarker(null);
    }
};

window.cycleIROpacity = function () {
    irOpacityIdx = (irOpacityIdx + 1) % irOpacityLevels.length;
    irOpacity = irOpacityLevels[irOpacityIdx];
    document.getElementById('ir-opacity-label').textContent = Math.round(irOpacity * 100) + '%';
    if (irOverlayLayer) {
        irOverlayLayer.setOpacity(irOpacity);
    }
};

window.toggleIRFollow = function () {
    irFollowStorm = !irFollowStorm;
    irFollowZoomSet = false; // Reset so next frame establishes zoom
    var btn = document.getElementById('ir-follow-btn');
    if (btn) {
        btn.classList.toggle('active', irFollowStorm);
        btn.title = irFollowStorm ? 'View locked to storm center (click to unlock)' : 'Free pan mode (click to lock on storm)';
    }
    // If just enabled, immediately snap to current frame
    if (irFollowStorm && irOverlayLayer && detailMap) {
        var frameBounds = irOverlayLayer.getBounds();
        if (frameBounds) {
            detailMap.fitBounds(frameBounds.pad(0.15), { animate: true, duration: 0.3, maxZoom: 7 });
            irFollowZoomSet = true;
        }
    }
};

function displayIROnMap(data) {
    if (!detailMap || !irOverlayVisible) {
        console.log('displayIROnMap: skipped (map=' + !!detailMap + ', visible=' + irOverlayVisible + ')');
        return;
    }
    if (!data || !data.frame) {
        console.warn('displayIROnMap: no frame data', data);
        return;
    }
    console.log('displayIROnMap: rendering frame, bounds=', data.bounds, 'frame length=', data.frame.length);

    var bounds = data.bounds;
    if (!bounds) {
        // Fallback: estimate bounds from storm position
        var track = allTracks[selectedStorm.sid] || [];
        var frameMeta = irMeta && irMeta.frames ? irMeta.frames[irFrameIdx] : null;
        var centerLat, centerLon;
        if (frameMeta && frameMeta.lat != null) {
            centerLat = frameMeta.lat;
            centerLon = frameMeta.lon;
        } else if (frameMeta && frameMeta.datetime) {
            var pt = findTrackPointAtTime(track, frameMeta.datetime);
            centerLat = pt ? pt.la : (selectedStorm.lmi_lat || 20);
            centerLon = pt ? pt.lo : (selectedStorm.lmi_lon || -60);
        } else {
            centerLat = selectedStorm.lmi_lat || 20;
            centerLon = selectedStorm.lmi_lon || -60;
        }
        var halfDeg = 7.0;  // Consistent domain size across all sources
        bounds = {
            south: centerLat - halfDeg,
            north: centerLat + halfDeg,
            west: centerLon - halfDeg,
            east: centerLon + halfDeg
        };
    }

    var imageBounds = L.latLngBounds(
        [bounds.south, bounds.west],
        [bounds.north, bounds.east]
    );

    // Remove old overlay and create fresh one each frame
    // (setUrl + setBounds on data URIs can cause stale image rendering)
    if (irOverlayLayer) {
        try { detailMap.removeLayer(irOverlayLayer); } catch (e) {}
    }
    irOverlayLayer = L.imageOverlay(data.frame, imageBounds, {
        opacity: irOpacity,
        interactive: false,
        className: 'ir-overlay-image'
    }).addTo(detailMap);

    // Store Tb grid and bounds for hover display
    irCurrentTbGrid = data.tb_grid || null;
    irCurrentBounds = imageBounds;

    // Set up mousemove handler (once) for Tb hover
    if (!detailMap._irHoverAttached) {
        irTbTooltip = L.popup({
            closeButton: false, autoPan: false, autoClose: false,
            className: 'ir-tb-tooltip', offset: [12, -12]
        });
        detailMap.on('mousemove', _handleIRMouseMove);
        detailMap.on('mouseout', function () {
            if (irTbTooltip && detailMap.hasLayer(irTbTooltip)) {
                detailMap.closePopup(irTbTooltip);
            }
        });
        detailMap._irHoverAttached = true;
    }

    // Pan/zoom map based on follow mode
    if (irFollowStorm) {
        if (!irFollowZoomSet) {
            // First frame: fitBounds to establish correct zoom level
            var padded = imageBounds.pad(0.15);
            detailMap.fitBounds(padded, {
                animate: false,
                maxZoom: 7
            });
            irFollowZoomSet = true;
        } else {
            // Subsequent frames: panTo center at existing zoom (no zoom jitter)
            var center = imageBounds.getCenter();
            detailMap.panTo(center, {
                animate: irPlaying,
                duration: irPlaying ? 0.3 : 0
            });
        }
    } else if (!detailMap.getBounds().contains(imageBounds)) {
        // Free-pan mode: only refit when IR drifts off-screen
        var padded = imageBounds.pad(0.3);
        detailMap.fitBounds(padded, { animate: true, duration: 0.4, maxZoom: 7 });
    }

    // Update storm position marker
    updateIRPositionMarker(data);
}

var _irHoverThrottled = false;
function _handleIRMouseMove(e) {
    if (_irHoverThrottled) return;
    _irHoverThrottled = true;
    setTimeout(function () { _irHoverThrottled = false; }, 50); // ~20 Hz

    if (!irOverlayVisible || !irCurrentTbGrid || !irCurrentBounds || !detailMap) {
        if (irTbTooltip && detailMap && detailMap.hasLayer(irTbTooltip)) {
            detailMap.closePopup(irTbTooltip);
        }
        return;
    }

    var lat = e.latlng.lat;
    var lng = e.latlng.lng;
    var b = irCurrentBounds;

    // Check if cursor is within IR image bounds
    if (lat < b.getSouth() || lat > b.getNorth() ||
        lng < b.getWest() || lng > b.getEast()) {
        if (irTbTooltip && detailMap.hasLayer(irTbTooltip)) {
            detailMap.closePopup(irTbTooltip);
        }
        return;
    }

    // Map lat/lon to grid indices (grid is north-at-top, row 0 = north)
    var grid = irCurrentTbGrid;
    var nRows = grid.length;
    var nCols = grid[0] ? grid[0].length : 0;
    if (nRows === 0 || nCols === 0) return;

    var fracY = (b.getNorth() - lat) / (b.getNorth() - b.getSouth());
    var fracX = (lng - b.getWest()) / (b.getEast() - b.getWest());
    var row = Math.min(Math.floor(fracY * nRows), nRows - 1);
    var col = Math.min(Math.floor(fracX * nCols), nCols - 1);

    var tbK = grid[row] ? grid[row][col] : null;
    if (tbK == null) {
        if (irTbTooltip && detailMap.hasLayer(irTbTooltip)) {
            detailMap.closePopup(irTbTooltip);
        }
        return;
    }

    var tbC = (tbK - 273.15).toFixed(1);
    var latStr = Math.abs(lat).toFixed(1) + (lat >= 0 ? '°N' : '°S');
    var lngStr = Math.abs(lng).toFixed(1) + (lng >= 0 ? '°E' : '°W');
    var html = '<span class="ir-tb-val">' + tbK + ' K</span>' +
               '<span class="ir-tb-sep"> / </span>' +
               '<span class="ir-tb-val">' + tbC + ' °C</span>' +
               '<span class="ir-tb-sep"> &nbsp; </span>' +
               '<span class="ir-tb-coord">' + latStr + ', ' + lngStr + '</span>';

    irTbTooltip.setLatLng(e.latlng).setContent(html);
    if (!detailMap.hasLayer(irTbTooltip)) {
        irTbTooltip.openOn(detailMap);
    }
}

function updateIRPositionMarker(data) {
    if (!detailMap) return;

    var frameMeta = irMeta && irMeta.frames ? irMeta.frames[irFrameIdx] : null;
    var lat, lon;

    if (frameMeta && frameMeta.lat != null) {
        lat = frameMeta.lat;
        lon = frameMeta.lon;
    } else if (frameMeta && frameMeta.datetime) {
        var track = allTracks[selectedStorm.sid] || [];
        var pt = findTrackPointAtTime(track, frameMeta.datetime);
        if (pt) { lat = pt.la; lon = pt.lo; }
    }

    if (lat != null && lon != null) {
        if (irPositionMarker) {
            irPositionMarker.setLatLng([lat, lon]);
        } else {
            irPositionMarker = L.circleMarker([lat, lon], {
                radius: 4,
                color: 'rgba(255,255,255,0.85)',
                fillColor: 'transparent',
                fillOpacity: 0,
                weight: 1.5,
                pane: 'markerPane'
            }).addTo(detailMap);
            irPositionMarker.bindTooltip('', { className: 'track-tooltip', permanent: false });
        }
        var tipText = (frameMeta.datetime || '');
        if (data && data.satellite) tipText += ' [' + data.satellite + ']';
        irPositionMarker.setTooltipContent(tipText);
    }
}

function findTrackPointAtTime(track, dtStr) {
    if (!track || !track.length || !dtStr) return null;
    var targetMs = new Date(dtStr).getTime();

    // Find the two flanking track points for interpolation
    var before = null, after = null;
    var beforeMs = -Infinity, afterMs = Infinity;

    for (var i = 0; i < track.length; i++) {
        if (!track[i].t || !track[i].la) continue;
        var ptMs = new Date(track[i].t).getTime();

        if (ptMs <= targetMs && ptMs > beforeMs) {
            before = track[i];
            beforeMs = ptMs;
        }
        if (ptMs >= targetMs && ptMs < afterMs) {
            after = track[i];
            afterMs = ptMs;
        }
    }

    // Exact match or only one side available
    if (!before && !after) return null;
    if (!before) return after;
    if (!after) return before;
    if (beforeMs === afterMs) return before;

    // Linear interpolation between flanking points
    var frac = (targetMs - beforeMs) / (afterMs - beforeMs);
    return {
        t: dtStr,
        la: before.la + frac * (after.la - before.la),
        lo: before.lo + frac * (after.lo - before.lo),
        w: before.w != null && after.w != null
            ? Math.round(before.w + frac * (after.w - before.w))
            : (before.w || after.w),
        p: before.p != null && after.p != null
            ? Math.round(before.p + frac * (after.p - before.p))
            : (before.p || after.p)
    };
}

function updateIRCacheStatus() {
    if (!irMeta) return;
    var cached = irFrames.filter(function (f) { return f; }).length;
    var total = irMeta.n_frames;
    var sourceLabels = {
        'mergir': 'MergIR 4km',
        'gridsat': 'GridSat 8km',
        'hursat': 'HURSAT-B1'
    };
    var plannedLabel = sourceLabels[irMeta.source] || irMeta.source;
    var statusEl = document.getElementById('ir-status');

    // Count how many cached frames came from a fallback source
    var fallbackCount = 0;
    if (irMeta.source) {
        irFrames.forEach(function (f) {
            if (f && f.source && f.source !== irMeta.source) fallbackCount++;
        });
    }

    var text;
    if (cached < total) {
        text = cached + ' / ' + total + ' frames loaded (' + plannedLabel + ')';
    } else {
        text = total + ' frames (' + plannedLabel + ')';
    }
    if (fallbackCount > 0) {
        text += ' · ' + fallbackCount + ' fallback';
    }
    statusEl.textContent = text;
}

var irPrefetchQueue = [];    // Frames queued for prefetch
var irPrefetchActive = 0;    // Number of active prefetch requests
var IR_PREFETCH_BATCH = 8;          // Concurrent prefetch requests (HURSAT)
var IR_PREFETCH_BATCH_GRIDSAT = 14; // Higher concurrency for GridSat (small subsets, no auth)
var IR_PREFETCH_BATCH_MERGIR = 3;   // MergIR: reduced from 4 to ease NASA GES DISC rate
                                    // limiting (server also paces with 0.5s min interval)
var IR_PREFETCH_AHEAD = 20;  // How many frames ahead to prefetch

function setIRLoadingText(msg) {
    var el = document.getElementById('ir-loading-text');
    if (el) el.textContent = msg;
}

function loadIRFrame(idx) {
    if (!irMeta || !selectedStorm) return;

    var loadingEl = document.getElementById('ir-frame-loading');

    // Check cache
    if (irFrames[idx]) {
        displayIROnMap(irFrames[idx]);
        updateIRMeta(idx);
        if (loadingEl) loadingEl.style.display = 'none';
        prefetchIRFrames(idx);
        return;
    }

    if (loadingEl) loadingEl.style.display = 'flex';

    // Show context-specific loading message
    var cached = Object.keys(irFrames).length;
    var source = irMeta.source || 'hursat';
    if (cached === 0 && source === 'hursat') {
        setIRLoadingText('Downloading satellite archive...\nThis may take up to 60 seconds');
    } else if (cached === 0) {
        setIRLoadingText('Loading satellite imagery...');
    } else {
        setIRLoadingText('Loading frame ' + (idx + 1) + '...');
    }

    fetchIRFrameSingle(idx, function (data) {
        if (data && irFrameIdx === idx) {
            displayIROnMap(data);
        }
        if (!data && irFrameIdx === idx) {
            irFailedFrames[idx] = true;
            // During playback, auto-skip to next frame
            if (irPlaying && irMeta) {
                var nextIdx = (idx + 1) % irMeta.n_frames;
                // Prevent infinite loop if all frames failed
                var attempts = 0;
                while (irFailedFrames[nextIdx] && attempts < irMeta.n_frames) {
                    nextIdx = (nextIdx + 1) % irMeta.n_frames;
                    attempts++;
                }
                if (attempts < irMeta.n_frames) {
                    irFrameIdx = nextIdx;
                    if (loadingEl) loadingEl.style.display = 'none';
                    loadIRFrame(nextIdx);
                    return;
                }
            }
            setIRLoadingText('Frame ' + (idx + 1) + ' unavailable');
            setTimeout(function () {
                if (loadingEl) loadingEl.style.display = 'none';
            }, 1500);
            return;
        }
        updateIRMeta(idx);
        if (loadingEl) loadingEl.style.display = 'none';
        prefetchIRFrames(idx);
    });
}

function fetchIRFrameSingle(idx, callback) {
    if (!irMeta || !selectedStorm) return;
    if (irFrames[idx]) { callback(irFrames[idx]); return; }

    // Build URL based on source (MergIR needs lat/lon, use unified endpoint)
    var frameUrl;
    var source = irMeta.source || 'hursat';

    // Cache version — bump when rendering changes (domain size, colormap, etc.)
    // to force browsers to discard stale cached frames.
    var irCacheVer = 'v3';

    if ((source === 'mergir' || source === 'gridsat') && irMeta.frames && irMeta.frames[idx]) {
        var fi = irMeta.frames[idx];
        frameUrl = API_BASE + '/global/ir/frame?sid=' + encodeURIComponent(selectedStorm.sid) +
            '&frame_idx=' + idx +
            '&lat=' + fi.lat + '&lon=' + fi.lon +
            '&_v=' + irCacheVer;
    } else {
        // HURSAT: use legacy endpoint directly (most reliable)
        frameUrl = API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(selectedStorm.sid) +
            '&frame_idx=' + idx +
            '&_v=' + irCacheVer;
    }

    // Timeout must be long enough for the full server-side cascade:
    // MergIR attempt (~30-90s) → GridSat attempt (~10-30s) → HURSAT (~5-60s)
    // First frame needs extra time for HURSAT tarball download.
    var cached = Object.keys(irFrames).length;
    var timeoutMs = cached === 0 ? 180000 : 120000;  // 3 min first, 2 min after
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

    fetch(frameUrl, { signal: controller.signal })
        .then(function (r) {
            clearTimeout(timer);
            if (!r.ok) throw new Error('Frame not available (HTTP ' + r.status + ')');
            return r.json();
        })
        .then(function (data) {
            irFrames[idx] = data;
            updateIRCacheStatus();
            if (callback) callback(data);
        })
        .catch(function (err) {
            clearTimeout(timer);
            console.warn('Frame ' + idx + ' load failed from ' + source + ':', err);
            // Fallback: try the other endpoint
            var fallbackUrl;
            if (source === 'hursat') {
                fallbackUrl = API_BASE + '/global/ir/frame?sid=' + encodeURIComponent(selectedStorm.sid) + '&frame_idx=' + idx + '&_v=' + irCacheVer;
            } else {
                // For mergir/gridsat, fall back to HURSAT legacy endpoint
                fallbackUrl = API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(selectedStorm.sid) + '&frame_idx=' + idx + '&_v=' + irCacheVer;
            }
            fetch(fallbackUrl)
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (data) {
                        irFrames[idx] = data;
                        updateIRCacheStatus();
                    }
                    if (callback) callback(data);
                })
                .catch(function () { if (callback) callback(null); });
        });
}

function prefetchIRFrames(currentIdx) {
    if (!irMeta) return;
    var total = irMeta.n_frames;
    var source = irMeta.source || 'hursat';

    // All sources use parallel individual fetches with self-replenishing chains.
    // Each completed fetch triggers another prefetchIRFrames() call, keeping
    // all slots filled until every frame is cached.
    var maxConcurrent;
    if (source === 'gridsat') maxConcurrent = IR_PREFETCH_BATCH_GRIDSAT;
    else if (source === 'mergir') maxConcurrent = IR_PREFETCH_BATCH_MERGIR;
    else maxConcurrent = IR_PREFETCH_BATCH;

    if (irPrefetchActive >= maxConcurrent) return;

    // Scan forward from current display position, wrapping around the full
    // loop, to find uncached frames. Always prioritizes frames the user
    // is about to see. No frontier needed — the scan itself skips cached frames.
    var toFetch = [];
    var slots = maxConcurrent - irPrefetchActive;
    for (var i = 0; i < total && toFetch.length < slots; i++) {
        var idx = (currentIdx + 1 + i) % total;
        if (!irFrames[idx] && !irFailedFrames[idx]) {
            toFetch.push(idx);
        }
    }

    // Also prefetch a few behind current display (for rewinding)
    for (var j = 1; j <= 3; j++) {
        var prevIdx = (currentIdx - j + total) % total;
        if (!irFrames[prevIdx] && !irFailedFrames[prevIdx] &&
            toFetch.indexOf(prevIdx) === -1 && toFetch.length < slots + 3) {
            toFetch.push(prevIdx);
        }
    }

    if (toFetch.length === 0) return;

    // Fire individual fetches in parallel — self-replenishing chain
    toFetch.forEach(function (idx) {
        irPrefetchActive++;
        fetchIRFrameSingle(idx, function (data) {
            irPrefetchActive--;
            if (!data) {
                // Mark as failed so prefetch doesn't retry this frame endlessly
                irFailedFrames[idx] = true;
            }
            updateIRCacheStatus();
            // Chain: each completion immediately fills the empty slot
            prefetchIRFrames(irFrameIdx);
        });
    });
}

/* fetchIRBatch removed — all sources now use individual parallel fetches via prefetchIRFrames */

function updateIRMeta(idx) {
    var datetimeEl = document.getElementById('ir-datetime');
    var frameInfoEl = document.getElementById('ir-frame-info');

    var dtText = '';
    if (irMeta && irMeta.frames && irMeta.frames[idx]) {
        dtText = irMeta.frames[idx].datetime || '';
        var sat = irMeta.frames[idx].satellite || '';
        if (datetimeEl) datetimeEl.textContent = dtText + (sat ? '  [' + sat + ']' : '');
        // Log NC file for HURSAT debugging
        var frameData = irFrames[idx];
        if (frameData && frameData.nc_file) {
            console.log('Frame ' + idx + ': ' + dtText + ' → ' + frameData.nc_file);
        }
    }
    if (frameInfoEl) {
        frameInfoEl.textContent = 'Frame ' + (idx + 1) + ' / ' + (irMeta ? irMeta.n_frames : '?');
    }
    var slider = document.getElementById('ir-slider');
    if (slider) slider.value = idx;

    // Update per-frame source badge (shows actual source, not planned source)
    var frameData = irFrames[idx];
    var badgeEl = document.getElementById('ir-source-badge');
    if (badgeEl && frameData && frameData.source) {
        var actualSource = frameData.source;
        var plannedSource = irMeta ? irMeta.source : '';
        var sourceLabels = {
            'mergir': 'MergIR 4km',
            'gridsat': 'GridSat 8km',
            'hursat': 'HURSAT-B1'
        };
        var label = sourceLabels[actualSource] || actualSource;
        // If this frame fell back to a different source, indicate it
        var isFallback = plannedSource && actualSource !== plannedSource;
        badgeEl.textContent = label;
        badgeEl.className = 'panel-badge ir-source-' + actualSource +
            (isFallback ? ' ir-source-fallback' : '');
    }

    // Sync intensity chart marker to current IR time
    updateIntensityMarker(dtText);

    // Update cache status
    updateIRCacheStatus();
}

window.toggleIRPlay = function () {
    if (irPlaying) {
        stopIRPlayback();
    } else {
        startIRPlayback();
    }
};

function startIRPlayback() {
    if (!irMeta || irMeta.n_frames === 0) return;
    _ga('ga_ir_playback', { storm: selectedStorm ? selectedStorm.name : '', n_frames: irMeta.n_frames });
    irPlaying = true;
    document.getElementById('ir-play-btn').innerHTML = '&#9646;&#9646; Pause';

    // Kick a prefetch burst when playback starts so the buffer fills faster
    prefetchIRFrames(irFrameIdx);

    irTimer = setInterval(function () {
        var nextIdx = (irFrameIdx + 1) % irMeta.n_frames;

        // If next frame isn't cached and isn't a known failure, skip forward
        // to the nearest cached frame so playback never stalls on a spinner.
        if (!irFrames[nextIdx] && !irFailedFrames[nextIdx]) {
            var skipIdx = -1;
            // Look ahead for the next cached frame (up to full loop)
            for (var i = 1; i < irMeta.n_frames; i++) {
                var candidate = (nextIdx + i) % irMeta.n_frames;
                if (irFrames[candidate]) { skipIdx = candidate; break; }
            }
            if (skipIdx >= 0 && skipIdx !== irFrameIdx) {
                irFrameIdx = skipIdx;
                displayIROnMap(irFrames[skipIdx]);
                updateIRMeta(skipIdx);
                // Continue prefetching ahead of where we were blocked
                prefetchIRFrames(nextIdx);
                return;
            }
        }

        irFrameIdx = nextIdx;
        loadIRFrame(irFrameIdx);
    }, irSpeed);
}

function stopIRPlayback() {
    irPlaying = false;
    if (irTimer) clearInterval(irTimer);
    irTimer = null;
    var btn = document.getElementById('ir-play-btn');
    if (btn) btn.innerHTML = '&#9654; Play';
}

window.seekIRFrame = function (val) {
    irFrameIdx = parseInt(val);
    loadIRFrame(irFrameIdx);
};

window.setIRSpeed = function (val) {
    irSpeed = parseInt(val);
    if (irPlaying) {
        stopIRPlayback();
        startIRPlayback();
    }
};

function syncIRToTime(clickedTime) {
    if (!irMeta || !irMeta.frames) return;

    // Find nearest frame to clicked time
    var targetMs = new Date(clickedTime).getTime();
    var bestIdx = 0;
    var bestDiff = Infinity;

    irMeta.frames.forEach(function (f, idx) {
        var diff = Math.abs(new Date(f.datetime).getTime() - targetMs);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = idx;
        }
    });

    irFrameIdx = bestIdx;
    loadIRFrame(bestIdx);
}

// ══════════════════════════════════════════════════════════════
//  CLIMATOLOGY TAB
// ══════════════════════════════════════════════════════════════

function renderClimatology() {
    _ga('ga_view_climatology', {});
    if (allStorms.length === 0) return;
    climRendered = true;

    // Year range
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y > 0; });
    var minYear = Math.min.apply(null, years);
    var maxYear = Math.max.apply(null, years);
    document.getElementById('clim-year-range').textContent = minYear + '–' + maxYear;

    renderACEChart(minYear, maxYear);
    renderFrequencyChart(minYear, maxYear);
    renderIntensityOverview();
    renderIntensityChangeOverview();
    renderBasinPie();
    renderLMILatOverview();
}

function renderACEChart(minYear, maxYear) {
    // Compute ACE by year and basin
    var basins = Object.keys(BASIN_NAMES);
    var yearRange = [];
    for (var y = Math.max(minYear, 1950); y <= maxYear; y++) yearRange.push(y);

    var traces = basins.map(function (basin) {
        var aceByYear = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr && s.basin === basin) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });

        return {
            x: yearRange,
            y: aceByYear,
            type: 'bar',
            name: basin,
            marker: { color: BASIN_COLORS[basin] || '#6b7280' },
            hovertemplate: '<b>' + basin + ' %{x}</b><br>ACE: %{y:.1f}<extra></extra>'
        };
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'stack',
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 55, r: 10, t: 30, b: 45 }
    });

    Plotly.newPlot('clim-ace-chart', traces, layout, PLOTLY_CONFIG);

    // Click handler: open ACE drill-down modal
    document.getElementById('clim-ace-chart').on('plotly_click', function () {
        openACEModal();
    });
}

function renderFrequencyChart(minYear, maxYear) {
    var catOrder = ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'];
    var yearRange = [];
    for (var y = Math.max(minYear, 1950); y <= maxYear; y++) yearRange.push(y);

    var traces = catOrder.map(function (cat) {
        var countsByYear = yearRange.map(function (yr) {
            return allStorms.filter(function (s) {
                return s.year === yr && getCatKey(s.peak_wind_kt) === cat;
            }).length;
        });

        return {
            x: yearRange,
            y: countsByYear,
            type: 'bar',
            name: cat,
            marker: { color: SS_COLORS[cat] },
            hovertemplate: '<b>%{x}</b><br>' + cat + ': %{y}<extra></extra>'
        };
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'stack',
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'Storm Count', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 50, r: 10, t: 30, b: 45 }
    });

    Plotly.newPlot('clim-freq-chart', traces, layout, PLOTLY_CONFIG);
}

function renderIntensityOverview() {
    // Box plots of peak wind by basin — overview for main panel
    var basins = Object.keys(BASIN_NAMES);
    var traces = [];
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; });
        if (winds.length === 0) return;
        traces.push({
            y: winds, name: basin, type: 'box',
            marker: { color: BASIN_COLORS[basin] },
            boxmean: 'sd',
            hovertemplate: '<b>' + basin + '</b><br>%{y} kt<extra></extra>'
        });
    });
    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        xaxis: { tickfont: { size: 10, color: '#8b9ec2' } },
        showlegend: false,
        margin: { l: 50, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('clim-hist-chart', traces, layout, PLOTLY_CONFIG);
}

function renderIntensityChangeOverview() {
    // Two overlaid histograms: ri_24h (max 24h intensification) and rw_24h (max 24h weakening)
    var riVals = allStorms.filter(function (s) { return s.ri_24h != null; }).map(function (s) { return s.ri_24h; });
    var rwVals = allStorms.filter(function (s) { return s.rw_24h != null; }).map(function (s) { return s.rw_24h; });
    var traces = [
        {
            x: riVals, type: 'histogram', name: 'Intensification',
            marker: { color: '#60a5fa', opacity: 0.7 },
            xbins: { size: 5 },
            hovertemplate: 'RI: %{x} kt/24h<br>%{y} storms<extra></extra>'
        },
        {
            x: rwVals, type: 'histogram', name: 'Weakening',
            marker: { color: '#f87171', opacity: 0.7 },
            xbins: { size: 5 },
            hovertemplate: 'RW: %{x} kt/24h<br>%{y} storms<extra></extra>'
        }
    ];
    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'overlay',
        xaxis: { title: { text: 'Max 24-h Wind Change (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Storms', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        shapes: [
            { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: -30, x1: -30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } }
        ],
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 9, color: '#8b9ec2' } },
        margin: { l: 45, r: 10, t: 30, b: 45 }
    });
    Plotly.newPlot('clim-ri-chart', traces, layout, PLOTLY_CONFIG);
}

function renderLMILatOverview() {
    // Box plots of LMI latitude by basin
    var basins = Object.keys(BASIN_NAMES);
    var traces = [];
    basins.forEach(function (basin) {
        var lats = allStorms
            .filter(function (s) { return s.basin === basin && s.lmi_lat != null; })
            .map(function (s) { return Math.abs(s.lmi_lat); }); // Use absolute for SH comparison
        if (lats.length === 0) return;
        traces.push({
            y: lats, name: basin, type: 'box',
            marker: { color: BASIN_COLORS[basin] },
            boxmean: true,
            hovertemplate: '<b>' + basin + '</b><br>|Lat|: %{y:.1f}&deg;<extra></extra>'
        });
    });
    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: '|Latitude| of LMI (\u00B0)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        xaxis: { tickfont: { size: 10, color: '#8b9ec2' } },
        showlegend: false,
        margin: { l: 50, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('clim-lmi-chart', traces, layout, PLOTLY_CONFIG);
}

function renderBasinPie() {
    var basinCounts = {};
    allStorms.forEach(function (s) {
        var b = s.basin || 'UN';
        basinCounts[b] = (basinCounts[b] || 0) + 1;
    });

    var labels = [];
    var values = [];
    var colors = [];
    Object.keys(BASIN_NAMES).forEach(function (b) {
        if (basinCounts[b]) {
            labels.push(BASIN_NAMES[b] + ' (' + b + ')');
            values.push(basinCounts[b]);
            colors.push(BASIN_COLORS[b] || '#6b7280');
        }
    });

    var trace = {
        labels: labels,
        values: values,
        type: 'pie',
        hole: 0.45,
        marker: { colors: colors, line: { color: '#0a1628', width: 2 } },
        textfont: { color: '#e2e8f0', size: 11, family: 'DM Sans' },
        textinfo: 'label+percent',
        textposition: 'outside',
        hovertemplate: '<b>%{label}</b><br>%{value} storms (%{percent})<extra></extra>'
    };

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        showlegend: false,
        margin: { l: 20, r: 20, t: 10, b: 10 }
    });

    Plotly.newPlot('clim-basin-chart', [trace], layout, PLOTLY_CONFIG);
}

// ══════════════════════════════════════════════════════════════
//  ACE DRILL-DOWN MODAL
// ══════════════════════════════════════════════════════════════

var aceModalBasins = ['ALL'];   // Active basins in ACE modal
var aceSeasonMap = null;        // Leaflet map for season track overview

window.openACEModal = function () {
    var modal = document.getElementById('ace-modal');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();

    // Reset basin chips
    aceModalBasins = ['ALL'];
    document.querySelectorAll('#ace-basin-chips .basin-chip').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-basin') === 'ALL');
    });

    // Hide year detail initially
    document.getElementById('ace-year-detail').style.display = 'none';

    renderACEDrillDownChart();
};

window.closeACEModal = function () {
    document.getElementById('ace-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
    // Destroy season map to free memory
    if (aceSeasonMap) {
        aceSeasonMap.remove();
        aceSeasonMap = null;
    }
};

window.toggleACEBasin = function (btn) {
    var basin = btn.getAttribute('data-basin');

    if (basin === 'ALL') {
        document.querySelectorAll('#ace-basin-chips .basin-chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        aceModalBasins = ['ALL'];
    } else {
        document.querySelector('#ace-basin-chips .basin-chip[data-basin="ALL"]').classList.remove('active');
        btn.classList.toggle('active');

        aceModalBasins = [];
        document.querySelectorAll('#ace-basin-chips .basin-chip.active').forEach(function (c) {
            var b = c.getAttribute('data-basin');
            if (b !== 'ALL') aceModalBasins.push(b);
        });
        if (aceModalBasins.length === 0) {
            document.querySelector('#ace-basin-chips .basin-chip[data-basin="ALL"]').classList.add('active');
            aceModalBasins = ['ALL'];
        }
    }

    renderACEDrillDownChart();
    document.getElementById('ace-year-detail').style.display = 'none';
};

function renderACEDrillDownChart() {
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y > 0; });
    var minYear = Math.max(Math.min.apply(null, years), 1950);
    var maxYear = Math.max.apply(null, years);
    var yearRange = [];
    for (var y = minYear; y <= maxYear; y++) yearRange.push(y);

    var basins = aceModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : aceModalBasins;
    var traces = [];

    basins.forEach(function (basin) {
        var aceByYear = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr && s.basin === basin) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });

        traces.push({
            x: yearRange,
            y: aceByYear,
            type: 'scatter',
            mode: 'lines',
            name: BASIN_NAMES[basin] || basin,
            line: { color: BASIN_COLORS[basin] || '#6b7280', width: 2 },
            hovertemplate: '<b>' + (BASIN_NAMES[basin] || basin) + ' %{x}</b><br>ACE: %{y:.1f}<extra></extra>'
        });
    });

    // Also add total ACE as a thicker dashed line if showing all basins
    if (aceModalBasins[0] === 'ALL') {
        var totalACE = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });
        traces.push({
            x: yearRange,
            y: totalACE,
            type: 'scatter',
            mode: 'lines',
            name: 'Global Total',
            line: { color: '#e2e8f0', width: 2.5, dash: 'dot' },
            hovertemplate: '<b>Global %{x}</b><br>Total ACE: %{y:.1f}<extra></extra>'
        });
    }

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.15,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 55, r: 10, t: 35, b: 45 },
        hovermode: 'x unified'
    });

    Plotly.newPlot('ace-drilldown-chart', traces, layout, PLOTLY_CONFIG);

    // Click handler for year drill-down
    var chartEl = document.getElementById('ace-drilldown-chart');
    chartEl.removeAllListeners && chartEl.removeAllListeners('plotly_click');
    chartEl.on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var clickedYear = data.points[0].x;
            renderACEYearDetail(clickedYear);
        }
    });
}

function renderACEYearDetail(year) {
    var detailDiv = document.getElementById('ace-year-detail');
    detailDiv.style.display = '';

    // Scroll to it
    detailDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    var basins = aceModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : aceModalBasins;

    // Get storms for this year matching basin filter
    var yearStorms = allStorms.filter(function (s) {
        return s.year === year && (aceModalBasins[0] === 'ALL' || aceModalBasins.indexOf(s.basin) !== -1);
    });

    // Sort by ACE descending
    yearStorms.sort(function (a, b) { return (b.ace || 0) - (a.ace || 0); });

    var totalACE = yearStorms.reduce(function (sum, s) { return sum + (s.ace || 0); }, 0);

    document.getElementById('ace-year-title').textContent =
        year + ' Season — ' + yearStorms.length + ' storms, ACE: ' + totalACE.toFixed(1);

    // Render season track map
    renderACESeasonMap(yearStorms);

    // Bar chart of storm ACE
    var stormNames = yearStorms.map(function (s) {
        return (s.name || 'UNNAMED') + ' (' + s.basin + ')';
    });
    var stormACE = yearStorms.map(function (s) { return Math.round((s.ace || 0) * 10) / 10; });
    var stormColors = yearStorms.map(function (s) { return getIntensityColor(s.peak_wind_kt); });

    var trace = {
        y: stormNames,
        x: stormACE,
        type: 'bar',
        orientation: 'h',
        marker: { color: stormColors },
        hovertemplate: '<b>%{y}</b><br>ACE: %{x:.1f}<extra></extra>',
        texttemplate: '%{x:.1f}',
        textposition: 'outside',
        textfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }
    };

    var chartHeight = Math.max(250, yearStorms.length * 26 + 60);

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        yaxis: {
            tickfont: { size: 10, color: '#e2e8f0' },
            autorange: 'reversed'
        },
        showlegend: false,
        margin: { l: 160, r: 50, t: 10, b: 40 },
        height: chartHeight
    });

    Plotly.newPlot('ace-year-chart', [trace], layout, PLOTLY_CONFIG);

    // Click handler to jump to storm detail
    document.getElementById('ace-year-chart').on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var idx = data.points[0].pointIndex;
            var storm = yearStorms[idx];
            if (storm) {
                closeACEModal();
                selectedStorm = storm;
                selectStorm(storm);
                viewStormDetail();
            }
        }
    });

    // Build table
    var maxACE = Math.max.apply(null, stormACE) || 1;
    var html = '<table><thead><tr>' +
        '<th>Storm</th><th>Basin</th><th>Peak Wind</th><th>Min Pres</th><th>ACE</th><th style="width:30%;">Contribution</th>' +
        '</tr></thead><tbody>';

    yearStorms.forEach(function (s) {
        var pct = totalACE > 0 ? ((s.ace || 0) / totalACE * 100) : 0;
        var barWidth = maxACE > 0 ? ((s.ace || 0) / maxACE * 100) : 0;
        var color = getIntensityColor(s.peak_wind_kt);
        html += '<tr>' +
            '<td><span class="ace-storm-name" style="color:' + color + ';" onclick="aceJumpToStorm(\'' + s.sid + '\')">' +
            (s.name || 'UNNAMED') + '</span></td>' +
            '<td>' + s.basin + '</td>' +
            '<td class="mono">' + (s.peak_wind_kt || '—') + ' kt</td>' +
            '<td class="mono">' + (s.min_pres_hpa || '—') + ' hPa</td>' +
            '<td class="mono">' + (s.ace || 0).toFixed(1) + '</td>' +
            '<td class="ace-bar-cell"><span class="ace-bar" style="width:' + barWidth + '%;background:' + color + ';"></span> ' +
            '<span style="font-size:0.72rem;color:var(--text-dim);">' + pct.toFixed(1) + '%</span></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('ace-year-table').innerHTML = html;
}

window.aceJumpToStorm = function (sid) {
    var storm = allStorms.find(function (s) { return s.sid === sid; });
    if (storm) {
        closeACEModal();
        selectedStorm = storm;
        selectStorm(storm);
        viewStormDetail();
    }
};

// ── Season Track Map ─────────────────────────────────────────

function renderACESeasonMap(yearStorms) {
    // Destroy previous instance
    if (aceSeasonMap) {
        aceSeasonMap.remove();
        aceSeasonMap = null;
    }

    var mapEl = document.getElementById('ace-season-map');
    if (!mapEl) return;

    // Collect storms that have track data
    var stormsWithTracks = yearStorms.filter(function (s) { return allTracks && allTracks[s.sid]; });
    if (stormsWithTracks.length === 0) {
        mapEl.style.display = 'none';
        return;
    }
    mapEl.style.display = '';

    // Initialize map
    aceSeasonMap = L.map('ace-season-map', {
        center: [20, -60],
        zoom: 3,
        zoomControl: true,
        worldCopyJump: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 12
    }).addTo(aceSeasonMap);

    var allLats = [];
    var allLons = [];

    // Compute median ACE for label filtering (reduce clutter in busy seasons)
    var aceValues = stormsWithTracks.map(function (s) { return s.ace || 0; }).sort(function (a, b) { return a - b; });
    var medianACE = aceValues.length > 0 ? aceValues[Math.floor(aceValues.length / 2)] : 0;
    var labelThreshold = stormsWithTracks.length > 20 ? medianACE : -1;

    stormsWithTracks.forEach(function (storm) {
        var track = allTracks[storm.sid];
        if (!track || track.length < 2) return;

        var validPts = track.filter(function (p) { return p.la && p.lo; });
        if (validPts.length < 2) return;

        // Draw intensity-colored polyline segments
        var segmentCoords = [];
        for (var i = 1; i < validPts.length; i++) {
            var p0 = validPts[i - 1];
            var p1 = validPts[i];
            var isTCPhase = _isTCNature(p1.n);
            var color = isTCPhase ? getIntensityColor(p1.w) : '#6b7280';
            var seg = L.polyline(
                [[p0.la, p0.lo], [p1.la, p1.lo]],
                { color: color, weight: isTCPhase ? 2.5 : 1, opacity: isTCPhase ? 0.85 : 0.35, dashArray: isTCPhase ? null : '4,3' }
            );
            seg._stormSid = storm.sid;
            seg.addTo(aceSeasonMap);

            // Tooltip on hover
            seg.bindTooltip(
                '<b style="color:' + getIntensityColor(storm.peak_wind_kt) + '">' +
                (storm.name || 'UNNAMED') + '</b><br>' +
                getIntensityCategory(storm.peak_wind_kt) + ' — ' + (storm.peak_wind_kt || '?') + ' kt' +
                (storm.ace ? '<br>ACE: ' + storm.ace.toFixed(1) : ''),
                { sticky: true, className: 'track-tooltip', direction: 'top', offset: [0, -8] }
            );

            // Click to jump to storm detail
            seg.on('click', (function (sid) {
                return function () { aceJumpToStorm(sid); };
            })(storm.sid));

            // Highlight on hover
            seg.on('mouseover', function () { this.setStyle({ weight: 5, opacity: 1 }); });
            seg.on('mouseout', function () { this.setStyle({ weight: 2.5, opacity: 0.85 }); });
        }

        // Collect bounds
        validPts.forEach(function (p) {
            allLats.push(p.la);
            allLons.push(p.lo);
        });

        // Add storm name label at LMI point (or midpoint)
        if ((storm.ace || 0) > labelThreshold) {
            var lmiPt = validPts.reduce(function (max, p) {
                return (p.w || 0) > (max.w || 0) ? p : max;
            }, validPts[0]);

            var labelColor = getIntensityColor(storm.peak_wind_kt);
            var icon = L.divIcon({
                className: 'ace-track-label',
                html: '<span style="color:' + labelColor + '">' + (storm.name || 'UNNAMED') + '</span>',
                iconSize: [0, 0],
                iconAnchor: [-5, 6]
            });
            L.marker([lmiPt.la, lmiPt.lo], { icon: icon, interactive: false }).addTo(aceSeasonMap);
        }

        // Genesis dot
        var gen = validPts[0];
        L.circleMarker([gen.la, gen.lo], {
            radius: 3, color: '#fff', fillColor: getIntensityColor(gen.w), fillOpacity: 0.9, weight: 1
        }).addTo(aceSeasonMap);
    });

    // Fit map bounds
    if (allLats.length > 0) {
        aceSeasonMap.fitBounds([
            [Math.min.apply(null, allLats) - 3, Math.min.apply(null, allLons) - 5],
            [Math.max.apply(null, allLats) + 3, Math.max.apply(null, allLons) + 5]
        ]);
    }
}

// ══════════════════════════════════════════════════════════════
//  INTENSITY DISTRIBUTION MODAL
// ══════════════════════════════════════════════════════════════

var intensityModalBasins = ['ALL'];

window.openIntensityModal = function () {
    document.getElementById('intensity-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    intensityModalBasins = ['ALL'];
    _resetBasinChips('intensity-basin-chips', 'ALL');
    renderIntensityModalCharts();
};
window.closeIntensityModal = function () {
    document.getElementById('intensity-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleIntensityBasin = function (btn) {
    intensityModalBasins = _toggleBasinChip(btn, 'intensity-basin-chips');
    renderIntensityModalCharts();
};

function renderIntensityModalCharts() {
    var basins = intensityModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : intensityModalBasins;

    // CDF chart
    var cdfTraces = [];
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; })
            .sort(function (a, b) { return a - b; });
        if (winds.length === 0) return;
        var cdf = winds.map(function (_, i) { return (i + 1) / winds.length; });
        cdfTraces.push({
            x: winds, y: cdf, type: 'scatter', mode: 'lines',
            name: BASIN_NAMES[basin],
            line: { color: BASIN_COLORS[basin], width: 2 },
            hovertemplate: '<b>' + basin + '</b><br>%{x:.0f} kt: %{y:.1%} cumulative<extra></extra>'
        });
    });
    // Add SS category reference lines
    var ssShapes = [64, 83, 96, 113, 137].map(function (kt) {
        return { type: 'line', x0: kt, x1: kt, y0: 0, y1: 1, line: { color: 'rgba(255,255,255,0.15)', width: 1, dash: 'dot' } };
    });
    var cdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Peak Wind Speed (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Cumulative Probability', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 1] },
        shapes: ssShapes,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.15, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 35, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('intensity-cdf-chart', cdfTraces, cdfLayout, PLOTLY_CONFIG);

    // Box plots
    var boxTraces = [];
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; });
        if (winds.length === 0) return;
        boxTraces.push({ y: winds, name: basin, type: 'box', marker: { color: BASIN_COLORS[basin] }, boxmean: 'sd' });
    });
    var boxLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: false, margin: { l: 55, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('intensity-box-chart', boxTraces, boxLayout, PLOTLY_CONFIG);

    // Stats table
    var html = '<table><thead><tr><th>Basin</th><th>Count</th><th>Mean</th><th>Median</th><th>P90</th><th>P99</th><th>Max</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; })
            .sort(function (a, b) { return a - b; });
        if (winds.length === 0) return;
        var mean = winds.reduce(function (a, b) { return a + b; }, 0) / winds.length;
        var med = winds[Math.floor(winds.length * 0.5)];
        var p90 = winds[Math.floor(winds.length * 0.9)];
        var p99 = winds[Math.floor(winds.length * 0.99)];
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td class="mono">' + winds.length + '</td><td class="mono">' + mean.toFixed(0) + '</td>' +
            '<td class="mono">' + med + '</td><td class="mono">' + p90 + '</td>' +
            '<td class="mono">' + p99 + '</td><td class="mono">' + Math.max.apply(null, winds) + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('intensity-stats-table').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
//  24-H INTENSITY CHANGE MODAL
// ══════════════════════════════════════════════════════════════

var riModalBasins = ['ALL'];
var riModalPeriod = 'modern'; // 'all', 'satellite', 'modern', '30yr', 'custom'

// Period definitions: [startYear, endYear]
var RI_PERIODS = {
    'all':       [0, 9999],
    'satellite': [1966, 9999],
    'modern':    [1980, 9999],
    '30yr':      [1991, 2020],
    'custom':    [1980, 2025]   // updated dynamically from inputs
};

// Helper: extract change values from intensityChangeData for a basin, filtered by period
function _riFilteredVals(basin) {
    if (!intensityChangeData || !intensityChangeData.basins || !intensityChangeData.basins[basin]) return [];
    var range = RI_PERIODS[riModalPeriod] || RI_PERIODS['modern'];
    var raw = intensityChangeData.basins[basin];
    // New format: each entry is [change, year]
    if (raw.length > 0 && Array.isArray(raw[0])) {
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var yr = raw[i][1];
            if (yr >= range[0] && yr <= range[1]) out.push(raw[i][0]);
        }
        return out;
    }
    // Legacy format: plain numbers (no year filtering possible)
    return raw;
}

// Helper: return [change, year] pairs for a basin (no period filter — used for trend analysis)
function _riAllPairs(basin) {
    if (!intensityChangeData || !intensityChangeData.basins || !intensityChangeData.basins[basin]) return [];
    var raw = intensityChangeData.basins[basin];
    if (raw.length > 0 && Array.isArray(raw[0])) return raw;
    return [];
}

function _showCustomRange(show) {
    var el = document.getElementById('ri-custom-range');
    if (el) el.style.display = show ? 'inline-flex' : 'none';
}

window.openIntensityChangeModal = function () {
    document.getElementById('intensity-change-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    riModalBasins = ['ALL'];
    riModalPeriod = 'modern';
    _resetBasinChips('ri-basin-chips', 'ALL');
    // Reset period chips
    var chips = document.querySelectorAll('#ri-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-period') === 'modern'); });
    _showCustomRange(false);
    renderRIModalCharts();
};
window.closeIntensityChangeModal = function () {
    document.getElementById('intensity-change-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleRIBasin = function (btn) {
    riModalBasins = _toggleBasinChip(btn, 'ri-basin-chips');
    renderRIModalCharts();
};
window.toggleRIPeriod = function (btn) {
    var chips = document.querySelectorAll('#ri-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.remove('active'); });
    btn.classList.add('active');
    riModalPeriod = btn.getAttribute('data-period');
    _showCustomRange(riModalPeriod === 'custom');
    if (riModalPeriod === 'custom') {
        // Read current input values
        var y1 = parseInt(document.getElementById('ri-year-start').value) || 1980;
        var y2 = parseInt(document.getElementById('ri-year-end').value) || 2025;
        RI_PERIODS['custom'] = [y1, y2];
    }
    renderRIModalCharts();
};
window.applyRICustomPeriod = function () {
    var y1 = parseInt(document.getElementById('ri-year-start').value) || 1980;
    var y2 = parseInt(document.getElementById('ri-year-end').value) || 2025;
    RI_PERIODS['custom'] = [Math.min(y1, y2), Math.max(y1, y2)];
    if (riModalPeriod === 'custom') renderRIModalCharts();
};

function renderRIModalCharts() {
    var basins = riModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : riModalBasins;

    // ── Histogram: all overwater 24-h intensity change episodes (pre-binned for percentiles) ──
    var BIN_SIZE = 5;
    var histTraces = [];
    basins.forEach(function (basin) {
        var vals = _riFilteredVals(basin);
        if (vals.length === 0) return;
        // Sort and bin manually so we can compute percentiles
        var sorted = vals.slice().sort(function (a, b) { return a - b; });
        var n = sorted.length;
        var binCounts = {};
        vals.forEach(function (v) {
            var b = Math.floor(v / BIN_SIZE) * BIN_SIZE;
            binCounts[b] = (binCounts[b] || 0) + 1;
        });
        // Build cumulative percentile at each bin's upper edge
        var binKeys = Object.keys(binCounts).map(Number).sort(function (a, b) { return a - b; });
        var cumul = 0;
        var binX = [], binY = [], binCustom = [];
        binKeys.forEach(function (b) {
            cumul += binCounts[b];
            var pctUpper = (cumul / n * 100).toFixed(1);
            var pctLower = ((cumul - binCounts[b]) / n * 100).toFixed(1);
            binX.push(b + BIN_SIZE / 2); // bin center
            binY.push(binCounts[b]);
            binCustom.push([b + ' to ' + (b + BIN_SIZE) + ' kt/24h', pctLower + '–' + pctUpper + ' pctl']);
        });
        histTraces.push({
            x: binX, y: binY, customdata: binCustom,
            type: 'bar', name: BASIN_NAMES[basin],
            marker: { color: BASIN_COLORS[basin], opacity: 0.65 },
            width: BIN_SIZE * 0.95,
            hovertemplate: '<b>' + basin + '</b><br>%{customdata[0]}<br>%{y} episodes (%{customdata[1]})<extra></extra>'
        });
    });
    var riShapes = [
        { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 35, x1: 35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 65, x1: 65, y0: 0, y1: 1, yref: 'paper', line: { color: '#a855f7', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: -30, x1: -30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: -35, x1: -35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } }
    ];
    var riAnnotations = [
        { x: 30, y: 1.02, yref: 'paper', xanchor: 'center', text: '30kt', showarrow: false, font: { size: 9, color: '#fbbf24' } },
        { x: 35, y: 1.06, yref: 'paper', xanchor: 'center', text: '35kt', showarrow: false, font: { size: 9, color: '#f87171' } },
        { x: 50, y: 1.02, yref: 'paper', xanchor: 'center', text: '50kt', showarrow: false, font: { size: 9, color: '#dc2626' } },
        { x: 65, y: 1.06, yref: 'paper', xanchor: 'center', text: '65kt', showarrow: false, font: { size: 9, color: '#a855f7' } },
        { x: -30, y: 1.02, yref: 'paper', xanchor: 'center', text: '-30kt', showarrow: false, font: { size: 9, color: '#fbbf24' } },
        { x: -35, y: 1.06, yref: 'paper', xanchor: 'center', text: '-35kt', showarrow: false, font: { size: 9, color: '#f87171' } }
    ];
    // Episode count + period — update HTML subtitle
    var totalEpisodes = 0;
    histTraces.forEach(function (t) { totalEpisodes += t.x.length; });
    var periodRange = RI_PERIODS[riModalPeriod] || RI_PERIODS['modern'];
    var yrMin = periodRange[0] || (intensityChangeData ? intensityChangeData.year_min : '?');
    var yrMax = periodRange[1] < 9000 ? periodRange[1] : (intensityChangeData ? intensityChangeData.year_max : '?');
    var epEl = document.getElementById('ri-episode-count');
    if (epEl) epEl.textContent = '(' + totalEpisodes.toLocaleString() + ' episodes, ' + yrMin + '–' + yrMax + ')';
    var histLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'overlay',
        xaxis: { title: { text: '24-h Wind Change (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Number of 24-h Episodes', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        shapes: riShapes, annotations: riAnnotations,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 35, b: 45 }
    });
    Plotly.newPlot('ri-hist-chart', histTraces, histLayout, PLOTLY_CONFIG);

    // ── Exceedance CDF: probability of exceeding RI threshold (per-episode) ──
    var cdfTraces = [];
    basins.forEach(function (basin) {
        // Use only positive (intensification) episodes for the exceedance curve
        var vals = _riFilteredVals(basin).filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
        if (vals.length === 0) return;
        var exceed = vals.map(function (_, i) { return 1 - (i / vals.length); });
        cdfTraces.push({
            x: vals, y: exceed, type: 'scatter', mode: 'lines',
            name: BASIN_NAMES[basin],
            line: { color: BASIN_COLORS[basin], width: 2 },
            hovertemplate: '<b>' + basin + '</b><br>%{x} kt/24h: %{y:.1%} exceed<extra></extra>'
        });
    });
    var cdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Intensification Threshold (kt/24h)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 100] },
        yaxis: { title: { text: 'Exceedance Probability', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 1] },
        shapes: [
            { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 35, x1: 35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 65, x1: 65, y0: 0, y1: 1, yref: 'paper', line: { color: '#a855f7', width: 1.5, dash: 'dash' } }
        ],
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('ri-cdf-chart', cdfTraces, cdfLayout, PLOTLY_CONFIG);

    // Stats table — episode-based statistics, filtered by period
    var range = RI_PERIODS[riModalPeriod] || RI_PERIODS['modern'];
    var periodLabel = riModalPeriod === 'all' ? 'All Years' : riModalPeriod === 'satellite' ? '1966–Present' : riModalPeriod === '30yr' ? '1991–2020' : '1980–Present';
    var plEl = document.getElementById('ri-period-label');
    if (plEl) plEl.textContent = '';  // period shown in chips, no extra label needed
    var html = '<table><thead><tr><th>Basin</th><th>Episodes</th><th>Mean</th><th>\u226530kt</th><th>\u226535kt</th><th>\u226550kt</th><th>% RI\u226530</th><th>Max RI</th><th>\u2264-30kt</th><th>Max RW</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var vals = _riFilteredVals(basin);
        if (vals.length === 0) return;
        var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        var ri30 = vals.filter(function (v) { return v >= 30; }).length;
        var ri35 = vals.filter(function (v) { return v >= 35; }).length;
        var ri50 = vals.filter(function (v) { return v >= 50; }).length;
        var maxRI = Math.max.apply(null, vals);
        var rw30 = vals.filter(function (v) { return v <= -30; }).length;
        var maxRW = Math.min.apply(null, vals);
        var pct = (ri30 / vals.length * 100).toFixed(1);
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td class="mono">' + vals.length.toLocaleString() + '</td><td class="mono">' + mean.toFixed(1) + '</td>' +
            '<td class="mono">' + ri30.toLocaleString() + '</td>' +
            '<td class="mono">' + ri35.toLocaleString() + '</td><td class="mono">' + ri50.toLocaleString() + '</td>' +
            '<td class="mono">' + pct + '%</td><td class="mono">+' + maxRI + '</td>' +
            '<td class="mono">' + rw30.toLocaleString() + '</td><td class="mono">' + maxRW + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('ri-stats-table').innerHTML = html;

    // ── RI Frequency Trend: % of episodes exceeding thresholds by 5-yr bins ──
    var BIN_YRS = 5;
    var RI_THRESHOLDS = [
        { val: 30, label: 'RI \u2265 30 kt', color: '#fbbf24' },
        { val: 35, label: 'RI \u2265 35 kt', color: '#f87171' },
        { val: 50, label: 'RI \u2265 50 kt', color: '#dc2626' },
        { val: 65, label: 'RI \u2265 65 kt', color: '#a855f7' }
    ];
    // Collect all [change, year] pairs for active basins (always use full satellite era for trend)
    var allPairs = [];
    basins.forEach(function (basin) {
        var pairs = _riAllPairs(basin);
        for (var i = 0; i < pairs.length; i++) {
            if (pairs[i][1] >= 1966) allPairs.push(pairs[i]); // satellite era only
        }
    });

    // Group by 5-yr bin
    var binMap = {};
    allPairs.forEach(function (p) {
        var yr = p[1];
        var binStart = Math.floor(yr / BIN_YRS) * BIN_YRS;
        if (!binMap[binStart]) binMap[binStart] = { total: 0, pos: 0, ri30: 0, ri35: 0, ri50: 0, ri65: 0 };
        binMap[binStart].total++;
        if (p[0] > 0) binMap[binStart].pos++;
        if (p[0] >= 30) binMap[binStart].ri30++;
        if (p[0] >= 35) binMap[binStart].ri35++;
        if (p[0] >= 50) binMap[binStart].ri50++;
        if (p[0] >= 65) binMap[binStart].ri65++;
    });

    var trendBins = Object.keys(binMap).map(Number).sort(function (a, b) { return a - b; });
    // Drop bins with very few episodes (< 50) as they produce noisy rates
    trendBins = trendBins.filter(function (b) { return binMap[b].total >= 50; });

    var trendTraces = RI_THRESHOLDS.map(function (th) {
        var key = 'ri' + th.val;
        return {
            x: trendBins.map(function (b) { return b + Math.floor(BIN_YRS / 2); }), // bin midpoint
            y: trendBins.map(function (b) { return binMap[b][key] / binMap[b].total * 100; }),
            customdata: trendBins.map(function (b) { return [binMap[b][key], binMap[b].total, b + '–' + (b + BIN_YRS - 1)]; }),
            type: 'scatter', mode: 'lines+markers',
            name: th.label,
            line: { color: th.color, width: 2 },
            marker: { size: 5, color: th.color },
            hovertemplate: '<b>' + th.label + '</b><br>%{customdata[2]}<br>%{y:.1f}% (%{customdata[0]} of %{customdata[1]})<extra></extra>'
        };
    });

    var trendLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: '% of 24-h Episodes Exceeding Threshold', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, rangemode: 'tozero' },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'x unified'
    });
    Plotly.newPlot('ri-trend-chart', trendTraces, trendLayout, PLOTLY_CONFIG);

    // ── Exceedance CDF by Era: overlay curves for different periods ──
    var ERA_DEFS = [
        { label: '1966–1979', range: [1966, 1979], color: '#94a3b8', dash: 'dot' },
        { label: '1980–1994', range: [1980, 1994], color: '#60a5fa', dash: 'dash' },
        { label: '1995–2009', range: [1995, 2009], color: '#34d399', dash: 'dashdot' },
        { label: '2010–2025', range: [2010, 2025], color: '#fbbf24', dash: 'solid' }
    ];

    var eraCdfTraces = [];
    ERA_DEFS.forEach(function (era) {
        // Gather positive (intensification) episodes for this era across active basins
        var eraVals = [];
        basins.forEach(function (basin) {
            var pairs = _riAllPairs(basin);
            for (var i = 0; i < pairs.length; i++) {
                if (pairs[i][1] >= era.range[0] && pairs[i][1] <= era.range[1] && pairs[i][0] > 0) {
                    eraVals.push(pairs[i][0]);
                }
            }
        });
        if (eraVals.length < 20) return; // skip eras with too few samples
        eraVals.sort(function (a, b) { return a - b; });
        var n = eraVals.length;
        eraCdfTraces.push({
            x: eraVals,
            y: eraVals.map(function (_, i) { return 1 - (i / n); }),
            type: 'scatter', mode: 'lines',
            name: era.label + ' (n=' + n.toLocaleString() + ')',
            line: { color: era.color, width: 2.5, dash: era.dash },
            hovertemplate: '<b>' + era.label + '</b><br>%{x} kt/24h: %{y:.1%} exceed<extra></extra>'
        });
    });

    var eraCdfShapes = [
        { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1, dash: 'dash' } },
        { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1, dash: 'dash' } }
    ];

    var eraCdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Intensification Threshold (kt/24h)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 100] },
        yaxis: { title: { text: 'Exceedance Probability', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 0.5] },
        shapes: eraCdfShapes,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('ri-era-cdf-chart', eraCdfTraces, eraCdfLayout, PLOTLY_CONFIG);

    // ── Era comparison stats table ──
    var eraHtml = '<table><thead><tr><th>Era</th><th>Episodes</th><th>Mean \u0394V</th><th>% \u226530</th><th>% \u226535</th><th>% \u226550</th><th>% \u226565</th><th>Max RI</th></tr></thead><tbody>';
    ERA_DEFS.forEach(function (era) {
        var eraVals = [];
        basins.forEach(function (basin) {
            var pairs = _riAllPairs(basin);
            for (var i = 0; i < pairs.length; i++) {
                if (pairs[i][1] >= era.range[0] && pairs[i][1] <= era.range[1]) eraVals.push(pairs[i][0]);
            }
        });
        if (eraVals.length < 20) return;
        var n = eraVals.length;
        var mean = eraVals.reduce(function (a, b) { return a + b; }, 0) / n;
        var ri30 = eraVals.filter(function (v) { return v >= 30; }).length;
        var ri35 = eraVals.filter(function (v) { return v >= 35; }).length;
        var ri50 = eraVals.filter(function (v) { return v >= 50; }).length;
        var ri65 = eraVals.filter(function (v) { return v >= 65; }).length;
        var maxRI = Math.max.apply(null, eraVals);
        eraHtml += '<tr><td style="color:' + era.color + '">' + era.label + '</td>' +
            '<td class="mono">' + n.toLocaleString() + '</td>' +
            '<td class="mono">' + mean.toFixed(1) + '</td>' +
            '<td class="mono">' + (ri30 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">' + (ri35 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">' + (ri50 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">' + (ri65 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">+' + maxRI + '</td></tr>';
    });
    eraHtml += '</tbody></table>';
    document.getElementById('ri-era-stats-table').innerHTML = eraHtml;
}

// ══════════════════════════════════════════════════════════════
//  SEASONAL CYCLE MODAL
// ══════════════════════════════════════════════════════════════

var seasonalModalBasins = ['ALL'];

window.openSeasonalModal = function () {
    document.getElementById('seasonal-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    seasonalModalBasins = ['ALL'];
    _resetBasinChips('seasonal-basin-chips', 'ALL');
    renderSeasonalModalChart();
};
window.closeSeasonalModal = function () {
    document.getElementById('seasonal-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleSeasonalBasin = function (btn) {
    seasonalModalBasins = _toggleBasinChip(btn, 'seasonal-basin-chips');
    renderSeasonalModalChart();
};

function renderSeasonalModalChart() {
    var basins = seasonalModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : seasonalModalBasins;
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Count storms per month per basin (use start_date month)
    // Compute mean storms per month = total / number of years in dataset
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y >= 1950; });
    var nYears = Math.max(1, new Set(years).size);

    var traces = [];
    basins.forEach(function (basin) {
        var monthlyCounts = new Array(12).fill(0);
        allStorms.forEach(function (s) {
            if (s.basin !== basin || !s.start_date || s.year < 1950) return;
            var m = parseInt(s.start_date.substring(5, 7), 10) - 1;
            if (m >= 0 && m < 12) monthlyCounts[m]++;
        });
        var avgPerMonth = monthlyCounts.map(function (c) { return Math.round(c / nYears * 10) / 10; });
        traces.push({
            x: monthNames, y: avgPerMonth, type: 'scatter', mode: 'lines+markers',
            name: BASIN_NAMES[basin],
            line: { color: BASIN_COLORS[basin], width: 2.5 },
            marker: { size: 5, color: BASIN_COLORS[basin] },
            hovertemplate: '<b>' + basin + ' %{x}</b><br>%{y:.1f} storms/yr<extra></extra>'
        });
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { tickfont: { size: 11, color: '#8b9ec2' }, gridcolor: 'rgba(255,255,255,0.04)' },
        yaxis: { title: { text: 'Mean Storms per Month', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.15, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 35, b: 40 }, hovermode: 'x unified'
    });
    Plotly.newPlot('seasonal-chart', traces, layout, PLOTLY_CONFIG);

    // Stats: peak month and season length per basin
    var html = '<table><thead><tr><th>Basin</th><th>Peak Month</th><th>Peak Rate</th><th>Annual Total</th><th>Active Months (>0.5/yr)</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var monthlyCounts = new Array(12).fill(0);
        var totalCount = 0;
        allStorms.forEach(function (s) {
            if (s.basin !== basin || !s.start_date || s.year < 1950) return;
            var m = parseInt(s.start_date.substring(5, 7), 10) - 1;
            if (m >= 0 && m < 12) { monthlyCounts[m]++; totalCount++; }
        });
        var avgPerMonth = monthlyCounts.map(function (c) { return c / nYears; });
        var peakIdx = avgPerMonth.indexOf(Math.max.apply(null, avgPerMonth));
        var activeMonths = avgPerMonth.filter(function (v) { return v >= 0.5; }).length;
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td>' + monthNames[peakIdx] + '</td>' +
            '<td class="mono">' + avgPerMonth[peakIdx].toFixed(1) + '/yr</td>' +
            '<td class="mono">' + (totalCount / nYears).toFixed(1) + '/yr</td>' +
            '<td class="mono">' + activeMonths + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('seasonal-stats-table').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
//  LMI LATITUDE MODAL
// ══════════════════════════════════════════════════════════════

var lmiModalBasins = ['ALL'];
var lmiModalPeriod = 'modern';

// Shared period definitions (same as RI modal)
var LMI_PERIODS = {
    'all':       [0, 9999],
    'satellite': [1966, 9999],
    'modern':    [1980, 9999],
    '30yr':      [1991, 2020],
    'custom':    [1980, 2025]
};

// Helper: filter allStorms by basin + LMI period
function _lmiFilteredStorms(basin) {
    var range = LMI_PERIODS[lmiModalPeriod] || LMI_PERIODS['modern'];
    return allStorms.filter(function (s) {
        return s.basin === basin && s.year >= range[0] && s.year <= range[1];
    });
}

window.openLMILatModal = function () {
    document.getElementById('lmi-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    lmiModalBasins = ['ALL'];
    lmiModalPeriod = 'modern';
    _resetBasinChips('lmi-basin-chips', 'ALL');
    var chips = document.querySelectorAll('#lmi-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-period') === 'modern'); });
    var cr = document.getElementById('lmi-custom-range');
    if (cr) cr.style.display = 'none';
    renderLMIModalCharts();
};
window.closeLMILatModal = function () {
    document.getElementById('lmi-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleLMIBasin = function (btn) {
    lmiModalBasins = _toggleBasinChip(btn, 'lmi-basin-chips');
    renderLMIModalCharts();
};
window.toggleLMIPeriod = function (btn) {
    var chips = document.querySelectorAll('#lmi-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.remove('active'); });
    btn.classList.add('active');
    lmiModalPeriod = btn.getAttribute('data-period');
    var cr = document.getElementById('lmi-custom-range');
    if (cr) cr.style.display = lmiModalPeriod === 'custom' ? 'inline-flex' : 'none';
    if (lmiModalPeriod === 'custom') {
        var y1 = parseInt(document.getElementById('lmi-year-start').value) || 1980;
        var y2 = parseInt(document.getElementById('lmi-year-end').value) || 2025;
        LMI_PERIODS['custom'] = [Math.min(y1, y2), Math.max(y1, y2)];
    }
    renderLMIModalCharts();
};
window.applyLMICustomPeriod = function () {
    var y1 = parseInt(document.getElementById('lmi-year-start').value) || 1980;
    var y2 = parseInt(document.getElementById('lmi-year-end').value) || 2025;
    LMI_PERIODS['custom'] = [Math.min(y1, y2), Math.max(y1, y2)];
    if (lmiModalPeriod === 'custom') renderLMIModalCharts();
};

function renderLMIModalCharts() {
    var basins = lmiModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : lmiModalBasins;

    // Period label
    var range = LMI_PERIODS[lmiModalPeriod] || LMI_PERIODS['modern'];
    var yrMin = range[0] || 1842;
    var yrMax = range[1] < 9000 ? range[1] : 2025;
    var totalStorms = 0;

    // Scatter: LMI latitude vs peak wind
    var scatterTraces = [];
    basins.forEach(function (basin) {
        var storms = _lmiFilteredStorms(basin).filter(function (s) {
            return s.lmi_lat != null && s.peak_wind_kt != null && s.peak_wind_kt > 0;
        });
        if (storms.length === 0) return;
        totalStorms += storms.length;
        scatterTraces.push({
            x: storms.map(function (s) { return s.peak_wind_kt; }),
            y: storms.map(function (s) { return s.lmi_lat; }),
            text: storms.map(function (s) { return (s.name || 'UNNAMED') + ' (' + s.year + ')'; }),
            type: 'scatter', mode: 'markers',
            name: BASIN_NAMES[basin],
            marker: { color: BASIN_COLORS[basin], size: 4, opacity: 0.5 },
            hovertemplate: '<b>%{text}</b><br>%{x} kt, %{y:.1f}\u00B0<extra>' + basin + '</extra>'
        });
    });
    // Update period info in header
    var piEl = document.getElementById('lmi-period-info');
    if (piEl) piEl.textContent = '(' + totalStorms.toLocaleString() + ' storms, ' + yrMin + '–' + yrMax + ')';

    var scatterLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'LMI Latitude (\u00B0)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 35, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('lmi-scatter-chart', scatterTraces, scatterLayout, PLOTLY_CONFIG);

    // Box plots of LMI latitude
    var boxTraces = [];
    basins.forEach(function (basin) {
        var lats = _lmiFilteredStorms(basin)
            .filter(function (s) { return s.lmi_lat != null; })
            .map(function (s) { return s.lmi_lat; });
        if (lats.length === 0) return;
        boxTraces.push({ y: lats, name: basin, type: 'box', marker: { color: BASIN_COLORS[basin] }, boxmean: true });
    });
    var boxLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: 'LMI Latitude (\u00B0)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: false, margin: { l: 55, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('lmi-box-chart', boxTraces, boxLayout, PLOTLY_CONFIG);

    // Stats table
    var html = '<table><thead><tr><th>Basin</th><th>Count</th><th>Mean Lat</th><th>Median Lat</th><th>Min |Lat|</th><th>Max |Lat|</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var lats = _lmiFilteredStorms(basin)
            .filter(function (s) { return s.lmi_lat != null; })
            .map(function (s) { return s.lmi_lat; })
            .sort(function (a, b) { return a - b; });
        if (lats.length === 0) return;
        var absLats = lats.map(function (l) { return Math.abs(l); });
        var mean = lats.reduce(function (a, b) { return a + b; }, 0) / lats.length;
        var med = lats[Math.floor(lats.length * 0.5)];
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td class="mono">' + lats.length.toLocaleString() + '</td><td class="mono">' + mean.toFixed(1) + '\u00B0</td>' +
            '<td class="mono">' + med.toFixed(1) + '\u00B0</td>' +
            '<td class="mono">' + Math.min.apply(null, absLats).toFixed(1) + '\u00B0</td>' +
            '<td class="mono">' + Math.max.apply(null, absLats).toFixed(1) + '\u00B0</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('lmi-stats-table').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
//  BASIN CHIP HELPERS (shared by all modals)
// ══════════════════════════════════════════════════════════════

function _resetBasinChips(containerId, activeBasin) {
    document.querySelectorAll('#' + containerId + ' .basin-chip').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-basin') === activeBasin);
    });
}

function _toggleBasinChip(btn, containerId) {
    var basin = btn.getAttribute('data-basin');
    if (basin === 'ALL') {
        _resetBasinChips(containerId, 'ALL');
        return ['ALL'];
    }
    document.querySelector('#' + containerId + ' .basin-chip[data-basin="ALL"]').classList.remove('active');
    btn.classList.toggle('active');
    var selected = [];
    document.querySelectorAll('#' + containerId + ' .basin-chip.active').forEach(function (c) {
        var b = c.getAttribute('data-basin');
        if (b !== 'ALL') selected.push(b);
    });
    if (selected.length === 0) {
        _resetBasinChips(containerId, 'ALL');
        return ['ALL'];
    }
    return selected;
}

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════

function showToast(message) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.style.display = '';
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
        el.style.display = 'none';
    }, 3000);
}

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function () {
    loadData();

    // Warm up the API server on page load — a lightweight health check wakes
    // the Render instance so it's ready when the user selects a storm.
    fetch(API_BASE + '/health', { method: 'GET' }).catch(function () {});

    // Close any open modal on Escape
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            var modals = [
                { id: 'analog-modal', close: closeAnalogFinder },
                { id: 'ace-modal', close: closeACEModal },
                { id: 'intensity-modal', close: closeIntensityModal },
                { id: 'intensity-change-modal', close: closeIntensityChangeModal },
                { id: 'seasonal-modal', close: closeSeasonalModal },
                { id: 'lmi-modal', close: closeLMILatModal }
            ];
            for (var i = 0; i < modals.length; i++) {
                var el = document.getElementById(modals[i].id);
                if (el && el.style.display !== 'none') {
                    modals[i].close();
                    break;
                }
            }
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// ── MICROWAVE SATELLITE OVERLAY (TC-PRIMED) — GLOBAL ARCHIVE ──
// ═══════════════════════════════════════════════════════════════

var _gaMwOverpassData = [];      // all overpasses for current storm
var _gaMwVisible = false;        // MW overlay is shown on the detail map
var _gaMwMapOverlay = null;      // L.imageOverlay for the current MW frame
var _gaMwMarkers = null;         // L.layerGroup of overpass time-markers on track
var _gaMwLastAtcf = null;        // last ATCF ID we fetched for
var _gaMwMarkerDt = null;        // current MW overpass datetime for intensity line

/**
 * Fetch all microwave overpasses for the selected storm's lifecycle.
 * Called from renderStormDetail() when a storm with an ATCF ID is viewed.
 */
function loadGlobalMWOverpasses(storm) {
    var status = document.getElementById('ga-mw-status');
    var sel = document.getElementById('ga-mw-overpass-select');
    if (!sel) return;

    var atcfId = storm.atcf_id;
    if (!atcfId) return;

    // Skip if already loaded for this storm
    if (atcfId === _gaMwLastAtcf && _gaMwOverpassData.length > 0) return;
    _gaMwLastAtcf = atcfId;

    sel.innerHTML = '<option value="">Loading...</option>';
    if (status) status.textContent = 'Searching TC-PRIMED...';

    fetch(API_BASE + '/microwave/storm_overpasses?atcf_id=' + encodeURIComponent(atcfId))
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (json) {
            _gaMwOverpassData = json.overpasses || [];
            sel.innerHTML = '';

            if (_gaMwOverpassData.length === 0) {
                sel.innerHTML = '<option value="">No overpasses found</option>';
                if (status) status.textContent = 'No TC-PRIMED data';
                return;
            }

            for (var i = 0; i < _gaMwOverpassData.length; i++) {
                var op = _gaMwOverpassData[i];
                var label = op.sensor + ' / ' + op.platform + ' — ' + op.datetime;
                var opt = document.createElement('option');
                opt.value = i;
                opt.textContent = label;
                sel.appendChild(opt);
            }

            if (status) status.textContent = _gaMwOverpassData.length + ' overpass(es)';
        })
        .catch(function (e) {
            sel.innerHTML = '<option value="">Error</option>';
            if (status) status.textContent = 'Error: ' + e.message;
        });
}

/**
 * Toggle the MW overlay layer on the global archive detail map.
 */
window.toggleGlobalMWOverlay = function () {
    var btn = document.getElementById('ga-mw-toggle-btn');
    var controls = document.getElementById('ga-mw-controls');

    if (_gaMwVisible) {
        // Hide
        _gaMwVisible = false;
        if (btn) btn.textContent = '\uD83D\uDCE1 MW';
        if (controls) controls.style.display = 'none';
        if (_gaMwMapOverlay && detailMap) { detailMap.removeLayer(_gaMwMapOverlay); }
        if (_gaMwMarkers && detailMap) { detailMap.removeLayer(_gaMwMarkers); }
        // Remove MW line from intensity chart
        _applyIntensityMarker(_lastMarkerDt);
        return;
    }

    // Show
    _gaMwVisible = true;
    if (btn) btn.textContent = 'Hide MW';
    if (controls) controls.style.display = '';
    _repositionMWControls();

    // If overpasses loaded, show markers on track and auto-load first
    if (_gaMwOverpassData.length > 0) {
        addMWTrackMarkers();
        loadGlobalMWOverpass();
    }
};

/**
 * Reposition the MW controls panel (no-op: controls now in normal flow below map).
 */
function _repositionMWControls() {}

/**
 * Add small markers along the storm track showing overpass times.
 */
function addMWTrackMarkers() {
    if (_gaMwMarkers && detailMap) detailMap.removeLayer(_gaMwMarkers);
    _gaMwMarkers = L.layerGroup();

    // Sensor colour map
    var colors = {
        'GMI': '#00bcd4', 'SSMIS': '#ff7043', 'AMSR2': '#66bb6a',
        'SSMI': '#ab47bc', 'TMI': '#ffa726', 'ATMS': '#42a5f5', 'MHS': '#78909c'
    };

    // We don't have lat/lon for each overpass from the API directly,
    // but we can still render them as a visual indicator if the storm track
    // is available. For now, just skip track markers — the dropdown is the
    // primary navigation interface.
    // Future enhancement: interpolate overpass time to track lat/lon.

    if (detailMap) _gaMwMarkers.addTo(detailMap);
}

/**
 * Load the selected MW overpass image onto the detail map.
 */
window.loadGlobalMWOverpass = function () {
    var sel = document.getElementById('ga-mw-overpass-select');
    var prodSel = document.getElementById('ga-mw-product-select');
    var status = document.getElementById('ga-mw-frame-status');
    if (!sel || sel.value === '') return;

    var idx = parseInt(sel.value, 10);
    var op = _gaMwOverpassData[idx];
    if (!op) return;

    var product = (prodSel && prodSel.value) || '89pct';

    var is37 = (product === '37h' || product === '37v' || product === '37color');
    var is89 = (product === '89pct' || product === '89v' || product === '89h');
    if (is37 && !op.has_37) {
        if (status) status.textContent = op.sensor + ' has no 37 GHz';
        return;
    }
    if (is89 && !op.has_89) {
        if (status) status.textContent = op.sensor + ' has no 89 GHz';
        return;
    }

    if (status) status.textContent = 'Loading ' + product + '...';

    var url = API_BASE + '/microwave/data?s3_key=' + encodeURIComponent(op.s3_key) +
        '&product=' + product;

    // Pass storm center if available from the selected storm
    if (selectedStorm) {
        var lat = selectedStorm.lmi_lat || selectedStorm.genesis_lat || 0;
        var lon = selectedStorm.lmi_lon || selectedStorm.genesis_lon || 0;
        url += '&center_lat=' + lat + '&center_lon=' + lon;
    }

    fetch(url)
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

            if (_gaMwMapOverlay && detailMap) {
                detailMap.removeLayer(_gaMwMapOverlay);
            }
            _gaMwMapOverlay = L.imageOverlay(imgUrl, bounds, {
                opacity: 0.8, interactive: false, zIndex: 650
            });
            if (_gaMwVisible && detailMap) _gaMwMapOverlay.addTo(detailMap);

            // Re-center map on the MW image so the overpass is visible
            if (detailMap && bounds.isValid()) {
                var mwCenter = bounds.getCenter();
                detailMap.flyTo(mwCenter, detailMap.getZoom(), {
                    animate: true, duration: 0.5
                });
            }

            if (status) status.textContent = json.sensor + ' ' + json.datetime;

            // Update MW marker on intensity chart
            // MW datetime is "YYYY-MM-DD HH:MM UTC" → convert to ISO for Plotly
            if (json.datetime) {
                var mwDt = json.datetime.replace(' UTC', '').replace(' ', 'T') + ':00';
                _gaMwMarkerDt = mwDt;
            }
            _applyIntensityMarker(_lastMarkerDt);
        })
        .catch(function (e) {
            if (status) status.textContent = 'Error: ' + e.message;
        });
};

/**
 * Remove the MW overlay and reset state (called when switching storms).
 */
function removeGlobalMWOverlay() {
    if (_gaMwMapOverlay && detailMap) { detailMap.removeLayer(_gaMwMapOverlay); _gaMwMapOverlay = null; }
    if (_gaMwMarkers && detailMap) { detailMap.removeLayer(_gaMwMarkers); _gaMwMarkers = null; }
    _gaMwOverpassData = [];
    _gaMwVisible = false;
    _gaMwLastAtcf = null;
    _gaMwMarkerDt = null;
    var btn = document.getElementById('ga-mw-toggle-btn');
    if (btn) btn.textContent = '\uD83D\uDCE1 MW';
    var controls = document.getElementById('ga-mw-controls');
    if (controls) controls.style.display = 'none';
}


})();
